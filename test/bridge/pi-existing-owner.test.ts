import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { discoverPiOwners, selectPiOwner } from "../../src/bridge/pi-owner-discovery.ts";
import { PiOwnerAdapter } from "../../src/bridge/bridge-adapters.pi.ts";

test("a WeRelay adapter sends to the already-running Pi instance without spawning another owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-existing-"));
  fs.chmodSync(root, 0o700);
  const previous = process.env.WERELAY_PI_OWNER_DIRECTORY;
  process.env.WERELAY_PI_OWNER_DIRECTORY = root;
  const handlers = new Map<string, (event: unknown, context: unknown) => void>();
  const prompts: unknown[][] = [];
  const models = [{ provider: "openai", id: "gpt", name: "GPT" }, { provider: "anthropic", id: "sonnet", name: "Sonnet" }];
  let currentModel = models[0];
  const sessionId = "12345678-1234-1234-1234-123456789abc";
  const extension = (await import(`../../bin/pi-owner-extension.mjs?existing=${Date.now()}`)).default;
  const adapter = new PiOwnerAdapter({ kind: "pi", command: "pi", cwd: process.cwd(), renderMode: "companion", initialSharedSessionId: sessionId });
  // The live daemon may hold the global owner lock while the full suite runs.
  // This fixture already simulates one external owner; do not compete with the
  // user's real Pi instance for its production lock.
  (adapter as unknown as { releaseOwnerLock: (() => void) | null }).releaseOwnerLock = () => undefined;
  try {
    extension({ on: (name: string, callback: (event: unknown, context: unknown) => void) => handlers.set(name, callback),
      sendUserMessage: (...args: unknown[]) => prompts.push(args),
      setModel: async (model: typeof models[number]) => { currentModel = model; return true; } });
    const context = { sessionManager: { getSessionId: () => sessionId }, isIdle: () => true,
      ui: { getEditorText: () => "" }, abort: () => undefined,
      modelRegistry: { getAvailable: () => models }, get model() { return currentModel; } };
    handlers.get("session_start")?.({}, context);
    if (process.platform === "win32") {
      // Native discovery deliberately refuses arbitrary Windows TUI owners.
      expect(discoverPiOwners(root)).toEqual([]);
      expect(selectPiOwner([], sessionId, process.cwd())).toBeUndefined();
      expect(prompts).toEqual([]);
      return;
    }
    const deadline = Date.now() + 1500;
    while (discoverPiOwners(root).length !== 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(selectPiOwner(discoverPiOwners(root), sessionId, process.cwd())).toMatchObject({ pid: process.pid, sessionId });
    await adapter.start();
    expect(adapter.getState()).toMatchObject({ status: "idle", sharedSessionId: sessionId, pid: process.pid });
    expect((adapter as unknown as { child: unknown }).child).toBeNull();
    expect(await adapter.getSessionModelState(sessionId)).toMatchObject({
      currentModel: "openai/gpt", canChange: true,
      options: [{ id: "openai/gpt" }, { id: "anthropic/sonnet" }],
    });
    expect(await adapter.getNewSessionModelState()).toMatchObject({ currentModel: "openai/gpt", canChange: true });
    expect(await adapter.getSessionModelState("other-session")).toMatchObject({
      canChange: false, unavailableReason: "请先打开这条 Pi 任务再切换模型。",
    });
    await expect(adapter.setSessionModel("other-session", "anthropic/sonnet")).rejects.toThrow("请先打开这条 Pi 任务");
    expect(await adapter.setSessionModel(sessionId, "anthropic/sonnet")).toMatchObject({
      currentModel: "anthropic/sonnet",
    });
    expect(currentModel).toEqual(models[1]);
    handlers.get("agent_start")?.({}, context);
    const runningDeadline = Date.now() + 1500;
    while ((await adapter.getSessionRunSummary(sessionId))?.status !== "running" && Date.now() < runningDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await adapter.getSessionRunSummary(sessionId)).toMatchObject({ status: "running" });
    handlers.get("agent_settled")?.({}, context);
    const settledDeadline = Date.now() + 1500;
    while ((await adapter.getSessionRunSummary(sessionId))?.status !== "completed" && Date.now() < settledDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await adapter.getSessionRunSummary(sessionId)).toMatchObject({ status: "completed" });
    await adapter.sendInputToSession(sessionId, "来自手机的唯一消息");
    expect(prompts).toEqual([["来自手机的唯一消息", undefined]]);
    await adapter.dispose();
    // Disconnecting WeRelay must not terminate the independently opened Pi TUI.
    expect(process.pid).toBeGreaterThan(0);
  } finally {
    await adapter.dispose();
    handlers.get("session_shutdown")?.({ reason: "quit" }, {});
    if (previous === undefined) delete process.env.WERELAY_PI_OWNER_DIRECTORY;
    else process.env.WERELAY_PI_OWNER_DIRECTORY = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("headless Pi connects only the explicitly selected existing owner, not an arbitrary project task", async () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-lazy-"));
  fs.chmodSync(root, 0o700);
  const previous = process.env.WERELAY_PI_OWNER_DIRECTORY;
  process.env.WERELAY_PI_OWNER_DIRECTORY = root;
  const id = "12345678-1234-1234-1234-123456789abc";
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const prompts: unknown[][] = [];
  const adapter = new PiOwnerAdapter({ kind: "pi", command: "must-not-spawn", cwd: root, renderMode: "headless" });
  try {
    const extension = (await import(`../../bin/pi-owner-extension.mjs?lazy=${Date.now()}`)).default;
    extension({ on: (name: string, cb: (event: unknown, ctx: unknown) => void) => handlers.set(name, cb),
      sendUserMessage: (...args: unknown[]) => prompts.push(args) });
    handlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => id }, isIdle: () => false });
    const deadline = Date.now() + 1500;
    while (discoverPiOwners(root).length !== 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    await adapter.start();
    expect(adapter.getState().sharedSessionId).toBeUndefined();
    expect(adapter.getState().pid).toBeUndefined();
    await adapter.resumeSession(id);
    expect(adapter.getState()).toMatchObject({ sharedSessionId: id, pid: process.pid, status: "busy" });
    await adapter.sendInputToSession(id, "Follow-up to exact live task");
    expect(prompts).toEqual([["Follow-up to exact live task", { deliverAs: "followUp" }]]);
    expect((adapter as unknown as { child: unknown }).child).toBeNull();
  } finally {
    await adapter.dispose();
    handlers.get("session_shutdown")?.({}, {});
    if (previous === undefined) delete process.env.WERELAY_PI_OWNER_DIRECTORY; else process.env.WERELAY_PI_OWNER_DIRECTORY = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("headless restored Pi sends to the same ID before initial attach and after disconnect", async () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-restore-"));
  fs.chmodSync(root, 0o700);
  const previous = process.env.WERELAY_PI_OWNER_DIRECTORY;
  process.env.WERELAY_PI_OWNER_DIRECTORY = root;
  const id = "12345678-1234-1234-1234-123456789abc";
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const prompts: unknown[][] = [];
  const adapter = new PiOwnerAdapter({ kind: "pi", command: "must-not-spawn", cwd: root, renderMode: "headless", initialSharedSessionId: id });
  try {
    const extension = (await import(`../../bin/pi-owner-extension.mjs?restored=${Date.now()}`)).default;
    extension({ on: (name: string, cb: (event: unknown, ctx: unknown) => void) => handlers.set(name, cb),
      sendUserMessage: (...args: unknown[]) => prompts.push(args) });
    handlers.get("session_start")?.({}, { cwd: root, sessionManager: { getSessionId: () => id }, isIdle: () => true });
    const deadline = Date.now() + 1500;
    while (discoverPiOwners(root).length !== 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    await adapter.start();
    await adapter.sendInputToSession(id, "first restored send");
    expect(prompts).toEqual([["first restored send", undefined]]);
    const socket = (adapter as unknown as { socket: import("node:net").Socket }).socket;
    await new Promise<void>((resolve) => { socket.once("close", resolve); socket.destroy(); });
    await new Promise((r) => setTimeout(r, 10));
    await adapter.sendInputToSession(id, "send after disconnect");
    expect(prompts).toHaveLength(2);
    expect((adapter as unknown as { child: unknown }).child).toBeNull();
  } finally {
    await adapter.dispose();
    handlers.get("session_shutdown")?.({ reason: "quit" }, {});
    if (previous === undefined) delete process.env.WERELAY_PI_OWNER_DIRECTORY; else process.env.WERELAY_PI_OWNER_DIRECTORY = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi Desktop sidecar advertises separate sessions in one process and routes exact owners", async () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-multi-"));
  fs.chmodSync(root, 0o700);
  const previous = process.env.WERELAY_PI_OWNER_DIRECTORY;
  const previousSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.WERELAY_PI_OWNER_DIRECTORY = root;
  process.env.PI_CODING_AGENT_SESSION_DIR = root;
  const ids = ["12345678-1234-1234-1234-123456789abc", "22222222-2222-2222-2222-222222222222"];
  const handlers = ids.map(() => new Map<string, (event: unknown, ctx: unknown) => void>());
  const prompts = ids.map(() => [] as unknown[][]);
  const adapter = new PiOwnerAdapter({ kind: "pi", command: "must-not-spawn", cwd: root, renderMode: "headless" });
  try {
    const extension = (await import(`../../bin/pi-owner-extension.mjs?multi=${Date.now()}`)).default;
    for (let i = 0; i < ids.length; i++) {
      extension({ on: (name: string, cb: (event: unknown, ctx: unknown) => void) => handlers[i]!.set(name, cb),
        sendUserMessage: (...args: unknown[]) => prompts[i]!.push(args) });
      handlers[i]!.get("session_start")?.({}, { cwd: path.join(root, `project-${i}`),
        sessionManager: { getSessionId: () => ids[i] }, isIdle: () => false });
    }
    const deadline = Date.now() + 1500;
    while (discoverPiOwners(root).length !== 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(discoverPiOwners(root)).toHaveLength(2);
    expect(selectPiOwner(discoverPiOwners(root), ids[1], root)?.cwd).toBe(path.join(root, "project-1"));
    for (const name of fs.readdirSync(root)) expect(fs.statSync(path.join(root, name)).mode & 0o777).toBe(0o600);
    const nativeFile = path.join(root, "desktop-native.jsonl");
    fs.writeFileSync(nativeFile, JSON.stringify({ type: "session", id: ids[1], cwd: root, timestamp: "2026-10-12T00:00:00Z" }) + "\n");
    const alias = "native-pi:" + createHash("sha256").update(`${fs.realpathSync(nativeFile)}\0${ids[1]}`).digest("base64url").slice(0, 24);
    await adapter.start();
    await adapter.sendInputToSession(alias, "second task");
    expect(adapter.getState().sharedSessionId).toBe(ids[1]!);
    expect(prompts[0]).toEqual([]);
    expect(prompts[1]).toEqual([["second task", { deliverAs: "followUp" }]]);
    handlers[0]!.get("session_shutdown")?.({ reason: "reload" }, {});
    expect(discoverPiOwners(root).map((owner) => owner.sessionId)).toEqual([ids[1]!]);
    handlers[1]!.get("agent_settled")?.({}, {});
    expect(selectPiOwner(discoverPiOwners(root), ids[1], root)?.status).toBe("idle");
  } finally {
    await adapter.dispose();
    for (const handler of handlers) handler.get("session_shutdown")?.({ reason: "quit" }, {});
    if (previous === undefined) delete process.env.WERELAY_PI_OWNER_DIRECTORY; else process.env.WERELAY_PI_OWNER_DIRECTORY = previous;
    if (previousSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessions;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two owner advertisements for the same Pi task fail closed without sending or spawning", async () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-ambiguous-"));
  fs.chmodSync(root, 0o700);
  const previous = process.env.WERELAY_PI_OWNER_DIRECTORY;
  process.env.WERELAY_PI_OWNER_DIRECTORY = root;
  const id = "12345678-1234-1234-1234-123456789abc";
  const handlers = [new Map<string, (event: unknown, ctx: unknown) => void>(), new Map<string, (event: unknown, ctx: unknown) => void>()];
  const prompts: unknown[] = [];
  const adapter = new PiOwnerAdapter({ kind: "pi", command: "must-not-spawn", cwd: root, renderMode: "headless" });
  try {
    const extension = (await import(`../../bin/pi-owner-extension.mjs?ambiguous=${Date.now()}`)).default;
    for (const handler of handlers) {
      extension({ on: (name: string, cb: (event: unknown, ctx: unknown) => void) => handler.set(name, cb), sendUserMessage: (text: unknown) => prompts.push(text) });
      handler.get("session_start")?.({}, { cwd: root, sessionManager: { getSessionId: () => id }, isIdle: () => true });
    }
    const deadline = Date.now() + 1500;
    while (discoverPiOwners(root).length !== 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    expect(discoverPiOwners(root)).toHaveLength(2);
    await adapter.start();
    await expect(adapter.sendInputToSession(id, "must not send")).rejects.toThrow("多个 owner");
    expect(prompts).toEqual([]);
    expect((adapter as unknown as { child: unknown }).child).toBeNull();
    handlers[0]!.get("session_shutdown")?.({ reason: "reload" }, {});
    await Promise.all([adapter.sendInputToSession(id, "one"), adapter.sendInputToSession(id, "two")]);
    expect(prompts).toEqual(["one", "two"]);
  } finally {
    await adapter.dispose();
    for (const handler of handlers) handler.get("session_shutdown")?.({ reason: "quit" }, {});
    if (previous === undefined) delete process.env.WERELAY_PI_OWNER_DIRECTORY; else process.env.WERELAY_PI_OWNER_DIRECTORY = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

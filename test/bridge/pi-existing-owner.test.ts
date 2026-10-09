import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

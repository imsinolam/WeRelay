import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPiSessions } from "../../src/bridge/pi-session-catalog.ts";
import { PiOwnerAdapter } from "../../src/bridge/bridge-adapters.pi.ts";
import { discoverPiOwners } from "../../src/bridge/pi-owner-discovery.ts";
import { listLightweightAdapterSessions } from "../../src/daemon/global-task-catalog.ts";
import { buildGlobalTaskSnapshot, formatGlobalTaskList, updateGlobalTaskSnapshot } from "../../src/daemon/global-task-index.ts";

type Handler = (event: any, context: any) => void;

async function withPiOwners(check: (fixture: {
  root: string;
  start: (id: string, idle?: boolean, persist?: boolean) => Promise<{
    handlers: Map<string, Handler>;
    context: { isIdle: () => boolean };
  }>;
}) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-status-"));
  const previous = {
    owners: process.env.WERELAY_PI_OWNER_DIRECTORY,
    sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
    endpoint: process.env.WERELAY_PI_OWNER_SOCKET,
  };
  fs.chmodSync(root, 0o700);
  process.env.WERELAY_PI_OWNER_DIRECTORY = root;
  process.env.PI_CODING_AGENT_SESSION_DIR = root;
  delete process.env.WERELAY_PI_OWNER_SOCKET;
  const instances: Map<string, Handler>[] = [];
  try {
    const extension = (await import("../../bin/pi-owner-extension.mjs")).default;
    await check({ root, start: async (id, idle = true, persist = true) => {
      const handlers = new Map<string, Handler>();
      instances.push(handlers);
      const previousCount = discoverPiOwners(root).length;
      extension({ on: (name: string, handler: Handler) => handlers.set(name, handler) });
      const context = { cwd: root, sessionManager: {
        getSessionId: () => id, getSessionFile: () => path.join(root, `${id}.jsonl`),
      }, isIdle: () => idle };
      if (persist) fs.writeFileSync(path.join(root, `${id}.jsonl`), JSON.stringify({
        type: "session", id, cwd: root, timestamp: "2026-10-27T00:00:00Z",
      }) + "\n");
      handlers.get("session_start")!({}, context);
      const deadline = Date.now() + 1_500;
      while (discoverPiOwners(root).length !== previousCount + 1) {
        if (Date.now() >= deadline) throw new Error("Pi owner did not advertise");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return { handlers, context };
    } });
  } finally {
    for (const handlers of instances) handlers.get("session_shutdown")?.({ reason: "quit" }, {});
    for (const [key, value] of Object.entries({
      WERELAY_PI_OWNER_DIRECTORY: previous.owners,
      PI_CODING_AGENT_SESSION_DIR: previous.sessions,
      WERELAY_PI_OWNER_SOCKET: previous.endpoint,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Pi reports running during prompt preparation, before the model loop starts", async () => {
  if (process.platform === "win32") return;
  await withPiOwners(async ({ root, start }) => {
    const id = "12345678-1234-1234-1234-123456789abc";
    const { handlers, context } = await start(id);
    expect((await listPiSessions({ root }))[0]?.runtimeStatus).toEqual({ type: "idle" });
    // Pi marks the real session busy before async before_agent_start hooks.
    // agent_start may arrive much later; no socket is attached to WeRelay here.
    handlers.get("before_agent_start")?.({ messageType: "user", prompt: "fixture" }, context);
    expect((await listPiSessions({ root }))[0]?.runtimeStatus).toEqual({ type: "active", activeFlags: [] });
    const started = discoverPiOwners(root)[0]?.startedAtMs;
    expect(started).toBeGreaterThan(0);
    handlers.get("agent_start")?.({}, context);
    expect(discoverPiOwners(root)[0]?.startedAtMs).toBe(started);
    handlers.get("agent_settled")?.({}, context);
    expect((await listPiSessions({ root }))[0]?.runtimeStatus).toEqual({ type: "idle" });
  });
});

test("Pi includes a live running owner before its first JSONL write, then deduplicates the native session", async () => {
  if (process.platform === "win32") return;
  await withPiOwners(async ({ root, start }) => {
    const id = "22345678-1234-1234-1234-123456789abc";
    const { handlers, context } = await start(id, false, false);
    const original = await listPiSessions({ root });
    expect(original).toHaveLength(1);
    expect(original[0]).toMatchObject({ sessionId: id, projectName: path.basename(root), runtimeStatus: { type: "active" } });
    const firstSeen = original[0]!.lastUpdatedAt;
    expect((await listPiSessions({ root }))[0]?.lastUpdatedAt).toBe(firstSeen);
    fs.writeFileSync(path.join(root, "desktop-native.jsonl"), JSON.stringify({
      type: "session", id, cwd: root, timestamp: firstSeen,
    }) + "\n");
    expect(await listPiSessions({ root })).toHaveLength(1);
    handlers.get("agent_settled")?.({}, context);
    expect((await listPiSessions({ root }))[0]?.runtimeStatus).toEqual({ type: "idle" });
    handlers.get("session_shutdown")?.({ reason: "quit" }, {});
    expect((await listPiSessions({ root }))[0]?.runtimeStatus).toEqual({ type: "notLoaded" });
  });
});

test("CLI and Desktop native Pi owners retain independent status through the shared catalog and stable filter", async () => {
  if (process.platform === "win32") return;
  await withPiOwners(async ({ root, start }) => {
    const cli = "32345678-1234-1234-1234-123456789abc";
    const desktop = "42345678-1234-1234-1234-123456789abc";
    const cliOwner = await start(cli, false);
    const desktopOwner = await start(desktop, true);
    const candidates = await listLightweightAdapterSessions("pi", root, 100);
    const snapshot = buildGlobalTaskSnapshot(candidates.map((candidate) => ({ ...candidate, adapter: "pi" as const })));
    const output = formatGlobalTaskList({ snapshot, startIndex: 0, pageSize: 15 });
    expect(output).toStartWith("全部任务 · 1 个运行中");
    expect(output.match(/运行中 🟢/g)).toHaveLength(1);
    expect(output).not.toContain("处理中");
    desktopOwner.handlers.get("agent_start")?.({}, desktopOwner.context);
    cliOwner.handlers.get("agent_settled")?.({}, cliOwner.context);
    const refreshed = updateGlobalTaskSnapshot({ current: snapshot, refresh: false,
      latestCandidates: (await listLightweightAdapterSessions("pi", root, 100))
        .map((candidate) => ({ ...candidate, adapter: "pi" as const })),
    });
    expect(refreshed.numberByIdentity).toEqual(snapshot.numberByIdentity);
    expect(refreshed.candidates.find((candidate) => candidate.sessionId === cli)?.runtimeStatus?.type).toBe("idle");
    expect(refreshed.candidates.find((candidate) => candidate.sessionId === desktop)?.runtimeStatus?.type).toBe("active");
    expect(formatGlobalTaskList({ snapshot: refreshed, adapter: "pi", startIndex: 0, pageSize: 15 }))
      .toContain("运行中 🟢");
  });
});

test("preparation failure reconciles to the owner's real idle state without a fake completion", async () => {
  if (process.platform === "win32") return;
  await withPiOwners(async ({ root, start }) => {
    const id = "62345678-1234-1234-1234-123456789abc";
    const { handlers, context } = await start(id);
    handlers.get("before_agent_start")?.({}, context);
    expect((await listPiSessions({ root }))[0]?.runtimeStatus?.type).toBe("active");
    // A failed preparation has no agent_settled in Pi 1.4. The public owner
    // state is authoritative; wait for that condition rather than a fixed nap.
    const deadline = Date.now() + 2_000;
    while ((await listPiSessions({ root }))[0]?.runtimeStatus?.type !== "idle") {
      if (Date.now() > deadline) throw new Error("failed preparation stayed running");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    handlers.get("before_agent_start")?.({}, context);
    expect((await listPiSessions({ root }))[0]?.runtimeStatus?.type).toBe("active");
  });
});

test("ambiguous Pi owners never manufacture a running task before history exists", async () => {
  if (process.platform === "win32") return;
  await withPiOwners(async ({ root, start }) => {
    const id = "52345678-1234-1234-1234-123456789abc";
    await start(id, false, false);
    await start(id, false, false);
    expect(await listPiSessions({ root })).toEqual([]);
  });
});

test("fileless Pi owners cannot leak across catalog roots and legacy advertisements remain readable", async () => {
  if (process.platform === "win32") return;
  await withPiOwners(async ({ root, start }) => {
    const id = "a2345678-1234-1234-1234-123456789abc";
    await start(id, false, false);
    const otherRoot = path.join(root, "another-profile");
    fs.mkdirSync(otherRoot);
    expect(await listPiSessions({ root: otherRoot })).toEqual([]);
    const advertisement = path.join(root, fs.readdirSync(root).find((name) => name.endsWith(".json"))!);
    const legacy = JSON.parse(fs.readFileSync(advertisement, "utf8"));
    delete legacy.sessionFile;
    delete legacy.startedAtMs;
    fs.writeFileSync(advertisement, JSON.stringify(legacy));
    expect(await listPiSessions({ root })).toEqual([]);
    fs.writeFileSync(path.join(root, "legacy.jsonl"), JSON.stringify({
      type: "session", id, cwd: root, timestamp: "2026-10-27T00:00:00Z",
    }) + "\n");
    expect((await listPiSessions({ root }))[0]).toMatchObject({ sessionId: id, runtimeStatus: { type: "active" } });
  });
});

test("owner reconciliation clears connected Pi busy without inventing a completion", () => {
  const id = "72345678-1234-1234-1234-123456789abc";
  const adapter = new PiOwnerAdapter({ kind: "pi", command: "must-not-spawn", cwd: process.cwd(), renderMode: "headless", initialSharedSessionId: id });
  const events: { type: string }[] = [];
  adapter.setEventSink((event) => events.push(event));
  const internal = adapter as unknown as { token: string; handleRecord: (record: unknown) => void };
  internal.token = "fixture";
  internal.handleRecord({ type: "agent_start", token: "fixture", sessionId: id });
  expect(adapter.getState().status).toBe("busy");
  internal.handleRecord({ type: "status", token: "fixture", sessionId: id, status: "idle", run: null });
  expect(adapter.getState().status).toBe("idle");
  expect(events.some((event) => event.type === "task_complete" || event.type === "final_reply")).toBe(false);
});

test("a run first observed through isIdle does not inherit the previous failure outcome", async () => {
  if (process.platform === "win32") return;
  await withPiOwners(async ({ root, start }) => {
    const id = "92345678-1234-1234-1234-123456789abc";
    const { handlers, context } = await start(id);
    const adapter = new PiOwnerAdapter({ kind: "pi", command: "must-not-spawn", cwd: root, renderMode: "headless" });
    const events: { type: string; outcome?: string; text?: string }[] = [];
    adapter.setEventSink((event) => events.push(event));
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 2_000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error("Pi status condition timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    try {
      await adapter.start();
      await adapter.resumeSession(id);
      handlers.get("before_agent_start")?.({}, context);
      handlers.get("agent_before_settle")?.({ outcome: "error" }, context);
      handlers.get("agent_settled")?.({}, context);
      await until(() => events.some((event) => event.type === "task_complete"));
      // Pi can be busy compacting before it emits before_agent_start.
      context.isIdle = () => false;
      await until(() => adapter.getState().status === "busy");
      const started = discoverPiOwners(root)[0]?.startedAtMs;
      handlers.get("before_agent_start")?.({}, context);
      handlers.get("agent_start")?.({}, context);
      expect(discoverPiOwners(root)[0]?.startedAtMs).toBe(started);
      handlers.get("message_end")?.({ message: {
        role: "assistant", stopReason: "stop", content: [{ type: "text", text: "fixture success" }],
      } }, context);
      context.isIdle = () => true;
      handlers.get("agent_settled")?.({}, context);
      await until(() => events.filter((event) => event.type === "task_complete").length === 2);
      expect(events.filter((event) => event.type === "task_complete").map((event) => event.outcome))
        .toEqual(["failed", "completed"]);
      expect(events.find((event) => event.type === "final_reply")?.text).toBe("fixture success");
    } finally { await adapter.dispose(); }
  });
});

test("a disposed Pi context stops the observer and removes its advertisement", async () => {
  if (process.platform === "win32") return;
  await withPiOwners(async ({ root, start }) => {
    const { context } = await start("82345678-1234-1234-1234-123456789abc");
    context.isIdle = () => { throw new Error("fixture stale context"); };
    const deadline = Date.now() + 2_000;
    while (discoverPiOwners(root).length > 0) {
      if (Date.now() > deadline) throw new Error("stale context remained advertised");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
});

import { expect, test } from "bun:test";
import { CODEX_MOBILE_APP_JS } from "../../src/daemon/codex-mobile-web.ts";

function functionSource(name: string): string {
  const start = CODEX_MOBILE_APP_JS.indexOf("  function " + name + "(");
  if (start < 0) throw new Error("Missing " + name);
  const end = CODEX_MOBILE_APP_JS.indexOf("\n  function ", start + 1);
  return CODEX_MOBILE_APP_JS.slice(start, end < 0 ? undefined : end);
}

function asyncFunctionSource(name: string): string {
  const start = CODEX_MOBILE_APP_JS.indexOf("  async function " + name + "(");
  if (start < 0) throw new Error("Missing " + name);
  const end = CODEX_MOBILE_APP_JS.indexOf("\n  async function ", start + 1);
  const normalEnd = CODEX_MOBILE_APP_JS.indexOf("\n  function ", start + 1);
  const stop = [end, normalEnd].filter(index => index >= 0).sort((a, b) => a - b)[0];
  return CODEX_MOBILE_APP_JS.slice(start, stop < 0 ? undefined : stop);
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: any[] = [];
  listeners = Object.create(null);
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (event: any) => void) {
    (this.listeners[type] ||= []).push(listener);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open", {});
  }
  message(frame: unknown) {
    this.emit("message", { data: JSON.stringify(frame) });
  }
  close() {
    this.readyState = 3;
  }
  emit(type: string, event: any) {
    for (const listener of this.listeners[type] || []) listener(event);
  }
}

function liveRuntime(options: {
  hidden?: boolean;
  now?: number;
  refresh?: () => Promise<unknown>;
} = {}) {
  const timers: Array<{ id: number; callback: () => void; delay: number; interval: boolean }> = [];
  let nextTimerId = 1;
  const now = options.now ?? 1_000_000;
  const state: any = {
    authenticated: true,
    cachePreviewMode: false,
    currentAdapter: "codex",
    currentThreadId: "task-a",
    tasks: [{ threadId: "task-a", adapter: "codex", status: "idle" }],
    contentRevision: "rev-1",
    liveConnected: false,
    liveHelloReceived: false,
    liveConnecting: false,
    liveSocket: null,
    liveReconnectAttempts: 0,
    liveRetryTimer: null,
    livePingTimer: null,
    liveWatchdogTimer: null,
    liveHelloTimer: null,
    liveLastFrameAtMs: 0,
    liveUnsupportedUntilMs: 0,
    liveSubscriptionKey: "",
    liveRefreshInFlight: false,
    liveRefreshTrailing: false,
    liveTasksRefreshTimer: null,
    nextTaskRefreshAtMs: 0,
    conversationSnapshots: Object.create(null),
    conversationSnapshotOrder: [],
    loadingMessages: false,
  };
  const document = { hidden: Boolean(options.hidden) };
  const refreshes: string[] = [];
  const taskLoads: string[] = [];
  const runtime = new Function(
    "state",
    "document",
    "window",
    "Date",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "conversationStateKey",
    "currentTask",
    "isTemporaryTask",
    "refreshMessagesIfChanged",
    "loadTasks",
    "scheduleLiveRefresh",
    "setBoundedConversationValue",
    "schedulePersistentMobileCacheWrite",
    "api",
    "adapterApiPath",
    "PREWARM_GAP_MS",
    "MAX_CONVERSATION_SNAPSHOTS",
    "LIVE_PING_INTERVAL_MS",
    "LIVE_WATCHDOG_TIMEOUT_MS",
    "LIVE_HELLO_TIMEOUT_MS",
    "LIVE_MESSAGE_REFRESH_INTERVAL_MS",
    "LIVE_TASK_REFRESH_INTERVAL_MS",
    "TASK_REFRESH_INTERVAL_MS",
    "LIVE_HIDDEN_DISCONNECT_MS",
    "LIVE_RECONNECT_BASE_MS",
    "LIVE_RECONNECT_MAX_MS",
    "LIVE_UNSUPPORTED_COOLDOWN_MS",
    [
      functionSource("liveChannelUrl"),
      functionSource("liveSubscriptionTarget"),
      functionSource("sendLiveFrame"),
      functionSource("clearLiveTimers"),
      functionSource("stopLiveChannel"),
      functionSource("liveReconnectDelay"),
      functionSource("scheduleLiveReconnect"),
      functionSource("noteLiveFailureBeforeHello"),
      functionSource("syncLiveSubscriptions"),
      functionSource("markConversationSnapshotStale"),
      functionSource("refreshCurrentMessagesFromLive"),
      functionSource("handleLiveFrame"),
      functionSource("startLiveChannel"),
      functionSource("liveMessagePollingInterval"),
      functionSource("liveTaskPollingInterval"),
      "return {startLiveChannel,stopLiveChannel,syncLiveSubscriptions,handleLiveFrame,liveMessagePollingInterval,liveTaskPollingInterval,markConversationSnapshotStale};",
    ].join("\n")
  )(
    state,
    document,
    { WebSocket: FakeSocket, location: { href: "https://relay.example.com/app?adapter=codex", origin: "https://relay.example.com" } },
    class extends Date { static now() { return now; } },
    (callback: () => void, delay: number) => {
      const id = nextTimerId++;
      timers.push({ id, callback, delay, interval: false });
      return id;
    },
    (id: number) => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
    (callback: () => void, delay: number) => {
      const id = nextTimerId++;
      timers.push({ id, callback, delay, interval: true });
      return id;
    },
    (id: number) => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
    (adapter: string, threadId: string) => adapter + "\u0000" + threadId,
    () => state.tasks.find((task: any) => task.threadId === state.currentThreadId) || null,
    (task: any) => Boolean(task && task.localCreationState),
    async () => {
      refreshes.push(state.currentThreadId);
      return await (options.refresh ? options.refresh() : {});
    },
    async () => { taskLoads.push(state.currentAdapter); return []; },
    () => {},
    () => {},
    async () => ({ messages: [] }),
    (path: string) => path,
    400,
    (values: any, order: string[], key: string, value: any, limit: number) => {
      values[key] = value;
      const existing = order.indexOf(key);
      if (existing >= 0) order.splice(existing, 1);
      order.push(key);
      while (order.length > limit) delete values[order.shift()!];
    },
    12,
    25000,
    45000,
    45000,
    15000,
    30000,
    8000,
    30000,
    1000,
    30000,
    600000,
  );
  return { runtime, state, timers, refreshes, taskLoads };
}

test("live connection subscribes to the current task and replaces the subscription on task switch", () => {
  FakeSocket.instances = [];
  const h = liveRuntime();
  h.runtime.startLiveChannel();
  const socket = FakeSocket.instances[0];
  expect(socket.url).toBe("wss://relay.example.com/api/live");
  socket.open();
  socket.message({ v: 1, type: "hello" });
  expect(socket.sent).toContainEqual({ v: 1, type: "subscribe", adapter: "codex", threadId: "task-a" });

  h.state.currentThreadId = "local-new-draft";
  h.state.tasks.push({ threadId: "local-new-draft", adapter: "codex", localCreationState: "ready" });
  h.runtime.syncLiveSubscriptions();
  expect(socket.sent).toContainEqual({ v: 1, type: "unsubscribe", adapter: "codex", threadId: "task-a" });

  h.state.currentThreadId = "task-b";
  h.state.tasks.push({ threadId: "task-b", adapter: "codex", status: "idle" });
  h.runtime.syncLiveSubscriptions();
  expect(socket.sent).toContainEqual({ v: 1, type: "subscribe", adapter: "codex", threadId: "task-b" });
});

test("live URL stays same-origin and same-prefix without adapter parameters", () => {
  FakeSocket.instances = [];
  const h = liveRuntime();
  h.runtime.startLiveChannel();
  expect(FakeSocket.instances[0].url).toBe("wss://relay.example.com/api/live");
});

test("live changed refreshes only the current task and deduplicates the known revision", () => {
  FakeSocket.instances = [];
  const h = liveRuntime();
  h.runtime.startLiveChannel();
  FakeSocket.instances[0].open();
  FakeSocket.instances[0].message({ v: 1, type: "hello" });

  h.runtime.handleLiveFrame({ v: 1, type: "changed", adapter: "codex", threadId: "other", revision: "rev-o" });
  expect(h.refreshes).toEqual([]);
  expect(h.state.conversationSnapshots["codex\u0000other"]).toBeUndefined();
  h.state.conversationSnapshots["codex\u0000other"] = { staleRevision: "" };
  h.runtime.handleLiveFrame({ v: 1, type: "changed", adapter: "codex", threadId: "other", revision: "rev-o" });
  expect(h.state.conversationSnapshots["codex\u0000other"].staleRevision).toBe("rev-o");

  h.runtime.handleLiveFrame({ v: 1, type: "changed", adapter: "codex", threadId: "task-a", revision: "rev-1" });
  expect(h.refreshes).toEqual([]);
  h.state.conversationSnapshots["codex\u0000task-a"] = { staleRevision: "" };
  h.runtime.handleLiveFrame({ v: 1, type: "changed", adapter: "codex", threadId: "task-a", revision: "rev-2" });
  expect(h.refreshes).toEqual(["task-a"]);
  expect(h.state.conversationSnapshots["codex\u0000task-a"].staleRevision).toBe("rev-2");
});

test("live changed refreshes are mutually exclusive and replay one trailing refresh", async () => {
  FakeSocket.instances = [];
  let resolveRefresh!: () => void;
  let refreshCalls = 0;
  const refreshGate = new Promise<void>(resolve => { resolveRefresh = resolve; });
  const h = liveRuntime({ refresh: () => {
    refreshCalls += 1;
    return refreshCalls === 1 ? refreshGate : Promise.resolve();
  } });
  h.runtime.startLiveChannel();
  FakeSocket.instances[0].open();
  FakeSocket.instances[0].message({ v: 1, type: "hello" });
  h.runtime.handleLiveFrame({ v: 1, type: "changed", adapter: "codex", threadId: "task-a", revision: "rev-2" });
  h.runtime.handleLiveFrame({ v: 1, type: "changed", adapter: "codex", threadId: "task-a", revision: "rev-3" });
  expect(h.refreshes).toEqual(["task-a"]);
  expect(h.state.liveRefreshTrailing).toBe(true);
  resolveRefresh();
  await refreshGate;
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(h.refreshes).toEqual(["task-a", "task-a"]);
  expect(h.state.liveRefreshTrailing).toBe(false);
});

test("tasks-changed coalesces task-list loads after 300ms", () => {
  FakeSocket.instances = [];
  const h = liveRuntime();
  h.runtime.startLiveChannel();
  FakeSocket.instances[0].open();
  FakeSocket.instances[0].message({ v: 1, type: "hello" });
  h.runtime.handleLiveFrame({ v: 1, type: "tasks-changed", adapter: "codex" });
  h.runtime.handleLiveFrame({ v: 1, type: "tasks-changed", adapter: "codex" });
  const timer = h.timers.filter(entry => entry.delay === 300);
  expect(timer).toHaveLength(1);
  timer[0].callback();
  expect(h.taskLoads).toEqual(["codex"]);
});

test("three failures before hello stop retrying and polling downgrades only after hello", () => {
  FakeSocket.instances = [];
  const h = liveRuntime();
  expect(h.runtime.liveMessagePollingInterval()).toBe(2200);
  for (let attempt = 0; attempt < 2; attempt++) {
    h.runtime.startLiveChannel();
    const socket = FakeSocket.instances[attempt];
    socket.open();
    socket.emit("close", {});
    const retry = h.timers.find(timer => !timer.interval && timer.delay >= 800 && timer.delay <= 2400);
    expect(retry).toBeDefined();
    retry.callback();
  }
  h.runtime.startLiveChannel();
  const finalSocket = FakeSocket.instances[2];
  finalSocket.open();
  finalSocket.emit("close", {});
  expect(FakeSocket.instances).toHaveLength(3);
  expect(h.state.liveUnsupportedUntilMs).toBeGreaterThan(1_000_000);

  FakeSocket.instances = [];
  const connected = liveRuntime();
  connected.runtime.startLiveChannel();
  FakeSocket.instances[0].open();
  expect(connected.runtime.liveMessagePollingInterval()).toBe(2200);
  FakeSocket.instances[0].message({ v: 1, type: "hello" });
  expect(connected.runtime.liveMessagePollingInterval()).toBe(15000);
  expect(connected.runtime.liveTaskPollingInterval()).toBe(30000);
});

test("losing a connected live channel restores the normal task polling deadline", () => {
  FakeSocket.instances = [];
  const h = liveRuntime();
  h.runtime.startLiveChannel();
  FakeSocket.instances[0].open();
  FakeSocket.instances[0].message({ v: 1, type: "hello" });
  h.state.nextTaskRefreshAtMs = 1_000_000 + 30_000;
  h.state.lastTaskRefreshAtMs = 1_000_000;
  FakeSocket.instances[0].emit("close", {});
  expect(h.state.nextTaskRefreshAtMs).toBe(1_000_000 + 8_000);
  expect(h.state.lastTaskRefreshAtMs).toBe(0);
});

function prewarmRuntime() {
  const state: any = {
    authenticated: true,
    currentAdapter: "codex",
    currentThreadId: "current",
    tasks: [],
    conversationSnapshots: Object.create(null),
    conversationSnapshotOrder: [],
    conversationSnapshotSavedAtMs: Object.create(null),
    prewarmTimer: null,
    prewarmIdleHandle: null,
    prewarmRunId: 0,
  };
  const document = { hidden: false };
  const runtime = new Function(
    "state",
    "document",
    "window",
    "Date",
    "setTimeout",
    "conversationStateKey",
    "isTemporaryTask",
    "isTaskBoardInProgress",
    "taskRecencyMs",
    "filterVisibleConversationMessages",
    "normalizeMessagePage",
    "setBoundedConversationValue",
    "schedulePersistentMobileCacheWrite",
    "api",
    "adapterApiPath",
    "PREWARM_GAP_MS",
    "MAX_CONVERSATION_SNAPSHOTS",
    "PREWARM_MAX_TASKS",
    "PREWARM_SNAPSHOT_MAX_AGE_MS",
    [
      functionSource("recentTaskPrewarmCandidates"),
      functionSource("recentTaskSnapshotFresh"),
      functionSource("prewarmConversationSnapshot"),
      asyncFunctionSource("prewarmRecentTasks"),
      "return {recentTaskPrewarmCandidates,recentTaskSnapshotFresh,prewarmConversationSnapshot,prewarmRecentTasks};",
    ].join("\n")
  )(
    state,
    document,
    {},
    Date,
    setTimeout,
    (adapter: string, threadId: string) => adapter + "\u0000" + threadId,
    (task: any) => Boolean(task && task.localCreationState),
    (task: any) => Boolean(task && ["running", "approval", "input"].includes(task.status)),
    (task: any) => Date.parse(task.lastUpdatedAt || "") || 0,
    (messages: unknown[]) => messages,
    () => ({ hasMore: true, nextBefore: "40", source: "native", caughtUp: false }),
    (values: any, order: string[], key: string, value: any, limit: number) => {
      values[key] = value;
      const existing = order.indexOf(key);
      if (existing >= 0) order.splice(existing, 1);
      order.push(key);
      while (order.length > limit) delete values[order.shift()!];
    },
    () => {},
    async () => ({ messages: [] }),
    (path: string) => path,
    400,
    12,
    6,
    60000,
  );
  return { runtime, state };
}

test("prewarm orders running tasks first, skips current and temporary tasks, and caps at six", () => {
  const h = prewarmRuntime();
  h.state.tasks = [
    { threadId: "current", adapter: "codex", status: "running", lastUpdatedAt: "2026-11-04T10:00:00Z" },
    { threadId: "idle-new", adapter: "codex", status: "idle", lastUpdatedAt: "2026-11-04T09:00:00Z" },
    { threadId: "local-new-draft", adapter: "codex", status: "idle", localCreationState: "ready" },
    { threadId: "running-old", adapter: "codex", status: "running", lastUpdatedAt: "2026-11-04T01:00:00Z" },
    { threadId: "approval", adapter: "codex", status: "approval", lastUpdatedAt: "2026-11-04T02:00:00Z" },
    { threadId: "idle-latest", adapter: "codex", status: "idle", lastUpdatedAt: "2026-11-04T08:00:00Z" },
    { threadId: "idle-2", adapter: "codex", status: "idle", lastUpdatedAt: "2026-11-04T07:00:00Z" },
    { threadId: "idle-3", adapter: "codex", status: "idle", lastUpdatedAt: "2026-11-04T06:00:00Z" },
    { threadId: "idle-4", adapter: "codex", status: "idle", lastUpdatedAt: "2026-11-04T05:00:00Z" },
    { threadId: "idle-5", adapter: "codex", status: "idle", lastUpdatedAt: "2026-11-04T04:00:00Z" },
  ];
  expect(h.runtime.recentTaskPrewarmCandidates(h.state.tasks, "codex", "current").map((task: any) => task.threadId))
    .toEqual(["approval", "running-old", "idle-new", "idle-latest", "idle-2", "idle-3"]);
});

test("prewarm skips fresh snapshots but refreshes stale or expired ones", () => {
  const h = prewarmRuntime();
  const now = 1_000_000;
  h.state.conversationSnapshots["codex\u0000fresh"] = { staleRevision: "" };
  h.state.conversationSnapshotSavedAtMs["codex\u0000fresh"] = now - 59_000;
  h.state.conversationSnapshots["codex\u0000stale"] = { staleRevision: "rev-2" };
  h.state.conversationSnapshotSavedAtMs["codex\u0000stale"] = now - 1_000;
  h.state.conversationSnapshots["codex\u0000expired"] = { staleRevision: "" };
  h.state.conversationSnapshotSavedAtMs["codex\u0000expired"] = now - 61_000;
  expect(h.runtime.recentTaskSnapshotFresh("codex", "fresh", now)).toBe(true);
  expect(h.runtime.recentTaskSnapshotFresh("codex", "stale", now)).toBe(false);
  expect(h.runtime.recentTaskSnapshotFresh("codex", "expired", now)).toBe(false);
});

test("prewarm snapshots include every field read by conversation restore", () => {
  const h = prewarmRuntime();
  h.runtime.prewarmConversationSnapshot("codex", "prewarmed", {
    messages: [{ id: "m1", role: "assistant", text: "done" }],
    revision: "rev-prewarm",
  });
  const snapshot = h.state.conversationSnapshots["codex\u0000prewarmed"];
  expect(Array.isArray(snapshot.serverMessages)).toBe(true);
  expect(Array.isArray(snapshot.outboundMessages)).toBe(true);
  expect(Array.isArray(snapshot.historyMessages)).toBe(true);
  expect(Array.isArray(snapshot.latestMessages)).toBe(true);
  expect(Array.isArray(snapshot.progressItems)).toBe(true);
  expect(Array.isArray(snapshot.pendingMessages)).toBe(true);
  expect(Array.isArray(snapshot.queuedMessages)).toBe(true);
  expect(Array.isArray(snapshot.approvalResults)).toBe(true);
  expect(snapshot.contentRevision).toBe("rev-prewarm");
});

test("prewarm keeps local pending send state in an existing snapshot", () => {
  const h = prewarmRuntime();
  h.state.conversationSnapshots["codex\u0000prewarmed"] = {
    serverMessages: [{ id: "old", role: "assistant", text: "old" }],
    outboundMessages: [{ clientId: "outbox-1", role: "user", text: "outbox" }],
    deliveredClientIds: ["outbox-1"],
    pendingMessages: [{ clientId: "pending-1", role: "user", text: "pending" }],
    progressItems: [{ id: "progress-1", turnId: "turn-1" }],
    queuedMessages: [{ id: "queue-1", text: "queued" }],
    pendingImages: [{ fileName: "draft.png" }],
    runSummary: { status: "running", turnId: "turn-1" },
    nearBottom: false,
    scrollTop: 42,
  };
  h.runtime.prewarmConversationSnapshot("codex", "prewarmed", {
    messages: [{ id: "m1", role: "assistant", text: "new" }],
    revision: "rev-prewarm",
  });
  const snapshot = h.state.conversationSnapshots["codex\u0000prewarmed"];
  expect(snapshot.serverMessages).toEqual([{ id: "m1", role: "assistant", text: "new" }]);
  expect(snapshot.latestMessages).toEqual(snapshot.serverMessages);
  expect(snapshot.outboundMessages).toEqual([{ clientId: "outbox-1", role: "user", text: "outbox" }]);
  expect(snapshot.pendingMessages).toEqual([{ clientId: "pending-1", role: "user", text: "pending" }]);
  expect(snapshot.queuedMessages).toEqual([{ id: "queue-1", text: "queued" }]);
  expect(snapshot.pendingImages).toEqual([{ fileName: "draft.png" }]);
  expect(snapshot.runSummary).toEqual({ status: "running", turnId: "turn-1" });
  expect(snapshot.nearBottom).toBe(false);
  expect(snapshot.scrollTop).toBe(42);
});

test("prewarm pauses while the current task is loading and spaces task reads by 400ms", async () => {
  const h = prewarmRuntime();
  const calls: string[] = [];
  const waits: number[] = [];
  h.state.tasks = [
    { threadId: "current", adapter: "codex", status: "idle" },
    { threadId: "one", adapter: "codex", status: "idle", lastUpdatedAt: "2026-11-04T09:00:00Z" },
    { threadId: "two", adapter: "codex", status: "idle", lastUpdatedAt: "2026-11-04T08:00:00Z" },
    { threadId: "three", adapter: "codex", status: "idle", lastUpdatedAt: "2026-11-04T07:00:00Z" },
  ];
  h.state.loadingMessages = true;
  h.state.conversationSnapshots["codex\u0000three"] = { staleRevision: "" };
  h.state.conversationSnapshotSavedAtMs["codex\u0000three"] = Date.now();
  const runtime = new Function(
    "state",
    "document",
    "Date",
    "setTimeout",
    "conversationStateKey",
    "isTemporaryTask",
    "isTaskBoardInProgress",
    "taskRecencyMs",
    "filterVisibleConversationMessages",
    "normalizeMessagePage",
    "setBoundedConversationValue",
    "schedulePersistentMobileCacheWrite",
    "api",
    "adapterApiPath",
    "PREWARM_GAP_MS",
    "MAX_CONVERSATION_SNAPSHOTS",
    "PREWARM_MAX_TASKS",
    "PREWARM_SNAPSHOT_MAX_AGE_MS",
    [
      functionSource("recentTaskPrewarmCandidates"),
      functionSource("recentTaskSnapshotFresh"),
      functionSource("prewarmConversationSnapshot"),
      asyncFunctionSource("prewarmRecentTasks"),
      "return {prewarmRecentTasks};",
    ].join("\n"),
  )(
    h.state,
    { hidden: false },
    Date,
    (callback: () => void, delay: number) => {
      waits.push(delay);
      if (h.state.loadingMessages) h.state.loadingMessages = false;
      callback();
      return waits.length;
    },
    (adapter: string, threadId: string) => adapter + "\u0000" + threadId,
    (task: any) => Boolean(task && task.localCreationState),
    (task: any) => Boolean(task && ["running", "approval", "input"].includes(task.status)),
    (task: any) => Date.parse(task.lastUpdatedAt || "") || 0,
    (messages: unknown[]) => messages,
    () => ({ hasMore: false, nextBefore: null, source: "native", caughtUp: true }),
    (values: any, order: string[], key: string, value: any, limit: number) => {
      values[key] = value;
      order.push(key);
      while (order.length > limit) delete values[order.shift()!];
    },
    () => {},
    async (path: string) => {
      calls.push(path);
      return { messages: [], revision: "rev" };
    },
    (path: string) => path,
    400,
    12,
    6,
    60000,
  );
  await runtime.prewarmRecentTasks();
  expect(waits.some(delay => delay > 0 && delay <= 400)).toBe(true);
  expect(calls).toEqual([
    "/api/tasks/one/messages?limit=40&history=1",
    "/api/tasks/two/messages?limit=40&history=1",
  ]);
});

test("prewarm keeps task reads at least 400ms apart even when a read takes time", async () => {
  const h = prewarmRuntime();
  const calls: string[] = [];
  const waits: number[] = [];
  const startedAtMs: number[] = [];
  h.state.tasks = [
    { threadId: "current", adapter: "codex", status: "idle" },
    { threadId: "one", adapter: "codex", status: "idle", lastUpdatedAt: "2026-11-04T09:00:00Z" },
    { threadId: "two", adapter: "codex", status: "idle", lastUpdatedAt: "2026-11-04T08:00:00Z" },
  ];
  const runtime = new Function(
    "state",
    "document",
    "Date",
    "setTimeout",
    "conversationStateKey",
    "isTemporaryTask",
    "isTaskBoardInProgress",
    "taskRecencyMs",
    "filterVisibleConversationMessages",
    "normalizeMessagePage",
    "setBoundedConversationValue",
    "schedulePersistentMobileCacheWrite",
    "api",
    "adapterApiPath",
    "PREWARM_GAP_MS",
    "MAX_CONVERSATION_SNAPSHOTS",
    "PREWARM_MAX_TASKS",
    "PREWARM_SNAPSHOT_MAX_AGE_MS",
    [
      functionSource("recentTaskPrewarmCandidates"),
      functionSource("recentTaskSnapshotFresh"),
      functionSource("prewarmConversationSnapshot"),
      asyncFunctionSource("prewarmRecentTasks"),
      "return {prewarmRecentTasks};",
    ].join("\n"),
  )(
    h.state,
    { hidden: false },
    Date,
    (callback: () => void, delay: number) => {
      waits.push(delay);
      callback();
      return waits.length;
    },
    (adapter: string, threadId: string) => adapter + "\u0000" + threadId,
    (task: any) => Boolean(task && task.localCreationState),
    (task: any) => Boolean(task && ["running", "approval", "input"].includes(task.status)),
    (task: any) => Date.parse(task.lastUpdatedAt || "") || 0,
    (messages: unknown[]) => messages,
    () => ({ hasMore: false, nextBefore: null, source: "native", caughtUp: true }),
    (values: any, order: string[], key: string, value: any, limit: number) => {
      values[key] = value;
      order.push(key);
      while (order.length > limit) delete values[order.shift()!];
    },
    () => {},
    async (path: string) => {
      calls.push(path);
      startedAtMs.push(Date.now());
      return { messages: [], revision: "rev" };
    },
    (path: string) => path,
    400,
    12,
    6,
    60000,
  );
  await runtime.prewarmRecentTasks();
  expect(waits.some(delay => delay > 0 && delay <= 400)).toBe(true);
  expect(calls).toEqual([
    "/api/tasks/one/messages?limit=40&history=1",
    "/api/tasks/two/messages?limit=40&history=1",
  ]);
  expect(waits.some(delay => delay > 0 && delay <= 400)).toBe(true);
  expect(startedAtMs).toHaveLength(2);
});

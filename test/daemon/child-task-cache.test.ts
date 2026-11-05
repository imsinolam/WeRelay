import { expect, test } from "bun:test";
import { WeRelayDaemon } from "../../src/daemon/werelay-daemon.ts";
import { BoundedTtlMap } from "../../src/utils/bounded-ttl-cache.ts";

function fixture(load: (...args: unknown[]) => Promise<unknown[]>) {
  return Object.assign(Object.create(WeRelayDaemon.prototype), {
    cwd: "/fixture", resolveMobileAdapter: (adapter: string) => adapter,
    mobileChildTaskCache: new BoundedTtlMap({ maxSize: 32, ttlMs: 60_000 }),
    mobileChildTaskReads: new Map(), globalTaskCatalogWorker: { loadChildren: load },
    slots: new Map(), globalTaskListSnapshot: { candidates: ["main"] },
  }) as any;
}

test("child inspection coalesces reads without creating slots or populating normal task/number caches", async () => {
  let resolve!: (value: unknown[]) => void;
  const calls: unknown[] = [];
  const daemon = fixture((...args) => { calls.push(args); return new Promise(yes => { resolve = yes; }); });
  const first = daemon.listMobileChildTasks("parent", "codex");
  const second = daemon.listMobileChildTasks("parent", "codex");
  expect(calls).toEqual([["codex", "/fixture", "parent", 100]]);
  resolve([
    { sessionId: "child", parentThreadId: "parent", title: "审查", runtimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] } },
    { sessionId: "unrelated", parentThreadId: "other" }, { sessionId: "parent", parentThreadId: "parent" },
  ]);
  expect(await first).toEqual([{ threadId: "child", parentThreadId: "parent", title: "审查", status: "approval", lastUpdatedAt: undefined }]);
  expect(await second).toEqual(await first);
  expect(await daemon.listMobileChildTasks("parent", "codex")).toEqual(await first);
  expect(calls).toHaveLength(1);
  expect(daemon.slots.size).toBe(0);
  expect(daemon.globalTaskListSnapshot.candidates).toEqual(["main"]);
  expect(daemon.mobileChildTaskReads.size).toBe(0);
});

test("child cache isolates adapters and parents; failed reads can retry and pending work is bounded", async () => {
  let failed = true;
  let reads = 0;
  const daemon = fixture(async (_adapter, _cwd, parent) => {
    reads++;
    if (failed) throw new Error("offline");
    return [{ sessionId: "child", parentThreadId: parent, title: "审查" }];
  });
  await expect(daemon.listMobileChildTasks("parent", "codex")).rejects.toThrow("offline");
  expect(daemon.mobileChildTaskReads.size).toBe(0);
  failed = false;
  await daemon.listMobileChildTasks("parent", "codex");
  await daemon.listMobileChildTasks("parent", "deepseek");
  await daemon.listMobileChildTasks("other", "codex");
  expect(reads).toBe(4);
  expect(await daemon.listMobileChildTasks("fork", "pi")).toEqual([]);
  expect(await daemon.listMobileChildTasks("local-new-draft", "codex")).toEqual([]);
  for (let i = 0; i < 16; i++) daemon.mobileChildTaskReads.set(String(i), new Promise(() => {}));
  await expect(daemon.listMobileChildTasks("another", "codex")).rejects.toThrow("繁忙");
  expect(reads).toBe(4);
});

test("child transcript preview reads only the existing owner and skips live follow, recovery and progress", async () => {
  const reads: unknown[] = [];
  const forbidden = () => { throw new Error("must not start, select, send or follow an owner"); };
  const runtime = {
    getSessionMessagePage: async (id: string, options: unknown) => {
      reads.push({ id, options });
      return { messages: [{ role: "assistant", text: "只读子任务原文" }], hasMore: false, nextBefore: null };
    },
    start: forbidden, resumeSession: forbidden, followSession: forbidden, sendInput: forbidden,
    getSessionRunSummary: forbidden, getSessionProgress: forbidden,
  };
  const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
    cwd: "/fixture", resolveMobileAdapter: () => "codex", getMobileSlot: () => ({ adapter: "codex", runtime }),
    reconcileFailedMobileMessages: forbidden, getSlotActiveTask: () => null, getMobilePendingApproval: () => null,
    mobileMessageOutbox: {
      resolveRequestedThread: () => null, deliveredClientIds: () => [], list: () => [],
      reconcileFailedExecution: () => {}, reconcile: () => {},
    },
    openAgentLogHistory: { readPage: async () => null },
    mobileMessageImageStore: { enrich: (messages: unknown[]) => messages },
    messageRecords: { confirmClawbotReceipts: () => {} }, stateStore: { getMobileApprovalResults: () => [] },
  }) as any;
  const options = { limit: 30, historyOnly: true, lightweight: true };
  const result = await daemon.readMobileMessages("child", options, "codex");
  expect(reads).toEqual([{ id: "child", options }]);
  expect(result).toMatchObject({ threadId: "child", messages: [{ text: "只读子任务原文" }], progressItems: [], runSummary: null });

  // OpenCode's existing owner exposes only the legacy full-history reader.
  // Its preview must obey the same 30-message limit as paged adapters.
  const messages = Array.from({ length: 45 }, (_, index) => ({ role: "assistant", text: String(index) }));
  daemon.resolveMobileAdapter = () => "opencode";
  daemon.getMobileSlot = () => ({ adapter: "opencode", runtime: { getSessionMessages: async () => messages } });
  const tail = await daemon.readMobileMessages("child", options, "opencode");
  expect(tail.messages.map((message: any) => message.text)).toEqual(messages.slice(-30).map((message) => message.text));
  expect(tail.messagePage).toMatchObject({ hasMore: true, nextBefore: "15" });
  const earlier = await daemon.readMobileMessages("child", { ...options, before: "15" }, "opencode");
  expect(earlier.messages.map((message: any) => message.text)).toEqual(messages.slice(0, 15).map((message) => message.text));
  expect(earlier.messagePage).toMatchObject({ hasMore: false, nextBefore: null });
});

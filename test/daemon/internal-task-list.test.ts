import { expect, test } from "bun:test";
import { WeRelayDaemon, codexTaskMonitorRetryDelayMs, resolveDaemonBareNumericReply, resolveDaemonTaskListSnapshot, resolveDaemonTaskTargetedMessage } from "../../src/daemon/werelay-daemon.ts";
import { formatResumeSessionList } from "../../src/bridge/bridge-utils.ts";
import { ApprovalNotificationDeliveryQueue } from "../../src/daemon/approval-notification-delivery.ts";
import {
  buildGlobalTaskSnapshot, countRunningGlobalTasks, formatGlobalTaskList,
  globalTaskIdentityKey, paginateGlobalTaskSnapshot, resolveGlobalTaskCandidate,
  resolveGlobalTaskTargetedMessage, searchGlobalTaskCandidates, updateGlobalTaskSnapshot,
  type GlobalTaskCandidate,
} from "../../src/daemon/global-task-index.ts";
import { BoundedTtlMap } from "../../src/utils/bounded-ttl-cache.ts";

function task(sessionId: string, extra: Partial<GlobalTaskCandidate> = {}): GlobalTaskCandidate {
  return { adapter: "codex", sessionId, title: sessionId, lastUpdatedAt: "2026-10-22T10:00:00Z", ...extra };
}

test("internal reviews and child tasks never occupy list numbers, pages, search or running counts", () => {
  const candidates = [
    task("review", { source: JSON.stringify({ subagent: { other: "guardian" } }), runtimeStatus: { type: "active", activeFlags: [] } }),
    task("child", { parentThreadId: "parent" }),
    task("parent", { title: "Guardian review" }),
    task("review", { adapter: "pi", title: "普通 Pi 任务" }),
  ];
  const snapshot = buildGlobalTaskSnapshot(candidates);
  expect(snapshot.candidates.map((item) => `${item.adapter}:${item.sessionId}`)).toEqual(["codex:parent", "pi:review"]);
  expect(countRunningGlobalTasks(candidates)).toBe(0);
  expect(paginateGlobalTaskSnapshot(snapshot, { startIndex: 0, pageSize: 1 }).hasMore).toBe(true);
  expect(searchGlobalTaskCandidates(snapshot, "child")).toEqual([]);
  expect(resolveGlobalTaskCandidate(snapshot, "codex:review")).toBeNull();
  expect(resolveGlobalTaskTargetedMessage({ snapshot, text: "2：继续" })?.candidate.adapter).toBe("pi");
  expect(formatGlobalTaskList({ snapshot, adapter: "codex", startIndex: 0, pageSize: 10 })).toContain("1、[Codex]");
});

test("an origin-bearing duplicate cannot be overwritten by newer metadata-free cache entries", () => {
  const child = task("child", { parentThreadId: "parent" });
  const newer = task("child", { lastUpdatedAt: "2026-10-22T11:00:00Z" });
  expect(buildGlobalTaskSnapshot([child, newer]).candidates).toEqual([]);
  expect(buildGlobalTaskSnapshot([newer, child]).candidates).toEqual([]);
});

test("discovering an internal origin retires that number without rerouting any previously visible number", () => {
  const initial = buildGlobalTaskSnapshot([task("a"), task("b"), task("c")]);
  const updated = updateGlobalTaskSnapshot({ current: initial, refresh: false, latestCandidates: [task("b", { source: "subagent" })] });
  expect(updated.candidates.map((item) => item.sessionId)).toEqual(["a", "c"]);
  expect(resolveGlobalTaskCandidate(updated, "2")).toBeNull();
  expect(resolveGlobalTaskCandidate(updated, "3")?.sessionId).toBe("c");
  const appended = updateGlobalTaskSnapshot({ current: updated, refresh: false, latestCandidates: [task("d")] });
  expect(appended.numberByIdentity.get(globalTaskIdentityKey("codex", "d"))).toBe(4);
  expect(resolveGlobalTaskTargetedMessage({ snapshot: appended, text: "3：继续" })?.candidate.sessionId).toBe("c");
  expect(resolveGlobalTaskCandidate(appended, "2")).toBeNull();
});

test("legacy terminal snapshots also retain stable numbers and reject retired selection", () => {
  const initial = resolveDaemonTaskListSnapshot({ latestCandidates: [task("a"), task("b"), task("c")], refresh: true });
  const snapshot = resolveDaemonTaskListSnapshot({ current: initial, refresh: false, latestCandidates: [task("b", { parentThreadId: "a" })] });
  expect(snapshot.candidates.map((item) => item.sessionId)).toEqual(["a", "c"]);
  expect(resolveDaemonTaskTargetedMessage({ snapshot, text: "2：继续" })).toBeNull();
  expect(resolveDaemonTaskTargetedMessage({ snapshot, text: "3：继续" })?.candidate.sessionId).toBe("c");
  expect(resolveDaemonBareNumericReply({ text: "2", taskListScope: "adapter", globalSnapshot: null, adapterSnapshot: snapshot })).toEqual({ type: "clarify", number: "2" });
  expect(resolveDaemonBareNumericReply({ text: "3", taskListScope: "adapter", globalSnapshot: null, adapterSnapshot: snapshot })).toEqual({ type: "resume", target: "3" });
  expect(formatResumeSessionList({ adapter: "codex", candidates: snapshot.candidates, numberBySessionId: snapshot.numberByThreadId })).toContain("3. c");
});

function fixture(candidates: GlobalTaskCandidate[]) {
  const slots = new Map();
  const completions = ["child", "parent"].map((threadId) => ({ adapter: "codex", threadId, title: threadId, completedAt: "2026-10-22T10:00:00Z" }));
  const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
    cwd: "/fixture", slots, activeAdapter: "codex",
    stateStore: { getRecentTaskCompletions: () => completions },
    globalTaskCatalogCache: { load: async (_key: string, load: () => Promise<unknown>) => load() },
    globalTaskCatalogWorker: {
      load: async (adapter: string) => adapter === "codex" ? candidates : [],
      loadNotificationMetadata: async (_cwd: string, id: string) => id === "child" ? { source: "subagent" } : { source: "cli" },
    },
    completionNotificationOriginCache: new BoundedTtlMap({ maxSize: 16, ttlMs: 60_000 }),
    listMobileAdapters: async () => ({ adapters: [] }),
    codexTaskObservations: new Map(), resolveMobileAdapter: () => "codex",
    getCodexTaskCandidates: async () => candidates,
    getSlotThreadId: () => "parent", getSlotActiveTask: () => null,
    resolveMobileTaskStatus: () => "idle",
  });
  return { daemon, slots };
}

test("both unconnected and connected mobile lists hide children, including old completion fallback", async () => {
  const { daemon, slots } = fixture([task("child", { source: "subagent" }), task("parent")]);
  expect((await daemon.listMobileTasks("codex")).map((item: any) => item.threadId)).toEqual(["parent"]);
  slots.set("codex", { adapter: "codex", runtime: {} });
  expect((await daemon.listMobileTasks("codex")).map((item: any) => item.threadId)).toEqual(["parent"]);
});

test("mobile board and recently completed section never resurrect a persisted child", async () => {
  const { daemon } = fixture([task("parent")]);
  const board = await daemon.listMobileTaskBoard();
  expect(board.tasks.map((item: any) => item.threadId)).toEqual(["parent"]);
  expect(board.recentCompleted.map((item: any) => item.threadId)).toEqual(["parent"]);
});

test("child approval delivery keeps an actionable number but never inserts the child into the normal task list", async () => {
  const { daemon } = fixture([task("parent")]);
  daemon.globalTaskListSnapshot = buildGlobalTaskSnapshot([task("parent")]);
  daemon.authorizedUserId = "fixture";
  daemon.stateStore.setLatestWechatTaskTarget = () => {};
  daemon.approvalNotificationDeliveries = new ApprovalNotificationDeliveryQueue();
  const sent: string[] = [];
  daemon.queueWechatMessage = async (_user: string, text: string) => { sent.push(text); return true; };
  daemon.approvalNotificationDeliveries.enqueue({ key: "approval", adapter: "codex", threadId: "child", text: "[Codex · 内部任务]\n需要确认" });
  expect((await daemon.deliverApprovalNotification("approval", "fixture")).status).toBe("delivered");
  expect(sent[0]).toContain("[任务 2 · 内部任务]");
  expect(daemon.globalTaskListSnapshot.candidates.map((item: any) => item.sessionId)).toEqual(["parent"]);
  expect(resolveGlobalTaskCandidate(daemon.globalTaskListSnapshot, "2")).toBeNull();
});

test("child input questions stay actionable without reintroducing the child into the task list", async () => {
  const { daemon } = fixture([task("parent")]);
  daemon.globalTaskListSnapshot = buildGlobalTaskSnapshot([task("parent")]);
  daemon.authorizedUserId = "fixture";
  daemon.stateStore.setLatestWechatTaskTarget = () => {};
  daemon.mobileConversationRevisions = { touch: () => {} };
  const sent: string[] = [];
  const forwards: Promise<unknown>[] = [];
  daemon.queueWechatMessage = async (_user: string, text: string) => { sent.push(text); return true; };
  daemon.trackWechatForwardTask = (work: Promise<unknown>) => { forwards.push(work); };
  const slot = {
    adapter: "codex", controller: { syncLocalClientEndpoint: () => {} },
    runtime: { getState: () => ({ kind: "codex", status: "idle" }) },
    outputBatcher: { flushNow: async () => {} }, pendingUserInputs: [], pendingConfirmations: [],
  };
  daemon.handleSlotEvent(slot, { type: "user_input_required", threadId: "child", request: {
    summary: "需要补充信息", questions: [{
      id: "scope", header: "范围", question: "请确认检查范围？", isOther: false, isSecret: false,
      options: [{ label: "仅本次", description: "只检查当前内容" }],
    }],
  } });
  await Promise.all(forwards);
  expect(sent[0]).toContain("需要补充信息");
  expect(daemon.latestWechatTaskTarget.sessionId).toBe("child");
  expect(daemon.globalTaskListSnapshot.candidates.map((item: any) => item.sessionId)).toEqual(["parent"]);
});

test("the background Codex observer still follows child approvals without caching or completing the child", async () => {
  const { daemon } = fixture([]);
  const followed: string[] = [];
  const slot = { adapter: "codex", runtime: {
    listResumeSessions: async (_limit: number, options: unknown) => {
      expect(options).toEqual({ includeInternal: true });
      return [task("child", { source: "subagent", runtimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] } })];
    },
    followSession: async (id: string) => { followed.push(id); },
  } };
  daemon.recordRecentTaskCompletion = () => { throw new Error("child is not a recent completion"); };
  await daemon.runCodexTaskMonitor(slot);
  expect(followed).toEqual(["child"]);
  expect(daemon.codexTaskObservations.size).toBe(0);
});


test("Codex monitor backs off repeated failures and promptly resumes after recovery", () => {
  expect([0, 1, 2, 3, 4, 5, 100].map(codexTaskMonitorRetryDelayMs))
    .toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
});

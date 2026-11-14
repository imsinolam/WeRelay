import { expect, test } from "bun:test";
import { WeRelayDaemon } from "../../src/daemon/werelay-daemon.ts";
import { CODEX_MOBILE_APP_JS } from "../../src/daemon/codex-mobile-web.ts";
import type { CodexMobileTask } from "../../src/daemon/codex-mobile-server.ts";

test("cached catalog and persisted message activity feed both project and terminal ordering without reading transcripts", async () => {
  const now = Date.now();
  const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();
  const candidates = [
    { adapter: "codex", sessionId: "quiet", projectId: "quiet-project", title: "更新但消息少", lastUpdatedAt: iso(1) },
    { adapter: "codex", sessionId: "busy", projectId: "busy-project", title: "消息更多", lastUpdatedAt: iso(2) },
    { adapter: "pi", sessionId: "old", title: "更早任务", lastUpdatedAt: iso(50) },
    { adapter: "deepseek", sessionId: "recent", title: "最近任务", lastUpdatedAt: iso(0.5) },
  ];
  const activities = [
    { adapter: "codex", threadId: "busy", occurredAt: iso(2), eventKey: "assistant:codex:busy:one" },
    { adapter: "codex", occurredAt: iso(2), eventKey: "assistant:codex:busy:legacy" },
    { adapter: "codex", threadId: "quiet", occurredAt: iso(1), eventKey: "assistant:codex:quiet:one" },
  ];
  const orders: string[][] = [];
  const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
    slots: new Map(),
    globalTaskCatalogCache: { read: () => [] },
    mobileAdapterUsageOrder: ["pi", "deepseek", "codex"],
    stateStore: {
      getAdapterMessageActivities: () => activities,
      setAdapterUsageOrder: (order: { adapters: string[] }) => orders.push(order.adapters),
    },
    listGlobalTaskCandidates: async () => candidates.filter(task => task.adapter === "codex"),
  }) as {
    refreshMobileAdapterUsageOrderIfDue(adapters?: string[], candidates?: unknown[]): void;
    listMobileTasksFromCatalog(adapter: string): Promise<CodexMobileTask[]>;
  };
  daemon.refreshMobileAdapterUsageOrderIfDue(undefined, candidates);
  expect(orders[0].slice(0, 3)).toEqual(["codex", "deepseek", "pi"]);
  daemon.refreshMobileAdapterUsageOrderIfDue(undefined, candidates);
  expect(orders).toHaveLength(1);
  const tasks = await daemon.listMobileTasksFromCatalog("codex");
  expect(tasks.map(task => task.recentMessageCount)).toEqual([1, 2]);
  expect(tasks.every(task => Number.isFinite(Date.parse(task.activityObservedAt!)))).toBe(true);
  const start = CODEX_MOBILE_APP_JS.indexOf("  function projectActivityByKey(");
  const end = CODEX_MOBILE_APP_JS.indexOf("  function renderProjectTasks(", start);
  const activity = new Function("taskGroupKey", "taskRecencyMs", `${CODEX_MOBILE_APP_JS.slice(start, end)}; return projectActivityByKey;`)(
    (task: CodexMobileTask) => task.projectId,
    (task: CodexMobileTask) => Date.parse(task.lastUpdatedAt!),
  )(tasks, Date.now());
  expect(activity["busy-project"].recentMessageCount).toBe(2);
  expect(activity["quiet-project"].recentMessageCount).toBe(1);
});

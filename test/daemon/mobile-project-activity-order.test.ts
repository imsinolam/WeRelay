import { expect, test } from "bun:test";
import { CODEX_MOBILE_APP_JS, CODEX_MOBILE_CSS } from "../../src/daemon/codex-mobile-web.ts";

type Task = { threadId: string; projectId: string; lastUpdatedAt?: string; recentMessageCount?: number; activityObservedAt?: string };
const now = Date.parse("2026-11-12T12:00:00Z");
const hour = 60 * 60_000;
const iso = (hoursAgo: number) => new Date(now - hoursAgo * hour).toISOString();
function harness() {
  const start = CODEX_MOBILE_APP_JS.indexOf("  function projectActivityByKey(");
  const end = CODEX_MOBILE_APP_JS.indexOf("  function renderProjectTasks(", start);
  return new Function("taskGroupKey", "taskRecencyMs", `${CODEX_MOBILE_APP_JS.slice(start, end)}; return {projectActivityByKey, compareProjectActivity};`)(
    (task: Task) => task.projectId,
    (task: Task) => Date.parse(task.lastUpdatedAt || "") || 0,
  ) as {
    projectActivityByKey(tasks: Task[], nowMs: number): Record<string, { recentMessageCount: number; latestAtMs: number; recent: boolean }>;
    compareProjectActivity(left: unknown, right: unknown): number;
  };
}

test("recent projects count messages across tasks, then use recency; old projects ignore desktop pin order", () => {
  const h = harness();
  const tasks: Task[] = [
    { threadId: "old", projectId: "old", lastUpdatedAt: iso(50) },
    { threadId: "newer-old", projectId: "newer-old", lastUpdatedAt: iso(30) },
    { threadId: "newest", projectId: "newest", lastUpdatedAt: iso(0.1), recentMessageCount: 1, activityObservedAt: iso(0) },
    { threadId: "busy1", projectId: "busy", lastUpdatedAt: iso(3), recentMessageCount: 2, activityObservedAt: iso(0) },
    { threadId: "busy2", projectId: "busy", lastUpdatedAt: iso(2), recentMessageCount: 2, activityObservedAt: iso(0) },
    { threadId: "tie", projectId: "tie", lastUpdatedAt: iso(1), recentMessageCount: 4, activityObservedAt: iso(0) },
  ];
  const activity = h.projectActivityByKey(tasks, now);
  const groups = ["old", "busy", "newest", "newer-old", "tie"].map((key, index) => ({ key, firstTaskIndex: index, activity: activity[key] }));
  expect(groups.sort(h.compareProjectActivity).map(group => group.key)).toEqual(["tie", "busy", "newest", "newer-old", "old"]);
});

test("boundary expiry, invalid data and ties stay deterministic without inventing message counts", () => {
  const h = harness();
  const tasks: Task[] = [
    { threadId: "boundary", projectId: "boundary", lastUpdatedAt: iso(24), recentMessageCount: 3, activityObservedAt: iso(0) },
    { threadId: "stale", projectId: "stale", lastUpdatedAt: iso(25), recentMessageCount: 100, activityObservedAt: iso(25) },
    { threadId: "future", projectId: "future", lastUpdatedAt: iso(-3), recentMessageCount: 100, activityObservedAt: iso(-1) },
    { threadId: "bad", projectId: "bad", lastUpdatedAt: "bad", recentMessageCount: -1, activityObservedAt: "bad" },
    { threadId: "no-count", projectId: "no-count", lastUpdatedAt: iso(1) },
    { threadId: "lagging", projectId: "lagging", lastUpdatedAt: iso(30), recentMessageCount: 2, activityObservedAt: iso(0) },
  ];
  const activity = h.projectActivityByKey(tasks, now);
  expect(activity.boundary.recent).toBe(true);
  expect(h.projectActivityByKey(tasks, now + 25 * hour).boundary.recent).toBe(false);
  expect(activity.stale.recentMessageCount).toBe(0);
  expect(activity.future.latestAtMs).toBe(0);
  expect(activity.future.recentMessageCount).toBe(0);
  expect(activity.bad.recent).toBe(false);
  expect(activity["no-count"].recentMessageCount).toBe(0);
  expect(activity.lagging.recent).toBe(true);
  expect(activity.lagging.recentMessageCount).toBe(2);
  expect(h.compareProjectActivity({ key: "a", firstTaskIndex: 0, activity: activity.bad }, { key: "b", firstTaskIndex: 1, activity: activity.bad })).toBeLessThan(0);
});

test("project sorting uses the full cached task set, keeps ungrouped last and refreshes without clearing rows", () => {
  const start = CODEX_MOBILE_APP_JS.indexOf("  function renderProjectTasks(");
  const block = CODEX_MOBILE_APP_JS.slice(start, CODEX_MOBILE_APP_JS.indexOf("  function renderTasks()", start));
  expect(block).toContain("projectActivityByKey(state.tasks, Date.now())");
  expect(block).toContain("groups.sort(compareProjectActivity)");
  const h = harness();
  expect(h.compareProjectActivity({ key: "recent" }, { key: "project" })).toBeGreaterThan(0);
  expect(CODEX_MOBILE_APP_JS).toContain("startSidebarActivityRefresh();");
  expect(CODEX_MOBILE_APP_JS).toContain('"recentMessageCount", "activityObservedAt"');
});

test("DeepSeek keeps its white icon background even when selected in dark mode", () => {
  expect(CODEX_MOBILE_CSS).toContain('.adapter-menu-item[data-adapter-id="deepseek"] .adapter-menu-icon { background: #fff; }');
});

test("automatic refresh is low frequency, idempotent and pauses in hidden or switching views", () => {
  const state = { sidebarActivityTimer: null as unknown, authenticated: true, taskView: "projects", cachePreviewMode: false, switchingAdapter: false, creatingTask: false };
  const document = { hidden: false };
  let callback = () => {};
  let timers = 0;
  let renders = 0;
  let requests = 0;
  const start = CODEX_MOBILE_APP_JS.indexOf("  function startSidebarActivityRefresh()");
  const end = CODEX_MOBILE_APP_JS.indexOf("  function currentTaskModelKey()", start);
  const run = new Function("state", "document", "setInterval", "renderTasks", "loadAdapters", `${CODEX_MOBILE_APP_JS.slice(start, end)}; return startSidebarActivityRefresh;`)(
    state, document, (fn: () => void, ms: number) => { callback = fn; timers++; expect(ms).toBe(5 * 60_000); return 1; },
    () => { renders++; }, () => { requests++; return Promise.resolve(); },
  );
  run(); run(); callback();
  expect([timers, renders, requests]).toEqual([1, 1, 1]);
  document.hidden = true; callback(); document.hidden = false;
  state.switchingAdapter = true; callback(); state.switchingAdapter = false;
  state.authenticated = false; callback(); state.authenticated = true;
  expect([renders, requests]).toEqual([1, 1]);
  callback(); expect([renders, requests]).toEqual([2, 2]);
});

test("project updates reorder existing group nodes without losing collapse state or changing project task order", () => {
  const h = harness();
  const nowIso = new Date().toISOString();
  const tasks = [
    { threadId: "a1", projectId: "a", projectName: "A", projectThreadOrder: 1, lastUpdatedAt: nowIso, recentMessageCount: 2, activityObservedAt: nowIso },
    { threadId: "b1", projectId: "b", projectName: "B", projectThreadOrder: 0, lastUpdatedAt: nowIso, recentMessageCount: 3, activityObservedAt: nowIso },
    { threadId: "a2", projectId: "a", projectName: "A", projectThreadOrder: 0, lastUpdatedAt: nowIso, recentMessageCount: 2, activityObservedAt: nowIso },
  ];
  const state = { tasks, taskGroupNodes: {} as Record<string, unknown>, collapsedProjectGroups: { a: true }, projectVisibleLimits: {} };
  const nodes = new Map<string, object>();
  let displayed: object[] = [];
  let taskOrder: string[] = [];
  const start = CODEX_MOBILE_APP_JS.indexOf("  function renderProjectTasks(");
  const end = CODEX_MOBILE_APP_JS.indexOf("  function renderTasks()", start);
  const render = new Function("state", "taskGroupKey", "projectActivityByKey", "compareProjectActivity", "getTaskGroup", "syncChildOrder", "taskList", `${CODEX_MOBILE_APP_JS.slice(start, end)}; return renderProjectTasks;`)(
    state, (task: Task) => task.projectId, h.projectActivityByKey, h.compareProjectActivity,
    (group: { key: string; tasks: Task[] }) => {
      if (group.key === "a") taskOrder = group.tasks.map(task => task.threadId);
      if (!nodes.has(group.key)) nodes.set(group.key, {});
      return nodes.get(group.key);
    }, (_: unknown, next: object[]) => { displayed = next; }, {},
  );
  render(tasks, false);
  expect(displayed).toEqual([nodes.get("a"), nodes.get("b")]);
  expect(taskOrder).toEqual(["a2", "a1"]);
  tasks[1].recentMessageCount = 10;
  render(tasks, false);
  expect(displayed[0]).toBe(nodes.get("b")!);
  expect(displayed[1]).toBe(nodes.get("a")!);
  expect(state.collapsedProjectGroups.a).toBe(true);
  // Search hides one A task but must not reduce A's project activity score.
  tasks[1].recentMessageCount = 3;
  render([tasks[0], tasks[1]], true);
  expect(displayed[0]).toBe(nodes.get("a")!);
});

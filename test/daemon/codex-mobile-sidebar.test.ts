import { expect, test } from "bun:test";
import { CODEX_MOBILE_JS } from "../../src/daemon/codex-mobile-web.ts";

function harness(mobile = false) {
  const state = {revealCurrentTaskOnSidebarOpen: true, currentThreadId: "target", taskView: "projects", collapsedProjectGroups: {project: false}, taskNodes: {} as Record<string, unknown>};
  const frames: Array<() => void> = [];
  let open = false;
  let known = true;
  let renders = 0;
  let top = 900;
  const button = {isConnected: true, getBoundingClientRect: () => ({top, bottom: top + 40, height: 40})};
  state.taskNodes.target = button;
  const taskList = {scrollTop: 0, clientHeight: 300, getBoundingClientRect: () => ({top: 100, bottom: 400, height: 300})};
  const searchInput = {value: ""};
  const start = CODEX_MOBILE_JS.indexOf("  function revealCurrentTaskInSidebar()");
  const end = CODEX_MOBILE_JS.indexOf("  function createTaskButton(", start);
  const create = new Function("state", "app", "window", "taskById", "searchInput", "taskGroupKey", "renderTasks", "requestAnimationFrame", "taskList", "closeTaskContextMenu", `${CODEX_MOBILE_JS.slice(start, end)}\nreturn {revealCurrentTaskInSidebar, openSidebar, closeSidebar};`);
  const api = create(state, {classList: {contains: () => open, add: () => {open = true;}, remove: () => {open = false;}}}, {matchMedia: () => ({matches: mobile})}, () => known ? {title: "目标任务", projectName: "项目"} : null, searchInput, () => "project", () => {renders++;}, (f: () => void) => frames.push(f), taskList, () => {}) as {revealCurrentTaskInSidebar: () => void; openSidebar: () => void};
  return {state, taskList, searchInput, api, frames, renders: () => renders, setKnown: (v: boolean) => {known = v;}, setTop: (v: number) => {top = v;}, flush: () => {for (const f of frames.splice(0)) f();}};
}

test("entering a task locates its desktop sidebar row without requiring an open drawer", () => {
  const h = harness(); h.api.revealCurrentTaskInSidebar(); h.flush();
  expect(h.taskList.scrollTop).toBeGreaterThan(0);
  expect(h.state.revealCurrentTaskOnSidebarOpen).toBe(false);
});
test("mobile defers until the drawer opens; background renders do not keep pulling the scroll", () => {
  const h = harness(true); h.api.revealCurrentTaskInSidebar(); h.flush();
  expect(h.taskList.scrollTop).toBe(0);
  expect(h.state.revealCurrentTaskOnSidebarOpen).toBe(true);
  h.api.openSidebar(); h.flush();
  expect(h.taskList.scrollTop).toBeGreaterThan(0);
  h.taskList.scrollTop = 25; h.api.revealCurrentTaskInSidebar(); h.flush();
  expect(h.taskList.scrollTop).toBe(25);
});
test("an async task list does not discard the pending reveal", () => {
  const h = harness(); h.setKnown(false); h.api.revealCurrentTaskInSidebar();
  expect(h.state.revealCurrentTaskOnSidebarOpen).toBe(true);
  h.setKnown(true); h.api.revealCurrentTaskInSidebar(); h.flush();
  expect(h.taskList.scrollTop).toBeGreaterThan(0);
});
test("expands a collapsed project and clears a stale search hiding the selected task", () => {
  const h = harness(); h.state.collapsedProjectGroups.project = true;
  h.api.revealCurrentTaskInSidebar();
  expect(h.state.collapsedProjectGroups.project).toBe(false);
  expect(h.renders()).toBe(1);
  h.searchInput.value = "其他项目"; h.api.revealCurrentTaskInSidebar();
  expect(h.searchInput.value).toBe("");
  expect(h.state.revealCurrentTaskOnSidebarOpen).toBe(true);
});
test("visible rows do not scroll and a stale frame cannot scroll a different task", () => {
  const h = harness(); h.setTop(160); h.api.revealCurrentTaskInSidebar(); h.flush();
  expect(h.taskList.scrollTop).toBe(0);
  h.state.revealCurrentTaskOnSidebarOpen = true; h.setTop(900); h.api.revealCurrentTaskInSidebar();
  h.state.currentThreadId = "another"; h.flush();
  expect(h.taskList.scrollTop).toBe(0);
});
test("both repeated entry and task switching request positioning after closing the drawer", () => {
  const start = CODEX_MOBILE_JS.indexOf("  async function selectTask(");
  const source = CODEX_MOBILE_JS.slice(start, CODEX_MOBILE_JS.indexOf("  function showToast(", start));
  expect(source.match(/closeSidebar\(\);\s+state.revealCurrentTaskOnSidebarOpen = true;/g)).toHaveLength(2);
});

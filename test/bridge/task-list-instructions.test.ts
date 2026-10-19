import { expect, test } from "bun:test";
import { formatResumeSessionList } from "../../src/bridge/bridge-utils.ts";
import { formatGlobalTaskList, buildGlobalTaskSnapshot } from "../../src/daemon/global-task-index.ts";
import { formatTaskListInstructions } from "../../src/bridge/task-list-instructions.ts";

// 直接取共享函数而不是复制一份文本：两套列表必须永远使用同一段说明，
// 否则任何一边改了文案都会与另一边悄悄分叉。
const footer = formatTaskListInstructions();

test("terminal and aggregate task lists use the same grouped instructions", () => {
  const candidate = { sessionId: "one", title: "示例", lastUpdatedAt: "2026-09-07T00:00:00Z" };
  for (const adapter of ["codex", "claude", "workbuddy", "deepseek"] as const) {
    expect(formatResumeSessionList({ adapter, candidates: [candidate] }).endsWith("\n\n" + footer)).toBe(true);
  }
  const snapshot = buildGlobalTaskSnapshot([{ ...candidate, adapter: "codex" }]);
  expect(formatGlobalTaskList({ snapshot, startIndex: 0, pageSize: 10 }).endsWith("\n\n" + footer)).toBe(true);
});

test("documents how to ask for a custom list size", () => {
  expect(footer).toContain("[任务20条]");
  expect(footer).toContain("[任务数20]");
  expect(footer).toContain("[列表20]");
  expect(footer).toContain("5 的倍数");
});

import { expect, test } from "bun:test";
import { formatResumeSessionList } from "../../src/bridge/bridge-utils.ts";
import { formatGlobalTaskList, buildGlobalTaskSnapshot } from "../../src/daemon/global-task-index.ts";

const footer = `[3] 进入任务 3
[3：内容] 给任务3发消息

[任务：关键词] 搜索任务
[下一页] 再看 10 条，可带数量如[下一页20]

任务序号在下次发送 [任务] 前保持不变。
中英文冒号均可，指令间可加空格。`;

test("terminal and aggregate task lists use the same grouped instructions", () => {
  const candidate = { sessionId: "one", title: "示例", lastUpdatedAt: "2026-09-07T00:00:00Z" };
  for (const adapter of ["codex", "claude", "workbuddy", "deepseek"] as const) {
    expect(formatResumeSessionList({ adapter, candidates: [candidate] }).endsWith("\n\n" + footer)).toBe(true);
  }
  const snapshot = buildGlobalTaskSnapshot([{ ...candidate, adapter: "codex" }]);
  expect(formatGlobalTaskList({ snapshot, startIndex: 0, pageSize: 10 }).endsWith("\n\n" + footer)).toBe(true);
});

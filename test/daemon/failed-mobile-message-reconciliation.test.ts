import { expect, test } from "bun:test";
import { findFailedMessageExecution, taskCanCoverFailedMessage } from "../../src/daemon/failed-mobile-message-reconciliation.ts";
import type { MobileMessageOutboxEntry } from "../../src/daemon/mobile-message-outbox.ts";
import type { BridgeSessionMessage } from "../../src/bridge/bridge-types.ts";

const text = "请修复网页任务台中的消息重复显示问题";
const entry: MobileMessageOutboxEntry = {
  clientId: "failed-1", adapter: "codex", threadId: "source", text, images: [],
  createdAtMs: 10_000, sequence: 1, status: "failed", attempts: 3, nextAttemptAtMs: 0,
};
function executed(value = text): BridgeSessionMessage[] {
  return [{id: "user", role: "user", text: value, createdAtMs: 11_000, turnId: "turn"},
    {role: "assistant", text: "正在检查消息合并", turnId: "turn", phase: "commentary"}];
}

test("matches failed requests fully covered by an executed request, including standalone subsets", () => {
  expect(findFailedMessageExecution(entry, "source", executed())?.id).toBe("user");
  expect(findFailedMessageExecution(entry, "other", executed("先检查缓存\n" + text + "\n然后运行测试"))?.id).toBe("user");
  expect(findFailedMessageExecution({...entry, text: text + "\n还要修复审批推送"}, "source", executed())).toBeUndefined();
});

test("does not confuse negation, short commands, previous runs or incomplete evidence with execution", () => {
  expect(findFailedMessageExecution(entry, "other", executed("不要" + text))).toBeUndefined();
  expect(findFailedMessageExecution({...entry, text: "继续"}, "other", executed("继续"))).toBeUndefined();
  expect(findFailedMessageExecution(entry, "source", executed().slice(0, 1))).toBeUndefined();
  expect(findFailedMessageExecution(entry, "source", [{...executed()[0]!, createdAtMs: 1}, executed()[1]!])).toBeUndefined();
  expect(findFailedMessageExecution(entry, "source", [{...executed()[0]!, createdAtMs: undefined}, executed()[1]!])).toBeUndefined();
  expect(findFailedMessageExecution({...entry, images: [{path: "/tmp/attachment.png", fileName: "attachment.png", mimeType: "image/png"}]}, "source", executed())).toBeUndefined();
});

test("requires the actual project identity for cross-task reconciliation", () => {
  const tasks = [{threadId: "source", projectId: "project-a"}, {threadId: "other", projectId: "project-a"}];
  expect(taskCanCoverFailedMessage(entry, tasks[1]!, tasks)).toBe(true);
  expect(taskCanCoverFailedMessage(entry, {threadId: "other", projectId: "project-b"}, tasks)).toBe(false);
  expect(taskCanCoverFailedMessage(entry, {threadId: "other"}, [])).toBe(false);
  expect(taskCanCoverFailedMessage(entry, {threadId: "source"}, [])).toBe(true);
});

test("does not count an assistant from a different turn or a later user's reply as execution", () => {
  expect(findFailedMessageExecution(entry, "source", [executed()[0]!, {...executed()[1]!, turnId: "old"}])).toBeUndefined();
  expect(findFailedMessageExecution(entry, "source", [executed()[0]!, {role: "user", text: "另外的需求"}, executed()[1]!])).toBeUndefined();
});

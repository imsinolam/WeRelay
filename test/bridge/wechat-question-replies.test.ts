import { expect, test } from "bun:test";
import { formatUserInputRequestMessage, parsePendingUserInputAnswerCommand, resolveWechatQuestionReply } from "../../src/bridge/bridge-utils.ts";
import type { PendingUserInputRequest } from "../../src/bridge/bridge-types.ts";

const pending: PendingUserInputRequest = {
  threadId: "question-task", createdAt: "2026-09-15T00:00:00Z", summary: "选择方向",
  questions: [{ id: "direction", header: "实现方向", question: "你想使用哪个方向？", isOther: true, isSecret: false,
    options: ["A. 同步页面", "B. 自动扫描", "C. 修复链路", "D. 暂不执行"].map((label) => ({label, description: "方案说明"})) }],
};

test("question formatting exposes numeric other option and direct-reply instructions without duplicate A/B numbers", () => {
  const output = formatUserInputRequestMessage(pending, {kind: "deepseek", status: "awaiting_input", cwd: "/example", command: "dsh"});
  expect(output).toContain("1. 同步页面");
  expect(output).toContain("5. 其他答案");
  expect(output).toContain("5：内容");
  expect(output).toContain("直接回复数字");
  expect(output).not.toContain("1. A.");
});

test("numbers select original labels while Chinese/English colon other answers strip only the routing prefix", () => {
  expect(parsePendingUserInputAnswerCommand("1", pending)).toMatchObject({answers: {direction: ["A. 同步页面"]}});
  for (const text of ["5：其他电脑是否也能更新？", " 5 : 其他电脑是否也能更新？ ", "5 ： 其他电脑是否也能更新？"]) {
    expect(parsePendingUserInputAnswerCommand(text, pending)).toMatchObject({answers: {direction: ["user_note: 其他电脑是否也能更新？"]}});
  }
  expect(parsePendingUserInputAnswerCommand("其他电脑是否也能更新？", pending)).toMatchObject({answers: {direction: ["user_note: 其他电脑是否也能更新？"]}});
  for (const text of ["5", "5：", "99", "99:内容"]) expect(parsePendingUserInputAnswerCommand(text, pending)).toHaveProperty("error");
});

test("pending question owns ordinary text and numeric-colon replies, never explicit task or control commands", () => {
  const base = {pending, adapter: "deepseek" as const, awaitingTaskSelection: false, hasPendingApproval: false, hasAttachments: false};
  for (const text of ["1", "5:另一个方向", "先解释一下", "/answer 2"]) {
    expect(resolveWechatQuestionReply({...base, text})).toEqual({type: "answer", raw: text === "/answer 2" ? "2" : text});
  }
  for (const text of ["任务5：继续", "任务 5 : 继续", "任务", "/tasks", "/dsh", "/stop", "下一页", "帮助", "/model"]) {
    expect(resolveWechatQuestionReply({...base, text})).toBeNull();
  }
  expect(resolveWechatQuestionReply({...base, text: "1", awaitingTaskSelection: true})).toBeNull();
  expect(resolveWechatQuestionReply({...base, text: "5：继续", awaitingTaskSelection: true})).toBeNull();
  expect(resolveWechatQuestionReply({...base, text: "1", hasPendingApproval: true})).toBeNull();
  expect(resolveWechatQuestionReply({...base, text: "1", pending: null})).toBeNull();
  expect(resolveWechatQuestionReply({...base, text: "说明", hasAttachments: true})).toBeNull();
});

test("fixed-choice, multiselect and multiple-question formats retain their validation", () => {
  const fixed = {...pending, questions: pending.questions.map((q) => ({...q, isOther: false}))};
  expect(parsePendingUserInputAnswerCommand("5:其他", fixed)).toHaveProperty("error");
  const multi = {...pending, questions: pending.questions.map((q) => ({...q, multiSelect: true}))};
  expect(parsePendingUserInputAnswerCommand("1,3", multi)).toMatchObject({answers: {direction: ["A. 同步页面", "C. 修复链路"]}});
  const two = {...pending, questions: [...pending.questions, {...pending.questions[0]!, id: "second"}]};
  expect(parsePendingUserInputAnswerCommand("1=2;2=5：其他", two)).toMatchObject({answers: {direction: ["B. 自动扫描"], second: ["user_note: 其他"]}});
});

test("unrelated selected-session events do not clear a background task's pending question", async () => {
  const { reconcilePendingUserInputs } = await import("../../src/bridge/pending-user-input.ts");
  const state = {kind: "deepseek" as const, status: "busy" as const, command: "dsh", sharedSessionId: "another-task", pendingUserInput: null};
  expect(reconcilePendingUserInputs([pending], state)).toEqual([pending]);
  expect(reconcilePendingUserInputs([pending], state, (id) => id === pending.threadId ? pending : null)).toEqual([pending]);
  expect(reconcilePendingUserInputs([pending], state, () => null)).toEqual([]);
  expect(reconcilePendingUserInputs([pending], {...state, sharedSessionId: pending.threadId})).toEqual([]);
});

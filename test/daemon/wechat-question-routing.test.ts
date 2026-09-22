import fs from "node:fs";
import { expect, test } from "bun:test";
import { WeRelayDaemon } from "../../src/daemon/werelay-daemon.ts";
import type { PendingUserInputRequest } from "../../src/bridge/bridge-types.ts";
import { parsePendingUserInputAnswerCommand } from "../../src/bridge/bridge-utils.ts";

const question: PendingUserInputRequest = {
  createdAt: "2026-09-15T00:00:00Z", threadId: "background", summary: "选择",
  questions: [{id: "q", header: "选择", question: "选择方向", isOther: true, isSecret: false,
    options: ["甲", "乙", "丙", "丁"].map((label) => ({label, description: ""}))}],
};

// No constructor, accounts, network, daemon log or desktop application are touched.
function harness() {
  const answers: Array<{adapter: string; threadId: string; values: Record<string, string[]>}> = [];
  let pending: PendingUserInputRequest | null = structuredClone(question);
  let accepted = true;
  const dsh = {
    adapter: "deepseek", pendingUserInputs: [] as PendingUserInputRequest[], pendingConfirmations: [],
    awaitingBareTaskSelection: false,
    runtime: {
      getState: () => ({kind: "deepseek", status: "busy", sharedSessionId: "selected-elsewhere", pendingUserInput: null}),
      getPendingTaskUserInput: (id: string) => id === "background" ? pending : null,
      submitTaskUserInput: async (id: string, values: Record<string, string[]>) => {
        if (id !== "background" || !pending || !accepted) return false;
        answers.push({adapter: "deepseek", threadId: id, values}); pending = null; return true;
      },
    },
  };
  const codex = {adapter: "codex", pendingUserInputs: [], pendingConfirmations: [], awaitingBareTaskSelection: false,
    runtime: {getState: () => ({kind: "codex", status: "busy", sharedThreadId: "background"})}};
  // Private-method harness intentionally exercises production resolution without starting a runtime.
  const daemon = Object.create(WeRelayDaemon.prototype) as any;
  daemon.slots = new Map([["deepseek", dsh], ["codex", codex]]);
  daemon.answerPendingUserInput = async (_message: unknown, slot: typeof dsh, raw: string, exact: PendingUserInputRequest) => {
    const parsed = parsePendingUserInputAnswerCommand(raw, exact);
    if ("error" in parsed) return;
    const submitted = await slot.runtime.submitTaskUserInput(exact.threadId!, parsed.answers);
    if (submitted) slot.pendingUserInputs = slot.pendingUserInputs.filter((item) => item !== exact);
  };
  return {daemon, dsh, codex, answers, fail: () => {accepted = false;}};
}

for (const text of ["1", "5 ： 请先解释一下", "请先解释一下"]) {
  test(`latest background DSH question owns reply ${text} even with Codex active and a colliding task id`, async () => {
    const {daemon, dsh, codex, answers} = harness();
    const handled = await daemon.tryAnswerWechatQuestion({senderId: "synthetic", text, attachments: []}, codex,
      {adapter: "deepseek", sessionId: "background", title: "问答", lastUpdatedAt: "2026-09-15T00:00:00Z"});
    expect(handled).toBe(true);
    expect(answers).toEqual([{adapter: "deepseek", threadId: "background", values: {q: [text === "1" ? "甲" : "user_note: 请先解释一下"]}}]);
    expect(dsh.runtime.getState().sharedSessionId).toBe("selected-elsewhere");
    expect(dsh.pendingUserInputs).toEqual([]);
  });
}

test("failed delivery retains the recovered exact question; explicit task routes and list selection are not consumed", async () => {
  const {daemon, dsh, codex, answers, fail} = harness();
  const target = {adapter: "deepseek", sessionId: "background"};
  fail();
  expect(await daemon.tryAnswerWechatQuestion({senderId: "synthetic", text: "1", attachments: []}, codex, target)).toBe(true);
  expect(dsh.pendingUserInputs).toHaveLength(1);
  expect(answers).toEqual([]);
  for (const text of ["任务5：继续", "/tasks", "/stop"]) {
    expect(await daemon.tryAnswerWechatQuestion({text, attachments: []}, codex, target)).toBe(false);
  }
  codex.awaitingBareTaskSelection = true;
  expect(await daemon.tryAnswerWechatQuestion({text: "5:内容", attachments: []}, codex, target)).toBe(false);
  expect(await daemon.tryAnswerWechatQuestion({text: "1", attachments: []}, codex, {adapter: "codex", sessionId: "background"})).toBe(false);
});

test("question interception runs before bare-number approval and task routing", () => {
  const source = fs.readFileSync("src/daemon/werelay-daemon.ts", "utf8");
  const entry = source.indexOf("if (await this.tryAnswerWechatQuestion(message, slot, receivedTaskTarget))");
  expect(entry).toBeGreaterThan(0);
  expect(entry).toBeLessThan(source.indexOf("const pendingApprovalTargets = this.listPendingApprovalTargets();", entry));
  expect(entry).toBeLessThan(source.indexOf("const globalTargetedTaskMessage =", entry));
  expect(source.includes("reconcilePendingUserInputs(")).toBe(true);
});

// Integration guard: keep the deployed task-scoping rules while recovering DSH questions.
test("question recovery retains strict Codex scope and never invents a target", () => {
  const {daemon, codex} = harness();
  (codex as any).pendingUserInputs = [{ ...question, threadId: undefined }];
  expect(daemon.resolveTaskPendingUserInput(codex, "background")).toBeNull();
  expect(daemon.resolveTaskPendingUserInput(codex, "another-task")).toBeNull();
  expect(daemon.resolveTaskPendingUserInput(codex, undefined)).toBeNull();
});

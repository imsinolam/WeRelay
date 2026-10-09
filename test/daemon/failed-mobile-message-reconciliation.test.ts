import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FailedMobileMessageSweep, findFailedMessageExecution, taskCanCoverFailedMessage } from "../../src/daemon/failed-mobile-message-reconciliation.ts";
import { MobileMessageOutbox, type MobileMessageOutboxEntry } from "../../src/daemon/mobile-message-outbox.ts";
import type { BridgeSessionMessage } from "../../src/bridge/bridge-types.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });
function createOutbox(now: () => number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-late-receipt-test-"));
  dirs.push(dir);
  return new MobileMessageOutbox({stateFile: path.join(dir, "outbox.json"), now});
}

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

test("未确认消息沿用同项目执行证据限制，不将旧记录或不完整证据视为送达", () => {
  const unconfirmed = {...entry, status: "unconfirmed" as const};
  expect(findFailedMessageExecution(unconfirmed, "other", executed())?.id).toBe("user");
  expect(findFailedMessageExecution(unconfirmed, "other", executed().slice(0, 1))).toBeUndefined();
  expect(findFailedMessageExecution(unconfirmed, "other", [{...executed()[0]!, createdAtMs: 1}, executed()[1]!])).toBeUndefined();
});

test("未确认扫描通知后仍包含原任务及同项目候选，分钟限频且不读取无关项目", async () => {
  let now = 1_000_000;
  const outbox = createOutbox(() => now);
  const syntheticText = "合成回归请求用于验证后台迟到回执";
  outbox.accept({clientId: "test-client", adapter: "codex", threadId: "test-source", text: syntheticText, images: [], createdAtMs: now});
  outbox.markUnconfirmed("codex", "test-source", "test-client", "接收超时");
  outbox.markFailureNotified("codex", "test-source", "test-client", now);
  const sweep = new FailedMobileMessageSweep();
  const reads: string[] = [];
  let available = false;
  const params = {
    adapter: "codex", outbox,
    listTasks: async () => [{threadId: "test-source", projectId: "test-project"}, {threadId: "test-actual", projectId: "test-project"}, {threadId: "test-unrelated", projectId: "another-project"}],
    readMessages: async (threadId: string): Promise<BridgeSessionMessage[]> => {
      reads.push(threadId);
      return available && threadId === "test-actual" ? [
        {id: "test-user", role: "user", text: syntheticText, turnId: "test-turn", createdAtMs: 1_000_001},
        {role: "assistant", text: "合成回复", turnId: "test-turn"},
      ] : [];
    },
  };
  await Promise.all([sweep.run({...params, nowMs: now}), sweep.run({...params, nowMs: now})]);
  expect(reads.sort()).toEqual(["test-actual", "test-source"]);
  expect(outbox.pendingFailureNotifications()).toEqual([]);
  now += 59_999;
  available = true;
  await sweep.run({...params, nowMs: now});
  expect(reads).toHaveLength(2);
  now += 1;
  await sweep.run({...params, nowMs: now});
  expect(reads).toHaveLength(4);
  expect(outbox.get("codex", "test-source", "test-client")?.status).toBe("delivered");
  expect(outbox.readyEntries(Number.MAX_SAFE_INTEGER)).toEqual([]);
});

test("未确认恢复每分钟最多八页、两路并发，旧消息停止扫描但内容保留", async () => {
  const now = 10 * 24 * 60 * 60_000;
  const outbox = createOutbox(() => now);
  for (let i = 0; i < 10; i++) {
    outbox.accept({clientId: `test-client-${i}`, adapter: "codex", threadId: `test-task-${i}`, text: "合成消息", images: [], createdAtMs: now});
    outbox.markUnconfirmed("codex", `test-task-${i}`, `test-client-${i}`, "接收超时");
    outbox.markFailureNotified("codex", `test-task-${i}`, `test-client-${i}`, now);
  }
  outbox.accept({clientId: "test-old", adapter: "codex", threadId: "test-old-task", text: "合成旧消息", images: [], createdAtMs: now - 7 * 24 * 60 * 60_000 - 1});
  outbox.markUnconfirmed("codex", "test-old-task", "test-old", "接收超时");
  const sweep = new FailedMobileMessageSweep();
  const reads: string[] = [];
  let active = 0;
  let maximum = 0;
  const params = {
    adapter: "codex", outbox,
    listTasks: async () => { throw new Error("合成目录离线"); },
    readMessages: async (threadId: string) => {
      reads.push(threadId);
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return [];
    },
  };
  await sweep.run({...params, nowMs: now});
  expect(reads).toHaveLength(8);
  expect(maximum).toBe(2);
  await sweep.run({...params, nowMs: now + 60_000});
  expect(reads).toHaveLength(16);
  expect(new Set(reads).size).toBe(10);
  expect(reads).not.toContain("test-old-task");
  await sweep.run({...params, nowMs: now + 7 * 24 * 60 * 60_000 + 1});
  expect(reads).toHaveLength(16);
  expect(outbox.list("codex", "test-old-task")[0]?.text).toBe("合成旧消息");
  expect(outbox.readyEntries(Number.MAX_SAFE_INTEGER)).toEqual([]);
});

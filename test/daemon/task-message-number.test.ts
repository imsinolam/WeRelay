import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WeRelayDaemon, formatCodexTaskCompletionMessages, formatCurrentCodexFullReplyMessages, prefixDaemonTaskMessage } from "../../src/daemon/werelay-daemon.ts";
import { buildGlobalTaskSnapshot, globalTaskIdentityKey } from "../../src/daemon/global-task-index.ts";
import { CodexCompletionDeliveryQueue } from "../../src/daemon/codex-completion-delivery.ts";
import { ApprovalNotificationDeliveryQueue } from "../../src/daemon/approval-notification-delivery.ts";
import { ScreenNotificationPolicy } from "../../src/daemon/screen-notification-policy.ts";
import { MobileMessageOutbox } from "../../src/daemon/mobile-message-outbox.ts";

function fixture() {
  const sent: string[] = [];
  const completions = new CodexCompletionDeliveryQueue();
  const approvals = new ApprovalNotificationDeliveryQueue();
  const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
    slots: new Map(), authorizedUserId: "test", codexCompletionDeliveries: completions, approvalNotificationDeliveries: approvals,
    globalTaskListSnapshot: buildGlobalTaskSnapshot([
      { adapter: "codex", sessionId: "same", title: "Codex task", lastUpdatedAt: "2026-10-14T02:00:00Z" },
      { adapter: "pi", sessionId: "same", title: "Pi task", lastUpdatedAt: "2026-10-14T01:00:00Z" },
    ]),
    stateStore: { setLatestWechatTaskTarget() {} }, clearCodexFinalReplyCache() {},
    queueWechatMessage: async (_id: string, text: string) => { sent.push(text); return true; },
    isApprovalNotificationStillPending: async () => true,
    shouldPushCompletionForTask: async () => true,
  });
  return { daemon, sent, completions, approvals };
}

test("every agent task notification displays the supplied global number", () => {
  for (const adapter of ["pi", "deepseek", "workbuddy", "claude", "tclaude", "grok", "codebuddy", "reasonix", "opencode"] as const) {
    expect(prefixDaemonTaskMessage(adapter, "需要确认", 63, "s", "原任务")).toStartWith("[任务 63 · ");
  }
});

test("every long Codex completion and full-reply chunk retains task number within the size limit", () => {
  for (const mode of ["full", "preview"] as const) {
    const messages = formatCodexTaskCompletionMessages({ title: "原任务", taskNumber: 10, outcome: "completed", durationMs: 1000, text: "结果".repeat(3000), mode });
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) { expect(message).toStartWith("[任务 10 · 原任务]"); expect(message.length).toBeLessThanOrEqual(1200); }
  }
  for (const message of formatCurrentCodexFullReplyMessages({ title: "原任务", taskNumber: 10, text: "结果".repeat(2000) })) {
    expect(message).toStartWith("[任务 10 · 原任务]"); expect(message.length).toBeLessThanOrEqual(1200);
  }
});

test("persisted legacy reply chunks acquire current adapter-specific number on send without replaying sent chunks", async () => {
  const { daemon, completions, sent } = fixture();
  completions.enqueue({ key: "pi", adapter: "pi", threadId: "same", title: "Pi task", texts: ["[Pi Agent · Pi task]\nfirst", "remaining"] });
  await completions.deliver("pi", async (_d, _texts, checkpoint) => { checkpoint(); return 1; });
  const restored = new CodexCompletionDeliveryQueue({ initial: completions.snapshot() });
  daemon.codexCompletionDeliveries = restored;
  await daemon.deliverCodexCompletionNotification("pi", "test");
  expect(sent).toEqual(["[任务 2 · Pi · Pi task]\nremaining"]);
  expect(restored.getPending()).toEqual([]);
  expect(daemon.globalTaskListSnapshot.numberByIdentity.get(globalTaskIdentityKey("codex", "same"))).toBe(1);
});

test("old numbered payload is relabeled after task refresh without duplicate headings", async () => {
  const { daemon, completions, sent } = fixture();
  completions.enqueue({ key: "codex", threadId: "same", title: "Codex task", texts: ["[任务 99 · Codex task] 已完成，用时1s\nanswer"] });
  await daemon.deliverCodexCompletionNotification("codex", "test");
  expect(sent).toEqual(["[任务 1 · Codex task] 已完成，用时1s\nanswer"]);
});

test("digest includes actionable global numbers for every completion and approval", async () => {
  const { daemon, completions, approvals, sent } = fixture();
  daemon.notificationPolicy = new ScreenNotificationPolicy({ read: async () => "unlocked" });
  completions.enqueue({ key: "pi", adapter: "pi", threadId: "same", title: "Pi task", texts: ["[Pi Agent · Pi task]\n已完成"], url: "https://example.test/pi" });
  approvals.enqueue({ key: "approval", adapter: "workbuddy", threadId: "approval", text: "[WorkBuddy · Original] 需要确认\nhttps://example.test/wb" });
  await daemon.runOutboundRecoveryPass();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("[任务 2 · Pi · Pi task]");
  expect(sent[0]).toContain("[任务 3 · WorkBuddy · Original]");
  expect(daemon.globalTaskListSnapshot.numberByIdentity.get(globalTaskIdentityKey("workbuddy", "approval"))).toBe(3);
});

test("legacy approval delivery uses current number and leaves answer brackets intact", async () => {
  const { daemon, approvals, sent } = fixture();
  approvals.enqueue({ key: "approval", adapter: "pi", threadId: "same", text: "[Pi Agent · Pi task]\n需要确认\nhttps://example.test/pi" });
  await daemon.deliverApprovalNotification("approval", "test");
  expect(sent[0]).toStartWith("[任务 2 · Pi · Pi task]\n需要确认");
  expect(daemon.formatNumberedDeliveryText({ adapter: "pi", threadId: "same", title: "Pi task" }, "[注意事项]\n不能删除"))
    .toBe("[任务 2 · Pi · Pi task]\n[注意事项]\n不能删除");
});

test("confirmed older backlog preserves real task numbers in both prompt and delivery", async () => {
  const { daemon, completions, sent } = fixture();
  for (let i = 0; i < 3; i++) completions.enqueue({ key: String(i), threadId: `task-${i}`, title: `Task ${i}`, texts: ["done"], url: `https://example.test/${i}`, completedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
  await daemon.remindClawbotBacklogAfterTaskList("test");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("回复“推送”");
  expect(completions.getPending()).toHaveLength(3);
  for (let i = 0; i < 3; i++) {
    const number = daemon.globalTaskListSnapshot.numberByIdentity.get(globalTaskIdentityKey("codex", `task-${i}`));
    expect(sent[0]).toContain(`[任务 ${number} · Task ${i}]`);
  }
  expect(sent[0]).not.toContain("1. [任务");
  await daemon.handleClawbotBacklogPushRequest({ senderId: "test", text: "推送" });
  expect(sent).toHaveLength(4);
  for (let i = 0; i < 3; i++) {
    const number = daemon.globalTaskListSnapshot.numberByIdentity.get(globalTaskIdentityKey("codex", `task-${i}`));
    expect(sent.slice(1).some((text: string) => text.startsWith(`[任务 ${number} · Task ${i}]`))).toBe(true);
  }
  expect(completions.getPending()).toHaveLength(0);
});

test("mobile failure notification registers the original task and adds its reply number", async () => {
  const { daemon, sent } = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wr-number-outbox-"));
  const outbox = new MobileMessageOutbox({ stateFile: path.join(directory, "outbox.json") });
  outbox.accept({ adapter: "pi", threadId: "same", clientId: "client", text: "continue", images: [] });
  outbox.markFailed("pi", "same", "client", "invalid input");
  Object.assign(daemon, { mobileMessageOutbox: outbox, resolveMobileAdapter: () => "pi",
    reconcileFailedMobileMessages: async () => {}, listMobileTasks: async () => [{ threadId: "same", title: "Pi task" }] });
  try {
    await daemon.deliverMobileMessageFailureNotifications();
    expect(sent[0]).toStartWith("[任务 2 · Pi · Pi task] 网页消息未能提交");
    expect(sent[0]).toContain("内容：continue");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("missing thread ID on a session-only adapter failure uses its captured original task", async () => {
  const { daemon, sent } = fixture();
  const tasks: Promise<void>[] = [];
  Object.assign(daemon, { mobileConversationRevisions: { touch() {} }, getSlotThreadId: () => "same",
    clearSlotTaskState() {}, trackWechatForwardTask: (task: Promise<void>) => tasks.push(task) });
  const slot = { adapter: "pi", controller: { syncLocalClientEndpoint() {} }, runtime: { getState: () => ({}) },
    pendingConfirmations: [], pendingUserInputs: [], outputBatcher: { flushNow: async () => {} } };
  daemon.handleSlotEvent(slot, { type: "task_failed", message: "test failure", timestamp: new Date().toISOString() });
  await Promise.all(tasks);
  expect(sent[0]).toStartWith("[任务 2 · Pi · Pi task]\n");
});

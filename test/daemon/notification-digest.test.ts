import { expect, test } from "bun:test";
import { WeRelayDaemon } from "../../src/daemon/werelay-daemon.ts";
import { CodexCompletionDeliveryQueue } from "../../src/daemon/codex-completion-delivery.ts";
import { ApprovalNotificationDeliveryQueue } from "../../src/daemon/approval-notification-delivery.ts";
import { ScreenNotificationPolicy } from "../../src/daemon/screen-notification-policy.ts";

test("unlocked combines cross-agent completions and live approvals; failure and restart preserve payloads", async () => {
  let now = Date.now();
  let locked = false;
  let successful = false;
  let persisted: number | undefined;
  const texts: string[] = [];
  const approvals = new ApprovalNotificationDeliveryQueue();
  const completions = new CodexCompletionDeliveryQueue();
  const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
    authorizedUserId: "test", codexCompletionDeliveries: completions, approvalNotificationDeliveries: approvals,
    notificationPolicy: new ScreenNotificationPolicy({ now: () => now, read: async () => locked ? "locked" : "unlocked", persist: (at) => { persisted = at; } }),
    queueWechatMessage: async (_id: string, text: string) => { texts.push(text); return successful; },
    isApprovalNotificationStillPending: async () => true,
    clearCodexFinalReplyCache() {}, rememberWechatCandidate() {}, slots: new Map(),
  });
  completions.enqueue({ key: "a", adapter: "workbuddy", threadId: "same", title: "任务A", texts: ["完成A"], url: "https://example.test/a" });
  completions.enqueue({ key: "b", adapter: "pi", threadId: "same", title: "任务B", texts: ["完成B"], url: "https://example.test/b" });
  approvals.enqueue({ key: "c", adapter: "workbuddy", threadId: "approval", text: "[任务 3 · WorkBuddy] 需要确认\nhttps://example.test/c" });
  await daemon.runOutboundRecoveryPass();
  expect(texts).toHaveLength(1);
  expect(texts[0]).toContain("任务A"); expect(texts[0]).toContain("需要确认");
  expect(completions.getPending()).toHaveLength(2); expect(approvals.getPending()).toHaveLength(1);
  successful = true;
  await daemon.runOutboundRecoveryPass();
  expect(completions.getPending()).toHaveLength(0); expect(approvals.getPending()).toHaveLength(0);
  completions.enqueue({ key: "d", adapter: "workbuddy", threadId: "next", texts: ["下一条"] });
  daemon.notificationPolicy = new ScreenNotificationPolicy({ now: () => now, read: async () => "unlocked", lastSentAtMs: persisted });
  await daemon.runOutboundRecoveryPass(); expect(texts).toHaveLength(2);
  now += 600_000;
  await daemon.runOutboundRecoveryPass(); expect(texts).toHaveLength(3);
  completions.enqueue({ key: "e", adapter: "workbuddy", threadId: "locked", texts: ["锁屏完成"] });
  locked = true;
  daemon.notificationPolicy = new ScreenNotificationPolicy({ read: async () => "locked" });
  await daemon.runOutboundRecoveryPass(); expect(texts.at(-1)).toBe("锁屏完成");
});

test("locked delivers backlog separately; pending media remains durable when a digest cannot link to it", async () => {
  const queue = new CodexCompletionDeliveryQueue();
  const sent: string[] = [];
  const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
    authorizedUserId: "test", notificationPolicy: new ScreenNotificationPolicy({ read: async () => "locked" }),
    codexCompletionDeliveries: queue, approvalNotificationDeliveries: new ApprovalNotificationDeliveryQueue(),
    queueWechatMessage: async (_id: string, text: string) => { sent.push(text); return true; },
    clearCodexFinalReplyCache() {}, rememberWechatCandidate() {}, slots: new Map(),
    persistCodexWechatThreadId() {},
  });
  for (let i = 0; i < 3; i++) queue.enqueue({ key: String(i), threadId: String(i), texts: [`已完成${i}`] });
  await daemon.runOutboundRecoveryPass();
  expect(sent).toEqual(["已完成0", "已完成1", "已完成2"]);
  expect(queue.getPending()).toHaveLength(0);
  daemon.notificationPolicy = new ScreenNotificationPolicy({ read: async () => "unlocked" });
  queue.enqueue({ key: "media", adapter: "workbuddy", threadId: "media", texts: ["附件"], images: ["/fake/image.png"] });
  await daemon.runOutboundRecoveryPass();
  expect(sent).toHaveLength(3);
  expect(queue.getPending()).toHaveLength(1);
  // With a task link, the digest intentionally replaces inline media with a web reference.
  queue.enqueue({ key: "linked", adapter: "pi", threadId: "linked", texts: ["图像"], url: "https://example.test/media", images: ["/fake/image.png"] });
  await daemon.runOutboundRecoveryPass();
  expect(sent.at(-1)).toContain("https://example.test/media");
  expect(queue.getPending().map((item) => item.key)).toEqual(["media"]);
});

test("summary reservations prevent a concurrent full delivery", async () => {
  const queue = new CodexCompletionDeliveryQueue();
  queue.enqueue({ key: "x", threadId: "x", texts: ["回复"] });
  expect(queue.reserveSummary(["x"])).toBe(true);
  let sends = 0;
  expect((await queue.deliver("x", async () => { sends++; return 1; })).status).toBe("in_flight");
  expect(sends).toBe(0);
  queue.releaseSummary(["x"]);
  expect((await queue.deliver("x", async () => { sends++; return 1; })).status).toBe("delivered");
});

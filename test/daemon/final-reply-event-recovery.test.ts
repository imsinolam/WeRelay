import { expect, test } from "bun:test";
import { WeRelayDaemon } from "../../src/daemon/werelay-daemon.ts";
import { CodexCompletionDeliveryQueue } from "../../src/daemon/codex-completion-delivery.ts";

// Exercise the actual event handler without starting servers, adapters or WeChat.
test("daemon persists a DeepSeek final event even when outbound send is rejected", async () => {
  const queue = new CodexCompletionDeliveryQueue();
  const tasks: Promise<void>[] = [];
  const targets: unknown[] = [];
  const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
    authorizedUserId: "test-recipient", codexCompletionDeliveries: queue,
    shouldPushCompletionForTask: async () => true,
    slots: new Map(),
    mobileConversationRevisions: { touch() {} }, recordAdapterMessageActivity() {},
    getSlotThreadId: () => "session", prefixSlotMessage: (_slot: unknown, text: string) => text,
    collectFinalReplyImages: async () => [], queueWechatMessage: async () => false,
    trackWechatForwardTask: (task: Promise<void>) => tasks.push(task),
    stateStore: { setLatestWechatTaskTarget: (target: unknown) => { targets.push(target); } },
  });
  const slot = {
    adapter: "deepseek", controller: { syncLocalClientEndpoint() {} },
    runtime: { getState: () => ({}) }, pendingConfirmations: [], pendingUserInputs: [],
    outputBatcher: { flushNow: async () => {} },
  };
  daemon.handleSlotEvent(slot, {
    type: "final_reply", text: "任务完成", threadId: "session", turnId: "turn", timestamp: new Date().toISOString(),
  });
  await Promise.all(tasks);
  expect(queue.getPending()).toHaveLength(1);
  expect(queue.getPending()[0]?.adapter).toBe("deepseek");
  expect(targets).toEqual([]);
  const restored = new CodexCompletionDeliveryQueue({ initial: JSON.parse(JSON.stringify(queue.snapshot())) });
  daemon.codexCompletionDeliveries = restored;
  const sent: string[] = [];
  daemon.queueWechatMessage = async (_recipient: string, text: string) => { sent.push(text); return true; };
  await daemon.retryPendingCodexCompletionNotifications("test-recipient");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("任务完成");
  expect(restored.getPending()).toEqual([]);
  expect(targets).toEqual([expect.objectContaining({ adapter: "deepseek", sessionId: "session" })]);
});

 test("completion recovery yields after a bounded batch and retains remaining payloads", async () => {
   const delivered: string[] = [];
   const now = new Date().toISOString();
   const pending = Array.from({ length: 20 }, (_, i) => ({ key: String(i), adapter: "deepseek", threadId: String(i), createdAt: now, completedAt: now }));
   const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
     codexCompletionDeliveries: { getPending: () => pending },
     shouldPushCompletionForTask: async () => true,
     stateStore: { setLatestWechatTaskTarget() {} },
     deliverCodexCompletionNotification: async (key: string) => {
       delivered.push(key);
       return { status: "delivered", totalCount: 1 };
     },
   });
   await daemon.retryPendingCodexCompletionNotifications("test-recipient");
   expect(delivered.length).toBe(3);
   expect(pending.length).toBe(20);
 });

 test("failed deliveries cannot starve later tasks across recovery passes", async () => {
   const attempted: string[] = [];
   const now = new Date().toISOString();
   const pending = Array.from({ length: 8 }, (_, i) => ({ key: String(i), adapter: "deepseek", threadId: String(i), createdAt: now, completedAt: now }));
   const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
     codexCompletionDeliveries: { getPending: () => pending },
     shouldPushCompletionForTask: async () => true,
     deliverCodexCompletionNotification: async (key: string) => {
       attempted.push(key);
       return { status: "pending" };
     },
   });
   await daemon.retryPendingCodexCompletionNotifications("test-recipient");
   await daemon.retryPendingCodexCompletionNotifications("test-recipient");
   await daemon.retryPendingCodexCompletionNotifications("test-recipient");
   expect(new Set(attempted).size).toBe(8);
   expect(attempted.slice(0, 6)).toEqual(["0", "1", "2", "3", "4", "5"]);
 });

/**
 * 用户反馈的真实场景：ClawBot 积压太多，下派新任务时历史通知一起涌出。
 * 现在只自动推送 3 分钟内完成的，更早的仅在获取任务列表后询问，超过 1 小时直接丢弃。
 */
function buildBacklogDaemon(queue: CodexCompletionDeliveryQueue, sent: string[]) {
  return Object.assign(Object.create(WeRelayDaemon.prototype), {
    authorizedUserId: "test-recipient",
    codexCompletionDeliveries: queue,
    shouldPushCompletionForTask: async () => true,
    notificationPolicy: { sent() {} },
    stateStore: { setLatestWechatTaskTarget() {} },
    slots: new Map(),
    codexFinalReplyByThreadId: new Map(),
    codexFinalReplyByTurnId: new Map(),
    queueWechatMessage: async (_recipient: string, text: string) => {
      sent.push(text);
      return true;
    },
    deliverCodexCompletionNotification: async (key: string) => {
      const delivery = queue.getPending().find((item) => item.key === key);
      if (delivery) sent.push(delivery.texts.join("\n"));
      queue.acknowledge([key]);
      return { status: "delivered" as const, totalCount: 1 };
    },
  });
}

test("a new ClawBot message only auto-pushes completions from the last three minutes", async () => {
  const queue = new CodexCompletionDeliveryQueue();
  const now = Date.now();
  const enqueue = (n: number, ageMs: number, name: string) => queue.enqueue({
    key: `k${n}`,
    threadId: `t${n}`,
    completedAt: new Date(now - ageMs).toISOString(),
    texts: [`[任务 ${n} · Codex · ${name}] 已完成，用时5m`],
  });
  enqueue(1, 30_000, "刚完成的");
  enqueue(2, 10 * 60_000, "十分钟前");
  enqueue(3, 2 * 60 * 60_000, "两小时前");

  const sent: string[] = [];
  const daemon = buildBacklogDaemon(queue, sent);
  await daemon.retryPendingCodexCompletionNotifications("test-recipient");

  // 只有 3 分钟内的正文被推送。
  expect(sent.some((text) => text.includes("刚完成的"))).toBe(true);
  expect(sent.some((text) => text.includes("十分钟前") && text.includes("已完成，用时"))).toBe(false);
  // 普通入站恢复不提醒积压；只在用户主动获取列表后提醒。
  expect(sent.some((text) => text.includes("较早的完成通知"))).toBe(false);
  await daemon.remindClawbotBacklogAfterTaskList("test-recipient");
  expect(sent.some((text) => text.includes("还有 1 条较早的完成通知"))).toBe(true);
  expect(queue.getPending().map((item) => item.key)).toEqual(["k2"]);
  // 超过 1 小时直接丢弃，并留下未送达凭证。
  expect(queue.snapshot().undelivered?.map((item) => item.key)).toEqual(["k3"]);
});

test("the backlog prompt is asked after a list, not on every recovery pass", async () => {
  const queue = new CodexCompletionDeliveryQueue();
  const now = Date.now();
  queue.enqueue({
    key: "old", threadId: "t-old",
    completedAt: new Date(now - 10 * 60_000).toISOString(),
    texts: ["[任务 5 · Codex · 十分钟前] 已完成，用时5m"],
  });

  const sent: string[] = [];
  const daemon = buildBacklogDaemon(queue, sent);
  await daemon.retryPendingCodexCompletionNotifications("test-recipient");
  expect(sent).toEqual([]);
  await daemon.remindClawbotBacklogAfterTaskList("test-recipient");
  await daemon.retryPendingCodexCompletionNotifications("test-recipient");
  await daemon.remindClawbotBacklogAfterTaskList("test-recipient");

  expect(sent.filter((text) => text.includes("还有 1 条较早的完成通知"))).toHaveLength(1);
});

test("replying 推送 resends the confirmed backlog exactly once", async () => {
  const queue = new CodexCompletionDeliveryQueue();
  const now = Date.now();
  queue.enqueue({
    key: "old", threadId: "t-old",
    completedAt: new Date(now - 10 * 60_000).toISOString(),
    texts: ["[任务 5 · Codex · 十分钟前] 已完成，用时5m\n\n这里是迟到的正文"],
  });

  const sent: string[] = [];
  const daemon = buildBacklogDaemon(queue, sent);
  await daemon.retryPendingCodexCompletionNotifications("test-recipient");
  sent.length = 0;

  await daemon.handleClawbotBacklogPushRequest({
    senderId: "test-recipient", sender: "u", sessionId: "s", text: "推送", attachments: [],
  } as never);

  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("这里是迟到的正文");
  expect(queue.getPending()).toEqual([]);
});

test("replying 推送 with nothing waiting says so instead of staying silent", async () => {
  const queue = new CodexCompletionDeliveryQueue();
  const sent: string[] = [];
  const daemon = buildBacklogDaemon(queue, sent);
  await daemon.handleClawbotBacklogPushRequest({
    senderId: "test-recipient", sender: "u", sessionId: "s", text: "推送", attachments: [],
  } as never);
  expect(sent).toEqual(["没有需要补发的完成通知。"]);
});

test("a failed resend after 推送 keeps the notification queued", async () => {
  const queue = new CodexCompletionDeliveryQueue();
  const now = Date.now();
  queue.enqueue({
    key: "old", threadId: "t-old",
    completedAt: new Date(now - 10 * 60_000).toISOString(),
    texts: ["[任务 5 · Codex · 十分钟前] 已完成，用时5m\n\n正文"],
  });

  const daemon = buildBacklogDaemon(queue, []);
  // 微信发送失败时不能把通知当成已送达。
  daemon.queueWechatMessage = async () => false;
  await daemon.handleClawbotBacklogPushRequest({
    senderId: "test-recipient", sender: "u", sessionId: "s", text: "推送", attachments: [],
  } as never);

  expect(queue.getPending().map((item) => item.key)).toEqual(["old"]);
});

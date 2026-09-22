import { expect, test } from "bun:test";
import { WeRelayDaemon } from "../../src/daemon/werelay-daemon.ts";
import { CodexCompletionDeliveryQueue } from "../../src/daemon/codex-completion-delivery.ts";

// Exercise the actual event handler without starting servers, adapters or WeChat.
test("daemon persists a DeepSeek final event even when outbound send is rejected", async () => {
  const queue = new CodexCompletionDeliveryQueue();
  const tasks: Promise<void>[] = [];
  const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
    authorizedUserId: "test-recipient", codexCompletionDeliveries: queue,
    mobileConversationRevisions: { touch() {} }, recordAdapterMessageActivity() {},
    getSlotThreadId: () => "session", prefixSlotMessage: (_slot: unknown, text: string) => text,
    collectFinalReplyImages: async () => [], queueWechatMessage: async () => false,
    trackWechatForwardTask: (task: Promise<void>) => tasks.push(task),
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
  const restored = new CodexCompletionDeliveryQueue({ initial: JSON.parse(JSON.stringify(queue.snapshot())) });
  daemon.codexCompletionDeliveries = restored;
  const sent: string[] = [];
  daemon.queueWechatMessage = async (_recipient: string, text: string) => { sent.push(text); return true; };
  await daemon.retryPendingCodexCompletionNotifications("test-recipient");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("任务完成");
  expect(restored.getPending()).toEqual([]);
});

 test("completion recovery yields after a bounded batch and retains remaining payloads", async () => {
   const delivered: string[] = [];
   const pending = Array.from({ length: 20 }, (_, i) => ({ key: String(i), adapter: "deepseek", threadId: String(i) }));
   const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
     codexCompletionDeliveries: { getPending: () => pending },
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
   const pending = Array.from({ length: 8 }, (_, i) => ({ key: String(i), adapter: "deepseek", threadId: String(i) }));
   const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
     codexCompletionDeliveries: { getPending: () => pending },
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

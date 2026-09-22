import { expect, test } from "bun:test";
import { prepareFinalReplyDelivery } from "../../src/daemon/final-reply-delivery.ts";
import { CodexCompletionDeliveryQueue } from "../../src/daemon/codex-completion-delivery.ts";

test("DeepSeek final reply survives rejection and restart without replaying sent chunks", async () => {
  const input = await prepareFinalReplyDelivery({
    adapter: "deepseek", threadId: "session", turnId: "turn", timestamp: new Date().toISOString(),
    rawText: "结果".repeat(4000), prefix: (text) => `[测试任务]\n${text}`,
  });
  const queue = new CodexCompletionDeliveryQueue();
  queue.enqueue(input);
  expect(input.texts.length).toBeGreaterThan(1);
  await queue.deliver(input.key, async (_delivery, _texts, checkpoint) => {
    checkpoint();
    return 1;
  });
  const restored = new CodexCompletionDeliveryQueue({ initial: JSON.parse(JSON.stringify(queue.snapshot())) });
  expect(restored.getPending()[0]?.adapter).toBe("deepseek");
  const attempts: string[] = [];
  await restored.deliver(input.key, async (_delivery, texts, checkpoint) => {
    for (const text of texts) { attempts.push(text); checkpoint(); }
    return texts.length;
  });
  expect(attempts).toEqual(input.texts.slice(1));
  expect(restored.enqueue(input).status).toBe("delivered");
});

test("delivery identity is isolated by adapter/session and stable across duplicate turn events", async () => {
  const params = { adapter: "deepseek" as const, threadId: "s", turnId: "t", timestamp: "2026-01-01", rawText: "完成", prefix: (text: string) => text };
  const one = await prepareFinalReplyDelivery(params);
  expect((await prepareFinalReplyDelivery({ ...params, timestamp: "2026-01-02" })).key).toBe(one.key);
  expect((await prepareFinalReplyDelivery({ ...params, adapter: "claude" })).key).not.toBe(one.key);
  expect((await prepareFinalReplyDelivery({ ...params, threadId: "other" })).key).not.toBe(one.key);
});

test("attachments remain pending independently of delivered text and survive restart", async () => {
  const input = await prepareFinalReplyDelivery({
    adapter: "deepseek", threadId: "s", turnId: "t", timestamp: new Date().toISOString(),
    rawText: "完成", images: [{ source: "local", path: "/tmp/result.png" }], prefix: (text) => text,
  });
  const queue = new CodexCompletionDeliveryQueue();
  queue.enqueue(input);
  const result = await queue.deliver(input.key, async (_delivery, texts) => texts.length);
  expect(result.status).toBe("pending");
  const restored = new CodexCompletionDeliveryQueue({ initial: queue.snapshot() });
  const sent: string[] = [];
  const final = await restored.deliver(input.key, async () => { throw new Error("text already delivered"); }, undefined,
    async (_delivery, attachment) => { sent.push(attachment.path); });
  expect(final.status).toBe("delivered");
  expect(sent).toEqual(["/tmp/result.png"]);
});

import { describe, expect, test } from "bun:test";

import {
  CodexCompletionDeliveryQueue,
  CODEX_COMPLETION_DELIVERABLE_WINDOW_MS,
  formatCodexCompletionBacklogSummary,
  selectCodexCompletionBacklogBatch,
  type CodexCompletionDeliveryState,
} from "../../src/daemon/codex-completion-delivery.ts";

function buildQueue(
  initial?: CodexCompletionDeliveryState,
  snapshots: CodexCompletionDeliveryState[] = [],
): CodexCompletionDeliveryQueue {
  return new CodexCompletionDeliveryQueue({
    initial,
    now: () => Date.parse("2026-08-08T12:00:00.000Z"),
    persist: (state) => snapshots.push(structuredClone(state)),
  });
}

test("backoff-suppressed completion is persisted and delivered after restart", async () => {
  const snapshots: CodexCompletionDeliveryState[] = [];
  const queue = buildQueue(undefined, snapshots);
  queue.enqueue({ key: "deepseek:session:turn", threadId: "session", texts: ["任务完成"] });
  const rejected = await queue.deliver("deepseek:session:turn", async () => 0);
  expect(rejected.status).toBe("pending");
  expect(snapshots.at(-1)?.pending[0]?.nextTextIndex).toBe(0);
  const restarted = buildQueue(snapshots.at(-1));
  const recovered = await restarted.deliver("deepseek:session:turn", async (_item, texts) => texts.length);
  expect(recovered.status).toBe("delivered");
  expect(restarted.getPending()).toEqual([]);
});

describe("Codex completion delivery queue", () => {
  test("retains a stale-token 0/N delivery for retry", async () => {
    const snapshots: CodexCompletionDeliveryState[] = [];
    const queue = buildQueue(undefined, snapshots);
    queue.enqueue({
      key: "thread:turn",
      threadId: "thread",
      turnId: "turn",
      texts: ["完成摘要", "链接"],
    });

    const result = await queue.deliver("thread:turn", async () => 0);

    expect(result.status).toBe("pending");
    expect(result.sentCount).toBe(0);
    expect(queue.snapshot().pending[0]?.nextTextIndex).toBe(0);
    expect(queue.hasDelivered("thread:turn")).toBe(false);
    expect(snapshots.at(-1)?.pending).toHaveLength(1);
  });

  test("resumes after a partial send without repeating delivered chunks", async () => {
    const queue = buildQueue();
    queue.enqueue({
      key: "thread:turn",
      threadId: "thread",
      texts: ["第一段", "第二段", "第三段"],
    });
    const attempts: string[][] = [];

    const first = await queue.deliver("thread:turn", async (_delivery, texts) => {
      attempts.push(texts);
      return 1;
    });
    const second = await queue.deliver("thread:turn", async (_delivery, texts) => {
      attempts.push(texts);
      return texts.length;
    });

    expect(first.status).toBe("pending");
    expect(second.status).toBe("delivered");
    expect(attempts).toEqual([
      ["第一段", "第二段", "第三段"],
      ["第二段", "第三段"],
    ]);
    expect(queue.snapshot().pending).toEqual([]);
    expect(queue.hasDelivered("thread:turn")).toBe(true);
  });

  test("prevents concurrent duplicate delivery while one attempt is in flight", async () => {
    const queue = buildQueue();
    queue.enqueue({
      key: "thread:turn",
      threadId: "thread",
      texts: ["完成"],
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.deliver("thread:turn", async (_delivery, texts) => {
      await waiting;
      return texts.length;
    });

    const duplicate = await queue.deliver("thread:turn", async () => 1);
    release();

    expect(duplicate.status).toBe("in_flight");
    expect((await first).status).toBe("delivered");
  });

  test("persists pending payloads and retries them after restart", async () => {
    const snapshots: CodexCompletionDeliveryState[] = [];
    const firstQueue = buildQueue(undefined, snapshots);
    firstQueue.enqueue({
      key: "thread:turn",
      threadId: "thread",
      texts: ["完整回答", "任务链接"],
    });
    await firstQueue.deliver("thread:turn", async () => 0);

    const restarted = buildQueue(snapshots.at(-1));
    const delivered = await restarted.deliver(
      "thread:turn",
      async (_delivery, texts) => texts.length,
    );

    expect(delivered.status).toBe("delivered");
    expect(restarted.snapshot().pending).toEqual([]);
    expect(restarted.hasDelivered("thread:turn")).toBe(true);
  });

  test("deduplicates a successfully delivered notification across restart", async () => {
    const snapshots: CodexCompletionDeliveryState[] = [];
    const queue = buildQueue(undefined, snapshots);
    queue.enqueue({
      key: "thread:turn",
      threadId: "thread",
      texts: ["完成"],
    });
    await queue.deliver("thread:turn", async (_delivery, texts) => texts.length);

    const restarted = buildQueue(snapshots.at(-1));
    const enqueue = restarted.enqueue({
      key: "thread:turn",
      threadId: "thread",
      texts: ["不应再次发送"],
    });
    let called = false;
    const result = await restarted.deliver("thread:turn", async () => {
      called = true;
      return 1;
    });

    expect(enqueue.status).toBe("delivered");
    expect(result.status).toBe("delivered");
    expect(called).toBe(false);
  });

  test("selects fully unsent completions for one backlog summary", async () => {
    const queue = buildQueue();
    for (let index = 1; index <= 4; index += 1) {
      queue.enqueue({
        key: `thread-${index}:turn`,
        threadId: `thread-${index}`,
        title: `任务 ${index}`,
        completedAt: `2026-08-08T0${index}:00:00.000Z`,
        url: `https://werelay.example/t/${index}`,
        texts: [`完成 ${index}`],
      });
    }
    await queue.deliver("thread-1:turn", async () => 0);
    const state = queue.snapshot();
    state.pending[0]!.nextTextIndex = 1;

    expect(selectCodexCompletionBacklogBatch(state.pending, 3).map((item) => item.key))
      .toEqual(["thread-2:turn", "thread-3:turn", "thread-4:turn"]);
    expect(selectCodexCompletionBacklogBatch(state.pending, 4)).toEqual([]);
  });

  test("formats one concise summary with completion time, task name, and task link", () => {
    const summary = formatCodexCompletionBacklogSummary([
      {
        key: "a:1",
        threadId: "a",
        title: "整理发布文档",
        completedAt: "2026-08-08T08:00:00.000Z",
        url: "https://werelay.example/t/a",
        texts: ["完成"],
        nextTextIndex: 0,
        createdAt: "2026-08-08T08:00:00.000Z",
      },
      {
        key: "a:2",
        threadId: "a",
        title: "整理发布文档",
        completedAt: "2026-08-08T09:00:00.000Z",
        url: "https://werelay.example/t/a",
        texts: ["完成"],
        nextTextIndex: 0,
        createdAt: "2026-08-08T09:00:00.000Z",
      },
      {
        key: "b:1",
        threadId: "b",
        title: "修复微信任务列表",
        completedAt: "2026-08-08T10:30:00.000Z",
        url: "https://werelay.example/t/b",
        texts: ["完成"],
        nextTextIndex: 0,
        createdAt: "2026-08-08T10:30:00.000Z",
      },
    ]);

    expect(summary).toContain("📥 积压完成通知汇总：3 条 · 2 个任务");
    expect(summary).toContain("1. ✅ 修复微信任务列表");
    expect(summary).toContain("  08-08 18:30 · https://werelay.example/t/b");
    expect(summary).toContain("2. ✅ 整理发布文档（2 条）");
    expect(summary).toContain("  08-08 17:00 · https://werelay.example/t/a");
    expect(summary).toContain("点开链接可查看对应任务的完整回复。");
    expect(summary.indexOf("修复微信任务列表")).toBeLessThan(
      summary.indexOf("整理发布文档"),
    );
  });

  test("marks failed and interrupted backlog entries without the success icon", () => {
    const summary = formatCodexCompletionBacklogSummary([
      {
        key: "f:1",
        threadId: "f",
        title: "失败任务",
        completedAt: "2026-08-08T10:30:00.000Z",
        url: "https://werelay.example/t/f",
        texts: ["失败"],
        nextTextIndex: 0,
        createdAt: "2026-08-08T10:30:00.000Z",
        outcome: "failed",
      },
      {
        key: "i:1",
        threadId: "i",
        title: "中断任务",
        completedAt: "2026-08-08T09:00:00.000Z",
        url: "https://werelay.example/t/i",
        texts: ["中断"],
        nextTextIndex: 0,
        createdAt: "2026-08-08T09:00:00.000Z",
        outcome: "interrupted",
      },
    ]);

    expect(summary).toContain("1. ❌ 执行失败 · 失败任务");
    expect(summary).toContain("2. ⚠️ 已中断 · 中断任务");
    expect(summary).not.toContain("✅");
  });

  test("acknowledges a delivered backlog summary without sending each original message", () => {
    const queue = buildQueue();
    queue.enqueue({ key: "a:1", threadId: "a", texts: ["完成 A"] });
    queue.enqueue({ key: "b:1", threadId: "b", texts: ["完成 B"] });

    const acknowledged = queue.acknowledge(["a:1", "b:1"]);

    expect(acknowledged.map((item) => item.key)).toEqual(["a:1", "b:1"]);
    expect(queue.getPending()).toEqual([]);
    expect(queue.hasDelivered("a:1")).toBe(true);
    expect(queue.hasDelivered("b:1")).toBe(true);
  });

  test("bounds delivered keys and expires retained payloads", async () => {
    let now = Date.parse("2026-08-08T12:00:00.000Z");
    let persisted: CodexCompletionDeliveryState | undefined;
    const queue = new CodexCompletionDeliveryQueue({
      now: () => now,
      persist: (state) => {
        persisted = structuredClone(state);
      },
    });
    for (let index = 0; index < 540; index += 1) {
      const key = `thread:turn-${index}`;
      queue.enqueue({ key, threadId: "thread", texts: [`完成 ${index}`] });
      await queue.deliver(key, async (_delivery, texts) => texts.length);
      now += 1;
    }
    expect(queue.snapshot().delivered.length).toBeLessThanOrEqual(512);

    queue.enqueue({
      key: "thread:pending-sensitive",
      threadId: "thread",
      texts: ["/Users/example/private-image.png"],
    });
    now += 31 * 24 * 60 * 60_000;

    expect(queue.getPending()).toEqual([]);
    expect(queue.snapshot().delivered).toEqual([]);
    expect(persisted?.pending).toEqual([]);
  });
});

test("persists text/link/image checkpoints and only retries the missing image after restart", async () => {
  const snapshots: CodexCompletionDeliveryState[] = [];
  const queue = buildQueue(undefined, snapshots);
  queue.enqueue({ key: "t:1", threadId: "t", texts: ["正文", "任务链接"], images: ["/tmp/a.png", "/tmp/b.png"] });
  const sent: string[] = [];
  const result = await queue.deliver("t:1", async (_delivery, texts, checkpoint) => {
    for (const text of texts) { sent.push(text); checkpoint(); }
    return texts.length;
  }, async (_delivery, image) => { if (image.endsWith("b.png")) throw new Error("rejected"); sent.push(image); });
  expect(result.status).toBe("pending");
  expect(queue.hasDelivered("t:1")).toBe(false);
  expect(queue.acknowledge(["t:1"])).toEqual([]);
  const restored = buildQueue(snapshots.at(-1));
  const done = await restored.deliver("t:1", async () => { throw new Error("must not repeat text"); }, async (_delivery, image) => { sent.push(image); });
  expect(done.status).toBe("delivered");
  expect(sent).toEqual(["正文", "任务链接", "/tmp/a.png", "/tmp/b.png"]);
  await restored.deliver("t:1", async () => { throw new Error("already delivered"); });
});

test("a crash after the first text checkpoint does not repeat that text", async () => {
  const snapshots: CodexCompletionDeliveryState[] = [];
  const queue = buildQueue(undefined, snapshots);
  queue.enqueue({ key: "t:crash", threadId: "t", texts: ["正文", "链接"] });
  await expect(queue.deliver("t:crash", async (_delivery, _texts, checkpoint) => {
    checkpoint(); throw new Error("process stopped");
  })).rejects.toThrow("process stopped");
  const restored = buildQueue(snapshots.at(-1));
  await restored.deliver("t:crash", async (_delivery, texts) => { expect(texts).toEqual(["链接"]); return 1; });
});

describe("Codex completion delivery expiry window", () => {
  function buildExpiryQueue(
    initial?: CodexCompletionDeliveryState,
    nowRef: { value: number } = { value: Date.parse("2026-08-08T12:00:00.000Z") },
    expiredBatches: string[][] = [],
  ): CodexCompletionDeliveryQueue {
    return new CodexCompletionDeliveryQueue({
      initial,
      now: () => nowRef.value,
      onExpire: (deliveries) => expiredBatches.push(deliveries.map((item) => item.key)),
    });
  }

  test("drops a completion that has been undelivered past the window", async () => {
    const nowRef = { value: Date.parse("2026-08-08T12:00:00.000Z") };
    const expiredBatches: string[][] = [];
    const queue = buildExpiryQueue(undefined, nowRef, expiredBatches);
    queue.enqueue({ key: "t:stale", threadId: "t", texts: ["完成"] });

    nowRef.value += CODEX_COMPLETION_DELIVERABLE_WINDOW_MS + 1;

    expect(queue.getPending()).toEqual([]);
    let called = false;
    const result = await queue.deliver("t:stale", async () => {
      called = true;
      return 1;
    });
    expect(result.status).toBe("missing");
    expect(called).toBe(false);
    expect(expiredBatches).toEqual([["t:stale"]]);
  });

  test("keeps a completion that is still inside the window", async () => {
    const nowRef = { value: Date.parse("2026-08-08T12:00:00.000Z") };
    const expiredBatches: string[][] = [];
    const queue = buildExpiryQueue(undefined, nowRef, expiredBatches);
    queue.enqueue({ key: "t:fresh", threadId: "t", texts: ["完成"] });

    nowRef.value += CODEX_COMPLETION_DELIVERABLE_WINDOW_MS - 60_000;

    expect(queue.getPending().map((item) => item.key)).toEqual(["t:fresh"]);
    const result = await queue.deliver("t:fresh", async (_delivery, texts) => texts.length);
    expect(result.status).toBe("delivered");
    expect(expiredBatches).toEqual([]);
  });

  test("never resurrects an expired completion when the same key is replayed", async () => {
    const nowRef = { value: Date.parse("2026-08-08T12:00:00.000Z") };
    const queue = buildExpiryQueue(undefined, nowRef);
    queue.enqueue({ key: "t:stale", threadId: "t", texts: ["完成"] });

    nowRef.value += CODEX_COMPLETION_DELIVERABLE_WINDOW_MS + 1;
    expect(queue.getPending()).toEqual([]);

    const replayed = queue.enqueue({ key: "t:stale", threadId: "t", texts: ["重放"] });

    expect(replayed.status).toBe("expired");
    expect(queue.getPending()).toEqual([]);
    let called = false;
    await queue.deliver("t:stale", async () => {
      called = true;
      return 1;
    });
    expect(called).toBe(false);
  });

  test("drops an already-expired backlog restored from disk on first retry", () => {
    const staleState: CodexCompletionDeliveryState = {
      pending: [{
        key: "t:stale",
        threadId: "t",
        texts: ["旧完成通知"],
        nextTextIndex: 0,
        createdAt: "2026-08-08T00:00:00.000Z",
      }],
      delivered: [],
    };
    const expiredBatches: string[][] = [];
    const queue = buildExpiryQueue(
      staleState,
      { value: Date.parse("2026-08-08T12:00:00.000Z") },
      expiredBatches,
    );

    expect(queue.getPending()).toEqual([]);
    expect(expiredBatches).toEqual([["t:stale"]]);
  });

  test("does not expire a completion while its own send is in flight", async () => {
    const nowRef = { value: Date.parse("2026-08-08T12:00:00.000Z") };
    const expiredBatches: string[][] = [];
    const queue = buildExpiryQueue(undefined, nowRef, expiredBatches);
    queue.enqueue({ key: "t:slow", threadId: "t", texts: ["完成"] });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = queue.deliver("t:slow", async (_delivery, texts) => {
      await waiting;
      return texts.length;
    });

    nowRef.value += CODEX_COMPLETION_DELIVERABLE_WINDOW_MS + 1;
    expect(queue.getPending().map((item) => item.key)).toEqual(["t:slow"]);

    release();
    expect((await inFlight).status).toBe("delivered");
    expect(expiredBatches).toEqual([]);
  });
});

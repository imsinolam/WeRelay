import { describe, expect, test } from "bun:test";
import {
  CLAWBOT_AUTO_PUSH_WINDOW_MS,
  CLAWBOT_BACKLOG_CONFIRM_TTL_MS,
  CLAWBOT_BACKLOG_DISCARD_MS,
  formatClawbotBacklogConfirmPrompt,
  isClawbotBacklogConfirmActive,
  isClawbotBacklogConfirmReply,
  planClawbotBacklogDelivery,
} from "../../src/daemon/clawbot-backlog-policy.ts";
import {
  CODEX_COMPLETION_DELIVERABLE_WINDOW_MS,
  CodexCompletionDeliveryQueue,
  type PendingCodexCompletionDelivery,
} from "../../src/daemon/codex-completion-delivery.ts";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");

function delivery(
  key: string,
  ageMs: number,
  overrides: Partial<PendingCodexCompletionDelivery> = {},
): PendingCodexCompletionDelivery {
  return {
    key,
    threadId: `thread-${key}`,
    texts: [`[任务 1 · Codex · ${key}] 已完成，用时1m`],
    nextTextIndex: 0,
    createdAt: new Date(NOW - ageMs).toISOString(),
    completedAt: new Date(NOW - ageMs).toISOString(),
    ...overrides,
  };
}

describe("ClawBot backlog delivery windows", () => {
  test("auto-pushes only notifications completed within three minutes", () => {
    const plan = planClawbotBacklogDelivery([
      delivery("fresh", 30_000),
      delivery("boundary", CLAWBOT_AUTO_PUSH_WINDOW_MS),
      delivery("too-old", CLAWBOT_AUTO_PUSH_WINDOW_MS + 1),
    ], NOW);

    expect(plan.autoPush.map((item) => item.key)).toEqual(["fresh", "boundary"]);
    expect(plan.awaitingConfirmation.map((item) => item.key)).toEqual(["too-old"]);
    expect(plan.discard).toEqual([]);
  });

  test("discards notifications older than one hour instead of queueing them", () => {
    const plan = planClawbotBacklogDelivery([
      delivery("keep", 10 * 60_000),
      delivery("edge", CLAWBOT_BACKLOG_DISCARD_MS),
      delivery("drop", CLAWBOT_BACKLOG_DISCARD_MS + 1),
    ], NOW);

    expect(plan.discard.map((item) => item.key)).toEqual(["drop"]);
    expect(plan.awaitingConfirmation.map((item) => item.key)).toEqual(["keep", "edge"]);
    expect(plan.autoPush).toEqual([]);
  });

  test("uses completion time rather than queue time so a late capture is not re-pushed", () => {
    // 任务实际完成于 2 小时前，但直到刚刚才被采集入队：按完成时间应直接丢弃。
    const plan = planClawbotBacklogDelivery([
      delivery("late-capture", 2 * 60 * 60_000, {
        createdAt: new Date(NOW - 1_000).toISOString(),
      }),
    ], NOW);

    expect(plan.discard.map((item) => item.key)).toEqual(["late-capture"]);
    expect(plan.autoPush).toEqual([]);
  });

  test("keeps unparseable timestamps for confirmation instead of dropping content", () => {
    const plan = planClawbotBacklogDelivery([
      { key: "broken", threadId: "t", texts: ["x"], nextTextIndex: 0, createdAt: "not-a-date" },
    ], NOW);

    expect(plan.awaitingConfirmation.map((item) => item.key)).toEqual(["broken"]);
    expect(plan.discard).toEqual([]);
  });

  test("sorts each group newest first", () => {
    const plan = planClawbotBacklogDelivery([
      delivery("older", 20 * 60_000),
      delivery("newer", 5 * 60_000),
    ], NOW);

    expect(plan.awaitingConfirmation.map((item) => item.key)).toEqual(["newer", "older"]);
  });
});

describe("ClawBot backlog confirmation prompt", () => {
  test("lists counts and task names without dumping message bodies", () => {
    const prompt = formatClawbotBacklogConfirmPrompt([
      delivery("a", 10 * 60_000),
      delivery("b", 11 * 60_000),
    ]);

    expect(prompt).toContain("还有 2 条较早的完成通知");
    expect(prompt).toContain("2 个任务");
    expect(prompt).toContain("回复“推送”补发");
    expect(prompt).not.toContain("用时1m");
  });

  test("groups repeated notifications for the same task", () => {
    const base = delivery("a", 10 * 60_000);
    const prompt = formatClawbotBacklogConfirmPrompt([
      base,
      { ...base, key: "a2" },
    ]);

    expect(prompt).toContain("（2 条）");
    expect(prompt).toContain("2 条较早的完成通知");
  });

  test("shows only the task name, not the full task identity header", () => {
    const prompt = formatClawbotBacklogConfirmPrompt([
      delivery("a", 10 * 60_000),
    ]);

    // 询问里不应重复“任务 N · Codex”这类头部信息。
    expect(prompt).not.toContain("任务 1 · Codex");
    expect(prompt).not.toContain("已完成，用时");
  });
});

describe("ClawBot backlog confirmation state", () => {
  test("recognises only explicit push replies", () => {
    expect(isClawbotBacklogConfirmReply("推送")).toBe(true);
    expect(isClawbotBacklogConfirmReply(" 补发 ")).toBe(true);
    expect(isClawbotBacklogConfirmReply("推送积压")).toBe(true);
    expect(isClawbotBacklogConfirmReply("推送一下")).toBe(false);
    expect(isClawbotBacklogConfirmReply("继续处理")).toBe(false);
  });

  test("expires a stale confirmation window", () => {
    expect(isClawbotBacklogConfirmActive({ requestedAtMs: NOW }, NOW)).toBe(true);
    expect(isClawbotBacklogConfirmActive(
      { requestedAtMs: NOW - CLAWBOT_BACKLOG_CONFIRM_TTL_MS - 1 },
      NOW,
    )).toBe(false);
    expect(isClawbotBacklogConfirmActive(undefined, NOW)).toBe(false);
  });
});

describe("discarding expired backlog from the queue", () => {
  test("drops the delivery, records an undelivered receipt and blocks replay", () => {
    const now = NOW;
    const queue = new CodexCompletionDeliveryQueue({ now: () => now });
    const input = { key: "t:old", threadId: "t", texts: ["private-payload"] };
    queue.enqueue(input);

    expect(queue.discard(["t:old"]).map((item) => item.key)).toEqual(["t:old"]);
    expect(queue.getPending()).toEqual([]);
    expect(queue.getNotificationStatus("t")).toMatchObject({
      status: "not_delivered",
      reason: "expired",
    });
    // 丢弃后同一 key 的重放事件不能把它复活。
    expect(queue.enqueue(input).status).toBe("expired");
    expect(queue.snapshot().undelivered?.[0]).toMatchObject({ key: "t:old", reason: "expired" });
    // 终态凭证只保留身份，不保留正文。
    expect(JSON.stringify(queue.snapshot())).not.toContain("private-payload");
  });

  test("never discards a delivery whose send is in flight", () => {
    const now = NOW;
    const queue = new CodexCompletionDeliveryQueue({ now: () => now });
    queue.enqueue({ key: "t:active", threadId: "t", texts: ["正文", "链接"] });

    expect(queue.reserveSummary(["t:active"])).toBe(true);
    expect(queue.discard(["t:active"])).toEqual([]);
    expect(queue.getPending().map((item) => item.key)).toEqual(["t:active"]);
    queue.releaseSummary(["t:active"]);
  });

  test("keeps the hard discard window at one hour", () => {
    expect(CODEX_COMPLETION_DELIVERABLE_WINDOW_MS).toBe(60 * 60_000);
    expect(CLAWBOT_BACKLOG_DISCARD_MS).toBe(60 * 60_000);
  });
});


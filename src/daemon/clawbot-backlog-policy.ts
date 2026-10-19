// ClawBot 积压完成通知的投递策略。
//
// 背景：微信主动回复窗口过期后，完成通知会留在队列里按 60 秒一轮重试，最长
// 堆积 6 小时；用户下次随便发一条消息刷新 token 时，历史通知会一次性全部
// 涌出，即使他只是想下派一个新任务。实测日志中同一条通知会连续重试数百次。
//
// 现在的规则（由用户明确指定）：
// 1. 只有最近 3 分钟内完成的完成通知，才允许在 ClawBot 恢复后自动推送；
// 2. 更早的通知不自动推，而是合并成一条汇总，说明条数和任务名，等用户
//    回复“推送”后再补发；
// 3. 超过 1 小时的通知直接从队列丢弃，不再等待补发。
//
// 该模块只做纯计算：它决定“哪些现在可以自动推、哪些要问、哪些已经丢弃”，
// 不负责发送、不持久化，方便单元测试，也避免把策略散落进 daemon。

import type { PendingCodexCompletionDelivery } from "./codex-completion-delivery.ts";

/** 只有这个窗口内完成的通知识才会被自动推送。 */
export const CLAWBOT_AUTO_PUSH_WINDOW_MS = 3 * 60_000;

/** 超过这个时长的通知直接丢弃，不再进入补发询问。 */
export const CLAWBOT_BACKLOG_DISCARD_MS = 60 * 60_000;

export type ClawbotBacklogPlan = {
  /** 可以立即自动推送的通知，按完成时间倒序。 */
  autoPush: PendingCodexCompletionDelivery[];
  /** 需要用户回复“推送”后才补发的通知，按完成时间倒序。 */
  awaitingConfirmation: PendingCodexCompletionDelivery[];
  /** 已经超过丢弃窗口、必须从队列删除的通知。 */
  discard: PendingCodexCompletionDelivery[];
};

function deliveryTimestampMs(
  delivery: PendingCodexCompletionDelivery,
): number {
  const parsed = Date.parse(delivery.completedAt ?? delivery.createdAt);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function byNewestFirst(
  left: PendingCodexCompletionDelivery,
  right: PendingCodexCompletionDelivery,
): number {
  return deliveryTimestampMs(right) - deliveryTimestampMs(left);
}

/**
 * 把当前待发送通知分成“自动推 / 等确认 / 丢弃”三组。
 *
 * 时间基准使用 `completedAt`（任务真正完成的时刻），缺失时退回 `createdAt`，
 * 这样通知排队本身的耗时不会被误算成任务最新程度。
 */
export function planClawbotBacklogDelivery(
  pending: PendingCodexCompletionDelivery[],
  nowMs: number,
): ClawbotBacklogPlan {
  const autoPush: PendingCodexCompletionDelivery[] = [];
  const awaitingConfirmation: PendingCodexCompletionDelivery[] = [];
  const discard: PendingCodexCompletionDelivery[] = [];
  for (const delivery of pending) {
    const atMs = deliveryTimestampMs(delivery);
    if (!Number.isFinite(atMs)) {
      // 时间无法解析时按最保守处理：既不自动推，也不静默丢弃内容，
      // 而是交给用户确认，避免因为脏数据把真实结果永久丢掉。
      awaitingConfirmation.push(delivery);
      continue;
    }
    const ageMs = nowMs - atMs;
    if (ageMs > CLAWBOT_BACKLOG_DISCARD_MS) {
      discard.push(delivery);
      continue;
    }
    if (ageMs <= CLAWBOT_AUTO_PUSH_WINDOW_MS) {
      autoPush.push(delivery);
      continue;
    }
    awaitingConfirmation.push(delivery);
  }
  autoPush.sort(byNewestFirst);
  awaitingConfirmation.sort(byNewestFirst);
  discard.sort(byNewestFirst);
  return { autoPush, awaitingConfirmation, discard };
}

function inferBacklogTitle(
  delivery: PendingCodexCompletionDelivery,
): string {
  if (delivery.title?.trim()) return delivery.title.trim();
  const heading = delivery.texts
    .join("\n")
    .match(/^\[([^\]]+)]\s*(?:已完成|执行失败|已中断|已停止)/m);
  const identity = heading?.[1]?.trim();
  if (identity) {
    // 消息头形如“任务 77 · Codex · 任务名”，询问里只需要任务名本身；
    // 编号、终端名和状态已经在汇总文本里表达过了。
    const parts = identity.split(" · ").map((part) => part.trim()).filter(Boolean);
    const name = parts[parts.length - 1];
    if (name && !/^任务 \d+$/.test(name) && name !== "Codex") return name;
  }
  return delivery.threadId.slice(0, 8);
}

/**
 * 生成“要不要补发”的询问文案。
 *
 * 只列任务名和条数，不贴正文，避免这次询问本身又把大量内容塞进微信；用户
 * 回复“推送”后再进入正式补发流程。
 */
export function formatClawbotBacklogConfirmPrompt(
  awaitingConfirmation: PendingCodexCompletionDelivery[],
  options: { maxTasks?: number; taskLabel?: (delivery: PendingCodexCompletionDelivery) => string } = {},
): string {
  const grouped = new Map<string, { title: string; count: number }>();
  for (const delivery of awaitingConfirmation) {
    const key = `${delivery.adapter ?? "codex"}:${delivery.threadId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    grouped.set(key, { title: options.taskLabel?.(delivery) ?? inferBacklogTitle(delivery), count: 1 });
  }
  const groups = [...grouped.values()];
  const visible = groups.slice(0, Math.max(1, options.maxTasks ?? 8));
  const lines = [
    `📥 还有 ${awaitingConfirmation.length} 条较早的完成通知（${groups.length} 个任务）没有自动推送。`,
    "",
    ...visible.map((group, index) => (
      `${options.taskLabel ? "" : `${index + 1}. `}${group.title}${group.count > 1 ? `（${group.count} 条）` : ""}`
    )),
  ];
  if (groups.length > visible.length) {
    lines.push(`…另有 ${groups.length - visible.length} 个任务`);
  }
  lines.push(
    "",
    "回复“推送”补发；不回复则不再推送。超过 1 小时的通知会自动丢弃。",
  );
  return lines.join("\n");
}

/** 用户确认后才允许补发的会话标记是否仍然有效。 */
export const CLAWBOT_BACKLOG_CONFIRM_TTL_MS = 30 * 60_000;

export type ClawbotBacklogConfirmState = {
  requestedAtMs: number;
};

export function isClawbotBacklogConfirmActive(
  state: ClawbotBacklogConfirmState | undefined,
  nowMs: number,
): boolean {
  if (!state) return false;
  const ageMs = nowMs - state.requestedAtMs;
  return ageMs >= 0 && ageMs <= CLAWBOT_BACKLOG_CONFIRM_TTL_MS;
}

/** 用户是否在回复积压补发询问（“推送”/“补发”）。 */
export function isClawbotBacklogConfirmReply(text: string): boolean {
  return /^\s*(?:推送|补发|推送积压|补发积压)\s*$/u.test(text);
}

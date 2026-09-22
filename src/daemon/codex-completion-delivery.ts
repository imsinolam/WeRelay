import { IMPLEMENTED_BRIDGE_ADAPTER_IDS, type BridgeAdapterKind } from "../bridge/bridge-providers.ts";

export type CompletionAttachment = { kind: "image" | "file" | "voice" | "video"; path: string };

const MAX_PENDING_CODEX_COMPLETIONS = 80;
const MAX_DELIVERED_CODEX_COMPLETIONS = 512;
const CODEX_COMPLETION_RETENTION_MS = 30 * 24 * 60 * 60_000;
// 积压完成通知的可投递窗口。超过该时长仍未送出的通知直接作废，不再补推：
// 微信侧迟到的“任务已完成”已经没有操作价值，继续补推只会在下次连上时
// 一次性轰炸用户。该窗口只约束“还能不能推”，不改变 30 天的去重保留期。
export const CODEX_COMPLETION_DELIVERABLE_WINDOW_MS = 6 * 60 * 60_000;

export type PendingCodexCompletionDelivery = {
  key: string;
  threadId: string;
  adapter?: BridgeAdapterKind;
  attachments?: CompletionAttachment[];
  nextAttachmentIndex?: number;
  turnId?: string;
  title?: string;
  completedAt?: string;
  url?: string;
  outcome?: "completed" | "failed" | "interrupted";
  texts: string[];
  images?: string[];
  nextImageIndex?: number;
  nextTextIndex: number;
  createdAt: string;
};

export type DeliveredCodexCompletionDelivery = {
  key: string;
  deliveredAt: string;
};

export type CodexCompletionDeliveryState = {
  pending: PendingCodexCompletionDelivery[];
  delivered: DeliveredCodexCompletionDelivery[];
};

export type CodexCompletionDeliveryQueueOptions = {
  initial?: CodexCompletionDeliveryState;
  now?: () => number;
  persist?: (state: CodexCompletionDeliveryState) => void;
  onExpire?: (deliveries: PendingCodexCompletionDelivery[]) => void;
};

export type CodexCompletionEnqueueResult = {
  status: "queued" | "pending" | "delivered" | "expired";
  delivery?: PendingCodexCompletionDelivery;
};

export type CodexCompletionDeliveryResult = {
  status: "missing" | "in_flight" | "pending" | "delivered";
  sentCount: number;
  totalCount: number;
  delivery?: PendingCodexCompletionDelivery;
};

function clonePending(
  delivery: PendingCodexCompletionDelivery,
): PendingCodexCompletionDelivery {
  return {
    ...delivery,
    texts: [...delivery.texts],
    ...(delivery.attachments ? { attachments: delivery.attachments.map((item) => ({ ...item })) } : {}),
    ...(delivery.images ? { images: [...delivery.images] } : {}),
  };
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(Date.parse(value)).toISOString();
}

function normalizePending(
  value: unknown,
): PendingCodexCompletionDelivery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.key !== "string" ||
    !record.key.trim() ||
    typeof record.threadId !== "string" ||
    !record.threadId.trim() ||
    !Array.isArray(record.texts) ||
    record.texts.length === 0 ||
    !record.texts.every((text) => typeof text === "string") ||
    typeof record.nextTextIndex !== "number" ||
    !Number.isInteger(record.nextTextIndex) ||
    record.nextTextIndex < 0 ||
    record.nextTextIndex > record.texts.length
  ) {
    return null;
  }
  const createdAt = normalizeTimestamp(record.createdAt);
  if (!createdAt) {
    return null;
  }
  return {
    key: record.key.trim(),
    threadId: record.threadId.trim(),
    ...(IMPLEMENTED_BRIDGE_ADAPTER_IDS.includes(record.adapter as BridgeAdapterKind)
      ? { adapter: record.adapter as BridgeAdapterKind } : {}),
    ...(Array.isArray(record.attachments) && record.attachments.every((item) =>
      item && typeof item === "object" && ["image", "file", "voice", "video"].includes(item.kind) && typeof item.path === "string")
      ? { attachments: record.attachments.map((item) => ({ kind: item.kind, path: item.path })),
          nextAttachmentIndex: Math.min(record.attachments.length, Math.max(0, Number.isInteger(record.nextAttachmentIndex) ? Number(record.nextAttachmentIndex) : 0)) }
      : {}),
    ...(typeof record.turnId === "string" && record.turnId.trim()
      ? { turnId: record.turnId.trim() }
      : {}),
    ...(typeof record.title === "string" && record.title.trim()
      ? { title: record.title.trim() }
      : {}),
    ...(normalizeTimestamp(record.completedAt)
      ? { completedAt: normalizeTimestamp(record.completedAt) as string }
      : {}),
    ...(typeof record.url === "string" && record.url.trim()
      ? { url: record.url.trim() }
      : {}),
    ...(record.outcome === "completed" ||
        record.outcome === "failed" ||
        record.outcome === "interrupted"
      ? { outcome: record.outcome }
      : {}),
    ...(Array.isArray(record.images) && record.images.every((item) => typeof item === "string")
      ? { images: [...record.images], nextImageIndex: Math.min(record.images.length, Math.max(0, Number.isInteger(record.nextImageIndex) ? Number(record.nextImageIndex) : 0)) }
      : {}),
    texts: [...record.texts],
    nextTextIndex: record.nextTextIndex,
    createdAt,
  };
}

function normalizeDelivered(
  value: unknown,
): DeliveredCodexCompletionDelivery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string" || !record.key.trim()) {
    return null;
  }
  const deliveredAt = normalizeTimestamp(record.deliveredAt);
  if (!deliveredAt) {
    return null;
  }
  return {
    key: record.key.trim(),
    deliveredAt,
  };
}

export function normalizeCodexCompletionDeliveryState(
  value: unknown,
  nowMs = Date.now(),
): CodexCompletionDeliveryState {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const cutoff = nowMs - CODEX_COMPLETION_RETENTION_MS;
  const deliveredByKey = new Map<string, DeliveredCodexCompletionDelivery>();
  for (const item of Array.isArray(record.delivered) ? record.delivered : []) {
    const delivered = normalizeDelivered(item);
    if (!delivered || Date.parse(delivered.deliveredAt) < cutoff) {
      continue;
    }
    const previous = deliveredByKey.get(delivered.key);
    if (!previous || Date.parse(previous.deliveredAt) < Date.parse(delivered.deliveredAt)) {
      deliveredByKey.set(delivered.key, delivered);
    }
  }
  const delivered = [...deliveredByKey.values()]
    .sort((left, right) => Date.parse(left.deliveredAt) - Date.parse(right.deliveredAt))
    .slice(-MAX_DELIVERED_CODEX_COMPLETIONS);
  const deliveredKeys = new Set(delivered.map((item) => item.key));

  const pendingByKey = new Map<string, PendingCodexCompletionDelivery>();
  for (const item of Array.isArray(record.pending) ? record.pending : []) {
    const pending = normalizePending(item);
    if (
      !pending ||
      Date.parse(pending.createdAt) < cutoff ||
      deliveredKeys.has(pending.key)
    ) {
      continue;
    }
    const previous = pendingByKey.get(pending.key);
    if (!previous || Date.parse(previous.createdAt) < Date.parse(pending.createdAt)) {
      pendingByKey.set(pending.key, pending);
    }
  }
  const pending = [...pendingByKey.values()]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-MAX_PENDING_CODEX_COMPLETIONS);

  return {
    pending: pending.map(clonePending),
    delivered: delivered.map((item) => ({ ...item })),
  };
}

export function selectCodexCompletionBacklogBatch(
  pending: PendingCodexCompletionDelivery[],
  threshold = 3,
): PendingCodexCompletionDelivery[] {
  const fullyUnsent = pending.filter((delivery) => delivery.nextTextIndex === 0);
  return fullyUnsent.length >= Math.max(2, threshold) ? fullyUnsent : [];
}

function inferCompletionTitle(delivery: PendingCodexCompletionDelivery): string {
  if (delivery.title?.trim()) return delivery.title.trim();
  const heading = delivery.texts.join("\n").match(/^\[([^\]]+)]\s*(?:已完成|执行失败|已中断)/m);
  return heading?.[1]?.trim() || `任务 ${delivery.threadId.slice(0, 8)}`;
}

function inferCompletionUrl(delivery: PendingCodexCompletionDelivery): string | undefined {
  if (delivery.url?.trim()) return delivery.url.trim();
  return delivery.texts.join("\n").match(/https?:\/\/[^\s]+/)?.[0];
}

function inferCompletionOutcome(
  delivery: PendingCodexCompletionDelivery,
): "completed" | "failed" | "interrupted" {
  if (delivery.outcome) return delivery.outcome;
  const text = delivery.texts.join("\n");
  if (/执行失败/.test(text)) return "failed";
  if (/已中断/.test(text)) return "interrupted";
  return "completed";
}

function formatCompletionTimestamp(value: string): string {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${read("month")}-${read("day")} ${read("hour")}:${read("minute")}`;
}

export function formatCodexCompletionBacklogSummary(
  deliveries: PendingCodexCompletionDelivery[],
  options: { maxTasks?: number } = {},
): string {
  const sorted = [...deliveries].sort((left, right) => (
    Date.parse(right.completedAt ?? right.createdAt) -
    Date.parse(left.completedAt ?? left.createdAt)
  ));
  const grouped = new Map<string, {
    delivery: PendingCodexCompletionDelivery;
    count: number;
  }>();
  for (const delivery of sorted) {
    const existing = grouped.get(delivery.threadId);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(delivery.threadId, { delivery, count: 1 });
    }
  }
  const groups = [...grouped.values()];
  const visible = groups.slice(0, Math.max(1, options.maxTasks ?? 12));
  const lines = [
    `📥 积压完成通知汇总：${deliveries.length} 条 · ${groups.length} 个任务`,
    "",
  ];
  visible.forEach((group, index) => {
    const delivery = group.delivery;
    const outcome = inferCompletionOutcome(delivery);
    const statusIcon = outcome === "failed"
      ? "❌"
      : outcome === "interrupted"
        ? "⚠️"
        : "✅";
    const statusPrefix = outcome === "failed"
      ? "执行失败 · "
      : outcome === "interrupted"
        ? "已中断 · "
        : "";
    const repeat = group.count > 1 ? `（${group.count} 条）` : "";
    lines.push(
      `${index + 1}. ${statusIcon} ${statusPrefix}${inferCompletionTitle(delivery)}${repeat}`,
    );
    const url = inferCompletionUrl(delivery);
    if (url) {
      lines.push(
        `  ${formatCompletionTimestamp(delivery.completedAt ?? delivery.createdAt)} · ${url}`,
      );
    }
    if (index < visible.length - 1) lines.push("");
  });
  if (groups.length > visible.length) {
    lines.push("", `另有 ${groups.length - visible.length} 个较早任务，请在网页版“最近”中查看。`);
  }
  lines.push("", "点开链接可查看对应任务的完整回复。");
  return lines.join("\n");
}

export class CodexCompletionDeliveryQueue {
  private readonly now: () => number;
  private readonly persist?: (state: CodexCompletionDeliveryState) => void;
  private readonly onExpire?: (deliveries: PendingCodexCompletionDelivery[]) => void;
  private readonly pending = new Map<string, PendingCodexCompletionDelivery>();
  private readonly delivered = new Map<string, DeliveredCodexCompletionDelivery>();
  private readonly expired = new Map<string, number>();
  private readonly inFlight = new Set<string>();

  constructor(options: CodexCompletionDeliveryQueueOptions = {}) {
    this.now = options.now ?? Date.now;
    this.persist = options.persist;
    this.onExpire = options.onExpire;
    const initial = normalizeCodexCompletionDeliveryState(
      options.initial,
      this.now(),
    );
    for (const delivery of initial.pending) {
      this.pending.set(delivery.key, clonePending(delivery));
    }
    for (const delivery of initial.delivered) {
      this.delivered.set(delivery.key, { ...delivery });
    }
    // 构造阶段不主动清理：此时 onExpire 监听方尚未就绪。getPending /
    // deliver / enqueue / snapshot 都会先做一次带通知的清理，daemon 启动
    // 后的第一轮重试即可丢弃过期积压并留下日志。
  }

  snapshot(): CodexCompletionDeliveryState {
    this.pruneExpired();
    return this.snapshotWithoutPruning();
  }

  private snapshotWithoutPruning(): CodexCompletionDeliveryState {
    return {
      pending: [...this.pending.values()].map(clonePending),
      delivered: [...this.delivered.values()].map((item) => ({ ...item })),
    };
  }

  getPending(): PendingCodexCompletionDelivery[] {
    if (this.pruneExpired()) {
      this.persistState();
    }
    return [...this.pending.values()].map(clonePending);
  }

  hasDelivered(key: string): boolean {
    if (this.pruneExpired()) {
      this.persistState();
    }
    return this.delivered.has(key);
  }

  enqueue(input: {
    key: string;
    threadId: string;
    adapter?: BridgeAdapterKind;
    attachments?: CompletionAttachment[];
    turnId?: string;
    title?: string;
    completedAt?: string;
    url?: string;
    outcome?: "completed" | "failed" | "interrupted";
    texts: string[];
    images?: string[];
  }): CodexCompletionEnqueueResult {
    if (this.pruneExpired()) {
      this.persistState();
    }
    const key = input.key.trim();
    if (this.delivered.has(key)) {
      return { status: "delivered" };
    }
    if (this.expired.has(key)) {
      // 已经过期作废的通知不允许被重放事件重新入队。
      return { status: "expired" };
    }
    const existing = this.pending.get(key);
    if (existing) {
      return { status: "pending", delivery: clonePending(existing) };
    }
    const texts = input.texts.filter((text) => typeof text === "string");
    if (!key || !input.threadId.trim() || texts.length === 0) {
      throw new Error("Codex completion delivery payload is invalid.");
    }
    const delivery: PendingCodexCompletionDelivery = {
      key,
      threadId: input.threadId.trim(),
      ...(input.adapter ? { adapter: input.adapter } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments.map((item) => ({ ...item })), nextAttachmentIndex: 0 } : {}),
      ...(input.turnId?.trim() ? { turnId: input.turnId.trim() } : {}),
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(normalizeTimestamp(input.completedAt)
        ? { completedAt: normalizeTimestamp(input.completedAt) as string }
        : {}),
      ...(input.url?.trim() ? { url: input.url.trim() } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      texts: [...texts],
      ...(input.images?.length ? { images: [...input.images], nextImageIndex: 0 } : {}),
      nextTextIndex: 0,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.pending.set(key, delivery);
    this.trimPending();
    this.persistState();
    return { status: "queued", delivery: clonePending(delivery) };
  }

  acknowledge(keys: string[]): PendingCodexCompletionDelivery[] {
    const acknowledged: PendingCodexCompletionDelivery[] = [];
    for (const key of keys) {
      if (this.inFlight.has(key)) continue;
      const delivery = this.pending.get(key);
      if (!delivery || (delivery.images?.length ?? 0) > (delivery.nextImageIndex ?? 0) ||
          (delivery.attachments?.length ?? 0) > (delivery.nextAttachmentIndex ?? 0)) continue;
      this.pending.delete(key);
      this.delivered.delete(key);
      this.delivered.set(key, {
        key,
        deliveredAt: new Date(this.now()).toISOString(),
      });
      acknowledged.push(clonePending(delivery));
    }
    if (acknowledged.length > 0) {
      this.trimDelivered();
      this.persistState();
    }
    return acknowledged;
  }

  async deliver(
    key: string,
    send: (
      delivery: PendingCodexCompletionDelivery,
      remainingTexts: string[],
      checkpoint: () => void,
    ) => Promise<number>,
    sendImage?: (delivery: PendingCodexCompletionDelivery, imagePath: string) => Promise<void>,
    sendAttachment?: (delivery: PendingCodexCompletionDelivery, attachment: CompletionAttachment) => Promise<void>,
  ): Promise<CodexCompletionDeliveryResult> {
    if (this.pruneExpired()) {
      this.persistState();
    }
    if (this.delivered.has(key)) {
      return { status: "delivered", sentCount: 0, totalCount: 0 };
    }
    const delivery = this.pending.get(key);
    if (!delivery) {
      return { status: "missing", sentCount: 0, totalCount: 0 };
    }
    if (this.inFlight.has(key)) {
      return {
        status: "in_flight",
        sentCount: 0,
        totalCount: delivery.texts.length,
        delivery: clonePending(delivery),
      };
    }

    this.inFlight.add(key);
    try {
      const remaining = delivery.texts.slice(delivery.nextTextIndex);
      const startIndex = delivery.nextTextIndex;
      const checkpoint = () => {
        if (delivery.nextTextIndex < delivery.texts.length) {
          delivery.nextTextIndex++;
          this.persistState();
        }
      };
      if (remaining.length) {
        const reportedCount = await send(clonePending(delivery), [...remaining], checkpoint);
        delivery.nextTextIndex = Math.max(delivery.nextTextIndex, startIndex + Math.max(0,
          Math.min(remaining.length, Number.isInteger(reportedCount) ? reportedCount : 0)));
        this.persistState();
      }
      const sentCount = delivery.nextTextIndex - startIndex;
      if (delivery.nextTextIndex >= delivery.texts.length) {
        const images = delivery.images ?? [];
        while ((delivery.nextImageIndex ?? 0) < images.length) {
          if (!sendImage) return { status: "pending", sentCount, totalCount: delivery.texts.length, delivery: clonePending(delivery) };
          try {
            await sendImage(clonePending(delivery), images[delivery.nextImageIndex ?? 0]!);
          } catch {
            return { status: "pending", sentCount, totalCount: delivery.texts.length, delivery: clonePending(delivery) };
          }
          delivery.nextImageIndex = (delivery.nextImageIndex ?? 0) + 1;
          this.persistState();
        }
        const attachments = delivery.attachments ?? [];
        while ((delivery.nextAttachmentIndex ?? 0) < attachments.length) {
          if (!sendAttachment) return { status: "pending", sentCount, totalCount: delivery.texts.length, delivery: clonePending(delivery) };
          try {
            await sendAttachment(clonePending(delivery), attachments[delivery.nextAttachmentIndex ?? 0]!);
          } catch {
            return { status: "pending", sentCount, totalCount: delivery.texts.length, delivery: clonePending(delivery) };
          }
          delivery.nextAttachmentIndex = (delivery.nextAttachmentIndex ?? 0) + 1;
          this.persistState();
        }
        this.markDelivered(delivery);
        return { status: "delivered", sentCount, totalCount: delivery.texts.length, delivery: clonePending(delivery) };
      }
      return { status: "pending", sentCount, totalCount: delivery.texts.length, delivery: clonePending(delivery) };
    } finally {
      this.inFlight.delete(key);
    }
  }

  private markDelivered(delivery: PendingCodexCompletionDelivery): void {
    this.pending.delete(delivery.key);
    this.delivered.delete(delivery.key);
    this.delivered.set(delivery.key, {
      key: delivery.key,
      deliveredAt: new Date(this.now()).toISOString(),
    });
    this.trimDelivered();
    this.persistState();
  }

  private trimPending(): void {
    while (this.pending.size > MAX_PENDING_CODEX_COMPLETIONS) {
      const oldestKey = this.pending.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.pending.delete(oldestKey);
    }
  }

  private trimDelivered(): void {
    this.pruneExpired();
    while (this.delivered.size > MAX_DELIVERED_CODEX_COMPLETIONS) {
      const oldestKey = this.delivered.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.delivered.delete(oldestKey);
    }
  }

  private persistState(): void {
    this.persist?.(this.snapshotWithoutPruning());
  }

  private pruneExpired(): boolean {
    const nowMs = this.now();
    const retentionCutoff = nowMs - CODEX_COMPLETION_RETENTION_MS;
    const deliverableCutoff = nowMs - CODEX_COMPLETION_DELIVERABLE_WINDOW_MS;
    let changed = false;
    const expired: PendingCodexCompletionDelivery[] = [];
    for (const [key, delivery] of this.pending) {
      // 正在发送中的条目不能在此刻作废：send 回调返回后仍会按 nextTextIndex
      // 收尾，提前删除会让一次已完成的分段发送状态与记录不一致。
      if (this.inFlight.has(key)) {
        continue;
      }
      const createdAtMs = Date.parse(delivery.createdAt);
      // 超过投递窗口的积压通知直接作废：既不补推，也不允许之后被同 key
      // 的事件重新入队，否则重放会把它“复活”成一条新通知。
      if (createdAtMs < deliverableCutoff) {
        this.pending.delete(key);
        this.rememberExpired(key);
        expired.push(clonePending(delivery));
        changed = true;
        continue;
      }
      if (createdAtMs < retentionCutoff) {
        this.pending.delete(key);
        changed = true;
      }
    }
    for (const [key, delivery] of this.delivered) {
      if (Date.parse(delivery.deliveredAt) < retentionCutoff) {
        this.delivered.delete(key);
        changed = true;
      }
    }
    if (expired.length > 0) {
      this.onExpire?.(expired);
    }
    return changed;
  }

  private rememberExpired(key: string): void {
    this.expired.delete(key);
    this.expired.set(key, this.now());
    while (this.expired.size > MAX_DELIVERED_CODEX_COMPLETIONS) {
      const oldestKey = this.expired.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.expired.delete(oldestKey);
    }
  }
}

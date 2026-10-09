import type { DaemonAdapterKind } from "./daemon-link.ts";
import { isDaemonAdapterKind } from "../bridge/bridge-providers.ts";

const MAX_PENDING_APPROVAL_NOTIFICATIONS = 160;
const MAX_DELIVERED_APPROVAL_NOTIFICATIONS = 512;
const APPROVAL_NOTIFICATION_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type PendingApprovalNotificationDelivery = {
  key: string;
  adapter: DaemonAdapterKind;
  threadId: string;
  turnId?: string;
  requestId?: string;
  text: string;
  commandPreview?: string;
  createdAt: string;
};

export type DeliveredApprovalNotificationDelivery = {
  key: string;
  deliveredAt: string;
};

export type ApprovalNotificationDeliveryState = {
  pending: PendingApprovalNotificationDelivery[];
  delivered: DeliveredApprovalNotificationDelivery[];
};

export type ApprovalNotificationDeliveryQueueOptions = {
  initial?: ApprovalNotificationDeliveryState;
  now?: () => number;
  persist?: (state: ApprovalNotificationDeliveryState) => void;
};

export type ApprovalNotificationEnqueueResult = {
  status: "queued" | "pending" | "delivered";
  delivery?: PendingApprovalNotificationDelivery;
};

export type ApprovalNotificationDeliveryResult = {
  status: "missing" | "in_flight" | "pending" | "delivered";
  delivery?: PendingApprovalNotificationDelivery;
};

function clonePending(
  delivery: PendingApprovalNotificationDelivery,
): PendingApprovalNotificationDelivery {
  return { ...delivery };
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(Date.parse(value)).toISOString();
}

function normalizePending(
  value: unknown,
): PendingApprovalNotificationDelivery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.key !== "string" ||
    !record.key.trim() ||
    !isDaemonAdapterKind(record.adapter) ||
    typeof record.threadId !== "string" ||
    !record.threadId.trim() ||
    typeof record.text !== "string" ||
    !record.text.trim()
  ) {
    return null;
  }
  const createdAt = normalizeTimestamp(record.createdAt);
  if (!createdAt) {
    return null;
  }
  return {
    key: record.key.trim(),
    adapter: record.adapter,
    threadId: record.threadId.trim(),
    ...(typeof record.turnId === "string" && record.turnId.trim()
      ? { turnId: record.turnId.trim() }
      : {}),
    ...(typeof record.requestId === "string" && record.requestId.trim()
      ? { requestId: record.requestId.trim() }
      : {}),
    text: record.text,
    ...(typeof record.commandPreview === "string" && record.commandPreview.trim()
      ? { commandPreview: record.commandPreview }
      : {}),
    createdAt,
  };
}

function normalizeDelivered(
  value: unknown,
): DeliveredApprovalNotificationDelivery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string" || !record.key.trim()) {
    return null;
  }
  const deliveredAt = normalizeTimestamp(record.deliveredAt);
  return deliveredAt ? { key: record.key.trim(), deliveredAt } : null;
}

export function normalizeApprovalNotificationDeliveryState(
  value: unknown,
  nowMs = Date.now(),
): ApprovalNotificationDeliveryState {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const cutoff = nowMs - APPROVAL_NOTIFICATION_RETENTION_MS;
  const deliveredByKey = new Map<string, DeliveredApprovalNotificationDelivery>();
  for (const candidate of Array.isArray(record.delivered) ? record.delivered : []) {
    const delivery = normalizeDelivered(candidate);
    if (!delivery || Date.parse(delivery.deliveredAt) < cutoff) continue;
    const previous = deliveredByKey.get(delivery.key);
    if (!previous || Date.parse(previous.deliveredAt) < Date.parse(delivery.deliveredAt)) {
      deliveredByKey.set(delivery.key, delivery);
    }
  }
  const delivered = [...deliveredByKey.values()]
    .sort((left, right) => Date.parse(left.deliveredAt) - Date.parse(right.deliveredAt))
    .slice(-MAX_DELIVERED_APPROVAL_NOTIFICATIONS);
  const deliveredKeys = new Set(delivered.map((delivery) => delivery.key));

  const pendingByKey = new Map<string, PendingApprovalNotificationDelivery>();
  for (const candidate of Array.isArray(record.pending) ? record.pending : []) {
    const delivery = normalizePending(candidate);
    if (
      !delivery ||
      Date.parse(delivery.createdAt) < cutoff ||
      deliveredKeys.has(delivery.key)
    ) {
      continue;
    }
    const previous = pendingByKey.get(delivery.key);
    if (!previous || Date.parse(previous.createdAt) < Date.parse(delivery.createdAt)) {
      pendingByKey.set(delivery.key, delivery);
    }
  }
  const pending = [...pendingByKey.values()]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-MAX_PENDING_APPROVAL_NOTIFICATIONS);

  return {
    pending: pending.map(clonePending),
    delivered: delivered.map((delivery) => ({ ...delivery })),
  };
}

export class ApprovalNotificationDeliveryQueue {
  private readonly now: () => number;
  private readonly persist?: (state: ApprovalNotificationDeliveryState) => void;
  private readonly pending = new Map<string, PendingApprovalNotificationDelivery>();
  private readonly delivered = new Map<string, DeliveredApprovalNotificationDelivery>();
  private readonly inFlight = new Set<string>();

  constructor(options: ApprovalNotificationDeliveryQueueOptions = {}) {
    this.now = options.now ?? Date.now;
    this.persist = options.persist;
    const initial = normalizeApprovalNotificationDeliveryState(
      options.initial,
      this.now(),
    );
    for (const delivery of initial.pending) {
      this.pending.set(delivery.key, clonePending(delivery));
    }
    for (const delivery of initial.delivered) {
      this.delivered.set(delivery.key, { ...delivery });
    }
  }

  snapshot(): ApprovalNotificationDeliveryState {
    if (this.pruneExpired()) this.persistState();
    return this.snapshotWithoutPruning();
  }

  getPending(): PendingApprovalNotificationDelivery[] {
    if (this.pruneExpired()) this.persistState();
    return [...this.pending.values()].map(clonePending);
  }

  hasDelivered(key: string): boolean {
    if (this.pruneExpired()) this.persistState();
    return this.delivered.has(key);
  }

  enqueue(input: {
    key: string;
    adapter: DaemonAdapterKind;
    threadId: string;
    turnId?: string;
    requestId?: string;
    text: string;
    commandPreview?: string;
  }): ApprovalNotificationEnqueueResult {
    if (this.pruneExpired()) this.persistState();
    const key = input.key.trim();
    if (this.delivered.has(key)) return { status: "delivered" };
    const existing = this.pending.get(key);
    if (existing) return { status: "pending", delivery: clonePending(existing) };
    if (!key || !input.threadId.trim() || !input.text.trim()) {
      throw new Error("Approval notification delivery payload is invalid.");
    }
    const delivery: PendingApprovalNotificationDelivery = {
      key,
      adapter: input.adapter,
      threadId: input.threadId.trim(),
      ...(input.turnId?.trim() ? { turnId: input.turnId.trim() } : {}),
      ...(input.requestId?.trim() ? { requestId: input.requestId.trim() } : {}),
      text: input.text,
      ...(input.commandPreview?.trim()
        ? { commandPreview: input.commandPreview }
        : {}),
      createdAt: new Date(this.now()).toISOString(),
    };
    this.pending.set(key, delivery);
    this.trimPending();
    this.persistState();
    return { status: "queued", delivery: clonePending(delivery) };
  }

  reserveSummary(keys: string[]): boolean {
    if (keys.some((key) => !this.pending.has(key) || this.inFlight.has(key))) return false;
    for (const key of keys) this.inFlight.add(key);
    return true;
  }

  releaseSummary(keys: string[]): void {
    for (const key of keys) this.inFlight.delete(key);
  }

  async deliver(
    key: string,
    send: (delivery: PendingApprovalNotificationDelivery) => Promise<boolean>,
  ): Promise<ApprovalNotificationDeliveryResult> {
    if (this.pruneExpired()) this.persistState();
    if (this.delivered.has(key)) return { status: "delivered" };
    const delivery = this.pending.get(key);
    if (!delivery) return { status: "missing" };
    if (this.inFlight.has(key)) {
      return { status: "in_flight", delivery: clonePending(delivery) };
    }

    this.inFlight.add(key);
    try {
      if (!await send(clonePending(delivery))) {
        return { status: "pending", delivery: clonePending(delivery) };
      }
      this.pending.delete(key);
      this.delivered.delete(key);
      this.delivered.set(key, {
        key,
        deliveredAt: new Date(this.now()).toISOString(),
      });
      this.trimDelivered();
      this.persistState();
      return { status: "delivered", delivery: clonePending(delivery) };
    } finally {
      this.inFlight.delete(key);
    }
  }

  acknowledgeSummary(keys: string[]): void {
    for (const key of keys) {
      if (!this.pending.has(key) || this.inFlight.has(key)) continue;
      this.pending.delete(key);
      this.delivered.set(key, { key, deliveredAt: new Date(this.now()).toISOString() });
    }
    this.trimDelivered();
    this.persistState();
  }

  cancel(key: string): boolean {
    const removed = this.pending.delete(key);
    if (removed) this.persistState();
    return removed;
  }

  private snapshotWithoutPruning(): ApprovalNotificationDeliveryState {
    return {
      pending: [...this.pending.values()].map(clonePending),
      delivered: [...this.delivered.values()].map((delivery) => ({ ...delivery })),
    };
  }

  private trimPending(): void {
    while (this.pending.size > MAX_PENDING_APPROVAL_NOTIFICATIONS) {
      const oldestKey = this.pending.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.pending.delete(oldestKey);
    }
  }

  private trimDelivered(): void {
    this.pruneExpired();
    while (this.delivered.size > MAX_DELIVERED_APPROVAL_NOTIFICATIONS) {
      const oldestKey = this.delivered.keys().next().value;
      if (typeof oldestKey !== "string") break;
      this.delivered.delete(oldestKey);
    }
  }

  private persistState(): void {
    this.persist?.(this.snapshotWithoutPruning());
  }

  private pruneExpired(): boolean {
    const cutoff = this.now() - APPROVAL_NOTIFICATION_RETENTION_MS;
    let changed = false;
    for (const [key, delivery] of this.pending) {
      if (Date.parse(delivery.createdAt) < cutoff) {
        this.pending.delete(key);
        changed = true;
      }
    }
    for (const [key, delivery] of this.delivered) {
      if (Date.parse(delivery.deliveredAt) < cutoff) {
        this.delivered.delete(key);
        changed = true;
      }
    }
    return changed;
  }
}

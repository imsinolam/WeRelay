export type MobileLiveEvent =
  | {
      kind: "conversation";
      adapter: string;
      threadId: string;
      revision: string;
    }
  | {
      kind: "tasks";
      adapter: string;
    };

type TimerHandle = ReturnType<typeof setTimeout>;

export type MobileLiveEventHubOptions = {
  coalesceMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

type PendingEvent = {
  event: MobileLiveEvent;
  timer: TimerHandle;
};

const DEFAULT_COALESCE_MS = 150;
const IDENTITY_MAX_LENGTH = 200;
const REVISION_MAX_LENGTH = 80;
const ABSOLUTE_MAX_TIMER_DELAY_MS = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && Array.from(value).length <= maxLength;
}

export function isMobileLiveEvent(value: unknown): value is MobileLiveEvent {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "tasks") {
    return hasOnlyKeys(value, ["kind", "adapter"]) &&
      isBoundedString(value.adapter, IDENTITY_MAX_LENGTH);
  }
  if (value.kind === "conversation") {
    return hasOnlyKeys(value, ["kind", "adapter", "threadId", "revision"]) &&
      isBoundedString(value.adapter, IDENTITY_MAX_LENGTH) &&
      isBoundedString(value.threadId, IDENTITY_MAX_LENGTH) &&
      isBoundedString(value.revision, REVISION_MAX_LENGTH);
  }
  return false;
}

function eventKey(event: MobileLiveEvent): string {
  return event.kind === "conversation"
    ? JSON.stringify([event.kind, event.adapter, event.threadId])
    : JSON.stringify([event.kind, event.adapter]);
}

export class MobileLiveEventHub {
  private readonly coalesceMs: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly listeners = new Set<(event: MobileLiveEvent) => void>();
  private readonly pending = new Map<string, PendingEvent>();

  constructor(options: MobileLiveEventHubOptions = {}) {
    const configuredCoalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.coalesceMs = Number.isFinite(configuredCoalesceMs)
      ? Math.min(ABSOLUTE_MAX_TIMER_DELAY_MS, Math.max(0, configuredCoalesceMs))
      : DEFAULT_COALESCE_MS;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  publish(event: MobileLiveEvent): void {
    if (!isMobileLiveEvent(event)) {
      return;
    }
    const key = eventKey(event);
    const existing = this.pending.get(key);
    if (existing) {
      existing.event = event;
      return;
    }
    if (this.coalesceMs === 0) {
      this.emit(event);
      return;
    }
    const timer = this.setTimer(() => this.flush(key), this.coalesceMs);
    this.pending.set(key, { event, timer });
  }

  subscribe(listener: (event: MobileLiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private flush(key: string): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    this.emit(pending.event);
  }

  private emit(event: MobileLiveEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One live consumer cannot prevent delivery to the remaining clients.
      }
    }
  }
}

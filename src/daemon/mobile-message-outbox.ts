import fs from "node:fs";
import path from "node:path";

import type { BridgeMessageImage, BridgeSessionMessage } from "../bridge/bridge-types.ts";
import { ensureWorkspaceChannelDir, normalizeWorkspacePath } from "../wechat/channel-config.ts";
import { writePrivateFileAtomic } from "../utils/private-files.ts";

export type MobileMessageOutboxStatus =
  | "accepted"
  | "sending"
  | "retrying"
  | "queued"
  | "submitted"
  | "failed"
  | "delivered";

export type MobileMessageOutboxImage = {
  path: string;
  fileName: string;
  mimeType: string;
};

export type MobileMessageOutboxEntry = {
  clientId: string;
  adapter: string;
  threadId: string;
  originalThreadId?: string;
  createTaskSourceThreadId?: string;
  text: string;
  images: MobileMessageOutboxImage[];
  createdAtMs: number;
  sequence: number;
  status: MobileMessageOutboxStatus;
  attempts: number;
  nextAttemptAtMs: number;
  lastAttemptAtMs?: number;
  lastError?: string;
  turnId?: string;
  queuedMessageId?: string;
  queuePosition?: number;
  submittedAtMs?: number;
  deliveredAtMs?: number;
  failureNotifiedAt?: number;
};

export type MobileMessageOutboxAcceptInput = {
  clientId: string;
  adapter: string;
  threadId: string;
  originalThreadId?: string;
  createTaskSourceThreadId?: string;
  text: string;
  images: MobileMessageOutboxImage[];
  createdAtMs?: number;
};

type MobileMessageOutboxFile = {
  version: 1;
  cwd?: string;
  nextSequence: number;
  entries: MobileMessageOutboxEntry[];
};

type MobileMessageOutboxOptions = {
  cwd?: string;
  stateFile?: string;
  now?: () => number;
};

const MAX_OUTBOX_ENTRIES = 500;
const DELIVERED_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_ERROR_LENGTH = 800;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeOptionalText(value: unknown): string | undefined {
  const text = normalizeText(value).trim();
  return text || undefined;
}

function normalizeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeStatus(value: unknown): MobileMessageOutboxStatus | null {
  switch (value) {
    case "accepted":
    case "sending":
    case "retrying":
    case "queued":
    case "submitted":
    case "failed":
    case "delivered":
      return value;
    default:
      return null;
  }
}

function normalizeImage(value: unknown): MobileMessageOutboxImage | null {
  if (!isRecord(value) || typeof value.path !== "string" || !value.path.trim()) {
    return null;
  }
  return {
    path: value.path,
    fileName: normalizeText(value.fileName) || path.basename(value.path),
    mimeType: normalizeText(value.mimeType) || "application/octet-stream",
  };
}

function normalizeEntry(value: unknown): MobileMessageOutboxEntry | null {
  if (!isRecord(value)) return null;
  const clientId = normalizeOptionalText(value.clientId);
  const adapter = normalizeOptionalText(value.adapter);
  const threadId = normalizeOptionalText(value.threadId);
  const status = normalizeStatus(value.status);
  if (!clientId || !adapter || !threadId || !status) return null;
  const images = Array.isArray(value.images)
    ? value.images.map(normalizeImage).filter((image): image is MobileMessageOutboxImage => Boolean(image))
    : [];
  const restoredStatus = status === "sending" ? "retrying" : status;
  return {
    clientId,
    adapter,
    threadId,
    ...(normalizeOptionalText(value.originalThreadId)
      ? { originalThreadId: normalizeOptionalText(value.originalThreadId) }
      : {}),
    ...(normalizeOptionalText(value.createTaskSourceThreadId)
      ? { createTaskSourceThreadId: normalizeOptionalText(value.createTaskSourceThreadId) }
      : {}),
    text: normalizeText(value.text),
    images,
    createdAtMs: Math.max(0, normalizeNumber(value.createdAtMs, Date.now())),
    sequence: Math.max(1, Math.floor(normalizeNumber(value.sequence, 1))),
    status: restoredStatus,
    attempts: Math.max(0, Math.floor(normalizeNumber(value.attempts, 0))),
    nextAttemptAtMs: restoredStatus === "retrying"
      ? 0
      : Math.max(0, normalizeNumber(value.nextAttemptAtMs, 0)),
    ...(normalizeNumber(value.lastAttemptAtMs) > 0
      ? { lastAttemptAtMs: normalizeNumber(value.lastAttemptAtMs) }
      : {}),
    ...(normalizeOptionalText(value.lastError)
      ? { lastError: normalizeOptionalText(value.lastError) }
      : {}),
    ...(normalizeOptionalText(value.turnId) ? { turnId: normalizeOptionalText(value.turnId) } : {}),
    ...(normalizeOptionalText(value.queuedMessageId)
      ? { queuedMessageId: normalizeOptionalText(value.queuedMessageId) }
      : {}),
    ...(normalizeNumber(value.queuePosition) > 0
      ? { queuePosition: Math.floor(normalizeNumber(value.queuePosition)) }
      : {}),
    ...(normalizeNumber(value.submittedAtMs) > 0
      ? { submittedAtMs: normalizeNumber(value.submittedAtMs) }
      : {}),
    ...(normalizeNumber(value.deliveredAtMs) > 0
      ? { deliveredAtMs: normalizeNumber(value.deliveredAtMs) }
      : {}),
    ...(normalizeNumber(value.failureNotifiedAt) > 0
      ? { failureNotifiedAt: normalizeNumber(value.failureNotifiedAt) }
      : {}),
  };
}

function cloneEntry(entry: MobileMessageOutboxEntry): MobileMessageOutboxEntry {
  return {
    ...entry,
    images: entry.images.map((image) => ({ ...image })),
  };
}

function entryMatchesThread(entry: MobileMessageOutboxEntry, threadId: string): boolean {
  return entry.threadId === threadId || entry.originalThreadId === threadId;
}

function normalizedMessageText(text: string): string {
  return text.split("\n").filter((line) => line.trim().toLowerCase() !== "[image]").join("\n").trim();
}

function messageOccurredAtMs(message: BridgeSessionMessage): number | null {
  if (typeof message.createdAtMs === "number" && Number.isFinite(message.createdAtMs)) {
    return message.createdAtMs;
  }
  return null;
}

function messageMatchesEntry(message: BridgeSessionMessage, entry: MobileMessageOutboxEntry): boolean {
  if (entry.turnId && message.turnId === entry.turnId) return true;
  if (entry.status !== "submitted" && entry.status !== "queued") return false;
  if (normalizedMessageText(message.text ?? "") !== normalizedMessageText(entry.text)) {
    return false;
  }
  const messageAtMs = messageOccurredAtMs(message);
  if (messageAtMs !== null && entry.lastAttemptAtMs !== undefined) {
    return messageAtMs >= entry.lastAttemptAtMs - 1_000;
  }
  return true;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function computeMobileMessageRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * (2 ** Math.max(0, Math.floor(attempt) - 1)));
}

export function formatMobileMessageFailureNotice(params: {
  title: string;
  text: string;
  error: string;
  url?: string;
}): string {
  const title = params.title.trim() || "网页任务";
  const text = params.text.trim() || "（图片消息）";
  const error = params.error.trim() || "电脑端暂时无法接收消息";
  return [
    `[${truncate(title, 55)}] 网页消息多次提交仍失败`,
    "消息已保留在网页任务台，可复制后重试。",
    `内容：${truncate(text.replace(/\s+/g, " "), 180)}`,
    `原因：${truncate(error.replace(/\s+/g, " "), 180)}`,
    params.url ? `打开任务：${params.url}` : undefined,
  ].filter(Boolean).join("\n");
}

export function mobileMessageOutboxEntryToUserMessage(
  entry: MobileMessageOutboxEntry,
): BridgeSessionMessage & {
  clientId: string;
  pending: true;
  status: MobileMessageOutboxStatus;
  attempts: number;
  lastError?: string;
  queuedMessageId?: string;
} {
  const images: BridgeMessageImage[] = entry.images.map((image) => ({
    source: "local",
    path: image.path,
    alt: image.fileName,
  }));
  return {
    id: `mobile-outbox:${entry.adapter}:${entry.clientId}`,
    role: "user",
    text: entry.text,
    createdAtMs: entry.createdAtMs,
    clientId: entry.clientId,
    pending: true,
    status: entry.status,
    attempts: entry.attempts,
    ...(entry.turnId ? { turnId: entry.turnId } : {}),
    ...(entry.lastError ? { lastError: entry.lastError } : {}),
    ...(entry.queuedMessageId ? { queuedMessageId: entry.queuedMessageId } : {}),
    ...(images.length ? { images } : {}),
  };
}

export class MobileMessageOutbox {
  private readonly stateFile: string;
  private readonly cwd?: string;
  private readonly now: () => number;
  private entries: MobileMessageOutboxEntry[] = [];
  private nextSequence = 1;

  constructor(options: MobileMessageOutboxOptions) {
    this.cwd = options.cwd ? normalizeWorkspacePath(options.cwd) : undefined;
    this.stateFile = options.stateFile ?? path.join(
      ensureWorkspaceChannelDir(options.cwd ?? process.cwd()).workspaceDir,
      "mobile-message-outbox.json",
    );
    this.now = options.now ?? Date.now;
    this.load();
  }

  accept(input: MobileMessageOutboxAcceptInput): {
    entry: MobileMessageOutboxEntry;
    duplicate: boolean;
  } {
    const adapter = input.adapter.trim();
    const threadId = input.threadId.trim();
    const clientId = input.clientId.trim();
    const existing = this.findMutable(adapter, threadId, clientId);
    if (existing) {
      return { entry: cloneEntry(existing), duplicate: true };
    }
    const entry: MobileMessageOutboxEntry = {
      clientId,
      adapter,
      threadId,
      ...(input.originalThreadId?.trim() && input.originalThreadId.trim() !== threadId
        ? { originalThreadId: input.originalThreadId.trim() }
        : {}),
      ...(input.createTaskSourceThreadId?.trim()
        ? { createTaskSourceThreadId: input.createTaskSourceThreadId.trim() }
        : {}),
      text: input.text,
      images: input.images.map((image) => ({ ...image })),
      createdAtMs: input.createdAtMs ?? this.now(),
      sequence: this.nextSequence++,
      status: "accepted",
      attempts: 0,
      nextAttemptAtMs: 0,
    };
    this.entries.push(entry);
    this.prune(false);
    this.persist();
    return { entry: cloneEntry(entry), duplicate: false };
  }

  get(adapter: string, threadId: string, clientId: string): MobileMessageOutboxEntry | null {
    const entry = this.findMutable(adapter, threadId, clientId);
    return entry ? cloneEntry(entry) : null;
  }

  list(adapter: string, threadId: string): MobileMessageOutboxEntry[] {
    return this.entries
      .filter((entry) => entry.adapter === adapter && entryMatchesThread(entry, threadId))
      .filter((entry) => entry.status !== "delivered")
      .sort((left, right) => left.sequence - right.sequence)
      .map(cloneEntry);
  }

  readyEntries(nowMs = this.now()): MobileMessageOutboxEntry[] {
    const firstDispatchableByTask = new Map<string, MobileMessageOutboxEntry>();
    for (const entry of [...this.entries].sort((left, right) => left.sequence - right.sequence)) {
      if (entry.status !== "accepted" && entry.status !== "retrying") continue;
      const taskKey = `${entry.adapter}\0${entry.threadId}`;
      if (!firstDispatchableByTask.has(taskKey)) {
        firstDispatchableByTask.set(taskKey, entry);
      }
    }
    return [...firstDispatchableByTask.values()]
      .filter((entry) => entry.nextAttemptAtMs <= nowMs)
      .sort((left, right) => left.sequence - right.sequence)
      .map(cloneEntry);
  }

  nextAttemptAtMs(): number | null {
    const pending = this.entries.filter((entry) => (
      entry.status === "accepted" || entry.status === "retrying"
    ));
    if (!pending.length) return null;
    return Math.min(...pending.map((entry) => entry.nextAttemptAtMs));
  }

  markSending(adapter: string, threadId: string, clientId: string, attemptedAtMs = this.now()): boolean {
    return this.update(adapter, threadId, clientId, (entry) => {
      entry.status = "sending";
      entry.attempts += 1;
      entry.lastAttemptAtMs = attemptedAtMs;
      entry.nextAttemptAtMs = 0;
      delete entry.lastError;
    });
  }

  markRetrying(
    adapter: string,
    threadId: string,
    clientId: string,
    params: { error: string; nextAttemptAtMs: number },
  ): boolean {
    return this.update(adapter, threadId, clientId, (entry) => {
      entry.status = "retrying";
      entry.lastError = truncate(params.error, MAX_ERROR_LENGTH);
      entry.nextAttemptAtMs = params.nextAttemptAtMs;
    });
  }

  markQueued(
    adapter: string,
    threadId: string,
    clientId: string,
    params: {
      queuedMessageId?: string;
      queuePosition?: number;
      turnId?: string;
      submittedAtMs?: number;
    },
  ): boolean {
    return this.update(adapter, threadId, clientId, (entry) => {
      entry.status = "queued";
      entry.submittedAtMs = params.submittedAtMs ?? this.now();
      entry.nextAttemptAtMs = 0;
      delete entry.lastError;
      if (params.queuedMessageId) entry.queuedMessageId = params.queuedMessageId;
      if (params.queuePosition) entry.queuePosition = params.queuePosition;
      if (params.turnId) entry.turnId = params.turnId;
    });
  }

  markSubmitted(
    adapter: string,
    threadId: string,
    clientId: string,
    params: { turnId?: string; submittedAtMs?: number },
  ): boolean {
    return this.update(adapter, threadId, clientId, (entry) => {
      entry.status = "submitted";
      entry.submittedAtMs = params.submittedAtMs ?? this.now();
      entry.nextAttemptAtMs = 0;
      delete entry.lastError;
      if (params.turnId) entry.turnId = params.turnId;
    });
  }

  markFailed(
    adapter: string,
    threadId: string,
    clientId: string,
    error: string,
  ): boolean {
    return this.update(adapter, threadId, clientId, (entry) => {
      entry.status = "failed";
      entry.lastError = truncate(error, MAX_ERROR_LENGTH);
      entry.nextAttemptAtMs = 0;
      delete entry.failureNotifiedAt;
    });
  }

  markFailureNotified(
    adapter: string,
    threadId: string,
    clientId: string,
    notifiedAtMs = this.now(),
  ): boolean {
    return this.update(adapter, threadId, clientId, (entry) => {
      entry.failureNotifiedAt = notifiedAtMs;
    });
  }

  pendingFailureNotifications(): MobileMessageOutboxEntry[] {
    return this.entries
      .filter((entry) => entry.status === "failed" && !entry.failureNotifiedAt)
      .sort((left, right) => left.sequence - right.sequence)
      .map(cloneEntry);
  }

  retry(adapter: string, threadId: string, clientId: string, nowMs = this.now()): boolean {
    return this.update(adapter, threadId, clientId, (entry) => {
      entry.status = "accepted";
      entry.attempts = 0;
      entry.nextAttemptAtMs = nowMs;
      delete entry.lastAttemptAtMs;
      delete entry.lastError;
      delete entry.failureNotifiedAt;
      delete entry.turnId;
      delete entry.queuedMessageId;
      delete entry.queuePosition;
      delete entry.submittedAtMs;
    });
  }

  resolveThread(
    adapter: string,
    threadId: string,
    clientId: string,
    resolvedThreadId: string,
  ): boolean {
    const normalized = resolvedThreadId.trim();
    const target = this.findMutable(adapter, threadId, clientId);
    if (!normalized || !target) return false;
    const originalThreadId = target.originalThreadId ?? target.threadId;
    let changed = false;
    for (const entry of this.entries) {
      if (entry.adapter !== adapter || !entryMatchesThread(entry, originalThreadId)) continue;
      if (entry.threadId !== normalized) {
        entry.originalThreadId = entry.originalThreadId ?? originalThreadId;
        entry.threadId = normalized;
        changed = true;
      }
      if (entry.createTaskSourceThreadId !== undefined) {
        delete entry.createTaskSourceThreadId;
        changed = true;
      }
    }
    if (changed) this.persist();
    return true;
  }

  resolveRequestedThread(adapter: string, threadId: string): string | null {
    const resolved = this.entries.find((entry) => (
      entry.adapter === adapter && entry.originalThreadId === threadId && entry.threadId !== threadId
    ));
    return resolved?.threadId ?? null;
  }

  reconcile(
    adapter: string,
    threadId: string,
    params: {
      messages: BridgeSessionMessage[];
      queuedMessages: Array<{ id: string; text: string; imageCount: number }>;
      nowMs?: number;
    },
  ): void {
    const relevant = this.entries
      .filter((entry) => entry.adapter === adapter && entryMatchesThread(entry, threadId))
      .filter((entry) => entry.status === "submitted" || entry.status === "queued")
      .sort((left, right) => left.sequence - right.sequence);
    if (!relevant.length) return;
    const usedMessageIndexes = new Set<number>();
    let changed = false;
    for (const entry of relevant) {
      if (
        entry.status === "queued" &&
        entry.queuedMessageId &&
        params.queuedMessages.some((message) => message.id === entry.queuedMessageId)
      ) {
        continue;
      }
      const messageIndex = params.messages.findIndex((message, index) => (
        !usedMessageIndexes.has(index) &&
        message.role === "user" &&
        messageMatchesEntry(message, entry)
      ));
      if (messageIndex < 0) continue;
      usedMessageIndexes.add(messageIndex);
      entry.status = "delivered";
      entry.deliveredAtMs = params.nowMs ?? this.now();
      changed = true;
    }
    if (changed) this.persist();
  }

  private findMutable(
    adapter: string,
    threadId: string,
    clientId: string,
  ): MobileMessageOutboxEntry | undefined {
    return this.entries.find((entry) => (
      entry.adapter === adapter &&
      entry.clientId === clientId &&
      entryMatchesThread(entry, threadId)
    ));
  }

  private update(
    adapter: string,
    threadId: string,
    clientId: string,
    mutate: (entry: MobileMessageOutboxEntry) => void,
  ): boolean {
    const entry = this.findMutable(adapter, threadId, clientId);
    if (!entry) return false;
    mutate(entry);
    this.persist();
    return true;
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as unknown;
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        return;
      }
      if (
        this.cwd &&
        typeof parsed.cwd === "string" &&
        normalizeWorkspacePath(parsed.cwd) !== this.cwd
      ) {
        return;
      }
      this.entries = parsed.entries
        .map(normalizeEntry)
        .filter((entry): entry is MobileMessageOutboxEntry => Boolean(entry));
      this.nextSequence = Math.max(
        Math.floor(normalizeNumber(parsed.nextSequence, 1)),
        ...this.entries.map((entry) => entry.sequence + 1),
        1,
      );
      this.prune(false);
      this.persist();
    } catch {
      this.entries = [];
      this.nextSequence = 1;
    }
  }

  private prune(persist = true): void {
    const cutoff = this.now() - DELIVERED_RETENTION_MS;
    const retained = this.entries
      .filter((entry) => entry.status !== "delivered" || (entry.deliveredAtMs ?? 0) >= cutoff)
      .sort((left, right) => left.sequence - right.sequence);
    const undelivered = retained.filter((entry) => entry.status !== "delivered");
    const delivered = retained.filter((entry) => entry.status === "delivered");
    const deliveredLimit = Math.max(0, MAX_OUTBOX_ENTRIES - undelivered.length);
    this.entries = undelivered.concat(
      deliveredLimit > 0 ? delivered.slice(-deliveredLimit) : [],
    ).sort((left, right) => left.sequence - right.sequence);
    if (persist) this.persist();
  }

  private persist(): void {
    if (this.entries.length === 0) {
      fs.rmSync(this.stateFile, { force: true });
      return;
    }
    const state: MobileMessageOutboxFile = {
      version: 1,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      nextSequence: this.nextSequence,
      entries: this.entries,
    };
    writePrivateFileAtomic(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
    });
  }
}

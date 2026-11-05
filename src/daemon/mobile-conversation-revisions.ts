import crypto from "node:crypto";

import { BoundedTtlMap } from "../utils/bounded-ttl-cache.ts";

const DEFAULT_MAX_SIZE = 2_048;
const DEFAULT_TTL_MS = 24 * 60 * 60_000;

type MobileConversationRevisionEntry = {
  sequence: number;
};

export type MobileConversationRevisionChange = {
  adapter: string;
  threadId: string;
  revision: string;
};

export class MobileConversationRevisionStore {
  private readonly epoch: string;
  private readonly entries: BoundedTtlMap<string, MobileConversationRevisionEntry>;
  private readonly listeners = new Set<(
    change: MobileConversationRevisionChange,
  ) => void>();

  constructor(options: {
    epoch?: string;
    maxSize?: number;
    ttlMs?: number;
    now?: () => number;
  } = {}) {
    this.epoch = options.epoch?.trim() || crypto.randomBytes(8).toString("hex");
    this.entries = new BoundedTtlMap({
      maxSize: options.maxSize ?? DEFAULT_MAX_SIZE,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      ...(options.now ? { now: options.now } : {}),
    });
  }

  get(adapter: string | undefined, threadId: string): string {
    const identity = this.identity(adapter, threadId);
    const entry = this.entries.get(identity) ?? { sequence: 0 };
    this.entries.set(identity, entry);
    return this.format(identity, entry.sequence);
  }

  touch(adapter: string | undefined, threadId: string): string {
    const normalizedAdapter = adapter?.trim() || "codex";
    const normalizedThreadId = threadId.trim();
    const identity = this.identity(normalizedAdapter, normalizedThreadId);
    const previous = this.entries.get(identity);
    const sequence = (previous?.sequence ?? 0) + 1;
    this.entries.set(identity, { sequence });
    const revision = this.format(identity, sequence);
    const change = {
      adapter: normalizedAdapter,
      threadId: normalizedThreadId,
      revision,
    };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A consumer must never be able to break revision publication.
      }
    }
    return revision;
  }

  onChange(listener: (change: MobileConversationRevisionChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private identity(adapter: string | undefined, threadId: string): string {
    return `${adapter?.trim() || "codex"}\0${threadId.trim()}`;
  }

  private format(identity: string, sequence: number): string {
    return crypto.createHash("sha256")
      .update(this.epoch)
      .update("\0")
      .update(identity)
      .update("\0")
      .update(String(sequence))
      .digest("hex")
      .slice(0, 16);
  }
}

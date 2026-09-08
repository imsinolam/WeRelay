import type { BridgeSessionMessage } from "../bridge/bridge-types.ts";
import type { MobileMessageOutboxEntry } from "./mobile-message-outbox.ts";

export type ReconciliationTask = { threadId: string; projectId?: string };

export function taskCanCoverFailedMessage(
  entry: MobileMessageOutboxEntry,
  candidate: ReconciliationTask,
  tasks: ReconciliationTask[],
): boolean {
  if (candidate.threadId === entry.threadId || candidate.threadId === entry.originalThreadId) return true;
  const source = tasks.find(task => task.threadId === entry.threadId) ??
    tasks.find(task => task.threadId === entry.createTaskSourceThreadId);
  // Names are not identities: two unrelated directories can have the same name.
  return Boolean(source?.projectId && source.projectId === candidate.projectId);
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n")
    .map(line => line.trim()).filter(line => line && line.toLowerCase() !== "[image]").join("\n");
}

function coversText(actual: string, expected: string, sameTask: boolean): boolean {
  const requested = normalize(expected);
  const executed = normalize(actual);
  if (!requested) return false;
  if (executed === requested) return sameTask || Array.from(requested).length >= 12;
  // Subset means the entire failed request appears as standalone lines in a
  // larger executed request, not that a few keywords or a task title overlap.
  if (Array.from(requested).length < 12) return false;
  return (`\n${executed}\n`).includes(`\n${requested}\n`);
}

export function findFailedMessageExecution(
  entry: MobileMessageOutboxEntry,
  threadId: string,
  messages: BridgeSessionMessage[],
): BridgeSessionMessage | undefined {
  if (entry.status !== "failed") return undefined;
  const sameTask = entry.threadId === threadId || entry.originalThreadId === threadId;
  return messages.find((message, index) => {
    if (message.role !== "user" || (message as BridgeSessionMessage & { pending?: boolean }).pending) return false;
    if (!coversText(message.text, entry.text, sameTask)) return false;
    // A failed receipt must not consume an old, deliberately repeated request.
    // Missing timestamps are accepted only with an exact native turn identity.
    const exactTurn = sameTask && Boolean(entry.turnId && entry.turnId === message.turnId);
    if (!exactTurn && (message.createdAtMs === undefined || message.createdAtMs < entry.createdAtMs - 1_000)) return false;
    if (entry.images.some(image => !message.images?.some(actual => actual.source === "local" && actual.path === image.path))) return false;
    for (const following of messages.slice(index + 1)) {
      if (following.role === "user") break;
      if (following.role === "assistant" && following.text.trim() &&
        (!message.turnId || following.turnId === message.turnId)) return true;
    }
    return false;
  });
}

async function boundedRead<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("reconciliation timeout")), 2_000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Background-only, bounded project scan. A slow agent must not block the transcript. */
export class FailedMobileMessageSweep {
  private readonly lastChecks = new Map<string, number>();
  private readonly offsets = new Map<string, number>();
  private readonly running = new Map<string, Promise<void>>();

  run(params: {
    adapter: string;
    outbox: import("./mobile-message-outbox.ts").MobileMessageOutbox;
    listTasks: () => Promise<ReconciliationTask[]>;
    readMessages: (threadId: string) => Promise<BridgeSessionMessage[]>;
    nowMs?: number;
  }): Promise<void> {
    const existing = this.running.get(params.adapter);
    if (existing) return existing;
    const now = params.nowMs ?? Date.now();
    if (now - (this.lastChecks.get(params.adapter) ?? -Infinity) < 60_000) return Promise.resolve();
    if (!params.outbox.failedEntries(params.adapter).length) return Promise.resolve();
    this.lastChecks.set(params.adapter, now);
    const scan = (async () => {
      try {
        const tasks = await boundedRead(params.listTasks);
        const failed = params.outbox.failedEntries(params.adapter);
        const candidates = tasks.filter(task => failed.some(entry => taskCanCoverFailedMessage(entry, task, tasks)));
        // Include the original task even when it fell off the recent-task list.
        for (const entry of failed) {
          if (!entry.threadId.startsWith("local-new-") && !candidates.some(task => task.threadId === entry.threadId)) {
            candidates.push({threadId: entry.threadId});
          }
        }
        const offset = this.offsets.get(params.adapter) ?? 0;
        const selected = Array.from({length: Math.min(8, candidates.length)}, (_, index) => candidates[(offset + index) % candidates.length]!);
        this.offsets.set(params.adapter, (offset + selected.length) % Math.max(1, candidates.length));
        // Read two at a time, at most eight recent pages per minute.
        for (let index = 0; index < selected.length; index += 2) {
          await Promise.all(selected.slice(index, index + 2).map(async task => {
            try {
              const messages = await boundedRead(() => params.readMessages(task.threadId));
              params.outbox.reconcileFailedExecution(params.adapter, task, tasks, messages);
            } catch { /* No reliable evidence: keep the failed request intact. */ }
          }));
        }
      } catch { /* Offline or no metadata: never discard a retained request. */ }
    })();
    this.running.set(params.adapter, scan);
    void scan.finally(() => { this.running.delete(params.adapter); });
    return scan;
  }
}

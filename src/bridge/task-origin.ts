import type { BridgeResumeSessionCandidate } from "./bridge-types.ts";

export type TaskOriginMetadata = Pick<BridgeResumeSessionCandidate, "source" | "parentThreadId">;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/** Normalize native, SQLite and rollout origin metadata without reading task content. */
export function readTaskOriginMetadata(value: unknown): TaskOriginMetadata {
  if (!record(value)) return {};
  let source: unknown = value.source;
  if (typeof source === "string" && source.trim().startsWith("{")) {
    try { source = JSON.parse(source); } catch { /* Unknown is not evidence of a child. */ }
  }
  const subagent = record(source) ? source.subagent : undefined;
  const spawn = record(subagent) && record(subagent.thread_spawn) ? subagent.thread_spawn : undefined;
  const parentThreadId = text(value.parentThreadId) ?? text(value.parent_thread_id) ?? text(spawn?.parent_thread_id);
  const sourceLabel = subagent || value.thread_source === "subagent"
    ? "subagent" : text(value.source) ?? text(value.thread_source);
  return {
    ...(sourceLabel ? { source: sourceLabel } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
  };
}

/** Task names (including “Guardian review”) alone never make a task internal. */
export function isInternalTask(value: unknown): boolean {
  const origin = readTaskOriginMetadata(value);
  return Boolean(origin.parentThreadId || origin.source === "subagent");
}

/** Origin is immutable; a lightweight refresh must not erase a known child identity. */
export function retainTaskOrigin<T extends TaskOriginMetadata>(candidate: T, previous?: TaskOriginMetadata): T {
  return isInternalTask(previous) ? { ...candidate, ...readTaskOriginMetadata(previous) } : candidate;
}

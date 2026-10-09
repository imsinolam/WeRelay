import { readCodexDesktopCompletionFromRolloutTail,
  readCodexStateDbSessionCatalogInProcess } from "../bridge/bridge-adapters.codex.ts";
import { listWorkBuddyDesktopSessions, readWorkBuddyDesktopCompletion } from "../bridge/bridge-adapters.workbuddy.ts";
import { CODEX_COMPLETION_DELIVERABLE_WINDOW_MS } from "./codex-completion-delivery.ts";
import type { DesktopCompletion } from "./passive-completion-monitor.ts";
import path from "node:path";
import { enrichBridgeSessionMessageImages } from "../bridge/bridge-message-images.ts";

/**
 * Worker-only history reader. No runtime creation, desktop IPC, session resume
 * or application launch is allowed here. File I/O must stay off the poll loop.
 */
export async function readDesktopCompletions(
  adapter: DesktopCompletion["adapter"], limit = 100, now = Date.now(),
): Promise<DesktopCompletion[]> {
  const completions: DesktopCompletion[] = [];
  const recent = (at?: number) => Number.isFinite(at) && at! <= now &&
    now - at! <= CODEX_COMPLETION_DELIVERABLE_WINDOW_MS;
  if (adapter === "codex") {
    const catalog = await readCodexStateDbSessionCatalogInProcess({ limit, inferRuntimeStatuses: false });
    for (const candidate of catalog?.candidates ?? []) {
      if (!recent(Date.parse(candidate.lastUpdatedAt ?? ""))) continue;
      const rollout = catalog?.rolloutPathByThreadId.get(candidate.sessionId);
      if (!rollout) continue;
      const evidence = readCodexDesktopCompletionFromRolloutTail(rollout, now);
      if (evidence && recent(evidence.summary.completedAtMs)) completions.push({
        adapter, candidate, ...evidence,
        finalMessage: enrichBridgeSessionMessageImages(evidence.finalMessage, { cwd: candidate.cwd }),
      });
    }
  } else {
    const sessions = await listWorkBuddyDesktopSessions(undefined, limit, { allowMissingDatabase: true });
    for (const row of sessions) {
      const updatedAt = row.lastActivityAt ?? row.updatedAt;
      if (row.status !== "completed" || !recent(updatedAt)) continue;
      const evidence = await readWorkBuddyDesktopCompletion(row.cwd, row.id, updatedAt);
      if (evidence && recent(evidence.summary.completedAtMs)) {
        completions.push({ adapter, candidate: {
          sessionId: row.id, title: row.customTitle || row.title || "WorkBuddy 任务", cwd: row.cwd,
          projectId: row.projectId ?? undefined, projectName: path.basename(row.cwd),
          lastUpdatedAt: new Date(updatedAt).toISOString(),
        }, ...evidence, finalMessage: enrichBridgeSessionMessageImages(evidence.finalMessage, { cwd: row.cwd }) });
      }
    }
  }
  return completions;
}

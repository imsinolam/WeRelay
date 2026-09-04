import { listClaudeStoredSessions } from "../bridge/bridge-adapters.claude.ts";
import { readCodexStateDbSessionCatalog } from "../bridge/bridge-adapters.codex.ts";
import { listCodeBuddySessions } from "../bridge/bridge-adapters.codebuddy.ts";
import { listDeepSeekHarnessSessions } from "../bridge/bridge-adapters.deepseek.ts";
import { listGrokStoredSessions } from "../bridge/bridge-adapters.grok.ts";
import { listOpenCodeStoredSessions } from "../bridge/bridge-adapters.opencode.ts";
import { listReasonixSessions } from "../bridge/bridge-adapters.reasonix.ts";
import { listWorkBuddyDesktopSessionCandidates } from "../bridge/bridge-adapters.workbuddy.ts";
import type { BridgeResumeSessionCandidate } from "../bridge/bridge-types.ts";
import type { DaemonAdapterKind } from "../bridge/bridge-providers.ts";

const DEEPSEEK_GLOBAL_CATALOG_TIMEOUT_MS = 2_000;

function markNotLoaded(
  candidates: BridgeResumeSessionCandidate[],
): BridgeResumeSessionCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    runtimeStatus: candidate.runtimeStatus ?? { type: "notLoaded" },
  }));
}

export function mergeSessionRuntimeSignals(
  candidates: BridgeResumeSessionCandidate[],
  signals: {
    pendingApprovalIds?: Iterable<string>;
    pendingUserInputIds?: Iterable<string>;
  } = {},
): BridgeResumeSessionCandidate[] {
  const pendingApprovalIds = new Set(signals.pendingApprovalIds ?? []);
  const pendingUserInputIds = new Set(signals.pendingUserInputIds ?? []);
  return candidates.map((candidate) => {
    const activeFlags = [
      ...(pendingApprovalIds.has(candidate.sessionId)
        ? ["waitingOnApproval" as const]
        : []),
      ...(pendingUserInputIds.has(candidate.sessionId)
        ? ["waitingOnUserInput" as const]
        : []),
    ];
    if (activeFlags.length > 0) {
      return {
        ...candidate,
        runtimeStatus: { type: "active", activeFlags },
      };
    }
    return candidate.runtimeStatus?.type === "active"
      ? candidate
      : { ...candidate, runtimeStatus: candidate.runtimeStatus ?? { type: "idle" } };
  });
}

export async function listLightweightAdapterSessions(
  adapter: DaemonAdapterKind,
  cwd: string,
  limit = 100,
  dependencies: {
    listDeepSeekSessions?: typeof listDeepSeekHarnessSessions;
  } = {},
): Promise<BridgeResumeSessionCandidate[]> {
  switch (adapter) {
    case "claude":
    case "tclaude":
      return markNotLoaded(listClaudeStoredSessions(adapter, limit).map(
        ({ transcriptPath: _transcriptPath, ...candidate }) => candidate,
      ));
    case "grok":
      return listGrokStoredSessions(limit);
    case "codebuddy":
      return markNotLoaded(await listCodeBuddySessions(cwd, limit));
    case "reasonix":
      return markNotLoaded(await listReasonixSessions(cwd, limit));
    case "workbuddy":
      return await listWorkBuddyDesktopSessionCandidates(limit);
    case "deepseek":
      return await (
        dependencies.listDeepSeekSessions ?? listDeepSeekHarnessSessions
      )(limit, undefined, {
        timeoutMs: DEEPSEEK_GLOBAL_CATALOG_TIMEOUT_MS,
      });
    case "opencode":
      return markNotLoaded(listOpenCodeStoredSessions(limit).map((session) => ({
        sessionId: session.id,
        threadId: session.id,
        title: session.title || `会话 ${session.id.slice(0, 8)}`,
        lastUpdatedAt: new Date(session.time.updated).toISOString(),
        cwd: session.directory,
      })));
    case "codex":
      return (await readCodexStateDbSessionCatalog({ limit }))?.candidates ?? [];
  }
}

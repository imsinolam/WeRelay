import type { listDeepSeekHarnessSessions } from "../bridge/bridge-adapters.deepseek.ts";
import type { readCodexStateDbSessionCatalog } from "../bridge/bridge-adapters.codex.ts";
import type { BridgeResumeSessionCandidate } from "../bridge/bridge-types.ts";
import type { DaemonAdapterKind } from "../bridge/bridge-providers.ts";
import { isGeneratedTaskTitle, latestUserMessageText, titleFromLatestMessage } from "../bridge/task-title-fallback.ts";

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
    activeSessionIds?: Iterable<string>;
  } = {},
): BridgeResumeSessionCandidate[] {
  const pendingApprovalIds = new Set(signals.pendingApprovalIds ?? []);
  const pendingUserInputIds = new Set(signals.pendingUserInputIds ?? []);
  const activeSessionIds = new Set(signals.activeSessionIds ?? []);
  return candidates.map((candidate) => {
    const activeFlags = [...new Set([
      ...(candidate.runtimeStatus?.type === "active" ? candidate.runtimeStatus.activeFlags ?? [] : []),
      ...(pendingApprovalIds.has(candidate.sessionId)
        ? ["waitingOnApproval" as const]
        : []),
      ...(pendingUserInputIds.has(candidate.sessionId)
        ? ["waitingOnUserInput" as const]
        : []),
    ])];
    if (activeFlags.length > 0 || activeSessionIds.has(candidate.sessionId)) {
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
    listCodexSessions?: typeof readCodexStateDbSessionCatalog;
    readCodexGlobalState?: () => unknown;
  } = {},
): Promise<BridgeResumeSessionCandidate[]> {
  switch (adapter) {
    case "claude":
    case "tclaude":
      return markNotLoaded((await import("../bridge/bridge-adapters.claude.ts")).listClaudeStoredSessions(adapter, limit).map(
        ({ transcriptPath: _transcriptPath, ...candidate }) => candidate,
      ));
    case "grok":
      // The global task board is polled by the mobile page and Relay. Keep
      // Grok's filesystem catalog off the daemon's synchronous event loop.
      return await (await import("../bridge/bridge-adapters.grok.ts")).listGrokStoredSessionsAsync(limit);
    case "codebuddy":
      return markNotLoaded(await (await import("../bridge/bridge-adapters.codebuddy.ts")).listCodeBuddySessions(cwd, limit));
    case "reasonix":
      return markNotLoaded(await (await import("../bridge/bridge-adapters.reasonix.ts")).listReasonixSessions(cwd, limit));
    case "pi":
      return await (await import("../bridge/pi-session-catalog.ts")).listPiSessions({ limit });
    case "workbuddy":
      return await (await import("../bridge/bridge-adapters.workbuddy.ts")).listWorkBuddyDesktopSessionCandidates(limit);
    case "deepseek":
      return await (
        dependencies.listDeepSeekSessions ?? (await import("../bridge/bridge-adapters.deepseek.ts")).listDeepSeekHarnessSessions
      )(limit, undefined, {
        timeoutMs: DEEPSEEK_GLOBAL_CATALOG_TIMEOUT_MS,
      });
    case "opencode": {
      const opencode = await import("../bridge/bridge-adapters.opencode.ts");
      return markNotLoaded(opencode.listOpenCodeStoredSessions(limit).map((session) => {
        const title = session.title || `会话 ${session.id.slice(0, 8)}`;
        const displayTitle = isGeneratedTaskTitle(title, session.id)
          ? titleFromLatestMessage(title, session.id, latestUserMessageText(
              opencode.readOpenCodeStoredSessionMessages(session.id),
            ))
          : title;
        return {
          sessionId: session.id,
          threadId: session.id,
          title: displayTitle,
          lastUpdatedAt: new Date(session.time.updated).toISOString(),
          cwd: session.directory,
        };
      }));
    }
    case "codex": {
      const codex = await import("../bridge/bridge-adapters.codex.ts");
      const candidates = (await (
        dependencies.listCodexSessions ?? codex.readCodexStateDbSessionCatalog
      )({ limit, inferRuntimeStatuses: true }))?.candidates ?? [];
      const canonicalProjectIds = new Map(
        candidates.filter((candidate) => candidate.projectId).map(
          (candidate) => [candidate.sessionId, candidate.projectId!],
        ),
      );
      const enriched = codex.applyCodexDesktopProjectMetadata(
        candidates,
        (dependencies.readCodexGlobalState ?? codex.readCodexDesktopProjectState)(),
      );
      for (const candidate of enriched) {
        if (!candidate.projectId) {
          const canonicalId = canonicalProjectIds.get(candidate.sessionId);
          if (canonicalId) candidate.projectId = canonicalId;
        }
      }
      return enriched;
    }
  }
}

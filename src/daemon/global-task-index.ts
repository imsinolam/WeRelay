import {
  DAEMON_PROVIDER_IDS,
  getBridgeProvider,
  type DaemonAdapterKind,
} from "../bridge/bridge-providers.ts";
import type { BridgeResumeSessionCandidate } from "../bridge/bridge-types.ts";

export type GlobalTaskCandidate = BridgeResumeSessionCandidate & {
  adapter: DaemonAdapterKind;
};

export type GlobalTaskSnapshot = {
  candidates: GlobalTaskCandidate[];
  numberByIdentity: Map<string, number>;
};

export type GlobalTaskPage = {
  candidates: GlobalTaskCandidate[];
  startIndex: number;
  pageSize: number;
  hasPrevious: boolean;
  hasMore: boolean;
};

function timestampMs(candidate: Pick<GlobalTaskCandidate, "lastUpdatedAt">): number {
  const parsed = Date.parse(candidate.lastUpdatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedSearchText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s_\-./\\]+/g, "");
}

function candidateSearchText(candidate: GlobalTaskCandidate): string {
  return normalizedSearchText([
    getBridgeProvider(candidate.adapter).label,
    candidate.adapter,
    candidate.title,
    candidate.projectName,
    candidate.projectId,
    candidate.cwd,
    candidate.sessionId,
  ].filter(Boolean).join(" "));
}

export function globalTaskIdentityKey(
  adapter: DaemonAdapterKind,
  sessionId: string,
): string {
  return `${adapter}\u0000${sessionId}`;
}

export function selectRunningGlobalTaskAdapters(params: {
  connectedAdapters: Iterable<DaemonAdapterKind>;
  openAdapters: Iterable<DaemonAdapterKind>;
}): DaemonAdapterKind[] {
  const running = new Set<DaemonAdapterKind>([
    ...params.connectedAdapters,
    ...params.openAdapters,
  ]);
  return DAEMON_PROVIDER_IDS.filter((adapter) => (
    running.has(adapter) && getBridgeProvider(adapter).capabilities.sessions
  ));
}

export function sortGlobalTaskCandidates(
  candidates: GlobalTaskCandidate[],
): GlobalTaskCandidate[] {
  return [...candidates].sort((left, right) => {
    const recency = timestampMs(right) - timestampMs(left);
    if (recency !== 0) return recency;
    const adapterOrder = left.adapter.localeCompare(right.adapter);
    if (adapterOrder !== 0) return adapterOrder;
    return left.sessionId.localeCompare(right.sessionId);
  });
}

export function buildGlobalTaskSnapshot(
  candidates: GlobalTaskCandidate[],
): GlobalTaskSnapshot {
  const unique = new Map<string, GlobalTaskCandidate>();
  for (const candidate of candidates) {
    const key = globalTaskIdentityKey(candidate.adapter, candidate.sessionId);
    const previous = unique.get(key);
    if (!previous || timestampMs(candidate) >= timestampMs(previous)) {
      unique.set(key, candidate);
    }
  }
  const ordered = sortGlobalTaskCandidates([...unique.values()]);
  return {
    candidates: ordered,
    numberByIdentity: new Map(
      ordered.map((candidate, index) => [
        globalTaskIdentityKey(candidate.adapter, candidate.sessionId),
        index + 1,
      ]),
    ),
  };
}

export function updateGlobalTaskSnapshot(params: {
  current?: GlobalTaskSnapshot | null;
  latestCandidates: GlobalTaskCandidate[];
  refresh: boolean;
}): GlobalTaskSnapshot {
  if (params.refresh || !params.current) {
    return buildGlobalTaskSnapshot(params.latestCandidates);
  }
  const latestByIdentity = new Map(
    params.latestCandidates.map((candidate) => [
      globalTaskIdentityKey(candidate.adapter, candidate.sessionId),
      candidate,
    ]),
  );
  const retained = params.current.candidates.map((candidate) => (
    latestByIdentity.get(globalTaskIdentityKey(candidate.adapter, candidate.sessionId)) ?? candidate
  ));
  const retainedKeys = new Set(
    retained.map((candidate) => globalTaskIdentityKey(candidate.adapter, candidate.sessionId)),
  );
  for (const candidate of params.latestCandidates) {
    const key = globalTaskIdentityKey(candidate.adapter, candidate.sessionId);
    if (!retainedKeys.has(key)) {
      retained.push(candidate);
      retainedKeys.add(key);
    }
  }
  return {
    candidates: retained,
    numberByIdentity: new Map(
      retained.map((candidate, index) => [
        globalTaskIdentityKey(candidate.adapter, candidate.sessionId),
        index + 1,
      ]),
    ),
  };
}

export function paginateGlobalTaskSnapshot(
  snapshot: GlobalTaskSnapshot,
  options: { startIndex: number; pageSize: number },
): GlobalTaskPage {
  const pageSize = Math.max(1, options.pageSize);
  const startIndex = Math.max(0, Math.min(options.startIndex, snapshot.candidates.length));
  return {
    candidates: snapshot.candidates.slice(startIndex, startIndex + pageSize),
    startIndex,
    pageSize,
    hasPrevious: startIndex > 0,
    hasMore: startIndex + pageSize < snapshot.candidates.length,
  };
}

export function resolveGlobalTaskCandidate(
  snapshot: GlobalTaskSnapshot,
  target: string,
): GlobalTaskCandidate | null {
  const normalized = target.trim();
  if (!normalized) return null;
  if (/^[1-9]\d*$/.test(normalized)) {
    const index = Number(normalized);
    return Number.isSafeInteger(index) ? snapshot.candidates[index - 1] ?? null : null;
  }
  const identityMatch = normalized.match(/^([a-z][a-z0-9_-]*)\s*[/:：]\s*(.+)$/i);
  if (identityMatch?.[1] && identityMatch[2]) {
    const adapter = identityMatch[1].toLowerCase();
    const sessionId = identityMatch[2].trim();
    const exactIdentity = snapshot.candidates.find(
      (candidate) => candidate.adapter === adapter && candidate.sessionId === sessionId,
    );
    if (exactIdentity) return exactIdentity;
  }
  const exactSessionMatches = snapshot.candidates.filter(
    (candidate) => candidate.sessionId === normalized,
  );
  if (exactSessionMatches.length === 1) return exactSessionMatches[0] ?? null;
  const exactTitleMatches = snapshot.candidates.filter(
    (candidate) => candidate.title.trim().toLocaleLowerCase() === normalized.toLocaleLowerCase(),
  );
  if (exactTitleMatches.length === 1) return exactTitleMatches[0] ?? null;
  const search = normalizedSearchText(normalized);
  const fuzzyMatches = snapshot.candidates.filter(
    (candidate) => candidateSearchText(candidate).includes(search),
  );
  return fuzzyMatches.length === 1 ? fuzzyMatches[0] ?? null : null;
}

export function searchGlobalTaskCandidates(
  snapshot: GlobalTaskSnapshot,
  target: string,
): GlobalTaskCandidate[] {
  const search = normalizedSearchText(target);
  if (!search) return [];
  return snapshot.candidates.filter((candidate) => candidateSearchText(candidate).includes(search));
}

export function resolveCompactGlobalTaskSearchTarget(
  text: string,
  snapshot: GlobalTaskSnapshot,
): string | null {
  const exactText = text.trim();
  if (
    !exactText.startsWith("任务") ||
    exactText === "任务" ||
    exactText === "任务列表"
  ) {
    return null;
  }
  const rawTarget = exactText.slice("任务".length);
  if (!rawTarget || /^[\s：:]/.test(rawTarget)) {
    return null;
  }
  const target = rawTarget.trim();
  if (!target) return null;
  return resolveGlobalTaskCandidate(snapshot, target) ||
      searchGlobalTaskCandidates(snapshot, target).length > 0
    ? target
    : null;
}

export function parseTaskTargetedMessageText(
  text: string,
): { taskNumber: string; text: string } | null {
  const match = text.trim().match(/^(?:任务\s*)?([1-9]\d*)\s*[：:]\s*([\s\S]*\S)$/);
  if (!match?.[1] || !match[2]) return null;
  return { taskNumber: match[1], text: match[2].trim() };
}

export function resolveGlobalTaskTargetedMessage(params: {
  text: string;
  snapshot: GlobalTaskSnapshot | null;
}): { candidate: GlobalTaskCandidate; text: string } | null {
  if (!params.snapshot) return null;
  const targeted = parseTaskTargetedMessageText(params.text);
  if (!targeted) return null;
  const candidate = resolveGlobalTaskCandidate(params.snapshot, targeted.taskNumber);
  return candidate ? { candidate, text: targeted.text } : null;
}

export function shouldShowGlobalTaskAdapterLabels(
  candidates: GlobalTaskCandidate[],
): boolean {
  if (candidates.length <= 1) return false;
  return new Set(candidates.map((candidate) => candidate.adapter)).size > 1;
}

function runtimeMarker(candidate: GlobalTaskCandidate): string {
  const status = candidate.runtimeStatus;
  if (status?.type === "active") {
    if (status.activeFlags.includes("waitingOnApproval")) return "　待审批";
    if (status.activeFlags.includes("waitingOnUserInput")) return "　待输入";
    return "　🟢";
  }
  return status?.type === "systemError" ? "　异常" : "";
}

export function formatGlobalTaskList(params: {
  snapshot: GlobalTaskSnapshot;
  startIndex: number;
  pageSize: number;
}): string {
  const page = paginateGlobalTaskSnapshot(params.snapshot, params);
  if (page.candidates.length === 0) {
    return page.hasPrevious
      ? "没有更多任务。\n发送“上一页”返回。"
      : "没有找到正在运行终端的可继续任务。";
  }
  const actions = [
    "回复序号进入任务",
    "发送“数字：内容”或“任务数字：内容”（如：任务6：继续处理）可直接发给指定任务",
    "发送“任务：关键词”搜索运行中的终端",
    "发送“任务”刷新运行终端列表",
  ];
  if (page.hasMore) actions.push("发送“下一页”查看更多，可用“下一页20”指定条数");
  if (page.hasPrevious) actions.push("发送“上一页”返回");
  const showAdapterLabels = shouldShowGlobalTaskAdapterLabels(page.candidates);
  return [
    "运行终端最近任务",
    "全部按最近更新时间排序。",
    ...page.candidates.map((candidate, index) => {
      const adapterLabel = showAdapterLabels
        ? `[${getBridgeProvider(candidate.adapter).label}] `
        : "";
      return `${page.startIndex + index + 1}. ${adapterLabel}${candidate.title}${runtimeMarker(candidate)}`;
    }),
    ...actions,
    "序号在再次发送“任务”前保持不变。",
  ].join("\n");
}

export function formatGlobalTaskSearchResults(params: {
  snapshot: GlobalTaskSnapshot;
  matches: GlobalTaskCandidate[];
  target: string;
}): string {
  const showAdapterLabels = shouldShowGlobalTaskAdapterLabels(params.matches);
  return [
    `匹配任务：${params.target}`,
    ...params.matches.map((candidate) => {
      const number = params.snapshot.numberByIdentity.get(
        globalTaskIdentityKey(candidate.adapter, candidate.sessionId),
      );
      const adapterLabel = showAdapterLabels
        ? `[${getBridgeProvider(candidate.adapter).label}] `
        : "";
      return `${number ?? "?"}. ${adapterLabel}${candidate.title}${runtimeMarker(candidate)}`;
    }),
    "回复序号进入任务，或补充关键词缩小范围。",
  ].join("\n");
}

export async function activateGlobalTaskCandidate<T>(
  candidate: GlobalTaskCandidate,
  operations: {
    getConnectedAdapter(adapter: DaemonAdapterKind): T | null;
    connectAdapter(adapter: DaemonAdapterKind): Promise<T>;
    resumeSession(connected: T, sessionId: string): Promise<void>;
  },
): Promise<T> {
  let connected = operations.getConnectedAdapter(candidate.adapter);
  if (!connected) {
    try {
      connected = await operations.connectAdapter(candidate.adapter);
    } catch (error) {
      throw new Error(
        `无法连接 ${getBridgeProvider(candidate.adapter).label}，未切换任务，也没有新建替代任务。${error instanceof Error && error.message ? ` 原因：${error.message}` : ""}`,
        { cause: error },
      );
    }
  }
  try {
    await operations.resumeSession(connected, candidate.sessionId);
  } catch (error) {
    throw new Error(
      `无法恢复 ${getBridgeProvider(candidate.adapter).label} 原任务“${candidate.title}”，未切换到其他任务，也没有新建替代任务。${error instanceof Error && error.message ? ` 原因：${error.message}` : ""}`,
      { cause: error },
    );
  }
  return connected;
}

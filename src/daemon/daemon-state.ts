import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ensureWorkspaceChannelDir,
  normalizeWorkspacePath,
} from "../wechat/channel-config.ts";
import type { DaemonAdapterKind } from "./daemon-link.ts";
import { isDaemonAdapterKind } from "../bridge/bridge-providers.ts";
import { writePrivateFileAtomic } from "../utils/private-files.ts";
import {
  normalizeCodexCompletionDeliveryState,
  type CodexCompletionDeliveryState,
} from "./codex-completion-delivery.ts";
import {
  normalizeApprovalNotificationDeliveryState,
  type ApprovalNotificationDeliveryState,
} from "./approval-notification-delivery.ts";

export type CodexWechatReplyMode = "preview" | "full";

export type DaemonWechatTaskTarget = {
  adapter: DaemonAdapterKind;
  sessionId: string;
  title: string;
  lastUpdatedAt: string;
};

export type DaemonRecentTaskCompletion = {
  adapter: DaemonAdapterKind;
  threadId: string;
  title: string;
  completedAt: string;
  turnId?: string;
};

const MAX_RECENT_TASK_COMPLETIONS = 80;

export type DaemonMobileApprovalResultAction =
  | "confirm"
  | "confirm_session"
  | "confirm_task"
  | "deny";

export type DaemonMobileApprovalResult = {
  id: string;
  adapter: DaemonAdapterKind;
  threadId: string;
  turnId?: string;
  action: DaemonMobileApprovalResultAction;
  summary: string;
  commandPreview: string;
  detailLabel?: string;
  detailPreview?: string;
  requestedAt?: string;
  resolvedAt: string;
};

const MAX_MOBILE_APPROVAL_RESULTS = 240;

export type DaemonTaskApprovalAutoApproveIdentity = {
  threadId?: string;
  turnId?: string;
};

export type DaemonTaskApprovalAutoApproveEntry =
  DaemonTaskApprovalAutoApproveIdentity & {
    adapter: DaemonAdapterKind;
  };

const MAX_TASK_APPROVAL_AUTO_APPROVALS = 80;

export type DaemonWorkspaceState = {
  version: 1;
  cwd: string;
  activeAdapter?: DaemonAdapterKind;
  adapterSessionIds?: Partial<Record<DaemonAdapterKind, string>>;
  latestWechatTaskTarget?: DaemonWechatTaskTarget;
  codexThreadId?: string;
  codexWechatThreadId?: string;
  mobileAccessToken?: string;
  codexWechatReplyMode?: CodexWechatReplyMode;
  restartNoticeSentAt?: string;
  recentTaskCompletions?: DaemonRecentTaskCompletion[];
  mobileApprovalResults?: DaemonMobileApprovalResult[];
  taskApprovalAutoApprovals?: DaemonTaskApprovalAutoApproveEntry[];
  codexCompletionDeliveries?: CodexCompletionDeliveryState;
  approvalNotificationDeliveries?: ApprovalNotificationDeliveryState;
  updatedAt: string;
};

type DaemonWorkspaceStateOptions = {
  stateFile?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCodexWechatReplyMode(value: unknown): value is CodexWechatReplyMode {
  return value === "preview" || value === "full";
}

function normalizeWechatTaskTarget(value: unknown): DaemonWechatTaskTarget | undefined {
  if (
    !isRecord(value) ||
    !isDaemonAdapterKind(value.adapter) ||
    typeof value.sessionId !== "string" ||
    !value.sessionId.trim() ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.lastUpdatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.lastUpdatedAt))
  ) {
    return undefined;
  }
  return {
    adapter: value.adapter,
    sessionId: value.sessionId.trim(),
    title: value.title.trim(),
    lastUpdatedAt: value.lastUpdatedAt.trim(),
  };
}

function isSameWorkspace(left: string, right: string): boolean {
  const normalizedLeft = normalizeWorkspacePath(left);
  const normalizedRight = normalizeWorkspacePath(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function normalizeRecentTaskCompletion(
  value: unknown,
): DaemonRecentTaskCompletion | null {
  if (
    !isRecord(value) ||
    !isDaemonAdapterKind(value.adapter) ||
    typeof value.threadId !== "string" ||
    !value.threadId.trim() ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.completedAt !== "string" ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    (
      value.turnId !== undefined &&
      (typeof value.turnId !== "string" || !value.turnId.trim())
    )
  ) {
    return null;
  }
  return {
    adapter: value.adapter,
    threadId: value.threadId.trim(),
    title: value.title.trim(),
    completedAt: value.completedAt.trim(),
    ...(typeof value.turnId === "string" ? { turnId: value.turnId.trim() } : {}),
  };
}

function normalizeRecentTaskCompletions(
  value: unknown,
): DaemonRecentTaskCompletion[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const newestByTask = new Map<string, DaemonRecentTaskCompletion>();
  for (const entry of value) {
    const completion = normalizeRecentTaskCompletion(entry);
    if (!completion) {
      continue;
    }
    const key = `${completion.adapter}\u0000${completion.threadId}`;
    const previous = newestByTask.get(key);
    if (
      !previous ||
      Date.parse(completion.completedAt) > Date.parse(previous.completedAt)
    ) {
      newestByTask.set(key, completion);
    }
  }
  const normalized = Array.from(newestByTask.values())
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))
    .slice(0, MAX_RECENT_TASK_COMPLETIONS);
  return normalized.length > 0 ? normalized : undefined;
}

function isDaemonMobileApprovalResultAction(
  value: unknown,
): value is DaemonMobileApprovalResultAction {
  return value === "confirm" ||
    value === "confirm_session" ||
    value === "confirm_task" ||
    value === "deny";
}

function normalizeMobileApprovalResult(
  value: unknown,
): DaemonMobileApprovalResult | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    !isDaemonAdapterKind(value.adapter) ||
    typeof value.threadId !== "string" ||
    !value.threadId.trim() ||
    (
      value.turnId !== undefined &&
      (typeof value.turnId !== "string" || !value.turnId.trim())
    ) ||
    !isDaemonMobileApprovalResultAction(value.action) ||
    typeof value.summary !== "string" ||
    !value.summary.trim() ||
    typeof value.commandPreview !== "string" ||
    (
      value.detailLabel !== undefined &&
      (typeof value.detailLabel !== "string" || !value.detailLabel.trim())
    ) ||
    (
      value.detailPreview !== undefined &&
      (typeof value.detailPreview !== "string" || !value.detailPreview.trim())
    ) ||
    (
      value.requestedAt !== undefined &&
      (typeof value.requestedAt !== "string" || !Number.isFinite(Date.parse(value.requestedAt)))
    ) ||
    typeof value.resolvedAt !== "string" ||
    !Number.isFinite(Date.parse(value.resolvedAt))
  ) {
    return null;
  }
  return {
    id: value.id.trim(),
    adapter: value.adapter,
    threadId: value.threadId.trim(),
    ...(typeof value.turnId === "string" ? { turnId: value.turnId.trim() } : {}),
    action: value.action,
    summary: value.summary.trim(),
    commandPreview: value.commandPreview.trim(),
    ...(typeof value.detailLabel === "string"
      ? { detailLabel: value.detailLabel.trim() }
      : {}),
    ...(typeof value.detailPreview === "string"
      ? { detailPreview: value.detailPreview.trim() }
      : {}),
    ...(typeof value.requestedAt === "string"
      ? { requestedAt: value.requestedAt.trim() }
      : {}),
    resolvedAt: value.resolvedAt.trim(),
  };
}

function normalizeMobileApprovalResults(
  value: unknown,
): DaemonMobileApprovalResult[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const newestById = new Map<string, DaemonMobileApprovalResult>();
  for (const entry of value) {
    const result = normalizeMobileApprovalResult(entry);
    if (!result) {
      continue;
    }
    const previous = newestById.get(result.id);
    if (
      !previous ||
      Date.parse(result.resolvedAt) > Date.parse(previous.resolvedAt)
    ) {
      newestById.set(result.id, result);
    }
  }
  const normalized = Array.from(newestById.values())
    .sort((left, right) => Date.parse(right.resolvedAt) - Date.parse(left.resolvedAt))
    .slice(0, MAX_MOBILE_APPROVAL_RESULTS);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeTaskApprovalAutoApproveEntry(
  value: unknown,
): DaemonTaskApprovalAutoApproveEntry | null {
  if (!isRecord(value) || !isDaemonAdapterKind(value.adapter)) {
    return null;
  }
  const threadId = typeof value.threadId === "string"
    ? value.threadId.trim()
    : "";
  const turnId = typeof value.turnId === "string"
    ? value.turnId.trim()
    : "";
  if (!threadId && !turnId) {
    return null;
  }
  return threadId
    ? { adapter: value.adapter, threadId }
    : { adapter: value.adapter, turnId };
}

function taskApprovalAutoApproveEntryKey(
  entry: DaemonTaskApprovalAutoApproveEntry,
): string {
  return [entry.adapter, entry.threadId ?? "", entry.turnId ?? ""].join("\u0000");
}

function normalizeTaskApprovalAutoApproveEntries(
  value: unknown,
): DaemonTaskApprovalAutoApproveEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalizedByIdentity = new Map<string, DaemonTaskApprovalAutoApproveEntry>();
  for (const candidate of value) {
    const normalized = normalizeTaskApprovalAutoApproveEntry(candidate);
    if (!normalized) {
      continue;
    }
    normalizedByIdentity.set(taskApprovalAutoApproveEntryKey(normalized), normalized);
  }
  const normalized = Array.from(normalizedByIdentity.values())
    .slice(0, MAX_TASK_APPROVAL_AUTO_APPROVALS);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeDaemonWorkspaceState(
  value: unknown,
  cwd: string,
): DaemonWorkspaceState | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.cwd !== "string") {
    return null;
  }
  if (!isSameWorkspace(value.cwd, cwd)) {
    return null;
  }
  if (
    value.activeAdapter !== undefined &&
    !isDaemonAdapterKind(value.activeAdapter)
  ) {
    return null;
  }
  if (
    value.codexThreadId !== undefined &&
    (typeof value.codexThreadId !== "string" || !value.codexThreadId.trim())
  ) {
    return null;
  }
  if (
    value.codexWechatThreadId !== undefined &&
    (
      typeof value.codexWechatThreadId !== "string" ||
      !value.codexWechatThreadId.trim()
    )
  ) {
    return null;
  }
  let adapterSessionIds: Partial<Record<DaemonAdapterKind, string>> | undefined;
  if (value.adapterSessionIds !== undefined) {
    if (!isRecord(value.adapterSessionIds)) {
      return null;
    }
    adapterSessionIds = {};
    for (const [adapter, sessionId] of Object.entries(value.adapterSessionIds)) {
      if (!isDaemonAdapterKind(adapter) || typeof sessionId !== "string" || !sessionId.trim()) {
        return null;
      }
      adapterSessionIds[adapter] = sessionId.trim();
    }
  }
  if (
    value.mobileAccessToken !== undefined &&
    (typeof value.mobileAccessToken !== "string" || !value.mobileAccessToken.trim())
  ) {
    return null;
  }
  if (
    value.codexWechatReplyMode !== undefined &&
    !isCodexWechatReplyMode(value.codexWechatReplyMode)
  ) {
    return null;
  }
  if (
    value.restartNoticeSentAt !== undefined &&
    (
      typeof value.restartNoticeSentAt !== "string" ||
      !value.restartNoticeSentAt.trim() ||
      !Number.isFinite(Date.parse(value.restartNoticeSentAt))
    )
  ) {
    return null;
  }
  if (typeof value.updatedAt !== "string" || !value.updatedAt.trim()) {
    return null;
  }
  const recentTaskCompletions = normalizeRecentTaskCompletions(
    value.recentTaskCompletions,
  );
  const latestWechatTaskTarget = normalizeWechatTaskTarget(
    value.latestWechatTaskTarget,
  );
  const mobileApprovalResults = normalizeMobileApprovalResults(
    value.mobileApprovalResults,
  );
  const taskApprovalAutoApprovals = normalizeTaskApprovalAutoApproveEntries(
    value.taskApprovalAutoApprovals,
  );
  const codexCompletionDeliveries = value.codexCompletionDeliveries === undefined
    ? undefined
    : normalizeCodexCompletionDeliveryState(value.codexCompletionDeliveries);
  const approvalNotificationDeliveries = value.approvalNotificationDeliveries === undefined
    ? undefined
    : normalizeApprovalNotificationDeliveryState(value.approvalNotificationDeliveries);

  return {
    version: 1,
    cwd: normalizeWorkspacePath(cwd),
    activeAdapter: value.activeAdapter,
    adapterSessionIds,
    latestWechatTaskTarget,
    codexThreadId:
      typeof value.codexThreadId === "string"
        ? value.codexThreadId.trim()
        : undefined,
    codexWechatThreadId:
      typeof value.codexWechatThreadId === "string"
        ? value.codexWechatThreadId.trim()
        : undefined,
    mobileAccessToken:
      typeof value.mobileAccessToken === "string"
        ? value.mobileAccessToken.trim()
        : undefined,
    codexWechatReplyMode: value.codexWechatReplyMode,
    restartNoticeSentAt:
      typeof value.restartNoticeSentAt === "string"
        ? value.restartNoticeSentAt.trim()
        : undefined,
    recentTaskCompletions,
    mobileApprovalResults,
    taskApprovalAutoApprovals,
    codexCompletionDeliveries,
    approvalNotificationDeliveries,
    updatedAt: value.updatedAt,
  };
}

function resolveDaemonStateFile(
  cwd: string,
  options: DaemonWorkspaceStateOptions,
): string {
  return options.stateFile ?? ensureWorkspaceChannelDir(cwd).daemonStateFile;
}

export function readDaemonWorkspaceState(
  cwd: string,
  options: DaemonWorkspaceStateOptions = {},
): DaemonWorkspaceState | null {
  const stateFile = resolveDaemonStateFile(cwd, options);
  try {
    if (!fs.existsSync(stateFile)) {
      return null;
    }
    return normalizeDaemonWorkspaceState(
      JSON.parse(fs.readFileSync(stateFile, "utf8")),
      cwd,
    );
  } catch {
    return null;
  }
}

export class DaemonWorkspaceStateStore {
  readonly hadPersistedState: boolean;
  private readonly stateFile: string;
  private state: DaemonWorkspaceState;
  private readonly persistedState: DaemonWorkspaceState | null;

  constructor(
    cwd: string,
    options: DaemonWorkspaceStateOptions = {},
  ) {
    this.stateFile = resolveDaemonStateFile(cwd, options);
    this.persistedState = readDaemonWorkspaceState(cwd, {
      stateFile: this.stateFile,
    });
    this.hadPersistedState = Boolean(this.persistedState);
    this.state = this.persistedState ?? {
      version: 1,
      cwd: normalizeWorkspacePath(cwd),
      updatedAt: new Date(0).toISOString(),
    };
  }

  getPersistedState(): DaemonWorkspaceState | null {
    return this.persistedState ? { ...this.persistedState } : null;
  }

  getState(): DaemonWorkspaceState {
    return {
      ...this.state,
      ...(this.state.recentTaskCompletions
        ? { recentTaskCompletions: this.state.recentTaskCompletions.map((entry) => ({ ...entry })) }
        : {}),
      ...(this.state.latestWechatTaskTarget
        ? { latestWechatTaskTarget: { ...this.state.latestWechatTaskTarget } }
        : {}),
      ...(this.state.mobileApprovalResults
        ? { mobileApprovalResults: this.state.mobileApprovalResults.map((entry) => ({ ...entry })) }
        : {}),
      ...(this.state.taskApprovalAutoApprovals
        ? {
            taskApprovalAutoApprovals: this.state.taskApprovalAutoApprovals.map(
              (entry) => ({ ...entry }),
            ),
          }
        : {}),
      ...(this.state.codexCompletionDeliveries
        ? {
            codexCompletionDeliveries: {
              pending: this.state.codexCompletionDeliveries.pending.map((entry) => ({
                ...entry,
                texts: [...entry.texts],
              })),
              delivered: this.state.codexCompletionDeliveries.delivered.map((entry) => ({
                ...entry,
              })),
            },
          }
        : {}),
      ...(this.state.approvalNotificationDeliveries
        ? {
            approvalNotificationDeliveries: {
              pending: this.state.approvalNotificationDeliveries.pending.map(
                (entry) => ({ ...entry }),
              ),
              delivered: this.state.approvalNotificationDeliveries.delivered.map(
                (entry) => ({ ...entry }),
              ),
            },
          }
        : {}),
    };
  }

  getCodexCompletionDeliveryState(): CodexCompletionDeliveryState {
    return normalizeCodexCompletionDeliveryState(
      this.state.codexCompletionDeliveries,
    );
  }

  setCodexCompletionDeliveryState(state: CodexCompletionDeliveryState): void {
    this.state.codexCompletionDeliveries = normalizeCodexCompletionDeliveryState(state);
    this.persist();
  }

  getApprovalNotificationDeliveryState(): ApprovalNotificationDeliveryState {
    return normalizeApprovalNotificationDeliveryState(
      this.state.approvalNotificationDeliveries,
    );
  }

  setApprovalNotificationDeliveryState(
    state: ApprovalNotificationDeliveryState,
  ): void {
    this.state.approvalNotificationDeliveries =
      normalizeApprovalNotificationDeliveryState(state);
    this.persist();
  }

  setActiveAdapter(adapter: DaemonAdapterKind): void {
    if (this.state.activeAdapter === adapter) {
      return;
    }
    this.state.activeAdapter = adapter;
    this.persist();
  }

  getLatestWechatTaskTarget(): DaemonWechatTaskTarget | null {
    return this.state.latestWechatTaskTarget
      ? { ...this.state.latestWechatTaskTarget }
      : null;
  }

  setLatestWechatTaskTarget(target: DaemonWechatTaskTarget): void {
    const normalized = normalizeWechatTaskTarget(target);
    if (!normalized) {
      throw new Error("最近微信任务目标无效。");
    }
    const current = this.state.latestWechatTaskTarget;
    if (
      current?.adapter === normalized.adapter &&
      current.sessionId === normalized.sessionId &&
      current.title === normalized.title &&
      current.lastUpdatedAt === normalized.lastUpdatedAt
    ) {
      return;
    }
    this.state.latestWechatTaskTarget = normalized;
    this.persist();
  }

  getAdapterSessionId(adapter: DaemonAdapterKind): string | undefined {
    return this.state.adapterSessionIds?.[adapter] ?? (
      adapter === "codex" ? this.state.codexThreadId : undefined
    );
  }

  setAdapterSessionId(
    adapter: DaemonAdapterKind,
    sessionId: string | null | undefined,
  ): void {
    const normalizedSessionId = sessionId?.trim() || undefined;
    const next = { ...(this.state.adapterSessionIds ?? {}) };
    if (normalizedSessionId) {
      next[adapter] = normalizedSessionId;
    } else {
      delete next[adapter];
    }
    if (this.state.adapterSessionIds?.[adapter] === normalizedSessionId) {
      return;
    }
    this.state.adapterSessionIds = Object.keys(next).length > 0 ? next : undefined;
    if (adapter === "codex") {
      this.state.codexThreadId = normalizedSessionId;
    }
    this.persist();
  }

  setCodexWechatReplyMode(mode: CodexWechatReplyMode): void {
    if (this.state.codexWechatReplyMode === mode) {
      return;
    }
    this.state.codexWechatReplyMode = mode;
    this.persist();
  }

  setRestartNoticeSentAt(value: string): void {
    const normalized = value.trim();
    if (!normalized || !Number.isFinite(Date.parse(normalized))) {
      throw new Error("重启通知时间无效。");
    }
    if (this.state.restartNoticeSentAt === normalized) {
      return;
    }
    this.state.restartNoticeSentAt = normalized;
    this.persist();
  }

  getRecentTaskCompletions(): DaemonRecentTaskCompletion[] {
    return (this.state.recentTaskCompletions ?? []).map((entry) => ({ ...entry }));
  }

  recordRecentTaskCompletion(entry: DaemonRecentTaskCompletion): void {
    const normalized = normalizeRecentTaskCompletion(entry);
    if (!normalized) {
      throw new Error("最近完成任务记录无效。");
    }
    const taskKey = `${normalized.adapter}\u0000${normalized.threadId}`;
    this.state.recentTaskCompletions = [
      normalized,
      ...(this.state.recentTaskCompletions ?? []).filter(
        (candidate) => `${candidate.adapter}\u0000${candidate.threadId}` !== taskKey,
      ),
    ]
      .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))
      .slice(0, MAX_RECENT_TASK_COMPLETIONS);
    this.persist();
  }

  getTaskApprovalAutoApproveIdentities(
    adapter: DaemonAdapterKind,
  ): DaemonTaskApprovalAutoApproveIdentity[] {
    return (this.state.taskApprovalAutoApprovals ?? [])
      .filter((entry) => entry.adapter === adapter)
      .map((entry) => ({
        ...(entry.threadId ? { threadId: entry.threadId } : {}),
        ...(entry.turnId ? { turnId: entry.turnId } : {}),
      }));
  }

  setTaskApprovalAutoApproveIdentities(
    adapter: DaemonAdapterKind,
    identities: DaemonTaskApprovalAutoApproveIdentity[],
  ): void {
    const retained = (this.state.taskApprovalAutoApprovals ?? [])
      .filter((entry) => entry.adapter !== adapter);
    const nextForAdapter = normalizeTaskApprovalAutoApproveEntries(
      identities.map((identity) => ({ ...identity, adapter })),
    ) ?? [];
    const next = [...retained, ...nextForAdapter]
      .slice(0, MAX_TASK_APPROVAL_AUTO_APPROVALS);
    this.state.taskApprovalAutoApprovals = next.length > 0 ? next : undefined;
    this.persist();
  }

  getMobileApprovalResults(
    adapter: DaemonAdapterKind,
    threadId: string,
  ): DaemonMobileApprovalResult[] {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      return [];
    }
    return (this.state.mobileApprovalResults ?? [])
      .filter(
        (entry) =>
          entry.adapter === adapter && entry.threadId === normalizedThreadId,
      )
      .sort((left, right) => Date.parse(left.resolvedAt) - Date.parse(right.resolvedAt))
      .map((entry) => ({ ...entry }));
  }

  recordMobileApprovalResult(entry: DaemonMobileApprovalResult): void {
    const normalized = normalizeMobileApprovalResult(entry);
    if (!normalized) {
      throw new Error("网页审批结果记录无效。");
    }
    this.state.mobileApprovalResults = [
      normalized,
      ...(this.state.mobileApprovalResults ?? []).filter(
        (candidate) => candidate.id !== normalized.id,
      ),
    ]
      .sort((left, right) => Date.parse(right.resolvedAt) - Date.parse(left.resolvedAt))
      .slice(0, MAX_MOBILE_APPROVAL_RESULTS);
    this.persist();
  }

  setCodexThreadId(threadId: string | null | undefined): void {
    this.setAdapterSessionId("codex", threadId);
  }

  getCodexWechatThreadId(): string | undefined {
    return this.state.codexWechatThreadId ?? this.state.codexThreadId;
  }

  setCodexWechatThreadId(threadId: string | null | undefined): void {
    const normalizedThreadId = threadId?.trim() || undefined;
    if (this.state.codexWechatThreadId === normalizedThreadId) {
      return;
    }
    this.state.codexWechatThreadId = normalizedThreadId;
    this.persist();
  }

  ensureMobileAccessToken(
    generate: () => string = () => crypto.randomBytes(12).toString("base64url"),
  ): string {
    if (this.state.mobileAccessToken) {
      return this.state.mobileAccessToken;
    }
    const token = generate().trim();
    if (!token) {
      throw new Error("移动版访问密钥不能为空。");
    }
    this.state.mobileAccessToken = token;
    this.persist();
    return token;
  }

  private persist(): void {
    this.state.updatedAt = new Date().toISOString();
    writePrivateFileAtomic(this.stateFile, JSON.stringify(this.state, null, 2), {
      encoding: "utf8",
    });
  }
}

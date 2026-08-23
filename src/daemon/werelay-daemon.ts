#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  resolveDefaultAdapterCommand,
} from "../bridge/bridge-adapters.ts";
import { resolveCodexDesktopIpcSocketPath } from "../bridge/codex-desktop-ipc.ts";
import { t } from "../i18n/index.ts";
import {
  delay,
  getSharedSessionIdFromAdapterState,
  quoteWindowsCommandArg,
  type AdapterOptions,
} from "../bridge/bridge-adapters.shared.ts";
import { BridgeController } from "../bridge/bridge-controller.ts";
import { forwardWechatFinalReply } from "../bridge/bridge-final-reply.ts";
import {
  collectAssistantMessageImages,
  enrichBridgeSessionMessageImages,
  mergeBridgeMessageMedia,
} from "../bridge/bridge-message-images.ts";
import { CodexInboundTaskQueue } from "../bridge/codex-inbound-queue.ts";
import {
  readBridgeLockFile,
  type BridgeLockPayload,
} from "../bridge/bridge-state.ts";
import {
  type BridgeProcessRecord,
  getProcessRecordByPid,
  isWeRelayDaemonCommandLine,
  killProcessTreeSync,
  listWeRelayDaemonProcesses,
  reapOrphanedOpencodeProcesses,
  reapPeerBridgeProcesses,
} from "../bridge/bridge-process-reaper.ts";
import {
  DAEMON_PROVIDER_IDS,
  getBridgeProvider,
  isClaudeProviderKind,
  providerRequiresVisibleClient,
  providerUsesDesktopOwner,
  providerUsesHarnessHost,
  isDaemonAdapterKind,
  listDaemonProviders,
} from "../bridge/bridge-providers.ts";
import { ApprovalRuleChain } from "./approval-rules.ts";
import { AdapterUndoScope } from "./adapter-undo-scope.ts";
import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeEvent,
  BridgeResumeSessionCandidate,
  BridgeResumeSessionRuntimeStatus,
  BridgeMessageImage,
  BridgeSessionMessage,
  BridgeSessionMessagePageOptions,
  BridgeSessionModelState,
  BridgeSessionProgressItem,
  BridgeSessionRunSummary,
  BridgeSessionSendResult,
  BridgeSessionStartMode,
  BridgeTaskOutcome,
  BridgeWorkerStatus,
  PendingApproval,
  PendingUserInputRequest,
  UserInputRequest,
} from "../bridge/bridge-types.ts";
import {
  buildOneTimeCode,
  buildWechatInboundPrompt,
  CODEX_TASK_LIST_MAX_PAGE_SIZE,
  CODEX_TASK_LIST_PAGE_SIZE,
  type CodexTaskListPagePosition,
  formatApprovalMessage,
  formatDuration,
  formatCodexDesktopTaskLatestMessage,
  formatCodexDesktopTaskSelection,
  formatCodexWechatHelp,
  formatMirroredUserInputMessage,
  formatPendingApprovalReminder,
  formatPendingUserInputReminder,
  formatResumeSessionList,
  formatResumeSessionSearchResults,
  formatSessionSwitchMessage,
  formatTaskFailedMessage,
  formatTaskInterruptedMessage,
  formatUserInputRequestMessage,
  MESSAGE_START_GRACE_MS,
  normalizeOutput,
  nowIso,
  OutputBatcher,
  parsePendingUserInputAnswerCommand,
  parseWechatControlCommand,
  redactSensitiveCommandText,
  resolveBareCodexTaskSelection,
  resolveCompactCodexTaskSearchTarget,
  resolveCodexTaskListPageNavigation,
  resolveResumeSessionCandidate,
  searchResumeSessionCandidates,
  sanitizeCodexVisibleAssistantMessageForDisplay,
  sanitizeCodexVisibleUserMessageForDisplay,
  sanitizeWechatInboundPromptForDisplay,
  shouldNotifyTaskInterrupted,
  isStrictApprovalModeEnabled,
  splitWechatTextIntoChunks,
  truncatePreview,
} from "../bridge/bridge-utils.ts";
import {
  formatBridgeNoticeForWechat,
  formatCodexTaskAcceptedMessage,
  formatCodexTaskDuplicateMessage,
  formatCodexTaskQueuedMessage,
  formatUserFacingBridgeFatalError,
  formatUserFacingInboundError,
  formatWechatContextTokenStaleLogEntry,
  formatWechatSendFailureLogEntry,
  isRetryableWechatSendError,
  isRetryableDeferredCodexDrainError,
  shouldForwardBridgeEventToWechat,
} from "../bridge/werelay-bridge.ts";
import {
  BRIDGE_LOCK_FILE,
  BRIDGE_LOG_FILE,
  appendBoundedLog,
  ensureChannelDataDir,
  ensureWorkspaceChannelDir,
  migrateLegacyChannelFiles,
} from "../wechat/channel-config.ts";
import { OpenAgentLogHistoryProvider } from "../history/openagentlog-history.ts";
import {
  ensurePrivateDir,
  writePrivateFileAtomic,
} from "../utils/private-files.ts";
import {
  BoundedTtlMap,
  BoundedTtlSet,
} from "../utils/bounded-ttl-cache.ts";
import { ensureWechatCredentials } from "../wechat/setup.ts";
import { WechatImageDraftCollector } from "../wechat/wechat-image-draft.ts";
import {
  classifyWechatTransportError,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  describeWechatTransportError,
  isWechatContextTokenStaleError,
  WeChatTransport,
  type InboundWechatMessage,
} from "../wechat/wechat-transport.ts";
import {
  createRuntimeHost,
} from "../runtime/create-runtime-host.ts";
import {
  clearLocalCompanionEndpoint,
  clearLocalCompanionOccupancy,
  readLocalCompanionEndpoint,
} from "../companion/local-companion-link.ts";
import {
  attachDaemonRequestListener,
  buildDaemonToken,
  clearDaemonEndpoint,
  DAEMON_PROTOCOL_VERSION,
  isPidAlive,
  readDaemonEndpoint,
  sendDaemonRequest,
  sendDaemonResponse,
  writeDaemonEndpoint,
  type DaemonAdapterKind,
  type DaemonEndpoint,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonSlotSummary,
  type DaemonStatus,
} from "./daemon-link.ts";
import {
  CodexDeferredInputStore,
  type CodexDeferredInboundMessage,
} from "./codex-deferred-input-store.ts";
import {
  DaemonWorkspaceStateStore,
  type CodexWechatReplyMode,
  type DaemonRecentTaskCompletion,
  type DaemonWorkspaceState,
} from "./daemon-state.ts";
import {
  CodexCompletionDeliveryQueue,
  formatCodexCompletionBacklogSummary,
  selectCodexCompletionBacklogBatch,
  type CodexCompletionDeliveryResult,
} from "./codex-completion-delivery.ts";
import {
  ApprovalNotificationDeliveryQueue,
  type PendingApprovalNotificationDelivery,
} from "./approval-notification-delivery.ts";
import { CodexMobileAuthStore } from "./codex-mobile-auth.ts";
import { MobileMessageImageStore } from "./mobile-message-image-store.ts";
import {
  buildMobileProviderSettings,
  MobileProviderInstallManager,
} from "./mobile-provider-settings.ts";
import {
  MobileAdapterUnavailableError,
  startCodexMobileServer,
  type CodexMobileMessageInput,
  type CodexMobileApprovalAction,
  type CodexMobileApprovalResolution,
  type CodexMobileApprovalResult,
  type CodexMobileApprovalResultAction,
  type CodexMobilePendingApproval,
  type CodexMobileQueuedMessage,
  type CodexMobileServerHandle,
  type CodexMobileTask,
  type CodexMobileTaskBoard,
  type CodexMobileTaskStatus,
  type CodexMobileSettings,
} from "./codex-mobile-server.ts";
import {
  startWeRelayRelayClient,
  type WeRelayRelayClientHandle,
} from "../relay/relay-client.ts";
import { WeRelayRelayTaskLinkClient } from "../relay/relay-task-links.ts";
import {
  activateGlobalTaskCandidate,
  buildGlobalTaskSnapshot,
  formatGlobalTaskList,
  formatGlobalTaskSearchResults,
  resolveCompactGlobalTaskSearchTarget,
  resolveGlobalTaskCandidate,
  resolveGlobalTaskTargetedMessage,
  searchGlobalTaskCandidates,
  selectRunningGlobalTaskAdapters,
  updateGlobalTaskSnapshot,
  type GlobalTaskCandidate,
  type GlobalTaskSnapshot,
} from "./global-task-index.ts";
import {
  listLightweightAdapterSessions,
  mergeSessionRuntimeSignals,
} from "./global-task-catalog.ts";

type DaemonCliOptions = {
  cwd: string;
  profile?: string;
  initialAdapter?: DaemonAdapterKind;
  openVisible: boolean;
  restorePersistedAdapter: boolean;
  allowDesktopApplicationLaunch: boolean;
};

type ActiveTask = {
  startedAt: number;
  inputPreview: string;
  turnId?: string;
  turnIdAuthoritative?: boolean;
};

type DeferredInboundMessage = CodexDeferredInboundMessage;

export type DaemonTaskListSnapshot = {
  candidates: BridgeResumeSessionCandidate[];
  numberByThreadId: Map<string, number>;
};

export function resolveDaemonTaskListSnapshot(params: {
  current?: DaemonTaskListSnapshot | null;
  latestCandidates: BridgeResumeSessionCandidate[];
  refresh: boolean;
}): DaemonTaskListSnapshot {
  if (!params.refresh && params.current) {
    const latestByThreadId = new Map(
      params.latestCandidates.map((candidate) => [candidate.sessionId, candidate]),
    );
    return {
      candidates: params.current.candidates.map(
        (candidate) => latestByThreadId.get(candidate.sessionId) ?? candidate,
      ),
      numberByThreadId: params.current.numberByThreadId,
    };
  }
  const candidates = [...params.latestCandidates];
  return {
    candidates,
    numberByThreadId: new Map(
      candidates.map((candidate, index) => [candidate.sessionId, index + 1]),
    ),
  };
}

export function resolveDaemonTaskTargetedMessage(params: {
  text: string;
  snapshot: DaemonTaskListSnapshot | null;
}): { candidate: BridgeResumeSessionCandidate; text: string } | null {
  if (!params.snapshot) {
    return null;
  }
  const match = params.text.trim().match(/^([1-9]\d*)\s*[：:]\s*([\s\S]*\S)$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const index = Number(match[1]);
  if (!Number.isSafeInteger(index)) {
    return null;
  }
  const candidate = params.snapshot.candidates[index - 1];
  if (!candidate) {
    return null;
  }
  return {
    candidate,
    text: match[2].trim(),
  };
}

export function resolveCodexWechatReplyThreadId(params: {
  currentThreadId?: string;
  notifiedThreadId?: string;
}): string | undefined {
  return params.notifiedThreadId ?? params.currentThreadId;
}

export function isCodexTaskCandidateCacheFresh(params: {
  cachedAtMs: number;
  nowMs?: number;
  maxAgeMs: number;
}): boolean {
  if (!Number.isFinite(params.cachedAtMs) || params.cachedAtMs <= 0) {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  return nowMs >= params.cachedAtMs &&
    nowMs - params.cachedAtMs <= params.maxAgeMs;
}

type WechatSendContext =
  | "final_reply"
  | "message"
  | "notice"
  | "approval_required"
  | "approval_resolved"
  | "user_input_required"
  | "mirrored_user_input"
  | "session_switched"
  | "thread_switched"
  | "mobile_link"
  | "task_failed"
  | "fatal_error"
  | "inbound_error";

export type DaemonTaskApprovalIdentity = {
  threadId?: string;
  turnId?: string;
};

function normalizeDaemonTaskApprovalIdentity(
  identity: DaemonTaskApprovalIdentity,
): DaemonTaskApprovalIdentity {
  const threadId = identity.threadId?.trim();
  const turnId = identity.turnId?.trim();
  if (threadId) {
    return { threadId };
  }
  return turnId ? { turnId } : {};
}

function daemonTaskApprovalIdentityKey(
  identity: DaemonTaskApprovalIdentity,
): string | null {
  if (identity.threadId) {
    return `thread:${identity.threadId}`;
  }
  if (identity.turnId) {
    return `turn:${identity.turnId}`;
  }
  return null;
}

function daemonTaskApprovalIdentitiesMatch(
  enabled: DaemonTaskApprovalIdentity,
  candidate: DaemonTaskApprovalIdentity,
): boolean {
  if (
    enabled.threadId &&
    candidate.threadId &&
    enabled.threadId !== candidate.threadId
  ) {
    return false;
  }
  if (
    enabled.turnId &&
    candidate.turnId &&
    enabled.turnId !== candidate.turnId
  ) {
    return false;
  }
  return Boolean(
    (enabled.threadId && candidate.threadId) ||
    (enabled.turnId && candidate.turnId),
  );
}

export class DaemonTaskApprovalAutoApprover {
  private readonly enabledByTask = new Map<
    string,
    DaemonTaskApprovalIdentity
  >();

  enable(identity: DaemonTaskApprovalIdentity): boolean {
    const normalized = normalizeDaemonTaskApprovalIdentity(identity);
    const key = daemonTaskApprovalIdentityKey(normalized);
    if (!key) {
      return false;
    }
    this.enabledByTask.set(key, normalized);
    return true;
  }

  shouldAutoApprove(identity: DaemonTaskApprovalIdentity): boolean {
    const normalized = normalizeDaemonTaskApprovalIdentity(identity);
    return this.findEnabledTask(normalized) !== null;
  }

  finish(identity: DaemonTaskApprovalIdentity): boolean {
    const normalized = normalizeDaemonTaskApprovalIdentity(identity);
    const matched = this.findEnabledTask(normalized);
    if (!matched) {
      return false;
    }
    this.enabledByTask.delete(matched.key);
    return true;
  }

  clear(): void {
    this.enabledByTask.clear();
  }

  snapshot(): DaemonTaskApprovalIdentity[] {
    return Array.from(this.enabledByTask.values(), (identity) => ({ ...identity }));
  }

  private findEnabledTask(
    identity: DaemonTaskApprovalIdentity,
  ): { key: string; identity: DaemonTaskApprovalIdentity } | null {
    const directKey = daemonTaskApprovalIdentityKey(identity);
    if (directKey) {
      const direct = this.enabledByTask.get(directKey);
      if (direct && daemonTaskApprovalIdentitiesMatch(direct, identity)) {
        return { key: directKey, identity: direct };
      }
    }
    for (const [key, enabled] of this.enabledByTask) {
      if (daemonTaskApprovalIdentitiesMatch(enabled, identity)) {
        return { key, identity: enabled };
      }
    }
    return null;
  }
}

type DaemonPendingApproval = PendingApproval & {
  notificationOrder?: number;
};

type DaemonSlot = {
  adapter: DaemonAdapterKind;
  runtime: BridgeAdapter;
  controller: BridgeController;
  outputBatcher: OutputBatcher;
  pendingConfirmations: DaemonPendingApproval[];
  notifiedApprovalKeys: BoundedTtlSet<string>;
  taskApprovalAutoApprover: DaemonTaskApprovalAutoApprover;
  approvalRuleChain: ApprovalRuleChain;
  undoScope: AdapterUndoScope;
  pendingUserInputs: PendingUserInputRequest[];
  activeTasks: Map<string, ActiveTask>;
  deferredInboundMessages: CodexInboundTaskQueue<DeferredInboundMessage>;
  deferredDrainRetryAttempts: Map<string, number>;
  deferredDrainRetryTimers: Map<string, ReturnType<typeof setTimeout>>;
  taskNumberByThreadId: Map<string, number>;
  taskListSnapshot: DaemonTaskListSnapshot | null;
  taskCandidatesCache: BridgeResumeSessionCandidate[] | null;
  taskCandidatesCachedAtMs: number;
  taskCandidatesRefreshPromise: Promise<BridgeResumeSessionCandidate[]> | null;
  wechatReplyThreadId?: string;
  awaitingBareTaskSelection: boolean;
  taskListPosition: CodexTaskListPagePosition;
  taskListHistory: CodexTaskListPagePosition[];
  suppressStartupNotifications: boolean;
};

type DaemonPendingApprovalTarget = {
  slot: DaemonSlot;
  pending: DaemonPendingApproval;
  insertionOrder: number;
};

export type DaemonApprovalShortcut = 1 | 2 | 3 | 4;

type DaemonApprovalShortcutResolution = {
  action: CodexMobileApprovalResultAction;
  label: string;
};

export function parseDaemonApprovalShortcutSequence(
  text: string,
): DaemonApprovalShortcut[] | null {
  const normalized = text.trim();
  if (!/^[1-4](?:[^\p{L}\p{N}]+[1-4])+$/u.test(normalized)) {
    return null;
  }
  return Array.from(normalized.matchAll(/[1-4]/g), (match) =>
    Number(match[0]) as DaemonApprovalShortcut
  );
}

export function resolveDaemonApprovalShortcut(
  pending: Pick<ApprovalRequest, "allowForSession">,
  shortcut: DaemonApprovalShortcut,
): DaemonApprovalShortcutResolution | null {
  if (shortcut === 1) {
    return { action: "confirm", label: "允许本次" };
  }
  if (shortcut === 2) {
    return { action: "deny", label: "拒绝" };
  }
  if (shortcut === 3) {
    return pending.allowForSession
      ? { action: "confirm_session", label: "本任务始终允许" }
      : { action: "confirm_task", label: "今日内本任务免审" };
  }
  return pending.allowForSession
    ? { action: "confirm_task", label: "今日内本任务免审" }
    : null;
}

export function compareDaemonApprovalQueueOrder(
  left: { createdAt: string; notificationOrder?: number; insertionOrder: number },
  right: { createdAt: string; notificationOrder?: number; insertionOrder: number },
): number {
  const orderDifference =
    (left.notificationOrder ?? Number.MAX_SAFE_INTEGER) -
    (right.notificationOrder ?? Number.MAX_SAFE_INTEGER);
  if (orderDifference) {
    return orderDifference;
  }
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const normalizedLeft = Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER;
  const normalizedRight = Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER;
  return normalizedLeft - normalizedRight || left.insertionOrder - right.insertionOrder;
}

export function buildDaemonApprovalNotificationKey(
  approval: Pick<ApprovalRequest, "threadId" | "turnId" | "requestId" | "commandPreview">,
): string {
  return [
    approval.threadId ?? "unknown-thread",
    approval.turnId ?? "unknown-turn",
    approval.requestId ?? redactSensitiveCommandText(approval.commandPreview),
  ].join("\u0000");
}

export function buildDaemonApprovalDeliveryKey(
  adapter: DaemonAdapterKind,
  approval: Pick<ApprovalRequest, "threadId" | "turnId" | "requestId" | "commandPreview">,
): string {
  return `${adapter}\u0000${buildDaemonApprovalNotificationKey(approval)}`;
}

type DaemonSystemCommand = NonNullable<
  ReturnType<typeof parseWechatControlCommand>
> & {
  preserveTaskSnapshot?: boolean;
  taskListPosition?: CodexTaskListPagePosition;
  taskListHistory?: CodexTaskListPagePosition[];
  taskListScope?: "global" | "adapter";
  sessionAlreadyRestored?: boolean;
};

const MODULE_FILE = fileURLToPath(import.meta.url);
const MODULE_DIR = path.dirname(MODULE_FILE);
const RUNTIME_ENTRY_EXTENSION = path.extname(MODULE_FILE) === ".ts" ? ".ts" : ".js";
const DAEMON_HOST = "127.0.0.1";
const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_MAX_MS = 30_000;
const WECHAT_SEND_MAX_ATTEMPTS = 3;
const WECHAT_SEND_RETRY_BASE_MS = 750;
const CODEX_TASK_MONITOR_INTERVAL_MS = 2_000;
const CODEX_TASK_CANDIDATE_CACHE_MAX_AGE_MS = 3_000;
const CODEX_COMPLETION_SUMMARY_RETRY_MS = 250;
const CODEX_COMPLETION_SUMMARY_RETRY_COUNT = 3;
const DAEMON_TRANSIENT_CACHE_TTL_MS = 24 * 60 * 60_000;
const CODEX_TASK_OBSERVATION_CACHE_MAX_SIZE = 1_000;
const CODEX_FINAL_REPLY_CACHE_MAX_SIZE = 512;
const WECHAT_GENERATED_IMAGE_KEY_CACHE_MAX_SIZE = 1_024;
const APPROVAL_NOTIFICATION_KEY_CACHE_MAX_SIZE = 512;
const MOBILE_CREATED_TASK_CACHE_MAX_SIZE = 256;
const MOBILE_CREATED_TASK_CACHE_TTL_MS = 15 * 60_000;
const SINGLE_BRIDGE_STOP_TIMEOUT_MS = 10_000;
const SINGLE_BRIDGE_FORCE_STOP_TIMEOUT_MS = 3_000;
const SINGLE_BRIDGE_STOP_POLL_MS = 250;
const DAEMON_TAKEOVER_STOP_TIMEOUT_MS = 10_000;
const DAEMON_TAKEOVER_FORCE_STOP_TIMEOUT_MS = 3_000;
const DAEMON_TAKEOVER_STOP_POLL_MS = 250;
const VISIBLE_CLIENT_CONNECT_TIMEOUT_MS = 15_000;
const VISIBLE_CLIENT_CONNECT_POLL_MS = 250;
const SWITCH_ADAPTER_TASK_LIST_READY_TIMEOUT_MS = 12_000;
const SWITCH_ADAPTER_TASK_LIST_READY_POLL_MS = 250;
const CODEX_DEFERRED_DRAIN_RETRY_BASE_MS = 1_000;
const CODEX_DEFERRED_DRAIN_RETRY_MAX_MS = 30_000;
const DAEMON_ADAPTERS: DaemonAdapterKind[] = [...DAEMON_PROVIDER_IDS];

function log(message: string): void {
  process.stderr.write(`[werelay-daemon] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[werelay-daemon] ERROR: ${message}\n`);
}

function appendDaemonLog(message: string): void {
  ensureChannelDataDir();
  appendBoundedLog(
    BRIDGE_LOG_FILE,
    `[${new Date().toISOString()}] daemon: ${message}\n`,
  );
}

function computePollRetryDelayMs(consecutiveFailures: number): number {
  const normalizedFailures = Math.max(1, consecutiveFailures);
  const exponent = Math.min(normalizedFailures - 1, 5);
  return Math.min(POLL_RETRY_MAX_MS, POLL_RETRY_BASE_MS * 2 ** exponent);
}

function computeWechatSendRetryDelayMs(attempt: number): number {
  return WECHAT_SEND_RETRY_BASE_MS * attempt;
}

export function computeCodexDeferredDrainRetryDelayMs(attempt: number): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const exponent = Math.min(normalizedAttempt - 1, 5);
  return Math.min(
    CODEX_DEFERRED_DRAIN_RETRY_MAX_MS,
    CODEX_DEFERRED_DRAIN_RETRY_BASE_MS * 2 ** exponent,
  );
}

function isSameWorkspaceCwd(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientCompanionTaskListError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bcompanion is (?:connected but not ready|not connected) yet\b/i.test(
    message,
  );
}

export async function retrySwitchedAdapterTaskList(
  readTaskList: () => Promise<void>,
  deps: {
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    onRetry?: (params: {
      attempt: number;
      delayMs: number;
      error: unknown;
    }) => void;
  } = {},
): Promise<void> {
  const timeoutMs = Math.max(
    0,
    deps.timeoutMs ?? SWITCH_ADAPTER_TASK_LIST_READY_TIMEOUT_MS,
  );
  const pollMs = Math.max(
    1,
    deps.pollMs ?? SWITCH_ADAPTER_TASK_LIST_READY_POLL_MS,
  );
  const sleepFn = deps.sleep ?? sleep;
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      await readTaskList();
      return;
    } catch (error) {
      if (!isTransientCompanionTaskListError(error)) {
        throw error;
      }
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        throw error;
      }
      const delayMs = Math.min(pollMs, remainingMs);
      deps.onRetry?.({ attempt, delayMs, error });
      await sleepFn(delayMs);
    }
  }
}

export function parseDaemonCliArgs(argv: string[]): DaemonCliOptions {
  let cwd = process.cwd();
  let profile: string | undefined;
  let initialAdapter: DaemonAdapterKind | undefined;
  let openVisible = true;
  let restorePersistedAdapter = true;
  let allowDesktopApplicationLaunch = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: werelay [--cwd <path>] [--adapter <codex|claude|tclaude|grok|codebuddy|reasonix|workbuddy|deepseek|opencode>] [--profile <name-or-path>] [--idle-start] [--no-open] [--open-desktop-apps]",
          "",
          "Keeps one WeChat connection alive and switches between supported agents from WeChat.",
          "Send /codex, /claude, /tclaude, /grok, /codebuddy, /reasonix, /workbuddy, /deepseek, or /opencode in WeChat to switch the active agent.",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }

    if (arg === "--cwd") {
      if (!next) {
        throw new Error("--cwd requires a value");
      }
      cwd = path.resolve(next);
      i += 1;
      continue;
    }

    if (arg === "--adapter") {
      if (!isDaemonAdapterKind(next)) {
        throw new Error(`Invalid adapter: ${next ?? "(missing)"}`);
      }
      initialAdapter = next;
      i += 1;
      continue;
    }

    if (arg === "--profile") {
      if (!next) {
        throw new Error("--profile requires a value");
      }
      profile = next;
      i += 1;
      continue;
    }

    if (arg === "--idle-start") {
      restorePersistedAdapter = false;
      continue;
    }

    if (arg === "--no-open") {
      openVisible = false;
      continue;
    }

    if (arg === "--open-desktop-apps") {
      allowDesktopApplicationLaunch = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    cwd,
    profile,
    initialAdapter,
    openVisible,
    restorePersistedAdapter,
    allowDesktopApplicationLaunch,
  };
}

export function resolveDaemonInitialAdapter(
  options: DaemonCliOptions,
  persistedAdapter?: DaemonAdapterKind,
): DaemonAdapterKind | undefined {
  if (options.initialAdapter) {
    return options.initialAdapter;
  }
  return options.restorePersistedAdapter ? persistedAdapter : undefined;
}

export function parseDaemonSwitchCommand(text: string): DaemonAdapterKind | null {
  const normalized = text.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  switch (normalized) {
    case "/codex":
      return "codex";
    case "/claude":
    case "/claude code":
      return "claude";
    case "/tclaude":
      return "tclaude";
    case "/grok":
    case "/grok cli":
      return "grok";
    case "/codebuddy":
      return "codebuddy";
    case "/reasonix":
    case "/reasonix code":
      return "reasonix";
    case "/workbuddy":
    case "/workbuddy desktop":
      return "workbuddy";
    case "/deepseek":
    case "/deepseek harness":
    case "/dsh":
      return "deepseek";
    case "/opencode":
      return "opencode";
    default:
      return null;
  }
}

export function resolveDaemonWechatCommand(params: {
  adapter: DaemonAdapterKind;
  text: string;
  awaitingBareTaskSelection: boolean;
  hasPendingConfirmation: boolean;
  hasPendingUserInput: boolean;
  canConfirmForSession?: boolean;
  canAutoApproveTask?: boolean;
}): NonNullable<ReturnType<typeof parseWechatControlCommand>> | null {
  const bareTaskTarget = resolveBareCodexTaskSelection({
    adapter: params.adapter,
    text: params.text,
    awaitingSelection: params.awaitingBareTaskSelection,
    hasPendingConfirmation: params.hasPendingConfirmation,
    hasPendingUserInput: params.hasPendingUserInput,
  });
  if (bareTaskTarget) {
    return { type: "resume", target: bareTaskTarget };
  }
  return parseWechatControlCommand(params.text, {
    adapter: params.adapter,
    hasPendingConfirmation: params.hasPendingConfirmation,
    hasPendingUserInput: params.hasPendingUserInput,
    canConfirmForSession: params.canConfirmForSession,
    canAutoApproveTask: params.canAutoApproveTask,
  });
}

export function resolveDaemonBareNumericReply(params: {
  text: string;
  taskListScope: "global" | "adapter";
  globalSnapshot: GlobalTaskSnapshot | null;
  adapterSnapshot: DaemonTaskListSnapshot | null;
}): { type: "resume"; target: string } | { type: "clarify"; number: string } | null {
  const number = params.text.trim();
  if (!/^[1-9]\d*$/.test(number)) {
    return null;
  }
  const candidate = params.taskListScope === "global"
    ? params.globalSnapshot
      ? resolveGlobalTaskCandidate(params.globalSnapshot, number)
      : null
    : params.adapterSnapshot
      ? resolveResumeSessionCandidate(params.adapterSnapshot.candidates, number)
      : null;
  return candidate
    ? { type: "resume", target: number }
    : { type: "clarify", number };
}

export function isExplicitGlobalTaskListRequest(text: string): boolean {
  const normalized = text.trim();
  if (normalized.startsWith("任务")) {
    return true;
  }
  return /^\/(?:tasks|threads)(?:$|\s)/i.test(normalized);
}

export function resolveDaemonTaskListScope(params: {
  text: string;
  activeScope: "global" | "adapter";
}): "global" | "adapter" {
  return isExplicitGlobalTaskListRequest(params.text)
    ? "global"
    : params.activeScope;
}

export function defaultDaemonSessionStartMode(
  adapter: DaemonAdapterKind,
): BridgeSessionStartMode {
  return providerUsesDesktopOwner(adapter) || providerUsesHarnessHost(adapter)
    ? "restore"
    : "new";
}

export function resolveDaemonSessionStartMode(params: {
  adapter: DaemonAdapterKind;
  explicitSessionStartMode?: BridgeSessionStartMode;
  slotCreated: boolean;
  visibleConnected: boolean;
  sharedSessionId?: string;
  reuseExistingVisible?: boolean;
}): BridgeSessionStartMode {
  if (params.reuseExistingVisible && params.visibleConnected) {
    return "restore";
  }
  if (params.explicitSessionStartMode) {
    return params.explicitSessionStartMode;
  }
  if (params.adapter === "codex") {
    return "restore";
  }
  if (params.adapter === "workbuddy" || params.adapter === "deepseek") {
    return "restore";
  }
  if (params.slotCreated) {
    return "new";
  }
  if (!params.visibleConnected && !params.sharedSessionId) {
    return "new";
  }
  return "restore";
}

function toPendingApproval(request: BridgeEvent & { type: "approval_required" }): PendingApproval {
  const rawRequest = request.request;
  if (typeof (rawRequest as PendingApproval).code === "string") {
    const pending = {
      ...(rawRequest as PendingApproval),
      ...(rawRequest.threadId || !request.threadId
        ? {}
        : { threadId: request.threadId }),
      ...(rawRequest.turnId || !request.turnId
        ? {}
        : { turnId: request.turnId }),
    };
    return {
      ...pending,
      commandPreview: redactSensitiveCommandText(pending.commandPreview),
      ...(pending.detailPreview
        ? { detailPreview: redactSensitiveCommandText(pending.detailPreview) }
        : {}),
    };
  }

  const pending = {
    ...rawRequest,
    ...(rawRequest.threadId || !request.threadId
      ? {}
      : { threadId: request.threadId }),
    ...(rawRequest.turnId || !request.turnId
      ? {}
      : { turnId: request.turnId }),
    code: buildOneTimeCode(),
    createdAt: request.timestamp,
  };
  return {
    ...pending,
    commandPreview: redactSensitiveCommandText(pending.commandPreview),
    ...(pending.detailPreview
      ? { detailPreview: redactSensitiveCommandText(pending.detailPreview) }
      : {}),
  };
}

function toPendingUserInput(request: UserInputRequest | PendingUserInputRequest): PendingUserInputRequest {
  if (typeof (request as PendingUserInputRequest).createdAt === "string") {
    return request as PendingUserInputRequest;
  }

  return {
    ...request,
    createdAt: nowIso(),
  };
}

export function prefixDaemonAdapterMessage(
  adapter: DaemonAdapterKind,
  text: string,
): string {
  const trimmed = text.trim();
  const prefix = `[${adapter}]`;
  return trimmed ? `${prefix}\n${trimmed}` : prefix;
}

function normalizeDaemonTaskDisplayTitle(
  title: string | undefined,
  fallback = "",
): string {
  const normalized = title
    ? normalizeOutput(title).trim().replace(/\s+/g, " ")
    : "";
  const migrated = normalized.replace(/codex[-_\s]*clawbot/gi, "WeRelay");
  return migrated || fallback;
}

export function prefixDaemonTaskMessage(
  adapter: DaemonAdapterKind,
  text: string,
  taskNumber?: number,
  threadId?: string,
  taskTitle?: string,
): string {
  const trimmed = text.trim();
  if (adapter !== "codex") {
    const normalizedTitle = taskTitle
      ? truncatePreview(normalizeOutput(taskTitle).trim().replace(/\s+/g, " "), 50)
      : "";
    const label = normalizedTitle
      ? `[${getBridgeProvider(adapter).label} · ${normalizedTitle}]`
      : "";
    return label && trimmed ? `${label}\n${trimmed}` : label || trimmed;
  }
  const normalizedTitle = truncatePreview(
    normalizeDaemonTaskDisplayTitle(taskTitle, "Codex 任务"),
    55,
  );
  const taskLabel = taskTitle || threadId || typeof taskNumber === "number"
    ? `[${normalizedTitle}]`
    : "";
  return taskLabel && trimmed ? `${taskLabel}\n${trimmed}` : taskLabel || trimmed;
}

export function buildVisibleClientLaunchArgs(params: {
  adapter: DaemonAdapterKind;
  cwd: string;
  sessionStartMode?: BridgeSessionStartMode;
  cliArgs?: string[];
}): string[] {
  const entryPath =
    params.adapter === "codex"
      ? path.resolve(
          MODULE_DIR,
          "..",
          "companion",
          `codex-remote-client${RUNTIME_ENTRY_EXTENSION}`,
        )
      : path.resolve(
          MODULE_DIR,
          "..",
          "companion",
          `local-companion${RUNTIME_ENTRY_EXTENSION}`,
        );
  const args = ["--no-warnings"];
  if (path.extname(entryPath) === ".ts") {
    args.push("--experimental-strip-types");
  }
  args.push(entryPath);
  if (params.adapter !== "codex") {
    args.push("--adapter", params.adapter);
  }
  if (params.sessionStartMode && params.sessionStartMode !== "restore") {
    args.push("--session-start-mode", params.sessionStartMode);
  }
  args.push("--cwd", params.cwd, ...(params.cliArgs ?? []));
  return args;
}

export function buildWindowsVisibleClientLaunchCommand(params: {
  adapter: DaemonAdapterKind;
  cwd: string;
  args: string[];
}): string {
  return [
    "start",
    quoteWindowsCommandArg(`werelay-${params.adapter}`),
    "/D",
    quoteWindowsCommandArg(params.cwd),
    quoteWindowsCommandArg(process.execPath),
    ...params.args.map((arg) => quoteWindowsCommandArg(arg)),
  ].join(" ");
}

type LinuxTerminalEntry = { cmd: string; buildArgs: (title: string) => string[] };

const LINUX_TERMINALS: LinuxTerminalEntry[] = [
  { cmd: "gnome-terminal", buildArgs: (title) => ["--title", title, "--"] },
  { cmd: "konsole", buildArgs: (title) => ["-p", `tabtitle=${title}`, "-e"] },
  { cmd: "xfce4-terminal", buildArgs: (title) => ["--title", title, "-e"] },
  { cmd: "xterm", buildArgs: (title) => ["-title", title, "-e"] },
];

let cachedLinuxTerminal: LinuxTerminalEntry | null | undefined;

function detectLinuxTerminal(): LinuxTerminalEntry | null {
  if (cachedLinuxTerminal !== undefined) {
    return cachedLinuxTerminal;
  }
  for (const entry of LINUX_TERMINALS) {
    try {
      execFileSync("which", [entry.cmd], { stdio: "ignore" });
      cachedLinuxTerminal = entry;
      return entry;
    } catch {
      // not found, try next
    }
  }
  cachedLinuxTerminal = null;
  return null;
}

function shellQuotePosix(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

type VisibleClientLaunch = {
  command: string;
  args: string[];
  pid?: number;
  launcherFile?: string;
};

type VisibleClientLauncherExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
};

export function buildMacVisibleClientLaunchScript(params: {
  launcherFile: string;
  cwd: string;
  execPath: string;
  args: string[];
}): string {
  const commandLine = [params.execPath, ...params.args].map(shellQuotePosix).join(" ");
  return [
    "#!/bin/zsh",
    `/bin/rm -f -- ${shellQuotePosix(params.launcherFile)}`,
    `cd ${shellQuotePosix(params.cwd)} || exit 1`,
    `exec ${commandLine}`,
    "",
  ].join("\n");
}

export function buildMacVisibleClientOpenArgs(launcherFile: string): string[] {
  return ["-g", "-a", "Terminal", launcherFile];
}

function createMacVisibleClientLauncherFile(params: {
  adapter: DaemonAdapterKind;
  cwd: string;
  args: string[];
}): string {
  const launcherDir = path.join(path.dirname(BRIDGE_LOG_FILE), "visible-client-launchers");
  ensurePrivateDir(launcherDir);
  const launcherFile = path.join(
    launcherDir,
    `${params.adapter}-${randomUUID()}.command`,
  );
  fs.writeFileSync(
    launcherFile,
    buildMacVisibleClientLaunchScript({
      launcherFile,
      cwd: params.cwd,
      execPath: process.execPath,
      args: params.args,
    }),
    { mode: 0o700 },
  );
  fs.chmodSync(launcherFile, 0o700);
  const cleanupTimer = setTimeout(() => {
    try {
      fs.rmSync(launcherFile, { force: true });
    } catch {
      // Best effort cleanup after LaunchServices has opened the command file.
    }
  }, 60_000);
  cleanupTimer.unref?.();
  return launcherFile;
}

function formatLaunchPreview(launch: VisibleClientLaunch): string {
  return [launch.command, ...launch.args].join(" ");
}

function openVisibleClient(params: {
  adapter: DaemonAdapterKind;
  cwd: string;
  sessionStartMode?: BridgeSessionStartMode;
  cliArgs?: string[];
  onError?: (error: Error) => void;
  onLauncherExit?: (result: VisibleClientLauncherExit) => void;
}): VisibleClientLaunch {
  if (params.adapter === "codex" && process.platform === "darwin") {
    const command = "/usr/bin/open";
    const args = ["-g", "-a", "ChatGPT"];
    const child = spawn(command, args, {
      cwd: params.cwd,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (error) => {
      params.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    child.unref();
    return { command, args, pid: child.pid };
  }

  const args = buildVisibleClientLaunchArgs(params);
  if (process.platform === "win32") {
    const command = process.env.ComSpec || "cmd.exe";
    const launchArgs = [
      "/d",
      "/c",
      buildWindowsVisibleClientLaunchCommand({
        adapter: params.adapter,
        cwd: params.cwd,
        args,
      }),
    ];
    const child = spawn(
      command,
      launchArgs,
      {
        cwd: params.cwd,
        env: process.env,
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: true,
        windowsHide: false,
      },
    );
    child.once("error", (error) => {
      params.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    child.unref();
    return {
      command,
      args: launchArgs,
      pid: child.pid,
    };
  }

  const title = `werelay-${params.adapter}`;
  const fullArgs = [process.execPath, ...args];

  if (process.platform === "darwin") {
    const launcherFile = createMacVisibleClientLauncherFile({
      adapter: params.adapter,
      cwd: params.cwd,
      args,
    });
    const command = "/usr/bin/open";
    const launchArgs = buildMacVisibleClientOpenArgs(launcherFile);
    let stderr = "";
    const child = spawn(command, launchArgs, {
      cwd: params.cwd,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.once("error", (error) => {
      params.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("close", (code, signal) => {
      params.onLauncherExit?.({ code, signal, stderr: stderr.trim() });
    });
    child.unref();
    return {
      command,
      args: launchArgs,
      pid: child.pid,
      launcherFile,
    };
  }

  const terminal = detectLinuxTerminal();
  if (terminal) {
    const termArgs = [...terminal.buildArgs(title), ...fullArgs];
    const child = spawn(terminal.cmd, termArgs, {
      cwd: params.cwd,
      env: process.env,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (error) => {
      params.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
    child.unref();
    return {
      command: terminal.cmd,
      args: termArgs,
      pid: child.pid,
    };
  }

  const child = spawn(process.execPath, args, {
    cwd: params.cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.once("error", (error) => {
    params.onError?.(error instanceof Error ? error : new Error(String(error)));
  });
  child.unref();
  return {
    command: process.execPath,
    args,
    pid: child.pid,
  };
}

function isVisibleClientAlive(cwd: string, adapter: DaemonAdapterKind): boolean {
  if (adapter === "codex" && process.platform === "darwin") {
    return fs.existsSync(resolveCodexDesktopIpcSocketPath());
  }
  const endpoint = readLocalCompanionEndpoint(cwd, { adapter });
  if (!endpoint?.companionPid) {
    return false;
  }
  if (isPidAlive(endpoint.companionPid)) {
    return true;
  }

  clearLocalCompanionOccupancy(cwd, endpoint.instanceId, { adapter });
  return false;
}

function cleanupVisibleClientLauncher(launch: VisibleClientLaunch): boolean {
  let cleaned = false;
  if (launch.launcherFile) {
    try {
      if (fs.existsSync(launch.launcherFile)) {
        fs.rmSync(launch.launcherFile, { force: true });
        cleaned = true;
      }
    } catch {
      // Best effort cleanup.
    }
  }
  if (!launch.pid || !isPidAlive(launch.pid)) {
    return cleaned;
  }

  try {
    killProcessTreeSync(launch.pid);
    return true;
  } catch {
    return cleaned;
  }
}

export async function waitForVisibleClientConnection(
  params: {
    cwd: string;
    adapter: DaemonAdapterKind;
    timeoutMs?: number;
    pollMs?: number;
  },
  deps: {
    isAlive?: (cwd: string, adapter: DaemonAdapterKind) => boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<boolean> {
  const timeoutMs = params.timeoutMs ?? VISIBLE_CLIENT_CONNECT_TIMEOUT_MS;
  const pollMs = params.pollMs ?? VISIBLE_CLIENT_CONNECT_POLL_MS;
  const isAlive = deps.isAlive ?? isVisibleClientAlive;
  const sleepFn = deps.sleep ?? sleep;
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;

  while (true) {
    if (isAlive(params.cwd, params.adapter)) {
      return true;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      return false;
    }

    await sleepFn(Math.min(pollMs, remainingMs));
  }
}

function formatInboundMessagePreview(message: InboundWechatMessage): string {
  if (message.text.trim()) {
    return message.text;
  }

  if (message.attachments.length > 0) {
    let imageIndex = 0;
    let fileIndex = 0;
    return message.attachments.map((attachment) => {
      if (attachment.kind === "image") {
        imageIndex += 1;
        return `png${imageIndex}`;
      }
      fileIndex += 1;
      return `文件${fileIndex}`;
    }).join(" ");
  }

  return "（空消息）";
}

function formatNoActiveAdapterMessage(): string {
  return [
    "尚未选择终端。",
    "发送 /codex、/claude、/tclaude、/grok、/codebuddy、/reasonix、/workbuddy、/deepseek 或 /opencode。",
  ].join("\n");
}

function formatDaemonAdapterLabel(adapter: DaemonAdapterKind): string {
  return getBridgeProvider(adapter).label;
}

function formatDaemonWorkerStatus(status: string): string {
  switch (status) {
    case "starting":
      return "启动中";
    case "busy":
      return "处理中";
    case "awaiting_approval":
      return "待审批";
    case "awaiting_input":
      return "待输入";
    case "error":
      return "异常";
    case "stopped":
      return "已停止";
    default:
      return "空闲";
  }
}

export type MobileAdapterDisplayStatus = BridgeWorkerStatus | "open";

export function resolveMobileAdapterDisplayStatus(params: {
  slotStatus?: BridgeWorkerStatus;
  endpointStatus?: BridgeWorkerStatus;
  endpointCompanionAlive?: boolean;
  visibleClientOpen?: boolean;
}): MobileAdapterDisplayStatus {
  if (params.slotStatus) {
    return params.slotStatus;
  }
  if (params.endpointCompanionAlive && params.endpointStatus) {
    return params.endpointStatus;
  }
  if (params.endpointCompanionAlive || params.visibleClientOpen) {
    return "open";
  }
  return "stopped";
}

function processLineHasCommand(line: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s/\\\\])${escaped}(?:\\.exe)?(?:$|[\\s/\\\\])`, "i")
    .test(line);
}

export function detectOpenMobileAdaptersFromProcessList(
  processList: string,
  options: { codexDesktopOpen?: boolean } = {},
): Set<DaemonAdapterKind> {
  const open = new Set<DaemonAdapterKind>();
  if (options.codexDesktopOpen) {
    open.add("codex");
  }

  for (const rawLine of processList.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/\/Applications\/WorkBuddy\.app\/Contents\/MacOS\//i.test(line)) {
      open.add("workbuddy");
    }
    if (processLineHasCommand(line, "tclaude") || /--adapter\s+tclaude(?:\s|$)/i.test(line)) {
      open.add("tclaude");
    } else if (processLineHasCommand(line, "claude") || /--adapter\s+claude(?:\s|$)/i.test(line)) {
      open.add("claude");
    }
    if (processLineHasCommand(line, "grok") || /--adapter\s+grok(?:\s|$)/i.test(line)) {
      open.add("grok");
    }
    if (processLineHasCommand(line, "codebuddy") || /--adapter\s+codebuddy(?:\s|$)/i.test(line)) {
      open.add("codebuddy");
    }
    if (processLineHasCommand(line, "reasonix") || /--adapter\s+reasonix(?:\s|$)/i.test(line)) {
      open.add("reasonix");
    }
    if (/(?:^|[\s/\\])dsh(?:\.exe)?\s+web(?:\s|$)/i.test(line) || /--adapter\s+deepseek(?:\s|$)/i.test(line)) {
      open.add("deepseek");
    }
    if (/\/Applications\/DSH Desktop\.app\/Contents\/MacOS\/DSH Desktop(?:\s|$)/i.test(line)) {
      open.add("deepseek");
    }
    if (processLineHasCommand(line, "opencode") || /--adapter\s+opencode(?:\s|$)/i.test(line)) {
      open.add("opencode");
    }
  }
  return open;
}

function readOpenMobileAdapters(cwd: string): Set<DaemonAdapterKind> {
  let processList = "";
  if (process.platform !== "win32") {
    const snapshot = spawnSync("ps", ["-axo", "command="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (!snapshot.error && snapshot.status === 0) {
      processList = snapshot.stdout;
    }
  }
  return detectOpenMobileAdaptersFromProcessList(processList, {
    codexDesktopOpen: isVisibleClientAlive(cwd, "codex"),
  });
}

export function formatMobileTaskListUnavailableMessage(
  adapter: DaemonAdapterKind,
  error: unknown,
): string | null {
  const raw = error instanceof Error ? error.message : String(error);
  const label = formatDaemonAdapterLabel(adapter);
  if (
    /\/resume is disabled|\/resume is only supported|\/resume is not available/i.test(raw)
  ) {
    return `${label} 已连接，但网页版暂不支持读取这个终端的任务列表。请在微信或电脑终端中继续使用。`;
  }
  if (
    /companion.*(?:not connected|not ready|disconnected|timed out)|socket disconnected/i.test(raw)
  ) {
    return `${label} 正在连接，请稍后再试。`;
  }
  return null;
}

export function formatDaemonSwitchResultDetail(result: {
  created: boolean;
  openedVisible: boolean;
  visibleConnected: boolean;
  activated?: boolean;
  previousActiveAdapter?: DaemonAdapterKind;
  activationReason?: string;
}): string {
  if (result.activated === false) {
    if (result.activationReason) {
      return result.previousActiveAdapter
        ? `${result.activationReason}，仍使用 ${formatDaemonAdapterLabel(result.previousActiveAdapter)}。`
        : `${result.activationReason}。`;
    }
    return result.previousActiveAdapter
      ? `桌面端尚未连接，仍使用 ${formatDaemonAdapterLabel(result.previousActiveAdapter)}。`
      : "桌面端尚未连接，请在电脑上打开对应客户端。";
  }

  if (result.openedVisible && result.visibleConnected) {
    return result.created
      ? "已启动并连接桌面端。"
      : "已打开并连接桌面端。";
  }

  if (result.openedVisible) {
    return "桌面端尚未连接，请在电脑上打开对应客户端。";
  }

  if (result.visibleConnected) {
    return "已连接现有桌面端。";
  }

  return result.created ? "已启动后台连接。" : "已复用后台连接。";
}

export function formatDaemonStatus(status: DaemonStatus): string {
  const lines = [
    `当前：${status.activeAdapter ? formatDaemonAdapterLabel(status.activeAdapter) : "未选择"}`,
  ];

  for (const adapter of DAEMON_ADAPTERS) {
    const slot = status.slots.find((entry) => entry.adapter === adapter);
    if (!slot) {
      lines.push(`${formatDaemonAdapterLabel(adapter)}：未启动`);
      continue;
    }
    const slotStatus = slot.pendingApproval
      ? "待审批"
      : slot.pendingUserInput
        ? "待输入"
        : formatDaemonWorkerStatus(slot.status);
    lines.push(`${formatDaemonAdapterLabel(adapter)}：${slotStatus}`);
  }

  return lines.join("\n");
}

export function shouldQueueCodexDaemonInbound(_params: {
  adapter: DaemonAdapterKind;
  status: BridgeWorkerStatus;
  currentThreadId?: string | null;
  hasActiveTask: boolean;
}): boolean {
  return false;
}

export function resolveDaemonDesktopApplicationLaunchPermission(params: {
  automaticLaunchEnabled: boolean;
  userInitiated: boolean;
}): boolean {
  return params.automaticLaunchEnabled || params.userInitiated;
}

export function shouldRecreateDesktopOwnerSlotForUserLaunch(params: {
  isDesktopOwner: boolean;
  userInitiated: boolean;
  status: BridgeWorkerStatus;
}): boolean {
  return params.isDesktopOwner &&
    params.userInitiated &&
    (params.status === "error" || params.status === "stopped");
}

export function buildDaemonRuntimeOptions(params: {
  adapter: DaemonAdapterKind;
  cwd: string;
  profile?: string;
  sessionStartMode?: BridgeSessionStartMode;
  initialSharedSessionId?: string;
  allowDesktopApplicationLaunch?: boolean;
}): AdapterOptions {
  const initialSharedSessionId = params.initialSharedSessionId;
  return {
    kind: params.adapter,
    command: resolveDefaultAdapterCommand(params.adapter),
    cwd: params.cwd,
    profile: params.profile,
    lifecycle: "persistent",
    sessionStartMode: params.sessionStartMode,
    companionLaunchMode: "daemon_auto",
    allowDesktopApplicationLaunch: params.allowDesktopApplicationLaunch === true,
    initialSharedSessionId,
    initialSharedThreadId: initialSharedSessionId,
  };
}

export function buildDaemonTaskCatalogRuntimeOptions(params: {
  adapter: DaemonAdapterKind;
  cwd: string;
  profile?: string;
}): AdapterOptions {
  return buildDaemonRuntimeOptions({
    ...params,
    sessionStartMode: "new",
    allowDesktopApplicationLaunch: false,
  });
}

export function formatDaemonRestartNotice(restored: boolean): string {
  return restored
    ? "WeRelay 已重启，仍在原任务。\n直接发送消息即可继续；发送“任务”可切换。"
    : "WeRelay 已重启。\n发送“任务”选择要继续的任务。";
}

const DAEMON_RESTART_NOTICE_COOLDOWN_MS = 60 * 60 * 1000;

export function shouldSendDaemonRestartNotice(
  persistedState: DaemonWorkspaceState | null,
  nowMs = Date.now(),
): boolean {
  if (!persistedState) {
    return false;
  }
  const lastSentAtMs = Date.parse(persistedState.restartNoticeSentAt ?? "");
  if (!Number.isFinite(lastSentAtMs)) {
    return true;
  }
  return nowMs - lastSentAtMs >= DAEMON_RESTART_NOTICE_COOLDOWN_MS;
}

export async function flushPendingDaemonRestartNotice(
  pendingNotice: string | null,
  send: (text: string) => Promise<boolean>,
): Promise<string | null> {
  if (!pendingNotice) {
    return null;
  }
  return await send(pendingNotice) ? null : pendingNotice;
}

export function shouldForwardDaemonThreadSwitch(reason: string): boolean {
  return ![
    "wechat_resume",
    "startup_restore",
    "local_follow",
    "local_session_fallback",
    "local_turn",
  ].includes(reason);
}

export function mapCodexMobileTaskStatus(
  runtimeStatus: BridgeResumeSessionRuntimeStatus | undefined,
): CodexMobileTaskStatus {
  if (runtimeStatus?.type === "systemError") {
    return "error";
  }
  if (runtimeStatus?.type !== "active") {
    return "idle";
  }
  if (runtimeStatus.activeFlags.includes("waitingOnApproval")) {
    return "approval";
  }
  if (runtimeStatus.activeFlags.includes("waitingOnUserInput")) {
    return "input";
  }
  return "running";
}

export function resolveCreatedMobileTask(params: {
  adapterLabel: string;
  threadId?: string;
  previousThreadId?: string;
  listedTasks: CodexMobileTask[];
  status: CodexMobileTaskStatus;
  canRename: boolean;
  canCreateInProject: boolean;
  sourceTask?: CodexMobileTask;
  nowIso?: string;
}): CodexMobileTask | null {
  const threadId = params.threadId?.trim();
  if (!threadId || threadId === params.previousThreadId) {
    return null;
  }

  const listed = params.listedTasks.find((task) => task.threadId === threadId);
  if (listed) {
    return {
      ...listed,
      ...(params.sourceTask?.projectId && !listed.projectId
        ? { projectId: params.sourceTask.projectId }
        : {}),
      ...(params.sourceTask?.projectName && !listed.projectName
        ? { projectName: params.sourceTask.projectName }
        : {}),
      selected: true,
    };
  }

  return {
    threadId,
    title: `新 ${params.adapterLabel} 任务`,
    ...(params.sourceTask?.projectId
      ? { projectId: params.sourceTask.projectId }
      : {}),
    ...(params.sourceTask?.projectName
      ? { projectName: params.sourceTask.projectName }
      : {}),
    lastUpdatedAt: params.nowIso ?? new Date().toISOString(),
    status: params.status,
    selected: true,
    canRename: params.canRename,
    canCreateInProject: params.canCreateInProject,
  };
}

export function isMobileTaskAvailableForDirectAction(params: {
  threadId: string;
  currentThreadId?: string;
  recentlyCreated: boolean;
  listed: boolean;
}): boolean {
  return params.threadId === params.currentThreadId ||
    params.recentlyCreated ||
    params.listed;
}

export function shouldFollowCodexActiveTask(
  runtimeStatus: BridgeResumeSessionRuntimeStatus | undefined,
): boolean {
  return runtimeStatus?.type === "active";
}

export function resolveCodexMobilePendingApprovalFromSignals(params: {
  threadId: string;
  selectedThreadId?: string | null;
  pendingConfirmations: PendingApproval[];
  runtimeTaskApprovals?: ApprovalRequest[];
  runtimePendingApproval?: ApprovalRequest | null;
}): CodexMobilePendingApproval | null {
  const pending = params.runtimeTaskApprovals !== undefined
    ? params.runtimeTaskApprovals[0] ?? null
    : params.pendingConfirmations.find(
        (candidate) => candidate.threadId === params.threadId,
      ) ?? (
        params.selectedThreadId === params.threadId
          ? params.runtimePendingApproval ?? null
          : null
      );
  if (!pending) {
    return null;
  }
  const createdAtMs = typeof pending.createdAt === "string"
    ? Date.parse(pending.createdAt)
    : Number.NaN;
  return {
    summary: pending.summary,
    commandPreview: redactSensitiveCommandText(pending.commandPreview),
    ...(pending.requestId ? { requestId: pending.requestId } : {}),
    ...(pending.turnId ? { turnId: pending.turnId } : {}),
    ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
    ...(pending.allowForSession !== undefined
      ? { allowForSession: pending.allowForSession }
      : {}),
    ...(pending.toolName ? { toolName: pending.toolName } : {}),
    ...(pending.detailLabel ? { detailLabel: pending.detailLabel } : {}),
    ...(pending.detailPreview
      ? { detailPreview: redactSensitiveCommandText(pending.detailPreview) }
      : {}),
  };
}

export function resolveCodexMobileTaskStatusFromSignals(params: {
  runtimeStatus: BridgeResumeSessionRuntimeStatus | undefined;
  hasPendingApproval: boolean;
  runtimeTaskApprovals?: ApprovalRequest[];
  hasPendingUserInput: boolean;
  hasActiveTask: boolean;
  selectedStateStatus?: BridgeWorkerStatus;
}): CodexMobileTaskStatus {
  if (params.runtimeStatus?.type === "idle" || params.runtimeStatus?.type === "systemError") {
    return mapCodexMobileTaskStatus(params.runtimeStatus);
  }
  const hasPendingApproval = params.runtimeTaskApprovals !== undefined
    ? params.runtimeTaskApprovals.length > 0
    : params.hasPendingApproval;
  if (hasPendingApproval) {
    return "approval";
  }
  if (params.hasPendingUserInput) {
    return "input";
  }
  if (params.runtimeStatus?.type === "active") {
    if (
      params.runtimeTaskApprovals !== undefined &&
      params.runtimeTaskApprovals.length === 0 &&
      params.runtimeStatus.activeFlags.includes("waitingOnApproval")
    ) {
      return mapCodexMobileTaskStatus({
        ...params.runtimeStatus,
        activeFlags: params.runtimeStatus.activeFlags.filter(
          (flag) => flag !== "waitingOnApproval",
        ),
      });
    }
    return mapCodexMobileTaskStatus(params.runtimeStatus);
  }
  if (params.hasActiveTask) {
    return "running";
  }
  if (params.selectedStateStatus === "awaiting_approval") {
    return "approval";
  }
  if (params.selectedStateStatus === "awaiting_input") {
    return "input";
  }
  if (params.selectedStateStatus === "busy") {
    return "running";
  }
  if (params.selectedStateStatus === "error" || params.selectedStateStatus === "stopped") {
    return "error";
  }
  return mapCodexMobileTaskStatus(params.runtimeStatus);
}

export function shouldClearCodexActiveTaskForCompletion(
  activeTaskTurnId: string | undefined,
  eventTurnId: string | undefined,
): boolean {
  return eventTurnId ? activeTaskTurnId === eventTurnId : true;
}

export function filterCodexMobileProgressForCurrentTurn(params: {
  progressItems: BridgeSessionProgressItem[];
  hasActiveTask: boolean;
  activeTurnId?: string;
  activeTurnAuthoritative?: boolean;
  runSummary: BridgeSessionRunSummary | null;
}): BridgeSessionProgressItem[] {
  if (params.hasActiveTask && !params.activeTurnId) {
    return [];
  }
  if (params.activeTurnAuthoritative && params.activeTurnId) {
    return params.progressItems.filter((item) => item.turnId === params.activeTurnId);
  }
  const activeTurnHasProgress = Boolean(
    params.activeTurnId &&
    params.progressItems.some((item) => item.turnId === params.activeTurnId),
  );
  const summaryTurnHasProgress = Boolean(
    params.runSummary?.turnId &&
    params.progressItems.some((item) => item.turnId === params.runSummary?.turnId),
  );
  const currentTurnId = params.activeTurnId &&
      (activeTurnHasProgress || !summaryTurnHasProgress)
    ? params.activeTurnId
    : params.runSummary?.turnId ?? params.activeTurnId;
  if (currentTurnId) {
    return params.progressItems.filter((item) => item.turnId === currentTurnId);
  }
  if (params.runSummary?.status === "running") {
    return [];
  }
  return params.progressItems;
}

export function resolveCodexTaskCompletionDurationMs(params: {
  turnId?: string;
  runSummary: BridgeSessionRunSummary | null;
  startedAtMs: number;
  nowMs?: number;
}): number {
  const summary = params.runSummary;
  const summaryMatches = Boolean(
    summary &&
    summary.status !== "running" &&
    summary.status !== "unknown" &&
    (!params.turnId || !summary.turnId || params.turnId === summary.turnId)
  );
  if (summaryMatches && summary?.durationMs !== undefined) {
    return Math.max(0, summary.durationMs);
  }
  return Math.max(0, (params.nowMs ?? Date.now()) - params.startedAtMs);
}

export function sanitizeDaemonVisibleSessionMessage(
  adapter: DaemonAdapterKind,
  message: BridgeSessionMessage,
): BridgeSessionMessage | null {
  if (message.role === "assistant") {
    const text = adapter === "codex"
      ? sanitizeCodexVisibleAssistantMessageForDisplay(message.text)
      : message.text.trim();
    return text ? { ...message, text } : null;
  }
  const text = adapter === "codex"
    ? sanitizeCodexVisibleUserMessageForDisplay(message.text)
    : sanitizeWechatInboundPromptForDisplay(message.text);
  if (!text && !message.images?.length) {
    return null;
  }
  return {
    ...message,
    text: text ?? "",
  };
}

export function selectCodexCompletionReplyText(params: {
  resolvedTurnId?: string;
  turnReply?: string;
  threadReply?: { turnId?: string; text: string };
  latestMessage?: BridgeSessionMessage | null;
}): string | undefined {
  if (params.turnReply) {
    return params.turnReply;
  }
  if (
    params.threadReply &&
    (!params.resolvedTurnId || params.threadReply.turnId === params.resolvedTurnId)
  ) {
    return params.threadReply.text;
  }
  if (
    params.latestMessage?.role === "assistant" &&
    (!params.resolvedTurnId || params.latestMessage.turnId === params.resolvedTurnId)
  ) {
    return params.latestMessage.text;
  }
  return undefined;
}

function normalizeCodexCompletionRequestPreview(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  let normalized = sanitizeWechatInboundPromptForDisplay(value);
  normalized = normalized.trim().replace(/\s+/g, " ");
  return normalized || undefined;
}

export function selectCodexCompletionRequestPreview(params: {
  resolvedTurnId?: string;
  activeTaskPreview?: string;
  messages?: BridgeSessionMessage[];
}): string | undefined {
  const activeTaskPreview = normalizeCodexCompletionRequestPreview(
    params.activeTaskPreview,
  );
  if (activeTaskPreview) {
    return activeTaskPreview;
  }

  const messages = params.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) {
      continue;
    }
    if (
      message.role !== "user" ||
      (params.resolvedTurnId && message.turnId !== params.resolvedTurnId)
    ) {
      continue;
    }
    const preview = normalizeCodexCompletionRequestPreview(message.text);
    if (preview) {
      return preview;
    }
  }
  return undefined;
}

export function shouldSendCodexMobileTaskLink(
  _outcome: BridgeTaskOutcome | undefined,
  threadId?: string,
): boolean {
  return Boolean(threadId);
}

export function shouldForwardDaemonFinalReply(
  adapter: DaemonAdapterKind,
): boolean {
  return adapter !== "codex";
}

const CODEX_COMPLETION_PREVIEW_MAX_CHARS = 280;

type CodexTaskObservation = {
  title: string;
  lastUpdatedAt: string;
  status: CodexMobileTaskStatus;
  runningSinceMs?: number;
  completionNotified: boolean;
};

export function buildCodexMobileTaskBoard(params: {
  taskGroups: Array<{
    adapter: DaemonAdapterKind;
    adapterLabel: string;
    tasks: CodexMobileTask[];
  }>;
  recentCompletions: DaemonRecentTaskCompletion[];
}): CodexMobileTaskBoard {
  const adapterLabels = new Map(
    params.taskGroups.map((group) => [group.adapter, group.adapterLabel]),
  );
  const completionByTask = new Map(
    params.recentCompletions.map((completion) => [
      `${completion.adapter}\u0000${completion.threadId}`,
      completion,
    ]),
  );
  const tasks = params.taskGroups.flatMap((group) =>
    group.tasks.map((task) => {
      const completion = completionByTask.get(
        `${group.adapter}\u0000${task.threadId}`,
      );
      const taskUpdatedAtMs = Date.parse(task.lastUpdatedAt ?? "") || 0;
      const completionAtMs = Date.parse(completion?.completedAt ?? "") || 0;
      const completionMatchesLatestActivity = Boolean(
        completion &&
        (!taskUpdatedAtMs || completionAtMs >= taskUpdatedAtMs - 5 * 60 * 1000),
      );
      return {
        ...task,
        adapter: group.adapter,
        adapterLabel: group.adapterLabel,
        ...(completionMatchesLatestActivity
          ? { completedAt: completion?.completedAt }
          : {}),
      };
    })
  ).sort((left, right) => {
    const leftTime = Date.parse(left.lastUpdatedAt ?? "") || 0;
    const rightTime = Date.parse(right.lastUpdatedAt ?? "") || 0;
    return rightTime - leftTime || left.title.localeCompare(right.title, "zh-CN");
  });
  return {
    tasks,
    recentCompleted: params.recentCompletions.map((completion) => ({
      ...completion,
      adapterLabel: adapterLabels.get(completion.adapter) ??
        formatDaemonAdapterLabel(completion.adapter),
    })),
  };
}

function isRunningCodexTaskStatus(
  status: CodexMobileTaskStatus | undefined,
): boolean {
  return status === "running" || status === "approval" || status === "input";
}

export function shouldForwardCodexTaskCompletionEvent(params: {
  bridgeStartedAtMs: number;
  eventTurnId?: string;
  activeTaskTurnId?: string;
  runSummary: BridgeSessionRunSummary | null;
  hasActiveTask: boolean;
  observationStatus?: CodexMobileTaskStatus;
}): boolean {
  const hasLiveTaskEvidence =
    params.hasActiveTask || isRunningCodexTaskStatus(params.observationStatus);
  if (
    params.eventTurnId &&
    params.activeTaskTurnId &&
    params.eventTurnId !== params.activeTaskTurnId
  ) {
    return false;
  }
  const summary = params.runSummary;
  if (!summary) {
    return hasLiveTaskEvidence;
  }
  if (
    params.eventTurnId &&
    summary.turnId &&
    params.eventTurnId !== summary.turnId
  ) {
    return false;
  }
  if (summary.status === "running") {
    return Boolean(
      params.eventTurnId &&
      params.activeTaskTurnId &&
      params.eventTurnId === params.activeTaskTurnId
    );
  }
  if (
    summary.completedAtMs !== undefined &&
    summary.completedAtMs < params.bridgeStartedAtMs
  ) {
    return false;
  }
  if (
    summary.status === "completed" ||
    summary.status === "interrupted" ||
    summary.status === "failed"
  ) {
    return summary.completedAtMs !== undefined || hasLiveTaskEvidence;
  }
  return hasLiveTaskEvidence;
}

function codexTaskIdFromUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim()).searchParams.get("task")?.trim() || null;
  } catch {
    return null;
  }
}

function stripMatchingCodexTaskLinks(
  text: string | undefined,
  canonicalUrl: string | undefined,
): string {
  const normalized = text ? normalizeOutput(text).trim() : "";
  const taskId = codexTaskIdFromUrl(canonicalUrl);
  if (!normalized || !taskId) return normalized;
  return normalized
    .replace(/https?:\/\/[^\s<>"'，。；！？、]+/gi, (candidate) =>
      codexTaskIdFromUrl(candidate) === taskId ? "" : candidate
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

function containsMatchingCodexTaskLink(
  text: string,
  canonicalUrl: string,
): boolean {
  const taskId = codexTaskIdFromUrl(canonicalUrl);
  if (!taskId) return text.includes(canonicalUrl);
  return Array.from(text.matchAll(/https?:\/\/[^\s<>"'，。；！？、]+/gi)).some(
    (match) => codexTaskIdFromUrl(match[0]) === taskId,
  );
}

export function appendCodexMobileTaskLink(
  text: string,
  url?: string,
): string {
  const trimmed = text.trim();
  const normalizedUrl = url?.trim();
  if (!normalizedUrl || containsMatchingCodexTaskLink(trimmed, normalizedUrl)) {
    return trimmed;
  }
  return trimmed ? `${trimmed}\n\n${normalizedUrl}` : normalizedUrl;
}

export function formatCompactTaskDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatCodexCompletionPreview(
  preview: string | undefined,
  limit = CODEX_COMPLETION_PREVIEW_MAX_CHARS,
): string {
  const normalized = preview
    ? normalizeOutput(preview).trim().replace(/\n{3,}/g, "\n\n")
    : "";
  if (!normalized) {
    return "";
  }
  const characters = Array.from(normalized);
  const safeLimit = Math.max(1, Math.floor(limit));
  if (characters.length <= safeLimit) {
    return normalized;
  }
  const visible = characters.slice(0, safeLimit).join("").trimEnd();
  const remaining = characters.length - safeLimit;
  return `${visible}…\n后面还有 ${remaining} 字，共 ${characters.length} 字`;
}

export function formatCodexTaskCompletionMessage(params: {
  title: string;
  taskNumber?: number;
  outcome: BridgeTaskOutcome | undefined;
  durationMs: number;
  requestPreview?: string;
  preview?: string;
  previewLimit?: number;
  url?: string;
}): string {
  const title = normalizeDaemonTaskDisplayTitle(params.title, "Codex 任务");
  const status = params.outcome === "interrupted"
    ? "已中断"
    : params.outcome === "failed"
      ? "执行失败"
      : "已完成";
  const taskName = truncatePreview(title, 55);
  const heading = `[${taskName}] ${status}，用时${formatCompactTaskDuration(params.durationMs)}`;
  const normalizedRequest = stripMatchingCodexTaskLinks(
    normalizeCodexCompletionRequestPreview(params.requestPreview),
    params.url,
  );
  const requestLine = normalizedRequest && normalizedRequest !== title
    ? `本次任务：${truncatePreview(normalizedRequest, 100)}`
    : "";
  const preview = formatCodexCompletionPreview(
    stripMatchingCodexTaskLinks(params.preview, params.url),
    params.previewLimit,
  );
  const fallback = params.url
    ? `${params.url}\n发送“全文”查看完整回答；网页版可查看完整任务及列表。`
    : "发送“全文”查看完整回答。";
  const headingWithRequest = [heading, requestLine].filter(Boolean).join("\n");
  return preview
    ? `${headingWithRequest}\n\n${preview}\n\n${fallback}`
    : `${headingWithRequest}\n${fallback}`;
}

export function formatCodexTaskCompletionMessages(params: {
  title: string;
  taskNumber?: number;
  outcome: BridgeTaskOutcome | undefined;
  durationMs: number;
  requestPreview?: string;
  text?: string;
  url?: string;
  mode: CodexWechatReplyMode;
}): string[] {
  if (params.mode === "preview") {
    return [formatCodexTaskCompletionMessage({
      title: params.title,
      taskNumber: params.taskNumber,
      outcome: params.outcome,
      durationMs: params.durationMs,
      requestPreview: params.requestPreview,
      preview: params.text,
      url: params.url,
    })];
  }

  const title = normalizeDaemonTaskDisplayTitle(params.title, "Codex 任务");
  const status = params.outcome === "interrupted"
    ? "已中断"
    : params.outcome === "failed"
      ? "执行失败"
      : "已完成";
  const taskName = truncatePreview(title, 55);
  const heading = `[${taskName}] ${status}，用时${formatCompactTaskDuration(params.durationMs)}`;
  const normalizedRequest = stripMatchingCodexTaskLinks(
    normalizeCodexCompletionRequestPreview(params.requestPreview),
    params.url,
  );
  const requestLine = normalizedRequest && normalizedRequest !== title
    ? `本次任务：${truncatePreview(normalizedRequest, 100)}`
    : "";
  const fullText = stripMatchingCodexTaskLinks(params.text, params.url)
    .replace(/\n{3,}/g, "\n\n");
  const sections = [[heading, requestLine].filter(Boolean).join("\n"), fullText, params.url]
    .filter(Boolean);
  return splitWechatTextIntoChunks(sections.join("\n\n"));
}

export function shouldSendCodexCompletionNotification(params: {
  eventTurnId?: string;
  runSummary: BridgeSessionRunSummary | null;
  latestMessage: BridgeSessionMessage | null;
}): boolean {
  if (params.eventTurnId) {
    return !(
      params.runSummary?.turnId &&
      params.eventTurnId !== params.runSummary.turnId
    );
  }
  if (params.runSummary?.status === "running") {
    return false;
  }
  if (params.latestMessage?.role !== "assistant") {
    return false;
  }
  const visibleText = sanitizeCodexVisibleAssistantMessageForDisplay(
    params.latestMessage.text,
  );
  if (!visibleText || params.latestMessage.phase === "commentary") {
    return false;
  }
  const turnMismatch = Boolean(
    params.runSummary?.turnId &&
    params.latestMessage.turnId &&
    params.runSummary.turnId !== params.latestMessage.turnId
  );
  if (turnMismatch) {
    return false;
  }
  if (params.latestMessage.phase === "final_answer") {
    return true;
  }
  return Boolean(
    params.runSummary?.turnId &&
    params.latestMessage.turnId === params.runSummary.turnId &&
    params.runSummary.status !== "unknown"
  );
}

export function formatCurrentCodexFullReplyMessages(params: {
  title: string;
  taskNumber?: number;
  text: string;
  url?: string;
}): string[] {
  const title = normalizeDaemonTaskDisplayTitle(params.title, "Codex 任务");
  const text = normalizeOutput(params.text).trim().replace(/\n{3,}/g, "\n\n");
  if (!text) {
    return [];
  }
  const taskName = truncatePreview(title, 55);
  const sections = [
    `[${taskName}] 最近完整回答`,
    text,
    params.url,
  ].filter(Boolean);
  return splitWechatTextIntoChunks(sections.join("\n\n"));
}

export function observeCodexTask(
  previous: CodexTaskObservation | null,
  candidate: BridgeResumeSessionCandidate,
  nowMs: number,
): {
  observation: CodexTaskObservation;
  completion?: { outcome: BridgeTaskOutcome; startedAtMs: number };
} {
  const status = mapCodexMobileTaskStatus(candidate.runtimeStatus);
  const running = status === "running" || status === "approval" || status === "input";
  const wasRunning = previous?.status === "running" ||
    previous?.status === "approval" ||
    previous?.status === "input";
  if (candidate.runtimeStatus?.type === "notLoaded" && previous && wasRunning) {
    return {
      observation: {
        ...previous,
        title: candidate.title,
        lastUpdatedAt: candidate.lastUpdatedAt,
      },
    };
  }
  if (running) {
    return {
      observation: {
        title: candidate.title,
        lastUpdatedAt: candidate.lastUpdatedAt,
        status,
        runningSinceMs: wasRunning ? previous?.runningSinceMs ?? nowMs : nowMs,
        completionNotified: false,
      },
    };
  }

  const observation: CodexTaskObservation = {
    title: candidate.title,
    lastUpdatedAt: candidate.lastUpdatedAt,
    status,
    runningSinceMs: previous?.runningSinceMs,
    completionNotified: previous?.completionNotified ?? false,
  };
  if (wasRunning && !previous?.completionNotified) {
    observation.completionNotified = true;
    return {
      observation,
      completion: {
        outcome: status === "error" ? "failed" : "completed",
        startedAtMs: previous?.runningSinceMs ?? nowMs,
      },
    };
  }
  return { observation };
}

export function shouldQueueCodexMobileMessage(
  _status: CodexMobileTaskStatus,
): boolean {
  return false;
}

export type DaemonRelayConfig = {
  relayUrl: string;
  deviceId: string;
  deviceToken: string;
};

export function resolveDaemonRelayConfig(
  env: NodeJS.ProcessEnv = process.env,
): DaemonRelayConfig | null {
  const relayUrl = env.WERELAY_RELAY_URL?.trim();
  if (!relayUrl) {
    return null;
  }
  const deviceToken = env.WERELAY_RELAY_DEVICE_TOKEN?.trim();
  if (!deviceToken) {
    return null;
  }
  return {
    relayUrl,
    deviceId: env.WERELAY_RELAY_DEVICE_ID?.trim() || "default",
    deviceToken,
  };
}

class WeRelayDaemon {
  private readonly cwd: string;
  private readonly profile?: string;
  private readonly authorizedUserId: string;
  private readonly transport: WeChatTransport;
  private readonly stateStore: DaemonWorkspaceStateStore;
  private readonly deferredInputStore: CodexDeferredInputStore;
  private readonly mobileMessageImageStore: MobileMessageImageStore;
  private readonly wechatImageDrafts = new WechatImageDraftCollector();
  private readonly allowDesktopApplicationLaunch: boolean;
  private readonly mobileProviderInstallManager = new MobileProviderInstallManager();
  private readonly slots = new Map<DaemonAdapterKind, DaemonSlot>();
  private approvalNotificationOrder = 0;
  private globalTaskListSnapshot: GlobalTaskSnapshot | null = null;
  private globalTaskListPosition: CodexTaskListPagePosition = {
    startIndex: 0,
    pageSize: CODEX_TASK_LIST_PAGE_SIZE,
  };
  private globalTaskListHistory: CodexTaskListPagePosition[] = [];
  private activeTaskListScope: "global" | "adapter" = "global";
  private readonly startedAt = new Date().toISOString();
  private readonly bridgeStartedAtMs = Date.now();

  /** Runtime override for strict approval; null = follow env var. */
  private runtimeStrictApproval: boolean | null = null;

  /** True when WERELAY_STRICT_APPROVAL is enabled (all approvals go remote). */
  private get strictApprovalEnabled(): boolean {
    if (this.runtimeStrictApproval !== null) {
      return this.runtimeStrictApproval;
    }
    return isStrictApprovalModeEnabled();
  }
  private backlogNoticeSent = false;
  private activeAdapter: DaemonAdapterKind | null = null;
  takenOverAdapter?: DaemonAdapterKind;
  private textSendChain = Promise.resolve();
  private attachmentSendChain = Promise.resolve();
  private readonly pendingWechatForwardTasks = new Set<Promise<void>>();
  private shutdownPromise: Promise<void> | null = null;
  private ipcServer: net.Server | null = null;
  private endpointToken = "";
  private startupNotice: string | null = null;
  private pendingRestartNotice: string | null = null;
  private codexMobileServer: CodexMobileServerHandle | null = null;
  private deskRelayRelayClient: WeRelayRelayClientHandle | null = null;
  private deskRelayRelayTaskLinks: WeRelayRelayTaskLinkClient | null = null;
  private codexTaskMonitorTimer: ReturnType<typeof setTimeout> | null = null;
  private codexTaskMonitorRunning = false;
  private readonly codexTaskObservations = new BoundedTtlMap<string, CodexTaskObservation>({
    maxSize: CODEX_TASK_OBSERVATION_CACHE_MAX_SIZE,
    ttlMs: DAEMON_TRANSIENT_CACHE_TTL_MS,
  });
  private readonly codexFinalReplyByTurnId = new BoundedTtlMap<string, string>({
    maxSize: CODEX_FINAL_REPLY_CACHE_MAX_SIZE,
    ttlMs: DAEMON_TRANSIENT_CACHE_TTL_MS,
  });
  private readonly codexFinalReplyByThreadId = new BoundedTtlMap<
    string,
    { turnId?: string; text: string }
  >({
    maxSize: CODEX_FINAL_REPLY_CACHE_MAX_SIZE,
    ttlMs: DAEMON_TRANSIENT_CACHE_TTL_MS,
  });
  private readonly codexCompletionDeliveries: CodexCompletionDeliveryQueue;
  private readonly approvalNotificationDeliveries: ApprovalNotificationDeliveryQueue;
  private readonly wechatGeneratedImageKeys = new BoundedTtlSet<string>({
    maxSize: WECHAT_GENERATED_IMAGE_KEY_CACHE_MAX_SIZE,
    ttlMs: DAEMON_TRANSIENT_CACHE_TTL_MS,
  });
  private readonly mobileCreatedTaskKeys = new BoundedTtlSet<string>({
    maxSize: MOBILE_CREATED_TASK_CACHE_MAX_SIZE,
    ttlMs: MOBILE_CREATED_TASK_CACHE_TTL_MS,
  });
  private readonly openAgentLogHistory = new OpenAgentLogHistoryProvider();
  private codexWechatReplyMode: CodexWechatReplyMode;

  constructor(params: {
    cwd: string;
    profile?: string;
    authorizedUserId: string;
    transport: WeChatTransport;
    stateStore: DaemonWorkspaceStateStore;
    allowDesktopApplicationLaunch?: boolean;
  }) {
    this.cwd = params.cwd;
    this.profile = params.profile;
    this.authorizedUserId = params.authorizedUserId;
    this.transport = params.transport;
    this.stateStore = params.stateStore;
    this.allowDesktopApplicationLaunch =
      params.allowDesktopApplicationLaunch === true;
    this.deferredInputStore = new CodexDeferredInputStore(params.cwd);
    this.mobileMessageImageStore = new MobileMessageImageStore(params.cwd);
    this.codexCompletionDeliveries = new CodexCompletionDeliveryQueue({
      initial: params.stateStore.getCodexCompletionDeliveryState(),
      persist: (state) => params.stateStore.setCodexCompletionDeliveryState(state),
    });
    this.approvalNotificationDeliveries = new ApprovalNotificationDeliveryQueue({
      initial: params.stateStore.getApprovalNotificationDeliveryState(),
      persist: (state) => params.stateStore.setApprovalNotificationDeliveryState(state),
    });
    this.codexWechatReplyMode =
      params.stateStore.getState().codexWechatReplyMode ?? "preview";
  }

  async startIpcServer(): Promise<void> {
    this.endpointToken = buildDaemonToken();
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        let detach: (() => void) | null = null;
        detach = attachDaemonRequestListener(socket, (frame) => {
          if (frame.token !== this.endpointToken) {
            sendDaemonResponse(socket, frame.id, {
              ok: false,
              error: "Invalid daemon IPC token.",
            });
            return;
          }

          void this.handleDaemonRequest(frame.payload).then(
            (result) => {
              sendDaemonResponse(socket, frame.id, { ok: true, result });
            },
            (error) => {
              sendDaemonResponse(socket, frame.id, {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              });
            },
          );
        });
        socket.once("close", () => {
          detach?.();
          detach = null;
        });
        socket.once("error", () => {
          socket.destroy();
        });
      });
      this.ipcServer = server;
      server.once("error", reject);
      server.listen(0, DAEMON_HOST, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate daemon IPC port."));
          return;
        }

        writeDaemonEndpoint({
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          pid: process.pid,
          port: address.port,
          token: this.endpointToken,
          cwd: this.cwd,
          startedAt: this.startedAt,
        });
        resolve();
      });
    });
  }

  getStatus(): DaemonStatus {
    return {
      cwd: this.cwd,
      activeAdapter: this.activeAdapter ?? undefined,
      startedAt: this.startedAt,
      slots: Array.from(this.slots.values()).map((slot): DaemonSlotSummary => {
        const endpoint = readLocalCompanionEndpoint(this.cwd, {
          adapter: slot.adapter,
        });
        return {
          adapter: slot.adapter,
          status: slot.runtime.getState().status,
          cwd: this.cwd,
          companionPid: endpoint?.companionPid,
          pendingApproval: slot.pendingConfirmations.length > 0,
          pendingUserInput: slot.pendingUserInputs.length > 0,
        };
      }),
    };
  }

  configureRestartNotice(persistedState: DaemonWorkspaceState | null): void {
    if (!persistedState || !shouldSendDaemonRestartNotice(persistedState)) {
      return;
    }
    const currentCodexThreadId = this.getCodexThreadId();
    const restored = Boolean(
      persistedState.codexThreadId &&
      this.activeAdapter === "codex" &&
      currentCodexThreadId === persistedState.codexThreadId,
    );
    this.startupNotice = formatDaemonRestartNotice(restored);
  }

  async startCodexMobileWeb(): Promise<void> {
    if (this.codexMobileServer) {
      return;
    }
    const configuredPort = Number.parseInt(
      process.env.WERELAY_MOBILE_PORT?.trim() ?? "4396",
      10,
    );
    const port = Number.isInteger(configuredPort) &&
        configuredPort > 0 &&
        configuredPort <= 65_535
      ? configuredPort
      : 4396;
    try {
      const accessToken = this.stateStore.ensureMobileAccessToken();
      const workspaceDir = ensureWorkspaceChannelDir(this.cwd).workspaceDir;
      const relayConfig = resolveDaemonRelayConfig();
      const publicBaseUrl = relayConfig?.relayUrl ??
        process.env.WERELAY_MOBILE_PUBLIC_URL;
      const authStore = new CodexMobileAuthStore({
        stateFile: path.join(workspaceDir, "codex-mobile-auth.json"),
      });
      const relayTaskLinks = relayConfig
        ? new WeRelayRelayTaskLinkClient({
            relayUrl: relayConfig.relayUrl,
            deviceId: relayConfig.deviceId,
            deviceToken: relayConfig.deviceToken,
          })
        : null;
      this.deskRelayRelayTaskLinks = relayTaskLinks;
      this.codexMobileServer = await startCodexMobileServer({
        port,
        publicBaseUrl,
        accessToken,
        ...(relayConfig ? { relayPrewarmToken: accessToken } : {}),
        ...(relayTaskLinks
          ? {
              buildPublicTaskUrl: (
                threadId: string,
                adapter: string,
                searchParams: URLSearchParams,
              ) => relayTaskLinks.buildTaskUrl(threadId, adapter, searchParams),
            }
          : {}),
        authStore,
        listAdapters: () => Promise.resolve(this.listMobileAdapters()),
        switchAdapter: (adapter) => this.switchMobileAdapter(adapter),
        readSettings: () => this.buildMobileSettings(),
        updateSettings: (patch) => this.updateMobileSettings(patch),
        installProviderDependency: (providerId, dependencyId) =>
          Promise.resolve(this.installMobileProviderDependency(providerId, dependencyId)),
        listTaskBoard: () => this.listMobileTaskBoard(),
        listTasks: (adapter) => this.listMobileTasks(adapter),
        createTask: (adapter, options) =>
          this.createMobileTask(adapter, options?.sourceThreadId),
        renameTask: (threadId, title, adapter) =>
          this.renameMobileTask(threadId, title, adapter),
        readTaskModel: (threadId, adapter) =>
          this.readMobileTaskModel(threadId, adapter),
        setTaskModel: (threadId, model, adapter) =>
          this.setMobileTaskModel(threadId, model, adapter),
        readMessages: (threadId, options, adapter) =>
          this.readMobileMessages(threadId, options, adapter),
        sendMessage: (threadId, input, adapter) =>
          this.sendMobileMessage(threadId, input, adapter),
        resolveApproval: (threadId, action, adapter) =>
          this.resolveMobileApproval(threadId, action, adapter),
        updateQueuedMessage: (threadId, messageId, text, adapter) =>
          this.updateMobileQueuedMessage(threadId, messageId, text, adapter),
        deleteQueuedMessage: (threadId, messageId, adapter) =>
          this.deleteMobileQueuedMessage(threadId, messageId, adapter),
        steerQueuedMessage: (threadId, messageId, adapter) =>
          this.steerMobileQueuedMessage(threadId, messageId, adapter),
        stopTask: (threadId, adapter) => this.stopMobileTask(threadId, adapter),
      });
      if (relayConfig) {
        this.deskRelayRelayClient = startWeRelayRelayClient({
          relayUrl: relayConfig.relayUrl,
          deviceId: relayConfig.deviceId,
          deviceToken: relayConfig.deviceToken,
          localBaseUrl: `http://127.0.0.1:${this.codexMobileServer.port}`,
          localPrewarmToken: accessToken,
          journalFile: path.join(workspaceDir, "relay-command-journal.json"),
          logger: (message) => appendDaemonLog(
            `relay_client: ${truncatePreview(message, 400)}`,
          ),
        });
        appendDaemonLog(
          `relay_client_started: device=${relayConfig.deviceId} url=${relayConfig.relayUrl}`,
        );
      } else if (process.env.WERELAY_RELAY_URL?.trim()) {
        appendDaemonLog(
          "relay_client_disabled: WERELAY_RELAY_DEVICE_TOKEN is missing",
        );
      }
      appendDaemonLog(
        `codex_mobile_started: address=${this.codexMobileServer.lanAddress} port=${this.codexMobileServer.port}`,
      );
      log(
        `WeRelay mobile web is ready at http://${this.codexMobileServer.lanAddress}:${this.codexMobileServer.port}`,
      );
      if (relayConfig) {
        log(`WeRelay public relay is connecting to ${relayConfig.relayUrl}`);
      }
    } catch (error) {
      if (this.deskRelayRelayTaskLinks) {
        const taskLinks = this.deskRelayRelayTaskLinks;
        this.deskRelayRelayTaskLinks = null;
        void taskLinks.close();
      }
      appendDaemonLog(
        `codex_mobile_start_error: error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
      );
      logError(
        `WeRelay mobile web failed to start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async runInitialAdapter(options: DaemonCliOptions): Promise<void> {
    const initialAdapter = resolveDaemonInitialAdapter(
      options,
      this.stateStore.getPersistedState()?.activeAdapter,
    );
    if (!initialAdapter) {
      return;
    }

    await this.ensureSlot(initialAdapter, {
      profile: options.profile,
      openVisible: options.openVisible,
    });
  }

  async runPollLoop(): Promise<void> {
    let consecutivePollFailures = 0;
    log("WeRelay daemon is ready.");
    log(`Working directory: ${this.cwd}`);
    log("Switch from WeChat with /codex, /claude, /tclaude, /grok, /codebuddy, /reasonix, /workbuddy, /deepseek, or /opencode.");
    appendDaemonLog(`started: cwd=${this.cwd}`);

    const activeSlot = this.getActiveSlot();
    const startupText = this.startupNotice ?? (
      this.stateStore.hadPersistedState
        ? null
        : t("daemon.welcome", {
            cwd: this.cwd,
            adapter: activeSlot?.adapter ?? "none",
          })
    );
    if (startupText) {
      const startupThreadId = activeSlot?.adapter === "codex"
        ? resolveCodexWechatReplyThreadId({
            currentThreadId: this.getSlotThreadId(activeSlot),
            notifiedThreadId: activeSlot.wechatReplyThreadId,
          })
        : activeSlot
          ? this.getSlotThreadId(activeSlot)
          : undefined;
      const startupMessage = activeSlot?.adapter === "codex"
        ? this.prefixSlotMessageWithMobileLink(
            activeSlot,
            startupText,
            startupThreadId,
          )
        : activeSlot
          ? prefixDaemonAdapterMessage(activeSlot.adapter, startupText)
          : startupText;
      const startupSent = await this.queueWechatMessage(
        this.authorizedUserId,
        startupMessage,
        "notice",
      );
      if (this.startupNotice) {
        if (startupSent) {
          this.stateStore.setRestartNoticeSentAt(nowIso());
        } else {
          this.pendingRestartNotice = this.startupNotice;
        }
      }
    }

    await this.retryPendingCodexCompletionNotifications(this.authorizedUserId);

    while (!this.shutdownPromise) {
      let pollResult: Awaited<ReturnType<WeChatTransport["pollMessages"]>>;
      try {
        pollResult = await this.transport.pollMessages({
          timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
          minCreatedAtMs: this.bridgeStartedAtMs - MESSAGE_START_GRACE_MS,
        });
      } catch (error) {
        const classification = classifyWechatTransportError(error);
        if (!classification.retryable) {
          throw error;
        }

        consecutivePollFailures += 1;
        const delayMs = computePollRetryDelayMs(consecutivePollFailures);
        const errorText = describeWechatTransportError(error);
        const statusDetails =
          typeof classification.statusCode === "number"
            ? ` status=${classification.statusCode}`
            : "";
        logError(
          `WeChat long poll failed (${classification.kind}${statusDetails}, attempt ${consecutivePollFailures}). Retrying in ${formatDuration(delayMs)}. ${errorText}`,
        );
        appendDaemonLog(
          `poll_retry: kind=${classification.kind}${statusDetails} attempt=${consecutivePollFailures} delay_ms=${delayMs} error=${truncatePreview(errorText, 400)}`,
        );
        await delay(delayMs);
        continue;
      }

      if (consecutivePollFailures > 0) {
        log(`WeChat long poll recovered after ${consecutivePollFailures} transient error(s).`);
        appendDaemonLog(`poll_recovered: failures=${consecutivePollFailures}`);
        consecutivePollFailures = 0;
      }

      if (pollResult.ignoredBacklogCount > 0) {
        appendDaemonLog(`ignored_startup_backlog: count=${pollResult.ignoredBacklogCount}`);
        if (!this.backlogNoticeSent) {
          this.backlogNoticeSent = true;
          await this.queueWechatMessage(
            this.authorizedUserId,
            t("bridge.backlogIgnored", {
              count: pollResult.ignoredBacklogCount,
              graceSeconds: Math.round(MESSAGE_START_GRACE_MS / 1000),
            }),
            "notice",
          );
        }
      }

      for (const message of pollResult.messages) {
        if (message.senderId === this.authorizedUserId) {
          await this.retryPendingCodexCompletionNotifications(message.senderId);
          await this.retryUndeliveredApprovalNotifications(message.senderId);
        }
        try {
          await this.handleInboundMessage(message);
        } catch (error) {
          const errorText = error instanceof Error ? error.message : String(error);
          const isUserFacingShellRejection =
            error instanceof Error && error.name === "ShellCommandRejectedError";
          logError(errorText);
          appendDaemonLog(
            `${isUserFacingShellRejection ? "inbound_rejected" : "inbound_error"}: ${errorText}`,
          );
          const errorSlot = this.getActiveSlot();
          const errorThreadId = errorSlot?.adapter === "codex"
            ? resolveCodexWechatReplyThreadId({
                currentThreadId: this.getSlotThreadId(errorSlot),
                notifiedThreadId: errorSlot.wechatReplyThreadId,
              })
            : errorSlot
              ? this.getSlotThreadId(errorSlot)
              : undefined;
          const userFacingError = formatUserFacingInboundError({
            adapter: this.activeAdapter ?? "codex",
            cwd: this.cwd,
            errorText,
            isUserFacingShellRejection,
          });
          await this.queueWechatMessage(
            message.senderId,
            errorSlot
              ? this.prefixSlotMessageWithMobileLink(
                  errorSlot,
                  userFacingError,
                  errorThreadId,
                )
              : userFacingError,
            "inbound_error",
          );
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.cleanup();
    }
    await this.shutdownPromise;
  }

  private async cleanup(): Promise<void> {
    appendDaemonLog("shutdown_started");
    if (this.codexTaskMonitorTimer) {
      clearTimeout(this.codexTaskMonitorTimer);
      this.codexTaskMonitorTimer = null;
    }
    if (this.deskRelayRelayClient) {
      const relayClient = this.deskRelayRelayClient;
      this.deskRelayRelayClient = null;
      try {
        await relayClient.close();
      } catch {
        // Best effort shutdown.
      }
    }
    if (this.deskRelayRelayTaskLinks) {
      const taskLinks = this.deskRelayRelayTaskLinks;
      this.deskRelayRelayTaskLinks = null;
      try {
        await taskLinks.close();
      } catch {
        // Best effort shutdown.
      }
    }
    if (this.codexMobileServer) {
      const mobileServer = this.codexMobileServer;
      this.codexMobileServer = null;
      try {
        await mobileServer.close();
      } catch {
        // Best effort shutdown.
      }
    }
    for (const slot of this.slots.values()) {
      try {
        await slot.outputBatcher.flushNow();
      } catch {
        // Best effort flush.
      }
    }
    await this.waitForPendingWechatForwardTasks();
    await this.textSendChain.catch(() => undefined);
    await this.attachmentSendChain.catch(() => undefined);

    for (const slot of this.slots.values()) {
      try {
        await slot.undoScope.undoAll();
      } catch {
        // Best effort undo.
      }
      try {
        await slot.runtime.dispose();
      } catch {
        // Best effort shutdown.
      }
      slot.controller.clearLocalClientEndpoint();
    }
    this.slots.clear();

    if (this.ipcServer) {
      const server = this.ipcServer;
      this.ipcServer = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    clearDaemonEndpoint();
    appendDaemonLog("shutdown_complete");
  }

  private async handleDaemonRequest(request: DaemonRequest): Promise<unknown> {
    switch (request.command) {
      case "status":
        return this.getStatus();
      case "shutdown":
        setTimeout(() => {
          void this.shutdown().finally(() => process.exit(0));
        }, 0);
        return { shuttingDown: true };
      case "ensure_slot":
        if (!isSameWorkspaceCwd(request.cwd, this.cwd)) {
          throw new Error(
            `werelay-daemon is bound to ${this.cwd}; requested cwd was ${request.cwd}.`,
          );
        }
        return await this.ensureSlot(request.adapter, {
          profile: request.profile,
          cliArgs: request.cliArgs,
          openVisible: request.openVisible ?? true,
          sessionStartMode: request.sessionStartMode,
          reuseExistingVisible: request.reuseExistingVisible ?? true,
        });
      case "switch_adapter":
        return await this.ensureSlot(request.adapter, {
          profile: request.profile,
          cliArgs: request.cliArgs,
          openVisible: request.openVisible ?? true,
          sessionStartMode: request.sessionStartMode,
          reuseExistingVisible: request.reuseExistingVisible ?? true,
          userInitiated: true,
        });
    }
  }

  private async ensureSlot(
    adapter: DaemonAdapterKind,
    options: {
      profile?: string;
      cliArgs?: string[];
      openVisible?: boolean;
      sessionStartMode?: BridgeSessionStartMode;
      reuseExistingVisible?: boolean;
      activate?: boolean;
      userInitiated?: boolean;
    } = {},
  ): Promise<{
    activeAdapter: DaemonAdapterKind;
    created: boolean;
    openedVisible: boolean;
    visibleConnected: boolean;
    activated: boolean;
    previousActiveAdapter?: DaemonAdapterKind;
    activationReason?: string;
  }> {
    const previousActiveAdapter = this.activeAdapter ?? undefined;
    let slot = this.slots.get(adapter);
    let created = false;
    if (slot && shouldRecreateDesktopOwnerSlotForUserLaunch({
      isDesktopOwner: providerUsesDesktopOwner(adapter),
      userInitiated: options.userInitiated === true,
      status: slot.runtime.getState().status,
    })) {
      appendDaemonLog(
        `desktop_slot_reconnect_requested: adapter=${adapter} source=user status=${slot.runtime.getState().status}`,
      );
      await this.disposeSlotForUserReconnect(slot);
      slot = undefined;
    }
    if (!slot) {
      const createSessionStartMode =
        options.sessionStartMode ??
        (adapter === this.takenOverAdapter ? "restore" : defaultDaemonSessionStartMode(adapter));
      if (adapter === this.takenOverAdapter) {
        this.takenOverAdapter = undefined;
      }
      slot = await this.createSlot(adapter, {
        profile: options.profile ?? this.profile,
        sessionStartMode: createSessionStartMode,
        allowDesktopApplicationLaunch:
          resolveDaemonDesktopApplicationLaunchPermission({
            automaticLaunchEnabled: this.allowDesktopApplicationLaunch,
            userInitiated: options.userInitiated === true,
          }),
      });
      this.slots.set(adapter, slot);
      created = true;
    }
    if (adapter === "codex") {
      await this.startCodexMobileWeb();
      this.startCodexTaskMonitor(slot);
      if (created && slot.deferredInboundMessages.threadIds().length > 0) {
        this.drainAllDeferredCodexInboundMessages(slot);
      }
    }

    const requiresVisibleClient = providerRequiresVisibleClient(adapter);
    let openedVisible = false;
    let visibleConnected = requiresVisibleClient
      ? isVisibleClientAlive(this.cwd, adapter)
      : false;
    const sessionStartMode = resolveDaemonSessionStartMode({
      adapter,
      explicitSessionStartMode: options.sessionStartMode,
      slotCreated: created,
      visibleConnected,
      sharedSessionId: getSharedSessionIdFromAdapterState(slot.runtime.getState()),
      reuseExistingVisible: options.reuseExistingVisible !== false,
    });
    if (
      !created &&
      options.reuseExistingVisible === false &&
      sessionStartMode === "new" &&
      (isClaudeProviderKind(adapter) || adapter === "opencode") &&
      visibleConnected
    ) {
      await this.startFreshSlotSession(slot);
      appendDaemonLog(`fresh_session_started: adapter=${adapter} source=start_command`);
    }

    if (requiresVisibleClient && options.openVisible !== false && !visibleConnected) {
      slot.controller.syncLocalClientEndpoint();
      const launch = openVisibleClient({
        adapter,
        cwd: this.cwd,
        sessionStartMode,
        cliArgs: options.cliArgs,
        onError: (error) => {
          appendDaemonLog(
            `visible_client_open_error: adapter=${adapter} error=${truncatePreview(error.message, 400)}`,
          );
        },
        onLauncherExit: ({ code, signal, stderr }) => {
          appendDaemonLog(
            `visible_client_launcher_exit: adapter=${adapter} code=${code ?? "null"} signal=${signal ?? "none"}`,
          );
          if (stderr) {
            appendDaemonLog(
              `visible_client_launcher_stderr: adapter=${adapter} text=${truncatePreview(stderr.replace(/\s+/g, " "), 400)}`,
            );
          }
        },
      });
      openedVisible = true;
      appendDaemonLog(
        `visible_client_open_attempt: adapter=${adapter} cwd=${this.cwd} pid=${launch.pid ?? "unknown"} command=${truncatePreview(formatLaunchPreview(launch), 400)}`,
      );
      visibleConnected = await waitForVisibleClientConnection({
        cwd: this.cwd,
        adapter,
      });
      if (visibleConnected) {
        appendDaemonLog(`visible_client_connected: adapter=${adapter} cwd=${this.cwd}`);
      } else {
        log(
          `${adapter} visible CLI did not connect within ${formatDuration(VISIBLE_CLIENT_CONNECT_TIMEOUT_MS)}. Check ${BRIDGE_LOG_FILE}.`,
        );
        const cleanedLauncher = cleanupVisibleClientLauncher(launch);
        appendDaemonLog(
          `visible_client_connect_timeout: adapter=${adapter} cwd=${this.cwd} timeout_ms=${VISIBLE_CLIENT_CONNECT_TIMEOUT_MS} cleaned_launcher=${cleanedLauncher}`,
        );
      }
    }

    let desktopAppReady = true;
    if (providerUsesDesktopOwner(adapter)) {
      let sessionId = getSharedSessionIdFromAdapterState(slot.runtime.getState());
      if (!sessionId && slot.runtime.resumeSession) {
        const latestSession = (await slot.runtime.listResumeSessions(1))[0];
        if (latestSession) {
          await slot.runtime.resumeSession(latestSession.sessionId);
          sessionId = getSharedSessionIdFromAdapterState(slot.runtime.getState());
        }
      }
      desktopAppReady = Boolean(sessionId);
    }

    const activated = providerUsesDesktopOwner(adapter)
      ? desktopAppReady
      : !requiresVisibleClient || options.openVisible === false || visibleConnected;
    const activationReason = !activated && providerUsesDesktopOwner(adapter)
      ? `没有可用的 ${formatDaemonAdapterLabel(adapter)} 任务`
      : undefined;
    if (activated && options.activate !== false) {
      this.activeAdapter = adapter;
      this.persistActiveAdapter(adapter);
    }

    appendDaemonLog(
      `switch_adapter: adapter=${adapter} created=${created} opened_visible=${openedVisible} visible_connected=${visibleConnected} activated=${activated} previous_active=${previousActiveAdapter ?? "(none)"} session_start_mode=${sessionStartMode}${activationReason ? ` reason=${activationReason}` : ""}`,
    );
    return {
      activeAdapter: adapter,
      created,
      openedVisible,
      visibleConnected,
      activated,
      previousActiveAdapter,
      ...(activationReason ? { activationReason } : {}),
    };
  }

  private async disposeSlotForUserReconnect(slot: DaemonSlot): Promise<void> {
    for (const timer of slot.deferredDrainRetryTimers.values()) {
      clearTimeout(timer);
    }
    slot.deferredDrainRetryTimers.clear();
    try {
      await slot.outputBatcher.flushNow();
    } catch {
      // Best effort flush before reconnecting the desktop owner.
    }
    try {
      await slot.runtime.dispose();
    } catch (error) {
      appendDaemonLog(
        `desktop_slot_reconnect_dispose_error: adapter=${slot.adapter} error=${truncatePreview(error instanceof Error ? error.message : String(error), 300)}`,
      );
    } finally {
      slot.controller.clearLocalClientEndpoint();
      this.slots.delete(slot.adapter);
      if (this.activeAdapter === slot.adapter) {
        this.activeAdapter = null;
      }
      if (slot.adapter === "codex" && this.codexTaskMonitorTimer) {
        clearTimeout(this.codexTaskMonitorTimer);
        this.codexTaskMonitorTimer = null;
      }
    }
  }

  private persistTaskApprovalAutoApprover(slot: DaemonSlot): void {
    this.stateStore.setTaskApprovalAutoApproveIdentities(
      slot.adapter,
      slot.taskApprovalAutoApprover.snapshot(),
    );
  }

  private enableTaskApprovalAutoApprove(
    slot: DaemonSlot,
    identity: DaemonTaskApprovalIdentity,
  ): boolean {
    const enabled = slot.taskApprovalAutoApprover.enable(identity);
    if (enabled) {
      this.persistTaskApprovalAutoApprover(slot);
    }
    return enabled;
  }

  private finishTaskApprovalAutoApprove(
    slot: DaemonSlot,
    identity: DaemonTaskApprovalIdentity,
  ): boolean {
    const finished = slot.taskApprovalAutoApprover.finish(identity);
    if (finished) {
      this.persistTaskApprovalAutoApprover(slot);
    }
    return finished;
  }

  private clearTaskApprovalAutoApprovals(slot: DaemonSlot): void {
    slot.taskApprovalAutoApprover.clear();
    this.persistTaskApprovalAutoApprover(slot);
  }

  private async createSlot(
    adapter: DaemonAdapterKind,
    options: {
      profile?: string;
      sessionStartMode?: BridgeSessionStartMode;
      allowDesktopApplicationLaunch?: boolean;
    },
  ): Promise<DaemonSlot> {
    clearLocalCompanionEndpoint(this.cwd, undefined, { adapter });
    const restoredWechatThreadId = adapter === "codex"
      ? this.stateStore.getCodexWechatThreadId()
      : undefined;
    const initialSharedSessionId = options.sessionStartMode !== "new"
      ? this.stateStore.getAdapterSessionId(adapter)
      : undefined;
    const runtime = createRuntimeHost(buildDaemonRuntimeOptions({
      adapter,
      cwd: this.cwd,
      profile: options.profile,
      sessionStartMode: options.sessionStartMode,
      initialSharedSessionId,
      allowDesktopApplicationLaunch:
        options.allowDesktopApplicationLaunch === true,
    }));
    const controller = new BridgeController(runtime, this.cwd);
    const deferredInboundMessages = new CodexInboundTaskQueue<DeferredInboundMessage>();
    const taskApprovalAutoApprover = new DaemonTaskApprovalAutoApprover();
    for (const identity of this.stateStore.getTaskApprovalAutoApproveIdentities(adapter)) {
      taskApprovalAutoApprover.enable(identity);
    }
    if (adapter === "codex") {
      const legacyDeferredCount = this.deferredInputStore.load().length;
      if (legacyDeferredCount > 0) {
        appendDaemonLog(
          `legacy_deferred_inputs_discarded: adapter=codex messages=${legacyDeferredCount} reason=native_queue_is_source_of_truth`,
        );
        this.deferredInputStore.clear();
      }
    }
    const slot: DaemonSlot = {
      adapter,
      runtime,
      controller,
      outputBatcher: new OutputBatcher(async (text) => {
        await this.queueWechatMessage(this.authorizedUserId, text);
      }),
      pendingConfirmations: [],
      notifiedApprovalKeys: new BoundedTtlSet<string>({
        maxSize: APPROVAL_NOTIFICATION_KEY_CACHE_MAX_SIZE,
        ttlMs: DAEMON_TRANSIENT_CACHE_TTL_MS,
      }),
      taskApprovalAutoApprover,
      approvalRuleChain: new ApprovalRuleChain(),
      undoScope: new AdapterUndoScope(),
      pendingUserInputs: [],
      activeTasks: new Map(),
      deferredInboundMessages,
      deferredDrainRetryAttempts: new Map(),
      deferredDrainRetryTimers: new Map(),
      taskNumberByThreadId: new Map(),
      taskListSnapshot: null,
      taskCandidatesCache: null,
      taskCandidatesCachedAtMs: 0,
      taskCandidatesRefreshPromise: null,
      awaitingBareTaskSelection: false,
      taskListPosition: { startIndex: 0, pageSize: CODEX_TASK_LIST_PAGE_SIZE },
      taskListHistory: [],
      suppressStartupNotifications: true,
    };

    // DSH-inspired revertible effects: register the free-pass snapshot so
    // removing this slot can restore the persisted auto-approve state.
    slot.undoScope.effect("free-pass-state", () => {
      slot.taskApprovalAutoApprover.clear();
      this.persistTaskApprovalAutoApprover(slot);
    });

    runtime.setEventSink((event) => {
      this.handleSlotEvent(slot, event);
    });
    try {
      await runtime.start();
      slot.suppressStartupNotifications = false;
    } catch (error) {
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
    slot.wechatReplyThreadId = adapter === "codex"
      ? restoredWechatThreadId ?? this.getSlotThreadId(slot)
      : this.getSlotThreadId(slot);
    if (adapter === "codex" && slot.wechatReplyThreadId) {
      this.persistCodexWechatThreadId(slot.wechatReplyThreadId);
    }
    this.persistAdapterSessionId(
      adapter,
      runtime.getState().sharedThreadId ?? runtime.getState().sharedSessionId,
    );
    controller.syncLocalClientEndpoint();
    appendDaemonLog(
      `slot_started: adapter=${adapter} command=${resolveDefaultAdapterCommand(adapter)} cwd=${this.cwd} session_start_mode=${options.sessionStartMode ?? "restore"}`,
    );
    if (adapter === "codex" && deferredInboundMessages.threadIds().length > 0) {
      appendDaemonLog(
        `deferred_inbound_restored: adapter=codex messages=${deferredInboundMessages.entries().reduce((total, entry) => total + entry.items.length, 0)}`,
      );
    }
    return slot;
  }

  private async startFreshSlotSession(slot: DaemonSlot): Promise<void> {
    await slot.outputBatcher.flushNow();
    slot.outputBatcher.clear();
    slot.pendingConfirmations = [];
    slot.notifiedApprovalKeys.clear();
    this.clearTaskApprovalAutoApprovals(slot);
    slot.pendingUserInputs = [];
    slot.activeTasks.clear();
    slot.deferredInboundMessages.clear();
    slot.awaitingBareTaskSelection = false;
    slot.wechatReplyThreadId = undefined;

    if (isClaudeProviderKind(slot.adapter)) {
      await slot.runtime.reset();
    } else if (slot.adapter === "opencode") {
      if (!slot.runtime.createSession) {
        throw new Error("/new is not available in opencode mode.");
      }
      await slot.runtime.createSession();
    }

    slot.controller.syncLocalClientEndpoint();
    slot.wechatReplyThreadId = this.getSlotThreadId(slot);
  }

  private handleSlotEvent(slot: DaemonSlot, event: BridgeEvent): void {
    slot.controller.syncLocalClientEndpoint();
    const adapterState = slot.runtime.getState();
    if (
      slot.adapter !== "codex" &&
      slot.pendingConfirmations.length > 0 &&
      !adapterState.pendingApproval
    ) {
      slot.pendingConfirmations = [];
      slot.notifiedApprovalKeys.clear();
    }
    if (
      slot.adapter !== "codex" &&
      slot.pendingUserInputs.length > 0 &&
      !adapterState.pendingUserInput
    ) {
      slot.pendingUserInputs = [];
    }

    switch (event.type) {
      case "stdout":
      case "stderr":
        if (
          !slot.suppressStartupNotifications &&
          shouldForwardBridgeEventToWechat(slot.adapter, event.type)
        ) {
          slot.outputBatcher.push(event.text);
        }
        break;
      case "final_reply":
        appendDaemonLog(`final_reply: adapter=${slot.adapter} text=${truncatePreview(event.text)}`);
        if (slot.adapter === "codex") {
          if (event.turnId) {
            this.codexFinalReplyByTurnId.set(event.turnId, event.text);
          }
          if (event.threadId) {
            this.codexFinalReplyByThreadId.set(event.threadId, {
              ...(event.turnId ? { turnId: event.turnId } : {}),
              text: event.text,
            });
          }
        }
        if (!shouldForwardDaemonFinalReply(slot.adapter)) {
          appendDaemonLog(
            `final_reply_suppressed: adapter=${slot.adapter} thread=${event.threadId ?? "unknown"}`,
          );
          break;
        }
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          const images = await this.collectFinalReplyImages(slot, {
            threadId: event.threadId,
            turnId: event.turnId,
            rawText: event.text,
          });
          await forwardWechatFinalReply({
            adapter: slot.adapter,
            rawText: event.text,
            images,
            onEmptyVisibleReply: ({ rawVisibleText }) => {
              appendDaemonLog(
                `empty_visible_final_reply: adapter=${slot.adapter} raw=${truncatePreview(rawVisibleText)}`,
              );
            },
            sender: {
              sendText: async (text) => {
                const sent = await this.queueWechatMessage(
                  this.authorizedUserId,
                  this.prefixSlotMessage(slot, text, event.threadId),
                  "final_reply",
                );
                if (sent) {
                  appendDaemonLog(
                    `final_reply_sent: adapter=${slot.adapter} chars=${Array.from(text).length}`,
                  );
                }
                return sent;
              },
              sendImage: (imagePath) => this.sendWechatGeneratedImage(slot, {
                threadId: event.threadId,
                turnId: event.turnId,
                rawText: event.text,
                imagePath,
              }),
              sendFile: (filePath) =>
                this.queueWechatAttachmentAction(() =>
                  this.transport.sendFile(filePath, {
                    recipientId: this.authorizedUserId,
                  }),
                ),
              sendVoice: (voicePath) =>
                this.queueWechatAttachmentAction(() =>
                  this.transport.sendVoice(voicePath, this.authorizedUserId),
                ),
              sendVideo: (videoPath) =>
                this.queueWechatAttachmentAction(() =>
                  this.transport.sendVideo(videoPath, {
                    recipientId: this.authorizedUserId,
                  }),
                ),
            },
          });
        }));
        break;
      case "status":
        if (event.message) {
          log(`${slot.adapter} ${event.status}: ${event.message}`);
          appendDaemonLog(`${slot.adapter}_${event.status}: ${event.message}`);
        }
        if (slot.adapter === "codex" && event.status === "idle") {
          this.drainAllDeferredCodexInboundMessages(slot);
        }
        break;
      case "notice":
        appendDaemonLog(`${slot.adapter}_${event.level}_notice: ${truncatePreview(event.text)}`);
        if (slot.suppressStartupNotifications) {
          break;
        }
        if (shouldForwardBridgeEventToWechat(slot.adapter, event.type, { text: event.text })) {
          this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
            await this.queueWechatMessage(
              this.authorizedUserId,
              formatBridgeNoticeForWechat(event.text),
              "notice",
            );
          }));
        }
        break;
      case "approval_required":
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          const pending: DaemonPendingApproval = {
            ...toPendingApproval(event),
            notificationOrder: ++this.approvalNotificationOrder,
          };
          const approvalIdentity = this.resolveTaskApprovalIdentity(
            slot,
            pending,
            event,
          );
          const notificationKey = buildDaemonApprovalNotificationKey(pending);
          const deliveryKey = buildDaemonApprovalDeliveryKey(slot.adapter, pending);
          if (!slot.pendingConfirmations.some(
            (candidate) =>
              buildDaemonApprovalNotificationKey(candidate) === notificationKey
          )) {
            slot.pendingConfirmations.push(pending);
          }
          appendDaemonLog(
            `approval_required: adapter=${slot.adapter} source=${pending.source} command=${truncatePreview(pending.commandPreview)}`,
          );
          const approvalDecision = slot.approvalRuleChain.decide({
            adapter: slot.adapter,
            toolName: pending.toolName,
            commandPreview: pending.commandPreview,
            taskIdentityKey: approvalIdentity.threadId,
            taskFreePassEnabled: slot.taskApprovalAutoApprover.shouldAutoApprove(approvalIdentity),
            strictApproval: this.strictApprovalEnabled,
          });
          const shouldAutoApprove = approvalDecision === "allow";
          if (shouldAutoApprove) {
            let count = 0;
            try {
              count = pending.threadId && slot.runtime.resolveTaskApprovals
                ? await slot.runtime.resolveTaskApprovals(pending.threadId, "confirm")
                : approvalIdentity.threadId && slot.runtime.resolveTaskApprovals
                  ? await slot.runtime.resolveTaskApprovals(
                      approvalIdentity.threadId,
                      "confirm",
                    )
                  : await slot.runtime.resolveAllApprovals("confirm");
            } catch (error) {
              appendDaemonLog(
                `approval_task_auto_confirm_error: adapter=${slot.adapter} thread=${approvalIdentity.threadId ?? "unknown"} turn=${approvalIdentity.turnId ?? "unknown"} error=${truncatePreview(error instanceof Error ? error.message : String(error), 300)}`,
              );
            }
            if (count > 0) {
              const taskThreadId = pending.threadId ?? approvalIdentity.threadId;
              slot.pendingConfirmations = taskThreadId
                ? slot.pendingConfirmations.filter(
                    (candidate) => candidate.threadId !== taskThreadId,
                  )
                : slot.pendingConfirmations.filter(
                    (candidate) => candidate !== pending,
                  );
              this.setSlotActiveTask(
                slot,
                {
                  startedAt: Date.now(),
                  inputPreview: pending.commandPreview,
                  ...(approvalIdentity.turnId
                    ? { turnId: approvalIdentity.turnId }
                    : {}),
                },
                taskThreadId,
              );
              this.recordMobileApprovalResult(slot, pending, "confirm_task", {
                ...(taskThreadId ? { threadId: taskThreadId } : {}),
                ...(approvalIdentity.turnId
                  ? { turnId: approvalIdentity.turnId }
                  : {}),
              });
              this.approvalNotificationDeliveries.cancel(deliveryKey);
              appendDaemonLog(
                `approval_task_auto_confirmed: adapter=${slot.adapter} thread=${taskThreadId ?? "unknown"} turn=${approvalIdentity.turnId ?? "unknown"} count=${count}`,
              );
              return;
            }
            appendDaemonLog(
              `approval_task_auto_confirm_failed: adapter=${slot.adapter} thread=${approvalIdentity.threadId ?? "unknown"} turn=${approvalIdentity.turnId ?? "unknown"}`,
            );
          }
          if (slot.notifiedApprovalKeys.has(notificationKey)) {
            return;
          }
          const threadId = event.threadId ?? pending.threadId;
          if (!threadId) {
            appendDaemonLog(
              `approval_notification_deferred: adapter=${slot.adapter} reason=missing_thread`,
            );
            return;
          }
          this.approvalNotificationDeliveries.enqueue({
            key: deliveryKey,
            adapter: slot.adapter,
            threadId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.requestId ? { requestId: pending.requestId } : {}),
            text: this.prefixSlotMessageWithMobileLink(
              slot,
              formatApprovalMessage(pending, adapterState, {
                allowTaskAutoApprove: true,
              }),
              threadId,
            ),
            commandPreview: pending.commandPreview,
          });
          const result = await this.deliverApprovalNotification(
            deliveryKey,
            this.authorizedUserId,
          );
          if (result.status === "delivered") {
            slot.notifiedApprovalKeys.add(notificationKey);
          }
        }));
        break;
      case "user_input_required":
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          const pending = toPendingUserInput(event.request);
          slot.pendingUserInputs.push(pending);
          appendDaemonLog(
            `user_input_required: adapter=${slot.adapter} questions=${pending.questions.length}`,
          );
          await this.queueWechatMessage(
            this.authorizedUserId,
            this.prefixSlotMessageWithMobileLink(
              slot,
              formatUserInputRequestMessage(pending, adapterState),
              event.threadId ?? pending.threadId,
            ),
            "user_input_required",
          );
        }));
        break;
      case "mirrored_user_input":
        appendDaemonLog(
          `mirrored_local_input: adapter=${slot.adapter} text=${truncatePreview(event.text)}`,
        );
        if (shouldForwardBridgeEventToWechat(slot.adapter, event.type, { text: event.text })) {
          this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
            await this.queueWechatMessage(
              this.authorizedUserId,
              this.prefixSlotMessage(
                slot,
                formatMirroredUserInputMessage(slot.adapter, event.text),
                event.threadId,
              ),
              "mirrored_user_input",
            );
          }));
        }
        break;
      case "session_switched":
        appendDaemonLog(
          `session_switched: adapter=${slot.adapter} session=${event.sessionId} source=${event.source} reason=${event.reason}`,
        );
        this.persistAdapterSessionId(slot.adapter, event.sessionId);
        if (
          !slot.suppressStartupNotifications &&
          shouldForwardDaemonThreadSwitch(event.reason) &&
          shouldForwardBridgeEventToWechat(slot.adapter, event.type)
        ) {
          this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
            await this.queueWechatMessage(
              this.authorizedUserId,
              this.withCodexMobileTaskLink(
                slot,
                formatSessionSwitchMessage({
                  adapter: slot.adapter,
                  sessionId: event.sessionId,
                  source: event.source,
                  reason: event.reason,
                }),
                event.sessionId,
              ),
              "session_switched",
            );
          }));
        }
        break;
      case "thread_switched":
        appendDaemonLog(
          `thread_switched: adapter=${slot.adapter} thread=${event.threadId} source=${event.source} reason=${event.reason}`,
        );
        if (slot.adapter === "codex") {
          this.persistCodexThreadId(event.threadId);
        }
        if (
          !slot.suppressStartupNotifications &&
          shouldForwardDaemonThreadSwitch(event.reason) &&
          shouldForwardBridgeEventToWechat(slot.adapter, event.type)
        ) {
          this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
            await this.queueWechatMessage(
              this.authorizedUserId,
              this.withCodexMobileTaskLink(
                slot,
                formatSessionSwitchMessage({
                  adapter: slot.adapter,
                  sessionId: event.threadId,
                  source: event.source,
                  reason: event.reason,
                }),
                event.threadId,
              ),
              "thread_switched",
            );
          }));
        }
        break;
      case "task_complete": {
        const completedThreadId = event.threadId ?? (
          slot.adapter === "codex" ? undefined : this.getSlotThreadId(slot)
        );
        const activeTask = this.getSlotActiveTask(slot, event.threadId);
        const observation = event.threadId
          ? this.codexTaskObservations.get(event.threadId)
          : undefined;
        const notifyInterrupted = slot.adapter !== "codex" && shouldNotifyTaskInterrupted(
          event.outcome,
          Boolean(activeTask),
        );
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          if (slot.adapter === "codex") {
            const shouldHandleCompletion = event.threadId
              ? await this.shouldHandleCodexTaskCompletionEvent(slot, {
                  threadId: event.threadId,
                  turnId: event.turnId,
                  activeTask,
                  observation,
                })
              : false;
            if (!shouldHandleCompletion) {
              this.clearSlotTaskState(slot, event.threadId, event.turnId);
              this.clearCodexFinalReplyCache(event.threadId, event.turnId);
              appendDaemonLog(
                `codex_completion_replay_suppressed: thread=${event.threadId ?? "unknown"} turn=${event.turnId ?? "unknown"}`,
              );
              return;
            }
            if (event.threadId && observation) {
              this.codexTaskObservations.set(event.threadId, {
                ...observation,
                status: event.outcome === "failed" ? "error" : "idle",
                completionNotified: true,
              });
            }
          }

          if (completedThreadId) {
            try {
              await this.recordRecentTaskCompletion(slot, {
                threadId: completedThreadId,
                ...(event.turnId ? { turnId: event.turnId } : {}),
                completedAt: event.timestamp,
                outcome: event.outcome,
              });
            } catch (error) {
              appendDaemonLog(
                `mobile_task_completion_record_error: adapter=${slot.adapter} thread=${completedThreadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
              );
            }
          }

          this.clearSlotTaskState(slot, event.threadId, event.turnId);
          if (notifyInterrupted) {
            await this.queueWechatMessage(
              this.authorizedUserId,
              this.prefixSlotMessage(
                slot,
                formatTaskInterruptedMessage(slot.adapter),
                event.threadId,
              ),
              "notice",
            );
          }
          if (
            slot.adapter === "codex" &&
            shouldSendCodexMobileTaskLink(event.outcome, event.threadId)
          ) {
            await this.sendCodexTaskCompletionMessage(slot, {
              threadId: event.threadId as string,
              turnId: event.turnId,
              outcome: event.outcome,
              completedAt: event.timestamp,
              startedAtMs:
                activeTask?.startedAt ?? observation?.runningSinceMs ?? Date.now(),
              inputPreview: activeTask?.inputPreview,
            });
          }
          if (event.threadId) {
            await this.maybeDrainDeferredCodexInboundMessages(slot, event.threadId);
          }
        }));
        break;
      }

      case "task_failed":
        if (slot.adapter === "codex") {
          appendDaemonLog(
            `task_failed_deferred_to_completion: adapter=codex thread=${event.threadId ?? "unknown"}`,
          );
          break;
        }
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          this.clearSlotTaskState(slot, event.threadId);
          await this.queueWechatMessage(
            this.authorizedUserId,
            this.prefixSlotMessage(
              slot,
              formatTaskFailedMessage(slot.adapter, event.message),
              event.threadId,
            ),
            "task_failed",
          );
        }));
        break;
      case "fatal_error":
        logError(`${slot.adapter}: ${event.message}`);
        appendDaemonLog(`fatal_error: adapter=${slot.adapter} message=${event.message}`);
        this.clearSlotTaskState(slot);
        if (slot.suppressStartupNotifications) {
          break;
        }
        this.trackWechatForwardTask(slot.outputBatcher.flushNow().then(async () => {
          await this.queueWechatMessage(
            this.authorizedUserId,
            formatUserFacingBridgeFatalError(event.message),
            "fatal_error",
          );
        }));
        break;
      case "shutdown_requested":
        appendDaemonLog(
          `slot_shutdown_requested: adapter=${slot.adapter} reason=${event.reason}`,
        );
        break;
    }
  }

  private async handleInboundMessage(initialMessage: InboundWechatMessage): Promise<void> {
    let message = initialMessage;
    if (message.senderId !== this.authorizedUserId) {
      await this.queueWechatMessage(
        message.senderId,
        "无权操作：仅接受已绑定微信的消息。",
      );
      return;
    }

    const restartSlot = this.getActiveSlot();
    const restartThreadId = restartSlot ? this.getSlotThreadId(restartSlot) : undefined;
    const pendingRestartNotice = this.pendingRestartNotice;
    this.pendingRestartNotice = await flushPendingDaemonRestartNotice(
      pendingRestartNotice,
      (text) => this.queueWechatMessage(
        message.senderId,
        restartSlot
          ? this.prefixSlotMessageWithMobileLink(
              restartSlot,
              text,
              restartThreadId,
            )
          : text,
        "notice",
      ),
    );
    if (pendingRestartNotice && !this.pendingRestartNotice) {
      this.stateStore.setRestartNoticeSentAt(nowIso());
    }
    const switchAdapter = parseDaemonSwitchCommand(message.text);
    if (switchAdapter) {
      const previousSlot = this.getActiveSlot();
      let result: Awaited<ReturnType<WeRelayDaemon["ensureSlot"]>>;
      try {
        result = await this.ensureSlot(switchAdapter, {
          openVisible: true,
          reuseExistingVisible: true,
          userInitiated: true,
        });
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        const missingCommand = /(?:spawn\s+\S+\s+ENOENT|ENOENT)/i.test(raw);
        const detail = missingCommand
          ? `没有找到 ${getBridgeProvider(switchAdapter).command} 命令，请检查安装和 PATH。`
          : raw;
        const fallback = previousSlot
          ? `仍使用 ${formatDaemonAdapterLabel(previousSlot.adapter)}。`
          : "当前没有可用应用。";
        appendDaemonLog(
          `switch_adapter_failed: adapter=${switchAdapter} previous_active=${previousSlot?.adapter ?? "(none)"} error=${truncatePreview(raw, 400)}`,
        );
        await this.queueWechatMessage(
          message.senderId,
          `切换 ${formatDaemonAdapterLabel(switchAdapter)} 失败。\n${detail}\n${fallback}`,
          "inbound_error",
        );
        return;
      }
      if (result.activated && previousSlot) {
        previousSlot.awaitingBareTaskSelection = false;
      }
      const detail = formatDaemonSwitchResultDetail(result);
      const heading = result.activated
        ? `已切换到 ${formatDaemonAdapterLabel(switchAdapter)}。`
        : `切换 ${formatDaemonAdapterLabel(switchAdapter)} 失败。`;
      await this.queueWechatMessage(
        message.senderId,
        prefixDaemonAdapterMessage(switchAdapter, `${heading}\n${detail}`),
      );
      if (result.activated) {
        const switchedSlot = this.getActiveSlot();
        if (switchedSlot?.adapter === switchAdapter) {
          try {
            await retrySwitchedAdapterTaskList(
              () => this.handleSystemCommand(message, switchedSlot, {
                type: "resume",
                taskListScope: "adapter",
              }),
              {
                onRetry: ({ attempt, delayMs, error }) => {
                  appendDaemonLog(
                    `switch_adapter_task_list_retry: adapter=${switchAdapter} attempt=${attempt} delay_ms=${delayMs} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
                  );
                },
              },
            );
          } catch (error) {
            appendDaemonLog(
              `switch_adapter_task_list_error: adapter=${switchAdapter} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
            );
            await this.queueWechatMessage(
              message.senderId,
              "任务列表暂时无法读取，请稍后发送“任务”重试。",
              "inbound_error",
            );
          }
        }
      }
      return;
    }

    if (message.text.trim().toLowerCase() === "/daemon-stop") {
      await this.queueWechatMessage(message.senderId, "正在停止微信桥接。");
      setTimeout(() => {
        void this.shutdown().finally(() => process.exit(0));
      }, 0);
      return;
    }

    if (await this.handleGlobalTaskInputWithoutActiveSlot(message)) {
      return;
    }

    const slot = this.getActiveSlot();
    if (!slot) {
      await this.queueWechatMessage(message.senderId, formatNoActiveAdapterMessage());
      return;
    }

    const pendingApprovalTargets = this.listPendingApprovalTargets();
    const pendingApprovalSlot = pendingApprovalTargets[0]?.slot ??
      this.resolvePendingApprovalSlot(slot);
    const pendingApproval = pendingApprovalTargets[0]?.pending ??
      (pendingApprovalSlot ? this.resolvePendingApproval(pendingApprovalSlot) : null);
    const approvalSequenceTargets = pendingApprovalTargets.length > 0
      ? pendingApprovalTargets
      : pendingApprovalSlot && pendingApproval
        ? [{
            slot: pendingApprovalSlot,
            pending: pendingApproval,
            insertionOrder: 0,
          }]
        : [];
    const approvalSequence = approvalSequenceTargets.length > 0
      ? parseDaemonApprovalShortcutSequence(message.text)
      : null;
    if (approvalSequence) {
      slot.awaitingBareTaskSelection = false;
      await this.handlePendingApprovalSequence(
        message,
        approvalSequence,
        approvalSequenceTargets,
      );
      return;
    }

    const shouldCollectImageDraft =
      message.attachments.some((attachment) => attachment.kind === "image") ||
      (this.wechatImageDrafts.hasPendingDraft(message.senderId) &&
        !message.text.trim().startsWith("/"));
    if (shouldCollectImageDraft && slot.pendingUserInputs.length === 0 && !pendingApproval) {
      const imageDraftResult = this.wechatImageDrafts.consume(message);
      if (imageDraftResult.type === "wait") {
        await this.queueWechatMessage(
          message.senderId,
          this.prefixSlotMessage(
            slot,
            imageDraftResult.reply,
            this.getSlotThreadId(slot),
          ),
          "notice",
        );
        return;
      }
      message = imageDraftResult.message;
    }

    const globalTargetedTaskMessage = this.activeTaskListScope === "global" &&
        this.globalTaskListSnapshot
      ? resolveGlobalTaskTargetedMessage({
          text: message.text,
          snapshot: this.globalTaskListSnapshot,
        })
      : null;
    if (globalTargetedTaskMessage) {
      try {
        await this.handleGlobalTaskTargetedMessage(message, globalTargetedTaskMessage);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        appendDaemonLog(
          `global_task_targeted_send_error: adapter=${globalTargetedTaskMessage.candidate.adapter} thread=${globalTargetedTaskMessage.candidate.sessionId} error=${truncatePreview(detail, 400)}`,
        );
        await this.queueWechatMessage(message.senderId, detail, "inbound_error");
      }
      return;
    }

    const targetedTaskMessage = this.activeTaskListScope === "adapter" &&
        slot.runtime.sendInputToSession
      ? resolveDaemonTaskTargetedMessage({
          text: message.text,
          snapshot: slot.taskListSnapshot,
        })
      : null;
    if (targetedTaskMessage) {
      await this.handleDaemonTaskTargetedMessage(message, slot, targetedTaskMessage);
      return;
    }

    const taskListScope = resolveDaemonTaskListScope({
      text: message.text,
      activeScope: this.activeTaskListScope,
    });
    let command = resolveDaemonWechatCommand({
      adapter: slot.adapter,
      text: message.text,
      awaitingBareTaskSelection: slot.awaitingBareTaskSelection,
      hasPendingConfirmation: Boolean(pendingApproval),
      hasPendingUserInput: slot.pendingUserInputs.length > 0,
      canConfirmForSession: pendingApproval?.allowForSession === true,
      canAutoApproveTask: Boolean(pendingApproval),
    });
    if (!command && isExplicitGlobalTaskListRequest(message.text)) {
      try {
        const snapshot = this.globalTaskListSnapshot ?? buildGlobalTaskSnapshot(
          await this.listWechatGlobalTaskCandidates(),
        );
        const compactTarget = resolveCompactGlobalTaskSearchTarget(
          message.text,
          snapshot,
        );
        if (compactTarget) {
          this.globalTaskListSnapshot = snapshot;
          command = { type: "resume", target: compactTarget };
        }
      } catch (error) {
        appendDaemonLog(
          `global_compact_task_search_error: error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
      }
    }
    if (!command && slot.adapter === "codex") {
      try {
        const candidates = slot.taskListSnapshot?.candidates ??
          await this.getCodexTaskCandidates(slot);
        const compactTarget = resolveCompactCodexTaskSearchTarget(
          message.text,
          candidates,
        );
        if (compactTarget) {
          command = { type: "resume", target: compactTarget };
        }
      } catch (error) {
        appendDaemonLog(
          `compact_task_search_error: error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
      }
    }
    if (!command) {
      const numericReply = resolveDaemonBareNumericReply({
        text: message.text,
        taskListScope,
        globalSnapshot: this.globalTaskListSnapshot,
        adapterSnapshot: slot.taskListSnapshot,
      });
      if (numericReply?.type === "resume") {
        command = numericReply;
      } else if (numericReply?.type === "clarify") {
        slot.awaitingBareTaskSelection = false;
        await this.queueWechatMessage(
          message.senderId,
          `我不确定数字“${numericReply.number}”对应哪个选项，没有把它发给模型。\n` +
            "选择任务：先发送“任务”，再回复序号。\n" +
            "处理审批：打开待审批任务后，按提示回复 1、2 或 3。",
        );
        return;
      }
    }
    if (command) {
      if (command.type !== "resume") {
        slot.awaitingBareTaskSelection = false;
      }
      const scopedCommand: DaemonSystemCommand = command.type === "resume" ||
          command.type === "resume_page"
        ? { ...command, taskListScope }
        : command;
      await this.handleSystemCommand(message, slot, scopedCommand);
      return;
    }
    slot.awaitingBareTaskSelection = false;
    const adapterState = slot.runtime.getState();
    const currentThreadId =
      adapterState.sharedThreadId ?? adapterState.sharedSessionId;
    const targetThreadId = slot.adapter === "codex"
      ? resolveCodexWechatReplyThreadId({
          currentThreadId,
          notifiedThreadId: slot.wechatReplyThreadId,
        })
      : currentThreadId;
    const currentPendingApproval = this.resolveTaskPendingApproval(
      slot,
      targetThreadId,
    );
    if (currentPendingApproval) {
      await this.queueWechatMessage(
        message.senderId,
        this.prefixSlotMessageWithMobileLink(
          slot,
          formatPendingApprovalReminder(
            currentPendingApproval,
            slot.runtime.getState(),
            { allowTaskAutoApprove: true },
          ),
          currentPendingApproval.threadId,
        ),
      );
      return;
    }

    const pendingUserInput = this.resolveTaskPendingUserInput(slot, targetThreadId);
    if (pendingUserInput) {
      await this.queueWechatMessage(
        message.senderId,
        this.prefixSlotMessageWithMobileLink(
          slot,
          formatPendingUserInputReminder(pendingUserInput),
          pendingUserInput.threadId,
        ),
      );
      return;
    }

    if (slot.adapter === "codex" && targetThreadId) {
      await this.dispatchInboundWechatText(message, slot, targetThreadId);
      return;
    }
    if (adapterState.status === "busy" || adapterState.status === "awaiting_approval") {
      await this.queueWechatMessage(
        message.senderId,
        this.prefixSlotMessage(
          slot,
          adapterState.status === "awaiting_approval"
            ? "任务正在等待审批。"
            : "任务仍在处理中，请等待完成。",
          this.getSlotThreadId(slot),
        ),
      );
      return;
    }

    await this.dispatchInboundWechatText(message, slot);
  }

  private async handleGlobalTaskInputWithoutActiveSlot(
    message: InboundWechatMessage,
  ): Promise<boolean> {
    if (this.getActiveSlot()) {
      return false;
    }

    const targeted = this.activeTaskListScope === "global" &&
        this.globalTaskListSnapshot
      ? resolveGlobalTaskTargetedMessage({
          text: message.text,
          snapshot: this.globalTaskListSnapshot,
        })
      : null;
    if (targeted) {
      try {
        await this.handleGlobalTaskTargetedMessage(message, targeted);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        appendDaemonLog(
          `global_task_targeted_send_error: adapter=${targeted.candidate.adapter} thread=${targeted.candidate.sessionId} error=${truncatePreview(detail, 400)}`,
        );
        await this.queueWechatMessage(message.senderId, detail, "inbound_error");
      }
      return true;
    }

    const taskListScope = resolveDaemonTaskListScope({
      text: message.text,
      activeScope: this.activeTaskListScope,
    });
    let command = resolveDaemonWechatCommand({
      adapter: "codex",
      text: message.text,
      awaitingBareTaskSelection: Boolean(this.globalTaskListSnapshot),
      hasPendingConfirmation: false,
      hasPendingUserInput: false,
    });
    if (!command && isExplicitGlobalTaskListRequest(message.text)) {
      try {
        const snapshot = this.globalTaskListSnapshot ?? buildGlobalTaskSnapshot(
          await this.listWechatGlobalTaskCandidates(),
        );
        const compactTarget = resolveCompactGlobalTaskSearchTarget(
          message.text,
          snapshot,
        );
        if (compactTarget) {
          this.globalTaskListSnapshot = snapshot;
          command = { type: "resume", target: compactTarget };
        }
      } catch (error) {
        appendDaemonLog(
          `global_compact_task_search_error: error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
      }
    }
    if (!command) {
      const numericReply = resolveDaemonBareNumericReply({
        text: message.text,
        taskListScope,
        globalSnapshot: this.globalTaskListSnapshot,
        adapterSnapshot: null,
      });
      if (numericReply?.type === "resume") {
        command = numericReply;
      } else if (numericReply?.type === "clarify") {
        await this.queueWechatMessage(
          message.senderId,
          `我不确定数字“${numericReply.number}”对应哪个选项，没有把它发给模型。\n` +
            "选择任务：先发送“任务”，再回复序号。",
        );
        return true;
      }
    }
    if (
      taskListScope !== "global" ||
      !command ||
      (command.type !== "resume" && command.type !== "resume_page")
    ) {
      return false;
    }
    await this.handleGlobalTaskCommand(message, {
      ...command,
      taskListScope: "global",
    });
    return true;
  }

  private async handleDaemonTaskTargetedMessage(
    message: InboundWechatMessage,
    slot: DaemonSlot,
    target: { candidate: BridgeResumeSessionCandidate; text: string },
  ): Promise<void> {
    const threadId = target.candidate.sessionId;
    slot.awaitingBareTaskSelection = false;
    await slot.outputBatcher.flushNow();
    slot.wechatReplyThreadId = threadId;
    if (slot.adapter === "codex") {
      this.persistCodexWechatThreadId(threadId);
    }
    slot.outputBatcher.clear();
    slot.controller.syncLocalClientEndpoint();
    appendDaemonLog(
      `wechat_resume_and_send: adapter=${slot.adapter} thread=${threadId} text=${truncatePreview(target.text)}`,
    );
    await this.dispatchInboundWechatText(
      { ...message, text: target.text },
      slot,
      threadId,
    );
  }

  private async handleSystemCommand(
    message: InboundWechatMessage,
    activeSlot: DaemonSlot,
    command: DaemonSystemCommand,
  ): Promise<void> {
    if (
      command.taskListScope === "global" &&
      (command.type === "resume" || command.type === "resume_page")
    ) {
      await this.handleGlobalTaskCommand(message, command);
      return;
    }
    if (command.type === "resume" || command.type === "resume_page") {
      this.activeTaskListScope = "adapter";
    }
    switch (command.type) {
      case "help":
        await this.queueWechatMessage(
          message.senderId,
          activeSlot.adapter === "codex"
            ? formatCodexWechatHelp()
            : [
                `${formatDaemonAdapterLabel(activeSlot.adapter)} 微信使用`,
                "查看任务：发送“任务”",
                "进入任务：回复序号",
                "指定任务发送：发送“数字：内容”（如：6：继续处理）",
                "搜索任务：发送“任务：关键词”",
                "新建任务：发送“新建：内容”",
                "继续对话：直接发送消息",
                "查看状态：发送“状态”",
                "停止任务：发送“停止”",
                "任务运行较久时，可打开消息中的网页版链接查看进展。",
              ].join("\n"),
        );
        return;
      case "status": {
        const threadId = activeSlot.adapter === "codex"
          ? resolveCodexWechatReplyThreadId({
              currentThreadId: this.getSlotThreadId(activeSlot),
              notifiedThreadId: activeSlot.wechatReplyThreadId,
            })
          : this.getSlotThreadId(activeSlot);
        await this.queueWechatMessage(
          message.senderId,
          this.prefixSlotMessageWithMobileLink(
            activeSlot,
            formatDaemonStatus(this.getStatus()),
            threadId,
          ),
        );
        return;
      }
      case "codex_reply_mode": {
        if (activeSlot.adapter !== "codex") {
          await this.queueWechatMessage(
            message.senderId,
            "全文模式仅用于 Codex 任务。",
          );
          return;
        }

        this.codexWechatReplyMode = command.mode;
        this.persistCodexWechatReplyMode(command.mode);
        const runtimeState = activeSlot.runtime.getState();
        const threadId = resolveCodexWechatReplyThreadId({
          currentThreadId: this.getSlotThreadId(activeSlot),
          notifiedThreadId: activeSlot.wechatReplyThreadId,
        });
        if (command.mode === "preview") {
          await this.queueWechatMessage(
            message.senderId,
            this.prefixSlotMessage(
              activeSlot,
              "已切换到预览模式。任务完成后发送内容预览和移动版链接。\n/full 可恢复全文模式。",
              threadId,
            ),
          );
          return;
        }

        const taskRunning = runtimeState.status === "busy" ||
          runtimeState.status === "awaiting_approval" ||
          runtimeState.status === "awaiting_input";
        await this.queueWechatMessage(
          message.senderId,
          this.prefixSlotMessage(
            activeSlot,
            taskRunning
              ? "已切换到全文模式。当前任务完成后会分段发送完整回答。\n/brief 可恢复预览模式。"
              : "已切换到全文模式。下面尝试发送当前任务最近的完整回答；以后任务完成时也会直接发送全文。\n/brief 可恢复预览模式。",
            threadId,
          ),
        );
        if (taskRunning || !threadId) {
          return;
        }

        try {
          const latestMessage = await this.readHistoricalLatestMessage(activeSlot, threadId);
          if (!latestMessage || latestMessage.role !== "assistant" || !latestMessage.text.trim()) {
            await this.queueWechatMessage(
              message.senderId,
              this.prefixSlotMessage(
                activeSlot,
                "当前任务还没有可显示的完整回答。",
                threadId,
              ),
            );
            return;
          }
          let title = "Codex 任务";
          try {
            const candidates = await this.getCodexTaskCandidates(activeSlot);
            title = candidates.find((candidate) => candidate.sessionId === threadId)?.title ?? title;
          } catch (error) {
            appendDaemonLog(
              `codex_full_mode_metadata_error: thread=${threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
            );
          }
          const texts = formatCurrentCodexFullReplyMessages({
            title,
            taskNumber: activeSlot.taskNumberByThreadId.get(threadId),
            text: latestMessage.text,
            url: this.codexMobileServer?.buildTaskUrl(threadId, activeSlot.adapter),
          });
          const sentCount = await this.queueWechatMessages(
            message.senderId,
            texts,
            "final_reply",
          );
          appendDaemonLog(
            `codex_full_mode_latest_sent: thread=${threadId} messages=${sentCount}/${texts.length}`,
          );
        } catch (error) {
          appendDaemonLog(
            `codex_full_mode_latest_error: thread=${threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
          );
          await this.queueWechatMessage(
            message.senderId,
            this.prefixSlotMessage(
              activeSlot,
              "全文模式已开启，但暂时无法读取当前任务的最近回答。",
              threadId,
            ),
          );
        }
        return;
      }
      case "resume_page": {
        const navigation = resolveCodexTaskListPageNavigation({
          direction: command.direction,
          current: activeSlot.taskListPosition,
          history: activeSlot.taskListHistory,
          ...(command.count ? { requestedPageSize: command.count } : {}),
        });
        await this.handleSystemCommand(message, activeSlot, {
          type: "resume",
          taskListPosition: navigation.current,
          taskListHistory: navigation.history,
          preserveTaskSnapshot: true,
        });
        return;
      }
      case "resume": {
        const commandStartedAtMs = Date.now();
        const pageSize = command.taskListPosition?.pageSize ?? CODEX_TASK_LIST_PAGE_SIZE;
        const page = command.page ?? 1;
        const pageStart = command.taskListPosition?.startIndex ??
          (page - 1) * CODEX_TASK_LIST_PAGE_SIZE;
        const numericTarget = command.target && /^\d+$/.test(command.target)
          ? Number(command.target)
          : null;
        const preserveSnapshot = command.preserveTaskSnapshot === true ||
          Boolean(command.target);
        const reusedSnapshot = Boolean(preserveSnapshot && activeSlot.taskListSnapshot);
        const snapshot = reusedSnapshot && activeSlot.taskListSnapshot
          ? activeSlot.taskListSnapshot
          : this.updateDaemonTaskListSnapshot(
              activeSlot,
              await this.getCodexTaskCandidates(activeSlot),
              true,
            );
        const candidates = snapshot.candidates;
        const runtimeState = activeSlot.runtime.getState();
        const currentSessionId = activeSlot.adapter === "codex"
          ? resolveCodexWechatReplyThreadId({
              currentThreadId: runtimeState.sharedSessionId ?? runtimeState.sharedThreadId,
              notifiedThreadId: activeSlot.wechatReplyThreadId,
            })
          : runtimeState.sharedSessionId ?? runtimeState.sharedThreadId;
        if (!command.target) {
          activeSlot.taskListPosition = { startIndex: pageStart, pageSize };
          activeSlot.taskListHistory = command.taskListHistory ?? Array.from(
            { length: Math.max(0, page - 1) },
            (_, index) => ({
              startIndex: index * CODEX_TASK_LIST_PAGE_SIZE,
              pageSize: CODEX_TASK_LIST_PAGE_SIZE,
            }),
          );
          const pageCandidates = candidates.slice(pageStart, pageStart + pageSize);
          activeSlot.awaitingBareTaskSelection = pageCandidates.length > 0;
          await this.queueWechatMessage(
            message.senderId,
            formatResumeSessionList({
              adapter: activeSlot.adapter,
              candidates: pageCandidates,
              currentSessionId,
              currentWorkerStatus: runtimeState.status,
              page,
              startIndex: pageStart,
              hasPrevious: pageStart > 0,
              hasMore: candidates.length > pageStart + pageSize,
            }),
          );
          appendDaemonLog(
            `wechat_task_list_sent: adapter=${activeSlot.adapter} duration_ms=${Date.now() - commandStartedAtMs} candidates=${pageCandidates.length} source=${reusedSnapshot ? "snapshot" : "cache_or_refresh"}`,
          );
          return;
        }

        const searchMatches = numericTarget === null
          ? searchResumeSessionCandidates(candidates, command.target)
          : [];
        const candidate = resolveResumeSessionCandidate(candidates, command.target);
        if (!candidate) {
          activeSlot.awaitingBareTaskSelection = true;
          await this.queueWechatMessage(
            message.senderId,
            searchMatches.length > 1
              ? formatResumeSessionSearchResults({
                  target: command.target,
                  matches: searchMatches,
                  currentSessionId,
                  currentWorkerStatus: runtimeState.status,
                })
              : [
                  `没有找到任务：${command.target}`,
                  formatResumeSessionList({
                    adapter: activeSlot.adapter,
                    candidates: candidates.slice(0, pageSize),
                    currentSessionId,
                    hasMore: candidates.length > pageSize,
                  }),
                ].join("\n\n"),
          );
          return;
        }

        activeSlot.awaitingBareTaskSelection = false;
        await activeSlot.outputBatcher.flushNow();
        if (activeSlot.adapter !== "codex" && !command.sessionAlreadyRestored) {
          await activeSlot.runtime.resumeSession(candidate.sessionId);
        }
        activeSlot.wechatReplyThreadId = candidate.sessionId;
        if (activeSlot.adapter === "codex") {
          this.persistCodexWechatThreadId(candidate.sessionId);
        }
        activeSlot.outputBatcher.clear();
        activeSlot.controller.syncLocalClientEndpoint();
        appendDaemonLog(
          `wechat_task_selected: adapter=${activeSlot.adapter} thread=${candidate.sessionId} cwd=${candidate.cwd ?? "(unknown)"}`,
        );
        const runSummaryPromise = activeSlot.runtime.getSessionRunSummary
          ? activeSlot.runtime.getSessionRunSummary(candidate.sessionId, {
              lightweight: true,
            }).catch((error) => {
              appendDaemonLog(
                `wechat_selection_run_summary_error: adapter=${activeSlot.adapter} thread=${candidate.sessionId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
              );
              return null;
            })
          : Promise.resolve(null);
        const latestMessagePromise = this.readHistoricalLatestMessage(
          activeSlot,
          candidate.sessionId,
        )
          .then((message) => ({ message, error: null as unknown }))
          .catch((error) => ({ message: null, error }));
        const [runSummary, latestResult] = await Promise.all([
          runSummaryPromise,
          latestMessagePromise,
        ]);
        await this.queueWechatMessage(
          message.senderId,
          this.prefixSlotMessageWithMobileLink(
            activeSlot,
            formatCodexDesktopTaskSelection(
              candidate,
              runSummary,
            ),
            candidate.sessionId,
          ),
        );
        if (!latestResult.error) {
          await this.queueWechatMessage(
            message.senderId,
            this.prefixSlotMessage(
              activeSlot,
              formatCodexDesktopTaskLatestMessage(
                latestResult.message,
                formatDaemonAdapterLabel(activeSlot.adapter),
              ),
              candidate.sessionId,
            ),
          );
        } else {
          appendDaemonLog(
            `wechat_selection_latest_message_error: adapter=${activeSlot.adapter} thread=${candidate.sessionId} error=${truncatePreview(latestResult.error instanceof Error ? latestResult.error.message : String(latestResult.error), 400)}`,
          );
          await this.queueWechatMessage(
            message.senderId,
            this.prefixSlotMessage(
              activeSlot,
              "已进入任务，但暂时无法读取最近一条消息。",
              candidate.sessionId,
            ),
          );
        }
        appendDaemonLog(
          `wechat_task_selected_sent: adapter=${activeSlot.adapter} thread=${candidate.sessionId} duration_ms=${Date.now() - commandStartedAtMs} source=${reusedSnapshot ? "snapshot" : "cache_or_refresh"}`,
        );
        return;
      }
      case "new_session": {
        const previousThreadId = this.getSlotThreadId(activeSlot);
        const label = formatDaemonAdapterLabel(activeSlot.adapter);
        try {
          if (!activeSlot.runtime.createSession) {
            throw new Error("当前连接暂不支持新建任务。");
          }
          await activeSlot.runtime.createSession();
        } catch (error) {
          const detail = truncatePreview(
            error instanceof Error ? error.message : String(error),
            180,
          );
          await this.queueWechatMessage(
            message.senderId,
            `新建${label}任务失败：${detail}`,
          );
          return;
        }

        let threadId = this.getSlotThreadId(activeSlot);
        if (threadId === previousThreadId) threadId = undefined;

        activeSlot.awaitingBareTaskSelection = false;
        activeSlot.wechatReplyThreadId = threadId;
        activeSlot.controller.syncLocalClientEndpoint();
        activeSlot.taskCandidatesCache = null;
        activeSlot.taskCandidatesCachedAtMs = 0;

        const persistCreatedThread = (createdThreadId: string | undefined): void => {
          if (!createdThreadId) return;
          activeSlot.wechatReplyThreadId = createdThreadId;
          this.persistAdapterSessionId(activeSlot.adapter, createdThreadId);
          if (activeSlot.adapter === "codex") {
            this.persistCodexThreadId(createdThreadId);
            this.persistCodexWechatThreadId(createdThreadId);
          }
        };
        persistCreatedThread(threadId);

        if (command.input) {
          try {
            await this.dispatchInboundWechatText(
              { ...message, text: command.input },
              activeSlot,
              threadId,
              { suppressCodexAcceptedNotice: true },
            );
            threadId = this.getSlotThreadId(activeSlot) ?? threadId;
            persistCreatedThread(threadId);
          } catch (error) {
            threadId = this.getSlotThreadId(activeSlot) ?? threadId;
            persistCreatedThread(threadId);
            const detail = truncatePreview(
              error instanceof Error ? error.message : String(error),
              180,
            );
            const failureText = [
              `已新建 ${label} 任务，但第一条消息发送失败。`,
              detail,
              "可直接再次发送消息重试。",
            ].join("\n");
            await this.queueWechatMessage(
              message.senderId,
              threadId
                ? this.prefixSlotMessageWithMobileLink(
                    activeSlot,
                    failureText,
                    threadId,
                  )
                : `[${label} · 新任务]\n${failureText}`,
              "inbound_error",
            );
            appendDaemonLog(
              `new_session_input_error: adapter=${activeSlot.adapter} thread=${threadId ?? "pending"} error=${truncatePreview(detail, 400)}`,
            );
            return;
          }
        }

        if (threadId) {
          persistCreatedThread(threadId);
          try {
            const candidates = await activeSlot.runtime.listResumeSessions(100);
            this.rememberCodexTaskCandidates(activeSlot, candidates);
            const created = candidates.find((candidate) => candidate.sessionId === threadId);
            if (created && activeSlot.taskListSnapshot &&
                !activeSlot.taskListSnapshot.numberByThreadId.has(threadId)) {
              const nextNumber = activeSlot.taskListSnapshot.candidates.length + 1;
              activeSlot.taskListSnapshot.candidates.push(created);
              activeSlot.taskListSnapshot.numberByThreadId.set(threadId, nextNumber);
              activeSlot.taskNumberByThreadId.set(threadId, nextNumber);
            }
          } catch (error) {
            appendDaemonLog(
              `new_session_task_refresh_error: adapter=${activeSlot.adapter} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
            );
          }
        }

        const readyText = command.input
          ? [
              `已新建 ${label} 任务并开始处理。`,
              `本次任务：${truncatePreview(command.input, 140)}`,
            ].join("\n")
          : [
              `已新建 ${label} 任务。`,
              threadId
                ? "直接发送消息即可开始。"
                : "直接发送消息即可开始；第一条消息发出后会生成任务编号。",
            ].join("\n");
        await this.queueWechatMessage(
          message.senderId,
          threadId
            ? this.prefixSlotMessageWithMobileLink(activeSlot, readyText, threadId)
            : `[${label} · 新任务]\n${readyText}`,
        );
        appendDaemonLog(
          `new_session: adapter=${activeSlot.adapter} thread=${threadId ?? "pending"} input=${command.input ? "yes" : "no"}`,
        );
        return;
      }
      case "stop": {
        const currentThreadId = activeSlot.adapter === "codex"
          ? resolveCodexWechatReplyThreadId({
              currentThreadId: this.getSlotThreadId(activeSlot),
              notifiedThreadId: activeSlot.wechatReplyThreadId,
            })
          : this.getSlotThreadId(activeSlot);
        const interrupted = activeSlot.adapter === "codex" && currentThreadId
          ? await (activeSlot.runtime.interruptSession?.(currentThreadId) ??
              activeSlot.runtime.interrupt())
          : await activeSlot.runtime.interrupt();
        await this.queueWechatMessage(
          message.senderId,
          this.prefixSlotMessageWithMobileLink(
            activeSlot,
            interrupted
              ? t("bridge.interrupt.sent")
              : t("bridge.interrupt.notBusy"),
            currentThreadId,
          ),
        );
        return;
      }
      case "reset": {
        const resetThreadId = activeSlot.adapter === "codex"
          ? resolveCodexWechatReplyThreadId({
              currentThreadId: this.getSlotThreadId(activeSlot),
              notifiedThreadId: activeSlot.wechatReplyThreadId,
            })
          : this.getSlotThreadId(activeSlot);
        await activeSlot.outputBatcher.flushNow();
        activeSlot.outputBatcher.clear();
        activeSlot.pendingConfirmations = [];
        activeSlot.notifiedApprovalKeys.clear();
        this.clearTaskApprovalAutoApprovals(activeSlot);
        activeSlot.pendingUserInputs = [];
        this.clearDeferredCodexInboundMessages(activeSlot);
        await activeSlot.runtime.reset();
        if (activeSlot.adapter === "codex") {
          this.persistCodexThreadId(this.getSlotThreadId(activeSlot));
        }
        appendDaemonLog(`reset: adapter=${activeSlot.adapter}`);
        await this.queueWechatMessage(
          message.senderId,
          this.prefixSlotMessageWithMobileLink(
            activeSlot,
            "会话已重置。",
            resetThreadId,
          ),
        );
        return;
      }
      case "confirm":
        await this.confirmPendingApproval(message, activeSlot, false);
        return;
      case "confirm_session":
        await this.confirmPendingApproval(message, activeSlot, true);
        return;
      case "confirm_task":
        await this.enableTaskApprovalAutoConfirm(message, activeSlot);
        return;
      case "deny":
        await this.denyPendingApproval(message, activeSlot);
        return;
      case "answer":
        await this.answerPendingUserInput(message, activeSlot, command.raw);
        return;
    }
  }

  private resolveTaskApprovalIdentity(
    slot: DaemonSlot,
    pending: Pick<ApprovalRequest, "threadId" | "turnId">,
    event?: { threadId?: string; turnId?: string },
  ): DaemonTaskApprovalIdentity {
    const runtimeState = slot.runtime.getState();
    const selectedThreadId =
      runtimeState.sharedThreadId ?? runtimeState.sharedSessionId;
    const threadId = pending.threadId ?? event?.threadId ?? selectedThreadId;
    const activeTask = this.getSlotActiveTask(slot, threadId);
    const turnId =
      pending.turnId ??
      event?.turnId ??
      activeTask?.turnId ??
      (threadId === selectedThreadId ? runtimeState.activeTurnId : undefined);
    return {
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
    };
  }

  private recordMobileApprovalResult(
    slot: DaemonSlot,
    pending: ApprovalRequest,
    action: CodexMobileApprovalResultAction,
    event?: { threadId?: string; turnId?: string },
  ): CodexMobileApprovalResult | null {
    const identity = this.resolveTaskApprovalIdentity(slot, pending, event);
    const threadId = identity.threadId;
    if (!threadId) {
      appendDaemonLog(
        `mobile_approval_result_skipped: adapter=${slot.adapter} action=${action} reason=missing_thread`,
      );
      return null;
    }
    const result: CodexMobileApprovalResult = {
      id: randomUUID(),
      action,
      summary: pending.summary,
      commandPreview: redactSensitiveCommandText(pending.commandPreview),
      resolvedAt: nowIso(),
      ...(identity.turnId ? { turnId: identity.turnId } : {}),
      ...(typeof pending.createdAt === "string"
        ? { requestedAt: pending.createdAt }
        : {}),
      ...(pending.detailLabel ? { detailLabel: pending.detailLabel } : {}),
      ...(pending.detailPreview
        ? { detailPreview: redactSensitiveCommandText(pending.detailPreview) }
        : {}),
    };
    this.stateStore.recordMobileApprovalResult({
      ...result,
      adapter: slot.adapter,
      threadId,
    });
    return result;
  }

  private formatPendingApprovalTargetLabel(
    slot: DaemonSlot,
    pending: PendingApproval,
  ): string {
    return this.prefixSlotMessage(slot, "", pending.threadId) ||
      `[${formatDaemonAdapterLabel(slot.adapter)}]`;
  }

  private removeResolvedPendingConfirmation(
    slot: DaemonSlot,
    pending: PendingApproval,
    resolvedCount: number,
    exactRequest: boolean,
  ): void {
    const notificationKey = buildDaemonApprovalNotificationKey(pending);
    const cancelCandidate = (candidate: PendingApproval): void => {
      this.approvalNotificationDeliveries.cancel(
        buildDaemonApprovalDeliveryKey(slot.adapter, candidate),
      );
    };
    if (exactRequest || resolvedCount === 1) {
      for (const candidate of slot.pendingConfirmations) {
        if (buildDaemonApprovalNotificationKey(candidate) === notificationKey) {
          cancelCandidate(candidate);
        }
      }
      slot.pendingConfirmations = slot.pendingConfirmations.filter(
        (candidate) =>
          buildDaemonApprovalNotificationKey(candidate) !== notificationKey,
      );
      return;
    }
    for (const candidate of slot.pendingConfirmations) {
      if (pending.threadId ? candidate.threadId === pending.threadId : candidate === pending) {
        cancelCandidate(candidate);
      }
    }
    slot.pendingConfirmations = pending.threadId
      ? slot.pendingConfirmations.filter(
          (candidate) => candidate.threadId !== pending.threadId,
        )
      : slot.pendingConfirmations.filter((candidate) => candidate !== pending);
  }

  private async resolvePendingApprovalTarget(
    target: DaemonPendingApprovalTarget,
    resolution: DaemonApprovalShortcutResolution,
  ): Promise<number> {
    const { slot, pending } = target;
    const identity = this.resolveTaskApprovalIdentity(slot, pending);
    const enableTaskAutoApprove = resolution.action === "confirm_task";
    if (enableTaskAutoApprove && !this.enableTaskApprovalAutoApprove(slot, identity)) {
      return 0;
    }

    const runtimeAction = resolution.action === "confirm_task"
      ? "confirm"
      : resolution.action;
    const exactRequest = Boolean(
      resolution.action !== "confirm_task" &&
      pending.requestId &&
      slot.runtime.resolveApprovalRequest
    );
    const count = exactRequest
      ? await slot.runtime.resolveApprovalRequest!(pending.requestId!, runtimeAction)
        ? 1
        : 0
      : pending.threadId && slot.runtime.resolveTaskApprovals
        ? await slot.runtime.resolveTaskApprovals(pending.threadId, runtimeAction)
        : runtimeAction === "confirm_session"
          ? await (
              slot.runtime.resolveAllApprovalsForSession?.() ?? Promise.resolve(0)
            )
          : await slot.runtime.resolveAllApprovals(
              runtimeAction === "deny" ? "deny" : "confirm",
            );
    if (!count) {
      if (enableTaskAutoApprove) {
        this.finishTaskApprovalAutoApprove(slot, identity);
      }
      return 0;
    }

    this.removeResolvedPendingConfirmation(slot, pending, count, exactRequest);
    if (resolution.action !== "deny") {
      this.setSlotActiveTask(
        slot,
        {
          startedAt: Date.now(),
          inputPreview: redactSensitiveCommandText(pending.commandPreview),
          ...(identity.turnId ? { turnId: identity.turnId } : {}),
        },
        identity.threadId,
      );
    }
    this.recordMobileApprovalResult(slot, pending, resolution.action, {
      ...(identity.threadId ? { threadId: identity.threadId } : {}),
      ...(identity.turnId ? { turnId: identity.turnId } : {}),
    });
    appendDaemonLog(
      `approval_resolved: adapter=${slot.adapter} action=${resolution.action} thread=${identity.threadId ?? "unknown"} turn=${identity.turnId ?? "unknown"} count=${count} command=${truncatePreview(pending.commandPreview)}`,
    );
    return count;
  }

  private async handlePendingApprovalSequence(
    message: InboundWechatMessage,
    shortcuts: DaemonApprovalShortcut[],
    pendingTargets: DaemonPendingApprovalTarget[],
  ): Promise<void> {
    if (shortcuts.length > pendingTargets.length) {
      await this.queueWechatMessage(
        message.senderId,
        `当前只有 ${pendingTargets.length} 项待审批，收到了 ${shortcuts.length} 个序号；本组未执行。`,
      );
      return;
    }

    const selectedTargets = pendingTargets.slice(0, shortcuts.length);
    const resolutions = shortcuts.map((shortcut, index) =>
      resolveDaemonApprovalShortcut(selectedTargets[index]!.pending, shortcut)
    );
    const invalidIndex = resolutions.findIndex((resolution) => !resolution);
    if (invalidIndex >= 0) {
      await this.queueWechatMessage(
        message.senderId,
        `第 ${invalidIndex + 1} 项审批不支持序号 ${shortcuts[invalidIndex]}；本组未执行。`,
      );
      return;
    }
    const taskAutoConflictIndex = resolutions.findIndex((resolution, index) =>
      resolution?.action === "confirm_task" &&
      selectedTargets.slice(index + 1).some((candidate) =>
        candidate.slot === selectedTargets[index]!.slot &&
        candidate.pending.threadId &&
        candidate.pending.threadId === selectedTargets[index]!.pending.threadId
      )
    );
    if (taskAutoConflictIndex >= 0) {
      await this.queueWechatMessage(
        message.senderId,
        `第 ${taskAutoConflictIndex + 1} 项选择“今日内本任务免审”会同时接受该任务的其他审批；请单独回复这个序号。`,
      );
      return;
    }

    const lines: string[] = [];
    for (let index = 0; index < selectedTargets.length; index += 1) {
      const target = selectedTargets[index]!;
      const shortcut = shortcuts[index]!;
      const resolution = resolutions[index]!;
      const count = await this.resolvePendingApprovalTarget(target, resolution);
      const targetLabel = this.formatPendingApprovalTargetLabel(
        target.slot,
        target.pending,
      );
      lines.push(
        `第 ${index + 1} 项 ${targetLabel}：序号 ${shortcut}（${resolution.label}）` +
        (count > 0
          ? count > 1
            ? `，已处理 ${count} 个审批。`
            : "，已处理。"
          : "，处理失败。"),
      );
    }

    appendDaemonLog(
      `approval_sequence_resolved: shortcuts=${shortcuts.join(",")} results=${lines.length}`,
    );
    await this.queueWechatMessage(
      message.senderId,
      [`已按顺序处理 ${lines.length} 项审批：`, ...lines].join("\n"),
    );
  }

  private async enableTaskApprovalAutoConfirm(
    message: InboundWechatMessage,
    activeSlot: DaemonSlot,
  ): Promise<void> {
    const target = this.resolveNextPendingApprovalTarget(activeSlot);
    if (!target) {
      await this.queueWechatMessage(message.senderId, t("approval.noPending"));
      return;
    }

    const count = await this.resolvePendingApprovalTarget(target, {
      action: "confirm_task",
      label: "今日内本任务免审",
    });
    if (!count) {
      await this.queueWechatMessage(
        message.senderId,
        this.prefixSlotMessageWithMobileLink(
          target.slot,
          "无法确认这项审批，请稍后重试。",
          target.pending.threadId,
        ),
      );
      return;
    }

    await this.queueWechatMessage(
      message.senderId,
      this.prefixSlotMessageWithMobileLink(
        target.slot,
        t("approval.taskAutoApproveEnabled"),
        target.pending.threadId,
      ),
    );
  }

  private async confirmPendingApproval(
    message: InboundWechatMessage,
    activeSlot: DaemonSlot,
    confirmForSession: boolean,
  ): Promise<void> {
    const target = this.resolveNextPendingApprovalTarget(activeSlot);
    if (!target) {
      await this.queueWechatMessage(message.senderId, t("approval.noPending"));
      return;
    }

    const resolution: DaemonApprovalShortcutResolution = confirmForSession
      ? { action: "confirm_session", label: "本任务始终允许" }
      : { action: "confirm", label: "允许本次" };
    const count = await this.resolvePendingApprovalTarget(target, resolution);
    if (!count) {
      await this.queueWechatMessage(
        message.senderId,
        this.prefixSlotMessageWithMobileLink(
          target.slot,
          confirmForSession
            ? "这项审批不支持本任务始终允许，请回复 1 允许本次或回复 2 拒绝。"
            : "无法确认这项审批，请稍后重试。",
          target.pending.threadId,
        ),
      );
      return;
    }

    await this.queueWechatMessage(
      message.senderId,
      this.prefixSlotMessageWithMobileLink(
        target.slot,
        count > 1
          ? t(
              confirmForSession
                ? "approval.batchSessionConfirmed"
                : "approval.batchConfirmed",
              { count },
            )
          : t(
              confirmForSession
                ? "approval.sessionConfirmed"
                : "approval.confirmed",
            ),
        target.pending.threadId,
      ),
    );
  }

  private async denyPendingApproval(
    message: InboundWechatMessage,
    activeSlot: DaemonSlot,
  ): Promise<void> {
    const target = this.resolveNextPendingApprovalTarget(activeSlot);
    if (!target) {
      await this.queueWechatMessage(message.senderId, t("approval.noPending"));
      return;
    }

    const count = await this.resolvePendingApprovalTarget(target, {
      action: "deny",
      label: "拒绝",
    });
    if (!count) {
      await this.queueWechatMessage(
        message.senderId,
        this.prefixSlotMessageWithMobileLink(
          target.slot,
          "无法拒绝这项审批，请稍后重试。",
          target.pending.threadId,
        ),
      );
      return;
    }

    await this.queueWechatMessage(
      message.senderId,
      this.prefixSlotMessageWithMobileLink(
        target.slot,
        count > 1
          ? t("approval.batchDenied", { count })
          : t("approval.denied"),
        target.pending.threadId,
      ),
    );
  }

  private async answerPendingUserInput(
    message: InboundWechatMessage,
    activeSlot: DaemonSlot,
    raw: string,
  ): Promise<void> {
    const pending = this.resolvePendingUserInput(activeSlot);
    if (!pending) {
      await this.queueWechatMessage(
        message.senderId,
        "没有待回答的问题。",
      );
      return;
    }

    const parsed = parsePendingUserInputAnswerCommand(raw, pending);
    if ("error" in parsed) {
      await this.queueWechatMessage(
        message.senderId,
        this.prefixSlotMessageWithMobileLink(
          activeSlot,
          parsed.error,
          pending.threadId,
        ),
      );
      return;
    }

    const submitted =
      pending.threadId && activeSlot.runtime.submitTaskUserInput
        ? await activeSlot.runtime.submitTaskUserInput(
            pending.threadId,
            parsed.answers,
          )
        : await activeSlot.runtime.submitUserInput(parsed.answers);
    if (!submitted) {
      await this.queueWechatMessage(
        message.senderId,
        this.prefixSlotMessageWithMobileLink(
          activeSlot,
          "答案提交失败，请重试。",
          pending.threadId,
        ),
      );
      return;
    }

    activeSlot.pendingUserInputs = activeSlot.pendingUserInputs.filter(
      (candidate) => candidate !== pending,
    );
    this.setSlotActiveTask(
      activeSlot,
      {
        startedAt: Date.now(),
        inputPreview: parsed.preview,
        ...(pending.turnId ? { turnId: pending.turnId } : {}),
      },
      pending.threadId,
    );
    appendDaemonLog(
      `user_input_answered: adapter=${activeSlot.adapter} preview=${parsed.preview}`,
    );
    await this.queueWechatMessage(
      message.senderId,
      this.prefixSlotMessageWithMobileLink(
        activeSlot,
        "答案已提交，继续处理。",
        pending.threadId,
      ),
    );
  }

  private resolveTrackedPendingApproval(
    slot: DaemonSlot,
    pending: DaemonPendingApproval,
  ): DaemonPendingApproval | null {
    if (slot.adapter !== "codex" || !slot.runtime.getPendingTaskApprovals) {
      return pending;
    }
    if (!pending.threadId) {
      return null;
    }
    const notificationKey = buildDaemonApprovalNotificationKey(pending);
    const runtimePending = slot.runtime.getPendingTaskApprovals(pending.threadId)
      .find((candidate) =>
        buildDaemonApprovalNotificationKey(candidate) === notificationKey
      );
    if (!runtimePending) {
      return null;
    }
    return {
      ...runtimePending,
      code: pending.code,
      createdAt: pending.createdAt,
      ...(pending.notificationOrder !== undefined
        ? { notificationOrder: pending.notificationOrder }
        : {}),
    };
  }

  private listPendingApprovalTargets(): DaemonPendingApprovalTarget[] {
    const targets: DaemonPendingApprovalTarget[] = [];
    let insertionOrder = 0;
    for (const slot of this.slots.values()) {
      const remaining: DaemonPendingApproval[] = [];
      for (const pending of slot.pendingConfirmations) {
        const resolved = this.resolveTrackedPendingApproval(slot, pending);
        if (!resolved) {
          continue;
        }
        remaining.push(resolved);
        targets.push({ slot, pending: resolved, insertionOrder: insertionOrder++ });
      }
      slot.pendingConfirmations = remaining;
    }
    return targets.sort((left, right) => compareDaemonApprovalQueueOrder(
      {
        createdAt: left.pending.createdAt,
        notificationOrder: left.pending.notificationOrder,
        insertionOrder: left.insertionOrder,
      },
      {
        createdAt: right.pending.createdAt,
        notificationOrder: right.pending.notificationOrder,
        insertionOrder: right.insertionOrder,
      },
    ));
  }

  private resolveNextPendingApprovalTarget(
    activeSlot: DaemonSlot,
  ): DaemonPendingApprovalTarget | null {
    const queued = this.listPendingApprovalTargets()[0];
    if (queued) {
      return queued;
    }

    const activePending = this.resolvePendingApproval(activeSlot);
    if (activePending) {
      return { slot: activeSlot, pending: activePending, insertionOrder: 0 };
    }
    for (const slot of this.slots.values()) {
      if (slot === activeSlot) continue;
      const pending = this.resolvePendingApproval(slot);
      if (pending) {
        return { slot, pending, insertionOrder: 0 };
      }
    }
    return null;
  }

  private resolvePendingApprovalSlot(
    activeSlot: DaemonSlot,
  ): DaemonSlot | null {
    return this.resolveNextPendingApprovalTarget(activeSlot)?.slot ?? null;
  }

  private getActiveSlot(): DaemonSlot | null {
    if (!this.activeAdapter) {
      return null;
    }
    return this.slots.get(this.activeAdapter) ?? null;
  }

  private startCodexTaskMonitor(slot: DaemonSlot): void {
    if (slot.adapter !== "codex" || this.codexTaskMonitorTimer || this.codexTaskMonitorRunning) {
      return;
    }
    void this.runCodexTaskMonitor(slot);
  }

  private async runCodexTaskMonitor(slot: DaemonSlot): Promise<void> {
    if (this.shutdownPromise || this.codexTaskMonitorRunning) {
      return;
    }
    this.codexTaskMonitorRunning = true;
    try {
      const candidates = await this.getCodexTaskCandidates(slot, {
        forceRefresh: true,
      });
      const nowMs = Date.now();
      for (const candidate of candidates) {
        if (
          shouldFollowCodexActiveTask(candidate.runtimeStatus) &&
          slot.runtime.followSession
        ) {
          try {
            await slot.runtime.followSession(candidate.sessionId);
          } catch (error) {
            appendDaemonLog(
              `codex_task_follow_error: thread=${candidate.sessionId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
            );
          }
        } else if (slot.runtime.unfollowSession) {
          try {
            await slot.runtime.unfollowSession(candidate.sessionId);
          } catch (error) {
            appendDaemonLog(
              `codex_task_unfollow_error: thread=${candidate.sessionId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
            );
          }
        }
        const previous = this.codexTaskObservations.get(candidate.sessionId) ?? null;
        const observed = observeCodexTask(previous, candidate, nowMs);
        const runningNow = observed.observation.status === "running" ||
          observed.observation.status === "approval" ||
          observed.observation.status === "input";
        const wasRunning = previous?.status === "running" ||
          previous?.status === "approval" ||
          previous?.status === "input";
        if (runningNow && !wasRunning) {
          this.codexFinalReplyByThreadId.delete(candidate.sessionId);
        }
        const ownerSettled = candidate.runtimeStatus?.type === "idle" ||
          candidate.runtimeStatus?.type === "systemError";
        if (ownerSettled) {
          this.clearSlotTaskState(slot, candidate.sessionId);
        }
        const idleRecencyChanged = Boolean(
          ownerSettled &&
          previous &&
          !runningNow &&
          !wasRunning &&
          previous.lastUpdatedAt !== candidate.lastUpdatedAt,
        );
        if (idleRecencyChanged) {
          observed.observation.completionNotified = true;
        }
        this.codexTaskObservations.set(candidate.sessionId, observed.observation);
        if (
          !runningNow &&
          slot.deferredInboundMessages.count(candidate.sessionId) > 0
        ) {
          void this.maybeDrainDeferredCodexInboundMessages(
            slot,
            candidate.sessionId,
          );
        }
        const completion = observed.completion ?? (idleRecencyChanged
          ? {
              outcome: observed.observation.status === "error"
                ? "failed" as const
                : "completed" as const,
              startedAtMs: nowMs - CODEX_TASK_MONITOR_INTERVAL_MS,
            }
          : undefined);
        if (!completion) {
          continue;
        }
        let completionRunSummary: BridgeSessionRunSummary | null = null;
        let completionLatestMessage: BridgeSessionMessage | null = null;
        try {
          completionRunSummary = slot.runtime.getSessionRunSummary
            ? await slot.runtime.getSessionRunSummary(candidate.sessionId, { lightweight: true })
            : null;
          completionLatestMessage = slot.runtime.getLatestSessionMessage
            ? await slot.runtime.getLatestSessionMessage(candidate.sessionId)
            : null;
        } catch (error) {
          appendDaemonLog(
            `codex_completion_evidence_error: thread=${candidate.sessionId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
          );
        }
        if (!shouldSendCodexCompletionNotification({
          runSummary: completionRunSummary,
          latestMessage: completionLatestMessage,
        })) {
          observed.observation.completionNotified = false;
          this.codexTaskObservations.set(candidate.sessionId, observed.observation);
          appendDaemonLog(
            `codex_completion_without_final_suppressed: thread=${candidate.sessionId} summary=${completionRunSummary?.status ?? "missing"} latest=${completionLatestMessage?.role ?? "missing"}`,
          );
          continue;
        }
        try {
          await this.recordRecentTaskCompletion(slot, {
            threadId: candidate.sessionId,
            title: candidate.title,
            completedAt: candidate.lastUpdatedAt,
            outcome: completion.outcome,
          });
        } catch (error) {
          appendDaemonLog(
            `mobile_task_completion_record_error: adapter=${slot.adapter} thread=${candidate.sessionId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
          );
        }
        this.trackWechatForwardTask(this.sendCodexTaskCompletionMessage(slot, {
          threadId: candidate.sessionId,
          title: candidate.title,
          outcome: completion.outcome,
          completedAt: candidate.lastUpdatedAt,
          startedAtMs: completion.startedAtMs,
        }));
      }
    } catch (error) {
      appendDaemonLog(
        `codex_task_monitor_error: error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
      );
    } finally {
      this.codexTaskMonitorRunning = false;
      const currentSlot = this.slots.get("codex");
      if (!this.shutdownPromise && currentSlot) {
        this.codexTaskMonitorTimer = setTimeout(() => {
          this.codexTaskMonitorTimer = null;
          const nextSlot = this.slots.get("codex");
          if (nextSlot) {
            void this.runCodexTaskMonitor(nextSlot);
          }
        }, CODEX_TASK_MONITOR_INTERVAL_MS);
        this.codexTaskMonitorTimer.unref?.();
      }
    }
  }

  private resolveMobileAdapter(adapter?: string): DaemonAdapterKind {
    const requested = adapter?.trim() || this.activeAdapter || "codex";
    if (!isDaemonAdapterKind(requested)) {
      throw new Error("不支持这个应用。");
    }
    return requested;
  }

  private getMobileSlot(adapter?: string): DaemonSlot {
    const resolvedAdapter = this.resolveMobileAdapter(adapter);
    const slot = this.slots.get(resolvedAdapter);
    if (!slot) {
      throw new MobileAdapterUnavailableError(
        `${formatDaemonAdapterLabel(resolvedAdapter)} 尚未连接。`,
      );
    }
    return slot;
  }

  private listMobileAdapters(): {
    activeAdapter?: string;
    adapters: Array<{ id: string; label: string; status: string; active: boolean }>;
  } {
    const openAdapters = readOpenMobileAdapters(this.cwd);
    return {
      ...(this.activeAdapter ? { activeAdapter: this.activeAdapter } : {}),
      adapters: DAEMON_ADAPTERS.map((adapter) => {
        const slotStatus = this.slots.get(adapter)?.runtime.getState().status;
        const endpoint = slotStatus
          ? null
          : readLocalCompanionEndpoint(this.cwd, { adapter });
        const endpointCompanionAlive = Boolean(
          endpoint?.companionPid && isPidAlive(endpoint.companionPid),
        );
        return {
          id: adapter,
          label: formatDaemonAdapterLabel(adapter),
          status: resolveMobileAdapterDisplayStatus({
            ...(slotStatus ? { slotStatus } : {}),
            ...(endpoint?.companionStatus
              ? { endpointStatus: endpoint.companionStatus }
              : {}),
            endpointCompanionAlive,
            visibleClientOpen: openAdapters.has(adapter),
          }),
          active: adapter === this.activeAdapter,
          capabilities: { ...getBridgeProvider(adapter).capabilities },
        };
      }),
    };
  }

  private async buildMobileSettings(): Promise<CodexMobileSettings> {
    const firstSlot = this.slots.values().next().value as DaemonSlot | undefined;
    return {
      strictApproval: this.strictApprovalEnabled,
      approvalRules: (firstSlot?.approvalRuleChain.list() ?? []).map((rule) => ({
        id: rule.id,
        label: rule.label,
        description: rule.description,
      })),
      providers: await buildMobileProviderSettings(listDaemonProviders(), {
        installManager: this.mobileProviderInstallManager,
      }),
    };
  }

  private async updateMobileSettings(patch: {
    strictApproval?: boolean;
  }): Promise<CodexMobileSettings> {
    if (typeof patch.strictApproval === "boolean") {
      this.runtimeStrictApproval = patch.strictApproval;
      appendDaemonLog(
        `settings_updated: strict_approval=${patch.strictApproval} (runtime override)`,
      );
    }
    return await this.buildMobileSettings();
  }

  private installMobileProviderDependency(
    providerId: string,
    dependencyId: string,
  ) {
    const result = this.mobileProviderInstallManager.start(providerId, dependencyId);
    appendDaemonLog(
      `provider_install_started: provider=${providerId} dependency=${dependencyId}`,
    );
    return result;
  }

  private async switchMobileAdapter(adapter: string): Promise<{
    activeAdapter: string;
    activated: boolean;
    detail: string;
  }> {
    const resolvedAdapter = this.resolveMobileAdapter(adapter);
    const result = await this.ensureSlot(resolvedAdapter, {
      openVisible: true,
      reuseExistingVisible: true,
      activate: false,
      userInitiated: true,
    });
    const detail = formatDaemonSwitchResultDetail(result);
    if (!result.activated) {
      throw new Error(detail);
    }
    return {
      activeAdapter: resolvedAdapter,
      activated: true,
      detail,
    };
  }

  private resolveMobileTaskStatus(
    slot: DaemonSlot,
    threadId: string,
    runtimeStatus: BridgeResumeSessionRuntimeStatus | undefined,
  ): CodexMobileTaskStatus {
    const currentThreadId = this.getSlotThreadId(slot);
    const runtimeTaskApprovals = slot.runtime.getPendingTaskApprovals?.(threadId);
    return resolveCodexMobileTaskStatusFromSignals({
      runtimeStatus,
      hasPendingApproval: slot.pendingConfirmations.some(
        (pending) => pending.threadId === threadId
      ),
      ...(runtimeTaskApprovals !== undefined ? { runtimeTaskApprovals } : {}),
      hasPendingUserInput: slot.pendingUserInputs.some(
        (pending) => pending.threadId === threadId
      ),
      hasActiveTask: Boolean(this.getSlotActiveTask(slot, threadId)),
      selectedStateStatus: currentThreadId === threadId
        ? slot.runtime.getState().status
        : undefined,
    });
  }

  private async listMobileTasks(adapter?: string): Promise<CodexMobileTask[]> {
    const slot = this.getMobileSlot(adapter);
    let candidates: BridgeResumeSessionCandidate[];
    try {
      candidates = slot.adapter === "codex"
        ? await this.getCodexTaskCandidates(slot)
        : await slot.runtime.listResumeSessions(100);
    } catch (error) {
      const unavailableMessage = formatMobileTaskListUnavailableMessage(
        slot.adapter,
        error,
      );
      if (unavailableMessage) {
        throw new MobileAdapterUnavailableError(unavailableMessage);
      }
      throw error;
    }
    const selectedThreadId = this.getSlotThreadId(slot);
    return candidates.map((candidate) => {
      const status = this.resolveMobileTaskStatus(
        slot,
        candidate.sessionId,
        candidate.runtimeStatus,
      );
      const activeTask = this.getSlotActiveTask(slot, candidate.sessionId);
      const observation = slot.adapter === "codex"
        ? this.codexTaskObservations.get(candidate.sessionId)
        : undefined;
      const startedAtMs = activeTask?.startedAt ??
        (isRunningCodexTaskStatus(status) ? observation?.runningSinceMs : undefined);
      return {
        threadId: candidate.sessionId,
        title: candidate.title,
        ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
        ...(candidate.projectName ? { projectName: candidate.projectName } : {}),
        ...(candidate.projectOrder !== undefined
          ? { projectOrder: candidate.projectOrder }
          : {}),
        ...(candidate.projectThreadOrder !== undefined
          ? { projectThreadOrder: candidate.projectThreadOrder }
          : {}),
        lastUpdatedAt: candidate.lastUpdatedAt,
        status,
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        ...(activeTask?.turnId ? { activeTurnId: activeTask.turnId } : {}),
        selected: candidate.sessionId === selectedThreadId,
        canRename: Boolean(slot.runtime.renameSession),
        canCreateInProject: Boolean(
          candidate.projectId &&
          candidate.cwd &&
          slot.runtime.createSessionInProject
        ),
      };
    });
  }

  private async listMobileTaskBoard(): Promise<CodexMobileTaskBoard> {
    const adapterLabels = new Map(
      this.listMobileAdapters().adapters.map((adapter) => [adapter.id, adapter.label]),
    );
    const candidates = await this.listGlobalTaskCandidates();
    const grouped = new Map<DaemonAdapterKind, CodexMobileTask[]>();
    for (const candidate of candidates) {
      const slot = this.slots.get(candidate.adapter);
      const selectedThreadId = slot ? this.getSlotThreadId(slot) : undefined;
      const status = slot
        ? this.resolveMobileTaskStatus(slot, candidate.sessionId, candidate.runtimeStatus)
        : mapCodexMobileTaskStatus(candidate.runtimeStatus);
      const activeTask = slot
        ? this.getSlotActiveTask(slot, candidate.sessionId)
        : undefined;
      const observation = candidate.adapter === "codex"
        ? this.codexTaskObservations.get(candidate.sessionId)
        : undefined;
      const startedAtMs = activeTask?.startedAt ?? (
        isRunningCodexTaskStatus(status) ? observation?.runningSinceMs : undefined
      );
      const tasks = grouped.get(candidate.adapter) ?? [];
      tasks.push({
        threadId: candidate.sessionId,
        title: candidate.title,
        ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
        ...(candidate.projectName ? { projectName: candidate.projectName } : {}),
        ...(candidate.projectOrder !== undefined
          ? { projectOrder: candidate.projectOrder }
          : {}),
        ...(candidate.projectThreadOrder !== undefined
          ? { projectThreadOrder: candidate.projectThreadOrder }
          : {}),
        lastUpdatedAt: candidate.lastUpdatedAt,
        status,
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        ...(activeTask?.turnId ? { activeTurnId: activeTask.turnId } : {}),
        selected: candidate.adapter === this.activeAdapter &&
          candidate.sessionId === selectedThreadId,
        canRename: Boolean(slot?.runtime.renameSession),
        canCreateInProject: Boolean(
          candidate.projectId &&
          candidate.cwd &&
          slot?.runtime.createSessionInProject
        ),
      });
      grouped.set(candidate.adapter, tasks);
    }
    return buildCodexMobileTaskBoard({
      taskGroups: DAEMON_ADAPTERS.map((adapter) => ({
        adapter,
        adapterLabel: adapterLabels.get(adapter) ?? formatDaemonAdapterLabel(adapter),
        tasks: grouped.get(adapter) ?? [],
      })),
      recentCompletions: this.stateStore.getRecentTaskCompletions(),
    });
  }

  private async recordRecentTaskCompletion(
    slot: DaemonSlot,
    params: {
      threadId: string;
      turnId?: string;
      title?: string;
      completedAt?: string;
      outcome?: BridgeTaskOutcome;
    },
  ): Promise<void> {
    if (params.outcome === "failed" || params.outcome === "interrupted") {
      return;
    }
    let title = params.title?.trim() || "";
    if (!title) {
      title = slot.taskListSnapshot?.candidates.find(
        (candidate) => candidate.sessionId === params.threadId,
      )?.title ?? slot.taskCandidatesCache?.find(
        (candidate) => candidate.sessionId === params.threadId,
      )?.title ?? (
        slot.adapter === "codex"
          ? this.codexTaskObservations.get(params.threadId)?.title
          : undefined
      ) ?? "";
    }
    if (!title) {
      try {
        title = (await this.listMobileTasks(slot.adapter)).find(
          (task) => task.threadId === params.threadId,
        )?.title ?? "";
      } catch (error) {
        appendDaemonLog(
          `mobile_task_completion_title_error: adapter=${slot.adapter} thread=${params.threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
      }
    }
    const completedAt = params.completedAt?.trim();
    this.stateStore.recordRecentTaskCompletion({
      adapter: slot.adapter,
      threadId: params.threadId,
      title: normalizeDaemonTaskDisplayTitle(
        title,
        `${formatDaemonAdapterLabel(slot.adapter)} 任务`,
      ),
      completedAt: completedAt && Number.isFinite(Date.parse(completedAt))
        ? completedAt
        : new Date().toISOString(),
      ...(params.turnId ? { turnId: params.turnId } : {}),
    });
  }

  private async renameMobileTask(
    threadId: string,
    title: string,
    adapter?: string,
  ): Promise<void> {
    const slot = this.getMobileSlot(adapter);
    const renameSession = slot.runtime.renameSession;
    if (!renameSession) {
      throw new Error(`当前 ${formatDaemonAdapterLabel(slot.adapter)} 连接暂不支持重命名任务。`);
    }
    const normalizedThreadId = threadId.trim();
    const normalizedTitle = title.trim();
    await renameSession.call(slot.runtime, normalizedThreadId, normalizedTitle);
    appendDaemonLog(
      `mobile_task_renamed: adapter=${slot.adapter} thread=${normalizedThreadId}`,
    );
  }

  private async createMobileTask(
    adapter?: string,
    sourceThreadId?: string,
  ): Promise<CodexMobileTask> {
    const slot = this.getMobileSlot(adapter);
    if (!slot.runtime.createSession) {
      throw new Error(`当前 ${formatDaemonAdapterLabel(slot.adapter)} 连接暂不支持新建任务。`);
    }
    const normalizedSourceThreadId = sourceThreadId?.trim() || undefined;
    let sourceTask: CodexMobileTask | undefined;
    if (normalizedSourceThreadId) {
      sourceTask = (await this.listMobileTasks(slot.adapter)).find(
        (task) => task.threadId === normalizedSourceThreadId,
      );
      if (!sourceTask?.canCreateInProject || !slot.runtime.createSessionInProject) {
        throw new Error("这个项目暂不支持从网页新建任务。");
      }
    }
    const state = slot.runtime.getState();
    const projectCreateWhileRunning = Boolean(
      normalizedSourceThreadId &&
      sourceTask?.canCreateInProject &&
      state.status === "busy"
    );
    if (
      (!projectCreateWhileRunning && state.status === "busy") ||
      state.status === "awaiting_approval" ||
      state.status === "awaiting_input"
    ) {
      throw new Error(`${formatDaemonAdapterLabel(slot.adapter)} 正在处理，请先完成或停止当前任务。`);
    }
    const previousThreadId = this.getSlotThreadId(slot);
    if (normalizedSourceThreadId && slot.runtime.createSessionInProject) {
      await slot.runtime.createSessionInProject(normalizedSourceThreadId);
    } else {
      await slot.runtime.createSession();
    }
    let threadId = this.getSlotThreadId(slot);
    for (let attempt = 0; attempt < 30 && (!threadId || threadId === previousThreadId); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      threadId = this.getSlotThreadId(slot);
    }
    let tasks: CodexMobileTask[] = [];
    try {
      tasks = await this.listMobileTasks(slot.adapter);
    } catch (error) {
      appendDaemonLog(
        `mobile_task_created_before_index_error: adapter=${slot.adapter} thread=${threadId ?? "pending"} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
      );
    }
    const created = resolveCreatedMobileTask({
      adapterLabel: formatDaemonAdapterLabel(slot.adapter),
      threadId,
      previousThreadId,
      listedTasks: tasks,
      status: threadId
        ? this.resolveMobileTaskStatus(slot, threadId, undefined)
        : "idle",
      canRename: Boolean(slot.runtime.renameSession),
      canCreateInProject: Boolean(
        sourceTask?.projectId && slot.runtime.createSessionInProject
      ),
      ...(sourceTask ? { sourceTask } : {}),
    });
    if (!created) {
      throw new Error(`${formatDaemonAdapterLabel(slot.adapter)} 没有返回新任务编号，请稍后重试。`);
    }
    if (!tasks.some((task) => task.threadId === created.threadId)) {
      appendDaemonLog(
        `mobile_task_created_before_index: adapter=${slot.adapter} thread=${created.threadId}`,
      );
    }
    this.mobileCreatedTaskKeys.add(`${slot.adapter}\0${created.threadId}`);
    this.persistAdapterSessionId(slot.adapter, created.threadId);
    appendDaemonLog(
      `mobile_task_created: adapter=${slot.adapter} thread=${created.threadId}`,
    );
    return created;
  }

  private async readMobileTaskModel(
    threadId: string,
    adapter?: string,
  ): Promise<BridgeSessionModelState> {
    const slot = this.getMobileSlot(adapter);
    const task = (await this.listMobileTasks(slot.adapter)).find(
      (candidate) => candidate.threadId === threadId,
    );
    if (!task) {
      throw new Error(`没有找到这个 ${formatDaemonAdapterLabel(slot.adapter)} 任务。`);
    }
    if (slot.runtime.getSessionModelState) {
      return await slot.runtime.getSessionModelState(threadId);
    }
    const latest = slot.runtime.getLatestSessionMessage
      ? await slot.runtime.getLatestSessionMessage(threadId)
      : null;
    const currentModel = latest?.model;
    return {
      ...(currentModel ? { currentModel } : {}),
      options: currentModel ? [{ id: currentModel }] : [],
      canChange: false,
      unavailableReason: `${formatDaemonAdapterLabel(slot.adapter)} 暂不支持从网页版切换模型。`,
    };
  }

  private async setMobileTaskModel(
    threadId: string,
    model: string,
    adapter?: string,
  ): Promise<BridgeSessionModelState> {
    const slot = this.getMobileSlot(adapter);
    if (!slot.runtime.setSessionModel) {
      throw new Error(`${formatDaemonAdapterLabel(slot.adapter)} 暂不支持从网页版切换模型。`);
    }
    const task = (await this.listMobileTasks(slot.adapter)).find(
      (candidate) => candidate.threadId === threadId,
    );
    if (!task) {
      throw new Error(`没有找到这个 ${formatDaemonAdapterLabel(slot.adapter)} 任务。`);
    }
    return await slot.runtime.setSessionModel(threadId, model);
  }

  private async readMobileMessages(
    threadId: string,
    options: BridgeSessionMessagePageOptions = {},
    adapter?: string,
  ): Promise<{
    threadId: string;
    messages: Awaited<ReturnType<NonNullable<BridgeAdapter["getSessionMessages"]>>>;
    messagePage?: {
      hasMore: boolean;
      nextBefore: string | null;
      source?: "native" | "openagentlog";
      caughtUp?: boolean;
    };
    progressItems: BridgeSessionProgressItem[];
    queuedMessages: CodexMobileQueuedMessage[];
    runSummary: BridgeSessionRunSummary | null;
    pendingApproval: CodexMobilePendingApproval | null;
    approvalResults: CodexMobileApprovalResult[];
  }> {
    const slot = this.getMobileSlot(adapter);
    const label = formatDaemonAdapterLabel(slot.adapter);
    if (!slot.runtime.getSessionMessages && !slot.runtime.getSessionMessagePage) {
      throw new Error(`当前 ${label} 连接暂不支持读取完整消息。`);
    }
    const readNativeMessagePage = () => slot.runtime.getSessionMessagePage
      ? slot.runtime.getSessionMessagePage(threadId, options)
      : slot.runtime.getSessionMessages!(threadId).then((messages) => ({
          messages,
          hasMore: false,
          nextBefore: null,
        }));
    const messagePagePromise = (async () => {
      const accelerated = await this.openAgentLogHistory.readPage(
        slot.adapter,
        threadId,
        options,
      );
      if (accelerated) {
        let messages = accelerated.messages;
        if (slot.runtime.getSessionMessageMedia) {
          try {
            const nativeMessages = await slot.runtime.getSessionMessageMedia(
              threadId,
              options,
              messages,
            );
            messages = mergeBridgeMessageMedia(messages, nativeMessages);
          } catch (error) {
            appendDaemonLog(
              `mobile_history_media_error: adapter=${slot.adapter} thread=${threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
            );
          }
        }
        const imageCount = messages.reduce(
          (count, message) => count + (message.images?.length ?? 0),
          0,
        );
        appendDaemonLog(
          `mobile_history_accelerated: adapter=${slot.adapter} thread=${threadId} messages=${messages.length} images=${imageCount}`,
        );
        return { ...accelerated, messages };
      }
      const nativePage = await readNativeMessagePage();
      return {
        ...nativePage,
        source: "native" as const,
        caughtUp: true,
      };
    })().catch((error) => {
          appendDaemonLog(
            `mobile_messages_error: adapter=${slot.adapter} thread=${threadId} error=${truncatePreview(error instanceof Error ? error.stack ?? error.message : String(error), 800)}`,
          );
          throw error;
        });
    const historyOnly = Boolean(options.before || options.historyOnly);
    const [messagePage, runSummary, progressItems] = await Promise.all([
      messagePagePromise,
      !historyOnly && slot.runtime.getSessionRunSummary
        ? slot.runtime.getSessionRunSummary(threadId, {
            lightweight: options.lightweight,
          }).catch((error) => {
            appendDaemonLog(
              `mobile_summary_error: adapter=${slot.adapter} thread=${threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
            );
            return null;
          })
        : Promise.resolve(null),
      !historyOnly && slot.runtime.getSessionProgress
        ? slot.runtime.getSessionProgress(threadId, {
            lightweight: options.lightweight,
          }).catch((error) => {
            appendDaemonLog(
              `mobile_progress_error: adapter=${slot.adapter} thread=${threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
            );
            return [];
          })
        : Promise.resolve([]),
    ]);
    const activeTask = this.getSlotActiveTask(slot, threadId);
    const visibleMessages = messagePage.messages.flatMap((message) => {
      const visible = sanitizeDaemonVisibleSessionMessage(slot.adapter, message);
      return visible
        ? [enrichBridgeSessionMessageImages(visible, { cwd: this.cwd })]
        : [];
    });
    return {
      threadId,
      messages: this.mobileMessageImageStore.enrich(visibleMessages, {
        adapter: slot.adapter,
        threadId,
      }),
      messagePage: {
        hasMore: messagePage.hasMore,
        nextBefore: messagePage.nextBefore,
        ...(messagePage.source ? { source: messagePage.source } : {}),
        ...(messagePage.caughtUp !== undefined
          ? { caughtUp: messagePage.caughtUp }
          : {}),
      },
      progressItems: filterCodexMobileProgressForCurrentTurn({
        progressItems,
        hasActiveTask: Boolean(activeTask),
        ...(activeTask?.turnId ? { activeTurnId: activeTask.turnId } : {}),
        ...(activeTask?.turnIdAuthoritative
          ? { activeTurnAuthoritative: true }
          : {}),
        runSummary,
      }),
      queuedMessages: slot.runtime.getQueuedTaskInputs?.(threadId) ?? [],
      runSummary,
      pendingApproval: this.getMobilePendingApproval(slot, threadId),
      approvalResults: this.stateStore
        .getMobileApprovalResults(slot.adapter, threadId)
        .map(({ adapter: _adapter, threadId: _threadId, ...result }) => result),
    };
  }

  private async readHistoricalLatestMessage(
    slot: DaemonSlot,
    threadId: string,
  ): Promise<BridgeSessionMessage | null> {
    const accelerated = await this.openAgentLogHistory.readLatestMessage(
      slot.adapter,
      threadId,
    );
    if (accelerated) {
      const visible = sanitizeDaemonVisibleSessionMessage(slot.adapter, accelerated);
      if (visible) {
        appendDaemonLog(
          `wechat_history_accelerated: adapter=${slot.adapter} thread=${threadId}`,
        );
        return visible;
      }
    }
    return slot.runtime.getLatestSessionMessage
      ? slot.runtime.getLatestSessionMessage(threadId)
      : null;
  }

  private getMobilePendingApproval(
    slot: DaemonSlot,
    threadId: string,
  ): CodexMobilePendingApproval | null {
    const runtimeState = slot.runtime.getState();
    return resolveCodexMobilePendingApprovalFromSignals({
      threadId,
      selectedThreadId: runtimeState.sharedThreadId ?? runtimeState.sharedSessionId,
      pendingConfirmations: slot.pendingConfirmations,
      ...(slot.runtime.getPendingTaskApprovals
        ? { runtimeTaskApprovals: slot.runtime.getPendingTaskApprovals(threadId) }
        : {}),
      runtimePendingApproval: runtimeState.pendingApproval,
    });
  }

  private async resolveMobileApproval(
    threadId: string,
    action: CodexMobileApprovalAction,
    adapter?: string,
  ): Promise<CodexMobileApprovalResolution> {
    const slot = this.getMobileSlot(adapter);
    const runtimeState = slot.runtime.getState();
    const runtimeTaskApprovals = slot.runtime.getPendingTaskApprovals?.(threadId);
    const pending = runtimeTaskApprovals !== undefined
      ? runtimeTaskApprovals[0] ?? null
      : slot.pendingConfirmations.find(
          (candidate) => candidate.threadId === threadId,
        ) ?? (
          (runtimeState.sharedThreadId ?? runtimeState.sharedSessionId) === threadId
            ? runtimeState.pendingApproval ?? null
            : null
        );
    if (!pending) {
      return { count: 0 };
    }
    const count = slot.runtime.resolveTaskApprovals
      ? await slot.runtime.resolveTaskApprovals(threadId, action)
      : this.getSlotThreadId(slot) === threadId
        ? action === "confirm_session"
          ? await (slot.runtime.resolveAllApprovalsForSession?.() ?? Promise.resolve(0))
          : await slot.runtime.resolveAllApprovals(
              action === "deny" ? "deny" : "confirm",
            )
        : 0;
    if (!count) {
      return { count: 0 };
    }
    const resolvedPendingConfirmations = slot.pendingConfirmations.filter(
      (candidate) => candidate.threadId === threadId,
    );
    for (const candidate of resolvedPendingConfirmations) {
      if (candidate.threadId === threadId) {
        this.approvalNotificationDeliveries.cancel(
          buildDaemonApprovalDeliveryKey(slot.adapter, candidate),
        );
      }
    }
    this.approvalNotificationDeliveries.cancel(
      buildDaemonApprovalDeliveryKey(slot.adapter, pending),
    );
    slot.pendingConfirmations = slot.pendingConfirmations.filter(
      (candidate) => candidate.threadId !== threadId,
    );
    if (action !== "deny") {
      this.setSlotActiveTask(
        slot,
        {
          startedAt: Date.now(),
          inputPreview: pending.commandPreview,
        },
        threadId,
      );
    }
    appendDaemonLog(
      `mobile_approval_${action}: adapter=${slot.adapter} thread=${threadId} count=${count} command=${truncatePreview(redactSensitiveCommandText(pending.commandPreview))}`,
    );
    const result = this.recordMobileApprovalResult(slot, pending, action, {
      threadId,
    });
    return {
      count,
      ...(result ? { result } : {}),
    };
  }

  private async updateMobileQueuedMessage(
    threadId: string,
    messageId: string,
    text: string,
    adapter?: string,
  ): Promise<boolean> {
    const slot = this.getMobileSlot(adapter);
    if (!slot.runtime.updateQueuedTaskInput) {
      throw new Error(`当前 ${formatDaemonAdapterLabel(slot.adapter)} 连接暂不支持编辑待发送消息。`);
    }
    const updated = await slot.runtime.updateQueuedTaskInput(threadId, messageId, text);
    appendDaemonLog(
      `mobile_queue_update: adapter=${slot.adapter} thread=${threadId} message=${messageId} updated=${updated}`,
    );
    return updated;
  }

  private async deleteMobileQueuedMessage(
    threadId: string,
    messageId: string,
    adapter?: string,
  ): Promise<boolean> {
    const slot = this.getMobileSlot(adapter);
    if (!slot.runtime.deleteQueuedTaskInput) {
      throw new Error(`当前 ${formatDaemonAdapterLabel(slot.adapter)} 连接暂不支持删除待发送消息。`);
    }
    const deleted = await slot.runtime.deleteQueuedTaskInput(threadId, messageId);
    appendDaemonLog(
      `mobile_queue_delete: adapter=${slot.adapter} thread=${threadId} message=${messageId} deleted=${deleted}`,
    );
    return deleted;
  }

  private async steerMobileQueuedMessage(
    threadId: string,
    messageId: string,
    adapter?: string,
  ): Promise<boolean> {
    const slot = this.getMobileSlot(adapter);
    if (!slot.runtime.steerQueuedTaskInput) {
      throw new Error(`当前 ${formatDaemonAdapterLabel(slot.adapter)} 连接暂不支持引导待发送消息。`);
    }
    const steered = await slot.runtime.steerQueuedTaskInput(threadId, messageId);
    appendDaemonLog(
      `mobile_queue_steer: adapter=${slot.adapter} thread=${threadId} message=${messageId} steered=${steered}`,
    );
    return steered;
  }

  private async stopMobileTask(threadId: string, adapter?: string): Promise<boolean> {
    const slot = this.getMobileSlot(adapter);
    const task = (await this.listMobileTasks(slot.adapter)).find(
      (candidate) => candidate.threadId === threadId,
    );
    if (!task) {
      throw new Error(`没有找到这个 ${formatDaemonAdapterLabel(slot.adapter)} 任务。`);
    }
    const currentThreadId = this.getSlotThreadId(slot);
    const interrupted = slot.runtime.interruptSession
      ? await slot.runtime.interruptSession(threadId)
      : currentThreadId === threadId
        ? await slot.runtime.interrupt()
        : false;
    appendDaemonLog(
      `mobile_stop: adapter=${slot.adapter} thread=${threadId} interrupted=${interrupted}`,
    );
    return interrupted;
  }

  private async sendMobileMessage(
    threadId: string,
    input: CodexMobileMessageInput,
    adapter?: string,
  ): Promise<{
    queued: boolean;
    duplicate?: boolean;
    queuedMessageId?: string;
    queuePosition?: number;
    turnId?: string;
  }> {
    const slot = this.getMobileSlot(adapter);
    if (!slot.runtime.sendInputToSession) {
      throw new Error(`当前 ${formatDaemonAdapterLabel(slot.adapter)} 连接暂不支持向指定任务发送消息。`);
    }
    const createdTaskKey = `${slot.adapter}\0${threadId}`;
    const currentThreadId = this.getSlotThreadId(slot);
    const recentlyCreated = this.mobileCreatedTaskKeys.has(createdTaskKey);
    let listed = false;
    if (threadId !== currentThreadId && !recentlyCreated) {
      listed = (await this.listMobileTasks(slot.adapter)).some(
        (candidate) => candidate.threadId === threadId,
      );
    }
    if (!isMobileTaskAvailableForDirectAction({
      threadId,
      currentThreadId,
      recentlyCreated,
      listed,
    })) {
      throw new Error(`没有找到这个 ${formatDaemonAdapterLabel(slot.adapter)} 任务。`);
    }
    const imagePaths = this.persistMobileImages(input);
    let result: BridgeSessionSendResult | void;
    try {
      result = await this.dispatchMobileInput(
        slot,
        threadId,
        input.text,
        imagePaths,
      );
    } catch (error) {
      if (imagePaths.length > 0) {
        appendDaemonLog(
          `mobile_images_retained_after_send_error: adapter=${slot.adapter} thread=${threadId} images=${imagePaths.length}`,
        );
      }
      throw error;
    }
    this.mobileCreatedTaskKeys.delete(createdTaskKey);
    if (!result?.duplicate && imagePaths.length > 0) {
      this.mobileMessageImageStore.remember({
        adapter: slot.adapter,
        threadId,
        ...(result?.turnId ? { turnId: result.turnId } : {}),
        text: input.text,
        images: imagePaths.map((imagePath, index) => ({
          path: imagePath,
          alt: input.images[index]?.fileName || path.basename(imagePath),
        })),
      });
    }
    return {
      queued: result?.queued ?? false,
      duplicate: result?.duplicate,
      queuedMessageId: result?.queuedMessageId,
      queuePosition: result?.queuePosition,
      turnId: result?.turnId,
    };
  }

  private persistMobileImages(input: CodexMobileMessageInput): string[] {
    if (input.images.length === 0) {
      return [];
    }
    const directory = path.join(
      ensureWorkspaceChannelDir(this.cwd).workspaceDir,
      "mobile-images",
      new Date().toISOString().slice(0, 10),
    );
    ensurePrivateDir(directory);
    const extensionByMimeType: Record<CodexMobileMessageInput["images"][number]["mimeType"], string> = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/webp": ".webp",
      "image/gif": ".gif",
    };
    return input.images.map((image) => {
      const filePath = path.join(
        directory,
        `mobile-${Date.now()}-${randomUUID()}${extensionByMimeType[image.mimeType]}`,
      );
      writePrivateFileAtomic(filePath, image.data);
      return filePath;
    });
  }

  private async sendCodexTaskCompletionMessage(
    slot: DaemonSlot,
    params: {
      threadId: string;
      turnId?: string;
      title?: string;
      outcome: BridgeTaskOutcome | undefined;
      completedAt?: string;
      startedAtMs: number;
      inputPreview?: string;
    },
  ): Promise<void> {
    const url = this.codexMobileServer?.buildTaskUrl(params.threadId, slot.adapter);

    let candidate: BridgeResumeSessionCandidate | undefined;
    try {
      const candidates = await this.getCodexTaskCandidates(slot);
      candidate = candidates.find((item) => item.sessionId === params.threadId);
    } catch (error) {
      appendDaemonLog(
        `codex_completion_metadata_error: thread=${params.threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
      );
    }

    let runSummary: BridgeSessionRunSummary | null = null;
    if (slot.runtime.getSessionRunSummary) {
      try {
        runSummary = await slot.runtime.getSessionRunSummary(params.threadId);
      } catch (error) {
        appendDaemonLog(
          `codex_completion_duration_error: thread=${params.threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
      }
    }

    let sessionMessages: BridgeSessionMessage[] = [];
    if (slot.runtime.getSessionMessages) {
      try {
        sessionMessages = await slot.runtime.getSessionMessages(params.threadId);
      } catch (error) {
        appendDaemonLog(
          `codex_completion_messages_error: thread=${params.threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
      }
    }

    let latestMessage = null as Awaited<ReturnType<NonNullable<BridgeAdapter["getLatestSessionMessage"]>>> | null;
    if (slot.runtime.getLatestSessionMessage) {
      try {
        latestMessage = await slot.runtime.getLatestSessionMessage(params.threadId);
      } catch (error) {
        appendDaemonLog(
          `codex_completion_preview_error: thread=${params.threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
      }
    }
    if (!shouldSendCodexCompletionNotification({
      eventTurnId: params.turnId,
      runSummary,
      latestMessage,
    })) {
      appendDaemonLog(
        `codex_completion_evidence_suppressed: thread=${params.threadId} turn=${params.turnId ?? "synthetic"} summary=${runSummary?.status ?? "missing"} latest=${latestMessage?.role ?? "missing"}`,
      );
      return;
    }
    const resolvedTurnId = params.turnId ?? runSummary?.turnId ?? latestMessage?.turnId ??
      sessionMessages.at(-1)?.turnId;
    const notificationKey = resolvedTurnId
      ? `${params.threadId}:${resolvedTurnId}`
      : `${params.threadId}:${candidate?.lastUpdatedAt ?? params.startedAtMs}`;
    if (this.codexCompletionDeliveries.hasDelivered(notificationKey)) {
      appendDaemonLog(`codex_completion_duplicate: key=${notificationKey}`);
      return;
    }

    const replyText = selectCodexCompletionReplyText({
      resolvedTurnId,
      turnReply: resolvedTurnId
        ? this.codexFinalReplyByTurnId.get(resolvedTurnId)
        : undefined,
      threadReply: this.codexFinalReplyByThreadId.get(params.threadId),
      latestMessage,
    });
    const requestPreview = selectCodexCompletionRequestPreview({
      resolvedTurnId,
      activeTaskPreview: params.inputPreview,
      messages: sessionMessages,
    });
    const completionTitle =
      params.title ?? candidate?.title ?? `任务 ${params.threadId.slice(0, 8)}`;
    const texts = formatCodexTaskCompletionMessages({
      title: completionTitle,
      taskNumber: slot.taskNumberByThreadId.get(params.threadId),
      outcome: params.outcome,
      durationMs: resolveCodexTaskCompletionDurationMs({
        turnId: resolvedTurnId,
        runSummary,
        startedAtMs: params.startedAtMs,
      }),
      requestPreview,
      text: replyText,
      url,
      mode: this.codexWechatReplyMode,
    });
    const enqueueResult = this.codexCompletionDeliveries.enqueue({
      key: notificationKey,
      threadId: params.threadId,
      ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
      title: completionTitle,
      completedAt: params.completedAt ?? candidate?.lastUpdatedAt ?? nowIso(),
      ...(url ? { url } : {}),
      ...(params.outcome ? { outcome: params.outcome } : {}),
      texts,
    });
    if (enqueueResult.status === "delivered") {
      appendDaemonLog(`codex_completion_duplicate: key=${notificationKey}`);
      return;
    }
    const deliveryResult = await this.deliverCodexCompletionNotification(
      notificationKey,
      this.authorizedUserId,
    );
    if (deliveryResult.status === "in_flight") {
      appendDaemonLog(`codex_completion_in_flight: key=${notificationKey}`);
      return;
    }
    if (deliveryResult.sentCount > 0) {
      slot.wechatReplyThreadId = params.threadId;
      this.persistCodexWechatThreadId(params.threadId);
    }
    if (deliveryResult.status !== "delivered") {
      appendDaemonLog(
        `codex_completion_pending: thread=${params.threadId} sent=${deliveryResult.delivery?.nextTextIndex ?? 0}/${deliveryResult.totalCount} reason=wechat_unavailable`,
      );
      return;
    }

    const completionImages = collectAssistantMessageImages(sessionMessages, {
      ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
      cwd: this.cwd,
      fallbackText: replyText,
    });
    for (const image of completionImages) {
      if (image.source !== "local") continue;
      try {
        await this.sendWechatGeneratedImage(slot, {
          threadId: params.threadId,
          ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
          rawText: replyText ?? "",
          imagePath: image.path,
        });
      } catch (error) {
        appendDaemonLog(
          `codex_completion_image_error: thread=${params.threadId} path=${image.path} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
      }
    }
    appendDaemonLog(
      `codex_completion_sent: thread=${params.threadId} mode=${this.codexWechatReplyMode} messages=${deliveryResult.totalCount}`,
    );
    this.clearCodexFinalReplyCache(params.threadId, resolvedTurnId);
  }

  private async collectFinalReplyImages(
    slot: DaemonSlot,
    params: {
      threadId?: string;
      turnId?: string;
      rawText: string;
    },
  ): Promise<BridgeMessageImage[]> {
    const threadId = params.threadId ?? this.getSlotThreadId(slot);
    let messages: BridgeSessionMessage[] = [];
    if (threadId && slot.runtime.getSessionMessages) {
      try {
        messages = await slot.runtime.getSessionMessages(threadId);
      } catch (error) {
        appendDaemonLog(
          `final_reply_images_error: adapter=${slot.adapter} thread=${threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
      }
    }
    return collectAssistantMessageImages(messages, {
      ...(params.turnId ? { turnId: params.turnId } : {}),
      cwd: this.cwd,
      fallbackText: params.rawText,
    });
  }

  private async sendWechatGeneratedImage(
    slot: DaemonSlot,
    params: {
      threadId?: string;
      turnId?: string;
      rawText: string;
      imagePath: string;
    },
  ): Promise<void> {
    const threadId = params.threadId ?? this.getSlotThreadId(slot) ?? "unknown-thread";
    const turnKey = params.turnId ?? params.rawText;
    const key = `${slot.adapter}\0${threadId}\0${turnKey}\0${params.imagePath}`;
    if (this.wechatGeneratedImageKeys.has(key)) {
      appendDaemonLog(
        `final_reply_image_duplicate: adapter=${slot.adapter} thread=${threadId} path=${params.imagePath}`,
      );
      return;
    }
    await this.queueWechatAttachmentAction(() =>
      this.transport.sendImage(params.imagePath, {
        recipientId: this.authorizedUserId,
      })
    );
    this.wechatGeneratedImageKeys.add(key);
    appendDaemonLog(
      `final_reply_image_sent: adapter=${slot.adapter} thread=${threadId} path=${params.imagePath}`,
    );
  }

  private clearCodexFinalReplyCache(
    threadId?: string,
    turnId?: string,
  ): void {
    if (turnId) {
      this.codexFinalReplyByTurnId.delete(turnId);
    }
    if (!threadId) {
      return;
    }
    const threadReply = this.codexFinalReplyByThreadId.get(threadId);
    if (!threadReply) {
      return;
    }
    if (!turnId || !threadReply.turnId || threadReply.turnId === turnId) {
      this.codexFinalReplyByThreadId.delete(threadId);
    }
  }

  private async shouldHandleCodexTaskCompletionEvent(
    slot: DaemonSlot,
    params: {
      threadId: string;
      turnId?: string;
      activeTask: ActiveTask | null;
      observation?: CodexTaskObservation;
    },
  ): Promise<boolean> {
    let runSummary: BridgeSessionRunSummary | null = null;
    if (slot.runtime.getSessionRunSummary) {
      for (let attempt = 0; attempt < CODEX_COMPLETION_SUMMARY_RETRY_COUNT; attempt += 1) {
        try {
          runSummary = await slot.runtime.getSessionRunSummary(params.threadId);
        } catch (error) {
          appendDaemonLog(
            `codex_completion_summary_error: thread=${params.threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
          );
          break;
        }
        if (
          runSummary?.status !== "running" ||
          (params.turnId && runSummary.turnId && params.turnId !== runSummary.turnId)
        ) {
          break;
        }
        if (attempt + 1 < CODEX_COMPLETION_SUMMARY_RETRY_COUNT) {
          await delay(CODEX_COMPLETION_SUMMARY_RETRY_MS);
        }
      }
    }
    return shouldForwardCodexTaskCompletionEvent({
      bridgeStartedAtMs: this.bridgeStartedAtMs,
      eventTurnId: params.turnId,
      activeTaskTurnId: params.activeTask?.turnId,
      runSummary,
      hasActiveTask: Boolean(params.activeTask),
      observationStatus: params.observation?.status,
    });
  }

  private getSlotThreadId(slot: DaemonSlot): string | undefined {
    return (
      slot.runtime.getState().sharedThreadId ??
      slot.runtime.getState().sharedSessionId ??
      undefined
    );
  }

  private getCodexThreadId(): string | undefined {
    const slot = this.slots.get("codex");
    return slot ? this.getSlotThreadId(slot) : undefined;
  }

  private persistActiveAdapter(adapter: DaemonAdapterKind): void {
    try {
      this.stateStore.setActiveAdapter(adapter);
    } catch (error) {
      appendDaemonLog(
        `daemon_state_write_error: field=active_adapter error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
      );
    }
  }

  private persistCodexThreadId(threadId: string | null | undefined): void {
    try {
      this.stateStore.setCodexThreadId(threadId);
    } catch (error) {
      appendDaemonLog(
        `daemon_state_write_error: field=codex_thread error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
      );
    }
  }

  private persistCodexWechatThreadId(
    threadId: string | null | undefined,
  ): void {
    try {
      this.stateStore.setCodexWechatThreadId(threadId);
    } catch (error) {
      appendDaemonLog(
        `daemon_state_write_error: field=codex_wechat_thread error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
      );
    }
  }

  private persistAdapterSessionId(
    adapter: DaemonAdapterKind,
    sessionId: string | null | undefined,
  ): void {
    try {
      this.stateStore.setAdapterSessionId(adapter, sessionId);
    } catch (error) {
      appendDaemonLog(
        `daemon_state_write_error: field=adapter_session adapter=${adapter} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
      );
    }
  }

  private persistCodexWechatReplyMode(mode: CodexWechatReplyMode): void {
    try {
      this.stateStore.setCodexWechatReplyMode(mode);
    } catch (error) {
      appendDaemonLog(
        `daemon_state_write_error: field=codex_wechat_reply_mode error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
      );
    }
  }

  private getSlotTaskKey(slot: DaemonSlot, threadId?: string): string {
    if (slot.adapter !== "codex") {
      return "__adapter__";
    }
    return (
      threadId ??
      slot.runtime.getState().sharedThreadId ??
      slot.runtime.getState().sharedSessionId ??
      "__codex__"
    );
  }

  private getSlotActiveTask(
    slot: DaemonSlot,
    threadId?: string,
  ): ActiveTask | null {
    return slot.activeTasks.get(this.getSlotTaskKey(slot, threadId)) ?? null;
  }

  private setSlotActiveTask(
    slot: DaemonSlot,
    task: ActiveTask,
    threadId?: string,
  ): void {
    slot.activeTasks.set(this.getSlotTaskKey(slot, threadId), task);
  }

  private clearSlotActiveTask(
    slot: DaemonSlot,
    threadId?: string,
    turnId?: string,
  ): void {
    const key = this.getSlotTaskKey(slot, threadId);
    const activeTask = slot.activeTasks.get(key);
    if (
      activeTask &&
      shouldClearCodexActiveTaskForCompletion(activeTask.turnId, turnId)
    ) {
      slot.activeTasks.delete(key);
    }
  }

  private clearSlotTaskState(
    slot: DaemonSlot,
    threadId?: string,
    turnId?: string,
  ): void {
    if (!threadId || slot.adapter !== "codex") {
      slot.pendingConfirmations = [];
      slot.notifiedApprovalKeys.clear();
      slot.pendingUserInputs = [];
      slot.activeTasks.clear();
      return;
    }
    slot.pendingConfirmations = slot.pendingConfirmations.filter(
      (pending) =>
        pending.threadId !== threadId ||
        (turnId ? pending.turnId !== turnId : false),
    );
    slot.pendingUserInputs = slot.pendingUserInputs.filter(
      (pending) =>
        pending.threadId !== threadId ||
        (turnId ? pending.turnId !== turnId : false),
    );
    this.clearSlotActiveTask(slot, threadId, turnId);
  }

  private resolvePendingApproval(slot: DaemonSlot): PendingApproval | null {
    const queued = this.listPendingApprovalTargets().find(
      (target) => target.slot === slot,
    );
    if (queued) {
      return queued.pending;
    }
    const currentThreadId =
      slot.runtime.getState().sharedThreadId ??
      slot.runtime.getState().sharedSessionId;
    if (slot.adapter === "codex" && slot.runtime.getPendingTaskApprovals) {
      const candidateThreadIds = [
        currentThreadId,
        ...slot.pendingConfirmations.map((pending) => pending.threadId),
      ].filter((threadId, index, values): threadId is string =>
        Boolean(threadId) && values.indexOf(threadId) === index
      );
      for (const threadId of candidateThreadIds) {
        const request = slot.runtime.getPendingTaskApprovals(threadId)[0];
        if (request) {
          return {
            ...request,
            code: request.requestId ?? "RUNTIME",
            createdAt: nowIso(),
          };
        }
      }
      return null;
    }
    return (
      slot.pendingConfirmations.find(
        (pending) => pending.threadId && pending.threadId === currentThreadId,
      ) ??
      slot.pendingConfirmations[0] ??
      null
    );
  }

  private resolveTaskPendingApproval(
    slot: DaemonSlot,
    threadId: string | undefined,
  ): PendingApproval | null {
    if (slot.adapter !== "codex") {
      return slot.pendingConfirmations[0] ?? null;
    }
    if (!threadId) {
      return null;
    }
    if (slot.runtime.getPendingTaskApprovals) {
      const request = slot.runtime.getPendingTaskApprovals(threadId)[0];
      return request
        ? {
            ...request,
            code: request.requestId ?? "RUNTIME",
            createdAt: nowIso(),
          }
        : null;
    }
    return slot.pendingConfirmations.find(
      (pending) => pending.threadId === threadId,
    ) ?? null;
  }

  private resolvePendingUserInput(
    slot: DaemonSlot,
  ): PendingUserInputRequest | null {
    const currentThreadId =
      slot.runtime.getState().sharedThreadId ??
      slot.runtime.getState().sharedSessionId;
    return (
      slot.pendingUserInputs.find(
        (pending) => pending.threadId && pending.threadId === currentThreadId,
      ) ??
      slot.pendingUserInputs[0] ??
      null
    );
  }

  private resolveTaskPendingUserInput(
    slot: DaemonSlot,
    threadId: string | undefined,
  ): PendingUserInputRequest | null {
    if (slot.adapter !== "codex") {
      return slot.pendingUserInputs[0] ?? null;
    }
    if (!threadId) {
      return null;
    }
    return slot.pendingUserInputs.find(
      (pending) => pending.threadId === threadId,
    ) ?? null;
  }

  private async listWechatGlobalTaskCandidates(): Promise<GlobalTaskCandidate[]> {
    const adapters = selectRunningGlobalTaskAdapters({
      connectedAdapters: this.slots.keys(),
      openAdapters: readOpenMobileAdapters(this.cwd),
    });
    appendDaemonLog(
      `wechat_global_task_adapters: adapters=${adapters.join(",") || "none"}`,
    );
    // Keep the aggregate list strictly ordered by lastUpdatedAt. Runtime
    // state remains visible through inline markers instead of reordering.
    return this.listGlobalTaskCandidates(adapters);
  }

  private async listGlobalTaskCandidates(
    adapters: readonly DaemonAdapterKind[] = DAEMON_ADAPTERS,
  ): Promise<GlobalTaskCandidate[]> {
    const adapterSet = new Set(adapters);
    const groups = await Promise.all(adapters.map(async (adapter) => {
      try {
        const slot = this.slots.get(adapter);
        let candidates: BridgeResumeSessionCandidate[];
        if (slot) {
          if (slot.adapter === "codex") {
            candidates = await this.getCodexTaskCandidates(slot);
          } else if (slot.adapter === "deepseek") {
            // DSH Desktop and `dsh web` may expose different Harness hosts.
            // Rediscover the current host for this read-only catalog request,
            // then merge pending interaction signals from the live slot.
            const freshCandidates = await listLightweightAdapterSessions(
              adapter,
              this.cwd,
              100,
            );
            candidates = mergeSessionRuntimeSignals(freshCandidates, {
              pendingApprovalIds: slot.pendingConfirmations
                .map((pending) => pending.threadId)
                .filter((id): id is string => Boolean(id)),
              pendingUserInputIds: slot.pendingUserInputs
                .map((pending) => pending.threadId)
                .filter((id): id is string => Boolean(id)),
            });
          } else {
            candidates = await slot.runtime.listResumeSessions(100);
          }
        } else if (adapter === "codex") {
          // Task enumeration is read-only: catalog runtime uses a fresh session and
          // never launches the desktop app, so the desktop UI is not moved.
          const runtime = createRuntimeHost(buildDaemonTaskCatalogRuntimeOptions({
            adapter,
            cwd: this.cwd,
            profile: this.profile,
          }));
          runtime.setEventSink(() => undefined);
          try {
            await runtime.start();
            candidates = await runtime.listResumeSessions(100);
          } finally {
            await runtime.dispose().catch(() => undefined);
          }
        } else {
          candidates = await listLightweightAdapterSessions(adapter, this.cwd, 100);
        }
        return candidates.map((candidate): GlobalTaskCandidate => ({
          ...candidate,
          adapter,
        }));
      } catch (error) {
        appendDaemonLog(
          `global_task_enumeration_error: adapter=${adapter} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
        return [];
      }
    }));
    const candidates = groups.flat();
    const identities = new Set(candidates.map((candidate) => (
      `${candidate.adapter}\u0000${candidate.sessionId}`
    )));
    for (const completion of this.stateStore.getRecentTaskCompletions()) {
      if (!adapterSet.has(completion.adapter)) continue;
      const identity = `${completion.adapter}\u0000${completion.threadId}`;
      if (identities.has(identity)) continue;
      candidates.push({
        adapter: completion.adapter,
        sessionId: completion.threadId,
        threadId: completion.threadId,
        title: completion.title,
        lastUpdatedAt: completion.completedAt,
        runtimeStatus: { type: "notLoaded" },
      });
      identities.add(identity);
    }
    return buildGlobalTaskSnapshot(candidates).candidates;
  }

  private async activateExactGlobalTask(
    candidate: GlobalTaskCandidate,
  ): Promise<DaemonSlot> {
    const hadConnectedSlot = this.slots.has(candidate.adapter);
    const slot = await activateGlobalTaskCandidate(candidate, {
      getConnectedAdapter: (adapter) => this.slots.get(adapter) ?? null,
      connectAdapter: async (adapter) => {
        const result = await this.ensureSlot(adapter, {
          openVisible: true,
          reuseExistingVisible: true,
          sessionStartMode: "restore",
          activate: false,
          userInitiated: true,
        });
        if (!result.activated) {
          throw new Error(result.activationReason ?? `${formatDaemonAdapterLabel(adapter)} 不可用。`);
        }
        const connected = this.slots.get(adapter);
        if (!connected) throw new Error(`${formatDaemonAdapterLabel(adapter)} 连接没有建立。`);
        return connected;
      },
      resumeSession: async (connected, sessionId) => {
        if (candidate.adapter === "codex" && hadConnectedSlot) return;
        await retrySwitchedAdapterTaskList(
          () => connected.runtime.resumeSession(sessionId),
          {
            onRetry: ({ attempt, delayMs, error }) => {
              appendDaemonLog(
                `global_task_resume_retry: adapter=${candidate.adapter} thread=${sessionId} attempt=${attempt} delay_ms=${delayMs} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
              );
            },
          },
        );
      },
    });
    this.activeAdapter = candidate.adapter;
    this.persistActiveAdapter(candidate.adapter);
    slot.wechatReplyThreadId = candidate.sessionId;
    this.persistAdapterSessionId(candidate.adapter, candidate.sessionId);
    if (candidate.adapter === "codex") {
      this.persistCodexWechatThreadId(candidate.sessionId);
    }
    slot.controller.syncLocalClientEndpoint();
    return slot;
  }

  private async handleGlobalTaskTargetedMessage(
    message: InboundWechatMessage,
    target: { candidate: GlobalTaskCandidate; text: string },
  ): Promise<void> {
    const slot = await this.activateExactGlobalTask(target.candidate);
    await this.handleDaemonTaskTargetedMessage(message, slot, target);
  }

  private async handleGlobalTaskCommand(
    message: InboundWechatMessage,
    command: DaemonSystemCommand,
  ): Promise<void> {
    if (command.type === "resume_page") {
      const navigation = resolveCodexTaskListPageNavigation({
        direction: command.direction,
        current: this.globalTaskListPosition,
        history: this.globalTaskListHistory,
        ...(command.count ? { requestedPageSize: command.count } : {}),
      });
      await this.handleGlobalTaskCommand(message, {
        type: "resume",
        taskListScope: "global",
        taskListPosition: navigation.current,
        taskListHistory: navigation.history,
        preserveTaskSnapshot: true,
      });
      return;
    }
    if (command.type !== "resume") return;
    const pageSize = command.taskListPosition?.pageSize ?? CODEX_TASK_LIST_PAGE_SIZE;
    const page = command.page ?? 1;
    const pageStart = command.taskListPosition?.startIndex ??
      (page - 1) * CODEX_TASK_LIST_PAGE_SIZE;
    const preserveSnapshot = command.preserveTaskSnapshot === true || Boolean(command.target);
    const latestCandidates = preserveSnapshot && this.globalTaskListSnapshot
      ? this.globalTaskListSnapshot.candidates
      : await this.listWechatGlobalTaskCandidates();
    const snapshot = updateGlobalTaskSnapshot({
      current: this.globalTaskListSnapshot,
      latestCandidates,
      refresh: !preserveSnapshot || !this.globalTaskListSnapshot,
    });
    this.globalTaskListSnapshot = snapshot;
    this.activeTaskListScope = "global";
    if (!command.target) {
      this.globalTaskListPosition = { startIndex: pageStart, pageSize };
      this.globalTaskListHistory = command.taskListHistory ?? [];
      const activeSlot = this.getActiveSlot();
      if (activeSlot) {
        activeSlot.awaitingBareTaskSelection = snapshot.candidates.slice(
          pageStart,
          pageStart + pageSize,
        ).length > 0;
      }
      await this.queueWechatMessage(
        message.senderId,
        formatGlobalTaskList({ snapshot, startIndex: pageStart, pageSize }),
      );
      appendDaemonLog(
        `wechat_global_task_list_sent: adapters=${[...new Set(snapshot.candidates.map((candidate) => candidate.adapter))].join(",") || "none"} candidates=${snapshot.candidates.length} page_start=${pageStart} page_size=${pageSize}`,
      );
      return;
    }
    const candidate = resolveGlobalTaskCandidate(snapshot, command.target);
    if (!candidate) {
      const matches = searchGlobalTaskCandidates(snapshot, command.target);
      const activeSlot = this.getActiveSlot();
      if (activeSlot) {
        activeSlot.awaitingBareTaskSelection = true;
      }
      await this.queueWechatMessage(
        message.senderId,
        matches.length > 1
          ? formatGlobalTaskSearchResults({
              snapshot,
              matches: matches.slice(0, CODEX_TASK_LIST_MAX_PAGE_SIZE),
              target: command.target,
            })
          : [
              `没有找到任务：${command.target}`,
              formatGlobalTaskList({ snapshot, startIndex: 0, pageSize }),
            ].join("\n\n"),
      );
      return;
    }
    let slot: DaemonSlot;
    try {
      slot = await this.activateExactGlobalTask(candidate);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appendDaemonLog(
        `global_task_selection_error: adapter=${candidate.adapter} thread=${candidate.sessionId} error=${truncatePreview(detail, 400)}`,
      );
      await this.queueWechatMessage(message.senderId, detail, "inbound_error");
      return;
    }
    slot.taskListSnapshot = {
      candidates: [candidate],
      numberByThreadId: new Map([[candidate.sessionId, 1]]),
    };
    slot.taskNumberByThreadId.clear();
    slot.taskNumberByThreadId.set(candidate.sessionId, 1);
    await this.handleSystemCommand(message, slot, {
      type: "resume",
      target: "1",
      preserveTaskSnapshot: true,
      taskListScope: "adapter",
      sessionAlreadyRestored: true,
    });
    this.activeTaskListScope = "global";
  }

  private updateDaemonTaskListSnapshot(
    slot: DaemonSlot,
    candidates: Awaited<ReturnType<BridgeAdapter["listResumeSessions"]>>,
    refresh: boolean,
  ): DaemonTaskListSnapshot {
    const snapshot = resolveDaemonTaskListSnapshot({
      current: slot.taskListSnapshot,
      latestCandidates: candidates,
      refresh,
    });
    if (snapshot !== slot.taskListSnapshot) {
      slot.taskListSnapshot = snapshot;
      slot.taskNumberByThreadId.clear();
      for (const [threadId, number] of snapshot.numberByThreadId) {
        slot.taskNumberByThreadId.set(threadId, number);
      }
    }
    return snapshot;
  }

  private rememberCodexTaskCandidates(
    slot: DaemonSlot,
    candidates: BridgeResumeSessionCandidate[],
  ): BridgeResumeSessionCandidate[] {
    if (slot.adapter === "codex") {
      slot.taskCandidatesCache = candidates;
      slot.taskCandidatesCachedAtMs = Date.now();
    }
    return candidates;
  }

  private async getCodexTaskCandidates(
    slot: DaemonSlot,
    options: { forceRefresh?: boolean; maxAgeMs?: number } = {},
  ): Promise<BridgeResumeSessionCandidate[]> {
    if (slot.adapter !== "codex") {
      return await slot.runtime.listResumeSessions(100);
    }
    const maxAgeMs = options.maxAgeMs ?? CODEX_TASK_CANDIDATE_CACHE_MAX_AGE_MS;
    if (
      !options.forceRefresh &&
      slot.taskCandidatesCache &&
      isCodexTaskCandidateCacheFresh({
        cachedAtMs: slot.taskCandidatesCachedAtMs,
        maxAgeMs,
      })
    ) {
      return slot.taskCandidatesCache;
    }
    if (slot.taskCandidatesRefreshPromise) {
      return await slot.taskCandidatesRefreshPromise;
    }
    const refreshPromise = slot.runtime.listResumeSessions(100).then(
      (candidates) => this.rememberCodexTaskCandidates(slot, candidates),
    );
    slot.taskCandidatesRefreshPromise = refreshPromise;
    try {
      return await refreshPromise;
    } finally {
      if (slot.taskCandidatesRefreshPromise === refreshPromise) {
        slot.taskCandidatesRefreshPromise = null;
      }
    }
  }

  private prefixSlotMessage(
    slot: DaemonSlot,
    text: string,
    threadId?: string,
  ): string {
    const taskTitle = threadId
      ? slot.taskListSnapshot?.candidates.find(
          (candidate) => candidate.sessionId === threadId,
        )?.title ??
        slot.taskCandidatesCache?.find(
          (candidate) => candidate.sessionId === threadId,
        )?.title ??
        (slot.adapter === "codex" ? this.codexTaskObservations.get(threadId)?.title : undefined)
      : undefined;
    return prefixDaemonTaskMessage(
      slot.adapter,
      text,
      threadId ? slot.taskNumberByThreadId.get(threadId) : undefined,
      threadId,
      taskTitle,
    );
  }

  private withCodexMobileTaskLink(
    slot: DaemonSlot,
    text: string,
    threadId?: string,
  ): string {
    if (!threadId) {
      return text;
    }
    return appendCodexMobileTaskLink(
      text,
      this.codexMobileServer?.buildTaskUrl(threadId, slot.adapter),
    );
  }

  private prefixSlotMessageWithMobileLink(
    slot: DaemonSlot,
    text: string,
    threadId?: string,
  ): string {
    return this.prefixSlotMessage(
      slot,
      this.withCodexMobileTaskLink(slot, text, threadId),
      threadId,
    );
  }

  private persistDeferredCodexInboundMessages(slot: DaemonSlot): void {
    if (slot.adapter !== "codex") {
      return;
    }
    this.deferredInputStore.replace(
      slot.deferredInboundMessages.entries().flatMap(({ threadId, items }) =>
        items.map((item) => ({ threadId, item }))
      ),
    );
  }

  private clearDeferredCodexInboundMessages(
    slot: DaemonSlot,
    threadId?: string,
  ): void {
    slot.deferredInboundMessages.clear(threadId);
    this.persistDeferredCodexInboundMessages(slot);
  }

  private clearDeferredCodexDrainRetry(
    slot: DaemonSlot,
    threadId: string,
  ): void {
    const timer = slot.deferredDrainRetryTimers.get(threadId);
    if (timer) {
      clearTimeout(timer);
      slot.deferredDrainRetryTimers.delete(threadId);
    }
    slot.deferredDrainRetryAttempts.delete(threadId);
  }

  private scheduleDeferredCodexInboundDrain(
    slot: DaemonSlot,
    threadId: string,
  ): void {
    if (slot.deferredDrainRetryTimers.has(threadId)) {
      return;
    }
    const attempt = (slot.deferredDrainRetryAttempts.get(threadId) ?? 0) + 1;
    slot.deferredDrainRetryAttempts.set(threadId, attempt);
    const delayMs = computeCodexDeferredDrainRetryDelayMs(attempt);
    const timer = setTimeout(() => {
      slot.deferredDrainRetryTimers.delete(threadId);
      void this.maybeDrainDeferredCodexInboundMessages(slot, threadId);
    }, delayMs);
    slot.deferredDrainRetryTimers.set(threadId, timer);
    timer.unref?.();
  }

  private drainAllDeferredCodexInboundMessages(slot: DaemonSlot): void {
    for (const threadId of slot.deferredInboundMessages.threadIds()) {
      this.clearDeferredCodexDrainRetry(slot, threadId);
      void this.maybeDrainDeferredCodexInboundMessages(slot, threadId);
    }
  }

  private async maybeDrainDeferredCodexInboundMessages(
    slot: DaemonSlot,
    threadId: string,
  ): Promise<void> {
    if (
      slot.adapter !== "codex" ||
      slot.deferredInboundMessages.count(threadId) === 0 ||
      !slot.deferredInboundMessages.beginDrain(threadId)
    ) {
      return;
    }

    let retryAfterTransientError = false;
    let drainNextQueuedMessage = false;
    try {
      const runtimeState = slot.runtime.getState();
      const selectedThreadId =
        runtimeState.sharedThreadId ?? runtimeState.sharedSessionId;
      const hasPendingApproval = slot.pendingConfirmations.some(
        (pending) => pending.threadId === threadId,
      );
      const hasPendingUserInput = slot.pendingUserInputs.some(
        (pending) => pending.threadId === threadId,
      );
      const selectedThreadBlocked =
        selectedThreadId === threadId &&
        (runtimeState.status === "busy" ||
          runtimeState.status === "awaiting_approval" ||
          runtimeState.status === "awaiting_input" ||
          Boolean(runtimeState.activeTurnId));
      if (
        this.getSlotActiveTask(slot, threadId) ||
        hasPendingApproval ||
        hasPendingUserInput ||
        selectedThreadBlocked
      ) {
        return;
      }

      const nextDeferred = slot.deferredInboundMessages.peek(threadId);
      if (!nextDeferred) {
        return;
      }
      const deferredText = nextDeferred.source === "wechat"
        ? nextDeferred.message.text
        : nextDeferred.text;
      appendDaemonLog(
        `draining_deferred_inbound_input: adapter=codex source=${nextDeferred.source} thread=${threadId} remaining=${Math.max(0, slot.deferredInboundMessages.count(threadId) - 1)} text=${truncatePreview(deferredText)}`,
      );
      try {
        if (nextDeferred.source === "wechat") {
          await this.dispatchInboundWechatText(nextDeferred.message, slot, threadId);
        } else {
          await this.dispatchMobileText(slot, threadId, nextDeferred.text);
        }
        slot.deferredInboundMessages.shift(threadId);
        this.persistDeferredCodexInboundMessages(slot);
        this.clearDeferredCodexDrainRetry(slot, threadId);
        drainNextQueuedMessage = slot.deferredInboundMessages.count(threadId) > 0;
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        if (isRetryableDeferredCodexDrainError(errorText)) {
          appendDaemonLog(
            `deferred_inbound_blocked: adapter=codex thread=${threadId} error=${truncatePreview(errorText, 400)}`,
          );
          retryAfterTransientError = true;
          return;
        }

        slot.deferredInboundMessages.shift(threadId);
        this.persistDeferredCodexInboundMessages(slot);
        this.clearDeferredCodexDrainRetry(slot, threadId);
        appendDaemonLog(
          `deferred_inbound_error: adapter=codex thread=${threadId} error=${truncatePreview(errorText, 400)}`,
        );
        if (nextDeferred.source === "wechat") {
          await this.queueWechatMessage(
            nextDeferred.message.senderId,
            this.prefixSlotMessage(
              slot,
              formatUserFacingInboundError({
                adapter: slot.adapter,
                cwd: this.cwd,
                errorText,
                isUserFacingShellRejection: false,
              }),
              threadId,
            ),
            "inbound_error",
          );
        }
        drainNextQueuedMessage = slot.deferredInboundMessages.count(threadId) > 0;
      }
    } finally {
      slot.deferredInboundMessages.endDrain(threadId);
      if (retryAfterTransientError) {
        this.scheduleDeferredCodexInboundDrain(slot, threadId);
      } else if (drainNextQueuedMessage) {
        const timer = setTimeout(() => {
          void this.maybeDrainDeferredCodexInboundMessages(slot, threadId);
        }, 0);
        timer.unref?.();
      }
    }
  }

  private async dispatchInboundWechatText(
    message: InboundWechatMessage,
    slot: DaemonSlot,
    targetThreadId?: string,
    options: { suppressCodexAcceptedNotice?: boolean } = {},
  ): Promise<void> {
    const preview = formatInboundMessagePreview(message);
    const startedAt = Date.now();
    const initialThreadId =
      targetThreadId ??
      slot.runtime.getState().sharedThreadId ??
      slot.runtime.getState().sharedSessionId;
    const activeTask: ActiveTask = {
      startedAt,
      inputPreview: truncatePreview(preview, 180),
    };
    const previousActiveTask = this.getSlotActiveTask(slot, initialThreadId);
    this.setSlotActiveTask(slot, activeTask, initialThreadId);
    appendDaemonLog(
      `forwarded_input: adapter=${slot.adapter} text=${truncatePreview(preview)}`,
    );
    let sendResult: BridgeSessionSendResult | void = undefined;
    try {
      const input = buildWechatInboundPrompt(message.text, message.attachments);
      if (targetThreadId && slot.runtime.sendInputToSession) {
        sendResult = await slot.runtime.sendInputToSession(targetThreadId, input);
      } else {
        await slot.runtime.sendInput(input);
      }
      if (sendResult?.turnId) {
        activeTask.turnId = sendResult.turnId;
        activeTask.turnIdAuthoritative = true;
      }
      if (sendResult?.queued || sendResult?.duplicate) {
        if (previousActiveTask) {
          this.setSlotActiveTask(slot, previousActiveTask, initialThreadId);
        } else {
          this.clearSlotActiveTask(slot, initialThreadId);
        }
      }
    } catch (error) {
      if (previousActiveTask) {
        this.setSlotActiveTask(slot, previousActiveTask, initialThreadId);
      } else {
        this.clearSlotActiveTask(slot, initialThreadId);
      }
      throw error;
    }
    const resolvedThreadId =
      targetThreadId ??
      slot.runtime.getState().sharedThreadId ??
      slot.runtime.getState().sharedSessionId ??
      initialThreadId;
    if (
      resolvedThreadId !== initialThreadId &&
      !sendResult?.queued &&
      !sendResult?.duplicate
    ) {
      this.clearSlotActiveTask(slot, initialThreadId);
      this.setSlotActiveTask(slot, activeTask, resolvedThreadId);
    }
    if (slot.adapter === "codex") {
      slot.wechatReplyThreadId = resolvedThreadId;
      this.persistCodexWechatThreadId(resolvedThreadId);
      if (!options.suppressCodexAcceptedNotice) {
        await this.queueWechatMessage(
          message.senderId,
          this.prefixSlotMessageWithMobileLink(
            slot,
            sendResult?.duplicate
              ? formatCodexTaskDuplicateMessage()
              : sendResult?.queued
                ? formatCodexTaskQueuedMessage(sendResult.queuePosition)
                : formatCodexTaskAcceptedMessage(),
            resolvedThreadId,
          ),
          "notice",
        );
      }
    }
  }

  private async dispatchMobileText(
    slot: DaemonSlot,
    threadId: string,
    text: string,
  ): Promise<BridgeSessionSendResult | void> {
    return await this.dispatchMobileInput(slot, threadId, text, []);
  }

  private async dispatchMobileInput(
    slot: DaemonSlot,
    threadId: string,
    text: string,
    imagePaths: string[],
  ): Promise<BridgeSessionSendResult | void> {
    if (!slot.runtime.sendInputToSession) {
      throw new Error("当前应用连接暂不支持向指定任务发送消息。");
    }
    if (imagePaths.length > 0 && !slot.runtime.sendInputItemsToSession) {
      throw new Error("当前应用连接暂不支持发送图片。");
    }
    const trimmedText = text.trim();
    const inputPreview = trimmedText || `图片 ${imagePaths.length} 张`;
    const activeTask: ActiveTask = {
      startedAt: Date.now(),
      inputPreview: truncatePreview(inputPreview, 180),
    };
    const previousActiveTask = this.getSlotActiveTask(slot, threadId);
    this.setSlotActiveTask(slot, activeTask, threadId);
    appendDaemonLog(
      `mobile_input_forwarded: adapter=${slot.adapter} thread=${threadId} images=${imagePaths.length} text=${truncatePreview(trimmedText)}`,
    );
    try {
      let result: BridgeSessionSendResult | void;
      if (imagePaths.length > 0 && slot.runtime.sendInputItemsToSession) {
        result = await slot.runtime.sendInputItemsToSession(threadId, [
          ...(trimmedText ? [{ type: "text" as const, text }] : []),
          ...imagePaths.map((imagePath) => ({
            type: "localImage" as const,
            path: imagePath,
          })),
        ]);
      } else {
        result = await slot.runtime.sendInputToSession(threadId, text);
      }
      if (result?.turnId) {
        activeTask.turnId = result.turnId;
        activeTask.turnIdAuthoritative = true;
      }
      if (result?.queued || result?.duplicate) {
        if (previousActiveTask) {
          this.setSlotActiveTask(slot, previousActiveTask, threadId);
        } else {
          this.clearSlotActiveTask(slot, threadId);
        }
      }
      return result;
    } catch (error) {
      if (previousActiveTask) {
        this.setSlotActiveTask(slot, previousActiveTask, threadId);
      } else {
        this.clearSlotActiveTask(slot, threadId);
      }
      throw error;
    }
  }

  private queueWechatTextAction<T>(action: () => Promise<T>): Promise<T> {
    const run = this.textSendChain.then(action);
    this.textSendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private queueWechatAttachmentAction<T>(action: () => Promise<T>): Promise<T> {
    const run = this.attachmentSendChain.then(action);
    this.attachmentSendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async sendWechatMessageNow(
    senderId: string,
    text: string,
    context: WechatSendContext,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= WECHAT_SEND_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.transport.sendText(senderId, text);
        return true;
      } catch (error) {
        if (isWechatContextTokenStaleError(error)) {
          this.transport.clearCachedContextToken(senderId);
          appendDaemonLog(
            formatWechatContextTokenStaleLogEntry({
              context,
              recipientId: senderId,
              error,
            }),
          );
          return false;
        }

        if (attempt < WECHAT_SEND_MAX_ATTEMPTS && isRetryableWechatSendError(error)) {
          const delayMs = computeWechatSendRetryDelayMs(attempt);
          appendDaemonLog(
            `wechat_send_retry: context=${context} recipient=${senderId} attempt=${attempt} delay_ms=${delayMs} error=${truncatePreview(describeWechatTransportError(error), 400)}`,
          );
          await delay(delayMs);
          continue;
        }

        logError(`Failed to send WeChat ${context}: ${describeWechatTransportError(error)}`);
        appendDaemonLog(
          formatWechatSendFailureLogEntry({
            context,
            recipientId: senderId,
            error,
          }),
        );
        return false;
      }
    }

    return false;
  }

  private async retryUndeliveredApprovalNotifications(
    senderId: string,
  ): Promise<void> {
    for (const delivery of this.approvalNotificationDeliveries.getPending()) {
      if (!await this.isApprovalNotificationStillPending(delivery)) {
        this.approvalNotificationDeliveries.cancel(delivery.key);
        continue;
      }
      const result = await this.deliverApprovalNotification(delivery.key, senderId);
      if (result.status === "in_flight") continue;
      if (result.status === "delivered") {
        const slot = this.slots.get(delivery.adapter);
        const tracked = slot?.pendingConfirmations.find((candidate) =>
          buildDaemonApprovalDeliveryKey(delivery.adapter, candidate) === delivery.key
        );
        if (tracked) {
          slot?.notifiedApprovalKeys.add(buildDaemonApprovalNotificationKey(tracked));
        }
        appendDaemonLog(
          `approval_resent_after_context_refresh: adapter=${delivery.adapter} thread=${delivery.threadId}`,
        );
        continue;
      }
      break;
    }
  }

  private deliverApprovalNotification(
    key: string,
    senderId: string,
  ) {
    return this.approvalNotificationDeliveries.deliver(
      key,
      (delivery) => this.queueWechatMessage(
        senderId,
        delivery.text,
        "approval_required",
      ),
    );
  }

  private async isApprovalNotificationStillPending(
    delivery: PendingApprovalNotificationDelivery,
  ): Promise<boolean> {
    let slot = this.slots.get(delivery.adapter);
    if (!slot && delivery.adapter === "codex") {
      try {
        await this.ensureSlot(delivery.adapter, {
          openVisible: false,
          reuseExistingVisible: true,
          sessionStartMode: "restore",
          activate: false,
        });
        slot = this.slots.get(delivery.adapter);
      } catch (error) {
        appendDaemonLog(
          `approval_retry_restore_pending: adapter=${delivery.adapter} thread=${delivery.threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 300)}`,
        );
        return true;
      }
    }
    if (!slot) return true;
    if (slot.runtime.getPendingTaskApprovals) {
      const runtimePending = slot.runtime.getPendingTaskApprovals(delivery.threadId);
      if (runtimePending.some((candidate) =>
        buildDaemonApprovalDeliveryKey(delivery.adapter, candidate) === delivery.key ||
        Boolean(
          delivery.commandPreview &&
          redactSensitiveCommandText(candidate.commandPreview) === delivery.commandPreview &&
          (!delivery.turnId || !candidate.turnId || candidate.turnId === delivery.turnId),
        )
      )) {
        return true;
      }
      return slot.pendingConfirmations.some((candidate) =>
        buildDaemonApprovalDeliveryKey(delivery.adapter, candidate) === delivery.key
      );
    }
    return slot.pendingConfirmations.some((candidate) =>
      buildDaemonApprovalDeliveryKey(delivery.adapter, candidate) === delivery.key
    ) || Boolean(slot.runtime.getState().pendingApproval);
  }

  private deliverCodexCompletionNotification(
    notificationKey: string,
    senderId: string,
  ): Promise<CodexCompletionDeliveryResult> {
    return this.codexCompletionDeliveries.deliver(
      notificationKey,
      (_delivery, remainingTexts) => this.queueWechatMessages(
        senderId,
        remainingTexts,
        "mobile_link",
      ),
    );
  }

  private async retryPendingCodexCompletionNotifications(
    senderId: string,
  ): Promise<void> {
    const backlog = selectCodexCompletionBacklogBatch(
      this.codexCompletionDeliveries.getPending(),
    );
    if (backlog.length > 0) {
      const summarySent = await this.queueWechatMessage(
        senderId,
        formatCodexCompletionBacklogSummary(backlog),
        "mobile_link",
      );
      if (!summarySent) {
        appendDaemonLog(
          `codex_completion_backlog_pending: completions=${backlog.length} reason=wechat_unavailable`,
        );
        return;
      }
      const acknowledged = this.codexCompletionDeliveries.acknowledge(
        backlog.map((delivery) => delivery.key),
      );
      for (const delivery of acknowledged) {
        this.clearCodexFinalReplyCache(delivery.threadId, delivery.turnId);
      }
      appendDaemonLog(
        `codex_completion_backlog_summarized: completions=${acknowledged.length} tasks=${new Set(acknowledged.map((delivery) => delivery.threadId)).size}`,
      );
    }

    for (const pending of this.codexCompletionDeliveries.getPending()) {
      const result = await this.deliverCodexCompletionNotification(
        pending.key,
        senderId,
      );
      if (result.status === "in_flight") {
        continue;
      }
      if (result.sentCount > 0) {
        const slot = this.slots.get("codex");
        if (slot) {
          slot.wechatReplyThreadId = pending.threadId;
        }
        this.persistCodexWechatThreadId(pending.threadId);
      }
      if (result.status === "delivered") {
        this.clearCodexFinalReplyCache(pending.threadId, pending.turnId);
        appendDaemonLog(
          `codex_completion_resent: thread=${pending.threadId} messages=${result.totalCount}`,
        );
        continue;
      }
      appendDaemonLog(
        `codex_completion_retry_pending: thread=${pending.threadId} sent=${result.delivery?.nextTextIndex ?? pending.nextTextIndex}/${result.totalCount}`,
      );
      break;
    }
  }

  private async prepareWechatMessageTaskLinks(text: string): Promise<string> {
    if (!this.deskRelayRelayTaskLinks || !text.includes("/t/")) {
      return text;
    }
    const resolved = await this.deskRelayRelayTaskLinks.confirmTaskLinksInText(text);
    if (resolved.unresolvedCount > 0) {
      appendDaemonLog(
        `wechat_task_short_link_unavailable: count=${resolved.unresolvedCount}`,
      );
    }
    return resolved.text;
  }

  private queueWechatMessage(
    senderId: string,
    text: string,
    context: WechatSendContext = "message",
  ): Promise<boolean> {
    return this.queueWechatTextAction(async () => {
      const preparedText = await this.prepareWechatMessageTaskLinks(text);
      return await this.sendWechatMessageNow(senderId, preparedText, context);
    });
  }

  private queueWechatMessages(
    senderId: string,
    texts: string[],
    context: WechatSendContext = "message",
  ): Promise<number> {
    return this.queueWechatTextAction(async () => {
      let sentCount = 0;
      for (const text of texts) {
        const preparedText = await this.prepareWechatMessageTaskLinks(text);
        if (!await this.sendWechatMessageNow(senderId, preparedText, context)) {
          break;
        }
        sentCount += 1;
      }
      return sentCount;
    });
  }

  private trackWechatForwardTask(task: Promise<void>): void {
    const tracked = task
      .catch((error) => {
        logError(`WeChat forward task failed: ${describeWechatTransportError(error)}`);
        appendDaemonLog(
          `wechat_forward_failed: error=${truncatePreview(describeWechatTransportError(error), 400)}`,
        );
      })
      .finally(() => {
        this.pendingWechatForwardTasks.delete(tracked);
      });
    this.pendingWechatForwardTasks.add(tracked);
  }

  private async waitForPendingWechatForwardTasks(): Promise<void> {
    while (this.pendingWechatForwardTasks.size > 0) {
      await Promise.allSettled([...this.pendingWechatForwardTasks]);
    }
  }
}

export type DaemonCleanupResult =
  | { action: "none" }
  | { action: "cleared_stale_endpoint"; endpoint: DaemonEndpoint }
  | { action: "stopped"; endpoint: DaemonEndpoint; forced: boolean };

type DaemonCleanupDeps = {
  cwd?: string;
  readEndpoint?: () => DaemonEndpoint | null;
  isAlive?: (pid: number) => boolean;
  sendRequest?: (
    endpoint: DaemonEndpoint,
    payload: DaemonRequest,
    options?: { timeoutMs?: number },
  ) => Promise<DaemonResponse>;
  killProcess?: (pid: number) => void;
  clearEndpoint?: (pid?: number) => void;
  clearWorkspaceEndpoints?: (endpoint: DaemonEndpoint) => void;
  isDaemonProcess?: (endpoint: DaemonEndpoint) => boolean;
  listDaemonProcesses?: (cwd: string) => BridgeProcessRecord[];
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  daemonLog?: (message: string) => void;
  stopTimeoutMs?: number;
  forceStopTimeoutMs?: number;
  pollMs?: number;
};

function clearDaemonWorkspaceEndpoints(endpoint: DaemonEndpoint): void {
  for (const adapter of DAEMON_ADAPTERS) {
    clearLocalCompanionEndpoint(endpoint.cwd, undefined, { adapter });
  }
}

function isEndpointDaemonProcess(endpoint: DaemonEndpoint): boolean {
  const record = getProcessRecordByPid(endpoint.pid);
  return Boolean(record && isWeRelayDaemonCommandLine(record.commandLine));
}

function selectDaemonProcessesToStop(
  records: BridgeProcessRecord[],
  excludedPids: Set<number>,
): BridgeProcessRecord[] {
  const recordPids = new Set(records.map((record) => record.pid));
  return records.filter((record) => {
    if (excludedPids.has(record.pid)) {
      return false;
    }

    return !records.some(
      (candidate) =>
        candidate.parentPid === record.pid &&
        recordPids.has(candidate.pid) &&
        !excludedPids.has(candidate.pid),
    );
  });
}

async function stopDaemonPeerProcesses(params: {
  cwd: string;
  listDaemonProcesses: (cwd: string) => BridgeProcessRecord[];
  killProcess: (pid: number) => void;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollMs: number;
  daemonLog: (message: string) => void;
}): Promise<number[]> {
  const excludedPids = new Set([process.pid, process.ppid]);
  const peerRecords = selectDaemonProcessesToStop(
    params.listDaemonProcesses(params.cwd),
    excludedPids,
  );
  const stoppedPids: number[] = [];

  for (const peer of peerRecords) {
    params.daemonLog(
      `daemon_peer_takeover_attempt: pid=${peer.pid} cwd=${params.cwd} command=${truncatePreview(peer.commandLine, 400)}`,
    );
    params.killProcess(peer.pid);
    if (await waitForProcessExit({
      pid: peer.pid,
      timeoutMs: params.timeoutMs,
      pollMs: params.pollMs,
      isAlive: params.isAlive,
      sleep: params.sleep,
    })) {
      stoppedPids.push(peer.pid);
      params.daemonLog(`daemon_peer_takeover_complete: pid=${peer.pid}`);
    } else {
      params.daemonLog(`daemon_peer_takeover_timeout: pid=${peer.pid}`);
    }
  }

  return stoppedPids;
}

export async function cleanupDaemonBeforeStart(
  deps: DaemonCleanupDeps = {},
): Promise<DaemonCleanupResult> {
  const readEndpoint = deps.readEndpoint ?? readDaemonEndpoint;
  const isAlive = deps.isAlive ?? isPidAlive;
  const sendRequest = deps.sendRequest ?? sendDaemonRequest;
  const killProcess = deps.killProcess ?? killProcessTreeSync;
  const clearEndpoint = deps.clearEndpoint ?? clearDaemonEndpoint;
  const clearWorkspaceEndpoints =
    deps.clearWorkspaceEndpoints ?? clearDaemonWorkspaceEndpoints;
  const isDaemonProcess = deps.isDaemonProcess ?? isEndpointDaemonProcess;
  const listDaemonProcesses =
    deps.listDaemonProcesses ??
    ((cwd: string) =>
      listWeRelayDaemonProcesses({
        cwd,
        excludePids: [process.pid, process.ppid],
      }));
  const sleepFn = deps.sleep ?? sleep;
  const cleanupLog = deps.log ?? log;
  const daemonLog = deps.daemonLog ?? appendDaemonLog;
  const stopTimeoutMs = deps.stopTimeoutMs ?? DAEMON_TAKEOVER_STOP_TIMEOUT_MS;
  const forceStopTimeoutMs =
    deps.forceStopTimeoutMs ?? DAEMON_TAKEOVER_FORCE_STOP_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? DAEMON_TAKEOVER_STOP_POLL_MS;
  const endpoint = readEndpoint();
  const cleanupCwd = endpoint?.cwd ?? deps.cwd;

  if (!endpoint) {
    if (cleanupCwd) {
      await stopDaemonPeerProcesses({
        cwd: cleanupCwd,
        listDaemonProcesses,
        killProcess,
        isAlive,
        sleep: sleepFn,
        timeoutMs: forceStopTimeoutMs,
        pollMs,
        daemonLog,
      });
    }
    return { action: "none" };
  }

  const clearDaemonArtifacts = () => {
    clearWorkspaceEndpoints(endpoint);
    clearEndpoint(endpoint.pid);
  };

  if (endpoint.pid === process.pid || !isAlive(endpoint.pid)) {
    cleanupLog(
      `Found stale werelay-daemon endpoint for ${endpoint.cwd} (pid=${endpoint.pid}). Cleaning it before daemon startup.`,
    );
    daemonLog(
      `daemon_stale_endpoint_cleanup: pid=${endpoint.pid} cwd=${endpoint.cwd}`,
    );
    clearDaemonArtifacts();
    await stopDaemonPeerProcesses({
      cwd: endpoint.cwd,
      listDaemonProcesses,
      killProcess,
      isAlive,
      sleep: sleepFn,
      timeoutMs: forceStopTimeoutMs,
      pollMs,
      daemonLog,
    });
    return { action: "cleared_stale_endpoint", endpoint };
  }

  cleanupLog(
    `Found existing werelay-daemon for ${endpoint.cwd} (pid=${endpoint.pid}). Stopping it before daemon startup...`,
  );
  daemonLog(
    `daemon_takeover_attempt: pid=${endpoint.pid} cwd=${endpoint.cwd}`,
  );

  let shutdownAcknowledged = false;
  try {
    const response = await sendRequest(
      endpoint,
      { command: "shutdown" },
      { timeoutMs: 1_000 },
    );
    if (response.ok) {
      shutdownAcknowledged = true;
    } else {
      daemonLog(
        `daemon_shutdown_request_failed: pid=${endpoint.pid} error=${truncatePreview(response.error, 400)}`,
      );
    }
  } catch (error) {
    daemonLog(
      `daemon_shutdown_request_failed: pid=${endpoint.pid} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
    );
  }

  let forced = false;
  let stopped = await waitForProcessExit({
    pid: endpoint.pid,
    timeoutMs: stopTimeoutMs,
    pollMs,
    isAlive,
    sleep: sleepFn,
  });

  if (!stopped) {
    if (!shutdownAcknowledged && !isDaemonProcess(endpoint)) {
      daemonLog(
        `daemon_force_stop_skipped_unverified: pid=${endpoint.pid} cwd=${endpoint.cwd}`,
      );
      clearDaemonArtifacts();
      await stopDaemonPeerProcesses({
        cwd: endpoint.cwd,
        listDaemonProcesses,
        killProcess,
        isAlive,
        sleep: sleepFn,
        timeoutMs: forceStopTimeoutMs,
        pollMs,
        daemonLog,
      });
      return { action: "cleared_stale_endpoint", endpoint };
    }

    forced = true;
    cleanupLog(
      `Existing daemon pid=${endpoint.pid} did not stop in ${formatDuration(stopTimeoutMs)}. Forcing cleanup...`,
    );
    daemonLog(
      `daemon_force_stop_attempt: pid=${endpoint.pid} cwd=${endpoint.cwd}`,
    );
    try {
      killProcess(endpoint.pid);
    } catch (error) {
      if (isAlive(endpoint.pid)) {
        daemonLog(
          `daemon_force_stop_failed: pid=${endpoint.pid} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
      }
    }
    stopped = await waitForProcessExit({
      pid: endpoint.pid,
      timeoutMs: forceStopTimeoutMs,
      pollMs,
      isAlive,
      sleep: sleepFn,
    });
  }

  if (!stopped && isAlive(endpoint.pid)) {
    throw new Error(
      `Could not stop existing werelay-daemon automatically (pid=${endpoint.pid}, cwd=${endpoint.cwd}).`,
    );
  }

  clearDaemonArtifacts();
  cleanupLog(
    `Cleaned previous werelay-daemon for ${endpoint.cwd}; daemon startup can continue.`,
  );
  daemonLog(
    `daemon_takeover_complete: pid=${endpoint.pid} cwd=${endpoint.cwd} forced=${forced}`,
  );
  await stopDaemonPeerProcesses({
    cwd: endpoint.cwd,
    listDaemonProcesses,
    killProcess,
    isAlive,
    sleep: sleepFn,
    timeoutMs: forceStopTimeoutMs,
    pollMs,
    daemonLog,
  });
  return { action: "stopped", endpoint, forced };
}

export type SingleBridgeCleanupResult =
  | { action: "none" }
  | { action: "cleared_stale_lock"; lock: BridgeLockPayload }
  | { action: "stopped"; lock: BridgeLockPayload; forced: boolean };

type SingleBridgeCleanupDeps = {
  readLock?: () => BridgeLockPayload | null;
  isAlive?: (pid: number) => boolean;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  clearLock?: (lock: BridgeLockPayload) => void;
  clearEndpoint?: (lock: BridgeLockPayload) => void;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  daemonLog?: (message: string) => void;
  stopTimeoutMs?: number;
  forceStopTimeoutMs?: number;
  pollMs?: number;
};

async function waitForProcessExit(params: {
  pid: number;
  timeoutMs: number;
  pollMs: number;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    if (!params.isAlive(params.pid)) {
      return true;
    }
    await params.sleep(Math.min(params.pollMs, deadline - Date.now()));
  }
  return !params.isAlive(params.pid);
}

function clearSingleBridgeLock(lock: BridgeLockPayload): void {
  try {
    const current = readBridgeLockFile();
    if (
      !current ||
      current.pid === lock.pid ||
      current.instanceId === lock.instanceId
    ) {
      fs.rmSync(BRIDGE_LOCK_FILE, { force: true });
    }
  } catch {
    // Best effort cleanup.
  }
}

function clearSingleBridgeEndpoint(lock: BridgeLockPayload): void {
  clearLocalCompanionEndpoint(lock.cwd, undefined, { adapter: lock.adapter });
}

export async function cleanupSingleBridgeBeforeDaemon(
  deps: SingleBridgeCleanupDeps = {},
): Promise<SingleBridgeCleanupResult> {
  const readLock = deps.readLock ?? readBridgeLockFile;
  const isAlive = deps.isAlive ?? isPidAlive;
  const killProcess = deps.killProcess ?? ((pid, signal) => {
    if (signal === "SIGKILL" || process.platform === "win32") {
      killProcessTreeSync(pid);
      return;
    }
    process.kill(pid, signal);
  });
  const clearLock = deps.clearLock ?? clearSingleBridgeLock;
  const clearEndpoint = deps.clearEndpoint ?? clearSingleBridgeEndpoint;
  const sleepFn = deps.sleep ?? sleep;
  const cleanupLog = deps.log ?? log;
  const daemonLog = deps.daemonLog ?? appendDaemonLog;
  const stopTimeoutMs = deps.stopTimeoutMs ?? SINGLE_BRIDGE_STOP_TIMEOUT_MS;
  const forceStopTimeoutMs =
    deps.forceStopTimeoutMs ?? SINGLE_BRIDGE_FORCE_STOP_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? SINGLE_BRIDGE_STOP_POLL_MS;
  const lock = readLock();

  if (!lock) {
    return { action: "none" };
  }

  const clearBridgeArtifacts = () => {
    clearEndpoint(lock);
    clearLock(lock);
  };

  if (!isAlive(lock.pid)) {
    cleanupLog(
      `Found stale single bridge lock for ${lock.cwd} (pid=${lock.pid} dead). Cleaning it before daemon startup.`,
    );
    daemonLog(
      `single_bridge_stale_cleanup: pid=${lock.pid} adapter=${lock.adapter} cwd=${lock.cwd}`,
    );
    clearBridgeArtifacts();
    return { action: "cleared_stale_lock", lock };
  }

  cleanupLog(
    `Found existing single bridge for ${lock.cwd} (pid=${lock.pid}, adapter=${lock.adapter}). Stopping it before daemon startup...`,
  );
  daemonLog(
    `single_bridge_takeover_attempt: pid=${lock.pid} adapter=${lock.adapter} cwd=${lock.cwd}`,
  );

  try {
    killProcess(lock.pid, "SIGTERM");
  } catch (error) {
    if (isAlive(lock.pid)) {
      daemonLog(
        `single_bridge_sigterm_failed: pid=${lock.pid} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
      );
    }
  }

  let forced = false;
  let stopped = await waitForProcessExit({
    pid: lock.pid,
    timeoutMs: stopTimeoutMs,
    pollMs,
    isAlive,
    sleep: sleepFn,
  });

  if (!stopped) {
    forced = true;
    cleanupLog(
      `Single bridge pid=${lock.pid} did not stop in ${formatDuration(stopTimeoutMs)}. Forcing cleanup...`,
    );
    daemonLog(
      `single_bridge_force_stop_attempt: pid=${lock.pid} adapter=${lock.adapter} cwd=${lock.cwd}`,
    );
    try {
      killProcess(lock.pid, "SIGKILL");
    } catch (error) {
      if (isAlive(lock.pid)) {
        daemonLog(
          `single_bridge_sigkill_failed: pid=${lock.pid} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
        );
      }
    }
    stopped = await waitForProcessExit({
      pid: lock.pid,
      timeoutMs: forceStopTimeoutMs,
      pollMs,
      isAlive,
      sleep: sleepFn,
    });
  }

  if (!stopped && isAlive(lock.pid)) {
    throw new Error(
      `Could not stop existing single bridge automatically (pid=${lock.pid}, adapter=${lock.adapter}, cwd=${lock.cwd}).`,
    );
  }

  clearBridgeArtifacts();
  cleanupLog(
    `Cleaned previous single bridge for ${lock.cwd}; daemon startup can continue.`,
  );
  daemonLog(
    `single_bridge_takeover_complete: pid=${lock.pid} adapter=${lock.adapter} cwd=${lock.cwd} forced=${forced}`,
  );
  return { action: "stopped", lock, forced };
}

export async function runDaemon(
  options: DaemonCliOptions,
): Promise<void> {
  migrateLegacyChannelFiles((message) => log(message));
  await cleanupDaemonBeforeStart({ cwd: options.cwd });
  const cleanupResult = await cleanupSingleBridgeBeforeDaemon();
  const reapedPeerPids = await reapPeerBridgeProcesses({
    logger: (message) => appendDaemonLog(message),
  });
  if (reapedPeerPids.length > 0) {
    log(`Cleaned ${reapedPeerPids.length} peer bridge process(es): ${reapedPeerPids.join(", ")}`);
  }
  const reapedOpencodePids = await reapOrphanedOpencodeProcesses({
    logger: (message) => appendDaemonLog(message),
  });
  if (reapedOpencodePids.length > 0) {
    log(`Cleaned ${reapedOpencodePids.length} orphaned OpenCode process(es): ${reapedOpencodePids.join(", ")}`);
  }
  const credentials = await ensureWechatCredentials({
    requireUserId: true,
    validateExisting: true,
    log,
  });
  if (!credentials.userId) {
    throw new Error("Saved WeChat credentials are missing userId.");
  }

  const stateStore = new DaemonWorkspaceStateStore(options.cwd);
  const persistedState = stateStore.getPersistedState();
  const daemon = new WeRelayDaemon({
    cwd: options.cwd,
    profile: options.profile,
    authorizedUserId: credentials.userId,
    transport: new WeChatTransport({ log, logError }),
    stateStore,
    allowDesktopApplicationLaunch: options.allowDesktopApplicationLaunch,
  });
  if (cleanupResult.action === "stopped" && isDaemonAdapterKind(cleanupResult.lock.adapter)) {
    daemon.takenOverAdapter = cleanupResult.lock.adapter;
  }
  await daemon.startIpcServer();
  await daemon.startCodexMobileWeb();
  try {
    await daemon.runInitialAdapter(options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appendDaemonLog(
      `initial_adapter_start_error: adapter=${resolveDaemonInitialAdapter(options, persistedState?.activeAdapter) ?? "none"} error=${truncatePreview(detail, 400)}`,
    );
    logError(`初始终端暂时无法连接，WeRelay 将继续运行：${detail}`);
  }
  daemon.configureRestartNotice(persistedState);

  let shutdownInProgress = false;
  const handleSignal = (signal: string) => {
    if (shutdownInProgress) {
      log(`Received ${signal} during shutdown, forcing exit.`);
      process.exit(1);
    }
    shutdownInProgress = true;
    log(`Received ${signal}. Stopping daemon.`);
    void daemon.shutdown().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGHUP", () => handleSignal("SIGHUP"));
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => handleSignal("SIGBREAK"));
  }
  process.on("exit", () => {
    clearDaemonEndpoint();
  });

  await daemon.runPollLoop();
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--doctor")) {
    const { runDoctorCheck } = await import("../utils/doctor.ts");
    await runDoctorCheck(argv, { mode: "daemon" });
    process.exit(0);
  }
  try {
    await runDaemon(parseDaemonCliArgs(argv));
  } catch (error) {
    logError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const isDirectRun = Boolean((import.meta as ImportMeta & { main?: boolean }).main);
if (isDirectRun) {
  void main();
}

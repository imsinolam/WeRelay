import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ApprovalRequest,
  BridgeMessageImage,
  BridgeQueuedTaskInput,
  BridgeResumeSessionCandidate,
  BridgeResumeSessionRuntimeStatus,
  BridgeSessionMessage,
  BridgeSessionMessagePage,
  BridgeSessionMessagePageOptions,
  BridgeSessionModelOption,
  BridgeSessionModelState,
  BridgeSessionPermissionState,
  BridgeSessionProgressItem,
  BridgeSessionReadOptions,
  BridgeSessionRunSummary,
  BridgeSessionSendResult,
  BridgeThreadSwitchReason,
  BridgeThreadSwitchSource,
  BridgeTurnInputItem,
  BridgeTurnOrigin,
} from "./bridge-types.ts";
import {
  detectCliApproval,
  normalizeOutput,
  nowIso,
  sanitizeCodexVisibleAssistantMessageForDisplay,
  sanitizeCodexVisibleUserMessageForDisplay,
  truncatePreview,
} from "./bridge-utils.ts";
import { AbstractPtyAdapter } from "./bridge-adapters.core.ts";
import { killProcessTreeSync } from "./bridge-process-reaper.ts";
import * as shared from "./bridge-adapters.shared.ts";
import {
  ensurePrivateDir,
  writePrivateFileAtomic,
} from "../utils/private-files.ts";
import { readFileTail, scanFileTail } from "../utils/file-tail.ts";
import {
  CodexDesktopIpcClient,
  isCodexDesktopMainProcessRunning,
  type CodexDesktopConversationState,
} from "./codex-desktop-ipc.ts";
import { ensureWorkspaceChannelDir } from "../wechat/channel-config.ts";
import {
  CODEX_REMOTE_AUTH_TOKEN_ENV,
  LOCAL_CLIENT_PROTOCOL_VERSION,
  type LocalClientEndpoint,
} from "../runtime/runtime-types.ts";

type AdapterOptions = shared.AdapterOptions;
type CodexActiveTurn = shared.CodexActiveTurn;
type CodexPendingApprovalRequest = shared.CodexPendingApprovalRequest;
type CodexPendingUserInputRequest = shared.CodexPendingUserInputRequest;
type CodexApprovalResolutionAction =
  | "confirm"
  | "confirm_session"
  | "deny";
type CodexQueuedNotification = shared.CodexQueuedNotification;
type CodexRpcPendingRequest = shared.CodexRpcPendingRequest;
type CodexRpcRequestId = shared.CodexRpcRequestId;
type SpawnTarget = shared.SpawnTarget;
type CodexThreadAnnouncementSignal =
  | "status_changed"
  | "thread_started"
  | "session_fallback"
  | "turn_started"
  | "user_message";
type CodexPendingThreadAnnouncement = {
  threadId: string;
  source: BridgeThreadSwitchSource;
  reason: BridgeThreadSwitchReason;
  signals: Set<CodexThreadAnnouncementSignal>;
  timer: ReturnType<typeof setTimeout> | null;
};

type CodexDesktopTurnState = {
  turnId: string;
  status: string;
  errorMessage: string | null;
  items: unknown[];
  startedAtMs?: number;
};

type CodexSqliteStatement = {
  all(...params: unknown[]): unknown[];
};

type CodexSqliteDatabase = {
  prepare(sql: string): CodexSqliteStatement;
  close(): void;
};

type CodexNodeSqliteModule = {
  DatabaseSync: new (
    pathname: string,
    options: { readOnly: boolean },
  ) => CodexSqliteDatabase;
};

type CodexBunSqliteModule = {
  Database: new (
    pathname: string,
    options: { readonly: boolean },
  ) => CodexSqliteDatabase;
};

export type CodexStateDbSessionCatalog = {
  candidates: BridgeResumeSessionCandidate[];
  rolloutPathByThreadId: Map<string, string>;
};

const CODEX_DESKTOP_RECONNECT_GRACE_MS = 3_000;
const CODEX_DESKTOP_STARTUP_TIMEOUT_MS = 15_000;
const CODEX_DESKTOP_CONNECT_RETRY_INTERVAL_MS = 300;
const CODEX_DESKTOP_METADATA_RECOVERY_GRACE_MS = 300;
const CODEX_DESKTOP_QUEUED_FOLLOW_UP_DRAIN_DELAY_MS = 350;
const CODEX_DESKTOP_BOOTSTRAP_ROLLOUT_WAIT_MS = 2_000;
const CODEX_DESKTOP_BOOTSTRAP_ROLLOUT_POLL_MS = 50;
const CODEX_DESKTOP_METADATA_RECOVERY_MAX_ATTEMPTS = 3;
const CODEX_DESKTOP_METADATA_RECOVERY_RETRY_MS = 500;
const CODEX_DESKTOP_BUNDLED_CLI_PATHS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
] as const;

type CodexDesktopAppServerSpawnTargetOptions = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  isExecutable?: (filePath: string) => boolean;
};

export function resolveCodexDesktopAppServerSpawnTarget(
  command: string,
  options: CodexDesktopAppServerSpawnTargetOptions = {},
): SpawnTarget {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin" && command.trim() === "codex") {
    const isExecutable = options.isExecutable ?? ((filePath: string) => {
      try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    const bundledCli = CODEX_DESKTOP_BUNDLED_CLI_PATHS.find(isExecutable);
    if (bundledCli) {
      return { file: bundledCli, args: [] };
    }
  }
  return resolveSpawnTarget(command, "codex", {
    platform,
    ...(options.env ? { env: options.env } : {}),
  });
}

export type CodexAppServerFailureAction =
  | "suppress"
  | "recover_metadata"
  | "fatal";

export function resolveCodexAppServerFailureAction(params: {
  expectedShutdown: boolean;
  usesDesktopTransport: boolean;
  desktopTransportStarted: boolean;
}): CodexAppServerFailureAction {
  if (params.expectedShutdown) {
    return "suppress";
  }
  if (params.usesDesktopTransport && params.desktopTransportStarted) {
    return "recover_metadata";
  }
  return "fatal";
}

type CodexDesktopIpcConnectOptions = {
  platform?: NodeJS.Platform;
  allowDesktopApplicationLaunch?: boolean;
  isDesktopMainProcessRunning?: () => Promise<boolean>;
  launchDesktopApp?: () => void;
  retryIntervalMs?: number;
  startupTimeoutMs?: number;
};

export async function connectCodexDesktopIpcClientWithLaunch(
  client: Pick<CodexDesktopIpcClient, "connect">,
  options: CodexDesktopIpcConnectOptions = {},
): Promise<void> {
  try {
    await client.connect();
    return;
  } catch (initialError) {
    const platform = options.platform ?? process.platform;
    if (platform !== "darwin") {
      throw initialError;
    }

    const isDesktopMainProcessRunning =
      options.isDesktopMainProcessRunning ?? isCodexDesktopMainProcessRunning;
    if (
      !await isDesktopMainProcessRunning() &&
      options.allowDesktopApplicationLaunch === true
    ) {
      try {
        const launchDesktopApp = options.launchDesktopApp ?? (() => {
          const launcher = spawnChild("/usr/bin/open", ["-g", "-a", "ChatGPT"], {
            detached: true,
            stdio: "ignore",
          });
          launcher.unref();
        });
        launchDesktopApp();
      } catch {
        throw initialError;
      }
    }

    const deadline = Date.now() +
      Math.max(0, options.startupTimeoutMs ?? CODEX_DESKTOP_STARTUP_TIMEOUT_MS);
    const retryIntervalMs = Math.max(0,
      options.retryIntervalMs ?? CODEX_DESKTOP_CONNECT_RETRY_INTERVAL_MS);
    let lastError: unknown = initialError;
    while (Date.now() < deadline) {
      await delay(retryIntervalMs);
      try {
        await client.connect();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    const launchHint = options.allowDesktopApplicationLaunch === true
      ? ""
      : "WeRelay 不会自动打开 ChatGPT，请先手动打开后重试。";
    throw new Error(
      `无法连接 Codex 桌面端：${describeUnknownError(lastError)}${launchHint}`,
      { cause: initialError },
    );
  }
}

type CodexDesktopRuntimeStatusCacheEntry = {
  filePath: string;
  fileSize: number;
  modifiedAtMs: number;
  scannedAtMs: number;
  runtimeStatus: BridgeResumeSessionRuntimeStatus;
};

export function shouldAttemptCodexDesktopApplicationLaunch(params: {
  allowDesktopApplicationLaunch: boolean;
  nowMs: number;
  lastLaunchAtMs: number;
  backoffUntilMs: number;
}): boolean {
  return params.allowDesktopApplicationLaunch && !shared.shouldThrottleDesktopLaunch({
    nowMs: params.nowMs,
    lastLaunchAtMs: params.lastLaunchAtMs,
    backoffUntilMs: params.backoffUntilMs,
  });
}

const CODEX_DESKTOP_RUNTIME_STATUS_SCAN_CHUNK_BYTES = 64 * 1024;
const CODEX_DESKTOP_RUNTIME_STATUS_SCAN_LIMIT_BYTES = 2 * 1024 * 1024;
const CODEX_DESKTOP_RUNTIME_STATUS_MAX_CANDIDATES = 12;
const CODEX_DESKTOP_RUNTIME_STATUS_CACHE_TTL_MS = 2_000;
const CODEX_SESSION_MESSAGE_PAGE_SCAN_CHUNK_BYTES = 64 * 1024;
const CODEX_SESSION_MESSAGE_MODEL_SCAN_LIMIT_BYTES = 8 * 1024 * 1024;
const CODEX_SESSION_MEDIA_SCAN_LIMIT_BYTES = 8 * 1024 * 1024;
const CODEX_SESSION_MESSAGE_PAGE_DEFAULT_LIMIT = 40;
const CODEX_SESSION_MESSAGE_PAGE_MAX_LIMIT = 100;
const CODEX_SESSION_RUN_SUMMARY_SCAN_LIMIT_BYTES = 64 * 1024 * 1024;
const CODEX_SESSION_PROGRESS_SCAN_LIMIT_BYTES = 8 * 1024 * 1024;
const CODEX_SESSION_POLL_INITIAL_READ_MAX_BYTES = 1024 * 1024;
const CODEX_DUPLICATE_INPUT_RECENT_WINDOW_MS = 2 * 60 * 1_000;
const CODEX_ROLLOUT_TURN_CONTEXT_MARKER = Buffer.from('"turn_context"');
const CODEX_ROLLOUT_MODEL_MARKER = Buffer.from('"model"');
const CODEX_ROLLOUT_RESPONSE_ITEM_MARKER = Buffer.from('"response_item"');
const CODEX_ROLLOUT_MESSAGE_MARKER = Buffer.from('"message"');

type CodexRolloutModelCacheEntry = {
  inode: number;
  fileSize: number;
  modifiedAtMs: number;
  modelsByTurnId: Map<string, string>;
  missingTurnIds: Set<string>;
};

const codexRolloutModelCache = new Map<string, CodexRolloutModelCacheEntry>();

const {
  CODEX_APP_SERVER_HOST,
  CODEX_APP_SERVER_READY_TIMEOUT_MS,
  CODEX_FINAL_REPLY_SETTLE_DELAY_MS,
  CODEX_RECENT_SESSION_KEY_LIMIT,
  CODEX_RPC_CONNECT_RETRY_MS,
  CODEX_RPC_RECONNECT_TIMEOUT_MS,
  CODEX_SESSION_FALLBACK_SCAN_INTERVAL_MS,
  CODEX_SESSION_LOCAL_MIRROR_FALLBACK_WINDOW_MS,
  CODEX_SESSION_POLL_INTERVAL_MS,
  CODEX_STARTUP_WARMUP_MS,
  CODEX_THREAD_SIGNAL_TTL_MS,
  INTERRUPT_SETTLE_DELAY_MS,
  appendBoundedLog,
  buildCodexApprovalRequest,
  buildCodexSessionsRoot,
  buildCodexCliArgs,
  buildCodexDynamicToolCallFailureResponse,
  buildCodexMcpServerElicitationDeclineResponse,
  buildCodexMcpServerElicitationResponse,
  buildCodexPermissionsRequestApprovalResponse,
  buildCodexUserInputRequest,
  coerceWebSocketMessageData,
  delay,
  describeUnknownError,
  extractCodexFinalTextFromItem,
  extractCodexThreadFollowIdFromStatusChanged,
  extractCodexThreadStartedThreadId,
  extractCodexUserMessageText,
  findCodexSessionFile,
  findRecentCodexSessionFileForCwd,
  getCodexRpcRequestId,
  getCodexApprovalAutoResponse,
  getCodexWechatOutboundAttachmentDenyMessage,
  getNotificationThreadId,
  getNotificationTurnId,
  isRecord,
  listCodexSessionFilesRecursively,
  isRecentIsoTimestamp,
  normalizeComparablePath,
  normalizeCodexRpcError,
  reserveLocalPort,
  resolveSpawnTarget,
  shouldAutoCompleteCodexWechatTurnAfterFinalReply,
  shouldIgnoreCodexSessionReplayEntry,
  shouldRecoverCodexStaleBusyState,
  waitForTcpPort,
} = shared;

const CODEX_LOCAL_THREAD_ANNOUNCE_SETTLE_MS = 150;

export type CodexDesktopPermissionSettings = {
  approvalPolicy: string;
  approvalsReviewer: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  sandboxPolicy: Record<string, unknown>;
};

const DEFAULT_CODEX_PERMISSION_SETTINGS: CodexDesktopPermissionSettings = {
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandbox: "workspace-write",
  sandboxPolicy: { type: "workspaceWrite" },
};

const CODEX_PERMISSION_OPTIONS: BridgeSessionPermissionState["options"] = [
  {
    id: "read-only",
    label: "只读",
    description: "默认只读取和分析；需要修改时会单独请求确认。",
  },
  {
    id: "workspace-write",
    label: "项目内读写",
    description: "可以修改当前项目；项目外操作仍需确认。",
  },
  {
    id: "danger-full-access",
    label: "完全访问",
    description: "可以访问项目外文件并执行高权限操作，不再逐项确认。",
    requiresConfirmation: true,
  },
];

function codexPermissionSettingsForMode(
  permission: string,
): CodexDesktopPermissionSettings | null {
  switch (permission) {
    case "read-only":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "read-only",
        sandboxPolicy: { type: "readOnly" },
      };
    case "workspace-write":
      return cloneCodexPermissionSettings(DEFAULT_CODEX_PERMISSION_SETTINGS);
    case "danger-full-access":
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
    default:
      return null;
  }
}

function cloneCodexPermissionSettings(
  settings: CodexDesktopPermissionSettings,
): CodexDesktopPermissionSettings {
  return {
    ...settings,
    sandboxPolicy: { ...settings.sandboxPolicy },
  };
}

function mapCodexSandboxPolicyToMode(
  sandboxPolicy: Record<string, unknown>,
): CodexDesktopPermissionSettings["sandbox"] | null {
  switch (sandboxPolicy.type) {
    case "dangerFullAccess":
    case "danger-full-access":
      return "danger-full-access";
    case "workspaceWrite":
    case "workspace-write":
      return "workspace-write";
    case "readOnly":
    case "read-only":
      return "read-only";
    default:
      return null;
  }
}

function normalizeCodexDesktopThreadPermissions(
  value: unknown,
): CodexDesktopPermissionSettings | null {
  if (!isRecord(value) || !isRecord(value.sandboxPolicy)) {
    return null;
  }

  const sandbox = mapCodexSandboxPolicyToMode(value.sandboxPolicy);
  if (!sandbox) {
    return null;
  }

  return {
    approvalPolicy:
      typeof value.approvalPolicy === "string" && value.approvalPolicy.trim()
        ? value.approvalPolicy
        : sandbox === "danger-full-access"
          ? "never"
          : "on-request",
    approvalsReviewer:
      typeof value.approvalsReviewer === "string" && value.approvalsReviewer.trim()
        ? value.approvalsReviewer
        : "user",
    sandbox,
    sandboxPolicy: { ...value.sandboxPolicy },
  };
}

function resolveCodexHostPermissionSettings(
  persistedState: Record<string, unknown>,
): CodexDesktopPermissionSettings | null {
  const hostModes = persistedState["agent-mode-by-host-id"];
  if (!isRecord(hostModes)) {
    return null;
  }

  switch (hostModes.local) {
    case "full-access":
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
    case "read-only":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "read-only",
        sandboxPolicy: { type: "readOnly" },
      };
    case "workspace-write":
    case "agent":
      return cloneCodexPermissionSettings(DEFAULT_CODEX_PERMISSION_SETTINGS);
    default:
      return null;
  }
}

export function resolveCodexDesktopPermissionSettings(
  globalState: unknown,
  threadId?: string,
): CodexDesktopPermissionSettings | null {
  if (!isRecord(globalState)) {
    return null;
  }

  const persistedState = globalState["electron-persisted-atom-state"];
  if (!isRecord(persistedState)) {
    return null;
  }

  const normalizedThreadId = threadId?.trim();
  if (normalizedThreadId) {
    const permissionsByThread = persistedState["heartbeat-thread-permissions-by-id"];
    if (isRecord(permissionsByThread)) {
      const threadSettings = normalizeCodexDesktopThreadPermissions(
        permissionsByThread[normalizedThreadId],
      );
      if (threadSettings) {
        return threadSettings;
      }
    }
  }

  return resolveCodexHostPermissionSettings(persistedState);
}

type CodexDesktopQueuedFollowUp = Record<string, unknown> & {
  id: string;
  text: string;
};

type CodexDesktopQueuedFollowUpsState = Record<string, unknown[]>;

function readCodexDesktopQueuedFollowUpsState(
  globalState: unknown,
): CodexDesktopQueuedFollowUpsState {
  if (!isRecord(globalState) || !isRecord(globalState["queued-follow-ups"])) {
    return {};
  }
  const result: CodexDesktopQueuedFollowUpsState = {};
  for (const [threadId, messages] of Object.entries(globalState["queued-follow-ups"])) {
    if (Array.isArray(messages)) {
      result[threadId] = structuredClone(messages);
    }
  }
  return result;
}

function normalizeCodexDesktopQueuedFollowUp(
  value: unknown,
): CodexDesktopQueuedFollowUp | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    typeof value.text !== "string"
  ) {
    return null;
  }
  return value as CodexDesktopQueuedFollowUp;
}

function codexDesktopQueuedFollowUpImageItems(
  value: CodexDesktopQueuedFollowUp,
): BridgeTurnInputItem[] {
  if (!isRecord(value.context) || !Array.isArray(value.context.imageAttachments)) {
    return [];
  }
  return value.context.imageAttachments.flatMap((attachment): BridgeTurnInputItem[] => {
    if (!isRecord(attachment)) {
      return [];
    }
    const localPath = typeof attachment.localPath === "string"
      ? attachment.localPath.trim()
      : "";
    if (localPath) {
      return [{ type: "localImage", path: localPath }];
    }
    const source = typeof attachment.src === "string" ? attachment.src.trim() : "";
    if (!source) {
      return [];
    }
    return /^data:image\//i.test(source)
      ? [{ type: "image", url: source }]
      : [{
          type: "localImage",
          path: source.replace(/^file:\/\//i, ""),
        }];
  });
}

export function extractCodexDesktopQueuedTaskInputs(
  globalState: unknown,
  threadId: string,
): BridgeQueuedTaskInput[] {
  const state = readCodexDesktopQueuedFollowUpsState(globalState);
  return (state[threadId] ?? []).flatMap((value): BridgeQueuedTaskInput[] => {
    const message = normalizeCodexDesktopQueuedFollowUp(value);
    if (!message) {
      return [];
    }
    const createdAtMs = typeof message.createdAt === "number" &&
        Number.isFinite(message.createdAt)
      ? message.createdAt
      : undefined;
    return [{
      id: message.id,
      text: message.text,
      imageCount: codexDesktopQueuedFollowUpImageItems(message).length,
      ...(createdAtMs !== undefined ? { createdAtMs } : {}),
    }];
  });
}

export function resolveCodexTaskOutcome(
  status: string,
): "completed" | "interrupted" | "failed" {
  const normalizedStatus = status.trim().toLowerCase();
  if (
    normalizedStatus === "interrupted" ||
    normalizedStatus === "cancelled" ||
    normalizedStatus === "canceled"
  ) {
    return "interrupted";
  }
  return normalizedStatus === "failed" || normalizedStatus === "error"
    ? "failed"
    : "completed";
}

function codexDesktopTimestampToIso(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestampMs = Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value;
    return new Date(timestampMs).toISOString();
  }

  if (typeof value === "string") {
    const timestampMs = Date.parse(value);
    if (Number.isFinite(timestampMs)) {
      return new Date(timestampMs).toISOString();
    }
  }

  return new Date(0).toISOString();
}

function extractCodexVisibleAgentMessageText(item: unknown): string | null {
  if (!isRecord(item) || item.type !== "agentMessage") {
    return null;
  }

  const phase = typeof item.phase === "string" ? item.phase : "";
  if (phase && phase !== "final_answer" && phase !== "commentary") {
    return null;
  }

  return typeof item.text === "string"
    ? sanitizeCodexVisibleAssistantMessageForDisplay(item.text)
    : null;
}

function normalizeCodexSessionMessagePageLimit(limit: number | undefined): number {
  const requested = Number.isFinite(limit)
    ? Math.floor(limit ?? CODEX_SESSION_MESSAGE_PAGE_DEFAULT_LIMIT)
    : CODEX_SESSION_MESSAGE_PAGE_DEFAULT_LIMIT;
  return Math.min(
    CODEX_SESSION_MESSAGE_PAGE_MAX_LIMIT,
    Math.max(1, requested),
  );
}

function encodeCodexSessionMessageByteCursor(offset: number): string {
  return `byte:${Math.max(0, Math.floor(offset))}`;
}

function decodeCodexSessionMessageByteCursor(cursor: string): number | null {
  const match = /^byte:(\d+)$/.exec(cursor.trim());
  if (!match?.[1]) {
    return null;
  }
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) ? offset : null;
}

function normalizeCodexModelName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractCodexTurnModel(value: Record<string, unknown>): string | undefined {
  return normalizeCodexModelName(value.model) ??
    normalizeCodexModelName(value.modelId) ??
    normalizeCodexModelName(value.model_id);
}

function extractCodexDesktopSessionModel(state: unknown): string | undefined {
  if (!isRecord(state)) return undefined;
  const settings = isRecord(state.latestThreadSettings)
    ? state.latestThreadSettings
    : null;
  return normalizeCodexModelName(settings?.model) ??
    normalizeCodexModelName(state.latestModel) ??
    normalizeCodexModelName(state.previousTurnModel);
}

function extractCodexDesktopSessionReasoningEffort(state: unknown): string | undefined {
  if (!isRecord(state)) return undefined;
  const settings = isRecord(state.latestThreadSettings)
    ? state.latestThreadSettings
    : null;
  return normalizeCodexModelName(settings?.effort) ??
    normalizeCodexModelName(state.latestReasoningEffort);
}

function mapCodexReasoningEffortOptions(
  value: unknown,
): NonNullable<BridgeSessionModelOption["reasoningEffortOptions"]> {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const id = normalizeCodexModelName(candidate.reasoningEffort) ??
      normalizeCodexModelName(candidate.id);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const description = normalizeCodexModelName(candidate.description);
    return [{ id, ...(description ? { description } : {}) }];
  });
}

function mapCodexModelListResponse(value: unknown): BridgeSessionModelOption[] {
  if (!isRecord(value) || !Array.isArray(value.data)) return [];
  const seen = new Set<string>();
  const options: BridgeSessionModelOption[] = [];
  for (const candidate of value.data) {
    if (!isRecord(candidate) || candidate.hidden === true) continue;
    const id = normalizeCodexModelName(candidate.model) ??
      normalizeCodexModelName(candidate.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = normalizeCodexModelName(candidate.displayName);
    const description = normalizeCodexModelName(candidate.description);
    const defaultReasoningEffort = normalizeCodexModelName(candidate.defaultReasoningEffort);
    const reasoningEffortOptions = mapCodexReasoningEffortOptions(
      candidate.supportedReasoningEfforts,
    );
    options.push({
      id,
      ...(label ? { label } : {}),
      ...(description ? { description } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      ...(reasoningEffortOptions.length > 0 ? { reasoningEffortOptions } : {}),
    });
  }
  return options;
}

function extractCodexRolloutTurnModel(
  line: Buffer,
): { turnId: string; model: string } | null {
  if (line.length === 0) return null;
  if (
    !line.includes(CODEX_ROLLOUT_TURN_CONTEXT_MARKER) ||
    !line.includes(CODEX_ROLLOUT_MODEL_MARKER)
  ) {
    return null;
  }
  const raw = line.toString("utf8").trim();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.type !== "turn_context" || !isRecord(parsed.payload)) {
      return null;
    }
    const turnId = normalizeCodexModelName(parsed.payload.turn_id);
    const model = extractCodexTurnModel(parsed.payload);
    return turnId && model ? { turnId, model } : null;
  } catch {
    return null;
  }
}

function codexRolloutModelCacheEntry(
  filePath: string,
  stats: fs.Stats,
): CodexRolloutModelCacheEntry {
  const cached = codexRolloutModelCache.get(filePath);
  if (
    cached &&
    cached.inode === stats.ino &&
    (stats.size > cached.fileSize ||
      (stats.size === cached.fileSize && stats.mtimeMs === cached.modifiedAtMs))
  ) {
    cached.fileSize = stats.size;
    cached.modifiedAtMs = stats.mtimeMs;
    return cached;
  }
  const created: CodexRolloutModelCacheEntry = {
    inode: stats.ino,
    fileSize: stats.size,
    modifiedAtMs: stats.mtimeMs,
    modelsByTurnId: new Map(),
    missingTurnIds: new Set(),
  };
  codexRolloutModelCache.set(filePath, created);
  if (codexRolloutModelCache.size > 256) {
    const oldest = codexRolloutModelCache.keys().next().value;
    if (typeof oldest === "string") codexRolloutModelCache.delete(oldest);
  }
  return created;
}

type CodexRolloutMessagePageOptions = BridgeSessionMessagePageOptions & {
  imageCacheDir?: string;
};

const CODEX_INPUT_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

function materializeCodexInputImage(
  imageUrl: string,
  imageCacheDir: string | undefined,
  alt: string,
): BridgeMessageImage | null {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(
    imageUrl.trim(),
  );
  if (!match?.[1] || !match[2] || !imageCacheDir) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > CODEX_INPUT_IMAGE_MAX_BYTES) return null;

  const mimeType = match[1].toLowerCase();
  const valid = mimeType === "image/png"
    ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mimeType === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mimeType === "image/gif"
        ? bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
        : bytes.length >= 12 &&
          bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
          bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!valid) return null;

  const extension = mimeType === "image/png"
    ? ".png"
    : mimeType === "image/jpeg"
      ? ".jpg"
      : mimeType === "image/gif"
        ? ".gif"
        : ".webp";
  const imagePath = path.join(
    imageCacheDir,
    `${crypto.createHash("sha256").update(bytes).digest("hex")}${extension}`,
  );
  try {
    ensurePrivateDir(imageCacheDir);
    if (!fs.existsSync(imagePath)) {
      writePrivateFileAtomic(imagePath, bytes);
    }
    fs.chmodSync(imagePath, 0o600);
    return { source: "local", path: imagePath, alt };
  } catch {
    return null;
  }
}

function extractCodexCompletedTurnEvidence(
  line: Buffer,
): { turnId: string; finalText?: string } | null {
  try {
    const parsed = JSON.parse(line.toString("utf8")) as unknown;
    if (!isRecord(parsed) || parsed.type !== "event_msg" || !isRecord(parsed.payload)) {
      return null;
    }
    if (
      parsed.payload.type !== "task_complete" ||
      typeof parsed.payload.turn_id !== "string" ||
      !parsed.payload.turn_id.trim()
    ) {
      return null;
    }
    const finalText = typeof parsed.payload.last_agent_message === "string"
      ? sanitizeCodexVisibleAssistantMessageForDisplay(
        parsed.payload.last_agent_message,
      ) ?? undefined
      : undefined;
    return {
      turnId: parsed.payload.turn_id.trim(),
      ...(finalText ? { finalText } : {}),
    };
  } catch {
    return null;
  }
}

function extractCodexRolloutVisibleMessage(
  line: Buffer,
  imageCacheDir?: string,
): BridgeSessionMessage | null {
  if (line.length === 0) {
    return null;
  }
  if (
    !line.includes(CODEX_ROLLOUT_RESPONSE_ITEM_MARKER) ||
    !line.includes(CODEX_ROLLOUT_MESSAGE_MARKER)
  ) {
    return null;
  }
  const raw = line.toString("utf8").trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.type !== "response_item") {
      return null;
    }
    const payload = parsed.payload;
    if (!isRecord(payload) || payload.type !== "message") {
      return null;
    }
    const role = payload.role;
    if (role !== "user" && role !== "assistant") {
      return null;
    }
    if (!Array.isArray(payload.content)) {
      return null;
    }

    const images: BridgeMessageImage[] = [];
    const textParts = payload.content.map((entry) => {
      if (!isRecord(entry) || typeof entry.type !== "string") {
        return "";
      }
      if (
        (entry.type === "input_text" || entry.type === "output_text") &&
        typeof entry.text === "string"
      ) {
        return entry.text;
      }
      if (role === "user" && entry.type === "input_image") {
        if (typeof entry.image_url === "string") {
          const image = materializeCodexInputImage(
            entry.image_url,
            imageCacheDir,
            `输入图片 ${images.length + 1}`,
          );
          if (image) images.push(image);
        }
        return "[image]";
      }
      return "";
    }).filter(Boolean);
    const rawText = normalizeOutput(textParts.join("\n")).trim();
    const text = role === "user"
      ? sanitizeCodexVisibleUserMessageForDisplay(rawText)
      : sanitizeCodexVisibleAssistantMessageForDisplay(rawText);
    if (!text) {
      return null;
    }

    const phase = role === "assistant" &&
        (payload.phase === "commentary" || payload.phase === "final_answer")
      ? payload.phase
      : undefined;
    const id = typeof payload.id === "string" && payload.id.trim()
      ? payload.id.trim()
      : undefined;
    const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : null;
    const turnId = metadata && typeof metadata.turn_id === "string" &&
        metadata.turn_id.trim()
      ? metadata.turn_id.trim()
      : undefined;
    const createdAtMs = typeof parsed.timestamp === "string"
      ? Date.parse(parsed.timestamp)
      : Number.NaN;
    return {
      role,
      text,
      ...(id ? { id } : {}),
      ...(turnId ? { turnId } : {}),
      ...(phase ? { phase } : {}),
      ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
      ...(images.length ? { images } : {}),
    };
  } catch {
    return null;
  }
}

export function readCodexSessionMessagePageFromRollout(
  filePath: string,
  options: CodexRolloutMessagePageOptions = {},
): BridgeSessionMessagePage | null {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return null;
  }
  const limit = normalizeCodexSessionMessagePageLimit(options.limit);
  const requestedEnd = typeof options.before === "string"
    ? decodeCodexSessionMessageByteCursor(options.before)
    : stats.size;
  if (
    requestedEnd === null ||
    requestedEnd < 0 ||
    requestedEnd > stats.size
  ) {
    return null;
  }

  let fileDescriptor: number;
  try {
    fileDescriptor = fs.openSync(filePath, "r");
  } catch {
    return null;
  }

  const found: Array<{ message: BridgeSessionMessage; lineStart: number }> = [];
  const completedTurnFinalTextById = new Map<string, string>();
  const modelCache = options.lightweight === true
    ? null
    : codexRolloutModelCacheEntry(filePath, stats);
  try {
    let endOffset = requestedEnd;
    let rightFragment = Buffer.alloc(0);

    while (endOffset > 0) {
      const startOffset = Math.max(
        0,
        endOffset - CODEX_SESSION_MESSAGE_PAGE_SCAN_CHUNK_BYTES,
      );
      const buffer = Buffer.alloc(endOffset - startOffset);
      const bytesRead = fs.readSync(
        fileDescriptor,
        buffer,
        0,
        buffer.length,
        startOffset,
      );
      if (bytesRead !== buffer.length) {
        return null;
      }
      const chunk = buffer.subarray(0, bytesRead);
      const data = rightFragment.length > 0
        ? Buffer.concat([chunk, rightFragment])
        : chunk;
      const newlineOffsets: number[] = [];
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] === 0x0a) {
          newlineOffsets.push(index);
        }
      }
      const segmentStarts = [
        0,
        ...newlineOffsets.map((offset) => offset + 1),
      ];
      const segmentEnds = [...newlineOffsets, data.length];
      const firstCompleteSegment = startOffset > 0 ? 1 : 0;

      for (
        let segmentIndex = segmentStarts.length - 1;
        segmentIndex >= firstCompleteSegment;
        segmentIndex -= 1
      ) {
        const segmentStart = segmentStarts[segmentIndex] ?? 0;
        const segmentEnd = segmentEnds[segmentIndex] ?? segmentStart;
        if (segmentEnd <= segmentStart) {
          continue;
        }
        const line = data.subarray(segmentStart, segmentEnd);
        const completedTurn = extractCodexCompletedTurnEvidence(line);
        if (completedTurn?.finalText) {
          completedTurnFinalTextById.set(
            completedTurn.turnId,
            completedTurn.finalText,
          );
        }
        const turnModel = modelCache ? extractCodexRolloutTurnModel(line) : null;
        if (turnModel && modelCache && !modelCache.modelsByTurnId.has(turnModel.turnId)) {
          modelCache.modelsByTurnId.set(turnModel.turnId, turnModel.model);
          modelCache.missingTurnIds.delete(turnModel.turnId);
        }
        if (found.length > limit) continue;
        const extractedMessage = extractCodexRolloutVisibleMessage(
          line,
          options.imageCacheDir,
        );
        if (!extractedMessage) {
          continue;
        }
        const message = extractedMessage.role === "assistant" &&
            !extractedMessage.phase &&
            extractedMessage.turnId &&
            completedTurnFinalTextById.get(extractedMessage.turnId) ===
              extractedMessage.text
          ? { ...extractedMessage, phase: "final_answer" as const }
          : extractedMessage;
        found.push({
          message,
          lineStart: startOffset + segmentStart,
        });
      }

      if (startOffset > 0) {
        const firstNewline = newlineOffsets[0];
        rightFragment = firstNewline === undefined
          ? data
          : data.subarray(0, firstNewline);
      } else {
        rightFragment = Buffer.alloc(0);
      }
      endOffset = startOffset;

      if (found.length > limit) {
        if (!modelCache) {
          break;
        }
        const requiredTurnIds = new Set(
          found.slice(0, limit)
            .map((entry) => entry.message)
            .filter((message) => message.role === "assistant" && message.turnId)
            .map((message) => message.turnId!),
        );
        const unresolvedTurnIds = [...requiredTurnIds].filter((turnId) =>
          !modelCache.modelsByTurnId.has(turnId) &&
          !modelCache.missingTurnIds.has(turnId)
        );
        if (
          unresolvedTurnIds.length === 0 ||
          requestedEnd - startOffset >= CODEX_SESSION_MESSAGE_MODEL_SCAN_LIMIT_BYTES ||
          startOffset === 0
        ) {
          for (const turnId of unresolvedTurnIds) {
            modelCache.missingTurnIds.add(turnId);
          }
          break;
        }
      }
    }
  } catch {
    return null;
  } finally {
    fs.closeSync(fileDescriptor);
  }

  const pageEntries = found.slice(0, limit);
  const hasMore = found.length > limit;
  const oldestIncluded = pageEntries[pageEntries.length - 1];
  return {
    messages: [...pageEntries].reverse().map((entry) => {
      const message = entry.message;
      const model = modelCache && message.role === "assistant" && message.turnId
        ? modelCache.modelsByTurnId.get(message.turnId)
        : undefined;
      return model ? { ...message, model } : message;
    }),
    hasMore,
    nextBefore: hasMore && oldestIncluded
      ? encodeCodexSessionMessageByteCursor(
          oldestIncluded.lineStart,
        )
      : null,
  };
}

function normalizeCodexMediaTargetText(text: string): string {
  return text
    .replace(/<\/?image\b[^>]*>/gi, "")
    .replace(/\[local image:\s*[^\]]+\]/gi, "")
    .replace(/^\s*\[image\]\s*$/gim, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function paginateCodexSessionMessages(
  messages: BridgeSessionMessage[],
  options: BridgeSessionMessagePageOptions,
): BridgeSessionMessagePage {
  const limit = normalizeCodexSessionMessagePageLimit(options.limit);
  const match = typeof options.before === "string"
    ? /^index:(\d+)$/.exec(options.before.trim())
    : null;
  const requestedEnd = match?.[1] ? Number(match[1]) : messages.length;
  const end = Math.min(messages.length, Math.max(0, requestedEnd));
  const start = Math.max(0, end - limit);
  return {
    messages: messages.slice(start, end),
    hasMore: start > 0,
    nextBefore: start > 0 ? `index:${start}` : null,
  };
}

export function extractLatestCodexThreadMessage(
  response: unknown,
): BridgeSessionMessage | null {
  const messages = extractCodexThreadMessages(response);
  const latest = messages[messages.length - 1];
  return latest ? { role: latest.role, text: latest.text } : null;
}

export function extractCodexThreadMessages(
  response: unknown,
): BridgeSessionMessage[] {
  if (!isRecord(response) || !isRecord(response.thread)) {
    return [];
  }

  const messages: BridgeSessionMessage[] = [];
  const turns = Array.isArray(response.thread.turns) ? response.thread.turns : [];
  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const turn = turns[turnIndex];
    if (!isRecord(turn) || !Array.isArray(turn.items)) {
      continue;
    }
    const turnId = typeof turn.id === "string" ? turn.id : undefined;
    const model = extractCodexTurnModel(turn);

    for (let itemIndex = 0; itemIndex < turn.items.length; itemIndex += 1) {
      const item = turn.items[itemIndex];
      const itemId = isRecord(item) && typeof item.id === "string"
        ? item.id
        : undefined;
      const assistantText = extractCodexVisibleAgentMessageText(item);
      if (assistantText) {
        const phase = isRecord(item) &&
            (item.phase === "commentary" || item.phase === "final_answer")
          ? item.phase
          : undefined;
        messages.push({
          role: "assistant",
          text: assistantText,
          ...(itemId ? { id: itemId } : {}),
          ...(turnId ? { turnId } : {}),
          ...(phase ? { phase } : {}),
          ...(model ? { model } : {}),
        });
        continue;
      }

      const userText = extractCodexUserMessageText(item);
      const visibleUserText = userText
        ? sanitizeCodexVisibleUserMessageForDisplay(userText)
        : null;
      if (visibleUserText) {
        messages.push({
          role: "user",
          text: visibleUserText,
          ...(itemId ? { id: itemId } : {}),
          ...(turnId ? { turnId } : {}),
        });
      }
    }
  }

  return messages;
}

function codexTimestampToMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.abs(value) < 1_000_000_000_000 ? value * 1_000 : value;
}

function codexDurationToMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function formatCodexRunErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.message !== "string") {
    return undefined;
  }
  const message = normalizeOutput(value.message).trim();
  if (!message) return undefined;
  const model = message.match(/\bmodel:\s*([^;,\s]+)/i)?.[1];
  if (/auth_unavailable|no auth available/i.test(message)) {
    return model
      ? `当前模型 ${model} 暂时没有可用账号，未生成回复。请在 CC Switch 中恢复该模型账号，或切换模型后重试。`
      : "当前模型暂时没有可用账号，未生成回复。请在 CC Switch 中恢复账号，或切换模型后重试。";
  }
  if (/\b503\b|service unavailable|upstream_status:\s*HTTP 503/i.test(message)) {
    return "模型服务暂时不可用，未生成回复。请稍后重试。";
  }
  if (/server_overloaded|selected model is at capacity|model is at capacity/i.test(message)) {
    return "当前模型暂时繁忙，未生成回复。请稍后重试，或切换模型后再试。";
  }
  return `Codex 未能完成请求：${truncatePreview(message, 220)}`;
}

function normalizeCodexRunStatus(
  value: unknown,
  completedAtMs?: number,
): BridgeSessionRunSummary["status"] {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (
    status === "running" ||
    status === "active" ||
    status === "inprogress" ||
    status === "in_progress" ||
    status === "started"
  ) {
    return "running";
  }
  if (status === "interrupted" || status === "cancelled" || status === "canceled") {
    return "interrupted";
  }
  if (status === "failed" || status === "error") {
    return "failed";
  }
  if (status === "completed" || status === "complete" || completedAtMs !== undefined) {
    return "completed";
  }
  return "unknown";
}

function isCodexDesktopTurnActiveStatus(value: unknown): boolean {
  const normalized = typeof value === "string"
    ? value.replace(/[_-]/g, "").trim().toLowerCase()
    : "";
  return normalized === "inprogress" || normalized === "active" || normalized === "running";
}

function codexDesktopTurnEntries(
  state: unknown,
): Array<[string, Record<string, unknown>]> {
  if (
    !isRecord(state) ||
    !isRecord(state.turnHistory) ||
    !isRecord(state.turnHistory.history) ||
    !isRecord(state.turnHistory.history.entitiesByKey)
  ) {
    return [];
  }
  return Object.entries(state.turnHistory.history.entitiesByKey)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]));
}

function codexDesktopRuntimeType(state: unknown): string | undefined {
  return isRecord(state) &&
      isRecord(state.threadRuntimeStatus) &&
      typeof state.threadRuntimeStatus.type === "string"
    ? state.threadRuntimeStatus.type
    : undefined;
}

function codexDesktopLiveTurnEntries(
  state: unknown,
  preferredTurnId?: string,
): Array<[string, Record<string, unknown>]> {
  const entries = codexDesktopTurnEntries(state);
  const normalizedPreferredTurnId = preferredTurnId?.trim();
  if (normalizedPreferredTurnId) {
    return entries.filter(([, entity]) =>
      entity.turnId === normalizedPreferredTurnId
    );
  }
  const tailEntries = entries.filter(([key]) => key.startsWith("tail:"));
  if (tailEntries.length > 0) {
    const runtimeType = codexDesktopRuntimeType(state);
    const preferredTail = runtimeType === "active"
      ? [...tailEntries].reverse().find(([, entity]) =>
        isCodexDesktopTurnActiveStatus(entity.status)
      )
      : [...tailEntries].reverse().find(([, entity]) => Array.isArray(entity.items));
    if (!preferredTail) {
      return [];
    }
    const preferredTailTurnId = typeof preferredTail[1].turnId === "string"
      ? preferredTail[1].turnId
      : undefined;
    return preferredTailTurnId
      ? tailEntries.filter(([, entity]) => entity.turnId === preferredTailTurnId)
      : [preferredTail];
  }
  if (codexDesktopRuntimeType(state) === "idle") {
    return [];
  }
  const latestActive = [...entries].reverse().find(([, entity]) =>
    isCodexDesktopTurnActiveStatus(entity.status)
  );
  return latestActive ? [latestActive] : [];
}

export function extractCodexThreadRunSummary(
  response: unknown,
  nowMs = Date.now(),
): BridgeSessionRunSummary | null {
  if (!isRecord(response) || !isRecord(response.thread)) {
    return null;
  }
  const turns = Array.isArray(response.thread.turns) ? response.thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!isRecord(turn)) {
      continue;
    }
    const turnId = typeof turn.id === "string" && turn.id.trim()
      ? turn.id.trim()
      : undefined;
    const startedAtMs = codexTimestampToMs(turn.startedAt);
    const completedAtMs = codexTimestampToMs(turn.completedAt);
    const status = normalizeCodexRunStatus(turn.status, completedAtMs);
    let durationMs = codexDurationToMs(turn.durationMs);
    if (durationMs === undefined && startedAtMs !== undefined) {
      if (completedAtMs !== undefined) {
        durationMs = Math.max(0, completedAtMs - startedAtMs);
      } else if (status === "running") {
        durationMs = Math.max(0, nowMs - startedAtMs);
      }
    }
    if (
      !turnId &&
      startedAtMs === undefined &&
      completedAtMs === undefined &&
      durationMs === undefined &&
      status === "unknown"
    ) {
      continue;
    }
    return {
      ...(turnId ? { turnId } : {}),
      status,
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(completedAtMs !== undefined ? { completedAtMs } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
  return null;
}

export function extractCodexDesktopThreadRunSummary(
  state: unknown,
  persisted: BridgeSessionRunSummary | null,
  nowMs = Date.now(),
  observedStartedAtMs?: number,
): BridgeSessionRunSummary | null {
  const entries = codexDesktopLiveTurnEntries(state);
  const activeEntries = entries.filter(([, entity]) =>
    isCodexDesktopTurnActiveStatus(entity.status)
  );
  const runtimeType = codexDesktopRuntimeType(state);
  const latestTail = [...entries].reverse().find(([key, entity]) =>
    key.startsWith("tail:") && typeof entity.turnId === "string"
  );

  if (runtimeType !== "active" && runtimeType !== "idle") {
    return persisted;
  }

  const preferred = runtimeType === "active"
    ? [...activeEntries].reverse().find(([key]) => key.startsWith("tail:")) ??
      latestTail ??
      activeEntries[activeEntries.length - 1]
    : latestTail ?? activeEntries[activeEntries.length - 1];
  const entity = preferred?.[1];
  if (!entity) {
    return runtimeType === "idle" && persisted?.status === "running"
      ? { ...persisted, status: "unknown", durationMs: persisted.durationMs ?? 0 }
      : persisted;
  }
  const turnId = typeof entity.turnId === "string" && entity.turnId.trim()
    ? entity.turnId.trim()
    : undefined;
  const startedAtMs = codexTimestampToMs(entity.startedAt) ??
    (turnId && persisted?.turnId === turnId ? persisted.startedAtMs : undefined) ??
    observedStartedAtMs;
  if (runtimeType === "idle") {
    const entityCompletedAtMs = codexTimestampToMs(entity.completedAt);
    const completedAtMs = entityCompletedAtMs ??
      (isRecord(state) ? codexTimestampToMs(state.updatedAt) : undefined) ??
      (turnId && persisted?.turnId === turnId ? persisted.completedAtMs : undefined);
    const entityStatus = normalizeCodexRunStatus(entity.status, entityCompletedAtMs);
    const hasFinalAnswer = Array.isArray(entity.items) && entity.items.some((item) =>
      isRecord(item) &&
      item.type === "agentMessage" &&
      item.phase === "final_answer" &&
      typeof item.text === "string" &&
      Boolean(item.text.trim())
    );
    const persistedTerminalStatus = turnId && persisted?.turnId === turnId &&
        persisted.status !== "running" && persisted.status !== "unknown"
      ? persisted.status
      : undefined;
    const status = persistedTerminalStatus === "failed" || persistedTerminalStatus === "interrupted"
      ? persistedTerminalStatus
      : entityStatus !== "running" && entityStatus !== "unknown"
        ? entityStatus
      : hasFinalAnswer
        ? "completed"
        : persistedTerminalStatus ?? "unknown";
    const entityDurationMs = codexDurationToMs(entity.durationMs);
    const persistedDurationMs = turnId && persisted?.turnId === turnId &&
        persisted.status !== "running"
      ? persisted.durationMs
      : undefined;
    const durationMs = entityDurationMs ?? persistedDurationMs ??
      (startedAtMs !== undefined && completedAtMs !== undefined
        ? Math.max(0, completedAtMs - startedAtMs)
        : 0);
    return {
      ...(turnId ? { turnId } : {}),
      status,
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(completedAtMs !== undefined && status !== "unknown" ? { completedAtMs } : {}),
      durationMs,
      ...(turnId && persisted?.turnId === turnId && persisted.errorMessage
        ? { errorMessage: persisted.errorMessage }
        : {}),
    };
  }
  return {
    ...(turnId ? { turnId } : {}),
    status: "running",
    ...(startedAtMs !== undefined ? { startedAtMs } : {}),
    durationMs: startedAtMs !== undefined ? Math.max(0, nowMs - startedAtMs) : 0,
  };
}

export function extractCodexDesktopThreadMessages(
  state: unknown,
  preferredTurnId?: string,
): BridgeSessionMessage[] {
  const messages: BridgeSessionMessage[] = [];
  for (const [, entity] of codexDesktopLiveTurnEntries(state, preferredTurnId)) {
    if (!Array.isArray(entity.items)) {
      continue;
    }
    const turnId = typeof entity.turnId === "string" ? entity.turnId : undefined;
    const model = extractCodexTurnModel(entity);
    for (const item of entity.items) {
      const itemId = isRecord(item) && typeof item.id === "string"
        ? item.id
        : undefined;
      const assistantText = extractCodexVisibleAgentMessageText(item);
      if (assistantText) {
        const phase = isRecord(item) &&
            (item.phase === "commentary" || item.phase === "final_answer")
          ? item.phase
          : undefined;
        messages.push({
          role: "assistant",
          text: assistantText,
          ...(itemId ? { id: itemId } : {}),
          ...(turnId ? { turnId } : {}),
          ...(phase ? { phase } : {}),
          ...(model ? { model } : {}),
        });
        continue;
      }

      const userText = extractCodexUserMessageText(item);
      const visibleUserText = userText
        ? sanitizeCodexVisibleUserMessageForDisplay(userText)
        : null;
      if (visibleUserText) {
        messages.push({
          role: "user",
          text: visibleUserText,
          ...(itemId ? { id: itemId } : {}),
          ...(turnId ? { turnId } : {}),
        });
      }
    }
  }
  return messages;
}


const CODEX_SESSION_PROGRESS_ACTIVITY_LIMIT = 10;

function compactCodexProgressItems(
  items: BridgeSessionProgressItem[],
): BridgeSessionProgressItem[] {
  const latestIndexBySemanticKey = new Map<string, number>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const normalizedText = normalizeOutput(item.text).trim().replace(/\s+/g, " ");
    const key = `${item.turnId ?? ""}\0${item.kind}\0${normalizedText}`;
    latestIndexBySemanticKey.set(key, index);
  }
  return items.filter((item, index) => {
    const normalizedText = normalizeOutput(item.text).trim().replace(/\s+/g, " ");
    const key = `${item.turnId ?? ""}\0${item.kind}\0${normalizedText}`;
    return latestIndexBySemanticKey.get(key) === index;
  });
}

function normalizeCodexProgressStatus(
  value: unknown,
): BridgeSessionProgressItem["status"] {
  const normalized = typeof value === "string"
    ? value.replace(/[_-]/g, "").trim().toLowerCase()
    : "";
  if (normalized === "inprogress" || normalized === "running" || normalized === "active") {
    return "running";
  }
  if (normalized === "failed" || normalized === "error" || normalized === "aborted") {
    return "failed";
  }
  return "completed";
}

function normalizeCodexPlanStepStatus(
  value: unknown,
): "pending" | BridgeSessionProgressItem["status"] {
  const normalized = typeof value === "string"
    ? value.replace(/[_-]/g, "").trim().toLowerCase()
    : "";
  if (normalized === "inprogress" || normalized === "running" || normalized === "active") {
    return "running";
  }
  if (normalized === "completed" || normalized === "complete" || normalized === "done") {
    return "completed";
  }
  if (normalized === "failed" || normalized === "error" || normalized === "aborted") {
    return "failed";
  }
  return "pending";
}

function codexProgressItemId(
  item: Record<string, unknown>,
  turnId: string | undefined,
  itemIndex: number,
): string {
  return typeof item.id === "string" && item.id.trim()
    ? item.id.trim()
    : `${turnId ?? "turn"}:progress:${itemIndex}`;
}

function cleanCodexReasoningSummary(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = normalizeOutput(value)
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*(.+)\*\*$/s, "$1")
    .replace(/^__(.+)__$/s, "$1")
    .trim();
  if (!text) {
    return null;
  }
  if (/\p{Script=Han}/u.test(text)) {
    return truncatePreview(text, 220);
  }
  const lower = text.toLowerCase();
  if (/\b(test|tests|testing|verify|verification|validat)/.test(lower)) {
    return "运行并检查测试";
  }
  if (/\b(performance|latency|speed|benchmark|measur)/.test(lower)) {
    return "测量读取性能";
  }
  if (/\b(debug|investigat|root cause|diagnos)/.test(lower)) {
    return "定位问题原因";
  }
  if (/\b(implement|edit|patch|updat|refactor|fix)/.test(lower)) {
    return "实现并调整代码";
  }
  if (/\b(plan|design|architect)/.test(lower)) {
    return "规划下一步处理";
  }
  if (/\b(inspect|check|review|read|analy|explor|resolv)/.test(lower)) {
    return "检查实现与运行状态";
  }
  return "继续分析任务";
}

function summarizeCodexPlanProgress(
  item: Record<string, unknown>,
  turnId: string | undefined,
  itemIndex: number,
): BridgeSessionProgressItem | null {
  if (!Array.isArray(item.plan) || item.plan.length === 0) {
    return null;
  }
  const steps = item.plan.filter((step): step is Record<string, unknown> => isRecord(step));
  if (steps.length === 0) {
    return null;
  }
  const statuses = steps.map((step) => normalizeCodexPlanStepStatus(step.status));
  const runningIndex = statuses.indexOf("running");
  const failedIndex = statuses.indexOf("failed");
  const pendingIndex = statuses.indexOf("pending");
  const currentIndex = runningIndex >= 0
    ? runningIndex
    : failedIndex >= 0
      ? failedIndex
      : pendingIndex >= 0
        ? pendingIndex
        : steps.length - 1;
  const current = steps[currentIndex];
  const stepText = current && typeof current.step === "string"
    ? normalizeOutput(current.step).trim()
    : "继续处理任务";
  const status = runningIndex >= 0 || pendingIndex >= 0
    ? "running"
    : failedIndex >= 0
      ? "failed"
      : "completed";
  return {
    id: codexProgressItemId(item, turnId, itemIndex),
    ...(turnId ? { turnId } : {}),
    kind: "plan",
    status,
    text: `第 ${currentIndex + 1} / ${steps.length} 步 · ${truncatePreview(stepText, 120)}`,
  };
}

function codexCommandActionPhrases(item: Record<string, unknown>): string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  for (const action of actions) {
    const type = isRecord(action) && typeof action.type === "string"
      ? action.type.trim().toLowerCase()
      : "unknown";
    const phrase = type === "read"
      ? "读取文件"
      : type === "search"
        ? "搜索内容"
        : type === "listfiles"
          ? "查看文件"
          : "运行命令";
    if (!seen.has(phrase)) {
      seen.add(phrase);
      phrases.push(phrase);
    }
  }
  return phrases.length > 0 ? phrases : ["运行命令"];
}

function progressActionText(
  phrases: string[],
  status: BridgeSessionProgressItem["status"],
): string {
  const action = phrases.join("并");
  if (status === "running") {
    return `正在${action}`;
  }
  if (status === "failed") {
    return `${action}失败`;
  }
  return `已${action}`;
}

function summarizeCodexMcpTool(item: Record<string, unknown>): string {
  const server = typeof item.server === "string" ? item.server.trim().toLowerCase() : "";
  const tool = typeof item.tool === "string" ? item.tool.trim().toLowerCase() : "";
  if (tool.includes("image") || tool.includes("view_image")) {
    return "查看图像";
  }
  if (server.includes("browser") || tool.includes("browser") || server === "node_repl") {
    return "检查页面与应用状态";
  }
  if (tool.includes("search")) {
    return "搜索信息";
  }
  if (tool.includes("exec") || tool.includes("command")) {
    return "运行命令";
  }
  return "调用工具";
}

function summarizeCodexProgressItem(
  item: Record<string, unknown>,
  turnId: string | undefined,
  itemIndex: number,
): BridgeSessionProgressItem | null {
  const id = codexProgressItemId(item, turnId, itemIndex);
  const base = { id, ...(turnId ? { turnId } : {}) };
  if (item.type === "reasoning") {
    const summaries = Array.isArray(item.summary) ? item.summary : [];
    const text = [...summaries].reverse().map(cleanCodexReasoningSummary).find(Boolean);
    return text
      ? { ...base, kind: "reasoning", status: "completed", text }
      : null;
  }
  if (item.type === "commandExecution") {
    const status = normalizeCodexProgressStatus(item.status);
    return {
      ...base,
      kind: "command",
      status,
      text: progressActionText(codexCommandActionPhrases(item), status),
    };
  }
  if (item.type === "fileChange") {
    const status = normalizeCodexProgressStatus(item.status);
    const count = Array.isArray(item.changes) ? item.changes.length : 0;
    const action = count > 0 ? `修改 ${count} 个文件` : "修改文件";
    return { ...base, kind: "file", status, text: progressActionText([action], status) };
  }
  if (item.type === "webSearch") {
    const status = normalizeCodexProgressStatus(item.status);
    return { ...base, kind: "web", status, text: progressActionText(["搜索网页"], status) };
  }
  if (item.type === "mcpToolCall") {
    const status = normalizeCodexProgressStatus(item.status);
    return {
      ...base,
      kind: "tool",
      status,
      text: progressActionText([summarizeCodexMcpTool(item)], status),
    };
  }
  if (item.type === "imageGeneration") {
    const status = normalizeCodexProgressStatus(item.status);
    return { ...base, kind: "image", status, text: progressActionText(["生成图像"], status) };
  }
  if (
    item.type === "collabAgentToolCall" ||
    item.type === "subAgentActivity" ||
    item.type === "dynamicToolCall"
  ) {
    const status = normalizeCodexProgressStatus(item.status);
    return { ...base, kind: "tool", status, text: progressActionText(["处理子任务"], status) };
  }
  if (item.type === "contextCompaction") {
    const status = normalizeCodexProgressStatus(item.status);
    return { ...base, kind: "tool", status, text: progressActionText(["整理上下文"], status) };
  }
  return null;
}

function extractCodexProgressFromTurn(
  turn: Record<string, unknown>,
): BridgeSessionProgressItem[] {
  if (!Array.isArray(turn.items)) {
    return [];
  }
  const turnId = typeof turn.turnId === "string" && turn.turnId.trim()
    ? turn.turnId.trim()
    : typeof turn.id === "string" && turn.id.trim()
      ? turn.id.trim()
      : undefined;
  const activity: BridgeSessionProgressItem[] = [];
  let latestPlan: BridgeSessionProgressItem | null = null;
  for (let index = 0; index < turn.items.length; index += 1) {
    const item = turn.items[index];
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === "todo-list") {
      latestPlan = summarizeCodexPlanProgress(item, turnId, index) ?? latestPlan;
      continue;
    }
    if (item.type === "imageView") {
      const ids: string[] = [];
      let count = 0;
      let cursor = index;
      while (cursor < turn.items.length) {
        const image = turn.items[cursor];
        if (!isRecord(image) || image.type !== "imageView") {
          break;
        }
        ids.push(codexProgressItemId(image, turnId, cursor));
        count += 1;
        cursor += 1;
      }
      activity.push({
        id: ids.join(":"),
        ...(turnId ? { turnId } : {}),
        kind: "image",
        status: "completed",
        text: `已查看 ${count} 张图像`,
      });
      index = cursor - 1;
      continue;
    }
    const progress = summarizeCodexProgressItem(item, turnId, index);
    if (progress) {
      activity.push(progress);
    }
  }
  return [
    ...(latestPlan ? [latestPlan] : []),
    ...compactCodexProgressItems(activity).slice(-CODEX_SESSION_PROGRESS_ACTIVITY_LIMIT),
  ];
}

export function extractCodexThreadProgress(
  response: unknown,
): BridgeSessionProgressItem[] {
  if (!isRecord(response) || !isRecord(response.thread)) {
    return [];
  }
  const turns = Array.isArray(response.thread.turns) ? response.thread.turns : [];
  const latest = [...turns].reverse().find((turn): turn is Record<string, unknown> =>
    isRecord(turn) && Array.isArray(turn.items)
  );
  return latest ? extractCodexProgressFromTurn(latest) : [];
}

export function extractCodexDesktopThreadProgress(
  state: unknown,
): BridgeSessionProgressItem[] {
  const entries = codexDesktopLiveTurnEntries(state);
  const runtimeType = codexDesktopRuntimeType(state);
  const preferred = runtimeType === "active"
    ? [...entries].reverse().find(([, entity]) =>
      isCodexDesktopTurnActiveStatus(entity.status)
    )
    : [...entries].reverse().find(([, entity]) => Array.isArray(entity.items));
  return preferred ? extractCodexProgressFromTurn(preferred[1]) : [];
}

function extractCodexRolloutTurnId(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.turn_id === "string" && payload.turn_id.trim()) {
    return payload.turn_id.trim();
  }
  const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
    ? payload.internal_chat_message_metadata_passthrough
    : null;
  return metadata && typeof metadata.turn_id === "string" && metadata.turn_id.trim()
    ? metadata.turn_id.trim()
    : undefined;
}

function parseCodexRolloutFunctionArguments(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractCodexRolloutReasoningText(payload: Record<string, unknown>): string | null {
  const summaries = Array.isArray(payload.summary) ? payload.summary : [];
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    const summary = summaries[index];
    const rawText = typeof summary === "string"
      ? summary
      : isRecord(summary) && typeof summary.text === "string"
        ? summary.text
        : null;
    const text = cleanCodexReasoningSummary(rawText);
    if (text) {
      return text;
    }
  }
  return null;
}

function rolloutToolProgress(
  payload: Record<string, unknown>,
  turnId: string | undefined,
  status: BridgeSessionProgressItem["status"],
): BridgeSessionProgressItem | null {
  const name = typeof payload.name === "string"
    ? payload.name.trim().toLowerCase()
    : "";
  if (!name || name.endsWith("update_plan") || name.endsWith("updateplan")) {
    return null;
  }
  const id = typeof payload.id === "string" && payload.id.trim()
    ? payload.id.trim()
    : typeof payload.call_id === "string" && payload.call_id.trim()
      ? payload.call_id.trim()
      : `${turnId ?? "turn"}:rollout-tool`;
  const base = { id, ...(turnId ? { turnId } : {}), status };
  if (
    name.includes("apply_patch") ||
    name.includes("write_file") ||
    name.includes("edit_file") ||
    name.includes("replace_file")
  ) {
    return { ...base, kind: "file", text: progressActionText(["修改文件"], status) };
  }
  if (
    name.includes("exec_command") ||
    name.includes("write_stdin") ||
    name.endsWith("shell") ||
    name.endsWith("bash")
  ) {
    return { ...base, kind: "command", text: progressActionText(["运行命令"], status) };
  }
  if (name.includes("view_image") || name.includes("screenshot")) {
    return { ...base, kind: "image", text: progressActionText(["查看图像"], status) };
  }
  if (name.includes("imagegen") || name.includes("image_gen")) {
    return { ...base, kind: "image", text: progressActionText(["生成图像"], status) };
  }
  if (
    name.includes("search_query") ||
    name.includes("image_query") ||
    name.includes("web_search")
  ) {
    return { ...base, kind: "web", text: progressActionText(["搜索网页"], status) };
  }
  if (
    name.includes("browser") ||
    name.includes("node_repl") ||
    name.endsWith(".open") ||
    name.endsWith(".click")
  ) {
    return {
      ...base,
      kind: "tool",
      text: progressActionText(["检查页面与应用状态"], status),
    };
  }
  if (name.includes("spawn_agent") || name.includes("wait_agent")) {
    return { ...base, kind: "tool", text: progressActionText(["处理子任务"], status) };
  }
  return { ...base, kind: "tool", text: progressActionText(["调用工具"], status) };
}

type CodexRolloutProgressRecord = {
  payload: Record<string, unknown>;
  turnId?: string;
  createdAtMs?: number;
};

function parseCodexRolloutProgressRecord(line: string): CodexRolloutProgressRecord | null {
  const trimmed = line.trim();
  if (
    !trimmed ||
    !trimmed.includes('"response_item"') ||
    !(
      trimmed.includes('"reasoning"') ||
      trimmed.includes('"function_call"') ||
      trimmed.includes('"function_call_output"')
    )
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed) || parsed.type !== "response_item" || !isRecord(parsed.payload)) {
      return null;
    }
    const payloadType = parsed.payload.type;
    if (
      payloadType !== "reasoning" &&
      payloadType !== "function_call" &&
      payloadType !== "function_call_output"
    ) {
      return null;
    }
    const turnId = extractCodexRolloutTurnId(parsed.payload);
    const createdAtMs = typeof parsed.timestamp === "string"
      ? Date.parse(parsed.timestamp)
      : Number.NaN;
    return {
      payload: parsed.payload,
      ...(turnId ? { turnId } : {}),
      ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
    };
  } catch {
    return null;
  }
}

function codexRolloutProgressFromRecords(
  records: CodexRolloutProgressRecord[],
): BridgeSessionProgressItem[] {
  const completedCallIds = new Set<string>();
  for (const record of records) {
    if (
      record.payload.type === "function_call_output" &&
      typeof record.payload.call_id === "string" &&
      record.payload.call_id.trim()
    ) {
      completedCallIds.add(record.payload.call_id.trim());
    }
  }

  const activity: BridgeSessionProgressItem[] = [];
  let latestPlan: BridgeSessionProgressItem | null = null;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const payload = record.payload;
    const withTimestamp = <T extends BridgeSessionProgressItem>(item: T): T =>
      record.createdAtMs !== undefined
        ? { ...item, createdAtMs: record.createdAtMs }
        : item;
    if (payload.type === "reasoning") {
      const text = extractCodexRolloutReasoningText(payload);
      if (text) {
        activity.push(withTimestamp({
          id: typeof payload.id === "string" && payload.id.trim()
            ? payload.id.trim()
            : `${record.turnId ?? "turn"}:rollout-reasoning:${index}`,
          ...(record.turnId ? { turnId: record.turnId } : {}),
          kind: "reasoning",
          status: "completed",
          text,
        }));
      }
      continue;
    }
    if (payload.type !== "function_call") {
      continue;
    }
    const name = typeof payload.name === "string" ? payload.name.trim().toLowerCase() : "";
    const callId = typeof payload.call_id === "string" && payload.call_id.trim()
      ? payload.call_id.trim()
      : undefined;
    if (name.endsWith("update_plan") || name.endsWith("updateplan")) {
      const args = parseCodexRolloutFunctionArguments(payload.arguments);
      if (args && Array.isArray(args.plan)) {
        const plan = summarizeCodexPlanProgress({
          type: "todo-list",
          id: typeof payload.id === "string" ? payload.id : callId,
          plan: args.plan,
        }, record.turnId, index);
        latestPlan = plan ? withTimestamp(plan) : latestPlan;
      }
      continue;
    }
    const progress = rolloutToolProgress(
      payload,
      record.turnId,
      callId && completedCallIds.has(callId) ? "completed" : "running",
    );
    if (progress) {
      activity.push(withTimestamp(progress));
    }
  }
  return [
    ...(latestPlan ? [latestPlan] : []),
    ...compactCodexProgressItems(activity).slice(-CODEX_SESSION_PROGRESS_ACTIVITY_LIMIT),
  ];
}

function mergeCodexSessionProgress(
  rollout: BridgeSessionProgressItem[],
  live: BridgeSessionProgressItem[],
): BridgeSessionProgressItem[] {
  const merged = rollout.map((item) => ({ ...item }));
  const indexById = new Map(
    merged.map((item, index) => [item.id, index] as const),
  );
  for (const item of live) {
    const existingIndex = indexById.get(item.id);
    if (existingIndex === undefined) {
      indexById.set(item.id, merged.length);
      merged.push({ ...item });
      continue;
    }
    const existing = merged[existingIndex]!;
    merged[existingIndex] = {
      ...existing,
      ...item,
      ...(existing.createdAtMs !== undefined
        ? { createdAtMs: existing.createdAtMs }
        : {}),
    };
  }
  const sorted = merged.sort((left, right) => {
    const leftTime = left.createdAtMs;
    const rightTime = right.createdAtMs;
    if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    if (leftTime !== undefined) return -1;
    if (rightTime !== undefined) return 1;
    return (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0);
  });
  return compactCodexProgressItems(sorted);
}

export function readCodexSessionProgressFromRolloutTail(
  filePath: string,
): BridgeSessionProgressItem[] {
  const lines = readFileTail(filePath, {
    scanLimitBytes: CODEX_SESSION_PROGRESS_SCAN_LIMIT_BYTES,
    chunkBytes: CODEX_DESKTOP_RUNTIME_STATUS_SCAN_CHUNK_BYTES,
  });
  if (!lines) {
    return [];
  }

  // The primitive emits lines in file order (oldest first); parse from the
  // newest line backward and stop at the first record of a previous turn,
  // mirroring the original reverse-scan semantics.
  const records: CodexRolloutProgressRecord[] = [];
  let latestTurnId: string | undefined;
  let reachedPreviousTurn = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (reachedPreviousTurn) break;
    const record = parseCodexRolloutProgressRecord(lines[index] ?? "");
    if (!record?.turnId) {
      continue;
    }
    if (!latestTurnId) {
      latestTurnId = record.turnId;
    } else if (record.turnId !== latestTurnId) {
      reachedPreviousTurn = records.length > 0;
      if (reachedPreviousTurn) {
        break;
      }
      continue;
    }
    records.push(record);
  }
  records.reverse();
  return codexRolloutProgressFromRecords(records);
}

export function mergeCodexSessionMessages(
  persisted: BridgeSessionMessage[],
  live: BridgeSessionMessage[],
): BridgeSessionMessage[] {
  const merged = persisted.map((message) => ({ ...message }));
  const indexById = new Map<string, number>();
  const indexBySemanticKey = new Map<string, number>();
  const semanticKey = (message: BridgeSessionMessage): string =>
    `${message.turnId ?? ""}:${message.role}:${message.phase ?? ""}:${message.text}`;

  const rebuildIndexes = (): void => {
    indexById.clear();
    indexBySemanticKey.clear();
    merged.forEach((message, index) => {
      if (message.id) {
        indexById.set(message.id, index);
      }
      indexBySemanticKey.set(semanticKey(message), index);
    });
  };
  rebuildIndexes();

  for (const message of live) {
    const idMatch = message.id ? indexById.get(message.id) : undefined;
    if (typeof idMatch === "number") {
      merged[idMatch] = { ...merged[idMatch], ...message };
      rebuildIndexes();
      continue;
    }

    const semanticMatch = indexBySemanticKey.get(semanticKey(message));
    if (typeof semanticMatch === "number") {
      continue;
    }

    let insertAt = merged.length;
    if (message.turnId) {
      for (let index = merged.length - 1; index >= 0; index -= 1) {
        if (merged[index]?.turnId === message.turnId) {
          insertAt = index + 1;
          break;
        }
      }
    }
    merged.splice(insertAt, 0, { ...message });
    rebuildIndexes();
  }
  return merged;
}

export function parseCodexSessionTaskBoundary(
  line: string,
): BridgeResumeSessionRuntimeStatus | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      type?: string;
      payload?: { type?: string };
    };
    if (parsed.type !== "event_msg") {
      return undefined;
    }
    if (parsed.payload?.type === "task_started") {
      return { type: "active", activeFlags: [] };
    }
    if (
      parsed.payload?.type === "task_complete" ||
      parsed.payload?.type === "turn_aborted"
    ) {
      return { type: "idle" };
    }
  } catch {
    // Ignore partial or malformed JSONL records while reading a live session tail.
  }

  return undefined;
}

function parseCodexSessionRunSummary(
  line: string,
  nowMs = Date.now(),
): BridgeSessionRunSummary | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes('"event_msg"')) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed) || parsed.type !== "event_msg" || !isRecord(parsed.payload)) {
      return null;
    }
    const payload = parsed.payload;
    if (
      payload.type !== "task_started" &&
      payload.type !== "task_complete" &&
      payload.type !== "turn_aborted"
    ) {
      return null;
    }
    const turnId = typeof payload.turn_id === "string" && payload.turn_id.trim()
      ? payload.turn_id.trim()
      : undefined;
    const eventTimestampMs = typeof parsed.timestamp === "string"
      ? Date.parse(parsed.timestamp)
      : Number.NaN;
    const startedAtMs = codexTimestampToMs(payload.started_at);
    const completedAtMs = codexTimestampToMs(payload.completed_at) ??
      (payload.type !== "task_started" && Number.isFinite(eventTimestampMs)
        ? eventTimestampMs
        : undefined);
    const durationMs = codexDurationToMs(payload.duration_ms) ??
      (startedAtMs !== undefined && completedAtMs !== undefined
        ? Math.max(0, completedAtMs - startedAtMs)
        : payload.type === "task_started" && startedAtMs !== undefined
          ? Math.max(0, nowMs - startedAtMs)
          : undefined);
    const errorMessage = formatCodexRunErrorMessage(payload.error);
    return {
      ...(turnId ? { turnId } : {}),
      status: payload.type === "task_started"
        ? "running"
        : payload.type === "turn_aborted"
          ? "interrupted"
          : errorMessage
            ? "failed"
            : "completed",
      ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      ...(completedAtMs !== undefined ? { completedAtMs } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    };
  } catch {
    return null;
  }
}

export function readCodexSessionRunSummaryFromRolloutTail(
  filePath: string,
  nowMs = Date.now(),
): BridgeSessionRunSummary | null {
  let summary: BridgeSessionRunSummary | null = null;
  // Scan from the newest line backward; the first parsable summary wins.
  // The primitive emits lines in file order, so iterate and keep the
  // newest parse result (later lines overwrite earlier ones).
  scanFileTail(filePath, {
    scanLimitBytes: CODEX_SESSION_RUN_SUMMARY_SCAN_LIMIT_BYTES,
    chunkBytes: CODEX_DESKTOP_RUNTIME_STATUS_SCAN_CHUNK_BYTES,
  }, (line) => {
    const parsed = parseCodexSessionRunSummary(line.text, nowMs);
    if (parsed) {
      summary = parsed;
    }
  });
  return summary;
}

function readCodexDesktopRuntimeStatusFromSessionTail(
  filePath: string,
): {
  fileSize: number;
  modifiedAtMs: number;
  runtimeStatus: BridgeResumeSessionRuntimeStatus | undefined;
} | null {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return null;
  }

  let fileDescriptor: number;
  try {
    fileDescriptor = fs.openSync(filePath, "r");
  } catch {
    return null;
  }

  try {
    let endOffset = stats.size;
    let scannedBytes = 0;
    let leadingLineFragment = "";

    while (endOffset > 0 && scannedBytes < CODEX_DESKTOP_RUNTIME_STATUS_SCAN_LIMIT_BYTES) {
      const bytesToRead = Math.min(
        CODEX_DESKTOP_RUNTIME_STATUS_SCAN_CHUNK_BYTES,
        endOffset,
        CODEX_DESKTOP_RUNTIME_STATUS_SCAN_LIMIT_BYTES - scannedBytes,
      );
      const startOffset = endOffset - bytesToRead;
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(
        fileDescriptor,
        buffer,
        0,
        buffer.length,
        startOffset,
      );
      const content =
        buffer.subarray(0, bytesRead).toString("utf8") + leadingLineFragment;
      const lines = content.split(/\r?\n/);
      leadingLineFragment = startOffset > 0 ? (lines.shift() ?? "") : "";

      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const runtimeStatus = parseCodexSessionTaskBoundary(lines[index] ?? "");
        if (runtimeStatus) {
          return {
            fileSize: stats.size,
            modifiedAtMs: stats.mtimeMs,
            runtimeStatus,
          };
        }
      }

      endOffset = startOffset;
      scannedBytes += bytesRead;
    }

    if (endOffset === 0 && leadingLineFragment) {
      const runtimeStatus = parseCodexSessionTaskBoundary(leadingLineFragment);
      if (runtimeStatus) {
        return {
          fileSize: stats.size,
          modifiedAtMs: stats.mtimeMs,
          runtimeStatus,
        };
      }
    }
  } catch {
    return null;
  } finally {
    fs.closeSync(fileDescriptor);
  }

  return {
    fileSize: stats.size,
    modifiedAtMs: stats.mtimeMs,
    runtimeStatus: undefined,
  };
}

function findCodexDesktopSessionFilesByThreadId(
  threadIds: string[],
): Map<
  string,
  { filePath: string; fileSize: number; modifiedAtMs: number }
> {
  const sessionsRoot = buildCodexSessionsRoot();
  if (!sessionsRoot || threadIds.length === 0) {
    return new Map();
  }

  const normalizedThreadIds = threadIds
    .map((threadId) => threadId.trim())
    .filter(Boolean);
  const matches = new Map<
    string,
    { filePath: string; fileSize: number; modifiedAtMs: number }
  >();

  for (const filePath of listCodexSessionFilesRecursively(sessionsRoot)) {
    const fileName = path.basename(filePath);
    const threadId = normalizedThreadIds.find((candidate) =>
      fileName.includes(candidate),
    );
    if (!threadId) {
      continue;
    }

    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      continue;
    }

    const previous = matches.get(threadId);
    if (!previous || stats.mtimeMs > previous.modifiedAtMs) {
      matches.set(threadId, {
        filePath,
        fileSize: stats.size,
        modifiedAtMs: stats.mtimeMs,
      });
    }
  }

  return matches;
}

function mapCodexDesktopThreadRuntimeStatus(
  value: unknown,
): BridgeResumeSessionRuntimeStatus | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  switch (value.type) {
    case "notLoaded":
    case "idle":
    case "systemError":
      return { type: value.type };
    case "active": {
      const activeFlags = Array.isArray(value.activeFlags)
        ? value.activeFlags.filter(
            (flag): flag is "waitingOnApproval" | "waitingOnUserInput" =>
              flag === "waitingOnApproval" || flag === "waitingOnUserInput",
          )
        : [];
      return {
        type: "active",
        activeFlags,
      };
    }
    default:
      return undefined;
  }
}

function codexStateDatabasePath(): string {
  if (process.env.CODEX_HOME) {
    return path.join(process.env.CODEX_HOME, "state_5.sqlite");
  }
  const homeDirectory = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
  return path.join(homeDirectory, ".codex", "state_5.sqlite");
}

function codexLocalCatalogDatabasePath(): string {
  if (process.env.CODEX_HOME) {
    return path.join(process.env.CODEX_HOME, "sqlite", "codex-dev.db");
  }
  const homeDirectory = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
  return path.join(homeDirectory, ".codex", "sqlite", "codex-dev.db");
}

async function importCodexRuntimeModule(specifier: string): Promise<unknown> {
  return await import(specifier);
}

async function openCodexStateDatabase(
  databasePath: string,
): Promise<CodexSqliteDatabase> {
  try {
    const sqlite = await importCodexRuntimeModule("node:sqlite") as CodexNodeSqliteModule;
    return new sqlite.DatabaseSync(databasePath, { readOnly: true });
  } catch (nodeError) {
    if (!process.versions.bun) {
      throw nodeError;
    }
    const sqlite = await importCodexRuntimeModule("bun:sqlite") as CodexBunSqliteModule;
    return new sqlite.Database(databasePath, { readonly: true });
  }
}

function codexCatalogTimestampToIso(row: Record<string, unknown>): string {
  const recencyAtMs = Number(row.recency_at_ms);
  if (Number.isFinite(recencyAtMs) && recencyAtMs > 0) {
    return new Date(recencyAtMs).toISOString();
  }
  const updatedAtMs = Number(row.updated_at_ms);
  if (Number.isFinite(updatedAtMs) && updatedAtMs > 0) {
    return new Date(updatedAtMs).toISOString();
  }
  return codexDesktopTimestampToIso(row.updated_at);
}

function codexCatalogTitle(row: Record<string, unknown>, threadId: string): string {
  for (const value of [row.name, row.title, row.preview, row.first_user_message]) {
    if (typeof value !== "string") continue;
    const firstLine = normalizeOutput(value)
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (firstLine) return truncatePreview(firstLine, 120);
  }
  return threadId;
}

async function readCodexLocalCatalogTitles(
  databasePath: string,
): Promise<Map<string, string>> {
  let database: CodexSqliteDatabase;
  try {
    database = await openCodexStateDatabase(databasePath);
  } catch {
    return new Map();
  }
  try {
    const columns = new Set(
      database.prepare("PRAGMA table_info(local_thread_catalog)").all()
        .flatMap((value): string[] =>
          isRecord(value) && typeof value.name === "string" ? [value.name] : []
        ),
    );
    if (
      !columns.has("thread_id") ||
      !columns.has("display_title") ||
      !columns.has("host_id")
    ) {
      return new Map();
    }
    const missingFilter = columns.has("missing_candidate")
      ? "AND missing_candidate = 0"
      : "";
    const order = columns.has("observation_sequence")
      ? "ORDER BY observation_sequence DESC"
      : "";
    const rows = database.prepare(`
      SELECT thread_id, display_title
      FROM local_thread_catalog
      WHERE host_id = 'local' ${missingFilter}
      ${order}
    `).all();
    const titles = new Map<string, string>();
    for (const value of rows) {
      if (!isRecord(value)) continue;
      const threadId = typeof value.thread_id === "string" ? value.thread_id.trim() : "";
      const title = typeof value.display_title === "string"
        ? normalizeOutput(value.display_title).trim()
        : "";
      if (threadId && title && !titles.has(threadId)) {
        titles.set(threadId, truncatePreview(title, 120));
      }
    }
    return titles;
  } catch {
    return new Map();
  } finally {
    database.close();
  }
}

export async function readCodexStateDbSessionCatalog(
  options: {
    databasePath?: string;
    catalogDatabasePath?: string;
    limit?: number;
  } = {},
): Promise<CodexStateDbSessionCatalog | null> {
  const databasePath = options.databasePath ?? codexStateDatabasePath();
  const catalogDatabasePath =
    options.catalogDatabasePath ?? codexLocalCatalogDatabasePath();
  const limit = Math.max(1, options.limit ?? 10);
  let database: CodexSqliteDatabase;
  try {
    database = await openCodexStateDatabase(databasePath);
  } catch {
    return null;
  }

  try {
    const columns = new Set(
      database.prepare("PRAGMA table_info(threads)").all().flatMap((value): string[] => {
        if (!isRecord(value) || typeof value.name !== "string") return [];
        return [value.name];
      }),
    );
    if (!columns.has("id") || !columns.has("rollout_path")) return null;
    const columnOr = (name: string, fallback: string) =>
      columns.has(name) ? name : `${fallback} AS ${name}`;
    const archivedFilter = columns.has("archived") ? "WHERE archived = 0" : "";
    const recencyOrder = columns.has("recency_at_ms")
      ? "recency_at_ms"
      : columns.has("updated_at_ms")
        ? "updated_at_ms"
        : columns.has("updated_at")
          ? "updated_at * 1000"
          : columns.has("created_at")
            ? "created_at * 1000"
            : "0";
    const rows = database.prepare(`
      SELECT id, rollout_path,
             ${columnOr("created_at", "0")},
             ${columnOr("updated_at", "0")},
             ${columnOr("source", "''")},
             ${columnOr("cwd", "''")},
             ${columnOr("title", "''")},
             ${columnOr("first_user_message", "''")},
             ${columnOr("preview", "''")},
             ${columnOr("name", "NULL")},
             ${columnOr("archived", "0")},
             ${columnOr("recency_at_ms", "0")},
             ${columnOr("updated_at_ms", "0")},
             ${columnOr("thread_source", "NULL")},
             ${columnOr("project_id", "NULL")}
      FROM threads
      ${archivedFilter}
      ORDER BY ${recencyOrder} DESC
      LIMIT ?
    `).all(limit);
    const localCatalogTitles = await readCodexLocalCatalogTitles(catalogDatabasePath);
    const candidates: BridgeResumeSessionCandidate[] = [];
    const rolloutPathByThreadId = new Map<string, string>();
    for (const value of rows) {
      if (!isRecord(value)) continue;
      const threadId = typeof value.id === "string" ? value.id.trim() : "";
      if (!threadId) continue;
      const rolloutPath = typeof value.rollout_path === "string"
        ? value.rollout_path.trim()
        : "";
      const cwd = typeof value.cwd === "string" && value.cwd.trim()
        ? value.cwd.trim()
        : undefined;
      const sourceValue = typeof value.thread_source === "string" && value.thread_source.trim()
        ? value.thread_source.trim()
        : typeof value.source === "string" && value.source.trim()
          ? value.source.trim()
          : undefined;
      const projectId = typeof value.project_id === "string" && value.project_id.trim()
        ? value.project_id.trim()
        : undefined;
      candidates.push({
        sessionId: threadId,
        threadId,
        title: localCatalogTitles.get(threadId) ?? codexCatalogTitle(value, threadId),
        lastUpdatedAt: codexCatalogTimestampToIso(value),
        ...(sourceValue ? { source: sourceValue } : {}),
        ...(cwd ? { cwd } : {}),
        ...(projectId ? { projectId } : {}),
        runtimeStatus: { type: "notLoaded" },
      });
      if (rolloutPath) rolloutPathByThreadId.set(threadId, rolloutPath);
    }
    return { candidates, rolloutPathByThreadId };
  } catch {
    return null;
  } finally {
    database.close();
  }
}

export function mapCodexDesktopThreadListResponse(
  response: unknown,
  limit = 10,
): BridgeResumeSessionCandidate[] {
  if (!isRecord(response)) {
    return [];
  }

  const rawThreads = Array.isArray(response.data)
    ? response.data
    : Array.isArray(response.threads)
      ? response.threads
      : [];

  return rawThreads
    .map((value): BridgeResumeSessionCandidate | null => {
      if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
        return null;
      }

      const threadId = value.id.trim();
      const name = typeof value.name === "string" ? value.name.trim() : "";
      const preview = typeof value.preview === "string"
        ? normalizeOutput(value.preview)
            .split("\n")
            .map((line) => line.trim())
            .find(Boolean) ?? ""
        : "";
      const cwd = typeof value.cwd === "string" && value.cwd.trim()
        ? value.cwd.trim()
        : undefined;
      const source = typeof value.source === "string" && value.source.trim()
        ? value.source.trim()
        : undefined;

      return {
        sessionId: threadId,
        threadId,
        title: truncatePreview(name || preview || threadId, 120),
        lastUpdatedAt: codexDesktopTimestampToIso(value.recencyAt ?? value.updatedAt),
        source,
        cwd,
        runtimeStatus: mapCodexDesktopThreadRuntimeStatus(value.status),
      };
    })
    .filter((candidate): candidate is BridgeResumeSessionCandidate => Boolean(candidate))
    .slice(0, Math.max(1, limit));
}


function normalizeDesktopProjectPath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPathInsideDesktopProject(candidateCwd: string, rootPath: string): boolean {
  const candidate = normalizeDesktopProjectPath(candidateCwd);
  const root = normalizeDesktopProjectPath(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export type CodexDesktopProjectCreationTarget = {
  legacyProjectId: string;
  appServerProjectId: string | null;
};

export function resolveCodexDesktopProjectCreationTarget(
  globalState: unknown,
  threadId: string,
  codexHome: string,
  candidateCwd?: string,
): CodexDesktopProjectCreationTarget | null {
  if (!isRecord(globalState)) {
    return null;
  }
  const projectlessThreadIds = globalState["projectless-thread-ids"];
  if (
    Array.isArray(projectlessThreadIds) &&
    projectlessThreadIds.some((value) => value === threadId)
  ) {
    return null;
  }
  const assignments = globalState["thread-project-assignments"];
  const assignment = isRecord(assignments) ? assignments[threadId] : null;
  let legacyProjectId = isRecord(assignment) &&
      assignment.projectKind === "local" &&
      typeof assignment.projectId === "string"
    ? assignment.projectId.trim()
    : "";
  if (!legacyProjectId && candidateCwd) {
    const projects = globalState["local-projects"];
    let matchedRootLength = -1;
    if (isRecord(projects)) {
      for (const [projectId, project] of Object.entries(projects)) {
        if (!isRecord(project) || !Array.isArray(project.rootPaths)) {
          continue;
        }
        for (const rootPath of project.rootPaths) {
          if (
            typeof rootPath === "string" &&
            rootPath.trim() &&
            isPathInsideDesktopProject(candidateCwd, rootPath) &&
            rootPath.length > matchedRootLength
          ) {
            legacyProjectId = projectId;
            matchedRootLength = rootPath.length;
          }
        }
      }
    }
  }
  if (!legacyProjectId) {
    return null;
  }

  const mappings = globalState["app-server-project-id-by-legacy-project-id-by-host"];
  if (!isRecord(mappings)) {
    return { legacyProjectId, appServerProjectId: null };
  }
  const localHostKey = `local:${path.resolve(codexHome)}`;
  const localMapping = mappings[localHostKey];
  if (isRecord(localMapping)) {
    const mappedProjectId = localMapping[legacyProjectId];
    if (typeof mappedProjectId === "string" && mappedProjectId.trim()) {
      return {
        legacyProjectId,
        appServerProjectId: mappedProjectId.trim(),
      };
    }
  }

  const fallbackProjectIds = new Set<string>();
  for (const [hostKey, mapping] of Object.entries(mappings)) {
    if (!hostKey.startsWith("local:") || !isRecord(mapping)) {
      continue;
    }
    const mappedProjectId = mapping[legacyProjectId];
    if (typeof mappedProjectId === "string" && mappedProjectId.trim()) {
      fallbackProjectIds.add(mappedProjectId.trim());
    }
  }
  return {
    legacyProjectId,
    appServerProjectId: fallbackProjectIds.size === 1
      ? [...fallbackProjectIds][0] ?? null
      : null,
  };
}

export function applyCodexDesktopProjectMetadata(
  candidates: BridgeResumeSessionCandidate[],
  globalState: unknown,
): BridgeResumeSessionCandidate[] {
  const canonicalProjectIdByThreadId = new Map<string, string>();
  for (const candidate of candidates) {
    const threadId = candidate.threadId ?? candidate.sessionId;
    if (candidate.projectId?.trim()) {
      canonicalProjectIdByThreadId.set(threadId, candidate.projectId.trim());
    }
    delete candidate.projectId;
    delete candidate.projectName;
    delete candidate.projectOrder;
    delete candidate.projectThreadOrder;
  }
  if (!isRecord(globalState)) {
    return candidates;
  }

  const rawProjects = globalState["local-projects"];
  const rawAssignments = globalState["thread-project-assignments"];
  const rawProjectlessThreadIds = globalState["projectless-thread-ids"];
  const rawProjectOrder = globalState["project-order"];
  const rawThreadOrders = globalState["sidebar-project-thread-orders"];
  const rawAppServerProjectMappings =
    globalState["app-server-project-id-by-legacy-project-id-by-host"];
  if (!isRecord(rawProjects)) {
    return candidates;
  }

  const projects = new Map<string, { name: string; rootPaths: string[] }>();
  for (const [projectId, value] of Object.entries(rawProjects)) {
    if (!isRecord(value)) {
      continue;
    }
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const rootPaths = Array.isArray(value.rootPaths)
      ? value.rootPaths.filter(
          (rootPath): rootPath is string =>
            typeof rootPath === "string" && Boolean(rootPath.trim()),
        )
      : [];
    if (name) {
      projects.set(projectId, { name, rootPaths });
    }
  }

  const projectOrder = new Map<string, number>();
  if (Array.isArray(rawProjectOrder)) {
    rawProjectOrder.forEach((projectId, index) => {
      if (typeof projectId === "string") {
        projectOrder.set(projectId, index);
      }
    });
  }
  const projectlessThreadIds = new Set(
    Array.isArray(rawProjectlessThreadIds)
      ? rawProjectlessThreadIds.filter(
          (threadId): threadId is string => typeof threadId === "string",
        )
      : [],
  );

  const legacyProjectIdByAppServerProjectId = new Map<string, string | null>();
  if (isRecord(rawAppServerProjectMappings)) {
    for (const [hostKey, mapping] of Object.entries(rawAppServerProjectMappings)) {
      if (!hostKey.startsWith("local:") || !isRecord(mapping)) {
        continue;
      }
      for (const [legacyProjectId, appServerProjectId] of Object.entries(mapping)) {
        if (typeof appServerProjectId !== "string" || !appServerProjectId.trim()) {
          continue;
        }
        const normalizedAppServerProjectId = appServerProjectId.trim();
        const existing = legacyProjectIdByAppServerProjectId.get(
          normalizedAppServerProjectId,
        );
        legacyProjectIdByAppServerProjectId.set(
          normalizedAppServerProjectId,
          existing === undefined || existing === legacyProjectId
            ? legacyProjectId
            : null,
        );
      }
    }
  }

  const threadOrderByProject = new Map<string, Map<string, number>>();
  if (isRecord(rawThreadOrders)) {
    for (const [projectId, value] of Object.entries(rawThreadOrders)) {
      if (!isRecord(value) || !Array.isArray(value.threadIds)) {
        continue;
      }
      const threadOrder = new Map<string, number>();
      value.threadIds.forEach((threadId, index) => {
        if (typeof threadId === "string") {
          threadOrder.set(threadId, index);
        }
      });
      threadOrderByProject.set(projectId, threadOrder);
    }
  }

  const resolveProjectId = (
    candidate: BridgeResumeSessionCandidate,
  ): string | null => {
    const threadId = candidate.threadId ?? candidate.sessionId;
    const canonicalProjectId = canonicalProjectIdByThreadId.get(threadId);
    if (canonicalProjectId) {
      if (projects.has(canonicalProjectId)) {
        return canonicalProjectId;
      }
      const legacyProjectId = legacyProjectIdByAppServerProjectId.get(
        canonicalProjectId,
      );
      if (legacyProjectId && projects.has(legacyProjectId)) {
        return legacyProjectId;
      }
    }
    if (projectlessThreadIds.has(threadId)) {
      return null;
    }
    if (isRecord(rawAssignments)) {
      const assignment = rawAssignments[threadId];
      if (
        isRecord(assignment) &&
        typeof assignment.projectId === "string" &&
        projects.has(assignment.projectId)
      ) {
        return assignment.projectId;
      }
    }
    if (!candidate.cwd) {
      return null;
    }
    let matchedProjectId: string | null = null;
    let matchedRootLength = -1;
    for (const [projectId, project] of projects) {
      for (const rootPath of project.rootPaths) {
        if (
          isPathInsideDesktopProject(candidate.cwd, rootPath) &&
          rootPath.length > matchedRootLength
        ) {
          matchedProjectId = projectId;
          matchedRootLength = rootPath.length;
        }
      }
    }
    return matchedProjectId;
  };

  for (const candidate of candidates) {
    const projectId = resolveProjectId(candidate);
    if (!projectId) {
      continue;
    }
    const project = projects.get(projectId);
    if (!project) {
      continue;
    }
    candidate.projectId = projectId;
    candidate.projectName = project.name;
    const orderedProjectIndex = projectOrder.get(projectId);
    if (orderedProjectIndex !== undefined) {
      candidate.projectOrder = orderedProjectIndex;
    }
    const threadId = candidate.threadId ?? candidate.sessionId;
    const orderedThreadIndex = threadOrderByProject.get(projectId)?.get(threadId);
    if (orderedThreadIndex !== undefined) {
      candidate.projectThreadOrder = orderedThreadIndex;
    }
  }
  return candidates;
}

export class CodexPtyAdapter extends AbstractPtyAdapter {
  readonly runtimeKind = "codex_runtime_host" as const;

  private appServer: ChildProcessWithoutNullStreams | null = null;
  private nativeProcess: ChildProcess | null = null;
  private appServerPort: number | null = null;
  private appServerShuttingDown = false;
  private appServerLog = "";
  private appServerAuthToken: string | null = null;
  private appServerAuthTokenFilePath: string | null = null;
  private rpcSocket: WebSocket | null = null;
  private rpcShuttingDown = false;
  private rpcReconnectPromise: Promise<boolean> | null = null;
  private cleanPanelExitInProgress = false;
  private rpcRequestCounter = 0;
  private pendingRpcRequests = new Map<string, CodexRpcPendingRequest>();
  private desktopIpcClient: CodexDesktopIpcClient | null = null;
  private desktopTransportStarted = false;
  private removeDesktopStateListener: (() => void) | null = null;
  private removeDesktopConnectionListener: (() => void) | null = null;
  private desktopReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private desktopReconnectGraceMs = CODEX_DESKTOP_RECONNECT_GRACE_MS;
  private desktopDisconnectWasReported = false;
  private desktopMetadataRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private desktopMetadataRecoveryPromise: Promise<boolean> | null = null;
  private desktopMetadataRecoveryGraceMs = CODEX_DESKTOP_METADATA_RECOVERY_GRACE_MS;
  private desktopMetadataUnavailableReason: string | null = null;
  private desktopInitializedThreadIds = new Set<string>();
  private desktopSeenRequestKeys = new Set<string>();
  private desktopApprovalSettleTimeoutMs = 1_500;
  private subscribedThreadIds = new Set<string>();
  private sharedThreadId: string | null = null;
  private announcedThreadId: string | null = null;
  private pendingThreadAnnouncement: CodexPendingThreadAnnouncement | null = null;
  private activeTurn: CodexActiveTurn | null = null;
  private backgroundTurns = new Map<string, CodexActiveTurn>();
  private bridgeOwnedTurnIds = new Set<string>();
  private recentBridgeThreadSignalAtById = new Map<string, number>();
  private pendingTurnStart = false;
  private pendingTurnThreadId: string | null = null;
  private pendingDesktopTurnThreadIds = new Set<string>();
  private pendingDesktopTurnTextByThreadId = new Map<string, string>();
  private selectedDesktopModelByThreadId = new Map<string, string>();
  private selectedDesktopReasoningEffortByThreadId = new Map<string, string>();
  private selectedDesktopPermissionByThreadId = new Map<
    string,
    CodexDesktopPermissionSettings
  >();
  private desktopQueuedFollowUpCleanupKeys = new Set<string>();
  private desktopQueuedFollowUpDrainThreadIds = new Set<string>();
  private desktopBootstrapThreadIds = new Set<string>();
  private desktopBootstrapHandoffDelayMs = 150;
  private recentDesktopTurnTextByThreadId = new Map<
    string,
    { text: string; acceptedAtMs: number }
  >();
  private interruptPendingTurnStart = false;
  private pendingThreadFollowId: string | null = null;
  private pendingApprovalRequests: CodexPendingApprovalRequest[] = [];
  private pendingUserInputRequests: CodexPendingUserInputRequest[] = [];
  private queuedTurnNotifications: CodexQueuedNotification[] = [];
  private queuedTurnServerRequests: Array<{
    requestId: CodexRpcRequestId;
    method: CodexPendingApprovalRequest["method"] | CodexPendingUserInputRequest["method"];
    params: Record<string, unknown>;
  }> = [];
  private mirroredUserInputTurnIds = new Set<string>();
  private turnFinalMessages = new Map<string, Map<string, string>>();
  private turnDeltaByItem = new Map<string, Map<string, string>>();
  private turnErrorById = new Map<string, string>();
  private turnStartedAtMs = new Map<string, number>();
  private turnLastActivityAtMs = new Map<string, number>();
  private turnPreviewById = new Map<string, string>();
  private startupBlocker: string | null = null;
  private warmupUntilMs = 0;
  private sessionFilePath: string | null = null;
  private sessionPollTimer: ReturnType<typeof setInterval> | null = null;
  private sessionReadOffset = 0;
  private sessionPartialLine = "";
  private sessionFinalText: string | null = null;
  private sessionIgnoreBeforeMs: number | null = null;
  private nextSessionFallbackScanAtMs = 0;
  private nextSessionFileLookupAtMs = 0;
  private desktopThreadCwdById = new Map<string, string>();
  private desktopThreadAppServerProjectIdById = new Map<string, string>();
  private desktopGlobalStateCache: {
    filePath: string;
    modifiedAtMs: number;
    value: unknown;
  } | null = null;
  private desktopQueuedFollowUpMutationChain: Promise<void> = Promise.resolve();
  private desktopThreadRuntimeStatusCache =
    new Map<string, CodexDesktopRuntimeStatusCacheEntry>();
  private desktopThreadSessionFilePathById = new Map<string, string>();
  private desktopListedRuntimeStatusByThreadId =
    new Map<string, BridgeResumeSessionRuntimeStatus>();
  private completedTurnIds = new Set<string>();
  private completedTurnOrder: string[] = [];
  private pendingInjectedInputs: Array<{
    text: string;
    normalizedText: string;
    createdAtMs: number;
  }> = [];
  private localInputListener: ((chunk: string | Buffer) => void) | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  private interruptFallbackTurn: CodexActiveTurn | null = null;
  private finalReplyCompletionTimer: ReturnType<typeof setTimeout> | null = null;
  private finalReplyCompletionTurnId: string | null = null;
  private resumeThreadId: string | null;
  private readonly localClientInstanceId = `${process.pid}-${Date.now().toString(36)}`;

  constructor(options: AdapterOptions) {
    super(options);
    this.resumeThreadId = options.sessionStartMode === "new"
      ? null
      : options.initialSharedSessionId ?? options.initialSharedThreadId ?? null;
    if (this.resumeThreadId && options.renderMode !== "panel") {
      this.state.sharedSessionId = this.resumeThreadId;
      this.state.sharedThreadId = this.resumeThreadId;
    }
  }

  private getDesktopGlobalStateFilePath(): string {
    return this.options.codexDesktopGlobalStateFile ??
      (process.env.CODEX_HOME
        ? path.join(process.env.CODEX_HOME, ".codex-global-state.json")
        : path.join(os.homedir(), ".codex", ".codex-global-state.json"));
  }

  private readDesktopGlobalState(): unknown | null {
    const filePath = this.getDesktopGlobalStateFilePath();
    try {
      const modifiedAtMs = fs.statSync(filePath).mtimeMs;
      if (
        this.desktopGlobalStateCache?.filePath === filePath &&
        this.desktopGlobalStateCache.modifiedAtMs === modifiedAtMs
      ) {
        return this.desktopGlobalStateCache.value;
      }
      const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
      if (!raw) {
        return null;
      }
      const value = JSON.parse(raw) as unknown;
      this.desktopGlobalStateCache = { filePath, modifiedAtMs, value };
      return value;
    } catch {
      return null;
    }
  }

  private updateDesktopQueuedFollowUpsCache(
    state: CodexDesktopQueuedFollowUpsState,
  ): void {
    const filePath = this.getDesktopGlobalStateFilePath();
    const current = this.readDesktopGlobalState();
    const next = isRecord(current) ? structuredClone(current) : {};
    next["queued-follow-ups"] = structuredClone(state);
    let modifiedAtMs = Date.now();
    try {
      modifiedAtMs = fs.statSync(filePath).mtimeMs;
    } catch {
      // Tests and first-run setups may not have a persisted global-state file yet.
    }
    this.desktopGlobalStateCache = { filePath, modifiedAtMs, value: next };
  }

  private async writeDesktopQueuedFollowUpsState(
    threadId: string,
    state: CodexDesktopQueuedFollowUpsState,
  ): Promise<void> {
    const client = this.desktopIpcClient;
    if (!client) {
      throw new Error("无法连接 Codex 桌面端，请确认应用正在运行。");
    }
    await client.setQueuedFollowUpsState(threadId, state);
    this.updateDesktopQueuedFollowUpsCache(state);
  }

  private withDesktopQueuedFollowUpMutation<T>(
    action: () => Promise<T>,
  ): Promise<T> {
    const run = this.desktopQueuedFollowUpMutationChain.then(action);
    this.desktopQueuedFollowUpMutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private buildDesktopQueuedFollowUp(
    threadId: string,
    items: BridgeTurnInputItem[],
  ): CodexDesktopQueuedFollowUp {
    const text = items
      .filter((item): item is Extract<BridgeTurnInputItem, { type: "text" }> =>
        item.type === "text"
      )
      .map((item) => item.text)
      .join("\n");
    const cwd = this.desktopThreadCwdById.get(threadId) ?? this.options.cwd;
    const imageAttachments = items.flatMap((item) => {
      if (item.type === "localImage") {
        return [{
          src: item.path,
          localPath: item.path,
          filename: path.basename(item.path),
        }];
      }
      if (item.type === "image") {
        return [{ src: item.url }];
      }
      return [];
    });
    return {
      id: crypto.randomUUID(),
      text,
      context: {
        addedFiles: [],
        chatGptConversationContexts: [],
        ideContext: null,
        imageAttachments,
        imageCommentDrafts: [],
        prompt: text,
        appshotContexts: [],
        fileAttachments: [],
        pastedTextAttachments: [],
        commentAttachments: [],
        mcpAppModelContextAttachments: [],
        selectedTextAttachments: [],
        responseTextAnnotations: [],
        pullRequestChecks: [],
        pullRequestMergeConflict: null,
        existingWorkspaceRoot: null,
        localProjectId: null,
        workspaceRoots: [cwd],
        threadReferences: [],
      },
      cwd,
      createdAt: Date.now(),
    };
  }

  private desktopQueuedFollowUpExists(
    threadId: string,
    messageId: string,
  ): boolean {
    this.desktopGlobalStateCache = null;
    const state = readCodexDesktopQueuedFollowUpsState(
      this.readDesktopGlobalState(),
    );
    return (state[threadId] ?? []).some(
      (value) => normalizeCodexDesktopQueuedFollowUp(value)?.id === messageId,
    );
  }

  private async waitForDesktopQueuedFollowUp(
    threadId: string,
    messageId: string,
    timeoutMs = 2_000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (this.desktopQueuedFollowUpExists(threadId, messageId)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    return this.desktopQueuedFollowUpExists(threadId, messageId);
  }

  private async enqueueDesktopQueuedFollowUp(
    threadId: string,
    items: BridgeTurnInputItem[],
  ): Promise<BridgeSessionSendResult> {
    return await this.withDesktopQueuedFollowUpMutation(async () => {
      const state = readCodexDesktopQueuedFollowUpsState(
        this.readDesktopGlobalState(),
      );
      const message = this.buildDesktopQueuedFollowUp(threadId, items);
      const queue = state[threadId] ?? [];
      queue.push(message);
      state[threadId] = queue;
      try {
        await this.writeDesktopQueuedFollowUpsState(threadId, state);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        const timedOut = messageText.includes(
          "请求超时：thread-follower-set-queued-follow-ups-state",
        );
        if (!timedOut || !await this.waitForDesktopQueuedFollowUp(threadId, message.id)) {
          if (timedOut) {
            throw new Error(
              "Codex 暂未确认待发送消息是否已加入队列，请先查看任务状态，避免重复发送。",
              { cause: error },
            );
          }
          throw error;
        }
        this.updateDesktopQueuedFollowUpsCache(state);
      }
      return {
        queued: true,
        queuedMessageId: message.id,
        queuePosition: queue.length,
      };
    });
  }

  private desktopThreadBusyForQueuedFollowUpDrain(threadId: string): boolean {
    const liveState = this.getDesktopThreadStateView(threadId);
    const liveRuntimeType = codexDesktopRuntimeType(liveState);
    return this.pendingDesktopTurnThreadIds.has(threadId) ||
      this.activeTurn?.threadId === threadId ||
      Array.from(this.backgroundTurns.values()).some((turn) => turn.threadId === threadId) ||
      this.getPendingApprovalRequestsForThread(threadId).length > 0 ||
      this.getPendingUserInputRequestsForThread(threadId).length > 0 ||
      liveRuntimeType === "active" ||
      (liveRuntimeType !== "idle" &&
        this.desktopListedRuntimeStatusByThreadId.get(threadId)?.type === "active");
  }

  private scheduleDesktopQueuedFollowUpDrain(threadId: string): void {
    if (!this.usesDesktopTransport() || this.desktopQueuedFollowUpDrainThreadIds.has(threadId)) {
      return;
    }
    if (this.getQueuedTaskInputs(threadId).length === 0) return;
    this.desktopQueuedFollowUpDrainThreadIds.add(threadId);
    const timer = setTimeout(() => {
      void this.drainDesktopQueuedFollowUp(threadId)
        .catch(() => undefined)
        .finally(() => {
          this.desktopQueuedFollowUpDrainThreadIds.delete(threadId);
        });
    }, CODEX_DESKTOP_QUEUED_FOLLOW_UP_DRAIN_DELAY_MS);
    timer.unref?.();
  }

  private async drainDesktopQueuedFollowUp(threadId: string): Promise<void> {
    if (this.desktopThreadBusyForQueuedFollowUpDrain(threadId)) return;
    await this.withDesktopQueuedFollowUpMutation(async () => {
      if (this.desktopThreadBusyForQueuedFollowUpDrain(threadId)) return;
      const client = this.desktopIpcClient;
      if (!client) return;
      this.desktopGlobalStateCache = null;
      const state = readCodexDesktopQueuedFollowUpsState(this.readDesktopGlobalState());
      const queue = state[threadId] ?? [];
      const index = queue.findIndex((value) => Boolean(normalizeCodexDesktopQueuedFollowUp(value)));
      if (index < 0) return;
      const message = normalizeCodexDesktopQueuedFollowUp(queue[index]);
      if (!message) return;
      const input: BridgeTurnInputItem[] = [
        ...(message.text.trim()
          ? [{ type: "text" as const, text: message.text }]
          : []),
        ...codexDesktopQueuedFollowUpImageItems(message),
      ];
      if (input.length === 0) return;

      queue.splice(index, 1);
      if (queue.length > 0) state[threadId] = queue;
      else delete state[threadId];
      await this.writeDesktopQueuedFollowUpsState(threadId, state);

      this.pendingDesktopTurnThreadIds.add(threadId);
      const normalizedText = normalizeOutput(message.text).trim();
      if (normalizedText) this.pendingDesktopTurnTextByThreadId.set(threadId, normalizedText);
      try {
        const startInput = input.length === 1 && input[0]?.type === "text"
          ? input[0].text
          : input;
        const selectedModel = this.selectedDesktopModelByThreadId.get(threadId);
        const selectedReasoningEffort = this.selectedDesktopReasoningEffortByThreadId.get(threadId);
        const permissionSettings = this.resolveDesktopPermissionSettings(threadId);
        const turn = await client.startTurn(threadId, startInput, {
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(selectedReasoningEffort ? { effort: selectedReasoningEffort } : {}),
          approvalPolicy: permissionSettings.approvalPolicy,
          approvalsReviewer: permissionSettings.approvalsReviewer,
          sandbox: permissionSettings.sandbox,
          sandboxPolicy: permissionSettings.sandboxPolicy,
        });
        const turnId = typeof turn.id === "string" ? turn.id : null;
        if (!turnId) throw new Error("Codex 桌面端没有返回任务编号。");
        this.bridgeOwnedTurnIds.add(turnId);
        this.turnStartedAtMs.set(turnId, Date.now());
        this.turnPreviewById.set(turnId, truncatePreview(message.text));
        const trackedTurn = { threadId, turnId, origin: "wechat" as const };
        if (threadId === this.sharedThreadId && !this.activeTurn) {
          this.setActiveTurn(trackedTurn);
        } else {
          this.backgroundTurns.set(turnId, trackedTurn);
        }
        if (normalizedText) {
          this.recentDesktopTurnTextByThreadId.set(threadId, {
            text: normalizedText,
            acceptedAtMs: Date.now(),
          });
        }
        this.syncSelectedThreadState();
      } catch (error) {
        const restoreState = readCodexDesktopQueuedFollowUpsState(
          this.readDesktopGlobalState(),
        );
        const restoreQueue = restoreState[threadId] ?? [];
        restoreQueue.splice(Math.min(index, restoreQueue.length), 0, message);
        restoreState[threadId] = restoreQueue;
        await this.writeDesktopQueuedFollowUpsState(threadId, restoreState);
        throw error;
      } finally {
        this.pendingDesktopTurnThreadIds.delete(threadId);
        if (
          normalizedText &&
          this.pendingDesktopTurnTextByThreadId.get(threadId) === normalizedText
        ) {
          this.pendingDesktopTurnTextByThreadId.delete(threadId);
        }
      }
    });
  }

  private scheduleConsumedDesktopQueuedFollowUpCleanup(
    threadId: string,
    userText: string,
    turnStartedAtMs: number,
  ): void {
    const normalizedText = normalizeOutput(userText).trim();
    if (!normalizedText) return;
    const cleanupKey = `${threadId}\u0000${normalizedText}`;
    if (this.desktopQueuedFollowUpCleanupKeys.has(cleanupKey)) return;
    const state = readCodexDesktopQueuedFollowUpsState(this.readDesktopGlobalState());
    const queue = state[threadId] ?? [];
    const matchesConsumedInput = (value: unknown): boolean => {
      const message = normalizeCodexDesktopQueuedFollowUp(value);
      if (!message || normalizeOutput(message.text).trim() !== normalizedText) {
        return false;
      }
      const createdAtMs = typeof message.createdAt === "number" &&
          Number.isFinite(message.createdAt)
        ? message.createdAt
        : undefined;
      return createdAtMs !== undefined && createdAtMs <= turnStartedAtMs;
    };
    const hasMatch = queue.some(matchesConsumedInput);
    if (!hasMatch) return;

    this.desktopQueuedFollowUpCleanupKeys.add(cleanupKey);
    void this.withDesktopQueuedFollowUpMutation(async () => {
      const nextState = readCodexDesktopQueuedFollowUpsState(
        this.readDesktopGlobalState(),
      );
      const nextQueue = nextState[threadId] ?? [];
      const index = nextQueue.findIndex(matchesConsumedInput);
      if (index < 0) return;
      nextQueue.splice(index, 1);
      if (nextQueue.length > 0) nextState[threadId] = nextQueue;
      else delete nextState[threadId];
      await this.writeDesktopQueuedFollowUpsState(threadId, nextState);
    }).catch(() => undefined).finally(() => {
      this.desktopQueuedFollowUpCleanupKeys.delete(cleanupKey);
    });
  }

  getQueuedTaskInputs(threadId: string): BridgeQueuedTaskInput[] {
    return extractCodexDesktopQueuedTaskInputs(
      this.readDesktopGlobalState(),
      threadId,
    );
  }

  async updateQueuedTaskInput(
    threadId: string,
    messageId: string,
    text: string,
  ): Promise<boolean> {
    return await this.withDesktopQueuedFollowUpMutation(async () => {
      const state = readCodexDesktopQueuedFollowUpsState(
        this.readDesktopGlobalState(),
      );
      const queue = state[threadId] ?? [];
      const index = queue.findIndex(
        (value) => normalizeCodexDesktopQueuedFollowUp(value)?.id === messageId,
      );
      if (index < 0) {
        return false;
      }
      const message = normalizeCodexDesktopQueuedFollowUp(queue[index]);
      if (!message) {
        return false;
      }
      const imageCount = codexDesktopQueuedFollowUpImageItems(message).length;
      if (!text.trim() && imageCount === 0) {
        throw new Error("消息内容不能为空。");
      }
      const context = isRecord(message.context)
        ? { ...message.context, prompt: text }
        : { prompt: text };
      queue[index] = { ...message, text, context };
      state[threadId] = queue;
      await this.writeDesktopQueuedFollowUpsState(threadId, state);
      return true;
    });
  }

  async deleteQueuedTaskInput(
    threadId: string,
    messageId: string,
  ): Promise<boolean> {
    return await this.withDesktopQueuedFollowUpMutation(async () => {
      const state = readCodexDesktopQueuedFollowUpsState(
        this.readDesktopGlobalState(),
      );
      const queue = state[threadId] ?? [];
      const index = queue.findIndex(
        (value) => normalizeCodexDesktopQueuedFollowUp(value)?.id === messageId,
      );
      if (index < 0) {
        return false;
      }
      queue.splice(index, 1);
      if (queue.length > 0) {
        state[threadId] = queue;
      } else {
        delete state[threadId];
      }
      await this.writeDesktopQueuedFollowUpsState(threadId, state);
      return true;
    });
  }

  async steerQueuedTaskInput(
    threadId: string,
    messageId: string,
  ): Promise<boolean> {
    return await this.withDesktopQueuedFollowUpMutation(async () => {
      const client = this.desktopIpcClient;
      if (!client) {
        throw new Error("无法连接 Codex 桌面端，请确认应用正在运行。");
      }
      const state = readCodexDesktopQueuedFollowUpsState(
        this.readDesktopGlobalState(),
      );
      const queue = state[threadId] ?? [];
      const index = queue.findIndex(
        (value) => normalizeCodexDesktopQueuedFollowUp(value)?.id === messageId,
      );
      if (index < 0) {
        return false;
      }
      const message = normalizeCodexDesktopQueuedFollowUp(queue[index]);
      if (!message) {
        return false;
      }
      const input: BridgeTurnInputItem[] = [
        ...(message.text.trim()
          ? [{ type: "text" as const, text: message.text }]
          : []),
        ...codexDesktopQueuedFollowUpImageItems(message),
      ];
      if (input.length === 0) {
        throw new Error("这条待发送消息没有可用内容。");
      }
      queue.splice(index, 1);
      if (queue.length > 0) {
        state[threadId] = queue;
      } else {
        delete state[threadId];
      }
      await this.writeDesktopQueuedFollowUpsState(threadId, state);
      try {
        await client.steerTurn(threadId, input, message);
        return true;
      } catch (error) {
        const restoreState = readCodexDesktopQueuedFollowUpsState(
          this.readDesktopGlobalState(),
        );
        const restoreQueue = restoreState[threadId] ?? [];
        restoreQueue.splice(Math.min(index, restoreQueue.length), 0, message);
        restoreState[threadId] = restoreQueue;
        await this.writeDesktopQueuedFollowUpsState(threadId, restoreState);
        throw error;
      }
    });
  }

  private resolveDesktopPermissionSettings(
    threadId?: string,
  ): CodexDesktopPermissionSettings {
    const selected = threadId
      ? this.selectedDesktopPermissionByThreadId.get(threadId.trim())
      : undefined;
    if (selected) {
      return cloneCodexPermissionSettings(selected);
    }
    if (this.options.inheritCodexDesktopPermissions !== true) {
      return cloneCodexPermissionSettings(DEFAULT_CODEX_PERMISSION_SETTINGS);
    }

    return resolveCodexDesktopPermissionSettings(
      this.readDesktopGlobalState(),
      threadId,
    ) ?? cloneCodexPermissionSettings(DEFAULT_CODEX_PERMISSION_SETTINGS);
  }

  override async start(): Promise<void> {
    if (this.isCodexClientRunning()) {
      return;
    }

    if (this.usesDesktopTransport()) {
      await this.startDesktopRuntime();
      return;
    }

    if (this.isHeadlessRuntimeMode()) {
      this.setStatus("starting", `Starting ${this.options.kind} runtime host...`);
    }

    await this.startAppServer();
    await this.connectRpcClient();
    await this.restoreInitialSharedThreadIfNeeded();

    try {
      if (this.isNativePanelMode()) {
        await this.startNativeClient();
      } else if (this.isHeadlessRuntimeMode()) {
        this.shuttingDown = false;
        this.cleanPanelExitInProgress = false;
        this.hasAcceptedInput = true;
        this.state.pid = this.appServer?.pid ?? undefined;
        this.state.startedAt = nowIso();
        this.state.pendingApproval = null;
        this.afterStart();
        this.setStatus("idle", `${this.options.kind} adapter is ready.`);
      } else {
        await super.start();
      }
    } catch (err) {
      await this.disconnectRpcClient();
      await this.stopAppServer();
      throw err;
    }
  }

  protected buildSpawnArgs(): string[] {
    if (!this.appServerPort) {
      throw new Error("Codex app-server is not ready.");
    }

    return buildCodexCliArgs(`ws://${CODEX_APP_SERVER_HOST}:${this.appServerPort}`, {
      inlineMode: this.options.renderMode !== "panel",
      profile: this.options.profile,
      extraCliArgs: this.options.extraCliArgs,
    });
  }

  protected override afterStart(): void {
    this.warmupUntilMs = this.usesRpcTurnTransport()
      ? 0
      : Date.now() + CODEX_STARTUP_WARMUP_MS;
    if (this.isEmbeddedCliMode()) {
      this.attachLocalInputForwarding();
    }
    this.startSessionPolling();
  }

  override async sendInput(text: string): Promise<void> {
    if (this.usesDesktopTransport()) {
      await this.sendDesktopTurn(text);
      return;
    }
    if (this.usesRpcTurnTransport()) {
      await this.sendPanelTurn(text);
      return;
    }

    if (!this.pty) {
      throw new Error("codex adapter is not running.");
    }
    if (this.state.status === "busy") {
      throw new Error("codex is still working. Wait for the current reply or use /stop.");
    }
    if (this.pendingApproval) {
      throw new Error("Codex 有操作等待确认，请回复 1 允许本次，回复 2 拒绝，或回复 3 本任务始终允许。");
    }
    if (this.startupBlocker) {
      throw new Error("Codex is waiting for local terminal input before the session can continue.");
    }

    await delay(this.warmupUntilMs - Date.now());
    if (!this.pty) {
      throw new Error("codex adapter is not running.");
    }
    if (this.startupBlocker) {
      throw new Error("Codex is waiting for local terminal input before the session can continue.");
    }

    this.clearInterruptTimer();
    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.rememberInjectedInput(text);
    this.setStatus("busy");
    this.state.activeTurnOrigin = "wechat";
    await this.typeIntoPty(text.replace(/\r?\n/g, "\r"));
    await delay(40);
    this.writeToPty("\r");
  }

  async sendInputToSession(
    threadId: string,
    text: string,
  ): Promise<BridgeSessionSendResult> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("请选择一个 Codex 任务。");
    }
    if (this.usesDesktopTransport()) {
      return await this.sendDesktopTurnToThread(normalizedThreadId, text);
    }
    if (normalizedThreadId !== this.sharedThreadId) {
      await this.resumeSession(normalizedThreadId);
    }
    await this.sendInput(text);
    return { queued: false };
  }

  async sendInputItemsToSession(
    threadId: string,
    items: BridgeTurnInputItem[],
  ): Promise<BridgeSessionSendResult> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("请选择一个 Codex 任务。");
    }
    const normalizedItems = items.flatMap((item): BridgeTurnInputItem[] => {
      if (item.type === "text") {
        return item.text.trim() ? [{ type: "text", text: item.text }] : [];
      }
      if (item.type === "localImage") {
        return item.path.trim()
          ? [{ type: "localImage", path: item.path.trim() }]
          : [];
      }
      return item.url.trim() ? [{ type: "image", url: item.url.trim() }] : [];
    });
    if (normalizedItems.length === 0) {
      throw new Error("请输入文字或添加图片。");
    }
    if (!this.usesDesktopTransport()) {
      if (normalizedItems.some((item) => item.type !== "text")) {
        throw new Error("当前 Codex 连接暂不支持发送图片。");
      }
      return await this.sendInputToSession(
        normalizedThreadId,
        normalizedItems
          .filter((item): item is Extract<BridgeTurnInputItem, { type: "text" }> =>
            item.type === "text"
          )
          .map((item) => item.text)
          .join("\n"),
      );
    }
    return await this.sendDesktopTurnItemsToThread(normalizedThreadId, normalizedItems);
  }

  private overlayPersistedDesktopRuntimeStatuses(
    candidates: BridgeResumeSessionCandidate[],
  ): void {
    const candidatesToInspect = candidates
      .filter(
        (candidate) =>
          !candidate.runtimeStatus ||
          candidate.runtimeStatus.type === "notLoaded" ||
          (
            candidate.runtimeStatus.type === "active" &&
            candidate.runtimeStatus.activeFlags.length === 0
          ),
      )
      .slice(0, CODEX_DESKTOP_RUNTIME_STATUS_MAX_CANDIDATES);
    if (candidatesToInspect.length === 0) {
      return;
    }

    const sessionFilesByThreadId = new Map<
      string,
      { filePath: string; fileSize: number; modifiedAtMs: number }
    >();
    const unresolvedThreadIds: string[] = [];
    for (const candidate of candidatesToInspect) {
      const threadId = candidate.threadId ?? candidate.sessionId;
      const filePath = this.desktopThreadSessionFilePathById.get(threadId);
      if (!filePath) {
        unresolvedThreadIds.push(threadId);
        continue;
      }
      try {
        const stats = fs.statSync(filePath);
        sessionFilesByThreadId.set(threadId, {
          filePath,
          fileSize: stats.size,
          modifiedAtMs: stats.mtimeMs,
        });
      } catch {
        unresolvedThreadIds.push(threadId);
      }
    }
    for (const [threadId, sessionFile] of
      findCodexDesktopSessionFilesByThreadId(unresolvedThreadIds)) {
      sessionFilesByThreadId.set(threadId, sessionFile);
    }
    const now = Date.now();

    for (const candidate of candidatesToInspect) {
      const useAsFallback =
        !candidate.runtimeStatus || candidate.runtimeStatus.type === "notLoaded";
      const canReconcileStaleActive =
        candidate.runtimeStatus?.type === "active" &&
        candidate.runtimeStatus.activeFlags.length === 0;
      if (!useAsFallback && !canReconcileStaleActive) {
        continue;
      }

      const threadId = candidate.threadId ?? candidate.sessionId;
      const sessionFile = sessionFilesByThreadId.get(threadId);
      if (!sessionFile) {
        continue;
      }
      this.desktopThreadSessionFilePathById.set(threadId, sessionFile.filePath);

      const applyInferredStatus = (
        runtimeStatus: BridgeResumeSessionRuntimeStatus,
        modifiedAtMs: number,
      ): void => {
        if (useAsFallback) {
          candidate.runtimeStatus = runtimeStatus;
          return;
        }
        if (runtimeStatus.type !== "idle") {
          return;
        }
        const desktopState = this.getDesktopThreadStateView(threadId);
        const desktopUpdatedAtMs = desktopState
          ? codexTimestampToMs(desktopState.updatedAt)
          : undefined;
        const hasPendingDesktopRequest = Boolean(
          desktopState &&
          Array.isArray(desktopState.requests) &&
          desktopState.requests.length > 0,
        );
        if (
          desktopUpdatedAtMs !== undefined &&
          modifiedAtMs >= desktopUpdatedAtMs &&
          !hasPendingDesktopRequest
        ) {
          candidate.runtimeStatus = runtimeStatus;
        }
      };

      const cached = this.desktopThreadRuntimeStatusCache.get(threadId);
      if (
        cached?.filePath === sessionFile.filePath &&
        (now - cached.scannedAtMs < CODEX_DESKTOP_RUNTIME_STATUS_CACHE_TTL_MS ||
          (cached.fileSize === sessionFile.fileSize &&
            cached.modifiedAtMs === sessionFile.modifiedAtMs))
      ) {
        applyInferredStatus(cached.runtimeStatus, cached.modifiedAtMs);
        continue;
      }

      const inferred = readCodexDesktopRuntimeStatusFromSessionTail(
        sessionFile.filePath,
      );
      if (!inferred?.runtimeStatus) {
        continue;
      }

      if (
        cached?.filePath === sessionFile.filePath &&
        cached.fileSize === inferred.fileSize &&
        cached.modifiedAtMs === inferred.modifiedAtMs
      ) {
        cached.scannedAtMs = now;
        applyInferredStatus(cached.runtimeStatus, cached.modifiedAtMs);
        continue;
      }

      this.desktopThreadRuntimeStatusCache.set(threadId, {
        filePath: sessionFile.filePath,
        fileSize: inferred.fileSize,
        modifiedAtMs: inferred.modifiedAtMs,
        scannedAtMs: now,
        runtimeStatus: inferred.runtimeStatus,
      });
      applyInferredStatus(inferred.runtimeStatus, inferred.modifiedAtMs);
    }
  }

  override async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    try {
      const stateCatalog = await readCodexStateDbSessionCatalog({ limit });
      let candidates: BridgeResumeSessionCandidate[];
      const databaseProjectIds = new Map<string, string>();
      if (stateCatalog) {
        candidates = stateCatalog.candidates;
        for (const candidate of candidates) {
          if (candidate.projectId) {
            databaseProjectIds.set(candidate.sessionId, candidate.projectId);
            this.desktopThreadAppServerProjectIdById.set(
              candidate.sessionId,
              candidate.projectId,
            );
          }
        }
        for (const [threadId, rolloutPath] of stateCatalog.rolloutPathByThreadId) {
          this.desktopThreadSessionFilePathById.set(threadId, rolloutPath);
        }
      } else {
        if (this.usesDesktopTransport() && !this.isRpcSocketOpen()) {
          return [];
        }
        const response = await this.sendRpcRequest("thread/list", {
          sourceKinds: ["vscode"],
          archived: false,
          limit,
          useStateDbOnly: true,
          sortKey: "recency_at",
          sortDirection: "desc",
        });
        candidates = mapCodexDesktopThreadListResponse(response, limit);
      }
      applyCodexDesktopProjectMetadata(candidates, this.readDesktopGlobalState());
      for (const candidate of candidates) {
        if (!candidate.projectId) {
          const databaseProjectId = databaseProjectIds.get(candidate.sessionId);
          if (databaseProjectId) candidate.projectId = databaseProjectId;
        }
        if (candidate.cwd) {
          this.desktopThreadCwdById.set(candidate.sessionId, candidate.cwd);
        }
        const desktopState = this.getDesktopThreadStateView(candidate.sessionId);
        if (desktopState) {
          candidate.runtimeStatus = this.mapDesktopConversationRuntimeStatus(desktopState);
        }
      }
      this.overlayPersistedDesktopRuntimeStatuses(candidates);
      for (const candidate of candidates) {
        if (candidate.runtimeStatus) {
          this.desktopListedRuntimeStatusByThreadId.set(
            candidate.sessionId,
            candidate.runtimeStatus,
          );
        }
      }
      return candidates;
    } catch (error) {
      throw new Error(
        `无法读取 Codex 桌面端任务列表：${describeUnknownError(error)}`,
        { cause: error },
      );
    }
  }

  private mapDesktopConversationRuntimeStatus(
    state: CodexDesktopConversationState,
  ): BridgeResumeSessionRuntimeStatus {
    if (!isRecord(state.threadRuntimeStatus)) {
      return { type: "notLoaded" };
    }
    const type = typeof state.threadRuntimeStatus.type === "string"
      ? state.threadRuntimeStatus.type
      : "notLoaded";
    if (type === "idle") {
      return { type: "idle" };
    }
    if (type === "systemError") {
      return { type: "systemError" };
    }
    if (type !== "active") {
      return { type: "notLoaded" };
    }

    const rawFlags = Array.isArray(state.threadRuntimeStatus.activeFlags)
      ? state.threadRuntimeStatus.activeFlags
      : [];
    const flags: Array<"waitingOnApproval" | "waitingOnUserInput"> = [];
    if (rawFlags.includes("waitingOnApproval")) {
      flags.push("waitingOnApproval");
    }
    if (rawFlags.includes("waitingOnUserInput")) {
      flags.push("waitingOnUserInput");
    }
    if (Array.isArray(state.requests)) {
      if (
        state.requests.some(
          (request) =>
            isRecord(request) &&
            request.method === "item/tool/requestUserInput",
        ) &&
        !flags.includes("waitingOnUserInput")
      ) {
        flags.push("waitingOnUserInput");
      }
      if (
        state.requests.some(
          (request) =>
            isRecord(request) &&
            typeof request.method === "string" &&
            (
              request.method.endsWith("/requestApproval") ||
              request.method === "mcpServer/elicitation/request"
            ),
        ) &&
        !flags.includes("waitingOnApproval")
      ) {
        flags.push("waitingOnApproval");
      }
    }
    return { type: "active", activeFlags: flags };
  }

  async renameSession(threadId: string, title: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    const normalizedTitle = title.trim();
    if (!normalizedThreadId) {
      throw new Error("请选择一个 Codex 任务。");
    }
    if (!normalizedTitle) {
      throw new Error("任务名不能为空。");
    }
    await this.sendRpcRequest("thread/name/set", {
      threadId: normalizedThreadId,
      name: normalizedTitle,
    });
  }

  override async resumeSession(threadId: string): Promise<void> {
    if (this.usesDesktopTransport()) {
      await this.resumeDesktopThread(threadId);
      return;
    }
    const cwd = await this.resolveDesktopThreadCwd(threadId);
    await this.resumeSharedThread(threadId, { cwd });
  }

  async createSession(): Promise<void> {
    if (!this.usesDesktopTransport()) {
      if (this.state.status === "busy" || this.state.status === "awaiting_approval") {
        throw new Error("Codex 正在处理当前任务，请先等待完成或停止。");
      }
      this.updateSharedThread(null);
      await this.ensureThreadStarted();
      return;
    }

    await this.createDesktopSession(this.options.cwd);
  }

  async createSessionInProject(sourceSessionId: string): Promise<void> {
    if (!this.usesDesktopTransport()) {
      throw new Error("当前 Codex 连接暂不支持在指定项目中新建任务。");
    }
    const cwd = await this.resolveDesktopThreadCwd(sourceSessionId);
    const projectId = this.resolveDesktopThreadAppServerProjectId(sourceSessionId);
    await this.createDesktopSession(cwd, projectId ?? undefined);
  }

  private resolveDesktopThreadAppServerProjectId(threadId: string): string | null {
    const normalizedThreadId = threadId.trim();
    const knownProjectId = this.desktopThreadAppServerProjectIdById.get(normalizedThreadId);
    if (knownProjectId) {
      return knownProjectId;
    }
    const target = resolveCodexDesktopProjectCreationTarget(
      this.readDesktopGlobalState(),
      normalizedThreadId,
      path.dirname(this.getDesktopGlobalStateFilePath()),
      this.desktopThreadCwdById.get(normalizedThreadId),
    );
    if (!target) {
      return null;
    }
    if (!target.appServerProjectId) {
      throw new Error(
        "Codex 桌面端尚未完成这个项目的索引同步，请先在 Codex 中打开该项目后重试。",
      );
    }
    this.desktopThreadAppServerProjectIdById.set(
      normalizedThreadId,
      target.appServerProjectId,
    );
    return target.appServerProjectId;
  }

  private async createDesktopSession(cwd: string, projectId?: string): Promise<void> {
    const permissionSettings = this.resolveDesktopPermissionSettings();
    const response = await this.sendRpcRequest(
      "thread/start",
      {
        cwd,
        ...(projectId ? { projectId } : {}),
        approvalPolicy: permissionSettings.approvalPolicy,
        approvalsReviewer: permissionSettings.approvalsReviewer,
        sandbox: permissionSettings.sandbox,
        serviceName: "werelay-bridge",
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      },
      { allowDesktopBootstrapWrite: true },
    );
    const threadId = this.extractThreadIdFromResponse(response);
    if (!threadId) {
      throw new Error("Codex 没有返回新任务编号，请稍后重试。");
    }

    this.desktopThreadCwdById.set(threadId, cwd);
    if (projectId) {
      this.desktopThreadAppServerProjectIdById.set(threadId, projectId);
    }
    this.desktopBootstrapThreadIds.add(threadId);
    if (this.activeTurn) {
      this.moveActiveTurnToBackground();
    }
    this.rememberBridgeOwnedThreadSignal(threadId);
    this.subscribedThreadIds.add(threadId);
    this.updateSharedThread(threadId, {
      source: "wechat",
      reason: "wechat_resume",
      notify: true,
    });
    await this.tryHandoffDesktopBootstrapThread(threadId, 1_200);
    this.syncSelectedThreadState();
  }

  private async tryHandoffDesktopBootstrapThread(
    threadId: string,
    timeoutMs = 1_200,
    options: { restoreBootstrapOnFailure?: boolean } = {},
  ): Promise<boolean> {
    if (!this.desktopBootstrapThreadIds.has(threadId)) return true;
    const client = this.desktopIpcClient;
    if (!client) return false;
    // A freshly started task does not have a rollout file until its first turn
    // begins. Releasing the bootstrap writer before that point makes both
    // Desktop follow and app-server resume fail with "no rollout found", even
    // though thread/start already returned a valid canonical task id.
    if (!this.resolveDesktopSessionFilePath(threadId)) return false;

    // thread/start makes the private metadata app-server the active writer.
    // Release that writer before asking Codex Desktop to resume the task;
    // doing this in the opposite order makes Desktop report that the task is
    // already open in another application and leaves the bootstrap owner stuck.
    try {
      await this.sendRpcRequest(
        "thread/unsubscribe",
        { threadId },
        { allowDesktopBootstrapWrite: true },
      );
    } catch {
      return false;
    }

    await delay(this.desktopBootstrapHandoffDelayMs);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await client.openAndFollowThread(threadId, { timeoutMs });
        this.desktopBootstrapThreadIds.delete(threadId);
        return true;
      } catch {
        if (attempt === 0) await delay(this.desktopBootstrapHandoffDelayMs);
      }
    }

    if (options.restoreBootstrapOnFailure === false) {
      try {
        await this.sendRpcRequest(
          "thread/unsubscribe",
          { threadId },
          { allowDesktopBootstrapWrite: true },
        );
      } catch {
        // The bootstrap writer may already be released.
      }
      return false;
    }

    try {
      const cwd = this.getKnownThreadCwd(threadId);
      const permissionSettings = this.resolveDesktopPermissionSettings(threadId);
      const response = await this.sendRpcRequest(
        "thread/resume",
        {
          threadId,
          cwd,
          approvalPolicy: permissionSettings.approvalPolicy,
          approvalsReviewer: permissionSettings.approvalsReviewer,
          sandbox: permissionSettings.sandbox,
          excludeTurns: true,
        },
        { allowDesktopBootstrapWrite: true },
      );
      const resumedThreadId = this.extractThreadIdFromResponse(response);
      if (!resumedThreadId || resumedThreadId !== threadId) {
        throw new Error("Codex did not restore the bootstrap task writer.");
      }
      this.subscribedThreadIds.add(threadId);
      return false;
    } catch (restoreError) {
      const message = describeUnknownError(restoreError);
      if (message.includes("active writer")) {
        this.desktopBootstrapThreadIds.delete(threadId);
        return true;
      }
      throw restoreError;
    }
  }

  private continueDesktopTaskAfterTurn(threadId: string): void {
    if (!this.desktopBootstrapThreadIds.has(threadId)) {
      this.scheduleDesktopQueuedFollowUpDrain(threadId);
      return;
    }
    void this.waitForDesktopBootstrapRollout(threadId)
      .then((rolloutReady) => rolloutReady
        ? this.tryHandoffDesktopBootstrapThread(threadId, 1_200, {
            restoreBootstrapOnFailure: false,
          })
        : false)
      .catch(() => false)
      .finally(() => this.scheduleDesktopQueuedFollowUpDrain(threadId));
  }

  private async waitForDesktopBootstrapRollout(threadId: string): Promise<boolean> {
    const deadline = Date.now() + CODEX_DESKTOP_BOOTSTRAP_ROLLOUT_WAIT_MS;
    while (this.desktopBootstrapThreadIds.has(threadId)) {
      if (this.resolveDesktopSessionFilePath(threadId)) return true;
      if (Date.now() >= deadline) return false;
      await delay(CODEX_DESKTOP_BOOTSTRAP_ROLLOUT_POLL_MS);
    }
    return false;
  }

  async followSession(threadId: string): Promise<void> {
    if (!this.usesDesktopTransport()) {
      return;
    }
    await this.desktopIpcClient?.followThread(threadId, { retention: "summary" });
  }

  async unfollowSession(threadId: string): Promise<void> {
    if (!this.usesDesktopTransport()) {
      return;
    }
    await this.desktopIpcClient?.unfollowThread(threadId);
  }

  private getDesktopThreadStateView(
    threadId: string,
  ): CodexDesktopConversationState | null {
    const client = this.desktopIpcClient;
    if (!client) {
      return null;
    }
    const clientWithView = client as CodexDesktopIpcClient & {
      getThreadStateView?: (candidateThreadId: string) => CodexDesktopConversationState | null;
    };
    return clientWithView.getThreadStateView?.(threadId) ?? client.getThreadState?.(threadId) ?? null;
  }

  private async getDesktopThreadStateViewWithRefresh(
    threadId: string,
  ): Promise<CodexDesktopConversationState | null> {
    const client = this.desktopIpcClient;
    if (!client) {
      return null;
    }
    const cached = this.getDesktopThreadStateView(threadId);
    if (cached) {
      return cached;
    }
    try {
      await client.followThread(threadId, { retention: "summary" });
    } catch {
      return null;
    }
    return this.getDesktopThreadStateView(threadId);
  }

  private resolveDesktopSessionFilePath(threadId: string): string | null {
    const remembered = this.desktopThreadSessionFilePathById.get(threadId);
    if (remembered && fs.existsSync(remembered)) {
      return remembered;
    }
    if (remembered) {
      this.desktopThreadSessionFilePathById.delete(threadId);
    }

    const runtimeStatusFile = this.desktopThreadRuntimeStatusCache.get(threadId)?.filePath;
    if (runtimeStatusFile && fs.existsSync(runtimeStatusFile)) {
      this.desktopThreadSessionFilePathById.set(threadId, runtimeStatusFile);
      return runtimeStatusFile;
    }

    const discovered = findCodexDesktopSessionFilesByThreadId([threadId])
      .get(threadId)?.filePath ?? null;
    if (discovered) {
      this.desktopThreadSessionFilePathById.set(threadId, discovered);
    }
    return discovered;
  }

  getSessionContentRevision(threadId: string): string | null {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) return null;
    const parts: string[] = [];
    const filePath = this.resolveDesktopSessionFilePath(normalizedThreadId);
    if (filePath) {
      try {
        const stat = fs.statSync(filePath);
        parts.push(
          `rollout:${stat.size.toString(36)}:${Math.trunc(stat.mtimeMs).toString(36)}`,
        );
      } catch {
        // The desktop can rotate a rollout between catalog refreshes.
      }
    }
    const desktopRevision = this.desktopIpcClient?.getThreadRevision(normalizedThreadId);
    if (typeof desktopRevision === "number") {
      parts.push(`desktop:${desktopRevision.toString(36)}`);
    }
    return parts.length > 0 ? parts.join(".") : null;
  }

  async getLatestSessionMessage(threadId: string): Promise<BridgeSessionMessage | null> {
    const page = await this.getSessionMessagePage(threadId, { limit: 1 });
    const latest = page.messages[page.messages.length - 1];
    return latest ? { ...latest } : null;
  }

  async getSessionRunSummary(
    threadId: string,
    options: BridgeSessionReadOptions = {},
  ): Promise<BridgeSessionRunSummary | null> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      return null;
    }
    const rolloutFilePath = this.resolveDesktopSessionFilePath(normalizedThreadId);
    const rolloutSummary = rolloutFilePath
      ? readCodexSessionRunSummaryFromRolloutTail(rolloutFilePath)
      : null;
    const client = this.desktopIpcClient;
    let liveState: CodexDesktopConversationState | null = null;
    if (client) {
      liveState = options.lightweight
        ? this.getDesktopThreadStateView(normalizedThreadId)
        : await this.getDesktopThreadStateViewWithRefresh(normalizedThreadId);
      if (liveState) {
        const nowMs = Date.now();
        const liveWithoutObservedStart = extractCodexDesktopThreadRunSummary(
          liveState,
          rolloutSummary,
          nowMs,
        );
        if (liveWithoutObservedStart) {
          const observedStartedAtMs = liveWithoutObservedStart.turnId
            ? this.turnStartedAtMs.get(liveWithoutObservedStart.turnId)
            : undefined;
          return extractCodexDesktopThreadRunSummary(
            liveState,
            rolloutSummary,
            nowMs,
            observedStartedAtMs,
          );
        }
      }
    }
    if (rolloutSummary) {
      return rolloutSummary;
    }
    if (options.lightweight) {
      return null;
    }
    const response = await this.sendRpcRequest("thread/read", {
      threadId: normalizedThreadId,
      includeTurns: true,
    });
    const persisted = extractCodexThreadRunSummary(response);
    if (!client) {
      return persisted;
    }
    if (!liveState) {
      liveState = await this.getDesktopThreadStateViewWithRefresh(
        normalizedThreadId,
      );
    }
    if (!liveState) {
      return persisted;
    }
    const nowMs = Date.now();
    const liveWithoutObservedStart = extractCodexDesktopThreadRunSummary(
      liveState,
      persisted,
      nowMs,
    );
    const observedStartedAtMs = liveWithoutObservedStart?.turnId
      ? this.turnStartedAtMs.get(liveWithoutObservedStart.turnId)
      : undefined;
    return extractCodexDesktopThreadRunSummary(
      liveState,
      persisted,
      nowMs,
      observedStartedAtMs,
    );
  }

  async getSessionMessageMedia(
    threadId: string,
    options: BridgeSessionMessagePageOptions = {},
    targetMessages: BridgeSessionMessage[] = [],
  ): Promise<BridgeSessionMessage[]> {
    const filePath = this.resolveDesktopSessionFilePath(threadId.trim());
    if (!filePath) return [];
    const imageCacheDir = path.join(
      ensureWorkspaceChannelDir(this.options.cwd).workspaceDir,
      "message-images",
      "codex",
    );
    const targetUserCounts = new Map<string, number>();
    for (const message of targetMessages) {
      if (message.role !== "user") continue;
      const key = normalizeCodexMediaTargetText(message.text);
      targetUserCounts.set(key, (targetUserCounts.get(key) ?? 0) + 1);
    }

    const usesNativeCursor = typeof options.before === "string" &&
      options.before.startsWith("byte:");
    let before = usesNativeCursor ? options.before : undefined;
    const collected: BridgeSessionMessage[] = [];
    const batchLimit = Math.max(100, Math.min(250, options.limit ?? 100));
    let scannedBytes = 0;
    let currentEnd = before
      ? decodeCodexSessionMessageByteCursor(before)
      : (() => {
          try {
            return fs.statSync(filePath).size;
          } catch {
            return null;
          }
        })();
    for (let scanned = 0; scanned < 2_000 && scannedBytes < CODEX_SESSION_MEDIA_SCAN_LIMIT_BYTES;) {
      const page = readCodexSessionMessagePageFromRollout(filePath, {
        ...options,
        ...(before ? { before } : { before: undefined }),
        limit: batchLimit,
        lightweight: true,
        imageCacheDir,
      });
      if (!page) break;
      scanned += page.messages.length;
      collected.unshift(...page.messages);
      for (const message of page.messages) {
        if (message.role !== "user") continue;
        const key = normalizeCodexMediaTargetText(message.text);
        const remaining = targetUserCounts.get(key) ?? 0;
        if (remaining <= 1) targetUserCounts.delete(key);
        else targetUserCounts.set(key, remaining - 1);
      }
      const nextEnd = page.nextBefore
        ? decodeCodexSessionMessageByteCursor(page.nextBefore)
        : null;
      if (currentEnd !== null && nextEnd !== null && nextEnd <= currentEnd) {
        scannedBytes += currentEnd - nextEnd;
      }
      if (targetUserCounts.size === 0 || !page.hasMore || !page.nextBefore) break;
      if (scannedBytes >= CODEX_SESSION_MEDIA_SCAN_LIMIT_BYTES) break;
      before = page.nextBefore;
      currentEnd = nextEnd;
    }
    return collected.filter((message) => Boolean(message.images?.length));
  }

  async getSessionMessagePage(
    threadId: string,
    options: BridgeSessionMessagePageOptions = {},
  ): Promise<BridgeSessionMessagePage> {
    const normalizedThreadId = threadId.trim();
    const trackedTurn = this.activeTurn?.threadId === normalizedThreadId
      ? this.activeTurn
      : this.getBackgroundTurnForThread(normalizedThreadId);
    const preferredTurnId = trackedTurn?.turnId;
    const usesIndexCursor = typeof options.before === "string" &&
      options.before.startsWith("index:");
    if (!usesIndexCursor) {
      const filePath = this.resolveDesktopSessionFilePath(normalizedThreadId);
      if (filePath) {
        const persistedPage = readCodexSessionMessagePageFromRollout(
          filePath,
          {
            ...options,
            imageCacheDir: path.join(
              ensureWorkspaceChannelDir(this.options.cwd).workspaceDir,
              "message-images",
              "codex",
            ),
          },
        );
        if (persistedPage) {
          if (options.before || options.historyOnly) {
            return persistedPage;
          }
          const client = this.desktopIpcClient;
          if (!client) {
            return persistedPage;
          }
          const liveState = options.lightweight
            ? this.getDesktopThreadStateView(normalizedThreadId)
            : await this.getDesktopThreadStateViewWithRefresh(normalizedThreadId);
          return liveState
            ? {
                ...persistedPage,
                messages: mergeCodexSessionMessages(
                  persistedPage.messages,
                  extractCodexDesktopThreadMessages(liveState, preferredTurnId),
                ),
              }
            : persistedPage;
        }
      }
      if (typeof options.before === "string" && options.before.startsWith("byte:")) {
        throw new Error("Codex 历史消息文件暂时不可读，请稍后重试。");
      }
    }

    if (options.lightweight) {
      const liveState = this.getDesktopThreadStateView(normalizedThreadId);
      return liveState
        ? paginateCodexSessionMessages(
            extractCodexDesktopThreadMessages(liveState, preferredTurnId),
            options,
          )
        : { messages: [], hasMore: false, nextBefore: null };
    }

    const messages = await this.getSessionMessages(normalizedThreadId);
    return paginateCodexSessionMessages(messages, options);
  }

  async getSessionProgress(
    threadId: string,
    options: BridgeSessionReadOptions = {},
  ): Promise<BridgeSessionProgressItem[]> {
    const normalizedThreadId = threadId.trim();
    const rolloutFilePath = this.resolveDesktopSessionFilePath(normalizedThreadId);
    const rolloutProgress = rolloutFilePath
      ? readCodexSessionProgressFromRolloutTail(rolloutFilePath)
      : [];
    const client = this.desktopIpcClient;
    if (client) {
      const liveState = options.lightweight
        ? this.getDesktopThreadStateView(normalizedThreadId)
        : await this.getDesktopThreadStateViewWithRefresh(normalizedThreadId);
      if (liveState) {
        const liveProgress = extractCodexDesktopThreadProgress(liveState);
        if (liveProgress.length > 0) {
          return mergeCodexSessionProgress(rolloutProgress, liveProgress);
        }
      }
    }
    if (rolloutFilePath && (rolloutProgress.length > 0 || options.lightweight)) {
      return rolloutProgress;
    }
    if (options.lightweight) {
      return [];
    }
    const response = await this.sendRpcRequest("thread/read", {
      threadId: normalizedThreadId,
      includeTurns: true,
    });
    return extractCodexThreadProgress(response);
  }

  async getSessionMessages(threadId: string): Promise<BridgeSessionMessage[]> {
    const normalizedThreadId = threadId.trim();
    const response = await this.sendRpcRequest("thread/read", {
      threadId: normalizedThreadId,
      includeTurns: true,
    });
    const persisted = extractCodexThreadMessages(response);
    const client = this.desktopIpcClient;
    if (!client) {
      return persisted;
    }

    const liveState = this.getDesktopThreadStateView(normalizedThreadId);
    const trackedTurn = this.activeTurn?.threadId === normalizedThreadId
      ? this.activeTurn
      : this.getBackgroundTurnForThread(normalizedThreadId);
    return liveState
      ? mergeCodexSessionMessages(
          persisted,
          extractCodexDesktopThreadMessages(liveState, trackedTurn?.turnId),
        )
      : persisted;
  }

  async getSessionModelState(threadId: string): Promise<BridgeSessionModelState> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("请选择一个 Codex 任务。");
    }
    if (!this.usesDesktopTransport()) {
      const latestMessage = await this.getLatestSessionMessage(normalizedThreadId);
      const currentModel = latestMessage?.model;
      return {
        ...(currentModel ? { currentModel } : {}),
        options: currentModel ? [{ id: currentModel }] : [],
        canChange: false,
        unavailableReason: "当前 Codex 连接暂不支持从网页版切换模型。",
      };
    }

    const liveState = this.getDesktopThreadStateView(normalizedThreadId) ??
      await this.getDesktopThreadStateViewWithRefresh(normalizedThreadId);
    const reconciliation = this.reconcilePersistedDesktopCompletion(
      normalizedThreadId,
      liveState,
    );
    const persistedTerminalIsCurrent = Boolean(
      reconciliation.terminalTurnId &&
      (!reconciliation.liveStateActive ||
        reconciliation.liveSummary?.turnId === reconciliation.terminalTurnId),
    );
    const selectedModel = this.selectedDesktopModelByThreadId.get(normalizedThreadId);
    const liveModel = extractCodexDesktopSessionModel(liveState);
    const latestMessageModel = selectedModel || liveModel
      ? undefined
      : (await this.getLatestSessionMessage(normalizedThreadId))?.model;
    const currentModel = selectedModel ?? liveModel ?? latestMessageModel;
    let options: BridgeSessionModelOption[] = [];
    let modelListError = false;
    try {
      options = mapCodexModelListResponse(
        await this.sendRpcRequest("model/list", {
          limit: 100,
          includeHidden: false,
        }),
      );
    } catch {
      modelListError = true;
    }
    if (currentModel && !options.some((option) => option.id === currentModel)) {
      options.unshift({ id: currentModel });
    }
    const selectedReasoningEffort = this.selectedDesktopReasoningEffortByThreadId.get(
      normalizedThreadId,
    );
    const liveReasoningEffort = extractCodexDesktopSessionReasoningEffort(liveState);
    const currentModelOption = options.find((option) => option.id === currentModel);
    const reasoningEffortOptions = currentModelOption?.reasoningEffortOptions ?? [];
    const reportedReasoningEffort = selectedReasoningEffort ?? liveReasoningEffort;
    const currentReasoningEffort = reportedReasoningEffort && (
        reasoningEffortOptions.length === 0 ||
        reasoningEffortOptions.some((option) => option.id === reportedReasoningEffort)
      )
      ? reportedReasoningEffort
      : undefined;
    const listedRuntimeStatus = this.desktopListedRuntimeStatusByThreadId.get(
      normalizedThreadId,
    );
    const taskRunning = !persistedTerminalIsCurrent && (
      codexDesktopRuntimeType(liveState) === "active" ||
      listedRuntimeStatus?.type === "active" ||
      this.pendingDesktopTurnThreadIds.has(normalizedThreadId) ||
      this.activeTurn?.threadId === normalizedThreadId ||
      Array.from(this.backgroundTurns.values()).some(
        (turn) => turn.threadId === normalizedThreadId,
      )
    );
    return {
      ...(currentModel ? { currentModel } : {}),
      options,
      canChange: !taskRunning && !modelListError && options.length > 0,
      ...(currentReasoningEffort ? { currentReasoningEffort } : {}),
      ...(reasoningEffortOptions.length > 0 ? { reasoningEffortOptions } : {}),
      ...(reasoningEffortOptions.length > 0
        ? {
            canChangeReasoningEffort: !taskRunning && !modelListError,
            ...(taskRunning
              ? { reasoningEffortUnavailableReason: "任务正在处理，完成或停止后再切换推理强度。" }
              : modelListError
                ? { reasoningEffortUnavailableReason: "暂时无法读取 Codex 可用推理强度。" }
                : {}),
          }
        : {}),
      ...(taskRunning
        ? { unavailableReason: "任务正在处理，完成或停止后再切换模型。" }
        : modelListError || options.length === 0
          ? { unavailableReason: "暂时无法读取 Codex 可用模型。" }
          : {}),
    };
  }

  async setSessionModel(
    threadId: string,
    model: string,
  ): Promise<BridgeSessionModelState> {
    const normalizedThreadId = threadId.trim();
    const normalizedModel = model.trim();
    if (!normalizedThreadId) throw new Error("请选择一个 Codex 任务。");
    if (!normalizedModel) throw new Error("请选择一个模型。");
    const state = await this.getSessionModelState(normalizedThreadId);
    if (!state.canChange) {
      throw new Error(state.unavailableReason || "当前任务暂时不能切换模型。");
    }
    if (!state.options.some((option) => option.id === normalizedModel)) {
      throw new Error("这个模型当前不可用，请重新选择。");
    }
    this.selectedDesktopModelByThreadId.set(normalizedThreadId, normalizedModel);
    const selectedOption = state.options.find((option) => option.id === normalizedModel);
    const reasoningOptions = selectedOption?.reasoningEffortOptions ?? [];
    const currentEffort = state.currentReasoningEffort;
    const nextEffort = currentEffort && reasoningOptions.some((option) => option.id === currentEffort)
      ? currentEffort
      : undefined;
    if (nextEffort) {
      this.selectedDesktopReasoningEffortByThreadId.set(normalizedThreadId, nextEffort);
    } else {
      this.selectedDesktopReasoningEffortByThreadId.delete(normalizedThreadId);
    }
    const nextState: BridgeSessionModelState = {
      ...state,
      currentModel: normalizedModel,
      reasoningEffortOptions: reasoningOptions,
      canChangeReasoningEffort: state.canChange && reasoningOptions.length > 0,
      ...(reasoningOptions.length === 0
        ? { reasoningEffortUnavailableReason: "当前模型没有提供可选推理强度。" }
        : { reasoningEffortUnavailableReason: undefined }),
    };
    if (nextEffort) {
      nextState.currentReasoningEffort = nextEffort;
    } else {
      delete nextState.currentReasoningEffort;
    }
    return nextState;
  }

  async setSessionReasoningEffort(
    threadId: string,
    reasoningEffort: string,
  ): Promise<BridgeSessionModelState> {
    const normalizedThreadId = threadId.trim();
    const normalizedEffort = reasoningEffort.trim();
    if (!normalizedThreadId) throw new Error("请选择一个 Codex 任务。");
    if (!normalizedEffort) throw new Error("请选择推理强度。");
    const state = await this.getSessionModelState(normalizedThreadId);
    if (!state.canChangeReasoningEffort) {
      throw new Error(
        state.reasoningEffortUnavailableReason || "当前任务暂时不能切换推理强度。",
      );
    }
    if (!state.reasoningEffortOptions?.some((option) => option.id === normalizedEffort)) {
      throw new Error("这个推理强度当前不可用，请重新选择。");
    }
    this.selectedDesktopReasoningEffortByThreadId.set(normalizedThreadId, normalizedEffort);
    return { ...state, currentReasoningEffort: normalizedEffort };
  }

  async interruptSession(threadId: string): Promise<boolean> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      return false;
    }
    if (this.usesDesktopTransport()) {
      return await this.interruptDesktopThread(normalizedThreadId);
    }
    if (normalizedThreadId !== this.sharedThreadId) {
      return false;
    }
    return await this.interrupt();
  }

  override async interrupt(): Promise<boolean> {
    if (this.usesDesktopTransport()) {
      return await this.interruptDesktopTurn();
    }
    if (this.usesRpcTurnTransport()) {
      return await this.interruptPanelTurn();
    }

    if (!this.pty) {
      return false;
    }

    if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
      return false;
    }

    this.clearPendingApprovalState();
    this.writeToPty("\u0003");
    this.armInterruptFallback();
    return true;
  }

  override async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    return await this.resolveApprovalAction(action);
  }

  async resolveApprovalForSession(): Promise<boolean> {
    return await this.resolveApprovalAction("confirm_session");
  }

  override async resolveAllApprovals(action: "confirm" | "deny"): Promise<number> {
    return await this.resolveAllApprovalActions(action);
  }

  async resolveAllApprovalsForSession(): Promise<number> {
    return await this.resolveAllApprovalActions("confirm_session");
  }

  private async resolveApprovalAction(
    action: CodexApprovalResolutionAction,
  ): Promise<boolean> {
    if (this.pendingApprovalRequests.length > 0) {
      const threadId =
        this.sharedThreadId ?? this.pendingApprovalRequests[0]?.threadId ?? null;
      if (!threadId) {
        return false;
      }
      return (await this.resolveTaskApprovals(threadId, action)) > 0;
    }

    if (!this.pendingApproval) {
      return false;
    }
    return await super.resolveApproval(action === "deny" ? "deny" : "confirm");
  }

  private async resolveAllApprovalActions(
    action: CodexApprovalResolutionAction,
  ): Promise<number> {
    if (this.pendingApprovalRequests.length > 0) {
      const threadId =
        this.sharedThreadId ?? this.pendingApprovalRequests[0]?.threadId ?? null;
      return threadId ? await this.resolveTaskApprovals(threadId, action) : 0;
    }

    if (!this.pendingApproval) {
      return 0;
    }
    const ok = await super.resolveApproval(action === "deny" ? "deny" : "confirm");
    return ok ? 1 : 0;
  }

  async resolveTaskApprovals(
    threadId: string,
    action: CodexApprovalResolutionAction,
  ): Promise<number> {
    const requests = this.getPendingApprovalRequestsForThread(threadId);
    if (requests.length === 0) {
      return 0;
    }

    for (const request of requests) {
      await this.respondToApprovalRequest(request, action);
    }
    const requestIds = new Set(requests.map((request) => request.requestId));
    this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
      (request) => !requestIds.has(request.requestId),
    );
    this.syncSelectedThreadState(
      threadId === this.sharedThreadId ? "Codex approval resolved." : undefined,
    );
    return requests.length;
  }

  async resolveApprovalRequest(
    requestId: string,
    action: CodexApprovalResolutionAction,
  ): Promise<boolean> {
    const request = this.pendingApprovalRequests.find(
      (candidate) => String(candidate.requestId) === requestId,
    );
    if (!request) {
      return false;
    }

    await this.respondToApprovalRequest(request, action);
    this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
      (candidate) => candidate !== request,
    );
    this.syncSelectedThreadState(
      request.threadId === this.sharedThreadId ? "Codex approval resolved." : undefined,
    );
    return true;
  }

  getPendingTaskApprovals(threadId: string): ApprovalRequest[] {
    return this.getPendingApprovalRequestsForThread(threadId).map(
      (request) => ({ ...request.request }),
    );
  }

  override async submitUserInput(answers: Record<string, string[]>): Promise<boolean> {
    const threadId =
      this.sharedThreadId ?? this.pendingUserInputRequests[0]?.threadId ?? null;
    if (!threadId) {
      return false;
    }
    return await this.submitTaskUserInput(threadId, answers);
  }

  async submitTaskUserInput(
    threadId: string,
    answers: Record<string, string[]>,
  ): Promise<boolean> {
    const request = this.getPendingUserInputRequestsForThread(threadId)[0];
    if (!request) {
      return false;
    }

    const responseAnswers: Record<string, { answers: string[] }> = {};
    for (const [questionId, values] of Object.entries(answers)) {
      responseAnswers[questionId] = {
        answers: values,
      };
    }

    if (
      this.usesDesktopTransport() &&
      !this.desktopBootstrapThreadIds.has(request.threadId)
    ) {
      const client = this.desktopIpcClient;
      if (!client) {
        throw new Error("Codex 桌面端连接不可用。");
      }
      await client.submitUserInput(
        request.threadId,
        request.requestId,
        responseAnswers,
      );
    } else {
      this.sendRpcMessage({
        id: request.requestId,
        result: {
          answers: responseAnswers,
        },
      });
    }
    this.pendingUserInputRequests = this.pendingUserInputRequests.filter(
      (candidate) => candidate.requestId !== request.requestId,
    );
    this.syncSelectedThreadState(
      threadId === this.sharedThreadId ? "Codex user input submitted." : undefined,
    );
    return true;
  }

  override async dispose(): Promise<void> {
    this.resetTurnTracking({ preserveThread: false });
    if (this.isEmbeddedCliMode()) {
      this.detachLocalInputForwarding();
    }
    this.stopSessionPolling();
    if (this.usesDesktopTransport()) {
      this.desktopTransportStarted = false;
      await this.stopDesktopIpcClient();
    }
    if (this.isNativePanelMode()) {
      this.cleanPanelExitInProgress = true;
    }
    await this.disconnectRpcClient();
    if (this.isNativePanelMode()) {
      await this.stopNativeClient();
      this.clearCompletionTimer();
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      this.state.status = "stopped";
      this.state.pid = undefined;
      this.state.startedAt = undefined;
    } else if (this.isHeadlessRuntimeMode()) {
      this.clearCompletionTimer();
      this.clearInterruptTimer();
      this.clearPendingApprovalState();
      this.state.status = "stopped";
      this.state.pid = undefined;
      this.state.startedAt = undefined;
    } else {
      await super.dispose();
    }
    await this.stopAppServer();
  }

  getLocalClientEndpoint(): LocalClientEndpoint | null {
    if (
      this.usesDesktopTransport() ||
      !this.isHeadlessRuntimeMode() ||
      !this.appServerPort ||
      !this.appServerAuthToken
    ) {
      return null;
    }

    return {
      protocolVersion: LOCAL_CLIENT_PROTOCOL_VERSION,
      runtimeKind: this.runtimeKind,
      instanceId: this.localClientInstanceId,
      kind: this.options.kind,
      port: this.appServerPort,
      token: this.appServerAuthToken,
      renderMode: "headless",
      bridgeOwnerPid: process.pid,
      serverPort: this.appServerPort,
      serverUrl: `ws://${CODEX_APP_SERVER_HOST}:${this.appServerPort}`,
      remoteAuthTokenEnv: CODEX_REMOTE_AUTH_TOKEN_ENV,
      cwd: this.options.cwd,
      command: this.options.command,
      profile: this.options.profile,
      sharedSessionId: this.state.sharedSessionId,
      sharedThreadId: this.state.sharedThreadId,
      resumeConversationId: this.state.resumeConversationId,
      transcriptPath: this.state.transcriptPath,
      startedAt: this.state.startedAt ?? nowIso(),
    };
  }

  async getSessionPermissionState(
    threadId: string,
  ): Promise<BridgeSessionPermissionState> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error("请选择一个 Codex 任务。");
    const current = this.resolveDesktopPermissionSettings(normalizedThreadId).sandbox;
    const reconciliation = this.reconcilePersistedDesktopCompletion(
      normalizedThreadId,
    );
    const runSummary = await this.getSessionRunSummary(normalizedThreadId, {
      lightweight: true,
    });
    const persistedTerminalIsCurrent = Boolean(
      reconciliation.terminalTurnId &&
      (!reconciliation.liveStateActive ||
        reconciliation.liveSummary?.turnId === reconciliation.terminalTurnId),
    );
    return {
      currentPermission: current,
      options: CODEX_PERMISSION_OPTIONS.map((option) => ({ ...option })),
      canChange: true,
    };
  }

  async setSessionPermission(
    threadId: string,
    permission: string,
  ): Promise<BridgeSessionPermissionState> {
    const normalizedThreadId = threadId.trim();
    const normalizedPermission = permission.trim();
    if (!normalizedThreadId) throw new Error("请选择一个 Codex 任务。");
    const next = codexPermissionSettingsForMode(normalizedPermission);
    if (!next) throw new Error("这个 Codex 权限范围当前不可用。");
    const state = await this.getSessionPermissionState(normalizedThreadId);
    if (!state.canChange) {
      throw new Error(state.unavailableReason || "当前任务暂时不能切换权限范围。");
    }
    this.selectedDesktopPermissionByThreadId.set(normalizedThreadId, next);
    return {
      ...state,
      currentPermission: normalizedPermission,
    };
  }

  protected override handleData(rawText: string): void {
    this.renderLocalOutput(rawText);

    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    const approval = detectCliApproval(text);

    if (this.hasAcceptedInput) {
      if (approval && !this.pendingApproval) {
        this.pendingApproval = approval;
        this.state.pendingApproval = approval;
        this.state.pendingApprovalOrigin = this.state.activeTurnOrigin;
        this.setStatus("awaiting_approval", "Codex approval is required.");
        this.emit({
          type: "approval_required",
          request: approval,
          timestamp: nowIso(),
        });
      }
      return;
    }

    if (approval) {
      this.startupBlocker = approval.commandPreview;
      if (this.state.status !== "awaiting_approval") {
        this.setStatus("awaiting_approval", "Codex is waiting for local terminal input.");
      }
      return;
    }

    if (this.startupBlocker) {
      this.startupBlocker = null;
      if (this.state.status === "awaiting_approval") {
        this.setStatus("idle", "codex adapter is ready.");
      }
    }
  }

  protected override handleExit(exitCode: number | undefined): void {
    this.resetTurnTracking({ preserveThread: false });
    this.detachLocalInputForwarding();
    this.stopSessionPolling();
    void this.disconnectRpcClient();
    void this.stopAppServer();
    super.handleExit(exitCode);
  }

  private isNativePanelMode(): boolean {
    return this.options.renderMode === "panel";
  }

  private isHeadlessRuntimeMode(): boolean {
    return this.options.renderMode === "headless";
  }

  private usesDesktopTransport(): boolean {
    return (
      this.isHeadlessRuntimeMode() &&
      this.options.codexTransport === "desktop"
    );
  }

  private isEmbeddedCliMode(): boolean {
    return !this.isNativePanelMode() && !this.isHeadlessRuntimeMode();
  }

  private usesRpcTurnTransport(): boolean {
    return this.isNativePanelMode() || this.isHeadlessRuntimeMode();
  }

  private isCodexClientRunning(): boolean {
    if (this.usesDesktopTransport()) {
      return this.desktopTransportStarted;
    }
    if (this.isHeadlessRuntimeMode()) {
      return Boolean(this.appServer);
    }
    return this.isNativePanelMode() ? Boolean(this.nativeProcess) : Boolean(this.pty);
  }

  private shouldPollSessionLog(): boolean {
    return (
      this.isCodexClientRunning() ||
      this.pendingTurnStart ||
      Boolean(this.activeTurn) ||
      Boolean(this.state.activeTurnId) ||
      Boolean(this.sessionFilePath)
    );
  }

  private async startDesktopRuntime(): Promise<void> {
    this.setStatus("starting", "正在连接 Codex 桌面端...");

    try {
      // The desktop owner is the authoritative transport for task switching,
      // sending, approvals, and live progress. Connect it first so a slow or
      // temporarily unavailable metadata helper cannot block an explicit
      // ClawBot/web message from reaching the real desktop task.
      await this.startDesktopIpcClient();
      this.desktopTransportStarted = true;

      // The private app-server remains metadata-only in desktop mode. It is
      // used for thread/list and thread/read; all mutating operations go
      // through the desktop application's owner IPC below.
      let metadataFailureReason: string | null = null;
      try {
        await this.startAppServer();
        await this.connectRpcClient();
        this.desktopMetadataUnavailableReason = null;
      } catch (error) {
        metadataFailureReason = describeUnknownError(error);
        this.desktopMetadataUnavailableReason = metadataFailureReason;
        await this.disconnectRpcClient().catch(() => undefined);
        await this.stopAppServer().catch(() => undefined);
      }
      await this.restoreInitialSharedThreadIfNeeded();

      this.shuttingDown = false;
      this.cleanPanelExitInProgress = false;
      this.hasAcceptedInput = true;
      this.state.pid = this.appServer?.pid ?? undefined;
      this.state.startedAt = nowIso();
      this.state.pendingApproval = null;
      this.afterStart();
      this.state.status = "idle";
      this.syncSelectedThreadState(
        metadataFailureReason
          ? "Codex 桌面端已连接；任务索引正在后台恢复。"
          : "Codex 桌面端已连接。",
      );
      if (metadataFailureReason) {
        this.scheduleDesktopMetadataRecovery(metadataFailureReason);
      }
    } catch (error) {
      await this.stopDesktopIpcClient();
      await this.disconnectRpcClient();
      await this.stopAppServer();
      this.desktopTransportStarted = false;
      this.state.status = "error";
      throw error;
    }
  }

  private async startDesktopIpcClient(): Promise<void> {
    if (this.desktopIpcClient) {
      await this.desktopIpcClient.connect();
      return;
    }

    const client = new CodexDesktopIpcClient();
    this.desktopIpcClient = client;
    this.removeDesktopStateListener = client.onStateChanged(
      (threadId, state, previousState) => {
        this.handleDesktopThreadStateChanged(threadId, state, previousState);
      },
    );
    this.removeDesktopConnectionListener = client.onConnectionChanged((connected) => {
      this.handleDesktopConnectionChanged(connected);
    });
    await connectCodexDesktopIpcClientWithLaunch(client, {
      allowDesktopApplicationLaunch:
        this.options.allowDesktopApplicationLaunch === true,
    });
  }

  private handleDesktopConnectionChanged(connected: boolean): void {
    if (!this.desktopTransportStarted || this.shuttingDown) {
      return;
    }
    if (connected) {
      this.clearDesktopReconnectTimer();
      if (!this.desktopDisconnectWasReported) {
        return;
      }
      this.desktopDisconnectWasReported = false;
      this.syncSelectedThreadState("Codex 桌面端已重新连接。", {
        recoverConnectionError: true,
      });
      return;
    }
    if (this.desktopReconnectTimer || this.desktopDisconnectWasReported) {
      return;
    }
    this.desktopReconnectTimer = setTimeout(() => {
      this.desktopReconnectTimer = null;
      if (!this.desktopTransportStarted || this.shuttingDown) {
        return;
      }
      this.desktopDisconnectWasReported = true;
      this.setStatus("error", "Codex 桌面端连接已断开，正在重连。");
    }, Math.max(0, this.desktopReconnectGraceMs));
    this.desktopReconnectTimer.unref?.();
  }

  private clearDesktopReconnectTimer(): void {
    if (!this.desktopReconnectTimer) {
      return;
    }
    clearTimeout(this.desktopReconnectTimer);
    this.desktopReconnectTimer = null;
  }

  private async stopDesktopIpcClient(): Promise<void> {
    this.clearDesktopReconnectTimer();
    this.clearDesktopMetadataRecoveryTimer();
    this.desktopDisconnectWasReported = false;
    this.removeDesktopStateListener?.();
    this.removeDesktopStateListener = null;
    this.removeDesktopConnectionListener?.();
    this.removeDesktopConnectionListener = null;
    const client = this.desktopIpcClient;
    this.desktopIpcClient = null;
    this.desktopInitializedThreadIds.clear();
    this.desktopSeenRequestKeys.clear();
    if (client) {
      await client.dispose();
    }
  }

  private handleDesktopThreadStateChanged(
    threadId: string,
    state: CodexDesktopConversationState,
    previousState: CodexDesktopConversationState | null,
  ): void {
    const initialSnapshot = !this.desktopInitializedThreadIds.has(threadId);
    this.desktopInitializedThreadIds.add(threadId);

    if (typeof state.cwd === "string" && state.cwd.trim()) {
      this.desktopThreadCwdById.set(threadId, state.cwd.trim());
    }

    const trackedTurnIds = new Set<string>();
    if (this.activeTurn?.threadId === threadId) {
      trackedTurnIds.add(this.activeTurn.turnId);
    }
    for (const turn of this.backgroundTurns.values()) {
      if (turn.threadId === threadId) {
        trackedTurnIds.add(turn.turnId);
      }
    }
    const previousTurns = this.extractDesktopTurns(previousState, trackedTurnIds);
    const currentTurns = this.extractDesktopTurns(state, trackedTurnIds);
    for (const turn of currentTurns.values()) {
      const previousTurn = previousTurns.get(turn.turnId) ?? null;
      this.handleDesktopTurnState(threadId, turn, previousTurn, initialSnapshot);
    }

    this.handleDesktopRequests(threadId, state);
    if (threadId === this.sharedThreadId) {
      this.syncSelectedThreadState();
    }
    if (codexDesktopRuntimeType(state) === "idle") {
      this.scheduleDesktopQueuedFollowUpDrain(threadId);
    }
  }

  private extractDesktopTurns(
    state: CodexDesktopConversationState | null,
    trackedTurnIds: ReadonlySet<string> = new Set(),
  ): Map<string, CodexDesktopTurnState> {
    const turns = new Map<string, CodexDesktopTurnState>();
    if (!state) {
      return turns;
    }

    const entries = codexDesktopLiveTurnEntries(state);
    const includedTurnIds = new Set(
      entries.flatMap(([, entity]) =>
        typeof entity.turnId === "string" ? [entity.turnId] : []
      ),
    );
    if (trackedTurnIds.size > 0) {
      for (const entry of codexDesktopTurnEntries(state)) {
        const turnId = typeof entry[1].turnId === "string" ? entry[1].turnId : null;
        if (turnId && trackedTurnIds.has(turnId) && !includedTurnIds.has(turnId)) {
          entries.push(entry);
          includedTurnIds.add(turnId);
        }
      }
    }

    const ownerIdle = codexDesktopRuntimeType(state) === "idle";
    for (const [, entity] of entries) {
      if (typeof entity.turnId !== "string") {
        continue;
      }
      const errorMessage = isRecord(entity.error) && typeof entity.error.message === "string"
        ? entity.error.message
        : null;
      const rawStatus = typeof entity.status === "string" ? entity.status : "unknown";
      const startedAtMs = codexTimestampToMs(entity.startedAt);
      turns.set(entity.turnId, {
        turnId: entity.turnId,
        status: ownerIdle && this.isDesktopTurnActive(rawStatus) ? "completed" : rawStatus,
        errorMessage,
        items: Array.isArray(entity.items) ? entity.items : [],
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
      });
    }
    return turns;
  }

  private handleDesktopTurnState(
    threadId: string,
    turn: CodexDesktopTurnState,
    previousTurn: CodexDesktopTurnState | null,
    initialSnapshot: boolean,
  ): void {
    const existingTurn = this.activeTurn?.turnId === turn.turnId
      ? this.activeTurn
      : this.backgroundTurns.get(turn.turnId) ?? null;
    const origin: BridgeTurnOrigin = existingTurn?.origin ??
      (this.bridgeOwnedTurnIds.has(turn.turnId) ||
      (this.pendingTurnStart && this.pendingTurnThreadId === threadId) ||
      this.pendingDesktopTurnThreadIds.has(threadId)
        ? "wechat"
        : "local");
    const trackedTurn: CodexActiveTurn = { threadId, turnId: turn.turnId, origin };
    const activeNow = this.isDesktopTurnActive(turn.status);
    const wasActive = previousTurn
      ? this.isDesktopTurnActive(previousTurn.status)
      : Boolean(existingTurn || this.bridgeOwnedTurnIds.has(turn.turnId));
    if (!activeNow && !wasActive) {
      return;
    }

    if (activeNow && !this.turnStartedAtMs.has(turn.turnId)) {
      this.turnStartedAtMs.set(turn.turnId, turn.startedAtMs ?? Date.now());
    }
    const userMessageItem = turn.items.find((item) => Boolean(extractCodexUserMessageText(item)));
    const userText = extractCodexUserMessageText(userMessageItem);
    if (userText) {
      this.turnPreviewById.set(turn.turnId, truncatePreview(userText));
      const turnStartedAtMs = this.turnStartedAtMs.get(turn.turnId);
      if (activeNow && turnStartedAtMs !== undefined) {
        this.scheduleConsumedDesktopQueuedFollowUpCleanup(
          threadId,
          userText,
          turnStartedAtMs,
        );
      }
    }
    for (const item of turn.items) {
      if (!isRecord(item) || typeof item.id !== "string") {
        continue;
      }
      const finalText = extractCodexFinalTextFromItem(item);
      if (finalText) {
        this.getTurnFinalMessageMap(turn.turnId).set(item.id, finalText);
      }
    }
    if (turn.errorMessage) {
      this.turnErrorById.set(turn.turnId, turn.errorMessage);
    }

    if (activeNow) {
      if (origin === "wechat" && this.pendingTurnStart && !existingTurn) {
        this.bindActiveTurn(trackedTurn);
      } else {
        this.handleTrackedTurnStarted(trackedTurn);
      }
      if (
        origin === "local" &&
        userMessageItem &&
        !initialSnapshot &&
        !previousTurn
      ) {
        this.maybeMirrorLocalUserInput(trackedTurn, userMessageItem);
      }
      return;
    }

    if (!wasActive || this.hasCompletedTurn(turn.turnId)) {
      return;
    }

    this.handleTurnCompleted(trackedTurn, {
      turn: {
        id: turn.turnId,
        status: this.normalizeDesktopTurnCompletionStatus(turn.status),
        ...(turn.errorMessage ? { error: { message: turn.errorMessage } } : {}),
      },
    });
  }

  private isDesktopTurnActive(status: string): boolean {
    const normalized = status.replace(/[_-]/g, "").toLowerCase();
    return normalized === "inprogress" || normalized === "active" || normalized === "running";
  }

  private normalizeDesktopTurnCompletionStatus(status: string): string {
    const normalized = status.replace(/[_-]/g, "").toLowerCase();
    if (normalized === "interrupted" || normalized === "cancelled" || normalized === "canceled") {
      return "interrupted";
    }
    if (normalized === "failed" || normalized === "error") {
      return "failed";
    }
    return "completed";
  }

  private handleDesktopRequests(
    threadId: string,
    state: CodexDesktopConversationState,
  ): void {
    const requests = Array.isArray(state.requests)
      ? state.requests.filter(isRecord)
      : [];
    const currentKeys = new Set<string>();
    for (const request of requests) {
      const requestId = getCodexRpcRequestId(request.id);
      const method = typeof request.method === "string" ? request.method : null;
      if (requestId === null || !method || !isRecord(request.params)) {
        continue;
      }
      const key = this.desktopRequestKey(threadId, requestId);
      currentKeys.add(key);
      if (this.desktopSeenRequestKeys.has(key)) {
        continue;
      }
      this.desktopSeenRequestKeys.add(key);
      void this.handleDesktopRequest(
        threadId,
        requestId,
        method,
        request.params,
      ).catch((error) => {
        this.emit({
          type: "notice",
          level: "warning",
          text: `处理 Codex 桌面端请求失败：${describeUnknownError(error)}`,
          timestamp: nowIso(),
        });
      });
    }

    const prefix = `${threadId}\u0000`;
    for (const key of this.desktopSeenRequestKeys) {
      if (key.startsWith(prefix) && !currentKeys.has(key)) {
        this.desktopSeenRequestKeys.delete(key);
      }
    }
    this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
      (request) =>
        request.threadId !== threadId ||
        currentKeys.has(this.desktopRequestKey(threadId, request.requestId)),
    );
    this.pendingUserInputRequests = this.pendingUserInputRequests.filter(
      (request) =>
        request.threadId !== threadId ||
        currentKeys.has(this.desktopRequestKey(threadId, request.requestId)),
    );
  }

  private desktopRequestKey(threadId: string, requestId: CodexRpcRequestId): string {
    return `${threadId}\u0000${typeof requestId}:${String(requestId)}`;
  }

  private reconcileDesktopApprovalRequests(threadId: string): void {
    if (!this.usesDesktopTransport()) {
      return;
    }
    const state = this.getDesktopThreadStateView(threadId);
    if (!state || !Array.isArray(state.requests)) {
      return;
    }

    const liveRequests: CodexPendingApprovalRequest[] = [];
    for (const value of state.requests) {
      if (!isRecord(value)) {
        continue;
      }
      const requestId = getCodexRpcRequestId(value.id);
      const method = typeof value.method === "string" ? value.method : "";
      if (
        requestId === null ||
        (method !== "item/commandExecution/requestApproval" &&
          method !== "item/fileChange/requestApproval" &&
          method !== "item/permissions/requestApproval" &&
          method !== "mcpServer/elicitation/request") ||
        !isRecord(value.params)
      ) {
        continue;
      }
      const requestThreadId = getNotificationThreadId(value.params) ?? threadId;
      if (requestThreadId !== threadId) {
        continue;
      }
      const turnId = getNotificationTurnId(value.params) ??
        (this.activeTurn?.threadId === threadId ? this.activeTurn.turnId : null) ??
        this.getBackgroundTurnForThread(threadId)?.turnId ?? null;
      const request = buildCodexApprovalRequest(method, value.params);
      if (!request) {
        continue;
      }
      const origin: BridgeTurnOrigin = turnId && this.bridgeOwnedTurnIds.has(turnId)
        ? "wechat"
        : "local";
      liveRequests.push({
        requestId,
        method,
        threadId,
        turnId: turnId ?? `desktop-request:${String(requestId)}`,
        origin,
        params: value.params,
        request: {
          ...request,
          requestId: String(requestId),
          createdAt: nowIso(),
          threadId,
          ...(turnId ? { turnId } : {}),
          origin,
        },
      });
    }

    const liveKeys = new Set(
      liveRequests.map((request) => this.desktopRequestKey(threadId, request.requestId)),
    );
    this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
      (request) =>
        request.threadId !== threadId ||
        liveKeys.has(this.desktopRequestKey(threadId, request.requestId)),
    );
    for (const request of liveRequests) {
      const key = this.desktopRequestKey(threadId, request.requestId);
      if (!this.pendingApprovalRequests.some(
        (candidate) => this.desktopRequestKey(threadId, candidate.requestId) === key
      )) {
        this.pendingApprovalRequests.push(request);
      }
    }
  }

  private async handleDesktopRequest(
    fallbackThreadId: string,
    requestId: CodexRpcRequestId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (
      method !== "item/commandExecution/requestApproval" &&
      method !== "item/fileChange/requestApproval" &&
      method !== "item/permissions/requestApproval" &&
      method !== "mcpServer/elicitation/request" &&
      method !== "item/tool/requestUserInput"
    ) {
      return;
    }

    const threadId = getNotificationThreadId(params) ?? fallbackThreadId;
    const turnId = getNotificationTurnId(params) ??
      (this.activeTurn?.threadId === threadId ? this.activeTurn.turnId : null) ??
      this.getBackgroundTurnForThread(threadId)?.turnId ?? null;
    const requestTurnId = turnId ?? `desktop-request:${String(requestId)}`;
    const origin: BridgeTurnOrigin = turnId && this.bridgeOwnedTurnIds.has(turnId)
      ? "wechat"
      : "local";
    if (turnId) {
      this.handleTrackedTurnStarted({ threadId, turnId, origin });
    }

    if (method === "item/tool/requestUserInput") {
      const request = buildCodexUserInputRequest(params);
      if (!request) {
        return;
      }
      const contextualRequest = {
        ...request,
        threadId,
        ...(turnId ? { turnId } : {}),
        origin,
      };
      this.pendingUserInputRequests.push({
        requestId,
        method,
        threadId,
        turnId: requestTurnId,
        origin,
        request: contextualRequest,
      });
      if (threadId === this.sharedThreadId) {
        this.syncSelectedThreadState("Codex 正在等待补充输入。");
      }
      this.emit({
        type: "user_input_required",
        request: contextualRequest,
        timestamp: nowIso(),
        threadId,
        ...(turnId ? { turnId } : {}),
        origin,
      });
      return;
    }

    const approvalMethod = method as CodexPendingApprovalRequest["method"];
    const pendingRequest: CodexPendingApprovalRequest = {
      requestId,
      method: approvalMethod,
      threadId,
      turnId: requestTurnId,
      origin,
      params,
      request: {
        source: "cli",
        summary: "Codex 请求操作确认",
        commandPreview: "",
      },
    };
    const denyMessage = getCodexWechatOutboundAttachmentDenyMessage(approvalMethod, params);
    if (denyMessage) {
      await this.respondToApprovalRequest(pendingRequest, "deny");
      return;
    }
    const autoResponse = getCodexApprovalAutoResponse(approvalMethod, params);
    if (autoResponse) {
      try {
        await this.respondToDesktopApprovalResult(pendingRequest, autoResponse.result);
        return;
      } catch {
        // The desktop owner can retain the approval even when its decision RPC
        // times out. Fall through so mobile clients still receive an actionable
        // approval instead of permanently hiding the request as already seen.
      }
    }

    const request = buildCodexApprovalRequest(approvalMethod, params);
    if (!request) {
      return;
    }
    const timestamp = nowIso();
    const contextualRequest = {
      ...request,
      requestId: String(requestId),
      createdAt: timestamp,
      threadId,
      ...(turnId ? { turnId } : {}),
      origin,
    };
    pendingRequest.request = contextualRequest;
    const pendingKey = this.desktopRequestKey(threadId, requestId);
    if (!this.pendingApprovalRequests.some(
      (candidate) => this.desktopRequestKey(threadId, candidate.requestId) === pendingKey
    )) {
      this.pendingApprovalRequests.push(pendingRequest);
    }
    if (threadId === this.sharedThreadId) {
      this.syncSelectedThreadState("Codex 有操作等待确认。");
    }
    this.emit({
      type: "approval_required",
      request: contextualRequest,
      timestamp,
      threadId,
      ...(turnId ? { turnId } : {}),
      origin,
    });
  }

  private async startNativeClient(): Promise<void> {
    this.setStatus("starting", `Starting ${this.options.kind} adapter...`);

    let spawnTarget: SpawnTarget | null = null;
    try {
      spawnTarget = resolveSpawnTarget(this.options.command, this.options.kind);
      const child = spawnChild(
        spawnTarget.file,
        [...spawnTarget.args, ...this.buildSpawnArgs()],
        {
          cwd: this.options.cwd,
          env: this.buildEnv(),
          stdio: "inherit",
          windowsHide: false,
        },
      );

      this.nativeProcess = child;
      this.shuttingDown = false;
      this.cleanPanelExitInProgress = false;
      this.hasAcceptedInput = false;
      this.state.pid = child.pid ?? undefined;
      this.state.startedAt = nowIso();
      this.state.status = "idle";
      this.state.pendingApproval = null;

      child.once("error", (error) => {
        if (this.nativeProcess === child) {
          this.handleNativeExit(undefined, undefined, error);
        }
      });
      child.once("exit", (exitCode, signal) => {
        if (this.nativeProcess === child) {
          this.handleNativeExit(exitCode ?? undefined, signal ?? undefined);
        }
      });

      this.afterStart();
      this.setStatus("idle", `${this.options.kind} adapter is ready.`);
    } catch (err) {
      this.state.status = "error";
      this.emit({
        type: "fatal_error",
        message: `Failed to start ${this.options.kind}${spawnTarget ? ` (${spawnTarget.file})` : ""}: ${String(err)}`,
        timestamp: nowIso(),
      });
      throw err;
    }
  }

  private handleNativeExit(
    exitCode: number | undefined,
    signal?: NodeJS.Signals,
    startupError?: Error,
  ): void {
    const expectedShutdown = shouldTreatCodexNativeExitAsExpected({
      renderMode: this.options.renderMode,
      shuttingDown: this.shuttingDown,
      exitCode,
      signal,
      startupError,
    });
    if (expectedShutdown && this.isNativePanelMode()) {
      this.cleanPanelExitInProgress = true;
    }

    this.clearCompletionTimer();
    this.resetTurnTracking({ preserveThread: false });
    this.stopSessionPolling();
    void this.disconnectRpcClient();
    void this.stopAppServer();

    this.shuttingDown = false;
    this.nativeProcess = null;
    this.state.status = "stopped";
    this.state.pid = undefined;
    this.pendingApproval = null;
    this.state.pendingApproval = null;

    if (expectedShutdown) {
      this.emit({
        type: "status",
        status: "stopped",
        message: `${this.options.kind} worker stopped.`,
        timestamp: nowIso(),
      });
      return;
    }

    const exitLabel = startupError
      ? startupError.message
      : signal
        ? `signal ${signal}`
        : typeof exitCode === "number"
          ? `code ${exitCode}`
          : "an unknown code";
    this.emit({
      type: "fatal_error",
      message: `${this.options.kind} worker exited unexpectedly with ${exitLabel}.`,
      timestamp: nowIso(),
    });
  }

  private async stopNativeClient(): Promise<void> {
    if (!this.nativeProcess) {
      this.state.pid = undefined;
      return;
    }

    const child = this.nativeProcess;
    this.shuttingDown = true;
    this.nativeProcess = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      child.once("exit", () => finish());
      try {
        if (child.pid) {
          killProcessTreeSync(child.pid);
        } else {
          child.kill();
        }
      } catch {
        finish();
      }
      const timer = setTimeout(() => finish(), 1_500);
      timer.unref?.();
    });
  }

  private startSessionPolling(): void {
    this.stopSessionPolling();
    const poll = () => {
      void this.pollSessionLog();
    };
    this.sessionPollTimer = setInterval(poll, CODEX_SESSION_POLL_INTERVAL_MS);
    this.sessionPollTimer.unref?.();
    poll();
  }

  private stopSessionPolling(): void {
    if (this.sessionPollTimer) {
      clearInterval(this.sessionPollTimer);
      this.sessionPollTimer = null;
    }
    this.sessionFilePath = null;
    this.sessionReadOffset = 0;
    this.sessionPartialLine = "";
    this.sessionFinalText = null;
    this.sessionIgnoreBeforeMs = null;
    this.nextSessionFallbackScanAtMs = 0;
    this.nextSessionFileLookupAtMs = 0;
  }

  private async pollSessionLog(): Promise<void> {
    if (!this.shouldPollSessionLog()) {
      return;
    }

    this.maybeApplyRecentSessionFallback();

    if (!this.sessionFilePath) {
      const now = Date.now();
      if (now < this.nextSessionFileLookupAtMs) {
        return;
      }
      this.nextSessionFileLookupAtMs = now + CODEX_SESSION_FALLBACK_SCAN_INTERVAL_MS;
      const startedAtMs = this.state.startedAt ? Date.parse(this.state.startedAt) : now;
      this.sessionFilePath = findCodexSessionFile(
        this.getKnownThreadCwd(this.sharedThreadId),
        startedAtMs,
        { threadId: this.sharedThreadId ?? undefined },
      );
      if (!this.sessionFilePath) {
        return;
      }
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
      this.seedSessionReplayCutoff(startedAtMs);
    }

    let chunk: string;
    try {
      const stat = fs.statSync(this.sessionFilePath);
      if (stat.size < this.sessionReadOffset) {
        this.sessionReadOffset = 0;
        this.sessionPartialLine = "";
      }
      if (
        this.sessionReadOffset === 0 &&
        stat.size > CODEX_SESSION_POLL_INITIAL_READ_MAX_BYTES
      ) {
        this.sessionReadOffset = stat.size - CODEX_SESSION_POLL_INITIAL_READ_MAX_BYTES;
        this.sessionPartialLine = "";
      }
      if (stat.size === this.sessionReadOffset) {
        return;
      }
      const fd = fs.openSync(this.sessionFilePath, "r");
      try {
        const bytesToRead = stat.size - this.sessionReadOffset;
        const buf = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buf, 0, bytesToRead, this.sessionReadOffset);
        chunk = buf.toString("utf8");
        this.sessionReadOffset = stat.size;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      this.sessionFilePath = null;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
      return;
    }

    const lines = `${this.sessionPartialLine}${chunk}`.split(/\r?\n/);
    this.sessionPartialLine = lines.pop() ?? "";

    for (const line of lines) {
      this.handleSessionLogLine(line);
    }
  }

  private seedSessionReplayCutoff(startedAtMs: number): void {
    if (this.sessionIgnoreBeforeMs !== null) {
      return;
    }

    if (Number.isFinite(startedAtMs)) {
      this.sessionIgnoreBeforeMs = startedAtMs;
    }
  }

  private maybeApplyRecentSessionFallback(): void {
    if (!this.isNativePanelMode()) {
      return;
    }

    const now = Date.now();
    if (now < this.nextSessionFallbackScanAtMs) {
      return;
    }
    this.nextSessionFallbackScanAtMs = now + CODEX_SESSION_FALLBACK_SCAN_INTERVAL_MS;

    const startedAtMs = this.state.startedAt ? Date.parse(this.state.startedAt) : now;
    const candidate = findRecentCodexSessionFileForCwd(
      this.getKnownThreadCwd(this.sharedThreadId),
      startedAtMs,
    );
    if (!candidate) {
      return;
    }

    let currentSessionModifiedAtMs = Number.NEGATIVE_INFINITY;
    if (this.sessionFilePath) {
      try {
        currentSessionModifiedAtMs = fs.statSync(this.sessionFilePath).mtimeMs;
      } catch {
        currentSessionModifiedAtMs = Number.NEGATIVE_INFINITY;
      }
    }

    if (candidate.threadId !== this.sharedThreadId) {
      if (this.sessionFilePath && candidate.modifiedAtMs <= currentSessionModifiedAtMs) {
        return;
      }

      if (!this.activeTurn || this.activeTurn.threadId === candidate.threadId) {
        this.trackLocalSharedThread(candidate.threadId, {
          reason: "local_session_fallback",
          signal: "session_fallback",
        });
        this.pendingThreadFollowId = null;
      } else {
        this.pendingThreadFollowId = candidate.threadId;
      }
    }

    if (this.sessionFilePath !== candidate.filePath) {
      this.sessionFilePath = candidate.filePath;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
      this.sessionFinalText = null;
      this.seedSessionReplayCutoff(startedAtMs);
    }
  }

  private handleSessionLogLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!isRecord(parsed) || !isRecord(parsed.payload) || typeof parsed.payload.type !== "string") {
      return;
    }

    if (shouldIgnoreCodexSessionReplayEntry(parsed.timestamp, this.sessionIgnoreBeforeMs)) {
      return;
    }

    const payload = parsed.payload;
    const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : nowIso();
    if (this.sessionIgnoreBeforeMs !== null) {
      this.sessionIgnoreBeforeMs = null;
    }

    switch (payload.type) {
      case "task_started": {
        if (typeof payload.turn_id === "string") {
          this.recordTurnActivity(payload.turn_id, timestamp);
          this.hasAcceptedInput = true;
          this.state.activeTurnId = payload.turn_id;
          const hasTrackedTurnContext =
            this.pendingTurnStart ||
            Boolean(this.activeTurn) ||
            this.state.activeTurnOrigin === "local" ||
            this.state.activeTurnOrigin === "wechat";
          if (
            hasTrackedTurnContext &&
            this.state.status !== "busy" &&
            this.state.status !== "awaiting_approval"
          ) {
            const message =
              this.state.activeTurnOrigin === "local"
                ? "Codex is busy with a local terminal turn."
                : undefined;
            this.setStatus("busy", message);
          }
        }
        return;
      }

      case "user_message": {
        if (typeof payload.message !== "string") {
          return;
        }

        const message = normalizeOutput(payload.message).trim();
        if (!message) {
          return;
        }

        this.hasAcceptedInput = true;
        this.state.lastInputAt = timestamp;
        const origin = this.consumeInjectedInput(message) ? "wechat" : "local";
        this.state.activeTurnOrigin = origin;

        if (origin === "local") {
          const turnId = this.activeTurn?.turnId ?? this.state.activeTurnId ?? null;
          const threadId =
            this.activeTurn?.threadId ??
            this.sharedThreadId ??
            this.state.sharedThreadId ??
            this.state.sharedSessionId ??
            null;
          if (turnId && !this.mirroredUserInputTurnIds.has(turnId)) {
            this.mirroredUserInputTurnIds.add(turnId);
            this.emit({
              type: "mirrored_user_input",
              text: message,
              timestamp,
              origin: "local",
              ...(threadId ? { threadId } : {}),
              turnId,
            });
          }

          if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
            this.setStatus("busy", "Codex is busy with a local terminal turn.");
          }

          if (
            !turnId &&
            !this.isRpcSocketOpen() &&
            isRecentIsoTimestamp(timestamp, CODEX_SESSION_LOCAL_MIRROR_FALLBACK_WINDOW_MS)
          ) {
            this.emit({
              type: "mirrored_user_input",
              text: message,
              timestamp,
              origin: "local",
              ...(threadId ? { threadId } : {}),
            });
          }
        }
        return;
      }

      case "agent_message": {
        if (payload.phase !== "final_answer" || typeof payload.message !== "string") {
          return;
        }

        const message = normalizeOutput(payload.message).trim();
        if (message) {
          this.sessionFinalText = message;
          this.state.lastOutputAt = timestamp;
          const activeTurnId = this.activeTurn?.turnId ?? this.state.activeTurnId ?? null;
          if (activeTurnId) {
            this.recordTurnActivity(activeTurnId, timestamp);
            this.scheduleFinalReplyCompletionIfEligible(activeTurnId);
          }
        }
        return;
      }

      case "task_complete": {
        if (typeof payload.turn_id !== "string") {
          return;
        }
        const turnId = payload.turn_id;
        this.clearFinalReplyCompletionTimerForTurn(turnId);
        this.clearInterruptTimerForTurn(turnId);

        if (this.hasCompletedTurn(turnId)) {
          this.sessionFinalText = null;
          if (this.activeTurn?.turnId === turnId) {
            this.setActiveTurn(null, { followPendingThread: false });
          }
          this.backgroundTurns.delete(turnId);
          this.cleanupTurnArtifacts(turnId);
          this.syncSelectedThreadState();
          return;
        }

        const finalText =
          this.sessionFinalText ||
          (typeof payload.last_agent_message === "string"
            ? normalizeOutput(payload.last_agent_message).trim()
            : "");
        this.sessionFinalText = null;
        const trackedTurn =
          this.activeTurn?.turnId === turnId
            ? this.activeTurn
            : this.backgroundTurns.get(turnId) ??
              (this.sharedThreadId
                ? {
                    threadId: this.sharedThreadId,
                    turnId,
                    origin: this.state.activeTurnOrigin ?? "local",
                  }
                : null);
        if (!trackedTurn) {
          return;
        }
        if (finalText) {
          this.getTurnFinalMessageMap(turnId).set("session-final", finalText);
        }
        const completedError = isRecord(payload.error) ? payload.error : null;
        this.handleTurnCompleted(trackedTurn, {
          turn: {
            id: turnId,
            status: completedError ? "failed" : "completed",
            ...(completedError ? { error: completedError } : {}),
          },
        });
        return;
      }
    }
  }

  private rememberInjectedInput(text: string): void {
    const normalizedText = normalizeOutput(text).trim();
    if (!normalizedText) {
      return;
    }

    const cutoff = Date.now() - 60_000;
    this.pendingInjectedInputs = this.pendingInjectedInputs.filter(
      (entry) => entry.createdAtMs >= cutoff,
    );
    this.pendingInjectedInputs.push({
      text,
      normalizedText,
      createdAtMs: Date.now(),
    });
    if (this.pendingInjectedInputs.length > 8) {
      this.pendingInjectedInputs.splice(0, this.pendingInjectedInputs.length - 8);
    }
  }

  private consumeInjectedInput(message: string): boolean {
    const normalizedMessage = normalizeOutput(message).trim();
    if (!normalizedMessage) {
      return false;
    }

    const cutoff = Date.now() - 60_000;
    this.pendingInjectedInputs = this.pendingInjectedInputs.filter(
      (entry) => entry.createdAtMs >= cutoff,
    );

    const index = this.pendingInjectedInputs.findIndex(
      (entry) => entry.normalizedText === normalizedMessage,
    );
    if (index < 0) {
      return false;
    }

    this.pendingInjectedInputs.splice(index, 1);
    return true;
  }

  private async typeIntoPty(text: string): Promise<void> {
    for (const character of text) {
      this.writeToPty(character);
      await delay(4);
    }
  }

  private async sendPanelTurnItems(
    items: BridgeTurnInputItem[],
    options: { allowDesktopBootstrapWrite?: boolean } = {},
  ): Promise<string> {
    if (this.isNativePanelMode() && !this.nativeProcess) {
      throw new Error("codex panel is not running.");
    }
    this.recoverStaleBusyStateIfNeeded();
    this.recoverStaleActiveTurnStateIfNeeded();
    if (this.pendingApproval) {
      throw new Error("Codex 有操作等待确认，请回复 1 允许本次，回复 2 拒绝，或回复 3 本任务始终允许。");
    }
    if (this.getPendingUserInputRequestsForThread(this.sharedThreadId).length > 0) {
      throw new Error("Codex is waiting for user input. Reply with /answer and your response, or use /stop.");
    }
    if (this.pendingTurnStart || this.activeTurn || this.state.status === "busy") {
      const origin = this.state.activeTurnOrigin;
      if (origin === "local") {
        throw new Error("The local Codex panel is still working. Wait for the current reply or use /stop.");
      }
      throw new Error("codex is still working. Wait for the current reply or use /stop.");
    }

    const text = items
      .filter((item): item is Extract<BridgeTurnInputItem, { type: "text" }> =>
        item.type === "text"
      )
      .map((item) => item.text)
      .join("\n")
      .trim();
    const imageCount = items.filter((item) => item.type !== "text").length;
    this.clearInterruptTimer();
    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(
      text || (imageCount > 0 ? `图片 ${imageCount} 张` : ""),
    );
    this.state.lastInputAt = nowIso();
    if (text) {
      this.rememberInjectedInput(text);
    }

    const threadId = await this.ensureThreadStarted();
    const subscribedBeforeTurnStart = await this.tryEnsureSharedThreadSubscribed(threadId);
    this.pendingTurnStart = true;
    this.pendingTurnThreadId = threadId;
    this.interruptPendingTurnStart = false;
    this.state.activeTurnOrigin = "wechat";
    this.setStatus("busy");

    try {
      const permissionSettings = this.resolveDesktopPermissionSettings(threadId);
      const response = await this.sendRpcRequest(
        "turn/start",
        {
          threadId,
          cwd: this.getKnownThreadCwd(threadId),
          approvalPolicy: permissionSettings.approvalPolicy,
          approvalsReviewer: permissionSettings.approvalsReviewer,
          sandboxPolicy: permissionSettings.sandboxPolicy,
          input: items,
        },
        { allowDesktopBootstrapWrite: options.allowDesktopBootstrapWrite },
      );

      const turnId = this.extractTurnIdFromResponse(response);
      if (!turnId) {
        throw new Error("Codex did not return a turn id for the requested turn.");
      }

      this.bindActiveTurn({
        threadId,
        turnId,
        origin: "wechat",
      });
      if (!subscribedBeforeTurnStart) {
        await this.tryEnsureSharedThreadSubscribed(threadId);
      }

      if (this.interruptPendingTurnStart) {
        await this.requestActiveTurnInterrupt();
        this.armInterruptFallback();
      }
      return turnId;
    } catch (error) {
      this.pendingTurnStart = false;
      this.pendingTurnThreadId = null;
      this.interruptPendingTurnStart = false;
      this.state.activeTurnOrigin = undefined;
      if (!this.activeTurn && this.getState().status === "busy") {
        this.setStatus("idle");
      }
      throw error;
    }
  }

  private async sendPanelTurn(
    text: string,
    options: { allowDesktopBootstrapWrite?: boolean } = {},
  ): Promise<void> {
    await this.sendPanelTurnItems([{ type: "text", text }], options);
  }

  private async sendDesktopTurn(text: string): Promise<void> {
    const threadId = this.sharedThreadId;
    if (!threadId) {
      throw new Error("请先用 /tasks 选择 Codex 任务。");
    }
    await this.sendDesktopTurnToThread(threadId, text);
  }

  private async sendDesktopTurnToThread(
    threadId: string,
    text: string,
  ): Promise<BridgeSessionSendResult> {
    return await this.sendDesktopTurnItemsToThread(threadId, [{ type: "text", text }]);
  }

  private async isDuplicateDesktopTurnInput(params: {
    threadId: string;
    text: string;
    imageCount: number;
    taskActive: boolean;
    queuedInputs: BridgeQueuedTaskInput[];
  }): Promise<boolean> {
    if (params.imageCount > 0) {
      return false;
    }
    const normalizedText = normalizeOutput(params.text).trim();
    if (!normalizedText) {
      return false;
    }
    if (this.pendingDesktopTurnTextByThreadId.get(params.threadId) === normalizedText) {
      return true;
    }
    const latestQueued = params.queuedInputs.at(-1);
    if (
      latestQueued &&
      latestQueued.imageCount === 0 &&
      normalizeOutput(latestQueued.text).trim() === normalizedText
    ) {
      return true;
    }
    const recentAccepted = this.recentDesktopTurnTextByThreadId.get(params.threadId);
    if (
      params.taskActive &&
      recentAccepted?.text === normalizedText &&
      Date.now() - recentAccepted.acceptedAtMs <= CODEX_DUPLICATE_INPUT_RECENT_WINDOW_MS
    ) {
      return true;
    }

    try {
      const page = await this.getSessionMessagePage(params.threadId, {
        limit: CODEX_SESSION_MESSAGE_PAGE_MAX_LIMIT,
      });
      const comparison = params.taskActive
        ? [...page.messages].reverse().find((message) => message.role === "user")
        : page.messages.at(-1);
      return comparison?.role === "user" &&
        normalizeOutput(comparison.text).trim() === normalizedText;
    } catch {
      // Duplicate detection must fail open when history is temporarily unavailable.
      return false;
    }
  }

  private reconcilePersistedDesktopCompletion(
    threadId: string,
    knownLiveState?: CodexDesktopConversationState | null,
  ): {
    terminalTurnId: string | null;
    liveSummary: BridgeSessionRunSummary | null;
    liveStateActive: boolean;
  } {
    const filePath = this.resolveDesktopSessionFilePath(threadId);
    const persisted = filePath
      ? readCodexSessionRunSummaryFromRolloutTail(filePath)
      : null;
    const terminalTurnId = persisted &&
        persisted.status !== "running" &&
        persisted.status !== "unknown" &&
        persisted.turnId
      ? persisted.turnId
      : null;
    const liveState = knownLiveState === undefined
      ? this.getDesktopThreadStateView(threadId)
      : knownLiveState;
    const liveSummary = liveState
      ? extractCodexDesktopThreadRunSummary(liveState, null, Date.now())
      : null;
    const liveStateActive = codexDesktopRuntimeType(liveState) === "active";
    if (!terminalTurnId) {
      return { terminalTurnId: null, liveSummary, liveStateActive };
    }

    if (
      this.activeTurn?.threadId === threadId &&
      this.activeTurn.turnId === terminalTurnId
    ) {
      this.cleanupTurnArtifacts(terminalTurnId);
      this.setActiveTurn(null, { followPendingThread: false });
    }
    const background = this.backgroundTurns.get(terminalTurnId);
    if (background?.threadId === threadId) {
      this.backgroundTurns.delete(terminalTurnId);
      this.cleanupTurnArtifacts(terminalTurnId);
    }
    this.clearPendingApprovalStateForTurn(terminalTurnId);
    this.clearPendingUserInputStateForTurn(terminalTurnId);
    const hasDifferentLiveTurn = liveStateActive &&
      liveSummary?.turnId !== terminalTurnId;
    if (!hasDifferentLiveTurn) {
      this.pendingDesktopTurnThreadIds.delete(threadId);
      this.desktopListedRuntimeStatusByThreadId.set(threadId, { type: "idle" });
    }
    return { terminalTurnId, liveSummary, liveStateActive };
  }

  private async sendDesktopTurnItemsToThread(
    threadId: string,
    items: BridgeTurnInputItem[],
  ): Promise<BridgeSessionSendResult> {
    if (this.desktopBootstrapThreadIds.has(threadId)) {
      const handedOff = await this.tryHandoffDesktopBootstrapThread(threadId);
      if (!handedOff) {
        const turnId = await this.sendPanelTurnItems(items, {
          allowDesktopBootstrapWrite: true,
        });
        return { turnId, queued: false };
      }
    }
    const client = this.desktopIpcClient;
    if (!client) {
      throw new Error("无法连接 Codex 桌面端，请确认应用正在运行。");
    }
    const isSelectedThread = threadId === this.sharedThreadId;
    const text = items
      .filter((item): item is Extract<BridgeTurnInputItem, { type: "text" }> =>
        item.type === "text"
      )
      .map((item) => item.text)
      .join("\n")
      .trim();
    const imageCount = items.filter((item) => item.type !== "text").length;
    const reconciliation = this.reconcilePersistedDesktopCompletion(threadId);
    const queuedInputs = this.getQueuedTaskInputs(threadId);
    const liveTurnIsStale = Boolean(
      reconciliation.terminalTurnId &&
      (!reconciliation.liveSummary?.turnId ||
        reconciliation.liveSummary.turnId === reconciliation.terminalTurnId),
    );
    const queued = this.activeTurn?.threadId === threadId ||
      Array.from(this.backgroundTurns.values()).some(
        (trackedTurn) => trackedTurn.threadId === threadId,
      ) ||
      this.pendingDesktopTurnThreadIds.has(threadId) ||
      this.getPendingApprovalRequestsForThread(threadId).length > 0 ||
      this.getPendingUserInputRequestsForThread(threadId).length > 0 ||
      queuedInputs.length > 0 ||
      (reconciliation.liveSummary?.status === "running" && !liveTurnIsStale) ||
      (this.desktopListedRuntimeStatusByThreadId.get(threadId)?.type === "active" &&
        !liveTurnIsStale);
    if (await this.isDuplicateDesktopTurnInput({
      threadId,
      text,
      imageCount,
      taskActive: queued,
      queuedInputs,
    })) {
      return { duplicate: true };
    }
    if (queued) {
      return await this.enqueueDesktopQueuedFollowUp(threadId, items);
    }
    if (this.getPendingApprovalRequestsForThread(threadId).length > 0) {
      throw new Error(
        isSelectedThread
          ? "当前任务有操作等待确认，请回复 1、2 或 3。"
          : "这个任务有操作等待确认。",
      );
    }
    if (this.getPendingUserInputRequestsForThread(threadId).length > 0) {
      throw new Error(
        isSelectedThread
          ? "当前任务正在等待你的补充输入。"
          : "这个任务正在等待你的补充输入。",
      );
    }
    if (this.pendingDesktopTurnThreadIds.has(threadId)) {
      throw new Error("上一条消息正在提交，请稍后重试。");
    }

    this.clearInterruptTimer();
    this.hasAcceptedInput = true;
    const preview = text || (imageCount > 0 ? `图片 ${imageCount} 张` : "");
    this.currentPreview = truncatePreview(preview);
    this.state.lastInputAt = nowIso();
    if (text) {
      this.rememberInjectedInput(text);
    }
    const normalizedText = imageCount === 0 ? normalizeOutput(text).trim() : "";
    this.pendingDesktopTurnThreadIds.add(threadId);
    if (normalizedText) {
      this.pendingDesktopTurnTextByThreadId.set(threadId, normalizedText);
    }
    if (isSelectedThread) {
      this.syncSelectedThreadState();
    }

    try {
      const startInput = imageCount === 0 && items.length === 1 && items[0]?.type === "text"
        ? items[0].text
        : items;
      const selectedModel = this.selectedDesktopModelByThreadId.get(threadId);
      const selectedReasoningEffort = this.selectedDesktopReasoningEffortByThreadId.get(threadId);
      const permissionSettings = this.resolveDesktopPermissionSettings(threadId);
      const turn = await client.startTurn(
        threadId,
        startInput,
        {
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(selectedReasoningEffort ? { effort: selectedReasoningEffort } : {}),
          approvalPolicy: permissionSettings.approvalPolicy,
          approvalsReviewer: permissionSettings.approvalsReviewer,
          sandbox: permissionSettings.sandbox,
          sandboxPolicy: permissionSettings.sandboxPolicy,
        },
      );
      const turnId = typeof turn.id === "string" ? turn.id : null;
      if (!turnId) {
        throw new Error("Codex 桌面端没有返回任务编号。");
      }
      if (normalizedText) {
        this.recentDesktopTurnTextByThreadId.set(threadId, {
          text: normalizedText,
          acceptedAtMs: Date.now(),
        });
      }
      this.bridgeOwnedTurnIds.add(turnId);
      this.turnStartedAtMs.set(turnId, Date.now());
      this.turnPreviewById.set(turnId, truncatePreview(preview));
      if (
        !this.hasCompletedTurn(turnId) &&
        this.activeTurn?.turnId !== turnId &&
        !this.backgroundTurns.has(turnId)
      ) {
        const trackedTurn = {
          threadId,
          turnId,
          origin: "wechat" as const,
        };
        if (isSelectedThread && !this.activeTurn) {
          this.setActiveTurn(trackedTurn);
        } else {
          this.backgroundTurns.set(turnId, trackedTurn);
        }
      }
      if (isSelectedThread) {
        this.syncSelectedThreadState();
      }
      return { turnId, queued: false };
    } finally {
      this.pendingDesktopTurnThreadIds.delete(threadId);
      if (
        normalizedText &&
        this.pendingDesktopTurnTextByThreadId.get(threadId) === normalizedText
      ) {
        this.pendingDesktopTurnTextByThreadId.delete(threadId);
      }
      if (isSelectedThread) {
        this.syncSelectedThreadState();
      }
    }
  }

  private async resumeDesktopThread(
    threadId: string,
    options: { startup?: boolean } = {},
  ): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("请选择一个 Codex 任务。");
    }
    const client = this.desktopIpcClient;
    if (!client) {
      throw new Error("无法连接 Codex 桌面端，请确认应用正在运行。");
    }

    await client.openThread(normalizedThreadId);
    this.selectDesktopThread(normalizedThreadId, options);
  }

  private async restoreDesktopThreadInBackground(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("请选择一个 Codex 任务。");
    }
    const client = this.desktopIpcClient;
    if (!client) {
      throw new Error("无法连接 Codex 桌面端，请确认应用正在运行。");
    }

    await client.followThread(normalizedThreadId, { retention: "summary" });
    this.selectDesktopThread(normalizedThreadId, { startup: true });
  }

  private selectDesktopThread(
    normalizedThreadId: string,
    options: { startup?: boolean } = {},
  ): void {
    this.subscribedThreadIds.add(normalizedThreadId);
    this.sessionFilePath = null;
    this.sessionReadOffset = 0;
    this.sessionPartialLine = "";
    this.sessionFinalText = null;
    this.pendingThreadFollowId = null;
    if (this.activeTurn && this.activeTurn.threadId !== normalizedThreadId) {
      this.moveActiveTurnToBackground();
    }
    this.updateSharedThread(normalizedThreadId, {
      source: options.startup ? "restore" : "wechat",
      reason: options.startup ? "startup_restore" : "wechat_resume",
      notify: true,
    });
    this.syncSelectedThreadState();
  }

  private async interruptDesktopTurn(): Promise<boolean> {
    if (!this.sharedThreadId) {
      return false;
    }
    return await this.interruptDesktopThread(this.sharedThreadId);
  }

  private async interruptDesktopThread(threadId: string): Promise<boolean> {
    const client = this.desktopIpcClient;
    if (!client) {
      return false;
    }
    let interruptedTurn = this.activeTurn?.threadId === threadId
      ? this.activeTurn
      : this.getBackgroundTurnForThread(threadId);
    if (!interruptedTurn) {
      const summary = await this.getSessionRunSummary(threadId);
      if (summary?.status !== "running" || !summary.turnId) {
        return false;
      }
      interruptedTurn = {
        threadId,
        turnId: summary.turnId,
        origin: "local",
      };
      if (threadId === this.sharedThreadId && !this.activeTurn) {
        this.setActiveTurn(interruptedTurn, { followPendingThread: false });
      } else {
        this.backgroundTurns.set(interruptedTurn.turnId, interruptedTurn);
      }
    }

    this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
      (request) => request.turnId !== interruptedTurn.turnId,
    );
    this.pendingUserInputRequests = this.pendingUserInputRequests.filter(
      (request) => request.turnId !== interruptedTurn.turnId,
    );
    if (threadId === this.sharedThreadId) {
      this.syncSelectedThreadState();
    }
    await client.interruptTurn(interruptedTurn.threadId, interruptedTurn.turnId);
    this.armInterruptFallback(interruptedTurn);
    return true;
  }

  private async interruptPanelTurn(): Promise<boolean> {
    if (this.isNativePanelMode() && !this.nativeProcess) {
      return false;
    }

    const turnPending =
      this.pendingTurnStart ||
      this.state.status === "busy" ||
      this.state.status === "awaiting_approval" ||
      this.state.status === "awaiting_input";
    if (!turnPending) {
      return false;
    }

    if (this.pendingTurnStart && !this.activeTurn) {
      this.interruptPendingTurnStart = true;
      return true;
    }

    const interruptedTurn = this.activeTurn;
    if (!interruptedTurn) {
      return false;
    }

    this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
      (request) => request.turnId !== interruptedTurn.turnId,
    );
    this.pendingUserInputRequests = this.pendingUserInputRequests.filter(
      (request) => request.turnId !== interruptedTurn.turnId,
    );
    this.syncSelectedThreadState();
    await this.requestActiveTurnInterrupt();
    this.armInterruptFallback(interruptedTurn);
    return true;
  }

  private handleUnexpectedAppServerFailure(
    message: string,
    expectedShutdown = shouldSuppressCodexTransportFatalError({
      transportShuttingDown: this.appServerShuttingDown,
      shuttingDown: this.shuttingDown,
      cleanPanelExitInProgress: this.cleanPanelExitInProgress,
    }),
  ): void {
    const action = resolveCodexAppServerFailureAction({
      expectedShutdown,
      usesDesktopTransport: this.usesDesktopTransport(),
      desktopTransportStarted: this.desktopTransportStarted,
    });
    if (action === "suppress") {
      return;
    }
    if (action === "recover_metadata") {
      this.state.pid = undefined;
      this.scheduleDesktopMetadataRecovery(message);
      return;
    }
    this.emit({
      type: "fatal_error",
      message,
      timestamp: nowIso(),
    });
    this.terminateCodexClient();
  }

  private scheduleDesktopMetadataRecovery(reason: string): void {
    this.desktopMetadataUnavailableReason = reason;
    if (
      this.desktopMetadataRecoveryTimer ||
      this.desktopMetadataRecoveryPromise ||
      this.shuttingDown ||
      !this.desktopTransportStarted
    ) {
      return;
    }
    this.desktopMetadataRecoveryTimer = setTimeout(() => {
      this.desktopMetadataRecoveryTimer = null;
      if (this.shuttingDown || !this.desktopTransportStarted) {
        return;
      }
      void this.recoverDesktopMetadataAppServer(reason);
    }, Math.max(0, this.desktopMetadataRecoveryGraceMs));
    this.desktopMetadataRecoveryTimer.unref?.();
  }

  private clearDesktopMetadataRecoveryTimer(): void {
    if (!this.desktopMetadataRecoveryTimer) {
      return;
    }
    clearTimeout(this.desktopMetadataRecoveryTimer);
    this.desktopMetadataRecoveryTimer = null;
  }

  private async recoverDesktopMetadataAppServer(reason: string): Promise<boolean> {
    if (this.desktopMetadataRecoveryPromise) {
      return await this.desktopMetadataRecoveryPromise;
    }
    this.clearDesktopMetadataRecoveryTimer();
    this.desktopMetadataRecoveryPromise = (async () => {
      await this.disconnectRpcClient().catch(() => undefined);
      await this.stopAppServer().catch(() => undefined);
      let lastError = reason;
      for (
        let attempt = 1;
        attempt <= CODEX_DESKTOP_METADATA_RECOVERY_MAX_ATTEMPTS;
        attempt += 1
      ) {
        if (this.shuttingDown || !this.desktopTransportStarted) {
          return false;
        }
        if (attempt > 1) {
          await delay(CODEX_DESKTOP_METADATA_RECOVERY_RETRY_MS * (attempt - 1));
        }
        try {
          await this.startAppServer();
          await this.connectRpcClient();
          this.desktopMetadataUnavailableReason = null;
          this.state.pid = this.appServer?.pid ?? undefined;
          this.emit({
            type: "status",
            status: this.state.status,
            message: "Codex 任务索引连接已恢复。",
            timestamp: nowIso(),
          });
          return true;
        } catch (error) {
          lastError = describeUnknownError(error);
          await this.disconnectRpcClient().catch(() => undefined);
          await this.stopAppServer().catch(() => undefined);
        }
      }
      this.desktopMetadataUnavailableReason = lastError;
      this.state.pid = undefined;
      this.emit({
        type: "status",
        status: this.state.status,
        message:
          "Codex 桌面任务仍可继续，但任务列表、历史和重命名暂时不可用；WeRelay 会在下次读取时重试任务索引连接。",
        timestamp: nowIso(),
      });
      return false;
    })();
    try {
      return await this.desktopMetadataRecoveryPromise;
    } finally {
      this.desktopMetadataRecoveryPromise = null;
    }
  }

  private async startAppServer(): Promise<void> {
    if (this.appServer) {
      return;
    }

    const port = await reserveLocalPort();
    const env = this.buildEnv();
    const workspacePaths = ensureWorkspaceChannelDir(this.options.cwd);
    const token = crypto.randomBytes(24).toString("hex");
    const tokenFilePath = path.join(
      workspacePaths.workspaceDir,
      `codex-app-server-token-${this.localClientInstanceId}.txt`,
    );
    writePrivateFileAtomic(tokenFilePath, `${token}\n`, { encoding: "utf8" });
    const spawnTarget = this.usesDesktopTransport()
      ? resolveCodexDesktopAppServerSpawnTarget(this.options.command)
      : resolveSpawnTarget(this.options.command, "codex");
    const child = spawnChild(
      spawnTarget.file,
      [
        ...spawnTarget.args,
        "app-server",
        "--listen",
        `ws://${CODEX_APP_SERVER_HOST}:${port}`,
        "--ws-auth",
        "capability-token",
        "--ws-token-file",
        tokenFilePath,
      ],
      {
        // The app-server only coordinates persisted threads; each thread/turn RPC
        // carries its real project cwd. Keep this helper process in Bridge-owned
        // state so a macOS LaunchAgent does not block on a protected Documents cwd.
        cwd: workspacePaths.workspaceDir,
        env,
        stdio: "pipe",
        windowsHide: true,
      },
    );

    this.appServer = child;
    this.appServerPort = port;
    this.appServerShuttingDown = false;
    this.appServerLog = "";
    this.appServerAuthToken = token;
    this.appServerAuthTokenFilePath = tokenFilePath;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.appServerLog = appendBoundedLog(this.appServerLog, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.appServerLog = appendBoundedLog(this.appServerLog, chunk);
    });
    let terminationHandled = false;
    child.once("error", (error: Error) => {
      if (terminationHandled) {
        return;
      }
      terminationHandled = true;
      // spawn itself failed (ENOENT/EACCES/EMFILE). Without this listener the
      // 'error' event is unhandled and crashes the bridge. Desktop transport
      // can recover this metadata-only helper after startup; other modes stay fatal.
      const expectedShutdown = shouldSuppressCodexTransportFatalError({
        transportShuttingDown: this.appServerShuttingDown,
        shuttingDown: this.shuttingDown,
        cleanPanelExitInProgress: this.cleanPanelExitInProgress,
      });
      this.appServer = null;
      this.appServerPort = null;
      this.appServerShuttingDown = false;
      this.deleteAppServerAuthTokenFile();
      this.appServerAuthToken = null;
      const details = this.describeAppServerLog();
      this.handleUnexpectedAppServerFailure(
        `codex app-server failed to start: ${String(error)}${details}`,
        expectedShutdown,
      );
    });
    child.on("exit", (code, signal) => {
      if (terminationHandled) {
        return;
      }
      terminationHandled = true;
      const expectedShutdown = shouldSuppressCodexTransportFatalError({
        transportShuttingDown: this.appServerShuttingDown,
        shuttingDown: this.shuttingDown,
        cleanPanelExitInProgress: this.cleanPanelExitInProgress,
      });
      this.appServer = null;
      this.appServerPort = null;
      this.appServerShuttingDown = false;
      this.deleteAppServerAuthTokenFile();
      this.appServerAuthToken = null;

      const exitLabel =
        signal ? `signal ${signal}` : `code ${typeof code === "number" ? code : "unknown"}`;
      const details = this.describeAppServerLog();
      this.handleUnexpectedAppServerFailure(
        `codex app-server exited unexpectedly with ${exitLabel}.${details}`,
        expectedShutdown,
      );
    });

    try {
      await waitForTcpPort(
        CODEX_APP_SERVER_HOST,
        port,
        CODEX_APP_SERVER_READY_TIMEOUT_MS,
      );
    } catch (err) {
      await this.stopAppServer();
      const details = this.describeAppServerLog();
      throw new Error(`Failed to start Codex app-server: ${String(err)}${details}`, {
        cause: err,
      });
    }
  }

  private async connectRpcClient(): Promise<void> {
    if (this.isRpcSocketOpen()) {
      return;
    }
    const appServer = this.appServer;
    const appServerPort = this.appServerPort;
    const appServerAuthToken = this.appServerAuthToken;
    if (!appServer || !appServerPort) {
      throw new Error("Codex app-server is not ready.");
    }
    if (typeof WebSocket !== "function") {
      throw new Error("Global WebSocket is unavailable in this runtime.");
    }

    const isCurrentAppServer = () => (
      this.appServer === appServer &&
      this.appServerPort === appServerPort &&
      this.appServerAuthToken === appServerAuthToken
    );
    const url = `ws://${CODEX_APP_SERVER_HOST}:${appServerPort}`;
    const deadline = Date.now() + CODEX_APP_SERVER_READY_TIMEOUT_MS;
    let lastError = "Timed out before the websocket became ready.";

    while (Date.now() < deadline) {
      if (this.isRpcSocketOpen()) {
        return;
      }
      if (!isCurrentAppServer()) {
        throw new Error("Codex app-server changed while connecting.");
      }

      let socket: WebSocket | null = null;
      try {
        socket = await this.openRpcSocket(
          url,
          appServerAuthToken,
          deadline - Date.now(),
        );
        if (!isCurrentAppServer()) {
          try {
            socket.close();
          } catch {
            // Best effort cleanup for a superseded connection attempt.
          }
          throw new Error("Codex app-server changed while connecting.");
        }
        this.attachRpcSocket(socket);
        await this.initializeRpcClient();
        if (!isCurrentAppServer() || this.rpcSocket !== socket) {
          throw new Error("Codex app-server changed while connecting.");
        }
        return;
      } catch (err) {
        lastError = describeUnknownError(err);
        if (socket && this.rpcSocket === socket) {
          await this.disconnectRpcClient();
        } else if (socket) {
          try {
            socket.close();
          } catch {
            // Best effort cleanup for a superseded connection attempt.
          }
        }
        if (this.isRpcSocketOpen()) {
          return;
        }
        if (!isCurrentAppServer()) {
          throw new Error("Codex app-server changed while connecting.", {
            cause: err,
          });
        }
        await delay(CODEX_RPC_CONNECT_RETRY_MS);
      }
    }

    throw new Error(`Failed to connect to Codex app-server websocket: ${lastError}`);
  }

  private async openRpcSocket(
    url: string,
    authToken: string | null,
    timeoutMs: number,
  ): Promise<WebSocket> {
    if (!authToken) {
      throw new Error("Codex app-server websocket auth token is unavailable.");
    }

    return await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          socket.close();
        } catch {
          // Best effort cleanup after timeout.
        }
        reject(new Error(`Timed out opening Codex websocket ${url}.`));
      }, Math.max(500, timeoutMs));

      const cleanup = () => {
        clearTimeout(timer);
      };

      socket.addEventListener(
        "open",
        () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(socket);
        },
        { once: true },
      );

      socket.addEventListener(
        "error",
        () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(new Error(`Failed to open Codex websocket ${url}.`));
        },
        { once: true },
      );
    });
  }

  private attachRpcSocket(socket: WebSocket): void {
    this.rpcSocket = socket;
    this.rpcShuttingDown = false;
    this.subscribedThreadIds.clear();

    socket.addEventListener("message", (event) => {
      this.handleRpcMessageData(event.data);
    });
    socket.addEventListener("close", () => {
      this.handleRpcSocketClosed();
    });
  }

  private async disconnectRpcClient(): Promise<void> {
    const socket = this.rpcSocket;
    this.rpcSocket = null;
    this.rpcShuttingDown = true;
    this.subscribedThreadIds.clear();
    this.rejectPendingRpcRequests("Codex websocket connection closed.");

    if (!socket) {
      this.rpcShuttingDown = false;
      return;
    }

    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      socket.addEventListener("close", () => finish(), { once: true });
      const timer = setTimeout(() => finish(), 1_000);
      timer.unref?.();

      try {
        socket.close();
      } catch {
        finish();
      }
    });

    this.rpcShuttingDown = false;
  }

  private handleRpcSocketClosed(): void {
    const expectedShutdown = shouldSuppressCodexTransportFatalError({
      transportShuttingDown: this.rpcShuttingDown,
      shuttingDown: this.shuttingDown,
      cleanPanelExitInProgress: this.cleanPanelExitInProgress,
    });
    this.rpcSocket = null;
    this.subscribedThreadIds.clear();
    this.rejectPendingRpcRequests("Codex websocket connection closed.");
    this.rpcShuttingDown = false;

    if (expectedShutdown) {
      return;
    }

    if (
      this.usesDesktopTransport() &&
      this.desktopTransportStarted &&
      (!this.appServer || !this.appServerPort)
    ) {
      this.scheduleDesktopMetadataRecovery(
        `codex app-server websocket closed unexpectedly.${this.describeAppServerLog()}`,
      );
      return;
    }

    void this.reconnectRpcClientAfterUnexpectedClose();
  }

  private async reconnectRpcClientAfterUnexpectedClose(): Promise<boolean> {
    if (this.rpcReconnectPromise) {
      return await this.rpcReconnectPromise;
    }

    this.rpcReconnectPromise = (async () => {
      if (
        shouldSuppressCodexTransportFatalError({
          transportShuttingDown: this.rpcShuttingDown,
          shuttingDown: this.shuttingDown,
          cleanPanelExitInProgress: this.cleanPanelExitInProgress,
        })
      ) {
        return false;
      }

      if (!this.appServer || !this.appServerPort) {
        if (
          shouldSuppressCodexTransportFatalError({
            transportShuttingDown: this.appServerShuttingDown,
            shuttingDown: this.shuttingDown,
            cleanPanelExitInProgress: this.cleanPanelExitInProgress,
          })
        ) {
          return false;
        }
        if (this.usesDesktopTransport() && this.desktopTransportStarted) {
          return await this.recoverDesktopMetadataAppServer(
            `codex app-server websocket closed unexpectedly.${this.describeAppServerLog()}`,
          );
        }
        const details = this.describeAppServerLog();
        this.emit({
          type: "fatal_error",
          message: `codex app-server websocket closed unexpectedly.${details}`,
          timestamp: nowIso(),
        });
        this.terminateCodexClient();
        return false;
      }

      const reconnectDeadline = Date.now() + CODEX_RPC_RECONNECT_TIMEOUT_MS;
      let lastError = "Codex websocket connection closed.";

      while (
        !this.shuttingDown &&
        !this.cleanPanelExitInProgress &&
        Date.now() < reconnectDeadline
      ) {
        try {
          await this.connectRpcClient();
          return true;
        } catch (error) {
          lastError = describeUnknownError(error);
          await delay(CODEX_RPC_CONNECT_RETRY_MS);
        }
      }

      const details = this.describeAppServerLog();
      if (
        shouldSuppressCodexTransportFatalError({
          transportShuttingDown: this.appServerShuttingDown,
          shuttingDown: this.shuttingDown,
          cleanPanelExitInProgress: this.cleanPanelExitInProgress,
        })
      ) {
        return false;
      }
      if (this.usesDesktopTransport() && this.desktopTransportStarted) {
        return await this.recoverDesktopMetadataAppServer(
          `codex app-server websocket closed unexpectedly and could not reconnect: ${lastError}.${details}`,
        );
      }
      this.emit({
        type: "fatal_error",
        message: `codex app-server websocket closed unexpectedly and could not reconnect: ${lastError}.${details}`,
        timestamp: nowIso(),
      });
      this.terminateCodexClient();
      return false;
    })();

    try {
      return await this.rpcReconnectPromise;
    } finally {
      this.rpcReconnectPromise = null;
    }
  }

  private rejectPendingRpcRequests(message: string): void {
    for (const pending of this.pendingRpcRequests.values()) {
      pending.reject(new Error(message));
    }
    this.pendingRpcRequests.clear();
  }

  private async initializeRpcClient(): Promise<void> {
    await this.sendRpcRequest("initialize", {
      clientInfo: {
        name: "werelay-bridge",
        title: "WeRelay",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  private async restoreInitialSharedThreadIfNeeded(): Promise<void> {
    if (!this.resumeThreadId || this.isNativePanelMode()) {
      return;
    }

    const threadId = this.resumeThreadId;
    this.resumeThreadId = null;

    try {
      if (this.usesDesktopTransport()) {
        await this.restoreDesktopThreadInBackground(threadId);
      } else {
        await this.resumeSharedThread(threadId, { startup: true });
      }
    } catch (error) {
      this.updateSharedThread(null);
      this.emit({
        type: "status",
        status: "starting",
        message: `Failed to restore the previous Codex thread ${threadId.slice(0, 12)}. Starting without resume: ${describeUnknownError(error)}`,
        timestamp: nowIso(),
      });
    }
  }

  private async ensureThreadStarted(): Promise<string> {
    if (this.sharedThreadId) {
      return this.sharedThreadId;
    }

    const permissionSettings = this.resolveDesktopPermissionSettings();
    const response = await this.sendRpcRequest("thread/start", {
      cwd: this.options.cwd,
      approvalPolicy: permissionSettings.approvalPolicy,
      approvalsReviewer: permissionSettings.approvalsReviewer,
      sandbox: permissionSettings.sandbox,
      serviceName: "werelay-bridge",
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });

    const threadId = this.extractThreadIdFromResponse(response);
    if (!threadId) {
      throw new Error("Codex did not return a thread id for the bridge session.");
    }

    this.rememberBridgeOwnedThreadSignal(threadId);
    this.subscribedThreadIds.add(threadId);
    this.updateSharedThread(threadId);
    return threadId;
  }

  private async tryEnsureSharedThreadSubscribed(threadId: string): Promise<boolean> {
    if (this.subscribedThreadIds.has(threadId)) {
      return true;
    }

    try {
      await this.ensureSharedThreadSubscribed(threadId);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureSharedThreadSubscribed(threadId: string): Promise<void> {
    if (this.subscribedThreadIds.has(threadId)) {
      return;
    }

    const cwd = this.getKnownThreadCwd(threadId);
    const permissionSettings = this.resolveDesktopPermissionSettings(threadId);
    const response = await this.sendRpcRequest("thread/resume", {
      threadId,
      cwd,
      approvalPolicy: permissionSettings.approvalPolicy,
      approvalsReviewer: permissionSettings.approvalsReviewer,
      sandbox: permissionSettings.sandbox,
      excludeTurns: true,
    });

    const resumedThreadId = this.extractThreadIdFromResponse(response);
    if (!resumedThreadId) {
      throw new Error("Codex did not return a thread id while subscribing the bridge client.");
    }

    this.rememberBridgeOwnedThreadSignal(resumedThreadId);
    this.subscribedThreadIds.add(resumedThreadId);
    if (resumedThreadId !== this.sharedThreadId) {
      this.updateSharedThread(resumedThreadId);
    }
  }

  private async resumeSharedThread(
    threadId: string,
    options: { startup?: boolean; cwd?: string } = {},
  ): Promise<void> {
    const trimmedThreadId = threadId.trim();
    if (!trimmedThreadId) {
      throw new Error("A thread id is required to resume a Codex thread.");
    }

    if (this.usesDesktopTransport()) {
      await this.resumeDesktopThread(trimmedThreadId, {
        startup: options.startup,
      });
      return;
    }

    if (!this.usesRpcTurnTransport()) {
      if (this.pendingApproval) {
        throw new Error("Codex 有操作等待确认，请回复 1 允许本次，回复 2 拒绝，或回复 3 本任务始终允许。");
      }

      if (
        !options.startup &&
        (this.pendingTurnStart ||
          this.activeTurn ||
          this.pendingUserInputRequests.length > 0 ||
          this.state.status === "busy" ||
          this.state.status === "awaiting_approval" ||
          this.state.status === "awaiting_input")
      ) {
        throw new Error("codex is still working. Wait for the current reply or use /stop.");
      }
    }

    const cwd = options.cwd ?? await this.resolveDesktopThreadCwd(trimmedThreadId);
    const permissionSettings = this.resolveDesktopPermissionSettings(trimmedThreadId);
    const response = await this.sendRpcRequest("thread/resume", {
      threadId: trimmedThreadId,
      cwd,
      approvalPolicy: permissionSettings.approvalPolicy,
      approvalsReviewer: permissionSettings.approvalsReviewer,
      sandbox: permissionSettings.sandbox,
      excludeTurns: true,
    });

    const resumedThreadId = this.extractThreadIdFromResponse(response);
    if (!resumedThreadId) {
      throw new Error("Codex did not return a thread id while resuming the saved thread.");
    }

    if (cwd) {
      this.desktopThreadCwdById.set(resumedThreadId, cwd);
    }
    this.rememberBridgeOwnedThreadSignal(resumedThreadId);
    this.subscribedThreadIds.add(resumedThreadId);
    this.sessionFilePath = null;
    this.sessionReadOffset = 0;
    this.sessionPartialLine = "";
    this.sessionFinalText = null;
    this.pendingThreadFollowId = null;
    if (
      this.usesRpcTurnTransport() &&
      this.activeTurn &&
      this.activeTurn.threadId !== resumedThreadId
    ) {
      this.moveActiveTurnToBackground();
    }
    this.updateSharedThread(resumedThreadId, {
      source: options.startup ? "restore" : "wechat",
      reason: options.startup ? "startup_restore" : "wechat_resume",
      notify: true,
    });
    if (this.usesRpcTurnTransport()) {
      this.syncSelectedThreadState();
    }
  }

  private getKnownThreadCwd(threadId: string | null | undefined): string {
    return (threadId ? this.desktopThreadCwdById.get(threadId) : undefined) ?? this.options.cwd;
  }

  private async resolveDesktopThreadCwd(threadId: string): Promise<string> {
    const trimmedThreadId = threadId.trim();
    const knownCwd = this.desktopThreadCwdById.get(trimmedThreadId);
    if (knownCwd) {
      return knownCwd;
    }

    try {
      const response = await this.sendRpcRequest("thread/read", {
        threadId: trimmedThreadId,
        includeTurns: false,
      });
      const cwd = this.extractThreadCwdFromResponse(response);
      if (cwd) {
        this.desktopThreadCwdById.set(trimmedThreadId, cwd);
        return cwd;
      }
    } catch {
      // Preserve the previous same-workspace behavior when thread/read is unavailable.
    }

    return this.options.cwd;
  }

  private extractThreadCwdFromResponse(response: unknown): string | null {
    if (!isRecord(response) || !isRecord(response.thread)) {
      return null;
    }
    return typeof response.thread.cwd === "string" && response.thread.cwd.trim()
      ? response.thread.cwd.trim()
      : null;
  }

  private extractThreadIdFromResponse(response: unknown): string | null {
    if (!isRecord(response) || !isRecord(response.thread)) {
      return null;
    }
    return typeof response.thread.id === "string" ? response.thread.id : null;
  }

  private extractTurnIdFromResponse(response: unknown): string | null {
    if (!isRecord(response) || !isRecord(response.turn)) {
      return null;
    }
    return typeof response.turn.id === "string" ? response.turn.id : null;
  }

  private bindActiveTurn(activeTurn: CodexActiveTurn): void {
    this.pendingTurnStart = false;
    this.pendingTurnThreadId = null;
    this.bridgeOwnedTurnIds.add(activeTurn.turnId);
    if (!this.turnStartedAtMs.has(activeTurn.turnId)) {
      this.turnStartedAtMs.set(activeTurn.turnId, Date.now());
    }
    this.turnPreviewById.set(activeTurn.turnId, this.currentPreview);
    this.setActiveTurn(activeTurn);

    const queuedNotifications = this.queuedTurnNotifications;
    this.queuedTurnNotifications = [];
    for (const notification of queuedNotifications) {
      this.handleRpcNotification(notification.method, notification.params);
    }

    const queuedRequests = this.queuedTurnServerRequests;
    this.queuedTurnServerRequests = [];
    for (const request of queuedRequests) {
      this.handleRpcServerRequest(request.requestId, request.method, request.params);
    }
  }

  private async requestActiveTurnInterrupt(): Promise<void> {
    if (!this.activeTurn) {
      return;
    }

    await this.sendRpcRequest(
      "turn/interrupt",
      {
        threadId: this.activeTurn.threadId,
        turnId: this.activeTurn.turnId,
      },
      {
        allowDesktopBootstrapWrite: this.desktopBootstrapThreadIds.has(
          this.activeTurn.threadId,
        ),
      },
    );
  }

  private armInterruptFallback(turn: CodexActiveTurn | null = this.activeTurn): void {
    this.clearInterruptTimer();
    this.interruptFallbackTurn = turn;
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      const interruptedTurn = this.interruptFallbackTurn;
      this.interruptFallbackTurn = null;
      if (!interruptedTurn) {
        return;
      }

      const stillTracked =
        this.activeTurn?.turnId === interruptedTurn.turnId ||
        this.backgroundTurns.has(interruptedTurn.turnId);
      if (!stillTracked) {
        return;
      }

      this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
        (request) => request.turnId !== interruptedTurn.turnId,
      );
      this.pendingUserInputRequests = this.pendingUserInputRequests.filter(
        (request) => request.turnId !== interruptedTurn.turnId,
      );
      if (this.activeTurn?.turnId === interruptedTurn.turnId) {
        this.setActiveTurn(null, { followPendingThread: false });
      }
      this.backgroundTurns.delete(interruptedTurn.turnId);
      this.cleanupTurnArtifacts(interruptedTurn.turnId);
      this.syncSelectedThreadState(
        interruptedTurn.threadId === this.sharedThreadId
          ? "Codex task interrupted."
          : undefined,
      );
      this.emit({
        type: "task_complete",
        summary: "Interrupted",
        outcome: "interrupted",
        timestamp: nowIso(),
        threadId: interruptedTurn.threadId,
        turnId: interruptedTurn.turnId,
        origin: interruptedTurn.origin,
      });
      this.rememberCompletedTurn(interruptedTurn.turnId);
    }, INTERRUPT_SETTLE_DELAY_MS);
  }

  private clearInterruptTimer(): void {
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = null;
    }
    this.interruptFallbackTurn = null;
  }

  private clearInterruptTimerForTurn(turnId: string): void {
    if (this.interruptFallbackTurn?.turnId === turnId) {
      this.clearInterruptTimer();
    }
  }

  private recoverStaleBusyStateIfNeeded(): void {
    if (
      !shouldRecoverCodexStaleBusyState({
        status: this.state.status,
        pendingTurnStart: this.pendingTurnStart,
        hasActiveTurn: Boolean(this.activeTurn),
        hasPendingApproval: Boolean(
          this.getPendingApprovalRequestsForThread(this.sharedThreadId).length,
        ),
        hasPendingUserInput: Boolean(
          this.getPendingUserInputRequestsForThread(this.sharedThreadId).length,
        ),
        activeTurnId: this.state.activeTurnId,
      })
    ) {
      return;
    }

    this.pendingTurnStart = false;
    this.pendingTurnThreadId = null;
    this.interruptPendingTurnStart = false;
    this.state.activeTurnId = undefined;
    this.state.activeTurnOrigin = undefined;
    this.clearInterruptTimer();
    this.setStatus("idle", "Recovered stale busy state.");
  }

  private recoverStaleActiveTurnStateIfNeeded(): void {
    if (
      !this.activeTurn ||
      this.pendingTurnStart ||
      this.getPendingApprovalRequestsForThread(this.sharedThreadId).length > 0 ||
      this.state.status === "busy" ||
      this.state.status === "awaiting_approval" ||
      this.state.activeTurnId
    ) {
      return;
    }

    this.cleanupTurnArtifacts(this.activeTurn.turnId);
    this.setActiveTurn(null);
    this.clearInterruptTimer();
  }

  private resetTurnTracking(options: { preserveThread: boolean }): void {
    this.clearInterruptTimer();
    this.clearFinalReplyCompletionTimer();
    if (this.activeTurn) {
      this.cleanupTurnArtifacts(this.activeTurn.turnId);
    }
    for (const backgroundTurn of this.backgroundTurns.values()) {
      this.cleanupTurnArtifacts(backgroundTurn.turnId);
    }
    this.backgroundTurns.clear();
    this.setActiveTurn(null);
    this.pendingTurnStart = false;
    this.pendingTurnThreadId = null;
    this.pendingDesktopTurnThreadIds.clear();
    this.interruptPendingTurnStart = false;
    this.pendingThreadFollowId = null;
    this.clearPendingApprovalState();
    this.clearPendingUserInputState();
    this.queuedTurnNotifications = [];
    this.queuedTurnServerRequests = [];
    this.turnFinalMessages.clear();
    this.turnDeltaByItem.clear();
    this.turnErrorById.clear();
    this.turnLastActivityAtMs.clear();
    this.turnPreviewById.clear();
    this.mirroredUserInputTurnIds.clear();
    this.bridgeOwnedTurnIds.clear();
    this.completedTurnIds.clear();
    this.completedTurnOrder = [];
    this.pendingInjectedInputs = [];
    this.recentBridgeThreadSignalAtById.clear();
    this.sessionFinalText = null;
    this.nextSessionFallbackScanAtMs = 0;
    this.nextSessionFileLookupAtMs = 0;
    this.state.activeTurnId = undefined;
    this.state.activeTurnOrigin = undefined;
    if (!options.preserveThread) {
      this.clearPendingThreadAnnouncement();
      this.announcedThreadId = null;
    }
    if (!options.preserveThread) {
      this.updateSharedThread(null);
    }
  }

  private updateSharedThread(
    threadId: string | null,
    options: {
      source?: BridgeThreadSwitchSource;
      reason?: BridgeThreadSwitchReason;
      notify?: boolean;
    } = {},
  ): void {
    const previousThreadId = this.sharedThreadId;
    this.sharedThreadId = threadId;
    this.state.sharedSessionId = threadId ?? undefined;
    this.state.sharedThreadId = threadId ?? undefined;
    if (!threadId) {
      this.clearPendingThreadAnnouncement();
      this.announcedThreadId = null;
    } else if (
      previousThreadId !== threadId &&
      this.pendingThreadAnnouncement &&
      this.pendingThreadAnnouncement.threadId !== threadId
    ) {
      this.clearPendingThreadAnnouncement();
    }
    if (threadId && options.source && options.reason) {
      const switchedAt = nowIso();
      this.state.lastSessionSwitchAt = switchedAt;
      this.state.lastSessionSwitchSource = options.source;
      this.state.lastSessionSwitchReason = options.reason;
      this.state.lastThreadSwitchAt = switchedAt;
      this.state.lastThreadSwitchSource = options.source;
      this.state.lastThreadSwitchReason = options.reason;
      if (options.notify) {
        this.emitThreadSwitched(threadId, options.source, options.reason);
      }
    }
    if (previousThreadId !== threadId) {
      this.sessionFilePath = null;
      this.sessionReadOffset = 0;
      this.sessionPartialLine = "";
      this.sessionFinalText = null;
      this.sessionIgnoreBeforeMs = threadId ? Date.now() : null;
      this.nextSessionFallbackScanAtMs = 0;
      this.nextSessionFileLookupAtMs = 0;
      this.emit({
        type: "status",
        status: this.state.status,
        timestamp: nowIso(),
      });
    }
  }

  private setActiveTurn(
    activeTurn: CodexActiveTurn | null,
    options: { followPendingThread?: boolean } = {},
  ): void {
    this.activeTurn = activeTurn;
    this.state.activeTurnId = activeTurn?.turnId;
    this.state.activeTurnOrigin = activeTurn?.origin;
    if (
      !activeTurn &&
      options.followPendingThread !== false &&
      this.pendingThreadFollowId
    ) {
      const pendingThreadId = this.pendingThreadFollowId;
      this.pendingThreadFollowId = null;
      this.trackLocalSharedThread(pendingThreadId, {
        reason: "local_follow",
        signal: "status_changed",
      });
    }
  }

  private getBackgroundTurnForThread(threadId: string): CodexActiveTurn | null {
    for (const turn of this.backgroundTurns.values()) {
      if (turn.threadId === threadId) {
        return turn;
      }
    }
    return null;
  }

  private hasTrackedTurnForThread(threadId: string): boolean {
    return (
      this.activeTurn?.threadId === threadId ||
      Boolean(this.getBackgroundTurnForThread(threadId))
    );
  }

  private moveActiveTurnToBackground(): void {
    if (!this.activeTurn) {
      return;
    }
    this.backgroundTurns.set(this.activeTurn.turnId, this.activeTurn);
    this.setActiveTurn(null, { followPendingThread: false });
  }

  private promoteBackgroundTurnForThread(threadId: string): CodexActiveTurn | null {
    const turn = this.getBackgroundTurnForThread(threadId);
    if (!turn) {
      return null;
    }
    this.backgroundTurns.delete(turn.turnId);
    this.setActiveTurn(turn, { followPendingThread: false });
    return turn;
  }

  private getPendingApprovalRequestsForThread(
    threadId: string | null | undefined,
  ): CodexPendingApprovalRequest[] {
    if (!threadId) {
      return [];
    }
    this.reconcileDesktopApprovalRequests(threadId);
    return this.pendingApprovalRequests.filter((request) => request.threadId === threadId);
  }

  private getPendingUserInputRequestsForThread(
    threadId: string | null | undefined,
  ): CodexPendingUserInputRequest[] {
    if (!threadId) {
      return [];
    }
    return this.pendingUserInputRequests.filter((request) => request.threadId === threadId);
  }

  private syncSelectedThreadState(
    message?: string,
    options: { recoverConnectionError?: boolean } = {},
  ): void {
    const selectedThreadId = this.sharedThreadId;
    if (
      selectedThreadId &&
      (!this.activeTurn || this.activeTurn.threadId !== selectedThreadId)
    ) {
      this.promoteBackgroundTurnForThread(selectedThreadId);
    }

    const selectedApproval =
      this.getPendingApprovalRequestsForThread(selectedThreadId)[0] ?? null;
    const selectedUserInput =
      this.getPendingUserInputRequestsForThread(selectedThreadId)[0] ?? null;
    this.pendingApproval = selectedApproval?.request ?? null;
    this.state.pendingApproval = selectedApproval?.request ?? null;
    this.state.pendingApprovalOrigin = selectedApproval?.origin;
    this.state.pendingUserInput = selectedUserInput?.request ?? null;
    this.state.pendingUserInputOrigin = selectedUserInput?.origin;

    if (
      this.state.status === "stopped" ||
      this.state.status === "starting" ||
      (this.state.status === "error" && !options.recoverConnectionError)
    ) {
      return;
    }

    const nextStatus = selectedApproval
      ? "awaiting_approval"
      : selectedUserInput
        ? "awaiting_input"
        : this.activeTurn ||
            (this.pendingTurnStart && this.pendingTurnThreadId === selectedThreadId)
          ? "busy"
          : "idle";
    if (this.state.status !== nextStatus || message) {
      this.setStatus(nextStatus, message);
    }
  }

  private clearPendingThreadAnnouncement(): void {
    if (!this.pendingThreadAnnouncement) {
      return;
    }
    if (this.pendingThreadAnnouncement.timer) {
      clearTimeout(this.pendingThreadAnnouncement.timer);
    }
    this.pendingThreadAnnouncement = null;
  }

  private emitThreadSwitched(
    threadId: string,
    source: BridgeThreadSwitchSource,
    reason: BridgeThreadSwitchReason,
  ): void {
    if (this.announcedThreadId === threadId) {
      if (this.pendingThreadAnnouncement?.threadId === threadId) {
        this.clearPendingThreadAnnouncement();
      }
      return;
    }

    if (this.pendingThreadAnnouncement?.threadId === threadId) {
      this.clearPendingThreadAnnouncement();
    }

    const switchedAt = nowIso();
    this.announcedThreadId = threadId;
    this.state.lastSessionSwitchAt = switchedAt;
    this.state.lastSessionSwitchSource = source;
    this.state.lastSessionSwitchReason = reason;
    this.state.lastThreadSwitchAt = switchedAt;
    this.state.lastThreadSwitchSource = source;
    this.state.lastThreadSwitchReason = reason;
    this.emit({
      type: "thread_switched",
      threadId,
      source,
      reason,
      timestamp: switchedAt,
    });
  }

  private isPendingThreadAnnouncementStable(
    pending: CodexPendingThreadAnnouncement,
  ): boolean {
    return pending.signals.has("user_message") || pending.signals.size >= 2;
  }

  private schedulePendingThreadAnnouncement(): void {
    const pending = this.pendingThreadAnnouncement;
    if (!pending || pending.timer || !this.isNativePanelMode()) {
      return;
    }

    pending.timer = setTimeout(() => {
      const current = this.pendingThreadAnnouncement;
      if (!current || current.threadId !== pending.threadId) {
        return;
      }
      current.timer = null;
      this.updateSharedThread(current.threadId, {
        source: current.source,
        reason: current.reason,
        notify: true,
      });
    }, CODEX_LOCAL_THREAD_ANNOUNCE_SETTLE_MS);
    pending.timer.unref?.();
  }

  private trackLocalSharedThread(
    threadId: string,
    options: {
      reason: BridgeThreadSwitchReason;
      signal: CodexThreadAnnouncementSignal;
    },
  ): void {
    if (!this.isNativePanelMode()) {
      this.updateSharedThread(threadId, {
        source: "local",
        reason: options.reason,
        notify: true,
      });
      return;
    }

    this.updateSharedThread(threadId, {
      source: "local",
      reason: options.reason,
    });

    if (this.announcedThreadId === threadId) {
      if (this.pendingThreadAnnouncement?.threadId === threadId) {
        this.clearPendingThreadAnnouncement();
      }
      return;
    }

    if (!this.pendingThreadAnnouncement || this.pendingThreadAnnouncement.threadId !== threadId) {
      this.clearPendingThreadAnnouncement();
      this.pendingThreadAnnouncement = {
        threadId,
        source: "local",
        reason: options.reason,
        signals: new Set<CodexThreadAnnouncementSignal>(),
        timer: null,
      };
    }

    this.pendingThreadAnnouncement.source = "local";
    this.pendingThreadAnnouncement.reason = options.reason;
    this.pendingThreadAnnouncement.signals.add(options.signal);

    if (this.isPendingThreadAnnouncementStable(this.pendingThreadAnnouncement)) {
      this.updateSharedThread(threadId, {
        source: "local",
        reason: options.reason,
        notify: true,
      });
      return;
    }

    this.schedulePendingThreadAnnouncement();
  }

  private rememberBridgeOwnedThreadSignal(threadId: string): void {
    const cutoff = Date.now() - CODEX_THREAD_SIGNAL_TTL_MS;
    for (const [candidateThreadId, recordedAtMs] of this.recentBridgeThreadSignalAtById.entries()) {
      if (recordedAtMs < cutoff) {
        this.recentBridgeThreadSignalAtById.delete(candidateThreadId);
      }
    }
    this.recentBridgeThreadSignalAtById.set(threadId, Date.now());
  }

  private isRecentlyBridgeOwnedThread(threadId: string): boolean {
    const recordedAtMs = this.recentBridgeThreadSignalAtById.get(threadId);
    if (!recordedAtMs) {
      return false;
    }
    if (recordedAtMs < Date.now() - CODEX_THREAD_SIGNAL_TTL_MS) {
      this.recentBridgeThreadSignalAtById.delete(threadId);
      return false;
    }
    return true;
  }

  private clearPendingApprovalState(): void {
    this.pendingApprovalRequests = [];
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
  }

  private clearPendingApprovalStateForTurn(turnId: string): void {
    this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
      (request) => request.turnId !== turnId,
    );
    this.syncSelectedThreadState();
  }

  private clearPendingApprovalStateForThread(threadId: string): void {
    this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
      (request) => request.threadId !== threadId,
    );
    this.syncSelectedThreadState();
  }

  private clearPendingUserInputState(): void {
    this.pendingUserInputRequests = [];
    this.state.pendingUserInput = null;
    this.state.pendingUserInputOrigin = undefined;
  }

  private clearPendingUserInputStateForTurn(turnId: string): void {
    this.pendingUserInputRequests = this.pendingUserInputRequests.filter(
      (request) => request.turnId !== turnId,
    );
    this.syncSelectedThreadState();
  }

  private clearPendingUserInputStateForThread(threadId: string): void {
    this.pendingUserInputRequests = this.pendingUserInputRequests.filter(
      (request) => request.threadId !== threadId,
    );
    this.syncSelectedThreadState();
  }

  private cleanupTurnArtifacts(turnId: string): void {
    this.clearFinalReplyCompletionTimerForTurn(turnId);
    this.turnFinalMessages.delete(turnId);
    this.turnDeltaByItem.delete(turnId);
    this.turnErrorById.delete(turnId);
    this.turnStartedAtMs.delete(turnId);
    this.turnLastActivityAtMs.delete(turnId);
    this.turnPreviewById.delete(turnId);
    this.mirroredUserInputTurnIds.delete(turnId);
    this.bridgeOwnedTurnIds.delete(turnId);
  }

  private rpcRequestKey(requestId: CodexRpcRequestId): string {
    return `${typeof requestId}:${String(requestId)}`;
  }

  private isRpcSocketOpen(): boolean {
    return Boolean(this.rpcSocket && this.rpcSocket.readyState === WebSocket.OPEN);
  }

  private async ensureRpcClientConnected(): Promise<void> {
    if (this.isRpcSocketOpen()) {
      return;
    }

    if (this.rpcReconnectPromise) {
      const reconnected = await this.rpcReconnectPromise;
      if (!reconnected || !this.isRpcSocketOpen()) {
        if (!(this.usesDesktopTransport() && this.desktopTransportStarted)) {
          throw new Error("Codex websocket is not connected.");
        }
      } else {
        return;
      }
    }

    if (
      this.usesDesktopTransport() &&
      this.desktopTransportStarted &&
      (!this.appServer || !this.appServerPort)
    ) {
      const recovered = await this.recoverDesktopMetadataAppServer(
        this.desktopMetadataUnavailableReason ?? "Codex 任务索引连接不可用。",
      );
      if (!recovered || !this.isRpcSocketOpen()) {
        throw new Error(
          "Codex 任务索引暂时不可用，请稍后重试；当前已打开任务仍可继续发送消息。",
        );
      }
      return;
    }

    await this.connectRpcClient();
    if (!this.isRpcSocketOpen()) {
      throw new Error("Codex websocket is not connected.");
    }
  }

  private async sendRpcRequest(
    method: string,
    params: unknown,
    options: { allowDesktopBootstrapWrite?: boolean } = {},
  ): Promise<unknown> {
    const allowedDesktopBootstrapWrite =
      options.allowDesktopBootstrapWrite === true &&
      (
        method === "thread/start" ||
        method === "thread/resume" ||
        method === "thread/unsubscribe" ||
        method === "turn/start" ||
        method === "turn/interrupt"
      );
    if (
      this.usesDesktopTransport() &&
      method !== "initialize" &&
      method !== "thread/list" &&
      method !== "thread/read" &&
      method !== "thread/name/set" &&
      method !== "model/list" &&
      !allowedDesktopBootstrapWrite
    ) {
      throw new Error(`桌面映射模式禁止通过独立 app-server 执行写操作：${method}`);
    }
    await this.ensureRpcClientConnected();
    const socket = this.rpcSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex websocket is not connected.");
    }

    const requestId = ++this.rpcRequestCounter;
    const requestKey = this.rpcRequestKey(requestId);
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcRequests.delete(requestKey);
        reject(new Error(`Codex RPC request timed out after 30s (method: ${method})`));
      }, 30_000);
      this.pendingRpcRequests.set(requestKey, {
        method,
        resolve: (value: unknown) => { clearTimeout(timer); resolve(value); },
        reject: (err: unknown) => { clearTimeout(timer); reject(err); },
      });
    });

    try {
      this.sendRpcMessage({
        id: requestId,
        method,
        params,
      });
    } catch (err) {
      this.pendingRpcRequests.delete(requestKey);
      throw err;
    }

    return await responsePromise;
  }

  private sendRpcMessage(payload: Record<string, unknown>): void {
    const socket = this.rpcSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Codex websocket is not connected.");
    }

    socket.send(JSON.stringify(payload));
  }

  private async respondToApprovalRequest(
    request: CodexPendingApprovalRequest,
    action: CodexApprovalResolutionAction,
  ): Promise<void> {
    if (
      this.usesDesktopTransport() &&
      !this.desktopBootstrapThreadIds.has(request.threadId)
    ) {
      const result = request.method === "item/permissions/requestApproval"
        ? buildCodexPermissionsRequestApprovalResponse(request.params, action)
        : request.method === "mcpServer/elicitation/request"
          ? buildCodexMcpServerElicitationResponse(action)
          : {
              decision: this.resolveDesktopApprovalDecision(request, action),
            };
      await this.respondToDesktopApprovalResult(request, result);
      return;
    }

    if (request.method === "item/permissions/requestApproval") {
      this.sendRpcMessage({
        id: request.requestId,
        result: buildCodexPermissionsRequestApprovalResponse(request.params, action),
      });
      return;
    }
    if (request.method === "mcpServer/elicitation/request") {
      this.sendRpcMessage({
        id: request.requestId,
        result: buildCodexMcpServerElicitationResponse(action),
      });
      return;
    }

    const decision = action === "deny"
      ? "decline"
      : action === "confirm_session"
        ? "acceptForSession"
        : "accept";
    this.sendRpcMessage({
      id: request.requestId,
      result: { decision },
    });
  }

  private resolveDesktopApprovalDecision(
    request: CodexPendingApprovalRequest,
    action: CodexApprovalResolutionAction,
  ): unknown {
    const availableDecisions = Array.isArray(request.params.availableDecisions)
      ? request.params.availableDecisions
      : [];
    if (action === "deny") {
      return availableDecisions.includes("cancel") ? "cancel" : "decline";
    }
    if (action === "confirm_session") {
      const amendment = availableDecisions.find(
        (decision) =>
          isRecord(decision) &&
          (isRecord(decision.acceptWithExecpolicyAmendment) ||
            isRecord(decision.accept_with_execpolicy_amendment)),
      );
      return amendment ?? "acceptForSession";
    }
    return "accept";
  }

  private async respondToDesktopApprovalResult(
    request: CodexPendingApprovalRequest,
    result: Record<string, unknown>,
  ): Promise<void> {
    const client = this.desktopIpcClient;
    if (!client) {
      throw new Error("Codex 桌面端连接不可用。");
    }
    if (request.method === "item/permissions/requestApproval") {
      await client.replyToPermissionsApproval(
        request.threadId,
        request.requestId,
        result,
      );
      await this.waitForDesktopApprovalRequestToClear(request);
      return;
    }
    if (request.method === "mcpServer/elicitation/request") {
      await client.replyToMcpServerElicitation(
        request.threadId,
        request.requestId,
        result,
      );
      await this.waitForDesktopApprovalRequestToClear(request);
      return;
    }
    const decision = result.decision;
    if (request.method === "item/fileChange/requestApproval") {
      await client.replyToFileApproval(
        request.threadId,
        request.requestId,
        decision,
      );
      await this.waitForDesktopApprovalRequestToClear(request);
      return;
    }
    await client.replyToCommandApproval(
      request.threadId,
      request.requestId,
      decision,
    );
    await this.waitForDesktopApprovalRequestToClear(request);
  }

  private async waitForDesktopApprovalRequestToClear(
    request: CodexPendingApprovalRequest,
  ): Promise<void> {
    const client = this.desktopIpcClient as (CodexDesktopIpcClient & {
      getThreadStateView?: (
        threadId: string,
      ) => CodexDesktopConversationState | null;
    }) | null;
    if (!client?.getThreadStateView) {
      return;
    }
    const deadline = Date.now() + this.desktopApprovalSettleTimeoutMs;
    while (true) {
      const state = client.getThreadStateView(request.threadId);
      const stillPending = Boolean(
        state &&
        Array.isArray(state.requests) &&
        state.requests.some((value) =>
          isRecord(value) &&
          value.id === request.requestId &&
          value.method === request.method
        ),
      );
      if (state && !stillPending) {
        return;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Codex 桌面端仍在等待审批：${request.method}#${String(request.requestId)}`,
        );
      }
      await delay(Math.min(50, remainingMs));
    }
  }

  private handleRpcMessageData(data: unknown): void {
    const text = coerceWebSocketMessageData(data);
    if (!text) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }

    if (!isRecord(payload)) {
      return;
    }

    const requestId = getCodexRpcRequestId(payload.id);
    const method = typeof payload.method === "string" ? payload.method : null;

    if (requestId !== null && method) {
      this.handleRpcServerRequest(requestId, method, payload.params);
      return;
    }

    if (requestId !== null) {
      this.handleRpcResponse(requestId, payload);
      return;
    }

    if (method) {
      this.handleRpcNotification(method, payload.params);
    }
  }

  private handleRpcResponse(requestId: CodexRpcRequestId, payload: Record<string, unknown>): void {
    const requestKey = this.rpcRequestKey(requestId);
    const pending = this.pendingRpcRequests.get(requestKey);
    if (!pending) {
      return;
    }

    this.pendingRpcRequests.delete(requestKey);
    if (payload.error !== undefined && payload.error !== null) {
      pending.reject(new Error(normalizeCodexRpcError(payload.error)));
      return;
    }

    pending.resolve(payload.result);
  }

  private handleRpcNotification(method: string, params: unknown): void {
    if (!isRecord(params)) {
      return;
    }

    if (method === "thread/started") {
      this.handleThreadStarted(params);
      return;
    }

    if (method === "thread/status/changed") {
      this.handleThreadStatusChanged(params);
      return;
    }

    if (
      method === "item/started" ||
      method === "item/agentMessage/delta" ||
      method === "item/completed" ||
      method === "turn/completed" ||
      method === "turn/started" ||
      method === "error" ||
      method === "serverRequest/resolved"
    ) {
      if (this.shouldQueuePendingTurnEvent(params)) {
        this.queuedTurnNotifications.push({ method, params });
        return;
      }

      const trackedTurn = this.identifyTrackedTurn(method, params);
      if (!trackedTurn) {
        return;
      }

      this.handleTrackedTurnNotification(method, params, trackedTurn);
      return;
    }

    if (this.activeTurn) {
      this.state.lastOutputAt = nowIso();
    }
  }

  private shouldQueuePendingTurnEvent(params: Record<string, unknown>): boolean {
    if (!this.pendingTurnStart || this.activeTurn || !this.pendingTurnThreadId) {
      return false;
    }

    return getNotificationThreadId(params) === this.pendingTurnThreadId;
  }

  private identifyTrackedTurn(
    method: string,
    params: Record<string, unknown>,
  ): CodexActiveTurn | null {
    const threadId = getNotificationThreadId(params);
    const turnId = getNotificationTurnId(params);
    if (!threadId || !turnId) {
      return null;
    }

    if (this.bridgeOwnedTurnIds.has(turnId)) {
      return {
        threadId,
        turnId,
        origin: "wechat",
      };
    }

    if (this.activeTurn?.turnId === turnId) {
      return {
        threadId,
        turnId,
        origin: this.activeTurn.origin,
      };
    }

    const backgroundTurn = this.backgroundTurns.get(turnId);
    if (backgroundTurn) {
      return {
        threadId,
        turnId,
        origin: backgroundTurn.origin,
      };
    }

    const localBootstrapUserMessage =
      this.isNativePanelMode() &&
      !this.activeTurn &&
      (method === "item/started" || method === "item/completed") &&
      extractCodexUserMessageText(params.item);
    if (localBootstrapUserMessage) {
      return {
        threadId,
        turnId,
        origin: "local",
      };
    }

    if (this.sharedThreadId && threadId === this.sharedThreadId) {
      return {
        threadId,
        turnId,
        origin: "local",
      };
    }

    if (method === "turn/started" && !this.activeTurn) {
      return {
        threadId,
        turnId,
        origin: "local",
      };
    }

    return null;
  }

  private handleTrackedTurnNotification(
    method: string,
    params: Record<string, unknown>,
    trackedTurn: CodexActiveTurn,
  ): void {
    this.state.lastOutputAt = nowIso();
    this.recordTurnActivity(trackedTurn.turnId);
    this.handleTrackedTurnStarted(trackedTurn);

    switch (method) {
      case "item/started": {
        this.maybeMirrorLocalUserInput(trackedTurn, params.item);
        return;
      }

      case "item/agentMessage/delta": {
        const itemId = typeof params.itemId === "string" ? params.itemId : null;
        const delta = typeof params.delta === "string" ? params.delta : "";
        if (!itemId || !delta) {
          return;
        }

        const deltaByItem = this.getTurnDeltaMap(trackedTurn.turnId);
        const previous = deltaByItem.get(itemId) ?? "";
        deltaByItem.set(itemId, `${previous}${delta}`);
        return;
      }

      case "item/completed": {
        this.maybeMirrorLocalUserInput(trackedTurn, params.item);
        const itemId =
          isRecord(params.item) && typeof params.item.id === "string"
            ? params.item.id
            : null;
        const finalText = extractCodexFinalTextFromItem(params.item);
        if (itemId && finalText) {
          this.getTurnFinalMessageMap(trackedTurn.turnId).set(itemId, finalText);
          this.scheduleFinalReplyCompletionIfEligible(trackedTurn.turnId);
        }
        return;
      }

      case "error": {
        if (isRecord(params.error) && typeof params.error.message === "string") {
          this.turnErrorById.set(trackedTurn.turnId, params.error.message);
        }
        return;
      }

      case "serverRequest/resolved": {
        const requestId = getCodexRpcRequestId(params.requestId);
        if (requestId === null) {
          return;
        }
        const approvalResolved = this.pendingApprovalRequests.some(
          (request) =>
            request.requestId === requestId &&
            request.turnId === trackedTurn.turnId,
        );
        const userInputResolved = this.pendingUserInputRequests.some(
          (request) =>
            request.requestId === requestId &&
            request.turnId === trackedTurn.turnId,
        );
        if (approvalResolved) {
          this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
            (request) => request.requestId !== requestId,
          );
        }
        if (userInputResolved) {
          this.pendingUserInputRequests = this.pendingUserInputRequests.filter(
            (request) => request.requestId !== requestId,
          );
        }
        if (approvalResolved || userInputResolved) {
          this.syncSelectedThreadState(
            trackedTurn.threadId === this.sharedThreadId
              ? approvalResolved
                ? "Codex approval resolved."
                : "Codex user input resolved."
              : undefined,
          );
        }
        return;
      }

      case "turn/completed": {
        this.clearFinalReplyCompletionTimerForTurn(trackedTurn.turnId);
        this.handleTurnCompleted(trackedTurn, params);
        return;
      }
    }
  }

  private handleRpcServerRequest(
    requestId: CodexRpcRequestId,
    method: string,
    params: unknown,
  ): void {
    if (method === "mcpServer/elicitation/request") {
      this.sendRpcMessage({
        id: requestId,
        result: buildCodexMcpServerElicitationDeclineResponse(),
      });
      return;
    }

    if (method === "item/tool/call") {
      this.sendRpcMessage({
        id: requestId,
        result: buildCodexDynamicToolCallFailureResponse(),
      });
      return;
    }

    if (
      method !== "item/commandExecution/requestApproval" &&
      method !== "item/fileChange/requestApproval" &&
      method !== "item/permissions/requestApproval" &&
      method !== "item/tool/requestUserInput"
    ) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32601,
          message: `Unsupported server request: ${method}`,
        },
      });
      return;
    }

    if (!isRecord(params)) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32602,
          message: "Invalid Codex approval request payload.",
        },
      });
      return;
    }

    if (this.shouldQueuePendingTurnEvent(params)) {
      this.queuedTurnServerRequests.push({
        requestId,
        method,
        params,
      });
      return;
    }

    const trackedTurn =
      this.identifyTrackedTurn("server/request", params) ??
      this.fallbackTrackedTurnForServerRequest(params);
    if (!trackedTurn) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32602,
          message: "Invalid Codex server request payload: missing threadId or turnId.",
        },
      });
      return;
    }

    this.handleTrackedTurnStarted(trackedTurn);
    this.handleTrackedTurnServerRequest(requestId, method, params, trackedTurn);
  }

  private handleTrackedTurnServerRequest(
    requestId: CodexRpcRequestId,
    method: CodexPendingApprovalRequest["method"] | CodexPendingUserInputRequest["method"],
    params: Record<string, unknown>,
    trackedTurn: CodexActiveTurn,
  ): void {
    if (method === "item/tool/requestUserInput") {
      this.handleTrackedTurnUserInputRequest(requestId, params, trackedTurn);
      return;
    }

    const denyMessage = getCodexWechatOutboundAttachmentDenyMessage(method, params);
    if (denyMessage) {
      this.sendRpcMessage({
        id: requestId,
        result:
          method === "item/permissions/requestApproval"
            ? buildCodexPermissionsRequestApprovalResponse(params, "deny")
            : { decision: "decline" },
      });
      this.state.lastOutputAt = nowIso();
      if (trackedTurn.threadId === this.sharedThreadId) {
        this.setStatus(
          "busy",
          `Codex approval auto-denied: ${truncatePreview(denyMessage, 180)}`,
        );
      }
      return;
    }

    const autoResponse = getCodexApprovalAutoResponse(method, params);
    if (autoResponse) {
      this.sendRpcMessage({
        id: requestId,
        result: autoResponse.result,
      });
      this.state.lastOutputAt = nowIso();
      if (trackedTurn.threadId === this.sharedThreadId) {
        this.setStatus(
          "busy",
          `Codex approval auto-approved: ${truncatePreview(autoResponse.reason, 180)}`,
        );
      }
      return;
    }

    const request = buildCodexApprovalRequest(method, params);
    if (!request) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32602,
          message: "Invalid Codex approval request payload.",
        },
      });
      return;
    }

    const timestamp = nowIso();
    const contextualRequest = {
      ...request,
      requestId: String(requestId),
      createdAt: timestamp,
      threadId: trackedTurn.threadId,
      turnId: trackedTurn.turnId,
      origin: trackedTurn.origin,
    };
    this.pendingApprovalRequests.push({
      requestId,
      method,
      threadId: trackedTurn.threadId,
      turnId: trackedTurn.turnId,
      origin: trackedTurn.origin,
      params,
      request: contextualRequest,
    });
    this.state.lastOutputAt = nowIso();
    if (trackedTurn.threadId === this.sharedThreadId) {
      this.syncSelectedThreadState(
        `Codex approval is required: ${truncatePreview(request.commandPreview, 180)}`,
      );
    }
    this.emit({
      type: "approval_required",
      request: contextualRequest,
      timestamp,
      threadId: trackedTurn.threadId,
      turnId: trackedTurn.turnId,
      origin: trackedTurn.origin,
    });
  }

  private fallbackTrackedTurnForServerRequest(
    params: Record<string, unknown>,
  ): CodexActiveTurn | null {
    if (this.activeTurn) {
      return null;
    }

    const threadId = getNotificationThreadId(params);
    const turnId = getNotificationTurnId(params);
    if (!threadId || !turnId) {
      return null;
    }

    return {
      threadId,
      turnId,
      origin: this.bridgeOwnedTurnIds.has(turnId) ? "wechat" : "local",
    };
  }

  private handleTrackedTurnUserInputRequest(
    requestId: CodexRpcRequestId,
    params: Record<string, unknown>,
    trackedTurn: CodexActiveTurn,
  ): void {
    const request = buildCodexUserInputRequest(params);
    if (!request) {
      this.sendRpcMessage({
        id: requestId,
        error: {
          code: -32602,
          message: "Invalid Codex user input request payload.",
        },
      });
      return;
    }

    const contextualRequest = {
      ...request,
      threadId: trackedTurn.threadId,
      turnId: trackedTurn.turnId,
      origin: trackedTurn.origin,
    };
    this.pendingUserInputRequests.push({
      requestId,
      method: "item/tool/requestUserInput",
      threadId: trackedTurn.threadId,
      turnId: trackedTurn.turnId,
      origin: trackedTurn.origin,
      request: contextualRequest,
    });
    this.state.lastOutputAt = nowIso();
    if (trackedTurn.threadId === this.sharedThreadId) {
      this.syncSelectedThreadState("Codex is waiting for user input.");
    }
    this.emit({
      type: "user_input_required",
      request: contextualRequest,
      timestamp: nowIso(),
      threadId: trackedTurn.threadId,
      turnId: trackedTurn.turnId,
      origin: trackedTurn.origin,
    });
  }

  private handleThreadStatusChanged(params: Record<string, unknown>): void {
    const threadId = extractCodexThreadFollowIdFromStatusChanged(params);
    if (!threadId) {
      return;
    }

    if (
      threadId !== this.sharedThreadId &&
      this.hasTrackedTurnForThread(threadId)
    ) {
      return;
    }

    if (!this.activeTurn || this.activeTurn.threadId === threadId) {
      this.trackLocalSharedThread(threadId, {
        reason: "local_follow",
        signal: "status_changed",
      });
      this.pendingThreadFollowId = null;
      return;
    }

    this.pendingThreadFollowId = threadId;
  }

  private handleThreadStarted(params: Record<string, unknown>): void {
    const threadId = extractCodexThreadStartedThreadId(params);
    if (!threadId) {
      return;
    }

    if (this.isRecentlyBridgeOwnedThread(threadId)) {
      return;
    }

    const thread = isRecord(params.thread) ? params.thread : null;
    if (thread && typeof thread.cwd === "string" && thread.cwd.trim()) {
      this.desktopThreadCwdById.set(threadId, thread.cwd.trim());
    }

    if (
      threadId !== this.sharedThreadId &&
      this.hasTrackedTurnForThread(threadId)
    ) {
      return;
    }

    if (!this.activeTurn || this.activeTurn.threadId === threadId) {
      this.trackLocalSharedThread(threadId, {
        reason: "local_follow",
        signal: "thread_started",
      });
      this.pendingThreadFollowId = null;
      return;
    }

    this.pendingThreadFollowId = threadId;
  }

  private handleTrackedTurnStarted(trackedTurn: CodexActiveTurn): void {
    if (this.activeTurn?.turnId === trackedTurn.turnId) {
      return;
    }

    const existingBackground = this.backgroundTurns.get(trackedTurn.turnId);
    if (existingBackground) {
      if (trackedTurn.threadId === this.sharedThreadId && !this.activeTurn) {
        this.promoteBackgroundTurnForThread(trackedTurn.threadId);
        this.syncSelectedThreadState();
      }
      return;
    }

    if (
      trackedTurn.origin === "local" &&
      trackedTurn.threadId !== this.sharedThreadId
    ) {
      if (!this.activeTurn || this.activeTurn.threadId === trackedTurn.threadId) {
        this.trackLocalSharedThread(trackedTurn.threadId, {
          reason: "local_turn",
          signal: "turn_started",
        });
        this.pendingThreadFollowId = null;
      } else {
        this.pendingThreadFollowId = trackedTurn.threadId;
      }
    }

    if (!this.activeTurn && trackedTurn.threadId === this.sharedThreadId) {
      this.setActiveTurn(trackedTurn);
      if (trackedTurn.origin === "local" && this.state.status !== "awaiting_approval") {
        this.setStatus("busy", "Codex is busy with a local terminal turn.");
      } else {
        this.syncSelectedThreadState();
      }
      return;
    }

    this.backgroundTurns.set(trackedTurn.turnId, trackedTurn);
    if (
      trackedTurn.origin === "local" &&
      this.activeTurn &&
      this.activeTurn.threadId !== trackedTurn.threadId
    ) {
      this.pendingThreadFollowId = trackedTurn.threadId;
    }
  }

  private maybeMirrorLocalUserInput(
    trackedTurn: CodexActiveTurn,
    item: unknown,
  ): void {
    if (trackedTurn.origin !== "local" || this.mirroredUserInputTurnIds.has(trackedTurn.turnId)) {
      return;
    }

    const text = extractCodexUserMessageText(item);
    if (!text) {
      return;
    }

    this.trackLocalSharedThread(trackedTurn.threadId, {
      reason: "local_turn",
      signal: "user_message",
    });
    this.mirroredUserInputTurnIds.add(trackedTurn.turnId);
    this.emit({
      type: "mirrored_user_input",
      text,
      timestamp: nowIso(),
      origin: "local",
      threadId: trackedTurn.threadId,
      turnId: trackedTurn.turnId,
    });
  }

  private handleTurnCompleted(
    trackedTurn: CodexActiveTurn,
    params: Record<string, unknown>,
  ): void {
    this.clearFinalReplyCompletionTimerForTurn(trackedTurn.turnId);
    this.clearInterruptTimerForTurn(trackedTurn.turnId);
    if (this.hasCompletedTurn(trackedTurn.turnId)) {
      if (this.activeTurn?.turnId === trackedTurn.turnId) {
        this.setActiveTurn(null, { followPendingThread: false });
      }
      this.backgroundTurns.delete(trackedTurn.turnId);
      this.desktopListedRuntimeStatusByThreadId.set(trackedTurn.threadId, { type: "idle" });
      this.cleanupTurnArtifacts(trackedTurn.turnId);
      this.syncSelectedThreadState();
      this.continueDesktopTaskAfterTurn(trackedTurn.threadId);
      return;
    }

    const turn = isRecord(params.turn) ? params.turn : null;
    const status = turn && typeof turn.status === "string" ? turn.status : "completed";
    const completedError =
      turn && isRecord(turn.error) && typeof turn.error.message === "string"
        ? turn.error.message
        : this.turnErrorById.get(trackedTurn.turnId) ?? null;
    const finalText = this.collectTurnOutput(trackedTurn.turnId);
    const completedTrackedTurn =
      this.activeTurn?.turnId === trackedTurn.turnId ? this.activeTurn : trackedTurn;
    const preview = this.turnPreviewById.get(trackedTurn.turnId) ?? this.currentPreview;
    const summary =
      status === "interrupted"
        ? "Interrupted"
        : completedTrackedTurn.origin === "local"
          ? "Local terminal turn completed."
          : preview;

    this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
      (request) => request.turnId !== trackedTurn.turnId,
    );
    this.pendingUserInputRequests = this.pendingUserInputRequests.filter(
      (request) => request.turnId !== trackedTurn.turnId,
    );
    if (this.activeTurn?.turnId === trackedTurn.turnId) {
      this.setActiveTurn(null, { followPendingThread: false });
    }
    this.backgroundTurns.delete(trackedTurn.turnId);
    this.desktopListedRuntimeStatusByThreadId.set(trackedTurn.threadId, { type: "idle" });
    const statusMessage =
      trackedTurn.threadId === this.sharedThreadId && status === "interrupted"
        ? "Codex task interrupted."
        : undefined;
    this.syncSelectedThreadState(statusMessage);

    if (finalText) {
      this.emit({
        type: "final_reply",
        text: finalText,
        timestamp: nowIso(),
        threadId: trackedTurn.threadId,
        turnId: trackedTurn.turnId,
        origin: trackedTurn.origin,
      });
    } else if (status === "failed") {
      const failureText = completedError
        ? `Codex could not complete the request: ${completedError}`
        : "Codex could not complete the request.";
      this.emit({
        type: "task_failed",
        message: failureText,
        timestamp: nowIso(),
        threadId: trackedTurn.threadId,
        turnId: trackedTurn.turnId,
        origin: trackedTurn.origin,
      });
    }
    this.emit({
      type: "task_complete",
      summary,
      outcome: resolveCodexTaskOutcome(status),
      timestamp: nowIso(),
      threadId: trackedTurn.threadId,
      turnId: trackedTurn.turnId,
      origin: trackedTurn.origin,
    });
    this.rememberCompletedTurn(trackedTurn.turnId);
    this.cleanupTurnArtifacts(trackedTurn.turnId);
    this.continueDesktopTaskAfterTurn(trackedTurn.threadId);
  }

  private getTurnFinalMessageMap(turnId: string): Map<string, string> {
    let finalMessages = this.turnFinalMessages.get(turnId);
    if (!finalMessages) {
      finalMessages = new Map<string, string>();
      this.turnFinalMessages.set(turnId, finalMessages);
    }
    return finalMessages;
  }

  private getTurnDeltaMap(turnId: string): Map<string, string> {
    let deltaByItem = this.turnDeltaByItem.get(turnId);
    if (!deltaByItem) {
      deltaByItem = new Map<string, string>();
      this.turnDeltaByItem.set(turnId, deltaByItem);
    }
    return deltaByItem;
  }

  private collectTurnOutput(turnId: string): string | null {
    const finalMessages = Array.from(this.getTurnFinalMessageMap(turnId).values())
      .map((text) => normalizeOutput(text).trim())
      .filter(Boolean);
    if (finalMessages.length > 0) {
      return finalMessages.join("\n\n");
    }

    const deltaFallback = Array.from(this.getTurnDeltaMap(turnId).values())
      .map((text) => normalizeOutput(text).trim())
      .filter(Boolean);
    if (deltaFallback.length === 0) {
      return null;
    }

    return deltaFallback[deltaFallback.length - 1] ?? null;
  }

  private recordTurnActivity(turnId: string, timestamp: string | number = Date.now()): void {
    const timestampMs =
      typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
    this.turnLastActivityAtMs.set(
      turnId,
      Number.isFinite(timestampMs) ? timestampMs : Date.now(),
    );
  }

  private clearFinalReplyCompletionTimer(): void {
    if (this.finalReplyCompletionTimer) {
      clearTimeout(this.finalReplyCompletionTimer);
      this.finalReplyCompletionTimer = null;
    }
    this.finalReplyCompletionTurnId = null;
  }

  private clearFinalReplyCompletionTimerForTurn(turnId: string): void {
    if (this.finalReplyCompletionTurnId !== turnId) {
      return;
    }
    this.clearFinalReplyCompletionTimer();
  }

  private scheduleFinalReplyCompletionIfEligible(turnId: string): void {
    if (
      !this.activeTurn ||
      this.activeTurn.turnId !== turnId ||
      this.activeTurn.origin !== "wechat" ||
      this.pendingTurnStart ||
      this.getPendingApprovalRequestsForThread(this.activeTurn.threadId).length > 0 ||
      this.getPendingUserInputRequestsForThread(this.activeTurn.threadId).length > 0 ||
      !this.collectTurnOutput(turnId)
    ) {
      return;
    }

    this.clearFinalReplyCompletionTimer();
    this.finalReplyCompletionTurnId = turnId;
    this.finalReplyCompletionTimer = setTimeout(() => {
      this.autoCompleteWechatTurnAfterFinalReply(turnId);
    }, CODEX_FINAL_REPLY_SETTLE_DELAY_MS);
    this.finalReplyCompletionTimer.unref?.();
  }

  private autoCompleteWechatTurnAfterFinalReply(turnId: string): void {
    this.clearFinalReplyCompletionTimerForTurn(turnId);

    const activeTurn = this.activeTurn;
    const finalText = this.collectTurnOutput(turnId);
    const lastActivityAtMs = this.turnLastActivityAtMs.get(turnId) ?? null;
    const pendingApproval = Boolean(
      activeTurn &&
        this.getPendingApprovalRequestsForThread(activeTurn.threadId).length > 0,
    );
    const pendingUserInput = Boolean(
      activeTurn &&
        this.getPendingUserInputRequestsForThread(activeTurn.threadId).length > 0,
    );
    const nowMs = Date.now();
    if (
      !shouldAutoCompleteCodexWechatTurnAfterFinalReply({
        candidateTurnId: turnId,
        activeTurnId: activeTurn?.turnId,
        activeTurnOrigin: activeTurn?.origin,
        pendingTurnStart: this.pendingTurnStart,
        hasPendingApproval: pendingApproval,
        hasPendingUserInput: pendingUserInput,
        hasFinalOutput: Boolean(finalText),
        hasCompletedTurn: this.hasCompletedTurn(turnId),
        lastActivityAtMs,
        nowMs,
        settleDelayMs: CODEX_FINAL_REPLY_SETTLE_DELAY_MS,
      })
    ) {
      if (
        activeTurn?.turnId === turnId &&
        activeTurn.origin === "wechat" &&
        !this.pendingTurnStart &&
        !pendingApproval &&
        !pendingUserInput &&
        finalText &&
        typeof lastActivityAtMs === "number"
      ) {
        const remainingMs = CODEX_FINAL_REPLY_SETTLE_DELAY_MS - (nowMs - lastActivityAtMs);
        if (remainingMs > 0) {
          this.finalReplyCompletionTurnId = turnId;
          this.finalReplyCompletionTimer = setTimeout(() => {
            this.autoCompleteWechatTurnAfterFinalReply(turnId);
          }, remainingMs);
          this.finalReplyCompletionTimer.unref?.();
        }
      }
      return;
    }

    if (!activeTurn || !finalText) {
      return;
    }

    const summary = this.turnPreviewById.get(turnId) ?? this.currentPreview;
    this.pendingApprovalRequests = this.pendingApprovalRequests.filter(
      (request) => request.turnId !== turnId,
    );
    this.pendingUserInputRequests = this.pendingUserInputRequests.filter(
      (request) => request.turnId !== turnId,
    );
    this.setActiveTurn(null, { followPendingThread: false });
    this.desktopListedRuntimeStatusByThreadId.set(activeTurn.threadId, { type: "idle" });
    this.state.lastOutputAt = nowIso();
    this.syncSelectedThreadState("Recovered delayed Codex completion after final reply.");
    this.emit({
      type: "final_reply",
      text: finalText,
      timestamp: nowIso(),
      threadId: activeTurn.threadId,
      turnId,
      origin: activeTurn.origin,
    });
    this.emit({
      type: "task_complete",
      summary,
      timestamp: nowIso(),
      threadId: activeTurn.threadId,
      turnId,
      origin: activeTurn.origin,
    });
    this.rememberCompletedTurn(turnId);
    this.cleanupTurnArtifacts(turnId);
    this.scheduleDesktopQueuedFollowUpDrain(activeTurn.threadId);
  }

  private async stopAppServer(): Promise<void> {
    if (!this.appServer) {
      this.appServerPort = null;
      this.appServerShuttingDown = false;
      this.deleteAppServerAuthTokenFile();
      this.appServerAuthToken = null;
      return;
    }

    const child = this.appServer;
    this.appServerShuttingDown = true;
    this.appServer = null;
    this.appServerPort = null;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };
      child.once("exit", () => finish());
      try {
        if (child.pid) {
          killProcessTreeSync(child.pid);
        } else {
          child.kill();
        }
      } catch {
        finish();
      }
      const timer = setTimeout(() => finish(), 1_000);
      timer.unref?.();
    });

    this.deleteAppServerAuthTokenFile();
    this.appServerAuthToken = null;
  }

  private describeAppServerLog(): string {
    const summary = normalizeOutput(this.appServerLog).trim();
    if (!summary) {
      return "";
    }
    return ` Recent app-server log: ${truncatePreview(summary, 220)}`;
  }

  private terminateCodexClient(): void {
    this.shuttingDown = true;

    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        // Best effort cleanup after embedded client failure.
      }
      return;
    }

    if (this.nativeProcess) {
      try {
        if (this.nativeProcess.pid) {
          killProcessTreeSync(this.nativeProcess.pid);
        } else {
          this.nativeProcess.kill();
        }
      } catch {
        // Best effort cleanup after panel client failure.
      }
    }
  }

  private deleteAppServerAuthTokenFile(): void {
    if (!this.appServerAuthTokenFilePath) {
      return;
    }

    try {
      fs.unlinkSync(this.appServerAuthTokenFilePath);
    } catch {
      // Best effort cleanup after app-server shutdown.
    }

    this.appServerAuthTokenFilePath = null;
  }

  private attachLocalInputForwarding(): void {
    if (this.localInputListener || !process.stdin.readable) {
      return;
    }

    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    this.localInputListener = (chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!text) {
        return;
      }
      this.writeToPty(text);
    };
    process.stdin.on("data", this.localInputListener);
  }

  private detachLocalInputForwarding(): void {
    if (!this.localInputListener) {
      return;
    }

    process.stdin.off("data", this.localInputListener);
    this.localInputListener = null;
    if (process.stdin.isTTY) {
      process.stdin.pause();
    }
  }

  private renderLocalOutput(rawText: string): void {
    try {
      process.stdout.write(rawText);
    } catch {
      // Best effort local mirroring for the visible Codex panel.
    }
  }

  private hasCompletedTurn(turnId: string): boolean {
    return this.completedTurnIds.has(turnId);
  }

  private rememberCompletedTurn(turnId: string): void {
    if (this.completedTurnIds.has(turnId)) {
      return;
    }

    this.completedTurnIds.add(turnId);
    this.completedTurnOrder.push(turnId);
    while (this.completedTurnOrder.length > CODEX_RECENT_SESSION_KEY_LIMIT) {
      const staleTurnId = this.completedTurnOrder.shift();
      if (staleTurnId) {
        this.completedTurnIds.delete(staleTurnId);
      }
    }
  }
}

export function shouldTreatCodexNativeExitAsExpected(params: {
  renderMode?: AdapterOptions["renderMode"];
  shuttingDown: boolean;
  exitCode: number | undefined;
  signal?: NodeJS.Signals;
  startupError?: Error;
}): boolean {
  return (
    params.shuttingDown ||
    (params.renderMode === "panel" &&
      !params.startupError &&
      !params.signal &&
      params.exitCode === 0)
  );
}

export function shouldSuppressCodexTransportFatalError(params: {
  transportShuttingDown: boolean;
  shuttingDown: boolean;
  cleanPanelExitInProgress: boolean;
}): boolean {
  return (
    params.transportShuttingDown ||
    params.shuttingDown ||
    params.cleanPanelExitInProgress
  );
}

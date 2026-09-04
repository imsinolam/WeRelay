#!/usr/bin/env bun

import path from "node:path";

import {
  resolveDefaultAdapterCommand,
} from "./bridge-adapters.ts";
import {
  getBridgeProvider,
  isBridgeAdapterKind,
  isClaudeProviderKind,
} from "./bridge-providers.ts";
import {
  delay,
  getLocalCompanionCommandName,
} from "./bridge-adapters.shared.ts";
import { t } from "../i18n/index.ts";
import { BridgeController } from "./bridge-controller.ts";
import { forwardWechatFinalReply } from "./bridge-final-reply.ts";
import { collectAssistantMessageImages } from "./bridge-message-images.ts";
import { ensureWechatCredentials } from "../wechat/setup.ts";
import { WechatImageDraftCollector } from "../wechat/wechat-image-draft.ts";
import { BridgeStateStore } from "./bridge-state.ts";
import { reapOrphanedOpencodeProcesses, reapPeerBridgeProcesses } from "./bridge-process-reaper.ts";
import { createRuntimeHost } from "../runtime/create-runtime-host.ts";
import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterKind,
  BridgeEvent,
  BridgeLifecycleMode,
  BridgeSessionMessage,
  BridgeSessionStartMode,
  BridgeWorkerStatus,
  PendingApproval,
  PendingUserInputRequest,
  UserInputRequest,
} from "./bridge-types.ts";
import {
  buildWechatInboundPrompt,
  buildOneTimeCode,
  CODEX_TASK_LIST_PAGE_SIZE,
  compactUserFacingError,
  formatApprovalMessage,
  formatPendingApprovalReminder,
  formatPendingUserInputReminder,
  formatResumeSessionList,
  formatResumeSessionSearchResults,
  formatDuration,
  formatCodexDesktopTaskLatestMessage,
  formatCodexDesktopTaskSelection,
  formatClawBotWechatHelp,
  formatCodexWechatHelp,
  formatMirroredUserInputMessage,
  formatSessionSwitchMessage,
  formatStatusReport,
  formatTaskFailedMessage,
  formatTaskInterruptedMessage,
  formatThinkingForWechat,
  formatUserInputRequestMessage,
  MESSAGE_START_GRACE_MS,
  nowIso,
  OutputBatcher,
  parsePendingUserInputAnswerCommand,
  parseWechatControlCommand,
  resolveBareCodexTaskSelection,
  resolveCompactCodexTaskSearchTarget,
  resolveResumeSessionCandidate,
  searchResumeSessionCandidates,
  shouldNotifyTaskInterrupted,
  type SystemCommand,
  truncatePreview,
} from "./bridge-utils.ts";
import {
  classifyWechatTransportError,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  WeChatTransport,
  describeWechatTransportError,
  isWechatContextTokenStaleError,
  type InboundWechatMessage,
} from "../wechat/wechat-transport.ts";
import {
  checkForUpdate,
  formatUpdateMessage,
} from "../utils/version-checker.ts";
import {
  clearDaemonEndpoint,
  isDaemonEndpointAlive,
  readDaemonEndpoint,
} from "../daemon/daemon-link.ts";

type BridgeCliOptions = {
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
  lifecycle: BridgeLifecycleMode;
  sessionStartMode: BridgeSessionStartMode;
};

type ActiveTask = {
  startedAt: number;
  inputPreview: string;
  queued?: boolean;
  duplicate?: boolean;
  queuePosition?: number;
};

type DeferredInboundMessage = {
  message: InboundWechatMessage;
};

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
  | "inbound_error"
  | "thinking";

const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_MAX_MS = 30_000;
const PARENT_PROCESS_POLL_MS = 5_000;
const WECHAT_SEND_MAX_ATTEMPTS = 3;
const WECHAT_SEND_RETRY_BASE_MS = 750;

function log(message: string): void {
  process.stderr.write(`[werelay-bridge] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[werelay-bridge] ERROR: ${message}\n`);
}

function computePollRetryDelayMs(consecutiveFailures: number): number {
  const normalizedFailures = Math.max(1, consecutiveFailures);
  const exponent = Math.min(normalizedFailures - 1, 5);
  return Math.min(POLL_RETRY_MAX_MS, POLL_RETRY_BASE_MS * 2 ** exponent);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function formatUserFacingBridgeFatalError(message: string): string {
  const workerExit = message.trim().match(
    /^([a-z][a-z0-9_-]*) worker exited unexpectedly with (?:code (-?\d+)|an unknown code)\.?$/i,
  );
  if (workerExit) {
    const adapter = workerExit[1]?.toLowerCase();
    const label = adapter && isBridgeAdapterKind(adapter)
      ? getBridgeProvider(adapter).label
      : "终端";
    const restartCommand = adapter && isBridgeAdapterKind(adapter)
      ? `/${adapter}`
      : "对应应用命令";
    const exitCode = workerExit[2];
    if (exitCode === "0") {
      return `${label} 已关闭。\n发送“${restartCommand}”可重新打开。`;
    }
    const errorDetail = exitCode === undefined
      ? ""
      : `（错误代码 ${exitCode}）`;
    return `${label} 运行异常结束${errorDetail}。\n发送“${restartCommand}”可重新打开；如果再次出现，请在电脑端查看。`;
  }
  return `桥接错误：${compactUserFacingError(message)}`;
}

export function shouldForwardBridgeEventToWechat(
  adapter: BridgeAdapterKind,
  eventType: BridgeEvent["type"],
  options: {
    text?: string;
} = {},
): boolean {
  if (eventType === "stdout" || eventType === "stderr") {
    return adapter === "shell";
  }
  if (
    eventType === "notice" &&
    /^(?:Claude|Codex|OpenCode) is still working on:/i.test(options.text ?? "")
  ) {
    return false;
  }
  if (adapter !== "opencode") {
    return true;
  }

  switch (eventType) {
    case "thread_switched":
      return false;
    case "notice":
      return /^OpenCode local draft:\s*/i.test(options.text ?? "");
    case "mirrored_user_input":
      return true;
    default:
      return true;
  }
}

export function formatBridgeNoticeForWechat(text: string): string {
  const normalized = text.trim();
  const localDraft = normalized.match(/^OpenCode local draft:\s*([\s\S]*)$/i);
  if (localDraft) {
    return `桌面端草稿：\n${truncatePreview(localDraft[1]?.trim() || "（空）", 300)}`;
  }
  if (/Conversation transcript .* no longer exists|Saved Claude conversation .* no longer available/i.test(normalized)) {
    return "历史会话已失效，已新建会话。";
  }
  if (/Conversation was compacted/i.test(normalized)) {
    return "会话已压缩，可以继续发送消息。";
  }
  if (/approval can no longer be resolved from WeChat/i.test(normalized)) {
    return "该审批需在 Claude 桌面端处理。";
  }
  if (/[\u3400-\u9fff]/.test(normalized)) {
    return truncatePreview(normalized, 300);
  }
  return "系统提示：请查看电脑端。";
}

export function formatUserFacingInboundError(params: {
  adapter: BridgeAdapterKind;
  cwd?: string;
  errorText: string;
  isUserFacingShellRejection: boolean;
}): string {
  const { adapter, errorText, isUserFacingShellRejection } = params;
  if (isUserFacingShellRejection) {
    return errorText;
  }

  if (
    adapter === "opencode" &&
    /opencode companion is not connected/i.test(errorText)
  ) {
    return "OpenCode 桌面端未连接，请在电脑上重新打开 OpenCode。";
  }

  return `桥接错误：${compactUserFacingError(errorText)}`;
}

export function formatWechatSendFailureLogEntry(params: {
  context: WechatSendContext;
  recipientId: string;
  error: unknown;
}): string {
  return `wechat_send_failed: context=${params.context} recipient=${params.recipientId} error=${truncatePreview(describeWechatTransportError(params.error), 400)}`;
}

export function formatWechatContextTokenStaleLogEntry(params: {
  context: WechatSendContext;
  recipientId: string;
  error: unknown;
}): string {
  return `wechat_context_token_stale: context=${params.context} recipient=${params.recipientId} action=wechat_message_required error=${truncatePreview(describeWechatTransportError(params.error), 400)}`;
}

function formatWechatSendRetryLogEntry(params: {
  context: WechatSendContext;
  recipientId: string;
  attempt: number;
  delayMs: number;
  error: unknown;
}): string {
  return `wechat_send_retry: context=${params.context} recipient=${params.recipientId} attempt=${params.attempt} delay_ms=${params.delayMs} error=${truncatePreview(describeWechatTransportError(params.error), 400)}`;
}

export function isRetryableWechatSendError(error: unknown): boolean {
  if (isWechatContextTokenStaleError(error)) {
    return false;
  }

  const classification = classifyWechatTransportError(error);
  if (classification.retryable) {
    return true;
  }

  const details = describeWechatTransportError(error);
  return /^(?:Error|WechatApiResponseError): sendmessage failed:/i.test(details) &&
    !/errcode=-14\b.*session timeout/i.test(details);
}

function computeWechatSendRetryDelayMs(attempt: number): number {
  return WECHAT_SEND_RETRY_BASE_MS * attempt;
}

export function shouldWatchParentProcess(options: {
  startupParentPid: number;
  attachedToTerminal: boolean;
  lifecycle: BridgeLifecycleMode;
}): boolean {
  return (
    options.startupParentPid > 1 &&
    (options.attachedToTerminal || options.lifecycle === "companion_bound")
  );
}

export function startParentProcessWatcher(options: {
  startupParentPid: number;
  attachedToTerminal: boolean;
  lifecycle: BridgeLifecycleMode;
  isShutdownRequested: () => boolean;
  requestShutdown: (message: string) => void;
  isParentAlive?: (pid: number) => boolean;
  pollMs?: number;
}): ReturnType<typeof setInterval> | null {
  if (!shouldWatchParentProcess(options)) {
    return null;
  }

  const isParentAlive = options.isParentAlive ?? isPidAlive;
  const timer = setInterval(() => {
    if (
      options.isShutdownRequested() ||
      isParentAlive(options.startupParentPid)
    ) {
      return;
    }

    options.requestShutdown(
      `Parent process ${options.startupParentPid} exited. Stopping bridge.`,
    );
  }, options.pollMs ?? PARENT_PROCESS_POLL_MS);
  timer.unref();
  return timer;
}

function toPendingApproval(request: ApprovalRequest | PendingApproval): PendingApproval {
  if (typeof (request as PendingApproval).code === "string") {
    return request as PendingApproval;
  }

  return {
    ...request,
    code: buildOneTimeCode(),
    createdAt: nowIso(),
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

export function shouldDeferCodexInboundMessage(_params: {
  adapter: BridgeAdapterKind;
  status: BridgeWorkerStatus;
  hasPendingConfirmation: boolean;
  hasSystemCommand: boolean;
}): boolean {
  return false;
}

export function canDrainDeferredCodexInboundQueue(params: {
  adapter: BridgeAdapterKind;
  deferredCount: number;
  status: BridgeWorkerStatus;
  activeTurnId?: string;
  hasPendingConfirmation: boolean;
  hasPendingUserInput: boolean;
  hasPendingApproval: boolean;
  hasActiveTask: boolean;
}): boolean {
  return (
    params.adapter === "codex" &&
    params.deferredCount > 0 &&
    !params.hasPendingConfirmation &&
    !params.hasPendingUserInput &&
    !params.hasPendingApproval &&
    !params.hasActiveTask &&
    !params.activeTurnId &&
    params.status !== "busy" &&
    params.status !== "awaiting_approval" &&
    params.status !== "awaiting_input"
  );
}

export function formatDeferredCodexInboundQueueMessage(queuePosition: number): string {
  const ahead = Math.max(0, Math.floor(queuePosition) - 1);
  return ahead > 0
    ? `消息已排队，前面还有 ${ahead} 条；当前任务结束后自动发送。`
    : "消息已排队；当前任务结束后自动发送。";
}

export function isRetryableDeferredCodexDrainError(errorText: string): boolean {
  return /still working|approval request is pending|waiting for local terminal input|操作等待确认|仍在处理|等待本地终端输入|等待你的补充输入|等待补充输入|Codex 桌面端连接已断开|无法连接 Codex 桌面端|Codex 桌面端未运行|Codex 桌面端连接已关闭/i.test(
    errorText,
  );
}


export function formatCodexTaskAcceptedMessage(): string {
  return "已发送，Codex 正在处理。\n\n完成后会在微信通知你；任务较久时，可打开下方网页版查看实时进展。";
}

export function formatCodexTaskDuplicateMessage(): string {
  return "与最近一条消息相同，未重复发送。";
}

export function formatCodexTaskQueuedMessage(queuePosition?: number): string {
  const position = Number.isFinite(queuePosition) && Number(queuePosition) > 0
    ? `（第 ${Math.floor(Number(queuePosition))} 条）`
    : "";
  return `已加入待发送${position}。\n可在网页版或 Codex 中引导、编辑或删除。`;
}

export function parseCliArgs(argv: string[]): BridgeCliOptions {
  let adapter: BridgeAdapterKind | null = null;
  let commandOverride: string | undefined;
  let cwd = process.cwd();
  let profile: string | undefined;
  let lifecycle: BridgeLifecycleMode = "persistent";
  let sessionStartMode: BridgeSessionStartMode = "restore";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    switch (arg) {
      case "--adapter":
        if (!isBridgeAdapterKind(next)) {
          throw new Error(`Invalid adapter: ${next ?? "(missing)"}`);
        }
        adapter = next as BridgeAdapterKind;
        i += 1;
        break;
      case "--cmd":
        if (!next) {
          throw new Error("--cmd requires a value");
        }
        commandOverride = next;
        i += 1;
        break;
      case "--cwd":
        if (!next) {
          throw new Error("--cwd requires a value");
        }
        cwd = path.resolve(next);
        i += 1;
        break;
      case "--profile":
        if (!next) {
          throw new Error("--profile requires a value");
        }
        profile = next;
        i += 1;
        break;
      case "--lifecycle":
        if (!next || !["persistent", "companion_bound"].includes(next)) {
          throw new Error(`Invalid lifecycle: ${next ?? "(missing)"}`);
        }
        lifecycle = next as BridgeLifecycleMode;
        i += 1;
        break;
      case "--session-start-mode":
        if (!next || !["restore", "new"].includes(next)) {
          throw new Error(`Invalid session start mode: ${next ?? "(missing)"}`);
        }
        sessionStartMode = next as BridgeSessionStartMode;
        i += 1;
        break;
      case "--shutdown-on-parent-exit":
        lifecycle = "companion_bound";
        break;
      case "--help":
      case "-h":
        printUsageAndExit();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!adapter) {
    throw new Error("Missing required --adapter <codex|claude|tclaude|grok|codebuddy|reasonix|workbuddy|deepseek|opencode|shell>");
  }

  const defaultCommand = resolveDefaultAdapterCommand(adapter);
  return {
    adapter,
    command: commandOverride ?? defaultCommand,
    cwd,
    profile,
    lifecycle,
    sessionStartMode,
  };
}

function printUsageAndExit(): never {
  process.stdout.write(
    [
      "Usage: werelay-bridge --adapter <codex|claude|tclaude|grok|codebuddy|reasonix|workbuddy|deepseek|opencode|shell> [--cmd <executable>] [--cwd <path>] [--profile <name-or-path>] [--lifecycle <persistent|companion_bound>] [--session-start-mode <restore|new>]",
      "",
      "Examples:",
      "  werelay-bridge-codex",
      "  werelay-bridge-claude --cwd ~/work/my-project",
      "  werelay-bridge-opencode --cwd ~/work/my-project",
      "  werelay-bridge-grok --cwd ~/work/my-project",
      "  werelay-bridge-codebuddy --cwd ~/work/my-project",
      "  werelay-bridge-reasonix --cwd ~/work/my-project",
      "  werelay-bridge-workbuddy --cwd ~/work/my-project",
      "  werelay-bridge-deepseek --cwd ~/work/my-project",
      "  werelay-bridge-shell --cmd pwsh   # headless shell executor for non-interactive commands/scripts",
      "  werelay-bridge-shell --cmd bash   # headless shell executor for non-interactive commands/scripts",
      "  werelay-bridge-codex --lifecycle companion_bound",
      "  bun run bridge:codex            # repo-local development entrypoint",
      "  bun run bridge:opencode          # repo-local development entrypoint",
      "  bun run bridge:grok              # repo-local development entrypoint",
      "  bun run bridge:codebuddy         # repo-local development entrypoint",
      "  bun run bridge:reasonix          # repo-local development entrypoint",
      "  bun run bridge:workbuddy         # repo-local development entrypoint",
      "  bun run bridge:deepseek          # repo-local development entrypoint",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv.includes("--doctor")) {
    const { runDoctorCheck } = await import("../utils/doctor.ts");
    await runDoctorCheck(process.argv.slice(2), { mode: "bridge" });
    process.exit(0);
  }
  const options = parseCliArgs(process.argv.slice(2));
  const daemonEndpoint = readDaemonEndpoint();
  if (daemonEndpoint && await isDaemonEndpointAlive(daemonEndpoint, { timeoutMs: 500 })) {
    throw new Error(
      `werelay-daemon is already running (pid=${daemonEndpoint.pid}, cwd=${daemonEndpoint.cwd}). Stop it before starting a standalone bridge.`,
    );
  }
  if (daemonEndpoint) {
    clearDaemonEndpoint(daemonEndpoint.pid);
    log(`Cleared stale werelay-daemon endpoint for pid=${daemonEndpoint.pid}.`);
  }
  const credentials = await ensureWechatCredentials({
    requireUserId: true,
    validateExisting: true,
    log,
  });
  if (!credentials.userId) {
    throw new Error("Saved WeChat credentials are missing userId.");
  }
  const transport = new WeChatTransport({ log, logError });
  const wechatImageDrafts = new WechatImageDraftCollector();

  // 非阻塞地检查更新（不影响启动速度，也避免首次登录时打断二维码输出）
  // unref：不能让这个延迟检查把 event loop 挂活（如 --doctor 或快速退出场景），
  // 否则会与强制退出 teardown 竞态。
  const updateCheckTimer = setTimeout(async () => {
    try {
      const versionInfo = await checkForUpdate();
      if (versionInfo?.hasUpdate) {
        log(formatUpdateMessage(versionInfo));
      }
    } catch (error) {
      // 静默失败，不影响正常使用
    }
  }, 3000); // 延迟3秒，确保不影响启动
  updateCheckTimer.unref?.();

  const stateStore = new BridgeStateStore({
    ...options,
    authorizedUserId: credentials.userId,
  });
  const reapedPeerPids = await reapPeerBridgeProcesses({
    logger: (message) => stateStore.appendLog(message),
  });
  if (reapedPeerPids.length > 0) {
    log(`Reaped ${reapedPeerPids.length} stale bridge process(es): ${reapedPeerPids.join(", ")}`);
  }

  if (options.adapter === "opencode") {
    const reapedOpencodePids = await reapOrphanedOpencodeProcesses({
      logger: (message) => stateStore.appendLog(message),
    });
    if (reapedOpencodePids.length > 0) {
      log(`Reaped ${reapedOpencodePids.length} orphaned opencode process(es): ${reapedOpencodePids.join(", ")}`);
    }
  }

  let lockRehydratedLogged = false;
  const ensureRuntimeOwnership = (): boolean => {
    const ownership = stateStore.verifyRuntimeOwnership();
    if (!ownership.ok) {
      if (ownership.reason === "superseded") {
        requestShutdown(
          `Bridge instance ${stateStore.getState().instanceId} was superseded by ${ownership.activeInstanceId}. Stopping duplicate bridge.`,
        );
        return false;
      }

      requestShutdown(
        `Bridge instance ${stateStore.getState().instanceId} lost the global lock to pid=${ownership.activePid} (${ownership.activeInstanceId}). Stopping duplicate bridge.`,
      );
      return false;
    }

    if (ownership.rehydratedLock && !lockRehydratedLogged) {
      lockRehydratedLogged = true;
      stateStore.appendLog(
        `lock_rehydrated: pid=${process.pid} instanceId=${stateStore.getState().instanceId} adapter=${options.adapter} cwd=${options.cwd}`,
      );
    }

    return true;
  };

  // Clear any stale endpoint left by a previous bridge for this workspace.
  // This prevents stale WeRelay companions from reconnecting to a dead bridge
  // while the new runtime is still starting up.
  const adapter = createRuntimeHost({
    kind: options.adapter,
    command: options.command,
    cwd: options.cwd,
    profile: options.profile,
    lifecycle: options.lifecycle,
    sessionStartMode: options.sessionStartMode,
    initialSharedSessionId:
      stateStore.getState().sharedSessionId ?? stateStore.getState().sharedThreadId,
    initialResumeConversationId: stateStore.getState().resumeConversationId,
    initialTranscriptPath: stateStore.getState().transcriptPath,
  });
  const controller = new BridgeController(adapter, options.cwd);
  controller.clearLocalClientEndpoint();
  stateStore.appendLog(`Cleared stale companion endpoint for ${options.cwd} before adapter start.`);
  let textSendChain = Promise.resolve();
  let attachmentSendChain = Promise.resolve();
  const pendingWechatForwardTasks = new Set<Promise<void>>();
  let activeTask: ActiveTask | null = null;
  const codexTaskNumberByThreadId = new Map<string, number>();
  const codexTaskTitleByThreadId = new Map<string, string>();
  const rememberCodexTaskNumbers = (
    candidates: Awaited<ReturnType<BridgeAdapter["listResumeSessions"]>>,
  ) => {
    if (options.adapter !== "codex") {
      return;
    }
    candidates.forEach((candidate, index) => {
      codexTaskNumberByThreadId.set(candidate.sessionId, index + 1);
      codexTaskTitleByThreadId.set(candidate.sessionId, candidate.title);
    });
  };
  const formatTaskMessage = (text: string, threadId?: string): string => {
    if (options.adapter !== "codex" || !threadId) {
      return text;
    }
    const taskNumber = codexTaskNumberByThreadId.get(threadId);
    const taskIdentity = typeof taskNumber === "number"
      ? `任务 ${taskNumber}`
      : `任务 ${threadId.slice(0, 8)}`;
    const title = truncatePreview(
      codexTaskTitleByThreadId.get(threadId)?.trim().replace(/\s+/g, " ") ?? "",
      50,
    );
    const taskLabel = title
      ? `[${taskIdentity} · ${title}]`
      : `[${taskIdentity}]`;
    const trimmed = text.trim();
    return trimmed
      ? `${taskLabel}\n${trimmed}`
      : taskLabel;
  };
  const deferredInboundMessages: DeferredInboundMessage[] = [];
  let drainingDeferredInboundMessages = false;
  let awaitingBareCodexTaskSelection = false;
  let consecutivePollFailures = 0;
  let backlogNoticeSent = false;

  const queueWechatTextAction = <T>(action: () => Promise<T>) => {
    const run = textSendChain.then(action);
    textSendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const queueWechatAttachmentAction = <T>(action: () => Promise<T>) => {
    const run = attachmentSendChain.then(action);
    attachmentSendChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const queueWechatMessage = (
    senderId: string,
    text: string,
    context: WechatSendContext = "message",
  ) => {
    return queueWechatTextAction(async () => {
      for (let attempt = 1; attempt <= WECHAT_SEND_MAX_ATTEMPTS; attempt += 1) {
        try {
          await transport.sendText(senderId, text);
          return true;
        } catch (err) {
          if (isWechatContextTokenStaleError(err)) {
            transport.clearCachedContextToken(senderId);
            const hint =
              "WeChat conversation context is stale. Ask the WeChat owner to send any message first, then local terminal replies can sync back to WeChat.";
            logError(`Failed to send WeChat ${context}: ${hint}`);
            stateStore.appendLog(
              formatWechatContextTokenStaleLogEntry({
                context,
                recipientId: senderId,
                error: err,
              }),
            );
            return false;
          }

          if (attempt < WECHAT_SEND_MAX_ATTEMPTS && isRetryableWechatSendError(err)) {
            const delayMs = computeWechatSendRetryDelayMs(attempt);
            logError(
              `Failed to send WeChat ${context} (attempt ${attempt}). Retrying in ${formatDuration(delayMs)}. ${describeWechatTransportError(err)}`,
            );
            stateStore.appendLog(
              formatWechatSendRetryLogEntry({
                context,
                recipientId: senderId,
                attempt,
                delayMs,
                error: err,
              }),
            );
            await delay(delayMs);
            continue;
          }

          logError(`Failed to send WeChat ${context}: ${describeWechatTransportError(err)}`);
          stateStore.appendLog(
            formatWechatSendFailureLogEntry({
              context,
              recipientId: senderId,
              error: err,
            }),
          );
          return false;
        }
      }

      return false;
    });
  };

  const trackWechatForwardTask = (task: Promise<void>): void => {
    const tracked = task
      .catch((error) => {
        logError(`WeChat forward task failed: ${describeWechatTransportError(error)}`);
        stateStore.appendLog(
          `wechat_forward_failed: error=${truncatePreview(describeWechatTransportError(error), 400)}`,
        );
      })
      .finally(() => {
        pendingWechatForwardTasks.delete(tracked);
      });
    pendingWechatForwardTasks.add(tracked);
  };

  const waitForPendingWechatForwardTasks = async (): Promise<void> => {
    while (pendingWechatForwardTasks.size > 0) {
      await Promise.allSettled([...pendingWechatForwardTasks]);
    }
  };

  const outputBatcher = new OutputBatcher(async (text) => {
    await queueWechatMessage(stateStore.getState().authorizedUserId, text);
  });
  const maybeDrainDeferredInboundMessages = async (): Promise<void> => {
    if (drainingDeferredInboundMessages || !ensureRuntimeOwnership()) {
      return;
    }

    const adapterState = adapter.getState();
    if (
      !canDrainDeferredCodexInboundQueue({
        adapter: options.adapter,
        deferredCount: deferredInboundMessages.length,
        status: adapterState.status,
        activeTurnId: adapterState.activeTurnId,
        hasPendingConfirmation: Boolean(stateStore.getState().pendingConfirmation),
        hasPendingUserInput: Boolean(stateStore.getState().pendingUserInput),
        hasPendingApproval: Boolean(adapterState.pendingApproval),
        hasActiveTask: Boolean(activeTask),
      })
    ) {
      return;
    }

    const nextDeferred = deferredInboundMessages.shift();
    if (!nextDeferred) {
      return;
    }

    drainingDeferredInboundMessages = true;
    try {
      stateStore.appendLog(
        `draining_deferred_inbound_input: remaining=${deferredInboundMessages.length} text=${truncatePreview(nextDeferred.message.text)}`,
      );
      const nextTask = await dispatchInboundWechatText({
        message: nextDeferred.message,
        options,
        stateStore,
        adapter,
      });
      activeTask = nextTask;
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      if (isRetryableDeferredCodexDrainError(errorText)) {
        deferredInboundMessages.unshift(nextDeferred);
        stateStore.appendLog(
          `deferred_inbound_blocked: ${truncatePreview(errorText, 400)}`,
        );
        return;
      }

      logError(errorText);
      stateStore.appendLog(`deferred_inbound_error: ${errorText}`);
      await queueWechatMessage(
        nextDeferred.message.senderId,
        formatUserFacingInboundError({
          adapter: options.adapter,
          cwd: options.cwd,
          errorText,
          isUserFacingShellRejection: false,
        }),
        "inbound_error",
      );
    } finally {
      drainingDeferredInboundMessages = false;
    }
  };
  const startupParentPid = process.ppid;
  const attachedToTerminal = Boolean(
    process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY,
  );
  let shutdownPromise: Promise<void> | null = null;
  let requestedExitCode = 0;
  let stdinDetached = false;
  let parentWatchTimer: ReturnType<typeof setInterval> | null = null;

  const cleanup = async () => {
    if (parentWatchTimer) {
      clearInterval(parentWatchTimer);
    }
    try {
      await outputBatcher.flushNow();
      await waitForPendingWechatForwardTasks();
    } catch {
      // Best effort flush.
    }
    try {
      await textSendChain;
      await attachmentSendChain;
      await waitForPendingWechatForwardTasks();
    } catch {
      // Best effort flush.
    }
    try {
      await adapter.dispose();
    } catch {
      // Best effort shutdown.
    }
    controller.clearLocalClientEndpoint();
    stateStore.releaseLock();
  };

  const shutdown = async (exitCode = 0): Promise<void> => {
    requestedExitCode = exitCode;
    if (!shutdownPromise) {
      shutdownPromise = cleanup().catch((error) => {
        logError(`Shutdown cleanup failed: ${describeWechatTransportError(error)}`);
      });
    }
    await shutdownPromise;
  };

  const requestShutdown = (message: string, exitCode = 0) => {
    if (shutdownPromise) {
      return;
    }
    log(message);
    void shutdown(exitCode).finally(() => process.exit(requestedExitCode));
  };

  parentWatchTimer = startParentProcessWatcher({
    startupParentPid,
    attachedToTerminal,
    lifecycle: options.lifecycle,
    isShutdownRequested: () => Boolean(shutdownPromise),
    requestShutdown,
  });

  process.once("SIGINT", () => {
    requestShutdown("Received SIGINT. Stopping bridge.");
  });
  process.once("SIGTERM", () => {
    requestShutdown("Received SIGTERM. Stopping bridge.");
  });
  process.once("SIGHUP", () => {
    requestShutdown("Terminal session closed. Stopping bridge.");
  });
  if (process.platform === "win32") {
    process.once("SIGBREAK", () => {
      requestShutdown("Received SIGBREAK. Stopping bridge.");
    });
  }
  if (attachedToTerminal) {
    process.stdin.on("close", () => {
      if (stdinDetached) {
        return;
      }
      stdinDetached = true;
      requestShutdown("Standard input closed. Stopping bridge.");
    });
    process.stdin.on("end", () => {
      if (stdinDetached) {
        return;
      }
      stdinDetached = true;
      requestShutdown("Standard input ended. Stopping bridge.");
    });
  }
  process.on("exit", () => {
    if (parentWatchTimer) {
      clearInterval(parentWatchTimer);
    }
    stateStore.releaseLock();
  });

  try {
    wireAdapterEvents({
      adapter,
      options,
      transport,
      stateStore,
      outputBatcher,
      queueWechatAttachmentAction,
      queueWechatMessage,
      trackWechatForwardTask,
      maybeDrainDeferredInboundMessages,
      getActiveTask: () => activeTask,
      clearActiveTask: () => {
        activeTask = null;
      },
      formatTaskMessage,
      syncSharedSessionState: () => {
        syncSharedSessionState(stateStore, adapter);
      },
      syncLocalClientEndpoint: () => {
        controller.syncLocalClientEndpoint();
      },
      requestShutdown,
    });

    await adapter.start();
    if (!ensureRuntimeOwnership()) {
      return;
    }
    syncSharedSessionState(stateStore, adapter);
    controller.syncLocalClientEndpoint();
    stateStore.appendLog(
      `Bridge started with adapter=${options.adapter} command=${options.command} cwd=${options.cwd}`,
    );

    log(`WeRelay bridge is ready for adapter "${options.adapter}".`);
    log(`Working directory: ${options.cwd}`);
    if (options.profile) {
      log(`Profile: ${options.profile}`);
    }
    log(`Authorized WeChat user: ${credentials.userId}`);
    if (options.adapter === "codex") {
      log(
        'Start the visible Codex panel in a second terminal with: werelay-codex',
      );
    } else if (
      options.adapter === "opencode" ||
      options.adapter === "grok" ||
      options.adapter === "codebuddy" ||
      options.adapter === "reasonix" ||
      isClaudeProviderKind(options.adapter)
    ) {
      log(
        `Start the visible ${options.adapter} companion in a second terminal with: ${getLocalCompanionCommandName(options.adapter)}`,
      );
    } else if (options.adapter === "shell") {
      log(
        "Shell mode runs as a headless remote executor for non-interactive commands and scripts.",
      );
    }

    const welcomeText = t("bridge.welcome", {
      adapter: options.adapter,
      cwd: options.cwd,
    });
    await queueWechatMessage(credentials.userId, welcomeText);

    while (true) {
      if (!ensureRuntimeOwnership()) {
        break;
      }

      let pollResult: Awaited<ReturnType<WeChatTransport["pollMessages"]>>;
      try {
        pollResult = await transport.pollMessages({
          timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
          minCreatedAtMs: stateStore.getState().bridgeStartedAtMs - MESSAGE_START_GRACE_MS,
        });
      } catch (err) {
        const classification = classifyWechatTransportError(err);
        if (!classification.retryable) {
          throw err;
        }

        consecutivePollFailures += 1;
        const delayMs = computePollRetryDelayMs(consecutivePollFailures);
        const errorText = describeWechatTransportError(err);
        const statusDetails =
          typeof classification.statusCode === "number"
            ? ` status=${classification.statusCode}`
            : "";
        logError(
          `WeChat long poll failed (${classification.kind}${statusDetails}, attempt ${consecutivePollFailures}). Retrying in ${formatDuration(delayMs)}. ${errorText}`,
        );
        stateStore.appendLog(
          `poll_retry: kind=${classification.kind}${statusDetails} attempt=${consecutivePollFailures} delay_ms=${delayMs} error=${truncatePreview(errorText, 400)}`,
        );
        await delay(delayMs);
        continue;
      }

      if (!ensureRuntimeOwnership()) {
        break;
      }

      if (consecutivePollFailures > 0) {
        const recoveredFailures = consecutivePollFailures;
        consecutivePollFailures = 0;
        log(`WeChat long poll recovered after ${recoveredFailures} transient error(s).`);
        stateStore.appendLog(`poll_recovered: failures=${recoveredFailures}`);
      }

      if (pollResult.ignoredBacklogCount > 0) {
        stateStore.incrementIgnoredBacklog(pollResult.ignoredBacklogCount);
        stateStore.appendLog(
          `ignored_startup_backlog: count=${pollResult.ignoredBacklogCount}`,
        );
        if (!backlogNoticeSent) {
          backlogNoticeSent = true;
          await queueWechatMessage(
            stateStore.getState().authorizedUserId,
            t("bridge.backlogIgnored", {
              count: pollResult.ignoredBacklogCount,
              graceSeconds: Math.round(MESSAGE_START_GRACE_MS / 1000),
            }),
            "notice",
          );
        }
      }

      for (const message of pollResult.messages) {
        if (!ensureRuntimeOwnership()) {
          break;
        }

        stateStore.touchActivity(message.createdAt);
        let nextTask: ActiveTask | null = null;
        try {
          nextTask = await handleInboundMessage({
            message,
            imageDraftCollector: wechatImageDrafts,
            options,
            stateStore,
            adapter,
            queueWechatMessage,
            outputBatcher,
            rememberCodexTaskNumbers,
            formatTaskMessage,
            getAwaitingBareCodexTaskSelection: () => awaitingBareCodexTaskSelection,
            setAwaitingBareCodexTaskSelection: (value) => {
              awaitingBareCodexTaskSelection = value;
            },
            deferInboundMessage: async (nextMessage) => {
              deferredInboundMessages.push({
                message: nextMessage,
              });
              stateStore.appendLog(
                `deferred_inbound_input: position=${deferredInboundMessages.length} text=${truncatePreview(nextMessage.text)}`,
              );
              await queueWechatMessage(
                nextMessage.senderId,
                formatDeferredCodexInboundQueueMessage(deferredInboundMessages.length),
              );
            },
          });
        } catch (err) {
          const errorText = err instanceof Error ? err.message : String(err);
          const isUserFacingShellRejection =
            err instanceof Error && err.name === "ShellCommandRejectedError";
          logError(errorText);
          stateStore.appendLog(
            `${isUserFacingShellRejection ? "inbound_rejected" : "inbound_error"}: ${errorText}`,
          );
          await queueWechatMessage(
            message.senderId,
            formatUserFacingInboundError({
              adapter: options.adapter,
              cwd: options.cwd,
              errorText,
              isUserFacingShellRejection,
            }),
            "inbound_error",
          );
        }
        if (nextTask) {
          if (!nextTask.queued && !nextTask.duplicate) {
            activeTask = nextTask;
          }
          if (options.adapter === "codex") {
            await queueWechatMessage(
              stateStore.getState().authorizedUserId,
              formatTaskMessage(
                nextTask.duplicate
                  ? formatCodexTaskDuplicateMessage()
                  : nextTask.queued
                    ? formatCodexTaskQueuedMessage(nextTask.queuePosition)
                    : formatCodexTaskAcceptedMessage(),
                adapter.getState().sharedThreadId ?? adapter.getState().sharedSessionId,
              ),
              "notice",
            );
          }
        }
        syncSharedSessionState(stateStore, adapter);
        await maybeDrainDeferredInboundMessages();
      }
    }
  } finally {
    await shutdown(requestedExitCode);
  }
}

function syncSharedSessionState(
  stateStore: BridgeStateStore,
  adapter: BridgeAdapter,
): void {
  const persistedState = stateStore.getState();
  const persistedSessionId = persistedState.sharedSessionId ?? persistedState.sharedThreadId;
  const adapterState = adapter.getState();
  const adapterSessionId = adapterState.sharedSessionId ?? adapterState.sharedThreadId;

  if (adapterSessionId && adapterSessionId !== persistedSessionId) {
    stateStore.setSharedSessionId(adapterSessionId);
  } else if (!adapterSessionId && persistedSessionId) {
    stateStore.clearSharedSessionId();
  }

  if (!isClaudeProviderKind(persistedState.adapter)) {
    return;
  }

  if (
    adapterState.resumeConversationId !== persistedState.resumeConversationId ||
    adapterState.transcriptPath !== persistedState.transcriptPath
  ) {
    if (adapterState.resumeConversationId || adapterState.transcriptPath) {
      stateStore.setClaudeResumeState(
        adapterState.resumeConversationId,
        adapterState.transcriptPath,
      );
    } else {
      stateStore.clearClaudeResumeState();
    }
  }
}

function wireAdapterEvents(params: {
  adapter: BridgeAdapter;
  options: BridgeCliOptions;
  transport: WeChatTransport;
  stateStore: BridgeStateStore;
  outputBatcher: OutputBatcher;
  queueWechatAttachmentAction: <T>(action: () => Promise<T>) => Promise<T>;
  queueWechatMessage: (
    senderId: string,
    text: string,
    context?: WechatSendContext,
  ) => Promise<boolean>;
  trackWechatForwardTask: (task: Promise<void>) => void;
  maybeDrainDeferredInboundMessages: () => Promise<void>;
  getActiveTask: () => ActiveTask | null;
  clearActiveTask: () => void;
  formatTaskMessage: (text: string, threadId?: string) => string;
  syncSharedSessionState: () => void;
  syncLocalClientEndpoint: () => void;
  requestShutdown: (message: string, exitCode?: number) => void;
}): void {
  const {
    adapter,
    options,
    transport,
    stateStore,
    outputBatcher,
    queueWechatAttachmentAction,
    queueWechatMessage,
    trackWechatForwardTask,
    maybeDrainDeferredInboundMessages,
    getActiveTask,
    clearActiveTask,
    formatTaskMessage,
    syncSharedSessionState,
    syncLocalClientEndpoint,
    requestShutdown,
  } = params;

  const forwardedGeneratedImageKeys = new Set<string>();

  adapter.setEventSink((event) => {
    syncSharedSessionState();
    syncLocalClientEndpoint();
    const adapterState = adapter.getState();
    const bridgeState = stateStore.getState();
    if (
      options.adapter !== "codex" &&
      bridgeState.pendingConfirmation &&
      !adapterState.pendingApproval
    ) {
      stateStore.clearPendingConfirmation();
    }
    if (
      options.adapter !== "codex" &&
      bridgeState.pendingUserInput &&
      !adapterState.pendingUserInput
    ) {
      stateStore.clearPendingUserInput();
    }
    const authorizedUserId = stateStore.getState().authorizedUserId;

    switch (event.type) {
      case "stdout":
      case "stderr":
        if (shouldForwardBridgeEventToWechat(options.adapter, event.type)) {
          outputBatcher.push(event.text);
        }
        break;
      case "final_reply":
        stateStore.appendLog(`final_reply: ${truncatePreview(event.text)}`);
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          const threadId = event.threadId ??
            adapter.getState().sharedThreadId ??
            adapter.getState().sharedSessionId;
          let sessionMessages: BridgeSessionMessage[] = [];
          if (threadId && adapter.getSessionMessages) {
            try {
              sessionMessages = await adapter.getSessionMessages(threadId);
            } catch (error) {
              stateStore.appendLog(
                `final_reply_images_error: adapter=${options.adapter} thread=${threadId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
              );
            }
          }
          const images = collectAssistantMessageImages(sessionMessages, {
            ...(event.turnId ? { turnId: event.turnId } : {}),
            cwd: options.cwd,
            fallbackText: event.text,
          });
          await forwardWechatFinalReply({
            adapter: options.adapter,
            rawText: event.text,
            images,
            onEmptyVisibleReply: ({ rawVisibleText }) => {
              stateStore.appendLog(
                `empty_visible_final_reply: adapter=${options.adapter} raw=${truncatePreview(rawVisibleText)}`,
              );
            },
            sender: {
              sendText: async (text) => {
                const sent = await queueWechatMessage(
                  authorizedUserId,
                  formatTaskMessage(text, event.threadId),
                  "final_reply",
                );
                if (sent) {
                  stateStore.appendLog(
                    `final_reply_sent: chars=${Array.from(text).length}`,
                  );
                }
                return sent;
              },
              sendImage: async (imagePath) => {
                const turnKey = event.turnId ?? event.text;
                const key = `${options.adapter}\0${threadId ?? "unknown-thread"}\0${turnKey}\0${imagePath}`;
                if (forwardedGeneratedImageKeys.has(key)) {
                  stateStore.appendLog(
                    `final_reply_image_duplicate: adapter=${options.adapter} thread=${threadId ?? "unknown"} path=${imagePath}`,
                  );
                  return;
                }
                await queueWechatAttachmentAction(() =>
                  transport.sendImage(imagePath, { recipientId: authorizedUserId })
                );
                forwardedGeneratedImageKeys.add(key);
                stateStore.appendLog(
                  `final_reply_image_sent: adapter=${options.adapter} thread=${threadId ?? "unknown"} path=${imagePath}`,
                );
              },
              sendFile: (filePath) =>
                queueWechatAttachmentAction(() =>
                  transport.sendFile(filePath, { recipientId: authorizedUserId }),
                ),
              sendVoice: (voicePath) =>
                queueWechatAttachmentAction(() =>
                  transport.sendVoice(voicePath, authorizedUserId),
                ),
              sendVideo: (videoPath) =>
                queueWechatAttachmentAction(() =>
                  transport.sendVideo(videoPath, { recipientId: authorizedUserId }),
                ),
            },
          });
        }));
        break;
      case "status":
        if (event.message) {
          log(`${event.status}: ${event.message}`);
          stateStore.appendLog(`${event.status}: ${event.message}`);
        }
        void maybeDrainDeferredInboundMessages();
        break;
      case "notice":
        stateStore.appendLog(`${event.level}_notice: ${truncatePreview(event.text)}`);
        if (shouldForwardBridgeEventToWechat(options.adapter, event.type, { text: event.text })) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(
              authorizedUserId,
              formatBridgeNoticeForWechat(event.text),
              "notice",
            );
          }));
        }
        break;
      case "thinking":
        if (event.text) {
          const thinkingPreview = formatThinkingForWechat(event.text, 500);
          if (thinkingPreview) {
            stateStore.appendLog(`thinking: ${thinkingPreview}`);
            trackWechatForwardTask((async () => {
              await queueWechatMessage(authorizedUserId, `思考：${thinkingPreview}`, "thinking");
            })());
          }
        }
        break;
      case "approval_required":
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          const pending = toPendingApproval(event.request);
          stateStore.setPendingConfirmation(pending);
          stateStore.appendLog(
            `Approval requested (${pending.source}): ${pending.commandPreview}`,
          );
          await queueWechatMessage(
            authorizedUserId,
            formatTaskMessage(
              formatApprovalMessage(pending, adapterState),
              event.threadId ?? pending.threadId,
            ),
            "approval_required",
          );
        }));
        break;
      case "user_input_required":
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          const pending = toPendingUserInput(event.request);
          stateStore.setPendingUserInput(pending);
          stateStore.appendLog(
            `User input requested: questions=${pending.questions.length}`,
          );
          await queueWechatMessage(
            authorizedUserId,
            formatTaskMessage(
              formatUserInputRequestMessage(pending, adapterState),
              event.threadId ?? pending.threadId,
            ),
            "user_input_required",
          );
        }));
        break;
      case "mirrored_user_input":
        stateStore.appendLog(`mirrored_local_input: ${truncatePreview(event.text)}`);
        if (shouldForwardBridgeEventToWechat(options.adapter, event.type, { text: event.text })) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(
              authorizedUserId,
              formatTaskMessage(
                formatMirroredUserInputMessage(options.adapter, event.text),
                event.threadId,
              ),
              "mirrored_user_input",
            );
          }));
        }
        break;
      case "session_switched":
        stateStore.appendLog(
          `session_switched: ${event.sessionId} source=${event.source} reason=${event.reason}`,
        );
        if (shouldForwardBridgeEventToWechat(options.adapter, event.type)) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(
              authorizedUserId,
              formatSessionSwitchMessage({
                adapter: options.adapter,
                sessionId: event.sessionId,
                source: event.source,
                reason: event.reason,
              }),
              "session_switched",
            );
          }));
        }
        break;
      case "thread_switched":
        stateStore.appendLog(
          `thread_switched: ${event.threadId} source=${event.source} reason=${event.reason}`,
        );
        if (
          event.reason !== "wechat_resume" &&
          shouldForwardBridgeEventToWechat(options.adapter, event.type)
        ) {
          trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
            await queueWechatMessage(
              authorizedUserId,
              formatSessionSwitchMessage({
                adapter: options.adapter,
                sessionId: event.threadId,
                source: event.source,
                reason: event.reason,
              }),
              "thread_switched",
            );
          }));
        }
        void maybeDrainDeferredInboundMessages();
        break;
      case "task_complete": {
        const currentThreadId =
          adapter.getState().sharedThreadId ?? adapter.getState().sharedSessionId;
        const isCurrentTaskEvent =
          !event.threadId || event.threadId === currentThreadId;
        const notifyInterrupted = shouldNotifyTaskInterrupted(
          event.outcome,
          Boolean(getActiveTask()) && isCurrentTaskEvent,
        );
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          const pendingConfirmation = stateStore.getState().pendingConfirmation;
          if (
            !event.threadId ||
            !pendingConfirmation?.threadId ||
            pendingConfirmation.threadId === event.threadId
          ) {
            stateStore.clearPendingConfirmation();
          }
          const pendingUserInput = stateStore.getState().pendingUserInput;
          if (
            !event.threadId ||
            !pendingUserInput?.threadId ||
            pendingUserInput.threadId === event.threadId
          ) {
            stateStore.clearPendingUserInput();
          }
          if (options.adapter === "shell") {
            const summary = buildCompletionSummary({
              adapter: options.adapter,
              activeTask: getActiveTask(),
              exitCode: event.exitCode,
              recentOutput: outputBatcher.getRecentSummary(),
            });
            await queueWechatMessage(authorizedUserId, summary);
          }
          if (isCurrentTaskEvent) {
            clearActiveTask();
          }
          if (notifyInterrupted) {
            await queueWechatMessage(
              authorizedUserId,
              formatTaskMessage(
                formatTaskInterruptedMessage(options.adapter),
                event.threadId,
              ),
              "notice",
            );
          }
          await maybeDrainDeferredInboundMessages();
        }));
        break;
      }
      case "task_failed":
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          const currentThreadId =
            adapter.getState().sharedThreadId ?? adapter.getState().sharedSessionId;
          if (!event.threadId || event.threadId === currentThreadId) {
            clearActiveTask();
          }
          await queueWechatMessage(
            authorizedUserId,
            formatTaskMessage(
              formatTaskFailedMessage(options.adapter, event.message),
              event.threadId,
            ),
            "task_failed",
          );
          await maybeDrainDeferredInboundMessages();
        }));
        break;
      case "fatal_error":
        logError(event.message);
        stateStore.appendLog(`fatal_error: ${event.message}`);
        stateStore.clearPendingConfirmation();
        stateStore.clearPendingUserInput();
        clearActiveTask();
        trackWechatForwardTask(outputBatcher.flushNow().then(async () => {
          await queueWechatMessage(
            authorizedUserId,
            formatUserFacingBridgeFatalError(event.message),
            "fatal_error",
          );
          await maybeDrainDeferredInboundMessages();
        }));
        break;
      case "shutdown_requested":
        stateStore.appendLog(`shutdown_requested: ${event.reason}`);
        requestShutdown(event.message, event.exitCode ?? 0);
        break;
    }
  });
}

function buildCompletionSummary(params: {
  adapter: BridgeAdapterKind;
  activeTask: ActiveTask | null;
  exitCode?: number;
  recentOutput: string;
}): string {
  const lines = ["执行完成"];
  if (params.activeTask) {
    lines.push(
      `耗时：${formatDuration(Date.now() - params.activeTask.startedAt)}`,
    );
    lines.push(`请求：${params.activeTask.inputPreview}`);
  }
  if (typeof params.exitCode === "number") {
    lines.push(`退出码：${params.exitCode}`);
  }
  lines.push(`结果：\n${params.recentOutput}`);
  return lines.join("\n");
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

async function handleInboundMessage(params: {
  message: InboundWechatMessage;
  imageDraftCollector: WechatImageDraftCollector;
  options: BridgeCliOptions;
  stateStore: BridgeStateStore;
  adapter: BridgeAdapter;
  queueWechatMessage: (
    senderId: string,
    text: string,
    context?: WechatSendContext,
  ) => Promise<boolean>;
  outputBatcher: OutputBatcher;
  rememberCodexTaskNumbers: (
    candidates: Awaited<ReturnType<BridgeAdapter["listResumeSessions"]>>,
  ) => void;
  formatTaskMessage: (text: string, threadId?: string) => string;
  getAwaitingBareCodexTaskSelection: () => boolean;
  setAwaitingBareCodexTaskSelection: (value: boolean) => void;
  deferInboundMessage: (message: InboundWechatMessage) => Promise<void>;
}): Promise<ActiveTask | null> {
  let message = params.message;
  const {
    imageDraftCollector,
    options,
    stateStore,
    adapter,
    queueWechatMessage,
    outputBatcher,
    rememberCodexTaskNumbers,
    formatTaskMessage,
    getAwaitingBareCodexTaskSelection,
    setAwaitingBareCodexTaskSelection,
    deferInboundMessage,
  } = params;
  const state = stateStore.getState();

  if (message.senderId !== state.authorizedUserId) {
    await queueWechatMessage(
      message.senderId,
      "无权操作：仅接受已绑定微信的消息。",
    );
    return null;
  }

  const shouldCollectImageDraft =
    message.attachments.some((attachment) => attachment.kind === "image") ||
    (imageDraftCollector.hasPendingDraft(message.senderId) &&
      !message.text.trim().startsWith("/"));
  if (
    shouldCollectImageDraft &&
    !state.pendingConfirmation &&
    !state.pendingUserInput
  ) {
    const imageDraftResult = imageDraftCollector.consume(message);
    if (imageDraftResult.type === "wait") {
      await queueWechatMessage(message.senderId, imageDraftResult.reply, "notice");
      return null;
    }
    message = imageDraftResult.message;
  }

  const parsedSystemCommand = parseWechatControlCommand(message.text, {
    adapter: options.adapter,
    hasPendingConfirmation: Boolean(state.pendingConfirmation),
    hasPendingUserInput: Boolean(state.pendingUserInput),
    canConfirmForSession: state.pendingConfirmation?.allowForSession === true,
  });
  const bareTaskTarget = parsedSystemCommand
    ? null
    : resolveBareCodexTaskSelection({
        adapter: options.adapter,
        text: message.text,
        awaitingSelection: getAwaitingBareCodexTaskSelection(),
        hasPendingConfirmation: Boolean(state.pendingConfirmation),
        hasPendingUserInput: Boolean(state.pendingUserInput),
      });
  let systemCommand: SystemCommand | null = parsedSystemCommand ?? (bareTaskTarget
    ? { type: "resume" as const, target: bareTaskTarget }
    : null);
  if (!systemCommand && options.adapter === "codex") {
    try {
      const candidates = await adapter.listResumeSessions(100);
      const compactTarget = resolveCompactCodexTaskSearchTarget(
        message.text,
        candidates,
      );
      if (compactTarget) {
        systemCommand = { type: "resume", target: compactTarget };
      }
    } catch (error) {
      stateStore.appendLog(
        `compact_task_search_error: error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
      );
    }
  }
  if (systemCommand?.type !== "resume") {
    setAwaitingBareCodexTaskSelection(false);
  }
  if (!systemCommand) {
    setAwaitingBareCodexTaskSelection(false);
  }

  switch (systemCommand?.type) {
    case "help":
      await queueWechatMessage(
        message.senderId,
        options.adapter === "codex"
          ? formatCodexWechatHelp()
          : formatClawBotWechatHelp(options.adapter),
      );
      return null;
    case "status":
      await queueWechatMessage(
        message.senderId,
        formatStatusReport(stateStore.getState(), adapter.getState()),
      );
      return null;
    case "resume": {
      if (options.adapter === "codex") {
        const pageSize = CODEX_TASK_LIST_PAGE_SIZE;
        const page = systemCommand.page ?? 1;
        const pageStart = (page - 1) * pageSize;
        const numericTarget = systemCommand.target && /^\d+$/.test(systemCommand.target)
          ? Number(systemCommand.target)
          : null;
        const listLimit = systemCommand.target
          ? numericTarget && Number.isSafeInteger(numericTarget)
            ? Math.max(pageSize, numericTarget)
            : 100
          : page * pageSize + 1;
        const candidates = await adapter.listResumeSessions(listLimit);
        rememberCodexTaskNumbers(candidates);
        const currentSessionId =
          adapter.getState().sharedSessionId ?? adapter.getState().sharedThreadId;
        if (!systemCommand.target) {
          const pageCandidates = candidates.slice(pageStart, pageStart + pageSize);
          setAwaitingBareCodexTaskSelection(pageCandidates.length > 0);
          await queueWechatMessage(
            message.senderId,
            formatResumeSessionList({
              adapter: "codex",
              candidates: pageCandidates,
              currentSessionId,
              currentWorkerStatus: adapter.getState().status,
              page,
              hasMore: candidates.length > pageStart + pageSize,
            }),
          );
          return null;
        }

        const searchMatches = numericTarget === null
          ? searchResumeSessionCandidates(candidates, systemCommand.target)
          : [];
        const candidate = resolveResumeSessionCandidate(candidates, systemCommand.target);
        if (!candidate) {
          setAwaitingBareCodexTaskSelection(true);
          await queueWechatMessage(
            message.senderId,
            searchMatches.length > 1
              ? formatResumeSessionSearchResults({
                  target: systemCommand.target,
                  matches: searchMatches,
                  currentSessionId,
                  currentWorkerStatus: adapter.getState().status,
                })
              : [
                  `没有找到任务：${systemCommand.target}`,
                  formatResumeSessionList({
                    adapter: "codex",
                    candidates: candidates.slice(0, pageSize),
                    currentSessionId,
                    hasMore: candidates.length > pageSize,
                  }),
                ].join("\n\n"),
          );
          return null;
        }

        setAwaitingBareCodexTaskSelection(false);
        await outputBatcher.flushNow();
        await adapter.resumeSession(candidate.sessionId);
        outputBatcher.clear();
        stateStore.setSharedSessionId(candidate.sessionId);
        stateStore.appendLog(
          `wechat_resume: thread=${candidate.sessionId} cwd=${candidate.cwd ?? "(unknown)"}`,
        );
        let runSummary = null as Awaited<
          ReturnType<NonNullable<BridgeAdapter["getSessionRunSummary"]>>
        > | null;
        if (adapter.getSessionRunSummary) {
          try {
            runSummary = await adapter.getSessionRunSummary(candidate.sessionId);
          } catch (error) {
            stateStore.appendLog(
              `wechat_resume_run_summary_error: thread=${candidate.sessionId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
            );
          }
        }
        await queueWechatMessage(
          message.senderId,
          formatTaskMessage(
            formatCodexDesktopTaskSelection(candidate, runSummary),
            candidate.sessionId,
          ),
        );
        try {
          const latestMessage =
            await adapter.getLatestSessionMessage?.(candidate.sessionId) ?? null;
          await queueWechatMessage(
            message.senderId,
            formatTaskMessage(
              formatCodexDesktopTaskLatestMessage(latestMessage),
              candidate.sessionId,
            ),
          );
        } catch (error) {
          stateStore.appendLog(
            `wechat_resume_latest_message_error: thread=${candidate.sessionId} error=${truncatePreview(error instanceof Error ? error.message : String(error), 400)}`,
          );
          await queueWechatMessage(
            message.senderId,
            formatTaskMessage(
              "已切换成功，但暂时无法读取这个任务的最近一条消息。",
              candidate.sessionId,
            ),
          );
        }
        return null;
      }
      if (isClaudeProviderKind(options.adapter)) {
        setAwaitingBareCodexTaskSelection(false);
        await queueWechatMessage(
          message.senderId,
          `WeChat /resume is disabled in ${options.adapter} mode. Use /resume directly inside "werelay-${options.adapter}"; WeChat will follow the active local session.`,
        );
        return null;
      }
      if (options.adapter === "opencode") {
        setAwaitingBareCodexTaskSelection(false);
        await queueWechatMessage(
          message.senderId,
          'WeChat /resume is disabled in opencode mode. Use /resume directly inside "werelay-opencode"; WeChat will follow the active local session.',
        );
        return null;
      }

      await queueWechatMessage(
        message.senderId,
        `/resume is not available in ${options.adapter} mode.`,
      );
      return null;
    }
    case "new_session": {
      if (!adapter.createSession) {
        await queueWechatMessage(
          message.senderId,
          `/new is not available in ${options.adapter} mode.`,
        );
        return null;
      }
      await outputBatcher.flushNow();
      outputBatcher.clear();
      stateStore.clearPendingConfirmation();
      stateStore.clearPendingUserInput();
      stateStore.clearSharedSessionId();
      await adapter.createSession();
      stateStore.appendLog(`New ${options.adapter} session requested by owner.`);
      return null;
    }
    case "stop": {
      const currentThreadId =
        adapter.getState().sharedThreadId ?? adapter.getState().sharedSessionId;
      const interrupted = await adapter.interrupt();
      await queueWechatMessage(
        message.senderId,
        formatTaskMessage(
          interrupted
            ? t("bridge.interrupt.sent")
            : t("bridge.interrupt.notBusy"),
          currentThreadId,
        ),
      );
      return null;
    }
    case "reset":
      await outputBatcher.flushNow();
      outputBatcher.clear();
      stateStore.clearPendingConfirmation();
      stateStore.clearPendingUserInput();
      stateStore.clearSharedSessionId();
      await adapter.reset();
      stateStore.appendLog("Worker reset by owner.");
      await queueWechatMessage(message.senderId, "会话已重置。");
      return null;
    case "confirm":
    case "confirm_session": {
      const pending = state.pendingConfirmation;
      if (!pending) {
        await queueWechatMessage(message.senderId, t("approval.noPending"));
        return null;
      }
      const confirmForSession = systemCommand.type === "confirm_session";
      const confirmed = pending.threadId && adapter.resolveTaskApprovals
        ? await adapter.resolveTaskApprovals(
            pending.threadId,
            confirmForSession ? "confirm_session" : "confirm",
          ) > 0
        : confirmForSession
          ? await (adapter.resolveApprovalForSession?.() ?? Promise.resolve(false))
          : await adapter.resolveApproval("confirm");
      if (!confirmed) {
        await queueWechatMessage(
          message.senderId,
          formatTaskMessage(
            confirmForSession
              ? "这项审批不支持本任务始终允许，请回复 1 允许本次或回复 2 拒绝。"
              : "无法确认这项审批，请稍后重试。",
            pending.threadId,
          ),
        );
        return null;
      }
      stateStore.clearPendingConfirmation();
      stateStore.appendLog(
        `Approval ${confirmForSession ? "confirmed for session" : "confirmed"}: ${pending.commandPreview}`,
      );
      await queueWechatMessage(
        message.senderId,
        formatTaskMessage(
          t(confirmForSession ? "approval.sessionConfirmed" : "approval.confirmed"),
          pending.threadId,
        ),
      );
      const currentThreadId =
        adapter.getState().sharedThreadId ?? adapter.getState().sharedSessionId;
      return !pending.threadId || pending.threadId === currentThreadId
        ? {
            startedAt: Date.now(),
            inputPreview: pending.commandPreview,
          }
        : null;
    }
    case "deny": {
      const pending = state.pendingConfirmation;
      if (!pending) {
        await queueWechatMessage(message.senderId, t("approval.noPending"));
        return null;
      }
      const denied = pending.threadId && adapter.resolveTaskApprovals
        ? await adapter.resolveTaskApprovals(pending.threadId, "deny") > 0
        : await adapter.resolveApproval("deny");
      if (!denied) {
        await queueWechatMessage(
          message.senderId,
          formatTaskMessage(
            "无法拒绝这项审批，请稍后重试。",
            pending.threadId,
          ),
        );
        return null;
      }
      stateStore.clearPendingConfirmation();
      stateStore.appendLog(`Approval denied: ${pending.commandPreview}`);
      await queueWechatMessage(
        message.senderId,
        formatTaskMessage(t("approval.denied"), pending.threadId),
      );
      return null;
    }
    case "answer": {
      const pending = state.pendingUserInput;
      if (!pending) {
        await queueWechatMessage(message.senderId, "没有待回答的问题。");
        return null;
      }

      const parsed = parsePendingUserInputAnswerCommand(systemCommand.raw, pending);
      if ("error" in parsed) {
        await queueWechatMessage(
          message.senderId,
          formatTaskMessage(parsed.error, pending.threadId),
        );
        return null;
      }

      const submitted = pending.threadId && adapter.submitTaskUserInput
        ? await adapter.submitTaskUserInput(pending.threadId, parsed.answers)
        : await adapter.submitUserInput(parsed.answers);
      if (!submitted) {
        await queueWechatMessage(
          message.senderId,
          formatTaskMessage(
            "答案提交失败，请重试。",
            pending.threadId,
          ),
        );
        return null;
      }

      stateStore.clearPendingUserInput();
      stateStore.appendLog(`User input answered: ${parsed.preview}`);
      await queueWechatMessage(
        message.senderId,
        formatTaskMessage("答案已提交，继续处理。", pending.threadId),
      );
      const currentThreadId =
        adapter.getState().sharedThreadId ?? adapter.getState().sharedSessionId;
      return !pending.threadId || pending.threadId === currentThreadId
        ? {
            startedAt: Date.now(),
            inputPreview: parsed.preview,
          }
        : null;
    }
  }

  if (state.pendingConfirmation) {
    await queueWechatMessage(
      message.senderId,
      formatTaskMessage(
        formatPendingApprovalReminder(state.pendingConfirmation, adapter.getState()),
        state.pendingConfirmation.threadId,
      ),
    );
    return null;
  }

  if (state.pendingUserInput) {
    await queueWechatMessage(
      message.senderId,
      formatTaskMessage(
        formatPendingUserInputReminder(state.pendingUserInput),
        state.pendingUserInput.threadId,
      ),
    );
    return null;
  }

  const adapterState = adapter.getState();
  if (
    shouldDeferCodexInboundMessage({
      adapter: options.adapter,
      status: adapterState.status,
      hasPendingConfirmation: Boolean(state.pendingConfirmation),
      hasSystemCommand: Boolean(systemCommand),
    })
  ) {
    await deferInboundMessage(message);
    return null;
  }

  if (adapterState.status === "busy" && options.adapter !== "codex") {
    if (
      options.adapter === "opencode" &&
      adapterState.activeTurnOrigin === "local"
    ) {
      await queueWechatMessage(
        message.senderId,
        "桌面端任务正在处理，消息暂未发送。",
      );
      return null;
    }

    await queueWechatMessage(
      message.senderId,
      "任务仍在处理中，请等待完成。",
    );
    return null;
  }

  return dispatchInboundWechatText({
    message,
    options,
    stateStore,
    adapter,
  });
}

async function dispatchInboundWechatText(params: {
  message: InboundWechatMessage;
  options: BridgeCliOptions;
  stateStore: BridgeStateStore;
  adapter: BridgeAdapter;
}): Promise<ActiveTask> {
  const { message, options, stateStore, adapter } = params;
  const preview = formatInboundMessagePreview(message);
  const activeTask: ActiveTask = {
    startedAt: Date.now(),
    inputPreview: truncatePreview(preview, 180),
  };
  stateStore.appendLog(`Forwarded input to ${options.adapter}: ${truncatePreview(preview)}`);
  const prompt = buildWechatInboundPrompt(message.text, message.attachments);
  const threadId = adapter.getState().sharedThreadId ?? adapter.getState().sharedSessionId;
  const result = options.adapter === "codex" && threadId && adapter.sendInputToSession
    ? await adapter.sendInputToSession(threadId, prompt)
    : await adapter.sendInput(prompt);
  if (result?.duplicate) {
    activeTask.duplicate = true;
  } else if (result?.queued) {
    activeTask.queued = true;
    activeTask.queuePosition = result.queuePosition;
  }
  return activeTask;
}

const isDirectRun = Boolean((import.meta as ImportMeta & { main?: boolean }).main);
if (isDirectRun) {
  main().catch((err) => {
    logError(describeWechatTransportError(err));
    process.exit(1);
  });
}

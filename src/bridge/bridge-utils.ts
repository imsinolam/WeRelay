import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { t } from "../i18n/index.ts";

import type {
  ApprovalRequest,
  BridgeAdapterKind,
  BridgeAdapterState,
  BridgeResumeSessionCandidate,
  BridgeResumeThreadCandidate,
  BridgeSessionMessage,
  BridgeSessionRunSummary,
  BridgeSessionSwitchReason,
  BridgeSessionSwitchSource,
  BridgeState,
  BridgeThreadSwitchReason,
  BridgeThreadSwitchSource,
  PendingApproval,
  PendingUserInputRequest,
  UserInputRequestQuestion,
} from "./bridge-types.ts";
import {
  getBridgeProvider,
  isClaudeProviderKind,
} from "./bridge-providers.ts";
import { formatTaskProjectLabel } from "./task-list-format.ts";
import { formatTaskListDisplayTitle } from "./task-list-display.ts";

const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export type SystemCommand =
  | { type: "status" }
  | { type: "help" }
  | { type: "codex_reply_mode"; mode: "preview" | "full" }
  | { type: "resume"; target?: string; page?: number }
  | { type: "resume_page"; direction: "next" | "prev"; count?: number }
  | { type: "new_session"; input?: string }
  | { type: "stop" }
  | { type: "reset" }
  | { type: "confirm" }
  | { type: "confirm_session" }
  | { type: "confirm_task" }
  | { type: "deny" }
  | { type: "answer"; raw: string };

// Messages older than bridge start minus this grace window are treated as
// pre-start backlog and skipped. The window must absorb realistic clock skew
// between the local machine and WeChat server timestamps: with a small value,
// a PC clock running slightly ahead silently dropped fresh messages.
export const MESSAGE_START_GRACE_MS = 30_000;
export const CODEX_TASK_LIST_PAGE_SIZE = 10;
export const CODEX_TASK_LIST_MAX_PAGE_SIZE = 100;

export type CodexTaskListPagePosition = {
  startIndex: number;
  pageSize: number;
};

export function resolveCodexTaskListPageNavigation(params: {
  direction: "next" | "prev";
  current: CodexTaskListPagePosition;
  history: CodexTaskListPagePosition[];
  requestedPageSize?: number;
}): {
  current: CodexTaskListPagePosition;
  history: CodexTaskListPagePosition[];
} {
  if (params.direction === "prev") {
    const previous = params.history.at(-1);
    if (previous) {
      return {
        current: previous,
        history: params.history.slice(0, -1),
      };
    }
    return {
      current: { startIndex: 0, pageSize: CODEX_TASK_LIST_PAGE_SIZE },
      history: [],
    };
  }

  const requestedPageSize = params.requestedPageSize ?? CODEX_TASK_LIST_PAGE_SIZE;
  const pageSize = Math.min(
    CODEX_TASK_LIST_MAX_PAGE_SIZE,
    Math.max(1, Math.trunc(requestedPageSize)),
  );
  return {
    current: {
      startIndex: params.current.startIndex + params.current.pageSize,
      pageSize,
    },
    history: [...params.history, params.current],
  };
}
const WECHAT_ATTACHMENT_SEND_INTENT_RE =
  /\b(send|upload|attach|forward|share)\b/i;
const WECHAT_ATTACHMENT_SEND_INTENT_ZH_RE =
  /发送|发给我|发我|给我发|发过来|发一下|发来|发到|发微信|上传|转发|分享|传给我|传我|传到/;
const WECHAT_ATTACHMENT_SHORT_SEND_ZH_RE =
  /^(?:发|发呀|发呢|发吧|直接发|直接发给我|发给我|发我|发微信|发送微信)$/;
const WECHAT_ATTACHMENT_FILE_TERM_RE =
  /\b(file|attachment|pdf|document|docx?|xlsx?|pptx?|csv|txt|zip|rar|7z|image|photo|picture|screenshot|audio|voice|video|png|jpe?g|gif|webp|bmp|mp3|wav|m4a|ogg|aac|mov|mp4|mkv|avi)\b/i;
const WECHAT_ATTACHMENT_FILE_TERM_ZH_RE =
  /文件|附件|文档|压缩包|图片|照片|截图|音频|语音|视频|pdf|PDF/;
const LOCAL_ATTACHMENT_PATH_HINT_RE =
  /(?:[A-Za-z]:\\|(?:~[\\/])?(?:Desktop|Documents|Downloads|Pictures|Videos|Music)[\\/]|桌面|下载目录|下载文件夹)/i;
export function buildWechatAttachmentPromptPrefix(
  platform: NodeJS.Platform = process.platform,
): string {
  const examplePath = platform === "win32"
    ? "C:\\Users\\用户名\\Desktop\\document.pdf"
    : platform === "darwin"
      ? "/Users/用户名/Desktop/document.pdf"
      : "/home/用户名/document.pdf";
  return [
    "[微信转发内部说明]",
    "你的最终回复会转发到微信。",
    "仅当用户明确要求发送本机文件或媒体，并且你知道原始文件路径时，才使用下面的附件块；不要回答没有微信发送工具。",
    "直接引用原始本地绝对路径，不要在 ~/.claude/channels/wechat、~/.werelay 或任何 outbound-attachments 目录中创建、复制、移动或暂存文件。",
    "先写简短的可见回复，然后在末尾只放一个附件块，例如：",
    "```wechat-attachments",
    `file ${examplePath}`,
    "```",
    "支持 image、file、video、voice；PDF 和普通文档使用 file。只列出确实需要发送的文件。",
    "",
    "[用户请求]",
  ].join("\n");
}

export function sanitizeWechatInboundPromptForDisplay(value: string): string {
  let normalized = normalizeOutput(value).trim();
  const requestMarkers = ["\n[User request]\n", "\n[用户请求]\n"];
  let requestIndex = -1;
  let requestMarker = "";
  for (const marker of requestMarkers) {
    const index = normalized.lastIndexOf(marker);
    if (index > requestIndex) {
      requestIndex = index;
      requestMarker = marker;
    }
  }
  if (requestIndex >= 0) {
    normalized = normalized.slice(requestIndex + requestMarker.length);
  }

  const attachmentMarkers = [
    "\n\n[WeChat inbound attachments",
    "\n[WeChat inbound attachments",
    "\n\n[微信入站附件",
    "\n[微信入站附件",
  ];
  let attachmentIndex = -1;
  for (const marker of attachmentMarkers) {
    const index = normalized.indexOf(marker);
    if (index >= 0 && (attachmentIndex < 0 || index < attachmentIndex)) {
      attachmentIndex = index;
    }
  }
  if (attachmentIndex >= 0) {
    normalized = normalized.slice(0, attachmentIndex);
  }
  return normalized.trim();
}

const CODEX_MODEL_HANDOFF_PREFIX_RE =
  /^Another language model started to solve this problem and produced a summary of its thinking process\.\s+You also have access to the state of the tools that were used by that language model\./i;

function isCodexInternalUserMessage(value: string): boolean {
  const trimmed = value.trimStart();
  if (
    /^#\s+AGENTS\.md instructions\s*(?:\r?\n|$)/i.test(trimmed) &&
    /<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/i.test(trimmed)
  ) {
    return true;
  }
  return CODEX_MODEL_HANDOFF_PREFIX_RE.test(trimmed) ||
    /^<(?:subagent_notification|turn_aborted)\b/i.test(trimmed) ||
    /^##\s+user confirmation protocol\b/i.test(trimmed);
}

export function sanitizeCodexVisibleAssistantMessageForDisplay(
  value: string,
): string | null {
  const sanitized = normalizeOutput(value)
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<thinking\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<\/?thinking\b[^>]*>/gi, "")
    .trim();
  return sanitized || null;
}

export function sanitizeCodexVisibleUserMessageForDisplay(
  value: string,
): string | null {
  const withoutDesktopContext = normalizeOutput(value)
    .replace(
      /<(in-app-browser-context|app-context|environment_context)\b[^>]*>[\s\S]*?<\/\1>/gi,
      "",
    )
    .trim();
  const sanitized = sanitizeWechatInboundPromptForDisplay(withoutDesktopContext).trim();
  if (!sanitized || isCodexInternalUserMessage(sanitized)) {
    return null;
  }
  if (
    /^#\s+Files mentioned by the user:/im.test(sanitized) ||
    /^##\s+My request for Codex:/im.test(sanitized) ||
    /<image\b[^>]*\bpath=/i.test(sanitized)
  ) {
    const compact = compactMirroredUserInputText(sanitized).trim();
    return compact && compact !== "（空消息）" ? compact : null;
  }
  return sanitized;
}

const WECHAT_ATTACHMENT_BLOCK_RE =
  /\n```wechat-attachments[ \t]*\n([\s\S]*?)\n```[ \t]*$/;

export const WECHAT_OUTBOUND_ATTACHMENT_DENY_MESSAGE =
  "WeRelay does not use outbound attachment directories for the WeChat channel. Do not create or copy files under .claude/channels/wechat/outbound-attachments or .werelay/outbound-attachments. To send a file, put the original absolute local file path in the final ```wechat-attachments``` block.";

const WECHAT_OUTBOUND_ATTACHMENT_PATH_RE =
  /(?:^|\/)(?:(?:\.claude\/channels\/wechat\/|\.werelay\/)?outbound-attachments)(?:\/|$)/i;
const WECHAT_OUTBOUND_ATTACHMENT_WRITE_COMMAND_RE =
  /\b(cp|copy|copy-item|xcopy|robocopy|mv|move|move-item|mkdir|md|new-item|ni|set-content|add-content|out-file|write-output|touch)\b|>\s*["']?[^&|]*outbound-attachments/i;
const WECHAT_OUTBOUND_ATTACHMENT_MUTATION_TOOL_RE =
  /^(?:write|edit|multiedit|notebookedit|patch|create|mkdir|move|copy|file[_-]?change|external_directory)$/i;

const WECHAT_ATTACHMENT_KINDS = ["image", "file", "video", "voice"] as const;
const INLINE_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
]);
const INLINE_VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mkv",
  ".avi",
  ".webm",
]);
const INLINE_VOICE_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".ogg",
  ".aac",
]);
const INLINE_REFERENCE_ONLY_FILE_EXTENSIONS = new Set([
  ".bat",
  ".c",
  ".cc",
  ".cjs",
  ".cmd",
  ".cpp",
  ".cs",
  ".cts",
  ".cxx",
  ".go",
  ".h",
  ".hh",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".lua",
  ".m",
  ".mjs",
  ".mm",
  ".mts",
  ".php",
  ".pl",
  ".ps1",
  ".psd1",
  ".psm1",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
  ".vb",
  ".zsh",
]);
const INLINE_MAAS_URL_RE =
  /https?:\/\/[^\s]*?\/([A-Za-z]:\\.+?(?:\.\s*[A-Za-z0-9]{2,8})+)(?:\?[^\n]*)?/g;
const INLINE_WINDOWS_PATH_RE =
  /(^|[^\w])`?([A-Za-z]:\\(?:[^\\/:*?"<>|\r\n`]+\\)*[^\\/:*?"<>|\r\n`]+?(?:\.\s*[A-Za-z0-9]{2,8})+)`?(?=$|[^\w])/gm;
const INLINE_HOME_RELATIVE_PATH_RE =
  /(^|[^\w])`?((?:~[\\/])?(?:Desktop|Documents|Downloads|Pictures|Videos|Music)[\\/](?:[^\\/:*?"<>|\r\n`]+[\\/])*[^\\/:*?"<>|\r\n`]+?(?:\.\s*[A-Za-z0-9]{2,8})+)`?(?=$|[^\w])/gim;

export type WechatAttachmentKind = (typeof WECHAT_ATTACHMENT_KINDS)[number];

export type WechatReplyAttachment = {
  kind: WechatAttachmentKind;
  path: string;
};

export type WechatInboundPromptAttachment = {
  kind: "image" | "file";
  path: string;
  fileName?: string;
  sizeBytes?: number;
};

export type ParsedWechatFinalReply = {
  visibleText: string;
  attachments: WechatReplyAttachment[];
};

type CodexSessionJsonLine = {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    phase?: string;
    message?: string;
  };
};

export type CodexSessionAgentMessage = {
  timestamp?: string;
  phase?: string;
  message: string;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export function normalizeOutput(text: string): string {
  return stripAnsi(text)
    // eslint-disable-next-line no-control-regex
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function truncatePreview(text: string, maxLength = 140): string {
  const normalized = normalizeOutput(text).trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "(empty)";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function redactSensitiveCommandText(text: string): string {
  return text
    .replace(
      /(\bsshpass\s+(?:[^\r\n]*?\s)?-p\s+)(["'])(.*?)\2/gi,
      "$1$2[已隐藏]$2",
    )
    .replace(
      /(\b(?:--password|--passwd|--token|--api[-_]?key)\s*(?:=|\s)\s*)(["']?)([^\s"']+)\2/gi,
      "$1$2[已隐藏]$2",
    )
    .replace(
      /(\b(?:password|passwd|token|api[-_]?key|authorization)\s*=\s*)(["']?)([^\s"']+)\2/gi,
      "$1$2[已隐藏]$2",
    )
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[已隐藏]");
}

function truncateMobileText(text: string, maxLength: number): string {
  const normalized = normalizeOutput(text).trim();
  if (!normalized) {
    return "（空消息）";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 5)).trimEnd()}\n（已截断）`;
}

export function isThinkingForwardEnabled(): boolean {
  if (process.env.WERELAY_THINKING_FORWARD === "1") {
    return true;
  }
  try {
    const accountPath = process.env.WERELAY_DATA_DIR
      ? path.join(process.env.WERELAY_DATA_DIR, "account.json")
      : path.join(os.homedir(), ".werelay", "account.json");
    if (!fs.existsSync(accountPath)) return false;
    const raw = fs.readFileSync(accountPath, "utf8");
    const data = JSON.parse(raw) as { enableThinkingForward?: boolean };
    return data.enableThinkingForward === true;
  } catch {
    return false;
  }
}

export function formatThinkingForWechat(text: string, maxLength = 500): string {
  const normalized = normalizeOutput(text).trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function buildOneTimeCode(length = 6): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  while (code.length < length) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export function buildInstanceId(): string {
  return `bridge-${Date.now().toString(36)}-${buildOneTimeCode(6).toLowerCase()}`;
}

export function parseSystemCommand(text: string): SystemCommand | null {
  const trimmed = text.trim();
  const newSessionWithInput = trimmed.match(
    /^(?:新建|新建任务|新建会话)\s*[：:]\s*(.+)$/s,
  );
  if (newSessionWithInput?.[1]?.trim()) {
    return { type: "new_session", input: newSessionWithInput[1].trim() };
  }
  if (["新建", "新建任务", "新建会话"].includes(trimmed)) {
    return { type: "new_session" };
  }
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  if (!rawCommand) {
    return null;
  }
  const command = rawCommand.toLowerCase();
  const argument = rest.join(" ").trim();
  const compactTaskMatch = command.match(/^\/t([1-9]\d*)$/);
  if (compactTaskMatch && !argument) {
    return { type: "resume", target: compactTaskMatch[1] };
  }
  const compactNextMatch = command.match(/^\/next([1-9]\d*)$/);
  if (compactNextMatch && !argument) {
    const count = Number(compactNextMatch[1]);
    return Number.isSafeInteger(count) && count <= CODEX_TASK_LIST_MAX_PAGE_SIZE
      ? { type: "resume_page", direction: "next", count }
      : null;
  }

  switch (command) {
    case "/status":
      return { type: "status" };
    case "/h":
    case "/help":
      return { type: "help" };
    case "/full":
    case "/全文":
      return { type: "codex_reply_mode", mode: "full" };
    case "/brief":
    case "/preview":
    case "/预览":
      return { type: "codex_reply_mode", mode: "preview" };
    case "/next": {
      if (!argument) {
        return { type: "resume_page", direction: "next" };
      }
      if (/^[1-9]\d*$/.test(argument)) {
        const count = Number(argument);
        return Number.isSafeInteger(count) && count <= CODEX_TASK_LIST_MAX_PAGE_SIZE
          ? { type: "resume_page", direction: "next", count }
          : null;
      }
      return null;
    }
    case "/prev":
      return { type: "resume_page", direction: "prev" };
    case "/resume":
      return argument ? { type: "resume", target: argument } : { type: "resume" };
    case "/tasks":
    case "/threads": {
      if (!argument) {
        return { type: "resume" };
      }
      if (/^[1-9]\d*$/.test(argument)) {
        const page = Number(argument);
        return Number.isSafeInteger(page) && page <= 100
          ? { type: "resume", page }
          : null;
      }
      return { type: "resume", target: argument };
    }
    case "/task":
    case "/thread":
      return argument ? { type: "resume", target: argument } : { type: "resume" };
    case "/new":
    case "/new-session":
      return argument
        ? { type: "new_session", input: argument }
        : { type: "new_session" };
    case "/stop":
      return { type: "stop" };
    case "/reset":
      return { type: "reset" };
    case "/confirm":
    case "/yes":
      return { type: "confirm" };
    case "/deny":
    case "/no":
      return { type: "deny" };
    case "/answer":
      return argument ? { type: "answer", raw: argument } : null;
    default:
      return null;
  }
}

export function resolveBareCodexTaskSelection(params: {
  adapter: BridgeAdapterKind;
  text: string;
  awaitingSelection: boolean;
  hasPendingConfirmation: boolean;
  hasPendingUserInput: boolean;
}): string | null {
  if (
    !params.awaitingSelection ||
    params.hasPendingConfirmation ||
    params.hasPendingUserInput
  ) {
    return null;
  }

  const normalized = params.text.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    return null;
  }
  const index = Number(normalized);
  return Number.isSafeInteger(index) ? normalized : null;
}

export function parseWechatControlCommand(
  text: string,
  options: {
    adapter: BridgeAdapterKind;
    hasPendingConfirmation: boolean;
    hasPendingUserInput: boolean;
    canConfirmForSession?: boolean;
    canAutoApproveTask?: boolean;
  },
): SystemCommand | null {
  if (shouldForwardNativeSlashCommand(text, options.adapter)) {
    return null;
  }
  const systemCommand = parseSystemCommand(text);
  if (systemCommand) {
    return systemCommand;
  }

  const exactText = text.trim();
  const nextPageMatch = exactText.match(/^下一页\s*([1-9]\d*)?$/);
  if (nextPageMatch) {
    if (!nextPageMatch[1]) {
      return { type: "resume_page", direction: "next" };
    }
    const count = Number(nextPageMatch[1]);
    return Number.isSafeInteger(count) && count <= CODEX_TASK_LIST_MAX_PAGE_SIZE
      ? { type: "resume_page", direction: "next", count }
      : null;
  }
  if (exactText === "任务" || exactText === "任务列表") {
    return { type: "resume" };
  }
  const taskTargetMatch = exactText.match(/^任务(?:\s*[：:]\s*|\s+)(.*)$/);
  if (taskTargetMatch) {
    const target = taskTargetMatch[1]?.trim() ?? "";
    return target ? { type: "resume", target } : { type: "resume" };
  }
  switch (exactText) {
    case "上一页":
      return { type: "resume_page", direction: "prev" };
    case "状态":
      return { type: "status" };
    case "停止":
      return { type: "stop" };
    case "帮助":
      return { type: "help" };
  }
  if (options.adapter === "codex") {
    switch (exactText) {
      case "全文":
        return { type: "codex_reply_mode", mode: "full" };
      case "预览":
        return { type: "codex_reply_mode", mode: "preview" };
    }
  }

  if (!options.hasPendingConfirmation) {
    return null;
  }

  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  switch (normalized) {
    case "1":
      return { type: "confirm" };
    case "2":
      return { type: "deny" };
    case "3":
      return options.canConfirmForSession
        ? { type: "confirm_session" }
        : options.canAutoApproveTask
          ? { type: "confirm_task" }
          : null;
    case "4":
      return options.canConfirmForSession && options.canAutoApproveTask
        ? { type: "confirm_task" }
        : null;
    case "confirm":
    case "yes":
    case "approve":
    case "同意":
    case "允许":
    case "确认":
    case "可以":
    case "继续":
      return { type: "confirm" };
    case "deny":
    case "no":
    case "reject":
    case "拒绝":
    case "取消":
    case "不允许":
    case "不同意":
    case "不可以":
      return { type: "deny" };
    default:
      return null;
  }
}

const WERELAY_RESERVED_SLASH_COMMAND_RE = /^(?:\/(?:h|help|tasks|threads|task|thread|resume|next|prev|new|new-session|stop|full|brief|preview|全文|预览|confirm|yes|deny|no|answer)|\/t[1-9]\d*)$/i;

export function shouldForwardNativeSlashCommand(
  text: string,
  adapter: BridgeAdapterKind,
): boolean {
  if (!getBridgeProvider(adapter).capabilities.nativeCommands) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }
  const command = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return Boolean(command) && !WERELAY_RESERVED_SLASH_COMMAND_RE.test(command);
}

export function shouldInjectWechatAttachmentPrompt(text: string): boolean {
  const normalized = normalizeOutput(text).trim();
  if (!normalized || normalized.includes("```wechat-attachments")) {
    return false;
  }

  const mentionsSendIntent =
    WECHAT_ATTACHMENT_SEND_INTENT_RE.test(normalized) ||
    WECHAT_ATTACHMENT_SEND_INTENT_ZH_RE.test(normalized) ||
    WECHAT_ATTACHMENT_SHORT_SEND_ZH_RE.test(normalized);
  if (!mentionsSendIntent) {
    return false;
  }

  const mentionsFileOrMedia =
    WECHAT_ATTACHMENT_FILE_TERM_RE.test(normalized) ||
    WECHAT_ATTACHMENT_FILE_TERM_ZH_RE.test(normalized);
  const mentionsLocalPath = LOCAL_ATTACHMENT_PATH_HINT_RE.test(normalized);
  const isExplicitShortSendCommand = WECHAT_ATTACHMENT_SHORT_SEND_ZH_RE.test(normalized);

  return mentionsFileOrMedia || mentionsLocalPath || isExplicitShortSendCommand;
}

export function containsWechatOutboundAttachmentPath(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().replace(/\\/g, "/");
  return WECHAT_OUTBOUND_ATTACHMENT_PATH_RE.test(normalized);
}

export function containsWechatOutboundAttachmentPathDeep(value: unknown): boolean {
  const seen = new WeakSet<object>();

  const visit = (candidate: unknown): boolean => {
    if (containsWechatOutboundAttachmentPath(candidate)) {
      return true;
    }
    if (!candidate || typeof candidate !== "object") {
      return false;
    }
    if (seen.has(candidate)) {
      return false;
    }
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      return candidate.some((item) => visit(item));
    }
    return Object.values(candidate).some((item) => visit(item));
  };

  return visit(value);
}

export function isWechatOutboundAttachmentWriteCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    containsWechatOutboundAttachmentPath(command) &&
    WECHAT_OUTBOUND_ATTACHMENT_WRITE_COMMAND_RE.test(command)
  );
}

export function isWechatOutboundAttachmentMutationTool(
  toolName: unknown,
  targetPath: unknown,
): boolean {
  return (
    typeof toolName === "string" &&
    WECHAT_OUTBOUND_ATTACHMENT_MUTATION_TOOL_RE.test(toolName.trim()) &&
    containsWechatOutboundAttachmentPath(targetPath)
  );
}

function formatPromptByteSize(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(bytes >= 100 * 1024 ? 0 : 1)} KB`;
  }
  return `${bytes} B`;
}

function formatWechatInboundAttachmentPrompt(
  attachments: WechatInboundPromptAttachment[],
): string {
  const lines = [
    "[微信入站附件]",
    "用户通过微信发送了以下文件。回复前必须逐一读取下面的本地路径，包括图片；不要跳过。",
  ];

  attachments.forEach((attachment, index) => {
    const sizeText = formatPromptByteSize(attachment.sizeBytes);
    const metadata = [
      `kind=${attachment.kind}`,
      attachment.fileName ? `name=${attachment.fileName}` : "",
      sizeText ? `size=${sizeText}` : "",
    ].filter(Boolean);
    lines.push(`${index + 1}. ${metadata.join(" ")} path=${attachment.path}`);
  });

  lines.push("");
  lines.push("请立即读取以上路径后再回复；图片也可以直接读取查看。");

  return lines.join("\n");
}

export function buildWechatInboundPrompt(
  text: string,
  attachments: WechatInboundPromptAttachment[] = [],
): string {
  const trimmedAttachments = attachments.filter((attachment) => attachment.path.trim());

  if (!trimmedAttachments.length) {
    if (!shouldInjectWechatAttachmentPrompt(text)) {
      return text;
    }

    const normalized = normalizeOutput(text).trim();
    if (!normalized) {
      return text;
    }

    return `${buildWechatAttachmentPromptPrefix()}\n${normalized}`;
  }

  const baseText = normalizeOutput(text).trim() || "收到微信附件。";
  const userPrompt = shouldInjectWechatAttachmentPrompt(baseText)
    ? `${buildWechatAttachmentPromptPrefix()}\n${baseText.trim()}`
    : baseText;

  return `${userPrompt.trim()}\n\n${formatWechatInboundAttachmentPrompt(trimmedAttachments)}`;
}

export function parseWechatFinalReply(text: string): ParsedWechatFinalReply {
  const normalized = normalizeOutput(text);
  const withLeadingNewline = normalized.startsWith("\n")
    ? normalized
    : `\n${normalized}`;
  const match = withLeadingNewline.match(WECHAT_ATTACHMENT_BLOCK_RE);
  if (!match) {
    return extractInlineWechatAttachments(normalized);
  }

  const attachments: WechatReplyAttachment[] = [];
  const attachmentBlock = match[1];
  if (attachmentBlock === undefined) {
    return extractInlineWechatAttachments(normalized);
  }

  const lines = attachmentBlock
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return extractInlineWechatAttachments(normalized);
  }

  for (const line of lines) {
    const parsed = /^(image|file|video|voice)\s+(.+)$/.exec(line);
    if (!parsed) {
      return extractInlineWechatAttachments(normalized);
    }

    const kind = parsed[1] as WechatAttachmentKind;
    const rawPath = parsed[2];
    if (!rawPath) {
      return extractInlineWechatAttachments(normalized);
    }

    const attachmentPath = resolveWechatAttachmentPath(rawPath);
    if (!attachmentPath) {
      return extractInlineWechatAttachments(normalized);
    }

    attachments.push({
      kind,
      path: attachmentPath,
    });
  }

  const blockIndex = withLeadingNewline.length - match[0].length;
  const visibleText = withLeadingNewline.slice(0, blockIndex).trim();
  const parsedFromBlock = {
    visibleText,
    attachments,
  };
  return parsedFromBlock.attachments.length > 0
    ? parsedFromBlock
    : extractInlineWechatAttachments(normalized);
}

export function parseCodexSessionAgentMessage(
  line: string,
): CodexSessionAgentMessage | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: CodexSessionJsonLine;
  try {
    parsed = JSON.parse(trimmed) as CodexSessionJsonLine;
  } catch {
    return null;
  }

  if (parsed.type !== "event_msg" || parsed.payload?.type !== "agent_message") {
    return null;
  }

  const message =
    typeof parsed.payload.message === "string"
      ? normalizeOutput(parsed.payload.message).trim()
      : "";
  if (!message) {
    return null;
  }

  return {
    timestamp: parsed.timestamp,
    phase: typeof parsed.payload.phase === "string" ? parsed.payload.phase : undefined,
    message,
  };
}

const HIGH_RISK_PATTERNS = [
  /\bremove-item\b/i,
  /\brd\b/i,
  /\brmdir\b/i,
  /\bdel\b/i,
  /\berase\b/i,
  /\bformat\b(?!-)/i,
  /\bshutdown\b/i,
  /\bstop-computer\b/i,
  /\brestart-computer\b/i,
  /\bstop-process\b/i,
  /\btaskkill\b/i,
  /\breg\s+delete\b/i,
  /\bsc\s+delete\b/i,
  /\bdiskpart\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-f/i,
  /\bset-executionpolicy\b/i,
  /\bstart-process\b.*\b-verb\s+runas\b/i,
  /\b(?:invoke-expression|iex)\b/i,
  /\bcurl\b.*\|\s*(?:iex|powershell)\b/i,
  /\binvoke-webrequest\b.*\|\s*(?:iex|powershell)\b/i,
  /\brm\b\s+/i,
  /\brm\b\s+-[A-Za-z-]*r[A-Za-z-]*/i,
  /\bfind\b[^\r\n]*\s-delete\b/i,
  /\bfind\b[^\r\n]*\s-exec\s+(?:rm|rmdir|del|erase|remove-item)\b/i,
  /\bxargs\b[^\r\n]*\b(?:rm|rmdir|del|erase|remove-item)\b/i,
  /\bsudo\b/i,
  /\bmkfs(?:\.\w+)?\b/i,
  /\bdd\b/i,
  /\breboot\b/i,
  /\bsystemctl\b/i,
  /\blaunchctl\b/i,
  /\bcurl\b.*\|\s*(?:sh|bash|zsh)\b/i,
  /\bwget\b.*\|\s*(?:sh|bash|zsh)\b/i,
];

export function isHighRiskShellCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(normalized));
}

const ALWAYS_INTERACTIVE_SHELL_COMMANDS = new Set([
  "ftp",
  "htop",
  "irb",
  "less",
  "more",
  "mongosh",
  "mysql",
  "nano",
  "nvim",
  "psql",
  "redis-cli",
  "screen",
  "sftp",
  "sqlite3",
  "ssh",
  "telnet",
  "tmux",
  "top",
  "vi",
  "vim",
  "watch",
]);

function tokenizeShellCommand(command: string, maxTokens = 16): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
        if (tokens.length >= maxTokens) {
          return tokens;
        }
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function normalizeShellExecutableToken(token: string): string {
  const trimmed = token.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) {
    return "";
  }
  return path.parse(trimmed).name.toLowerCase();
}

function findCommandFlagIndex(args: string[], supportedFlags: string[]): number {
  return args.findIndex((arg) => supportedFlags.includes(arg.toLowerCase()));
}

function hasScriptLikeArg(args: string[]): boolean {
  return args.some((arg) => Boolean(arg) && !arg.startsWith("-") && !arg.startsWith("/"));
}

function hasAnyCommandFlag(args: string[], supportedFlags: string[]): boolean {
  return findCommandFlagIndex(args, supportedFlags) >= 0;
}

function buildInteractiveShellCommandMessage(executable: string, suggestion: string): string {
  return `暂不支持交互命令“${executable}”。请改用一次性命令或脚本。${suggestion}`;
}

export function getInteractiveShellCommandRejectionMessage(command: string): string | null {
  const tokens = tokenizeShellCommand(command);
  if (!tokens.length) {
    return null;
  }

  const firstToken = tokens[0];
  if (!firstToken) {
    return null;
  }

  const executable = normalizeShellExecutableToken(firstToken);
  const args = tokens.slice(1);
  const lowerArgs = args.map((arg) => arg.toLowerCase());

  if (!executable) {
    return null;
  }

  if (ALWAYS_INTERACTIVE_SHELL_COMMANDS.has(executable)) {
    return buildInteractiveShellCommandMessage(
      executable,
      "请直接发送要执行的命令。",
    );
  }

  switch (executable) {
    case "python":
    case "python3":
    case "py": {
      if (!args.length) {
        return buildInteractiveShellCommandMessage(
          executable,
          '可用：python script.py 或 python -c "..."。',
        );
      }
      if (lowerArgs.includes("-i") || lowerArgs.includes("--interactive")) {
        return buildInteractiveShellCommandMessage(
          executable,
          '可用：python script.py 或 python -c "..."。',
        );
      }
      if (hasAnyCommandFlag(lowerArgs, ["-c", "-h", "--help", "-v", "--version"])) {
        return null;
      }
      const moduleFlagIndex = findCommandFlagIndex(lowerArgs, ["-m"]);
      if (moduleFlagIndex >= 0) {
        return moduleFlagIndex < args.length - 1
          ? null
          : buildInteractiveShellCommandMessage(
              executable,
              "可用：python script.py 或 python -m 模块名。",
            );
      }
      return hasScriptLikeArg(args)
        ? null
        : buildInteractiveShellCommandMessage(
            executable,
            '可用：python script.py 或 python -c "..."。',
          );
    }

    case "node":
      if (!args.length || lowerArgs.includes("-i") || lowerArgs.includes("--interactive")) {
        return buildInteractiveShellCommandMessage(
          executable,
          '可用：node script.js 或 node -e "..."。',
        );
      }
      if (hasAnyCommandFlag(lowerArgs, ["-e", "--eval", "-p", "--print", "-h", "--help", "-v", "--version"])) {
        return null;
      }
      return hasScriptLikeArg(args)
        ? null
        : buildInteractiveShellCommandMessage(
            executable,
            '可用：node script.js 或 node -e "..."。',
          );

    case "cmd":
      if (lowerArgs.includes("/?")) {
        return null;
      }
      if (lowerArgs.includes("/k") || !lowerArgs.includes("/c")) {
        return buildInteractiveShellCommandMessage(
          executable,
          "可用：cmd /c 命令，或直接发送命令。",
        );
      }
      return null;

    case "powershell":
    case "pwsh":
      if (
        !args.length ||
        lowerArgs.includes("-noexit") ||
        lowerArgs.includes("-nologo") && args.length === 1
      ) {
        return buildInteractiveShellCommandMessage(
          executable,
          `可用：${executable} -Command "..." 或 ${executable} -File script.ps1。`,
        );
      }
      if (
        hasAnyCommandFlag(
          lowerArgs,
          ["-c", "-command", "-enc", "-encodedcommand", "-f", "-file", "-h", "-help", "-v", "-version", "-?"],
        )
      ) {
        return null;
      }
      return hasScriptLikeArg(args)
        ? null
        : buildInteractiveShellCommandMessage(
            executable,
            `可用：${executable} -Command "..." 或 ${executable} -File script.ps1。`,
          );

    case "bash":
    case "dash":
    case "ksh":
    case "sh":
    case "zsh":
      if (!args.length || lowerArgs.includes("-i")) {
        return buildInteractiveShellCommandMessage(
          executable,
          `可用：${executable} -c '...' 或 ${executable} script.sh。`,
        );
      }
      if (findCommandFlagIndex(lowerArgs, ["-c", "-lc"]) >= 0) {
        return null;
      }
      if (hasAnyCommandFlag(lowerArgs, ["-h", "--help", "--version"])) {
        return null;
      }
      return hasScriptLikeArg(args)
        ? null
        : buildInteractiveShellCommandMessage(
            executable,
            `可用：${executable} -c '...' 或 ${executable} script.sh。`,
          );

    default:
      return null;
  }
}

export function detectCliApproval(text: string): ApprovalRequest | null {
  const normalized = normalizeOutput(text);
  const compact = normalized.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }

  const approvalPatterns: Array<{
    pattern: RegExp;
    confirmInput?: string;
    denyInput?: string;
  }> = [
    { pattern: /\bdo you want to allow\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\bapprove\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\ballow this\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\b\(y\/n\)\b/i, confirmInput: "y\r", denyInput: "n\r" },
    { pattern: /\byes\/no\b/i, confirmInput: "yes\r", denyInput: "no\r" },
    { pattern: /\bpress enter to continue\b/i, confirmInput: "\r" },
    { pattern: /\bconfirm to continue\b/i, confirmInput: "y\r", denyInput: "n\r" },
  ];

  const matched = approvalPatterns.find(({ pattern }) => pattern.test(compact));
  if (!matched) {
    return null;
  }

  const preview = truncatePreview(compact, 160);
  return {
    source: "cli",
    summary: t("approval.cliRequired"),
    commandPreview: preview,
    confirmInput: matched.confirmInput,
    denyInput: matched.denyInput,
  };
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0秒";
  }

  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (!minutes) {
    return `${seconds}秒`;
  }

  return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
}

export function summarizeOutput(text: string, maxLength = 280): string {
  const normalized = normalizeOutput(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!normalized.length) {
    return "（无输出）";
  }

  const summary = normalized.slice(-6).join("\n");
  if (summary.length <= maxLength) {
    return summary;
  }

  return summary.slice(summary.length - maxLength);
}

function formatAdapterLabel(adapter: BridgeAdapterKind): string {
  return getBridgeProvider(adapter).label;
}

export function formatWorkerStatusLabel(
  status: BridgeAdapterState["status"],
): string {
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

function formatTurnOriginLabel(origin: BridgeAdapterState["activeTurnOrigin"]): string | null {
  if (origin === "local") {
    return "桌面端";
  }
  if (origin === "wechat") {
    return "微信";
  }
  return null;
}

function hasChineseText(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function compactApprovalSummary(text: string, fallback: string): string {
  const normalized = normalizeOutput(text)
    .replace(/^CLI approval is required\.?\s*/i, "")
    .replace(/^Codex needs approval before (?:running a command|making file changes|continuing):?\s*/i, "")
    .replace(/^Codex approval is required:?\s*/i, "")
    .trim();
  return hasChineseText(normalized)
    ? truncatePreview(normalized, 100)
    : fallback;
}

export function compactUserFacingError(text: string, maxLength = 160): string {
  const normalized = normalizeOutput(text)
    .replace(/\s+Recent app-server log:.*$/s, "")
    .trim();
  if (!normalized) {
    return "未知错误";
  }

  if (/app-server.*(?:websocket )?closed|websocket.*closed|connection.*closed/i.test(normalized)) {
    return "Codex 连接已断开，请稍后重试。";
  }
  if (/app-server is not ready|runtime host is not ready|not ready/i.test(normalized)) {
    return "Codex 尚未就绪，请稍后重试。";
  }
  if (/companion is not connected|panel is not running|not connected/i.test(normalized)) {
    return "桌面端未连接，请在电脑上重新打开客户端。";
  }
  if (/still working|currently busy/i.test(normalized)) {
    return "任务仍在处理中。";
  }
  if (/approval request is pending|waiting for approval/i.test(normalized)) {
    return "任务正在等待审批。";
  }
  if (/waiting for local terminal input/i.test(normalized)) {
    return "任务正在等待桌面端输入。";
  }

  const firstLine = normalized
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? normalized;
  const shortenedPaths = firstLine.replace(
    /(?:\/(?:Users|private|var|tmp)\/[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+)/g,
    (value) => path.basename(value.replace(/\\/g, "/")) || "本地文件",
  );
  return truncatePreview(shortenedPaths, maxLength);
}

export function formatStatusReport(
  bridgeState: BridgeState,
  adapterState: BridgeAdapterState,
): string {
  const status = bridgeState.pendingConfirmation
    ? "待审批"
    : bridgeState.pendingUserInput
      ? "待输入"
      : formatWorkerStatusLabel(adapterState.status);
  const origin = formatTurnOriginLabel(adapterState.activeTurnOrigin);
  return [
    `状态：${status}`,
    origin ? `来源：${origin}` : "",
    bridgeState.ignoredBacklogCount > 0
      ? `已忽略旧消息：${bridgeState.ignoredBacklogCount} 条`
      : "",
  ].filter(Boolean).join("\n");
}

export function formatSessionSwitchMessage(params: {
  adapter: BridgeAdapterKind;
  sessionId: string;
  source: BridgeSessionSwitchSource;
  reason: BridgeSessionSwitchReason;
}): string {
  switch (params.reason) {
    case "local_follow":
    case "local_session_fallback":
    case "local_turn":
      return params.adapter === "codex"
        ? "已跟随桌面端切换任务。"
        : "已跟随桌面端切换会话。";
    case "wechat_resume":
      return params.adapter === "codex" ? "已切换任务。" : "已切换会话。";
    case "startup_restore":
      return params.adapter === "codex" ? "已恢复上次任务。" : "已恢复上次会话。";
    default:
      return params.adapter === "codex" ? "任务已切换。" : "会话已切换。";
  }
}

export function formatThreadSwitchMessage(params: {
  threadId: string;
  source: BridgeThreadSwitchSource;
  reason: BridgeThreadSwitchReason;
}): string {
  return formatSessionSwitchMessage({
    adapter: "codex",
    sessionId: params.threadId,
    source: params.source,
    reason: params.reason,
  });
}

export type ResumeSessionCandidateMatch = {
  candidate: BridgeResumeSessionCandidate;
  index: number;
  score: number;
};

function normalizeTaskSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function scoreTaskSearchText(value: string, target: string): number | null {
  const haystack = normalizeTaskSearchText(value);
  const needle = normalizeTaskSearchText(target);
  if (!haystack || !needle) {
    return null;
  }
  if (haystack === needle) {
    return 1_000;
  }
  if (haystack.startsWith(needle)) {
    return 850 - Math.min(200, haystack.length - needle.length);
  }
  const substringIndex = haystack.indexOf(needle);
  if (substringIndex >= 0) {
    return 700 - Math.min(200, substringIndex * 2 + haystack.length - needle.length);
  }

  let cursor = 0;
  let firstMatch = -1;
  let lastMatch = -1;
  for (const character of needle) {
    const nextIndex = haystack.indexOf(character, cursor);
    if (nextIndex < 0) {
      return null;
    }
    if (firstMatch < 0) {
      firstMatch = nextIndex;
    }
    lastMatch = nextIndex;
    cursor = nextIndex + character.length;
  }
  const span = lastMatch - firstMatch + 1;
  const gapCount = Math.max(0, span - needle.length);
  return 500 - Math.min(300, firstMatch * 2 + gapCount * 4);
}

export function searchResumeSessionCandidates(
  candidates: BridgeResumeSessionCandidate[],
  target: string,
): ResumeSessionCandidateMatch[] {
  const normalizedTarget = target.trim();
  if (!normalizedTarget || /^\d+$/.test(normalizedTarget)) {
    return [];
  }

  return candidates.flatMap((candidate, index) => {
    const titleScore = scoreTaskSearchText(candidate.title, normalizedTarget);
    const projectScore = candidate.projectName
      ? scoreTaskSearchText(candidate.projectName, normalizedTarget)
      : null;
    const combinedScore = scoreTaskSearchText(
      `${candidate.projectName ?? ""} ${candidate.title}`,
      normalizedTarget,
    );
    const score = Math.max(
      titleScore ?? Number.NEGATIVE_INFINITY,
      projectScore === null ? Number.NEGATIVE_INFINITY : projectScore - 120,
      combinedScore === null ? Number.NEGATIVE_INFINITY : combinedScore - 80,
    );
    return Number.isFinite(score)
      ? [{ candidate, index, score }]
      : [];
  }).sort((left, right) => right.score - left.score || left.index - right.index);
}

export function resolveResumeSessionCandidate(
  candidates: BridgeResumeSessionCandidate[],
  target: string,
): BridgeResumeSessionCandidate | null {
  const normalized = target.trim();
  if (!normalized) {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    const index = Number(normalized) - 1;
    return Number.isSafeInteger(index) && index >= 0 && index < candidates.length
      ? candidates[index] ?? null
      : null;
  }

  const exact = candidates.find(
    (candidate) =>
      candidate.sessionId === normalized || candidate.threadId === normalized,
  );
  if (exact) {
    return exact;
  }

  const prefixMatches = candidates.filter(
    (candidate) =>
      candidate.sessionId.startsWith(normalized) || candidate.threadId?.startsWith(normalized),
  );
  if (prefixMatches.length === 1) {
    return prefixMatches[0] ?? null;
  }

  const normalizedTitle = normalizeTaskSearchText(normalized);
  const exactTitleMatches = candidates.filter(
    (candidate) => normalizeTaskSearchText(candidate.title) === normalizedTitle,
  );
  if (exactTitleMatches.length === 1) {
    return exactTitleMatches[0] ?? null;
  }

  const fuzzyMatches = searchResumeSessionCandidates(candidates, normalized);
  return fuzzyMatches.length === 1 ? fuzzyMatches[0]?.candidate ?? null : null;
}

export function resolveCompactCodexTaskSearchTarget(
  text: string,
  candidates: BridgeResumeSessionCandidate[],
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
  if (!target) {
    return null;
  }
  return resolveResumeSessionCandidate(candidates, target) ||
    searchResumeSessionCandidates(candidates, target).length > 0
    ? target
    : null;
}

function formatResumeSessionRuntimeMarkers(
  candidate: BridgeResumeSessionCandidate,
  isCurrent: boolean,
  currentWorkerStatus?: BridgeAdapterState["status"],
): string {
  const markers: string[] = [];
  if (isCurrent) markers.push("当前");

  const currentWorkerMarker = isCurrent
    ? currentWorkerStatus === "busy"
      ? "处理中 🟢"
      : currentWorkerStatus === "awaiting_approval"
        ? "待审批"
        : currentWorkerStatus === "awaiting_input"
          ? "待输入"
          : currentWorkerStatus === "starting"
            ? "启动中"
            : currentWorkerStatus === "error"
              ? "异常"
              : currentWorkerStatus === "stopped"
                ? "已停止"
                : null
    : null;
  if (currentWorkerMarker) {
    markers.push(currentWorkerMarker);
    return ` · ${markers.join(" · ")}`;
  }

  const status = candidate.runtimeStatus;
  if (status?.type === "active") {
    if (status.activeFlags.includes("waitingOnApproval")) {
      markers.push("待审批");
    } else if (status.activeFlags.includes("waitingOnUserInput")) {
      markers.push("待输入");
    } else {
      markers.push("处理中 🟢");
    }
  } else if (status?.type === "systemError") {
    markers.push("异常");
  }

  return markers.length > 0 ? ` · ${markers.join(" · ")}` : "";
}

function formatResumeSessionInstructions(params: {
  hasMore: boolean;
  hasPrevious: boolean;
}): string[] {
  const navigation = [
    "搜索“任务：关键词”",
    "发送“新建：内容”新建任务",
  ];
  if (params.hasMore) navigation.push("“下一页20”查看更多");
  if (params.hasPrevious) navigation.push("“上一页”返回");
  return [
    "回复序号进入；发送“3：内容”可直接下发",
    navigation.join("；"),
    "序号保持到下次发送“任务”",
  ];
}

export function formatResumeSessionList(params: {
  adapter: BridgeAdapterKind;
  candidates: BridgeResumeSessionCandidate[];
  currentSessionId?: string;
  currentWorkerStatus?: BridgeAdapterState["status"];
  page?: number;
  startIndex?: number;
  hasPrevious?: boolean;
  hasMore?: boolean;
}): string {
  const {
    adapter,
    candidates,
    currentSessionId,
    currentWorkerStatus,
    page = 1,
    startIndex,
    hasPrevious,
    hasMore = false,
  } = params;
  const resolvedStartIndex = startIndex ?? (page - 1) * CODEX_TASK_LIST_PAGE_SIZE;
  const resolvedHasPrevious = hasPrevious ?? resolvedStartIndex > 0;
  const providerLabel = getBridgeProvider(adapter).label;
  if (candidates.length === 0) {
    return resolvedHasPrevious
      ? "已经到底了。\n发送“上一页”返回。"
      : `${providerLabel} 当前没有可继续的任务。\n可发送“新建：内容”开始新任务。`;
  }

  return [
    `${providerLabel} 最近任务`,
    ...candidates.map((candidate, index) => {
      const isCurrent = Boolean(
        currentSessionId && candidate.sessionId === currentSessionId,
      );
      const markers = formatResumeSessionRuntimeMarkers(
        candidate,
        isCurrent,
        currentWorkerStatus,
      );
      return `${resolvedStartIndex + index + 1}. ${formatTaskProjectLabel(candidate)}${formatTaskListDisplayTitle(candidate.title)}${markers}`;
    }),
    ...formatResumeSessionInstructions({
      hasMore,
      hasPrevious: resolvedHasPrevious,
    }),
  ].join("\n");
}

export function formatResumeSessionSearchResults(params: {
  target: string;
  matches: ResumeSessionCandidateMatch[];
  currentSessionId?: string;
  currentWorkerStatus?: BridgeAdapterState["status"];
  limit?: number;
}): string {
  const limit = Math.max(1, params.limit ?? CODEX_TASK_LIST_PAGE_SIZE);
  const visibleMatches = params.matches.slice(0, limit);
  const remaining = Math.max(0, params.matches.length - visibleMatches.length);
  return [
    `搜索“${formatTaskListDisplayTitle(params.target, 48)}”`,
    ...visibleMatches.map((match) => {
      const isCurrent = Boolean(
        params.currentSessionId && match.candidate.sessionId === params.currentSessionId,
      );
      const markers = formatResumeSessionRuntimeMarkers(
        match.candidate,
        isCurrent,
        params.currentWorkerStatus,
      );
      return `${match.index + 1}. ${formatTaskProjectLabel(match.candidate)}${formatTaskListDisplayTitle(match.candidate.title)}${markers}`;
    }),
    "回复序号进入；补充关键词可缩小范围",
    ...(remaining > 0 ? [`还有 ${remaining} 条，请补充关键词缩小范围。`] : []),
  ].join("\n");
}

export function formatClawBotWechatHelp(
  adapter?: BridgeAdapterKind,
  adapterLabel?: string,
): string {
  const header = adapter
    ? ["ClawBot 指令", `当前终端：${adapterLabel || getBridgeProvider(adapter).label}`, ""]
    : ["ClawBot 指令", ""];
  return [
    ...header,
    "查看任务：发送“任务”",
    "进入任务：回复任务序号",
    "指定任务发送：发送“数字：内容”或“任务数字：内容”（如：任务6：继续处理）",
    "搜索任务：发送“任务 canvas”、“任务canvas”或“任务：canvas”",
    "新建任务：发送“新建：内容”",
    "直接发送内容：继续最近一条任务消息",
    "查看进度：发送“状态”",
    "停止任务：发送“停止”",
    ...(!adapter || adapter === "codex" ? ["Codex 完整回答：发送“全文”"] : []),
    "翻页：发送“下一页”、“下一页20”或“上一页”",
    "切换终端：/codex、/workbuddy、/claude、/tclaude、/grok、/codebuddy、/reasonix、/deepseek 或 /opencode",
    "帮助：/h 或 /help",
    "任务运行较久时，可打开消息中的网页版链接查看实时进展。",
  ].join("\n");
}

export function formatCodexWechatHelp(): string {
  return formatClawBotWechatHelp("codex");
}

function collectDesktopAttachmentAliases(text: string): {
  imageAliases: string[];
  fileAliases: string[];
} {
  const imageKeys = new Set<string>();
  const fileKeys = new Set<string>();
  const remember = (rawValue: string) => {
    const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
    if (!value) {
      return;
    }
    const extension = path.extname(value.split(/[?#]/, 1)[0] ?? "").toLowerCase();
    if (INLINE_IMAGE_EXTENSIONS.has(extension)) {
      imageKeys.add(value);
    } else {
      fileKeys.add(value);
    }
  };

  for (const match of text.matchAll(/<image\b[^>]*\bpath="([^"]+)"[^>]*>/gi)) {
    remember(match[1] ?? "");
  }
  for (const match of text.matchAll(/^##\s+[^:\n]+:[ \t]*(.+)$/gm)) {
    remember(match[1] ?? "");
  }

  return {
    imageAliases: Array.from(imageKeys, (_value, index) => `png${index + 1}`),
    fileAliases: Array.from(fileKeys, (_value, index) => `文件${index + 1}`),
  };
}

export function compactMirroredUserInputText(text: string): string {
  const normalized = normalizeOutput(text).trim();
  if (!normalized) {
    return "（空消息）";
  }

  const aliases = collectDesktopAttachmentAliases(normalized);
  const requestMarker = /^##\s+My request for Codex:\s*$/im;
  const requestMatch = requestMarker.exec(normalized);
  let visibleText = requestMatch
    ? normalized.slice((requestMatch.index ?? 0) + requestMatch[0].length)
    : normalized;

  visibleText = visibleText
    .replace(/^#\s+Files mentioned by the user:\s*$/gim, "")
    .replace(/^##\s+[^:\n]+:\s*(?:\/|[A-Za-z]:\\).+$/gm, "")
    .replace(/^##\s+My request for Codex:\s*$/gim, "")
    .replace(/<image\b[^>]*>/gi, "")
    .replace(/\[local image:\s*[^\]]+\]/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const lines = [
    aliases.imageAliases.length > 0
      ? `图片：${aliases.imageAliases.join(" ")}`
      : "",
    aliases.fileAliases.length > 0
      ? `附件：${aliases.fileAliases.join(" ")}`
      : "",
    visibleText || (aliases.imageAliases.length > 0 || aliases.fileAliases.length > 0
      ? ""
      : "（空消息）"),
  ].filter(Boolean);
  return lines.join("\n");
}

export function formatCodexDesktopTaskLatestMessage(
  message: BridgeSessionMessage | null,
  assistantLabel = "Codex",
): string {
  if (!message) {
    return `最近一条消息：暂无可显示的用户或 ${assistantLabel} 消息。`;
  }

  const roleLabel = message.role === "assistant" ? assistantLabel : "你";
  const header = `最近一条消息（${roleLabel}）：\n`;
  const normalized = message.role === "user"
    ? compactMirroredUserInputText(message.text)
    : normalizeOutput(message.text).trim();
  if (!normalized) {
    return `${header}（空消息）`;
  }

  const truncationNotice = "…";
  const availableLength = Math.max(
    0,
    WECHAT_TEXT_CHUNK_MAX_CHARS - header.length - truncationNotice.length,
  );
  if (normalized.length > availableLength) {
    return `${header}${normalized.slice(0, availableLength)}${truncationNotice}`;
  }

  return `${header}${normalized}`;
}

function formatCompactRunDuration(durationMs: number): string {
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

function formatCompactTaskTimestamp(timestampMs: number | undefined): string {
  if (timestampMs === undefined || !Number.isFinite(timestampMs)) {
    return "";
  }
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatCodexTaskRunSummary(
  candidate: BridgeResumeSessionCandidate,
  summary?: BridgeSessionRunSummary | null,
): string | null {
  const running = candidate.runtimeStatus?.type === "active" || summary?.status === "running";
  if (running) {
    return summary?.durationMs !== undefined
      ? `状态：进行中，已运行${formatCompactRunDuration(summary.durationMs)}`
      : "状态：进行中";
  }
  if (!summary) {
    return null;
  }
  const duration = summary.durationMs !== undefined
    ? `，用时${formatCompactRunDuration(summary.durationMs)}`
    : "";
  const fallbackCompletedAtMs = Date.parse(candidate.lastUpdatedAt);
  const completedAt = formatCompactTaskTimestamp(
    summary.completedAtMs ?? (
      Number.isFinite(fallbackCompletedAtMs) ? fallbackCompletedAtMs : undefined
    ),
  );
  const completedAtPrefix = completedAt ? `${completedAt} ` : "";
  if (summary.status === "completed") {
    return `状态：${completedAtPrefix}已完成${duration}`;
  }
  if (summary.status === "interrupted") {
    return `状态：${completedAtPrefix}已中断${duration}`;
  }
  if (summary.status === "failed") {
    return `状态：${completedAtPrefix}失败${duration}`;
  }
  return null;
}

export function formatCodexDesktopTaskSelection(
  candidate: BridgeResumeSessionCandidate,
  runSummary?: BridgeSessionRunSummary | null,
): string {
  const lines = ["已进入任务。"];
  const statusLine = formatCodexTaskRunSummary(candidate, runSummary);
  if (statusLine) {
    lines.push(statusLine);
  }
  lines.push(
    "",
    "接下来直接回复，会发送给当前任务。",
    "如需发给任务列表中的其他任务，发送“任务4：继续处理”。",
    "发送“任务”可切换其他任务。",
  );
  return lines.join("\n");
}

export function formatResumeThreadList(
  candidates: BridgeResumeThreadCandidate[],
  currentThreadId?: string,
): string {
  return formatResumeSessionList({
    adapter: "codex",
    candidates: candidates.map((candidate) => ({
      ...candidate,
      sessionId: candidate.sessionId ?? candidate.threadId ?? "",
      threadId: candidate.threadId ?? candidate.sessionId,
    })),
    currentSessionId: currentThreadId,
  });
}

export function formatMirroredUserInputMessage(
  _adapter: BridgeAdapterKind,
  text: string,
): string {
  return `桌面端输入：\n${truncateMobileText(compactMirroredUserInputText(text), 500)}`;
}

export function formatFinalReplyMessage(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  if (isClaudeProviderKind(adapter) || adapter === "codex" || adapter === "opencode") {
    return text;
  }
  return `执行结果：\n${text}`;
}

const OPENCODE_WORKING_NOTICE_RE = /^OpenCode is still working on:\s*$/i;
const OPENCODE_TRANSIENT_NOTICE_RES = [
  /^Bridge error: opencode companion is not connected\./i,
  /^OpenCode companion is not connected(?: for bridge workspace)?:?$/i,
  /^Run "(?:werelay|wechat)-(?:bridge-opencode|opencode(?:-start)?)".*$/i,
  /^OpenCode session switched to \S+ from the local terminal\.$/i,
  /^Local OpenCode input:\s*$/i,
];
const OPENCODE_REASONING_LINE_RES = [
  /\bCLAUDE\.md\b/i,
  /\bNo tool needed\.?$/i,
  /\bThe user said\b/i,
  /\bI need to (?:respond|reply|answer|tell the user)\b/i,
  /\bWe need to (?:respond|reply|answer)\b/i,
  /\bI should\b/i,
  /\bI(?:'ll| will) (?:respond|reply|answer|tell the user|provide)\b/i,
  /\bI'll provide\b/i,
  /^Let me (?:directly )?(?:answer|respond)\b/i,
  /根据系统提示/i,
  /系统提示中说/i,
  /我需要(?:告诉用户|回答|回复)/,
  /我们需要(?:回答|回复)/,
  /^让我直接(?:回答|回复)/,
  /^我要直接(?:回答|回复)/,
  /^用户(?:说|问)了/,
];

const OPENCODE_INLINE_REASONING_MARKER_RE =
  /\b(?:The user\b|I need to\b|I should\b|I(?:'ll| will)\b|We need to\b|Let me\b)/i;
const OPENCODE_INLINE_REASONING_SENTENCE_RE =
  /^(?:The user\b|I need to\b|I should\b|I(?:'ll| will)\b|We need to\b|Let me\b)[^.!?\n]*(?:[.!?]+)\s*/i;

function stripInlineOpenCodeReasoningPrefix(text: string): string {
  let current = text.trim();
  const markerIndex = current.search(OPENCODE_INLINE_REASONING_MARKER_RE);
  if (markerIndex > 0 && markerIndex <= 80) {
    current = current.slice(markerIndex).trimStart();
  }

  for (let index = 0; index < 6; index += 1) {
    const match = current.match(OPENCODE_INLINE_REASONING_SENTENCE_RE);
    if (!match) {
      break;
    }
    current = current.slice(match[0].length).trimStart();
  }

  return current;
}

function isOpenCodeReasoningResidue(text: string): boolean {
  return !text.replace(/[\s"'“”‘’`.,!?;:()[\]{}<>…。！？；：（）【】《》、，-]/g, "");
}

export function sanitizeWechatFinalReplyText(
  adapter: BridgeAdapterKind,
  text: string,
): string {
  const normalized =
    adapter === "opencode"
      ? cleanupVisibleWechatReplyText(stripInlineOpenCodeReasoningPrefix(text))
      : cleanupVisibleWechatReplyText(text);
  if (!normalized || adapter !== "opencode") {
    return normalized;
  }

  const keptLines: string[] = [];
  let dropNextContextLine = false;
  let sawDroppedMeta = false;
  let tailStartIndex = 0;

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      keptLines.push("");
      continue;
    }

    if (dropNextContextLine) {
      dropNextContextLine = false;
      if (line.length <= 200) {
        sawDroppedMeta = true;
        tailStartIndex = keptLines.length;
        continue;
      }
    }

    if (OPENCODE_WORKING_NOTICE_RE.test(line)) {
      sawDroppedMeta = true;
      tailStartIndex = keptLines.length;
      dropNextContextLine = true;
      continue;
    }

    if (
      OPENCODE_TRANSIENT_NOTICE_RES.some((pattern) => pattern.test(line)) ||
      OPENCODE_REASONING_LINE_RES.some((pattern) => pattern.test(line))
    ) {
      sawDroppedMeta = true;
      tailStartIndex = keptLines.length;
      continue;
    }

    const previousLine = keptLines.length > 0 ? keptLines[keptLines.length - 1] : undefined;
    if (
      previousLine &&
      previousLine.trim() &&
      previousLine.trim().replace(/\s+/g, " ") === line.replace(/\s+/g, " ")
    ) {
      continue;
    }

    keptLines.push(line);
  }

  const cleaned = cleanupVisibleWechatReplyText(keptLines.join("\n"));
  if (!sawDroppedMeta) {
    return cleaned;
  }

  const tail = cleanupVisibleWechatReplyText(keptLines.slice(tailStartIndex).join("\n"));
  const resolved = tail || cleaned;
  return isOpenCodeReasoningResidue(resolved) ? "" : resolved;
}

function extractInlineWechatAttachments(text: string): ParsedWechatFinalReply {
  const sanitized = text
    .replace(/\\\n\s*/g, "\\")
    .replace(/\.\s*\n?\s*([A-Za-z0-9]{2,8})(?=\?)/g, ".$1")
    .replace(/\?\s+/g, "?");
  const attachments: WechatReplyAttachment[] = [];
  const seenPaths = new Set<string>();
  let visibleText = sanitized;
  const rememberAttachment = (candidatePath: string): boolean => {
    const attachmentPath = resolveWechatAttachmentPath(candidatePath);
    if (!attachmentPath) {
      return false;
    }

    const kind = inferInlineWechatAttachmentKind(attachmentPath);
    if (!kind) {
      return false;
    }

    if (!seenPaths.has(attachmentPath)) {
      attachments.push({
        kind,
        path: attachmentPath,
      });
      seenPaths.add(attachmentPath);
    }
    return true;
  };

  visibleText = visibleText.replace(INLINE_MAAS_URL_RE, (fullMatch, candidatePath) => {
    return rememberAttachment(candidatePath) ? "" : fullMatch;
  });

  visibleText = visibleText.replace(
    INLINE_WINDOWS_PATH_RE,
    (fullMatch, prefix, candidatePath) => {
      return rememberAttachment(candidatePath) ? prefix : fullMatch;
    },
  );

  visibleText = visibleText.replace(
    INLINE_HOME_RELATIVE_PATH_RE,
    (fullMatch, prefix, candidatePath) => {
      return rememberAttachment(candidatePath) ? prefix : fullMatch;
    },
  );

  return {
    visibleText: cleanupVisibleWechatReplyText(visibleText),
    attachments,
  };
}

// Platform-independent absolute-path check for WeChat attachment candidates.
// Recognizes Windows drive paths (C:\, C:/) and POSIX root paths (/, \), so an
// agent-emitted path resolves on any host OS. Node's path.isAbsolute is
// platform-specific: it rejects "C:\Users\example\..." on Linux/macOS, which dropped
// the attachment and failed CI on non-Windows runners.
function isWechatAttachmentAbsolutePath(candidate: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(candidate);
}

function resolveWechatAttachmentPath(candidatePath: string): string | null {
  const normalizedCandidate = normalizeWechatAttachmentCandidate(candidatePath);
  if (!normalizedCandidate) {
    return null;
  }

  if (isWechatAttachmentAbsolutePath(normalizedCandidate)) {
    return normalizedCandidate;
  }

  const homeRelativeMatch =
    /^(?:~[\\/])?(Desktop|Documents|Downloads|Pictures|Videos|Music)([\\/].+)?$/i.exec(
      normalizedCandidate,
    );
  if (!homeRelativeMatch) {
    return null;
  }

  const relativeTail = `${homeRelativeMatch[1]}${homeRelativeMatch[2] ?? ""}`;
  const relativeSegments = relativeTail.split(/[\\/]+/).filter(Boolean);
  if (!relativeSegments.length) {
    return null;
  }

  return path.normalize(path.join(os.homedir(), ...relativeSegments));
}

// Trim and clean a WeChat attachment candidate path. Intentionally does NOT
// rewrite separators to path.sep: the path must keep its original separator
// style (Windows "\" or POSIX "/") so the bridge can resolve agent-emitted
// paths regardless of host OS (see isWechatAttachmentAbsolutePath).
function normalizeWechatAttachmentCandidate(candidatePath: string): string {
  return candidatePath
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/\.\s+([A-Za-z0-9]{2,8})(?=$|[?/\s])/g, ".$1");
}

function inferInlineWechatAttachmentKind(filePath: string): WechatAttachmentKind | null {
  const extension = path.extname(filePath).toLowerCase();
  if (INLINE_IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (INLINE_VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  if (INLINE_VOICE_EXTENSIONS.has(extension)) {
    return "voice";
  }

  // Keep ordinary local files auto-sendable, but avoid turning common
  // source/script references in prose into unintended WeChat uploads.
  if (!extension || INLINE_REFERENCE_ONLY_FILE_EXTENSIONS.has(extension)) {
    return null;
  }

  return "file";
}

function cleanupVisibleWechatReplyText(text: string): string {
  return text
    .replace(/```[^\n]*\n\s*```/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function formatTaskFailedMessage(
  _adapter: BridgeAdapterKind,
  text: string,
): string {
  return `任务失败：${compactUserFacingError(text)}`;
}

export function shouldNotifyTaskInterrupted(
  outcome: "completed" | "interrupted" | "failed" | undefined,
  hasActiveTask: boolean,
): boolean {
  return outcome === "interrupted" && hasActiveTask;
}

export function formatTaskInterruptedMessage(adapter: BridgeAdapterKind): string {
  return t("task.interrupted", { adapter: formatAdapterLabel(adapter) });
}

export function formatApprovalMessage(
  pending: PendingApproval,
  adapterState: BridgeAdapterState,
  options: { allowTaskAutoApprove?: boolean } = {},
): string {
  const adapterLabel = formatAdapterLabel(adapterState.kind);
  const rawSummary = isClaudeProviderKind(adapterState.kind) && pending.toolName
    ? t("approval.toolSummary", {
        adapter: adapterLabel,
        tool: pending.toolName,
      })
    : pending.summary.trim();
  const summary = compactApprovalSummary(
    rawSummary,
    `${adapterLabel} 请求执行操作。`,
  );
  const rawTarget = pending.detailPreview?.trim() || pending.commandPreview.trim();
  const target = rawTarget.length <= 80 && !/[\\/].{40,}/.test(rawTarget)
    ? rawTarget
    : "";

  const replyOptions = t(
    pending.allowForSession ? "approval.replyWithSession" : "approval.replyShort",
  );
  const taskAutoApproveOption = options.allowTaskAutoApprove
    ? t("approval.taskAutoApproveOption", {
        number: pending.allowForSession ? 4 : 3,
      })
    : "";

  return [
    t("approval.requestTitle"),
    summary,
    target ? t("approval.action", { target: truncatePreview(target, 180) }) : "",
    [replyOptions, taskAutoApproveOption].filter(Boolean).join("\n"),
  ].filter(Boolean).join("\n");
}

export function formatPendingApprovalReminder(
  pending: PendingApproval,
  _adapterState: BridgeAdapterState,
  options: { allowTaskAutoApprove?: boolean } = {},
): string {
  const rawTarget = pending.detailPreview?.trim() || pending.commandPreview.trim();
  const target = rawTarget.length <= 60 && !/[\\/].{30,}/.test(rawTarget)
    ? rawTarget
    : "待确认操作";
  const reminder = t(
    pending.allowForSession
      ? "approval.pendingWithSession"
      : "approval.pendingShort",
    {
      target: truncatePreview(target, 140),
    },
  );
  if (!options.allowTaskAutoApprove) {
    return reminder;
  }
  return `${reminder}\n${t("approval.taskAutoApproveOption", {
    number: pending.allowForSession ? 4 : 3,
  })}`;
}

function formatUserInputQuestionLabel(
  question: UserInputRequestQuestion,
  index: number,
): string {
  return `${index + 1}. ${question.header}`;
}

function resolveUserInputQuestion(
  pending: PendingUserInputRequest,
  reference: string,
): UserInputRequestQuestion | null {
  const trimmed = reference.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    return pending.questions[index] ?? null;
  }

  const normalized = trimmed.toLowerCase();
  return (
    pending.questions.find((question) => question.id.toLowerCase() === normalized) ?? null
  );
}

function resolveUserInputOptionLabel(
  question: UserInputRequestQuestion,
  value: string,
): string | null {
  if (!question.options?.length) {
    return null;
  }

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    return question.options[index]?.label ?? null;
  }

  const normalized = trimmed.toLowerCase();
  return question.options.find((option) => option.label.toLowerCase() === normalized)?.label ?? null;
}

function parseSingleUserInputAnswer(
  question: UserInputRequestQuestion,
  rawValue: string,
): { answers: string[] } | { error: string } {
  const trimmed = normalizeOutput(rawValue).trim();
  if (!trimmed) {
    return {
      error: `请回答“${question.header}”。`,
    };
  }

  if (!question.options?.length) {
    return {
      answers: [trimmed],
    };
  }

  const separatorIndex = trimmed.indexOf("|");
  const selection = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex).trim() : trimmed;
  let note = separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1).trim() : "";
  const answers: string[] = [];

  if (selection) {
    const selections = question.multiSelect
      ? selection.split(/\s*[,，、+]\s*/).map((value) => value.trim()).filter(Boolean)
      : [selection];
    for (const value of selections) {
      const selectedLabel = resolveUserInputOptionLabel(question, value);
      if (selectedLabel) {
        if (!answers.includes(selectedLabel)) answers.push(selectedLabel);
      } else if (question.isOther) {
        note = note ? `${value}; ${note}` : value;
      } else {
        return {
          error: `“${question.header}”请回复选项数字或名称。`,
        };
      }
    }
  }

  if (note) {
    answers.push(`user_note: ${note}`);
  }

  if (answers.length === 0) {
    return {
      error: `请回答“${question.header}”。`,
    };
  }

  return {
    answers,
  };
}

export function parsePendingUserInputAnswerCommand(
  raw: string,
  pending: PendingUserInputRequest,
): { answers: Record<string, string[]>; preview: string } | { error: string } {
  const input = normalizeOutput(raw).trim();
  if (!input) {
    return {
      error: "请在 /answer 后填写答案。",
    };
  }

  const answers: Record<string, string[]> = {};

  if (pending.questions.length === 1) {
    const question = pending.questions[0];
    if (!question) {
      return {
        error: "没有待回答的问题。",
      };
    }
    const parsed = parseSingleUserInputAnswer(question, input);
    if ("error" in parsed) {
      return parsed;
    }
    answers[question.id] = parsed.answers;
  } else {
    const segments = input
      .split(/\s*(?:;|\n)\s*/)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length === 0) {
      return {
        error: "请回复 /answer 1=答案; 2=答案。",
      };
    }

    for (const segment of segments) {
      const separatorIndex = segment.indexOf("=");
      if (separatorIndex <= 0) {
        return {
          error: `答案格式应为“序号=答案”：${segment}`,
        };
      }

      const reference = segment.slice(0, separatorIndex).trim();
      const rawValue = segment.slice(separatorIndex + 1).trim();
      const question = resolveUserInputQuestion(pending, reference);
      if (!question) {
        return {
          error: `没有第 ${reference} 个问题。`,
        };
      }
      if (answers[question.id]) {
        return {
          error: `第 ${reference} 个问题重复回答了。`,
        };
      }

      const parsed = parseSingleUserInputAnswer(question, rawValue);
      if ("error" in parsed) {
        return parsed;
      }
      answers[question.id] = parsed.answers;
    }

    const missing = pending.questions.filter((question) => !answers[question.id]);
    if (missing.length > 0) {
      return {
        error: `还有 ${missing.length} 个问题未回答。`,
      };
    }
  }

  return {
    answers,
    preview: truncatePreview(
      pending.questions
        .map((question) => `${question.id}=${(answers[question.id] ?? []).join(", ")}`)
        .join("; "),
      180,
    ),
  };
}

export function formatUserInputRequestMessage(
  pending: PendingUserInputRequest,
  _adapterState: BridgeAdapterState,
): string {
  const lines = [
    "需要补充信息",
  ];

  const hasSecretQuestion = pending.questions.some((question) => question.isSecret);
  if (hasSecretQuestion) {
    lines.push("提示：微信回复不是隐藏输入，请勿发送密码。\n");
  }

  pending.questions.forEach((question, index) => {
    lines.push("");
    lines.push(formatUserInputQuestionLabel(question, index));
    lines.push(
      hasChineseText(question.question)
        ? truncateMobileText(question.question, 120)
        : `${question.options?.length ? "请选择" : "请补充"}：${truncatePreview(question.header, 40)}`,
    );
    if (question.options?.length) {
      lines.push(question.multiSelect ? "选项（可多选）：" : "选项：");
      question.options.forEach((option, optionIndex) => {
        const description = option.description.trim();
        lines.push(
          description && hasChineseText(description)
            ? `  ${optionIndex + 1}. ${option.label}：${truncatePreview(description, 80)}`
            : `  ${optionIndex + 1}. ${option.label}`,
        );
      });
      if (question.multiSelect) {
        lines.push("多选可用逗号分隔，如 1,3。");
      }
    }
    if (question.isOther) {
      lines.push("可补充自定义说明。");
    }
  });

  lines.push("");
  if (pending.questions.length === 1) {
    const question = pending.questions[0];
    if (!question) {
      return lines.join("\n");
    }
    if (question.options?.length) {
      lines.push("回复 /answer 1");
      if (question.isOther) {
        lines.push("补充说明：/answer 1 | 说明");
      }
    } else {
      lines.push("回复 /answer 你的答案");
    }
  } else {
    lines.push("回复 /answer 1=答案; 2=答案");
  }
  lines.push("/stop 可中断任务。");

  return lines.join("\n");
}

export function formatPendingUserInputReminder(
  pending: PendingUserInputRequest,
): string {
  if (pending.questions.length === 1) {
    const question = pending.questions[0];
    if (!question) {
      return "任务等待输入，请回复 /answer。";
    }
    return `任务等待输入：${question.header}\n请回复 /answer。`;
  }

  return `任务等待 ${pending.questions.length} 个答案。\n回复 /answer 1=答案; 2=答案。`;
}

export class OutputBatcher {
  private readonly onFlush: (text: string) => Promise<void> | void;
  private readonly flushIntervalMs: number;
  private readonly maxChars: number;
  private buffer = "";
  private recentText = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain = Promise.resolve();

  constructor(
    onFlush: (text: string) => Promise<void> | void,
    flushIntervalMs = 1_000,
    maxChars = 1_200,
  ) {
    this.onFlush = onFlush;
    this.flushIntervalMs = flushIntervalMs;
    this.maxChars = maxChars;
  }

  push(text: string): void {
    const normalized = normalizeOutput(text);
    if (!normalized) {
      return;
    }

    this.buffer += normalized;
    this.recentText = (this.recentText + normalized).slice(-6_000);

    while (this.buffer.length >= this.maxChars) {
      const nextChunk = this.buffer.slice(0, this.maxChars);
      this.buffer = this.buffer.slice(this.maxChars);
      this.enqueueFlush(nextChunk);
    }

    this.ensureFlushTimer();
  }

  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.buffer) {
      await this.flushChain;
      return;
    }

    const chunk = this.buffer;
    this.buffer = "";
    this.enqueueFlush(chunk);
    await this.flushChain;
  }

  clear(): void {
    this.buffer = "";
    this.recentText = "";
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  getRecentSummary(maxLength = 280): string {
    return summarizeOutput(this.recentText, maxLength);
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer || !this.buffer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, this.flushIntervalMs);
  }

  private enqueueFlush(text: string): void {
    const payload = text.trim();
    if (!payload) {
      return;
    }

    this.flushChain = this.flushChain
      .then(() => Promise.resolve(this.onFlush(payload)))
      .catch(() => undefined);
  }
}

// When WERELAY_STRICT_APPROVAL is enabled, no permission request is
// auto-approved: everything is forwarded to WeChat for an explicit
// /confirm or /deny decision.
export function isStrictApprovalModeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.WERELAY_STRICT_APPROVAL?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// Outbound WeChat text size cap shared by the streaming OutputBatcher and the
// final-reply forwarder. Long replies sent as a single sendmessage call can be
// rejected by the server, which previously made long final replies vanish.
export const WECHAT_TEXT_CHUNK_MAX_CHARS = 1_200;

export function splitWechatTextIntoChunks(
  text: string,
  maxChars = WECHAT_TEXT_CHUNK_MAX_CHARS,
): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    // Prefer breaking at a newline reasonably close to the cap so paragraphs
    // stay intact; fall back to a hard split.
    const window = remaining.slice(0, maxChars + 1);
    const newlineIndex = window.lastIndexOf("\n");
    const splitIndex = newlineIndex > maxChars / 2 ? newlineIndex : maxChars;
    const chunk = remaining.slice(0, splitIndex).trim();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}

export function shouldDropStartupBacklogMessage(
  createdAtMs: number | undefined,
  bridgeStartedAtMs: number,
  graceMs = MESSAGE_START_GRACE_MS,
): boolean {
  // A missing or unparsable timestamp must not drop the message: treat it as
  // fresh and let normal processing continue.
  if (!Number.isFinite(createdAtMs) || (createdAtMs as number) <= 0) {
    return false;
  }

  return (createdAtMs as number) < bridgeStartedAtMs - graceMs;
}

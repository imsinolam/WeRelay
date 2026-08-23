import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterState,
  BridgeEvent,
  BridgeResumeSessionCandidate,
  BridgeResumeSessionRuntimeStatus,
  BridgeSessionMessage,
  BridgeSessionRunSummary,
  BridgeSessionSendResult,
  BridgeTurnInputItem,
} from "./bridge-types.ts";
import type { AdapterOptions, EventSink } from "./bridge-adapters.shared.ts";
import { describeUnknownError, isRecord } from "./bridge-adapter-common.ts";
import { selectAcpPermissionOption } from "./bridge-adapters.acp.ts";
import { nowIso, truncatePreview } from "./bridge-utils.ts";
import {
  WorkBuddyDesktopRpcClient,
  isWorkBuddyMainProcessRunning,
  resolveWorkBuddyDesktopSocketPath,
  type WorkBuddyDesktopRpcClientOptions,
  type WorkBuddyDesktopRpcClientLike,
} from "./workbuddy-desktop-rpc.ts";

type WorkBuddyRpcId = string | number;

type WorkBuddySessionRow = {
  id: string;
  cwd: string;
  title?: string | null;
  customTitle?: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastActivityAt?: number | null;
  projectId?: string | null;
};

type WorkBuddySqliteStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
};

type WorkBuddySqliteDatabase = {
  prepare(sql: string): WorkBuddySqliteStatement;
  close(): void;
};

type WorkBuddySqliteModule = {
  DatabaseSync: new (pathname: string, options: { readOnly: boolean }) => WorkBuddySqliteDatabase;
};

type WorkBuddyPermissionOption = {
  optionId: string;
  name?: string;
  kind?: string;
};

type PendingWorkBuddyPermission = {
  sessionId: string;
  requestId: string;
  toolCallId?: string;
  options: WorkBuddyPermissionOption[];
  request: ApprovalRequest;
};

type WorkBuddyAcpCallbacks = {
  onNotification(method: string, params: unknown): void;
  onRequest(id: WorkBuddyRpcId, method: string, params: unknown): void;
};

export type WorkBuddyAcpClientLike = {
  connect(): Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
  respond(id: WorkBuddyRpcId, result: unknown): Promise<void>;
  close(): Promise<void>;
};

export type WorkBuddyAdapterDependencies = {
  createDesktopClient(options: WorkBuddyDesktopRpcClientOptions): WorkBuddyDesktopRpcClientLike;
  listSessions(cwd: string | undefined, limit: number): Promise<WorkBuddySessionRow[]>;
  readSession(sessionId: string): Promise<WorkBuddySessionRow | null>;
  readMessages(cwd: string, sessionId: string): Promise<BridgeSessionMessage[]>;
  readRunSummary(cwd: string, sessionId: string): Promise<BridgeSessionRunSummary | null>;
  readLocalImage(pathname: string): Promise<{ data: string; mimeType: string }>;
};

type WorkBuddyAcpCredentials = {
  connectionId: string;
  sessionToken?: string;
};

type PendingWorkBuddyRequest = {
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
};

export type WorkBuddySidecarSession = {
  sessionId: string;
  acpEndpoint: string;
};

const WORKBUDDY_HOST_SESSION_PREFIX = "__workbuddy_cli_host__";
const WORKBUDDY_ACP_REQUEST_TIMEOUT_MS = 30_000;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeComparablePath(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, "");
}

function hashToken(value: string, length: number): string {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, length);
}

export function resolveWorkBuddySidecarSocketPath(options: {
  configDir?: string;
  tmpDir?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  xdgRuntimeDir?: string;
} = {}): string {
  const configDir = options.configDir ??
    process.env.WORKBUDDY_CONFIG_DIR?.trim() ??
    process.env.CODEBUDDY_CONFIG_DIR?.trim() ??
    path.join(os.homedir(), ".workbuddy");
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const instance = hashToken(configDir, 12);
  if (platform === "win32") {
    return `\\\\.\\pipe\\workbuddy-${instance}-sidecar-control`;
  }
  if (platform === "linux") {
    const xdg = options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR?.trim();
    if (xdg) {
      return pathApi.join(xdg, "workbuddy", instance, "sidecar.sock");
    }
    if (uid !== undefined && fs.existsSync(`/run/user/${uid}`)) {
      return pathApi.join(`/run/user/${uid}`, "workbuddy", instance, "sidecar.sock");
    }
  }
  const base = uid === undefined ? "wb" : `wb-${hashToken(String(uid), 6)}`;
  return pathApi.join(options.tmpDir ?? os.tmpdir().trim(), base, instance, "sidecar.sock");
}

function isLoopbackAcpEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") &&
      url.pathname === "/api/v1/acp";
  } catch {
    return false;
  }
}

async function callWorkBuddySidecar(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error("连接 WorkBuddy sidecar 超时。"));
    }, 5_000);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id !== id) continue;
          if (isRecord(message.error)) {
            finish(new Error(readString(message.error.message) ?? "WorkBuddy sidecar 请求失败。"));
          } else {
            finish(undefined, message.result);
          }
        } catch {
          // Ignore malformed or unrelated frames.
        }
      }
    });
    socket.once("error", (error) => finish(error));
  });
}

export async function listWorkBuddySidecarSessions(): Promise<WorkBuddySidecarSession[]> {
  const value = await callWorkBuddySidecar(
    resolveWorkBuddySidecarSocketPath(),
    "session.list",
  );
  if (!Array.isArray(value)) {
    throw new Error("WorkBuddy sidecar 未返回活动会话。");
  }
  return value.flatMap((entry): WorkBuddySidecarSession[] => {
    if (!isRecord(entry)) return [];
    const sessionId = readString(entry.sessionId);
    const acpEndpoint = readString(entry.acpEndpoint);
    return sessionId && acpEndpoint && isLoopbackAcpEndpoint(acpEndpoint)
      ? [{ sessionId, acpEndpoint }]
      : [];
  });
}

export async function resolveWorkBuddyDesktopAcpEndpoint(
  sessionId?: string,
): Promise<string> {
  const override = process.env.WORKBUDDY_ACP_ENDPOINT?.trim();
  if (override) {
    if (!isLoopbackAcpEndpoint(override)) {
      throw new Error("WORKBUDDY_ACP_ENDPOINT 必须指向本机 /api/v1/acp。");
    }
    return override;
  }
  const sessions = await listWorkBuddySidecarSessions();
  const target = sessionId
    ? sessions.find((entry) => entry.sessionId === sessionId)
    : sessions.find((entry) => entry.sessionId.startsWith(WORKBUDDY_HOST_SESSION_PREFIX));
  if (target) return target.acpEndpoint;
  throw new Error(sessionId
    ? "指定的 WorkBuddy 桌面任务尚未就绪。"
    : "WorkBuddy Desktop 的 ACP 服务尚未就绪，请先打开 WorkBuddy。");
}

export function buildWorkBuddyDesktopTaskUrl(sessionId: string): string {
  const normalized = sessionId.trim();
  if (!normalized) throw new Error("WorkBuddy 任务编号无效。");
  return `workbuddy://chat/${encodeURIComponent(normalized)}`;
}

export async function openWorkBuddyDesktopTask(sessionId: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("WorkBuddy 桌面任务唤起目前仅支持 macOS。");
  }
  const url = buildWorkBuddyDesktopTaskUrl(sessionId);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", ["-g", url], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("WorkBuddy 任务唤起失败。"));
    });
  });
}


const WORKBUDDY_WINDOW_BOUNDS_SCRIPT = String.raw`tell application "System Events"
  if not (exists process "WorkBuddy") then error "WorkBuddy 尚未打开"
  tell process "WorkBuddy"
    set frontmost to true
    repeat with candidateWindow in windows
      try
        set candidatePosition to position of candidateWindow
        set candidateSize to size of candidateWindow
        if (item 1 of candidateSize) > 600 and (item 2 of candidateSize) > 400 then
          return ((item 1 of candidatePosition) as text) & "," & ((item 2 of candidatePosition) as text) & "," & ((item 1 of candidateSize) as text) & "," & ((item 2 of candidateSize) as text)
        end if
      end try
    end repeat
  end tell
end tell
error "找不到 WorkBuddy 主窗口"`;

const WORKBUDDY_NATIVE_CLICK_SCRIPT = String.raw`ObjC.import("ApplicationServices");
function run(argv) {
  const x = Number(argv[0]);
  const y = Number(argv[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("点击坐标无效");
  const point = { x, y };
  const down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft);
  const up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, down);
  delay(0.05);
  $.CGEventPost($.kCGHIDEventTap, up);
}`;

export function buildWorkBuddyDesktopPromptScript(): string {
  return String.raw`on run argv
  if (count of argv) is not 3 then error "消息参数无效"
  set messageText to item 1 of argv
  set clipboardSentinel to item 2 of argv
  set clipboardProbe to item 3 of argv
  set previousClipboard to the clipboard as record
  set insertedProbe to false
  set insertedMessage to false
  try
    set the clipboard to clipboardSentinel
    tell application "System Events"
      if not (exists process "WorkBuddy") then error "WorkBuddy 尚未打开"
      tell process "WorkBuddy"
        keystroke "a" using command down
        keystroke "c" using command down
      end tell
    end tell
    delay 0.15
    set composerText to my readWorkBuddyClipboardText(clipboardSentinel)
    if composerText is not clipboardSentinel and composerText is not "" then error "WorkBuddy 目标任务输入框已有未发送内容"

    set the clipboard to clipboardProbe
    tell application "System Events"
      tell process "WorkBuddy"
        keystroke "v" using command down
      end tell
    end tell
    set insertedProbe to true
    delay 0.15
    set the clipboard to clipboardSentinel
    tell application "System Events"
      tell process "WorkBuddy"
        keystroke "a" using command down
        keystroke "c" using command down
      end tell
    end tell
    delay 0.15
    set composerProbeText to my readWorkBuddyClipboardText("")
    if composerProbeText is not clipboardProbe then error "无法定位 WorkBuddy 消息输入框"
    tell application "System Events"
      tell process "WorkBuddy"
        key code 51
      end tell
    end tell
    set insertedProbe to false

    set the clipboard to messageText
    tell application "System Events"
      tell process "WorkBuddy"
        keystroke "v" using command down
      end tell
    end tell
    set insertedMessage to true
    delay 0.15
    set the clipboard to clipboardSentinel
    tell application "System Events"
      tell process "WorkBuddy"
        keystroke "a" using command down
        keystroke "c" using command down
      end tell
    end tell
    delay 0.15
    set pastedMessageText to my readWorkBuddyClipboardText("")
    if pastedMessageText is not messageText then error "无法确认 WorkBuddy 消息已正确填入"
    tell application "System Events"
      tell process "WorkBuddy"
        key code 36
      end tell
    end tell
    set insertedMessage to false
  on error errorMessage number errorNumber
    if insertedProbe or insertedMessage then
      try
        tell application "System Events"
          tell process "WorkBuddy"
            keystroke "z" using command down
          end tell
        end tell
      end try
    end if
    set the clipboard to previousClipboard
    error errorMessage number errorNumber
  end try
  set the clipboard to previousClipboard
end run

on readWorkBuddyClipboardText(fallbackText)
  try
    return the clipboard as text
  on error
    try
      return do shell script "/usr/bin/pbpaste -Prefer html | /usr/bin/textutil -convert txt -stdin -stdout"
    on error
      return fallbackText
    end try
  end try
end readWorkBuddyClipboardText`;
}

const WORKBUDDY_DESKTOP_PROMPT_SCRIPT = buildWorkBuddyDesktopPromptScript();

async function runOsaScript(
  language: "AppleScript" | "JavaScript",
  script: string,
  args: string[] = [],
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/osascript",
      ["-l", language, "-e", script, "--", ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const detail = stderr.trim().replace(/^.*?execution error:\s*/i, "").replace(/\s*\(-?\d+\)\s*$/, "");
      reject(new Error(detail || "WorkBuddy 桌面操作失败。"));
    });
  });
}

export async function sendWorkBuddyDesktopPrompt(text: string): Promise<void> {
  const normalized = text.trim();
  if (!normalized) throw new Error("消息不能为空。");
  if (process.platform !== "darwin") {
    throw new Error("WorkBuddy 桌面消息写入目前仅支持 macOS。");
  }
  const boundsText = await runOsaScript("AppleScript", WORKBUDDY_WINDOW_BOUNDS_SCRIPT);
  const bounds = boundsText.split(",").map((value) => Number(value.trim()));
  if (bounds.length !== 4 || bounds.some((value) => !Number.isFinite(value))) {
    throw new Error("无法读取 WorkBuddy 主窗口位置。");
  }
  const [x, y, width, height] = bounds as [number, number, number, number];
  const clickX = Math.round(x + width * 0.326);
  const clickY = Math.round(y + height - 135);
  await runOsaScript("JavaScript", WORKBUDDY_NATIVE_CLICK_SCRIPT, [
    String(clickX),
    String(clickY),
  ]);
  const sentinel = `werelay-composer-${crypto.randomUUID()}`;
  const probe = `werelay-composer-probe-${crypto.randomUUID()}`;
  await runOsaScript("AppleScript", WORKBUDDY_DESKTOP_PROMPT_SCRIPT, [normalized, sentinel, probe]);
}


function workBuddyConfigDir(): string {
  return process.env.WORKBUDDY_CONFIG_DIR?.trim() ??
    process.env.CODEBUDDY_CONFIG_DIR?.trim() ??
    path.join(os.homedir(), ".workbuddy");
}

function workBuddyDatabasePath(): string {
  return path.join(workBuddyConfigDir(), "workbuddy.db");
}

async function importRuntimeModule(specifier: string): Promise<unknown> {
  return await import(specifier);
}

async function openWorkBuddyDatabase(): Promise<WorkBuddySqliteDatabase> {
  const sqlite = await importRuntimeModule("node:sqlite") as WorkBuddySqliteModule;
  return new sqlite.DatabaseSync(workBuddyDatabasePath(), { readOnly: true });
}

function mapWorkBuddySessionRow(row: Record<string, unknown>): WorkBuddySessionRow | null {
  const id = readString(row.id);
  const cwd = readString(row.cwd);
  const status = readString(row.status);
  const createdAt = typeof row.created_at === "number" ? row.created_at : Number(row.created_at);
  const updatedAt = typeof row.updated_at === "number" ? row.updated_at : Number(row.updated_at);
  if (!id || !cwd || !status || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) {
    return null;
  }
  const lastActivityAt = row.last_activity_at == null ? null : Number(row.last_activity_at);
  return {
    id,
    cwd,
    status,
    createdAt,
    updatedAt,
    lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : null,
    title: readString(row.title) ?? null,
    customTitle: readString(row.custom_title) ?? null,
    projectId: readString(row.project_id) ?? null,
  };
}

export async function listWorkBuddyDesktopSessions(
  cwd: string | undefined,
  limit: number,
): Promise<WorkBuddySessionRow[]> {
  const database = await openWorkBuddyDatabase();
  try {
    const rows = cwd
      ? database.prepare(`
          SELECT id, cwd, title, custom_title, status, created_at, updated_at,
                 last_activity_at, project_id
          FROM sessions
          WHERE deleted_at IS NULL AND cwd = ?
          ORDER BY COALESCE(last_activity_at, updated_at) DESC
          LIMIT ?
        `).all(normalizeComparablePath(cwd), Math.max(1, limit))
      : database.prepare(`
          SELECT id, cwd, title, custom_title, status, created_at, updated_at,
                 last_activity_at, project_id
          FROM sessions
          WHERE deleted_at IS NULL
          ORDER BY COALESCE(last_activity_at, updated_at) DESC
          LIMIT ?
        `).all(Math.max(1, limit));
    return rows.flatMap((row): WorkBuddySessionRow[] => {
      const normalized = mapWorkBuddySessionRow(row as Record<string, unknown>);
      return normalized ? [normalized] : [];
    });
  } finally {
    database.close();
  }
}

export async function readWorkBuddyDesktopSession(
  sessionId: string,
): Promise<WorkBuddySessionRow | null> {
  const database = await openWorkBuddyDatabase();
  try {
    const row = database.prepare(`
      SELECT id, cwd, title, custom_title, status, created_at, updated_at,
             last_activity_at, project_id
      FROM sessions
      WHERE deleted_at IS NULL AND id = ?
      LIMIT 1
    `).get(sessionId);
    return row ? mapWorkBuddySessionRow(row as Record<string, unknown>) : null;
  } finally {
    database.close();
  }
}

function workBuddyProjectDirectoryName(cwd: string): string {
  return normalizeComparablePath(cwd)
    .replace(/^[\\/]+/, "")
    .replace(/[:\\/]+/g, "-");
}

function findWorkBuddyTranscript(cwd: string, sessionId: string): string | null {
  const projectsRoot = path.join(workBuddyConfigDir(), "projects");
  const direct = path.join(
    projectsRoot,
    workBuddyProjectDirectoryName(cwd),
    `${sessionId}.jsonl`,
  );
  if (fs.existsSync(direct)) return direct;
  try {
    for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(projectsRoot, entry.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function workBuddyContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const type = readString(entry.type);
    const text = readString(entry.text);
    if (text && (!type || type.includes("text"))) {
      parts.push(text);
    } else if (type?.includes("image")) {
      parts.push("[图片]");
    }
  }
  return parts.join("\n").trim();
}

function normalizeWorkBuddyUserText(text: string): string {
  const userQueryMatches = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/gi)];
  const userQuery = userQueryMatches.at(-1)?.[1]?.trim();
  if (userQuery) {
    const imageCount = (text.match(/\[图片\]/g) ?? []).length;
    const imageSuffix = imageCount > 0 ? `\n${Array(imageCount).fill("[图片]").join("\n")}` : "";
    return `${userQuery}${imageSuffix}`.trim();
  }
  return text.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, "").trim();
}

export function parseWorkBuddyTranscript(text: string): BridgeSessionMessage[] {
  const messages: BridgeSessionMessage[] = [];
  const indexById = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.type !== "message") continue;
    const role = value.role === "user" || value.role === "assistant" ? value.role : null;
    if (!role) continue;
    const rawMessageText = workBuddyContentText(value.content);
    const messageText = role === "user"
      ? normalizeWorkBuddyUserText(rawMessageText)
      : rawMessageText;
    if (!messageText) continue;
    const providerData = isRecord(value.providerData) ? value.providerData : null;
    const model = role === "assistant" ? readString(providerData?.model) : undefined;
    const message: BridgeSessionMessage = {
      role,
      text: messageText,
      id: readString(value.id),
      ...(role === "assistant" ? { phase: "final_answer" as const } : {}),
      ...(model ? { model } : {}),
    };
    if (message.id && indexById.has(message.id)) {
      messages[indexById.get(message.id)!] = message;
    } else {
      if (message.id) indexById.set(message.id, messages.length);
      messages.push(message);
    }
  }
  return messages;
}

export async function readWorkBuddyDesktopMessages(
  cwd: string,
  sessionId: string,
): Promise<BridgeSessionMessage[]> {
  const transcript = findWorkBuddyTranscript(cwd, sessionId);
  if (!transcript) return [];
  try {
    return parseWorkBuddyTranscript(await fs.promises.readFile(transcript, "utf8"));
  } catch {
    return [];
  }
}

export function parseWorkBuddyTranscriptRunSummary(
  text: string,
): BridgeSessionRunSummary | null {
  let startedAtMs: number | undefined;
  let completedAtMs: number | undefined;
  let assistantStatus = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.type !== "message") continue;
    const timestamp = typeof value.timestamp === "number"
      ? value.timestamp
      : Number(value.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    if (value.role === "user") {
      if (startedAtMs === undefined || timestamp >= startedAtMs) {
        startedAtMs = timestamp;
        completedAtMs = undefined;
        assistantStatus = "";
      }
    } else if (value.role === "assistant" && startedAtMs !== undefined && timestamp >= startedAtMs) {
      completedAtMs = Math.max(completedAtMs ?? 0, timestamp);
      assistantStatus = readString(value.status)?.toLowerCase() ?? assistantStatus;
    }
  }
  if (startedAtMs === undefined) return null;
  const status = assistantStatus === "completed"
    ? "completed"
    : assistantStatus === "failed" || assistantStatus === "error"
      ? "failed"
      : assistantStatus === "cancelled" || assistantStatus === "canceled" || assistantStatus === "incomplete"
        ? "interrupted"
        : completedAtMs === undefined
          ? "running"
          : "unknown";
  return {
    status,
    startedAtMs,
    ...(completedAtMs === undefined ? {} : {
      completedAtMs,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
    }),
  };
}

export async function readWorkBuddyDesktopRunSummary(
  cwd: string,
  sessionId: string,
): Promise<BridgeSessionRunSummary | null> {
  const transcript = findWorkBuddyTranscript(cwd, sessionId);
  if (!transcript) return null;
  try {
    return parseWorkBuddyTranscriptRunSummary(await fs.promises.readFile(transcript, "utf8"));
  } catch {
    return null;
  }
}

function mimeTypeForPath(pathname: string): string {
  switch (path.extname(pathname).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

async function readLocalImage(pathname: string): Promise<{ data: string; mimeType: string }> {
  return {
    data: (await fs.promises.readFile(pathname)).toString("base64"),
    mimeType: mimeTypeForPath(pathname),
  };
}

function parseSseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // Ignore malformed SSE events.
    }
  }
  return messages;
}

class WorkBuddyAcpHttpClient implements WorkBuddyAcpClientLike {
  private readonly endpoint: string;
  private readonly callbacks: WorkBuddyAcpCallbacks;
  private credentials: WorkBuddyAcpCredentials | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, PendingWorkBuddyRequest>();
  private getAbortController: AbortController | null = null;
  private getTask: Promise<void> | null = null;

  constructor(
    endpoint: string,
    callbacks: WorkBuddyAcpCallbacks,
  ) {
    this.endpoint = endpoint;
    this.callbacks = callbacks;
  }

  async connect(): Promise<void> {
    const response = await fetch(`${this.endpoint}/connect`, {
      method: "POST",
      headers: { "x-codebuddy-request": "1" },
    });
    if (!response.ok) {
      throw new Error(`WorkBuddy ACP 连接失败（${response.status}）。`);
    }
    const payload = await response.json() as Record<string, unknown>;
    const connectionId = readString(payload.connectionId);
    if (!connectionId) throw new Error("WorkBuddy ACP 未返回连接 ID。");
    this.credentials = {
      connectionId,
      sessionToken: readString(payload.sessionToken),
    };
    this.getAbortController = new AbortController();
    this.getTask = this.readGetStream(this.getAbortController.signal).catch(() => undefined);
    await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "werelay", version: "1" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.nextId;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    void this.post({ jsonrpc: "2.0", id, method, params }).catch((error) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      pending.reject(error);
    });
    return await response;
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params });
  }

  async respond(id: WorkBuddyRpcId, result: unknown): Promise<void> {
    await this.post({ jsonrpc: "2.0", id, result });
  }

  async close(): Promise<void> {
    this.getAbortController?.abort();
    this.getAbortController = null;
    const credentials = this.credentials;
    this.credentials = null;
    for (const request of this.pending.values()) {
      request.reject(new Error("WorkBuddy ACP 已断开。"));
    }
    this.pending.clear();
    if (credentials) {
      await fetch(this.endpoint, {
        method: "DELETE",
        headers: this.headers(credentials),
      }).catch(() => undefined);
    }
    await this.getTask?.catch(() => undefined);
    this.getTask = null;
  }

  private async post(message: Record<string, unknown>): Promise<void> {
    const credentials = this.requireCredentials();
    const method = readString(message.method);
    const controller = new AbortController();
    const timer = method === "session/prompt" ? null : setTimeout(() => {
      controller.abort();
    }, WORKBUDDY_ACP_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers(credentials),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).trim();
        throw new Error(
          `WorkBuddy ACP 请求失败（${response.status}）${detail ? `：${truncatePreview(detail, 300)}` : ""}`,
        );
      }
      await this.readResponse(response);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async readGetStream(signal: AbortSignal): Promise<void> {
    const response = await fetch(this.endpoint, {
      method: "GET",
      headers: {
        ...this.headers(this.requireCredentials()),
        Accept: "text/event-stream",
      },
      signal,
    });
    if (response.ok) await this.readResponse(response);
  }

  private async readResponse(response: Response): Promise<void> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const text = await response.text();
      if (!text.trim()) return;
      try {
        this.handleMessage(JSON.parse(text));
      } catch {
        // Ignore non-JSON acknowledgements.
      }
      return;
    }
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary < 0) break;
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const message of parseSseMessages(`${block}\n\n`)) {
            this.handleMessage(message);
          }
        }
      }
      for (const message of parseSseMessages(buffer)) {
        this.handleMessage(message);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleMessage(value: unknown): void {
    if (!isRecord(value)) return;
    const method = readString(value.method);
    if (value.id !== undefined && !method) {
      const id = Number(value.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (isRecord(value.error)) {
        pending.reject(new Error(readString(value.error.message) ?? "WorkBuddy ACP 请求失败。"));
      } else {
        pending.resolve(value.result);
      }
      return;
    }
    if (!method) return;
    if (value.id !== undefined) {
      this.callbacks.onRequest(value.id as WorkBuddyRpcId, method, value.params);
    } else {
      this.callbacks.onNotification(method, value.params);
    }
  }

  private headers(credentials: WorkBuddyAcpCredentials): Record<string, string> {
    return {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "x-codebuddy-request": "1",
      "acp-connection-id": credentials.connectionId,
      ...(credentials.sessionToken ? { "acp-session-token": credentials.sessionToken } : {}),
    };
  }

  private requireCredentials(): WorkBuddyAcpCredentials {
    if (!this.credentials) throw new Error("WorkBuddy ACP 尚未连接。");
    return this.credentials;
  }
}


export type WorkBuddyHybridRpcClientDependencies = {
  desktopHookAvailable(): boolean | Promise<boolean>;
  desktopApplicationRunning(): boolean | Promise<boolean>;
  createDesktopClient(options: WorkBuddyDesktopRpcClientOptions): WorkBuddyDesktopRpcClientLike;
  listSidecarSessions(): Promise<WorkBuddySidecarSession[]>;
  openDesktopSession(sessionId: string): Promise<void>;
  sendDesktopPrompt(text: string): Promise<void>;
  readSession(sessionId: string): Promise<WorkBuddySessionRow | null>;
  readRunSummary(cwd: string, sessionId: string): Promise<BridgeSessionRunSummary | null>;
  createAcpClient(
    endpoint: string,
    callbacks: WorkBuddyAcpCallbacks,
  ): WorkBuddyAcpClientLike;
  delay(ms: number): Promise<void>;
  sessionReadyTimeoutMs: number;
  sessionReadyPollIntervalMs: number;
  promptAcceptanceTimeoutMs: number;
  promptCompletionTimeoutMs: number;
};

async function probeWorkBuddyDesktopHook(
  socketPath = resolveWorkBuddyDesktopSocketPath(),
  timeoutMs = 300,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = net.createConnection(socketPath);
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function defaultHybridDependencies(): WorkBuddyHybridRpcClientDependencies {
  return {
    desktopHookAvailable: probeWorkBuddyDesktopHook,
    desktopApplicationRunning: isWorkBuddyMainProcessRunning,
    createDesktopClient: (options) => new WorkBuddyDesktopRpcClient({
      callbacks: options,
      allowDesktopApplicationLaunch: options.allowDesktopApplicationLaunch,
    }),
    listSidecarSessions: listWorkBuddySidecarSessions,
    openDesktopSession: openWorkBuddyDesktopTask,
    sendDesktopPrompt: sendWorkBuddyDesktopPrompt,
    readSession: readWorkBuddyDesktopSession,
    readRunSummary: readWorkBuddyDesktopRunSummary,
    createAcpClient: (endpoint, callbacks) => new WorkBuddyAcpHttpClient(endpoint, callbacks),
    delay: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
    sessionReadyTimeoutMs: 15_000,
    sessionReadyPollIntervalMs: 250,
    promptAcceptanceTimeoutMs: 15_000,
    promptCompletionTimeoutMs: 12 * 60 * 60 * 1_000,
  };
}

export class WorkBuddyHybridRpcClient implements WorkBuddyDesktopRpcClientLike {
  private readonly options: WorkBuddyDesktopRpcClientOptions;
  private readonly dependencies: WorkBuddyHybridRpcClientDependencies;
  private mode: "disconnected" | "desktop" | "sidecar" = "disconnected";
  private desktopClient: WorkBuddyDesktopRpcClientLike | null = null;
  private acpClient: WorkBuddyAcpClientLike | null = null;
  private activeSessionId: string | null = null;
  private activeEndpoint: string | null = null;
  private pendingDesktopSession: { sessionId: string; cwd: string } | null = null;
  private readonly permissionRequestIds = new Map<string, WorkBuddyRpcId>();

  constructor(
    options: WorkBuddyDesktopRpcClientOptions,
    dependencies: Partial<WorkBuddyHybridRpcClientDependencies> = {},
  ) {
    this.options = options;
    this.dependencies = { ...defaultHybridDependencies(), ...dependencies };
  }

  async connect(): Promise<void> {
    if (this.mode !== "disconnected") return;

    if (await this.dependencies.desktopHookAvailable()) {
      const client = this.dependencies.createDesktopClient({
        ...this.options,
        allowDesktopApplicationLaunch: false,
      });
      try {
        await client.connect();
        this.desktopClient = client;
        this.mode = "desktop";
        return;
      } catch {
        await client.close().catch(() => undefined);
      }
    }

    try {
      await this.dependencies.listSidecarSessions();
      this.mode = "sidecar";
      return;
    } catch (sidecarError) {
      if (await this.dependencies.desktopApplicationRunning()) {
        throw new Error(
          "WorkBuddy 已打开，但桌面任务接口暂未就绪；WeRelay 不会自动重启应用。请稍后重试，或在 WorkBuddy 中重新打开目标任务。",
          { cause: sidecarError },
        );
      }
      if (this.options.allowDesktopApplicationLaunch !== true) {
        throw new Error(
          "WorkBuddy 尚未连接。请从网页或 ClawBot 明确选择 WorkBuddy 后重试。",
          { cause: sidecarError },
        );
      }
    }

    const client = this.dependencies.createDesktopClient({
      ...this.options,
      allowDesktopApplicationLaunch: true,
    });
    try {
      await client.connect();
      this.desktopClient = client;
      this.mode = "desktop";
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (this.mode === "desktop") {
      if (!this.desktopClient) throw new Error("WorkBuddy Desktop 尚未连接。");
      return await this.desktopClient.invoke(channel, ...args);
    }
    if (this.mode !== "sidecar") throw new Error("WorkBuddy Desktop 尚未连接。");

    switch (channel) {
      case "session:load":
        return await this.loadSidecarSession(args);
      case "session:sendMessage":
        return await this.sendSidecarMessage(args);
      case "session:cancel":
        await this.notifySidecarSession("session/cancel", args);
        return {};
      case "session:resolvePermission":
        await this.resolveSidecarPermission(args, false);
        return {};
      case "session:rejectPermission":
        await this.resolveSidecarPermission(args, true);
        return {};
      case "session:create":
        throw new Error(
          "当前可以继续 WorkBuddy 桌面已有任务；新建任务请先在 WorkBuddy 桌面端创建。",
        );
      default:
        throw new Error(`WorkBuddy 桌面任务接口暂不支持：${channel}`);
    }
  }

  async close(): Promise<void> {
    this.mode = "disconnected";
    this.permissionRequestIds.clear();
    const desktopClient = this.desktopClient;
    const acpClient = this.acpClient;
    this.desktopClient = null;
    this.acpClient = null;
    this.activeSessionId = null;
    this.activeEndpoint = null;
    this.pendingDesktopSession = null;
    await Promise.all([
      desktopClient?.close().catch(() => undefined),
      acpClient?.close().catch(() => undefined),
    ]);
  }

  private async loadSidecarSession(args: unknown[]): Promise<unknown> {
    const sessionId = readString(args[0]);
    const options = isRecord(args[1]) ? args[1] : {};
    if (!sessionId) throw new Error("WorkBuddy 任务编号无效。");
    const cwd = readString(options.cwd);
    if (!cwd) throw new Error("WorkBuddy 任务目录无效。");

    const existing = (await this.dependencies.listSidecarSessions())
      .find((entry) => entry.sessionId === sessionId);
    if (existing) {
      await this.attachSidecarSession(sessionId, cwd, existing);
      this.pendingDesktopSession = null;
      return {};
    }

    await this.closeActiveAcpClient();
    await this.dependencies.openDesktopSession(sessionId);
    await this.dependencies.delay(800);
    this.pendingDesktopSession = { sessionId, cwd };
    return {};
  }

  private async attachSidecarSession(
    sessionId: string,
    cwd: string,
    session: WorkBuddySidecarSession,
  ): Promise<void> {
    if (
      this.acpClient &&
      this.activeSessionId === sessionId &&
      this.activeEndpoint === session.acpEndpoint
    ) {
      return;
    }

    await this.closeActiveAcpClient();
    const client = this.dependencies.createAcpClient(
      session.acpEndpoint,
      {
        onNotification: (method, params) => this.handleAcpNotification(sessionId, method, params),
        onRequest: (id, method, params) => this.handleAcpRequest(sessionId, id, method, params),
      },
    );
    this.acpClient = client;
    this.activeSessionId = sessionId;
    this.activeEndpoint = session.acpEndpoint;
    try {
      await client.connect();
      await client.request("session/load", {
        sessionId,
        cwd,
        mcpServers: [],
      });
    } catch (error) {
      this.acpClient = null;
      this.activeSessionId = null;
      this.activeEndpoint = null;
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async closeActiveAcpClient(): Promise<void> {
    const previous = this.acpClient;
    this.acpClient = null;
    this.activeSessionId = null;
    this.activeEndpoint = null;
    this.permissionRequestIds.clear();
    await previous?.close().catch(() => undefined);
  }

  private async waitForSidecarSession(sessionId: string): Promise<WorkBuddySidecarSession> {
    const deadline = Date.now() + this.dependencies.sessionReadyTimeoutMs;
    while (Date.now() < deadline) {
      const target = (await this.dependencies.listSidecarSessions().catch(() => []))
        .find((entry) => entry.sessionId === sessionId);
      if (target) return target;
      await this.dependencies.delay(this.dependencies.sessionReadyPollIntervalMs);
    }
    throw new Error("WorkBuddy 已打开目标任务，但未确认收到消息；未切换到其他任务，也没有新建替代任务。");
  }

  private async sendSidecarMessage(args: unknown[]): Promise<unknown> {
    const sessionId = readString(args[0]);
    if (!sessionId) throw new Error("WorkBuddy 任务编号无效。");
    const payload = isRecord(args[1]) ? args[1] : {};
    const prompt = Array.isArray(payload.content) ? payload.content : [];
    if (prompt.length === 0) throw new Error("消息不能为空。");

    if (this.acpClient && this.activeSessionId === sessionId) {
      return await this.acpClient.request("session/prompt", { sessionId, prompt });
    }

    const pending = this.pendingDesktopSession;
    if (!pending || pending.sessionId !== sessionId) {
      throw new Error("WorkBuddy 指定任务尚未连接。");
    }
    const textParts: string[] = [];
    for (const item of prompt) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
        throw new Error("WorkBuddy 目标任务当前未运行；请先在桌面打开该任务后再发送图片或附件。");
      }
      if (item.text.trim()) textParts.push(item.text);
    }
    const text = textParts.join("\n").trim();
    if (!text) throw new Error("消息不能为空。");
    const before = await this.dependencies.readSession(sessionId);
    if (!before) throw new Error("WorkBuddy 桌面端找不到该任务。");
    const baselineActivityAt = before.lastActivityAt ?? before.updatedAt;
    const baselineRunSummary = await this.dependencies.readRunSummary(pending.cwd, sessionId);
    const baselineRunStartedAt = baselineRunSummary?.startedAtMs ?? baselineActivityAt;

    await this.dependencies.openDesktopSession(sessionId);
    await this.dependencies.delay(500);
    await this.dependencies.sendDesktopPrompt(text);
    const sidecarSession = await this.waitForSidecarSession(sessionId);
    await this.attachSidecarSession(sessionId, pending.cwd, sidecarSession);
    await this.waitForDesktopPromptCompletion(
      sessionId,
      pending.cwd,
      baselineActivityAt,
      baselineRunStartedAt,
    );
    this.pendingDesktopSession = null;
    return {};
  }

  private async waitForDesktopPromptCompletion(
    sessionId: string,
    cwd: string,
    baselineActivityAt: number,
    baselineRunStartedAt: number,
  ): Promise<void> {
    const acceptedDeadline = Date.now() + this.dependencies.promptAcceptanceTimeoutMs;
    const completionDeadline = Date.now() + this.dependencies.promptCompletionTimeoutMs;
    let accepted = false;
    let observedActiveTurn = false;
    while (Date.now() < completionDeadline) {
      const [row, runSummary] = await Promise.all([
        this.dependencies.readSession(sessionId),
        this.dependencies.readRunSummary(cwd, sessionId).catch(() => null),
      ]);
      if (!row) throw new Error("WorkBuddy 桌面端找不到该任务。");
      const activityAt = row.lastActivityAt ?? row.updatedAt;
      const runStartedAt = runSummary?.startedAtMs;
      const hasNewTranscriptTurn = typeof runStartedAt === "number" &&
        runStartedAt > baselineRunStartedAt;
      if (activityAt > baselineActivityAt || hasNewTranscriptTurn) accepted = true;

      const rowIsActive = runtimeStatusForWorkBuddyRow(row).type === "active";
      const transcriptIsActive = hasNewTranscriptTurn && runSummary?.status === "running";
      if (rowIsActive || transcriptIsActive) observedActiveTurn = true;

      const transcriptIsTerminal = hasNewTranscriptTurn && (
        runSummary?.status === "completed" ||
        runSummary?.status === "failed" ||
        runSummary?.status === "interrupted"
      );
      if (accepted && (transcriptIsTerminal || (observedActiveTurn && !rowIsActive))) return;
      if (!accepted && Date.now() >= acceptedDeadline) {
        throw new Error("WorkBuddy 已打开目标任务，但未确认收到消息；请检查桌面输入框后重试。");
      }
      await this.dependencies.delay(this.dependencies.sessionReadyPollIntervalMs);
    }
    throw new Error("WorkBuddy 任务运行时间过长，WeRelay 已停止等待完成通知。");
  }

  private async notifySidecarSession(method: string, args: unknown[]): Promise<void> {
    const sessionId = this.requireActiveSession(args[0]);
    await this.requireAcpClient().notify(method, { sessionId });
  }

  private async resolveSidecarPermission(args: unknown[], deny: boolean): Promise<void> {
    const sessionId = this.requireActiveSession(args[0]);
    const requestId = readString(args[1]);
    if (!requestId) throw new Error("WorkBuddy 审批请求已失效。");
    const rpcId = this.permissionRequestIds.get(requestId);
    if (rpcId === undefined) throw new Error("WorkBuddy 审批请求已失效。");
    const optionId = readString(args[2]);
    if (!deny && !optionId) throw new Error("WorkBuddy 审批选项无效。");
    await this.requireAcpClient().respond(rpcId, deny
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId } });
    this.permissionRequestIds.delete(requestId);
    this.options.onEvent(`session:event:${sessionId}`, {
      sessionId,
      type: "permissionResolved",
      requestId,
    });
  }

  private handleAcpNotification(sessionId: string, method: string, params: unknown): void {
    if (method !== "session/update" && method !== "_x.ai/session/update") return;
    const payload = isRecord(params) ? params : {};
    const update = isRecord(payload.update) ? payload.update : null;
    if (!update) return;
    this.options.onEvent(`session:event:${sessionId}`, { sessionId, update });
  }

  private handleAcpRequest(
    sessionId: string,
    id: WorkBuddyRpcId,
    method: string,
    params: unknown,
  ): void {
    if (method !== "session/request_permission" || !isRecord(params)) {
      void this.requireAcpClient().respond(id, { outcome: { outcome: "cancelled" } })
        .catch(() => undefined);
      return;
    }
    const requestId = String(id);
    this.permissionRequestIds.set(requestId, id);
    this.options.onEvent(`session:event:${sessionId}`, {
      sessionId,
      type: "permissionRequest",
      requestId,
      request: params,
    });
  }

  private requireActiveSession(value: unknown): string {
    const sessionId = readString(value);
    if (!sessionId || sessionId !== this.activeSessionId) {
      throw new Error("WorkBuddy 指定任务尚未连接。");
    }
    return sessionId;
  }

  private requireAcpClient(): WorkBuddyAcpClientLike {
    if (!this.acpClient) throw new Error("WorkBuddy 指定任务尚未连接。");
    return this.acpClient;
  }
}

function defaultDependencies(): WorkBuddyAdapterDependencies {
  return {
    createDesktopClient: (options) => new WorkBuddyHybridRpcClient(options),
    listSessions: listWorkBuddyDesktopSessions,
    readSession: readWorkBuddyDesktopSession,
    readMessages: readWorkBuddyDesktopMessages,
    readRunSummary: readWorkBuddyDesktopRunSummary,
    readLocalImage,
  };
}

function runtimeStatusForWorkBuddyRow(
  row: WorkBuddySessionRow,
): BridgeResumeSessionRuntimeStatus {
  const status = row.status.toLowerCase();
  if (status === "error" || status === "failed") return { type: "systemError" };
  if (
    status === "running" ||
    status === "working" ||
    status === "pending" ||
    status === "busy" ||
    status === "processing"
  ) {
    return { type: "active", activeFlags: [] };
  }
  return { type: "idle" };
}

function candidateForWorkBuddyRow(row: WorkBuddySessionRow): BridgeResumeSessionCandidate {
  const updatedAt = row.lastActivityAt ?? row.updatedAt;
  return {
    sessionId: row.id,
    threadId: row.id,
    title: row.customTitle ?? row.title ?? `会话 ${row.id.slice(0, 8)}`,
    lastUpdatedAt: new Date(updatedAt).toISOString(),
    cwd: row.cwd,
    projectId: row.projectId ?? undefined,
    projectName: path.basename(row.cwd),
    runtimeStatus: runtimeStatusForWorkBuddyRow(row),
  };
}

export async function listWorkBuddyDesktopSessionCandidates(
  limit = 10,
): Promise<BridgeResumeSessionCandidate[]> {
  return (await listWorkBuddyDesktopSessions(undefined, limit)).map(candidateForWorkBuddyRow);
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.text === "string") return value.text;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("");
  return "";
}

export class WorkBuddyDesktopAdapter implements BridgeAdapter {
  private readonly options: AdapterOptions;
  private readonly state: BridgeAdapterState;
  private readonly dependencies: WorkBuddyAdapterDependencies;
  private eventSink: EventSink = () => undefined;
  private client: WorkBuddyDesktopRpcClientLike | null = null;
  private loadingSession = false;
  private pendingPermission: PendingWorkBuddyPermission | null = null;
  private currentReply = "";
  private currentRunStartedAtMs: number | null = null;
  private readonly runSummaries = new Map<string, BridgeSessionRunSummary>();
  private activePromptToken = 0;

  constructor(
    options: AdapterOptions,
    dependencies: WorkBuddyAdapterDependencies = defaultDependencies(),
  ) {
    this.options = options;
    this.dependencies = dependencies;
    const initialSessionId = options.sessionStartMode === "new"
      ? undefined
      : options.initialSharedSessionId ?? options.initialSharedThreadId;
    this.state = {
      kind: "workbuddy",
      status: "stopped",
      cwd: options.cwd,
      command: options.command,
      profile: options.profile,
      sharedSessionId: initialSessionId,
      activeRuntimeSessionId: initialSessionId,
    };
  }

  setEventSink(sink: EventSink): void {
    this.eventSink = sink;
  }

  async start(): Promise<void> {
    if (this.client) return;
    this.setStatus("starting", "正在连接 WorkBuddy Desktop。");
    const client = this.dependencies.createDesktopClient({
      allowDesktopApplicationLaunch:
        this.options.allowDesktopApplicationLaunch === true,
      onEvent: (channel, data) => this.handleDesktopEvent(channel, data),
      onDisconnect: (error) => {
        if (this.client !== client) return;
        this.setStatus("error");
        this.emit({
          type: "notice",
          level: "warning",
          text: error?.message || "WorkBuddy Desktop 连接已断开，请重新切换到 WorkBuddy。",
          timestamp: nowIso(),
        });
      },
    });
    this.client = client;
    this.state.startedAt = nowIso();
    try {
      await client.connect();
      let sessionId = this.state.sharedSessionId;
      if (!sessionId) {
        sessionId = (await this.dependencies.listSessions(undefined, 1))[0]?.id;
      }
      if (sessionId) {
        await this.loadSession(sessionId, "restore", "startup_restore");
      } else {
        this.emit({
          type: "notice",
          level: "warning",
          text: "当前项目还没有 WorkBuddy 任务，请先在 WorkBuddy 桌面端创建任务。",
          timestamp: nowIso(),
        });
      }
      this.setStatus("idle");
    } catch (error) {
      await client.close().catch(() => undefined);
      this.client = null;
      this.setStatus("error");
      throw error;
    }
  }

  async sendInput(text: string): Promise<void> {
    await this.sendItems([{ type: "text", text }]);
  }

  async sendInputToSession(
    sessionId: string,
    text: string,
  ): Promise<BridgeSessionSendResult> {
    if (sessionId !== this.state.sharedSessionId) await this.resumeSession(sessionId);
    await this.sendInput(text);
    return {};
  }

  async sendInputItemsToSession(
    sessionId: string,
    items: BridgeTurnInputItem[],
  ): Promise<BridgeSessionSendResult> {
    if (sessionId !== this.state.sharedSessionId) await this.resumeSession(sessionId);
    await this.sendItems(items);
    return {};
  }

  async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    return (await this.dependencies.listSessions(undefined, limit)).map((row) => {
      const candidate = candidateForWorkBuddyRow(row);
      if (row.id === this.state.sharedSessionId && this.state.status === "busy") {
        candidate.runtimeStatus = { type: "active", activeFlags: [] };
      } else if (
        row.id === this.state.sharedSessionId &&
        this.state.status === "awaiting_approval"
      ) {
        candidate.runtimeStatus = {
          type: "active",
          activeFlags: ["waitingOnApproval"],
        };
      }
      return candidate;
    });
  }

  async resumeSession(sessionId: string): Promise<void> {
    if (this.state.status === "busy" || this.state.status === "awaiting_approval") {
      throw new Error("WorkBuddy 正在处理当前任务，请先等待完成或停止。");
    }
    await this.loadSession(sessionId, "wechat", "wechat_resume");
  }

  async getLatestSessionMessage(sessionId: string): Promise<BridgeSessionMessage | null> {
    const messages = await this.getSessionMessages(sessionId);
    return messages.at(-1) ?? null;
  }

  async getSessionMessages(sessionId: string): Promise<BridgeSessionMessage[]> {
    const row = await this.dependencies.readSession(sessionId);
    return await this.dependencies.readMessages(row?.cwd ?? this.options.cwd, sessionId);
  }

  async getSessionRunSummary(sessionId: string): Promise<BridgeSessionRunSummary | null> {
    const current = this.runSummaries.get(sessionId);
    if (current) return { ...current };
    const row = await this.dependencies.readSession(sessionId);
    if (!row) return null;
    const runtimeStatus = runtimeStatusForWorkBuddyRow(row);
    const transcript = await this.dependencies.readRunSummary(row.cwd, sessionId);
    const startedAtMs = transcript?.startedAtMs ?? row.createdAt;
    const completedAtMs = transcript?.completedAtMs ?? row.lastActivityAt ?? row.updatedAt;
    if (runtimeStatus.type === "active") {
      return {
        status: "running",
        startedAtMs,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
    }
    const status = runtimeStatus.type === "systemError"
      ? "failed"
      : transcript?.status === "interrupted" || transcript?.status === "failed"
        ? transcript.status
        : "completed";
    return {
      status,
      startedAtMs,
      completedAtMs,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
    };
  }

  async interrupt(): Promise<boolean> {
    const sessionId = this.state.sharedSessionId;
    if (!sessionId || (this.state.status !== "busy" && this.state.status !== "awaiting_approval")) {
      return false;
    }
    const client = this.requireClient();
    const pending = this.pendingPermission;
    if (pending) {
      await client.invoke(
        "session:rejectPermission",
        pending.sessionId,
        pending.requestId,
        "用户已停止任务",
      ).catch(() => undefined);
      this.pendingPermission = null;
      this.state.pendingApproval = null;
    }
    await client.invoke("session:cancel", sessionId);
    this.activePromptToken += 1;
    const completedAtMs = Date.now();
    this.runSummaries.set(sessionId, {
      status: "interrupted",
      startedAtMs: this.currentRunStartedAtMs ?? completedAtMs,
      completedAtMs,
      durationMs: Math.max(0, completedAtMs - (this.currentRunStartedAtMs ?? completedAtMs)),
    });
    this.currentRunStartedAtMs = null;
    this.setStatus("idle");
    this.emit({
      type: "task_complete",
      outcome: "interrupted",
      timestamp: nowIso(),
      threadId: sessionId,
      origin: "wechat",
    });
    return true;
  }

  async interruptSession(sessionId: string): Promise<boolean> {
    if (sessionId !== this.state.sharedSessionId) return false;
    return await this.interrupt();
  }

  async reset(): Promise<void> {
    await this.createSession();
  }

  async createSession(): Promise<void> {
    const created = await this.requireClient().invoke("session:create", {
      cwd: this.options.cwd,
    });
    const record = isRecord(created) ? created : null;
    const sessionId = readString(record?.sessionId) ?? readString(record?.id);
    if (!sessionId) {
      throw new Error("WorkBuddy 没有返回新任务编号，请稍后重试。");
    }
    const cwd = readString(record?.cwd) ?? this.options.cwd;
    this.loadingSession = true;
    try {
      await this.requireClient().invoke(
        "session:load",
        sessionId,
        { cwd, forceRendererHistoryReplay: false },
      );
      this.state.sharedSessionId = sessionId;
      this.state.activeRuntimeSessionId = sessionId;
      this.state.lastSessionSwitchAt = nowIso();
      this.emit({
        type: "session_switched",
        sessionId,
        source: "wechat",
        reason: "wechat_resume",
        timestamp: nowIso(),
      });
    } finally {
      this.loadingSession = false;
    }
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    return await this.resolvePendingPermission(action);
  }

  async resolveAllApprovals(action: "confirm" | "deny"): Promise<number> {
    return await this.resolvePendingPermission(action) ? 1 : 0;
  }

  async resolveApprovalForSession(): Promise<boolean> {
    return await this.resolvePendingPermission("confirm_session");
  }

  async resolveAllApprovalsForSession(): Promise<number> {
    return await this.resolvePendingPermission("confirm_session") ? 1 : 0;
  }

  async resolveTaskApprovals(
    threadId: string,
    action: "confirm" | "confirm_session" | "deny",
  ): Promise<number> {
    if (this.pendingPermission?.request.threadId !== threadId) return 0;
    return await this.resolvePendingPermission(action) ? 1 : 0;
  }

  getPendingTaskApprovals(threadId: string): ApprovalRequest[] {
    return this.pendingPermission?.request.threadId === threadId
      ? [this.pendingPermission.request]
      : [];
  }

  async submitUserInput(_answers: Record<string, string[]>): Promise<boolean> {
    return false;
  }

  async dispose(): Promise<void> {
    this.activePromptToken += 1;
    this.pendingPermission = null;
    this.state.pendingApproval = null;
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => undefined);
    this.state.status = "stopped";
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  private async sendItems(items: BridgeTurnInputItem[]): Promise<void> {
    const sessionId = this.requireSessionId();
    if (this.state.status === "busy") {
      throw new Error("WorkBuddy 仍在处理，请等待当前回复或发送 /stop。");
    }
    if (this.pendingPermission) throw new Error("WorkBuddy 正在等待审批。");
    const prompt: Record<string, unknown>[] = [];
    let preview = "";
    for (const item of items) {
      if (item.type === "text") {
        if (!item.text.trim()) continue;
        prompt.push({ type: "text", text: item.text });
        preview += `${preview ? "\n" : ""}${item.text}`;
      } else if (item.type === "localImage") {
        const image = await this.dependencies.readLocalImage(item.path);
        prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
      } else {
        prompt.push({ type: "resource_link", uri: item.url, name: "image" });
      }
    }
    if (prompt.length === 0) throw new Error("消息不能为空。");
    this.currentReply = "";
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "wechat";
    this.currentRunStartedAtMs = Date.now();
    this.runSummaries.set(sessionId, {
      status: "running",
      startedAtMs: this.currentRunStartedAtMs,
    });
    this.setStatus("busy");
    const token = ++this.activePromptToken;
    void this.runPrompt(sessionId, prompt, preview, token);
  }

  private async runPrompt(
    sessionId: string,
    prompt: Record<string, unknown>[],
    preview: string,
    token: number,
  ): Promise<void> {
    try {
      const userMessageId = crypto.randomUUID();
      const clientSendTime = Date.now();
      await this.requireClient().invoke(
        "session:sendMessage",
        sessionId,
        {
          content: prompt,
          _meta: {
            "codebuddy.ai": {
              userMessageId,
              messageRequestId: userMessageId,
              promptRequestId: userMessageId,
              requestId: userMessageId,
              conversationId: sessionId,
              clientSendTime,
              emitSyntheticUserPromptLive: true,
              source: "werelay",
            },
          },
        },
      );
      if (token !== this.activePromptToken) return;
      let finalText = this.currentReply.trim();
      if (!finalText) {
        const messages = await this.getSessionMessages(sessionId);
        finalText = [...messages].reverse().find((message) => message.role === "assistant")?.text ?? "";
      }
      if (finalText) {
        this.emit({
          type: "final_reply",
          text: finalText,
          timestamp: nowIso(),
          threadId: sessionId,
          origin: "wechat",
        });
      }
      const completedAtMs = Date.now();
      const startedAtMs = this.currentRunStartedAtMs ?? completedAtMs;
      this.runSummaries.set(sessionId, {
        status: "completed",
        startedAtMs,
        completedAtMs,
        durationMs: Math.max(0, completedAtMs - startedAtMs),
      });
      this.currentRunStartedAtMs = null;
      this.setStatus("idle");
      this.emit({
        type: "task_complete",
        summary: truncatePreview(finalText || preview || "WorkBuddy 任务已完成", 240),
        outcome: "completed",
        timestamp: nowIso(),
        threadId: sessionId,
        origin: "wechat",
      });
    } catch (error) {
      if (token !== this.activePromptToken) return;
      const completedAtMs = Date.now();
      const startedAtMs = this.currentRunStartedAtMs ?? completedAtMs;
      this.runSummaries.set(sessionId, {
        status: "failed",
        startedAtMs,
        completedAtMs,
        durationMs: Math.max(0, completedAtMs - startedAtMs),
      });
      this.currentRunStartedAtMs = null;
      this.setStatus("error");
      this.emit({
        type: "task_failed",
        message: describeUnknownError(error),
        timestamp: nowIso(),
        threadId: sessionId,
        origin: "wechat",
      });
    }
  }

  private async loadSession(
    sessionId: string,
    source: "wechat" | "restore",
    reason: "wechat_resume" | "startup_restore",
  ): Promise<void> {
    const row = await this.dependencies.readSession(sessionId);
    if (!row) throw new Error("WorkBuddy 桌面端找不到该任务。");
    this.loadingSession = true;
    try {
      await this.requireClient().invoke(
        "session:load",
        sessionId,
        {
          cwd: row.cwd,
          forceRendererHistoryReplay: false,
        },
      );
      this.state.sharedSessionId = sessionId;
      this.state.activeRuntimeSessionId = sessionId;
      this.state.lastSessionSwitchAt = nowIso();
      this.emit({
        type: "session_switched",
        sessionId,
        source,
        reason,
        timestamp: nowIso(),
      });
    } finally {
      this.loadingSession = false;
    }
  }

  private handleDesktopEvent(channel: string, data: unknown): void {
    if (!channel.startsWith("session:event") || !isRecord(data)) return;
    const channelSessionId = channel.startsWith("session:event:")
      ? readString(channel.slice("session:event:".length))
      : undefined;
    const sessionId = readString(data.sessionId) ?? channelSessionId;
    if (!sessionId) return;
    if (this.state.sharedSessionId && sessionId !== this.state.sharedSessionId) return;

    const eventType = readString(data.type);
    if (eventType === "permissionRequest") {
      this.handlePermissionRequest(sessionId, data);
      return;
    }
    if (eventType === "permissionResolved") {
      const requestId = readString(data.requestId);
      if (!requestId || requestId === this.pendingPermission?.requestId) {
        this.clearPendingPermission();
      }
      return;
    }

    const update = isRecord(data.update) ? data.update : null;
    if (!update) return;
    const type = readString(update.sessionUpdate) ?? readString(update.type);
    if (this.pendingPermission && this.isPermissionToolCallSettled(update)) {
      this.clearPendingPermission();
    }
    if (
      this.loadingSession ||
      this.currentRunStartedAtMs === null ||
      (this.state.status !== "busy" && this.state.status !== "awaiting_approval")
    ) {
      return;
    }
    const text = contentText(update.content ?? update.text);
    this.state.lastOutputAt = nowIso();
    if ((type === "agent_message_chunk" || type === "assistant_message_chunk" || type === "text") && text) {
      this.currentReply += text;
    } else if (
      (type === "agent_thought_chunk" || type === "thought" || type === "plan") &&
      text
    ) {
      this.emit({ type: "thinking", text, timestamp: nowIso() });
    }
  }

  private handlePermissionRequest(sessionId: string, payload: Record<string, unknown>): void {
    const requestId = readString(payload.requestId);
    const params = isRecord(payload.request) ? payload.request : null;
    if (!requestId || !params) return;
    const options = Array.isArray(params.options)
      ? params.options.flatMap((entry): WorkBuddyPermissionOption[] => {
          if (!isRecord(entry)) return [];
          const optionId = readString(entry.optionId) ?? readString(entry.id);
          if (!optionId) return [];
          return [{
            optionId,
            name: readString(entry.name),
            kind: readString(entry.kind),
          }];
        })
      : [];
    const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
    const toolCallId = readString(toolCall.toolCallId) ?? readString(toolCall.id);
    const title = readString(toolCall.title) ?? readString(toolCall.name) ?? "工具操作";
    const detail = toolCall.rawInput ?? toolCall.input ?? params;
    const detailText = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
    const request: ApprovalRequest = {
      source: "cli",
      threadId: sessionId,
      origin: "wechat",
      summary: `WorkBuddy 请求执行：${title}`,
      commandPreview: truncatePreview(detailText || title, 800),
      detailLabel: title,
      detailPreview: truncatePreview(detailText || title, 800),
      allowForSession: Boolean(selectAcpPermissionOption(options, "confirm_session")),
      requestId,
    };
    if (this.pendingPermission?.requestId === requestId) return;
    this.pendingPermission = { sessionId, requestId, toolCallId, options, request };
    this.state.pendingApproval = request;
    this.setStatus("awaiting_approval");
    this.emit({
      type: "approval_required",
      request,
      timestamp: nowIso(),
      threadId: request.threadId,
      origin: "wechat",
    });
  }

  private isPermissionToolCallSettled(update: Record<string, unknown>): boolean {
    const pending = this.pendingPermission;
    if (!pending?.toolCallId) return false;
    const type = readString(update.sessionUpdate) ?? readString(update.type);
    if (type !== "tool_call_update" && type !== "tool_call") return false;
    const toolCallId = readString(update.toolCallId);
    if (toolCallId !== pending.toolCallId) return false;
    const status = readString(update.status)?.toLowerCase();
    return Boolean(status && status !== "pending" && status !== "awaiting_approval");
  }

  private clearPendingPermission(): void {
    if (!this.pendingPermission) return;
    this.pendingPermission = null;
    this.state.pendingApproval = null;
    if (this.state.status === "awaiting_approval") {
      this.setStatus(this.currentRunStartedAtMs === null ? "idle" : "busy");
    }
  }

  private async resolvePendingPermission(
    action: "confirm" | "confirm_session" | "deny",
  ): Promise<boolean> {
    const pending = this.pendingPermission;
    if (!pending) return false;
    if (action === "deny") {
      await this.requireClient().invoke(
        "session:rejectPermission",
        pending.sessionId,
        pending.requestId,
        "用户拒绝",
      );
    } else {
      const option = selectAcpPermissionOption(pending.options, action);
      if (!option) return false;
      await this.requireClient().invoke(
        "session:resolvePermission",
        pending.sessionId,
        pending.requestId,
        option.optionId,
      );
    }
    this.clearPendingPermission();
    return true;
  }

  private requireClient(): WorkBuddyDesktopRpcClientLike {
    if (!this.client) throw new Error("WorkBuddy Desktop 尚未连接。");
    return this.client;
  }

  private requireSessionId(): string {
    const sessionId = this.state.sharedSessionId;
    if (!sessionId) throw new Error("请先在 WorkBuddy 桌面端创建任务并从任务列表进入。");
    return sessionId;
  }

  private setStatus(status: BridgeAdapterState["status"], message?: string): void {
    this.state.status = status;
    this.emit({ type: "status", status, message, timestamp: nowIso() });
  }

  private emit(event: BridgeEvent): void {
    this.eventSink(event);
  }
}

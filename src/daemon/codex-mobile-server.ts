import crypto from "node:crypto";
import fs from "node:fs";
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import os, { type NetworkInterfaceInfo } from "node:os";
import { BoundedTtlMap } from "../utils/bounded-ttl-cache.ts";

import type {
  BridgeSessionMessage,
  BridgeSessionModelState,
  BridgeSessionProgressItem,
  BridgeSessionRunSummary,
} from "../bridge/bridge-types.ts";
import { CodexMobileAuthStore } from "./codex-mobile-auth.ts";
import type { MobileProviderSettingsEntry } from "./mobile-provider-settings.ts";
import {
  CODEX_MOBILE_CSS,
  CODEX_MOBILE_HTML,
  CODEX_MOBILE_JS,
  WE_RELAY_ABOUT_HTML,
} from "./codex-mobile-web.ts";

const WE_RELAY_ASSET_VERSION_PLACEHOLDER = "__WE_RELAY_ASSET_VERSION__";
export const CODEX_MOBILE_ASSET_VERSION = crypto.createHash("sha256")
  .update(CODEX_MOBILE_CSS)
  .update("\0")
  .update(CODEX_MOBILE_JS)
  .digest("hex")
  .slice(0, 12);

export type CodexMobileTaskShortTarget = import("../relay/relay-task-short-code.ts").WeRelayTaskShortTarget;

/**
 * Settings payload served to the mobile settings panel. It merges the
 * declarative provider metadata (capabilities + dependency graph) with the
 * live approval-rule chain and strict-approval mode, so the panel can render
 * capability chips and dependency checks without duplicating the registry.
 */
export type CodexMobileSettings = {
  strictApproval: boolean;
  approvalRules: Array<{
    id: string;
    label: string;
    description: string;
  }>;
  providers: MobileProviderSettingsEntry[];
};

export type CodexMobileProviderInstallResult = {
  accepted: true;
  status: "installing";
  message: string;
};

export {
  decodeWeRelayTaskShortCode as decodeCodexMobileTaskShortCode,
  encodeWeRelayTaskShortCode as encodeCodexMobileTaskShortCode,
} from "../relay/relay-task-short-code.ts";

import {
  decodeWeRelayTaskShortCode,
  encodeWeRelayTaskShortCode,
} from "../relay/relay-task-short-code.ts";

export function resolveCodexMobileTaskShortRedirect(
  pathname: string,
  searchParams?: URLSearchParams,
): string | null {
  const match = pathname.match(/^\/t\/([A-Za-z0-9_.~-]+)$/);
  if (!match) return null;
  const target = decodeWeRelayTaskShortCode(match[1] ?? "");
  if (!target) return null;
  const redirect = new URLSearchParams();
  redirect.set("task", target.threadId);
  redirect.set("adapter", target.adapter);
  redirect.set("appv", CODEX_MOBILE_ASSET_VERSION);
  for (const key of ["setup", "key"] as const) {
    const value = searchParams?.get(key)?.trim();
    if (value) redirect.set(key, value);
  }
  return `/?${redirect.toString()}`;
}
const CODEX_MOBILE_HTML_RESPONSE = CODEX_MOBILE_HTML.replaceAll(
  WE_RELAY_ASSET_VERSION_PLACEHOLDER,
  CODEX_MOBILE_ASSET_VERSION,
);
const WE_RELAY_ABOUT_HTML_RESPONSE = WE_RELAY_ABOUT_HTML.replaceAll(
  WE_RELAY_ASSET_VERSION_PLACEHOLDER,
  CODEX_MOBILE_ASSET_VERSION,
);
const CODEX_MOBILE_JS_RESPONSE = CODEX_MOBILE_JS.replaceAll(
  WE_RELAY_ASSET_VERSION_PLACEHOLDER,
  CODEX_MOBILE_ASSET_VERSION,
);

export type CodexMobileTaskStatus =
  | "idle"
  | "running"
  | "approval"
  | "input"
  | "error";

export type CodexMobileTask = {
  threadId: string;
  title: string;
  projectId?: string;
  projectName?: string;
  projectOrder?: number;
  projectThreadOrder?: number;
  lastUpdatedAt?: string;
  status: CodexMobileTaskStatus;
  startedAtMs?: number;
  activeTurnId?: string;
  selected?: boolean;
  canRename?: boolean;
  canCreateInProject?: boolean;
};

export type CodexMobileTaskBoardTask = CodexMobileTask & {
  adapter: string;
  adapterLabel: string;
  completedAt?: string;
};

export type CodexMobileRecentCompletion = {
  adapter: string;
  adapterLabel: string;
  threadId: string;
  title: string;
  completedAt: string;
};

export type CodexMobileTaskBoard = {
  tasks: CodexMobileTaskBoardTask[];
  recentCompleted: CodexMobileRecentCompletion[];
};

export type CodexMobileAdapter = {
  id: string;
  label: string;
  status: string;
  active: boolean;
  /** Declared capabilities for UI adaptation (DSH-inspired). */
  capabilities?: {
    sessions: boolean;
    messages: boolean;
    images: boolean;
    queue: boolean;
    approvals: boolean;
    stop: boolean;
    nativeCommands: boolean;
  };
};

export type CodexMobileAdapterList = {
  activeAdapter?: string;
  adapters: CodexMobileAdapter[];
};

export type CodexMobileAdapterSwitchResult = {
  activeAdapter: string;
  activated: boolean;
  detail: string;
};

export type CodexMobileQueuedMessage = {
  id: string;
  text: string;
  imageCount: number;
  createdAtMs?: number;
};

export type CodexMobileImageInput = {
  fileName: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: Buffer;
};

export type CodexMobileMessageInput = {
  text: string;
  images: CodexMobileImageInput[];
};

export type CodexMobileSendResult = {
  queued: boolean;
  duplicate?: boolean;
  queuedMessageId?: string;
  queuePosition?: number;
  turnId?: string;
};

type CodexMobileMessageDelivery = {
  clientId: string;
  threadId: string;
  adapter?: string;
  requestHash: string;
  status: "forwarding" | "sent" | "queued" | "duplicate" | "failed";
  result?: CodexMobileSendResult;
  error?: string;
};

export type CodexMobileApprovalAction = "confirm" | "confirm_session" | "deny";

export type CodexMobileApprovalResultAction =
  | CodexMobileApprovalAction
  | "confirm_task";

export type CodexMobileApprovalResult = {
  id: string;
  action: CodexMobileApprovalResultAction;
  summary: string;
  commandPreview: string;
  resolvedAt: string;
  turnId?: string;
  requestedAt?: string;
  detailLabel?: string;
  detailPreview?: string;
};

export type CodexMobileApprovalResolution = {
  count: number;
  result?: CodexMobileApprovalResult;
};

export type CodexMobilePendingApproval = {
  summary: string;
  commandPreview: string;
  requestId?: string;
  turnId?: string;
  createdAtMs?: number;
  allowForSession?: boolean;
  toolName?: string;
  detailLabel?: string;
  detailPreview?: string;
};

export type CodexMobileTranscript = {
  threadId: string;
  messages: BridgeSessionMessage[];
  messagePage?: {
    start?: number;
    end?: number;
    total?: number;
    hasMore: boolean;
    nextBefore: string | number | null;
    source?: "native" | "openagentlog";
    caughtUp?: boolean;
  };
  progressItems?: BridgeSessionProgressItem[];
  queuedMessages: CodexMobileQueuedMessage[];
  runSummary?: BridgeSessionRunSummary | null;
  pendingApproval?: CodexMobilePendingApproval | null;
  approvalResults?: CodexMobileApprovalResult[];
};

export function createCodexMobileTranscriptRevision(
  transcript: Pick<
    CodexMobileTranscript,
    | "threadId"
    | "messages"
    | "progressItems"
    | "queuedMessages"
    | "runSummary"
    | "pendingApproval"
    | "approvalResults"
  >,
): string {
  const latestMessage = transcript.messages.at(-1);
  const runSummary = transcript.runSummary;
  const payload = {
    threadId: transcript.threadId,
    latestMessage: latestMessage
      ? {
          id: latestMessage.id ?? "",
          role: latestMessage.role,
          text: latestMessage.text,
          turnId: latestMessage.turnId ?? "",
          phase: latestMessage.phase ?? "",
          createdAtMs: latestMessage.createdAtMs ?? 0,
          model: latestMessage.model ?? "",
          images: (latestMessage.images ?? []).map((image) => image.source === "local"
            ? [image.source, image.path, image.alt ?? ""]
            : [image.source, image.url, image.alt ?? ""]),
        }
      : null,
    progressItems: (transcript.progressItems ?? []).map((item) => ({
      id: item.id,
      turnId: item.turnId ?? "",
      kind: item.kind,
      status: item.status,
      text: item.text,
      createdAtMs: item.createdAtMs ?? 0,
    })),
    queuedMessages: transcript.queuedMessages.map((message) => ({
      id: message.id,
      text: message.text,
      imageCount: message.imageCount,
      createdAtMs: message.createdAtMs ?? 0,
    })),
    runSummary: runSummary
      ? {
          turnId: runSummary.turnId ?? "",
          status: runSummary.status,
          startedAtMs: runSummary.startedAtMs ?? 0,
          completedAtMs: runSummary.completedAtMs ?? 0,
          durationMs: runSummary.status === "running" ? 0 : runSummary.durationMs ?? 0,
          errorMessage: runSummary.errorMessage ?? "",
        }
      : null,
    pendingApproval: transcript.pendingApproval ?? null,
    approvalResults: transcript.approvalResults ?? [],
  };
  return crypto.createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
}

export type CodexMobileMessagePage = {
  messages: BridgeSessionMessage[];
  start: number;
  end: number;
  total: number;
  hasMore: boolean;
  nextBefore: number | null;
};

export function paginateCodexMobileMessages(
  messages: BridgeSessionMessage[],
  options: {
    before?: number | null;
    limit?: number;
  } = {},
): CodexMobileMessagePage {
  const total = messages.length;
  const requestedLimit = Number.isFinite(options.limit)
    ? Math.floor(options.limit ?? 40)
    : 40;
  const limit = Math.min(100, Math.max(1, requestedLimit));
  const requestedEnd = Number.isFinite(options.before)
    ? Math.floor(options.before ?? total)
    : total;
  const end = Math.min(total, Math.max(0, requestedEnd));
  const start = Math.max(0, end - limit);
  return {
    messages: messages.slice(start, end),
    start,
    end,
    total,
    hasMore: start > 0,
    nextBefore: start > 0 ? start : null,
  };
}

export type StartCodexMobileServerOptions = {
  host?: string;
  port?: number;
  maxPortAttempts?: number;
  lanAddress?: string;
  publicBaseUrl?: string;
  buildPublicTaskUrl?: (
    threadId: string,
    adapter: string,
    searchParams: URLSearchParams,
  ) => string;
  accessToken: string;
  relayPrewarmToken?: string;
  authStore?: CodexMobileAuthStore;
  resolveDesktopPublicAddress?: () => Promise<string | null>;
  listAdapters?: () => Promise<CodexMobileAdapterList>;
  switchAdapter?: (adapter: string) => Promise<CodexMobileAdapterSwitchResult>;
  readSettings?: () => Promise<CodexMobileSettings>;
  updateSettings?: (patch: {
    strictApproval?: boolean;
  }) => Promise<CodexMobileSettings>;
  installProviderDependency?: (
    providerId: string,
    dependencyId: string,
  ) => Promise<CodexMobileProviderInstallResult>;
  listTaskBoard?: () => Promise<CodexMobileTaskBoard>;
  listTasks: (adapter?: string) => Promise<CodexMobileTask[]>;
  createTask?: (
    adapter?: string,
    options?: { sourceThreadId?: string },
  ) => Promise<CodexMobileTask>;
  renameTask?: (
    threadId: string,
    title: string,
    adapter?: string,
  ) => Promise<void>;
  readTaskModel?: (
    threadId: string,
    adapter?: string,
  ) => Promise<BridgeSessionModelState>;
  setTaskModel?: (
    threadId: string,
    model: string,
    adapter?: string,
  ) => Promise<BridgeSessionModelState>;
  readMessages: (
    threadId: string,
    options?: {
      before?: string | null;
      limit?: number;
      historyOnly?: boolean;
      lightweight?: boolean;
    },
    adapter?: string,
  ) => Promise<CodexMobileTranscript>;
  sendMessage: (
    threadId: string,
    input: CodexMobileMessageInput,
    adapter?: string,
  ) => Promise<CodexMobileSendResult>;
  resolveApproval?: (
    threadId: string,
    action: CodexMobileApprovalAction,
    adapter?: string,
  ) => Promise<CodexMobileApprovalResolution>;
  updateQueuedMessage?: (
    threadId: string,
    messageId: string,
    text: string,
    adapter?: string,
  ) => Promise<boolean>;
  deleteQueuedMessage?: (
    threadId: string,
    messageId: string,
    adapter?: string,
  ) => Promise<boolean>;
  steerQueuedMessage?: (
    threadId: string,
    messageId: string,
    adapter?: string,
  ) => Promise<boolean>;
  stopTask?: (threadId: string, adapter?: string) => Promise<boolean>;
};

function relayPrewarmSearchIsAllowed(url: URL, allowed: Set<string>): boolean {
  return [...url.searchParams.keys()].every((key) => allowed.has(key));
}

function isRelayPrewarmRead(method: string, url: URL): boolean {
  if (method !== "GET") return false;
  const pathname = url.pathname;
  if (pathname === "/api/adapters" || pathname === "/api/task-board") {
    return relayPrewarmSearchIsAllowed(url, new Set());
  }
  if (pathname === "/api/tasks") {
    return relayPrewarmSearchIsAllowed(url, new Set(["adapter"]));
  }
  if (/^\/api\/tasks\/[^/]+\/model$/.test(pathname)) {
    return relayPrewarmSearchIsAllowed(url, new Set(["adapter"]));
  }
  if (!/^\/api\/tasks\/[^/]+\/messages$/.test(pathname)) return false;
  if (!relayPrewarmSearchIsAllowed(url, new Set(["adapter", "limit", "history"]))) {
    return false;
  }
  const limitValue = url.searchParams.get("limit");
  if (limitValue !== null) {
    const limit = Number(limitValue);
    if (!Number.isInteger(limit) || limit < 1 || limit > 40) return false;
  }
  const history = url.searchParams.get("history");
  return history === null || history === "1";
}

export type CodexMobileServerHandle = {
  port: number;
  lanAddress: string;
  buildTaskUrl: (threadId: string, adapter?: string) => string;
  close: () => Promise<void>;
};

class HttpError extends Error {
  readonly statusCode: number;

  constructor(
    statusCode: number,
    message: string,
  ) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class MobileAdapterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MobileAdapterUnavailableError";
  }
}

function isPrivateIpv4(address: string): boolean {
  if (/^10\./.test(address) || /^192\.168\./.test(address)) {
    return true;
  }
  const match = address.match(/^172\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function isVirtualInterface(name: string): boolean {
  return /^(utun|tun|tap|vmnet|vbox|docker|bridge|llw|awdl)/i.test(name);
}

export function resolvePreferredLanAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | null {
  const candidates: Array<{
    address: string;
    interfaceName: string;
    privateAddress: boolean;
    physicalPriority: number;
  }> = [];

  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") {
        continue;
      }
      const priority = /^(en0|en1|eth0|wlan0|wi-fi)$/i.test(interfaceName)
        ? 0
        : isVirtualInterface(interfaceName)
          ? 2
          : 1;
      candidates.push({
        address: entry.address,
        interfaceName,
        privateAddress: isPrivateIpv4(entry.address),
        physicalPriority: priority,
      });
    }
  }

  candidates.sort((left, right) => {
    if (left.physicalPriority !== right.physicalPriority) {
      return left.physicalPriority - right.physicalPriority;
    }
    if (left.privateAddress !== right.privateAddress) {
      return left.privateAddress ? -1 : 1;
    }
    return left.interfaceName.localeCompare(right.interfaceName);
  });
  return candidates[0]?.address ?? null;
}

function normalizePublicBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("移动版公网地址不是有效 URL。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("移动版公网地址只支持 HTTP 或 HTTPS。");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("移动版公网地址不能包含账号、查询参数或片段。");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function resolveCodexMobileListenHost(
  options: Pick<
    StartCodexMobileServerOptions,
    "host" | "publicBaseUrl" | "authStore"
  >,
): string {
  const explicitHost = options.host?.trim();
  if (explicitHost) {
    return explicitHost;
  }
  if (options.publicBaseUrl?.trim() && !options.authStore) {
    return "127.0.0.1";
  }
  return "0.0.0.0";
}

function timingSafeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

const MOBILE_SESSION_COOKIE = "codex_mobile_session";
const MOBILE_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_BLOCK_MS = 5 * 60_000;
const LAN_HANDOFF_TTL_MS = 45_000;
const LAN_SESSION_TTL_MS = 12 * 60 * 60_000;
const DESKTOP_PUBLIC_ADDRESS_CACHE_MS = 60_000;
const DESKTOP_PUBLIC_ADDRESS_FAILURE_CACHE_MS = 10_000;
const DESKTOP_PUBLIC_ADDRESS_PATH = "/__werelay/client-ip";

type MobileServerNetworkContext = {
  publicBaseUrl: string | null;
  lanAddress: string;
  port: number;
};

type LanHandoff = {
  expiresAtMs: number;
  target: string;
};

type LanSession = {
  clientAddress: string;
  expiresAtMs: number;
};

type LoginAttempt = {
  failures: number;
  blockedUntilMs: number;
};

function readCookie(request: IncomingMessage, name: string): string {
  const header = request.headers.cookie;
  if (!header) {
    return "";
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    if (key !== name) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function readSetupToken(request: IncomingMessage, url: URL): string {
  const header = request.headers["x-codex-mobile-setup"];
  if (typeof header === "string") {
    return header;
  }
  return url.searchParams.get("setup") ?? "";
}

function readLegacyAccessToken(request: IncomingMessage, url: URL): string {
  const header = request.headers["x-codex-mobile-key"];
  if (typeof header === "string") {
    return header;
  }
  return url.searchParams.get("key") ?? "";
}

function buildSessionCookie(
  token: string,
  secure: boolean,
  maxAgeSeconds = MOBILE_SESSION_MAX_AGE_SECONDS,
): string {
  return [
    `${MOBILE_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function buildExpiredSessionCookie(secure: boolean): string {
  return [
    `${MOBILE_SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function normalizeIpAddress(value: string | undefined): string | null {
  let normalized = value?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return null;
  }
  const zoneSeparator = normalized.indexOf("%");
  if (zoneSeparator >= 0) {
    normalized = normalized.slice(0, zoneSeparator);
  }
  if (normalized.startsWith("::ffff:")) {
    normalized = normalized.slice(7);
  }
  return isIP(normalized) ? normalized : null;
}

function isLoopbackAddress(value: string | undefined): boolean {
  const address = normalizeIpAddress(value);
  return address === "127.0.0.1" || address === "::1";
}

function isTrustedReverseProxyRequest(request: IncomingMessage): boolean {
  return isLoopbackAddress(request.socket.remoteAddress) &&
    typeof request.headers["x-forwarded-proto"] === "string" &&
    typeof request.headers["x-real-ip"] === "string";
}

function requestUsesHttps(request: IncomingMessage): boolean {
  if ((request.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted) {
    return true;
  }
  if (!isTrustedReverseProxyRequest(request)) {
    return false;
  }
  const forwardedProto = request.headers["x-forwarded-proto"];
  return typeof forwardedProto === "string" &&
    forwardedProto.split(",", 1)[0]?.trim().toLowerCase() === "https";
}

function requestPublicClientAddress(request: IncomingMessage): string | null {
  if (!isTrustedReverseProxyRequest(request)) {
    return null;
  }
  return normalizeIpAddress(request.headers["x-real-ip"] as string);
}

function requestClientKey(request: IncomingMessage): string {
  return requestPublicClientAddress(request) ??
    normalizeIpAddress(request.socket.remoteAddress) ??
    "unknown";
}

function normalizeLanHandoffTarget(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    throw new HttpError(400, "页面地址无效，请刷新后重试。");
  }
  const target = new URL(value, "http://werelay.local");
  if (target.origin !== "http://werelay.local") {
    throw new HttpError(400, "页面地址无效，请刷新后重试。");
  }
  target.searchParams.delete("setup");
  target.searchParams.delete("key");
  target.searchParams.delete("handoff");
  target.searchParams.delete("lan");
  return `${target.pathname}${target.search}${target.hash}`;
}

async function fetchDesktopPublicAddress(publicBaseUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`${publicBaseUrl}${DESKTOP_PUBLIC_ADDRESS_PATH}`, {
      cache: "no-store",
      headers: { "user-agent": "WeRelay-network-check" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return normalizeIpAddress((await response.text()).trim());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function lanEntryErrorHtml(message: string, publicBaseUrl: string | null): string {
  const publicLink = publicBaseUrl
    ? `<p><a href="${publicBaseUrl}">继续使用公网连接</a></p>`
    : "";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WeRelay</title></head><body style="margin:0;padding:32px;font:15px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;color:#1f1f1f;background:#f7f7f5"><main style="max-width:420px;margin:12vh auto;padding:28px;border-radius:18px;background:#fff"><h1 style="margin:0 0 10px;font-size:20px">局域网连接未完成</h1><p>${message}</p>${publicLink}</main></body></html>`;
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; connect-src 'self'; img-src 'self' data: http: https:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  response.end(body);
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  sendText(
    response,
    statusCode,
    "application/json; charset=utf-8",
    JSON.stringify(value),
    headers,
  );
}

function sendBinary(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: Buffer,
): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "content-length": String(body.length),
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
    "referrer-policy": "no-referrer",
  });
  response.end(body);
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes = 1_048_576,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, "消息或图片过大。");
    }
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid body");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "消息格式不正确。");
  }
}

const MOBILE_IMAGE_COUNT_LIMIT = 4;
const MOBILE_IMAGE_BYTES_LIMIT = 8 * 1024 * 1024;
const MOBILE_IMAGE_TOTAL_BYTES_LIMIT = 18 * 1024 * 1024;
const MOBILE_MESSAGE_BODY_BYTES_LIMIT = 26 * 1024 * 1024;

function detectMobileImageMimeType(
  data: Buffer,
): CodexMobileImageInput["mimeType"] | null {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    data.length >= 6 &&
    (data.toString("ascii", 0, 6) === "GIF87a" ||
      data.toString("ascii", 0, 6) === "GIF89a")
  ) {
    return "image/gif";
  }
  return null;
}

function parseCodexMobileImages(value: unknown): CodexMobileImageInput[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "图片格式不正确。");
  }
  if (value.length > MOBILE_IMAGE_COUNT_LIMIT) {
    throw new HttpError(413, `一次最多发送 ${MOBILE_IMAGE_COUNT_LIMIT} 张图片。`);
  }

  let totalBytes = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new HttpError(400, `第 ${index + 1} 张图片格式不正确。`);
    }
    const record = item as Record<string, unknown>;
    const fileName = typeof record.fileName === "string"
      ? record.fileName.trim().slice(0, 200)
      : "";
    const base64 = typeof record.dataBase64 === "string"
      ? record.dataBase64.replace(/\s+/g, "")
      : "";
    if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      throw new HttpError(400, `第 ${index + 1} 张图片内容不正确。`);
    }
    const data = Buffer.from(base64, "base64");
    if (data.length === 0) {
      throw new HttpError(400, `第 ${index + 1} 张图片是空文件。`);
    }
    if (data.length > MOBILE_IMAGE_BYTES_LIMIT) {
      throw new HttpError(413, `第 ${index + 1} 张图片不能超过 8 MB。`);
    }
    totalBytes += data.length;
    if (totalBytes > MOBILE_IMAGE_TOTAL_BYTES_LIMIT) {
      throw new HttpError(413, "图片总大小不能超过 18 MB。");
    }
    const mimeType = detectMobileImageMimeType(data);
    if (!mimeType) {
      throw new HttpError(400, `第 ${index + 1} 张图片不是支持的图片格式。`);
    }
    return {
      fileName: fileName || `image-${index + 1}`,
      mimeType,
      data,
    };
  });
}

function resolveTaskBySelector(
  tasks: CodexMobileTask[],
  selector: string,
): CodexMobileTask {
  const normalized = selector.trim();
  const exact = tasks.find((task) => task.threadId === normalized);
  if (exact) {
    return exact;
  }
  const matches = tasks.filter((task) => task.threadId.startsWith(normalized));
  if (matches.length === 1 && matches[0]) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new HttpError(409, "任务标识不唯一，请从列表重新选择。");
  }
  throw new HttpError(404, "没有找到这个任务。");
}

function createRequestHandler(
  options: StartCodexMobileServerOptions,
  network: MobileServerNetworkContext,
): (request: IncomingMessage, response: ServerResponse) => void {
  const loginAttempts = new Map<string, LoginAttempt>();
  const lanHandoffs = new Map<string, LanHandoff>();
  const lanSessions = new Map<string, LanSession>();
  const outputImages = new BoundedTtlMap<string, {
    threadId: string;
    adapter?: string;
    path: string;
  }>({
    maxSize: 512,
    ttlMs: 60 * 60_000,
  });
  const messageDeliveries = new BoundedTtlMap<string, CodexMobileMessageDelivery>({
    maxSize: 1_024,
    ttlMs: 15 * 60_000,
  });
  const messageDeliveryKey = (
    adapter: string | undefined,
    threadId: string,
    clientId: string,
  ): string => `${adapter ?? "codex"}\0${threadId}\0${clientId}`;
  const messageDeliveryPayload = (delivery: CodexMobileMessageDelivery) => ({
    clientId: delivery.clientId,
    status: delivery.status,
    ...(delivery.result ?? {}),
    ...(delivery.error ? { error: delivery.error } : {}),
  });
  const registerOutputImage = (
    threadId: string,
    adapter: string | undefined,
    imagePath: string,
  ): string | null => {
    try {
      const stat = fs.statSync(imagePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > 25 * 1024 * 1024) return null;
    } catch {
      return null;
    }
    const id = crypto.createHmac("sha256", options.accessToken)
      .update(`${threadId}\0${adapter ?? ""}\0${imagePath}`)
      .digest("base64url")
      .slice(0, 32);
    outputImages.set(id, {
      threadId,
      ...(adapter ? { adapter } : {}),
      path: imagePath,
    });
    const query = adapter ? `?adapter=${encodeURIComponent(adapter)}` : "";
    return `/api/tasks/${encodeURIComponent(threadId)}/images/${id}${query}`;
  };
  const exposeMessageImages = (
    messages: BridgeSessionMessage[],
    threadId: string,
    adapter: string | undefined,
  ): BridgeSessionMessage[] => messages.map((message) => {
    if (!message.images?.length) return message;
    const images = message.images.flatMap((image) => {
      if (image.source === "remote") {
        try {
          const url = new URL(image.url);
          if (url.protocol !== "http:" && url.protocol !== "https:") return [];
          return [{ ...image, url: url.toString() }];
        } catch {
          return [];
        }
      }
      const url = registerOutputImage(threadId, adapter, image.path);
      return url
        ? [{ source: "remote" as const, url, ...(image.alt ? { alt: image.alt } : {}) }]
        : [];
    });
    const { images: _privateImages, ...rest } = message;
    return images.length ? { ...rest, images } : rest;
  });
  let desktopPublicAddressCache: { address: string | null; expiresAtMs: number } | null = null;
  let desktopPublicAddressRequest: Promise<string | null> | null = null;

  const resolveDesktopPublicAddress = async (): Promise<string | null> => {
    const nowMs = Date.now();
    if (desktopPublicAddressCache && desktopPublicAddressCache.expiresAtMs > nowMs) {
      return desktopPublicAddressCache.address;
    }
    if (!desktopPublicAddressRequest) {
      desktopPublicAddressRequest = (options.resolveDesktopPublicAddress
        ? options.resolveDesktopPublicAddress()
        : network.publicBaseUrl
          ? fetchDesktopPublicAddress(network.publicBaseUrl)
          : Promise.resolve(null))
        .then((address) => normalizeIpAddress(address ?? undefined))
        .catch(() => null)
        .then((address) => {
          desktopPublicAddressCache = {
            address,
            expiresAtMs: Date.now() + (address
              ? DESKTOP_PUBLIC_ADDRESS_CACHE_MS
              : DESKTOP_PUBLIC_ADDRESS_FAILURE_CACHE_MS),
          };
          return address;
        })
        .finally(() => {
          desktopPublicAddressRequest = null;
        });
    }
    return await desktopPublicAddressRequest;
  };

  const isSamePublicNetwork = async (request: IncomingMessage): Promise<boolean> => {
    const clientAddress = requestPublicClientAddress(request);
    if (!clientAddress) {
      return false;
    }
    return clientAddress === await resolveDesktopPublicAddress();
  };

  const cleanExpiredHandoffs = (nowMs: number): void => {
    for (const [token, handoff] of lanHandoffs) {
      if (handoff.expiresAtMs <= nowMs) {
        lanHandoffs.delete(token);
      }
    }
  };

  const cleanExpiredLanSessions = (nowMs: number): void => {
    for (const [token, session] of lanSessions) {
      if (session.expiresAtMs <= nowMs) {
        lanSessions.delete(token);
      }
    }
  };

  const createLanSessionCookie = (request: IncomingMessage): string => {
    const nowMs = Date.now();
    cleanExpiredLanSessions(nowMs);
    const token = crypto.randomBytes(32).toString("base64url");
    lanSessions.set(token, {
      clientAddress: requestClientKey(request),
      expiresAtMs: nowMs + LAN_SESSION_TTL_MS,
    });
    return buildSessionCookie(
      token,
      false,
      Math.floor(LAN_SESSION_TTL_MS / 1_000),
    );
  };

  const createAuthenticatedSessionCookie = (
    request: IncomingMessage,
    authStore: CodexMobileAuthStore,
  ): string => {
    if (!isTrustedReverseProxyRequest(request) && !requestUsesHttps(request)) {
      return createLanSessionCookie(request);
    }
    return buildSessionCookie(authStore.createSessionToken(), requestUsesHttps(request));
  };

  const verifyLanSession = (request: IncomingMessage, token: string): boolean => {
    if (!token || isTrustedReverseProxyRequest(request)) {
      return false;
    }
    const nowMs = Date.now();
    const session = lanSessions.get(token);
    if (!session || session.expiresAtMs <= nowMs) {
      if (session) {
        lanSessions.delete(token);
      }
      return false;
    }
    return session.clientAddress === requestClientKey(request);
  };

  return (request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/") {
        sendText(response, 200, "text/html; charset=utf-8", CODEX_MOBILE_HTML_RESPONSE);
        return;
      }
      if (method === "GET" && url.pathname === "/about") {
        sendText(response, 200, "text/html; charset=utf-8", WE_RELAY_ABOUT_HTML_RESPONSE);
        return;
      }
      if (method === "GET" && url.pathname === "/app.css") {
        sendText(response, 200, "text/css; charset=utf-8", CODEX_MOBILE_CSS);
        return;
      }
      if (method === "GET" && url.pathname === "/app.js") {
        sendText(response, 200, "text/javascript; charset=utf-8", CODEX_MOBILE_JS_RESPONSE);
        return;
      }
      if (method === "GET" && url.pathname === "/app-version") {
        sendJson(response, 200, { version: CODEX_MOBILE_ASSET_VERSION });
        return;
      }
      if (method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }
      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (method === "GET" && url.pathname.startsWith("/t/")) {
        const target = resolveCodexMobileTaskShortRedirect(url.pathname, url.searchParams);
        if (!target) {
          sendText(response, 404, "text/plain; charset=utf-8", "短链接不存在或已失效。");
          return;
        }
        response.writeHead(302, {
          location: target,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end();
        return;
      }
      if (method === "GET" && url.pathname === "/lan-entry") {
        const authStore = options.authStore;
        if (!authStore?.isConfigured()) {
          sendText(
            response,
            428,
            "text/html; charset=utf-8",
            lanEntryErrorHtml("请先通过微信中的公网链接设置访问密码。", network.publicBaseUrl),
          );
          return;
        }
        if (isTrustedReverseProxyRequest(request)) {
          sendText(
            response,
            400,
            "text/html; charset=utf-8",
            lanEntryErrorHtml("这个入口只能在与电脑相同的局域网中打开。", network.publicBaseUrl),
          );
          return;
        }
        const nowMs = Date.now();
        cleanExpiredHandoffs(nowMs);
        const handoffToken = url.searchParams.get("handoff") ?? "";
        const handoff = lanHandoffs.get(handoffToken);
        if (!handoff || handoff.expiresAtMs <= nowMs) {
          if (handoffToken) {
            lanHandoffs.delete(handoffToken);
          }
          sendText(
            response,
            410,
            "text/html; charset=utf-8",
            lanEntryErrorHtml("高速连接已失效，请返回公网页面后重试。", network.publicBaseUrl),
          );
          return;
        }
        lanHandoffs.delete(handoffToken);
        response.writeHead(302, {
          location: handoff.target,
          "set-cookie": createLanSessionCookie(request),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end();
        return;
      }

      const authStore = options.authStore;
      if (authStore) {
        const setupAuthorized = !authStore.isConfigured() && timingSafeTokenEqual(
          readSetupToken(request, url),
          options.accessToken,
        );
        const sessionToken = readCookie(request, MOBILE_SESSION_COOKIE);
        const authenticated = authStore.verifySessionToken(sessionToken) ||
          verifyLanSession(request, sessionToken);
        const relayPrewarmHeader = request.headers["x-werelay-relay-prewarm"];
        const relayPrewarmAuthorized = Boolean(
          options.relayPrewarmToken &&
          request.headers["x-werelay-relay"] === "1" &&
          typeof relayPrewarmHeader === "string" &&
          timingSafeTokenEqual(relayPrewarmHeader, options.relayPrewarmToken) &&
          isRelayPrewarmRead(method, url)
        );

        if (url.pathname === "/api/auth/status" && method === "GET") {
          sendJson(response, 200, {
            authenticated,
            configured: authStore.isConfigured(),
            canSetup: setupAuthorized,
          });
          return;
        }

        if (url.pathname === "/api/auth/setup" && method === "POST") {
          if (authStore.isConfigured()) {
            throw new HttpError(409, "访问密码已经设置，请直接登录。");
          }
          if (!setupAuthorized) {
            throw new HttpError(401, "设置链接已失效，请从微信重新打开。");
          }
          const body = await readJsonBody(request);
          const password = typeof body.password === "string" ? body.password : "";
          try {
            authStore.setPassword(password);
          } catch (error) {
            throw new HttpError(
              400,
              error instanceof Error ? error.message : "密码设置失败。",
            );
          }
          sendJson(response, 200, { ok: true }, {
            "set-cookie": createAuthenticatedSessionCookie(request, authStore),
          });
          return;
        }

        if (url.pathname === "/api/auth/login" && method === "POST") {
          if (!authStore.isConfigured()) {
            throw new HttpError(428, "请先从微信中的链接设置访问密码。");
          }
          const clientKey = requestClientKey(request);
          const nowMs = Date.now();
          const attempt = loginAttempts.get(clientKey);
          if (attempt?.blockedUntilMs && attempt.blockedUntilMs > nowMs) {
            throw new HttpError(429, "密码错误次数过多，请稍后再试。");
          }
          const body = await readJsonBody(request);
          const password = typeof body.password === "string" ? body.password : "";
          if (!authStore.verifyPassword(password)) {
            const failures = (attempt?.blockedUntilMs && attempt.blockedUntilMs <= nowMs)
              ? 1
              : (attempt?.failures ?? 0) + 1;
            loginAttempts.set(clientKey, {
              failures,
              blockedUntilMs: failures >= LOGIN_ATTEMPT_LIMIT
                ? nowMs + LOGIN_BLOCK_MS
                : 0,
            });
            throw new HttpError(401, "密码不正确。");
          }
          loginAttempts.delete(clientKey);
          sendJson(response, 200, { ok: true }, {
            "set-cookie": createAuthenticatedSessionCookie(request, authStore),
          });
          return;
        }

        if (url.pathname === "/api/auth/logout" && method === "POST") {
          lanSessions.delete(sessionToken);
          sendJson(response, 200, { ok: true }, {
            "set-cookie": buildExpiredSessionCookie(requestUsesHttps(request)),
          });
          return;
        }

        if (!authStore.isConfigured()) {
          throw new HttpError(428, "请先设置移动版访问密码。");
        }
        if (!authenticated && !relayPrewarmAuthorized) {
          throw new HttpError(401, "请先输入访问密码。");
        }
      } else if (!timingSafeTokenEqual(
        readLegacyAccessToken(request, url),
        options.accessToken,
      )) {
        throw new HttpError(401, "移动版链接已失效，请从微信重新打开。");
      }

      if (method === "GET" && url.pathname === "/api/network-route") {
        const publicRequest = isTrustedReverseProxyRequest(request);
        sendJson(response, 200, {
          mode: publicRequest ? "public" : "lan",
          publicUrl: network.publicBaseUrl,
          lanUrl: `http://${network.lanAddress}:${network.port}`,
          sameNetworkLikely: publicRequest && await isSamePublicNetwork(request),
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/network/lan-handoff") {
        if (!network.publicBaseUrl || !isTrustedReverseProxyRequest(request)) {
          throw new HttpError(409, "当前已经在使用局域网连接。");
        }
        if (!await isSamePublicNetwork(request)) {
          throw new HttpError(409, "当前网络无法使用局域网高速连接。");
        }
        const body = await readJsonBody(request, 8_192);
        const target = normalizeLanHandoffTarget(body.target);
        const nowMs = Date.now();
        cleanExpiredHandoffs(nowMs);
        const handoffToken = crypto.randomBytes(32).toString("base64url");
        lanHandoffs.set(handoffToken, {
          expiresAtMs: nowMs + LAN_HANDOFF_TTL_MS,
          target,
        });
        sendJson(response, 200, {
          handoffUrl: `http://${network.lanAddress}:${network.port}/lan-entry?handoff=${encodeURIComponent(handoffToken)}`,
          expiresInSeconds: Math.floor(LAN_HANDOFF_TTL_MS / 1_000),
        });
        return;
      }

      const requestedAdapter = url.searchParams.get("adapter")?.trim() || undefined;

      const outputImageRoute = url.pathname.match(
        /^\/api\/tasks\/([^/]+)\/images\/([A-Za-z0-9_-]+)$/,
      );
      if (method === "GET" && outputImageRoute?.[1] && outputImageRoute[2]) {
        const threadId = decodeURIComponent(outputImageRoute[1]);
        const image = outputImages.get(outputImageRoute[2]);
        if (
          !image ||
          image.threadId !== threadId ||
          (image.adapter ?? undefined) !== requestedAdapter
        ) {
          throw new HttpError(404, "图片不存在或已经失效。请刷新任务后重试。");
        }
        let data: Buffer;
        try {
          data = fs.readFileSync(image.path);
        } catch {
          outputImages.delete(outputImageRoute[2]);
          throw new HttpError(404, "图片文件已经不存在。");
        }
        const mimeType = detectMobileImageMimeType(data);
        if (!mimeType) {
          throw new HttpError(415, "暂不支持打开这种图片格式。");
        }
        sendBinary(response, 200, mimeType, data);
        return;
      }

      if (method === "GET" && url.pathname === "/api/adapters") {
        const payload = options.listAdapters
          ? await options.listAdapters()
          : {
              activeAdapter: "codex",
              adapters: [{ id: "codex", label: "Codex", status: "idle", active: true }],
            };
        sendJson(response, 200, payload);
        return;
      }

      if (method === "GET" && url.pathname === "/api/settings") {
        if (!options.readSettings) {
          throw new HttpError(409, "当前连接暂不支持读取设置。");
        }
        sendJson(response, 200, await options.readSettings());
        return;
      }

      if (method === "POST" && url.pathname === "/api/settings") {
        if (!options.updateSettings) {
          throw new HttpError(409, "当前连接暂不支持修改设置。");
        }
        const body = await readJsonBody(request);
        const patch: { strictApproval?: boolean } = {};
        if (typeof body.strictApproval === "boolean") {
          patch.strictApproval = body.strictApproval;
        }
        sendJson(response, 200, await options.updateSettings(patch));
        return;
      }

      const providerInstallRoute = url.pathname.match(
        /^\/api\/settings\/providers\/([^/]+)\/install$/,
      );
      if (method === "POST" && providerInstallRoute?.[1]) {
        if (!options.installProviderDependency) {
          throw new HttpError(409, "当前连接暂不支持安装终端。");
        }
        const providerId = decodeURIComponent(providerInstallRoute[1]);
        const body = await readJsonBody(request, 4_096);
        const dependencyId = typeof body.dependencyId === "string"
          ? body.dependencyId.trim()
          : "";
        if (!dependencyId) {
          throw new HttpError(400, "缺少需要安装的组件。请刷新设置后重试。");
        }
        try {
          sendJson(
            response,
            202,
            await options.installProviderDependency(providerId, dependencyId),
          );
        } catch (error) {
          throw new HttpError(
            400,
            error instanceof Error ? error.message : "无法开始安装。",
          );
        }
        return;
      }

      if (method === "GET" && url.pathname === "/api/task-board") {
        if (!options.listTaskBoard) {
          throw new HttpError(409, "当前连接暂不支持任务看板。");
        }
        sendJson(response, 200, await options.listTaskBoard());
        return;
      }

      const adapterSwitchRoute = url.pathname.match(/^\/api\/adapters\/([^/]+)\/switch$/);
      if (method === "POST" && adapterSwitchRoute?.[1]) {
        if (!options.switchAdapter) {
          throw new HttpError(409, "当前连接暂不支持切换应用。");
        }
        const adapter = decodeURIComponent(adapterSwitchRoute[1]);
        try {
          sendJson(response, 200, await options.switchAdapter(adapter));
        } catch (error) {
          throw new HttpError(
            409,
            error instanceof Error ? error.message : "应用切换失败。",
          );
        }
        return;
      }

      if (method === "GET" && url.pathname === "/api/tasks") {
        sendJson(response, 200, { tasks: await options.listTasks(requestedAdapter) });
        return;
      }

      if (method === "POST" && url.pathname === "/api/tasks") {
        if (!options.createTask) {
          throw new HttpError(409, "当前连接暂不支持新建任务。");
        }
        try {
          const sourceThreadId = url.searchParams.get("sourceTask")?.trim() || undefined;
          sendJson(response, 201, {
            task: await options.createTask(requestedAdapter, { sourceThreadId }),
          });
        } catch (error) {
          throw new HttpError(409, error instanceof Error ? error.message : "新建任务失败。");
        }
        return;
      }

      const taskRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (method === "PATCH" && taskRoute?.[1]) {
        const threadId = decodeURIComponent(taskRoute[1]).trim();
        if (!threadId) {
          throw new HttpError(400, "任务 ID 不能为空。");
        }
        const body = await readJsonBody(request, 4_096);
        const title = typeof body.title === "string" ? body.title.trim() : "";
        if (!title) {
          throw new HttpError(400, "任务名不能为空。");
        }
        if (Array.from(title).length > 200) {
          throw new HttpError(413, "任务名不能超过 200 个字符。");
        }
        if (!options.renameTask) {
          throw new HttpError(409, "当前连接暂不支持重命名任务。");
        }
        try {
          await options.renameTask(threadId, title, requestedAdapter);
          sendJson(response, 200, { ok: true, threadId, title });
        } catch (error) {
          throw new HttpError(
            409,
            error instanceof Error ? error.message : "任务重命名失败。",
          );
        }
        return;
      }

      const modelRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/model$/);
      if (modelRoute?.[1] && (method === "GET" || method === "PUT")) {
        const tasks = await options.listTasks(requestedAdapter);
        const task = resolveTaskBySelector(tasks, decodeURIComponent(modelRoute[1]));
        if (method === "GET") {
          if (!options.readTaskModel) {
            throw new HttpError(409, "当前连接暂不支持读取模型。");
          }
          sendJson(
            response,
            200,
            await options.readTaskModel(task.threadId, requestedAdapter),
          );
          return;
        }
        if (!options.setTaskModel) {
          throw new HttpError(409, "当前连接暂不支持切换模型。");
        }
        const body = await readJsonBody(request, 4_096);
        const model = typeof body.model === "string" ? body.model.trim() : "";
        if (!model) throw new HttpError(400, "请选择一个模型。");
        if (Array.from(model).length > 200) {
          throw new HttpError(413, "模型名称过长。");
        }
        try {
          sendJson(
            response,
            200,
            await options.setTaskModel(task.threadId, model, requestedAdapter),
          );
        } catch (error) {
          throw new HttpError(
            409,
            error instanceof Error ? error.message : "模型切换失败。",
          );
        }
        return;
      }

      const stopRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/stop$/);
      if (method === "POST" && stopRoute?.[1]) {
        if (!options.stopTask) {
          throw new HttpError(501, "当前连接暂不支持停止任务。");
        }
        const tasks = await options.listTasks(requestedAdapter);
        const task = resolveTaskBySelector(
          tasks,
          decodeURIComponent(stopRoute[1]),
        );
        const interrupted = await options.stopTask(task.threadId, requestedAdapter);
        sendJson(response, 200, { ok: true, interrupted });
        return;
      }

      const messageDeliveryRoute = url.pathname.match(
        /^\/api\/tasks\/([^/]+)\/message-deliveries\/([^/]+)$/,
      );
      if (method === "GET" && messageDeliveryRoute?.[1] && messageDeliveryRoute[2]) {
        const requestedThreadId = decodeURIComponent(messageDeliveryRoute[1]).trim();
        const clientId = decodeURIComponent(messageDeliveryRoute[2]).trim();
        if (!requestedThreadId || !clientId) {
          throw new HttpError(400, "消息发送标识无效。");
        }
        const threadId = /^[0-9a-f]{8}$/i.test(requestedThreadId)
          ? resolveTaskBySelector(
              await options.listTasks(requestedAdapter),
              requestedThreadId,
            ).threadId
          : requestedThreadId;
        const delivery = messageDeliveries.get(
          messageDeliveryKey(requestedAdapter, threadId, clientId),
        );
        if (!delivery) {
          throw new HttpError(404, "还没有找到这条消息的发送记录。");
        }
        sendJson(response, 200, messageDeliveryPayload(delivery));
        return;
      }

      const messageRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/messages$/);
      const syncStateRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/sync-state$/);
      if (method === "GET" && syncStateRoute?.[1]) {
        const requestedThreadId = decodeURIComponent(syncStateRoute[1]).trim();
        if (!requestedThreadId) {
          throw new HttpError(400, "任务 ID 不能为空。");
        }
        const threadId = /^[0-9a-f]{8}$/i.test(requestedThreadId)
          ? resolveTaskBySelector(
              await options.listTasks(requestedAdapter),
              requestedThreadId,
            ).threadId
          : requestedThreadId;
        const transcript = await options.readMessages(threadId, {
          limit: 1,
          lightweight: true,
        }, requestedAdapter);
        const revision = createCodexMobileTranscriptRevision(transcript);
        const known = url.searchParams.get("known")?.trim() ?? "";
        sendJson(response, 200, {
          threadId: transcript.threadId,
          revision,
          changed: !known || known !== revision,
        });
        return;
      }
      if (messageRoute?.[1]) {
        const requestedThreadId = decodeURIComponent(messageRoute[1]).trim();
        if (!requestedThreadId) {
          throw new HttpError(400, "任务 ID 不能为空。");
        }
        if (method === "GET") {
          const threadId = /^[0-9a-f]{8}$/i.test(requestedThreadId)
            ? resolveTaskBySelector(
                await options.listTasks(requestedAdapter),
                requestedThreadId,
              ).threadId
            : requestedThreadId;
          const beforeValue = url.searchParams.get("before");
          const limitValue = url.searchParams.get("limit");
          const requestedLimit = limitValue === null ? undefined : Number(limitValue);
          const historyOnly = url.searchParams.get("history") === "1";
          const transcript = await options.readMessages(threadId, {
            ...(beforeValue === null ? {} : { before: beforeValue }),
            ...(requestedLimit === undefined ? {} : { limit: requestedLimit }),
            ...(historyOnly ? { historyOnly: true } : {}),
            lightweight: true,
          }, requestedAdapter);
          const revision = createCodexMobileTranscriptRevision(transcript);
          const fallbackPage = transcript.messagePage
            ? null
            : paginateCodexMobileMessages(transcript.messages, {
                before: beforeValue === null ? undefined : Number(beforeValue),
                limit: requestedLimit,
              });
          const messages = exposeMessageImages(
            fallbackPage?.messages ?? transcript.messages,
            transcript.threadId,
            requestedAdapter,
          );
          const messagePage = transcript.messagePage ?? {
            start: fallbackPage?.start ?? 0,
            end: fallbackPage?.end ?? messages.length,
            total: fallbackPage?.total ?? messages.length,
            hasMore: fallbackPage?.hasMore ?? false,
            nextBefore: fallbackPage?.nextBefore ?? null,
          };
          sendJson(response, 200, {
            task: null,
            threadId: transcript.threadId,
            messages,
            messagePage,
            progressItems: transcript.progressItems ?? [],
            queuedMessages: transcript.queuedMessages,
            runSummary: transcript.runSummary ?? null,
            pendingApproval: transcript.pendingApproval ?? null,
            approvalResults: transcript.approvalResults ?? [],
            revision,
          });
          return;
        }
        if (method === "POST") {
          const threadId = /^[0-9a-f]{8}$/i.test(requestedThreadId)
            ? resolveTaskBySelector(
                await options.listTasks(requestedAdapter),
                requestedThreadId,
              ).threadId
            : requestedThreadId;
          const body = await readJsonBody(request, MOBILE_MESSAGE_BODY_BYTES_LIMIT);
          const text = typeof body.text === "string" ? body.text : "";
          const images = parseCodexMobileImages(body.images);
          if (!text.trim() && images.length === 0) {
            throw new HttpError(400, "请输入文字或添加图片。");
          }
          if (Array.from(text).length > 20_000) {
            throw new HttpError(413, "消息不能超过 20000 个字符。");
          }
          const clientId = typeof body.clientId === "string"
            ? body.clientId.trim()
            : "";
          if (clientId) {
            if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) {
              throw new HttpError(400, "消息发送标识无效。");
            }
            const requestHash = crypto.createHash("sha256")
              .update(text)
              .update("\0")
              .update(images.map((image) => [
                image.fileName,
                image.mimeType,
                crypto.createHash("sha256").update(image.data).digest("hex"),
              ]).flat().join("\0"))
              .digest("hex");
            const deliveryKey = messageDeliveryKey(
              requestedAdapter,
              threadId,
              clientId,
            );
            const existing = messageDeliveries.get(deliveryKey);
            if (existing) {
              if (existing.requestHash !== requestHash) {
                throw new HttpError(409, "这条消息的发送标识已经用于其他内容。");
              }
              sendJson(response, 202, { ok: true, ...messageDeliveryPayload(existing) });
              return;
            }
            const delivery: CodexMobileMessageDelivery = {
              clientId,
              threadId,
              ...(requestedAdapter ? { adapter: requestedAdapter } : {}),
              requestHash,
              status: "forwarding",
            };
            messageDeliveries.set(deliveryKey, delivery);
            void options.sendMessage(threadId, { text, images }, requestedAdapter).then(
              (result) => {
                messageDeliveries.set(deliveryKey, {
                  ...delivery,
                  status: result.duplicate
                    ? "duplicate"
                    : result.queued
                      ? "queued"
                      : "sent",
                  result,
                });
              },
              (error: unknown) => {
                messageDeliveries.set(deliveryKey, {
                  ...delivery,
                  status: "failed",
                  error: error instanceof Error ? error.message : "消息发送失败。",
                });
              },
            );
            sendJson(response, 202, {
              ok: true,
              clientId,
              status: "forwarding",
            });
            return;
          }
          let result: CodexMobileSendResult;
          try {
            result = await options.sendMessage(
              threadId,
              { text, images },
              requestedAdapter,
            );
          } catch (error) {
            throw new HttpError(409, error instanceof Error ? error.message : "消息发送失败。");
          }
          sendJson(response, 202, { ok: true, ...result });
          return;
        }
      }

      const queueRoute = url.pathname.match(
        /^\/api\/tasks\/([^/]+)\/queue\/([^/]+)(?:\/(steer))?$/,
      );
      if (queueRoute?.[1] && queueRoute[2]) {
        const tasks = await options.listTasks(requestedAdapter);
        const task = resolveTaskBySelector(
          tasks,
          decodeURIComponent(queueRoute[1]),
        );
        const messageId = decodeURIComponent(queueRoute[2]);
        if (method === "PATCH" && !queueRoute[3]) {
          if (!options.updateQueuedMessage) {
            throw new HttpError(409, "当前连接暂不支持编辑待发送消息。");
          }
          const body = await readJsonBody(request, MOBILE_MESSAGE_BODY_BYTES_LIMIT);
          const text = typeof body.text === "string" ? body.text : "";
          if (Array.from(text).length > 20_000) {
            throw new HttpError(413, "消息不能超过 20000 个字符。");
          }
          const updated = await options.updateQueuedMessage(
            task.threadId,
            messageId,
            text,
            requestedAdapter,
          );
          if (!updated) {
            throw new HttpError(404, "这条待发送消息已经不存在。");
          }
          sendJson(response, 200, { ok: true });
          return;
        }
        if (method === "DELETE" && !queueRoute[3]) {
          if (!options.deleteQueuedMessage) {
            throw new HttpError(409, "当前连接暂不支持删除待发送消息。");
          }
          const deleted = await options.deleteQueuedMessage(
            task.threadId,
            messageId,
            requestedAdapter,
          );
          if (!deleted) {
            throw new HttpError(404, "这条待发送消息已经不存在。");
          }
          sendJson(response, 200, { ok: true });
          return;
        }
        if (method === "POST" && queueRoute[3] === "steer") {
          if (!options.steerQueuedMessage) {
            throw new HttpError(409, "当前连接暂不支持引导待发送消息。");
          }
          const steered = await options.steerQueuedMessage(
            task.threadId,
            messageId,
            requestedAdapter,
          );
          if (!steered) {
            throw new HttpError(404, "这条待发送消息已经不存在。");
          }
          sendJson(response, 200, { ok: true });
          return;
        }
      }

      const approvalRoute = url.pathname.match(/^\/api\/tasks\/([^/]+)\/approval$/);
      if (approvalRoute?.[1] && method === "POST") {
        const tasks = await options.listTasks(requestedAdapter);
        const task = resolveTaskBySelector(
          tasks,
          decodeURIComponent(approvalRoute[1]),
        );
        if (!options.resolveApproval) {
          throw new HttpError(409, "当前连接暂不支持在网页处理权限请求。");
        }
        const body = await readJsonBody(request, 4_096);
        const action = body.action;
        if (
          action !== "confirm" &&
          action !== "confirm_session" &&
          action !== "deny"
        ) {
          throw new HttpError(400, "无效的权限处理方式。");
        }
        const resolution = await options.resolveApproval(
          task.threadId,
          action,
          requestedAdapter,
        );
        if (resolution.count <= 0) {
          throw new HttpError(409, "这项权限请求已经处理或不存在。");
        }
        sendJson(response, 200, {
          ok: true,
          count: resolution.count,
          ...(resolution.result ? { result: resolution.result } : {}),
        });
        return;
      }

      throw new HttpError(404, "页面不存在。");
    })().catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (!(error instanceof HttpError) && !(error instanceof MobileAdapterUnavailableError)) {
        console.error(
          `[WeRelay mobile] ${request.method ?? "GET"} ${request.url ?? "/"} failed:`,
          error,
        );
      }
      const statusCode = error instanceof HttpError
        ? error.statusCode
        : error instanceof MobileAdapterUnavailableError
          ? 409
          : 500;
      const message = error instanceof HttpError || error instanceof MobileAdapterUnavailableError
        ? error.message
        : "移动版暂时不可用，请稍后重试。";
      sendJson(response, statusCode, { error: message });
    });
  };
}

async function listen(
  server: Server,
  host: string,
  port: number,
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("移动版无法取得监听端口。"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startCodexMobileServer(
  options: StartCodexMobileServerOptions,
): Promise<CodexMobileServerHandle> {
  const host = resolveCodexMobileListenHost(options);
  const requestedPort = options.port ?? 4396;
  const maxPortAttempts = requestedPort === 0 ? 1 : options.maxPortAttempts ?? 10;
  const publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl);
  const lanAddress = options.lanAddress ?? resolvePreferredLanAddress() ??
    (publicBaseUrl ? "127.0.0.1" : null);
  if (!lanAddress) {
    throw new Error("没有找到可供手机访问的局域网 IPv4 地址。");
  }

  let server: Server | null = null;
  let port = requestedPort;
  let lastError: unknown = null;
  const networkContext: MobileServerNetworkContext = {
    publicBaseUrl,
    lanAddress,
    port: requestedPort,
  };
  for (let attempt = 0; attempt < maxPortAttempts; attempt += 1) {
    const candidatePort = requestedPort === 0 ? 0 : requestedPort + attempt;
    networkContext.port = candidatePort;
    const candidate = http.createServer(createRequestHandler(options, networkContext));
    try {
      port = await listen(candidate, host, candidatePort);
      networkContext.port = port;
      server = candidate;
      break;
    } catch (error) {
      lastError = error;
      candidate.close();
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") {
        break;
      }
    }
  }
  if (!server) {
    throw lastError instanceof Error
      ? lastError
      : new Error("移动版服务启动失败。");
  }

  const activeServer = server;
  return {
    port,
    lanAddress,
    buildTaskUrl: (threadId, adapter) => {
      const selector = threadId.trim();
      const baseUrl = publicBaseUrl ?? `http://${lanAddress}:${port}`;
      const shortCode = encodeWeRelayTaskShortCode(adapter ?? "codex", selector);
      const searchParams = new URLSearchParams();
      if (!options.authStore) {
        searchParams.set("key", options.accessToken);
      } else if (!options.authStore.isConfigured()) {
        searchParams.set("setup", options.accessToken);
      }
      if (publicBaseUrl && options.buildPublicTaskUrl) {
        return options.buildPublicTaskUrl(
          selector,
          adapter ?? "codex",
          searchParams,
        );
      }
      const query = searchParams.toString();
      return `${baseUrl}/t/${shortCode}${query ? `?${query}` : ""}`;
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        activeServer.close(() => resolve());
        activeServer.closeAllConnections?.();
      });
    },
  };
}

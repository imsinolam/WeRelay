import { messageJournalAsset, MESSAGE_JOURNAL_CSP } from "../message-journal/assets.ts";
import { serveMobileAppBundle } from "../daemon/mobile-app-bundle.ts";
import crypto from "node:crypto";
import {
  attachRelayWebSocketServer,
  type WeRelayRelayDeviceEvent,
} from "./relay-websocket-server.ts";
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import WebSocket, { WebSocketServer as LiveWebSocketServer } from "ws";
import {
  createImmutableTextAsset,
  sendImmutableTextAsset,
} from "../utils/http-static-asset.ts";

import {
  CODEX_MOBILE_ASSET_VERSION,
  resolveCodexMobileTaskShortRedirect,
  resolveCodexMobileBoardRedirect,
} from "../daemon/codex-mobile-server.ts";
import { SESSION_ORGANIZER_CSS, SESSION_ORGANIZER_HTML, SESSION_ORGANIZER_JS } from "../daemon/session-organizer-web.ts";
import {
  CODEX_MOBILE_CSS,
  CODEX_MOBILE_HTML,
  CODEX_MOBILE_JS,
  WE_RELAY_ABOUT_HTML,
} from "../daemon/codex-mobile-web.ts";
import {
  createWeRelayRelayCommandId,
  WERELAY_RELAY_CLIENT_IP_PATH,
  WERELAY_RELAY_CHECK_PATH,
  WERELAY_RELAY_HEARTBEAT_PATH,
  WERELAY_RELAY_POLL_PATH,
  WERELAY_RELAY_PROTOCOL_VERSION,
  WERELAY_RELAY_REQUEST_BODY_LIMIT,
  WERELAY_RELAY_RESPONSE_BODY_LIMIT,
  WERELAY_RELAY_RESPONSE_PATH,
  deskRelayRelayBearerToken,
  isWeRelayRelayApiRequest,
  timingSafeRelayTokenEqual,
  type WeRelayRelayCommand,
  type WeRelayRelayCommandResponse,
  type WeRelayRelayHeaderMap,
} from "./relay-protocol.ts";
import {
  WERELAY_RELAY_TASK_LINK_REGISTER_PATH,
  WeRelayRelayTaskLinkStore,
} from "./relay-task-links.ts";
import {
  EphemeralLocalPreviewStore,
  isLocalPreviewPackage,
} from "../preview/local-preview.ts";
import {
  createLocalPreviewOpenHtml,
  createLocalPreviewViewerHtml,
  localPreviewOpenContentSecurityPolicy,
  localPreviewViewerContentSecurityPolicy,
} from "../preview/local-preview-web.ts";
import { RelayWarmSnapshotStore } from "./relay-warm-snapshot-store.ts";

const ASSET_VERSION_PLACEHOLDER = "__WE_RELAY_ASSET_VERSION__";
const MOBILE_HTML = CODEX_MOBILE_HTML.replaceAll(
  ASSET_VERSION_PLACEHOLDER,
  CODEX_MOBILE_ASSET_VERSION,
);
const ABOUT_HTML = WE_RELAY_ABOUT_HTML.replaceAll(
  ASSET_VERSION_PLACEHOLDER,
  CODEX_MOBILE_ASSET_VERSION,
);
const MOBILE_JS = CODEX_MOBILE_JS.replaceAll(
  ASSET_VERSION_PLACEHOLDER,
  CODEX_MOBILE_ASSET_VERSION,
);
const MOBILE_CSS_ASSET = createImmutableTextAsset(CODEX_MOBILE_CSS);
const MOBILE_JS_ASSET = createImmutableTextAsset(MOBILE_JS);
const ORGANIZER_CSS_ASSET = createImmutableTextAsset(SESSION_ORGANIZER_CSS);
const ORGANIZER_JS_ASSET = createImmutableTextAsset(SESSION_ORGANIZER_JS);
const MOBILE_ASSET_SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data: http: https:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const DEFAULT_POLL_TIMEOUT_MS = 25_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 90_000;
const DEFAULT_COMMAND_LEASE_MS = 35_000;
const DEFAULT_DEVICE_OFFLINE_MS = 45_000;
const DEFAULT_WARM_CACHE_FRESH_MS = 5_000;
const DEFAULT_WARM_CACHE_TTL_MS = 30 * 60_000;
const DEFAULT_WARM_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60_000;
// 设备级预热刷新周期：每个周期轮转刷新一个缓存路径。
const DEFAULT_WARM_REFRESH_INTERVAL_MS = 5_000;
// 设备级预热失败后的退避，避免电脑未授权时反复空转。
const DEFAULT_WARM_FAILURE_RETRY_MS = 30_000;
const MAX_WARM_SESSIONS = 4;
const MAX_WARM_PATHS_PER_DEVICE = 64;
const MAX_WARM_PENDING_COMMANDS = 4;
const MAX_WARM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_WARM_DEVICE_BYTES = 24 * 1024 * 1024;
const MAX_WARM_PATHS_PER_SESSION = 24;
const MAX_WARM_SESSION_BYTES = 12 * 1024 * 1024;
const DEVICE_EVENT_REFRESH_MIN_INTERVAL_MS = 1_000;
const MAX_LIVE_BROWSER_CONNECTIONS = 64;
const MAX_LIVE_SUBSCRIPTIONS = 8;
const LIVE_MAX_PAYLOAD = 4 * 1024;
const LIVE_MAX_BUFFERED_BYTES = 1 * 1024 * 1024;
const LIVE_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_LIVE_SWEEP_INTERVAL_MS = 5_000;
const MAX_PENDING_COMMANDS = 64;
// 无浏览器访问时也要提前缓存的任务条数：最近 10 个任务 + 当前任务。
const DEVICE_WARM_TASK_LIMIT = 10;
// 设备级预热会话不绑定浏览器 Cookie，用固定键复用同一份缓存。
const GLOBAL_WARM_SESSION_KEY = "__device_warm_cache__";

export type StartWeRelayRelayServerOptions = {
  host?: string;
  port?: number;
  deviceId: string;
  deviceToken: string;
  pollTimeoutMs?: number;
  commandTimeoutMs?: number;
  commandLeaseMs?: number;
  deviceOfflineMs?: number;
  webSocketHeartbeatTimeoutMs?: number;
  warmCacheFreshMs?: number;
  warmCacheTtlMs?: number;
  warmSnapshotFile?: string;
  warmSnapshotRetentionMs?: number;
  warmRefreshIntervalMs?: number;
  taskLinkStateFile?: string;
  now?: () => number;
  logger?: (message: string) => void;
};

export type WeRelayRelayServerHandle = {
  host: string;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
};

type PendingCommand = {
  command: WeRelayRelayCommand;
  leaseExpiresAtMs: number;
  resolve: (response: WeRelayRelayCommandResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WaitingPoll = {
  request: IncomingMessage;
  response: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
};

type WarmCacheEntry = {
  response: WeRelayRelayCommandResponse;
  updatedAtMs: number;
  sizeBytes: number;
};

type LiveBrowserConnection = {
  socket: WebSocket;
  sessionKey: string;
  subscriptions: Set<string>;
  lastClientFrameAtMs: number;
};

type WarmSession = {
  key: string;
  cookieHeader: string;
  expiresAtMs: number;
  paths: string[];
  entries: Map<string, WarmCacheEntry>;
  refreshing: Set<string>;
  lastUserActivityAtMs: number;
  /** 设备级预热用：当前终端与轮转刷新游标。 */
  activeAdapter: string;
  refreshCursor: number;
};

class RelayHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function normalizeIpAddress(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const unwrapped = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  const withoutZone = unwrapped.split("%", 1)[0] ?? unwrapped;
  const ipv4Mapped = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const candidate = ipv4Mapped ?? withoutZone;
  return isIP(candidate) ? candidate : null;
}

function isLoopback(value: string | undefined): boolean {
  const normalized = normalizeIpAddress(value);
  return normalized === "127.0.0.1" || normalized === "::1";
}

function isTrustedReverseProxyRequest(request: IncomingMessage): boolean {
  return isLoopback(request.socket.remoteAddress) &&
    typeof request.headers["x-real-ip"] === "string";
}

function requestClientAddress(request: IncomingMessage): string {
  if (isTrustedReverseProxyRequest(request)) {
    return normalizeIpAddress(request.headers["x-real-ip"] as string) ?? "unknown";
  }
  return normalizeIpAddress(request.socket.remoteAddress) ?? "unknown";
}

function requestForwardedProto(request: IncomingMessage): "http" | "https" {
  if ((request.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted) {
    return "https";
  }
  if (isTrustedReverseProxyRequest(request)) {
    const value = request.headers["x-forwarded-proto"];
    if (typeof value === "string" && value.split(",", 1)[0]?.trim() === "https") {
      return "https";
    }
  }
  return "http";
}

function requestDeviceId(request: IncomingMessage): string {
  const value = request.headers["x-werelay-device-id"];
  return typeof value === "string" ? value.trim() : "";
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string,
  headers: WeRelayRelayHeaderMap = {},
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
  headers: WeRelayRelayHeaderMap = {},
): void {
  sendText(
    response,
    statusCode,
    "application/json; charset=utf-8",
    JSON.stringify(value),
    headers,
  );
}

async function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new RelayHttpError(413, "消息或附件过大。");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(
  request: IncomingMessage,
  maxBytes: number,
): Promise<T> {
  const body = await readBody(request, maxBytes);
  try {
    return JSON.parse(body.toString("utf8")) as T;
  } catch {
    throw new RelayHttpError(400, "请求格式不正确。");
  }
}

function forwardedRequestHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "cookie", "x-codex-mobile-setup"]) {
    const value = request.headers[name];
    if (typeof value === "string") {
      headers[name] = value;
    }
  }
  return headers;
}

function readCookieValue(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function sessionTokenExpiryMs(token: string, fallbackMs: number): number {
  const parts = token.split(".");
  const parsed = parts[0] === "v1" ? Number(parts[1]) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > Date.now() ? parsed : fallbackMs;
}

function warmSessionKey(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isWarmCacheablePath(method: string, url: URL): boolean {
  if (method !== "GET") return false;
  const pathname = url.pathname;
  if (pathname === "/api/auth/status" || pathname === "/api/adapters" ||
      pathname === "/api/task-board" || pathname === "/api/tasks") return true;
  if (/^\/api\/tasks\/[^/]+\/model$/.test(pathname)) return true;
  // 任务消息尾页也可以预热：翻页请求（before）不缓存，避免缓存体积失控。
  if (/^\/api\/tasks\/[^/]+\/messages$/.test(pathname)) {
    return !url.searchParams.has("before");
  }
  return false;
}

function responseJson(response: WeRelayRelayCommandResponse): unknown {
  if (!response.bodyBase64) return null;
  try {
    return JSON.parse(Buffer.from(response.bodyBase64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function cachedRelayResponse(
  response: WeRelayRelayCommandResponse,
): WeRelayRelayCommandResponse {
  const headers: WeRelayRelayHeaderMap = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (["set-cookie", "content-length", "transfer-encoding", "date"].includes(name.toLowerCase())) {
      continue;
    }
    headers[name] = value;
  }
  return {
    ...response,
    headers,
  };
}

function isRelayCommandResponse(value: unknown): value is WeRelayRelayCommandResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.protocolVersion === WERELAY_RELAY_PROTOCOL_VERSION &&
    typeof record.commandId === "string" &&
    typeof record.statusCode === "number" &&
    Boolean(record.headers) &&
    typeof record.headers === "object" &&
    !Array.isArray(record.headers) &&
    (record.bodyBase64 === undefined || typeof record.bodyBase64 === "string");
}

function validateDeviceRequest(
  request: IncomingMessage,
  deviceId: string,
  deviceToken: string,
): void {
  if (
    requestDeviceId(request) !== deviceId ||
    !timingSafeRelayTokenEqual(
      deskRelayRelayBearerToken(request.headers),
      deviceToken,
    )
  ) {
    throw new RelayHttpError(401, "设备认证失败。");
  }
}

function writeForwardedResponse(
  response: ServerResponse,
  commandResponse: WeRelayRelayCommandResponse,
  extraHeaders: WeRelayRelayHeaderMap = {},
): void {
  let body: Buffer;
  try {
    body = commandResponse.bodyBase64
      ? Buffer.from(commandResponse.bodyBase64, "base64")
      : Buffer.alloc(0);
  } catch {
    sendJson(response, 502, { error: "电脑返回的数据格式不正确。" });
    return;
  }
  if (body.length > WERELAY_RELAY_RESPONSE_BODY_LIMIT) {
    sendJson(response, 502, { error: "电脑返回的内容过大。" });
    return;
  }
  response.writeHead(commandResponse.statusCode, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...commandResponse.headers,
    ...extraHeaders,
  });
  response.end(body);
}

export async function startWeRelayRelayServer(
  options: StartWeRelayRelayServerOptions,
): Promise<WeRelayRelayServerHandle> {
  const host = options.host?.trim() || "127.0.0.1";
  const requestedPort = options.port ?? 14396;
  const deviceId = options.deviceId.trim();
  const deviceToken = options.deviceToken.trim();
  if (!deviceId || !deviceToken) {
    throw new Error("WeRelay Relay 缺少设备 ID 或设备密钥。");
  }

  const now = options.now ?? (() => Date.now());
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const commandLeaseMs = options.commandLeaseMs ?? DEFAULT_COMMAND_LEASE_MS;
  const deviceOfflineMs = options.deviceOfflineMs ?? DEFAULT_DEVICE_OFFLINE_MS;
  const warmCacheFreshMs = Math.max(
    0,
    options.warmCacheFreshMs ?? DEFAULT_WARM_CACHE_FRESH_MS,
  );
  const warmCacheTtlMs = Math.max(
    warmCacheFreshMs,
    options.warmCacheTtlMs ?? DEFAULT_WARM_CACHE_TTL_MS,
  );
  const warmSnapshotRetentionMs = Math.max(
    warmCacheFreshMs,
    options.warmSnapshotRetentionMs ?? DEFAULT_WARM_SNAPSHOT_RETENTION_MS,
  );
  const warmRefreshIntervalMs = Math.max(
    250,
    options.warmRefreshIntervalMs ?? DEFAULT_WARM_REFRESH_INTERVAL_MS,
  );
  const logger = options.logger ?? (() => undefined);
  const warmSnapshotStore = options.warmSnapshotFile
    ? new RelayWarmSnapshotStore({
        filePath: options.warmSnapshotFile,
        deviceToken,
        retentionMs: warmSnapshotRetentionMs,
        maxPaths: MAX_WARM_PATHS_PER_DEVICE,
        maxBytes: MAX_WARM_DEVICE_BYTES,
        now,
      })
    : null;
  const loadedSnapshotEntries = warmSnapshotStore?.load() ?? [];
  const taskLinks = new WeRelayRelayTaskLinkStore({
    deviceToken,
    ...(options.taskLinkStateFile
      ? { stateFile: options.taskLinkStateFile }
      : {}),
  });
  const localPreviewStore = new EphemeralLocalPreviewStore({ now });
  const pendingCommands = new Map<string, PendingCommand>();
  const commandOrder: string[] = [];
  const warmSessions = new Map<string, WarmSession>();
  const warmSessionOrder: string[] = [];
  const liveConnections = new Set<LiveBrowserConnection>();
  const pendingLiveChanges = new Map<string, {
    event: Extract<WeRelayRelayDeviceEvent, { kind: "conversation" }>;
    timer: ReturnType<typeof setTimeout> | null;
  }>();
  const lastConversationRefreshAtMs = new Map<string, number>();
  const pendingLiveTasksChanges = new Map<string, ReturnType<typeof setTimeout>>();
  const lastTasksRefreshAtMs = new Map<string, number>();
  const queuedWarmRefreshes: string[] = [];
  let warmRefreshRunning = false;
  let shuttingDown = false;
  let waitingPoll: WaitingPoll | null = null;
  let lastDeviceSeenAtMs = 0;
  let liveBrowserSocket: LiveWebSocketServer | null = null;

  const cleanCommandOrder = () => {
    while (commandOrder.length > 0 && !pendingCommands.has(commandOrder[0] ?? "")) {
      commandOrder.shift();
    }
  };

  const nextCommand = (exclude = new Set<string>()): PendingCommand | null => {
    cleanCommandOrder();
    const currentMs = now();
    let firstReadable: PendingCommand | null = null;
    for (const commandId of commandOrder) {
      const pending = pendingCommands.get(commandId);
      if (!pending) {
        continue;
      }
      if (exclude.has(commandId)) continue;
      if (pending.command.expiresAtMs <= currentMs) {
        clearTimeout(pending.timer);
        pendingCommands.delete(commandId);
        pending.reject(new Error("电脑响应超时，请稍后重试。"));
        continue;
      }
      if (pending.leaseExpiresAtMs <= currentMs) {
        if (pending.command.request.method !== "GET") {
          return pending;
        }
        firstReadable ??= pending;
      }
    }
    cleanCommandOrder();
    return firstReadable;
  };

  const deliverCommand = (response: ServerResponse): boolean => {
    const pending = nextCommand();
    if (!pending) {
      return false;
    }
    pending.leaseExpiresAtMs = now() + commandLeaseMs;
    sendJson(response, 200, pending.command);
    return true;
  };

  const dispatchWaitingPoll = () => {
    if (deviceSocket?.active()) { deviceSocket.dispatch(); return; }
    if (!waitingPoll) {
      return;
    }
    const activePoll = waitingPoll;
    if (!deliverCommand(activePoll.response)) {
      return;
    }
    waitingPoll = null;
    clearTimeout(activePoll.timer);
  };

  const completeCommand = (value: unknown): WeRelayRelayCommandResponse => {
    if (!isRelayCommandResponse(value)) throw new RelayHttpError(400, "设备响应格式不正确。");
    const pending = pendingCommands.get(value.commandId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCommands.delete(value.commandId);
      pending.resolve(value);
    }
    return value;
  };

  const enqueueRelayRequest = async (input: {
    method: WeRelayRelayCommand["request"]["method"];
    path: string;
    headers: Record<string, string>;
    body?: Buffer;
    clientAddress: string;
    forwardedProto: "http" | "https";
  }): Promise<WeRelayRelayCommandResponse> => {
    if (pendingCommands.size >= MAX_PENDING_COMMANDS) {
      throw new RelayHttpError(503, "待处理请求过多，请稍后重试。");
    }
    if (!lastDeviceSeenAtMs || now() - lastDeviceSeenAtMs > deviceOfflineMs) {
      throw new RelayHttpError(503, "电脑当前离线，请确认 WeRelay 正在运行。");
    }
    const commandId = createWeRelayRelayCommandId();
    const createdAtMs = now();
    const command: WeRelayRelayCommand = {
      protocolVersion: WERELAY_RELAY_PROTOCOL_VERSION,
      id: commandId,
      deviceId,
      createdAtMs,
      expiresAtMs: createdAtMs + commandTimeoutMs,
      request: {
        method: input.method,
        path: input.path,
        headers: input.headers,
        ...(input.body?.length ? { bodyBase64: input.body.toString("base64") } : {}),
        clientAddress: input.clientAddress,
        forwardedProto: input.forwardedProto,
      },
    };

    const responsePromise = new Promise<WeRelayRelayCommandResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = pendingCommands.get(commandId);
        if (!pending) {
          return;
        }
        pendingCommands.delete(commandId);
        pending.reject(new Error("电脑响应超时，请稍后重试。"));
      }, commandTimeoutMs);
      pendingCommands.set(commandId, {
        command,
        leaseExpiresAtMs: 0,
        resolve,
        reject,
        timer,
      });
      commandOrder.push(commandId);
    });
    dispatchWaitingPoll();
    return await responsePromise;
  };

  const enqueueBrowserRequest = async (
    request: IncomingMessage,
    url: URL,
  ): Promise<WeRelayRelayCommandResponse> => {
    const method = request.method ?? "GET";
    if (!isWeRelayRelayApiRequest(method, url.pathname)) {
      throw new RelayHttpError(404, "页面不存在。");
    }
    const body = await readBody(request, WERELAY_RELAY_REQUEST_BODY_LIMIT);
    return await enqueueRelayRequest({
      method,
      path: `${url.pathname}${url.search}`,
      headers: forwardedRequestHeaders(request),
      ...(body.length ? { body } : {}),
      clientAddress: requestClientAddress(request),
      forwardedProto: requestForwardedProto(request),
    });
  };

  const closeLiveConnection = (
    connection: LiveBrowserConnection,
    code: number,
    reason: string,
  ) => {
    liveConnections.delete(connection);
    connection.socket.close(code, reason);
    const timer = setTimeout(() => connection.socket.terminate(), 250);
    timer.unref?.();
    connection.socket.once("close", () => clearTimeout(timer));
  };
  const closeLiveConnectionsForSession = (key: string) => {
    for (const connection of [...liveConnections]) {
      if (connection.sessionKey !== key) continue;
      closeLiveConnection(connection, 1008, "Session expired");
    }
  };
  const deleteWarmSession = (key: string) => {
    warmSessions.delete(key);
    const index = warmSessionOrder.indexOf(key);
    if (index >= 0) warmSessionOrder.splice(index, 1);
    closeLiveConnectionsForSession(key);
  };

  const touchWarmSession = (session: WarmSession) => {
    session.lastUserActivityAtMs = now();
    const index = warmSessionOrder.indexOf(session.key);
    if (index >= 0) warmSessionOrder.splice(index, 1);
    warmSessionOrder.push(session.key);
    while (warmSessionOrder.length > MAX_WARM_SESSIONS) {
      const removed = warmSessionOrder.shift();
      if (removed) deleteWarmSession(removed);
    }
  };

  const addWarmPath = (session: WarmSession, path: string) => {
    let url: URL;
    try {
      url = new URL(path, "http://werelay-relay.local");
    } catch {
      return;
    }
    if (!isWarmCacheablePath("GET", url)) return;
    const normalized = `${url.pathname}${url.search}`;
    const existing = session.paths.indexOf(normalized);
    if (existing >= 0) return;
    session.paths.push(normalized);
    const pathLimit = session.key === GLOBAL_WARM_SESSION_KEY
      ? MAX_WARM_PATHS_PER_DEVICE
      : MAX_WARM_PATHS_PER_SESSION;
    while (session.paths.length > pathLimit) {
      const removed = session.paths.shift();
      if (removed) session.entries.delete(removed);
    }
  };

  const ensureWarmSession = (token: string): WarmSession => {
    const key = warmSessionKey(token);
    const existing = warmSessions.get(key);
    if (existing) {
      existing.cookieHeader = `codex_mobile_session=${encodeURIComponent(token)}`;
      existing.expiresAtMs = sessionTokenExpiryMs(token, now() + warmCacheTtlMs);
      touchWarmSession(existing);
      return existing;
    }
    const session: WarmSession = {
      key,
      cookieHeader: `codex_mobile_session=${encodeURIComponent(token)}`,
      expiresAtMs: sessionTokenExpiryMs(token, now() + warmCacheTtlMs),
      paths: [],
      entries: new Map(),
      refreshing: new Set(),
      lastUserActivityAtMs: now(),
      activeAdapter: "",
      refreshCursor: 0,
    };
    warmSessions.set(key, session);
    touchWarmSession(session);
    return session;
  };

  // 设备级预热会话：不依赖浏览器 Cookie，电脑在线时就持续刷新任务列表与
  // 最近任务的消息尾页，使用户打开公网页面时直接命中最新快照。
  const globalWarmSession: WarmSession = {
    key: GLOBAL_WARM_SESSION_KEY,
    cookieHeader: "",
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    paths: [],
    entries: new Map(),
    refreshing: new Set(),
    lastUserActivityAtMs: now(),
    activeAdapter: "",
    refreshCursor: 0,
  };
  for (const path of ["/api/adapters", "/api/task-board", "/api/tasks"]) {
    addWarmPath(globalWarmSession, path);
  }
  if (warmSnapshotStore) {
    for (const entry of loadedSnapshotEntries) {
      globalWarmSession.entries.set(entry.path, {
        response: entry.response,
        updatedAtMs: entry.updatedAtMs,
        sizeBytes: entry.sizeBytes,
      });
      addWarmPath(globalWarmSession, entry.path);
    }
  }
  let globalWarmRetryAtMs = 0;


  const warmSessionFromRequest = (request: IncomingMessage): WarmSession | null => {
    const token = readCookieValue(request.headers.cookie, "codex_mobile_session");
    if (!token) return null;
    const key = warmSessionKey(token);
    const session = warmSessions.get(key) ?? null;
    if (!session) return null;
    if (
      session.expiresAtMs <= now() ||
      now() - session.lastUserActivityAtMs > warmCacheTtlMs
    ) {
      deleteWarmSession(key);
      return null;
    }
    touchWarmSession(session);
    return session;
  };


  const learnWarmPaths = (
    session: WarmSession,
    path: string,
    response: WeRelayRelayCommandResponse,
  ) => {
    const payload = responseJson(response);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const record = payload as Record<string, unknown>;
    let url: URL;
    try {
      url = new URL(path, "http://werelay-relay.local");
    } catch {
      return;
    }
    if (url.pathname === "/api/adapters" && typeof record.activeAdapter === "string") {
      session.activeAdapter = record.activeAdapter;
      addWarmPath(session, `/api/tasks?adapter=${encodeURIComponent(record.activeAdapter)}`);
    }
    const isTaskList = url.pathname === "/api/tasks";
    const isTaskBoard = url.pathname === "/api/task-board";
    if ((!isTaskList && !isTaskBoard) || !Array.isArray(record.tasks)) return;
    const fallbackAdapter = url.searchParams.get("adapter")?.trim() || session.activeAdapter;
    // 最近 10 个任务 + 当前任务的消息尾页：用户打开页面即可直接看到内容。
    for (const task of record.tasks.slice(0, DEVICE_WARM_TASK_LIMIT)) {
      if (!task || typeof task !== "object" || Array.isArray(task)) continue;
      const taskRecord = task as Record<string, unknown>;
      const threadId = taskRecord.threadId;
      const adapter = isTaskBoard && typeof taskRecord.adapter === "string"
        ? taskRecord.adapter.trim()
        : fallbackAdapter;
      if (typeof threadId !== "string" || !threadId || !adapter) continue;
      addWarmPath(session, `/api/tasks?adapter=${encodeURIComponent(adapter)}`);
      const base = `/api/tasks/${encodeURIComponent(threadId)}/messages`;
      addWarmPath(session, `${base}?limit=40&history=1&adapter=${encodeURIComponent(adapter)}`);
      addWarmPath(session, `${base}?limit=5&adapter=${encodeURIComponent(adapter)}`);
    }
  };

  const storeWarmResponse = (
    session: WarmSession,
    path: string,
    response: WeRelayRelayCommandResponse,
  ) => {
    if (response.statusCode < 200 || response.statusCode >= 300) return;
    const sizeBytes = response.bodyBase64
      ? Buffer.byteLength(response.bodyBase64, "base64")
      : 0;
    if (sizeBytes > MAX_WARM_RESPONSE_BYTES) return;
    addWarmPath(session, path);
    session.entries.set(path, {
      response: cachedRelayResponse(response),
      updatedAtMs: now(),
      sizeBytes,
    });
    const maxSessionBytes = session.key === GLOBAL_WARM_SESSION_KEY
      ? MAX_WARM_DEVICE_BYTES
      : MAX_WARM_SESSION_BYTES;
    let totalBytes = [...session.entries.values()].reduce(
      (total, entry) => total + entry.sizeBytes,
      0,
    );
    while (totalBytes > maxSessionBytes && session.entries.size > 1) {
      const oldest = [...session.entries.entries()].sort(
        (left, right) => left[1].updatedAtMs - right[1].updatedAtMs,
      )[0];
      if (!oldest) break;
      session.entries.delete(oldest[0]);
      const pathIndex = session.paths.indexOf(oldest[0]);
      if (pathIndex >= 0) session.paths.splice(pathIndex, 1);
      totalBytes -= oldest[1].sizeBytes;
    }
    learnWarmPaths(session, path, response);
    if (session.key === GLOBAL_WARM_SESSION_KEY && warmSnapshotStore) {
      warmSnapshotStore.save(globalSnapshotEntries());
    }
  };

  const globalSnapshotEntries = () =>
    [...globalWarmSession.entries.entries()].map(([entryPath, entry]) => ({
      path: entryPath,
      ...entry,
    }));

  const persistDeviceEntry = (path: string, response: WeRelayRelayCommandResponse) => {
    if (!warmSnapshotStore) return;
    const sizeBytes = response.bodyBase64
      ? Buffer.byteLength(response.bodyBase64, "base64")
      : 0;
    if (response.statusCode < 200 || response.statusCode >= 300 ||
        sizeBytes > MAX_WARM_RESPONSE_BYTES) return;
    globalWarmSession.entries.set(path, {
      response: cachedRelayResponse(response),
      updatedAtMs: now(),
      sizeBytes,
    });
    addWarmPath(globalWarmSession, path);
    warmSnapshotStore.save(globalSnapshotEntries());
  };

  const responseAuthenticatesSession = (
    path: string,
    response: WeRelayRelayCommandResponse,
  ): boolean => {
    if (response.statusCode < 200 || response.statusCode >= 300) return false;
    const url = new URL(path, "http://werelay-relay.local");
    if (url.pathname !== "/api/auth/status") {
      return !url.pathname.startsWith("/api/auth/");
    }
    const payload = responseJson(response);
    return Boolean(
      payload && typeof payload === "object" && !Array.isArray(payload) &&
      (payload as Record<string, unknown>).authenticated === true
    );
  };

  const invalidateWarmResponses = () => {
    globalWarmSession.entries.clear();
    globalWarmSession.refreshCursor = 0;
    warmSnapshotStore?.save([]);
    for (const warmSession of warmSessions.values()) {
      warmSession.entries.clear();
      warmSession.refreshCursor = 0;
    }
  };

  const taskWriteTargets = (
    url: URL,
    response: WeRelayRelayCommandResponse,
  ): { adapter: string; threadId: string } | null => {
    const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\//);
    if (!match?.[1]) return null;
    let threadId: string;
    try {
      threadId = decodeURIComponent(match[1]);
    } catch {
      return null;
    }
    const payload = responseJson(response);
    const responseAdapter = payload && typeof payload === "object" &&
      !Array.isArray(payload) &&
      typeof (payload as Record<string, unknown>).adapter === "string"
      ? String((payload as Record<string, unknown>).adapter).trim()
      : "";
    const adapter = url.searchParams.get("adapter")?.trim() || responseAdapter;
    return threadId && adapter ? { adapter, threadId } : null;
  };

  const messageTailPaths = (adapter: string, threadId: string) => {
    const base = `/api/tasks/${encodeURIComponent(threadId)}/messages`;
    return [
      `${base}?limit=40&history=1&adapter=${encodeURIComponent(adapter)}`,
      `${base}?limit=5&adapter=${encodeURIComponent(adapter)}`,
    ];
  };
  const taskListPath = (adapter: string) =>
    `/api/tasks?adapter=${encodeURIComponent(adapter)}`;
  const taskModelPath = (adapter: string, threadId: string) =>
    `/api/tasks/${encodeURIComponent(threadId)}/model?adapter=${encodeURIComponent(adapter)}`;
  const invalidateDevicePaths = (
    paths: string[],
    predicate: (path: string, url: URL) => boolean,
  ) => {
    const wanted = new Set(paths);
    for (const session of [globalWarmSession, ...warmSessions.values()]) {
      for (const [path, entry] of session.entries) {
        let url: URL;
        try {
          url = new URL(path, "http://werelay-relay.local");
        } catch {
          continue;
        }
        if (wanted.has(path) || predicate(path, url)) {
          // A zero timestamp keeps the payload servable while making both age
          // headers and freshness checks detect that a refresh is due.
          session.entries.set(path, { ...entry, updatedAtMs: 0 });
        }
      }
    }
    if (warmSnapshotStore) {
      warmSnapshotStore.save(globalSnapshotEntries());
    }
  };
  const invalidateTaskWarmPaths = (adapter: string, threadId: string) => {
    invalidateDevicePaths(
      [taskListPath(adapter), "/api/task-board"],
      (path, url) => {
        if (url.pathname === "/api/tasks" &&
            url.searchParams.get("adapter") === adapter) return true;
        if (url.pathname === "/api/task-board") return true;
        const decoded = (() => {
          const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(?:messages|model)$/);
          if (!match?.[1]) return "";
          try {
            return decodeURIComponent(match[1]);
          } catch {
            return "";
          }
        })();
        return decoded === threadId &&
          url.searchParams.get("adapter") === adapter;
      },
    );
  };

  const installLocalPreviewPackage = (
    url: URL,
    commandResponse: WeRelayRelayCommandResponse,
  ): WeRelayRelayCommandResponse => {
    if (
      commandResponse.statusCode < 200 ||
      commandResponse.statusCode >= 300 ||
      !/^\/api\/previews\/jobs\/[^/]+$/.test(url.pathname)
    ) return commandResponse;
    const payload = responseJson(commandResponse);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return commandResponse;
    }
    const record = payload as Record<string, unknown>;
    if (record.previewPackage === undefined) return commandResponse;
    if (!isLocalPreviewPackage(record.previewPackage)) {
      throw new RelayHttpError(502, "电脑返回的手机预览部署包无效。");
    }
    localPreviewStore.put(record.previewPackage);
    const deploymentId = record.previewPackage.deploymentId;
    delete record.previewPackage;
    record.deploymentId = deploymentId;
    record.entryPath = record.entryPath || localPreviewStore.entryPath(deploymentId);
    record.readyUrl = `/preview/view/${encodeURIComponent(deploymentId)}`;
    const headers = { ...commandResponse.headers };
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "content-length") delete headers[name];
    }
    headers["content-type"] = "application/json; charset=utf-8";
    return {
      ...commandResponse,
      headers,
      bodyBase64: Buffer.from(JSON.stringify(record)).toString("base64"),
    };
  };

  const recordBrowserResponse = (
    request: IncomingMessage,
    url: URL,
    commandResponse: WeRelayRelayCommandResponse,
  ) => {
    const path = `${url.pathname}${url.search}`;
    const requestToken = readCookieValue(request.headers.cookie, "codex_mobile_session");
    let session = requestToken ? warmSessions.get(warmSessionKey(requestToken)) : undefined;
    if (requestToken && responseAuthenticatesSession(path, commandResponse)) {
      session = ensureWarmSession(requestToken);
    } else if (
      session &&
      commandResponse.statusCode !== 401 &&
      commandResponse.statusCode !== 403
    ) {
      touchWarmSession(session);
    }
    if (session && request.method === "GET" && isWarmCacheablePath("GET", url)) {
      storeWarmResponse(session, path, commandResponse);
      persistDeviceEntry(path, commandResponse);
    }
    if (request.method !== "GET" && commandResponse.statusCode < 400) {
      const target = taskWriteTargets(url, commandResponse);
      if (target) {
        invalidateTaskWarmPaths(target.adapter, target.threadId);
        void (async () => {
          for (const warmPath of [
            ...messageTailPaths(target.adapter, target.threadId),
            taskModelPath(target.adapter, target.threadId),
            taskListPath(target.adapter),
            "/api/task-board",
          ]) {
            queueWarmRefresh(warmPath);
          }
        })();
      } else {
        invalidateWarmResponses();
      }
    }
  };

  const refreshWarmPath = async (
    session: WarmSession,
    path: string,
  ): Promise<boolean> => {
    const isDeviceSession = session.key === GLOBAL_WARM_SESSION_KEY;
    if (session.refreshing.has(path) || session.expiresAtMs <= now() ||
        (isDeviceSession && now() < globalWarmRetryAtMs)) return false;
    if (pendingCommands.size >= MAX_WARM_PENDING_COMMANDS) return false;
    session.refreshing.add(path);
    try {
      const response = await enqueueRelayRequest({
        method: "GET",
        path,
        headers: isDeviceSession
          ? { "x-werelay-prewarm": "1" }
          : { cookie: session.cookieHeader },
        clientAddress: "relay-cache",
        forwardedProto: "https",
      });
      if (response.statusCode === 401 || response.statusCode === 403) {
        if (isDeviceSession) {
          // 电脑未授权预热：清空并退避，避免反复空转。
          session.entries.clear();
          session.refreshCursor = 0;
          warmSnapshotStore?.save([]);
          globalWarmRetryAtMs = now() + DEFAULT_WARM_FAILURE_RETRY_MS;
        } else {
          deleteWarmSession(session.key);
        }
        return false;
      }
      const pathname = new URL(path, "http://werelay-relay.local").pathname;
      if (pathname === "/api/auth/status" && !responseAuthenticatesSession(path, response)) {
        deleteWarmSession(session.key);
        return false;
      }
      if (responseAuthenticatesSession(path, response) ||
          !pathname.startsWith("/api/auth/")) {
        if (isDeviceSession) globalWarmRetryAtMs = 0;
        storeWarmResponse(session, path, response);
        return response.statusCode >= 200 && response.statusCode < 300;
      }
      return false;
    } catch {
      // Warm refresh failures stay silent; the last verified snapshot remains usable.
      return false;
    } finally {
      session.refreshing.delete(path);
    }
  };

  const drainQueuedWarmRefreshes = async () => {
    if (warmRefreshRunning) return;
    warmRefreshRunning = true;
    try {
      while (queuedWarmRefreshes.length > 0) {
        if (shuttingDown) {
          queuedWarmRefreshes.length = 0;
          break;
        }
        const path = queuedWarmRefreshes.shift();
        if (!path) continue;
        await refreshWarmPath(globalWarmSession, path);
      }
    } finally {
      warmRefreshRunning = false;
    }
  };

  const queueWarmRefresh = (path: string) => {
    if (shuttingDown) return;
    if (!queuedWarmRefreshes.includes(path)) queuedWarmRefreshes.push(path);
    void drainQueuedWarmRefreshes();
  };

  // 电脑在线时轮转刷新设备级缓存，使用户打开页面即可看到最新状态。
  const scheduleWarmRefresh = () => {
    if (!lastDeviceSeenAtMs || now() - lastDeviceSeenAtMs > deviceOfflineMs) return;
    for (const session of [globalWarmSession, ...warmSessions.values()]) {
      const isDeviceSession = session.key === GLOBAL_WARM_SESSION_KEY;
      if (
        !isDeviceSession &&
        (session.expiresAtMs <= now() ||
          now() - session.lastUserActivityAtMs > warmCacheTtlMs)
      ) {
        deleteWarmSession(session.key);
        continue;
      }
      if (
        !session.paths.length ||
        (isDeviceSession && now() < globalWarmRetryAtMs)
      ) continue;
      for (let offset = 0; offset < session.paths.length; offset += 1) {
        const index = (session.refreshCursor + offset) % session.paths.length;
        const path = session.paths[index];
        if (!path || session.refreshing.has(path)) continue;
        const entry = session.entries.get(path);
        if (entry && now() - entry.updatedAtMs < warmCacheFreshMs) continue;
        session.refreshCursor = (index + 1) % session.paths.length;
        void refreshWarmPath(session, path);
        break;
      }
    }
  };

  const sendLive = (
    connection: LiveBrowserConnection,
    value: Record<string, unknown>,
  ): boolean => {
    if (connection.socket.readyState !== WebSocket.OPEN) return false;
    if (connection.socket.bufferedAmount > LIVE_MAX_BUFFERED_BYTES) {
      connection.socket.terminate();
      liveConnections.delete(connection);
      return false;
    }
    connection.socket.send(JSON.stringify(value), (error) => {
      if (error) connection.socket.terminate();
    });
    return true;
  };
  const broadcastConversationChanged = (event: {
    adapter: string;
    threadId: string;
    revision: string;
  }) => {
    const key = `${event.adapter}\n${event.threadId}`;
    for (const connection of [...liveConnections]) {
      if (!connection.subscriptions.has(key)) continue;
      sendLive(connection, {
        v: 1,
        type: "changed",
        adapter: event.adapter,
        threadId: event.threadId,
        revision: event.revision,
      });
    }
  };
  const broadcastTasksChanged = (adapter: string) => {
    for (const connection of [...liveConnections]) {
      sendLive(connection, { v: 1, type: "tasks-changed", adapter });
    }
  };
  const refreshTasksWarmPaths = async (adapter: string) => {
    await Promise.all([
      refreshWarmPath(globalWarmSession, taskListPath(adapter)),
      refreshWarmPath(globalWarmSession, "/api/task-board"),
    ]);
  };
  const refreshAndBroadcastConversation = async (
    event: Extract<WeRelayRelayDeviceEvent, { kind: "conversation" }>,
  ) => {
    if (shuttingDown) return;
    const key = `${event.adapter}\n${event.threadId}`;
    const pending = pendingLiveChanges.get(key);
    if (pending) pendingLiveChanges.delete(key);
    lastConversationRefreshAtMs.set(key, Date.now());
    const queuedPaths = [
      taskModelPath(event.adapter, event.threadId),
      taskListPath(event.adapter),
      "/api/task-board",
    ];
    const refreshTail = async (path: string, deadlineMs: number) => {
      while (!shuttingDown) {
        if (Date.now() >= deadlineMs) return false;
        if (await refreshWarmPath(globalWarmSession, path)) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    };
    const tailDeadlineMs = Date.now() + 2_000;
    const tailRefreshes = messageTailPaths(event.adapter, event.threadId)
      .map((path) => refreshTail(path, tailDeadlineMs));
    for (const path of queuedPaths) queueWarmRefresh(path);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      Promise.all(tailRefreshes),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(
          resolve,
          Math.max(0, tailDeadlineMs - Date.now()),
        );
        timeoutId.unref?.();
      }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    if (shuttingDown) return;
    broadcastConversationChanged(event);
  };
  const scheduleConversationChanged = (
    event: Extract<WeRelayRelayDeviceEvent, { kind: "conversation" }>,
  ) => {
    const key = `${event.adapter}\n${event.threadId}`;
    const previous = pendingLiveChanges.get(key);
    if (previous) {
      previous.event = event;
      return;
    }
    const pending = { event, timer: null as ReturnType<typeof setTimeout> | null };
    const delay = Math.max(
      0,
      DEVICE_EVENT_REFRESH_MIN_INTERVAL_MS -
        (Date.now() - (lastConversationRefreshAtMs.get(key) ?? 0)),
    );
    pendingLiveChanges.set(key, pending);
    const timer = setTimeout(() => {
      const current = pendingLiveChanges.get(key);
      if (!current || current.timer !== timer) return;
      current.timer = null;
      void refreshAndBroadcastConversation(current.event);
    }, delay);
    timer.unref?.();
    pending.timer = timer;
  };
  const beginLiveUpgrade = (
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => {
    if (!liveBrowserSocket) return false;
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://werelay-relay.local");
    } catch {
      return false;
    }
    if (url.pathname !== "/api/live") return false;
    if (
      [...url.searchParams.keys()].some((key) => key !== "adapter") ||
      url.searchParams.getAll("adapter").length > 1
    ) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
      return true;
    }
    const refuse = (code: number) => {
      socket.write(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
    };
    if (liveConnections.size >= MAX_LIVE_BROWSER_CONNECTIONS) {
      refuse(503);
      return true;
    }
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (typeof origin !== "string" || typeof host !== "string" || !host) {
      refuse(403);
      return true;
    }
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      refuse(403);
      return true;
    }
    if (
      (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") ||
      originUrl.host.toLowerCase() !== host.toLowerCase()
    ) {
      refuse(403);
      return true;
    }
    const warmSession = warmSessionFromRequest(request);
    if (!warmSession) {
      refuse(401);
      return true;
    }
    liveBrowserSocket.handleUpgrade(request, socket, head, (connected) => {
      const connection: LiveBrowserConnection = {
        socket: connected,
        sessionKey: warmSession.key,
        subscriptions: new Set<string>(),
        lastClientFrameAtMs: Date.now(),
      };
      liveConnections.add(connection);
      connected.on("error", () => connected.terminate());
      connected.on("close", () => liveConnections.delete(connection));
      connected.on("message", (data, binary) => {
        connection.lastClientFrameAtMs = Date.now();
        if (connected.bufferedAmount > LIVE_MAX_BUFFERED_BYTES) {
          connected.terminate();
          liveConnections.delete(connection);
          return;
        }
        try {
          if (binary) throw new Error("binary");
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          if (message.v !== 1) throw new Error("version");
          if (message.type === "ping" && Object.keys(message).length === 2) {
            const liveSession = warmSessions.get(connection.sessionKey);
            if (!liveSession) throw new Error("session");
            touchWarmSession(liveSession);
            sendLive(connection, { v: 1, type: "pong" });
            return;
          }
          if (message.type === "subscribe" || message.type === "unsubscribe") {
            const adapter = message.adapter;
            const threadId = message.threadId;
            if (
              Object.keys(message).length !== 4 ||
              typeof adapter !== "string" ||
              !adapter ||
              adapter !== adapter.trim() ||
              Array.from(adapter).length > 200 ||
              typeof threadId !== "string" ||
              !threadId ||
              threadId !== threadId.trim() ||
              Array.from(threadId).length > 200
            ) throw new Error("subscription");
            const liveSession = warmSessions.get(connection.sessionKey);
            if (!liveSession) throw new Error("session");
            touchWarmSession(liveSession);
            const key = `${adapter}\n${threadId}`;
            if (message.type === "subscribe") {
              if (
                !connection.subscriptions.has(key) &&
                connection.subscriptions.size >= MAX_LIVE_SUBSCRIPTIONS
              ) {
                throw new Error("subscription limit");
              }
              connection.subscriptions.add(key);
            } else {
              connection.subscriptions.delete(key);
            }
            return;
          }
          throw new Error("frame");
        } catch {
          closeLiveConnection(connection, 1008, "Invalid live protocol");
        }
      });
      sendLive(connection, { v: 1, type: "hello" });
    });
    return true;
  };
  const scheduleTasksChanged = (adapter: string) => {
    if (pendingLiveTasksChanges.has(adapter)) return;
    const delay = Math.max(
      0,
      DEVICE_EVENT_REFRESH_MIN_INTERVAL_MS -
        (Date.now() - (lastTasksRefreshAtMs.get(adapter) ?? 0)),
    );
    const timer = setTimeout(() => {
      pendingLiveTasksChanges.delete(adapter);
      lastTasksRefreshAtMs.set(adapter, Date.now());
      void (async () => {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          refreshTasksWarmPaths(adapter).then(() => true),
          new Promise<boolean>((resolve) => {
            timeoutId = setTimeout(() => resolve(false), 2_000);
            timeoutId.unref?.();
          }),
        ]);
        if (timeoutId) clearTimeout(timeoutId);
        if (!shuttingDown) broadcastTasksChanged(adapter);
      })();
    }, delay);
    timer.unref?.();
    pendingLiveTasksChanges.set(adapter, timer);
  };
  const liveSweepTimer = setInterval(() => {
    const currentMs = Date.now();
    for (const connection of [...liveConnections]) {
      if (currentMs - connection.lastClientFrameAtMs > LIVE_IDLE_TIMEOUT_MS) {
        closeLiveConnection(connection, 1001, "Idle timeout");
        continue;
      }
      const session = warmSessions.get(connection.sessionKey);
      if (
        !session ||
        session.expiresAtMs <= now() ||
        now() - session.lastUserActivityAtMs > warmCacheTtlMs
      ) {
        deleteWarmSession(connection.sessionKey);
      }
    }
  }, Math.min(DEFAULT_LIVE_SWEEP_INTERVAL_MS, Math.max(100, warmCacheTtlMs / 4)));
  liveSweepTimer.unref?.();
  const closeAllLive = () => {
    for (const connection of [...liveConnections]) {
      closeLiveConnection(connection, 1001, "Relay shutting down");
    }
  };
  const warmRefreshTimer = setInterval(scheduleWarmRefresh, warmRefreshIntervalMs);
  warmRefreshTimer.unref?.();

  const activeSockets = new Set<import("node:net").Socket>();
  const server: Server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://werelay-relay.local");
      const method = request.method ?? "GET";

      const journalAsset = method === "GET" ? messageJournalAsset(url.pathname) : undefined;
      if (journalAsset) {
        sendText(response, 200, journalAsset.contentType, journalAsset.body, { "content-security-policy": MESSAGE_JOURNAL_CSP });
        return;
      }
      if (method === "GET" && url.pathname === "/") {
        sendText(response, 200, "text/html; charset=utf-8", MOBILE_HTML);
        return;
      }
      if (method === "GET" && url.pathname === "/about") {
        sendText(response, 200, "text/html; charset=utf-8", ABOUT_HTML);
        return;
      }
      if (method === "GET" && url.pathname === "/organizer") {
        sendText(response, 200, "text/html; charset=utf-8", SESSION_ORGANIZER_HTML.replaceAll("__WE_RELAY_ASSET_VERSION__", CODEX_MOBILE_ASSET_VERSION));
        return;
      }
      if (method === "GET" && url.pathname === "/organizer.css") {
        sendImmutableTextAsset(request, response, "text/css; charset=utf-8", ORGANIZER_CSS_ASSET, MOBILE_ASSET_SECURITY_HEADERS);
        return;
      }
      if (method === "GET" && url.pathname === "/organizer.js") {
        sendImmutableTextAsset(request, response, "text/javascript; charset=utf-8", ORGANIZER_JS_ASSET, MOBILE_ASSET_SECURITY_HEADERS);
        return;
      }
      if (method === "GET" && url.pathname === "/app.css") {
        sendImmutableTextAsset(
          request,
          response,
          "text/css; charset=utf-8",
          MOBILE_CSS_ASSET,
          MOBILE_ASSET_SECURITY_HEADERS,
        );
        return;
      }
      if (method === "GET" && url.pathname === "/app.js") {
        sendImmutableTextAsset(
          request,
          response,
          "text/javascript; charset=utf-8",
          MOBILE_JS_ASSET,
          MOBILE_ASSET_SECURITY_HEADERS,
        );
        return;
      }
      if (method === "GET" && url.pathname === "/app-bundle") {
        serveMobileAppBundle(response);
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
      if (method === "GET" && url.pathname === "/preview/open") {
        const nonce = crypto.randomBytes(18).toString("base64");
        sendText(
          response,
          200,
          "text/html; charset=utf-8",
          createLocalPreviewOpenHtml(nonce),
          {
            "content-security-policy": localPreviewOpenContentSecurityPolicy(nonce),
            "referrer-policy": "no-referrer",
          },
        );
        return;
      }
      const localPreviewViewRoute = url.pathname.match(/^\/preview\/view\/([^/]+)$/);
      if (method === "GET" && localPreviewViewRoute?.[1]) {
        if (!warmSessionFromRequest(request)) {
          sendJson(response, 401, { error: "请先返回 WeRelay 任务页完成登录。" });
          return;
        }
        const deploymentId = decodeURIComponent(localPreviewViewRoute[1]);
        const entryPath = localPreviewStore.entryPath(deploymentId);
        const label = localPreviewStore.sourceLabel(deploymentId);
        if (!entryPath || !label) {
          sendText(response, 404, "text/plain; charset=utf-8", "这次手机预览已经失效，请返回任务后重新打开链接。");
          return;
        }
        const nonce = crypto.randomBytes(18).toString("base64");
        sendText(
          response,
          200,
          "text/html; charset=utf-8",
          createLocalPreviewViewerHtml({
            nonce,
            deploymentId,
            entryPath,
            sourceLabel: label,
          }),
          {
            "content-security-policy": localPreviewViewerContentSecurityPolicy(nonce),
            "referrer-policy": "no-referrer",
          },
        );
        return;
      }
      const localPreviewContentRoute = url.pathname.match(
        /^\/preview\/content\/([^/]+)\/(.+)$/,
      );
      if (method === "GET" && localPreviewContentRoute?.[1] && localPreviewContentRoute[2]) {
        if (!warmSessionFromRequest(request)) {
          sendJson(response, 401, { error: "请先返回 WeRelay 任务页完成登录。" });
          return;
        }
        const deploymentId = decodeURIComponent(localPreviewContentRoute[1]);
        const content = localPreviewStore.read(deploymentId, localPreviewContentRoute[2]);
        if (!content) {
          sendText(response, 404, "text/plain; charset=utf-8", "预览内容不存在或已经失效。");
          return;
        }
        response.writeHead(200, {
          "content-type": content.contentType,
          "content-length": String(content.body.length),
          "cache-control": content.cacheControl,
          "content-security-policy": content.contentSecurityPolicy,
          "content-disposition": "inline",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end(content.body);
        return;
      }
      if (method === "GET" && url.pathname === WERELAY_RELAY_CLIENT_IP_PATH) {
        sendText(response, 200, "text/plain; charset=utf-8", requestClientAddress(request));
        return;
      }
      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          ok: true,
          deviceOnline: Boolean(
            lastDeviceSeenAtMs && now() - lastDeviceSeenAtMs <= deviceOfflineMs,
          ),
        });
        return;
      }
      if (method === "GET" && url.pathname === "/b") {
        response.writeHead(302, {
          location: resolveCodexMobileBoardRedirect(url.searchParams),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end();
        return;
      }
      const rootTaskAlias = method === "GET"
        ? url.pathname.match(/^\/([A-Za-z0-9_-]{10})$/)?.[1]
        : undefined;
      if (rootTaskAlias) {
        const registered = taskLinks.resolve(rootTaskAlias);
        if (!registered) {
          sendJson(response, 404, { error: "短链接不存在或已失效。" });
          return;
        }
        const query = new URLSearchParams();
        query.set("task", registered.threadId);
        query.set("adapter", registered.adapter);
        query.set("appv", CODEX_MOBILE_ASSET_VERSION);
        for (const key of ["setup", "key"] as const) {
          const value = url.searchParams.get(key)?.trim();
          if (value) query.set(key, value);
        }
        response.writeHead(302, {
          location: `/?${query}`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end();
        return;
      }
      if (method === "GET" && url.pathname.startsWith("/t/")) {
        const alias = url.pathname.match(/^\/t\/([A-Za-z0-9_-]{10})$/)?.[1];
        const registered = alias ? taskLinks.resolve(alias) : null;
        const target = registered
          ? (() => {
              const query = new URLSearchParams();
              query.set("task", registered.threadId);
              query.set("adapter", registered.adapter);
              query.set("appv", CODEX_MOBILE_ASSET_VERSION);
              for (const key of ["setup", "key"] as const) {
                const value = url.searchParams.get(key)?.trim();
                if (value) query.set(key, value);
              }
              return `/?${query}`;
            })()
          : resolveCodexMobileTaskShortRedirect(url.pathname, url.searchParams);
        if (!target) {
          sendJson(response, 404, { error: "短链接不存在或已失效。" });
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

      if (method === "GET" && url.pathname === WERELAY_RELAY_CHECK_PATH) {
        validateDeviceRequest(request, deviceId, deviceToken);
        // Configuration probes must not claim the device is online or consume commands.
        sendJson(response, 200, { ok: true, protocolVersion: WERELAY_RELAY_PROTOCOL_VERSION });
        return;
      }

      if (method === "POST" && url.pathname === WERELAY_RELAY_TASK_LINK_REGISTER_PATH) {
        validateDeviceRequest(request, deviceId, deviceToken);
        const body = await readJson<{
          alias?: string;
          adapter?: string;
          threadId?: string;
        }>(request, 4_096);
        taskLinks.register(body.alias ?? "", {
          adapter: body.adapter ?? "",
          threadId: body.threadId ?? "",
        });
        lastDeviceSeenAtMs = now();
        sendJson(response, 200, { ok: true });
        return;
      }

      if (method === "POST" && url.pathname === WERELAY_RELAY_HEARTBEAT_PATH) {
        validateDeviceRequest(request, deviceId, deviceToken);
        await readBody(request, 4_096);
        lastDeviceSeenAtMs = now();
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }

      if (method === "POST" && url.pathname === WERELAY_RELAY_POLL_PATH) {
        validateDeviceRequest(request, deviceId, deviceToken);
        await readBody(request, 4_096);
        if (deviceSocket?.active()) throw new RelayHttpError(409, "设备已通过 WSS 连接，请关闭旧通道后重试。");
        lastDeviceSeenAtMs = now();
        if (deliverCommand(response)) {
          return;
        }
        if (waitingPoll) {
          clearTimeout(waitingPoll.timer);
          if (!waitingPoll.response.headersSent) {
            sendJson(waitingPoll.response, 409, { error: "设备已建立新的连接。" });
          }
          waitingPoll = null;
        }
        const timer = setTimeout(() => {
          if (waitingPoll?.response === response) {
            waitingPoll = null;
          }
          if (!response.headersSent) {
            response.writeHead(204, { "cache-control": "no-store" });
            response.end();
          }
        }, pollTimeoutMs);
        waitingPoll = { request, response, timer };
        response.once("close", () => {
          if (response.writableEnded || waitingPoll?.request !== request) {
            return;
          }
          clearTimeout(waitingPoll.timer);
          waitingPoll = null;
        });
        return;
      }

      if (method === "POST" && url.pathname === WERELAY_RELAY_RESPONSE_PATH) {
        validateDeviceRequest(request, deviceId, deviceToken);
        lastDeviceSeenAtMs = now();
        const commandResponse = await readJson<WeRelayRelayCommandResponse>(
          request,
          WERELAY_RELAY_RESPONSE_BODY_LIMIT * 2,
        );
        if (!isRelayCommandResponse(commandResponse)) throw new RelayHttpError(400, "设备响应格式不正确。");
        const ignored = !pendingCommands.has(commandResponse.commandId);
        completeCommand(commandResponse);
        sendJson(response, 200, { ok: true, ...(ignored ? { ignored: true } : {}) });
        return;
      }

      if (isWeRelayRelayApiRequest(method, url.pathname)) {
        try {
          const path = `${url.pathname}${url.search}`;
          if (isWarmCacheablePath(method, url)) {
            const warmSession = warmSessionFromRequest(request);
            // 设备预热缓存只对已登录的浏览器会话可见：未登录请求仍会走正常
            // 转发并在电脑端被拒绝，避免把任务内容暴露给匿名访问者。
            const browserEntry = warmSession?.entries.get(path);
            const deviceEntry = warmSession
              ? globalWarmSession.entries.get(path)
              : undefined;
            if (
              browserEntry?.updatedAtMs &&
              now() - browserEntry.updatedAtMs > warmCacheTtlMs
            ) {
              warmSession?.entries.delete(path);
            }
            if (
              deviceEntry?.updatedAtMs &&
              now() - deviceEntry.updatedAtMs > warmSnapshotRetentionMs
            ) {
              globalWarmSession.entries.delete(path);
              warmSnapshotStore?.save(globalSnapshotEntries());
            }
            const entry = warmSession?.entries.get(path) ??
              (warmSession ? globalWarmSession.entries.get(path) : undefined);
            if (warmSession && entry) {
              writeForwardedResponse(response, entry.response, {
                "x-werelay-cache": "warm",
                "x-werelay-cache-age": String(Math.max(0, now() - entry.updatedAtMs)),
              });
              if (
                now() - entry.updatedAtMs >= warmCacheFreshMs &&
                lastDeviceSeenAtMs && now() - lastDeviceSeenAtMs <= deviceOfflineMs
              ) {
                const currentDeviceEntry = globalWarmSession.entries.get(path);
                if (currentDeviceEntry === entry) {
                  void refreshWarmPath(globalWarmSession, path);
                } else {
                  void refreshWarmPath(warmSession, path);
                }
              }
              return;
            }
          }
          const rawCommandResponse = await enqueueBrowserRequest(request, url);
          const commandResponse = installLocalPreviewPackage(url, rawCommandResponse);
          recordBrowserResponse(request, url, commandResponse);
          writeForwardedResponse(response, commandResponse);
        } catch (error) {
          if (error instanceof RelayHttpError) {
            throw error;
          }
          throw new RelayHttpError(
            504,
            error instanceof Error ? error.message : "电脑响应超时，请稍后重试。",
          );
        }
        return;
      }

      throw new RelayHttpError(404, "页面不存在。");
    })().catch((error) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const statusCode = error instanceof RelayHttpError ? error.statusCode : 500;
      const message = error instanceof RelayHttpError
        ? error.message
        : "WeRelay Relay 暂时不可用。";
      logger(`${methodForLog(request)} 请求失败：${message}`);
      sendJson(response, statusCode, { error: message });
    });
  });

  liveBrowserSocket = new LiveWebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: LIVE_MAX_PAYLOAD,
  });

  const deviceSocket = attachRelayWebSocketServer({
    server,
    authenticate: (request) => validateDeviceRequest(request, deviceId, deviceToken),
    seen: () => { lastDeviceSeenAtMs = now(); },
    cancelPoll: () => {
      if (!waitingPoll) return;
      clearTimeout(waitingPoll.timer);
      if (!waitingPoll.response.headersSent) sendJson(waitingPoll.response, 409, { error: "设备已切换至 WSS。" });
      waitingPoll = null;
    },
    take: (exclude) => {
      const pending = nextCommand(exclude);
      if (!pending) return null;
      pending.leaseExpiresAtMs = now() + commandLeaseMs;
      return pending.command;
    },
    hasPending: (id) => pendingCommands.has(id),
    complete: completeCommand,
    heartbeatTimeoutMs: options.webSocketHeartbeatTimeoutMs ?? 45_000,
    handleOtherUpgrade: beginLiveUpgrade,
    onEvent: (event) => {
      if (event.kind === "conversation") {
        invalidateTaskWarmPaths(event.adapter, event.threadId);
        scheduleConversationChanged(event);
      } else {
        invalidateDevicePaths(
          [taskListPath(event.adapter), "/api/task-board"],
          (_path, url) =>
            (url.pathname === "/api/tasks" &&
              url.searchParams.get("adapter") === event.adapter) ||
            url.pathname === "/api/task-board",
        );
        scheduleTasksChanged(event.adapter);
      }
    },
  });

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("WeRelay Relay 无法取得监听端口。"));
        return;
      }
      resolve(address.port);
    });
  });

  return {
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    close: async () => {
      shuttingDown = true;
      queuedWarmRefreshes.length = 0;
      deviceSocket?.close();
      clearInterval(warmRefreshTimer);
      clearInterval(liveSweepTimer);
      liveBrowserSocket?.close();
      closeAllLive();
      liveConnections.clear();
      for (const pending of pendingLiveChanges.values()) {
        if (pending.timer) clearTimeout(pending.timer);
      }
      pendingLiveChanges.clear();
      for (const timer of pendingLiveTasksChanges.values()) clearTimeout(timer);
      pendingLiveTasksChanges.clear();
      warmSnapshotStore?.close();
      if (waitingPoll) {
        clearTimeout(waitingPoll.timer);
        if (!waitingPoll.response.headersSent) {
          waitingPoll.response.writeHead(204, { "cache-control": "no-store" });
          waitingPoll.response.end();
        }
        waitingPoll = null;
      }
      for (const pending of pendingCommands.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("WeRelay Relay 已停止。"));
      }
      pendingCommands.clear();
      for (const socket of activeSockets) {
        socket.destroy();
      }
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(fallbackTimer);
          resolve();
        };
        const fallbackTimer = setTimeout(finish, 500);
        server.close(finish);
      });
    },
  };
}

function methodForLog(request: IncomingMessage): string {
  return request.method ?? "GET";
}

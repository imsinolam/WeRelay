import crypto from "node:crypto";
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import {
  createImmutableTextAsset,
  sendImmutableTextAsset,
} from "../utils/http-static-asset.ts";

import {
  CODEX_MOBILE_ASSET_VERSION,
  resolveCodexMobileTaskShortRedirect,
} from "../daemon/codex-mobile-server.ts";
import {
  CODEX_MOBILE_CSS,
  CODEX_MOBILE_HTML,
  CODEX_MOBILE_JS,
  WE_RELAY_ABOUT_HTML,
} from "../daemon/codex-mobile-web.ts";
import {
  createWeRelayRelayCommandId,
  WERELAY_RELAY_CLIENT_IP_PATH,
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
const MOBILE_ASSET_SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data: http: https:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const DEFAULT_POLL_TIMEOUT_MS = 25_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 90_000;
const DEFAULT_COMMAND_LEASE_MS = 35_000;
const DEFAULT_DEVICE_OFFLINE_MS = 45_000;
const DEFAULT_WARM_REFRESH_INTERVAL_MS = 8_000;
const DEFAULT_WARM_CACHE_FRESH_MS = 5_000;
const DEFAULT_WARM_CACHE_TTL_MS = 30 * 60_000;
const DEFAULT_WARM_FAILURE_RETRY_MS = 60_000;
const MAX_WARM_SESSIONS = 4;
const MAX_WARM_PATHS_PER_SESSION = 24;
const MAX_WARM_PENDING_COMMANDS = 4;
const MAX_WARM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_WARM_SESSION_BYTES = 12 * 1024 * 1024;
const GLOBAL_WARM_SESSION_KEY = "__device_warm_cache__";
const MAX_PENDING_COMMANDS = 64;

export type StartWeRelayRelayServerOptions = {
  host?: string;
  port?: number;
  deviceId: string;
  deviceToken: string;
  pollTimeoutMs?: number;
  commandTimeoutMs?: number;
  commandLeaseMs?: number;
  deviceOfflineMs?: number;
  warmRefreshIntervalMs?: number;
  warmCacheFreshMs?: number;
  warmCacheTtlMs?: number;
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

type WarmSession = {
  key: string;
  cookieHeader: string;
  expiresAtMs: number;
  activeAdapter: string;
  paths: string[];
  entries: Map<string, WarmCacheEntry>;
  refreshing: Set<string>;
  refreshCursor: number;
  touchedAtMs: number;
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
  const warmRefreshIntervalMs = Math.max(
    10,
    options.warmRefreshIntervalMs ?? DEFAULT_WARM_REFRESH_INTERVAL_MS,
  );
  const warmCacheFreshMs = Math.max(
    0,
    options.warmCacheFreshMs ?? DEFAULT_WARM_CACHE_FRESH_MS,
  );
  const warmCacheTtlMs = Math.max(
    warmCacheFreshMs,
    options.warmCacheTtlMs ?? DEFAULT_WARM_CACHE_TTL_MS,
  );
  const logger = options.logger ?? (() => undefined);
  const taskLinks = new WeRelayRelayTaskLinkStore({
    deviceToken,
    ...(options.taskLinkStateFile
      ? { stateFile: options.taskLinkStateFile }
      : {}),
  });
  const pendingCommands = new Map<string, PendingCommand>();
  const commandOrder: string[] = [];
  const warmSessions = new Map<string, WarmSession>();
  const warmSessionOrder: string[] = [];
  let waitingPoll: WaitingPoll | null = null;
  let lastDeviceSeenAtMs = 0;
  let globalWarmRetryAtMs = 0;

  const cleanCommandOrder = () => {
    while (commandOrder.length > 0 && !pendingCommands.has(commandOrder[0] ?? "")) {
      commandOrder.shift();
    }
  };

  const nextCommand = (): PendingCommand | null => {
    cleanCommandOrder();
    const currentMs = now();
    for (const commandId of commandOrder) {
      const pending = pendingCommands.get(commandId);
      if (!pending) {
        continue;
      }
      if (pending.command.expiresAtMs <= currentMs) {
        clearTimeout(pending.timer);
        pendingCommands.delete(commandId);
        pending.reject(new Error("电脑响应超时，请稍后重试。"));
        continue;
      }
      if (pending.leaseExpiresAtMs <= currentMs) {
        return pending;
      }
    }
    cleanCommandOrder();
    return null;
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

  const deleteWarmSession = (key: string) => {
    warmSessions.delete(key);
    const index = warmSessionOrder.indexOf(key);
    if (index >= 0) warmSessionOrder.splice(index, 1);
  };

  const touchWarmSession = (session: WarmSession) => {
    session.touchedAtMs = now();
    if (session.key === GLOBAL_WARM_SESSION_KEY) return;
    const index = warmSessionOrder.indexOf(session.key);
    if (index >= 0) warmSessionOrder.splice(index, 1);
    warmSessionOrder.push(session.key);
    while (warmSessionOrder.length > MAX_WARM_SESSIONS) {
      const removed = warmSessionOrder.shift();
      if (removed) warmSessions.delete(removed);
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
    while (session.paths.length > MAX_WARM_PATHS_PER_SESSION) {
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
      activeAdapter: "",
      paths: [],
      entries: new Map(),
      refreshing: new Set(),
      refreshCursor: 0,
      touchedAtMs: now(),
    };
    for (const path of [
      "/api/auth/status",
      "/api/adapters",
      "/api/task-board",
      "/api/tasks",
    ]) addWarmPath(session, path);
    warmSessions.set(key, session);
    touchWarmSession(session);
    return session;
  };

  const globalWarmSession: WarmSession = {
    key: GLOBAL_WARM_SESSION_KEY,
    cookieHeader: "",
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    activeAdapter: "",
    paths: [],
    entries: new Map(),
    refreshing: new Set(),
    refreshCursor: 0,
    touchedAtMs: now(),
  };
  for (const path of ["/api/adapters", "/api/task-board", "/api/tasks"]) {
    addWarmPath(globalWarmSession, path);
  }

  const warmSessionFromRequest = (request: IncomingMessage): WarmSession | null => {
    const token = readCookieValue(request.headers.cookie, "codex_mobile_session");
    if (!token) return null;
    const key = warmSessionKey(token);
    const session = warmSessions.get(key) ?? null;
    if (!session) return null;
    if (session.expiresAtMs <= now() || now() - session.touchedAtMs > warmCacheTtlMs) {
      deleteWarmSession(key);
      return null;
    }
    if (session.key === GLOBAL_WARM_SESSION_KEY) session.touchedAtMs = now();
    else touchWarmSession(session);
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
    const url = new URL(path, "http://werelay-relay.local");
    if (url.pathname === "/api/adapters" && typeof record.activeAdapter === "string") {
      session.activeAdapter = record.activeAdapter;
      addWarmPath(
        session,
        `/api/tasks?adapter=${encodeURIComponent(record.activeAdapter)}`,
      );
    }
    const isTaskList = url.pathname === "/api/tasks";
    const isTaskBoard = url.pathname === "/api/task-board";
    if ((!isTaskList && !isTaskBoard) || !Array.isArray(record.tasks)) return;
    const fallbackAdapter = url.searchParams.get("adapter")?.trim() || session.activeAdapter;
    for (const task of record.tasks.slice(0, 5)) {
      if (!task || typeof task !== "object" || Array.isArray(task)) continue;
      const taskRecord = task as Record<string, unknown>;
      const threadId = taskRecord.threadId;
      const adapter = isTaskBoard && typeof taskRecord.adapter === "string"
        ? taskRecord.adapter.trim()
        : fallbackAdapter;
      if (typeof threadId !== "string" || !threadId || !adapter) continue;
      addWarmPath(session, `/api/tasks?adapter=${encodeURIComponent(adapter)}`);
      const base = `/api/tasks/${encodeURIComponent(threadId)}/messages`;
      addWarmPath(
        session,
        `${base}?limit=40&history=1&adapter=${encodeURIComponent(adapter)}`,
      );
      addWarmPath(
        session,
        `${base}?limit=5&adapter=${encodeURIComponent(adapter)}`,
      );
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
    let totalBytes = [...session.entries.values()].reduce(
      (total, entry) => total + entry.sizeBytes,
      0,
    );
    while (totalBytes > MAX_WARM_SESSION_BYTES && session.entries.size > 1) {
      const oldest = [...session.entries.entries()].sort(
        (left, right) => left[1].updatedAtMs - right[1].updatedAtMs,
      )[0];
      if (!oldest) break;
      session.entries.delete(oldest[0]);
      totalBytes -= oldest[1].sizeBytes;
    }
    learnWarmPaths(session, path, response);
    touchWarmSession(session);
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
    for (const warmSession of warmSessions.values()) {
      warmSession.entries.clear();
      warmSession.refreshCursor = 0;
    }
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
    }
    if (session && request.method === "GET" && isWarmCacheablePath("GET", url)) {
      storeWarmResponse(session, path, commandResponse);
    }
    if (request.method !== "GET" && commandResponse.statusCode < 400) {
      invalidateWarmResponses();
    }
  };

  const refreshWarmPath = async (session: WarmSession, path: string) => {
    if (
      session.refreshing.has(path) ||
      session.expiresAtMs <= now() ||
      pendingCommands.size >= MAX_WARM_PENDING_COMMANDS ||
      (session.key === GLOBAL_WARM_SESSION_KEY && now() < globalWarmRetryAtMs)
    ) return;
    session.refreshing.add(path);
    try {
      const response = await enqueueRelayRequest({
        method: "GET",
        path,
        headers: session.key === GLOBAL_WARM_SESSION_KEY
          ? { "x-werelay-prewarm": "1" }
          : { cookie: session.cookieHeader },
        clientAddress: "relay-cache",
        forwardedProto: "https",
      });
      if (response.statusCode === 401 || response.statusCode === 403) {
        if (session.key === GLOBAL_WARM_SESSION_KEY) {
          session.entries.clear();
          session.refreshCursor = 0;
          session.touchedAtMs = now();
          globalWarmRetryAtMs = now() + DEFAULT_WARM_FAILURE_RETRY_MS;
        } else {
          deleteWarmSession(session.key);
        }
        return;
      }
      const pathname = new URL(path, "http://werelay-relay.local").pathname;
      if (pathname === "/api/auth/status" && !responseAuthenticatesSession(path, response)) {
        deleteWarmSession(session.key);
        return;
      }
      if (responseAuthenticatesSession(path, response) ||
          !pathname.startsWith("/api/auth/")) {
        if (session.key === GLOBAL_WARM_SESSION_KEY) globalWarmRetryAtMs = 0;
        storeWarmResponse(session, path, response);
      }
    } catch {
      // Warm refresh failures stay silent; the last verified snapshot remains usable.
    } finally {
      session.refreshing.delete(path);
    }
  };

  const scheduleWarmRefresh = () => {
    if (!lastDeviceSeenAtMs || now() - lastDeviceSeenAtMs > deviceOfflineMs) return;
    for (const session of [globalWarmSession, ...warmSessions.values()]) {
      if (
        session.key !== GLOBAL_WARM_SESSION_KEY &&
        (session.expiresAtMs <= now() || now() - session.touchedAtMs > warmCacheTtlMs)
      ) {
        deleteWarmSession(session.key);
        continue;
      }
      if (
        !session.paths.length ||
        (session.key === GLOBAL_WARM_SESSION_KEY && now() < globalWarmRetryAtMs)
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

  const warmRefreshTimer = setInterval(scheduleWarmRefresh, warmRefreshIntervalMs);
  warmRefreshTimer.unref?.();

  const activeSockets = new Set<import("node:net").Socket>();
  const server: Server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://werelay-relay.local");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/") {
        sendText(response, 200, "text/html; charset=utf-8", MOBILE_HTML);
        return;
      }
      if (method === "GET" && url.pathname === "/about") {
        sendText(response, 200, "text/html; charset=utf-8", ABOUT_HTML);
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
      if (method === "GET" && url.pathname === "/app-version") {
        sendJson(response, 200, { version: CODEX_MOBILE_ASSET_VERSION });
        return;
      }
      if (method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
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

      if (method === "POST" && url.pathname === WERELAY_RELAY_POLL_PATH) {
        validateDeviceRequest(request, deviceId, deviceToken);
        await readBody(request, 4_096);
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
        scheduleWarmRefresh();
        return;
      }

      if (method === "POST" && url.pathname === WERELAY_RELAY_RESPONSE_PATH) {
        validateDeviceRequest(request, deviceId, deviceToken);
        lastDeviceSeenAtMs = now();
        const commandResponse = await readJson<WeRelayRelayCommandResponse>(
          request,
          WERELAY_RELAY_RESPONSE_BODY_LIMIT * 2,
        );
        if (!isRelayCommandResponse(commandResponse)) {
          throw new RelayHttpError(400, "设备响应格式不正确。");
        }
        const pending = pendingCommands.get(commandResponse.commandId);
        if (!pending) {
          sendJson(response, 200, { ok: true, ignored: true });
          return;
        }
        clearTimeout(pending.timer);
        pendingCommands.delete(commandResponse.commandId);
        pending.resolve(commandResponse);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (isWeRelayRelayApiRequest(method, url.pathname)) {
        try {
          const path = `${url.pathname}${url.search}`;
          if (isWarmCacheablePath(method, url)) {
            const warmSession = warmSessionFromRequest(request);
            const entry = warmSession?.entries.get(path) ??
              (warmSession ? globalWarmSession.entries.get(path) : undefined);
            if (warmSession && entry && now() - entry.updatedAtMs <= warmCacheTtlMs) {
              writeForwardedResponse(response, entry.response, {
                "x-werelay-cache": "warm",
                "x-werelay-cache-age": String(Math.max(0, now() - entry.updatedAtMs)),
              });
              if (
                now() - entry.updatedAtMs >= warmCacheFreshMs &&
                lastDeviceSeenAtMs && now() - lastDeviceSeenAtMs <= deviceOfflineMs
              ) void refreshWarmPath(warmSession, path);
              return;
            }
          }
          const commandResponse = await enqueueBrowserRequest(request, url);
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
      clearInterval(warmRefreshTimer);
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

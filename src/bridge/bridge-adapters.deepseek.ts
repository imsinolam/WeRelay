import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterState,
  BridgeEvent,
  BridgeResumeSessionCandidate,
  BridgeSessionMessage,
  BridgeSessionMessagePage,
  BridgeSessionMessagePageOptions,
  BridgeSessionModelState,
  BridgeSessionPermissionOption,
  BridgeSessionPermissionState,
  BridgeSessionProgressItem,
  BridgeSessionRunSummary,
  BridgeSessionSendResult,
  BridgeTurnInputItem,
  UserInputRequest,
} from "./bridge-types.ts";
import type { AdapterOptions, EventSink } from "./bridge-adapters.shared.ts";
import { nowIso, truncatePreview } from "./bridge-utils.ts";
import { DeepSeekHarnessRemoteMux } from "./deepseek-harness-remote.ts";
import { recoverDeepSeekDesktopHarnessAccess } from "./deepseek-desktop-lifecycle.ts";
import {
  classifyDeepSeekHarnessProbe,
  deepSeekHarnessEndpoint,
  type DeepSeekHarnessCapability,
  resolveDeepSeekHarnessCookieHeader,
  typertSessionAddress,
  wrapTypertPayload,
  type DeepSeekHarnessDialect,
} from "./deepseek-harness-protocol.ts";

const DEFAULT_DEEPSEEK_HARNESS_URL = "http://127.0.0.1:3080";
/**
 * DSH Desktop's documented loopback web port (`DESKTOP_DEFAULT_WEB_PORT`).
 * A Desktop process also owns helper IPC sockets, so discovery prefers this
 * port over whichever listener `lsof` happens to report first.
 */
const DESKTOP_DEFAULT_WEB_PORT = 43120;
const DESKTOP_APP_PATH = "/Applications/DSH Desktop.app";
const DEEPSEEK_HARNESS_URL_ENV = "WERELAY_DEEPSEEK_HARNESS_URL";
const DEEPSEEK_HARNESS_HTTP_TIMEOUT_MS = 10_000;
const DEEPSEEK_HARNESS_RECONNECT_MS = 1_000;
const DEEPSEEK_HARNESS_RECOVERY_INTERVAL_MS = 2_000;
const DEEPSEEK_HARNESS_RECOVERY_MAX_MS = 30 * 60_000;
const DEEPSEEK_HARNESS_DISCONNECT_RENOTIFY_MS = 10 * 60_000;
const DEEPSEEK_HARNESS_DISCONNECT_NOTICE_DEBOUNCE_MS = 5_000;
const DEEPSEEK_HARNESS_RECOVERY_STABLE_MS = 5_000;
const DEEPSEEK_HISTORY_LIMIT = 100;
const DEEPSEEK_DESKTOP_RECOVERY_TIMEOUT_MS = 20_000;
/**
 * Bounded in-place retry for transient connect failures (a Desktop restart, a
 * refused connection). Kept short and side-effect free: it must never restart
 * the Desktop, and it must not make a user-visible switch hang.
 */
const DEEPSEEK_TRANSIENT_CONNECT_RETRY_ATTEMPTS = 4;
const DEEPSEEK_TRANSIENT_CONNECT_RETRY_INTERVAL_MS = 1_500;
/**
 * Discovery attempts before accepting the documented default endpoint. A
 * Desktop that is starting up briefly has no listener; treating that as "use
 * the default port" pins a dead address for the client's whole lifetime.
 */
const DEEPSEEK_ENDPOINT_DISCOVERY_ATTEMPTS = 5;
const DEEPSEEK_ENDPOINT_DISCOVERY_INTERVAL_MS = 400;
const DEEPSEEK_DESKTOP_RECOVERY_POLL_MS = 250;

type UnknownRecord = Record<string, unknown>;

const DEEPSEEK_PERMISSION_LABELS: Record<string, string> = {
  "read-only": "只读",
  "workspace-write": "项目内读写",
  "danger-full-access": "完全访问",
  custom: "自定义权限",
};

export type DeepSeekHarnessSessionEvent = {
  type: string;
  seq: number;
  time: number;
  data: unknown;
};

export type DeepSeekHarnessHistoryEntry = {
  event: DeepSeekHarnessSessionEvent;
  view?: unknown;
};

export type DeepSeekHarnessSessionSummary = {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: "subagent";
  cwd?: string;
  agentPreset?: string;
  projections?: {
    asOfSeq?: number;
    values?: Record<string, unknown>;
  };
};

export type DeepSeekHarnessModelSelection = {
  provider: string;
  model: string;
  reasoningEffort?: string;
};

export type DeepSeekHarnessModelState = {
  // 部分 Harness 会话（例如尚未选择模型，或目录只返回 provider 列表时）
  // 不会带回 current；读取方必须自行兜底，不能假定它一定存在。
  current?: DeepSeekHarnessModelSelection;
  routable: boolean;
  groups: Array<{
    id: string;
    name: string;
    models: Array<{
      id: string;
      name: string;
      description?: string;
    }>;
  }>;
  failures: Array<{ id: string; name: string; message: string }>;
};

export type DeepSeekHarnessPromptContent =
  | { type: "text"; text: string }
  | {
      type: "image";
      mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      data: string;
      name?: string;
    };

type DeepSeekHarnessImageMediaType = Extract<
  DeepSeekHarnessPromptContent,
  { type: "image" }
>["mediaType"];

export type DeepSeekHarnessMuxFrame =
  | { type: "stream/ready" }
  | {
      type: "session/event";
      sessionId: string;
      event: DeepSeekHarnessSessionEvent;
      view?: unknown;
    }
  | { type: "session/subscribed"; sessionId: string; lastSeq: number }
  | {
      type: "approval/requested";
      sessionId: string;
      approvalId: string;
      toolName: string;
      callId?: string;
      reason?: string;
    }
  | {
      type: "approval/resolved";
      sessionId: string;
      approvalId: string;
      outcome: "allowed-once" | "rejected" | "cancelled" | "unavailable";
    }
  | {
      type: "question/requested";
      sessionId: string;
      questions: DeepSeekHarnessQuestion[];
    }
  | {
      type: "question/resolved";
      sessionId: string;
      questionRpcId: string;
      outcome: "answered" | "cancelled";
    }
  | {
      type: "session/queue";
      sessionId: string;
      items: unknown[];
    }
  | {
      type: "session/projection";
      sessionId: string;
      key: string;
      value: unknown;
      seq: number;
    }
  | { type: "stream/error"; error: unknown };

export type DeepSeekHarnessEnvelope = {
  rpcId: string;
  payload: DeepSeekHarnessMuxFrame;
};

export type DeepSeekHarnessQuestion = {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  intent?: { kind: "plan-review"; approve: string };
};

export type DeepSeekHarnessClientResponse = {
  type: "client-response";
  rpcId: string;
  result:
    | { ok: true; value: unknown }
    | {
        ok: false;
        error: { code: string; message: string; details: Record<string, unknown> };
      };
};

export interface DeepSeekHarnessClientLike {
  describeHost(): Promise<{
    version: string;
    cwd: string;
    provider: string;
    model: string;
    attachedSessions: number;
    canOpenPath: boolean;
  }>;
  listSessions(): Promise<DeepSeekHarnessSessionSummary[]>;
  createSession(cwd: string): Promise<{ sessionId: string }>;
  renameSession(sessionId: string, title: string): Promise<void>;
  readHistory(
    sessionId: string,
    options?: { beforeSeq?: number; maxMessages?: number },
  ): Promise<{
    events: DeepSeekHarnessHistoryEntry[];
    hasMore: boolean;
    projections?: { asOfSeq?: number; values?: Record<string, unknown> };
  }>;
  readModels(sessionId: string): Promise<DeepSeekHarnessModelState>;
  selectModel(
    sessionId: string,
    selection: DeepSeekHarnessModelSelection,
  ): Promise<{ selected: DeepSeekHarnessModelSelection }>;
  prompt(
    sessionId: string,
    content: DeepSeekHarnessPromptContent[],
    requestId?: string,
  ): Promise<{ rpcId: string; value: { accepted: true } }>;
  cancelSession(sessionId: string): Promise<{ accepted: true }>;
  respond(message: DeepSeekHarnessClientResponse): Promise<{
    accepted: boolean;
    reason?: string;
  }>;
  openMux(signal?: AbortSignal): AsyncIterable<DeepSeekHarnessEnvelope>;
}

export type DeepSeekHarnessAdapterDependencies = {
  createClient(baseUrl: string): DeepSeekHarnessClientLike;
  resolveBaseUrl?(): string;
  resolveRecoveredBaseUrl?(): string | null;
  recoverDesktopAccess?(error: unknown): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
};

type ResolvedDeepSeekHarnessAdapterDependencies = {
  createClient(baseUrl: string): DeepSeekHarnessClientLike;
  resolveBaseUrl(): string;
  resolveRecoveredBaseUrl(): string | null;
  recoverDesktopAccess(error: unknown): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
};

type DeepSeekRpcEnvelope = {
  type: "server-response";
  rpcId: string;
  result:
    | { ok: true; value?: unknown }
    | { ok: false; error?: unknown };
};

type PendingHarnessApproval = {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  request: ApprovalRequest;
};

type PendingHarnessQuestion = {
  rpcId: string;
  sessionId: string;
  questions: DeepSeekHarnessQuestion[];
  request: UserInputRequest;
};

type HarnessTurnOrigin = "wechat" | "local";

/**
 * Whether a connect failure is a transient transport problem worth retrying.
 *
 * Node surfaces these as `fetch failed` with the real reason in `cause`, so the
 * whole chain is inspected. Semantic failures (a missing session, an invalid
 * argument) are deliberately excluded: retrying them only delays the error.
 */
function isTransientDeepSeekConnectError(error: unknown): boolean {
  const seen: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    seen.push(`${current.message}${typeof code === "string" ? ` ${code}` : ""}`);
    current = (current as { cause?: unknown }).cause;
  }
  const text = seen.join(" ");
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|timed?\s*out|timeout|WebSocket.*(?:失败|closed|error)|aborted/iu.test(
    text,
  );
}

/** Summarize a failed Harness connection for logs: endpoint plus cause chain. */
function describeDeepSeekConnectFailure(baseUrl: string, error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    parts.push(`${current.name}: ${current.message}${typeof code === "string" ? ` [${code}]` : ""}`);
    current = (current as { cause?: unknown }).cause;
  }
  const detail = parts.join(" <- ");
  return ` [endpoint=${baseUrl || "(unresolved)"}${detail ? `; ${detail}` : ""}]`;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function describeRpcError(error: unknown): string {
  if (!isRecord(error)) return String(error ?? "unknown error");
  const message = readString(error.message);
  const code = readString(error.code);
  return [code, message].filter(Boolean).join(": ") || "unknown error";
}

function deepSeekHarnessFailureMessage(reason: UnknownRecord | null): string | undefined {
  if (!reason) return undefined;
  const nested = isRecord(reason.error)
    ? reason.error
    : isRecord(reason.failure)
      ? reason.failure
      : null;
  const code = readString(nested?.code) ?? readString(reason.code);
  const message = readString(nested?.message) ?? readString(reason.message);
  if (code === "EMPTY_RESPONSE" || message?.includes("completed response with no content")) {
    const model = message?.match(/model\s+["']([^"']+)["']/i)?.[1];
    if (model === "stealth/ox-alpha") {
      return "OpenRouter 的 ox-alpha 模型返回了空响应，请切换到其他模型后重试。";
    }
    return model
      ? `模型 ${model} 返回了空响应，请切换到其他模型后重试。`
      : "当前模型返回了空响应，请切换到其他模型后重试。";
  }
  return message;
}

function waitForAbortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "::1" ||
    normalized === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function normalizeDeepSeekHarnessBaseUrl(
  value = process.env[DEEPSEEK_HARNESS_URL_ENV],
): string {
  const raw = value?.trim() || DEFAULT_DEEPSEEK_HARNESS_URL;
  const url = new URL(raw);
  if (url.username || url.password) {
    throw new Error("DeepSeek Harness URL must not contain credentials.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("DeepSeek Harness URL must use HTTP or HTTPS.");
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error("DeepSeek Harness URL must use a loopback host.");
  }
  if (url.search || url.hash) {
    throw new Error("DeepSeek Harness URL must not contain a query or fragment.");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname) {
    throw new Error("DeepSeek Harness URL must not contain an application path.");
  }
  return `${url.protocol}//${url.host}`;
}

type DeepSeekHarnessEndpointDiscovery = {
  platform?: NodeJS.Platform;
  readProcessList?: () => string;
  readListeners?: (pid: number) => string;
  readPortListeners?: () => string;
  /** Override for tests: whether the DSH Desktop bundle is installed. */
  appInstalled?: () => boolean;
};

/** List every loopback TCP listener with its owning process name. */
function readDeepSeekDesktopPortListeners(): string {
  try {
    return execFileSync(
      "/usr/sbin/lsof",
      ["-nP", "-iTCP", "-sTCP:LISTEN"],
      {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return "";
  }
}

function readDeepSeekDesktopProcessList(): string {
  try {
    return execFileSync("/bin/ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function readDeepSeekDesktopListeners(pid: number): string {
  try {
    return execFileSync(
      "/usr/sbin/lsof",
      ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
      {
        encoding: "utf8",
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return "";
  }
}

export function discoverDeepSeekDesktopHarnessBaseUrl(
  discovery: DeepSeekHarnessEndpointDiscovery = {},
): string | null {
  if ((discovery.platform ?? process.platform) !== "darwin") {
    return null;
  }
  const processList = (discovery.readProcessList ?? readDeepSeekDesktopProcessList)();
  // DSH Desktop 2.0.9 serves its loopback API from a Helper child process, so
  // discovery must accept both the main executable and its Helper, and read
  // listeners by port rather than assuming the parent owns the socket.
  const desktopPids = processList.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match?.[1] || !match[2]) return [];
    const command = match[2].trim();
    const isDesktop = command ===
      "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop" ||
      command.startsWith(
        "/Applications/DSH Desktop.app/Contents/Frameworks/DSH Desktop Helper.app/Contents/MacOS/",
      );
    return isDesktop ? [Number(match[1])] : [];
  }).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const readListeners = discovery.readListeners ?? readDeepSeekDesktopListeners;
  const readPortListeners = discovery.readPortListeners ?? readDeepSeekDesktopPortListeners;
  const ownedPorts: number[] = [];
  for (const pid of desktopPids) {
    const listenerOutput = readListeners(pid);
    for (const line of listenerOutput.split(/\r?\n/)) {
      const match = line.match(/^n(?:127(?:\.\d{1,3}){3}|\[?::1\]?):([1-9]\d{0,4})$/u);
      const port = match?.[1] ? Number(match[1]) : 0;
      if (port > 0 && port <= 65_535) ownedPorts.push(port);
    }
  }
  // A DSH Desktop process owns several loopback sockets (helper IPC, caches),
  // so prefer its documented web port before accepting any other listener.
  if (ownedPorts.includes(DESKTOP_DEFAULT_WEB_PORT)) {
    return `http://127.0.0.1:${DESKTOP_DEFAULT_WEB_PORT}`;
  }
  if (ownedPorts.length > 0) {
    return `http://127.0.0.1:${ownedPorts[0]}`;
  }
  // Only scan system listeners when a Desktop process was actually found;
  // otherwise the caller must fall through to the `dsh web` default.
  if (desktopPids.length === 0) {
    return null;
  }
  // Fall back to scanning loopback listeners for the DSH Desktop process
  // names, which also covers Helper-owned sockets that `lsof -p` misses.
  // `lsof` may wrap a long record across lines, so track the owning command
  // and match its loopback port on whichever line carries it.
  const portOutput = readPortListeners();
  let scanningDshRecord = false;
  const fallbackPorts: number[] = [];
  for (const line of portOutput.split(/\r?\n/)) {
    if (/^\S/u.test(line)) {
      scanningDshRecord = /^DSH\\x20De\b|^DSH\s*Desktop\b/u.test(line);
      if (!scanningDshRecord) continue;
    }
    if (!scanningDshRecord) continue;
    const match = line.match(/(?:127(?:\.\d{1,3}){3}|\[?::1\]?):([1-9]\d{0,4})\s*\(LISTEN\)/u);
    const port = match?.[1] ? Number(match[1]) : 0;
    if (port > 0 && port <= 65_535) fallbackPorts.push(port);
  }
  if (fallbackPorts.includes(DESKTOP_DEFAULT_WEB_PORT)) {
    return `http://127.0.0.1:${DESKTOP_DEFAULT_WEB_PORT}`;
  }
  if (fallbackPorts.length > 0) {
    return `http://127.0.0.1:${fallbackPorts[0]}`;
  }
  return null;
}

/**
 * Resolve the Harness endpoint.
 *
 * DSH Desktop and the `dsh web` CLI are different products on different
 * ports: the Desktop serves 43120 and the CLI serves 3080. Discovery finds the
 * Desktop; the documented default only fits the CLI. When the Desktop app is
 * installed but its port cannot be discovered yet (it may still be starting),
 * prefer the Desktop port over the CLI default so the client does not bind a
 * port that nothing is serving.
 */
export function resolveDeepSeekHarnessBaseUrl(
  value = process.env[DEEPSEEK_HARNESS_URL_ENV],
  discovery: DeepSeekHarnessEndpointDiscovery = {},
): string {
  if (value?.trim()) {
    return normalizeDeepSeekHarnessBaseUrl(value);
  }
  const discovered = discoverDeepSeekDesktopHarnessBaseUrl(discovery);
  if (discovered) return discovered;
  return (discovery.appInstalled ?? deepSeekDesktopAppInstalled)()
    ? `http://127.0.0.1:${DESKTOP_DEFAULT_WEB_PORT}`
    : DEFAULT_DEEPSEEK_HARNESS_URL;
}

/** Whether the DSH Desktop application bundle is present on this machine. */
function deepSeekDesktopAppInstalled(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    return fs.existsSync(DESKTOP_APP_PATH);
  } catch {
    return false;
  }
}

export class DeepSeekHarnessHttpClient implements DeepSeekHarnessClientLike {
  /** Detected once per client; Typert is DSH Desktop 2.0.9+. */
  private dialect: DeepSeekHarnessDialect = "legacy";
  private dialectProbe: Promise<DeepSeekHarnessDialect> | null = null;
  /** True once a probe produced a definitive answer worth caching. */
  private dialectConfirmed = false;
  /**
   * Cached cookie header. DSH Desktop mints a new browser-session credential
   * each time it starts, so a cookie computed at construction time goes stale
   * as soon as the Desktop restarts. It is refreshed on demand instead of
   * being fixed for the client's lifetime.
   */
  private cookieHeader: string | null;
  // Keep bulk follow snapshots off the long-lived approval/event carrier.
  // A history timeout, oversized frame or reconnect must not disconnect $events.
  private remoteMux: DeepSeekHarnessRemoteMux | null = null;
  private eventMux: DeepSeekHarnessRemoteMux | null = null;
  private readonly remoteEvents = new Map<string, { clientId: string; sessionId: string; kind: "approval" | "question" }>();

  private getRemoteMux(): DeepSeekHarnessRemoteMux {
    this.remoteMux ??= new DeepSeekHarnessRemoteMux(this.baseUrl, () => {
      this.refreshCookieHeader();
      return this.cookieHeader;
    }, this.requestTimeoutMs);
    return this.remoteMux;
  }

  private getEventMux(): DeepSeekHarnessRemoteMux {
    this.eventMux ??= new DeepSeekHarnessRemoteMux(this.baseUrl, () => {
      this.refreshCookieHeader();
      return this.cookieHeader;
    }, this.requestTimeoutMs);
    return this.eventMux;
  }

  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly requestTimeoutMs = DEEPSEEK_HARNESS_HTTP_TIMEOUT_MS,
    cookieHeader?: string | null,
    private readonly resolveCookieHeader: (
      baseUrl: string,
    ) => string | null = resolveDeepSeekHarnessCookieHeader,
  ) {
    this.cookieHeader = cookieHeader === undefined
      ? resolveDeepSeekHarnessCookieHeader(baseUrl)
      : cookieHeader;
  }

  /**
   * DSH Desktop 2.0.9 requires the signed browser-session cookie on every
   * loopback request. Legacy builds have no credential store and simply
   * ignore the header, so sending it is always safe.
   */
  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return this.cookieHeader ? { ...extra, cookie: this.cookieHeader } : extra;
  }

  /**
   * Re-read the Harness credential store and mint a fresh cookie. The Desktop
   * issues a new secret on every start, so a 401/403 means the cached cookie
   * belongs to a previous generation.
   */
  private refreshCookieHeader(): boolean {
    const refreshed = this.resolveCookieHeader(this.baseUrl);
    if (!refreshed || refreshed === this.cookieHeader) return false;
    this.cookieHeader = refreshed;
    // The auth generation changed, so any dialect verdict belongs to the
    // previous generation as well.
    this.dialectConfirmed = false;
    this.dialectProbe = null;
    return true;
  }

  /**
   * Decide which RPC dialect this host speaks by probing the slash-form
   * endpoint. A Typert host answers with a gateway envelope (or 401 without a
   * cookie), while a legacy host reports the route as not found.
   *
   * Only a definitive answer is cached. A transport failure (the Desktop
   * restarting, a timeout, a refused connection) must not be remembered as
   * `legacy`: that would pin the client to the wrong dialect for the rest of
   * its lifetime, so every later call would 404 even after the host returns.
   */
  private async resolveDialect(): Promise<DeepSeekHarnessDialect> {
    if (this.dialectProbe) return await this.dialectProbe;
    const probe = (async () => {
      try {
        const response = await this.fetchFn(
          new URL("/api/session/list", this.baseUrl),
          {
            method: "POST",
            headers: this.authHeaders({ "content-type": "application/json" }),
            body: JSON.stringify({
              type: "client-request",
              rpcId: crypto.randomUUID(),
              method: "session/list",
              payload: { args: { _request: {} } },
            }),
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          },
        );
        const text = await response.text();
        const detected = classifyDeepSeekHarnessProbe({
          status: response.status,
          body: text,
        });
        if (detected) {
          this.dialect = detected;
          this.dialectConfirmed = true;
          return detected;
        }
      } catch {
        // Inconclusive: fall through and leave the probe uncached.
      }
      return this.dialect;
    })();
    this.dialectProbe = probe;
    const resolved = await probe;
    // Drop an inconclusive probe so the next call re-probes instead of
    // permanently pinning the wrong dialect.
    if (this.dialectProbe === probe && !this.dialectConfirmed) {
      this.dialectProbe = null;
    }
    return resolved;
  }

  /**
   * POST one capability, resolving its dialect-specific endpoint name and
   * argument wrapper each attempt. Taking the capability rather than a fixed
   * endpoint name lets a 404 retry re-map the name as well as the wrapper,
   * which is what heals a client that mis-detected the host dialect.
   */
  private async callEndpoint<T>(
    capability: DeepSeekHarnessCapability,
    request: Record<string, unknown>,
    requestId = crypto.randomUUID(),
    unwrap?: (value: unknown) => T,
  ): Promise<T> {
    const attempt = async (dialect: DeepSeekHarnessDialect): Promise<Response> => {
      const endpoint = deepSeekHarnessEndpoint(capability, dialect);
      if (!endpoint) {
        throw new Error(
          `DeepSeek Harness ${dialect} host does not expose the ${capability} endpoint.`,
        );
      }
      const payload = dialect === "typert"
        ? wrapTypertPayload(endpoint, capability === "prompt" ? { ...request, requestId } : request)
        : request;
      return await this.fetchFn(new URL(`/api/${endpoint}`, this.baseUrl), {
        method: "POST",
        headers: this.authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          type: "client-request",
          rpcId: requestId,
          method: endpoint,
          payload,
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    };

    const dialect = await this.resolveDialect();
    let response = await attempt(dialect);
    // A 401/403 means the cached browser-session cookie belongs to a previous
    // Desktop generation. Re-mint it from the credential store and retry once
    // before giving up, so a Desktop restart does not permanently break the
    // client until the whole daemon is restarted.
    if ((response.status === 401 || response.status === 403) && this.refreshCookieHeader()) {
      response = await attempt(dialect);
    }
    if (response.ok) {
      return await this.readEnvelope<T>(response, capability, requestId, unwrap);
    }
    // A 404 means this endpoint does not exist on the connected host, the
    // signature of a stale dialect guess. Drop the cached probe and retry once
    // with the opposite dialect — re-mapping the endpoint name and argument
    // wrapper — so a mis-detected client heals itself instead of 404ing until
    // the process restarts.
    if (response.status === 404) {
      this.dialectConfirmed = false;
      this.dialectProbe = null;
      const other: DeepSeekHarnessDialect = dialect === "typert" ? "legacy" : "typert";
      this.dialect = other;
      let retryResponse: Response;
      try {
        retryResponse = await attempt(other);
      } catch (error) {
        // The other dialect may have no equivalent endpoint at all.
        throw new Error(
          `DeepSeek Harness ${capability} transport failed: HTTP ${response.status}`,
          { cause: error },
        );
      }
      if (retryResponse.ok) {
        return await this.readEnvelope<T>(retryResponse, capability, requestId, unwrap);
      }
      throw new Error(
        `DeepSeek Harness ${capability} transport failed: HTTP ${retryResponse.status}`,
      );
    }
    throw new Error(
      `DeepSeek Harness ${capability} transport failed: HTTP ${response.status}`,
    );
  }

  /** Validate one RPC response envelope and unwrap its value. */
  private async readEnvelope<T>(
    response: Response,
    capability: string,
    requestId: string,
    unwrap?: (value: unknown) => T,
  ): Promise<T> {
    const envelope = await response.json() as DeepSeekRpcEnvelope;
    if (
      !isRecord(envelope) ||
      envelope.type !== "server-response" ||
      envelope.rpcId !== requestId ||
      !isRecord(envelope.result)
    ) {
      throw new Error(`DeepSeek Harness ${capability} returned an invalid RPC envelope.`);
    }
    if (envelope.result.ok !== true) {
      throw new Error(
        `DeepSeek Harness ${capability} failed: ${describeRpcError(envelope.result.error)}`,
      );
    }
    return unwrap ? unwrap(envelope.result.value) : envelope.result.value as T;
  }

  async describeHost() {
    const dialect = await this.resolveDialect();
    // Typert hosts dropped the dedicated describe endpoint; the session list
    // already proves reachability, so report a minimal host description.
    if (dialect === "typert") {
      return {
        version: "2.0.9+",
        cwd: "",
        provider: "",
        model: "",
        attachedSessions: 0,
        canOpenPath: false,
      };
    }
    return await this.call<ReturnType<DeepSeekHarnessClientLike["describeHost"]> extends Promise<infer T> ? T : never>(
      "host.describe",
      {},
    ).then((result) => result.value);
  }

  async listSessions(): Promise<DeepSeekHarnessSessionSummary[]> {
    return await this.callEndpoint<{ items: DeepSeekHarnessSessionSummary[] }>(
      "listSessions",
      {},
      crypto.randomUUID(),
      (value) => value as { items: DeepSeekHarnessSessionSummary[] },
    ).then((result) => result.items);
  }

  async createSession(cwd: string): Promise<{ sessionId: string }> {
    return await this.callEndpoint<{ sessionId: string }>("createSession", { cwd });
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.callEndpoint("renameSession", { sessionId, title });
  }

  async readHistory(
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number } = {},
  ) {
    const dialect = await this.resolveDialect();
    if (dialect === "typert") {
      // Projection cursors in the lightweight list may be absent or stale (-1)
      // for cold sessions. The native opening snapshot is authoritative.
      const snapshot = await this.readTypertSessionSnapshot(sessionId, options.maxMessages);
      const page = options.beforeSeq === undefined ? snapshot : await this.callEndpoint<{
        records?: unknown[];
        hasMore?: boolean;
        projections?: { asOfSeq?: number; values?: Record<string, unknown> };
      }>("readHistory", {
        ...typertSessionAddress(sessionId),
        throughSeq: snapshot.cursor,
        beforeSeq: options.beforeSeq,
        ...(options.maxMessages === undefined ? {} : { maxMessages: options.maxMessages }),
      });
      return {
        events: (page.records ?? []).flatMap((record) => {
          if (!isRecord(record) || record.type !== "event" || !isRecord(record.event)) return [];
          const event = record.event;
          return typeof event.seq === "number"
            ? [{ event: event as DeepSeekHarnessSessionEvent }]
            : [];
        }),
        hasMore: page.hasMore === true,
        ...(page.projections ? { projections: page.projections } : {}),
      };
    }
    return (await this.call<{
      events: DeepSeekHarnessHistoryEntry[];
      hasMore: boolean;
      projections?: { asOfSeq?: number; values?: Record<string, unknown> };
    }>("session.history", { sessionId, ...options })).value;
  }

  async readModels(sessionId: string): Promise<DeepSeekHarnessModelState> {
    const dialect = await this.resolveDialect();
    if (dialect === "typert") {
      const catalog = await this.callEndpoint<DeepSeekHarnessModelState & {
        default?: DeepSeekHarnessModelSelection;
        routableProviders?: string[];
      }>("readModels", {});
      const snapshot = await this.readTypertSessionSnapshot(sessionId, 1);
      const selection = snapshot.projections?.values?.modelSelection;
      const next = isRecord(selection) ? selection.next : undefined;
      const current = isRecord(next) && typeof next.provider === "string" && typeof next.model === "string"
        ? { provider: next.provider, model: next.model,
          ...(typeof next.reasoningEffort === "string" ? { reasoningEffort: next.reasoningEffort } : {}) }
        : catalog.default;
      if (!current) throw new Error("DeepSeek Harness 尚未提供这个任务的模型设置。");
      return { current, groups: catalog.groups, failures: catalog.failures,
        routable: catalog.routableProviders?.includes(current.provider) ?? false };
    }
    return (await this.call<DeepSeekHarnessModelState>("session.models", { sessionId })).value;
  }

  async selectModel(
    sessionId: string,
    selection: DeepSeekHarnessModelSelection,
  ): Promise<{ selected: DeepSeekHarnessModelSelection }> {
    return await this.callEndpoint<{ selected: DeepSeekHarnessModelSelection }>(
      "selectModel",
      { sessionId, ...selection },
    );
  }

  private async readTypertSessionSnapshot(sessionId: string, maxMessages?: number): Promise<{
    cursor: number;
    records: unknown[];
    hasMore?: boolean;
    projections?: { asOfSeq?: number; values?: Record<string, unknown> };
  }> {
    const signal = AbortSignal.timeout(this.requestTimeoutMs);
    for await (const frame of this.getRemoteMux().open("session/follow", {
      args: { request: { ...typertSessionAddress(sessionId), ...(maxMessages === undefined ? {} : { maxMessages }) } },
    }, signal)) {
      if (isRecord(frame) && frame.type === "snapshot" && Number.isSafeInteger(frame.cursor) &&
          typeof frame.cursor === "number" && frame.cursor >= -1 && Array.isArray(frame.records)) {
        return {
          cursor: frame.cursor,
          records: frame.records,
          hasMore: frame.hasMore === true,
          ...(isRecord(frame.projections) ? { projections: frame.projections } : {}),
        };
      }
    }
    throw new Error("DeepSeek Harness 未返回指定任务的历史快照，未切换到其他任务。");
  }

  async prompt(
    sessionId: string,
    content: DeepSeekHarnessPromptContent[],
    requestId = crypto.randomUUID(),
  ): Promise<{ rpcId: string; value: { accepted: true } }> {
    const value = await this.callEndpoint<{ accepted: true }>(
      "prompt",
      {
        sessionId,
        mode: "queue",
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
      },
      requestId,
    );
    return { rpcId: requestId, value };
  }

  async cancelSession(sessionId: string): Promise<{ accepted: true }> {
    return await this.callEndpoint<{ accepted: true }>("cancelSession", { sessionId });
  }

  async respond(message: DeepSeekHarnessClientResponse): Promise<{
    accepted: boolean;
    reason?: string;
  }> {
    if (await this.resolveDialect() === "typert") {
      const pending = this.remoteEvents.get(message.rpcId);
      if (!pending) return { accepted: false, reason: "这条确认已失效，请重新查看任务。" };
      const value = message.result.ok && isRecord(message.result.value) ? message.result.value : null;
      const outcome = message.result.ok
        ? { kind: "result", value: pending.kind === "approval" ? value?.outcome : value?.answer }
        : { kind: "rejected", error: message.result.error };
      const id = crypto.randomUUID();
      const response = await this.fetchFn(new URL("/api/$events/result", this.baseUrl), {
        method: "POST", headers: this.authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ type: "client-request", rpcId: id, method: "$events/result", payload: {
          args: { clientId: pending.clientId, eventId: message.rpcId, outcome },
        } }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`DeepSeek Harness 确认发送失败：HTTP ${response.status}`);
      await this.readEnvelope(response, "respond", id);
      this.remoteEvents.delete(message.rpcId);
      return { accepted: true };
    }
    const response = await this.fetchFn(new URL("/api/respond", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`DeepSeek Harness response transport failed: HTTP ${response.status}`);
    }
    const value = await response.json() as unknown;
    if (!isRecord(value) || typeof value.accepted !== "boolean") {
      throw new Error("DeepSeek Harness returned an invalid response receipt.");
    }
    return {
      accepted: value.accepted,
      ...(readString(value.reason) ? { reason: readString(value.reason) } : {}),
    };
  }

  async *openMux(signal?: AbortSignal): AsyncGenerator<DeepSeekHarnessEnvelope> {
    const streamSignal = signal ?? new AbortController().signal;
    // Typert renamed the stream mux and requires the same session cookie as
    // the HTTP surface; Node's global WebSocket forwards `headers` on the
    // upgrade request, so no extra dependency is needed.
    const dialect = await this.resolveDialect();
    if (dialect === "typert") {
      let clientId = "";
      try {
        for await (const frame of this.getEventMux().open("$events", { args: {} }, streamSignal)) {
          if (!isRecord(frame)) continue;
          if (frame.type === "ready" && typeof frame.clientId === "string") {
            clientId = frame.clientId;
            yield { rpcId: clientId, payload: { type: "stream/ready" } };
          } else if (frame.type === "emit" && typeof frame.event === "string" && frame.event.startsWith("api-session/") && Array.isArray(frame.args)) {
            const first = frame.args[0];
            const sessionId = typeof first === "string" ? first : isRecord(first) ? readString(first.sessionId) : undefined;
            if (sessionId) yield { rpcId: crypto.randomUUID(), payload: { type: "session/subscribed", sessionId, lastSeq: -1 } };
          } else if (frame.type === "waterfall" && clientId && typeof frame.eventId === "string" && typeof frame.agentId === "string" && isRecord(frame.request)) {
            const kind = frame.event === "approval/request" ? "approval" : frame.event === "user-questions/request" ? "question" : null;
            if (!kind) continue;
            if (this.remoteEvents.size >= 256) throw new Error("DeepSeek Harness 待确认请求过多，请在电脑端处理后重试。");
            this.remoteEvents.set(frame.eventId, { clientId, sessionId: frame.agentId, kind });
            if (kind === "approval") yield { rpcId: frame.eventId, payload: {
              type: "approval/requested", sessionId: frame.agentId, approvalId: frame.eventId,
              toolName: readString(frame.request.toolName) ?? "工具操作",
              ...(readString(frame.request.callId) ? { callId: readString(frame.request.callId) } : {}),
              ...(readString(frame.request.reason) ? { reason: readString(frame.request.reason) } : {}),
            } };
            else if (Array.isArray(frame.request.questions)) yield { rpcId: frame.eventId, payload: {
              type: "question/requested", sessionId: frame.agentId, questions: frame.request.questions as DeepSeekHarnessQuestion[],
            } };
          } else if (frame.type === "cancel" && typeof frame.eventId === "string") {
            const pending = this.remoteEvents.get(frame.eventId);
            if (!pending) continue;
            this.remoteEvents.delete(frame.eventId);
            yield { rpcId: frame.eventId, payload: pending.kind === "approval"
              ? { type: "approval/resolved", sessionId: pending.sessionId, approvalId: frame.eventId, outcome: "cancelled" }
              : { type: "question/resolved", sessionId: pending.sessionId, questionRpcId: frame.eventId, outcome: "cancelled" } };
          }
        }
      } finally {
        for (const [id, pending] of this.remoteEvents) if (pending.clientId === clientId) this.remoteEvents.delete(id);
      }
      return;
    }
    const muxPath = "/api/events.mux";
    const url = new URL(muxPath, this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.cookieHeader
      ? new WebSocket(url, { headers: { cookie: this.cookieHeader } } as never)
      : new WebSocket(url);
    type QueueItem =
      | { kind: "frame"; envelope: DeepSeekHarnessEnvelope }
      | { kind: "error"; error: Error }
      | { kind: "end" };
    const inbox: QueueItem[] = [];
    let wake: (() => void) | undefined;
    const enqueue = (item: QueueItem): void => {
      inbox.push(item);
      wake?.();
      wake = undefined;
    };
    const handleMessage = (event: MessageEvent): void => {
      try {
        if (typeof event.data !== "string") {
          throw new Error("DeepSeek Harness event stream returned a binary frame.");
        }
        const parsed = JSON.parse(event.data) as unknown;
        if (
          !isRecord(parsed) ||
          parsed.type !== "server-request" ||
          typeof parsed.rpcId !== "string" ||
          !isRecord(parsed.payload) ||
          typeof parsed.payload.type !== "string"
        ) {
          throw new Error("DeepSeek Harness event stream returned an invalid frame.");
        }
        enqueue({
          kind: "frame",
          envelope: {
            rpcId: parsed.rpcId,
            payload: parsed.payload as DeepSeekHarnessMuxFrame,
          },
        });
      } catch (error) {
        enqueue({
          kind: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    };
    const handleError = (): void => {
      enqueue({ kind: "error", error: new Error("DeepSeek Harness WebSocket 连接失败。") });
    };
    const handleClose = (): void => enqueue({ kind: "end" });
    const handleAbort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("error", handleError, { once: true });
    socket.addEventListener("close", handleClose, { once: true });
    streamSignal.addEventListener("abort", handleAbort, { once: true });
    if (streamSignal.aborted) handleAbort();
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift();
          if (!item || item.kind === "end") return;
          if (item.kind === "error") throw item.error;
          yield item.envelope;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      streamSignal.removeEventListener("abort", handleAbort);
      socket.removeEventListener("message", handleMessage);
      socket.removeEventListener("error", handleError);
      socket.removeEventListener("close", handleClose);
      handleAbort();
    }
  }

  private async call<T>(
    method: string,
    payload: Record<string, unknown>,
    requestId = crypto.randomUUID(),
  ): Promise<{ rpcId: string; value: T }> {
    const response = await this.fetchFn(new URL(`/api/${method}`, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: requestId,
        method,
        payload,
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`DeepSeek Harness ${method} transport failed: HTTP ${response.status}`);
    }
    const envelope = await response.json() as DeepSeekRpcEnvelope;
    if (
      !isRecord(envelope) ||
      envelope.type !== "server-response" ||
      envelope.rpcId !== requestId ||
      !isRecord(envelope.result)
    ) {
      throw new Error(`DeepSeek Harness ${method} returned an invalid RPC envelope.`);
    }
    if (envelope.result.ok !== true) {
      throw new Error(`DeepSeek Harness ${method} failed: ${describeRpcError(envelope.result.error)}`);
    }
    return {
      rpcId: requestId,
      value: envelope.result.value as T,
    };
  }
}

function visibleTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "text") return [];
    const text = readString(block.text);
    return text ? [text] : [];
  }).join("\n\n").trim();
}

function assistantMessageFromEvent(
  event: DeepSeekHarnessSessionEvent,
): BridgeSessionMessage | null {
  if (event.type !== "assistant/message" || !isRecord(event.data)) return null;
  const message = isRecord(event.data.message) ? event.data.message : null;
  if (!message) return null;
  const text = visibleTextFromContent(message.content);
  if (!text) return null;
  const source = isRecord(message.source) ? message.source : null;
  return {
    role: "assistant",
    text,
    ...(readString(message.id) ? { id: readString(message.id) } : {}),
    ...(readNumber(event.data.turn) !== undefined
      ? { turnId: String(readNumber(event.data.turn)) }
      : {}),
    phase: "final_answer",
    createdAtMs: event.time,
    ...(source && readString(source.model) ? { model: readString(source.model) } : {}),
  };
}

export function mapDeepSeekHarnessHistoryEvents(
  entries: DeepSeekHarnessHistoryEntry[],
): BridgeSessionMessage[] {
  const messages: BridgeSessionMessage[] = [];
  for (const { event } of entries) {
    if (event.type === "user/message" && isRecord(event.data)) {
      const source = isRecord(event.data.source) ? event.data.source : null;
      if (source?.kind !== "user") continue;
      const text = visibleTextFromContent(event.data.content);
      if (!text) continue;
      messages.push({
        role: "user",
        text,
        ...(readString(event.data.id) ? { id: readString(event.data.id) } : {}),
        createdAtMs: event.time,
      });
      continue;
    }
    const assistant = assistantMessageFromEvent(event);
    if (assistant) messages.push(assistant);
  }
  return messages;
}

function sessionTitle(summary: DeepSeekHarnessSessionSummary): string {
  const values = summary.projections?.values;
  const title = values && readString(values.title);
  return title ?? (summary.blank ? "DeepSeek 新任务" : `DeepSeek 任务 ${summary.sessionId.slice(0, 8)}`);
}

function sessionProject(cwd: string | undefined): {
  projectId: string;
  projectName: string;
} | null {
  const projectId = cwd?.trim().replace(/[\\/]+$/, "") ?? "";
  if (!projectId) return null;
  const projectName = projectId.split(/[\\/]/).at(-1)?.trim() ?? "";
  return projectName ? { projectId, projectName } : null;
}

function sessionCandidate(
  summary: DeepSeekHarnessSessionSummary,
  pendingApprovals = false,
  pendingQuestions = false,
): BridgeResumeSessionCandidate {
  const project = sessionProject(summary.cwd);
  const runtimeStatus = summary.running
    ? {
        type: "active" as const,
        activeFlags: [
          ...(pendingApprovals ? ["waitingOnApproval" as const] : []),
          ...(pendingQuestions ? ["waitingOnUserInput" as const] : []),
        ],
      }
    : { type: "idle" as const };
  return {
    sessionId: summary.sessionId,
    threadId: summary.sessionId,
    title: sessionTitle(summary),
    lastUpdatedAt: new Date(summary.updatedAt).toISOString(),
    ...(project
      ? { cwd: project.projectId, ...project }
      : summary.cwd
        ? { cwd: summary.cwd }
        : {}),
    runtimeStatus,
  };
}

export async function listDeepSeekHarnessSessions(
  limit = 100,
  baseUrl = resolveDeepSeekHarnessBaseUrl(),
  options: { timeoutMs?: number } = {},
): Promise<BridgeResumeSessionCandidate[]> {
  const client = new DeepSeekHarnessHttpClient(
    baseUrl,
    fetch,
    options.timeoutMs ?? DEEPSEEK_HARNESS_HTTP_TIMEOUT_MS,
  );
  return (await client.listSessions()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(0, limit)).map((item) =>
    sessionCandidate(item)
  );
}

function imageMediaType(pathname: string): DeepSeekHarnessImageMediaType {
  switch (path.extname(pathname).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      throw new Error(`DeepSeek Harness 不支持这个图片格式：${path.extname(pathname) || "未知"}`);
  }
}

function turnKey(sessionId: string, turn: number | string): string {
  return `${sessionId}\u0000${turn}`;
}

function callKey(sessionId: string, callId: string): string {
  return `${sessionId}\u0000${callId}`;
}

function pendingQuestionRequest(
  sessionId: string,
  questions: DeepSeekHarnessQuestion[],
  origin: HarnessTurnOrigin,
): UserInputRequest {
  return {
    summary: questions[0]?.question ?? "DeepSeek Harness 需要补充信息",
    threadId: sessionId,
    origin,
    questions: questions.map((question, index) => ({
      id: question.id,
      header: question.header ?? `问题 ${index + 1}`,
      question: [question.question, question.detail].filter(Boolean).join("\n\n"),
      // Native Harness questions support a custom answer even with fixed options.
      isOther: true,
      multiSelect: question.multiSelect ?? false,
      isSecret: false,
      ...(question.options?.length
        ? {
            options: question.options.map((option) => ({
              label: option.label,
              description: option.description ?? "",
            })),
          }
        : {}),
    })),
  };
}

function toolCallPreview(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const rawArguments = readString(value.arguments);
  if (!rawArguments) return fallback;
  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    if (isRecord(parsed)) {
      const preferred = readString(parsed.cmd) ?? readString(parsed.command) ??
        readString(parsed.file_path) ?? readString(parsed.path);
      if (preferred) return preferred;
    }
  } catch {
    // Keep the original compact JSON text below.
  }
  return rawArguments;
}

function toolResultState(
  event: DeepSeekHarnessSessionEvent,
): { callId: string; status: "completed" | "failed" } | null {
  if (event.type !== "tool/result" || !isRecord(event.data)) return null;
  const message = isRecord(event.data.message) ? event.data.message : null;
  const source = message && isRecord(message.source) ? message.source : null;
  const callId = readString(source?.callId);
  if (!callId) return null;
  const content = message && Array.isArray(message.content) ? message.content : [];
  const failed = Boolean(event.data.error) || content.some((block) =>
    isRecord(block) && block.type === "tool-result" && block.isError === true
  );
  return { callId, status: failed ? "failed" : "completed" };
}

export class DeepSeekHarnessAdapter implements BridgeAdapter {
  private readonly options: AdapterOptions;
  private client!: DeepSeekHarnessClientLike;
  private readonly dependencies: ResolvedDeepSeekHarnessAdapterDependencies;
  private readonly state: BridgeAdapterState;
  private eventSink: EventSink = () => undefined;
  private muxAbortController: AbortController | null = null;
  private muxTask: Promise<void> | null = null;
  private disposing = false;
  private readonly currentTurnBySession = new Map<string, number>();
  private readonly turnOriginByKey = new Map<string, HarnessTurnOrigin>();
  private readonly replyTextByTurn = new Map<string, string[]>();
  private readonly replyTimestampByTurn = new Map<string, number>();
  private readonly promptRpcIds = new Set<string>();
  private readonly promptSessionByRpcId = new Map<string, string>();
  private readonly promptRpcIdByTurn = new Map<string, string>();
  private readonly toolCalls = new Map<string, unknown>();
  private readonly pendingApprovals = new Map<string, PendingHarnessApproval>();
  private readonly pendingQuestions = new Map<string, PendingHarnessQuestion>();
  private readonly deliveredTurns = new Set<string>();
  private readonly historyReconciliationBySession = new Map<string, Promise<void>>();
  private readonly recoveryTaskBySession = new Map<string, Promise<void>>();
  private readonly permissionSelectionBySession = new Map<string, string>();
  private muxOutageNoticeActive = false;
  private muxLastOutageNoticeAt = 0;
  private muxOutageNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private muxRecoveryStableTimer: ReturnType<typeof setTimeout> | null = null;
  private historyErrorNoticeAt = 0;
  /** Endpoint the current client is bound to, so it can be re-resolved. */
  private boundBaseUrl = "";

  constructor(
    options: AdapterOptions,
    dependencies?: DeepSeekHarnessAdapterDependencies,
  ) {
    this.options = options;
    const resolveBaseUrl = dependencies?.resolveBaseUrl ?? (dependencies
      ? () => normalizeDeepSeekHarnessBaseUrl()
      : () => resolveDeepSeekHarnessBaseUrl());
    this.dependencies = {
      createClient: dependencies?.createClient ??
        ((baseUrl: string) => new DeepSeekHarnessHttpClient(baseUrl)),
      resolveBaseUrl,
      resolveRecoveredBaseUrl: dependencies?.resolveRecoveredBaseUrl ??
        (dependencies ? resolveBaseUrl : () => discoverDeepSeekDesktopHarnessBaseUrl()),
      recoverDesktopAccess: dependencies?.recoverDesktopAccess ??
        ((error) => recoverDeepSeekDesktopHarnessAccess({
          error,
          allowDesktopApplicationLaunch:
            this.options.allowDesktopApplicationLaunch === true,
        })),
      sleep: dependencies?.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: dependencies?.now ?? (() => Date.now()),
    };
    // The endpoint is resolved once here, but discovery can legitimately fail
    // while DSH Desktop is restarting and then fall back to the documented
    // default port. That default may not be the port the Desktop ends up
    // serving, so remember whether the endpoint was discovered or assumed and
    // re-resolve it before a connection attempt rather than pinning the client
    // to a dead port for its whole lifetime.
    this.boundBaseUrl = this.dependencies.resolveBaseUrl();
    this.client = this.dependencies.createClient(this.boundBaseUrl);
    const initialSessionId = options.sessionStartMode === "new"
      ? undefined
      : options.initialSharedSessionId ?? options.initialSharedThreadId;
    this.state = {
      kind: "deepseek",
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

  /**
   * Re-resolve the Harness endpoint and rebind the client when the resolved
   * address changed.
   *
   * Construction resolves the endpoint once. If DSH Desktop was mid-restart at
   * that moment, discovery returns nothing and the resolver falls back to the
   * documented default port, which the Desktop may not be serving. Pinning the
   * client to that address makes every later call fail with `fetch failed`
   * even after the Desktop is healthy again.
   */
  private async reconnectClientToResolvedBaseUrl(): Promise<void> {
    const resolved = await this.resolveReachableBaseUrl();
    if (resolved === this.boundBaseUrl) return;
    this.boundBaseUrl = resolved;
    this.client = this.dependencies.createClient(resolved);
  }

  /**
   * Resolve an endpoint that actually has a listening Desktop behind it.
   *
   * The plain resolver falls back to the documented default port whenever
   * discovery comes up empty. That default is a `dsh web` port the Desktop does
   * not serve, so binding it produces ECONNREFUSED for the whole client
   * lifetime. When discovery is empty, retry briefly instead of accepting a
   * default that cannot be the right answer while a Desktop is running.
   */
  private async resolveReachableBaseUrl(): Promise<string> {
    const resolved = this.dependencies.resolveBaseUrl();
    if (resolved !== DEFAULT_DEEPSEEK_HARNESS_URL) return resolved;
    // A single discovery probe. Endpoint discovery shells out synchronously
    // (`ps` plus `lsof`), so looping here would block the daemon event loop and
    // freeze WeChat polling, the web console, and the relay together. Callers
    // that need another chance retry the whole connect instead.
    return this.dependencies.resolveRecoveredBaseUrl() ?? resolved;
  }

  async start(): Promise<void> {
    if (this.muxTask) return;
    this.disposing = false;
    this.clearMuxNoticeTimers();
    this.muxOutageNoticeActive = false;
    this.muxLastOutageNoticeAt = 0;
    this.setStatus("starting", "正在连接 DeepSeek Harness。");
    // The endpoint may have changed since construction (DSH Desktop restart).
    await this.reconnectClientToResolvedBaseUrl();
    try {
      let selected: DeepSeekHarnessSessionSummary | undefined;
      try {
        selected = await this.connectAndRestoreSession();
      } catch (error) {
        // A transient transport failure (the Desktop restarting, a refused
        // connection) is retried in place. Restarting the Desktop for it would
        // turn a brief blip into a long outage, so settings recovery stays
        // reserved for the protected-host case that genuinely needs it.
        if (
          this.options.allowDesktopApplicationLaunch !== true ||
          !await this.dependencies.recoverDesktopAccess(error)
        ) {
          const retried = await this.retryTransientConnectFailure(error);
          if (retried === null) throw error;
          selected = retried;
        } else {
          try {
            selected = await this.retryAfterDesktopRecovery(error);
          } catch (recoveryError) {
            // The recovery window can expire without ever producing an
            // actionable error (for example while DSH Desktop is still
            // booting and its port is not listening yet). Always surface a
            // real reason so callers and WeChat never see `undefined`.
            throw recoveryError ?? error;
          }
        }
      }
      this.state.startedAt = nowIso();
      this.setStatus(selected?.running ? "busy" : "idle");
      this.muxAbortController = new AbortController();
      this.muxTask = this.runMuxLoop(this.muxAbortController.signal);
    } catch (error) {
      // Include the resolved endpoint and cause chain: without them a bare
      // "fetch failed" cannot be told apart from a dead port, a stale cookie,
      // or a wrong dialect.
      this.setStatus(
        "error",
        `无法连接 DeepSeek Harness，请确认 DSH Desktop 或 dsh web 正在本机运行。${describeDeepSeekConnectFailure(this.boundBaseUrl, error)}`,
      );
      throw error;
    }
  }

  private async connectAndRestoreSession(): Promise<DeepSeekHarnessSessionSummary | undefined> {
    await this.client.describeHost();
    const sessions = (await this.client.listSessions()).sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
    const requestedSessionId = this.state.sharedSessionId;
    let selected: DeepSeekHarnessSessionSummary | undefined;
    if (this.options.sessionStartMode === "new") {
      await this.createSessionAt(this.options.cwd, false);
      return undefined;
    }
    if (requestedSessionId) {
      selected = sessions.find((item) => item.sessionId === requestedSessionId);
      if (!selected) {
        throw new Error("无法恢复指定的 DeepSeek Harness 任务；为避免会话分叉，未切换到其他任务。");
      }
    } else {
      selected = sessions[0];
    }
    if (!selected) {
      await this.createSessionAt(this.options.cwd, false);
    } else {
      this.setSessionId(selected.sessionId, selected.cwd);
    }
    return selected;
  }

  /**
   * Retry a transient connect failure in place, re-resolving the endpoint each
   * time so a Desktop that restarted underneath us is picked up.
   *
   * Returns the restored session, or null when every attempt failed. This is
   * deliberately bounded and side-effect free: it must not restart the
   * Desktop, because the caller may simply have raced a restart that is
   * already in progress.
   */
  private async retryTransientConnectFailure(
    originalError: unknown,
  ): Promise<DeepSeekHarnessSessionSummary | undefined | null> {
    // Only transport-level failures are worth retrying. A semantic error such
    // as "the persisted task no longer exists" is permanent, and retrying it
    // would stall the caller for the whole window before failing anyway.
    if (!isTransientDeepSeekConnectError(originalError)) return null;
    // Count attempts rather than polling a clock: an injected or coarse `now`
    // that does not advance would make a deadline-based loop spin forever.
    for (let attempt = 0; attempt < DEEPSEEK_TRANSIENT_CONNECT_RETRY_ATTEMPTS; attempt += 1) {
      await this.dependencies.sleep(DEEPSEEK_TRANSIENT_CONNECT_RETRY_INTERVAL_MS);
      await this.reconnectClientToResolvedBaseUrl();
      try {
        return await this.connectAndRestoreSession();
      } catch {
        // Keep trying until the bounded attempt budget is spent.
      }
    }
    return null;
  }

  private async retryAfterDesktopRecovery(
    originalError?: unknown,
  ): Promise<DeepSeekHarnessSessionSummary | undefined> {
    // Count bounded attempts instead of polling a clock: an injected or coarse
    // `now` that never advances would otherwise spin this loop forever.
    const maxAttempts = Math.max(
      1,
      Math.ceil(DEEPSEEK_DESKTOP_RECOVERY_TIMEOUT_MS / DEEPSEEK_DESKTOP_RECOVERY_POLL_MS),
    );
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const recoveredBaseUrl = this.dependencies.resolveRecoveredBaseUrl();
      if (recoveredBaseUrl) {
        this.boundBaseUrl = recoveredBaseUrl;
        this.client = this.dependencies.createClient(recoveredBaseUrl);
        try {
          return await this.connectAndRestoreSession();
        } catch (error) {
          lastError = error;
        }
      }
      if (attempt + 1 < maxAttempts) {
        await this.dependencies.sleep(DEEPSEEK_DESKTOP_RECOVERY_POLL_MS);
      }
    }
    // Never throw a bare `undefined`: when the restarted Desktop never
    // published a loopback port inside the window, surface the original
    // transport failure so callers and WeChat see the real reason.
    throw lastError ?? originalError ?? new Error(
      "DSH Desktop 已重新启动，但本地接口仍未就绪；请在电脑上确认 DSH Desktop 已打开后重试。",
    );
  }

  async sendInput(text: string): Promise<void> {
    await this.sendInputItemsToSession(this.requireSessionId(), [{ type: "text", text }]);
  }

  async sendInputToSession(
    sessionId: string,
    text: string,
  ): Promise<BridgeSessionSendResult> {
    return await this.sendInputItemsToSession(sessionId, [{ type: "text", text }]);
  }

  async sendInputItemsToSession(
    sessionId: string,
    items: BridgeTurnInputItem[],
  ): Promise<BridgeSessionSendResult> {
    if (sessionId !== this.state.sharedSessionId) await this.resumeSession(sessionId);
    const sessionSummary = (await this.client.listSessions()).find(
      (item) => item.sessionId === sessionId,
    );
    if (sessionSummary?.blank && items.some((item) => item.type === "localImage")) {
      const models = await this.client.readModels(sessionId);
      // current 可能缺失（会话尚未选择模型）；缺失时不做视觉模型替换。
      const current = models.current;
      const visionModel = current?.provider === "deepseek-official" &&
          current.model === "deepseek-v4-flash"
        ? models.groups.find((group) => group.id === current.provider)?.models.find(
          (model) => model.id === "deepseek-v4-flash-vision-exp",
        )
        : undefined;
      if (visionModel && current) {
        await this.client.selectModel(sessionId, {
          provider: current.provider,
          model: visionModel.id,
          ...(current.reasoningEffort
            ? { reasoningEffort: current.reasoningEffort }
            : {}),
        });
      }
    }
    const content: DeepSeekHarnessPromptContent[] = [];
    for (const item of items) {
      if (item.type === "text") {
        if (item.text.trim()) content.push({ type: "text", text: item.text });
        continue;
      }
      if (item.type === "image") {
        throw new Error("DeepSeek Harness 暂不直接读取远程图片链接，请先上传本地图片。");
      }
      const data = await fs.promises.readFile(item.path);
      content.push({
        type: "image",
        mediaType: imageMediaType(item.path),
        data: data.toString("base64"),
        name: path.basename(item.path),
      });
    }
    if (content.length === 0) throw new Error("消息不能为空。");
    const running = sessionSummary?.running === true;
    const requestId = crypto.randomUUID();
    this.promptRpcIds.add(requestId);
    this.promptSessionByRpcId.set(requestId, sessionId);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "wechat";
    this.setStatus("busy");
    try {
      const result = await this.client.prompt(sessionId, content, requestId);
      if (result.rpcId !== requestId) {
        this.promptRpcIds.delete(requestId);
        this.promptSessionByRpcId.delete(requestId);
        this.promptRpcIds.add(result.rpcId);
        this.promptSessionByRpcId.set(result.rpcId, sessionId);
      }
      this.startSessionRecovery(sessionId);
      return { queued: running };
    } catch (error) {
      this.promptRpcIds.delete(requestId);
      this.promptSessionByRpcId.delete(requestId);
      this.setStatus("error");
      throw error;
    }
  }

  async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    const sessions = await this.client.listSessions();
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(0, limit)).map((item) => sessionCandidate(
      item,
      [...this.pendingApprovals.values()].some((pending) => pending.sessionId === item.sessionId),
      [...this.pendingQuestions.values()].some((pending) => pending.sessionId === item.sessionId),
    ));
  }

  async resumeSession(sessionId: string): Promise<void> {
    const sessions = await this.client.listSessions();
    const session = sessions.find((item) => item.sessionId === sessionId);
    if (!session) {
      throw new Error("没有找到这个 DeepSeek Harness 任务；为避免会话分叉，未新建替代任务。");
    }
    this.setSessionId(sessionId, session.cwd);
    this.setStatus(session.running ? "busy" : "idle");
    this.emit({
      type: "session_switched",
      sessionId,
      source: "wechat",
      reason: "wechat_resume",
      timestamp: nowIso(),
    });
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.client.renameSession(sessionId, title);
  }

  async getLatestSessionMessage(sessionId: string): Promise<BridgeSessionMessage | null> {
    const messages = await this.getSessionMessages(sessionId);
    return messages.at(-1) ?? null;
  }

  async getSessionMessages(sessionId: string): Promise<BridgeSessionMessage[]> {
    const history = await this.client.readHistory(sessionId, {
      maxMessages: DEEPSEEK_HISTORY_LIMIT,
    });
    return mapDeepSeekHarnessHistoryEvents(history.events);
  }

  async getSessionMessagePage(
    sessionId: string,
    options: BridgeSessionMessagePageOptions = {},
  ): Promise<BridgeSessionMessagePage> {
    const beforeSeq = options.before && /^\d+$/.test(options.before)
      ? Number(options.before)
      : undefined;
    const limit = Math.max(1, Math.min(options.limit ?? 40, DEEPSEEK_HISTORY_LIMIT));
    const history = await this.client.readHistory(sessionId, {
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
      maxMessages: limit,
    });
    const firstSeq = history.events[0]?.event.seq;
    return {
      messages: mapDeepSeekHarnessHistoryEvents(history.events),
      hasMore: history.hasMore,
      nextBefore: history.hasMore && firstSeq !== undefined ? String(firstSeq) : null,
      source: "native",
      caughtUp: beforeSeq === undefined,
    };
  }

  async getSessionProgress(sessionId: string): Promise<BridgeSessionProgressItem[]> {
    const history = await this.client.readHistory(sessionId, { maxMessages: 20 });
    const resultStateByCallId = new Map<string, "completed" | "failed">();
    for (const { event } of history.events) {
      const result = toolResultState(event);
      if (result) resultStateByCallId.set(result.callId, result.status);
    }
    return history.events.flatMap(({ event }) => {
      if (event.type !== "tool/call" || !isRecord(event.data)) return [];
      const name = readString(event.data.name) ?? "工具";
      const callId = readString(event.data.callId) ?? String(event.seq);
      return [{
        id: `${sessionId}:${callId}`,
        ...(readNumber(event.data.turn) !== undefined
          ? { turnId: String(readNumber(event.data.turn)) }
          : {}),
        kind: name === "bash" ? "command" as const : "tool" as const,
        status: resultStateByCallId.get(callId) ?? "running" as const,
        text: `${name}：${truncatePreview(toolCallPreview(event.data, name), 200)}`,
        createdAtMs: event.time,
      }];
    });
  }

  async getSessionRunSummary(sessionId: string): Promise<BridgeSessionRunSummary | null> {
    const summary = (await this.client.listSessions()).find(
      (item) => item.sessionId === sessionId,
    );
    if (!summary) return null;
    const history = await this.client.readHistory(sessionId, { maxMessages: 50 });
    let latestStart: DeepSeekHarnessSessionEvent | undefined;
    let latestEnd: DeepSeekHarnessSessionEvent | undefined;
    for (const { event } of history.events) {
      if (event.type === "turn/start" && (!latestStart || event.seq > latestStart.seq)) {
        latestStart = event;
      }
      if (event.type === "turn/end" && (!latestEnd || event.seq > latestEnd.seq)) {
        latestEnd = event;
      }
    }
    const startData = latestStart && isRecord(latestStart.data) ? latestStart.data : null;
    const endData = latestEnd && isRecord(latestEnd.data) ? latestEnd.data : null;
    if (summary.running) {
      const turn = readNumber(startData?.turn);
      return {
        ...(turn !== undefined ? { turnId: String(turn) } : {}),
        status: "running",
        ...(latestStart ? { startedAtMs: latestStart.time } : {}),
        ...(latestStart ? { durationMs: Math.max(0, Date.now() - latestStart.time) } : {}),
      };
    }
    if (latestStart && (!latestEnd || latestStart.seq > latestEnd.seq)) {
      const turn = readNumber(startData?.turn);
      return {
        ...(turn !== undefined ? { turnId: String(turn) } : {}),
        status: "interrupted",
        startedAtMs: latestStart.time,
        completedAtMs: summary.updatedAt,
        durationMs: Math.max(0, summary.updatedAt - latestStart.time),
      };
    }
    if (!latestEnd) return summary.blank ? null : { status: "unknown" };
    const turn = readNumber(endData?.turn);
    const reason = isRecord(endData?.reason) ? endData.reason : null;
    const kind = readString(reason?.kind);
    const status = kind === "completed"
      ? "completed"
      : kind === "cancelled" || kind === "interrupted"
        ? "interrupted"
        : kind === "error"
          ? "failed"
          : "unknown";
    const errorMessage = status === "failed"
      ? deepSeekHarnessFailureMessage(reason)
      : undefined;
    return {
      ...(turn !== undefined ? { turnId: String(turn) } : {}),
      status,
      ...(latestStart ? { startedAtMs: latestStart.time } : {}),
      completedAtMs: latestEnd.time,
      ...(latestStart ? { durationMs: Math.max(0, latestEnd.time - latestStart.time) } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    };
  }

  private modelSelectionId(provider: string, model: string): string {
    return `${provider}::${model}`;
  }

  private parseModelSelectionId(value: string): { provider: string; model: string } | null {
    const separatorIndex = value.indexOf("::");
    if (separatorIndex <= 0 || separatorIndex >= value.length - 2) return null;
    return {
      provider: value.slice(0, separatorIndex),
      model: value.slice(separatorIndex + 2),
    };
  }

  private reasoningEffortOptions(current?: string): Array<{
    id: string;
    label: string;
  }> {
    if (!current?.trim()) return [];
    const options = [
      { id: "low", label: "低" },
      { id: "medium", label: "中" },
      { id: "high", label: "高" },
    ];
    return options.some((option) => option.id === current)
      ? options
      : [...options, { id: current, label: current }];
  }

  async getNewSessionModelState(): Promise<BridgeSessionModelState> {
    if (!this.state.sharedSessionId) {
      return { options: [], canChange: false, unavailableReason: "请先连接一个 DSH 任务，再预选新任务模型。" };
    }
    return await this.getSessionModelState(this.state.sharedSessionId);
  }

  async getSessionModelState(sessionId: string): Promise<BridgeSessionModelState> {
    const state = await this.client.readModels(sessionId);
    // Harness 在某些会话下（尚未选择模型、目录只返回 provider 列表、Host
    // 刚重启）不会带回 current。这里必须兜底，否则模型状态读取会直接抛
    // 异常，让任务台的模型入口与切换全部失败。
    const current = state.current;
    const reasoningEffortOptions = this.reasoningEffortOptions(
      current?.reasoningEffort,
    );
    // routable 只说明当前选中的 provider 已不可用；只要目录里还有可切换的
    // 模型，就必须允许用户改选，否则失效模型（如已下线的 ox-alpha）会把任务
    // 永久卡在既不能发消息也不能换模型的状态。模型目录继续展开全部 provider，
    // 供用户精确改选。
    const groups = Array.isArray(state.groups) ? state.groups : [];
    const options = groups.flatMap((group) => group.models.map((model) => ({
        id: this.modelSelectionId(group.id, model.id),
        label: model.name,
        group: group.name,
        ...(model.description ? { description: model.description } : {}),
      })));
    return {
      ...(current
        ? { currentModel: this.modelSelectionId(current.provider, current.model) }
        : {}),
      options,
      canChange: options.length > 0,
      ...(current?.reasoningEffort
        ? { currentReasoningEffort: current.reasoningEffort }
        : {}),
      ...(reasoningEffortOptions.length > 0 ? { reasoningEffortOptions } : {}),
      ...(reasoningEffortOptions.length > 0
        ? { canChangeReasoningEffort: options.length > 0 }
        : {}),
      ...(options.length === 0
        ? { unavailableReason: "DeepSeek Harness 当前没有可切换的模型。" }
        : {}),
    };
  }

  async setSessionModel(
    sessionId: string,
    model: string,
  ): Promise<BridgeSessionModelState> {
    const current = await this.client.readModels(sessionId);
    const exact = this.parseModelSelectionId(model);
    const groups = Array.isArray(current.groups) ? current.groups : [];
    // current 可能缺失；此时只能按模型 id 查找，不能按当前 provider 匹配。
    const currentProvider = current.current?.provider;
    const group = exact
      ? groups.find((item) =>
          item.id === exact.provider &&
          item.models.some((candidate) => candidate.id === exact.model)
        )
      : groups.find((item) =>
          item.id === currentProvider &&
          item.models.some((candidate) => candidate.id === model)
        ) ?? groups.find((item) =>
          item.models.some((candidate) => candidate.id === model)
        );
    const selectedModel = exact?.model ?? model;
    if (!group) throw new Error(`DeepSeek Harness 没有提供模型 ${model}。`);
    await this.client.selectModel(sessionId, {
      provider: group.id,
      model: selectedModel,
      ...(current.current?.reasoningEffort
        ? { reasoningEffort: current.current.reasoningEffort }
        : {}),
    });
    return await this.getSessionModelState(sessionId);
  }

  async setSessionReasoningEffort(
    sessionId: string,
    reasoningEffort: string,
  ): Promise<BridgeSessionModelState> {
    const normalizedEffort = reasoningEffort.trim();
    if (!normalizedEffort) throw new Error("请选择推理强度。");
    const current = await this.client.readModels(sessionId);
    const options = this.reasoningEffortOptions(current.current?.reasoningEffort);
    if (!current.routable) {
      throw new Error("DeepSeek Harness 当前模型路由不可用。");
    }
    if (!options.some((option) => option.id === normalizedEffort)) {
      throw new Error("这个推理强度当前不可用，请重新选择。");
    }
    // 没有 current 就无法确定要切换哪个模型，明确报错而不是崩溃。
    const activeModel = current.current;
    if (!activeModel) {
      throw new Error("DeepSeek Harness 当前没有可用的模型，请先选择模型。");
    }
    await this.client.selectModel(sessionId, {
      provider: activeModel.provider,
      model: activeModel.model,
      reasoningEffort: normalizedEffort,
    });
    return await this.getSessionModelState(sessionId);
  }

  async getSessionPermissionState(
    sessionId: string,
  ): Promise<BridgeSessionPermissionState> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) throw new Error("请选择一个 DeepSeek Harness 任务。");
    const [history, summary] = await Promise.all([
      this.client.readHistory(normalizedSessionId, { maxMessages: 1 }),
      this.client.listSessions().then((sessions) =>
        sessions.find((item) => item.sessionId === normalizedSessionId)
      ),
    ]);
    if (!summary) throw new Error("没有找到这个 DeepSeek Harness 任务。");
    const rawPermissions = history.projections?.values?.permissions;
    const permissions = isRecord(rawPermissions) ? rawPermissions : null;
    const rawOptions = Array.isArray(permissions?.options) ? permissions.options : [];
    const options = rawOptions.flatMap((raw): BridgeSessionPermissionOption[] => {
      if (!isRecord(raw)) return [];
      const id = readString(raw.value) ?? readString(raw.id);
      if (!id) return [];
      const label = DEEPSEEK_PERMISSION_LABELS[id] ?? readString(raw.name) ?? id;
      const description = readString(raw.description);
      return [{
        id,
        label,
        ...(description ? { description } : {}),
        ...(id === "danger-full-access" ? { requiresConfirmation: true } : {}),
      }];
    });
    const projectedPermission = readString(permissions?.currentValue);
    const selectedPermission = this.permissionSelectionBySession.get(normalizedSessionId);
    const currentPermission = selectedPermission &&
        options.some((option) => option.id === selectedPermission)
      ? selectedPermission
      : projectedPermission;
    if (projectedPermission === selectedPermission) {
      this.permissionSelectionBySession.delete(normalizedSessionId);
    }
    const hasSelectableOptions = options.some((option) => option.id !== "custom");
    return {
      ...(currentPermission ? { currentPermission } : {}),
      options,
      canChange: hasSelectableOptions,
      ...(!hasSelectableOptions
        ? { unavailableReason: "DeepSeek Harness 当前任务没有提供可切换的权限范围。" }
        : {}),
    };
  }

  async setSessionPermission(
    sessionId: string,
    permission: string,
  ): Promise<BridgeSessionPermissionState> {
    const normalizedSessionId = sessionId.trim();
    const normalizedPermission = permission.trim();
    if (!normalizedSessionId) throw new Error("请选择一个 DeepSeek Harness 任务。");
    if (!normalizedPermission) throw new Error("请选择权限范围。");
    const state = await this.getSessionPermissionState(normalizedSessionId);
    if (!state.canChange) {
      throw new Error(state.unavailableReason || "当前任务暂时不能切换权限范围。");
    }
    const option = state.options.find((candidate) => candidate.id === normalizedPermission);
    if (!option || option.id === "custom") {
      throw new Error("这个 DeepSeek Harness 权限范围当前不可用。");
    }
    await this.client.prompt(normalizedSessionId, [{
      type: "text",
      text: `/permission ${normalizedPermission}`,
    }]);
    this.permissionSelectionBySession.set(normalizedSessionId, normalizedPermission);
    return {
      ...state,
      currentPermission: normalizedPermission,
    };
  }

  async createSession(): Promise<void> {
    await this.createSessionAt(this.options.cwd);
  }

  async createSessionInProject(sourceSessionId: string): Promise<void> {
    const source = (await this.client.listSessions()).find(
      (item) => item.sessionId === sourceSessionId,
    );
    await this.createSessionAt(source?.cwd ?? this.options.cwd);
  }

  async interrupt(): Promise<boolean> {
    return await this.interruptSession(this.requireSessionId());
  }

  async interruptSession(sessionId: string): Promise<boolean> {
    const running = (await this.client.listSessions()).find(
      (item) => item.sessionId === sessionId,
    )?.running === true;
    const hasWait = [...this.pendingApprovals.values()].some(
      (pending) => pending.sessionId === sessionId,
    ) || [...this.pendingQuestions.values()].some(
      (pending) => pending.sessionId === sessionId,
    );
    if (!running && !hasWait) return false;
    await this.client.cancelSession(sessionId);
    this.clearPendingForSession(sessionId);
    this.clearPendingPromptsForSession(sessionId);
    if (sessionId === this.state.sharedSessionId) this.setStatus("idle");
    this.emit({
      type: "task_complete",
      outcome: "interrupted",
      timestamp: nowIso(),
      threadId: sessionId,
      origin: "wechat",
    });
    return true;
  }

  async reset(): Promise<void> {
    if (this.state.status === "busy" || this.state.status === "awaiting_approval") {
      await this.interrupt();
    }
    await this.createSession();
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    const sessionId = this.state.sharedSessionId;
    const pending = [...this.pendingApprovals.values()].find(
      (item) => !sessionId || item.sessionId === sessionId,
    ) ?? this.pendingApprovals.values().next().value;
    if (!pending) return false;
    return await this.answerApproval(pending, action);
  }

  async resolveAllApprovals(action: "confirm" | "deny"): Promise<number> {
    let count = 0;
    for (const pending of [...this.pendingApprovals.values()]) {
      if (await this.answerApproval(pending, action)) count += 1;
    }
    return count;
  }

  async resolveApprovalRequest(
    requestId: string,
    action: "confirm" | "confirm_session" | "deny",
  ): Promise<boolean> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    return await this.answerApproval(pending, action === "deny" ? "deny" : "confirm");
  }

  async resolveTaskApprovals(
    threadId: string,
    action: "confirm" | "confirm_session" | "deny",
  ): Promise<number> {
    let count = 0;
    for (const pending of [...this.pendingApprovals.values()]) {
      if (pending.sessionId !== threadId) continue;
      if (await this.answerApproval(pending, action === "deny" ? "deny" : "confirm")) {
        count += 1;
      }
    }
    return count;
  }

  getPendingTaskApprovals(threadId: string): ApprovalRequest[] {
    return [...this.pendingApprovals.values()]
      .filter((pending) => pending.sessionId === threadId)
      .map((pending) => pending.request);
  }

  async submitUserInput(answers: Record<string, string[]>): Promise<boolean> {
    const sessionId = this.state.sharedSessionId;
    const pending = [...this.pendingQuestions.values()].find(
      (item) => !sessionId || item.sessionId === sessionId,
    ) ?? this.pendingQuestions.values().next().value;
    if (!pending) return false;
    return await this.answerQuestion(pending, answers);
  }

  getPendingTaskUserInput(threadId: string): UserInputRequest | null {
    const pending = [...this.pendingQuestions.values()].find((item) => item.sessionId === threadId);
    return pending ? structuredClone(pending.request) : null;
  }

  async submitTaskUserInput(
    threadId: string,
    answers: Record<string, string[]>,
  ): Promise<boolean> {
    const pending = [...this.pendingQuestions.values()].find(
      (item) => item.sessionId === threadId,
    );
    if (!pending) return false;
    return await this.answerQuestion(pending, answers);
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    this.clearMuxNoticeTimers();
    this.muxAbortController?.abort();
    this.muxAbortController = null;
    const muxTask = this.muxTask;
    this.muxTask = null;
    if (muxTask) {
      await Promise.race([
        muxTask.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    }
    this.setStatus("stopped");
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  private async createSessionAt(cwd: string, emitSwitch = true): Promise<void> {
    const created = await this.client.createSession(cwd);
    await this.client.selectModel(created.sessionId, {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
    });
    this.setSessionId(created.sessionId, cwd);
    this.setStatus("idle");
    if (emitSwitch) {
      this.emit({
        type: "session_switched",
        sessionId: created.sessionId,
        source: "wechat",
        reason: "wechat_resume",
        timestamp: nowIso(),
      });
    }
  }

  private async runMuxLoop(signal: AbortSignal): Promise<void> {
    let consecutiveFailures = 0;
    while (!this.disposing && !signal.aborted) {
      let connectedAt: number | undefined;
      try {
        let receivedEnvelope = false;
        for await (const envelope of this.client.openMux(signal)) {
          if (!receivedEnvelope) {
            receivedEnvelope = true;
            connectedAt = performance.now();
            this.scheduleMuxRecoveryNotice();
          }
          if (this.disposing || signal.aborted) return;
          this.handleMuxEnvelope(envelope);
        }
      } catch (error) {
        if (this.disposing || signal.aborted) return;
        this.clearMuxRecoveryTimer();
        this.scheduleMuxOutageNotice(error);
      }
      // Only sustained recovery resets backoff; a brief ready/disconnect loop
      // must still back off. Use monotonic time so wall-clock changes are safe.
      if (connectedAt !== undefined && performance.now() - connectedAt >= DEEPSEEK_HARNESS_RECOVERY_STABLE_MS) {
        consecutiveFailures = 0;
      }
      const retryDelayMs = Math.min(
        30_000,
        DEEPSEEK_HARNESS_RECONNECT_MS * (2 ** Math.min(consecutiveFailures, 5)),
      );
      consecutiveFailures += 1;
      await waitForAbortableDelay(retryDelayMs, signal);
    }
  }

  private clearMuxRecoveryTimer(): void {
    if (this.muxRecoveryStableTimer) clearTimeout(this.muxRecoveryStableTimer);
    this.muxRecoveryStableTimer = null;
  }

  private clearMuxNoticeTimers(): void {
    if (this.muxOutageNoticeTimer) clearTimeout(this.muxOutageNoticeTimer);
    this.muxOutageNoticeTimer = null;
    this.clearMuxRecoveryTimer();
  }

  private scheduleMuxOutageNotice(error: unknown): void {
    if (this.muxOutageNoticeActive || this.muxOutageNoticeTimer) return;
    this.muxOutageNoticeTimer = setTimeout(() => {
      this.muxOutageNoticeTimer = null;
      if (this.disposing || this.muxOutageNoticeActive) return;
      const now = Date.now();
      if (now - this.muxLastOutageNoticeAt < DEEPSEEK_HARNESS_DISCONNECT_RENOTIFY_MS) return;
      this.muxOutageNoticeActive = true;
      this.muxLastOutageNoticeAt = now;
      this.emit({
        type: "notice",
        level: "warning",
        text: `DeepSeek Harness 事件连接暂时中断，正在自动恢复：${truncatePreview(error instanceof Error ? error.message : String(error), 160)}`,
        timestamp: nowIso(),
      });
    }, DEEPSEEK_HARNESS_DISCONNECT_NOTICE_DEBOUNCE_MS);
  }

  private scheduleMuxRecoveryNotice(): void {
    if (!this.muxOutageNoticeActive) {
      // The socket recovered before the debounce window elapsed: cancel the
      // pending warning instead of reporting a false outage after recovery.
      if (this.muxOutageNoticeTimer) clearTimeout(this.muxOutageNoticeTimer);
      this.muxOutageNoticeTimer = null;
      return;
    }
    if (this.muxRecoveryStableTimer) return;
    this.muxRecoveryStableTimer = setTimeout(() => {
      this.muxRecoveryStableTimer = null;
      if (this.disposing || !this.muxOutageNoticeActive) return;
      this.muxOutageNoticeActive = false;
      this.muxLastOutageNoticeAt = 0;
      this.emit({
        type: "notice",
        level: "info",
        text: "DeepSeek Harness 事件连接已恢复。",
        timestamp: nowIso(),
      });
    }, DEEPSEEK_HARNESS_RECOVERY_STABLE_MS);
  }

  private handleMuxEnvelope(envelope: DeepSeekHarnessEnvelope): void {
    const frame = envelope.payload;
    switch (frame.type) {
      case "session/event":
        this.handleSessionEvent(frame.sessionId, frame.event, "stream");
        return;
      case "session/subscribed":
        this.reconcileSessionHistoryInBackground(frame.sessionId);
        return;
      case "approval/requested":
        this.handleApprovalRequested(envelope.rpcId, frame);
        return;
      case "approval/resolved":
        this.handleApprovalResolved(frame.sessionId, frame.approvalId);
        return;
      case "question/requested":
        this.handleQuestionRequested(envelope.rpcId, frame);
        return;
      case "question/resolved":
        this.pendingQuestions.delete(frame.questionRpcId);
        this.refreshPendingState(frame.sessionId);
        return;
      case "stream/error":
        this.emit({
          type: "notice",
          level: "warning",
          text: `DeepSeek Harness 事件流报错：${truncatePreview(describeRpcError(frame.error), 200)}`,
          timestamp: nowIso(),
        });
        return;
      default:
        return;
    }
  }

  private handleSessionEvent(
    sessionId: string,
    event: DeepSeekHarnessSessionEvent,
    source: "stream" | "history",
  ): void {
    const data = isRecord(event.data) ? event.data : null;
    switch (event.type) {
      case "turn/start": {
        const turn = readNumber(data?.turn);
        if (turn === undefined) return;
        this.currentTurnBySession.set(sessionId, turn);
        const key = turnKey(sessionId, turn);
        if (!this.turnOriginByKey.has(key)) this.turnOriginByKey.set(key, "local");
        if (sessionId === this.state.sharedSessionId) {
          this.state.activeTurnId = String(turn);
          this.state.activeTurnOrigin = this.turnOriginByKey.get(key);
          this.setStatus("busy");
        }
        return;
      }
      case "user/message": {
        const source = isRecord(data?.source) ? data.source : null;
        const rpcId = source?.kind === "user" ? readString(source.rpcId) : undefined;
        const turn = this.currentTurnBySession.get(sessionId);
        if (!rpcId || turn === undefined) return;
        const key = turnKey(sessionId, turn);
        const origin: HarnessTurnOrigin =
          this.promptRpcIds.has(rpcId) ||
            this.promptRpcIdByTurn.get(key) === rpcId ||
            this.turnOriginByKey.get(key) === "wechat"
            ? "wechat"
            : "local";
        this.turnOriginByKey.set(key, origin);
        this.promptRpcIdByTurn.set(key, rpcId);
        if (sessionId === this.state.sharedSessionId) {
          this.state.activeTurnId = String(turn);
          this.state.activeTurnOrigin = origin;
        }
        return;
      }
      case "assistant/message": {
        const message = assistantMessageFromEvent(event);
        const turn = readNumber(data?.turn);
        if (!message || turn === undefined) return;
        const key = turnKey(sessionId, turn);
        const parts = this.replyTextByTurn.get(key) ?? [];
        if (!parts.includes(message.text)) parts.push(message.text);
        this.replyTextByTurn.set(key, parts);
        this.replyTimestampByTurn.set(key, event.time);
        return;
      }
      case "tool/call": {
        const callId = readString(data?.callId);
        if (callId) this.toolCalls.set(callKey(sessionId, callId), data);
        return;
      }
      case "turn/end": {
        const turn = readNumber(data?.turn);
        if (turn === undefined || !data) return;
        const key = turnKey(sessionId, turn);
        const origin = this.turnOriginByKey.get(key) ?? "local";
        if (
          source === "stream" &&
          ((origin === "local" && this.hasPendingWechatPrompt(sessionId)) ||
            (origin === "wechat" && !(this.replyTextByTurn.get(key)?.length)))
        ) {
          this.reconcileSessionHistoryInBackground(sessionId);
          return;
        }
        this.finishTurn(sessionId, turn, data, event.time);
        return;
      }
      default:
        return;
    }
  }

  private finishTurn(
    sessionId: string,
    turn: number,
    data: UnknownRecord,
    completedAtMs: number,
  ): void {
    const key = turnKey(sessionId, turn);
    if (this.deliveredTurns.has(key)) return;
    this.deliveredTurns.add(key);
    const origin = this.turnOriginByKey.get(key) ?? "local";
    const reason = isRecord(data.reason) ? data.reason : null;
    const reasonKind = readString(reason?.kind) ?? "unknown";
    const text = (this.replyTextByTurn.get(key) ?? []).join("\n\n").trim();
    if (sessionId === this.state.sharedSessionId) {
      this.state.activeTurnId = undefined;
      this.state.activeTurnOrigin = undefined;
      this.setStatus("idle");
    }
    if (origin === "wechat") {
      if (text) {
        this.emit({
          type: "final_reply",
          text,
          timestamp: new Date(this.replyTimestampByTurn.get(key) ?? completedAtMs).toISOString(),
          threadId: sessionId,
          turnId: String(turn),
          origin,
        });
      }
      if (reasonKind === "error") {
        this.emit({
          type: "task_failed",
          message: deepSeekHarnessFailureMessage(reason) ?? "DeepSeek Harness 任务执行失败。",
          timestamp: new Date(completedAtMs).toISOString(),
          threadId: sessionId,
          turnId: String(turn),
          origin,
        });
      } else {
        this.emit({
          type: "task_complete",
          outcome: reasonKind === "completed" ? "completed" : "interrupted",
          summary: text || undefined,
          timestamp: new Date(completedAtMs).toISOString(),
          threadId: sessionId,
          turnId: String(turn),
          origin,
        });
      }
    }
    const promptRpcId = this.promptRpcIdByTurn.get(key);
    if (promptRpcId) {
      this.promptRpcIds.delete(promptRpcId);
      this.promptSessionByRpcId.delete(promptRpcId);
    }
    this.promptRpcIdByTurn.delete(key);
    this.replyTextByTurn.delete(key);
    this.replyTimestampByTurn.delete(key);
    this.turnOriginByKey.delete(key);
    if (this.currentTurnBySession.get(sessionId) === turn) {
      this.currentTurnBySession.delete(sessionId);
    }
  }

  private handleApprovalRequested(
    rpcId: string,
    frame: Extract<DeepSeekHarnessMuxFrame, { type: "approval/requested" }>,
  ): void {
    const turn = this.currentTurnBySession.get(frame.sessionId);
    const origin = turn === undefined
      ? "local"
      : this.turnOriginByKey.get(turnKey(frame.sessionId, turn)) ?? "local";
    const call = frame.callId
      ? this.toolCalls.get(callKey(frame.sessionId, frame.callId))
      : undefined;
    const preview = truncatePreview(
      toolCallPreview(call, frame.reason ?? frame.toolName),
      800,
    );
    const request: ApprovalRequest = {
      source: "cli",
      threadId: frame.sessionId,
      ...(turn === undefined ? {} : { turnId: String(turn) }),
      origin,
      summary: `DeepSeek Harness 请求执行：${frame.toolName}`,
      commandPreview: preview,
      allowForSession: false,
      toolName: frame.toolName,
      detailLabel: frame.toolName,
      detailPreview: preview,
      requestId: rpcId,
      createdAt: nowIso(),
    };
    this.pendingApprovals.set(rpcId, {
      rpcId,
      sessionId: frame.sessionId,
      approvalId: frame.approvalId,
      request,
    });
    if (frame.sessionId === this.state.sharedSessionId) {
      this.state.pendingApproval = request;
      this.state.pendingApprovalOrigin = origin;
      this.setStatus("awaiting_approval");
    }
    this.emit({
      type: "approval_required",
      request,
      timestamp: nowIso(),
      threadId: frame.sessionId,
      ...(turn === undefined ? {} : { turnId: String(turn) }),
      origin,
    });
  }

  private handleApprovalResolved(sessionId: string, approvalId: string): void {
    for (const [rpcId, pending] of this.pendingApprovals) {
      if (pending.sessionId === sessionId && pending.approvalId === approvalId) {
        this.pendingApprovals.delete(rpcId);
      }
    }
    this.refreshPendingState(sessionId);
  }

  private handleQuestionRequested(
    rpcId: string,
    frame: Extract<DeepSeekHarnessMuxFrame, { type: "question/requested" }>,
  ): void {
    const turn = this.currentTurnBySession.get(frame.sessionId);
    const origin = turn === undefined
      ? "local"
      : this.turnOriginByKey.get(turnKey(frame.sessionId, turn)) ?? "local";
    const request = pendingQuestionRequest(frame.sessionId, frame.questions, origin);
    this.pendingQuestions.set(rpcId, {
      rpcId,
      sessionId: frame.sessionId,
      questions: frame.questions,
      request,
    });
    if (frame.sessionId === this.state.sharedSessionId) {
      this.state.pendingUserInput = request;
      this.state.pendingUserInputOrigin = origin;
      this.setStatus("awaiting_input");
    }
    this.emit({
      type: "user_input_required",
      request,
      timestamp: nowIso(),
      threadId: frame.sessionId,
      ...(turn === undefined ? {} : { turnId: String(turn) }),
      origin,
    });
  }

  private async answerApproval(
    pending: PendingHarnessApproval,
    action: "confirm" | "deny",
  ): Promise<boolean> {
    const receipt = await this.client.respond({
      type: "client-response",
      rpcId: pending.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: pending.sessionId,
          approvalId: pending.approvalId,
          outcome: action === "confirm" ? "allowed-once" : "rejected",
        },
      },
    });
    if (!receipt.accepted) return false;
    this.pendingApprovals.delete(pending.rpcId);
    this.refreshPendingState(pending.sessionId);
    return true;
  }

  private async answerQuestion(
    pending: PendingHarnessQuestion,
    answers: Record<string, string[]>,
  ): Promise<boolean> {
    const encoded = pending.questions.map((question) => {
      const raw = answers[question.id] ?? [];
      const labels = new Set(question.options?.map((option) => option.label) ?? []);
      const selected = raw.filter((value) => labels.has(value));
      const customParts = raw.flatMap((value) => value.startsWith("user_note: ")
        ? [value.slice("user_note: ".length).trim()]
        : labels.has(value) ? [] : [value.trim()]
      ).filter(Boolean);
      return {
        id: question.id,
        selected,
        ...(customParts.length > 0 && selected.length === 0
          ? { custom: customParts.join("; ") }
          : {}),
      };
    });
    const receipt = await this.client.respond({
      type: "client-response",
      rpcId: pending.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: pending.sessionId,
          answer: { answers: encoded },
        },
      },
    });
    if (!receipt.accepted) return false;
    this.pendingQuestions.delete(pending.rpcId);
    this.refreshPendingState(pending.sessionId);
    return true;
  }

  private refreshPendingState(sessionId: string): void {
    if (sessionId !== this.state.sharedSessionId) return;
    const approval = [...this.pendingApprovals.values()].find(
      (pending) => pending.sessionId === sessionId,
    );
    const question = [...this.pendingQuestions.values()].find(
      (pending) => pending.sessionId === sessionId,
    );
    this.state.pendingApproval = approval?.request ?? null;
    this.state.pendingUserInput = question?.request ?? null;
    if (approval) {
      this.setStatus("awaiting_approval");
    } else if (question) {
      this.setStatus("awaiting_input");
    } else if (this.currentTurnBySession.has(sessionId)) {
      this.setStatus("busy");
    } else {
      this.setStatus("idle");
    }
  }

  private clearPendingForSession(sessionId: string): void {
    for (const [rpcId, pending] of this.pendingApprovals) {
      if (pending.sessionId === sessionId) this.pendingApprovals.delete(rpcId);
    }
    for (const [rpcId, pending] of this.pendingQuestions) {
      if (pending.sessionId === sessionId) this.pendingQuestions.delete(rpcId);
    }
    if (sessionId === this.state.sharedSessionId) {
      this.state.pendingApproval = null;
      this.state.pendingUserInput = null;
    }
  }

  private clearPendingPromptsForSession(sessionId: string): void {
    for (const [rpcId, promptSessionId] of this.promptSessionByRpcId) {
      if (promptSessionId !== sessionId) continue;
      this.promptSessionByRpcId.delete(rpcId);
      this.promptRpcIds.delete(rpcId);
    }
    for (const [key, rpcId] of this.promptRpcIdByTurn) {
      if (!key.startsWith(`${sessionId}\u0000`)) continue;
      this.promptRpcIdByTurn.delete(key);
      this.promptRpcIds.delete(rpcId);
      this.promptSessionByRpcId.delete(rpcId);
    }
  }

  private hasPendingWechatPrompt(sessionId: string): boolean {
    return [...this.promptSessionByRpcId.values()].some(
      (promptSessionId) => promptSessionId === sessionId,
    );
  }

  private startSessionRecovery(sessionId: string): void {
    if (this.recoveryTaskBySession.has(sessionId)) return;
    const signal = this.muxAbortController?.signal;
    if (!signal) return;
    const task = this.runSessionRecovery(sessionId, signal).finally(() => {
      if (this.recoveryTaskBySession.get(sessionId) === task) {
        this.recoveryTaskBySession.delete(sessionId);
      }
    });
    this.recoveryTaskBySession.set(sessionId, task);
  }

  private async runSessionRecovery(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + DEEPSEEK_HARNESS_RECOVERY_MAX_MS;
    while (
      !this.disposing &&
      !signal.aborted &&
      Date.now() < deadline &&
      this.hasPendingWechatPrompt(sessionId)
    ) {
      await waitForAbortableDelay(DEEPSEEK_HARNESS_RECOVERY_INTERVAL_MS, signal);
      if (this.disposing || signal.aborted || !this.hasPendingWechatPrompt(sessionId)) return;
      await this.reconcileSessionHistory(sessionId).catch(() => undefined);
    }
  }

  private reconcileSessionHistoryInBackground(sessionId: string): void {
    if (this.historyReconciliationBySession.has(sessionId)) return;
    void this.reconcileSessionHistory(sessionId).catch((error) => {
      if (this.disposing || Date.now() - this.historyErrorNoticeAt < 30_000) return;
      this.historyErrorNoticeAt = Date.now();
      this.emit({
        type: "notice",
        level: "warning",
        timestamp: nowIso(),
        text: `DeepSeek Harness 历史同步暂时失败，连接仍保留：${truncatePreview(error instanceof Error ? error.message : String(error), 160)}`,
      });
    });
  }

  private async reconcileSessionHistory(sessionId: string): Promise<void> {
    const existing = this.historyReconciliationBySession.get(sessionId);
    if (existing) return await existing;
    const task = (async () => {
      const history = await this.client.readHistory(sessionId, {
        maxMessages: DEEPSEEK_HISTORY_LIMIT,
      });
      const entries = [...history.events].sort(
        (left, right) => left.event.seq - right.event.seq,
      );
      for (const { event } of entries) {
        this.handleSessionEvent(sessionId, event, "history");
      }
    })().finally(() => {
      if (this.historyReconciliationBySession.get(sessionId) === task) {
        this.historyReconciliationBySession.delete(sessionId);
      }
    });
    this.historyReconciliationBySession.set(sessionId, task);
    await task;
  }

  private setSessionId(sessionId: string, cwd?: string): void {
    this.state.sharedSessionId = sessionId;
    this.state.activeRuntimeSessionId = sessionId;
    this.state.cwd = cwd ?? this.options.cwd;
  }

  private requireSessionId(): string {
    const sessionId = this.state.sharedSessionId;
    if (!sessionId) throw new Error("DeepSeek Harness 尚未选择任务。");
    return sessionId;
  }

  private setStatus(status: BridgeAdapterState["status"], message?: string): void {
    this.state.status = status;
    this.emit({
      type: "status",
      status,
      ...(message ? { message } : {}),
      timestamp: nowIso(),
    });
  }

  private emit(event: BridgeEvent): void {
    this.eventSink(event);
  }
}

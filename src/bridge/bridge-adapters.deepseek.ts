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
  BridgeSessionProgressItem,
  BridgeSessionRunSummary,
  BridgeSessionSendResult,
  BridgeTurnInputItem,
  UserInputRequest,
} from "./bridge-types.ts";
import type { AdapterOptions, EventSink } from "./bridge-adapters.shared.ts";
import { nowIso, truncatePreview } from "./bridge-utils.ts";

const DEFAULT_DEEPSEEK_HARNESS_URL = "http://127.0.0.1:3080";
const DEEPSEEK_HARNESS_URL_ENV = "WERELAY_DEEPSEEK_HARNESS_URL";
const DEEPSEEK_HARNESS_HTTP_TIMEOUT_MS = 10_000;
const DEEPSEEK_HARNESS_RECONNECT_MS = 1_000;
const DEEPSEEK_HARNESS_RECOVERY_INTERVAL_MS = 2_000;
const DEEPSEEK_HARNESS_RECOVERY_MAX_MS = 30 * 60_000;
const DEEPSEEK_HARNESS_DISCONNECT_RENOTIFY_MS = 10 * 60_000;
const DEEPSEEK_HISTORY_LIMIT = 100;

type UnknownRecord = Record<string, unknown>;

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
  current: DeepSeekHarnessModelSelection;
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
};

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

function discoverDeepSeekDesktopHarnessBaseUrl(
  discovery: DeepSeekHarnessEndpointDiscovery = {},
): string | null {
  if ((discovery.platform ?? process.platform) !== "darwin") {
    return null;
  }
  const processList = (discovery.readProcessList ?? readDeepSeekDesktopProcessList)();
  const desktopPids = processList.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match?.[1] || !match[2]) return [];
    return match[2].trim() ===
        "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop"
      ? [Number(match[1])]
      : [];
  }).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  const readListeners = discovery.readListeners ?? readDeepSeekDesktopListeners;
  for (const pid of desktopPids) {
    const listenerOutput = readListeners(pid);
    const match = listenerOutput.match(
      /^n(?:127(?:\.\d{1,3}){3}|\[?::1\]?):([1-9]\d{0,4})$/m,
    );
    const port = match?.[1] ? Number(match[1]) : 0;
    if (port > 0 && port <= 65_535) {
      return `http://127.0.0.1:${port}`;
    }
  }
  return null;
}

export function resolveDeepSeekHarnessBaseUrl(
  value = process.env[DEEPSEEK_HARNESS_URL_ENV],
  discovery: DeepSeekHarnessEndpointDiscovery = {},
): string {
  if (value?.trim()) {
    return normalizeDeepSeekHarnessBaseUrl(value);
  }
  return discoverDeepSeekDesktopHarnessBaseUrl(discovery) ??
    DEFAULT_DEEPSEEK_HARNESS_URL;
}

export class DeepSeekHarnessHttpClient implements DeepSeekHarnessClientLike {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async describeHost() {
    return (await this.call<ReturnType<DeepSeekHarnessClientLike["describeHost"]> extends Promise<infer T> ? T : never>(
      "host.describe",
      {},
    )).value;
  }

  async listSessions(): Promise<DeepSeekHarnessSessionSummary[]> {
    const result = await this.call<{ items: DeepSeekHarnessSessionSummary[] }>(
      "session.list",
      {},
    );
    return result.value.items;
  }

  async createSession(cwd: string): Promise<{ sessionId: string }> {
    return (await this.call<{ sessionId: string }>("session.create", { cwd })).value;
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.call("session.rename", { sessionId, title });
  }

  async readHistory(
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number } = {},
  ) {
    return (await this.call<{
      events: DeepSeekHarnessHistoryEntry[];
      hasMore: boolean;
      projections?: { asOfSeq?: number; values?: Record<string, unknown> };
    }>("session.history", { sessionId, ...options })).value;
  }

  async readModels(sessionId: string): Promise<DeepSeekHarnessModelState> {
    return (await this.call<DeepSeekHarnessModelState>("session.models", { sessionId })).value;
  }

  async selectModel(
    sessionId: string,
    selection: DeepSeekHarnessModelSelection,
  ): Promise<{ selected: DeepSeekHarnessModelSelection }> {
    return (await this.call<{ selected: DeepSeekHarnessModelSelection }>(
      "session.selectModel",
      { sessionId, ...selection },
    )).value;
  }

  async prompt(
    sessionId: string,
    content: DeepSeekHarnessPromptContent[],
    requestId = crypto.randomUUID(),
  ): Promise<{ rpcId: string; value: { accepted: true } }> {
    return await this.call<{ accepted: true }>(
      "session.prompt",
      {
        sessionId,
        mode: "queue",
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
      },
      requestId,
    );
  }

  async cancelSession(sessionId: string): Promise<{ accepted: true }> {
    return (await this.call<{ accepted: true }>("session.cancel", { sessionId })).value;
  }

  async respond(message: DeepSeekHarnessClientResponse): Promise<{
    accepted: boolean;
    reason?: string;
  }> {
    const response = await this.fetchFn(new URL("/api/respond", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(DEEPSEEK_HARNESS_HTTP_TIMEOUT_MS),
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
    const url = new URL("/api/events.mux", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
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
      signal: AbortSignal.timeout(DEEPSEEK_HARNESS_HTTP_TIMEOUT_MS),
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

function sessionCandidate(
  summary: DeepSeekHarnessSessionSummary,
  pendingApprovals = false,
  pendingQuestions = false,
): BridgeResumeSessionCandidate {
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
    ...(summary.cwd ? { cwd: summary.cwd } : {}),
    ...(summary.cwd
      ? {
          projectId: summary.cwd,
          projectName: path.basename(summary.cwd) || "DeepSeek Harness",
        }
      : {}),
    runtimeStatus,
  };
}

export async function listDeepSeekHarnessSessions(
  limit = 100,
  baseUrl = resolveDeepSeekHarnessBaseUrl(),
): Promise<BridgeResumeSessionCandidate[]> {
  const client = new DeepSeekHarnessHttpClient(baseUrl);
  return (await client.listSessions()).slice(0, Math.max(0, limit)).map((item) =>
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
      isOther: !question.options?.length,
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
  private readonly client: DeepSeekHarnessClientLike;
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
  private muxOutageNoticeActive = false;
  private muxLastOutageNoticeAt = 0;

  constructor(
    options: AdapterOptions,
    dependencies?: DeepSeekHarnessAdapterDependencies,
  ) {
    this.options = options;
    const resolvedDependencies = dependencies ?? {
      createClient: (baseUrl: string) => new DeepSeekHarnessHttpClient(baseUrl),
    };
    this.client = resolvedDependencies.createClient(
      dependencies
        ? normalizeDeepSeekHarnessBaseUrl()
        : resolveDeepSeekHarnessBaseUrl(),
    );
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

  async start(): Promise<void> {
    if (this.muxTask) return;
    this.disposing = false;
    this.muxOutageNoticeActive = false;
    this.muxLastOutageNoticeAt = 0;
    this.setStatus("starting", "正在连接 DeepSeek Harness。");
    try {
      await this.client.describeHost();
      const sessions = (await this.client.listSessions()).sort(
        (left, right) => right.updatedAt - left.updatedAt,
      );
      const requestedSessionId = this.state.sharedSessionId;
      let selected: DeepSeekHarnessSessionSummary | undefined;
      if (this.options.sessionStartMode === "new") {
        await this.createSessionAt(this.options.cwd, false);
      } else {
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
      }
      this.state.startedAt = nowIso();
      this.setStatus(selected?.running ? "busy" : "idle");
      this.muxAbortController = new AbortController();
      this.muxTask = this.runMuxLoop(this.muxAbortController.signal);
    } catch (error) {
      this.setStatus("error", "无法连接 DeepSeek Harness，请确认 DSH Desktop 或 dsh web 正在本机运行。");
      throw error;
    }
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
      const visionModel = models.current.provider === "deepseek-official" &&
          models.current.model === "deepseek-v4-flash"
        ? models.groups.find((group) => group.id === models.current.provider)?.models.find(
          (model) => model.id === "deepseek-v4-flash-vision-exp",
        )
        : undefined;
      if (visionModel) {
        await this.client.selectModel(sessionId, {
          provider: models.current.provider,
          model: visionModel.id,
          ...(models.current.reasoningEffort
            ? { reasoningEffort: models.current.reasoningEffort }
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
    return sessions.slice(0, Math.max(0, limit)).map((item) => sessionCandidate(
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

  async getSessionModelState(sessionId: string): Promise<BridgeSessionModelState> {
    const state = await this.client.readModels(sessionId);
    return {
      currentModel: this.modelSelectionId(state.current.provider, state.current.model),
      options: state.groups.flatMap((group) => group.models.map((model) => ({
        id: this.modelSelectionId(group.id, model.id),
        label: `${group.name} · ${model.name}`,
        ...(model.description ? { description: model.description } : {}),
      }))),
      canChange: state.routable,
      ...(!state.routable
        ? { unavailableReason: "DeepSeek Harness 当前模型路由不可用。" }
        : {}),
    };
  }

  async setSessionModel(
    sessionId: string,
    model: string,
  ): Promise<BridgeSessionModelState> {
    const current = await this.client.readModels(sessionId);
    const exact = this.parseModelSelectionId(model);
    const group = exact
      ? current.groups.find((item) =>
          item.id === exact.provider &&
          item.models.some((candidate) => candidate.id === exact.model)
        )
      : current.groups.find((item) =>
          item.id === current.current.provider &&
          item.models.some((candidate) => candidate.id === model)
        ) ?? current.groups.find((item) =>
          item.models.some((candidate) => candidate.id === model)
        );
    const selectedModel = exact?.model ?? model;
    if (!group) throw new Error(`DeepSeek Harness 没有提供模型 ${model}。`);
    await this.client.selectModel(sessionId, {
      provider: group.id,
      model: selectedModel,
      ...(selectedModel === "deepseek-v4-flash" ? { reasoningEffort: "high" } : {}),
    });
    return await this.getSessionModelState(sessionId);
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
    while (!this.disposing && !signal.aborted) {
      let reconnected = false;
      try {
        for await (const envelope of this.client.openMux(signal)) {
          if (!reconnected) {
            reconnected = true;
            if (this.muxOutageNoticeActive) {
              this.muxOutageNoticeActive = false;
              this.muxLastOutageNoticeAt = 0;
              this.emit({
                type: "notice",
                level: "info",
                text: "DeepSeek Harness 事件连接已恢复。",
                timestamp: nowIso(),
              });
            }
          }
          if (this.disposing || signal.aborted) return;
          this.handleMuxEnvelope(envelope);
        }
      } catch (error) {
        if (this.disposing || signal.aborted) return;
        const now = Date.now();
        if (!this.muxOutageNoticeActive || now - this.muxLastOutageNoticeAt >= DEEPSEEK_HARNESS_DISCONNECT_RENOTIFY_MS) {
          const firstNotice = !this.muxOutageNoticeActive;
          this.muxOutageNoticeActive = true;
          this.muxLastOutageNoticeAt = now;
          this.emit({
            type: "notice",
            level: "warning",
            text: `DeepSeek Harness 事件连接已断开，${firstNotice ? "正在重连" : "仍未恢复，每10分钟提醒一次"}：${truncatePreview(error instanceof Error ? error.message : String(error), 160)}`,
            timestamp: nowIso(),
          });
        }
      }
      await waitForAbortableDelay(DEEPSEEK_HARNESS_RECONNECT_MS, signal);
    }
  }

  private handleMuxEnvelope(envelope: DeepSeekHarnessEnvelope): void {
    const frame = envelope.payload;
    switch (frame.type) {
      case "session/event":
        this.handleSessionEvent(frame.sessionId, frame.event, "stream");
        return;
      case "session/subscribed":
        void this.reconcileSessionHistory(frame.sessionId);
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
          void this.reconcileSessionHistory(sessionId);
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

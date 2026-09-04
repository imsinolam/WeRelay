import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterState,
  BridgeEvent,
  BridgeResumeSessionCandidate,
  BridgeSessionMessage,
  BridgeSessionSendResult,
} from "./bridge-types.ts";
import type { BridgeAdapterKind } from "./bridge-providers.ts";
import {
  type AdapterOptions,
  type EventSink,
  buildCliEnvironment,
  resolveSpawnTarget,
} from "./bridge-adapters.shared.ts";
import {
  describeUnknownError,
  isRecord,
} from "./bridge-adapter-common.ts";
import {
  normalizeOutput,
  nowIso,
  truncatePreview,
} from "./bridge-utils.ts";

export type AcpProviderKind = Extract<BridgeAdapterKind, "grok" | "codebuddy">;

type AcpRequestId = string | number;

type AcpPermissionOption = {
  optionId: string;
  name?: string;
  kind?: string;
};

type PendingAcpPermission = {
  options: AcpPermissionOption[];
  request: ApprovalRequest;
  resolution:
    | { type: "rpc"; rpcId: AcpRequestId }
    | {
        type: "codebuddy_interruption";
        sessionId: string;
        toolCallId: string;
      };
};

export type AcpTransportCallbacks = {
  message: (message: unknown) => void;
  stderr: (text: string) => void;
  failure: (error: Error) => void;
  close: (code: number | null) => void;
};

export interface AcpTransport {
  readonly pid?: number;
  start(): Promise<void>;
  send(message: Record<string, unknown>): Promise<void>;
  dispose(): Promise<void>;
}

type AcpProviderConfig = {
  kind: AcpProviderKind;
  buildArgs: (options: AdapterOptions) => string[];
  createTransport?: (
    options: AdapterOptions,
    cwd: string,
    environmentOverrides: Record<string, string>,
    callbacks: AcpTransportCallbacks,
  ) => AcpTransport;
  listSessions?: (
    request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
    cwd: string,
    limit: number,
  ) => Promise<BridgeResumeSessionCandidate[]>;
  readSessionMessages?: (
    cwd: string,
    sessionId: string,
  ) => Promise<BridgeSessionMessage[]>;
  resolveSessionCwd?: (sessionId: string) => string | null;
  resolveSessionEnvironment?: (sessionId: string) => Record<string, string> | null;
  restartProcessForSessionCwd?: boolean;
};

type PendingRpcRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

const ACP_REQUEST_TIMEOUT_MS = 30_000;
const ACP_PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const ACP_PROCESS_STOP_TIMEOUT_MS = 1_000;

function waitForChildProcessClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
  });
}

class StdioAcpTransport implements AcpTransport {
  private readonly options: AdapterOptions;
  private readonly config: AcpProviderConfig;
  private readonly cwd: string;
  private readonly environmentOverrides: Record<string, string>;
  private readonly callbacks: AcpTransportCallbacks;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lineReader: readline.Interface | null = null;
  private disposing = false;

  constructor(
    options: AdapterOptions,
    config: AcpProviderConfig,
    cwd: string,
    environmentOverrides: Record<string, string>,
    callbacks: AcpTransportCallbacks,
  ) {
    this.options = options;
    this.config = config;
    this.cwd = cwd;
    this.environmentOverrides = environmentOverrides;
    this.callbacks = callbacks;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    const target = resolveSpawnTarget(this.options.command, this.config.kind);
    const child = spawn(target.file, [...target.args, ...this.config.buildArgs(this.options)], {
      cwd: this.cwd,
      env: {
        ...buildCliEnvironment(this.config.kind),
        ...this.environmentOverrides,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const lineReader = readline.createInterface({ input: child.stdout });
    this.lineReader = lineReader;
    lineReader.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        const text = normalizeOutput(line);
        if (text) this.callbacks.stderr(text);
        return;
      }
      this.callbacks.message(message);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = normalizeOutput(String(chunk));
      if (text) this.callbacks.stderr(text);
    });
    child.once("error", (error) => {
      if (!this.disposing) this.callbacks.failure(error);
    });
    child.once("close", (code) => {
      if (!this.disposing) this.callbacks.close(code);
    });
  }

  async send(message: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new Error(`${this.config.kind} ACP 未连接。`);
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    this.lineReader?.close();
    this.lineReader = null;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill("SIGTERM");
    if (await waitForChildProcessClose(child, ACP_PROCESS_STOP_TIMEOUT_MS)) {
      return;
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForChildProcessClose(child, ACP_PROCESS_STOP_TIMEOUT_MS);
    }
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value) && typeof value.text === "string") {
    return value.text;
  }
  if (Array.isArray(value)) {
    return value.map(contentText).filter(Boolean).join("");
  }
  return "";
}

function permissionOptionKind(option: AcpPermissionOption): string {
  return `${option.kind ?? ""} ${option.name ?? ""}`.toLowerCase();
}

export function selectAcpPermissionOption(
  options: AcpPermissionOption[],
  action: "confirm" | "confirm_session" | "deny",
): AcpPermissionOption | null {
  const preferred = action === "confirm_session"
    ? [/allow.*always/, /always.*allow/, /allow/]
    : action === "confirm"
      ? [/allow.*once/, /once.*allow/, /allow/]
      : [/reject.*once/, /deny.*once/, /reject/, /deny/];
  for (const pattern of preferred) {
    const match = options.find((option) => pattern.test(permissionOptionKind(option)));
    if (match) {
      return match;
    }
  }
  return null;
}

export function normalizeAcpSessionCandidates(
  value: unknown,
  cwd: string,
  limit: number,
): BridgeResumeSessionCandidate[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    return [];
  }
  return value.sessions.flatMap((entry): BridgeResumeSessionCandidate[] => {
    if (!isRecord(entry)) {
      return [];
    }
    const sessionId = readString(entry.sessionId) ?? readString(entry.id);
    if (!sessionId) {
      return [];
    }
    const sessionCwd = readString(entry.cwd) ?? cwd;
    const customTitle = readString(entry.customTitle);
    const projectName = customTitle
      ? sessionCwd.split(/[\\/]/).filter(Boolean).at(-1)
      : undefined;
    const lastUpdatedAt = readString(entry.updatedAt) ?? readString(entry.lastUpdatedAt) ?? nowIso();
    return [{
      sessionId,
      threadId: sessionId,
      title: customTitle ?? readString(entry.title) ?? `会话 ${sessionId.slice(0, 8)}`,
      lastUpdatedAt,
      cwd: sessionCwd,
      ...(projectName ? { projectName } : {}),
    }];
  }).sort((left, right) =>
    Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt)
  ).slice(0, Math.max(1, limit));
}

export class AcpBridgeAdapter implements BridgeAdapter {
  private readonly options: AdapterOptions;
  private readonly config: AcpProviderConfig;
  private readonly state: BridgeAdapterState;
  private eventSink: EventSink = () => undefined;
  private transport: AcpTransport | null = null;
  private requestCounter = 0;
  private pendingRequests = new Map<AcpRequestId, PendingRpcRequest>();
  private pendingPermission: PendingAcpPermission | null = null;
  private loadingSession = false;
  private shuttingDown = false;
  private activePromptRequestId: AcpRequestId | null = null;
  private currentReply = "";
  private readonly messageCache = new Map<string, BridgeSessionMessage[]>();
  private readonly sessionCwdById = new Map<string, string>();
  private processCwd: string;
  private processEnvironmentOverrides: Record<string, string> = {};
  private processGeneration = 0;

  constructor(options: AdapterOptions, config: AcpProviderConfig) {
    this.options = options;
    this.config = config;
    this.processCwd = options.cwd;
    const shouldRestore = options.sessionStartMode !== "new";
    const initialSessionId = shouldRestore
      ? options.initialSharedSessionId ?? options.initialSharedThreadId
      : undefined;
    this.state = {
      kind: config.kind,
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
    if (this.transport) {
      return;
    }
    this.shuttingDown = false;
    this.setStatus("starting", `正在连接 ${this.config.kind}。`);
    await this.startProcess(this.processCwd);

    const initialSessionId = this.state.sharedSessionId;
    if (initialSessionId && this.options.sessionStartMode !== "new") {
      try {
        await this.loadSession(initialSessionId, "restore", "startup_restore");
      } catch (error) {
        await this.dispose();
        this.setStatus("error");
        throw new Error(
          `无法恢复原 ${this.config.kind} 任务。请确认任务仍存在后重试；为避免会话分叉，未新建替代任务。`,
          { cause: error },
        );
      }
    } else {
      await this.createSession();
    }
    this.setStatus("idle");
  }

  private async startProcess(
    cwd: string,
    environmentOverrides: Record<string, string> = this.processEnvironmentOverrides,
  ): Promise<void> {
    const generation = ++this.processGeneration;
    const callbacks: AcpTransportCallbacks = {
      message: (message) => {
        if (generation === this.processGeneration) this.handleMessage(message);
      },
      stderr: (text) => {
        if (generation !== this.processGeneration) return;
        this.state.lastOutputAt = nowIso();
        this.emit({ type: "stderr", text, timestamp: nowIso() });
      },
      failure: (error) => this.handleProcessFailure(error, generation),
      close: (code) => this.handleProcessClose(code, generation),
    };
    const transport = this.config.createTransport
      ? this.config.createTransport(this.options, cwd, environmentOverrides, callbacks)
      : new StdioAcpTransport(this.options, this.config, cwd, environmentOverrides, callbacks);
    this.transport = transport;
    this.processEnvironmentOverrides = { ...environmentOverrides };
    await transport.start();
    if (generation !== this.processGeneration) {
      await transport.dispose();
      return;
    }
    this.state.pid = transport.pid;
    this.state.startedAt = nowIso();

    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
  }

  async sendInput(text: string): Promise<void> {
    const sessionId = this.requireSessionId();
    if (this.state.status === "busy") {
      throw new Error(`${this.config.kind} 仍在处理，请等待当前回复或发送 /stop。`);
    }
    if (this.pendingPermission) {
      throw new Error(`${this.config.kind} 正在等待审批。`);
    }
    const normalized = text.trim();
    if (!normalized) {
      throw new Error("消息不能为空。");
    }

    this.currentReply = "";
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "wechat";
    this.setStatus("busy");
    this.appendCachedMessage(sessionId, { role: "user", text });
    const requestId = ++this.requestCounter;
    this.activePromptRequestId = requestId;
    void this.runPrompt(sessionId, text, requestId);
  }

  private async runPrompt(
    sessionId: string,
    text: string,
    requestId: AcpRequestId,
  ): Promise<void> {
    try {
      await this.requestWithId(requestId, "session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      }, ACP_PROMPT_TIMEOUT_MS);
      if (this.activePromptRequestId !== requestId) {
        return;
      }
      this.activePromptRequestId = null;
      const finalText = this.currentReply.trim();
      if (finalText) {
        this.appendCachedMessage(sessionId, {
          role: "assistant",
          text: finalText,
          phase: "final_answer",
        });
        this.emit({
          type: "final_reply",
          text: finalText,
          timestamp: nowIso(),
          threadId: sessionId,
          origin: "wechat",
        });
      }
      this.setStatus("idle");
      this.emit({
        type: "task_complete",
        summary: truncatePreview(finalText || text, 240),
        outcome: "completed",
        timestamp: nowIso(),
        threadId: sessionId,
        origin: "wechat",
      });
    } catch (error) {
      this.activePromptRequestId = null;
      if (this.state.status === "idle") {
        return;
      }
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

  async sendInputToSession(
    sessionId: string,
    text: string,
  ): Promise<BridgeSessionSendResult> {
    if (sessionId !== this.state.sharedSessionId) {
      await this.resumeSession(sessionId);
    }
    await this.sendInput(text);
    return {};
  }

  async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    if (this.config.listSessions) {
      const sessions = await this.config.listSessions(
        (method, params) => this.request(method, params),
        this.options.cwd,
        limit,
      );
      for (const session of sessions) {
        if (session.cwd) this.sessionCwdById.set(session.sessionId, session.cwd);
      }
      return sessions.map((session) => this.withRuntimeStatus(session));
    }
    const sessionId = this.state.sharedSessionId;
    if (!sessionId) {
      return [];
    }
    return [this.withRuntimeStatus({
      sessionId,
      threadId: sessionId,
      title: `${this.config.kind} 当前会话`,
      lastUpdatedAt: this.state.lastOutputAt ?? this.state.startedAt ?? nowIso(),
      cwd: this.options.cwd,
    })];
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.loadSession(sessionId, "wechat", "wechat_resume");
  }

  async createSession(): Promise<void> {
    this.loadingSession = true;
    try {
      const result = await this.request("session/new", {
        cwd: this.processCwd,
        mcpServers: [],
        _meta: { autoMode: true },
      });
      const sessionId = isRecord(result)
        ? readString(result.sessionId) ?? readString(result.id)
        : undefined;
      if (!sessionId) {
        throw new Error(`${this.config.kind} 未返回会话 ID。`);
      }
      this.setSessionId(sessionId);
      this.emit({
        type: "session_switched",
        sessionId,
        source: "restore",
        reason: "startup_restore",
        timestamp: nowIso(),
      });
    } finally {
      this.loadingSession = false;
    }
  }

  async getLatestSessionMessage(sessionId: string): Promise<BridgeSessionMessage | null> {
    const messages = await this.getSessionMessages(sessionId);
    return messages.at(-1) ?? null;
  }

  async getSessionMessages(sessionId: string): Promise<BridgeSessionMessage[]> {
    if (this.config.readSessionMessages) {
      const sessionCwd = this.resolveSessionCwd(sessionId);
      const messages = await this.config.readSessionMessages(sessionCwd, sessionId);
      if (messages.length > 0) {
        return messages;
      }
    }
    return [...(this.messageCache.get(sessionId) ?? [])];
  }

  async interrupt(): Promise<boolean> {
    const sessionId = this.state.sharedSessionId;
    if (!sessionId || (this.state.status !== "busy" && this.state.status !== "awaiting_approval")) {
      return false;
    }
    this.notify("session/cancel", { sessionId });
    if (this.pendingPermission) {
      if (this.pendingPermission.resolution.type === "rpc") {
        this.respond(this.pendingPermission.resolution.rpcId, {
          outcome: { outcome: "cancelled" },
        });
      } else {
        void this.request("_codebuddy.ai/resolveInterruption", {
          sessionId: this.pendingPermission.resolution.sessionId,
          toolCallId: this.pendingPermission.resolution.toolCallId,
          decision: "deny",
        }).catch(() => undefined);
      }
      this.pendingPermission = null;
      this.state.pendingApproval = null;
    }
    if (this.activePromptRequestId !== null) {
      const pending = this.pendingRequests.get(this.activePromptRequestId);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve({ stopReason: "cancelled" });
        this.pendingRequests.delete(this.activePromptRequestId);
      }
      this.activePromptRequestId = null;
    }
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

  async reset(): Promise<void> {
    if (this.state.status === "busy" || this.state.status === "awaiting_approval") {
      await this.interrupt();
    }
    await this.createSession();
    this.setStatus("idle");
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    return this.resolvePendingPermission(action);
  }

  async resolveAllApprovals(action: "confirm" | "deny"): Promise<number> {
    return await this.resolvePendingPermission(action) ? 1 : 0;
  }

  async resolveApprovalForSession(): Promise<boolean> {
    return this.resolvePendingPermission("confirm_session");
  }

  async resolveAllApprovalsForSession(): Promise<number> {
    return await this.resolvePendingPermission("confirm_session") ? 1 : 0;
  }

  async submitUserInput(_answers: Record<string, string[]>): Promise<boolean> {
    return false;
  }

  async dispose(): Promise<void> {
    this.shuttingDown = true;
    this.processGeneration += 1;
    this.pendingPermission = null;
    this.state.pendingApproval = null;
    this.rejectPendingRequests(new Error(`${this.config.kind} 已关闭。`));
    const transport = this.transport;
    this.transport = null;
    await transport?.dispose();
    this.state.status = "stopped";
    this.state.pid = undefined;
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  private async loadSession(
    sessionId: string,
    source: "wechat" | "restore",
    reason: "wechat_resume" | "startup_restore",
  ): Promise<void> {
    this.loadingSession = true;
    try {
      const sessionCwd = this.resolveSessionCwd(sessionId);
      const sessionEnvironment = this.config.resolveSessionEnvironment?.(sessionId) ?? {};
      const environmentChanged = JSON.stringify(sessionEnvironment) !==
        JSON.stringify(this.processEnvironmentOverrides);
      if (
        (this.config.restartProcessForSessionCwd &&
          path.resolve(sessionCwd) !== path.resolve(this.processCwd)) ||
        environmentChanged
      ) {
        await this.restartProcessForSession(sessionCwd, sessionEnvironment);
      }
      await this.request("session/load", {
        sessionId,
        cwd: sessionCwd,
        mcpServers: [],
      });
      this.sessionCwdById.set(sessionId, sessionCwd);
      this.setSessionId(sessionId);
      this.emit({
        type: "session_switched",
        sessionId,
        source,
        reason,
        timestamp: nowIso(),
      });
      this.setStatus("idle");
    } finally {
      this.loadingSession = false;
    }
  }

  private async restartProcessForSession(
    cwd: string,
    environmentOverrides: Record<string, string>,
  ): Promise<void> {
    const transport = this.transport;
    this.processGeneration += 1;
    this.transport = null;
    this.state.pid = undefined;
    this.rejectPendingRequests(new Error(`${this.config.kind} 正在切换任务目录。`));
    await transport?.dispose();
    this.processCwd = cwd;
    this.processEnvironmentOverrides = { ...environmentOverrides };
    await this.startProcess(cwd, environmentOverrides);
  }

  private resolveSessionCwd(sessionId: string): string {
    const cached = this.sessionCwdById.get(sessionId);
    if (cached) return cached;
    const resolved = this.config.resolveSessionCwd?.(sessionId);
    if (resolved) {
      this.sessionCwdById.set(sessionId, resolved);
      return resolved;
    }
    return this.options.cwd;
  }

  private setSessionId(sessionId: string): void {
    this.state.sharedSessionId = sessionId;
    this.state.activeRuntimeSessionId = sessionId;
    this.state.lastSessionSwitchAt = nowIso();
  }

  private requireSessionId(): string {
    const sessionId = this.state.sharedSessionId;
    if (!sessionId) {
      throw new Error(`${this.config.kind} 尚未建立会话。`);
    }
    return sessionId;
  }

  private appendCachedMessage(sessionId: string, message: BridgeSessionMessage): void {
    const messages = this.messageCache.get(sessionId) ?? [];
    messages.push(message);
    this.messageCache.set(sessionId, messages.slice(-400));
  }

  private withRuntimeStatus(
    session: BridgeResumeSessionCandidate,
  ): BridgeResumeSessionCandidate {
    if (session.sessionId !== this.state.sharedSessionId) {
      return session;
    }
    const activeFlags = this.state.status === "awaiting_approval"
      ? ["waitingOnApproval" as const]
      : [];
    return {
      ...session,
      runtimeStatus: this.state.status === "busy" || this.state.status === "awaiting_approval"
        ? { type: "active", activeFlags }
        : { type: "idle" },
    };
  }

  private request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return this.requestWithId(++this.requestCounter, method, params, ACP_REQUEST_TIMEOUT_MS);
  }

  private requestWithId(
    id: AcpRequestId,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const transport = this.transport;
    if (!transport) {
      return Promise.reject(new Error(`${this.config.kind} ACP 未连接。`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`${this.config.kind} ACP 请求超时：${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(id, { resolve, reject, timer });
      void transport.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const transport = this.transport;
    if (!transport) {
      return;
    }
    void transport.send({ jsonrpc: "2.0", method, params }).catch((error) => {
      this.handleProcessFailure(error, this.processGeneration);
    });
  }

  private respond(id: AcpRequestId, result: unknown): void {
    const transport = this.transport;
    if (!transport) {
      return;
    }
    void transport.send({ jsonrpc: "2.0", id, result }).catch((error) => {
      this.handleProcessFailure(error, this.processGeneration);
    });
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      return;
    }
    const id = typeof message.id === "string" || typeof message.id === "number"
      ? message.id
      : null;
    if (id !== null && ("result" in message || "error" in message)) {
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      this.pendingRequests.delete(id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(new Error(this.describeRpcError(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (id !== null && typeof message.method === "string") {
      this.handleAgentRequest(id, message.method, message.params);
      return;
    }
    if (typeof message.method === "string") {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleAgentRequest(id: AcpRequestId, method: string, params: unknown): void {
    if (method !== "session/request_permission" || !isRecord(params)) {
      this.respond(id, { outcome: { outcome: "cancelled" } });
      return;
    }
    const options = Array.isArray(params.options)
      ? params.options.flatMap((entry): AcpPermissionOption[] => {
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
    const title = readString(toolCall.title) ?? readString(toolCall.name) ?? "工具操作";
    const previewValue = toolCall.rawInput ?? toolCall.input ?? params;
    const preview = typeof previewValue === "string"
      ? previewValue
      : JSON.stringify(previewValue, null, 2);
    const request: ApprovalRequest = {
      source: "cli",
      threadId: readString(params.sessionId) ?? this.state.sharedSessionId,
      origin: "wechat",
      summary: `${this.config.kind} 请求执行：${title}`,
      commandPreview: truncatePreview(preview || title, 800),
      detailLabel: title,
      detailPreview: truncatePreview(preview || title, 800),
      allowForSession: Boolean(selectAcpPermissionOption(options, "confirm_session")),
      requestId: String(id),
    };
    this.pendingPermission = {
      options,
      request,
      resolution: { type: "rpc", rpcId: id },
    };
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

  private handleNotification(method: string, params: unknown): void {
    if (method !== "session/update" && method !== "_x.ai/session/update") {
      return;
    }
    if (this.loadingSession || !isRecord(params) || !isRecord(params.update)) {
      return;
    }
    const sessionId = readString(params.sessionId);
    if (sessionId && this.state.sharedSessionId && sessionId !== this.state.sharedSessionId) {
      return;
    }
    const update = params.update;
    const updateType = readString(update.sessionUpdate) ?? readString(update.type);
    const text = contentText(update.content ?? update.text);
    this.state.lastOutputAt = nowIso();
    if (this.config.kind === "codebuddy") {
      if (updateType === "interruption_request") {
        this.handleCodeBuddyInterruption(sessionId, update);
        return;
      }
      if (updateType === "session_info_update" && isRecord(update._meta)) {
        const interruption = update._meta["codebuddy.ai/interruptionRequest"];
        if (isRecord(interruption)) {
          this.handleCodeBuddyInterruption(sessionId, interruption);
          return;
        }
        if (update._meta["codebuddy.ai/permissionResolved"] === true) {
          this.pendingPermission = null;
          this.state.pendingApproval = null;
          if (this.state.status === "awaiting_approval") this.setStatus("busy");
        }
      }
    }
    switch (updateType) {
      case "agent_message_chunk":
      case "text":
        if (text) this.currentReply += text;
        break;
      case "agent_thought_chunk":
      case "thought":
        if (text) {
          this.emit({ type: "thinking", text, timestamp: nowIso() });
        }
        break;
      case "plan":
        if (text) {
          this.emit({ type: "thinking", text, timestamp: nowIso() });
        }
        break;
      default:
        break;
    }
  }

  private handleCodeBuddyInterruption(
    sessionId: string | undefined,
    value: Record<string, unknown>,
  ): void {
    const activeSessionId = sessionId ?? this.state.sharedSessionId;
    const interruptionId = readString(value.interruptionId);
    const toolCallId = readString(value.toolCallId) ?? interruptionId?.replace(/^ir-/, "");
    if (!activeSessionId || !toolCallId) return;
    const decisions = Array.isArray(value.options)
      ? value.options.filter((entry): entry is string => typeof entry === "string")
      : ["allow", "allowAll", "deny"];
    const options: AcpPermissionOption[] = decisions.map((decision) => ({
      optionId: decision,
      name: decision,
      kind: decision === "allowAll"
        ? "allow_always"
        : decision === "allow"
          ? "allow_once"
          : "reject_once",
    }));
    const toolName = readString(value.toolName) ?? readString(value.toolTitle) ?? "工具操作";
    const reason = readString(value.reason) ?? `${toolName} 需要审批`;
    const input = value.toolInput ?? value.rawInput ?? value;
    const preview = typeof input === "string" ? input : JSON.stringify(input, null, 2);
    const request: ApprovalRequest = {
      source: "cli",
      threadId: activeSessionId,
      origin: "wechat",
      summary: `CodeBuddy 请求执行：${reason}`,
      commandPreview: truncatePreview(preview || toolName, 800),
      toolName,
      detailLabel: toolName,
      detailPreview: truncatePreview(preview || reason, 800),
      allowForSession: decisions.includes("allowAll"),
      requestId: interruptionId ?? toolCallId,
    };
    this.pendingPermission = {
      options,
      request,
      resolution: {
        type: "codebuddy_interruption",
        sessionId: activeSessionId,
        toolCallId,
      },
    };
    this.state.pendingApproval = request;
    this.setStatus("awaiting_approval");
    this.emit({
      type: "approval_required",
      request,
      timestamp: nowIso(),
      threadId: activeSessionId,
      origin: "wechat",
    });
  }

  private async resolvePendingPermission(
    action: "confirm" | "confirm_session" | "deny",
  ): Promise<boolean> {
    const pending = this.pendingPermission;
    if (!pending) {
      return false;
    }
    const option = selectAcpPermissionOption(pending.options, action);
    if (!option) {
      return false;
    }
    if (pending.resolution.type === "rpc") {
      this.respond(pending.resolution.rpcId, {
        outcome: { outcome: "selected", optionId: option.optionId },
      });
    } else {
      await this.request("_codebuddy.ai/resolveInterruption", {
        sessionId: pending.resolution.sessionId,
        toolCallId: pending.resolution.toolCallId,
        decision: option.optionId,
      });
    }
    this.pendingPermission = null;
    this.state.pendingApproval = null;
    this.setStatus("busy");
    return true;
  }

  private describeRpcError(error: unknown): string {
    if (!isRecord(error)) {
      return describeUnknownError(error);
    }
    const message = readString(error.message) ?? "ACP 请求失败";
    const data = readString(error.data);
    return data ? `${message}：${data}` : message;
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private handleProcessFailure(error: Error, generation: number): void {
    if (this.shuttingDown || generation !== this.processGeneration) return;
    this.rejectPendingRequests(error);
    this.setStatus("error");
    this.emit({
      type: "fatal_error",
      message: `${this.config.kind} ACP 启动失败：${error.message}`,
      timestamp: nowIso(),
    });
  }

  private handleProcessClose(code: number | null, generation: number): void {
    if (generation !== this.processGeneration) return;
    const expected = this.shuttingDown;
    this.transport = null;
    this.state.pid = undefined;
    this.rejectPendingRequests(new Error(`${this.config.kind} ACP 已退出。`));
    if (expected) {
      this.state.status = "stopped";
      return;
    }
    this.setStatus("error");
    this.emit({
      type: "fatal_error",
      message: `${this.config.kind} ACP 意外退出${code === null ? "" : `（代码 ${code}）`}。`,
      timestamp: nowIso(),
    });
  }

  protected setStatus(status: BridgeAdapterState["status"], message?: string): void {
    this.state.status = status;
    this.emit({ type: "status", status, message, timestamp: nowIso() });
  }

  protected emit(event: BridgeEvent): void {
    this.eventSink(event);
  }
}

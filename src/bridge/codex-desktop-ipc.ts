import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { BridgeTurnInputItem } from "./bridge-types.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_DELAY_MS = 500;
const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const INITIALIZING_CLIENT_ID = "initializing-client";
const CODEX_DESKTOP_MAIN_PROCESS_PATHS = [
  "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  "/Applications/Codex.app/Contents/MacOS/ChatGPT",
] as const;

export type CodexDesktopConversationState = Record<string, unknown>;

export type CodexDesktopStatePatch = {
  op: "add" | "replace" | "remove";
  path: Array<string | number>;
  value?: unknown;
};

export type CodexDesktopStateChange =
  | {
      type: "snapshot";
      revision: number;
      conversationState: CodexDesktopConversationState;
    }
  | {
      type: "patches";
      baseRevision: number;
      revision: number;
      patches: CodexDesktopStatePatch[];
    };

export type CodexDesktopStateListener = (
  threadId: string,
  state: CodexDesktopConversationState,
  previousState: CodexDesktopConversationState | null,
  change: CodexDesktopStateChange,
) => void;

export type CodexDesktopConnectionListener = (connected: boolean) => void;

export type CodexDesktopIpcClientOptions = {
  socketPath?: string;
  clientType?: string;
  openThread?: (threadId: string) => Promise<void>;
  reconnectDelayMs?: number;
  requestTimeoutMs?: number;
};

export type CodexDesktopThreadRetention = "full" | "summary";

type PendingRequest = {
  method: string;
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type ThreadStateEntry = {
  revision: number;
  state: CodexDesktopConversationState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export function isCodexDesktopMainProcessCommandLine(commandLine: string): boolean {
  const normalized = commandLine.trim();
  return CODEX_DESKTOP_MAIN_PROCESS_PATHS.some(
    (executable) => normalized === executable || normalized.startsWith(`${executable} `),
  );
}

export async function isCodexDesktopMainProcessRunning(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "command="]);
    return stdout
      .split(/\r?\n/)
      .some((commandLine) => isCodexDesktopMainProcessCommandLine(commandLine));
  } catch {
    return false;
  }
}

function isCodexDesktopTurnActiveStatus(value: unknown): boolean {
  const normalized = typeof value === "string"
    ? value.replace(/[_-]/g, "").trim().toLowerCase()
    : "";
  return normalized === "inprogress" || normalized === "active" || normalized === "running";
}

function extractCodexDesktopActiveTurn(
  state: CodexDesktopConversationState | null,
): Record<string, unknown> | null {
  if (
    !state ||
    !isRecord(state.threadRuntimeStatus) ||
    state.threadRuntimeStatus.type !== "active" ||
    !isRecord(state.turnHistory) ||
    !isRecord(state.turnHistory.history) ||
    !isRecord(state.turnHistory.history.entitiesByKey)
  ) {
    return null;
  }
  const entries = Object.entries(state.turnHistory.history.entitiesByKey)
    .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]));
  const tailEntries = entries.filter(([key]) => key.startsWith("tail:"));
  const candidate = [...(tailEntries.length > 0 ? tailEntries : entries)]
    .reverse()
    .find(([, entity]) => isCodexDesktopTurnActiveStatus(entity.status));
  if (!candidate) {
    return null;
  }
  const entity = candidate[1];
  const turnId = typeof entity.turnId === "string" && entity.turnId.trim()
    ? entity.turnId.trim()
    : typeof entity.id === "string" && entity.id.trim()
      ? entity.id.trim()
      : "";
  if (!turnId) {
    return null;
  }
  return {
    ...cloneValue(entity),
    id: turnId,
    status: typeof entity.status === "string" ? entity.status : "inProgress",
  };
}

function clonePatchContainer(
  value: unknown,
  nextKey?: string | number,
): Record<string | number, unknown> | unknown[] {
  if (Array.isArray(value)) {
    return [...value];
  }
  if (isRecord(value)) {
    return { ...value };
  }
  return typeof nextKey === "number" ? [] : {};
}

export function applyCodexDesktopStatePatches<T>(
  currentState: T,
  patches: CodexDesktopStatePatch[],
): T {
  let nextState = currentState;

  for (const patch of patches) {
    if (!Array.isArray(patch.path)) {
      throw new Error("Codex desktop state patch path is invalid.");
    }

    if (patch.path.length === 0) {
      nextState = patch.op === "remove"
        ? (undefined as T)
        : (patch.value as T);
      continue;
    }

    const root = clonePatchContainer(nextState, patch.path[0]);
    let source: unknown = nextState;
    let parent = root;
    for (let index = 0; index < patch.path.length - 1; index += 1) {
      const key = patch.path[index];
      const nextKey = patch.path[index + 1];
      if (key === undefined) {
        throw new Error("Invalid Codex desktop state patch path.");
      }
      const sourceContainer = isRecord(source) || Array.isArray(source)
        ? source as Record<string | number, unknown> | unknown[]
        : null;
      const sourceChild = sourceContainer?.[key as never];
      const targetChild = clonePatchContainer(sourceChild, nextKey);
      parent[key as never] = targetChild as never;
      source = sourceChild;
      parent = targetChild;
    }
    const key = patch.path[patch.path.length - 1];
    if (key === undefined) {
      throw new Error("Invalid Codex desktop state patch path.");
    }
    if (patch.op === "remove") {
      if (Array.isArray(parent) && typeof key === "number") {
        parent.splice(key, 1);
      } else {
        delete (parent as Record<string | number, unknown>)[key];
      }
    } else {
      const value = patch.value;
      if (patch.op === "add" && Array.isArray(parent) && typeof key === "number") {
        parent.splice(key, 0, value);
      } else {
        (parent as Record<string | number, unknown>)[key] = value;
      }
    }
    nextState = root as T;
  }

  return nextState;
}

const CODEX_DESKTOP_SUMMARY_STATE_KEYS = new Set([
  "cwd",
  "updatedAt",
  "threadRuntimeStatus",
  "requests",
  "modelProvider",
  "latestModel",
  "latestReasoningEffort",
  "previousTurnModel",
  "latestThreadSettings",
]);

export function compactCodexDesktopConversationState(
  state: CodexDesktopConversationState,
): CodexDesktopConversationState {
  const compact: CodexDesktopConversationState = {};
  for (const key of CODEX_DESKTOP_SUMMARY_STATE_KEYS) {
    if (key in state) {
      compact[key] = state[key];
    }
  }
  return compact;
}

function isCodexDesktopSummaryPatch(patch: CodexDesktopStatePatch): boolean {
  const rootKey = patch.path[0];
  return typeof rootKey === "string" && CODEX_DESKTOP_SUMMARY_STATE_KEYS.has(rootKey);
}

export function encodeCodexDesktopIpcMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
    throw new Error(`Codex desktop IPC frame size is invalid: ${body.length}.`);
  }
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function buildCodexDesktopThreadUrl(threadId: string): string {
  return `codex://threads/${encodeURIComponent(threadId.trim())}`;
}

export function resolveCodexDesktopIpcSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const codexHome = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "ipc", "ipc.sock");
}

export function isWindowsNamedPipePath(socketPath: string): boolean {
  const normalized = socketPath.toLowerCase();
  return normalized.startsWith("\\\\.\\pipe\\") || normalized.startsWith("\\\\?\\pipe\\");
}

async function openCodexDesktopThread(threadId: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Codex 桌面端任务映射目前仅支持 macOS。");
  }
  await execFileAsync("/usr/bin/open", ["-g", buildCodexDesktopThreadUrl(threadId)]);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function unwrapFollowerResult(message: Record<string, unknown>): unknown {
  let value: unknown = message.result;
  while (isRecord(value) && Object.keys(value).length === 1 && "result" in value) {
    value = value.result;
  }
  return value;
}

export class CodexDesktopIpcClient {
  private readonly options: Required<
    Pick<CodexDesktopIpcClientOptions, "clientType" | "reconnectDelayMs" | "requestTimeoutMs">
  > & Pick<CodexDesktopIpcClientOptions, "socketPath" | "openThread">;
  private socket: net.Socket | null = null;
  private frameHeader = Buffer.allocUnsafe(4);
  private frameHeaderOffset = 0;
  private frameBody: Buffer | null = null;
  private frameBodyOffset = 0;
  private clientId = INITIALIZING_CLIENT_ID;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private requestCounter = 0;
  private pendingRequests = new Map<string, PendingRequest>();
  private followedThreadIds = new Set<string>();
  private threadRetentionById = new Map<string, CodexDesktopThreadRetention>();
  private threadStates = new Map<string, ThreadStateEntry>();
  private stateListeners = new Set<CodexDesktopStateListener>();
  private connectionListeners = new Set<CodexDesktopConnectionListener>();

  constructor(options: CodexDesktopIpcClientOptions = {}) {
    this.options = {
      socketPath: options.socketPath,
      clientType: options.clientType ?? "werelay",
      openThread: options.openThread,
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    };
  }

  onStateChanged(listener: CodexDesktopStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onConnectionChanged(listener: CodexDesktopConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  getThreadState(threadId: string): CodexDesktopConversationState | null {
    const state = this.threadStates.get(threadId.trim())?.state;
    return state ? cloneValue(state) : null;
  }

  getThreadStateView(threadId: string): CodexDesktopConversationState | null {
    return this.threadStates.get(threadId.trim())?.state ?? null;
  }

  isConnected(): boolean {
    return Boolean(this.socket?.writable && this.clientId !== INITIALIZING_CLIENT_ID);
  }

  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error("Codex 桌面端连接已关闭。");
    }
    if (this.isConnected()) {
      return;
    }
    if (this.connectPromise) {
      return await this.connectPromise;
    }

    this.connectPromise = this.connectOnce();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async openAndFollowThread(
    threadId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<CodexDesktopConversationState> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("请选择一个 Codex 任务。");
    }

    await this.openThread(normalizedThreadId);

    const cachedState = this.threadRetentionById.get(normalizedThreadId) === "full"
      ? this.getThreadState(normalizedThreadId)
      : null;
    if (cachedState) {
      return cachedState;
    }

    const totalTimeoutMs = Math.min(
      options.timeoutMs ?? this.options.requestTimeoutMs,
      12_000,
    );
    const attempts = 3;
    const attemptTimeoutMs = Math.max(100, Math.ceil(totalTimeoutMs / attempts));
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const statePromise = this.waitForThreadState(
        normalizedThreadId,
        attemptTimeoutMs,
      );
      try {
        await this.followThread(normalizedThreadId, { force: true });
        return await statePromise;
      } catch (error) {
        void statePromise.catch(() => undefined);
        lastError = error;
        if (attempt < attempts) {
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
      }
    }
    throw new Error(
      "已自动重试 3 次，仍无法读取 Codex 桌面任务，请稍后再试。",
      { cause: lastError },
    );
  }

  async openThread(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("请选择一个 Codex 任务。");
    }
    const openThread = this.options.openThread ?? openCodexDesktopThread;
    await openThread(normalizedThreadId);
    await this.connect();
  }

  async followThread(
    threadId: string,
    options: { force?: boolean; retention?: CodexDesktopThreadRetention } = {},
  ): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      throw new Error("请选择一个 Codex 任务。");
    }
    await this.connect();
    const requestedRetention = options.retention ?? "full";
    const currentRetention = this.threadRetentionById.get(normalizedThreadId);
    const upgradingToFull = requestedRetention === "full" && currentRetention === "summary";
    if (!currentRetention || upgradingToFull) {
      this.threadRetentionById.set(normalizedThreadId, requestedRetention);
    }
    if (upgradingToFull) {
      this.threadStates.delete(normalizedThreadId);
    }
    if (
      this.followedThreadIds.has(normalizedThreadId) &&
      !options.force &&
      !upgradingToFull
    ) {
      return;
    }
    this.followedThreadIds.add(normalizedThreadId);
    this.sendBroadcast("thread-stream-following-changed", 1, {
      conversationId: normalizedThreadId,
      hostId: "local",
      following: true,
    });
  }

  async unfollowThread(threadId: string): Promise<void> {
    const normalizedThreadId = threadId.trim();
    const wasFollowing = this.followedThreadIds.delete(normalizedThreadId);
    this.threadRetentionById.delete(normalizedThreadId);
    this.threadStates.delete(normalizedThreadId);
    if (!wasFollowing || !this.isConnected()) {
      return;
    }
    this.sendBroadcast("thread-stream-following-changed", 1, {
      conversationId: normalizedThreadId,
      hostId: "local",
      following: false,
    });
  }

  async startTurn(
    threadId: string,
    input: string | BridgeTurnInputItem[],
    options: { model?: string } = {},
  ): Promise<Record<string, unknown>> {
    const normalizedThreadId = threadId.trim();
    const items = typeof input === "string"
      ? [{ type: "text" as const, text: input }]
      : input.map((item) => ({ ...item }));
    const previousTurn = extractCodexDesktopActiveTurn(
      this.getThreadStateView(normalizedThreadId),
    );
    const previousTurnId = typeof previousTurn?.id === "string"
      ? previousTurn.id
      : null;
    let removeStateListener = () => {};
    const stateConfirmation = new Promise<Record<string, unknown>>((resolve) => {
      removeStateListener = this.onStateChanged((changedThreadId, state) => {
        if (changedThreadId !== normalizedThreadId) {
          return;
        }
        const activeTurn = extractCodexDesktopActiveTurn(state);
        if (
          !activeTurn ||
          typeof activeTurn.id !== "string" ||
          activeTurn.id === previousTurnId
        ) {
          return;
        }
        removeStateListener();
        resolve(activeTurn);
      });
    });
    const requestOutcome = this.sendFollowerRequest(
      "thread-follower-start-turn",
      2,
      {
        conversationId: normalizedThreadId,
        turnStart: {
          request: {
            threadId: normalizedThreadId,
            input: items,
            ...(options.model?.trim() ? { model: options.model.trim() } : {}),
          },
        },
      },
    ).then(
      (result) => ({ type: "response" as const, result }),
      (error: unknown) => ({ type: "error" as const, error }),
    );
    const outcome = await Promise.race([
      requestOutcome,
      stateConfirmation.then((turn) => ({ type: "confirmed" as const, turn })),
    ]);
    removeStateListener();
    if (outcome.type === "confirmed") {
      // Codex can publish the new live turn before its desktop owner replies to
      // the request. Treat that authoritative state as acceptance instead of
      // showing a false failure and encouraging a duplicate retry.
      void requestOutcome;
      return outcome.turn;
    }
    if (outcome.type === "error") {
      const message = outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error);
      if (message.includes("请求超时：thread-follower-start-turn")) {
        throw new Error(
          "Codex 暂未确认收到这条消息，请先查看任务状态，避免重复发送。",
          { cause: outcome.error },
        );
      }
      throw outcome.error;
    }
    const result = outcome.result;
    if (!isRecord(result) || !isRecord(result.turn)) {
      throw new Error("Codex 桌面端没有返回任务运行信息。");
    }
    return result.turn;
  }

  async setQueuedFollowUpsState(
    threadId: string,
    state: Record<string, unknown[]>,
  ): Promise<void> {
    await this.sendFollowerRequest(
      "thread-follower-set-queued-follow-ups-state",
      1,
      {
        conversationId: threadId.trim(),
        state: cloneValue(state),
      },
    );
  }

  async steerTurn(
    threadId: string,
    input: BridgeTurnInputItem[],
    restoreMessage: Record<string, unknown>,
  ): Promise<unknown> {
    return await this.sendFollowerRequest(
      "thread-follower-steer-turn",
      1,
      {
        conversationId: threadId.trim(),
        input: input.map((item) => ({ ...item })),
        restoreMessage: cloneValue(restoreMessage),
        clientUserMessageId:
          typeof restoreMessage.id === "string" ? restoreMessage.id : undefined,
      },
    );
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.sendFollowerRequest("thread-follower-interrupt-turn", 4, {
      conversationId: threadId.trim(),
      mode: "interrupt",
      expectedTurnId: turnId,
    });
  }

  async replyToCommandApproval(
    threadId: string,
    requestId: string | number,
    decision: unknown,
  ): Promise<void> {
    await this.sendFollowerRequest("thread-follower-command-approval-decision", 1, {
      conversationId: threadId.trim(),
      requestId,
      decision,
    });
  }

  async replyToFileApproval(
    threadId: string,
    requestId: string | number,
    decision: unknown,
  ): Promise<void> {
    await this.sendFollowerRequest("thread-follower-file-approval-decision", 1, {
      conversationId: threadId.trim(),
      requestId,
      decision,
    });
  }

  async replyToPermissionsApproval(
    threadId: string,
    requestId: string | number,
    response: Record<string, unknown>,
  ): Promise<void> {
    await this.sendFollowerRequest(
      "thread-follower-permissions-request-approval-response",
      1,
      {
        conversationId: threadId.trim(),
        requestId,
        response,
      },
    );
  }

  async replyToMcpServerElicitation(
    threadId: string,
    requestId: string | number,
    response: Record<string, unknown>,
  ): Promise<void> {
    await this.sendFollowerRequest(
      "thread-follower-submit-mcp-server-elicitation-response",
      1,
      {
        conversationId: threadId.trim(),
        requestId,
        response,
      },
    );
  }

  async submitUserInput(
    threadId: string,
    requestId: string | number,
    answers: Record<string, unknown>,
  ): Promise<void> {
    await this.sendFollowerRequest("thread-follower-submit-user-input", 1, {
      conversationId: threadId.trim(),
      requestId,
      response: { answers },
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.isConnected()) {
      for (const threadId of this.followedThreadIds) {
        try {
          this.sendBroadcast("thread-stream-following-changed", 1, {
            conversationId: threadId,
            hostId: "local",
            following: false,
          });
        } catch {
          // Best effort: the socket may already be closing.
        }
      }
    }

    this.rejectPendingRequests("Codex 桌面端连接已关闭。");
    const socket = this.socket;
    this.socket = null;
    this.clientId = INITIALIZING_CLIENT_ID;
    if (!socket) {
      return;
    }

    socket.destroy();
    await new Promise<void>((resolve) => {
      if (socket.destroyed) {
        setImmediate(resolve);
        return;
      }
      socket.once("close", resolve);
    });
  }

  private async connectOnce(): Promise<void> {
    const socketPath = this.options.socketPath ?? resolveCodexDesktopIpcSocketPath();
    if (!isWindowsNamedPipePath(socketPath) && !fs.existsSync(socketPath)) {
      throw new Error("Codex 桌面端未运行，请先打开 Codex 应用。");
    }

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.createConnection(socketPath);
      let settled = false;
      candidate.once("connect", () => {
        settled = true;
        resolve(candidate);
      });
      candidate.once("error", (error) => {
        if (!settled) {
          reject(error);
        }
      });
    });

    if (this.disposed) {
      socket.destroy();
      throw new Error("Codex 桌面端连接已关闭。");
    }

    this.socket = socket;
    this.resetFrameDecoder();
    this.clientId = INITIALIZING_CLIENT_ID;
    socket.on("data", (chunk) => this.handleSocketData(chunk));
    socket.on("error", () => {
      // The close handler performs recovery and reports connection state.
    });
    socket.on("close", () => this.handleSocketClosed(socket));

    const response = await this.sendRequest(
      "initialize",
      0,
      { clientType: this.options.clientType },
      this.options.requestTimeoutMs,
    );
    const result = isRecord(response.result) ? response.result : null;
    if (!result || typeof result.clientId !== "string" || !result.clientId) {
      socket.destroy();
      throw new Error("Codex 桌面端通讯协议初始化失败。");
    }
    this.clientId = result.clientId;
    this.notifyConnection(true);

    for (const threadId of this.followedThreadIds) {
      this.sendBroadcast("thread-stream-following-changed", 1, {
        conversationId: threadId,
        hostId: "local",
        following: true,
      });
    }
  }

  private async waitForThreadState(
    threadId: string,
    timeoutMs: number,
  ): Promise<CodexDesktopConversationState> {
    const cachedState = this.getThreadStateView(threadId);
    if (cachedState) {
      return cachedState;
    }
    return await new Promise<CodexDesktopConversationState>((resolve, reject) => {
      const timer = setTimeout(() => {
        removeListener();
        reject(new Error("无法读取 Codex 桌面任务，请确认 Codex 应用已打开该任务。"));
      }, Math.max(100, timeoutMs));
      const removeListener = this.onStateChanged((changedThreadId, state) => {
        if (changedThreadId !== threadId) {
          return;
        }
        clearTimeout(timer);
        removeListener();
        resolve(state);
      });
    });
  }

  private async sendFollowerRequest(
    method: string,
    version: number,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const deadline = Date.now() + this.options.requestTimeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        const response = await this.sendRequest(
          method,
          version,
          params,
          Math.max(100, deadline - Date.now()),
        );
        return unwrapFollowerResult(response);
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const conversationId = typeof params.conversationId === "string"
          ? params.conversationId
          : null;
        if (!conversationId || !message.includes("no-client-found")) {
          throw error;
        }
        const openThread = this.options.openThread ?? openCodexDesktopThread;
        await openThread(conversationId);
        await delay(250);
        await this.followThread(conversationId, { retention: "summary" });
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Codex 桌面端请求超时：${method}`);
  }

  private async sendRequest(
    method: string,
    version: number,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (method !== "initialize") {
      await this.connect();
    }
    const socket = this.socket;
    if (!socket?.writable) {
      throw new Error("无法连接 Codex 桌面端。");
    }

    const requestId = `${Date.now().toString(36)}-${++this.requestCounter}-${randomUUID()}`;
    const message = {
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version,
      method,
      params,
      timeoutMs,
    };

    const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Codex 桌面端请求超时：${method}`));
      }, Math.max(100, timeoutMs));
      this.pendingRequests.set(requestId, { method, resolve, reject, timer });
    });

    try {
      socket.write(encodeCodexDesktopIpcMessage(message));
    } catch (error) {
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(requestId);
      }
      throw error;
    }

    return await responsePromise;
  }

  private sendBroadcast(
    method: string,
    version: number,
    params: Record<string, unknown>,
  ): void {
    const socket = this.socket;
    if (!socket?.writable || this.clientId === INITIALIZING_CLIENT_ID) {
      throw new Error("无法连接 Codex 桌面端。");
    }
    socket.write(encodeCodexDesktopIpcMessage({
      type: "broadcast",
      method,
      sourceClientId: this.clientId,
      version,
      params,
    }));
  }

  private handleSocketData(chunk: Buffer): void {
    let chunkOffset = 0;
    while (chunkOffset < chunk.length) {
      if (!this.frameBody) {
        const headerBytes = Math.min(
          this.frameHeader.length - this.frameHeaderOffset,
          chunk.length - chunkOffset,
        );
        chunk.copy(
          this.frameHeader,
          this.frameHeaderOffset,
          chunkOffset,
          chunkOffset + headerBytes,
        );
        this.frameHeaderOffset += headerBytes;
        chunkOffset += headerBytes;
        if (this.frameHeaderOffset < this.frameHeader.length) {
          continue;
        }

        const frameLength = this.frameHeader.readUInt32LE(0);
        this.frameHeaderOffset = 0;
        if (frameLength === 0 || frameLength > MAX_FRAME_BYTES) {
          this.resetFrameDecoder();
          this.socket?.destroy(new Error("Codex 桌面端返回了无效通讯数据。"));
          return;
        }
        this.frameBody = Buffer.allocUnsafe(frameLength);
        this.frameBodyOffset = 0;
      }

      const frameBody = this.frameBody;
      const bodyBytes = Math.min(
        frameBody.length - this.frameBodyOffset,
        chunk.length - chunkOffset,
      );
      chunk.copy(
        frameBody,
        this.frameBodyOffset,
        chunkOffset,
        chunkOffset + bodyBytes,
      );
      this.frameBodyOffset += bodyBytes;
      chunkOffset += bodyBytes;
      if (this.frameBodyOffset < frameBody.length) {
        continue;
      }

      this.frameBody = null;
      this.frameBodyOffset = 0;
      try {
        const message = JSON.parse(frameBody.toString("utf8"));
        if (isRecord(message)) {
          this.handleMessage(message);
        }
      } catch {
        this.resetFrameDecoder();
        this.socket?.destroy(new Error("Codex 桌面端返回了无法解析的通讯数据。"));
        return;
      }
    }
  }

  private resetFrameDecoder(): void {
    this.frameHeaderOffset = 0;
    this.frameBody = null;
    this.frameBodyOffset = 0;
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (message.type === "response") {
      this.handleResponse(message);
      return;
    }
    if (message.type === "client-discovery-request") {
      const socket = this.socket;
      if (socket?.writable) {
        socket.write(encodeCodexDesktopIpcMessage({
          type: "client-discovery-response",
          requestId: message.requestId,
          response: { canHandle: false },
        }));
      }
      return;
    }
    if (
      message.type === "broadcast" &&
      message.method === "thread-stream-state-changed"
    ) {
      this.handleThreadStateBroadcast(message);
    }
  }

  private handleResponse(message: Record<string, unknown>): void {
    if (typeof message.requestId !== "string") {
      return;
    }
    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.resultType === "error") {
      pending.reject(new Error(
        typeof message.error === "string"
          ? message.error
          : `Codex 桌面端请求失败：${pending.method}`,
      ));
      return;
    }
    pending.resolve(message);
  }

  private handleThreadStateBroadcast(message: Record<string, unknown>): void {
    if (message.version !== 11 || !isRecord(message.params)) {
      return;
    }
    const threadId = typeof message.params.conversationId === "string"
      ? message.params.conversationId
      : null;
    const change = message.params.change;
    if (!threadId || !isRecord(change)) {
      return;
    }

    if (
      change.type === "snapshot" &&
      typeof change.revision === "number" &&
      isRecord(change.conversationState)
    ) {
      const previousState = this.threadStates.get(threadId)?.state ?? null;
      const retention = this.threadRetentionById.get(threadId) ?? "full";
      const state = retention === "summary"
        ? compactCodexDesktopConversationState(change.conversationState)
        : change.conversationState;
      this.threadStates.set(threadId, { revision: change.revision, state });
      this.notifyState(threadId, state, previousState, {
        type: "snapshot",
        revision: change.revision,
        conversationState: state,
      });
      return;
    }

    if (
      change.type === "patches" &&
      typeof change.baseRevision === "number" &&
      typeof change.revision === "number" &&
      Array.isArray(change.patches)
    ) {
      const entry = this.threadStates.get(threadId);
      if (!entry || entry.revision !== change.baseRevision) {
        this.threadStates.delete(threadId);
        this.sendBroadcast("thread-stream-following-changed", 1, {
          conversationId: threadId,
          hostId: "local",
          following: true,
        });
        return;
      }
      const patches = change.patches.filter((patch): patch is CodexDesktopStatePatch => {
        if (!isRecord(patch) || !Array.isArray(patch.path)) {
          return false;
        }
        return patch.op === "add" || patch.op === "replace" || patch.op === "remove";
      });
      const retention = this.threadRetentionById.get(threadId) ?? "full";
      const retainedPatches = retention === "summary"
        ? patches.filter(isCodexDesktopSummaryPatch)
        : patches;
      const previousState = entry.state;
      const state = applyCodexDesktopStatePatches(previousState, retainedPatches);
      this.threadStates.set(threadId, { revision: change.revision, state });
      if (retainedPatches.length === 0) {
        return;
      }
      this.notifyState(threadId, state, previousState, {
        type: "patches",
        baseRevision: change.baseRevision,
        revision: change.revision,
        patches: retainedPatches,
      });
    }
  }

  private handleSocketClosed(closedSocket: net.Socket): void {
    if (this.socket !== closedSocket) {
      return;
    }
    this.socket = null;
    this.resetFrameDecoder();
    this.clientId = INITIALIZING_CLIENT_ID;
    this.rejectPendingRequests("Codex 桌面端连接已断开。");
    this.notifyConnection(false);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || this.isConnected()) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, Math.max(10, this.options.reconnectDelayMs));
    this.reconnectTimer.unref?.();
  }

  private rejectPendingRequests(message: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pendingRequests.clear();
  }

  private notifyState(
    threadId: string,
    state: CodexDesktopConversationState,
    previousState: CodexDesktopConversationState | null,
    change: CodexDesktopStateChange,
  ): void {
    for (const listener of this.stateListeners) {
      listener(threadId, state, previousState, change);
    }
  }

  private notifyConnection(connected: boolean): void {
    for (const listener of this.connectionListeners) {
      listener(connected);
    }
  }
}

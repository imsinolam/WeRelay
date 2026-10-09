import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { BridgeTurnInputItem } from "./bridge-types.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// Desktop discovery waits up to 10s for registered clients before no-client-found.
// A 1s snapshot probe must not also truncate that independent read-only request.
const OWNER_DISCOVERY_TIMEOUT_MS = 12_000;
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

class StartTurnOwnerError extends Error {}

function startTurnNotReady(cause?: unknown): Error {
  return new Error("Codex 桌面任务状态尚未就绪，消息尚未发送，请稍后再试。", { cause });
}

function startTurnUnconfirmed(cause?: unknown): Error {
  return new Error("Codex 暂未确认收到这条消息，请先查看任务状态，避免重复发送。", { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function toCodexDesktopInput(input: string | BridgeTurnInputItem[]) {
  const items = typeof input === "string"
    ? [{ type: "text" as const, text: input }]
    : input;
  // Desktop renders this input before app-server can supply protocol defaults.
  return items.map((item) => item.type === "text"
    ? {
        ...item,
        text_elements: "text_elements" in item && Array.isArray(item.text_elements)
          ? cloneValue(item.text_elements)
          : [],
      }
    : { ...item });
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

type ReceiptCandidate = {
  key: string;
  turnId?: string;
  status?: string;
  inputFingerprint?: string;
};

type PendingStartReceipt = {
  revision: number | null;
  minimumRevision: number;
  identityBaselineComplete: boolean;
  submitted: boolean;
  candidate: ReceiptCandidate | null;
  knownTurns: Uint8Array;
  inputFingerprint: string | null;
  ready: () => void;
  confirm: (turn: Record<string, unknown>) => void;
};

type PendingThreadStarts = {
  receipts: Set<PendingStartReceipt>;
  desiredRetention: CodexDesktopThreadRetention | null;
};

function fingerprintCodexDesktopInput(input: unknown): string | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const hash = createHash("sha256");
  const append = (value: unknown): void => {
    if (Array.isArray(value)) {
      hash.update("[");
      for (const item of value) append(item);
      hash.update("]");
    } else if (isRecord(value)) {
      hash.update("{");
      for (const key of Object.keys(value).sort()) {
        if (value[key] === undefined) continue;
        hash.update(JSON.stringify(key));
        append(value[key]);
      }
      hash.update("}");
    } else {
      hash.update(JSON.stringify(value) ?? "null");
    }
    hash.update(",");
  };
  for (const item of input) {
    if (!isRecord(item) || typeof item.type !== "string") return null;
    append(item.type === "text" ? { ...item, text_elements: item.text_elements ?? [] } : item);
  }
  return hash.digest("hex");
}

function receiptTurnId(entity: Record<string, unknown>): string | undefined {
  const id = typeof entity.turnId === "string" ? entity.turnId : entity.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function receiptCandidate(key: string, entity: unknown): ReceiptCandidate | null {
  if (!isRecord(entity)) return null;
  return {
    key,
    turnId: receiptTurnId(entity),
    status: typeof entity.status === "string" ? entity.status : undefined,
    inputFingerprint: isRecord(entity.params)
      ? fingerprintCodexDesktopInput(entity.params.input) ?? undefined
      : undefined,
  };
}

function receiptTurnBits(id: string): number[] {
  const hash = createHash("sha256").update(id).digest();
  return [0, 4, 8].map((offset) => hash.readUInt32LE(offset) % (2048 * 8));
}

function rememberReceiptTurn(receipt: PendingStartReceipt, id: string): void {
  // 固定 2 KiB 的 Bloom filter 只会保守漏确认，不会把已见过的旧 turn 当作新 turn。
  for (const bit of receiptTurnBits(id)) {
    receipt.knownTurns[bit >> 3]! |= 1 << (bit & 7);
  }
}

function isKnownReceiptTurn(receipt: PendingStartReceipt, id: string): boolean {
  return receiptTurnBits(id).every((bit) =>
    (receipt.knownTurns[bit >> 3]! & (1 << (bit & 7))) !== 0);
}

function sampleReceiptSnapshot(
  receipt: PendingStartReceipt,
  state: CodexDesktopConversationState,
  revision: number,
): void {
  if (revision < receipt.minimumRevision ||
    (receipt.revision !== null && revision <= receipt.revision)) return;
  const entities = isRecord(state.turnHistory) && isRecord(state.turnHistory.history)
    ? state.turnHistory.history.entitiesByKey
    : null;
  let candidate: ReceiptCandidate | null = null;
  if (isRecord(entities)) {
    for (const key in entities) {
      const entity = entities[key];
      if (!isRecord(entity)) continue;
      const id = receiptTurnId(entity);
      if (!receipt.submitted && id) rememberReceiptTurn(receipt, id);
      if (!candidate || key.startsWith("tail:") || !candidate.key.startsWith("tail:")) {
        // 先选最新实体，再摘要输入；不复制历史、items 或其他输出分支。
        candidate = { key };
      }
    }
    if (candidate) candidate = receiptCandidate(candidate.key, entities[candidate.key]);
  }
  receipt.candidate = candidate;
  receipt.revision = revision;
  if (!receipt.submitted) receipt.identityBaselineComplete = isRecord(entities);
  receipt.ready();
}

function sampleReceiptPatches(
  receipt: PendingStartReceipt,
  patches: CodexDesktopStatePatch[],
  baseRevision: number,
  revision: number,
): void {
  if (receipt.revision !== baseRevision || revision <= baseRevision) return;
  for (const patch of patches) {
    const keys = patch.path;
    if (keys.length <= 3) {
      let entities: unknown;
      if (keys.length === 0 && isRecord(patch.value) && isRecord(patch.value.turnHistory)) {
        const history = patch.value.turnHistory.history;
        entities = isRecord(history) ? history.entitiesByKey : null;
      } else if (keys[0] === "turnHistory") {
        entities = keys.length === 1 && isRecord(patch.value) && isRecord(patch.value.history)
          ? patch.value.history.entitiesByKey
          : keys[1] === "history" && keys.length === 2 && isRecord(patch.value)
            ? patch.value.entitiesByKey
            : keys[1] === "history" && keys[2] === "entitiesByKey" ? patch.value : null;
      } else continue;
      receipt.candidate = null;
      if (patch.op !== "remove" && isRecord(entities)) {
        for (const key in entities) {
          if (!isRecord(entities[key])) continue;
          if (!receipt.candidate || key.startsWith("tail:") ||
            !receipt.candidate.key.startsWith("tail:")) receipt.candidate = { key };
        }
        if (receipt.candidate) {
          receipt.candidate = receiptCandidate(receipt.candidate.key, entities[receipt.candidate.key]);
        }
      }
      continue;
    }
    if (keys[0] !== "turnHistory" || keys[1] !== "history" ||
      keys[2] !== "entitiesByKey" || typeof keys[3] !== "string") continue;
    const key = keys[3];
    if (keys.length === 4) {
      if (patch.op !== "remove") receipt.candidate = receiptCandidate(key, patch.value);
      else if (receipt.candidate?.key === key) receipt.candidate = null;
      continue;
    }
    const isIdentity = keys.length === 5 && (keys[4] === "turnId" || keys[4] === "id");
    const isStatus = keys.length === 5 && keys[4] === "status";
    const isInput = keys[4] === "params" && (keys.length === 5 || keys[5] === "input");
    if (!isIdentity && !isStatus && !isInput) continue;
    if (!receipt.candidate || receipt.candidate.key !== key) {
      if (receipt.candidate && isStatus) continue;
      receipt.candidate = { key };
    }
    const candidate = receipt.candidate;
    const value = patch.op === "remove" ? undefined : patch.value;
    if (isIdentity) {
      const turnId = typeof value === "string" && value.trim() ? value.trim() : undefined;
      if (candidate.turnId && candidate.turnId !== turnId) {
        candidate.inputFingerprint = undefined;
        candidate.status = undefined;
      }
      candidate.turnId = turnId;
    } else if (isStatus) {
      candidate.status = typeof value === "string" ? value : undefined;
    } else if (isInput) {
      candidate.inputFingerprint = keys.length === 5
        ? isRecord(value) ? fingerprintCodexDesktopInput(value.input) ?? undefined : undefined
        : keys.length === 6 && keys[5] === "input"
          ? fingerprintCodexDesktopInput(value) ?? undefined
          : undefined;
    }
  }
  receipt.revision = revision;
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
  private pendingThreadStarts = new Map<string, PendingThreadStarts>();

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

  getThreadRevision(threadId: string): number | null {
    return this.threadStates.get(threadId.trim())?.revision ?? null;
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
    const requestedRetention = options.retention ?? "full";
    const pending = this.pendingThreadStarts.get(normalizedThreadId);
    if (pending) {
      pending.desiredRetention = pending.desiredRetention === "full" ? "full" : requestedRetention;
    }
    await this.ensureThreadFollowed(normalizedThreadId, options);
  }

  private async ensureThreadFollowed(
    normalizedThreadId: string,
    options: { force?: boolean; retention?: CodexDesktopThreadRetention } = {},
  ): Promise<void> {
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
    const pending = this.pendingThreadStarts.get(normalizedThreadId);
    if (pending) {
      pending.desiredRetention = null;
      return;
    }
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
    options: {
      model?: string;
      effort?: string;
      approvalPolicy?: string;
      approvalsReviewer?: string;
      sandbox?: string;
      sandboxPolicy?: Record<string, unknown>;
    } = {},
  ): Promise<Record<string, unknown>> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error("请选择一个 Codex 任务。");
    const items = toCodexDesktopInput(input);
    let pending = this.pendingThreadStarts.get(normalizedThreadId);
    if (!pending) {
      pending = {
        receipts: new Set(),
        desiredRetention: this.threadRetentionById.get(normalizedThreadId) ?? null,
      };
      this.pendingThreadStarts.set(normalizedThreadId, pending);
    }
    let ready = () => {};
    const baselineReady = new Promise<void>((resolve) => { ready = resolve; });
    let confirm = (_turn: Record<string, unknown>) => {};
    const stateConfirmation = new Promise<Record<string, unknown>>((resolve) => { confirm = resolve; });
    const receipt: PendingStartReceipt = {
      revision: null,
      minimumRevision: this.getThreadRevision(normalizedThreadId) ?? 0,
      identityBaselineComplete: false,
      submitted: false,
      candidate: null,
      knownTurns: new Uint8Array(2048),
      inputFingerprint: fingerprintCodexDesktopInput(items),
      ready,
      confirm,
    };
    pending.receipts.add(receipt);
    try {
      try {
        await this.prepareStartReceipt(normalizedThreadId, receipt, baselineReady);
      } catch (error) {
        throw startTurnNotReady(error);
      }
      const requestOutcome = this.sendRequest(
        "thread-follower-start-turn",
        2,
        {
          conversationId: normalizedThreadId,
          turnStart: {
            request: {
              threadId: normalizedThreadId,
              input: items,
              ...(options.model?.trim() ? { model: options.model.trim() } : {}),
              ...(options.effort?.trim() ? { effort: options.effort.trim() } : {}),
              ...(options.approvalPolicy?.trim()
                ? { approvalPolicy: options.approvalPolicy.trim() }
                : {}),
              ...(options.approvalsReviewer?.trim()
                ? { approvalsReviewer: options.approvalsReviewer.trim() }
                : {}),
              ...(options.sandbox?.trim() ? { sandbox: options.sandbox.trim() } : {}),
              ...(options.sandboxPolicy
                ? { sandboxPolicy: structuredClone(options.sandboxPolicy) }
                : {}),
            },
          },
        },
        this.options.requestTimeoutMs,
        () => { receipt.submitted = true; },
      ).then(
        (response) => ({ type: "response" as const,
          result: response.resultType === "success" ? unwrapFollowerResult(response) : undefined }),
        (error: unknown) => ({ type: "error" as const, error }),
      );
      const outcome = await Promise.race([
        requestOutcome,
        stateConfirmation.then((turn) => ({ type: "confirmed" as const, turn })),
      ]);
      if (outcome.type === "confirmed") {
        // 输入关联的新 turn（包括快速终态）只确认接收，不代表执行成功。
        void requestOutcome;
        return outcome.turn;
      }
      if (outcome.type === "error") {
        if (outcome.error instanceof StartTurnOwnerError) {
          if (outcome.error.message === "no-client-found") {
            // Router 明确未投递。本次不重放，下一次必须重新建立基线并发现 owner。
            this.threadStates.delete(normalizedThreadId);
            throw startTurnNotReady(outcome.error);
          }
          throw outcome.error;
        }
        throw receipt.submitted ? startTurnUnconfirmed(outcome.error) : startTurnNotReady(outcome.error);
      }
      const result = outcome.result;
      if (!isRecord(result) || !isRecord(result.turn) ||
        typeof result.turn.id !== "string" || !result.turn.id.trim()) {
        throw startTurnUnconfirmed(new Error("Codex 桌面端没有返回有效任务运行信息。"));
      }
      return result.turn;
    } finally {
      pending.receipts.delete(receipt);
      if (pending.receipts.size === 0) {
        this.pendingThreadStarts.delete(normalizedThreadId);
        if (pending.desiredRetention === null) {
          // 本地订阅先清除；断线或 unfollow 写失败不能覆盖提交结果或核心错误。
          await this.unfollowThread(normalizedThreadId).catch(() => undefined);
        } else if (pending.desiredRetention === "summary") {
          this.threadRetentionById.set(normalizedThreadId, "summary");
          const entry = this.threadStates.get(normalizedThreadId);
          if (entry) entry.state = compactCodexDesktopConversationState(entry.state);
        }
      }
    }
  }

  private async prepareStartReceipt(
    threadId: string,
    receipt: PendingStartReceipt,
    baselineReady: Promise<void>,
  ): Promise<void> {
    const cached = this.threadStates.get(threadId);
    if (cached && this.threadRetentionById.get(threadId) === "full") {
      sampleReceiptSnapshot(receipt, cached.state, cached.revision);
      await this.ensureThreadFollowed(threadId, { retention: "summary" });
      return;
    }
    const waitForBaseline = async (timeoutMs: number): Promise<boolean> => {
      if (receipt.revision !== null) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          baselineReady.then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const probeTimeoutMs = Math.max(100, Math.min(1_000, this.options.requestTimeoutMs));
    await this.ensureThreadFollowed(threadId, { retention: "summary", force: true });
    if (await waitForBaseline(probeTimeoutMs)) return;
    try {
      // 只读发现真实 owner；缺少 snapshot 本身不是打开任务的依据。
      await this.sendRequest("thread-owner-discovery", 1, {
        hostId: "local", conversationId: threadId,
      }, Math.max(100, Math.min(OWNER_DISCOVERY_TIMEOUT_MS, this.options.requestTimeoutMs)));
    } catch (error) {
      if (receipt.revision !== null) return;
      if (!(error instanceof Error) || error.message !== "no-client-found") throw error;
      await this.openThread(threadId);
    }
    if (receipt.revision !== null) return;
    await this.ensureThreadFollowed(threadId, { retention: "summary", force: true });
    if (!await waitForBaseline(Math.max(100, Math.min(3_000, this.options.requestTimeoutMs)))) {
      throw new Error("Codex 桌面任务基线等待超时。");
    }
  }

  async updateThreadSettingsForNextTurn(
    threadId: string,
    settings: { model?: string; effort?: string },
  ): Promise<void> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) throw new Error("请选择一个 Codex 任务。");
    const result = await this.sendFollowerRequest(
      "thread-follower-update-thread-settings",
      2,
      {
        conversationId: normalizedThreadId,
        threadSettings: settings,
      },
    );
    if (!isRecord(result) || result.applied !== true) {
      throw new Error("Codex 桌面端未应用模型设置，请重试。");
    }
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
        input: toCodexDesktopInput(input),
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
    onWriting?: () => void,
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
      const frame = encodeCodexDesktopIpcMessage(message);
      onWriting?.();
      socket.write(frame);
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
      const errorMessage = typeof message.error === "string"
        ? message.error
        : `Codex 桌面端请求失败：${pending.method}`;
      pending.reject(pending.method === "thread-follower-start-turn" &&
        typeof message.error === "string"
        ? new StartTurnOwnerError(errorMessage)
        : new Error(errorMessage));
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
    if (!threadId || !isRecord(change) || !this.followedThreadIds.has(threadId)) {
      return;
    }

    if (
      change.type === "snapshot" &&
      typeof change.revision === "number" &&
      isRecord(change.conversationState)
    ) {
      this.sampleStartReceipts(threadId, {
        type: "snapshot",
        revision: change.revision,
        conversationState: change.conversationState,
      });
      const previousEntry = this.threadStates.get(threadId);
      if (previousEntry && change.revision < previousEntry.revision) return;
      const previousState = previousEntry?.state ?? null;
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
      this.sampleStartReceipts(threadId, {
        type: "patches",
        baseRevision: change.baseRevision,
        revision: change.revision,
        patches,
      });
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

  private sampleStartReceipts(threadId: string, change: CodexDesktopStateChange): void {
    const pending = this.pendingThreadStarts.get(threadId);
    if (!pending) return;
    for (const receipt of pending.receipts) {
      if (change.type === "snapshot") {
        sampleReceiptSnapshot(receipt, change.conversationState, change.revision);
      } else {
        sampleReceiptPatches(receipt, change.patches, change.baseRevision, change.revision);
      }
      const candidate = receipt.candidate;
      if (!candidate?.turnId) continue;
      if (!receipt.submitted) {
        rememberReceiptTurn(receipt, candidate.turnId);
      } else if (receipt.identityBaselineComplete && !isKnownReceiptTurn(receipt, candidate.turnId)) {
        if (receipt.inputFingerprint && candidate.inputFingerprint === receipt.inputFingerprint) {
          receipt.confirm({ id: candidate.turnId, status: candidate.status ?? "unknown" });
        }
        // 不完整 metadata 仍可由后续 patch 补齐；完整的其他输入不能稍后冒充本次提交。
        if (candidate.inputFingerprint) rememberReceiptTurn(receipt, candidate.turnId);
      }
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

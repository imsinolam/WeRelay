import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ApprovalRequest,
  BridgeAdapter,
  BridgeAdapterState,
  BridgeEvent,
  BridgeResumeSessionCandidate,
  BridgeSessionMessage,
  BridgeSessionSendResult,
  UserInputRequest,
} from "./bridge-types.ts";
import {
  type AdapterOptions,
  type EventSink,
  buildCliEnvironment,
  reserveLocalPort,
  resolveSpawnTarget,
} from "./bridge-adapters.shared.ts";
import { describeUnknownError, isRecord } from "./bridge-adapter-common.ts";
import { killProcessTreeSync } from "./bridge-process-reaper.ts";
import { nowIso, truncatePreview } from "./bridge-utils.ts";

const REASONIX_TRANSCRIPT_SUFFIX = ".jsonl";
const REASONIX_EXCLUDED_TRANSCRIPT_SUFFIXES = [
  ".events.jsonl",
  ".conflicts.jsonl",
  ".guardian.jsonl",
];
const REASONIX_SERVER_HOST = "127.0.0.1";
const REASONIX_SERVER_READY_TIMEOUT_MS = 15_000;
const REASONIX_SERVER_POLL_INTERVAL_MS = 150;

const reasonixSessionCwdById = new Map<string, string>();
const reasonixSessionStateRootById = new Map<string, string>();
const reasonixSessionTranscriptById = new Map<string, string>();

type ReasonixSessionMetadata = {
  sessionId: string;
  transcriptPath: string;
  stateRoot: string;
  title: string;
  lastUpdatedAt: string;
  cwd: string;
  model?: string;
  userRenamed: boolean;
  acp: boolean;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readEventId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

async function waitForChildExit(child: ChildProcess, timeoutMs = 3_000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("exit", onExit);
  });
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function reasonixStateRoot(): string {
  const configured = process.env.REASONIX_STATE_HOME?.trim() ||
    process.env.REASONIX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".reasonix");
}

export function reasonixSessionDirectory(): string {
  return path.join(reasonixStateRoot(), "sessions");
}

function collectReasonixProjectSessionDirectories(root: string): string[] {
  const directories: string[] = [];
  const pending: Array<{ directory: string; depth: number }> = [{
    directory: root,
    depth: 0,
  }];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    const normalized = path.resolve(current.directory);
    if (visited.has(normalized) || current.depth > 8) continue;
    visited.add(normalized);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(normalized, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(normalized, entry.name);
      if (entry.name === "sessions") {
        directories.push(child);
        continue;
      }
      pending.push({ directory: child, depth: current.depth + 1 });
    }
  }
  return directories;
}

function reasonixSessionDirectories(): string[] {
  const stateRoot = reasonixStateRoot();
  return [...new Set([
    path.join(stateRoot, "sessions"),
    ...collectReasonixProjectSessionDirectories(path.join(stateRoot, "projects")),
  ].map((directory) => path.resolve(directory)))];
}

function isReasonixTranscriptName(name: string): boolean {
  return name.endsWith(REASONIX_TRANSCRIPT_SUFFIX) &&
    !REASONIX_EXCLUDED_TRANSCRIPT_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function normalizeTimestamp(value: unknown, fallbackMs: number): string {
  const text = readString(value);
  if (text) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

function collapseTitle(value: string): string {
  const title = value.replace(/\s+/g, " ").trim();
  if (!title) return "";
  return [...title].length <= 80 ? title : `${[...title].slice(0, 77).join("")}...`;
}

function reasonixContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(reasonixContentText).filter(Boolean).join("");
  }
  if (!isRecord(value)) return "";
  const text = readString(value.text);
  if (text) return text;
  return reasonixContentText(value.content);
}

export function parseReasonixTranscript(
  transcript: string,
  options: { sessionId?: string; model?: string } = {},
): BridgeSessionMessage[] {
  const messages: BridgeSessionMessage[] = [];
  const lines = transcript.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || (entry.role !== "user" && entry.role !== "assistant")) {
      continue;
    }
    const text = reasonixContentText(entry.content).trim();
    if (!text) continue;
    const id = readString(entry.id) ??
      `${options.sessionId ?? "reasonix"}:${index + 1}`;
    if (entry.role === "user") {
      messages.push({ role: "user", text, id });
      continue;
    }
    messages.push({
      role: "assistant",
      text,
      id,
      phase: "final_answer",
      ...(options.model ? { model: options.model } : {}),
    });
  }
  return messages;
}

function readReasonixSessionMetadata(
  transcriptPath: string,
  fallbackCwd: string,
): ReasonixSessionMetadata | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return null;
  }
  const name = path.basename(transcriptPath);
  if (!isReasonixTranscriptName(name)) return null;
  const sessionId = name.slice(0, -REASONIX_TRANSCRIPT_SUFFIX.length);
  if (!sessionId || sessionId.startsWith("subagent-")) return null;

  const stemPath = transcriptPath.slice(0, -REASONIX_TRANSCRIPT_SUFFIX.length);
  const acpMeta = readJsonFile(`${stemPath}.acp.json`);
  const branchMeta = readJsonFile(`${transcriptPath}.meta`);
  const legacyMeta = readJsonFile(`${stemPath}.meta.json`);
  if (readString(branchMeta?.parent_id)) return null;

  const model = readString(acpMeta?.model) ?? readString(branchMeta?.model);
  let messages: BridgeSessionMessage[] | null = null;
  const ensureMessages = (): BridgeSessionMessage[] => {
    if (messages) return messages;
    try {
      messages = parseReasonixTranscript(fs.readFileSync(transcriptPath, "utf8"), {
        sessionId,
        model,
      });
    } catch {
      messages = [];
    }
    return messages;
  };
  const recordedTurns = readNumber(branchMeta?.turns);
  if (
    recordedTurns === 0 ||
    (recordedTurns === undefined && !ensureMessages().some((item) => item.role === "user"))
  ) {
    return null;
  }

  const cwd = readString(acpMeta?.cwd) ??
    readString(branchMeta?.workspace_root) ??
    readString(legacyMeta?.workspace) ??
    fallbackCwd;
  const title = collapseTitle(
    readString(acpMeta?.title) ??
      readString(branchMeta?.custom_title) ??
      readString(branchMeta?.topic_title) ??
      readString(branchMeta?.preview) ??
      ensureMessages().find((item) => item.role === "user")?.text ??
      `reasonix 会话 ${sessionId.slice(0, 8)}`,
  );
  const lastUpdatedAt = normalizeTimestamp(
    acpMeta?.updatedAt ?? branchMeta?.updated_at,
    stat.mtimeMs,
  );
  return {
    sessionId,
    transcriptPath,
    stateRoot: path.dirname(path.dirname(transcriptPath)),
    title,
    lastUpdatedAt,
    cwd: path.resolve(cwd),
    model,
    userRenamed: Boolean(readString(branchMeta?.custom_title)),
    acp: acpMeta !== null,
  };
}

function listReasonixDiskSessionMetadata(cwd: string): ReasonixSessionMetadata[] {
  const byId = new Map<string, ReasonixSessionMetadata>();
  for (const directory of reasonixSessionDirectories()) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !isReasonixTranscriptName(entry.name)) continue;
      const metadata = readReasonixSessionMetadata(path.join(directory, entry.name), cwd);
      if (!metadata) continue;
      const existing = byId.get(metadata.sessionId);
      if (
        !existing ||
        (metadata.acp && !existing.acp) ||
        Date.parse(metadata.lastUpdatedAt) >= Date.parse(existing.lastUpdatedAt)
      ) {
        byId.set(metadata.sessionId, metadata);
      }
    }
  }
  return [...byId.values()];
}

function cacheReasonixSession(metadata: ReasonixSessionMetadata): void {
  reasonixSessionCwdById.set(metadata.sessionId, metadata.cwd);
  reasonixSessionStateRootById.set(metadata.sessionId, metadata.stateRoot);
  reasonixSessionTranscriptById.set(metadata.sessionId, metadata.transcriptPath);
}

export async function listReasonixSessions(
  cwd: string,
  limit = 10,
  acpSessions: BridgeResumeSessionCandidate[] = [],
): Promise<BridgeResumeSessionCandidate[]> {
  const byId = new Map<string, BridgeResumeSessionCandidate>();
  for (const metadata of listReasonixDiskSessionMetadata(cwd)) {
    cacheReasonixSession(metadata);
    byId.set(metadata.sessionId, {
      sessionId: metadata.sessionId,
      threadId: metadata.sessionId,
      title: metadata.title,
      lastUpdatedAt: metadata.lastUpdatedAt,
      cwd: metadata.cwd,
      ...(metadata.userRenamed
        ? { projectName: path.basename(metadata.cwd) || metadata.cwd }
        : {}),
    });
  }
  for (const session of acpSessions) {
    if (session.cwd) reasonixSessionCwdById.set(session.sessionId, session.cwd);
    const existing = byId.get(session.sessionId);
    if (!existing || Date.parse(session.lastUpdatedAt) >= Date.parse(existing.lastUpdatedAt)) {
      byId.set(session.sessionId, {
        ...existing,
        ...session,
        title: session.title || existing?.title ||
          `reasonix 会话 ${session.sessionId.slice(0, 8)}`,
      });
    }
  }
  return [...byId.values()]
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt))
    .slice(0, Math.max(1, limit));
}

function findReasonixTranscript(sessionId: string): ReasonixSessionMetadata | null {
  if (!sessionId || path.basename(sessionId) !== sessionId) return null;
  const cachedTranscript = reasonixSessionTranscriptById.get(sessionId);
  if (cachedTranscript) {
    const cached = readReasonixSessionMetadata(
      cachedTranscript,
      reasonixSessionCwdById.get(sessionId) ?? process.cwd(),
    );
    if (cached) return cached;
  }
  const cachedStateRoot = reasonixSessionStateRootById.get(sessionId);
  if (cachedStateRoot) {
    const cached = readReasonixSessionMetadata(
      path.join(cachedStateRoot, "sessions", `${sessionId}${REASONIX_TRANSCRIPT_SUFFIX}`),
      reasonixSessionCwdById.get(sessionId) ?? process.cwd(),
    );
    if (cached) return cached;
  }
  const metadata = listReasonixDiskSessionMetadata(
    reasonixSessionCwdById.get(sessionId) ?? process.cwd(),
  ).find((entry) => entry.sessionId === sessionId) ?? null;
  if (metadata) cacheReasonixSession(metadata);
  return metadata;
}

export function resolveReasonixSessionCwd(sessionId: string): string | null {
  const cached = reasonixSessionCwdById.get(sessionId);
  if (cached) return cached;
  return findReasonixTranscript(sessionId)?.cwd ?? null;
}

export function resolveReasonixSessionStateRoot(sessionId: string): string {
  const cached = reasonixSessionStateRootById.get(sessionId);
  if (cached) return cached;
  return findReasonixTranscript(sessionId)?.stateRoot ?? reasonixStateRoot();
}

export async function readReasonixSessionMessages(
  _cwd: string,
  sessionId: string,
): Promise<BridgeSessionMessage[]> {
  const metadata = findReasonixTranscript(sessionId);
  if (!metadata) return [];
  try {
    return parseReasonixTranscript(
      await fs.promises.readFile(metadata.transcriptPath, "utf8"),
      { sessionId, model: metadata.model },
    );
  } catch {
    return [];
  }
}

export function buildReasonixServeArgs(
  options: AdapterOptions,
  port: number,
  portFile: string,
  resumePath?: string,
): string[] {
  return [
    "serve",
    ...(options.profile ? ["-model", options.profile] : []),
    ...(options.extraCliArgs ?? []),
    "-addr",
    `${REASONIX_SERVER_HOST}:${port}`,
    "-auth",
    "none",
    "-port-file",
    portFile,
    ...(resumePath ? ["-resume", resumePath] : []),
  ];
}

type ReasonixPendingApproval = {
  id: string;
  request: ApprovalRequest;
};

type ReasonixPendingAsk = {
  id: string;
  request: UserInputRequest;
};

export class ReasonixServerAdapter implements BridgeAdapter {
  private readonly options: AdapterOptions;
  private readonly state: BridgeAdapterState;
  private eventSink: EventSink = () => undefined;
  private child: ChildProcess | null = null;
  private serverPort = 0;
  private endpoint = "";
  private portFile = "";
  private eventAbortController: AbortController | null = null;
  private eventTask: Promise<void> | null = null;
  private generation = 0;
  private disposing = false;
  private restarting = false;
  private browserOpened = false;
  private turnActive = false;
  private interruptRequested = false;
  private currentReply = "";
  private pendingApproval: ReasonixPendingApproval | null = null;
  private pendingAsk: ReasonixPendingAsk | null = null;
  private readonly seenServerEventIds = new Set<string>();
  private readonly seenServerEventOrder: string[] = [];

  constructor(options: AdapterOptions) {
    this.options = options;
    const shouldRestore = options.sessionStartMode !== "new";
    const initialSessionId = shouldRestore
      ? options.initialSharedSessionId ?? options.initialSharedThreadId
      : undefined;
    this.state = {
      kind: "reasonix",
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
    if (this.child) return;
    this.disposing = false;
    this.setStatus("starting", "正在连接 reasonix。");
    this.serverPort = await reserveLocalPort();
    const initialSessionId = this.state.sharedSessionId;
    const resumePath = initialSessionId
      ? findReasonixTranscript(initialSessionId)?.transcriptPath
      : undefined;
    if (initialSessionId && !resumePath) {
      throw new Error("无法读取原 reasonix 任务，未创建副本会话。");
    }
    try {
      await this.startServer(resumePath);
      if (!initialSessionId || this.options.sessionStartMode === "new") {
        await this.post("/new");
        this.setSessionId(undefined);
      }
      this.setStatus("idle");
    } catch (error) {
      await this.stopServer();
      this.setStatus("error");
      throw error;
    }
  }

  async sendInput(text: string): Promise<void> {
    const normalized = text.trim();
    if (!normalized) throw new Error("消息不能为空。");
    if (this.state.status === "busy") {
      throw new Error("reasonix 仍在处理，请等待当前回复或发送 /stop。");
    }
    if (this.pendingApproval) throw new Error("reasonix 正在等待审批。");
    if (this.pendingAsk) throw new Error("reasonix 正在等待补充信息。");
    this.currentReply = "";
    this.turnActive = true;
    this.interruptRequested = false;
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "wechat";
    this.setStatus("busy");
    process.stderr.write(`\n[reasonix] > ${normalized}\n`);
    try {
      const response = await this.post("/submit", { input: normalized });
      if (response.status !== 202 && response.status !== 204) {
        throw new Error(`reasonix 未接受消息（${response.status}）。`);
      }
    } catch (error) {
      this.turnActive = false;
      this.currentReply = "";
      this.setStatus("error");
      throw error;
    }
  }

  async sendInputToSession(
    sessionId: string,
    text: string,
  ): Promise<BridgeSessionSendResult> {
    if (sessionId !== this.state.sharedSessionId) await this.resumeSession(sessionId);
    await this.sendInput(text);
    return {};
  }

  async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    const sessions = await listReasonixSessions(this.options.cwd, limit);
    return sessions.map((session) => session.sessionId === this.state.sharedSessionId
      ? {
          ...session,
          runtimeStatus: this.state.status === "busy" || this.state.status === "awaiting_approval"
            ? {
                type: "active" as const,
                activeFlags: this.state.status === "awaiting_approval"
                  ? ["waitingOnApproval" as const]
                  : [],
              }
            : { type: "idle" as const },
        }
      : session);
  }

  async resumeSession(sessionId: string): Promise<void> {
    const metadata = findReasonixTranscript(sessionId);
    if (!metadata) {
      throw new Error("无法读取该 reasonix 任务；为避免会话分叉，未复制历史后重开。");
    }
    await this.restartServer(metadata.transcriptPath, metadata.cwd);
    this.setSessionId(sessionId);
    this.emit({
      type: "session_switched",
      sessionId,
      source: "wechat",
      reason: "wechat_resume",
      timestamp: nowIso(),
    });
    this.setStatus("idle");
  }

  async createSession(): Promise<void> {
    await this.restartServer(undefined, this.options.cwd);
    await this.post("/new");
    this.setSessionId(undefined);
    this.setStatus("idle");
  }

  async getLatestSessionMessage(sessionId: string): Promise<BridgeSessionMessage | null> {
    return (await this.getSessionMessages(sessionId)).at(-1) ?? null;
  }

  async getSessionMessages(sessionId: string): Promise<BridgeSessionMessage[]> {
    return await readReasonixSessionMessages(this.options.cwd, sessionId);
  }

  async interrupt(): Promise<boolean> {
    if (!this.turnActive && !this.pendingApproval && !this.pendingAsk) return false;
    this.interruptRequested = true;
    await this.post("/cancel");
    this.pendingApproval = null;
    this.pendingAsk = null;
    this.state.pendingApproval = null;
    this.state.pendingUserInput = null;
    return true;
  }

  async reset(): Promise<void> {
    if (this.turnActive) await this.interrupt();
    await this.createSession();
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    return await this.resolveReasonixApproval(action, false);
  }

  async resolveAllApprovals(action: "confirm" | "deny"): Promise<number> {
    return await this.resolveApproval(action) ? 1 : 0;
  }

  async resolveApprovalForSession(): Promise<boolean> {
    return await this.resolveReasonixApproval("confirm", true);
  }

  async resolveAllApprovalsForSession(): Promise<number> {
    return await this.resolveApprovalForSession() ? 1 : 0;
  }

  async submitUserInput(answers: Record<string, string[]>): Promise<boolean> {
    const pending = this.pendingAsk;
    if (!pending) return false;
    await this.post("/answer", {
      id: pending.id,
      answers: pending.request.questions.map((question) => ({
        questionId: question.id,
        selected: answers[question.id] ?? [],
      })),
    });
    this.pendingAsk = null;
    this.state.pendingUserInput = null;
    this.setStatus("busy");
    return true;
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    this.generation += 1;
    await this.stopServer();
    this.state.status = "stopped";
    this.state.pid = undefined;
  }

  getState(): BridgeAdapterState {
    return JSON.parse(JSON.stringify(this.state)) as BridgeAdapterState;
  }

  private async startServer(resumePath?: string): Promise<void> {
    const generation = ++this.generation;
    const portFile = path.join(
      os.tmpdir(),
      `werelay-reasonix-${process.pid}-${this.serverPort}.port`,
    );
    try {
      fs.unlinkSync(portFile);
    } catch {
      // Missing stale file is expected.
    }
    this.portFile = portFile;
    const env = buildCliEnvironment("reasonix");
    const target = resolveSpawnTarget(this.options.command, "reasonix", { env });
    const child = spawn(
      target.file,
      [...target.args, ...buildReasonixServeArgs(
        this.options,
        this.serverPort,
        portFile,
        resumePath,
      )],
      {
        cwd: resumePath
          ? resolveReasonixSessionCwd(path.basename(resumePath, REASONIX_TRANSCRIPT_SUFFIX)) ?? this.options.cwd
          : this.options.cwd,
        env,
        stdio: "inherit",
        windowsHide: false,
      },
    );
    this.child = child;
    this.state.pid = child.pid;
    this.state.startedAt = nowIso();
    child.once("error", (error) => {
      if (generation !== this.generation || this.disposing || this.restarting) return;
      this.failFatal(`reasonix 启动失败：${describeUnknownError(error)}`);
    });
    child.once("exit", (code, signal) => {
      if (generation !== this.generation || this.disposing || this.restarting) return;
      this.child = null;
      this.state.pid = undefined;
      this.setStatus("stopped", "reasonix 本地会话已关闭。");
      this.emit({
        type: "shutdown_requested",
        reason: "companion_closed",
        message: `reasonix 本地会话已关闭（${signal ? `信号 ${signal}` : `代码 ${code ?? "未知"}`}）。`,
        exitCode: typeof code === "number" ? code : 0,
        timestamp: nowIso(),
      });
    });
    try {
      await this.waitUntilReady();
    } catch (error) {
      await this.stopServer();
      throw error;
    }
    this.endpoint = `http://${REASONIX_SERVER_HOST}:${this.serverPort}`;
    this.seenServerEventIds.clear();
    this.seenServerEventOrder.length = 0;
    this.startEventLoop(generation);
    if (!this.browserOpened) {
      this.browserOpened = true;
      this.openOfficialWebUi();
    }
  }

  private async restartServer(resumePath: string | undefined, cwd: string): Promise<void> {
    this.restarting = true;
    try {
      await this.stopServer();
      this.state.cwd = cwd;
      await this.startServer(resumePath);
    } finally {
      this.restarting = false;
    }
  }

  private async stopServer(): Promise<void> {
    this.generation += 1;
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    const eventTask = this.eventTask;
    this.eventTask = null;
    await eventTask?.catch(() => undefined);
    const child = this.child;
    this.child = null;
    if (child?.pid) {
      try {
        killProcessTreeSync(child.pid);
      } catch {
        // Best effort shutdown.
      }
      if (!await waitForChildExit(child)) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // The process may have exited between checks.
        }
        await waitForChildExit(child, 1_000);
      }
    }
    if (this.portFile) {
      try {
        fs.unlinkSync(this.portFile);
      } catch {
        // Best effort stale-file cleanup.
      }
    }
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + REASONIX_SERVER_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child?.exitCode !== null) {
        throw new Error("reasonix 本地会话服务启动后立即退出，请先运行 reasonix doctor。");
      }
      try {
        const portText = fs.readFileSync(this.portFile, "utf8").trim();
        if (portText.endsWith(`:${this.serverPort}`)) {
          const response = await fetch(`http://${REASONIX_SERVER_HOST}:${this.serverPort}/status`);
          if (response.ok) return;
        }
      } catch {
        // Keep polling until the server writes the port file and accepts requests.
      }
      await new Promise((resolve) => setTimeout(resolve, REASONIX_SERVER_POLL_INTERVAL_MS));
    }
    throw new Error("reasonix 本地会话服务启动超时，请先运行 reasonix doctor。");
  }

  private startEventLoop(generation: number): void {
    this.eventAbortController?.abort();
    const controller = new AbortController();
    this.eventAbortController = controller;
    this.eventTask = this.runEventLoop(generation, controller.signal).catch((error) => {
      if (generation !== this.generation || this.disposing || controller.signal.aborted) return;
      this.failFatal(`reasonix 消息连接中断：${describeUnknownError(error)}`);
    });
  }

  private async runEventLoop(generation: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted && generation === this.generation) {
      const response = await fetch(`${this.endpoint}/events`, { signal });
      if (!response.ok) throw new Error(`事件接口返回 ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("事件接口没有返回数据流");
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          while (true) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = block.split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            try {
              await this.handleServerEvent(JSON.parse(data));
            } catch {
              // Ignore malformed individual events without dropping the stream.
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  private async handleServerEvent(value: unknown): Promise<void> {
    if (!isRecord(value) || this.isDuplicateServerEvent(value)) return;
    const kind = readString(value.kind);
    this.state.lastOutputAt = nowIso();
    if (kind === "turn_started") {
      this.turnActive = true;
      this.setStatus("busy");
      await this.refreshCurrentSessionId();
      return;
    }
    if (kind === "reasoning") {
      const text = readString(value.reasoning) ?? readString(value.text);
      if (text) this.emit({ type: "thinking", text, timestamp: nowIso() });
      return;
    }
    if (kind === "text") {
      const text = typeof value.text === "string" ? value.text : "";
      if (text) {
        this.currentReply += text;
        process.stdout.write(text);
      }
      return;
    }
    if (kind === "message" && typeof value.text === "string" && value.text.trim()) {
      this.currentReply = value.text;
      return;
    }
    if (kind === "approval_request" && isRecord(value.approval)) {
      this.handleApproval(value.approval);
      return;
    }
    if (kind === "ask_request" && isRecord(value.ask)) {
      this.handleAsk(value.ask);
      return;
    }
    if (kind !== "turn_done" || !this.turnActive) return;

    process.stdout.write("\n");
    this.turnActive = false;
    await this.refreshCurrentSessionId();
    const sessionId = this.state.sharedSessionId;
    const error = readString(value.err);
    const outcomeText = readString(value.outcome);
    const finalText = this.currentReply.trim();
    this.pendingApproval = null;
    this.pendingAsk = null;
    this.state.pendingApproval = null;
    this.state.pendingUserInput = null;
    if (error) {
      this.currentReply = "";
      this.interruptRequested = false;
      this.setStatus("error");
      this.emit({
        type: "task_failed",
        message: error,
        timestamp: nowIso(),
        threadId: sessionId,
        origin: "wechat",
      });
      return;
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
    this.setStatus("idle");
    this.emit({
      type: "task_complete",
      summary: truncatePreview(finalText || "reasonix 任务已完成", 240),
      outcome: this.interruptRequested || outcomeText === "cancelled" ? "interrupted" : "completed",
      timestamp: nowIso(),
      threadId: sessionId,
      origin: "wechat",
    });
    this.currentReply = "";
    this.interruptRequested = false;
  }

  private isDuplicateServerEvent(value: Record<string, unknown>): boolean {
    const eventId = readEventId(value.event_id);
    if (!eventId) return false;
    if (this.seenServerEventIds.has(eventId)) return true;
    this.seenServerEventIds.add(eventId);
    this.seenServerEventOrder.push(eventId);
    if (this.seenServerEventOrder.length > 2_048) {
      const oldest = this.seenServerEventOrder.shift();
      if (oldest) this.seenServerEventIds.delete(oldest);
    }
    return false;
  }

  private handleApproval(value: Record<string, unknown>): void {
    const id = readString(value.id);
    if (!id) return;
    const tool = readString(value.tool) ?? "工具操作";
    const subject = readString(value.subject) ?? tool;
    const request: ApprovalRequest = {
      source: "cli",
      threadId: this.state.sharedSessionId,
      origin: "wechat",
      summary: `reasonix 请求执行：${tool}`,
      commandPreview: truncatePreview(subject, 800),
      toolName: tool,
      detailLabel: tool,
      detailPreview: truncatePreview(subject, 800),
      allowForSession: true,
      requestId: id,
    };
    this.pendingApproval = { id, request };
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

  private handleAsk(value: Record<string, unknown>): void {
    const id = readString(value.id);
    if (!id || !Array.isArray(value.questions)) return;
    const questions = value.questions.flatMap((entry, index) => {
      if (!isRecord(entry)) return [];
      const questionId = readString(entry.id) ?? `q_${index}`;
      const prompt = readString(entry.prompt) ?? "请选择";
      const options = Array.isArray(entry.options)
        ? entry.options.flatMap((option) => isRecord(option) && readString(option.label)
          ? [{
              label: readString(option.label)!,
              description: readString(option.description) ?? "",
            }]
          : [])
        : [];
      return [{
        id: questionId,
        header: "reasonix",
        question: prompt,
        isOther: false,
        isSecret: false,
        options,
      }];
    });
    if (questions.length === 0) return;
    const request: UserInputRequest = {
      summary: questions[0]?.question ?? "reasonix 需要补充信息",
      threadId: this.state.sharedSessionId,
      origin: "wechat",
      questions,
    };
    this.pendingAsk = { id, request };
    this.state.pendingUserInput = request;
    this.setStatus("awaiting_approval");
    this.emit({
      type: "user_input_required",
      request,
      timestamp: nowIso(),
      threadId: request.threadId,
      origin: "wechat",
    });
  }

  private async resolveReasonixApproval(
    action: "confirm" | "deny",
    session: boolean,
  ): Promise<boolean> {
    const pending = this.pendingApproval;
    if (!pending) return false;
    await this.post("/approve", {
      id: pending.id,
      allow: action === "confirm",
      session: action === "confirm" && session,
      persist: false,
      scope: "",
    });
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.setStatus("busy");
    return true;
  }

  private async refreshCurrentSessionId(): Promise<void> {
    try {
      const sessions = await this.fetchJson("/sessions");
      if (!Array.isArray(sessions)) return;
      const current = sessions.find((entry) => isRecord(entry) && entry.current === true);
      if (!isRecord(current)) return;
      const rawId = readString(current.id) ?? readString(current.name) ?? readString(current.path);
      if (!rawId) return;
      const sessionId = path.basename(rawId).replace(/\.jsonl$/i, "");
      if (sessionId) this.setSessionId(sessionId);
    } catch {
      // Session discovery will retry on the next lifecycle event.
    }
  }

  private setSessionId(sessionId: string | undefined): void {
    this.state.sharedSessionId = sessionId;
    this.state.activeRuntimeSessionId = sessionId;
    this.state.lastSessionSwitchAt = nowIso();
  }

  private async fetchJson(pathname: string): Promise<unknown> {
    const response = await fetch(`${this.endpoint}${pathname}`);
    if (!response.ok) throw new Error(`reasonix 接口失败（${response.status}）。`);
    return await response.json();
  }

  private async post(pathname: string, body?: Record<string, unknown>): Promise<Response> {
    const response = await fetch(`${this.endpoint}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) {
      const detail = truncatePreview((await response.text()).trim(), 300);
      throw new Error(
        `reasonix 请求失败（${response.status}）${detail ? `：${detail}` : ""}`,
      );
    }
    return response;
  }

  private openOfficialWebUi(): void {
    if (process.env.WERELAY_REASONIX_OPEN_WEB?.trim() === "0") return;
    const url = this.endpoint;
    try {
      if (process.platform === "darwin") {
        spawn("/usr/bin/open", ["-g", url], { detached: true, stdio: "ignore" }).unref();
      } else if (process.platform === "win32") {
        spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", "start", "", url], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        }).unref();
      } else {
        spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
      }
    } catch {
      // The terminal still prints the official Reasonix URL when no browser opener exists.
    }
  }

  private failFatal(message: string): void {
    this.setStatus("error");
    this.emit({ type: "fatal_error", message, timestamp: nowIso() });
  }

  private setStatus(status: BridgeAdapterState["status"], message?: string): void {
    this.state.status = status;
    this.emit({ type: "status", status, message, timestamp: nowIso() });
  }

  private emit(event: BridgeEvent): void {
    this.eventSink(event);
  }
}

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  type AdapterOptions,
  buildCliEnvironment,
  resolveSpawnTarget,
} from "./bridge-adapters.shared.ts";
import type {
  BridgeResumeSessionCandidate,
  BridgeSessionMessage,
} from "./bridge-types.ts";
import {
  AcpBridgeAdapter,
  type AcpTransport,
  type AcpTransportCallbacks,
} from "./bridge-adapters.acp.ts";
import { isRecord } from "./bridge-adapter-common.ts";
import { killProcessTreeSync } from "./bridge-process-reaper.ts";
import { truncatePreview } from "./bridge-utils.ts";

const CODEBUDDY_HTTP_START_TIMEOUT_MS = 15_000;
const CODEBUDDY_HTTP_POLL_INTERVAL_MS = 150;
const CODEBUDDY_HTTP_REQUEST_TIMEOUT_MS = 30_000;
const CODEBUDDY_HTTP_HOST = "127.0.0.1";

type CodeBuddyAcpCredentials = {
  connectionId: string;
  sessionToken?: string;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, CODEBUDDY_HTTP_HOST, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("无法分配 CodeBuddy 本地端口。"));
        else resolve(port);
      });
    });
  });
}

export function buildCodeBuddyServeArgs(
  options: AdapterOptions,
  port: number,
): string[] {
  return [
    ...(options.profile ? ["--agent", options.profile] : []),
    ...(options.extraCliArgs ?? []),
    "--serve",
    "--port",
    String(port),
    "--host",
    CODEBUDDY_HTTP_HOST,
  ];
}

export function parseCodeBuddyAcpSse(text: string): unknown[] {
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
      // Ignore malformed keepalive or partial events.
    }
  }
  return messages;
}

class CodeBuddyHttpAcpTransport implements AcpTransport {
  private readonly options: AdapterOptions;
  private readonly cwd: string;
  private readonly environmentOverrides: Record<string, string>;
  private readonly callbacks: AcpTransportCallbacks;
  private child: ChildProcess | null = null;
  private endpoint = "";
  private credentials: CodeBuddyAcpCredentials | null = null;
  private getAbortController: AbortController | null = null;
  private getTask: Promise<void> | null = null;
  private disposing = false;

  constructor(
    options: AdapterOptions,
    cwd: string,
    environmentOverrides: Record<string, string>,
    callbacks: AcpTransportCallbacks,
  ) {
    this.options = options;
    this.cwd = cwd;
    this.environmentOverrides = environmentOverrides;
    this.callbacks = callbacks;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  async start(): Promise<void> {
    const port = await reserveLoopbackPort();
    this.endpoint = `http://${CODEBUDDY_HTTP_HOST}:${port}/api/v1/acp`;
    const env = {
      ...buildCliEnvironment("codebuddy"),
      ...this.environmentOverrides,
    };
    const target = resolveSpawnTarget(this.options.command, "codebuddy", { env });
    const child = spawn(
      target.file,
      [...target.args, ...buildCodeBuddyServeArgs(this.options, port)],
      {
        cwd: this.cwd,
        env,
        stdio: "inherit",
        windowsHide: false,
      },
    );
    this.child = child;
    child.once("error", (error) => {
      if (!this.disposing) this.callbacks.failure(error);
    });
    child.once("exit", (code) => {
      if (!this.disposing) this.callbacks.close(code);
    });

    try {
      await this.waitUntilReady(port);
      await this.connect();
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async send(message: Record<string, unknown>): Promise<void> {
    const credentials = this.requireCredentials();
    const controller = new AbortController();
    const isPrompt = message.method === "session/prompt";
    const timer = isPrompt ? null : setTimeout(() => controller.abort(), CODEBUDDY_HTTP_REQUEST_TIMEOUT_MS);
    timer?.unref?.();
    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers(credentials),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = truncatePreview((await response.text()).trim(), 300);
        throw new Error(
          `CodeBuddy 请求失败（${response.status}）${detail ? `：${detail}` : ""}`,
        );
      }
      await this.readResponse(response);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    this.getAbortController?.abort();
    this.getAbortController = null;
    const credentials = this.credentials;
    this.credentials = null;
    if (credentials && this.endpoint) {
      await fetch(this.endpoint, {
        method: "DELETE",
        headers: this.headers(credentials),
      }).catch(() => undefined);
    }
    await this.getTask?.catch(() => undefined);
    this.getTask = null;
    const child = this.child;
    this.child = null;
    if (child?.pid) {
      try {
        killProcessTreeSync(child.pid);
      } catch {
        // Best effort shutdown.
      }
    }
  }

  private async waitUntilReady(port: number): Promise<void> {
    const healthUrl = `http://${CODEBUDDY_HTTP_HOST}:${port}/api/v1/health`;
    const deadline = Date.now() + CODEBUDDY_HTTP_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child?.exitCode !== null) {
        throw new Error("CodeBuddy 本地会话服务启动后立即退出，请先运行 codebuddy 检查登录状态。");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 500);
      try {
        const response = await fetch(healthUrl, {
          headers: { "x-codebuddy-request": "1" },
          signal: controller.signal,
        });
        if (response.ok) return;
      } catch {
        // Keep polling until the process is ready or the deadline expires.
      } finally {
        clearTimeout(timer);
      }
      await delay(CODEBUDDY_HTTP_POLL_INTERVAL_MS);
    }
    throw new Error("CodeBuddy 本地会话服务启动超时，请先运行 codebuddy doctor 检查环境。");
  }

  private async connect(): Promise<void> {
    const response = await fetch(`${this.endpoint}/connect`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "x-codebuddy-request": "1",
      },
    });
    if (!response.ok) {
      throw new Error(`CodeBuddy ACP 连接失败（${response.status}）。`);
    }
    const payload = await response.json() as Record<string, unknown>;
    const connectionId = readString(payload.connectionId);
    if (!connectionId) {
      throw new Error("CodeBuddy ACP 未返回连接 ID。");
    }
    this.credentials = {
      connectionId,
      sessionToken: readString(payload.sessionToken),
    };
    this.getAbortController = new AbortController();
    this.getTask = this.readGetStream(this.getAbortController.signal).catch((error) => {
      if (!this.disposing) {
        this.callbacks.failure(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async readGetStream(signal: AbortSignal): Promise<void> {
    const response = await fetch(this.endpoint, {
      headers: this.headers(this.requireCredentials()),
      signal,
    });
    if (!response.ok) {
      throw new Error(`CodeBuddy 事件连接失败（${response.status}）。`);
    }
    await this.readResponse(response);
  }

  private async readResponse(response: Response): Promise<void> {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      const text = await response.text();
      if (!text.trim()) return;
      try {
        this.callbacks.message(JSON.parse(text));
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
          for (const message of parseCodeBuddyAcpSse(`${block}\n\n`)) {
            this.callbacks.message(message);
          }
        }
      }
      for (const message of parseCodeBuddyAcpSse(buffer)) {
        this.callbacks.message(message);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private headers(credentials: CodeBuddyAcpCredentials): Record<string, string> {
    return {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "x-codebuddy-request": "1",
      "acp-connection-id": credentials.connectionId,
      ...(credentials.sessionToken ? { "acp-session-token": credentials.sessionToken } : {}),
    };
  }

  private requireCredentials(): CodeBuddyAcpCredentials {
    if (!this.credentials) {
      throw new Error("CodeBuddy ACP 尚未连接。");
    }
    return this.credentials;
  }
}

function normalizeComparablePath(value: string): string {
  const resolved = path.resolve(value);
  return resolved === path.parse(resolved).root
    ? resolved
    : resolved.replace(/[\\/]+$/, "");
}

function codeBuddyConfigDir(): string {
  return process.env.CODEBUDDY_CONFIG_DIR?.trim() ?? path.join(os.homedir(), ".codebuddy");
}

export function codeBuddyProjectDirectoryName(cwd: string): string {
  return normalizeComparablePath(cwd)
    .replace(/^[\\/]+/, "")
    .replace(/[:\\/]+/g, "-");
}

function codeBuddyContentText(value: unknown): string {
  if (typeof value === "string") return value.trim();
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

export function parseCodeBuddyTranscript(text: string): BridgeSessionMessage[] {
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
    const messageText = codeBuddyContentText(value.content);
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

type CodeBuddyTranscriptMetadata = {
  sessionId?: string;
  cwd?: string;
  title?: string;
  userRenamed?: boolean;
  firstTimestampMs?: number;
  lastUpdatedAtMs?: number;
};

type CachedCodeBuddyTranscriptMetadata = {
  mtimeMs: number;
  size: number;
  metadata: CodeBuddyTranscriptMetadata;
};

const codeBuddyTranscriptMetadataCache = new Map<
  string,
  CachedCodeBuddyTranscriptMetadata
>();
const codeBuddyTranscriptPathsBySession = new Map<string, string[]>();
const codeBuddySessionCwdById = new Map<string, string>();

function parseCodeBuddyTranscriptMetadata(text: string): CodeBuddyTranscriptMetadata {
  const metadata: CodeBuddyTranscriptMetadata = {};
  let generatedTitle: string | undefined;
  let customTitle: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    metadata.sessionId ??= readString(value.sessionId);
    metadata.cwd ??= readString(value.cwd);
    const timestamp = typeof value.timestamp === "number"
      ? value.timestamp
      : Number(value.timestamp);
    if (Number.isFinite(timestamp)) {
      metadata.firstTimestampMs = Math.min(
        metadata.firstTimestampMs ?? timestamp,
        timestamp,
      );
      metadata.lastUpdatedAtMs = Math.max(metadata.lastUpdatedAtMs ?? 0, timestamp);
    }
    if (value.type === "custom-title") {
      customTitle = readString(value.customTitle) ?? customTitle;
    } else if (value.type === "ai-title") {
      generatedTitle = readString(value.aiTitle) ?? generatedTitle;
    } else if (value.type === "message" && value.role === "user" && !metadata.title) {
      const textContent = codeBuddyContentText(value.content).replace(/\s+/g, " ").trim();
      if (textContent) metadata.title = truncatePreview(textContent, 80);
    }
  }
  metadata.title = customTitle ?? generatedTitle ?? metadata.title;
  metadata.userRenamed = Boolean(customTitle);
  return metadata;
}

function codeBuddySessionCacheKey(sessionId: string): string {
  return `${codeBuddyConfigDir()}\0${sessionId}`;
}

function listCodeBuddyTranscriptPaths(): string[] {
  const projectsRoot = path.join(codeBuddyConfigDir(), "projects");
  const paths: string[] = [];
  const pending = [projectsRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(entryPath);
      }
    } catch {
      // Missing or unreadable history directories simply have no sessions.
    }
  }
  return paths;
}

async function readCodeBuddyTranscriptMetadata(
  transcriptPath: string,
  stat: fs.Stats,
): Promise<CodeBuddyTranscriptMetadata | null> {
  const cached = codeBuddyTranscriptMetadataCache.get(transcriptPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.metadata;
  }
  try {
    const metadata = parseCodeBuddyTranscriptMetadata(
      await fs.promises.readFile(transcriptPath, "utf8"),
    );
    codeBuddyTranscriptMetadataCache.set(transcriptPath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      metadata,
    });
    return metadata;
  } catch {
    return null;
  }
}

export async function listCodeBuddySessions(
  cwd: string,
  limit: number,
): Promise<BridgeResumeSessionCandidate[]> {
  const normalizedCwd = normalizeComparablePath(cwd);
  const directDirectory = path.join(
    codeBuddyConfigDir(),
    "projects",
    codeBuddyProjectDirectoryName(cwd),
  );
  const bySessionId = new Map<string, {
    candidate: BridgeResumeSessionCandidate;
    canonicalTimestampMs: number;
    latestTimestampMs: number;
    transcriptPaths: string[];
  }>();
  for (const transcriptPath of listCodeBuddyTranscriptPaths()) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(transcriptPath);
    } catch {
      continue;
    }
    const metadata = await readCodeBuddyTranscriptMetadata(transcriptPath, stat);
    if (!metadata) continue;
    const inferredCwd = metadata.cwd ?? (
      path.dirname(transcriptPath) === directDirectory ? normalizedCwd : undefined
    );
    if (!inferredCwd) continue;
    const sessionCwd = normalizeComparablePath(inferredCwd);
    const sessionId = metadata.sessionId ?? path.basename(transcriptPath, ".jsonl");
    if (!sessionId) continue;
    const canonicalTimestampMs = metadata.firstTimestampMs ?? stat.birthtimeMs ?? stat.mtimeMs;
    const updatedAtMs = Math.max(metadata.lastUpdatedAtMs ?? 0, stat.mtimeMs);
    const candidate: BridgeResumeSessionCandidate = {
      sessionId,
      threadId: sessionId,
      title: metadata.title ?? `CodeBuddy 会话 ${sessionId.slice(0, 8)}`,
      lastUpdatedAt: new Date(updatedAtMs).toISOString(),
      cwd: sessionCwd,
      ...(metadata.userRenamed
        ? { projectName: path.basename(sessionCwd) || sessionCwd }
        : {}),
    };
    const existing = bySessionId.get(sessionId);
    if (!existing) {
      bySessionId.set(sessionId, {
        candidate,
        canonicalTimestampMs,
        latestTimestampMs: updatedAtMs,
        transcriptPaths: [transcriptPath],
      });
      continue;
    }
    existing.transcriptPaths.push(transcriptPath);
    existing.latestTimestampMs = Math.max(existing.latestTimestampMs, updatedAtMs);
    if (canonicalTimestampMs < existing.canonicalTimestampMs) {
      existing.candidate = candidate;
      existing.canonicalTimestampMs = canonicalTimestampMs;
    }
    existing.candidate.lastUpdatedAt = new Date(existing.latestTimestampMs).toISOString();
  }
  for (const [sessionId, aggregate] of bySessionId) {
    aggregate.candidate.lastUpdatedAt = new Date(aggregate.latestTimestampMs).toISOString();
    const cacheKey = codeBuddySessionCacheKey(sessionId);
    codeBuddyTranscriptPathsBySession.set(cacheKey, aggregate.transcriptPaths);
    if (aggregate.candidate.cwd) {
      codeBuddySessionCwdById.set(cacheKey, aggregate.candidate.cwd);
    }
  }
  return [...bySessionId.values()].map((aggregate) => aggregate.candidate)
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt))
    .slice(0, Math.max(1, limit));
}

function findCodeBuddyTranscripts(cwd: string, sessionId: string): string[] {
  const projectsRoot = path.join(codeBuddyConfigDir(), "projects");
  const cacheKey = codeBuddySessionCacheKey(sessionId);
  const cached = codeBuddyTranscriptPathsBySession.get(cacheKey) ?? [];
  const direct = path.join(
    projectsRoot,
    codeBuddyProjectDirectoryName(cwd),
    `${sessionId}.jsonl`,
  );
  const legacy = path.join(projectsRoot, `${sessionId}.jsonl`);
  const fileName = `${sessionId}.jsonl`;
  const discovered = listCodeBuddyTranscriptPaths().filter(
    (transcriptPath) => path.basename(transcriptPath) === fileName,
  );
  const paths = [...new Set([...cached, direct, legacy, ...discovered])]
    .filter((transcriptPath) => fs.existsSync(transcriptPath))
    .sort((left, right) => {
      try {
        return fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs;
      } catch {
        return 0;
      }
    });
  codeBuddyTranscriptPathsBySession.set(cacheKey, paths);
  return paths;
}

export function resolveCodeBuddySessionCwd(sessionId: string): string | null {
  const cacheKey = codeBuddySessionCacheKey(sessionId);
  const cached = codeBuddySessionCwdById.get(cacheKey);
  if (cached) return cached;
  let canonical: { cwd: string; firstTimestampMs: number } | null = null;
  for (const transcript of findCodeBuddyTranscripts("/", sessionId)) {
    try {
      const stat = fs.statSync(transcript);
      const metadata = parseCodeBuddyTranscriptMetadata(fs.readFileSync(transcript, "utf8"));
      if (!metadata.cwd) continue;
      const firstTimestampMs = metadata.firstTimestampMs ?? stat.birthtimeMs ?? stat.mtimeMs;
      if (!canonical || firstTimestampMs < canonical.firstTimestampMs) {
        canonical = {
          cwd: normalizeComparablePath(metadata.cwd),
          firstTimestampMs,
        };
      }
    } catch {
      // Continue searching duplicate transcript copies.
    }
  }
  if (canonical) codeBuddySessionCwdById.set(cacheKey, canonical.cwd);
  return canonical?.cwd ?? null;
}

export async function readCodeBuddySessionMessages(
  cwd: string,
  sessionId: string,
): Promise<BridgeSessionMessage[]> {
  const messages: BridgeSessionMessage[] = [];
  const indexById = new Map<string, number>();
  for (const transcript of findCodeBuddyTranscripts(cwd, sessionId)) {
    let transcriptMessages: BridgeSessionMessage[];
    try {
      transcriptMessages = parseCodeBuddyTranscript(
        await fs.promises.readFile(transcript, "utf8"),
      );
    } catch {
      continue;
    }
    for (const message of transcriptMessages) {
      if (message.id && indexById.has(message.id)) {
        messages[indexById.get(message.id)!] = message;
      } else {
        if (message.id) indexById.set(message.id, messages.length);
        messages.push(message);
      }
    }
  }
  return messages;
}

export class CodeBuddyAcpAdapter extends AcpBridgeAdapter {
  constructor(options: AdapterOptions) {
    super(options, {
      kind: "codebuddy",
      buildArgs: () => [],
      createTransport: (adapterOptions, cwd, environmentOverrides, callbacks) =>
        new CodeBuddyHttpAcpTransport(
          adapterOptions,
          cwd,
          environmentOverrides,
          callbacks,
        ),
      listSessions: async (_request, cwd, limit) => listCodeBuddySessions(cwd, limit),
      readSessionMessages: readCodeBuddySessionMessages,
      resolveSessionCwd: resolveCodeBuddySessionCwd,
      restartProcessForSessionCwd: true,
    });
  }
}

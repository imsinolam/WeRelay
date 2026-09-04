import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { buildLocalCompanionToken } from "../companion/local-companion-link.ts";
import { t } from "../i18n/index.ts";
import { ensureWorkspaceChannelDir } from "../wechat/channel-config.ts";
import {
  buildClaudeFailureMessage,
  buildClaudeHookScript,
  buildClaudeHookSettings,
  buildClaudePermissionDecisionHookOutput,
  buildClaudePermissionApprovalRequest,
  extractClaudeAssistantMessageText,
  extractClaudeResumeConversationId,
  extractClaudeTranscriptFinalReply,
  findInjectedClaudePromptIndex,
  getClaudePermissionAutoResponse,
  getClaudeWechatOutboundAttachmentDenyMessage,
  normalizeClaudeAssistantMessage,
  parseClaudeHookPayload,
  type ClaudeHookPayload,
  type PendingInjectedClaudePrompt,
} from "./claude-hooks.ts";
import type {
  ApprovalRequest,
  BridgeNoticeLevel,
  BridgeResumeSessionCandidate,
  BridgeSessionMessage,
  BridgeSessionSendResult,
  BridgeThreadSwitchReason,
  BridgeThreadSwitchSource,
} from "./bridge-types.ts";
import {
  detectCliApproval,
  isThinkingForwardEnabled,
  normalizeOutput,
  nowIso,
  truncatePreview,
} from "./bridge-utils.ts";
import {
  ensurePrivateDir,
  writePrivateFileAtomic,
} from "../utils/private-files.ts";
import { AbstractPtyAdapter } from "./bridge-adapters.core.ts";
import * as shared from "./bridge-adapters.shared.ts";

type AdapterOptions = shared.AdapterOptions;
type ClaudePendingHookApproval = shared.ClaudePendingHookApproval;

const {
  CLAUDE_HOOK_LISTEN_HOST,
  CLAUDE_WECHAT_WORKING_NOTICE_DELAY_MS,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MODULE_DIR,
  buildClaudeCliArgs,
  delay,
  isClaudeInvalidResumeError,
  quotePosixCommandArg,
  quoteWindowsCommandArg,
  shouldIncludeClaudeNoAltScreen,
} = shared;

const CLAUDE_COMPACT_OUTPUT_LINE_RE =
  /^Compacted(?:\s*\(.*full summary.*\))?$/i;
const CLAUDE_COMPACT_FAILURE_RE =
  /Error:\s*Error during compaction:|(?:^|\b)API Error:|\b(?:compact|compaction)\s+failed\b|^Error:/i;
const CLAUDE_COMPACT_DEDUP_MS = 2_000;
const CLAUDE_BRACKETED_PASTE_START = "\u001b[200~";
const CLAUDE_BRACKETED_PASTE_END = "\u001b[201~";
const CLAUDE_REMOTE_ENTER_DELAY_MS = 40;
const CLAUDE_STARTUP_OUTPUT_BUFFER_LIMIT = 4_000;
const CLAUDE_TUI_READY_BUFFER_LIMIT = 12_000;
const CLAUDE_LOGIN_REQUIRED_RE = /Not logged in|Please run\s+\/login/i;

function claudeAdapterLabel(kind: AdapterOptions["kind"]): string {
  return kind === "tclaude" ? "TClaude" : "Claude Code";
}

export function resolveClaudeRuntimeDirectoryName(
  kind: "claude" | "tclaude",
): "claude-runtime" | "tclaude-runtime" {
  return kind === "tclaude" ? "tclaude-runtime" : "claude-runtime";
}

function isClaudeWorkspaceTrustPrompt(text: string): boolean {
  const compact = text.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  return (
    compact.includes("accessingworkspace") &&
    compact.includes("quicksafetycheck") &&
    compact.includes("projectyoucreatedoroneyoutrust") &&
    compact.includes("itrustthisfolder")
  );
}

function isClaudeInteractivePromptReady(text: string): boolean {
  const compact = text.replace(/[^\p{L}\p{N}❯]+/gu, "").toLowerCase();
  return compact.includes("claudecodev") &&
    compact.includes("forshortcuts") &&
    compact.includes("❯");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeClaudeProjectConfigKey(cwd: string): string {
  return path.resolve(cwd).replace(/\\/g, "/");
}


type ClaudeStoredSession = BridgeResumeSessionCandidate & {
  transcriptPath: string;
};

function claudeConfigDirectory(
  kind: AdapterOptions["kind"],
  homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir(),
): string {
  if (kind === "tclaude") {
    return process.env.TCLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, ".tclaude");
  }
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDir, ".claude");
}

function collectJsonlFiles(directory: string): string[] {
  const files: string[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(entryPath);
    }
  }
  return files;
}

function readClaudeTranscriptEdge(filePath: string, maxBytes: number, fromEnd = false): string {
  let file: number | undefined;
  try {
    const stat = fs.statSync(filePath);
    const length = Math.min(maxBytes, stat.size);
    if (length <= 0) return "";
    file = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(file, buffer, 0, length, fromEnd ? stat.size - length : 0);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (file !== undefined) {
      try { fs.closeSync(file); } catch { /* Best effort. */ }
    }
  }
}

function claudeMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((entry): string[] => {
    if (!isRecord(entry) || entry.type !== "text" || typeof entry.text !== "string") {
      return [];
    }
    return [entry.text];
  }).join("\n");
}

function cleanClaudeUserText(text: string): string {
  return text
    .replace(/<(?:system-reminder|local-command-caveat|local-command-stdout|ide_opened_file|in-app-browser-context)[^>]*>[\s\S]*?<\/(?:system-reminder|local-command-caveat|local-command-stdout|ide_opened_file|in-app-browser-context)>/gi, "")
    .replace(/<command-[^>]+>[\s\S]*?<\/command-[^>]+>/gi, "")
    .trim();
}

function parseClaudeTranscriptLine(line: string): {
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  message?: BridgeSessionMessage;
} | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId : undefined;
  const cwd = typeof value.cwd === "string" ? value.cwd : undefined;
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : undefined;
  if (value.type !== "user" && value.type !== "assistant") {
    return { sessionId, cwd, timestamp };
  }
  if (value.isSidechain === true || value.isMeta === true) {
    return { sessionId, cwd, timestamp };
  }
  const message = isRecord(value.message) ? value.message : undefined;
  const rawText = claudeMessageText(message?.content);
  const text = value.type === "user" ? cleanClaudeUserText(rawText) : rawText.trim();
  if (!text) return { sessionId, cwd, timestamp };
  const model = value.type === "assistant" && typeof message?.model === "string"
    ? message.model.trim()
    : "";
  return {
    sessionId,
    cwd,
    timestamp,
    message: {
      role: value.type,
      text,
      ...(typeof value.uuid === "string" ? { id: value.uuid } : {}),
      ...(value.type === "assistant" ? { phase: "final_answer" as const } : {}),
      ...(model && !/^<.*>$/.test(model) ? { model } : {}),
    },
  };
}

export function parseClaudeTranscript(text: string): BridgeSessionMessage[] {
  const messages: BridgeSessionMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseClaudeTranscriptLine(line);
    if (parsed?.message) messages.push(parsed.message);
  }
  return messages;
}

function inspectClaudeTranscript(filePath: string): ClaudeStoredSession | null {
  const sessionIdFromFile = path.basename(filePath, ".jsonl");
  let sessionId = sessionIdFromFile;
  let cwd: string | undefined;
  let title = "";
  let lastUpdatedAt = "";
  const prefix = readClaudeTranscriptEdge(filePath, 256 * 1024);
  for (const line of prefix.split(/\r?\n/)) {
    const parsed = parseClaudeTranscriptLine(line);
    if (!parsed) continue;
    sessionId = parsed.sessionId ?? sessionId;
    cwd = parsed.cwd ?? cwd;
    lastUpdatedAt = parsed.timestamp ?? lastUpdatedAt;
    if (!title && parsed.message?.role === "user") {
      title = truncatePreview(parsed.message.text, 80);
    }
  }
  const suffix = readClaudeTranscriptEdge(filePath, 128 * 1024, true);
  for (const line of suffix.split(/\r?\n/)) {
    const parsed = parseClaudeTranscriptLine(line);
    if (!parsed) continue;
    sessionId = parsed.sessionId ?? sessionId;
    cwd = parsed.cwd ?? cwd;
    lastUpdatedAt = parsed.timestamp ?? lastUpdatedAt;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (!lastUpdatedAt) lastUpdatedAt = stat.mtime.toISOString();
  return {
    sessionId,
    threadId: sessionId,
    title: title || `会话 ${sessionId.slice(0, 8)}`,
    lastUpdatedAt,
    ...(cwd ? { cwd } : {}),
    transcriptPath: filePath,
  };
}

export function listClaudeStoredSessions(
  kind: Extract<AdapterOptions["kind"], "claude" | "tclaude">,
  limit = 10,
  homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir(),
): ClaudeStoredSession[] {
  const projectsDirectory = path.join(claudeConfigDirectory(kind, homeDir), "projects");
  const bySessionId = new Map<string, ClaudeStoredSession>();
  for (const session of collectJsonlFiles(projectsDirectory)
    .map(inspectClaudeTranscript)
    .filter((candidate): candidate is ClaudeStoredSession => Boolean(candidate))) {
    const previous = bySessionId.get(session.sessionId);
    if (!previous || Date.parse(session.lastUpdatedAt) > Date.parse(previous.lastUpdatedAt)) {
      bySessionId.set(session.sessionId, session);
    }
  }
  return Array.from(bySessionId.values())
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt))
    .slice(0, Math.max(1, limit));
}

export function readClaudeStoredSessionMessages(filePath: string): BridgeSessionMessage[] {
  try {
    return parseClaudeTranscript(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
}

export function ensureClaudeWorkspaceTrustAccepted(
  cwd: string,
  homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir(),
): boolean {
  const configPath = path.join(homeDir, ".claude.json");
  let config: Record<string, unknown> = {};

  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf8");
      config = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
    }
  } catch {
    return false;
  }

  if (!isRecord(config)) {
    return false;
  }

  const projectKey = normalizeClaudeProjectConfigKey(cwd);
  const projects = isRecord(config.projects) ? config.projects : {};
  const currentProject = isRecord(projects[projectKey])
    ? projects[projectKey]
    : {};
  if (currentProject.hasTrustDialogAccepted === true) {
    return false;
  }

  const nextConfig = {
    ...config,
    projects: {
      ...projects,
      [projectKey]: {
        ...currentProject,
        hasTrustDialogAccepted: true,
      },
    },
  };
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, configPath);
    return true;
  } catch {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort cleanup.
    }
    return false;
  }
}

export class ClaudeCompanionAdapter extends AbstractPtyAdapter {
  private hookServer: net.Server | null = null;
  private hookPort: number | null = null;
  private hookToken: string | null = null;
  private runtimeSessionId: string | null;
  private resumeConversationId: string | null;
  private transcriptPath: string | null;
  private pendingCliApprovalHints:
    | Pick<ApprovalRequest, "confirmInput" | "denyInput">
    | null = null;
  private pendingInjectedInputs: PendingInjectedClaudePrompt[] = [];
  private localTerminalInputListener: ((chunk: string | Buffer) => void) | null = null;
  private resizeListener: (() => void) | null = null;
  private settingsFilePath: string | null = null;
  private hookErrorLogPath: string | null = null;
  private hookReceivedCount = 0;
  private hookHealthCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingHookApprovals = new Map<string, ClaudePendingHookApproval>();
  private recoveringInvalidResume = false;
  private workingNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private workingNoticeSent = false;
  private workingNoticeDelayMs = CLAUDE_WECHAT_WORKING_NOTICE_DELAY_MS;
  private lastCompactCompletionAtMs = 0;
  private startupOutputBuffer = "";
  private hasAutoConfirmedWorkspaceTrustPrompt = false;
  private lastAutoApprovedPayload: ClaudeHookPayload | null = null;
  private transcriptPollTimer: ReturnType<typeof setInterval> | null = null;
  private transcriptTailOffset = 0;
  private polledTranscriptSessionId: string | null = null;
  private readonly storedSessionsById = new Map<string, ClaudeStoredSession>();
  private cliSessionReady = false;
  private loginRequired = false;
  private tuiReadinessBuffer = "";
  private tclaudeSessionBaseline = new Set<string>();
  private tclaudeTranscriptDiscoveryTimer: ReturnType<typeof setInterval> | null = null;
  private tclaudeTranscriptDiscoveryDeadlineMs = 0;
  private pendingStartupInput: {
    text: string;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(options: AdapterOptions) {
    super(options);
    const shouldRestoreInitialSession = options.sessionStartMode !== "new";
    this.runtimeSessionId = shouldRestoreInitialSession
      ? options.initialSharedSessionId ?? options.initialSharedThreadId ?? null
      : null;
    this.resumeConversationId = shouldRestoreInitialSession
      ? options.initialResumeConversationId ?? null
      : null;
    this.transcriptPath = shouldRestoreInitialSession
      ? options.initialTranscriptPath ?? null
      : null;
    if (this.runtimeSessionId) {
      this.state.sharedSessionId = this.runtimeSessionId;
      this.state.activeRuntimeSessionId = this.runtimeSessionId;
    }
    if (this.resumeConversationId) {
      this.state.resumeConversationId = this.resumeConversationId;
    }
    if (this.transcriptPath) {
      this.state.transcriptPath = this.transcriptPath;
    }
  }

  override async start(): Promise<void> {
    if (this.pty) {
      return;
    }

    this.startupOutputBuffer = "";
    this.tuiReadinessBuffer = "";
    this.hasAutoConfirmedWorkspaceTrustPrompt = false;
    this.cliSessionReady = false;
    this.loginRequired = false;
    this.rejectPendingStartupInput(new Error(`${claudeAdapterLabel(this.options.kind)} 正在重新启动，请稍后重试。`));
    this.clearTClaudeTranscriptDiscovery();
    if (this.options.kind === "tclaude" && !this.transcriptPath) {
      this.tclaudeSessionBaseline = new Set(
        listClaudeStoredSessions("tclaude", 100)
          .filter((session) => this.isCurrentWorkspaceSession(session))
          .map((session) => session.sessionId),
      );
    }
    ensureClaudeWorkspaceTrustAccepted(this.options.cwd);

    // Validate transcript file exists before launching Claude CLI.
    // After a compact, the old transcript is deleted and the persisted
    // resumeConversationId becomes invalid, causing --resume to crash.
    if (this.transcriptPath) {
      try {
        fs.accessSync(this.transcriptPath);
      } catch {
        this.setStatus("error");
        throw new Error(
          `无法读取原 ${claudeAdapterLabel(this.options.kind)} 任务的会话记录。请确认任务仍存在后重试；为避免会话分叉，未创建新任务。`,
        );
      }
    }

    await this.startHookServer();
    try {
      await super.start();
      if (!this.cliSessionReady && this.pty) {
        this.setStatus(
          "starting",
          `正在等待 ${claudeAdapterLabel(this.options.kind)} 准备完成。`,
        );
      }
    } catch (error) {
      await this.stopHookServer();
      throw error;
    }
  }

  override async sendInput(text: string): Promise<void> {
    if (!this.pty) {
      throw new Error(`${claudeAdapterLabel(this.options.kind)} 尚未启动，请先切换到该终端后再试。`);
    }
    if (this.state.status === "busy" || this.pendingStartupInput) {
      throw new Error(`${claudeAdapterLabel(this.options.kind)} 正在处理，请等待当前回复或发送 /stop。`);
    }
    if (this.pendingApproval) {
      throw new Error(`${claudeAdapterLabel(this.options.kind)} 正在等待审批，请先确认或拒绝。`);
    }

    const normalizedText = normalizeOutput(text).trim();
    if (this.loginRequired && normalizedText.toLowerCase() !== "/login") {
      throw new Error("Claude Code 尚未登录，请发送 /login 完成登录后再试。");
    }
    if (!this.cliSessionReady && normalizedText.toLowerCase() !== "/login") {
      await new Promise<void>((resolve, reject) => {
        this.pendingStartupInput = {
          text,
          resolve,
          reject: (error) => reject(error),
        };
      });
      return;
    }
    await this.dispatchRemoteInput(text);
  }

  private async dispatchRemoteInput(text: string): Promise<void> {
    const normalizedText = normalizeOutput(text).trim();
    this.pendingInjectedInputs.push({
      normalizedText,
      createdAtMs: Date.now(),
    });
    this.pendingInjectedInputs = this.pendingInjectedInputs.slice(-8);
    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(text);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "wechat";
    this.pendingCliApprovalHints = null;
    this.clearWechatWorkingNotice(true);
    this.setStatus("busy");
    this.startTranscriptThinkingWatch();
    this.writeToPty(this.buildRemoteInputPayload(text));
    await delay(CLAUDE_REMOTE_ENTER_DELAY_MS);
    this.writeToPty("\r");
    if (this.options.kind === "tclaude" && !this.transcriptPath) {
      this.startTClaudeTranscriptDiscovery();
    }
    this.armWechatWorkingNotice();
  }

  private markClaudeSessionReady(): void {
    this.cliSessionReady = true;
    this.loginRequired = false;
    if (this.options.kind === "tclaude") {
      this.clearHookHealthCheck();
    }
    if (this.state.status === "starting") {
      this.setStatus("idle", `${claudeAdapterLabel(this.options.kind)} 已准备完成。`);
    }
    const pending = this.pendingStartupInput;
    if (!pending) {
      return;
    }
    this.pendingStartupInput = null;
    void this.dispatchRemoteInput(pending.text).then(pending.resolve, pending.reject);
  }

  private rejectPendingStartupInput(error: Error): void {
    const pending = this.pendingStartupInput;
    if (!pending) {
      return;
    }
    this.pendingStartupInput = null;
    pending.reject(error);
  }

  private isCurrentWorkspaceSession(session: ClaudeStoredSession): boolean {
    return Boolean(session.cwd) && path.resolve(session.cwd!) === path.resolve(this.options.cwd);
  }

  private startTClaudeTranscriptDiscovery(): void {
    if (this.options.kind !== "tclaude" || this.transcriptPath) {
      return;
    }
    this.clearTClaudeTranscriptDiscovery();
    this.tclaudeTranscriptDiscoveryDeadlineMs = Date.now() + 10_000;
    const discover = () => {
      const candidates = listClaudeStoredSessions("tclaude", 100)
        .filter((session) => this.isCurrentWorkspaceSession(session));
      const candidate = candidates.find(
        (session) => !this.tclaudeSessionBaseline.has(session.sessionId),
      ) ?? candidates.find((session) => {
        const lastInputAtMs = Date.parse(this.state.lastInputAt ?? "") || 0;
        return lastInputAtMs > 0 &&
          Date.parse(session.lastUpdatedAt) >= lastInputAtMs - 2_000;
      });
      if (candidate) {
        this.runtimeSessionId = candidate.sessionId;
        this.resumeConversationId = candidate.sessionId;
        this.transcriptPath = candidate.transcriptPath;
        this.state.sharedSessionId = candidate.sessionId;
        this.state.activeRuntimeSessionId = candidate.sessionId;
        this.state.resumeConversationId = candidate.sessionId;
        this.state.transcriptPath = candidate.transcriptPath;
        this.tclaudeSessionBaseline.add(candidate.sessionId);
        this.clearTClaudeTranscriptDiscovery();
        this.startTranscriptThinkingWatch(true);
        return;
      }
      if (Date.now() >= this.tclaudeTranscriptDiscoveryDeadlineMs) {
        this.clearTClaudeTranscriptDiscovery();
      }
    };
    discover();
    if (!this.transcriptPath) {
      this.tclaudeTranscriptDiscoveryTimer = setInterval(discover, 500);
      this.tclaudeTranscriptDiscoveryTimer.unref?.();
    }
  }

  private clearTClaudeTranscriptDiscovery(): void {
    if (this.tclaudeTranscriptDiscoveryTimer) {
      clearInterval(this.tclaudeTranscriptDiscoveryTimer);
      this.tclaudeTranscriptDiscoveryTimer = null;
    }
    this.tclaudeTranscriptDiscoveryDeadlineMs = 0;
  }

  async sendInputToSession(
    sessionId: string,
    text: string,
  ): Promise<BridgeSessionSendResult> {
    if (sessionId !== this.runtimeSessionId) {
      await this.resumeSession(sessionId);
    }
    await this.sendInput(text);
    return {};
  }

  override async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    const sessions = listClaudeStoredSessions(
      this.options.kind as "claude" | "tclaude",
      limit,
    );
    for (const session of sessions) {
      this.storedSessionsById.set(session.sessionId, session);
    }
    return sessions.map(({ transcriptPath: _transcriptPath, ...session }) => ({
      ...session,
      ...(session.sessionId === this.runtimeSessionId
        ? {
            runtimeStatus: this.state.status === "busy" || this.state.status === "awaiting_approval"
              ? {
                  type: "active" as const,
                  activeFlags: this.state.status === "awaiting_approval"
                    ? ["waitingOnApproval" as const]
                    : [],
                }
              : { type: "idle" as const },
          }
        : { runtimeStatus: { type: "notLoaded" as const } }),
    }));
  }

  override async resumeSession(sessionId: string): Promise<void> {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      throw new Error("请选择要继续的任务。");
    }
    if (this.state.status === "busy" || this.state.status === "awaiting_approval") {
      throw new Error(`${claudeAdapterLabel(this.options.kind)} 正在处理，请先等待完成或停止当前任务。`);
    }
    const stored = this.findStoredSession(normalizedSessionId);
    if (!stored) {
      throw new Error(`没有找到这个 ${claudeAdapterLabel(this.options.kind)} 任务。`);
    }

    await this.dispose();
    this.runtimeSessionId = stored.sessionId;
    this.resumeConversationId = stored.sessionId;
    this.transcriptPath = stored.transcriptPath;
    this.state.sharedSessionId = stored.sessionId;
    this.state.activeRuntimeSessionId = stored.sessionId;
    this.state.resumeConversationId = stored.sessionId;
    this.state.transcriptPath = stored.transcriptPath;
    await this.start();
    const timestamp = nowIso();
    this.state.lastSessionSwitchAt = timestamp;
    this.state.lastSessionSwitchSource = "wechat";
    this.state.lastSessionSwitchReason = "wechat_resume";
    this.emit({
      type: "session_switched",
      sessionId: stored.sessionId,
      source: "wechat",
      reason: "wechat_resume",
      timestamp,
    });
  }

  async createSession(): Promise<void> {
    if (this.state.status === "busy" || this.state.status === "awaiting_approval") {
      throw new Error(`${claudeAdapterLabel(this.options.kind)} 正在处理，请先等待完成或停止当前任务。`);
    }
    await this.reset();
    for (let attempt = 0; attempt < 40 && !this.runtimeSessionId; attempt += 1) {
      await delay(100);
    }
  }

  async getLatestSessionMessage(
    sessionId: string,
  ): Promise<BridgeSessionMessage | null> {
    const messages = await this.getSessionMessages(sessionId);
    return messages.at(-1) ?? null;
  }

  async getSessionMessages(sessionId: string): Promise<BridgeSessionMessage[]> {
    const stored = this.findStoredSession(sessionId);
    return stored ? readClaudeStoredSessionMessages(stored.transcriptPath) : [];
  }

  private findStoredSession(sessionId: string): ClaudeStoredSession | null {
    const cached = this.storedSessionsById.get(sessionId);
    if (cached) return cached;
    const stored = listClaudeStoredSessions(
      this.options.kind as "claude" | "tclaude",
      2_000,
    ).find((session) => session.sessionId === sessionId) ?? null;
    if (stored) this.storedSessionsById.set(sessionId, stored);
    return stored;
  }

  override async interrupt(): Promise<boolean> {
    if (!this.pty) {
      return false;
    }
    if (this.state.status !== "busy" && this.state.status !== "awaiting_approval") {
      return false;
    }

    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.writeToPty("\u0003");
    this.scheduleTaskComplete(shared.INTERRUPT_SETTLE_DELAY_MS);
    return true;
  }

  override async reset(): Promise<void> {
    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.runtimeSessionId = null;
    this.resumeConversationId = null;
    this.transcriptPath = null;
    this.state.sharedSessionId = undefined;
    this.state.sharedThreadId = undefined;
    this.state.activeRuntimeSessionId = undefined;
    this.state.resumeConversationId = undefined;
    this.state.transcriptPath = undefined;
    this.state.lastSessionSwitchAt = undefined;
    this.state.lastSessionSwitchSource = undefined;
    this.state.lastSessionSwitchReason = undefined;
    await super.reset();
  }

  override async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    if (!this.pendingApproval) {
      return false;
    }

    if (this.pendingApproval.requestId) {
      const handled = this.respondToClaudeHookApproval(this.pendingApproval.requestId, action);
      if (handled) {
        this.clearWechatWorkingNotice();
        this.pendingCliApprovalHints = null;
        this.pendingApproval = null;
        this.state.pendingApproval = null;
        this.state.pendingApprovalOrigin = undefined;
        this.setStatus("busy");
        return true;
      }
    }

    const input =
      action === "confirm" ? this.pendingApproval.confirmInput : this.pendingApproval.denyInput;
    if (!input) {
      throw new Error(
        "Remote approval is not safely available for this Claude prompt. Approve it in the local Claude terminal.",
      );
    }

    this.clearWechatWorkingNotice();
    this.pendingCliApprovalHints = null;
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.setStatus("busy");
    this.writeToPty(input);
    return true;
  }

  override async resolveAllApprovals(action: "confirm" | "deny"): Promise<number> {
    let count = 0;
    for (const requestId of Array.from(this.pendingHookApprovals.keys())) {
      const pending = this.pendingHookApprovals.get(requestId);
      if (pending) {
        this.pendingHookApprovals.delete(requestId);
        this.respondToClaudeHook(
          pending.socket,
          requestId,
          buildClaudePermissionDecisionHookOutput(action),
        );
        count++;
      }
    }
    if (count > 0) {
      this.clearWechatWorkingNotice();
      this.pendingCliApprovalHints = null;
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      this.state.pendingApprovalOrigin = undefined;
      this.setStatus("busy");
      return count;
    }
    const ok = await this.resolveApproval(action);
    return ok ? 1 : 0;
  }

  override async dispose(): Promise<void> {
    this.rejectPendingStartupInput(new Error(`${claudeAdapterLabel(this.options.kind)} 已关闭，消息未发送。`));
    this.cliSessionReady = false;
    this.clearTClaudeTranscriptDiscovery();
    this.detachLocalTerminal();
    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.stopTranscriptThinkingWatch();
    await super.dispose();
    await this.stopHookServer();
  }

  protected buildSpawnArgs(): string[] {
    if (!this.settingsFilePath) {
      throw new Error("Claude companion settings are not ready.");
    }

    return buildClaudeCliArgs({
      settingsFilePath: this.settingsFilePath,
      resumeConversationId: this.resumeConversationId,
      profile: this.options.profile,
      includeNoAltScreen: shouldIncludeClaudeNoAltScreen(this.options.command),
      extraCliArgs: this.options.extraCliArgs,
    });
  }

  protected override afterStart(): void {
    this.attachLocalTerminal();
    this.resizePtyToTerminal();
    this.startHookHealthCheck();
    if (!this.cliSessionReady) {
      this.setStatus(
        "starting",
        `正在等待 ${claudeAdapterLabel(this.options.kind)} 准备完成。`,
      );
    }
  }

  protected override shouldMarkReadyAfterStart(): boolean {
    return false;
  }

  protected override handleData(rawText: string): void {
    this.renderLocalOutput(rawText);

    const text = normalizeOutput(rawText);
    if (!text) {
      return;
    }

    if (this.options.kind === "tclaude" && !this.cliSessionReady && !this.hasAcceptedInput) {
      this.tuiReadinessBuffer = `${this.tuiReadinessBuffer}${text}`.slice(
        -CLAUDE_TUI_READY_BUFFER_LIMIT,
      );
      if (isClaudeInteractivePromptReady(this.tuiReadinessBuffer)) {
        this.markClaudeSessionReady();
      }
    }

    if (
      this.resumeConversationId &&
      !this.hasAcceptedInput &&
      !this.recoveringInvalidResume &&
      isClaudeInvalidResumeError(text)
    ) {
      this.failInvalidResume(this.resumeConversationId);
      return;
    }

    this.state.lastOutputAt = nowIso();
    if (this.maybeAutoConfirmWorkspaceTrustPrompt(text)) {
      return;
    }

    if (this.shouldTreatClaudeOutputAsCompactCompletion(text)) {
      this.completeClaudeCompact();
      return;
    }
    const compactFailure = this.extractClaudeCompactFailure(text);
    if (compactFailure) {
      this.failClaudeTurn(compactFailure);
      return;
    }

    if (CLAUDE_LOGIN_REQUIRED_RE.test(text)) {
      this.loginRequired = true;
      const message = `${claudeAdapterLabel(this.options.kind)} 尚未登录，请发送 /login 完成登录后再试。`;
      this.rejectPendingStartupInput(new Error(message));
      if (this.hasAcceptedInput) {
        this.failClaudeTurn(message);
      } else {
        this.setStatus("idle", message);
      }
      return;
    }

    const approval = detectCliApproval(text);
    if (approval) {
      this.clearWechatWorkingNotice();
      if (this.pendingApproval) {
        this.pendingApproval = {
          ...this.pendingApproval,
          confirmInput: this.pendingApproval.confirmInput ?? approval.confirmInput,
          denyInput: this.pendingApproval.denyInput ?? approval.denyInput,
        };
        this.state.pendingApproval = this.pendingApproval;
      } else {
        this.pendingCliApprovalHints = {
          confirmInput: approval.confirmInput,
          denyInput: approval.denyInput,
        };
      }
      return;
    }

    if (!this.hasAcceptedInput) {
      return;
    }
  }

  private maybeAutoConfirmWorkspaceTrustPrompt(text: string): boolean {
    if (this.hasAcceptedInput || this.hasAutoConfirmedWorkspaceTrustPrompt) {
      return false;
    }

    this.startupOutputBuffer = `${this.startupOutputBuffer}${text}`.slice(
      -CLAUDE_STARTUP_OUTPUT_BUFFER_LIMIT,
    );
    if (!isClaudeWorkspaceTrustPrompt(this.startupOutputBuffer)) {
      return false;
    }

    this.hasAutoConfirmedWorkspaceTrustPrompt = true;
    this.writeToPty("\r");
    return true;
  }

  protected override handleExit(exitCode: number | undefined): void {
    const cleanExternalExit = !this.shuttingDown && exitCode === 0;
    this.detachLocalTerminal();
    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.cliSessionReady = false;
    this.clearTClaudeTranscriptDiscovery();
    this.rejectPendingStartupInput(
      new Error(
        this.loginRequired
          ? "Claude Code 尚未登录，请发送 /login 完成登录后再试。"
          : `${claudeAdapterLabel(this.options.kind)} 已关闭，消息未发送。`,
      ),
    );
    void this.stopHookServer();
    if (this.recoveringInvalidResume && !this.shuttingDown) {
      this.clearCompletionTimer();
      this.recoveringInvalidResume = false;
      this.pty = null;
      this.state.status = "error";
      this.state.pid = undefined;
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      return;
    }
    if (cleanExternalExit && !this.loginRequired) {
      const label = claudeAdapterLabel(this.options.kind);
      this.emitClaudeNotice(
        `${label} 已关闭。\n发送“/${this.options.kind}”可重新打开。`,
        "warning",
      );
    }
    super.handleExit(exitCode);
  }

  protected override shouldTreatWorkerExitAsExpected(
    exitCode: number | undefined,
  ): boolean {
    return exitCode === 0;
  }

  private async startHookServer(): Promise<void> {
    if (this.hookServer) {
      return;
    }

    this.hookToken = buildLocalCompanionToken();
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => {
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
          buffer += chunk;
          // Cap the buffer: a single hook frame is tiny, so a frame larger
          // than 1 MiB means a misbehaving client (e.g. one that never sends a
          // newline). Without this the buffer could grow unbounded. Sibling
          // IPC paths already cap their buffers; this one did not.
          if (buffer.length > 1024 * 1024) {
            socket.destroy();
            return;
          }
          while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex < 0) {
              break;
            }

            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line) {
              continue;
            }

            try {
              const envelope = JSON.parse(line) as {
                token?: string;
                requestId?: string;
                payload?: string;
              };
              if (
                envelope.token === this.hookToken &&
                typeof envelope.requestId === "string" &&
                typeof envelope.payload === "string"
              ) {
                this.handleClaudeHookEnvelope({
                  requestId: envelope.requestId,
                  rawPayload: envelope.payload,
                  socket,
                });
              }
            } catch {
              // Ignore malformed hook payloads.
            }
          }
        });
        const cleanupPendingRequestsForSocket = () => {
          for (const [requestId, pending] of this.pendingHookApprovals.entries()) {
            if (pending.socket === socket) {
              this.pendingHookApprovals.delete(requestId);
              this.handleClosedClaudeHookApproval(requestId);
            }
          }
        };
        socket.once("close", cleanupPendingRequestsForSocket);
        socket.once("error", cleanupPendingRequestsForSocket);
      });

      this.hookServer = server;
      server.once("error", (error) => {
        reject(error);
      });
      server.listen(0, CLAUDE_HOOK_LISTEN_HOST, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Failed to allocate a local Claude hook port."));
          return;
        }

        this.hookPort = address.port;
        try {
          this.writeClaudeRuntimeFiles();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private async stopHookServer(): Promise<void> {
    this.clearHookHealthCheck();
    this.flushPendingClaudeHookApprovals();
    if (!this.hookServer) {
      this.hookPort = null;
      this.settingsFilePath = null;
      return;
    }

    const server = this.hookServer;
    this.hookServer = null;
    this.hookPort = null;
    this.settingsFilePath = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private writeClaudeRuntimeFiles(): void {
    if (!this.hookPort || !this.hookToken) {
      throw new Error("Claude hook server is not ready.");
    }

    const { workspaceDir } = ensureWorkspaceChannelDir(this.options.cwd);
    const runtimeDir = path.join(
      workspaceDir,
      resolveClaudeRuntimeDirectoryName(this.options.kind as "claude" | "tclaude"),
    );
    ensurePrivateDir(runtimeDir);

    const hookScriptPath = path.join(
      runtimeDir,
      process.platform === "win32" ? "hook.cmd" : "hook.sh",
    );
    const settingsFilePath = path.join(runtimeDir, "settings.json");
    const sourceHookEntryPath = path.join(MODULE_DIR, "claude-hook.ts");
    const hookEntryPath = fs.existsSync(sourceHookEntryPath)
      ? sourceHookEntryPath
      : path.join(MODULE_DIR, "claude-hook.js");

    const hookErrorLogPath = path.join(runtimeDir, "hook-error.log");
    this.hookErrorLogPath = hookErrorLogPath;

    writePrivateFileAtomic(
      hookScriptPath,
      buildClaudeHookScript({
        platform: process.platform,
        runtimeExecPath: process.execPath,
        hookEntryPath,
        hookPort: this.hookPort,
        hookToken: this.hookToken,
        hookErrorLogPath,
      }),
      { encoding: "utf8" },
    );
    if (process.platform !== "win32") {
      fs.chmodSync(hookScriptPath, 0o700);
    }

    const hookCommand =
      process.platform === "win32"
        ? quoteWindowsCommandArg(hookScriptPath)
        : quotePosixCommandArg(hookScriptPath);
    writePrivateFileAtomic(
      settingsFilePath,
      JSON.stringify(buildClaudeHookSettings(hookCommand), null, 2),
      { encoding: "utf8" },
    );
    this.settingsFilePath = settingsFilePath;
  }

  private attachLocalTerminal(): void {
    if (this.localTerminalInputListener || !this.pty) {
      return;
    }

    this.localTerminalInputListener = (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.writeToPty(text);
    };
    process.stdin.on("data", this.localTerminalInputListener);
    process.stdin.resume();
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true);
    }

    this.resizeListener = () => {
      this.resizePtyToTerminal();
    };
    if (process.stdout.isTTY) {
      process.stdout.on("resize", this.resizeListener);
    }
  }

  private detachLocalTerminal(): void {
    if (this.localTerminalInputListener) {
      process.stdin.off("data", this.localTerminalInputListener);
      this.localTerminalInputListener = null;
    }
    if (this.resizeListener) {
      process.stdout.off("resize", this.resizeListener);
      this.resizeListener = null;
    }
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  }

  private resizePtyToTerminal(): void {
    if (!this.pty || !process.stdout.isTTY) {
      return;
    }

    try {
      this.pty.resize?.(process.stdout.columns || DEFAULT_COLS, process.stdout.rows || DEFAULT_ROWS);
    } catch {
      // Best effort resize sync.
    }
  }

  private renderLocalOutput(rawText: string): void {
    try {
      process.stdout.write(rawText);
    } catch {
      // Best effort local mirroring for the visible Claude companion.
    }
  }

  private armWechatWorkingNotice(): void {
    this.clearWechatWorkingNotice();
    if (
      this.workingNoticeSent ||
      !this.hasAcceptedInput ||
      this.state.status !== "busy" ||
      this.pendingApproval ||
      this.state.activeTurnOrigin !== "wechat"
    ) {
      return;
    }

    this.workingNoticeTimer = setTimeout(() => {
      this.workingNoticeTimer = null;
      if (
        this.workingNoticeSent ||
        !this.hasAcceptedInput ||
        this.state.status !== "busy" ||
        this.pendingApproval ||
        this.state.activeTurnOrigin !== "wechat"
      ) {
        return;
      }

      this.workingNoticeSent = true;
      this.emitClaudeNotice(`${claudeAdapterLabel(this.options.kind)} 正在处理：\n${this.currentPreview}`);
    }, this.workingNoticeDelayMs);
    this.workingNoticeTimer.unref?.();
  }

  private clearWechatWorkingNotice(resetSent = false): void {
    if (this.workingNoticeTimer) {
      clearTimeout(this.workingNoticeTimer);
      this.workingNoticeTimer = null;
    }
    if (resetSent) {
      this.workingNoticeSent = false;
    }
  }

  private startHookHealthCheck(): void {
    this.hookReceivedCount = 0;
    this.clearHookHealthCheck();
    this.hookHealthCheckTimer = setTimeout(() => {
      this.hookHealthCheckTimer = null;
      this.handleClaudeHookHealthCheckTimeout();
    }, 15_000);
    this.hookHealthCheckTimer.unref?.();
  }

  private handleClaudeHookHealthCheckTimeout(): void {
    if (this.hookReceivedCount !== 0 || this.shuttingDown) {
      return;
    }
    if (this.options.kind === "tclaude" && this.cliSessionReady) {
      return;
    }
    const message = `${claudeAdapterLabel(this.options.kind)} 启动后没有建立消息通道，请重新发送 /${this.options.kind}；如果仍失败，请在电脑端查看启动错误。`;
    if (this.pendingStartupInput) {
      this.rejectPendingStartupInput(new Error(message));
      this.setStatus("error", message);
    }
    const logHint = this.hookErrorLogPath
      ? t("hook.healthCheck.logHint", { logPath: this.hookErrorLogPath })
      : "";
    this.emit({
      type: "stdout",
      text: [
        message,
        logHint,
        t("hook.healthCheck.fixes"),
      ].filter(Boolean).join("\n"),
      timestamp: nowIso(),
    });
  }

  private clearHookHealthCheck(): void {
    if (this.hookHealthCheckTimer) {
      clearTimeout(this.hookHealthCheckTimer);
      this.hookHealthCheckTimer = null;
    }
  }

  private emitClaudeNotice(text: string, level: BridgeNoticeLevel = "info"): void {
    const normalized = normalizeOutput(text).trim();
    if (!normalized) {
      return;
    }

    this.state.lastOutputAt = nowIso();
    this.emit({
      type: "notice",
      text: normalized,
      level,
      timestamp: nowIso(),
    });
  }

  private buildRemoteInputPayload(text: string): string {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalizedText.includes("\n")) {
      return normalizedText;
    }

    return `${CLAUDE_BRACKETED_PASTE_START}${normalizedText}${CLAUDE_BRACKETED_PASTE_END}`;
  }

  // Fallback heuristic for older Claude Code versions that lack PostCompact hooks.
  // The structured PostCompact hook event (handled in handleClaudeHookEnvelope) is
  // the reliable signal; this regex match serves as a best-effort fallback.
  private shouldTreatClaudeOutputAsCompactCompletion(text: string): boolean {
    if (
      this.state.status !== "busy" &&
      this.state.status !== "awaiting_approval" &&
      !this.hasAcceptedInput
    ) {
      return false;
    }

    return normalizeOutput(text)
      .split("\n")
      .some((line) => CLAUDE_COMPACT_OUTPUT_LINE_RE.test(line.trim()));
  }

  private isCompactCommandActive(): boolean {
    const preview = normalizeOutput(this.currentPreview).trim().toLowerCase();
    return preview === "/compact" || preview.startsWith("/compact ");
  }

  private extractClaudeCompactFailure(text: string): string | null {
    if (!this.isCompactCommandActive()) {
      return null;
    }

    const matchedLine = normalizeOutput(text)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .find((line) => CLAUDE_COMPACT_FAILURE_RE.test(line));
    if (!matchedLine) {
      return null;
    }

    const detail = matchedLine
      .replace(/^Error:\s*Error during compaction:\s*/i, "")
      .replace(/^Error:\s*/i, "")
      .replace(/^(?:compact|compaction)\s+failed:\s*/i, "")
      .trim();
    return truncatePreview(
      `Compact failed: ${detail || "Claude reported an unknown compaction error."}`,
      500,
    );
  }

  private failClaudeTurn(message: string): void {
    const hasActiveTurn =
      this.state.status === "busy" ||
      this.state.status === "awaiting_approval" ||
      this.hasAcceptedInput ||
      this.pendingApproval !== null ||
      this.state.activeTurnOrigin !== undefined ||
      this.currentPreview !== "(idle)";
    if (!hasActiveTurn) {
      return;
    }

    this.clearCompletionTimer();
    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.state.activeTurnOrigin = undefined;
    this.hasAcceptedInput = false;
    this.setStatus("idle");
    this.emit({
      type: "task_failed",
      message,
      timestamp: nowIso(),
    });
    this.currentPreview = "(idle)";
  }

  private completeClaudeCompact(params?: {
    nextResumeConversationId?: string | null;
  }): void {
    const compactedAtMs = Date.now();
    const shouldEmitNotice =
      compactedAtMs - this.lastCompactCompletionAtMs > CLAUDE_COMPACT_DEDUP_MS;
    this.lastCompactCompletionAtMs = compactedAtMs;

    if (shouldEmitNotice) {
      const previousResumeConversationId = this.resumeConversationId;
      const nextResumeConversationId =
        params?.nextResumeConversationId ?? previousResumeConversationId;
      const detail =
        previousResumeConversationId &&
        nextResumeConversationId &&
        previousResumeConversationId !== nextResumeConversationId
          ? ` Old ID: ${previousResumeConversationId} → New ID: ${nextResumeConversationId}.`
          : "";
      this.emitClaudeNotice(
        `Conversation was compacted.${detail} Bridge is ready for new WeChat messages.`,
        "info",
      );
    }

    const shouldEmitTaskComplete =
      this.state.status === "busy" ||
      this.state.status === "awaiting_approval" ||
      this.hasAcceptedInput;
    const completedPreview = this.currentPreview;
    this.clearCompletionTimer();
    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.state.activeTurnOrigin = undefined;
    this.hasAcceptedInput = false;
    this.setStatus("idle");
    if (shouldEmitTaskComplete) {
      this.emit({
        type: "task_complete",
        summary: completedPreview,
        timestamp: nowIso(),
      });
    }
    this.currentPreview = "(idle)";
  }

  private handleClaudeHookEnvelope(params: {
    requestId: string;
    rawPayload: string;
    socket: net.Socket;
  }): void {
    this.hookReceivedCount++;
    this.clearHookHealthCheck();
    const payload = parseClaudeHookPayload(params.rawPayload);
    if (!payload?.hook_event_name) {
      this.respondToClaudeHook(params.socket, params.requestId);
      return;
    }

    switch (payload.hook_event_name) {
      case "SessionStart":
        this.handleClaudeSessionStart(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "UserPromptSubmit":
        this.handleClaudeUserPromptSubmit(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "PermissionRequest":
        this.handleClaudePermissionRequest(params.requestId, payload, params.socket);
        return;
      case "Notification":
        if (payload.notification_type === "permission_prompt") {
          if (this.pendingApproval) {
            this.setStatus("awaiting_approval", "Claude approval is required.");
          } else if (this.lastAutoApprovedPayload) {
            // Auto-approval response failed to reach Claude Code (socket closed before delivery).
            // Fall back to forwarding the approval request to WeChat.
            const fallbackPayload = this.lastAutoApprovedPayload;
            this.lastAutoApprovedPayload = null;
            const request = buildClaudePermissionApprovalRequest(fallbackPayload);
            this.pendingApproval = {
              ...request,
              requestId: undefined,
              confirmInput: this.pendingCliApprovalHints?.confirmInput,
              denyInput: this.pendingCliApprovalHints?.denyInput,
            };
            this.pendingCliApprovalHints = null;
            this.state.pendingApproval = this.pendingApproval;
            this.state.pendingApprovalOrigin = this.state.activeTurnOrigin;
            this.setStatus("awaiting_approval", "Claude auto-approval failed, forwarding to WeChat.");
            this.emit({
              type: "approval_required",
              request: this.pendingApproval,
              timestamp: nowIso(),
            });
          }
        }
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "Stop":
        this.handleClaudeStop(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "StopFailure":
        this.handleClaudeStopFailure(payload);
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      case "PostCompact":
        this.completeClaudeCompact();
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
      default:
        this.respondToClaudeHook(params.socket, params.requestId);
        return;
    }
  }

  private handleClaudeSessionStart(payload: {
    session_id?: string;
    source?: string;
    transcript_path?: string;
  }): void {
    if (!payload.session_id) {
      return;
    }

    const previousRuntimeSessionId = this.runtimeSessionId;
    const previousResumeConversationId = this.resumeConversationId;
    const nextTranscriptPath =
      typeof payload.transcript_path === "string" && payload.transcript_path.trim()
        ? payload.transcript_path.trim()
        : null;
    const nextResumeConversationId = extractClaudeResumeConversationId(
      nextTranscriptPath ?? undefined,
    );

    const compactedByTranscriptRotation =
      Boolean(this.transcriptPath) &&
      Boolean(nextTranscriptPath) &&
      this.transcriptPath !== nextTranscriptPath &&
      (this.state.status === "busy" ||
        this.state.status === "awaiting_approval" ||
        this.hasAcceptedInput);

    // Compact may keep the same runtime session id, so rely on the structured
    // source when available and fall back to transcript rotation while a turn is active.
    if (
      payload.source === "compact" ||
      compactedByTranscriptRotation
    ) {
      this.completeClaudeCompact({
        nextResumeConversationId,
      });
    }

    this.runtimeSessionId = payload.session_id;
    this.state.sharedSessionId = payload.session_id;
    this.state.activeRuntimeSessionId = payload.session_id;
    this.state.sharedThreadId = undefined;
    this.resumeConversationId = nextResumeConversationId;
    this.state.resumeConversationId = nextResumeConversationId ?? undefined;
    this.transcriptPath = nextTranscriptPath;
    this.state.transcriptPath = nextTranscriptPath ?? undefined;
    this.startTranscriptThinkingWatch();
    this.markClaudeSessionReady();

    if (previousRuntimeSessionId === payload.session_id) {
      return;
    }

    const timestamp = nowIso();
    const isRestore =
      !previousRuntimeSessionId &&
      (payload.source === "resume" ||
        (nextResumeConversationId !== null &&
          nextResumeConversationId === previousResumeConversationId));
    const source: BridgeThreadSwitchSource = isRestore ? "restore" : "local";
    const reason: BridgeThreadSwitchReason = isRestore ? "startup_restore" : "local_follow";
    this.state.lastSessionSwitchAt = timestamp;
    this.state.lastSessionSwitchSource = source;
    this.state.lastSessionSwitchReason = reason;
    this.emit({
      type: "session_switched",
      sessionId: payload.session_id,
      source,
      reason,
      timestamp,
    });
  }

  private handleClaudeUserPromptSubmit(payload: { prompt?: string }): void {
    const prompt =
      typeof payload.prompt === "string" ? normalizeOutput(payload.prompt).trim() : "";
    if (!prompt) {
      return;
    }

    const injectedIndex = findInjectedClaudePromptIndex(prompt, this.pendingInjectedInputs);
    if (injectedIndex >= 0) {
      this.pendingInjectedInputs.splice(injectedIndex, 1);
      return;
    }

    this.hasAcceptedInput = true;
    this.currentPreview = truncatePreview(prompt);
    this.state.lastInputAt = nowIso();
    this.state.activeTurnOrigin = "local";
    this.pendingCliApprovalHints = null;
    this.clearWechatWorkingNotice(true);
    this.setStatus("busy");
    this.startTranscriptThinkingWatch();
    this.emit({
      type: "mirrored_user_input",
      text: prompt,
      origin: "local",
      timestamp: nowIso(),
    });
  }

  private failInvalidResume(failedResumeConversationId: string): void {
    if (this.recoveringInvalidResume) {
      return;
    }

    this.recoveringInvalidResume = true;
    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.flushPendingClaudeHookApprovals();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.setStatus("error");
    this.emit({
      type: "fatal_error",
      message: `原 ${claudeAdapterLabel(this.options.kind)} 任务 ${failedResumeConversationId} 已不可用。请在电脑端确认任务状态后重试；为避免会话分叉，未创建新任务。`,
      timestamp: nowIso(),
    });
  }

  private handleClaudePermissionRequest(
    requestId: string,
    payload: ClaudeHookPayload,
    socket: net.Socket,
  ): void {
    this.clearWechatWorkingNotice();
    this.lastAutoApprovedPayload = null;
    const denyMessage = getClaudeWechatOutboundAttachmentDenyMessage(payload);
    if (denyMessage) {
      this.pendingApproval = null;
      this.state.pendingApproval = null;
      this.state.pendingApprovalOrigin = undefined;
      if (this.state.status === "awaiting_approval") {
        this.setStatus("busy");
      }
      this.respondToClaudeHook(
        socket,
        requestId,
        buildClaudePermissionDecisionHookOutput("deny", denyMessage),
      );
      return;
    }

    const autoResponse = getClaudePermissionAutoResponse(payload);
    if (autoResponse) {
      if (!this.pendingApproval && !this.state.pendingApproval) {
        this.setStatus(
          "busy",
          `Claude approval auto-approved: ${truncatePreview(autoResponse.reason, 180)}`,
        );
      }
      this.lastAutoApprovedPayload = payload;
      this.respondToClaudeHook(
        socket,
        requestId,
        buildClaudePermissionDecisionHookOutput(autoResponse.action),
      );
      return;
    }

    this.flushPendingClaudeHookApprovals();
    this.pendingHookApprovals.set(requestId, {
      requestId,
      socket,
    });
    const request = buildClaudePermissionApprovalRequest(payload);
    this.pendingApproval = {
      ...request,
      requestId,
      confirmInput:
        this.pendingApproval?.confirmInput ?? this.pendingCliApprovalHints?.confirmInput,
      denyInput: this.pendingApproval?.denyInput ?? this.pendingCliApprovalHints?.denyInput,
    };
    this.pendingCliApprovalHints = null;
    this.state.pendingApproval = this.pendingApproval;
    this.state.pendingApprovalOrigin = this.state.activeTurnOrigin;
    this.setStatus("awaiting_approval", "Claude approval is required.");
    this.emit({
      type: "approval_required",
      request: this.pendingApproval,
      timestamp: nowIso(),
    });
  }

  private handleClosedClaudeHookApproval(requestId: string): void {
    if (this.pendingApproval?.requestId !== requestId) {
      return;
    }

    if (this.pendingApproval.confirmInput || this.pendingApproval.denyInput) {
      this.pendingApproval = {
        ...this.pendingApproval,
        requestId: undefined,
      };
      this.state.pendingApproval = this.pendingApproval;
      return;
    }

    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    if (this.state.status === "awaiting_approval") {
      this.setStatus("awaiting_approval", "Claude approval must be resolved in the local terminal.");
    }
    this.emitClaudeNotice(
      "Claude approval can no longer be resolved from WeChat. Approve it in the local Claude terminal.",
      "warning",
    );
  }

  private readClaudeTranscriptFinalReply(): string | null {
    if (!this.transcriptPath) {
      return null;
    }

    try {
      const rawTranscript = fs.readFileSync(this.transcriptPath, "utf8");
      return extractClaudeTranscriptFinalReply(rawTranscript);
    } catch {
      return null;
    }
  }

  private resolveClaudeFinalReplyText(payload: { last_assistant_message?: string }): string {
    return (
      extractClaudeAssistantMessageText(payload) ||
      this.readClaudeTranscriptFinalReply() ||
      normalizeClaudeAssistantMessage(payload)
    );
  }

  private handleClaudeStop(payload: { last_assistant_message?: string }): void {
    this.clearWechatWorkingNotice(true);
    this.pendingCliApprovalHints = null;
    this.lastAutoApprovedPayload = null;
    this.flushPendingClaudeHookApprovals();
    this.pendingApproval = null;
    this.state.pendingApproval = null;
    this.state.pendingApprovalOrigin = undefined;
    this.state.activeTurnOrigin = undefined;
    this.hasAcceptedInput = false;
    this.setStatus("idle");
    this.emit({
      type: "final_reply",
      text: this.resolveClaudeFinalReplyText(payload),
      timestamp: nowIso(),
    });
    this.emit({
      type: "task_complete",
      summary: this.currentPreview,
      timestamp: nowIso(),
    });
    this.stopTranscriptThinkingWatch();
    this.currentPreview = "(idle)";
  }

  private handleClaudeStopFailure(payload: {
    error?: string;
    error_details?: string;
    last_assistant_message?: string;
  }): void {
    this.lastAutoApprovedPayload = null;
    this.stopTranscriptThinkingWatch();
    this.failClaudeTurn(buildClaudeFailureMessage(payload));
  }

  private startTranscriptThinkingWatch(fromStart = false): void {
    this.stopTranscriptThinkingWatch();
    if (!this.transcriptPath) {
      return;
    }
    const forwardThinking = isThinkingForwardEnabled();
    if (!forwardThinking && this.options.kind !== "tclaude") {
      return;
    }

    this.transcriptTailOffset = 0;
    try {
      const stat = fs.statSync(this.transcriptPath);
      this.transcriptTailOffset = fromStart ? 0 : stat.size;
    } catch {
      return;
    }

    const watchPath = this.transcriptPath;
    const sessionId = this.runtimeSessionId;
    this.polledTranscriptSessionId = sessionId;

    this.transcriptPollTimer = setInterval(() => {
      if (this.shuttingDown) {
        this.stopTranscriptThinkingWatch();
        return;
      }
      if (this.polledTranscriptSessionId !== this.runtimeSessionId) {
        this.stopTranscriptThinkingWatch();
        return;
      }

      try {
        const stat = fs.statSync(watchPath);
        if (stat.size <= this.transcriptTailOffset) {
          return;
        }

        const fd = fs.openSync(watchPath, "r");
        const buf = Buffer.alloc(stat.size - this.transcriptTailOffset);
        fs.readSync(fd, buf, 0, buf.length, this.transcriptTailOffset);
        fs.closeSync(fd);
        this.transcriptTailOffset = stat.size;

        const newText = buf.toString("utf8");
        const lines = newText.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          let parsed: any;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          if (
            !parsed ||
            parsed.type !== "assistant" ||
            !Array.isArray(parsed.message?.content)
          ) {
            continue;
          }

          this.handleTClaudeTranscriptAssistant(parsed);

          for (const block of parsed.message.content) {
            if (
              forwardThinking &&
              block.type === "thinking" &&
              typeof block.thinking === "string" &&
              block.thinking.trim()
            ) {
              const thinking = normalizeOutput(block.thinking).trim();
              if (thinking) {
                this.emit({
                  type: "thinking",
                  text: thinking,
                  timestamp: nowIso(),
                });
              }
            }
          }
        }
      } catch {
        // File may be temporarily locked or deleted; silently retry next poll.
      }
    }, 800);
    this.transcriptPollTimer.unref?.();
  }

  private handleTClaudeTranscriptAssistant(parsed: {
    message?: {
      stop_reason?: string | null;
      content?: Array<{ type?: string; text?: string }>;
    };
  }): void {
    if (
      this.options.kind !== "tclaude" ||
      !this.hasAcceptedInput ||
      this.state.status !== "busy" ||
      parsed.message?.stop_reason !== "end_turn" ||
      !Array.isArray(parsed.message.content)
    ) {
      return;
    }
    const finalText = normalizeOutput(
      parsed.message.content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n"),
    ).trim();
    if (!finalText) {
      return;
    }
    this.handleClaudeStop({ last_assistant_message: finalText });
  }

  private stopTranscriptThinkingWatch(): void {
    if (this.transcriptPollTimer) {
      clearInterval(this.transcriptPollTimer);
      this.transcriptPollTimer = null;
    }
    this.transcriptTailOffset = 0;
    this.polledTranscriptSessionId = null;
  }

  private respondToClaudeHook(
    socket: net.Socket,
    requestId: string,
    stdout?: string,
  ): void {
    try {
      socket.end(`${JSON.stringify({ requestId, stdout })}\n`);
    } catch {
      try {
        socket.destroy();
      } catch {
        // Best effort cleanup.
      }
    }
  }

  private respondToClaudeHookApproval(
    requestId: string,
    action: "confirm" | "deny",
  ): boolean {
    const pending = this.pendingHookApprovals.get(requestId);
    if (!pending) {
      return false;
    }

    this.pendingHookApprovals.delete(requestId);
    this.respondToClaudeHook(
      pending.socket,
      requestId,
      buildClaudePermissionDecisionHookOutput(action),
    );
    return true;
  }

  private cancelPendingClaudeHookApproval(requestId: string): void {
    const pending = this.pendingHookApprovals.get(requestId);
    if (!pending) {
      return;
    }

    this.respondToClaudeHook(pending.socket, requestId);
    this.pendingHookApprovals.delete(requestId);
  }

  private flushPendingClaudeHookApprovals(): void {
    for (const requestId of Array.from(this.pendingHookApprovals.keys())) {
      this.cancelPendingClaudeHookApproval(requestId);
    }
  }
}

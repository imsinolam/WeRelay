import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
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
  BridgeMessageImage,
  BridgeResumeSessionCandidate,
  BridgeResumeSessionRuntimeStatus,
  BridgeSessionMessage,
} from "./bridge-types.ts";
import {
  enrichBridgeSessionMessageImages,
  mergeBridgeMessageImages,
} from "./bridge-message-images.ts";
import {
  AcpBridgeAdapter,
  normalizeAcpSessionCandidates,
} from "./bridge-adapters.acp.ts";
import {
  describeUnknownError,
  isRecord,
} from "./bridge-adapter-common.ts";
import { killProcessTreeSync } from "./bridge-process-reaper.ts";
import { nowIso } from "./bridge-utils.ts";

const GROK_LEADER_READY_TIMEOUT_MS = 10_000;
const GROK_LEADER_POLL_INTERVAL_MS = 100;
const GROK_EXISTING_LEADER_READY_TIMEOUT_MS = 3_000;
const GROK_LEADER_EXIT_TIMEOUT_MS = 4_000;
const GROK_PROCESS_PROBE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const GROK_EVENT_TAIL_MAX_BYTES = 1024 * 1024;
const GROK_LIVE_EVENT_CACHE_TTL_MS = 2_000;

const grokLiveEventPathCache = new Map<string, {
  expiresAtMs: number;
  paths: Set<string>;
}>();

type GrokLeaderSocketOptions = {
  platform?: NodeJS.Platform;
  uid?: number;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function grokHomeDirectory(): string {
  return process.env.GROK_HOME?.trim() || path.join(os.homedir(), ".grok");
}

function grokSessionDirectory(cwd: string, sessionId: string): string {
  return path.join(grokHomeDirectory(), "sessions", encodeURIComponent(cwd), sessionId);
}

export function resolveGrokLeaderSocket(
  cwd: string,
  options: GrokLeaderSocketOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
  const workspaceHash = crypto.createHash("sha256")
    .update(path.resolve(cwd))
    .digest("hex")
    .slice(0, 16);
  if (platform === "win32") {
    return `\\\\.\\pipe\\werelay-grok-${uid}-${workspaceHash}`;
  }
  return `/tmp/werelay-grok-${uid}-${workspaceHash}.sock`;
}

export function buildGrokAcpArgs(
  options: AdapterOptions,
  leaderSocket: string,
): string[] {
  return [
    "agent",
    "--leader",
    "--leader-socket",
    leaderSocket,
    ...(options.profile ? ["--agent-profile", options.profile] : []),
    "stdio",
  ];
}

export function buildGrokNativeArgs(
  options: AdapterOptions,
  leaderSocket: string,
  sessionId?: string,
): string[] {
  return [
    "--leader-socket",
    leaderSocket,
    ...(sessionId ? ["--resume", sessionId] : []),
    ...(options.extraCliArgs ?? []),
  ];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function canConnectToLeader(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    const settle = (connected: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(250, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function tokenizeProcessCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of commandLine.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens.filter(Boolean);
}

function commandBasename(command: string): string {
  return command.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
}

export function isGrokLeaderCommandLine(commandLine: string): boolean {
  const tokens = tokenizeProcessCommandLine(commandLine);
  return tokens.some((token, index) => {
    const executable = commandBasename(token);
    return (
      (executable === "grok" || executable === "grok.exe") &&
      tokens[index + 1]?.toLowerCase() === "agent" &&
      tokens[index + 2]?.toLowerCase() === "leader"
    );
  });
}

export function parseGrokLeaderSocketOwnerPids(
  lsofOutput: string,
  socketPath: string,
): number[] {
  const owners = new Set<number>();
  let currentPid: number | null = null;
  for (const line of lsofOutput.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      const pid = Number.parseInt(line.slice(1), 10);
      currentPid = Number.isInteger(pid) && pid > 0 ? pid : null;
      continue;
    }
    if (currentPid !== null && line === `n${socketPath}`) {
      owners.add(currentPid);
    }
  }
  return [...owners];
}

export function selectGrokLeaderSocketOwnerPids(
  socketPath: string,
  lsofOutput: string,
  commandLines: ReadonlyMap<number, string>,
): number[] {
  return parseGrokLeaderSocketOwnerPids(lsofOutput, socketPath)
    .filter((pid) => pid !== process.pid)
    .filter((pid) => isGrokLeaderCommandLine(commandLines.get(pid) ?? ""));
}

type GrokLeaderOwnerProbe = {
  available: boolean;
  socketPids: number[];
  pids: number[];
  detail?: string;
};

function readProcessCommandLine(pid: number): string {
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2_000,
    });
    return result.status === 0 ? (result.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}

function readProcessCwd(pid: number): string | null {
  try {
    const result = spawnSync(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 2_000,
      },
    );
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      return null;
    }
    for (const line of (result.stdout ?? "").split(/\r?\n/)) {
      if (line.startsWith("n") && line.length > 1) {
        return line.slice(1);
      }
    }
  } catch {
    // Process inspection is best effort.
  }
  return null;
}

function probeGrokLeaderSocketOwners(socketPath: string): GrokLeaderOwnerProbe {
  if (process.platform === "win32") {
    return {
      available: false,
      socketPids: [],
      pids: [],
      detail: "Windows 不支持 lsof socket owner 探测",
    };
  }
  try {
    const result = spawnSync("lsof", ["-n", "-U", "-Fpn"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: GROK_PROCESS_PROBE_MAX_BUFFER_BYTES,
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      return {
        available: false,
        socketPids: [],
        pids: [],
        detail: result.error?.message || (result.stderr ?? "").trim() || `lsof code ${result.status}`,
      };
    }
    const output = result.stdout ?? "";
    const candidatePids = parseGrokLeaderSocketOwnerPids(output, socketPath);
    const commandLines = new Map(
      candidatePids.map((pid) => [pid, readProcessCommandLine(pid)] as const),
    );
    return {
      available: true,
      socketPids: candidatePids,
      pids: selectGrokLeaderSocketOwnerPids(socketPath, output, commandLines),
    };
  } catch (error) {
    return {
      available: false,
      socketPids: [],
      pids: [],
      detail: describeUnknownError(error),
    };
  }
}

function resolveGrokLeaderLockPath(socketPath: string): string {
  return socketPath.endsWith(".sock")
    ? `${socketPath.slice(0, -".sock".length)}.lock`
    : `${socketPath}.lock`;
}

function readGrokLeaderLockPid(socketPath: string): number | null {
  if (process.platform === "win32") return null;
  try {
    const pid = Number.parseInt(
      fs.readFileSync(resolveGrokLeaderLockPath(socketPath), "utf8").trim(),
      10,
    );
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForLeaderConnection(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await canConnectToLeader(socketPath)) return true;
    if (Date.now() >= deadline) break;
    await delay(Math.min(GROK_LEADER_POLL_INTERVAL_MS, deadline - Date.now()));
  } while (Date.now() < deadline);
  return false;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await delay(Math.min(GROK_LEADER_POLL_INTERVAL_MS, deadline - Date.now()));
  }
  return !isPidAlive(pid);
}

async function terminateVerifiedGrokLeader(pid: number): Promise<boolean> {
  killProcessTreeSync(pid);
  if (await waitForProcessExit(pid, GROK_LEADER_EXIT_TIMEOUT_MS)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // It may have exited between the wait and the fallback signal.
  }
  return await waitForProcessExit(pid, GROK_LEADER_EXIT_TIMEOUT_MS);
}

export function findGrokSessionDirectory(
  sessionId: string,
  preferredCwd?: string,
): string | null {
  if (preferredCwd) {
    const preferred = grokSessionDirectory(preferredCwd, sessionId);
    if (fs.existsSync(preferred)) return preferred;
  }
  const sessionsRoot = path.join(grokHomeDirectory(), "sessions");
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const candidate = path.join(sessionsRoot, project.name, sessionId);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveGrokSessionCwd(sessionId: string): string | null {
  const directory = findGrokSessionDirectory(sessionId);
  if (!directory) return null;
  try {
    const summary = JSON.parse(
      fs.readFileSync(path.join(directory, "summary.json"), "utf8"),
    ) as unknown;
    if (isRecord(summary) && isRecord(summary.info) && typeof summary.info.cwd === "string") {
      return summary.info.cwd;
    }
  } catch {
    // Fall back to decoding the project directory name.
  }
  try {
    return decodeURIComponent(path.basename(path.dirname(directory)));
  } catch {
    return null;
  }
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string") {
        return entry.text;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function normalizeGrokUserText(text: string): string {
  const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)?.[1]?.trim();
  if (query) return query;
  if (/<(?:system-reminder|user_info|git_status)>/i.test(text)) return "";
  return text.trim();
}

export function parseGrokChatHistory(text: string): BridgeSessionMessage[] {
  const messages: BridgeSessionMessage[] = [];
  let latestAssistantIndex = -1;
  const attachGeneratedImage = (image: BridgeMessageImage) => {
    if (latestAssistantIndex < 0) {
      messages.push({
        role: "assistant",
        text: "",
        phase: "final_answer",
        images: [image],
      });
      latestAssistantIndex = messages.length - 1;
      return;
    }
    const assistant = messages[latestAssistantIndex];
    if (!assistant || assistant.role !== "assistant") return;
    assistant.images = mergeBridgeMessageImages(assistant.images, [image]);
  };

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;

    if (value.type === "tool_result") {
      const content = typeof value.content === "string" ? value.content.trim() : "";
      if (!content || /^Read image file:/i.test(content)) continue;
      let result: unknown;
      try {
        result = JSON.parse(content);
      } catch {
        continue;
      }
      if (!isRecord(result) || typeof result.path !== "string") continue;
      const imagePath = path.normalize(result.path);
      const extension = path.extname(imagePath).toLowerCase();
      if (
        !path.isAbsolute(imagePath) ||
        ![".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"].includes(extension) ||
        !fs.existsSync(imagePath)
      ) {
        continue;
      }
      attachGeneratedImage({
        source: "local",
        path: imagePath,
        ...(readString(result.filename) ? { alt: readString(result.filename) } : {}),
      });
      continue;
    }

    if (value.type !== "user" && value.type !== "assistant") continue;
    const rawText = textContent(value.content);
    const messageText = value.type === "user" ? normalizeGrokUserText(rawText) : rawText.trim();
    if (value.type === "user") latestAssistantIndex = -1;
    if (!messageText) continue;
    const model = value.type === "assistant"
      ? readString(value.model_id) ?? readString(value.model)
      : undefined;
    const message = enrichBridgeSessionMessageImages({
      role: value.type,
      text: messageText,
      ...(value.type === "assistant" ? { phase: "final_answer" as const } : {}),
      ...(model ? { model } : {}),
    });
    messages.push(message);
    if (value.type === "assistant") latestAssistantIndex = messages.length - 1;
  }
  return messages;
}

function parseGrokLiveEventPaths(
  lsofOutput: string,
  sessionsRoot: string,
): Set<string> {
  const normalizedRoot = `${path.resolve(sessionsRoot)}${path.sep}`;
  const eventPaths = new Set<string>();
  for (const line of lsofOutput.split(/\r?\n/)) {
    if (!line.startsWith("n") || line.length <= 1) continue;
    const candidate = path.resolve(line.slice(1));
    if (
      candidate.startsWith(normalizedRoot) &&
      path.basename(candidate) === "events.jsonl"
    ) {
      eventPaths.add(candidate);
    }
  }
  return eventPaths;
}

function probeGrokLiveEventPaths(sessionsRoot: string): Set<string> {
  if (process.platform === "win32") return new Set();
  const cacheKey = path.resolve(sessionsRoot);
  const cached = grokLiveEventPathCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) return cached.paths;
  try {
    const result = spawnSync("lsof", ["-nP", "-Fpn", "-c", "grok"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2_000,
      maxBuffer: GROK_PROCESS_PROBE_MAX_BUFFER_BYTES,
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) {
      return new Set();
    }
    const paths = parseGrokLiveEventPaths(result.stdout ?? "", sessionsRoot);
    grokLiveEventPathCache.set(cacheKey, {
      expiresAtMs: Date.now() + GROK_LIVE_EVENT_CACHE_TTL_MS,
      paths,
    });
    return paths;
  } catch {
    return new Set();
  }
}

function readGrokEventTail(eventsPath: string): string {
  try {
    const stat = fs.statSync(eventsPath);
    const bytesToRead = Math.min(stat.size, GROK_EVENT_TAIL_MAX_BYTES);
    if (bytesToRead <= 0) return "";
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const fd = fs.openSync(eventsPath, "r");
    try {
      fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
    } finally {
      fs.closeSync(fd);
    }
    let text = buffer.toString("utf8");
    if (bytesToRead < stat.size) {
      const firstLineBreak = text.indexOf("\n");
      text = firstLineBreak >= 0 ? text.slice(firstLineBreak + 1) : "";
    }
    return text;
  } catch {
    return "";
  }
}

function inferGrokLiveRuntimeStatus(eventsPath: string): BridgeResumeSessionRuntimeStatus {
  let turnActive = false;
  let sawTurnActivity = false;
  for (const line of readGrokEventTail(eventsPath).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    const type = readString(event.type);
    if (type === "turn_started") {
      sawTurnActivity = true;
      turnActive = true;
      continue;
    }
    if (type === "turn_ended") {
      sawTurnActivity = true;
      turnActive = false;
      continue;
    }
    if (type === "permission_requested") {
      sawTurnActivity = true;
      turnActive = true;
      continue;
    }
    if (type === "permission_resolved") continue;
    if (
      type === "loop_started" ||
      type === "phase_changed" ||
      type === "first_token" ||
      type === "tool_started" ||
      type === "tool_completed"
    ) {
      sawTurnActivity = true;
      turnActive = true;
    }
  }
  if (!sawTurnActivity || !turnActive) return { type: "idle" };
  return { type: "active", activeFlags: [] };
}

type ListGrokStoredSessionsOptions = {
  liveEventPaths?: Iterable<string>;
};

export function listGrokStoredSessions(
  limit = 10,
  options: ListGrokStoredSessionsOptions = {},
): BridgeResumeSessionCandidate[] {
  const sessionsRoot = path.join(grokHomeDirectory(), "sessions");
  const liveEventPaths = options.liveEventPaths === undefined
    ? probeGrokLiveEventPaths(sessionsRoot)
    : new Set([...options.liveEventPaths].map((eventPath) => path.resolve(eventPath)));
  const candidates: BridgeResumeSessionCandidate[] = [];
  let projects: fs.Dirent[];
  try {
    projects = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDirectory = path.join(sessionsRoot, project.name);
    let sessions: fs.Dirent[];
    try {
      sessions = fs.readdirSync(projectDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const directory = path.join(projectDirectory, session.name);
      const summaryPath = path.join(directory, "summary.json");
      let summary: unknown;
      let stat: fs.Stats;
      try {
        summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
        stat = fs.statSync(summaryPath);
      } catch {
        continue;
      }
      if (!isRecord(summary)) continue;
      const info = isRecord(summary.info) ? summary.info : null;
      const sessionId = readString(info?.id) ?? session.name;
      const cwd = readString(info?.cwd) ?? (() => {
        try { return decodeURIComponent(project.name); } catch { return undefined; }
      })();
      const title = readString(summary.generated_title) ??
        readString(summary.session_summary) ??
        `Grok 会话 ${sessionId.slice(0, 8)}`;
      const lastUpdatedAt = readString(summary.last_active_at) ??
        readString(summary.updated_at) ??
        stat.mtime.toISOString();
      const eventsPath = path.join(directory, "events.jsonl");
      candidates.push({
        sessionId,
        threadId: sessionId,
        title,
        lastUpdatedAt,
        ...(cwd ? { cwd } : {}),
        runtimeStatus: liveEventPaths.has(path.resolve(eventsPath))
          ? inferGrokLiveRuntimeStatus(eventsPath)
          : { type: "notLoaded" },
      });
    }
  }
  return candidates
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt))
    .slice(0, Math.max(1, limit));
}

export async function readGrokStoredSessionMessages(
  cwd: string,
  sessionId: string,
): Promise<BridgeSessionMessage[]> {
  try {
    const directory = findGrokSessionDirectory(sessionId, cwd);
    if (!directory) return [];
    return parseGrokChatHistory(
      fs.readFileSync(path.join(directory, "chat_history.jsonl"), "utf8"),
    );
  } catch {
    return [];
  }
}

export class GrokAcpAdapter extends AcpBridgeAdapter {
  private readonly grokOptions: AdapterOptions;
  private readonly leaderSocket: string;
  private leaderProcess: ChildProcess | null = null;
  private ownsLeaderProcess = false;
  private nativeProcess: ChildProcess | null = null;
  private nativeGeneration = 0;
  private disposingGrok = false;
  private startingGrok = false;

  constructor(options: AdapterOptions) {
    const leaderSocket = resolveGrokLeaderSocket(options.cwd);
    super(options, {
      kind: "grok",
      buildArgs: (adapterOptions) => buildGrokAcpArgs(adapterOptions, leaderSocket),
      listSessions: async (request, cwd, limit) =>
        normalizeAcpSessionCandidates(await request("session/list", {}), cwd, limit),
      readSessionMessages: readGrokStoredSessionMessages,
      resolveSessionCwd: resolveGrokSessionCwd,
    });
    this.grokOptions = options;
    this.leaderSocket = leaderSocket;
  }

  async getSessionMessageMedia(sessionId: string): Promise<BridgeSessionMessage[]> {
    return await readGrokStoredSessionMessages(this.grokOptions.cwd, sessionId);
  }

  override async start(): Promise<void> {
    this.disposingGrok = false;
    this.startingGrok = true;
    try {
      await this.ensureLeaderProcess();
      await super.start();
    } finally {
      this.startingGrok = false;
    }
    await this.restartNativeClient();
  }

  override async createSession(): Promise<void> {
    await super.createSession();
    if (!this.startingGrok && this.grokOptions.renderMode === "companion") {
      await this.restartNativeClient();
    }
  }

  override async resumeSession(sessionId: string): Promise<void> {
    await super.resumeSession(sessionId);
    if (!this.startingGrok && this.grokOptions.renderMode === "companion") {
      await this.restartNativeClient();
    }
  }

  override async dispose(): Promise<void> {
    this.disposingGrok = true;
    this.nativeGeneration += 1;
    this.stopNativeClient();
    await super.dispose();
    await this.stopOwnedLeader();
  }

  private async ensureLeaderProcess(): Promise<void> {
    if (await waitForLeaderConnection(this.leaderSocket, 500)) {
      return;
    }

    const ownerProbe = probeGrokLeaderSocketOwners(this.leaderSocket);
    const recoverablePids = new Set(ownerProbe.pids);
    const lockPid = readGrokLeaderLockPid(this.leaderSocket);
    if (
      lockPid !== null &&
      lockPid !== process.pid &&
      isPidAlive(lockPid) &&
      isGrokLeaderCommandLine(readProcessCommandLine(lockPid))
    ) {
      const ownerCwd = readProcessCwd(lockPid);
      if (ownerCwd && path.resolve(ownerCwd) === path.resolve(this.grokOptions.cwd)) {
        recoverablePids.add(lockPid);
      }
    }

    const recoveredPids: number[] = [];
    if (recoverablePids.size > 0) {
      if (
        await waitForLeaderConnection(
          this.leaderSocket,
          GROK_EXISTING_LEADER_READY_TIMEOUT_MS,
        )
      ) {
        return;
      }
      for (const pid of recoverablePids) {
        if (!(await terminateVerifiedGrokLeader(pid))) {
          throw new Error(
            `Grok 共享会话服务被不可连接的旧进程占用，且无法安全回收（PID ${pid}，socket ${this.leaderSocket}）。`,
          );
        }
        recoveredPids.push(pid);
      }
      if (process.platform !== "win32") {
        fs.rmSync(this.leaderSocket, { force: true });
        const currentLockPid = readGrokLeaderLockPid(this.leaderSocket);
        if (
          currentLockPid === null ||
          recoveredPids.includes(currentLockPid) ||
          !isPidAlive(currentLockPid)
        ) {
          fs.rmSync(resolveGrokLeaderLockPath(this.leaderSocket), { force: true });
        }
      }
    } else if (
      process.platform !== "win32" &&
      ownerProbe.available &&
      ownerProbe.socketPids.length === 0 &&
      (lockPid === null || !isPidAlive(lockPid))
    ) {
      // Only remove stale artifacts after lsof proves that no process holds the
      // socket and the lock does not point at a live process. A single failed
      // 250 ms connection is not ownership evidence.
      fs.rmSync(this.leaderSocket, { force: true });
      fs.rmSync(resolveGrokLeaderLockPath(this.leaderSocket), { force: true });
    }

    const env = buildCliEnvironment("grok");
    const target = resolveSpawnTarget(this.grokOptions.command, "grok", { env });
    const args = [
      "agent",
      "leader",
      "--no-exit-on-disconnect",
      "--relay-on-demand",
      "--leader-socket",
      this.leaderSocket,
    ];
    const child = spawn(target.file, [...target.args, ...args], {
      cwd: this.grokOptions.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.leaderProcess = child;
    this.ownsLeaderProcess = true;

    let leaderError = "";
    child.once("error", (error) => {
      leaderError = describeUnknownError(error);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      leaderError = `${leaderError}${String(chunk)}`.slice(-4000);
    });

    const deadline = Date.now() + GROK_LEADER_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await canConnectToLeader(this.leaderSocket)) {
        return;
      }
      if (child.exitCode !== null) {
        break;
      }
      await delay(GROK_LEADER_POLL_INTERVAL_MS);
    }

    const childPid = child.pid;
    await this.stopOwnedLeader();
    const detail = leaderError.trim().replace(/\s+/g, " ");
    const diagnostics = [
      `socket=${this.leaderSocket}`,
      ...(typeof childPid === "number" ? [`child_pid=${childPid}`] : []),
      ...(recoveredPids.length > 0
        ? [`recovered_orphan_pids=${recoveredPids.join(",")}`]
        : []),
      ...(!ownerProbe.available && ownerProbe.detail
        ? [`owner_probe=${ownerProbe.detail.replace(/\s+/g, " ")}`]
        : []),
    ].join("，");
    throw new Error(
      detail
        ? `Grok 共享会话服务启动失败：${detail}（${diagnostics}）`
        : `Grok 共享会话服务启动超时（${diagnostics}），请运行 grok doctor 检查登录和本机环境。`,
    );
  }

  private async restartNativeClient(): Promise<void> {
    if (this.grokOptions.renderMode !== "companion") {
      return;
    }
    const generation = ++this.nativeGeneration;
    this.stopNativeClient();
    const env = buildCliEnvironment("grok");
    const target = resolveSpawnTarget(this.grokOptions.command, "grok", { env });
    const sessionId = this.getState().sharedSessionId;
    const args = buildGrokNativeArgs(this.grokOptions, this.leaderSocket, sessionId);
    const child = spawn(target.file, [...target.args, ...args], {
      cwd: sessionId ? resolveGrokSessionCwd(sessionId) ?? this.grokOptions.cwd : this.grokOptions.cwd,
      env,
      stdio: "inherit",
      windowsHide: false,
    });
    this.nativeProcess = child;

    child.once("error", (error) => {
      if (generation !== this.nativeGeneration || this.disposingGrok) return;
      this.setStatus("error", "Grok 可见终端启动失败。");
      this.emit({
        type: "fatal_error",
        message: `Grok 可见终端启动失败：${describeUnknownError(error)}`,
        timestamp: nowIso(),
      });
    });

    child.once("exit", (code, signal) => {
      if (generation !== this.nativeGeneration || this.disposingGrok) return;
      if (this.nativeProcess === child) this.nativeProcess = null;
      this.setStatus("stopped", "Grok 可见终端已关闭。");
      const detail = signal ? `信号 ${signal}` : `代码 ${code ?? "未知"}`;
      this.emit({
        type: "shutdown_requested",
        reason: "companion_closed",
        message: `Grok 可见终端已关闭（${detail}）。`,
        exitCode: typeof code === "number" ? code : 0,
        timestamp: nowIso(),
      });
    });
  }

  private stopNativeClient(): void {
    const child = this.nativeProcess;
    this.nativeProcess = null;
    if (child?.pid) {
      try {
        killProcessTreeSync(child.pid);
      } catch {
        // Best effort shutdown.
      }
    }
  }

  private async stopOwnedLeader(): Promise<void> {
    const child = this.leaderProcess;
    const ownedLeader = this.ownsLeaderProcess;
    this.leaderProcess = null;
    this.ownsLeaderProcess = false;
    if (ownedLeader && child?.pid) {
      try {
        killProcessTreeSync(child.pid);
        await waitForProcessExit(child.pid, GROK_LEADER_EXIT_TIMEOUT_MS);
      } catch {
        // Best effort shutdown.
      }
    }
    if (ownedLeader && process.platform !== "win32") {
      const ownerProbe = probeGrokLeaderSocketOwners(this.leaderSocket);
      const lockPid = readGrokLeaderLockPid(this.leaderSocket);
      if (
        ownerProbe.available &&
        ownerProbe.socketPids.length === 0 &&
        (
          lockPid === null ||
          lockPid === child?.pid ||
          !isPidAlive(lockPid)
        )
      ) {
        try {
          fs.rmSync(this.leaderSocket, { force: true });
          fs.rmSync(resolveGrokLeaderLockPath(this.leaderSocket), { force: true });
        } catch {
          // Best effort cleanup after proving no process owns the socket.
        }
      }
    }
  }
}

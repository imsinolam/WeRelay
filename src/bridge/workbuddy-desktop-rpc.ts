import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensurePrivateDir } from "../utils/private-files.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveChannelDataDir } from "../wechat/channel-config.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_CONNECT_POLL_INTERVAL_MS = 250;
const DEFAULT_EXISTING_PROCESS_GRACE_MS = 1_500;
const DEFAULT_QUIT_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const WORKBUDDY_APP_EXECUTABLE = "/Applications/WorkBuddy.app/Contents/MacOS/Electron";
const WORKBUDDY_APP_ASAR = "/Applications/WorkBuddy.app/Contents/Resources/app.asar";
export const WORKBUDDY_BUNDLE_ID = "com.tencent.workbuddy.mac";

export type WorkBuddyDesktopRpcCallbacks = {
  onEvent(channel: string, data: unknown): void;
  onDisconnect?(error?: Error): void;
};

export type WorkBuddyDesktopRpcClientOptions = WorkBuddyDesktopRpcCallbacks & {
  allowDesktopApplicationLaunch?: boolean;
};

export interface WorkBuddyDesktopRpcClientLike {
  connect(): Promise<void>;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

type WorkBuddyDesktopLaunchOptions = {
  socketPath?: string;
  hookPath?: string;
};

type WorkBuddyDesktopLifecycle = {
  isRunning(): Promise<boolean>;
  launch(options: WorkBuddyDesktopLaunchOptions): Promise<void>;
  restart(options: WorkBuddyDesktopLaunchOptions): Promise<void>;
  cleanup?(): Promise<void>;
};

type WorkBuddyProcessRecord = {
  pid: number;
  parentPid: number;
  commandLine: string;
};

type PendingRequest = {
  channel: string;
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};

type WorkBuddyDesktopRpcFrame = {
  type?: unknown;
  id?: unknown;
  channel?: unknown;
  result?: unknown;
  error?: unknown;
  message?: unknown;
};

export function resolveWorkBuddyDesktopSocketPath(options: {
  uid?: number;
  tmpDir?: string;
  platform?: NodeJS.Platform;
} = {}): string {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (platform === "win32") {
    return `\\\\.\\pipe\\werelay-workbuddy-${uid ?? "user"}`;
  }
  const tmpDir = options.tmpDir ?? (platform === "darwin" ? "/tmp" : os.tmpdir());
  return path.posix.join(tmpDir, `werelay-workbuddy-${uid ?? "user"}.sock`);
}

export function resolveWorkBuddyDesktopHookPath(dataDir = resolveChannelDataDir()): string {
  return path.join(dataDir, "runtime", "workbuddy-desktop-hook.cjs");
}

export function buildWorkBuddyDesktopHookSource(): string {
  return String.raw`"use strict";
const fs = require("node:fs");
const net = require("node:net");
const childProcess = require("node:child_process");

const socketPath = process.env.WERELAY_WORKBUDDY_SOCKET;
const logPath = process.env.WERELAY_WORKBUDDY_HOOK_LOG;

function log(message) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, new Date().toISOString() + " pid=" + process.pid + " " + message + "\n", { mode: 0o600 });
    fs.chmodSync(logPath, 0o600);
  } catch {}
}

if (socketPath && process.type === "browser" && !globalThis.__deskRelayWorkBuddyHookInstalled) {
  globalThis.__deskRelayWorkBuddyHookInstalled = true;
  const originalSpawn = childProcess.spawn;
  const clients = new Set();
  let daemonChild = null;
  let server = null;

  function send(client, frame) {
    if (!client.destroyed) client.write(JSON.stringify(frame) + "\n");
  }

  function broadcast(chunk) {
    for (const client of clients) {
      if (!client.destroyed) client.write(chunk);
    }
  }

  function startServer() {
    if (server) return;
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    } catch {}
    server = net.createServer((client) => {
      clients.add(client);
      client.setEncoding("utf8");
      let buffer = "";
      client.on("data", (chunk) => {
        buffer += chunk;
        while (true) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let frame;
          try {
            frame = JSON.parse(line);
            if (frame?.type !== "rpc-request" || typeof frame.id !== "string" || typeof frame.channel !== "string") {
              throw new Error("请求格式无效");
            }
            if (!frame.channel.startsWith("session:") && frame.channel !== "daemon:ping") {
              throw new Error("请求通道不允许");
            }
            if (!daemonChild?.stdin || daemonChild.stdin.destroyed) {
              throw new Error("WorkBuddy app-server 尚未就绪");
            }
            daemonChild.stdin.write(JSON.stringify(frame) + "\n");
          } catch (error) {
            send(client, {
              type: "rpc-error",
              id: typeof frame?.id === "string" ? frame.id : "werelay-invalid-request",
              channel: typeof frame?.channel === "string" ? frame.channel : "werelay",
              error: {
                code: "WERELAY_BRIDGE_ERROR",
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
      });
      client.on("close", () => clients.delete(client));
      client.on("error", () => clients.delete(client));
      send(client, { type: "bridge-ready", pid: process.pid });
    });
    server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {}
      log("socket ready " + socketPath);
    });
    server.on("error", (error) => log("server error " + (error?.message || String(error))));
  }

  childProcess.spawn = function patchedSpawn(command, args, options) {
    const child = originalSpawn.apply(this, arguments);
    const argv = Array.isArray(args) ? args : [];
    if (argv.some((value) => typeof value === "string" && value.includes("daemon-app-server-entry.js"))) {
      daemonChild = child;
      startServer();
      child.stdout?.on("data", broadcast);
      child.once("exit", (code, signal) => {
        if (daemonChild === child) daemonChild = null;
        log("daemon exit code=" + code + " signal=" + signal);
      });
      log("captured daemon pid=" + child.pid);
    }
    return child;
  };

  process.once("exit", () => {
    try {
      server?.close();
    } catch {}
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    } catch {}
  });
  log("hook installed");
}
`;
}

export async function ensureWorkBuddyDesktopHookFile(
  hookPath = resolveWorkBuddyDesktopHookPath(),
): Promise<string> {
  const source = buildWorkBuddyDesktopHookSource();
  ensurePrivateDir(path.dirname(hookPath));
  let current = "";
  try {
    current = await fs.promises.readFile(hookPath, "utf8");
  } catch {
    // The file is created below.
  }
  if (current !== source) {
    await fs.promises.writeFile(hookPath, source, { encoding: "utf8", mode: 0o600 });
  }
  await fs.promises.chmod(hookPath, 0o600).catch(() => undefined);
  return hookPath;
}

function buildNodeOptions(current: string | undefined, hookPath: string): string {
  const requireOption = `--require=${hookPath}`;
  const value = current?.trim() ?? "";
  if (value.includes(requireOption)) return value;
  return [value, requireOption].filter(Boolean).join(" ");
}

export function isWorkBuddyMainProcessCommandLine(
  commandLine: string,
  options: {
    executable?: string;
    appAsar?: string;
  } = {},
): boolean {
  const executable = options.executable ?? WORKBUDDY_APP_EXECUTABLE;
  const appAsar = options.appAsar ?? WORKBUDDY_APP_ASAR;
  const normalized = commandLine.trim();
  return normalized === executable || normalized === `${executable} ${appAsar}`;
}

export function isWorkBuddyDesktopDaemonCommandLine(
  commandLine: string,
  options: {
    executable?: string;
    appAsar?: string;
  } = {},
): boolean {
  const executable = options.executable ?? WORKBUDDY_APP_EXECUTABLE;
  const appAsar = options.appAsar ?? WORKBUDDY_APP_ASAR;
  const normalized = commandLine.trim();
  return normalized === `${executable} ${appAsar}/main/daemon-app-server-entry.js --stdio`;
}

async function listWorkBuddyProcesses(): Promise<WorkBuddyProcessRecord[]> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,ppid=,command="]);
    return stdout.split(/\r?\n/).flatMap((line): WorkBuddyProcessRecord[] => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) return [];
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid < 0) {
        return [];
      }
      return [{ pid, parentPid, commandLine: match[3]! }];
    });
  } catch {
    return [];
  }
}

async function listWorkBuddyMainProcessIds(): Promise<number[]> {
  return (await listWorkBuddyProcesses())
    .filter((record) => isWorkBuddyMainProcessCommandLine(record.commandLine))
    .map((record) => record.pid);
}

export async function isWorkBuddyMainProcessRunning(): Promise<boolean> {
  return (await listWorkBuddyMainProcessIds()).length > 0;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessIdsToExit(processIds: number[], timeoutMs: number): Promise<boolean> {
  if (processIds.length === 0) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processIds.every((pid) => !isProcessRunning(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return processIds.every((pid) => !isProcessRunning(pid));
}

async function waitForPromiseWithinDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  timeoutMessage: string,
): Promise<T> {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new Error(timeoutMessage);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cleanupOrphanedWorkBuddyDesktopDaemons(): Promise<void> {
  const processIds = (await listWorkBuddyProcesses())
    .filter((record) =>
      record.parentPid === 1 && isWorkBuddyDesktopDaemonCommandLine(record.commandLine)
    )
    .map((record) => record.pid);
  if (processIds.length === 0) return;
  for (const pid of processIds) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may already have exited.
    }
  }
  if (await waitForProcessIdsToExit(processIds, 2_000)) return;
  for (const pid of processIds) {
    if (!isProcessRunning(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
  await waitForProcessIdsToExit(processIds, 1_000);
}

export async function launchWorkBuddyWithDesktopRelay(options: {
  socketPath?: string;
  hookPath?: string;
  executable?: string;
  appAsar?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("WorkBuddy 桌面同步目前仅支持 macOS。");
  }
  const executable = options.executable ?? WORKBUDDY_APP_EXECUTABLE;
  const appAsar = options.appAsar ?? WORKBUDDY_APP_ASAR;
  if (!fs.existsSync(executable) || !fs.existsSync(appAsar)) {
    throw new Error("没有找到 WorkBuddy 应用，请先安装并打开 WorkBuddy。");
  }
  await cleanupOrphanedWorkBuddyDesktopDaemons();
  const socketPath = options.socketPath ?? resolveWorkBuddyDesktopSocketPath();
  const hookPath = await ensureWorkBuddyDesktopHookFile(options.hookPath);
  const env = {
    ...process.env,
    ...options.env,
    NODE_OPTIONS: buildNodeOptions(options.env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS, hookPath),
    WERELAY_WORKBUDDY_SOCKET: socketPath,
    WERELAY_WORKBUDDY_HOOK_LOG: options.env?.WERELAY_WORKBUDDY_HOOK_LOG ??
      path.join(resolveChannelDataDir(), "runtime", "workbuddy-desktop-hook.log"),
  };
  const child = spawn(executable, [appAsar], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();
}

async function waitForWorkBuddyToExit(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await isWorkBuddyMainProcessRunning()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !await isWorkBuddyMainProcessRunning();
}

export async function restartWorkBuddyWithDesktopRelay(options: {
  socketPath?: string;
  hookPath?: string;
  quitTimeoutMs?: number;
} = {}): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("WorkBuddy 桌面同步目前仅支持 macOS。");
  }
  const quitTimeoutMs = options.quitTimeoutMs ?? DEFAULT_QUIT_TIMEOUT_MS;
  if (await isWorkBuddyMainProcessRunning()) {
    try {
      await execFileAsync("/usr/bin/osascript", [
        "-e",
        `tell application id "${WORKBUDDY_BUNDLE_ID}" to quit`,
      ], {
        timeout: quitTimeoutMs,
        killSignal: "SIGKILL",
      });
    } catch {
      throw new Error("WorkBuddy 无法自动重启，请先处理电脑端尚未关闭的窗口后重试。");
    }
    if (!await waitForWorkBuddyToExit(quitTimeoutMs)) {
      throw new Error("WorkBuddy 正在阻止自动重启，请先处理电脑端尚未保存的内容后重试。");
    }
  }
  await launchWorkBuddyWithDesktopRelay(options);
}

function defaultWorkBuddyDesktopLifecycle(): WorkBuddyDesktopLifecycle {
  return {
    isRunning: isWorkBuddyMainProcessRunning,
    launch: launchWorkBuddyWithDesktopRelay,
    restart: restartWorkBuddyWithDesktopRelay,
    cleanup: cleanupOrphanedWorkBuddyDesktopDaemons,
  };
}

export class WorkBuddyDesktopRpcClient implements WorkBuddyDesktopRpcClientLike {
  private readonly socketPath: string;
  private readonly hookPath?: string;
  private readonly callbacks: WorkBuddyDesktopRpcCallbacks;
  private readonly connectTimeoutMs: number;
  private readonly connectPollIntervalMs: number;
  private readonly existingProcessGraceMs: number;
  private readonly requestTimeoutMs: number;
  private readonly lifecycle: WorkBuddyDesktopLifecycle;
  private readonly allowDesktopApplicationLaunch: boolean;
  private socket: net.Socket | null = null;
  private buffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(options: {
    socketPath?: string;
    hookPath?: string;
    callbacks: WorkBuddyDesktopRpcCallbacks;
    allowDesktopApplicationLaunch?: boolean;
    connectTimeoutMs?: number;
    connectPollIntervalMs?: number;
    existingProcessGraceMs?: number;
    requestTimeoutMs?: number;
    lifecycle?: WorkBuddyDesktopLifecycle;
  }) {
    this.socketPath = options.socketPath ?? resolveWorkBuddyDesktopSocketPath();
    this.hookPath = options.hookPath;
    this.callbacks = options.callbacks;
    this.allowDesktopApplicationLaunch =
      options.allowDesktopApplicationLaunch === true;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.connectPollIntervalMs = options.connectPollIntervalMs ?? DEFAULT_CONNECT_POLL_INTERVAL_MS;
    this.existingProcessGraceMs = options.existingProcessGraceMs ?? DEFAULT_EXISTING_PROCESS_GRACE_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.lifecycle = options.lifecycle ?? defaultWorkBuddyDesktopLifecycle();
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    this.closed = false;
    const direct = await this.tryConnect();
    if (direct) {
      await this.lifecycle.cleanup?.();
      return;
    }

    const deadline = Date.now() + this.connectTimeoutMs;
    const wasRunning = await this.lifecycle.isRunning();
    if (wasRunning && this.existingProcessGraceMs > 0) {
      const graceDeadline = Math.min(deadline, Date.now() + this.existingProcessGraceMs);
      if (await this.waitForConnection(graceDeadline)) {
        await this.lifecycle.cleanup?.();
        return;
      }
    }
    if (!this.allowDesktopApplicationLaunch) {
      throw new Error(
        "WeRelay 后台不会自动启动或重启 WorkBuddy；请从网页或 ClawBot 明确选择 WorkBuddy 后重试。",
      );
    }
    const launchOptions = {
      socketPath: this.socketPath,
      hookPath: this.hookPath,
    };
    if (wasRunning) {
      await waitForPromiseWithinDeadline(
        this.lifecycle.restart(launchOptions),
        deadline,
        "WorkBuddy 自动重启超时，请处理电脑端未关闭的窗口后重试。",
      );
    } else {
      await waitForPromiseWithinDeadline(
        this.lifecycle.launch(launchOptions),
        deadline,
        "WorkBuddy 自动启动超时，请确认应用可以正常打开后重试。",
      );
    }
    if (await this.waitForConnection(deadline)) {
      await this.lifecycle.cleanup?.();
      return;
    }
    throw new Error("WorkBuddy 自动接入失败，请确认应用可以正常打开后重试。");
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error("WorkBuddy Desktop 连接已断开，请重新切换到 WorkBuddy。");
    }
    const id = `werelay-${crypto.randomUUID()}`;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WorkBuddy Desktop 请求超时：${channel}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { channel, resolve, reject, timer });
      socket.write(`${JSON.stringify({ type: "rpc-request", id, channel, args })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.end();
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 500).unref?.();
      });
    }
    this.rejectPending(new Error("WorkBuddy Desktop 连接已关闭。"));
  }

  private async tryConnect(): Promise<boolean> {
    try {
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const candidate = net.createConnection(this.socketPath);
        const onError = (error: Error) => {
          candidate.destroy();
          reject(error);
        };
        candidate.once("error", onError);
        candidate.once("connect", () => {
          candidate.off("error", onError);
          resolve(candidate);
        });
      });
      this.attachSocket(socket);
      return true;
    } catch {
      return false;
    }
  }

  private async waitForConnection(deadline: number): Promise<boolean> {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.connectPollIntervalMs));
      if (await this.tryConnect()) return true;
    }
    return false;
  }

  private attachSocket(socket: net.Socket): void {
    this.socket?.destroy();
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.handleData(chunk));
    socket.on("error", (error) => this.handleDisconnect(error));
    socket.on("close", () => this.handleDisconnect());
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let frame: WorkBuddyDesktopRpcFrame;
      try {
        frame = JSON.parse(line) as WorkBuddyDesktopRpcFrame;
      } catch {
        continue;
      }
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: WorkBuddyDesktopRpcFrame): void {
    const type = typeof frame.type === "string" ? frame.type : "";
    const id = typeof frame.id === "string" ? frame.id : "";
    if ((type === "rpc-response" || type === "rpc-error") && id) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (type === "rpc-error") {
        const errorRecord = frame.error && typeof frame.error === "object"
          ? frame.error as Record<string, unknown>
          : null;
        pending.reject(new Error(
          typeof errorRecord?.message === "string"
            ? errorRecord.message
            : `WorkBuddy Desktop 请求失败：${pending.channel}`,
        ));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (type === "rpc-event" && typeof frame.channel === "string") {
      this.callbacks.onEvent(frame.channel, frame.result);
    }
  }

  private handleDisconnect(error?: Error): void {
    if (this.socket?.destroyed) this.socket = null;
    this.rejectPending(error ?? new Error("WorkBuddy Desktop 连接已断开。"));
    if (!this.closed) this.callbacks.onDisconnect?.(error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

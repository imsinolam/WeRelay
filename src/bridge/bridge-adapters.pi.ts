import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { BridgeAdapter, BridgeAdapterState, BridgeEvent, BridgeSessionMessage, BridgeSessionSendResult, BridgeResumeSessionCandidate, BridgeSessionModelState, BridgeSessionRunSummary } from "./bridge-types.ts";
import type { AdapterOptions, EventSink } from "./bridge-adapters.shared.ts";
import { buildCliEnvironment, resolveSpawnTarget } from "./bridge-adapters.shared.ts";
import { findPiSessionFile, listPiSessions, readPiSessionMessages, readPiSessionProject, readPiNativeSessionId } from "./pi-session-catalog.ts";
import { nowIso, truncatePreview } from "./bridge-utils.ts";
import { acquirePiOwnerLock } from "./pi-owner-lock.ts";
import { discoverPiOwners, selectPiOwner, type PiOwnerAdvertisement } from "./pi-owner-discovery.ts";
import { readPiOwnerModels, readPiInstalledModels } from "./pi-model-catalog.ts";
import { formatPiModelError } from "./pi-model-error.ts";

type OwnerRecord = { type: string; token?: string; id?: string; sessionId?: string; ok?: boolean; error?: string; text?: string; queued?: boolean; outcome?: "completed" | "aborted" | "error"; modelState?: BridgeSessionModelState; run?: BridgeSessionRunSummary | null };
const EXTENSION_PATH = fileURLToPath(new URL("../../bin/pi-owner-extension.mjs", import.meta.url));

const PI_OWNERSHIP_FLAGS = /^(?:--(?:session(?:-id|-dir)?|resume|continue|fork|no-session|mode|print|extension|no-extensions)(?:=|$)|-(?:r|c|p|e)$|--$)/i;

export function validatePiCliArgs(args: string[]): string[] {
  if (args.some((arg) => PI_OWNERSHIP_FLAGS.test(arg))) {
    throw new Error("Pi 启动参数不能覆盖由 WeRelay 管理的原会话、扩展或交互模式。");
  }
  return [...args];
}

/** Fail closed for pre-existing Pi TUIs that did not load our owner extension. */
export function findIndependentPiProcessIds(output: string, exclude = new Set<number>()): number[] {
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || exclude.has(Number(match[1]))) return [];
    const command = match[2] ?? "";
    const executable = command.split(/\s+/, 1)[0] ?? "";
    const isPi = executable === "pi" || executable.endsWith("/bin/pi") ||
      /(?:^|\s)\S*\/pi-coding-agent\/\S*\/cli\.js(?:\s|$)/.test(command);
    return isPi ? [Number(match[1])] : [];
  });
}

function assertNoIndependentPiOwner(cwd: string, restoring = false, exclude = new Set<number>()): void {
  if (process.platform === "win32") {
    if (restoring) throw new Error("Windows 暂无法安全确认 Pi 原会话是否正被其他进程写入，拒绝自动恢复。");
    return;
  }
  let output: string;
  try { output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 3_000, maxBuffer: 8 * 1024 * 1024 }); }
  catch { throw new Error("无法确认 Pi 原会话的唯一 owner，拒绝自动恢复。"); }
  const active = findIndependentPiProcessIds(output, new Set([process.pid, ...exclude]));
  for (const pid of active) {
    let listing: string;
    try { listing = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 3_000 }); }
    catch { throw new Error("无法确认 Pi 原窗口的项目目录，拒绝打开第二个 owner。"); }
    if (listing.split("\n").some((line) => line.startsWith("n") && path.resolve(line.slice(1)) === path.resolve(cwd))) {
      throw new Error("当前项目已有未接入的 Pi 窗口；请在原窗口执行 /reload 加载 WeRelay 扩展。未新建替代任务。");
    }
  }
}


/** The visible Pi TUI is the only writer. The bridge only asks its in-process extension to act. */
export class PiOwnerAdapter implements BridgeAdapter {
  private readonly options: AdapterOptions;
  private readonly state: BridgeAdapterState;
  private sink: EventSink = () => undefined;
  private child: ChildProcess | null = null;
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private socketDir = "";
  private socketPath = "";
  private token = "";
  private buffer = "";
  private pending = new Map<string, { resolve: (value: OwnerRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private ready: ((sessionId: string) => void) | null = null;
  private readyFailure: ((error: Error) => void) | null = null;
  private disposed = false;
  private releaseOwnerLock: (() => void) | null = null;
  private restarting = false;
  private lastReply = "";
  private lastError = "";
  private settledRevision = 0;
  private ownerSessionConfirmed = false;
  private activeOrigin: "wechat" | "local" = "local";
  private externalOwner = false;
  private runSummary: BridgeSessionRunSummary | null = null;
  private ownerTransition: Promise<void> = Promise.resolve();

  constructor(options: AdapterOptions) {
    this.options = options;
    this.state = {
      kind: "pi", status: "stopped", cwd: options.cwd, command: options.command,
      sharedSessionId: options.sessionStartMode === "new" ? undefined : options.initialSharedSessionId,
      activeRuntimeSessionId: options.sessionStartMode === "new" ? undefined : options.initialSharedSessionId,
    };
  }
  setEventSink(sink: EventSink): void { this.sink = sink; }
  getState(): BridgeAdapterState { return { ...this.state }; }
  private emit(event: BridgeEvent): void { this.sink(event); }
  private status(status: BridgeAdapterState["status"], message?: string): void {
    this.state.status = status;
    this.emit({ type: "status", status, message, timestamp: nowIso() });
  }
  async start(): Promise<void> {
    if (this.child || this.socket) return;
    // The daemon is an index and an authenticated client of the real writer,
    // not another TUI. /pi must not create an empty owner to enumerate tasks.
    if (this.options.renderMode !== "companion") {
      this.status("idle");
      return;
    }
    const sessionId = this.state.sharedSessionId;
    if (sessionId) this.state.sharedSessionId = await this.nativeSessionId(sessionId);
    const owners = discoverPiOwners();
    const matching = sessionId ? owners.filter((owner) => owner.sessionId === this.state.sharedSessionId)
      : owners.filter((owner) => path.resolve(owner.cwd) === path.resolve(this.options.cwd));
    if (matching.length > 1) throw new Error("Pi 原任务有多个 owner，拒绝猜测发送目标，未启动替代任务。");
    const owner = selectPiOwner(owners, this.state.sharedSessionId, this.options.cwd);
    if (owner) { await this.attachOwner(owner); return; }
    const sessionPath = sessionId ? await findPiSessionFile(this.state.sharedSessionId!) : null;
    if (sessionId && !sessionPath) throw new Error("找不到 Pi 原任务，未创建替代任务。");
    await this.startOwner(sessionPath ?? undefined);
  }
  async sendInput(text: string): Promise<void> {
    const sessionId = this.state.sharedSessionId;
    if (!sessionId) throw new Error("Pi 尚未确认当前会话。");
    await this.sendInputToSession(sessionId, text);
  }
  async sendInputToSession(sessionId: string, text: string): Promise<BridgeSessionSendResult> {
    if (!text.trim()) throw new Error("消息不能为空。");
    sessionId = await this.nativeSessionId(sessionId);
    if (sessionId !== this.state.sharedSessionId || !this.socket || this.socket.destroyed || !this.ownerSessionConfirmed) await this.resumeSession(sessionId);
    // The real owner may start (and even finish) before its acknowledgement reaches us.
    this.activeOrigin = "wechat";
    const settledBeforeSend = this.settledRevision;
    const response = await this.request("prompt", sessionId, text);
    this.state.lastInputAt = nowIso();
    if (!response.queued && this.settledRevision === settledBeforeSend && this.state.status !== "busy") this.status("busy");
    return { queued: Boolean(response.queued) };
  }
  async listResumeSessions(limit = 10): Promise<BridgeResumeSessionCandidate[]> {
    const candidates = (await listPiSessions({ limit })).map((candidate) => this.ownerSessionConfirmed && candidate.sessionId === this.state.sharedSessionId
      ? { ...candidate, runtimeStatus: this.state.status === "busy"
        ? { type: "active" as const, activeFlags: [] } : { type: "idle" as const } } : candidate);
    const sessionId = this.state.sharedSessionId;
    if (this.ownerSessionConfirmed && sessionId && !candidates.some((candidate) => candidate.sessionId === sessionId)) {
      candidates.unshift({
        sessionId, threadId: sessionId, title: "Pi 新任务", cwd: this.state.cwd,
        projectId: this.state.cwd, projectName: path.basename(this.state.cwd),
        lastUpdatedAt: this.state.startedAt ?? nowIso(),
        runtimeStatus: this.state.status === "busy" ? { type: "active", activeFlags: [] } : { type: "idle" },
      });
    }
    return candidates.slice(0, limit);
  }
  async resumeSession(sessionId: string): Promise<void> {
    sessionId = await this.nativeSessionId(sessionId);
    const next = this.ownerTransition.catch(() => undefined).then(() => this.resumeOwner(sessionId));
    this.ownerTransition = next;
    return next;
  }
  private async resumeOwner(sessionId: string): Promise<void> {
    if (this.disposed) throw new Error("Pi 连接已关闭。");
    if (sessionId === this.state.sharedSessionId && this.socket && !this.socket.destroyed && this.ownerSessionConfirmed) return;
    const owners = discoverPiOwners();
    if (owners.filter((owner) => owner.sessionId === sessionId).length > 1) throw new Error("Pi 原任务有多个 owner，拒绝猜测发送目标，未启动替代任务。");
    const external = selectPiOwner(owners, sessionId, this.state.cwd);
    if (external) {
      await this.restartWithExternalOwner(external);
      return;
    }
    if (this.options.renderMode !== "companion") {
      throw new Error("Pi 任务已找到，但原窗口尚未提供可接入的发送接口。请在该 Pi 窗口执行 /reload；如果由 Pi Desktop 持有，请在桌面端继续。未启动第二个 Pi，也没有新建替代任务。");
    }
    const file = await findPiSessionFile(sessionId);
    if (!file) throw new Error("找不到 Pi 原任务，未创建替代任务。");
    if (this.state.status === "busy") throw new Error("Pi 正在运行，不能切换任务。");
    if (this.externalOwner) throw new Error("当前 Pi 是已打开的原窗口；请在该窗口切换任务并刷新网页，未另开第二个 Pi。");
    assertNoIndependentPiOwner(await readPiSessionProject(file), true, this.child?.pid ? new Set([this.child.pid]) : undefined);
    if (this.child) await this.request("can_switch", this.state.sharedSessionId!);
    await this.restartOwner(file);
    if (this.state.sharedSessionId !== sessionId) throw new Error("Pi 未能恢复指定原任务。");
  }
  async createSession(): Promise<void> {
    await this.createInProject(this.state.cwd);
  }
  async createSessionInProject(sourceSessionId: string): Promise<void> {
    const file = await findPiSessionFile(sourceSessionId);
    if (!file) throw new Error("找不到 Pi 原任务所属项目，未在其他项目新建任务。");
    await this.createInProject(await readPiSessionProject(file), await this.nativeSessionId(sourceSessionId));
  }
  private async createInProject(cwd: string, sourceSessionId?: string): Promise<void> {
    const next = this.ownerTransition.catch(() => undefined).then(async () => {
      if (this.disposed) throw new Error("Pi 连接已关闭。");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("Pi 原项目目录已不存在，未在其他位置新建任务。");
      const owners = discoverPiOwners().filter((owner) => path.resolve(owner.cwd) === path.resolve(cwd));
      const exact = sourceSessionId ? owners.filter((owner) => owner.sessionId === sourceSessionId) : [];
      const matches = exact.length ? exact : owners;
      if (matches.length > 1) throw new Error("该项目有多个 Pi 窗口，请先选择要使用的原窗口任务，未猜测新建位置。");
      const owner = matches[0];
      if (owner) {
        if (owner.sessionId !== this.state.sharedSessionId || !this.socket || this.socket.destroyed) await this.restartWithExternalOwner(owner);
        await this.request("can_switch", owner.sessionId);
        let response: OwnerRecord;
        try { response = await this.request("new_session", owner.sessionId); }
        catch (error) {
          if (error instanceof Error && /Unsupported Pi owner request/i.test(error.message)) throw new Error("请在 Pi 原窗口执行 /reload，加载网页新建任务能力。", { cause: error });
          throw error;
        }
        if (!response.sessionId || response.sessionId === owner.sessionId) throw new Error("Pi 未确认新任务，未发送消息，请刷新原窗口检查。");
        // Session replacement reloads extensions. Reconnect to the fresh extension
        // in the SAME process; never reuse the invalidated old extension API.
        let replacement: PiOwnerAdvertisement | undefined;
        const deadline = Date.now() + 3000;
        do {
          replacement = selectPiOwner(discoverPiOwners().filter((item) => item.pid === owner.pid), response.sessionId, cwd);
          if (replacement) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        if (!replacement) throw new Error("Pi 已新建任务，但新窗口连接尚未就绪；请刷新列表查看，勿重复新建。");
        if (replacement.socket !== owner.socket) await this.restartWithExternalOwner(replacement);
        this.state.sharedSessionId = response.sessionId;
        this.state.activeRuntimeSessionId = response.sessionId;
        this.state.cwd = cwd;
        this.ownerSessionConfirmed = true;
        this.runSummary = null;
        this.status("idle");
        return;
      }
      if (this.options.renderMode !== "companion") throw new Error("这个项目没有已接入的 Pi 原窗口；请先打开该项目的 Pi 并执行 /reload。未启动独立 owner。");
      if (this.state.status === "busy") throw new Error("Pi 正在运行，不能新建任务。");
      if (this.externalOwner) throw new Error("Pi 原窗口已断开，请重新连接后新建任务。");
      if (this.child && this.state.sharedSessionId) await this.request("can_switch", this.state.sharedSessionId);
      await this.restartOwner(undefined, cwd);
    });
    this.ownerTransition = next;
    return next;
  }
  async getSessionMessages(sessionId: string): Promise<BridgeSessionMessage[]> {
    const file = await findPiSessionFile(sessionId);
    if (!file) {
      if (this.ownerSessionConfirmed && this.state.sharedSessionId === sessionId) return [];
      throw new Error("找不到 Pi 原任务。");
    }
    return readPiSessionMessages(file);
  }
  async getLatestSessionMessage(sessionId: string): Promise<BridgeSessionMessage | null> {
    return (await this.getSessionMessages(sessionId)).at(-1) ?? null;
  }
  async getSessionRunSummary(sessionId: string): Promise<BridgeSessionRunSummary | null> {
    sessionId = await this.nativeSessionId(sessionId);
    return sessionId === this.state.sharedSessionId ? this.runSummary : null;
  }
  async getNewSessionModelState(): Promise<BridgeSessionModelState> {
    let catalog: BridgeSessionModelState;
    const id = this.state.sharedSessionId;
    if (id && this.socket && !this.socket.destroyed && this.ownerSessionConfirmed) catalog = await this.getSessionModelState(id);
    else {
      const owners = discoverPiOwners();
      const owner = selectPiOwner(owners, id, this.state.cwd);
      try {
        if (owner) {
          try { catalog = await readPiOwnerModels(owner); }
          catch { catalog = await readPiInstalledModels(this.options.command); }
        } else catalog = await readPiInstalledModels(this.options.command);
      }
      catch { return { options: [], canChange: false, unavailableReason: "暂时无法读取 Pi 模型，请确认电脑端已配置模型，或在原 Pi 窗口执行 /reload 后重试。" }; }
    }
    // Draft selection does not change the running task. It is applied only to
    // the newly created task before its first user message.
    return { ...catalog, canChange: catalog.options.length > 0,
      unavailableReason: catalog.options.length ? undefined : "Pi 当前没有可用的模型，请先在电脑端配置。" };
  }
  async getSessionModelState(sessionId: string): Promise<BridgeSessionModelState> {
    sessionId = await this.nativeSessionId(sessionId);
    if (sessionId !== this.state.sharedSessionId) {
      return { options: [], canChange: false, unavailableReason: "请先打开这条 Pi 任务再切换模型。" };
    }
    if (!this.socket || this.socket.destroyed || !this.ownerSessionConfirmed) {
      return { options: [], canChange: false, unavailableReason: "Pi 原窗口尚未连接；发送消息时会重新确认这条原任务。" };
    }
    let response: OwnerRecord;
    try {
      response = await this.request("model_state", sessionId);
    } catch (error) {
      if (!(error instanceof Error) || !/Unsupported Pi owner request/i.test(error.message)) throw error;
      return { options: [], canChange: false, unavailableReason: "请在 Pi 窗口执行 /reload，更新模型切换能力。" };
    }
    if (!response.modelState) throw new Error("Pi 当前窗口未提供模型列表，请在窗口执行 /reload 后重试。");
    return response.modelState;
  }
  async setSessionModel(sessionId: string, model: string): Promise<BridgeSessionModelState> {
    sessionId = await this.nativeSessionId(sessionId);
    if (sessionId !== this.state.sharedSessionId) throw new Error("请先打开这条 Pi 任务再切换模型。");
    await this.resumeSession(sessionId);
    const response = await this.request("set_model", sessionId, undefined, model);
    if (!response.modelState) throw new Error("Pi 未确认模型切换，请刷新模型列表。");
    return response.modelState;
  }
  async setSessionReasoningEffort(sessionId: string, effort: string): Promise<BridgeSessionModelState> {
    sessionId = await this.nativeSessionId(sessionId);
    if (sessionId !== this.state.sharedSessionId) throw new Error("请先打开这条 Pi 任务再调整推理强度。");
    await this.resumeSession(sessionId);
    const response = await this.request("set_reasoning", sessionId, undefined, effort);
    if (!response.modelState) throw new Error("Pi 未确认推理强度，请刷新设置。");
    return response.modelState;
  }
  async interrupt(): Promise<boolean> {
    const sessionId = this.state.sharedSessionId;
    if (!sessionId || this.state.status !== "busy") return false;
    await this.request("abort", sessionId);
    return true;
  }
  async interruptSession(sessionId: string): Promise<boolean> {
    sessionId = await this.nativeSessionId(sessionId);
    if (sessionId !== this.state.sharedSessionId) return false;
    return this.interrupt();
  }
  async reset(): Promise<void> { await this.createSession(); }
  async resolveApproval(): Promise<boolean> { return false; }
  async resolveAllApprovals(): Promise<number> { return 0; }
  async submitUserInput(): Promise<boolean> { return false; }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopOwner();
    this.status("stopped");
  }
  private async restartOwner(sessionPath?: string, projectCwd?: string): Promise<void> {
    this.restarting = true;
    try { await this.stopOwner(); await this.startOwner(sessionPath, projectCwd); }
    finally { this.restarting = false; }
  }
  private async nativeSessionId(sessionId: string): Promise<string> {
    if (!sessionId.startsWith("native-pi:")) return sessionId;
    const file = await findPiSessionFile(sessionId);
    if (!file) throw new Error("找不到 Pi Desktop 对应的原生任务，未创建替代任务。");
    return readPiNativeSessionId(file);
  }
  private async restartWithExternalOwner(owner: PiOwnerAdvertisement): Promise<void> {
    this.restarting = true;
    try { await this.stopOwner(); await this.attachOwner(owner); }
    finally { this.restarting = false; }
  }
  private async attachOwner(owner: PiOwnerAdvertisement): Promise<void> {
    this.status("starting", "正在连接已打开的 Pi 原窗口…");
    // Attaching is not acquiring a writer. A stale managed companion must not
    // prevent the daemon from connecting to an independently running owner.
    this.externalOwner = true;
    this.token = owner.token;
    this.ownerSessionConfirmed = false;
    const ready = new Promise<string>((resolve, reject) => { this.ready = resolve; this.readyFailure = reject; });
    try {
      const socket = net.createConnection(owner.socket);
      socket.once("error", (error) => this.readyFailure?.(error));
      socket.once("connect", () => {
        this.acceptSocket(socket);
        socket.write(`${JSON.stringify({ type: "hello", token: owner.token })}\n`);
      });
      const timer = setTimeout(() => this.readyFailure?.(new Error("Pi 原窗口连接超时。")), 5_000);
      timer.unref();
      const sessionId = await ready.finally(() => clearTimeout(timer));
      if (sessionId !== owner.sessionId) throw new Error("Pi 原窗口已切换任务，请刷新后重试。");
      this.state.sharedSessionId = sessionId;
      this.state.activeRuntimeSessionId = sessionId;
      this.state.cwd = owner.cwd;
      this.state.pid = owner.pid;
      this.state.startedAt = nowIso();
      this.ownerSessionConfirmed = true;
      this.status(this.runSummary?.status === "running" ? "busy" : "idle");
    } catch (error) { await this.stopOwner(); throw error; }
    finally { this.ready = this.readyFailure = null; }
  }
  private async startOwner(sessionPath?: string, projectCwd?: string): Promise<void> {
    // Desktop has its own native writer lease. Never overwrite/delete it or
    // open a TUI writer on that same file merely because CLI discovery is empty.
    if (sessionPath && fs.existsSync(`${sessionPath}.pi-desktop.lock`)) {
      throw new Error("该 Pi 原任务由 Pi Desktop 持有，请在桌面端继续；未启动第二个写者。");
    }
    const cwd = sessionPath ? await readPiSessionProject(sessionPath) : projectCwd ?? this.options.cwd;
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("Pi 原项目目录不可用，未在其他位置打开任务。");
    this.status("starting", "正在连接 Pi 本地会话…");
    this.ownerSessionConfirmed = false;
    const cliArgs = validatePiCliArgs(this.options.extraCliArgs ?? []);
    assertNoIndependentPiOwner(cwd, Boolean(sessionPath));
    this.releaseOwnerLock ??= acquirePiOwnerLock();
    this.externalOwner = false;
    try {
      this.token = randomBytes(32).toString("hex");
      this.socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pi-"));
      if (process.platform !== "win32") fs.chmodSync(this.socketDir, 0o700);
      this.socketPath = process.platform === "win32"
        ? `\\\\.\\pipe\\wr-pi-${randomUUID()}` : path.join(this.socketDir, "owner.sock");
      this.server = net.createServer((socket) => this.acceptSocket(socket));
      await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(this.socketPath, resolve));
      if (process.platform !== "win32") fs.chmodSync(this.socketPath, 0o600);
      const env = { ...buildCliEnvironment("pi"), WERELAY_PI_OWNER_SOCKET: this.socketPath, WERELAY_PI_OWNER_TOKEN: this.token };
      const target = resolveSpawnTarget(this.options.command, "pi", { env });
      const ready = new Promise<string>((resolve, reject) => {
        this.ready = resolve;
        this.readyFailure = reject;
      });
      const globalExtension = path.join(os.homedir(), ".pi", "agent", "extensions", "werelay-owner.js");
      const alreadyGlobal = (() => { try { return fs.realpathSync(globalExtension) === fs.realpathSync(EXTENSION_PATH); } catch { return false; } })();
      const child = spawn(target.file, [...target.args, ...cliArgs, ...(alreadyGlobal ? [] : ["--extension", EXTENSION_PATH]), ...(sessionPath ? ["--session", sessionPath] : [])], {
        cwd, env, stdio: "inherit", windowsHide: false,
      });
      this.child = child;
      this.state.pid = child.pid;
      this.state.startedAt = nowIso();
      child.once("error", (error) => this.readyFailure?.(error));
      child.once("exit", (code) => {
        this.child = null;
        this.state.pid = undefined;
        this.readyFailure?.(new Error(`Pi 已退出（${code ?? "未知"}）。`));
        if (!this.disposed && !this.restarting) {
          void this.stopOwner();
          this.status("stopped");
          this.emit({ type: "shutdown_requested", reason: "companion_closed", message: "Pi 本地会话已关闭。", timestamp: nowIso() });
        }
      });
      try {
        const id = await Promise.race([ready, new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Pi 本地界面未完成连接。")), 60_000);
          timer.unref();
          ready.finally(() => clearTimeout(timer)).catch(() => undefined);
        })]);
        this.state.sharedSessionId = id;
        this.state.activeRuntimeSessionId = id;
        this.state.cwd = cwd;
        this.ownerSessionConfirmed = true;
        this.status("idle");
      } finally { this.ready = this.readyFailure = null; }
    } catch (error) { await this.stopOwner(); throw error; }
  }
  private async stopOwner(): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Pi 会话连接已关闭。"));
      this.pending.delete(id);
    }
    this.ownerSessionConfirmed = false;
    this.runSummary = null;
    this.socket?.destroy(); this.socket = null;
    this.server?.close(); this.server = null;
    const child = this.child; this.child = null;
    this.state.pid = undefined;
    this.externalOwner = false;
    if (child?.pid && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
        timer.unref();
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
    if (this.socketDir) { fs.rmSync(this.socketDir, { recursive: true, force: true }); this.socketDir = ""; }
    this.releaseOwnerLock?.(); this.releaseOwnerLock = null;
  }
  private acceptSocket(socket: net.Socket): void {
    if (this.socket) { socket.destroy(); return; }
    this.socket = socket;
    this.buffer = "";
    socket.on("data", (data) => {
      this.buffer += data.toString("utf8");
      if (this.buffer.length > 256 * 1024) { socket.destroy(); return; }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try { this.handleRecord(JSON.parse(line) as OwnerRecord); } catch { socket.destroy(); return; }
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.disposed && !this.restarting && this.externalOwner) {
        this.ownerSessionConfirmed = false;
        this.runSummary = null;
        if (this.options.renderMode === "companion") {
          this.status("stopped", "Pi 原窗口连接已断开。");
          this.emit({ type: "shutdown_requested", reason: "companion_closed", message: "Pi 原窗口连接已断开。", timestamp: nowIso() });
        } else {
          // The catalog remains readable after owner reload/quit. The next
          // exact-task action discovers a fresh authenticated advertisement.
          this.state.pid = undefined;
          this.status("idle", "Pi 原窗口连接已断开；列表仍可读取，下次发送时重新确认原任务。");
        }
      }
    });
  }
  private handleRecord(record: OwnerRecord): void {
    if (record.token !== this.token) { this.socket?.destroy(); return; }
    if (record.type === "ready" && record.sessionId) {
      this.runSummary = record.run ?? null;
      this.ready?.(record.sessionId); return;
    }
    if (record.type === "response" && record.id) {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id); clearTimeout(pending.timer);
      if (record.ok) pending.resolve(record);
      else pending.reject(new Error(record.error || "Pi 未接受请求。"));
      return;
    }
    if (record.type === "session" && record.sessionId) {
      this.ownerSessionConfirmed = true;
      this.runSummary = null;
    }
    if (record.sessionId && record.sessionId !== this.state.sharedSessionId) {
      this.runSummary = record.run ?? null;
      this.state.sharedSessionId = record.sessionId;
      this.state.activeRuntimeSessionId = record.sessionId;
      this.emit({ type: "session_switched", sessionId: record.sessionId, source: "local", reason: "local_session_fallback", timestamp: nowIso() });
    }
    if (record.type === "agent_start") {
      this.lastReply = ""; this.lastError = "";
      this.runSummary = record.run ?? { status: "running", startedAtMs: Date.now() };
      this.status("busy");
    }
    if (record.type === "assistant" && record.text) this.lastReply = record.text;
    if (record.type === "assistant_error") this.lastError = formatPiModelError(record.error);
    if (record.type === "settled") {
      const startedAtMs = this.runSummary?.startedAtMs ?? Date.now();
      this.runSummary = record.run ?? {
        status: record.outcome === "aborted" ? "interrupted" : record.outcome === "error" ? "failed" : "completed",
        startedAtMs, completedAtMs: Date.now(),
      };
      this.settledRevision++;
      const id = this.state.sharedSessionId;
      const origin = this.activeOrigin;
      const outcome = record.outcome === "aborted" ? "interrupted" : record.outcome === "error" ? "failed" : "completed";
      if (outcome === "failed") {
        this.emit({ type: "task_failed", message: this.lastError || formatPiModelError(undefined), threadId: id, origin, timestamp: nowIso() });
      } else if (this.lastReply) {
        this.emit({ type: "final_reply", text: this.lastReply, threadId: id, origin, timestamp: nowIso() });
      }
      this.emit({ type: "task_complete", summary: truncatePreview(outcome === "failed" ? this.lastError || formatPiModelError(undefined) : this.lastReply || "Pi 任务已结束", 240), threadId: id, origin, outcome, timestamp: nowIso() });
      this.lastReply = ""; this.lastError = ""; this.activeOrigin = "local"; this.status("idle");
    }
  }
  private async request(type: "prompt" | "abort" | "can_switch" | "model_state" | "set_model" | "set_reasoning" | "new_session", sessionId: string, text?: string, model?: string): Promise<OwnerRecord> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Pi 本地 owner 未连接，未另建任务。");
    const id = randomUUID();
    return await new Promise<OwnerRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(type === "set_model"
          ? "Pi 模型切换结果暂未确认，请刷新模型列表，避免重复操作。"
          : "Pi 未确认收到消息，请先检查原任务以免重复发送。"));
      }, (type === "set_model" || type === "new_session") ? 30_000 : 10_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ id, token: this.token, type, sessionId, text, model })}\n`);
    });
  }
}

import path from "node:path";
import type { AdapterOptions, EventSink } from "./bridge-adapters.shared.ts";
import type { BridgeAdapter, BridgeAdapterState, BridgeResumeSessionCandidate, BridgeSessionMessage, BridgeSessionSendResult, BridgeSessionRunSummary, BridgeSessionMessagePage, BridgeSessionMessagePageOptions } from "./bridge-types.ts";
import { PiDesktopClient, PiDesktopUncertainError, type PiDesktopControl } from "./pi-desktop-client.ts";
import { nowIso } from "./bridge-utils.ts";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
function desktopSession(value: unknown): RecordValue | null {
  const session = object(value);
  const id = string(session.id);
  // Native Pi and remote-host sessions may also appear in Desktop's catalog.
  // They are not this provider's local Desktop owner.
  if (!id || id.includes(":") || (session.source !== undefined && session.source !== "desktop")) return null;
  return session;
}
function assertId(id: string): void {
  if (!id.trim() || id.length > 256 || (id.includes(":") || [...id].some((char) => char.charCodeAt(0) < 32))) throw new Error("请从 Pi Desktop 任务列表选择本机桌面任务；Pi Agent 任务请使用 /pi。");
}
const catalogClient = new PiDesktopClient();
export async function listPiDesktopSessions(limit = 100, client: PiDesktopControl = catalogClient): Promise<BridgeResumeSessionCandidate[]> {
  const result = object(await client.invoke("session/list"));
  if (!Array.isArray(result.sessions)) throw new Error("Pi Desktop 任务列表格式不受支持。");
  return result.sessions.flatMap((raw): BridgeResumeSessionCandidate[] => {
    const session = desktopSession(raw); if (!session) return [];
    const cwd = string(session.projectPath);
    const status = session.status;
    return [{ sessionId: string(session.id), threadId: string(session.id), title: string(session.title) || "Pi Desktop 任务",
      lastUpdatedAt: string(session.updatedAt) || string(session.createdAt), cwd: cwd || undefined,
      projectId: cwd || undefined, projectName: cwd ? path.basename(cwd) : undefined,
      runtimeStatus: status === "running" || status === "waiting_permission" || status === "waiting_input"
        ? { type: "active", activeFlags: status === "waiting_permission" ? ["waitingOnApproval"] : status === "waiting_input" ? ["waitingOnUserInput"] : [] }
        : { type: "notLoaded" },
    }];
  }).sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt)).slice(0, Math.max(0, limit));
}

/** Authenticated client of the existing Desktop main process. Never starts a CLI or opens a window. */
export class PiDesktopAdapter implements BridgeAdapter {
  private readonly client: PiDesktopControl;
  private state: BridgeAdapterState;
  private sink: EventSink = () => undefined;
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private polling = false;
  private readonly watched = new Map<string, { before: Set<string>; turnId?: string; interrupted: boolean; sending: boolean; messageBoundary?: number }>();
  constructor(options: AdapterOptions, private readonly dependencies: { client?: PiDesktopControl; pollIntervalMs?: number } = {}) {
    this.client = dependencies.client ?? new PiDesktopClient();
    this.state = { kind: "pi-desktop", command: options.command, cwd: options.cwd, status: "stopped",
      sharedSessionId: options.initialSharedSessionId, activeRuntimeSessionId: options.initialSharedSessionId };
  }
  setEventSink(sink: EventSink): void { this.sink = sink; }
  getState(): BridgeAdapterState { return { ...this.state }; }
  private status(status: BridgeAdapterState["status"], message?: string): void {
    this.state.status = status; this.sink({ type: "status", status, message, timestamp: nowIso() });
  }
  async start(): Promise<void> {
    await this.client.invoke("app/health");
    this.disposed = false; this.status("idle");
    const interval = this.dependencies.pollIntervalMs ?? 2_000;
    if (interval > 0 && !this.timer) { this.timer = setInterval(() => { void this.poll(); }, interval); this.timer.unref(); }
  }
  listResumeSessions(limit = 100): Promise<BridgeResumeSessionCandidate[]> { return listPiDesktopSessions(limit, this.client); }
  private async read(id: string, page: { messageBefore?: number; messageLimit?: number } = {}): Promise<RecordValue> {
    assertId(id);
    const result = object(await this.client.invoke("session/get", [{ id, messageLimit: 40, contentLimit: 8_000, ...page }]));
    const session = desktopSession(result.session);
    if (!session || session.id !== id) throw new Error("Pi Desktop 原任务不存在或不可用，未创建替代任务。");
    return { ...result, session };
  }
  async resumeSession(id: string): Promise<void> {
    const result = await this.read(id);
    this.state.sharedSessionId = id; this.state.activeRuntimeSessionId = id;
    this.state.cwd = string(object(result.session).projectPath) || this.state.cwd;
    // Read-only selection: no session/open, project/set or GUI activation.
  }
  private messages(result: RecordValue): BridgeSessionMessage[] {
    const messages = object(result.session).messages;
    if (!Array.isArray(messages)) throw new Error("Pi Desktop 消息格式不受支持。");
    return messages.flatMap((raw): BridgeSessionMessage[] => {
      const message = object(raw);
      if (message.role !== "user" && message.role !== "assistant") return [];
      const content = message.content;
      const text = typeof content === "string" ? content : Array.isArray(content)
        ? content.map((part) => object(part).type === "text" ? string(object(part).text) : "").join("\n") : "";
      return [{ id: string(message.id) || undefined, role: message.role, text, turnId: string(message.turnId) || undefined,
        createdAtMs: Date.parse(string(message.createdAt)) || undefined,
        phase: message.role === "assistant" && message.status === "complete" ? "final_answer" : "commentary" }];
    });
  }
  async getSessionMessages(id: string): Promise<BridgeSessionMessage[]> { return this.messages(await this.read(id)); }
  async getSessionMessagePage(id: string, options: BridgeSessionMessagePageOptions = {}): Promise<BridgeSessionMessagePage> {
    let messageBefore: number | undefined;
    if (options.before != null) {
      if (!/^\d+$/.test(options.before) || !Number.isSafeInteger(Number(options.before))) throw new Error("Pi Desktop 历史游标无效。");
      messageBefore = Number(options.before);
    }
    const limit = Math.min(40, Math.max(1, Math.trunc(options.limit || 40)));
    const result = await this.read(id, { messageLimit: limit, ...(messageBefore !== undefined ? { messageBefore } : {}) });
    const session = object(result.session);
    const hasMore = session.hasMoreBefore === true;
    const start = session.messageStart;
    if (hasMore && (typeof start !== "number" || !Number.isSafeInteger(start) || start <= 0)) {
      throw new Error("Pi Desktop 未提供可靠的历史游标，请在桌面查看更早消息。");
    }
    return { messages: this.messages(result), hasMore, nextBefore: hasMore ? String(start) : null, source: "native" };
  }
  async getLatestSessionMessage(id: string): Promise<BridgeSessionMessage | null> {
    return (await this.getSessionMessages(id)).filter((message) => message.role === "assistant").at(-1) ?? null;
  }
  async sendInput(text: string): Promise<void> {
    if (!this.state.sharedSessionId) throw new Error("请先选择 Pi Desktop 任务。");
    await this.sendInputToSession(this.state.sharedSessionId, text);
  }
  async sendInputToSession(id: string, text: string): Promise<BridgeSessionSendResult> {
    if (this.disposed) throw new Error("Pi Desktop 连接已关闭。");
    assertId(id);
    if (!text.trim()) throw new Error("消息不能为空。");
    if (this.watched.has(id)) throw new Error("Pi Desktop 上一条消息尚未结束或确认，请检查原任务；未重复发送。");
    const watch = { before: new Set<string>(), turnId: undefined as string | undefined, interrupted: false, sending: true, messageBoundary: undefined as number | undefined };
    this.watched.set(id, watch);
    try {
      const snapshot = await this.read(id);
      watch.before = new Set(this.messages(snapshot).flatMap((message) => message.id ? [message.id] : []));
      const native = object(snapshot.session);
      if (Number.isSafeInteger(native.messageStart) && Number(native.messageStart) >= 0 && Array.isArray(native.messages)) {
        watch.messageBoundary = Number(native.messageStart) + native.messages.length;
      }
      const status = object(await this.client.invoke("agent/getStatus", [id]));
      if (status.isRunning !== false) throw new Error("Pi Desktop 原任务正在处理或状态未确认，请稍后再发送。");
    } catch (error) { this.watched.delete(id); throw error; }
    // Keep the watch on ambiguous timeouts. Never replay an unconfirmed write.
    let result: RecordValue;
    try { result = object(await this.client.invoke("agent/prompt", [{ sessionId: id, content: text }])); }
    catch (error) { if (!(error instanceof PiDesktopUncertainError)) this.watched.delete(id); throw error; }
    finally { watch.sending = false; }
    watch.turnId = string(result.turnId) || undefined;
    if (!watch.turnId) throw new PiDesktopUncertainError("Pi Desktop 未确认运行轮次，请检查原任务，未自动重试。");
    this.state.sharedSessionId = id; this.state.activeRuntimeSessionId = id;
    this.state.lastInputAt = nowIso(); this.state.activeTurnId = watch.turnId;
    this.status("busy");
    return { turnId: watch.turnId, queued: false };
  }
  async getSessionRunSummary(id: string): Promise<BridgeSessionRunSummary> {
    assertId(id);
    const status = object(await this.client.invoke("agent/getStatus", [id]));
    return { turnId: string(status.turnId) || undefined, status: status.isRunning === true ? "running" : "unknown" };
  }
  async poll(): Promise<void> {
    if (this.disposed || this.polling) return;
    this.polling = true;
    try {
      for (const [id, watch] of this.watched) {
        if (watch.sending) continue;
        const status = object(await this.client.invoke("agent/getStatus", [id]));
        if (this.disposed) return;
        if (status.isRunning === true) {
          if (id === this.state.sharedSessionId) this.status(Number(status.pendingToolConfirmations) > 0 ? "awaiting_approval" : "busy",
            Number(status.pendingToolConfirmations) > 0 ? "请在 Pi Desktop 原窗口处理审批。" : undefined);
          continue;
        }
        if (status.isRunning !== false) continue; // unknown is not completion
        const snapshot = await this.read(id);
        const native = object(snapshot.session);
        let messages = this.messages(snapshot);
        if (watch.messageBoundary !== undefined && Number.isSafeInteger(native.messageStart) && Array.isArray(native.messages)) {
          const offset = Math.max(0, watch.messageBoundary - Number(native.messageStart));
          messages = this.messages({ session: { ...native, messages: native.messages.slice(offset) } });
        }
        if (this.disposed) return;
        const newUserIndex = messages.findLastIndex((message) => message.role === "user" && message.id && !watch.before.has(message.id));
        const afterUser = newUserIndex >= 0 ? messages.slice(newUserIndex + 1)
          : watch.messageBoundary !== undefined && Number.isSafeInteger(native.messageStart) ? messages
          : messages.filter((message) => watch.turnId && message.turnId === watch.turnId);
        const reply = afterUser.filter((message) => message.role === "assistant" && message.id && !watch.before.has(message.id) && message.phase === "final_answer" &&
          (!watch.turnId || !message.turnId || message.turnId === watch.turnId)).at(-1);
        if (!reply && !watch.interrupted) continue;
        this.watched.delete(id);
        if (id === this.state.sharedSessionId) this.status("idle");
        if (reply && !watch.interrupted) this.sink({ type: "final_reply", text: reply.text, messageId: reply.id, threadId: id,
          turnId: reply.turnId ?? watch.turnId, origin: "wechat", timestamp: nowIso() });
      }
    } catch {
      // Preserve original target and pending sends; do not restart Desktop or silently fall back.
      if (!this.disposed) this.status("error", "Pi Desktop 状态暂时无法读取；未重启应用，请检查桌面端。");
    } finally { this.polling = false; }
  }
  async renameSession(id: string, title: string): Promise<void> {
    await this.read(id); if (!title.trim()) throw new Error("任务名不能为空。");
    await this.client.invoke("session/rename", [id, title.trim()]);
  }
  private async create(projectPath: string): Promise<void> {
    const result = object(await this.client.invoke("session/create", [{ projectPath }]));
    const session = desktopSession(result.session);
    if (!session) throw new Error("Pi Desktop 未确认新任务，未自动重试。");
    await this.resumeSession(string(session.id));
  }
  async createSession(): Promise<void> { await this.create(this.state.cwd); }
  async createSessionInProject(id: string): Promise<void> {
    const result = await this.read(id); const project = string(object(result.session).projectPath);
    if (!project) throw new Error("原任务没有本机项目目录，请在 Pi Desktop 新建任务。");
    await this.create(project);
  }
  async interruptSession(id: string): Promise<boolean> {
    await this.read(id);
    const result = object(await this.client.invoke("agent/abort", [{ sessionId: id }]));
    if (result.ok === false) return false;
    const watch = this.watched.get(id); if (watch) watch.interrupted = true;
    return true;
  }
  async interrupt(): Promise<boolean> { return this.state.sharedSessionId ? this.interruptSession(this.state.sharedSessionId) : false; }
  async reset(): Promise<void> { throw new Error("请明确新建或选择 Pi Desktop 任务；不会自动替换原任务。"); }
  async resolveApproval(_action: "confirm" | "deny"): Promise<boolean> { throw new Error("当前 Pi Desktop 控制接口不提供完整的待审批读取，请在桌面原窗口审批。"); }
  async resolveAllApprovals(_action: "confirm" | "deny"): Promise<number> { throw new Error("请在 Pi Desktop 原窗口审批，WeRelay 不会自动放行。"); }
  async submitUserInput(_answers: Record<string, string[]>): Promise<boolean> { throw new Error("请在 Pi Desktop 原窗口回答待输入问题。"); }
  async dispose(): Promise<void> {
    this.disposed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.watched.clear(); this.state.status = "stopped";
  }
}

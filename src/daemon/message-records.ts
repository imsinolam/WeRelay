import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ensureWorkspaceChannelDir } from "../wechat/channel-config.ts";
import { appendPrivateFile, writePrivateFileAtomic } from "../utils/private-files.ts";

export const MESSAGE_RECORD_STATUSES = ["received", "accepted", "sending", "retrying", "queued", "submitted", "unconfirmed", "failed", "delivered", "cancelled", "handled"] as const;
export type MessageRecordStatus = typeof MESSAGE_RECORD_STATUSES[number];
export const MESSAGE_RECORD_STATUS_GROUPS: Record<string, readonly MessageRecordStatus[]> = {
  active: ["received", "accepted", "sending", "retrying", "queued"],
  sent: ["submitted", "delivered"],
  attention: ["unconfirmed", "failed"],
  closed: ["cancelled", "handled"],
};
export type MessageRecordPolicy = { enabled: boolean; textMode: "none" | "summary" | "body"; retentionDays: number; maxRecords: number };
export type MessageRecordProject = { key: string; label: string };
export function messageRecordProject(adapter: string, candidate?: { projectId?: string; projectName?: string; cwd?: string }): MessageRecordProject | undefined {
  const cwd = candidate?.cwd?.trim().replace(/\\/g, "/").replace(/\/+$/, "") || (candidate?.cwd === "/" ? "/" : "");
  const id = candidate?.projectId?.trim();
  if (!cwd && !id) return undefined;
  const identity = cwd ? ["cwd", cwd] : ["id", adapter, id];
  return { key: "project-" + createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32),
    label: redactMessageRecordText(candidate?.projectName?.trim() || cwd.split("/").filter(Boolean).at(-1) || "未命名项目", 120) };
}
export type MessageRecordInput = {
  key: string; source: "web" | "clawbot"; adapter: string; threadId: string; text: string;
  status: MessageRecordStatus; attempts: number; imageCount?: number; createdAtMs?: number;
  error?: string; turnId?: string; kind?: "task" | "control"; historical?: boolean; failureNotified?: boolean;
};
type RecordEvent = { atMs: number; status: MessageRecordStatus; attempts: number; error?: string };
export type MessageRecord = {
  id: string; source: "web" | "clawbot"; adapter: string; threadId: string; preview: string; body?: string;
  status: MessageRecordStatus; attempts: number; imageCount: number; createdAtMs: number; updatedAtMs: number;
  kind: "task" | "control"; historical: boolean; turnId?: string; error?: string; failureNotified: boolean;
  events: RecordEvent[]; omittedEvents: number;
  taskState?: "running" | "approval" | "input" | "error" | "idle" | "unknown";
  taskTitle?: string;
  projectKey?: string;
  projectName?: string;
};
type HistoryEntry = { clientId: string; adapter: string; threadId: string; text: string; images: unknown[]; createdAtMs: number; status: MessageRecordStatus; attempts: number; lastError?: string; turnId?: string; failureNotifiedAt?: number };
type Query = { source?: string; adapter?: string; project?: string; status?: string; statusGroup?: string; kind?: string; from?: string; to?: string; search?: string; offset?: number; limit?: number };
const MAX_BYTES = 8 * 1024 * 1024;
const DAY = 86400_000;
const DEFAULT_POLICY: MessageRecordPolicy = { enabled: true, textMode: "summary", retentionDays: 30, maxRecords: 5000 };

/** Best-effort redaction, not a guarantee that arbitrary user prose is secret-free. */
export function redactMessageRecordText(value: string, limit = 4000): string {
  return value.replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "Bearer [已隐藏]")
    .replace(/((?:token|pass(?:word|wd)|secret|api[_-]?key|authorization|access[_-]?key)\s*[=:]\s*["']?)[^\s&"'<>]+/gi, "$1[已隐藏]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[已隐藏]@")
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}/g, "[已隐藏]").slice(0, limit);
}

export function clawbotMessageRecordKey(message: { senderId: string; sessionId: string; createdAt: string; createdAtMs?: number; text: string; attachments: unknown[] }): string {
  return createHash("sha256").update(JSON.stringify([message.senderId, message.sessionId, message.createdAtMs ?? message.createdAt, message.text, message.attachments])).digest("hex");
}

export class MessageRecords {
  private readonly stateFile: string;
  private readonly now: () => number;
  private policy: MessageRecordPolicy = { ...DEFAULT_POLICY };
  private rows = new Map<string, MessageRecord>();
  private startedAtMs: number;
  private historyImported = false;
  private captureFromMs = 0;
  private textFromMs = 0;
  private warning = "";
  private bytes = 0;
  private writes = 0;
  private readonly resolveProject?: (adapter: string, threadId: string) => MessageRecordProject | undefined;

  constructor(options: { cwd?: string; stateFile?: string; now?: () => number; resolveProject?: (adapter: string, threadId: string) => MessageRecordProject | undefined }) {
    this.resolveProject = options.resolveProject;
    this.stateFile = options.stateFile ?? path.join(ensureWorkspaceChannelDir(options.cwd ?? process.cwd()).workspaceDir, "message-records.jsonl");
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
    if (!fs.existsSync(this.stateFile)) return;
    try {
      const stat = fs.statSync(this.stateFile);
      if (stat.size > MAX_BYTES * 2) throw new Error("记录文件超过读取上限");
      this.bytes = stat.size;
      for (const line of fs.readFileSync(this.stateFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.type === "meta") {
            this.policy = this.validatePolicy(data.policy);
            this.startedAtMs = Number(data.startedAtMs) || this.startedAtMs;
            this.historyImported = data.historyImported === true;
            this.captureFromMs = Number(data.captureFromMs) || 0;
            this.textFromMs = Number(data.textFromMs) || 0;
          } else if (data.type === "record" && this.validRow(data.row)) {
            this.rows.set(data.row.id, data.row);
          } else throw new Error("记录格式无效");
        } catch { this.warning = "部分记录文件损坏，已保留原文件；当前显示可读取的记录，暂不写入新记录。"; }
      }
    } catch { this.warning = "消息记录暂时无法读取，原文件未改动；请检查电脑上的文件权限或磁盘空间。"; }
  }

  private validRow(row: MessageRecord): boolean {
    return Boolean(row && typeof row.id === "string" && ["web", "clawbot"].includes(row.source) &&
      MESSAGE_RECORD_STATUSES.includes(row.status) && typeof row.preview === "string" &&
      typeof row.adapter === "string" && typeof row.threadId === "string" &&
      Number.isFinite(row.createdAtMs) && Number.isFinite(row.updatedAtMs) &&
      Array.isArray(row.events) && row.events.length <= 40);
  }

  private projectFor(adapter: string, threadId: string): MessageRecordProject | undefined {
    try { return this.resolveProject?.(adapter, threadId); } catch { return undefined; }
  }

  private validatePolicy(patch: Partial<MessageRecordPolicy>): MessageRecordPolicy {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("记录设置无效。");
    const policy = { ...this.policy, ...patch };
    if (typeof policy.enabled !== "boolean" || !["none", "summary", "body"].includes(policy.textMode) ||
      ![7, 30, 90].includes(policy.retentionDays) || ![500, 2000, 5000].includes(policy.maxRecords)) throw new Error("请选择有效的记录保留范围。");
    return { enabled: policy.enabled, textMode: policy.textMode, retentionDays: policy.retentionDays, maxRecords: policy.maxRecords };
  }

  record(input: MessageRecordInput): void {
    if (!this.policy.enabled || this.warning) return;
    try {
      const id = createHash("sha256").update(input.source + ":" + input.key).digest("hex").slice(0, 32);
      const previous = this.rows.get(id);
      const now = this.now();
      const createdAtMs = previous?.createdAtMs ?? Math.min(now, input.createdAtMs ?? now);
      if (!previous && createdAtMs < this.captureFromMs) return;
      if (createdAtMs < now - this.policy.retentionDays * DAY) return;
      const mayCaptureText = this.policy.textMode !== "none" && createdAtMs >= this.textFromMs;
      const cleanText = mayCaptureText ? redactMessageRecordText(input.text) : previous?.preview ?? "";
      const error = this.policy.textMode === "none" ? undefined : input.error && mayCaptureText ? redactMessageRecordText(input.error, 300) : previous?.error;
      const attempts = Math.max(previous?.attempts ?? 0, input.attempts);
      const project = this.projectFor(input.adapter, input.threadId);
      const row: MessageRecord = {
        id, source: input.source, adapter: input.adapter, threadId: input.threadId, preview: cleanText.slice(0, 160),
        ...(this.policy.textMode === "body" && (mayCaptureText || previous?.body) ? { body: mayCaptureText ? cleanText : previous?.body } : {}),
        createdAtMs, updatedAtMs: now, status: input.status, attempts, imageCount: input.imageCount ?? 0,
        kind: input.kind ?? previous?.kind ?? "task", historical: previous?.historical ?? input.historical === true,
        ...(input.turnId || previous?.turnId ? { turnId: input.turnId ?? previous?.turnId } : {}),
        ...(error ? { error } : {}), failureNotified: input.failureNotified ?? previous?.failureNotified ?? false,
        events: previous?.events.slice() ?? [], omittedEvents: previous?.omittedEvents ?? 0,
        ...(project ? { projectKey: project.key, projectName: project.label } : previous?.threadId === input.threadId && previous.projectKey
          ? { projectKey: previous.projectKey, projectName: previous.projectName } : {}),
      };
      if (previous && JSON.stringify({ ...previous, events: [], updatedAtMs: 0 }) === JSON.stringify({ ...row, events: [], updatedAtMs: 0 })) return;
      row.events.push({ atMs: now, status: input.status, attempts, ...(input.error && error ? { error } : {}) });
      if (row.events.length > 40) { row.events.shift(); row.omittedEvents++; }
      this.rows.set(id, row);
      if (!this.bytes) this.compact();
      else {
        const line = JSON.stringify({ type: "record", row }) + "\n";
        appendPrivateFile(this.stateFile, line, { encoding: "utf8" });
        this.bytes += Buffer.byteLength(line); this.writes++;
        if (this.bytes >= MAX_BYTES || this.rows.size > this.policy.maxRecords || this.writes >= 200) this.compact();
      }
    } catch { this.warning = "消息已继续发送，但消息记录保存失败；请检查电脑磁盘和文件权限。"; }
  }

  configure(patch: Partial<MessageRecordPolicy>): ReturnType<MessageRecords["query"]> {
    if (this.warning) throw new Error(this.warning);
    const nextPolicy = this.validatePolicy(patch);
    const previous = { policy: this.policy, captureFromMs: this.captureFromMs, textFromMs: this.textFromMs, rows: structuredClone(this.rows) };
    if (!this.policy.enabled && nextPolicy.enabled) this.captureFromMs = this.now();
    if (["none", "summary", "body"].indexOf(nextPolicy.textMode) > ["none", "summary", "body"].indexOf(this.policy.textMode)) this.textFromMs = this.now();
    this.policy = nextPolicy;
    for (const row of this.rows.values()) {
      if (this.policy.textMode !== "body") delete row.body;
      if (this.policy.textMode === "none") {
        row.preview = ""; delete row.error;
        row.events.forEach(event => { delete event.error; });
      }
    }
    try { this.compact(); } catch {
      Object.assign(this, previous);
      throw new Error("记录设置未保存，请检查电脑磁盘和文件权限后重试。");
    }
    return this.query({});
  }

  clear(): ReturnType<MessageRecords["query"]> {
    if (this.warning) throw new Error(this.warning);
    const previous = { rows: this.rows, historyImported: this.historyImported, startedAtMs: this.startedAtMs, captureFromMs: this.captureFromMs };
    this.rows = new Map(); this.historyImported = true; this.startedAtMs = this.now(); this.captureFromMs = this.now();
    try { this.compact(); } catch {
      Object.assign(this, previous);
      throw new Error("消息记录未清空，请检查电脑磁盘和文件权限后重试。");
    }
    return this.query({});
  }

  importWebHistory(entries: HistoryEntry[]): number {
    if (this.historyImported || this.warning) return 0;
    this.historyImported = true;
    const before = this.rows.size;
    for (const entry of entries) this.recordWeb(entry, true);
    try { this.compact(); } catch { this.warning = "历史消息记录保存失败，原待发送箱不受影响。"; }
    return this.rows.size - before;
  }

  recordWeb(entry: HistoryEntry, historical = false): void {
    this.record({ key: entry.adapter + ":" + entry.clientId, source: "web", adapter: entry.adapter,
      threadId: entry.threadId, text: entry.text, imageCount: entry.images.length, createdAtMs: entry.createdAtMs,
      status: entry.status, attempts: entry.attempts, error: entry.lastError, turnId: entry.turnId,
      failureNotified: Boolean(entry.failureNotifiedAt), historical });
  }

  confirmClawbotReceipts(adapter: string, threadId: string, messages: Array<{ role?: string; turnId?: string; createdAtMs?: number; text: string }>): void {
    if (!this.policy.enabled || this.warning) return;
    let changed = false;
    for (const row of this.rows.values()) {
      if (row.source !== "clawbot" || row.adapter !== adapter || row.threadId !== threadId ||
        !row.turnId || !["submitted", "queued"].includes(row.status)) continue;
      if (!messages.some(message => message.role === "user" && message.turnId === row.turnId &&
        message.createdAtMs !== undefined && message.createdAtMs >= row.createdAtMs && row.preview &&
        redactMessageRecordText(message.text).includes(row.preview))) continue;
      row.status = "delivered"; row.updatedAtMs = this.now();
      row.events.push({ atMs: this.now(), status: "delivered", attempts: row.attempts });
      if (row.events.length > 40) { row.events.shift(); row.omittedEvents++; }
      changed = true;
    }
    if (changed) try { this.compact(); } catch { this.warning = "收件回执记录保存失败，请检查磁盘和文件权限。"; }
  }

  get(source: "web" | "clawbot", key: string): MessageRecord | undefined {
    const id = createHash("sha256").update(source + ":" + key).digest("hex").slice(0, 32);
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }

  query(query: Query) {
    if (query.source && !["web", "clawbot"].includes(query.source) ||
      query.status && !MESSAGE_RECORD_STATUSES.includes(query.status as MessageRecordStatus) ||
      query.statusGroup && !Object.hasOwn(MESSAGE_RECORD_STATUS_GROUPS, query.statusGroup) ||
      query.kind && !["task", "control"].includes(query.kind)) throw new Error("记录筛选条件无效。");
    const time = (value?: string) => { if (!value) return undefined; const n = Date.parse(value); if (!Number.isFinite(n)) throw new Error("时间范围无效。"); return n; };
    const from = time(query.from), to = time(query.to);
    if (from !== undefined && to !== undefined && from > to) throw new Error("开始时间不能晚于结束时间。");
    const now = this.now();
    let projectChanged = false;
    const retained = [...this.rows.values()].filter(row => row.createdAtMs >= now - this.policy.retentionDays * DAY).map(row => {
      const project = this.projectFor(row.adapter, row.threadId);
      if (project && (row.projectKey !== project.key || row.projectName !== project.label)) {
        row.projectKey = project.key; row.projectName = project.label; projectChanged = true;
      }
      return row;
    });
    if (projectChanged && this.policy.enabled && !this.warning) {
      try { this.compact(); } catch { this.warning = "项目归属暂未保存，当前记录仍可查看；请检查磁盘和文件权限。"; }
    }
    if (retained.length !== this.rows.size && !this.warning) this.compact();
    const matching = retained.filter(row => (!query.source || row.source === query.source) && (!query.adapter || row.adapter === query.adapter) &&
      (!query.kind || row.kind === query.kind) && (!query.status || row.status === query.status) &&
      (!query.statusGroup || MESSAGE_RECORD_STATUS_GROUPS[query.statusGroup]!.includes(row.status)) &&
      (from === undefined || row.createdAtMs >= from) && (to === undefined || row.createdAtMs <= to) &&
      (!query.search || [row.preview, row.body, row.error, row.threadId].join(" ").toLowerCase().includes(query.search.toLowerCase().slice(0, 200))));
    const projects = new Map<string, { key: string; label: string; count: number }>();
    for (const row of matching) {
      const key = row.projectKey || "unassigned";
      const item = projects.get(key) ?? { key, label: row.projectName || "未归属项目", count: 0 };
      item.count++; projects.set(key, item);
    }
    const rows = matching.filter(row => !query.project || (row.projectKey || "unassigned") === query.project)
      .sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id));
    const tasks = rows.filter(row => row.kind === "task");
    const offset = Math.max(0, Math.min(5000, Math.floor(query.offset || 0)));
    const limit = Math.max(1, Math.min(100, Math.floor(query.limit || 30)));
    return {
      policy: { ...this.policy }, startedAtMs: this.startedAtMs, warning: this.warning, total: rows.length,
      offset, limit, hasMore: offset + limit < rows.length, records: structuredClone(rows.slice(offset, offset + limit)),
      adapters: [...new Set(retained.map(row => row.adapter))].sort(),
      projects: [...projects.values()].sort((a, b) => a.label.localeCompare(b.label, "zh-CN") || a.key.localeCompare(b.key)),
      stats: { messages: tasks.length, web: tasks.filter(row => row.source === "web").length,
        clawbot: tasks.filter(row => row.source === "clawbot").length, failed: tasks.filter(row => row.status === "failed").length,
        delivered: tasks.filter(row => row.status === "delivered").length, retries: tasks.reduce((sum, row) => sum + Math.max(0, row.attempts - 1), 0),
        queued: tasks.filter(row => row.status === "queued").length, historical: rows.filter(row => row.historical).length,
        controls: rows.length - tasks.length, attachments: tasks.reduce((sum, row) => sum + row.imageCount, 0) },
      storage: { retained: retained.length, bytes: this.bytes, maxBytes: MAX_BYTES, oldestAtMs: retained.reduce((min, row) => Math.min(min, row.createdAtMs), now) },
    };
  }

  export(query: Query) {
    const first = this.query({ ...query, offset: 0, limit: 100 });
    const records = first.records;
    for (let offset = 100; offset < first.total; offset += 100) records.push(...this.query({ ...query, offset, limit: 100 }).records);
    return { exportedAt: new Date(this.now()).toISOString(), scope: "仅当前保留的消息交付记录，不代表全部历史或任务执行结果", ...first, records };
  }

  private compact(): void {
    if (this.warning) return;
    const retained = [...this.rows.values()].filter(row => row.createdAtMs >= this.now() - this.policy.retentionDays * DAY)
      .sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, this.policy.maxRecords);
    const lines = [JSON.stringify({ type: "meta", policy: this.policy, startedAtMs: this.startedAtMs, historyImported: this.historyImported, captureFromMs: this.captureFromMs, textFromMs: this.textFromMs }) + "\n"];
    let bytes = Buffer.byteLength(lines[0]!);
    const kept: MessageRecord[] = [];
    for (const row of retained) {
      const line = JSON.stringify({ type: "record", row }) + "\n";
      if (bytes + Buffer.byteLength(line) > MAX_BYTES) continue;
      lines.push(line); bytes += Buffer.byteLength(line); kept.push(row);
    }
    writePrivateFileAtomic(this.stateFile, lines.join(""), { encoding: "utf8" });
    this.bytes = bytes; this.writes = 0; this.rows = new Map(kept.map(row => [row.id, row]));
  }
}

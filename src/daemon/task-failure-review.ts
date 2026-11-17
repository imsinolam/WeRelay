import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { MessageRecord } from "./message-records.ts";

const STATUSES = new Set(["received", "accepted", "sending", "retrying", "queued", "submitted", "unconfirmed", "failed", "delivered", "cancelled", "handled"]);
const ADAPTERS = new Set(["codex", "claude", "tclaude", "grok", "codebuddy", "reasonix", "workbuddy", "opencode", "pi", "dsh", "deepseek", "shell"]);
const PROBLEMS = new Set(["failed", "unconfirmed", "retrying"]);
const MAX_BYTES = 16 * 1024 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
type Outcome = "recovered" | "attention" | "pending" | "closed";
type Group = {
  fingerprint: string; adapter: string; source: string; category: string;
  recentMessages: number; outstandingMessages: number; firstAtMs: number; lastAtMs: number;
  outcomes: Record<Outcome, number>; samples: { workspace: string; message: string }[];
};

// Only allow-listed labels leave this boundary. Raw errors, prose and paths stay local.
function category(error: string): string {
  if (/protocol|协议|version.*mismatch|不兼容/i.test(error)) return "protocol";
  if (/状态尚未就绪|waiting for app-server|hydration/i.test(error)) return "readiness";
  if (/401|403|unauthorized|forbidden|鉴权|凭据|权限/i.test(error)) return "authentication";
  if (/429|rate limit|too many requests|at capacity/i.test(error)) return "rate-limit";
  if (/model-unavailable|invalid.*model|模型.*不可用/i.test(error)) return "model";
  if (/attachment|image|图片|附件/i.test(error)) return "attachment";
  if (/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|not connected|未连接|离线/i.test(error)) return "connection";
  if (/timeout|timed out|超时|未确认|unconfirmed|disconnected|连接中断/i.test(error)) return "receipt-uncertain";
  return "unknown";
}
function validRow(row: MessageRecord): boolean {
  return Boolean(row && typeof row.id === "string" && typeof row.adapter === "string" &&
    ["web", "clawbot"].includes(row.source) && ["task", "control"].includes(row.kind) && STATUSES.has(row.status) &&
    Number.isFinite(row.createdAtMs) && Number.isFinite(row.updatedAtMs) &&
    (row.error === undefined || typeof row.error === "string") &&
    Array.isArray(row.events) && row.events.length <= 40 && row.events.every(event => event &&
      Number.isFinite(event.atMs) && STATUSES.has(event.status) && (event.error === undefined || typeof event.error === "string")));
}
function outcome(row: MessageRecord): Outcome {
  if (["submitted", "delivered"].includes(row.status)) return "recovered";
  if (["failed", "unconfirmed"].includes(row.status)) return "attention";
  if (["cancelled", "handled"].includes(row.status)) return "closed";
  return "pending";
}

/** Read-only bounded inspection: never instantiate MessageRecords, whose query may compact files. */
export function reviewTaskFailures(dataDir: string, options: { now?: number; hours?: number } = {}) {
  const now = options.now ?? Date.now();
  const hours = options.hours ?? 24;
  if (!Number.isFinite(now) || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) throw new Error("巡检时间范围无效");
  const since = now - hours * 3600_000;
  const gaps: string[] = [];
  const coverage: { workspace: string; records: number; gaps: string[] }[] = [];
  const groups = new Map<string, Group>();
  let directories: fs.Dirent[] = [];
  try {
    directories = fs.readdirSync(path.join(dataDir, "workspaces"), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch { gaps.push("workspaces-unavailable"); }
  if (!directories.length && !gaps.length) gaps.push("no-workspaces");
  if (directories.length > 1000) gaps.push("workspace-limit");
  for (const directory of directories.slice(0, 1000)) {
    if (!directory.isDirectory() && !directory.isSymbolicLink()) continue;
    const workspace = hash(directory.name);
    const issue = new Set<string>();
    const rows = new Map<string, MessageRecord>();
    const file = path.join(dataDir, "workspaces", directory.name, "message-records.jsonl");
    let metaSeen = false;
    let enabled = true;
    try {
      if (directory.isSymbolicLink()) { issue.add("unsafe-file"); continue; }
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) { issue.add("unsafe-file"); continue; }
      if (stat.size > MAX_BYTES) { issue.add("journal-too-large"); continue; }
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        if (!fs.fstatSync(fd).isFile()) { issue.add("unsafe-file"); continue; }
        // Read a fixed buffer so a growing journal cannot consume unbounded memory.
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
          if (!count) break;
          length += count;
        }
        if (length > MAX_BYTES) { issue.add("journal-too-large"); continue; }
        for (const line of buffer.subarray(0, length).toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data?.type === "meta" && typeof data.policy?.enabled === "boolean") {
              metaSeen = true; enabled = data.policy.enabled;
              if (!Number.isFinite(data.startedAtMs) || data.startedAtMs > since) issue.add("partial-window");
            } else if (data?.type === "record" && validRow(data.row)) rows.set(data.row.id, data.row);
            else issue.add("invalid-records");
          } catch { issue.add("invalid-records"); }
        }
      } finally { fs.closeSync(fd); }
      if (!metaSeen) issue.add("metadata-missing");
      if (!enabled) issue.add("recording-disabled");
      for (const row of rows.values()) {
        if (row.omittedEvents > 0) issue.add("events-truncated");
        if (row.historical) issue.add("historical-snapshot");
        if (row.updatedAtMs > now || row.events.some(event => event.atMs > now)) { issue.add("future-timestamp"); continue; }
        if (row.kind !== "task") continue;
        const events = row.events.filter(event => PROBLEMS.has(event.status));
        // Imported/old snapshots may lack events; retain their current failure as weaker evidence.
        if (!events.length && PROBLEMS.has(row.status)) {
          events.push({ atMs: row.updatedAtMs, status: row.status, attempts: row.attempts, error: row.error });
          issue.add("snapshot-only");
        }
        const recent = events.filter(event => event.atMs >= since);
        const state = outcome(row);
        const outstanding = events.length > 0 && (state === "attention" || state === "pending");
        if (!recent.length && !outstanding) continue;
        // One logical message contributes once; use its latest incident as its actionable category.
        const last = [...events].sort((a, b) => a.atMs - b.atMs).at(-1)!;
        const adapter = ADAPTERS.has(row.adapter) ? row.adapter : "other";
        const label = category(last.error ?? row.error ?? "");
        const fingerprint = hash(JSON.stringify([adapter, row.source, label]));
        const group = groups.get(fingerprint) ?? { fingerprint, adapter, source: row.source, category: label,
          recentMessages: 0, outstandingMessages: 0, firstAtMs: last.atMs, lastAtMs: last.atMs,
          outcomes: { recovered: 0, attention: 0, pending: 0, closed: 0 }, samples: [] };
        group.recentMessages += Number(recent.length > 0);
        group.outstandingMessages += Number(outstanding);
        group.outcomes[state]++;
        group.firstAtMs = Math.min(group.firstAtMs, ...events.map(event => event.atMs));
        group.lastAtMs = Math.max(group.lastAtMs, last.atMs);
        if (group.samples.length < 5) group.samples.push({ workspace, message: hash(row.id) });
        groups.set(fingerprint, group);
      }
    } catch (error) {
      issue.add((error as NodeJS.ErrnoException).code === "ENOENT" ? "journal-missing" : "journal-unreadable");
    } finally { coverage.push({ workspace, records: rows.size, gaps: [...issue].sort() }); }
  }
  return { schemaVersion: 1, generatedAtMs: now, sinceMs: since,
    scope: "仅保留的消息交付记录；不代表 Agent 执行结果，也不代表完整历史。分组是诊断线索，不是已确认根因。",
    complete: !gaps.length && coverage.every(item => !item.gaps.length), gaps, coverage,
    groups: [...groups.values()].sort((a, b) => b.outstandingMessages - a.outstandingMessages || b.recentMessages - a.recentMessages || a.fingerprint.localeCompare(b.fingerprint)) };
}

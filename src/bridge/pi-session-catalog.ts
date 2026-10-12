import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { BridgeResumeSessionCandidate, BridgeSessionMessage } from "./bridge-types.ts";
import { titleFromLatestMessage } from "./task-title-fallback.ts";
import { formatPiModelError } from "./pi-model-error.ts";
import { discoverPiOwners } from "./pi-owner-discovery.ts";

const METADATA_BYTES = 128 * 1024;
const HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_FILES = 10_000;

type PiSessionHeader = { id: string; cwd: string; timestamp: string };

export function piSessionRoot(): string {
  return path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR?.trim() ||
    path.join(process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent"), "sessions"));
}

async function readWindow(file: string, bytes: number, tail = false): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, bytes);
    const position = tail ? size - length : 0;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (!tail || position === 0) return text;
    const newline = text.indexOf("\n");
    return newline < 0 ? "" : text.slice(newline + 1);
  } finally { await handle.close(); }
}

function parseLines(text: string): Record<string, unknown>[] {
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop(); // Ignore an entry still being written.
  return lines.flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return value && typeof value === "object" && !Array.isArray(value)
        ? [value as Record<string, unknown>] : [];
    } catch { return []; }
  });
}

function headerOf(entry: Record<string, unknown> | undefined): PiSessionHeader | null {
  if (entry?.type !== "session" || typeof entry.id !== "string" ||
    typeof entry.cwd !== "string" || typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) return null;
  return { id: entry.id, cwd: entry.cwd, timestamp: entry.timestamp };
}

function piUserMessageText(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
  const message = entry.message as Record<string, unknown>;
  if (message.role !== "user") return undefined;
  const content = message.content;
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((part) =>
      part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
    ).map((part) => (part as Record<string, unknown>).text)
      .filter((part): part is string => typeof part === "string").join("\n") : "";
  return text.trim() || undefined;
}

async function readPiMetadata(file: string): Promise<BridgeResumeSessionCandidate | null> {
  const head = parseLines(await readWindow(file, METADATA_BYTES));
  const header = headerOf(head[0]);
  if (!header) return null;
  const tail = parseLines(await readWindow(file, METADATA_BYTES, true));
  const entries = [...head, ...tail];
  const name = entries.filter((entry) => entry.type === "session_info" && typeof entry.name === "string")
    .at(-1)?.name;
  const user = head.find((entry) => entry.type === "message" &&
    entry.message && typeof entry.message === "object" &&
    (entry.message as Record<string, unknown>).role === "user");
  const firstText = user?.message && typeof user.message === "object"
    ? (user.message as Record<string, unknown>).content : undefined;
  const title = typeof name === "string" && name.trim() ? name.trim()
    : typeof firstText === "string" && firstText.trim() ? firstText.trim().slice(0, 100)
    : `Pi 任务 ${header.id.slice(0, 8)}`;
  const latestText = [...head, ...tail].reverse().map(piUserMessageText).find(Boolean);
  // Copies, Desktop inspection and filesystem maintenance can touch mtime.
  // Sort by real native events, never a viewer's file access time.
  const latestTimestamp = entries.reduce((latest, entry) => {
    const value = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    return Number.isFinite(value) ? Math.max(latest, value) : latest;
  }, Date.parse(header.timestamp));
  return {
    sessionId: header.id, threadId: header.id,
    title: titleFromLatestMessage(title, header.id, latestText), projectId: header.cwd,
    cwd: header.cwd, projectName: path.basename(header.cwd),
    lastUpdatedAt: new Date(latestTimestamp).toISOString(),
    runtimeStatus: { type: "notLoaded" },
  };
}

async function piSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const directories = [{ path: root, depth: 0 }];
  let visited = 0;
  while (directories.length && visited++ < MAX_SESSION_FILES && files.length < MAX_SESSION_FILES) {
    const directory = directories.shift()!;
    const entries = await fs.readdir(directory.path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || directory.depth > 0) return [];
      throw error;
    });
    for (const entry of entries) {
      // Native Desktop enumerates recursively. Never follow directory symlinks
      // out of the configured Pi root or recurse without a depth/work bound.
      if (entry.isDirectory() && directory.depth < 8 && directories.length < MAX_SESSION_FILES) {
        directories.push({ path: path.join(directory.path, entry.name), depth: directory.depth + 1 });
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(directory.path, entry.name));
      if (files.length >= MAX_SESSION_FILES) break;
    }
  }
  return files;
}

async function readPiSessionIndex(root: string): Promise<Array<{ file: string; candidate: BridgeResumeSessionCandidate }>> {
  const files = await piSessionFiles(root);
  // Bound simultaneous file opens even when many projects have Pi history.
  const results: Array<{ file: string; candidate: BridgeResumeSessionCandidate }> = [];
  for (let index = 0; index < files.length; index += 16) {
    const group = await Promise.all(files.slice(index, index + 16)
      .map(async (file) => {
        const candidate = await readPiMetadata(file).catch(() => null);
        return candidate ? { file, candidate } : null;
      }));
    for (const item of group) if (item) results.push(item);
  }
  return results.sort((a, b) => b.candidate.lastUpdatedAt.localeCompare(a.candidate.lastUpdatedAt) || a.file.localeCompare(b.file));
}

export async function listPiSessions(options: { root?: string; limit?: number } = {}): Promise<BridgeResumeSessionCandidate[]> {
  const index = await readPiSessionIndex(options.root ?? piSessionRoot());
  const unique = new Map<string, BridgeResumeSessionCandidate>();
  for (const { candidate } of index) if (!unique.has(candidate.sessionId)) unique.set(candidate.sessionId, candidate);
  const owners = discoverPiOwners();
  return [...unique.values()].map((candidate) => {
    const matching = owners.filter((owner) => owner.sessionId === candidate.sessionId);
    const owner = matching.length === 1 ? matching[0] : undefined;
    return owner?.status ? { ...candidate, runtimeStatus: owner.status === "busy"
      ? { type: "active" as const, activeFlags: [] } : { type: "idle" as const } } : candidate;
  })
    .slice(0, Math.max(0, Math.min(options.limit ?? 100, 500)));
}

export async function readPiSessionMessages(file: string): Promise<BridgeSessionMessage[]> {
  const entries = parseLines(await readWindow(file, HISTORY_BYTES, true));
  const messages: BridgeSessionMessage[] = [];
  let pendingError: BridgeSessionMessage | null = null;
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.role === "user" && pendingError) {
      messages.push(pendingError);
      pendingError = null;
    }
    if (message.role === "assistant" && message.stopReason === "error") {
      pendingError = {
        role: "task",
        text: formatPiModelError(typeof message.errorMessage === "string" ? message.errorMessage : undefined),
        ...(typeof entry.id === "string" ? { id: entry.id } : {}),
        ...(typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp))
          ? { createdAtMs: Date.parse(entry.timestamp) } : {}),
      };
      continue;
    }
    const content = message.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.filter((part) => part && typeof part === "object" &&
        (part as Record<string, unknown>).type === "text")
        .map((part) => (part as Record<string, unknown>).text).filter((part): part is string => typeof part === "string")
        .join("\n") : "";
    if (!text) continue;
    if (message.role === "assistant") pendingError = null;
    messages.push({ role: message.role, text,
      ...(message.role === "assistant" && message.stopReason === "stop"
        ? { phase: "final_answer" as const } : {}),
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      ...(typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp))
        ? { createdAtMs: Date.parse(entry.timestamp) } : {}),
    });
  }
  if (pendingError) messages.push(pendingError);
  return messages;
}

/** Resolve a native Pi session ID without manufacturing a copy of its history. */
export async function findPiSessionFile(sessionId: string, root = piSessionRoot()): Promise<string | null> {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId) && !/^native-pi:[A-Za-z0-9_-]{24}$/.test(sessionId)) return null;
  const index = await readPiSessionIndex(root);
  for (const { file, candidate } of index) {
    if (candidate.sessionId === sessionId) return file;
    if (sessionId.startsWith("native-pi:")) {
      const realFile = await fs.realpath(file);
      const alias = "native-pi:" + createHash("sha256").update(`${realFile}\0${candidate.sessionId}`).digest("base64url").slice(0, 24);
      if (alias === sessionId) return file;
    }
  }
  return null;
}

export async function readPiNativeSessionId(file: string): Promise<string> {
  const header = headerOf(parseLines(await readWindow(file, 2048))[0]);
  if (!header) throw new Error("Pi 原会话头无效，未创建替代任务。");
  return header.id;
}

/** Read the project directory from the session header, not from the storage bucket. */
export async function readPiSessionProject(file: string): Promise<string> {
  const header = headerOf(parseLines(await readWindow(file, 2048))[0]);
  if (!header?.cwd || !path.isAbsolute(header.cwd)) throw new Error("Pi 会话缺少有效项目目录。");
  return header.cwd;
}

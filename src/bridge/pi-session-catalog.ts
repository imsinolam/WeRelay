import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BridgeResumeSessionCandidate, BridgeSessionMessage } from "./bridge-types.ts";
import { titleFromLatestMessage } from "./task-title-fallback.ts";
import { formatPiModelError } from "./pi-model-error.ts";

const METADATA_BYTES = 128 * 1024;
const HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_FILES = 10_000;

type PiSessionHeader = { id: string; cwd: string; timestamp: string };

export function piSessionRoot(): string {
  return path.resolve(process.env.PI_CODING_AGENT_SESSION_DIR?.trim() ||
    path.join(os.homedir(), ".pi", "agent", "sessions"));
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
    typeof entry.cwd !== "string" || typeof entry.timestamp !== "string") return null;
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
  const stat = await fs.stat(file);
  return {
    sessionId: header.id, threadId: header.id,
    title: titleFromLatestMessage(title, header.id, latestText), projectId: header.cwd,
    cwd: header.cwd, projectName: path.basename(header.cwd),
    lastUpdatedAt: new Date(stat.mtimeMs).toISOString(),
    runtimeStatus: { type: "notLoaded" },
  };
}

export async function listPiSessions(options: { root?: string; limit?: number } = {}): Promise<BridgeResumeSessionCandidate[]> {
  const root = options.root ?? piSessionRoot();
  let directories: string[];
  try {
    directories = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const directory of directories) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(directory, entry.name));
      if (files.length >= MAX_SESSION_FILES) break;
    }
    if (files.length >= MAX_SESSION_FILES) break;
  }
  // Bound simultaneous file opens even when many projects have Pi history.
  const results: BridgeResumeSessionCandidate[] = [];
  for (let index = 0; index < files.length; index += 16) {
    const group = await Promise.all(files.slice(index, index + 16)
      .map((file) => readPiMetadata(file).catch(() => null)));
    for (const candidate of group) if (candidate) results.push(candidate);
  }
  return results.sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt))
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
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return null;
  const projects = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const directory = path.join(root, project.name);
    const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(`_${sessionId}.jsonl`)) continue;
      const candidate = path.join(directory, file.name);
      const header = headerOf(parseLines(await readWindow(candidate, 2048))[0]);
      if (header?.id === sessionId) return candidate;
    }
  }
  return null;
}

/** Read the project directory from the session header, not from the storage bucket. */
export async function readPiSessionProject(file: string): Promise<string> {
  const header = headerOf(parseLines(await readWindow(file, 2048))[0]);
  if (!header?.cwd || !path.isAbsolute(header.cwd)) throw new Error("Pi 会话缺少有效项目目录。");
  return header.cwd;
}

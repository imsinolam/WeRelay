import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { BridgeSessionComposerDraft } from "./bridge-types.ts";
import { writePrivateFileAtomic } from "../utils/private-files.ts";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasUnrepresentedFields(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.entries(value).some(([key, item]) => !allowed.includes(key) && item !== null && item !== undefined &&
    item !== false && item !== "" && !(Array.isArray(item) && item.length === 0));
}

/** Conservative text-only projection. Unknown native nodes must not silently lose content. */
function documentText(node: unknown): string | null {
  if (!record(node)) return null;
  if (node.type === "text") return typeof node.text === "string" ? node.text : null;
  if (node.type === "hardBreak" || node.type === "hard_break") return "\n";
  if (node.type !== "doc" && node.type !== "paragraph") return null;
  if (node.content !== undefined && !Array.isArray(node.content)) return null;
  const parts = (node.content ?? []).map(documentText);
  if (parts.some((part: string | null) => part === null)) return null;
  return parts.join(node.type === "doc" ? "\n" : "");
}

export function readCodexComposerDraft(state: unknown, sessionId: string): BridgeSessionComposerDraft {
  const unavailable = { supported: false, draft: null,
    unavailableReason: "当前 Codex 未提供可完整读取的文字草稿。" };
  if (!record(state) || !record(state["electron-persisted-atom-state"])) return unavailable;
  const atoms = state["electron-persisted-atom-state"];
  // An existing empty modern store means sent/cleared, never fall back to stale legacy data.
  const drafts = Object.hasOwn(atoms, "composer-prompt-drafts-v2")
    ? atoms["composer-prompt-drafts-v2"] : atoms["composer-prompt-drafts-v1"];
  if (!record(drafts)) return unavailable;
  const key = `local:${sessionId}`;
  let value = drafts[key];
  if (value === undefined || value === null) return { supported: true, draft: null };
  if (record(value) && "draft" in value) {
    if (hasUnrepresentedFields(value, ["draft"])) return unavailable;
    value = value.draft;
  }
  if (record(value) && hasUnrepresentedFields(value, ["prompt"])) return unavailable;
  const prompt = record(value) && "prompt" in value ? value.prompt : value;
  if (record(prompt) && hasUnrepresentedFields(prompt, ["document", "plainTextMode"])) return unavailable;
  const text = typeof prompt === "string" ? prompt : record(prompt) ? documentText(prompt.document) : null;
  if (text === null) return unavailable;
  if (text.length === 0) return { supported: true, draft: null };
  const revision = createHash("sha256").update(JSON.stringify([key, prompt])).digest("hex");
  return { supported: true, draft: { text, revision } };
}

/** Opaque per-task generations: no text/paths/IDs, no dependence on other tasks' file mtime. */
export class NativeComposerDraftRevisions {
  private entries = new Map<string, { fingerprint: string | null; revision: string }>();

  constructor(private readonly stateFile: string) {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (!record(value) || value.version !== 1 || !Array.isArray(value.entries)) return;
      for (const entry of value.entries.slice(-512)) {
        if (!record(entry) || typeof entry.key !== "string" || !/^[a-f0-9]{64}$/.test(entry.key) ||
            typeof entry.revision !== "string" || !/^[a-f0-9-]{36}$/.test(entry.revision) ||
            entry.fingerprint !== null && (typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint))) continue;
        this.entries.set(entry.key, { fingerprint: entry.fingerprint, revision: entry.revision });
      }
    } catch { /* First use or an unreadable receipt cache. Never recover draft text from here. */ }
  }

  track(sessionId: string, result: BridgeSessionComposerDraft): BridgeSessionComposerDraft {
    if (!result.supported) return result;
    const key = createHash("sha256").update(sessionId).digest("hex");
    const previous = this.entries.get(key);
    const fingerprint = result.draft?.revision ?? null;
    if (!previous && !fingerprint) return result;
    const revision = previous?.fingerprint === fingerprint ? previous.revision : randomUUID();
    if (!previous || previous.fingerprint !== fingerprint) {
      this.entries.delete(key);
      this.entries.set(key, { fingerprint, revision });
      if (this.entries.size > 512) this.entries.delete(this.entries.keys().next().value!);
      writePrivateFileAtomic(this.stateFile, JSON.stringify({ version: 1,
        entries: [...this.entries].map(([key, value]) => ({ key, ...value })),
      }) + "\n");
    }
    return result.draft ? { ...result, draft: { ...result.draft, revision } } : result;
  }
}

export const COMPOSER_DRAFT_CONFLICT = "电脑端草稿已发送、清空或修改；本条未发送，请核对后重新编辑发送。";

export function assertComposerDraftRevision(state: BridgeSessionComposerDraft, revision: string): void {
  if (!state.supported || state.draft?.revision !== revision) throw new Error(COMPOSER_DRAFT_CONFLICT);
}

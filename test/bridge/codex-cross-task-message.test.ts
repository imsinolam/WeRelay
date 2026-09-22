import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCodexSessionMessagePageFromRollout, mergeCodexSessionMessages } from "../../src/bridge/bridge-adapters.codex.ts";

const source = "11111111-1111-7111-8111-111111111111";
const envelope = (text: string) => `<codex_delegation>\n<source_thread_id>${source}</source_thread_id>\n<input>${text}</input>\n</codex_delegation>`;
const incoming = (overrides: Record<string, unknown> = {}) => ({
  timestamp: "2026-09-14T12:01:00.000Z", type: "response_item",
  payload: { type: "function_call_output", id: "incoming-1", namespace: "codex_app", name: "send_message_to_thread",
    output: envelope("已核对发布候选。"), internal_chat_message_metadata_passthrough: { turn_id: "turn-2" }, ...overrides },
});
function withRollout(records: unknown[], run: (file: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-cross-task-"));
  const file = path.join(dir, "rollout.jsonl");
  try { fs.writeFileSync(file, records.map(x => JSON.stringify(x)).join("\n") + "\n"); run(file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const reply = (text: string, time: string, turnId: string) => ({ timestamp: time, type: "response_item",
  payload: { type: "message", role: "assistant", content: [{type: "output_text", text}],
    internal_chat_message_metadata_passthrough: {turn_id: turnId}, phase: "final_answer" } });

describe("Codex incoming cross-task messages", () => {
  test("keeps the incoming message between replies with its own source, id, turn and timestamp", () => {
    withRollout([reply("已交接。", "2026-09-14T12:00:00Z", "turn-1"), incoming(),
      reply("收到确认。", "2026-09-14T12:02:00Z", "turn-2")], file => {
      for (const lightweight of [true, false]) {
        const page = readCodexSessionMessagePageFromRollout(file, { limit: 10, lightweight });
        expect(page?.messages.map(m => m.text)).toEqual(["已交接。", "已核对发布候选。", "收到确认。"]);
        expect(page?.messages[1]).toEqual({ role: "task", text: "已核对发布候选。", id: "incoming-1", turnId: "turn-2",
          createdAtMs: Date.parse("2026-09-14T12:01:00Z"), sourceTask: { adapter: "codex", sessionId: source } });
      }
      const latest = readCodexSessionMessagePageFromRollout(file, {limit: 1, lightweight: true});
      const older = readCodexSessionMessagePageFromRollout(file, {limit: 1, lightweight: true, before: latest?.nextBefore});
      expect(older?.messages[0]?.text).toBe("已核对发布候选。");
      expect(older?.hasMore).toBe(true);
    });
  });
  test("does not promote ordinary tool output, developer instructions or malformed wrappers", () => {
    withRollout([
      incoming({namespace: "shell"}), incoming({name: "exec_command"}),
      incoming({type: "message", role: "developer", content: [{type: "input_text", text: envelope("private") }]}),
      incoming({output: "ordinary log: " + envelope("private")}),
      incoming({output: envelope("private").replace(source, "not-a-task")}),
      incoming({output: envelope("private").replace("</codex_delegation>", "")}),
      incoming({output: envelope("<thinking>internal reasoning</thinking>可见结论。")}),
    ], file => {
      expect(readCodexSessionMessagePageFromRollout(file, {limit: 20})?.messages.map(m => m.text)).toEqual(["可见结论。"]);
    });
  });
  test("merging live history neither duplicates a source message nor mistakes it for a user receipt", () => {
    withRollout([incoming()], file => {
      const messages = readCodexSessionMessagePageFromRollout(file, {limit: 10})!.messages;
      expect(messages).toHaveLength(1);
      expect(mergeCodexSessionMessages(messages, messages)).toHaveLength(1);
      const merged = mergeCodexSessionMessages(messages, [{role: "user", text: "已核对发布候选。", turnId: "turn-2"}]);
      expect(merged).toHaveLength(2);
      expect(merged.filter(m => m.role === "user")).toHaveLength(1);
    });
  });
});

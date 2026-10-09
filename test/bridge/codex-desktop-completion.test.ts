import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { readCodexDesktopCompletionFromRolloutTail } from "../../src/bridge/bridge-adapters.codex.ts";

test("Codex native completion text survives missing message metadata without borrowing a previous turn", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-codex-completion-"));
  const file = path.join(dir, "rollout.jsonl");
  const timestamp = "2026-01-02T12:00:00Z";
  const complete = { timestamp, type: "event_msg", payload: {
    type: "task_complete", turn_id: "current", last_agent_message: "最终结果", duration_ms: 1000,
  } };
  const message = (role: string, turnId: string, phase = "final_answer") => ({
    timestamp, type: "response_item", payload: { type: "message", role, phase,
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
      content: [{ type: role === "user" ? "input_text" : "output_text", text: "原生正文" }] },
  });
  const read = (...rows: unknown[]) => {
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));
    return readCodexDesktopCompletionFromRolloutTail(file);
  };
  try {
    expect(read(complete)).toMatchObject({
      summary: { status: "completed", turnId: "current", durationMs: 1000 },
      finalMessage: { role: "assistant", phase: "final_answer", turnId: "current", text: "最终结果" },
    });
    const noText = { ...complete, payload: { ...complete.payload, last_agent_message: undefined } };
    expect(read(message("assistant", "current"), noText)?.finalMessage.text).toBe("原生正文");
    expect(read(message("assistant", "old"), noText)).toBeNull();
    expect(read(message("assistant", "current", "commentary"), noText)).toBeNull();
    expect(read(complete, { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "next" } })).toBeNull();
    expect(read(complete, message("user", "next"))).toBeNull();
    expect(read({ ...complete, payload: { ...complete.payload, error: { message: "失败" } } })).toBeNull();
    expect(read(complete, { type: "title", text: "改名" })?.finalMessage.text).toBe("最终结果");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

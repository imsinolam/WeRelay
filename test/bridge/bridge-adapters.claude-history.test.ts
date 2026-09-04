import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ClaudeCompanionAdapter,
  listClaudeStoredSessions,
  parseClaudeTranscript,
  readClaudeStoredSessionMessages,
} from "../../src/bridge/bridge-adapters.claude.ts";
import type { BridgeEvent } from "../../src/bridge/bridge-types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeHome(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-claude-history-"));
  tempDirs.push(directory);
  return directory;
}

function writeTranscript(
  filePath: string,
  sessionId: string,
  cwd: string,
  timestamp: string,
  userText: string,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, [
    JSON.stringify({
      type: "user",
      uuid: `${sessionId}-user`,
      sessionId,
      cwd,
      timestamp,
      message: { role: "user", content: userText },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: `${sessionId}-assistant`,
      sessionId,
      cwd,
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: `完成：${userText}` }],
      },
    }),
  ].join("\n"));
}

describe("Claude stored sessions", () => {
  test("treats a clean TClaude exit as a normal close with a Chinese recovery hint", () => {
    const adapter = new ClaudeCompanionAdapter({
      kind: "tclaude",
      command: "tclaude",
      cwd: process.cwd(),
    });
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));

    (adapter as unknown as { handleExit(exitCode: number): void }).handleExit(0);

    expect(events).toContainEqual({
      type: "notice",
      text: "TClaude 已关闭。\n发送“/tclaude”可重新打开。",
      level: "warning",
      timestamp: expect.any(String),
    });
    expect(events).toContainEqual({
      type: "status",
      status: "stopped",
      message: "tclaude worker stopped.",
      timestamp: expect.any(String),
    });
    expect(events.some((event) => event.type === "fatal_error")).toBe(false);
  });

  test("removes terminal metadata while keeping real user and assistant messages", () => {
    const messages = parseClaudeTranscript([
      JSON.stringify({
        type: "user",
        sessionId: "session-1",
        message: {
          role: "user",
          content: "<local-command-stdout>模型已切换</local-command-stdout>",
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId: "session-1",
        uuid: "user-1",
        message: { role: "user", content: "继续修复移动端" },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId: "session-1",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: "已经修复。" }],
        },
      }),
    ].join("\n"));

    expect(messages).toEqual([
      { role: "user", text: "继续修复移动端", id: "user-1" },
      {
        role: "assistant",
        text: "已经修复。",
        id: "assistant-1",
        phase: "final_answer",
        model: "claude-sonnet-5",
      },
    ]);
  });

  test("lists recent Claude tasks across projects and de-duplicates compacted copies", () => {
    const home = makeHome();
    const older = path.join(home, ".claude", "projects", "project-a", "same.jsonl");
    const newer = path.join(home, ".claude", "projects", "project-b", "same.jsonl");
    const other = path.join(home, ".claude", "projects", "project-c", "other.jsonl");
    writeTranscript(older, "same", "/repo/old", "2026-08-01T10:00:00.000Z", "旧标题");
    writeTranscript(newer, "same", "/repo/new", "2026-08-03T10:00:00.000Z", "新标题");
    writeTranscript(other, "other", "/repo/other", "2026-08-02T10:00:00.000Z", "其他任务");

    const sessions = listClaudeStoredSessions("claude", 10, home);
    expect(sessions.map((session) => session.sessionId)).toEqual(["same", "other"]);
    expect(sessions[0]).toMatchObject({
      title: "新标题",
      cwd: "/repo/new",
      transcriptPath: newer,
    });
    expect(sessions[0]?.projectName).toBeUndefined();
    expect(readClaudeStoredSessionMessages(newer).at(-1)?.text).toBe("完成：新标题");
  });

  test("uses the separate TClaude history directory", () => {
    const home = makeHome();
    const transcript = path.join(home, ".tclaude", "projects", "project", "t-session.jsonl");
    writeTranscript(
      transcript,
      "t-session",
      "/repo/tclaude",
      "2026-08-04T10:00:00.000Z",
      "TClaude 最近任务",
    );
    expect(listClaudeStoredSessions("tclaude", 10, home)).toMatchObject([
      { sessionId: "t-session", title: "TClaude 最近任务", cwd: "/repo/tclaude" },
    ]);
    expect(listClaudeStoredSessions("claude", 10, home)).toEqual([]);
  });
});

import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPiSessions, readPiSessionMessages } from "../../src/bridge/pi-session-catalog.ts";

test("Pi native session index keeps project and explicit name without copying sessions", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-pi-catalog-"));
  try {
    const project = path.join(root, "--project--");
    fs.mkdirSync(project);
    const sessionFile = path.join(project, "2026-09-23_abc.jsonl");
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "abc", timestamp: "2026-09-23T00:00:00Z", cwd: "/project" }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-23T00:01:00Z", message: { role: "user", content: "First prompt" } }),
      JSON.stringify({ type: "session_info", id: "n1", parentId: "m1", timestamp: "2026-09-23T00:02:00Z", name: "Renamed task" }),
      JSON.stringify({ type: "message", id: "m2", parentId: "n1", timestamp: "2026-09-23T00:03:00Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] } }),
      "",
    ].join("\n"));
    const sessions = await listPiSessions({ root });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: "abc", title: "Renamed task", cwd: "/project", projectName: "project" });
    expect(await readPiSessionMessages(sessionFile)).toEqual([
      { role: "user", text: "First prompt", id: "m1", createdAtMs: Date.parse("2026-09-23T00:01:00Z") },
      { role: "assistant", text: "Done", phase: "final_answer", id: "m2", createdAtMs: Date.parse("2026-09-23T00:03:00Z") },
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Pi placeholder title uses the latest user message, never a newer assistant reply", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-pi-catalog-"));
  try {
    const project = path.join(root, "--project--");
    fs.mkdirSync(project);
    const sessionFile = path.join(project, "2026-09-24_01a0d152.jsonl");
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", version: 3, id: "01a0d152-0000-0000-0000-000000000000", timestamp: "2026-09-24T00:00:00Z", cwd: "/project" }),
      JSON.stringify({ type: "message", id: "m1", timestamp: "2026-09-24T00:01:00Z", message: { role: "user", content: [{ type: "text", text: "第一条消息" }] } }),
      JSON.stringify({ type: "message", id: "m2", timestamp: "2026-09-24T00:02:00Z", message: { role: "toolResult", content: [{ type: "text", text: "不应使用工具输出" }] } }),
      JSON.stringify({ type: "message", id: "m3", timestamp: "2026-09-24T00:03:00Z", message: { role: "user", content: [{ type: "text", text: "请检查最新这轮 Pi Agent 任务的问题并修复" }] } }),
      JSON.stringify({ type: "message", id: "m4", timestamp: "2026-09-24T00:04:00Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "**已经修复了 Pi 任务的连接错误**" }] } }),
      "",
    ].join("\n"));
    const sessions = await listPiSessions({ root });
    expect(sessions[0]?.title).toBe("请检查最新这轮 Pi Agent 任务的");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Pi model connection errors appear once as a task failure instead of a missing reply", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-pi-failure-"));
  try {
    const file = path.join(root, "session.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({ type: "session", id: "s1", cwd: root, timestamp: "2026-09-24T00:00:00Z" }),
      JSON.stringify({ type: "message", id: "u1", timestamp: "2026-09-24T00:01:00Z", message: { role: "user", content: "Test request" } }),
      ...[2, 3, 4].map((n) => JSON.stringify({ type: "message", id: `a${n}`, timestamp: `2026-09-24T00:0${n}:00Z`, message: {
        role: "assistant", stopReason: "error", errorMessage: "Connection error.", content: [],
      } })),
      "",
    ].join("\n"));
    const messages = await readPiSessionMessages(file);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "task",
      id: "a4",
      text: "Pi 模型连接失败。请检查当前模型服务或网络后重试。",
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Pi retry errors disappear when the same turn eventually succeeds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-pi-retry-"));
  try {
    const file = path.join(root, "session.jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "message", id: "e1", message: {
        role: "assistant", stopReason: "error", errorMessage: "Connection error.", content: [],
      } }),
      JSON.stringify({ type: "message", id: "a1", message: {
        role: "assistant", stopReason: "stop", content: [{ type: "text", text: "回复成功" }],
      } }),
      JSON.stringify({ type: "message", id: "u2", message: { role: "user", content: "again" } }),
      JSON.stringify({ type: "message", id: "e2", message: {
        role: "assistant", stopReason: "error", errorMessage: "https://example.invalid/?key=private-token failed", content: [],
      } }),
      JSON.stringify({ type: "message", id: "u3", message: { role: "user", content: "one more" } }),
      "",
    ].join("\n"));
    const messages = await readPiSessionMessages(file);
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "hello"], ["assistant", "回复成功"], ["user", "again"],
      ["task", "Pi 模型请求失败。请在 Pi 窗口查看具体错误并检查当前模型配置。"],
      ["user", "one more"],
    ]);
    expect(JSON.stringify(messages)).not.toContain("private-token");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

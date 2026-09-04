import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { BridgeEvent } from "../../src/bridge/bridge-types.ts";

import { createBridgeAdapter } from "../../src/bridge/bridge-adapters.ts";
import { LocalCompanionProxyAdapter } from "../../src/bridge/bridge-adapters.core.ts";
import {
  ReasonixServerAdapter,
  buildReasonixServeArgs,
  listReasonixSessions,
  parseReasonixTranscript,
  readReasonixSessionMessages,
  reasonixSessionDirectory,
  resolveReasonixSessionCwd,
  resolveReasonixSessionStateRoot,
} from "../../src/bridge/bridge-adapters.reasonix.ts";

const previousReasonixHome = process.env.REASONIX_HOME;
const previousReasonixStateHome = process.env.REASONIX_STATE_HOME;
const previousReasonixOpenWeb = process.env.WERELAY_REASONIX_OPEN_WEB;
const tempDirectories: string[] = [];

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-reasonix-"));
  tempDirectories.push(directory);
  return directory;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待测试条件超时");
}

afterEach(() => {
  if (previousReasonixHome === undefined) delete process.env.REASONIX_HOME;
  else process.env.REASONIX_HOME = previousReasonixHome;
  if (previousReasonixStateHome === undefined) delete process.env.REASONIX_STATE_HOME;
  else process.env.REASONIX_STATE_HOME = previousReasonixStateHome;
  if (previousReasonixOpenWeb === undefined) delete process.env.WERELAY_REASONIX_OPEN_WEB;
  else process.env.WERELAY_REASONIX_OPEN_WEB = previousReasonixOpenWeb;
  while (tempDirectories.length > 0) {
    fs.rmSync(tempDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("reasonix adapter", () => {
  test("routes reasonix through one visible serve owner", () => {
    const options = {
      kind: "reasonix" as const,
      command: "reasonix",
      cwd: "/repo",
      profile: "deepseek-v4",
      extraCliArgs: ["-profile", "delivery"],
    };
    expect(createBridgeAdapter(options)).toBeInstanceOf(LocalCompanionProxyAdapter);
    expect(createBridgeAdapter({ ...options, renderMode: "companion" }))
      .toBeInstanceOf(ReasonixServerAdapter);
    expect(buildReasonixServeArgs(
      options,
      8787,
      "/tmp/reasonix.port",
      "/tmp/session.jsonl",
    )).toEqual([
      "serve",
      "-model",
      "deepseek-v4",
      "-profile",
      "delivery",
      "-addr",
      "127.0.0.1:8787",
      "-auth",
      "none",
      "-port-file",
      "/tmp/reasonix.port",
      "-resume",
      "/tmp/session.jsonl",
    ]);
  });

  test("parses user and assistant transcript messages without exposing tool records", () => {
    expect(parseReasonixTranscript([
      JSON.stringify({ role: "system", content: "hidden" }),
      JSON.stringify({ role: "user", content: "修复登录问题" }),
      JSON.stringify({ role: "assistant", content: "", tool_calls: [{ id: "tool-1" }] }),
      JSON.stringify({ role: "tool", content: "private output" }),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "output_text", text: "已经修复。" }],
      }),
    ].join("\n"), { sessionId: "session-a", model: "deepseek-v4" })).toEqual([
      { role: "user", text: "修复登录问题", id: "session-a:2" },
      {
        role: "assistant",
        text: "已经修复。",
        id: "session-a:5",
        phase: "final_answer",
        model: "deepseek-v4",
      },
    ]);
  });

  test("lists, titles, reads, and resolves native and ACP Reasonix sessions", async () => {
    const stateHome = makeTempDirectory();
    const currentCwd = path.join(stateHome, "current-project");
    const nativeCwd = path.join(stateHome, "native-project");
    const acpCwd = path.join(stateHome, "acp-project");
    process.env.REASONIX_STATE_HOME = stateHome;
    delete process.env.REASONIX_HOME;
    const sessionDir = reasonixSessionDirectory();
    fs.mkdirSync(sessionDir, { recursive: true });

    const nativeTranscript = path.join(sessionDir, "native-session.jsonl");
    fs.writeFileSync(nativeTranscript, [
      JSON.stringify({ role: "user", content: "原生 Reasonix 任务" }),
      JSON.stringify({ role: "assistant", content: "原生任务已完成。" }),
    ].join("\n"), "utf8");
    writeJson(`${nativeTranscript}.meta`, {
      id: "native-session",
      workspace_root: nativeCwd,
      custom_title: "原生任务",
      updated_at: "2026-08-05T10:00:00Z",
      turns: 1,
      model: "deepseek-v4",
    });

    const acpTranscript = path.join(sessionDir, "acp-session.jsonl");
    fs.writeFileSync(acpTranscript, [
      JSON.stringify({ role: "user", content: "ACP Reasonix 任务" }),
      JSON.stringify({ role: "assistant", content: "ACP 任务已完成。" }),
    ].join("\n"), "utf8");
    writeJson(path.join(sessionDir, "acp-session.acp.json"), {
      sessionId: "acp-session",
      cwd: acpCwd,
      title: "ACP 任务",
      updatedAt: "2026-08-05T11:00:00Z",
      model: "kimi-k3",
    });

    const automaticTranscript = path.join(sessionDir, "automatic-session.jsonl");
    fs.writeFileSync(automaticTranscript, [
      JSON.stringify({ role: "user", content: "自动命名任务" }),
      JSON.stringify({ role: "assistant", content: "自动命名任务已完成。" }),
    ].join("\n"), "utf8");
    writeJson(`${automaticTranscript}.meta`, {
      id: "automatic-session",
      workspace_root: path.join(stateHome, "automatic-project"),
      topic_title: "自动标题",
      updated_at: "2026-08-05T11:30:00Z",
      turns: 1,
    });

    const projectStateRoot = path.join(stateHome, "projects", "project-store");
    const projectSessionDir = path.join(projectStateRoot, "sessions");
    const projectCwd = path.join(stateHome, "project-workspace");
    const projectTranscript = path.join(projectSessionDir, "project-session.jsonl");
    fs.mkdirSync(projectSessionDir, { recursive: true });
    fs.writeFileSync(projectTranscript, [
      JSON.stringify({ role: "user", content: "项目范围任务" }),
      JSON.stringify({ role: "assistant", content: "项目范围任务已完成。" }),
    ].join("\n"), "utf8");
    writeJson(`${projectTranscript}.meta`, {
      id: "project-session",
      workspace_root: projectCwd,
      custom_title: "项目范围任务",
      updated_at: "2026-08-05T12:00:00Z",
      turns: 1,
    });

    const subagentTranscript = path.join(sessionDir, "subagent-hidden.jsonl");
    fs.writeFileSync(subagentTranscript, JSON.stringify({ role: "user", content: "不应显示" }), "utf8");

    const sessions = await listReasonixSessions(currentCwd, 10);
    expect(sessions.map((session) => session.sessionId)).toEqual([
      "project-session",
      "automatic-session",
      "acp-session",
      "native-session",
    ]);
    expect(sessions.map((session) => session.title)).toEqual([
      "项目范围任务",
      "自动标题",
      "ACP 任务",
      "原生任务",
    ]);
    expect(sessions.map((session) => session.projectName)).toEqual([
      "project-workspace",
      undefined,
      undefined,
      "native-project",
    ]);
    expect(sessions[0]?.cwd).toBe(projectCwd);
    expect(sessions[2]?.cwd).toBe(acpCwd);
    expect(sessions[3]?.cwd).toBe(nativeCwd);
    expect(resolveReasonixSessionStateRoot("project-session")).toBe(projectStateRoot);
    expect(resolveReasonixSessionCwd("native-session")).toBe(nativeCwd);
    expect(await readReasonixSessionMessages(currentCwd, "native-session")).toEqual([
      { role: "user", text: "原生 Reasonix 任务", id: "native-session:1" },
      {
        role: "assistant",
        text: "原生任务已完成。",
        id: "native-session:2",
        phase: "final_answer",
        model: "deepseek-v4",
      },
    ]);
  });

  test("keeps the original transcript as the only resumable source", async () => {
    const stateHome = makeTempDirectory();
    const projectCwd = path.join(stateHome, "native-project");
    const projectSessionDir = path.join(
      stateHome,
      "projects",
      "native-project-store",
      "sessions",
    );
    const nativeTranscript = path.join(projectSessionDir, "code-Documents.jsonl");
    process.env.REASONIX_STATE_HOME = stateHome;
    fs.mkdirSync(projectSessionDir, { recursive: true });
    fs.writeFileSync(nativeTranscript, [
      JSON.stringify({ role: "user", content: "旧任务" }),
      JSON.stringify({ role: "assistant", content: "旧回复" }),
    ].join("\n"), "utf8");
    writeJson(`${nativeTranscript}.meta`, {
      workspace_root: projectCwd,
      custom_title: "旧任务",
      updated_at: "2026-08-05T12:00:00Z",
      turns: 1,
    });

    const sessions = await listReasonixSessions(projectCwd, 10);
    expect(sessions).toContainEqual(expect.objectContaining({
      sessionId: "code-Documents",
      cwd: projectCwd,
    }));
    expect(resolveReasonixSessionStateRoot("code-Documents")).toBe(
      path.join(stateHome, "projects", "native-project-store"),
    );
    expect(await readReasonixSessionMessages(projectCwd, "code-Documents"))
      .toEqual([
        { role: "user", text: "旧任务", id: "code-Documents:1" },
        {
          role: "assistant",
          text: "旧回复",
          id: "code-Documents:2",
          phase: "final_answer",
        },
      ]);
    expect(fs.readdirSync(stateHome)).toEqual(["projects"]);
  });
  test("uses one serve owner for submit, approval, cancel, and transcript switching", async () => {
    const stateHome = makeTempDirectory();
    const projectCwd = path.join(stateHome, "project");
    const sessionDir = path.join(stateHome, "sessions");
    const logPath = path.join(stateHome, "fake-reasonix.log");
    const scriptPath = path.join(stateHome, "fake-reasonix.mjs");
    process.env.REASONIX_STATE_HOME = stateHome;
    process.env.WERELAY_REASONIX_OPEN_WEB = "0";
    fs.mkdirSync(projectCwd, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });

    for (const [sessionId, title] of [
      ["session-one", "第一条任务"],
      ["session-two", "第二条任务"],
    ] as const) {
      const transcriptPath = path.join(sessionDir, `${sessionId}.jsonl`);
      fs.writeFileSync(
        transcriptPath,
        `${JSON.stringify({ role: "user", content: title })}\n`,
        "utf8",
      );
      writeJson(`${transcriptPath}.meta`, {
        workspace_root: projectCwd,
        custom_title: title,
        updated_at: "2026-08-06T10:00:00Z",
        turns: 1,
      });
    }

    fs.writeFileSync(scriptPath, `#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const readArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const address = readArg("-addr");
const portFile = readArg("-port-file");
const resumePath = readArg("-resume");
const logPath = readArg("--log");
const separator = address.lastIndexOf(":");
const host = address.slice(0, separator);
const port = Number(address.slice(separator + 1));
let currentSessionId = resumePath ? path.basename(resumePath, ".jsonl") : null;
let clients = [];
let eventId = 0;
const append = (entry) => fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
const broadcast = (event, fixedId) => {
  const payload = { event_id: fixedId ?? ++eventId, ...event };
  for (const client of clients) client.write("data: " + JSON.stringify(payload) + "\\n\\n");
  return payload;
};
const readBody = async (request) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
};
const json = (response, value) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/status") return json(response, { running: false });
  if (request.method === "GET" && request.url === "/sessions") {
    return json(response, currentSessionId ? [{ id: currentSessionId, current: true }] : []);
  }
  if (request.method === "GET" && request.url === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(": connected\\n\\n");
    clients.push(response);
    request.on("close", () => { clients = clients.filter((client) => client !== response); });
    return;
  }
  if (request.method === "POST" && request.url === "/new") {
    currentSessionId = null;
    append({ type: "new" });
    response.writeHead(204);
    return response.end();
  }
  if (request.method === "POST" && request.url === "/submit") {
    const body = await readBody(request);
    currentSessionId ??= "new-session";
    append({ type: "submit", input: body.input, sessionId: currentSessionId });
    response.writeHead(202);
    response.end();
    setTimeout(() => {
      broadcast({ kind: "turn_started" });
      if (body.input === "需要审批") {
        broadcast({
          kind: "approval_request",
          approval: { id: "approval-1", tool: "shell", subject: "echo ok" },
        });
        return;
      }
      if (body.input === "需要停止") return;
      broadcast({ kind: "text", text: "处理完成" });
      broadcast({ kind: "message", text: "处理完成" });
      const done = broadcast({ kind: "turn_done", outcome: "completed" });
      broadcast({ kind: "turn_done", outcome: "completed" }, done.event_id);
    }, 30);
    return;
  }
  if (request.method === "POST" && request.url === "/approve") {
    const body = await readBody(request);
    append({ type: "approve", body });
    response.writeHead(204);
    response.end();
    setTimeout(() => {
      broadcast({ kind: "text", text: "审批后完成" });
      broadcast({ kind: "message", text: "审批后完成" });
      broadcast({ kind: "turn_done", outcome: "completed" });
    }, 20);
    return;
  }
  if (request.method === "POST" && request.url === "/cancel") {
    append({ type: "cancel" });
    response.writeHead(204);
    response.end();
    setTimeout(() => broadcast({ kind: "turn_done", outcome: "cancelled" }), 20);
    return;
  }
  if (request.method === "POST" && request.url === "/answer") {
    append({ type: "answer", body: await readBody(request) });
    response.writeHead(204);
    return response.end();
  }
  response.writeHead(404);
  response.end();
});

server.listen(port, host, () => {
  const actual = server.address();
  fs.writeFileSync(portFile, actual.address + ":" + actual.port);
  append({ type: "start", address: actual.address + ":" + actual.port, resumePath });
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`);
    fs.chmodSync(scriptPath, 0o755);
    const commandPath = process.platform === "win32"
      ? path.join(stateHome, "fake-reasonix.cmd")
      : scriptPath;
    if (process.platform === "win32") {
      fs.writeFileSync(
        commandPath,
        `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
        "utf8",
      );
    }

    const events: BridgeEvent[] = [];
    const adapter = new ReasonixServerAdapter({
      kind: "reasonix",
      command: commandPath,
      cwd: projectCwd,
      renderMode: "companion",
      sessionStartMode: "restore",
      initialSharedSessionId: "session-one",
      extraCliArgs: ["--log", logPath],
    });
    adapter.setEventSink((event) => events.push(event));

    try {
      await adapter.start();
      await adapter.sendInput("正常消息");
      await waitFor(() => events.some((event) => event.type === "task_complete"));
      expect(events.filter((event) => event.type === "final_reply")).toHaveLength(1);
      expect(events.filter((event) => event.type === "task_complete")).toHaveLength(1);
      expect(adapter.getState()).toMatchObject({
        status: "idle",
        sharedSessionId: "session-one",
      });

      await adapter.sendInput("需要审批");
      await waitFor(() => events.some((event) => event.type === "approval_required"));
      expect(await adapter.resolveApproval("confirm")).toBe(true);
      await waitFor(() => events.filter((event) => event.type === "task_complete").length === 2);

      await adapter.sendInput("需要停止");
      await waitFor(() => adapter.getState().status === "busy");
      expect(await adapter.interrupt()).toBe(true);
      await waitFor(() => events.filter((event) => event.type === "task_complete").length === 3);
      expect(events.filter((event) => event.type === "task_complete").at(-1)).toMatchObject({
        outcome: "interrupted",
      });

      await adapter.resumeSession("session-two");
      expect(adapter.getState()).toMatchObject({
        status: "idle",
        sharedSessionId: "session-two",
        cwd: projectCwd,
      });

      const logs = fs.readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const starts = logs.filter((entry) => entry.type === "start");
      expect(starts).toHaveLength(2);
      expect(starts[0]?.address).toBe(starts[1]?.address);
      expect(starts.map((entry) => path.basename(String(entry.resumePath)))).toEqual([
        "session-one.jsonl",
        "session-two.jsonl",
      ]);
      expect(logs).toContainEqual(expect.objectContaining({
        type: "approve",
        body: expect.objectContaining({ id: "approval-1", allow: true }),
      }));
      expect(logs).toContainEqual({ type: "cancel" });
    } finally {
      await adapter.dispose();
    }
  }, 15_000);

});

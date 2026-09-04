import { describe, expect, test } from "bun:test";

import {
  AcpBridgeAdapter,
  type AcpTransport,
  type AcpTransportCallbacks,
  normalizeAcpSessionCandidates,
  selectAcpPermissionOption,
} from "../../src/bridge/bridge-adapters.acp.ts";
import { parseGrokChatHistory } from "../../src/bridge/bridge-adapters.grok.ts";
import {
  CodeBuddyAcpAdapter,
  buildCodeBuddyServeArgs,
  codeBuddyProjectDirectoryName,
  listCodeBuddySessions,
  parseCodeBuddyAcpSse,
  parseCodeBuddyTranscript,
  readCodeBuddySessionMessages,
  resolveCodeBuddySessionCwd,
} from "../../src/bridge/bridge-adapters.codebuddy.ts";
import { createBridgeAdapter } from "../../src/bridge/bridge-adapters.ts";
import { LocalCompanionProxyAdapter } from "../../src/bridge/bridge-adapters.core.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("ACP bridge helpers", () => {
  test("routes CodeBuddy through one visible HTTP owner", () => {
    const options = {
      kind: "codebuddy" as const,
      command: "codebuddy",
      cwd: "/tmp/codebuddy-project",
      profile: "reviewer",
      extraCliArgs: ["--permission-mode", "auto"],
    };
    expect(createBridgeAdapter(options)).toBeInstanceOf(LocalCompanionProxyAdapter);
    expect(createBridgeAdapter({ ...options, renderMode: "companion" })).toBeInstanceOf(CodeBuddyAcpAdapter);
    expect(buildCodeBuddyServeArgs(options, 43123)).toEqual([
      "--agent",
      "reviewer",
      "--permission-mode",
      "auto",
      "--serve",
      "--port",
      "43123",
      "--host",
      "127.0.0.1",
    ]);
  });

  test("parses CodeBuddy JSON-RPC messages from SSE blocks", () => {
    expect(parseCodeBuddyAcpSse([
      ":ok",
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","method":"session/update",',
      'data: "params":{"sessionId":"one"}}',
      "",
    ].join("\n"))).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "one" } },
    ]);
  });

  test("forwards and resolves CodeBuddy interruption approvals on the same HTTP owner", async () => {
    let callbacks: AcpTransportCallbacks | null = null;
    const sent: Record<string, unknown>[] = [];
    const adapter = new AcpBridgeAdapter({
      kind: "codebuddy",
      command: "codebuddy",
      cwd: "/tmp/codebuddy-approval",
      sessionStartMode: "new",
      renderMode: "companion",
    }, {
      kind: "codebuddy",
      buildArgs: () => [],
      createTransport: (_options, _cwd, _environment, transportCallbacks): AcpTransport => {
        callbacks = transportCallbacks;
        return {
          pid: 123,
          async start() {},
          async send(message) {
            sent.push(message);
            if (message.id === undefined) return;
            const result = message.method === "session/new"
              ? { sessionId: "codebuddy-session" }
              : {};
            queueMicrotask(() => transportCallbacks.message({
              jsonrpc: "2.0",
              id: message.id,
              result,
            }));
          },
          async dispose() {},
        };
      },
    });
    const events: unknown[] = [];
    adapter.setEventSink((event) => events.push(event));
    try {
      await adapter.start();
      callbacks!.message({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "codebuddy-session",
          update: {
            sessionUpdate: "interruption_request",
            interruptionId: "ir-tool-123",
            reason: "需要运行测试命令",
            options: ["allow", "allowAll", "deny"],
            toolName: "Bash",
            toolInput: { command: "npm test" },
          },
        },
      });
      expect(adapter.getState().status).toBe("awaiting_approval");
      expect(events).toContainEqual(expect.objectContaining({
        type: "approval_required",
        request: expect.objectContaining({
          threadId: "codebuddy-session",
          toolName: "Bash",
          allowForSession: true,
        }),
      }));
      expect(await adapter.resolveApprovalForSession()).toBe(true);
      expect(sent).toContainEqual(expect.objectContaining({
        method: "_codebuddy.ai/resolveInterruption",
        params: {
          sessionId: "codebuddy-session",
          toolCallId: "tool-123",
          decision: "allowAll",
        },
      }));
      expect(adapter.getState().status).toBe("busy");
    } finally {
      await adapter.dispose();
    }
  });

  test("does not create a replacement task when persisted ACP restore fails", async () => {
    const sentMethods: string[] = [];
    let disposed = false;
    const adapter = new AcpBridgeAdapter({
      kind: "codebuddy",
      command: "codebuddy",
      cwd: "/tmp/codebuddy-restore",
      sessionStartMode: "restore",
      initialSharedSessionId: "missing-session",
      renderMode: "companion",
    }, {
      kind: "codebuddy",
      buildArgs: () => [],
      createTransport: (_options, _cwd, _environment, callbacks): AcpTransport => ({
        async start() {},
        async send(message) {
          sentMethods.push(String(message.method));
          if (message.id === undefined) return;
          queueMicrotask(() => callbacks.message(
            message.method === "session/load"
              ? {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32001, message: "Session not found" },
                }
              : { jsonrpc: "2.0", id: message.id, result: {} },
          ));
        },
        async dispose() {
          disposed = true;
        },
      }),
    });

    await expect(adapter.start()).rejects.toThrow(/未新建替代任务/);
    expect(sentMethods).toEqual(["initialize", "session/load"]);
    expect(disposed).toBe(true);
    expect(adapter.getState().status).toBe("error");
  });

  test("selects once, session and deny permission options", () => {
    const options = [
      { optionId: "allow-once", kind: "allow_once" },
      { optionId: "allow-session", kind: "allow_always" },
      { optionId: "reject-once", kind: "reject_once" },
    ];
    expect(selectAcpPermissionOption(options, "confirm")?.optionId).toBe("allow-once");
    expect(selectAcpPermissionOption(options, "confirm_session")?.optionId).toBe("allow-session");
    expect(selectAcpPermissionOption(options, "deny")?.optionId).toBe("reject-once");
  });

  test("keeps ACP sessions across projects without treating cwd folders as project names", () => {
    const sessions = normalizeAcpSessionCandidates({
      sessions: [
        { sessionId: "older", cwd: "/repo", title: "旧任务", updatedAt: "2026-08-02T10:00:00Z" },
        { sessionId: "other", cwd: "/other", title: "其他项目", updatedAt: "2026-08-03T12:00:00Z" },
        { sessionId: "newer", cwd: "/repo/", title: "新任务", updatedAt: "2026-08-03T11:00:00Z" },
        {
          sessionId: "renamed",
          cwd: "/renamed-project",
          title: "自动标题",
          customTitle: "用户重命名",
          updatedAt: "2026-08-04T11:00:00Z",
        },
      ],
    }, "/repo", 10);

    expect(sessions.map((session) => session.sessionId)).toEqual([
      "renamed",
      "other",
      "newer",
      "older",
    ]);
    expect(sessions.find((session) => session.sessionId === "other")?.projectName)
      .toBeUndefined();
    expect(sessions[0]).toMatchObject({
      title: "用户重命名",
      projectName: "renamed-project",
    });
  });

  test("restarts the shared-owner transport in the selected task directory before loading it", async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codebuddy-acp-cwd-"));
    const initialCwd = path.join(tempDir, "initial");
    const sessionCwd = path.join(tempDir, "selected");
    const scriptPath = path.join(tempDir, "fake-acp.mjs");
    const logPath = path.join(tempDir, "fake-acp.log");
    await fs.promises.mkdir(initialCwd, { recursive: true });
    await fs.promises.mkdir(sessionCwd, { recursive: true });
    await fs.promises.writeFile(scriptPath, `
      import fs from "node:fs";
      import readline from "node:readline";
      const logPath = process.argv[2];
      const lines = readline.createInterface({ input: process.stdin });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.method === "session/new" || message.method === "session/load") {
          fs.appendFileSync(logPath, JSON.stringify({
            method: message.method,
            processCwd: process.cwd(),
            requestedCwd: message.params?.cwd,
          }) + "\\n");
        }
        const result = message.method === "session/new"
          ? { sessionId: "new-session" }
          : {};
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
      });
    `);
    const adapter = new AcpBridgeAdapter({
      kind: "codebuddy",
      command: process.execPath,
      cwd: initialCwd,
      sessionStartMode: "new",
      renderMode: "embedded",
    }, {
      kind: "codebuddy",
      buildArgs: () => [scriptPath, logPath],
      resolveSessionCwd: () => sessionCwd,
      restartProcessForSessionCwd: true,
    });
    try {
      await adapter.start();
      await adapter.resumeSession("stored-session");
      const realInitialCwd = await fs.promises.realpath(initialCwd);
      const realSessionCwd = await fs.promises.realpath(sessionCwd);
      const entries = (await fs.promises.readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, string>);
      const canonicalEntries = await Promise.all(entries.map(async (entry) => ({
        method: entry.method,
        processCwd: await fs.promises.realpath(entry.processCwd),
        requestedCwd: await fs.promises.realpath(entry.requestedCwd),
      })));
      expect(canonicalEntries).toEqual([
        {
          method: "session/new",
          processCwd: realInitialCwd,
          requestedCwd: realInitialCwd,
        },
        {
          method: "session/load",
          processCwd: realSessionCwd,
          requestedCwd: realSessionCwd,
        },
      ]);
    } finally {
      await adapter.dispose();
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });


  test("keeps real Grok user queries and assistant replies", () => {
    const messages = parseGrokChatHistory([
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<system-reminder>忽略</system-reminder>" }] }),
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>修复分页</user_query>" }] }),
      JSON.stringify({ type: "assistant", content: "已经修复。", model_id: "grok-4.5-build" }),
    ].join("\n"));
    expect(messages).toEqual([
      { role: "user", text: "修复分页" },
      {
        role: "assistant",
        text: "已经修复。",
        phase: "final_answer",
        model: "grok-4.5-build",
      },
    ]);
  });

  test("parses CodeBuddy transcripts and keeps the latest version of a message", () => {
    const messages = parseCodeBuddyTranscript([
      JSON.stringify({
        id: "user-1",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "修复历史任务" }],
      }),
      JSON.stringify({
        id: "assistant-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "处理中" }],
      }),
      JSON.stringify({
        id: "assistant-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "已经完成" }],
        providerData: { model: "claude-opus-4.8" },
      }),
    ].join("\n"));
    expect(messages).toEqual([
      { role: "user", text: "修复历史任务", id: "user-1" },
      {
        role: "assistant",
        text: "已经完成",
        id: "assistant-1",
        phase: "final_answer",
        model: "claude-opus-4.8",
      },
    ]);
  });

  test("preserves the filesystem root as a resumable CodeBuddy task directory", async () => {
    const configDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codebuddy-root-history-"));
    const sessionId = "44444444-4444-4444-8444-444444444444";
    const rootCwd = path.parse(configDir).root;
    await fs.promises.mkdir(path.join(configDir, "projects"), { recursive: true });
    await fs.promises.writeFile(
      path.join(configDir, "projects", `${sessionId}.jsonl`),
      JSON.stringify({
        id: `${sessionId}-user`,
        timestamp: 1_900_000_000_000,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "根目录任务" }],
        sessionId,
        cwd: rootCwd,
      }),
    );
    const previous = process.env.CODEBUDDY_CONFIG_DIR;
    process.env.CODEBUDDY_CONFIG_DIR = configDir;
    try {
      expect(resolveCodeBuddySessionCwd(sessionId)).toBe(rootCwd);
    } finally {
      if (previous === undefined) delete process.env.CODEBUDDY_CONFIG_DIR;
      else process.env.CODEBUDDY_CONFIG_DIR = previous;
      await fs.promises.rm(configDir, { recursive: true, force: true });
    }
  });

  test("lists and reads CodeBuddy sessions from the real project layout", async () => {
    const configDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codebuddy-history-"));
    const cwd = path.join(configDir, "demo-project");
    const projectDir = path.join(
      configDir,
      "projects",
      codeBuddyProjectDirectoryName(cwd),
    );
    await fs.promises.mkdir(projectDir, { recursive: true });
    const olderId = "11111111-1111-4111-8111-111111111111";
    const newerId = "22222222-2222-4222-8222-222222222222";
    const otherId = "33333333-3333-4333-8333-333333333333";
    const writeTranscript = async (
      file: string,
      sessionId: string,
      transcriptCwd: string,
      timestamp: number,
      text: string,
      customTitle?: string,
    ) => {
      await fs.promises.writeFile(file, [
        JSON.stringify({
          id: `${sessionId}-user`,
          timestamp,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
          sessionId,
          cwd: transcriptCwd,
        }),
        JSON.stringify({
          timestamp: timestamp + 10,
          type: "ai-title",
          aiTitle: `自动：${text}`,
          sessionId,
          cwd: transcriptCwd,
        }),
        ...(customTitle ? [JSON.stringify({
          timestamp: timestamp + 20,
          type: "custom-title",
          customTitle,
          sessionId,
          cwd: transcriptCwd,
        })] : []),
        JSON.stringify({
          id: `${sessionId}-assistant`,
          timestamp: timestamp + 100,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: `完成：${text}` }],
          sessionId,
          cwd: transcriptCwd,
        }),
      ].join("\n"));
    };
    await writeTranscript(
      path.join(projectDir, `${olderId}.jsonl`),
      olderId,
      cwd,
      1_700_000_000_000,
      "旧任务",
      "用户命名旧任务",
    );
    await writeTranscript(path.join(projectDir, `${newerId}.jsonl`), newerId, cwd, 1_800_000_000_000, "新任务");
    await writeTranscript(
      path.join(configDir, "projects", `${otherId}.jsonl`),
      otherId,
      path.join(configDir, "other-project"),
      1_900_000_000_000,
      "其他项目",
    );
    await fs.promises.writeFile(path.join(projectDir, `${otherId}.jsonl`), [
      JSON.stringify({
        id: `${otherId}-continued-user`,
        timestamp: 2_000_000_000_000,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "继续其他项目" }],
        sessionId: otherId,
        cwd,
      }),
      JSON.stringify({
        id: `${otherId}-continued-assistant`,
        timestamp: 2_000_000_000_100,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "完成：继续其他项目" }],
        sessionId: otherId,
        cwd,
      }),
    ].join("\n"));
    const previous = process.env.CODEBUDDY_CONFIG_DIR;
    process.env.CODEBUDDY_CONFIG_DIR = configDir;
    try {
      const sessions = await listCodeBuddySessions(cwd, 10);
      expect(sessions.map((session) => session.sessionId)).toEqual([
        otherId,
        newerId,
        olderId,
      ]);
      expect(sessions.map((session) => session.title)).toEqual([
        "自动：其他项目",
        "自动：新任务",
        "用户命名旧任务",
      ]);
      expect(sessions.map((session) => session.projectName)).toEqual([
        undefined,
        undefined,
        "demo-project",
      ]);
      expect(sessions[0]?.cwd).toBe(path.join(configDir, "other-project"));
      expect(await readCodeBuddySessionMessages(cwd, newerId)).toEqual([
        { role: "user", text: "新任务", id: `${newerId}-user` },
        {
          role: "assistant",
          text: "完成：新任务",
          id: `${newerId}-assistant`,
          phase: "final_answer",
        },
      ]);
      expect(await readCodeBuddySessionMessages(cwd, otherId)).toEqual([
        { role: "user", text: "其他项目", id: `${otherId}-user` },
        {
          role: "assistant",
          text: "完成：其他项目",
          id: `${otherId}-assistant`,
          phase: "final_answer",
        },
        { role: "user", text: "继续其他项目", id: `${otherId}-continued-user` },
        {
          role: "assistant",
          text: "完成：继续其他项目",
          id: `${otherId}-continued-assistant`,
          phase: "final_answer",
        },
      ]);
      expect(resolveCodeBuddySessionCwd(otherId)).toBe(
        path.join(configDir, "other-project"),
      );
    } finally {
      if (previous === undefined) delete process.env.CODEBUDDY_CONFIG_DIR;
      else process.env.CODEBUDDY_CONFIG_DIR = previous;
      await fs.promises.rm(configDir, { recursive: true, force: true });
    }
  });

});

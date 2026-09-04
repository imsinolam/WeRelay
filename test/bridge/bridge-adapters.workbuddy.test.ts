import crypto from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  WorkBuddyDesktopAdapter,
  WorkBuddyHybridRpcClient,
  buildWorkBuddyDesktopPromptScript,
  buildWorkBuddyDesktopTaskUrl,
  parseWorkBuddyTranscript,
  parseWorkBuddyTranscriptRunSummary,
  parseWorkBuddyTranscriptTitle,
  resolveWorkBuddySidecarSocketPath,
  type WorkBuddyAdapterDependencies,
} from "../../src/bridge/bridge-adapters.workbuddy.ts";
import type { BridgeEvent } from "../../src/bridge/bridge-types.ts";
import type {
  WorkBuddyDesktopRpcClientLike,
} from "../../src/bridge/workbuddy-desktop-rpc.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("WorkBuddy Desktop adapter", () => {
  test("reads and changes the real WorkBuddy task permission mode", async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const row = {
      id: "wb-permission",
      cwd: "/repo",
      title: "权限任务",
      customTitle: null,
      status: "completed",
      createdAt: 100,
      updatedAt: 200,
      lastActivityAt: 200,
      projectId: null,
      permissionMode: "acceptEdits",
    };
    const dependencies: WorkBuddyAdapterDependencies = {
      createDesktopClient: () => ({
        connect: async () => undefined,
        invoke: async (channel, ...args) => {
          calls.push({ channel, args });
          return {};
        },
        close: async () => undefined,
      }),
      listSessions: async () => [row],
      readSession: async () => row,
      readMessages: async () => [],
      readRunSummary: async () => null,
      readLocalImage: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }),
    };
    const adapter = new WorkBuddyDesktopAdapter({
      kind: "workbuddy",
      command: "workbuddy",
      cwd: "/repo",
      sessionStartMode: "restore",
    }, dependencies) as any;
    await adapter.start();

    expect(await adapter.getSessionPermissionState("wb-permission")).toMatchObject({
      currentPermission: "acceptEdits",
      canChange: true,
      options: [
        { id: "default" },
        { id: "acceptEdits" },
        { id: "fullAccess", requiresConfirmation: true },
        { id: "bypassPermissions", requiresConfirmation: true },
        { id: "plan" },
      ],
    });

    const next = await adapter.setSessionPermission("wb-permission", "fullAccess");
    expect(calls).toContainEqual({
      channel: "session:setMode",
      args: ["wb-permission", { modeId: "fullAccess" }],
    });
    expect(next.currentPermission).toBe("fullAccess");
  });

  test("does not change WorkBuddy permission while the task is running", async () => {
    const row = {
      id: "wb-running",
      cwd: "/repo",
      title: "运行中任务",
      customTitle: null,
      status: "working",
      createdAt: 100,
      updatedAt: 200,
      lastActivityAt: 200,
      projectId: null,
      permissionMode: "default",
    };
    const dependencies: WorkBuddyAdapterDependencies = {
      createDesktopClient: () => ({
        connect: async () => undefined,
        invoke: async () => ({}),
        close: async () => undefined,
      }),
      listSessions: async () => [row],
      readSession: async () => row,
      readMessages: async () => [],
      readRunSummary: async () => null,
      readLocalImage: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }),
    };
    const adapter = new WorkBuddyDesktopAdapter({
      kind: "workbuddy",
      command: "workbuddy",
      cwd: "/repo",
      sessionStartMode: "restore",
    }, dependencies) as any;
    await adapter.start();

    expect(await adapter.getSessionPermissionState("wb-running")).toMatchObject({
      currentPermission: "default",
      canChange: false,
      unavailableReason: "任务正在处理，完成或停止后再切换权限范围。",
    });
    await expect(
      adapter.setSessionPermission("wb-running", "acceptEdits"),
    ).rejects.toThrow("任务正在处理");
  });

  test("connects immediately without probing unrelated tasks when the persisted WorkBuddy task was deleted", async () => {
    const staleSessionId = "stale-session";
    const currentSession = {
      id: "current-session",
      cwd: "/repo/current",
      title: "当前有效任务",
      customTitle: null,
      status: "working",
      createdAt: 100,
      updatedAt: 300,
      lastActivityAt: 300,
      projectId: null,
    };
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    let closeCount = 0;
    const dependencies: WorkBuddyAdapterDependencies = {
      createDesktopClient: () => ({
        connect: async () => undefined,
        invoke: async (channel, ...args) => {
          calls.push({ channel, args });
          return true;
        },
        close: async () => {
          closeCount += 1;
        },
      }),
      listSessions: async () => [currentSession],
      readSession: async (sessionId) => sessionId === staleSessionId ? null : currentSession,
      readMessages: async () => [],
      readRunSummary: async () => null,
      readLocalImage: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }),
    };
    const adapter = new WorkBuddyDesktopAdapter({
      kind: "workbuddy",
      command: "workbuddy",
      cwd: "/repo",
      sessionStartMode: "restore",
      initialSharedSessionId: staleSessionId,
    }, dependencies);

    await adapter.start();

    expect(closeCount).toBe(0);
    expect(calls).toEqual([]);
    expect(adapter.getState()).toMatchObject({ status: "idle" });
    expect(adapter.getState().sharedSessionId).toBeUndefined();
    expect(adapter.getState().activeRuntimeSessionId).toBeUndefined();
  });

  test("keeps WorkBuddy connected without a selected task when startup restore has no valid fallback", async () => {
    let closeCount = 0;
    const dependencies: WorkBuddyAdapterDependencies = {
      createDesktopClient: () => ({
        connect: async () => undefined,
        invoke: async () => {
          throw new Error("不应加载已删除任务");
        },
        close: async () => {
          closeCount += 1;
        },
      }),
      listSessions: async () => [],
      readSession: async () => null,
      readMessages: async () => [],
      readRunSummary: async () => null,
      readLocalImage: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }),
    };
    const adapter = new WorkBuddyDesktopAdapter({
      kind: "workbuddy",
      command: "workbuddy",
      cwd: "/repo",
      sessionStartMode: "restore",
      initialSharedSessionId: "deleted-session",
    }, dependencies);

    await adapter.start();

    expect(closeCount).toBe(0);
    expect(adapter.getState()).toMatchObject({ status: "idle" });
    expect(adapter.getState().sharedSessionId).toBeUndefined();
    expect(adapter.getState().activeRuntimeSessionId).toBeUndefined();
  });

  test("stays connected without probing more tasks when WorkBuddy runtime rejects startup restore", async () => {
    const staleSession = {
      id: "runtime-missing-session",
      cwd: "/repo/stale",
      title: "运行时已失效",
      customTitle: null,
      status: "working",
      createdAt: 100,
      updatedAt: 400,
      lastActivityAt: 400,
      projectId: null,
    };
    const currentSession = {
      ...staleSession,
      id: "current-session",
      cwd: "/repo/current",
      title: "当前有效任务",
      updatedAt: 300,
      lastActivityAt: 300,
    };
    const loadedSessions: string[] = [];
    const loadTimeouts: number[] = [];
    const dependencies: WorkBuddyAdapterDependencies = {
      createDesktopClient: () => ({
        connect: async () => undefined,
        invoke: async () => true,
        invokeWithTimeout: async (channel, timeoutMs, ...args) => {
          if (channel === "session:load") {
            const sessionId = String(args[0]);
            loadedSessions.push(sessionId);
            loadTimeouts.push(timeoutMs);
            if (sessionId === staleSession.id) {
              throw new Error("conversation not found");
            }
          }
          return true;
        },
        close: async () => undefined,
      }),
      listSessions: async () => [staleSession, currentSession],
      readSession: async (sessionId) => (
        sessionId === staleSession.id ? staleSession : currentSession
      ),
      readMessages: async () => [],
      readRunSummary: async () => null,
      readLocalImage: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }),
    };
    const adapter = new WorkBuddyDesktopAdapter({
      kind: "workbuddy",
      command: "workbuddy",
      cwd: "/repo",
      sessionStartMode: "restore",
      initialSharedSessionId: staleSession.id,
    }, dependencies);

    await adapter.start();

    expect(loadedSessions).toEqual([staleSession.id]);
    expect(loadTimeouts).toEqual([5_000]);
    expect(adapter.getState()).toMatchObject({ status: "idle" });
    expect(adapter.getState().sharedSessionId).toBeUndefined();
    expect(adapter.getState().activeRuntimeSessionId).toBeUndefined();
  });

  test("probes an empty WorkBuddy composer before deciding focus failed", () => {
    const script = buildWorkBuddyDesktopPromptScript();

    expect(script).toContain("set clipboardProbe to item 3 of argv");
    expect(script).toContain("set the clipboard to clipboardProbe");
    expect(script).toContain('if composerText is not clipboardSentinel and composerText is not "" then error');
    expect(script).toContain("/usr/bin/pbpaste -Prefer html | /usr/bin/textutil -convert txt -stdin -stdout");
    expect(script).toContain("if composerProbeText is not clipboardProbe then error");
    expect(script).not.toContain("if composerText is clipboardSentinel then error");
  });

  test("reproduces the WorkBuddy sidecar socket path", () => {
    const configDir = "/Users/test/.workbuddy";
    const uid = 501;
    const uidHash = crypto.createHash("sha1").update(String(uid)).digest("hex").slice(0, 6);
    const instanceHash = crypto.createHash("sha1").update(configDir).digest("hex").slice(0, 12);
    expect(resolveWorkBuddySidecarSocketPath({
      configDir,
      uid,
      tmpDir: "/tmp/runtime",
      platform: "darwin",
    })).toBe(`/tmp/runtime/wb-${uidHash}/${instanceHash}/sidecar.sock`);
    expect(resolveWorkBuddySidecarSocketPath({
      configDir,
      platform: "win32",
    })).toBe(`\\\\.\\pipe\\workbuddy-${instanceHash}-sidecar-control`);
  });

  test("prefers WorkBuddy custom titles and falls back to the latest generated title", () => {
    expect(parseWorkBuddyTranscriptTitle([
      JSON.stringify({ type: "ai-title", aiTitle: "自动标题" }),
      JSON.stringify({ type: "custom-title", customTitle: "用户重命名" }),
      JSON.stringify({ type: "ai-title", aiTitle: "后续自动标题" }),
    ].join("\n"))).toBe("用户重命名");
    expect(parseWorkBuddyTranscriptTitle(
      JSON.stringify({ type: "ai-title", aiTitle: "战车模型模块化配置需求" }),
    )).toBe("战车模型模块化配置需求");
  });

  test("opens and attaches to the exact existing WorkBuddy task without restarting the app", async () => {
    const hookLaunchPermissions: boolean[] = [];
    const openedSessions: string[] = [];
    const desktopPrompts: string[] = [];
    const acpCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const desktopEvents: Array<{ channel: string; data: unknown }> = [];
    let targetVisible = false;
    const client = new WorkBuddyHybridRpcClient({
      allowDesktopApplicationLaunch: true,
      onEvent: (channel, data) => desktopEvents.push({ channel, data }),
    }, {
      desktopHookAvailable: () => false,
      createDesktopClient: (options) => {
        hookLaunchPermissions.push(options.allowDesktopApplicationLaunch === true);
        return {
          connect: async () => {
            throw new Error("不应重启 WorkBuddy");
          },
          invoke: async () => ({}),
          close: async () => undefined,
        };
      },
      listSidecarSessions: async () => targetVisible
        ? [{ sessionId: "target-session", acpEndpoint: "http://127.0.0.1:43123/api/v1/acp" }]
        : [{ sessionId: "__workbuddy_cli_host__-1", acpEndpoint: "http://127.0.0.1:43122/api/v1/acp" }],
      openDesktopSession: async (sessionId) => {
        openedSessions.push(sessionId);
      },
      sendDesktopPrompt: async (text) => {
        desktopPrompts.push(text);
        targetVisible = true;
      },
      readSession: async () => ({
        id: "target-session",
        cwd: "/repo",
        title: "目标任务",
        customTitle: null,
        status: "completed",
        createdAt: 1,
        updatedAt: targetVisible ? 2 : 1,
        lastActivityAt: targetVisible ? 2 : 1,
        projectId: null,
      }),
      readRunSummary: async () => targetVisible
        ? { status: "completed", startedAtMs: 2, completedAtMs: 3, durationMs: 1 }
        : { status: "completed", startedAtMs: 1, completedAtMs: 1, durationMs: 0 },
      createAcpClient: (_endpoint, callbacks) => ({
        connect: async () => {
          acpCalls.push({ method: "initialize", params: {} });
        },
        request: async (method, params) => {
          acpCalls.push({ method, params });
          if (method === "session/load") {
            callbacks.onNotification("session/update", {
              sessionId: "target-session",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "已收到" },
              },
            });
          }
          return {};
        },
        notify: async (method, params) => {
          acpCalls.push({ method, params });
        },
        respond: async () => undefined,
        close: async () => undefined,
      }),
      delay: async () => undefined,
      sessionReadyTimeoutMs: 100,
    });

    expect(buildWorkBuddyDesktopTaskUrl("target-session"))
      .toBe("workbuddy://chat/target-session");
    await client.connect();
    await client.invoke("session:load", "target-session", { cwd: "/repo" });
    await client.invoke("session:sendMessage", "target-session", {
      content: [{ type: "text", text: "继续处理" }],
    });

    expect(hookLaunchPermissions).toEqual([]);
    expect(openedSessions).toEqual(["target-session", "target-session"]);
    expect(desktopPrompts).toEqual(["继续处理"]);
    expect(acpCalls.map((call) => call.method)).toEqual([
      "initialize",
      "session/load",
    ]);
    expect(desktopEvents).toContainEqual({
      channel: "session:event:target-session",
      data: {
        sessionId: "target-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "已收到" },
        },
      },
    });
    await client.close();
  });

  test("switches WorkBuddy permission mode through the active sidecar session", async () => {
    const acpCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = new WorkBuddyHybridRpcClient({
      onEvent: () => undefined,
    }, {
      desktopHookAvailable: () => false,
      desktopApplicationRunning: () => true,
      listSidecarSessions: async () => [{
        sessionId: "target-session",
        acpEndpoint: "http://127.0.0.1:43123/api/v1/acp",
      }],
      openDesktopSession: async () => undefined,
      sendDesktopPrompt: async () => undefined,
      readSession: async () => ({
        id: "target-session",
        cwd: "/repo",
        title: "目标任务",
        customTitle: null,
        status: "completed",
        createdAt: 1,
        updatedAt: 2,
        lastActivityAt: 2,
        projectId: null,
        permissionMode: "default",
      }),
      readRunSummary: async () => null,
      createAcpClient: () => ({
        connect: async () => undefined,
        request: async (method, params) => {
          acpCalls.push({ method, params });
          return {};
        },
        notify: async () => undefined,
        respond: async () => undefined,
        close: async () => undefined,
      }),
      delay: async () => undefined,
      sessionReadyTimeoutMs: 100,
    });

    await client.connect();
    await client.invoke("session:load", "target-session", { cwd: "/repo" });
    await client.invoke("session:setMode", "target-session", { modeId: "acceptEdits" });

    expect(acpCalls).toContainEqual({
      method: "session/set_mode",
      params: { sessionId: "target-session", modeId: "acceptEdits" },
    });
    await client.close();
  });

  test("waits for the new WorkBuddy turn instead of treating the accepted idle snapshot as completed", async () => {
    let targetVisible = false;
    let sessionReadCount = 0;
    const client = new WorkBuddyHybridRpcClient({
      onEvent: () => undefined,
    }, {
      desktopHookAvailable: () => false,
      desktopApplicationRunning: () => true,
      listSidecarSessions: async () => targetVisible
        ? [{ sessionId: "target-session", acpEndpoint: "http://127.0.0.1:43123/api/v1/acp" }]
        : [{ sessionId: "__workbuddy_cli_host__-1", acpEndpoint: "http://127.0.0.1:43122/api/v1/acp" }],
      openDesktopSession: async () => undefined,
      sendDesktopPrompt: async () => {
        targetVisible = true;
      },
      readSession: async () => {
        sessionReadCount += 1;
        const phase = sessionReadCount === 1
          ? { status: "completed", activityAt: 1 }
          : sessionReadCount === 2
            ? { status: "completed", activityAt: 2 }
            : sessionReadCount === 3
              ? { status: "working", activityAt: 2 }
              : { status: "completed", activityAt: 3 };
        return {
          id: "target-session",
          cwd: "/repo",
          title: "目标任务",
          customTitle: null,
          status: phase.status,
          createdAt: 1,
          updatedAt: phase.activityAt,
          lastActivityAt: phase.activityAt,
          projectId: null,
        };
      },
      readRunSummary: async () => null,
      createAcpClient: () => ({
        connect: async () => undefined,
        request: async () => ({}),
        notify: async () => undefined,
        respond: async () => undefined,
        close: async () => undefined,
      }),
      delay: async () => undefined,
      sessionReadyTimeoutMs: 100,
      promptAcceptanceTimeoutMs: 100,
      promptCompletionTimeoutMs: 100,
    });

    await client.connect();
    await client.invoke("session:load", "target-session", { cwd: "/repo" });
    await client.invoke("session:sendMessage", "target-session", {
      content: [{ type: "text", text: "继续处理" }],
    });

    expect(sessionReadCount).toBe(4);
    await client.close();
  });

  test("reconnects an explicitly selected already-open WorkBuddy when neither desktop interface is ready", async () => {
    const launchPermissions: boolean[] = [];
    let desktopConnectCount = 0;
    const client = new WorkBuddyHybridRpcClient({
      allowDesktopApplicationLaunch: true,
      onEvent: () => undefined,
    }, {
      desktopHookAvailable: () => false,
      desktopApplicationRunning: () => true,
      createDesktopClient: (options) => {
        launchPermissions.push(options.allowDesktopApplicationLaunch === true);
        return {
          connect: async () => {
            desktopConnectCount += 1;
          },
          invoke: async () => ({}),
          close: async () => undefined,
        };
      },
      listSidecarSessions: async () => {
        throw new Error("sidecar unavailable");
      },
    });

    await client.connect();

    expect(launchPermissions).toEqual([true]);
    expect(desktopConnectCount).toBe(1);
    await client.close();
  });

  test("forwards WorkBuddy ACP approvals to the existing desktop task", async () => {
    let onRequest: ((id: string | number, method: string, params: unknown) => void) | null = null;
    const responses: Array<{ id: string | number; result: unknown }> = [];
    const events: Array<{ channel: string; data: unknown }> = [];
    const client = new WorkBuddyHybridRpcClient({
      onEvent: (channel, data) => events.push({ channel, data }),
    }, {
      desktopHookAvailable: () => false,
      desktopApplicationRunning: () => true,
      listSidecarSessions: async () => [{
        sessionId: "target-session",
        acpEndpoint: "http://127.0.0.1:43123/api/v1/acp",
      }],
      createAcpClient: (_endpoint, callbacks) => {
        onRequest = callbacks.onRequest;
        return {
          connect: async () => undefined,
          request: async () => ({}),
          notify: async () => undefined,
          respond: async (id, result) => responses.push({ id, result }),
          close: async () => undefined,
        };
      },
    });

    await client.connect();
    await client.invoke("session:load", "target-session", { cwd: "/repo" });
    onRequest?.(42, "session/request_permission", {
      sessionId: "target-session",
      options: [{ optionId: "allow_once", kind: "allow_once" }],
      toolCall: { title: "读取服务器状态" },
    });
    expect(events.at(-1)).toEqual({
      channel: "session:event:target-session",
      data: {
        sessionId: "target-session",
        type: "permissionRequest",
        requestId: "42",
        request: {
          sessionId: "target-session",
          options: [{ optionId: "allow_once", kind: "allow_once" }],
          toolCall: { title: "读取服务器状态" },
        },
      },
    });

    await client.invoke(
      "session:resolvePermission",
      "target-session",
      "42",
      "allow_once",
    );
    expect(responses).toEqual([{
      id: 42,
      result: { outcome: { outcome: "selected", optionId: "allow_once" } },
    }]);
    await client.close();
  });

  test("parses and replaces updated transcript messages by id", () => {
    const messages = parseWorkBuddyTranscript([
      JSON.stringify({
        id: "user-1",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "检查任务" }, { type: "input_image" }],
      }),
      JSON.stringify({
        id: "assistant-1",
        type: "message",
        role: "assistant",
        status: "running",
        content: [{ type: "output_text", text: "处理中" }],
      }),
      JSON.stringify({
        id: "assistant-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "已经完成" }],
        providerData: { model: "deepseek-v4-flash-ioa" },
      }),
    ].join("\n"));
    expect(messages).toEqual([
      { role: "user", text: "检查任务\n[图片]", id: "user-1" },
      {
        role: "assistant",
        text: "已经完成",
        id: "assistant-1",
        phase: "final_answer",
        model: "deepseek-v4-flash-ioa",
      },
    ]);
  });

  test("hides WorkBuddy injected context and keeps only the visible user query", () => {
    const messages = parseWorkBuddyTranscript(JSON.stringify({
      id: "user-real-owner",
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: [
          '<system-reminder data-role="user-context">',
          "大量桌面内部上下文",
          "</system-reminder>",
          "<user_query>请对比两版数据工具</user_query>",
        ].join("\n"),
      }, { type: "input_image" }],
    }));
    expect(messages).toEqual([{
      role: "user",
      text: "请对比两版数据工具\n[图片]",
      id: "user-real-owner",
    }]);
  });


  test("derives the latest turn duration instead of the whole desktop session age", () => {
    const summary = parseWorkBuddyTranscriptRunSummary([
      JSON.stringify({ type: "message", role: "user", timestamp: 1_000 }),
      JSON.stringify({ type: "message", role: "assistant", status: "completed", timestamp: 2_000 }),
      JSON.stringify({ type: "message", role: "user", timestamp: 10_000 }),
      JSON.stringify({ type: "message", role: "assistant", status: "completed", timestamp: 13_500 }),
    ].join("\n"));
    expect(summary).toEqual({
      status: "completed",
      startedAtMs: 10_000,
      completedAtMs: 13_500,
      durationMs: 3_500,
    });
  });

  test("forwards explicit desktop launch permission to the WorkBuddy client", async () => {
    let allowDesktopApplicationLaunch: boolean | undefined;
    const dependencies: WorkBuddyAdapterDependencies = {
      createDesktopClient: (options) => {
        allowDesktopApplicationLaunch = options.allowDesktopApplicationLaunch;
        return {
          connect: async () => undefined,
          invoke: async () => ({}),
          close: async () => undefined,
        };
      },
      listSessions: async () => [],
      readSession: async () => null,
      readMessages: async () => [],
      readRunSummary: async () => null,
      readLocalImage: async () => ({ data: "", mimeType: "image/png" }),
    };
    const adapter = new WorkBuddyDesktopAdapter({
      kind: "workbuddy",
      command: "workbuddy",
      cwd: "/repo",
      allowDesktopApplicationLaunch: true,
    }, dependencies);

    await adapter.start();
    expect(allowDesktopApplicationLaunch).toBe(true);
    await adapter.dispose();
  });

  test("uses the real desktop RPC owner instead of the isolated ACP prompt path", async () => {
    const promptResult = deferred<unknown>();
    let onEvent: ((channel: string, data: unknown) => void) | null = null;
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const client: WorkBuddyDesktopRpcClientLike = {
      connect: async () => undefined,
      invoke: async (channel, ...args) => {
        calls.push({ channel, args });
        if (channel === "session:sendMessage") return await promptResult.promise;
        return {};
      },
      close: async () => undefined,
    };
    const row = {
      id: "wb-session",
      cwd: "/repo",
      title: "真实任务",
      customTitle: null,
      status: "completed",
      createdAt: 100,
      updatedAt: 200,
      lastActivityAt: 200,
      projectId: null,
    };
    const listScopes: Array<string | undefined> = [];
    const dependencies: WorkBuddyAdapterDependencies = {
      createDesktopClient: (callbacks) => {
        onEvent = callbacks.onEvent;
        return client;
      },
      listSessions: async (cwd) => {
        listScopes.push(cwd);
        return [row];
      },
      readSession: async () => row,
      readMessages: async () => [],
      readRunSummary: async () => null,
      readLocalImage: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }),
    };
    const adapter = new WorkBuddyDesktopAdapter({
      kind: "workbuddy",
      command: "workbuddy",
      cwd: "/repo",
      sessionStartMode: "restore",
    }, dependencies);
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));

    await adapter.start();
    expect(listScopes).toEqual([undefined]);
    expect(calls[0]).toEqual({
      channel: "session:load",
      args: ["wb-session", { cwd: "/repo", forceRendererHistoryReplay: false }],
    });

    await adapter.sendInput("继续处理");
    expect(adapter.getState().status).toBe("busy");
    expect(calls.at(-1)?.channel).toBe("session:sendMessage");
    expect(calls.some((call) => call.channel === "session/prompt")).toBe(false);
    expect(calls.at(-1)?.args[0]).toBe("wb-session");
    expect(calls.at(-1)?.args[1]).toMatchObject({
      content: [{ type: "text", text: "继续处理" }],
      _meta: {
        "codebuddy.ai": {
          conversationId: "wb-session",
          emitSyntheticUserPromptLive: true,
          source: "werelay",
        },
      },
    });

    onEvent!("session:event:wb-session", {
      sessionId: "wb-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "处理完成" },
      },
    });
    promptResult.resolve({ stopReason: "end_turn" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.some((event) =>
      event.type === "final_reply" && event.text === "处理完成"
    )).toBe(true);
    expect(events.some((event) =>
      event.type === "task_complete" && event.threadId === "wb-session"
    )).toBe(true);
    expect(adapter.getState().status).toBe("idle");
  });

  test("does not silently fall back to an isolated ACP session when desktop send fails", async () => {
    const calls: string[] = [];
    const row = {
      id: "wb-session",
      cwd: "/repo",
      title: "真实任务",
      customTitle: null,
      status: "completed",
      createdAt: 100,
      updatedAt: 200,
      lastActivityAt: 200,
      projectId: null,
    };
    const dependencies: WorkBuddyAdapterDependencies = {
      createDesktopClient: () => ({
        connect: async () => undefined,
        invoke: async (channel) => {
          calls.push(channel);
          if (channel === "session:sendMessage") {
            throw new Error("desktop unavailable");
          }
          return {};
        },
        close: async () => undefined,
      }),
      listSessions: async () => [row],
      readSession: async () => row,
      readMessages: async () => [],
      readRunSummary: async () => null,
      readLocalImage: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }),
    };
    const adapter = new WorkBuddyDesktopAdapter({
      kind: "workbuddy",
      command: "workbuddy",
      cwd: "/repo",
      sessionStartMode: "restore",
    }, dependencies);
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));

    await adapter.start();
    await adapter.sendInput("继续处理");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual(["session:load", "session:sendMessage"]);
    expect(events.some((event) =>
      event.type === "task_failed" && event.message.includes("desktop unavailable")
    )).toBe(true);
  });

  test("forwards desktop permission requests and resolves them through WorkBuddy RPC", async () => {
    let onEvent: ((channel: string, data: unknown) => void) | null = null;
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const row = {
      id: "wb-session",
      cwd: "/repo",
      title: "审批任务",
      customTitle: null,
      status: "running",
      createdAt: 100,
      updatedAt: 200,
      lastActivityAt: 200,
      projectId: null,
    };
    const dependencies: WorkBuddyAdapterDependencies = {
      createDesktopClient: (callbacks) => {
        onEvent = callbacks.onEvent;
        return {
          connect: async () => undefined,
          invoke: async (channel, ...args) => {
            calls.push({ channel, args });
            return true;
          },
          close: async () => undefined,
        };
      },
      listSessions: async () => [row],
      readSession: async () => row,
      readMessages: async () => [],
      readRunSummary: async () => null,
      readLocalImage: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }),
    };
    const adapter = new WorkBuddyDesktopAdapter({
      kind: "workbuddy",
      command: "workbuddy",
      cwd: "/repo",
      sessionStartMode: "restore",
    }, dependencies);
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));

    await adapter.start();
    onEvent!("session:event:wb-session", {
      type: "permissionRequest",
      sessionId: "wb-session",
      requestId: "permission-1",
      request: {
        options: [
          { optionId: "allow-once", name: "允许一次", kind: "allow_once" },
          { optionId: "reject-once", name: "拒绝", kind: "reject_once" },
          { optionId: "allow-always", name: "本任务始终允许", kind: "allow_always" },
        ],
        toolCall: {
          toolCallId: "tool-1",
          title: "运行命令",
          rawInput: { command: "npm test" },
        },
      },
    });

    expect(adapter.getState().status).toBe("awaiting_approval");
    expect(events.some((event) =>
      event.type === "approval_required" &&
      event.request.requestId === "permission-1" &&
      event.request.threadId === "wb-session"
    )).toBe(true);

    expect(await adapter.resolveApprovalForSession()).toBe(true);
    expect(calls.at(-1)).toEqual({
      channel: "session:resolvePermission",
      args: ["wb-session", "permission-1", "allow-always"],
    });
    expect(adapter.getState().pendingApproval).toBeNull();
  });

  test("routes AskUserQuestion permission envelopes to user input and returns structured answers", async () => {
    let onEvent: ((channel: string, data: unknown) => void) | null = null;
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const row = {
      id: "wb-session",
      cwd: "/repo",
      title: null,
      customTitle: null,
      status: "working",
      createdAt: 100,
      updatedAt: 200,
      lastActivityAt: 200,
      projectId: null,
    };
    const dependencies: WorkBuddyAdapterDependencies = {
      createDesktopClient: (callbacks) => {
        onEvent = callbacks.onEvent;
        return {
          connect: async () => undefined,
          invoke: async (channel, ...args) => {
            calls.push({ channel, args });
            return true;
          },
          close: async () => undefined,
        };
      },
      listSessions: async () => [row],
      readSession: async () => row,
      readMessages: async () => [],
      readRunSummary: async () => null,
      readSessionTitle: async () => "战车配置器",
      readLocalImage: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }),
    };
    const adapter = new WorkBuddyDesktopAdapter({
      kind: "workbuddy",
      command: "workbuddy",
      cwd: "/repo",
      sessionStartMode: "restore",
    }, dependencies);
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));

    await adapter.start();
    onEvent!("session:event:wb-session", {
      type: "permissionRequest",
      sessionId: "wb-session",
      requestId: "call-question-1",
      request: {
        options: [
          { optionId: "allow", name: "允许", kind: "allow_once" },
          { optionId: "reject", name: "拒绝", kind: "reject_once" },
        ],
        toolCall: {
          toolCallId: "call-question-1",
          rawInput: {
            questions: [
              {
                question: "想要哪种交付形态？",
                header: "交付形态",
                options: [
                  { label: "网页3D配置器", description: "可旋转缩放" },
                  { label: "3D模型文件", description: "输出 GLB" },
                ],
              },
              {
                question: "需要配置哪些部分？",
                header: "配置维度",
                multiSelect: true,
                options: [
                  { label: "车身底盘", description: "底盘与装甲" },
                  { label: "炮塔与主炮", description: "炮塔与武器" },
                ],
              },
            ],
          },
        },
      },
    });

    expect(adapter.getState().status).toBe("awaiting_input");
    expect(adapter.getState().pendingApproval).toBeNull();
    expect(adapter.getState().pendingUserInput?.questions).toEqual([
      {
        id: "q_0",
        header: "交付形态",
        question: "想要哪种交付形态？",
        isOther: false,
        isSecret: false,
        multiSelect: false,
        options: [
          { label: "网页3D配置器", description: "可旋转缩放" },
          { label: "3D模型文件", description: "输出 GLB" },
        ],
      },
      {
        id: "q_1",
        header: "配置维度",
        question: "需要配置哪些部分？",
        isOther: false,
        isSecret: false,
        multiSelect: true,
        options: [
          { label: "车身底盘", description: "底盘与装甲" },
          { label: "炮塔与主炮", description: "炮塔与武器" },
        ],
      },
    ]);
    expect(events.some((event) => event.type === "approval_required")).toBe(false);
    expect(events.some((event) =>
      event.type === "user_input_required" &&
      event.request.threadId === "wb-session"
    )).toBe(true);
    expect((await adapter.listResumeSessions(10))[0]?.title).toBe("战车配置器");
    expect((await adapter.listResumeSessions(10))[0]?.runtimeStatus).toEqual({
      type: "active",
      activeFlags: ["waitingOnUserInput"],
    });
    expect(await adapter.resolveApprovalForSession()).toBe(false);

    expect(await adapter.submitUserInput({
      q_0: ["网页3D配置器"],
      q_1: ["车身底盘", "炮塔与主炮"],
    })).toBe(true);
    expect(calls.at(-1)).toEqual({
      channel: "session:answerQuestion",
      args: ["wb-session", "call-question-1", {
        q_0: "网页3D配置器",
        q_1: ["车身底盘", "炮塔与主炮"],
      }],
    });
    expect(adapter.getState().pendingUserInput).toBeNull();
  });

  test("keeps replayed AskUserQuestion pending after startup session restore", async () => {
    let onEvent: ((channel: string, data: unknown) => void) | null = null;
    const row = {
      id: "wb-session",
      cwd: "/repo",
      title: "等待补充信息",
      customTitle: null,
      status: "working",
      createdAt: 100,
      updatedAt: 200,
      lastActivityAt: 200,
      projectId: null,
    };
    const dependencies: WorkBuddyAdapterDependencies = {
      createDesktopClient: (callbacks) => {
        onEvent = callbacks.onEvent;
        return {
          connect: async () => undefined,
          invoke: async (channel) => {
            if (channel === "session:load") {
              onEvent!("session:event:wb-session", {
                type: "permissionRequest",
                sessionId: "wb-session",
                requestId: "call-question-on-restore",
                request: {
                  toolCall: {
                    toolCallId: "call-question-on-restore",
                    name: "AskUserQuestion",
                    rawInput: {
                      questions: [{
                        question: "请选择输出格式",
                        options: [{ label: "Markdown" }, { label: "PDF" }],
                      }],
                    },
                  },
                },
              });
            }
            return true;
          },
          close: async () => undefined,
        };
      },
      listSessions: async () => [row],
      readSession: async () => row,
      readMessages: async () => [],
      readRunSummary: async () => null,
      readLocalImage: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }),
    };
    const adapter = new WorkBuddyDesktopAdapter({
      kind: "workbuddy",
      command: "workbuddy",
      cwd: "/repo",
      sessionStartMode: "restore",
    }, dependencies);

    await adapter.start();

    expect(adapter.getState().status).toBe("awaiting_input");
    expect(adapter.getState().pendingUserInput?.questions[0]?.question)
      .toBe("请选择输出格式");
    expect(adapter.getState().pendingApproval).toBeNull();
  });

  test("ignores replayed desktop output until a relay turn is actually running", async () => {
    let onEvent: ((channel: string, data: unknown) => void) | null = null;
    const row = {
      id: "wb-session",
      cwd: "/repo",
      title: "历史任务",
      customTitle: null,
      status: "completed",
      createdAt: 100,
      updatedAt: 200,
      lastActivityAt: 200,
      projectId: null,
    };
    const dependencies: WorkBuddyAdapterDependencies = {
      createDesktopClient: (callbacks) => {
        onEvent = callbacks.onEvent;
        return {
          connect: async () => undefined,
          invoke: async () => ({}),
          close: async () => undefined,
        };
      },
      listSessions: async () => [row],
      readSession: async () => row,
      readMessages: async () => [],
      readRunSummary: async () => null,
      readLocalImage: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }),
    };
    const adapter = new WorkBuddyDesktopAdapter({
      kind: "workbuddy",
      command: "workbuddy",
      cwd: "/repo",
      sessionStartMode: "restore",
    }, dependencies);
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));

    await adapter.start();
    onEvent!("session:event:wb-session", {
      sessionId: "wb-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "不应乱入的历史输出" },
      },
    });

    expect(events.some((event) =>
      (event.type === "thinking" || event.type === "final_reply") &&
      "text" in event && event.text.includes("不应乱入")
    )).toBe(false);
  });
  test("creates and loads a real WorkBuddy desktop task", async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = [];
    const createdRow = {
      id: "wb-created", cwd: "/repo", title: "新任务", customTitle: null,
      status: "completed", createdAt: 300, updatedAt: 300, lastActivityAt: 300, projectId: null,
    };
    const dependencies: WorkBuddyAdapterDependencies = {
      createDesktopClient: () => ({
        connect: async () => undefined,
        invoke: async (channel, ...args) => {
          calls.push({ channel, args });
          if (channel === "session:create") return { sessionId: "wb-created", cwd: "/repo" };
          return {};
        },
        close: async () => undefined,
      }),
      listSessions: async () => [],
      readSession: async (sessionId) => sessionId === "wb-created" ? createdRow : null,
      readMessages: async () => [],
      readRunSummary: async () => null,
      readLocalImage: async () => ({ data: "aW1hZ2U=", mimeType: "image/png" }),
    };
    const adapter = new WorkBuddyDesktopAdapter({
      kind: "workbuddy", command: "workbuddy", cwd: "/repo", sessionStartMode: "restore",
    }, dependencies);
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));
    await adapter.start();

    await adapter.createSession();

    expect(calls).toContainEqual({ channel: "session:create", args: [{ cwd: "/repo" }] });
    expect(calls).toContainEqual({
      channel: "session:load",
      args: ["wb-created", { cwd: "/repo", forceRendererHistoryReplay: false }],
    });
    expect(adapter.getState().sharedSessionId).toBe("wb-created");
    expect(events.some((event) => event.type === "session_switched" && event.sessionId === "wb-created")).toBe(true);
  });

});

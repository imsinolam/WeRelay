import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  CodexDesktopIpcClient,
  applyCodexDesktopStatePatches,
  buildCodexDesktopThreadUrl,
  compactCodexDesktopConversationState,
  encodeCodexDesktopIpcMessage,
  isWindowsNamedPipePath,
} from "../../src/bridge/codex-desktop-ipc.ts";

const cleanupPaths: string[] = [];
const cleanupServers: net.Server[] = [];
const cleanupSockets: net.Socket[] = [];

afterEach(async () => {
  for (const socket of cleanupSockets.splice(0)) {
    socket.destroy();
  }
  for (const server of cleanupServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const target of cleanupPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

function createFrameReader(onMessage: (message: Record<string, unknown>) => void) {
  let buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) {
        return;
      }
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      onMessage(JSON.parse(body.toString("utf8")) as Record<string, unknown>);
    }
  };
}

async function createMockRouter(
  handleMessage: (
    socket: net.Socket,
    message: Record<string, unknown>,
  ) => void,
): Promise<{ socketPath: string; server: net.Server }> {
  const dir = process.platform === "win32"
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), "codex-desktop-ipc-test-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\werelay-codex-ipc-${process.pid}-${crypto.randomUUID()}`
    : path.join(dir!, "ipc.sock");
  if (dir) cleanupPaths.push(dir);
  const server = net.createServer((socket) => {
    cleanupSockets.push(socket);
    socket.on("data", createFrameReader((message) => handleMessage(socket, message)));
  });
  cleanupServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, server };
}

function sendFrame(socket: net.Socket, message: Record<string, unknown>): void {
  socket.write(encodeCodexDesktopIpcMessage(message));
}

describe("Codex desktop IPC framing and state", () => {
  test("recognizes Windows named pipes without requiring a filesystem entry", () => {
    expect(isWindowsNamedPipePath("\\\\.\\pipe\\werelay-codex-ipc")).toBe(true);
    expect(isWindowsNamedPipePath("\\\\?\\pipe\\werelay-codex-ipc")).toBe(true);
    expect(isWindowsNamedPipePath("/tmp/codex-ipc.sock")).toBe(false);
  });

  test("builds the native Codex thread deep link", () => {
    expect(buildCodexDesktopThreadUrl("0000000a-0000-7000-8000-00000000000a")).toBe(
      "codex://threads/0000000a-0000-7000-8000-00000000000a",
    );
  });

  test("applies desktop state add, replace, and remove patches", () => {
    const unchangedLargeBranch = {
      items: Array.from({ length: 100 }, (_, index) => ({ index })),
    };
    const state = {
      requests: [],
      status: { type: "idle" },
      values: ["a", "c"],
      unchangedLargeBranch,
    };

    const next = applyCodexDesktopStatePatches(state, [
      { op: "add", path: ["values", 1], value: "b" },
      { op: "replace", path: ["status"], value: { type: "active" } },
      { op: "add", path: ["requests", 0], value: { id: 1 } },
      { op: "remove", path: ["values", 0] },
    ]);

    expect(next).toEqual({
      requests: [{ id: 1 }],
      status: { type: "active" },
      values: ["b", "c"],
      unchangedLargeBranch,
    });
    expect(next.unchangedLargeBranch).toBe(unchangedLargeBranch);
    expect(state.values).toEqual(["a", "c"]);
  });

  test("keeps approval and model fields for summary subscriptions", () => {
    const requests = [{
      id: 2,
      method: "mcpServer/elicitation/request",
      params: { threadId: "thread-1", turnId: "turn-1" },
    }];
    expect(compactCodexDesktopConversationState({
      cwd: "/tmp/project",
      updatedAt: 123,
      threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] },
      requests,
      modelProvider: "custom",
      latestModel: "gpt-5.6-sol",
      latestReasoningEffort: "high",
      latestThreadSettings: { model: "gpt-5.6-sol", effort: "high" },
      turnHistory: {
        history: {
          entitiesByKey: {
            huge: { items: Array.from({ length: 10_000 }, () => ({ text: "large" })) },
          },
        },
      },
    })).toEqual({
      cwd: "/tmp/project",
      updatedAt: 123,
      threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] },
      requests,
      modelProvider: "custom",
      latestModel: "gpt-5.6-sol",
      latestReasoningEffort: "high",
      latestThreadSettings: { model: "gpt-5.6-sol", effort: "high" },
    });
  });
});

describe("Codex desktop IPC client", () => {
  test("registers, follows a desktop task, and consumes its state snapshot", async () => {
    const received: Record<string, unknown>[] = [];
    const { socketPath } = await createMockRouter((socket, message) => {
      received.push(message);
      if (message.type === "request" && message.method === "initialize") {
        sendFrame(socket, {
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: "initialize",
          handledByClientId: "router",
          result: { clientId: "bridge-client" },
        });
        return;
      }
      if (
        message.type === "broadcast" &&
        message.method === "thread-stream-following-changed"
      ) {
        sendFrame(socket, {
          type: "broadcast",
          method: "thread-stream-state-changed",
          sourceClientId: "desktop-owner",
          version: 11,
          params: {
            conversationId: "thread-1",
            hostId: "local",
            change: {
              type: "snapshot",
              revision: 1,
              conversationState: {
                id: "thread-1",
                requests: [],
                threadRuntimeStatus: { type: "idle" },
              },
            },
          },
        });
      }
    });
    const client = new CodexDesktopIpcClient({
      socketPath,
      openThread: async () => undefined,
      reconnectDelayMs: 10,
    });

    const state = await client.openAndFollowThread("thread-1", { timeoutMs: 2_000 });

    expect(state).toMatchObject({
      id: "thread-1",
      threadRuntimeStatus: { type: "idle" },
    });
    expect(
      received.some(
        (message) =>
          message.type === "broadcast" &&
          message.method === "thread-stream-following-changed" &&
          (message.params as Record<string, unknown>).following === true,
      ),
    ).toBe(true);
    await client.dispose();
  });

  test("reuses cached followed state without waiting for another snapshot", async () => {
    let followCount = 0;
    const { socketPath } = await createMockRouter((socket, message) => {
      if (message.type === "request" && message.method === "initialize") {
        sendFrame(socket, {
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: "initialize",
          result: { clientId: "bridge-client" },
        });
        return;
      }
      if (
        message.type === "broadcast" &&
        message.method === "thread-stream-following-changed"
      ) {
        followCount += 1;
        if (followCount === 1) {
          sendFrame(socket, {
            type: "broadcast",
            method: "thread-stream-state-changed",
            sourceClientId: "desktop-owner",
            version: 11,
            params: {
              conversationId: "thread-cached",
              hostId: "local",
              change: {
                type: "snapshot",
                revision: 1,
                conversationState: {
                  id: "thread-cached",
                  cwd: "/repo/cached",
                  threadRuntimeStatus: { type: "idle" },
                },
              },
            },
          });
        }
      }
    });
    const client = new CodexDesktopIpcClient({
      socketPath,
      openThread: async () => undefined,
      requestTimeoutMs: 100,
    });

    await client.openAndFollowThread("thread-cached", { timeoutMs: 100 });
    const cached = await client.openAndFollowThread("thread-cached", {
      timeoutMs: 100,
    });

    expect(cached).toMatchObject({ id: "thread-cached", cwd: "/repo/cached" });
    expect(followCount).toBe(1);
    await client.dispose();
  });

  test("does not broadcast repeated unfollow requests for an unsubscribed task", async () => {
    const received: Record<string, unknown>[] = [];
    const { socketPath } = await createMockRouter((socket, message) => {
      received.push(message);
      if (message.type === "request" && message.method === "initialize") {
        sendFrame(socket, {
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: "initialize",
          result: { clientId: "bridge-client" },
        });
      }
    });
    const client = new CodexDesktopIpcClient({ socketPath });

    await client.connect();
    await client.unfollowThread("thread-idle");
    await client.followThread("thread-idle", { retention: "summary" });
    await client.unfollowThread("thread-idle");
    await client.unfollowThread("thread-idle");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(received.filter(
      (message) =>
        message.type === "broadcast" &&
        message.method === "thread-stream-following-changed" &&
        (message.params as Record<string, unknown>).following === false,
    )).toHaveLength(1);
    await client.dispose();
  });

  test("retries following when the desktop owner delays its state snapshot", async () => {
    let followCount = 0;
    const { socketPath } = await createMockRouter((socket, message) => {
      if (message.type === "request" && message.method === "initialize") {
        sendFrame(socket, {
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: "initialize",
          result: { clientId: "bridge-client" },
        });
        return;
      }
      if (
        message.type === "broadcast" &&
        message.method === "thread-stream-following-changed"
      ) {
        followCount += 1;
        if (followCount === 3) {
          sendFrame(socket, {
            type: "broadcast",
            method: "thread-stream-state-changed",
            sourceClientId: "desktop-owner",
            version: 11,
            params: {
              conversationId: "thread-retry",
              hostId: "local",
              change: {
                type: "snapshot",
                revision: 1,
                conversationState: {
                  id: "thread-retry",
                  threadRuntimeStatus: { type: "idle" },
                },
              },
            },
          });
        }
      }
    });
    const client = new CodexDesktopIpcClient({
      socketPath,
      openThread: async () => undefined,
      requestTimeoutMs: 900,
    });

    const state = await client.openAndFollowThread("thread-retry", {
      timeoutMs: 900,
    });

    expect(state).toMatchObject({ id: "thread-retry" });
    expect(followCount).toBe(3);
    await client.dispose();
  });

  test("starts a turn through the desktop owner instead of app-server", async () => {
    const requests: Record<string, unknown>[] = [];
    const { socketPath } = await createMockRouter((socket, message) => {
      if (message.type !== "request") {
        return;
      }
      requests.push(message);
      if (message.method === "initialize") {
        sendFrame(socket, {
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: "initialize",
          result: { clientId: "bridge-client" },
        });
        return;
      }
      if (message.method === "thread-follower-start-turn") {
        const params = message.params as Record<string, unknown>;
        const turnStart = params.turnStart as Record<string, unknown> | undefined;
        const request = turnStart?.request as Record<string, unknown> | undefined;
        if (
          message.version !== 2 ||
          request?.threadId !== "thread-1" ||
          !Array.isArray(request.input)
        ) {
          return;
        }
        sendFrame(socket, {
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: message.method,
          handledByClientId: "desktop-owner",
          result: {
            result: {
              turn: {
                id: "turn-1",
                status: "inProgress",
                items: [],
              },
            },
          },
        });
      }
    });
    const client = new CodexDesktopIpcClient({ socketPath });

    const turn = await client.startTurn("thread-1", [
      { type: "text", text: "真实桌面消息" },
      { type: "localImage", path: "/tmp/mobile-image.png" },
    ], {
      model: "gpt-5.6-terra",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" },
    });

    expect(turn).toMatchObject({ id: "turn-1", status: "inProgress" });
    expect(
      requests.find((request) => request.method === "thread-follower-start-turn"),
    ).toMatchObject({
      version: 2,
      params: {
        conversationId: "thread-1",
        turnStart: {
          request: {
            threadId: "thread-1",
            input: [
              { type: "text", text: "真实桌面消息" },
              { type: "localImage", path: "/tmp/mobile-image.png" },
            ],
            model: "gpt-5.6-terra",
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandbox: "danger-full-access",
            sandboxPolicy: { type: "dangerFullAccess" },
          },
        },
      },
    });
    await client.dispose();
  });

  test("accepts a desktop turn when live state confirms it before the owner replies", async () => {
    const { socketPath } = await createMockRouter((socket, message) => {
      if (message.type !== "request") {
        return;
      }
      if (message.method === "initialize") {
        sendFrame(socket, {
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: "initialize",
          result: { clientId: "bridge-client" },
        });
        return;
      }
      if (message.method === "thread-follower-start-turn") {
        setTimeout(() => {
          sendFrame(socket, {
            type: "broadcast",
            method: "thread-stream-state-changed",
            sourceClientId: "desktop-owner",
            version: 11,
            params: {
              conversationId: "thread-confirmed",
              hostId: "local",
              change: {
                type: "snapshot",
                revision: 1,
                conversationState: {
                  id: "thread-confirmed",
                  threadRuntimeStatus: { type: "active", activeFlags: [] },
                  turnHistory: {
                    history: {
                      entitiesByKey: {
                        "tail:turn-confirmed": {
                          turnId: "turn-confirmed",
                          status: "inProgress",
                          items: [],
                        },
                      },
                    },
                  },
                },
              },
            },
          });
        }, 10);
      }
    });
    const client = new CodexDesktopIpcClient({
      socketPath,
      requestTimeoutMs: 100,
    });

    const turn = await client.startTurn("thread-confirmed", "已经被桌面端接收");

    expect(turn).toMatchObject({
      id: "turn-confirmed",
      status: "inProgress",
    });
    await client.dispose();
  });

  test("reports an unconfirmed start without claiming the message failed", async () => {
    const { socketPath } = await createMockRouter((socket, message) => {
      if (message.type === "request" && message.method === "initialize") {
        sendFrame(socket, {
          type: "response",
          requestId: message.requestId,
          resultType: "success",
          method: "initialize",
          result: { clientId: "bridge-client" },
        });
      }
    });
    const client = new CodexDesktopIpcClient({
      socketPath,
      requestTimeoutMs: 100,
    });

    await expect(
      client.startTurn("thread-unconfirmed", "等待桌面端确认"),
    ).rejects.toThrow("Codex 暂未确认收到这条消息，请先查看任务状态，避免重复发送。");
    await client.dispose();
  });

  test("syncs and steers the desktop native follow-up queue", async () => {
    const requests: Record<string, unknown>[] = [];
    const { socketPath } = await createMockRouter((socket, message) => {
      if (message.type !== "request") {
        return;
      }
      requests.push(message);
      sendFrame(socket, {
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: message.method,
        result: message.method === "initialize"
          ? { clientId: "bridge-client" }
          : { ok: true },
      });
    });
    const client = new CodexDesktopIpcClient({ socketPath });
    const queuedMessage = {
      id: "queued-1",
      text: "等待发送",
      context: { prompt: "等待发送", imageAttachments: [] },
      cwd: "/tmp/project",
      createdAt: 1_800_000_000_000,
    };

    await client.setQueuedFollowUpsState("thread-1", {
      "thread-1": [queuedMessage],
    });
    await client.steerTurn(
      "thread-1",
      [{ type: "text", text: "等待发送" }],
      queuedMessage,
    );

    expect(requests.find(
      (request) => request.method === "thread-follower-set-queued-follow-ups-state",
    )).toMatchObject({
      version: 1,
      params: {
        conversationId: "thread-1",
        state: { "thread-1": [queuedMessage] },
      },
    });
    expect(requests.find(
      (request) => request.method === "thread-follower-steer-turn",
    )).toMatchObject({
      version: 1,
      params: {
        conversationId: "thread-1",
        input: [{ type: "text", text: "等待发送" }],
        restoreMessage: queuedMessage,
        clientUserMessageId: "queued-1",
      },
    });
    await client.dispose();
  });

  test("routes approval, MCP elicitation, and user input responses to the desktop owner", async () => {
    const requests: Record<string, unknown>[] = [];
    const { socketPath } = await createMockRouter((socket, message) => {
      if (message.type !== "request") {
        return;
      }
      requests.push(message);
      sendFrame(socket, {
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: message.method,
        result:
          message.method === "initialize"
            ? { clientId: "bridge-client" }
            : { ok: true },
      });
    });
    const client = new CodexDesktopIpcClient({ socketPath });

    await client.replyToCommandApproval("thread-1", 7, "acceptForSession");
    await client.replyToMcpServerElicitation("thread-1", 9, {
      action: "accept",
      content: null,
      _meta: { persist: "always" },
    });
    await client.submitUserInput("thread-1", 8, {
      answer: { answers: ["继续"] },
    });

    expect(
      requests.find(
        (request) => request.method === "thread-follower-command-approval-decision",
      ),
    ).toMatchObject({
      version: 1,
      params: {
        conversationId: "thread-1",
        requestId: 7,
        decision: "acceptForSession",
      },
    });
    expect(
      requests.find(
        (request) =>
          request.method === "thread-follower-submit-mcp-server-elicitation-response",
      ),
    ).toMatchObject({
      version: 1,
      params: {
        conversationId: "thread-1",
        requestId: 9,
        response: {
          action: "accept",
          content: null,
          _meta: { persist: "always" },
        },
      },
    });
    expect(
      requests.find(
        (request) => request.method === "thread-follower-submit-user-input",
      ),
    ).toMatchObject({
      version: 1,
      params: {
        conversationId: "thread-1",
        requestId: 8,
        response: {
          answers: {
            answer: { answers: ["继续"] },
          },
        },
      },
    });
    await client.dispose();
  });
});

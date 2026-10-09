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
import { classifyMobileSendFailure, MobileMessageOutbox } from "../../src/daemon/mobile-message-outbox.ts";
import {
  isMobileMessageDeliveryUncertain,
  prepareMobileMessageRetry,
  shouldRetryMobileMessage,
} from "../../src/daemon/mobile-message-recovery.ts";

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

function sendState(
  socket: net.Socket,
  threadId: string,
  change: Record<string, unknown>,
): void {
  sendFrame(socket, {
    type: "broadcast", method: "thread-stream-state-changed", version: 11,
    sourceClientId: "desktop-owner",
    params: { conversationId: threadId, hostId: "local", change },
  });
}

function receiptState(turnId: string, input: unknown, status = "inProgress") {
  return {
    threadRuntimeStatus: { type: status === "inProgress" ? "active" : "idle" },
    turnHistory: { history: { entitiesByKey: {
      [`tail:${turnId}`]: { turnId, status, params: { input }, items: [] as unknown[] },
    } } },
  };
}

async function createStartTurnRouter(
  handleMessage: (socket: net.Socket, message: Record<string, unknown>) => void,
  baseline: Record<string, unknown> = { threadRuntimeStatus: { type: "idle" } },
) {
  return await createMockRouter((socket, message) => {
    if (message.type === "broadcast" && message.method === "thread-stream-following-changed" &&
      (message.params as Record<string, unknown>).following === true) {
      sendState(socket, (message.params as Record<string, unknown>).conversationId as string, {
        type: "snapshot", revision: 1, conversationState: {
          turnHistory: { history: { entitiesByKey: {} } }, ...baseline,
        },
      });
    }
    handleMessage(socket, message);
  });
}

function createRetryingOutbox(error: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ipc-recovery-test-"));
  cleanupPaths.push(dir);
  const stateFile = path.join(dir, "outbox.json");
  const outbox = new MobileMessageOutbox({ stateFile, now: () => 15_000 });
  outbox.accept({
    adapter: "codex", threadId: "task", clientId: "ipc-message",
    text: "合成 IPC 消息", images: [], createdAtMs: 10_000,
  });
  outbox.markSending("codex", "task", "ipc-message", 11_000);
  outbox.markRetrying("codex", "task", "ipc-message", { error, nextAttemptAtMs: 12_000 });
  return { outbox, stateFile, entry: outbox.get("codex", "task", "ipc-message")! };
}

function initializeRouter(socket: net.Socket, message: Record<string, unknown>): void {
  if (message.method === "initialize") sendFrame(socket, {
    type: "response", requestId: message.requestId, resultType: "success",
    result: { clientId: "bridge-client" },
  });
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
    const { socketPath } = await createStartTurnRouter((socket, message) => {
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
              { type: "text", text: "真实桌面消息", text_elements: [] },
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

  test("updates the desktop owner's next-turn model and rejects an unapplied update", async () => {
    const requests: Record<string, unknown>[] = [];
    const { socketPath } = await createMockRouter((socket, message) => {
      if (message.type !== "request") return;
      if (message.method === "initialize") {
        sendFrame(socket, {
          type: "response", requestId: message.requestId, resultType: "success",
          method: "initialize", result: { clientId: "bridge-client" },
        });
        return;
      }
      if (message.method === "thread-follower-update-thread-settings") {
        requests.push(message);
        sendFrame(socket, {
          type: "response", requestId: message.requestId, resultType: "success",
          method: message.method, handledByClientId: "desktop-owner",
          result: { applied: requests.length === 1 },
        });
      }
    });
    const client = new CodexDesktopIpcClient({ socketPath });
    try {
      await expect(client.updateThreadSettingsForNextTurn("thread-1", { model: "gpt-6-sol" }))
        .resolves.toBeUndefined();
      expect(requests[0]).toMatchObject({
        version: 2,
        params: {
          conversationId: "thread-1",
          threadSettings: { model: "gpt-6-sol" },
        },
      });
      await expect(client.updateThreadSettingsForNextTurn("thread-1", { effort: "high" }))
        .rejects.toThrow("未应用");
    } finally {
      await client.dispose();
    }
  });

  test("accepts a desktop turn when live state confirms it before the owner replies", async () => {
    const requests: Record<string, unknown>[] = [];
    const { socketPath } = await createStartTurnRouter((socket, message) => {
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
        requests.push(message);
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
                revision: 2,
                conversationState: {
                  id: "thread-confirmed",
                  threadRuntimeStatus: { type: "active", activeFlags: [] },
                  turnHistory: {
                    history: {
                      entitiesByKey: {
                        "tail:turn-confirmed": {
                          turnId: "turn-confirmed",
                          status: "inProgress",
                          params: { input: [{ type: "text", text: "已经被桌面端接收" }] },
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
    expect(requests[0]).toMatchObject({
      params: {
        turnStart: {
          request: {
            input: [{ type: "text", text: "已经被桌面端接收", text_elements: [] }],
          },
        },
      },
    });
    await client.dispose();
  });

  test("reports an unconfirmed start without claiming the message failed", async () => {
    const { socketPath } = await createStartTurnRouter((socket, message) => {
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

  test("confirms raw snapshots without upgrading or leaking summary history", async () => {
    const received: Record<string, unknown>[] = [];
    const input = [{ type: "text", text: "摘要订阅提交", text_elements: [] }];
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      received.push(message);
      initializeRouter(socket, message);
      if (message.method === "thread-follower-start-turn") {
        const state = receiptState("summary-new", input);
        state.turnHistory.history.entitiesByKey["tail:summary-new"]!.items =
          Array.from({ length: 10_000 }, () => ({ text: "不应保留的历史输出" }));
        sendState(socket, "summary-thread", {
          type: "snapshot", revision: 2, conversationState: state,
        });
      }
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    const changes: unknown[] = [];
    client.onStateChanged((_thread, state, _previous, change) => {
      expect(state).not.toHaveProperty("turnHistory");
      changes.push(change);
    });
    try {
      await client.followThread("summary-thread", { retention: "summary" });
      const turn = await client.startTurn("summary-thread", input);
      expect(turn).toEqual({ id: "summary-new", status: "inProgress" });
      expect(client.getThreadState("summary-thread")).not.toHaveProperty("turnHistory");
      expect(JSON.stringify(changes)).not.toContain("params");
      expect(JSON.stringify(changes)).not.toContain("items");
      expect((client as unknown as { threadRetentionById: Map<string, string> })
        .threadRetentionById.get("summary-thread")).toBe("summary");
      expect(received.filter((message) => message.method === "thread-stream-following-changed" &&
        (message.params as Record<string, unknown>).following === false)).toHaveLength(0);
    } finally {
      await client.dispose();
    }
  });

  test("confirms patch-only new turns and split metadata before summary patches are filtered", async () => {
    const input = [{ type: "text", text: "仅 patch 确认" }];
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method !== "thread-follower-start-turn") return;
      const entityPath = ["turnHistory", "history", "entitiesByKey", "tail:patch-new"];
      sendState(socket, "patch-thread", {
        type: "patches", baseRevision: 1, revision: 2,
        patches: [{ op: "add", path: entityPath, value: { turnId: "patch-new", items: [] } }],
      });
      sendState(socket, "patch-thread", {
        type: "patches", baseRevision: 2, revision: 3,
        patches: [
          { op: "replace", path: [...entityPath, "status"], value: "inProgress" },
          { op: "add", path: [...entityPath, "params", "input"], value: input },
          { op: "replace", path: ["turnHistory", "history", "entitiesByKey", "tail:old", "items", 0],
            value: { text: "旧 turn 的输出不能挤掉 candidate" } },
          { op: "replace", path: ["turnHistory", "history", "entitiesByKey", "tail:old", "status"],
            value: "completed" },
        ],
      });
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    let publicChanges = 0;
    client.onStateChanged(() => { publicChanges += 1; });
    try {
      await client.followThread("patch-thread", { retention: "summary" });
      expect(await client.startTurn("patch-thread", "仅 patch 确认"))
        .toEqual({ id: "patch-new", status: "inProgress" });
      expect(publicChanges).toBe(2);
      expect(client.getThreadRevision("patch-thread")).toBe(3);
      expect(client.getThreadState("patch-thread")).not.toHaveProperty("turnHistory");
    } finally {
      await client.dispose();
    }
  });

  test("does not transfer old input evidence when a patch replaces the turn identity", async () => {
    const input = [{ type: "text", text: "旧身份关联" }];
    let release = () => {};
    let delivered = () => {};
    const deliveredPromise = new Promise<void>((resolve) => { delivered = resolve; });
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method !== "thread-follower-start-turn") return;
      sendState(socket, "identity-thread", {
        type: "patches", baseRevision: 1, revision: 2,
        patches: [
          { op: "replace", path: ["turnHistory", "history", "entitiesByKey", "tail:old", "turnId"],
            value: "identity-new" },
          { op: "replace", path: ["updatedAt"], value: 2 },
        ],
      });
      release = () => sendState(socket, "identity-thread", {
        type: "patches", baseRevision: 2, revision: 3,
        patches: [{ op: "replace", path: ["turnHistory", "history", "entitiesByKey", "tail:old", "params"],
          value: { input } }],
      });
    }, {
      threadRuntimeStatus: { type: "idle" },
      turnHistory: { history: { entitiesByKey: {
        "tail:old": { turnId: "old", status: "completed", params: { input } },
      } } },
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 500 });
    client.onStateChanged((threadId) => {
      if (client.getThreadRevision(threadId) === 2) delivered();
    });
    try {
      let settled = false;
      await client.followThread("identity-thread", { retention: "summary" });
      const turnPromise = client.startTurn("identity-thread", "旧身份关联")
        .then((turn) => { settled = true; return turn; });
      await deliveredPromise;
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      expect(await turnPromise).toEqual({ id: "identity-new", status: "unknown" });
    } finally {
      await client.dispose();
    }
  });

  test("samples replacement history branches without retaining their items", async () => {
    const input = [{ type: "text", text: "替换 history" }];
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method !== "thread-follower-start-turn") return;
      sendState(socket, "replacement-thread", {
        type: "patches", baseRevision: 1, revision: 2,
        patches: [{ op: "replace", path: ["turnHistory", "history"], value: {
          entitiesByKey: {
            "tail:replacement": { turnId: "replacement", status: "completed", params: { input },
              items: [{ text: "巨大输出分支" }] },
          },
        } }],
      });
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    try {
      await client.followThread("replacement-thread", { retention: "summary" });
      expect(await client.startTurn("replacement-thread", "替换 history"))
        .toEqual({ id: "replacement", status: "completed" });
      expect(client.getThreadState("replacement-thread")).not.toHaveProperty("turnHistory");
    } finally {
      await client.dispose();
    }
  });

  test("temporarily follows idle tasks and defers monitor unfollow until receipt cleanup", async () => {
    const received: Record<string, unknown>[] = [];
    let deliver: (() => void) | undefined;
    let unfollowed = () => {};
    const unfollowedPromise = new Promise<void>((resolve) => { unfollowed = resolve; });
    let submitted = () => {};
    const submittedPromise = new Promise<void>((resolve) => { submitted = resolve; });
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      received.push(message);
      initializeRouter(socket, message);
      if (message.method === "thread-stream-following-changed" &&
        (message.params as Record<string, unknown>).following === false) unfollowed();
      if (message.method !== "thread-follower-start-turn") return;
      deliver = () => sendState(socket, "idle-thread", {
        type: "snapshot", revision: 2,
        conversationState: receiptState("idle-new", [{ type: "text", text: "空闲提交" }]),
      });
      submitted();
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    const internals = client as unknown as {
      pendingThreadStarts: Map<string, { receipts: Set<{
        knownTurns: Uint8Array; candidate: Record<string, unknown> | null;
      }> }>;
      threadRetentionById: Map<string, string>;
    };
    try {
      const turnPromise = client.startTurn("idle-thread", "空闲提交");
      await submittedPromise;
      const receipt = [...internals.pendingThreadStarts.get("idle-thread")!.receipts][0]!;
      expect(receipt.knownTurns.byteLength).toBe(2048);
      expect(receipt.candidate).not.toHaveProperty("items");
      expect(receipt.candidate).not.toHaveProperty("params");
      await client.unfollowThread("idle-thread");
      expect(client.getThreadState("idle-thread")).not.toBeNull();
      expect(internals.threadRetentionById.get("idle-thread")).toBe("summary");
      expect(received.filter((message) => message.method === "thread-stream-following-changed" &&
        (message.params as Record<string, unknown>).following === false)).toHaveLength(0);
      deliver!();
      expect(await turnPromise).toEqual({ id: "idle-new", status: "inProgress" });
      expect(client.getThreadState("idle-thread")).toBeNull();
      expect(internals.pendingThreadStarts.size).toBe(0);
      expect(internals.threadRetentionById.size).toBe(0);
      await unfollowedPromise;
      expect(received.filter((message) => message.method === "thread-stream-following-changed" &&
        (message.params as Record<string, unknown>).following === false)).toHaveLength(1);
      expect(received.filter((message) => message.method === "thread-follower-start-turn"))
        .toHaveLength(1);
      expect(received.findIndex((message) => message.method === "thread-stream-following-changed"))
        .toBeLessThan(received.findIndex((message) => message.method === "thread-follower-start-turn"));
    } finally {
      await client.dispose();
    }
  });

  for (const status of ["completed", "failed"]) {
    test(`accepts a fast ${status} turn as receipt, not execution success`, async () => {
      const { socketPath } = await createStartTurnRouter((socket, message) => {
        initializeRouter(socket, message);
        if (message.method === "thread-follower-start-turn") sendState(socket, "terminal-thread", {
          type: "patches", baseRevision: 1, revision: 2,
          patches: [{ op: "add", path: ["turnHistory", "history", "entitiesByKey", "tail:terminal"],
            value: { turnId: "terminal", status, params: { input: [{ type: "text", text: "快速终态" }] },
              items: [{ text: "不保留输出" }] } }],
        });
      });
      const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
      try {
        expect(await client.startTurn("terminal-thread", "快速终态"))
          .toEqual({ id: "terminal", status });
        expect(client.getThreadState("terminal-thread")).toBeNull();
      } finally {
        await client.dispose();
      }
    });
  }

  test("ignores delayed old snapshots, other threads and new turns with unrelated input", async () => {
    const input = [{ type: "text", text: "同文但必须新 turn" }];
    let release = () => {};
    let delivered = () => {};
    const deliveredPromise = new Promise<void>((resolve) => { delivered = resolve; });
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method !== "thread-follower-start-turn") return;
      sendState(socket, "other-thread", {
        type: "snapshot", revision: 5, conversationState: receiptState("other-new", input),
      });
      sendState(socket, "guard-thread", {
        type: "snapshot", revision: 0, conversationState: receiptState("delayed-old", input),
      });
      sendState(socket, "guard-thread", {
        type: "snapshot", revision: 2, conversationState: receiptState("baseline-old", input),
      });
      sendState(socket, "guard-thread", {
        type: "snapshot", revision: 3,
        conversationState: receiptState("unrelated-new", [{ type: "text", text: "其他桌面输入" }]),
      });
      sendState(socket, "guard-thread", {
        type: "snapshot", revision: 4, conversationState: receiptState("missing-params", undefined),
      });
      release = () => sendState(socket, "guard-thread", {
        type: "snapshot", revision: 5, conversationState: receiptState("matching-new", input),
      });
    }, {
      threadRuntimeStatus: { type: "idle" },
      turnHistory: { history: { entitiesByKey: {
        "tail:baseline-old": { turnId: "baseline-old", status: "completed", params: { input } },
        "tail:last-old": { turnId: "last-old", status: "completed" },
      } } },
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 500 });
    client.onStateChanged((threadId) => {
      if (threadId === "guard-thread" && client.getThreadRevision(threadId) === 4) delivered();
    });
    try {
      let settled = false;
      const turnPromise = client.startTurn("guard-thread", "同文但必须新 turn")
        .then((turn) => { settled = true; return turn; });
      await deliveredPromise;
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(client.getThreadState("other-thread")).toBeNull();
      release();
      expect(await turnPromise).toEqual({ id: "matching-new", status: "inProgress" });
    } finally {
      await client.dispose();
    }
  });

  test("matches all input items including attachment and text-element metadata", async () => {
    const input = [
      { type: "text" as const, text: "含附件", text_elements: [{ placeholder: "正确" }] },
      { type: "localImage" as const, path: "/tmp/right.png" },
    ];
    let release = () => {};
    let delivered = () => {};
    const deliveredPromise = new Promise<void>((resolve) => { delivered = resolve; });
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method !== "thread-follower-start-turn") return;
      sendState(socket, "attachment-thread", {
        type: "snapshot", revision: 2,
        conversationState: receiptState("wrong-image", [input[0], { type: "localImage", path: "/tmp/wrong.png" }]),
      });
      sendState(socket, "attachment-thread", {
        type: "snapshot", revision: 3,
        conversationState: receiptState("wrong-elements", [
          { ...input[0], text_elements: [{ placeholder: "错误" }] }, input[1],
        ]),
      });
      release = () => sendState(socket, "attachment-thread", {
        type: "snapshot", revision: 4,
        conversationState: receiptState("right-input", [
          { text_elements: [{ placeholder: "正确" }], text: "含附件", type: "text" }, input[1],
        ]),
      });
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 500 });
    client.onStateChanged((threadId) => {
      if (client.getThreadRevision(threadId) === 3) delivered();
    });
    try {
      let settled = false;
      const turnPromise = client.startTurn("attachment-thread", input)
        .then((turn) => { settled = true; return turn; });
      await deliveredPromise;
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      expect(await turnPromise).toEqual({ id: "right-input", status: "inProgress" });
    } finally {
      await client.dispose();
    }
  });

  for (const errorType of ["timeout", "owner-error", "no-client-found", "invalid-response", "disconnect"]) {
    test(`cleans receipt and temporary subscription after ${errorType} without resending`, async () => {
      let starts = 0;
      const { socketPath } = await createStartTurnRouter((socket, message) => {
        initializeRouter(socket, message);
        if (message.method !== "thread-follower-start-turn") return;
        starts += 1;
        if (errorType === "timeout") return;
        if (errorType === "disconnect") { socket.destroy(); return; }
        sendFrame(socket, {
          type: "response", requestId: message.requestId,
          resultType: errorType === "invalid-response" ? "success" : "error",
          result: { unexpected: true }, error: errorType,
        });
      });
      const client = new CodexDesktopIpcClient({
        socketPath, requestTimeoutMs: 100, openThread: async () => { throw new Error("禁止重发打开"); },
      });
      try {
        const error = await client.startTurn("error-thread", "失败清理").catch((error: Error) => error);
        expect(error).toBeInstanceOf(Error);
        const errorMessage = (error as Error).message;
        expect(classifyMobileSendFailure(errorMessage)).toBe(
          errorType === "no-client-found" ? "transient" : errorType === "owner-error" ? "unknown" : "unconfirmed",
        );
        if (["timeout", "invalid-response", "disconnect"].includes(errorType)) {
          const { outbox, entry } = createRetryingOutbox(errorMessage);
          expect(shouldRetryMobileMessage(errorMessage, 1, 5)).toBe(false);
          const action = await prepareMobileMessageRetry({ outbox, entry, readMessages: async () => [] });
          expect(action).toBe("check");
          if (action === "send") await client.startTurn("error-thread", "失败清理");
        }
        const internals = client as unknown as {
          pendingThreadStarts: Map<string, unknown>; followedThreadIds: Set<string>;
        };
        expect(internals.pendingThreadStarts.size).toBe(0);
        expect(internals.followedThreadIds.size).toBe(0);
        expect(client.getThreadState("error-thread")).toBeNull();
        expect(starts).toBe(1);
      } finally {
        await client.dispose();
      }
    });
  }

  test("cleans receipt even when summary follow initialization fails", async () => {
    const { socketPath } = await createMockRouter((socket, message) => sendFrame(socket, {
      type: "response", requestId: message.requestId, resultType: "error", error: "follow 初始化失败",
    }));
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    try {
      await expect(client.startTurn("follow-error", "不能发送"))
        .rejects.toThrow("Codex 桌面任务状态尚未就绪，消息尚未发送，请稍后再试。");
      expect((client as unknown as { pendingThreadStarts: Map<string, unknown> })
        .pendingThreadStarts.size).toBe(0);
      await client.unfollowThread("follow-error");
      expect(client.getThreadState("follow-error")).toBeNull();
    } finally {
      await client.dispose();
    }
  });

  test("cleans the receipt when the summary follow broadcast itself throws", async () => {
    const { socketPath } = await createMockRouter(initializeRouter);
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    const internals = client as unknown as {
      socket: net.Socket; pendingThreadStarts: Map<string, unknown>;
      followedThreadIds: Set<string>; threadRetentionById: Map<string, string>;
    };
    await client.connect();
    const write = internals.socket.write;
    let failed = false;
    internals.socket.write = function (...args: Parameters<typeof write>) {
      if (!failed) {
        failed = true;
        throw new Error("summary follow 写失败");
      }
      return write.apply(this, args);
    } as typeof write;
    try {
      await expect(client.startTurn("follow-write-error", "未发送"))
        .rejects.toThrow("Codex 桌面任务状态尚未就绪，消息尚未发送，请稍后再试。");
      expect(internals.pendingThreadStarts.size).toBe(0);
      expect(internals.followedThreadIds.size).toBe(0);
      expect(internals.threadRetentionById.size).toBe(0);
    } finally {
      internals.socket.write = write;
      await client.dispose();
    }
  });

  test("does not send user input when the submission baseline never arrives", async () => {
    let starts = 0;
    const { socketPath } = await createMockRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method === "thread-follower-start-turn") starts += 1;
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    try {
      await expect(client.startTurn("no-baseline", "禁止误确认旧消息"))
        .rejects.toThrow("消息尚未发送");
      expect(starts).toBe(0);
      expect((client as unknown as { pendingThreadStarts: Map<string, unknown> })
        .pendingThreadStarts.size).toBe(0);
      expect(client.getThreadState("no-baseline")).toBeNull();
    } finally {
      await client.dispose();
    }
  });

  test("opens an unloaded task once only after read-only discovery finds no owner", async () => {
    const received: Record<string, unknown>[] = [];
    const opened: string[] = [];
    let loaded = false;
    const { socketPath } = await createMockRouter((socket, message) => {
      received.push(message);
      initializeRouter(socket, message);
      if (message.method === "thread-stream-following-changed" &&
        (message.params as Record<string, unknown>).following === true && loaded) {
        sendState(socket, "unloaded-thread", {
          type: "snapshot", revision: 1, conversationState: {
            threadRuntimeStatus: { type: "idle" }, turnHistory: { history: { entitiesByKey: {} } },
          },
        });
      }
      if (message.method === "thread-owner-discovery") {
        sendFrame(socket, {
          type: "response", requestId: message.requestId, resultType: "error", error: "no-client-found",
        });
      }
      if (message.method === "thread-follower-start-turn") sendState(socket, "unloaded-thread", {
        type: "snapshot", revision: 2,
        conversationState: receiptState("unloaded-new", [{ type: "text", text: "按需打开原任务" }]),
      });
    });
    const client = new CodexDesktopIpcClient({
      socketPath, requestTimeoutMs: 100,
      openThread: async (threadId) => { opened.push(threadId); loaded = true; },
    });
    try {
      expect(await client.startTurn("unloaded-thread", "按需打开原任务"))
        .toEqual({ id: "unloaded-new", status: "inProgress" });
      expect(opened).toEqual(["unloaded-thread"]);
      const discovery = received.filter((message) => message.method === "thread-owner-discovery");
      expect(discovery).toHaveLength(1);
      expect(discovery[0]).toMatchObject({
        version: 1, timeoutMs: 100, params: { hostId: "local", conversationId: "unloaded-thread" },
      });
      expect(JSON.stringify(discovery)).not.toContain("按需打开原任务");
      expect(received.filter((message) => message.method === "thread-follower-start-turn"))
        .toHaveLength(1);
      expect(received.filter((message) => message.method === "thread-stream-following-changed" &&
        (message.params as Record<string, unknown>).following === true)).toHaveLength(2);
      expect(client.getThreadState("unloaded-thread")).toBeNull();
    } finally {
      await client.dispose();
    }
  });

  test("waits for delayed no-owner discovery before opening only the original task", async () => {
    const opened: string[] = [];
    let loaded = false;
    let starts = 0;
    const { socketPath } = await createMockRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method === "thread-owner-discovery") {
        setTimeout(() => sendFrame(socket, {
          type: "response", requestId: message.requestId, resultType: "error", error: "no-client-found",
        }), 1_200);
      }
      if (message.method === "thread-stream-following-changed" &&
        (message.params as Record<string, unknown>).following === true && loaded) {
        sendState(socket, "delayed-original", {
          type: "snapshot", revision: 1, conversationState: {
            threadRuntimeStatus: { type: "idle" }, turnHistory: { history: { entitiesByKey: {} } },
          },
        });
      }
      if (message.method === "thread-follower-start-turn") {
        starts += 1;
        sendState(socket, "delayed-original", {
          type: "snapshot", revision: 2,
          conversationState: receiptState("delayed-turn", [{ type: "text", text: "继续原任务" }]),
        });
      }
    });
    const client = new CodexDesktopIpcClient({
      socketPath, requestTimeoutMs: 3_000,
      openThread: async (id) => { opened.push(id); loaded = true; },
    });
    try {
      expect(await client.startTurn("delayed-original", "继续原任务"))
        .toEqual({ id: "delayed-turn", status: "inProgress" });
      expect(opened).toEqual(["delayed-original"]);
      expect(starts).toBe(1);
    } finally {
      await client.dispose();
    }
  });

  for (const failure of ["open-error", "missing-after-open", "owner-exists", "discovery-error", "discovery-timeout"]) {
    test(`does not send start or reopen after pre-submit ${failure}`, async () => {
      let opens = 0;
      let starts = 0;
      let follows = 0;
      const { socketPath } = await createMockRouter((socket, message) => {
        initializeRouter(socket, message);
        if (message.method === "thread-stream-following-changed" &&
          (message.params as Record<string, unknown>).following === true) follows += 1;
        if (message.method === "thread-follower-start-turn") starts += 1;
        if (message.method !== "thread-owner-discovery" || failure === "discovery-timeout") return;
        sendFrame(socket, {
          type: "response", requestId: message.requestId,
          resultType: failure === "owner-exists" ? "success" : "error",
          result: { supportsUntrustedAppInput: true }, handledByClientId: "desktop-owner",
          error: failure === "discovery-error" ? "owner discovery unavailable" : "no-client-found",
        });
      });
      const client = new CodexDesktopIpcClient({
        socketPath, requestTimeoutMs: 100,
        openThread: async () => {
          opens += 1;
          if (failure === "open-error") throw new Error("原任务打开失败");
        },
      });
      try {
        await expect(client.startTurn("pre-submit-error", "尚未发送的输入"))
          .rejects.toThrow("Codex 桌面任务状态尚未就绪，消息尚未发送，请稍后再试。");
        expect(opens).toBe(failure === "open-error" || failure === "missing-after-open" ? 1 : 0);
        expect(starts).toBe(0);
        expect(follows).toBe(failure === "owner-exists" || failure === "missing-after-open" ? 2 : 1);
        expect(client.getThreadState("pre-submit-error")).toBeNull();
        expect((client as unknown as { pendingThreadStarts: Map<string, unknown> })
          .pendingThreadStarts.size).toBe(0);
      } finally {
        await client.dispose();
      }
    });
  }

  test("refollows an existing owner without opening when its first snapshot was missing", async () => {
    let follows = 0;
    let opens = 0;
    const { socketPath } = await createMockRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method === "thread-stream-following-changed" &&
        (message.params as Record<string, unknown>).following === true && ++follows === 2) {
        sendState(socket, "existing-owner", {
          type: "snapshot", revision: 1, conversationState: { threadRuntimeStatus: { type: "idle" } },
        });
      }
      if (message.method === "thread-owner-discovery") sendFrame(socket, {
        type: "response", requestId: message.requestId, resultType: "success",
        handledByClientId: "desktop-owner", result: { supportsUntrustedAppInput: true },
      });
      if (message.method === "thread-follower-start-turn") sendFrame(socket, {
        type: "response", requestId: message.requestId, resultType: "success",
        result: { turn: { id: "existing-owner-new", status: "inProgress" } },
      });
    });
    const client = new CodexDesktopIpcClient({
      socketPath, requestTimeoutMs: 100, openThread: async () => { opens += 1; },
    });
    try {
      expect(await client.startTurn("existing-owner", "丢失的首次 snapshot"))
        .toMatchObject({ id: "existing-owner-new" });
      expect(opens).toBe(0);
      expect(follows).toBe(2);
    } finally {
      await client.dispose();
    }
  });

  test("does not open after a snapshot arrives during owner discovery", async () => {
    let opens = 0;
    const { socketPath } = await createMockRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method === "thread-owner-discovery") {
        sendState(socket, "discovery-race", {
          type: "snapshot", revision: 1, conversationState: { threadRuntimeStatus: { type: "idle" } },
        });
        sendFrame(socket, {
          type: "response", requestId: message.requestId, resultType: "error", error: "no-client-found",
        });
      }
      if (message.method === "thread-follower-start-turn") sendFrame(socket, {
        type: "response", requestId: message.requestId, resultType: "success",
        result: { turn: { id: "race-new", status: "inProgress" } },
      });
    });
    const client = new CodexDesktopIpcClient({
      socketPath, requestTimeoutMs: 100, openThread: async () => { opens += 1; },
    });
    try {
      expect(await client.startTurn("discovery-race", "迟到基线"))
        .toMatchObject({ id: "race-new" });
      expect(opens).toBe(0);
    } finally {
      await client.dispose();
    }
  });

  test("refreshes cached summary identity baseline without owner discovery or opening", async () => {
    let follows = 0;
    let discoveries = 0;
    let opens = 0;
    let observed = () => {};
    const observedPromise = new Promise<void>((resolve) => { observed = resolve; });
    const { socketPath } = await createMockRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method === "thread-stream-following-changed" &&
        (message.params as Record<string, unknown>).following === true) {
        follows += 1;
        sendState(socket, "cached-start", {
          type: "snapshot", revision: 7, conversationState: {
            threadRuntimeStatus: { type: "idle" }, turnHistory: { history: { entitiesByKey: {} } },
          },
        });
      }
      if (message.method === "thread-owner-discovery") discoveries += 1;
      if (message.method === "thread-follower-start-turn") sendState(socket, "cached-start", {
        type: "patches", baseRevision: 7, revision: 8,
        patches: [{ op: "add", path: ["turnHistory", "history", "entitiesByKey", "tail:cached-new"],
          value: { turnId: "cached-new", status: "inProgress", params: { input: [{ type: "text", text: "缓存提交" }] } } }],
      });
    });
    const client = new CodexDesktopIpcClient({
      socketPath, requestTimeoutMs: 100, openThread: async () => { opens += 1; },
    });
    client.onStateChanged(() => observed());
    try {
      await client.followThread("cached-start", { retention: "summary" });
      await observedPromise;
      expect(await client.startTurn("cached-start", "缓存提交"))
        .toEqual({ id: "cached-new", status: "inProgress" });
      expect(follows).toBe(2);
      expect(discoveries).toBe(0);
      expect(opens).toBe(0);
    } finally {
      await client.dispose();
    }
  });

  test("does not confirm higher-revision old turns from a cached summary identity gap", async () => {
    const input = [{ type: "text", text: "重复文字但不同身份" }];
    let release = () => {};
    let oldSeen = () => {};
    let cachedSeen = () => {};
    const oldSeenPromise = new Promise<void>((resolve) => { oldSeen = resolve; });
    const cachedSeenPromise = new Promise<void>((resolve) => { cachedSeen = resolve; });
    const { socketPath } = await createMockRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method === "thread-stream-following-changed" &&
        (message.params as Record<string, unknown>).following === true) {
        sendState(socket, "cached-identity", {
          type: "snapshot", revision: 7, conversationState: receiptState("old-completed", input, "completed"),
        });
      }
      if (message.method !== "thread-follower-start-turn") return;
      sendState(socket, "cached-identity", {
        type: "snapshot", revision: 8, conversationState: receiptState("old-completed", input, "completed"),
      });
      release = () => sendState(socket, "cached-identity", {
        type: "snapshot", revision: 9, conversationState: receiptState("new-identity", input, "completed"),
      });
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 300 });
    client.onStateChanged((threadId) => {
      if (client.getThreadRevision(threadId) === 7) cachedSeen();
      if (client.getThreadRevision(threadId) === 8) oldSeen();
    });
    try {
      await client.followThread("cached-identity", { retention: "summary" });
      await cachedSeenPromise;
      expect(client.getThreadState("cached-identity")).not.toHaveProperty("turnHistory");
      let settled = false;
      const turnPromise = client.startTurn("cached-identity", "重复文字但不同身份")
        .then((turn) => { settled = true; return turn; });
      await oldSeenPromise;
      await Promise.resolve();
      expect(settled).toBe(false);
      release();
      expect(await turnPromise).toEqual({ id: "new-identity", status: "completed" });
    } finally {
      await client.dispose();
    }
  });

  test("disables state fallback when raw baseline has no turn identity history", async () => {
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method === "thread-follower-start-turn") sendState(socket, "no-identity-baseline", {
        type: "snapshot", revision: 2,
        conversationState: receiptState("old-unproven", [{ type: "text", text: "未证明身份" }], "completed"),
      });
    }, { turnHistory: undefined, threadRuntimeStatus: { type: "idle" } });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    try {
      const error = await client.startTurn("no-identity-baseline", "未证明身份").catch((error: Error) => error);
      expect(classifyMobileSendFailure((error as Error).message)).toBe("unconfirmed");
    } finally {
      await client.dispose();
    }
  });

  test("wraps initialize timeout as definitely unsent before any start request", async () => {
    let starts = 0;
    const { socketPath } = await createMockRouter((_socket, message) => {
      if (message.method === "thread-follower-start-turn") starts += 1;
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    try {
      const error = await client.startTurn("initialize-timeout", "未发送的正文").catch((error: Error) => error);
      expect((error as Error).message).toBe("Codex 桌面任务状态尚未就绪，消息尚未发送，请稍后再试。");
      expect(classifyMobileSendFailure((error as Error).message)).toBe("transient");
      expect(((error as Error).cause as Error).message).toContain("initialize");
      const errorMessage = (error as Error).message;
      const fresh = createRetryingOutbox(errorMessage);
      expect(shouldRetryMobileMessage(errorMessage, 1, 5)).toBe(true);
      expect(await prepareMobileMessageRetry({
        outbox: fresh.outbox, entry: fresh.entry, readMessages: async () => [],
      })).toBe("send");

      const prior = createRetryingOutbox("Codex 暂未确认收到这条消息，请先查看任务状态，避免重复发送。");
      prior.outbox.markSending("codex", "task", "ipc-message", 13_000);
      prior.outbox.markRetrying("codex", "task", "ipc-message", { error: errorMessage, nextAttemptAtMs: 14_000 });
      const restored = new MobileMessageOutbox({ stateFile: prior.stateFile, now: () => 15_000 });
      const entry = restored.get("codex", "task", "ipc-message")!;
      expect(entry.lastError).toBe(errorMessage);
      expect(entry.deliveryUncertain).toBe(true);
      expect(isMobileMessageDeliveryUncertain(entry)).toBe(true);
      expect(await prepareMobileMessageRetry({ outbox: restored, entry, readMessages: async () => [] })).toBe("check");
      expect(starts).toBe(0);
    } finally {
      await client.dispose();
    }
  });

  test("wraps cached full baseline follow failure as unsent and preserves the subscription intent", async () => {
    let starts = 0;
    let observed = () => {};
    const observedPromise = new Promise<void>((resolve) => { observed = resolve; });
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method === "thread-follower-start-turn") starts += 1;
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    client.onStateChanged(() => observed());
    try {
      await client.followThread("cached-full-error");
      await observedPromise;
      await client.dispose();
      const error = await client.startTurn("cached-full-error", "未发送").catch((error: Error) => error);
      expect(classifyMobileSendFailure((error as Error).message)).toBe("transient");
      expect(((error as Error).cause as Error).message).toBe("Codex 桌面端连接已关闭。");
      expect(starts).toBe(0);
      const internals = client as unknown as {
        pendingThreadStarts: Map<string, unknown>; threadRetentionById: Map<string, string>;
      };
      expect(internals.pendingThreadStarts.size).toBe(0);
      expect(internals.threadRetentionById.get("cached-full-error")).toBe("full");
    } finally {
      await client.dispose();
    }
  });

  for (const failure of ["dispose", "invalid-turn", "missing-turn", "missing-result-type", "malformed-owner-error"]) {
    test(`classifies post-write ${failure} as unconfirmed with exactly one start`, async () => {
      let starts = 0;
      let disposeClient = () => {};
      const { socketPath } = await createStartTurnRouter((socket, message) => {
        initializeRouter(socket, message);
        if (message.method !== "thread-follower-start-turn") return;
        starts += 1;
        if (failure === "dispose") { disposeClient(); return; }
        sendFrame(socket, {
          type: "response", requestId: message.requestId,
          ...(failure === "missing-result-type" ? {} :
            { resultType: failure === "malformed-owner-error" ? "error" : "success" }),
          result: failure === "missing-turn" ? {} : { turn: { status: "completed" } },
        });
      });
      const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
      disposeClient = () => { void client.dispose(); };
      try {
        const error = await client.startTurn("post-write", "一次发送").catch((error: Error) => error);
        expect(error).toBeInstanceOf(Error);
        const errorMessage = (error as Error).message;
        expect(classifyMobileSendFailure(errorMessage)).toBe("unconfirmed");
        expect(shouldRetryMobileMessage(errorMessage, 1, 5)).toBe(false);
        const { outbox, entry } = createRetryingOutbox(errorMessage);
        const action = await prepareMobileMessageRetry({ outbox, entry, readMessages: async () => [] });
        expect(action).toBe("check");
        if (action === "send") await client.startTurn("post-write", "一次发送");
        expect(starts).toBe(1);
        expect((client as unknown as { pendingThreadStarts: Map<string, unknown> })
          .pendingThreadStarts.size).toBe(0);
      } finally {
        await client.dispose();
      }
    });
  }

  test("keeps explicit owner model rejection permanent and unchanged", async () => {
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method === "thread-follower-start-turn") sendFrame(socket, {
        type: "response", requestId: message.requestId, resultType: "error", error: "invalid model: rejected",
      });
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    try {
      const error = await client.startTurn("model-error", "模型明确拒绝").catch((error: Error) => error);
      expect((error as Error).message).toBe("invalid model: rejected");
      expect(classifyMobileSendFailure((error as Error).message)).toBe("permanent");
    } finally {
      await client.dispose();
    }
  });

  for (const failure of ["owner-error", "disconnect"]) {
    test(`preserves non-start follower ${failure} errors unchanged`, async () => {
      let requests = 0;
      const { socketPath } = await createMockRouter((socket, message) => {
        initializeRouter(socket, message);
        if (message.method !== "thread-follower-interrupt-turn") return;
        requests += 1;
        if (failure === "disconnect") { socket.destroy(); return; }
        sendFrame(socket, {
          type: "response", requestId: message.requestId, resultType: "error", error: "interrupt rejected",
        });
      });
      const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
      try {
        await expect(client.interruptTurn("unchanged-method", "turn-1")).rejects.toThrow(
          failure === "disconnect" ? "Codex 桌面端连接已断开。" : "interrupt rejected",
        );
        expect(requests).toBe(1);
      } finally {
        await client.dispose();
      }
    });
  }

  test("invalidates a vanished cached owner and safely discovers/opens on the next attempt only", async () => {
    let starts = 0;
    let discoveries = 0;
    let opens = 0;
    let loaded = true;
    let cachedSeen = () => {};
    const cachedSeenPromise = new Promise<void>((resolve) => { cachedSeen = resolve; });
    const { socketPath } = await createMockRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method === "thread-stream-following-changed" &&
        (message.params as Record<string, unknown>).following === true && loaded) sendState(socket, "vanished-owner", {
        type: "snapshot", revision: 1, conversationState: {
          threadRuntimeStatus: { type: "idle" }, turnHistory: { history: { entitiesByKey: {} } },
        },
      });
      if (message.method === "thread-owner-discovery") {
        discoveries += 1;
        sendFrame(socket, {
          type: "response", requestId: message.requestId, resultType: "error", error: "no-client-found",
        });
      }
      if (message.method === "thread-follower-start-turn") {
        starts += 1;
        if (starts === 1) {
          loaded = false;
          sendFrame(socket, {
            type: "response", requestId: message.requestId, resultType: "error", error: "no-client-found",
          });
        } else sendState(socket, "vanished-owner", {
          type: "snapshot", revision: 2,
          conversationState: receiptState("recovered-owner", [{ type: "text", text: "恢复原任务" }]),
        });
      }
    });
    const client = new CodexDesktopIpcClient({
      socketPath, requestTimeoutMs: 100, openThread: async () => { opens += 1; loaded = true; },
    });
    client.onStateChanged(() => cachedSeen());
    try {
      await client.followThread("vanished-owner", { retention: "summary" });
      await cachedSeenPromise;
      const error = await client.startTurn("vanished-owner", "恢复原任务").catch((error: Error) => error);
      expect(classifyMobileSendFailure((error as Error).message)).toBe("transient");
      expect(client.getThreadState("vanished-owner")).toBeNull();
      expect(starts).toBe(1);
      expect(opens).toBe(0);
      expect(discoveries).toBe(0);
      expect(await client.startTurn("vanished-owner", "恢复原任务"))
        .toEqual({ id: "recovered-owner", status: "inProgress" });
      expect(starts).toBe(2);
      expect(opens).toBe(1);
      expect(discoveries).toBe(1);
    } finally {
      await client.dispose();
    }
  });

  test("does not discover owners or open tasks for background summary monitoring", async () => {
    const received: string[] = [];
    let followed = () => {};
    const followedPromise = new Promise<void>((resolve) => { followed = resolve; });
    const { socketPath } = await createMockRouter((socket, message) => {
      initializeRouter(socket, message);
      received.push(message.method as string);
      if (message.method === "thread-stream-following-changed") followed();
    });
    const client = new CodexDesktopIpcClient({
      socketPath, openThread: async () => { throw new Error("后台不能打开任务"); },
    });
    try {
      await client.followThread("monitor-idle", { retention: "summary" });
      await followedPromise;
      await client.unfollowThread("monitor-idle");
      expect(received).not.toContain("thread-owner-discovery");
      expect(received).not.toContain("thread-follower-start-turn");
    } finally {
      await client.dispose();
    }
  });

  for (const resultType of ["success", "error"]) {
    test(`preserves the core ${resultType} outcome when finally unfollow throws`, async () => {
      let starts = 0;
      const { socketPath } = await createStartTurnRouter((socket, message) => {
        initializeRouter(socket, message);
        if (message.method !== "thread-follower-start-turn") return;
        starts += 1;
        sendFrame(socket, {
          type: "response", requestId: message.requestId, resultType,
          error: "核心提交错误", result: { turn: { id: "cleanup-new", status: "inProgress" } },
        });
      });
      const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 1_000 });
      // This regression targets finally cleanup, not discovery/readiness timing.
      // Establish a real router snapshot before injecting a cleanup write failure.
      const threadId = `cleanup-${resultType}`;
      let baselineReady = () => {};
      const baseline = new Promise<void>((resolve) => { baselineReady = resolve; });
      const unsubscribe = client.onStateChanged((id) => {
        if (id === threadId) baselineReady();
      });
      await client.followThread(threadId);
      await baseline;
      unsubscribe();
      const internals = client as unknown as {
        sendBroadcast: (method: string, version: number, params: Record<string, unknown>) => void;
        pendingThreadStarts: Map<string, unknown>; followedThreadIds: Set<string>;
      };
      // Inject at the client boundary; do not replace Bun's native named-pipe write method.
      const broadcast = internals.sendBroadcast;
      let cleanupAttempts = 0;
      internals.sendBroadcast = function (method, version, params) {
        if (method === "thread-stream-following-changed" && params.following === false) {
          cleanupAttempts += 1;
          throw new Error("finally 清理写失败");
        }
        return broadcast.call(this, method, version, params);
      };
      try {
        const turnPromise = client.startTurn(threadId, "清理不能改变结果");
        await client.unfollowThread(threadId);
        if (resultType === "success") {
          expect(await turnPromise).toEqual({ id: "cleanup-new", status: "inProgress" });
        } else {
          const error = await turnPromise.catch((error: Error) => error);
          if (!(error instanceof Error) || error.message !== "核心提交错误") {
            console.error("cleanup fixture diagnostic", {
              starts, cleanupAttempts, error: String(error),
              cause: error instanceof Error ? String(error.cause) : undefined,
            });
          }
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toBe("核心提交错误");
        }
        expect(starts).toBe(1);
        expect(cleanupAttempts).toBe(1);
        expect(internals.pendingThreadStarts.size).toBe(0);
        expect(internals.followedThreadIds.size).toBe(0);
        expect(client.getThreadState(threadId)).toBeNull();
      } finally {
        internals.sendBroadcast = broadcast;
        await client.dispose();
      }
    });
  }

  test("keeps a summary follow requested during a previously unsubscribed submission", async () => {
    let reply = () => {};
    let submitted = () => {};
    const submittedPromise = new Promise<void>((resolve) => { submitted = resolve; });
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method !== "thread-follower-start-turn") return;
      reply = () => sendFrame(socket, {
        type: "response", requestId: message.requestId, resultType: "success",
        result: { turn: { id: "new-summary", status: "inProgress" } },
      });
      submitted();
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    try {
      const turnPromise = client.startTurn("new-summary-thread", "监控重新需要订阅");
      await submittedPromise;
      await client.unfollowThread("new-summary-thread");
      await client.followThread("new-summary-thread", { retention: "summary" });
      reply();
      await turnPromise;
      expect(client.getThreadState("new-summary-thread")).not.toBeNull();
      expect((client as unknown as { threadRetentionById: Map<string, string> })
        .threadRetentionById.get("new-summary-thread")).toBe("summary");
    } finally {
      await client.dispose();
    }
  });

  test("keeps the temporary follow until all pending starts finish and matches each input", async () => {
    let release = () => {};
    let submitted = () => {};
    let starts = 0;
    const submittedPromise = new Promise<void>((resolve) => { submitted = resolve; });
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method !== "thread-follower-start-turn") return;
      starts += 1;
      if (starts !== 2) return;
      sendState(socket, "concurrent-thread", {
        type: "snapshot", revision: 2,
        conversationState: receiptState("first-receipt", [{ type: "text", text: "第一个输入" }]),
      });
      release = () => sendState(socket, "concurrent-thread", {
        type: "snapshot", revision: 3,
        conversationState: receiptState("second-receipt", [{ type: "text", text: "第二个输入" }]),
      });
      submitted();
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 500 });
    try {
      const first = client.startTurn("concurrent-thread", "第一个输入");
      let secondSettled = false;
      const second = client.startTurn("concurrent-thread", "第二个输入")
        .then((turn) => { secondSettled = true; return turn; });
      await submittedPromise;
      expect(await first).toMatchObject({ id: "first-receipt" });
      expect(secondSettled).toBe(false);
      expect(client.getThreadState("concurrent-thread")).not.toBeNull();
      release();
      expect(await second).toMatchObject({ id: "second-receipt" });
      expect(client.getThreadState("concurrent-thread")).toBeNull();
      expect(starts).toBe(2);
    } finally {
      await client.dispose();
    }
  });

  test("preserves an existing full subscription without adding receipt items", async () => {
    const baseline = receiptState("full-old", [{ type: "text", text: "旧消息" }], "completed");
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method === "thread-follower-start-turn") sendState(socket, "full-thread", {
        type: "snapshot", revision: 2,
        conversationState: receiptState("full-new", [{ type: "text", text: "已有 full" }]),
      });
    }, baseline);
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    try {
      await client.followThread("full-thread");
      expect(await client.startTurn("full-thread", "已有 full"))
        .toEqual({ id: "full-new", status: "inProgress" });
      expect(client.getThreadState("full-thread")).toHaveProperty("turnHistory");
      expect((client as unknown as { threadRetentionById: Map<string, string> })
        .threadRetentionById.get("full-thread")).toBe("full");
    } finally {
      await client.dispose();
    }
  });

  test("honors explicit unfollow of an existing summary subscription after successful response", async () => {
    let reply = () => {};
    let submitted = () => {};
    const submittedPromise = new Promise<void>((resolve) => { submitted = resolve; });
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      initializeRouter(socket, message);
      if (message.method !== "thread-follower-start-turn") return;
      reply = () => sendFrame(socket, {
        type: "response", requestId: message.requestId, resultType: "success",
        result: { turn: { id: "response-new", status: "inProgress" } },
      });
      submitted();
    });
    const client = new CodexDesktopIpcClient({ socketPath, requestTimeoutMs: 100 });
    try {
      await client.followThread("explicit-unfollow", { retention: "summary" });
      const turnPromise = client.startTurn("explicit-unfollow", "已有 summary");
      await submittedPromise;
      await client.unfollowThread("explicit-unfollow");
      expect(client.getThreadState("explicit-unfollow")).not.toBeNull();
      reply();
      expect(await turnPromise).toMatchObject({ id: "response-new" });
      expect(client.getThreadState("explicit-unfollow")).toBeNull();
    } finally {
      await client.dispose();
    }
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
        input: [{ type: "text", text: "等待发送", text_elements: [] }],
        restoreMessage: queuedMessage,
        clientUserMessageId: "queued-1",
      },
    });
    await client.dispose();
  });

  test("preserves text elements and image inputs without mutating caller data", async () => {
    const requests: Record<string, unknown>[] = [];
    const { socketPath } = await createStartTurnRouter((socket, message) => {
      if (message.type !== "request") return;
      requests.push(message);
      sendFrame(socket, {
        type: "response",
        requestId: message.requestId,
        resultType: "success",
        method: message.method,
        result: message.method === "initialize"
          ? { clientId: "bridge-client" }
          : { result: { turn: { id: "turn-metadata", status: "inProgress", items: [] } } },
      });
    });
    const client = new CodexDesktopIpcClient({ socketPath });
    const input = [
      { type: "text" as const, text: "hello", text_elements: [
        { byteRange: { start: 0, end: 5 }, placeholder: "attachment" },
      ] },
      { type: "text" as const, text: "plain" },
      { type: "localImage" as const, path: "/tmp/input.png" },
      { type: "image" as const, url: "https://example.com/input.png" },
    ];
    const original = structuredClone(input);
    try {
      await client.startTurn("thread-metadata", input);
      await client.steerTurn("thread-metadata", input, { id: "steer-metadata" });
      const expected = original.map((item) => item.type === "text"
        ? { ...item, text_elements: item.text_elements ?? [] }
        : item);
      expect(requests.find((request) => request.method === "thread-follower-start-turn"))
        .toMatchObject({ params: { turnStart: { request: { input: expected } } } });
      expect(requests.find((request) => request.method === "thread-follower-steer-turn"))
        .toMatchObject({ params: { input: expected } });
      expect(input).toEqual(original);
    } finally {
      await client.dispose();
    }
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

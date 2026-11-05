import crypto from "node:crypto";
import http from "node:http";
import { Buffer } from "node:buffer";
import console from "node:console";
import { clearTimeout, setTimeout } from "node:timers";
import { startWeRelayRelayServer } from "../../../src/relay/relay-server.ts";
import { startWeRelayRelayClient } from "../../../src/relay/relay-client.ts";
import WebSocket from "ws";

const { fetch, URL } = globalThis;

const sessionToken = `v1.${Date.now() + 60_000}.live.signature`;
const cookie = `codex_mobile_session=${sessionToken}`;
const messageReads = [];
const relayCommands = [];
let changedBeforeRefresh = false;
let targetRefreshStarted = false;
const local = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://werelay.local");
  response.setHeader("content-type", "application/json; charset=utf-8");
  const prewarm = typeof request.headers["x-werelay-relay-prewarm"] === "string";
  if (url.pathname.endsWith("/messages")) {
    messageReads.push({
      path: url.pathname,
      search: url.search,
      prewarm,
    });
  }
  if (url.pathname === "/api/auth/status") {
    const hasBrowserSession =
      typeof request.headers.cookie === "string" &&
      request.headers.cookie.startsWith("codex_mobile_session=");
    response.end(JSON.stringify({
      authenticated: hasBrowserSession || prewarm,
    }));
    return;
  }
  if (prewarm) {
    const delayMs = url.searchParams.get("limit") === "5" ? 2_500 : 0;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response.end(JSON.stringify({ ok: true, tasks: [] }));
    return;
  }
  response.end(JSON.stringify({ ok: true, tasks: [] }));
});
await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
const localAddress = `http://127.0.0.1:${local.address().port}`;

const relay = await startWeRelayRelayServer({
  host: "127.0.0.1",
  port: 0,
  deviceId: "test-device",
  deviceToken: "synthetic-device-token",
  warmCacheTtlMs: 60_000,
  warmRefreshIntervalMs: 60_000,
  pollTimeoutMs: 20,
  deviceOfflineMs: 5_000,
});
const waitsForTask = new Map();

const waitForNoPendingTask = async (threadId) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const pending = waitsForTask.get(threadId) ?? new Set();
    if (pending.size === 0 && !relayCommands.some(
      (command) =>
        command.pathname === `/api/tasks/${threadId}/messages` &&
        !command.completed,
    )) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task refresh did not settle: ${threadId}`);
};

const upgradeStatus = (headers) => new Promise((resolve, reject) => {
  const request = http.request(relay.baseUrl + "/api/live", {
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": crypto.randomBytes(16).toString("base64"),
      ...headers,
    },
  }, (response) => {
    response.resume();
    resolve(response.statusCode);
  });
  request.on("upgrade", (_response, socket) => {
    socket.destroy();
    reject(new Error("unexpected live upgrade"));
  });
  request.on("error", reject);
  request.setTimeout(1_000, () => request.destroy(new Error("live upgrade timeout")));
  request.end();
});

const openLive = () => new Promise((resolve, reject) => {
  const messages = [];
  const messageWaiters = new Set();
  const socket = new WebSocket(relay.baseUrl.replace("http:", "ws:") + "/api/live", {
    headers: { cookie, origin: relay.baseUrl },
  });
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (
      message.type === "changed" &&
      message.threadId === "task-1" &&
      targetRefreshStarted
    ) {
      const refreshed = relayCommands.some((command) =>
        command.pathname === "/api/tasks/task-1/messages" &&
        command.search.includes("limit=5"),
      );
      changedBeforeRefresh = !refreshed;
    }
    messages.push(message);
    for (const wake of [...messageWaiters]) wake();
  });
  socket.once("open", () => resolve({ socket, messages, messageWaiters }));
  socket.once("error", reject);
});

const waitForMessage = async (messages, predicate, timeoutMs = 3_000, messageWaiters) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        messageWaiters?.delete(wake);
        resolve();
      }, Math.min(50, Math.max(1, deadline - Date.now())));
      const wake = () => {
        clearTimeout(timer);
        messageWaiters?.delete(wake);
        resolve();
      };
      messageWaiters?.add(wake);
    });
  }
  throw new Error(`message timeout: ${JSON.stringify(messages)}`);
};

const closeCode = (socket) => Promise.race([
  new Promise((resolve) => socket.once("close", resolve)),
  new Promise((resolve) => setTimeout(() => resolve(-1), 2_000)),
]);

let device;
let live;
let expiringRelay;
let expiringClient;
let expiringLive;
try {
  const rejected = [
    await upgradeStatus({ origin: relay.baseUrl }),
    await upgradeStatus({ cookie, origin: "https://evil.example" }),
  ];
  device = new WebSocket(
    relay.baseUrl.replace("http:", "ws:") + "/__werelay/device/ws",
    {
      headers: {
        authorization: "Bearer synthetic-device-token",
        "x-werelay-device-id": "test-device",
      },
    },
  );
  await new Promise((resolve, reject) => {
    device.once("open", resolve);
    device.once("error", reject);
  });
  device.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === "ack") {
      device.send(JSON.stringify({ version: 1, type: "ready", capacity: 2 }));
      return;
    }
    if (frame.type !== "command") return;
    relayCommands.push({
      path: frame.command.request.path,
      pathname: new URL(frame.command.request.path, localAddress).pathname,
      search: new URL(frame.command.request.path, localAddress).search,
      completed: false,
    });
    const commandRecord = relayCommands[relayCommands.length - 1];
    const completion = () => {
      commandRecord.completed = true;
      const threadId = commandRecord.pathname.split("/")[3];
      const pending = waitsForTask.get(threadId);
      pending?.delete(completion);
      if (pending?.size === 0) waitsForTask.delete(threadId);
    };
    const threadId = commandRecord.pathname.split("/")[3];
    const pending = waitsForTask.get(threadId) ?? new Set();
    pending.add(completion);
    waitsForTask.set(threadId, pending);
    void (async () => {
      const target = new URL(frame.command.request.path, localAddress);
      const response = await fetch(target, {
        method: frame.command.request.method,
        headers: {
          ...frame.command.request.headers,
          "x-werelay-relay-prewarm": "live-prewarm-token",
        },
      });
      const body = Buffer.from(await response.arrayBuffer());
      device.send(JSON.stringify({
        version: 1,
        type: "response",
        response: {
          protocolVersion: 1,
          commandId: frame.command.id,
          statusCode: response.status,
          headers: { "content-type": "application/json" },
          ...(body.length ? { bodyBase64: body.toString("base64") } : {}),
        },
      }));
    })().catch(() => device.terminate()).finally(completion);
  });
  device.send(JSON.stringify({ version: 1, type: "ready", capacity: 2 }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  if ((await fetch(relay.baseUrl + "/api/auth/status", {
    headers: { cookie },
  })).status !== 200) throw new Error("browser authentication failed");

  const opened = await openLive();
  live = opened.socket;
  const { messages, messageWaiters } = opened;
  await waitForMessage(messages, (message) => message.type === "hello", 3_000, messageWaiters);
  live.send(JSON.stringify({
    v: 1,
    type: "subscribe",
    adapter: "codex",
    threadId: "task-1",
  }));
  live.send(JSON.stringify({ v: 1, type: "ping" }));
  await waitForMessage(messages, (message) => message.type === "pong", 3_000, messageWaiters);

  targetRefreshStarted = true;
  device.send(JSON.stringify({
    version: 1,
    type: "event",
    event: {
      kind: "conversation",
      adapter: "codex",
      threadId: "task-2",
      revision: "ignored",
    },
  }));
  device.send(JSON.stringify({
    version: 1,
    type: "event",
    event: {
      kind: "conversation",
      adapter: "codex",
      threadId: "task-1",
      revision: "revision-1",
    },
  }));
  await waitForMessage(messages, (message) => message.type === "changed", 3_000, messageWaiters);
  device.send(JSON.stringify({
    version: 1,
    type: "event",
    event: { kind: "tasks", adapter: "claude" },
  }));
  await waitForMessage(
    messages,
    (message) => message.type === "tasks-changed",
    3_000,
    messageWaiters,
  );
  await waitForNoPendingTask("task-1");
  live.send(JSON.stringify({
    v: 1,
    type: "subscribe",
    adapter: "codex",
    threadId: "task-slow",
  }));
  live.send(JSON.stringify({
    v: 1,
    type: "subscribe",
    adapter: "slow",
    threadId: "unused",
  }));
  live.send(JSON.stringify({ v: 1, type: "ping" }));
  await waitForMessage(
    messages,
    (message) => message.type === "pong" &&
      messages.filter((item) => item.type === "pong").length >= 2,
    3_000,
    messageWaiters,
  );
  device.send(JSON.stringify({ version: 1, type: "ready", capacity: 8 }));
  const delayedConversationStartedAt = Date.now();
  device.send(JSON.stringify({
    version: 1,
    type: "event",
    event: {
      kind: "conversation",
      adapter: "codex",
      threadId: "task-slow",
      revision: "revision-slow",
    },
  }));
  await waitForMessage(
    messages,
    (message) => message.type === "changed" && message.threadId === "task-slow",
    4_000,
    messageWaiters,
  );
  const delayedConversationChangedAfterMs = Date.now() - delayedConversationStartedAt;
  const delayedTasksStartedAt = Date.now();
  device.send(JSON.stringify({
    version: 1,
    type: "event",
    event: { kind: "tasks", adapter: "slow" },
  }));
  await waitForMessage(
    messages,
    (message) => message.type === "tasks-changed" && message.adapter === "slow",
    4_000,
    messageWaiters,
  );
  const delayedTasksChangedAfterMs = Date.now() - delayedTasksStartedAt;
  for (let index = 0; index < 7; index += 1) {
    live.send(JSON.stringify({
      v: 1,
      type: "subscribe",
      adapter: "codex",
      threadId: `limit-${index}`,
    }));
  }
  live.send(JSON.stringify({ v: 1, type: "ping" }));
  await waitForMessage(
    messages,
    (message) => message.type === "pong" &&
      messages.filter((item) => item.type === "pong").length >= 2,
    3_000,
    messageWaiters,
  );
  const subscriptionClose = closeCode(live);
  live.send(JSON.stringify({
    v: 1,
    type: "subscribe",
    adapter: "codex",
    threadId: "limit-overflow",
  }));
  const subscriptionLimitCloseCode = await subscriptionClose;
  const afterUnsubscribeStartedAt = Date.now();
  device.send(JSON.stringify({
    version: 1,
    type: "event",
    event: {
      kind: "conversation",
      adapter: "codex",
      threadId: "task-slow",
      revision: "revision-after-unsubscribe",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 2_300));
  const afterUnsubscribeReceived = messages.some(
    (message) => message.revision === "revision-after-unsubscribe",
  );
  const afterUnsubscribeElapsedMs = Date.now() - afterUnsubscribeStartedAt;

  expiringRelay = await startWeRelayRelayServer({
    host: "127.0.0.1",
    port: 0,
    deviceId: "test-device",
    deviceToken: "synthetic-device-token",
    warmCacheTtlMs: 500,
    warmCacheFreshMs: 0,
    warmRefreshIntervalMs: 60_000,
    pollTimeoutMs: 20,
    deviceOfflineMs: 5_000,
  });
  expiringClient = startWeRelayRelayClient({
    transport: "long-poll",
    relayUrl: expiringRelay.baseUrl,
    deviceId: "test-device",
    deviceToken: "synthetic-device-token",
    localBaseUrl: `http://127.0.0.1:${local.address().port}`,
    localPrewarmToken: "live-prewarm-token",
    retryDelayMs: 5,
  });
  let expiringOnline = false;
  const expiringDeadline = Date.now() + 3_000;
  while (Date.now() < expiringDeadline) {
    expiringOnline = Boolean((await (
      await fetch(expiringRelay.baseUrl + "/health")
    ).json()).deviceOnline);
    if (expiringOnline) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!expiringOnline) throw new Error("expiry fixture device did not connect");
  const expiringCookie = `codex_mobile_session=v1.${Date.now() + 60_000}.expire.signature`;
  await fetch(expiringRelay.baseUrl + "/api/auth/status", {
    headers: { cookie: expiringCookie },
  });
  expiringLive = new WebSocket(
    expiringRelay.baseUrl.replace("http:", "ws:") + "/api/live",
    { headers: { cookie: expiringCookie, origin: expiringRelay.baseUrl } },
  );
  expiringLive.on("error", () => undefined);
  await new Promise((resolve, reject) => {
    expiringLive.once("open", resolve);
    expiringLive.once("error", reject);
  });
  const expiringClose = closeCode(expiringLive);
  const sessionExpiryCloseCode = await expiringClose;

  console.log(JSON.stringify({
    rejected,
    messages,
    unsubscribedTaskReceived: messages.some((message) =>
      message.threadId === "task-2"),
    changedBeforeRefresh,
    targetRefreshStarted: relayCommands.some((command) =>
      command.pathname === "/api/tasks/task-1/messages" &&
      command.search.includes("limit=5")),
    delayedConversationChangedAfterMs,
    delayedTasksChangedAfterMs,
    afterUnsubscribeReceived,
    afterUnsubscribeElapsedMs,
    subscriptionLimitCloseCode,
    sessionExpiryCloseCode,
  }));
} finally {
  expiringLive?.terminate();
  live?.terminate();
  device?.terminate();
  await expiringClient?.close();
  await expiringRelay?.close();
  await relay.close();
  local.closeAllConnections();
  await new Promise((resolve) => local.close(resolve));
}

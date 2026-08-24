import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { encodeCodexMobileTaskShortCode } from "../../src/daemon/codex-mobile-server.ts";
import {
  startWeRelayRelayClient,
  type WeRelayRelayClientHandle,
} from "../../src/relay/relay-client.ts";
import {
  WERELAY_RELAY_POLL_PATH,
} from "../../src/relay/relay-protocol.ts";
import {
  startWeRelayRelayServer,
  type WeRelayRelayServerHandle,
} from "../../src/relay/relay-server.ts";
import {
  createWeRelayRelayTaskLinkAlias,
  WERELAY_RELAY_TASK_LINK_REGISTER_PATH,
} from "../../src/relay/relay-task-links.ts";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

async function startLocalMobileStub() {
  const received: Array<{
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body,
      });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": "codex_mobile_session=test-session; Path=/; HttpOnly; Secure",
      });
      response.end(JSON.stringify({
        ok: true,
        method: request.method,
        path: request.url,
        body: body ? JSON.parse(body) : null,
      }));
    })();
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("missing local address"));
        return;
      }
      resolve(address.port);
    });
  });
  closers.push(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  });
  return { port, received };
}

async function waitUntilOnline(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const payload = await fetch(`${baseUrl}/health`).then((response) => response.json()) as {
      deviceOnline?: boolean;
    };
    if (payload.deviceOnline) {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error("relay client did not connect");
}

describe("WeRelay application relay", () => {
  test("serves versioned assets with immutable caching, validators, and compression", async () => {
    const relay = await startWeRelayRelayServer({
      host: "127.0.0.1",
      port: 0,
      deviceId: "asset-device",
      deviceToken: "asset-token",
    });
    closers.push(() => relay.close());

    const response = await fetch(`${relay.baseUrl}/app.js`, {
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control"))
      .toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("etag")).toBeTruthy();
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(["br", "gzip"]).toContain(response.headers.get("content-encoding"));
    expect(await response.text()).toContain("WeRelay");

    const notModified = await fetch(`${relay.baseUrl}/app.js`, {
      headers: { "if-none-match": response.headers.get("etag") ?? "" },
    });
    expect(notModified.status).toBe(304);
  });

  test("prewarms authenticated task data before the browser opens again", async () => {
    const sessionToken = `v1.${Date.now() + 60_000}.nonce.signature`;
    let version = 1;
    const requestCounts = new Map<string, number>();
    const localServer = http.createServer((request, response) => {
      const path = request.url ?? "/";
      const url = new URL(path, "http://werelay.local");
      requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
      const prewarmAuthorized = request.headers["x-werelay-relay-prewarm"] ===
        "local-prewarm-secret";
      if (
        request.headers.cookie !== `codex_mobile_session=${sessionToken}` &&
        !prewarmAuthorized
      ) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "请先登录。" }));
        return;
      }
      let payload: unknown;
      if (url.pathname === "/api/auth/status") {
        payload = { authenticated: true, configured: true, canSetup: false };
      } else if (url.pathname === "/api/adapters") {
        payload = {
          activeAdapter: "codex",
          adapters: [
            { id: "codex", label: "Codex", status: "idle", active: true },
            { id: "claude", label: "Claude Code", status: "idle", active: false },
          ],
        };
      } else if (url.pathname === "/api/task-board") {
        payload = {
          tasks: [
            {
              adapter: "codex",
              adapterLabel: "Codex",
              threadId: "thread-1",
              title: `任务列表 ${version}`,
              status: "idle",
              lastUpdatedAt: `2026-08-15T00:00:0${version}.000Z`,
            },
            {
              adapter: "claude",
              adapterLabel: "Claude Code",
              threadId: "claude-thread",
              title: `Claude 任务 ${version}`,
              status: "idle",
              lastUpdatedAt: "2026-08-14T23:59:59.000Z",
            },
          ],
          recentCompleted: [],
        };
      } else if (url.pathname === "/api/tasks") {
        const adapter = url.searchParams.get("adapter") || "codex";
        payload = {
          tasks: [{
            threadId: adapter === "claude" ? "claude-thread" : "thread-1",
            title: adapter === "claude" ? `Claude 任务 ${version}` : `任务列表 ${version}`,
            status: "idle",
            lastUpdatedAt: `2026-08-15T00:00:0${version}.000Z`,
          }],
        };
      } else {
        const threadId = url.pathname.includes("claude-thread") ? "claude-thread" : "thread-1";
        payload = {
          threadId,
          messages: [{ role: "assistant", text: `${threadId} 任务详情 ${version}` }],
          queuedMessages: [],
          progressItems: [],
          runSummary: null,
          pendingApproval: null,
          approvalResults: [],
          revision: `revision-${version}`,
        };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
    const localPort = await new Promise<number>((resolve, reject) => {
      localServer.once("error", reject);
      localServer.listen(0, "127.0.0.1", () => {
        const address = localServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("missing local address"));
          return;
        }
        resolve(address.port);
      });
    });
    closers.push(async () => {
      await new Promise<void>((resolve) => {
        localServer.close(() => resolve());
        localServer.closeAllConnections?.();
      });
    });

    const relay = await startWeRelayRelayServer({
      host: "127.0.0.1",
      port: 0,
      deviceId: "example-device",
      deviceToken: "test-device-token",
      pollTimeoutMs: 30,
      deviceOfflineMs: 60,
      warmRefreshIntervalMs: 60_000,
      warmCacheFreshMs: 5,
    });
    closers.push(() => relay.close());
    const client = startWeRelayRelayClient({
      relayUrl: relay.baseUrl,
      deviceId: "example-device",
      deviceToken: "test-device-token",
      localBaseUrl: `http://127.0.0.1:${localPort}`,
      localPrewarmToken: "local-prewarm-secret",
      retryDelayMs: 10,
    });
    closers.push(() => client.close());
    await waitUntilOnline(relay.baseUrl);

    const headers = { cookie: `codex_mobile_session=${sessionToken}` };
    const tasksPath = "/api/tasks?adapter=codex";
    const messagesPath = "/api/tasks/thread-1/messages?limit=40&history=1&adapter=codex";
    const claudeMessagesPath =
      "/api/tasks/claude-thread/messages?limit=40&history=1&adapter=claude";
    const firstWarmDeadline = Date.now() + 2_000;
    while (
      Date.now() < firstWarmDeadline &&
      ((requestCounts.get(tasksPath) ?? 0) < 1 ||
        (requestCounts.get(messagesPath) ?? 0) < 1 ||
        (requestCounts.get(claudeMessagesPath) ?? 0) < 1)
    ) await Bun.sleep(20);
    expect(requestCounts.get(tasksPath)).toBeGreaterThanOrEqual(1);
    expect(requestCounts.get(messagesPath)).toBeGreaterThanOrEqual(1);
    expect(requestCounts.get(claudeMessagesPath)).toBeGreaterThanOrEqual(1);

    const taskCountBeforeUpdate = requestCounts.get(tasksPath) ?? 0;
    const messageCountBeforeUpdate = requestCounts.get(messagesPath) ?? 0;
    version = 2;
    const deadline = Date.now() + 2_000;
    while (
      Date.now() < deadline &&
      ((requestCounts.get(tasksPath) ?? 0) <= taskCountBeforeUpdate ||
        (requestCounts.get(messagesPath) ?? 0) <= messageCountBeforeUpdate)
    ) await Bun.sleep(20);
    expect(requestCounts.get(tasksPath)).toBeGreaterThan(taskCountBeforeUpdate);
    expect(requestCounts.get(messagesPath)).toBeGreaterThan(messageCountBeforeUpdate);

    const authStatus = await fetch(`${relay.baseUrl}/api/auth/status`, { headers });
    expect(await authStatus.json()).toMatchObject({ authenticated: true });
    const preloadedTasks = await fetch(`${relay.baseUrl}${tasksPath}`, { headers });
    expect(preloadedTasks.headers.get("x-werelay-cache")).toBe("warm");
    expect(await preloadedTasks.json()).toMatchObject({
      tasks: [{ title: "任务列表 2" }],
    });

    await client.close();
    await Bun.sleep(90);
    const cachedTasks = await fetch(`${relay.baseUrl}${tasksPath}`, { headers });
    expect(cachedTasks.status).toBe(200);
    expect(cachedTasks.headers.get("x-werelay-cache")).toBe("warm");
    expect(await cachedTasks.json()).toMatchObject({
      tasks: [{ title: "任务列表 2" }],
    });
    const cachedMessages = await fetch(`${relay.baseUrl}${messagesPath}`, { headers });
    expect(cachedMessages.headers.get("x-werelay-cache")).toBe("warm");
    expect(await cachedMessages.json()).toMatchObject({
      messages: [{ text: "thread-1 任务详情 2" }],
    });

    const rejected = await fetch(`${relay.baseUrl}${tasksPath}`, {
      headers: { cookie: "codex_mobile_session=another-session" },
    });
    expect(rejected.status).toBe(503);
  });

  test("invalidates every browser warm cache after a successful write", async () => {
    const sessionOne = `v1.${Date.now() + 60_000}.one.signature`;
    const sessionTwo = `v1.${Date.now() + 60_000}.two.signature`;
    let version = 1;
    const localServer = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://werelay.local");
      const cookie = request.headers.cookie;
      const authenticated = cookie === `codex_mobile_session=${sessionOne}` ||
        cookie === `codex_mobile_session=${sessionTwo}`;
      if (!authenticated) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "请先登录。" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (url.pathname === "/api/auth/status") {
        response.end(JSON.stringify({ authenticated: true, configured: true }));
      } else if (request.method === "POST") {
        response.end(JSON.stringify({ queued: false }));
      } else {
        response.end(JSON.stringify({ currentModel: `model-${version}`, options: [] }));
      }
    });
    const localPort = await new Promise<number>((resolve, reject) => {
      localServer.once("error", reject);
      localServer.listen(0, "127.0.0.1", () => {
        const address = localServer.address();
        if (!address || typeof address === "string") reject(new Error("missing local address"));
        else resolve(address.port);
      });
    });
    closers.push(async () => {
      await new Promise<void>((resolve) => {
        localServer.close(() => resolve());
        localServer.closeAllConnections?.();
      });
    });
    const relay = await startWeRelayRelayServer({
      host: "127.0.0.1",
      port: 0,
      deviceId: "example-device",
      deviceToken: "test-device-token",
      pollTimeoutMs: 30,
      deviceOfflineMs: 200,
      warmRefreshIntervalMs: 1_000,
    });
    closers.push(() => relay.close());
    const client = startWeRelayRelayClient({
      relayUrl: relay.baseUrl,
      deviceId: "example-device",
      deviceToken: "test-device-token",
      localBaseUrl: `http://127.0.0.1:${localPort}`,
      retryDelayMs: 10,
    });
    closers.push(() => client.close());
    await waitUntilOnline(relay.baseUrl);

    const headersOne = { cookie: `codex_mobile_session=${sessionOne}` };
    const headersTwo = { cookie: `codex_mobile_session=${sessionTwo}` };
    const modelPath = "/api/tasks/thread-1/model?adapter=codex";
    await fetch(`${relay.baseUrl}/api/auth/status`, { headers: headersOne });
    await fetch(`${relay.baseUrl}/api/auth/status`, { headers: headersTwo });
    await fetch(`${relay.baseUrl}${modelPath}`, { headers: headersOne });
    await fetch(`${relay.baseUrl}${modelPath}`, { headers: headersTwo });
    expect((await fetch(`${relay.baseUrl}${modelPath}`, { headers: headersTwo }))
      .headers.get("x-werelay-cache")).toBe("warm");

    version = 2;
    const sent = await fetch(`${relay.baseUrl}/api/tasks/thread-1/messages?adapter=codex`, {
      method: "POST",
      headers: { ...headersOne, "content-type": "application/json" },
      body: JSON.stringify({ text: "更新缓存", images: [] }),
    });
    expect(sent.status).toBe(200);
    const refreshed = await fetch(`${relay.baseUrl}${modelPath}`, { headers: headersTwo });
    expect(refreshed.headers.get("x-werelay-cache")).toBeNull();
    expect(await refreshed.json()).toMatchObject({ currentModel: "model-2" });
  });

  test("resumes device prewarming after the cache ttl has elapsed", async () => {
    let clockMs = Date.now();
    let taskRequests = 0;
    const localServer = http.createServer((request, response) => {
      if (request.url === "/api/tasks") taskRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/api/adapters"
        ? { activeAdapter: "codex", adapters: [] }
        : { tasks: [] }));
    });
    const localPort = await new Promise<number>((resolve, reject) => {
      localServer.once("error", reject);
      localServer.listen(0, "127.0.0.1", () => {
        const address = localServer.address();
        if (!address || typeof address === "string") reject(new Error("missing local address"));
        else resolve(address.port);
      });
    });
    closers.push(async () => {
      await new Promise<void>((resolve) => {
        localServer.close(() => resolve());
        localServer.closeAllConnections?.();
      });
    });
    const relay = await startWeRelayRelayServer({
      host: "127.0.0.1",
      port: 0,
      deviceId: "example-device",
      deviceToken: "test-device-token",
      pollTimeoutMs: 20,
      deviceOfflineMs: 500,
      warmRefreshIntervalMs: 10,
      warmCacheFreshMs: 0,
      warmCacheTtlMs: 20,
      now: () => clockMs,
    });
    closers.push(() => relay.close());
    const client = startWeRelayRelayClient({
      relayUrl: relay.baseUrl,
      deviceId: "example-device",
      deviceToken: "test-device-token",
      localBaseUrl: `http://127.0.0.1:${localPort}`,
      localPrewarmToken: "local-prewarm-secret",
      retryDelayMs: 5,
    });
    closers.push(() => client.close());
    await waitUntilOnline(relay.baseUrl);
    const firstDeadline = Date.now() + 1_000;
    while (Date.now() < firstDeadline && taskRequests < 1) await Bun.sleep(10);
    expect(taskRequests).toBeGreaterThanOrEqual(1);

    await Bun.sleep(30);
    clockMs += 100;
    const beforeResume = taskRequests;
    const resumeDeadline = Date.now() + 1_000;
    while (Date.now() < resumeDeadline && taskRequests <= beforeResume) await Bun.sleep(10);
    expect(taskRequests).toBeGreaterThan(beforeResume);
  });

  test("serves the mobile shell and forwards only mobile API requests through the Mac client", async () => {
    const local = await startLocalMobileStub();
    const relay: WeRelayRelayServerHandle = await startWeRelayRelayServer({
      host: "127.0.0.1",
      port: 0,
      deviceId: "example-device",
      deviceToken: "test-device-token",
      pollTimeoutMs: 100,
      deviceOfflineMs: 500,
    });
    closers.push(() => relay.close());
    const client: WeRelayRelayClientHandle = startWeRelayRelayClient({
      relayUrl: relay.baseUrl,
      deviceId: "example-device",
      deviceToken: "test-device-token",
      localBaseUrl: `http://127.0.0.1:${local.port}`,
      retryDelayMs: 10,
    });
    closers.push(() => client.close());

    await waitUntilOnline(relay.baseUrl);

    const page = await fetch(`${relay.baseUrl}/?task=thread-1`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("WeRelay");
    expect(local.received).toHaveLength(0);

    const tasks = await fetch(`${relay.baseUrl}/api/tasks?adapter=codex`, {
      headers: {
        cookie: "codex_mobile_session=browser-session",
        "x-forwarded-proto": "https",
        "x-real-ip": "203.0.113.7",
      },
    });
    expect(tasks.status).toBe(200);
    expect(await tasks.json()).toMatchObject({
      ok: true,
      method: "GET",
      path: "/api/tasks?adapter=codex",
    });
    expect(tasks.headers.get("set-cookie")).toContain("test-session");
    expect(local.received[0]?.headers["x-real-ip"]).toBe("203.0.113.7");
    expect(local.received[0]?.headers["x-forwarded-proto"]).toBe("https");
    expect(local.received[0]?.headers.cookie).toBe(
      "codex_mobile_session=browser-session",
    );

    const send = await fetch(`${relay.baseUrl}/api/tasks/thread-1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "从手机继续当前任务", images: [] }),
    });
    expect(send.status).toBe(200);
    expect(await send.json()).toMatchObject({
      body: { text: "从手机继续当前任务", images: [] },
    });
    const forwardedSend = local.received.find(function (entry) {
      return entry.method === "POST" && entry.url === "/api/tasks/thread-1/messages";
    });
    expect(forwardedSend?.body).toContain("从手机继续当前任务");

    const switchModel = await fetch(
      `${relay.baseUrl}/api/tasks/thread-1/model?adapter=codex`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6" }),
      },
    );
    expect(switchModel.status).toBe(200);
    expect(await switchModel.json()).toMatchObject({
      method: "PUT",
      path: "/api/tasks/thread-1/model?adapter=codex",
      body: { model: "gpt-5.6" },
    });
    expect(local.received).toContainEqual(expect.objectContaining({
      method: "PUT",
      url: "/api/tasks/thread-1/model?adapter=codex",
      body: JSON.stringify({ model: "gpt-5.6" }),
    }));
  });

  test("rejects unauthenticated device polls and reports an offline Mac in Chinese", async () => {
    const relay = await startWeRelayRelayServer({
      host: "127.0.0.1",
      port: 0,
      deviceId: "example-device",
      deviceToken: "test-device-token",
      pollTimeoutMs: 50,
      deviceOfflineMs: 50,
    });
    closers.push(() => relay.close());

    const poll = await fetch(`${relay.baseUrl}${WERELAY_RELAY_POLL_PATH}`, {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-token",
        "x-werelay-device-id": "example-device",
      },
    });
    expect(poll.status).toBe(401);

    const tasks = await fetch(`${relay.baseUrl}/api/tasks`);
    expect(tasks.status).toBe(503);
    expect(await tasks.json()).toEqual({
      error: "电脑当前离线，请确认 WeRelay 正在运行。",
    });
  });

  test("resolves task short links while the Mac is offline", async () => {
    const relay = await startWeRelayRelayServer({
      host: "127.0.0.1",
      port: 0,
      deviceId: "example-device",
      deviceToken: "test-device-token",
      pollTimeoutMs: 50,
      deviceOfflineMs: 50,
    });
    closers.push(() => relay.close());

    const code = encodeCodexMobileTaskShortCode(
      "workbuddy",
      "0000000a-0000-7000-8000-00000000000a",
    );
    const response = await fetch(`${relay.baseUrl}/t/${code}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "/?task=0000000a-0000-7000-8000-00000000000a&adapter=workbuddy&appv=",
    );
  });

  test("resolves registered ten-character task links after a relay restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-relay-links-"));
    const stateFile = path.join(directory, "task-links.json");
    const target = {
      adapter: "workbuddy",
      threadId: "0000000a-0000-7000-8000-00000000000a",
    };
    const alias = createWeRelayRelayTaskLinkAlias(
      "test-device-token",
      target.adapter,
      target.threadId,
    );
    const first = await startWeRelayRelayServer({
      host: "127.0.0.1",
      port: 0,
      deviceId: "example-device",
      deviceToken: "test-device-token",
      taskLinkStateFile: stateFile,
    });
    const register = await fetch(
      `${first.baseUrl}${WERELAY_RELAY_TASK_LINK_REGISTER_PATH}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-device-token",
          "content-type": "application/json",
          "x-werelay-device-id": "example-device",
        },
        body: JSON.stringify({ alias, ...target }),
      },
    );
    expect(register.status).toBe(200);
    await first.close();

    const restored = await startWeRelayRelayServer({
      host: "127.0.0.1",
      port: 0,
      deviceId: "example-device",
      deviceToken: "test-device-token",
      taskLinkStateFile: stateFile,
    });
    closers.push(async () => {
      await restored.close();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const response = await fetch(`${restored.baseUrl}/${alias}`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "/?task=0000000a-0000-7000-8000-00000000000a&adapter=workbuddy&appv=",
    );
  });
});

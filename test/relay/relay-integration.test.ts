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
  WERELAY_RELAY_PROTOCOL_VERSION,
  WERELAY_RELAY_RESPONSE_PATH,
  type WeRelayRelayCommand,
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
  test("delivers a queued write before older read requests", async () => {
    const relay = await startWeRelayRelayServer({
      host: "127.0.0.1",
      port: 0,
      deviceId: "priority-device",
      deviceToken: "priority-token",
      pollTimeoutMs: 10,
      commandTimeoutMs: 2_000,
    });
    closers.push(() => relay.close());
    const deviceHeaders = {
      authorization: "Bearer priority-token",
      "x-werelay-device-id": "priority-device",
      "content-type": "application/json",
    };
    await fetch(`${relay.baseUrl}${WERELAY_RELAY_POLL_PATH}`, {
      method: "POST",
      headers: deviceHeaders,
      body: "{}",
    });
    const readRequest = fetch(`${relay.baseUrl}/api/tasks`).catch(() => null);
    const writeRequest = fetch(`${relay.baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "draft-priority" }),
    }).catch(() => null);
    await Bun.sleep(10);

    const poll = async () => await fetch(`${relay.baseUrl}${WERELAY_RELAY_POLL_PATH}`, {
      method: "POST",
      headers: deviceHeaders,
      body: "{}",
    }).then((response) => response.json()) as WeRelayRelayCommand;
    const respond = async (command: WeRelayRelayCommand) => {
      await fetch(`${relay.baseUrl}${WERELAY_RELAY_RESPONSE_PATH}`, {
        method: "POST",
        headers: deviceHeaders,
        body: JSON.stringify({
          protocolVersion: WERELAY_RELAY_PROTOCOL_VERSION,
          commandId: command.id,
          statusCode: 200,
          headers: { "content-type": "application/json" },
          bodyBase64: Buffer.from('{"ok":true}').toString("base64"),
        }),
      });
    };
    const first = await poll();
    await respond(first);
    const second = await poll();
    await respond(second);
    await Promise.all([readRequest, writeRequest]);

    expect(first.request.method).toBe("POST");
    expect(second.request.method).toBe("GET");
  });

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

  test("refreshes cached browser paths only when the browser asks again", async () => {
    const sessionToken = `v1.${Date.now() + 60_000}.nonce.signature`;
    let version = 1;
    const requestCounts = new Map<string, number>();
    const localServer = http.createServer((request, response) => {
      const requestPath = request.url ?? "/";
      const url = new URL(requestPath, "http://werelay.local");
      requestCounts.set(requestPath, (requestCounts.get(requestPath) ?? 0) + 1);
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
      } else if (url.pathname === "/api/task-board") {
        payload = {
          tasks: [{
            adapter: "codex",
            threadId: "thread-1",
            title: `任务列表 ${version}`,
            status: "idle",
            lastUpdatedAt: `2026-08-15T00:00:0${version}.000Z`,
          }],
          recentCompleted: [],
        };
      } else if (url.pathname === "/api/tasks") {
        payload = {
          tasks: [{
            threadId: "thread-1",
            title: `任务列表 ${version}`,
            status: "idle",
            lastUpdatedAt: `2026-08-15T00:00:0${version}.000Z`,
          }],
        };
      } else {
        payload = {
          threadId: "thread-1",
          messages: [{ role: "assistant", text: `任务详情 ${version}` }],
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
      warmCacheFreshMs: 0,
      warmCacheTtlMs: 500,
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

    const tasksPath = "/api/tasks?adapter=codex";
    const boardPath = "/api/task-board";
    const messagesPath = "/api/tasks/thread-1/messages?limit=40&history=1&adapter=codex";
    await Bun.sleep(80);
    expect(requestCounts.get(tasksPath) ?? 0).toBe(0);
    expect(requestCounts.get(boardPath) ?? 0).toBe(0);
    expect(requestCounts.get(messagesPath) ?? 0).toBe(0);

    const headers = { cookie: `codex_mobile_session=${sessionToken}` };
    expect((await fetch(`${relay.baseUrl}/api/auth/status`, { headers })).status).toBe(200);
    expect((await fetch(`${relay.baseUrl}${tasksPath}`, { headers })).status).toBe(200);
    expect((await fetch(`${relay.baseUrl}${boardPath}`, { headers })).status).toBe(200);
    const messages = await fetch(`${relay.baseUrl}${messagesPath}`, { headers });
    expect(messages.status).toBe(200);
    expect(messages.headers.get("x-werelay-cache")).toBeNull();

    const initialTaskRequests = requestCounts.get(tasksPath) ?? 0;
    const initialBoardRequests = requestCounts.get(boardPath) ?? 0;
    const initialMessageRequests = requestCounts.get(messagesPath) ?? 0;
    version = 2;
    await Bun.sleep(120);
    expect(requestCounts.get(tasksPath)).toBe(initialTaskRequests);
    expect(requestCounts.get(boardPath)).toBe(initialBoardRequests);
    expect(requestCounts.get(messagesPath)).toBe(initialMessageRequests);

    const cachedTasks = await fetch(`${relay.baseUrl}${tasksPath}`, { headers });
    expect(cachedTasks.headers.get("x-werelay-cache")).toBe("warm");
    expect(await cachedTasks.json()).toMatchObject({
      tasks: [{ title: "任务列表 1" }],
    });
    const refreshDeadline = Date.now() + 1_000;
    while (
      Date.now() < refreshDeadline &&
      (requestCounts.get(tasksPath) ?? 0) <= initialTaskRequests
    ) await Bun.sleep(10);
    expect(requestCounts.get(tasksPath)).toBe(initialTaskRequests + 1);
    expect(requestCounts.get(boardPath)).toBe(initialBoardRequests);
    expect(requestCounts.get(messagesPath)).toBe(initialMessageRequests);

    const refreshedTasks = await fetch(`${relay.baseUrl}${tasksPath}`, { headers });
    expect(refreshedTasks.headers.get("x-werelay-cache")).toBe("warm");
    expect(await refreshedTasks.json()).toMatchObject({
      tasks: [{ title: "任务列表 2" }],
    });
    await Bun.sleep(30);
    const requestsAfterBrowserReads = [...requestCounts.entries()];
    await Bun.sleep(120);
    expect([...requestCounts.entries()]).toEqual(requestsAfterBrowserReads);
    expect(requestCounts.get(boardPath)).toBe(initialBoardRequests);
    expect(requestCounts.get(messagesPath)).toBe(initialMessageRequests);
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

describe("WeRelay relay local preview deployment", () => {
  test("stores the Mac snapshot on Relay and serves it only to the authenticated browser session", async () => {
    const deployment = {
      version: 1 as const,
      deploymentId: "preview-relay-test",
      sourceLabel: "127.0.0.1:17800/",
      entryPath: "index.html",
      createdAtMs: Date.now(),
      totalBytes: Buffer.byteLength("<h1>Relay 最新预览</h1>"),
      files: [{
        path: "index.html",
        contentType: "text/html; charset=utf-8",
        bodyBase64: Buffer.from("<h1>Relay 最新预览</h1>").toString("base64"),
      }],
    };
    const localServer = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://deskrelay.local");
      response.setHeader("content-type", "application/json; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/api/auth/status") {
        response.writeHead(200);
        response.end(JSON.stringify({
          authenticated: request.headers.cookie === "codex_mobile_session=preview-browser-session",
          configured: true,
          canSetup: false,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/previews/jobs") {
        response.writeHead(202);
        response.end(JSON.stringify({
          jobId: "preview-job-relay-test",
          status: "queued",
          progress: 4,
          message: "正在请求电脑准备最新内容",
        }));
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/previews/jobs/preview-job-relay-test"
      ) {
        expect(request.headers["x-werelay-relay"]).toBe("1");
        response.writeHead(200);
        response.end(JSON.stringify({
          jobId: "preview-job-relay-test",
          status: "ready",
          progress: 100,
          message: "部署完成，正在打开最新页面",
          deploymentId: deployment.deploymentId,
          entryPath: deployment.entryPath,
          readyUrl: `/preview/view/${deployment.deploymentId}`,
          previewPackage: deployment,
        }));
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: "not found" }));
    });
    const localPort = await new Promise<number>((resolve, reject) => {
      localServer.once("error", reject);
      localServer.listen(0, "127.0.0.1", () => {
        const address = localServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("missing local preview stub address"));
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
      pollTimeoutMs: 50,
      deviceOfflineMs: 500,
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

    const cookie = "codex_mobile_session=preview-browser-session";
    const progressPage = await fetch(
      `${relay.baseUrl}/preview/open?target=${encodeURIComponent("http://127.0.0.1:17800/")}`,
    );
    expect(progressPage.status).toBe(200);
    expect(await progressPage.text()).toContain(
      "正在部署到服务器上，以方便手机预览",
    );
    expect(progressPage.headers.get("content-security-policy")).toContain(
      "script-src 'nonce-",
    );

    const create = await fetch(`${relay.baseUrl}/api/previews/jobs`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ target: "http://127.0.0.1:17800/" }),
    });
    expect(create.status).toBe(202);

    const status = await fetch(
      `${relay.baseUrl}/api/previews/jobs/preview-job-relay-test`,
      { headers: { cookie } },
    );
    expect(status.status).toBe(200);
    const statusPayload = await status.json() as Record<string, unknown>;
    expect(statusPayload.readyUrl).toBe("/preview/view/preview-relay-test");
    expect(statusPayload.previewPackage).toBeUndefined();

    const unauthenticated = await fetch(
      `${relay.baseUrl}/preview/content/preview-relay-test/index.html`,
    );
    expect(unauthenticated.status).toBe(401);

    const view = await fetch(`${relay.baseUrl}/preview/view/preview-relay-test`, {
      headers: { cookie },
    });
    expect(view.status).toBe(200);
    expect(await view.text()).toContain(
      'sandbox="allow-scripts allow-downloads allow-popups allow-modals"',
    );
    expect(view.headers.get("content-security-policy")).toContain(
      "style-src 'nonce-",
    );

    const content = await fetch(
      `${relay.baseUrl}/preview/content/preview-relay-test/index.html`,
      { headers: { cookie } },
    );
    expect(content.status).toBe(200);
    expect(await content.text()).toContain("Relay 最新预览");
    expect(content.headers.get("content-security-policy")).toContain("sandbox");
    expect(content.headers.get("cache-control")).toBe("no-store");
  });
});

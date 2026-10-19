import { expect, test } from "bun:test";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startWeRelayRelayServer } from "../../src/relay/relay-server.ts";
import { startWeRelayRelayClient } from "../../src/relay/relay-client.ts";
import { WERELAY_RELAY_WEBSOCKET_PATH } from "../../src/relay/relay-protocol.ts";
import { relayWebSocketUrl } from "../../src/relay/relay-websocket-client.ts";

const headers = { authorization: "Bearer synthetic-device-token", "x-werelay-device-id": "test-device" };
const waitFor = async (predicate: () => boolean) => {
  const until = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("relay socket condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
async function localStub() {
  let writes = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "POST") writes++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
    writes: () => writes,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
function rawSocket(base: string, extra: Record<string, string> = {}) {
  return new WebSocket(base.replace("http:", "ws:") + WERELAY_RELAY_WEBSOCKET_PATH, { headers: { ...headers, ...extra } });
}

test("WSS URL requires TLS outside loopback and never carries authentication", () => {
  expect(relayWebSocketUrl("https://relay.example")).toBe("wss://relay.example/__werelay/device/ws");
  expect(relayWebSocketUrl("http://127.0.0.1:1234")).toBe("ws://127.0.0.1:1234/__werelay/device/ws");
  expect(() => relayWebSocketUrl("http://relay.example")).toThrow("公网必须使用");
});

test("device socket rejects wrong token and browser Origin without claiming online", async () => {
  // Bun 1.3.1 drops manual upgrade rejection bodies; use the production Node
  // HTTP server/client to assert actual status codes rather than weakening them.
  const fixture = new URL("./fixtures/websocket-auth.mjs", import.meta.url);
  const result = await promisify(execFile)("node", ["--experimental-transform-types", fileURLToPath(fixture)], { timeout: 8_000 });
  expect(JSON.parse(result.stdout)).toEqual({ rejected: [401, 403, 404], deviceOnline: false,
    transport: "websocket", nativeResponse: "native-node-response" });
});

test("auto client uses socket for original API writes without polling and acknowledges responses", async () => {
  const local = await localStub();
  const server = await startWeRelayRelayServer({ port: 0, deviceId: "test-device", deviceToken: "synthetic-device-token" });
  let polls = 0, responds = 0, connected = false;
  const fetchImpl: typeof fetch = (input, init) => {
    if (String(input).endsWith("/device/poll")) polls++;
    if (String(input).endsWith("/device/respond")) responds++;
    return fetch(input, init);
  };
  const client = startWeRelayRelayClient({ relayUrl: server.baseUrl, localBaseUrl: local.url,
    deviceId: "test-device", deviceToken: "synthetic-device-token", fetchImpl,
    onConnectionChange: (status) => { connected = status === "connected"; } });
  try {
    await waitFor(() => connected);
    const r = await fetch(server.baseUrl + "/api/tasks/original/messages", { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ path: "/api/tasks/original/messages" });
    expect(local.writes()).toBe(1);
    expect(polls).toBe(0);
    expect(responds).toBe(0);
  } finally { await client.close(); await server.close(); await local.close(); }
});

test("only one authenticated socket consumes work; replacement closes old owner and excludes poll", async () => {
  const server = await startWeRelayRelayServer({ port: 0, deviceId: "test-device", deviceToken: "synthetic-device-token" });
  const first = rawSocket(server.baseUrl);
  let firstClosed = false, hello = false;
  first.on("close", () => { firstClosed = true; });
  first.on("message", () => { hello = true; });
  try {
    await waitFor(() => hello);
    const second = rawSocket(server.baseUrl);
    second.on("error", () => undefined);
    try {
      await waitFor(() => firstClosed);
      const poll = await fetch(server.baseUrl + "/__werelay/device/poll", { method: "POST", headers, body: "{}" });
      expect(poll.status).toBe(409);
      second.send(JSON.stringify({ version: 1, type: "ready", capacity: 99 }));
      let invalidClosed = false;
      second.on("close", () => { invalidClosed = true; });
      await waitFor(() => invalidClosed);
    } finally { second.terminate(); }
  } finally { first.terminate(); await server.close(); }
});

test("server heartbeat deadline removes a half-open device independently of queued work", async () => {
  const server = await startWeRelayRelayServer({ port: 0, deviceId: "test-device", deviceToken: "synthetic-device-token", webSocketHeartbeatTimeoutMs: 40, deviceOfflineMs: 40 });
  const socket = rawSocket(server.baseUrl);
  let closed = false;
  socket.on("close", () => { closed = true; });
  try {
    await waitFor(() => closed);
    expect(await (await fetch(server.baseUrl + "/health")).json()).toMatchObject({ deviceOnline: false });
  } finally { socket.terminate(); await server.close(); }
});

test("old Relay upgrade failure falls back to HTTPS and reattempts WSS without concurrent polling", async () => {
  let polls = 0, upgrades = 0, activePolls = 0, maxPolls = 0;
  const old = http.createServer((req, res) => {
    if (req.url?.endsWith("/poll")) {
      polls++;activePolls++;maxPolls = Math.max(maxPolls, activePolls);
      setTimeout(() => { activePolls--;res.writeHead(204);res.end(); }, 20);
    } else { res.writeHead(204);res.end(); }
  });
  old.on("upgrade", (_req, socket) => { upgrades++;socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(old.address() as import("node:net").AddressInfo).port}`;
  const client = startWeRelayRelayClient({ relayUrl: url, localBaseUrl: url, deviceId: "test-device", deviceToken: "synthetic-device-token", webSocketHandshakeTimeoutMs: 100, webSocketRetryIntervalMs: 25 });
  try {
    await waitFor(() => upgrades > 1 && polls > 1);
    expect(maxPolls).toBe(1);
  } finally { await client.close();old.closeAllConnections();await new Promise<void>((resolve) => old.close(() => resolve())); }
});

test("WSS loses response acknowledgement, retries same ID and executes write only once", async () => {
  const local = await localStub();
  const server = http.createServer((req, res) => { res.writeHead(404);res.end(); });
  const { WebSocketServer } = await import("ws");
  const sockets = new WebSocketServer({ server });
  let connections = 0, acked = false;
  const command = { protocolVersion: 1, id: "same-write", deviceId: "test-device", createdAtMs: Date.now(), expiresAtMs: Date.now() + 5_000,
    request: { method: "POST", path: "/api/tasks/original/messages", headers: {}, clientAddress: "127.0.0.1", forwardedProto: "https", bodyBase64: Buffer.from("{}").toString("base64") } };
  sockets.on("connection", (socket) => {
    connections++;let sent = false;
    socket.send(JSON.stringify({ version: 1, type: "hello" }));
    socket.on("message", (data) => {
      const value = JSON.parse(data.toString());
      if (value.type === "ready" && !sent) { sent = true;socket.send(JSON.stringify({ version: 1, type: "command", command })); }
      if (value.type === "response") {
        if (connections === 1) socket.terminate();
        else { acked = true;socket.send(JSON.stringify({ version: 1, type: "ack", commandId: "same-write" })); }
      }
      if (value.type === "heartbeat") socket.send(JSON.stringify({ version: 1, type: "heartbeat-ack" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const client = startWeRelayRelayClient({ relayUrl: url, localBaseUrl: local.url, deviceId: "test-device", deviceToken: "synthetic-device-token", retryDelayMs: 5,
    webSocketRetryIntervalMs: 10, heartbeatIntervalMs: 100 });
  try {
    await waitFor(() => acked);
    expect(connections).toBeGreaterThan(1);
    expect(local.writes()).toBe(1);
  } finally { await client.close();sockets.close();server.closeAllConnections();await new Promise<void>((resolve) => server.close(() => resolve()));await local.close(); }
});

test("client heartbeat timeout falls back instead of trusting an open but silent socket", async () => {
  const { WebSocketServer } = await import("ws");
  let polls = 0;
  const server = http.createServer((_req, res) => { polls++;res.writeHead(204);res.end(); });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => socket.send(JSON.stringify({ version: 1, type: "hello" })));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const client = startWeRelayRelayClient({ relayUrl: url, localBaseUrl: url, deviceId: "test-device", deviceToken: "synthetic-device-token",
    heartbeatIntervalMs: 10, webSocketHeartbeatTimeoutMs: 30, webSocketRetryIntervalMs: 1_000 });
  try { await waitFor(() => polls > 0);expect(polls).toBeGreaterThan(0); }
  finally { await client.close();sockets.close();server.closeAllConnections();await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("socket capacity bounds busy reads while heartbeat stays online and writes remain serial", async () => {
  let active = 0, peak = 0;
  const order: string[] = [];
  const local = http.createServer((req, res) => {
    active++;peak = Math.max(peak, active);
    setTimeout(() => {
      if (req.method === "POST") order.push(req.url!);
      active--;res.setHeader("content-type", "application/json");res.end("{}");
    }, 40);
  });
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  const localUrl = `http://127.0.0.1:${(local.address() as import("node:net").AddressInfo).port}`;
  const server = await startWeRelayRelayServer({ port: 0, deviceId: "test-device", deviceToken: "synthetic-device-token", deviceOfflineMs: 50 });
  let connected = false;
  const client = startWeRelayRelayClient({ relayUrl: server.baseUrl, localBaseUrl: localUrl, deviceId: "test-device", deviceToken: "synthetic-device-token", heartbeatIntervalMs: 10,
    onConnectionChange: () => { connected = true; } });
  try {
    await waitFor(() => connected);
    const reads = Array.from({ length: 12 }, (_, i) => fetch(server.baseUrl + `/api/read-${i}`).then(r => r.text()));
    const first = fetch(server.baseUrl + "/api/write-first", { method: "POST" }).then(r => r.text());
    const second = fetch(server.baseUrl + "/api/write-second", { method: "POST" }).then(r => r.text());
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(await (await fetch(server.baseUrl + "/health")).json()).toMatchObject({ deviceOnline: true });
    await Promise.all([...reads, first, second]);
    expect(peak).toBeLessThanOrEqual(8);
    expect(order).toEqual(["/api/write-first", "/api/write-second"]);
  } finally { await client.close();await server.close();local.closeAllConnections();await new Promise<void>((resolve) => local.close(() => resolve())); }
});

import http from "node:http";
import console from "node:console";
import { setTimeout } from "node:timers";
import { randomBytes } from "node:crypto";
import { startWeRelayRelayServer } from "../../../src/relay/relay-server.ts";
import { startWeRelayRelayClient } from "../../../src/relay/relay-client.ts";

const relay = await startWeRelayRelayServer({ port: 0, deviceId: "test-device", deviceToken: "synthetic-device-token" });
try {
  const rejected = [];
  for (const input of [
    { path: "/__werelay/device/ws", headers: { authorization: "Bearer wrong-token" } },
    { path: "/__werelay/device/ws", headers: { origin: "https://relay.example" } },
    { path: "/__werelay/device/ws?token=synthetic", headers: {} },
  ]) {
    rejected.push(await new Promise((resolve, reject) => {
      const req = http.request(relay.baseUrl + input.path, { headers: {
        authorization: "Bearer synthetic-device-token", "x-werelay-device-id": "test-device",
        connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"), ...input.headers,
      } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("upgrade", (_res, socket) => { socket.destroy(); reject(new Error("Unexpected upgrade")); });
      req.on("error", reject);
      req.setTimeout(1_000, () => req.destroy(new Error("Upgrade timeout")));
      req.end();
    }));
  }
  const health = await (await globalThis.fetch(relay.baseUrl + "/health")).json();
  const local = http.createServer((_req, res) => { res.end("native-node-response"); });
  await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
  let connected = false;
  let transport;
  const client = startWeRelayRelayClient({ relayUrl: relay.baseUrl,
    localBaseUrl: `http://127.0.0.1:${local.address().port}`, deviceId: "test-device", deviceToken: "synthetic-device-token",
    onConnectionChange: (status) => { connected = status === "connected"; },
    onTransportChange: (next) => { transport = next; },
  });
  let nativeResponse;
  try {
    const until = Date.now() + 2_000;
    while (!connected && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    if (!connected) throw new Error("Native Node socket did not connect");
    nativeResponse = await (await globalThis.fetch(relay.baseUrl + "/api/native-node", { method: "POST" })).text();
  } finally {
    await client.close();
    local.closeAllConnections();
    await new Promise(resolve => local.close(resolve));
  }
  console.log(JSON.stringify({ rejected, deviceOnline: health.deviceOnline, transport, nativeResponse }));
} finally { await relay.close(); }

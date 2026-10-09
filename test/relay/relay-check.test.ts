import { expect, test } from "bun:test";
import { startWeRelayRelayServer } from "../../src/relay/relay-server.ts";
import { WERELAY_RELAY_CHECK_PATH, WERELAY_RELAY_POLL_PATH } from "../../src/relay/relay-protocol.ts";

test("pairing check authenticates without marking the computer online or replacing its poll", async () => {
  const relay = await startWeRelayRelayServer({ host: "127.0.0.1", port: 0, deviceId: "test-device", deviceToken: "test-secret-only", pollTimeoutMs: 400, deviceOfflineMs: 1000, now: () => 0 });
  const headers = { authorization: "Bearer test-secret-only", "x-werelay-device-id": "test-device" };
  try {
    const probe = (extra = headers) => fetch(relay.baseUrl + WERELAY_RELAY_CHECK_PATH, { headers: extra });
    expect((await probe({ ...headers, authorization: "Bearer wrong" })).status).toBe(401);
    expect((await probe({ ...headers, "x-werelay-device-id": "another" })).status).toBe(401);
    expect(await (await probe()).json()).toEqual({ ok: true, protocolVersion: 1 });
    expect((await fetch(relay.baseUrl + "/health").then((r) => r.json())).deviceOnline).toBe(false);
    // A zero clock isolates the long poll from automatic background cache warming.
    let pollFinished = false;
    const poll = fetch(relay.baseUrl + WERELAY_RELAY_POLL_PATH, { method: "POST", headers, body: "{}" }).then((r) => { pollFinished = true; return r; });
    await Bun.sleep(25);
    expect((await probe()).status).toBe(200);
    expect(pollFinished).toBe(false);
    expect((await poll).status).toBe(204);
  } finally { await relay.close(); }
});

test("relay reports real poll failures and successful connections to settings", async () => {
  const { startWeRelayRelayClient } = await import("../../src/relay/relay-client.ts");
  const states: string[] = [];
  let calls = 0;
  const client = startWeRelayRelayClient({
    relayUrl: "https://relay.example.com", localBaseUrl: "http://127.0.0.1:4396", deviceId: "test-device", deviceToken: "test-secret-only", retryDelayMs: 1,
    onConnectionChange: (state) => { states.push(state); },
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      calls++;
      if (calls === 1) return new Response(null, { status: 503 });
      if (calls === 2) return new Response(null, { status: 204 });
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new Error("aborted"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    }) as typeof fetch,
  });
  try {
    const deadline = Date.now() + 1000;
    while (states.length < 2 && Date.now() < deadline) await Bun.sleep(5);
    expect(states).toEqual(["disconnected", "connected"]);
  } finally { await client.close(); }
});

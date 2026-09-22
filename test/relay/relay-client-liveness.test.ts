import { describe, expect, test } from "bun:test";
import { startWeRelayRelayClient } from "../../src/relay/relay-client.ts";
import { WERELAY_RELAY_POLL_PATH, WERELAY_RELAY_RESPONSE_PATH, type WeRelayRelayCommand } from "../../src/relay/relay-protocol.ts";

const heartbeatPath = "/__werelay/device/heartbeat";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for relay state");
    await delay(5);
  }
}
function command(id: string, method = "GET"): WeRelayRelayCommand {
  return { protocolVersion: 1, id, deviceId: "device-1", createdAtMs: Date.now(), expiresAtMs: Date.now() + 10_000,
    request: { method: method as "GET" | "POST", path: "/api/tasks", headers: {}, clientAddress: "127.0.0.1", forwardedProto: "https" } };
}
function aborting(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    if (init?.signal?.aborted) { reject(init.signal.reason); return; }
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  });
}

describe("Relay liveness independent of business requests", () => {
  test("eight pending reads do not stop authenticated heartbeats and each read has a deadline", async () => {
    let polls = 0, heartbeats = 0, localSignals = 0;
    const releases: Array<() => void> = [];
    const responses: number[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(heartbeatPath)) { heartbeats += 1; return new Response(null, { status: 204 }); }
      if (url.endsWith(WERELAY_RELAY_POLL_PATH)) {
        polls += 1;
        return polls <= 8 ? Response.json(command(String(polls))) : await aborting(init);
      }
      if (url.endsWith(WERELAY_RELAY_RESPONSE_PATH)) { responses.push(JSON.parse(String(init?.body)).statusCode); return Response.json({ ok: true }); }
      if (init?.signal) localSignals += 1;
      return await new Promise<Response>((resolve, reject) => {
        releases.push(() => resolve(Response.json({})));
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as typeof fetch;
    const client = startWeRelayRelayClient({ relayUrl: "https://relay.example.test", deviceId: "device-1", deviceToken: "test-token",
      localBaseUrl: "http://127.0.0.1:4396", fetchImpl, heartbeatIntervalMs: 10, localRequestTimeoutMs: 100, remoteRequestTimeoutMs: 200 });
    try {
      await delay(60);
      expect(polls).toBe(8);
      expect(localSignals).toBe(8);
      expect(heartbeats).toBeGreaterThan(0);
      await delay(100);
      expect(responses).toHaveLength(8);
      expect(responses.every(code => code === 504)).toBe(true);
      expect(polls).toBeGreaterThan(8);
    } finally { releases.forEach(r => r()); await client.close(); }
  });

  test("a hung poll times out and reconnects instead of waiting until restart", async () => {
    let polls = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith(heartbeatPath)) return new Response(null, { status: 404 });
      polls += 1;
      return await aborting(init);
    }) as typeof fetch;
    const client = startWeRelayRelayClient({ relayUrl: "https://relay.example.test", deviceId: "device-1", deviceToken: "test-token",
      localBaseUrl: "http://127.0.0.1:4396", fetchImpl, pollRequestTimeoutMs: 20, heartbeatIntervalMs: 10, retryDelayMs: 1 });
    try { await waitFor(() => polls > 1); expect(polls).toBeGreaterThan(1); }
    finally { await client.close(); }
  });
  test("an unconfirmed write is journaled and not executed again when the response is retried", async () => {
    let polls = 0, executions = 0, posted = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(heartbeatPath)) return new Response(null, { status: 404 });
      if (url.endsWith(WERELAY_RELAY_POLL_PATH)) {
        polls += 1;
        if (polls === 1) return Response.json(command("same-write", "POST"));
        if (polls === 2) { await delay(45); return Response.json(command("same-write", "POST")); }
        return await aborting(init);
      }
      if (url.endsWith(WERELAY_RELAY_RESPONSE_PATH)) {
        posted += 1;
        expect(JSON.parse(String(init?.body)).statusCode).toBe(504);
        if (posted === 1) throw new Error("lost response");
        return Response.json({ ok: true });
      }
      executions += 1;
      return await aborting(init);
    }) as typeof fetch;
    const client = startWeRelayRelayClient({ relayUrl: "https://relay.example.test", deviceId: "device-1", deviceToken: "test-token",
      localBaseUrl: "http://127.0.0.1:4396", fetchImpl, localRequestTimeoutMs: 20 });
    try { await waitFor(() => posted === 2); expect(executions).toBe(1); expect(posted).toBe(2); }
    finally { await client.close(); }
  });

});

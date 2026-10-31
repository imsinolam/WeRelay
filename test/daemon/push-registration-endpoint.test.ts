import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexMobileAuthStore } from "../../src/daemon/codex-mobile-auth.ts";
import { startCodexMobileServer } from "../../src/daemon/codex-mobile-server.ts";

const tempDirs: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createAuthStore(): CodexMobileAuthStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-push-server-"));
  tempDirs.push(dir);
  return new CodexMobileAuthStore({ stateFile: path.join(dir, "auth.json") });
}

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("missing set-cookie");
  return value.split(";", 1)[0] ?? "";
}

async function startServer(options: {
  registrations: Array<{ provider: string; token: string; appId?: string; deviceId?: string; origin: string }>;
  clears: string[];
  withCallbacks?: boolean;
}) {
  const authStore = createAuthStore();
  const server = await startCodexMobileServer({
    host: "127.0.0.1",
    port: 0,
    lanAddress: "192.168.50.10",
    publicBaseUrl: "http://198.51.100.10/",
    accessToken: "one-time-setup-secret",
    authStore,
    listTasks: async () => [],
    readMessages: async (threadId) => ({
      threadId,
      messages: [],
      queuedMessages: [],
      runSummary: null,
    }),
    sendMessage: async () => ({ queued: false }),
    ...(options.withCallbacks === false
      ? {}
      : {
          registerPushToken: async (input) => {
            options.registrations.push(input);
            return { ok: true as const };
          },
          clearPushTokens: async (input) => {
            options.clears.push(input.origin);
            return { cleared: 1 };
          },
        }),
  });
  servers.push(server);

  // Establish the session the way the app does.
  const root = `http://127.0.0.1:${server.port}`;
  const setup = await fetch(`${root}/api/auth/setup`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-mobile-setup": "one-time-setup-secret",
    },
    body: JSON.stringify({ password: "push test access" }),
  });
  expect(setup.status).toBe(200);
  return { root, cookie: cookieFrom(setup), publicCookie: "codex_mobile_session=" + authStore.createSessionToken() };
}

describe("push registration endpoint", () => {
  test("stores a vivo token scoped to the request origin", async () => {
    const registrations: Parameters<typeof startServer>[0]["registrations"] = [];
    const clears: string[] = [];
    const { root, cookie } = await startServer({ registrations, clears });

    const response = await fetch(`${root}/api/push/registration`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ provider: "vivo", token: "regid-abc", appId: "10004" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({ provider: "vivo", token: "regid-abc", appId: "10004" });
    expect(registrations[0]?.origin).toBe(root);
  });

  test("relay registration uses configured public origin, not the local forwarded host", async () => {
    const registrations: Parameters<typeof startServer>[0]["registrations"] = [];
    const { root, publicCookie: cookie } = await startServer({ registrations, clears: [] });
    const response = await fetch(`${root}/api/push/registration`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie,
        "x-werelay-relay": "1", "x-forwarded-proto": "https",
        "x-real-ip": "192.0.2.10", "x-forwarded-host": "untrusted.example" },
      body: JSON.stringify({ provider: "vivo", token: "synthetic-relay-install" }),
    });
    expect(response.status).toBe(200);
    expect(registrations[0]?.origin).toBe("http://198.51.100.10");
    const cleared = await fetch(`${root}/api/push/registration`, {
      method: "DELETE", headers: { cookie, "x-werelay-relay": "1",
        "x-forwarded-proto": "https", "x-real-ip": "192.0.2.10" },
    });
    expect(cleared.status).toBe(200);
  });

  test("rejects unknown vendors and empty tokens", async () => {
    const registrations: Parameters<typeof startServer>[0]["registrations"] = [];
    const clears: string[] = [];
    const { root, cookie } = await startServer({ registrations, clears });

    const vendor = await fetch(`${root}/api/push/registration`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ provider: "xiaomi", token: "x" }),
    });
    expect(vendor.status).toBe(400);

    const empty = await fetch(`${root}/api/push/registration`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ provider: "vivo", token: "   " }),
    });
    expect(empty.status).toBe(400);
    expect(registrations).toHaveLength(0);
  });

  test("requires authentication", async () => {
    const registrations: Parameters<typeof startServer>[0]["registrations"] = [];
    const clears: string[] = [];
    const { root } = await startServer({ registrations, clears });

    const response = await fetch(`${root}/api/push/registration`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "vivo", token: "regid-abc" }),
    });
    expect(response.status).toBe(401);
    expect(registrations).toHaveLength(0);
  });

  test("reports 409 when the server build has no push support", async () => {
    const { root, cookie } = await startServer({
      registrations: [],
      clears: [],
      withCallbacks: false,
    });
    const response = await fetch(`${root}/api/push/registration`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ provider: "vivo", token: "r" }),
    });
    expect(response.status).toBe(409);
  });

  test("deleting clears only this origin", async () => {
    const registrations: Parameters<typeof startServer>[0]["registrations"] = [];
    const clears: string[] = [];
    const { root, cookie } = await startServer({ registrations, clears });

    const response = await fetch(`${root}/api/push/registration`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cleared: 1 });
    expect(clears).toEqual([root]);
  });
});

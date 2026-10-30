import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexMobileAuthStore } from "../../src/daemon/codex-mobile-auth.ts";
import { startCodexMobileServer } from "../../src/daemon/codex-mobile-server.ts";
import { startWeRelayRelayClient } from "../../src/relay/relay-client.ts";
import { startWeRelayRelayServer } from "../../src/relay/relay-server.ts";

test("public relay forwards authenticated native draft reads fresh and never warm-caches private input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-relay-draft-"));
  const auth = new CodexMobileAuthStore({ stateFile: path.join(dir, "auth.json") });
  auth.setPassword("fixture-password");
  let reads = 0;
  let draft: { text: string; revision: string } | null = { text: "  unsent\n\ncomplete  ", revision: "r1" };
  const mobile = await startCodexMobileServer({ host: "127.0.0.1", port: 0, lanAddress: "127.0.0.1", accessToken: "fixture", authStore: auth,
    relayPrewarmToken: "fixture-prewarm",
    listTasks: async () => [], readMessages: async () => { throw new Error("draft must not read history"); },
    sendMessage: async () => ({ queued: false }),
    readTaskComposerDraft: async (threadId, adapter) => {
      expect(threadId).toBe("exact"); expect(adapter).toBe("pi"); reads++;
      return { supported: true, draft };
    },
  });
  const relay = await startWeRelayRelayServer({ host: "127.0.0.1", port: 0, deviceId: "fixture-draft", deviceToken: "fixture-device-token",
    pollTimeoutMs: 20, warmCacheFreshMs: 60_000,
  });
  const client = startWeRelayRelayClient({ transport: "long-poll", relayUrl: relay.baseUrl, deviceId: "fixture-draft", deviceToken: "fixture-device-token",
    localBaseUrl: `http://127.0.0.1:${mobile.port}`, localPrewarmToken: "fixture-prewarm", retryDelayMs: 5,
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!(await fetch(`${relay.baseUrl}/health`).then(r => r.json()) as { deviceOnline?: boolean }).deviceOnline) {
      if (Date.now() > deadline) throw new Error("fixture relay not online");
      await Bun.sleep(10);
    }
    const endpoint = `${relay.baseUrl}/api/tasks/exact/composer-draft?adapter=pi`;
    expect((await fetch(endpoint)).status).toBe(401);
    expect(reads).toBe(0);
    const headers = { cookie: `codex_mobile_session=${auth.createSessionToken()}` };
    const first = await fetch(endpoint, { headers });
    expect(first.headers.get("cache-control")).toContain("no-store");
    expect(first.headers.get("x-werelay-cache")).toBeNull();
    expect(await first.json()).toMatchObject({ draft });
    draft = null;
    const second = await fetch(endpoint, { headers });
    expect(await second.json()).toMatchObject({ draft: null });
    expect(reads).toBe(2);
  } finally {
    await client.close(); await relay.close(); await mobile.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

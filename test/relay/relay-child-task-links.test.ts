import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexMobileAuthStore } from "../../src/daemon/codex-mobile-auth.ts";
import { startCodexMobileServer } from "../../src/daemon/codex-mobile-server.ts";
import { startWeRelayRelayServer } from "../../src/relay/relay-server.ts";
import { startWeRelayRelayClient } from "../../src/relay/relay-client.ts";

test("application relay keeps child links authenticated, parent-scoped and outside the normal list cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-relay-children-"));
  const closers: Array<() => Promise<void>> = [];
  try {
    const authStore = new CodexMobileAuthStore({ stateFile: path.join(dir, "auth.json") });
    authStore.setPassword("child-relay-fixture");
    let childReads = 0;
    const reads: unknown[] = [];
    const mobile = await startCodexMobileServer({ host: "127.0.0.1", port: 0, lanAddress: "127.0.0.1", accessToken: "fixture", authStore,
      listTasks: async () => { throw new Error("child inspection must not enumerate the normal list"); },
      listChildTasks: async (parentThreadId, adapter) => {
        expect(parentThreadId).toBe("main"); expect(adapter).toBe("codex"); childReads++;
        return [{ threadId: "hidden-child", parentThreadId, title: "子任务", status: "unknown" }];
      },
      readMessages: async (threadId, options, adapter) => {
        reads.push({ threadId, options, adapter });
        return { threadId, messages: [{ role: "assistant", text: "原子任务内容" }], queuedMessages: [] };
      },
      sendMessage: async () => { throw new Error("child preview must not send"); },
    });
    closers.push(() => mobile.close());
    const relay = await startWeRelayRelayServer({ host: "127.0.0.1", port: 0, deviceId: "child-device", deviceToken: "fixture-device-token", pollTimeoutMs: 10 });
    closers.push(() => relay.close());
    const client = startWeRelayRelayClient({ transport: "long-poll", relayUrl: relay.baseUrl, deviceId: "child-device",
      deviceToken: "fixture-device-token", localBaseUrl: `http://127.0.0.1:${mobile.port}`, retryDelayMs: 5 });
    closers.push(() => client.close());
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if ((await (await fetch(`${relay.baseUrl}/health`)).json()).deviceOnline) break;
      await Bun.sleep(10);
    }
    const childrenUrl = `${relay.baseUrl}/api/tasks/main/children?adapter=codex`;
    expect((await fetch(childrenUrl)).status).toBe(401);
    expect(childReads).toBe(0);
    const headers = { cookie: `codex_mobile_session=${authStore.createSessionToken()}` };
    for (let i = 0; i < 2; i++) {
      const response = await fetch(childrenUrl, { headers });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-werelay-cache")).toBeNull();
      expect(await response.json()).toMatchObject({ parentThreadId: "main", tasks: [{ threadId: "hidden-child" }] });
    }
    expect(childReads).toBe(2);
    const preview = await fetch(`${relay.baseUrl}/api/tasks/hidden-child/messages?adapter=codex&limit=30&history=1`, { headers });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ messages: [{ text: "原子任务内容" }] });
    expect(reads).toEqual([{ threadId: "hidden-child", adapter: "codex", options: { limit: 30, historyOnly: true, lightweight: true } }]);
  } finally {
    for (const close of closers.reverse()) await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

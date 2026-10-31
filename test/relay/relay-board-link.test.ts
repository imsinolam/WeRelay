import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexMobileAuthStore } from "../../src/daemon/codex-mobile-auth.ts";
import { expect, test } from "bun:test";
import { startCodexMobileServer } from "../../src/daemon/codex-mobile-server.ts";
import { CODEX_MOBILE_ASSET_VERSION } from "../../src/daemon/codex-mobile-server.ts";
import { startWeRelayRelayServer } from "../../src/relay/relay-server.ts";

test("LAN and public board short entries preserve authentication, drop task selection, and work offline", async () => {
  const local = await startCodexMobileServer({
    host: "127.0.0.1", port: 0, lanAddress: "127.0.0.1", accessToken: "board-fixture",
    publicBaseUrl: "https://relay.example",
    listTasks: async () => [],
    readMessages: async (threadId) => ({ threadId, messages: [], queuedMessages: [] }),
    sendMessage: async () => ({ accepted: true }),
  });
  const relay = await startWeRelayRelayServer({
    host: "127.0.0.1", port: 0, deviceId: "fixture", deviceToken: "fixture-secret",
  });
  try {
    expect(local.buildBoardUrl()).toBe("https://relay.example/b?key=board-fixture");
    local.updateRemoteAccess(undefined);
    expect(local.buildBoardUrl()).toBe(`http://127.0.0.1:${local.port}/b?key=board-fixture`);
    for (const root of [`http://127.0.0.1:${local.port}`, relay.baseUrl]) {
      for (const auth of ["", "key=board-fixture", "setup=board-fixture"]) {
        const response = await fetch(`${root}/b?${auth}&task=old-task&adapter=pi&view=chat&evil=ignored`, {
          redirect: "manual",
        });
        expect(response.status).toBe(302);
        const url = new URL(response.headers.get("location")!, root);
        expect(url.pathname).toBe("/");
        expect(url.searchParams.get("view")).toBe("board");
        expect(url.searchParams.get("appv")).toBe(CODEX_MOBILE_ASSET_VERSION);
        expect(url.searchParams.has("task")).toBe(false);
        expect(url.searchParams.has("adapter")).toBe(false);
        expect(url.searchParams.has("evil")).toBe(false);
        if (auth) {
          const [key, value] = auth.split("=");
          expect(url.searchParams.get(key!)).toBe(value!);
        }
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      }
    }
  } finally {
    await local.close();
    await relay.close();
  }
});

test("password-protected board entries preserve setup flow and still require login", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-board-entry-"));
  const authStore = new CodexMobileAuthStore({ stateFile: path.join(directory, "auth.json") });
  const local = await startCodexMobileServer({
    host: "127.0.0.1", port: 0, lanAddress: "127.0.0.1", accessToken: "board-setup",
    authStore, listTasks: async () => [],
    readMessages: async (threadId) => ({ threadId, messages: [], queuedMessages: [] }),
    sendMessage: async () => ({ accepted: true }),
  });
  try {
    const root = `http://127.0.0.1:${local.port}`;
    expect(local.buildBoardUrl()).toBe(`${root}/b?setup=board-setup`);
    authStore.setPassword("fixture-password");
    expect(local.buildBoardUrl()).toBe(`${root}/b`);
    const redirect = await fetch(local.buildBoardUrl(), { redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(new URL(redirect.headers.get("location")!, root).searchParams.get("view")).toBe("board");
    expect((await fetch(`${root}/api/task-board`)).status).toBe(401);
  } finally {
    await local.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

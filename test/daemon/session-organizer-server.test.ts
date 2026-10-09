import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexMobileAuthStore } from "../../src/daemon/codex-mobile-auth.ts";
import {
  SESSION_ORGANIZER_CSS,
  SESSION_ORGANIZER_HTML,
  SESSION_ORGANIZER_JS,
} from "../../src/daemon/session-organizer-web.ts";
import { buildSessionOrganizerSnapshot } from "../../src/daemon/session-organizer.ts";
import { startCodexMobileServer } from "../../src/daemon/codex-mobile-server.ts";
import { CODEX_MOBILE_HTML } from "../../src/daemon/codex-mobile-web.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function createAuthStore(): CodexMobileAuthStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-organizer-server-"));
  tempDirs.push(dir);
  const store = new CodexMobileAuthStore({ stateFile: path.join(dir, "auth.json") });
  store.setPassword("organizer-password");
  return store;
}

describe("session organizer server", () => {
  test("serves the organizer shell and authenticated snapshot API", async () => {
    const authStore = createAuthStore();
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const snapshot = buildSessionOrganizerSnapshot([{
      adapter: "codex",
      adapterLabel: "Codex",
      threadId: "thread-organizer",
      title: "new",
      projectName: "WeRelay",
      cwd: "/tmp/WeRelay",
      status: "idle",
      lastUpdatedAt: "2026-09-18T10:00:00.000Z",
    }], { nowMs: Date.parse("2026-09-18T12:00:00.000Z") });
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "organizer-secret",
      authStore,
      listSessionOrganizer: async () => snapshot,
      listTasks: async () => [],
      readMessages: async (threadId) => ({ threadId, messages: [], queuedMessages: [] }),
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const shell = await fetch(`${root}/organizer`);
      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain("先把会话整理清楚");
      expect(await (await fetch(`${root}/organizer.css`)).text()).toContain(".project-list");
      expect(await (await fetch(`${root}/organizer.js`)).text()).toContain("/api/session-organizer");

      const unauthorized = await fetch(`${root}/api/session-organizer`);
      expect(unauthorized.status).toBe(401);

      const response = await fetch(`${root}/api/session-organizer`, {
        headers: { cookie: sessionCookie },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(snapshot);
    } finally {
      await server.close();
    }
  });

  test("keeps the organizer asset JavaScript syntactically valid", () => {
    expect(() => new Function(SESSION_ORGANIZER_JS)).not.toThrow();
    expect(SESSION_ORGANIZER_HTML).toContain("/organizer.css");
    expect(SESSION_ORGANIZER_HTML).toContain("/organizer.js");
    expect(SESSION_ORGANIZER_CSS).toContain(".session");
    expect(CODEX_MOBILE_HTML).toContain('href="/organizer"');
    // Same thread IDs in two adapters must use the clicked row's input.
    expect(SESSION_ORGANIZER_JS).toContain('button.closest(".session").querySelector("[data-input]")');
    expect(SESSION_ORGANIZER_JS).not.toContain("document.querySelector('[data-input=");
  });
});

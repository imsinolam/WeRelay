import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  createWeRelayRelayTaskLinkAlias,
  WeRelayRelayTaskLinkClient,
  WeRelayRelayTaskLinkStore,
} from "../../src/relay/relay-task-links.ts";
import {
  decodeCodexMobileTaskShortCode,
} from "../../src/daemon/codex-mobile-server.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("relay task links", () => {
  test("creates stable ten-character aliases without cross-adapter collisions", () => {
    const threadId = "0000000a-0000-7000-8000-00000000000a";
    const codex = createWeRelayRelayTaskLinkAlias("device-secret", "codex", threadId);
    const workbuddy = createWeRelayRelayTaskLinkAlias(
      "device-secret",
      "workbuddy",
      threadId,
    );

    expect(codex).toHaveLength(10);
    expect(codex).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(workbuddy).not.toBe(codex);
    expect(createWeRelayRelayTaskLinkAlias("device-secret", "codex", threadId)).toBe(codex);
  });

  test("persists aliases across relay restarts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-task-links-"));
    temporaryDirectories.push(directory);
    const stateFile = path.join(directory, "task-links.json");
    const target = {
      adapter: "codex",
      threadId: "0000000a-0000-7000-8000-00000000000a",
    };
    const alias = createWeRelayRelayTaskLinkAlias(
      "device-secret",
      target.adapter,
      target.threadId,
    );

    const first = new WeRelayRelayTaskLinkStore({
      deviceToken: "device-secret",
      stateFile,
    });
    first.register(alias, target);

    const restored = new WeRelayRelayTaskLinkStore({
      deviceToken: "device-secret",
      stateFile,
    });
    expect(restored.resolve(alias)).toEqual(target);
    if (process.platform !== "win32") {
      expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
    }
  });

  test("uses a self-contained task URL until the Relay confirms the shorter alias", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let finishRegistration: ((response: Response) => void) | undefined;
    const client = new WeRelayRelayTaskLinkClient({
      relayUrl: "https://werelay.example",
      deviceId: "device-1",
      deviceToken: "device-secret",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return await new Promise<Response>((resolve) => {
          finishRegistration = resolve;
        });
      },
    });
    try {
      const firstUrl = new URL(client.buildTaskUrl(
        "0000000a-0000-7000-8000-00000000000a",
        "codex",
        new URLSearchParams(),
      ));
      expect(firstUrl.pathname).toMatch(/^\/t\/[A-Za-z0-9_.~-]+$/);
      expect(decodeCodexMobileTaskShortCode(firstUrl.pathname.slice(3))).toEqual({
        adapter: "codex",
        threadId: "0000000a-0000-7000-8000-00000000000a",
      });
      await Bun.sleep(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.init?.headers).toMatchObject({
        authorization: "Bearer device-secret",
        "x-werelay-device-id": "device-1",
      });
      finishRegistration?.(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await Bun.sleep(0);
      const confirmedUrl = client.buildTaskUrl(
        "0000000a-0000-7000-8000-00000000000a",
        "codex",
        new URLSearchParams(),
      );
      expect(confirmedUrl).toMatch(/^https:\/\/werelay\.example\/[A-Za-z0-9_-]{10}$/);
      expect(confirmedUrl.length).toBeLessThan(45);
    } finally {
      await client.close();
    }
  });

  test("never emits an unregistered alias while Relay registration is failing", async () => {
    const client = new WeRelayRelayTaskLinkClient({
      relayUrl: "https://werelay.example",
      deviceId: "device-1",
      deviceToken: "device-secret",
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    });
    try {
      const url = new URL(client.buildTaskUrl(
        "0000000a-0000-7000-8000-00000000000a",
        "codex",
        new URLSearchParams("setup=token"),
      ));
      expect(url.pathname).toMatch(/^\/t\//);
      expect(url.searchParams.get("setup")).toBe("token");
    } finally {
      await client.close();
    }
  });

  test("waits for Relay confirmation before returning a real short link", async () => {
    let finishRegistration: ((response: Response) => void) | undefined;
    const client = new WeRelayRelayTaskLinkClient({
      relayUrl: "https://werelay.example",
      deviceId: "device-1",
      deviceToken: "device-secret",
      fetchImpl: async () => await new Promise<Response>((resolve) => {
        finishRegistration = resolve;
      }),
    });
    try {
      const pendingUrl = client.buildConfirmedTaskUrl(
        "0000000a-0000-7000-8000-00000000000a",
        "codex",
        new URLSearchParams(),
      );
      await Bun.sleep(0);
      let settled = false;
      void pendingUrl.finally(() => { settled = true; });
      await Bun.sleep(0);
      expect(settled).toBe(false);

      finishRegistration?.(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      expect(await pendingUrl).toMatch(
        /^https:\/\/werelay\.example\/[A-Za-z0-9_-]{10}$/,
      );
    } finally {
      await client.close();
    }
  });

  test("replaces internal reversible links only after the real short link is confirmed", async () => {
    let finishRegistration: ((response: Response) => void) | undefined;
    const client = new WeRelayRelayTaskLinkClient({
      relayUrl: "https://werelay.example",
      deviceId: "device-1",
      deviceToken: "device-secret",
      fetchImpl: async () => await new Promise<Response>((resolve) => {
        finishRegistration = resolve;
      }),
    });
    try {
      const reversibleUrl = client.buildTaskUrl(
        "0000000a-0000-7000-8000-00000000000a",
        "codex",
        new URLSearchParams("setup=one-time"),
      );
      expect(reversibleUrl).toContain("/t/");

      const pending = client.confirmTaskLinksInText(
        `任务已完成\n\n${reversibleUrl}`,
      );
      await Bun.sleep(0);
      finishRegistration?.(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

      const result = await pending;
      expect(result.unresolvedCount).toBe(0);
      expect(result.text).toMatch(
        /^任务已完成\n\nhttps:\/\/werelay\.example\/[A-Za-z0-9_-]{10}\?setup=one-time$/,
      );
      expect(result.text).not.toContain("/t/");
    } finally {
      await client.close();
    }
  });

  test("removes an unconfirmed internal link instead of leaking a long or dead URL", async () => {
    const client = new WeRelayRelayTaskLinkClient({
      relayUrl: "https://werelay.example",
      deviceId: "device-1",
      deviceToken: "device-secret",
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    });
    try {
      const reversibleUrl = client.buildTaskUrl(
        "0000000a-0000-7000-8000-00000000000a",
        "codex",
        new URLSearchParams(),
      );
      const result = await client.confirmTaskLinksInText(
        `任务已完成\n\n${reversibleUrl}`,
        { timeoutMs: 10 },
      );
      expect(result.unresolvedCount).toBe(1);
      expect(result.text).toBe(
        "任务已完成\n\n任务短链接暂时无法生成，可发送“任务”从列表进入。",
      );
      expect(result.text).not.toContain("/t/");
    } finally {
      await client.close();
    }
  });

  test("does not return a dead short link when confirmation times out", async () => {
    const client = new WeRelayRelayTaskLinkClient({
      relayUrl: "https://werelay.example",
      deviceId: "device-1",
      deviceToken: "device-secret",
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    });
    try {
      await expect(client.buildConfirmedTaskUrl(
        "0000000a-0000-7000-8000-00000000000a",
        "codex",
        new URLSearchParams(),
        { timeoutMs: 10 },
      )).rejects.toThrow("短链接暂时无法生成");
    } finally {
      await client.close();
    }
  });
});

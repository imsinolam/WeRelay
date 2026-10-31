import fs from "node:fs";
import crypto from "node:crypto";
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
  test("a stuck registration is bounded and retries successfully within the same confirmation request", async () => {
    let calls = 0;
    let firstSignal: AbortSignal | undefined;
    const client = new WeRelayRelayTaskLinkClient({
      relayUrl: "https://werelay.example", deviceId: "device", deviceToken: "device-secret",
      requestTimeoutMs: 20,
      fetchImpl: async (_url, init) => {
        calls++;
        if (calls === 1) {
          firstSignal = init?.signal ?? undefined;
          // Simulate a transport which ignores abort; no pending entry may hang forever.
          return await new Promise<Response>(() => {});
        }
        return Response.json({ ok: true });
      },
    });
    try {
      const url = await client.buildConfirmedTaskUrl("task", "pi", new URLSearchParams(), { timeoutMs: 2_000 });
      expect(url).toMatch(/^https:\/\/werelay\.example\/[A-Z0-9]{10}$/);
      expect(firstSignal?.aborted).toBe(true);
      expect(calls).toBe(2);
    } finally { await client.close(); }
  });

  test("a real user confirmation bypasses background retry backoff without duplicating an active attempt", async () => {
    let calls = 0;
    let recovered = false;
    const client = new WeRelayRelayTaskLinkClient({
      relayUrl: "https://werelay.example", deviceId: "device", deviceToken: "device-secret",
      fetchImpl: async () => {
        calls++;
        return recovered ? Response.json({ ok: true }) : new Response("unavailable", { status: 503 });
      },
    });
    try {
      client.buildTaskUrl("same", "deepseek", new URLSearchParams());
      await Bun.sleep(0);
      expect(calls).toBe(1);
      recovered = true;
      const urls = await Promise.all(Array.from({ length: 5 }, () => client.buildConfirmedTaskUrl(
        "same", "deepseek", new URLSearchParams(), { timeoutMs: 100 },
      )));
      expect(new Set(urls).size).toBe(1);
      expect(calls).toBe(2);
    } finally { await client.close(); }
  });

  test("HTTP success without a Relay acknowledgement never confirms a dead short link", async () => {
    const client = new WeRelayRelayTaskLinkClient({
      relayUrl: "https://werelay.example", deviceId: "device", deviceToken: "device-secret",
      fetchImpl: async () => new Response("<html>proxy login</html>", { status: 200 }),
    });
    try {
      await expect(client.buildConfirmedTaskUrl("task", "pi", new URLSearchParams(), { timeoutMs: 25 }))
        .rejects.toThrow("短链接暂时无法生成");
    } finally { await client.close(); }
  });

  test("bounded acknowledgement reads and failure diagnostics contain no credentials or task text", async () => {
    const failures: unknown[] = [];
    let signal: AbortSignal | undefined;
    const client = new WeRelayRelayTaskLinkClient({
      relayUrl: "https://werelay.example", deviceId: "private-device", deviceToken: "private-token",
      requestTimeoutMs: 10, onRegistrationFailure: (failure) => failures.push(failure),
      fetchImpl: async (_url, init) => {
        signal = init?.signal ?? undefined;
        const response = Response.json({ ok: true });
        response.json = async () => await new Promise(() => {});
        return response;
      },
    });
    try {
      await expect(client.buildConfirmedTaskUrl("private-task", "pi", new URLSearchParams("setup=private-setup"), { timeoutMs: 60 }))
        .rejects.toThrow("短链接暂时无法生成");
      expect(signal?.aborted).toBe(true);
      expect(failures).toEqual([{ reason: "timeout" }]);
      expect(JSON.stringify(failures)).not.toContain("private");
    } finally { await client.close(); }
  });

  test("closing the client aborts registration and settles waiters without a late retry or confirmation", async () => {
    let signal: AbortSignal | undefined;
    let resolve!: (response: Response) => void;
    const client = new WeRelayRelayTaskLinkClient({
      relayUrl: "https://werelay.example", deviceId: "device", deviceToken: "device-secret",
      fetchImpl: async (_url, init) => {
        signal = init?.signal ?? undefined;
        return await new Promise<Response>((done) => { resolve = done; });
      },
    });
    const pending = client.buildConfirmedTaskUrl("task", "pi", new URLSearchParams(), { timeoutMs: 500 });
    const outcome = pending.then(() => "unexpected success", () => "closed");
    await Bun.sleep(0);
    await client.close();
    expect(signal?.aborted).toBe(true);
    expect(await Promise.race([outcome, Bun.sleep(100).then(() => "still waiting")])).toBe("closed");
    resolve(Response.json({ ok: true }));
    await Bun.sleep(0);
    expect(() => client.buildTaskUrl("task", "pi", new URLSearchParams())).toThrow("短链接暂时无法生成");
    await expect(client.buildConfirmedTaskUrl("task", "pi", new URLSearchParams())).rejects.toThrow("短链接暂时无法生成");
  });

  test("reports safe HTTP/network/protocol categories without logging server error bodies", async () => {
    for (const reason of ["http", "network", "protocol"] as const) {
      const failures: unknown[] = [];
      const client = new WeRelayRelayTaskLinkClient({
        relayUrl: "https://werelay.example", deviceId: "private-device", deviceToken: "private-token",
        onRegistrationFailure: failure => failures.push(failure),
        fetchImpl: async () => {
          if (reason === "network") throw new Error("private connection details");
          return reason === "http" ? new Response("private server error", { status: 401 })
            : Response.json({ ok: false, secret: "private" });
        },
      });
      try {
        await expect(client.buildConfirmedTaskUrl("private-task", "pi", new URLSearchParams(), { timeoutMs: 30 }))
          .rejects.toThrow("短链接暂时无法生成");
        expect(failures).toEqual([reason === "http" ? { reason, status: 401 } : { reason }]);
        expect(JSON.stringify(failures)).not.toContain("private");
      } finally { await client.close(); }
    }
  });

  test("a late response from a timed-out attempt cannot confirm or overwrite the retry", async () => {
    let finishFirst!: (response: Response) => void;
    let finishRetry!: (response: Response) => void;
    let calls = 0;
    const client = new WeRelayRelayTaskLinkClient({
      relayUrl: "https://werelay.example", deviceId: "device", deviceToken: "device-secret",
      requestTimeoutMs: 20,
      fetchImpl: async () => {
        calls++;
        return await new Promise<Response>((resolve) => {
          if (calls === 1) finishFirst = resolve; else finishRetry = resolve;
        });
      },
    });
    try {
      client.buildTaskUrl("task", "pi", new URLSearchParams());
      await Bun.sleep(35);
      const pending = client.buildConfirmedTaskUrl("task", "pi", new URLSearchParams(), { timeoutMs: 200 });
      finishFirst(Response.json({ ok: true }));
      await Bun.sleep(0);
      expect(client.buildTaskUrl("task", "pi", new URLSearchParams())).toContain("/t/");
      finishRetry(Response.json({ ok: true }));
      expect(await pending).not.toContain("/t/");
      expect(calls).toBe(2);
    } finally { await client.close(); }
  });

  test("creates stable ten-character aliases without cross-adapter collisions", () => {
    const threadId = "0000000a-0000-7000-8000-00000000000a";
    const codex = createWeRelayRelayTaskLinkAlias("device-secret", "codex", threadId);
    const workbuddy = createWeRelayRelayTaskLinkAlias(
      "device-secret",
      "workbuddy",
      threadId,
    );

    expect(codex).toHaveLength(10);
    // 别名必须是纯字母数字：微信不把以 - 或 _ 结尾的裸链接整体识别为链接，
    // 实测 https://host/Eg5CwU5rU_ 末尾下划线被排除，点击后无法访问。
    expect(codex).toMatch(/^[A-Za-z0-9]+$/);
    expect(workbuddy).not.toBe(codex);
    expect(createWeRelayRelayTaskLinkAlias("device-secret", "codex", threadId)).toBe(codex);
  });

  test("never produces a link alias that WeChat would truncate", () => {
    // 覆盖大量输入，确保别名不含也不会以 - 或 _ 结尾。
    for (let index = 0; index < 5_000; index += 1) {
      const alias = createWeRelayRelayTaskLinkAlias(
        "device-secret",
        index % 2 === 0 ? "codex" : "grok",
        `thread-${index}`,
      );
      expect(alias).toHaveLength(10);
      expect(alias).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  test("accepts a legacy base64url alias so old links keep working", () => {
    // 改算法前发出的别名可能含 - 或 _，重启后必须仍能从持久化记录解析，
    // 否则用户微信里已收到的历史链接会失效。
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-task-links-legacy-"));
    temporaryDirectories.push(directory);
    const stateFile = path.join(directory, "task-links.json");
    const deviceToken = "device-secret";
    const target = {
      adapter: "codex",
      threadId: "0000000a-0000-7000-8000-00000000000b",
    };
    // 复现旧算法（base64url）生成的别名，并以旧格式写入持久化文件。
    const legacyAlias = crypto.createHash("sha256")
      .update("placeholder")
      .digest("base64url");
    const oldAlias = crypto.createHmac("sha256", deviceToken)
      .update(target.adapter)
      .update("\0")
      .update(target.threadId)
      .digest("base64url")
      .slice(0, 10);
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      entries: [{ alias: oldAlias, adapter: target.adapter, threadId: target.threadId, updatedAt: new Date().toISOString() }],
    }));
    expect(legacyAlias).toBeTruthy();

    const store = new WeRelayRelayTaskLinkStore({ deviceToken, stateFile });
    expect(store.resolve(oldAlias)).toEqual(target);
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

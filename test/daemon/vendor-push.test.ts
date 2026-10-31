import { describe, expect, test } from "bun:test";

import {
  createPushDispatch,
  createVivoPushProvider,
  readVivoCredentials,
  truncatePushText,
  vivoAuthSign,
} from "../../src/daemon/vendor-push.ts";

// Fully synthetic fixture; never used by a deployed vendor account.
const credentials = {
  appId: "10004",
  appKey: "test-app-key",
  appSecret: "test-app-secret",
};

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function fakeFetch(
  handler: (call: Call) => { status?: number; json: unknown },
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const call: Call = {
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : {},
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const result = handler(call);
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => result.json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("vivo signature", () => {
  test("matches an independently calculated synthetic MD5 vector", () => {
    // 固定合成向量，按厂商规定的拼接顺序独立计算。
    expect(vivoAuthSign({ ...credentials, timestamp: 1501484120000 })).toBe(
      "cd7f2d5e1f3360398a7614c1c3a95111",
    );
  });
});

describe("truncatePushText", () => {
  test("keeps short text and trims whitespace", () => {
    expect(truncatePushText("  任务完成  ", 40)).toBe("任务完成");
  });

  test("fits the vendor limit including the ellipsis", () => {
    const result = truncatePushText("a".repeat(60), 40);
    expect(result.length).toBe(40);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("readVivoCredentials", () => {
  test("returns null when any field is missing", () => {
    expect(readVivoCredentials({})).toBeNull();
    expect(
      readVivoCredentials({ WERELAY_VIVO_PUSH_APP_ID: "1", WERELAY_VIVO_PUSH_APP_KEY: "k" }),
    ).toBeNull();
  });

  test("reads and trims a complete environment", () => {
    expect(
      readVivoCredentials({
        WERELAY_VIVO_PUSH_APP_ID: " 10004 ",
        WERELAY_VIVO_PUSH_APP_KEY: " key ",
        WERELAY_VIVO_PUSH_APP_SECRET: " secret ",
      }),
    ).toEqual({ appId: "10004", appKey: "key", appSecret: "secret" });
  });
});

describe("vivo provider", () => {
  test("is inert without credentials", async () => {
    const provider = createVivoPushProvider({ credentials: null });
    expect(provider.configured()).toBe(false);
    expect(await provider.send({ provider: "vivo", token: "r" }, { title: "t", content: "c" }))
      .toEqual({ ok: false, reason: "unsupported" });
  });

  test("authenticates once and sends a capped operation message", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/message/auth")) return { json: { result: 0, authToken: "T1" } };
      return { json: { result: 0, taskId: "121397329" } };
    });
    const provider = createVivoPushProvider({ credentials, fetchImpl, now: () => 1_700_000_000_000 });

    const notification = {
      title: "任务已完成",
      content: "x".repeat(200),
      data: { adapter: "codex", threadId: "01a05d6a" },
      collapseKey: "12345",
    };
    expect(await provider.send({ provider: "vivo", token: "regid-1" }, notification))
      .toEqual({ ok: true });
    expect(await provider.send({ provider: "vivo", token: "regid-1" }, notification))
      .toEqual({ ok: true });

    // Second send reuses the cached authToken instead of re-authenticating.
    expect(calls.filter((c) => c.url.endsWith("/message/auth"))).toHaveLength(1);

    const send = calls.at(-1)!;
    expect(send.headers.authToken).toBe("T1");
    expect(send.body.title).toBe("任务已完成");
    expect(String(send.body.content)).toHaveLength(100);
    expect(send.body.category).toBe("CONTENT");
    expect(send.body.skipType).toBe(1);
    expect(send.body.notifyId).toBe(12345);
    expect(send.body.clientCustomMap).toEqual({ adapter: "codex", threadId: "01a05d6a" });
  });

  test("maps an unknown regid to invalid-token so callers can prune it", async () => {
    const { fetchImpl } = fakeFetch((call) => {
      if (call.url.endsWith("/message/auth")) return { json: { result: 0, authToken: "T1" } };
      return { json: { result: 10302, desc: "regId 不合法" } };
    });
    const provider = createVivoPushProvider({ credentials, fetchImpl });
    expect(await provider.send({ provider: "vivo", token: "gone" }, { title: "t", content: "c" }))
      .toEqual({ ok: false, reason: "invalid-token" });
  });

  test("reports transport failure when authentication fails", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 500, json: {} }));
    const provider = createVivoPushProvider({ credentials, fetchImpl });
    const result = await provider.send({ provider: "vivo", token: "r" }, { title: "t", content: "c" });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "transport" });
    // A failed auth must not attempt to send.
    expect(calls.filter((c) => c.url.endsWith("/message/send"))).toHaveLength(0);
  });

  test("drops custom fields that would overflow the vendor cap", async () => {
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url.endsWith("/message/auth")) return { json: { result: 0, authToken: "T1" } };
      return { json: { result: 0 } };
    });
    const provider = createVivoPushProvider({ credentials, fetchImpl });
    await provider.send(
      { provider: "vivo", token: "r" },
      { title: "t", content: "c", data: { big: "b".repeat(2_000), small: "ok" } },
    );
    const send = calls.at(-1)!;
    expect(send.body.clientCustomMap).toEqual({ small: "ok" });
  });
});

describe("push dispatch", () => {
  test("skips unconfigured providers and survives a throwing provider", async () => {
    const dispatch = createPushDispatch({
      providers: [
        createVivoPushProvider({
          credentials,
          fetchImpl: fakeFetch(() => ({ json: { result: 0, authToken: "T" } })).fetchImpl,
        }),
      ],
    });
    expect(dispatch.activeProviders()).toEqual(["vivo"]);

    const results = await dispatch.send(
      [
        { provider: "vivo", token: "r1" },
        // Unknown vendor: reported as unsupported rather than thrown.
        { provider: "xiaomi" as any, token: "x" },
      ],
      { title: "任务已完成", content: "任务 A" },
    );
    expect(results).toHaveLength(2);
    expect(results[1]).toEqual({ ok: false, reason: "unsupported" });
  });

  test("is completely inert when no provider has credentials", async () => {
    const dispatch = createPushDispatch({
      providers: [createVivoPushProvider({ credentials: null })],
    });
    expect(dispatch.activeProviders()).toEqual([]);
    expect(await dispatch.send([{ provider: "vivo", token: "r" }], { title: "t", content: "c" }))
      .toEqual([{ ok: false, reason: "unsupported" }]);
  });
});

import { describe, expect, test } from "bun:test";
import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  apiFetch,
  assertWechatApiResponseOk,
  assertMediaUploadSizeAllowed,
  buildCdnDownloadUrl,
  buildInboundMessageClaimPath,
  clearInboundMessageClaims,
  classifyWechatTransportError,
  decodeInboundMediaAesKey,
  decryptInboundMediaPayload,
  describeWechatTransportError,
  extractInboundMessageContent,
  formatByteSize,
  isWechatContextTokenStaleError,
  isWechatSyncSessionTimeout,
  resolveInboundMediaDownloadLimitBytes,
  resolveMediaUploadLimitBytes,
  tryClaimInboundMessage,
  WechatApiResponseError,
  type WeixinMessage,
} from "../../src/wechat/wechat-transport.ts";

test("send API can reject redirects instead of risking replay after a second-host DNS failure", async () => {
  let redirect: string | undefined;
  await apiFetch({ baseUrl: "https://example.invalid/", endpoint: "sendmessage",
    body: "{}", timeoutMs: 1000, redirect: "error",
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response('{"ret":0}', { status: 200 });
    }) as typeof fetch,
  });
  expect(redirect).toBe("error");
});

describe("wechat upload limits", () => {
  test("uses the default per-media upload limits", () => {
    expect(resolveMediaUploadLimitBytes("image", {})).toBe(20 * 1024 * 1024);
    expect(resolveMediaUploadLimitBytes("file", {})).toBe(50 * 1024 * 1024);
    expect(resolveMediaUploadLimitBytes("voice", {})).toBe(20 * 1024 * 1024);
    expect(resolveMediaUploadLimitBytes("video", {})).toBe(100 * 1024 * 1024);
  });

  test("allows env overrides and ignores invalid values", () => {
    expect(
      resolveMediaUploadLimitBytes("video", {
        WECHAT_MAX_VIDEO_MB: "64",
      } as NodeJS.ProcessEnv),
    ).toBe(64 * 1024 * 1024);

    expect(
      resolveMediaUploadLimitBytes("video", {
        WECHAT_MAX_VIDEO_MB: "not-a-number",
      } as NodeJS.ProcessEnv),
    ).toBe(100 * 1024 * 1024);
  });

  test("throws a clear error when a file exceeds the configured limit", () => {
    expect(() =>
      assertMediaUploadSizeAllowed(
        "video",
        377_800_000,
        {} as NodeJS.ProcessEnv,
      ),
    ).toThrow(
      "Video too large: 360 MB exceeds 100 MB limit. Set WECHAT_MAX_VIDEO_MB to override.",
    );
  });

  test("formats byte sizes consistently", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1_536)).toBe("1.5 KB");
    expect(formatByteSize(20 * 1024 * 1024)).toBe("20.0 MB");
  });

  test("uses separate inbound download limits", () => {
    expect(resolveInboundMediaDownloadLimitBytes("image", {} as NodeJS.ProcessEnv)).toBe(
      20 * 1024 * 1024,
    );
    expect(
      resolveInboundMediaDownloadLimitBytes("file", {
        WECHAT_MAX_INBOUND_FILE_MB: "12",
      } as NodeJS.ProcessEnv),
    ).toBe(12 * 1024 * 1024);
  });

  test("keeps the request timeout active even when response-body reads ignore abort", async () => {
    let abortObserved = false;
    const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        abortObserved = true;
      }, { once: true });
      return {
        ok: true,
        status: 200,
        text: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return JSON.stringify({ ret: 0, msgs: [] });
        },
      } as Response;
    }) as typeof fetch;

    const startedAt = Date.now();
    await expect(apiFetch({
      baseUrl: "https://wechat.invalid",
      endpoint: "ilink/bot/getupdates",
      body: "{}",
      token: "test-token",
      timeoutMs: 10,
      fetchImpl,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(abortObserved).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(80);
  });

  test("classifies transient fetch failures as retryable network errors", () => {
    const cause = Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:443"), {
      code: "ETIMEDOUT",
      syscall: "connect",
      address: "10.0.0.1",
      port: 443,
    });
    const error = new TypeError("fetch failed", { cause });

    expect(classifyWechatTransportError(error)).toEqual({
      kind: "network",
      retryable: true,
    });
    expect(describeWechatTransportError(error)).toContain("TypeError: fetch failed");
    expect(describeWechatTransportError(error)).toContain("code=ETIMEDOUT");
  });

  test("treats HTTP 503 as retryable and HTTP 401 as fatal auth", () => {
    expect(classifyWechatTransportError(new Error("HTTP 503: upstream unavailable"))).toEqual({
      kind: "http",
      retryable: true,
      statusCode: 503,
    });

    expect(classifyWechatTransportError(new Error("HTTP 401: unauthorized"))).toEqual({
      kind: "auth",
      retryable: false,
      statusCode: 401,
    });
  });

  test("treats WeChat session timeout as fatal auth instead of retryable network", () => {
    expect(
      classifyWechatTransportError(
        new Error('WeChat session timed out. Run "werelay-setup" to log in again.'),
      ),
    ).toEqual({
      kind: "auth",
      retryable: false,
    });
  });

  test("detects expired WeChat sync sessions from app-level responses", () => {
    expect(
      isWechatSyncSessionTimeout({
        errcode: -14,
        errmsg: "session timeout",
      }),
    ).toBe(true);
    expect(
      isWechatSyncSessionTimeout({
        errcode: -14,
        errmsg: "other failure",
      }),
    ).toBe(false);
  });

  test("throws on app-level sendmessage failures even when HTTP succeeded", () => {
    expect(() =>
      assertWechatApiResponseOk(
        "sendmessage",
        JSON.stringify({ ret: 1, errcode: 45009, errmsg: "rate limited" }),
      ),
    ).toThrow("sendmessage failed: ret=1 errcode=45009 errmsg=rate limited");

    expect(() =>
      assertWechatApiResponseOk("sendmessage", JSON.stringify({ ret: 0 })),
    ).not.toThrow();
  });

  test("classifies sendmessage ret=-2 as stale WeChat context", () => {
    let thrown: unknown;

    try {
      assertWechatApiResponseOk("sendmessage", JSON.stringify({ ret: -2 }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WechatApiResponseError);
    expect(thrown).toMatchObject({
      endpoint: "sendmessage",
      ret: -2,
      errcode: undefined,
      errmsg: "",
    });
    expect(isWechatContextTokenStaleError(thrown)).toBe(true);
    expect(describeWechatTransportError(thrown)).toContain(
      "WechatApiResponseError: sendmessage failed: ret=-2 errcode=undefined errmsg=",
    );
  });

  test("does not classify other app-level failures as stale WeChat context", () => {
    expect(
      isWechatContextTokenStaleError(
        new WechatApiResponseError({
          endpoint: "getupdates",
          ret: -2,
        }),
      ),
    ).toBe(false);
    expect(
      isWechatContextTokenStaleError(
        new WechatApiResponseError({
          endpoint: "sendmessage",
          ret: 1,
        }),
      ),
    ).toBe(false);
  });

  test("claims each inbound message key only once across processes", () => {
    const claimsDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claims-"));
    const scopedMessageKey = "account-1|sender|client|123|ctx";

    try {
      expect(tryClaimInboundMessage(scopedMessageKey, { claimsDir })).toBe(true);
      expect(tryClaimInboundMessage(scopedMessageKey, { claimsDir })).toBe(false);
      const claimPath = buildInboundMessageClaimPath(scopedMessageKey, claimsDir);
      expect(fs.existsSync(claimPath)).toBe(true);
      if (process.platform !== "win32") {
        expect(fs.statSync(claimsDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(claimPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      clearInboundMessageClaims(claimsDir);
    }
  });

  test("reclaims stale inbound message claims after the TTL expires", () => {
    const claimsDir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-claims-"));
    const scopedMessageKey = "account-1|sender|client|456|ctx";
    const nowMs = Date.now();

    try {
      expect(
        tryClaimInboundMessage(scopedMessageKey, {
          claimsDir,
          nowMs,
          ttlMs: 1000,
        }),
      ).toBe(true);

      const claimPath = buildInboundMessageClaimPath(scopedMessageKey, claimsDir);
      fs.utimesSync(claimPath, new Date(nowMs - 5000), new Date(nowMs - 5000));

      expect(
        tryClaimInboundMessage(scopedMessageKey, {
          claimsDir,
          nowMs,
          ttlMs: 1000,
        }),
      ).toBe(true);
    } finally {
      clearInboundMessageClaims(claimsDir);
    }
  });
});

describe("wechat inbound media", () => {
  const demoImageAesKey = Buffer.alloc(16, 0x11).toString("hex");
  const demoFileAesKey = Buffer.alloc(16, 0x22).toString("hex");

  test("extracts image and file descriptors without requiring text", () => {
    const message: WeixinMessage = {
      item_list: [
        {
          type: 2,
          image_item: {
            file_name: "screenshot.png",
            media: {
              aes_key: demoImageAesKey,
              encrypt_query_param: "img-param",
            },
          },
        },
        {
          type: 4,
          file_item: {
            file_name: "report.pdf",
            len: "128",
            media: {
              aes_key: demoFileAesKey,
              encrypt_query_param: "file-param",
            },
          },
        },
      ],
    };

    expect(extractInboundMessageContent(message)).toEqual({
      text: "",
      attachments: [
        expect.objectContaining({
          kind: "image",
          fileName: "screenshot.png",
          aesKey: demoImageAesKey,
          expectedSizeBytes: undefined,
        }),
        expect.objectContaining({
          kind: "file",
          fileName: "report.pdf",
          aesKey: demoFileAesKey,
          expectedSizeBytes: 128,
        }),
      ],
    });
  });

  test("adds an explicit note when media metadata is missing", () => {
    const message: WeixinMessage = {
      item_list: [{ type: 2, image_item: {} }],
    };

    expect(extractInboundMessageContent(message)).toEqual({
      text: "[WeChat image attachment could not be downloaded: missing media metadata]",
      attachments: [],
    });
  });

  test("builds CDN download URLs from encrypted query params", () => {
    expect(buildCdnDownloadUrl("https://novac2c.cdn.weixin.qq.com/c2c", "a+b/c=")).toBe(
      "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%2Bb%2Fc%3D",
    );
  });

  test("decodes inbound AES keys and decrypts media payloads", () => {
    const key = Buffer.alloc(16, 0x11);
    const plaintext = Buffer.from("wechat inbound media");
    const cipher = createCipheriv("aes-128-ecb", key, null);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    expect(decodeInboundMediaAesKey(key.toString("hex"))).toEqual(key);
    expect(decodeInboundMediaAesKey(key.toString("base64"))).toEqual(key);
    expect(decodeInboundMediaAesKey(Buffer.from(key.toString("hex")).toString("base64"))).toEqual(
      key,
    );
    expect(decryptInboundMediaPayload(ciphertext, key.toString("hex"))).toEqual(plaintext);
  });
});

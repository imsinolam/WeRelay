import { describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";

import {
  buildDeepSeekHarnessSessionCookie,
  classifyDeepSeekHarnessProbe,
  deepSeekHarnessAuthority,
  deepSeekHarnessEndpoint,
  resolveDeepSeekHarnessCookieHeader,
  typertSessionAddress,
  wrapTypertPayload,
} from "../../src/bridge/deepseek-harness-protocol.ts";

describe("DeepSeek Harness protocol mapping", () => {
  test("maps each capability to its dialect-specific endpoint", () => {
    expect(deepSeekHarnessEndpoint("listSessions", "legacy")).toBe("session.list");
    expect(deepSeekHarnessEndpoint("listSessions", "typert")).toBe("session/list");
    expect(deepSeekHarnessEndpoint("readHistory", "typert")).toBe("session/page");
    expect(deepSeekHarnessEndpoint("readModels", "typert")).toBe("session/modelCatalog");
    expect(deepSeekHarnessEndpoint("cancelSession", "typert")).toBe("session/cancel");
    // Typert dropped the dedicated describe endpoint.
    expect(deepSeekHarnessEndpoint("describeHost", "typert")).toBeNull();
  });

  test("wraps Typert payloads with the field each endpoint declares", () => {
    expect(wrapTypertPayload("session/list", {})).toEqual({ args: { _request: {} } });
    expect(wrapTypertPayload("session/cancel", { sessionId: "s" }))
      .toEqual({ args: { request: { sessionId: "s" } } });
    // Catalog endpoints declare no parameters and reject any field.
    expect(wrapTypertPayload("session/modelCatalog", {})).toEqual({ args: {} });
  });

  test("addresses sessions through the Typert address union", () => {
    expect(typertSessionAddress("session-1"))
      .toEqual({ address: { kind: "session", sessionId: "session-1" } });
    expect(typertSessionAddress("child-1", "childSession"))
      .toEqual({ address: { kind: "childSession", childSessionId: "child-1" } });
  });

  test("classifies host dialect from the probe response", () => {
    // A legacy host has no slash route at all.
    expect(classifyDeepSeekHarnessProbe({ status: 404, body: "not found" })).toBe("legacy");
    // A Typert host serves it, and answers a gateway envelope.
    expect(classifyDeepSeekHarnessProbe({
      status: 200,
      body: JSON.stringify({ type: "server-response", result: { ok: true, value: { items: [] } } }),
    })).toBe("typert");
    expect(classifyDeepSeekHarnessProbe({
      status: 200,
      body: JSON.stringify({ result: { ok: false, error: { code: "gateway/bad-request" } } }),
    })).toBe("typert");
    // A Typert host without a valid cookie still proves the route exists.
    expect(classifyDeepSeekHarnessProbe({ status: 401, body: "unauthorized" })).toBe("typert");
  });

  test("derives the cookie authority from the base URL", () => {
    expect(deepSeekHarnessAuthority("http://127.0.0.1:43120")).toBe("127.0.0.1:43120");
    expect(deepSeekHarnessAuthority("not a url")).toBeNull();
  });

  test("mints the DSH-signed session cookie the host accepts", () => {
    const secret = Buffer.alloc(32, 7);
    const cookie = buildDeepSeekHarnessSessionCookie({
      authority: "127.0.0.1:43120",
      secret,
      nowMs: 1_700_000_000_000,
    });
    const expectedName = "dsh-auth-" +
      createHash("sha256").update("127.0.0.1:43120").digest("base64url");
    const [name, value] = cookie.split("=");
    expect(name).toBe(expectedName);

    const [version, body, signed] = value!.split(".");
    expect(version).toBe("v1");
    // The signature must be an HMAC over the exact encoded body.
    expect(signed).toBe(createHmac("sha256", secret).update(body!).digest("base64url"));
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    expect(payload).toMatchObject({ version: 1, authority: "127.0.0.1:43120" });
    expect(payload.expiresAt).toBeGreaterThan(payload.issuedAt);
  });

  test("omits the cookie when the host has no credential store", () => {
    // Legacy hosts predate the auth fence; sending nothing preserves them.
    expect(resolveDeepSeekHarnessCookieHeader("http://127.0.0.1:3080", {
      readCredentials: () => "",
      now: () => 0,
    })).toBeNull();
    expect(resolveDeepSeekHarnessCookieHeader("http://127.0.0.1:3080", {
      readCredentials: () => { throw new Error("unreadable"); },
      now: () => 0,
    })).toBeNull();
    // A malformed secret must not produce a broken cookie.
    expect(resolveDeepSeekHarnessCookieHeader("http://127.0.0.1:3080", {
      readCredentials: () => "secret: short",
      now: () => 0,
    })).toBeNull();
  });

  test("resolves a cookie once a 32-byte secret is present", () => {
    const secret = Buffer.alloc(32, 3).toString("base64url");
    const cookie = resolveDeepSeekHarnessCookieHeader("http://127.0.0.1:43120", {
      readCredentials: () => `version: 1\nrecords:\n  secret: ${secret}\n`,
      now: () => 1_700_000_000_000,
    });
    expect(cookie).toContain("dsh-auth-");
    expect(cookie).toContain("=v1.");
  });
});

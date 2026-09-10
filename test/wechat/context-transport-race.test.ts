import { expect, test } from "bun:test";
import { WeChatTransport } from "../../src/wechat/wechat-transport.ts";
import { ContextSendGuard } from "../../src/wechat/context-send-guard.ts";

// Bypass constructor so tests never read or write real accounts or runtime files.
function fakeTransport() {
  const transport = Object.create(WeChatTransport.prototype) as {
    contextTokenCache: Map<string, string>;
    contextSendGuard: ContextSendGuard;
    sendMessage: (account: { token: string; baseUrl: string }, recipient: string, token: string, items: unknown[], key?: string) => Promise<void>;
  };
  transport.contextTokenCache = new Map([["recipient", "fresh"]]);
  transport.contextSendGuard = new ContextSendGuard();
  return transport;
}

test("media final send reads fresh token after upload rather than captured old token", async () => {
  const transport = fakeTransport(); const original = globalThis.fetch;
  const tokens: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    tokens.push(JSON.parse(String(init.body)).msg.context_token);
    return new Response('{"ret":0}');
  }) as typeof fetch;
  try {
    await transport.sendMessage({ token: "account", baseUrl: "https://example.invalid" }, "recipient", "captured-before-upload", [{ type: 2 }], "image:stable-content-digest");
    expect(tokens).toEqual(["fresh"]);
  } finally { globalThis.fetch = original; }
});

test("late old-token rejection retries the new token once and keeps it cached", async () => {
  const transport = fakeTransport(); const original = globalThis.fetch; const tokens: string[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    tokens.push(JSON.parse(String(init.body)).msg.context_token);
    if (tokens.length === 1) { transport.contextTokenCache.set("recipient", "newest"); return new Response('{"ret":-2,"errmsg":"prepare failed"}'); }
    return new Response('{"ret":0}');
  }) as typeof fetch;
  try {
    await transport.sendMessage({ token: "account", baseUrl: "https://example.invalid" }, "recipient", "captured", [{ type: 1 }]);
    expect(tokens).toEqual(["fresh", "newest"]);
    expect(transport.contextTokenCache.get("recipient")).toBe("newest");
  } finally { globalThis.fetch = original; }
});

test("uncertain media delivery stays paused even if a retry upload has new ciphertext", async () => {
  const transport = fakeTransport(); const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("connection lost"); }) as typeof fetch;
  try {
    const account = { token: "account", baseUrl: "https://example.invalid" };
    await expect(transport.sendMessage(account, "recipient", "fresh", [{ type: 2, media: "first-upload" }], "image:same-content")).rejects.toThrow("未确认");
    await expect(transport.sendMessage(account, "recipient", "fresh", [{ type: 2, media: "new-upload" }], "image:same-content")).rejects.toThrow("未确认");
    expect(calls).toBe(1);
  } finally { globalThis.fetch = original; }
});

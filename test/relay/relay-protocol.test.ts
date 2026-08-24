import { describe, expect, test } from "bun:test";

import {
  isWeRelayRelayApiRequest,
  normalizeWeRelayRelayBaseUrl,
  timingSafeRelayTokenEqual,
} from "../../src/relay/relay-protocol.ts";

describe("WeRelay relay protocol", () => {
  test("only forwards WeRelay application APIs", () => {
    expect(isWeRelayRelayApiRequest("GET", "/api/tasks")).toBe(true);
    expect(isWeRelayRelayApiRequest("PATCH", "/api/tasks/thread")).toBe(true);
    expect(isWeRelayRelayApiRequest("PUT", "/api/tasks/thread/model")).toBe(true);
    expect(isWeRelayRelayApiRequest("GET", "/health")).toBe(false);
    expect(isWeRelayRelayApiRequest("POST", "/__werelay/device/poll")).toBe(false);
    expect(isWeRelayRelayApiRequest("CONNECT", "/api/tasks")).toBe(false);
  });

  test("normalizes relay URLs without accepting embedded credentials", () => {
    expect(normalizeWeRelayRelayBaseUrl("https://relay.example.com///")).toBe(
      "https://relay.example.com",
    );
    expect(() => normalizeWeRelayRelayBaseUrl("https://user:pass@relay.example.com"))
      .toThrow("不能包含账号");
  });

  test("compares device tokens safely", () => {
    expect(timingSafeRelayTokenEqual("same-token", "same-token")).toBe(true);
    expect(timingSafeRelayTokenEqual("short", "different-token")).toBe(false);
  });
});

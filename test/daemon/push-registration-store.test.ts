import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PushRegistrationStore } from "../../src/daemon/push-registration-store.ts";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-push-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function store(): PushRegistrationStore {
  return new PushRegistrationStore(path.join(dir, "push.json"));
}

describe("PushRegistrationStore", () => {
  test("starts empty when the file is missing", () => {
    expect(store().all()).toEqual([]);
    expect(store().active("https://example.com")).toEqual([]);
  });

  test("re-registering the same token replaces instead of duplicating", () => {
    const s = store();
    s.upsert({ provider: "vivo", token: "t1", origin: "https://a" });
    s.upsert({ provider: "vivo", token: "t1", origin: "https://a" });
    expect(s.all()).toHaveLength(1);
  });

  test("keeps origins separate so a second server cannot read the first", () => {
    const s = store();
    s.upsert({ provider: "vivo", token: "t1", origin: "https://a" });
    s.upsert({ provider: "vivo", token: "t2", origin: "https://b" });
    expect(s.active("https://a").map((r) => r.token)).toEqual(["t1"]);
    expect(s.active("https://b").map((r) => r.token)).toEqual(["t2"]);
  });

  test("invalidated tokens stop being returned but stay on disk", () => {
    const s = store();
    s.upsert({ provider: "vivo", token: "t1", origin: "https://a" });
    s.invalidate("vivo", "t1");
    expect(s.active("https://a")).toEqual([]);
    expect(s.all()).toHaveLength(1);
    expect(s.all()[0].invalidatedAtMs).toBeGreaterThan(0);
  });

  test("clearing an origin keeps other servers' registrations", () => {
    const s = store();
    s.upsert({ provider: "vivo", token: "t1", origin: "https://a" });
    s.upsert({ provider: "vivo", token: "t2", origin: "https://b" });
    s.clearOrigin("https://a");
    expect(s.active("https://a")).toEqual([]);
    expect(s.active("https://b")).toHaveLength(1);
  });

  test("survives a corrupt file by resetting", () => {
    const file = path.join(dir, "push.json");
    fs.writeFileSync(file, "{not json");
    const s = new PushRegistrationStore(file);
    expect(s.all()).toEqual([]);
    s.upsert({ provider: "vivo", token: "t1", origin: "https://a" });
    expect(new PushRegistrationStore(file).active("https://a")).toHaveLength(1);
  });

  test("caps the number of stored registrations", () => {
    const s = store();
    for (let i = 0; i < 40; i += 1) {
      s.upsert({ provider: "vivo", token: `t${i}`, origin: "https://a" });
    }
    expect(s.all()).toHaveLength(32);
  });
});

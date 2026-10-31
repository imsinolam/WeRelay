import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageRecords } from "../../src/daemon/message-records.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-records-")); dirs.push(dir);
  let now = Date.now();
  const options = { stateFile: path.join(dir, "records.jsonl"), now: () => now };
  return { store: new MessageRecords(options), options, advance: (ms: number) => { now += ms; } };
}
const input = { key: "stable", source: "web" as const, adapter: "codex", threadId: "original", text: "测试消息", imageCount: 1, status: "accepted" as const, attempts: 0 };

test("one logical message survives retry, task migration and restart without duplicate counts", () => {
  const h = fixture(); h.store.record(input);
  h.store.record({ ...input, status: "sending", attempts: 1 });
  h.store.record({ ...input, status: "retrying", attempts: 1, error: "请求超时" });
  h.store.record({ ...input, status: "submitted", attempts: 2, threadId: "real" });
  h.store.record({ ...input, status: "submitted", attempts: 2, threadId: "real" });
  const result = new MessageRecords(h.options).query({});
  expect(result.total).toBe(1);
  expect(result.stats.retries).toBe(1);
  expect(result.records[0]).toMatchObject({ threadId: "real", attempts: 2, status: "submitted" });
  expect(result.records[0]!.events).toHaveLength(4);
  if (process.platform !== "win32") {
    expect(fs.statSync(h.options.stateFile).mode & 0o777).toBe(0o600);
  }
});

test("filters and statistics use the same retained logical records", () => {
  const h = fixture(); h.store.record(input);
  h.store.record({ ...input, key: "wechat", source: "clawbot", status: "failed", adapter: "pi", attempts: 2 });
  expect(h.store.query({ source: "web" }).total).toBe(1);
  expect(h.store.query({ source: "clawbot", status: "failed" }).stats.failed).toBe(1);
  expect(h.store.query({ adapter: "pi" }).records[0]!.source).toBe("clawbot");
  expect(h.store.query({ search: "不存在" }).records).toEqual([]);
});

test("privacy changes erase old text, redact secrets and disabling or clearing never reimports history", () => {
  const h = fixture();
  h.store.record({ ...input, text: "token=super-secret-value Authorization: Bearer abcdefghijk", error: "https://user:password@example.invalid/?token=secret" });
  expect(fs.readFileSync(h.options.stateFile, "utf8")).not.toContain("super-secret-value");
  expect(fs.readFileSync(h.options.stateFile, "utf8")).not.toContain("user:password");
  h.store.configure({ textMode: "none" });
  expect(fs.readFileSync(h.options.stateFile, "utf8")).not.toContain("测试消息");
  expect(h.store.query({}).records[0]!.preview).toBe("");
  h.store.configure({ enabled: false }); h.store.record({ ...input, key: "off" });
  expect(h.store.query({}).total).toBe(1);
  h.store.clear();
  expect(new MessageRecords(h.options).query({}).total).toBe(0);
  expect(h.store.importWebHistory([])).toBe(0);
});

test("retention, capacity and historical snapshots are explicit and bounded", () => {
  const h = fixture();
  h.store.importWebHistory([{ clientId: "history", adapter: "codex", threadId: "task", text: "历史", images: [], createdAtMs: Date.now(), status: "delivered", attempts: 2 }]);
  expect(h.store.query({}).records[0]!.historical).toBe(true);
  h.store.configure({ retentionDays: 7, maxRecords: 500 });
  h.advance(8 * 86400_000);
  expect(h.store.query({}).total).toBe(0);
  for (let i = 0; i < 505; i++) h.store.record({ ...input, key: String(i) });
  expect(h.store.query({}).total).toBe(500);
  expect(h.store.query({ limit: 10, offset: 10 }).records).toHaveLength(10);
});

test("invalid filters and policy are rejected instead of accidentally exposing unfiltered records", () => {
  const h = fixture();
  expect(() => h.store.query({ source: "bad" })).toThrow();
  expect(() => h.store.query({ from: "not-a-date" })).toThrow();
  expect(() => h.store.configure({ retentionDays: 0 })).toThrow();
});

test("a damaged journal is preserved and reported, not overwritten as an empty history", () => {
  const h = fixture(); h.store.record(input);
  fs.appendFileSync(h.options.stateFile, "broken\n");
  const reopened = new MessageRecords(h.options);
  expect(reopened.query({}).warning).toBeTruthy();
  expect(reopened.query({}).total).toBe(1);
  reopened.record({ ...input, key: "new" });
  expect(fs.readFileSync(h.options.stateFile, "utf8")).toContain("broken");
});

test("clearing and pausing do not resurrect previous outbox entries", () => {
  const h = fixture(); const createdAtMs = h.options.now(); h.store.record({ ...input, createdAtMs });
  h.advance(1); h.store.clear(); h.advance(1);
  h.store.record({ ...input, createdAtMs, status: "delivered", error: "原来已删除的错误文字" });
  expect(h.store.query({}).total).toBe(0);
  h.store.configure({ enabled: false });
  const duringPause = h.options.now(); h.advance(1); h.store.configure({ enabled: true });
  h.store.record({ ...input, key: "paused", createdAtMs: duringPause });
  expect(h.store.query({}).total).toBe(0);
});

test("less restrictive text settings do not retroactively recover deleted body", () => {
  const h = fixture(); const createdAtMs = h.options.now(); h.store.record({ ...input, createdAtMs });
  h.store.configure({ textMode: "none" }); h.advance(1); h.store.configure({ textMode: "body" });
  h.store.record({ ...input, createdAtMs, status: "delivered" });
  expect(h.store.query({}).records[0]).toMatchObject({ preview: "" });
  expect(h.store.query({}).records[0]!.body).toBeUndefined();
  expect(h.store.query({}).records[0]!.error).toBeUndefined();
});

test("failed policy saves and clear preserve the previous state and can be retried", () => {
  const h = fixture(); h.store.record(input);
  const file = h.options.stateFile;
  const backup = file + ".backup";
  fs.renameSync(file, backup); fs.mkdirSync(file);
  expect(() => h.store.configure({ textMode: "none", enabled: false })).toThrow("未保存");
  expect(h.store.query({}).policy).toMatchObject({ enabled: true, textMode: "summary" });
  expect(h.store.query({}).records[0]!.preview).toBe("测试消息");
  expect(() => h.store.clear()).toThrow("未清空");
  expect(h.store.query({}).total).toBe(1);
  fs.rmdirSync(file); fs.renameSync(backup, file);
  expect(h.store.configure({ textMode: "none" }).records[0]!.preview).toBe("");
  expect(h.store.clear().total).toBe(0);
});

test("ClawBot only confirms a real matching user receipt, never an assistant completion", () => {
  const h = fixture(); const now = h.options.now();
  h.store.record({ ...input, source: "clawbot", turnId: "turn", status: "submitted", createdAtMs: now });
  h.store.confirmClawbotReceipts("codex", "original", [{ role: "assistant", turnId: "turn", text: "测试消息", createdAtMs: now }]);
  expect(h.store.query({}).records[0]!.status).toBe("submitted");
  h.store.confirmClawbotReceipts("codex", "original", [{ role: "user", turnId: "turn", text: "另一条", createdAtMs: now }]);
  expect(h.store.query({}).records[0]!.status).toBe("submitted");
  h.store.confirmClawbotReceipts("codex", "original", [{ role: "user", turnId: "turn", text: "测试消息", createdAtMs: now }]);
  expect(h.store.query({}).records[0]!.status).toBe("delivered");
});

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reviewTaskFailures } from "../../src/daemon/task-failure-review.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
const now = 2_000_000_000_000;
const day = 86400_000;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-failure-review-")); dirs.push(root);
  const workspace = path.join(root, "workspaces", "private-project"); fs.mkdirSync(workspace, { recursive: true });
  const file = path.join(workspace, "message-records.jsonl");
  const write = (rows: unknown[]) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  return { root, file, write, run: () => reviewTaskFailures(root, { now }) };
}
function row(patch: Record<string, unknown> = {}) {
  return { type: "record", row: { id: "message-private", source: "web", adapter: "codex", threadId: "thread-private", preview: "private prose", body: "secret body", kind: "task", status: "failed", attempts: 2, createdAtMs: now - 3 * day, updatedAtMs: now - 1000, omittedEvents: 0, events: [{ atMs: now - 1000, status: "failed", attempts: 2, error: "ECONNREFUSED token=secret https://private.example" }], ...patch } };
}
const meta = { type: "meta", policy: { enabled: true }, startedAtMs: now - 5 * day };

test("deduplicates journal rows and counts today's failures for older messages by event time", () => {
  const h = fixture(); h.write([meta, row(), row()]);
  const result = h.run();
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]).toMatchObject({ category: "connection", recentMessages: 1, outstandingMessages: 1, outcomes: { attention: 1 } });
  const json = JSON.stringify(result);
  for (const text of ["private-project", "message-private", "thread-private", "private prose", "secret body", "token=", "private.example"]) expect(json).not.toContain(text);
  const before = fs.readFileSync(h.file, "utf8"); h.run(); expect(fs.readFileSync(h.file, "utf8")).toBe(before);
});

test("distinguishes recovered delivery, uncertainty, pending retry and cancelled without claiming execution success", () => {
  const h = fixture(); const events = row().row.events;
  h.write([meta, row({ status: "delivered", events: [...events, { atMs: now - 500, status: "delivered", attempts: 2 }] }),
    row({ id: "uncertain", status: "unconfirmed" }), row({ id: "pending", status: "retrying" }), row({ id: "cancelled", status: "cancelled" })]);
  expect(h.run().groups[0]).toMatchObject({ recentMessages: 4, outstandingMessages: 2, outcomes: { recovered: 1, attention: 1, pending: 1, closed: 1 } });
  expect(h.run().scope).toContain("不代表 Agent 执行结果");
});

test("keeps unresolved older incidents visible but excludes old recovered incidents and controls", () => {
  const h = fixture(); const events = [{ atMs: now - 2 * day, status: "failed", attempts: 1 }];
  h.write([meta, row({ events }), row({ id: "old-recovered", events, status: "submitted" }), row({ id: "control", kind: "control" })]);
  expect(h.run().groups[0]).toMatchObject({ recentMessages: 0, outstandingMessages: 1 });
});

test("reports disabled, corrupt, missing and truncated evidence as gaps, never zero failures proof", () => {
  const h = fixture();
  h.write([{ ...meta, policy: { enabled: false } }, row({ omittedEvents: 4, historical: true })]);
  fs.appendFileSync(h.file, "{incomplete\n");
  const result = h.run();
  expect(result.coverage[0]?.gaps).toEqual(expect.arrayContaining(["recording-disabled", "invalid-records", "events-truncated", "historical-snapshot"]));
  expect(result.complete).toBe(false);
  fs.unlinkSync(h.file); expect(h.run().coverage[0]?.gaps).toContain("journal-missing");
  fs.rmSync(path.join(h.root, "workspaces"), { recursive: true }); expect(h.run().gaps).toContain("workspaces-unavailable");
});

test("rejects malformed records and does not follow journal symlinks", () => {
  const h = fixture(); h.write([meta, row({ events: [null] }), row({ updatedAtMs: "bad" })]);
  expect(h.run().coverage[0]?.gaps).toContain("invalid-records");
  expect(h.run().groups).toHaveLength(0);
  fs.renameSync(h.file, h.file + ".original"); fs.symlinkSync(h.file + ".original", h.file);
  expect(h.run().coverage[0]?.gaps).toContain("unsafe-file");
});

test("validates time window and emits stable category fingerprints without arbitrary adapter text", () => {
  const h = fixture(); h.write([meta, row({ adapter: "secret-provider-name" })]);
  expect(h.run().groups[0]?.adapter).toBe("other");
  expect(h.run().groups[0]?.fingerprint).toBe(h.run().groups[0]?.fingerprint);
  expect(() => reviewTaskFailures(h.root, { now, hours: -1 })).toThrow();
});

test("bounds journal size, exposes incomplete time coverage and ignores future evidence", () => {
  const h = fixture();
  h.write([{ ...meta, startedAtMs: now - 1000 }, row({ events: [{ atMs: now + 1000, status: "failed" }] })]);
  expect(h.run().groups).toHaveLength(0);
  expect(h.run().coverage[0]?.gaps).toEqual(expect.arrayContaining(["partial-window", "future-timestamp"]));
  fs.truncateSync(h.file, 16 * 1024 * 1024 + 1);
  expect(h.run().coverage[0]?.gaps).toContain("journal-too-large");
});

test("CLI honors isolated data directory and rejects invalid arguments without leaking input", () => {
  const h = fixture(); h.write([meta, row()]);
  const command = ["node", "--experimental-strip-types", "scripts/review-task-failures.mjs"];
  const valid = Bun.spawnSync(command, { env: { ...process.env, WERELAY_DATA_DIR: h.root } });
  expect(valid.exitCode).toBe(0);
  expect(JSON.parse(valid.stdout.toString()).coverage).toHaveLength(1);
  const invalid = Bun.spawnSync([...command, "private-invalid-input"], { env: { ...process.env, WERELAY_DATA_DIR: h.root } });
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stderr.toString()).not.toContain("private-invalid-input");
});

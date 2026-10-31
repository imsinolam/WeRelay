import { expect, test } from "bun:test";
import { MESSAGE_RECORD_SETTINGS_JS, MESSAGE_RECORD_SETTINGS_CSS } from "../../src/web/message-record-settings.ts";
import { CODEX_MOBILE_JS } from "../../src/daemon/codex-mobile-web.ts";
import { MessageRecords } from "../../src/daemon/message-records.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("delivery groups are exhaustive and group filtering precedes pagination and statistics", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-record-groups-"));
  try {
    const store = new MessageRecords({ stateFile: path.join(dir, "records.jsonl") });
    const statuses = ["received", "accepted", "sending", "retrying", "queued", "submitted", "unconfirmed", "failed", "delivered", "cancelled", "handled"] as const;
    statuses.forEach(status => store.record({ key: status, source: "web", adapter: "codex", threadId: "same", text: status, status, attempts: 1 }));
    expect(store.query({ statusGroup: "active" }).total).toBe(5);
    expect(store.query({ statusGroup: "sent" }).stats.messages).toBe(2);
    expect(store.query({ statusGroup: "attention" }).records.map(row => row.status).sort()).toEqual(["failed", "unconfirmed"]);
    expect(store.query({ statusGroup: "closed" }).total).toBe(2);
    expect(() => store.query({ statusGroup: "typo" })).toThrow();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("record settings use compact progressive filters and read-only preview without navigating or switching", () => {
  expect(MESSAGE_RECORD_SETTINGS_JS).toContain('id="record-more-filters"');
  expect(MESSAGE_RECORD_SETTINGS_JS).toContain('class="record-filter-actions"');
  const readable = MESSAGE_RECORD_SETTINGS_JS.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  expect(readable).toContain('"active", "处理中"');
  expect(MESSAGE_RECORD_SETTINGS_CSS).toContain("align-self: end");
  const wiring = CODEX_MOBILE_JS.slice(CODEX_MOBILE_JS.indexOf("messageRecordSettings = createMessageRecordSettings"), CODEX_MOBILE_JS.indexOf("else void loadSettings();", CODEX_MOBILE_JS.indexOf("messageRecordSettings = createMessageRecordSettings")));
  expect(wiring).toContain("readTask:");
  expect(wiring).not.toMatch(/switchAdapter\(|selectTask\(|setSettingsOpen\(false/);
  expect(MESSAGE_RECORD_SETTINGS_JS).toContain("showModal()");
  expect(MESSAGE_RECORD_SETTINGS_JS).toContain("previewEpoch");
  expect(readable).toContain("展开回复");
  expect(readable).toContain("收起回复");
  expect(MESSAGE_RECORD_SETTINGS_CSS).toContain("max-height: 4.8em");
  new Function(MESSAGE_RECORD_SETTINGS_JS);
});

test("record runtime enrichment stays read-only and does not infer completion from delivery", () => {
  const source = fs.readFileSync(new URL("../../src/daemon/werelay-daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("readMessageRecords: (query, exporting) => {");
  const end = source.indexOf("changeMessageRecords:", start);
  const callback = source.slice(start + "readMessageRecords: ".length, end).trim().replace(/,$/, "");
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`function harness() { const read = ${callback}; return read; }`);
  const payload = { records: [
    { kind: "task", threadId: "running", adapter: "codex", status: "delivered" },
    { kind: "task", threadId: "missing", adapter: "codex", status: "submitted" },
    { kind: "task", threadId: "offline", adapter: "pi", status: "delivered" },
  ] };
  const h = { messageRecords: { query: () => structuredClone(payload) }, slots: new Map([["codex", { taskCandidatesCache: [] }]]),
    resolveMobileTaskStatus: (_slot: unknown, id: string) => id === "running" ? "running" : "idle", getSlotThreadId: () => "other" };
  const read = new Function(js + "; return harness;")().call(h);
  const result = read({}, false);
  expect(result.records.map((row: any) => [row.status, row.taskState])).toEqual([["delivered", "running"], ["submitted", "unknown"], ["delivered", "unknown"]]);
});

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexMobileAuthStore } from "../../src/daemon/codex-mobile-auth.ts";
import { startCodexMobileServer } from "../../src/daemon/codex-mobile-server.ts";
import { DAILY_REVIEW_SETTINGS_JS } from "../../src/web/daily-review-settings.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

test("review history is authenticated, read-only, uncached and independent of real Agent operations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-review-settings-")); dirs.push(dir);
  const authStore = new CodexMobileAuthStore({ stateFile: path.join(dir, "auth.json") });
  authStore.setPassword("synthetic-review-password");
  let reads = 0;
  const server = await startCodexMobileServer({ host: "127.0.0.1", port: 0, lanAddress: "127.0.0.1", accessToken: "synthetic", authStore,
    listTasks: async () => { throw new Error("must not access Agent"); },
    readMessages: async () => { throw new Error("must not read conversation"); },
    sendMessage: async () => { throw new Error("must not send"); },
    readDailyReviews: () => { reads++; return { reports: [], skipped: 0 }; } });
  try {
    const url = `http://127.0.0.1:${server.port}/api/settings/daily-reviews`;
    expect((await fetch(url)).status).toBe(401);
    expect(reads).toBe(0);
    const headers = { cookie: `codex_mobile_session=${authStore.createSessionToken()}` };
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ reports: [], skipped: 0 });
    expect((await fetch(url, { method: "POST", headers })).status).toBe(405);
    expect(reads).toBe(1);
  } finally { await server.close(); }
});

function uiHarness(api: () => Promise<unknown>) {
  const button = { addEventListener() {} };
  const root = { innerHTML: "", querySelector: () => button, querySelectorAll: () => [] };
  const create = new Function(DAILY_REVIEW_SETTINGS_JS + ";return createDailyReviewSettings;")();
  const escape = (value: unknown) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return { root, ui: create({ root, api, escape }) };
}

test("loading, empty and failure states are actionable without claiming healthy tasks", async () => {
  const empty = uiHarness(async () => ({ reports: [], skipped: 0 }));
  await empty.ui.load();
  expect(empty.root.innerHTML).toContain("还没有巡检记录");
  expect(empty.root.innerHTML).not.toContain("全部正常");
  const failed = uiHarness(async () => { throw new Error("private raw error"); });
  await failed.ui.load();
  expect(failed.root.innerHTML).toContain("请稍后刷新重试");
  expect(failed.root.innerHTML).not.toContain("private raw error");
});

test("late responses cannot replace a different settings tab and report prose is escaped", async () => {
  let resolve!: (value: unknown) => void;
  const late = uiHarness(() => new Promise(done => { resolve = done; }));
  const pending = late.ui.load(); late.ui.destroy(); late.root.innerHTML = "different settings tab";
  resolve({ reports: [], skipped: 0 }); await pending;
  expect(late.root.innerHTML).toBe("different settings tab");
  const report = uiHarness(async () => ({ reports: [{ id: "id", atMs: Date.now(), counts: { recent: 5, outstanding: 19, recovered: 1, failed: 11, unconfirmed: 8 },
    issues: [{ title: "<img src=x>", detail: "<script>private</script>", status: "observing", statusLabel: "已更新，观察中", next: "继续观察" }],
    actions: ["完成检查"], coverageNote: "部分历史记录缺失" }], skipped: 0 }));
  await report.ui.load();
  expect(report.root.innerHTML).toContain("19");
  expect(report.root.innerHTML).toContain("包括历史记录在内");
  expect(report.root.innerHTML).toContain("送达不代表任务已经执行成功");
  expect(report.root.innerHTML).toContain("&lt;img");
  expect(report.root.innerHTML).not.toContain("<script>");
});

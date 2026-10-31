import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageRecords, clawbotMessageRecordKey } from "../../src/daemon/message-records.ts";
import { MobileMessageOutbox } from "../../src/daemon/mobile-message-outbox.ts";
import { CodexMobileAuthStore } from "../../src/daemon/codex-mobile-auth.ts";
import { startCodexMobileServer } from "../../src/daemon/codex-mobile-server.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-record-integration-")); dirs.push(dir);
  return { dir, records: new MessageRecords({ stateFile: path.join(dir, "records.jsonl") }) };
}

test("outbox observer records attempts, queue, real receipts and restart history without sending", () => {
  const { dir, records } = fixture();
  const options = { stateFile: path.join(dir, "outbox.json"), onChange: (entry: any) => records.recordWeb(entry) };
  const outbox = new MobileMessageOutbox(options);
  outbox.accept({ clientId: "same", adapter: "codex", threadId: "task", text: "合成请求", images: [] });
  outbox.markSending("codex", "task", "same");
  outbox.markQueued("codex", "task", "same", { queuedMessageId: "native", turnId: "turn" });
  outbox.reconcile("codex", "task", { queuedMessages: [], messages: [{ role: "user", text: "合成请求", turnId: "turn" }] });
  expect(records.query({}).records[0]).toMatchObject({ source: "web", status: "delivered", attempts: 1 });
  records.importWebHistory(new MobileMessageOutbox(options).snapshot());
  expect(records.query({}).total).toBe(1);
  expect(records.query({}).records[0]!.historical).toBe(false);
  records.configure({ enabled: false });
  outbox.accept({ clientId: "still-send", adapter: "codex", threadId: "task", text: "关闭记录不阻止发送", images: [] });
  expect(outbox.get("codex", "task", "still-send")).not.toBeNull();
  expect(records.query({}).total).toBe(1);
});

test("diagnostic observer failure never rejects an already persisted message", () => {
  const { dir } = fixture();
  const box = new MobileMessageOutbox({ stateFile: path.join(dir, "outbox.json"), onChange: () => { throw new Error("disk"); } });
  expect(() => box.accept({ clientId: "id", adapter: "pi", threadId: "task", text: "保留", images: [] })).not.toThrow();
  expect(new MobileMessageOutbox({ stateFile: path.join(dir, "outbox.json") }).snapshot()).toHaveLength(1);
});

test("message record settings require authentication and never touch an Agent", async () => {
  const { dir, records } = fixture();
  records.record({ key: "id", source: "clawbot", adapter: "pi", threadId: "task", text: "合成", status: "failed", attempts: 2 });
  const authStore = new CodexMobileAuthStore({ stateFile: path.join(dir, "auth.json") }); authStore.setPassword("synthetic-password");
  const server = await startCodexMobileServer({ host: "127.0.0.1", port: 0, lanAddress: "127.0.0.1", accessToken: "synthetic", authStore,
    listTasks: async () => { throw new Error("must not list Agent tasks"); }, readMessages: async () => { throw new Error("must not read Agent"); },
    sendMessage: async () => { throw new Error("must not send"); },
    readMessageRecords: (query, exporting) => exporting ? records.export(query) : records.query(query),
    changeMessageRecords: patch => records.configure(patch), clearMessageRecords: () => records.clear() });
  try {
    const url = `http://127.0.0.1:${server.port}/api/settings/message-records`;
    const headers = { cookie: `codex_mobile_session=${authStore.createSessionToken()}`, "content-type": "application/json" };
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"action":"clear"}' })).status).toBe(401);
    const response = await fetch(url + "?source=clawbot&status=failed", { headers });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await response.json()).stats).toMatchObject({ clawbot: 1, failed: 1, retries: 1 });
    expect((await fetch(url + "?source=invalid", { headers })).status).toBe(400);
    expect((await (await fetch(url + "?statusGroup=attention", { headers })).json()).total).toBe(1);
    expect((await (await fetch(url + "?statusGroup=sent", { headers })).json()).total).toBe(0);
    expect((await fetch(url + "?statusGroup=typo", { headers })).status).toBe(400);
    expect((await (await fetch(url + "?project=unassigned", { headers })).json()).total).toBe(1);
    expect((await (await fetch(url + "?project=nonexistent", { headers })).json()).total).toBe(0);
    expect((await (await fetch(url + "/export?project=nonexistent", { headers })).json()).records).toHaveLength(0);
    expect((await fetch(url + "?from=bad", { headers })).status).toBe(400);
    expect((await fetch(url, { method: "POST", headers, body: '{"retentionDays":0}' })).status).toBe(400);
    const exported = await fetch(url + "/export?source=clawbot", { headers });
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    expect((await exported.json()).records).toHaveLength(1);
    expect((await fetch(url, { method: "POST", headers, body: '{"action":"clear"}' })).status).toBe(200);
    expect(records.query({}).total).toBe(0);
  } finally { await server.close(); }
});

test("ClawBot uniform dispatch records queue and failure under the original message identity", async () => {
  const { records } = fixture();
  const source = fs.readFileSync(new URL("../../src/daemon/werelay-daemon.ts", import.meta.url), "utf8");
  function block(start: string, end: string) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
  const cls = `class Harness { ${block("  private recordClawbotMessage(", "  private async handleInboundMessageImpl(")}
    ${block("  private async dispatchInboundWechatText(", "  private async dispatchMobileText(")}
  }`;
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(cls);
  const Harness = new Function("clawbotMessageRecordKey", "formatInboundMessagePreview", "truncatePreview", "appendDaemonLog", "buildWechatInboundPrompt", js + ";return Harness;")(
    clawbotMessageRecordKey, (m: any) => m.text, (text: string) => text, () => {}, (text: string) => text);
  const h = new Harness();
  Object.assign(h, { messageRecords: records, activeAdapter: "codex", getSlotActiveTask: () => null,
    setSlotActiveTask: () => {}, clearSlotActiveTask: () => {}, persistCodexWechatThreadId: () => {} });
  let fail = false;
  const slot = { adapter: "codex", runtime: { getState: () => ({ sharedThreadId: "task" }), sendInputToSession: async () => {
    if (fail) throw new Error("合成发送失败"); return { queued: true, turnId: "turn" };
  } } };
  const message = { senderId: "synthetic", sessionId: "session", createdAt: "synthetic-time", text: "消息", attachments: [] };
  await h.dispatchInboundWechatText(message, slot, "task", { suppressAcceptedNotice: true });
  expect(records.query({}).records[0]).toMatchObject({ source: "clawbot", status: "queued", attempts: 1 });
  h.recordClawbotMessage(message, { status: "failed", attempts: 0, error: "提交后的通知失败" });
  expect(records.query({}).records[0]!.status).toBe("queued");
  fail = true;
  await expect(h.dispatchInboundWechatText(message, slot, "task", { suppressAcceptedNotice: true })).rejects.toThrow("合成发送失败");
  expect(records.query({}).total).toBe(1);
  expect(records.query({}).records[0]).toMatchObject({ status: "failed", attempts: 2 });
});

test("ClawBot wrapper separates controls, unconfirmed tasks and notification failures after submission", async () => {
  const { records } = fixture();
  const source = fs.readFileSync(new URL("../../src/daemon/werelay-daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("  private async handleInboundMessage(");
  const end = source.indexOf("  private async handleInboundMessageImpl(", start);
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`class Harness { ${source.slice(start, end)} }`);
  const Harness = new Function("clawbotMessageRecordKey", js + ";return Harness;")(clawbotMessageRecordKey);
  const h = new Harness();
  Object.assign(h, { messageRecords: records, authorizedUserId: "synthetic", activeAdapter: "codex", handleInboundMessageImpl: async () => {} });
  const message = { senderId: "synthetic", sessionId: "session", createdAt: "time", text: "控制命令", attachments: [] };
  await h.handleInboundMessage(message);
  expect(records.query({ kind: "control" }).records[0]!.status).toBe("handled");
  h.handleInboundMessageImpl = async (m: any) => h.recordClawbotMessage(m, { kind: "task", status: "received", attempts: 0 });
  await h.handleInboundMessage({ ...message, text: "恢复任务但未取得确认" });
  expect(records.query({ status: "unconfirmed" }).total).toBe(1);
  h.handleInboundMessageImpl = async (m: any) => {
    h.recordClawbotMessage(m, { kind: "task", status: "submitted", attempts: 1 });
    throw new Error("微信通知失败");
  };
  await expect(h.handleInboundMessage({ ...message, text: "已提交的任务" })).rejects.toThrow("微信通知失败");
  expect(records.query({ status: "submitted" }).total).toBe(1);
  expect(records.query({ status: "failed" }).total).toBe(0);
  h.handleInboundMessageImpl = async () => { throw new Error("unauthorized"); };
  await expect(h.handleInboundMessage({ ...message, senderId: "unauthorized", text: "不应记录" })).rejects.toThrow();
  expect(records.query({}).total).toBe(3);
});

test("native picker visibility changes do not discard unsubmitted record filters", () => {
  const source = fs.readFileSync(new URL("../../src/daemon/codex-mobile-web.ts", import.meta.url), "utf8");
  expect(source).toContain('if (settingsTab !== "records") await Promise.all([loadTasks(false), loadSettings()]);');
});

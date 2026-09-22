import fs from "node:fs";
import { describe, expect, test } from "bun:test";
import { WeRelayDaemon } from "../../src/daemon/werelay-daemon.ts";
import { CODEX_MOBILE_JS } from "../../src/daemon/codex-mobile-web.ts";

function fn(name: string): string {
  const start = CODEX_MOBILE_JS.indexOf("  function " + name + "(");
  if (start < 0) throw new Error("Missing " + name);
  const end = CODEX_MOBILE_JS.indexOf("\n  function ", start + 1);
  return CODEX_MOBILE_JS.slice(start, end < 0 ? undefined : end);
}

describe("durable mobile send recovery", () => {
  test("permanent failure does not block later sends; transient retry retains order", () => {
    const needs = new Function(fn("pendingMessageNeedsServerAcceptance") + ";return pendingMessageNeedsServerAcceptance")();
    expect(needs({status: "failed", retryBlocked: true})).toBe(false);
    expect(needs({status: "retrying"})).toBe(true);
    expect(needs({status: "accepted"})).toBe(false);
  });
  test("pending snapshots retain identity, attachment reference and retry policy", () => {
    const sanitize = new Function(fn("sanitizePersistentImage") + fn("sanitizePersistentMessage") + ";return sanitizePersistentMessage")();
    const pending = sanitize({clientId: "m1", adapter: "deepseek", threadId: "local-new-1", imageStoreKey: "m1", imageCount: 2, retryAtMs: 123, retryBlocked: false});
    expect(pending).toMatchObject({adapter: "deepseek", threadId: "local-new-1", imageStoreKey: "m1", retryAtMs: 123, retryBlocked: false});
  });
  test("browser recovery has no six-attempt cutoff or repeated retry toast", () => {
    expect(CODEX_MOBILE_JS).not.toContain('pending.browserAttempts >= 6 ? "failed"');
    expect(CODEX_MOBILE_JS).not.toContain('showToast("连接暂时中断，正在自动重试")');
    expect(CODEX_MOBILE_JS).toContain('await restorePendingMessageImages(pending)');
    expect(CODEX_MOBILE_JS).toContain('await persistPendingMessageImages(pending)');
  });
  test("temporary tasks read only the draft catalog and never existing-task permissions", () => {
    const model = CODEX_MOBILE_JS.slice(CODEX_MOBILE_JS.indexOf("async function loadCurrentTaskModel"), CODEX_MOBILE_JS.indexOf("async function loadCurrentTaskPermission"));
    expect(model).toContain('draft ? "/api/new-task/model"');
    const permission = CODEX_MOBILE_JS.slice(CODEX_MOBILE_JS.indexOf("async function loadCurrentTaskPermission"), CODEX_MOBILE_JS.indexOf("async function selectCurrentTaskPermission"));
    expect(permission.indexOf("taskNeedsCreation(currentTask())")).toBeLessThan(permission.indexOf("await api("));
    expect(permission.slice(0,permission.indexOf("await api("))).toContain("return null;");
  });
});

test("retries more than six times silently with the same client id and original image payload", async () => {
  const start = CODEX_MOBILE_JS.indexOf("  function pendingMessagesForTarget(");
  const end = CODEX_MOBILE_JS.indexOf("\n  function beginOptimisticRunIfNeeded", start);
  const pending: any = {clientId: "durable-image", adapter: "deepseek", threadId: "thread-one", text: "带图消息", imageCount: 1, images: [{fileName: "a.png", mimeType: "image/png", dataBase64: "aGVsbG8="}], browserAttempts: 0};
  const state = {pendingMessages: [pending], authenticated: true, sending: false, currentThreadId: "thread-one", currentAdapter: "deepseek"};
  const bodies: any[] = [];
  const toasts: string[] = [];
  const noop = () => {};
  const run = new Function("state", "api", "navigator", "setTimeout", "showToast", "renderMessages", "updateHeader", "saveCurrentConversationSnapshot", "persistMobileCacheNow", "restorePendingMessageImages", "persistPendingMessageImages", "adapterApiPath", "renderQueuedMessages", "migrateTemporaryConversation", "loadMessages", CODEX_MOBILE_JS.slice(start, end) + ";return submitPendingMessage;")(
    state, async (_path: string, options: any) => { bodies.push(JSON.parse(options.body)); if (bodies.length <= 8) throw new Error("offline"); return {status: "accepted"}; },
    {onLine: true}, noop, (text: string) => toasts.push(text), noop, noop, noop, noop, async () => {}, async () => {}, (path: string) => path, noop, noop, noop,
  );
  for (let attempt = 0; attempt < 8; attempt++) {
    await run(pending);
    expect(pending.status).toBe("retrying");
    expect(state.sending).toBe(false);
    expect(pending.inFlight).toBe(false);
  }
  expect(toasts).toEqual([]);
  await run(pending);
  expect(pending.status).toBe("accepted");
  expect(bodies).toHaveLength(9);
  expect(new Set(bodies.map((body) => body.clientId)).size).toBe(1);
  expect(bodies.every((body) => body.images[0].dataBase64 === "aGVsbG8=")).toBe(true);
});

test("browser attachment restore hydrates bytes before sending and refuses a partial image message", async () => {
  const start = CODEX_MOBILE_JS.indexOf("  async function persistPendingMessageImages(");
  const end = CODEX_MOBILE_JS.indexOf("\n  function makePendingMessage", start);
  const saved = [{fileName: "a.png", mimeType: "image/png", dataBase64: "aGVsbG8=", previewUrl: "data:image/png;base64,aGVsbG8="}];
  const runtime = new Function("pendingImageStoreOperation", CODEX_MOBILE_JS.slice(start, end) + ";return {restorePendingMessageImages, persistPendingMessageImages};")(async () => saved);
  const pending: any = {clientId: "m1", imageStoreKey: "m1", imageCount: 1, images: []};
  await runtime.restorePendingMessageImages(pending);
  expect(pending.images).toEqual(saved);
  await runtime.persistPendingMessageImages(pending);
  await expect(runtime.persistPendingMessageImages({clientId: "m2", imageCount: 2, images: []})).rejects.toMatchObject({attachmentMissing: true});
});


test("a queued image is persisted before clearing the composer and before the send lock", () => {
  const start = CODEX_MOBILE_JS.indexOf('composerForm.addEventListener("submit"');
  const end = CODEX_MOBILE_JS.indexOf('authForm.addEventListener', start);
  const source = CODEX_MOBILE_JS.slice(start, end);
  expect(source.indexOf("await persistPendingMessageImages(pending)")).toBeGreaterThan(0);
  expect(source.indexOf("await persistPendingMessageImages(pending)")).toBeLessThan(source.indexOf("state.pendingMessages.push(pending)"));
  expect(source.indexOf("await persistPendingMessageImages(pending)")).toBeLessThan(source.indexOf('composerInput.value = ""'));
  expect(source.indexOf("await persistPendingMessageImages(pending)")).toBeLessThan(source.indexOf("void submitPendingMessage(pending)"));
});

test("server-acknowledged permanent failures never become browser resend loops", () => {
  const needs = new Function(fn("pendingMessageNeedsServerAcceptance") + ";return pendingMessageNeedsServerAcceptance")();
  expect(needs({status:"failed", serverAcknowledged:true})).toBe(false);
});


test("runtime question recovery retains one identity across read and answer", () => {
  const daemon = Object.create(WeRelayDaemon.prototype) as any;
  const runtimeRequest = {summary:"选择方案", questions:[{id:"q", question:"选哪个？"}]};
  const slot = {pendingUserInputs: [], runtime:{getState: () => ({sharedThreadId:"t1", pendingUserInput: runtimeRequest})}};
  const first = daemon.getMobilePendingQuestion(slot, "t1");
  const second = daemon.getMobilePendingQuestion(slot, "t1");
  expect(second).toBe(first);
  expect(slot.pendingUserInputs).toHaveLength(1);
  expect(first.createdAt).toBeTruthy();
  expect(daemon.mobileQuestionId(second)).toBe(daemon.mobileQuestionId(first));
  expect(daemon.getMobilePendingQuestion(slot, "other-task")).toBe(null);
});

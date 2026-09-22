import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MobileMessageOutbox } from "../../src/daemon/mobile-message-outbox.ts";
import { prepareMobileMessageRetry, shouldRetryMobileMessage } from "../../src/daemon/mobile-message-recovery.ts";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true}); });
function setup(turnId?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-receipt-test-")); dirs.push(dir);
  const stateFile = path.join(dir, "outbox.json");
  const outbox = new MobileMessageOutbox({stateFile, now: () => 15_000});
  outbox.accept({adapter: "codex", threadId: "task", clientId: "original-id", text: "修复消息", images: [], createdAtMs: 10_000});
  outbox.markSending("codex", "task", "original-id", 11_000);
  if (turnId) outbox.markSubmitted("codex", "task", "original-id", {turnId});
  outbox.markRetrying("codex", "task", "original-id", {error: "Codex 暂未确认收到这条消息", nextAttemptAtMs: 12_000});
  return {outbox, stateFile, entry: outbox.get("codex", "task", "original-id")!};
}
const received = {id: "native-user", role: "user" as const, text: "修复消息", createdAtMs: 11_500, turnId: "turn"};
test("a lost response is recovered from a native user message without waiting for an assistant", async () => {
  const {outbox, entry, stateFile} = setup(); let reads = 0;
  expect(await prepareMobileMessageRetry({outbox, entry, readMessages: async () => { reads++; return [received]; }})).toBe("received");
  expect(reads).toBe(1);
  expect(outbox.list("codex", "task")).toEqual([]);
  const restored = new MobileMessageOutbox({stateFile, now: () => 15_000});
  expect(restored.deliveredClientIds("codex", "task")).toEqual(["original-id"]);
  expect(restored.retry("codex", "task", "original-id")).toBe(false);
});
test("uncertain delivery retries receipt checks, not execution, and stops at the limit", async () => {
  const {outbox, entry} = setup();
  for (let attempts = 1; attempts <= 5; attempts++) {
    expect(await prepareMobileMessageRetry({outbox, entry: {...entry, attempts}, readMessages: async () => []})).toBe("check");
    expect(shouldRetryMobileMessage(entry.lastError!, attempts, 5)).toBe(attempts < 5);
  }
  expect(shouldRetryMobileMessage("ECONNREFUSED", 5, 5)).toBe(false);
  expect(shouldRetryMobileMessage("invalid input", 1, 5)).toBe(false);
});
test("known rejection retries sending; first attempts do not read history", async () => {
  const {outbox, entry} = setup();
  expect(await prepareMobileMessageRetry({outbox, entry: {...entry, lastError: "ECONNREFUSED", deliveryUncertain: false}, readMessages: async () => []})).toBe("send");
  expect(await prepareMobileMessageRetry({outbox, entry: {...entry, attempts: 0, deliveryUncertain: false}, readMessages: async () => {throw new Error("must not read");}})).toBe("send");
});
test("old messages, a different turn, missing timestamps and unreadable history never remove the failure", async () => {
  const {outbox, entry} = setup("new-turn");
  expect(await prepareMobileMessageRetry({outbox, entry, readMessages: async () => [received]})).toBe("check");
  for (const message of [{...received, createdAtMs: 1}, {...received, createdAtMs: undefined}]) {
    expect(await prepareMobileMessageRetry({outbox, entry: {...entry, turnId: undefined}, readMessages: async () => [message]})).toBe("check");
  }
  expect(await prepareMobileMessageRetry({outbox, entry, readMessages: async () => { throw new Error("offline"); }})).toBe("check");
  expect(outbox.list("codex", "task")).toHaveLength(1);
});
test("late receipts recover failed entries after restart, once per native user message", () => {
  const {outbox, stateFile} = setup();
  outbox.markFailed("codex", "task", "original-id", "超时");
  const restored = new MobileMessageOutbox({stateFile, now: () => 15_000});
  expect(restored.reconcileReceived("codex", "task", "original-id", [received])).toBe(true);
  restored.accept({adapter: "codex", threadId: "task", clientId: "different-id", text: "修复消息", images: [], createdAtMs: 10_000});
  restored.markFailed("codex", "task", "different-id", "超时");
  expect(restored.reconcileReceived("codex", "task", "different-id", [received])).toBe(false);
  expect(restored.list("codex", "task").map(x => x.clientId)).toEqual(["different-id"]);
});

test("a restart during verification and a manual retry cannot turn uncertain delivery into a second send", async () => {
  const {outbox, stateFile} = setup();
  outbox.markSending("codex", "task", "original-id", 13_000);
  const restored = new MobileMessageOutbox({stateFile, now: () => 15_000});
  restored.retry("codex", "task", "original-id");
  const entry = restored.get("codex", "task", "original-id")!;
  expect(entry.clientId).toBe("original-id");
  expect(await prepareMobileMessageRetry({outbox: restored, entry, readMessages: async () => []})).toBe("check");
  expect(await prepareMobileMessageRetry({outbox: restored, entry, readMessages: async () => [received]})).toBe("received");
});

test("native receipts cannot confirm an image message without its attachment", async () => {
  const {outbox} = setup();
  outbox.accept({adapter: "codex", threadId: "task", clientId: "with-image", text: "修复消息", images: [{path: "/tmp/request.png", fileName: "request.png", mimeType: "image/png"}], createdAtMs: 10_000});
  outbox.markFailed("codex", "task", "with-image", "超时");
  expect(outbox.reconcileReceived("codex", "task", "with-image", [received])).toBe(false);
});

test("receipt reads are bounded and cannot mutate the outbox after timeout", async () => {
  const {outbox, entry} = setup();
  let complete!: (messages: typeof received[]) => void;
  const slow = new Promise<typeof received[]>(resolve => { complete = resolve; });
  expect(await prepareMobileMessageRetry({outbox, entry, readMessages: () => slow, timeoutMs: 5})).toBe("check");
  complete([received]);
  await slow;
  expect(outbox.list("codex", "task")).toHaveLength(1);
});

test("a notification does not prevent a later original-task receipt from clearing the failed card", async () => {
  const {FailedMobileMessageSweep} = await import("../../src/daemon/failed-mobile-message-reconciliation.ts");
  const {outbox} = setup();
  outbox.markFailed("codex", "task", "original-id", "超时");
  outbox.markFailureNotified("codex", "task", "original-id", 14_000);
  const sweep = new FailedMobileMessageSweep();
  let available = false;
  const params = {adapter: "codex", outbox, listTasks: async () => { throw new Error("list offline"); }, readMessages: async () => available ? [received] : []};
  await sweep.run({...params, nowMs: 20_000});
  expect(outbox.list("codex", "task")).toHaveLength(1);
  available = true;
  await sweep.run({...params, nowMs: 81_000});
  expect(outbox.list("codex", "task")).toEqual([]);
  expect(outbox.pendingFailureNotifications()).toEqual([]);
});

test("retry preserves known native turn evidence while acceptance is uncertain", async () => {
  const {outbox, stateFile} = setup("known-turn");
  outbox.retry("codex", "task", "original-id");
  const restored = new MobileMessageOutbox({stateFile, now: () => 15_000});
  const entry = restored.get("codex", "task", "original-id")!;
  expect(entry.turnId).toBe("known-turn");
  expect(await prepareMobileMessageRetry({outbox: restored, entry, readMessages: async () => [received]})).toBe("check");
});

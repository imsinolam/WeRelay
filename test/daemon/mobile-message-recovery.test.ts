import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MobileMessageOutbox } from "../../src/daemon/mobile-message-outbox.ts";
import {
  mobileMessageReceiptObservationDeadlineMs,
  MOBILE_MESSAGE_RECEIPT_OBSERVATION_WINDOW_MS,
  prepareMobileMessageRetry,
  shouldRetryMobileMessage,
} from "../../src/daemon/mobile-message-recovery.ts";
import { WeRelayDaemon } from "../../src/daemon/werelay-daemon.ts";
import { FailedMobileMessageSweep } from "../../src/daemon/failed-mobile-message-reconciliation.ts";
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
test("未确认送达不进入发送重试预算，只能检查回执", async () => {
  const {outbox, entry} = setup();
  for (let attempts = 1; attempts <= 5; attempts++) {
    expect(await prepareMobileMessageRetry({outbox, entry: {...entry, attempts}, readMessages: async () => []})).toBe("check");
    expect(shouldRetryMobileMessage(entry.lastError!, attempts, 5)).toBe(false);
  }
  expect(shouldRetryMobileMessage("ECONNREFUSED", 5, 5)).toBe(false);
  expect(shouldRetryMobileMessage("invalid input", 1, 5)).toBe(false);
});
test("known rejection retries sending; first attempts do not read history", async () => {
  const {outbox, entry} = setup();
  expect(await prepareMobileMessageRetry({outbox, entry: {...entry, lastError: "ECONNREFUSED", deliveryUncertain: false}, readMessages: async () => []})).toBe("send");
  expect(await prepareMobileMessageRetry({outbox, entry: {...entry, attempts: 0, deliveryUncertain: false}, readMessages: async () => {throw new Error("must not read");}})).toBe("send");
});
test("an independent Pi owner requires a manual reload and fails without futile retries", () => {
  expect(shouldRetryMobileMessage(
    "当前项目已有未接入的 Pi 窗口；请在原窗口执行 /reload 加载 WeRelay 扩展。未新建替代任务。",
    1,
    5,
  )).toBe(false);
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

function daemonHarness(outbox: MobileMessageOutbox, send: () => Promise<never>) {
  const daemon = Object.create(WeRelayDaemon.prototype) as any;
  const reads: Array<{threadId: string; options: unknown}> = [];
  let messages: typeof received[] = [];
  const notices: string[] = [];
  daemon.mobileMessageOutbox = outbox;
  daemon.slots = new Map([["codex", {runtime: {
    getSessionMessagePage: async (threadId: string, options: unknown) => {
      reads.push({threadId, options});
      return {messages};
    },
  }}]]);
  daemon.dispatchPersistedMobileMessage = send;
  const sideEffects = {ensureSlot: 0, createMobileTask: 0};
  daemon.ensureSlot = async () => { sideEffects.ensureSlot++; throw new Error("只读检查不能启动终端"); };
  daemon.createMobileTask = async () => { sideEffects.createMobileTask++; throw new Error("只读检查不能新建任务"); };
  daemon.reconcileFailedMobileMessages = async () => {};
  daemon.listMobileTasks = async () => [{threadId: "task", title: "回归任务"}];
  daemon.queueWechatMessage = async (_user: string, notice: string) => { notices.push(notice); return true; };
  daemon.authorizedUserId = "test-recipient";
  daemon.scheduleMobileMessageOutboxDrain = () => {};
  return {daemon, reads, notices, sideEffects, setMessages: (value: typeof received[]) => { messages = value; }};
}

function acceptedOutbox(now: () => number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-observation-test-"));
  dirs.push(dir);
  const stateFile = path.join(dir, "outbox.json");
  const outbox = new MobileMessageOutbox({stateFile, now});
  outbox.accept({adapter: "codex", threadId: "task", clientId: "test-client", text: "合成回归消息", images: []});
  return {outbox, stateFile};
}

test("daemon 在首次发送后观察满180秒，耗尽转未确认并通知，始终只发送一次", async () => {
  let now = 1_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const state = acceptedOutbox(() => now);
    const {stateFile} = state;
    let outbox = state.outbox;
    let sends = 0;
    const harness = daemonHarness(outbox, async () => { sends++; now += 30_000; throw new Error("send timeout"); });
    const {daemon, reads, notices} = harness;
    const slot = daemon.slots.get("codex");
    await daemon.dispatchMobileMessageOutboxEntry(outbox.get("codex", "task", "test-client"));
    expect(outbox.get("codex", "task", "test-client")).toMatchObject({status: "retrying", attempts: 1, firstAttemptAtMs: 1_000_000, lastAttemptAtMs: 1_000_000});
    expect(reads).toHaveLength(0);
    const deadline = 1_000_000 + MOBILE_MESSAGE_RECEIPT_OBSERVATION_WINDOW_MS;
    while (outbox.get("codex", "task", "test-client")?.status === "retrying") {
      const entry = outbox.get("codex", "task", "test-client")!;
      now = entry.nextAttemptAtMs;
      if (now === 1_080_000) {
        outbox = new MobileMessageOutbox({stateFile, now: () => now});
        daemon.mobileMessageOutbox = outbox;
      }
      if (now === 1_090_000) daemon.slots.clear();
      if (now === 1_120_000) daemon.slots.set("codex", slot);
      await daemon.dispatchMobileMessageOutboxEntry(outbox.get("codex", "task", "test-client"));
      expect(outbox.get("codex", "task", "test-client")?.attempts).toBe(1);
      expect(mobileMessageReceiptObservationDeadlineMs(outbox.get("codex", "task", "test-client")!)).toBe(deadline);
      if (now < deadline) {
        expect(outbox.get("codex", "task", "test-client")?.status).toBe("retrying");
        expect(await daemon.deliverMobileMessageFailureNotifications()).toBe(true);
        expect(notices).toEqual([]);
      }
      expect(now).toBeLessThanOrEqual(deadline);
    }
    expect(now).toBe(deadline);
    expect(reads.length).toBeGreaterThan(5);
    expect(reads.every(read => read.threadId === "task" && JSON.stringify(read.options) === JSON.stringify({limit: 100, lightweight: true, historyOnly: true}))).toBe(true);
    expect(outbox.get("codex", "task", "test-client")).toMatchObject({status: "unconfirmed", deliveryUncertain: true, text: "合成回归消息", attempts: 1});
    expect(outbox.failedEntries()).toEqual([]);
    expect(outbox.readyEntries(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(await daemon.deliverMobileMessageFailureNotifications()).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("接收状态未确认");
    expect(notices[0]).toContain("消息已保留，请先查看原任务，避免重复发送。");
    expect(notices[0]).not.toMatch(/多次提交仍失败|复制后重试/);
    daemon.mobileMessageOutbox = new MobileMessageOutbox({stateFile, now: () => now});
    expect(await daemon.deliverMobileMessageFailureNotifications()).toBe(true);
    expect(notices).toHaveLength(1);
    daemon.acceptMobileMessage("task", {clientId: "test-client", retry: true, text: "", images: []}, "codex");
    await daemon.dispatchMobileMessageOutboxEntry(daemon.mobileMessageOutbox.get("codex", "task", "test-client"));
    expect(daemon.mobileMessageOutbox.get("codex", "task", "test-client")).toMatchObject({status: "unconfirmed", attempts: 1});
    expect(await daemon.deliverMobileMessageFailureNotifications()).toBe(true);
    expect(notices).toHaveLength(1);
    harness.setMessages([{...received, text: "合成回归消息", createdAtMs: 1_000_001}]);
    daemon.acceptMobileMessage("task", {clientId: "test-client", retry: true, text: "", images: []}, "codex");
    await daemon.dispatchMobileMessageOutboxEntry(daemon.mobileMessageOutbox.get("codex", "task", "test-client"));
    expect(daemon.mobileMessageOutbox.get("codex", "task", "test-client")?.status).toBe("delivered");
    expect(harness.sideEffects).toEqual({ensureSlot: 0, createMobileTask: 0});
    expect(sends).toBe(1);
  } finally { clock.mockRestore(); }
});

test("桌面hydrate120秒后出现原生回执即可恢复送达，无重发或失败通知", async () => {
  let now = 2_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const {outbox} = acceptedOutbox(() => now);
    let sends = 0;
    const {daemon, notices, setMessages} = daemonHarness(outbox, async () => { sends++; now += 30_000; throw new Error("send timeout"); });
    await daemon.dispatchMobileMessageOutboxEntry(outbox.get("codex", "task", "test-client"));
    while (now < 2_130_000) {
      now = outbox.get("codex", "task", "test-client")!.nextAttemptAtMs;
      if (now >= 2_130_000) setMessages([{...received, text: "合成回归消息", createdAtMs: 2_000_001}]);
      await daemon.dispatchMobileMessageOutboxEntry(outbox.get("codex", "task", "test-client"));
    }
    expect(outbox.get("codex", "task", "test-client")).toMatchObject({status: "delivered", attempts: 1});
    expect(await daemon.deliverMobileMessageFailureNotifications()).toBe(true);
    expect(notices).toEqual([]);
    expect(sends).toBe(1);
  } finally { clock.mockRestore(); }
});

test("确定拒绝保留5次发送预算和原失败通知，永久拒绝不重试", async () => {
  let now = 3_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    for (const [error, expectedSends] of [["ECONNREFUSED", 5], ["invalid input", 1]] as const) {
      const {outbox} = acceptedOutbox(() => now);
      let sends = 0;
      const {daemon, notices} = daemonHarness(outbox, async () => { sends++; throw new Error(error); });
      do {
        const entry = outbox.get("codex", "task", "test-client")!;
        now = Math.max(now, entry.nextAttemptAtMs);
        await daemon.dispatchMobileMessageOutboxEntry(entry);
      } while (outbox.get("codex", "task", "test-client")?.status === "retrying");
      expect(sends).toBe(expectedSends);
      expect(outbox.get("codex", "task", "test-client")).toMatchObject({status: "failed", attempts: expectedSends});
      expect(await daemon.deliverMobileMessageFailureNotifications()).toBe(true);
      expect(notices[0]).toContain("网页消息多次提交仍失败");
      expect(notices[0]).toContain("消息已保留在网页任务台，可复制后重试。");
    }
  } finally { clock.mockRestore(); }
});

test("未确认通知失败后可补发，旧版failed未确认条目也不诱导重发", async () => {
  const {outbox} = acceptedOutbox(() => 1_000_000);
  outbox.markUnconfirmed("codex", "task", "test-client", "接收超时");
  const {daemon, notices} = daemonHarness(outbox, async () => { throw new Error("不得发送"); });
  daemon.queueWechatMessage = async () => false;
  expect(await daemon.deliverMobileMessageFailureNotifications()).toBe(false);
  expect(outbox.pendingFailureNotifications()).toHaveLength(1);
  daemon.queueWechatMessage = async (_user: string, notice: string) => { notices.push(notice); return true; };
  expect(await daemon.deliverMobileMessageFailureNotifications()).toBe(true);
  expect(outbox.pendingFailureNotifications()).toEqual([]);
  outbox.markFailed("codex", "task", "test-client", "接收超时");
  expect(await daemon.deliverMobileMessageFailureNotifications()).toBe(true);
  expect(notices).toHaveLength(2);
  expect(notices.every(notice => notice.includes("接收状态未确认") && !/多次提交仍失败|复制后重试/.test(notice))).toBe(true);
});

test("未确认通知成功后daemon每分钟只读恢复迟到回执，无需网页或手动操作", async () => {
  let now = 5_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const {outbox, stateFile} = acceptedOutbox(() => now);
    outbox.markSending("codex", "task", "test-client", now);
    outbox.markUnconfirmed("codex", "task", "test-client", "接收超时");
    let sends = 0;
    const {daemon, reads, notices, sideEffects, setMessages} = daemonHarness(outbox, async () => { sends++; throw new Error("不得发送"); });
    delete daemon.reconcileFailedMobileMessages;
    daemon.failedMobileMessageSweep = new FailedMobileMessageSweep();
    const scheduled: number[] = [];
    daemon.scheduleMobileMessageOutboxDrain = (delay: number) => { scheduled.push(delay); };
    await daemon.drainMobileMessageOutbox();
    expect(notices).toHaveLength(1);
    expect(outbox.pendingFailureNotifications()).toEqual([]);
    expect(outbox.failedEntries()).toEqual([]);
    expect(outbox.readyEntries(Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(scheduled.splice(0)).toEqual([60_000]);
    daemon.mobileMessageOutbox = new MobileMessageOutbox({stateFile, now: () => now});
    const readsAfterNotice = reads.length;
    now += 59_999;
    setMessages([{...received, text: "合成回归消息", createdAtMs: 5_000_001}]);
    await daemon.drainMobileMessageOutbox();
    expect(reads).toHaveLength(readsAfterNotice);
    expect(daemon.mobileMessageOutbox.get("codex", "task", "test-client")?.status).toBe("unconfirmed");
    scheduled.splice(0);
    now += 1;
    await daemon.drainMobileMessageOutbox();
    expect(reads).toHaveLength(readsAfterNotice + 1);
    expect(daemon.mobileMessageOutbox.get("codex", "task", "test-client")).toMatchObject({status: "delivered", attempts: 1});
    expect(new MobileMessageOutbox({stateFile, now: () => now}).deliveredClientIds("codex", "task")).toEqual(["test-client"]);
    expect(scheduled).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(sends).toBe(0);
    expect(sideEffects).toEqual({ensureSlot: 0, createMobileTask: 0});
    expect(reads.every(read => JSON.stringify(read.options) === JSON.stringify({limit: 100, lightweight: true, historyOnly: true}))).toBe(true);
  } finally { clock.mockRestore(); }
});

test("其他消息的一小时确认期限不能推迟未确认消息的分钟恢复，七天后停止扫描", async () => {
  let now = 6_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const {outbox} = acceptedOutbox(() => now);
    outbox.markUnconfirmed("codex", "task", "test-client", "接收超时");
    outbox.markFailureNotified("codex", "task", "test-client", now);
    outbox.accept({adapter: "codex", threadId: "other-task", clientId: "test-submitted", text: "合成等待确认", images: []});
    outbox.markSubmitted("codex", "other-task", "test-submitted", {submittedAtMs: now});
    const {daemon, reads} = daemonHarness(outbox, async () => { throw new Error("不得发送"); });
    delete daemon.reconcileFailedMobileMessages;
    daemon.failedMobileMessageSweep = new FailedMobileMessageSweep();
    const scheduled: number[] = [];
    daemon.scheduleMobileMessageOutboxDrain = (delay: number) => { scheduled.push(delay); };
    await daemon.drainMobileMessageOutbox();
    expect(scheduled.splice(0)).toEqual([60_000]);
    outbox.cancelByClientId("codex", "other-task", "test-submitted");
    now += 7 * 24 * 60 * 60_000 + 1;
    const previousReads = reads.length;
    await daemon.drainMobileMessageOutbox();
    expect(reads).toHaveLength(previousReads);
    expect(scheduled).toEqual([]);
    expect(outbox.get("codex", "task", "test-client")).toMatchObject({status: "unconfirmed", text: "合成回归消息"});
    expect(outbox.readyEntries(Number.MAX_SAFE_INTEGER)).toEqual([]);
  } finally { clock.mockRestore(); }
});

test("旧版未确认条目的观察期限有界，检查不会消耗或刷新发送预算", async () => {
  let now = 4_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const {stateFile} = setup();
    const legacy = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    delete legacy.entries[0].firstAttemptAtMs;
    legacy.entries[0].lastAttemptAtMs = now - 60_000;
    legacy.entries[0].attempts = 5;
    fs.writeFileSync(stateFile, JSON.stringify(legacy));
    const restored = new MobileMessageOutbox({stateFile, now: () => now});
    const {daemon} = daemonHarness(restored, async () => { throw new Error("不得发送"); });
    const deadline = now + 120_000;
    await daemon.dispatchMobileMessageOutboxEntry(restored.get("codex", "task", "original-id"));
    expect(restored.get("codex", "task", "original-id")).toMatchObject({status: "retrying", attempts: 5, lastAttemptAtMs: now - 60_000});
    now = deadline;
    await daemon.dispatchMobileMessageOutboxEntry(restored.get("codex", "task", "original-id"));
    expect(restored.get("codex", "task", "original-id")?.status).toBe("unconfirmed");
    expect(mobileMessageReceiptObservationDeadlineMs(restored.get("codex", "task", "original-id")!)).toBe(deadline);
    expect(new MobileMessageOutbox({stateFile, now: () => now}).get("codex", "task", "original-id")?.status).toBe("unconfirmed");
  } finally { clock.mockRestore(); }
});

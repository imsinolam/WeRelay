import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FailedMobileMessageSweep } from "../../src/daemon/failed-mobile-message-reconciliation.ts";

import {
  MobileMessageOutbox,
  computeMobileMessageRetryDelayMs,
  formatMobileMessageFailureNotice,
} from "../../src/daemon/mobile-message-outbox.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createStateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deskrelay-mobile-outbox-"));
  tempDirs.push(dir);
  return path.join(dir, "mobile-message-outbox.json");
}

describe("MobileMessageOutbox", () => {
  test("retains missing queues without resending, persists their state, and cleans up on native evidence", () => {
    const stateFile = createStateFile();
    let outbox = new MobileMessageOutbox({ stateFile });
    outbox.accept({ clientId: "queued", adapter: "codex", threadId: "thread", text: "排队内容", images: [], createdAtMs: 10_000 });
    outbox.markQueued("codex", "thread", "queued", { queuedMessageId: "native", submittedAtMs: 11_000 });
    const revision = outbox.contentRevision("codex", "thread");
    outbox.reconcile("codex", "thread", { messages: [] });
    expect(outbox.list("codex", "thread")[0]?.queueMissing).toBeUndefined();
    outbox.reconcile("codex", "thread", { messages: [], queuedMessages: [] });
    expect(outbox.contentRevision("codex", "thread")).not.toBe(revision);
    outbox = new MobileMessageOutbox({ stateFile });
    expect(outbox.list("codex", "thread")[0]).toMatchObject({ status: "queued", queueMissing: true, text: "排队内容" });
    expect(outbox.readyEntries()).toEqual([]);
    outbox.reconcile("codex", "thread", { messages: [], queuedMessages: [{ id: "native", text: "排队内容", imageCount: 0 }] });
    expect(outbox.list("codex", "thread")[0]?.queueMissing).toBe(false);
    outbox.reconcile("codex", "thread", { messages: [{ role: "user", text: "排队内容" }], queuedMessages: [] });
    expect(outbox.list("codex", "thread")).toHaveLength(1);
    outbox.reconcile("codex", "thread", { messages: [{ id: "real", role: "user", text: "排队内容", createdAtMs: 12_000 }], queuedMessages: [] });
    expect(outbox.list("codex", "thread")).toEqual([]);
    expect(new MobileMessageOutbox({ stateFile }).deliveredClientIds("codex", "thread")).toEqual(["queued"]);
  });

  test("does not reuse a delivered receipt for a later identical queued input across polls", () => {
    const stateFile = createStateFile();
    let outbox = new MobileMessageOutbox({ stateFile });
    for (const clientId of ["first", "second"]) {
      outbox.accept({ clientId, adapter: "codex", threadId: "thread", text: "继续", images: [], createdAtMs: 10_000 });
      outbox.markQueued("codex", "thread", clientId, { queuedMessageId: clientId, submittedAtMs: 10_100 });
    }
    const messages = [{ id: "receipt", role: "user" as const, text: "继续", createdAtMs: 11_000 }];
    outbox.reconcile("codex", "thread", { messages, queuedMessages: [] });
    outbox = new MobileMessageOutbox({ stateFile });
    outbox.reconcile("codex", "thread", { messages, queuedMessages: [] });
    expect(outbox.list("codex", "thread").map(entry => entry.clientId)).toEqual(["second"]);
  });

  test("confirmed queue edits and deletions persist without resurrecting an old send", () => {
    const stateFile = createStateFile();
    let outbox = new MobileMessageOutbox({ stateFile });
    const input = { clientId: "client", adapter: "codex", threadId: "thread", text: "原文", images: [], createdAtMs: 10_000 };
    outbox.accept(input);
    outbox.markQueued("codex", "thread", "client", { queuedMessageId: "native" });
    outbox.updateQueuedEntry("claude", "thread", "native", "错误终端");
    expect(outbox.get("codex", "thread", "client")?.text).toBe("原文");
    outbox.updateQueuedEntry("codex", "thread", "native", "编辑后的完整内容");
    outbox = new MobileMessageOutbox({ stateFile });
    expect(outbox.get("codex", "thread", "client")?.text).toBe("编辑后的完整内容");
    outbox.updateQueuedEntry("codex", "thread", "native", null);
    outbox = new MobileMessageOutbox({ stateFile });
    expect(outbox.accept(input)).toMatchObject({ duplicate: true, entry: { status: "cancelled" } });
    expect(outbox.retry("codex", "thread", "client")).toBe(false);
    expect(outbox.readyEntries()).toEqual([]);
    expect(outbox.deliveredClientIds("codex", "thread")).toEqual([]);
  });

  test("expires only settled tombstones, never unresolved queue content", () => {
    const stateFile = createStateFile();
    let now = 10_000;
    let outbox = new MobileMessageOutbox({ stateFile, now: () => now });
    for (const clientId of ["cancelled", "unresolved"]) {
      outbox.accept({ clientId, adapter: "codex", threadId: "thread", text: "保留请求", images: [], createdAtMs: now });
      outbox.markQueued("codex", "thread", clientId, { queuedMessageId: clientId });
    }
    outbox.updateQueuedEntry("codex", "thread", "cancelled", null);
    now += 8 * 24 * 60 * 60_000;
    outbox = new MobileMessageOutbox({ stateFile, now: () => now });
    expect(outbox.get("codex", "thread", "cancelled")).toBeNull();
    expect(outbox.get("codex", "thread", "unresolved")?.text).toBe("保留请求");
  });

  test("returns durable delivered ids scoped to the adapter and task, and changes the content revision", () => {
    const stateFile = createStateFile();
    const outbox = new MobileMessageOutbox({stateFile});
    outbox.accept({clientId: "receipt", adapter: "codex", threadId: "thread", text: "请求", images: [], createdAtMs: 1});
    const before = outbox.contentRevision("codex", "thread");
    outbox.markSubmitted("codex", "thread", "receipt", {turnId: "turn", submittedAtMs: 2});
    outbox.reconcile("codex", "thread", {messages: [{role: "user", text: "请求", turnId: "turn"}], queuedMessages: []});
    expect(outbox.contentRevision("codex", "thread")).not.toBe(before);
    const restored = new MobileMessageOutbox({stateFile});
    expect(restored.deliveredClientIds("codex", "thread")).toEqual(["receipt"]);
    expect(restored.list("codex", "thread")).toEqual([]);
    expect(restored.deliveredClientIds("claude", "thread")).toEqual([]);
    expect(restored.deliveredClientIds("codex", "other")).toEqual([]);
    expect(restored.contentRevision("codex", "thread")).toBe(outbox.contentRevision("codex", "thread"));
  });

  test("scans only matching projects in the background, throttles reads and preserves offline failures", async () => {
    const outbox = new MobileMessageOutbox({stateFile: createStateFile()});
    const text = "请修复网页任务台中的消息重复显示问题";
    outbox.accept({clientId: "failed-scan", adapter: "codex", threadId: "source", text, images: [], createdAtMs: 10_000});
    outbox.markFailed("codex", "source", "failed-scan", "连接超时");
    const sweep = new FailedMobileMessageSweep();
    const reads: string[] = [];
    let offline = true;
    const params = {
      adapter: "codex", outbox, nowMs: 20_000,
      listTasks: async () => [{threadId: "source", projectId: "project"}, {threadId: "actual", projectId: "project"}, {threadId: "unrelated", projectId: "other"}],
      readMessages: async (threadId: string) => {
        reads.push(threadId);
        if (offline) throw new Error("offline");
        return threadId === "actual" ? [{role: "user" as const, text, createdAtMs: 11_000, turnId: "turn"}, {role: "assistant" as const, text: "开始处理", turnId: "turn"}] : [];
      },
    };
    await Promise.all([sweep.run(params), sweep.run(params)]);
    expect(reads.sort()).toEqual(["actual", "source"]);
    expect(outbox.failedEntries()).toHaveLength(1);
    await sweep.run({...params, nowMs: 21_000});
    expect(reads).toHaveLength(2);
    offline = false;
    await sweep.run({...params, nowMs: 81_000});
    expect(outbox.failedEntries()).toHaveLength(0);
    expect(outbox.pendingFailureNotifications()).toHaveLength(0);
  });

  test("persists automatic recovery of failed records and suppresses stale failures and retries", () => {
    const stateFile = createStateFile();
    const outbox = new MobileMessageOutbox({ stateFile });
    const text = "请修复网页任务台中的消息重复显示问题";
    outbox.accept({clientId: "failed", adapter: "codex", threadId: "source", text, images: [], createdAtMs: 10_000});
    outbox.markFailed("codex", "source", "failed", "连接超时");
    const tasks = [{threadId: "source", projectId: "project"}, {threadId: "actual", projectId: "project"}];
    const messages = [{role: "user" as const, text: "请检查以下问题\n" + text, turnId: "turn", createdAtMs: 11_000},
      {role: "assistant" as const, text: "已开始检查", turnId: "turn"}];
    expect(outbox.reconcileFailedExecution("claude", tasks[1]!, tasks, messages)).toBe(0);
    expect(outbox.reconcileFailedExecution("codex", tasks[1]!, tasks, messages)).toBe(1);
    const restored = new MobileMessageOutbox({stateFile});
    expect(restored.list("codex", "source")).toEqual([]);
    expect(restored.pendingFailureNotifications()).toEqual([]);
    expect(restored.retry("codex", "source", "failed")).toBe(false);
    expect(restored.readyEntries()).toEqual([]);
  });

  test("persists accepted messages and deduplicates browser retries by adapter, task, and client id", () => {
    const stateFile = createStateFile();
    const outbox = new MobileMessageOutbox({ stateFile });

    const first = outbox.accept({
      clientId: "mobile-1",
      adapter: "codex",
      threadId: "thread-1",
      text: "请继续处理",
      images: [],
      createdAtMs: 1_800_000_000_000,
    });
    const duplicate = outbox.accept({
      clientId: "mobile-1",
      adapter: "codex",
      threadId: "thread-1",
      text: "请继续处理",
      images: [],
      createdAtMs: 1_800_000_000_999,
    });

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(outbox.list("codex", "thread-1")).toHaveLength(1);

    const restored = new MobileMessageOutbox({ stateFile });
    expect(restored.list("codex", "thread-1")).toEqual([
      expect.objectContaining({
        clientId: "mobile-1",
        status: "accepted",
        text: "请继续处理",
        createdAtMs: 1_800_000_000_000,
      }),
    ]);
  });

  test("keeps later messages for the same task behind the first retrying message", () => {
    const outbox = new MobileMessageOutbox({ stateFile: createStateFile() });
    outbox.accept({
      clientId: "mobile-first",
      adapter: "codex",
      threadId: "thread-1",
      text: "第一条",
      images: [],
      createdAtMs: 10,
    });
    outbox.accept({
      clientId: "mobile-second",
      adapter: "codex",
      threadId: "thread-1",
      text: "第二条",
      images: [],
      createdAtMs: 20,
    });
    outbox.accept({
      clientId: "mobile-other",
      adapter: "claude",
      threadId: "thread-2",
      text: "另一任务",
      images: [],
      createdAtMs: 30,
    });

    expect(outbox.readyEntries(100).map((entry) => entry.clientId)).toEqual([
      "mobile-first",
      "mobile-other",
    ]);
    outbox.markRetrying("codex", "thread-1", "mobile-first", {
      error: "连接中断",
      nextAttemptAtMs: 1_000,
    });
    expect(outbox.readyEntries(500).map((entry) => entry.clientId)).toEqual([
      "mobile-other",
    ]);
    expect(outbox.readyEntries(1_000).map((entry) => entry.clientId)).toEqual([
      "mobile-first",
      "mobile-other",
    ]);
    outbox.markSubmitted("claude", "thread-2", "mobile-other", {});
    expect(outbox.nextAttemptAtMs()).toBe(1_000);
  });

  test("moves every accepted message from one temporary task to the same real task", () => {
    const outbox = new MobileMessageOutbox({ stateFile: createStateFile() });
    outbox.accept({
      clientId: "mobile-first",
      adapter: "codex",
      threadId: "local-new-1",
      text: "第一条",
      images: [],
      createdAtMs: 10,
    });
    outbox.accept({
      clientId: "mobile-second",
      adapter: "codex",
      threadId: "local-new-1",
      text: "第二条",
      images: [],
      createdAtMs: 20,
    });

    expect(outbox.resolveThread(
      "codex",
      "local-new-1",
      "mobile-first",
      "thread-real",
    )).toBe(true);

    expect(outbox.list("codex", "local-new-1")).toEqual([
      expect.objectContaining({
        clientId: "mobile-first",
        threadId: "thread-real",
        originalThreadId: "local-new-1",
      }),
      expect.objectContaining({
        clientId: "mobile-second",
        threadId: "thread-real",
        originalThreadId: "local-new-1",
      }),
    ]);
    expect(outbox.resolveRequestedThread("codex", "local-new-1")).toBe("thread-real");

    outbox.accept({
      clientId: "mobile-third",
      adapter: "codex",
      threadId: "thread-real",
      originalThreadId: "local-new-1",
      text: "第三条",
      images: [],
      createdAtMs: 30,
    });
    expect(outbox.list("codex", "local-new-1").map((entry) => entry.clientId)).toEqual([
      "mobile-first",
      "mobile-second",
      "mobile-third",
    ]);
  });

  test("never prunes undelivered messages when the retained history limit is exceeded", () => {
    const stateFile = createStateFile();
    const outbox = new MobileMessageOutbox({ stateFile });
    for (let index = 0; index < 505; index += 1) {
      outbox.accept({
        clientId: `mobile-${index}`,
        adapter: "codex",
        threadId: "thread-1",
        text: `消息 ${index}`,
        images: [],
        createdAtMs: index,
      });
    }

    const restored = new MobileMessageOutbox({ stateFile });
    expect(restored.list("codex", "thread-1")).toHaveLength(505);
    expect(restored.list("codex", "thread-1")[0]?.clientId).toBe("mobile-0");
  });

  test("restores in-flight work after restart and preserves final failures for notification and manual retry", () => {
    const stateFile = createStateFile();
    const outbox = new MobileMessageOutbox({ stateFile });
    outbox.accept({
      clientId: "mobile-1",
      adapter: "codex",
      threadId: "thread-1",
      text: "不要丢失",
      images: [],
      createdAtMs: 10,
    });
    outbox.markSending("codex", "thread-1", "mobile-1", 20);

    const restored = new MobileMessageOutbox({ stateFile });
    expect(restored.readyEntries(21)).toEqual([
      expect.objectContaining({ clientId: "mobile-1", status: "retrying" }),
    ]);

    restored.markFailed("codex", "thread-1", "mobile-1", "多次提交仍失败");
    expect(restored.list("codex", "thread-1")).toEqual([
      expect.objectContaining({
        clientId: "mobile-1",
        status: "failed",
        lastError: "多次提交仍失败",
      }),
    ]);
    expect(restored.list("codex", "thread-1")[0]?.failureNotifiedAt).toBeUndefined();
    expect(restored.pendingFailureNotifications()).toHaveLength(1);

    restored.markFailureNotified("codex", "thread-1", "mobile-1", 50);
    expect(restored.pendingFailureNotifications()).toHaveLength(0);

    expect(restored.retry("codex", "thread-1", "mobile-1", 60)).toBe(true);
    expect(restored.readyEntries(60)).toEqual([
      expect.objectContaining({
        clientId: "mobile-1",
        status: "accepted",
        attempts: 0,
      }),
    ]);
  });

  test("does not mistake an older identical transcript message for the newly submitted message", () => {
    const outbox = new MobileMessageOutbox({ stateFile: createStateFile() });
    outbox.accept({
      clientId: "mobile-repeat",
      adapter: "codex",
      threadId: "thread-1",
      text: "相同内容",
      images: [],
      createdAtMs: 9_000,
    });
    outbox.markSending("codex", "thread-1", "mobile-repeat", 10_000);
    outbox.markSubmitted("codex", "thread-1", "mobile-repeat", {
      submittedAtMs: 10_100,
    });

    outbox.reconcile("codex", "thread-1", {
      messages: [{ role: "user", text: "相同内容", createdAtMs: 5_000 }],
      queuedMessages: [],
      nowMs: 10_200,
    });
    expect(outbox.list("codex", "thread-1")).toEqual([
      expect.objectContaining({ clientId: "mobile-repeat", status: "submitted" }),
    ]);

    outbox.reconcile("codex", "thread-1", {
      messages: [{ role: "user", text: "相同内容", createdAtMs: 10_050 }],
      queuedMessages: [],
      nowMs: 10_300,
    });
    expect(outbox.list("codex", "thread-1")).toEqual([]);
  });

  test("reconciles submitted and queued records without reordering repeated user messages", () => {
    const outbox = new MobileMessageOutbox({ stateFile: createStateFile() });
    outbox.accept({
      clientId: "mobile-1",
      adapter: "codex",
      threadId: "thread-1",
      text: "相同内容",
      images: [],
      createdAtMs: 10,
    });
    outbox.markSubmitted("codex", "thread-1", "mobile-1", {
      turnId: "turn-1",
      submittedAtMs: 20,
    });
    outbox.accept({
      clientId: "mobile-2",
      adapter: "codex",
      threadId: "thread-1",
      text: "相同内容",
      images: [],
      createdAtMs: 30,
    });
    outbox.markQueued("codex", "thread-1", "mobile-2", {
      queuedMessageId: "queued-2",
      queuePosition: 1,
      submittedAtMs: 40,
    });

    outbox.reconcile("codex", "thread-1", {
      messages: [{ role: "user", text: "相同内容", turnId: "turn-1" }],
      queuedMessages: [{ id: "queued-2", text: "相同内容", imageCount: 0 }],
      nowMs: 50,
    });

    expect(outbox.list("codex", "thread-1")).toEqual([
      expect.objectContaining({ clientId: "mobile-2", status: "queued" }),
    ]);
  });
});

describe("mobile outbox helpers", () => {
  test("uses bounded exponential retry delays", () => {
    expect(computeMobileMessageRetryDelayMs(1)).toBe(1_000);
    expect(computeMobileMessageRetryDelayMs(2)).toBe(2_000);
    expect(computeMobileMessageRetryDelayMs(3)).toBe(4_000);
    expect(computeMobileMessageRetryDelayMs(20)).toBe(30_000);
  });

  test("formats a Chinese ClawBot failure notice with a recoverable task link", () => {
    expect(formatMobileMessageFailureNotice({
      title: "修复移动网页",
      text: "请继续处理发送顺序",
      error: "电脑端暂时未连接",
      url: "https://relay.example/t/task",
    })).toBe(
      "[修复移动网页] 网页消息多次提交仍失败\n" +
      "消息已保留在网页任务台，可复制后重试。\n" +
      "内容：请继续处理发送顺序\n" +
      "原因：电脑端暂时未连接\n" +
      "打开任务：https://relay.example/t/task",
    );
  });
});


test("classifies permanent image failures separately from safe reconnects and uncertain delivery", async () => {
  const {classifyMobileSendFailure} = await import("../../src/daemon/mobile-message-outbox.ts");
  expect(classifyMobileSendFailure("ECONNREFUSED 127.0.0.1")).toBe("transient");
  expect(classifyMobileSendFailure("Timed out waiting for app-server")).toBe("transient");
  expect(classifyMobileSendFailure('attachment-error: Model does not support image input')).toBe("permanent");
  expect(classifyMobileSendFailure("Codex 暂未确认收到这条消息")).toBe("unconfirmed");
  expect(classifyMobileSendFailure("session.prompt timed out")).toBe("unconfirmed");
});

test("draft settings survive restart and apply only to the first input of the new task", () => {
  const stateFile = createStateFile();
  let outbox = new MobileMessageOutbox({stateFile});
  const input = {adapter:"codex",threadId:"local-new-draft",text:"检查",images:[],newTaskSettings:{model:"model-a",reasoningEffort:"high"}};
  outbox.accept({...input,clientId:"first"});outbox.accept({...input,clientId:"second"});
  outbox = new MobileMessageOutbox({stateFile});
  expect(outbox.get("codex","local-new-draft","first")?.newTaskSettings).toEqual(input.newTaskSettings);
  outbox.resolveThread("codex","local-new-draft","first","real-new-task");
  expect(outbox.get("codex","real-new-task","first")?.newTaskSettings).toEqual(input.newTaskSettings);
  expect(outbox.get("codex","real-new-task","second")?.newTaskSettings).toEqual(input.newTaskSettings);
  outbox.accept({...input, threadId:"real-new-task", clientId:"third", newTaskSettings:undefined});
  expect(outbox.get("codex","real-new-task","third")?.newTaskSettings).toEqual(input.newTaskSettings);
  outbox.markNewTaskSettingsApplied("codex","real-new-task","first");
  expect(outbox.get("codex","real-new-task","second")?.newTaskSettingsApplied).toBe(true);
  expect(outbox.get("codex","real-new-task","third")?.newTaskSettingsApplied).toBe(true);
  outbox = new MobileMessageOutbox({stateFile});
  outbox.retry("codex","real-new-task","first");
  expect(outbox.get("codex","real-new-task","first")?.newTaskSettingsApplied).toBe(true);
});

test("expires a queued send that never gets a native queue id", () => {
  // 真实场景：DeepSeek 在任务运行中返回 queued，但不提供 queuedMessageId。
  // 对账逻辑要求有原生 ID 才检查，因此该条目永远无法确认，会永久留在待发列表。
  const stateFile = createStateFile();
  const outbox = new MobileMessageOutbox({ stateFile });
  outbox.accept({ clientId: "c1", adapter: "deepseek", threadId: "t1", text: "排队内容", images: [], createdAtMs: 1_000 });
  outbox.markQueued("deepseek", "t1", "c1", { submittedAtMs: 1_000 });
  expect(outbox.get("deepseek", "t1", "c1")?.status).toBe("queued");
  expect(outbox.get("deepseek", "t1", "c1")?.queuedMessageId).toBeUndefined();

  // 未到期：保持原状。
  expect(outbox.expireStalePendingConfirmations(1_000 + 60_000)).toEqual([]);
  expect(outbox.get("deepseek", "t1", "c1")?.status).toBe("queued");

  // 超过 1 小时仍未确认：转为未确认，内容保留，不再占用待发列表。
  const affected = outbox.expireStalePendingConfirmations(1_000 + 60 * 60 * 1_000 + 1);
  expect(affected).toEqual([{ adapter: "deepseek", threadId: "t1" }]);
  expect(outbox.get("deepseek", "t1", "c1")).toMatchObject({ status: "unconfirmed", text: "排队内容" });
  // 已转为未确认后不会重复过期。
  expect(outbox.expireStalePendingConfirmations(1_000 + 10 * 60 * 60 * 1_000)).toEqual([]);
});

test("expires an unconfirmed submitted send and keeps a real queued entry", () => {
  const stateFile = createStateFile();
  const outbox = new MobileMessageOutbox({ stateFile });
  outbox.accept({ clientId: "submitted", adapter: "codex", threadId: "t1", text: "已提交", images: [], createdAtMs: 5_000 });
  outbox.markSubmitted("codex", "t1", "submitted", { submittedAtMs: 5_000 });
  outbox.accept({ clientId: "queued", adapter: "codex", threadId: "t1", text: "真排队", images: [], createdAtMs: 5_000 });
  outbox.markQueued("codex", "t1", "queued", { queuedMessageId: "native-1", submittedAtMs: 5_000 });

  const affected = outbox.expireStalePendingConfirmations(5_000 + 60 * 60 * 1_000 + 1);
  expect(affected).toEqual([{ adapter: "codex", threadId: "t1" }]);
  expect(outbox.get("codex", "t1", "submitted")?.status).toBe("unconfirmed");
  // 有原生队列 ID 的条目由服务端对账，不在这里过期。
  expect(outbox.get("codex", "t1", "queued")).toMatchObject({ status: "queued", queuedMessageId: "native-1" });
});

test("reports the next pending confirmation expiry so the scheduler stays awake", () => {
  const stateFile = createStateFile();
  const outbox = new MobileMessageOutbox({ stateFile });
  expect(outbox.nextPendingConfirmationExpiryAtMs(1_000)).toBeNull();
  outbox.accept({ clientId: "c1", adapter: "deepseek", threadId: "t1", text: "排队", images: [], createdAtMs: 2_000 });
  outbox.markQueued("deepseek", "t1", "c1", { submittedAtMs: 2_000 });
  const timeoutMs = 60 * 60 * 1_000;
  expect(outbox.nextPendingConfirmationExpiryAtMs(3_000)).toBe(2_000 + timeoutMs);
  // 已过期时间点应钳制到当前时间，避免立即忙轮询。
  expect(outbox.nextPendingConfirmationExpiryAtMs(2_000 + timeoutMs + 50_000)).toBe(2_000 + timeoutMs + 50_000);
  outbox.expireStalePendingConfirmations(2_000 + timeoutMs + 1);
  expect(outbox.nextPendingConfirmationExpiryAtMs(2_000 + timeoutMs + 2)).toBeNull();
});

test("cancels a local optimistic send without deleting its content", () => {
  const stateFile = createStateFile();
  const outbox = new MobileMessageOutbox({ stateFile });
  outbox.accept({ clientId: "c1", adapter: "deepseek", threadId: "t1", text: "待取消", images: [], createdAtMs: 1_000 });
  outbox.markQueued("deepseek", "t1", "c1", { submittedAtMs: 1_000 });
  expect(outbox.cancelByClientId("deepseek", "t1", "c1")).toBe(true);
  // 取消是幂等墓碑，内容保留且不可重复提交。
  expect(outbox.get("deepseek", "t1", "c1")).toMatchObject({ status: "cancelled", text: "待取消" });
  expect(outbox.cancelByClientId("deepseek", "t1", "c1")).toBe(false);
  expect(outbox.readyEntries(Number.MAX_SAFE_INTEGER)).toEqual([]);
});

test("does not expire an already delivered send", () => {
  const stateFile = createStateFile();
  const outbox = new MobileMessageOutbox({ stateFile });
  outbox.accept({ clientId: "c1", adapter: "codex", threadId: "t1", text: "已完成", images: [], createdAtMs: 1_000 });
  outbox.markQueued("codex", "t1", "c1", { queuedMessageId: "native", submittedAtMs: 1_000 });
  outbox.reconcileReceived("codex", "t1", "c1", [
    { id: "m1", role: "user", text: "已完成", createdAtMs: 1_500, clientId: "c1" },
  ]);
  expect(outbox.expireStalePendingConfirmations(1_000 + 100 * 60 * 60 * 1_000)).toEqual([]);
  expect(outbox.get("codex", "t1", "c1")?.status).toBe("delivered");
});

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

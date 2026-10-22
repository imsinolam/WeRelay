import { expect, test } from "bun:test";
import { WeRelayDaemon } from "../../src/daemon/werelay-daemon.ts";
import { formatTaskListInstructions } from "../../src/bridge/task-list-instructions.ts";
import { CodexCompletionDeliveryQueue } from "../../src/daemon/codex-completion-delivery.ts";

function fixture(queue = new CodexCompletionDeliveryQueue()) {
  const sent: string[] = [];
  const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
    codexCompletionDeliveries: queue,
    shouldPushCompletionForTask: async () => true,
    formatNumberedDeliveryText: (_item: unknown, text: string) => text,
    queueWechatMessages: async (_sender: string, texts: string[]) => { sent.push(...texts); return texts.length; },
    queueWechatMessage: async (_sender: string, text: string) => { sent.push(text); return true; },
  });
  return { daemon, sent, queue };
}

function add(queue: CodexCompletionDeliveryQueue, key: string) {
  queue.enqueue({ key, threadId: key, completedAt: new Date(Date.now() - 10 * 60_000).toISOString(), texts: [`[${key}] completed`] });
}

test("background recovery stays silent even when the backlog changes", async () => {
  const { daemon, queue, sent } = fixture();
  add(queue, "a"); add(queue, "b");
  await daemon.retryPendingCodexCompletionNotifications("u");
  queue.discard(["a"]);
  add(queue, "c");
  await daemon.retryPendingCodexCompletionNotifications("u");
  expect(sent).toEqual([]);
});

test("a successful task list carries one backlog reminder; shrinking, pagination and restart do not repeat it", async () => {
  const first = fixture();
  add(first.queue, "a"); add(first.queue, "b");
  await first.daemon.queueWechatTaskListMessage("u", "任务列表");
  expect(first.sent.filter((text) => text.includes("较早的完成通知"))).toHaveLength(1);
  first.queue.discard(["a"]);
  await first.daemon.queueWechatTaskListMessage("u", "下一页任务");
  const restarted = fixture(new CodexCompletionDeliveryQueue({ initial: JSON.parse(JSON.stringify(first.queue.snapshot())) }));
  await restarted.daemon.queueWechatTaskListMessage("u", "/dsh任务");
  expect(first.sent.filter((text) => text.includes("较早的完成通知"))).toHaveLength(1);
  expect(restarted.sent).toEqual(["/dsh任务"]);
  expect(restarted.queue.hasDelivered("b")).toBe(false);
  expect(restarted.queue.getPending()).toHaveLength(1);
});

test("new backlog waits for the next list and only mentions newly unannounced notifications", async () => {
  const { daemon, queue, sent } = fixture();
  add(queue, "a");
  await daemon.queueWechatTaskListMessage("u", "list");
  add(queue, "b");
  await daemon.retryPendingCodexCompletionNotifications("u");
  expect(sent.filter((text) => text.includes("较早的完成通知"))).toHaveLength(1);
  await daemon.queueWechatTaskListMessage("u", "list again");
  const prompts = sent.filter((text) => text.includes("较早的完成通知"));
  expect(prompts).toHaveLength(2);
  expect(prompts[1]).toContain("[b]");
  expect(prompts[1]).not.toContain("[a]");
});

test("partial task list delivery does not push a reminder", async () => {
  const { daemon, queue, sent } = fixture();
  add(queue, "a");
  daemon.queueWechatMessages = async (_sender: string, texts: string[]) => {
    expect(texts).toHaveLength(2);
    sent.push(texts[0]!);
    return 1;
  };
  await daemon.queueWechatTaskListMessage("u", `list\n\n${formatTaskListInstructions()}`);
  expect(sent).toEqual(["list"]);
  expect(queue.getPending()[0]?.backlogNotifiedAt).toBeUndefined();
});

test("failed reminder is not retried in the background, only on a later user list request", async () => {
  const { daemon, queue, sent } = fixture();
  add(queue, "a");
  let attempts = 0;
  daemon.queueWechatMessage = async (_sender: string, text: string) => { attempts++; if (attempts === 1) return false; sent.push(text); return true; };
  await daemon.queueWechatTaskListMessage("u", "list");
  await daemon.retryPendingCodexCompletionNotifications("u");
  expect(attempts).toBe(1);
  await daemon.queueWechatTaskListMessage("u", "list again");
  expect(attempts).toBe(2);
  await daemon.queueWechatTaskListMessage("u", "list third");
  expect(attempts).toBe(2);
});

test("concurrent list requests cannot duplicate an in-flight reminder", async () => {
  const { daemon, queue, sent } = fixture();
  add(queue, "a");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  daemon.queueWechatMessage = async (_sender: string, text: string) => { calls++; await blocked; sent.push(text); return true; };
  const first = daemon.queueWechatTaskListMessage("u", "list");
  const second = daemon.queueWechatTaskListMessage("u", "list again");
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  await Promise.all([first, second]);
  expect(calls).toBe(1);
});


test("a failed backlog read cannot turn concurrent successful lists into failed requests", async () => {
  const { daemon, queue, sent } = fixture();
  add(queue, "a");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  daemon.pendingBacklogCompletions = async () => { await blocked; throw new Error("fixture backlog unavailable"); };
  const first = daemon.queueWechatTaskListMessage("u", "list");
  const second = daemon.queueWechatTaskListMessage("u", "list again");
  // Attach rejection handlers before releasing the shared failure.
  const settled = Promise.allSettled([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  expect((await settled).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(sent).toEqual(["list", "list again"]);
  expect(queue.getPending()[0]?.backlogNotifiedAt).toBeUndefined();
});

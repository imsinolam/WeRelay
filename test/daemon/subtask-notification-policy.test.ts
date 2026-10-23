import { expect, test } from "bun:test";
import { shouldPushTaskNotification } from "../../src/daemon/subtask-notification-policy.ts";
import { WeRelayDaemon } from "../../src/daemon/werelay-daemon.ts";
import { CodexCompletionDeliveryQueue } from "../../src/daemon/codex-completion-delivery.ts";
import { ApprovalNotificationDeliveryQueue } from "../../src/daemon/approval-notification-delivery.ts";
import { BoundedTtlMap } from "../../src/utils/bounded-ttl-cache.ts";

test("child completions are silent but child approvals stay eligible", () => {
  for (const metadata of [
    { parentThreadId: "parent" },
    { source: "subagent" },
    { source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "p" } } }) },
    { source: JSON.stringify({ subagent: { other: "guardian" } }) },
  ]) {
    expect(shouldPushTaskNotification("completion", metadata)).toBe(false);
    expect(shouldPushTaskNotification("approval", metadata)).toBe(true);
  }
});

test("normal tasks and unknown metadata retain completion notifications", () => {
  for (const metadata of [undefined, null, {}, { source: "cli" }, { source: "desktop" }, { source: "{" }]) {
    expect(shouldPushTaskNotification("completion", metadata)).toBe(true);
  }
});

function daemonFixture() {
  // No constructor: never connect WeChat, start a timer, write runtime state or
  // create a desktop owner in these routing tests.
  const daemon = Object.create(WeRelayDaemon.prototype) as any;
  const sent: string[] = [];
  daemon.slots = new Map();
  daemon.cwd = "/fixture";
  daemon.authorizedUserId = "fixture-user";
  daemon.codexCompletionDeliveries = new CodexCompletionDeliveryQueue();
  daemon.approvalNotificationDeliveries = new ApprovalNotificationDeliveryQueue();
  daemon.completionNotificationOriginCache = new BoundedTtlMap({ maxSize: 16, ttlMs: 60000 });
  daemon.globalTaskCatalogWorker = { loadNotificationMetadata: async (_cwd: string, id: string) => id === "child" ? { parentThreadId: "parent" } : { source: "cli" } };
  daemon.clearCodexFinalReplyCache = () => {};
  daemon.formatNumberedDeliveryText = (_delivery: unknown, text: string) => text;
  daemon.queueWechatMessage = async (_user: string, text: string) => { sent.push(text); return true; };
  return { daemon, sent };
}

test("live Codex completion stops before history, numbering or enqueue", async () => {
  const { daemon, sent } = daemonFixture();
  const slot = { adapter: "codex", runtime: { getSessionMessages: () => { throw new Error("must not read answer"); } } };
  daemon.getCodexTaskCandidates = async () => [{ sessionId: "child", parentThreadId: "parent" }];
  await daemon.sendCodexTaskCompletionMessage(slot, { threadId: "child", startedAtMs: Date.now() });
  expect(daemon.codexCompletionDeliveries.getPending()).toEqual([]);
  expect(sent).toEqual([]);
});

test("persisted child deliveries are suppressed before replay and parent delivery still sends", async () => {
  const { daemon, sent } = daemonFixture();
  for (const threadId of ["child", "parent"]) daemon.codexCompletionDeliveries.enqueue({
    key: `${threadId}:turn`, threadId, texts: [`${threadId} completed`],
  });
  expect((await daemon.deliverCodexCompletionNotification("child:turn", "fixture")).status).toBe("missing");
  expect((await daemon.deliverCodexCompletionNotification("parent:turn", "fixture")).status).toBe("delivered");
  expect(sent).toEqual(["parent completed"]);
  expect(daemon.codexCompletionDeliveries.getNotificationStatus("child", "codex")).toMatchObject({ reason: "suppressed" });
});

test("digest omits child completions and retains child approvals", async () => {
  const { daemon, sent } = daemonFixture();
  daemon.notificationPolicy = { sent: () => {} };
  daemon.isApprovalNotificationStillPending = async () => true;
  daemon.rememberWechatCandidate = () => {};
  daemon.codexCompletionDeliveries.enqueue({ key: "child:t", threadId: "child", texts: ["child completed"] });
  daemon.codexCompletionDeliveries.enqueue({ key: "parent:t", threadId: "parent", texts: ["parent completed"] });
  daemon.approvalNotificationDeliveries.enqueue({ key: "approval", adapter: "codex", threadId: "child", text: "[child] needs approval" });
  await daemon.sendTaskNotificationDigest();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("[child]");
  expect(sent[0]).toContain("待审批");
  expect(sent[0]).toContain("parent completed");
  expect(sent[0]).not.toContain("child completed");
});

test("a child approval can be sent immediately without checking completion eligibility", async () => {
  const { daemon, sent } = daemonFixture();
  daemon.shouldPushCompletionForTask = () => { throw new Error("approval must not use completion policy"); };
  daemon.approvalNotificationDeliveries.enqueue({ key: "approval", adapter: "codex", threadId: "child", text: "approval requested" });
  expect((await daemon.deliverApprovalNotification("approval", "fixture")).status).toBe("delivered");
  expect(sent).toEqual(["approval requested"]);
});

test("classification failure keeps a notification pending instead of sending or marking delivered", async () => {
  const { daemon, sent } = daemonFixture();
  daemon.globalTaskCatalogWorker.loadNotificationMetadata = async () => { throw new Error("fixture read failure"); };
  daemon.codexCompletionDeliveries.enqueue({ key: "unknown:t", threadId: "unknown", texts: ["answer"] });
  // Avoid the diagnostic logger by exercising the direct path, whose error
  // is handled by the existing persistent recovery scheduler.
  await expect(daemon.deliverCodexCompletionNotification("unknown:t", "fixture")).rejects.toThrow("fixture read failure");
  expect(daemon.codexCompletionDeliveries.getPending()).toHaveLength(1);
  expect(daemon.codexCompletionDeliveries.hasDelivered("unknown:t")).toBe(false);
  expect(sent).toEqual([]);
});

test("backlog confirmation never includes a child completion", async () => {
  const { daemon, sent } = daemonFixture();
  const now = Date.now();
  const original = new CodexCompletionDeliveryQueue({ now: () => now - 10 * 60_000 });
  for (const threadId of ["child", "parent"]) original.enqueue({ key: `${threadId}:old`, threadId, texts: [`${threadId} old answer`] });
  daemon.codexCompletionDeliveries = new CodexCompletionDeliveryQueue({ initial: original.snapshot() });
  const asked: string[] = [];
  daemon.requestClawbotBacklogConfirmation = async (_sender: string, items: { threadId: string }[]) => { asked.push(...items.map((item) => item.threadId)); };
  await daemon.remindClawbotBacklogAfterTaskList("fixture");
  expect(asked).toEqual(["parent"]);
  expect(sent).toEqual([]);
});

test("an explicit backlog resend also removes previously persisted child payloads", async () => {
  const { daemon, sent } = daemonFixture();
  const queue = new CodexCompletionDeliveryQueue({ now: () => Date.now() - 10 * 60_000 });
  for (const threadId of ["child", "parent"]) queue.enqueue({ key: `${threadId}:old`, threadId, texts: [`${threadId} old answer`] });
  daemon.codexCompletionDeliveries = new CodexCompletionDeliveryQueue({ initial: queue.snapshot() });
  await daemon.handleClawbotBacklogPushRequest({ senderId: "fixture" });
  expect(sent).toEqual(["parent old answer"]);
  expect(daemon.codexCompletionDeliveries.getPending()).toEqual([]);
});

import fs from "node:fs";
import { expect, test } from "bun:test";
import { resolveDaemonWechatReplyTarget } from "../../src/daemon/werelay-daemon.ts";

const source = fs.readFileSync(new URL("../../src/daemon/werelay-daemon.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("captures incoming targets before replaying pending completion notifications", () => {
  const capture = source.indexOf("const inboundTargets = pollResult.messages.map");
  const replay = source.indexOf("await this.retryPendingCodexCompletionNotifications(message.senderId)", capture);
  const dispatch = source.indexOf("await this.handleInboundMessage(message, inboundTargets[messageIndex])", replay);
  expect(capture).toBeGreaterThan(0);
  expect(replay).toBeGreaterThan(capture);
  expect(dispatch).toBeGreaterThan(replay);
});

test("a later completion cannot redirect an already received reply", () => {
  let latest = { adapter: "codex" as const, sessionId: "task-10" };
  const captured = latest;
  latest = { adapter: "codex", sessionId: "task-32" };
  expect(resolveDaemonWechatReplyTarget({
    currentAdapter: "codex", currentThreadId: latest.sessionId, latestTask: captured,
  })).toEqual({ adapter: "codex", threadId: "task-10" });
});

test("formatting a pending Codex completion does not activate its reply target", () => {
  expect(source).toContain("completionTitle,\n      false,");
  expect(source).toContain('if (deliveryResult.status === "delivered") {\n      this.rememberWechatTaskTarget');
  const handler = source.slice(source.indexOf("  private async handleInboundMessage("), source.indexOf("  private async handleDaemonTaskTargetedMessage("));
  expect(handler).not.toContain("latestTask: this.latestWechatTaskTarget");
  expect(handler).toContain("latestTask: receivedTaskTarget");
});

import fs from "node:fs";
import { expect, test } from "bun:test";
import { resolveDaemonWechatReplyTarget } from "../../src/daemon/werelay-daemon.ts";

const source = fs.readFileSync(new URL("../../src/daemon/werelay-daemon.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("handles inbound messages before scheduling nonblocking recovery", () => {
  const capture = source.indexOf("const inboundTargets = messages.map");
  const dispatch = source.indexOf("await this.handleInboundMessage(message, inboundTargets[messageIndex])", capture);
  const replay = source.indexOf("void this.outboundRecoveryScheduler.trigger()", dispatch);
  expect(capture).toBeGreaterThan(0);
  expect(dispatch).toBeGreaterThan(capture);
  expect(replay).toBeGreaterThan(dispatch);
  expect(source).not.toContain("await this.outboundRecoveryScheduler.trigger()");
  expect(source).not.toContain("await this.runOutboundRecoveryPass()");
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

 test("actual inbound batch completes while historical delivery is stuck", async () => {
   const { WeRelayDaemon } = await import("../../src/daemon/werelay-daemon.ts");
   const { OutboundRecoveryScheduler } = await import("../../src/daemon/outbound-recovery-scheduler.ts");
   let release!: () => void;
   const blocked = new Promise<void>((resolve) => { release = resolve; });
   const scheduler = new OutboundRecoveryScheduler(() => blocked, () => {});
   const running = scheduler.trigger();
   const received: string[] = [];
   const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
     authorizedUserId: "test", getActiveSlot: () => null,
     outboundRecoveryScheduler: scheduler,
     handleInboundMessage: async (message: { text: string }) => { received.push(message.text); },
   });
   try {
     let completed = false;
     const batch = daemon.handleInboundBatch([{ senderId: "test", text: "任务" }, { senderId: "test", text: "/dsh" }]).then(() => { completed = true; });
     for (let i = 0; i < 12; i++) await Promise.resolve();
     expect(completed).toBe(true);
     expect(received).toEqual(["任务", "/dsh"]);
     await batch;
   } finally {
     release();
     await running;
     scheduler.stop();
   }
 });

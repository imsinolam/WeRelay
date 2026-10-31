import { expect, test } from "bun:test";
import { WeRelayDaemon } from "../../src/daemon/werelay-daemon.ts";

test("completion vendor push retains identity after the delivery queue removes its pending entry", async () => {
  const daemon: any = Object.create(WeRelayDaemon.prototype);
  const delivered = { key: "synthetic-notice", adapter: "pi-desktop", threadId: "original-task", title: "合成任务", texts: ["done"] };
  let pending = [delivered];
  daemon.codexCompletionDeliveries = {
    getPending: () => pending,
    deliver: async () => { pending = []; return { status: "delivered", delivery: delivered }; },
  };
  daemon.vendorPushOrigin = () => "https://relay.example";
  let pushed: any;
  daemon.deliverVendorPush = async (input: unknown) => { pushed = input; };
  const result = await daemon.deliverCompletionWithScreenPolicy("synthetic-notice", "synthetic-recipient");
  expect(result.status).toBe("delivered");
  expect(pushed.content).toBe("合成任务");
  expect(pushed.data).toEqual({ adapter: "pi-desktop", threadId: "original-task", kind: "completed" });
  expect(pushed.collapseKey).toBeTruthy();
});

test("approval push never substitutes private command text when a task title is missing", () => {
  const daemon: any = Object.create(WeRelayDaemon.prototype);
  daemon.mobileTaskTitleFor = () => "";
  const text = daemon.approvalPushContent({ adapter: "codex" }, "original-task", { commandPreview: "private command must stay local" });
  expect(text).not.toContain("private command");
  expect(text).toContain("任务需要确认");
});

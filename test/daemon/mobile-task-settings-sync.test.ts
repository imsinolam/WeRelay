import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MobileMessageOutbox, classifyMobileSendFailure } from "../../src/daemon/mobile-message-outbox.ts";
import {
  MobileTaskModelStateCache,
  staleModelStateFallback,
  startMobileTaskSettingsTimer,
  taskSettingsSatisfied,
} from "../../src/daemon/mobile-task-settings-sync.ts";

const tempDirs: string[] = [];
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function stateFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-task-settings-"));
  tempDirs.push(dir);
  return path.join(dir, "outbox.json");
}

test("settings are satisfied only when every requested field matches", () => {
  const state = { currentModel: "a", currentReasoningEffort: "high" };
  expect(taskSettingsSatisfied(state, { model: "a" })).toBe(true);
  expect(taskSettingsSatisfied(state, { model: "a", reasoningEffort: "low" })).toBe(false);
  expect(taskSettingsSatisfied(null, { model: "a" })).toBe(false);
});

test("model state cache expires and keeps a bounded number of tasks", () => {
  let now = 0;
  const cache = new MobileTaskModelStateCache({ maxEntries: 2, now: () => now });
  cache.remember("pi", "t1", { options: [{ id: "a" }], canChange: true });
  cache.remember("pi", "t2", { options: [{ id: "b" }], canChange: true });
  cache.remember("pi", "t3", { options: [{ id: "c" }], canChange: true });
  expect(cache.get("pi", "t1", 1_000)).toBeNull();
  expect(cache.get("pi", "t3", 1_000)?.options[0]?.id).toBe("c");
  now = 2_000;
  expect(cache.get("pi", "t3", 1_000)).toBeNull();
});

test("a temporary read failure keeps the last switch capability instead of disabling it", () => {
  const fallback = staleModelStateFallback({ options: [{ id: "a" }], canChange: true, currentModel: "a" }, new Error("超时"));
  expect(fallback).toMatchObject({ canChange: true, stale: true, staleReason: "超时", currentModel: "a" });
});

test("timer reports every stage and total", () => {
  let now = 0;
  const timer = startMobileTaskSettingsTimer(() => now);
  now = 5; timer.mark("locate");
  now = 25; timer.mark("agent_read");
  expect(timer.summary()).toBe("locate=5ms agent_read=20ms total=25ms");
});

test("outbox keeps per-message settings across restart and marks only that message applied", () => {
  const file = stateFile();
  let outbox = new MobileMessageOutbox({ stateFile: file });
  outbox.accept({ clientId: "m1", adapter: "pi", threadId: "t", text: "一", images: [], taskSettings: { model: "a" } });
  outbox.accept({ clientId: "m2", adapter: "pi", threadId: "t", text: "二", images: [], taskSettings: { model: "b", reasoningEffort: "high" } });
  outbox.markTaskSettingsApplied("pi", "t", "m1");
  outbox = new MobileMessageOutbox({ stateFile: file });
  const [first, second] = outbox.list("pi", "t");
  expect(first).toMatchObject({ clientId: "m1", taskSettings: { model: "a" }, taskSettingsApplied: true });
  expect(second).toMatchObject({ clientId: "m2", taskSettings: { model: "b", reasoningEffort: "high" } });
  expect(second?.taskSettingsApplied).toBeUndefined();
});

test("an Agent without model switching fails the message permanently instead of retrying forever", () => {
  expect(classifyMobileSendFailure("Pi 暂不支持从网页版切换模型。")).toBe("permanent");
});

async function dispatchWithSettings(options: {
  current: { currentModel?: string; currentReasoningEffort?: string };
  failRead?: boolean;
  setResult?: (update: Record<string, string>) => Record<string, string>;
}) {
  const { WeRelayDaemon } = await import("../../src/daemon/werelay-daemon.ts");
  const proto = WeRelayDaemon.prototype as any;
  const calls: string[] = [];
  const runtime = {
    sendInputToSession: async () => {},
    getSessionPermissionState: async () => ({ currentPermission: "workspace-write", options: [{ id: "workspace-write" }], canChange: true }),
    getSessionModelState: async () => {
      calls.push("read");
      if (options.failRead) throw new Error("超时");
      return { ...options.current, options: [{ id: "a" }, { id: "b" }], canChange: true };
    },
    setSessionModel: async (_id: string, model: string) => {
      calls.push(`model:${model}`);
      return { ...(options.setResult?.({ model }) ?? { currentModel: model }), options: [], canChange: true };
    },
    setSessionReasoningEffort: async (_id: string, effort: string) => {
      calls.push(`effort:${effort}`);
      return { currentReasoningEffort: effort, options: [], canChange: true };
    },
  };
  const slot = { adapter: "pi", runtime };
  const marked: string[] = [];
  const receiver: any = {
    getMobileSlot: () => slot,
    getSlotThreadId: () => "task",
    mobileCreatedTaskKeys: new Set<string>(),
    mobileTaskModelStates: new MobileTaskModelStateCache(),
    mobileMessageOutbox: { markTaskSettingsApplied: (_a: string, _t: string, id: string) => marked.push(id) },
    dispatchMobileInput: async () => { calls.push("send"); return {}; },
    logMobileTaskSettingsTiming: () => {},
  };
  receiver.assertMobileTaskKnown = proto.assertMobileTaskKnown.bind(receiver);
  receiver.setMobileTaskModel = proto.setMobileTaskModel.bind(receiver);
  receiver.applyMobileMessageTaskSettings = proto.applyMobileMessageTaskSettings.bind(receiver);
  const run = (taskSettings: Record<string, string>) => proto.dispatchPersistedMobileMessage.call(receiver, {
    clientId: "m1", adapter: "pi", threadId: "task", text: "继续", images: [], taskSettings,
  });
  return { calls, marked, run };
}

test("a message applies only the settings that differ, then sends", async () => {
  const h = await dispatchWithSettings({
    current: { currentModel: "a", currentReasoningEffort: "high" },
    setResult: ({ model }) => ({ currentModel: model!, currentReasoningEffort: "high" }),
  });
  await h.run({ model: "b", reasoningEffort: "high" });
  expect(h.calls).toEqual(["read", "model:b", "send"]);
  expect(h.marked).toEqual(["m1"]);
});

test("a model switch that resets reasoning effort re-applies the chosen effort", async () => {
  const h = await dispatchWithSettings({ current: { currentModel: "a", currentReasoningEffort: "high" } });
  await h.run({ model: "b", reasoningEffort: "high" });
  expect(h.calls).toEqual(["read", "model:b", "effort:high", "send"]);
});

test("matching settings skip the write entirely", async () => {
  const h = await dispatchWithSettings({ current: { currentModel: "b" } });
  await h.run({ model: "b" });
  expect(h.calls).toEqual(["read", "send"]);
});

test("an unconfirmed switch keeps the message instead of sending with the old model", async () => {
  const h = await dispatchWithSettings({ current: { currentModel: "a" }, setResult: () => ({ currentModel: "a" }) });
  await expect(h.run({ model: "b" })).rejects.toThrow("所选模型尚未在电脑端生效");
  expect(h.calls).not.toContain("send");
  expect(h.marked).toEqual([]);
});

test("an unreadable current state still writes the requested settings before sending", async () => {
  const h = await dispatchWithSettings({ current: {}, failRead: true });
  await h.run({ model: "b", reasoningEffort: "low" });
  expect(h.calls).toEqual(["read", "model:b", "effort:low", "send"]);
});

test("the newest selection wins over settings carried by an earlier message", async () => {
  const { CODEX_MOBILE_APP_JS } = await import("../../src/daemon/codex-mobile-web.ts");
  const start = CODEX_MOBILE_APP_JS.indexOf("  function pendingNextTaskSettings(");
  const end = CODEX_MOBILE_APP_JS.indexOf("  function projectedTaskModelState(", start);
  const state: any = {
    currentAdapter: "pi", currentThreadId: "t",
    nextTaskSettings: { "pi\0t": { model: "c" } },
    pendingMessages: [{ adapter: "pi", threadId: "t", taskSettings: { model: "b" } }],
    outboundMessages: [],
    sentTaskSettings: { "pi\0t": { settings: { model: "b" }, sentAtMs: Date.now() } },
  };
  const unconfirmed = new Function("state", `
    function currentTaskModelKey() { return state.currentAdapter + "\\u0000" + state.currentThreadId; }
    function conversationStateKey(a, t) { return a + "\\u0000" + t; }
    ${CODEX_MOBILE_APP_JS.slice(start, end)}
    return unconfirmedTaskSettings;`)(state);
  expect(unconfirmed({ currentModel: "a" })).toEqual({ model: "c" });
  delete state.nextTaskSettings["pi\0t"];
  state.pendingMessages = [];
  // 已发出但电脑尚未确认时，继续显示刚发出的选择，不闪回旧模型。
  expect(unconfirmed({ currentModel: "a" })).toEqual({ model: "b" });
  expect(unconfirmed({ currentModel: "b" })).toBeNull();
});

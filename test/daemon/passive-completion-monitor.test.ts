import { expect, test } from "bun:test";
import { PassiveCompletionMonitor, type DesktopCompletion } from "../../src/daemon/passive-completion-monitor.ts";
import { CodexCompletionDeliveryQueue } from "../../src/daemon/codex-completion-delivery.ts";

const now = Date.parse("2026-01-02T12:00:00Z");
const completion = (adapter: "codex" | "workbuddy", sessionId = "same"): DesktopCompletion => ({
  adapter, candidate: { sessionId, title: "测试任务", lastUpdatedAt: new Date(now).toISOString() },
  summary: { status: "completed", turnId: adapter === "codex" ? "turn" : undefined, completedAtMs: now },
  finalMessage: { role: "assistant", phase: "final_answer", id: "final", text: "完成", turnId: adapter === "codex" ? "turn" : undefined },
});

test("idle daemon monitors desktop completions without slots, owners or application launch", async () => {
  const captured: string[] = [];
  const monitor = new PassiveCompletionMonitor({
    now: () => now,
    read: async (adapter) => [completion(adapter)],
    capture: async (item) => { captured.push(item.adapter); },
  });
  await monitor.poll();
  await monitor.poll();
  expect(captured).toEqual(["codex", "workbuddy"]);
  monitor.stop();
});

test("reader/capture failure retries next pass without blocking another adapter", async () => {
  let calls = 0; const captured: string[] = [];
  const monitor = new PassiveCompletionMonitor({ now: () => now,
    read: async (adapter) => { if (adapter === "codex" && calls++ === 0) throw new Error("busy"); return [completion(adapter)]; },
    capture: async (item) => { captured.push(item.adapter); },
  });
  await monitor.poll(); await monitor.poll();
  expect(captured).toEqual(["workbuddy", "codex"]);
  monitor.stop();
});

test("running, stale and mismatched final evidence never becomes a completion", async () => {
  const valid = completion("codex");
  const items: DesktopCompletion[] = [
    { ...valid, summary: { ...valid.summary, status: "running" } },
    { ...valid, summary: { ...valid.summary, completedAtMs: now - 7 * 60 * 60_000 } },
    { ...valid, finalMessage: { ...valid.finalMessage, turnId: "previous" } },
    { ...valid, finalMessage: { ...valid.finalMessage, role: "user" } },
    { ...valid, finalMessage: { ...valid.finalMessage, phase: "commentary" } },
  ];
  let captured = 0;
  const monitor = new PassiveCompletionMonitor({ now: () => now,
    read: async () => items, capture: async () => { captured++; },
  });
  await monitor.poll();
  expect(captured).toBe(0);
  monitor.stop();
});

test("single-flight polling and stop prevent late capture", async () => {
  let resolve!: (items: DesktopCompletion[]) => void;
  let reads = 0; let captures = 0;
  const monitor = new PassiveCompletionMonitor({ now: () => now,
    read: async () => { reads++; return await new Promise<DesktopCompletion[]>((r) => { resolve = r; }); },
    adapters: ["codex"], capture: async () => { captures++; },
  });
  const first = monitor.poll();
  await monitor.poll();
  expect(reads).toBe(1);
  monitor.stop(); resolve([completion("codex")]); await first;
  expect(captures).toBe(0);
});

test("restart uses persistent delivery keys, retains failed payload and deduplicates success", async () => {
  let state: ReturnType<CodexCompletionDeliveryQueue["snapshot"]> | undefined;
  const deliveries: string[] = [];
  const pollWith = async (fail: boolean) => {
    const queue = new CodexCompletionDeliveryQueue({ now: () => now, initial: state, persist: (value) => { state = value; } });
    const monitor = new PassiveCompletionMonitor({ now: () => now,
      read: async (adapter) => [completion(adapter)],
      capture: async (item, key) => {
        queue.enqueue({ key, threadId: item.candidate.sessionId, texts: [item.finalMessage.text], completedAt: new Date(now).toISOString() });
        await queue.deliver(key, async () => { if (fail) return 0; deliveries.push(item.adapter); return 1; });
      },
    });
    await monitor.poll(); monitor.stop();
  };
  await pollWith(true);
  expect(state?.pending).toHaveLength(2);
  await pollWith(false);
  expect(deliveries).toEqual(["codex", "workbuddy"]);
  await pollWith(false);
  expect(deliveries).toHaveLength(2);
});

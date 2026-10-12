import { describe, expect, test } from "bun:test";

import { OutboundRecoveryScheduler } from "../../src/daemon/outbound-recovery-scheduler.ts";
import { CodexCompletionDeliveryQueue, type CodexCompletionDeliveryState } from "../../src/daemon/codex-completion-delivery.ts";

describe("outbound recovery scheduler", () => {
  test("inbound refresh recovers persisted partial delivery without duplicating confirmed parts", async () => {
    const snapshots: CodexCompletionDeliveryState[] = [];
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    let freshContext = false;
    let passes = 0;
    const attempts: string[][] = [];
    const queue = new CodexCompletionDeliveryQueue({ persist: (state) => snapshots.push(structuredClone(state)) });
    queue.enqueue({ key: "session:turn", threadId: "session", texts: ["answer", "task link"] });
    const scheduler = new OutboundRecoveryScheduler(async () => {
      const thisPass = ++passes;
      await queue.deliver("session:turn", async (_item, texts, checkpoint) => {
        attempts.push(texts);
        if (thisPass === 1) {
          checkpoint(); // answer confirmed, link rejected using the old context
          await waiting;
          return 1;
        }
        expect(freshContext).toBe(true);
        return texts.length;
      });
    }, () => {});
    const recovering = scheduler.trigger();
    await Promise.resolve();
    freshContext = true;
    void scheduler.trigger({ rerunIfRunning: true });
    release();
    await recovering;
    expect(attempts).toEqual([["answer", "task link"], ["task link"]]);
    expect(passes).toBe(2);
    expect(new CodexCompletionDeliveryQueue({ initial: snapshots.at(-1) }).hasDelivered("session:turn")).toBe(true);
    scheduler.stop();
  });

  test("fresh inbound during recovery coalesces into one follow-up pass", async () => {
    let release!: () => void;
    let passes = 0;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new OutboundRecoveryScheduler(async () => {
      passes++;
      if (passes === 1) await waiting;
    }, () => {});
    const first = scheduler.trigger();
    await Promise.resolve();
    const refresh = scheduler.trigger({ rerunIfRunning: true });
    scheduler.trigger({ rerunIfRunning: true });
    scheduler.trigger();
    release();
    await Promise.all([first, refresh]);
    expect(passes).toBe(2);
    scheduler.stop();
  });

  test("stop cancels an inbound follow-up and ordinary triggers never self-loop", async () => {
    let release!: () => void;
    let passes = 0;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const scheduler = new OutboundRecoveryScheduler(async () => {
      passes++;
      void scheduler.trigger();
      await waiting;
    }, () => {});
    const first = scheduler.trigger();
    await Promise.resolve();
    void scheduler.trigger({ rerunIfRunning: true });
    scheduler.stop();
    release();
    await first;
    expect(passes).toBe(1);
  });

  test("fresh inbound is not lost when the current pass fails", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const errors: unknown[] = [];
    let passes = 0;
    const scheduler = new OutboundRecoveryScheduler(async () => {
      if (++passes === 1) { await waiting; throw new Error("old-context failure"); }
    }, (error) => errors.push(error));
    const first = scheduler.trigger();
    await Promise.resolve();
    void scheduler.trigger({ rerunIfRunning: true });
    release();
    await first;
    expect(passes).toBe(2);
    expect(errors).toHaveLength(1);
    scheduler.stop();
  });

  test("runs an independent timer pass and triggers immediately on demand", async () => {
    let passes = 0;
    const scheduler = new OutboundRecoveryScheduler(
      async () => { passes += 1; },
      () => {},
      10,
    );
    scheduler.start();
    await scheduler.trigger();
    expect(passes).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    scheduler.stop();
    expect(passes).toBeGreaterThanOrEqual(2);
    const afterStop = passes;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(passes).toBe(afterStop);
  });

  test("serializes overlapping passes instead of running them concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const scheduler = new OutboundRecoveryScheduler(
      async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      },
      () => {},
      10_000,
    );
    const first = scheduler.trigger();
    const second = scheduler.trigger();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    scheduler.stop();
  });

  test("a failing pass reports the error and later triggers still run", async () => {
    const errors: unknown[] = [];
    let passes = 0;
    const scheduler = new OutboundRecoveryScheduler(
      async () => {
        passes += 1;
        if (passes === 1) throw new Error("recovery failed");
      },
      (error) => errors.push(error),
      10_000,
    );
    await scheduler.trigger();
    expect(passes).toBe(1);
    expect(errors).toHaveLength(1);
    await scheduler.trigger();
    expect(passes).toBe(2);
    scheduler.stop();
  });
});

 test("stop prevents queued recovery from starting again", async () => {
   let count = 0;
   const scheduler = new OutboundRecoveryScheduler(async () => { count++; }, () => {});
   const queued = scheduler.trigger();
   scheduler.stop();
   await queued;
   await scheduler.trigger();
   expect(count).toBe(0);
 });

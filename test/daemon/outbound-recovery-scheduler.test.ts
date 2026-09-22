import { describe, expect, test } from "bun:test";

import { OutboundRecoveryScheduler } from "../../src/daemon/outbound-recovery-scheduler.ts";

describe("outbound recovery scheduler", () => {
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

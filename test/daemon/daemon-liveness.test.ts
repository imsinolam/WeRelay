import { expect, test } from "bun:test";
import { DaemonLivenessMonitor } from "../../src/daemon/daemon-liveness.ts";

test("records monotonic event-loop delay without flooding or treating a wall-clock change as a stall", () => {
  let now = 0;
  const delays: number[] = [];
  const monitor = new DaemonLivenessMonitor((ms) => delays.push(ms), { now: () => now });
  monitor.start();
  try {
    now = 1000; monitor.sample(); expect(delays).toEqual([]);
    now = 7000; monitor.sample(); expect(delays).toEqual([5000]);
    now = 14000; monitor.sample(); expect(delays).toEqual([5000]);
    now = 40000; monitor.sample(); expect(delays).toEqual([5000, 25000]);
    monitor.stop(); now = 90000; monitor.sample(); expect(delays).toHaveLength(2);
  } finally { monitor.stop(); }
});

test("diagnostic logging failure cannot crash the daemon", () => {
  let now = 0;
  const monitor = new DaemonLivenessMonitor(() => { throw new Error("disk unavailable"); }, { now: () => now });
  monitor.start();
  try { now = 10000; expect(() => monitor.sample()).not.toThrow(); }
  finally { monitor.stop(); }
});

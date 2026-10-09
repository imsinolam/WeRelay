import { expect, test } from "bun:test";
import { ScreenNotificationPolicy, parseMacScreenLockState } from "../../src/daemon/screen-notification-policy.ts";

test("unlocked pushes are spaced ten minutes; only successful pushes advance persisted clock", async () => {
  let now = 1_000_000;
  let state: "locked" | "unlocked" | "unknown" = "unlocked";
  let saved: number | undefined;
  const policy = new ScreenNotificationPolicy({ now: () => now, read: async () => state,
    persist: (at) => { saved = at; } });
  expect(await policy.mode()).toBe("digest");
  policy.sent();
  expect(saved).toBe(now);
  now += 599_999;
  expect(await policy.mode()).toBe("wait");
  now++;
  expect(await policy.mode()).toBe("digest");
  state = "locked";
  expect(await policy.mode()).toBe("immediate");
  policy.sent();
  expect(await policy.mode()).toBe("immediate");
  state = "unlocked";
  expect(await policy.mode()).toBe("wait");
  const restarted = new ScreenNotificationPolicy({ now: () => now, read: async () => state, lastSentAtMs: saved });
  expect(await restarted.mode()).toBe("wait");
});

test("unknown and failed lock probes never silently delay approvals", async () => {
  expect(await new ScreenNotificationPolicy({ read: async () => "unknown" }).mode()).toBe("immediate");
  expect(await new ScreenNotificationPolicy({ read: async () => { throw new Error("probe"); } }).mode()).toBe("immediate");
  expect(parseMacScreenLockState('"CGSSessionScreenIsLocked"=Yes')).toBe("locked");
  expect(parseMacScreenLockState('"CGSSessionScreenIsLocked"=No')).toBe("unlocked");
  expect(parseMacScreenLockState("unrelated output")).toBe("unknown");
});

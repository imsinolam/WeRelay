import { describe, expect, test } from "bun:test";

import {
  MobileLiveEventHub,
  isMobileLiveEvent,
  type MobileLiveEvent,
} from "../../src/daemon/mobile-live-events.ts";
import { MobileConversationRevisionStore } from "../../src/daemon/mobile-conversation-revisions.ts";

describe("mobile conversation revision notifications", () => {
  test("publishes normalized identity changes without letting listener errors break touch", () => {
    const store = new MobileConversationRevisionStore({ epoch: "live-events" });
    const changes: Array<{ adapter: string; threadId: string; revision: string }> = [];
    store.onChange(() => {
      throw new Error("broken consumer");
    });
    const unsubscribe = store.onChange((change) => changes.push(change));

    const revision = store.touch(" ", " task-1 ");
    expect(changes).toEqual([{
      adapter: "codex",
      threadId: "task-1",
      revision,
    }]);

    unsubscribe();
    store.touch("codex", "task-1");
    expect(changes).toHaveLength(1);
  });
});

describe("mobile live event hub", () => {
  test("coalesces the same task window while keeping distinct keys", () => {
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const hub = new MobileLiveEventHub({
      coalesceMs: 150,
      setTimer: (callback, delayMs) => {
        timers.push({ callback, delayMs });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    const received: MobileLiveEvent[] = [];
    hub.subscribe((event) => received.push(event));

    hub.publish({
      kind: "conversation",
      adapter: "codex",
      threadId: "task-1",
      revision: "revision-1",
    });
    hub.publish({
      kind: "conversation",
      adapter: "codex",
      threadId: "task-1",
      revision: "revision-2",
    });
    hub.publish({ kind: "tasks", adapter: "codex" });

    expect(timers).toHaveLength(2);
    expect(received).toEqual([]);
    timers[0]?.callback();
    timers[1]?.callback();
    expect(received).toEqual([
      {
        kind: "conversation",
        adapter: "codex",
        threadId: "task-1",
        revision: "revision-2",
      },
      { kind: "tasks", adapter: "codex" },
    ]);
  });

  test("supports unsubscribing and isolates listener failures", () => {
    const hub = new MobileLiveEventHub({ coalesceMs: 0 });
    const received: MobileLiveEvent[] = [];
    hub.subscribe(() => {
      throw new Error("broken live client");
    });
    const unsubscribe = hub.subscribe((event) => received.push(event));

    hub.publish({ kind: "tasks", adapter: "codex" });
    expect(received).toEqual([{ kind: "tasks", adapter: "codex" }]);

    unsubscribe();
    hub.publish({ kind: "tasks", adapter: "claude" });
    expect(received).toHaveLength(1);
  });

  test("strictly validates event shapes and payload limits", () => {
    expect(isMobileLiveEvent({
      kind: "conversation",
      adapter: "codex",
      threadId: "task-1",
      revision: "abcdef",
    })).toBe(true);
    expect(isMobileLiveEvent({ kind: "tasks", adapter: "codex" })).toBe(true);
    expect(isMobileLiveEvent({ kind: "tasks", adapter: "codex", extra: true })).toBe(false);
    expect(isMobileLiveEvent({ kind: "tasks", adapter: "codex", threadId: "task" })).toBe(false);
    expect(isMobileLiveEvent({ kind: "unknown", adapter: "codex" })).toBe(false);
    expect(isMobileLiveEvent({
      kind: "conversation",
      adapter: "c".repeat(201),
      threadId: "task",
      revision: "revision",
    })).toBe(false);
    expect(isMobileLiveEvent({
      kind: "conversation",
      adapter: "codex",
      threadId: "t".repeat(201),
      revision: "revision",
    })).toBe(false);
    expect(isMobileLiveEvent({
      kind: "conversation",
      adapter: "codex",
      threadId: "task",
      revision: "r".repeat(81),
    })).toBe(false);
    expect(isMobileLiveEvent(null)).toBe(false);
    expect(isMobileLiveEvent([])).toBe(false);
  });
});

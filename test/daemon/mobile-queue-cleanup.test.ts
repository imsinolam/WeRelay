import { describe, expect, test } from "bun:test";
import { CODEX_MOBILE_JS } from "../../src/daemon/codex-mobile-web.ts";

function queueFunction(name: string, state: Record<string, unknown> = {}) {
  const start = CODEX_MOBILE_JS.indexOf("  function " + name + "(");
  const end = CODEX_MOBILE_JS.indexOf("\n  function ", start + 1);
  const asyncEnd = CODEX_MOBILE_JS.indexOf("\n  async function ", start + 1);
  if (start < 0) throw new Error("Missing queue function: " + name);
  const source = CODEX_MOBILE_JS.slice(start, Math.min(...[end, asyncEnd].filter(index => index >= 0)));
  // reconcilePendingQueueState 依赖待发送确认判定与超时常量。
  const guardStart = CODEX_MOBILE_JS.indexOf("  var PENDING_CONFIRMATION_TIMEOUT_MS");
  const guardEnd = CODEX_MOBILE_JS.indexOf("\n  function reconcilePendingQueueState", guardStart);
  const guard = guardStart >= 0 && guardEnd > guardStart
    ? CODEX_MOBILE_JS.slice(guardStart, guardEnd)
    : "";
  return new Function("state", "effectiveRunSummary", guard + source + "\nreturn " + name + ";")(state, () => null);
}

const pending = { clientId: "client-1", text: "继续检查", status: "queued", imageCount: 0, queuedMessageId: "queue-1", displayInTranscript: false };
const native = { id: "queue-1", text: pending.text, imageCount: 0, createdAtMs: 100 };

describe("mobile queue cleanup", () => {
  test("invalidates the queue when only provisional state changes", () => {
    const state = { serverMessages: [], pendingMessages: [{ ...pending }] };
    const signature = queueFunction("queuedMessagesRenderSignature", state);
    const before = signature([]);
    state.pendingMessages[0]!.status = "delivered";
    expect(signature([])).not.toBe(before);
    state.pendingMessages = [];
    expect(signature([])).not.toBe(before);
  });

  test("does not resurrect a consumed native queue item from its provisional twin", () => {
    const merge = queueFunction("mergeQueuedMessagesForDisplay");
    expect(merge([native], [pending], [{ role: "user", text: pending.text, turnId: "turn" }],
      { status: "running", turnId: "turn", startedAtMs: 200 })).toEqual([]);
  });

  test("delivery receipts remove queue decoration without requiring the native page to be loaded", () => {
    const merge = queueFunction("mergeQueuedMessagesForDisplay");
    expect(merge([], [{ ...pending, status: "delivered", deliveryConfirmed: true }], [], null)).toEqual([]);
  });

  test("keeps genuine queues and unknown snapshots, but preserves missing queue content in the transcript", () => {
    const state = { pendingMessages: [{ ...pending, queueMissing: true }] };
    const reconcile = queueFunction("reconcilePendingQueueState", state);
    reconcile();
    expect(state.pendingMessages[0]).toMatchObject({ displayInTranscript: true, queueMissing: true });
    expect(state.pendingMessages[0]!.text).toBe(pending.text);
    state.pendingMessages[0]!.queueMissing = false;
    reconcile();
    expect(state.pendingMessages[0]!.displayInTranscript).toBe(false);
  });

  test("persists queue identity and unresolved state across browser restoration", () => {
    const sanitize = queueFunction("sanitizePersistentMessage");
    expect(sanitize({ ...pending, queueMissing: true })).toMatchObject({ queuedMessageId: "queue-1", queueMissing: true });
  });

  test("confirmed cancellations remove provisional queue and transcript copies", () => {
    const state = { pendingMessages: [{ ...pending, status: "cancelled" }] };
    queueFunction("reconcilePendingQueueState", state)();
    expect(state.pendingMessages).toEqual([]);
    expect(queueFunction("mergeQueuedMessagesForDisplay")([], [{ ...pending, status: "cancelled" }], [], null)).toEqual([]);
  });

  test("unknown queue state is not treated as missing", () => {
    const state = { pendingMessages: [{ ...pending }] };
    queueFunction("reconcilePendingQueueState", state)();
    expect(state.pendingMessages).toEqual([pending]);
  });

  test("different client ids never hide intentional repeated input", () => {
    const merge = queueFunction("mergeQueuedMessagesForDisplay");
    expect(merge([{ ...native, clientId: "new" }], [],
      [{ role: "user", text: native.text, clientId: "old", turnId: "turn" }],
      { status: "running", turnId: "turn", startedAtMs: 200 })).toHaveLength(1);
  });
});

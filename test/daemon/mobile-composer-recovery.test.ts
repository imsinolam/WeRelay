import { expect, test } from "bun:test";
import { CODEX_MOBILE_APP_JS } from "../../src/daemon/codex-mobile-web.ts";
import { composerHarness } from "./helpers/chat-components.ts";
import { normalizeMobileMessageText } from "../../src/daemon/mobile-message-text.ts";

function block(from: string, to: string) {
  const start = CODEX_MOBILE_APP_JS.indexOf(from);
  const end = CODEX_MOBILE_APP_JS.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`Missing ${from}/${to}`);
  return CODEX_MOBILE_APP_JS.slice(start, end);
}

function harness(api: (...args: any[]) => Promise<unknown>, timeoutMs = 30_000) {
  const state: any = { currentAdapter: "codex", currentThreadId: "task", authenticated: true,
    pendingMessages: [], outboundMessages: [], conversationSnapshots: {}, sending: false };
  const noop = () => {};
  const runtime = new Function("state", "api", "normalizeMobileMessageText", "setTimeout", "clearTimeout", `
    var navigator = { onLine: true };
    function renderMessages() {} function updateHeader() {} function saveCurrentConversationSnapshot() {}
    function persistMobileCacheNow() {} function cancelConversationEntryFocus() {}
    async function restorePendingMessageImages() { if (state.restoreImages) await state.restoreImages(); }
    async function persistPendingMessageImages() {}
    function adapterApiPath(path) { return path; } function renderQueuedMessages() {}
    function migrateTemporaryConversation() {} function loadMessages() {}
    function isNativeComposerDraftConflict() { return false; }
    function pendingImageStoreOperation() { return Promise.resolve(); }
    function currentPendingDelivery() { return state.pendingMessages[0] || null; }
    ${block("  function pendingMessagesForTarget(", "  function beginOptimisticRunIfNeeded(")}
    ${block("  function reconcilePendingMessages(", "  function runHeaderInsertIndex(")}
    ${block("  function shouldBlockComposerForDelivery(", "  function updateHeader(")}
    return { submitPendingMessage, reconcilePendingMessages, shouldBlockComposerForDelivery };
  `)(state, api, normalizeMobileMessageText,
    (fn: () => void, ms: number) => ms === 30_000 ? setTimeout(fn, timeoutMs) : noop(), clearTimeout);
  function pending(clientId: string, overrides = {}) {
    const value = { clientId, adapter: "codex", threadId: "task", text: clientId, createdAtMs: Date.now(), baselineUserKeys: [], ...overrides };
    state.pendingMessages.push(value); return value as any;
  }
  return { state, pending, ...runtime };
}

test("a completed task with a retained receipt still lets users send new text or images", () => {
  const h = harness(async () => ({}));
  for (const content of ["text", "image"]) {
    h.state.sending = true;
    const blocked = h.shouldBlockComposerForDelivery(true, { status: "completed" });
    const ui = composerHarness();
    ui.view.updateAction({ stopMode: false, stopRequested: false, sending: blocked, enabled: true, hasContent: Boolean(content) });
    expect(ui.part("send-button").disabled).toBe(false);
    expect(ui.part("send-button").dataset.state).toBe("send");
  }
  expect(h.shouldBlockComposerForDelivery(false, { status: "completed" })).toBe(false);
  h.state.activeMessageSubmission = { pending: { adapter: "pi-desktop", threadId: "another" } };
  expect(h.shouldBlockComposerForDelivery(false, null)).toBe(false);
});

test("a native receipt releases a hung POST without replay or losing its attachment", async () => {
  let calls = 0;
  let signal!: AbortSignal;
  const h = harness(async (_path, options) => { calls++; signal = options.signal; return new Promise(() => {}); });
  const first = h.pending("first", { images: [{ fileName: "a.png", dataBase64: "aGVsbG8=" }], imageCount: 1 });
  const sending = h.submitPendingMessage(first);
  await Bun.sleep(0);
  expect(h.state.sending).toBe(true);
  expect(signal.aborted).toBe(false);
  // Task switches restore clones, not the object captured by the original POST.
  h.state.pendingMessages = [{ ...first }];
  h.reconcilePendingMessages([], [], ["first"]);
  await sending;
  expect(h.state.sending).toBe(false);
  expect(first.serverAcknowledged).toBe(true);
  expect(first.images).toHaveLength(1);
  expect(calls).toBe(1);
  expect(signal.aborted).toBe(true);
});

test("an outbox acknowledgement also releases the POST; another task's receipt cannot", async () => {
  const h = harness(async () => new Promise(() => {}));
  const first = h.pending("first");
  const sending = h.submitPendingMessage(first);
  await Bun.sleep(0);
  h.reconcilePendingMessages([], [], ["other"]);
  expect(h.state.sending).toBe(true);
  h.reconcilePendingMessages([], [{ clientId: "first", status: "accepted" }]);
  await sending;
  expect(h.state.sending).toBe(false);
  expect(first.status).toBe("accepted");
});

test("the actual native user message releases its POST before the HTTP acknowledgement", async () => {
  const h = harness(async () => new Promise(() => {}));
  const first = h.pending("first");
  const sending = h.submitPendingMessage(first);
  await Bun.sleep(0);
  h.reconcilePendingMessages([{ id: "native", role: "user", text: "first", turnId: "real-turn", createdAtMs: Date.now() }]);
  await sending;
  expect(h.state.sending).toBe(false);
  expect(first.deliveryConfirmed).toBe(true);
  expect(h.state.pendingMessages).toEqual([]);
});

test("late responses from the released POST cannot unlock or overwrite the next send", async () => {
  let finishFirst!: (value: unknown) => void;
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return calls === 1 ? new Promise(resolve => { finishFirst = resolve; }) : new Promise(() => {});
  });
  const first = h.pending("first");
  const a = h.submitPendingMessage(first);
  await Bun.sleep(0);
  h.reconcilePendingMessages([], [], ["first"]);
  await a;
  const second = h.pending("second");
  const b = h.submitPendingMessage(second);
  await Bun.sleep(0);
  finishFirst({ status: "sending", turnId: "old-response" });
  await Bun.sleep(0);
  expect(h.state.sending).toBe(true);
  expect(first.status).toBe("delivered");
  h.reconcilePendingMessages([], [], ["second"]);
  await b;
});

test("a lost POST has a bounded wait and retries only the same durable client identity", async () => {
  const bodies: any[] = [];
  const h = harness(async (_path, options) => { bodies.push(JSON.parse(options.body)); return new Promise(() => {}); }, 5);
  const first = h.pending("first", { images: [{ fileName: "a.png", dataBase64: "aGVsbG8=" }], imageCount: 1 });
  await h.submitPendingMessage(first);
  expect(h.state.sending).toBe(false);
  expect(first.status).toBe("retrying");
  expect(first.inFlight).toBe(false);
  expect(first.images).toHaveLength(1);
  expect(bodies.map(body => body.clientId)).toEqual(["first"]);
});

test("a slow attachment restore cannot hold the composer forever or send after its attempt expired", async () => {
  let resume!: () => void;
  let posts = 0;
  const h = harness(async () => { posts++; return { status: "accepted" }; }, 5);
  h.state.restoreImages = () => new Promise<void>(resolve => { resume = resolve; });
  const first = h.pending("first", { imageCount: 1, images: [{ fileName: "a.png", dataBase64: "aGVsbG8=" }] });
  const attempt = h.submitPendingMessage(first);
  await Bun.sleep(15);
  expect(h.state.sending).toBe(false);
  expect(first.status).toBe("retrying");
  resume();
  await attempt;
  await Bun.sleep(0);
  expect(posts).toBe(0);
  expect(first.images).toHaveLength(1);
});

test("taskSettings is included in the next message request without a model confirmation step", async () => {
  const bodies: any[] = [];
  const h = harness(async (_path, options) => {
    bodies.push(JSON.parse(options.body));
    return { status: "accepted" };
  });
  const first = h.pending("first", { taskSettings: { model: "fixture-model" } });
  await h.submitPendingMessage(first);
  expect(first.status).toBe("accepted");
  expect(h.state.sending).toBe(false);
  expect(first.inFlight).toBe(false);
  expect(bodies).toEqual([expect.objectContaining({
    clientId: "first",
    taskSettings: { model: "fixture-model" },
  })]);
});

test("server outbox updates preserve local image preview and original bytes", () => {
  const h = harness(async () => ({}));
  const image = { fileName: "draft.png", dataBase64: "cHJldmlldw==", previewUrl: "data:image/png;base64,cHJldmlldw==" };
  const pending = h.pending("photo", { images: [image], imageCount: 1 });
  h.reconcilePendingMessages([], [{ clientId: "photo", status: "failed", images: [{ source: "remote", url: "/image-expiring" }] }]);
  expect(pending.images[0]).toMatchObject(image);
  expect(pending.images[0].url).toBe("/image-expiring");
});

test("native acknowledgement retains the already visible image when the transcript has no image yet", () => {
  const h = harness(async () => ({}));
  const image = { fileName: "draft.png", previewUrl: "data:image/png;base64,cHJldmlldw==", dataBase64: "cHJldmlldw==" };
  h.pending("photo", { images: [image], imageCount: 1 });
  const native: any = { id: "native", role: "user", clientId: "photo", text: "photo" };
  h.reconcilePendingMessages([native]);
  expect(h.state.pendingMessages).toHaveLength(0);
  expect(native.images[0].previewUrl).toBe(image.previewUrl);
  expect(native.images[0].dataBase64).toBeUndefined();
});

test("later transcript polls retain the same local image preview after pending acknowledgement", () => {
  const merge = new Function(block("  function messagePageKey(", "  function rebuildServerMessages(") + "\nreturn mergeMessagePages;")();
  const original = { id: "native", role: "user", text: "photo", clientId: "photo", images: [{ previewUrl: "data:image/png;base64,cHJldmlldw==" }] };
  const next = merge([original], [{ id: "native", role: "user", text: "photo", images: [{ url: "/server-image" }] }]);
  expect(next[0].clientId).toBe("photo");
  expect(next[0].images[0]).toEqual({ previewUrl: original.images[0]!.previewUrl, url: "/server-image" });
  expect(merge(next, [{ id: "native", role: "user", text: "photo" }])[0].images).toEqual(next[0].images);
  expect(merge([original], [{ id: "other", role: "user", text: "photo" }])[1].images).toBeUndefined();
});

test("transcript selection handler never changes a focused native input selection", () => {
  const start = CODEX_MOBILE_APP_JS.indexOf('  document.addEventListener("selectionchange",');
  const end = CODEX_MOBILE_APP_JS.indexOf('  document.addEventListener("click",', start);
  let handler!: () => void;
  let clamps = 0;
  const input = { tagName: "TEXTAREA" };
  const doc = { activeElement: input as unknown, addEventListener: (_: string, fn: () => void) => { handler = fn; } };
  const run = new Function("document", "composerInput", "clampSelectionToMessageContent", `
    var activeMessageSelectionScope = {isConnected:true}; var clampingMessageSelection=false;
    var taskContextMenu={hidden:true}; var window={getSelection(){return {}}};
    function hasActiveTextSelection(){return true} function clearActiveTextSelection(){throw Error("native selection cleared")}
    ${CODEX_MOBILE_APP_JS.slice(start,end)}
    return {setScope(){activeMessageSelectionScope={isConnected:true}}};
  `)(doc, input, () => { clamps++; });
  handler(); expect(clamps).toBe(0);
  run.setScope(); doc.activeElement = { tagName: "INPUT" }; handler(); expect(clamps).toBe(0);
  run.setScope(); doc.activeElement = null; handler(); expect(clamps).toBe(1);
});

test("image continuity does not discard additional native attachments", () => {
  const merge = new Function(block("  function messagePageKey(", "  function rebuildServerMessages(") + "\nreturn mergeMessagePages;")();
  const original = { id: "native", role: "user", text: "photo", images: [{ previewUrl: "data:image/png;base64,cHJldmlldw==" }] };
  const result = merge([original], [{ id: "native", role: "user", text: "photo", images: [{ url: "/one" }, { url: "/two" }] }]);
  expect(result[0].images).toHaveLength(2);
  expect(result[0].images[1].url).toBe("/two");
});

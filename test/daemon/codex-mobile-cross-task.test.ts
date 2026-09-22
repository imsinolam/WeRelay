import { expect, test } from "bun:test";
import { CODEX_MOBILE_JS, CODEX_MOBILE_CSS } from "../../src/daemon/codex-mobile-web.ts";
import { createCodexMobileTranscriptRevision } from "../../src/daemon/codex-mobile-server.ts";

function helpers(state: Record<string, unknown>) {
  const start = CODEX_MOBILE_JS.indexOf("  function messageNodeBaseKey");
  const end = CODEX_MOBILE_JS.indexOf("\n  function renderResponsePendingIndicator", start);
  return new Function("state", "document", `
    function escapeHtml(text) { return String(text).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
    function renderMarkdown(text) { return escapeHtml(text); }
    function renderMessageImages() { return ''; }
    function visibleMessageText(m) { return m.text; }
    function visibleMessageModel() { return ''; }
    function effectiveRunSummary() { return { status: 'completed', turnId: 'turn', completedAtMs: 9000 }; }
    function formatClockTime(ms) { return String(ms); }
    function currentAdapterName() { return 'Codex'; }
    function bindMessageImageActions() {}
    ${CODEX_MOBILE_JS.slice(start, end)}
    return { renderMessageRow, resolveMessageFooter, getMessageNode, messageNodeKey };
  `)(state, { createElement: () => ({querySelector: () => null}) });
}
const message = { role: "task" as const, id: "handoff", text: "已确认候选。", turnId: "turn", createdAtMs: 1000,
  sourceTask: {adapter: "codex", sessionId: "source-task"} };

test("cross-task rows display escaped provenance and received time, never completion time", () => {
  const state = { currentAdapter: "codex", tasks: [{threadId: "source-task", adapter: "codex", title: "发布 <任务>"}], messageNodes: {} };
  const h = helpers(state);
  const row = h.renderMessageRow(message, 0, undefined, "handoff", true);
  expect(row.className).toBe("message-row task");
  expect(row.innerHTML).toContain("来自 Codex 任务 · 发布 &lt;任务&gt;");
  expect(row.innerHTML).toContain("已确认候选。");
  expect(row.innerHTML).toContain("收到于 1000");
  expect(row.innerHTML).not.toContain("完成于");
  expect(CODEX_MOBILE_CSS).toContain(".message-row.task .message-card");
});
test("source identity survives message cache and different source messages do not share fallback keys", () => {
  const state = {currentAdapter: "codex", tasks: [] as Record<string, unknown>[], messageNodes: {}};
  const h = helpers(state);
  const first = h.getMessageNode(message, 0, undefined, "handoff", true);
  expect(first.innerHTML).toContain("来自 Codex 任务 · source-t");
  state.tasks.push({threadId: "source-task", adapter: "codex", title: "发布与部署"});
  const second = h.getMessageNode(message, 0, undefined, "handoff", true);
  expect(second).not.toBe(first);
  expect(second.innerHTML).toContain("发布与部署");
  const other = {...message, id: undefined, sourceTask: {adapter: "codex", sessionId: "another-task"}};
  expect(h.messageNodeKey({...message, id: undefined}, 0)).not.toBe(h.messageNodeKey(other, 0));
  const transcript = {threadId: "task", messages: [message], queuedMessages: []};
  expect(createCodexMobileTranscriptRevision(transcript)).not.toBe(
    createCodexMobileTranscriptRevision({...transcript, messages: [{...message, sourceTask: other.sourceTask}]}));
});

test("persistent conversation cache preserves source identity without retaining arbitrary metadata", () => {
  const start = CODEX_MOBILE_JS.indexOf("  function sanitizePersistentMessage(");
  const end = CODEX_MOBILE_JS.indexOf("\n  function sanitizePersistentMessages", start);
  const sanitize = new Function(`${CODEX_MOBILE_JS.slice(start, end)}; return sanitizePersistentMessage;`)();
  const cached = sanitize({...message, sourceTask: {...message.sourceTask, privateField: "do not retain"}});
  expect(cached.sourceTask).toEqual(message.sourceTask);
  expect(cached.role).toBe("task");
  const last = {role: "assistant" as const, text: "收到确认", id: "last"};
  const transcript = {threadId: "task", messages: [last], queuedMessages: []};
  expect(createCodexMobileTranscriptRevision(transcript)).not.toBe(
    createCodexMobileTranscriptRevision({...transcript, messages: [message, last]}));
});

test("a turn triggered by a task message puts new progress after that message", () => {
  const start = CODEX_MOBILE_JS.indexOf("  function runHeaderInsertIndex");
  const end = CODEX_MOBILE_JS.indexOf("\n  function isVisibleConversationMessage", start);
  const insert = new Function(`${CODEX_MOBILE_JS.slice(start, end)}; return runHeaderInsertIndex;`)();
  const messages = [{role: "user", text: "earlier", turnId: "old"}, {role: "assistant", text: "done", turnId: "old"}, message];
  expect(insert(messages, {turnId: "turn", status: "running"})).toBe(3);
});

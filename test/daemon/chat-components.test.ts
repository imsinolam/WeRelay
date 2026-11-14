import { expect, test } from "bun:test";
import { CHAT_COMPONENTS_JS, CHAT_COMPONENTS_CSS, renderChatComposerHtml } from "../../src/web/chat-components/index.ts";
import { CHAT_COMPOSER_JS } from "../../src/web/chat-components/composer.ts";
import { CODEX_MOBILE_HTML, CODEX_MOBILE_JS } from "../../src/daemon/codex-mobile-web.ts";
import { composerHarness, ChatElement } from "./helpers/chat-components.ts";

function components() {
  return new Function(CHAT_COMPONENTS_JS + "; return WeRelayChatUI;")();
}

test("chat components can load without the taskboard, network or browser globals", () => {
  const ui = components();
  expect(typeof ui.createText).toBe("function");
  expect(typeof ui.createMessageBubble).toBe("function");
  expect(typeof ui.createComposer).toBe("function");
  expect(CHAT_COMPONENTS_JS).not.toMatch(/\b(?:fetch|localStorage|sessionStorage)\b|\/api\//);
});

test("text rendering is escaped and tool groups retain the trailing conclusion", () => {
  const text = components().createText();
  const html = text.renderMarkdown("<script>bad()</script>\n```bash\npwd\n```\n然后\n```sh\nls\n```\n检查完成", "fixture");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain('class="message-tools-group"');
  expect(html).toContain('data-fold-key="fixture:tools-1"');
  expect(html.endsWith("<p>检查完成</p>")).toBe(true);
  expect(html).not.toContain(" open");
});

test("link routing is injected rather than coupled to the mobile preview server", () => {
  const ui = components();
  const normal = ui.createText();
  const routed = ui.createText({ resolveLink: (target: string) => ({ href: "/preview?file=" + encodeURIComponent(target), localPreview: true }) });
  expect(normal.renderMarkdown("[页面](/example.html)")).toContain('href="/example.html"');
  expect(routed.renderMarkdown("[页面](/example.html)")).toContain('href="/preview?file=%2Fexample.html"');
});

test("composer markup is complete and can be mounted twice without duplicate IDs", () => {
  const one = renderChatComposerHtml("first");
  const two = renderChatComposerHtml("second");
  const ids = [...(one + two).matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const part of ["composer-input", "composer-image-input", "composer-media", "composer-queue", "composer-model-menu", "composer-session-menu", "send-button", "send-running-orb"]) {
    expect(one).toContain('data-chat-part="' + part + '"');
  }
  expect(CODEX_MOBILE_HTML).toContain(renderChatComposerHtml());
  expect(CODEX_MOBILE_JS).toContain("WeRelayChatUI.createComposer(");
  expect(CODEX_MOBILE_JS).toContain("messageBubble.render(");
  expect(CHAT_COMPONENTS_CSS).toContain("prefers-reduced-motion");
  expect(CHAT_COMPONENTS_CSS).toContain(".composer textarea {");
  expect(CHAT_COMPONENTS_CSS).toContain("max-height: 164px");
  const resizeStart = CHAT_COMPOSER_JS.indexOf("  function resize()");
  const resizeEnd = CHAT_COMPOSER_JS.indexOf("\n  function renderNotice", resizeStart);
  expect(CHAT_COMPOSER_JS.slice(resizeStart, resizeEnd))
    .not.toMatch(/composerInput\.(?:value|selectionStart|selectionEnd)\s*=(?!=)/);
  expect(CHAT_COMPOSER_JS).toContain("function measureContentHeight(style)");
  expect(CHAT_COMPOSER_JS).toContain('on(composerInput, "compositionstart"');
  expect(CHAT_COMPOSER_JS).toContain('on(composerInput, "compositionend"');
});

test("composer instances isolate drafts and dispose listeners and scheduled work", () => {
  let firstSends = 0;
  let secondSends = 0;
  const first = composerHarness({ onSubmit: () => firstSends++ });
  const second = composerHarness({ onSubmit: () => secondSends++ });
  first.view.setValue("第一条");
  second.view.setValue("第二条");
  first.part("composer-input").emit("keydown", { key: "Enter", ctrlKey: true });
  expect([firstSends, secondSends]).toEqual([1, 0]);
  expect(second.view.getValue()).toBe("第二条");
  first.view.destroy();
  first.root.emit("submit");
  expect(firstSends).toBe(1);
  expect(first.frames.size).toBe(0);
  expect([...first.document.listeners.values()].every(set => set.size === 0)).toBe(true);
  second.root.emit("submit");
  expect(secondSends).toBe(1);
  second.view.destroy();
});

test("composer grows to its cap without collapsing and keeps a middle caret in place", () => {
  const resizes: number[] = [];
  const h = composerHarness({ onResize: (height: number) => resizes.push(height) });
  const input = h.part("composer-input");
  input.value = "第一行\n第二行\n第三行\n第四行";
  input.scrollHeight = 260;
  input.scrollTop = 48;
  input.selectionStart = 5;
  input.selectionEnd = 5;

  input.emit("input", { isComposing: false });
  const historyAtCap = input.styleHistory.length;
  input.value += "\n第五行";
  input.scrollHeight = 280;
  input.emit("input", { isComposing: false });

  expect(input.style.height).toBe("164px");
  expect(input.scrollTop).toBe(48);
  expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5]);
  expect(input.value).toBe("第一行\n第二行\n第三行\n第四行\n第五行");
  expect(input.styleHistory.slice(historyAtCap)).toEqual([]);
  expect(input.style.height).toBe("164px");
  expect(h.measurements).toContain("164px");
  expect(resizes).toEqual([]);
  h.view.destroy();
});

test("composer reveals the complete last visual line below the capped viewport", () => {
  const h = composerHarness();
  const input = h.part("composer-input");
  input.value = "第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行\n第八行";
  input.scrollHeight = 260;
  input.scrollTop = 0;
  input.selectionStart = input.value.length;
  input.selectionEnd = input.selectionStart;

  input.emit("input");

  expect(input.style.height).toBe("164px");
  expect(input.scrollTop).toBe(96);
  h.view.destroy();
});

test("composer leaves scrolling untouched while editing between long-text lines", () => {
  const h = composerHarness();
  const input = h.part("composer-input");
  input.value = "第一行\n第二行\n第三行\n第四行\n第五行\n第六行\n第七行\n第八行";
  input.scrollHeight = 260;
  input.scrollTop = 36;
  input.selectionStart = 22;
  input.selectionEnd = 22;

  input.emit("input", { isComposing: false, inputType: "insertText" });
  const historyAtCap = input.styleHistory.length;
  input.value += "\n第九行";
  input.emit("input", { isComposing: false, inputType: "insertText" });

  expect(input.style.height).toBe("164px");
  expect(input.scrollTop).toBe(36);
  expect(input.styleHistory.slice(historyAtCap)).toEqual([]);
  expect(input.style.height).toBe("164px");
  h.view.destroy();
});

test("composer leaves value, selection and scrolling alone during composition and resumes after compositionend", () => {
  const h = composerHarness();
  const input = h.part("composer-input");
  input.value = "拼音";
  input.scrollHeight = 260;
  input.scrollTop = 48;
  input.selectionStart = 1;
  input.selectionEnd = 2;
  input.emit("compositionstart");
  input.emit("input", { isComposing: true, keyCode: 229, inputType: "insertCompositionText" });

  expect(input.style.height).toBeUndefined();
  expect([input.value, input.selectionStart, input.selectionEnd, input.scrollTop]).toEqual(["拼音", 1, 2, 48]);

  input.value = "拼音输入完成\n第二行";
  input.scrollHeight = 60;
  input.emit("compositionend", { isComposing: false });
  input.emit("input", { isComposing: false });
  expect(input.style.height).toBe("60px");
  expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(["拼音输入完成\n第二行", 1, 2]);
  h.view.destroy();
});

test("composer restores one row after shorten, clear and programmatic draft restore", () => {
  const h = composerHarness();
  const input = h.part("composer-input");
  input.scrollHeight = 260;
  input.emit("input", { isComposing: false });
  expect(input.style.height).toBe("164px");

  input.value = "短文本";
  input.selectionStart = input.value.length;
  input.selectionEnd = input.selectionStart;
  input.scrollHeight = 36;
  input.scrollTop = 70;
  input.emit("input", { isComposing: false });
  expect(input.style.height).toBe("36px");

  h.view.setValue("");
  input.scrollHeight = 36;
  expect(input.style.height).toBe("36px");
  expect(h.view.getValue()).toBe("");
  h.view.destroy();
});

test("composer does not rewrite value or selection while measuring a long draft", () => {
  const h = composerHarness();
  const input = h.part("composer-input");
  const draft = "第一行\n第二行\n第三行\n第四行\n第五行\n第六行";
  input.scrollHeight = 180;
  input.scrollTop = 16;
  input.selectionStart = 4;
  input.selectionEnd = 9;

  h.view.setValue(draft);

  expect(input.style.height).toBe("164px");
  expect(input.value).toBe(draft);
  expect([input.selectionStart, input.selectionEnd, input.scrollTop]).toEqual([4, 9, 16]);
  h.view.destroy();
});

test("send, admission, running and stopping keep their button semantics", () => {
  const h = composerHarness();
  const button = h.part("send-button");
  h.view.updateAction({ enabled: true, hasContent: true });
  expect([button.dataset.state, button.disabled, button.attributes["aria-label"]]).toEqual(["send", false, "发送"]);
  h.view.updateAction({ enabled: true, sending: true });
  expect([button.dataset.state, button.disabled, button.attributes["aria-busy"]]).toEqual(["pending", true, "true"]);
  h.view.updateAction({ enabled: true, stopMode: true });
  expect([button.dataset.state, button.disabled, button.attributes["aria-label"]]).toEqual(["running", false, "停止"]);
  h.view.updateAction({ enabled: true, stopMode: true, stopRequested: true });
  expect([button.dataset.state, button.disabled, button.attributes["aria-label"]]).toEqual(["stopping", true, "正在停止"]);
  h.view.destroy();
});

test("queue and image actions use callbacks without mutating host messages", () => {
  const calls: string[] = [];
  const h = composerHarness({ onQueueSteer: (id: string) => calls.push("steer:" + id),
    onQueueEdit: (m: any) => calls.push("edit:" + m.id), onQueueDelete: (id: string) => calls.push("delete:" + id),
    onImageRemove: (id: string) => calls.push("image:" + id) });
  const message = Object.freeze({ id: "queued", text: "等待发送", status: "queued" });
  h.view.renderQueue([message], {});
  const buttons = h.part("composer-queue").all().filter(el => el.className.includes("queued-followup-action") && !el.className.includes("queued-followup-actions"));
  buttons.forEach(el => el.emit("click"));
  h.view.renderImages([{ id: "photo", previewUrl: "data:image/png;base64,AA==", fileName: "示例" }]);
  h.part("composer-media").all().find(el => el.className === "composer-media-remove")!.emit("click");
  expect(calls).toEqual(["steer:queued", "edit:queued", "delete:queued", "image:photo"]);
  expect(message.status).toBe("queued");
  h.view.destroy();
  buttons.forEach(el => el.emit("click"));
  expect(calls).toHaveLength(4);
});

test("model grouping, selection and stable reasoning nodes are component-owned", () => {
  const selected: string[] = [];
  const h = composerHarness({ onModelSelect: (id: string) => selected.push(id), onModelGroup: (id: string) => selected.push(id) });
  const view = { visible: true, open: true, canChange: true, value: "a", activeGroup: null,
    options: [{ id: "a", label: "模型 A", group: "来源 A" }, { id: "b", label: "模型 B", group: "来源 B" }] };
  h.view.renderModel(view);
  h.part("composer-model-menu").children[1]!.emit("click");
  h.view.renderModel({ ...view, activeGroup: "来源 B" });
  h.part("composer-model-menu").children[1]!.emit("click");
  expect(selected).toEqual(["来源 B", "b"]);
  h.view.destroy();
});

test("message bubble renders escaped text, source, footer and retained failure actions", () => {
  const ui = components();
  const bubble = ui.createMessageBubble({ document: { createElement: () => new ChatElement() } });
  const row = bubble.render({ id: "pending-one", message: { role: "user", clientId: "one", pending: true, status: "failed", text: "保留的消息" },
    text: "保留的消息 <script>", footer: { time: "今天", model: "示例" },
    delivery: { text: "提交失败", failed: true, retryLabel: "重新提交", copy: true } });
  expect(row.id).toBe("pending-one");
  expect(row.className).toBe("message-row user failed");
  expect(row.innerHTML).toContain("&lt;script&gt;");
  expect(row.innerHTML).toContain('data-retry="one"');
  expect(row.innerHTML).toContain('data-copy-message="one"');
  expect(row.innerHTML).toContain("message-model");
});

test("tool progress and response activity render without taskboard state", () => {
  const text = components().createText();
  const document = { createElement: () => new ChatElement() };
  const progress = text.renderProgressList(document, [
    ...Array.from({ length: 5 }, (_, i) => ({ text: "已完成步骤 " + i, status: "completed" })),
    { text: "当前步骤 <script>", status: "running" },
  ], "示例 Agent");
  expect(progress.innerHTML).toContain("之前 2 条进展");
  expect(progress.innerHTML).toContain('class="run-progress-item running"');
  expect(progress.innerHTML).toContain("&lt;script&gt;");
  const pending = text.renderPendingIndicator(document, "正在执行");
  expect(pending.attributes["aria-label"]).toBe("正在执行");
  expect(pending.innerHTML).toContain("agent-planning-dots");
});


test("composer measures soft-wrapped lines and shrinks below the cap without resetting its live height", () => {
  const h = composerHarness();
  const input = h.part("composer-input");
  input.value = "自动折行".repeat(60);
  input.selectionStart = input.selectionEnd = input.value.length;
  input.scrollHeight = 468;
  input.emit("input");
  expect([input.style.height, input.scrollTop]).toEqual(["164px", 304]);
  input.value = "短文本";
  input.scrollHeight = 36;
  input.selectionStart = input.selectionEnd = input.value.length;
  h.view.resize();
  expect(input.style.height).toBe("36px");
  expect(input.styleHistory.some(entry => entry.height === "auto" || entry.height === "0px")).toBe(false);
  h.view.destroy();
});

test("IME keycode 229 cannot submit a message before composition completes", () => {
  let sends = 0;
  const h = composerHarness({ onSubmit: () => sends++ });
  h.part("composer-input").emit("keydown", { key: "Enter", ctrlKey: true, keyCode: 229 });
  h.part("composer-input").emit("compositionstart");
  h.part("composer-input").emit("keydown", { key: "Enter", ctrlKey: true });
  expect(sends).toBe(0);
  h.part("composer-input").emit("compositionend");
  h.part("composer-input").emit("keydown", { key: "Enter", ctrlKey: true });
  expect(sends).toBe(1);
  h.view.destroy();
});


test("native field sizing keeps height and scroll under browser control including composition", () => {
  const h = composerHarness({}, true);
  const input = h.part("composer-input");
  input.value = "长文本".repeat(200);
  input.selectionStart = input.selectionEnd = input.value.length;
  input.scrollTop = 32;
  input.emit("input");
  h.view.resize();
  input.emit("compositionstart");
  input.emit("input", {isComposing:true});
  input.emit("compositionend");
  expect(input.styleHistory).toEqual([]);
  expect(input.scrollTop).toBe(32);
  expect(h.root.children).toHaveLength(0);
  h.view.destroy();
});

test("background resizing never drags a manually scrolled draft back to its last caret", () => {
  const h = composerHarness();
  const input = h.part("composer-input");
  input.value = "长文本".repeat(200);
  input.scrollHeight = 500;
  input.selectionStart = input.selectionEnd = input.value.length;
  input.scrollTop = 24;
  h.view.resize();
  expect(input.scrollTop).toBe(24);
  h.view.destroy();
});

test("clicking send during composition cannot dispatch unfinished input", () => {
  let sends = 0;
  const h = composerHarness({onSubmit:()=>sends++});
  h.part("composer-input").emit("compositionstart");
  h.root.emit("submit");
  expect(sends).toBe(0);
  h.part("composer-input").emit("compositionend");
  h.root.emit("submit");
  expect(sends).toBe(1);
  h.view.destroy();
});

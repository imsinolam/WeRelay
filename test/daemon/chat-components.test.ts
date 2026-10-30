import { expect, test } from "bun:test";
import { CHAT_COMPONENTS_JS, CHAT_COMPONENTS_CSS, renderChatComposerHtml } from "../../src/web/chat-components/index.ts";
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

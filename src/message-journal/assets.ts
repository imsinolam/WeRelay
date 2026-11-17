import crypto from "node:crypto";
import fs from "node:fs";

const upstream = new URL("../../vendor/message-journal/", import.meta.url);
const read = (name: string) => fs.readFileSync(new URL(name, upstream), "utf8");
const core = read("panel/core.mjs").replace(/export /g, "");
const coreScript = `(function(){${core}\nwindow.JournalCore={AGENTS,dayKey,shiftDay,rankProjects,showMessageTime,sessionKey,groupKey,searchMessages,groupMessages,excerpt,messageIdentity,timeMessages,fitView,taskBranches};})();`;
const css = read("panel/panel.css") + `
:root { --magpie-bg:#fff; --magpie-card:#f7f7f8; --magpie-fg:#171717; --magpie-fg-2:#404040; --magpie-muted:#737373; --magpie-line:#dedede; --magpie-accent:#147d64; --magpie-accent-soft:#e5f3ed; color-scheme:light; }
body { font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; color:var(--j-fg); background:var(--j-bg); }
button,input,select { font:inherit; color:inherit; border:1px solid var(--j-line); border-radius:6px; background:var(--j-card); padding:4px 8px; }
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible { outline:2px solid var(--j-accent); outline-offset:2px; }
.journal-nav { display:flex; align-items:center; flex-wrap:wrap; gap:12px; padding:10px 16px; border-bottom:1px solid var(--j-line); min-height:48px; }
.journal-nav a { color:inherit; text-decoration:none; }.journal-nav strong { flex:1; font-size:14px; }
.journal { height:calc(100dvh - 49px); }
.source-settings { position:fixed; z-index:50; top:58px; right:12px; width:min(440px,calc(100vw - 24px)); max-height:calc(100dvh - 80px); overflow:auto; padding:20px; background:var(--j-bg); border:1px solid var(--j-line); border-radius:12px; box-shadow:0 12px 40px #0002; }
.source-settings p { margin:8px 0 16px; color:var(--j-muted); }.source-options { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px; }.source-options label { display:flex; align-items:center; gap:8px; }
.source-actions { display:flex; gap:8px; }.source-settings [role=status] { margin-top:12px; }
#error { color:var(--j-secondary); }
.journal-latest { margin-left:8px; color:var(--j-accent); background:transparent; }
.mobile-project-more { display:none; }
.journal-search,.journal-filters { display:contents; }
.journal-filter-toggle,.message-read-hint { display:none; }
@media (max-width:900px) {
  html,body { overflow:hidden; }
  body { font-size:16px; }
  .journal-nav { height:56px; min-height:56px; flex-wrap:nowrap; gap:10px; padding:6px 16px; }
  .journal-nav a { display:flex; align-items:center; min-height:44px; font-size:14px; white-space:nowrap; }
  .journal-nav strong { font-size:17px; white-space:nowrap; }
  .journal-nav button { min-height:44px; font-size:14px; padding:8px 10px; }
  .journal { height:calc(100dvh - 56px); padding:4px 16px 0; }
  button:not(.message-bubble),.toolbar input,.toolbar select,.toolbar button { min-height:44px; height:auto; font-size:14px; }
  .toolbar { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; margin:0; }
  .date-stepper { grid-column:1; order:0; margin:0; min-width:0; gap:0; }
  .date-stepper .step { width:44px; flex:none; min-height:44px; font-size:22px!important; }
  .date-label { min-width:88px; padding:0 2px!important; font-size:17px!important; border:0!important; background:transparent!important; font-weight:600; }
  .journal-latest { min-width:44px; flex:none; margin-left:4px; padding:0 6px; border:0; }
  .toolbar-end { grid-column:2; grid-row:1; order:0; margin:0; }
  .toolbar .quiet { font-size:13px; padding:8px 0; }
  .journal-search { grid-column:1 / -1; order:1; display:flex; align-items:center; gap:8px; min-width:0; }
  .toolbar #query { flex:1; min-width:0; width:100%; max-width:none; height:44px; padding:10px 12px; font-size:16px; border-radius:12px; }
  .journal-filter-toggle { display:flex; align-items:center; justify-content:center; flex:none; gap:6px; min-width:64px; padding:8px 10px; border-radius:10px; background:transparent; }
  .journal-filter-toggle[aria-expanded="true"],.journal-filter-toggle[data-active="true"] { color:var(--j-accent); border-color:var(--j-accent); background:var(--j-soft); }
  .journal-filters { grid-column:1 / -1; order:2; display:none; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:8px; padding:4px 0 8px; }
  .journal-filters[data-open="true"] { display:grid; }
  .toolbar #agent,.toolbar #project { order:2; width:100%; max-width:none; min-width:0; padding:8px; font-size:14px; border-radius:10px; }
  .icon-group { grid-column:1 / -1; order:3; justify-content:flex-end; gap:4px; }
  .icon-group .icon-btn { width:44px; }
  .results-head { padding:12px 0 8px; font-size:13px; line-height:1.5; }
  .canvas-hint,.canvas-tools { display:none; }
  #error { font-size:13px; margin:0 0 10px; padding:10px 12px; }
  .canvas { overflow-y:auto; overflow-x:hidden; touch-action:pan-y; cursor:auto; overscroll-behavior-y:contain; padding-bottom:calc(24px + env(safe-area-inset-bottom)); scrollbar-width:thin; scrollbar-color:var(--j-line) transparent; }
  .canvas-world { position:static; transform:none!important; will-change:auto; }
  .project-node { position:static; width:100%; padding:0 0 28px; }
  .project-head { padding:8px 0; gap:8px; }
  .project-toggle { font-size:16px!important; line-height:1.4; }
  .project-count { font-size:13px; }
  .project-content { padding-top:12px; }
  .message-stream { max-height:none; overflow:visible; padding:0; touch-action:auto; }
  .message-bubbles { gap:12px; }
  .bubble-row { align-items:stretch; gap:6px; }
  .bubble-meta { margin:0; font-size:12px; flex-wrap:wrap; line-height:1.5; }
  .bubble-model { max-width:22ch; }
  .message-bubble { width:100%; padding:12px 14px; border-radius:12px; }
  .bubble-text { font-size:16px; line-height:1.6; -webkit-line-clamp:3; }
  .message-read-hint { display:block; margin-top:8px; font-size:12px; color:var(--j-accent); }
  .project-node:not(.mobile-expanded) .bubble-row:nth-child(n+4),.project-node:not(.mobile-expanded) .stream-more { display:none; }
  .mobile-project-more { display:block; width:100%; margin-top:10px; padding:10px; border:0; background:transparent; color:var(--j-accent); }
  .task-branch { margin-left:0; padding-left:12px; }
  .empty { padding:48px 12px; font-size:15px; line-height:1.7; }
  .source-settings,.data-popover { position:fixed; top:auto; bottom:0; left:0; right:0; width:100%; max-height:85dvh; border-radius:20px 20px 0 0; padding:22px 20px calc(24px + env(safe-area-inset-bottom)); box-shadow:0 -8px 32px #0002; }
  .source-settings h2,.popover-head h2 { font-size:18px; }
  .source-settings p,.data-popover { font-size:14px; line-height:1.65; }
  .source-options { gap:4px 12px; }
  .source-options label { min-height:48px; }
  .source-options input { width:20px; height:20px; accent-color:var(--j-accent); }
  .source-actions button { flex:1; min-height:48px; font-size:16px; }
  #sources-save { background:var(--j-accent); border-color:var(--j-accent); color:var(--j-bg); }
  .detail.floating { top:0!important; left:0!important; width:100%!important; height:100dvh; max-height:100dvh!important; border:0; border-radius:0; }
  .detail .popover-head { padding:10px 16px; }
  .detail .icon-close,.data-popover .icon-close { width:44px; height:44px; min-height:44px; }
  .detail-scroll { padding:16px 16px calc(24px + env(safe-area-inset-bottom)); }
  .detail-meta,.scope,.message time { font-size:13px; }
  .scope { min-height:44px; }
  .message { padding:16px 0; }
  .message p { font-size:16px; line-height:1.7; }
}
@media (max-width:360px) { .journal-nav { padding-inline:12px; gap:6px; }.journal-nav a { font-size:12px; }.journal { padding-inline:12px; }.date-label { min-width:76px; font-size:16px!important; }.journal-latest { margin-left:0; }.toolbar-end .quiet { font-size:12px; } }
@media (prefers-color-scheme:dark) { :root { --magpie-bg:#171717; --magpie-card:#242424; --magpie-fg:#ededed; --magpie-fg-2:#d0d0d0; --magpie-muted:#a0a0a0; --magpie-line:#424242; --magpie-accent:#78c9aa; --magpie-accent-soft:#173e31; color-scheme:dark; } }
`;
const hostScript = `(() => {
  const version = "__JOURNAL_VERSION__";
  const form = document.getElementById("source-settings");
  const status = document.getElementById("source-status");
  let initialized = false;
  let saving = false;
  let cached = null;
  let generation = 0;
  const mobile = window.matchMedia?.("(max-width:900px)");
  const expandedProjects = new Set();
  const filters = document.getElementById("journal-filters");
  const filterToggle = document.getElementById("journal-filter-toggle");
  filterToggle?.addEventListener("click", () => {
    const open = filters.dataset.open !== "true";
    filters.dataset.open = String(open); filterToggle.setAttribute("aria-expanded", String(open));
  });
  function updateFilterState() {
    if (!filterToggle) return;
    const count = ["agent", "project"].filter(id => document.getElementById(id).value).length;
    filterToggle.textContent = count ? "筛选 · " + count : "筛选";
    filterToggle.dataset.active = String(count > 0);
  }
  for (const id of ["agent", "project", "reset"]) document.getElementById(id)?.addEventListener(id === "reset" ? "click" : "change", () => setTimeout(updateFilterState, 0));
  const errorNode = document.getElementById("error");
  function quietPartialWarning() {
    if (!errorNode) return;
    const partial = errorNode.textContent === "部分日志被跳过，见右上角“数据详情”。";
    if (partial) errorNode.hidden = true;
    const button = document.getElementById("sources-toggle");
    if (button) button.textContent = partial ? (mobile?.matches ? "详情 · 提示" : "数据详情 · 提示") : "数据详情";
  }
  if (errorNode && typeof MutationObserver === "function") new MutationObserver(quietPartialWarning).observe(errorNode, {childList:true});
  const latestButton = document.getElementById("journal-latest");
  let dayKeys = [];
  function chooseDay(day) {
    const input = document.getElementById("date");
    input.value = day; input.dispatchEvent(new Event("change", {bubbles:true}));
    document.getElementById("canvas").scrollTop = 0;
  }
  latestButton?.addEventListener("click", () => { if (dayKeys.length) chooseDay(dayKeys[dayKeys.length - 1]); });
  for (const [id, direction] of [["prev-day", -1], ["next-day", 1]]) {
    document.getElementById(id)?.addEventListener("click", event => {
      const current = document.getElementById("date").value;
      const day = direction < 0 ? dayKeys.filter(day => day < current).pop() : dayKeys.find(day => day > current);
      if (day) { event.stopImmediatePropagation(); chooseDay(day); }
    }, true);
  }
  function updateReadingState(result) {
    updateFilterState(); quietPartialWarning();
    dayKeys = [...new Set(result.messages.map(message => window.JournalCore.dayKey(message.time)))].sort();
    if (latestButton) latestButton.hidden = !dayKeys.length;
    const current = document.getElementById("date").value;
    document.getElementById("prev-day").disabled = !dayKeys.some(day => day < current);
    document.getElementById("next-day").disabled = !dayKeys.some(day => day > current);
    const empty = document.getElementById("canvas-empty");
    if (result.loading) empty.textContent = "正在读取电脑上的消息，首次扫描需要一些时间…";
    else if (!result.permissions.agents.length) empty.textContent = "还未选择消息来源。点击右上角“读取来源”开始。";
    else if (!result.messages.length) empty.textContent = result.error || "所选来源近 30 天还没有用户消息。可在“数据详情”检查来源是否已读取。";
    else if (!result.messages.some(message => window.JournalCore.dayKey(message.time) === current)) empty.textContent = "这一天没有消息，点击“最近”查看最近有记录的一天。";
    if (mobile?.matches) {
      for (const node of document.querySelectorAll(".project-node")) {
        if (expandedProjects.has(node.dataset.project)) node.classList.add("mobile-expanded");
        for (const bubble of node.querySelectorAll(".message-bubble")) {
          const text = bubble.querySelector(".bubble-text");
          if (text && text.scrollHeight > text.clientHeight + 2 && !bubble.querySelector(".message-read-hint")) {
            const hint = document.createElement("span"); hint.className = "message-read-hint"; hint.textContent = "阅读全文"; bubble.appendChild(hint);
          }
        }
        if (node.querySelector(".mobile-project-more")) continue;
        const rows = node.querySelectorAll(".bubble-row");
        if (rows.length <= 3) continue;
        const button = document.createElement("button"); button.type = "button"; button.className = "mobile-project-more";
        const paint = () => { const open = node.classList.contains("mobile-expanded"); button.textContent = open ? "收起消息" : "展开本项目消息"; button.setAttribute("aria-expanded", String(open)); };
        paint();
        const content = node.querySelector(".project-content");
        button.addEventListener("click", () => {
          const open = !node.classList.contains("mobile-expanded");
          if (open) expandedProjects.add(node.dataset.project); else expandedProjects.delete(node.dataset.project);
          node.classList.toggle("mobile-expanded", open); paint();
          if (open) content.prepend(button); else content.appendChild(button);
          if (!open) node.scrollIntoView({block:"start",behavior:"instant"});
        });
        if (node.classList.contains("mobile-expanded")) content.prepend(button); else content.appendChild(button);
      }
    }
  }
  const list = document.getElementById("list");
  if (list && typeof MutationObserver === "function") {
    new MutationObserver(() => { if (cached) updateReadingState(cached); }).observe(list, {childList:true});
  }
  // Vertical reading uses native scrolling; desktop retains the shared canvas.
  for (const type of ["pointerdown", "wheel", "keydown"]) document.getElementById("canvas")?.addEventListener(type, event => {
    if (mobile?.matches && (type !== "keydown" || event.target === document.getElementById("canvas"))) event.stopImmediatePropagation();
  }, {capture:true});
  const key = new URL(location.href).searchParams.get("key");
  if (key) document.getElementById("journal-back").href = "/?key=" + encodeURIComponent(key);
  async function request(path, body) {
    const startedGeneration = generation;
    const url = new URL("/api/message-journal/" + path, location.origin);
    if (key) url.searchParams.set("key", key);
    if (path === "data" && cached?.revision) url.searchParams.set("revision", cached.revision);
    let response;
    let result;
    try {
      response = await fetch(url, { method:body ? "POST" : "GET", headers:body ? {"Content-Type":"application/json"} : {}, body:body ? JSON.stringify(body) : undefined, cache:"no-store", signal:AbortSignal.timeout(25000) });
      result = await response.json();
    } catch {
      if (!cached && path === "data") {
        document.getElementById("summary").textContent = "暂时未能连接电脑";
        const empty = document.getElementById("canvas-empty");
        empty.hidden = false; empty.textContent = "消息还没有读取成功。请确认电脑在线，再点击刷新。";
      }
      throw new Error(body ? "尚未确认保存结果，正在核对电脑上的读取来源…" : "连接电脑超时或网络中断，请稍后刷新。已有来源设置不会因此丢失。");
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 428) {
        status.textContent = "请先返回任务台登录，再打开消息日历。";
        form.hidden = false;
        throw new Error(status.textContent);
      }
      throw new Error(result.error || "消息日历暂时不可用，请稍后重试。");
    }
    if (path === "data") {
      if (generation !== startedGeneration) return request("data");
      if (result.unchanged) {
        if (cached?.revision === result.revision) return cached;
        return request("data");
      }
      cached = result;
      setTimeout(() => updateReadingState(result), 0);
      const agents = result.permissions.agents;
      if (!initialized || form.hidden) {
        for (const input of form.querySelectorAll("input")) input.checked = agents.includes(input.value);
      }
      if (!initialized && !agents.length) { form.hidden = false; status.textContent = "请选择允许读取的消息来源。"; }
      initialized = true;
    }
    return result;
  }
  window.JournalHost = { request, readOnly:true, refreshMs:5000 };
  document.getElementById("sources-open").addEventListener("click", () => { form.hidden = !form.hidden; });
  document.getElementById("sources-dismiss").addEventListener("click", () => { if (!saving) form.hidden = true; });
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (saving) return;
    const agents = [...form.querySelectorAll("input:checked")].map(input => input.value);
    saving = true; document.getElementById("sources-save").disabled = true; status.textContent = "正在保存…";
    for (const input of form.querySelectorAll("input")) input.disabled = true;
    try {
      try { await request("permissions", { agents }); }
      catch {
        status.textContent = "正在核对电脑上的读取来源…";
        let confirmed = false;
        try {
          const result = await request("permissions");
          confirmed = result.permissions.agents.length === agents.length && agents.every(agent => result.permissions.agents.includes(agent));
        } catch { /* Keep the user's selection for a later retry. */ }
        if (!confirmed) throw new Error("暂时无法确认保存结果。请检查电脑是否在线，稍后重新打开读取来源核对；你的选择仍保留在这里。");
      }
      generation++; cached = null;
      status.textContent = "已保存。"; form.hidden = true;
      document.getElementById("reload").click();
    } catch (error) { status.textContent = error.message; }
    finally { saving = false; document.getElementById("sources-save").disabled = false; for (const input of form.querySelectorAll("input")) input.disabled = false; }
  });
  async function checkVersion() {
    if (document.hidden) return;
    try {
      const response = await fetch("/journal/version", {cache:"no-store", signal:AbortSignal.timeout(5000)});
      if (response.ok && (await response.json()).version !== version) location.reload();
    } catch { /* Keep the current page usable while offline. */ }
  }
  setInterval(checkVersion, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void checkVersion(); });
})();`;
const nav = `<nav class="journal-nav" aria-label="消息日历导航"><a id="journal-back" href="/">‹ 返回任务台</a><strong>消息日历</strong><button id="sources-open" type="button" aria-controls="source-settings">读取来源</button></nav>
<form id="source-settings" class="source-settings" aria-labelledby="source-title" hidden><h2 id="source-title">允许读取哪些消息</h2><p>读取这台电脑最近 30 天的用户消息，登录任务台的人可通过局域网或公网查看。不会读取助手回复、附件正文或调用模型。此授权独立于 Magpie；取消来源后立即停止展示。</p><div class="source-options">${["codex", "pi", "pi-desktop", "workbuddy", "dsh", "claude"].map((agent, i) => `<label><input type="checkbox" value="${agent}">${["Codex", "Pi", "PI-Desktop", "WorkBuddy", "DSH", "Claude Code"][i]}</label>`).join("")}</div><div class="source-actions"><button id="sources-save" type="submit">保存来源</button><button id="sources-dismiss" type="button">关闭</button></div><p id="source-status" role="status" aria-live="polite"></p></form>`;
let html = read("panel/index.html")
  .replace('width=device-width, initial-scale=1', 'width=device-width, initial-scale=1, viewport-fit=cover')
  .replace('<script src="_magpie/bridge.js"></script>', '<script src="host.js" defer></script>')
  .replace('<body>', '<body>' + nav)
  .replace('<input id="query"', '<div class="journal-search"><input id="query"')
  .replace('autocomplete="off">', 'autocomplete="off"><button id="journal-filter-toggle" class="journal-filter-toggle" type="button" aria-expanded="false" aria-controls="journal-filters">筛选</button></div><div id="journal-filters" class="journal-filters">')
  .replace('<div class="toolbar-end">', '</div><div class="toolbar-end">')
  .replace('<input id="date"', '<button id="journal-latest" class="journal-latest" type="button" hidden>最近</button><input id="date"')
  .replace('</main>\n</main>', '</main>')
  .replace('索引与分类保存在本机；浏览、搜索不联网。仅在确认分类时，将所选项目消息发送给选择的 Magpie 模型，可能产生费用。不读取项目源码、不自动路由。', '日志扫描在电脑上完成；通过任务台现有连接读取消息。本阶段仅供浏览和搜索，不调用模型，不修改 Magpie 分类。')
  .replace('读取权限遵循 Magpie「设置 → 隐私 → Agent 会话历史」。默认最近 30 天，不代表完整历史。', '读取权限由上方“读取来源”控制，独立于 Magpie。默认最近 30 天，不代表完整历史。');
const app = read("panel/app.js");
export const MESSAGE_JOURNAL_ASSET_VERSION = crypto.createHash("sha256").update(html).update(css).update(app).update(coreScript).update(hostScript).digest("hex").slice(0, 12);
html = html.replace(/(src|href)="(host.js|core.js|app.js|panel.css)"/g, `$1="/journal/$2?v=${MESSAGE_JOURNAL_ASSET_VERSION}"`);
const assets: Record<string, { contentType: string; body: string }> = {
  "/journal": { contentType:"text/html; charset=utf-8", body:html },
  "/journal/": { contentType:"text/html; charset=utf-8", body:html },
  "/journal/app.js": { contentType:"text/javascript; charset=utf-8", body:app },
  "/journal/core.js": { contentType:"text/javascript; charset=utf-8", body:coreScript },
  "/journal/host.js": { contentType:"text/javascript; charset=utf-8", body:hostScript.replaceAll("__JOURNAL_VERSION__", MESSAGE_JOURNAL_ASSET_VERSION) },
  "/journal/panel.css": { contentType:"text/css; charset=utf-8", body:css },
  "/journal/version": { contentType:"application/json; charset=utf-8", body:JSON.stringify({version:MESSAGE_JOURNAL_ASSET_VERSION}) },
};
export function messageJournalAsset(pathname: string) { return Object.hasOwn(assets, pathname) ? assets[pathname] : undefined; }
export const MESSAGE_JOURNAL_CSP = "default-src 'self'; connect-src 'self'; img-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

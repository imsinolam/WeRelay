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
@media (max-width:600px) { .journal { padding:10px 12px 0; }.toolbar #query { width:calc(100% - 100px); max-width:none; }.toolbar #project { flex:1; min-width:90px; }.toolbar-end { margin-left:0; }.canvas-hint { display:none; }.journal-nav { padding:8px 12px; } }
@media (prefers-color-scheme:dark) { :root { --magpie-bg:#171717; --magpie-card:#242424; --magpie-fg:#ededed; --magpie-fg-2:#d0d0d0; --magpie-muted:#a0a0a0; --magpie-line:#424242; --magpie-accent:#78c9aa; --magpie-accent-soft:#173e31; color-scheme:dark; } }
`;
const hostScript = `(() => {
  const version = "__JOURNAL_VERSION__";
  const form = document.getElementById("source-settings");
  const status = document.getElementById("source-status");
  let initialized = false;
  let saving = false;
  const key = new URL(location.href).searchParams.get("key");
  if (key) document.getElementById("journal-back").href = "/?key=" + encodeURIComponent(key);
  async function request(path, body) {
    const url = new URL("/api/message-journal/" + path, location.origin);
    if (key) url.searchParams.set("key", key);
    const response = await fetch(url, { method:body ? "POST" : "GET", headers:body ? {"Content-Type":"application/json"} : {}, body:body ? JSON.stringify(body) : undefined, cache:"no-store", signal:AbortSignal.timeout(25000) });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 401 || response.status === 428) {
        status.textContent = "请先返回任务台登录，再打开消息日历。";
        form.hidden = false;
        throw new Error(status.textContent);
      }
      throw new Error(result.error || "消息日历暂时不可用，请稍后重试。");
    }
    if (path === "data") {
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
    try {
      await request("permissions", { agents });
      status.textContent = "已保存。"; form.hidden = true;
      document.getElementById("reload").click();
    } catch (error) { status.textContent = error.message; }
    finally { saving = false; document.getElementById("sources-save").disabled = false; }
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
  .replace('<script src="_magpie/bridge.js"></script>', '<script src="host.js" defer></script>')
  .replace('<body>', '<body>' + nav)
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

export const SESSION_ORGANIZER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>WeRelay 会话整理</title>
  <link rel="stylesheet" href="/organizer.css?appv=__WE_RELAY_ASSET_VERSION__" />
</head>
<body>
  <main class="shell">
    <header class="masthead">
      <div>
        <p class="eyebrow">WERELAY / PROJECT ORGANIZER</p>
        <h1>先把会话整理清楚。</h1>
        <p class="lede">按项目、状态和最近活动查看真实 Agent 会话。标题只提出建议，是否写回由你决定。</p>
      </div>
      <button id="refresh" class="button secondary" type="button">重新扫描</button>
    </header>

    <section id="error" class="notice error" hidden></section>
    <section id="loading" class="notice">正在扫描本机上的 Agent 会话……</section>

    <section id="app" hidden>
      <div class="toolbar">
        <label class="project-picker">
          <span>项目</span>
          <select id="project-filter"></select>
        </label>
        <div id="stats" class="stats"></div>
      </div>
      <div id="review-banner" class="notice review" hidden></div>
      <div id="project-list" class="project-list"></div>
    </section>
  </main>
  <script src="/organizer.js?appv=__WE_RELAY_ASSET_VERSION__" defer></script>
</body>
</html>`;

export const SESSION_ORGANIZER_CSS = `
:root { color-scheme: light; --ink:#1f1f1d; --muted:#756f67; --line:#ded8ce; --paper:#f5f1e9; --card:#fffdf8; --accent:#315d51; --warning:#9e5a2b; --soft:#ebe4d8; }
* { box-sizing: border-box; }
body { margin:0; min-width:320px; color:var(--ink); background:var(--paper); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.shell { width:min(1180px, calc(100% - 40px)); margin:0 auto; padding:42px 0 80px; }
.masthead { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; padding-bottom:34px; border-bottom:1px solid var(--line); }
.eyebrow { margin:0 0 10px; color:var(--accent); font:700 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.14em; }
h1 { margin:0; max-width:680px; font:600 clamp(32px, 5vw, 58px)/1.02 Georgia,"Times New Roman",serif; letter-spacing:-.04em; }
.lede { max-width:610px; margin:17px 0 0; color:var(--muted); font-size:16px; }
.button { border:1px solid var(--ink); border-radius:999px; cursor:pointer; padding:9px 16px; font:600 13px inherit; background:var(--ink); color:#fff; white-space:nowrap; }
.button.secondary { border-color:var(--line); color:var(--ink); background:transparent; }
.button.ghost { border-color:var(--line); color:var(--accent); background:var(--card); }
.button:disabled { cursor:wait; opacity:.55; }
.notice { margin:24px 0 0; padding:14px 16px; border:1px solid var(--line); border-radius:12px; background:rgba(255,253,248,.7); color:var(--muted); }
.notice.error { border-color:#d7a790; color:#873e21; background:#fff4ed; }
.notice.review { border-color:#d7c4a5; color:#73512e; background:#fff8e9; }
.toolbar { display:flex; justify-content:space-between; align-items:end; gap:18px; margin:30px 0 18px; }
.project-picker { display:grid; gap:6px; color:var(--muted); font-size:12px; font-weight:700; letter-spacing:.05em; }
select { min-width:min(360px, 70vw); border:1px solid var(--line); border-radius:10px; padding:11px 34px 11px 12px; color:var(--ink); background:var(--card); font:15px inherit; }
.stats { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; }
.stat { padding:7px 10px; border-radius:999px; background:var(--soft); color:var(--muted); font-size:12px; }
.stat strong { color:var(--ink); }
.project-list { display:grid; gap:24px; }
.project { border-top:2px solid var(--ink); padding-top:14px; }
.project-head { display:flex; justify-content:space-between; gap:16px; align-items:baseline; margin-bottom:12px; }
.project-name { margin:0; font:600 26px/1.2 Georgia,"Times New Roman",serif; }
.project-path { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
.project-counts { display:flex; gap:8px; color:var(--muted); font-size:12px; }
.section { margin-top:16px; }
.section-title { display:flex; align-items:center; gap:8px; margin:0 0 8px; color:var(--muted); font-size:12px; font-weight:750; letter-spacing:.05em; text-transform:uppercase; }
.dot { width:8px; height:8px; border-radius:50%; background:var(--muted); }
.dot.active { background:#2d8b5f; }.dot.waiting { background:#c27a27; }.dot.stale { background:#a39b90; }.dot.error { background:#b14835; }.dot.recent { background:#507c9b; }
.session-list { display:grid; gap:8px; }
.session { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:center; padding:14px 16px; border:1px solid var(--line); border-radius:12px; background:var(--card); }
.session-main { min-width:0; }.session-title { display:flex; flex-wrap:wrap; gap:7px; align-items:center; font-weight:700; }.session-title del { color:var(--muted); font-weight:500; }
.adapter { padding:2px 7px; border-radius:999px; color:var(--accent); background:#e2eee9; font-size:11px; font-weight:700; }
.session-meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:5px; color:var(--muted); font-size:12px; }.session-meta span + span::before { content:"·"; margin-right:8px; color:#b7afa3; }
.suggestion { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:10px; padding:9px 10px; border-radius:8px; background:#f2eee6; color:var(--muted); font-size:12px; }.suggestion strong { color:var(--ink); font-size:13px; }
.rename { display:flex; align-items:center; gap:7px; }.rename input { width:min(320px, 42vw); border:1px solid var(--line); border-radius:8px; padding:8px 9px; background:#fff; color:var(--ink); font:13px inherit; }.rename .button { padding:8px 11px; font-size:12px; }
.empty { padding:26px 0; color:var(--muted); }
@media (max-width:700px) { .shell { width:min(100% - 24px, 1180px); padding-top:25px; }.masthead,.toolbar { display:grid; align-items:start; }.stats { justify-content:flex-start; }.session { grid-template-columns:1fr; }.rename input { width:100%; }.rename { flex-wrap:wrap; }.project-head { display:grid; gap:4px; }.button.secondary { justify-self:start; } }
`;

export const SESSION_ORGANIZER_JS = `
(function () {
  "use strict";
  var state = { snapshot: null, projectKey: "*" };
  var labels = { active: "正在进行", waiting: "等待处理", recent: "最近更新", stale: "长期未更新", error: "需要检查" };
  var order = ["active", "waiting", "recent", "error", "stale"];
  var loading = document.getElementById("loading");
  var error = document.getElementById("error");
  var app = document.getElementById("app");
  var projectFilter = document.getElementById("project-filter");
  var projectList = document.getElementById("project-list");
  var stats = document.getElementById("stats");
  var reviewBanner = document.getElementById("review-banner");

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
    });
  }
  function formatTime(value) {
    if (!value) return "时间未知";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }
  async function api(path, options) {
    var response = await fetch(path, Object.assign({ headers: { "accept": "application/json" } }, options || {}));
    var payload = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(payload.error || "请求失败（" + response.status + "）");
    return payload;
  }
  function showError(message) { error.textContent = message; error.hidden = false; loading.hidden = true; }
  function groupBySection(sessions) {
    var groups = {}; order.forEach(function (key) { groups[key] = []; });
    sessions.forEach(function (session) { (groups[session.section] || groups.recent).push(session); });
    return groups;
  }
  function renderStats(snapshot) {
    var totals = snapshot.totals;
    stats.innerHTML = [
      ["项目", totals.projects], ["会话", totals.sessions], ["需整理", totals.needsReview],
      ["进行中", totals.active], ["等待处理", totals.waiting], ["长期未更新", totals.stale]
    ].map(function (item) { return '<span class="stat">' + item[0] + ' <strong>' + item[1] + '</strong></span>'; }).join("");
  }
  function renderProjects(snapshot) {
    var projects = state.projectKey === "*" ? snapshot.projects : snapshot.projects.filter(function (project) { return project.projectKey === state.projectKey; });
    projectList.innerHTML = projects.length ? projects.map(renderProject).join("") : '<div class="empty">没有找到符合条件的项目。</div>';
    projectList.querySelectorAll("[data-rename]").forEach(function (button) { button.addEventListener("click", function () { renameSession(button.dataset.rename, button.dataset.adapter, button.dataset.title); }); });
    projectList.querySelectorAll("[data-custom-rename]").forEach(function (button) { button.addEventListener("click", function () { var input = button.closest(".session").querySelector("[data-input]"); renameSession(button.dataset.customRename, button.dataset.adapter, input && input.value); }); });
  }
  function renderProject(project) {
    var groups = groupBySection(project.sessions);
    var sections = order.filter(function (key) { return groups[key].length; }).map(function (key) {
      return '<section class="section"><h3 class="section-title"><span class="dot ' + key + '"></span>' + labels[key] + ' <span>(' + groups[key].length + ')</span></h3><div class="session-list">' + groups[key].map(renderSession).join("") + '</div></section>';
    }).join("");
    var counts = order.filter(function (key) { return project.counts[key]; }).map(function (key) { return labels[key] + " " + project.counts[key]; }).join(" · ");
    return '<article class="project"><div class="project-head"><div><h2 class="project-name">' + escapeHtml(project.projectLabel) + '</h2><div class="project-path">' + escapeHtml(project.cwd || "未记录项目路径") + '</div></div><div class="project-counts">' + escapeHtml(counts) + '</div></div>' + sections + '</article>';
  }
  function renderSession(session) {
    var title = escapeHtml(session.title || "未命名会话");
    var suggestion = session.renameSuggestion ? '<div class="suggestion"><span>建议标题</span><strong>' + escapeHtml(session.renameSuggestion) + '</strong>' + (session.canRename === false ? '<span>当前终端不支持写回</span>' : '<button class="button ghost" type="button" data-rename="' + escapeHtml(session.threadId) + '" data-adapter="' + escapeHtml(session.adapter) + '" data-title="' + escapeHtml(session.renameSuggestion) + '">接受建议</button>') + '</div>' : '';
    var review = session.titleQuality !== "clear" && session.canRename !== false ? '<div class="rename"><input data-input="' + escapeHtml(session.threadId) + '" value="" placeholder="输入一个能说明工作内容的标题" /><button class="button ghost" type="button" data-custom-rename="' + escapeHtml(session.threadId) + '" data-adapter="' + escapeHtml(session.adapter) + '">保存标题</button></div>' : '';
    return '<div class="session"><div class="session-main"><div class="session-title">' + title + ' <span class="adapter">' + escapeHtml(session.adapterLabel) + '</span></div><div class="session-meta"><span>' + formatTime(session.lastUpdatedAt) + '</span><span>' + escapeHtml(session.threadId.slice(0, 12)) + '</span></div>' + (session.renameReason ? '<div class="suggestion">' + escapeHtml(session.renameReason) + '</div>' : '') + suggestion + '</div>' + review + '</div>';
  }
  function render(snapshot) {
    state.snapshot = snapshot;
    loading.hidden = true; error.hidden = true; app.hidden = false;
    projectFilter.innerHTML = '<option value="*">全部项目</option>' + snapshot.projects.map(function (project) { return '<option value="' + escapeHtml(project.projectKey) + '">' + escapeHtml(project.projectLabel) + '（' + project.sessions.length + '）</option>'; }).join("");
    projectFilter.value = state.projectKey;
    renderStats(snapshot);
    reviewBanner.hidden = snapshot.totals.needsReview === 0;
    reviewBanner.textContent = snapshot.totals.needsReview + " 个会话的标题可能不够清楚。建议先逐个确认，再进入自动分发。";
    renderProjects(snapshot);
  }
  async function load() { loading.hidden = false; error.hidden = true; try { render(await api("/api/session-organizer")); } catch (err) { showError(err.message || "无法读取会话列表。"); } }
  async function renameSession(threadId, adapter, title) {
    title = String(title || "").trim();
    if (!title) { showError("标题不能为空。"); return; }
    try {
      await api("/api/tasks/" + encodeURIComponent(threadId) + "?adapter=" + encodeURIComponent(adapter), { method: "PATCH", headers: { "content-type": "application/json", "accept": "application/json" }, body: JSON.stringify({ title: title }) });
      await load();
    } catch (err) { showError(err.message || "重命名失败。"); }
  }
  projectFilter.addEventListener("change", function () { state.projectKey = projectFilter.value; if (state.snapshot) render(state.snapshot); });
  document.getElementById("refresh").addEventListener("click", load);
  load();
})();
`;

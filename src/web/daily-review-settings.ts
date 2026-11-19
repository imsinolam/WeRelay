export const DAILY_REVIEW_SETTINGS_CSS = String.raw`
.review-history { max-width: 820px; margin: 0 auto; color: var(--text); }
.review-heading { display: flex; align-items: start; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
.review-heading h2 { margin: 0 0 7px; font-size: 20px; font-weight: 650; letter-spacing: -.025em; }
.review-heading p, .review-note { margin: 0; color: var(--muted-strong); font-size: 13px; line-height: 1.75; }
.review-refresh { flex: 0 0 auto; min-height: 40px; padding: 8px 13px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--page); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
.review-refresh:hover { background: var(--surface); }
.review-refresh:disabled { opacity: .55; cursor: default; }
.review-refresh:focus-visible, .review-report > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.review-report { margin: 0; border-top: 1px solid var(--border); }
.review-report > summary { display: flex; align-items: center; gap: 12px; padding: 20px 0; cursor: pointer; list-style: none; }
.review-report > summary::-webkit-details-marker { display: none; }
.review-report > summary::after { content: ''; flex: 0 0 7px; width: 7px; height: 7px; margin-left: auto; margin-right: 4px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); }
.review-report[open] > summary::after { transform: rotate(225deg); }
.review-date { min-width: 0; }
.review-date strong { display: block; font-size: 15px; font-weight: 620; font-variant-numeric: tabular-nums; }
.review-date time { display: block; margin-top: 4px; color: var(--muted-strong); font-size: 12px; }
.review-tag { display: inline-flex; align-items: center; flex: 0 0 auto; padding: 4px 8px; border-radius: 6px; background: var(--surface); color: var(--muted-strong); font-size: 12px; line-height: 1.5; }
.review-report-content { padding-bottom: 26px; }
.review-overview { padding: 16px 18px; border-radius: 12px; background: var(--surface); font-size: 14px; line-height: 1.8; }
.review-overview p { margin: 0; }
.review-overview p + p { margin-top: 6px; }
.review-overview strong { font-weight: 650; font-variant-numeric: tabular-nums; }
.review-status-line { display: flex; flex-wrap: wrap; gap: 5px 18px; margin-top: 10px; color: var(--muted-strong); font-size: 12px; }
.review-section-title { margin: 25px 0 8px; font-size: 14px; font-weight: 650; }
.review-issue { padding: 14px 0; border-bottom: 1px solid var(--border); }
.review-issue:last-child { border-bottom: 0; }
.review-issue-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.review-issue h4 { margin: 3px 0 0; font-size: 14px; line-height: 1.6; font-weight: 620; }
.review-issue p { margin: 7px 0 0; color: var(--muted-strong); font-size: 13px; line-height: 1.8; overflow-wrap: anywhere; }
.review-issue .review-next { color: var(--text); }
.review-badge { flex: 0 0 auto; padding: 4px 8px; border-radius: 6px; font-size: 12px; line-height: 1.5; background: var(--surface); color: var(--muted-strong); }
.review-badge.is-observing { background: #e9f5ee; color: #23633f; }
.review-badge.is-waiting { background: #fff2dd; color: #805100; }
.review-actions { margin: 6px 0 20px; padding-left: 20px; font-size: 13px; color: var(--muted-strong); line-height: 1.9; }
.review-actions li + li { margin-top: 5px; }
.review-coverage { margin: 20px 0 0; padding-top: 14px; border-top: 1px solid var(--border); }
.review-empty { padding: 42px 12px; text-align: center; }
.review-empty svg { width: 32px; height: 32px; margin-bottom: 12px; fill: none; stroke: var(--muted-strong); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.review-empty h3 { margin: 0 0 8px; font-size: 16px; font-weight: 620; }
.review-empty p { margin: 0 auto; max-width: 34ch; color: var(--muted-strong); font-size: 13px; line-height: 1.8; }
@media (max-width: 600px) {
  .review-heading { gap: 12px; margin-bottom: 20px; }
  .review-heading h2 { font-size: 19px; }
  .review-issue-head { flex-wrap: wrap; gap: 6px; }
  .review-issue h4 { flex: 1 1 180px; }
  .review-overview { padding: 14px; }
  .settings-view .settings-tabs { gap: 2px; padding-inline: 12px; overflow-x: auto; scrollbar-width: thin; }
  .settings-view .settings-tabs button { flex: 1 0 auto; white-space: nowrap; padding-inline: 2px; font-size: 12px; }
}
@media (prefers-color-scheme: dark) {
  .review-badge.is-observing { background: #203b2b; color: #b0dec0; }
  .review-badge.is-waiting { background: #44361f; color: #f3d59c; }
}
`;

// Extends the incumbent settings surface: a quiet, newest-first reading list.
// Only the server's allow-listed summary is rendered, never private report JSON.
export const DAILY_REVIEW_SETTINGS_JS = String.raw`
function createDailyReviewSettings(options) {
  var root = options.root;
  var disposed = false;
  var requestId = 0;
  var data = null;
  var busy = false;
  var failure = false;
  var expanded = new Set();
  var initialized = false;
  var esc = options.escape;
  function date(value, time) {
    var d = new Date(value);
    return d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", year: "numeric",
      ...(time ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) });
  }
  function count(value) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
  function overview(c) {
    var recent = count(c.recent), outstanding = count(c.outstanding);
    var text = recent === null ? "本次已检查保留的消息记录。" : recent === 0 ? "本次检查范围内，未发现新的消息发送异常。" : '本次发现 <strong>' + recent + ' 条</strong>消息出现过发送异常。';
    text += outstanding === null ? "" : outstanding === 0 ? " 当前没有待核对的异常记录。" : ' 包括历史记录在内，仍有 <strong>' + outstanding + ' 条</strong>需要跟进。';
    var labels = [["failed", "仍标记失败"], ["unconfirmed", "尚未确认收到"], ["pending", "等待重试"]];
    var states = labels.filter(function (pair) { return count(c[pair[0]]) !== null && c[pair[0]] > 0; }).map(function (pair) {
      return '<span>' + pair[1] + ' ' + c[pair[0]] + ' 条</span>';
    }).join("");
    var resolved = [["recovered", "已恢复送达"], ["closed", "已取消或处理"]].filter(function (pair) { return count(c[pair[0]]) !== null && c[pair[0]] > 0; }).map(function (pair) { return pair[1] + ' ' + c[pair[0]] + ' 条'; }).join('，');
    return '<div class="review-overview"><p>' + text + '</p>' + (states ? '<div class="review-status-line" aria-label="待跟进记录的当前状态"><span>待跟进记录</span>' + states + '</div>' : '') + (resolved ? '<p class="review-note">本次统计中，' + resolved + '。</p>' : '') + '</div>';
  }
  function reportHtml(report, index) {
    var issues = report.issues || [];
    return '<details class="review-report" data-review-id="' + esc(report.id) + '"' + (expanded.has(report.id) ? ' open' : '') + '><summary><div class="review-date"><strong>' + esc(date(report.atMs, false)) + '</strong><time datetime="' + esc(new Date(report.atMs).toISOString()) + '">' + esc(date(report.atMs, true)) + ' · 北京时间</time></div>' + (index === 0 ? '<span class="review-tag">最近一次</span>' : '') + '</summary><div class="review-report-content">' + overview(report.counts || {}) +
      (issues.length ? '<h3 class="review-section-title">发现的问题与处理进展</h3><div>' + issues.map(function (issue) {
        var tone = issue.status === "observing" ? " is-observing" : issue.status === "waiting" ? " is-waiting" : "";
        return '<article class="review-issue"><div class="review-issue-head"><h4>' + esc(issue.title) + '</h4><span class="review-badge' + tone + '">' + esc(issue.statusLabel) + '</span></div><p>' + esc(issue.detail) + '</p><p class="review-next">' + esc(issue.next) + '</p></article>';
      }).join("") + '</div>' : '<p class="review-note" style="margin-top:16px">这次没有记录具体的问题处理项。</p>') +
      ((report.actions || []).length ? '<h3 class="review-section-title">本次做了什么</h3><ul class="review-actions">' + report.actions.map(function (action) { return '<li>' + esc(action) + '</li>'; }).join("") + '</ul>' : '') +
      '<p class="review-note review-coverage">' + esc(report.coverageNote) + '</p></div></details>';
  }
  function render() {
    if (disposed) return;
    var reports = data && Array.isArray(data.reports) ? data.reports : [];
    if (!initialized && data) { if (reports[0]) expanded.add(reports[0].id); initialized = true; }
    root.innerHTML = '<section class="review-history" aria-label="巡检记录"><div class="review-heading"><div><h2>巡检记录</h2><p>查看发现的问题、已做的处理和下一步。最新记录在前。</p></div><button type="button" class="review-refresh"' + (busy ? ' disabled' : '') + '>' + (busy ? '正在读取…' : '刷新记录') + '</button></div>' +
      (failure ? '<p class="review-note" role="alert">暂时无法读取巡检记录，请稍后刷新重试。</p>' : '') +
      (!data && busy ? '<p class="review-note" role="status">正在读取巡检记录…</p>' : reports.length ? '<p class="review-note" style="margin-bottom:18px">这里记录消息是否送到及后续处理；送达不代表任务已经执行成功。</p>' + reports.map(reportHtml).join("") : !failure ? '<div class="review-empty"><svg viewBox="0 0 32 32" aria-hidden="true"><rect x="7" y="5" width="18" height="23" rx="3"/><path d="M12 4h8v5h-8zM12 15h8M12 20h5"/></svg><h3>还没有巡检记录</h3><p>完成首次巡检后，发现的问题和处理进展会显示在这里。</p></div>' : '') +
      (data && data.skipped ? '<p class="review-note review-coverage">部分记录暂时无法读取，当前仅展示可用内容。</p>' : '') + '</section>';
    root.querySelector('.review-refresh').addEventListener('click', load);
    root.querySelectorAll('.review-report').forEach(function (el) {
      el.addEventListener('toggle', function () { if (el.open) expanded.add(el.dataset.reviewId); else expanded.delete(el.dataset.reviewId); });
    });
  }
  async function load() {
    var id = ++requestId;
    busy = true; failure = false; render();
    try {
      var payload = await options.api('/api/settings/daily-reviews');
      if (disposed || id !== requestId) return;
      data = payload;
    } catch (_) { if (!disposed && id === requestId) failure = true; }
    finally { if (!disposed && id === requestId) { busy = false; render(); } }
  }
  return { load: load, destroy: function () { disposed = true; requestId++; } };
}
`;

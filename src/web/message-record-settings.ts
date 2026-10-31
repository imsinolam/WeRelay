export const MESSAGE_RECORD_SETTINGS_CSS = String.raw`
.record-toolbar, .record-filter-grid, .record-policy { display: grid; grid-template-columns: repeat(auto-fit, minmax(136px, 1fr)); gap: 12px; margin: 16px 0; }
.record-toolbar label, .record-filter-grid label, .record-policy label { display: grid; align-content: start; gap: 5px; font-size: 12px; color: var(--muted-strong); min-width: 0; }
.record-toolbar input, .record-toolbar select, .record-filter-grid input, .record-filter-grid select, .record-policy select { width: 100%; min-width: 0; min-height: 40px; padding: 8px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--page); color: var(--text); font: inherit; font-size: 13px; }
.record-toolbar input:focus-visible, .record-toolbar select:focus-visible, .record-filter-grid input:focus-visible, .record-filter-grid select:focus-visible, .record-policy select:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
.record-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; }
.record-action { min-height: 40px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
.record-action:hover { background: var(--surface-selected, var(--surface)); }
.record-action:focus-visible, .record-open:focus-visible, .record-link:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
.record-action:disabled { opacity: .55; cursor: default; }
.record-summary { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 14px 0; margin-bottom: 12px; border-block: 1px solid var(--border); font-size: 13px; font-variant-numeric: tabular-nums; }
.record-summary strong { font-weight: 650; }
.record-row { border-bottom: 1px solid var(--border); padding: 12px 0; }
.record-row > .record-open { cursor: pointer; overflow-wrap: anywhere; line-height: 1.5; font-size: 14px; }
.record-meta { display: block; color: var(--muted-strong); font-size: 12px; margin: 4px 0; }
.record-status-failed, .record-warning { color: var(--red); }
.record-body { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 13px; max-height: 300px; overflow-y: auto; background: var(--surface); padding: 12px; border-radius: 8px; }
.record-events { padding-inline-start: 22px; color: var(--muted-strong); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.record-empty { padding: 24px 0; font-size: 14px; color: var(--muted-strong); }
.record-policy-panel { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 14px; }
.record-policy-panel > summary { font-size: 14px; cursor: pointer; }
.record-toolbar { grid-template-columns: minmax(120px, 1fr) minmax(120px, 1fr) minmax(140px, 1.3fr) auto; gap: 10px; align-items: end; }
.record-filter-actions { display: flex; align-self: end; gap: 8px; }
.record-filter-actions .record-action { width: auto; flex: none; }
.record-more { margin: 8px 0 16px; }
.record-more > summary, .record-diagnostics > summary { cursor: pointer; color: var(--muted-strong); font-size: 13px; }
.record-filter-grid { margin: 12px 0; }
.record-open { display: block; width: 100%; text-align: start; padding: 0; border: 0; background: none; color: var(--text); font: inherit; cursor: pointer; }
.record-open:hover .record-title { text-decoration: underline; text-underline-offset: 3px; }
.record-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.record-diagnostics { margin-top: 8px; }
.record-task-active { color: var(--green); font-weight: 600; }
.record-link { border: 0; background: none; color: var(--text); padding: 4px 0; font: inherit; font-size: 13px; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.record-preview { width: min(800px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; border: 1px solid var(--border-strong); border-radius: 14px; background: var(--page); color: var(--text); }
.record-preview::backdrop { background: rgba(0, 0, 0, .42); }
.record-preview-shell { display: flex; flex-direction: column; max-height: calc(100dvh - 36px); }
.record-preview-header { display: flex; gap: 16px; align-items: start; justify-content: space-between; padding: 18px 20px; border-bottom: 1px solid var(--border); }
.record-preview-header h2 { font-size: 16px; margin: 0 0 5px; }
.record-preview-header p { margin: 0; }
.record-preview-messages { overflow: auto; overscroll-behavior: contain; padding: 20px; }
.record-preview .message-row { margin-block: 0 18px; }
.record-preview .message-content { min-width: 0; }
.record-preview .record-reply-tail { display: flex; flex-direction: column; justify-content: flex-end; max-height: 4.8em; overflow: hidden; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.record-preview [hidden] { display: none !important; }
.record-reply-tail > span { flex: none; display: block; }
.record-preview .record-reply-toggle { margin-top: 6px; }
@media (max-width: 600px) {
  .record-toolbar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .record-toolbar .record-search { grid-column: 1 / -1; }
  .record-preview { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); }
  .record-preview-messages, .record-preview-header { padding: 16px; }
}

`;

export const MESSAGE_RECORD_SETTINGS_JS = String.raw`
function createMessageRecordSettings(options) {
  var root = options.root;
  var query = { kind: "task", range: "7", offset: 0 };
  var generation = 0;
  var disposed = false;
  var latest = null;
  var advancedOpen = false;
  var preview = null;
  var previewEpoch = 0;
  var taskLabels = { running: "任务进行中", approval: "待审批", input: "待输入", error: "任务异常", idle: "当前空闲", unknown: "任务状态待确认" };
  var groups = { active: "处理中", sent: "已发送", attention: "需关注", closed: "已结束" };
  function statusGroup(status) {
    if (["received", "accepted", "sending", "retrying", "queued"].includes(status)) return "active";
    if (["submitted", "delivered"].includes(status)) return "sent";
    if (["unconfirmed", "failed"].includes(status)) return "attention";
    return "closed";
  }
  var labels = { received: "已收到", accepted: "已保存待发送", sending: "发送中", retrying: "等待重试", queued: "已排队", submitted: "已提交", unconfirmed: "送达未确认", failed: "发送失败", delivered: "已确认送达", cancelled: "已取消", handled: "已处理" };
  var escape = options.escape;
  function time(value) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }
  function params() {
    var result = new URLSearchParams();
    ["source", "adapter", "project", "statusGroup", "status", "kind", "search"].forEach(function (key) { if (query[key]) result.set(key, query[key]); });
    if (query.from) result.set("from", new Date(query.from).toISOString());
    else if (query.range) result.set("from", new Date(Date.now() - Number(query.range) * 86400000).toISOString());
    if (query.to) result.set("to", new Date(query.to).toISOString());
    result.set("offset", String(query.offset || 0)); result.set("limit", "30");
    return result.toString();
  }
  function select(name, label, values, selected) {
    return '<label>' + label + '<select name="' + name + '">' + values.map(function (item) {
      return '<option value="' + escape(item[0]) + '"' + (item[0] === String(selected || "") ? ' selected' : '') + '>' + escape(item[1]) + '</option>';
    }).join("") + '</select></label>';
  }
  function bind(selector, event, callback) { root.querySelector(selector).addEventListener(event, callback); }
  function render(payload) {
    latest = payload;
    query.offset = payload.offset;
    var stats = payload.stats;
    root.innerHTML = '<section><h2 class="settings-section-title">消息记录</h2>' +
      '<p class="settings-note">按来源查看发送记录，排查排队、失败和重试。消息交付与任务运行状态分开展示。</p>' +
      (!payload.policy.enabled ? '<p class="record-warning" role="status">记录已暂停，仍可查看已有记录。新消息不会记录；可在下方「记录与隐私设置」重新启用。</p>' : '') +
      '<form id="record-filters" class="record-toolbar">' +
      select("project", "所属项目", projectOptions(payload), query.project) +
      select("statusGroup", "交付分类", [["", "全部分类"], ["active", "处理中"], ["sent", "已发送"], ["attention", "需关注"], ["closed", "已结束"]], query.statusGroup) +
      '<label class="record-search">搜索消息<input type="search" name="search" maxlength="200" value="' + escape(query.search || "") + '" placeholder="摘要或任务 ID"></label>' +
      '<div class="record-filter-actions"><button type="submit" class="record-action">查询</button></div>' +
      '</form><details class="record-more" id="record-more-filters"' + (advancedOpen ? ' open' : '') + '><summary>更多筛选' + advancedSummary() + '</summary><div class="record-filter-grid">' +
      select("source", "消息来源", [["", "全部来源"], ["clawbot", "ClawBot"], ["web", "网页任务台"]], query.source) +
      select("range", "时间范围", [["1", "最近 24 小时"], ["7", "最近 7 天"], ["30", "最近 30 天"], ["", "全部保留记录"]], query.range) +
      select("adapter", "Agent", [["", "全部 Agent"]].concat(payload.adapters.map(function (id) { return [id, options.agentName(id)]; })), query.adapter) +
      select("kind", "消息类型", [["task", "任务消息"], ["control", "控制消息"], ["", "全部消息"]], query.kind) +
      select("status", "具体交付状态", [["", "全部状态"]].concat(Object.keys(labels).filter(function (id) { return !query.statusGroup || statusGroup(id) === query.statusGroup; }).map(function (id) { return [id, labels[id]]; })), query.status) +
      '<label>开始时间<input type="datetime-local" name="from" value="' + escape(query.from || "") + '"></label>' +
      '<label>结束时间<input type="datetime-local" name="to" value="' + escape(query.to || "") + '"></label>' +
      '</div><button type="submit" form="record-filters" class="record-action">应用筛选</button></details>' +
      '<div class="record-actions"><button type="button" class="record-link" id="record-refresh">刷新记录</button><button type="button" class="record-link" id="record-export">导出记录</button></div>' +
      '<p id="record-action-status" class="settings-note" role="status"></p>' +
      (payload.warning ? '<p class="record-warning" role="status">' + escape(payload.warning) + '</p>' : '') +
      '<div class="record-summary" aria-label="当前筛选范围统计">' +
      [["任务消息", stats.messages], ["ClawBot", stats.clawbot], ["网页任务台", stats.web], ["发送失败", stats.failed], ["已确认送达", stats.delivered], ["排队中", stats.queued], ["额外重试", stats.retries], ["附件数", stats.attachments]].map(function (item) {
        return '<span>' + item[0] + ' <strong>' + item[1] + '</strong></span>';
      }).join("") + '</div>' +
      '<p class="settings-note">统计仅覆盖当前筛选和保留范围，不是全部历史累计。去重后的消息计数，重试不重复计消息。当前结果 ' + payload.total + ' 条，其中历史快照 ' + stats.historical + ' 条、控制消息 ' + stats.controls + ' 条。记录启用于 ' + time(payload.startedAtMs) + '。</p>' +
      '<div id="record-list">' + (payload.records.length ? payload.records.map(rowHtml).join("") : '<p class="record-empty">此范围内还没有记录。可放宽筛选；启用前的 ClawBot 历史不会自动补回。</p>') + '</div>' +
      '<div class="record-actions"><button type="button" class="record-action" id="record-prev"' + (payload.offset ? '' : ' disabled') + '>上一页</button><span class="settings-note">' + (payload.total ? payload.offset + 1 : 0) + '–' + (payload.offset + payload.records.length) + ' / ' + payload.total + '</span><button type="button" class="record-action" id="record-next"' + (payload.hasMore ? '' : ' disabled') + '>下一页</button></div>' +
      policyHtml(payload) + '</section>';
    bind("#record-filters", "submit", function (event) {
      event.preventDefault(); var form = new FormData(event.currentTarget);
      root.querySelectorAll("#record-more-filters [name]").forEach(function (field) { form.set(field.name, field.value); });
      form.forEach(function (value, key) { query[key] = String(value); }); query.offset = 0;
      if (query.status && query.statusGroup && statusGroup(query.status) !== query.statusGroup) query.status = "";
      if (query.from || query.to) query.range = "";
      void load();
    });
    bind("#record-more-filters", "toggle", function (event) { advancedOpen = event.currentTarget.open; });
    bind('select[name="statusGroup"]', "change", function (event) {
      var category = event.currentTarget.value;
      var field = root.querySelector('select[name="status"]');
      field.innerHTML = '<option value="">全部状态</option>' + Object.keys(labels).filter(function (id) { return !category || statusGroup(id) === category; }).map(function (id) { return '<option value="' + id + '">' + labels[id] + '</option>'; }).join("");
    });
    bind("#record-refresh", "click", function () { void load(); });
    bind("#record-prev", "click", function () { query.offset = Math.max(0, query.offset - 30); void load(); });
    bind("#record-next", "click", function () { query.offset += 30; void load(); });
    bind("#record-export", "click", function (event) { void action(event.currentTarget, async function () {
      var data = await options.api("/api/settings/message-records/export?" + params());
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob); var anchor = document.createElement("a");
      anchor.href = url; anchor.download = "werelay-message-records.json"; anchor.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      status("已导出当前筛选结果。导出内容可能包含敏感信息，请谨慎分享。");
    }); });
    bind("#record-policy", "submit", function (event) {
      event.preventDefault(); var form = new FormData(event.currentTarget);
      void action(root.querySelector("#record-policy-save"), async function () {
        await options.api("/api/settings/message-records", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          enabled: form.get("enabled") === "true", textMode: form.get("textMode"), retentionDays: Number(form.get("retentionDays")), maxRecords: Number(form.get("maxRecords"))
        }) }); await load(); status("记录设置已保存，不影响消息发送。");
      });
    });
    bind("#record-clear", "click", function () { root.querySelector("#record-clear-confirm").hidden = false; });
    bind("#record-clear-cancel", "click", function () { root.querySelector("#record-clear-confirm").hidden = true; });
    bind("#record-clear-yes", "click", function (event) { void action(event.currentTarget, async function () {
      await options.api("/api/settings/message-records", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "clear" }) });
      query.offset = 0; await load(); status("记录已清空，原任务、附件和待发送消息未删除。");
    }); });
    root.querySelectorAll("[data-record-open]").forEach(function (button) { button.addEventListener("click", function () {
      var row = payload.records.find(function (item) { return item.id === button.dataset.recordOpen; });
      if (row) void openPreview(row, button);
    }); });
  }
  function rowHtml(row) {
    var title = row.preview || (row.imageCount ? "附件消息（" + row.imageCount + " 个）" : "文字未保存");
    var canPreview = row.kind === "task" && row.threadId && !row.threadId.startsWith("local-new-");
    var opening = canPreview ? '<button type="button" class="record-open" data-record-open="' + row.id + '" aria-label="预览任务：' + escape(title) + '">' : '<div class="record-open">';
    return '<article class="record-row">' + opening + '<span class="record-title">' + escape(title) + '</span><span class="record-meta">' +
      escape(time(row.createdAtMs) + ' · ' + (row.projectName || '未归属项目') + ' · ' + (row.source === 'web' ? '网页任务台' : 'ClawBot') + ' · ' + options.agentName(row.adapter)) +
      ' · <span class="record-status-' + row.status + '">' + escape(groups[statusGroup(row.status)] + ' · ' + labels[row.status]) + '</span>' +
      (['running', 'approval', 'input', 'error'].includes(row.taskState) ? ' · <span class="record-task-active">' + taskLabels[row.taskState] + '</span>' : '') +
      (row.historical ? ' · 历史快照' : '') + '</span>' + (canPreview ? '</button>' : '</div>') +
      '<details class="record-diagnostics"><summary>交付详情</summary>' +
      '<p class="settings-note">尝试 ' + row.attempts + ' 次 · 额外重试 ' + Math.max(0, row.attempts - 1) + ' 次 · 附件 ' + row.imageCount + ' 个' +
      (row.failureNotified ? ' · 已发送失败通知' : '') + '</p>' +
      (row.threadId ? '<p class="settings-note">任务：' + escape(row.threadId) + '</p>' : '') +
      (row.body ? '<pre class="record-body">' + escape(row.body) + '</pre>' : '') +
      (row.error ? '<p class="record-warning">最近问题：' + escape(row.error) + '</p>' : '') +
      (row.omittedEvents ? '<p class="settings-note">仅保留最近 40 次状态变化。</p>' : '') +
      '<ol class="record-events">' + row.events.map(function (event) { return '<li>' + escape(time(event.atMs) + ' · ' + (labels[event.status] || '未知状态') + ' · 尝试 ' + event.attempts + ' 次' + (event.error ? ' · ' + event.error : '')) + '</li>'; }).join('') + '</ol></details></article>';
  }
  function projectOptions(payload) {
    var projects = payload.projects || [];
    var items = [["", "全部项目"]].concat(projects.map(function (project) {
      var duplicate = projects.filter(function (item) { return item.label === project.label; }).length > 1;
      return [project.key, project.label + (duplicate ? ' · ' + project.key.slice(-6) : '') + '（' + project.count + '）'];
    }));
    if (query.project && !projects.some(function (item) { return item.key === query.project; })) items.push([query.project, '当前项目（此范围无记录）']);
    return items;
  }
  function advancedSummary() {
    var parts = [query.range ? '最近 ' + query.range + ' 天' : '全部时间'];
    if (query.adapter) parts.push(options.agentName(query.adapter));
    if (query.source) parts.push(query.source === 'web' ? '网页任务台' : 'ClawBot');
    if (query.status) parts.push(labels[query.status]);
    if (query.from || query.to) parts[0] = '自定时间';
    if (query.kind !== 'task') parts.push(query.kind === 'control' ? '控制消息' : '全部类型');
    return ' · ' + escape(parts.join(' · '));
  }
  function closePreview() {
    previewEpoch++;
    if (preview) { var dialog = preview; preview = null; dialog.close(); dialog.remove(); }
  }
  async function openPreview(row, trigger) {
    closePreview();
    var current = ++previewEpoch;
    var doc = root.ownerDocument;
    var dialog = doc.createElement('dialog');
    dialog.className = 'record-preview';
    dialog.setAttribute('aria-labelledby', 'record-preview-title');
    dialog.innerHTML = '<div class="record-preview-shell"><header class="record-preview-header"><div><h2 id="record-preview-title">' + escape(row.taskTitle || '任务预览') + '</h2><p class="settings-note">' + escape((row.projectName || '未归属项目') + ' · ' + options.agentName(row.adapter)) + ' · 只读预览，不切换当前任务</p></div><button class="record-action" type="button" data-preview-close autofocus>关闭</button></header><div class="record-preview-messages" aria-live="polite"><p class="settings-note">正在读取最近对话…</p></div></div>';
    doc.body.appendChild(dialog); preview = dialog;
    dialog.addEventListener('close', function () {
      if (preview === dialog) { preview = null; previewEpoch++; dialog.remove(); }
      if (!disposed && trigger && trigger.isConnected) trigger.focus();
    });
    dialog.querySelector('[data-preview-close]').addEventListener('click', closePreview);
    dialog.addEventListener('click', function (event) { if (event.target === dialog) { var r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closePreview(); } });
    dialog.showModal();
    var content = dialog.querySelector('.record-preview-messages');
    async function read() {
      content.innerHTML = '<p class="settings-note">正在读取最近对话…</p>';
      try {
        var payload = await options.readTask(row.adapter, row.threadId);
        if (disposed || preview !== dialog || current !== previewEpoch) return;
        var text = options.chatText || options.chatUI.createText();
        var bubble = options.chatUI.createMessageBubble({ document: doc, text: text, actions: {
          onOpenImage: function (url) { if (/^(?:https?:\/\/|\/api\/)/i.test(url)) doc.defaultView.open(url, '_blank', 'noopener,noreferrer'); }
        } });
        content.innerHTML = '';
        var summary = payload.runSummary;
        var taskStatus = summary ? (summary.status === 'running' ? 'running' : summary.status === 'failed' ? 'error' : 'idle') : row.taskState;
        var note = doc.createElement('p'); note.className = 'settings-note';
        note.textContent = (taskLabels[taskStatus] || '任务状态待确认') + ' · 最近对话，AI 回复默认显示末尾三行'; content.appendChild(note);
        var messages = (payload.messages || []).concat((payload.outboundMessages || []).filter(function (outbound) {
          return !(payload.messages || []).some(function (native) { return native.clientId && native.clientId === outbound.clientId; });
        }));
        messages.forEach(function (message, index) {
          if (!['user', 'assistant'].includes(message.role)) return;
          var node = bubble.render({ id: 'record-preview-message-' + index, message: message, text: message.text || '', footer: {} });
          if (message.role === 'assistant' && message.text) {
            var full = node.querySelector('.message-content');
            if (full) {
              full.hidden = true;
              var tail = doc.createElement('div'); tail.className = 'record-reply-tail';
              var span = doc.createElement('span'); span.textContent = message.text.trimEnd().split('\n').slice(-3).join('\n'); tail.appendChild(span);
              full.before(tail);
              var toggle = doc.createElement('button'); toggle.type = 'button'; toggle.className = 'record-link record-reply-toggle';
              toggle.textContent = '展开回复'; toggle.setAttribute('aria-expanded', 'false');
              toggle.addEventListener('click', function () { var expand = full.hidden; full.hidden = !expand; tail.hidden = expand; toggle.textContent = expand ? '收起回复' : '展开回复'; toggle.setAttribute('aria-expanded', String(expand)); });
              tail.after(toggle);
            }
          }
          content.appendChild(node);
        });
        if (!messages.length) { var empty = doc.createElement('p'); empty.className = 'record-empty'; empty.textContent = '原任务暂时没有可预览的消息。'; content.appendChild(empty); }
      } catch (error) {
        if (disposed || preview !== dialog || current !== previewEpoch) return;
        content.innerHTML = '<p class="record-warning">' + escape(error.message || '暂时无法读取原任务') + '</p><button type="button" class="record-action" data-preview-retry>重新读取</button>';
        content.querySelector('[data-preview-retry]').addEventListener('click', function () { void read(); });
      }
    }
    await read();
  }
  function policyHtml(payload) {
    var policy = payload.policy;
    return '<details class="record-policy-panel"><summary>记录与隐私设置' + (policy.enabled ? '' : '（已关闭）') + '</summary>' +
      '<p class="settings-note">记录仅存电脑私有目录；远程查看经过原有登录和加密中继。默认保存脱敏摘要，不额外保存附件内容、附件路径或微信身份。消息文字本身仍可能含路径或个人信息，脱敏不能保证覆盖所有敏感内容。这些设置只管理本页诊断记录，不会修改 Agent 会话、发送所需的待发送箱或既有运行日志。</p>' +
      '<form id="record-policy" class="record-policy">' +
      select("enabled", "记录开关", [["true", "启用记录"], ["false", "暂停记录"]], String(policy.enabled)) +
      select("textMode", "文字保存", [["none", "不保存文字"], ["summary", "脱敏摘要（160 字）"], ["body", "脱敏正文（最多 4000 字）"]], policy.textMode) +
      select("retentionDays", "保留时间", [["7", "7 天"], ["30", "30 天"], ["90", "90 天"]], String(policy.retentionDays)) +
      select("maxRecords", "保留条数", [["500", "500 条"], ["2000", "2000 条"], ["5000", "5000 条"]], String(policy.maxRecords)) +
      '<button type="submit" id="record-policy-save" class="record-action">保存设置</button></form>' +
      '<p class="settings-note">时间、条数、8 MiB 容量限制以先达到者为准。当前保留 ' + payload.storage.retained + ' 条，占用约 ' + Math.ceil(payload.storage.bytes / 1024) + ' KiB。降低文字保存范围会立即删除已保存的对应文字，不能恢复；暂停不影响发送，也不补录暂停期间消息。清空只删除诊断记录。</p>' +
      '<button type="button" class="record-action" id="record-clear">清空消息记录</button>' +
      '<div id="record-clear-confirm" hidden><p class="record-warning">确认清空全部消息记录？此操作不能恢复，真实会话与待发送队列不受影响。</p><div class="record-actions"><button type="button" id="record-clear-yes" class="record-action">确认清空记录</button><button type="button" id="record-clear-cancel" class="record-action">取消</button></div></div></details>';
  }
  function status(message) { var el = root.querySelector("#record-action-status"); if (!disposed && el) el.textContent = message; }
  async function action(button, work) {
    var current = generation; button.disabled = true;
    try { await work(); } catch (error) { if (!disposed && current === generation) status(error.message || "操作失败，请重试。"); }
    finally { if (!disposed && button.isConnected) button.disabled = false; }
  }
  async function load() {
    var current = ++generation;
    try {
      var payload = await options.api("/api/settings/message-records?" + params());
      if (!disposed && current === generation) render(payload);
    } catch (error) {
      if (disposed || current !== generation) return;
      if (latest && root.querySelector("#record-action-status")) status("读取失败：" + (error.message || "请重试"));
      else {
        root.innerHTML = '<p class="record-empty" role="status">' + escape(error.message || "消息记录读取失败") + '</p><button type="button" class="record-action" id="record-load-retry">重新读取</button>';
        bind("#record-load-retry", "click", function () { void load(); });
      }
    }
  }
  return { load: load, destroy: function () { disposed = true; generation++; closePreview(); } };
}
`;

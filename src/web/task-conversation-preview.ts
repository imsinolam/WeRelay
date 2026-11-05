/** Shared read-only transcript viewer. Opening it never selects or resumes a task. */
export const TASK_CONVERSATION_PREVIEW_JS = String.raw`
function createTaskConversationPreview(options) {
  var preview = null;
  var previewEpoch = 0;
  var disposed = false;
  var escape = options.escape;
  var taskLabels = { running: "任务进行中", approval: "待审批", input: "待输入", error: "任务异常", idle: "当前空闲", unknown: "任务状态待确认" };
  function closePreview() {
    previewEpoch++;
    if (preview) { var dialog = preview; preview = null; dialog.close(); dialog.remove(); }
  }
  async function openPreview(row, trigger) {
    closePreview();
    var current = ++previewEpoch;
    var doc = options.document;
    var dialog = doc.createElement('dialog');
    dialog.className = 'record-preview';
    dialog.setAttribute('aria-labelledby', 'record-preview-title');
    dialog.innerHTML = '<div class="record-preview-shell"><header class="record-preview-header"><div><h2 id="record-preview-title">' + escape(row.taskTitle || row.title || '任务预览') + '</h2><p class="settings-note">' + escape((row.contextLabel || row.projectName || '未归属项目') + ' · ' + options.agentName(row.adapter)) + ' · 只读预览，不切换当前任务</p></div><button class="record-action" type="button" data-preview-close autofocus>关闭</button></header><div class="record-preview-messages" aria-live="polite"><p class="settings-note">正在读取最近对话…</p></div></div>';
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
  return { open: openPreview, close: closePreview, destroy: function () { disposed = true; closePreview(); } };
}
`;

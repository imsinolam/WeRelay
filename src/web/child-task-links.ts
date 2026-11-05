export const CHILD_TASK_LINKS_CSS = String.raw`
.child-task-links { width: min(100%, var(--thread-max)); margin: 24px auto 12px; font-size: 14px; }
.child-task-links > details { border-top: 1px solid var(--border); padding-top: 12px; }
.child-task-links summary { width: fit-content; min-height: 36px; cursor: pointer; color: var(--muted-strong); }
.child-task-links summary:focus-visible, .child-task-link:focus-visible { outline: 2px solid var(--green); outline-offset: 3px; }
.child-task-links ul { list-style: none; padding: 0; margin: 4px 0; }
.child-task-link { display: flex; gap: 16px; align-items: baseline; width: 100%; min-height: 44px; padding: 10px 0; border: 0; background: none; color: var(--text); font: inherit; text-align: start; cursor: pointer; }
.child-task-link:hover .child-task-title { text-decoration: underline; text-underline-offset: 3px; }
.child-task-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.child-task-state { flex: none; color: var(--muted-strong); font-size: 12px; }
.child-task-links .settings-note { margin: 8px 0; }
`;

/** Separate from task navigation and its persistent cache: children are only links. */
export const CHILD_TASK_LINKS_JS = String.raw`
function createChildTaskLinks(options) {
  var doc = options.document;
  var root = doc.createElement('section'); root.className = 'child-task-links'; root.hidden = true;
  root.setAttribute('aria-label', '子任务');
  var details = doc.createElement('details');
  var summary = doc.createElement('summary');
  var list = doc.createElement('ul');
  var notice = doc.createElement('p'); notice.className = 'settings-note'; notice.setAttribute('role', 'status');
  var retry = doc.createElement('button'); retry.type = 'button'; retry.className = 'record-link'; retry.textContent = '重新读取子任务';
  details.appendChild(summary); details.appendChild(list); details.appendChild(notice); details.appendChild(retry); root.appendChild(details);
  var adapter = '', parent = '', epoch = 0, pending = null, lastRead = 0, signature = '', tasks = [], errorText = '';
  var labels = { running: '进行中', approval: '待审批', input: '待输入', error: '异常', idle: '空闲' };
  function changed() { if (options.onChange) options.onChange(); }
  function render() {
    root.hidden = !tasks.length && !errorText;
    summary.textContent = '子任务' + (tasks.length ? '（' + tasks.length + '）' : '');
    notice.textContent = errorText ? '子任务暂时无法读取：' + errorText : '仅查看，不切换当前任务。';
    retry.hidden = !errorText;
    var nextSignature = JSON.stringify(tasks);
    if (nextSignature !== signature) {
      signature = nextSignature; list.innerHTML = '';
      tasks.forEach(function (task) {
        var row = doc.createElement('li');
        var button = doc.createElement('button'); button.type = 'button'; button.className = 'child-task-link';
        var title = doc.createElement('span'); title.className = 'child-task-title'; title.textContent = task.title || '未命名子任务';
        var state = doc.createElement('span'); state.className = 'child-task-state'; state.textContent = labels[task.status] || '状态待确认';
        button.appendChild(title); button.appendChild(state);
        button.setAttribute('aria-label', '查看子任务：' + title.textContent);
        button.addEventListener('click', function () { void options.preview.open({ adapter: adapter, threadId: task.threadId,
          taskTitle: title.textContent, taskState: task.status, contextLabel: '子任务' }, button); });
        row.appendChild(button); list.appendChild(row);
      });
    }
    changed();
  }
  async function refresh(force) {
    if (!parent || !['codex', 'deepseek', 'opencode'].includes(adapter)) return;
    if (pending) return pending;
    var now = options.now ? options.now() : Date.now();
    if (!force && lastRead && now - lastRead < 15000) return;
    lastRead = now;
    var current = epoch, readAdapter = adapter, readParent = parent;
    var request = (async function () {
      try {
        var payload = await options.readChildren(readAdapter, readParent);
        if (current !== epoch) return;
        if (payload.parentThreadId !== readParent) throw new Error('任务关系已变化，请重新读取。');
        tasks = (payload.tasks || []).filter(function (task) { return task.parentThreadId === readParent && task.threadId && task.threadId !== readParent; });
        errorText = '';
      } catch (error) {
        if (current !== epoch) return;
        errorText = error.message || '请稍后重试';
      }
      if (current === epoch) render();
    })();
    pending = request;
    try { await request; } finally { if (pending === request) pending = null; }
  }
  retry.addEventListener('click', function () { void refresh(true); });
  return { element: root, refresh: refresh, setTarget: function (nextAdapter, nextParent) {
    nextParent = nextParent && !nextParent.startsWith('local-new-') ? nextParent : '';
    if (adapter === nextAdapter && parent === nextParent) return pending || Promise.resolve();
    epoch++; pending = null; lastRead = 0; adapter = nextAdapter; parent = nextParent;
    tasks = []; errorText = ''; details.open = false; options.preview.close(); render();
    return refresh(true);
  } };
}
`;

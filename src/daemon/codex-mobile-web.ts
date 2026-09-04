export const CODEX_MOBILE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#ffffff">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <title>WeRelay</title>
  <link rel="stylesheet" href="/app.css?appv=__WE_RELAY_ASSET_VERSION__">
</head>
<body>
  <section class="boot-screen" id="boot-screen" aria-label="正在打开 WeRelay">
    <div class="boot-content">
      <div class="boot-wordmark">WeRelay</div>
      <div class="boot-activity" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="boot-status" id="boot-status">正在检查电脑连接状态…</div>
      <div class="boot-detail" id="boot-detail">正在确认服务器和电脑是否在线。</div>
    </div>
  </section>

  <section class="auth-screen" id="auth-screen" aria-labelledby="auth-title" hidden>
    <div class="auth-card">
      <a class="auth-wordmark" href="/about" aria-label="查看 WeRelay 项目说明">WeRelay</a>
      <h1 id="auth-title">验证访问</h1>
      <p id="auth-description">请输入移动版访问密码。</p>
      <form class="auth-form" id="auth-form">
        <label class="auth-field">
          <span>访问密码</span>
          <input id="auth-password" type="password" minlength="8" maxlength="256" autocomplete="current-password" placeholder="至少 8 个字符" required>
        </label>
        <button class="auth-submit" id="auth-submit" type="submit">继续</button>
        <div class="auth-error" id="auth-error" role="alert"></div>
      </form>
      <p class="auth-security-warning" id="auth-security-warning" hidden>当前连接未启用 HTTPS，请勿在不可信网络输入密码。公网访问建议先配置 HTTPS。</p>
      <p class="auth-hint" id="auth-hint">密码仅保存在这台 Mac 上。</p>
    </div>
  </section>

  <div class="app-shell" id="app" hidden>
    <div class="sidebar-overlay" id="sidebar-overlay"></div>
    <aside class="sidebar" id="sidebar" aria-label="任务列表">
      <div class="sidebar-head">
        <div class="workspace-area">
          <button class="workspace-switcher" id="workspace-switcher" type="button" aria-label="切换终端或打开 WeRelay 菜单" aria-expanded="false">
            <span class="workspace-product">WeRelay</span>
            <span class="workspace-divider">·</span>
            <span class="workspace-adapter" id="active-adapter-label">Codex</span>
            <span class="workspace-switch-progress" id="workspace-switch-progress" aria-hidden="true" hidden></span>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 6.25 8 9.75l3.5-3.5"/></svg>
          </button>
        </div>
        <button class="icon-button sidebar-close" id="sidebar-close" type="button" aria-label="关闭任务列表">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <nav class="sidebar-primary-nav" aria-label="工作区视图">
        <button class="sidebar-primary-button" id="task-board-open" type="button" aria-pressed="false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="16" rx="1.5"/><rect x="14" y="4" width="6" height="9" rx="1.5"/></svg>
          <span>任务看板</span>
          <span class="sidebar-primary-count" id="task-board-count" hidden></span>
        </button>
      </nav>
      <div class="task-view-switch" role="tablist" aria-label="任务列表视图">
        <button class="task-view-button is-active" id="task-view-projects" type="button" role="tab" aria-selected="true">项目</button>
        <button class="task-view-button" id="task-view-recent" type="button" role="tab" aria-selected="false">最近</button>
      </div>
      <label class="search-box">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>
        <input id="task-search" type="search" placeholder="搜索任务" autocomplete="off">
      </label>
      <div class="task-list" id="task-list"></div>
      <div class="sidebar-footer">
        <button class="sidebar-settings-button" id="settings-open" type="button" aria-pressed="false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M20 7h-2M10 17h10M4 17h2"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>
          <span>设置</span>
        </button>
      </div>
    </aside>

    <div class="workspace-menu" id="workspace-menu" role="menu" hidden>
      <div class="adapter-menu" id="adapter-menu"></div>
      <div class="workspace-menu-divider" role="separator"></div>
      <a class="workspace-menu-item" href="/about" role="menuitem">项目说明</a>
      <button class="workspace-menu-item" id="auth-logout" type="button" role="menuitem">退出</button>
    </div>

    <main class="main-panel">
      <header class="topbar">
        <button class="icon-button menu-button" id="menu-button" type="button" aria-label="打开任务列表">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14M5 16h14"/></svg>
        </button>
        <div class="topbar-copy">
          <div class="topbar-title" id="current-title">选择一个任务</div>
          <div class="topbar-meta" id="current-meta"></div>
        </div>
        <div class="topbar-actions">
          <div class="cache-sync-indicator" id="cache-sync-indicator" role="status" aria-live="polite" hidden>
            <span class="cache-sync-icon" aria-hidden="true"></span>
            <span class="cache-sync-text"></span>
          </div>
          <div class="status-label" id="current-status">未选择</div>
          <button class="new-task-button" id="new-task-button" type="button" aria-label="新建任务" title="新建任务">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
      </header>

      <section class="task-board" id="task-board" aria-labelledby="task-board-title" hidden>
        <header class="task-board-header">
          <div class="task-board-heading-row">
            <button class="icon-button task-board-menu-button" id="task-board-menu-button" type="button" aria-label="打开任务列表">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14M5 16h14"/></svg>
            </button>
            <div class="task-board-heading">
              <h1 id="task-board-title">所有任务</h1>
              <p id="task-board-subtitle">汇集所有支持 Agent 的真实任务</p>
            </div>
            <button class="task-board-refresh" id="task-board-refresh" type="button" aria-label="刷新任务看板" title="刷新">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 5v6h-6"/></svg>
            </button>
          </div>
          <div class="task-board-toolbar">
            <div class="task-board-view-switch" role="tablist" aria-label="任务看板视图">
              <button class="task-board-view-button is-active" id="task-board-view-active" type="button" role="tab" aria-selected="true">任务</button>
              <button class="task-board-view-button" id="task-board-view-completed" type="button" role="tab" aria-selected="false">最近</button>
            </div>
            <label class="task-board-search">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>
              <input id="task-board-search" type="search" placeholder="搜索全部任务" autocomplete="off">
            </label>
          </div>
        </header>
        <div class="task-board-body" id="task-board-body" aria-live="polite"></div>
      </section>

      <section class="settings-view" id="settings-view" aria-labelledby="settings-title" hidden>
        <header class="settings-view-header">
          <button class="icon-button settings-menu-button" id="settings-menu-button" type="button" aria-label="打开任务列表">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 8h14M5 16h14"/></svg>
          </button>
          <div>
            <h1 id="settings-title">设置</h1>
            <p>管理审批方式与电脑上的终端</p>
          </div>
        </header>
        <div class="settings-body" id="settings-body">
          <div class="settings-loading" id="settings-loading">正在读取设置…</div>
        </div>
      </section>

      <section class="messages" id="messages" aria-live="polite">
        <div class="empty-state" id="empty-state">
          <div class="empty-wordmark">WeRelay</div>
          <h1>从手机继续任务</h1>
          <p>这里显示电脑端任务的完整上下文。</p>
        </div>
      </section>

      <div class="message-navigation" id="message-navigation" aria-label="用户消息导航" hidden>
        <button class="message-navigation-button" id="previous-user-message" type="button" aria-label="上一条用户消息" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 14 5-5 5 5"/></svg>
        </button>
        <button class="message-navigation-button" id="next-user-message" type="button" aria-label="下一条用户消息" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
        </button>
      </div>

      <form class="composer-wrap" id="composer-form">
        <div class="composer-queue" id="composer-queue" aria-live="polite" hidden></div>
        <input id="composer-image-input" type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" multiple>
        <div class="composer">
          <div class="composer-media" id="composer-media" hidden></div>
          <textarea id="composer-input" rows="1" maxlength="20000" placeholder="有问题，尽管问"></textarea>
          <button class="composer-image-button" id="composer-image-button" type="button" aria-label="添加图片">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <div class="composer-settings-controls" id="composer-settings-controls" hidden>
            <div class="composer-model-control" id="composer-model-control" hidden>
              <button class="composer-model-button" id="composer-model-button" type="button" aria-haspopup="menu" aria-expanded="false">
                <span id="composer-model-label">模型</span>
                <svg class="composer-model-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6"/></svg>
              </button>
              <div class="composer-model-menu" id="composer-model-menu" role="menu" hidden></div>
            </div>
            <div class="composer-model-control" id="composer-reasoning-control" hidden>
              <button class="composer-model-button" id="composer-reasoning-button" type="button" aria-haspopup="menu" aria-expanded="false">
                <span id="composer-reasoning-label">推理</span>
                <svg class="composer-model-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6"/></svg>
              </button>
              <div class="composer-model-menu composer-reasoning-menu" id="composer-reasoning-menu" role="menu" hidden></div>
            </div>
            <div class="composer-model-control" id="composer-permission-control" hidden>
              <button class="composer-model-button" id="composer-permission-button" type="button" aria-haspopup="menu" aria-expanded="false">
                <span id="composer-permission-label">权限范围</span>
                <svg class="composer-model-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6"/></svg>
              </button>
              <div class="composer-model-menu composer-permission-menu" id="composer-permission-menu" role="menu" hidden></div>
            </div>
          </div>
          <button class="send-button" id="send-button" type="submit" aria-label="发送">
            <svg class="send-arrow-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18V6M7.5 10.5L12 6l4.5 4.5"/></svg>
            <svg class="send-stop-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.2"/></svg>
          </button>
        </div>
      </form>
    </main>
  </div>

  <div class="task-context-menu" id="task-context-menu" role="menu" aria-label="任务操作" hidden>
    <button id="task-context-rename" type="button" role="menuitem">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.2-1 10.6-10.6a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z"/><path d="m14.8 6.2 3 3"/></svg>
      <span>重命名</span>
    </button>
    <button id="task-context-copy-id" type="button" role="menuitem">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
      <span>复制任务 ID</span>
    </button>
  </div>

  <div class="task-rename-overlay" id="task-rename-overlay" hidden>
    <form class="task-rename-dialog" id="task-rename-form" role="dialog" aria-modal="true" aria-labelledby="task-rename-title">
      <div class="task-rename-title" id="task-rename-title">重命名任务</div>
      <input class="task-rename-input" id="task-rename-input" type="text" maxlength="200" autocomplete="off" aria-label="任务名">
      <div class="task-rename-actions">
        <button class="task-rename-cancel" id="task-rename-cancel" type="button">取消</button>
        <button class="task-rename-save" id="task-rename-save" type="submit">保存</button>
      </div>
    </form>
  </div>

  <div class="toast" id="toast" role="status"></div>
  <script src="/app.js?appv=__WE_RELAY_ASSET_VERSION__" defer></script>
</body>
</html>`;

export const WE_RELAY_ABOUT_HTML = `<!doctype html>
<html class="about-document" lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#ffffff">
  <title>项目说明 · WeRelay</title>
  <link rel="stylesheet" href="/app.css?appv=__WE_RELAY_ASSET_VERSION__">
</head>
<body class="about-page">
  <header class="about-topbar">
    <a class="about-logo" href="/about">WeRelay</a>
    <a class="about-open-app" href="/">打开任务</a>
  </header>

  <main class="about-main">
    <section class="about-hero">
      <div class="about-eyebrow">ONE REAL SESSION. EVERY SCREEN.</div>
      <h1>让真实的 AI 编程任务<br>延伸到任何设备</h1>
      <p>WeRelay 连接电脑上的真实 Codex、Claude Code、Cursor 和其他编程 Agent 任务。微信、手机网页与其他入口只负责延伸这条任务，不复制会话，也不在后台创建一条看不见的分支。</p>
      <div class="about-actions">
        <a class="about-primary-action" href="/">打开任务</a>
        <a class="about-secondary-action" href="#principles">了解工作方式</a>
      </div>
    </section>

    <section class="about-statement" id="principles">
      <div class="about-statement-label">核心原则</div>
      <p>电脑端持有唯一真实任务。<br>其他端都只是延伸入口。</p>
    </section>

    <section class="about-section">
      <div class="about-section-heading">
        <div class="about-section-index">01</div>
        <h2>为什么要保持同一条任务</h2>
      </div>
      <div class="about-grid about-grid-four">
        <article class="about-card">
          <h3>不分叉上下文</h3>
          <p>手机发出的消息真实进入电脑端正在使用的任务，继续沿用原来的历史、项目目录和上下文。</p>
        </article>
        <article class="about-card">
          <h3>不伪造同步</h3>
          <p>远程端看到的任务、消息、状态和回复来自同一个真实会话，而不是另一套看起来相似的记录。</p>
        </article>
        <article class="about-card">
          <h3>不替代原生客户端</h3>
          <p>Codex、Cursor 或 Claude Code 仍然是主工作界面。WeRelay 只补上离开电脑后的入口。</p>
        </article>
        <article class="about-card">
          <h3>不中断后台任务</h3>
          <p>可以从手机切换任务、查看进展、处理审批和排队消息，不需要把工作迁移到新的 Agent 平台。</p>
        </article>
      </div>
    </section>

    <section class="about-section">
      <div class="about-section-heading">
        <div class="about-section-index">02</div>
        <h2>WeRelay 如何工作</h2>
      </div>
      <div class="about-flow" aria-label="WeRelay 工作流程">
        <div class="about-flow-node">
          <strong>远程入口</strong>
          <span>微信 · 手机网页 · 浏览器</span>
        </div>
        <div class="about-flow-arrow" aria-hidden="true">→</div>
        <div class="about-flow-node is-relay">
          <strong>WeRelay</strong>
          <span>任务映射 · 队列 · 审批 · 状态</span>
        </div>
        <div class="about-flow-arrow" aria-hidden="true">→</div>
        <div class="about-flow-node">
          <strong>真实任务</strong>
          <span>Codex · Claude Code · WorkBuddy · 更多 Agent</span>
        </div>
      </div>
    </section>

    <section class="about-section about-two-column">
      <div>
        <div class="about-section-heading">
          <div class="about-section-index">03</div>
          <h2>它提供什么</h2>
        </div>
        <ul class="about-list">
          <li>查看电脑端真实任务列表与完整消息</li>
          <li>从微信和移动网页继续发送文字与图片</li>
          <li>同步运行状态、处理时间与任务完成通知</li>
          <li>管理待发送消息、停止任务与远程审批</li>
          <li>通过适配器接入不同的 AI 编程工具</li>
        </ul>
      </div>
      <div>
        <div class="about-section-heading">
          <div class="about-section-index">04</div>
          <h2>它不是什么</h2>
        </div>
        <ul class="about-list is-muted">
          <li>不是一个重新托管所有任务的云端 Agent</li>
          <li>不是只会模拟点击和键盘的远程桌面</li>
          <li>不是在手机端复制一份独立聊天记录</li>
          <li>不会把远程会话伪装成桌面原始任务</li>
        </ul>
      </div>
    </section>

    <section class="about-section about-local-first">
      <div class="about-section-heading">
        <div class="about-section-index">05</div>
        <h2>本地优先</h2>
      </div>
      <p>任务和 Agent 仍然运行在你的电脑上。WeRelay 只在你授权的入口之间传递必要的信息。移动网页使用独立访问密码；公网访问可通过 WeRelay 应用层主动 Relay 提供，电脑不需要暴露本地端口。</p>
    </section>

    <footer class="about-footer">
      <div>
        <strong>WeRelay</strong>
        <span>Your real coding-agent sessions, everywhere.</span>
      </div>
      <a href="/">返回任务</a>
    </footer>
  </main>
</body>
</html>`;

export const CODEX_MOBILE_CSS = String.raw`
:root {
  color-scheme: light;
  --page: #ffffff;
  --canvas: #fcfcfc;
  --sidebar: #f9f9f9;
  --surface: #f4f4f4;
  --surface-hover: #ececec;
  --surface-selected: #e7e7e7;
  --border: rgba(0, 0, 0, 0.08);
  --border-strong: rgba(0, 0, 0, 0.13);
  --text: #0d0d0d;
  --muted: #6b6b6b;
  --muted-strong: #4f4f4f;
  --accent: #0d0d0d;
  --green: #10a37f;
  --orange: #c17422;
  --red: #d00e17;
  --thread-max: 48rem;
  --shadow: 0 8px 30px rgba(0, 0, 0, 0.10);
  font-family: -apple-system-body, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

[hidden] { display: none !important; }
* { box-sizing: border-box; }
html { -webkit-tap-highlight-color: transparent; }
html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; overscroll-behavior: none; background: var(--canvas); color: var(--text); }
body { position: fixed; inset: 0; font-size: 16px; line-height: 1.5; }
button, input, textarea, a { -webkit-tap-highlight-color: transparent; }
button, input, textarea { font: inherit; }
button { color: inherit; touch-action: manipulation; -webkit-appearance: none; appearance: none; user-select: none; }
button:focus { outline: none; }
button:focus-visible { outline: 2px solid var(--border-strong); outline-offset: 2px; }
.about-document, .about-document body { width: 100%; height: auto; min-height: 100%; overflow: auto; overscroll-behavior: auto; }
.about-page { position: static; inset: auto; background: var(--page); }
.about-topbar { position: sticky; top: 0; min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: max(12px, env(safe-area-inset-top)) max(24px, calc((100vw - 1120px) / 2)) 12px; border-bottom: 1px solid var(--border); background: rgba(255,255,255,.88); backdrop-filter: blur(18px); z-index: 10; }
.about-logo { color: var(--text); font-size: 18px; font-weight: 680; letter-spacing: -.035em; text-decoration: none; }
.about-open-app { min-height: 36px; display: inline-flex; align-items: center; padding: 0 14px; border: 1px solid var(--border-strong); border-radius: 10px; color: var(--text); font-size: 13px; font-weight: 560; text-decoration: none; }
.about-open-app:hover { background: var(--surface); }
.about-main { width: min(100%, 1120px); margin: 0 auto; padding: 0 32px max(52px, env(safe-area-inset-bottom)); }
.about-hero { padding: clamp(76px, 11vw, 142px) 0 clamp(76px, 10vw, 124px); }
.about-eyebrow { margin-bottom: 24px; color: var(--muted); font-size: 12px; font-weight: 680; letter-spacing: .14em; }
.about-hero h1 { max-width: 920px; margin: 0; font-size: clamp(44px, 7.3vw, 88px); font-weight: 570; letter-spacing: -.065em; line-height: .98; }
.about-hero > p { max-width: 760px; margin: 34px 0 0; color: var(--muted-strong); font-size: clamp(17px, 2vw, 21px); line-height: 1.72; }
.about-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 36px; }
.about-primary-action, .about-secondary-action { min-height: 46px; display: inline-flex; align-items: center; justify-content: center; padding: 0 18px; border-radius: 12px; font-size: 14px; font-weight: 580; text-decoration: none; }
.about-primary-action { background: var(--accent); color: var(--page); }
.about-secondary-action { border: 1px solid var(--border-strong); color: var(--text); }
.about-secondary-action:hover { background: var(--surface); }
.about-statement { margin-bottom: 110px; padding: clamp(32px, 6vw, 64px); border-radius: 30px; background: #0d0d0d; color: #fff; }
.about-statement-label { margin-bottom: 36px; color: rgba(255,255,255,.55); font-size: 12px; font-weight: 650; letter-spacing: .12em; }
.about-statement p { margin: 0; font-size: clamp(32px, 5vw, 60px); font-weight: 510; letter-spacing: -.045em; line-height: 1.16; }
.about-section { padding: 84px 0; border-top: 1px solid var(--border); scroll-margin-top: 72px; }
.about-section-heading { display: flex; align-items: baseline; gap: 18px; margin-bottom: 36px; }
.about-section-index { color: var(--muted); font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
.about-section h2 { margin: 0; font-size: clamp(28px, 3.2vw, 42px); font-weight: 560; letter-spacing: -.04em; line-height: 1.12; }
.about-grid { display: grid; gap: 12px; }
.about-grid-four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.about-card { min-height: 210px; padding: 28px; border: 1px solid var(--border); border-radius: 20px; background: var(--canvas); }
.about-card h3 { margin: 0 0 44px; font-size: 18px; font-weight: 620; letter-spacing: -.025em; }
.about-card p { margin: 0; color: var(--muted-strong); font-size: 15px; line-height: 1.7; }
.about-flow { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 16px; }
.about-flow-node { min-height: 144px; display: flex; flex-direction: column; justify-content: space-between; gap: 24px; padding: 24px; border: 1px solid var(--border); border-radius: 18px; background: var(--canvas); }
.about-flow-node.is-relay { border-color: #0d0d0d; background: #0d0d0d; color: #fff; }
.about-flow-node strong { font-size: 17px; font-weight: 620; }
.about-flow-node span { color: var(--muted); font-size: 13px; line-height: 1.5; }
.about-flow-node.is-relay span { color: rgba(255,255,255,.58); }
.about-flow-arrow { color: var(--muted); font-size: 22px; }
.about-two-column { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: clamp(52px, 8vw, 110px); }
.about-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.about-list li { padding: 18px 0; border-bottom: 1px solid var(--border); font-size: 15px; line-height: 1.55; }
.about-list.is-muted { color: var(--muted-strong); }
.about-local-first > p { max-width: 780px; margin: 0; color: var(--muted-strong); font-size: 18px; line-height: 1.75; }
.about-footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding: 76px 0 28px; border-top: 1px solid var(--border); }
.about-footer > div { display: grid; gap: 8px; }
.about-footer strong { font-size: 20px; font-weight: 670; letter-spacing: -.035em; }
.about-footer span { color: var(--muted); font-size: 13px; }
.about-footer a { color: var(--text); font-size: 14px; font-weight: 560; text-decoration: none; }
.boot-screen { min-height: 100dvh; display: grid; place-items: center; background: var(--canvas); }
.boot-content { width: min(360px, calc(100vw - 48px)); display: grid; justify-items: center; gap: 9px; }
.boot-wordmark { color: var(--text); font-size: 24px; font-weight: 650; letter-spacing: -0.035em; }
.boot-activity { display: inline-flex; align-items: center; gap: 4px; height: 12px; margin: 6px 0 1px; }
.boot-activity span { width: 4px; height: 4px; border-radius: 50%; background: var(--muted); animation: boot-activity-dot 1.2s ease-in-out infinite; }
.boot-activity span:nth-child(2) { animation-delay: .16s; }
.boot-activity span:nth-child(3) { animation-delay: .32s; }
@keyframes boot-activity-dot { 0%, 60%, 100% { opacity: .28; transform: translateY(0); } 30% { opacity: .92; transform: translateY(-3px); } }
.boot-status { color: var(--text); font-size: 14px; font-weight: 570; line-height: 1.5; text-align: center; }
.boot-detail { min-height: 40px; color: var(--muted); font-size: 12px; line-height: 1.65; text-align: center; text-wrap: balance; }
.auth-screen { min-height: 100dvh; display: grid; place-items: center; padding: max(24px, env(safe-area-inset-top)) 20px max(24px, env(safe-area-inset-bottom)); background: var(--canvas); }
.auth-card { width: min(100%, 390px); padding: 34px 30px 30px; border: 1px solid var(--border); border-radius: 24px; background: var(--page); box-shadow: var(--shadow); }
.auth-wordmark { display: inline-block; margin-bottom: 28px; color: var(--text); font-size: 22px; font-weight: 680; letter-spacing: -0.04em; text-decoration: none; }
.auth-card h1 { margin: 0 0 9px; font-size: 24px; font-weight: 650; letter-spacing: -0.035em; }
.auth-card > p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
.auth-form { display: grid; gap: 14px; margin-top: 25px; }
.auth-field { display: grid; gap: 8px; color: var(--muted-strong); font-size: 13px; font-weight: 560; }
.auth-field input { width: 100%; min-height: 50px; padding: 0 15px; border: 1px solid var(--border-strong); border-radius: 13px; outline: 0; background: var(--page); color: var(--text); font-size: 16px; transition: border-color .16s ease, box-shadow .16s ease; }
.auth-field input:focus { border-color: rgba(13,13,13,.42); box-shadow: 0 0 0 3px rgba(13,13,13,.07); }
.auth-submit { min-height: 48px; border: 0; border-radius: 13px; background: var(--accent); color: var(--page); font-size: 15px; font-weight: 620; cursor: pointer; }
.auth-submit:disabled { opacity: .46; cursor: default; }
.auth-error { min-height: 20px; color: var(--red); font-size: 13px; line-height: 1.5; }
.auth-security-warning { margin-top: 4px !important; padding: 10px 12px; border: 1px solid rgba(193,116,34,.32); border-radius: 11px; background: rgba(193,116,34,.08); color: #8a4b12 !important; font-size: 12px !important; line-height: 1.5 !important; }
.auth-hint { margin-top: 18px !important; font-size: 12px !important; text-align: center; }
svg { display: block; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }

.app-shell { display: grid; grid-template-columns: 260px minmax(0, 1fr); width: 100%; height: 100dvh; }
.sidebar {
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: max(8px, env(safe-area-inset-top)) 8px max(8px, env(safe-area-inset-bottom));
  background: var(--sidebar);
  z-index: 20;
}
.sidebar-head { min-height: 44px; flex: 0 0 auto; display: flex; align-items: center; gap: 4px; padding: 0 2px 4px; }
.sidebar-head .workspace-area { min-width: 0; flex: 1; }
.sidebar-head .workspace-switcher { max-width: 100%; }
.sidebar-head .workspace-adapter { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-button {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
  cursor: pointer;
}
.icon-button svg { width: 18px; height: 18px; }
.icon-button:hover { background: var(--surface-hover); }
.icon-button:active { background: #dfdfdf; }
.sidebar-close { display: none; margin-left: auto; }
.sidebar-primary-nav { flex: 0 0 auto; margin: 0 2px 8px; }
.sidebar-primary-button {
  width: 100%;
  min-height: 38px;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 0 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted-strong);
  font: inherit;
  font-size: 14px;
  font-weight: 520;
  text-align: left;
  cursor: pointer;
  transition: background .16s cubic-bezier(.2,.8,.2,1), color .16s cubic-bezier(.2,.8,.2,1);
}
.sidebar-primary-button:hover { background: var(--surface-hover); color: var(--text); }
.sidebar-primary-button:active { transform: translateY(1px); }
.sidebar-primary-button:focus-visible { outline: 2px solid rgba(16,163,127,.42); outline-offset: 2px; }
.sidebar-primary-button.is-active { background: var(--surface-selected); color: var(--text); }
.sidebar-primary-button svg { width: 18px; height: 18px; stroke-width: 1.7; }
.sidebar-primary-count { min-width: 22px; padding: 2px 7px; border-radius: 999px; background: var(--page); color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; text-align: center; }
.sidebar-footer { flex: 0 0 auto; margin: 7px 2px 0; padding-top: 7px; border-top: 1px solid var(--border); }
.sidebar-settings-button {
  width: 100%;
  min-height: 38px;
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: center;
  gap: 9px;
  padding: 0 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted-strong);
  font: inherit;
  font-size: 14px;
  font-weight: 520;
  text-align: left;
  cursor: pointer;
  transition: background .16s cubic-bezier(.2,.8,.2,1), color .16s cubic-bezier(.2,.8,.2,1);
}
.sidebar-settings-button:hover { background: var(--surface-hover); color: var(--text); }
.sidebar-settings-button:focus-visible { outline: 2px solid rgba(16,163,127,.42); outline-offset: 2px; }
.sidebar-settings-button.is-active { background: var(--surface-selected); color: var(--text); }
.sidebar-settings-button svg { width: 18px; height: 18px; stroke-width: 1.65; }
.task-view-switch {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
  margin: 0 2px 6px;
  padding: 2px;
  border-radius: 9px;
  background: rgba(0, 0, 0, .04);
}
.task-view-button {
  min-height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-weight: 520;
  cursor: pointer;
}
.task-view-button.is-active { background: var(--page); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,.06); }
.search-box {
  flex: 0 0 auto;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 2px 8px;
  padding: 0 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted-strong);
}
.search-box:hover, .search-box:focus-within { background: var(--surface-hover); }
.search-box svg { width: 17px; height: 17px; flex: 0 0 auto; }
.search-box input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 14px; }
.search-box input::placeholder { color: var(--muted-strong); }
.task-list { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 0; overscroll-behavior: contain; scrollbar-width: thin; -webkit-overflow-scrolling: touch; }
.task-group { margin: 0; }
.task-group-head {
  min-height: 36px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 36px;
  align-items: center;
  gap: 2px;
  padding-right: 4px;
}
.task-group.is-recent .task-group-head { grid-template-columns: minmax(0, 1fr); padding-right: 0; }
.task-group-title {
  width: 100%;
  min-height: 32px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 6px 4px 10px;
  overflow: hidden;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.35;
  text-align: left;
  cursor: pointer;
}
.task-group-title:hover { color: var(--muted-strong); background: var(--surface-hover); }
.task-group-title.is-static { cursor: default; }
.task-group-title.is-static:hover { color: var(--muted); background: transparent; }
.task-group-title-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-group-chevron { width: 13px; height: 13px; flex: 0 0 auto; transition: transform .15s ease; }
.task-group.is-collapsed .task-group-chevron { transform: rotate(-90deg); }
.task-group-title.is-static .task-group-chevron { display: none; }
.task-group:first-child .task-group-head { min-height: 32px; }
.task-group:first-child .task-group-title { padding-top: 4px; }
.task-group-create {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.task-group-create:hover { color: var(--text); background: var(--surface-hover); }
.task-group-create:focus-visible { outline: 2px solid rgba(16,163,127,.42); outline-offset: 1px; }
.task-group-create:disabled { opacity: .38; cursor: wait; }
.task-group-create svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 1.8; }
.task-group-create-spinner { display: none; stroke-dasharray: 26; stroke-dashoffset: 9; }
.task-group-create.is-loading .task-group-create-plus { display: none; }
.task-group-create.is-loading .task-group-create-spinner { display: block; animation: switch-spin .8s linear infinite; transform-origin: center; }
.task-group:not(.is-recent) .task-group-items .task-item,
.task-group:not(.is-recent) .task-group-more { padding-left: 28px; }
.task-group-more, .task-list-more {
  width: 100%;
  min-height: 31px;
  padding: 5px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.task-group-more:hover, .task-list-more:hover { color: var(--muted-strong); background: var(--surface-hover); }
.task-list-more { margin: 3px 0 10px; }
.task-list,
.task-list * {
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
}
.task-item {
  width: 100%;
  min-height: 36px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  margin: 1px 0;
  padding: 7px 10px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  touch-action: pan-y;
}
.task-item:hover { background: var(--surface-hover); }
.task-item.is-active { background: var(--surface-selected); }
.task-copy { min-width: 0; grid-column: 1; grid-row: 1; }
.task-indicator { min-width: 10px; grid-column: 2; grid-row: 1; display: inline-flex; align-items: center; justify-content: flex-end; }
.task-dot { width: 6px; height: 6px; flex: 0 0 auto; visibility: hidden; border-radius: 50%; background: transparent; }
.task-dot.running { visibility: visible; background: var(--green); animation: task-dot-breathe 1.6s ease-in-out infinite; }
.task-dot.input { visibility: visible; background: var(--orange); }
.task-dot.error { visibility: visible; background: var(--red); }
.task-status-badge { display: none; min-height: 20px; padding: 1px 6px; align-items: center; border: 1px solid rgba(193,116,34,.24); border-radius: 6px; background: rgba(193,116,34,.10); color: var(--orange); font-size: 11px; font-weight: 600; line-height: 1; white-space: nowrap; }
.task-status-badge.approval { display: inline-flex; }
@keyframes task-dot-breathe {
  0%, 100% { opacity: .55; transform: scale(.86); box-shadow: 0 0 0 0 rgba(16, 163, 127, 0); }
  50% { opacity: 1; transform: scale(1.12); box-shadow: 0 0 0 4px rgba(16, 163, 127, .14); }
}
@media (prefers-reduced-motion: reduce) {
  .task-dot.running, .adapter-menu-running-dot { animation: none; opacity: 1; transform: none; box-shadow: none; }
}
.task-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 430; line-height: 1.5; }
.task-project { display: block; margin-top: 1px; overflow: hidden; color: var(--muted); font-size: 11px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.task-project[hidden] { display: none; }
.sidebar-overlay { display: none; }

.main-panel { position: relative; min-width: 0; display: flex; flex-direction: column; height: 100dvh; overflow: hidden; background: var(--page); }
.topbar {
  min-height: 52px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: max(8px, env(safe-area-inset-top)) 14px 8px;
  background: rgba(255, 255, 255, 0.92);
  backdrop-filter: blur(16px);
  z-index: 10;
}
.menu-button { display: none; }
.topbar-copy { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
.workspace-area { position: relative; flex: 0 0 auto; }
.workspace-switcher { min-height: 32px; max-width: min(420px, calc(100vw - 96px)); display: flex; align-items: center; gap: 5px; padding: 0 7px; border: 0; border-radius: 8px; background: transparent; color: var(--muted-strong); font: inherit; white-space: nowrap; cursor: pointer; }
.workspace-switcher:hover { background: var(--surface-hover); color: var(--text); }
.workspace-product { flex: 0 0 auto; color: var(--text); font-size: 16px; font-weight: 620; letter-spacing: -0.015em; white-space: nowrap; }
.workspace-divider { flex: 0 0 auto; color: var(--muted); font-size: 13px; white-space: nowrap; }
.workspace-adapter { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 540; }
.workspace-switch-progress { width: 12px; height: 12px; flex: 0 0 auto; margin-left: 2px; border: 1.5px solid var(--border-strong); border-top-color: var(--green); border-radius: 50%; animation: switch-spin .8s linear infinite; }
.workspace-switcher svg { width: 13px; height: 13px; margin-left: 1px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
.workspace-switcher[aria-expanded="true"] svg { transform: rotate(180deg); }
.workspace-switcher.is-switching > svg { display: none; }
@keyframes switch-spin { to { transform: rotate(360deg); } }
.workspace-menu { position: fixed; top: 0; left: 0; width: min(300px, calc(100vw - 16px)); max-height: min(70vh, 520px); overflow-y: auto; padding: 4px; border: 1px solid var(--border); border-radius: 12px; background: var(--page); box-shadow: var(--shadow); z-index: 40; }
.adapter-menu { display: block; }
.adapter-menu-item { width: 100%; min-height: 36px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.adapter-menu-item > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.adapter-menu-label { display: inline-flex; align-items: center; gap: 7px; }
.adapter-menu-running-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--green); animation: task-dot-breathe 1.6s ease-in-out infinite; }
.adapter-menu-item:hover { background: var(--surface-hover); }
.adapter-menu-item.is-active { font-weight: 620; }
.adapter-menu-state { flex: 0 0 auto; white-space: nowrap; color: var(--muted); font-size: 11px; font-weight: 430; }
.workspace-menu-divider { height: 1px; margin: 4px 6px; background: var(--border); }
.workspace-menu-item { width: 100%; min-height: 34px; display: flex; align-items: center; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--text); font: inherit; font-size: 13px; text-align: left; text-decoration: none; cursor: pointer; }
.workspace-menu-item:hover { background: var(--surface-hover); }
.topbar-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 12px; font-weight: 420; }
.topbar-meta { display: none; }
.topbar-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 4px; }
.cache-sync-indicator { min-height: 24px; display: inline-flex; align-items: center; gap: 5px; padding: 0 7px; border-radius: 999px; color: var(--muted); background: var(--surface); font-size: 11px; white-space: nowrap; }
.cache-sync-indicator[hidden] { display: none; }
.cache-sync-icon { width: 10px; height: 10px; flex: 0 0 auto; border: 1.4px solid var(--border-strong); border-top-color: var(--green); border-radius: 50%; animation: switch-spin .8s linear infinite; }
.cache-sync-indicator.is-current .cache-sync-icon { border: 0; animation: none; }
.cache-sync-indicator.is-current .cache-sync-icon::before { content: ""; display: block; width: 8px; height: 4px; margin: 1px 0 0 1px; border-left: 1.5px solid var(--green); border-bottom: 1.5px solid var(--green); transform: rotate(-45deg); }
.cache-sync-indicator.is-updating { color: var(--muted-strong); }
.status-label { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; min-height: 32px; padding: 0 8px; color: var(--muted); font-size: 12px; white-space: nowrap; }
.new-task-button { width: 34px; height: 34px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 9px; background: transparent; color: var(--text); cursor: pointer; }
.new-task-button:hover { background: var(--surface-hover); }
.task-board {
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--canvas);
}
.task-board[hidden] { display: none; }
.app-shell.board-open .topbar,
.app-shell.board-open .messages,
.app-shell.board-open .message-navigation,
.app-shell.board-open .composer-wrap { display: none; }
.settings-view {
  min-width: 0;
  min-height: 0;
  flex: 1;
  display: none;
  flex-direction: column;
  overflow: hidden;
  background: var(--page);
}
.settings-view[hidden] { display: none; }
.app-shell.settings-open .settings-view { display: flex; }
.app-shell.settings-open .topbar,
.app-shell.settings-open .task-board,
.app-shell.settings-open .messages,
.app-shell.settings-open .message-navigation,
.app-shell.settings-open .composer-wrap { display: none; }
.settings-view-header {
  min-height: 84px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: max(20px, env(safe-area-inset-top)) max(24px, calc((100% - 820px) / 2)) 18px;
  border-bottom: 1px solid var(--border);
  background: var(--page);
}
.settings-menu-button { display: none; }
.settings-view-header h1 { margin: 0; color: var(--text); font-size: 24px; font-weight: 650; letter-spacing: -.035em; line-height: 1.2; }
.settings-view-header p { margin: 5px 0 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
.settings-body {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 26px max(24px, calc((100% - 820px) / 2)) max(36px, env(safe-area-inset-bottom));
}
.task-board-header {
  flex: 0 0 auto;
  padding: 22px 24px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--page);
}
.task-board-heading-row { display: flex; align-items: center; gap: 12px; }
.task-board-menu-button { display: none; }
.task-board-heading { min-width: 0; flex: 1; }
.task-board-heading h1 { margin: 0; color: var(--text); font-size: 24px; font-weight: 650; letter-spacing: -0.035em; line-height: 1.2; }
.task-board-heading p { margin: 5px 0 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
.task-board-refresh {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--page);
  color: var(--muted-strong);
  cursor: pointer;
  transition: background .16s cubic-bezier(.2,.8,.2,1), color .16s cubic-bezier(.2,.8,.2,1), transform .16s cubic-bezier(.2,.8,.2,1);
}
.task-board-refresh:hover { background: var(--surface); color: var(--text); }
.task-board-refresh:active { transform: scale(.97); }
.task-board-refresh:focus-visible { outline: 2px solid rgba(16,163,127,.42); outline-offset: 2px; }
.task-board-refresh:disabled { opacity: .48; cursor: default; }
.task-board-refresh.is-loading svg { animation: board-refresh-spin .8s linear infinite; }
.task-board-refresh svg { width: 18px; height: 18px; stroke-width: 1.8; }
@keyframes board-refresh-spin { to { transform: rotate(360deg); } }
.task-board-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 20px; }
.task-board-view-switch { display: inline-grid; grid-template-columns: repeat(2, auto); gap: 3px; padding: 3px; border-radius: 10px; background: var(--surface); }
.task-board-view-button { min-height: 32px; padding: 0 13px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); font: inherit; font-size: 13px; font-weight: 560; cursor: pointer; }
.task-board-view-button:hover { color: var(--text); }
.task-board-view-button.is-active { background: var(--page); color: var(--text); box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.task-board-view-button:focus-visible { outline: 2px solid rgba(16,163,127,.42); outline-offset: 1px; }
.task-board-search { width: min(320px, 42vw); min-height: 38px; display: flex; align-items: center; gap: 9px; padding: 0 11px; border: 1px solid var(--border); border-radius: 10px; background: var(--page); color: var(--muted); }
.task-board-search:focus-within { border-color: rgba(13,13,13,.28); box-shadow: 0 0 0 3px rgba(13,13,13,.05); }
.task-board-search svg { width: 17px; height: 17px; flex: 0 0 auto; }
.task-board-search input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 14px; }
.task-board-search input::placeholder { color: var(--muted); }
.task-board-body { min-width: 0; min-height: 0; flex: 1; overflow: auto; padding: 20px 24px 28px; overscroll-behavior: contain; scrollbar-width: thin; }
.task-board-columns { min-width: 900px; display: grid; grid-template-columns: repeat(4, minmax(210px, 1fr)); align-items: start; gap: 16px; }
.task-board-column { min-width: 0; }
.task-board-column-head { min-height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 2px 8px; color: var(--muted-strong); }
.task-board-column-mark { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--muted); }
.task-board-column[data-lane="running"] .task-board-column-mark { background: var(--green); }
.task-board-column[data-lane="waiting"] .task-board-column-mark { background: var(--orange); }
.task-board-column[data-lane="error"] .task-board-column-mark { background: var(--red); }
.task-board-column[data-lane="queued"] .task-board-column-mark { background: #7c8798; }
.task-board-column-title { font-size: 13px; font-weight: 620; }
.task-board-column-count { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.task-board-card-list { display: grid; gap: 10px; }
.task-board-card {
  position: relative;
  width: 100%;
  min-height: 112px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 15px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--page);
  color: var(--text);
  font: inherit;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
  touch-action: manipulation;
  transition: border-color .16s cubic-bezier(.2,.8,.2,1), transform .16s cubic-bezier(.2,.8,.2,1), box-shadow .16s cubic-bezier(.2,.8,.2,1);
}
.task-board-card:hover { border-color: var(--border-strong); transform: translateY(-1px); box-shadow: 0 8px 22px rgba(0,0,0,.06); }
.task-board-card:active { transform: translateY(0) scale(.99); }
.task-board-card:focus-visible { outline: 2px solid rgba(16,163,127,.42); outline-offset: 2px; }
.task-board-card.is-opening { opacity: .58; cursor: wait; }
.task-board-card-title { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 3; color: var(--text); font-size: 14px; font-weight: 560; line-height: 1.48; overflow-wrap: anywhere; }
.task-board-card-meta { margin-top: auto; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 5px 12px; min-width: 0; color: var(--muted); font-size: 11px; }
.task-board-card-status { display: inline-flex; align-items: center; gap: 5px; min-width: 0; white-space: nowrap; }
.task-board-card-status-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: currentColor; }
.task-board-card[data-lane="running"] .task-board-card-status { color: var(--green); }
.task-board-card[data-lane="waiting"] .task-board-card-status { color: var(--orange); }
.task-board-card[data-lane="error"] .task-board-card-status { color: var(--red); }
.task-board-card-context { grid-column: 1 / -1; min-width: 0; overflow: hidden; color: var(--muted-strong); font-weight: 520; text-overflow: ellipsis; white-space: nowrap; }
.task-board-card-time { grid-column: 2; grid-row: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
.task-board-column-empty { min-height: 104px; display: grid; place-items: center; padding: 18px; border: 1px dashed var(--border-strong); border-radius: 14px; color: var(--muted); font-size: 12px; text-align: center; }
.task-board-completed { width: min(920px, 100%); margin: 0 auto; display: grid; gap: 0; border-top: 1px solid var(--border); }
.task-board-completed-item { width: 100%; min-height: 72px; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 18px; padding: 15px 4px; border: 0; border-bottom: 1px solid var(--border); background: transparent; color: var(--text); font: inherit; text-align: left; text-decoration: none; cursor: pointer; touch-action: manipulation; }
.task-board-completed-item:hover .task-board-completed-title { text-decoration: underline; text-underline-offset: 3px; }
.task-board-completed-item.is-opening { opacity: .58; cursor: wait; }
.task-board-completed-item:focus-visible { outline: 2px solid rgba(16,163,127,.42); outline-offset: 2px; border-radius: 8px; }
.task-board-completed-copy { min-width: 0; display: block; }
.task-board-completed-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 540; }
.task-board-completed-meta { display: block; margin-top: 5px; color: var(--muted); font-size: 12px; }
.task-board-completed-time { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.task-board-empty { min-height: 54vh; display: grid; place-items: center; padding: 40px 20px; text-align: center; }
.task-board-empty-copy { max-width: 360px; }
.task-board-empty-icon { width: 44px; height: 44px; display: grid; place-items: center; margin: 0 auto 16px; border: 1px solid var(--border); border-radius: 14px; color: var(--muted); }
.task-board-empty-icon svg { width: 22px; height: 22px; }
.task-board-empty h2 { margin: 0; color: var(--text); font-size: 17px; font-weight: 620; letter-spacing: -0.02em; }
.task-board-empty p { margin: 7px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
.task-board-skeleton { min-width: 900px; display: grid; grid-template-columns: repeat(4, minmax(210px, 1fr)); gap: 16px; }
.task-board-skeleton-column { display: grid; gap: 10px; }
.task-board-skeleton-line, .task-board-skeleton-card { border-radius: 10px; background: var(--surface); animation: board-skeleton-pulse 1.4s ease-in-out infinite; }
.task-board-skeleton-line { width: 92px; height: 18px; }
.task-board-skeleton-card { height: 116px; }
@keyframes board-skeleton-pulse { 0%, 100% { opacity: .58; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .task-board-refresh.is-loading svg, .task-board-skeleton-line, .task-board-skeleton-card { animation: none; }
  .task-board-card, .sidebar-primary-button { transition: none; }
}
.new-task-button:disabled { opacity: .36; cursor: default; }
.new-task-button svg { width: 18px; height: 18px; }
.status-label::before { content: ""; width: 7px; height: 7px; visibility: hidden; border-radius: 50%; background: transparent; }
.status-label.running::before { visibility: visible; background: var(--green); }
.status-label.starting::before { visibility: visible; border: 1.5px solid var(--border-strong); border-top-color: var(--green); background: transparent; animation: switch-spin .8s linear infinite; }
.status-label.approval::before, .status-label.input::before { visibility: visible; background: var(--orange); }
.status-label.error::before { visibility: visible; background: var(--red); }

.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 38px 24px 112px;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
}
.message-row { width: min(100%, var(--thread-max)); display: flex; margin: 0 auto 20px; }
.message-row.user { justify-content: flex-end; }
.message-card { min-width: 0; max-width: 100%; color: var(--text); font-size: 16px; line-height: 1.52; overflow-wrap: anywhere; }
.message-row.user .message-card { max-width: min(78%, 38rem); padding: 10px 16px; border-radius: 20px; background: var(--surface); }
.message-row.assistant { margin-bottom: 16px; }
.message-row.assistant.continues { margin-bottom: 10px; }
.message-row.assistant .message-card { width: 100%; color: var(--text); font-size: 15px; line-height: 1.62; }
.message-row.assistant.commentary .message-card { padding-left: 0; border-left: 0; color: var(--text); }
.message-model { margin-top: 10px; color: var(--muted); font-size: 11px; font-weight: 430; line-height: 1.4; }
.run-header { width: min(100%, var(--thread-max)); display: flex; align-items: center; gap: 9px; margin: -4px auto 13px; color: var(--muted-strong); font-size: 13px; font-weight: 560; }
.run-header-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--green); }
.run-header.running .run-header-dot { animation: run-pulse 1.4s ease-in-out infinite; }
.run-header.approval .run-header-dot { background: var(--orange); }
.run-header.unknown .run-header-dot { background: var(--muted); }
.run-header.failed .run-header-dot, .run-header.interrupted .run-header-dot { background: var(--red); }
.run-failure { width: min(100%, var(--thread-max)); margin: -2px auto 18px; padding: 12px 14px; border: 1px solid rgba(196, 55, 55, .18); border-radius: 12px; background: rgba(196, 55, 55, .055); color: var(--text); font-size: 13px; line-height: 1.6; }
.run-failure-title { margin-bottom: 3px; color: var(--red); font-weight: 620; }
.run-failure-detail { color: var(--muted-strong); white-space: pre-wrap; }
@keyframes run-pulse { 0%, 100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
.run-progress { width: min(100%, var(--thread-max)); display: grid; gap: 9px; margin: 0 auto 24px; color: var(--muted); font-size: 14px; font-weight: 400; line-height: 1.45; }
.run-progress-item { min-width: 0; display: flex; align-items: flex-start; gap: 9px; font-size: inherit; font-weight: inherit; }
.run-progress-dot { width: 7px; height: 7px; flex: 0 0 auto; margin-top: 7px; border: 1.5px solid currentColor; border-radius: 50%; opacity: .62; }
.run-progress-item.running { color: var(--muted-strong); }
.run-progress-item.running .run-progress-dot { border-color: var(--green); animation: run-pulse 1.4s ease-in-out infinite; }
.run-progress-item.failed { color: var(--red); }
.run-progress-text { min-width: 0; overflow-wrap: anywhere; }
.run-progress-history { margin: 1px 0 2px 16px; color: var(--muted); }
.run-progress-history > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; padding: 0 2px; cursor: pointer; list-style: none; font-size: 12px; }
.run-progress-history > summary::-webkit-details-marker { display: none; }
.run-progress-history-items { display: grid; gap: 7px; padding: 5px 0 5px; }
.run-progress-fold-open { display: none; }
.run-progress-history[open] .run-progress-fold-closed { display: none; }
.run-progress-history[open] .run-progress-fold-open { display: inline; }
.run-progress-fold-action { color: var(--muted); font-size: 11px; }
.approval-card { width: min(100%, var(--thread-max)); margin: 0 auto 20px; padding: 16px; border: 1px solid rgba(217,119,6,.24); border-radius: 16px; background: rgba(245,158,11,.07); }
.approval-card-kicker { color: var(--orange); font-size: 12px; font-weight: 650; }
.approval-card-title { margin-top: 7px; color: var(--text); font-size: 15px; font-weight: 600; line-height: 1.45; }
.approval-card-detail { margin-top: 11px; }
.approval-card-detail-label { margin-bottom: 5px; color: var(--muted); font-size: 11px; }
.approval-card-detail pre { margin: 0; padding: 11px 12px; overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--page); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.approval-card-hint { margin-top: 10px; color: var(--muted-strong); font-size: 12px; line-height: 1.5; }
.approval-card-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.approval-action { min-height: 34px; padding: 0 13px; border: 1px solid var(--border-strong); border-radius: 999px; background: var(--page); color: var(--text); font-size: 12px; font-weight: 600; cursor: pointer; }
.approval-action.primary { border-color: var(--accent); background: var(--accent); color: var(--page); }
.approval-action.danger { color: var(--red); }
.approval-action:disabled { opacity: .5; cursor: default; }
.approval-result { width: min(100%, var(--thread-max)); margin: 0 auto 18px; padding: 12px 14px; border: 1px solid rgba(22,163,74,.18); border-radius: 14px; background: rgba(22,163,74,.055); color: var(--muted-strong); }
.approval-result.denied { border-color: rgba(208,14,23,.16); background: rgba(208,14,23,.045); }
.approval-result-heading { display: flex; align-items: center; gap: 8px; color: var(--text); font-size: 13px; font-weight: 650; line-height: 1.4; }
.approval-result-icon { display: inline-grid; width: 19px; height: 19px; place-items: center; flex: 0 0 auto; border-radius: 50%; background: rgba(22,163,74,.12); color: var(--green); font-size: 12px; }
.approval-result.denied .approval-result-icon { background: rgba(208,14,23,.1); color: var(--red); }
.approval-result-summary { margin-top: 6px; font-size: 12px; line-height: 1.5; }
.approval-result-detail { margin-top: 8px; }
.approval-result-detail-label { margin-bottom: 4px; color: var(--muted); font-size: 10px; }
.approval-result-detail pre { margin: 0; padding: 8px 10px; overflow-x: auto; border-radius: 9px; background: rgba(127,127,127,.055); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted-strong); font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.message-row.user.pending .message-card { opacity: .76; }
.message-row.user.failed .message-card { border: 1px solid rgba(208,14,23,.22); }
.message-delivery { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 5px; color: var(--muted); font-size: 10px; line-height: 1.3; }
.message-delivery.failed { color: var(--red); }
.message-images { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 0 9px; }
.message-images.single { grid-template-columns: minmax(0, 1fr); }
.message-image-button { position: relative; width: 100%; min-width: 0; margin: 0; padding: 0; overflow: hidden; border: 0; border-radius: 12px; background: var(--surface); cursor: zoom-in; }
.message-image-button img { width: 100%; max-height: 420px; display: block; object-fit: contain; background: var(--surface); }
.message-image-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.message-image-button.failed { min-height: 96px; cursor: default; }
.message-image-button.failed img { display: none; }
.message-image-error { display: none; padding: 24px 12px; color: var(--muted); font-size: 12px; line-height: 1.45; text-align: center; }
.message-image-button.failed .message-image-error { display: block; }
.image-viewer { position: fixed; inset: 0; z-index: 120; display: grid; grid-template-rows: auto minmax(0, 1fr); padding: max(14px, env(safe-area-inset-top)) max(14px, env(safe-area-inset-right)) max(14px, env(safe-area-inset-bottom)) max(14px, env(safe-area-inset-left)); background: rgba(0, 0, 0, .92); }
.image-viewer[hidden] { display: none; }
.image-viewer-toolbar { display: flex; justify-content: flex-end; padding-bottom: 10px; }
.image-viewer-close { min-width: 56px; height: 36px; padding: 0 14px; border: 0; border-radius: 18px; background: rgba(255, 255, 255, .14); color: #fff; font: inherit; cursor: pointer; }
.image-viewer-stage { min-height: 0; display: grid; place-items: center; overflow: auto; }
.image-viewer-stage img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
body.image-viewer-open { overflow: hidden; }
.message-retry { padding: 0; border: 0; background: transparent; color: inherit; font-size: inherit; font-weight: 650; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.message-content { -webkit-user-select: text; user-select: text; -webkit-touch-callout: default; }
.response-pending { width: min(100%, var(--thread-max)); display: flex; align-items: center; gap: 4px; margin: -8px auto 20px; padding-left: 2px; color: var(--muted); }
.response-pending-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .28; animation: response-pending-dot 1.15s ease-in-out infinite; }
.response-pending-dot:nth-child(2) { animation-delay: .16s; }
.response-pending-dot:nth-child(3) { animation-delay: .32s; }
@keyframes response-pending-dot { 0%, 60%, 100% { opacity: .24; transform: translateY(0); } 30% { opacity: .9; transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .response-pending-dot { animation: none; opacity: .5; } }
.message-content > :first-child { margin-top: 0; }
.message-content > :last-child { margin-bottom: 0; }
.message-content p { margin: 0 0 10px; }
.message-content h1, .message-content h2, .message-content h3, .message-content h4, .message-content h5, .message-content h6 { margin: 12px 0; font-size: inherit; font-weight: inherit; letter-spacing: inherit; line-height: inherit; }
.message-content ul, .message-content ol { margin: 6px 0 12px; padding-left: 22px; }
.message-content li { margin: 4px 0; }
.message-content strong { font-weight: 620; }
.message-content blockquote { margin: 12px 0; padding: 1px 0 1px 14px; border-left: 2px solid #d1d1d1; color: var(--muted-strong); }
.message-content pre { overflow-x: auto; margin: 14px 0; padding: 14px 16px; border: 1px solid var(--border); border-radius: 12px; background: #f7f7f7; font: 13px/1.58 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.message-content code { padding: 2px 5px; border-radius: 5px; background: #f2f2f2; font: .88em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.message-content pre code { padding: 0; background: transparent; font-size: inherit; }
.message-code-fold { overflow: hidden; margin: 14px 0; border: 1px solid var(--border); border-radius: 12px; background: #f7f7f7; }
.message-code-fold > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; padding: 0 13px; cursor: pointer; list-style: none; color: var(--muted-strong); font-size: 12px; line-height: 1.4; }
.message-code-fold > summary::-webkit-details-marker { display: none; }
.message-code-fold > pre { margin: 0; border: 0; border-top: 1px solid var(--border); border-radius: 0; }
.message-code-fold-open { display: none; }
.message-code-fold[open] .message-code-fold-closed { display: none; }
.message-code-fold[open] .message-code-fold-open { display: inline; }
.message-code-fold-action { flex: 0 0 auto; color: var(--muted); font-size: 11px; }
.message-content a { color: #0b57d0; text-decoration: underline; text-decoration-color: rgba(11, 87, 208, 0.32); text-underline-offset: 2px; }
.message-content hr { height: 1px; margin: 22px 0; border: 0; background: var(--border); }
.message-content img { max-width: 100%; height: auto; border-radius: 12px; }
.loading-row { padding: 30px 16px; color: var(--muted); text-align: center; font-size: 13px; }
.empty-state { min-height: 62vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: var(--muted); }
.empty-wordmark { color: var(--text); font-size: 30px; font-weight: 560; letter-spacing: -0.035em; line-height: 1; }
.empty-state h1 { margin: 18px 0 6px; color: var(--text); font-size: 20px; font-weight: 580; letter-spacing: -0.02em; }
.empty-state p { margin: 0; max-width: 300px; font-size: 14px; line-height: 1.55; }

.composer-wrap {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 20px 24px max(12px, env(safe-area-inset-bottom));
  background: linear-gradient(to bottom, rgba(255,255,255,0), rgba(255,255,255,.94) 32%, #fff 62%);
  z-index: 12;
}
.composer { width: min(100%, var(--thread-max)); margin-left: auto; margin-right: auto; }
.composer-queue { width: calc(100% - 40px); max-width: calc(var(--thread-max) - 40px); display: grid; gap: 0; max-height: 190px; overflow: hidden auto; overscroll-behavior: contain; scrollbar-width: thin; margin: 0 auto; border: 1px solid var(--border); border-radius: 16px; background: var(--page); }
.composer-queue[hidden], .composer-media[hidden] { display: none; }
.composer-media { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; padding: 2px 2px 4px; }
.composer-media-item { position: relative; width: 72px; height: 72px; flex: 0 0 auto; }
.composer-media-preview { width: 100%; height: 100%; display: block; padding: 0; border: 0; border-radius: 12px; background: transparent; cursor: zoom-in; }
.composer-media-preview:focus { outline: 0; }
.composer-media-preview:focus-visible { box-shadow: 0 0 0 2px rgba(16,163,127,.28); }
.composer-media-item img { width: 100%; height: 100%; display: block; object-fit: cover; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.composer-media-remove { position: absolute; z-index: 1; top: -6px; right: -6px; width: 22px; height: 22px; display: grid; place-items: center; padding: 0; border: 2px solid var(--page); border-radius: 50%; background: var(--accent); color: var(--page); cursor: pointer; }
.composer-media-remove svg { width: 11px; height: 11px; stroke-width: 2.2; }
.composer-model-control { position: relative; min-width: 0; align-self: end; }
.composer-model-control[hidden] { display: none; }
.composer-model-button { max-width: 100%; min-height: 32px; display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; border: 0; border-radius: 9px; background: transparent; color: var(--muted-strong); font: inherit; font-size: 12px; cursor: pointer; }
.composer-model-button:hover { background: var(--surface); color: var(--text); }
.composer-model-button:focus { outline: 0; }
.composer-model-button:focus-visible { box-shadow: inset 0 0 0 2px rgba(16,163,127,.24); }
.composer-model-button[aria-disabled="true"] { cursor: default; }
.composer-model-button.is-loading { opacity: .58; cursor: wait; }
.composer-model-button span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-model-chevron { width: 14px; height: 14px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.6; }
.composer-model-button.is-readonly .composer-model-chevron { display: none; }
.composer-model-menu { position: absolute; left: 0; bottom: calc(100% + 8px); width: fit-content; max-width: min(420px, calc(100vw - 48px)); min-width: 148px; max-height: min(360px, 52vh); overflow: auto; padding: 5px; border: 1px solid var(--border); border-radius: 13px; background: var(--page); box-shadow: var(--shadow); z-index: 30; }
.composer-reasoning-menu { left: auto; right: 0; width: fit-content; max-width: min(280px, calc(100vw - 48px)); min-width: 96px; }
.composer-permission-menu { left: auto; right: 0; width: fit-content; max-width: min(360px, calc(100vw - 48px)); min-width: 96px; }
.composer-model-menu[hidden] { display: none; }
.composer-model-group { padding: 7px 9px 3px; color: var(--muted); font-size: 11px; font-weight: 560; letter-spacing: .02em; white-space: nowrap; user-select: none; -webkit-user-select: none; pointer-events: none; }
.composer-model-group:not(:first-child) { margin-top: 3px; border-top: 1px solid var(--border); }
.composer-model-option { width: 100%; min-height: 44px; display: grid; grid-template-columns: minmax(0, 1fr) 18px; gap: 10px; align-items: center; padding: 7px 9px; border: 0; border-radius: 9px; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.composer-model-option:hover { background: var(--surface); }
.composer-model-option:disabled { opacity: .48; cursor: wait; }
.composer-model-option-copy { min-width: 0; }
.composer-model-option-label { display: block; overflow-wrap: anywhere; white-space: normal; font-size: 13px; font-weight: 560; }
.composer-model-option-description { display: block; margin-top: 2px; overflow-wrap: anywhere; white-space: normal; color: var(--muted); font-size: 11px; font-weight: 430; }
.composer-model-option-check { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
.queued-followup { min-width: 0; background: var(--page); }
.queued-followup + .queued-followup { border-top: 1px solid var(--border); }
.queued-followup-main { display: flex; align-items: center; gap: 9px; padding: 4px 4px 0px 8px; }
.queued-followup-icon { width: 20px; height: 20px; flex: 0 0 auto; display: grid; place-items: center; color: var(--muted); }
.queued-followup-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
.queued-followup-copy { flex: 1; min-width: 0; }
.queued-followup-text { max-height: 44px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text); font-size: 14px; line-height: 1.45; }
.queued-followup-status, .queued-followup-images { margin-top: 2px; color: var(--muted); font-size: 11px; font-weight: 430; line-height: 1.35; }
.queued-followup-status.is-pending { color: var(--muted-strong); }
.queued-followup-actions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.queued-followup-action { min-width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 0 7px; border: 0; border-radius: 9px; background: transparent; color: var(--muted-strong); font: inherit; font-size: 13px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.queued-followup-action:hover { background: var(--surface); color: var(--text); }
.queued-followup-action:focus { outline: 0; }
.queued-followup-action:focus-visible { box-shadow: inset 0 0 0 2px rgba(16,163,127,.24); }
.queued-followup-action:disabled { opacity: .42; cursor: default; }
.queued-followup-action svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
.composer {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 36px;
  align-items: flex-end;
  gap: 4px;
  min-height: 52px;
  padding: 8px;
  border: 0;
  border-radius: 28px;
  background: var(--page);
  box-shadow: 0 0 0 1px rgba(0,0,0,.04), 0 2px 8px rgba(0,0,0,.04), 0 4px 80px 8px rgba(0,0,0,.024);
  transition: box-shadow .16s ease;
}
.composer:focus-within { box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 2px 10px rgba(0,0,0,.055), 0 8px 80px 10px rgba(0,0,0,.03); }
.composer-image-button, .send-button { width: 36px; height: 36px; flex: 0 0 auto; display: grid; place-items: center; margin: 0; padding: 0; border: 0; border-radius: 50%; cursor: pointer; }
.composer-image-button { grid-column: 1; background: transparent; color: var(--text); }
.composer-settings-controls { grid-column: 2; min-width: 0; display: flex; align-items: center; gap: 6px; }
.composer-settings-controls[hidden], .composer-model-control[hidden] { display: none; }
.composer-model-control { position: relative; min-width: 0; }
.composer-image-button:hover { background: var(--surface); }
.composer-image-button svg { width: 19px; height: 19px; stroke-width: 1.7; }
.composer textarea { grid-column: 1 / -1; min-width: 0; min-height: 36px; max-height: 164px; resize: none; border: 0; outline: 0; padding: 6px 8px; background: transparent; color: var(--text); font-size: 16px; line-height: 24px; }
.composer textarea::placeholder { color: #8f8f8f; }
.send-button { grid-column: 3; background: var(--accent); color: white; }
.send-button svg { width: 18px; height: 18px; stroke-width: 2; }
.send-button .send-stop-icon { width: 20px; height: 20px; display: none; fill: currentColor; stroke: none; }
.send-button.is-stop .send-arrow-icon { display: none; }
.send-button.is-stop .send-stop-icon { display: block; }
.send-button:disabled { background: #d7d7d7; color: #fff; cursor: default; }
.send-button.is-stop:disabled { background: var(--accent); opacity: .58; }
.message-navigation { position: absolute; left: auto; top: 68px; right: max(24px, calc((100% - var(--thread-max)) / 2)); bottom: auto; display: flex; align-items: center; gap: 7px; z-index: 14; opacity: .62; transition: opacity .16s ease; }
.message-navigation:hover, .message-navigation:focus-within { opacity: 1; }
.message-navigation-button { width: 36px; height: 36px; display: grid; place-items: center; padding: 0; border: 1px solid var(--border); border-radius: 12px; background: rgba(255,255,255,.72); backdrop-filter: blur(10px); box-shadow: 0 4px 16px rgba(0,0,0,.10); color: var(--muted-strong); cursor: pointer; }
.message-navigation-button:hover { color: var(--text); background: rgba(255,255,255,.94); }
.message-navigation-button svg { width: 19px; height: 19px; stroke-width: 2; }
.task-context-menu {
  position: fixed;
  min-width: 178px;
  padding: 5px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--page);
  box-shadow: var(--shadow);
  z-index: 60;
}
.task-context-menu button {
  width: 100%;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.task-context-menu button:hover { background: var(--surface-hover); }
.task-context-menu button:focus { outline: 0; }
.task-context-menu button:focus-visible { box-shadow: inset 0 0 0 2px rgba(16,163,127,.24); }
.task-context-menu svg { width: 17px; height: 17px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
.task-rename-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0,0,0,.28);
  z-index: 70;
}
.task-rename-dialog {
  width: min(100%, 420px);
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 18px;
  background: var(--page);
  box-shadow: var(--shadow);
}
.task-rename-title { margin-bottom: 16px; font-size: 17px; font-weight: 650; letter-spacing: -.025em; }
.task-rename-input {
  width: 100%;
  min-height: 46px;
  padding: 0 13px;
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  outline: 0;
  background: var(--page);
  color: var(--text);
  font: inherit;
  font-size: 16px;
  -webkit-user-select: text;
  user-select: text;
}
.task-rename-input:focus { border-color: rgba(13,13,13,.42); box-shadow: 0 0 0 3px rgba(13,13,13,.07); }
.task-rename-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.task-rename-actions button { min-width: 72px; min-height: 40px; padding: 0 15px; border: 0; border-radius: 10px; font: inherit; font-size: 14px; font-weight: 580; cursor: pointer; }
.task-rename-cancel { background: var(--surface); color: var(--text); }
.task-rename-save { background: var(--accent); color: var(--page); }
.settings-loading { padding: 24px 0; text-align: center; color: var(--muted); font-size: 14px; }
.settings-section { margin-top: 28px; }
.settings-section:first-child { margin-top: 0; }
.settings-section-title { font-size: 15px; font-weight: 630; color: var(--text); margin-bottom: 8px; }
.settings-note { font-size: 12px; color: var(--muted); line-height: 1.5; margin: 6px 0 10px; }
.settings-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.settings-toggle-row:last-child { border-bottom: 0; }
.settings-toggle-label { font-size: 14px; }
.settings-toggle-label small { display: block; margin-top: 3px; color: var(--muted); font-size: 12px; font-weight: 430; line-height: 1.45; }
.settings-toggle {
  position: relative;
  flex: 0 0 auto;
  width: 44px;
  height: 26px;
  border: 0;
  border-radius: 999px;
  background: var(--border-strong);
  cursor: pointer;
  transition: background .18s ease;
  appearance: none;
  -webkit-appearance: none;
}
.settings-toggle::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--page);
  box-shadow: 0 1px 3px rgba(0,0,0,.25);
  transition: transform .18s ease;
}
.settings-toggle.is-on { background: var(--accent); }
.settings-toggle.is-on::after { transform: translateX(18px); }
.settings-rule-list { list-style: none; margin: 0; padding: 0; }
.settings-rule-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.settings-rule-item:last-child { border-bottom: 0; }
.settings-rule-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); flex: 0 0 auto; transform: translateY(-1px); }
.settings-rule-label { font-size: 14px; font-weight: 580; }
.settings-rule-desc { display: block; margin-top: 2px; color: var(--muted); font-size: 12px; font-weight: 430; line-height: 1.45; }
.settings-provider { padding: 17px 0; border-bottom: 1px solid var(--border); }
.settings-provider:last-child { border-bottom: 0; }
.settings-provider-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.settings-provider-name { font-size: 15px; font-weight: 620; }
.settings-provider-status { flex: 0 0 auto; color: var(--muted); font-size: 12px; }
.settings-provider-status::before { content: ""; width: 7px; height: 7px; display: inline-block; margin-right: 6px; border-radius: 50%; background: var(--border-strong); }
.settings-provider-status.is-ready::before { background: var(--green); }
.settings-provider-status.is-installing::before { background: #d6a44b; animation: task-pulse 1.35s ease-in-out infinite; }
.settings-provider-source { margin-top: 6px; color: var(--muted); font-size: 12px; line-height: 1.55; }
.settings-provider-capabilities { margin-top: 7px; color: var(--muted-strong); font-size: 12px; line-height: 1.5; }
.settings-provider-deps { margin-top: 12px; border-top: 1px solid var(--border); }
.settings-dep-line { padding: 11px 0; border-bottom: 1px solid var(--border); }
.settings-dep-line:last-child { border-bottom: 0; padding-bottom: 0; }
.settings-dep-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.settings-dep-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--border-strong); }
.settings-dep-line.is-ready .settings-dep-dot { background: var(--green); }
.settings-dep-line.is-installing .settings-dep-dot { background: #d6a44b; animation: task-pulse 1.35s ease-in-out infinite; }
.settings-dep-line.is-missing .settings-dep-dot,
.settings-dep-line.is-failed .settings-dep-dot { background: #c9675a; }
.settings-dep-label { flex: 1; min-width: 0; color: var(--text); font-size: 13px; font-weight: 550; }
.settings-dep-status { flex: 0 0 auto; color: var(--muted); font-size: 11px; }
.settings-dep-detail { margin: 6px 0 0 15px; max-height: 2.9em; overflow: hidden; color: var(--muted); font-size: 12px; line-height: 1.45; }
.settings-dep-line.is-expanded .settings-dep-detail { max-height: none; }
.settings-dep-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 9px; }
.settings-dep-action { min-height: 32px; padding: 0 11px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--page); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
.settings-dep-action:hover { background: var(--surface-hover); }
.settings-dep-action.is-primary { border-color: var(--accent); background: var(--accent); color: var(--page); }
.settings-dep-action:disabled { opacity: .48; cursor: default; }

.task-rename-actions button:disabled { opacity: .46; cursor: default; }
body.task-rename-open { overflow: hidden; }
.toast { position: fixed; left: 50%; bottom: calc(82px + env(safe-area-inset-bottom)); max-width: calc(100vw - 36px); transform: translate(-50%, 14px); padding: 9px 13px; border-radius: 10px; background: rgba(13,13,13,.9); color: white; font-size: 12px; opacity: 0; pointer-events: none; transition: .18s ease; z-index: 40; }
.toast.is-visible { opacity: 1; transform: translate(-50%, 0); }

@media (hover: none) and (pointer: coarse) {
  button:active { opacity: .72; }
  .icon-button:active, .composer-image-button:active { background: transparent; }
  a:active { background: transparent; }
}

@media (max-width: 760px) {
  .about-topbar { padding-left: 18px; padding-right: 18px; }
  .about-main { padding-left: 20px; padding-right: 20px; }
  .about-hero { padding-top: 70px; padding-bottom: 74px; }
  .about-hero h1 { font-size: clamp(42px, 13vw, 64px); }
  .about-statement { margin-bottom: 64px; padding: 28px 24px; border-radius: 22px; }
  .about-section { padding: 62px 0; }
  .about-grid-four, .about-two-column { grid-template-columns: 1fr; }
  .about-card { min-height: 0; }
  .about-card h3 { margin-bottom: 30px; }
  .about-flow { grid-template-columns: 1fr; }
  .about-flow-arrow { transform: rotate(90deg); justify-self: center; }
  .about-footer { align-items: flex-start; flex-direction: column; }
  .app-shell { display: block; }
  .sidebar { position: fixed; inset: 0 auto 0 0; width: min(86vw, 300px); transform: translateX(-102%); transition: transform .2s ease, visibility 0s linear .2s; box-shadow: var(--shadow); }
  .app-shell:not(.sidebar-open) .sidebar { visibility: hidden; pointer-events: none; }
  .app-shell.sidebar-open .sidebar { visibility: visible; pointer-events: auto; transform: translateX(0); transition-delay: 0s; }
  .app-shell.sidebar-open .main-panel { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
  .sidebar-overlay { position: fixed; inset: 0; display: block; background: rgba(0,0,0,.28); opacity: 0; pointer-events: none; transition: opacity .2s ease; z-index: 15; }
  .app-shell.sidebar-open .sidebar-overlay { opacity: 1; pointer-events: auto; }
  .settings-view-header { min-height: 72px; padding: max(14px, env(safe-area-inset-top)) 16px 14px; }
  .settings-menu-button { display: grid; margin-left: -4px; }
  .settings-view-header h1 { font-size: 20px; }
  .settings-view-header p { max-width: 68vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .settings-body { padding: 22px 18px max(32px, env(safe-area-inset-bottom)); }
  .sidebar-close, .menu-button { display: grid; }
  .topbar { position: absolute; top: 0; left: 0; right: 0; min-height: 52px; padding: max(8px, env(safe-area-inset-top)) 8px 8px; background: rgba(255,255,255,.86); z-index: 12; }
  .menu-button { border-radius: 8px; }
  .topbar-copy { gap: 7px; }
  .sidebar-head .workspace-product { font-size: 15px; }
  .task-board-header { padding: max(12px, env(safe-area-inset-top)) 16px 14px; }
  .task-board-heading-row { gap: 8px; }
  .task-board-menu-button { display: grid; margin-left: -4px; }
  .task-board-heading h1 { font-size: 20px; }
  .task-board-heading p { max-width: 64vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .task-board-toolbar { align-items: stretch; flex-direction: column; gap: 10px; margin-top: 15px; }
  .task-board-view-switch { width: 100%; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .task-board-search { width: 100%; }
  .task-board-body { overflow-x: hidden; padding: 18px 16px max(28px, env(safe-area-inset-bottom)); scroll-snap-type: none; }
  .task-board-columns { width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 22px; }
  .task-board-column { width: auto; min-width: 0; }
  .task-board-column.is-empty { display: none; }
  .task-board-column-head { min-height: 30px; padding: 0 2px 7px; }
  .task-board-column-title { font-size: 14px; }
  .task-board-card-list { gap: 9px; }
  .task-board-card { min-height: 0; gap: 12px; padding: 14px 15px; }
  .task-board-card-title { -webkit-line-clamp: 2; font-size: 15px; line-height: 1.46; }
  .task-board-card-meta { gap: 4px 12px; font-size: 12px; }
  .task-board-completed-item { min-height: 78px; padding-left: 2px; padding-right: 2px; }
  .task-board-completed-title { white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .task-board-skeleton { width: 100%; min-width: 0; grid-template-columns: minmax(0, 1fr); gap: 20px; }
  .task-board-skeleton-column:nth-child(n + 3) { display: none; }
  .topbar-title { max-width: 46vw; font-size: 11px; }
  .status-label { width: 28px; padding: 0; justify-content: center; font-size: 0; }
  .topbar-actions { gap: 1px; }
  .cache-sync-indicator { min-width: 24px; padding: 0 6px; justify-content: center; }
  .cache-sync-text { display: none; }
  .new-task-button { width: 34px; height: 34px; }
  .messages { padding: calc(64px + env(safe-area-inset-top)) 16px 116px; }
  .message-row { margin-bottom: 18px; }
  .message-card { font-size: 16px; line-height: 1.5; }
  .message-row.user .message-card { max-width: 88%; padding: 9px 14px; border-radius: 18px; }
  .composer-wrap { padding: 20px 16px max(8px, env(safe-area-inset-bottom)); }
  .composer-queue { max-height: 172px; }
  .queued-followup-main { gap: 8px; padding-left: 12px; }
  .queued-followup-action { min-width: 32px; width: 32px; padding: 0; }
  .queued-followup-action-label { display: none; }
  .queued-followup-action-label.steer-label { display: inline; }
  .queued-followup-action.steer-action { width: auto; padding: 0 6px; }
  .queued-followup-edit { padding-left: 40px; }
  .composer { min-height: 52px; padding: 8px; border-radius: 28px; }
  .composer textarea { width: 100%; }
  .message-navigation { left: auto; top: calc(64px + env(safe-area-inset-top)); right: 16px; bottom: auto; }
  .task-rename-overlay { align-items: flex-end; padding: 12px 12px max(12px, env(safe-area-inset-bottom)); }
  .task-rename-dialog { padding: 20px; border-radius: 18px; }
}

@media (max-width: 360px) {
  .topbar-title { display: none; }
  .messages { padding-left: 14px; padding-right: 14px; }
  .composer-wrap { padding-left: 12px; padding-right: 12px; }
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #212121;
    --canvas: #212121;
    --sidebar: #171717;
    --surface: #2f2f2f;
    --surface-hover: #2b2b2b;
    --surface-selected: #2f2f2f;
    --border: rgba(255,255,255,.08);
    --border-strong: rgba(255,255,255,.14);
    --text: #ececec;
    --muted: #a3a3a3;
    --muted-strong: #b4b4b4;
    --accent: #ececec;
    --shadow: 0 12px 40px rgba(0,0,0,.36);
  }
  .send-button { color: #212121; }
  .auth-submit { color: #212121; }
  .auth-field input { background: #2a2a2a; }
  .auth-field input:focus { border-color: rgba(255,255,255,.34); box-shadow: 0 0 0 3px rgba(255,255,255,.06); }
  .auth-security-warning { color: #e7a363 !important; }
  .about-topbar { background: rgba(33,33,33,.88); }
  .topbar { background: rgba(33,33,33,.88); }
  .message-navigation-button { background: rgba(33,33,33,.72); }
  .message-navigation-button:hover { background: rgba(47,47,47,.94); }
  .icon-button:active { background: #333; }
  .message-content pre, .message-content code { background: #2b2b2b; }
  .message-content pre code { background: transparent; }
  .composer { background: #303030; box-shadow: 0 0 0 1px rgba(255,255,255,.06), 0 2px 12px rgba(0,0,0,.22); }
  .composer-wrap { background: linear-gradient(to bottom, rgba(33,33,33,0), rgba(33,33,33,.94) 32%, #212121 62%); }
  .composer-image-button:hover { background: #3a3a3a; }
  .message-content a { color: #7ab7ff; }
  .task-board-search:focus-within { border-color: rgba(255,255,255,.24); box-shadow: 0 0 0 3px rgba(255,255,255,.05); }
  .task-board-view-button.is-active { box-shadow: 0 1px 3px rgba(0,0,0,.32); }
  .task-board-card:hover { box-shadow: 0 8px 22px rgba(0,0,0,.22); }
}
`;

export const CODEX_MOBILE_JS = String.raw`
(function () {
  "use strict";

  var app = document.getElementById("app");
  var bootScreen = document.getElementById("boot-screen");
  var bootStatus = document.getElementById("boot-status");
  var bootDetail = document.getElementById("boot-detail");
  var authScreen = document.getElementById("auth-screen");
  var authForm = document.getElementById("auth-form");
  var authTitle = document.getElementById("auth-title");
  var authDescription = document.getElementById("auth-description");
  var authPassword = document.getElementById("auth-password");
  var authSubmit = document.getElementById("auth-submit");
  var authError = document.getElementById("auth-error");
  var authSecurityWarning = document.getElementById("auth-security-warning");
  var authHint = document.getElementById("auth-hint");
  var authLogout = document.getElementById("auth-logout");
  var taskList = document.getElementById("task-list");
  var taskBoard = document.getElementById("task-board");
  var taskBoardOpen = document.getElementById("task-board-open");
  var taskBoardCount = document.getElementById("task-board-count");
  var taskBoardMenuButton = document.getElementById("task-board-menu-button");
  var taskBoardBody = document.getElementById("task-board-body");
  var taskBoardSubtitle = document.getElementById("task-board-subtitle");
  var taskBoardRefresh = document.getElementById("task-board-refresh");
  var taskBoardViewActive = document.getElementById("task-board-view-active");
  var taskBoardViewCompleted = document.getElementById("task-board-view-completed");
  var taskBoardSearch = document.getElementById("task-board-search");
  var taskViewProjects = document.getElementById("task-view-projects");
  var taskViewRecent = document.getElementById("task-view-recent");
  var searchInput = document.getElementById("task-search");
  var messagesEl = document.getElementById("messages");
  var titleEl = document.getElementById("current-title");
  var metaEl = document.getElementById("current-meta");
  var statusEl = document.getElementById("current-status");
  var cacheSyncIndicator = document.getElementById("cache-sync-indicator");
  var newTaskButton = document.getElementById("new-task-button");
  var workspaceSwitcher = document.getElementById("workspace-switcher");
  var workspaceMenu = document.getElementById("workspace-menu");
  var adapterMenu = document.getElementById("adapter-menu");
  var activeAdapterLabel = document.getElementById("active-adapter-label");
  var workspaceSwitchProgress = document.getElementById("workspace-switch-progress");
  var composerForm = document.getElementById("composer-form");
  var composerInput = document.getElementById("composer-input");
  var composerImageInput = document.getElementById("composer-image-input");
  var composerImageButton = document.getElementById("composer-image-button");
  var composerMedia = document.getElementById("composer-media");
  var composerModelControl = document.getElementById("composer-model-control");
  var composerSettingsControls = document.getElementById("composer-settings-controls");
  var composerModelButton = document.getElementById("composer-model-button");
  var composerModelLabel = document.getElementById("composer-model-label");
  var composerModelMenu = document.getElementById("composer-model-menu");
  var composerReasoningControl = document.getElementById("composer-reasoning-control");
  var composerReasoningButton = document.getElementById("composer-reasoning-button");
  var composerReasoningLabel = document.getElementById("composer-reasoning-label");
  var composerReasoningMenu = document.getElementById("composer-reasoning-menu");
  var composerPermissionControl = document.getElementById("composer-permission-control");
  var composerPermissionButton = document.getElementById("composer-permission-button");
  var composerPermissionLabel = document.getElementById("composer-permission-label");
  var composerPermissionMenu = document.getElementById("composer-permission-menu");
  var sendButton = document.getElementById("send-button");
  var messageNavigation = document.getElementById("message-navigation");
  var previousUserMessage = document.getElementById("previous-user-message");
  var nextUserMessage = document.getElementById("next-user-message");
  var toastEl = document.getElementById("toast");
  var composerQueue = document.getElementById("composer-queue");
  var taskContextMenu = document.getElementById("task-context-menu");
  var taskContextRename = document.getElementById("task-context-rename");
  var taskContextCopyId = document.getElementById("task-context-copy-id");
  var taskRenameOverlay = document.getElementById("task-rename-overlay");
  var taskRenameForm = document.getElementById("task-rename-form");
  var taskRenameInput = document.getElementById("task-rename-input");
  var taskRenameCancel = document.getElementById("task-rename-cancel");
  var taskRenameSave = document.getElementById("task-rename-save");
  var settingsView = document.getElementById("settings-view");
  var settingsBody = document.getElementById("settings-body");
  var settingsOpen = document.getElementById("settings-open");
  var settingsMenuButton = document.getElementById("settings-menu-button");
  var settingsRefreshTimer = null;

  var state = {
    setupToken: "",
    authMode: "login",
    authenticated: false,
    cachePreviewMode: false,
    authenticationRetryTimer: null,
    persistentCacheAuthenticatedAtMs: 0,
    appStarted: false,
    adapters: [],
    currentAdapter: "codex",
    switchingAdapter: false,
    switchingAdapterId: "",
    switchStartedAtMs: 0,
    adapterError: "",
    tasks: [],
    loadingTasks: false,
    taskView: "projects",
    collapsedProjectGroups: Object.create(null),
    projectVisibleLimits: Object.create(null),
    recentVisibleLimit: 20,
    recentMoreNode: null,
    boardOpen: false,
    settingsOpen: false,
    boardView: "active",
    boardTasks: [],
    boardRecentCompleted: [],
    boardLoading: false,
    boardError: "",
    boardRequestId: 0,
    boardOpeningKey: "",
    boardLastLoadedAtMs: 0,
    currentThreadId: "",
    taskModels: Object.create(null),
    modelRequestId: 0,
    modelChanging: false,
    modelMenuOpen: false,
    reasoningChanging: false,
    reasoningMenuOpen: false,
    taskPermissions: Object.create(null),
    permissionRequestId: 0,
    permissionChanging: false,
    permissionMenuOpen: false,
    serverMessages: [],
    historyMessages: [],
    latestMessages: [],
    oldestMessageCursor: null,
    hasOlderMessages: false,
    historySource: "",
    historyCaughtUp: true,
    loadingOlderMessages: false,
    historyRequestId: 0,
    progressItems: [],
    optimisticProgressTurnId: null,
    pendingMessages: [],
    transcriptSignature: "",
    contentRevision: "",
    lastLiveMessageRefreshAtMs: 0,
    cacheSyncState: "idle",
    cacheSyncResetTimer: null,
    queueSignature: "",
    queuedMessages: [],
    editingQueuedMessageId: "",
    editingQueuedImageCount: 0,
    queueActionMessageId: "",
    runSummary: null,
    localRunSummary: null,
    pendingApproval: null,
    approvalResults: [],
    resolvingApproval: false,
    stopRequestedThreadId: "",
    loadingMessages: false,
    trailingMessageRefresh: null,
    taskRequestId: 0,
    nextTaskRefreshAtMs: 0,
    messageRequestId: 0,
    composerRevision: 0,
    messagePostChains: Object.create(null),
    creatingTask: false,
    pendingImages: [],
    messageNodes: Object.create(null),
    taskNodes: Object.create(null),
    taskGroupNodes: Object.create(null),
    taskEmptyNode: null,
    contextTaskId: "",
    renamingTaskId: "",
    renameSubmitting: false,
    suppressTaskClickThreadId: "",
    suppressTaskClickUntil: 0,
    toastTimer: null,
    liveRefreshTimer: null,
    runClockTimer: null,
    appUpdateChecking: false,
    lastAppVersionCheckAtMs: 0,
    connectionMode: "unknown",
    conversationSnapshots: Object.create(null),
    conversationSnapshotOrder: [],
    composerDrafts: Object.create(null),
    composerDraftOrder: [],
    taskSnapshots: Object.create(null),
    taskSnapshotOrder: [],
    persistentCacheRestored: false,
    persistentCacheWriteTimer: null,
    localTaskDrafts: Object.create(null)
  };

  var APP_VERSION = "__WE_RELAY_ASSET_VERSION__";
  var APP_VERSION_CHECK_INTERVAL_MS = 30 * 1000;
  var PROJECT_TASK_BATCH_SIZE = 5;
  var RECENT_TASK_BATCH_SIZE = 20;
  var MESSAGE_PAGE_SIZE = 40;
  var LIVE_MESSAGE_PAGE_SIZE = 5;
  var TASK_REFRESH_INTERVAL_MS = 8000;
  var TASK_LONG_PRESS_MS = 520;
  var TASK_LONG_PRESS_MOVE_PX = 8;
  var LAN_REDIRECT_ATTEMPT_KEY = "werelayLanRedirectAttemptedAt";
  var LAN_REDIRECT_COOLDOWN_MS = 10 * 60 * 1000;
  var LAN_REDIRECT_FALLBACK_MS = 3500;
  var DEVICE_CONNECTION_RETRY_MS = 1500;
  var MAX_CONVERSATION_SNAPSHOTS = 12;
  var MAX_COMPOSER_DRAFTS = 40;

  function taskRecencyMs(task) {
    var parsed = Date.parse(task && task.lastUpdatedAt || "");
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function sortTasksByRecency(tasks) {
    return tasks.map(function (task, index) {
      return { task: task, index: index };
    }).sort(function (left, right) {
      return taskRecencyMs(right.task) - taskRecencyMs(left.task) || left.index - right.index;
    }).map(function (entry) { return entry.task; });
  }

  function taskBoardLane(task) {
    if (!task) return "queued";
    if (task.status === "running") return "running";
    if (task.status === "approval" || task.status === "input") return "waiting";
    if (task.status === "error") return "error";
    if (task.completedAt) return "completed";
    return "queued";
  }

  function isTaskBoardInProgress(task) {
    return Boolean(task && (
      task.status === "running" || task.status === "approval" || task.status === "input"
    ));
  }

  function taskBoardMatchesQuery(task, query) {
    var normalized = String(query || "").trim().toLowerCase();
    if (!normalized) return true;
    return [task && task.title, task && task.projectName, task && task.adapterLabel]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalized);
  }

  function shouldShowTaskAdapterLabels(tasks) {
    if (!Array.isArray(tasks) || tasks.length <= 1) return false;
    var adapters = new Set(tasks.map(function (task) {
      return String(task && task.adapter || "").trim();
    }).filter(Boolean));
    return adapters.size > 1;
  }

  function taskListProjectLabel(task, view) {
    if (view !== "recent") return "";
    return String(task && task.projectName || "").trim();
  }

  function taskBoardContextText(task, showAdapterLabel, suffix) {
    var parts = [];
    if (showAdapterLabel && task && task.adapterLabel) parts.push(task.adapterLabel);
    if (task && task.projectName) parts.push(task.projectName);
    if (suffix) parts.push(suffix);
    return parts.join(" · ");
  }

  function taskBoardTaskHref(task) {
    var url = new URL(window.location.href);
    url.searchParams.set("adapter", task.adapter);
    url.searchParams.set("task", task.threadId);
    url.searchParams.delete("view");
    url.searchParams.delete("board");
    return url.pathname + url.search + url.hash;
  }

  function formatTaskBoardTime(value, nowMs) {
    var timestamp = Date.parse(String(value || ""));
    if (!Number.isFinite(timestamp)) return "";
    var elapsedMs = Math.max(0, Number(nowMs || Date.now()) - timestamp);
    var minutes = Math.floor(elapsedMs / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return minutes + " 分钟前";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + " 小时前";
    var days = Math.floor(hours / 24);
    if (days === 1) return "昨天";
    if (days < 7) return days + " 天前";
    var date = new Date(timestamp);
    return (date.getMonth() + 1) + " 月 " + date.getDate() + " 日";
  }

  function resolveTaskSelector(tasks, selector) {
    var normalized = String(selector || "").trim();
    if (!normalized) return null;
    var exact = tasks.find(function (task) { return task.threadId === normalized; });
    if (exact) return exact;
    var prefixMatches = tasks.filter(function (task) {
      return task.threadId.indexOf(normalized) === 0;
    });
    return prefixMatches.length === 1 ? prefixMatches[0] : null;
  }

  function nextTaskVisibleLimit(current, total, batchSize) {
    var batch = Math.max(1, Math.floor(Number(batchSize) || 1));
    var normalizedCurrent = Math.max(batch, Math.floor(Number(current) || 0));
    var normalizedTotal = Math.max(0, Math.floor(Number(total) || 0));
    return Math.min(normalizedTotal, normalizedCurrent + batch);
  }

  function setProjectGroupCollapsed(collapsedGroups, visibleLimits, groupKey, collapsed) {
    if (collapsed) {
      collapsedGroups[groupKey] = true;
      delete visibleLimits[groupKey];
      return;
    }
    delete collapsedGroups[groupKey];
    visibleLimits[groupKey] = PROJECT_TASK_BATCH_SIZE;
  }

  function projectTaskCreationSource(tasks, currentThreadId) {
    var supported = (Array.isArray(tasks) ? tasks : []).filter(function (task) {
      return task && task.canCreateInProject === true;
    });
    return supported.find(function (task) {
      return task.threadId === currentThreadId;
    }) || supported[0] || null;
  }

  function conversationStateKey(adapterId, threadId) {
    return String(adapterId || "") + "\u0000" + String(threadId || "");
  }

  var PERSISTENT_MOBILE_CACHE_STORAGE_NAME = "werelayMobileCacheV1";
  var PERSISTENT_MOBILE_CACHE_SCHEMA_VERSION = 1;
  var PERSISTENT_MOBILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  var PERSISTENT_MOBILE_CACHE_WRITE_DELAY_MS = 120;
  var MAX_PERSISTENT_TASK_SNAPSHOTS = 8;
  var MAX_PERSISTENT_TASKS_PER_ADAPTER = 160;
  var MAX_PERSISTENT_MESSAGES = 60;

  function touchConversationValue(order, key) {
    var existingIndex = order.indexOf(key);
    if (existingIndex >= 0) order.splice(existingIndex, 1);
    order.push(key);
  }

  function setBoundedConversationValue(values, order, key, value, limit) {
    if (!key) return order;
    values[key] = value;
    touchConversationValue(order, key);
    var boundedLimit = Math.max(1, Math.floor(Number(limit) || 1));
    while (order.length > boundedLimit) {
      var evictedKey = order.shift();
      if (evictedKey !== undefined) delete values[evictedKey];
    }
    return order;
  }

  function getBoundedConversationValue(values, order, key) {
    if (!key || !Object.prototype.hasOwnProperty.call(values, key)) return null;
    touchConversationValue(order, key);
    return values[key];
  }

  function deleteConversationValue(values, order, key) {
    if (!key) return;
    delete values[key];
    var existingIndex = order.indexOf(key);
    if (existingIndex >= 0) order.splice(existingIndex, 1);
  }

  function moveConversationValue(values, order, fromKey, toKey, limit) {
    if (!fromKey || !toKey || fromKey === toKey) return;
    if (!Object.prototype.hasOwnProperty.call(values, fromKey)) return;
    var value = values[fromKey];
    deleteConversationValue(values, order, fromKey);
    setBoundedConversationValue(values, order, toKey, value, limit);
  }

  function persistentStorageGet() {
    try {
      return localStorage.getItem(PERSISTENT_MOBILE_CACHE_STORAGE_NAME);
    } catch (_) {
      return null;
    }
  }

  function persistentStorageSet(value) {
    try {
      localStorage.setItem(PERSISTENT_MOBILE_CACHE_STORAGE_NAME, value);
      return true;
    } catch (_) {
      return false;
    }
  }

  function clearPersistentMobileCache() {
    if (state.persistentCacheWriteTimer) clearTimeout(state.persistentCacheWriteTimer);
    state.persistentCacheWriteTimer = null;
    try {
      localStorage.removeItem(PERSISTENT_MOBILE_CACHE_STORAGE_NAME);
    } catch (_) {}
  }

  function readPersistentMobileCache() {
    var raw = persistentStorageGet();
    if (!raw) return null;
    try {
      var payload = JSON.parse(raw);
      var savedAtMs = Number(payload && payload.savedAtMs);
      if (
        !payload ||
        payload.schemaVersion !== PERSISTENT_MOBILE_CACHE_SCHEMA_VERSION ||
        !Number.isFinite(savedAtMs) ||
        Date.now() - savedAtMs > PERSISTENT_MOBILE_CACHE_TTL_MS ||
        savedAtMs - Date.now() > 5 * 60 * 1000
      ) {
        clearPersistentMobileCache();
        return null;
      }
      return payload;
    } catch (_) {
      clearPersistentMobileCache();
      return null;
    }
  }

  function sanitizePersistentTask(task) {
    if (!task || typeof task.threadId !== "string" || !task.threadId) return null;
    var sanitized = {};
    [
      "threadId", "title", "status", "lastUpdatedAt", "startedAtMs", "completedAt",
      "completedAtMs", "durationMs", "activeTurnId", "selected", "projectId",
      "projectName", "projectOrder", "projectThreadOrder", "canRename",
      "canCreateInProject", "localCreationState", "localCreationError",
      "localSourceThreadId"
    ].forEach(function (key) {
      if (task[key] !== undefined) sanitized[key] = task[key];
    });
    return sanitized;
  }

  function sanitizePersistentTaskBoardItem(item) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.adapter !== "string" ||
      typeof item.threadId !== "string" ||
      !item.adapter ||
      !item.threadId
    ) return null;
    var sanitized = {};
    [
      "adapter", "adapterLabel", "threadId", "title", "status", "lastUpdatedAt",
      "startedAtMs", "completedAt", "completedAtMs", "durationMs", "activeTurnId",
      "projectId", "projectName"
    ].forEach(function (key) {
      if (item[key] !== undefined) sanitized[key] = item[key];
    });
    return sanitized;
  }

  function hasTaskBoardCachedContent(tasks, recentCompleted, lastLoadedAtMs) {
    return Boolean(
      Math.max(0, Number(lastLoadedAtMs) || 0) ||
      Array.isArray(tasks) && tasks.length ||
      Array.isArray(recentCompleted) && recentCompleted.length
    );
  }

  function buildCachedTaskBoardFallback(taskSnapshots, taskSnapshotOrder, adapters) {
    function sortCachedTasks(items) {
      return items.slice().sort(function (left, right) {
        var leftMs = Date.parse(left && left.lastUpdatedAt || "");
        var rightMs = Date.parse(right && right.lastUpdatedAt || "");
        return (Number.isFinite(rightMs) ? rightMs : 0) -
          (Number.isFinite(leftMs) ? leftMs : 0);
      });
    }
    var adapterLabels = Object.create(null);
    (Array.isArray(adapters) ? adapters : []).forEach(function (adapter) {
      if (adapter && adapter.id) adapterLabels[adapter.id] = adapter.label || adapter.id;
    });
    var source = taskSnapshots && typeof taskSnapshots === "object"
      ? taskSnapshots
      : Object.create(null);
    var adapterIds = [];
    (Array.isArray(taskSnapshotOrder) ? taskSnapshotOrder : []).concat(Object.keys(source))
      .forEach(function (adapterId) {
        if (typeof adapterId === "string" && adapterId && !adapterIds.includes(adapterId)) {
          adapterIds.push(adapterId);
        }
      });
    var seen = new Set();
    var active = [];
    var completed = [];
    adapterIds.forEach(function (adapterId) {
      var snapshot = source[adapterId];
      (snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks : []).forEach(function (task) {
        if (!task || typeof task.threadId !== "string" || !task.threadId) return;
        var key = adapterId + "\u0000" + task.threadId;
        if (seen.has(key)) return;
        seen.add(key);
        var item = sanitizePersistentTaskBoardItem(Object.assign({}, task, {
          adapter: adapterId,
          adapterLabel: adapterLabels[adapterId] || adapterId,
        }));
        if (!item) return;
        if (item.completedAt || item.completedAtMs) completed.push(item);
        else active.push(item);
      });
    });
    return {
      tasks: sortCachedTasks(active).slice(0, 240),
      recentCompleted: sortCachedTasks(completed).slice(0, 80),
    };
  }

  function sanitizePersistentAdapter(adapter) {
    if (!adapter || typeof adapter.id !== "string" || !adapter.id) return null;
    return {
      id: adapter.id,
      label: typeof adapter.label === "string" && adapter.label
        ? adapter.label
        : adapter.id,
      status: ""
    };
  }

  function sanitizePersistentImage(image) {
    if (!image || typeof image !== "object") return null;
    var previewUrl = typeof image.previewUrl === "string" &&
      !image.previewUrl.startsWith("data:")
      ? image.previewUrl
      : "";
    var url = typeof image.url === "string" && !image.url.startsWith("data:")
      ? image.url
      : "";
    if (!previewUrl && !url) return null;
    return {
      previewUrl: previewUrl,
      url: url,
      alt: typeof image.alt === "string" ? image.alt : "",
      fileName: typeof image.fileName === "string" ? image.fileName : ""
    };
  }

  function sanitizePersistentMessage(message) {
    if (!message || typeof message !== "object") return null;
    var sanitized = {};
    [
      "id", "role", "text", "turnId", "phase", "model", "createdAt", "createdAtMs",
      "status", "pending", "clientId", "imageCount"
    ].forEach(function (key) {
      if (message[key] !== undefined) sanitized[key] = message[key];
    });
    if (Array.isArray(message.images)) {
      var images = message.images.map(sanitizePersistentImage).filter(Boolean);
      if (images.length) sanitized.images = images;
    }
    return sanitized;
  }

  function sanitizePersistentMessages(messages) {
    return (Array.isArray(messages) ? messages : [])
      .slice(-MAX_PERSISTENT_MESSAGES)
      .map(sanitizePersistentMessage)
      .filter(Boolean);
  }

  function sanitizePersistentRunSummary(summary) {
    if (!summary || typeof summary !== "object") return null;
    var sanitized = {};
    [
      "turnId", "status", "startedAtMs", "completedAtMs", "durationMs", "receivedAtMs",
      "errorMessage", "model"
    ].forEach(function (key) {
      if (summary[key] !== undefined) sanitized[key] = summary[key];
    });
    return sanitized;
  }

  function sanitizePersistentConversationSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    var messages = sanitizePersistentMessages(snapshot.serverMessages);
    return {
      serverMessages: messages,
      historyMessages: [],
      latestMessages: messages,
      oldestMessageCursor: snapshot.oldestMessageCursor === null
        ? null
        : snapshot.oldestMessageCursor || null,
      hasOlderMessages: Boolean(snapshot.hasOlderMessages),
      historySource: typeof snapshot.historySource === "string" ? snapshot.historySource : "",
      historyCaughtUp: snapshot.historyCaughtUp !== false,
      progressItems: [],
      optimisticProgressTurnId: null,
      pendingMessages: [],
      transcriptSignature: "",
      contentRevision: typeof snapshot.contentRevision === "string"
        ? snapshot.contentRevision
        : "",
      queueSignature: "",
      queuedMessages: [],
      editingQueuedMessageId: "",
      editingQueuedImageCount: 0,
      editingQueuedText: "",
      pendingImages: [],
      runSummary: sanitizePersistentRunSummary(snapshot.runSummary),
      localRunSummary: null,
      pendingApproval: null,
      approvalResults: [],
      stopRequestedThreadId: "",
      scrollTop: Math.max(0, Number(snapshot.scrollTop) || 0),
      nearBottom: snapshot.nearBottom !== false
    };
  }

  function rememberCurrentTaskSnapshot() {
    if (!state.currentAdapter) return;
    var tasks = (Array.isArray(state.tasks) ? state.tasks : [])
      .slice(0, MAX_PERSISTENT_TASKS_PER_ADAPTER)
      .map(sanitizePersistentTask)
      .filter(Boolean);
    if (!tasks.length && !state.currentThreadId) return;
    setBoundedConversationValue(
      state.taskSnapshots,
      state.taskSnapshotOrder,
      state.currentAdapter,
      {
        currentThreadId: state.currentThreadId || "",
        tasks: tasks
      },
      MAX_PERSISTENT_TASK_SNAPSHOTS
    );
  }

  function buildPersistentMobileCache() {
    rememberCurrentTaskSnapshot();
    var taskSnapshots = Object.create(null);
    state.taskSnapshotOrder.slice(-MAX_PERSISTENT_TASK_SNAPSHOTS).forEach(function (adapterId) {
      var snapshot = state.taskSnapshots[adapterId];
      if (!snapshot || !Array.isArray(snapshot.tasks)) return;
      taskSnapshots[adapterId] = {
        currentThreadId: typeof snapshot.currentThreadId === "string"
          ? snapshot.currentThreadId
          : "",
        tasks: snapshot.tasks
          .slice(0, MAX_PERSISTENT_TASKS_PER_ADAPTER)
          .map(sanitizePersistentTask)
          .filter(Boolean)
      };
    });
    var conversationSnapshots = Object.create(null);
    var conversationOrder = state.conversationSnapshotOrder
      .slice(-MAX_CONVERSATION_SNAPSHOTS)
      .filter(function (key) {
        var sanitized = sanitizePersistentConversationSnapshot(
          state.conversationSnapshots[key]
        );
        if (!sanitized) return false;
        conversationSnapshots[key] = sanitized;
        return true;
      });
    var composerDrafts = Object.create(null);
    var composerOrder = state.composerDraftOrder
      .slice(-MAX_COMPOSER_DRAFTS)
      .filter(function (key) {
        var draft = state.composerDrafts[key];
        if (!draft || typeof draft.text !== "string" || !draft.text) return false;
        composerDrafts[key] = { text: draft.text.slice(0, 20000) };
        return true;
      });
    return {
      schemaVersion: PERSISTENT_MOBILE_CACHE_SCHEMA_VERSION,
      savedAtMs: Date.now(),
      authenticatedAtMs: state.cachePreviewMode
        ? state.persistentCacheAuthenticatedAtMs
        : Date.now(),
      currentAdapter: state.currentAdapter || "codex",
      adapters: (Array.isArray(state.adapters) ? state.adapters : [])
        .map(sanitizePersistentAdapter)
        .filter(Boolean),
      taskSnapshots: taskSnapshots,
      taskSnapshotOrder: Object.keys(taskSnapshots).filter(function (adapterId) {
        return state.taskSnapshotOrder.includes(adapterId);
      }),
      conversationSnapshots: conversationSnapshots,
      conversationSnapshotOrder: conversationOrder,
      composerDrafts: composerDrafts,
      composerDraftOrder: composerOrder,
      taskBoard: {
        tasks: (Array.isArray(state.boardTasks) ? state.boardTasks : [])
          .map(sanitizePersistentTaskBoardItem)
          .filter(Boolean),
        recentCompleted: (Array.isArray(state.boardRecentCompleted)
          ? state.boardRecentCompleted
          : [])
          .map(sanitizePersistentTaskBoardItem)
          .filter(Boolean),
        lastLoadedAtMs: Math.max(0, Number(state.boardLastLoadedAtMs) || 0)
      }
    };
  }

  function persistMobileCacheNow() {
    if (!state.authenticated) return false;
    if (state.currentThreadId) saveCurrentConversationSnapshot(true);
    if (state.persistentCacheWriteTimer) clearTimeout(state.persistentCacheWriteTimer);
    state.persistentCacheWriteTimer = null;
    try {
      return persistentStorageSet(JSON.stringify(buildPersistentMobileCache()));
    } catch (_) {
      return false;
    }
  }

  function schedulePersistentMobileCacheWrite() {
    if (!state.authenticated) return;
    if (state.persistentCacheWriteTimer) clearTimeout(state.persistentCacheWriteTimer);
    state.persistentCacheWriteTimer = setTimeout(function () {
      persistMobileCacheNow();
    }, PERSISTENT_MOBILE_CACHE_WRITE_DELAY_MS);
  }

  function restoreCachedAdapterState(adapterId, requestedThreadId) {
    var taskSnapshot = state.taskSnapshots[adapterId];
    state.currentAdapter = adapterId;
    state.tasks = taskSnapshot && Array.isArray(taskSnapshot.tasks)
      ? taskSnapshot.tasks.slice()
      : [];
    var selectedTask = state.tasks.find(function (task) { return task && task.selected; });
    var firstTask = state.tasks[0];
    var threadId = String(requestedThreadId ||
      taskSnapshot && taskSnapshot.currentThreadId ||
      selectedTask && selectedTask.threadId ||
      firstTask && firstTask.threadId || "");
    state.currentThreadId = threadId;
    var restoredConversation = threadId
      ? restoreConversationSnapshot(adapterId, threadId)
      : false;
    if (!restoredConversation && threadId) {
      restoreComposerDraft(adapterId, threadId);
      resizeComposer();
    }
    renderAdapterMenu();
    renderTasks();
    updateHeader();
    return Boolean(state.tasks.length || restoredConversation || composerInput.value);
  }

  function restorePersistentMobileCache(requestedAdapter, requestedThreadId) {
    if (state.persistentCacheRestored) return false;
    state.persistentCacheRestored = true;
    var payload = readPersistentMobileCache();
    if (!payload) return false;
    state.persistentCacheAuthenticatedAtMs = Math.max(
      0,
      Number(payload.authenticatedAtMs) || 0
    );
    state.adapters = Array.isArray(payload.adapters)
      ? payload.adapters.map(sanitizePersistentAdapter).filter(Boolean)
      : [];
    var taskSnapshotSource = payload.taskSnapshots && typeof payload.taskSnapshots === "object"
      ? payload.taskSnapshots
      : Object.create(null);
    var taskSnapshotOrder = Array.isArray(payload.taskSnapshotOrder)
      ? payload.taskSnapshotOrder.filter(function (adapterId) {
          return typeof adapterId === "string" && taskSnapshotSource[adapterId];
        }).slice(-MAX_PERSISTENT_TASK_SNAPSHOTS)
      : [];
    state.taskSnapshots = Object.create(null);
    state.taskSnapshotOrder = [];
    taskSnapshotOrder.forEach(function (adapterId) {
      var snapshot = taskSnapshotSource[adapterId];
      if (!snapshot || !Array.isArray(snapshot.tasks)) return;
      state.taskSnapshots[adapterId] = {
        currentThreadId: typeof snapshot.currentThreadId === "string"
          ? snapshot.currentThreadId
          : "",
        tasks: snapshot.tasks
          .slice(0, MAX_PERSISTENT_TASKS_PER_ADAPTER)
          .map(sanitizePersistentTask)
          .filter(Boolean)
      };
      state.taskSnapshotOrder.push(adapterId);
    });
    var conversationSnapshotSource = payload.conversationSnapshots &&
      typeof payload.conversationSnapshots === "object"
      ? payload.conversationSnapshots
      : Object.create(null);
    var conversationSnapshotOrder = Array.isArray(payload.conversationSnapshotOrder)
      ? payload.conversationSnapshotOrder.filter(function (key) {
          return typeof key === "string" && conversationSnapshotSource[key];
        }).slice(-MAX_CONVERSATION_SNAPSHOTS)
      : [];
    state.conversationSnapshots = Object.create(null);
    state.conversationSnapshotOrder = [];
    conversationSnapshotOrder.forEach(function (key) {
      var snapshot = sanitizePersistentConversationSnapshot(conversationSnapshotSource[key]);
      if (!snapshot) return;
      state.conversationSnapshots[key] = snapshot;
      state.conversationSnapshotOrder.push(key);
    });
    var composerDraftSource = payload.composerDrafts && typeof payload.composerDrafts === "object"
      ? payload.composerDrafts
      : Object.create(null);
    var composerDraftOrder = Array.isArray(payload.composerDraftOrder)
      ? payload.composerDraftOrder.filter(function (key) {
          return typeof key === "string" && composerDraftSource[key];
        }).slice(-MAX_COMPOSER_DRAFTS)
      : [];
    state.composerDrafts = Object.create(null);
    state.composerDraftOrder = [];
    composerDraftOrder.forEach(function (key) {
      var draft = composerDraftSource[key];
      if (!draft || typeof draft.text !== "string" || !draft.text) return;
      state.composerDrafts[key] = { text: draft.text.slice(0, 20000) };
      state.composerDraftOrder.push(key);
    });

    var taskBoard = payload.taskBoard && typeof payload.taskBoard === "object"
      ? payload.taskBoard
      : null;
    state.boardTasks = taskBoard && Array.isArray(taskBoard.tasks)
      ? taskBoard.tasks.map(sanitizePersistentTaskBoardItem).filter(Boolean)
      : [];
    state.boardRecentCompleted = taskBoard && Array.isArray(taskBoard.recentCompleted)
      ? taskBoard.recentCompleted.map(sanitizePersistentTaskBoardItem).filter(Boolean)
      : [];
    state.boardLastLoadedAtMs = taskBoard
      ? Math.max(0, Number(taskBoard.lastLoadedAtMs) || 0)
      : 0;
    var adapterId = String(requestedAdapter || payload.currentAdapter || state.currentAdapter || "codex");
    var restoredAdapterState = restoreCachedAdapterState(adapterId, requestedThreadId);
    if (!restoredAdapterState && requestedThreadId) {
      state.boardTasks = [];
      state.boardRecentCompleted = [];
      state.boardLastLoadedAtMs = 0;
      return false;
    }
    if (!hasTaskBoardCachedContent(
      state.boardTasks,
      state.boardRecentCompleted,
      state.boardLastLoadedAtMs
    ) && restoredAdapterState) {
      var boardFallback = buildCachedTaskBoardFallback(
        state.taskSnapshots,
        state.taskSnapshotOrder,
        state.adapters
      );
      state.boardTasks = boardFallback.tasks;
      state.boardRecentCompleted = boardFallback.recentCompleted;
    }
    return Boolean(
      restoredAdapterState ||
      state.boardTasks.length ||
      state.boardRecentCompleted.length
    );
  }

  function restoreTrustedPersistentMobileCachePreview() {
    state.setupToken = readSetupToken();
    if (state.setupToken) return false;
    var payload = readPersistentMobileCache();
    var authenticatedAtMs = Number(payload && payload.authenticatedAtMs);
    if (
      !payload ||
      !Number.isFinite(authenticatedAtMs) ||
      authenticatedAtMs <= 0 ||
      Date.now() - authenticatedAtMs > PERSISTENT_MOBILE_CACHE_TTL_MS
    ) return false;
    var pageUrl = new URL(window.location.href);
    var requestedAdapter = pageUrl.searchParams.get("adapter") || payload.currentAdapter || "codex";
    var requestedTask = pageUrl.searchParams.get("task") || "";
    state.authenticated = true;
    state.cachePreviewMode = true;
    state.persistentCacheAuthenticatedAtMs = authenticatedAtMs;
    if (!restorePersistentMobileCache(requestedAdapter, requestedTask)) {
      state.authenticated = false;
      state.cachePreviewMode = false;
      return false;
    }
    state.appStarted = true;
    state.boardView = pageUrl.searchParams.get("board") === "completed"
      ? "completed"
      : "active";
    if (!state.runClockTimer) {
      state.runClockTimer = setInterval(updateRunHeaderClock, 1000);
    }
    state.loadingTasks = false;
    bootScreen.hidden = true;
    authScreen.hidden = true;
    app.hidden = false;
    setTaskBoardOpen(pageUrl.searchParams.get("view") === "board", false);
    setSettingsOpen(pageUrl.searchParams.get("view") === "settings", false);
    syncComposerInset();
    updateUserMessageNavigation();
    return true;
  }

  function isTemporaryTask(task) {
    return Boolean(task && task.localCreationState);
  }

  function taskNeedsCreation(task) {
    return Boolean(task && (
      task.localCreationState === "creating" || task.localCreationState === "failed"
    ));
  }

  function taskCreationErrorText(task) {
    var text = String(task && task.localCreationError || "").trim();
    if (!text) return "";
    var characters = Array.from(text);
    return characters.length > 120
      ? characters.slice(0, 120).join("") + "…"
      : text;
  }

  function findReusableLocalTask(tasks) {
    return (Array.isArray(tasks) ? tasks : []).find(function (task) {
      return isTemporaryTask(task);
    }) || null;
  }

  function currentLocalTaskDraft() {
    return state.localTaskDrafts[state.currentAdapter] || findReusableLocalTask(state.tasks);
  }

  function rememberLocalTaskDraft(task) {
    if (!task || !task.threadId || !isTemporaryTask(task)) return;
    state.localTaskDrafts[state.currentAdapter] = task;
  }

  function forgetLocalTaskDraft(adapterId, threadId) {
    var task = state.localTaskDrafts[adapterId];
    if (!task || threadId && task.threadId !== threadId) return;
    delete state.localTaskDrafts[adapterId];
  }

  function mergeTasksWithLocalDrafts(remoteTasks, localTasks) {
    var localByThreadId = Object.create(null);
    (Array.isArray(localTasks) ? localTasks : []).forEach(function (task) {
      if (task && task.threadId) localByThreadId[task.threadId] = task;
    });
    var merged = (Array.isArray(remoteTasks) ? remoteTasks : []).map(function (task) {
      var localTask = task && localByThreadId[task.threadId];
      if (!localTask) return task;
      delete localByThreadId[task.threadId];
      return Object.assign({}, localTask, task, {
        localCreationState: localTask.localCreationState,
        localCreationError: localTask.localCreationError || "",
        localSourceThreadId: localTask.localSourceThreadId || "",
        selected: Boolean(localTask.selected || task.selected)
      });
    });
    (Array.isArray(localTasks) ? localTasks : []).slice().reverse().forEach(function (task) {
      if (task && localByThreadId[task.threadId]) {
        merged.unshift(task);
        delete localByThreadId[task.threadId];
      }
    });
    return merged;
  }

  function finishLocalTaskDraft(threadId) {
    var task = taskById(threadId);
    if (!task || task.localCreationState !== "ready") return;
    delete task.localCreationState;
    delete task.localCreationError;
    delete task.localSourceThreadId;
    forgetLocalTaskDraft(state.currentAdapter, threadId);
    renderTasks();
    updateHeader();
  }

  function saveComposerDraft(adapterId, threadId, suppressPersistentWrite) {
    if (!threadId || state.editingQueuedMessageId) return;
    var key = conversationStateKey(adapterId, threadId);
    var text = String(composerInput.value || "");
    if (!text) {
      deleteConversationValue(state.composerDrafts, state.composerDraftOrder, key);
      if (!suppressPersistentWrite) schedulePersistentMobileCacheWrite();
      return;
    }
    setBoundedConversationValue(
      state.composerDrafts,
      state.composerDraftOrder,
      key,
      { text: text },
      MAX_COMPOSER_DRAFTS
    );
    if (!suppressPersistentWrite) schedulePersistentMobileCacheWrite();
  }

  function restoreComposerDraft(adapterId, threadId) {
    var draft = getBoundedConversationValue(
      state.composerDrafts,
      state.composerDraftOrder,
      conversationStateKey(adapterId, threadId)
    );
    composerInput.value = draft && draft.text ? draft.text : "";
  }

  function clearComposerDraft(adapterId, threadId) {
    deleteConversationValue(
      state.composerDrafts,
      state.composerDraftOrder,
      conversationStateKey(adapterId, threadId)
    );
    schedulePersistentMobileCacheWrite();
  }

  function saveCurrentConversationSnapshot(suppressPersistentWrite) {
    if (!state.currentThreadId) return;
    saveComposerDraft(state.currentAdapter, state.currentThreadId, true);
    var key = conversationStateKey(state.currentAdapter, state.currentThreadId);
    setBoundedConversationValue(
      state.conversationSnapshots,
      state.conversationSnapshotOrder,
      key,
      {
        serverMessages: state.serverMessages.slice(),
        historyMessages: state.historyMessages.slice(),
        latestMessages: state.latestMessages.slice(),
        oldestMessageCursor: state.oldestMessageCursor,
        hasOlderMessages: state.hasOlderMessages,
        historySource: state.historySource,
        historyCaughtUp: state.historyCaughtUp,
        progressItems: state.progressItems.slice(),
        optimisticProgressTurnId: state.optimisticProgressTurnId,
        pendingMessages: state.pendingMessages.slice(),
        transcriptSignature: state.transcriptSignature,
        contentRevision: state.contentRevision,
        queueSignature: state.queueSignature,
        queuedMessages: state.queuedMessages.slice(),
        editingQueuedMessageId: state.editingQueuedMessageId,
        editingQueuedImageCount: state.editingQueuedImageCount,
        editingQueuedText: state.editingQueuedMessageId ? composerInput.value : "",
        pendingImages: state.pendingImages.slice(),
        runSummary: state.runSummary,
        localRunSummary: state.localRunSummary,
        pendingApproval: state.pendingApproval,
        approvalResults: state.approvalResults.slice(),
        stopRequestedThreadId: state.stopRequestedThreadId,
        scrollTop: messagesEl.scrollTop,
        nearBottom: isNearBottom()
      },
      MAX_CONVERSATION_SNAPSHOTS
    );
    if (!suppressPersistentWrite) schedulePersistentMobileCacheWrite();
  }

  function restoreConversationSnapshot(adapterId, threadId) {
    var snapshot = getBoundedConversationValue(
      state.conversationSnapshots,
      state.conversationSnapshotOrder,
      conversationStateKey(adapterId, threadId)
    );
    if (!snapshot) return false;
    state.serverMessages = snapshot.serverMessages.slice();
    state.historyMessages = snapshot.historyMessages.slice();
    state.latestMessages = snapshot.latestMessages.slice();
    state.oldestMessageCursor = snapshot.oldestMessageCursor;
    state.hasOlderMessages = snapshot.hasOlderMessages;
    state.historySource = snapshot.historySource || "";
    state.historyCaughtUp = snapshot.historyCaughtUp !== false;
    state.progressItems = snapshot.progressItems.slice();
    state.optimisticProgressTurnId = snapshot.optimisticProgressTurnId || null;
    state.pendingMessages = snapshot.pendingMessages.slice();
    state.transcriptSignature = snapshot.transcriptSignature || "";
    state.contentRevision = snapshot.contentRevision || "";
    state.queueSignature = snapshot.queueSignature || "";
    state.queuedMessages = snapshot.queuedMessages.slice();
    state.editingQueuedMessageId = snapshot.editingQueuedMessageId || "";
    state.editingQueuedImageCount = Math.max(0, Number(snapshot.editingQueuedImageCount) || 0);
    state.runSummary = snapshot.runSummary || null;
    state.localRunSummary = snapshot.localRunSummary || null;
    state.pendingApproval = snapshot.pendingApproval || null;
    state.approvalResults = snapshot.approvalResults.slice();
    state.stopRequestedThreadId = snapshot.stopRequestedThreadId === threadId ? threadId : "";
    state.messageNodes = Object.create(null);
    state.pendingImages = Array.isArray(snapshot.pendingImages)
      ? snapshot.pendingImages.slice()
      : [];
    composerInput.value = state.editingQueuedMessageId
      ? String(snapshot.editingQueuedText || "")
      : "";
    if (!state.editingQueuedMessageId) restoreComposerDraft(adapterId, threadId);
    composerInput.placeholder = state.editingQueuedMessageId
      ? "编辑待发送消息"
      : "有问题，尽管问";
    composerImageButton.disabled = Boolean(state.editingQueuedMessageId);
    renderPendingImages();
    renderQueuedMessages(state.queuedMessages);
    resizeComposer();
    renderMessages(false);
    requestAnimationFrame(function () {
      if (threadId !== state.currentThreadId) return;
      if (snapshot.nearBottom) scrollToLatest(false);
      else messagesEl.scrollTop = Math.max(0, Number(snapshot.scrollTop) || 0);
      updateUserMessageNavigation();
    });
    return true;
  }

  function readSetupToken() {
    var url = new URL(window.location.href);
    var queryToken = url.searchParams.get("setup") || "";
    if (queryToken) {
      try { sessionStorage.setItem("codexMobileSetup", queryToken); } catch (_) {}
      url.searchParams.delete("setup");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
      return queryToken;
    }
    try { return sessionStorage.getItem("codexMobileSetup") || ""; } catch (_) { return ""; }
  }

  function updateAuthSecurityWarning() {
    var hostname = window.location.hostname.toLowerCase();
    var localAddress = hostname === "localhost" || hostname === "127.0.0.1" ||
      hostname === "::1" || hostname === "[::1]";
    authSecurityWarning.hidden = window.location.protocol === "https:" || localAddress;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function isLocalPreviewTarget(value) {
    var target = String(value || "").trim();
    if (
      /^file:\/\//i.test(target) ||
      /^\/(?!\/)/.test(target) ||
      /^[A-Za-z]:[\\/]/.test(target)
    ) return true;
    try {
      var url = new URL(target);
      var hostname = url.hostname.toLowerCase();
      return (url.protocol === "http:" || url.protocol === "https:") &&
        (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1");
    } catch (_) {
      return false;
    }
  }

  function renderMessageLink(target, label) {
    var localPreview = isLocalPreviewTarget(target);
    var href = localPreview
      ? "/preview/open?target=" + encodeURIComponent(target)
      : target;
    return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noreferrer"' +
      (localPreview ? ' data-local-preview="true"' : "") + '>' + escapeHtml(label) + "</a>";
  }

  function renderInline(value) {
    var source = String(value || "");
    var links = [];
    function preserveLink(target, label) {
      var token = "@@DESKRELAY_LINK_" + links.length + "@@";
      links.push(renderMessageLink(target, label));
      return token;
    }
    source = source.replace(/\[([^\]]+)\]\(((?:(?:https?|file):\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^)\s]+)\)/gi, function (_, label, target) {
      return preserveLink(target, label);
    });
    source = source.replace(/(^|\s)((?:https?|file):\/\/[^\s<]+)/gi, function (_, prefix, target) {
      return prefix + preserveLink(target, target);
    });
    var escaped = escapeHtml(source);
    escaped = escaped.replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>");
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    links.forEach(function (link, index) {
      escaped = escaped.replace("@@DESKRELAY_LINK_" + index + "@@", link);
    });
    return escaped;
  }

  function renderTextBlock(text) {
    var lines = text.split("\n");
    var html = [];
    var paragraph = [];
    var listType = "";

    function flushParagraph() {
      if (!paragraph.length) return;
      html.push("<p>" + paragraph.map(renderInline).join("<br>") + "</p>");
      paragraph = [];
    }
    function closeList() {
      if (!listType) return;
      html.push("</" + listType + ">");
      listType = "";
    }

    lines.forEach(function (line) {
      var heading = line.match(/^(#{1,3})\s+(.+)$/);
      var unordered = line.match(/^\s*[-*]\s+(.+)$/);
      var ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
      var quote = line.match(/^>\s?(.*)$/);
      if (!line.trim()) {
        flushParagraph();
        closeList();
        return;
      }
      if (heading) {
        flushParagraph();
        closeList();
        var level = heading[1].length;
        html.push("<h" + level + ">" + renderInline(heading[2]) + "</h" + level + ">");
        return;
      }
      if (unordered || ordered) {
        flushParagraph();
        var nextList = unordered ? "ul" : "ol";
        if (listType !== nextList) {
          closeList();
          listType = nextList;
          html.push(nextList === "ol" ? '<ol start="' + ordered[1] + '">' : "<ul>");
        }
        var itemValue = ordered ? ' value="' + ordered[1] + '"' : "";
        var itemText = unordered ? unordered[1] : ordered[2];
        html.push("<li" + itemValue + ">" + renderInline(itemText) + "</li>");
        return;
      }
      if (quote) {
        flushParagraph();
        closeList();
        html.push("<blockquote>" + renderInline(quote[1]) + "</blockquote>");
        return;
      }
      if (/^---+$/.test(line.trim())) {
        flushParagraph();
        closeList();
        html.push("<hr>");
        return;
      }
      closeList();
      paragraph.push(line);
    });
    flushParagraph();
    closeList();
    return html.join("");
  }

  function renderMarkdown(text, foldPrefix) {
    var parts = String(text || "").split(/\x60\x60\x60/);
    return parts.map(function (part, index) {
      if (index % 2 === 1) {
        var newline = part.indexOf("\n");
        var code = newline >= 0 ? part.slice(newline + 1) : part;
        var normalizedCode = code.replace(/\n$/, "");
        var lineCount = normalizedCode ? normalizedCode.split("\n").length : 1;
        var codeHtml = "<pre><code>" + escapeHtml(normalizedCode) + "</code></pre>";
        if (lineCount <= 6 && normalizedCode.length <= 320) return codeHtml;
        var amount = lineCount > 1 ? lineCount + " 行" : normalizedCode.length + " 字";
        var foldKey = String(foldPrefix || "message") + ":" + index;
        return '<details class="message-code-fold" data-fold-key="' + escapeHtml(foldKey) + '"><summary>' +
          '<span>代码 / 输出 · ' + amount + "</span>" +
          '<span class="message-code-fold-action"><span class="message-code-fold-closed">展开</span>' +
          '<span class="message-code-fold-open">收起</span></span></summary>' + codeHtml + "</details>";
      }
      return renderTextBlock(part);
    }).join("");
  }

  function isMobileFetchNetworkError(error) {
    if (!error || error.status) return false;
    var message = String(error.message || error);
    return error.name === "TypeError" ||
      /Failed to fetch|Load failed|NetworkError|Internet connection appears to be offline|network request failed/i.test(message);
  }

  function shouldRetryMobileFetch(error, method, attempt) {
    return String(method || "GET").toUpperCase() === "GET" &&
      attempt === 0 &&
      isMobileFetchNetworkError(error);
  }

  function normalizeMobileFetchError(error) {
    if (!isMobileFetchNetworkError(error)) return error;
    var normalized = new Error("网络连接暂时中断，请稍后重试。");
    normalized.network = true;
    return normalized;
  }

  async function waitForMobileFetchRetry() {
    await new Promise(function (resolve) {
      setTimeout(resolve, document.hidden ? 900 : 450);
    });
  }

  async function fetchJson(path, options) {
    options = options || {};
    var requestOptions = Object.assign({ credentials: "same-origin" }, options);
    var method = String(requestOptions.method || "GET").toUpperCase();
    delete requestOptions.retryNetwork;
    var response = null;
    for (var attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch(path, requestOptions);
        break;
      } catch (error) {
        if (shouldRetryMobileFetch(error, method, attempt)) {
          await waitForMobileFetchRetry();
          continue;
        }
        throw normalizeMobileFetchError(error);
      }
    }
    var payload = null;
    try { payload = await response.json(); } catch (_) { payload = null; }
    if (!response.ok) {
      var error = new Error(payload && payload.error ? payload.error : "请求失败");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function checkForAppUpdate(force) {
    var now = Date.now();
    if (state.appUpdateChecking) return false;
    if (!force && now - state.lastAppVersionCheckAtMs < APP_VERSION_CHECK_INTERVAL_MS) {
      return false;
    }
    state.appUpdateChecking = true;
    state.lastAppVersionCheckAtMs = now;
    try {
      var payload = await fetchJson(
        "/app-version?current=" + encodeURIComponent(APP_VERSION),
        { cache: "no-store" }
      );
      var nextVersion = payload && typeof payload.version === "string"
        ? payload.version.trim()
        : "";
      if (!nextVersion || nextVersion === APP_VERSION) return false;
      var nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("appv", nextVersion);
      window.location.replace(nextUrl.pathname + nextUrl.search + nextUrl.hash);
      return true;
    } catch (_) {
      return false;
    } finally {
      state.appUpdateChecking = false;
    }
  }

  async function authApi(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    if (state.setupToken) headers["x-codex-mobile-setup"] = state.setupToken;
    return await fetchJson(path, Object.assign({}, options, { headers: headers }));
  }

  function currentLanHandoffTarget() {
    var target = new URL(window.location.href);
    target.searchParams.delete("setup");
    target.searchParams.delete("key");
    target.searchParams.delete("handoff");
    target.searchParams.delete("lan");
    return target.pathname + target.search + target.hash;
  }

  function recentlyAttemptedLanRedirect() {
    try {
      var attemptedAtMs = Number(sessionStorage.getItem(LAN_REDIRECT_ATTEMPT_KEY) || 0);
      return Number.isFinite(attemptedAtMs) &&
        attemptedAtMs > 0 &&
        Date.now() - attemptedAtMs < LAN_REDIRECT_COOLDOWN_MS;
    } catch (_) {
      return false;
    }
  }

  function rememberLanRedirectAttempt() {
    try {
      sessionStorage.setItem(LAN_REDIRECT_ATTEMPT_KEY, String(Date.now()));
    } catch (_) {}
  }

  function resolveBootConnectionState(health, waitedMs) {
    var elapsedSeconds = Math.max(0, Math.floor((Number(waitedMs) || 0) / 1000));
    if (health && typeof health.deviceOnline === "boolean") {
      if (health.deviceOnline) {
        return {
          mode: "relay",
          ready: true,
          label: "电脑已连接",
          detail: "正在读取任务和最近消息…"
        };
      }
      if (elapsedSeconds < 10) {
        return {
          mode: "relay",
          ready: false,
          label: "服务器已连接",
          detail: "正在等待你的电脑主动连接…"
        };
      }
      if (elapsedSeconds < 30) {
        return {
          mode: "relay",
          ready: false,
          label: "电脑尚未连接",
          detail: "已等待 " + elapsedSeconds + " 秒，WeRelay 会自动重试。"
        };
      }
      return {
        mode: "relay",
        ready: false,
        label: "电脑仍未连接",
        detail: "已等待 " + elapsedSeconds + " 秒，请确认电脑已开机、联网且 WeRelay 正在运行。"
      };
    }
    return {
      mode: "direct",
      ready: true,
      label: "已连接电脑",
      detail: "正在读取任务和最近消息…"
    };
  }

  function bootReadyStatus() {
    return state.connectionMode === "relay"
      ? "电脑已连接"
      : "已连接电脑";
  }

  async function waitForComputerConnection() {
    if (!state.cachePreviewMode) {
      app.hidden = true;
      authScreen.hidden = true;
      bootScreen.hidden = false;
    }
    var startedAtMs = Date.now();
    var serverFailureCount = 0;
    bootStatus.textContent = "正在检查连接状态";
    bootDetail.textContent = "正在确认服务器和电脑是否在线。";
    while (true) {
      try {
        var health = await fetchJson("/health", { cache: "no-store" });
        serverFailureCount = 0;
        var connection = resolveBootConnectionState(health, Date.now() - startedAtMs);
        state.connectionMode = connection.mode;
        bootStatus.textContent = connection.label;
        bootDetail.textContent = connection.detail;
        if (state.cachePreviewMode) {
          if (connection.ready) setCacheSyncState("checking");
          else setCacheSyncState("waiting-computer");
        }
        if (connection.ready) return;
      } catch (_) {
        serverFailureCount += 1;
        state.connectionMode = "unknown";
        bootStatus.textContent = "暂时无法连接服务器";
        bootDetail.textContent = "已重试 " + serverFailureCount + " 次，网络恢复后会自动继续。";
        if (state.cachePreviewMode) setCacheSyncState("server-retry");
      }
      await new Promise(function (resolve) {
        setTimeout(resolve, document.hidden ? 5000 : DEVICE_CONNECTION_RETRY_MS);
      });
    }
  }

  async function attemptLanAcceleration() {
    if (window.location.protocol !== "https:") return false;
    var pageUrl = new URL(window.location.href);
    if (pageUrl.searchParams.get("lan") === "public") {
      pageUrl.searchParams.delete("lan");
      history.replaceState(null, "", pageUrl.pathname + pageUrl.search + pageUrl.hash);
      return false;
    }
    if (recentlyAttemptedLanRedirect()) return false;

    var route;
    try {
      route = await fetchJson("/api/network-route", { cache: "no-store" });
    } catch (_) {
      return false;
    }
    if (
      !route ||
      route.mode !== "public" ||
      !route.sameNetworkLikely ||
      typeof route.lanUrl !== "string" ||
      !route.lanUrl
    ) {
      return false;
    }

    bootStatus.textContent = "检测到与电脑在同一网络，正在切换到高速连接…";
    bootDetail.textContent = "局域网连接通常更快，失败后会自动返回公网。";
    var handoff;
    try {
      handoff = await fetchJson("/api/network/lan-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: currentLanHandoffTarget() })
      });
    } catch (_) {
      bootStatus.textContent = bootReadyStatus();
      bootDetail.textContent = "正在读取任务和最近消息…";
      return false;
    }
    if (!handoff || typeof handoff.handoffUrl !== "string" || !handoff.handoffUrl) {
      bootStatus.textContent = bootReadyStatus();
      bootDetail.textContent = "正在读取任务和最近消息…";
      return false;
    }

    rememberLanRedirectAttempt();
    var fallbackUrl = new URL(window.location.href);
    fallbackUrl.searchParams.set("lan", "public");
    var fallbackTimer = setTimeout(function () {
      try { window.stop(); } catch (_) {}
      window.location.replace(fallbackUrl.toString());
    }, LAN_REDIRECT_FALLBACK_MS);
    try {
      window.location.assign(handoff.handoffUrl);
      return true;
    } catch (_) {
      clearTimeout(fallbackTimer);
      bootStatus.textContent = bootReadyStatus();
      bootDetail.textContent = "正在读取任务和最近消息…";
      return false;
    }
  }

  async function api(path, options) {
    try {
      return await fetchJson(path, options);
    } catch (error) {
      if (error.status === 401) {
        showAuthentication("login", "登录已过期，请重新输入访问密码。");
      }
      throw error;
    }
  }

  function adapterApiPath(path, requestedAdapter) {
    var url = new URL(path, window.location.origin);
    var adapter = requestedAdapter === undefined ? state.currentAdapter : requestedAdapter;
    if (adapter) url.searchParams.set("adapter", adapter);
    return url.pathname + url.search;
  }

  function currentAdapterEntry() {
    return state.adapters.find(function (adapter) {
      return adapter.id === state.currentAdapter;
    }) || null;
  }

  function fallbackAdapterName(adapterId) {
    var labels = {
      codex: "Codex",
      claude: "Claude Code",
      tclaude: "TClaude",
      grok: "Grok CLI",
      codebuddy: "CodeBuddy",
      reasonix: "reasonix",
      workbuddy: "WorkBuddy",
      deepseek: "DeepSeek Harness",
      opencode: "OpenCode",
      shell: "Shell"
    };
    return labels[adapterId] || adapterId || "Codex";
  }

  function adapterName(adapterId) {
    var entry = state.adapters.find(function (adapter) { return adapter.id === adapterId; });
    return entry?.label || fallbackAdapterName(adapterId);
  }

  function currentAdapterName() {
    return adapterName(state.currentAdapter);
  }

  function switchingAdapterName() {
    return adapterName(state.switchingAdapterId || state.currentAdapter);
  }

  function updateDocumentTitle() {
    var task = currentTask();
    document.title = task && task.title
      ? task.title
      : "WeRelay · " + currentAdapterName();
  }

  function updateActiveDocumentTitle() {
    if (state.settingsOpen) {
      document.title = "WeRelay · 设置";
      return;
    }
    updateDocumentTitle();
  }

  function isAdapterCapabilityError() {
    return /已连接，但网页版暂不支持/.test(state.adapterError || "");
  }

  function adapterStateLabel(status) {
    if (status === "busy") return "处理中";
    if (status === "awaiting_approval") return "待审批";
    if (status === "awaiting_input") return "待输入";
    if (status === "error") return "异常";
    if (status === "starting") return "启动中";
    return "";
  }

  function syncCurrentAdapterStatusFromTasks() {
    var adapter = currentAdapterEntry();
    if (!adapter) return;
    if (state.tasks.some(function (task) { return task.status === "approval"; })) {
      adapter.status = "awaiting_approval";
      return;
    }
    if (state.tasks.some(function (task) { return task.status === "input"; })) {
      adapter.status = "awaiting_input";
      return;
    }
    if (state.tasks.some(function (task) { return task.status === "running"; })) {
      adapter.status = "busy";
      return;
    }
    if (["busy", "awaiting_approval", "awaiting_input"].includes(adapter.status)) {
      adapter.status = "idle";
    }
  }

  function renderAdapterMenu() {
    activeAdapterLabel.textContent = state.switchingAdapter
      ? switchingAdapterName()
      : currentAdapterName();
    workspaceSwitcher.classList.remove("is-switching");
    workspaceSwitcher.setAttribute("aria-busy", state.switchingAdapter ? "true" : "false");
    workspaceSwitchProgress.hidden = true;
    updateActiveDocumentTitle();
    adapterMenu.innerHTML = "";
    state.adapters.forEach(function (adapter) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "adapter-menu-item" +
        (adapter.id === state.currentAdapter ? " is-active" : "") +
        (state.switchingAdapter && adapter.id === state.switchingAdapterId ? " is-switching" : "");
      button.disabled = state.switchingAdapter || state.creatingTask;
      button.setAttribute("role", "menuitem");
      var label = document.createElement("span");
      label.className = "adapter-menu-label";
      var runningDot = document.createElement("span");
      runningDot.className = "adapter-menu-running-dot";
      runningDot.setAttribute("aria-hidden", "true");
      runningDot.hidden = adapter.status !== "busy";
      var labelText = document.createElement("span");
      labelText.textContent = adapter.label;
      label.appendChild(runningDot);
      label.appendChild(labelText);
      var status = document.createElement("span");
      status.className = "adapter-menu-state";
      var adapterStatus = adapterStateLabel(adapter.status);
      status.textContent = state.switchingAdapter && adapter.id === state.switchingAdapterId
        ? "切换中"
        : adapter.id === state.currentAdapter
          ? "当前" + (adapterStatus ? " · " + adapterStatus : "")
          : adapterStatus;
      status.hidden = !status.textContent;
      button.appendChild(label);
      button.appendChild(status);
      button.addEventListener("click", function () {
        void switchAdapter(adapter.id);
      });
      adapterMenu.appendChild(button);
    });
  }

  async function loadAdapters() {
    var payload = await api("/api/adapters");
    state.adapters = Array.isArray(payload.adapters) ? payload.adapters : [];
    if (!state.adapters.some(function (adapter) { return adapter.id === state.currentAdapter; })) {
      state.currentAdapter = payload.activeAdapter || state.adapters[0]?.id || "codex";
    }
    renderAdapterMenu();
    return payload;
  }

  function currentTaskModelKey() {
    return state.currentAdapter + "\u0000" + state.currentThreadId;
  }

  function currentTaskModelState() {
    return state.currentThreadId ? state.taskModels[currentTaskModelKey()] || null : null;
  }

  function currentTaskPermissionKey() {
    return state.currentAdapter + "\u0000" + state.currentThreadId;
  }

  function currentTaskPermissionState() {
    return state.currentThreadId
      ? state.taskPermissions[currentTaskPermissionKey()] || null
      : null;
  }

  function closeModelMenu() {
    state.modelMenuOpen = false;
    composerModelMenu.hidden = true;
    composerModelButton.setAttribute("aria-expanded", "false");
  }

  function closeReasoningMenu() {
    state.reasoningMenuOpen = false;
    composerReasoningMenu.hidden = true;
    composerReasoningButton.setAttribute("aria-expanded", "false");
  }

  function closePermissionMenu() {
    state.permissionMenuOpen = false;
    composerPermissionMenu.hidden = true;
    composerPermissionButton.setAttribute("aria-expanded", "false");
  }

  function syncComposerSettingsVisibility() {
    composerSettingsControls.hidden = composerModelControl.hidden &&
      composerReasoningControl.hidden && composerPermissionControl.hidden;
  }

  function permissionLabel(value) {
    if (value === "read-only") return "只读";
    if (value === "workspace-write") return "项目内读写";
    if (value === "danger-full-access") return "完全访问";
    if (value === "default") return "标准权限";
    if (value === "acceptEdits") return "自动接受文件修改";
    if (value === "fullAccess") return "完全访问";
    if (value === "bypassPermissions") return "跳过审批";
    if (value === "plan") return "规划模式";
    if (value === "custom") return "自定义权限";
    return value || "权限范围";
  }

  function renderPermissionControl() {
    var permissionState = currentTaskPermissionState();
    var currentPermission = permissionState && permissionState.currentPermission || "";
    var options = permissionState && Array.isArray(permissionState.options)
      ? permissionState.options
      : [];
    if (!state.currentThreadId) {
      composerPermissionControl.hidden = true;
      closePermissionMenu();
      syncComposerSettingsVisibility();
      return;
    }
    composerPermissionControl.hidden = false;
    var currentOption = options.find(function (option) {
      return option.id === currentPermission;
    });
    composerPermissionLabel.textContent = state.permissionChanging
      ? "正在切换…"
      : !permissionState
        ? "获取中"
        : currentPermission
          ? (
              currentOption && currentOption.label || permissionLabel(currentPermission)
            )
          : "暂不可用";
    var canChange = Boolean(
      permissionState && permissionState.canChange && options.length > 0
    );
    composerPermissionButton.classList.toggle("is-readonly", !canChange);
    composerPermissionButton.classList.toggle("is-loading", state.permissionChanging);
    composerPermissionButton.setAttribute(
      "aria-disabled",
      canChange && !state.permissionChanging ? "false" : "true"
    );
    composerPermissionButton.title = !canChange
      ? permissionState && permissionState.unavailableReason ||
        (!permissionState ? "正在读取当前任务权限范围。" : "当前任务暂时不能切换权限范围。")
      : "切换当前任务权限范围";
    composerPermissionMenu.innerHTML = "";
    if (!canChange) {
      closePermissionMenu();
      syncComposerSettingsVisibility();
      return;
    }
    options.forEach(function (option) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "composer-model-option";
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", option.id === currentPermission ? "true" : "false");
      button.disabled = state.permissionChanging;
      var copy = document.createElement("span");
      copy.className = "composer-model-option-copy";
      var label = document.createElement("span");
      label.className = "composer-model-option-label";
      label.textContent = option.label || permissionLabel(option.id);
      copy.appendChild(label);
      if (option.description) {
        var description = document.createElement("span");
        description.className = "composer-model-option-description";
        description.textContent = option.description;
        copy.appendChild(description);
      }
      var check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      check.setAttribute("viewBox", "0 0 16 16");
      check.setAttribute("aria-hidden", "true");
      check.setAttribute("class", "composer-model-option-check");
      if (option.id === currentPermission) {
        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "m3.5 8.2 2.7 2.7 6.3-6.3");
        check.appendChild(path);
      }
      button.appendChild(copy);
      button.appendChild(check);
      button.addEventListener("click", function () {
        void selectCurrentTaskPermission(option.id);
      });
      composerPermissionMenu.appendChild(button);
    });
    composerPermissionMenu.hidden = !state.permissionMenuOpen;
    composerPermissionButton.setAttribute(
      "aria-expanded",
      state.permissionMenuOpen ? "true" : "false"
    );
    syncComposerSettingsVisibility();
  }

  function reasoningEffortLabel(value) {
    if (value === "none") return "关闭推理";
    if (value === "minimal") return "极低";
    if (value === "low") return "低";
    if (value === "medium") return "中";
    if (value === "high") return "高";
    if (value === "xhigh") return "很高";
    if (value === "max") return "最高";
    if (value === "ultra") return "超高";
    return value || "推理";
  }

  function renderReasoningControl() {
    var modelState = currentTaskModelState();
    var currentEffort = modelState && modelState.currentReasoningEffort || "";
    var options = modelState && Array.isArray(modelState.reasoningEffortOptions)
      ? modelState.reasoningEffortOptions
      : [];
    if (!state.currentThreadId || (!currentEffort && options.length === 0 && !state.reasoningChanging)) {
      composerReasoningControl.hidden = true;
      closeReasoningMenu();
      syncComposerSettingsVisibility();
      return;
    }
    composerReasoningControl.hidden = false;
    var currentOption = options.find(function (option) { return option.id === currentEffort; });
    composerReasoningLabel.textContent = state.reasoningChanging
      ? "正在切换…"
      : (
          currentOption && currentOption.label ||
          (currentEffort ? reasoningEffortLabel(currentEffort) : "跟随会话")
        );
    var canChange = Boolean(
      modelState && modelState.canChangeReasoningEffort && options.length > 0
    );
    composerReasoningButton.classList.toggle("is-readonly", !canChange);
    composerReasoningButton.classList.toggle("is-loading", state.reasoningChanging);
    composerReasoningButton.setAttribute(
      "aria-disabled",
      canChange && !state.reasoningChanging ? "false" : "true"
    );
    composerReasoningButton.title = !canChange
      ? modelState && modelState.reasoningEffortUnavailableReason || "当前模型没有可选推理强度。"
      : "切换当前任务推理强度";
    composerReasoningMenu.innerHTML = "";
    if (!canChange) {
      closeReasoningMenu();
      syncComposerSettingsVisibility();
      return;
    }
    options.forEach(function (option) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "composer-model-option";
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", option.id === currentEffort ? "true" : "false");
      button.disabled = state.reasoningChanging;
      var copy = document.createElement("span");
      copy.className = "composer-model-option-copy";
      var label = document.createElement("span");
      label.className = "composer-model-option-label";
      label.textContent = option.label || reasoningEffortLabel(option.id);
      copy.appendChild(label);
      if (option.description) {
        var description = document.createElement("span");
        description.className = "composer-model-option-description";
        description.textContent = option.description;
        copy.appendChild(description);
      }
      var check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      check.setAttribute("viewBox", "0 0 16 16");
      check.setAttribute("aria-hidden", "true");
      check.setAttribute("class", "composer-model-option-check");
      if (option.id === currentEffort) {
        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "m3.5 8.2 2.7 2.7 6.3-6.3");
        check.appendChild(path);
      }
      button.appendChild(copy);
      button.appendChild(check);
      button.addEventListener("click", function () {
        void selectCurrentTaskReasoningEffort(option.id);
      });
      composerReasoningMenu.appendChild(button);
    });
    composerReasoningMenu.hidden = !state.reasoningMenuOpen;
    composerReasoningButton.setAttribute("aria-expanded", state.reasoningMenuOpen ? "true" : "false");
    syncComposerSettingsVisibility();
  }

  function renderModelControl() {
    var modelState = currentTaskModelState();
    var currentModel = modelState && modelState.currentModel || "";
    var options = modelState && Array.isArray(modelState.options) ? modelState.options : [];
    if (!state.currentThreadId || (!currentModel && options.length === 0 && !state.modelChanging)) {
      composerModelControl.hidden = true;
      closeModelMenu();
      renderReasoningControl();
      renderPermissionControl();
      return;
    }
    composerModelControl.hidden = false;
    var currentOption = options.find(function (option) { return option.id === currentModel; });
    composerModelLabel.textContent = currentOption && currentOption.label ||
      currentModel || (state.modelChanging ? "正在切换…" : "模型");
    var canChange = Boolean(
      modelState && modelState.canChange && options.length > 0
    );
    composerModelButton.classList.toggle("is-readonly", !canChange);
    composerModelButton.classList.toggle("is-loading", state.modelChanging);
    composerModelButton.setAttribute("aria-disabled", canChange && !state.modelChanging ? "false" : "true");
    composerModelButton.title = !canChange
      ? modelState && modelState.unavailableReason || "当前任务暂时不能切换模型。"
      : currentModel ? "切换当前任务模型" : "查看模型";
    composerModelMenu.innerHTML = "";
    if (!canChange) {
      closeModelMenu();
      renderReasoningControl();
      renderPermissionControl();
      return;
    }
    var lastModelGroup;
    options.forEach(function (option) {
      var groupName = typeof option.group === "string" ? option.group.trim() : "";
      if (groupName && groupName !== lastModelGroup) {
        lastModelGroup = groupName;
        var heading = document.createElement("div");
        heading.className = "composer-model-group";
        heading.textContent = groupName;
        composerModelMenu.appendChild(heading);
      }
      var button = document.createElement("button");
      button.type = "button";
      button.className = "composer-model-option";
      button.setAttribute("role", "menuitemradio");
      button.setAttribute("aria-checked", option.id === currentModel ? "true" : "false");
      button.disabled = state.modelChanging;
      var copy = document.createElement("span");
      copy.className = "composer-model-option-copy";
      var label = document.createElement("span");
      label.className = "composer-model-option-label";
      label.textContent = option.label || option.id;
      copy.appendChild(label);
      if (option.description) {
        var description = document.createElement("span");
        description.className = "composer-model-option-description";
        description.textContent = option.description;
        copy.appendChild(description);
      }
      var check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      check.setAttribute("viewBox", "0 0 16 16");
      check.setAttribute("aria-hidden", "true");
      check.setAttribute("class", "composer-model-option-check");
      if (option.id === currentModel) {
        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "m3.5 8.2 2.7 2.7 6.3-6.3");
        check.appendChild(path);
      }
      button.appendChild(copy);
      button.appendChild(check);
      button.addEventListener("click", function () {
        void selectCurrentTaskModel(option.id);
      });
      composerModelMenu.appendChild(button);
    });
    composerModelMenu.hidden = !state.modelMenuOpen;
    composerModelButton.setAttribute("aria-expanded", state.modelMenuOpen ? "true" : "false");
    renderReasoningControl();
    renderPermissionControl();
  }

  async function loadCurrentTaskModel(force) {
    if (!state.currentThreadId) {
      renderModelControl();
      return null;
    }
    var key = currentTaskModelKey();
    var cached = state.taskModels[key];
    renderModelControl();
    if (!force && cached && Date.now() - Number(cached.loadedAtMs || 0) < 10000) {
      return cached;
    }
    var requestId = ++state.modelRequestId;
    var requestedAdapter = state.currentAdapter;
    var requestedThreadId = state.currentThreadId;
    try {
      var path = adapterApiPath("/api/tasks/" + encodeURIComponent(state.currentThreadId) + "/model");
      var payload = await api(path, { cache: "no-store" });
      if (
        requestId !== state.modelRequestId ||
        requestedAdapter !== state.currentAdapter ||
        requestedThreadId !== state.currentThreadId
      ) return null;
      state.taskModels[key] = Object.assign({}, payload, { loadedAtMs: Date.now() });
      renderModelControl();
      return state.taskModels[key];
    } catch (error) {
      if (
        requestId === state.modelRequestId &&
        requestedAdapter === state.currentAdapter &&
        requestedThreadId === state.currentThreadId
      ) {
        state.taskModels[key] = {
          currentModel: cached && cached.currentModel || "",
          options: cached && cached.options || [],
          currentReasoningEffort: cached && cached.currentReasoningEffort || "",
          reasoningEffortOptions: cached && cached.reasoningEffortOptions || [],
          canChange: false,
          canChangeReasoningEffort: false,
          unavailableReason: error.message || "暂时无法读取模型。",
          reasoningEffortUnavailableReason: error.message || "暂时无法读取推理强度。",
          loadedAtMs: Date.now()
        };
        renderModelControl();
      }
      return null;
    }
  }

  async function loadCurrentTaskPermission(force) {
    if (!state.currentThreadId) {
      renderPermissionControl();
      return null;
    }
    var key = currentTaskPermissionKey();
    var cached = state.taskPermissions[key];
    renderPermissionControl();
    if (!force && cached && Date.now() - Number(cached.loadedAtMs || 0) < 10000) {
      return cached;
    }
    var requestId = ++state.permissionRequestId;
    var requestedAdapter = state.currentAdapter;
    var requestedThreadId = state.currentThreadId;
    try {
      var path = adapterApiPath(
        "/api/tasks/" + encodeURIComponent(state.currentThreadId) + "/permission"
      );
      var payload = await api(path, { cache: "no-store" });
      if (
        requestId !== state.permissionRequestId ||
        requestedAdapter !== state.currentAdapter ||
        requestedThreadId !== state.currentThreadId
      ) return null;
      state.taskPermissions[key] = Object.assign({}, payload, { loadedAtMs: Date.now() });
      renderPermissionControl();
      return state.taskPermissions[key];
    } catch (error) {
      if (
        requestId === state.permissionRequestId &&
        requestedAdapter === state.currentAdapter &&
        requestedThreadId === state.currentThreadId
      ) {
        state.taskPermissions[key] = {
          currentPermission: cached && cached.currentPermission || "",
          options: cached && cached.options || [],
          canChange: false,
          unavailableReason: error.message || "暂时无法读取权限范围。",
          loadedAtMs: Date.now()
        };
        renderPermissionControl();
      }
      return null;
    }
  }

  async function selectCurrentTaskPermission(permission) {
    var permissionState = currentTaskPermissionState();
    if (!permissionState || !permissionState.canChange) {
      showToast(permissionState && permissionState.unavailableReason || "当前任务暂时不能切换权限范围");
      return;
    }
    if (state.permissionChanging || permission === permissionState.currentPermission) {
      closePermissionMenu();
      renderPermissionControl();
      return;
    }
    var option = (permissionState.options || []).find(function (candidate) {
      return candidate.id === permission;
    });
    if (!option) {
      showToast("这个权限范围当前不可用");
      return;
    }
    if (option.requiresConfirmation) {
      var confirmed = window.confirm(
        "确认切换为“" + (option.label || permissionLabel(option.id)) + "”吗？\n\n" +
        (option.description || "这个权限范围会减少审批并扩大任务可访问的范围。")
      );
      if (!confirmed) {
        closePermissionMenu();
        renderPermissionControl();
        return;
      }
    }
    var key = currentTaskPermissionKey();
    var requestId = ++state.permissionRequestId;
    var requestedAdapter = state.currentAdapter;
    var requestedThreadId = state.currentThreadId;
    state.permissionChanging = true;
    closePermissionMenu();
    renderPermissionControl();
    try {
      var path = adapterApiPath(
        "/api/tasks/" + encodeURIComponent(state.currentThreadId) + "/permission"
      );
      var payload = await api(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permission: permission })
      });
      if (
        requestId !== state.permissionRequestId ||
        requestedAdapter !== state.currentAdapter ||
        requestedThreadId !== state.currentThreadId
      ) return;
      state.taskPermissions[key] = Object.assign({}, payload, { loadedAtMs: Date.now() });
      showToast("权限范围已切换为" + permissionLabel(payload.currentPermission || permission));
    } catch (error) {
      if (
        requestId === state.permissionRequestId &&
        requestedAdapter === state.currentAdapter &&
        requestedThreadId === state.currentThreadId
      ) showToast(error.message || "权限范围切换失败，请重试");
    } finally {
      if (requestId === state.permissionRequestId) state.permissionChanging = false;
      renderPermissionControl();
    }
  }

  async function selectCurrentTaskModel(model) {
    var modelState = currentTaskModelState();
    if (!modelState || !modelState.canChange) {
      showToast(modelState && modelState.unavailableReason || "当前任务暂时不能切换模型");
      return;
    }
    if (state.modelChanging || model === modelState.currentModel) {
      closeModelMenu();
      renderModelControl();
      return;
    }
    var key = currentTaskModelKey();
    var requestId = ++state.modelRequestId;
    var requestedAdapter = state.currentAdapter;
    var requestedThreadId = state.currentThreadId;
    state.modelChanging = true;
    closeModelMenu();
    renderModelControl();
    try {
      var path = adapterApiPath("/api/tasks/" + encodeURIComponent(state.currentThreadId) + "/model");
      var payload = await api(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: model })
      });
      if (
        requestId !== state.modelRequestId ||
        requestedAdapter !== state.currentAdapter ||
        requestedThreadId !== state.currentThreadId
      ) return;
      state.taskModels[key] = Object.assign({}, payload, { loadedAtMs: Date.now() });
      showToast("已切换至 " + (payload.currentModel || model));
    } catch (error) {
      if (
        requestId === state.modelRequestId &&
        requestedAdapter === state.currentAdapter &&
        requestedThreadId === state.currentThreadId
      ) showToast(error.message || "模型切换失败，请重试");
    } finally {
      if (requestId === state.modelRequestId) state.modelChanging = false;
      renderModelControl();
    }
  }

  async function selectCurrentTaskReasoningEffort(reasoningEffort) {
    var modelState = currentTaskModelState();
    if (!modelState || !modelState.canChangeReasoningEffort) {
      showToast(modelState && modelState.reasoningEffortUnavailableReason || "当前模型没有可选推理强度");
      return;
    }
    if (state.reasoningChanging || reasoningEffort === modelState.currentReasoningEffort) {
      closeReasoningMenu();
      renderReasoningControl();
      return;
    }
    var key = currentTaskModelKey();
    var requestId = ++state.modelRequestId;
    var requestedAdapter = state.currentAdapter;
    var requestedThreadId = state.currentThreadId;
    state.reasoningChanging = true;
    closeReasoningMenu();
    renderReasoningControl();
    try {
      var path = adapterApiPath("/api/tasks/" + encodeURIComponent(state.currentThreadId) + "/model");
      var payload = await api(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reasoningEffort: reasoningEffort })
      });
      if (
        requestId !== state.modelRequestId ||
        requestedAdapter !== state.currentAdapter ||
        requestedThreadId !== state.currentThreadId
      ) return;
      state.taskModels[key] = Object.assign({}, payload, { loadedAtMs: Date.now() });
      showToast("推理强度已切换为" + reasoningEffortLabel(payload.currentReasoningEffort || reasoningEffort));
    } catch (error) {
      if (
        requestId === state.modelRequestId &&
        requestedAdapter === state.currentAdapter &&
        requestedThreadId === state.currentThreadId
      ) showToast(error.message || "推理强度切换失败，请重试");
    } finally {
      if (requestId === state.modelRequestId) state.reasoningChanging = false;
      renderModelControl();
    }
  }

  function resetTaskStateForAdapterSwitch() {
    state.taskRequestId += 1;
    state.messageRequestId += 1;
    state.historyRequestId += 1;
    state.composerRevision += 1;
    state.loadingMessages = false;
    state.trailingMessageRefresh = null;
    state.tasks = [];
    state.currentThreadId = "";
    state.modelRequestId += 1;
    state.modelChanging = false;
    state.reasoningChanging = false;
    state.permissionRequestId += 1;
    state.permissionChanging = false;
    closeModelMenu();
    closeReasoningMenu();
    closePermissionMenu();
    renderModelControl();
    state.serverMessages = [];
    state.historyMessages = [];
    state.latestMessages = [];
    state.oldestMessageCursor = null;
    state.hasOlderMessages = false;
    state.progressItems = [];
    state.optimisticProgressTurnId = null;
    state.pendingMessages = [];
    state.contentRevision = "";
    setCacheSyncState("idle");
    state.messageNodes = Object.create(null);
    state.queuedMessages = [];
    state.editingQueuedMessageId = "";
    state.editingQueuedImageCount = 0;
    state.runSummary = null;
    state.localRunSummary = null;
    state.pendingApproval = null;
    state.approvalResults = [];
    state.adapterError = "";
    state.pendingImages = [];
    composerInput.value = "";
    composerInput.placeholder = "有问题，尽管问";
    composerImageButton.disabled = false;
    renderPendingImages();
    renderQueuedMessages([]);
    renderTasks();
    renderMessages(false);
    updateHeader();
  }

  async function switchAdapter(adapterId, initial) {
    if (!adapterId || state.switchingAdapter || state.creatingTask) return false;
    var selectedAdapter = currentAdapterEntry();
    var reconnectCurrent = Boolean(
      state.adapterError && !isAdapterCapabilityError() ||
      selectedAdapter && ["stopped", "open", "error"].includes(selectedAdapter.status)
    );
    if (adapterId === state.currentAdapter && !initial && !reconnectCurrent) {
      toggleWorkspaceMenu(false);
      return true;
    }
    saveCurrentConversationSnapshot();
    rememberCurrentTaskSnapshot();
    state.switchingAdapter = true;
    state.switchingAdapterId = adapterId;
    state.switchStartedAtMs = Date.now();
    state.currentAdapter = adapterId;
    resetTaskStateForAdapterSwitch();
    restoreCachedAdapterState(adapterId, "");
    var canonicalUrl = new URL(window.location.href);
    canonicalUrl.searchParams.set("adapter", adapterId);
    if (!initial) canonicalUrl.searchParams.delete("task");
    history.replaceState(null, "", canonicalUrl.pathname + canonicalUrl.search + canonicalUrl.hash);
    renderAdapterMenu();
    renderTasks();
    renderMessages(false);
    updateHeader();
    toggleWorkspaceMenu(false);
    try {
      var result = await api(
        "/api/adapters/" + encodeURIComponent(adapterId) + "/switch",
        { method: "POST" }
      );
      state.currentAdapter = result.activeAdapter || adapterId;
      if (state.currentAdapter !== adapterId) {
        resetTaskStateForAdapterSwitch();
        restoreCachedAdapterState(state.currentAdapter, "");
        canonicalUrl.searchParams.set("adapter", state.currentAdapter);
        history.replaceState(null, "", canonicalUrl.pathname + canonicalUrl.search + canonicalUrl.hash);
      }
      await loadAdapters();
      if (!initial) await loadTasks(true);
      if (!initial) showToast("已切换到 " + currentAdapterName());
      return true;
    } catch (error) {
      state.adapterError = error.message || "暂时无法连接这个终端。";
      renderMessages(false);
      updateHeader();
      showToast("切换失败：" + (error.message || "请稍后重试"));
      await loadAdapters().catch(function () {});
      return false;
    } finally {
      state.switchingAdapter = false;
      state.switchingAdapterId = "";
      state.switchStartedAtMs = 0;
      renderAdapterMenu();
      renderTasks();
      updateHeader();
    }
  }

  function showAuthentication(mode, message, disabled) {
    state.authenticated = false;
    state.cachePreviewMode = false;
    state.taskRequestId += 1;
    state.messageRequestId += 1;
    state.composerRevision += 1;
    state.authMode = mode;
    if (state.liveRefreshTimer) clearTimeout(state.liveRefreshTimer);
    state.liveRefreshTimer = null;
    bootScreen.hidden = true;
    app.hidden = true;
    authScreen.hidden = false;
    authPassword.value = "";
    authPassword.disabled = Boolean(disabled);
    authSubmit.disabled = Boolean(disabled);
    authError.textContent = message || "";
    if (mode === "setup") {
      authTitle.textContent = "设置访问密码";
      authDescription.textContent = "首次使用，请先为 WeRelay 移动端设置密码。";
      authHint.textContent = "至少 8 个字符。密码只保存在这台 Mac 上。";
      authSubmit.textContent = "设置并进入";
      authPassword.autocomplete = "new-password";
    } else {
      authTitle.textContent = "进入 WeRelay";
      authDescription.textContent = "输入访问密码，继续电脑上的任务。";
      authHint.textContent = "登录状态会在此设备保留 30 天。";
      authSubmit.textContent = "进入";
      authPassword.autocomplete = "current-password";
    }
    if (!disabled) setTimeout(function () { authPassword.focus(); }, 0);
  }

  async function initializeAuthentication() {
    updateAuthSecurityWarning();
    state.setupToken = readSetupToken();
    try {
      var status = await authApi("/api/auth/status");
      if (status.authenticated) {
        if (state.authenticationRetryTimer) clearTimeout(state.authenticationRetryTimer);
        state.authenticationRetryTimer = null;
        void startAuthenticatedApp();
        return;
      }
      if (!status.configured) {
        if (!status.canSetup) {
          showAuthentication("setup", "请从微信重新打开最新链接，再设置访问密码。", true);
          return;
        }
        showAuthentication("setup", "", false);
        return;
      }
      showAuthentication("login", "", false);
    } catch (error) {
      var waitingForComputer = error.network || error.status === 503 || error.status === 504;
      if (waitingForComputer) {
        if (!state.cachePreviewMode) {
          state.authenticated = false;
          app.hidden = true;
          authScreen.hidden = true;
          bootScreen.hidden = false;
        }
        if (!state.authenticationRetryTimer) {
          state.authenticationRetryTimer = setTimeout(function () {
            state.authenticationRetryTimer = null;
            void initializeAuthentication();
          }, document.hidden ? 5000 : DEVICE_CONNECTION_RETRY_MS);
        }
        return;
      }
      showAuthentication("login", error.message || "暂时无法连接电脑端。", true);
    }
  }

  function startAuthenticatedApp() {
    var resumedCachedPreview = state.cachePreviewMode;
    state.authenticated = true;
    state.cachePreviewMode = false;
    state.persistentCacheAuthenticatedAtMs = Date.now();
    authScreen.hidden = true;
    var firstStart = !state.appStarted;
    var pageUrl = new URL(window.location.href);
    var requestedAdapter = pageUrl.searchParams.get("adapter") || "";
    var requestedTask = pageUrl.searchParams.get("task") || "";
    var requestedBoard = pageUrl.searchParams.get("view") === "board";
    var requestedSettings = pageUrl.searchParams.get("view") === "settings";
    state.boardView = pageUrl.searchParams.get("board") === "completed"
      ? "completed"
      : "active";
    if (requestedAdapter) state.currentAdapter = requestedAdapter;

    var restoredCache = restorePersistentMobileCache(
      requestedAdapter || state.currentAdapter,
      requestedTask
    );
    var shouldValidateCachedContent = Boolean(resumedCachedPreview || restoredCache);
    var needsInitialTask = firstStart || !state.currentThreadId;
    state.appStarted = true;
    if (!state.runClockTimer) {
      state.runClockTimer = setInterval(updateRunHeaderClock, 1000);
    }
    state.loadingTasks = needsInitialTask && !restoredCache && !state.tasks.length;
    renderAdapterMenu();
    renderTasks();
    updateHeader();
    if (needsInitialTask && !state.currentThreadId && !restoredCache) {
      messagesEl.innerHTML = "";
    }
    bootScreen.hidden = true;
    app.hidden = false;
    setTaskBoardOpen(requestedBoard, false);
    setSettingsOpen(requestedSettings, false);
    syncComposerInset();
    updateUserMessageNavigation();

    void refreshAuthenticatedApp({
      firstStart: firstStart,
      needsInitialTask: needsInitialTask,
      requestedAdapter: requestedAdapter,
      requestedTask: requestedTask,
      pageUrl: pageUrl,
      restoredCache: shouldValidateCachedContent
    });
  }

  async function refreshAuthenticatedApp(options) {
    if (options.firstStart && await attemptLanAcceleration()) return;
    var needsInitialTask = options.needsInitialTask;
    var requestedAdapter = options.requestedAdapter;
    var requestedTask = options.requestedTask;
    var pageUrl = options.pageUrl;
    var adapterPayload;
    try {
      adapterPayload = await loadAdapters();
    } catch (error) {
      state.loadingTasks = false;
      state.adapterError = error.message || "暂时无法连接电脑端。";
      renderTasks();
      renderMessages(false);
      updateHeader();
      scheduleLiveRefresh(2200);
      return;
    }
    if (!requestedAdapter) {
      var activeAdapter = adapterPayload.activeAdapter || state.currentAdapter;
      if (activeAdapter !== state.currentAdapter) {
        rememberCurrentTaskSnapshot();
        restoreCachedAdapterState(activeAdapter, "");
        needsInitialTask = true;
      }
      state.currentAdapter = activeAdapter;
      renderAdapterMenu();
    } else if (requestedAdapter !== adapterPayload.activeAdapter) {
      var switched = await switchAdapter(requestedAdapter, true);
      if (!switched) {
        state.currentAdapter = adapterPayload.activeAdapter || state.currentAdapter;
        restoreCachedAdapterState(state.currentAdapter, "");
        pageUrl.searchParams.set("adapter", state.currentAdapter);
        history.replaceState(null, "", pageUrl.pathname + pageUrl.search + pageUrl.hash);
      } else {
        needsInitialTask = true;
      }
    } else {
      state.currentAdapter = requestedAdapter;
      renderAdapterMenu();
    }
    if (needsInitialTask) {
      if (requestedTask && !/^[0-9a-f]{8}$/i.test(requestedTask)) {
        await Promise.all([
          selectTask(requestedTask, false),
          loadTasks(true)
        ]);
      } else {
        await loadTasks(true);
      }
      if (options.restoredCache && state.currentThreadId) {
        await refreshMessagesIfChanged(false, true);
      }
    } else {
      await Promise.all([
        loadTasks(false),
        refreshMessagesIfChanged(false, Boolean(options.restoredCache))
      ]);
    }
    if (!state.authenticated) return;
    syncComposerInset();
    if (!restoredCacheScrollPosition()) scrollToLatest(false);
    updateUserMessageNavigation();
    persistMobileCacheNow();
    scheduleLiveRefresh(2200);
  }

  function restoredCacheScrollPosition() {
    var snapshot = state.conversationSnapshots[
      conversationStateKey(state.currentAdapter, state.currentThreadId)
    ];
    return Boolean(snapshot && snapshot.nearBottom === false);
  }

  function taskStatusLabel(status) {
    if (status === "running") return "运行中";
    if (status === "approval") return "待审批";
    if (status === "input") return "待输入";
    if (status === "error") return "异常";
    return "空闲";
  }

  function reconcileTaskApprovalStatus(task, pendingApproval, runSummary) {
    if (!task) return task;
    if (pendingApproval) {
      return task.status === "approval"
        ? task
        : Object.assign({}, task, { status: "approval" });
    }
    if (task.status !== "approval") return task;
    var nextStatus = runSummary && runSummary.status === "running"
      ? "running"
      : runSummary && runSummary.status === "failed"
        ? "error"
        : "idle";
    return Object.assign({}, task, { status: nextStatus });
  }

  function currentTask() {
    return state.tasks.find(function (task) { return task.threadId === state.currentThreadId; }) || null;
  }

  function visiblePendingMessages() {
    return state.pendingMessages.filter(function (pending) {
      return pending.displayInTranscript !== false;
    });
  }

  function currentVisibleRunSummary() {
    var messages = filterVisibleConversationMessages(state.serverMessages).concat(visiblePendingMessages().map(function (pending) {
      return Object.assign({ role: "user", pending: true }, pending);
    }));
    return resolveVisibleRunSummary(
      messages,
      currentTask(),
      effectiveRunSummary(),
      Date.now(),
      state.progressItems
    );
  }

  function shouldQueueComposerSubmission(
    task,
    runSummary,
    queuedMessages,
    pendingApproval,
    waitingForTaskCreation
  ) {
    if (waitingForTaskCreation) return false;
    return isTaskActivelyRunning(task) ||
      Boolean(runSummary && runSummary.status === "running") ||
      Boolean(queuedMessages && queuedMessages.length > 0) ||
      Boolean(pendingApproval);
  }

  function updateHeader() {
    var task = currentTask();
    var capabilityLimited = isAdapterCapabilityError();
    var hasComposerContent = Boolean(
      composerInput.value.trim() || state.pendingImages.length > 0 ||
      state.editingQueuedMessageId && state.editingQueuedImageCount > 0
    );
    var stopMode = shouldUseStopComposerAction(
      task,
      currentVisibleRunSummary(),
      hasComposerContent
    );
    titleEl.textContent = state.switchingAdapter
      ? switchingAdapterName()
      : task
        ? task.title
        : state.loadingTasks
          ? currentAdapterName()
          : state.adapterError
            ? currentAdapterName() + (capabilityLimited ? " 网页能力受限" : " 未连接")
            : "选择一个任务";
    metaEl.textContent = state.switchingAdapter
      ? ""
      : task
        ? task.localCreationState === "creating"
          ? "正在后台创建，可以先输入"
          : task.localCreationState === "failed"
            ? "输入内容和图片已保留"
            : task.localCreationState === "ready"
              ? "输入内容会保留，发送后开始执行"
            : (task.projectName || currentAdapterName() + " 任务")
        : state.adapterError
          ? capabilityLimited
            ? "请在微信或电脑终端中继续使用"
            : "点击上方终端菜单重新连接"
          : "";
    updateActiveDocumentTitle();
    statusEl.className = "status-label" + (
      state.switchingAdapter
        ? " starting"
        : task && task.localCreationState === "creating"
          ? " starting"
          : task && task.localCreationState === "failed"
            ? " error"
            : task
              ? " " + task.status
              : ""
    );
    statusEl.textContent = state.switchingAdapter
      ? switchProgressLabel(state.switchStartedAtMs, Date.now())
      : task && task.localCreationState === "creating"
        ? "创建中"
        : task && task.localCreationState === "failed"
          ? "创建失败"
          : task && task.localCreationState === "ready"
            ? "待输入"
          : task
            ? taskStatusLabel(task.status)
        : state.loadingTasks
          ? "读取中"
          : state.adapterError
            ? capabilityLimited ? "已连接" : "未连接"
            : "未选择";
    sendButton.classList.toggle("is-stop", stopMode);
    sendButton.setAttribute(
      "aria-label",
      stopMode
        ? (state.stopRequestedThreadId === state.currentThreadId ? "正在停止" : "停止")
        : "发送"
    );
    sendButton.disabled = Boolean(
      Boolean(state.queueActionMessageId) || !task ||
      state.stopRequestedThreadId === state.currentThreadId ||
      (!stopMode && !hasComposerContent)
    );
    var reusableLocalTask = currentLocalTaskDraft();
    newTaskButton.disabled = Boolean(state.creatingTask || state.switchingAdapter || state.loadingTasks);
    newTaskButton.setAttribute(
      "aria-label",
      state.creatingTask
        ? "正在新建任务"
        : reusableLocalTask && reusableLocalTask.localCreationState === "failed"
          ? "继续未完成的新任务"
          : reusableLocalTask
            ? "继续未完成的新任务"
          : "新建 " + currentAdapterName() + " 任务"
    );
  }

  function setTaskView(view) {
    var normalized = view === "recent" ? "recent" : "projects";
    if (state.taskView === normalized) {
      updateTaskViewSwitch();
      return;
    }
    state.taskView = normalized;
    updateTaskViewSwitch();
    renderTasks();
    taskList.scrollTop = 0;
  }

  function updateTaskViewSwitch() {
    var projectActive = state.taskView === "projects";
    taskViewProjects.classList.toggle("is-active", projectActive);
    taskViewProjects.setAttribute("aria-selected", projectActive ? "true" : "false");
    taskViewRecent.classList.toggle("is-active", !projectActive);
    taskViewRecent.setAttribute("aria-selected", projectActive ? "false" : "true");
  }

  function taskGroupKey(task) {
    if (typeof task.projectId === "string" && task.projectId.trim()) {
      return "project:" + task.projectId.trim();
    }
    if (typeof task.projectName === "string" && task.projectName.trim()) {
      return "project-name:" + task.projectName.trim();
    }
    return "recent";
  }

  function syncChildOrder(parent, nodes) {
    nodes.forEach(function (node, index) {
      var current = parent.children[index] || null;
      if (current !== node) {
        parent.insertBefore(node, current);
      }
    });
    while (parent.children.length > nodes.length) {
      parent.removeChild(parent.lastElementChild);
    }
  }

  function taskById(threadId) {
    return state.tasks.find(function (task) { return task.threadId === threadId; }) || null;
  }

  function closeTaskContextMenu() {
    taskContextMenu.hidden = true;
    taskContextMenu.style.visibility = "";
    state.contextTaskId = "";
  }

  function openTaskContextMenu(threadId, clientX, clientY, sourceButton) {
    var task = taskById(threadId);
    if (!task || isTemporaryTask(task)) return;
    toggleWorkspaceMenu(false);
    state.contextTaskId = threadId;
    taskContextRename.hidden = task.canRename !== true;
    taskContextMenu.hidden = false;
    taskContextMenu.style.visibility = "hidden";
    taskContextMenu.style.left = "0px";
    taskContextMenu.style.top = "0px";
    var rect = sourceButton.getBoundingClientRect();
    var menuWidth = taskContextMenu.offsetWidth;
    var menuHeight = taskContextMenu.offsetHeight;
    var x = Number.isFinite(clientX) ? clientX + 4 : rect.left + 12;
    var y = Number.isFinite(clientY) ? clientY + 4 : rect.bottom - 4;
    x = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8));
    taskContextMenu.style.left = Math.round(x) + "px";
    taskContextMenu.style.top = Math.round(y) + "px";
    taskContextMenu.style.visibility = "visible";
    var firstItem = task.canRename === true ? taskContextRename : taskContextCopyId;
    if (firstItem && document.activeElement === sourceButton && clientX === undefined) {
      firstItem.focus();
    }
  }

  function openTaskRenameDialog() {
    var task = taskById(state.contextTaskId);
    if (!task || task.canRename !== true) {
      closeTaskContextMenu();
      return;
    }
    state.renamingTaskId = task.threadId;
    closeTaskContextMenu();
    taskRenameInput.value = task.title || "";
    taskRenameOverlay.hidden = false;
    document.body.classList.add("task-rename-open");
    requestAnimationFrame(function () {
      taskRenameInput.focus();
      taskRenameInput.select();
    });
  }

  function closeTaskRenameDialog(force) {
    if (state.renameSubmitting && force !== true) return;
    taskRenameOverlay.hidden = true;
    taskRenameForm.removeAttribute("aria-busy");
    taskRenameCancel.disabled = false;
    taskRenameSave.disabled = false;
    state.renamingTaskId = "";
    document.body.classList.remove("task-rename-open");
  }

  async function renameTaskFromDialog() {
    if (state.renameSubmitting || !state.renamingTaskId) return;
    var task = taskById(state.renamingTaskId);
    var title = taskRenameInput.value.trim();
    if (!task) {
      closeTaskRenameDialog(true);
      return;
    }
    if (!title) {
      showToast("任务名不能为空");
      taskRenameInput.focus();
      return;
    }
    if (title === task.title) {
      closeTaskRenameDialog(true);
      return;
    }
    state.renameSubmitting = true;
    taskRenameForm.setAttribute("aria-busy", "true");
    taskRenameCancel.disabled = true;
    taskRenameSave.disabled = true;
    try {
      var payload = await api(adapterApiPath(
        "/api/tasks/" + encodeURIComponent(task.threadId)
      ), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title })
      });
      var index = state.tasks.findIndex(function (item) {
        return item.threadId === task.threadId;
      });
      if (index >= 0) {
        state.tasks[index] = Object.assign({}, state.tasks[index], {
          title: payload && typeof payload.title === "string" ? payload.title : title
        });
      }
      state.renameSubmitting = false;
      closeTaskRenameDialog(true);
      renderTasks();
      updateHeader();
      showToast("已重命名");
      void loadTasks(false);
    } catch (error) {
      showToast(error.message || "重命名失败");
    } finally {
      state.renameSubmitting = false;
      taskRenameForm.removeAttribute("aria-busy");
      taskRenameCancel.disabled = false;
      taskRenameSave.disabled = false;
    }
  }

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {}
    }
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    var copied = false;
    try { copied = document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(textarea);
    return copied;
  }

  async function copyContextTaskId() {
    var threadId = state.contextTaskId;
    closeTaskContextMenu();
    if (!threadId) return;
    var copied = await copyTextToClipboard(threadId);
    showToast(copied ? "已复制任务 ID" : "复制失败，请稍后重试");
  }

  function hasActiveTextSelection() {
    var selection = window.getSelection && window.getSelection();
    return Boolean(selection && !selection.isCollapsed && String(selection).trim());
  }

  function clearActiveTextSelection() {
    var selection = window.getSelection && window.getSelection();
    if (selection && typeof selection.removeAllRanges === "function") selection.removeAllRanges();
    activeMessageSelectionScope = null;
  }

  function selectionNodeWithin(container, node) {
    return Boolean(container && node && (node === container || container.contains(node)));
  }

  function selectionEscapesMessageContent(selection, content) {
    if (!selection || selection.isCollapsed || !content) return false;
    return !selectionNodeWithin(content, selection.anchorNode) ||
      !selectionNodeWithin(content, selection.focusNode);
  }

  function clampSelectionToMessageContent(selection, content) {
    if (!selectionEscapesMessageContent(selection, content)) return false;
    var range = document.createRange();
    range.selectNodeContents(content);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  var activeMessageSelectionScope = null;
  var clampingMessageSelection = false;

  function rememberMessageSelectionScope(event) {
    var target = event && event.target;
    var content = target && typeof target.closest === "function"
      ? target.closest(".message-content")
      : null;
    activeMessageSelectionScope = content && messagesEl.contains(content) ? content : null;
  }

  function isTaskContextMenuTriggerAllowed(button, clientX, clientY) {
    if (
      window.matchMedia("(max-width: 760px)").matches &&
      !app.classList.contains("sidebar-open")
    ) return false;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return true;
    var hit = document.elementFromPoint(clientX, clientY);
    return Boolean(hit && button.contains(hit));
  }

  function closeSidebar() {
    app.classList.remove("sidebar-open");
    closeTaskContextMenu();
  }

  function createTaskButton(threadId) {
    var button = document.createElement("button");
    var longPressTimer = null;
    var longPressPointerId = null;
    var longPressStartX = 0;
    var longPressStartY = 0;
    var longPressActive = false;
    var longPressTriggered = false;
    var longPressResetTimer = null;

    function cancelLongPress() {
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = null;
      longPressPointerId = null;
      longPressActive = false;
    }

    function markLongPressTriggered() {
      longPressTriggered = true;
      if (longPressResetTimer) clearTimeout(longPressResetTimer);
      longPressResetTimer = setTimeout(function () {
        longPressTriggered = false;
        longPressResetTimer = null;
      }, 10000);
    }

    function finishLongPress() {
      var triggered = longPressTriggered;
      cancelLongPress();
      if (!triggered) return;
      if (longPressResetTimer) clearTimeout(longPressResetTimer);
      longPressResetTimer = setTimeout(function () {
        longPressTriggered = false;
        longPressResetTimer = null;
      }, 1200);
    }

    button.type = "button";
    button.className = "task-item";
    button.dataset.threadId = threadId;
    button.setAttribute("aria-haspopup", "menu");
    button.innerHTML =
      '<span class="task-copy"><span class="task-title"></span><span class="task-project"></span></span>' +
      '<span class="task-indicator"><span class="task-dot"></span><span class="task-status-badge"></span></span>';
    button.addEventListener("click", function (event) {
      if (longPressTriggered) {
        longPressTriggered = false;
        if (longPressResetTimer) clearTimeout(longPressResetTimer);
        longPressResetTimer = null;
        state.suppressTaskClickThreadId = "";
        state.suppressTaskClickUntil = 0;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (
        state.suppressTaskClickThreadId === threadId &&
        Date.now() < state.suppressTaskClickUntil
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (state.creatingTask && threadId !== state.currentThreadId) {
        showToast("新任务正在后台创建，可以先继续输入");
        return;
      }
      closeTaskContextMenu();
      if (state.boardOpen) setTaskBoardOpen(false, true);
      selectTask(threadId, true);
    });
    button.addEventListener("contextmenu", function (event) {
      event.preventDefault();
      if (!isTaskContextMenuTriggerAllowed(button, event.clientX, event.clientY)) {
        cancelLongPress();
        return;
      }
      var touchGeneratedContextMenu = event.pointerType === "touch" || Boolean(
        event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents
      );
      cancelLongPress();
      if (touchGeneratedContextMenu) markLongPressTriggered();
      state.suppressTaskClickThreadId = threadId;
      state.suppressTaskClickUntil = Date.now() + 700;
      openTaskContextMenu(threadId, event.clientX, event.clientY, button);
    });
    button.addEventListener("pointerdown", function (event) {
      if (event.button !== 0 || event.pointerType === "mouse") return;
      clearActiveTextSelection();
      cancelLongPress();
      longPressPointerId = event.pointerId;
      longPressStartX = event.clientX;
      longPressStartY = event.clientY;
      longPressActive = true;
      longPressTimer = setTimeout(function () {
        longPressTimer = null;
        var hit = document.elementFromPoint(longPressStartX, longPressStartY);
        var sidebarHiddenOnMobile = window.matchMedia("(max-width: 760px)").matches &&
          !app.classList.contains("sidebar-open");
        if (
          !longPressActive ||
          !button.isConnected ||
          !hit ||
          !button.contains(hit) ||
          sidebarHiddenOnMobile
        ) {
          cancelLongPress();
          return;
        }
        longPressPointerId = null;
        longPressActive = false;
        markLongPressTriggered();
        state.suppressTaskClickThreadId = threadId;
        state.suppressTaskClickUntil = Date.now() + 700;
        openTaskContextMenu(threadId, longPressStartX, longPressStartY, button);
      }, TASK_LONG_PRESS_MS);
    });
    button.addEventListener("pointermove", function (event) {
      if (event.pointerId !== longPressPointerId) return;
      if (
        Math.abs(event.clientX - longPressStartX) > TASK_LONG_PRESS_MOVE_PX ||
        Math.abs(event.clientY - longPressStartY) > TASK_LONG_PRESS_MOVE_PX
      ) cancelLongPress();
    });
    button.addEventListener("pointerup", finishLongPress);
    button.addEventListener("pointercancel", finishLongPress);
    button.addEventListener("pointerleave", finishLongPress);
    button.addEventListener("lostpointercapture", finishLongPress);
    button.addEventListener("keydown", function (event) {
      if (event.key === "ContextMenu" || event.shiftKey && event.key === "F10") {
        event.preventDefault();
        openTaskContextMenu(threadId, undefined, undefined, button);
      }
    });
    return button;
  }

  function updateTaskButton(button, task) {
    button.className = "task-item" + (task.threadId === state.currentThreadId ? " is-active" : "");
    var displayStatus = task.localCreationState === "creating"
      ? "创建中"
      : task.localCreationState === "failed"
        ? "创建失败"
        : task.localCreationState === "ready"
          ? "待输入"
        : taskStatusLabel(task.status);
    button.title = task.title + " · " + displayStatus;
    var dot = button.querySelector(".task-dot");
    if (dot) dot.className = "task-dot " + task.status;
    var badge = button.querySelector(".task-status-badge");
    if (badge) {
      badge.className = "task-status-badge" + (
        task.status === "approval" || task.localCreationState === "failed" ? " approval" : ""
      );
      var badgeText = task.status === "approval" ? "审批" : "";
      if (task.localCreationState === "creating") badgeText = "创建中";
      if (task.localCreationState === "failed") badgeText = "失败";
      if (task.localCreationState === "ready") badgeText = "待输入";
      badge.textContent = badgeText;
    }
    var title = button.querySelector(".task-title");
    if (title && title.textContent !== task.title) title.textContent = task.title;
    var project = button.querySelector(".task-project");
    var projectText = taskListProjectLabel(task, state.taskView);
    if (project && project.textContent !== projectText) project.textContent = projectText;
    if (project) project.hidden = !projectText;
  }

  function getTaskButton(task) {
    var button = state.taskNodes[task.threadId];
    if (!button) {
      button = createTaskButton(task.threadId);
      state.taskNodes[task.threadId] = button;
    }
    updateTaskButton(button, task);
    return button;
  }

  function getTaskGroup(group, searching) {
    var section = state.taskGroupNodes[group.key];
    if (!section) {
      section = document.createElement("section");
      section.className = "task-group";
      section.dataset.groupKey = group.key;
      var head = document.createElement("div");
      head.className = "task-group-head";
      var heading = document.createElement("button");
      heading.type = "button";
      heading.className = "task-group-title";
      heading.innerHTML =
        '<svg class="task-group-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m5.5 6 2.5 2.5L10.5 6"/></svg>' +
        '<span class="task-group-title-text"></span>';
      heading.addEventListener("click", function () {
        if (section.dataset.collapsible !== "true") return;
        var key = section.dataset.groupKey || "";
        var collapse = !Boolean(state.collapsedProjectGroups[key]);
        setProjectGroupCollapsed(
          state.collapsedProjectGroups,
          state.projectVisibleLimits,
          key,
          collapse
        );
        renderTasks();
      });
      var items = document.createElement("div");
      items.className = "task-group-items";
      var more = document.createElement("button");
      more.type = "button";
      more.className = "task-group-more";
      more.textContent = "显示更多";
      more.addEventListener("click", function () {
        var key = section.dataset.groupKey || "";
        var total = Number(section.dataset.taskCount) || 0;
        var current = Number(state.projectVisibleLimits[key]) || PROJECT_TASK_BATCH_SIZE;
        state.projectVisibleLimits[key] = nextTaskVisibleLimit(
          current,
          total,
          PROJECT_TASK_BATCH_SIZE
        );
        renderTasks();
      });
      var create = document.createElement("button");
      create.type = "button";
      create.className = "task-group-create";
      create.title = "在这个项目中新建任务";
      create.setAttribute("aria-label", "在这个项目中新建任务");
      create.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path class="task-group-create-plus" d="M10 4v12M4 10h12"/><circle class="task-group-create-spinner" cx="10" cy="10" r="6"/></svg>';
      create.addEventListener("click", function () {
        var sourceThreadId = section.dataset.createSourceThreadId || "";
        var projectName = section.dataset.projectName || "这个项目";
        if (sourceThreadId) void createTask(sourceThreadId, projectName);
      });
      head.appendChild(heading);
      head.appendChild(create);
      section.appendChild(head);
      section.appendChild(items);
      section.appendChild(more);
      state.taskGroupNodes[group.key] = section;
    }

    var collapsible = group.key !== "recent";
    var collapsed = collapsible && !searching && Boolean(state.collapsedProjectGroups[group.key]);
    section.className = "task-group" +
      (group.key === "recent" ? " is-recent" : "") +
      (collapsed ? " is-collapsed" : "");
    section.dataset.groupKey = group.key;
    section.dataset.collapsible = collapsible ? "true" : "false";
    section.dataset.taskCount = String(group.tasks.length);
    section.dataset.projectName = group.title;
    var createSource = collapsible
      ? projectTaskCreationSource(group.tasks, state.currentThreadId)
      : null;
    section.dataset.createSourceThreadId = createSource?.threadId || "";

    var headingNode = section.querySelector(".task-group-title");
    var headingText = section.querySelector(".task-group-title-text");
    if (headingText && headingText.textContent !== group.title) {
      headingText.textContent = group.title;
    }
    if (headingNode) {
      headingNode.classList.toggle("is-static", !collapsible);
      headingNode.setAttribute("aria-expanded", collapsed ? "false" : "true");
      headingNode.setAttribute("aria-label", collapsible
        ? group.title + (collapsed ? "，展开项目" : "，收起项目")
        : group.title);
    }
    var createNode = section.querySelector(".task-group-create");
    if (createNode) {
      createNode.hidden = !createSource;
      createNode.disabled = Boolean(state.creatingTask || state.switchingAdapter);
      createNode.classList.toggle(
        "is-loading",
        Boolean(state.creatingTask && state.creatingProjectKey === group.key)
      );
      var createLabel = "在“" + group.title + "”中新建任务";
      createNode.title = createLabel;
      createNode.setAttribute("aria-label", createLabel);
    }

    var configuredLimit = Number(state.projectVisibleLimits[group.key]) || PROJECT_TASK_BATCH_SIZE;
    var activeIndex = group.tasks.findIndex(function (task) {
      return task.threadId === state.currentThreadId;
    });
    var visibleLimit = searching
      ? group.tasks.length
      : Math.max(configuredLimit, activeIndex >= 0 ? activeIndex + 1 : 0);
    var visibleTasks = collapsed ? [] : group.tasks.slice(0, visibleLimit);
    var itemsNode = section.querySelector(".task-group-items");
    syncChildOrder(itemsNode, visibleTasks.map(getTaskButton));
    var moreNode = section.querySelector(".task-group-more");
    if (moreNode) {
      moreNode.hidden = collapsed || searching || visibleTasks.length >= group.tasks.length;
    }
    return section;
  }

  function getRecentMoreButton() {
    if (!state.recentMoreNode) {
      var button = document.createElement("button");
      button.type = "button";
      button.className = "task-list-more";
      button.textContent = "显示更多";
      button.addEventListener("click", function () {
        state.recentVisibleLimit = nextTaskVisibleLimit(
          state.recentVisibleLimit,
          state.tasks.length,
          RECENT_TASK_BATCH_SIZE
        );
        renderTasks();
      });
      state.recentMoreNode = button;
    }
    return state.recentMoreNode;
  }

  function renderRecentTasks(filtered, searching) {
    var sorted = sortTasksByRecency(filtered);
    var activeIndex = sorted.findIndex(function (task) {
      return task.threadId === state.currentThreadId;
    });
    var visibleLimit = searching
      ? sorted.length
      : Math.max(state.recentVisibleLimit, activeIndex >= 0 ? activeIndex + 1 : 0);
    var visibleTasks = sorted.slice(0, visibleLimit);
    var nodes = visibleTasks.map(getTaskButton);
    if (!searching && visibleTasks.length < sorted.length) {
      nodes.push(getRecentMoreButton());
    }
    syncChildOrder(taskList, nodes);
  }

  function renderProjectTasks(filtered, searching) {
    var groupByKey = Object.create(null);
    var groups = [];
    filtered.forEach(function (task, taskIndex) {
      var key = taskGroupKey(task);
      var group = groupByKey[key];
      if (!group) {
        var projectName = typeof task.projectName === "string" ? task.projectName.trim() : "";
        group = {
          key: key,
          title: projectName || "最近",
          projectOrder: Number.isFinite(task.projectOrder) ? task.projectOrder : Number.MAX_SAFE_INTEGER,
          firstTaskIndex: taskIndex,
          tasks: []
        };
        groupByKey[key] = group;
        groups.push(group);
      }
      group.projectOrder = Math.min(
        group.projectOrder,
        Number.isFinite(task.projectOrder) ? task.projectOrder : Number.MAX_SAFE_INTEGER
      );
      group.tasks.push({ task: task, sourceIndex: taskIndex });
    });

    groups.forEach(function (group) {
      group.tasks.sort(function (left, right) {
        var leftOrder = Number.isFinite(left.task.projectThreadOrder)
          ? left.task.projectThreadOrder
          : Number.MAX_SAFE_INTEGER;
        var rightOrder = Number.isFinite(right.task.projectThreadOrder)
          ? right.task.projectThreadOrder
          : Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.sourceIndex - right.sourceIndex;
      });
      group.tasks = group.tasks.map(function (entry) { return entry.task; });
    });
    groups.sort(function (left, right) {
      if (left.key === "recent") return 1;
      if (right.key === "recent") return -1;
      return left.projectOrder - right.projectOrder || left.firstTaskIndex - right.firstTaskIndex;
    });

    var activeGroupKeys = Object.create(null);
    var groupNodes = groups.map(function (group) {
      activeGroupKeys[group.key] = true;
      return getTaskGroup(group, searching);
    });
    Object.keys(state.taskGroupNodes).forEach(function (key) {
      if (!activeGroupKeys[key]) {
        var staleGroup = state.taskGroupNodes[key];
        if (staleGroup && staleGroup.parentNode) staleGroup.parentNode.removeChild(staleGroup);
        delete state.taskGroupNodes[key];
        delete state.collapsedProjectGroups[key];
        delete state.projectVisibleLimits[key];
      }
    });
    syncChildOrder(taskList, groupNodes);
  }

  function renderTasks() {
    updateTaskViewSwitch();
    if (state.switchingAdapter) {
      syncChildOrder(taskList, []);
      return;
    }
    var query = searchInput.value.trim().toLowerCase();
    var filtered = state.tasks.filter(function (task) {
      return !query || (task.title + " " + (task.projectName || "")).toLowerCase().includes(query);
    });

    var liveTaskIds = Object.create(null);
    state.tasks.forEach(function (task) { liveTaskIds[task.threadId] = true; });
    Object.keys(state.taskNodes).forEach(function (threadId) {
      if (!liveTaskIds[threadId]) {
        var staleNode = state.taskNodes[threadId];
        if (staleNode && staleNode.parentNode) staleNode.parentNode.removeChild(staleNode);
        delete state.taskNodes[threadId];
      }
    });

    if (!filtered.length) {
      if (!state.taskEmptyNode) {
        state.taskEmptyNode = document.createElement("div");
        state.taskEmptyNode.className = "loading-row";
      }
      if (state.loadingTasks) {
        syncChildOrder(taskList, []);
        return;
      }
      state.taskEmptyNode.textContent = state.adapterError || "没有匹配的任务";
      syncChildOrder(taskList, [state.taskEmptyNode]);
      return;
    }

    if (state.taskView === "recent") {
      renderRecentTasks(filtered, Boolean(query));
      return;
    }
    renderProjectTasks(filtered, Boolean(query));
  }

  function taskBoardStatusLabel(task) {
    if (task.status === "running") return "处理中";
    if (task.status === "approval") return "待审批";
    if (task.status === "input") return "待输入";
    if (task.status === "error") return "异常";
    return "待继续";
  }

  function updateTaskBoardControls() {
    taskBoardOpen.classList.toggle("is-active", state.boardOpen);
    taskBoardOpen.setAttribute("aria-pressed", state.boardOpen ? "true" : "false");
    var activeCount = state.boardTasks.filter(isTaskBoardInProgress).length;
    taskBoardCount.hidden = activeCount === 0;
    taskBoardCount.textContent = activeCount > 99 ? "99+" : String(activeCount);
    taskBoardViewActive.classList.toggle("is-active", state.boardView === "active");
    taskBoardViewActive.setAttribute(
      "aria-selected",
      state.boardView === "active" ? "true" : "false"
    );
    taskBoardViewCompleted.classList.toggle("is-active", state.boardView === "completed");
    taskBoardViewCompleted.setAttribute(
      "aria-selected",
      state.boardView === "completed" ? "true" : "false"
    );
    taskBoardRefresh.disabled = state.boardLoading;
    taskBoardRefresh.classList.toggle("is-loading", state.boardLoading);
    taskBoardSubtitle.textContent = state.boardView === "completed"
      ? "按完成时间查看所有 Agent 的真实任务"
      : "统一汇总，不按 Agent 分栏";
  }

  function renderTaskBoardEmpty(title, description) {
    var empty = document.createElement("div");
    empty.className = "task-board-empty";
    empty.innerHTML =
      '<div class="task-board-empty-copy">' +
      '<div class="task-board-empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="16" rx="1.5"/><rect x="14" y="4" width="6" height="9" rx="1.5"/></svg></div>' +
      '<h2>' + escapeHtml(title) + '</h2>' +
      '<p>' + escapeHtml(description) + '</p>' +
      '</div>';
    return empty;
  }

  function renderTaskBoardSkeleton() {
    var skeleton = document.createElement("div");
    skeleton.className = "task-board-skeleton";
    for (var columnIndex = 0; columnIndex < 4; columnIndex += 1) {
      var column = document.createElement("div");
      column.className = "task-board-skeleton-column";
      var line = document.createElement("div");
      line.className = "task-board-skeleton-line";
      column.appendChild(line);
      for (var cardIndex = 0; cardIndex < 2; cardIndex += 1) {
        var card = document.createElement("div");
        card.className = "task-board-skeleton-card";
        column.appendChild(card);
      }
      skeleton.appendChild(column);
    }
    return skeleton;
  }

  function renderTaskBoardCard(task, lane, showAdapterLabel) {
    var card = document.createElement("a");
    var key = task.adapter + "\u0000" + task.threadId;
    card.href = taskBoardTaskHref(task);
    card.className = "task-board-card" + (state.boardOpeningKey === key ? " is-opening" : "");
    card.dataset.lane = lane;
    card.setAttribute("aria-label", "打开任务：" + task.title);
    if (state.boardOpeningKey === key) card.setAttribute("aria-busy", "true");

    var title = document.createElement("span");
    title.className = "task-board-card-title";
    title.textContent = task.title;

    var meta = document.createElement("span");
    meta.className = "task-board-card-meta";
    var status = document.createElement("span");
    status.className = "task-board-card-status";
    status.innerHTML = '<span class="task-board-card-status-dot"></span><span></span>';
    status.lastChild.textContent = taskBoardStatusLabel(task);
    meta.appendChild(status);

    var contextText = taskBoardContextText(task, showAdapterLabel);
    var time = document.createElement("span");
    time.className = "task-board-card-time";
    time.textContent = formatTaskBoardTime(task.lastUpdatedAt);
    meta.appendChild(time);
    if (contextText) {
      var context = document.createElement("span");
      context.className = "task-board-card-context";
      context.textContent = contextText;
      context.title = context.textContent;
      meta.appendChild(context);
    }

    card.appendChild(title);
    card.appendChild(meta);
    card.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      if (state.boardOpeningKey) return;
      void openTaskFromBoard(task);
    });
    return card;
  }

  function renderActiveTaskBoard(tasks) {
    var laneDefinitions = [
      { id: "running", title: "处理中", empty: "当前没有正在执行的任务" },
      { id: "waiting", title: "等待你", empty: "没有待审批或待输入的任务" },
      { id: "error", title: "需要关注", empty: "当前没有异常任务" },
      { id: "queued", title: "待继续", empty: "没有等待继续的任务" }
    ];
    var lanes = {
      running: [],
      waiting: [],
      error: [],
      queued: []
    };
    tasks.forEach(function (task) {
      var lane = taskBoardLane(task);
      if (lane !== "completed") lanes[lane].push(task);
    });
    var activeCount = laneDefinitions.reduce(function (count, lane) {
      return count + lanes[lane.id].length;
    }, 0);
    if (!activeCount) {
      return renderTaskBoardEmpty(
        taskBoardSearch.value.trim() ? "没有匹配的任务" : "当前没有待处理任务",
        taskBoardSearch.value.trim()
          ? "换一个关键词搜索全部 Agent 的任务。"
          : "新任务开始运行后会自动出现在这里。"
      );
    }
    var showAdapterLabels = shouldShowTaskAdapterLabels(tasks);
    var columns = document.createElement("div");
    columns.className = "task-board-columns";
    laneDefinitions.forEach(function (definition) {
      var section = document.createElement("section");
      section.className = "task-board-column";
      section.dataset.lane = definition.id;
      section.classList.toggle("is-empty", lanes[definition.id].length === 0);
      var heading = document.createElement("div");
      heading.className = "task-board-column-head";
      heading.innerHTML =
        '<span class="task-board-column-mark"></span>' +
        '<span class="task-board-column-title">' + escapeHtml(definition.title) + '</span>' +
        '<span class="task-board-column-count">' + lanes[definition.id].length + '</span>';
      var list = document.createElement("div");
      list.className = "task-board-card-list";
      if (!lanes[definition.id].length) {
        var empty = document.createElement("div");
        empty.className = "task-board-column-empty";
        empty.textContent = definition.empty;
        list.appendChild(empty);
      } else {
        lanes[definition.id].forEach(function (task) {
          list.appendChild(renderTaskBoardCard(task, definition.id, showAdapterLabels));
        });
      }
      section.appendChild(heading);
      section.appendChild(list);
      columns.appendChild(section);
    });
    return columns;
  }

  function renderCompletedTaskBoard(items) {
    if (!items.length) {
      return renderTaskBoardEmpty(
        taskBoardSearch.value.trim() ? "没有匹配的已完成任务" : "还没有最近完成",
        taskBoardSearch.value.trim()
          ? "换一个关键词搜索最近完成的任务。"
          : "任意 Agent 的真实任务完成后，会自动汇入这里。"
      );
    }
    var showAdapterLabels = shouldShowTaskAdapterLabels(items);
    var list = document.createElement("div");
    list.className = "task-board-completed";
    items.forEach(function (item) {
      var button = document.createElement("a");
      var key = item.adapter + "\u0000" + item.threadId;
      button.href = taskBoardTaskHref(item);
      button.className = "task-board-completed-item" +
        (state.boardOpeningKey === key ? " is-opening" : "");
      button.setAttribute("aria-label", "打开已完成任务：" + item.title);
      if (state.boardOpeningKey === key) button.setAttribute("aria-busy", "true");
      var copy = document.createElement("span");
      copy.className = "task-board-completed-copy";
      var title = document.createElement("span");
      title.className = "task-board-completed-title";
      title.textContent = item.title;
      var meta = document.createElement("span");
      meta.className = "task-board-completed-meta";
      meta.textContent = taskBoardContextText(item, showAdapterLabels, "已完成");
      copy.appendChild(title);
      copy.appendChild(meta);
      var time = document.createElement("span");
      time.className = "task-board-completed-time";
      time.textContent = formatTaskBoardTime(item.completedAt);
      button.appendChild(copy);
      button.appendChild(time);
      button.addEventListener("click", function (event) {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (state.boardOpeningKey) return;
        void openTaskFromBoard(item);
      });
      list.appendChild(button);
    });
    return list;
  }

  function renderTaskBoard() {
    updateTaskBoardControls();
    if (!state.boardOpen) return;
    taskBoardBody.innerHTML = "";
    if (state.boardLoading && !hasTaskBoardCachedContent(
      state.boardTasks,
      state.boardRecentCompleted,
      state.boardLastLoadedAtMs
    )) {
      taskBoardBody.appendChild(renderTaskBoardSkeleton());
      return;
    }
    if (state.boardError && !hasTaskBoardCachedContent(
      state.boardTasks,
      state.boardRecentCompleted,
      state.boardLastLoadedAtMs
    )) {
      taskBoardBody.appendChild(renderTaskBoardEmpty(
        "任务看板暂时不可用",
        state.boardError + " 请稍后刷新重试。"
      ));
      return;
    }
    var query = taskBoardSearch.value.trim();
    if (state.boardView === "completed") {
      taskBoardBody.appendChild(renderCompletedTaskBoard(
        state.boardRecentCompleted.filter(function (item) {
          return taskBoardMatchesQuery(item, query);
        })
      ));
      return;
    }
    taskBoardBody.appendChild(renderActiveTaskBoard(
      state.boardTasks.filter(function (task) {
        return taskBoardMatchesQuery(task, query);
      })
    ));
  }

  async function loadTaskBoard(force) {
    if (!state.authenticated || state.boardLoading) return;
    var requestId = ++state.boardRequestId;
    var hasCachedBoard = hasTaskBoardCachedContent(
      state.boardTasks,
      state.boardRecentCompleted,
      state.boardLastLoadedAtMs
    );
    state.boardLoading = true;
    state.boardError = "";
    renderTaskBoard();
    try {
      var payload = await api("/api/task-board");
      if (requestId !== state.boardRequestId || !state.authenticated) return;
      state.boardTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      state.boardRecentCompleted = Array.isArray(payload.recentCompleted)
        ? payload.recentCompleted
        : [];
      state.boardLastLoadedAtMs = Date.now();
      schedulePersistentMobileCacheWrite();
    } catch (error) {
      if (requestId !== state.boardRequestId || error.status === 401) return;
      if (error.network && hasCachedBoard) return;
      state.boardError = error.message || "任务看板读取失败";
    } finally {
      if (requestId === state.boardRequestId) {
        state.boardLoading = false;
        renderTaskBoard();
      }
    }
  }

  function setTaskBoardView(view, updateUrl) {
    state.boardView = view === "completed" ? "completed" : "active";
    if (updateUrl) {
      var url = new URL(window.location.href);
      url.searchParams.set("view", "board");
      if (state.boardView === "completed") url.searchParams.set("board", "completed");
      else url.searchParams.delete("board");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    renderTaskBoard();
  }

  function setTaskBoardOpen(open, updateUrl) {
    if (open && state.settingsOpen) setSettingsOpen(false, false);
    state.boardOpen = Boolean(open);
    app.classList.toggle("board-open", state.boardOpen);
    taskBoard.hidden = !state.boardOpen;
    if (updateUrl) {
      var url = new URL(window.location.href);
      if (state.boardOpen) url.searchParams.set("view", "board");
      else {
        url.searchParams.delete("view");
        url.searchParams.delete("board");
      }
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    updateTaskBoardControls();
    if (state.boardOpen) {
      closeSidebar();
      renderTaskBoard();
      if (!state.boardLastLoadedAtMs || Date.now() - state.boardLastLoadedAtMs > 8000) {
        void loadTaskBoard(false);
      }
    }
    updateActiveDocumentTitle();
  }

  async function openTaskFromBoard(task) {
    var key = task.adapter + "\u0000" + task.threadId;
    if (state.boardOpeningKey) return;
    if (state.creatingTask) {
      showToast("新任务正在后台创建，可以先继续输入");
      return;
    }
    state.boardOpeningKey = key;
    renderTaskBoard();
    try {
      if (task.adapter !== state.currentAdapter) {
        var switched = await switchAdapter(task.adapter, true);
        if (!switched) return;
      }
      var url = new URL(window.location.href);
      url.searchParams.set("adapter", task.adapter);
      url.searchParams.set("task", task.threadId);
      url.searchParams.delete("view");
      url.searchParams.delete("board");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
      setTaskBoardOpen(false, false);
      if (!state.tasks.some(function (candidate) {
        return candidate.threadId === task.threadId;
      })) {
        state.tasks.push({
          threadId: task.threadId,
          title: task.title,
          status: task.status || "idle",
          lastUpdatedAt: task.lastUpdatedAt || task.completedAt || "",
          selected: true
        });
      }
      await selectTask(task.threadId, false);
      await loadTasks(false);
    } catch (error) {
      setTaskBoardOpen(true, false);
      showToast("任务打开失败：" + (error.message || "请稍后重试"));
    } finally {
      state.boardOpeningKey = "";
      renderTaskBoard();
    }
  }

  function positionWorkspaceMenu() {
    if (workspaceMenu.hidden) return;
    var anchor = workspaceSwitcher.getBoundingClientRect();
    var viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    var edge = 8;
    var gap = 7;
    var menuWidth = Math.min(300, Math.max(0, viewportWidth - edge * 2));
    workspaceMenu.style.width = menuWidth + "px";
    var menuHeight = Math.min(
      workspaceMenu.scrollHeight || workspaceMenu.getBoundingClientRect().height,
      Math.min(viewportHeight * 0.7, 520),
    );
    var maxLeft = Math.max(edge, viewportWidth - menuWidth - edge);
    var left = Math.min(Math.max(anchor.left, edge), maxLeft);
    var belowTop = anchor.bottom + gap;
    var aboveTop = anchor.top - menuHeight - gap;
    var top = belowTop + menuHeight <= viewportHeight - edge || aboveTop < edge
      ? belowTop
      : aboveTop;
    var maxTop = Math.max(edge, viewportHeight - menuHeight - edge);
    workspaceMenu.style.left = Math.round(left) + "px";
    workspaceMenu.style.top = Math.round(Math.min(Math.max(top, edge), maxTop)) + "px";
  }

  function toggleWorkspaceMenu(forceOpen) {
    var nextOpen = typeof forceOpen === "boolean"
      ? forceOpen
      : workspaceMenu.hidden;
    workspaceMenu.hidden = !nextOpen;
    workspaceSwitcher.setAttribute("aria-expanded", nextOpen ? "true" : "false");
    if (nextOpen) {
      positionWorkspaceMenu();
      void loadAdapters().then(positionWorkspaceMenu).catch(function () {});
    }
  }

  function setSettingsOpen(open, updateUrl) {
    var nextOpen = Boolean(open);
    if (nextOpen && state.boardOpen) setTaskBoardOpen(false, false);
    state.settingsOpen = nextOpen;
    app.classList.toggle("settings-open", state.settingsOpen);
    settingsView.hidden = !state.settingsOpen;
    settingsOpen.classList.toggle("is-active", state.settingsOpen);
    settingsOpen.setAttribute("aria-pressed", state.settingsOpen ? "true" : "false");
    toggleWorkspaceMenu(false);
    closeTaskContextMenu();
    closeModelMenu();
    closeReasoningMenu();
    if (updateUrl) {
      var url = new URL(window.location.href);
      if (state.settingsOpen) {
        url.searchParams.set("view", "settings");
        url.searchParams.delete("board");
      } else if (url.searchParams.get("view") === "settings") {
        url.searchParams.delete("view");
      }
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    if (state.settingsOpen) {
      closeSidebar();
      settingsBody.innerHTML = "";
      var loading = document.createElement("div");
      loading.className = "settings-loading";
      loading.textContent = "正在读取设置…";
      settingsBody.appendChild(loading);
      void loadSettings();
    } else if (settingsRefreshTimer) {
      clearTimeout(settingsRefreshTimer);
      settingsRefreshTimer = null;
    }
    updateActiveDocumentTitle();
  }

  function settingsCapabilitySummary(capabilities) {
    var labels = {
      sessions: "任务",
      messages: "消息",
      images: "图片",
      queue: "排队",
      approvals: "审批",
      stop: "停止",
      nativeCommands: "原生命令",
    };
    return Object.keys(labels).filter(function (key) {
      return capabilities && capabilities[key];
    }).map(function (key) { return labels[key]; }).join("、");
  }

  function settingsHasInstallingProvider(payload) {
    return Boolean(payload && Array.isArray(payload.providers) && payload.providers.some(function (provider) {
      return provider.status === "installing" || (provider.dependencies || []).some(function (dep) {
        return dep.status === "installing";
      });
    }));
  }

  function scheduleSettingsRefresh() {
    if (settingsRefreshTimer) clearTimeout(settingsRefreshTimer);
    settingsRefreshTimer = setTimeout(function () {
      settingsRefreshTimer = null;
      if (state.settingsOpen) void loadSettings();
    }, 1600);
  }

  async function installSettingsDependency(provider, dependency, button) {
    var confirmed = window.confirm(
      "将在这台电脑上安装“" + (dependency.label || dependency.name) + "”。安装命令由 WeRelay 预先定义，网页不能提交任意命令。是否继续？"
    );
    if (!confirmed) return;
    button.disabled = true;
    button.textContent = "正在安装…";
    try {
      var result = await api(
        "/api/settings/providers/" + encodeURIComponent(provider.id) + "/install",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dependencyId: dependency.id })
        }
      );
      showToast(result.message || "安装已开始");
      await loadSettings();
      scheduleSettingsRefresh();
    } catch (error) {
      button.disabled = false;
      button.textContent = dependency.action && dependency.action.label || "一键安装";
      showToast(error && error.message ? error.message : "无法开始安装");
    }
  }

  function renderSettings(payload) {
    settingsBody.innerHTML = "";
    if (!payload || !Array.isArray(payload.providers)) {
      var empty = document.createElement("div");
      empty.className = "settings-loading";
      empty.textContent = "暂无可用的设置信息。";
      settingsBody.appendChild(empty);
      return;
    }

    // 审批设置
    var rulesSection = document.createElement("div");
    rulesSection.className = "settings-section";
    var rulesTitle = document.createElement("div");
    rulesTitle.className = "settings-section-title";
    rulesTitle.textContent = "审批设置";
    rulesSection.appendChild(rulesTitle);

    var strictToggle = document.createElement("div");
    strictToggle.className = "settings-toggle-row";
    var strictLabelWrap = document.createElement("div");
    strictLabelWrap.className = "settings-toggle-label";
    strictLabelWrap.innerHTML = "严格审批<small>所有审批请求都交给远程端确认，不自动通过。切换后立即生效，重启后恢复环境变量默认值。</small>";
    var strictToggleBtn = document.createElement("button");
    strictToggleBtn.type = "button";
    strictToggleBtn.className = "settings-toggle" + (payload.strictApproval ? " is-on" : "");
    strictToggleBtn.setAttribute("role", "switch");
    strictToggleBtn.setAttribute("aria-checked", payload.strictApproval ? "true" : "false");
    strictToggleBtn.title = "切换后立即生效（本机运行时覆盖，重启后恢复环境变量默认值）";
    strictToggleBtn.addEventListener("click", function () {
      var next = !payload.strictApproval;
      strictToggleBtn.disabled = true;
      void api("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strictApproval: next }),
      }).then(function (updated) {
        strictToggleBtn.disabled = false;
        if (updated && typeof updated.strictApproval === "boolean") {
          payload.strictApproval = updated.strictApproval;
          strictToggleBtn.classList.toggle("is-on", payload.strictApproval);
          strictToggleBtn.setAttribute("aria-checked", payload.strictApproval ? "true" : "false");
        }
      }).catch(function (error) {
        strictToggleBtn.disabled = false;
        showToast(error && error.message ? error.message : "设置保存失败");
      });
    });
    strictToggle.appendChild(strictLabelWrap);
    strictToggle.appendChild(strictToggleBtn);
    rulesSection.appendChild(strictToggle);

    if (Array.isArray(payload.approvalRules) && payload.approvalRules.length > 0) {
      var rulesList = document.createElement("ul");
      rulesList.className = "settings-rule-list";
      payload.approvalRules.forEach(function (rule) {
        var item = document.createElement("li");
        item.className = "settings-rule-item";
        var dot = document.createElement("span");
        dot.className = "settings-rule-dot";
        var label = document.createElement("span");
        label.className = "settings-rule-label";
        label.textContent = rule.label || rule.id;
        var desc = document.createElement("span");
        desc.className = "settings-rule-desc";
        desc.textContent = rule.description || "";
        item.appendChild(dot);
        item.appendChild(label);
        item.appendChild(desc);
        rulesList.appendChild(item);
      });
      rulesSection.appendChild(rulesList);
    }
    settingsBody.appendChild(rulesSection);

    // 电脑终端与真实依赖状态
    var providersSection = document.createElement("div");
    providersSection.className = "settings-section";
    var providersTitle = document.createElement("div");
    providersTitle.className = "settings-section-title";
    providersTitle.textContent = "电脑终端";
    providersSection.appendChild(providersTitle);
    var providersNote = document.createElement("div");
    providersNote.className = "settings-note";
    providersNote.textContent = "这里显示电脑上的真实检测结果。已安装但未启动，与尚未安装会分别说明。";
    providersSection.appendChild(providersNote);

    payload.providers.forEach(function (provider) {
      var block = document.createElement("div");
      block.className = "settings-provider";
      var head = document.createElement("div");
      head.className = "settings-provider-head";
      var name = document.createElement("span");
      name.className = "settings-provider-name";
      name.textContent = provider.label || provider.id;
      var status = document.createElement("span");
      status.className = "settings-provider-status is-" + (provider.status || "unavailable");
      status.textContent = provider.statusLabel || "状态未知";
      head.appendChild(name);
      head.appendChild(status);
      block.appendChild(head);

      var source = document.createElement("div");
      source.className = "settings-provider-source";
      source.textContent = provider.sessionSource || "连接电脑上的真实任务。";
      block.appendChild(source);

      var capabilitySummary = settingsCapabilitySummary(provider.capabilities);
      if (capabilitySummary) {
        var caps = document.createElement("div");
        caps.className = "settings-provider-capabilities";
        caps.textContent = "支持：" + capabilitySummary;
        block.appendChild(caps);
      }

      if (Array.isArray(provider.dependencies) && provider.dependencies.length > 0) {
        var deps = document.createElement("div");
        deps.className = "settings-provider-deps";
        provider.dependencies.forEach(function (dep) {
          var line = document.createElement("div");
          line.className = "settings-dep-line is-" + (dep.status || "missing");
          var main = document.createElement("div");
          main.className = "settings-dep-main";
          var dot = document.createElement("span");
          dot.className = "settings-dep-dot";
          var depLabel = document.createElement("span");
          depLabel.className = "settings-dep-label";
          depLabel.textContent = dep.label || dep.name;
          var depStatus = document.createElement("span");
          depStatus.className = "settings-dep-status";
          depStatus.textContent = dep.statusLabel || "状态未知";
          main.appendChild(dot);
          main.appendChild(depLabel);
          main.appendChild(depStatus);
          line.appendChild(main);

          if (dep.detail) {
            var detail = document.createElement("div");
            detail.className = "settings-dep-detail";
            detail.textContent = dep.detail;
            line.appendChild(detail);
          }

          if (dep.action) {
            var actions = document.createElement("div");
            actions.className = "settings-dep-actions";
            var action = document.createElement("button");
            action.type = "button";
            action.className = "settings-dep-action" + (dep.action.type === "install" ? " is-primary" : "");
            action.textContent = dep.action.label;
            action.addEventListener("click", function () {
              if (dep.action.type === "install") {
                void installSettingsDependency(provider, dep, action);
                return;
              }
              line.classList.toggle("is-expanded");
              action.textContent = line.classList.contains("is-expanded") ? "收起" : dep.action.label;
            });
            actions.appendChild(action);
            line.appendChild(actions);
          }
          deps.appendChild(line);
        });
        block.appendChild(deps);
      }
      providersSection.appendChild(block);
    });
    settingsBody.appendChild(providersSection);
  }

  async function loadSettings() {
    try {
      var payload = await api("/api/settings");
      if (!state.settingsOpen) return;
      renderSettings(payload);
      if (settingsHasInstallingProvider(payload)) scheduleSettingsRefresh();
    } catch (error) {
      if (!state.settingsOpen) return;
      settingsBody.innerHTML = "";
      var failed = document.createElement("div");
      failed.className = "settings-loading";
      failed.textContent = "设置读取失败：" + (error && error.message ? error.message : "未知错误");
      settingsBody.appendChild(failed);
    }
  }

  async function loadTasks(initial) {
    if (!state.authenticated) return;
    var requestId = ++state.taskRequestId;
    state.loadingTasks = true;
    renderTasks();
    updateHeader();
    try {
      var payload = await api(adapterApiPath("/api/tasks"));
      if (requestId !== state.taskRequestId || !state.authenticated) return;
      var hadAdapterError = Boolean(state.adapterError);
      state.adapterError = "";
      var previousCurrentTask = state.tasks.find(function (task) {
        return task.threadId === state.currentThreadId;
      }) || null;
      var localTasks = state.tasks.filter(isTemporaryTask);
      var rememberedLocalTask = currentLocalTaskDraft();
      if (rememberedLocalTask && !localTasks.some(function (task) {
        return task.threadId === rememberedLocalTask.threadId;
      })) localTasks.push(rememberedLocalTask);
      state.tasks = mergeTasksWithLocalDrafts(payload.tasks || [], localTasks);
      if (
        previousCurrentTask &&
        !state.tasks.some(function (task) { return task.threadId === previousCurrentTask.threadId; })
      ) state.tasks.push(previousCurrentTask);
      syncCurrentAdapterStatusFromTasks();
      var url = new URL(window.location.href);
      var requested = initial ? (url.searchParams.get("task") || "") : "";
      var chosen = null;
      if (requested) chosen = resolveTaskSelector(state.tasks, requested);
      if (!chosen && state.currentThreadId) {
        chosen = state.tasks.find(function (task) { return task.threadId === state.currentThreadId; });
      }
      var keepDirectTask = Boolean(
        state.currentThreadId && !chosen && (
          !initial || requested && state.currentThreadId === requested
        )
      );
      if (!chosen && !keepDirectTask) {
        chosen = state.tasks.find(function (task) { return task.selected; }) || state.tasks[0];
      }
      if (initial && chosen && requested !== chosen.threadId) {
        var canonicalUrl = new URL(window.location.href);
        canonicalUrl.searchParams.set("adapter", state.currentAdapter);
        canonicalUrl.searchParams.set("task", chosen.threadId);
        history.replaceState(null, "", canonicalUrl.pathname + canonicalUrl.search + canonicalUrl.hash);
      }
      renderTasks();
      if (chosen && chosen.threadId !== state.currentThreadId) {
        await selectTask(chosen.threadId, false);
      } else {
        if (hadAdapterError) renderMessages(false);
        if (!chosen && !state.currentThreadId) renderMessages(false);
        updateHeader();
      }
      state.nextTaskRefreshAtMs = Date.now() + TASK_REFRESH_INTERVAL_MS;
      rememberCurrentTaskSnapshot();
      schedulePersistentMobileCacheWrite();
    } catch (error) {
      if (requestId !== state.taskRequestId || error.status === 401) return;
      if (error.network && !initial && state.tasks.length) {
        state.nextTaskRefreshAtMs = Date.now() + TASK_REFRESH_INTERVAL_MS;
        return;
      }
      var nextError = error.message || "任务列表读取失败";
      var errorChanged = nextError !== state.adapterError;
      state.adapterError = nextError;
      if (!state.currentThreadId) {
        state.tasks = [];
        state.serverMessages = [];
        state.historyMessages = [];
        state.latestMessages = [];
        state.progressItems = [];
        state.runSummary = null;
        state.pendingApproval = null;
        state.approvalResults = [];
      }
      renderTasks();
      renderMessages(false);
      updateHeader();
      if (error.status !== 409 && initial && errorChanged) showToast(nextError);
    } finally {
      if (requestId === state.taskRequestId) {
        state.loadingTasks = false;
        renderTasks();
        updateHeader();
      }
    }
  }

  function syncComposerInset() {
    var composerHeight = composerForm.offsetHeight;
    messagesEl.style.paddingBottom = Math.max(96, composerHeight + 16) + "px";
  }

  function queuedMessageDisplayText(message) {
    var text = String(message && message.text || "").replace(/\s+/g, " ").trim();
    if (text) return text;
    var imageCount = Math.max(0, Number(message && message.imageCount) || 0);
    return imageCount ? "图片 " + imageCount + " 张" : "（空消息）";
  }

  function makeSteeredPendingMessage(message, threadId, transcriptMessages, nowMs) {
    var users = (Array.isArray(transcriptMessages) ? transcriptMessages : []).filter(
      function (candidate) { return candidate && candidate.role === "user"; }
    );
    function baselineKey(candidate) {
      if (candidate && candidate.id) return "id:" + candidate.id;
      return "content:" + [
        candidate && candidate.turnId || "",
        candidate && candidate.role || "",
        candidate && candidate.phase || "",
        candidate && candidate.text || ""
      ].join("\u0000");
    }
    var sourceMessageId = String(message && message.id || "");
    var queuedAtMs = Number(message && message.createdAtMs);
    return {
      clientId: "steered-" + (sourceMessageId || String(nowMs) + "-" + Math.random().toString(36).slice(2, 8)),
      sourceMessageId: sourceMessageId,
      createdAtMs: nowMs,
      queuedAtMs: Number.isFinite(queuedAtMs) ? queuedAtMs : undefined,
      threadId: threadId,
      text: String(message && message.text || ""),
      images: [],
      imageCount: Math.max(0, Number(message && message.imageCount) || 0),
      status: "steered",
      turnId: "",
      queued: false,
      optimisticRun: false,
      displayInTranscript: true,
      baselineUserCount: users.length,
      baselineUserKeys: users.map(baselineKey)
    };
  }

  function mergeQueuedMessagesForDisplay(
    queuedMessages,
    pendingMessages,
    transcriptMessages,
    runSummary
  ) {
    var activeTurnId = runSummary && runSummary.status === "running"
      ? String(runSummary.turnId || "")
      : "";
    var latestActiveUser = (Array.isArray(transcriptMessages) ? transcriptMessages : [])
      .slice()
      .reverse()
      .find(function (message) {
        return message && message.role === "user" &&
          (!activeTurnId || !message.turnId || message.turnId === activeTurnId);
      });
    var activeUserText = latestActiveUser
      ? String(latestActiveUser.text || "").replace(/\s+/g, " ").trim()
      : "";
    var activeStartedAtMs = runSummary && Number(runSummary.startedAtMs);
    var consumedMatchHidden = false;
    var confirmed = (Array.isArray(queuedMessages) ? queuedMessages : []).filter(
      function (message) {
        if (!activeUserText || consumedMatchHidden) return true;
        var queuedText = String(message && message.text || "")
          .replace(/\s+/g, " ").trim();
        if (queuedText !== activeUserText) return true;
        var createdAtMs = Number(message && message.createdAtMs);
        var wasQueuedBeforeTurn = Number.isFinite(activeStartedAtMs) &&
          Number.isFinite(createdAtMs) &&
          createdAtMs <= activeStartedAtMs;
        if (!wasQueuedBeforeTurn) return true;
        consumedMatchHidden = true;
        return false;
      }
    );
    var confirmedIds = {};
    confirmed.forEach(function (message) { confirmedIds[message.id] = true; });
    var optimistic = (Array.isArray(pendingMessages) ? pendingMessages : []).flatMap(
      function (pending) {
        if (
          pending.displayInTranscript ||
          pending.status === "failed" ||
          pending.status === "sent" ||
          pending.queuedMessageId && confirmedIds[pending.queuedMessageId]
        ) return [];
        var message = {
          id: pending.queuedMessageId || pending.clientId,
          text: pending.text,
          imageCount: pending.imageCount,
          optimistic: true,
          status: pending.status
        };
        if (pending.createdAtMs !== undefined) message.createdAtMs = pending.createdAtMs;
        return [message];
      }
    );
    return confirmed.concat(optimistic);
  }

  async function steerQueuedMessage(messageId) {
    if (!state.currentThreadId || state.queueActionMessageId) return;
    var requestedThreadId = state.currentThreadId;
    var queuedMessage = state.queuedMessages.find(function (message) {
      return message.id === messageId;
    });
    state.queueActionMessageId = messageId;
    renderQueuedMessages(state.queuedMessages);
    try {
      await api(adapterApiPath(
        "/api/tasks/" + encodeURIComponent(requestedThreadId) +
        "/queue/" + encodeURIComponent(messageId) + "/steer"),
        { method: "POST" }
      );
      if (requestedThreadId !== state.currentThreadId) return;
      state.queuedMessages = state.queuedMessages.filter(function (message) {
        return message.id !== messageId;
      });
      if (queuedMessage && !state.pendingMessages.some(function (pending) {
        return pending.sourceMessageId === messageId;
      })) {
        var pending = makeSteeredPendingMessage(
          queuedMessage,
          requestedThreadId,
          state.serverMessages,
          Date.now()
        );
        beginOptimisticRunIfNeeded(pending);
        state.pendingMessages.push(pending);
      }
      state.editingQueuedMessageId = "";
      showToast("已引导到当前任务");
      renderQueuedMessages(state.queuedMessages);
      renderMessages(true);
      saveCurrentConversationSnapshot();
      await loadMessages(false);
    } catch (error) {
      showToast("引导失败：" + (error.message || "请稍后重试"));
    } finally {
      state.queueActionMessageId = "";
      renderQueuedMessages(state.queuedMessages);
    }
  }

  async function deleteQueuedMessage(messageId) {
    if (!state.currentThreadId || state.queueActionMessageId) return;
    state.queueActionMessageId = messageId;
    renderQueuedMessages(state.queuedMessages);
    try {
      await api(adapterApiPath(
        "/api/tasks/" + encodeURIComponent(state.currentThreadId) +
        "/queue/" + encodeURIComponent(messageId)),
        { method: "DELETE" }
      );
      state.queuedMessages = state.queuedMessages.filter(function (message) {
        return message.id !== messageId;
      });
      state.editingQueuedMessageId = "";
      showToast("已删除待发送消息");
      renderQueuedMessages(state.queuedMessages);
      await loadMessages(false);
    } catch (error) {
      showToast("删除失败：" + (error.message || "请稍后重试"));
    } finally {
      state.queueActionMessageId = "";
      renderQueuedMessages(state.queuedMessages);
    }
  }

  function beginQueuedMessageEdit(message) {
    if (!message || message.optimistic || state.queueActionMessageId) return;
    if (composerInput.value.trim() || state.pendingImages.length > 0) {
      showToast("请先发送或清空输入框中的内容");
      composerInput.focus();
      return;
    }
    saveComposerDraft(state.currentAdapter, state.currentThreadId);
    state.editingQueuedMessageId = message.id;
    state.editingQueuedImageCount = Math.max(0, Number(message.imageCount) || 0);
    state.composerRevision += 1;
    composerInput.value = String(message.text || "");
    composerInput.placeholder = "编辑待发送消息";
    composerImageButton.disabled = true;
    renderQueuedMessages(state.queuedMessages);
    resizeComposer();
    composerInput.focus();
    composerInput.setSelectionRange(composerInput.value.length, composerInput.value.length);
  }

  function cancelQueuedMessageEdit() {
    if (!state.editingQueuedMessageId) return;
    state.editingQueuedMessageId = "";
    state.editingQueuedImageCount = 0;
    state.composerRevision += 1;
    restoreComposerDraft(state.currentAdapter, state.currentThreadId);
    composerInput.placeholder = "有问题，尽管问";
    composerImageButton.disabled = false;
    resizeComposer();
    renderQueuedMessages(state.queuedMessages);
  }

  async function submitQueuedMessageEdit(text) {
    var messageId = state.editingQueuedMessageId;
    if (!state.currentThreadId || state.queueActionMessageId) return;
    var message = state.queuedMessages.find(function (item) { return item.id === messageId; });
    if (!message) {
      cancelQueuedMessageEdit();
      showToast("这条待发送消息已经不存在");
      return;
    }
    if (!String(text || "").trim() && state.editingQueuedImageCount === 0) {
      showToast("消息内容不能为空");
      return;
    }
    state.queueActionMessageId = messageId;
    renderQueuedMessages(state.queuedMessages);
    try {
      await api(adapterApiPath(
        "/api/tasks/" + encodeURIComponent(state.currentThreadId) +
        "/queue/" + encodeURIComponent(messageId)),
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: text })
        }
      );
      state.queuedMessages = state.queuedMessages.map(function (item) {
        return item.id === messageId ? Object.assign({}, item, { text: text }) : item;
      });
      state.editingQueuedMessageId = "";
      state.editingQueuedImageCount = 0;
      state.composerRevision += 1;
      restoreComposerDraft(state.currentAdapter, state.currentThreadId);
      composerInput.placeholder = "有问题，尽管问";
      composerImageButton.disabled = false;
      resizeComposer();
      showToast("已重新加入待发送");
      renderQueuedMessages(state.queuedMessages);
      await loadMessages(false);
    } catch (error) {
      showToast("重新发送失败：" + (error.message || "请稍后重试"));
    } finally {
      state.queueActionMessageId = "";
      renderQueuedMessages(state.queuedMessages);
    }
  }

  function queuedMessagesRenderSignature(messages) {
    var latestUser = (Array.isArray(state.serverMessages) ? state.serverMessages : [])
      .slice()
      .reverse()
      .find(function (message) { return message && message.role === "user"; });
    var summary = effectiveRunSummary();
    return JSON.stringify([
      messages,
      latestUser && [latestUser.turnId, latestUser.text],
      summary && [summary.status, summary.turnId]
    ]);
  }

  function renderQueuedMessages(messages) {
    state.queuedMessages = Array.isArray(messages) ? messages : [];
    state.queueSignature = queuedMessagesRenderSignature(state.queuedMessages);
    var visibleMessages = mergeQueuedMessagesForDisplay(
      state.queuedMessages,
      state.pendingMessages,
      state.serverMessages,
      effectiveRunSummary()
    ).filter(function (message) {
      return message.id !== state.editingQueuedMessageId;
    });
    if (
      state.editingQueuedMessageId &&
      !state.queuedMessages.some(function (message) {
        return message.id === state.editingQueuedMessageId;
      })
    ) state.editingQueuedMessageId = "";
    composerQueue.innerHTML = "";
    composerQueue.hidden = visibleMessages.length === 0;
    visibleMessages.forEach(function (message) {
      var item = document.createElement("div");
      item.className = "queued-followup";
      item.setAttribute("data-queued-message-id", message.id);
      var optimistic = Boolean(message.optimistic);
      var busy = state.queueActionMessageId === message.id;
      if (optimistic) {
        item.classList.add("is-pending");
        item.setAttribute("aria-busy", "true");
      }

      var main = document.createElement("div");
      main.className = "queued-followup-main";
      var icon = document.createElement("span");
      icon.className = "queued-followup-icon";
      icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h9a4 4 0 0 1 4 4v1M18 7l-3-3m3 3-3 3M19 17h-9a4 4 0 0 1-4-4v-1M6 17l3 3m-3-3 3-3"/></svg>';
      var copy = document.createElement("div");
      copy.className = "queued-followup-copy";
      var textEl = document.createElement("div");
      textEl.className = "queued-followup-text";
      textEl.textContent = queuedMessageDisplayText(message);
      copy.appendChild(textEl);
      var status = document.createElement("div");
      status.className = "queued-followup-status" + (optimistic ? " is-pending" : "");
      status.textContent = optimistic
        ? "正在加入待发送…"
        : busy
          ? "正在更新…"
          : "已排队 · 等待当前任务完成";
      copy.appendChild(status);
      if (Number(message.imageCount) > 0 && String(message.text || "").trim()) {
        var imageMeta = document.createElement("div");
        imageMeta.className = "queued-followup-images";
        imageMeta.textContent = "图片 " + Number(message.imageCount) + " 张";
        copy.appendChild(imageMeta);
      }

      var actions = document.createElement("div");
      actions.className = "queued-followup-actions";
      var steer = document.createElement("button");
      steer.type = "button";
      steer.className = "queued-followup-action steer-action";
      steer.disabled = optimistic || Boolean(state.queueActionMessageId);
      steer.setAttribute("aria-label", "引导这条消息");
      steer.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h12M13 8l4 4-4 4"/></svg><span class="queued-followup-action-label steer-label">引导</span>';
      steer.addEventListener("click", function () { void steerQueuedMessage(message.id); });
      var edit = document.createElement("button");
      edit.type = "button";
      edit.className = "queued-followup-action";
      edit.disabled = optimistic || Boolean(state.queueActionMessageId);
      edit.setAttribute("aria-label", "编辑这条消息");
      edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 19 3.5-.8L18 8.7 15.3 6 5.8 15.5 5 19Z"/><path d="m13.8 7.5 2.7 2.7"/></svg><span class="queued-followup-action-label">编辑</span>';
      edit.addEventListener("click", function () {
        beginQueuedMessageEdit(message);
      });
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "queued-followup-action";
      remove.disabled = optimistic || Boolean(state.queueActionMessageId);
      remove.setAttribute("aria-label", "删除这条消息");
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>';
      remove.addEventListener("click", function () { void deleteQueuedMessage(message.id); });
      if (busy) steer.setAttribute("aria-busy", "true");
      actions.appendChild(steer);
      actions.appendChild(edit);
      actions.appendChild(remove);
      actions.hidden = optimistic;

      main.appendChild(icon);
      main.appendChild(copy);
      main.appendChild(actions);
      item.appendChild(main);

      composerQueue.appendChild(item);
    });
    requestAnimationFrame(syncComposerInset);
  }

  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  }

  function scrollToLatest(smooth) {
    if (smooth) {
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
      return;
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function resolveUserMessageNavigation(offsets, scrollTop, targetInset) {
    var anchor = Math.max(0, Number(scrollTop) || 0) + Math.max(0, Number(targetInset) || 0);
    var currentIndex = offsets.findIndex(function (offset) {
      return Math.abs(offset - anchor) <= 24;
    });
    if (currentIndex >= 0) {
      return {
        previousIndex: currentIndex - 1,
        nextIndex: currentIndex + 1 < offsets.length ? currentIndex + 1 : -1,
      };
    }
    var previousIndex = -1;
    var nextIndex = -1;
    offsets.some(function (offset, index) {
      if (offset > anchor) {
        nextIndex = index;
        return true;
      }
      previousIndex = index;
      return false;
    });
    return { previousIndex: previousIndex, nextIndex: nextIndex };
  }

  function userMessageNavigationTargetInset() {
    var topbar = document.querySelector(".topbar");
    if (topbar && window.getComputedStyle(topbar).position === "absolute") {
      return Math.max(64, topbar.offsetHeight + 12);
    }
    return 24;
  }

  function updateUserMessageNavigation() {
    var userRows = Array.prototype.slice.call(
      messagesEl.querySelectorAll(".message-row.user")
    );
    if (!userRows.length) {
      messageNavigation.hidden = true;
      previousUserMessage.hidden = true;
      nextUserMessage.hidden = true;
      return;
    }
    var targetInset = userMessageNavigationTargetInset();
    var navigation = resolveUserMessageNavigation(
      userRows.map(function (row) { return row.offsetTop; }),
      messagesEl.scrollTop,
      targetInset
    );
    previousUserMessage.hidden = navigation.previousIndex < 0;
    nextUserMessage.hidden = navigation.nextIndex < 0;
    previousUserMessage.dataset.messageIndex = String(navigation.previousIndex);
    nextUserMessage.dataset.messageIndex = String(navigation.nextIndex);
    messageNavigation.hidden = previousUserMessage.hidden && nextUserMessage.hidden;
  }

  function navigateToUserMessage(index) {
    var userRows = messagesEl.querySelectorAll(".message-row.user");
    var row = userRows[index];
    if (!row) return;
    messagesEl.scrollTo({
      top: Math.max(0, row.offsetTop - userMessageNavigationTargetInset()),
      behavior: "smooth"
    });
    setTimeout(updateUserMessageNavigation, 260);
  }

  function formatRunDuration(durationMs) {
    var seconds = Math.max(0, Math.floor((Number(durationMs) || 0) / 1000));
    return Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
  }

  function switchProgressLabel(startedAtMs, nowMs) {
    var elapsedMs = Math.max(0, Number(nowMs) - Number(startedAtMs));
    return (elapsedMs >= 10_000 ? "仍在连接" : "连接中") + " · " + formatRunDuration(elapsedMs);
  }

  function effectiveRunSummary() {
    var local = state.localRunSummary;
    var remote = state.runSummary;
    if (local && (
      !remote ||
      remote.status === "unknown" ||
      !remote.turnId ||
      remote.turnId !== local.turnId
    )) return local;
    return remote || local;
  }

  function isTaskActivelyRunning(task) {
    return Boolean(task && (
      task.status === "running" || task.status === "approval" || task.status === "input"
    ));
  }

  function shouldForceLiveMessageRefresh(nowMs) {
    var summary = effectiveRunSummary();
    var taskRunning = isTaskActivelyRunning(currentTask()) ||
      Boolean(summary && summary.status === "running");
    return taskRunning &&
      Number(nowMs) - Number(state.lastLiveMessageRefreshAtMs || 0) >= 5000;
  }

  function filterProgressItemsForCurrentTurn(progressItems, task, summary) {
    var items = Array.isArray(progressItems) ? progressItems : [];
    var currentTurnId = task && task.activeTurnId || summary && summary.turnId;
    if (currentTurnId) {
      return items.filter(function (item) { return item && item.turnId === currentTurnId; });
    }
    if (isTaskActivelyRunning(task) || summary && summary.status === "running") return [];
    return items;
  }

  function filterProgressItemsForOptimisticTurn(progressItems, optimisticTurnId) {
    var items = Array.isArray(progressItems) ? progressItems : [];
    if (optimisticTurnId === null || optimisticTurnId === undefined) return items;
    if (!optimisticTurnId) return [];
    return items.filter(function (item) {
      return item && item.turnId === optimisticTurnId;
    });
  }

  function resolveVisibleRunSummary(messages, task, summary, nowMs, progressItems) {
    var latestAssistant = null;
    var latestAssistantIndex = -1;
    var latestUser = null;
    var latestUserIndex = -1;
    for (var index = messages.length - 1; index >= 0; index -= 1) {
      if (!latestAssistant && messages[index].role === "assistant") {
        latestAssistant = messages[index];
        latestAssistantIndex = index;
      }
      if (!latestUser && messages[index].role === "user") {
        latestUser = messages[index];
        latestUserIndex = index;
      }
      if (latestAssistant && latestUser) break;
    }
    if (isTaskActivelyRunning(task)) {
      if (summary && summary.status === "running") return summary;
      var startedAtMs = Number(task && task.startedAtMs) ||
        Number(summary && summary.startedAtMs) || nowMs;
      return {
        turnId: task && task.activeTurnId || summary && summary.turnId ||
          latestAssistant && latestAssistant.turnId || undefined,
        status: "running",
        startedAtMs: startedAtMs,
        durationMs: Math.max(0, nowMs - startedAtMs)
      };
    }
    var currentTurnId = task && task.activeTurnId || latestUser && latestUser.turnId || "";
    var runningProgress = (Array.isArray(progressItems) ? progressItems : []).slice().reverse()
      .find(function (item) {
        return item && item.status === "running" &&
          (!currentTurnId || !item.turnId || item.turnId === currentTurnId);
      });
    if (runningProgress) {
      var progressTurnId = runningProgress.turnId || currentTurnId || undefined;
      var summaryMatchesProgress = Boolean(
        summary && (!progressTurnId || !summary.turnId || summary.turnId === progressTurnId)
      );
      var progressStartedAtMs = Number(task && task.startedAtMs) ||
        Number(runningProgress.createdAtMs) ||
        Number(summaryMatchesProgress && summary && summary.startedAtMs) || nowMs;
      return {
        turnId: progressTurnId,
        status: "running",
        startedAtMs: progressStartedAtMs,
        durationMs: Math.max(0, nowMs - progressStartedAtMs)
      };
    }
    if (summary && summary.status !== "running" && latestUser) {
      if (
        summary.turnId &&
        latestUser.turnId &&
        latestUser.turnId !== summary.turnId
      ) return null;
      if (
        latestUserIndex > latestAssistantIndex &&
        (!summary.turnId || !latestUser.turnId || latestUser.turnId !== summary.turnId)
      ) return null;
    }
    return summary || null;
  }

  function shouldUseStopComposerAction(task, summary, hasContent) {
    return Boolean(task && !hasContent && summary && summary.status === "running");
  }

  function runDurationMs(summary) {
    if (!summary) return 0;
    if (summary.status === "running") {
      if (summary.startedAtMs) return Math.max(Number(summary.durationMs) || 0, Date.now() - summary.startedAtMs);
      return (Number(summary.durationMs) || 0) + Math.max(0, Date.now() - (summary.receivedAtMs || Date.now()));
    }
    if (Number(summary.durationMs) > 0) return Number(summary.durationMs);
    if (!summary.completedAtMs || !summary.startedAtMs) return 0;
    return Math.max(0, summary.completedAtMs - summary.startedAtMs);
  }

  function runHeaderLabel(summary, stopping) {
    var duration = formatRunDuration(runDurationMs(summary));
    if (state.pendingApproval) return "等待确认 · " + duration;
    if (summary.status === "running") {
      return (stopping ? "正在停止" : "正在处理") + " · " + duration;
    }
    if (summary.status === "failed") return "处理失败 · " + duration;
    if (summary.status === "interrupted") return "已中断 · " + duration;
    if (summary.status === "completed") return "已完成 · " + duration;
    return "状态同步中 · " + duration;
  }

  function currentPendingDelivery() {
    return state.pendingMessages.find(function (pending) {
      return pending.threadId === state.currentThreadId &&
        (!pending.adapter || pending.adapter === state.currentAdapter) &&
        pending.displayInTranscript !== false &&
        (pending.status === "contacting_computer" ||
          pending.status === "forwarding_to_agent" ||
          pending.status === "sending");
    }) || null;
  }

  function deliveryHeaderLabel(pending) {
    var duration = formatRunDuration(Date.now() - Number(pending.createdAtMs || Date.now()));
    if (pending.status === "forwarding_to_agent") {
      return "电脑正在组织发送给 " + adapterName(pending.adapter || state.currentAdapter) + " · " + duration;
    }
    return "正在尝试发送给电脑 · " + duration;
  }

  function renderDeliveryHeader(pending) {
    var row = document.createElement("div");
    row.className = "run-header sending";
    row.id = "delivery-header";
    row.innerHTML = '<span class="run-header-dot"></span><span class="run-header-label">' +
      escapeHtml(deliveryHeaderLabel(pending)) + "</span>";
    return row;
  }

  function renderRunHeader(summary) {
    var row = document.createElement("div");
    var stopping = summary.status === "running" &&
      state.stopRequestedThreadId === state.currentThreadId;
    row.className = "run-header " + (state.pendingApproval ? "approval" : (summary.status || "unknown"));
    row.id = "run-header";
    row.innerHTML = '<span class="run-header-dot"></span><span class="run-header-label">' +
      escapeHtml(runHeaderLabel(summary, stopping)) + "</span>";
    return row;
  }

  function runFailureText(summary) {
    if (!summary || summary.status !== "failed") return "";
    var detail = typeof summary.errorMessage === "string"
      ? summary.errorMessage.trim()
      : "任务执行失败，未生成 AI 回复。请重试。";
    return detail || "任务执行失败，未生成 AI 回复。请重试。";
  }

  function runFailureTitle(summary) {
    var detail = runFailureText(summary);
    return /模型.*繁忙/.test(detail) ? "模型暂时繁忙" : "未生成 AI 回复";
  }

  function renderRunFailure(summary) {
    var detail = runFailureText(summary);
    if (!detail) return null;
    var row = document.createElement("div");
    row.className = "run-failure";
    row.setAttribute("role", "alert");
    row.innerHTML = '<div class="run-failure-title">' +
      escapeHtml(runFailureTitle(summary)) + '</div>' +
      '<div class="run-failure-detail">' + escapeHtml(detail) + "</div>";
    return row;
  }

  function partitionProgressItems(progressItems) {
    var items = Array.isArray(progressItems) ? progressItems.filter(Boolean) : [];
    var plans = items.filter(function (item) { return item.kind === "plan"; });
    var pinned = plans.length > 0 ? [plans[plans.length - 1]] : [];
    var activity = items.filter(function (item) { return item.kind !== "plan"; });
    var visibleSet = new Set(activity.filter(function (item) {
      return item.status !== "completed";
    }));
    activity.filter(function (item) {
      return item.status === "completed";
    }).slice(-3).forEach(function (item) {
      visibleSet.add(item);
    });
    return {
      pinned: pinned,
      hidden: activity.filter(function (item) { return !visibleSet.has(item); }),
      visible: activity.filter(function (item) { return visibleSet.has(item); })
    };
  }

  function renderProgressItemHtml(item) {
    var status = item && (item.status === "running" || item.status === "failed")
      ? item.status
      : "completed";
    return '<div class="run-progress-item ' + status + '">' +
      '<span class="run-progress-dot" aria-hidden="true"></span>' +
      '<span class="run-progress-text">' + escapeHtml(item && item.text || currentAdapterName() + " 正在处理") + "</span>" +
    "</div>";
  }

  function renderProgressList(progressItems) {
    if (!Array.isArray(progressItems) || progressItems.length === 0) return null;
    var list = document.createElement("section");
    list.className = "run-progress";
    list.setAttribute("aria-label", currentAdapterName() + " 处理进展");
    var groups = partitionProgressItems(progressItems);
    var hiddenHtml = groups.hidden.length > 0
      ? '<details class="run-progress-history"><summary><span>之前 ' + groups.hidden.length + ' 条进展</span>' +
        '<span class="run-progress-fold-action"><span class="run-progress-fold-closed">展开</span>' +
        '<span class="run-progress-fold-open">收起</span></span></summary>' +
        '<div class="run-progress-history-items">' + groups.hidden.map(renderProgressItemHtml).join("") + "</div></details>"
      : "";
    list.innerHTML = groups.pinned.map(renderProgressItemHtml).join("") + hiddenHtml +
      groups.visible.map(renderProgressItemHtml).join("");
    return list;
  }

  function renderApprovalCard(approval) {
    var card = document.createElement("section");
    card.className = "approval-card";
    card.id = "pending-approval";
    var detail = approval.detailPreview || approval.commandPreview || "";
    var detailLabel = approval.detailLabel || (approval.toolName ? "请求使用 " + approval.toolName : "请求执行的操作");
    var sessionButton = approval.allowForSession
      ? '<button class="approval-action" type="button" data-approval-action="confirm_session">本任务始终允许</button>'
      : "";
    card.innerHTML =
      '<div class="approval-card-kicker">需要你的确认</div>' +
      '<div class="approval-card-title">' + escapeHtml(approval.summary || currentAdapterName() + " 请求执行一项操作。") + "</div>" +
      (detail
        ? '<div class="approval-card-detail"><div class="approval-card-detail-label">' + escapeHtml(detailLabel) + '</div><pre>' + escapeHtml(detail) + "</pre></div>"
        : "") +
      '<div class="approval-card-hint">' + escapeHtml(currentAdapterName()) + " 正在等待你的决定，确认后才会继续处理。</div>" +
      '<div class="approval-card-actions">' +
        '<button class="approval-action danger" type="button" data-approval-action="deny">拒绝</button>' +
        sessionButton +
        '<button class="approval-action primary" type="button" data-approval-action="confirm">允许本次</button>' +
      "</div>";
    Array.prototype.forEach.call(card.querySelectorAll("[data-approval-action]"), function (button) {
      button.disabled = state.resolvingApproval;
      button.addEventListener("click", function () {
        resolvePendingApproval(button.getAttribute("data-approval-action"));
      });
    });
    return card;
  }

  function approvalResultTitle(action) {
    if (action === "deny") return "已拒绝此操作";
    if (action === "confirm_session") return "本任务后续同类操作已允许";
    if (action === "confirm_task") return "已按本任务免审允许";
    return "已允许本次操作";
  }

  function timelineOccurredAtMs(value, fallbackField) {
    var direct = Number(value && value.createdAtMs);
    if (Number.isFinite(direct)) return direct;
    var fallback = value && value[fallbackField];
    if (typeof fallback === "string") {
      var parsed = Date.parse(fallback);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  function timelineFallbackRank(kind) {
    if (kind === "message") return 0;
    if (kind === "progress") return 1;
    if (kind === "approval-result") return 2;
    return 3;
  }

  function buildConversationTimeline(params) {
    var messages = Array.isArray(params && params.messages) ? params.messages : [];
    var results = Array.isArray(params && params.approvalResults) ? params.approvalResults : [];
    var progressItems = Array.isArray(params && params.progressItems) ? params.progressItems : [];
    var pendingApproval = params && params.pendingApproval || null;
    var items = [];
    var sequence = 0;

    var fallbackTurnId = "";
    messages.forEach(function (message, messageIndex) {
      var explicitTurnId = message && message.turnId || "";
      if (message && message.role === "user" && explicitTurnId) fallbackTurnId = explicitTurnId;
      var effectiveTurnId = explicitTurnId || fallbackTurnId;
      if (explicitTurnId) fallbackTurnId = explicitTurnId;
      items.push({
        kind: "message",
        message: message,
        messageIndex: messageIndex,
        turnId: effectiveTurnId,
        occurredAtMs: timelineOccurredAtMs(message, "createdAt"),
        anchorIndex: messageIndex,
        fallbackOrder: messageIndex * 10,
        sequence: sequence++
      });
    });
    progressItems.forEach(function (progressItem, progressIndex) {
      items.push({
        kind: "progress",
        progressItem: progressItem,
        turnId: progressItem && progressItem.turnId || "",
        occurredAtMs: timelineOccurredAtMs(progressItem, "createdAt"),
        anchorIndex: messages.length,
        fallbackOrder: progressIndex * 10 + 1,
        sequence: sequence++
      });
    });
    var loadedMessageTurnIds = new Set(items.filter(function (item) {
      return item.kind === "message" && item.turnId;
    }).map(function (item) { return item.turnId; }));
    var timestampedMessages = items.filter(function (item) {
      return item.kind === "message" && item.occurredAtMs !== null;
    });
    var earliestLoadedMessageAtMs = timestampedMessages.length
      ? Math.min.apply(null, timestampedMessages.map(function (item) { return item.occurredAtMs; }))
      : null;
    results.forEach(function (approvalResult, resultIndex) {
      var requestedAtMs = timelineOccurredAtMs(approvalResult, "requestedAt");
      var resolvedAtMs = timelineOccurredAtMs(approvalResult, "resolvedAt");
      var occurredAtMs = requestedAtMs !== null ? requestedAtMs : resolvedAtMs;
      var approvalTurnId = approvalResult && approvalResult.turnId || "";
      if (
        approvalTurnId &&
        loadedMessageTurnIds.size > 0 &&
        !loadedMessageTurnIds.has(approvalTurnId)
      ) return;
      if (
        loadedMessageTurnIds.size === 0 &&
        occurredAtMs !== null &&
        earliestLoadedMessageAtMs !== null &&
        occurredAtMs < earliestLoadedMessageAtMs
      ) return;
      items.push({
        kind: "approval-result",
        approvalResult: approvalResult,
        turnId: approvalTurnId,
        occurredAtMs: occurredAtMs,
        anchorIndex: messages.length,
        fallbackOrder: resultIndex * 10 + 2,
        sequence: sequence++
      });
    });
    if (pendingApproval) {
      items.push({
        kind: "pending-approval",
        pendingApproval: pendingApproval,
        turnId: pendingApproval.turnId || "",
        occurredAtMs: timelineOccurredAtMs(pendingApproval, "createdAt"),
        anchorIndex: messages.length,
        fallbackOrder: Number.MAX_SAFE_INTEGER,
        sequence: sequence++
      });
    }

    function turnBounds(turnId) {
      var first = -1;
      var last = -1;
      items.forEach(function (item) {
        if (item.kind !== "message" || item.turnId !== turnId) return;
        if (first < 0) first = item.messageIndex;
        last = item.messageIndex;
      });
      return { first: first, last: last };
    }
    items.forEach(function (item) {
      if (item.kind === "message" || !item.turnId) return;
      var bounds = turnBounds(item.turnId);
      if (bounds.first < 0) return;
      item.anchorIndex = bounds.last;
      item.fallbackOrder = bounds.last * 10 + timelineFallbackRank(item.kind);
    });

    return items.sort(function (left, right) {
      if (
        left.occurredAtMs !== null &&
        right.occurredAtMs !== null &&
        left.occurredAtMs !== right.occurredAtMs
      ) {
        return left.occurredAtMs - right.occurredAtMs;
      }
      if (left.anchorIndex !== right.anchorIndex) return left.anchorIndex - right.anchorIndex;
      if (left.occurredAtMs !== null && right.occurredAtMs !== null) {
        if (left.occurredAtMs !== right.occurredAtMs) return left.occurredAtMs - right.occurredAtMs;
      } else if (left.occurredAtMs !== null) {
        return -1;
      } else if (right.occurredAtMs !== null) {
        return 1;
      }
      if (left.fallbackOrder !== right.fallbackOrder) return left.fallbackOrder - right.fallbackOrder;
      return left.sequence - right.sequence;
    });
  }

  function renderApprovalResult(result) {
    var card = document.createElement("section");
    var denied = result.action === "deny";
    card.className = "approval-result" + (denied ? " denied" : "");
    card.id = "approval-result-" + (result.id || "resolved");
    card.setAttribute("role", "status");
    var detail = result.detailPreview || result.commandPreview || "";
    var detailLabel = result.detailLabel || "审批操作";
    card.innerHTML =
      '<div class="approval-result-heading"><span class="approval-result-icon" aria-hidden="true">' +
        (denied ? "×" : "✓") + '</span><span>' + escapeHtml(approvalResultTitle(result.action)) + "</span></div>" +
      (result.summary
        ? '<div class="approval-result-summary">' + escapeHtml(result.summary) + "</div>"
        : "") +
      (detail
        ? '<div class="approval-result-detail"><div class="approval-result-detail-label">' + escapeHtml(detailLabel) + '</div><pre>' + escapeHtml(detail) + "</pre></div>"
        : "");
    return card;
  }

  async function resolvePendingApproval(action) {
    if (state.resolvingApproval || !state.currentThreadId || !state.pendingApproval) return;
    state.resolvingApproval = true;
    renderMessages(false);
    try {
      var payload = await api(adapterApiPath("/api/tasks/" + encodeURIComponent(state.currentThreadId) + "/approval"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: action })
      });
      if (payload.result) {
        state.approvalResults = state.approvalResults
          .filter(function (result) { return result.id !== payload.result.id; })
          .concat([payload.result])
          .sort(function (left, right) {
            return Date.parse(left.resolvedAt || "") - Date.parse(right.resolvedAt || "");
          });
      }
      state.pendingApproval = null;
      showToast(action === "deny"
        ? "已拒绝，" + currentAdapterName() + " 将停止这项操作"
        : "已允许，" + currentAdapterName() + " 继续处理");
      renderMessages(false);
      setTimeout(function () { loadMessages(false); }, 180);
    } catch (error) {
      if (error.network) {
        showToast("审批状态暂未确认，正在同步…");
        setTimeout(function () { loadMessages(false); }, 500);
      } else {
        showToast(error.message || "权限处理失败，请重试");
        loadMessages(false);
      }
    } finally {
      state.resolvingApproval = false;
      renderMessages(false);
    }
  }

  function updateRunHeaderClock() {
    if (state.switchingAdapter) {
      updateHeader();
    }
    var delivery = currentPendingDelivery();
    var deliveryHeader = document.getElementById("delivery-header");
    if (deliveryHeader && delivery) {
      var deliveryLabel = deliveryHeader.querySelector(".run-header-label");
      if (deliveryLabel) deliveryLabel.textContent = deliveryHeaderLabel(delivery);
    }
    var header = document.getElementById("run-header");
    var messages = filterVisibleConversationMessages(state.serverMessages).concat(visiblePendingMessages().map(function (pending) {
      return Object.assign({ role: "user", pending: true }, pending);
    }));
    var summary = resolveVisibleRunSummary(
      messages,
      currentTask(),
      effectiveRunSummary(),
      Date.now(),
      state.progressItems
    );
    renderPermissionControl();
    if (!header || !summary) return;
    var label = header.querySelector(".run-header-label");
    if (label) {
      label.textContent = runHeaderLabel(
        summary,
        state.stopRequestedThreadId === state.currentThreadId
      );
    }
  }

  function reconcilePendingMessages(messages) {
    var users = messages.filter(function (message) { return message.role === "user"; });
    var used = {};

    function userMessageKey(message) {
      if (message && message.id) return "id:" + message.id;
      return "content:" + [
        message && message.turnId || "",
        message && message.role || "",
        message && message.phase || "",
        message && message.text || ""
      ].join("\u0000");
    }

    function matchesPendingText(message, pending) {
      var actual = String(message && message.text || "").trim();
      var expected = String(pending && pending.text || "").trim();
      if (actual === expected) return true;
      if (!(pending && pending.imageCount > 0)) return false;
      var withoutImages = actual.split("\n").filter(function (line) {
        return line.trim().toLowerCase() !== "[image]";
      }).join("\n").trim();
      return withoutImages === expected;
    }

    state.pendingMessages = state.pendingMessages.filter(function (pending) {
      var baselineKeys = Array.isArray(pending.baselineUserKeys)
        ? new Set(pending.baselineUserKeys)
        : null;
      var matchIndex = -1;
      if (pending.sourceMessageId) {
        matchIndex = users.findIndex(function (message, index) {
          return !used[index] && String(message && message.id || "") === pending.sourceMessageId;
        });
      }
      if (matchIndex < 0 && pending.turnId) {
        matchIndex = users.findIndex(function (message, index) {
          return !used[index] && message.turnId === pending.turnId;
        });
      }
      if (matchIndex < 0) {
        matchIndex = users.findIndex(function (message, index) {
          if (used[index] || !matchesPendingText(message, pending)) return false;
          if (baselineKeys) return !baselineKeys.has(userMessageKey(message));
          return index >= pending.baselineUserCount;
        });
      }
      if (
        matchIndex < 0 &&
        pending.turnId &&
        pending.imageCount > 0 &&
        !pending.text.trim() &&
        messages.some(function (message) { return message.turnId === pending.turnId; })
      ) {
        return false;
      }
      if (matchIndex < 0) return true;
      var matchedMessage = users[matchIndex];
      if (
        state.optimisticProgressTurnId !== undefined &&
        state.optimisticProgressTurnId !== null &&
        matchedMessage &&
        matchedMessage.turnId
      ) {
        state.optimisticProgressTurnId = matchedMessage.turnId;
      }
      used[matchIndex] = true;
      return false;
    });
  }

  function runHeaderInsertIndex(messages, summary) {
    if (!summary) return -1;
    if (summary.turnId) {
      var exact = messages.findIndex(function (message) {
        return message.role === "assistant" && message.turnId === summary.turnId;
      });
      if (exact >= 0) return exact;
    }
    for (var index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") return index + 1;
    }
    return messages.length;
  }

  function isVisibleConversationMessage(message) {
    if (!message) return false;
    var text = String(message.text || "").trim().toLowerCase();
    if (
      message.role === "assistant" &&
      /^\[(?:tool_use|tool_result)\]$/.test(text)
    ) return false;
    return true;
  }

  function filterVisibleConversationMessages(messages) {
    return (messages || []).filter(isVisibleConversationMessage);
  }

  function visibleMessageText(message) {
    var text = String(message && message.text || "");
    if (!message || message.role !== "user") return text;
    var imageMarker = /(^|\n)\s*图片：\s*png\d+(?:\s+png\d+)*\s*(?=\n|$)|\[image\]|<\/?image\b/i.test(text);
    var cleaned = text
      .replace(/(^|\n)\s*图片：\s*png\d+(?:\s+png\d+)*\s*(?=\n|$)/gi, function (_, prefix) {
        return prefix ? "\n" : "";
      })
      .replace(/\[image\](?:<\/image>)?/gi, "")
      .replace(/<\/?image\b[^>]*>/gi, "")
      .replace(/^\s*\[local image:[^\]]+\]\s*$/gim, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (cleaned) return cleaned;
    var imageCount = Math.max(0, Number(message && message.imageCount) || 0);
    if (message && message.pending && imageCount > 0) {
      return message.status === "steered"
        ? "已引导图片 " + imageCount + " 张"
        : "已发送图片 " + imageCount + " 张";
    }
    return imageMarker ? "已发送图片" : "";
  }

  function visibleMessageModel(message) {
    if (
      !message ||
      message.role !== "assistant" ||
      message.phase === "commentary" ||
      typeof message.model !== "string"
    ) {
      return "";
    }
    return message.model.trim();
  }

  var imageViewer = null;
  var imageViewerImage = null;

  function ensureImageViewer() {
    if (imageViewer) return imageViewer;
    imageViewer = document.createElement("div");
    imageViewer.className = "image-viewer";
    imageViewer.hidden = true;
    imageViewer.setAttribute("role", "dialog");
    imageViewer.setAttribute("aria-modal", "true");
    imageViewer.setAttribute("aria-label", "图片预览");
    imageViewer.innerHTML = '<div class="image-viewer-toolbar">' +
      '<button class="image-viewer-close" type="button">关闭</button></div>' +
      '<div class="image-viewer-stage"></div>';
    imageViewerImage = document.createElement("img");
    imageViewerImage.alt = "";
    imageViewer.querySelector(".image-viewer-stage").appendChild(imageViewerImage);
    document.body.appendChild(imageViewer);
    imageViewer.querySelector(".image-viewer-close").addEventListener("click", closeImageViewer);
    imageViewer.addEventListener("click", function (event) {
      if (event.target === imageViewer || event.target.classList.contains("image-viewer-stage")) {
        closeImageViewer();
      }
    });
    return imageViewer;
  }

  function openImageViewer(url, alt) {
    if (!url) return;
    var viewer = ensureImageViewer();
    imageViewerImage.src = url;
    imageViewerImage.alt = alt || "生成图片";
    viewer.hidden = false;
    document.body.classList.add("image-viewer-open");
    viewer.querySelector(".image-viewer-close").focus();
  }

  function closeImageViewer() {
    if (!imageViewer || imageViewer.hidden) return;
    imageViewer.hidden = true;
    document.body.classList.remove("image-viewer-open");
    if (imageViewerImage) imageViewerImage.removeAttribute("src");
  }

  function renderMessageImages(message) {
    var images = Array.isArray(message && message.images) ? message.images : [];
    var visibleImages = images.map(function (image) {
      var url = typeof image.previewUrl === "string" && image.previewUrl
        ? image.previewUrl
        : typeof image.url === "string"
          ? image.url
          : "";
      if (!url) return "";
      var alt = image.alt || image.fileName || (message.pending ? "待发送图片" : "生成图片");
      return '<button class="message-image-button" type="button" data-open-image="' +
        escapeHtml(url) + '" data-image-alt="' + escapeHtml(alt) + '" aria-label="打开图片：' +
        escapeHtml(alt) + '"><img src="' + escapeHtml(url) + '" alt="' + escapeHtml(alt) +
        '" loading="lazy" decoding="async"><span class="message-image-error">图片加载失败，请刷新后重试</span></button>';
    }).filter(Boolean);
    return visibleImages.length
      ? '<div class="message-images' + (visibleImages.length === 1 ? " single" : "") + '">' +
        visibleImages.join("") + "</div>"
      : "";
  }

  function bindMessageImageActions(row) {
    row.querySelectorAll("[data-open-image]").forEach(function (button) {
      var image = button.querySelector("img");
      if (image) image.addEventListener("error", function () {
        button.classList.add("failed");
        button.disabled = true;
        button.removeAttribute("data-open-image");
      });
      button.addEventListener("click", function () {
        openImageViewer(button.dataset.openImage, button.dataset.imageAlt);
      });
    });
  }

  function messageNodeBaseKey(message) {
    if (message && message.clientId) return "pending:" + message.clientId;
    if (message && message.id) return "message:" + message.id;
    var images = Array.isArray(message && message.images)
      ? message.images.map(function (image) {
          return [
            image && image.previewUrl || "",
            image && image.url || "",
            image && image.path || "",
            image && image.alt || "",
            image && image.fileName || ""
          ];
        })
      : [];
    return "fallback:" + JSON.stringify([
      message && message.turnId || "",
      message && message.role || "",
      message && message.phase || "",
      message && message.model || "",
      message && message.text || "",
      images
    ]);
  }

  function messageNodeKey(message, duplicateIndex) {
    return messageNodeBaseKey(message) + "#" + String(duplicateIndex || 0);
  }

  function stableMessageNodeHash(value) {
    var hash = 2166136261;
    for (var index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function messageContinues(message, nextMessage) {
    return Boolean(
      message && message.role === "assistant" &&
      nextMessage && nextMessage.role === "assistant" &&
      (!message.turnId || !nextMessage.turnId || message.turnId === nextMessage.turnId)
    );
  }

  function messageRowRenderKey(message, nextMessage) {
    return JSON.stringify([
      message && message.role || "",
      message && message.text || "",
      message && message.id || "",
      message && message.turnId || "",
      message && message.phase || "",
      message && message.model || "",
      Boolean(message && message.pending),
      message && message.status || "",
      message && message.clientId || "",
      Array.isArray(message && message.images) ? message.images.map(function (image) {
        return [
          image && image.previewUrl || "",
          image && image.url || "",
          image && image.path || "",
          image && image.alt || "",
          image && image.fileName || ""
        ];
      }) : [],
      messageContinues(message, nextMessage),
      message && message.pending ? currentAdapterName() : ""
    ]);
  }

  function getMessageNode(message, index, nextMessage, nodeKey) {
    var renderKey = messageRowRenderKey(message, nextMessage);
    var existing = state.messageNodes[nodeKey];
    if (existing && existing.__deskRelayMessageRenderKey === renderKey) {
      return existing;
    }
    var row = renderMessageRow(message, index, nextMessage, nodeKey);
    row.__deskRelayMessageRenderKey = renderKey;
    state.messageNodes[nodeKey] = row;
    return row;
  }

  function renderMessageRow(message, index, nextMessage, nodeKey) {
    var row = document.createElement("article");
    var pendingClass = message.pending ? " " + (message.status === "failed" ? "failed" : "pending") : "";
    var continues = messageContinues(message, nextMessage);
    var continuesClass = continues ? " continues" : "";
    row.className = "message-row " + message.role + (message.phase === "commentary" ? " commentary" : "") + continuesClass + pendingClass;
    row.id = message.clientId
      ? "pending-" + message.clientId
      : message.id
        ? "message-" + message.id
        : "message-auto-" + stableMessageNodeHash(nodeKey || String(index));
    var deliveryHtml = "";
    if (message.pending) {
      var creationError = message.status === "waiting_task_retry"
        ? taskCreationErrorText(taskById(message.threadId))
        : "";
      var statusText = message.status === "creating_task"
        ? "正在创建任务，创建后自动发送…"
        : message.status === "waiting_task_retry"
          ? creationError
            ? "任务创建失败：" + taskCreationErrorText(taskById(message.threadId))
            : "任务创建失败，点击重试后自动发送"
          : message.status === "waiting_to_send"
            ? "任务已创建，正在发送…"
            : message.status === "contacting_computer"
              ? "正在尝试发送给电脑…"
              : message.status === "forwarding_to_agent"
                ? "电脑正在组织发送给 " + adapterName(message.adapter || state.currentAdapter) + "…"
                : message.status === "sending"
                  ? "正在尝试发送给电脑…"
        : message.status === "failed"
          ? "发送失败"
          : message.status === "unconfirmed"
            ? "发送状态未确认"
            : message.status === "queued"
              ? "已排队 · 等待当前任务完成"
              : message.status === "steered"
                ? "已引导 · 正在处理"
                : "已发送 · 正在处理";
      var retry = message.status === "failed" || message.status === "waiting_task_retry" || message.status === "unconfirmed"
        ? '<button class="message-retry" type="button" data-retry="' + escapeHtml(message.clientId) + '">' +
          (message.status === "unconfirmed" ? "检查状态" : "重试") + "</button>"
        : "";
      deliveryHtml = '<div class="message-delivery ' + (
        message.status === "failed" || message.status === "waiting_task_retry" ? "failed" : ""
      ) + '"><span>' + escapeHtml(statusText) + "</span>" + retry + "</div>";
    }
    var imagesHtml = renderMessageImages(message);
    var visibleText = visibleMessageText(message);
    var textHtml = visibleText ? '<div class="message-content">' + renderMarkdown(visibleText, row.id) + "</div>" : "";
    var model = visibleMessageModel(message);
    var modelHtml = model
      ? '<div class="message-model">' + escapeHtml(model) + "</div>"
      : "";
    row.innerHTML = '<div class="message-card">' + imagesHtml + textHtml + modelHtml + deliveryHtml + "</div>";
    var retryButton = row.querySelector("[data-retry]");
    if (retryButton) retryButton.addEventListener("click", function () { retryPendingMessage(message.clientId); });
    bindMessageImageActions(row);
    return row;
  }

  function renderResponsePendingIndicator(summary) {
    if (!summary || summary.status !== "running" || state.pendingApproval) return null;
    var row = document.createElement("div");
    row.className = "response-pending";
    row.setAttribute("role", "status");
    row.setAttribute("aria-label", "正在处理");
    row.innerHTML = '<span class="response-pending-dot"></span>' +
      '<span class="response-pending-dot"></span>' +
      '<span class="response-pending-dot"></span>';
    return row;
  }

  function runSummaryRenderKey(summary) {
    if (!summary) return null;
    return [
      summary.turnId || "",
      summary.status || "",
      Number(summary.startedAtMs) || 0,
      Number(summary.completedAtMs) || 0,
      summary.errorMessage || ""
    ];
  }

  function captureOpenFoldState() {
    if (messagesEl.dataset.threadId !== state.currentThreadId) {
      return { codeKeys: [], progressHistoryOpen: false };
    }
    return {
      codeKeys: Array.from(messagesEl.querySelectorAll(".message-code-fold[open]"))
        .map(function (details) { return details.getAttribute("data-fold-key") || ""; })
        .filter(Boolean),
      progressHistoryOpen: Boolean(messagesEl.querySelector(".run-progress-history[open]"))
    };
  }

  function restoreOpenFoldState(foldState) {
    var openCodeKeys = new Set(foldState && foldState.codeKeys || []);
    messagesEl.querySelectorAll(".message-code-fold").forEach(function (details) {
      if (openCodeKeys.has(details.getAttribute("data-fold-key") || "")) {
        details.open = true;
      }
    });
    var progressHistory = messagesEl.querySelector(".run-progress-history");
    if (progressHistory && foldState && foldState.progressHistoryOpen) {
      progressHistory.open = true;
    }
    messagesEl.dataset.threadId = state.currentThreadId || "";
  }

  function renderMessages(forceBottom) {
    if (state.switchingAdapter) {
      messagesEl.innerHTML = "";
      messagesEl.dataset.threadId = "";
      state.messageNodes = Object.create(null);
      updateUserMessageNavigation();
      return;
    }
    var shouldStick = forceBottom || isNearBottom();
    var previousScrollTop = messagesEl.scrollTop;
    var openFoldState = captureOpenFoldState();
    var messages = filterVisibleConversationMessages(state.serverMessages).concat(visiblePendingMessages().map(function (pending) {
      return Object.assign({ role: "user", pending: true }, pending);
    }));
    var summary = resolveVisibleRunSummary(
      messages,
      currentTask(),
      effectiveRunSummary(),
      Date.now(),
      state.progressItems
    );
    var headerIndex = runHeaderInsertIndex(messages, summary);
    var pendingDelivery = currentPendingDelivery();
    if (!messages.length && !summary && !state.pendingApproval && state.approvalResults.length === 0 && state.progressItems.length === 0) {
      state.messageNodes = Object.create(null);
      var emptyTask = currentTask();
      if (isTemporaryTask(emptyTask)) {
        var emptyCreationError = taskCreationErrorText(emptyTask);
        messagesEl.innerHTML = '<div class="empty-state"><div class="empty-wordmark">WeRelay</div><h1>' +
          (emptyTask.localCreationState === "failed"
            ? '任务创建失败'
            : emptyTask.localCreationState === "ready"
              ? '继续填写新任务'
              : '正在后台创建任务') +
          '</h1><p>' +
          (emptyTask.localCreationState === "failed"
            ? '输入内容和图片都已保留；再次点“新建任务”会自动重试。' +
              (emptyCreationError
                ? '<br>失败原因：' + escapeHtml(taskCreationErrorText(emptyTask))
                : '')
            : emptyTask.localCreationState === "ready"
              ? '尚未发送的内容会一直保留；发送第一条消息后才开始执行。'
              : '现在就可以输入；提交后会在任务创建成功时自动发送。') +
          '</p></div>';
      } else if (state.adapterError) {
        var capabilityLimited = isAdapterCapabilityError();
        messagesEl.innerHTML = '<div class="empty-state"><div class="empty-wordmark">' + escapeHtml(currentAdapterName()) + '</div><h1>' +
          (capabilityLimited ? '网页版暂不支持此终端' : '终端暂未连接') + '</h1><p>' +
          escapeHtml(state.adapterError) + '<br>' +
          (capabilityLimited
            ? '可从上方菜单切换到其他终端。'
            : '点击上方「WeRelay · ' + escapeHtml(currentAdapterName()) + '」重新连接。') +
          '</p></div>';
      } else {
        messagesEl.innerHTML = '<div class="empty-state"><div class="empty-wordmark">WeRelay</div><h1>还没有消息</h1><p>可以从手机继续这个任务。</p></div>';
      }
      messagesEl.dataset.threadId = state.currentThreadId || "";
      updateUserMessageNavigation();
      return;
    }
    if (messagesEl.dataset.threadId !== state.currentThreadId) {
      state.messageNodes = Object.create(null);
    }
    var nodes = [];
    var usedMessageNodeKeys = Object.create(null);
    var messageKeyCounts = Object.create(null);
    var runHeaderRendered = false;
    var timeline = buildConversationTimeline({
      messages: messages,
      approvalResults: state.approvalResults,
      pendingApproval: state.pendingApproval,
      progressItems: state.progressItems
    });
    function appendRunHeaderIfNeeded(messageIndex) {
      if (runHeaderRendered || !summary || messageIndex !== headerIndex) return;
      nodes.push(renderRunHeader(summary));
      var failure = renderRunFailure(summary);
      if (failure) nodes.push(failure);
      runHeaderRendered = true;
    }
    timeline.forEach(function (item) {
      if (item.kind === "message") {
        var message = item.message;
        var index = messages.indexOf(message);
        appendRunHeaderIfNeeded(index);
        var baseKey = messageNodeBaseKey(message);
        var duplicateIndex = messageKeyCounts[baseKey] || 0;
        messageKeyCounts[baseKey] = duplicateIndex + 1;
        var nodeKey = messageNodeKey(message, duplicateIndex);
        usedMessageNodeKeys[nodeKey] = true;
        nodes.push(getMessageNode(message, index, messages[index + 1], nodeKey));
        return;
      }
      if (item.kind === "progress") {
        var progress = renderProgressList([item.progressItem]);
        if (progress) {
          progress.classList.add("timeline-progress");
          progress.open = true;
          nodes.push(progress);
        }
        return;
      }
      if (item.kind === "approval-result") {
        nodes.push(renderApprovalResult(item.approvalResult));
        return;
      }
      if (item.kind === "pending-approval") {
        nodes.push(renderApprovalCard(item.pendingApproval));
      }
    });
    if (!runHeaderRendered && summary && headerIndex >= messages.length) {
      nodes.push(renderRunHeader(summary));
      var trailingFailure = renderRunFailure(summary);
      if (trailingFailure) nodes.push(trailingFailure);
    }
    if (pendingDelivery) nodes.push(renderDeliveryHeader(pendingDelivery));
    var responsePending = renderResponsePendingIndicator(summary);
    if (responsePending) nodes.push(responsePending);
    syncChildOrder(messagesEl, nodes);
    Object.keys(state.messageNodes).forEach(function (nodeKey) {
      if (!usedMessageNodeKeys[nodeKey]) delete state.messageNodes[nodeKey];
    });
    restoreOpenFoldState(openFoldState);
    requestAnimationFrame(function () {
      if (shouldStick) scrollToLatest(false);
      else messagesEl.scrollTop = previousScrollTop;
      updateUserMessageNavigation();
    });
  }

  async function stopCurrentTask() {
    var threadId = state.currentThreadId;
    if (!threadId || state.stopRequestedThreadId === threadId) return;
    state.stopRequestedThreadId = threadId;
    renderMessages(false);
    updateHeader();
    try {
      var result = await api(adapterApiPath("/api/tasks/" + encodeURIComponent(threadId) + "/stop"), {
        method: "POST"
      });
      if (threadId !== state.currentThreadId) return;
      if (result.interrupted) {
        showToast("已发送停止请求");
        setTimeout(function () {
          if (threadId === state.currentThreadId) loadMessages(false);
        }, 300);
      } else {
        state.stopRequestedThreadId = "";
        showToast("任务当前没有运行");
        renderMessages(false);
        updateHeader();
      }
    } catch (error) {
      if (threadId === state.currentThreadId) {
        state.stopRequestedThreadId = "";
        showToast("停止失败：" + (error.message || "请稍后重试"));
        renderMessages(false);
        updateHeader();
      }
    }
  }

  function updateRunSummary(summary, task, messages) {
    var taskRunning = isTaskActivelyRunning(task);
    var latestUserIndex = -1;
    var latestAssistantIndex = -1;
    (Array.isArray(messages) ? messages : []).forEach(function (message, index) {
      if (!message) return;
      if (message.role === "user") latestUserIndex = index;
      if (message.role === "assistant") latestAssistantIndex = index;
    });
    var assistantReplySettled = latestUserIndex >= 0 && latestAssistantIndex > latestUserIndex;
    var previous = state.runSummary;
    var next = summary ? Object.assign({}, summary, { receivedAtMs: Date.now() }) : null;
    if (taskRunning && next && next.status !== "running") {
      next = null;
    } else if (!taskRunning && next && next.status === "running") {
      var localRunning = state.localRunSummary &&
        state.localRunSummary.status === "running" &&
        (!state.localRunSummary.turnId || !next.turnId ||
          state.localRunSummary.turnId === next.turnId);
      if (assistantReplySettled || !localRunning) {
        if (previous && previous.turnId === next.turnId && previous.status !== "running") {
          next = previous;
        } else {
          next = Object.assign({}, next, {
            status: "unknown",
            completedAtMs: undefined,
            durationMs: runDurationMs(next)
          });
        }
      }
    }
    state.runSummary = next;
    if (!taskRunning && state.stopRequestedThreadId === state.currentThreadId) {
      state.stopRequestedThreadId = "";
    }
    if (
      state.optimisticProgressTurnId &&
      next &&
      next.turnId === state.optimisticProgressTurnId &&
      next.status !== "running"
    ) {
      state.optimisticProgressTurnId = null;
    }
    if (state.localRunSummary) {
      var localTurnConfirmed = Boolean(
        state.localRunSummary.turnId &&
        next &&
        next.turnId === state.localRunSummary.turnId &&
        next.status !== "unknown"
      );
      var localAgeMs = Date.now() - Number(state.localRunSummary.startedAtMs || Date.now());
      var remoteSettledForLocal = Boolean(
        next &&
        next.status !== "running" &&
        state.localRunSummary.turnId &&
        next.turnId &&
        state.localRunSummary.turnId === next.turnId
      );
      var settledEvidence = remoteSettledForLocal || assistantReplySettled;
      if (
        localTurnConfirmed ||
        settledEvidence ||
        taskRunning && next && next.status === "running"
      ) {
        state.localRunSummary = null;
        if (settledEvidence) state.optimisticProgressTurnId = null;
      } else if (!taskRunning && !state.pendingMessages.some(function (message) {
        return message.inFlight;
      }) && localAgeMs > 120000) {
        state.localRunSummary = null;
      }
    }
  }

  function normalizeMessagePage(payload, messages) {
    var page = payload && payload.messagePage || {};
    return {
      hasMore: Boolean(page.hasMore),
      nextBefore: page.nextBefore === null || page.nextBefore === undefined
        ? null
        : String(page.nextBefore),
      source: page.source === "openagentlog" ? "openagentlog" : "native",
      caughtUp: page.caughtUp !== false
    };
  }

  function messagePageKey(message) {
    if (message && message.id) return "id:" + message.id;
    return "content:" + [
      message && message.turnId || "",
      message && message.role || "",
      message && message.phase || "",
      message && message.text || ""
    ].join("\u0000");
  }

  function messagesRepresentSameEntry(left, right) {
    if (!left || !right) return false;
    if (left.id && right.id) return left.id === right.id;
    if (
      (left.role || "") !== (right.role || "") ||
      (left.text || "") !== (right.text || "")
    ) return false;
    var text = String(left.text || "").trim().toLowerCase();
    if (!text || /^\[(?:tool_use|tool_result)\]$/.test(text)) return false;
    if (left.turnId && right.turnId && left.turnId !== right.turnId) return false;
    if (left.phase && right.phase && left.phase !== right.phase) return false;
    return true;
  }

  function messagePageAlignment(existing, incoming) {
    var previous = existing || [];
    var next = incoming || [];
    var lengths = Array.from({ length: previous.length + 1 }, function () {
      return Array(next.length + 1).fill(0);
    });
    for (var previousIndex = 1; previousIndex <= previous.length; previousIndex += 1) {
      for (var incomingIndex = 1; incomingIndex <= next.length; incomingIndex += 1) {
        if (messagesRepresentSameEntry(
          previous[previousIndex - 1],
          next[incomingIndex - 1]
        )) {
          lengths[previousIndex][incomingIndex] =
            lengths[previousIndex - 1][incomingIndex - 1] + 1;
        } else {
          lengths[previousIndex][incomingIndex] = Math.max(
            lengths[previousIndex - 1][incomingIndex],
            lengths[previousIndex][incomingIndex - 1]
          );
        }
      }
    }
    if (!lengths[previous.length][next.length]) return null;

    var matches = [];
    var previousCursor = previous.length;
    var incomingCursor = next.length;
    while (previousCursor > 0 && incomingCursor > 0) {
      if (
        messagesRepresentSameEntry(
          previous[previousCursor - 1],
          next[incomingCursor - 1]
        ) &&
        lengths[previousCursor][incomingCursor] ===
          lengths[previousCursor - 1][incomingCursor - 1] + 1
      ) {
        matches.unshift({
          previousIndex: previousCursor - 1,
          incomingIndex: incomingCursor - 1
        });
        previousCursor -= 1;
        incomingCursor -= 1;
      } else if (
        lengths[previousCursor - 1][incomingCursor] >
        lengths[previousCursor][incomingCursor - 1]
      ) {
        previousCursor -= 1;
      } else {
        incomingCursor -= 1;
      }
    }
    return {
      first: matches[0],
      last: matches[matches.length - 1]
    };
  }

  function mergeMessagePages(existing, incoming) {
    var previous = existing || [];
    var next = incoming || [];
    var alignment = messagePageAlignment(previous, next);
    if (alignment) {
      var prefix = previous.slice(0, alignment.first.previousIndex);
      var suffix = alignment.last.incomingIndex === next.length - 1
        ? previous.slice(alignment.last.previousIndex + 1)
        : [];
      return prefix.concat(next, suffix);
    }

    var merged = previous.slice();
    var indexByKey = Object.create(null);
    merged.forEach(function (message, index) {
      indexByKey[messagePageKey(message)] = index;
    });
    next.forEach(function (message) {
      var key = messagePageKey(message);
      var existingIndex = indexByKey[key];
      if (existingIndex !== undefined) {
        merged[existingIndex] = message;
        return;
      }
      indexByKey[key] = merged.length;
      merged.push(message);
    });
    return merged;
  }

  function rebuildServerMessages() {
    state.serverMessages = filterVisibleConversationMessages(mergeMessagePages(
      state.historyMessages,
      state.latestMessages
    ));
  }

  function applyLatestMessagePage(payload, historyOnly) {
    var messages = filterVisibleConversationMessages(payload.messages || []);
    var page = normalizeMessagePage(payload, messages);
    if (historyOnly || !state.latestMessages.length) {
      state.historyMessages = [];
      state.latestMessages = messages;
      state.oldestMessageCursor = page.nextBefore;
      state.historySource = page.source;
      state.historyCaughtUp = page.caughtUp;
    } else {
      state.latestMessages = mergeMessagePages(state.latestMessages, messages);
    }
    state.hasOlderMessages = state.oldestMessageCursor !== null;
    rebuildServerMessages();
    return page;
  }

  async function loadOlderMessages() {
    if (
      !state.authenticated ||
      !state.currentThreadId ||
      !state.hasOlderMessages ||
      state.loadingOlderMessages
    ) return;
    var requestedThreadId = state.currentThreadId;
    var requestId = ++state.historyRequestId;
    var before = state.oldestMessageCursor;
    if (before === null) {
      state.hasOlderMessages = false;
      return;
    }
    state.loadingOlderMessages = true;
    var previousHeight = messagesEl.scrollHeight;
    var previousTop = messagesEl.scrollTop;
    try {
      var payload = await api(adapterApiPath(
        "/api/tasks/" + encodeURIComponent(requestedThreadId) +
        "/messages?limit=" + MESSAGE_PAGE_SIZE + "&before=" + encodeURIComponent(before)
      ));
      if (
        requestId !== state.historyRequestId ||
        requestedThreadId !== state.currentThreadId ||
        payload.threadId !== requestedThreadId
      ) return;
      var messages = filterVisibleConversationMessages(payload.messages || []);
      var page = normalizeMessagePage(payload, messages);
      state.historyMessages = mergeMessagePages(messages, state.historyMessages);
      state.oldestMessageCursor = page.nextBefore;
      state.hasOlderMessages = state.oldestMessageCursor !== null;
      rebuildServerMessages();
      state.transcriptSignature = "";
      renderMessages(false);
      messagesEl.scrollTop = previousTop + Math.max(0, messagesEl.scrollHeight - previousHeight);
    } catch (error) {
      if (requestId === state.historyRequestId && error.status !== 401) {
        showToast(error.message || "更早消息读取失败");
      }
    } finally {
      if (requestId === state.historyRequestId) state.loadingOlderMessages = false;
    }
  }

  function mergeMessageRefreshRequest(current, forceBottom, historyOnly, forceFullPage) {
    if (!current) {
      return {
        forceBottom: Boolean(forceBottom),
        historyOnly: Boolean(historyOnly),
        forceFullPage: Boolean(forceFullPage)
      };
    }
    return {
      forceBottom: Boolean(current.forceBottom || forceBottom),
      historyOnly: Boolean(current.historyOnly && historyOnly),
      forceFullPage: Boolean(current.forceFullPage || forceFullPage)
    };
  }

  async function loadMessages(forceBottom, historyOnly, forceFullPage) {
    if (!state.authenticated || !state.currentThreadId) return null;
    if (isTemporaryTask(currentTask())) {
      renderMessages(false);
      updateHeader();
      return null;
    }
    if (state.loadingMessages) {
      state.trailingMessageRefresh = mergeMessageRefreshRequest(
        state.trailingMessageRefresh,
        forceBottom,
        historyOnly,
        forceFullPage
      );
      return null;
    }
    var requestedThreadId = state.currentThreadId;
    var requestId = ++state.messageRequestId;
    state.loadingMessages = true;
    try {
      var livePageSize = forceFullPage ? MESSAGE_PAGE_SIZE : LIVE_MESSAGE_PAGE_SIZE;
      var pageSize = historyOnly || !state.latestMessages.length
        ? MESSAGE_PAGE_SIZE
        : livePageSize;
      var payload = await api(adapterApiPath(
        "/api/tasks/" + encodeURIComponent(requestedThreadId) +
        "/messages?limit=" + pageSize + (historyOnly ? "&history=1" : "")
      ));
      if (
        requestId !== state.messageRequestId ||
        requestedThreadId !== state.currentThreadId ||
        payload.threadId !== requestedThreadId
      ) return;
      applyLatestMessagePage(payload, historyOnly);
      if (!historyOnly) {
        state.lastLiveMessageRefreshAtMs = Date.now();
        if (typeof payload.revision === "string" && payload.revision) {
          state.contentRevision = payload.revision;
        }
      }
      var messages = state.serverMessages;
      reconcilePendingMessages(payload.messages || []);
      var taskIndex = state.tasks.findIndex(function (task) { return task.threadId === payload.threadId; });
      if (taskIndex >= 0 && payload.task) {
        state.tasks[taskIndex] = mergeTasksWithLocalDrafts(
          [payload.task],
          isTemporaryTask(state.tasks[taskIndex]) ? [state.tasks[taskIndex]] : []
        )[0];
      }
      if (!historyOnly) {
        state.pendingApproval = payload.pendingApproval || null;
        state.approvalResults = Array.isArray(payload.approvalResults)
          ? payload.approvalResults
          : [];
        if (taskIndex >= 0) {
          state.tasks[taskIndex] = reconcileTaskApprovalStatus(
            state.tasks[taskIndex],
            state.pendingApproval,
            payload.runSummary || null
          );
        }
        updateRunSummary(payload.runSummary || null, payload.task || null, messages);
        state.progressItems = filterProgressItemsForOptimisticTurn(
          filterProgressItemsForCurrentTurn(
            payload.progressItems || [],
            payload.task || null,
            effectiveRunSummary()
          ),
          state.optimisticProgressTurnId
        );
      }
      var pendingSignature = state.pendingMessages.map(function (pending) {
        return [
          pending.clientId,
          pending.status,
          pending.turnId,
          pending.text,
          pending.imageCount,
          pending.displayInTranscript
        ];
      });
      var signature = JSON.stringify([
        messages,
        pendingSignature,
        runSummaryRenderKey(effectiveRunSummary()),
        payload.task && [payload.task.status, payload.task.startedAtMs, payload.task.activeTurnId],
        state.stopRequestedThreadId,
        state.pendingApproval,
        state.approvalResults,
        state.progressItems
      ]);
      if (signature !== state.transcriptSignature) {
        state.transcriptSignature = signature;
        renderMessages(forceBottom);
      }
      var queuedMessages = payload.queuedMessages || [];
      var queueSignature = queuedMessagesRenderSignature(queuedMessages);
      if (queueSignature !== state.queueSignature) renderQueuedMessages(queuedMessages);
      updateHeader();
      renderTasks();
      saveCurrentConversationSnapshot();
      if (!historyOnly && (
        state.cacheSyncState === "checking" || state.cacheSyncState === "updating"
      )) setCacheSyncState("current");
      return payload;
    } catch (error) {
      if (
        requestId === state.messageRequestId &&
        requestedThreadId === state.currentThreadId &&
        error.status !== 401
      ) {
        if (!error.network) showToast(error.message || "消息读取失败");
      }
      return null;
    } finally {
      if (requestId === state.messageRequestId) {
        state.loadingMessages = false;
        var trailingRefresh = state.trailingMessageRefresh;
        state.trailingMessageRefresh = null;
        if (trailingRefresh && requestedThreadId === state.currentThreadId) {
          void loadMessages(
            trailingRefresh.forceBottom,
            trailingRefresh.historyOnly,
            trailingRefresh.forceFullPage
          );
        }
      }
    }
  }

  async function refreshMessagesIfChanged(forceBottom, announceCheck) {
    if (!state.authenticated || !state.currentThreadId) return null;
    if (!state.contentRevision || isTemporaryTask(currentTask())) {
      return await loadMessages(forceBottom, false, false);
    }
    var requestedThreadId = state.currentThreadId;
    var knownRevision = state.contentRevision;
    if (announceCheck) setCacheSyncState("checking");
    try {
      var payload = await api(adapterApiPath(
        "/api/tasks/" + encodeURIComponent(requestedThreadId) +
        "/sync-state?known=" + encodeURIComponent(knownRevision)
      ));
      if (
        requestedThreadId !== state.currentThreadId ||
        payload.threadId !== requestedThreadId
      ) return null;
      if (!payload.changed) {
        if (typeof payload.revision === "string" && payload.revision) {
          state.contentRevision = payload.revision;
        }
        if (shouldForceLiveMessageRefresh(Date.now())) {
          setCacheSyncState("updating");
          return await loadMessages(forceBottom, false, false);
        }
        if (announceCheck) setCacheSyncState("current");
        else setCacheSyncState("idle");
        saveCurrentConversationSnapshot();
        return payload;
      }
      setCacheSyncState("updating");
      var refreshed = await loadMessages(forceBottom, false, false);
      if (!refreshed) setCacheSyncState("idle");
      return refreshed;
    } catch (error) {
      setCacheSyncState("idle");
      if (error.status === 401) return null;
      return await loadMessages(forceBottom, false, false);
    }
  }

  function temporaryTaskTitle(projectName) {
    return projectName
      ? "新 " + projectName + " 任务"
      : "新 " + currentAdapterName() + " 任务";
  }

  function createTemporaryTask(sourceThreadId, projectName) {
    var sourceTask = sourceThreadId ? taskById(sourceThreadId) : null;
    return {
      threadId: "local-new-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      title: temporaryTaskTitle(projectName),
      projectId: sourceTask && sourceTask.projectId,
      projectName: projectName || sourceTask && sourceTask.projectName,
      projectOrder: sourceTask && sourceTask.projectOrder,
      projectThreadOrder: sourceTask && sourceTask.projectThreadOrder,
      status: "idle",
      selected: true,
      canRename: false,
      canCreateInProject: false,
      localCreationState: "creating",
      localSourceThreadId: sourceThreadId || "",
      lastUpdatedAt: new Date().toISOString()
    };
  }

  function migrateTemporaryConversation(temporaryThreadId, realThreadId) {
    var temporaryKey = conversationStateKey(state.currentAdapter, temporaryThreadId);
    var realKey = conversationStateKey(state.currentAdapter, realThreadId);
    saveComposerDraft(state.currentAdapter, temporaryThreadId);
    state.pendingMessages.forEach(function (pending) {
      if (pending.threadId === temporaryThreadId) pending.threadId = realThreadId;
    });
    saveCurrentConversationSnapshot();
    moveConversationValue(
      state.composerDrafts,
      state.composerDraftOrder,
      temporaryKey,
      realKey,
      MAX_COMPOSER_DRAFTS
    );
    moveConversationValue(
      state.conversationSnapshots,
      state.conversationSnapshotOrder,
      temporaryKey,
      realKey,
      MAX_CONVERSATION_SNAPSHOTS
    );
    state.currentThreadId = realThreadId;
    messagesEl.dataset.threadId = realThreadId;
    var url = new URL(window.location.href);
    url.searchParams.set("adapter", state.currentAdapter);
    url.searchParams.set("task", realThreadId);
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  async function submitMessagesWaitingForTaskCreation(threadId) {
    var waiting = state.pendingMessages.filter(function (pending) {
      return pending.threadId === threadId && pending.waitingForTaskCreation;
    });
    if (!waiting.length) return;
    finishLocalTaskDraft(threadId);
    for (var index = 0; index < waiting.length; index += 1) {
      var pending = waiting[index];
      pending.waitingForTaskCreation = false;
      pending.status = "waiting_to_send";
      await submitPendingMessage(pending);
    }
  }

  function shouldRetryTaskCreationRequest(error, attempt) {
    return attempt === 0 && Boolean(
      error && (error.network || error.status === 504)
    );
  }

  async function requestTaskCreation(createPath, requestId) {
    for (var attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await api(createPath, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId: requestId })
        });
      } catch (error) {
        if (!shouldRetryTaskCreationRequest(error, attempt)) throw error;
        await waitForMobileFetchRetry();
      }
    }
    throw new Error("电脑响应超时，请稍后重试。");
  }

  async function createTask(sourceThreadId, projectName, existingTemporaryTask) {
    if (state.creatingTask || state.switchingAdapter) return;
    var reusableTask = currentLocalTaskDraft();
    if (!existingTemporaryTask && reusableTask) {
      await selectTask(reusableTask.threadId, true);
      requestAnimationFrame(function () { composerInput.focus(); });
      if (reusableTask.localCreationState === "failed") {
        sourceThreadId = reusableTask.localSourceThreadId || "";
        projectName = reusableTask.projectName || projectName || "";
        existingTemporaryTask = reusableTask;
      } else {
        showToast("已回到未完成的新任务");
        return;
      }
    }
    var temporaryTask = existingTemporaryTask || createTemporaryTask(sourceThreadId, projectName);
    state.creatingTask = true;
    temporaryTask.localCreationState = "creating";
    temporaryTask.localCreationError = "";
    state.creatingProjectKey = sourceThreadId
      ? taskGroupKey(taskById(sourceThreadId) || {})
      : "";
    if (!existingTemporaryTask) {
      rememberLocalTaskDraft(temporaryTask);
      state.tasks.unshift(temporaryTask);
      await selectTask(temporaryTask.threadId, true);
      requestAnimationFrame(function () { composerInput.focus(); });
    } else {
      renderTasks();
      updateHeader();
      renderMessages(false);
    }
    try {
      var createPath = adapterApiPath("/api/tasks");
      if (sourceThreadId) {
        var createUrl = new URL(createPath, window.location.origin);
        createUrl.searchParams.set("sourceTask", sourceThreadId);
        createPath = createUrl.pathname + createUrl.search;
      }
      var payload = await requestTaskCreation(createPath, temporaryTask.threadId);
      var task = payload && payload.task;
      if (!task || !task.threadId) throw new Error("电脑端没有返回新任务。");
      task = Object.assign({}, task, {
        localCreationState: "ready",
        localCreationError: "",
        localSourceThreadId: sourceThreadId || ""
      });
      rememberLocalTaskDraft(task);
      state.adapterError = "";
      var temporaryThreadId = temporaryTask.threadId;
      state.tasks = state.tasks.filter(function (candidate) {
        return candidate.threadId !== task.threadId || candidate.threadId === temporaryThreadId;
      });
      var taskIndex = state.tasks.findIndex(function (candidate) {
        return candidate.threadId === temporaryThreadId;
      });
      if (taskIndex >= 0) state.tasks[taskIndex] = task;
      if (state.currentThreadId === temporaryThreadId) {
        migrateTemporaryConversation(temporaryThreadId, task.threadId);
      } else {
        var temporaryKey = conversationStateKey(state.currentAdapter, temporaryThreadId);
        var realKey = conversationStateKey(state.currentAdapter, task.threadId);
        moveConversationValue(
          state.composerDrafts,
          state.composerDraftOrder,
          temporaryKey,
          realKey,
          MAX_COMPOSER_DRAFTS
        );
        moveConversationValue(
          state.conversationSnapshots,
          state.conversationSnapshotOrder,
          temporaryKey,
          realKey,
          MAX_CONVERSATION_SNAPSHOTS
        );
        state.pendingMessages.forEach(function (pending) {
          if (pending.threadId === temporaryThreadId) pending.threadId = task.threadId;
        });
      }
      renderTasks();
      updateHeader();
      renderMessages(false);
      void submitMessagesWaitingForTaskCreation(task.threadId);
      void loadTasks(false);
      if (state.currentThreadId === task.threadId) void loadMessages(false, false, false);
      showToast(sourceThreadId
        ? "已在“" + (projectName || "这个项目") + "”中准备好新任务"
        : "新任务已准备好，可以继续输入");
    } catch (error) {
      temporaryTask.localCreationState = "failed";
      temporaryTask.localCreationError = error.message || "新建任务失败";
      rememberLocalTaskDraft(temporaryTask);
      state.pendingMessages.forEach(function (pending) {
        if (pending.threadId === temporaryTask.threadId && pending.waitingForTaskCreation) {
          pending.status = "waiting_task_retry";
        }
      });
      saveComposerDraft(state.currentAdapter, temporaryTask.threadId);
      if (state.currentThreadId === temporaryTask.threadId) saveCurrentConversationSnapshot();
      renderTasks();
      updateHeader();
      renderMessages(false);
      showToast("创建失败，输入内容已保留");
    } finally {
      state.creatingTask = false;
      state.creatingProjectKey = "";
      updateHeader();
      renderTasks();
    }
  }

  async function selectTask(threadId, updateUrl) {
    closeTaskContextMenu();
    if (!threadId) return;
    if (state.settingsOpen) setSettingsOpen(false, updateUrl);
    if (threadId === state.currentThreadId) {
      if (updateUrl) {
        var currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set("task", threadId);
        history.replaceState(null, "", currentUrl.pathname + currentUrl.search + currentUrl.hash);
      }
      closeSidebar();
      renderTasks();
      updateHeader();
      if (!isTemporaryTask(currentTask())) {
        void Promise.all([
          refreshMessagesIfChanged(false, true),
          loadCurrentTaskModel(false),
          loadCurrentTaskPermission(false)
        ]);
      }
      return;
    }
    saveCurrentConversationSnapshot();
    state.messageRequestId += 1;
    state.loadingMessages = false;
    state.trailingMessageRefresh = null;
    state.composerRevision += 1;
    state.currentThreadId = threadId;
    state.modelRequestId += 1;
    state.modelChanging = false;
    state.reasoningChanging = false;
    state.permissionRequestId += 1;
    state.permissionChanging = false;
    closeModelMenu();
    closeReasoningMenu();
    closePermissionMenu();
    renderModelControl();
    state.loadingOlderMessages = false;
    state.historyRequestId += 1;
    state.resolvingApproval = false;
    var restored = restoreConversationSnapshot(state.currentAdapter, threadId);
    if (!restored) {
      state.serverMessages = [];
      state.historyMessages = [];
      state.latestMessages = [];
      state.oldestMessageCursor = null;
      state.hasOlderMessages = false;
      state.historySource = "";
      state.historyCaughtUp = true;
      state.progressItems = [];
      state.optimisticProgressTurnId = null;
      state.pendingMessages = [];
      state.messageNodes = Object.create(null);
      state.editingQueuedMessageId = "";
      state.editingQueuedImageCount = 0;
      restoreComposerDraft(state.currentAdapter, threadId);
      composerInput.placeholder = "有问题，尽管问";
      composerImageButton.disabled = false;
      state.pendingImages = [];
      renderPendingImages();
      resizeComposer();
      state.runSummary = null;
      state.localRunSummary = null;
      state.pendingApproval = null;
      state.approvalResults = [];
      state.stopRequestedThreadId = "";
      state.transcriptSignature = "";
      state.contentRevision = "";
      state.queueSignature = "";
      renderQueuedMessages([]);
      var selectedTask = taskById(threadId);
      messagesEl.innerHTML = isTemporaryTask(selectedTask)
        ? '<div class="loading-row">正在准备新任务…</div>'
        : '<div class="loading-row">正在读取最近消息…</div>';
      messagesEl.dataset.threadId = threadId;
      updateUserMessageNavigation();
    }
    if (updateUrl) {
      var url = new URL(window.location.href);
      url.searchParams.set("task", threadId);
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
    closeSidebar();
    renderTasks();
    updateHeader();
    rememberCurrentTaskSnapshot();
    schedulePersistentMobileCacheWrite();
    if (isTemporaryTask(currentTask())) {
      renderMessages(false);
      return;
    }
    void loadCurrentTaskModel(false);
    void loadCurrentTaskPermission(false);
    if (restored) {
      void refreshMessagesIfChanged(false, true);
      return;
    }
    await loadMessages(true, true, false);
    if (threadId === state.currentThreadId) {
      void loadMessages(false, false, false);
    }
  }

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("is-visible");
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { toastEl.classList.remove("is-visible"); }, 2200);
  }

  function setCacheSyncState(nextState) {
    if (state.cacheSyncResetTimer) clearTimeout(state.cacheSyncResetTimer);
    state.cacheSyncResetTimer = null;
    state.cacheSyncState = nextState || "idle";
    cacheSyncIndicator.className = "cache-sync-indicator" + (
      state.cacheSyncState === "updating"
        ? " is-updating"
        : state.cacheSyncState === "current"
          ? " is-current"
          : ""
    );
    var labels = {
      checking: "检查更新",
      updating: "同步更新",
      current: "已是最新",
      "waiting-computer": "等待电脑",
      "server-retry": "重连服务器"
    };
    var label = labels[state.cacheSyncState] || "";
    cacheSyncIndicator.hidden = !label;
    var text = cacheSyncIndicator.querySelector(".cache-sync-text");
    if (text) text.textContent = label;
    cacheSyncIndicator.setAttribute("aria-label", label);
    if (state.cacheSyncState === "current") {
      state.cacheSyncResetTimer = setTimeout(function () {
        state.cacheSyncResetTimer = null;
        setCacheSyncState("idle");
      }, 1400);
    }
  }

  function renderPendingImages() {
    composerMedia.innerHTML = "";
    composerMedia.hidden = state.pendingImages.length === 0;
    state.pendingImages.forEach(function (image) {
      var item = document.createElement("div");
      item.className = "composer-media-item";
      var previewButton = document.createElement("button");
      previewButton.type = "button";
      previewButton.className = "composer-media-preview";
      previewButton.setAttribute("aria-label", "打开图片：" + image.fileName);
      previewButton.addEventListener("click", function () {
        openImageViewer(image.previewUrl, image.fileName);
      });
      var preview = document.createElement("img");
      preview.src = image.previewUrl;
      preview.alt = image.fileName;
      previewButton.appendChild(preview);
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "composer-media-remove";
      remove.setAttribute("aria-label", "移除图片");
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';
      remove.addEventListener("click", function () {
        state.pendingImages = state.pendingImages.filter(function (entry) {
          return entry.id !== image.id;
        });
        renderPendingImages();
        updateHeader();
        requestAnimationFrame(syncComposerInset);
      });
      item.appendChild(previewButton);
      item.appendChild(remove);
      composerMedia.appendChild(item);
    });
    requestAnimationFrame(syncComposerInset);
  }

  function readImageFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = typeof reader.result === "string" ? reader.result : "";
        var marker = ";base64,";
        var markerIndex = result.indexOf(marker);
        if (markerIndex < 0) {
          reject(new Error("图片读取失败"));
          return;
        }
        resolve({
          id: String(Date.now()) + "-" + Math.random().toString(36).slice(2),
          fileName: file.name || "image",
          mimeType: file.type,
          sizeBytes: file.size,
          dataBase64: result.slice(markerIndex + marker.length),
          previewUrl: result
        });
      };
      reader.onerror = function () { reject(new Error("图片读取失败")); };
      reader.readAsDataURL(file);
    });
  }

  async function addImageFiles(fileList) {
    if (state.editingQueuedMessageId) {
      showToast("编辑待发送消息时暂不支持增减图片");
      return;
    }
    var requestedThreadId = state.currentThreadId;
    var requestedComposerRevision = state.composerRevision;
    var supportedTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
    var files = Array.prototype.slice.call(fileList || []).filter(function (file) {
      return file && supportedTypes.includes(file.type);
    });
    if (!files.length) {
      showToast("请选择 PNG、JPG、WebP 或 GIF 图片");
      return;
    }
    var remaining = Math.max(0, 4 - state.pendingImages.length);
    if (remaining === 0) {
      showToast("一次最多发送 4 张图片");
      return;
    }
    if (files.length > remaining) {
      showToast("一次最多发送 4 张图片");
      files = files.slice(0, remaining);
    }
    var accepted = [];
    for (var index = 0; index < files.length; index += 1) {
      var file = files[index];
      if (file.size > 8 * 1024 * 1024) {
        showToast("单张图片不能超过 8 MB");
        continue;
      }
      try {
        var acceptedImage = await readImageFile(file);
        if (
          requestedComposerRevision !== state.composerRevision ||
          requestedThreadId !== state.currentThreadId
        ) return;
        accepted.push(acceptedImage);
      } catch (error) {
        if (
          requestedComposerRevision !== state.composerRevision ||
          requestedThreadId !== state.currentThreadId
        ) return;
        showToast(error.message || "图片读取失败");
      }
    }
    if (
      requestedComposerRevision !== state.composerRevision ||
      requestedThreadId !== state.currentThreadId
    ) return;
    var totalBytes = state.pendingImages.concat(accepted).reduce(function (sum, image) {
      return sum + image.sizeBytes;
    }, 0);
    if (totalBytes > 18 * 1024 * 1024) {
      showToast("图片总大小不能超过 18 MB");
      return;
    }
    state.pendingImages = state.pendingImages.concat(accepted);
    renderPendingImages();
    updateHeader();
  }

  function insertComposerText(text) {
    if (!text) return;
    var start = composerInput.selectionStart || 0;
    var end = composerInput.selectionEnd || start;
    composerInput.value =
      composerInput.value.slice(0, start) + text + composerInput.value.slice(end);
    composerInput.selectionStart = composerInput.selectionEnd = start + text.length;
    saveComposerDraft(state.currentAdapter, state.currentThreadId);
    resizeComposer();
  }

  function resizeComposer() {
    composerInput.style.height = "auto";
    composerInput.style.height = Math.min(composerInput.scrollHeight, 168) + "px";
    updateHeader();
    requestAnimationFrame(syncComposerInset);
  }

  function makePendingMessage(text, images) {
    return {
      clientId: "mobile-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      createdAtMs: Date.now(),
      threadId: state.currentThreadId,
      adapter: state.currentAdapter,
      text: text,
      images: images.slice(),
      imageCount: images.length,
      status: "contacting_computer",
      turnId: "",
      queued: false,
      optimisticRun: false,
      inFlight: false,
      displayInTranscript: true,
      baselineUserCount: state.serverMessages.filter(function (message) { return message.role === "user"; }).length,
      baselineUserKeys: state.serverMessages.filter(function (message) {
        return message.role === "user";
      }).map(messagePageKey)
    };
  }

  function enqueuePendingPost(pending, post) {
    var key = conversationStateKey(pending.adapter || "codex", pending.threadId);
    var previous = state.messagePostChains[key] || Promise.resolve();
    var current = previous.catch(function () {}).then(post);
    var tail = current.then(function () {}, function () {}).then(function () {
      if (state.messagePostChains[key] === tail) delete state.messagePostChains[key];
    });
    state.messagePostChains[key] = tail;
    return current;
  }

  async function submitPendingMessage(pending) {
    if (pending.inFlight) return;
    var requestedThreadId = pending.threadId;
    var requestedAdapter = pending.adapter || state.currentAdapter;
    pending.inFlight = true;
    pending.status = "contacting_computer";
    renderMessages(true);
    updateHeader();
    showToast("正在尝试发送给电脑…");
    try {
      var images = (pending.images || []).map(function (image) {
        return {
          fileName: image.fileName,
          mimeType: image.mimeType,
          dataBase64: image.dataBase64
        };
      });
      var result = await enqueuePendingPost(pending, function () {
        return api(adapterApiPath(
          "/api/tasks/" + encodeURIComponent(requestedThreadId) + "/messages",
          requestedAdapter
        ), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: pending.clientId,
            text: pending.text,
            images: images
          })
        });
      });
      var deliveryChecks = 0;
      while (result && result.status === "forwarding") {
        pending.status = "forwarding_to_agent";
        renderMessages(true);
        deliveryChecks += 1;
        if (deliveryChecks >= 100) {
          throw new Error(currentAdapterName() + " 暂未确认收到这条消息，请先检查任务状态。");
        }
        await new Promise(function (resolve) { setTimeout(resolve, 650); });
        result = await api(adapterApiPath(
          "/api/tasks/" + encodeURIComponent(requestedThreadId) +
          "/message-deliveries/" + encodeURIComponent(pending.clientId),
          requestedAdapter
        ));
      }
      if (result && result.status === "failed") {
        throw new Error(result.error || "消息发送失败。");
      }
      if (result.duplicate) {
        state.pendingMessages = state.pendingMessages.filter(function (message) {
          return message.clientId !== pending.clientId;
        });
        if (pending.optimisticRun) {
          state.localRunSummary = null;
          state.optimisticProgressTurnId = null;
          pending.optimisticRun = false;
        }
        renderQueuedMessages(state.queuedMessages);
        renderMessages(true);
        showToast("与最近一条消息相同，未重复发送");
        await loadMessages(false);
        return;
      }
      pending.turnId = result.turnId || "";
      pending.queuedMessageId = result.queuedMessageId || "";
      pending.queued = Boolean(result.queued);
      pending.status = pending.queued ? "queued" : "sent";
      if (requestedThreadId !== state.currentThreadId) return;
      if (pending.queued) {
        if (pending.optimisticRun) {
          state.localRunSummary = null;
          state.optimisticProgressTurnId = null;
          pending.optimisticRun = false;
        }
        var queuedMessage = {
          id: pending.queuedMessageId || pending.clientId,
          text: pending.text,
          imageCount: pending.imageCount,
          createdAtMs: pending.createdAtMs
        };
        if (!state.queuedMessages.some(function (message) {
          return message.id === queuedMessage.id;
        })) state.queuedMessages.push(queuedMessage);
        state.pendingMessages = state.pendingMessages.filter(function (message) {
          return message.clientId !== pending.clientId;
        });
        renderQueuedMessages(state.queuedMessages);
        showToast("已加入待发送");
        await loadMessages(false);
      } else {
        beginOptimisticRunIfNeeded(pending);
        pending.displayInTranscript = true;
        renderQueuedMessages(state.queuedMessages);
        if (pending.optimisticRun) {
          state.optimisticProgressTurnId = pending.turnId || "";
        }
        if (pending.optimisticRun && state.localRunSummary) {
          state.localRunSummary.turnId = pending.turnId || undefined;
        } else if (!state.localRunSummary || state.localRunSummary.status !== "running") {
          state.localRunSummary = {
            turnId: pending.turnId || undefined,
            status: "running",
            startedAtMs: Date.now(),
            durationMs: 0,
            receivedAtMs: Date.now()
          };
        }
        showToast("已交给 " + currentAdapterName() + "，正在处理");
      }
      renderMessages(true);
      setTimeout(function () {
        if (requestedThreadId === state.currentThreadId) loadMessages(true);
      }, 250);
    } catch (error) {
      var uncertain = Boolean(error && error.network) ||
        String(error && error.message || "").includes("暂未确认");
      pending.status = uncertain ? "unconfirmed" : "failed";
      pending.displayInTranscript = true;
      renderQueuedMessages(state.queuedMessages);
      if (pending.optimisticRun) {
        state.localRunSummary = null;
        pending.optimisticRun = false;
      }
      if (requestedThreadId === state.currentThreadId) {
        try {
          await loadMessages(false);
        } catch {}
        var stillPending = state.pendingMessages.some(function (message) {
          return message.clientId === pending.clientId;
        });
        if (stillPending) {
          renderMessages(true);
          showToast(uncertain
            ? "发送状态暂未确认，请先查看任务状态"
            : "发送失败：" + (error.message || "请稍后重试"));
        } else {
          showToast("已发送，" + currentAdapterName() + " 正在处理");
        }
      }
    } finally {
      pending.inFlight = false;
      updateHeader();
    }
  }

  function beginOptimisticRunIfNeeded(pending) {
    var visibleSummary = currentVisibleRunSummary();
    if (visibleSummary && visibleSummary.status === "running") return;
    pending.optimisticRun = true;
    state.optimisticProgressTurnId = "";
    state.progressItems = [];
    state.localRunSummary = {
      status: "running",
      startedAtMs: Date.now(),
      durationMs: 0,
      receivedAtMs: Date.now()
    };
  }

  function retryPendingMessage(clientId) {
    var pending = state.pendingMessages.find(function (message) { return message.clientId === clientId; });
    if (!pending || pending.inFlight) return;
    var task = taskById(pending.threadId);
    if (isTemporaryTask(task)) {
      pending.waitingForTaskCreation = true;
      pending.status = "creating_task";
      renderMessages(true);
      void createTask(task.localSourceThreadId || "", task.projectName || "", task);
      return;
    }
    pending.turnId = "";
    pending.baselineUserCount = state.serverMessages.filter(function (message) {
      return message.role === "user";
    }).length;
    pending.baselineUserKeys = state.serverMessages.filter(function (message) {
      return message.role === "user";
    }).map(messagePageKey);
    renderMessages(true);
    submitPendingMessage(pending);
  }

  composerForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var text = composerInput.value;
    var images = state.pendingImages.slice();
    if (state.editingQueuedMessageId) {
      if (images.length > 0) {
        showToast("编辑待发送消息时暂不支持增减图片");
        return;
      }
      if (!text.trim() && state.editingQueuedImageCount === 0) {
        showToast("消息内容不能为空");
        return;
      }
      void submitQueuedMessageEdit(text);
      return;
    }
    var task = currentTask();
    var hasContent = Boolean(text.trim() || images.length > 0);
    var visibleRunSummary = currentVisibleRunSummary();
    if (shouldUseStopComposerAction(task, visibleRunSummary, hasContent)) {
      stopCurrentTask();
      return;
    }
    if (!hasContent || !state.currentThreadId) return;
    var pending = makePendingMessage(text, images);
    var waitingForTaskCreation = taskNeedsCreation(task);
    var likelyQueued = shouldQueueComposerSubmission(
      task,
      visibleRunSummary,
      state.queuedMessages,
      state.pendingApproval,
      waitingForTaskCreation
    );
    pending.displayInTranscript = !likelyQueued;
    if (waitingForTaskCreation) {
      pending.waitingForTaskCreation = true;
      pending.status = task.localCreationState === "failed"
        ? "waiting_task_retry"
        : "creating_task";
    }
    state.composerRevision += 1;
    state.pendingMessages.push(pending);
    if (task && task.localCreationState === "ready") finishLocalTaskDraft(task.threadId);
    composerInput.value = "";
    clearComposerDraft(state.currentAdapter, state.currentThreadId);
    state.pendingImages = [];
    renderPendingImages();
    resizeComposer();
    renderQueuedMessages(state.queuedMessages);
    renderMessages(true);
    if (!waitingForTaskCreation) {
      submitPendingMessage(pending);
    } else if (task.localCreationState === "failed") {
      pending.status = "creating_task";
      void createTask(task.localSourceThreadId || "", task.projectName || "", task);
    }
  });

  authForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    var password = authPassword.value;
    if (!password) return;
    authSubmit.disabled = true;
    authError.textContent = "";
    try {
      await authApi(state.authMode === "setup" ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: password })
      });
      try { sessionStorage.removeItem("codexMobileSetup"); } catch (_) {}
      state.setupToken = "";
      void startAuthenticatedApp();
    } catch (error) {
      authError.textContent = error.message || "验证失败，请重试。";
      authPassword.select();
    } finally {
      authSubmit.disabled = false;
    }
  });

  composerModelButton.addEventListener("click", function () {
    var modelState = currentTaskModelState();
    if (!modelState || !modelState.canChange) {
      showToast(modelState && modelState.unavailableReason || "当前任务暂时不能切换模型");
      return;
    }
    state.modelMenuOpen = !state.modelMenuOpen;
    closeReasoningMenu();
    closePermissionMenu();
    renderModelControl();
  });

  composerReasoningButton.addEventListener("click", function () {
    var modelState = currentTaskModelState();
    if (!modelState || !modelState.canChangeReasoningEffort) {
      showToast(modelState && modelState.reasoningEffortUnavailableReason || "当前模型没有可选推理强度");
      return;
    }
    state.reasoningMenuOpen = !state.reasoningMenuOpen;
    closeModelMenu();
    closePermissionMenu();
    renderReasoningControl();
  });

  composerPermissionButton.addEventListener("click", function () {
    var permissionState = currentTaskPermissionState();
    if (!permissionState || !permissionState.canChange) {
      showToast(permissionState && permissionState.unavailableReason || "当前任务暂时不能切换权限范围");
      return;
    }
    state.permissionMenuOpen = !state.permissionMenuOpen;
    closeModelMenu();
    closeReasoningMenu();
    renderPermissionControl();
  });

  composerImageButton.addEventListener("click", function () {
    if (state.editingQueuedMessageId) {
      showToast("编辑待发送消息时暂不支持增减图片");
      return;
    }
    composerImageInput.click();
  });
  composerImageInput.addEventListener("change", function () {
    if (state.editingQueuedMessageId) {
      composerImageInput.value = "";
      showToast("编辑待发送消息时暂不支持增减图片");
      return;
    }
    void addImageFiles(composerImageInput.files);
    composerImageInput.value = "";
  });
  composerInput.addEventListener("paste", function (event) {
    var clipboard = event.clipboardData;
    if (!clipboard) return;
    var files = Array.prototype.slice.call(clipboard.files || []).filter(function (file) {
      return file.type && file.type.indexOf("image/") === 0;
    });
    if (!files.length && clipboard.items) {
      files = Array.prototype.slice.call(clipboard.items).flatMap(function (item) {
        if (item.kind !== "file" || item.type.indexOf("image/") !== 0) return [];
        var file = item.getAsFile();
        return file ? [file] : [];
      });
    }
    if (!files.length) return;
    if (state.editingQueuedMessageId) {
      showToast("编辑待发送消息时暂不支持增减图片");
      return;
    }
    event.preventDefault();
    var plainText = clipboard.getData("text/plain");
    if (plainText) insertComposerText(plainText);
    void addImageFiles(files);
  });

  authLogout.addEventListener("click", async function () {
    toggleWorkspaceMenu(false);
    closeTaskContextMenu();
    closeTaskRenameDialog(true);
    setSettingsOpen(false, false);
    try { await fetchJson("/api/auth/logout", { method: "POST" }); } catch (_) {}
    state.taskRequestId += 1;
    state.messageRequestId += 1;
    state.composerRevision += 1;
    state.tasks = [];
    state.currentThreadId = "";
    state.serverMessages = [];
    state.historyMessages = [];
    state.latestMessages = [];
    state.oldestMessageCursor = null;
    state.hasOlderMessages = false;
    state.loadingOlderMessages = false;
    state.historyRequestId += 1;
    state.progressItems = [];
    state.optimisticProgressTurnId = null;
    state.pendingMessages = [];
    state.messageNodes = Object.create(null);
    state.queuedMessages = [];
    state.editingQueuedMessageId = "";
    state.editingQueuedImageCount = 0;
    state.queueActionMessageId = "";
    state.adapters = [];
    state.currentAdapter = "codex";
    state.switchingAdapter = false;
    state.switchingAdapterId = "";
    state.switchStartedAtMs = 0;
    updateActiveDocumentTitle();
    state.adapterError = "";
    state.pendingImages = [];
    state.conversationSnapshots = Object.create(null);
    state.conversationSnapshotOrder = [];
    state.composerDrafts = Object.create(null);
    state.composerDraftOrder = [];
    state.localTaskDrafts = Object.create(null);
    state.taskSnapshots = Object.create(null);
    state.taskSnapshotOrder = [];
    state.persistentCacheRestored = false;
    state.cachePreviewMode = false;
    state.persistentCacheAuthenticatedAtMs = 0;
    if (state.authenticationRetryTimer) clearTimeout(state.authenticationRetryTimer);
    state.authenticationRetryTimer = null;
    composerInput.value = "";
    composerInput.placeholder = "有问题，尽管问";
    composerImageButton.disabled = false;
    renderPendingImages();
    state.runSummary = null;
    state.localRunSummary = null;
    state.pendingApproval = null;
    state.approvalResults = [];
    state.resolvingApproval = false;
    state.stopRequestedThreadId = "";
    clearPersistentMobileCache();
    showAuthentication("login", "已退出。", false);
  });

  composerInput.addEventListener("input", function () {
    if (!state.editingQueuedMessageId) {
      saveComposerDraft(state.currentAdapter, state.currentThreadId);
    }
    resizeComposer();
  });
  composerInput.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.editingQueuedMessageId) {
      event.preventDefault();
      cancelQueuedMessageEdit();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      composerForm.requestSubmit();
    }
  });
  taskContextRename.addEventListener("click", openTaskRenameDialog);
  taskContextCopyId.addEventListener("click", function () { void copyContextTaskId(); });
  taskRenameCancel.addEventListener("click", function () { closeTaskRenameDialog(); });
  taskRenameOverlay.addEventListener("click", function (event) {
    if (event.target === taskRenameOverlay) closeTaskRenameDialog();
  });
  taskRenameForm.addEventListener("submit", function (event) {
    event.preventDefault();
    void renameTaskFromDialog();
  });
  taskViewProjects.addEventListener("click", function () { setTaskView("projects"); });
  taskViewRecent.addEventListener("click", function () { setTaskView("recent"); });
  searchInput.addEventListener("input", renderTasks);
  window.addEventListener("resize", function () {
    syncComposerInset();
    closeTaskContextMenu();
    positionWorkspaceMenu();
  });
  window.addEventListener("orientationchange", function () {
    requestAnimationFrame(positionWorkspaceMenu);
  });
  taskList.addEventListener("scroll", closeTaskContextMenu, { passive: true });
  messagesEl.addEventListener("scroll", function () {
    updateUserMessageNavigation();
    if (messagesEl.scrollTop < 120) void loadOlderMessages();
  });
  previousUserMessage.addEventListener("click", function () {
    navigateToUserMessage(Number(previousUserMessage.dataset.messageIndex));
  });
  nextUserMessage.addEventListener("click", function () {
    navigateToUserMessage(Number(nextUserMessage.dataset.messageIndex));
  });
  workspaceSwitcher.addEventListener("click", function () { toggleWorkspaceMenu(); });
  taskBoardOpen.addEventListener("click", function () {
    setTaskBoardOpen(!state.boardOpen, true);
  });
  taskBoardMenuButton.addEventListener("click", function () {
    app.classList.add("sidebar-open");
  });
  taskBoardRefresh.addEventListener("click", function () {
    void loadTaskBoard(true);
  });
  taskBoardViewActive.addEventListener("click", function () {
    setTaskBoardView("active", true);
  });
  taskBoardViewCompleted.addEventListener("click", function () {
    setTaskBoardView("completed", true);
  });
  taskBoardSearch.addEventListener("input", renderTaskBoard);
  newTaskButton.addEventListener("click", function () {
    void createTask("", "");
  });
  taskList.addEventListener("selectstart", function (event) {
    event.preventDefault();
  });
  messagesEl.addEventListener("selectstart", function (event) {
    rememberMessageSelectionScope(event);
    closeTaskContextMenu();
  });
  messagesEl.addEventListener("contextmenu", function (event) {
    rememberMessageSelectionScope(event);
    closeTaskContextMenu();
  });
  messagesEl.addEventListener("pointerdown", closeTaskContextMenu);
  document.addEventListener("pointerdown", rememberMessageSelectionScope, true);
  document.addEventListener("touchstart", rememberMessageSelectionScope, {
    capture: true,
    passive: true
  });
  document.addEventListener("selectionchange", function () {
    if (!hasActiveTextSelection()) return;
    if (!taskContextMenu.hidden) {
      clearActiveTextSelection();
      return;
    }
    if (
      clampingMessageSelection ||
      !activeMessageSelectionScope ||
      !activeMessageSelectionScope.isConnected
    ) return;
    clampingMessageSelection = true;
    try {
      clampSelectionToMessageContent(
        window.getSelection && window.getSelection(),
        activeMessageSelectionScope
      );
    } finally {
      clampingMessageSelection = false;
    }
  });
  document.addEventListener("click", function (event) {
    if (!workspaceMenu.hidden && !workspaceMenu.contains(event.target) && !workspaceSwitcher.contains(event.target)) {
      toggleWorkspaceMenu(false);
    }
    if (
      state.modelMenuOpen &&
      !composerModelMenu.contains(event.target) &&
      !composerModelButton.contains(event.target)
    ) closeModelMenu();
    if (
      state.reasoningMenuOpen &&
      !composerReasoningMenu.contains(event.target) &&
      !composerReasoningButton.contains(event.target)
    ) closeReasoningMenu();
    if (
      state.permissionMenuOpen &&
      !composerPermissionMenu.contains(event.target) &&
      !composerPermissionButton.contains(event.target)
    ) closePermissionMenu();
    if (!taskContextMenu.hidden && !taskContextMenu.contains(event.target)) {
      closeTaskContextMenu();
    }
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      if (imageViewer && !imageViewer.hidden) {
        event.preventDefault();
        closeImageViewer();
        return;
      }
      if (!taskRenameOverlay.hidden) {
        event.preventDefault();
        closeTaskRenameDialog();
        return;
      }
      closeTaskContextMenu();
      closeModelMenu();
      closeReasoningMenu();
      closePermissionMenu();
      toggleWorkspaceMenu(false);
    }
  });
  document.getElementById("menu-button").addEventListener("click", function () { app.classList.add("sidebar-open"); });
  document.getElementById("sidebar-close").addEventListener("click", closeSidebar);
  document.getElementById("sidebar-overlay").addEventListener("click", closeSidebar);
  settingsOpen.addEventListener("click", function () {
    setSettingsOpen(true, true);
  });
  settingsMenuButton.addEventListener("click", function () { app.classList.add("sidebar-open"); });

  function scheduleLiveRefresh(delayMs) {
    if (!state.authenticated) return;
    if (state.liveRefreshTimer) clearTimeout(state.liveRefreshTimer);
    state.liveRefreshTimer = setTimeout(async function () {
      if (await checkForAppUpdate(false)) return;
      var refreshes = state.settingsOpen
        ? []
        : state.boardOpen
        ? Date.now() - state.boardLastLoadedAtMs >= TASK_REFRESH_INTERVAL_MS
          ? [loadTaskBoard(false)]
          : []
        : [
            refreshMessagesIfChanged(false, false),
            loadCurrentTaskModel(false),
            loadCurrentTaskPermission(false)
          ];
      if (!state.boardOpen && Date.now() >= state.nextTaskRefreshAtMs) {
        refreshes.push(loadTasks(false));
      }
      await Promise.all(refreshes);
      scheduleLiveRefresh(document.hidden ? 10000 : 2200);
    }, delayMs);
  }

  window.addEventListener("pageshow", function () {
    void checkForAppUpdate(true);
  });

  window.addEventListener("pagehide", function () {
    saveCurrentConversationSnapshot();
    persistMobileCacheNow();
  });

  document.addEventListener("visibilitychange", function () {
    if (!state.authenticated) return;
    if (!document.hidden) {
      void (async function () {
        if (await checkForAppUpdate(true)) return;
        state.nextTaskRefreshAtMs = 0;
        if (state.settingsOpen) await Promise.all([loadTasks(false), loadSettings()]);
        else if (state.boardOpen) await loadTaskBoard(true);
        else await Promise.all([
          loadTasks(false),
          refreshMessagesIfChanged(false, true),
          loadCurrentTaskModel(true),
          loadCurrentTaskPermission(true)
        ]);
      })();
    }
    scheduleLiveRefresh(document.hidden ? 10000 : 300);
  });

  updateDocumentTitle();
  async function startMobileApplication() {
    restoreTrustedPersistentMobileCachePreview();
    void waitForComputerConnection();
    await initializeAuthentication();
  }
  void startMobileApplication();
})();
`;

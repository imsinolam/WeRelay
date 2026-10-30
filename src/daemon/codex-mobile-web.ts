import { CHAT_COMPONENTS_JS, renderChatComposerHtml } from "../web/chat-components/index.ts";
import { MESSAGE_BUBBLE_CSS, MESSAGE_MEDIA_CSS, CHAT_PROGRESS_CSS, CHAT_PENDING_CSS, CHAT_TEXT_CSS, CHAT_COMPOSER_CSS, CHAT_MOBILE_CSS, CHAT_SMALL_CSS, CHAT_DARK_CSS } from "../web/chat-components/styles.ts";
import { AGENT_BRAND_ICON_DATA } from "./agent-brand-icons.ts";
import { normalizeMobileMessageText } from "./mobile-message-text.ts";
import {
  WE_RELAY_LOGO_DARK_DATA_URI,
  WE_RELAY_LOGO_LIGHT_DATA_URI,
} from "./codex-mobile-brand.ts";

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
      <div class="boot-wordmark brand-logo" role="img" aria-label="WeRelay" style="--brand-logo-width: 132px"></div>
      <canvas class="boot-orb" id="boot-orb" role="img" aria-label="正在处理" width="56" height="56"></canvas>
      <div class="boot-status" id="boot-status" role="status"><span id="boot-status-text">正在连接电脑</span></div>
      <div class="boot-detail" id="boot-detail" hidden></div>
    </div>
  </section>

  <section class="auth-screen" id="auth-screen" aria-labelledby="auth-title" hidden>
    <div class="auth-card">
      <a class="auth-wordmark brand-logo" href="/about" aria-label="查看 WeRelay 项目说明" style="--brand-logo-width: 132px"></a>
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
            <span class="workspace-adapter" id="active-adapter-label">Codex</span>
            <span class="workspace-divider" aria-hidden="true">·</span>
            <span class="workspace-product brand-logo" role="img" aria-label="WeRelay" style="--brand-logo-width: 64px"></span>
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
        <div class="local-address-entry" id="local-address-entry" hidden>
          <span>电脑本机入口</span><button type="button" id="local-address-copy"></button>
        </div>
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
      <a class="workspace-menu-item" href="/organizer" role="menuitem">整理会话</a>
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
            <p>远程访问、任务审批与电脑终端</p>
          </div>
        </header>
        <nav class="settings-tabs" aria-label="设置分类">
          <button type="button" data-settings-tab="remote" aria-pressed="true">远程访问</button>
          <button type="button" data-settings-tab="tasks" aria-pressed="false">任务与审批</button>
          <button type="button" data-settings-tab="providers" aria-pressed="false">电脑终端</button>
        </nav>
        <div class="settings-body" id="settings-body">
          <div class="settings-loading" id="settings-loading">正在读取设置…</div>
        </div>
      </section>

      <section class="messages" id="messages" aria-live="polite">
        <div class="empty-state" id="empty-state">
          <div class="empty-wordmark brand-logo" role="img" aria-label="WeRelay" style="--brand-logo-width: 150px"></div>
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

${renderChatComposerHtml()}    </main>
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
    <a class="about-logo brand-logo" href="/about" role="img" aria-label="WeRelay 项目说明" style="--brand-logo-width: 104px"></a>
    <a class="about-open-app" href="/">打开任务</a>
  </header>

  <main class="about-main">
    <section class="about-hero">
      <div class="about-eyebrow">同一条真实任务，延伸到每一块屏幕</div>
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
      <p>任务和 Agent 仍然运行在你的电脑上。WeRelay 只在你授权的入口之间传递必要的信息。移动网页使用独立访问密码；公网访问可通过 WeRelay 应用层主动中继提供，电脑不需要暴露本地端口。</p>
    </section>

    <footer class="about-footer">
      <div>
        <strong>WeRelay</strong>
        <span>让真实的本地 Agent 任务，随时在你手边继续。</span>
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
  --composer-action-ground: #202020;
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
/* 品牌字标：使用与官网同一张字标图（黑字 + 绿弧），暗色模式换用反相版。
   宽度用 em 跟随各处字号，高度按原图 3.84:1 自动推导，避免变形。 */
.brand-logo {
  display: block;
  width: var(--brand-logo-width, 7em);
  height: auto;
  aspect-ratio: 384 / 100;
  background: url("${WE_RELAY_LOGO_LIGHT_DATA_URI}") center / contain no-repeat;
  color: transparent;
  text-indent: -9999px;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}
/* 思考球：纯 canvas 点阵动画，无外框、无底色，随主题自动切换墨色。 */
.boot-orb { width: 56px; height: 56px; display: block; margin: 6px 0 2px; }
@keyframes solving-shimmer { 0% { background-position: 120% 0; } 100% { background-position: -120% 0; } }
@keyframes solving-dot { 0%, 60%, 100% { opacity: .2; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-1px); } }
.boot-status { display: inline-flex; align-items: baseline; gap: 3px; margin-top: 8px; color: var(--text); font-size: 14px; font-weight: 570; line-height: 1.5; text-align: center; }
.boot-detail { max-width: 300px; color: var(--muted); font-size: 12px; line-height: 1.6; text-align: center; text-wrap: balance; }
.boot-detail[hidden] { display: none; }
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
.sidebar-head .workspace-product.brand-logo { flex: 0 0 auto; width: 64px; }
.workspace-divider { flex: 0 0 auto; color: var(--muted); font-size: 13px; white-space: nowrap; }
.workspace-adapter { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 19px; font-weight: 700; color: var(--text); }
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
.settings-tabs { display: flex; gap: 5px; padding: 10px max(24px, calc((100% - 820px) / 2)); border-bottom: 1px solid var(--border); }
.settings-tabs button { flex: 1; min-height: 40px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
.settings-tabs button[aria-pressed="true"] { background: var(--surface); color: var(--text); font-weight: 650; }
.settings-tabs button:focus-visible, .settings-provider-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.local-address-entry { margin: 6px 14px; font-size: 11px; color: var(--muted); }
.local-address-entry[hidden] { display: none; }
.local-address-entry button { display: block; max-width: 100%; padding: 5px 0; border: 0; background: none; color: var(--text); font: inherit; overflow-wrap: anywhere; text-align: left; cursor: pointer; }
.remote-intro { padding: 16px 18px; border-radius: 12px; background: var(--surface); line-height: 1.7; font-size: 13px; }
.remote-intro h2 { margin: 0 0 5px; font-size: 16px; }
.remote-intro ol { margin-bottom: 0; padding-left: 20px; }
.remote-status { margin: 15px 0; color: var(--muted-strong); font-size: 13px; overflow-wrap: anywhere; }
.remote-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 15px 0; }
.remote-action { padding: 9px 13px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
.remote-action.is-primary { background: var(--text); color: var(--page); }
.remote-action:disabled { opacity: .5; cursor: default; }
.remote-form[hidden] { display: none; }
.remote-form { display: grid; gap: 14px; margin: 16px 0; }
.remote-form label { display: grid; gap: 5px; font-size: 13px; font-weight: 580; }
.remote-form input { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--page); color: var(--text); font: inherit; }
.remote-help { color: var(--muted); font-size: 12px; line-height: 1.7; font-weight: 400; }
.remote-help summary { cursor: pointer; }
.remote-feedback { min-height: 20px; font-size: 13px; overflow-wrap: anywhere; }
.remote-feedback.is-error { color: #b42318; }
.remote-local-setting { padding-top: 15px; border-top: 1px solid var(--border); }
.settings-provider-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; align-items: start; }
.settings-provider-grid .settings-provider { position: relative; min-width: 0; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.settings-provider-grid .settings-provider[open] { z-index: 2; }
.settings-provider-grid .settings-provider-head { display: flex; align-items: center; min-height: 55px; padding: 10px; cursor: pointer; list-style: none; gap: 6px; }
.settings-provider-grid .settings-provider-head::-webkit-details-marker { display: none; }
.settings-provider-grid .settings-provider-icon { display: grid; place-items: center; flex: 0 0 24px; height: 24px; border-radius: 6px; background: #fff; overflow: hidden; }
.settings-provider-grid .settings-provider-icon img { display: block; width: 21px; height: 21px; object-fit: contain; }
.settings-provider-grid .settings-provider-name { font-size: 13px; overflow-wrap: anywhere; }
.settings-provider-grid .settings-provider-status { margin-left: auto; text-align: right; font-size: 11px; }
.settings-provider-grid .settings-provider-detail { position: absolute; top: calc(100% + 3px); left: -1px; width: calc(100% + 2px); box-sizing: border-box; max-height: min(55dvh, 420px); overflow-y: auto; padding: 12px 14px 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--page); box-shadow: 0 12px 30px rgba(0,0,0,.16); }
.settings-provider-grid .settings-provider.is-above .settings-provider-detail { top: auto; bottom: calc(100% + 3px); }
@media (min-width: 1100px) { .settings-provider-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 359px) { .settings-provider-grid { grid-template-columns: 1fr; } }
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
.task-board-card-list { display: grid; gap: 8px; }
.task-board-card {
  position: relative;
  width: 100%;
  min-height: 96px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
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
.task-board-card-title { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: var(--text); font-size: 14px; font-weight: 560; line-height: 1.42; overflow-wrap: anywhere; }
.task-board-card-meta { margin-top: auto; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 3px 10px; min-width: 0; color: var(--muted); font-size: 11px; }
.task-board-card-status { display: inline-flex; align-items: center; gap: 5px; min-width: 0; white-space: nowrap; }
.task-board-card-status-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: currentColor; }
.task-board-card[data-lane="running"] .task-board-card-status { color: var(--green); }
.task-board-card[data-lane="waiting"] .task-board-card-status { color: var(--orange); }
.task-board-card[data-lane="error"] .task-board-card-status { color: var(--red); }
.task-board-card-context { grid-column: 1 / -1; min-width: 0; overflow: hidden; color: var(--muted-strong); font-weight: 520; text-overflow: ellipsis; white-space: nowrap; }
.task-board-card-time { grid-column: 2; grid-row: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
.task-board-column-empty { min-height: 88px; display: grid; place-items: center; padding: 16px; border: 1px dashed var(--border-strong); border-radius: 14px; color: var(--muted); font-size: 12px; text-align: center; }
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
.task-board-skeleton-card { height: 98px; }
@keyframes board-skeleton-pulse { 0%, 100% { opacity: .58; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .task-board-refresh.is-loading svg, .task-board-skeleton-line, .task-board-skeleton-card { animation: none; }
  .task-board-card, .sidebar-primary-button { transition: none; }
}
.new-task-button:disabled { opacity: .36; cursor: default; }
.menu-button svg,
.task-board-menu-button svg,
.settings-menu-button svg,
.new-task-button svg { width: 28px; height: 28px; stroke-width: 1.8; }
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
${MESSAGE_BUBBLE_CSS}
.run-header { width: min(100%, var(--thread-max)); display: flex; align-items: center; gap: 9px; margin: -4px auto 13px; color: var(--muted-strong); font-size: 13px; font-weight: 560; }
.run-header-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--green); }
.run-header.running .run-header-dot, .run-header.submitting .run-header-dot, .run-header.syncing .run-header-dot, .run-header.sending .run-header-dot { animation: run-pulse 1.4s ease-in-out infinite; }
.run-header.approval .run-header-dot { background: var(--orange); }
.run-header.unknown .run-header-dot { background: var(--muted); }
.run-header.failed .run-header-dot, .run-header.interrupted .run-header-dot { background: var(--red); }
.run-failure { width: min(100%, var(--thread-max)); margin: -2px auto 18px; padding: 12px 14px; border: 1px solid rgba(196, 55, 55, .18); border-radius: 12px; background: rgba(196, 55, 55, .055); color: var(--text); font-size: 13px; line-height: 1.6; }
.run-failure-title { margin-bottom: 3px; color: var(--red); font-weight: 620; }
.run-failure-detail { color: var(--muted-strong); white-space: pre-wrap; }
@keyframes run-pulse { 0%, 100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
${CHAT_PROGRESS_CSS}
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
${MESSAGE_MEDIA_CSS}
${CHAT_PENDING_CSS}
${CHAT_TEXT_CSS}
.loading-row { padding: 30px 16px; color: var(--muted); text-align: center; font-size: 13px; }
.empty-state { min-height: 62vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; color: var(--muted); }
.empty-wordmark { color: var(--text); font-size: 30px; font-weight: 560; letter-spacing: -0.035em; line-height: 1; }
.empty-state h1 { margin: 18px 0 6px; color: var(--text); font-size: 20px; font-weight: 580; letter-spacing: -0.02em; }
.empty-state p { margin: 0; max-width: 300px; font-size: 14px; line-height: 1.55; }

${CHAT_COMPOSER_CSS}
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
${CHAT_MOBILE_CSS}
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
  .task-board-card-list { gap: 7px; }
  .task-board-card { min-height: 0; gap: 9px; padding: 11px 13px; }
  .task-board-card-title { -webkit-line-clamp: 2; font-size: 15px; line-height: 1.38; }
  .task-board-card-meta { gap: 3px 10px; font-size: 12px; }
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
  .message-navigation { left: auto; top: calc(64px + env(safe-area-inset-top)); right: 16px; bottom: auto; }
  .task-rename-overlay { align-items: flex-end; padding: 12px 12px max(12px, env(safe-area-inset-bottom)); }
  .task-rename-dialog { padding: 20px; border-radius: 18px; }
}

@media (max-width: 360px) {
${CHAT_SMALL_CSS}
  .topbar-title { display: none; }
  .messages { padding-left: 14px; padding-right: 14px; }
}

@media (prefers-color-scheme: dark) {
${CHAT_DARK_CSS}
  /* 暗色底上换用反相字标，字形为浅色、绿弧保持品牌绿。 */
  .brand-logo { background-image: url("${WE_RELAY_LOGO_DARK_DATA_URI}"); }
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
    --composer-action-ground: #303030;
    --shadow: 0 12px 40px rgba(0,0,0,.36);
  }
  .auth-submit { color: #212121; }
  .auth-field input { background: #2a2a2a; }
  .auth-field input:focus { border-color: rgba(255,255,255,.34); box-shadow: 0 0 0 3px rgba(255,255,255,.06); }
  .auth-security-warning { color: #e7a363 !important; }
  .about-topbar { background: rgba(33,33,33,.88); }
  .topbar { background: rgba(33,33,33,.88); }
  .message-navigation-button { background: rgba(33,33,33,.72); }
  .message-navigation-button:hover { background: rgba(47,47,47,.94); }
  .icon-button:active { background: #333; }
  .task-board-search:focus-within { border-color: rgba(255,255,255,.24); box-shadow: 0 0 0 3px rgba(255,255,255,.05); }
  .task-board-view-button.is-active { box-shadow: 0 1px 3px rgba(0,0,0,.32); }
  .task-board-card:hover { box-shadow: 0 8px 22px rgba(0,0,0,.22); }
}
`;

export const CODEX_MOBILE_APP_JS = String.raw`
(function () {
  "use strict";

  var AGENT_BRAND_ICON_DATA = ${JSON.stringify(AGENT_BRAND_ICON_DATA)};
  var normalizeMobileMessageText = ${normalizeMobileMessageText.toString()};

  var app = document.getElementById("app");
  var bootScreen = document.getElementById("boot-screen");
  var bootOrb = document.getElementById("boot-orb");
  var bootStatus = document.getElementById("boot-status");
  var bootStatusText = document.getElementById("boot-status-text");
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
  var chatText = WeRelayChatUI.createText({ resolveLink: function (target) {
    var local = isLocalPreviewTarget(target);
    return { href: local ? "/preview/open?target=" + encodeURIComponent(target) : target, localPreview: local };
  } });
  var messageBubble = WeRelayChatUI.createMessageBubble({ document: document, text: chatText, actions: {
    onRetry: function (id) { retryPendingMessage(id); },
    onCopy: function (text) { void copyMessageText(text); },
    onOpenImage: openImageViewer
  } });
  var composerView = WeRelayChatUI.createComposer(composerForm, { actions: {
    onSubmit: submitComposer,
    onInput: function () {
      state.composerRevision += 1;
      if (state.nativeComposerDraft) state.nativeComposerDraft.awaitingValidation = false;
      if (!state.editingQueuedMessageId) saveComposerDraft(state.currentAdapter, state.currentThreadId);
      resizeComposer();
    },
    onEscape: function (event) {
      if (state.editingQueuedMessageId) { event.preventDefault(); cancelQueuedMessageEdit(); }
    },
    canAttach: function () {
      if (!state.editingQueuedMessageId) return true;
      showToast("编辑待发送消息时暂不支持增减图片"); return false;
    },
    onInsertText: insertComposerText,
    onFiles: function (files) { void addImageFiles(files); },
    onOpenImage: openImageViewer,
    onImageRemove: function (id) {
      state.pendingImages = state.pendingImages.filter(function (image) { return image.id !== id; });
      renderPendingImages(); updateHeader();
    },
    onQueueSteer: function (id) { void steerQueuedMessage(id); },
    onQueueEdit: beginQueuedMessageEdit,
    onQueueDelete: function (id) { void deleteQueuedMessage(id); },
    onModelSelect: function (id) { void selectCurrentTaskModel(id); },
    onModelGroup: function (group) { state.activeModelGroup = group; renderModelControl(); },
    onSettingSelect: function (kind, id) {
      if (kind === "reasoning") void selectCurrentTaskReasoningEffort(id);
      else void selectCurrentTaskPermission(id);
    },
    onToggleMenu: function (kind) { if (kind === "model") toggleComposerModel(); else toggleComposerSession(); },
    onCloseMenu: function (kind) { if (kind === "model") closeModelMenu(); else closeSessionMenu(); },
    onResize: syncComposerInset
  } });

  var composerInput = composerView.part("composer-input");
  var composerImageButton = composerView.part("composer-image-button");
  var messageNavigation = document.getElementById("message-navigation");
  var previousUserMessage = document.getElementById("previous-user-message");
  var nextUserMessage = document.getElementById("next-user-message");
  var toastEl = document.getElementById("toast");
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
  var settingsTab = "remote";
  var settingsEpoch = 0;
  var settingsExpandedProviders = Object.create(null);
  var remoteRefreshTimer = null;

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
    revealCurrentTaskOnSidebarOpen: false,
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
    taskSettingSync: null,
    modelMenuOpen: false,
    activeModelGroup: null,
    reasoningChanging: false,
    sessionMenuOpen: false,
    taskPermissions: Object.create(null),
    permissionRequestId: 0,
    permissionChanging: false,
    serverMessages: [],
    outboundMessages: [],
    deliveredClientIds: [],
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
    messageRenderRevision: 0,
    scrollIntentRevision: 0,
    entryFocusKey: "",
    entryFocusGeneration: 0,
    composerRevision: 0,
    nativeComposerDraft: null,
    nativeComposerDraftRequest: 0,
    nativeComposerDraftConsumed: Object.create(null),
    sending: false,
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

  function formatClockTime(timestampMs, nowMs) {
    if (!Number.isFinite(timestampMs)) return "";
    var date = new Date(timestampMs);
    var now = new Date(Number(nowMs || Date.now()));
    var clock = ("0" + date.getHours()).slice(-2) + ":" + ("0" + date.getMinutes()).slice(-2);
    var sameDay = date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    if (sameDay) return clock;
    var yesterday = new Date(now.getTime());
    yesterday.setDate(yesterday.getDate() - 1);
    var isYesterday = date.getFullYear() === yesterday.getFullYear() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getDate() === yesterday.getDate();
    if (isYesterday) return "昨天 " + clock;
    return (date.getMonth() + 1) + " 月 " + date.getDate() + " 日 " + clock;
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

  // 没有项目归属的「最近」分组：只要该终端能直接新建任务就允许。
  // Grok 等只提供 createSession、没有项目的终端此前完全没有新建入口。
  function recentTaskCreationSource(tasks) {
    var supported = (Array.isArray(tasks) ? tasks : []).filter(function (task) {
      return task && task.canCreateTask === true;
    });
    return supported[0] || null;
  }

  function conversationStateKey(adapterId, threadId) {
    return String(adapterId || "") + "\u0000" + String(threadId || "");
  }

  var PERSISTENT_MOBILE_CACHE_STORAGE_NAME = "werelayMobileCacheV1";
  var PERSISTENT_MOBILE_CACHE_SCHEMA_VERSION = 1;
  // Old lists did not carry origins and may contain internal reviews. Invalidate
  // only those indexes once, preserving conversation cache and unsent drafts.
  var PERSISTENT_TASK_LIST_POLICY_VERSION = 1;
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
      "canCreateInProject", "canCreateTask", "localCreationState", "localCreationError",
      "localSourceThreadId", "newTaskSettings"
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
        if (isTaskBoardInProgress(item)) active.push(item);
        else if (item.completedAt || item.completedAtMs) completed.push(item);
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
      "status", "pending", "clientId", "imageCount", "attempts", "browserAttempts",
      "lastError", "waitingForTaskCreation", "createTaskSourceThreadId", "displayInTranscript",
      "adapter", "threadId", "imageStoreKey", "retryAtMs", "retryBlocked", "serverAcknowledged",
      "deliveryConfirmed", "queuedMessageId", "queueMissing", "baselineUserKeys", "baselineUserCount", "sourceMessageId", "newTaskSettings", "requiredTaskSettings", "composerDraftRevision"
    ].forEach(function (key) {
      if (message[key] !== undefined) sanitized[key] = message[key];
    });
    if (message.role === "task" && message.sourceTask &&
        typeof message.sourceTask.adapter === "string" && typeof message.sourceTask.sessionId === "string") {
      sanitized.sourceTask = { adapter: message.sourceTask.adapter, sessionId: message.sourceTask.sessionId };
    }
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
      "errorMessage", "model", "clientId", "baselineTurnId"
    ].forEach(function (key) {
      if (summary[key] !== undefined) sanitized[key] = summary[key];
    });
    return sanitized;
  }

  function sanitizeDeliveredClientIds(ids) {
    return Array.isArray(ids) ? ids.filter(function (id) { return typeof id === "string" && id.length <= 128; }).slice(-500) : [];
  }

  function sanitizePersistentConversationSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return null;
    var messages = sanitizePersistentMessages(snapshot.serverMessages);
    return {
      serverMessages: messages,
      outboundMessages: sanitizePersistentMessages(snapshot.outboundMessages),
      deliveredClientIds: sanitizeDeliveredClientIds(snapshot.deliveredClientIds),
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
      pendingMessages: sanitizePersistentMessages(snapshot.pendingMessages).map(function (message) {
        if (Number(message.imageCount) > 0 && !message.imageStoreKey && (!Array.isArray(message.images) || !message.images.length)) {
          message.status = "failed";
          message.retryBlocked = true;
          message.lastError = "旧版缓存未保留图片原件，请重新添加图片；后续消息仍可发送。";
        }
        return message;
      }),
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
      localRunSummary: snapshot.localRunSummary && ["submitting", "syncing"].includes(snapshot.localRunSummary.status)
        ? sanitizePersistentRunSummary(snapshot.localRunSummary) : null,
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
        if (!draft || typeof draft.text !== "string" || !draft.text && !draft.nativeRevision) return false;
        composerDrafts[key] = Object.assign({}, draft);
        return true;
      });
    return {
      schemaVersion: PERSISTENT_MOBILE_CACHE_SCHEMA_VERSION,
      taskListPolicyVersion: PERSISTENT_TASK_LIST_POLICY_VERSION,
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
      nativeComposerDraftConsumed: state.nativeComposerDraftConsumed,
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
    if (threadId) beginConversationEntryFocus(adapterId, threadId);
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
    var taskListsCompatible = payload.taskListPolicyVersion === PERSISTENT_TASK_LIST_POLICY_VERSION;
    var taskSnapshotSource = taskListsCompatible && payload.taskSnapshots && typeof payload.taskSnapshots === "object"
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
      if (!draft || typeof draft.text !== "string" || !draft.text && !draft.nativeRevision) return;
      state.composerDrafts[key] = Object.assign({}, draft);
      state.composerDraftOrder.push(key);
    });

    state.nativeComposerDraftConsumed = Object.create(null);
    var consumedSource = payload.nativeComposerDraftConsumed;
    if (consumedSource && typeof consumedSource === "object") Object.keys(consumedSource).slice(-MAX_COMPOSER_DRAFTS).forEach(function (key) {
      if (Array.isArray(consumedSource[key])) state.nativeComposerDraftConsumed[key] = consumedSource[key].filter(function (revision) {
        return typeof revision === "string" && revision.length <= 160;
      }).slice(-8);
    });

    var taskBoard = taskListsCompatible && payload.taskBoard && typeof payload.taskBoard === "object"
      ? payload.taskBoard
      : null;
    state.boardTasks = taskBoard && Array.isArray(taskBoard.tasks)
      ? taskBoard.tasks.map(sanitizePersistentTaskBoardItem).filter(Boolean)
      : [];
    state.boardRecentCompleted = taskBoard && Array.isArray(taskBoard.recentCompleted)
      ? taskBoard.recentCompleted
        .map(sanitizePersistentTaskBoardItem)
        .filter(function (item) {
          return Boolean(item && !isTaskBoardInProgress(item));
        })
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
    setBootScreenVisible(false);
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
    return Boolean(task && isTemporaryTask(task) && String(task.threadId || "").startsWith("local-new-"));
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
    var native = state.nativeComposerDraft && state.nativeComposerDraft.key === key ? state.nativeComposerDraft : null;
    if (native && text !== native.text && !(native.awaitingValidation && !text)) native.edited = true;
    if (!text && native && native.awaitingValidation && !native.edited) text = native.text;
    if (!text && !native) {
      deleteConversationValue(state.composerDrafts, state.composerDraftOrder, key);
      if (!suppressPersistentWrite) schedulePersistentMobileCacheWrite();
      return;
    }
    setBoundedConversationValue(state.composerDrafts, state.composerDraftOrder, key,
      Object.assign({ text: text }, native ? {
        nativeRevision: native.revision, nativeText: native.text,
        nativeEdited: Boolean(native.edited), nativeConflict: Boolean(native.conflict)
      } : {}), MAX_COMPOSER_DRAFTS);
    if (!suppressPersistentWrite) schedulePersistentMobileCacheWrite();
  }

  function restoreComposerDraft(adapterId, threadId) {
    var key = conversationStateKey(adapterId, threadId);
    var draft = getBoundedConversationValue(state.composerDrafts, state.composerDraftOrder, key);
    state.nativeComposerDraft = draft && draft.nativeRevision ? {
      key: key, revision: draft.nativeRevision, text: draft.nativeText || "",
      edited: Boolean(draft.nativeEdited), conflict: Boolean(draft.nativeConflict),
      awaitingValidation: !draft.nativeEdited
    } : null;
    // Revalidate unedited native input before displaying it: it may already be sent.
    composerInput.value = draft && (!draft.nativeRevision || draft.nativeEdited) ? draft.text || "" : "";
  }

  function clearComposerDraft(adapterId, threadId) {
    var key = conversationStateKey(adapterId, threadId);
    deleteConversationValue(state.composerDrafts, state.composerDraftOrder, key);
    if (state.nativeComposerDraft && state.nativeComposerDraft.key === key) state.nativeComposerDraft = null;
    schedulePersistentMobileCacheWrite();
  }

  function isNativeComposerDraftConflict(error) {
    return Boolean(error && error.status === 409 && /草稿.*(?:已发送|已在网页提交|标识冲突|未发送)/.test(error.message || ""));
  }

  function nativeComposerDraftReference() {
    var draft = state.nativeComposerDraft;
    return draft && draft.key === conversationStateKey(state.currentAdapter, state.currentThreadId) ? draft.revision : "";
  }

  function consumeNativeComposerDraft(pending) {
    if (!pending.composerDraftRevision) return;
    var key = conversationStateKey(pending.adapter, pending.threadId);
    if (!state.nativeComposerDraftConsumed) state.nativeComposerDraftConsumed = Object.create(null);
    var revisions = state.nativeComposerDraftConsumed[key] || [];
    if (!revisions.includes(pending.composerDraftRevision)) revisions.push(pending.composerDraftRevision);
    state.nativeComposerDraftConsumed[key] = revisions.slice(-8);
    var keys = Object.keys(state.nativeComposerDraftConsumed);
    if (keys.length > MAX_COMPOSER_DRAFTS) delete state.nativeComposerDraftConsumed[keys[0]];
    if (state.nativeComposerDraft && state.nativeComposerDraft.key === key && state.nativeComposerDraft.revision === pending.composerDraftRevision) {
      state.nativeComposerDraft = null;
    }
  }

  async function loadNativeComposerDraft() {
    if (!state.authenticated || !state.currentThreadId || String(state.currentThreadId).startsWith("local-new-") ||
        state.editingQueuedMessageId || state.preparingMessage) return;
    var adapter = state.currentAdapter;
    var threadId = state.currentThreadId;
    var key = conversationStateKey(adapter, threadId);
    var editRevision = state.composerRevision;
    var textBeforeRead = composerInput.value;
    var request = (state.nativeComposerDraftRequest || 0) + 1;
    state.nativeComposerDraftRequest = request;
    try {
      var payload = await api(adapterApiPath("/api/tasks/" + encodeURIComponent(threadId) + "/composer-draft", adapter), { cache: "no-store" });
      if (request !== state.nativeComposerDraftRequest || adapter !== state.currentAdapter || threadId !== state.currentThreadId ||
          editRevision !== state.composerRevision || textBeforeRead !== composerInput.value || state.editingQueuedMessageId || state.preparingMessage) return;
      if (!payload || !payload.supported) return;
      var incoming = payload.draft;
      if (incoming && (typeof incoming.text !== "string" || typeof incoming.revision !== "string")) return;
      var consumed = state.nativeComposerDraftConsumed && state.nativeComposerDraftConsumed[key] || [];
      var pending = (state.pendingMessages || []).concat(state.outboundMessages || []);
      if (incoming && (consumed.includes(incoming.revision) || pending.some(function (message) {
        return (message.adapter || adapter) === adapter && (message.threadId || threadId) === threadId &&
          message.composerDraftRevision === incoming.revision;
      }))) incoming = null;
      var native = state.nativeComposerDraft && state.nativeComposerDraft.key === key ? state.nativeComposerDraft : null;
      if (native && (native.edited || composerInput.value && composerInput.value !== native.text)) {
        native.edited = true;
        if ((!incoming || native.revision !== incoming.revision) && !native.conflict) {
          native.conflict = true;
          showToast("电脑端草稿已变化，网页修改已保留；发送前需要核对。");
        }
        saveComposerDraft(adapter, threadId);
        return;
      }
      if (!native && (composerInput.value || state.pendingImages.length)) return;
      if (native && incoming && native.revision === incoming.revision && !native.awaitingValidation && composerInput.value === incoming.text) return;
      if (!incoming) {
        if (!native) return;
        composerInput.value = "";
        clearComposerDraft(adapter, threadId);
      } else {
        state.nativeComposerDraft = { key: key, text: incoming.text, revision: incoming.revision, edited: false, conflict: false };
        composerInput.value = incoming.text;
        saveComposerDraft(adapter, threadId);
      }
      state.composerRevision += 1;
      resizeComposer();
    } catch (_) {
      // Connection trouble is not evidence that a desktop draft was cleared.
    }
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
        deliveredClientIds: sanitizeDeliveredClientIds(state.deliveredClientIds),
        outboundMessages: Array.isArray(state.outboundMessages)
          ? state.outboundMessages.slice()
          : [],
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
    state.deliveredClientIds = sanitizeDeliveredClientIds(snapshot.deliveredClientIds);
    state.outboundMessages = Array.isArray(snapshot.outboundMessages)
      ? snapshot.outboundMessages.slice()
      : [];
    state.historyMessages = snapshot.historyMessages.slice();
    state.latestMessages = snapshot.latestMessages.slice();
    state.oldestMessageCursor = snapshot.oldestMessageCursor;
    state.hasOlderMessages = snapshot.hasOlderMessages;
    state.historySource = snapshot.historySource || "";
    state.historyCaughtUp = snapshot.historyCaughtUp !== false;
    state.progressItems = snapshot.progressItems.slice();
    state.optimisticProgressTurnId = snapshot.optimisticProgressTurnId || null;
    state.pendingMessages = snapshot.pendingMessages.map(function (message) {
      return Object.assign({}, message, { adapter: message.adapter || adapterId, threadId: message.threadId || threadId, inFlight: false });
    });
    state.pendingMessages.forEach(function (pending) {
      void restorePendingMessageImages(pending).then(function () {
        if (state.currentAdapter === adapterId && state.currentThreadId === threadId) renderMessages(false);
      }).catch(function () {});
    });
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

  function renderMessageLink(target, label) { return chatText.renderInline("[" + label + "](" + target + ")"); }
  function renderInline(value) { return chatText.renderInline(value); }
  function renderMarkdown(text, foldPrefix) { return chatText.renderMarkdown(text, foldPrefix); }

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

  function isMobileConnectionUnavailable(error) {
    return Boolean(error && (
      error.network ||
      error.status === 503 ||
      error.status === 504
    ));
  }

  function isMobileConnectionUnavailableMessage(text) {
    return /电脑(?:当前)?离线|电脑仍?未连接|请确认 (?:DeskRelay|WeRelay) 正在运行/.test(
      String(text || "")
    );
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
    if (window.WeRelayPlatform) {
      void window.WeRelayPlatform.checkForUpdate(force).catch(function () {});
      return false;
    }
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

  // --- 思考球（启动页加载动画）-----------------------------------------
  // 点阵球体在「打乱 → 复原」之间循环：每条带按四分之一圈转动，随后倒序
  // 回放，让球体咔哒一声回到已复原状态。几何为纯 CPU 数学，仅使用 2D canvas
  // 圆弧填充，因此各浏览器像素一致，且不需要 WebGL 或滤镜。
  //
  // 改编自 thinking-orbs（MIT License, Copyright (c) 2026 Jakub Antalik）
  // https://github.com/Jakubantalik/thinking-orbs —— 取其 solving（rubik）
  // 模式的几何与预设参数，改写为无依赖的纯 JS，并按本站主题取墨色。
  var BOOT_ORB_PRESET = WeRelayChatUI.solvingOrb.preset;
  var bootOrbFrame = WeRelayChatUI.solvingOrb.frame;
  var bootOrbOptions = WeRelayChatUI.solvingOrb.options;
  var bootOrbIsDark = WeRelayChatUI.solvingOrb.isDark;
  var bootOrbAnimation = (function () {
    var raf = 0;
    var running = false;
    var reduced = Boolean(
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
    var ctx = null;
    var size = 56;
    var dpr = 1;

    function paint(tSec) {
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bootOrbFrame(ctx, size, tSec, bootOrbIsDark(), bootOrbOptions());
    }

    function loop() {
      paint((performance.now() / 1000) * BOOT_ORB_PRESET.speed);
      if (running) raf = requestAnimationFrame(loop);
    }

    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    function start() {
      if (!ctx || running || reduced) return;
      if (bootScreen.hidden || document.visibilityState === "hidden") return;
      running = true;
      raf = requestAnimationFrame(loop);
    }

    function setup() {
      if (!bootOrb) return;
      // 以 CSS 盒尺寸为准：canvas 的 width/height 属性只作为无 CSS 时的兜底。
      // 之前直接读属性，属性(112)与 CSS(56px) 不一致时会在 2x 屏上把几何画到
      // 可视区域之外，表现为「有占位但没有动画」。
      var cssSize = 0;
      try {
        cssSize = Number.parseFloat(window.getComputedStyle(bootOrb).width) || 0;
      } catch (_) {
        cssSize = 0;
      }
      size = cssSize || Number(bootOrb.getAttribute("width")) || 56;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      bootOrb.width = Math.round(size * dpr);
      bootOrb.height = Math.round(size * dpr);
      ctx = bootOrb.getContext ? bootOrb.getContext("2d") : null;
      if (!ctx) return;
      // 减少动态偏好：只画一帧有代表性的静止画面，仍然跟随主题。
      if (reduced) {
        paint(0.6);
        return;
      }
      paint(0);
      start();
    }

    return {
      setup: setup,
      start: start,
      stop: stop,
      repaint: function () {
        if (reduced) paint(0.6);
        else if (!running) paint(performance.now() / 1000 * BOOT_ORB_PRESET.speed);
      }
    };
  })();

  if (window.matchMedia) {
    var bootOrbThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    var onBootOrbThemeChange = function () { bootOrbAnimation.repaint(); };
    if (bootOrbThemeQuery.addEventListener) {
      bootOrbThemeQuery.addEventListener("change", onBootOrbThemeChange);
    } else if (bootOrbThemeQuery.addListener) {
      bootOrbThemeQuery.addListener(onBootOrbThemeChange);
    }
  }

  // 标签页隐藏时停掉动画，回到前台再续上，避免后台空转耗电。
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") bootOrbAnimation.stop();
    else if (!bootScreen.hidden) bootOrbAnimation.start();
  });

  // 启动页可见性统一走这里，顺带控制思考球的启停，避免动画在后台空转。
  function setBootScreenVisible(visible) {
    bootScreen.hidden = !visible;
    if (visible) bootOrbAnimation.start();
    else bootOrbAnimation.stop();
  }

  // 启动页只保留一行状态；第二行仅在确实带来新信息（等待时长、重试次数、
  // 操作指引）时出现。与状态行重复、或没有内容时整行隐藏，避免同一件事
  // 换句话再说一遍。
  function setBootStatus(label, detail) {
    bootStatusText.textContent = label;
    var text = typeof detail === "string" ? detail.trim() : "";
    var normalizedLabel = String(label || "").trim().replace(/[。．.！!？?…\s]+$/g, "");
    var normalizedDetail = text.replace(/[。．.！!？?…\s]+$/g, "");
    if (!text || normalizedDetail === normalizedLabel) {
      bootDetail.textContent = "";
      bootDetail.hidden = true;
      return;
    }
    bootDetail.textContent = text;
    bootDetail.hidden = false;
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
          label: "等待电脑连接",
          detail: "请确认电脑已开机、联网且 WeRelay 正在运行。"
        };
      }
      if (elapsedSeconds < 30) {
        return {
          mode: "relay",
          ready: false,
          label: "电脑尚未连接",
          detail: "已等待 " + elapsedSeconds + " 秒，会自动重试。"
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
      setBootScreenVisible(true);
    }
    var startedAtMs = Date.now();
    var serverFailureCount = 0;
    // 这一句已经把「在连接、在检查」说清楚了，不需要再补一句同义解释。
    setBootStatus("正在连接电脑");
    while (true) {
      try {
        var health = await fetchJson("/health", { cache: "no-store" });
        serverFailureCount = 0;
        var connection = resolveBootConnectionState(health, Date.now() - startedAtMs);
        state.connectionMode = connection.mode;
        setBootStatus(connection.label, connection.detail);
        if (state.cachePreviewMode) {
          if (connection.ready) setCacheSyncState("checking");
          else setCacheSyncState("waiting-computer");
        }
        if (connection.ready) return;
      } catch (_) {
        serverFailureCount += 1;
        state.connectionMode = "unknown";
        setBootStatus(
          "暂时无法连接服务器",
          "已重试 " + serverFailureCount + " 次，网络恢复后会自动继续。"
        );
        if (state.cachePreviewMode) setCacheSyncState("server-retry");
      }
      await new Promise(function (resolve) {
        setTimeout(resolve, document.hidden ? 5000 : DEVICE_CONNECTION_RETRY_MS);
      });
    }
  }

  async function attemptLanAcceleration() {
    if (window.WeRelayPlatform) return false;
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

    setBootStatus(
      "正在切换到高速连接",
      "检测到与电脑在同一网络；失败后会自动返回公网。"
    );
    var handoff;
    try {
      handoff = await fetchJson("/api/network/lan-handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: currentLanHandoffTarget() })
      });
    } catch (_) {
      setBootStatus(bootReadyStatus(), "正在读取任务和最近消息…");
      return false;
    }
    if (!handoff || typeof handoff.handoffUrl !== "string" || !handoff.handoffUrl) {
      setBootStatus(bootReadyStatus(), "正在读取任务和最近消息…");
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
      setBootStatus(bootReadyStatus(), "正在读取任务和最近消息…");
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
      pi: "Pi Agent",
      "pi-desktop": "Pi Desktop",
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
    if (status === "busy") return "运行中";
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
    state.activeModelGroup = null;
    composerView.closeMenu("model");
  }

  function closeSessionMenu() {
    state.sessionMenuOpen = false;
    composerView.closeMenu("session");
  }

  function eventPathContains(event, element) {
    if (!event || !element) return false;
    var path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (Array.isArray(path) && path.indexOf(element) >= 0) return true;
    return typeof element.contains === "function" && element.contains(event.target);
  }

  function permissionLabel(value) {
    if (value === "read-only") return "权限受限";
    if (value === "workspace-write") return "项目内读写";
    if (value === "danger-full-access") return "完全访问";
    if (value === "default") return "标准";
    if (value === "acceptEdits") return "自动接受修改";
    if (value === "fullAccess") return "完全访问";
    if (value === "bypassPermissions") return "跳过审批";
    if (value === "plan") return "规划";
    if (value === "custom") return "自定义";
    return value || "权限";
  }

  function composerSessionLabel(reasoning, permission) {
    return (reasoning || "推理") + " · " + (permission || "权限");
  }

  function renderSessionControl() {
    var modelState = currentTaskModelState();
    var permissionState = currentTaskPermissionState();
    if (!state.currentThreadId) {
      closeSessionMenu();
      composerView.renderSession({ visible: false, label: "推理 · 权限" });
      return;
    }

    var currentEffort = modelState && modelState.currentReasoningEffort || "";
    var reasoningOptions = modelState && Array.isArray(modelState.reasoningEffortOptions)
      ? modelState.reasoningEffortOptions
      : [];
    var currentReasoningOption = reasoningOptions.find(function (option) {
      return option.id === currentEffort;
    });
    var currentPermission = permissionState && permissionState.currentPermission || "";
    var permissionOptions = permissionState && Array.isArray(permissionState.options)
      ? permissionState.options.filter(function (option) { return option.id !== "read-only"; })
      : [];
    var currentPermissionOption = permissionOptions.find(function (option) {
      return option.id === currentPermission;
    });
    var reasoningText = state.reasoningChanging
      ? "正在切换…"
      : !modelState
        ? "获取中"
        : currentReasoningOption && currentReasoningOption.label ||
          (currentEffort ? reasoningEffortLabel(currentEffort) : taskNeedsCreation(currentTask()) && !modelState.currentModel ? "先选模型" : "跟随会话");
    var permissionText = state.permissionChanging
      ? "正在切换…"
      : !permissionState
        ? "获取中"
        : permissionState.draft ? "跟随终端"
        : currentPermissionOption && currentPermissionOption.label ||
          (currentPermission ? permissionLabel(currentPermission) : "暂不可用");

    var canChangeReasoning = Boolean(
      modelState && modelState.canChangeReasoningEffort && reasoningOptions.length > 0 && !draftSettingsSubmitted()
    );
    var canChangePermission = Boolean(
      permissionState && permissionState.canChange && permissionOptions.length > 0
    );
    var canChange = canChangeReasoning || canChangePermission;
    var isChanging = state.reasoningChanging || state.permissionChanging;
    if (!canChange) closeSessionMenu();
    composerView.renderSession({
      key: currentTaskModelKey(), visible: true, open: state.sessionMenuOpen,
      label: composerSessionLabel(reasoningText, permissionText), canChange: canChange, changing: isChanging,
      title: canChange ? "切换推理强度或访问权限" : modelState && modelState.reasoningEffortUnavailableReason ||
        permissionState && permissionState.unavailableReason ||
        (!modelState || !permissionState ? "正在读取当前任务设置。" : "当前任务没有可切换的设置。"),
      groups: [
        { kind: "reasoning", label: "推理强度", value: currentEffort, disabled: !canChangeReasoning,
          options: reasoningOptions.length ? reasoningOptions.map(function (option) {
            return Object.assign({}, option, { label: option.label || reasoningEffortLabel(option.id) });
          }) : [{ id: currentEffort, label: reasoningText, disabled: true }] },
        { kind: "permission", label: "访问权限", value: currentPermission, disabled: !canChangePermission,
          options: permissionOptions.length ? permissionOptions.map(function (option) {
            return Object.assign({}, option, { label: option.label || permissionLabel(option.id) });
          }) : [{ id: currentPermission, label: permissionText, disabled: true }] }
      ]
    });
  }

  function reasoningEffortLabel(value) {
    if (value === "none" || value === "off" || value === "disabled") return "关闭推理";
    if (value === "enabled") return "开启推理";
    if (value === "minimal") return "极低";
    if (value === "low") return "低";
    if (value === "medium") return "中";
    if (value === "high") return "高";
    if (value === "xhigh") return "很高";
    if (value === "max") return "最高";
    if (value === "ultra") return "超高";
    return value || "推理";
  }

  function renderModelControl() {
    var modelState = currentTaskModelState();
    var currentModel = modelState && modelState.currentModel || "";
    var options = modelState && Array.isArray(modelState.options) ? modelState.options : [];
    var visible = Boolean(state.currentThreadId && (taskNeedsCreation(currentTask()) || currentModel || options.length || state.modelChanging));
    var currentOption = options.find(function (option) { return option.id === currentModel; });
    var canChange = Boolean(modelState && modelState.canChange && options.length > 0 && !draftSettingsSubmitted());
    if (!visible || !canChange) closeModelMenu();
    composerView.renderModel({
      key: currentTaskModelKey(), visible: visible, open: state.modelMenuOpen, canChange: canChange,
      retry: Boolean(modelState && modelState.loadError), changing: state.modelChanging,
      value: currentModel, options: options, activeGroup: state.activeModelGroup,
      label: currentOption && currentOption.label || currentModel ||
        (state.modelChanging ? "正在切换…" : modelState && modelState.loadError ? "重新获取模型" : !modelState ? "获取中" : "选择模型"),
      title: !canChange ? modelState && modelState.unavailableReason || "当前任务暂时不能切换模型。" : currentModel ? "切换当前任务模型" : "查看模型"
    });
    renderSessionControl();
  }

  function applyDraftModelSelection(payload, selection) {
    var settings = selection || {};
    var model = settings.model || payload.currentModel || "";
    var option = (payload.options || []).find(function (entry) { return entry.id === model; });
    var efforts = option && Array.isArray(option.reasoningEffortOptions)
      ? option.reasoningEffortOptions : model ? payload.reasoningEffortOptions || [] : [];
    var desiredEffort = settings.reasoningEffort ||
      (model === payload.currentModel ? payload.currentReasoningEffort : "") ||
      option && option.defaultReasoningEffort || "";
    var effort = efforts.some(function (entry) { return entry.id === desiredEffort; }) ? desiredEffort : "";
    return Object.assign({}, payload, {
      currentModel: model, currentReasoningEffort: effort,
      reasoningEffortOptions: efforts,
      canChangeReasoningEffort: Boolean(payload.canChange && model && efforts.length),
      reasoningEffortUnavailableReason: !model ? "请先选择模型。" : efforts.length ? "" : "当前模型没有可选推理强度。"
    });
  }

  function draftSettingsSubmitted() {
    return taskNeedsCreation(currentTask()) && (state.pendingMessages || []).some(function (message) {
      return message.threadId === state.currentThreadId && !["failed", "waiting_task_retry"].includes(message.status);
    });
  }

  function saveDraftModelSelection(update) {
    if (draftSettingsSubmitted()) {
      showToast("消息已提交，新任务创建后再切换设置");
      return;
    }
    var task = currentTask();
    var modelState = currentTaskModelState();
    var selection = Object.assign({}, task.newTaskSettings || {}, update);
    if (update.model) {
      var projected = applyDraftModelSelection(modelState, { model: update.model });
      if (!projected.reasoningEffortOptions.some(function (entry) { return entry.id === selection.reasoningEffort; })) {
        if (projected.currentReasoningEffort) selection.reasoningEffort = projected.currentReasoningEffort;
        else delete selection.reasoningEffort;
      }
    }
    if (update.reasoningEffort && !selection.model && modelState.currentModel) selection.model = modelState.currentModel;
    task.newTaskSettings = selection;
    state.taskModels[currentTaskModelKey()] = applyDraftModelSelection(modelState, selection);
    rememberLocalTaskDraft(task);
    saveCurrentConversationSnapshot();
    closeModelMenu(); closeSessionMenu(); renderModelControl();
  }

  async function loadCurrentTaskModel(force) {
    if (!state.currentThreadId) {
      renderModelControl();
      return null;
    }
    var key = currentTaskModelKey();
    var cached = state.taskModels[key];
    renderModelControl();
    if (state.modelChanging || state.reasoningChanging) return cached || null;
    if (!force && cached && Date.now() - Number(cached.loadedAtMs || 0) < 10000) {
      return cached;
    }
    var requestId = ++state.modelRequestId;
    var requestedAdapter = state.currentAdapter;
    var requestedThreadId = state.currentThreadId;
    var modelAbort = new AbortController();
    var modelTimeout;
    try {
      var draft = taskNeedsCreation(currentTask());
      var path = adapterApiPath(draft ? "/api/new-task/model" : "/api/tasks/" + encodeURIComponent(state.currentThreadId) + "/model");
      var payload = await Promise.race([
        api(path, { cache: "no-store", signal: modelAbort.signal }),
        new Promise(function (_, reject) {
          modelTimeout = setTimeout(function () {
            reject(new Error("读取模型超时，请点击重新获取模型。"));
            modelAbort.abort();
          }, 15000);
        })
      ]);
      if (
        requestId !== state.modelRequestId ||
        requestedAdapter !== state.currentAdapter ||
        requestedThreadId !== state.currentThreadId
      ) return null;
      if (draft) payload = applyDraftModelSelection(payload, currentTask().newTaskSettings);
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
          loadError: true,
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
    } finally {
      clearTimeout(modelTimeout);
    }
  }

  async function loadCurrentTaskPermission(force) {
    if (taskNeedsCreation(currentTask())) {
      state.taskPermissions[currentTaskPermissionKey()] = { options: [], canChange: false, draft: true };
      renderSessionControl();
      return null;
    }
    if (!state.currentThreadId) {
      renderSessionControl();
      return null;
    }
    var key = currentTaskPermissionKey();
    var cached = state.taskPermissions[key];
    renderSessionControl();
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
      renderSessionControl();
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
        renderSessionControl();
      }
      return null;
    }
  }

  async function selectCurrentTaskPermission(permission) {
    if (permission === "read-only") {
      showToast("请选择项目内读写权限");
      return;
    }
    var permissionState = currentTaskPermissionState();
    if (!permissionState || !permissionState.canChange) {
      showToast(permissionState && permissionState.unavailableReason || "当前任务暂时不能切换权限范围");
      return;
    }
    if (state.permissionChanging || permission === permissionState.currentPermission) {
      closeSessionMenu();
      renderSessionControl();
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
        closeSessionMenu();
        renderSessionControl();
        return;
      }
    }
    var key = currentTaskPermissionKey();
    var requestId = ++state.permissionRequestId;
    var requestedAdapter = state.currentAdapter;
    var requestedThreadId = state.currentThreadId;
    state.permissionChanging = true;
    closeSessionMenu();
    renderSessionControl();
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
      renderSessionControl();
    }
  }

  async function selectCurrentTaskModel(model) {
    var modelState = currentTaskModelState();
    if (state.reasoningChanging) {
      showToast("推理强度尚在同步到电脑，请稍后再切换模型");
      return;
    }
    if (!modelState || !modelState.canChange) {
      showToast(modelState && modelState.unavailableReason || "当前任务暂时不能切换模型");
      return;
    }
    if (taskNeedsCreation(currentTask())) {
      if (!(modelState.options || []).some(function (option) { return option.id === model; })) return;
      saveDraftModelSelection({ model: model });
      showToast("已为新任务选择模型，发送时生效");
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
      var changePromise = api(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: model })
      });
      var sync = { adapter: requestedAdapter, threadId: requestedThreadId, model: model, promise: changePromise };
      state.taskSettingSync = sync;
      var payload = await changePromise;
      if (
        requestId !== state.modelRequestId ||
        requestedAdapter !== state.currentAdapter ||
        requestedThreadId !== state.currentThreadId
      ) return;
      state.taskModels[key] = Object.assign({}, payload, { loadedAtMs: Date.now() });
      showToast((currentVisibleRunSummary() && currentVisibleRunSummary().status === "running" ? "已选择下一轮模型：" : "已切换至 ") + (payload.currentModel || model));
    } catch (error) {
      if (
        requestId === state.modelRequestId &&
        requestedAdapter === state.currentAdapter &&
        requestedThreadId === state.currentThreadId
      ) showToast(error.message || "模型切换失败，请重试");
    } finally {
      if (state.taskSettingSync && state.taskSettingSync.promise === changePromise) state.taskSettingSync = null;
      if (requestId === state.modelRequestId) state.modelChanging = false;
      renderModelControl();
    }
  }

  async function selectCurrentTaskReasoningEffort(reasoningEffort) {
    var modelState = currentTaskModelState();
    if (state.modelChanging) {
      showToast("模型尚在同步到电脑，请稍后再切换推理强度");
      return;
    }
    if (!modelState || !modelState.canChangeReasoningEffort) {
      showToast(modelState && modelState.reasoningEffortUnavailableReason || "当前模型没有可选推理强度");
      return;
    }
    if (taskNeedsCreation(currentTask())) {
      if (!(modelState.reasoningEffortOptions || []).some(function (option) { return option.id === reasoningEffort; })) return;
      saveDraftModelSelection({ reasoningEffort: reasoningEffort });
      showToast("已为新任务选择推理强度，发送时生效");
      return;
    }
    if (state.reasoningChanging || reasoningEffort === modelState.currentReasoningEffort) {
      closeSessionMenu();
      renderSessionControl();
      return;
    }
    var key = currentTaskModelKey();
    var requestId = ++state.modelRequestId;
    var requestedAdapter = state.currentAdapter;
    var requestedThreadId = state.currentThreadId;
    state.reasoningChanging = true;
    closeSessionMenu();
    renderSessionControl();
    try {
      var path = adapterApiPath("/api/tasks/" + encodeURIComponent(state.currentThreadId) + "/model");
      var changePromise = api(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reasoningEffort: reasoningEffort })
      });
      var sync = { adapter: requestedAdapter, threadId: requestedThreadId, reasoningEffort: reasoningEffort, promise: changePromise };
      state.taskSettingSync = sync;
      var payload = await changePromise;
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
      if (state.taskSettingSync && state.taskSettingSync.promise === changePromise) state.taskSettingSync = null;
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
    closeSessionMenu();
    renderModelControl();
    state.serverMessages = [];
    state.outboundMessages = [];
    state.deliveredClientIds = [];
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
      renderMessages(false);
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
    setBootScreenVisible(false);
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
      if (isMobileConnectionUnavailable(error)) {
        if (!state.cachePreviewMode) {
          state.authenticated = false;
          app.hidden = true;
          authScreen.hidden = true;
          setBootScreenVisible(true);
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
    void api("/api/settings/remote").then(updateLocalAccessLink).catch(function () {});
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
    setBootScreenVisible(false);
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
      if (isMobileConnectionUnavailable(error)) {
        setCacheSyncState(
          state.connectionMode === "unknown" ? "server-retry" : "waiting-computer"
        );
      }
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
    void loadNativeComposerDraft();
    syncComposerInset();
    finishConversationEntryFocus(state.entryFocusGeneration);
    persistMobileCacheNow();
    state.pendingMessages.slice().forEach(function (pending, index) {
      if (pending.status === "failed" || Number(pending.imageCount) > 0 && !(pending.images || []).length) return;
      setTimeout(function () { void submitPendingMessage(pending); }, index * 120);
    });
    scheduleLiveRefresh(2200);
  }

  function taskStatusLabel(status) {
    if (status === "running") return "运行中";
    if (status === "approval") return "待审批";
    if (status === "input") return "等待回答";
    if (status === "error") return "异常";
    return "空闲";
  }

  function reconcileTaskApprovalStatus(task, pendingApproval, runSummary) {
    if (!task) return task;
    if (pendingApproval) {
      var waitingStatus = pendingApproval.kind === "question" ? "input" : "approval";
      return task.status === waitingStatus ? task : Object.assign({}, task, { status: waitingStatus });
    }
    if (task.status !== "approval" && task.status !== "input") return task;
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
    reconcilePendingMessages(state.serverMessages, state.outboundMessages, state.deliveredClientIds);
    return state.pendingMessages.filter(function (pending) {
      return pending.displayInTranscript !== false;
    });
  }

  function conversationMessages() {
    var pending = visiblePendingMessages();
    var messages = filterVisibleConversationMessages(state.serverMessages).slice();
    pending.forEach(function (entry) {
      var message = Object.assign({ role: "user", pending: true }, entry);
      var position = messages.findIndex(function (existing) {
        if (entry.turnId && existing.turnId === entry.turnId && existing.role === "assistant") return true;
        return Number(entry.createdAtMs) > 0 && Number(existing.createdAtMs) > Number(entry.createdAtMs);
      });
      if (position < 0) messages.push(message);
      else messages.splice(position, 0, message);
    });
    return messages;
  }

  function currentVisibleRunSummary() {
    var messages = conversationMessages();
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
    var visibleSummary = currentVisibleRunSummary();
    var capabilityLimited = isAdapterCapabilityError();
    var hasComposerContent = Boolean(
      composerInput.value.trim() || state.pendingImages.length > 0 ||
      state.editingQueuedMessageId && state.editingQueuedImageCount > 0
    );
    var stopMode = shouldUseStopComposerAction(
      task,
      visibleSummary,
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
    refreshMessageSourceTaskLabels();
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
    var stopRequested = state.stopRequestedThreadId === state.currentThreadId;
    var sendingAction = Boolean(
      state.sending || currentPendingDelivery() ||
      visibleSummary && ["submitting", "syncing"].includes(visibleSummary.status)
    );
    composerView.updateAction({
      stopMode: stopMode, stopRequested: stopRequested, sending: sendingAction,
      enabled: Boolean(task), hasContent: hasComposerContent, queueBusy: Boolean(state.queueActionMessageId),
      beamActive: Boolean(composerInput.value.trim() || state.pendingImages.length > 0) &&
        !(visibleSummary && ["running", "submitting", "syncing"].includes(visibleSummary.status))
    });
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

  function revealCurrentTaskInSidebar() {
    if (
      !state.revealCurrentTaskOnSidebarOpen ||
      (window.matchMedia("(max-width: 760px)").matches && !app.classList.contains("sidebar-open")) ||
      !state.currentThreadId
    ) return;
    var currentTask = taskById(state.currentThreadId);
    if (!currentTask) return;
    var query = searchInput.value.trim().toLowerCase();
    if (
      query &&
      !(currentTask.title + " " + (currentTask.projectName || "")).toLowerCase().includes(query)
    ) {
      searchInput.value = "";
      renderTasks();
      return;
    }
    if (state.taskView === "projects") {
      var groupKey = taskGroupKey(currentTask);
      if (state.collapsedProjectGroups[groupKey]) {
        state.collapsedProjectGroups[groupKey] = false;
        renderTasks();
        return;
      }
    }
    var button = state.taskNodes[state.currentThreadId];
    if (!button || !button.isConnected) return;
    var requestedThreadId = state.currentThreadId;
    requestAnimationFrame(function () {
      if (!state.revealCurrentTaskOnSidebarOpen || requestedThreadId !== state.currentThreadId || !button.isConnected) return;
      if (window.matchMedia("(max-width: 760px)").matches && !app.classList.contains("sidebar-open")) return;
      if (!taskList.clientHeight) return;
      var viewport = taskList.getBoundingClientRect();
      var row = button.getBoundingClientRect();
      // Scroll only the task list, never the conversation or the whole page.
      if (row.top < viewport.top || row.bottom > viewport.bottom) {
        taskList.scrollTop += row.top - viewport.top - (taskList.clientHeight - row.height) / 2;
      }
      state.revealCurrentTaskOnSidebarOpen = false;
    });
  }

  function openSidebar() {
    state.revealCurrentTaskOnSidebarOpen = true;
    app.classList.add("sidebar-open");
    revealCurrentTaskInSidebar();
  }

  function closeSidebar() {
    state.revealCurrentTaskOnSidebarOpen = false;
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
      create.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path class="task-group-create-plus" d="M10 4v12M4 10h12"/><circle class="task-group-create-spinner" cx="10" cy="10" r="6"/></svg>';
      create.addEventListener("click", function () {
        if (section.dataset.createEnabled !== "true") return;
        var sourceThreadId = section.dataset.createSourceThreadId || "";
        var projectName = section.dataset.projectName || "这个项目";
        // 「最近」分组没有来源任务，按该终端直接新建（Grok 等无项目终端）。
        void createTask(
          section.dataset.createWithoutSource === "true" ? "" : sourceThreadId,
          section.dataset.createWithoutSource === "true" ? "" : projectName
        );
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
      : recentTaskCreationSource(group.tasks);
    section.dataset.createSourceThreadId = createSource?.threadId || "";
    // 无项目归属的「最近」分组不需要来源任务：直接按该终端新建。
    section.dataset.createWithoutSource = !collapsible && createSource ? "true" : "false";
    section.dataset.createEnabled = createSource ? "true" : "false";

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
      // 「最近」分组没有项目名，直接说新建任务，避免出现「在“最近”中新建任务」。
      var createLabel = collapsible
        ? "在“" + group.title + "”中新建任务"
        : "新建任务";
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
      revealCurrentTaskInSidebar();
      return;
    }
    renderProjectTasks(filtered, Boolean(query));
    revealCurrentTaskInSidebar();
  }

  function taskBoardStatusLabel(task) {
    if (task.status === "running") return "运行中";
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
      { id: "running", title: "运行中", empty: "当前没有正在执行的任务" },
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
        ? payload.recentCompleted.filter(function (item) {
            return Boolean(item && !isTaskBoardInProgress(item));
          })
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
    closeSessionMenu();
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
      selectSettingsTab(settingsTab);
    } else {
      settingsEpoch++;
      clearTimeout(settingsRefreshTimer);
      clearTimeout(remoteRefreshTimer);
      settingsRefreshTimer = null;
      remoteRefreshTimer = null;
      settingsBody.innerHTML = ""; // Clear any unsaved connection key.
    }
    updateActiveDocumentTitle();
  }

  function selectSettingsTab(tab) {
    settingsTab = tab;
    var epoch = ++settingsEpoch;
    clearTimeout(settingsRefreshTimer);
    clearTimeout(remoteRefreshTimer);
    document.querySelectorAll("[data-settings-tab]").forEach(function (button) {
      button.setAttribute("aria-pressed", button.dataset.settingsTab === tab ? "true" : "false");
    });
    settingsBody.innerHTML = '<div class="settings-loading">正在读取设置…</div>';
    if (tab === "remote") void loadRemoteAccess(epoch);
    else void loadSettings();
  }

  function updateLocalAccessLink(view) {
    var entry = document.getElementById("local-address-entry");
    var copy = document.getElementById("local-address-copy");
    try {
      var url = new URL(view.localUrl);
      if (url.protocol !== "http:" || url.hostname !== "localhost" ||
          url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("invalid");
      entry.hidden = !view.showLocalLink;
      copy.textContent = url.origin;
      copy.onclick = function () {
        void navigator.clipboard.writeText(url.origin).then(function () {
          showToast("本机地址已复制");
        }).catch(function () { showToast("无法自动复制，请手动选择地址"); });
      };
    } catch (_) { entry.hidden = true; }
  }

  function renderRemoteAccess(view, epoch) {
    settingsBody.innerHTML =
      '<section class="settings-section"><div class="settings-toggle-row"><div class="settings-toggle-label">启用远端服务器<small>让手机在外网继续电脑上的任务；电脑与 Agent 仍需运行。</small></div><button type="button" id="remote-enabled" class="settings-toggle" role="switch" aria-label="启用远端服务器"></button></div><p class="remote-status" id="remote-status" role="status"></p></section>' +
      '<div id="remote-intro" class="remote-intro" hidden><h2>离开电脑，也能继续任务</h2><p>连接可信的 HTTPS Relay。任务数据会经过服务器，但无需开放电脑端口。</p><ol><li>准备已经部署 WeRelay Relay 的服务器</li><li>填写 HTTPS 地址和配对密钥，先检查连接</li><li>保存后在手机上打开服务器地址</li></ol></div>' +
      '<div class="remote-actions"><button type="button" id="remote-copy" class="remote-action" hidden>复制手机访问地址</button><button type="button" id="remote-configure" class="remote-action">修改配置</button></div>' +
      '<form id="remote-form" class="remote-form" hidden><label>服务器地址<input id="remote-url" type="url" placeholder="https://relay.example.com" autocomplete="off" spellcheck="false" required></label><label>连接密钥<input id="remote-token" type="password" autocomplete="new-password" maxlength="1024"><span class="remote-help">用于设备与服务器配对，不是网页登录或 SSH 密码。已保存的密钥不会显示。</span></label><details class="remote-help"><summary>高级设置</summary><label>设备标识<input id="remote-device" maxlength="128" autocomplete="off" spellcheck="false"></label><p>与服务器配置保持一致，通常为 default。</p></details><details class="remote-help"><summary>我还没有服务器</summary><p>请先准备可信的 HTTPS 服务器并部署 WeRelay Relay。本页不会购买服务器或开放电脑端口。</p></details><div class="remote-actions"><button type="button" id="remote-check" class="remote-action">检查连接</button><button type="submit" id="remote-save" class="remote-action is-primary">保存并启用</button></div><p id="remote-feedback" class="remote-feedback" role="status" aria-live="polite"></p></form>' +
      '<section class="remote-local-setting"><div class="settings-toggle-row"><div class="settings-toggle-label">显示本机链接<small>只在侧边栏显示 localhost 地址；不会改变局域网访问。</small></div><button type="button" id="local-link-visible" class="settings-toggle" role="switch" aria-label="显示本机链接"></button></div><p class="remote-help">localhost 只能在这台电脑的浏览器中打开。</p><p id="local-link-feedback" class="remote-feedback" role="status"></p></section>';
    var status = document.getElementById("remote-status");
    var toggle = document.getElementById("remote-enabled");
    var intro = document.getElementById("remote-intro");
    var copy = document.getElementById("remote-copy");
    var configure = document.getElementById("remote-configure");
    var form = document.getElementById("remote-form");
    var urlInput = document.getElementById("remote-url");
    var tokenInput = document.getElementById("remote-token");
    var deviceInput = document.getElementById("remote-device");
    var feedback = document.getElementById("remote-feedback");
    var localToggle = document.getElementById("local-link-visible");
    var busy = false;
    urlInput.value = view.serverUrl || "";
    deviceInput.value = view.deviceId || "default";
    tokenInput.placeholder = view.hasToken ? "同一服务器与设备可留空" : "请填写服务器提供的密钥";
    function refresh(next) {
      view = next;
      var labels = {
        disabled: "远端访问已关闭",
        connecting: "正在连接服务器…",
        connected: "已连接服务器",
        disconnected: "连接暂时断开，正在重试",
        external: "已配置外部入口，连接状态未知"
      };
      status.textContent = (labels[next.status] || "连接状态未知") +
        (next.enabled && next.serverUrl ? " · " + next.serverUrl : "");
      toggle.classList.toggle("is-on", next.enabled);
      toggle.setAttribute("aria-checked", next.enabled ? "true" : "false");
      intro.hidden = Boolean(next.configured || next.enabled);
      copy.hidden = !(next.enabled && next.serverUrl);
      localToggle.classList.toggle("is-on", Boolean(next.showLocalLink));
      localToggle.setAttribute("aria-checked", next.showLocalLink ? "true" : "false");
      updateLocalAccessLink(next);
    }
    refresh(view);
    toggle.disabled = !view.canEdit;
    localToggle.disabled = !view.canEdit;
    configure.hidden = !view.canEdit;
    configure.textContent = view.configured ? "修改配置" : "开始配置";
    if (!view.canEdit) {
      var notice = document.createElement("p");
      notice.className = "remote-help";
      notice.textContent = "请在电脑浏览器通过 localhost 打开任务台并登录后修改服务器设置。";
      settingsBody.insertBefore(notice, form);
    }
    copy.onclick = function () {
      void navigator.clipboard.writeText(view.serverUrl).then(function () { showToast("手机访问地址已复制"); })
        .catch(function () { showToast("无法自动复制地址"); });
    };
    configure.onclick = function () {
      form.hidden = !form.hidden;
      configure.textContent = form.hidden ? "修改配置" : "收起配置";
      if (form.hidden) tokenInput.value = "";
      else urlInput.focus();
    };
    async function changeRemote(checkOnly, enabled, useSaved) {
      if (busy) return;
      if (enabled && !useSaved && !form.reportValidity()) { form.hidden = false; return; }
      if (!checkOnly && !enabled && view.enabled &&
          !window.confirm("关闭后手机将不能通过此服务器连接电脑。配置会保留，微信和本地任务不受影响。确认关闭？")) return;
      busy = true;
      toggle.disabled = true;
      configure.disabled = true;
      form.querySelectorAll("input,button").forEach(function (item) { item.disabled = true; });
      feedback.classList.remove("is-error");
      feedback.textContent = checkOnly ? "正在检查服务器和配对…" : "正在保存设置…";
      try {
        var result = await api("/api/settings/remote" + (checkOnly ? "/check" : ""), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: enabled, serverUrl: useSaved ? view.serverUrl : urlInput.value,
            deviceId: useSaved ? view.deviceId : deviceInput.value,
            deviceToken: useSaved ? "" : tokenInput.value
          })
        });
        if (epoch !== settingsEpoch || !form.isConnected) return;
        if (checkOnly) feedback.textContent = "检查通过，尚未保存本次配置。";
        else {
          tokenInput.value = "";
          form.hidden = true;
          configure.textContent = "修改配置";
          refresh(result);
          showToast(result.enabled ? "配置已保存" : "远端访问已关闭");
        }
      } catch (error) {
        if (epoch === settingsEpoch && form.isConnected) {
          form.hidden = false;
          feedback.classList.add("is-error");
          feedback.textContent = error.message || "操作未完成，请重试。";
        }
      } finally {
        busy = false;
        if (form.isConnected) {
          toggle.disabled = !view.canEdit;
          configure.disabled = !view.canEdit;
          form.querySelectorAll("input,button").forEach(function (item) { item.disabled = false; });
        }
      }
    }
    toggle.onclick = function () {
      if (!view.enabled && (!view.configured || !view.hasToken)) {
        form.hidden = false;
        feedback.textContent = "先完成配置，再保存启用。";
        urlInput.focus();
        return;
      }
      void changeRemote(false, !view.enabled, true);
    };
    document.getElementById("remote-check").onclick = function () { void changeRemote(true, true, false); };
    form.onsubmit = function (event) { event.preventDefault(); void changeRemote(false, true, false); };
    localToggle.onclick = async function () {
      localToggle.disabled = true;
      try {
        var next = await api("/api/settings/remote", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ showLocalLink: !view.showLocalLink })
        });
        if (epoch !== settingsEpoch || !localToggle.isConnected) return;
        refresh(next);
        document.getElementById("local-link-feedback").textContent = "已保存";
      } catch (error) {
        if (localToggle.isConnected) document.getElementById("local-link-feedback").textContent = error.message || "保存失败";
      } finally { if (localToggle.isConnected) localToggle.disabled = !view.canEdit; }
    };
    async function pollStatus() {
      try {
        var next = await api("/api/settings/remote");
        if (epoch !== settingsEpoch || !status.isConnected) return;
        if (!busy) refresh(next); // Preserve form input while polling.
      } catch (_) { /* Keep the last known status. */ }
      if (epoch === settingsEpoch && status.isConnected) remoteRefreshTimer = setTimeout(pollStatus, 4000);
    }
    remoteRefreshTimer = setTimeout(pollStatus, 4000);
  }

  async function loadRemoteAccess(epoch) {
    try {
      var view = await api("/api/settings/remote");
      if (epoch === settingsEpoch && state.settingsOpen) renderRemoteAccess(view, epoch);
    } catch (error) {
      if (epoch === settingsEpoch && state.settingsOpen) {
        settingsBody.textContent = "远程访问设置读取失败：" + (error.message || "请稍后重试");
      }
    }
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
      if (state.settingsOpen && settingsTab === "providers") void loadSettings();
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
    var scrollTop = settingsBody.scrollTop;
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
    if (settingsTab === "tasks") settingsBody.appendChild(rulesSection);

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

    var providerGrid = document.createElement("div");
    providerGrid.className = "settings-provider-grid";
    payload.providers.forEach(function (provider) {
      var block = document.createElement("details");
      block.className = "settings-provider";
      block.open = Boolean(settingsExpandedProviders[provider.id]);
      function placePanel() {
        if (!block.isConnected || !block.open) return;
        var anchor = block.getBoundingClientRect();
        var viewport = settingsBody.getBoundingClientRect();
        var panelHeight = Math.min(detail.scrollHeight, window.innerHeight * .55, 420);
        var roomBelow = viewport.bottom - anchor.bottom;
        var roomAbove = anchor.top - viewport.top;
        var above = roomBelow < panelHeight && roomAbove > roomBelow;
        block.classList.toggle("is-above", above);
        detail.style.maxHeight = Math.max(40, Math.min(window.innerHeight * .55, 420, (above ? roomAbove : roomBelow) - 8)) + "px";
      }
      block.addEventListener("toggle", function () {
        if (!block.isConnected) return;
        settingsExpandedProviders[provider.id] = block.open;
        if (!block.open) {
          block.classList.remove("is-above");
          return;
        }
        providerGrid.querySelectorAll(".settings-provider[open]").forEach(function (other) {
          if (other !== block) other.open = false;
        });
        requestAnimationFrame(placePanel);
      });
      var head = document.createElement("summary");
      head.className = "settings-provider-head";
      var icon = document.createElement("span");
      icon.className = "settings-provider-icon";
      icon.setAttribute("aria-hidden", "true");
      var iconImage = document.createElement("img");
      iconImage.src = AGENT_BRAND_ICON_DATA[provider.id] || AGENT_BRAND_ICON_DATA.shell;
      iconImage.alt = "";
      icon.appendChild(iconImage);
      head.appendChild(icon);
      var name = document.createElement("span");
      name.className = "settings-provider-name";
      name.textContent = provider.label || provider.id;
      var status = document.createElement("span");
      status.className = "settings-provider-status is-" + (provider.status || "unavailable");
      status.textContent = provider.statusLabel || "状态未知";
      head.appendChild(name);
      head.appendChild(status);
      block.appendChild(head);

      var detail = document.createElement("div");
      detail.className = "settings-provider-detail";
      var source = document.createElement("div");
      source.className = "settings-provider-source";
      source.textContent = provider.sessionSource || "连接电脑上的真实任务。";
      detail.appendChild(source);

      var capabilitySummary = settingsCapabilitySummary(provider.capabilities);
      if (capabilitySummary) {
        var caps = document.createElement("div");
        caps.className = "settings-provider-capabilities";
        caps.textContent = "支持：" + capabilitySummary;
        detail.appendChild(caps);
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
        detail.appendChild(deps);
      }
      block.appendChild(detail);
      providerGrid.appendChild(block);
      if (block.open) requestAnimationFrame(placePanel);
    });
    providersSection.appendChild(providerGrid);
    if (settingsTab === "providers") settingsBody.appendChild(providersSection);
    settingsBody.scrollTop = scrollTop;
  }

  async function loadSettings() {
    var epoch = settingsEpoch;
    var tab = settingsTab;
    try {
      var payload = await api("/api/settings");
      if (!state.settingsOpen || epoch !== settingsEpoch || tab !== settingsTab) return;
      renderSettings(payload);
      if (settingsHasInstallingProvider(payload)) scheduleSettingsRefresh();
    } catch (error) {
      if (!state.settingsOpen || epoch !== settingsEpoch || tab !== settingsTab) return;
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
      if (isMobileConnectionUnavailable(error)) {
        setCacheSyncState(
          state.connectionMode === "unknown" ? "server-retry" : "waiting-computer"
        );
      }
      if (isMobileConnectionUnavailable(error) && state.tasks.length) {
        state.nextTaskRefreshAtMs = Date.now() + TASK_REFRESH_INTERVAL_MS;
        return;
      }
      var nextError = error.message || "任务列表读取失败";
      var errorChanged = nextError !== state.adapterError;
      state.adapterError = nextError;
      if (!state.currentThreadId) {
        state.tasks = [];
        state.serverMessages = [];
        state.outboundMessages = [];
        state.deliveredClientIds = [];
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
      if (
        !isMobileConnectionUnavailable(error) &&
        error.status !== 409 &&
        initial &&
        errorChanged
      ) showToast(nextError);
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
        if (message.clientId && latestActiveUser.clientId && message.clientId !== latestActiveUser.clientId) return true;
        var queuedText = String(message && message.text || "")
          .replace(/\s+/g, " ").trim();
        var comparableUserText = message.imageCount > 0
          ? normalizeMobileMessageText(latestActiveUser.text, true).replace(/\s+/g, " ").trim()
          : activeUserText;
        if (queuedText !== comparableUserText) return true;
        var createdAtMs = Number(message && message.createdAtMs);
        var wasQueuedBeforeTurn = Number.isFinite(activeStartedAtMs) &&
          Number.isFinite(createdAtMs) &&
          createdAtMs <= activeStartedAtMs;
        if (!wasQueuedBeforeTurn) return true;
        consumedMatchHidden = true;
        return false;
      }
    );
    var nativeQueue = Array.isArray(queuedMessages) ? queuedMessages : [];
    var claimed = new Set();
    var matches = new Map();
    var pendingQueue = Array.isArray(pendingMessages) ? pendingMessages : [];
    // Reserve explicit identities first; one native item cannot hide two sends.
    pendingQueue.forEach(function (pending) {
      var index = nativeQueue.findIndex(function (message, index) {
        return !claimed.has(index) && (pending.queuedMessageId
          ? pending.queuedMessageId === message.id
          : message.clientId && message.clientId === pending.clientId);
      });
      if (index >= 0) { claimed.add(index); matches.set(pending, index); }
    });
    pendingQueue.forEach(function (pending) {
      if (matches.has(pending) || pending.queuedMessageId || pending.displayInTranscript ||
          !["sending", "accepted", "submitted", "queued", "retrying"].includes(pending.status)) return;
      var index = nativeQueue.findIndex(function (message, index) {
        if (claimed.has(index) || message.clientId) return false;
        var created = Number(message.createdAtMs);
        var sent = Number(pending.createdAtMs);
        return sent > 0 && created >= sent && created - sent <= 180000 &&
          Number(message.imageCount || 0) === Number(pending.imageCount || pending.images && pending.images.length || 0) &&
          normalizeMobileMessageText(message.text) === normalizeMobileMessageText(pending.text);
      });
      if (index >= 0) { claimed.add(index); matches.set(pending, index); }
    });
    var optimistic = (Array.isArray(pendingMessages) ? pendingMessages : []).flatMap(
      function (pending) {
        if (
          pending.displayInTranscript || pending.deliveryConfirmed || pending.queueMissing ||
          pending.status === "delivered" || pending.status === "cancelled" ||
          pending.status === "failed" ||
          // 未确认：已离开待发列表并回到正文，不能继续留在队列里。
          pending.status === "unconfirmed" ||
          pending.status === "sent" ||
          matches.has(pending)
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
      // 乐观条目的 ID 是 clientId，已确认条目才带原生队列 ID；两者都要清掉。
      state.pendingMessages = state.pendingMessages.filter(function (pending) {
        return pending.queuedMessageId !== messageId && pending.clientId !== messageId;
      });
      state.outboundMessages = state.outboundMessages.filter(function (pending) {
        return pending.queuedMessageId !== messageId && pending.clientId !== messageId;
      });
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
    // 本地乐观条目也能编辑：先取消本地待发，再把内容放回输入框。
    // 只有终态（已发送/已取消/失败）才不允许编辑。
    if (!message || state.queueActionMessageId) return;
    if (message.status === "delivered" || message.status === "cancelled") return;
    if (composerInput.value.trim() || state.pendingImages.length > 0) {
      showToast("请先发送或清空输入框中的内容");
      composerInput.focus();
      return;
    }
    if (message.optimistic || !message.queuedMessageId) {
      // 没有原生队列 ID，编辑等价于取消本地待发并回到输入框。
      void cancelQueuedMessageLocally(message);
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

  async function cancelQueuedMessageLocally(message) {
    var messageId = message.queuedMessageId || message.id;
    try {
      await api(adapterApiPath(
        "/api/tasks/" + encodeURIComponent(state.currentThreadId) +
        "/queue/" + encodeURIComponent(messageId)),
        { method: "DELETE" }
      );
    } catch (error) {
      showToast("无法取回这条消息：" + (error.message || "请稍后重试"));
      return;
    }
    state.pendingMessages = state.pendingMessages.filter(function (pending) {
      return pending.queuedMessageId !== messageId && pending.clientId !== messageId;
    });
    state.outboundMessages = state.outboundMessages.filter(function (pending) {
      return pending.queuedMessageId !== messageId && pending.clientId !== messageId;
    });
    state.queuedMessages = state.queuedMessages.filter(function (entry) { return entry.id !== messageId; });
    composerInput.value = String(message.text || "");
    state.editingQueuedMessageId = "";
    state.editingQueuedImageCount = 0;
    state.composerRevision += 1;
    composerInput.placeholder = "有问题，尽管问";
    composerImageButton.disabled = false;
    renderQueuedMessages(state.queuedMessages);
    resizeComposer();
    composerInput.focus();
    composerInput.setSelectionRange(composerInput.value.length, composerInput.value.length);
    showToast("已取回输入框，可修改后重新发送");
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
      state.pendingMessages.map(function (pending) {
        return [pending.clientId, pending.queuedMessageId, pending.status, pending.displayInTranscript,
          pending.deliveryConfirmed, pending.queueMissing, pending.text, pending.imageCount];
      }),
      latestUser && [latestUser.id, latestUser.clientId, latestUser.turnId, latestUser.text],
      summary && [summary.status, summary.turnId, summary.startedAtMs]
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
    composerView.renderQueue(visibleMessages, { busyId: state.queueActionMessageId });
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

  function scrollToLatestUserMessage() {
    var userRows = messagesEl.querySelectorAll(".message-row.user");
    var latestUser = userRows[userRows.length - 1];
    if (!latestUser) {
      scrollToLatest(false);
      return;
    }
    messagesEl.scrollTop = Math.max(0, latestUser.offsetTop - userMessageNavigationTargetInset());
  }

  function beginConversationEntryFocus(adapterId, threadId) {
    state.entryFocusKey = conversationStateKey(adapterId, threadId);
    state.entryFocusGeneration += 1;
    return state.entryFocusGeneration;
  }

  function cancelConversationEntryFocus() {
    state.entryFocusKey = "";
    state.scrollIntentRevision += 1;
  }

  function finishConversationEntryFocus(generation) {
    requestAnimationFrame(function () {
      if (
        generation !== state.entryFocusGeneration ||
        state.entryFocusKey !== conversationStateKey(state.currentAdapter, state.currentThreadId)
      ) return;
      scrollToLatestUserMessage();
      cancelConversationEntryFocus();
      updateUserMessageNavigation();
    });
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
    // An owner-backed CLI may not expose a turn id. Its later terminal state
    // still resolves the optimistic local run that preceded it.
    if (local && remote && ["completed", "failed", "interrupted"].includes(remote.status) &&
      Number(remote.completedAtMs) >= Number(local.startedAtMs) &&
      (!remote.turnId || !local.turnId || remote.turnId === local.turnId)) return remote;
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
    var awaitingReceipt = (state.pendingMessages || []).some(function (message) {
      return message.displayInTranscript !== false && !["failed", "waiting_task_retry", "queued"].includes(message.status);
    });
    return (taskRunning || awaitingReceipt || Boolean(state.localRunSummary)) &&
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
    if (summary && ["submitting", "syncing"].includes(summary.status)) return summary;
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
    // 任务的终态是权威的：只要这一轮已经明确结束，即使某条进展项还停在
    // running（同一轮内 Agent 的进展不会逐条回填终态），也不能把它当成
    // 仍在运行，否则已完成的任务会一直显示「正在规划 ···」动画。
    var summarySettledThisTurn = Boolean(
      summary &&
      summary.status !== "running" &&
      (!currentTurnId || !summary.turnId || summary.turnId === currentTurnId)
    );
    var runningProgress = summarySettledThisTurn
      ? null
      : (Array.isArray(progressItems) ? progressItems : []).slice().reverse()
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
    if (["running", "submitting", "syncing"].includes(summary.status)) {
      if (summary.startedAtMs) return Math.max(Number(summary.durationMs) || 0, Date.now() - summary.startedAtMs);
      return (Number(summary.durationMs) || 0) + Math.max(0, Date.now() - (summary.receivedAtMs || Date.now()));
    }
    if (Number(summary.durationMs) > 0) return Number(summary.durationMs);
    if (!summary.completedAtMs || !summary.startedAtMs) return 0;
    return Math.max(0, summary.completedAtMs - summary.startedAtMs);
  }

  function runHeaderLabel(summary, stopping) {
    var duration = formatRunDuration(runDurationMs(summary));
    if (state.pendingApproval) return (state.pendingApproval.kind === "question" ? "等待回答 · " : "等待确认 · ") + duration;
    if (summary.status === "running") {
      return (stopping ? "正在停止" : "正在处理") + " · " + duration;
    }
    if (summary.status === "submitting") {
      var pending = state.pendingMessages.find(function (message) { return message.clientId === summary.clientId; });
      return pending ? deliveryHeaderLabel(pending) : "正在同步提交状态 · " + duration;
    }
    if (summary.status === "syncing") return "Agent 已收到，正在同步运行状态 · " + duration;
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
        ["contacting_computer", "forwarding_to_agent", "sending", "syncing_model", "accepted", "submitted", "delivered", "retrying", "waiting_to_send"].includes(pending.status);
    }) || null;
  }

  function deliveryHeaderLabel(pending) {
    var duration = formatRunDuration(Date.now() - Number(pending.createdAtMs || Date.now()));
    if (pending.status === "delivered") return "Agent 已收到，正在同步运行状态 · " + duration;
    if (pending.status === "syncing_model") return "正在确认所选模型，再发送给电脑 · " + duration;
    if (pending.status === "retrying") return "正在重试并核对接收状态 · " + duration;
    if (pending.status === "waiting_to_send") return "等待前一条消息提交 · " + duration;
    if (pending.serverAcknowledged || ["accepted", "submitted", "forwarding_to_agent"].includes(pending.status)) {
      return "已提交，正在等待 " + adapterName(pending.adapter || state.currentAdapter) + " 接收 · " + duration;
    }
    return "正在提交消息 · " + duration;
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

  function partitionProgressItems(items) { return chatText.partitionProgressItems(items); }
  function renderProgressItemHtml(item) { return chatText.renderProgressItemHtml(item, currentAdapterName() + " 正在处理"); }

  function settleVisibleProgressItem(item, summary, messages) {
    if (!item || item.status !== "running") return item;
    var terminal = summary && ["completed", "failed", "interrupted"].includes(summary.status);
    var sameTurn = Boolean(summary && summary.turnId && item.turnId && summary.turnId === item.turnId);
    var turnMismatch = Boolean(summary && summary.turnId && item.turnId && summary.turnId !== item.turnId);
    var endedAfterProgress = Boolean(!turnMismatch && summary && Number(summary.completedAtMs) > 0 &&
      Number(item.createdAtMs) > 0 && Number(summary.completedAtMs) >= Number(item.createdAtMs));
    var finalAfterProgress = (messages || []).some(function (message) {
      return message && message.role === "assistant" && message.phase === "final_answer" &&
        Number(message.createdAtMs) > 0 && Number(item.createdAtMs) > 0 &&
        Number(message.createdAtMs) >= Number(item.createdAtMs) &&
        (!message.turnId || !item.turnId || message.turnId === item.turnId);
    });
    return terminal && (sameTurn || endedAfterProgress) || finalAfterProgress
      ? Object.assign({}, item, { status: "completed" }) : item;
  }

  function renderProgressList(progressItems, summary, messages) {
    return chatText.renderProgressList(document, (progressItems || []).map(function (item) {
      return settleVisibleProgressItem(item, summary, messages);
    }), currentAdapterName());
  }

  function renderQuestionCard(request) {
    var existing = document.getElementById("pending-approval");
    if (existing && existing.getAttribute("data-question-id") === request.requestId) return existing;
    var card = document.createElement("form");
    card.className = "approval-card";
    card.id = "pending-approval";
    card.setAttribute("data-question-id", request.requestId);
    var title = document.createElement("div");
    title.className = "approval-card-title";
    title.textContent = request.summary || "需要你回答问题";
    card.appendChild(title);
    (request.questions || []).forEach(function (question, index) {
      var field = document.createElement("fieldset");
      field.style.cssText = "border:0;padding:12px 0;margin:0;min-width:0";
      var legend = document.createElement("legend");
      legend.textContent = question.question;
      field.appendChild(legend);
      (question.options || []).forEach(function (option) {
        var label = document.createElement("label");
        label.style.cssText = "display:block;padding:8px 0;cursor:pointer";
        var input = document.createElement("input");
        input.type = question.multiSelect ? "checkbox" : "radio";
        input.name = "question-" + index;
        input.value = option.label;
        input.disabled = state.resolvingApproval;
        label.appendChild(input);
        label.appendChild(document.createTextNode(" " + option.label + (option.description ? " · " + option.description : "")));
        field.appendChild(label);
      });
      if (question.isOther || !(question.options || []).length) {
        var other = document.createElement("input");
        other.type = question.isSecret ? "password" : "text";
        other.name = "other-" + index;
        other.placeholder = (question.options || []).length ? "或填写其他答案" : "填写答案";
        other.autocomplete = "off";
        other.style.cssText = "width:100%;box-sizing:border-box;padding:10px;font:inherit";
        field.appendChild(other);
      }
      card.appendChild(field);
    });
    var button = document.createElement("button");
    button.type = "submit";
    button.className = "approval-action primary";
    button.disabled = state.resolvingApproval;
    button.textContent = state.resolvingApproval ? "提交中…" : "提交答案";
    card.appendChild(button);
    card.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (state.resolvingApproval) return;
      var data = new FormData(card);
      var answers = Object.create(null);
      var valid = (request.questions || []).every(function (question, index) {
        var values = data.getAll("question-" + index).map(String);
        var other = String(data.get("other-" + index) || "").trim();
        if (other) values = question.multiSelect ? values.concat([other]) : [other];
        answers[question.id] = values;
        return values.length > 0;
      });
      if (!valid) { showToast("请回答所有问题后再提交"); return; }
      var threadId = state.currentThreadId;
      var adapter = state.currentAdapter;
      state.resolvingApproval = true;
      button.disabled = true;
      button.textContent = "提交中…";
      try {
        await api(adapterApiPath("/api/tasks/" + encodeURIComponent(threadId) + "/user-input", adapter), {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId: request.requestId, answers: answers })
        });
        if (state.currentThreadId === threadId && state.currentAdapter === adapter) {
          state.pendingApproval = null;
          await loadMessages(false);
        }
      } catch (error) { showToast(error.message || "答案未提交，请重试"); }
      finally {
        state.resolvingApproval = false;
        button.disabled = false;
        button.textContent = "提交答案";
      }
    });
    return card;
  }

  function renderApprovalCard(approval) {
    if (approval.kind === "question") return renderQuestionCard(approval);
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
    var raw = value && value.createdAtMs;
    var direct = typeof raw === "number" ? raw : NaN;
    if (Number.isFinite(direct) && direct > 0) return direct;
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
    var messages = Array.isArray(params && params.messages) ? params.messages.slice() : [];
    var segmentStart = 0;
    for (var cursor = 0; cursor <= messages.length; cursor += 1) {
      if (cursor < messages.length && timelineOccurredAtMs(messages[cursor], "createdAt") !== null) continue;
      var segment = messages.slice(segmentStart, cursor).sort(function (left, right) {
        return timelineOccurredAtMs(left, "createdAt") - timelineOccurredAtMs(right, "createdAt");
      });
      messages.splice.apply(messages, [segmentStart, segment.length].concat(segment));
      segmentStart = cursor + 1;
    }
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
    function messageInsertionBoundary(item) {
      var bounds = item.turnId ? turnBounds(item.turnId) : { first: 0, last: messages.length - 1 };
      var first = bounds.first < 0 ? 0 : bounds.first;
      var last = bounds.last < 0 ? messages.length - 1 : bounds.last;
      if (item.occurredAtMs === null) return last + 1;
      var boundary = first;
      for (var index = first; index <= last; index += 1) {
        var messageTime = timelineOccurredAtMs(messages[index], "createdAt");
        if (messageTime !== null && messageTime <= item.occurredAtMs) {
          boundary = index + 1;
        }
      }
      return boundary;
    }

    items.forEach(function (item) {
      if (item.kind === "message") {
        item.sortPosition = item.messageIndex * 2;
        return;
      }
      item.anchorIndex = messageInsertionBoundary(item);
      item.sortPosition = item.anchorIndex * 2 - 1;
      item.fallbackOrder = item.anchorIndex * 10 + timelineFallbackRank(item.kind);
    });

    return items.sort(function (left, right) {
      if (left.sortPosition !== right.sortPosition) return left.sortPosition - right.sortPosition;
      if (left.kind === "message" && right.kind === "message") {
        return left.messageIndex - right.messageIndex;
      }
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
    // Keep the composer action in step with the one-second runtime clock.
    // A running task can settle without immediately rendering a new message;
    // without this refresh the breathing dot and stop affordance can linger.
    updateHeader();
    var delivery = currentPendingDelivery();
    var deliveryHeader = document.getElementById("delivery-header");
    if (deliveryHeader && delivery) {
      var deliveryLabel = deliveryHeader.querySelector(".run-header-label");
      if (deliveryLabel) deliveryLabel.textContent = deliveryHeaderLabel(delivery);
    }
    var header = document.getElementById("run-header");
    var messages = conversationMessages();
    var summary = resolveVisibleRunSummary(
      messages,
      currentTask(),
      effectiveRunSummary(),
      Date.now(),
      state.progressItems
    );
    renderSessionControl();
    if (!header || !summary) return;
    var label = header.querySelector(".run-header-label");
    if (label) {
      label.textContent = runHeaderLabel(
        summary,
        state.stopRequestedThreadId === state.currentThreadId
      );
    }
  }

  function reconcilePendingMessages(messages, outboundMessages, deliveredClientIds) {
    (Array.isArray(outboundMessages) ? outboundMessages : []).forEach(function (remote) {
      if (!remote || !remote.clientId) return;
      if (remote.status === "cancelled") {
        state.pendingMessages = state.pendingMessages.filter(function (pending) { return pending.clientId !== remote.clientId; });
        if (Array.isArray(state.outboundMessages)) state.outboundMessages = state.outboundMessages.filter(function (pending) { return pending.clientId !== remote.clientId; });
        return;
      }
      if (messages.some(function (message) { return message.role === "user" && message.clientId === remote.clientId; })) return;
      var pending = state.pendingMessages.find(function (entry) { return entry.clientId === remote.clientId; });
      if (!pending) {
        pending = Object.assign({ threadId: state.currentThreadId, adapter: state.currentAdapter }, remote);
        state.pendingMessages.push(pending);
      } else {
        // Preserve the original object (an in-flight POST still owns it), baseline and render identity.
        ["status", "turnId", "queuedMessageId", "queueMissing", "attempts", "lastError", "lastAttemptAtMs", "submittedAtMs"].forEach(function (key) {
          if (remote[key] !== undefined) pending[key] = remote[key];
        });
        if (remote.status === "queued" && typeof remote.text === "string") pending.text = remote.text;
        if (Array.isArray(remote.images) && remote.images.length) pending.images = remote.images;
      }
      pending.serverAcknowledged = true;
      if (["failed", "queued", "waiting_task_retry"].includes(pending.status) && state.localRunSummary && state.localRunSummary.clientId === pending.clientId) {
        state.localRunSummary = null;
        state.optimisticProgressTurnId = null;
      }
      if (state.localRunSummary && state.localRunSummary.clientId === pending.clientId && pending.turnId) {
        state.localRunSummary.turnId = pending.turnId;
        state.localRunSummary.status = "syncing";
      }
    });
    applyDeliveredMessageReceipts(deliveredClientIds);
    reconcilePendingQueueState();
    var users = messages.filter(function (message) { return message.role === "user"; });
    var used = {};
    var confirmedKeys = [];

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
      if (message && message.clientId && message.clientId !== pending.clientId) return false;
      var actual = normalizeMobileMessageText(message && message.text);
      var expected = normalizeMobileMessageText(pending && pending.text);
      if (actual === expected) return true;
      if (!(pending && (pending.imageCount > 0 || pending.images && pending.images.length))) return false;
      return normalizeMobileMessageText(actual, true) === expected;
    }

    state.pendingMessages = state.pendingMessages.filter(function (pending) {
      var baselineKeys = Array.isArray(pending.baselineUserKeys)
        ? new Set(pending.baselineUserKeys)
        : null;
      var matchIndex = users.findIndex(function (message, index) {
        return !used[index] && message.clientId === pending.clientId;
      });
      if (matchIndex < 0 && pending.sourceMessageId) {
        matchIndex = users.findIndex(function (message, index) {
          return !used[index] && String(message && message.id || "") === pending.sourceMessageId;
        });
      }
      if (matchIndex < 0 && pending.turnId) {
        matchIndex = users.findIndex(function (message, index) {
          return !used[index] && message.turnId === pending.turnId &&
            matchesPendingText(message, pending) &&
            (!baselineKeys || !baselineKeys.has(userMessageKey(message)));
        });
      }
      if (matchIndex < 0) {
        matchIndex = users.findIndex(function (message, index) {
          if (used[index] || !matchesPendingText(message, pending)) return false;
          if (pending.turnId && message.turnId && pending.turnId !== message.turnId) return false;
          if (!baselineKeys && pending.createdAtMs && (!message.createdAtMs || message.createdAtMs < pending.createdAtMs) && !(pending.turnId && pending.turnId === message.turnId)) return false;
          if (baselineKeys) return !baselineKeys.has(userMessageKey(message));
          return index >= pending.baselineUserCount;
        });
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
      pending.deliveryConfirmed = true;
      matchedMessage.clientId = pending.clientId;
      if (state.localRunSummary && state.localRunSummary.clientId === pending.clientId) {
        state.localRunSummary.turnId = matchedMessage.turnId || pending.turnId || "";
        state.localRunSummary.status = "syncing";
      }
      if (pending.imageStoreKey) void pendingImageStoreOperation(pending.imageStoreKey, null).catch(function () {});
      if (Array.isArray(state.outboundMessages)) {
        state.outboundMessages = state.outboundMessages.filter(function (entry) { return entry.clientId !== pending.clientId; });
      }
      confirmedKeys.push(userMessageKey(matchedMessage));
      return false;
    });
    // A real message can acknowledge only one optimistic send, across renders
    // too. Otherwise a second intentional "continue" disappears on the next tick.
    if (confirmedKeys.length) state.pendingMessages.forEach(function (pending) {
      if (!Array.isArray(pending.baselineUserKeys)) return;
      pending.baselineUserKeys = Array.from(new Set(pending.baselineUserKeys.concat(confirmedKeys)));
    });
  }

  // 与服务端 MOBILE_PENDING_CONFIRMATION_TIMEOUT_MS 保持一致：等待原生确认
  // 超过这个时间的待发送消息视为过时，离开待发列表并回到正文。
  var PENDING_CONFIRMATION_TIMEOUT_MS = 60 * 60 * 1_000;

  function isAwaitingNativeConfirmation(pending) {
    if (!pending) return false;
    var status = pending.status;
    if (status !== "queued" && status !== "submitted" && status !== "sending") return false;
    // 已经拿到原生队列 ID 的条目由服务端对账，不在客户端判定过时。
    return !pending.queuedMessageId;
  }

  function pendingConfirmationSinceMs(pending) {
    var candidates = [pending.lastAttemptAtMs, pending.submittedAtMs, pending.createdAtMs];
    for (var i = 0; i < candidates.length; i += 1) {
      var value = Number(candidates[i]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return Date.now();
  }

  function reconcilePendingQueueState() {
    state.pendingMessages = state.pendingMessages.filter(function (pending) { return pending.status !== "cancelled"; });
    state.pendingMessages.forEach(function (pending) {
      if (pending.deliveryConfirmed || pending.status === "delivered") {
        pending.displayInTranscript = true;
        return;
      }
      if (pending.status === "queued" && typeof pending.queueMissing === "boolean") {
        // Preserve uncertain content in the conversation; never resend or erase it on a timer.
        pending.displayInTranscript = pending.queueMissing;
        return;
      }
      // 兜底：服务端尚未把超时条目转为未确认时（例如页面离线期间），
      // 客户端也不能让等待原生确认的条目无限期留在待发列表。内容同样保留。
      if (isAwaitingNativeConfirmation(pending) &&
          Date.now() - pendingConfirmationSinceMs(pending) >= PENDING_CONFIRMATION_TIMEOUT_MS) {
        pending.status = "unconfirmed";
        pending.queuedMessageId = "";
        pending.queueMissing = false;
        pending.displayInTranscript = true;
      }
    });
  }

  function applyDeliveredMessageReceipts(deliveredClientIds) {
    var delivered = new Set(Array.isArray(deliveredClientIds) ? deliveredClientIds : []);
    // A receipt stops resubmission; only a visible native user message removes the provisional bubble.
    state.pendingMessages.forEach(function (pending) {
      if (pending.status === "delivered" || delivered.has(pending.clientId)) {
        pending.serverAcknowledged = true;
        pending.deliveryConfirmed = true;
        pending.status = "delivered";
        delete pending.lastError;
      }
    });
  }

  function runHeaderInsertIndex(messages, summary) {
    if (!summary) return -1;
    if (summary.turnId) {
      var exact = messages.findIndex(function (message) {
        return message.role === "assistant" && message.turnId === summary.turnId;
      });
      if (exact >= 0) return exact;
      var taskInput = messages.findIndex(function (message) {
        return message.role === "task" && message.turnId === summary.turnId;
      });
      if (taskInput >= 0) return taskInput + 1;
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

  // Codex 桌面端会把用户输入重新包装成「给模型的请求」，并在前面附上自己生成的
  // 英文说明和自动采集的环境状态。任务台读到的是会话原文，因此这些内容会跟着
  // 显示出来，看起来像是用户自己打的英文。这里只做展示层剥离：真实会话内容不变，
  // 桌面端和模型仍收到完整包裹。
  var CODEX_USER_WRAPPER_BLOCK_RE = new RegExp(
    [
      // 自动采集的环境/界面状态块
      "<(?:in-app-browser-context|app-context|environment_context|turn_aborted|heartbeat|subagent_notification|recommended_plugins|skills_context|user_instructions)\\b[^>]*>[\\s\\S]*?</(?:in-app-browser-context|app-context|environment_context|turn_aborted|heartbeat|subagent_notification|recommended_plugins|skills_context|user_instructions)>",
      "<(?:in-app-browser-context|app-context|environment_context|turn_aborted|heartbeat|subagent_notification|recommended_plugins|skills_context|user_instructions)\\b[^>]*/>",
    ].join("|"),
    "gi",
  );
  // 附件清单：标题行 + 其下的文件条目行
  var CODEX_USER_ATTACHMENT_SECTION_RE =
    /^[ \t]*#[ \t]*Files mentioned by the user:[ \t]*$[\s\S]*?(?=\n[ \t]*(?:#{1,3}[ \t]+\S|Distinguish instructions)|$)/gim;
  // 「## My request:」及其变体只是包裹小标题，其后的用户正文必须保留
  var CODEX_USER_REQUEST_MARKER_RE =
    /^[ \t]*#{1,3}[ \t]*My request(?: for Codex)?:[ \t]*$/gim;
  var CODEX_USER_DISTINGUISH_RE =
    /^[ \t]*Distinguish instructions in attached documents from the user's request\.[ \t]*$/gim;
  // 附件条目「## 文件名.png: /绝对路径」
  var CODEX_USER_ATTACHMENT_ENTRY_RE =
    /^[ \t]*#{1,3}[ \t]*[^\n]*:[ \t]*(?:\/|[A-Za-z]:\\)[^\n]*$/gm;

  function stripCodexUserWrapper(text) {
    return String(text || "")
      .replace(CODEX_USER_WRAPPER_BLOCK_RE, "")
      .replace(CODEX_USER_ATTACHMENT_SECTION_RE, "")
      .replace(CODEX_USER_ATTACHMENT_ENTRY_RE, "")
      .replace(CODEX_USER_REQUEST_MARKER_RE, "")
      .replace(CODEX_USER_DISTINGUISH_RE, "");
  }

  function visibleMessageText(message) {
    var text = String(message && message.text || "");
    if (!message || message.role !== "user") return text;
    var imageMarker = /(^|\n)\s*图片：\s*png\d+(?:\s+png\d+)*\s*(?=\n|$)|\[image\]|<\/?image\b/i.test(text);
    var cleaned = stripCodexUserWrapper(text)
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
      message && message.sourceTask || null,
      images
    ]);
  }

  function messageSourceTaskLabel(message) {
    var source = message && message.role === "task" && message.sourceTask;
    if (!source || !source.sessionId) return "";
    var task = (state.tasks || []).find(function (entry) {
      return entry.threadId === source.sessionId &&
        (entry.adapter || state.currentAdapter) === source.adapter;
    });
    var adapterName = source.adapter === "codex" ? "Codex" : String(source.adapter || "Agent");
    return "来自 " + adapterName + " 任务 · " +
      (task && task.title || String(source.sessionId).slice(0, 8));
  }

  function refreshMessageSourceTaskLabels() {
    messagesEl.querySelectorAll(".message-source-task").forEach(function (label) {
      var text = messageSourceTaskLabel({ role: "task", sourceTask: {
        adapter: label.dataset.sourceAdapter,
        sessionId: label.dataset.sourceSession
      } });
      if (label.textContent !== text) label.textContent = text;
    });
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
      messageSourceTaskLabel(message),
      message && message.text || "",
      message && message.id || "",
      message && message.turnId || "",
      message && message.phase || "",
      message && message.model || "",
      Boolean(message && message.pending),
      message && message.status || "",
      Boolean(message && message.queueMissing),
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

  function getMessageNode(message, index, nextMessage, nodeKey, isLatest, runStatus) {
    // 运行状态会改变页脚内容（运行中显示更新时间、结束后补上模型名），
    // 因此必须计入渲染键，否则结束瞬间会复用旧的运行中行。
    var renderKey = messageRowRenderKey(message, nextMessage) +
      "\u0000" + (isLatest ? "1" : "0") +
      "\u0000" + String(runStatus || "");
    var existing = state.messageNodes[nodeKey];
    if (existing && existing.__deskRelayMessageRenderKey === renderKey) {
      return existing;
    }
    var row = renderMessageRow(message, index, nextMessage, nodeKey, isLatest);
    row.__deskRelayMessageRenderKey = renderKey;
    state.messageNodes[nodeKey] = row;
    return row;
  }

  // 一轮对话常常被拆成多个 assistant 小段。模型名与时间只在整轮的末尾显示
  // 一次，避免每一小段都重复一遍；运行中只显示不断刷新的更新时间，模型名
  // 等到这一轮结束再显示。
  function resolveMessageFooter(message, summary, isSegmentEnd, nowMs) {
    // 其他任务转来的消息按「收到于」显示时间，且不显示模型名。
    if (message && message.role === "task") {
      return {
        model: "",
        time: Number.isFinite(message.createdAtMs)
          ? "收到于 " + formatClockTime(message.createdAtMs, nowMs) : ""
      };
    }
    if (!message || message.role !== "assistant") return { model: "", time: "" };
    if (!isSegmentEnd) return { model: "", time: "" };
    var createdMs = Number(message.createdAtMs);
    var summaryTurnId = summary && summary.turnId;
    var messageTurnId = message.turnId;
    // 只有当运行中的那一轮就是这条消息所属的轮次时，才按「更新于」显示；
    // 历史轮次即使此刻有别的轮次在跑，也保留自己的完成时间与模型名。
    var sameTurn = Boolean(
      summaryTurnId && messageTurnId &&
      String(summaryTurnId) === String(messageTurnId)
    );
    var running = Boolean(
      summary &&
      summary.status === "running" &&
      (sameTurn || !messageTurnId || !summaryTurnId)
    );
    var time = "";
    if (running) {
      // 运行中：用最近的更新时间覆盖，而不是逐段累加。
      var updatedMs = Number(summary && summary.receivedAtMs) || createdMs || nowMs;
      time = "更新于 " + formatClockTime(updatedMs, nowMs);
    } else if (sameTurn && Number(summary && summary.completedAtMs)) {
      time = "完成于 " + formatClockTime(Number(summary.completedAtMs), nowMs);
    } else if (Number.isFinite(createdMs)) {
      time = "完成于 " + formatClockTime(createdMs, nowMs);
    }
    return {
      // 运行中的进展不显示模型名；这一轮结束后才显示它实际使用的模型。
      model: running ? "" : visibleMessageModel(message),
      time: time
    };
  }

  function renderMessageRow(message, index, nextMessage, nodeKey, isLatest) {
    var continues = messageContinues(message, nextMessage);
    var id = message.clientId ? "pending-" + message.clientId : message.id ? "message-" + message.id :
      "message-auto-" + stableMessageNodeHash(nodeKey || String(index));
    var delivery = null;
    if (message.pending) {
      var creationError = message.status === "waiting_task_retry"
        ? taskCreationErrorText(taskById(message.threadId))
        : "";
      var statusText = message.status === "creating_task"
        ? "已接收，正在创建任务"
        : message.status === "syncing_model"
          ? "已接收，正在确认所选模型"
        : message.status === "waiting_task_retry"
          ? creationError
            ? "任务创建失败：" + creationError
            : "任务创建失败，消息已保留"
          : message.status === "waiting_to_send"
            ? "已保留，等待前一条消息提交"
            : message.status === "accepted"
              ? "已接收，正在提交"
              : message.status === "sending"
                ? "正在提交到 " + adapterName(message.adapter || state.currentAdapter)
                : message.status === "retrying"
                  ? "已保留，等待连接恢复"
                  : message.status === "failed"
                    ? (message.lastError && /does not support image|attachment-error/.test(message.lastError)
                      ? "当前模型不支持图片，请换用支持图片的模型后重试；文字和图片已保留"
                      : message.lastError || "提交失败，消息已保留")
                    : message.status === "unconfirmed"
                      ? "提交状态暂未确认，消息已保留"
                      : message.status === "queued"
                        ? message.queueMissing ? "暂未在待发送列表中找到，接收结果待核对；内容已保留" : "已排队，等待当前任务完成"
                        : message.status === "submitted"
                          ? "已提交，正在等待任务接收"
                          : message.status === "steered"
                            ? "已引导，正在处理"
                            : message.status === "delivered" ? "已收到，正在同步消息记录" : "已提交，等待运行状态";
      var failed = message.status === "failed" || message.status === "waiting_task_retry";
      var sharedDeliveryStatus = ["sending", "syncing_model", "accepted", "submitted", "delivered", "forwarding_to_agent", "contacting_computer", "retrying"].includes(message.status);
      if (!sharedDeliveryStatus) delivery = {
        text: statusText, failed: failed,
        retryLabel: failed ? "重新提交" : message.status === "unconfirmed" ? "检查状态" : "",
        copy: Boolean((failed || message.queueMissing) && message.text)
      };
    }
    return messageBubble.render({
      message: message, id: id, continues: continues, delivery: delivery,
      text: visibleMessageText(message), sourceLabel: messageSourceTaskLabel(message),
      footer: resolveMessageFooter(message, effectiveRunSummary(), !continues, Date.now())
    });
  }

  function renderResponsePendingIndicator(summary) {
    if (!summary || summary.status !== "running" || state.pendingApproval) return null;
    return chatText.renderPendingIndicator(document, "Agent 正在执行");
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
      codeKeys: Array.from(
        messagesEl.querySelectorAll(".message-code-fold[open], .message-tools-group[open]")
      )
        .map(function (details) { return details.getAttribute("data-fold-key") || ""; })
        .filter(Boolean),
      progressHistoryOpen: Boolean(messagesEl.querySelector(".run-progress-history[open]"))
    };
  }

  function restoreOpenFoldState(foldState) {
    var openCodeKeys = new Set(foldState && foldState.codeKeys || []);
    messagesEl.querySelectorAll(".message-code-fold, .message-tools-group").forEach(function (details) {
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
      messagesEl.setAttribute("aria-busy", "true");
      updateUserMessageNavigation();
      return;
    }
    messagesEl.setAttribute("aria-busy", "false");
    var shouldStick = forceBottom || isNearBottom();
    var previousScrollTop = messagesEl.scrollTop;
    var renderedAdapter = state.currentAdapter;
    var renderedThreadId = state.currentThreadId;
    var renderRevision = ++state.messageRenderRevision;
    var scrollIntentRevision = state.scrollIntentRevision;
    var openFoldState = captureOpenFoldState();
    var messages = conversationMessages();
    var summary = resolveVisibleRunSummary(
      messages,
      currentTask(),
      effectiveRunSummary(),
      Date.now(),
      state.progressItems
    );
    var headerIndex = runHeaderInsertIndex(messages, summary);
    var pendingDelivery = summary ? null : currentPendingDelivery();
    if (!messages.length && !summary && !state.pendingApproval && state.approvalResults.length === 0 && state.progressItems.length === 0) {
      state.messageNodes = Object.create(null);
      var emptyTask = currentTask();
      if (isTemporaryTask(emptyTask)) {
        var emptyCreationError = taskCreationErrorText(emptyTask);
        messagesEl.innerHTML = '<div class="empty-state"><div class="empty-wordmark brand-logo" role="img" aria-label="WeRelay" style="--brand-logo-width: 150px"></div><h1>' +
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
        messagesEl.innerHTML = '<div class="empty-state"><div class="empty-wordmark brand-logo" role="img" aria-label="WeRelay" style="--brand-logo-width: 150px"></div><h1>还没有消息</h1><p>可以从手机继续这个任务。</p></div>';
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
    var latestAssistantIndex = -1;
    for (var scanIndex = messages.length - 1; scanIndex >= 0; scanIndex -= 1) {
      if (messages[scanIndex].role === "assistant" && !messages[scanIndex].pending) {
        latestAssistantIndex = scanIndex;
        break;
      }
    }
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
        nodes.push(getMessageNode(
          message,
          index,
          messages[index + 1],
          nodeKey,
          index === latestAssistantIndex,
          summary && summary.status
        ));
        return;
      }
      if (item.kind === "progress") {
        var progress = renderProgressList([item.progressItem], summary, messages);
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
    // 新任务的首帧必须直接落在本轮用户消息；若等 rAF，浏览器会先画出
    // scrollTop=0 的旧历史，随后再跳到最新内容。
    if (state.entryFocusKey === conversationStateKey(renderedAdapter, renderedThreadId)) {
      scrollToLatestUserMessage();
      updateUserMessageNavigation();
    }
    requestAnimationFrame(function () {
      if (
        renderRevision !== state.messageRenderRevision ||
        renderedAdapter !== state.currentAdapter ||
        renderedThreadId !== state.currentThreadId ||
        scrollIntentRevision !== state.scrollIntentRevision
      ) return;
      if (state.entryFocusKey === conversationStateKey(renderedAdapter, renderedThreadId)) {
        scrollToLatestUserMessage();
      } else if (shouldStick) scrollToLatest(false);
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

  function updateRunSummary(summary, task, messages, progressItems) {
    var taskRunning = isTaskActivelyRunning(task);
    var next = summary ? Object.assign({}, summary, { receivedAtMs: Date.now() }) : null;
    var previous = state.runSummary;
    if (!next && previous && previous.status === "running") {
      var finishedPrevious = (messages || []).some(function (message) {
        return message.role === "assistant" && message.phase === "final_answer" && message.turnId === previous.turnId;
      });
      next = finishedPrevious && task && !taskRunning
        ? Object.assign({}, previous, { status: "unknown" }) : previous;
    }
    var local = state.localRunSummary;
    var piNativeCompleted = false;
    // Pi records its terminal reply in the native session file but has no run
    // summary RPC. Settle only after the exact client message and a later final
    // assistant record are visible; an older reply or tool step is not proof.
    if (state.currentAdapter === "pi" && local && !next && !taskRunning && local.clientId) {
      var nativeUser = (messages || []).find(function (message) {
        return message.role === "user" &&
          (message.clientId === local.clientId ||
            !message.clientId && Number(message.createdAtMs) >= Number(local.startedAtMs) - 1000 &&
              String(message.text || "").trim() === String(local.requestText || "").trim()) &&
          Number(message.createdAtMs) >= Number(local.startedAtMs) - 1000;
      });
      var nativeFinal = nativeUser && (messages || []).find(function (message) {
        return message.role === "assistant" && message.phase === "final_answer" &&
          Number(message.createdAtMs) >= Number(nativeUser.createdAtMs) &&
          Number(message.createdAtMs) >= Number(local.startedAtMs);
      });
      if (nativeFinal) {
        piNativeCompleted = true;
        next = { status: "completed", startedAtMs: local.startedAtMs,
          completedAtMs: nativeFinal.createdAtMs, receivedAtMs: Date.now() };
      }
    }
    // Progress may arrive before both the native user page and the summary.
    // Only a matching/new turn can release the old-turn progress guard.
    if (local && (!next || next.turnId === local.baselineTurnId)) {
      var liveProgress = (progressItems || []).find(function (item) {
        return item && item.status === "running" && item.turnId &&
          (local.turnId ? item.turnId === local.turnId :
            item.turnId !== local.baselineTurnId && Number(item.createdAtMs) >= Number(local.startedAtMs));
      });
      if (liveProgress) next = { turnId: liveProgress.turnId, status: "running",
        startedAtMs: Number(liveProgress.createdAtMs), receivedAtMs: Date.now() };
    }
    var localTurnConfirmed = Boolean(local && local.turnId && next && next.turnId === local.turnId);
    var piOwnerSettledLocalTurn = Boolean(
      state.currentAdapter === "pi" && local && next && !taskRunning &&
      ["completed", "failed", "interrupted"].includes(next.status) &&
      Number(next.completedAtMs) >= Number(local.startedAtMs) &&
      (!next.turnId || !local.turnId || next.turnId === local.turnId)
    );
    var freshTurn = Boolean(local && next && next.turnId && next.turnId !== local.baselineTurnId &&
      Number(next.startedAtMs) >= Number(local.startedAtMs) &&
      (!local.turnId || next.turnId === local.turnId));
    if (next && next.status === "running" && task && !taskRunning) {
      var finalForTurn = (messages || []).some(function (message) {
        return message.role === "assistant" && message.phase === "final_answer" && message.turnId === next.turnId;
      });
      if (finalForTurn) next = Object.assign({}, next, {status: "unknown"});
      else if (previous && previous.turnId === next.turnId && ["completed", "failed", "interrupted"].includes(previous.status)) next = previous;
    }
    state.runSummary = next;
    if (local && (localTurnConfirmed || freshTurn || piNativeCompleted || piOwnerSettledLocalTurn) && next && next.status !== "unknown") {
      state.localRunSummary = null;
      state.optimisticProgressTurnId = next.status === "running" ? next.turnId : null;
    } else if (localTurnConfirmed && next.status === "unknown") {
      state.localRunSummary = null;
      state.optimisticProgressTurnId = null;
    } else if (!local && next && ["completed", "failed", "interrupted"].includes(next.status)) {
      state.optimisticProgressTurnId = null;
    }
    if (next && ["completed", "failed", "interrupted"].includes(next.status)) state.stopRequestedThreadId = "";
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
    var clientIds = Object.create(null);
    previous.forEach(function (message) { if (message.clientId) clientIds[messagePageKey(message)] = message.clientId; });
    var next = (incoming || []).map(function (message) {
      var clientId = clientIds[messagePageKey(message)];
      return clientId ? Object.assign({}, message, {clientId: clientId}) : message;
    });
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
      reconcilePendingMessages(state.serverMessages, payload.outboundMessages, payload.deliveredClientIds);
      renderQueuedMessages(state.queuedMessages);
      saveCurrentConversationSnapshot();
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
    if (taskNeedsCreation(currentTask()) && !state.pendingMessages.some(function (message) {
      return message.threadId === state.currentThreadId && message.serverAcknowledged;
    })) {
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
      if (payload.resolvedThreadId && payload.resolvedThreadId !== requestedThreadId) {
        migrateTemporaryConversation(requestedThreadId, payload.resolvedThreadId);
        finishLocalTaskDraft(payload.resolvedThreadId);
        void loadCurrentTaskModel(true);
        void loadCurrentTaskPermission(true);
        void loadTasks(false);
      }
      applyLatestMessagePage(payload, historyOnly);
      if (!historyOnly) {
        state.lastLiveMessageRefreshAtMs = Date.now();
        if (typeof payload.revision === "string" && payload.revision) {
          state.contentRevision = payload.revision;
        }
      }
      var messages = state.serverMessages;
      state.outboundMessages = Array.isArray(payload.outboundMessages)
        ? payload.outboundMessages
        : [];
      state.deliveredClientIds = sanitizeDeliveredClientIds(payload.deliveredClientIds);
      reconcilePendingMessages(messages, state.outboundMessages, state.deliveredClientIds);
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
        updateRunSummary(payload.runSummary || null, payload.task || null, messages, payload.progressItems || []);
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
        state.outboundMessages,
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
      if (
        state.cacheSyncState === "waiting-computer" ||
        state.cacheSyncState === "server-retry"
      ) setCacheSyncState("current");
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
        if (isMobileConnectionUnavailable(error)) {
          setCacheSyncState(
            state.connectionMode === "unknown" ? "server-retry" : "waiting-computer"
          );
        } else {
          showToast(error.message || "消息读取失败");
        }
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

  function migrateTemporaryConversation(temporaryThreadId, realThreadId, requestedAdapter) {
    var adapter = requestedAdapter || state.currentAdapter;
    var oldSettingsKey = conversationStateKey(adapter, temporaryThreadId);
    var newSettingsKey = conversationStateKey(adapter, realThreadId);
    [state.taskModels, state.taskPermissions].forEach(function (cache) {
      if (cache && cache[oldSettingsKey]) {
        cache[newSettingsKey] = Object.assign({}, cache[oldSettingsKey], { loadedAtMs: 0 });
        delete cache[oldSettingsKey];
      }
    });
    if (state.currentAdapter !== adapter || state.currentThreadId !== temporaryThreadId) {
      var oldKey = conversationStateKey(adapter, temporaryThreadId);
      var newKey = conversationStateKey(adapter, realThreadId);
      var snapshot = state.conversationSnapshots[oldKey];
      if (snapshot) (snapshot.pendingMessages || []).forEach(function (message) { message.threadId = realThreadId; });
      moveConversationValue(state.conversationSnapshots, state.conversationSnapshotOrder, oldKey, newKey, MAX_CONVERSATION_SNAPSHOTS);
      moveConversationValue(state.composerDrafts, state.composerDraftOrder, oldKey, newKey, MAX_COMPOSER_DRAFTS);
      var tasks = state.currentAdapter === adapter ? state.tasks : (state.taskSnapshots[adapter] || {}).tasks || [];
      tasks.forEach(function (task) { if (task.threadId === temporaryThreadId) { task.threadId = realThreadId; task.localCreationState = "ready"; } });
      schedulePersistentMobileCacheWrite();
      return;
    }
    var temporaryKey = conversationStateKey(state.currentAdapter, temporaryThreadId);
    var realKey = conversationStateKey(state.currentAdapter, realThreadId);
    saveComposerDraft(state.currentAdapter, temporaryThreadId);
    state.pendingMessages.forEach(function (pending) {
      if (pending.threadId === temporaryThreadId) pending.threadId = realThreadId;
    });
    var temporaryTask = taskById(temporaryThreadId);
    if (temporaryTask) {
      temporaryTask.threadId = realThreadId;
      temporaryTask.localCreationState = "ready";
      temporaryTask.lastUpdatedAt = new Date().toISOString();
      rememberLocalTaskDraft(temporaryTask);
    }
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


  async function createTask(sourceThreadId, projectName, existingTemporaryTask) {
    if (state.switchingAdapter) return;
    var reusableTask = currentLocalTaskDraft();
    if (!existingTemporaryTask && reusableTask) {
      await selectTask(reusableTask.threadId, true);
      requestAnimationFrame(function () { composerInput.focus(); });
      showToast("已回到未完成的新任务");
      return;
    }
    var temporaryTask = existingTemporaryTask || createTemporaryTask(sourceThreadId, projectName);
    temporaryTask.localCreationState = "ready";
    temporaryTask.localCreationError = "";
    temporaryTask.localSourceThreadId = sourceThreadId || "";
    rememberLocalTaskDraft(temporaryTask);
    if (!existingTemporaryTask) {
      state.tasks.unshift(temporaryTask);
      await selectTask(temporaryTask.threadId, true);
    } else {
      renderTasks();
      updateHeader();
      renderMessages(false);
    }
    requestAnimationFrame(function () { composerInput.focus(); });
    showToast(sourceThreadId
      ? "新任务已准备好，发送第一条消息后创建"
      : "新任务已准备好，发送第一条消息后创建");
  }

  async function selectTask(threadId, updateUrl) {
    closeTaskContextMenu();
    if (!threadId) return;
    if (state.settingsOpen) setSettingsOpen(false, updateUrl);
    if (threadId === state.currentThreadId) {
      void loadNativeComposerDraft();
      var currentEntryGeneration = beginConversationEntryFocus(state.currentAdapter, threadId);
      if (updateUrl) {
        var currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set("task", threadId);
        history.replaceState(null, "", currentUrl.pathname + currentUrl.search + currentUrl.hash);
      }
      closeSidebar();
      state.revealCurrentTaskOnSidebarOpen = true;
      renderTasks();
      updateHeader();
      requestAnimationFrame(function () {
        if (
          currentEntryGeneration === state.entryFocusGeneration &&
          state.entryFocusKey === conversationStateKey(state.currentAdapter, threadId)
        ) scrollToLatestUserMessage();
      });
      if (isTemporaryTask(currentTask())) {
        void loadCurrentTaskModel(false);
        void loadCurrentTaskPermission(false);
        finishConversationEntryFocus(currentEntryGeneration);
      } else {
        void Promise.all([
          refreshMessagesIfChanged(false, true),
          loadCurrentTaskModel(false),
          loadCurrentTaskPermission(false)
        ]).finally(function () {
          finishConversationEntryFocus(currentEntryGeneration);
        });
      }
      return;
    }
    saveCurrentConversationSnapshot();
    state.messageRequestId += 1;
    state.loadingMessages = false;
    state.trailingMessageRefresh = null;
    state.composerRevision += 1;
    state.currentThreadId = threadId;
    var entryGeneration = beginConversationEntryFocus(state.currentAdapter, threadId);
    state.modelRequestId += 1;
    state.modelChanging = false;
    state.reasoningChanging = false;
    state.permissionRequestId += 1;
    state.permissionChanging = false;
    closeModelMenu();
    closeSessionMenu();
    renderModelControl();
    state.loadingOlderMessages = false;
    state.historyRequestId += 1;
    state.resolvingApproval = false;
    var restored = restoreConversationSnapshot(state.currentAdapter, threadId);
    if (!restored) {
      state.serverMessages = [];
      state.outboundMessages = [];
      state.deliveredClientIds = [];
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
    void loadNativeComposerDraft();
    closeSidebar();
    state.revealCurrentTaskOnSidebarOpen = true;
    renderTasks();
    updateHeader();
    rememberCurrentTaskSnapshot();
    schedulePersistentMobileCacheWrite();
    if (isTemporaryTask(currentTask())) {
      void loadCurrentTaskModel(false);
      void loadCurrentTaskPermission(false);
      renderMessages(false);
      finishConversationEntryFocus(entryGeneration);
      return;
    }
    void loadCurrentTaskModel(false);
    void loadCurrentTaskPermission(false);
    if (restored) {
      void refreshMessagesIfChanged(false, true).finally(function () {
        finishConversationEntryFocus(entryGeneration);
      });
      return;
    }
    await loadMessages(true, true, false);
    if (threadId === state.currentThreadId) {
      // 首次载入与实时续读都由 entryFocusKey 锚定最新用户消息，
      // 不再把上一次尚未绘制完成的 scrollTop=0 写回去。
      void loadMessages(false, false, false).finally(function () {
        finishConversationEntryFocus(entryGeneration);
      });
    }
  }

  function showToast(text) {
    if (isMobileConnectionUnavailableMessage(text)) {
      setCacheSyncState(
        state.connectionMode === "unknown" ? "server-retry" : "waiting-computer"
      );
      return;
    }
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

  function renderPendingImages() { composerView.renderImages(state.pendingImages); }

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
    composerView.resize();
    updateHeader();
  }

  var pendingImageDatabase = null;
  function openPendingImageDatabase() {
    if (pendingImageDatabase) return pendingImageDatabase;
    pendingImageDatabase = new Promise(function (resolve, reject) {
      var request = indexedDB.open("werelay-pending-images", 1);
      request.onupgradeneeded = function () { request.result.createObjectStore("images"); };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error("图片存储暂时被其他页面占用")); };
    }).catch(function (error) { pendingImageDatabase = null; throw error; });
    return pendingImageDatabase;
  }

  async function pendingImageStoreOperation(key, images) {
    var database = await openPendingImageDatabase();
    return new Promise(function (resolve, reject) {
      var writing = images !== undefined;
      var transaction = database.transaction("images", writing ? "readwrite" : "readonly");
      var store = transaction.objectStore("images");
      var request = images === null ? store.delete(key) : writing ? store.put(images, key) : store.get(key);
      transaction.oncomplete = function () { resolve(request.result); };
      transaction.onerror = transaction.onabort = function () { reject(transaction.error || new Error("图片保存失败")); };
    });
  }

  async function persistPendingMessageImages(pending) {
    if (!pending.imageCount || pending.imagesPersisted) return;
    // Do not clear or send partial image messages. A quota error retains the original composer data.
    if ((pending.images || []).length !== Number(pending.imageCount) || pending.images.some(function (image) { return !image.dataBase64; })) {
      var error = new Error("图片原件不在此浏览器缓存中，请重新添加；后续消息仍可发送。");
      error.attachmentMissing = true;
      throw error;
    }
    pending.imageStoreKey = pending.imageStoreKey || pending.clientId;
    try {
      await pendingImageStoreOperation(pending.imageStoreKey, pending.images);
    } catch (_) {
      var storageError = new Error("浏览器无法保存图片原件，请释放存储空间后重试；本页图片仍保留，暂勿关闭网页。");
      storageError.attachmentMissing = true;
      throw storageError;
    }
    pending.imagesPersisted = true;
  }

  async function restorePendingMessageImages(pending) {
    if (!pending.imageStoreKey || (pending.images || []).some(function (image) { return Boolean(image.dataBase64); })) return;
    var images = await pendingImageStoreOperation(pending.imageStoreKey);
    if (Array.isArray(images) && images.length === Number(pending.imageCount)) {
      pending.images = images;
      pending.imagesPersisted = true;
    }
  }

  function makePendingMessage(text, images) {
    return {
      clientId: "mobile-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      createdAtMs: Date.now(),
      threadId: state.currentThreadId,
      adapter: state.currentAdapter,
      text: text,
      composerDraftRevision: nativeComposerDraftReference(),
      images: images.slice(),
      imageCount: images.length,
      status: "sending",
      browserAttempts: 0,
      manualRetry: false,
      createTaskSourceThreadId: "",
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

  function pendingMessagesForTarget(pending) {
    if ((!pending.adapter || pending.adapter === state.currentAdapter) && pending.threadId === state.currentThreadId) return state.pendingMessages;
    var key = conversationStateKey(pending.adapter || state.currentAdapter, pending.threadId);
    var snapshot = state.conversationSnapshots && state.conversationSnapshots[key];
    return snapshot && snapshot.pendingMessages || [];
  }

  function pendingMessageNeedsServerAcceptance(pending) {
    return !pending.retryBlocked && !pending.serverAcknowledged && !["accepted", "queued", "submitted", "delivered"].includes(pending.status);
  }

  function hasEarlierPendingMessage(pending) {
    var collection = pendingMessagesForTarget(pending);
    var pendingIndex = collection.findIndex(function (message) {
      return message.clientId === pending.clientId;
    });
    if (pendingIndex <= 0) return false;
    return collection.slice(0, pendingIndex).some(function (message) {
      return message.adapter === pending.adapter && message.threadId === pending.threadId && pendingMessageNeedsServerAcceptance(message);
    });
  }

  function submitNextWaitingMessage() {
    if (state.sending || !state.authenticated || navigator.onLine === false) return;
    var candidates = state.pendingMessages.slice();
    Object.keys(state.conversationSnapshots || {}).forEach(function (key) {
      var snapshot = state.conversationSnapshots[key];
      (snapshot.pendingMessages || []).forEach(function (message) {
        if (message.adapter && message.threadId && !candidates.some(function (candidate) { return candidate.clientId === message.clientId; })) candidates.push(message);
      });
    });
    var next = candidates.find(function (message) {
      return pendingMessageNeedsServerAcceptance(message) && !message.inFlight &&
        !message.deliveryConfirmed && !message.serverAcknowledged &&
        Number(message.retryAtMs || 0) <= Date.now() && !hasEarlierPendingMessage(message);
    });
    if (next) void submitPendingMessage(next);
  }

  async function confirmPendingTaskSettings(pending, requestedAdapter, requestedThreadId) {
    var required = pending.requiredTaskSettings;
    if (!required || (!required.model && !required.reasoningEffort)) return;
    var path = adapterApiPath(
      "/api/tasks/" + encodeURIComponent(requestedThreadId) + "/model",
      requestedAdapter
    );
    function matches(payload) {
      return payload &&
        (!required.model || payload.currentModel === required.model) &&
        (!required.reasoningEffort || payload.currentReasoningEffort === required.reasoningEffort);
    }
    try {
      var sync = state.taskSettingSync;
      var sameRequest = sync && sync.adapter === requestedAdapter &&
        sync.threadId === requestedThreadId &&
        sync.model === required.model &&
        sync.reasoningEffort === required.reasoningEffort;
      // On a reload, the original PUT may have succeeded without its response
      // reaching this tab. Read the owner first; repeat only if still needed.
      var payload;
      if (sameRequest) {
        try {
          payload = await sync.promise;
        } catch (requestError) {
          // A lost PUT response does not mean the desktop rejected the change.
          payload = await api(path, { cache: "no-store" });
          if (!matches(payload)) throw requestError;
        }
      } else {
        payload = await api(path, { cache: "no-store" });
      }
      if (!matches(payload) && !sameRequest) {
        payload = await api(path, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(required)
        });
      }
      if (!matches(payload)) throw new Error("电脑尚未确认所选模型设置");
      delete pending.requiredTaskSettings;
      pending.status = "sending";
      persistMobileCacheNow();
    } catch (error) {
      var failure = new Error("模型设置未确认，消息未发送：" + (error && error.message || "请稍后重试"));
      failure.modelSyncFailed = true;
      throw failure;
    }
  }

  async function submitPendingMessage(pending) {
    if (pending.inFlight || pending.deliveryConfirmed || pending.serverAcknowledged) return;
    var requestedThreadId = pending.threadId;
    var requestedAdapter = pending.adapter || state.currentAdapter;
    function targetVisible() { return pending.threadId === state.currentThreadId && requestedAdapter === state.currentAdapter; }
    if (hasEarlierPendingMessage(pending)) {
      pending.status = "waiting_to_send";
      if (targetVisible()) renderMessages(true);
      updateHeader();
      saveCurrentConversationSnapshot();
      return;
    }
    if (state.sending) {
      pending.status = "waiting_to_send";
      if (targetVisible()) renderMessages(true);
      updateHeader();
      return;
    }
    if (targetVisible()) cancelConversationEntryFocus();
    state.sending = true;
    pending.inFlight = true;
    pending.status = pending.requiredTaskSettings ? "syncing_model" :
      pending.browserAttempts > 0 ? "retrying" : (
        pending.waitingForTaskCreation ? "creating_task" : "sending"
      );
    if (targetVisible()) renderMessages(true);
    updateHeader();
    try {
      var retainedByServer = pending.manualRetry && (state.outboundMessages || []).some(function (message) {
        return message.clientId === pending.clientId;
      });
      if (!retainedByServer) {
        await restorePendingMessageImages(pending);
        await persistPendingMessageImages(pending);
      }
      saveCurrentConversationSnapshot();
      persistMobileCacheNow();
      if (pending.deliveryConfirmed || pending.serverAcknowledged) return;
      await confirmPendingTaskSettings(pending, requestedAdapter, requestedThreadId);
      if (targetVisible()) renderMessages(true);
      var images = (pending.images || []).map(function (image) {
        return {
          fileName: image.fileName,
          mimeType: image.mimeType,
          dataBase64: image.dataBase64
        };
      });
      var body = JSON.stringify({
        clientId: pending.clientId,
        createdAtMs: pending.createdAtMs,
        text: pending.text,
        composerDraftRevision: pending.composerDraftRevision || undefined,
        images: images,
        retry: Boolean(pending.manualRetry),
        newTaskSettings: String(requestedThreadId).startsWith("local-new-") ? pending.newTaskSettings : undefined,
        createTaskSourceThreadId: pending.waitingForTaskCreation
          ? pending.createTaskSourceThreadId || ""
          : undefined
      });
      var result = await api(adapterApiPath(
        "/api/tasks/" + encodeURIComponent(requestedThreadId) + "/messages",
        requestedAdapter
      ), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body,
        keepalive: body.length < 60 * 1024
      });
      if (pending.deliveryConfirmed) return;
      pending.serverAcknowledged = true;
      pending.manualRetry = false;
      pending.browserAttempts = 0;
      pending.turnId = result.turnId || pending.turnId || "";
      pending.queuedMessageId = result.queuedMessageId || pending.queuedMessageId || "";
      pending.queued = Boolean(result.queued || result.status === "queued");
      pending.status = result.status || (pending.queued ? "queued" : "accepted");
      if (result.threadId && result.threadId !== requestedThreadId) {
        migrateTemporaryConversation(requestedThreadId, result.threadId, requestedAdapter);
      }
      if (pending.queued && pending.optimisticRun && requestedThreadId === state.currentThreadId && requestedAdapter === state.currentAdapter) {
        state.localRunSummary = null;
        state.optimisticProgressTurnId = null;
        pending.optimisticRun = false;
      }
      renderQueuedMessages(state.queuedMessages);
      if (targetVisible()) renderMessages(true);
      setTimeout(function () {
        var activeThreadId = result.threadId || requestedThreadId;
        if (requestedAdapter === state.currentAdapter && (activeThreadId === state.currentThreadId || requestedThreadId === state.currentThreadId)) {
          void loadMessages(true);
        }
      }, 180);
    } catch (error) {
      if (pending.deliveryConfirmed || pending.serverAcknowledged) return;
      pending.browserAttempts = Math.min(30, Number(pending.browserAttempts || 0) + 1);
      pending.lastError = error && error.message || "网络连接暂时中断";
      pending.retryBlocked = Boolean(error && (error.attachmentMissing || error.modelSyncFailed)) ||
        isNativeComposerDraftConflict(error) ||
        [400, 413, 422].includes(error && error.status);
      pending.status = pending.retryBlocked ? "failed" : "retrying";
      pending.retryAtMs = Date.now() + Math.min(30000, 1000 * Math.pow(2, pending.browserAttempts - 1));
      pending.displayInTranscript = true;
      if (pending.optimisticRun && requestedThreadId === state.currentThreadId && requestedAdapter === state.currentAdapter) {
        state.localRunSummary = null;
        state.optimisticProgressTurnId = null;
        pending.optimisticRun = false;
      }
      if (targetVisible()) renderMessages(true);
      if (!pending.retryBlocked) {
        setTimeout(function () { submitNextWaitingMessage(); }, Math.max(1000, pending.retryAtMs - Date.now()));
      }

    } finally {
      state.sending = false;
      pending.inFlight = false;
      updateHeader();
      saveCurrentConversationSnapshot();
      submitNextWaitingMessage();
    }
  }

  function beginOptimisticRunIfNeeded(pending) {
    var visibleSummary = currentVisibleRunSummary();
    if (visibleSummary && visibleSummary.status === "running") return;
    pending.optimisticRun = true;
    state.optimisticProgressTurnId = "";
    state.progressItems = [];
    state.localRunSummary = {
      status: "submitting",
      clientId: pending.clientId,
      requestText: pending.text,
      baselineTurnId: state.runSummary && state.runSummary.turnId || "",
      startedAtMs: Date.now(),
      durationMs: 0,
      receivedAtMs: Date.now()
    };
  }

  async function copyMessageText(text) {
    var value = String(text || "");
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      showToast("消息已复制");
    } catch (_) {
      var textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
      showToast("消息已复制");
    }
  }

  function retryPendingMessage(clientId) {
    if ((state.deliveredClientIds || []).includes(clientId)) {
      reconcilePendingMessages(state.serverMessages, state.outboundMessages, state.deliveredClientIds);
      renderMessages(false);
      return;
    }
    var pending = state.pendingMessages.find(function (message) { return message.clientId === clientId; });
    if (!pending) {
      var outbound = (state.outboundMessages || []).find(function (message) { return message.clientId === clientId; });
      if (!outbound) return;
      outbound.status = "accepted";
      outbound.attempts = 0;
      pending = {
        clientId: outbound.clientId,
        createdAtMs: outbound.createdAtMs || Date.now(),
        threadId: state.currentThreadId,
        text: outbound.text || "",
        images: [],
        imageCount: outbound.imageCount || (outbound.images || []).length,
        status: "accepted",
        browserAttempts: 0,
        manualRetry: true,
        createTaskSourceThreadId: currentTask() && currentTask().localSourceThreadId || "",
        waitingForTaskCreation: String(state.currentThreadId || "").startsWith("local-new-"),
        turnId: "",
        queued: false,
        optimisticRun: false,
        displayInTranscript: true,
        baselineUserCount: state.serverMessages.filter(function (message) { return message.role === "user"; }).length,
        baselineUserKeys: state.serverMessages.filter(function (message) {
          return message.role === "user";
        }).map(messagePageKey)
      };
      state.pendingMessages.push(pending);
    }
    reconcilePendingMessages(state.serverMessages);
    if (pending.deliveryConfirmed) {
      renderMessages(false);
      return;
    }
    var task = taskById(pending.threadId);
    pending.manualRetry = true;
    pending.serverAcknowledged = false;
    pending.retryBlocked = false;
    pending.retryAtMs = 0;
    pending.browserAttempts = 0;
    if (!isTemporaryTask(task)) beginOptimisticRunIfNeeded(pending);
    renderMessages(true);
    void submitPendingMessage(pending);
  }

  async function submitComposer(event) {
    event.preventDefault();
    if (state.preparingMessage) return;
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
    if (state.nativeComposerDraft && state.nativeComposerDraft.conflict) {
      if (!window.confirm("电脑端草稿已发送或修改。确认把当前网页内容作为一条新消息发送吗？")) return;
      state.nativeComposerDraft = null;
      saveComposerDraft(state.currentAdapter, state.currentThreadId);
    }
    var pending = makePendingMessage(text, images);
    var settingSync = state.taskSettingSync;
    if (settingSync && settingSync.adapter === pending.adapter && settingSync.threadId === pending.threadId) {
      pending.requiredTaskSettings = settingSync.model
        ? { model: settingSync.model }
        : { reasoningEffort: settingSync.reasoningEffort };
    }
    var waitingForTaskCreation = taskNeedsCreation(task);
    var visibleRunSummaryForQueue = effectiveRunSummary();
    // 只有「当前任务确实在跑」时才进待发队列；空闲时发出应立刻成为正文气泡，
    // 否则用户会看到自己的消息卡在队列里等一个根本没在跑的任务。
    var willQueue = shouldQueueComposerSubmission(
      task,
      visibleRunSummaryForQueue,
      state.queuedMessages,
      state.pendingApproval,
      waitingForTaskCreation
    );
    pending.displayInTranscript = !willQueue;
    if (waitingForTaskCreation) {
      pending.waitingForTaskCreation = true;
      pending.createTaskSourceThreadId = task.localSourceThreadId || "";
      pending.newTaskSettings = task.newTaskSettings ? Object.assign({}, task.newTaskSettings) : undefined;
      pending.status = "creating_task";
      pending.displayInTranscript = true;
    }
    // Persist before clearing the composer or waiting behind another send.
    // Otherwise a queued image only exists in RAM and disappears on reload.
    state.preparingMessage = true;
    try {
      await persistPendingMessageImages(pending);
    } catch (error) {
      showToast(error.message || "图片未保存，请保留本页并重试");
      return;
    } finally { state.preparingMessage = false; }
    if (pending.adapter !== state.currentAdapter || pending.threadId !== state.currentThreadId) {
      var original = state.conversationSnapshots[conversationStateKey(pending.adapter, pending.threadId)];
      if (original) {
        original.pendingMessages.push(pending);
        original.pendingImages = [];
        consumeNativeComposerDraft(pending);
        var originalDraft = state.composerDrafts[conversationStateKey(pending.adapter, pending.threadId)];
        if (originalDraft && originalDraft.text === text) clearComposerDraft(pending.adapter, pending.threadId);
        schedulePersistentMobileCacheWrite();
        void submitPendingMessage(pending);
      }
      return;
    }
    if (!waitingForTaskCreation && !willQueue) beginOptimisticRunIfNeeded(pending);
    state.composerRevision += 1;
    state.pendingMessages.push(pending);
    if (waitingForTaskCreation) renderModelControl();
    consumeNativeComposerDraft(pending);
    if (composerInput.value === text) {
      composerInput.value = "";
      clearComposerDraft(state.currentAdapter, state.currentThreadId);
    } else saveComposerDraft(state.currentAdapter, state.currentThreadId);
    state.pendingImages = state.pendingImages.filter(function (image) { return !images.includes(image); });
    renderPendingImages();
    resizeComposer();
    renderQueuedMessages(state.queuedMessages);
    renderMessages(true);
    void submitPendingMessage(pending);
  }

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

  function toggleComposerModel() {
    var modelState = currentTaskModelState();
    if (!modelState || modelState.loadError) {
      void loadCurrentTaskModel(true).then(function (loaded) {
        if (loaded && loaded.canChange) { state.modelMenuOpen = true; renderModelControl(); }
      });
      return;
    }
    if (!modelState.canChange) {
      showToast(modelState.unavailableReason || "当前任务暂时不能切换模型");
      return;
    }
    state.modelMenuOpen = !state.modelMenuOpen;
    closeSessionMenu();
    renderModelControl();
  }

  function toggleComposerSession() {
    var modelState = currentTaskModelState();
    var permissionState = currentTaskPermissionState();
    var canChangeReasoning = Boolean(
      modelState && modelState.canChangeReasoningEffort &&
      Array.isArray(modelState.reasoningEffortOptions) && modelState.reasoningEffortOptions.length > 0
    );
    var canChangePermission = Boolean(
      permissionState && permissionState.canChange &&
      Array.isArray(permissionState.options) && permissionState.options.length > 0
    );
    if (!canChangeReasoning && !canChangePermission) {
      showToast(
        modelState && modelState.reasoningEffortUnavailableReason ||
        permissionState && permissionState.unavailableReason ||
        "当前任务暂时不能切换推理强度或访问权限"
      );
      return;
    }
    if (state.reasoningChanging || state.permissionChanging) return;
    state.sessionMenuOpen = !state.sessionMenuOpen;
    closeModelMenu();
    renderSessionControl();
  }

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
    state.outboundMessages = [];
    state.deliveredClientIds = [];
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
    state.nativeComposerDraft = null;
    state.nativeComposerDraftConsumed = Object.create(null);
    state.nativeComposerDraftRequest += 1;
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
    if (!state.entryFocusKey && messagesEl.scrollTop < 120) void loadOlderMessages();
  });
  messagesEl.addEventListener("wheel", cancelConversationEntryFocus, { passive: true });
  messagesEl.addEventListener("touchstart", cancelConversationEntryFocus, { passive: true });
  messagesEl.addEventListener("keydown", cancelConversationEntryFocus);
  previousUserMessage.addEventListener("click", function () {
    cancelConversationEntryFocus();
    navigateToUserMessage(Number(previousUserMessage.dataset.messageIndex));
  });
  nextUserMessage.addEventListener("click", function () {
    cancelConversationEntryFocus();
    navigateToUserMessage(Number(nextUserMessage.dataset.messageIndex));
  });
  workspaceSwitcher.addEventListener("click", function () { toggleWorkspaceMenu(); });
  taskBoardOpen.addEventListener("click", function () {
    setTaskBoardOpen(!state.boardOpen, true);
  });
  taskBoardMenuButton.addEventListener("click", openSidebar);
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
  messagesEl.addEventListener("pointerdown", function () {
    cancelConversationEntryFocus();
    closeTaskContextMenu();
  });
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
    if (!taskContextMenu.hidden && !taskContextMenu.contains(event.target)) {
      closeTaskContextMenu();
    }
    if (
      cacheSyncIndicator.hidden === false &&
      ["waiting-computer", "server-retry"].includes(state.cacheSyncState)
    ) {
      state.nextTaskRefreshAtMs = 0;
      state.pendingMessages.forEach(function (pending) {
        pending.retryAtMs = 0;
      });
      void loadTasks(false);
      if (state.currentThreadId) {
        void refreshMessagesIfChanged(false, true);
        submitNextWaitingMessage();
      }
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
      if (state.modelMenuOpen && state.activeModelGroup !== null) {
        event.preventDefault();
        state.activeModelGroup = null;
        renderModelControl();
        return;
      }
      closeModelMenu();
      closeSessionMenu();
      toggleWorkspaceMenu(false);
    }
  });
  document.getElementById("menu-button").addEventListener("click", openSidebar);
  document.getElementById("sidebar-close").addEventListener("click", closeSidebar);
  document.getElementById("sidebar-overlay").addEventListener("click", closeSidebar);
  settingsOpen.addEventListener("click", function () {
    setSettingsOpen(true, true);
  });
  document.querySelectorAll("[data-settings-tab]").forEach(function (button) {
    button.addEventListener("click", function () {
      if (state.settingsOpen) selectSettingsTab(button.dataset.settingsTab);
    });
  });
  settingsMenuButton.addEventListener("click", openSidebar);

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
            loadNativeComposerDraft(),
            loadCurrentTaskModel(false),
            loadCurrentTaskPermission(false)
          ];
      if (!state.boardOpen && Date.now() >= state.nextTaskRefreshAtMs) {
        refreshes.push(loadTasks(false));
      }
      await Promise.all(refreshes);
      submitNextWaitingMessage();
      scheduleLiveRefresh(document.hidden ? 10000 : 2200);
    }, delayMs);
  }

  window.addEventListener("online", function () {
    state.pendingMessages.forEach(function (pending) { pending.retryAtMs = 0; });
    submitNextWaitingMessage();
  });

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
          loadNativeComposerDraft(),
          loadCurrentTaskModel(true),
          loadCurrentTaskPermission(true)
        ]);
      })();
    }
    scheduleLiveRefresh(document.hidden ? 10000 : 300);
  });

  window.addEventListener("werelay:open-task", function (event) {
    var target = event.detail;
    if (!target || typeof target.adapter !== "string" || typeof target.threadId !== "string") return;
    var url = new URL(window.location.href);
    url.searchParams.set("adapter", target.adapter);
    url.searchParams.set("task", target.threadId);
    url.searchParams.delete("view");
    history.replaceState(null, "", url.pathname + url.search);
    if (state.authenticated && !state.cachePreviewMode) {
      void openTaskFromBoard({ adapter: target.adapter, threadId: target.threadId, title: "任务" });
    }
  });

  updateDocumentTitle();
  async function startMobileApplication() {
    if (window.WeRelayPlatform) await window.WeRelayPlatform.ready;
    bootOrbAnimation.setup();
    restoreTrustedPersistentMobileCachePreview();
    if (window.WeRelayPlatform) window.WeRelayPlatform.healthReady();
    void waitForComputerConnection();
    await initializeAuthentication();
  }
  void startMobileApplication();
})();
`;

export const CODEX_MOBILE_JS = CHAT_COMPONENTS_JS + CODEX_MOBILE_APP_JS;

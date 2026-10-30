import { COMPOSER_BEAM_CSS } from "./composer-beam.ts";

export const MESSAGE_BUBBLE_CSS = String.raw`
.message-row { width: min(100%, var(--thread-max)); display: flex; margin: 0 auto 20px; }
.message-row.user { justify-content: flex-end; }
.message-card { min-width: 0; max-width: 100%; color: var(--text); font-size: 16px; line-height: 1.52; overflow-wrap: anywhere; }
.message-row.user .message-card { max-width: min(78%, 38rem); padding: 10px 16px; border-radius: 20px; background: var(--surface); }
.message-row.assistant { margin-bottom: 16px; }
.message-row.assistant.continues { margin-bottom: 10px; }
.message-row.assistant .message-card { width: 100%; color: var(--text); font-size: 15px; line-height: 1.62; }
.message-row.assistant.commentary .message-card { padding-left: 0; border-left: 0; color: var(--text); }
.message-row.task .message-card { width: 100%; padding: 12px 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); font-size: 14px; line-height: 1.62; }
.message-source-task { margin-bottom: 8px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.message-model { margin-top: 10px; color: var(--muted); font-size: 11px; font-weight: 430; line-height: 1.4; }
.message-time { margin-top: 6px; color: var(--muted); font-size: 11px; font-weight: 400; line-height: 1.4; }
`;

export const MESSAGE_MEDIA_CSS = String.raw`
.message-row.user.pending .message-card { opacity: 1; }
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
`;

export const CHAT_PROGRESS_CSS = String.raw`
.run-progress { width: min(100%, var(--thread-max)); display: grid; gap: 9px; margin: 0 auto 4px; color: var(--muted); font-size: 14px; font-weight: 400; line-height: 1.45; }
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
`;

export const CHAT_TEXT_CSS = String.raw`
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
.message-tools-group { overflow: hidden; margin: 14px 0; border: 1px dashed var(--border); border-radius: 12px; background: transparent; }
.message-tools-group > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 36px; padding: 0 13px; cursor: pointer; list-style: none; color: var(--muted); font-size: 12px; line-height: 1.4; }
.message-tools-group > summary::-webkit-details-marker { display: none; }
.message-tools-group-items { padding: 0 10px 10px; }
.message-tools-group-items .message-code-fold { margin: 10px 0 0; }
.message-content a { color: #0b57d0; text-decoration: underline; text-decoration-color: rgba(11, 87, 208, 0.32); text-underline-offset: 2px; }
.message-content hr { height: 1px; margin: 22px 0; border: 0; background: var(--border); }
.message-content img { max-width: 100%; height: auto; border-radius: 12px; }
`;

export const CHAT_COMPOSER_CSS = String.raw`
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
/* 队列接到输入框上圆角的切点，保留输入框原有圆角。 */
.composer-wrap { --composer-radius: 28px; }
.composer-queue { box-sizing: border-box; width: max(0px, calc(min(100%, var(--thread-max)) - 2 * var(--composer-radius))); min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; max-height: 190px; overflow: hidden auto; overscroll-behavior: contain; scrollbar-width: thin; margin: 0 auto; border: 1px solid var(--border); border-bottom: 0; border-radius: 14px 14px 0 0; background: var(--page); }
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
.composer-model-menu { position: absolute; left: 0; bottom: calc(100% + 8px); width: min(360px, calc(100vw - 64px)); min-width: min(300px, calc(100vw - 64px)); max-width: calc(100vw - 64px); max-height: min(360px, 52vh); overflow: auto; padding: 5px; border: 1px solid var(--border); border-radius: 13px; background: var(--page); box-shadow: var(--shadow); z-index: 30; }
.composer-session-menu { left: auto; right: 0; width: fit-content; max-width: min(360px, calc(100vw - 48px)); min-width: 188px; }
.composer-permission-option .composer-model-option-label { white-space: nowrap; overflow-wrap: normal; }
.composer-model-menu[hidden] { display: none; }
.composer-model-group { padding: 7px 9px 3px; color: var(--muted); font-size: 11px; font-weight: 560; letter-spacing: .02em; white-space: nowrap; user-select: none; -webkit-user-select: none; pointer-events: none; }
.composer-model-group:not(:first-child) { margin-top: 3px; border-top: 1px solid var(--border); }
.composer-model-back { width: 100%; min-height: 38px; display: inline-flex; align-items: center; gap: 6px; padding: 6px 9px; margin-bottom: 3px; border: 0; border-radius: 9px; border-bottom: 1px solid var(--border); background: transparent; color: var(--muted-strong); font: inherit; font-size: 12px; font-weight: 560; cursor: pointer; }
.composer-model-back:hover { background: var(--surface); color: var(--text); }
.composer-model-chevron-left { transform: rotate(90deg); }
.composer-model-chevron-right { transform: rotate(-90deg); }
.composer-model-option { width: 100%; min-height: 44px; display: grid; grid-template-columns: minmax(0, 1fr) 18px; gap: 10px; align-items: center; padding: 7px 9px; border: 0; border-radius: 9px; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.composer-model-option:hover { background: var(--surface); }
.composer-model-option:disabled { opacity: .48; cursor: wait; }
.composer-model-option-copy { min-width: 0; }
.composer-model-option-label { display: block; overflow: hidden; overflow-wrap: normal; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; font-weight: 560; }
.composer-model-option-description { display: block; margin-top: 2px; overflow-wrap: anywhere; white-space: normal; color: var(--muted); font-size: 11px; font-weight: 430; }
.composer-model-option-check { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.8; }
.queued-followup { min-width: 0; background: var(--page); }
.queued-followup + .queued-followup { border-top: 1px solid var(--border); }
.queued-followup-main { min-width: 0; display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 8px; }
.queued-followup-icon { width: 20px; height: 20px; flex: 0 0 auto; display: grid; place-items: center; color: var(--muted-strong); }
.queued-followup-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
.queued-followup-copy { flex: 1; min-width: 0; }
.queued-followup-text { min-width: 0; max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text); font-size: 14px; line-height: 1.45; }
.queued-followup-status, .queued-followup-images { margin-top: 2px; color: var(--muted-strong); font-size: 12px; font-weight: 430; line-height: 1.4; }
.queued-followup-status.is-pending { color: var(--muted-strong); }
.queued-followup-actions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.queued-followup-action { flex: 0 0 auto; min-width: 34px; height: 36px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; padding: 0 7px; border: 0; border-radius: 9px; background: transparent; color: var(--muted-strong); font: inherit; font-size: 13px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.queued-followup-action:hover { background: var(--surface); color: var(--text); }
.queued-followup-action:focus { outline: 0; }
.queued-followup-action:focus-visible { box-shadow: inset 0 0 0 2px rgba(16,163,127,.24); }
.queued-followup-action:disabled { opacity: .65; cursor: default; }
.queued-followup-action svg { flex: 0 0 auto; width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
.composer {
  display: grid;
  position: relative;
  isolation: isolate;
  grid-template-columns: 36px minmax(0, 1fr) 36px;
  align-items: flex-end;
  gap: 4px;
  min-height: 52px;
  padding: 8px;
  border: 0;
  border-radius: var(--composer-radius);
  background: var(--page);
  box-shadow: 0 0 0 1px rgba(0,0,0,.04), 0 2px 8px rgba(0,0,0,.04), 0 4px 80px 8px rgba(0,0,0,.024);
  transition: box-shadow .16s ease;
}
.composer > :not(.composer-beam) { position: relative; z-index: 2; }
${COMPOSER_BEAM_CSS}
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
.send-button { grid-column: 3; background: var(--accent); color: white; transition: background-color .14s ease, color .14s ease, opacity .14s ease, transform .14s ease; }
.send-button:hover:not(:disabled) { transform: translateY(-1px); }
.send-button:active:not(:disabled) { transform: translateY(0) scale(.96); }
.send-button:focus-visible { outline: 2px solid rgba(16,163,127,.38); outline-offset: 2px; }
.send-button svg { width: 18px; height: 18px; }
.send-button .send-arrow-icon { fill: currentColor; stroke: none; }
.send-button .send-running-orb { width: 20px; height: 20px; display: none; pointer-events: none; }
.send-button .send-stop-icon { width: 20px; height: 20px; display: none; fill: currentColor; stroke: none; }
.send-button.is-stop { background: var(--composer-action-ground); color: var(--green); cursor: pointer; }
.send-button.is-stop canvas { grid-area: 1 / 1; }
.send-button.is-stop .send-arrow-icon, .send-button.is-stop .send-stop-icon { display: none; }
.send-button.is-stop .send-running-orb { display: none; }
.send-button.is-stop[data-state="running"] .send-running-orb,
.send-button.is-stop[data-state="pending"] .send-running-orb { display: block; }
.send-button.is-stop[data-state="stopping"] .send-stop-icon { display: block; }
.send-button.is-stop:hover .send-running-orb,
.send-button.is-stop:focus-visible .send-running-orb { display: none; }
.send-button.is-stop:hover .send-stop-icon,
.send-button.is-stop:focus-visible .send-stop-icon { display: block; }
.send-button.is-stop[data-state="pending"]:hover .send-running-orb,
.send-button.is-stop[data-state="pending"]:focus-visible .send-running-orb { display: block; }
.send-button.is-stop[data-state="pending"]:hover .send-stop-icon,
.send-button.is-stop[data-state="pending"]:focus-visible .send-stop-icon { display: none; }
.send-button:disabled { background: #d7d7d7; color: #fff; cursor: default; }
.send-button.is-stop:disabled { background: var(--composer-action-ground); color: var(--green); opacity: .58; }
@media (prefers-reduced-motion: reduce) {
  .send-button { transition: none; }
  .send-button:hover:not(:disabled), .send-button:active:not(:disabled) { transform: none; }
}
`;

export const CHAT_MOBILE_CSS = String.raw`
  .message-row { margin-bottom: 18px; }
  .message-card { font-size: 16px; line-height: 1.5; }
  .message-row.user .message-card { max-width: 88%; padding: 9px 14px; border-radius: 18px; }
  .composer-wrap { padding: 20px 16px max(8px, env(safe-area-inset-bottom)); }
  .composer-queue { max-height: 172px; }
  .queued-followup-main { gap: 6px; padding: 8px 4px; }
  .queued-followup-action { min-width: 32px; width: 32px; padding: 0; }
  .queued-followup-action-label { display: none; }
  .queued-followup-action-label.steer-label { display: none; }
  .queued-followup-action.steer-action { width: 32px; padding: 0; }
  .queued-followup-edit { padding-left: 40px; }
  .composer { min-height: 52px; padding: 8px; border-radius: 28px; }
  .composer textarea { width: 100%; }
`;

export const CHAT_SMALL_CSS = String.raw`
  .composer-wrap { padding-left: 12px; padding-right: 12px; }
`;

export const CHAT_DARK_CSS = String.raw`
  .send-button { color: #212121; }
  .message-content pre, .message-content code { background: #2b2b2b; }
  .message-content pre code { background: transparent; }
  .composer { background: #303030; box-shadow: 0 0 0 1px rgba(255,255,255,.06), 0 2px 12px rgba(0,0,0,.22); }
  .composer-wrap { background: linear-gradient(to bottom, rgba(33,33,33,0), rgba(33,33,33,.94) 32%, #212121 62%); }
  .composer-image-button:hover { background: #3a3a3a; }
  .message-content a { color: #7ab7ff; }
`;

export const CHAT_PENDING_CSS = String.raw`
.response-pending { width: min(100%, var(--thread-max)); display: inline-flex; align-items: baseline; gap: 3px; margin: -8px auto 20px; padding-left: 2px; color: var(--muted); font-size: 13px; font-weight: 520; }
.agent-planning-copy { background: linear-gradient(100deg, var(--muted) 20%, var(--text) 48%, var(--muted) 76%); background-size: 220% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: solving-shimmer 1.55s ease-in-out infinite; }
.agent-planning-dots { display: inline-flex; width: 18px; }
.agent-planning-dots span { display: inline-block; animation: solving-dot 1.15s ease-in-out infinite; }
.agent-planning-dots span:nth-child(2) { animation-delay: .14s; }
.agent-planning-dots span:nth-child(3) { animation-delay: .28s; }
@media (prefers-reduced-motion: reduce) { .agent-planning-copy, .solving-dots span, .agent-planning-dots span { animation: none; color: var(--muted); background: none; opacity: 1; transform: none; } }
`;

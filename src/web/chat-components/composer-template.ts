/** Default IDs keep the taskboard integration stable; use a prefix for multiple instances. */
const template = `      <form class="composer-wrap" id="composer-form" data-chat-part="composer-form">
        <div class="composer-notice" id="composer-notice" data-chat-part="composer-notice" hidden>
          <span class="composer-notice-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 9V5m8 4V5M6 9h12v3a6 6 0 0 1-12 0V9Zm6 9v3"/></svg></span>
          <span class="composer-notice-text" id="composer-notice-text" data-chat-part="composer-notice-text" role="status" aria-live="polite"></span>
          <button class="composer-notice-retry" id="composer-notice-retry" data-chat-part="composer-notice-retry" type="button">重试</button>
        </div>
        <div class="composer-queue" id="composer-queue" data-chat-part="composer-queue" aria-live="polite" hidden></div>
        <input id="composer-image-input" data-chat-part="composer-image-input" type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" multiple>
        <div class="composer">
          <div class="composer-beam" data-beam="composer" aria-hidden="true"><span data-beam-bloom></span></div>
          <div class="composer-media" id="composer-media" data-chat-part="composer-media" hidden></div>
          <textarea id="composer-input" data-chat-part="composer-input" rows="1" maxlength="20000" placeholder="有问题，尽管问"></textarea>
          <button class="composer-image-button" id="composer-image-button" data-chat-part="composer-image-button" type="button" aria-label="添加图片">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <div class="composer-settings-controls" id="composer-settings-controls" data-chat-part="composer-settings-controls" hidden>
            <div class="composer-model-control" id="composer-model-control" data-chat-part="composer-model-control" hidden>
              <button class="composer-model-button" id="composer-model-button" data-chat-part="composer-model-button" type="button" aria-haspopup="menu" aria-expanded="false">
                <span id="composer-model-label" data-chat-part="composer-model-label">模型</span>
                <svg class="composer-model-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6"/></svg>
              </button>
              <div class="composer-model-menu" id="composer-model-menu" data-chat-part="composer-model-menu" role="menu" hidden></div>
            </div>
            <div class="composer-model-control" id="composer-session-control" data-chat-part="composer-session-control" hidden>
              <button class="composer-model-button" id="composer-session-button" data-chat-part="composer-session-button" type="button" aria-haspopup="menu" aria-expanded="false">
                <span id="composer-session-label" data-chat-part="composer-session-label">推理 · 权限</span>
                <svg class="composer-model-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6"/></svg>
              </button>
              <div class="composer-model-menu composer-session-menu" id="composer-session-menu" data-chat-part="composer-session-menu" role="menu" hidden></div>
            </div>
          </div>
          <button class="send-button" id="send-button" data-chat-part="send-button" type="submit" aria-label="发送">
            <svg class="send-arrow-icon" viewBox="0 0 32 32" aria-hidden="true">
              <rect x="16.1284" y="9" width="2.01621" height="10.081" rx="1.0081" transform="rotate(45 16.1284 9)"/>
              <rect x="23.2568" y="16.1289" width="2.01621" height="10.081" rx="1.0081" transform="rotate(135 23.2568 16.1289)"/>
              <rect x="17.0573" y="22" width="2" height="12" rx="1" transform="rotate(-180 17.0573 22)"/>
            </svg>
            <canvas class="send-running-orb" id="send-running-orb" data-chat-part="send-running-orb" width="20" height="20" aria-hidden="true"></canvas>
            <svg class="send-stop-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.2"/></svg>
          </button>
        </div>
      </form>
`;

export function renderChatComposerHtml(prefix = ""): string {
  if (prefix && !/^[a-z][a-z0-9_-]*$/i.test(prefix)) throw new Error("Invalid chat composer prefix");
  return prefix ? template.replace(/id="([^"]+)"/g, (_, id) => `id="${prefix}-${id}"`) : template;
}

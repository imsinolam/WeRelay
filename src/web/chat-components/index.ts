import { CHAT_TEXT_JS } from "./text.ts";
import { MESSAGE_BUBBLE_JS } from "./message-bubble.ts";
import { CHAT_COMPOSER_JS } from "./composer.ts";
import { SOLVING_ORB_JS } from "./solving-orb.ts";
import {
  MESSAGE_BUBBLE_CSS, MESSAGE_MEDIA_CSS, CHAT_PROGRESS_CSS, CHAT_PENDING_CSS, CHAT_TEXT_CSS,
  CHAT_COMPOSER_CSS, CHAT_MOBILE_CSS, CHAT_SMALL_CSS, CHAT_DARK_CSS,
} from "./styles.ts";

export { renderChatComposerHtml } from "./composer-template.ts";

/** One dependency-free browser bundle, also embedded in the taskboard's app.js. */
export const CHAT_COMPONENTS_JS = String.raw`
var WeRelayChatUI = (function () {
  "use strict";
${SOLVING_ORB_JS}
${CHAT_TEXT_JS}
${MESSAGE_BUBBLE_JS}
${CHAT_COMPOSER_JS}
  return Object.freeze({
    createText: createChatText,
    createMessageBubble: createMessageBubble,
    createComposer: createChatComposer,
    solvingOrb: Object.freeze({ preset: BOOT_ORB_PRESET, frame: bootOrbFrame, options: bootOrbOptions, isDark: bootOrbIsDark })
  });
})();
`;

/** Standalone defaults; the taskboard supplies its own theme tokens. */
export const CHAT_COMPONENTS_CSS = String.raw`
.werelay-chat {
  --page: #fff; --surface: #f4f4f4; --text: #202020; --muted: #777;
  --muted-strong: #666; --border: rgba(0,0,0,.08); --border-strong: rgba(0,0,0,.16);
  --accent: #202020; --green: #10a37f; --red: #c43737;
  --thread-max: 768px; --composer-action-ground: #202020;
  --shadow: 0 12px 40px rgba(0,0,0,.12);
  color: var(--text); font: 15px/1.6 system-ui, sans-serif;
}
.werelay-chat *, .werelay-chat *::before, .werelay-chat *::after { box-sizing: border-box; }
.werelay-chat [hidden] { display: none !important; }
:where(.werelay-chat) button, :where(.werelay-chat) textarea { font: inherit; }
:where(.werelay-chat) svg { display: block; fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
${MESSAGE_BUBBLE_CSS}
${MESSAGE_MEDIA_CSS}
${CHAT_TEXT_CSS}
${CHAT_PROGRESS_CSS}
${CHAT_PENDING_CSS}
${CHAT_COMPOSER_CSS}
.werelay-chat .composer-wrap { position: relative; }
@keyframes solving-shimmer { 0% { background-position: 120% 0; } 100% { background-position: -120% 0; } }
@keyframes solving-dot { 0%, 60%, 100% { opacity: .2; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-1px); } }
@keyframes run-pulse { 0%, 100% { opacity: .35; transform: scale(.85); } 50% { opacity: 1; transform: scale(1); } }
@media (max-width: 760px) { ${CHAT_MOBILE_CSS} }
@media (max-width: 360px) { ${CHAT_SMALL_CSS} }
@media (prefers-color-scheme: dark) {
  .werelay-chat { --page: #212121; --surface: #2f2f2f; --text: #ececec;
    --muted: #a3a3a3; --muted-strong: #b4b4b4; --accent: #ececec;
    --border: rgba(255,255,255,.08); --border-strong: rgba(255,255,255,.14);
    --composer-action-ground: #303030; }
${CHAT_DARK_CSS}
}
@media (prefers-reduced-motion: reduce) { .run-progress-dot { animation: none !important; } }
`;

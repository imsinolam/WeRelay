import crypto from "node:crypto";
import { CODEX_MOBILE_HTML, CODEX_MOBILE_CSS, CODEX_MOBILE_JS, WE_RELAY_ABOUT_HTML } from "./codex-mobile-web.ts";
import { SESSION_ORGANIZER_HTML, SESSION_ORGANIZER_CSS, SESSION_ORGANIZER_JS } from "./session-organizer-web.ts";

// Include HTML too: a markup-only update must invalidate both browser and App resources.
export const CODEX_MOBILE_ASSET_VERSION = crypto.createHash("sha256")
  .update([CODEX_MOBILE_HTML, CODEX_MOBILE_CSS, CODEX_MOBILE_JS, WE_RELAY_ABOUT_HTML,
    SESSION_ORGANIZER_HTML, SESSION_ORGANIZER_CSS, SESSION_ORGANIZER_JS].join("\0"))
  .digest("hex").slice(0, 12);

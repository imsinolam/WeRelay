import { CODEX_MOBILE_ASSET_VERSION } from "./mobile-asset-version.ts";
import { CODEX_MOBILE_HTML, CODEX_MOBILE_CSS, CODEX_MOBILE_JS, WE_RELAY_ABOUT_HTML } from "./codex-mobile-web.ts";
import { SESSION_ORGANIZER_HTML, SESSION_ORGANIZER_CSS, SESSION_ORGANIZER_JS } from "./session-organizer-web.ts";

/** The Android shell consumes these generated assets. No fork of the taskboard. */
export function createMobileAppAssets(): { version: string; files: Record<string, string> } {
  const version = CODEX_MOBILE_ASSET_VERSION;
  const replaceVersion = (text: string): string => text.replaceAll("__WE_RELAY_ASSET_VERSION__", version);
  const localPage = (text: string): string => replaceVersion(text).replace(
    "</head>",
    '<script src="/native-platform.js"></script>\n</head>',
  );
  return {
    version,
    files: {
      "index.html": localPage(CODEX_MOBILE_HTML),
      "app.css": CODEX_MOBILE_CSS,
      "app.js": replaceVersion(CODEX_MOBILE_JS),
      "about/index.html": localPage(WE_RELAY_ABOUT_HTML),
      "organizer/index.html": localPage(SESSION_ORGANIZER_HTML),
      "organizer.css": SESSION_ORGANIZER_CSS,
      "organizer.js": replaceVersion(SESSION_ORGANIZER_JS),
    },
  };
}

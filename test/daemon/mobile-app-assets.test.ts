import { expect, test } from "bun:test";
import { createMobileAppAssets } from "../../src/daemon/mobile-app-assets.ts";
import { CODEX_MOBILE_CSS, CODEX_MOBILE_JS } from "../../src/daemon/codex-mobile-web.ts";

test("App assets are produced from the same taskboard, not a second UI", () => {
  const bundle = createMobileAppAssets();
  expect(bundle.files["app.css"]).toBe(CODEX_MOBILE_CSS);
  expect(bundle.files["app.js"]).toBe(CODEX_MOBILE_JS.replaceAll("__WE_RELAY_ASSET_VERSION__", bundle.version));
  expect(bundle.files["index.html"]).toContain("/native-platform.js");
  expect(bundle.files["index.html"].indexOf("/native-platform.js")).toBeLessThan(bundle.files["index.html"].indexOf("src=\"/app.js"));
  expect(bundle.files["organizer/index.html"]).toContain("/native-platform.js");
  expect(bundle.files["about/index.html"]).toContain("WeRelay");
  expect(bundle.files["index.html"]).not.toContain("__WE_RELAY_ASSET_VERSION__");
  expect(bundle.version).toMatch(/^[a-f0-9]{12}$/);
});

test("native update handling precedes browser navigation", () => {
  expect(CODEX_MOBILE_JS).toContain("window.WeRelayPlatform.checkForUpdate");
  expect(CODEX_MOBILE_JS).toContain('"werelay:open-task"');
  expect(CODEX_MOBILE_JS).toContain("window.WeRelayPlatform.ready");
});

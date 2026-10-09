import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexMobileAuthStore } from "../../src/daemon/codex-mobile-auth.ts";
import { startCodexMobileServer } from "../../src/daemon/codex-mobile-server.ts";
import { MobileRemoteAccess } from "../../src/daemon/mobile-remote-access.ts";

const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

test("remote settings require login, localhost Host and same Origin; relay viewers cannot edit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-api-"));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const auth = new CodexMobileAuthStore({ stateFile: path.join(dir, "auth.json") });
  auth.setPassword("test-password-only");
  let checks = 0; let applies = 0;
  const access = new MobileRemoteAccess({ stateFile: path.join(dir, "remote.json"), check: async () => { checks++; }, apply: async (config) => {
    applies++;
    server.updateRemoteAccess(config?.relayUrl);
  } });
  const server = await startCodexMobileServer({
    host: "127.0.0.1", port: 0, authStore: auth, accessToken: "test-mobile-secret",
    listTasks: async () => [], readMessages: async (threadId) => ({ threadId, messages: [], queuedMessages: [], runSummary: null }), sendMessage: async () => ({ queued: false }),
    readRemoteAccess: () => access.view(), changeRemoteAccess: (input, check) => access.change(input, check),
  });
  closers.push(() => server.close());
  const root = `http://127.0.0.1:${server.port}`;
  const cookie = `codex_mobile_session=${auth.createSessionToken()}`;
  const body = JSON.stringify({ enabled: true, serverUrl: "https://relay.example.com", deviceToken: "test-pairing-secret", deviceId: "default" });
  expect((await fetch(root + "/api/settings/remote")).status).toBe(401);
  const get = await fetch(root + "/api/settings/remote", { headers: { cookie } });
  expect(await get.json()).toMatchObject({ enabled: false, canEdit: true });
  for (const extra of [{}, { origin: "https://evil.example.com" }, { origin: root, "x-werelay-relay": "1" }, { origin: root, "x-forwarded-for": "203.0.113.1" }, { origin: root, "sec-fetch-site": "cross-site" }, { origin: root, host: "evil.example.com" }]) {
    const response = await fetch(root + "/api/settings/remote", { method: "POST", headers: { cookie, "content-type": "application/json", ...extra }, body });
    expect(response.status).toBe(403);
  }
  const remoteView = await fetch(root + "/api/settings/remote", { headers: { cookie, "x-werelay-relay": "1", "x-forwarded-proto": "https" } });
  expect(await remoteView.json()).toMatchObject({ canEdit: false });
  const preference = await fetch(root + "/api/settings/remote", { method: "POST", headers: { cookie, origin: root, "content-type": "application/json" }, body: JSON.stringify({ showLocalLink: true }) });
  expect(await preference.json()).toMatchObject({ enabled: false, configured: false, showLocalLink: true, localUrl: `http://localhost:${server.port}` });
  expect(applies).toBe(0); expect(checks).toBe(0);
  const post = (suffix: string, payload = body) => fetch(root + "/api/settings/remote" + suffix, { method: "POST", headers: { cookie, origin: root, "content-type": "application/json" }, body: payload });
  const check = await post("/check");
  expect(await check.json()).toMatchObject({ checked: true, enabled: false });
  expect(checks).toBe(1); expect(applies).toBe(0);
  const saved = await post("");
  expect(saved.status).toBe(200);
  expect(await saved.text()).not.toContain("test-pairing-secret");
  expect(applies).toBe(1);
  expect((await fetch(root + "/api/network-route", { headers: { cookie } }).then((r) => r.json())).publicUrl).toBe("https://relay.example.com");
  expect(new URL(server.buildTaskUrl("test-thread", "codex")).origin).toBe("https://relay.example.com");
  expect((await post("", JSON.stringify({ enabled: false }))).status).toBe(200);
  expect((await fetch(root + "/api/network-route", { headers: { cookie } }).then((r) => r.json())).publicUrl).toBeNull();
  expect(new URL(server.buildTaskUrl("test-thread", "codex")).hostname).toBe(server.lanAddress);
  expect((await post("", JSON.stringify({ enabled: true, deviceToken: "x".repeat(9000) }))).status).toBe(413);
});

test("settings provide discoverable sections and keep entered keys out of persistence", async () => {
  const { CODEX_MOBILE_HTML: html, CODEX_MOBILE_JS: js, CODEX_MOBILE_CSS: css } = await import("../../src/daemon/codex-mobile-web.ts");
  expect(html).toContain('id="settings-open"');
  expect(html).toContain('id="local-address-entry"');
  for (const tab of ["remote", "tasks", "providers"]) expect(html).toContain(`data-settings-tab="${tab}"`);
  expect(js).toContain('if (tab === "remote") void loadRemoteAccess(epoch);');
  expect(js).toContain('if (!state.settingsOpen || epoch !== settingsEpoch || tab !== settingsTab) return;');
  const remote = js.slice(js.indexOf("  function renderRemoteAccess"), js.indexOf("  function settingsCapabilitySummary"));
  expect(remote).not.toContain("localStorage");
  expect(remote).not.toContain("sessionStorage");
  expect(remote).toContain('tokenInput.value = "";');
  expect(remote).toContain("if (!view.canEdit)");
  expect(remote).toContain("refresh(next)");
  expect(css).toContain(".remote-form[hidden] { display: none; }");
  expect(() => new Function(js)).not.toThrow();
});

test("provider cards are collapsible and retain expansion and scroll on refresh", async () => {
  const { CODEX_MOBILE_JS: js, CODEX_MOBILE_CSS: css } = await import("../../src/daemon/codex-mobile-web.ts");
  const render = js.slice(js.indexOf("  function renderSettings("), js.indexOf("  async function loadTasks("));
  expect(render).toContain('document.createElement("details")');
  expect(render).toContain('document.createElement("summary")');
  expect(render).toContain("block.open = Boolean(settingsExpandedProviders[provider.id])");
  expect(render).toContain('iconImage.src = AGENT_BRAND_ICON_DATA[provider.id]');
  expect(render).toContain('block.classList.toggle("is-above"');
  expect(render).toContain("settingsBody.scrollTop = scrollTop");
  expect(css).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  expect(css).not.toContain(".settings-provider-grid .settings-provider[open] { grid-column: 1 / -1");
  expect(css).toContain(".settings-provider-grid .settings-provider-detail { position: absolute;");
});

test("provider marks are bundled for every supported agent and shell", async () => {
  const { AGENT_BRAND_ICON_DATA } = await import("../../src/daemon/agent-brand-icons.ts");
  for (const id of ["codex", "claude", "tclaude", "grok", "deepseek", "codebuddy", "workbuddy", "opencode", "reasonix", "shell"]) {
    expect(AGENT_BRAND_ICON_DATA[id]).toMatch(/^data:image\/(?:svg\+xml,|png;base64,)/);
    expect(AGENT_BRAND_ICON_DATA[id]).not.toContain("http://");
    expect(AGENT_BRAND_ICON_DATA[id]).not.toContain("https://");
  }
});

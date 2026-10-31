import { expect, test } from "bun:test";
import { CODEX_MOBILE_APP_JS } from "../../src/daemon/codex-mobile-web.ts";
import { composerHarness } from "./helpers/chat-components.ts";

function controller() {
  const start = CODEX_MOBILE_APP_JS.indexOf("  function isAdapterConnectionUnavailableMessage(");
  const end = CODEX_MOBILE_APP_JS.indexOf("  function setCacheSyncState(", start);
  if (start < 0 || end < 0) throw new Error("missing connection notice controller");
  const state: any = { currentAdapter: "codex", currentThreadId: "original", authenticated: true,
    adapterConnectionNotice: null, adapterReconnectInFlight: false, adapterError: "", toastTimer: null };
  const views: any[] = [];
  const calls: string[] = [];
  let fail = false;
  let release: () => void = () => {};
  const api = async () => {
    calls.push("connect");
    await new Promise<void>(resolve => { release = resolve; });
    if (fail) throw new Error("Codex 尚未连接。");
  };
  const result = new Function("state", "composerView", "api", "loadAdapters", "loadTasks", "loadMessages",
    "loadCurrentTaskModel", "loadCurrentTaskPermission", "currentAdapterName", "isMobileConnectionUnavailableMessage",
    "setCacheSyncState", "toastEl", "updateHeader", CODEX_MOBILE_APP_JS.slice(start, end) + `
    return { reportAdapterConnectionError, clearAdapterConnectionNotice, retryAdapterConnection, showToast, renderAdapterConnectionNotice };
  `)(state, { renderNotice: (view: any) => views.push(view) }, api,
    async () => {}, async () => {}, async () => { calls.push("messages"); },
    async () => {}, async () => {}, () => "Codex", () => false, () => {},
    { classList: { add: () => calls.push("toast"), remove: () => {} } }, () => {});
  return { state, views, calls, ...result, release: () => release(), fail: () => { fail = true; } };
}

test("connection notice stays mounted, supports retry and keeps composer content", () => {
  let retries = 0;
  const h = composerHarness({ onNoticeRetry: () => retries++ });
  h.view.setValue("保留的草稿");
  h.view.renderNotice({ visible: true, text: "Codex 尚未连接", retrying: false });
  const notice = h.part("composer-notice");
  const retry = h.part("composer-notice-retry");
  expect(notice.hidden).toBe(false);
  retry.emit("click");
  expect(retries).toBe(1);
  h.view.renderNotice({ visible: true, text: "正在重新连接 Codex…", retrying: true });
  expect(retry.disabled).toBe(true);
  expect(notice.hidden).toBe(false);
  retry.emit("click");
  expect(retries).toBe(1);
  expect(h.view.getValue()).toBe("保留的草稿");
  h.view.renderNotice({ visible: false });
  expect(notice.hidden).toBe(true);
  h.view.destroy();
  retry.emit("click");
  expect(retries).toBe(1);
});

test("repeated terminal errors use one persistent notice instead of timed toasts", () => {
  const h = controller();
  h.showToast("Codex 尚未连接。");
  h.showToast("Codex 尚未连接。");
  expect(h.state.adapterConnectionNotice.message).toBe("Codex 尚未连接。");
  expect(h.state.toastTimer).toBeNull();
  expect(h.calls).not.toContain("toast");
  h.clearAdapterConnectionNotice("claude");
  expect(h.state.adapterConnectionNotice).not.toBeNull();
  h.clearAdapterConnectionNotice("codex");
  expect(h.state.adapterConnectionNotice).toBeNull();
});

test("Pi Desktop's one-time connection instructions stay readable instead of disappearing in a toast", () => {
  const h = controller();
  h.state.currentAdapter = "pi-desktop";
  const message = "Pi Desktop 尚未接入，连接插件已准备好。请在插件管理中安装并授权后重试。";
  h.showToast(message);
  expect(h.state.adapterConnectionNotice).toMatchObject({ adapter: "pi-desktop", message });
  expect(h.state.toastTimer).toBeNull();
  expect(h.calls).not.toContain("toast");
});

test("retry is single flight, preserves task identity and only clears on successful connection", async () => {
  const h = controller();
  h.reportAdapterConnectionError("Codex 尚未连接。", "codex");
  const first = h.retryAdapterConnection();
  await h.retryAdapterConnection();
  expect(h.calls).toEqual(["connect"]);
  expect(h.state.adapterConnectionNotice.retrying).toBe(true);
  expect(h.state.currentThreadId).toBe("original");
  h.release();
  await first;
  expect(h.calls).toContain("messages");
  expect(h.state.adapterConnectionNotice).toBeNull();
  expect(h.state.currentThreadId).toBe("original");
});

test("failed retry stays actionable and late errors from a different agent are ignored", async () => {
  const h = controller();
  h.reportAdapterConnectionError("Claude 尚未连接。", "claude");
  expect(h.state.adapterConnectionNotice).toBeNull();
  h.reportAdapterConnectionError("Codex 尚未连接。", "codex");
  h.fail();
  const retry = h.retryAdapterConnection();
  h.release();
  await retry;
  expect(h.state.adapterConnectionNotice.retrying).toBe(false);
  expect(h.state.adapterReconnectInFlight).toBe(false);
  expect(h.calls).not.toContain("toast");
});

test("API records connection failures without letting cached lists or history clear the warning", async () => {
  const start = CODEX_MOBILE_APP_JS.indexOf("  async function api(");
  const end = CODEX_MOBILE_APP_JS.indexOf("  function adapterApiPath(", start);
  const state: any = { currentAdapter: "codex", adapterConnectionNotice: { adapter: "codex" } };
  const cleared: string[] = [];
  const reported: string[] = [];
  let fetcher = async () => ({});
  let warm = false;
  const api = new Function("state", "window", "fetchJson", "clearAdapterConnectionNotice", "reportAdapterConnectionError", "showAuthentication",
    CODEX_MOBILE_APP_JS.slice(start, end) + ";return api;")(state, { location: { origin: "https://example.invalid" } },
    async (_path: string, options: any) => {
      const result = await fetcher();
      options.onResponse({ headers: { get: () => warm ? "warm" : null } });
      return result;
    }, (adapter: string) => cleared.push(adapter), (text: string) => reported.push(text), () => {});
  await api("/api/tasks?adapter=codex");
  await api("/api/tasks/original/messages?adapter=codex&history=1");
  await api("/api/tasks/original/model?adapter=codex");
  await api("/api/tasks/original/permission?adapter=codex");
  expect(cleared).toEqual([]);
  warm = true;
  await api("/api/tasks/original/messages?adapter=codex");
  expect(cleared).toEqual([]);
  warm = false;
  await api("/api/tasks/original/messages?adapter=codex");
  expect(cleared).toEqual(["codex"]);
  state.adapterConnectionNotice.retrying = true;
  await api("/api/tasks/original/messages?adapter=codex");
  expect(cleared).toEqual(["codex"]);
  fetcher = async () => { throw new Error("Codex 尚未连接。"); };
  await expect(api("/api/tasks/original/messages?adapter=codex")).rejects.toThrow("Codex 尚未连接。");
  expect(reported).toEqual(["Codex 尚未连接。"]);
});

test("a success that started before a new failure cannot dismiss the new warning", async () => {
  const start = CODEX_MOBILE_APP_JS.indexOf("  async function api(");
  const end = CODEX_MOBILE_APP_JS.indexOf("  function adapterApiPath(", start);
  const state: any = { currentAdapter: "codex", adapterConnectionNotice: null };
  let resolve: (value: object) => void = () => {};
  let cleared = false;
  const api = new Function("state", "window", "fetchJson", "clearAdapterConnectionNotice", "reportAdapterConnectionError", "showAuthentication",
    CODEX_MOBILE_APP_JS.slice(start, end) + ";return api;")(state, { location: { origin: "https://example.invalid" } },
    () => new Promise<object>(done => { resolve = done; }), () => { cleared = true; }, () => {}, () => {});
  const request = api("/api/tasks/original/messages?adapter=codex");
  state.adapterConnectionNotice = { adapter: "codex", message: "Codex 尚未连接。" };
  resolve({});
  await request;
  expect(cleared).toBe(false);
});

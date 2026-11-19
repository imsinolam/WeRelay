import { expect, test } from "bun:test";
import { CODEX_MOBILE_APP_JS } from "../../src/daemon/codex-mobile-web.ts";

function harness(adapterStatus = "idle") {
  const state = {
    currentAdapter: "codex", currentThreadId: "original-task", adapterError: "",
    switchingAdapter: false, switchingAdapterId: "", switchingFromAdapterId: "", creatingTask: false,
  };
  const renders: Array<{ active: string; switching: boolean; target: string }> = [];
  const restores: string[][] = [];
  const urls: string[] = [];
  const taskRefreshes: boolean[] = [];
  const composer = { value: "alpha omega", selectionStart: 9, selectionEnd: 9 };
  let savedDraft = "";
  function writeComposer(value: string) {
    if (composer.value === value) return;
    composer.value = value;
    composer.selectionStart = composer.selectionEnd = value.length;
  }
  let succeed!: (value: { activeAdapter: string }) => void;
  let fail!: (error: Error) => void;
  const request = new Promise<{ activeAdapter: string }>((resolve, reject) => { succeed = resolve; fail = reject; });
  const start = CODEX_MOBILE_APP_JS.indexOf("  async function switchAdapter(");
  const end = CODEX_MOBILE_APP_JS.indexOf("  function showAuthentication(", start);
  const names = ["state", "currentAdapterEntry", "isAdapterCapabilityError", "saveCurrentConversationSnapshot", "rememberCurrentTaskSnapshot", "resetTaskStateForAdapterSwitch", "restoreCachedAdapterState", "syncLiveSubscriptions", "window", "history", "renderAdapterMenu", "renderTasks", "renderMessages", "updateHeader", "api", "loadAdapters", "loadTasks", "showToast", "currentAdapterName", "clearAdapterConnectionNotice"];
  const noop = () => {};
  const switchAdapter = new Function(...names, `${CODEX_MOBILE_APP_JS.slice(start, end)}; return switchAdapter;`)(
    state, () => ({ status: adapterStatus }), () => false, () => { savedDraft = composer.value; }, noop,
    () => { state.currentThreadId = ""; state.adapterError = ""; writeComposer(""); },
    (adapter: string, task: string) => {
      restores.push([adapter, task]);
      state.currentThreadId = task || `${adapter}-cached-task`;
      writeComposer(adapter === "codex" ? savedDraft : "");
    },
    noop, { location: { href: "http://localhost/?adapter=codex&task=original-task" } },
    { replaceState: (_a: unknown, _b: unknown, url: string) => urls.push(url) },
    () => renders.push({ active: state.switchingFromAdapterId || state.currentAdapter, switching: state.switchingAdapter, target: state.currentAdapter }),
    noop, noop, noop, () => request, async () => {}, async (initial: boolean) => { taskRefreshes.push(initial); }, noop, () => state.currentAdapter, noop,
  ) as (adapter: string, initial?: boolean) => Promise<boolean>;
  return { state, renders, restores, urls, taskRefreshes, composer, succeed, fail, switchAdapter };
}

test("cached target content does not move the selection until server confirmation", async () => {
  const h = harness();
  const result = h.switchAdapter("pi");
  expect(h.renders[0]).toEqual({ active: "codex", switching: true, target: "pi" });
  h.succeed({ activeAdapter: "pi" });
  expect(await result).toBe(true);
  expect(h.renders.at(-1)).toEqual({ active: "pi", switching: false, target: "pi" });
  expect(h.state.switchingFromAdapterId).toBe("");
  expect(h.urls.at(-1)).toBe("/?adapter=pi");
  expect(h.taskRefreshes).toEqual([true]);
});

test("a failed switch restores the original cached task and deep link", async () => {
  const h = harness();
  const result = h.switchAdapter("pi");
  h.fail(new Error("fixture connection failed"));
  expect(await result).toBe(false);
  expect(h.state.currentAdapter).toBe("codex");
  expect(h.state.currentThreadId).toBe("original-task");
  expect(h.restores.at(-1)).toEqual(["codex", "original-task"]);
  expect(h.urls.at(-1)).toBe("/?adapter=codex&task=original-task");
  expect(h.renders.at(-1)).toEqual({ active: "codex", switching: false, target: "codex" });
});

test.each([true, false])("connecting the displayed terminal leaves the draft and caret untouched (initial=%s)", async (initial) => {
  const fixture = harness("open");
  const connection = fixture.switchAdapter("codex", initial);
  fixture.succeed({ activeAdapter: "codex" });
  expect(await connection).toBe(true);
  expect(fixture.composer).toEqual({ value: "alpha omega", selectionStart: 9, selectionEnd: 9 });
  expect(fixture.state.currentThreadId).toBe("original-task");
  expect(fixture.restores).toEqual([]);
  expect(fixture.urls.at(-1)).toBe("/?adapter=codex&task=original-task");
  expect(fixture.taskRefreshes).toEqual(initial ? [] : [false]);
});

test("a failed reconnect leaves the current draft and selected text untouched", async () => {
  const fixture = harness("error");
  fixture.state.adapterError = "尚未连接";
  fixture.composer.selectionStart = 6;
  const connection = fixture.switchAdapter("codex");
  fixture.fail(new Error("仍未连接"));
  expect(await connection).toBe(false);
  expect(fixture.composer).toEqual({ value: "alpha omega", selectionStart: 6, selectionEnd: 9 });
  expect(fixture.state.currentThreadId).toBe("original-task");
  expect(fixture.state.adapterError).toBe("仍未连接");
  expect(fixture.restores).toEqual([]);
});

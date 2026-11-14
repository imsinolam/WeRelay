import { expect, test } from "bun:test";
import { CODEX_MOBILE_APP_JS } from "../../src/daemon/codex-mobile-web.ts";

function harness() {
  const state = {
    currentAdapter: "codex", currentThreadId: "original-task", adapterError: "",
    switchingAdapter: false, switchingAdapterId: "", switchingFromAdapterId: "", creatingTask: false,
  };
  const renders: Array<{ active: string; switching: boolean; target: string }> = [];
  const restores: string[][] = [];
  const urls: string[] = [];
  let succeed!: (value: { activeAdapter: string }) => void;
  let fail!: (error: Error) => void;
  const request = new Promise<{ activeAdapter: string }>((resolve, reject) => { succeed = resolve; fail = reject; });
  const start = CODEX_MOBILE_APP_JS.indexOf("  async function switchAdapter(");
  const end = CODEX_MOBILE_APP_JS.indexOf("  function showAuthentication(", start);
  const names = ["state", "currentAdapterEntry", "isAdapterCapabilityError", "saveCurrentConversationSnapshot", "rememberCurrentTaskSnapshot", "resetTaskStateForAdapterSwitch", "restoreCachedAdapterState", "syncLiveSubscriptions", "window", "history", "renderAdapterMenu", "renderTasks", "renderMessages", "updateHeader", "api", "loadAdapters", "loadTasks", "showToast", "currentAdapterName"];
  const noop = () => {};
  const switchAdapter = new Function(...names, `${CODEX_MOBILE_APP_JS.slice(start, end)}; return switchAdapter;`)(
    state, () => ({ status: "idle" }), () => false, noop, noop,
    () => { state.currentThreadId = ""; state.adapterError = ""; },
    (adapter: string, task: string) => { restores.push([adapter, task]); state.currentThreadId = task; },
    noop, { location: { href: "http://localhost/?adapter=codex&task=original-task" } },
    { replaceState: (_a: unknown, _b: unknown, url: string) => urls.push(url) },
    () => renders.push({ active: state.switchingFromAdapterId || state.currentAdapter, switching: state.switchingAdapter, target: state.currentAdapter }),
    noop, noop, noop, () => request, async () => {}, async () => {}, noop, () => state.currentAdapter,
  ) as (adapter: string) => Promise<boolean>;
  return { state, renders, restores, urls, succeed, fail, switchAdapter };
}

test("cached target content does not move the selection until server confirmation", async () => {
  const h = harness();
  const result = h.switchAdapter("pi");
  expect(h.renders[0]).toEqual({ active: "codex", switching: true, target: "pi" });
  h.succeed({ activeAdapter: "pi" });
  expect(await result).toBe(true);
  expect(h.renders.at(-1)).toEqual({ active: "pi", switching: false, target: "pi" });
  expect(h.state.switchingFromAdapterId).toBe("");
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

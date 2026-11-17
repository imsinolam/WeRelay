import { expect, test } from "bun:test";
import vm from "node:vm";
import { messageJournalAsset } from "../../src/message-journal/assets.ts";

function setup(fetchImpl: (url: URL, options: any) => Promise<any>) {
  const inputs = [{value:"pi", checked:true, disabled:false}];
  const listeners = new Map<string, (event: any) => Promise<void>>();
  const nodes = new Map<string, any>();
  const timers: Array<() => void> = [];
  let observeError: (() => void) | undefined;
  for (const id of ["source-settings", "source-status", "journal-back", "sources-open", "sources-dismiss", "sources-save", "reload", "summary", "canvas-empty", "journal-filters", "journal-filter-toggle", "agent", "project", "reset", "error", "sources-toggle"]) {
    nodes.set(id, {hidden:true, disabled:false, textContent:"", value:"", dataset:{}, attributes:{}, click() {}, querySelectorAll:() => inputs,
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      addEventListener:(name: string, fn: any) => listeners.set(id+":"+name, fn)});
  }
  const window: any = {};
  vm.runInNewContext(messageJournalAsset("/journal/host.js")!.body, {
    window, document:{getElementById:(id: string)=>nodes.get(id), addEventListener() {}},
    location:{href:"https://example.test/journal/", origin:"https://example.test"},
    URL, AbortSignal, fetch:fetchImpl, setInterval() {}, setTimeout(fn: () => void) { timers.push(fn); },
    MutationObserver:class { constructor(fn: () => void) { observeError = fn; } observe() {} },
  });
  return {window, inputs, nodes, emit:(id: string, event: string) => listeners.get(id+":"+event)!({}),
    flushTimers:() => { for (const fn of timers.splice(0)) fn(); }, observeError:() => observeError!(),
    submit:() => listeners.get("source-settings:submit")!({preventDefault() {}})};
}
const json = (data: unknown) => ({ok:true, json:async()=>data});

test("collapsed mobile filters expose their state and selected condition count", () => {
  const host = setup(async () => json({}));
  host.emit("journal-filter-toggle", "click");
  expect(host.nodes.get("journal-filters").dataset.open).toBe("true");
  expect(host.nodes.get("journal-filter-toggle").attributes["aria-expanded"]).toBe("true");
  host.nodes.get("agent").value = "pi";
  host.nodes.get("project").value = "example";
  host.emit("agent", "change");
  host.flushTimers();
  expect(host.nodes.get("journal-filter-toggle").textContent).toBe("筛选 · 2");
  host.emit("journal-filter-toggle", "click");
  expect(host.nodes.get("journal-filters").dataset.open).toBe("false");
  expect(host.nodes.get("journal-filter-toggle").dataset.active).toBe("true");
  host.nodes.get("agent").value = host.nodes.get("project").value = "";
  host.emit("reset", "click");
  host.flushTimers();
  expect(host.nodes.get("journal-filter-toggle").textContent).toBe("筛选");
  expect(host.nodes.get("journal-filter-toggle").dataset.active).toBe("false");
});

test("partial log warnings move to data details while connection errors remain visible", () => {
  const host = setup(async () => json({}));
  const error = host.nodes.get("error");
  error.hidden = false;
  error.textContent = "部分日志被跳过，见右上角“数据详情”。";
  host.observeError();
  expect(error.hidden).toBe(true);
  expect(host.nodes.get("sources-toggle").textContent).toBe("数据详情 · 提示");
  error.hidden = false;
  error.textContent = "连接电脑超时或网络中断";
  host.observeError();
  expect(error.hidden).toBe(false);
  expect(host.nodes.get("sources-toggle").textContent).toBe("数据详情");
});

test("lost save acknowledgement is confirmed by a read without repeating the mutation", async () => {
  let posts = 0, reads = 0;
  const host = setup(async (_url, options) => {
    if (options.method === "POST") { posts++; throw new DOMException("signal timed out", "TimeoutError"); }
    reads++; return json({permissions:{agents:["pi"]}});
  });
  await host.submit();
  expect(posts).toBe(1);
  expect(reads).toBe(1);
  expect(host.nodes.get("source-settings").hidden).toBe(true);
  expect(host.nodes.get("source-status").textContent).toBe("已保存。");
  expect(host.inputs[0]!.disabled).toBe(false);
});

test("unconfirmed save keeps the selection and provides a Chinese recovery message", async () => {
  const host = setup(async () => { throw new DOMException("signal timed out", "TimeoutError"); });
  host.nodes.get("source-settings").hidden = false;
  await host.submit();
  expect(host.nodes.get("source-settings").hidden).toBe(false);
  expect(host.nodes.get("source-status").textContent).toContain("暂时无法确认保存结果");
  expect(host.inputs[0]!.checked).toBe(true);
  expect(host.nodes.get("sources-save").disabled).toBe(false);
});

test("initial connection failure never leaves the calendar pretending it is still reading", async () => {
  const host = setup(async () => { throw new Error("offline"); });
  await expect(host.window.JournalHost.request("data")).rejects.toThrow("连接电脑超时或网络中断");
  expect(host.nodes.get("summary").textContent).toBe("暂时未能连接电脑");
  expect(host.nodes.get("canvas-empty").hidden).toBe(false);
  expect(host.nodes.get("canvas-empty").textContent).toContain("消息还没有读取成功");
});

test("conditional polls reuse the canvas data and revocation replaces it", async () => {
  let count = 0;
  const full = {revision:"first", permissions:{agents:["pi"]}, messages:[{id:"u",text:"示例"}]};
  const host = setup(async url => {
    count++;
    if (count === 1) return json(full);
    expect(url.searchParams.get("revision")).toBe("first");
    return json(count === 2 ? {revision:"first",unchanged:true,messages:[]} : {revision:"revoked",permissions:{agents:[]},messages:[]});
  });
  expect(await host.window.JournalHost.request("data")).toEqual(full);
  expect(await host.window.JournalHost.request("data")).toEqual(full);
  expect((await host.window.JournalHost.request("data")).messages).toEqual([]);
});

test("a data response started before a permission save cannot restore the old messages", async () => {
  let finish!: (value: any) => void;
  let reads = 0;
  const host = setup(async (_url, options) => {
    if (options.method === "POST") return json({ok:true});
    if (++reads === 1) return new Promise(resolve => { finish = resolve; });
    return json({revision:"new",permissions:{agents:[]},messages:[]});
  });
  const pending = host.window.JournalHost.request("data");
  await host.submit();
  finish(json({revision:"old",permissions:{agents:["pi"]},messages:[{text:"old"}]}));
  expect((await pending).messages).toEqual([]);
  expect(reads).toBe(2);
});

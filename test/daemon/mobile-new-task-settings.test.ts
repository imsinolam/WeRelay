import { expect, test } from "bun:test";
import { CODEX_MOBILE_JS } from "../../src/daemon/codex-mobile-web.ts";
import { applyMobileNewTaskSettings, parseMobileNewTaskSettings } from "../../src/daemon/mobile-new-task-settings.ts";

function loadDraftModelRuntime(api: (path: string) => Promise<unknown>, schedule = setTimeout) {
  const state: any = { currentThreadId: "local-new-draft", currentAdapter: "codex", taskModels: {}, modelRequestId: 0 };
  const task: any = { threadId: state.currentThreadId, localCreationState: "ready" };
  const start = CODEX_MOBILE_JS.indexOf("  async function loadCurrentTaskModel(");
  const end = CODEX_MOBILE_JS.indexOf("  async function loadCurrentTaskPermission(", start);
  const load = new Function("state", "api", "task", "setTimeout", `
    function currentTask() { return task; }
    function taskNeedsCreation() { return true; }
    function currentTaskModelKey() { return 'draft'; }
    function renderModelControl() {}
    function adapterApiPath(path) { return path; }
    function applyDraftModelSelection(payload) { return payload; }
    ${CODEX_MOBILE_JS.slice(start, end)}
    return loadCurrentTaskModel;
  `)(state, api, task, schedule);
  return { state, task, load };
}

test("a local new task loads its catalog instead of waiting for a real task id", async () => {
  const calls: string[] = [];
  const h = loadDraftModelRuntime(async path => { calls.push(path); return { options:[{id:"model-a"}], canChange:true }; });
  await h.load(false);
  expect(calls).toEqual(["/api/new-task/model"]);
  expect(h.state.taskModels.draft.canChange).toBe(true);
});

test("settings validation rejects malformed input rather than silently using defaults", () => {
  expect(parseMobileNewTaskSettings({model:"model-a",reasoningEffort:"high"})).toEqual({model:"model-a",reasoningEffort:"high"});
  expect(()=>parseMobileNewTaskSettings({model:42})).toThrow();
  expect(()=>parseMobileNewTaskSettings({reasoningEffort:"x".repeat(81)})).toThrow();
});

test("new task settings are applied in order and require confirmation before first input", async () => {
  const calls: string[] = [];
  await applyMobileNewTaskSettings({
    setSessionModel: async (id,model) => { calls.push(`model:${id}`); return {currentModel:model,options:[],canChange:true}; },
    setSessionReasoningEffort: async (id,effort) => { calls.push(`effort:${id}`); return {currentReasoningEffort:effort,options:[],canChange:true}; },
  }, "new-real-task", {model:"model-a",reasoningEffort:"high"});
  expect(calls).toEqual(["model:new-real-task","effort:new-real-task"]);
  await expect(applyMobileNewTaskSettings({setSessionModel:async()=>({currentModel:"wrong",options:[],canChange:true})},"new",{model:"model-a"})).rejects.toThrow("尚未生效");
});

function draftSelector() {
  const start = CODEX_MOBILE_JS.indexOf("  function applyDraftModelSelection(");
  const end = CODEX_MOBILE_JS.indexOf("  function saveDraftModelSelection(", start);
  return new Function(CODEX_MOBILE_JS.slice(start,end)+";return applyDraftModelSelection;")();
}

test("draft reasoning choices follow the selected model instead of the old model", () => {
  const select = draftSelector();
  const catalog = {canChange:true,currentModel:"a",currentReasoningEffort:"high",reasoningEffortOptions:[{id:"high"}],options:[
    {id:"a",reasoningEffortOptions:[{id:"high"}]},
    {id:"b",defaultReasoningEffort:"low",reasoningEffortOptions:[{id:"low"},{id:"medium"}]},
    {id:"c",reasoningEffortOptions:[]},
  ]};
  expect(select(catalog,{model:"b",reasoningEffort:"high"})).toMatchObject({currentModel:"b",currentReasoningEffort:"",reasoningEffortOptions:[{id:"low"},{id:"medium"}]});
  expect(select(catalog,{model:"b",reasoningEffort:"medium"})).toMatchObject({currentReasoningEffort:"medium",canChangeReasoningEffort:true});
  expect(select(catalog,{model:"c"})).toMatchObject({canChangeReasoningEffort:false,reasoningEffortOptions:[]});
});

test("draft choices stay local and survive state refresh without updating another task", async () => {
  const task: any = {threadId:"local-new-draft"};
  const state: any = {taskModels:{draft:{canChange:true,currentModel:"a",options:[{id:"b",reasoningEffortOptions:[{id:"high"}]}]} }};
  let saves = 0;
  const start = CODEX_MOBILE_JS.indexOf("  function applyDraftModelSelection(");
  const end = CODEX_MOBILE_JS.indexOf("  async function loadCurrentTaskModel(",start);
  const save = new Function("state","task","rememberLocalTaskDraft",`
    function taskNeedsCreation(){return true;} function currentTask(){return task;} function currentTaskModelState(){return state.taskModels.draft;}
    function currentTaskModelKey(){return 'draft';} function saveCurrentConversationSnapshot(){}
    function closeModelMenu(){} function closeSessionMenu(){} function renderModelControl(){}
    ${CODEX_MOBILE_JS.slice(start,end)};return saveDraftModelSelection;
  `)(state,task,()=>{saves++;});
  save({model:"b"});save({reasoningEffort:"high"});
  expect(task.newTaskSettings).toEqual({model:"b",reasoningEffort:"high"});
  expect(saves).toBe(2);
  expect(draftSelector()({canChange:true,options:[{id:"b",reasoningEffortOptions:[{id:"high"}]}]},task.newTaskSettings)).toMatchObject({currentModel:"b",currentReasoningEffort:"high"});
});

test("catalog failures settle into a retryable error instead of perpetual loading", async () => {
  const h = loadDraftModelRuntime(async()=>{throw new Error("连接暂时中断");});
  await h.load(false);
  expect(h.state.taskModels.draft).toMatchObject({loadError:true,canChange:false,unavailableReason:"连接暂时中断"});
});

test("entering a local draft starts settings loads before the early return", () => {
  const start = CODEX_MOBILE_JS.indexOf("  async function selectTask(");
  const end = CODEX_MOBILE_JS.indexOf("  function ", start+30);
  const source = CODEX_MOBILE_JS.slice(start,end);
  expect(source).toContain(`if (isTemporaryTask(currentTask())) {
      void loadCurrentTaskModel(false);
      void loadCurrentTaskPermission(false);
      renderMessages(false);
      return;`);
});

test("a failed settings confirmation prevents task input from being dispatched", async () => {
  const events: string[] = [];
  await expect((async () => {
    await applyMobileNewTaskSettings({setSessionModel:async()=>{events.push("configure");throw new Error("模型目录暂不可用");}},"new-task",{model:"a"});
    events.push("send");
  })()).rejects.toThrow("模型目录暂不可用");
  expect(events).toEqual(["configure"]);
});

test("accepted drafts can read their creation receipt and refresh real-task settings", () => {
  const start = CODEX_MOBILE_JS.indexOf("  async function loadMessages(");
  const end = CODEX_MOBILE_JS.indexOf("  async function refreshMessagesIfChanged(",start);
  const source = CODEX_MOBILE_JS.slice(start,end);
  expect(source).toContain("taskNeedsCreation(currentTask()) && !state.pendingMessages.some");
  expect(source).toContain("message.threadId === state.currentThreadId && message.serverAcknowledged");
  expect(source).toContain(`finishLocalTaskDraft(payload.resolvedThreadId);
        void loadCurrentTaskModel(true);
        void loadCurrentTaskPermission(true);`);
});

test("a stalled catalog request becomes a visible retryable timeout", async () => {
  let timeout: (() => void) | undefined;
  const schedule = ((callback: () => void, delay: number) => {expect(delay).toBe(15000);timeout=callback;return 0;}) as typeof setTimeout;
  const h = loadDraftModelRuntime(()=>new Promise(()=>{}),schedule);
  const loading = h.load(false);
  timeout!();
  await loading;
  expect(h.state.taskModels.draft).toMatchObject({loadError:true,unavailableReason:"读取模型超时，请点击重新获取模型。"});
});

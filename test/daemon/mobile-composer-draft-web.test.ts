import { expect, test } from "bun:test";
import { CODEX_MOBILE_APP_JS } from "../../src/daemon/codex-mobile-web.ts";

function harness() {
  const state:any={authenticated:true,currentAdapter:"pi",currentThreadId:"a",composerRevision:0,composerDrafts:Object.create(null),composerDraftOrder:[],
    nativeComposerDraft:null,nativeComposerDraftRequest:0,nativeComposerDraftConsumed:Object.create(null),pendingMessages:[],outboundMessages:[],pendingImages:[],editingQueuedMessageId:""};
  const input={value:""};
  let result:any={supported:true,draft:{text:"  桌面草稿\n\n完整内容  ",revision:"r1"}};
  let deferred:Promise<any>|null=null;
  const notices:string[]=[];
  const start=CODEX_MOBILE_APP_JS.indexOf("  function saveComposerDraft(");
  const end=CODEX_MOBILE_APP_JS.indexOf("  function saveCurrentConversationSnapshot(",start);
  const api=new Function("state","composerInput","conversationStateKey","getBoundedConversationValue","setBoundedConversationValue","deleteConversationValue","MAX_COMPOSER_DRAFTS","schedulePersistentMobileCacheWrite","resizeComposer","api","adapterApiPath","showToast",
    CODEX_MOBILE_APP_JS.slice(start,end)+"\nreturn {saveComposerDraft,restoreComposerDraft,loadNativeComposerDraft,nativeComposerDraftReference,consumeNativeComposerDraft};")(
    state,input,(a:string,t:string)=>a+"/"+t,
    (v:any,_o:any,k:string)=>v[k],(v:any,o:any,k:string,x:any)=>{v[k]=x;if(!o.includes(k))o.push(k);},(v:any,_o:any,k:string)=>delete v[k],40,()=>{},()=>{},()=>deferred||Promise.resolve(result),(p:string,a:string)=>p+"?adapter="+a,(s:string)=>notices.push(s));
  return {state,input,api,notices,set:(value:any)=>{result=value;},defer:(value:Promise<any>)=>{deferred=value;}};
}

test("web imports full native text then clears an unedited draft when sent on desktop",async()=>{
  const h=harness();await h.api.loadNativeComposerDraft();
  expect(h.input.value).toBe("  桌面草稿\n\n完整内容  ");
  expect(h.api.nativeComposerDraftReference()).toBe("r1");
  h.set({supported:true,draft:null});await h.api.loadNativeComposerDraft();
  expect(h.input.value).toBe("");
  expect(h.api.nativeComposerDraftReference()).toBe("");
});

test("web edits survive native changes but stale versions cannot submit as live native drafts",async()=>{
  const h=harness();await h.api.loadNativeComposerDraft();
  h.input.value="网页编辑后";h.state.composerRevision++;h.api.saveComposerDraft("pi","a");
  h.set({supported:true,draft:{text:"电脑刚改",revision:"r2"}});await h.api.loadNativeComposerDraft();
  expect(h.input.value).toBe("网页编辑后");
  expect(h.state.nativeComposerDraft.conflict).toBe(true);
  expect(h.notices).toHaveLength(1);
});

test("late response cannot replace web input, another task, or another adapter",async()=>{
  for(const mutation of [(h:any)=>{h.input.value="新输入";h.state.composerRevision++;},(h:any)=>{h.state.currentThreadId="b";h.input.value="B";},(h:any)=>{h.state.currentAdapter="codex";h.input.value="Codex";}]) {
    const h=harness();let resolve!:(x:any)=>void;h.defer(new Promise(r=>{resolve=r;}));
    const load=h.api.loadNativeComposerDraft();mutation(h);
    const expected=h.input.value;resolve({supported:true,draft:{text:"迟到",revision:"old"}});await load;
    expect(h.input.value).toBe(expected);
  }
});

test("submitted native revision never refills the empty composer; fresh desktop drafts still import",async()=>{
  const h=harness();await h.api.loadNativeComposerDraft();
  const pending={adapter:"pi",threadId:"a",composerDraftRevision:"r1"};
  h.api.consumeNativeComposerDraft(pending);h.input.value="";h.state.composerRevision++;
  await h.api.loadNativeComposerDraft();expect(h.input.value).toBe("");
  h.set({supported:true,draft:{text:"新的一份",revision:"r2"}});await h.api.loadNativeComposerDraft();
  expect(h.input.value).toBe("新的一份");
});

test("pending draft references from a different task or adapter cannot suppress the current draft", async () => {
  const h = harness();
  h.state.outboundMessages = [
    { adapter: "codex", threadId: "a", composerDraftRevision: "r1" },
    { adapter: "pi", threadId: "b", composerDraftRevision: "r1" },
  ];
  await h.api.loadNativeComposerDraft();
  expect(h.input.value).toContain("完整内容");
});

test("a stale native draft conflict is not retried automatically in the browser", () => {
  const start = CODEX_MOBILE_APP_JS.indexOf("  function isNativeComposerDraftConflict(");
  const end = CODEX_MOBILE_APP_JS.indexOf("  function nativeComposerDraftReference(", start);
  const check = new Function(CODEX_MOBILE_APP_JS.slice(start, end) + "\nreturn isNativeComposerDraftConflict;")();
  expect(check({ status: 409, message: "这份电脑端草稿已在网页提交，未重复发送" })).toBe(true);
  expect(check({ status: 409, message: "电脑端草稿已发送、清空或修改；本条未发送" })).toBe(true);
  expect(check({ status: 503, message: "电脑暂未连接" })).toBe(false);
  expect(check({ status: 409, message: "正在恢复终端" })).toBe(false);
});

test("local web drafts and empty local edits are never overwritten; imported drafts revalidate on return",async()=>{
  const h=harness();h.input.value="网页自己的草稿";h.api.saveComposerDraft("pi","a");
  await h.api.loadNativeComposerDraft();expect(h.input.value).toBe("网页自己的草稿");
  const another=harness();await another.api.loadNativeComposerDraft();
  another.input.value="";another.state.composerRevision++;another.api.saveComposerDraft("pi","a");
  await another.api.loadNativeComposerDraft();expect(another.input.value).toBe("");
  const third=harness();await third.api.loadNativeComposerDraft();third.api.saveComposerDraft("pi","a");
  third.input.value="temporary";third.api.restoreComposerDraft("pi","a");
  expect(third.input.value).toBe(""); // do not flash a possibly already-sent cached native draft
  third.api.saveComposerDraft("pi","a"); // a snapshot save while the fresh read is pending
  await third.api.loadNativeComposerDraft();expect(third.input.value).toContain("完整内容");
  const revision = third.state.composerRevision;
  await third.api.loadNativeComposerDraft();expect(third.state.composerRevision).toBe(revision);
});

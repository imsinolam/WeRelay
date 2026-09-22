import { expect, test } from "bun:test";
import { CODEX_MOBILE_JS } from "../../src/daemon/codex-mobile-web.ts";
type Message = {role?: string; text: string; clientId?: string; id?: string; turnId?: string; status?: string; createdAtMs?: number; phase?: string; serverAcknowledged?: boolean; deliveryConfirmed?: boolean; baselineUserKeys?: string[]; baselineUserCount?: number; threadId?: string; adapter?: string; images?: unknown[]; imageCount?: number};
type Summary = {status: string; turnId?: string; clientId?: string; startedAtMs?: number; baselineTurnId?: string};
function block(from: string, to: string) {
  const a = CODEX_MOBILE_JS.indexOf('  function ' + from);
  const b = CODEX_MOBILE_JS.indexOf('  function ' + to, a);
  if (a < 0 || b < 0) throw new Error(`missing ${from}/${to}`);
  return CODEX_MOBILE_JS.slice(a, b);
}
function harness() {
  const state = {currentThreadId:'task', currentAdapter:'codex', pendingMessages:[] as Message[], outboundMessages:[] as Message[], serverMessages:[] as Message[], deliveredClientIds:[] as string[], localRunSummary:null as Summary|null, runSummary:null as Summary|null, optimisticProgressTurnId:null as string|null, progressItems:[] as unknown[], lastLiveMessageRefreshAtMs:0};
  const api = new Function('state', `
    function filterVisibleConversationMessages(x) {return x || [];} function currentTask(){return null;}
    function pendingImageStoreOperation(){return Promise.resolve();}
    ${block('visiblePendingMessages()', 'currentVisibleRunSummary()')}
    ${block('reconcilePendingMessages(', 'runHeaderInsertIndex(')}
    ${block('effectiveRunSummary()', 'resolveVisibleRunSummary(')}
    ${block('updateRunSummary(', 'normalizeMessagePage(')}
    ${block('messageNodeBaseKey(', 'stableMessageNodeHash(')}
    function runDurationMs(){return 0;}
    return {visiblePendingMessages, reconcilePendingMessages, updateRunSummary, shouldForceLiveMessageRefresh,
      conversation: typeof conversationMessages === 'function' ? conversationMessages : () => state.serverMessages.concat(visiblePendingMessages()), messageNodeBaseKey};
  `)(state) as {
    visiblePendingMessages: () => Message[];
    reconcilePendingMessages: (messages: Message[], outbound?:Message[], ids?:string[])=>void;
    updateRunSummary: (s:Summary|null,t:unknown,m:Message[],p?:Message[])=>void;
    shouldForceLiveMessageRefresh: (time:number)=>boolean;
    conversation: ()=>Message[];
    messageNodeBaseKey: (m:Message)=>string;
  };
  return {state,...api};
}
// 使用接近当前时间的时间戳：客户端会把「等待原生确认过久」的待发送消息判定为
// 过时，写死的 1970 年时间会被正确判为过期，从而干扰这些与本意无关的用例。
const baseMs = Date.now();
function pending(overrides: Partial<Message> = {}): Message {return {clientId:'client', text:'新的请求', status:'sending', threadId:'task', adapter:'codex', createdAtMs:baseMs, baselineUserKeys:['id:old'], baselineUserCount:1,...overrides};}

test('POST acknowledgement never removes the visible message while transcript catches up',()=>{
  const h=harness();h.state.pendingMessages=[pending({serverAcknowledged:true,status:'accepted'})];
  expect(h.visiblePendingMessages().map(m=>m.clientId)).toEqual(['client']);
  h.state.deliveredClientIds=['client'];
  expect(h.visiblePendingMessages()).toHaveLength(1);
  expect(h.state.pendingMessages[0]?.serverAcknowledged).toBe(true);
});
test('outbox takeover and an empty following snapshot keep one durable bubble',()=>{
  const h=harness();h.state.pendingMessages=[pending()];h.state.outboundMessages=[pending({status:'sending',id:'outbox'})];
  expect(h.visiblePendingMessages()).toHaveLength(1);
  h.state.outboundMessages=[];
  expect(h.visiblePendingMessages()).toHaveLength(1);
});
test('outbox-only page preserves its bubble through a receipt-only refresh',()=>{
  const h=harness();h.state.outboundMessages=[pending({status:'submitted',turnId:'new'})];
  expect(h.visiblePendingMessages()).toHaveLength(1);
  h.state.outboundMessages=[];h.state.deliveredClientIds=['client'];
  expect(h.visiblePendingMessages()).toHaveLength(1);
});
test('a native user message atomically replaces the provisional bubble under the same render key',()=>{
  const h=harness();h.state.pendingMessages=[pending({turnId:'new'})];h.state.outboundMessages=[pending({status:'submitted',turnId:'new'})];
  const key=h.messageNodeBaseKey(h.visiblePendingMessages()[0]!);
  h.state.serverMessages=[{id:'native',role:'user',text:'新的请求',turnId:'new',createdAtMs:baseMs + 10}];
  expect(h.visiblePendingMessages()).toHaveLength(0);
  expect(h.messageNodeBaseKey(h.state.serverMessages[0]!)).toBe(key);
});
test('same text in a different known turn never acknowledges this send',()=>{
  const h=harness();h.state.pendingMessages=[pending({turnId:'new'})];
  h.state.serverMessages=[{id:'other',role:'user',text:'新的请求',turnId:'other',createdAtMs:baseMs + 10}];
  expect(h.visiblePendingMessages()).toHaveLength(1);
});
test('a preserved user bubble precedes its assistant output rather than jumping below it',()=>{
  const h=harness();h.state.pendingMessages=[pending({status:'submitted',serverAcknowledged:true,turnId:'new'})];
  h.state.serverMessages=[{id:'answer',role:'assistant',text:'开始检查',phase:'commentary',turnId:'new',createdAtMs:baseMs + 100}];
  expect(h.conversation().map(m=>m.text)).toEqual(['新的请求','开始检查']);
});
test('previous completed output cannot terminate a newly submitted request',()=>{
  const h=harness();h.state.localRunSummary={status:'submitting',clientId:'client',startedAtMs:Date.now(),baselineTurnId:'old'};
  h.updateRunSummary({status:'completed',turnId:'old'},null,[{role:'user',text:'旧请求',turnId:'old'},{role:'assistant',text:'旧回复',turnId:'old',phase:'final_answer'}]);
  expect(h.state.localRunSummary?.status).toBe('submitting');
});
test('native running state stays running even with commentary and a missing list snapshot',()=>{
  const h=harness();h.updateRunSummary({status:'running',turnId:'new'},null,[{role:'user',text:'请求',turnId:'new'},{role:'assistant',text:'开始检查',turnId:'new',phase:'commentary'}]);
  expect(h.state.runSummary?.status).toBe('running');
});
test('matching live turn hands off local status and unlocks native progress immediately',()=>{
  const h=harness();h.state.localRunSummary={status:'submitting',turnId:'new',clientId:'client',startedAtMs:Date.now()};h.state.optimisticProgressTurnId='';
  h.updateRunSummary({status:'running',turnId:'new'},null,[{role:'user',text:'新的请求',turnId:'new'}]);
  expect(h.state.localRunSummary).toBeNull();expect(h.state.optimisticProgressTurnId).toBe('new');
});
test('pending acceptance keeps the fallback refresh active without a running task',()=>{
  const h=harness();h.state.pendingMessages=[pending({status:'accepted',serverAcknowledged:true})];
  expect(h.shouldForceLiveMessageRefresh(6000)).toBe(true);
});

test("fresh progress unlocks the real turn before its user page or summary arrives", () => {
  const h = harness(); const now = Date.now();
  h.state.localRunSummary = {status:"submitting", clientId:"client", baselineTurnId:"old", startedAtMs:now};
  h.state.optimisticProgressTurnId = "";
  h.updateRunSummary({status:"completed", turnId:"old"}, null, [], [{text:"核对文件", turnId:"new", status:"running", createdAtMs:now+1}]);
  expect(h.state.runSummary).toMatchObject({turnId:"new", status:"running"});
  expect(h.state.localRunSummary).toBeNull();
  expect(h.state.optimisticProgressTurnId).toBe("new");
});
test("old progress never claims a new submission", () => {
  const h = harness();
  h.state.localRunSummary = {status:"submitting", clientId:"client", baselineTurnId:"old", startedAtMs:10_000};
  h.state.optimisticProgressTurnId = "";
  h.updateRunSummary(null, null, [], [{text:"旧进展", turnId:"old", status:"running", createdAtMs:baseMs + 1}]);
  expect(h.state.localRunSummary?.status).toBe("submitting");
  expect(h.state.optimisticProgressTurnId).toBe("");
});
test("stale outbox cannot resurrect a native message or consume another identical send", () => {
  const h = harness();
  h.state.serverMessages = [{id:"native", clientId:"first", role:"user", text:"新的请求", turnId:"new", createdAtMs:baseMs + 10}];
  h.state.pendingMessages = [pending({clientId:"second", turnId:"new"})];
  h.state.outboundMessages = [pending({clientId:"first", turnId:"new"})];
  for (let i=0;i<3;i++) expect(h.visiblePendingMessages().map(m=>m.clientId)).toEqual(["second"]);
});
test("a matching completed turn ends only its own provisional state", () => {
  const h = harness(); h.state.localRunSummary = {status:"syncing",turnId:"new"};
  h.updateRunSummary({status:"completed",turnId:"new"},null,[]);
  expect(h.state.localRunSummary).toBeNull();
  expect(h.state.runSummary?.status).toBe("completed");
});

test("missing live summary cannot erase an already confirmed running turn", () => {
  const h = harness();h.state.runSummary = {status:"running",turnId:"new"};
  h.updateRunSummary(null,null,[{text:"检查中",role:"assistant",phase:"commentary",turnId:"new"}]);
  expect(h.state.runSummary).toMatchObject({status:"running",turnId:"new"});
});
test("authoritative queue or delivery failure releases the provisional submission status", () => {
  for (const status of ["queued", "failed"]) {
    const h = harness();h.state.localRunSummary = {status:"submitting",clientId:"client"};
    h.state.pendingMessages=[pending()];h.state.outboundMessages=[pending({status})];
    expect(h.visiblePendingMessages()).toHaveLength(1);
    expect(h.state.localRunSummary).toBeNull();
    expect(h.state.pendingMessages[0]?.status).toBe(status);
  }
});

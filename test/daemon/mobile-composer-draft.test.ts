import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MobileMessageOutbox } from "../../src/daemon/mobile-message-outbox.ts";
import { CodexMobileAuthStore } from "../../src/daemon/codex-mobile-auth.ts";
import { startCodexMobileServer } from "../../src/daemon/codex-mobile-server.ts";

test("native draft reference survives outbox restart and is claimed per adapter and session", () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wr-md-"));
  try {
    const stateFile=path.join(dir,"outbox.json");
    let box=new MobileMessageOutbox({stateFile});
    box.accept({adapter:"pi",threadId:"same",clientId:"a",text:"modified",images:[],composerDraftRevision:"rev-a"});
    expect(box.findComposerDraftSubmission("pi","same","rev-a")?.clientId).toBe("a");
    expect(box.findComposerDraftSubmission("codex","same","rev-a")).toBeNull();
    expect(box.findComposerDraftSubmission("pi","other","rev-a")).toBeNull();
    box=new MobileMessageOutbox({stateFile});
    expect(box.get("pi","same","a")?.composerDraftRevision).toBe("rev-a");
    box.markSubmitted("pi","same","a",{});
    expect(box.findComposerDraftSubmission("pi","same","rev-a")?.status).toBe("submitted");
    expect(box.findComposerDraftSubmission("pi","same","new-revision")).toBeNull();
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test("composer draft API is authenticated, uncached, exact and forwards send reference", async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wr-md-api-"));
  const authStore=new CodexMobileAuthStore({stateFile:path.join(dir,"auth.json")});
  authStore.setPassword("fixture-password");
  const calls: unknown[]=[];
  const server=await startCodexMobileServer({host:"127.0.0.1",port:0,lanAddress:"127.0.0.1",accessToken:"fixture",authStore,
    relayPrewarmToken:"prewarm-fixture",
    listTasks:async()=>{throw new Error("must not enumerate/follow tasks");},
    readMessages:async()=>{throw new Error("must not read history for a draft");},
    readTaskComposerDraft:async(threadId,adapter)=>{calls.push({threadId,adapter});return {supported:true,draft:{text:"  exact\n\ntext  ",revision:"revision-1"}};},
    sendMessage:async(threadId,input,adapter)=>{calls.push({threadId,input,adapter});return {accepted:true,queued:false};},
  });
  try {
    const root=`http://127.0.0.1:${server.port}`;
    const endpoint=root+"/api/tasks/exact-task/composer-draft?adapter=pi";
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint,{headers:{"x-werelay-relay-prewarm":"prewarm-fixture"}})).status).toBe(401);
    expect(calls).toEqual([]);
    const headers={cookie:`codex_mobile_session=${authStore.createSessionToken()}`,"content-type":"application/json"};
    const response=await fetch(endpoint,{headers});
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({threadId:"exact-task",supported:true,draft:{text:"  exact\n\ntext  ",revision:"revision-1"}});
    const send=await fetch(root+"/api/tasks/exact-task/messages?adapter=pi",{method:"POST",headers,
      body:JSON.stringify({clientId:"one",text:"modified",images:[],composerDraftRevision:"revision-1"})});
    expect(send.status).toBe(202);
    expect(calls[1]).toMatchObject({threadId:"exact-task",adapter:"pi",input:{composerDraftRevision:"revision-1",text:"modified"}});
    const invalid=await fetch(root+"/api/tasks/exact-task/messages?adapter=pi",{method:"POST",headers,
      body:JSON.stringify({clientId:"two",text:"x",composerDraftRevision:{invalid:true}})});
    expect(invalid.status).toBe(400);
  } finally {await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test("daemon accepts a native draft once across different browser client IDs, retries the original only", async()=>{
  const {WeRelayDaemon}=await import("../../src/daemon/werelay-daemon.ts");
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wr-draft-once-"));
  try {
    const daemon:any=Object.create(WeRelayDaemon.prototype);
    daemon.mobileMessageOutbox=new MobileMessageOutbox({stateFile:path.join(dir,"box.json")});
    daemon.activeAdapter="pi";
    daemon.scheduleMobileMessageOutboxDrain=()=>{};
    daemon.persistMobileImages=()=>[];
    const input={clientId:"first",text:"edited",images:[],composerDraftRevision:"rev-1"};
    expect(daemon.acceptMobileMessage("task-a",input,"pi").accepted).toBe(true);
    expect(daemon.acceptMobileMessage("task-a",input,"pi").duplicate).toBe(true);
    expect(()=>daemon.acceptMobileMessage("task-a",{...input,clientId:"other-tab"},"pi")).toThrow("已在网页提交");
    expect(daemon.acceptMobileMessage("task-b",{...input,clientId:"other-task"},"pi").accepted).toBe(true);
    expect(daemon.acceptMobileMessage("task-a",{...input,clientId:"other-adapter"},"codex").accepted).toBe(true);
    expect(daemon.mobileMessageOutbox.readyEntries()).toHaveLength(3);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test("draft receipts outlive transcript retention without retaining the draft text",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"wr-draft-receipt-"));
  const stateFile=path.join(dir,"box.json");let now=1_000_000;
  try {
    let box=new MobileMessageOutbox({stateFile,now:()=>now});
    box.accept({adapter:"codex",threadId:"a",clientId:"one",text:"private fixture",images:[],composerDraftRevision:"unchanged"});
    box.markSubmitted("codex","a","one",{});
    box.reconcileReceived("codex","a","one",[{role:"user",text:"private fixture",createdAtMs:now+1,id:"received"}]);
    now+=9*24*60*60_000;
    box=new MobileMessageOutbox({stateFile,now:()=>now});
    expect(box.get("codex","a","one")).toBeNull();
    expect(box.hasComposerDraftSubmission("codex","a","unchanged")).toBe(true);
    expect(fs.readFileSync(stateFile,"utf8")).not.toContain("private fixture");
    box=new MobileMessageOutbox({stateFile,now:()=>now});
    expect(box.hasComposerDraftSubmission("codex","a","unchanged")).toBe(true);
    expect(box.hasComposerDraftSubmission("pi","a","unchanged")).toBe(false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

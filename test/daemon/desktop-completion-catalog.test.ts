import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "bun:test";

test("idle daemon captures native desktop history and persists it without opening owners or sending network requests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-passive-completions-"));
  const daemonSource = new URL("../../src/daemon/werelay-daemon.ts", import.meta.url).href;
  const stateSource = new URL("../../src/daemon/daemon-state.ts", import.meta.url).href;
  const workerSource = new URL("../../src/daemon/global-task-catalog-worker.ts", import.meta.url).href;
  const code = `
    import fs from "node:fs"; import path from "node:path"; import assert from "node:assert/strict";
    import {DatabaseSync} from "node:sqlite";
    import {WeRelayDaemon} from ${JSON.stringify(daemonSource)};
    import {DaemonWorkspaceStateStore} from ${JSON.stringify(stateSource)};
    import {GlobalTaskCatalogWorker} from ${JSON.stringify(workerSource)};
    const dir=process.env.HOME, now=Date.now(), iso=new Date(now).toISOString();
    fs.mkdirSync(path.join(process.env.WORKBUDDY_CONFIG_DIR,"projects","fixture"),{recursive:true});
    const wb=new DatabaseSync(path.join(process.env.WORKBUDDY_CONFIG_DIR,"workbuddy.db"));
    wb.exec("CREATE TABLE sessions (id TEXT,cwd TEXT,title TEXT,custom_title TEXT,status TEXT,created_at INTEGER,updated_at INTEGER,last_activity_at INTEGER,project_id TEXT,deleted_at INTEGER)");
    wb.prepare("INSERT INTO sessions VALUES (?,?,?,NULL,?,?,?,?,NULL,NULL)").run("same",dir,"桌面完成", "completed",now-1000,now,now);
    wb.close();
    const wbFile=path.join(process.env.WORKBUDDY_CONFIG_DIR,"projects","fixture","same.jsonl");
    fs.writeFileSync(wbFile,[
      {type:"message",id:"user",role:"user",timestamp:now-1000,content:[{type:"text",text:"检查"}]},
      {type:"message",id:"native-final",role:"assistant",status:"completed",timestamp:now,content:[{type:"text",text:"已完成检查"}]},
    ].map(JSON.stringify).join("\\n"));
    fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
    const rollout=path.join(process.env.CODEX_HOME,"fixture.jsonl");
    const rows=[
      {timestamp:iso,type:"response_item",payload:{type:"message",role:"assistant",phase:"final_answer",id:"a",internal_chat_message_metadata_passthrough:{turn_id:"turn"},content:[{type:"output_text",text:"Codex 完成"}]}},
      {timestamp:iso,type:"event_msg",payload:{type:"task_complete",turn_id:"turn",duration_ms:1000,last_agent_message:"Codex 完成"}},
    ];
    fs.writeFileSync(rollout,rows.map(JSON.stringify).join("\\n"));
    const cx=new DatabaseSync(path.join(process.env.CODEX_HOME,"state_5.sqlite"));
    cx.exec("CREATE TABLE threads (id TEXT,rollout_path TEXT,cwd TEXT,title TEXT,created_at INTEGER,updated_at INTEGER)");
    cx.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?)").run("same",rollout,dir,"Codex 完成",Math.floor(now/1000),Math.floor(now/1000));
    cx.close();
    const reader=new GlobalTaskCatalogWorker({timeoutMs:10000});
    const wbEvidence=await reader.loadCompletions("workbuddy",dir);
    const codexEvidence=await reader.loadCompletions("codex",dir);
    assert.equal(wbEvidence.length,1); assert.equal(codexEvidence.length,1);
    assert.equal(wbEvidence[0].finalMessage.id,"native-final");
    const stateFile=path.join(dir,"state.json");
    const store=new DaemonWorkspaceStateStore(dir,{stateFile});
    let sends=0;
    const daemon=new WeRelayDaemon({cwd:dir,authorizedUserId:"fixture",stateStore:store,
      transport:{sendText:async()=>{sends++;throw Error("should not send in capture");}}});
    daemon.ensureSlot=async()=>{throw Error("must not connect a desktop owner");};
    daemon.outboundRecoveryScheduler.trigger=async()=>{};
    await daemon.captureDesktopCompletion(wbEvidence[0],"native-key");
    await daemon.captureDesktopCompletion(codexEvidence[0],"same:turn");
    await daemon.captureDesktopCompletion(wbEvidence[0],"native-key");
    assert.equal(daemon.getStatus().slots.length,0);
    assert.equal(store.getLatestWechatTaskTarget(),null);
    assert.equal(store.getCodexCompletionDeliveryState().pending.length,2);
    assert.equal(store.getRecentTaskCompletions().length,2);
    assert.equal(sends,0);
    const restarted=new DaemonWorkspaceStateStore(dir,{stateFile});
    assert.equal(restarted.getCodexCompletionDeliveryState().pending.length,2);
    // A newly submitted user message must suppress the previous completed reply.
    fs.appendFileSync(wbFile,"\\n"+JSON.stringify({type:"message",id:"next-user",role:"user",timestamp:now+1,content:[{type:"text",text:"继续"}]}));
    assert.equal((await reader.loadCompletions("workbuddy",dir)).length,0);
    fs.appendFileSync(rollout,"\\n"+JSON.stringify({timestamp:iso,type:"event_msg",payload:{type:"task_started",turn_id:"next"}}));
    assert.equal((await reader.loadCompletions("codex",dir)).length,0);
    await reader.close(); await daemon.shutdown();
    console.log("PASS");
  `;
  try {
    const { stdout } = await promisify(execFile)("node", ["--experimental-transform-types", "--input-type=module", "-e", code], {
      env: { ...process.env, HOME: dir, USERPROFILE: dir, CODEX_HOME: path.join(dir, "codex"),
        WORKBUDDY_CONFIG_DIR: path.join(dir, "wb"), WERELAY_DATA_DIR: path.join(dir, "relay") },
      timeout: 20_000,
    });
    expect(stdout.trim()).toBe("PASS");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 25_000);

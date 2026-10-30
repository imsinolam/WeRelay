import { expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readPiOwnerDraft } from "../../src/bridge/pi-owner-draft.ts";
import { PiOwnerAdapter } from "../../src/bridge/bridge-adapters.pi.ts";

test("Pi duplicate draft acknowledgement does not revive a completed run", async () => {
  const adapter: any = Object.create(PiOwnerAdapter.prototype);
  adapter.state = { sharedSessionId: "a", status: "idle" };
  adapter.socket = { destroyed: false }; adapter.ownerSessionConfirmed = true; adapter.settledRevision = 1;
  adapter.nativeSessionId = async (id: string) => id;
  adapter.request = async () => ({ queued: false, duplicate: true });
  adapter.status = (status: string) => { adapter.state.status = status; };
  expect((await adapter.sendInputToSession("a", "same", { composerDraftRevision: "r1", clientId: "one" })).duplicate).toBe(true);
  expect(adapter.state.status).toBe("idle");
});

test("Pi native draft reader preserves UTF-8 across socket chunks and releases before returning", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pdu-"));
  const endpoint = path.join(dir, "owner.sock");
  const text = "  中文和表情🙂\n\n完整保留  ";
  let released = false;
  let peer: net.Socket | undefined;
  const server = net.createServer(socket => {
    peer = socket;
    let buffer = "";
    socket.on("data", data => {
      buffer += data.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (request.type === "hello") socket.write(JSON.stringify({ type: "ready", sessionId: "a", token: "fixture" }) + "\n");
        if (request.type === "composer_draft") {
          const bytes = Buffer.from(JSON.stringify({ type: "response", id: request.id, ok: true, token: "fixture",
            composerDraft: { supported: true, draft: { text, revision: "r1" } },
          }) + "\n");
          const cut = bytes.indexOf(Buffer.from("中")) + 1;
          socket.write(bytes.subarray(0, cut));
          setTimeout(() => socket.write(bytes.subarray(cut)), 10);
        }
        if (request.type === "release") {
          released = true;
          socket.end(JSON.stringify({ type: "response", id: request.id, ok: true, token: "fixture" }) + "\n");
        }
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
    const result = await readPiOwnerDraft({ pid: process.pid, sessionId: "a", cwd: dir, socket: endpoint, token: "fixture" });
    expect(result.draft?.text).toBe(text);
    expect(released).toBe(true);
  } finally { peer?.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Pi native draft read/edit-send is exact, compare-and-clear, idempotent and rollback-safe", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-pd-"));
  const saved = { ...process.env };
  const handlers = new Map<string, (...args: any[]) => any>();
  let draft = "  未发送\n\n保留空格  ";
  const sent: string[] = [];
  const responses = new Map<string, any>();
  let socket: net.Socket | undefined;
  let fail = false;
  const server = net.createServer(peer => {
    socket = peer; let buffer = "";
    peer.on("data", data => {
      buffer += data.toString(); let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const r = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1);
        if (r.id) responses.set(r.id,r);
      }
    });
  });
  const until = async (fn: () => boolean) => {
    const deadline=Date.now()+1500;
    while(!fn()) { if(Date.now()>deadline) throw new Error("fixture timeout"); await new Promise(r=>setTimeout(r,5)); }
  };
  const request = async (type: string, extra = {}) => {
    const id = String(Math.random());
    socket!.write(JSON.stringify({type,id,sessionId:"session-a",token:"fixture",...extra})+"\n");
    await until(()=>responses.has(id)); return responses.get(id);
  };
  try {
    await new Promise<void>(r=>server.listen(path.join(dir,"owner.sock"),r));
    process.env.WERELAY_PI_OWNER_SOCKET=path.join(dir,"owner.sock"); process.env.WERELAY_PI_OWNER_TOKEN="fixture";
    const extension=(await import(new URL(`../../bin/pi-owner-extension.mjs?draft=${Date.now()}`,import.meta.url).href)).default;
    extension({on:(name:string,fn:any)=>handlers.set(name,fn),sendUserMessage:(text:string)=>{if(fail)throw new Error("fixture send failure");sent.push(text);}});
    const ctx={hasUI:true,sessionManager:{getSessionId:()=>"session-a"},isIdle:()=>true,
      ui:{getEditorText:()=>draft,setEditorText:(text:string)=>{draft=text;}}};
    handlers.get("session_start")!({},ctx); await until(()=>Boolean(socket));
    const read=await request("composer_draft");
    expect(read).toMatchObject({ok:true,composerDraft:{supported:true,draft:{text:draft}}});
    const revision=read.composerDraft.draft.revision;
    expect((await request("prompt",{text:"网页修改",clientId:"once",composerDraftRevision:revision})).ok).toBe(true);
    expect(draft).toBe(""); expect(sent).toEqual(["网页修改"]);
    expect((await request("prompt",{text:"网页修改",clientId:"once",composerDraftRevision:revision})).duplicate).toBe(true);
    expect(sent).toHaveLength(1);
    expect((await request("composer_draft")).composerDraft.draft).toBeNull();
    draft="新草稿";
    expect((await request("prompt",{text:"stale",clientId:"wrong",composerDraftRevision:revision})).ok).toBe(false);
    expect(draft).toBe("新草稿");
    const newer=(await request("composer_draft")).composerDraft.draft;
    fail=true;
    expect((await request("prompt",{text:"failed",clientId:"failure",composerDraftRevision:newer.revision})).ok).toBe(false);
    expect(draft).toBe("新草稿"); fail=false;
    handlers.get("input")!({source:"interactive"},ctx);
    expect((await request("composer_draft")).composerDraft.draft.revision).not.toBe(newer.revision);
    ctx.hasUI=false;
    expect((await request("composer_draft")).composerDraft).toMatchObject({supported:false,draft:null});
    expect((await request("composer_draft",{sessionId:"wrong"})).ok).toBe(false);
    handlers.get("session_shutdown")!({reason:"quit"},ctx);
  } finally {
    socket?.destroy(); server.close();
    for(const key of ["WERELAY_PI_OWNER_SOCKET","WERELAY_PI_OWNER_TOKEN"]) {
      if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];
    }
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

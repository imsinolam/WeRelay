import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexMobileAuthStore } from "../../src/daemon/codex-mobile-auth.ts";
import { startCodexMobileServer } from "../../src/daemon/codex-mobile-server.ts";
import { createMessageJournal } from "../../src/message-journal/journal.ts";
import { MESSAGE_JOURNAL_ASSET_VERSION } from "../../src/message-journal/assets.ts";
import { startWeRelayRelayServer } from "../../src/relay/relay-server.ts";
import { startWeRelayRelayClient } from "../../src/relay/relay-client.ts";

const closers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive:true, force:true });
});
async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-http-")); dirs.push(dir);
  const root = path.join(dir, "sessions"); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "s.jsonl"), [
    {type:"session", id:"s", cwd:"/example/project"},
    {type:"message", id:"u", timestamp:Date.now(), message:{role:"user",content:"日历接口回归"}},
  ].map(row => JSON.stringify(row)).join("\n"));
  const journal = createMessageJournal({ permissionFile:path.join(dir,"permissions.json"), roots:[{agent:"pi",root}] });
  const authStore = new CodexMobileAuthStore({ stateFile:path.join(dir,"auth.json") });
  authStore.setPassword("journal-test-password");
  const server = await startCodexMobileServer({ host:"127.0.0.1", lanAddress:"127.0.0.1", port:0, accessToken:"journal-test-setup", relayPrewarmToken:"test-prewarm", authStore, messageJournal:journal, listTasks:async()=>[], readMessages:async()=>({threadId:"unused",messages:[]}), sendMessage:async()=>({queued:false}) });
  closers.push(()=>server.close());
  return { journal, root:`http://127.0.0.1:${server.port}`, cookie:`codex_mobile_session=${authStore.createSessionToken()}` };
}
async function waitForMessages(root: string, cookie: string) {
  const deadline = Date.now()+2000;
  while (Date.now()<deadline) {
    const response = await fetch(root+"/api/message-journal/data",{headers:{cookie}});
    const data = await response.json() as any;
    if (data.messages?.length) return data;
    await Bun.sleep(10);
  }
  throw new Error("journal scan did not finish");
}

test("public shell contains no private data; consent and data require authentication", async()=>{
  const {root,cookie} = await setup();
  const html = await fetch(root+"/journal/");
  expect(html.status).toBe(200);
  const text = await html.text();
  expect(text).toContain(MESSAGE_JOURNAL_ASSET_VERSION);
  expect(text).not.toContain("日历接口回归");
  expect(text).not.toContain("_magpie/bridge.js");
  expect(html.headers.get("content-security-policy")).toContain("style-src 'self' 'unsafe-inline'");
  expect((await fetch(root+"/api/message-journal/data")).status).toBe(401);
  const permissionUrl = root+"/api/message-journal/permissions";
  expect((await fetch(permissionUrl,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agents:["pi"]})})).status).toBe(401);
  expect((await fetch(root+"/api/message-journal/data",{headers:{"x-werelay-relay":"1","x-werelay-relay-prewarm":"test-prewarm"}})).status).toBe(401);
  expect((await fetch(root+"/api/message-journal/data",{headers:{cookie}}).then(r=>r.json()) as any).messages).toEqual([]);
  expect((await fetch(permissionUrl,{method:"POST",headers:{cookie,"content-type":"text/plain"},body:JSON.stringify({agents:["pi"]})})).status).toBe(415);
  expect((await fetch(permissionUrl,{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({agents:["pi"]})})).status).toBe(200);
  expect((await waitForMessages(root,cookie)).messages[0].text).toBe("日历接口回归");
  await fetch(permissionUrl,{method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({agents:[]})});
  expect((await fetch(root+"/api/message-journal/data",{headers:{cookie}}).then(r=>r.json()) as any).messages).toEqual([]);
  for (const name of ["data.js","provenance.json","../src/scanner.mjs"]) expect((await fetch(root+"/journal/"+name)).status).toBe(401);
});

test("application relay serves identical assets and carries authenticated consent, data and revocation", async()=>{
  const local = await setup();
  const relay = await startWeRelayRelayServer({host:"127.0.0.1",port:0,deviceId:"journal-device",deviceToken:"journal-device-test-token",pollTimeoutMs:100,warmRefreshIntervalMs:60000});
  closers.push(()=>relay.close());
  const client = startWeRelayRelayClient({relayUrl:relay.baseUrl,deviceId:"journal-device",deviceToken:"journal-device-test-token",localBaseUrl:local.root,retryDelayMs:10});
  closers.push(()=>client.close());
  const base = relay.baseUrl;
  expect(await fetch(base+"/journal/").then(r=>r.text())).toBe(await fetch(local.root+"/journal/").then(r=>r.text()));
  for (const asset of ["app.js","core.js","host.js","panel.css","version"]) {
    expect(await fetch(base+"/journal/"+asset).then(r=>r.text())).toBe(await fetch(local.root+"/journal/"+asset).then(r=>r.text()));
  }
  expect((await fetch(base+"/api/message-journal/data")).status).toBe(401);
  const headers = {cookie:local.cookie,"content-type":"application/json"};
  expect((await fetch(base+"/api/message-journal/permissions",{method:"POST",headers,body:JSON.stringify({agents:["pi"]})})).status).toBe(200);
  expect((await waitForMessages(base,local.cookie)).messages[0].text).toBe("日历接口回归");
  await fetch(base+"/api/message-journal/permissions",{method:"POST",headers,body:JSON.stringify({agents:[]})});
  expect((await fetch(base+"/api/message-journal/data",{headers}).then(r=>r.json()) as any).messages).toEqual([]);
});

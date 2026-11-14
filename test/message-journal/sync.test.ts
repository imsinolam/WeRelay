import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive:true, force:true }); });
test("sync updates only allowlisted code; an offline build verifies the saved snapshot",()=>{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"journal-sync-")); dirs.push(dir);
  const project = path.join(dir,"consumer"); const upstream = path.join(dir,"upstream");
  fs.mkdirSync(path.join(project,"scripts"),{recursive:true});
  fs.copyFileSync(path.join(repo,"scripts/sync-message-journal.mjs"),path.join(project,"scripts/sync-message-journal.mjs"));
  fs.cpSync(path.join(repo,"vendor/message-journal"),upstream,{recursive:true});
  fs.writeFileSync(path.join(upstream,"package.json"),JSON.stringify({name:"magpie-message-journal"}));
  fs.writeFileSync(path.join(upstream,"panel/data.js"),"PRIVATE INDEX");
  fs.writeFileSync(path.join(upstream,"tasks.json"),"PRIVATE CLASSIFICATIONS");
  const run = (source?: string) => execFileSync(process.execPath,[path.join(project,"scripts/sync-message-journal.mjs")],{cwd:dir,env:{...process.env,MESSAGE_JOURNAL_SOURCE:source??""},encoding:"utf8",stdio:["ignore","pipe","pipe"]});
  expect(run(upstream)).toBe(""); // npm pack --json must keep stdout machine-readable.
  const target = path.join(project,"vendor/message-journal");
  expect(fs.existsSync(path.join(target,"panel/data.js"))).toBe(false);
  expect(fs.existsSync(path.join(target,"tasks.json"))).toBe(false);
  const newCore = fs.readFileSync(path.join(upstream,"panel/core.mjs"),"utf8")+"\n// synthetic upstream update\n";
  fs.writeFileSync(path.join(upstream,"panel/core.mjs"),newCore);
  run(upstream);
  expect(fs.readFileSync(path.join(target,"panel/core.mjs"),"utf8")).toBe(newCore);
  expect(run()).toBe("");
  fs.appendFileSync(path.join(target,"panel/core.mjs"),"tampered");
  const failed = spawnSync(process.execPath,[path.join(project,"scripts/sync-message-journal.mjs")],{cwd:dir,env:{...process.env,MESSAGE_JOURNAL_SOURCE:""},encoding:"utf8"});
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain("快照校验失败");
});


test("release builds verify the committed snapshot without importing another worktree", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-locked-build-")); dirs.push(dir);
  const project = path.join(dir, "consumer"); const upstream = path.join(dir, "upstream");
  fs.mkdirSync(path.join(project, "scripts"), {recursive:true});
  fs.copyFileSync(path.join(repo, "scripts/sync-message-journal.mjs"), path.join(project, "scripts/sync-message-journal.mjs"));
  fs.cpSync(path.join(repo, "vendor/message-journal"), path.join(project, "vendor/message-journal"), {recursive:true});
  fs.cpSync(path.join(repo, "vendor/message-journal"), upstream, {recursive:true});
  fs.writeFileSync(path.join(upstream, "package.json"), JSON.stringify({name:"magpie-message-journal"}));
  fs.appendFileSync(path.join(upstream, "panel/core.mjs"), "\n// uncommitted upstream update\n");
  const target = path.join(project, "vendor/message-journal/panel/core.mjs");
  const before = fs.readFileSync(target, "utf8");
  const command = [path.join(project, "scripts/sync-message-journal.mjs"), "--check"];
  const env = {...process.env, MESSAGE_JOURNAL_SOURCE:upstream};
  const result = spawnSync(process.execPath, command, {cwd:project,env,encoding:"utf8"});
  expect(result.status).toBe(0);
  expect(fs.readFileSync(target, "utf8")).toBe(before);
  fs.appendFileSync(target, "tampered");
  const failed = spawnSync(process.execPath, command, {cwd:project,env,encoding:"utf8"});
  expect(failed.status).not.toBe(0);
  expect(failed.stderr).toContain("快照校验失败");
});


test("reviewed snapshot remains byte-identical in an autocrlf checkout", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-crlf-")); dirs.push(dir);
  fs.copyFileSync(path.join(repo, ".gitattributes"), path.join(dir, ".gitattributes"));
  fs.cpSync(path.join(repo, "vendor/message-journal"), path.join(dir, "vendor/message-journal"), { recursive: true });
  const git = (args: string[]) => execFileSync("git", ["-c", "core.autocrlf=true", ...args], { cwd: dir, stdio: "pipe" });
  git(["init"]);
  git(["add", ".gitattributes", "vendor/message-journal"]);
  fs.rmSync(path.join(dir, "vendor"), { recursive: true });
  git(["checkout-index", "--all", "--force"]);
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(repo, "scripts/sync-message-journal.mjs"), path.join(dir, "scripts/sync-message-journal.mjs"));
  const result = spawnSync(process.execPath, [path.join(dir, "scripts/sync-message-journal.mjs"), "--check"], { cwd: dir, encoding: "utf8" });
  expect(result.stderr).toContain("已校验");
  expect(result.status).toBe(0);
});

import { expect, test } from "bun:test";
import { readCodexComposerDraft, NativeComposerDraftRevisions } from "../../src/bridge/native-composer-draft.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("opaque draft generations survive restart, but identical text after clearing is a new draft", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-draft-generations-"));
  const file = path.join(dir, "revisions.json");
  const raw = { supported: true, draft: { text: "private fixture", revision: "a".repeat(64) } };
  try {
    let revisions = new NativeComposerDraftRevisions(file);
    const first = revisions.track("a", raw).draft!.revision;
    revisions.track("b", raw);
    expect(revisions.track("a", raw).draft!.revision).toBe(first);
    revisions = new NativeComposerDraftRevisions(file);
    expect(revisions.track("a", raw).draft!.revision).toBe(first);
    revisions.track("a", { supported: false, draft: null });
    expect(revisions.track("a", raw).draft!.revision).toBe(first);
    revisions.track("a", { supported: true, draft: null });
    revisions = new NativeComposerDraftRevisions(file);
    expect(revisions.track("a", raw).draft!.revision).not.toBe(first);
    expect(fs.readFileSync(file, "utf8")).not.toContain("private fixture");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function state(entries: Record<string, unknown>, legacy?: Record<string, unknown>) {
  return { "electron-persisted-atom-state": {
    "composer-prompt-drafts-v2": entries,
    ...(legacy ? { "composer-prompt-drafts-v1": legacy } : {}),
  } };
}

test("Codex draft preserves all whitespace and resolves only the exact local task", () => {
  const text = "  第一段\n\n第二段  \n";
  const first = readCodexComposerDraft(state({ "local:task-a": text, "local:task-b": "other" }), "task-a");
  expect(first).toMatchObject({ supported: true, draft: { text } });
  expect(first.draft?.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(readCodexComposerDraft(state({ "local:task-a": text }), "task-b").draft).toBeNull();
  expect(readCodexComposerDraft(state({ "remote:task-a": text }), "task-a").draft).toBeNull();
  expect(readCodexComposerDraft(state({ "local:task-a": text, "local:task-b": "updated" }), "task-a").draft?.revision)
    .toBe(first.draft?.revision);
});

test("modern empty store is authoritative; sent drafts cannot return from legacy", () => {
  expect(readCodexComposerDraft(state({}, { "local:task-a": "already sent" }), "task-a"))
    .toEqual({ supported: true, draft: null });
  expect(readCodexComposerDraft({ "electron-persisted-atom-state": { "composer-prompt-drafts-v1": { "local:task-a": "legacy" } } }, "task-a").draft?.text)
    .toBe("legacy");
  expect(readCodexComposerDraft(null, "task-a").supported).toBe(false);
  expect(readCodexComposerDraft({ "electron-persisted-atom-state": {
    "composer-prompt-drafts-v2": null, "composer-prompt-drafts-v1": { "local:task-a": "stale" },
  } }, "task-a").draft).toBeNull();
});

test("Codex supports native draft wrappers and safe rich text without truncation", () => {
  const long = "字".repeat(25_000);
  expect(readCodexComposerDraft(state({ "local:a": { draft: { prompt: long } } }), "a").draft?.text).toBe(long);
  const document = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "  第一段" }, { type: "hardBreak" }, { type: "text", text: "下一行  " }] },
    { type: "paragraph" }, { type: "paragraph", content: [{ type: "text", text: "结尾" }] },
  ] };
  expect(readCodexComposerDraft(state({ "local:a": { prompt: { document, plainTextMode: true } } }), "a").draft?.text)
    .toBe("  第一段\n下一行  \n\n结尾");
  expect(readCodexComposerDraft(state({ "local:a": { prompt: { document: { type: "unknown" } } } }), "a").supported).toBe(false);
});

test("native non-text context cannot be silently discarded during a text draft import", () => {
  expect(readCodexComposerDraft(state({ "local:a": { prompt: "text", images: ["fixture.png"] } }), "a").supported).toBe(false);
  expect(readCodexComposerDraft(state({ "local:a": { prompt: "review", primaryReviewFor: "fixture-pr" } }), "a").supported).toBe(false);
  expect(readCodexComposerDraft(state({ "local:a": { prompt: "text", pullRequestChecks: [], primaryReviewFor: null } }), "a").draft?.text).toBe("text");
});

test("Codex adapter reads native draft without desktop follow and rejects a sent or changed draft before dispatch", async () => {
  const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const { CodexPtyAdapter } = await import("../../src/bridge/bridge-adapters.codex.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"wr-cd-"));
  const stateFile=path.join(dir,"state.json");
  const adapter:any=new CodexPtyAdapter({kind:"codex",command:"must-not-spawn",cwd:dir,renderMode:"headless",codexTransport:"desktop",codexDesktopGlobalStateFile:stateFile});
  adapter.nativeComposerDraftRevisions = new NativeComposerDraftRevisions(path.join(dir, "revisions.json"));
  let sends=0;
  adapter.sendDesktopTurnToThread=async(id:string,text:string)=>{expect(id).toBe("a");expect(text).toBe("edited");sends++;return {turnId:"one"};};
  try {
    fs.writeFileSync(stateFile,JSON.stringify(state({"local:a":"  original\n"})));
    const draft=await adapter.getSessionComposerDraft("a");
    expect(draft.draft.text).toBe("  original\n");
    expect(adapter.desktopIpcClient).toBeNull();
    await adapter.sendInputToSession("a","edited",{composerDraftRevision:draft.draft.revision,clientId:"once"});
    expect(sends).toBe(1);
    fs.writeFileSync(stateFile,JSON.stringify(state({})));
    expect((await adapter.getSessionComposerDraft("a")).draft).toBeNull();
    await expect(adapter.sendInputToSession("a","stale",{composerDraftRevision:draft.draft.revision})).rejects.toThrow("本条未发送");
    expect(sends).toBe(1);
  } finally { await adapter.dispose();fs.rmSync(dir,{recursive:true,force:true}); }
});

import { expect, test } from "bun:test";
import fs from "node:fs";
import { readProcessSnapshot } from "../../src/daemon/process-snapshot.ts";
import { detectOpenMobileAdaptersFromProcessList } from "../../src/daemon/werelay-daemon.ts";

test("a transient failed probe retries instead of inventing an empty running-terminal set", async () => {
  let calls = 0;
  const text = await readProcessSnapshot(async () => {
    if (++calls === 1) throw new Error("timeout");
    return "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop";
  });
  expect(calls).toBe(2);
  expect(detectOpenMobileAdaptersFromProcessList(text).has("deepseek")).toBe(true);
});
test("persistent probe failure is not a successful empty discovery", async () => {
  let calls = 0;
  await expect(readProcessSnapshot(async () => { calls++; throw new Error("timeout"); })).rejects.toThrow("终端");
  expect(calls).toBe(2);
});
test("a real empty process snapshot is accepted without unnecessary retries", async () => {
  let calls = 0;
  expect(await readProcessSnapshot(async () => { calls++; return ""; })).toBe("");
  expect(calls).toBe(1);
});
test("terminal switching refreshes status before rendering and never reuses an indefinitely old task snapshot", () => {
  const source = fs.readFileSync("src/daemon/werelay-daemon.ts", "utf8");
  expect(source.includes("getCachedSwitchedAdapterTaskCandidates")).toBe(false);
  expect(source.includes("refreshSwitchedAdapterTaskListInBackground")).toBe(false);
});

test("cold discovery includes DSH before numbering, and filtering refreshes busy status without renumbering", async () => {
  const { buildGlobalTaskSnapshot, updateGlobalTaskSnapshot, paginateGlobalTaskSnapshot } = await import("../../src/daemon/global-task-index.ts");
  const { mergeSessionRuntimeSignals } = await import("../../src/daemon/global-task-catalog.ts");
  let calls = 0;
  const processList = await readProcessSnapshot(async () => {
    if (++calls === 1) throw new Error("temporary timeout");
    return "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop";
  });
  const open = detectOpenMobileAdaptersFromProcessList(processList, {codexDesktopOpen: true});
  expect([...open].sort()).toEqual(["codex", "deepseek"]);
  const snapshot = buildGlobalTaskSnapshot([
    {adapter:"codex",sessionId:"same",title:"较旧",lastUpdatedAt:"2026-09-15T00:00:00Z"},
    {adapter:"deepseek",sessionId:"same",title:"较新",lastUpdatedAt:"2026-09-17T00:00:00Z",runtimeStatus:{type:"idle"}},
  ]);
  const latest = mergeSessionRuntimeSignals([{sessionId:"same",title:"较新",lastUpdatedAt:"2026-09-17T00:01:00Z",runtimeStatus:{type:"active",activeFlags:[]}}]);
  const refreshed = updateGlobalTaskSnapshot({current:snapshot,latestCandidates:latest.map(x=>({...x,adapter:"deepseek" as const})),refresh:false});
  const page = paginateGlobalTaskSnapshot(refreshed,{adapter:"deepseek",startIndex:0,pageSize:10});
  expect(page.candidates[0]?.runtimeStatus?.type).toBe("active");
  expect(refreshed.numberByIdentity.get("deepseek\0same")).toBe(1);
  expect(refreshed.numberByIdentity.get("codex\0same")).toBe(2);
});

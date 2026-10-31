import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageRecords, messageRecordProject } from "../../src/daemon/message-records.ts";

const base = { source: "web" as const, adapter: "codex", threadId: "a", text: "合成项目消息", status: "delivered" as const, attempts: 1 };
test("project identity never merges same-name directories, and shared cwd can group across Agents", () => {
  const one = messageRecordProject("codex", { projectId: "native-a", projectName: "同名项目", cwd: "/synthetic/one/repo" });
  const two = messageRecordProject("pi", { projectName: "同名项目", cwd: "/synthetic/two/repo" });
  expect(one!.key).not.toBe(two!.key);
  expect(messageRecordProject("pi", { cwd: "/synthetic/one/repo/" })!.key).toBe(one!.key);
  expect(messageRecordProject("codex", { projectName: "仅名称" })).toBeUndefined();
  expect(messageRecordProject("codex", { projectId: "same" })!.key).not.toBe(messageRecordProject("pi", { projectId: "same" })!.key);
  expect(one!.key).not.toContain("/synthetic/");
});

test("project filters apply to full retained data before pagination, statistics and export; restart keeps attribution", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-project-records-"));
  try {
    const stateFile = path.join(dir, "records.jsonl");
    const project = messageRecordProject("codex", { cwd: "/synthetic/a", projectName: "项目甲" })!;
    const projects = new Map([["codex:a", project], ["pi:b", project]]);
    const store = new MessageRecords({ stateFile, resolveProject: (adapter, thread) => projects.get(adapter + ":" + thread) });
    for (let i = 0; i < 35; i++) store.record({ ...base, key: "a" + i });
    store.record({ ...base, key: "pi", source: "clawbot", adapter: "pi", threadId: "b" });
    store.record({ ...base, key: "unknown", threadId: "missing" });
    expect(store.query({ project: project.key, limit: 10, offset: 30 }).records).toHaveLength(6);
    expect(store.query({ project: project.key }).stats).toMatchObject({ messages: 36, web: 35, clawbot: 1 });
    expect(store.export({ project: project.key }).records).toHaveLength(36);
    expect(store.query({ project: "unassigned" }).total).toBe(1);
    expect(store.query({ project: "unknown-project" }).total).toBe(0);
    expect(store.query({}).projects).toContainEqual({ key: project.key, label: "项目甲", count: 36 });
    expect(new MessageRecords({ stateFile }).query({ project: project.key }).total).toBe(36);
    expect(fs.readFileSync(stateFile, "utf8")).not.toContain("/synthetic/");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("old snapshots can use known metadata without connecting Agents or changing stored text", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-project-history-"));
  try {
    const stateFile = path.join(dir, "records.jsonl");
    new MessageRecords({ stateFile }).record({ ...base, key: "old" });
    const project = messageRecordProject("codex", { projectId: "p", projectName: "历史项目" })!;
    const store = new MessageRecords({ stateFile, resolveProject: () => project });
    expect(store.query({ project: project.key }).total).toBe(1);
    expect(store.query({ source: "clawbot" }).projects).toEqual([]);
    expect(store.query({}).records[0]!.projectName).toBe("历史项目");
    expect(new MessageRecords({ stateFile }).query({ project: project.key }).total).toBe(1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("daemon project resolver uses adapter-scoped cached task identities only", () => {
  const source = fs.readFileSync(new URL("../../src/daemon/werelay-daemon.ts", import.meta.url), "utf8");
  const start = source.indexOf("resolveProject: (adapter, threadId) => {");
  const end = source.indexOf("\n    } });", start);
  const fn = source.slice(start + "resolveProject: ".length, end) + "\n}";
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`function harness() { return ${fn}; }`);
  const resolver = new Function("messageRecordProject", js + ";return harness;")(messageRecordProject).call({
    slots: new Map([["pi", { taskCandidatesCache: [{ sessionId: "same", projectName: "pi项目", cwd: "/synthetic/pi" }] }]]),
    globalTaskListSnapshot: { candidates: [{ adapter: "codex", sessionId: "same", projectId: "native", projectName: "Codex项目" }] },
    globalTaskCatalogCache: { read: () => [] },
  });
  expect(resolver("pi", "same").label).toBe("pi项目");
  expect(resolver("codex", "same").label).toBe("Codex项目");
  expect(resolver("grok", "same")).toBeUndefined();
});

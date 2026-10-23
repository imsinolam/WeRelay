import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { mapCodexDesktopThreadListResponse, readCodexStateDbSessionCatalogInProcess } from "../../src/bridge/bridge-adapters.codex.ts";

async function removeTempDirectory(directory: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
      if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

test("native Codex lists filter Guardian and spawned children before applying the visible limit", () => {
  const candidates = mapCodexDesktopThreadListResponse({ data: [
    { id: "guardian", source: { subagent: { other: "guardian" } }, parent_thread_id: "main" },
    { id: "worker", source: { subagent: { thread_spawn: { parent_thread_id: "main" } } } },
    { id: "legacy", source: "subagent" },
    { id: "parent-only", parent_thread_id: "main" },
    { id: "main", name: "Guardian review", source: "vscode" },
  ] }, 1);
  expect(candidates.map((item) => item.sessionId)).toEqual(["main"]);
});

test("SQLite and rollout metadata cover Guardian other, thread_spawn, parent-only and legacy origins without starving main tasks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-origin-"));
  const databasePath = path.join(dir, "state.sqlite");
  const db = new Database(databasePath);
  try {
    db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, source TEXT, thread_source TEXT, title TEXT, updated_at_ms INTEGER, parent_thread_id TEXT)");
    const rows = [
      { id: "guardian", source: JSON.stringify({ subagent: { other: "guardian" } }), parent_thread_id: "main" },
      { id: "spawn", source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "main" } } }) },
      { id: "legacy", source: "subagent" },
      { id: "rollout-only", source: "vscode", metadata: { source: { subagent: { other: "guardian" } }, parent_thread_id: "main" } },
      { id: "parent-only", source: "cli", parent_thread_id: "main" },
      { id: "main", source: "vscode" },
    ];
    rows.forEach((row, index) => {
      const file = path.join(dir, `${row.id}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: row.id, source: row.source, ...row.metadata } }) + "\n");
      db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)").run(row.id, file, row.source, "vscode", "Guardian review", 10_000 - index, row.parent_thread_id ?? null);
    });
    const catalog = await readCodexStateDbSessionCatalogInProcess({ databasePath, catalogDatabasePath: path.join(dir, "missing.sqlite"), limit: 1 });
    expect(catalog?.candidates.map((item) => item.sessionId)).toEqual(["main"]);
    expect([...catalog!.rolloutPathByThreadId.keys()]).toEqual(["main"]);
    const approvalCatalog = await readCodexStateDbSessionCatalogInProcess({ databasePath, catalogDatabasePath: path.join(dir, "missing.sqlite"), limit: 10, includeInternal: true });
    expect(approvalCatalog?.candidates).toHaveLength(6);
    expect(approvalCatalog?.candidates.find((item) => item.sessionId === "guardian")).toMatchObject({ source: "subagent", parentThreadId: "main" });
    expect(approvalCatalog?.candidates.find((item) => item.sessionId === "rollout-only")).toMatchObject({ source: "subagent", parentThreadId: "main" });
  } finally {
    db.close();
    // Windows can release the SQLite handle shortly after close().
    await removeTempDirectory(dir);
  }
});

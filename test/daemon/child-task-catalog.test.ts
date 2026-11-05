import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listChildTaskCandidates, listLightweightAdapterSessions, readGlobalTaskNotificationMetadata } from "../../src/daemon/global-task-catalog.ts";

test("Codex children use a targeted read, never a truncated top-level task list", async () => {
  let options: unknown;
  const children = await listChildTaskCandidates("codex", "/fixture", "main", 20, {
    listCodexSessions: async (input: unknown) => {
      options = input;
      return { candidates: [
        { sessionId: "child", title: "child", parentThreadId: "main", lastUpdatedAt: "2026-11-04T00:00:00Z" },
        { sessionId: "unrelated", title: "unrelated", parentThreadId: "another", lastUpdatedAt: "2026-11-04T00:00:00Z" },
      ] };
    },
  });
  expect(options).toMatchObject({ parentThreadId: "main", includeInternal: true, limit: 20 });
  expect(children.map(item => item.sessionId)).toEqual(["child"]);
});

test("an unavailable native catalog remains retryable instead of hiding existing child links", async () => {
  await expect(listChildTaskCandidates("codex", "/fixture", "main", 20, {
    listCodexSessions: async () => null,
  })).rejects.toThrow("暂时无法读取");
  expect(await listChildTaskCandidates("codex", "/fixture", "main", 0)).toEqual([]);
});

test("Harness child reads retain the same owner and use a bounded read-only catalog", async () => {
  let received: unknown;
  const children = await listChildTaskCandidates("deepseek", "/fixture", "main", 20, {
    listDeepSeekSessions: async (_limit: number, _url: unknown, options: unknown) => {
      received = options;
      return [{ sessionId: "child", title: "child", parentThreadId: "main", lastUpdatedAt: "2026-11-04T00:00:00Z" }];
    },
  });
  expect(received).toMatchObject({ parentThreadId: "main", timeoutMs: 2000 });
  expect(children).toHaveLength(1);
  expect(await listChildTaskCandidates("pi", "/fixture", "main")).toEqual([]);
});

test("OpenCode child reads use native parentID without reintroducing children to normal lists", async () => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-child-catalog-"));
  const previous = process.env.OPENCODE_STORAGE_DIR;
  process.env.OPENCODE_STORAGE_DIR = storage;
  try {
    const dir = path.join(storage, "session", "global");
    fs.mkdirSync(dir, { recursive: true });
    for (const [id, parentID, updated] of [["main", undefined, 1], ["child", "main", 2], ["other", "another", 3]] as const) {
      fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify({ id, parentID, title: id, projectID: "global", directory: "/fixture", time: { created: 1, updated } }));
    }
    const children = await listChildTaskCandidates("opencode", "/fixture", "main", 1);
    expect(children).toMatchObject([{ sessionId: "child", parentThreadId: "main" }]);
    expect((await listLightweightAdapterSessions("opencode", "/fixture", 1)).map((item) => item.sessionId)).toEqual(["main"]);
    expect(await readGlobalTaskNotificationMetadata("opencode", "child")).toEqual({ parentThreadId: "main" });
    expect(await readGlobalTaskNotificationMetadata("opencode", "other")).toEqual({ parentThreadId: "another" });
    expect(await readGlobalTaskNotificationMetadata("opencode", "main")).toEqual({});
    expect(await readGlobalTaskNotificationMetadata("opencode", "absent")).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_STORAGE_DIR; else process.env.OPENCODE_STORAGE_DIR = previous;
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

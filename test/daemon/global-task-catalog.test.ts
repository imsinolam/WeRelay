import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  listLightweightAdapterSessions,
  mergeSessionRuntimeSignals,
} from "../../src/daemon/global-task-catalog.ts";

const previousOpenCodeStorageDir = process.env.OPENCODE_STORAGE_DIR;
const tempDirectories: string[] = [];

afterEach(() => {
  if (previousOpenCodeStorageDir === undefined) delete process.env.OPENCODE_STORAGE_DIR;
  else process.env.OPENCODE_STORAGE_DIR = previousOpenCodeStorageDir;
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("global task catalog runtime signals", () => {

  test("bounds background DeepSeek catalog reads without changing normal Harness timeouts", async () => {
    let receivedTimeoutMs = 0;
    const candidates = await listLightweightAdapterSessions(
      "deepseek",
      "/tmp/project",
      100,
      {
        listDeepSeekSessions: async (_limit, _baseUrl, options) => {
          receivedTimeoutMs = options.timeoutMs ?? 0;
          return [];
        },
      },
    );

    expect(candidates).toEqual([]);
    expect(receivedTimeoutMs).toBe(2_000);
  });

  test("keeps lightweight OpenCode tasks projectless instead of grouping by native project id", async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-opencode-catalog-"));
    tempDirectories.push(storage);
    process.env.OPENCODE_STORAGE_DIR = storage;
    const sessionDir = path.join(storage, "session", "global");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "session.json"), JSON.stringify({
      id: "session",
      projectID: "global",
      directory: "/repo/opencode",
      title: "OpenCode 任务",
      version: "1",
      time: { created: 1, updated: 2 },
    }));

    const [candidate] = await listLightweightAdapterSessions(
      "opencode",
      "/repo/opencode",
      10,
    );

    expect(candidate).toMatchObject({
      sessionId: "session",
      title: "OpenCode 任务",
      cwd: "/repo/opencode",
    });
    expect(candidate?.projectId).toBeUndefined();
    expect(candidate?.projectName).toBeUndefined();
  });

  test("merges live slot approval signals into a freshly discovered Harness catalog", () => {
    const candidates = mergeSessionRuntimeSignals([
      {
        sessionId: "desktop-session",
        threadId: "desktop-session",
        title: "US中转服务器",
        lastUpdatedAt: "2026-08-19T02:00:00.000Z",
      },
      {
        sessionId: "other-session",
        threadId: "other-session",
        title: "其他任务",
        lastUpdatedAt: "2026-08-19T01:00:00.000Z",
      },
    ], {
      pendingApprovalIds: ["desktop-session"],
    });

    expect(candidates[0]?.runtimeStatus).toEqual({
      type: "active",
      activeFlags: ["waitingOnApproval"],
    });
    expect(candidates[1]?.runtimeStatus).toEqual({ type: "idle" });
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  listLightweightAdapterSessions,
  mergeSessionRuntimeSignals,
} from "../../src/daemon/global-task-catalog.ts";
import { buildGlobalTaskSnapshot, formatGlobalTaskList } from "../../src/daemon/global-task-index.ts";

const previousOpenCodeStorageDir = process.env.OPENCODE_STORAGE_DIR;
const tempDirectories: string[] = [];

afterEach(() => {
  if (previousOpenCodeStorageDir === undefined) delete process.env.OPENCODE_STORAGE_DIR;
  else process.env.OPENCODE_STORAGE_DIR = previousOpenCodeStorageDir;
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("busy overlay preserves existing approval and user-input flags", () => {
  const candidates = mergeSessionRuntimeSignals([{
    sessionId: "running",
    title: "任务",
    runtimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] },
  }], { activeSessionIds: ["running"], pendingUserInputIds: ["running"] });
  expect(candidates[0]?.runtimeStatus).toEqual({
    type: "active", activeFlags: ["waitingOnApproval", "waitingOnUserInput"],
  });
});

describe("global task catalog runtime signals", () => {

  test("unconnected Codex catalog reads live status for the WeChat processing marker", async () => {
    let inferredStatuses = false;
    const candidates = await listLightweightAdapterSessions("codex", "/repo/WeRelay", 10, {
      listCodexSessions: async (options) => {
        inferredStatuses = options.inferRuntimeStatuses === true;
        return { candidates: [{
          sessionId: "running",
          title: "正在执行的任务",
          lastUpdatedAt: "2026-09-24T12:00:00Z",
          runtimeStatus: options.inferRuntimeStatuses
            ? { type: "active", activeFlags: [] }
            : { type: "notLoaded" },
        }, {
          sessionId: "idle",
          title: "已完成的任务",
          lastUpdatedAt: "2026-09-24T11:00:00Z",
          runtimeStatus: { type: "idle" },
        }] };
      },
      readCodexGlobalState: () => ({}),
    });
    const text = formatGlobalTaskList({
      snapshot: buildGlobalTaskSnapshot(candidates.map((candidate) => ({ ...candidate, adapter: "codex" }))),
      startIndex: 0,
      pageSize: 10,
    });
    expect(inferredStatuses).toBe(true);
    expect(text).toContain("正在执行的任务 · 处理中 🟢");
    expect(text).toContain("已完成的任务");
    expect(text).not.toContain("已完成的任务 · 处理中 🟢");
  });

  test("lightweight Codex directory includes real desktop project names", async () => {
    const candidates = await listLightweightAdapterSessions("codex", "/repo/WeRelay", 10, {
      listCodexSessions: async () => ({ candidates: [
        { sessionId: "assigned", title: "项目任务", cwd: "/repo/WeRelay" },
        { sessionId: "projectless", title: "无项目任务", cwd: "/tmp/Codex/2026-09-24/work" },
        { sessionId: "unknown-project", title: "待映射任务", projectId: "canonical-id" },
      ] }),
      readCodexGlobalState: () => ({
        "local-projects": {
          project: { name: "WeRelay", rootPaths: ["/repo/WeRelay"] },
        },
        "projectless-thread-ids": ["projectless"],
      }),
    });
    expect(candidates[0]?.projectName).toBe("WeRelay");
    expect(candidates[1]?.projectName).toBeUndefined();
    expect(candidates[2]?.projectId).toBe("canonical-id");
  });

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

  test("OpenCode ID placeholder uses the latest user message, not a later AI reply", async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-opencode-catalog-"));
    tempDirectories.push(storage);
    process.env.OPENCODE_STORAGE_DIR = storage;
    const id = "01a0d152-0000-0000-0000-000000000000";
    const sessionDir = path.join(storage, "session", "global");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "session.json"), JSON.stringify({
      id, projectID: "global", directory: "/repo/opencode",
      title: `会话 ${id.slice(0, 8)}`, version: "1", time: { created: 1, updated: 2 },
    }));
    for (const [index, text] of ["前一条消息", "请检查 OpenCode 最近任务的标题显示"].entries()) {
      const messageId = `m${index}`;
      fs.mkdirSync(path.join(storage, "message", id), { recursive: true });
      fs.mkdirSync(path.join(storage, "part", messageId), { recursive: true });
      fs.writeFileSync(path.join(storage, "message", id, `${messageId}.json`), JSON.stringify({
        id: messageId, role: "user", time: { created: index + 1 },
      }));
      fs.writeFileSync(path.join(storage, "part", messageId, "part.json"), JSON.stringify({
        id: `p${index}`, type: "text", text,
      }));
    }
    const assistantId = "m2";
    fs.mkdirSync(path.join(storage, "part", assistantId));
    fs.writeFileSync(path.join(storage, "message", id, `${assistantId}.json`), JSON.stringify({
      id: assistantId, role: "assistant", time: { created: 3 },
    }));
    fs.writeFileSync(path.join(storage, "part", assistantId, "part.json"), JSON.stringify({
      id: "p2", type: "text", text: "**已经分析完成**",
    }));
    const [candidate] = await listLightweightAdapterSessions("opencode", "/repo/opencode", 10);
    expect(candidate?.title).toBe("请检查 OpenCode 最近任务的标题");
    expect(candidate?.projectId).toBeUndefined();
  });

  test("merges the selected live slot and active task ids into a lightweight catalog", () => {
    const candidates = mergeSessionRuntimeSignals([
      {
        sessionId: "selected-session",
        title: "当前任务",
        lastUpdatedAt: "2026-09-12T07:00:00.000Z",
        runtimeStatus: { type: "notLoaded" },
      },
      {
        sessionId: "background-session",
        title: "后台任务",
        lastUpdatedAt: "2026-09-12T06:00:00.000Z",
      },
    ], {
      activeSessionIds: ["selected-session", "background-session"],
    });

    expect(candidates.map((candidate) => candidate.runtimeStatus)).toEqual([
      { type: "active", activeFlags: [] },
      { type: "active", activeFlags: [] },
    ]);
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

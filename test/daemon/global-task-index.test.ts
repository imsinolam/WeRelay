import { describe, expect, test } from "bun:test";

import {
  activateGlobalTaskCandidate,
  buildGlobalTaskSnapshot,
  formatGlobalTaskList,
  globalTaskIdentityKey,
  paginateGlobalTaskSnapshot,
  resolveCompactGlobalTaskSearchTarget,
  resolveGlobalTaskCandidate,
  resolveGlobalTaskTargetedMessage,
  shouldShowGlobalTaskAdapterLabels,
  selectRunningGlobalTaskAdapters,
  updateGlobalTaskSnapshot,
  type GlobalTaskCandidate,
} from "../../src/daemon/global-task-index.ts";

function candidate(
  adapter: GlobalTaskCandidate["adapter"],
  sessionId: string,
  title: string,
  lastUpdatedAt: string,
): GlobalTaskCandidate {
  return { adapter, sessionId, threadId: sessionId, title, lastUpdatedAt };
}

describe("global task index", () => {
  test("limits the ClawBot aggregate to terminals that are connected or visibly running", () => {
    expect(selectRunningGlobalTaskAdapters({
      connectedAdapters: ["deepseek", "codex"],
      openAdapters: ["workbuddy", "codebuddy", "deepseek"],
    })).toEqual(["codex", "codebuddy", "workbuddy", "deepseek"]);
  });

  test("sorts strictly by lastUpdatedAt even when an older task is still running", () => {
    const activeDeepSeek = candidate(
      "deepseek",
      "deepseek-active",
      "US中转服务器",
      "2026-08-08T08:00:00.000Z",
    );
    activeDeepSeek.runtimeStatus = { type: "active", activeFlags: [] };
    const snapshot = buildGlobalTaskSnapshot([
      candidate("deepseek", "deepseek-idle", "DeepSeek 最近已完成", "2026-08-08T10:00:00.000Z"),
      activeDeepSeek,
      candidate("codex", "codex-1", "Codex 任务", "2026-08-08T09:00:00.000Z"),
    ]);

    expect(snapshot.candidates.map((item) => item.sessionId)).toEqual([
      "deepseek-idle",
      "codex-1",
      "deepseek-active",
    ]);
  });

  test("fills the default page strictly by recency without reserving a slot per terminal", () => {
    const candidates = [
      ...Array.from({ length: 12 }, (_, index) => candidate(
        "codex",
        `codex-${index}`,
        `Codex ${index}`,
        new Date(Date.parse("2026-08-08T12:00:00.000Z") - index * 1_000).toISOString(),
      )),
      candidate("deepseek", "deepseek-1", "DeepSeek 最近任务", "2026-08-08T08:00:00.000Z"),
      candidate("workbuddy", "workbuddy-1", "WorkBuddy 最近任务", "2026-08-08T07:00:00.000Z"),
    ];

    const snapshot = buildGlobalTaskSnapshot(candidates);
    const firstPage = paginateGlobalTaskSnapshot(snapshot, { startIndex: 0, pageSize: 10 });

    expect(firstPage.candidates.map((entry) => entry.adapter)).toEqual(
      Array.from({ length: 10 }, () => "codex"),
    );
    expect(snapshot.numberByIdentity.get(globalTaskIdentityKey("deepseek", "deepseek-1"))).toBe(13);
    expect(snapshot.numberByIdentity.get(globalTaskIdentityKey("workbuddy", "workbuddy-1"))).toBe(14);
  });

  test("sorts all adapters by lastUpdatedAt and shows terminal labels", () => {
    const snapshot = buildGlobalTaskSnapshot([
      candidate("claude", "claude-1", "Claude 较旧任务", "2026-08-08T08:00:00.000Z"),
      candidate("codex", "codex-1", "Codex 最新任务", "2026-08-08T10:00:00.000Z"),
      candidate("workbuddy", "wb-1", "WorkBuddy 中间任务", "2026-08-08T09:00:00.000Z"),
    ]);

    expect(snapshot.candidates.map((entry) => `${entry.adapter}:${entry.sessionId}`)).toEqual([
      "codex:codex-1",
      "workbuddy:wb-1",
      "claude:claude-1",
    ]);
    const output = formatGlobalTaskList({ snapshot, startIndex: 0, pageSize: 10 });
    expect(output).toContain("运行终端最近任务");
    expect(output).toContain("全部按最近更新时间排序");
    expect(output).not.toContain("每个运行终端优先显示最近一条");
    expect(output).not.toContain("────────");
    expect(output).toContain("1. [Codex] Codex 最新任务");
    expect(output).toContain("2. [WorkBuddy] WorkBuddy 中间任务");
    expect(output).toContain("3. [Claude Code] Claude 较旧任务");
  });


  test("uses an emoji for a running task marker", () => {
    const running = candidate(
      "codex",
      "running-1",
      "正在执行的任务",
      "2026-08-08T10:00:00.000Z",
    );
    running.runtimeStatus = { type: "active", activeFlags: [] };

    const output = formatGlobalTaskList({
      snapshot: buildGlobalTaskSnapshot([running]),
      startIndex: 0,
      pageSize: 10,
    });

    expect(output).toContain("1. 正在执行的任务　🟢");
    expect(output).not.toContain("正在执行的任务　运行中");
  });

  test("hides terminal labels on a single-adapter page", () => {
    const snapshot = buildGlobalTaskSnapshot([
      candidate("codex", "c1", "任务一", "2026-08-08T10:00:00.000Z"),
      candidate("codex", "c2", "任务二", "2026-08-08T09:00:00.000Z"),
    ]);
    const page = paginateGlobalTaskSnapshot(snapshot, { startIndex: 0, pageSize: 10 });

    expect(shouldShowGlobalTaskAdapterLabels(page.candidates)).toBe(false);
    const output = formatGlobalTaskList({ snapshot, startIndex: 0, pageSize: 10 });
    expect(output).toContain("1. 任务一");
    expect(output).toContain("2. 任务二");
    expect(output).not.toContain("[Codex]");
  });

  test("shows terminal labels for every item on a mixed-adapter page", () => {
    const snapshot = buildGlobalTaskSnapshot([
      candidate("codex", "c1", "Codex 任务", "2026-08-08T10:00:00.000Z"),
      candidate("claude", "a1", "Claude 任务", "2026-08-08T09:00:00.000Z"),
    ]);
    const page = paginateGlobalTaskSnapshot(snapshot, { startIndex: 0, pageSize: 10 });

    expect(shouldShowGlobalTaskAdapterLabels(page.candidates)).toBe(true);
    const output = formatGlobalTaskList({ snapshot, startIndex: 0, pageSize: 10 });
    expect(output).toContain("1. [Codex] Codex 任务");
    expect(output).toContain("2. [Claude Code] Claude 任务");
    expect(output).not.toContain("────────");
  });

  test("recomputes terminal-label visibility after crossing a page boundary", () => {
    const snapshot = buildGlobalTaskSnapshot([
      candidate("codex", "c1", "第一页一", "2026-08-08T10:00:00.000Z"),
      candidate("codex", "c2", "第一页二", "2026-08-08T09:00:00.000Z"),
      candidate("codex", "c3", "第二页一", "2026-08-08T08:00:00.000Z"),
      candidate("workbuddy", "w1", "第二页二", "2026-08-08T07:00:00.000Z"),
    ]);

    expect(shouldShowGlobalTaskAdapterLabels(
      paginateGlobalTaskSnapshot(snapshot, { startIndex: 0, pageSize: 2 }).candidates,
    )).toBe(false);
    expect(shouldShowGlobalTaskAdapterLabels(
      paginateGlobalTaskSnapshot(snapshot, { startIndex: 2, pageSize: 2 }).candidates,
    )).toBe(true);
    expect(formatGlobalTaskList({ snapshot, startIndex: 0, pageSize: 2 })).not.toContain("[Codex]");
    const secondPage = formatGlobalTaskList({ snapshot, startIndex: 2, pageSize: 2 });
    expect(secondPage).toContain("3. [Codex] 第二页一");
    expect(secondPage).toContain("4. [WorkBuddy] 第二页二");
  });

  test("keeps identical session ids isolated by adapter", () => {
    const snapshot = buildGlobalTaskSnapshot([
      candidate("codex", "same-id", "Codex 任务", "2026-08-08T10:00:00.000Z"),
      candidate("grok", "same-id", "Grok 任务", "2026-08-08T09:00:00.000Z"),
    ]);

    expect(snapshot.numberByIdentity.get(globalTaskIdentityKey("codex", "same-id"))).toBe(1);
    expect(snapshot.numberByIdentity.get(globalTaskIdentityKey("grok", "same-id"))).toBe(2);
    expect(resolveGlobalTaskCandidate(snapshot, "1")).toMatchObject({
      adapter: "codex",
      sessionId: "same-id",
    });
    expect(resolveGlobalTaskCandidate(snapshot, "2")).toMatchObject({
      adapter: "grok",
      sessionId: "same-id",
    });
  });

  test("keeps stable numbers until an explicit refresh", () => {
    const initial = buildGlobalTaskSnapshot([
      candidate("codex", "c1", "Codex", "2026-08-08T10:00:00.000Z"),
      candidate("claude", "a1", "Claude", "2026-08-08T09:00:00.000Z"),
    ]);
    const retained = updateGlobalTaskSnapshot({
      current: initial,
      refresh: false,
      latestCandidates: [
        candidate("claude", "a1", "Claude 已更新", "2026-08-08T11:00:00.000Z"),
        candidate("codex", "c1", "Codex", "2026-08-08T10:00:00.000Z"),
      ],
    });

    expect(retained.candidates.map((entry) => entry.adapter)).toEqual(["codex", "claude"]);
    expect(retained.candidates[1]?.title).toBe("Claude 已更新");

    const refreshed = updateGlobalTaskSnapshot({
      current: retained,
      refresh: true,
      latestCandidates: retained.candidates,
    });
    expect(refreshed.candidates.map((entry) => entry.adapter)).toEqual(["claude", "codex"]);
  });

  test("paginates the stable global snapshot without renumbering", () => {
    const snapshot = buildGlobalTaskSnapshot(Array.from({ length: 25 }, (_, index) => (
      candidate(
        index % 2 === 0 ? "codex" : "opencode",
        `s-${index + 1}`,
        `任务 ${index + 1}`,
        new Date(Date.UTC(2026, 7, 8, 12, 0, 25 - index)).toISOString(),
      )
    )));
    const page = paginateGlobalTaskSnapshot(snapshot, { startIndex: 10, pageSize: 10 });

    expect(page.candidates).toHaveLength(10);
    expect(page.startIndex).toBe(10);
    expect(page.hasPrevious).toBe(true);
    expect(page.hasMore).toBe(true);
    expect(formatGlobalTaskList({ snapshot, startIndex: 10, pageSize: 10 })).toContain(
      "11. [Codex] 任务 11",
    );
  });

  test("supports compact 任务关键词 only when the global catalog has a matching task", () => {
    const snapshot = buildGlobalTaskSnapshot([
      candidate("workbuddy", "w1", "Skillwestock 数据工具合作伙伴", "2026-08-08T10:00:00.000Z"),
      candidate("codex", "c1", "wechat_canvas 页面模板", "2026-08-08T09:00:00.000Z"),
    ]);

    expect(resolveCompactGlobalTaskSearchTarget("任务canvas", snapshot)).toBe("canvas");
    expect(resolveCompactGlobalTaskSearchTarget("任务Skillwestock", snapshot)).toBe("Skillwestock");
    expect(resolveCompactGlobalTaskSearchTarget("任务做完后告诉我", snapshot)).toBeNull();
  });

  test("routes 数字：内容 and 任务数字：内容 by adapter plus session id from the global snapshot", () => {
    const snapshot = buildGlobalTaskSnapshot([
      candidate("codex", "same-id", "Codex", "2026-08-08T10:00:00.000Z"),
      candidate("workbuddy", "same-id", "WorkBuddy", "2026-08-08T09:00:00.000Z"),
    ]);

    for (const text of ["2 ： 继续处理", "任务2:继续处理", "任务 2 ： 继续处理"]) {
      expect(resolveGlobalTaskTargetedMessage({ text, snapshot })).toEqual({
        candidate: snapshot.candidates[1],
        text: "继续处理",
      });
    }
  });

  test("restores the exact disconnected adapter task and never falls back", async () => {
    const target = candidate("tclaude", "target-session", "目标任务", "2026-08-08T10:00:00.000Z");
    const calls: string[] = [];
    const slot = { id: "tclaude-slot" };

    const result = await activateGlobalTaskCandidate(target, {
      getConnectedAdapter: () => null,
      connectAdapter: async (adapter) => {
        calls.push(`connect:${adapter}`);
        return slot;
      },
      resumeSession: async (connected, sessionId) => {
        calls.push(`resume:${connected.id}:${sessionId}`);
      },
    });

    expect(result).toBe(slot);
    expect(calls).toEqual([
      "connect:tclaude",
      "resume:tclaude-slot:target-session",
    ]);
  });

  test("reports recovery failure without resuming or creating another task", async () => {
    const target = candidate("reasonix", "missing-session", "原任务", "2026-08-08T10:00:00.000Z");
    let resumeCalls = 0;

    await expect(activateGlobalTaskCandidate(target, {
      getConnectedAdapter: () => null,
      connectAdapter: async () => {
        throw new Error("reasonix 未登录");
      },
      resumeSession: async () => {
        resumeCalls += 1;
      },
    })).rejects.toThrow("无法连接 reasonix，未切换任务，也没有新建替代任务");
    expect(resumeCalls).toBe(0);
  });
});

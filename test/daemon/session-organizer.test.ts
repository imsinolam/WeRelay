import { describe, expect, test } from "bun:test";

import {
  buildSessionOrganizerSnapshot,
  classifySession,
  getTitleQuality,
} from "../../src/daemon/session-organizer.ts";

const nowMs = Date.parse("2026-09-18T12:00:00.000Z");

function task(overrides: Record<string, unknown> = {}) {
  return {
    adapter: "codex",
    adapterLabel: "Codex",
    threadId: "thread-1",
    title: "实现移动端任务列表",
    projectId: "project-1",
    projectName: "WeRelay",
    cwd: "/Users/example/WeRelay",
    status: "idle" as const,
    lastUpdatedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("session organizer", () => {
  test("uses runtime state before recency to classify sessions", () => {
    expect(classifySession({ status: "running", lastUpdatedAt: "2020-01-01T00:00:00.000Z" }, nowMs)).toBe("active");
    expect(classifySession({ status: "approval", lastUpdatedAt: "2026-09-18T10:00:00.000Z" }, nowMs)).toBe("waiting");
    expect(classifySession({ status: "error", lastUpdatedAt: "2026-09-18T10:00:00.000Z" }, nowMs)).toBe("error");
    expect(classifySession({ status: "idle", lastUpdatedAt: "2026-08-01T10:00:00.000Z" }, nowMs)).toBe("stale");
  });

  test("marks generic titles as missing and gives normalized suggestions for slugs", () => {
    expect(getTitleQuality("new")).toBe("missing");
    expect(getTitleQuality("fix-mobile-messages")).toBe("needsReview");
    expect(getTitleQuality("修复移动端消息重复显示")).toBe("clear");
  });

  test("groups sessions by project and keeps deterministic section order", () => {
    const snapshot = buildSessionOrganizerSnapshot([
      task({ threadId: "stale", title: "old", lastUpdatedAt: "2026-01-01T00:00:00.000Z" }),
      task({ threadId: "waiting", title: "审批发布", status: "approval" }),
      task({ threadId: "active", title: "实现移动端任务列表", status: "running" }),
      task({
        threadId: "other-project",
        title: "new",
        projectId: "project-2",
        projectName: "Other",
        cwd: "/Users/example/Other",
        lastUpdatedAt: "2026-09-18T09:00:00.000Z",
      }),
    ], { nowMs });

    expect(snapshot.totals).toEqual({
      projects: 2,
      sessions: 4,
      needsReview: 3,
      active: 1,
      waiting: 1,
      stale: 1,
    });
    expect(snapshot.projects.map((project) => project.projectLabel)).toEqual([
      "WeRelay",
      "Other",
    ]);
    expect(snapshot.projects[0]?.sessions.map((session) => [session.threadId, session.section])).toEqual([
      ["active", "active"],
      ["waiting", "waiting"],
      ["stale", "stale"],
    ]);
    expect(snapshot.sessions.find((session) => session.threadId === "stale")?.renameSuggestion).toBeUndefined();
    expect(snapshot.sessions.find((session) => session.threadId === "other-project")?.renameReason).toContain("笼统");
  });
});

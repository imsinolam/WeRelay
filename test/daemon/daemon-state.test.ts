import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  DaemonWorkspaceStateStore,
  readDaemonWorkspaceState,
} from "../../src/daemon/daemon-state.ts";

describe("daemon workspace state", () => {
  test("persists the latest ClawBot task target across daemon restarts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-daemon-state-"));
    const stateFile = path.join(directory, "daemon-state.json");
    const cwd = path.join(directory, "workspace");

    try {
      const store = new DaemonWorkspaceStateStore(cwd, { stateFile });
      store.setLatestWechatTaskTarget({
        adapter: "workbuddy",
        sessionId: "session-b",
        title: "整理服务器列表",
        lastUpdatedAt: "2026-08-30T01:02:03.000Z",
      });

      const restored = new DaemonWorkspaceStateStore(cwd, { stateFile });
      expect(restored.getLatestWechatTaskTarget()).toEqual({
        adapter: "workbuddy",
        sessionId: "session-b",
        title: "整理服务器列表",
        lastUpdatedAt: "2026-08-30T01:02:03.000Z",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("persists recent adapter message activity and daily usage order", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-daemon-state-"));
    const stateFile = path.join(directory, "daemon-state.json");
    const cwd = path.join(directory, "workspace");
    const nowMs = Date.parse("2026-09-05T08:00:00.000Z");

    try {
      const store = new DaemonWorkspaceStateStore(cwd, { stateFile });
      store.recordAdapterMessageActivity({
        adapter: "grok",
        occurredAt: "2026-09-05T07:00:00.000Z",
        eventKey: "grok-turn-1",
      }, nowMs);
      store.recordAdapterMessageActivity({
        adapter: "grok",
        occurredAt: "2026-09-05T07:00:00.000Z",
        eventKey: "grok-turn-1",
      }, nowMs);
      store.recordAdapterMessageActivity({
        adapter: "codex",
        occurredAt: "2026-09-02T07:00:00.000Z",
        eventKey: "expired-codex-turn",
      }, nowMs);
      store.setAdapterUsageOrder({
        adapters: ["grok", "codex", "workbuddy"],
        updatedAt: "2026-09-05T08:00:00.000Z",
      });

      expect(store.getAdapterMessageActivities()).toEqual([{
        adapter: "grok",
        occurredAt: "2026-09-05T07:00:00.000Z",
        eventKey: "grok-turn-1",
      }]);
      expect(store.getAdapterUsageOrder()).toEqual({
        adapters: ["grok", "codex", "workbuddy"],
        updatedAt: "2026-09-05T08:00:00.000Z",
      });

      const restored = new DaemonWorkspaceStateStore(cwd, { stateFile });
      expect(restored.getAdapterMessageActivities()).toEqual(
        store.getAdapterMessageActivities(),
      );
      expect(restored.getAdapterUsageOrder()).toEqual(store.getAdapterUsageOrder());
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("persists task-scoped auto-approval across daemon restarts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-daemon-state-"));
    const stateFile = path.join(directory, "daemon-state.json");
    const cwd = path.join(directory, "workspace");

    try {
      const store = new DaemonWorkspaceStateStore(cwd, { stateFile });
      store.setTaskApprovalAutoApproveIdentities("codex", [{
        threadId: "thread-a",
        turnId: "turn-1",
      }]);
      store.setTaskApprovalAutoApproveIdentities("claude", [{
        threadId: "session-b",
        turnId: "turn-2",
      }]);

      const restored = new DaemonWorkspaceStateStore(cwd, { stateFile });
      expect(restored.getTaskApprovalAutoApproveIdentities("codex")).toEqual([{
        threadId: "thread-a",
      }]);
      expect(restored.getTaskApprovalAutoApproveIdentities("claude")).toEqual([{
        threadId: "session-b",
      }]);

      restored.setTaskApprovalAutoApproveIdentities("codex", []);
      expect(new DaemonWorkspaceStateStore(cwd, { stateFile })
        .getTaskApprovalAutoApproveIdentities("codex")).toEqual([]);
      expect(new DaemonWorkspaceStateStore(cwd, { stateFile })
        .getTaskApprovalAutoApproveIdentities("claude")).toEqual([{
          threadId: "session-b",
        }]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("persists pending and delivered Codex completion notifications", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-daemon-state-"));
    const stateFile = path.join(directory, "daemon-state.json");
    const cwd = path.join(directory, "workspace");
    // Keep this persistence fixture within retention regardless of the calendar date.
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const deliveredAt = new Date(Date.now() - 120_000).toISOString();

    try {
      const store = new DaemonWorkspaceStateStore(cwd, { stateFile });
      store.setCodexCompletionDeliveryState({
        pending: [
          {
            key: "thread:turn-pending",
            threadId: "thread",
            turnId: "turn-pending",
            texts: ["完成摘要", "链接"],
            nextTextIndex: 1,
            createdAt,
          },
        ],
        delivered: [
          {
            key: "thread:turn-delivered",
            deliveredAt,
          },
        ],
      });

      const restored = new DaemonWorkspaceStateStore(cwd, { stateFile });
      expect(restored.getCodexCompletionDeliveryState()).toEqual({
        pending: [
          {
            key: "thread:turn-pending",
            threadId: "thread",
            turnId: "turn-pending",
            texts: ["完成摘要", "链接"],
            nextTextIndex: 1,
            createdAt,
          },
        ],
        delivered: [
          {
            key: "thread:turn-delivered",
            deliveredAt,
          },
        ],
      });
      if (process.platform !== "win32") {
        expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("persists pending and delivered approval notifications", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-daemon-state-"));
    const stateFile = path.join(directory, "daemon-state.json");
    const cwd = path.join(directory, "workspace");
    // 审批通知同样有 30 天保留期，使用相对当前时间的时刻避免时间炸弹。
    const deliveredAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const pendingCreatedAt = new Date(Date.now() - 30 * 60_000).toISOString();

    try {
      const store = new DaemonWorkspaceStateStore(cwd, { stateFile });
      store.setApprovalNotificationDeliveryState({
        pending: [{
          key: "codex:thread:turn:request",
          adapter: "codex",
          threadId: "thread",
          turnId: "turn",
          requestId: "request",
          text: "需要确认",
          commandPreview: "ssh example",
          createdAt: pendingCreatedAt,
        }],
        delivered: [{
          key: "codex:thread:old:request",
          deliveredAt,
        }],
      });

      const restored = new DaemonWorkspaceStateStore(cwd, { stateFile });
      expect(restored.getApprovalNotificationDeliveryState()).toEqual({
        pending: [{
          key: "codex:thread:turn:request",
          adapter: "codex",
          threadId: "thread",
          turnId: "turn",
          requestId: "request",
          text: "需要确认",
          commandPreview: "ssh example",
          createdAt: pendingCreatedAt,
        }],
        delivered: [{
          key: "codex:thread:old:request",
          deliveredAt,
        }],
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("persists the active adapter and selected Codex thread", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-daemon-state-"));
    const stateFile = path.join(directory, "daemon-state.json");
    const cwd = path.join(directory, "workspace");

    try {
      const store = new DaemonWorkspaceStateStore(cwd, { stateFile });
      expect(store.hadPersistedState).toBe(false);

      store.setActiveAdapter("codex");
      store.setCodexThreadId(" 0000000a-0000-7000-8000-00000000000a ");
      store.setAdapterSessionId("grok", " grok-session ");
      store.setCodexWechatReplyMode("full");
      store.setCodexWechatThreadId(" wechat-thread ");
      store.setRestartNoticeSentAt("2026-08-05T02:04:00.000+08:00");
      expect(store.ensureMobileAccessToken(() => "mobile-secret")).toBe(
        "mobile-secret",
      );

      expect(readDaemonWorkspaceState(cwd, { stateFile })).toMatchObject({
        version: 1,
        cwd: path.resolve(cwd),
        activeAdapter: "codex",
        codexThreadId: "0000000a-0000-7000-8000-00000000000a",
        adapterSessionIds: {
          codex: "0000000a-0000-7000-8000-00000000000a",
          grok: "grok-session",
        },
        mobileAccessToken: "mobile-secret",
        codexWechatReplyMode: "full",
        codexWechatThreadId: "wechat-thread",
        restartNoticeSentAt: "2026-08-05T02:04:00.000+08:00",
      });

      const restoredStore = new DaemonWorkspaceStateStore(cwd, { stateFile });
      expect(restoredStore.hadPersistedState).toBe(true);
      expect(restoredStore.getState().codexThreadId).toBe(
        "0000000a-0000-7000-8000-00000000000a",
      );
      expect(restoredStore.getAdapterSessionId("grok")).toBe("grok-session");
      expect(restoredStore.ensureMobileAccessToken(() => "other-secret")).toBe(
        "mobile-secret",
      );
      expect(restoredStore.getState().codexWechatReplyMode).toBe("full");
      expect(restoredStore.getCodexWechatThreadId()).toBe("wechat-thread");
      expect(restoredStore.getState().restartNoticeSentAt).toBe(
        "2026-08-05T02:04:00.000+08:00",
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("ignores malformed or cross-workspace state", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-daemon-state-"));
    const stateFile = path.join(directory, "daemon-state.json");
    const cwd = path.join(directory, "workspace");

    try {
      fs.writeFileSync(stateFile, "not-json", "utf8");
      expect(readDaemonWorkspaceState(cwd, { stateFile })).toBeNull();

      fs.writeFileSync(
        stateFile,
        JSON.stringify({
          version: 1,
          cwd: path.join(directory, "other-workspace"),
          activeAdapter: "codex",
          codexThreadId: "thread_other",
          updatedAt: "2026-07-31T00:00:00.000Z",
        }),
        "utf8",
      );
      expect(readDaemonWorkspaceState(cwd, { stateFile })).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("persists one latest completed record per task across all adapters", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-daemon-state-"));
    const stateFile = path.join(directory, "daemon-state.json");
    const cwd = path.join(directory, "workspace");

    try {
      const store = new DaemonWorkspaceStateStore(cwd, { stateFile });
      store.recordRecentTaskCompletion({
        adapter: "codex",
        threadId: "codex-task",
        title: "第一次完成",
        completedAt: "2026-08-07T01:00:00.000Z",
        turnId: "turn-1",
      });
      store.recordRecentTaskCompletion({
        adapter: "grok",
        threadId: "grok-task",
        title: "Grok 完成项",
        completedAt: "2026-08-07T02:00:00.000Z",
      });
      store.recordRecentTaskCompletion({
        adapter: "codex",
        threadId: "codex-task",
        title: "第二次完成",
        completedAt: "2026-08-07T03:00:00.000Z",
        turnId: "turn-2",
      });

      expect(store.getRecentTaskCompletions()).toEqual([
        {
          adapter: "codex",
          threadId: "codex-task",
          title: "第二次完成",
          completedAt: "2026-08-07T03:00:00.000Z",
          turnId: "turn-2",
        },
        {
          adapter: "grok",
          threadId: "grok-task",
          title: "Grok 完成项",
          completedAt: "2026-08-07T02:00:00.000Z",
        },
      ]);

      const restored = new DaemonWorkspaceStateStore(cwd, { stateFile });
      expect(restored.getRecentTaskCompletions()).toEqual(
        store.getRecentTaskCompletions(),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("persists approval results and keeps them isolated by adapter and task", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-daemon-state-"));
    const stateFile = path.join(directory, "daemon-state.json");
    const cwd = path.join(directory, "workspace");

    try {
      const store = new DaemonWorkspaceStateStore(cwd, { stateFile });
      store.recordMobileApprovalResult({
        id: "approval-1",
        adapter: "codex",
        threadId: "task-a",
        turnId: "turn-1",
        action: "confirm",
        summary: "Codex 请求运行命令。",
        commandPreview: "npm run quality",
        detailLabel: "运行命令",
        detailPreview: "npm run quality",
        resolvedAt: "2026-08-08T01:00:00.000Z",
      });
      store.recordMobileApprovalResult({
        id: "approval-2",
        adapter: "codex",
        threadId: "task-a",
        turnId: "turn-1",
        action: "deny",
        summary: "Codex 请求修改文件。",
        commandPreview: "修改 src/app.ts",
        resolvedAt: "2026-08-08T01:01:00.000Z",
      });
      store.recordMobileApprovalResult({
        id: "approval-3",
        adapter: "grok",
        threadId: "task-a",
        action: "confirm_task",
        summary: "Grok 请求运行命令。",
        commandPreview: "bun test",
        resolvedAt: "2026-08-08T01:02:00.000Z",
      });

      expect(store.getMobileApprovalResults("codex", "task-a")).toEqual([
        expect.objectContaining({
          id: "approval-1",
          action: "confirm",
          turnId: "turn-1",
        }),
        expect.objectContaining({
          id: "approval-2",
          action: "deny",
          turnId: "turn-1",
        }),
      ]);
      expect(store.getMobileApprovalResults("grok", "task-a")).toEqual([
        expect.objectContaining({
          id: "approval-3",
          action: "confirm_task",
        }),
      ]);
      expect(store.getMobileApprovalResults("codex", "task-b")).toEqual([]);

      const restored = new DaemonWorkspaceStateStore(cwd, { stateFile });
      expect(restored.getMobileApprovalResults("codex", "task-a")).toEqual(
        store.getMobileApprovalResults("codex", "task-a"),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

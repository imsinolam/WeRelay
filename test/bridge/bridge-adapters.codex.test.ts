import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CodexPtyAdapter,
  applyCodexDesktopProjectMetadata,
  connectCodexDesktopIpcClientWithLaunch,
  extractCodexDesktopThreadMessages,
  extractCodexDesktopThreadProgress,
  extractCodexDesktopThreadRunSummary,
  extractCodexThreadMessages,
  extractCodexThreadRunSummary,
  mergeCodexSessionMessages,
  extractLatestCodexThreadMessage,
  mapCodexDesktopThreadListResponse,
  parseCodexSessionTaskBoundary,
  readCodexSessionMessagePageFromRollout,
  readCodexSessionProgressFromRolloutTail,
  readCodexSessionRunSummaryFromRolloutTail,
  resolveCodexAppServerFailureAction,
  resolveCodexDesktopAppServerSpawnTarget,
  resolveCodexDesktopPermissionSettings,
  resolveCodexTaskOutcome,
  shouldAttemptCodexDesktopApplicationLaunch,
  shouldSuppressCodexTransportFatalError,
  shouldTreatCodexNativeExitAsExpected,
} from "../../src/bridge/bridge-adapters.codex.ts";
import { isCodexDesktopMainProcessCommandLine } from "../../src/bridge/codex-desktop-ipc.ts";
import { createRuntimeHost } from "../../src/runtime/create-runtime-host.ts";
import { getWorkspaceChannelPaths } from "../../src/wechat/channel-config.ts";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Codex desktop permission alignment", () => {
  const globalState = {
    "electron-persisted-atom-state": {
      "agent-mode-by-host-id": {
        local: "full-access",
      },
      "heartbeat-thread-permissions-by-id": {
        thread_full: {
          activePermissionProfile: { id: ":danger-full-access", extends: null },
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
        },
        thread_auto: {
          activePermissionProfile: { id: ":workspace", extends: null },
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/repo"],
            networkAccess: false,
          },
        },
      },
    },
  };

  test("uses the selected desktop task's Full access settings", () => {
    expect(resolveCodexDesktopPermissionSettings(globalState, "thread_full")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  test("preserves desktop automatic-review workspace settings", () => {
    expect(resolveCodexDesktopPermissionSettings(globalState, "thread_auto")).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/repo"],
        networkAccess: false,
      },
    });
  });

  test("falls back to the desktop host mode for a new task", () => {
    expect(resolveCodexDesktopPermissionSettings(globalState)).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  test("marks interrupted and failed turn completion explicitly", () => {
    expect(resolveCodexTaskOutcome("interrupted")).toBe("interrupted");
    expect(resolveCodexTaskOutcome("failed")).toBe("failed");
    expect(resolveCodexTaskOutcome("completed")).toBe("completed");
  });

  test("emits interrupted outcome when Codex confirms an interrupted turn", () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "panel",
    }) as any;
    const events: Array<{ type: string; outcome?: string }> = [];
    adapter.setEventSink((event: { type: string; outcome?: string }) => {
      events.push(event);
    });
    const trackedTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };
    adapter.activeTurn = trackedTurn;
    adapter.state.status = "busy";
    adapter.state.activeTurnId = trackedTurn.turnId;
    adapter.state.activeTurnOrigin = trackedTurn.origin;

    adapter.handleTurnCompleted(trackedTurn, {
      turn: {
        id: trackedTurn.turnId,
        status: "interrupted",
      },
    });

    expect(events.find((event) => event.type === "task_complete")?.outcome).toBe(
      "interrupted",
    );
  });
});

describe("Codex task metadata", () => {
  test("renames the canonical desktop thread through app-server", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const requests: Array<{ method: string; params: unknown }> = [];
    adapter.rpcSocket = { readyState: WebSocket.OPEN };
    adapter.sendRpcMessage = (payload: { method: string; params: unknown }) => {
      requests.push({ method: payload.method, params: payload.params });
      const pending = Array.from(adapter.pendingRpcRequests.values()).at(-1);
      pending?.resolve({});
    };

    await adapter.renameSession("  thread_rename  ", "新的任务名");

    expect(requests).toEqual([{
      method: "thread/name/set",
      params: { threadId: "thread_rename", name: "新的任务名" },
    }]);
  });
});

describe("codex exit handling", () => {
  test("treats a clean native panel exit as expected", () => {
    expect(
      shouldTreatCodexNativeExitAsExpected({
        renderMode: "panel",
        shuttingDown: false,
        exitCode: 0,
      }),
    ).toBe(true);
  });

  test("keeps embedded codex exit code 0 as unexpected", () => {
    expect(
      shouldTreatCodexNativeExitAsExpected({
        renderMode: "embedded",
        shuttingDown: false,
        exitCode: 0,
      }),
    ).toBe(false);
  });

  test("suppresses transport fatal errors while a clean panel exit is in progress", () => {
    expect(
      shouldSuppressCodexTransportFatalError({
        transportShuttingDown: false,
        shuttingDown: false,
        cleanPanelExitInProgress: true,
      }),
    ).toBe(true);
  });
});


describe("Codex desktop thread listing", () => {
  test("maps app-server thread/list results to desktop task candidates", () => {
    const candidates = mapCodexDesktopThreadListResponse(
      {
        data: [
          {
            id: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa7",
            name: "校验页面模板并列出修复建议",
            preview: "fallback preview",
            cwd: "/Users/example/Projects/design-system",
            source: "vscode",
            recencyAt: 1784992242,
            updatedAt: 1784992240,
          },
          {
            id: "cccccccc-cccc-7ccc-8ccc-ccccccccccc9",
            name: null,
            preview: "检索亚太开发者活动\n更多内容",
            cwd: "/Users/example/Projects/notes",
            source: "vscode",
            recencyAt: null,
            updatedAt: 1784991445,
          },
        ],
      },
      10,
    );

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      sessionId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa7",
      threadId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa7",
      title: "校验页面模板并列出修复建议",
      cwd: "/Users/example/Projects/design-system",
      source: "vscode",
    });
    expect(candidates[1]?.title).toBe("检索亚太开发者活动");
    expect(Number.isNaN(Date.parse(candidates[0]?.lastUpdatedAt ?? ""))).toBe(false);
  });
});

  test("uses the desktop project's real name and keeps projectless tasks in recent", () => {
    const candidates = mapCodexDesktopThreadListResponse({
      data: [
        { id: "thread_project", name: "项目任务", cwd: "/repo/subdir" },
        { id: "thread_recent", name: "临时任务", cwd: "/tmp/generated-name" },
        { id: "thread_fallback", name: "新任务", cwd: "/repo/feature" },
      ],
    });

    applyCodexDesktopProjectMetadata(candidates, {
      "local-projects": {
        project_real: {
          id: "project_real",
          name: "真实项目名",
          rootPaths: ["/repo"],
        },
      },
      "project-order": ["project_real"],
      "thread-project-assignments": {
        thread_project: { projectKind: "local", projectId: "project_real" },
      },
      "projectless-thread-ids": ["thread_recent"],
      "sidebar-project-thread-orders": {
        project_real: { threadIds: ["thread_fallback", "thread_project"] },
      },
    });

    expect(candidates[0]).toMatchObject({
      projectId: "project_real",
      projectName: "真实项目名",
      projectOrder: 0,
      projectThreadOrder: 1,
    });
    expect(candidates[1]?.projectName).toBeUndefined();
    expect(candidates[2]).toMatchObject({
      projectId: "project_real",
      projectName: "真实项目名",
      projectThreadOrder: 0,
    });
  });



describe("Codex desktop task run summary", () => {
  test("extracts the latest completed turn duration", () => {
    expect(
      extractCodexThreadRunSummary({
        thread: {
          turns: [
            {
              id: "turn_done",
              status: "completed",
              startedAt: 1_785_569_563,
              completedAt: 1_785_570_619,
              durationMs: 1_055_660,
            },
          ],
        },
      }),
    ).toEqual({
      turnId: "turn_done",
      status: "completed",
      startedAtMs: 1_785_569_563_000,
      completedAtMs: 1_785_570_619_000,
      durationMs: 1_055_660,
    });
  });

  test("computes elapsed time for the latest running turn", () => {
    expect(
      extractCodexThreadRunSummary(
        {
          thread: {
            turns: [
              {
                id: "turn_running",
                status: "inProgress",
                startedAt: 1_785_570_000,
                completedAt: null,
                durationMs: null,
              },
            ],
          },
        },
        1_785_570_547_000,
      ),
    ).toEqual({
      turnId: "turn_running",
      status: "running",
      startedAtMs: 1_785_570_000_000,
      durationMs: 547_000,
    });
  });

  test("uses the desktop active turn instead of a stale interrupted RPC summary", () => {
    expect(
      extractCodexDesktopThreadRunSummary(
        {
          threadRuntimeStatus: { type: "active", activeFlags: [] },
          turnHistory: {
            history: {
              entitiesByKey: {
                "turn:old": {
                  turnId: "turn_old",
                  status: "interrupted",
                  items: [],
                },
                "tail:0:local:current": {
                  turnId: "turn_current",
                  status: "inProgress",
                  items: [],
                },
              },
            },
          },
        },
        {
          turnId: "turn_old",
          status: "interrupted",
          startedAtMs: 1_000,
        },
        9_000,
        4_000,
      ),
    ).toEqual({
      turnId: "turn_current",
      status: "running",
      startedAtMs: 4_000,
      durationMs: 5_000,
    });
  });

  test("keeps an idle desktop turn unknown until terminal evidence appears", () => {
    expect(
      extractCodexDesktopThreadRunSummary(
        {
          threadRuntimeStatus: { type: "idle" },
          updatedAt: 9,
          turnHistory: {
            history: {
              entitiesByKey: {
                "tail:0:local:uncertain": {
                  turnId: "turn_current",
                  status: "inProgress",
                  items: [{
                    type: "agentMessage",
                    phase: "commentary",
                    text: "仍在检查任务状态。",
                  }],
                },
              },
            },
          },
        },
        {
          turnId: "turn_current",
          status: "running",
          startedAtMs: 4_000,
          durationMs: 5_000,
        },
        12_000,
        4_000,
      ),
    ).toEqual({
      turnId: "turn_current",
      status: "unknown",
      startedAtMs: 4_000,
      durationMs: 5_000,
    });
  });

  test("stops a stale running summary when the desktop owner is idle", () => {
    expect(
      extractCodexDesktopThreadRunSummary(
        {
          threadRuntimeStatus: { type: "idle" },
          updatedAt: 9,
          turnHistory: {
            history: {
              entitiesByKey: {
                "tail:0:local:completed": {
                  turnId: "turn_current",
                  status: "inProgress",
                  durationMs: null,
                  items: [{
                    type: "agentMessage",
                    phase: "final_answer",
                    text: "已经完成。",
                  }],
                },
              },
            },
          },
        },
        {
          turnId: "turn_current",
          status: "running",
          startedAtMs: 4_000,
          durationMs: 5_000,
        },
        12_000,
        4_000,
      ),
    ).toEqual({
      turnId: "turn_current",
      status: "completed",
      startedAtMs: 4_000,
      completedAtMs: 9_000,
      durationMs: 5_000,
    });
  });
});

describe("Codex desktop live conversation messages", () => {
  test("merges in-progress desktop messages into the persisted transcript", () => {
    const persisted = [{
      role: "user" as const,
      text: "查看运行进展",
      id: "user_1",
      turnId: "turn_1",
    }];
    const live = extractCodexDesktopThreadMessages({
      turnHistory: {
        history: {
          entitiesByKey: {
            "tail:0:local:test": {
              turnId: "turn_1",
              status: "inProgress",
              items: [
                {
                  type: "userMessage",
                  id: "user_1",
                  content: [{ type: "text", text: "查看运行进展" }],
                },
                {
                  type: "agentMessage",
                  id: "assistant_live",
                  phase: "commentary",
                  text: "正在检查所有桌面任务。",
                },
              ],
            },
          },
        },
      },
    });
    expect(mergeCodexSessionMessages(persisted, live)).toEqual([
      persisted[0],
      {
        role: "assistant",
        text: "正在检查所有桌面任务。",
        id: "assistant_live",
        turnId: "turn_1",
        phase: "commentary",
      },
    ]);
  });

  test("ignores paginated completed history when reading the live desktop tail", () => {
    expect(
      extractCodexDesktopThreadMessages({
        turnHistory: {
          history: {
            entitiesByKey: {
              "tail:0:local:current": {
                turnId: "turn_current",
                status: "inProgress",
                items: [{
                  type: "userMessage",
                  id: "user_current",
                  content: [{ type: "text", text: "刚刚发出的消息" }],
                }],
              },
              "turn:old": {
                turnId: "turn_old",
                status: "completed",
                items: [{
                  type: "userMessage",
                  id: "user_old",
                  content: [{ type: "text", text: "本会话第一条久远消息" }],
                }],
              },
            },
          },
        },
      }),
    ).toEqual([{
      role: "user",
      text: "刚刚发出的消息",
      id: "user_current",
      turnId: "turn_current",
    }]);
  });

  test("ignores stale historical turns that still claim to be in progress", () => {
    expect(
      extractCodexDesktopThreadMessages({
        threadRuntimeStatus: { type: "active", activeFlags: [] },
        turnHistory: {
          history: {
            entitiesByKey: {
              "turn:stale": {
                turnId: "turn_stale",
                status: "inProgress",
                items: [{
                  type: "userMessage",
                  id: "user_stale",
                  content: [{ type: "text", text: "不应再次出现的历史消息" }],
                }],
              },
              "tail:0:local:current": {
                turnId: "turn_current",
                status: "inProgress",
                items: [{
                  type: "userMessage",
                  id: "user_current",
                  content: [{ type: "text", text: "当前消息" }],
                }],
              },
            },
          },
        },
      }),
    ).toEqual([{
      role: "user",
      text: "当前消息",
      id: "user_current",
      turnId: "turn_current",
    }]);
  });

  test("keeps the preferred live turn when the desktop tail cache retains older turns", () => {
    expect(
      extractCodexDesktopThreadMessages({
        threadRuntimeStatus: { type: "active", activeFlags: [] },
        turnHistory: {
          history: {
            entitiesByKey: {
              "tail:0:local:current": {
                turnId: "turn_current",
                status: "inProgress",
                items: [{
                  type: "userMessage",
                  id: "user_current",
                  content: [{ type: "text", text: "刚刚发出的消息" }],
                }],
              },
              "tail:0:local:stale-hotel-route": {
                turnId: "turn_stale_route",
                status: "inProgress",
                items: [{
                  type: "userMessage",
                  id: "user_stale_route",
                  content: [{ type: "text", text: "看看根据新酒店的位置调整行程" }],
                }],
              },
              "tail:0:local:stale-hotel-email": {
                turnId: "turn_stale_email",
                status: "inProgress",
                items: [{
                  type: "userMessage",
                  id: "user_stale_email",
                  content: [{ type: "text", text: "起草凌晨入住邮件" }],
                }],
              },
              "tail:0:local:stale-mail-cli": {
                turnId: "turn_stale_cli",
                status: "inProgress",
                items: [{
                  type: "userMessage",
                  id: "user_stale_cli",
                  content: [{ type: "text", text: "安装邮箱 CLI" }],
                }],
              },
            },
          },
        },
      }, "turn_current"),
    ).toEqual([{
      role: "user",
      text: "刚刚发出的消息",
      id: "user_current",
      turnId: "turn_current",
    }]);
  });

  test("does not fall back to stale tail turns while the preferred turn is still arriving", () => {
    expect(
      extractCodexDesktopThreadMessages({
        threadRuntimeStatus: { type: "active", activeFlags: [] },
        turnHistory: {
          history: {
            entitiesByKey: {
              "tail:0:local:stale": {
                turnId: "turn_stale",
                status: "inProgress",
                items: [{
                  type: "userMessage",
                  id: "user_stale",
                  content: [{ type: "text", text: "不应插到新消息后面" }],
                }],
              },
            },
          },
        },
      }, "turn_current"),
    ).toEqual([]);
  });

  test("deduplicates persisted and live messages that use different ids", () => {
    const persisted = [
      {
        role: "user" as const,
        text: "第一条网页消息",
        id: "item-100",
        turnId: "turn-1",
      },
      {
        role: "assistant" as const,
        text: "第一条处理中",
        id: "item-101",
        turnId: "turn-1",
        phase: "commentary" as const,
      },
      {
        role: "user" as const,
        text: "第二条网页消息",
        id: "item-102",
        turnId: "turn-2",
      },
    ];
    const live = [
      {
        role: "user" as const,
        text: "第一条网页消息",
        id: "019f-live-user-1",
        turnId: "turn-1",
      },
      {
        role: "assistant" as const,
        text: "第一条处理中",
        id: "msg_live_assistant_1",
        turnId: "turn-1",
        phase: "commentary" as const,
      },
      {
        role: "user" as const,
        text: "第二条网页消息",
        id: "019f-live-user-2",
        turnId: "turn-2",
      },
      {
        role: "assistant" as const,
        text: "第二条正在处理",
        id: "msg_live_assistant_2",
        turnId: "turn-2",
        phase: "commentary" as const,
      },
    ];

    expect(mergeCodexSessionMessages(persisted, live)).toEqual([
      persisted[0],
      persisted[1],
      persisted[2],
      live[3],
    ]);
  });

  test("getSessionMessages reuses cached live state without starting a heavy follow", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    adapter.sendRpcRequest = async () => ({
      thread: {
        turns: [{
          id: "turn_1",
          items: [{
            type: "userMessage",
            id: "user_1",
            content: [{ type: "text", text: "查看运行进展" }],
          }],
        }],
      },
    });
    adapter.desktopIpcClient = {
      getThreadState: () => ({
        turnHistory: {
          history: {
            entitiesByKey: {
              turn_1: {
                turnId: "turn_1",
                status: "inProgress",
                items: [{
                  type: "agentMessage",
                  id: "assistant_live",
                  phase: "commentary",
                  text: "正在实时刷新。",
                }],
              },
            },
          },
        },
      }),
    };

    expect(await adapter.getSessionMessages("thread_1")).toEqual([
      {
        role: "user",
        text: "查看运行进展",
        id: "user_1",
        turnId: "turn_1",
      },
      {
        role: "assistant",
        text: "正在实时刷新。",
        id: "assistant_live",
        turnId: "turn_1",
        phase: "commentary",
      },
    ]);
  });

  test("reads recent rollout messages from the file tail and continues with an opaque cursor", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-page-"));
    const filePath = path.join(directory, "rollout-thread-page.jsonl");
    const responseMessage = (
      role: "user" | "assistant" | "developer",
      text: string,
      index: number,
      phase?: "commentary" | "final_answer",
    ) => JSON.stringify({
      timestamp: `2026-08-04T00:00:${String(index).padStart(2, "0")}.000Z`,
      type: "response_item",
      payload: {
        type: "message",
        id: `message-${index}`,
        role,
        content: [{
          type: role === "assistant" ? "output_text" : "input_text",
          text,
        }],
        ...(phase ? { phase } : {}),
        internal_chat_message_metadata_passthrough: {
          turn_id: `turn-${index}`,
        },
      },
    });

    try {
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: "session_meta", payload: { id: "thread-page" } }),
        responseMessage("developer", "内部指令不能显示", 0),
        responseMessage("user", "消息 1", 1),
        JSON.stringify({
          type: "turn_context",
          payload: { turn_id: "turn-2", model: "gpt-5.4" },
        }),
        responseMessage("assistant", "回答 1", 2, "final_answer"),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "回答 1", phase: "final_answer" },
        }),
        responseMessage("user", "消息 2", 3),
        JSON.stringify({
          type: "turn_context",
          payload: { turn_id: "turn-4", model: "gpt-5.5" },
        }),
        responseMessage("assistant", "回答 2", 4, "commentary"),
        responseMessage("user", "<app-context>内部上下文</app-context>\n消息 3", 5),
        JSON.stringify({
          type: "turn_context",
          payload: { turn_id: "turn-6", model: "gpt-5.6-sol" },
        }),
        responseMessage("assistant", "回答 3", 6, "final_answer"),
        JSON.stringify({
          timestamp: "2026-08-04T00:00:08.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-6",
            started_at: 1_785_801_100,
            completed_at: 1_785_801_128,
            duration_ms: 28_000,
          },
        }),
      ].join("\n") + "\n", "utf8");

      const latest = readCodexSessionMessagePageFromRollout(filePath, { limit: 3 });
      expect(latest?.messages.map((message) => message.createdAtMs)).toEqual([
        Date.parse("2026-08-04T00:00:04.000Z"),
        Date.parse("2026-08-04T00:00:05.000Z"),
        Date.parse("2026-08-04T00:00:06.000Z"),
      ]);
      expect(latest).toMatchObject({
        messages: [
          {
            role: "assistant",
            text: "回答 2",
            id: "message-4",
            phase: "commentary",
            model: "gpt-5.5",
          },
          { role: "user", text: "消息 3", id: "message-5" },
          {
            role: "assistant",
            text: "回答 3",
            id: "message-6",
            phase: "final_answer",
            model: "gpt-5.6-sol",
          },
        ],
        hasMore: true,
      });
      expect(latest?.nextBefore).toMatch(/^byte:\d+$/);

      expect(readCodexSessionMessagePageFromRollout(filePath, {
        limit: 3,
        lightweight: true,
      })).toMatchObject({
        messages: [
          { role: "assistant", text: "回答 2", id: "message-4" },
          { role: "user", text: "消息 3", id: "message-5" },
          { role: "assistant", text: "回答 3", id: "message-6" },
        ],
      });
      expect(
        readCodexSessionMessagePageFromRollout(filePath, {
          limit: 3,
          lightweight: true,
        })?.messages.some((message) => Boolean(message.model)),
      ).toBe(false);

      const older = readCodexSessionMessagePageFromRollout(filePath, {
        before: latest?.nextBefore,
        limit: 3,
      });
      expect(older).toEqual({
        messages: [
          {
            role: "user",
            text: "消息 1",
            id: "message-1",
            turnId: "turn-1",
            createdAtMs: Date.parse("2026-08-04T00:00:01.000Z"),
          },
          {
            role: "assistant",
            text: "回答 1",
            id: "message-2",
            turnId: "turn-2",
            phase: "final_answer",
            createdAtMs: Date.parse("2026-08-04T00:00:02.000Z"),
            model: "gpt-5.4",
          },
          {
            role: "user",
            text: "消息 2",
            id: "message-3",
            turnId: "turn-3",
            createdAtMs: Date.parse("2026-08-04T00:00:03.000Z"),
          },
        ],
        hasMore: false,
        nextBefore: null,
      });
      expect(readCodexSessionRunSummaryFromRolloutTail(filePath)).toEqual({
        turnId: "turn-6",
        status: "completed",
        startedAtMs: 1_785_801_100_000,
        completedAtMs: 1_785_801_128_000,
        durationMs: 28_000,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("recovers a completed phase-less assistant reply and removes internal thinking text", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-phase-less-final-"));
    const filePath = path.join(directory, "rollout-phase-less-final.jsonl");
    try {
      fs.writeFileSync(filePath, [
        JSON.stringify({
          timestamp: "2026-08-14T12:47:28.575Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "user-phase-less",
            role: "user",
            content: [{ type: "input_text", text: "找出参数链接" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-phase-less" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-14T12:47:53.013Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "assistant-phase-less",
            role: "assistant",
            content: [{
              type: "output_text",
              text: "<thinking>internal reasoning must stay private</thinking>\n参数链接：https://example.com/?insight=abc",
            }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-phase-less" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-14T12:47:53.655Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "turn-phase-less",
            last_agent_message: "<thinking>private</thinking>\n参数链接：https://example.com/?insight=abc",
            started_at: 1_786_711_648,
            completed_at: 1_786_711_673,
            duration_ms: 25_097,
          },
        }),
      ].join("\n") + "\n", "utf8");

      expect(readCodexSessionMessagePageFromRollout(filePath, { limit: 1 })).toEqual({
        messages: [{
          role: "assistant",
          text: "参数链接：https://example.com/?insight=abc",
          id: "assistant-phase-less",
          turnId: "turn-phase-less",
          phase: "final_answer",
          createdAtMs: Date.parse("2026-08-14T12:47:53.013Z"),
        }],
        hasMore: true,
        nextBefore: expect.stringMatching(/^byte:\d+$/),
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps recent assistant output when newer Codex rollouts omit the phase field", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-unphased-"));
    const filePath = path.join(directory, "rollout-thread-unphased.jsonl");
    try {
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: "session_meta", payload: { id: "thread-unphased" } }),
        JSON.stringify({
          timestamp: "2026-08-13T03:42:00.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "user-unphased",
            role: "user",
            content: [{ type: "input_text", text: "完成了吗" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-unphased" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-13T03:42:17.000Z",
          type: "response_item",
          payload: {
            type: "message",
            id: "assistant-unphased",
            role: "assistant",
            content: [{ type: "output_text", text: "已经完成，这是最近回复。" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-unphased" },
          },
        }),
        JSON.stringify({
          timestamp: "2026-08-13T03:42:18.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "turn-unphased" },
        }),
      ].join("\n") + "\n", "utf8");

      expect(readCodexSessionMessagePageFromRollout(filePath, { limit: 10 })).toMatchObject({
        messages: [
          {
            role: "user",
            text: "完成了吗",
            id: "user-unphased",
            turnId: "turn-unphased",
          },
          {
            role: "assistant",
            text: "已经完成，这是最近回复。",
            id: "assistant-unphased",
            turnId: "turn-unphased",
          },
        ],
        hasMore: false,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("materializes historical input images into a private local cache for mobile previews", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-input-image-"));
    const filePath = path.join(directory, "rollout-input-image.jsonl");
    const imageCacheDir = path.join(directory, "image-cache");
    const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl4wGAAAAAASUVORK5CYII=";
    try {
      fs.writeFileSync(filePath, JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          id: "user-with-image",
          role: "user",
          content: [
            { type: "input_text", text: "分析这张图" },
            { type: "input_image", image_url: `data:image/png;base64,${imageBase64}` },
          ],
        },
      }) + "\n", "utf8");

      const page = readCodexSessionMessagePageFromRollout(filePath, {
        limit: 1,
        imageCacheDir,
      });
      expect(page?.messages).toHaveLength(1);
      expect(page?.messages[0]).toMatchObject({
        role: "user",
        text: "分析这张图\n[image]",
        id: "user-with-image",
        images: [{ source: "local", alt: "输入图片 1" }],
      });
      const imagePath = page?.messages[0]?.images?.[0]?.source === "local"
        ? page.messages[0].images[0].path
        : "";
      expect(imagePath).toStartWith(imageCacheDir);
      expect(fs.readFileSync(imagePath)).toEqual(Buffer.from(imageBase64, "base64"));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("provides paged Codex input image media for accelerated mobile history", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-media-page-"));
    const threadId = "thread-media-page";
    const filePath = path.join(directory, `rollout-${threadId}.jsonl`);
    const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl4wGAAAAAASUVORK5CYII=";
    const workspaceDir = getWorkspaceChannelPaths(directory).workspaceDir;
    try {
      fs.writeFileSync(filePath, [
        JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            id: "user-media",
            role: "user",
            content: [
              { type: "input_text", text: "查看输入图片" },
              { type: "input_image", image_url: `data:image/png;base64,${imageBase64}` },
            ],
          },
        }),
      ].join("\n") + "\n", "utf8");
      const adapter = new CodexPtyAdapter({
        kind: "codex",
        command: "codex",
        cwd: directory,
        renderMode: "headless",
        codexTransport: "desktop",
      }) as any;
      adapter.resolveDesktopSessionFilePath = () => filePath;

      const messages = await adapter.getSessionMessageMedia(threadId, {
        historyOnly: true,
        lightweight: true,
        limit: 1,
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: "user",
        text: "查看输入图片\n[image]",
        images: [{ source: "local", alt: "输入图片 1" }],
      });
      const image = messages[0]?.images?.[0];
      expect(image?.source).toBe("local");
      if (image?.source === "local") {
        expect(image.path).toStartWith(path.join(workspaceDir, "message-images", "codex"));
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("finds the turn model before a large rollout gap without loading the full thread", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-model-"));
    const filePath = path.join(directory, "rollout-thread-model.jsonl");
    try {
      fs.writeFileSync(filePath, [
        JSON.stringify({
          type: "turn_context",
          payload: { turn_id: "turn-model", model: "gpt-5.6-terra" },
        }),
        JSON.stringify({ type: "event_msg", payload: { type: "context", text: "x".repeat(96 * 1024) } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            id: "assistant-model",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "跨分块回答" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn-model" },
          },
        }),
      ].join("\n") + "\n", "utf8");

      expect(readCodexSessionMessagePageFromRollout(filePath, { limit: 1 })).toEqual({
        messages: [{
          role: "assistant",
          text: "跨分块回答",
          id: "assistant-model",
          turnId: "turn-model",
          phase: "final_answer",
          model: "gpt-5.6-terra",
        }],
        hasMore: false,
        nextBefore: null,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("serves lightweight rollout pages and cached live state without loading the full thread", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-adapter-"));
    const threadId = "thread-rollout-live";
    const filePath = path.join(directory, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          id: "user-persisted",
          role: "user",
          content: [{ type: "input_text", text: "查看进展" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-live" },
        },
      }),
    ].join("\n") + "\n", "utf8");

    try {
      const adapter = new CodexPtyAdapter({
        kind: "codex",
        command: "codex",
        cwd: process.cwd(),
        renderMode: "headless",
        codexTransport: "desktop",
      }) as any;
      let rpcReads = 0;
      let followCalls = 0;
      adapter.sendRpcRequest = async () => {
        rpcReads += 1;
        throw new Error("不应读取完整 thread");
      };
      adapter.desktopThreadRuntimeStatusCache.set(threadId, {
        filePath,
        fileSize: fs.statSync(filePath).size,
        modifiedAtMs: fs.statSync(filePath).mtimeMs,
        scannedAtMs: Date.now(),
        runtimeStatus: { type: "active", activeFlags: [] },
      });
      adapter.desktopIpcClient = {
        followThread: async () => {
          followCalls += 1;
          throw new Error("后台订阅刷新失败不应阻塞已缓存的桌面状态");
        },
        getThreadStateView: () => ({
          threadRuntimeStatus: { type: "active", activeFlags: [] },
          turnHistory: {
            history: {
              entitiesByKey: {
                "tail:0:local:current": {
                  turnId: "turn-live",
                  status: "inProgress",
                  items: [{
                    type: "agentMessage",
                    id: "assistant-live",
                    phase: "commentary",
                    text: "正在检查。",
                  }],
                },
              },
            },
          },
        }),
      };

      expect(await adapter.getSessionMessagePage(threadId, {
        limit: 40,
        lightweight: true,
      })).toEqual({
        messages: [
          {
            role: "user",
            text: "查看进展",
            id: "user-persisted",
            turnId: "turn-live",
          },
          {
            role: "assistant",
            text: "正在检查。",
            id: "assistant-live",
            turnId: "turn-live",
            phase: "commentary",
          },
        ],
        hasMore: false,
        nextBefore: null,
      });
      expect(await adapter.getSessionRunSummary(threadId, {
        lightweight: true,
      })).toMatchObject({
        turnId: "turn-live",
        status: "running",
      });
      expect(rpcReads).toBe(0);
      expect(followCalls).toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps history-only rollout pages independent from cached desktop live state", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-history-only-"));
    const threadId = "thread-rollout-history-only";
    const filePath = path.join(directory, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          id: "user-persisted",
          role: "user",
          content: [{ type: "input_text", text: "只读取历史记录" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-persisted" },
        },
      }),
    ].join("\n") + "\n", "utf8");

    try {
      const adapter = new CodexPtyAdapter({
        kind: "codex",
        command: "codex",
        cwd: process.cwd(),
        renderMode: "headless",
        codexTransport: "desktop",
      }) as any;
      let liveStateReads = 0;
      adapter.desktopThreadRuntimeStatusCache.set(threadId, {
        filePath,
        fileSize: fs.statSync(filePath).size,
        modifiedAtMs: fs.statSync(filePath).mtimeMs,
        scannedAtMs: Date.now(),
        runtimeStatus: { type: "active", activeFlags: [] },
      });
      adapter.desktopIpcClient = {
        getThreadStateView: () => {
          liveStateReads += 1;
          return {
            turnHistory: {
              history: {
                entitiesByKey: {
                  "tail:0:local:current": {
                    turnId: "turn-live",
                    status: "inProgress",
                    items: [{
                      type: "agentMessage",
                      id: "assistant-live",
                      phase: "commentary",
                      text: "不应混入历史首屏。",
                    }],
                  },
                },
              },
            },
          };
        },
      };

      expect(await adapter.getSessionMessagePage(threadId, {
        historyOnly: true,
        lightweight: true,
        limit: 40,
      })).toEqual({
        messages: [{
          role: "user",
          text: "只读取历史记录",
          id: "user-persisted",
          turnId: "turn-persisted",
        }],
        hasMore: false,
        nextBefore: null,
      });
      expect(liveStateReads).toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("does not follow or read a full uncached thread for lightweight mobile polling", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-lightweight-"));
    const threadId = "thread-rollout-lightweight";
    const filePath = path.join(directory, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
      JSON.stringify({
        timestamp: "2026-08-05T09:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "task_started",
          turn_id: "turn-lightweight",
          started_at: 1_786_003_200,
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-05T09:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          id: "user-lightweight",
          role: "user",
          content: [{ type: "input_text", text: "检查性能" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-lightweight" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-05T09:00:02.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          id: "reasoning-lightweight",
          summary: [{ type: "summary_text", text: "检查移动端读取链路" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-lightweight" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-08-05T09:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          id: "call-lightweight",
          call_id: "call-lightweight",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "bun test" }),
          internal_chat_message_metadata_passthrough: { turn_id: "turn-lightweight" },
        },
      }),
    ].join("\n") + "\n", "utf8");

    try {
      const adapter = new CodexPtyAdapter({
        kind: "codex",
        command: "codex",
        cwd: process.cwd(),
        renderMode: "headless",
        codexTransport: "desktop",
      }) as any;
      let rpcReads = 0;
      let followCalls = 0;
      adapter.sendRpcRequest = async () => {
        rpcReads += 1;
        throw new Error("不应读取完整 thread");
      };
      adapter.desktopThreadRuntimeStatusCache.set(threadId, {
        filePath,
        fileSize: fs.statSync(filePath).size,
        modifiedAtMs: fs.statSync(filePath).mtimeMs,
        scannedAtMs: Date.now(),
        runtimeStatus: { type: "active", activeFlags: [] },
      });
      adapter.desktopIpcClient = {
        followThread: async () => {
          followCalls += 1;
          throw new Error("轻量轮询不应订阅完整桌面任务");
        },
        getThreadStateView: () => null,
        getThreadState: () => null,
      };

      const page = await adapter.getSessionMessagePage(threadId, {
        limit: 40,
        lightweight: true,
      });
      const summary = await adapter.getSessionRunSummary(threadId, {
        lightweight: true,
      });
      const progress = await adapter.getSessionProgress(threadId, {
        lightweight: true,
      });

      expect(page.messages).toEqual([{
        role: "user",
        text: "检查性能",
        id: "user-lightweight",
        turnId: "turn-lightweight",
        createdAtMs: Date.parse("2026-08-05T09:00:01.000Z"),
      }]);
      expect(summary).toMatchObject({
        turnId: "turn-lightweight",
        status: "running",
      });
      expect(progress).toEqual([
        {
          id: "reasoning-lightweight",
          turnId: "turn-lightweight",
          kind: "reasoning",
          status: "completed",
          text: "检查移动端读取链路",
          createdAtMs: Date.parse("2026-08-05T09:00:02.000Z"),
        },
        {
          id: "call-lightweight",
          turnId: "turn-lightweight",
          kind: "command",
          status: "running",
          text: "正在运行命令",
          createdAtMs: Date.parse("2026-08-05T09:00:03.000Z"),
        },
      ]);
      expect(rpcReads).toBe(0);
      expect(followCalls).toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reads current Codex progress from the rollout tail", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-progress-"));
    const filePath = path.join(directory, "rollout-progress.jsonl");
    fs.writeFileSync(filePath, [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "reasoning",
          id: "old-reasoning",
          summary: [{ type: "summary_text", text: "旧任务进展" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-old" },
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          id: "plan-current",
          call_id: "plan-current",
          name: "update_plan",
          arguments: JSON.stringify({
            plan: [
              { step: "定位性能问题", status: "completed" },
              { step: "实现轻量读取", status: "in_progress" },
              { step: "运行回归测试", status: "pending" },
            ],
          }),
          internal_chat_message_metadata_passthrough: { turn_id: "turn-current" },
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          id: "plan-output",
          call_id: "plan-current",
          output: "Plan updated",
          internal_chat_message_metadata_passthrough: { turn_id: "turn-current" },
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "reasoning",
          id: "reasoning-current",
          summary: [{ type: "summary_text", text: "读取本地会话尾部" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-current" },
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          id: "command-current",
          call_id: "command-current",
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "bun test" }),
          internal_chat_message_metadata_passthrough: { turn_id: "turn-current" },
        },
      }),
    ].join("\n") + "\n", "utf8");

    try {
      expect(readCodexSessionProgressFromRolloutTail(filePath)).toEqual([
        {
          id: "plan-current",
          turnId: "turn-current",
          kind: "plan",
          status: "running",
          text: "第 2 / 3 步 · 实现轻量读取",
        },
        {
          id: "reasoning-current",
          turnId: "turn-current",
          kind: "reasoning",
          status: "completed",
          text: "读取本地会话尾部",
        },
        {
          id: "command-current",
          turnId: "turn-current",
          kind: "command",
          status: "running",
          text: "正在运行命令",
        },
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("compacts rollout and live progress that map to the same visible summary", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-progress-source-dedup-"));
    const threadId = "thread-progress-source-dedup";
    const filePath = path.join(directory, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(filePath, JSON.stringify({
      type: "response_item",
      payload: {
        type: "reasoning",
        id: "rollout-planning",
        summary: [{ type: "summary_text", text: "Planning next steps" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-progress-source-dedup" },
      },
    }) + "\n", "utf8");

    try {
      const adapter = new CodexPtyAdapter({
        kind: "codex",
        command: "codex",
        cwd: process.cwd(),
        renderMode: "headless",
        codexTransport: "desktop",
      }) as any;
      adapter.desktopThreadRuntimeStatusCache.set(threadId, {
        filePath,
        fileSize: fs.statSync(filePath).size,
        modifiedAtMs: fs.statSync(filePath).mtimeMs,
        scannedAtMs: Date.now(),
        runtimeStatus: { type: "active", activeFlags: [] },
      });
      adapter.desktopIpcClient = {
        getThreadStateView: () => ({
          threadRuntimeStatus: { type: "active", activeFlags: [] },
          turnHistory: {
            history: {
              entitiesByKey: {
                "tail:0:local:current": {
                  turnId: "turn-progress-source-dedup",
                  status: "inProgress",
                  items: [{
                    type: "reasoning",
                    id: "live-planning",
                    summary: ["Designing next steps"],
                  }],
                },
              },
            },
          },
        }),
      };

      expect(await adapter.getSessionProgress(threadId, { lightweight: true })).toEqual([{
        id: "live-planning",
        turnId: "turn-progress-source-dedup",
        kind: "reasoning",
        status: "completed",
        text: "规划下一步处理",
      }]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("falls back to rollout progress when cached desktop state is summary-only", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-summary-cache-"));
    const threadId = "thread-summary-cache";
    const filePath = path.join(directory, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(filePath, JSON.stringify({
      type: "response_item",
      payload: {
        type: "reasoning",
        id: "reasoning-summary-cache",
        summary: [{ type: "summary_text", text: "继续检查网页进展" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-summary-cache" },
      },
    }) + "\n", "utf8");

    try {
      const adapter = new CodexPtyAdapter({
        kind: "codex",
        command: "codex",
        cwd: process.cwd(),
        renderMode: "headless",
        codexTransport: "desktop",
      }) as any;
      adapter.desktopThreadRuntimeStatusCache.set(threadId, {
        filePath,
        fileSize: fs.statSync(filePath).size,
        modifiedAtMs: fs.statSync(filePath).mtimeMs,
        scannedAtMs: Date.now(),
        runtimeStatus: { type: "active", activeFlags: [] },
      });
      adapter.desktopIpcClient = {
        getThreadStateView: () => ({
          threadRuntimeStatus: { type: "active", activeFlags: [] },
          turnHistory: { history: { entitiesByKey: {} } },
        }),
      };

      expect(await adapter.getSessionProgress(threadId, {
        lightweight: true,
      })).toEqual([{
        id: "reasoning-summary-cache",
        turnId: "turn-summary-cache",
        kind: "reasoning",
        status: "completed",
        text: "继续检查网页进展",
      }]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reads an idle task duration from the rollout tail without loading the full thread", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-summary-"));
    const threadId = "thread-rollout-summary";
    const filePath = path.join(directory, `rollout-${threadId}.jsonl`);
    fs.writeFileSync(filePath, [
      JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
      JSON.stringify({
        timestamp: "2026-08-04T01:00:30.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-completed",
          started_at: 1_785_804_800,
          completed_at: 1_785_804_830,
          duration_ms: 30_000,
        },
      }),
    ].join("\n") + "\n", "utf8");

    try {
      const adapter = new CodexPtyAdapter({
        kind: "codex",
        command: "codex",
        cwd: process.cwd(),
        renderMode: "headless",
        codexTransport: "desktop",
      }) as any;
      let rpcReads = 0;
      adapter.sendRpcRequest = async () => {
        rpcReads += 1;
        throw new Error("不应读取完整 thread");
      };
      adapter.desktopThreadRuntimeStatusCache.set(threadId, {
        filePath,
        fileSize: fs.statSync(filePath).size,
        modifiedAtMs: fs.statSync(filePath).mtimeMs,
        scannedAtMs: Date.now(),
        runtimeStatus: { type: "idle" },
      });
      adapter.desktopIpcClient = {
        followThread: async () => {},
        getThreadStateView: () => ({
          threadRuntimeStatus: { type: "idle" },
          turnHistory: { history: { entitiesByKey: {} } },
        }),
      };

      expect(await adapter.getSessionRunSummary(threadId)).toEqual({
        turnId: "turn-completed",
        status: "completed",
        startedAtMs: 1_785_804_800_000,
        completedAtMs: 1_785_804_830_000,
        durationMs: 30_000,
      });
      expect(rpcReads).toBe(0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("treats task_complete with an error as failed and keeps a concise reason", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollout-failed-summary-"));
    const filePath = path.join(directory, "rollout-thread-failed.jsonl");
    fs.writeFileSync(filePath, JSON.stringify({
      timestamp: "2026-08-13T13:17:30.949Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-failed",
        error: {
          message: "unexpected status 503 Service Unavailable: CC Switch local proxy failed while handling Codex endpoint /responses. Provider: codexpro; model: gpt-5.4; upstream_status: HTTP 503; cause: auth_unavailable: no auth available (providers=xai, model=gpt-5.4)",
        },
        started_at: 1_786_627_000,
        completed_at: 1_786_627_050,
        duration_ms: 50_000,
      },
    }) + "\n", "utf8");

    try {
      expect(readCodexSessionRunSummaryFromRolloutTail(filePath)).toEqual({
        turnId: "turn-failed",
        status: "failed",
        startedAtMs: 1_786_627_000_000,
        completedAtMs: 1_786_627_050_000,
        durationMs: 50_000,
        errorMessage: "当前模型 gpt-5.4 暂时没有可用账号，未生成回复。请在 CC Switch 中恢复该模型账号，或切换模型后重试。",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});


describe("Codex desktop task progress", () => {
  test("treats an aborted rollout turn as idle instead of running forever", () => {
    expect(parseCodexSessionTaskBoundary(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        turn_id: "turn-aborted",
      },
    }))).toEqual({ type: "idle" });
  });

  test("summarizes visible reasoning, plans, images, and command activity", () => {
    expect(
      extractCodexDesktopThreadProgress({
        threadRuntimeStatus: { type: "active", activeFlags: [] },
        turnHistory: {
          history: {
            entitiesByKey: {
              "tail:0:local:current": {
                turnId: "turn_progress",
                status: "inProgress",
                items: [
                  {
                    type: "reasoning",
                    id: "reason_1",
                    summary: ["**Inspecting queued image attachments**"],
                    content: [],
                  },
                  { type: "imageView", id: "image_1", path: "/tmp/one.png" },
                  { type: "imageView", id: "image_2", path: "/tmp/two.png" },
                  {
                    type: "commandExecution",
                    id: "command_1",
                    status: "completed",
                    commandActions: [
                      { type: "read", path: "/repo/app.ts" },
                      { type: "unknown", command: "npm test" },
                    ],
                  },
                  {
                    type: "todo-list",
                    id: "plan_1",
                    plan: [
                      { step: "检查现有实现", status: "completed" },
                      { step: "同步网页进展", status: "inProgress" },
                      { step: "运行回归测试", status: "pending" },
                    ],
                  },
                ],
              },
            },
          },
        },
      }),
    ).toEqual([
      {
        id: "plan_1",
        turnId: "turn_progress",
        kind: "plan",
        status: "running",
        text: "第 2 / 3 步 · 同步网页进展",
      },
      {
        id: "reason_1",
        turnId: "turn_progress",
        kind: "reasoning",
        status: "completed",
        text: "检查实现与运行状态",
      },
      {
        id: "image_1:image_2",
        turnId: "turn_progress",
        kind: "image",
        status: "completed",
        text: "已查看 2 张图像",
      },
      {
        id: "command_1",
        turnId: "turn_progress",
        kind: "command",
        status: "completed",
        text: "已读取文件并运行命令",
      },
    ]);
  });

  test("compacts repeated semantic progress from distinct Codex items", () => {
    const progress = extractCodexDesktopThreadProgress({
      threadRuntimeStatus: { type: "active", activeFlags: [] },
      turnHistory: {
        history: {
          entitiesByKey: {
            "tail:0:local:current": {
              turnId: "turn_repeated_progress",
              status: "inProgress",
              items: [
                {
                  type: "commandExecution",
                  id: "command_1",
                  status: "completed",
                  commandActions: [{ type: "unknown", command: "pwd" }],
                },
                {
                  type: "commandExecution",
                  id: "command_2",
                  status: "completed",
                  commandActions: [{ type: "unknown", command: "git status" }],
                },
                { type: "reasoning", id: "thinking_1", summary: ["Thinking through the task"] },
                { type: "reasoning", id: "thinking_2", summary: ["Considering the task"] },
                { type: "reasoning", id: "testing_1", summary: ["Running tests"] },
                { type: "reasoning", id: "planning_1", summary: ["Planning next steps"] },
                { type: "reasoning", id: "planning_2", summary: ["Designing next steps"] },
                { type: "reasoning", id: "planning_3", summary: ["Planning the next action"] },
                { type: "reasoning", id: "testing_2", summary: ["Testing the implementation"] },
              ],
            },
          },
        },
      },
    });

    expect(progress).toEqual([
      {
        id: "command_2",
        turnId: "turn_repeated_progress",
        kind: "command",
        status: "completed",
        text: "已运行命令",
      },
      {
        id: "thinking_2",
        turnId: "turn_repeated_progress",
        kind: "reasoning",
        status: "completed",
        text: "继续分析任务",
      },
      {
        id: "planning_3",
        turnId: "turn_repeated_progress",
        kind: "reasoning",
        status: "completed",
        text: "规划下一步处理",
      },
      {
        id: "testing_2",
        turnId: "turn_repeated_progress",
        kind: "reasoning",
        status: "completed",
        text: "运行并检查测试",
      },
    ]);
  });

  test("uses only the latest active desktop tail and caps noisy activity", () => {
    const items = Array.from({ length: 16 }, (_, index) => ({
      type: "fileChange",
      id: `file_${index}`,
      status: index === 15 ? "inProgress" : "completed",
      changes: Array.from({ length: index + 1 }, (_, changeIndex) => ({
        path: `/tmp/file-${index}-${changeIndex}.txt`,
      })),
    }));
    const progress = extractCodexDesktopThreadProgress({
      threadRuntimeStatus: { type: "active", activeFlags: [] },
      turnHistory: {
        history: {
          entitiesByKey: {
            "tail:0:local:stale": {
              turnId: "turn_stale",
              status: "completed",
              items: [{
                type: "reasoning",
                id: "stale_reason",
                summary: ["不要显示"],
              }],
            },
            "tail:0:local:current": {
              turnId: "turn_current",
              status: "inProgress",
              items,
            },
          },
        },
      },
    });

    expect(progress).toHaveLength(10);
    expect(progress.some((item) => item.turnId === "turn_stale")).toBe(false);
    expect(progress.at(-1)).toMatchObject({
      id: "file_15",
      status: "running",
      text: "正在修改 16 个文件",
    });
  });

  test("uses the first pending plan step when Codex has not marked one in progress yet", () => {
    expect(
      extractCodexDesktopThreadProgress({
        threadRuntimeStatus: { type: "active", activeFlags: [] },
        turnHistory: {
          history: {
            entitiesByKey: {
              "tail:0:local:current": {
                turnId: "turn_pending_plan",
                status: "inProgress",
                items: [{
                  type: "todo-list",
                  id: "plan_pending",
                  plan: [
                    { step: "检查现有实现", status: "completed" },
                    { step: "同步网页进展", status: "pending" },
                    { step: "运行回归测试", status: "pending" },
                  ],
                }],
              },
            },
          },
        },
      }),
    ).toEqual([{
      id: "plan_pending",
      turnId: "turn_pending_plan",
      kind: "plan",
      status: "running",
      text: "第 2 / 3 步 · 同步网页进展",
    }]);
  });
});

describe("Codex desktop latest conversation message", () => {
  test("extracts the complete visible conversation in chronological order", () => {
    expect(
      extractCodexThreadMessages({
        thread: {
          turns: [
            {
              id: "turn_1",
              items: [
                {
                  id: "user_1",
                  type: "userMessage",
                  content: [
                    {
                      type: "text",
                      text: '<app-context>hidden</app-context>\n做一个移动端页面',
                    },
                  ],
                },
                {
                  id: "assistant_1",
                  type: "agentMessage",
                  phase: "commentary",
                  text: "正在梳理接口。",
                },
                {
                  id: "assistant_2",
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "已经完成。",
                },
              ],
            },
          ],
        },
      }),
    ).toEqual([
      {
        role: "user",
        text: "做一个移动端页面",
        id: "user_1",
        turnId: "turn_1",
      },
      {
        role: "assistant",
        text: "正在梳理接口。",
        id: "assistant_1",
        turnId: "turn_1",
        phase: "commentary",
      },
      {
        role: "assistant",
        text: "已经完成。",
        id: "assistant_2",
        turnId: "turn_1",
        phase: "final_answer",
      },
    ]);
  });

  test("returns the latest final assistant message from the newest turn", () => {
    expect(
      extractLatestCodexThreadMessage({
        thread: {
          turns: [
            {
              items: [
                {
                  type: "userMessage",
                  content: [{ type: "text", text: "Earlier question" }],
                },
                {
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "Earlier answer",
                },
              ],
            },
            {
              items: [
                {
                  type: "userMessage",
                  content: [{ type: "text", text: "Latest question" }],
                },
                { type: "commandExecution", command: "npm test" },
                {
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "Latest answer",
                },
              ],
            },
          ],
        },
      }),
    ).toEqual({ role: "assistant", text: "Latest answer" });
  });

  test("returns the latest assistant commentary from an interrupted turn", () => {
    expect(
      extractLatestCodexThreadMessage({
        thread: {
          turns: [
            {
              status: "interrupted",
              items: [
                {
                  type: "userMessage",
                  content: [
                    {
                      type: "text",
                      text: '<in-app-browser-context source="ambient-ui-state">automatic context</in-app-browser-context>\n把按钮改成页签',
                    },
                  ],
                },
                {
                  type: "agentMessage",
                  phase: "commentary",
                  text: "已定位到旧代码仍在运行，下一步会刷新服务。",
                },
              ],
            },
          ],
        },
      }),
    ).toEqual({
      role: "assistant",
      text: "已定位到旧代码仍在运行，下一步会刷新服务。",
    });
  });

  test("hides WeChat attachment transport instructions from visible user messages", () => {
    expect(
      extractLatestCodexThreadMessage({
        thread: {
          turns: [{
            items: [{
              type: "userMessage",
              content: [{
                type: "text",
                text: [
                  "[WeRelay WeChat note]",
                  "Your final reply will be forwarded back to a WeChat chat.",
                  "file C:\\Users\\example\\Desktop\\document.docx",
                  "",
                  "[User request]",
                  "把桌面的文档发给我",
                ].join("\n"),
              }],
            }],
          }],
        },
      }),
    ).toEqual({
      role: "user",
      text: "把桌面的文档发给我",
    });
  });

  test("hides desktop attachment transport headings from visible user messages", () => {
    expect(
      extractLatestCodexThreadMessage({
        thread: {
          turns: [{
            items: [{
              type: "userMessage",
              content: [{
                type: "text",
                text: [
                  "# Files mentioned by the user:",
                  "## screenshot.png: /private/tmp/screenshot.png",
                  "## My request for Codex:",
                  "请检查这个页面。",
                  '<image name=[Image #1] path="/private/tmp/screenshot.png">',
                  '[local image: /private/tmp/screenshot.png]',
                ].join("\n"),
              }],
            }],
          }],
        },
      }),
    ).toEqual({
      role: "user",
      text: "图片：png1\n请检查这个页面。",
    });
  });

  test("strips injected desktop context before returning a latest user message", () => {
    expect(
      extractLatestCodexThreadMessage({
        thread: {
          turns: [
            {
              items: [
                {
                  type: "userMessage",
                  content: [
                    {
                      type: "text",
                      text: '<in-app-browser-context source="ambient-ui-state">automatic context</in-app-browser-context>\nContinue from this request',
                    },
                  ],
                },
                { type: "commandExecution", command: "git status" },
              ],
            },
          ],
        },
      }),
    ).toEqual({ role: "user", text: "Continue from this request" });
  });

  test("ignores an injected context-only user message", () => {
    expect(
      extractLatestCodexThreadMessage({
        thread: {
          turns: [
            {
              items: [
                {
                  type: "userMessage",
                  content: [
                    {
                      type: "text",
                      text: '<in-app-browser-context source="ambient-ui-state">automatic context</in-app-browser-context>',
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    ).toBeNull();
  });

  test("ignores injected AGENTS instructions recorded as a user message", () => {
    expect(
      extractLatestCodexThreadMessage({
        thread: {
          turns: [{
            items: [{
              type: "userMessage",
              content: [{
                type: "text",
                text: [
                  "# AGENTS.md instructions",
                  "",
                  "<INSTRUCTIONS>",
                  "始终使用中文对话",
                  "</INSTRUCTIONS>",
                  "<environment_context>internal environment</environment_context>",
                ].join("\n"),
              }],
            }],
          }],
        },
      }),
    ).toBeNull();
  });

  test("ignores model handoff summaries recorded as user messages", () => {
    expect(
      extractLatestCodexThreadMessage({
        thread: {
          turns: [{
            items: [{
              type: "userMessage",
              content: [{
                type: "text",
                text: "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model.\nInternal handoff details.",
              }],
            }],
          }],
        },
      }),
    ).toBeNull();
  });

  test("returns null when the thread has no visible conversation message", () => {
    expect(
      extractLatestCodexThreadMessage({
        thread: {
          turns: [{ items: [{ type: "commandExecution", command: "git status" }] }],
        },
      }),
    ).toBeNull();
  });
});


describe("Codex parallel desktop task switching", () => {
  test("interrupts a running background desktop task without switching tasks", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const interrupted: Array<{ threadId: string; turnId: string }> = [];
    adapter.desktopIpcClient = {
      interruptTurn: async (threadId: string, turnId: string) => {
        interrupted.push({ threadId, turnId });
      },
    };
    adapter.sharedThreadId = "thread_b";
    adapter.state.sharedThreadId = "thread_b";
    adapter.activeTurn = { threadId: "thread_b", turnId: "turn_b", origin: "local" };
    adapter.backgroundTurns.set("turn_a", {
      threadId: "thread_a",
      turnId: "turn_a",
      origin: "wechat",
    });

    expect(await adapter.interruptSession("thread_a")).toBe(true);
    expect(interrupted).toEqual([{ threadId: "thread_a", turnId: "turn_a" }]);
    expect(adapter.sharedThreadId).toBe("thread_b");
    expect(adapter.activeTurn?.turnId).toBe("turn_b");
  });

  test("keeps the previous task running when switching and starts work in the new task", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
    }) as any;
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    adapter.sharedThreadId = "thread_a";
    adapter.state.sharedSessionId = "thread_a";
    adapter.state.sharedThreadId = "thread_a";
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_a",
      turnId: "turn_a",
      origin: "wechat",
    };
    adapter.state.activeTurnId = "turn_a";
    adapter.state.activeTurnOrigin = "wechat";
    adapter.bridgeOwnedTurnIds.add("turn_a");
    adapter.desktopThreadCwdById.set("thread_b", process.cwd());
    adapter.sendRpcRequest = async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "thread/resume") {
        return { thread: { id: "thread_b" } };
      }
      if (method === "turn/start") {
        return { turn: { id: "turn_b" } };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    };

    await adapter.resumeSession("thread_b");
    await adapter.sendInput("继续处理第二个任务");

    expect(requests.some((request) => request.method === "turn/interrupt")).toBe(false);
    expect(adapter.backgroundTurns.get("turn_a")).toEqual({
      threadId: "thread_a",
      turnId: "turn_a",
      origin: "wechat",
    });
    expect(adapter.activeTurn).toEqual({
      threadId: "thread_b",
      turnId: "turn_b",
      origin: "wechat",
    });
    expect(adapter.state.status).toBe("busy");
  });

  test("emits a labelled background completion without disturbing the selected task", () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
    }) as any;
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.sharedThreadId = "thread_b";
    adapter.state.sharedSessionId = "thread_b";
    adapter.state.sharedThreadId = "thread_b";
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_b",
      turnId: "turn_b",
      origin: "wechat",
    };
    adapter.state.activeTurnId = "turn_b";
    adapter.state.activeTurnOrigin = "wechat";
    adapter.backgroundTurns.set("turn_a", {
      threadId: "thread_a",
      turnId: "turn_a",
      origin: "wechat",
    });
    adapter.bridgeOwnedTurnIds.add("turn_a");
    adapter.turnFinalMessages.set(
      "turn_a",
      new Map([["message_a", "第一个任务已经完成"]]),
    );

    adapter.handleTurnCompleted(
      { threadId: "thread_a", turnId: "turn_a", origin: "wechat" },
      { turn: { id: "turn_a", status: "completed" } },
    );

    expect(events.find((event) => event.type === "final_reply")).toMatchObject({
      type: "final_reply",
      text: "第一个任务已经完成",
      threadId: "thread_a",
      turnId: "turn_a",
    });
    expect(adapter.activeTurn?.turnId).toBe("turn_b");
    expect(adapter.state.status).toBe("busy");
  });

  test("continues tracking a desktop-started task after switching away", () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
    }) as any;
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.sharedThreadId = "thread_b";
    adapter.state.sharedSessionId = "thread_b";
    adapter.state.sharedThreadId = "thread_b";
    adapter.state.status = "idle";
    adapter.backgroundTurns.set("turn_local_a", {
      threadId: "thread_a",
      turnId: "turn_local_a",
      origin: "local",
    });
    adapter.turnFinalMessages.set(
      "turn_local_a",
      new Map([["message_local_a", "桌面端启动的第一个任务已经完成"]]),
    );

    adapter.handleRpcNotification("turn/completed", {
      threadId: "thread_a",
      turn: {
        id: "turn_local_a",
        status: "completed",
      },
    });

    expect(events.find((event) => event.type === "final_reply")).toMatchObject({
      type: "final_reply",
      text: "桌面端启动的第一个任务已经完成",
      threadId: "thread_a",
      turnId: "turn_local_a",
      origin: "local",
    });
    expect(adapter.backgroundTurns.has("turn_local_a")).toBe(false);
    expect(adapter.sharedThreadId).toBe("thread_b");
  });

  test("resolves approvals and user input only for the labelled task", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
    }) as any;
    const sentMessages: Array<Record<string, unknown>> = [];
    adapter.sendRpcMessage = (payload: Record<string, unknown>) => {
      sentMessages.push(payload);
    };
    adapter.pendingApprovalRequests = [
      {
        requestId: 1,
        method: "item/commandExecution/requestApproval",
        threadId: "thread_a",
        turnId: "turn_a",
        origin: "wechat",
        params: {},
        request: {
          source: "codex",
          summary: "审批 A",
          commandPreview: "command a",
        },
      },
      {
        requestId: 2,
        method: "item/commandExecution/requestApproval",
        threadId: "thread_b",
        turnId: "turn_b",
        origin: "wechat",
        params: {},
        request: {
          source: "codex",
          summary: "审批 B",
          commandPreview: "command b",
        },
      },
    ];
    adapter.pendingUserInputRequests = [
      {
        requestId: 3,
        method: "item/tool/requestUserInput",
        threadId: "thread_a",
        turnId: "turn_a",
        origin: "wechat",
        request: {
          summary: "输入 A",
          questions: [],
        },
      },
      {
        requestId: 4,
        method: "item/tool/requestUserInput",
        threadId: "thread_b",
        turnId: "turn_b",
        origin: "wechat",
        request: {
          summary: "输入 B",
          questions: [],
        },
      },
    ];

    expect(await adapter.resolveTaskApprovals("thread_a", "confirm")).toBe(1);
    expect(await adapter.submitTaskUserInput("thread_a", { question_a: ["答案"] })).toBe(
      true,
    );

    expect(sentMessages).toEqual([
      { id: 1, result: { decision: "accept" } },
      {
        id: 3,
        result: {
          answers: {
            question_a: { answers: ["答案"] },
          },
        },
      },
    ]);
    expect(adapter.pendingApprovalRequests.map((request: any) => request.threadId)).toEqual([
      "thread_b",
    ]);
    expect(adapter.pendingUserInputRequests.map((request: any) => request.threadId)).toEqual([
      "thread_b",
    ]);
  });
});

describe("Codex desktop application launch policy", () => {
  test("never launches ChatGPT when desktop application launch is disabled", () => {
    expect(shouldAttemptCodexDesktopApplicationLaunch({
      allowDesktopApplicationLaunch: false,
      nowMs: 120_000,
      lastLaunchAtMs: 0,
      backoffUntilMs: 0,
    })).toBe(false);
  });

  test("allows an explicit desktop launch only when the retry window is open", () => {
    expect(shouldAttemptCodexDesktopApplicationLaunch({
      allowDesktopApplicationLaunch: true,
      nowMs: 120_000,
      lastLaunchAtMs: 0,
      backoffUntilMs: 0,
    })).toBe(true);
    expect(shouldAttemptCodexDesktopApplicationLaunch({
      allowDesktopApplicationLaunch: true,
      nowMs: 120_000,
      lastLaunchAtMs: 119_500,
      backoffUntilMs: 0,
    })).toBe(false);
  });
});

describe("Codex desktop IPC transport", () => {
  test("recovers a runtime desktop metadata app-server exit without failing the desktop slot", () => {
    expect(resolveCodexAppServerFailureAction({
      expectedShutdown: false,
      usesDesktopTransport: true,
      desktopTransportStarted: true,
    })).toBe("recover_metadata");
  });

  test("does not hide desktop metadata startup failures before the desktop slot is ready", () => {
    expect(resolveCodexAppServerFailureAction({
      expectedShutdown: false,
      usesDesktopTransport: true,
      desktopTransportStarted: false,
    })).toBe("fatal");
  });

  test("keeps standalone app-server failures fatal", () => {
    expect(resolveCodexAppServerFailureAction({
      expectedShutdown: false,
      usesDesktopTransport: false,
      desktopTransportStarted: true,
    })).toBe("fatal");
  });

  test("suppresses app-server failures during an expected shutdown", () => {
    expect(resolveCodexAppServerFailureAction({
      expectedShutdown: true,
      usesDesktopTransport: true,
      desktopTransportStarted: true,
    })).toBe("suppress");
  });

  test("delays desktop metadata recovery so daemon shutdown can win the signal race", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const recoveries: string[] = [];
    const events: Array<{ type: string }> = [];
    adapter.desktopTransportStarted = true;
    adapter.desktopMetadataRecoveryGraceMs = 5;
    adapter.recoverDesktopMetadataAppServer = async (reason: string) => {
      recoveries.push(reason);
      return true;
    };
    adapter.setEventSink((event: { type: string }) => events.push(event));

    adapter.handleUnexpectedAppServerFailure(
      "codex app-server exited unexpectedly with code 0.",
    );
    adapter.shuttingDown = true;
    await wait(15);

    expect(recoveries).toEqual([]);
    expect(events.some((event) => event.type === "fatal_error")).toBe(false);
  });

  test("restarts only the desktop metadata helper after an unexpected runtime exit", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const recoveries: string[] = [];
    const events: Array<{ type: string }> = [];
    adapter.desktopTransportStarted = true;
    adapter.desktopMetadataRecoveryGraceMs = 1;
    adapter.recoverDesktopMetadataAppServer = async (reason: string) => {
      recoveries.push(reason);
      return true;
    };
    adapter.setEventSink((event: { type: string }) => events.push(event));

    adapter.handleUnexpectedAppServerFailure(
      "codex app-server exited unexpectedly with code 0.",
    );
    await wait(10);

    expect(recoveries).toEqual([
      "codex app-server exited unexpectedly with code 0.",
    ]);
    expect(events.some((event) => event.type === "fatal_error")).toBe(false);
    expect(adapter.shuttingDown).toBe(false);
  });

  test("routes a desktop metadata websocket close into helper recovery instead of fatal", () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const recoveries: string[] = [];
    const events: Array<{ type: string }> = [];
    adapter.desktopTransportStarted = true;
    adapter.appServer = null;
    adapter.appServerPort = null;
    adapter.scheduleDesktopMetadataRecovery = (reason: string) => {
      recoveries.push(reason);
    };
    adapter.setEventSink((event: { type: string }) => events.push(event));

    adapter.handleRpcSocketClosed();

    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).toContain("websocket closed");
    expect(events.some((event) => event.type === "fatal_error")).toBe(false);
    expect(adapter.shuttingDown).toBe(false);
  });

  test("does not let a stale RPC connection attempt close the recovered metadata socket", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const oldAppServer = {};
    const recoveredAppServer = {};
    let oldSocketCloses = 0;
    let recoveredSocketCloses = 0;
    let replacementSocketCloses = 0;
    let openAttempts = 0;
    let initializeAttempts = 0;
    const createSocket = (onClose: () => void) => {
      const closeListeners: Array<() => void> = [];
      return {
        readyState: WebSocket.OPEN,
        addEventListener: (type: string, listener: () => void) => {
          if (type === "close") {
            closeListeners.push(listener);
          }
        },
        close() {
          this.readyState = WebSocket.CLOSED;
          onClose();
          for (const listener of closeListeners) {
            listener();
          }
        },
      };
    };
    const oldSocket = createSocket(() => {
      oldSocketCloses += 1;
    });
    const recoveredSocket = createSocket(() => {
      recoveredSocketCloses += 1;
    });
    const replacementSocket = createSocket(() => {
      replacementSocketCloses += 1;
    });

    adapter.appServer = oldAppServer;
    adapter.appServerPort = 1111;
    adapter.appServerAuthToken = "old-token";
    adapter.rpcSocket = null;
    adapter.openRpcSocket = async () => {
      openAttempts += 1;
      return openAttempts === 1 ? oldSocket : replacementSocket;
    };
    adapter.attachRpcSocket = (socket: WebSocket) => {
      adapter.rpcSocket = socket;
    };
    adapter.initializeRpcClient = async () => {
      initializeAttempts += 1;
      if (initializeAttempts !== 1) {
        return;
      }
      adapter.appServer = recoveredAppServer;
      adapter.appServerPort = 2222;
      adapter.appServerAuthToken = "recovered-token";
      adapter.rpcSocket = recoveredSocket;
      throw new Error("stale initialize failed");
    };

    await adapter.connectRpcClient();

    expect(openAttempts).toBe(1);
    expect(adapter.rpcSocket).toBe(recoveredSocket);
    expect(oldSocketCloses).toBe(1);
    expect(recoveredSocketCloses).toBe(0);
    expect(replacementSocketCloses).toBe(0);
  });

  test("reconnects the desktop metadata helper on demand before an RPC read", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    let recoveries = 0;
    adapter.desktopTransportStarted = true;
    adapter.appServer = null;
    adapter.appServerPort = null;
    adapter.rpcSocket = null;
    adapter.recoverDesktopMetadataAppServer = async () => {
      recoveries += 1;
      adapter.appServer = {};
      adapter.appServerPort = 12345;
      adapter.rpcSocket = { readyState: WebSocket.OPEN };
      return true;
    };

    await adapter.ensureRpcClientConnected();

    expect(recoveries).toBe(1);
    expect(adapter.rpcSocket.readyState).toBe(WebSocket.OPEN);
  });

  test("uses the ChatGPT-bundled Codex for desktop metadata app-server", () => {
    const bundledCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const target = resolveCodexDesktopAppServerSpawnTarget("codex", {
      platform: "darwin",
      env: {
        HOME: "/Users/tester",
        PATH: "/Users/tester/.nvm/versions/node/v22.16.0/bin:/usr/bin:/bin",
      },
      isExecutable: (candidate) => candidate === bundledCodex,
    });

    expect(target).toEqual({ file: bundledCodex, args: [] });
  });

  test("respects an explicitly configured Codex command in desktop mode", () => {
    const customCodex = "/opt/custom/bin/codex";
    const target = resolveCodexDesktopAppServerSpawnTarget(customCodex, {
      platform: "darwin",
      env: { PATH: "/usr/bin:/bin" },
      isExecutable: () => true,
    });

    expect(target).toEqual({ file: customCodex, args: [] });
  });

  test("does not relaunch ChatGPT when its main process is already running", async () => {
    let connectAttempts = 0;
    let launchCount = 0;
    const client = {
      connect: async () => {
        connectAttempts += 1;
        if (connectAttempts === 1) {
          throw new Error("ipc unavailable");
        }
      },
    };

    await connectCodexDesktopIpcClientWithLaunch(client, {
      platform: "darwin",
      allowDesktopApplicationLaunch: true,
      isDesktopMainProcessRunning: async () => true,
      launchDesktopApp: () => {
        launchCount += 1;
      },
      retryIntervalMs: 1,
      startupTimeoutMs: 20,
    });

    expect(connectAttempts).toBe(2);
    expect(launchCount).toBe(0);
  });

  test("keeps ChatGPT closed when desktop auto-launch is disabled", async () => {
    let connectAttempts = 0;
    let launchCount = 0;
    const client = {
      connect: async () => {
        connectAttempts += 1;
        if (connectAttempts === 1) {
          throw new Error("ipc unavailable");
        }
      },
    };

    await connectCodexDesktopIpcClientWithLaunch(client, {
      platform: "darwin",
      allowDesktopApplicationLaunch: false,
      isDesktopMainProcessRunning: async () => false,
      launchDesktopApp: () => {
        launchCount += 1;
      },
      retryIntervalMs: 1,
      startupTimeoutMs: 20,
    });

    expect(connectAttempts).toBe(2);
    expect(launchCount).toBe(0);
  });

  test("launches ChatGPT once when its main process is absent", async () => {
    let connectAttempts = 0;
    let launchCount = 0;
    const client = {
      connect: async () => {
        connectAttempts += 1;
        if (connectAttempts === 1) {
          throw new Error("ipc unavailable");
        }
      },
    };

    await connectCodexDesktopIpcClientWithLaunch(client, {
      platform: "darwin",
      allowDesktopApplicationLaunch: true,
      isDesktopMainProcessRunning: async () => false,
      launchDesktopApp: () => {
        launchCount += 1;
      },
      retryIntervalMs: 1,
      startupTimeoutMs: 20,
    });

    expect(connectAttempts).toBe(2);
    expect(launchCount).toBe(1);
  });

  test("does not attempt to launch a desktop app on non-macOS platforms", async () => {
    let launchCount = 0;

    await expect(connectCodexDesktopIpcClientWithLaunch({
      connect: async () => {
        throw new Error("ipc unavailable");
      },
    }, {
      platform: "linux",
      allowDesktopApplicationLaunch: true,
      isDesktopMainProcessRunning: async () => false,
      launchDesktopApp: () => {
        launchCount += 1;
      },
      retryIntervalMs: 1,
      startupTimeoutMs: 5,
    })).rejects.toThrow("ipc unavailable");

    expect(launchCount).toBe(0);
  });

  test("recognizes only the ChatGPT desktop main process", () => {
    expect(
      isCodexDesktopMainProcessCommandLine(
        "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      ),
    ).toBe(true);
    expect(
      isCodexDesktopMainProcessCommandLine(
        "/Applications/ChatGPT.app/Contents/Resources/codex app-server",
      ),
    ).toBe(false);
    expect(
      isCodexDesktopMainProcessCommandLine(
        "/Applications/ChatGPT.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper",
      ),
    ).toBe(false);
  });

  test("uses desktop transport for the bridge-owned Codex runtime host", () => {
    const runtime = createRuntimeHost({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
    }) as any;

    expect(runtime.options.renderMode).toBe("headless");
    expect(runtime.options.codexTransport).toBe(
      process.platform === "darwin" ? "desktop" : "app-server",
    );
    expect(runtime.getLocalClientEndpoint()).toBeNull();
  });

  test("finishes desktop runtime startup in an idle state", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    adapter.startAppServer = async () => undefined;
    adapter.connectRpcClient = async () => undefined;
    adapter.startDesktopIpcClient = async () => undefined;
    adapter.restoreInitialSharedThreadIfNeeded = async () => undefined;
    adapter.afterStart = () => undefined;

    await adapter.start();

    expect(adapter.getState().status).toBe("idle");
  });

  test("restores the remembered desktop task in the background without changing Codex focus", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
      sessionStartMode: "restore",
      initialSharedSessionId: "thread_remembered",
    }) as any;
    const opened: string[] = [];
    const followed: Array<{ threadId: string; retention?: string }> = [];
    adapter.desktopIpcClient = {
      openThread: async (threadId: string) => {
        opened.push(threadId);
      },
      followThread: async (
        threadId: string,
        options?: { retention?: string },
      ) => {
        followed.push({ threadId, retention: options?.retention });
      },
    };

    await adapter.restoreInitialSharedThreadIfNeeded();

    expect(opened).toEqual([]);
    expect(followed).toEqual([{
      threadId: "thread_remembered",
      retention: "summary",
    }]);
    expect(adapter.getState().sharedThreadId).toBe("thread_remembered");
  });

  test("never falls back to mutating the independent app-server", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;

    await expect(
      adapter.sendRpcRequest("turn/start", {
        threadId: "thread_1",
        input: [{ type: "text", text: "不能分叉" }],
      }),
    ).rejects.toThrow("禁止通过独立 app-server 执行写操作");
  });

  test("reads the current desktop model, validates options, and applies the selected model to the next turn", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const starts: Array<{ threadId: string; text: string; model?: string }> = [];
    adapter.sendRpcRequest = async (method: string) => {
      if (method !== "model/list") throw new Error(`Unexpected RPC method: ${method}`);
      return {
        data: [
          {
            id: "model-sol",
            model: "gpt-5.6-sol",
            displayName: "GPT-5.6 Sol",
            description: "均衡模型",
            hidden: false,
          },
          {
            id: "model-terra",
            model: "gpt-5.6-terra",
            displayName: "GPT-5.6 Terra",
            description: "深度推理",
            hidden: false,
          },
        ],
        nextCursor: null,
      };
    };
    adapter.desktopIpcClient = {
      getThreadStateView: () => ({
        latestModel: "gpt-5.6-sol",
        latestThreadSettings: { model: "gpt-5.6-sol" },
        threadRuntimeStatus: { type: "idle" },
      }),
      startTurn: async (threadId: string, text: string, options?: { model?: string }) => {
        starts.push({ threadId, text, model: options?.model });
        return { id: "turn-model", status: "inProgress" };
      },
    };
    adapter.getQueuedTaskInputs = () => [];
    adapter.getSessionMessagePage = async () => ({
      messages: [{ role: "assistant", text: "上一轮已完成" }],
      hasMore: false,
      nextBefore: null,
    });

    expect(await adapter.getSessionModelState("thread-model")).toEqual({
      currentModel: "gpt-5.6-sol",
      options: [
        {
          id: "gpt-5.6-sol",
          label: "GPT-5.6 Sol",
          description: "均衡模型",
        },
        {
          id: "gpt-5.6-terra",
          label: "GPT-5.6 Terra",
          description: "深度推理",
        },
      ],
      canChange: true,
    });
    await expect(
      adapter.setSessionModel("thread-model", "not-a-real-model"),
    ).rejects.toThrow("这个模型当前不可用");
    expect(await adapter.setSessionModel("thread-model", "gpt-5.6-terra"))
      .toMatchObject({ currentModel: "gpt-5.6-terra", canChange: true });

    await adapter.sendInputToSession("thread-model", "使用新模型继续");
    expect(starts).toEqual([{
      threadId: "thread-model",
      text: "使用新模型继续",
      model: "gpt-5.6-terra",
    }]);
  });

  test("does not allow changing a Codex model while that task is running", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    adapter.sendRpcRequest = async () => ({
      data: [{ id: "model-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", hidden: false }],
      nextCursor: null,
    });
    adapter.desktopIpcClient = {
      getThreadStateView: () => ({
        latestModel: "gpt-5.6-sol",
        threadRuntimeStatus: { type: "active", activeFlags: [] },
      }),
    };

    expect(await adapter.getSessionModelState("thread-running")).toMatchObject({
      currentModel: "gpt-5.6-sol",
      canChange: false,
      unavailableReason: "任务正在处理，完成或停止后再切换模型。",
    });
    await expect(
      adapter.setSessionModel("thread-running", "gpt-5.6-sol"),
    ).rejects.toThrow("任务正在处理，完成或停止后再切换模型");
  });

  test("creates a canonical task and hands it to the desktop owner", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const rpcCalls: Array<{ method: string; params: unknown }> = [];
    const desktopCalls: Array<{ method: string; threadId: string; text?: string }> = [];
    const handoffEvents: string[] = [];
    let bootstrapWriterReleased = false;
    adapter.sendRpcRequest = async (method: string, params: unknown) => {
      rpcCalls.push({ method, params });
      if (method === "thread/start") {
        handoffEvents.push("private:start");
        return { thread: { id: "thread_new" } };
      }
      if (method === "thread/unsubscribe") {
        handoffEvents.push("private:unsubscribe");
        bootstrapWriterReleased = true;
        return {};
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    };
    adapter.desktopIpcClient = {
      openAndFollowThread: async (threadId: string) => {
        handoffEvents.push("desktop:open");
        expect(bootstrapWriterReleased).toBe(true);
        desktopCalls.push({ method: "open", threadId });
        return {};
      },
      startTurn: async (threadId: string, text: string) => {
        desktopCalls.push({ method: "start", threadId, text });
        return { id: "turn_new", status: "inProgress" };
      },
    };

    await adapter.createSession();
    await adapter.sendInput("开始新任务");

    expect(adapter.getState().sharedThreadId).toBe("thread_new");
    expect(adapter.desktopBootstrapThreadIds.has("thread_new")).toBe(false);
    expect(rpcCalls.map((call) => call.method)).toContain("thread/start");
    expect(rpcCalls.map((call) => call.method)).toContain("thread/unsubscribe");
    expect(rpcCalls.map((call) => call.method)).not.toContain("turn/start");
    expect(handoffEvents).toEqual([
      "private:start",
      "private:unsubscribe",
      "desktop:open",
    ]);
    expect(desktopCalls).toEqual([
      { method: "open", threadId: "thread_new" },
      { method: "start", threadId: "thread_new", text: "开始新任务" },
    ]);
  });

  test("creates a new desktop task in the source task project directory", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: "/workspace/default",
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    adapter.desktopThreadCwdById.set("thread_source", "/workspace/project-a");
    adapter.sendRpcRequest = async (method: string, params: Record<string, unknown>) => {
      rpcCalls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread_project_new" } };
      if (method === "thread/unsubscribe") return {};
      throw new Error(`Unexpected RPC method: ${method}`);
    };
    adapter.desktopIpcClient = {
      openAndFollowThread: async () => ({}),
    };

    await adapter.createSessionInProject("thread_source");

    expect(rpcCalls[0]).toMatchObject({
      method: "thread/start",
      params: { cwd: "/workspace/project-a" },
    });
    expect(adapter.getState().sharedThreadId).toBe("thread_project_new");
  });

  test("keeps a newly created canonical task usable while the desktop is locked", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const rpcCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    adapter.sendRpcRequest = async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      rpcCalls.push({ method, params });
      if (method === "thread/start" || method === "thread/resume") {
        return { thread: { id: "thread_locked" } };
      }
      if (method === "thread/unsubscribe") {
        return {};
      }
      if (method === "turn/start") {
        return { turn: { id: "turn_locked" } };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    };
    adapter.desktopIpcClient = {
      openAndFollowThread: async () => {
        throw new Error("The Mac is locked");
      },
      startTurn: async () => {
        throw new Error("锁屏时不应调用桌面 startTurn");
      },
    };

    await adapter.createSession();
    await adapter.sendInput("锁屏后也要开始");

    expect(adapter.desktopBootstrapThreadIds.has("thread_locked")).toBe(true);
    expect(rpcCalls.map((call) => call.method)).toEqual([
      "thread/start",
      "thread/unsubscribe",
      "thread/resume",
      "thread/unsubscribe",
      "thread/resume",
      "turn/start",
    ]);
    expect(rpcCalls.at(-1)?.params).toMatchObject({
      threadId: "thread_locked",
      input: [{ type: "text", text: "锁屏后也要开始" }],
    });
    expect(adapter.activeTurn).toEqual({
      threadId: "thread_locked",
      turnId: "turn_locked",
      origin: "wechat",
    });
  });

  test("keeps bootstrap approvals, input requests, and interrupts on the canonical owner", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const rpcMessages: Array<Record<string, unknown>> = [];
    const rpcCalls: Array<{ method: string; params: unknown }> = [];
    const desktopResponses: string[] = [];
    adapter.desktopBootstrapThreadIds.add("thread_bootstrap");
    adapter.sharedThreadId = "thread_bootstrap";
    adapter.state.sharedSessionId = "thread_bootstrap";
    adapter.state.sharedThreadId = "thread_bootstrap";
    adapter.sendRpcMessage = (payload: Record<string, unknown>) => {
      rpcMessages.push(payload);
    };
    adapter.sendRpcRequest = async (method: string, params: unknown) => {
      rpcCalls.push({ method, params });
      return {};
    };
    adapter.desktopIpcClient = {
      replyToCommandApproval: async () => desktopResponses.push("approval"),
      submitUserInput: async () => desktopResponses.push("input"),
    };
    adapter.pendingApprovalRequests = [{
      requestId: 21,
      method: "item/commandExecution/requestApproval",
      threadId: "thread_bootstrap",
      turnId: "turn_bootstrap",
      origin: "wechat",
      params: {},
      request: {
        source: "codex",
        summary: "允许执行",
        commandPreview: "echo ok",
      },
    }];
    adapter.pendingUserInputRequests = [{
      requestId: 22,
      method: "item/tool/requestUserInput",
      threadId: "thread_bootstrap",
      turnId: "turn_bootstrap",
      origin: "wechat",
      request: { summary: "请补充", questions: [] },
    }];
    adapter.activeTurn = {
      threadId: "thread_bootstrap",
      turnId: "turn_bootstrap",
      origin: "wechat",
    };

    expect(await adapter.resolveTaskApprovals("thread_bootstrap", "confirm")).toBe(1);
    expect(await adapter.submitTaskUserInput("thread_bootstrap", { q: ["答案"] })).toBe(true);
    await adapter.requestActiveTurnInterrupt();

    expect(desktopResponses).toEqual([]);
    expect(rpcMessages).toEqual([
      { id: 21, result: { decision: "accept" } },
      { id: 22, result: { answers: { q: { answers: ["答案"] } } } },
    ]);
    expect(rpcCalls).toEqual([{
      method: "turn/interrupt",
      params: { threadId: "thread_bootstrap", turnId: "turn_bootstrap" },
    }]);
  });

  test("switches tasks and starts the next turn through the desktop owner", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const calls: Array<{ method: string; threadId: string; text?: string }> = [];
    adapter.desktopIpcClient = {
      openThread: async (threadId: string) => {
        calls.push({ method: "open", threadId });
      },
      startTurn: async (threadId: string, text: string) => {
        calls.push({ method: "start", threadId, text });
        return { id: "turn_b", status: "inProgress" };
      },
    };
    adapter.sharedThreadId = "thread_a";
    adapter.state.sharedSessionId = "thread_a";
    adapter.state.sharedThreadId = "thread_a";
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_a",
      turnId: "turn_a",
      origin: "wechat",
    };
    adapter.state.activeTurnId = "turn_a";
    adapter.state.activeTurnOrigin = "wechat";
    adapter.bridgeOwnedTurnIds.add("turn_a");

    await adapter.resumeSession("thread_b");
    await adapter.sendInput("从微信继续处理");

    expect(calls).toEqual([
      { method: "open", threadId: "thread_b" },
      { method: "start", threadId: "thread_b", text: "从微信继续处理" },
    ]);
    expect(adapter.backgroundTurns.get("turn_a")).toEqual({
      threadId: "thread_a",
      turnId: "turn_a",
      origin: "wechat",
    });
    expect(adapter.activeTurn).toEqual({
      threadId: "thread_b",
      turnId: "turn_b",
      origin: "wechat",
    });
  });

  test("filters an identical recent user message while the task is still active", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const starts: string[] = [];
    adapter.desktopIpcClient = {
      startTurn: async (_threadId: string, text: string) => {
        starts.push(text);
        return { id: "turn_duplicate", status: "inProgress" };
      },
    };
    adapter.getQueuedTaskInputs = () => [];
    adapter.getSessionMessagePage = async () => ({
      messages: [
        { role: "assistant", text: "之前的回答" },
        { role: "user", text: "不要重复下任务" },
        { role: "assistant", text: "正在处理", phase: "commentary" },
      ],
      hasMore: false,
      nextBefore: null,
    });
    adapter.activeTurn = {
      threadId: "thread_a",
      turnId: "turn_a",
      origin: "local",
    };

    const result = await adapter.sendInputToSession("thread_a", "不要重复下任务");

    expect(result).toEqual({ duplicate: true });
    expect(starts).toEqual([]);
  });

  test("submits text and local images to the real desktop task", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const calls: Array<{ threadId: string; input: unknown }> = [];
    adapter.desktopIpcClient = {
      startTurn: async (threadId: string, input: unknown) => {
        calls.push({ threadId, input });
        return { id: "turn_image", status: "inProgress" };
      },
    };
    adapter.sharedThreadId = "thread_a";
    adapter.state.sharedSessionId = "thread_a";
    adapter.state.sharedThreadId = "thread_a";

    const result = await adapter.sendInputItemsToSession("thread_a", [
      { type: "text", text: "请分析这张图" },
      { type: "localImage", path: "/tmp/mobile-image.png" },
    ]);

    expect(calls).toEqual([
      {
        threadId: "thread_a",
        input: [
          { type: "text", text: "请分析这张图" },
          { type: "localImage", path: "/tmp/mobile-image.png" },
        ],
      },
    ]);
    expect(result).toEqual({ turnId: "turn_image", queued: false });
  });

  test("recovers the selected task status after the desktop IPC reconnects", () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const events: Array<{ type: string; status?: string; message?: string }> = [];
    adapter.setEventSink((event: { type: string; status?: string; message?: string }) => {
      events.push(event);
    });
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";
    adapter.state.status = "error";

    adapter.syncSelectedThreadState("Codex 桌面端已重新连接。", {
      recoverConnectionError: true,
    });

    expect(adapter.state.status).toBe("idle");
    expect(events.at(-1)).toMatchObject({
      type: "status",
      status: "idle",
      message: "Codex 桌面端已重新连接。",
    });
  });

  test("does not expose a transient desktop IPC disconnect that recovers within the grace window", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const events: string[] = [];
    adapter.desktopTransportStarted = true;
    adapter.desktopReconnectGraceMs = 20;
    adapter.setStatus = (_status: string, message?: string) => {
      events.push(`status:${message ?? ""}`);
    };
    adapter.syncSelectedThreadState = (message?: string) => {
      events.push(`sync:${message ?? ""}`);
    };

    adapter.handleDesktopConnectionChanged(false);
    await wait(5);
    adapter.handleDesktopConnectionChanged(true);
    await wait(30);

    expect(events).toEqual([]);
  });

  test("reports recovery only when the desktop IPC disconnect was visible", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const events: string[] = [];
    adapter.desktopTransportStarted = true;
    adapter.desktopReconnectGraceMs = 5;
    adapter.setStatus = (_status: string, message?: string) => {
      events.push(`status:${message ?? ""}`);
    };
    adapter.syncSelectedThreadState = (message?: string) => {
      events.push(`sync:${message ?? ""}`);
    };

    adapter.handleDesktopConnectionChanged(false);
    await wait(20);
    adapter.handleDesktopConnectionChanged(true);

    expect(events).toEqual([
      "status:Codex 桌面端连接已断开，正在重连。",
      "sync:Codex 桌面端已重新连接。",
    ]);
  });

  test("reports a desktop IPC disconnect only after the grace window expires", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const events: string[] = [];
    adapter.desktopTransportStarted = true;
    adapter.desktopReconnectGraceMs = 5;
    adapter.setStatus = (_status: string, message?: string) => {
      events.push(message ?? "");
    };

    adapter.handleDesktopConnectionChanged(false);
    expect(events).toEqual([]);
    await wait(20);

    expect(events).toEqual(["Codex 桌面端连接已断开，正在重连。"]);
  });

  test("starts a queued turn in its original background task without switching the selected task", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const calls: Array<{ threadId: string; text: string }> = [];
    adapter.desktopIpcClient = {
      startTurn: async (threadId: string, text: string) => {
        calls.push({ threadId, text });
        return { id: "turn_a_queued", status: "inProgress" };
      },
    };
    adapter.sharedThreadId = "thread_b";
    adapter.state.sharedSessionId = "thread_b";
    adapter.state.sharedThreadId = "thread_b";
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_b",
      turnId: "turn_b",
      origin: "wechat",
    };
    adapter.state.activeTurnId = "turn_b";
    adapter.state.activeTurnOrigin = "wechat";
    adapter.bridgeOwnedTurnIds.add("turn_b");

    const result = await adapter.sendInputToSession("thread_a", "队列中的下一条消息");

    expect(result).toEqual({ turnId: "turn_a_queued", queued: false });
    expect(calls).toEqual([
      { threadId: "thread_a", text: "队列中的下一条消息" },
    ]);
    expect(adapter.sharedThreadId).toBe("thread_b");
    expect(adapter.activeTurn).toEqual({
      threadId: "thread_b",
      turnId: "turn_b",
      origin: "wechat",
    });
    expect(adapter.backgroundTurns.get("turn_a_queued")).toEqual({
      threadId: "thread_a",
      turnId: "turn_a_queued",
      origin: "wechat",
    });
  });

  test("starts directly when persisted completion proves tracked desktop activity is stale", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stale-active-send-"));
    const threadId = "thread_stale";
    const rolloutFile = path.join(directory, `rollout-${threadId}.jsonl`);
    const globalStateFile = path.join(directory, ".codex-global-state.json");
    fs.writeFileSync(globalStateFile, JSON.stringify({ "queued-follow-ups": {} }));
    fs.writeFileSync(rolloutFile, [
      JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
      JSON.stringify({
        timestamp: "2026-08-07T01:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn_stale",
          completed_at: 1_786_000_005,
          duration_ms: 5_000,
        },
      }),
    ].join("\n") + "\n");
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
      codexDesktopGlobalStateFile: globalStateFile,
    }) as any;
    const starts: Array<{ threadId: string; text: string }> = [];
    const queueWrites: unknown[] = [];
    adapter.desktopIpcClient = {
      startTurn: async (candidateThreadId: string, text: string) => {
        starts.push({ threadId: candidateThreadId, text });
        return { id: "turn_new", status: "inProgress" };
      },
      setQueuedFollowUpsState: async (_candidateThreadId: string, state: unknown) => {
        queueWrites.push(state);
      },
      getThreadState: () => null,
    };
    adapter.desktopThreadSessionFilePathById.set(threadId, rolloutFile);
    adapter.desktopListedRuntimeStatusByThreadId.set(threadId, {
      type: "active",
      activeFlags: [],
    });
    adapter.sharedThreadId = threadId;
    adapter.state.sharedSessionId = threadId;
    adapter.state.sharedThreadId = threadId;
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId,
      turnId: "turn_stale",
      origin: "local",
    };
    adapter.state.activeTurnId = "turn_stale";
    adapter.state.activeTurnOrigin = "local";

    try {
      const result = await adapter.sendInputToSession(threadId, "新任务只启动一次");
      expect(result).toEqual({ turnId: "turn_new", queued: false });
      expect(starts).toEqual([{ threadId, text: "新任务只启动一次" }]);
      expect(queueWrites).toEqual([]);
      expect(adapter.activeTurn).toEqual({
        threadId,
        turnId: "turn_new",
        origin: "wechat",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("removes a queued follow-up after Codex starts the same input", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-consumed-queue-"));
    const globalStateFile = path.join(directory, ".codex-global-state.json");
    const queued = {
      id: "queued_consumed",
      text: "不要再执行第二次",
      context: {
        prompt: "不要再执行第二次",
        imageAttachments: [],
        workspaceRoots: [process.cwd()],
      },
      cwd: process.cwd(),
      createdAt: 1_800_000_000_000,
    };
    fs.writeFileSync(globalStateFile, JSON.stringify({
      "queued-follow-ups": { thread_a: [queued] },
    }));
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
      codexDesktopGlobalStateFile: globalStateFile,
    }) as any;
    const queueWrites: Array<Record<string, unknown[]>> = [];
    adapter.desktopIpcClient = {
      setQueuedFollowUpsState: async (
        _threadId: string,
        state: Record<string, unknown[]>,
      ) => {
        queueWrites.push(structuredClone(state));
        fs.writeFileSync(globalStateFile, JSON.stringify({ "queued-follow-ups": state }));
      },
    };

    try {
      adapter.handleDesktopTurnState("thread_a", {
        turnId: "turn_started",
        status: "inProgress",
        errorMessage: null,
        startedAtMs: 1_800_000_001_000,
        items: [{
          id: "user_started",
          type: "userMessage",
          content: [{ type: "text", text: "不要再执行第二次" }],
        }],
      }, null, false);
      await adapter.desktopQueuedFollowUpMutationChain;
      expect(queueWrites.at(-1)?.thread_a).toBeUndefined();
      expect(adapter.getQueuedTaskInputs("thread_a")).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("adds a native queued follow-up instead of starting another active turn", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-queue-"));
    const globalStateFile = path.join(directory, ".codex-global-state.json");
    fs.writeFileSync(globalStateFile, JSON.stringify({
      "queued-follow-ups": {
        thread_a: [{
          id: "queued_existing",
          text: "已经排队的消息",
          context: {
            prompt: "已经排队的消息",
            imageAttachments: [],
            workspaceRoots: [process.cwd()],
          },
          cwd: process.cwd(),
          createdAt: 1_800_000_000_000,
        }],
      },
    }));
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
      codexDesktopGlobalStateFile: globalStateFile,
    }) as any;
    const queueWrites: Array<{ threadId: string; state: Record<string, unknown> }> = [];
    adapter.desktopIpcClient = {
      startTurn: async () => {
        throw new Error("must not start a second turn");
      },
      setQueuedFollowUpsState: async (
        threadId: string,
        state: Record<string, unknown>,
      ) => queueWrites.push({ threadId, state }),
    };
    adapter.sharedThreadId = "thread_a";
    adapter.state.sharedSessionId = "thread_a";
    adapter.state.sharedThreadId = "thread_a";
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_a",
      turnId: "turn_running",
      origin: "local",
    };
    adapter.state.activeTurnId = "turn_running";
    adapter.state.activeTurnOrigin = "local";

    const result = await adapter.sendInputToSession(
      "thread_a",
      "等待当前任务结束后再发送",
    );

    expect(result.queued).toBe(true);
    expect(result.queuePosition).toBe(2);
    expect(result.queuedMessageId).toBeString();
    expect(queueWrites).toHaveLength(1);
    expect(queueWrites[0]?.threadId).toBe("thread_a");
    expect(queueWrites[0]?.state["thread_a"]).toMatchObject([
      { id: "queued_existing", text: "已经排队的消息" },
      {
        id: result.queuedMessageId,
        text: "等待当前任务结束后再发送",
        context: {
          prompt: "等待当前任务结束后再发送",
          imageAttachments: [],
          workspaceRoots: [process.cwd()],
        },
        cwd: process.cwd(),
      },
    ]);
    expect(adapter.activeTurn).toEqual({
      threadId: "thread_a",
      turnId: "turn_running",
      origin: "local",
    });
    expect(adapter.backgroundTurns.size).toBe(0);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("confirms a queued follow-up from desktop state after the reply times out", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-queue-timeout-"));
    const globalStateFile = path.join(directory, ".codex-global-state.json");
    fs.writeFileSync(globalStateFile, JSON.stringify({ "queued-follow-ups": {} }));
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
      codexDesktopGlobalStateFile: globalStateFile,
    }) as any;
    adapter.desktopIpcClient = {
      startTurn: async () => {
        throw new Error("must not start a second turn");
      },
      setQueuedFollowUpsState: async (
        _threadId: string,
        state: Record<string, unknown>,
      ) => {
        fs.writeFileSync(globalStateFile, JSON.stringify({
          "queued-follow-ups": state,
        }));
        throw new Error("Codex 桌面端请求超时：thread-follower-set-queued-follow-ups-state");
      },
    };
    adapter.sharedThreadId = "thread_a";
    adapter.state.sharedSessionId = "thread_a";
    adapter.state.sharedThreadId = "thread_a";
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_a",
      turnId: "turn_running",
      origin: "local",
    };
    adapter.state.activeTurnId = "turn_running";
    adapter.state.activeTurnOrigin = "local";

    const result = await adapter.sendInputToSession("thread_a", "只排队一次");

    expect(result).toMatchObject({ queued: true, queuePosition: 1 });
    expect(adapter.getQueuedTaskInputs("thread_a")).toMatchObject([{
      id: result.queuedMessageId,
      text: "只排队一次",
    }]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("uses listed desktop runtime status to queue a background task message", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-background-queue-"));
    const globalStateFile = path.join(directory, ".codex-global-state.json");
    fs.writeFileSync(globalStateFile, JSON.stringify({ "queued-follow-ups": {} }));
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
      codexDesktopGlobalStateFile: globalStateFile,
    }) as any;
    const queueWrites: Array<Record<string, unknown>> = [];
    adapter.desktopIpcClient = {
      startTurn: async () => {
        throw new Error("must not start a second background turn");
      },
      setQueuedFollowUpsState: async (
        _threadId: string,
        state: Record<string, unknown>,
      ) => queueWrites.push(state),
      getThreadState: () => null,
    };
    adapter.desktopListedRuntimeStatusByThreadId.set("thread_background", {
      type: "active",
      activeFlags: [],
    });

    const result = await adapter.sendInputToSession(
      "thread_background",
      "排到后台任务的原生队列",
    );

    expect(result.queued).toBe(true);
    expect(queueWrites.at(-1)?.thread_background).toMatchObject([{
      id: result.queuedMessageId,
      text: "排到后台任务的原生队列",
    }]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("reads, edits, deletes, and steers native queued follow-ups", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-queue-actions-"));
    const globalStateFile = path.join(directory, ".codex-global-state.json");
    const queuedMessage = {
      id: "queued_1",
      text: "原始内容",
      context: {
        prompt: "原始内容",
        imageAttachments: [{
          src: "/tmp/queued.png",
          localPath: "/tmp/queued.png",
          filename: "queued.png",
        }],
        workspaceRoots: [process.cwd()],
      },
      cwd: process.cwd(),
      createdAt: 1_800_000_000_000,
    };
    fs.writeFileSync(globalStateFile, JSON.stringify({
      "queued-follow-ups": { thread_a: [queuedMessage] },
    }));
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
      codexDesktopGlobalStateFile: globalStateFile,
    }) as any;
    const queueWrites: Array<Record<string, unknown>> = [];
    const steers: unknown[] = [];
    adapter.desktopIpcClient = {
      setQueuedFollowUpsState: async (
        _threadId: string,
        state: Record<string, unknown>,
      ) => {
        queueWrites.push(structuredClone(state));
        fs.writeFileSync(globalStateFile, JSON.stringify({
          "queued-follow-ups": state,
        }));
      },
      steerTurn: async (
        threadId: string,
        input: unknown,
        restoreMessage: unknown,
      ) => steers.push({ threadId, input, restoreMessage }),
    };

    expect(adapter.getQueuedTaskInputs("thread_a")).toEqual([{
      id: "queued_1",
      text: "原始内容",
      imageCount: 1,
      createdAtMs: 1_800_000_000_000,
    }]);
    expect(await adapter.updateQueuedTaskInput("thread_a", "queued_1", "修改后的内容"))
      .toBe(true);
    expect(queueWrites.at(-1)?.thread_a).toMatchObject([{
      id: "queued_1",
      text: "修改后的内容",
      context: { prompt: "修改后的内容" },
    }]);
    expect(await adapter.steerQueuedTaskInput("thread_a", "queued_1")).toBe(true);
    expect(steers).toMatchObject([{
      threadId: "thread_a",
      input: [
        { type: "text", text: "修改后的内容" },
        { type: "localImage", path: "/tmp/queued.png" },
      ],
      restoreMessage: { id: "queued_1", text: "修改后的内容" },
    }]);
    expect(queueWrites.at(-1)?.thread_a).toBeUndefined();

    fs.writeFileSync(globalStateFile, JSON.stringify({
      "queued-follow-ups": { thread_a: [queuedMessage] },
    }));
    adapter.desktopGlobalStateCache = null;
    expect(await adapter.deleteQueuedTaskInput("thread_a", "queued_1")).toBe(true);
    expect(queueWrites.at(-1)?.thread_a).toBeUndefined();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("does not track a stale historical in-progress entity as the active desktop turn", () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";

    adapter.handleDesktopThreadStateChanged("thread_1", {
      threadRuntimeStatus: { type: "active", activeFlags: [] },
      turnHistory: {
        history: {
          entitiesByKey: {
            "turn:stale": {
              turnId: "turn_stale",
              status: "inProgress",
              items: [{
                type: "userMessage",
                id: "user_stale",
                content: [{ type: "text", text: "历史任务" }],
              }],
            },
            "tail:0:local:current": {
              turnId: "turn_current",
              status: "inProgress",
              items: [{
                type: "userMessage",
                id: "user_current",
                content: [{ type: "text", text: "当前任务" }],
              }],
            },
          },
        },
      },
    }, null);

    expect(adapter.activeTurn).toEqual({
      threadId: "thread_1",
      turnId: "turn_current",
      origin: "local",
    });
    expect(adapter.backgroundTurns.has("turn_stale")).toBe(false);
    expect(events.some((event) => event.turnId === "turn_stale")).toBe(false);
  });

  test("emits the real desktop final answer when the followed turn completes", () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";
    adapter.state.status = "busy";
    adapter.bridgeOwnedTurnIds.add("turn_1");

    const activeState = {
      cwd: process.cwd(),
      requests: [],
      threadRuntimeStatus: { type: "active", activeFlags: [] },
      turnHistory: {
        history: {
          entitiesByKey: {
            "tail:0:local:test": {
              turnId: "turn_1",
              status: "inProgress",
              items: [
                {
                  type: "userMessage",
                  id: "user_1",
                  content: [{ type: "text", text: "微信中的真实消息" }],
                },
              ],
            },
          },
        },
      },
    };
    const completedState = structuredClone(activeState) as any;
    completedState.threadRuntimeStatus = { type: "idle" };
    const completedTurn = completedState.turnHistory.history.entitiesByKey[
      "tail:0:local:test"
    ];
    completedTurn.status = "completed";
    completedTurn.items.push({
      type: "agentMessage",
      id: "assistant_1",
      text: "这是 Codex 桌面端的真实回复",
      phase: "final_answer",
    });

    adapter.handleDesktopThreadStateChanged("thread_1", activeState, null);
    adapter.handleDesktopThreadStateChanged(
      "thread_1",
      completedState,
      activeState,
    );

    expect(events.find((event) => event.type === "final_reply")).toMatchObject({
      type: "final_reply",
      text: "这是 Codex 桌面端的真实回复",
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    });
    expect(events.find((event) => event.type === "task_complete")).toMatchObject({
      type: "task_complete",
      threadId: "thread_1",
      turnId: "turn_1",
      outcome: "completed",
    });
  });

  test("returns desktop approval decisions to the same task owner", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const decisions: unknown[] = [];
    adapter.desktopIpcClient = {
      replyToCommandApproval: async (
        threadId: string,
        requestId: number,
        decision: unknown,
      ) => decisions.push({ threadId, requestId, decision }),
    };
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };
    adapter.bridgeOwnedTurnIds.add("turn_1");
    const amendment = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["touch", "/tmp/desktop-test"],
      },
    };

    await adapter.handleDesktopRequest(
      "thread_1",
      7,
      "item/commandExecution/requestApproval",
      {
        threadId: "thread_1",
        turnId: "turn_1",
        reason: "需要执行高风险测试命令",
        command: "/bin/zsh -lc 'rm -rf /'",
        cwd: process.cwd(),
        availableDecisions: ["accept", amendment, "cancel"],
      },
    );

    expect(adapter.pendingApprovalRequests).toHaveLength(1);
    expect(await adapter.resolveTaskApprovals("thread_1", "confirm_session")).toBe(1);
    expect(decisions).toEqual([
      {
        threadId: "thread_1",
        requestId: 7,
        decision: amendment,
      },
    ]);
  });

  test("uses the cached desktop request as the authoritative pending approval", () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    adapter.desktopIpcClient = {
      getThreadStateView: () => ({
        requests: [{
          id: 995,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread_1",
            turnId: "turn_1",
            reason: "桌面端仍在等待确认",
            command: "/bin/zsh -lc 'echo live-state'",
            cwd: process.cwd(),
            availableDecisions: ["accept", "cancel"],
          },
        }],
        threadRuntimeStatus: {
          type: "active",
          activeFlags: ["waitingOnApproval"],
        },
      }),
    };

    expect(adapter.getPendingTaskApprovals("thread_1")).toMatchObject([{
      requestId: "995",
      threadId: "thread_1",
      turnId: "turn_1",
      summary: "桌面端仍在等待确认",
    }]);
  });

  test("keeps an automatically approved desktop request actionable when delivery times out", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.desktopIpcClient = {
      replyToCommandApproval: async () => {
        throw new Error("Codex 桌面端请求超时：thread-follower-command-approval-decision");
      },
      getThreadStateView: () => null,
    };
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";
    adapter.state.status = "busy";

    await adapter.handleDesktopRequest(
      "thread_1",
      996,
      "item/commandExecution/requestApproval",
      {
        threadId: "thread_1",
        turnId: "turn_1",
        reason: "允许运行低风险检查吗？",
        command: "/bin/zsh -lc 'echo werelay'",
        cwd: process.cwd(),
        availableDecisions: ["accept", "cancel"],
      },
    );

    expect(adapter.getPendingTaskApprovals("thread_1")).toMatchObject([{
      requestId: "996",
      threadId: "thread_1",
      turnId: "turn_1",
      summary: "允许运行低风险检查吗？",
    }]);
    expect(events.filter((event) => event.type === "approval_required")).toHaveLength(1);
  });

  test("does not clear an approval until the desktop request actually disappears", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const pendingState = {
      requests: [{
        id: 997,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          reason: "桌面端尚未真正接受",
          command: "/bin/zsh -lc 'echo still-pending'",
          cwd: process.cwd(),
          availableDecisions: ["accept", "cancel"],
        },
      }],
      threadRuntimeStatus: {
        type: "active",
        activeFlags: ["waitingOnApproval"],
      },
    };
    adapter.desktopApprovalSettleTimeoutMs = 1;
    adapter.desktopIpcClient = {
      replyToCommandApproval: async () => undefined,
      getThreadStateView: () => pendingState,
    };
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";
    adapter.state.status = "busy";
    adapter.handleDesktopThreadStateChanged("thread_1", pendingState, null);
    await Bun.sleep(0);

    await expect(adapter.resolveTaskApprovals("thread_1", "confirm")).rejects.toThrow(
      "Codex 桌面端仍在等待审批",
    );
    expect(adapter.getPendingTaskApprovals("thread_1")).toMatchObject([{
      requestId: "997",
      threadId: "thread_1",
    }]);
  });

  test("uses the cached desktop request as the authoritative pending approval", () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    adapter.desktopIpcClient = {
      getThreadStateView: () => ({
        requests: [{
          id: 995,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread_1",
            turnId: "turn_1",
            reason: "桌面端仍在等待确认",
            command: "/bin/zsh -lc 'echo live-state'",
            cwd: process.cwd(),
            availableDecisions: ["accept", "cancel"],
          },
        }],
        threadRuntimeStatus: {
          type: "active",
          activeFlags: ["waitingOnApproval"],
        },
      }),
    };

    expect(adapter.getPendingTaskApprovals("thread_1")).toMatchObject([{
      requestId: "995",
      threadId: "thread_1",
      turnId: "turn_1",
      summary: "桌面端仍在等待确认",
    }]);
  });

  test("does not report an approval as resolved when desktop state is unavailable", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const events: Array<Record<string, unknown>> = [];
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.desktopApprovalSettleTimeoutMs = 1;
    adapter.desktopIpcClient = {
      replyToCommandApproval: async () => undefined,
      getThreadStateView: () => null,
    };
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";
    adapter.state.status = "busy";

    await adapter.handleDesktopRequest(
      "thread_1",
      996,
      "item/commandExecution/requestApproval",
      {
        threadId: "thread_1",
        turnId: "turn_1",
        reason: "桌面状态暂时不可用",
        command: "/bin/zsh -lc 'echo unavailable-state'",
        cwd: process.cwd(),
        availableDecisions: ["accept", "cancel"],
      },
    );

    expect(adapter.getPendingTaskApprovals("thread_1")).toMatchObject([{
      requestId: "996",
      threadId: "thread_1",
      turnId: "turn_1",
      summary: "桌面状态暂时不可用",
    }]);
    expect(events.filter((event) => event.type === "approval_required")).toHaveLength(1);
  });

  test("does not report an approval as resolved while the desktop request remains", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const events: Array<Record<string, unknown>> = [];
    const pendingState = {
      requests: [{
        id: 996,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          reason: "桌面端尚未真正接受",
          command: "/bin/zsh -lc 'echo still-pending'",
          cwd: process.cwd(),
          availableDecisions: ["accept", "cancel"],
        },
      }],
      threadRuntimeStatus: {
        type: "active",
        activeFlags: ["waitingOnApproval"],
      },
    };
    adapter.setEventSink((event: Record<string, unknown>) => events.push(event));
    adapter.desktopApprovalSettleTimeoutMs = 1;
    adapter.desktopIpcClient = {
      replyToCommandApproval: async () => undefined,
      getThreadStateView: () => pendingState,
    };
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";
    adapter.state.status = "busy";

    adapter.handleDesktopThreadStateChanged("thread_1", pendingState, null);
    await Bun.sleep(10);

    expect(adapter.getPendingTaskApprovals("thread_1")).toMatchObject([{
      requestId: "996",
      threadId: "thread_1",
      turnId: "turn_1",
      summary: "桌面端尚未真正接受",
    }]);
    expect(events.filter((event) => event.type === "approval_required")).toHaveLength(1);
  });

  test("resolves one desktop approval request without consuming the next queued approval", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const decisions: unknown[] = [];
    adapter.desktopIpcClient = {
      replyToCommandApproval: async (
        threadId: string,
        requestId: number,
        decision: unknown,
      ) => decisions.push({ threadId, requestId, decision }),
    };
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";
    adapter.state.status = "busy";
    adapter.activeTurn = {
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "wechat",
    };
    adapter.bridgeOwnedTurnIds.add("turn_1");

    for (const requestId of [7, 8]) {
      await adapter.handleDesktopRequest(
        "thread_1",
        requestId,
        "item/commandExecution/requestApproval",
        {
          threadId: "thread_1",
          turnId: "turn_1",
          reason: `审批 ${requestId}`,
          command: `/bin/zsh -lc 'rm -rf /tmp/approval-${requestId}'`,
          cwd: process.cwd(),
          availableDecisions: ["accept", "cancel"],
        },
      );
    }

    expect(adapter.getPendingTaskApprovals("thread_1")).toHaveLength(2);
    expect(await adapter.resolveApprovalRequest("7", "deny")).toBe(true);
    expect(adapter.getPendingTaskApprovals("thread_1")).toMatchObject([{
      requestId: "8",
    }]);
    expect(decisions).toEqual([{
      threadId: "thread_1",
      requestId: 7,
      decision: "cancel",
    }]);
  });

  test("reconstructs actionable desktop approvals from a followed thread snapshot", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const decisions: unknown[] = [];
    adapter.desktopIpcClient = {
      replyToCommandApproval: async (
        threadId: string,
        requestId: number,
        decision: unknown,
      ) => decisions.push({ threadId, requestId, decision }),
    };
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";
    adapter.state.status = "busy";

    const pendingState = {
      cwd: process.cwd(),
      requests: [{
        id: 9,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          reason: "需要执行部署检查",
          command: "/bin/zsh -lc 'rm -rf /'",
          cwd: process.cwd(),
          availableDecisions: ["accept", "cancel"],
        },
      }],
      threadRuntimeStatus: {
        type: "active",
        activeFlags: ["waitingOnApproval"],
      },
      turnHistory: {
        history: {
          entitiesByKey: {
            "tail:0:local:test": {
              turnId: "turn_1",
              status: "inProgress",
              items: [{
                type: "userMessage",
                id: "user_1",
                content: [{ type: "text", text: "检查部署" }],
              }],
            },
          },
        },
      },
    };

    adapter.handleDesktopThreadStateChanged("thread_1", pendingState, null);

    expect(adapter.getPendingTaskApprovals("thread_1")).toMatchObject([{
      threadId: "thread_1",
      turnId: "turn_1",
      summary: "需要执行部署检查",
    }]);
    expect(await adapter.resolveTaskApprovals("thread_1", "confirm")).toBe(1);
    expect(decisions).toEqual([{
      threadId: "thread_1",
      requestId: 9,
      decision: "accept",
    }]);
  });

  test("reconstructs an actionable desktop approval when a summary snapshot omits turn metadata", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const decisions: unknown[] = [];
    adapter.desktopIpcClient = {
      replyToCommandApproval: async (
        threadId: string,
        requestId: number,
        decision: unknown,
      ) => decisions.push({ threadId, requestId, decision }),
    };
    adapter.sharedThreadId = "thread_summary";
    adapter.state.sharedSessionId = "thread_summary";
    adapter.state.sharedThreadId = "thread_summary";
    adapter.state.status = "busy";

    adapter.handleDesktopThreadStateChanged("thread_summary", {
      requests: [{
        id: 11,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread_summary",
          reason: "需要执行发布检查",
          command: "/bin/zsh -lc 'rm -rf /tmp/werelay-summary-approval'",
          cwd: process.cwd(),
          availableDecisions: ["accept", "cancel"],
        },
      }],
      threadRuntimeStatus: {
        type: "active",
        activeFlags: ["waitingOnApproval"],
      },
    }, null);

    expect(adapter.getPendingTaskApprovals("thread_summary")).toMatchObject([{
      threadId: "thread_summary",
      summary: "需要执行发布检查",
      requestId: "11",
    }]);
    expect(await adapter.resolveTaskApprovals("thread_summary", "confirm")).toBe(1);
    expect(decisions).toEqual([{
      threadId: "thread_summary",
      requestId: 11,
      decision: "accept",
    }]);
  });

  test("drops a desktop approval after the owner resolves it", () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";
    adapter.state.status = "busy";
    const pendingState = {
      requests: [{
        id: 10,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          reason: "需要确认",
          command: "/bin/zsh -lc 'rm -rf /'",
          availableDecisions: ["accept", "cancel"],
        },
      }],
      threadRuntimeStatus: {
        type: "active",
        activeFlags: ["waitingOnApproval"],
      },
      turnHistory: {
        history: {
          entitiesByKey: {
            "tail:0:local:test": {
              turnId: "turn_1",
              status: "inProgress",
              items: [],
            },
          },
        },
      },
    };
    const resolvedState = structuredClone(pendingState);
    resolvedState.requests = [];
    resolvedState.threadRuntimeStatus.activeFlags = [];

    adapter.handleDesktopThreadStateChanged("thread_1", pendingState, null);
    expect(adapter.getPendingTaskApprovals("thread_1")).toHaveLength(1);
    adapter.handleDesktopThreadStateChanged("thread_1", resolvedState, pendingState);
    expect(adapter.getPendingTaskApprovals("thread_1")).toEqual([]);
  });

  test("rebuilds and resolves browser MCP elicitation approvals from desktop state", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const responses: unknown[] = [];
    adapter.desktopIpcClient = {
      replyToMcpServerElicitation: async (
        threadId: string,
        requestId: number,
        response: Record<string, unknown>,
      ) => responses.push({ threadId, requestId, response }),
    };
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";
    adapter.state.status = "busy";

    adapter.handleDesktopThreadStateChanged("thread_1", {
      requests: [{
        id: 2,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          serverName: "node_repl",
          message: "Allow Browser use to access https://www.baipai.com?",
          requestedSchema: { type: "object", properties: {} },
          _meta: {
            persist: "always",
            tool_title: "Access browser origin",
            origin: "https://www.baipai.com",
          },
        },
      }],
      threadRuntimeStatus: {
        type: "active",
        activeFlags: ["waitingOnApproval"],
      },
    }, null);

    expect(adapter.getPendingTaskApprovals("thread_1")).toEqual([{
      source: "cli",
      summary: "Allow Browser use to access https://www.baipai.com?",
      commandPreview: "Access browser origin · https://www.baipai.com",
      allowForSession: true,
      toolName: "Access browser origin",
      detailLabel: "访问网站",
      detailPreview: "https://www.baipai.com",
      requestId: "2",
      threadId: "thread_1",
      turnId: "turn_1",
      origin: "local",
      createdAt: expect.any(String),
    }]);

    expect(await adapter.resolveTaskApprovals("thread_1", "confirm_session")).toBe(1);
    expect(responses).toEqual([{
      threadId: "thread_1",
      requestId: 2,
      response: {
        action: "accept",
        content: null,
        _meta: { persist: "always" },
      },
    }]);
  });

  test("submits desktop user input without replying through app-server", async () => {
    const adapter = new CodexPtyAdapter({
      kind: "codex",
      command: "codex",
      cwd: process.cwd(),
      renderMode: "headless",
      codexTransport: "desktop",
    }) as any;
    const submissions: unknown[] = [];
    adapter.desktopIpcClient = {
      submitUserInput: async (
        threadId: string,
        requestId: number,
        answers: Record<string, unknown>,
      ) => submissions.push({ threadId, requestId, answers }),
    };
    adapter.sharedThreadId = "thread_1";
    adapter.state.sharedSessionId = "thread_1";
    adapter.state.sharedThreadId = "thread_1";
    adapter.pendingUserInputRequests = [
      {
        requestId: 8,
        method: "item/tool/requestUserInput",
        threadId: "thread_1",
        turnId: "turn_1",
        origin: "wechat",
        request: {
          summary: "请选择",
          questions: [],
        },
      },
    ];

    expect(await adapter.submitTaskUserInput("thread_1", { choice: ["继续"] })).toBe(
      true,
    );
    expect(submissions).toEqual([
      {
        threadId: "thread_1",
        requestId: 8,
        answers: { choice: { answers: ["继续"] } },
      },
    ]);
  });
});

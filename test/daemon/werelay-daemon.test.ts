import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  appendCodexMobileTaskLink,
  buildCodexMobileTaskBoard,
  buildDaemonApprovalNotificationKey,
  DaemonTaskApprovalAutoApprover,
  buildMacVisibleClientLaunchScript,
  buildMacVisibleClientOpenArgs,
  buildVisibleClientLaunchArgs,
  buildWindowsVisibleClientLaunchCommand,
  cleanupDaemonBeforeStart,
  cleanupSingleBridgeBeforeDaemon,
  compareDaemonApprovalQueueOrder,
  computeCodexDeferredDrainRetryDelayMs,
  buildDaemonRuntimeOptions,
  buildDaemonTaskCatalogRuntimeOptions,
  defaultDaemonSessionStartMode,
  deferCodexCompletionObservationRetry,
  flushPendingDaemonRestartNotice,
  formatCodexTaskCompletionMessage,
  formatCodexTaskCompletionMessages,
  formatCurrentCodexFullReplyMessages,
  formatCompactTaskDuration,
  formatDaemonRestartNotice,
  formatDaemonSwitchResultDetail,
  formatDaemonStatus,
  formatMobileTaskListUnavailableMessage,
  isCodexTaskCandidateCacheFresh,
  isMobileTaskAvailableForDirectAction,
  isExplicitGlobalTaskListRequest,
  detectOpenMobileAdaptersFromProcessList,
  filterCodexMobileProgressForCurrentTurn,
  mapCodexMobileTaskStatus,
  observeCodexTask,
  parseDaemonApprovalShortcutSequence,
  parseDaemonCliArgs,
  parseDaemonSwitchCommand,
  prefixDaemonAdapterMessage,
  prefixDaemonTaskMessage,
  resolveDaemonInitialAdapter,
  resolveDaemonDesktopApplicationLaunchPermission,
  shouldRecreateDesktopOwnerSlotForUserLaunch,
  resolveDaemonSessionStartMode,
  resolveDaemonApprovalShortcut,
  resolveDaemonTaskListScope,
  resolveDaemonBareNumericReply,
  resolveDaemonWechatCommand,
  resolveMobileAdapterDisplayStatus,
  resolveCodexMobileTaskStatusFromSignals,
  resolveDaemonTaskListSnapshot,
  resolveDaemonTaskTargetedMessage,
  resolveCreatedMobileTask,
  resolveCodexWechatReplyThreadId,
  resolveCodexMobilePendingApprovalFromSignals,
  resolveCodexTaskCompletionDurationMs,
  selectCodexCompletionReplyText,
  selectCodexCompletionRequestPreview,
  sanitizeDaemonVisibleSessionMessage,
  shouldFollowCodexActiveTask,
  shouldInferCodexIdleRecencyCompletion,
  shouldClearCodexActiveTaskForCompletion,
  shouldForwardDaemonFinalReply,
  shouldForwardCodexTaskCompletionEvent,
  shouldForwardDaemonThreadSwitch,
  shouldQueueCodexDaemonInbound,
  shouldQueueCodexMobileMessage,
  shouldSendCodexMobileTaskLink,
  shouldSendCodexCompletionNotification,
  shouldSendDaemonRestartNotice,
  retrySwitchedAdapterTaskList,
  waitForVisibleClientConnection,
} from "../../src/daemon/werelay-daemon.ts";
import { redactSensitiveCommandText } from "../../src/bridge/bridge-utils.ts";
import type { BridgeLockPayload } from "../../src/bridge/bridge-state.ts";
import type {
  DaemonEndpoint,
  DaemonRequest,
} from "../../src/daemon/daemon-link.ts";

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

function buildBridgeLock(overrides: Partial<BridgeLockPayload> = {}): BridgeLockPayload {
  return {
    pid: 28544,
    parentPid: 1234,
    instanceId: "bridge-1",
    adapter: "codex",
    command: "codex",
    cwd: "C:\\Users\\example",
    startedAt: "2026-05-22T00:00:00.000Z",
    lifecycle: "persistent",
    ...overrides,
  };
}

function buildDaemonEndpoint(overrides: Partial<DaemonEndpoint> = {}): DaemonEndpoint {
  return {
    protocolVersion: 1,
    pid: 28600,
    port: 55901,
    token: "daemon-token",
    cwd: "C:\\Users\\example",
    startedAt: "2026-05-25T00:00:00.000Z",
    ...overrides,
  };
}

describe("mobile image persistence", () => {
  test("does not delete an uploaded image when desktop acceptance is uncertain", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const start = source.indexOf("  private async sendMobileMessage(");
    const end = source.indexOf("\n  private persistMobileImages", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).not.toContain("fs.rmSync(imagePath");
  });
});

describe("mobile task creation", () => {
  test("returns the authoritative new thread before the desktop task index catches up", () => {
    expect(resolveCreatedMobileTask({
      adapterLabel: "Codex",
      threadId: "new-thread",
      previousThreadId: "old-thread",
      listedTasks: [],
      status: "idle",
      canRename: true,
      canCreateInProject: false,
      nowIso: "2026-08-10T08:00:00.000Z",
    })).toEqual({
      threadId: "new-thread",
      title: "新 Codex 任务",
      lastUpdatedAt: "2026-08-10T08:00:00.000Z",
      status: "idle",
      selected: true,
      canRename: true,
      canCreateInProject: false,
    });
  });

  test("prefers indexed metadata and preserves the source project while indexing is delayed", () => {
    const listedTask = {
      threadId: "new-thread",
      title: "真实标题",
      projectId: "project-1",
      projectName: "真实项目",
      lastUpdatedAt: "2026-08-10T08:01:00.000Z",
      status: "idle" as const,
      selected: false,
      canRename: true,
      canCreateInProject: true,
    };
    expect(resolveCreatedMobileTask({
      adapterLabel: "Codex",
      threadId: "new-thread",
      previousThreadId: "old-thread",
      listedTasks: [listedTask],
      status: "idle",
      canRename: true,
      canCreateInProject: true,
      sourceTask: {
        threadId: "source-thread",
        title: "来源任务",
        projectId: "project-source",
        projectName: "来源项目",
        status: "idle",
      },
      nowIso: "2026-08-10T08:00:00.000Z",
    })).toEqual({
      ...listedTask,
      selected: true,
    });

    expect(resolveCreatedMobileTask({
      adapterLabel: "Codex",
      threadId: "new-thread",
      previousThreadId: "old-thread",
      listedTasks: [],
      status: "idle",
      canRename: true,
      canCreateInProject: true,
      sourceTask: {
        threadId: "source-thread",
        title: "来源任务",
        projectId: "project-source",
        projectName: "来源项目",
        status: "idle",
      },
      nowIso: "2026-08-10T08:00:00.000Z",
    })).toMatchObject({
      threadId: "new-thread",
      title: "新 Codex 任务",
      projectId: "project-source",
      projectName: "来源项目",
      selected: true,
      canCreateInProject: true,
    });
  });

  test("does not mistake an unchanged or missing thread id for a created task", () => {
    const base = {
      adapterLabel: "Codex",
      previousThreadId: "old-thread",
      listedTasks: [],
      status: "idle" as const,
      canRename: true,
      canCreateInProject: false,
      nowIso: "2026-08-10T08:00:00.000Z",
    };
    expect(resolveCreatedMobileTask({ ...base, threadId: undefined })).toBeNull();
    expect(resolveCreatedMobileTask({ ...base, threadId: "old-thread" })).toBeNull();
  });

  test("allows the first message to use the authoritative current or freshly created task id", () => {
    expect(isMobileTaskAvailableForDirectAction({
      threadId: "new-thread",
      currentThreadId: "new-thread",
      recentlyCreated: false,
      listed: false,
    })).toBe(true);
    expect(isMobileTaskAvailableForDirectAction({
      threadId: "new-thread",
      currentThreadId: "other-thread",
      recentlyCreated: true,
      listed: false,
    })).toBe(true);
    expect(isMobileTaskAvailableForDirectAction({
      threadId: "indexed-thread",
      currentThreadId: "other-thread",
      recentlyCreated: false,
      listed: true,
    })).toBe(true);
    expect(isMobileTaskAvailableForDirectAction({
      threadId: "unknown-thread",
      currentThreadId: "other-thread",
      recentlyCreated: false,
      listed: false,
    })).toBe(false);
  });
});

describe("daemon sequential approvals", () => {
  test("parses two or more approval shortcuts separated by whitespace or punctuation", () => {
    for (const text of ["1 2", "1,2", "1，2", "1/2", "1、2", "1。2", "1:2", "1：2", "1\n2", "1 👉 2"]) {
      expect(parseDaemonApprovalShortcutSequence(text)).toEqual([1, 2]);
    }
    expect(parseDaemonApprovalShortcutSequence("1,2;4")).toEqual([1, 2, 4]);
  });

  test("does not reinterpret ordinary text, invalid choices, contiguous digits, or one shortcut", () => {
    for (const text of ["1", "12", "审批 1,2", "1,a,2", "1,5", "版本 1.2"]) {
      expect(parseDaemonApprovalShortcutSequence(text)).toBeNull();
    }
  });

  test("maps each number against the options shown on that specific approval", () => {
    const shortApproval = { allowForSession: false };
    const sessionApproval = { allowForSession: true };

    expect(resolveDaemonApprovalShortcut(shortApproval, 1)).toEqual({
      action: "confirm",
      label: "允许本次",
    });
    expect(resolveDaemonApprovalShortcut(shortApproval, 2)).toEqual({
      action: "deny",
      label: "拒绝",
    });
    expect(resolveDaemonApprovalShortcut(shortApproval, 3)).toEqual({
      action: "confirm_task",
      label: "今日内本任务免审",
    });
    expect(resolveDaemonApprovalShortcut(shortApproval, 4)).toBeNull();
    expect(resolveDaemonApprovalShortcut(sessionApproval, 3)).toEqual({
      action: "confirm_session",
      label: "本任务始终允许",
    });
    expect(resolveDaemonApprovalShortcut(sessionApproval, 4)).toEqual({
      action: "confirm_task",
      label: "今日内本任务免审",
    });
  });

  test("keeps cross-task approvals in the order their prompts were emitted", () => {
    const approvals = [
      { id: "second", createdAt: "2026-08-09T01:00:00.000Z", notificationOrder: 2, insertionOrder: 0 },
      { id: "first", createdAt: "2026-08-09T01:00:00.000Z", notificationOrder: 1, insertionOrder: 1 },
      { id: "third", createdAt: "2026-08-09T00:59:00.000Z", notificationOrder: 3, insertionOrder: 2 },
    ];
    expect(approvals.sort(compareDaemonApprovalQueueOrder).map((item) => item.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("uses the sequential handler before ordinary single-command dispatch", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const inboundStart = source.indexOf("  private async handleInboundMessage(");
    const commandIndex = source.indexOf("    let command = resolveDaemonWechatCommand", inboundStart);
    const sequenceIndex = source.indexOf("parseDaemonApprovalShortcutSequence", inboundStart);
    const targetedIndex = source.indexOf("resolveGlobalTaskTargetedMessage", inboundStart);
    expect(sequenceIndex).toBeGreaterThan(inboundStart);
    expect(sequenceIndex).toBeLessThan(targetedIndex);
    expect(sequenceIndex).toBeLessThan(commandIndex);
    expect(source).toContain("handlePendingApprovalSequence");
    expect(source).toContain("resolvePendingApprovalTarget");
    expect(source).toContain("resolveApprovalRequest");
  });
});

describe("daemon startup resilience", () => {
  test("starts the mobile web before the initial adapter and keeps polling if that adapter fails", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const ipc = source.indexOf("  await daemon.startIpcServer();");
    const mobile = source.indexOf("  await daemon.startCodexMobileWeb();", ipc);
    const initial = source.indexOf("    await daemon.runInitialAdapter(options);", mobile);
    const polling = source.indexOf("  await daemon.runPollLoop();", initial);
    expect(ipc).toBeGreaterThan(-1);
    expect(mobile).toBeGreaterThan(ipc);
    expect(initial).toBeGreaterThan(mobile);
    expect(polling).toBeGreaterThan(initial);
    expect(source.slice(mobile, polling)).toContain("catch (error)");
    expect(source.slice(mobile, polling)).toContain("initial_adapter_start_error");
    const mobileMethodStart = source.indexOf("  async startCodexMobileWeb(): Promise<void> {");
    const mobileMethodEnd = source.indexOf("\n  async runInitialAdapter", mobileMethodStart);
    expect(source.slice(mobileMethodStart, mobileMethodEnd)).not.toContain('!this.slots.has("codex")');
  });

  test("merges three or more unsent completion notifications before retrying individually", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const retryStart = source.indexOf("  private async retryPendingCodexCompletionNotifications(");
    const retryEnd = source.indexOf("\n  private queueWechatMessage(", retryStart);
    const retryBlock = source.slice(retryStart, retryEnd);

    expect(retryBlock).toContain("selectCodexCompletionBacklogBatch");
    expect(retryBlock).toContain("formatCodexCompletionBacklogSummary");
    expect(retryBlock).toContain("this.codexCompletionDeliveries.acknowledge");
    expect(retryBlock.indexOf("formatCodexCompletionBacklogSummary")).toBeLessThan(
      retryBlock.indexOf("for (const pending of this.codexCompletionDeliveries.getPending())"),
    );
  });

  test("retries undelivered approvals before handling the inbound message that refreshed WeChat context", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts").replace(/\r\n?/g, "\n");
    const loopStart = source.indexOf(
      "      for (const message of pollResult.messages) {",
    );
    const loopEnd = source.indexOf("\n      }\n    }\n  }\n\n  async shutdown", loopStart);
    expect(loopStart).toBeGreaterThan(-1);
    expect(loopEnd).toBeGreaterThan(loopStart);

    const loopBody = source.slice(loopStart, loopEnd);
    const retryCompletions = loopBody.indexOf(
      "await this.retryPendingCodexCompletionNotifications(message.senderId);",
    );
    const retryApprovals = loopBody.indexOf(
      "await this.retryUndeliveredApprovalNotifications(message.senderId);",
    );
    const handleInbound = loopBody.indexOf("await this.handleInboundMessage(message);");
    expect(retryCompletions).toBeGreaterThan(-1);
    expect(retryApprovals).toBeGreaterThan(-1);
    expect(handleInbound).toBeGreaterThan(-1);
    expect(retryCompletions).toBeLessThan(handleInbound);
    expect(retryApprovals).toBeLessThan(handleInbound);
  });

  test("keeps restored approval deliveries while the desktop approval index is still warming up", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const retryStart = source.indexOf("  private async isApprovalNotificationStillPending(");
    const retryEnd = source.indexOf("  private deliverCodexCompletionNotification(", retryStart);
    const retrySource = source.slice(retryStart, retryEnd);

    expect(retrySource).toContain(
      "const runtimePending = slot.runtime.getPendingTaskApprovals(delivery.threadId);",
    );
    expect(retrySource).toContain(
      "return slot.pendingConfirmations.some((candidate) =>",
    );
  });
});

describe("mobile transcript visibility", () => {
  test("filters Codex internal user records from accelerated history", () => {
    expect(sanitizeDaemonVisibleSessionMessage("codex", {
      role: "user",
      text: [
        "# AGENTS.md instructions",
        "",
        "<INSTRUCTIONS>",
        "始终使用中文对话",
        "</INSTRUCTIONS>",
      ].join("\n"),
    })).toBeNull();

    expect(sanitizeDaemonVisibleSessionMessage("codex", {
      role: "user",
      text: "真实用户消息",
    })).toEqual({
      role: "user",
      text: "真实用户消息",
    });
  });

  test("preserves user attachment requests while removing desktop metadata", () => {
    expect(sanitizeDaemonVisibleSessionMessage("codex", {
      role: "user",
      text: [
        "# Files mentioned by the user:",
        "",
        "## screenshot.png: /private/tmp/screenshot.png",
        "",
        "## My request for Codex:",
        "请检查这个页面。",
      ].join("\n"),
    })).toEqual({
      role: "user",
      text: "图片：png1\n请检查这个页面。",
    });
  });
});

describe("werelay-daemon helpers", () => {
  test("redacts command credentials before approval text is logged or persisted", () => {
    expect(redactSensitiveCommandText(
      "sshpass -p 'secret-value' ssh host Authorization=BearerToken --token=abc",
    )).toBe(
      "sshpass -p '[已隐藏]' ssh host Authorization=[已隐藏] --token=[已隐藏]",
    );
    expect(redactSensitiveCommandText("curl -H 'Authorization: Bearer abc.def' host"))
      .toBe("curl -H 'Authorization: Bearer [已隐藏]' host");
  });

  test("redacts credentials in mobile approval cards and stable approval keys", () => {
    const approval = {
      summary: "Codex 请求运行命令。",
      commandPreview: "sshpass -p 'secret-value' ssh host",
      requestId: undefined,
      threadId: "thread-a",
      turnId: "turn-a",
    };
    expect(resolveCodexMobilePendingApprovalFromSignals({
      threadId: "thread-a",
      pendingConfirmations: [],
      runtimeTaskApprovals: [approval],
    })?.commandPreview).toBe("sshpass -p '[已隐藏]' ssh host");
    expect(buildDaemonApprovalNotificationKey(approval)).toBe(
      buildDaemonApprovalNotificationKey({
        ...approval,
        commandPreview: "sshpass -p '[已隐藏]' ssh host",
      }),
    );
  });
  test("merges live tasks and recent completions across adapters into one board", () => {
    const board = buildCodexMobileTaskBoard({
      taskGroups: [
        {
          adapter: "codex",
          adapterLabel: "Codex",
          tasks: [{
            threadId: "codex-running",
            title: "统一任务看板",
            status: "running",
            lastUpdatedAt: "2026-08-07T03:00:00.000Z",
          }],
        },
        {
          adapter: "grok",
          adapterLabel: "Grok",
          tasks: [{
            threadId: "grok-complete",
            title: "检查全部 Agent 聚合",
            status: "idle",
            lastUpdatedAt: "2026-08-07T02:00:00.000Z",
          }],
        },
      ],
      recentCompletions: [{
        adapter: "grok",
        threadId: "grok-complete",
        title: "检查全部 Agent 聚合",
        completedAt: "2026-08-07T02:01:00.000Z",
      }],
    });

    expect(board.tasks.map((task) => `${task.adapter}:${task.threadId}`)).toEqual([
      "codex:codex-running",
      "grok:grok-complete",
    ]);
    expect(board.tasks[1]).toMatchObject({
      adapterLabel: "Grok",
      completedAt: "2026-08-07T02:01:00.000Z",
    });
    expect(board.recentCompleted).toEqual([{
      adapter: "grok",
      adapterLabel: "Grok",
      threadId: "grok-complete",
      title: "检查全部 Agent 聚合",
      completedAt: "2026-08-07T02:01:00.000Z",
    }]);
  });

  test("reports an open terminal separately from a daemon-connected adapter", () => {
    expect(resolveMobileAdapterDisplayStatus({
      visibleClientOpen: true,
    })).toBe("open");
    expect(resolveMobileAdapterDisplayStatus({
      endpointStatus: "busy",
      endpointCompanionAlive: true,
    })).toBe("busy");
    expect(resolveMobileAdapterDisplayStatus({
      slotStatus: "awaiting_approval",
      visibleClientOpen: true,
    })).toBe("awaiting_approval");
    expect(resolveMobileAdapterDisplayStatus({})).toBe("stopped");
  });

  test("detects already-open CLI and desktop applications from one process snapshot", () => {
    const open = detectOpenMobileAdaptersFromProcessList([
      "/Applications/WorkBuddy.app/Contents/MacOS/Electron /Applications/WorkBuddy.app/Contents/Resources/app.asar",
      "node /Users/test/.hermes/node/bin/tclaude --dangerously-skip-permissions",
      "/Users/test/.hermes/node/lib/node_modules/@vendor/tclaude/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      "grok",
      "reasonix acp",
      "node /Users/test/.workbuddy/node/bin/dsh web",
      "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop",
      "opencode serve",
    ].join("\n"), { codexDesktopOpen: true });

    expect([...open].sort()).toEqual([
      "codex",
      "deepseek",
      "grok",
      "opencode",
      "reasonix",
      "tclaude",
      "workbuddy",
    ]);
    expect(open.has("claude")).toBe(false);
  });

  test("explains terminal capability limits instead of exposing a generic mobile error", () => {
    expect(formatMobileTaskListUnavailableMessage(
      "tclaude",
      new Error('WeChat /resume is disabled in claude mode.'),
    )).toBe(
      "TClaude 已连接，但网页版暂不支持读取这个终端的任务列表。请在微信或电脑终端中继续使用。",
    );
    expect(formatMobileTaskListUnavailableMessage(
      "tclaude",
      new Error("tclaude companion is connected but not ready yet."),
    )).toBe("TClaude 正在连接，请稍后再试。");
    expect(formatMobileTaskListUnavailableMessage(
      "codex",
      new Error("unexpected decoder failure"),
    )).toBeNull();
  });

  test("uses thread, turn, and request id to deduplicate approval notifications", () => {
    expect(buildDaemonApprovalNotificationKey({
      threadId: "thread-a",
      turnId: "turn-a",
      requestId: "request-a",
      commandPreview: "npm test",
    })).toBe(buildDaemonApprovalNotificationKey({
      threadId: "thread-a",
      turnId: "turn-a",
      requestId: "request-a",
      commandPreview: "updated preview",
    }));
    expect(buildDaemonApprovalNotificationKey({
      threadId: "thread-a",
      turnId: "turn-b",
      requestId: "request-a",
      commandPreview: "npm test",
    })).not.toBe(buildDaemonApprovalNotificationKey({
      threadId: "thread-a",
      turnId: "turn-a",
      requestId: "request-a",
      commandPreview: "npm test",
    }));
  });

  test("keeps automatic approval scoped to one task across turns", () => {
    const autoApprover = new DaemonTaskApprovalAutoApprover();

    expect(autoApprover.enable({
      threadId: "thread-a",
      turnId: "turn-1",
    })).toBe(true);
    expect(autoApprover.shouldAutoApprove({
      threadId: "thread-a",
      turnId: "turn-1",
    })).toBe(true);
    expect(autoApprover.snapshot()).toEqual([{
      threadId: "thread-a",
    }]);
    expect(autoApprover.shouldAutoApprove({
      threadId: "thread-a",
      turnId: "turn-2",
    })).toBe(true);
    expect(autoApprover.shouldAutoApprove({
      threadId: "thread-b",
      turnId: "turn-1",
    })).toBe(false);

    autoApprover.clear();
    expect(autoApprover.shouldAutoApprove({
      threadId: "thread-a",
      turnId: "turn-2",
    })).toBe(false);
    expect(autoApprover.snapshot()).toEqual([]);
  });

  test("wires task-scoped automatic approval into approval and completion events", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const approvalStart = source.indexOf('      case "approval_required":');
    const approvalEnd = source.indexOf('      case "user_input_required":', approvalStart);
    const completionStart = source.indexOf('      case "task_complete":');
    const completionEnd = source.indexOf('      case "task_failed":', completionStart);
    const confirmStart = source.indexOf('      case "confirm_task":');
    const confirmEnd = source.indexOf('      case "deny":', confirmStart);

    expect(approvalStart).toBeGreaterThan(-1);
    expect(approvalEnd).toBeGreaterThan(approvalStart);
    expect(source.slice(approvalStart, approvalEnd)).toContain(
      "taskApprovalAutoApprover.shouldAutoApprove",
    );
    expect(source.slice(approvalStart, approvalEnd)).toContain(
      'resolveTaskApprovals(pending.threadId, "confirm")',
    );
    const approvalSource = source.slice(approvalStart, approvalEnd);
    expect(approvalSource).toContain("approval_task_auto_confirm_error");
    expect(approvalSource.indexOf("approval_task_auto_confirm_error")).toBeLessThan(
      approvalSource.indexOf("approvalNotificationDeliveries.enqueue"),
    );
    expect(completionStart).toBeGreaterThan(-1);
    expect(completionEnd).toBeGreaterThan(completionStart);
    expect(source.slice(completionStart, completionEnd)).not.toContain(
      "finishTaskApprovalAutoApprove",
    );
    const failureStart = source.indexOf('      case "task_failed":');
    const failureEnd = source.indexOf('      case "fatal_error":', failureStart);
    expect(failureStart).toBeGreaterThan(-1);
    expect(failureEnd).toBeGreaterThan(failureStart);
    expect(source.slice(failureStart, failureEnd)).not.toContain(
      "finishTaskApprovalAutoApprove",
    );
    const createSlotStart = source.indexOf("  private async createSlot(");
    const createSlotEnd = source.indexOf("  private async startFreshSlotSession(", createSlotStart);
    expect(source.slice(createSlotStart, createSlotEnd)).toContain(
      "getTaskApprovalAutoApproveIdentities",
    );
    const fatalStart = source.indexOf('      case "fatal_error":');
    const fatalEnd = source.indexOf('      case "shutdown_requested":', fatalStart);
    expect(source.slice(fatalStart, fatalEnd)).not.toContain(
      "clearTaskApprovalAutoApprovals",
    );
    expect(source.slice(fatalStart, fatalEnd)).not.toContain(
      "taskApprovalAutoApprover.clear",
    );
    expect(confirmStart).toBeGreaterThan(-1);
    expect(confirmEnd).toBeGreaterThan(confirmStart);
    expect(source.slice(confirmStart, confirmEnd)).toContain(
      "enableTaskApprovalAutoConfirm",
    );
  });

  test("persists resolved approvals for the mobile task transcript", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const readStart = source.indexOf("  private async readMobileMessages(");
    const readEnd = source.indexOf("  private async readHistoricalLatestMessage(", readStart);
    const webStart = source.indexOf("  private async resolveMobileApproval(");
    const webEnd = source.indexOf("  private async updateMobileQueuedMessage(", webStart);
    const targetStart = source.indexOf("  private async resolvePendingApprovalTarget(");
    const targetEnd = source.indexOf("  private async handlePendingApprovalSequence(", targetStart);

    expect(source.slice(readStart, readEnd)).toContain(
      "getMobileApprovalResults(slot.adapter, threadId)",
    );
    expect(source.slice(webStart, webEnd)).toContain(
      "recordMobileApprovalResult(slot, pending, action",
    );
    expect(source.slice(targetStart, targetEnd)).toContain(
      "recordMobileApprovalResult(slot, pending, resolution.action",
    );
  });

  test("routes a plain follow-up to the task named by the latest task notification", () => {
    expect(resolveCodexWechatReplyThreadId({
      currentThreadId: "thread-3",
      notifiedThreadId: "thread-2",
    })).toBe("thread-2");
    expect(resolveCodexWechatReplyThreadId({
      currentThreadId: "thread-3",
    })).toBe("thread-3");
  });

  test("routes number-colon content to the matching stable task number for every adapter", () => {
    const snapshot = resolveDaemonTaskListSnapshot({
      latestCandidates: [
        { sessionId: "thread-1", title: "任务一", lastUpdatedAt: "2026-08-04T01:00:00.000Z" },
        { sessionId: "thread-2", title: "任务二", lastUpdatedAt: "2026-08-04T02:00:00.000Z" },
      ],
      refresh: true,
    });

    for (const text of [
      "2:继续处理",
      "2：继续处理",
      "2 : 继续处理",
      "2 ： 继续处理",
      "任务2:继续处理",
      "任务 2 ： 继续处理",
    ]) {
      expect(resolveDaemonTaskTargetedMessage({ text, snapshot })).toEqual({
        candidate: snapshot.candidates[1],
        text: "继续处理",
      });
    }
    expect(resolveDaemonTaskTargetedMessage({ text: "3:不存在", snapshot })).toBeNull();
    expect(resolveDaemonTaskTargetedMessage({ text: "2:", snapshot })).toBeNull();
    expect(resolveDaemonTaskTargetedMessage({ text: "2：继续处理", snapshot: null })).toBeNull();
  });

  test("keeps task numbers stable until the task list is explicitly refreshed", () => {
    const first = resolveDaemonTaskListSnapshot({
      latestCandidates: [
        { sessionId: "thread-2", title: "任务二", lastUpdatedAt: "2026-08-03T05:00:00.000Z" },
        { sessionId: "thread-3", title: "任务三", lastUpdatedAt: "2026-08-03T05:01:00.000Z" },
      ],
      refresh: true,
    });
    const retained = resolveDaemonTaskListSnapshot({
      current: first,
      latestCandidates: [
        {
          sessionId: "thread-3",
          title: "任务三",
          lastUpdatedAt: "2026-08-03T05:03:00.000Z",
          runtimeStatus: { type: "active", activeFlags: [] },
        },
        {
          sessionId: "thread-2",
          title: "任务二（已更新）",
          lastUpdatedAt: "2026-08-03T05:02:00.000Z",
          runtimeStatus: { type: "idle" },
        },
      ],
      refresh: false,
    });

    expect(retained.candidates.map((candidate) => candidate.sessionId)).toEqual([
      "thread-2",
      "thread-3",
    ]);
    expect(retained.candidates[0]?.title).toBe("任务二（已更新）");
    expect(retained.candidates[1]?.runtimeStatus?.type).toBe("active");
    expect(retained.numberByThreadId.get("thread-2")).toBe(1);
    expect(retained.numberByThreadId.get("thread-3")).toBe(2);

    const refreshed = resolveDaemonTaskListSnapshot({
      current: retained,
      latestCandidates: [
        { sessionId: "thread-3", title: "任务三", lastUpdatedAt: "2026-08-03T05:01:00.000Z" },
        { sessionId: "thread-2", title: "任务二", lastUpdatedAt: "2026-08-03T05:00:00.000Z" },
      ],
      refresh: true,
    });
    expect(refreshed.numberByThreadId.get("thread-3")).toBe(1);
    expect(refreshed.numberByThreadId.get("thread-2")).toBe(2);
  });

  test("hides stale Codex progress while a new mobile turn is awaiting its turn id", () => {
    expect(filterCodexMobileProgressForCurrentTurn({
      progressItems: [{
        id: "old-progress",
        turnId: "turn-old",
        kind: "reasoning",
        status: "running",
        text: "上一轮进展",
      }],
      hasActiveTask: true,
      runSummary: {
        turnId: "turn-old",
        status: "running",
      },
    })).toEqual([]);
  });

  test("keeps only progress belonging to the current Codex turn", () => {
    expect(filterCodexMobileProgressForCurrentTurn({
      progressItems: [
        {
          id: "old-progress",
          turnId: "turn-old",
          kind: "reasoning",
          status: "completed",
          text: "上一轮进展",
        },
        {
          id: "new-progress",
          turnId: "turn-new",
          kind: "plan",
          status: "running",
          text: "当前轮进展",
        },
      ],
      hasActiveTask: true,
      activeTurnId: "turn-new",
      runSummary: {
        turnId: "turn-old",
        status: "running",
      },
    })).toEqual([{
      id: "new-progress",
      turnId: "turn-new",
      kind: "plan",
      status: "running",
      text: "当前轮进展",
    }]);
  });

  test("does not fall back to old progress when the new active turn is authoritative", () => {
    expect(filterCodexMobileProgressForCurrentTurn({
      progressItems: [{
        id: "old-progress",
        turnId: "turn-old",
        kind: "reasoning",
        status: "completed",
        text: "上一轮进展",
      }],
      hasActiveTask: true,
      activeTurnId: "turn-new",
      activeTurnAuthoritative: true,
      runSummary: {
        turnId: "turn-old",
        status: "running",
      },
    })).toEqual([]);
  });

  test("prefers the live desktop turn when a stale bridge turn has no progress", () => {
    expect(filterCodexMobileProgressForCurrentTurn({
      progressItems: [{
        id: "desktop-progress",
        turnId: "turn-desktop",
        kind: "tool",
        status: "running",
        text: "等待桌面端审批",
      }],
      hasActiveTask: true,
      activeTurnId: "turn-stale-bridge",
      runSummary: {
        turnId: "turn-desktop",
        status: "running",
      },
    })).toEqual([{
      id: "desktop-progress",
      turnId: "turn-desktop",
      kind: "tool",
      status: "running",
      text: "等待桌面端审批",
    }]);
  });

  test("uses the desktop run turn when the task was started outside the bridge", () => {
    expect(filterCodexMobileProgressForCurrentTurn({
      progressItems: [
        {
          id: "old-progress",
          turnId: "turn-old",
          kind: "reasoning",
          status: "completed",
          text: "上一轮进展",
        },
        {
          id: "desktop-progress",
          turnId: "turn-desktop",
          kind: "tool",
          status: "running",
          text: "桌面端当前进展",
        },
      ],
      hasActiveTask: false,
      runSummary: {
        turnId: "turn-desktop",
        status: "running",
      },
    })).toEqual([{
      id: "desktop-progress",
      turnId: "turn-desktop",
      kind: "tool",
      status: "running",
      text: "桌面端当前进展",
    }]);
  });

  test("preserves matching completed progress and legacy progress without turn evidence", () => {
    const completedProgress = [{
      id: "completed-progress",
      turnId: "turn-completed",
      kind: "command" as const,
      status: "completed" as const,
      text: "已运行命令",
    }];
    expect(filterCodexMobileProgressForCurrentTurn({
      progressItems: [
        {
          id: "old-progress",
          turnId: "turn-old",
          kind: "reasoning",
          status: "completed",
          text: "更早的进展",
        },
        ...completedProgress,
      ],
      hasActiveTask: false,
      runSummary: {
        turnId: "turn-completed",
        status: "completed",
      },
    })).toEqual(completedProgress);
    expect(filterCodexMobileProgressForCurrentTurn({
      progressItems: completedProgress,
      hasActiveTask: false,
      runSummary: null,
    })).toEqual(completedProgress);
  });

  test("maps Codex desktop runtime states for the mobile task list", () => {
    expect(mapCodexMobileTaskStatus({ type: "idle" })).toBe("idle");
    expect(
      mapCodexMobileTaskStatus({
        type: "active",
        activeFlags: ["waitingOnApproval"],
      }),
    ).toBe("approval");
    expect(
      mapCodexMobileTaskStatus({
        type: "active",
        activeFlags: ["waitingOnUserInput"],
      }),
    ).toBe("input");
    expect(
      mapCodexMobileTaskStatus({ type: "active", activeFlags: [] }),
    ).toBe("running");
  });

  test("subscribes to active Codex summary state so approval and input can be discovered", () => {
    expect(shouldFollowCodexActiveTask({
      type: "active",
      activeFlags: [],
    })).toBe(true);
    expect(shouldFollowCodexActiveTask({
      type: "active",
      activeFlags: ["waitingOnApproval"],
    })).toBe(true);
    expect(shouldFollowCodexActiveTask({
      type: "active",
      activeFlags: ["waitingOnUserInput"],
    })).toBe(true);
    expect(shouldFollowCodexActiveTask({ type: "idle" })).toBe(false);
  });

  test("lets the desktop owner override stale local approval and running flags", () => {
    expect(resolveCodexMobileTaskStatusFromSignals({
      runtimeStatus: { type: "idle" },
      hasPendingApproval: true,
      hasPendingUserInput: true,
      hasActiveTask: true,
      selectedStateStatus: "busy",
    })).toBe("idle");
    expect(resolveCodexMobileTaskStatusFromSignals({
      runtimeStatus: { type: "active", activeFlags: [] },
      hasPendingApproval: true,
      hasPendingUserInput: false,
      hasActiveTask: true,
      selectedStateStatus: "busy",
    })).toBe("approval");
    expect(resolveCodexMobileTaskStatusFromSignals({
      runtimeStatus: { type: "active", activeFlags: [] },
      hasPendingApproval: true,
      runtimeTaskApprovals: [],
      hasPendingUserInput: false,
      hasActiveTask: true,
      selectedStateStatus: "busy",
    })).toBe("running");
    expect(resolveCodexMobileTaskStatusFromSignals({
      runtimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] },
      hasPendingApproval: true,
      runtimeTaskApprovals: [],
      hasPendingUserInput: false,
      hasActiveTask: true,
      selectedStateStatus: "awaiting_approval",
    })).toBe("running");
    expect(resolveCodexMobileTaskStatusFromSignals({
      runtimeStatus: { type: "notLoaded" },
      hasPendingApproval: false,
      hasPendingUserInput: false,
      hasActiveTask: true,
      selectedStateStatus: "idle",
    })).toBe("running");
  });

  test("lets a connected non-Codex runtime override a stale idle task snapshot", () => {
    expect(resolveCodexMobileTaskStatusFromSignals({
      runtimeStatus: { type: "idle" },
      hasPendingApproval: false,
      hasPendingUserInput: false,
      hasActiveTask: true,
      selectedStateStatus: "busy",
      preferSelectedState: true,
    })).toBe("running");
    expect(resolveCodexMobileTaskStatusFromSignals({
      runtimeStatus: { type: "idle" },
      hasPendingApproval: true,
      hasPendingUserInput: false,
      hasActiveTask: true,
      selectedStateStatus: "awaiting_approval",
      preferSelectedState: true,
    })).toBe("approval");
  });

  test("restores a selected task approval from the desktop runtime after daemon restart", () => {
    const pending = resolveCodexMobilePendingApprovalFromSignals({
      threadId: "thread-a",
      selectedThreadId: "thread-a",
      pendingConfirmations: [],
      runtimeTaskApprovals: [{
        source: "cli",
        summary: "Codex 请求运行命令。",
        commandPreview: "npm run quality",
        requestId: "approval-runtime",
        turnId: "turn-runtime",
        createdAt: "2026-08-12T04:00:00.000Z",
        allowForSession: true,
      }],
      runtimePendingApproval: {
        source: "cli",
        summary: "旧的运行状态摘要",
        commandPreview: "stale command",
        allowForSession: true,
      },
    });

    expect(pending).toEqual({
      summary: "Codex 请求运行命令。",
      commandPreview: "npm run quality",
      requestId: "approval-runtime",
      turnId: "turn-runtime",
      createdAtMs: Date.parse("2026-08-12T04:00:00.000Z"),
      allowForSession: true,
    });
    expect(
      resolveCodexMobilePendingApprovalFromSignals({
        threadId: "thread-b",
        selectedThreadId: "thread-a",
        pendingConfirmations: [{
          source: "cli",
          summary: "已经失效的审批",
          commandPreview: "stale command",
          code: "STALE",
          createdAt: "2026-08-02T00:00:00.000Z",
          threadId: "thread-b",
        }],
        runtimeTaskApprovals: [],
        runtimePendingApproval: {
          source: "cli",
          summary: "另一项审批",
          commandPreview: "npm test",
        },
      }),
    ).toBeNull();
  });

  test("allows bare task commands before an active adapter has been selected", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const inboundStart = source.indexOf("  private async handleInboundMessage(");
    const inboundEnd = source.indexOf("\n  private async handleDaemonTaskTargetedMessage(", inboundStart);
    const inboundBlock = source.slice(inboundStart, inboundEnd);
    const earlyGlobalIndex = inboundBlock.indexOf("await this.handleGlobalTaskInputWithoutActiveSlot(message)");
    const activeSlotGuardIndex = inboundBlock.indexOf("const slot = this.getActiveSlot()");

    expect(earlyGlobalIndex).toBeGreaterThan(-1);
    expect(activeSlotGuardIndex).toBeGreaterThan(-1);
    expect(earlyGlobalIndex).toBeLessThan(activeSlotGuardIndex);
  });

  test("builds the ClawBot global list from running terminals instead of every supported adapter", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const listStart = source.indexOf("  private async listWechatGlobalTaskCandidates(");
    const listEnd = source.indexOf("\n  private async listGlobalTaskCandidates(", listStart);
    const listBlock = source.slice(listStart, listEnd);

    expect(listStart).toBeGreaterThan(-1);
    expect(listEnd).toBeGreaterThan(listStart);
    expect(listBlock).toContain("readOpenMobileAdapters(this.cwd)");
    expect(listBlock).toContain("this.slots.keys()");
    expect(listBlock).toContain("selectRunningGlobalTaskAdapters");
    expect(listBlock).toContain("this.listGlobalTaskCandidates(adapters)");
    expect(listBlock).not.toContain("prioritizeGlobalTaskAdapterCoverage");
  });

  test("rediscovers the current DeepSeek Harness host while preserving live interaction flags", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const listStart = source.indexOf("  private async listGlobalTaskCandidates(");
    const listEnd = source.indexOf("\n  private async activateExactGlobalTask(", listStart);
    const listBlock = source.slice(listStart, listEnd);

    expect(listBlock).toContain('slot.adapter === "deepseek"');
    expect(listBlock).toContain("listLightweightAdapterSessions");
    expect(listBlock).toContain("mergeSessionRuntimeSignals");
  });

  test("enumerates disconnected Codex tasks without restoring a desktop task", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const listStart = source.indexOf("  private async listGlobalTaskCandidates(");
    const listEnd = source.indexOf("\n  private async activateExactGlobalTask(", listStart);
    const listBlock = source.slice(listStart, listEnd);

    expect(listStart).toBeGreaterThan(-1);
    expect(listEnd).toBeGreaterThan(listStart);
    expect(listBlock).toContain('adapter === "codex"');
    expect(listBlock).not.toContain("this.stateStore.getAdapterSessionId(adapter)");
  });

  test("uses the global task index for bare task commands and preserves the current list scope for navigation", () => {
    expect(isExplicitGlobalTaskListRequest("任务")).toBe(true);
    expect(isExplicitGlobalTaskListRequest("任务列表")).toBe(true);
    expect(isExplicitGlobalTaskListRequest("任务：canvas")).toBe(true);
    expect(isExplicitGlobalTaskListRequest("任务 canvas")).toBe(true);
    expect(isExplicitGlobalTaskListRequest("任务canvas")).toBe(true);
    expect(isExplicitGlobalTaskListRequest("/tasks")).toBe(true);
    expect(isExplicitGlobalTaskListRequest("/tasks 2")).toBe(true);
    expect(isExplicitGlobalTaskListRequest("/threads keyword")).toBe(true);
    expect(isExplicitGlobalTaskListRequest("/t2")).toBe(false);
    expect(resolveDaemonTaskListScope({
      text: "任务",
      activeScope: "adapter",
    })).toBe("global");
    expect(resolveDaemonTaskListScope({
      text: "任务：canvas",
      activeScope: "adapter",
    })).toBe("global");
    expect(resolveDaemonTaskListScope({
      text: "任务canvas",
      activeScope: "adapter",
    })).toBe("global");
    expect(resolveDaemonTaskListScope({
      text: "/t2",
      activeScope: "adapter",
    })).toBe("adapter");
    expect(resolveDaemonTaskListScope({
      text: "下一页20",
      activeScope: "global",
    })).toBe("global");
  });

  test("lets the latest approval prompt own bare numbers while explicit task commands still switch tasks", () => {
    expect(resolveDaemonWechatCommand({
      adapter: "codex",
      text: "2",
      awaitingBareTaskSelection: true,
      hasPendingConfirmation: true,
      hasPendingUserInput: false,
      canConfirmForSession: true,
    })).toEqual({ type: "deny" });
    expect(resolveDaemonWechatCommand({
      adapter: "claude",
      text: "2",
      awaitingBareTaskSelection: true,
      hasPendingConfirmation: false,
      hasPendingUserInput: false,
    })).toEqual({ type: "resume", target: "2" });
    expect(resolveDaemonWechatCommand({
      adapter: "codex",
      text: "2",
      awaitingBareTaskSelection: false,
      hasPendingConfirmation: true,
      hasPendingUserInput: false,
      canConfirmForSession: true,
    })).toEqual({ type: "deny" });
    expect(resolveDaemonWechatCommand({
      adapter: "codex",
      text: "任务 2",
      awaitingBareTaskSelection: false,
      hasPendingConfirmation: true,
      hasPendingUserInput: false,
    })).toEqual({ type: "resume", target: "2" });
    expect(resolveDaemonWechatCommand({
      adapter: "codex",
      text: "任务：2",
      awaitingBareTaskSelection: false,
      hasPendingConfirmation: true,
      hasPendingUserInput: false,
    })).toEqual({ type: "resume", target: "2" });
    expect(resolveDaemonWechatCommand({
      adapter: "codex",
      text: "任务：震荡止损",
      awaitingBareTaskSelection: false,
      hasPendingConfirmation: true,
      hasPendingUserInput: false,
    })).toEqual({ type: "resume", target: "震荡止损" });
  });

  test("never forwards a bare number to the model when it can select a recent task or needs clarification", () => {
    const adapterSnapshot = resolveDaemonTaskListSnapshot({
      latestCandidates: [
        { sessionId: "thread-1", title: "任务一", lastUpdatedAt: "2026-08-16T01:00:00.000Z" },
        { sessionId: "thread-2", title: "任务二", lastUpdatedAt: "2026-08-16T02:00:00.000Z" },
      ],
      refresh: true,
    });

    expect(resolveDaemonBareNumericReply({
      text: "2",
      taskListScope: "adapter",
      adapterSnapshot,
      globalSnapshot: null,
    })).toEqual({ type: "resume", target: "2" });
    expect(resolveDaemonBareNumericReply({
      text: "9",
      taskListScope: "adapter",
      adapterSnapshot,
      globalSnapshot: null,
    })).toEqual({ type: "clarify", number: "9" });
    expect(resolveDaemonBareNumericReply({
      text: "继续处理",
      taskListScope: "adapter",
      adapterSnapshot,
      globalSnapshot: null,
    })).toBeNull();
  });

  test("sends a mobile link for every settled Codex task with a thread", () => {
    expect(shouldSendCodexMobileTaskLink("completed", "thread_a")).toBe(true);
    expect(shouldSendCodexMobileTaskLink(undefined, "thread_a")).toBe(true);
    expect(shouldSendCodexMobileTaskLink("interrupted", "thread_a")).toBe(true);
    expect(shouldSendCodexMobileTaskLink("failed", "thread_a")).toBe(true);
    expect(shouldSendCodexMobileTaskLink("completed", undefined)).toBe(false);
  });

  test("confirms Relay task aliases before any WeChat text is sent", () => {
    const daemonSource = fs.readFileSync(
      path.join(process.cwd(), "src/daemon/werelay-daemon.ts"),
      "utf8",
    );
    const prepareStart = daemonSource.indexOf("  private async prepareWechatMessageTaskLinks");
    const queueEnd = daemonSource.indexOf("\n  private trackWechatForwardTask", prepareStart);
    const queueBlock = daemonSource.slice(prepareStart, queueEnd);
    expect(queueBlock).toContain("confirmTaskLinksInText(text)");
    expect(queueBlock).toContain("sendWechatMessageNow(senderId, preparedText, context)");
    expect(queueBlock).not.toContain("sendWechatMessageNow(senderId, text, context)");
  });

  test("adds one concise mobile link to task-scoped messages", () => {
    const url = "http://198.51.100.10/?task=0000000a&key=secret";
    expect(appendCodexMobileTaskLink("已收到，处理中。", url)).toBe(
      `已收到，处理中。\n\n${url}`,
    );
    expect(appendCodexMobileTaskLink(`已切换。\n\n${url}`, url)).toBe(
      `已切换。\n\n${url}`,
    );
    expect(appendCodexMobileTaskLink("任务列表", undefined)).toBe("任务列表");
  });

  test("replaces Codex final output with one named linked completion notice", () => {
    expect(shouldForwardDaemonFinalReply("codex")).toBe(false);
    expect(shouldForwardDaemonFinalReply("claude")).toBe(true);
    expect(shouldForwardDaemonFinalReply("deepseek")).toBe(true);
    expect(formatCompactTaskDuration(547_000)).toBe("9m 7s");
    expect(
      formatCodexTaskCompletionMessage({
        title: "完善移动版消息",
        taskNumber: 3,
        outcome: "completed",
        durationMs: 547_000,
        requestPreview: "让完成通知明确显示本次处理的具体请求",
        preview: "已完成移动端消息刷新。",
        url: "http://192.168.50.10:4396/?task=0000000a&key=secret",
      }),
    ).toBe(
      "[完善移动版消息] 已完成，用时9m 7s\n本次任务：让完成通知明确显示本次处理的具体请求\n\n已完成移动端消息刷新。\n\n发送“全文”查看完整回答；网页版可查看完整任务及列表。\n\nhttp://192.168.50.10:4396/?task=0000000a&key=secret",
    );
    expect(
      formatCodexTaskCompletionMessage({
        title: "完善移动版消息",
        outcome: "interrupted",
        durationMs: 65_000,
        url: "http://192.168.50.10:4396/?task=0000000a&key=secret",
      }),
    ).toStartWith("[完善移动版消息] 已中断，用时1m 5s\n");
    expect(
      formatCodexTaskCompletionMessage({
        title: "完善移动版消息",
        outcome: "failed",
        durationMs: 8_000,
        url: "http://192.168.50.10:4396/?task=0000000a&key=secret",
      }),
    ).toStartWith("[完善移动版消息] 执行失败，用时8s\n");
    expect(
      formatCodexTaskCompletionMessage({
        title: "长回复任务",
        outcome: "completed",
        durationMs: 8_000,
        preview: "一二三四五六七八九十",
        previewLimit: 8,
        url: "http://192.168.50.10:4396/?task=thread&key=secret",
      }),
    ).toBe(
      "[长回复任务] 已完成，用时8s\n\n一二三四五六七八…\n后面还有 2 字，共 10 字\n\n发送“全文”查看完整回答；网页版可查看完整任务及列表。\n\nhttp://192.168.50.10:4396/?task=thread&key=secret",
    );

    expect(
      formatCodexTaskCompletionMessage({
        title: "网页不可用",
        outcome: "completed",
        durationMs: 1_000,
        preview: "任务结果",
      }),
    ).toBe(
      "[网页不可用] 已完成，用时1s\n\n任务结果\n\n发送“全文”查看完整回答。",
    );
  });

  test("keeps only one semantic task link in completion notices", () => {
    const canonicalUrl = "https://203.0.113.10/?task=thread_a&appv=current";
    const variantUrl = "https://203.0.113.10/?task=thread_a&adapter=codex&appv=old";
    const message = formatCodexTaskCompletionMessage({
      title: "修复重复消息",
      outcome: "completed",
      durationMs: 5_000,
      requestPreview: `${variantUrl} 检查网页消息重复`,
      url: canonicalUrl,
    });

    expect(message).toContain("本次任务：检查网页消息重复");
    expect(message).not.toContain(variantUrl);
    expect(message).toEndWith(canonicalUrl);
    expect(message.split("https://203.0.113.10/")).toHaveLength(2);
    expect(appendCodexMobileTaskLink(`已完成\n\n${variantUrl}`, canonicalUrl)).toBe(
      `已完成\n\n${variantUrl}`,
    );
    const fullMessages = formatCodexTaskCompletionMessages({
      title: "修复重复消息",
      outcome: "completed",
      durationMs: 5_000,
      requestPreview: `${variantUrl} 检查网页消息重复`,
      text: `已经处理完成。\n\n${variantUrl}`,
      url: canonicalUrl,
      mode: "full",
    });
    expect(fullMessages.join("\n")).toContain("本次任务：检查网页消息重复");
    expect(fullMessages.join("\n")).not.toContain(variantUrl);
    expect(fullMessages.join("\n").split("https://203.0.113.10/")).toHaveLength(2);
  });

  test("does not announce a synthetic completion while the latest turn is running or user-only", () => {
    expect(shouldSendCodexCompletionNotification({
      runSummary: {
        turnId: "turn_new",
        status: "running",
        startedAtMs: 10_000,
        durationMs: 5_000,
      },
      latestMessage: { role: "user", text: "刚提交的新任务", turnId: "turn_new" },
    })).toBe(false);
    expect(shouldSendCodexCompletionNotification({
      runSummary: {
        turnId: "turn_done",
        status: "completed",
        completedAtMs: 20_000,
        durationMs: 5_000,
      },
      latestMessage: {
        role: "assistant",
        text: "已经完成",
        turnId: "turn_done",
        phase: "final_answer",
      },
    })).toBe(true);
    expect(shouldSendCodexCompletionNotification({
      runSummary: {
        turnId: "turn_unphased",
        status: "completed",
        completedAtMs: 21_000,
        durationMs: 4_000,
      },
      latestMessage: {
        role: "assistant",
        text: "这是缺少 phase 的真实最终回答",
        turnId: "turn_unphased",
      },
    })).toBe(true);
    expect(shouldSendCodexCompletionNotification({
      runSummary: {
        turnId: "turn_new",
        status: "completed",
        completedAtMs: 22_000,
        durationMs: 4_000,
      },
      latestMessage: {
        role: "assistant",
        text: "旧轮次回答",
        turnId: "turn_old",
      },
    })).toBe(false);
    expect(shouldSendCodexCompletionNotification({
      runSummary: {
        turnId: "turn_commentary",
        status: "completed",
        completedAtMs: 23_000,
        durationMs: 4_000,
      },
      latestMessage: {
        role: "assistant",
        text: "处理中",
        turnId: "turn_commentary",
        phase: "commentary",
      },
    })).toBe(false);
    expect(shouldSendCodexCompletionNotification({
      runSummary: {
        turnId: "turn_thinking_only",
        status: "completed",
        completedAtMs: 24_000,
        durationMs: 4_000,
      },
      latestMessage: {
        role: "assistant",
        text: "<thinking>仅内部思考</thinking>",
        turnId: "turn_thinking_only",
      },
    })).toBe(false);
    expect(shouldSendCodexCompletionNotification({
      eventTurnId: "turn_failed",
      runSummary: null,
      latestMessage: null,
    })).toBe(true);
    expect(shouldSendCodexCompletionNotification({
      eventTurnId: "turn_done",
      runSummary: {
        turnId: "turn_done",
        status: "running",
        startedAtMs: 10_000,
        durationMs: 5_000,
      },
      latestMessage: { role: "user", text: "下一条任务", turnId: "turn_new" },
    })).toBe(true);
  });

  test("formats full Codex replies as safe WeChat message chunks", () => {
    const fullText = `第一段\n\n${"完整内容".repeat(500)}`;
    const messages = formatCodexTaskCompletionMessages({
      title: "全文任务",
      taskNumber: 8,
      outcome: "completed",
      durationMs: 9_000,
      text: fullText,
      url: "http://192.168.50.10:4396/?task=thread&key=secret",
      mode: "full",
    });

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 1_200)).toBe(true);
    expect(messages.join("\n")).toContain("[全文任务] 已完成，用时9s");
    expect(messages.join("")).toContain("完整内容".repeat(500));
    expect(messages.at(-1)).toEndWith(
      "http://192.168.50.10:4396/?task=thread&key=secret",
    );
  });

  test("formats the current task latest full reply for on-demand fallback", () => {
    const messages = formatCurrentCodexFullReplyMessages({
      title: "当前任务",
      taskNumber: 4,
      text: "这是完整回答。",
    });
    expect(messages).toEqual([
      "[当前任务] 最近完整回答\n\n这是完整回答。",
    ]);
  });

  test("observes every desktop task and detects active-to-idle completion", () => {
    const active = observeCodexTask(null, {
      sessionId: "thread_a",
      title: "后台任务",
      lastUpdatedAt: "2026-08-01T01:00:00.000Z",
      runtimeStatus: { type: "active", activeFlags: [] },
    }, 1_000);
    expect(active.completion).toBeUndefined();
    expect(active.observation.runningSinceMs).toBe(1_000);

    const completed = observeCodexTask(active.observation, {
      sessionId: "thread_a",
      title: "后台任务",
      lastUpdatedAt: "2026-08-01T01:09:07.000Z",
      runtimeStatus: { type: "idle" },
    }, 548_000);
    expect(completed.completion).toEqual({
      outcome: "completed",
      startedAtMs: 1_000,
    });

    const retryAfterEvidenceLag = observeCodexTask({
      ...completed.observation,
      completionNotified: false,
    }, {
      sessionId: "thread_a",
      title: "后台任务",
      lastUpdatedAt: "2026-08-01T01:09:07.000Z",
      runtimeStatus: { type: "idle" },
    }, 550_000);
    expect(retryAfterEvidenceLag.completion).toEqual({
      outcome: "completed",
      startedAtMs: 1_000,
    });
    expect(shouldInferCodexIdleRecencyCompletion(
      {
        ...completed.observation,
        completionNotified: false,
      },
      {
        sessionId: "thread_a",
        title: "后台任务",
        lastUpdatedAt: "2026-08-01T01:09:08.000Z",
        runtimeStatus: { type: "idle" },
      },
    )).toBe(false);
    expect(shouldInferCodexIdleRecencyCompletion(
      {
        title: "后台任务",
        lastUpdatedAt: "2026-08-01T01:09:07.000Z",
        status: "idle",
        completionNotified: false,
      },
      {
        sessionId: "thread_a",
        title: "后台任务",
        lastUpdatedAt: "2026-08-01T01:09:08.000Z",
        runtimeStatus: { type: "idle" },
      },
    )).toBe(true);

    expect(deferCodexCompletionObservationRetry(
      {
        title: "后台任务",
        lastUpdatedAt: "2026-08-01T01:09:07.000Z",
        status: "idle",
        completionNotified: false,
      },
      {
        title: "后台任务",
        lastUpdatedAt: "2026-08-01T01:09:08.000Z",
        status: "idle",
        completionNotified: true,
      },
      true,
    )).toEqual({
      title: "后台任务",
      lastUpdatedAt: "2026-08-01T01:09:07.000Z",
      status: "idle",
      completionNotified: false,
    });

    const temporarilyUnavailable = observeCodexTask(active.observation, {
      sessionId: "thread_a",
      title: "后台任务",
      lastUpdatedAt: "2026-08-01T01:05:00.000Z",
      runtimeStatus: { type: "notLoaded" },
    }, 301_000);
    expect(temporarilyUnavailable.completion).toBeUndefined();
    expect(temporarilyUnavailable.observation.status).toBe("running");
    expect(temporarilyUnavailable.observation.runningSinceMs).toBe(1_000);
  });

  test("keeps the terminal prefix at entry and uses only task labels afterwards", () => {
    expect(prefixDaemonAdapterMessage("codex", "已进入 Codex。"))
      .toBe("[codex]\n已进入 Codex。");
    expect(prefixDaemonTaskMessage("codex", "需要审批", 3, "thread_a"))
      .toBe("[Codex 任务]\n需要审批");
    expect(prefixDaemonTaskMessage("claude", "任务已继续"))
      .toBe("任务已继续");
    expect(prefixDaemonTaskMessage(
      "claude",
      "任务已继续",
      2,
      "session_a",
      "修复 hooks",
    )).toBe("[Claude Code · 修复 hooks]\n任务已继续");
    expect(prefixDaemonTaskMessage(
      "codex",
      "需要审批",
      3,
      "thread_a",
      "codex-clawbot",
    )).toBe("[WeRelay]\n需要审批");
  });

  test("does not reuse an older turn reply as the next completion preview", () => {
    expect(selectCodexCompletionReplyText({
      resolvedTurnId: "turn_new",
      threadReply: { turnId: "turn_old", text: "旧回复" },
      latestMessage: {
        role: "assistant",
        text: "旧回复",
        turnId: "turn_old",
      },
    })).toBeUndefined();
    expect(selectCodexCompletionReplyText({
      resolvedTurnId: "turn_new",
      turnReply: "当前回复",
      threadReply: { turnId: "turn_old", text: "旧回复" },
      latestMessage: null,
    })).toBe("当前回复");
  });

  test("identifies a completion with the current turn request instead of only the chat title", () => {
    expect(selectCodexCompletionRequestPreview({
      resolvedTurnId: "turn_current",
      activeTaskPreview: "修复当前任务的完成通知",
      messages: [{
        role: "user",
        text: "旧任务内容",
        turnId: "turn_old",
      }],
    })).toBe("修复当前任务的完成通知");
    expect(selectCodexCompletionRequestPreview({
      resolvedTurnId: "turn_current",
      messages: [
        { role: "user", text: "旧任务内容", turnId: "turn_old" },
        { role: "user", text: "本次真实任务内容", turnId: "turn_current" },
        { role: "assistant", text: "已经完成", turnId: "turn_current" },
      ],
    })).toBe("本次真实任务内容");
    expect(selectCodexCompletionRequestPreview({
      resolvedTurnId: "turn_current",
      messages: [
        { role: "user", text: "旧任务内容", turnId: "turn_old" },
      ],
    })).toBeUndefined();
    expect(selectCodexCompletionRequestPreview({
      resolvedTurnId: "turn_current",
      messages: [{
        role: "user",
        turnId: "turn_current",
        text: [
          "[WeRelay WeChat note]",
          "English bridge guidance that must not enter the completion notice.",
          "",
          "[User request]",
          "把本次任务说清楚",
          "",
          "[WeChat inbound attachments — ACTION REQUIRED]",
          "kind=image path=/tmp/png1.png",
        ].join("\n"),
      }],
    })).toBe("把本次任务说清楚");
  });

  test("uses the persisted turn duration for completion notices", () => {
    expect(resolveCodexTaskCompletionDurationMs({
      turnId: "turn_current",
      runSummary: {
        turnId: "turn_current",
        status: "completed",
        startedAtMs: 1_000,
        completedAtMs: 548_000,
        durationMs: 547_000,
      },
      startedAtMs: 500_000,
      nowMs: 550_000,
    })).toBe(547_000);
    expect(resolveCodexTaskCompletionDurationMs({
      turnId: "turn_current",
      runSummary: {
        turnId: "turn_other",
        status: "completed",
        durationMs: 900_000,
      },
      startedAtMs: 500_000,
      nowMs: 550_000,
    })).toBe(50_000);
  });

  test("clears task state only for the completing turn", () => {
    expect(shouldClearCodexActiveTaskForCompletion("turn_current", "turn_current")).toBe(true);
    expect(shouldClearCodexActiveTaskForCompletion("turn_new", "turn_old")).toBe(false);
    expect(shouldClearCodexActiveTaskForCompletion(undefined, "turn_current")).toBe(false);
    expect(shouldClearCodexActiveTaskForCompletion(undefined, undefined)).toBe(true);
  });

  test("suppresses replayed historical Codex completion events", () => {
    const bridgeStartedAtMs = 10_000;
    expect(
      shouldForwardCodexTaskCompletionEvent({
        bridgeStartedAtMs,
        eventTurnId: "turn_old",
        runSummary: {
          turnId: "turn_old",
          status: "completed",
          completedAtMs: 9_000,
          durationMs: 1_000,
        },
        hasActiveTask: false,
        observationStatus: "idle",
      }),
    ).toBe(false);
    expect(
      shouldForwardCodexTaskCompletionEvent({
        bridgeStartedAtMs,
        eventTurnId: "turn_old",
        runSummary: {
          turnId: "turn_current",
          status: "running",
          startedAtMs: 9_500,
          durationMs: 500,
        },
        hasActiveTask: true,
        observationStatus: "running",
      }),
    ).toBe(false);
    expect(
      shouldForwardCodexTaskCompletionEvent({
        bridgeStartedAtMs,
        eventTurnId: "turn_current",
        activeTaskTurnId: "turn_current",
        runSummary: {
          turnId: "turn_current",
          status: "running",
          startedAtMs: 9_500,
          durationMs: 500,
        },
        hasActiveTask: true,
        observationStatus: "running",
      }),
    ).toBe(true);
    expect(
      shouldForwardCodexTaskCompletionEvent({
        bridgeStartedAtMs,
        eventTurnId: "turn_old",
        activeTaskTurnId: "turn_new",
        runSummary: null,
        hasActiveTask: true,
        observationStatus: "running",
      }),
    ).toBe(false);
  });

  test("forwards only a current completion or a completion with live task evidence", () => {
    expect(
      shouldForwardCodexTaskCompletionEvent({
        bridgeStartedAtMs: 10_000,
        eventTurnId: "turn_current",
        runSummary: {
          turnId: "turn_current",
          status: "completed",
          completedAtMs: 11_000,
          durationMs: 1_500,
        },
        hasActiveTask: false,
        observationStatus: "running",
      }),
    ).toBe(true);
    expect(
      shouldForwardCodexTaskCompletionEvent({
        bridgeStartedAtMs: 10_000,
        eventTurnId: "turn_current",
        runSummary: null,
        hasActiveTask: true,
        observationStatus: "idle",
      }),
    ).toBe(true);
    expect(
      shouldForwardCodexTaskCompletionEvent({
        bridgeStartedAtMs: 10_000,
        eventTurnId: "turn_unknown",
        runSummary: null,
        hasActiveTask: false,
        observationStatus: "idle",
      }),
    ).toBe(false);
  });

  test("retains failed completion notices for retry after context refresh", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    expect(source).toContain("retryPendingCodexCompletionNotifications");
    expect(source).toContain("codex_completion_pending");
    expect(source).toContain("codex_completion_resent");
    expect(source).not.toContain("codex_completion_dropped");
  });

  test("never hides mobile messages in a Bridge-owned Codex queue", () => {
    expect(shouldQueueCodexMobileMessage("running")).toBe(false);
    expect(shouldQueueCodexMobileMessage("approval")).toBe(false);
    expect(shouldQueueCodexMobileMessage("input")).toBe(false);
    expect(shouldQueueCodexMobileMessage("idle")).toBe(false);
    expect(shouldQueueCodexMobileMessage("error")).toBe(false);
  });

  test("backs off transient Codex reconnect retries instead of polling every 500ms", () => {
    expect(computeCodexDeferredDrainRetryDelayMs(1)).toBe(1_000);
    expect(computeCodexDeferredDrainRetryDelayMs(2)).toBe(2_000);
    expect(computeCodexDeferredDrainRetryDelayMs(3)).toBe(4_000);
    expect(computeCodexDeferredDrainRetryDelayMs(10)).toBe(30_000);
  });

  test("restores the persisted Codex thread through runtime options", () => {
    expect(
      buildDaemonRuntimeOptions({
        adapter: "codex",
        cwd: "/Users/test/project",
        sessionStartMode: "restore",
        initialSharedSessionId: "thread_previous",
      }),
    ).toMatchObject({
      kind: "codex",
      cwd: "/Users/test/project",
      sessionStartMode: "restore",
      initialSharedSessionId: "thread_previous",
      initialSharedThreadId: "thread_previous",
    });
  });

  test("lists the background Codex catalog without restoring or focusing a saved task", () => {
    expect(
      buildDaemonTaskCatalogRuntimeOptions({
        adapter: "codex",
        cwd: "/Users/test/project",
      }),
    ).toMatchObject({
      kind: "codex",
      cwd: "/Users/test/project",
      sessionStartMode: "new",
      allowDesktopApplicationLaunch: false,
    });
    expect(
      buildDaemonTaskCatalogRuntimeOptions({
        adapter: "codex",
        cwd: "/Users/test/project",
      }).initialSharedSessionId,
    ).toBeUndefined();
  });

  test("formats concise restart notices", () => {
    expect(formatDaemonRestartNotice(true)).toBe(
      "WeRelay 已重启，仍在原任务。\n直接发送消息即可继续；发送“任务”可切换。",
    );
    expect(formatDaemonRestartNotice(false)).toBe(
      "WeRelay 已重启。\n发送“任务”选择要继续的任务。",
    );
  });

  test("suppresses repeated restart notices during the same maintenance window", () => {
    const nowMs = Date.parse("2026-08-05T02:30:00.000+08:00");
    expect(shouldSendDaemonRestartNotice(null, nowMs)).toBe(false);
    expect(shouldSendDaemonRestartNotice({
      version: 1,
      cwd: "/Users/test/project",
      updatedAt: "2026-08-05T01:00:00.000+08:00",
    }, nowMs)).toBe(true);
    expect(shouldSendDaemonRestartNotice({
      version: 1,
      cwd: "/Users/test/project",
      restartNoticeSentAt: "2026-08-05T02:04:00.000+08:00",
      updatedAt: "2026-08-05T02:04:00.000+08:00",
    }, nowMs)).toBe(false);
    expect(shouldSendDaemonRestartNotice({
      version: 1,
      cwd: "/Users/test/project",
      restartNoticeSentAt: "2026-08-05T01:20:00.000+08:00",
      updatedAt: "2026-08-05T01:20:00.000+08:00",
    }, nowMs)).toBe(true);
  });

  test("keeps a failed restart notice pending until WeChat refreshes its token", async () => {
    const attempts: string[] = [];

    await expect(
      flushPendingDaemonRestartNotice(
        "重启提示",
        async (text) => {
          attempts.push(text);
          return false;
        },
      ),
    ).resolves.toBe("重启提示");

    await expect(
      flushPendingDaemonRestartNotice(
        "重启提示",
        async (text) => {
          attempts.push(text);
          return true;
        },
      ),
    ).resolves.toBeNull();
    expect(attempts).toEqual(["重启提示", "重启提示"]);
  });

  test("does not send an extra task-switch message for startup restoration", () => {
    expect(shouldForwardDaemonThreadSwitch("startup_restore")).toBe(false);
    expect(shouldForwardDaemonThreadSwitch("wechat_resume")).toBe(false);
    expect(shouldForwardDaemonThreadSwitch("local_follow")).toBe(false);
    expect(shouldForwardDaemonThreadSwitch("local_turn")).toBe(false);

    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const sessionSwitchStart = source.indexOf('      case "session_switched":');
    const sessionSwitchEnd = source.indexOf('      case "thread_switched":', sessionSwitchStart);
    expect(sessionSwitchStart).toBeGreaterThan(-1);
    expect(sessionSwitchEnd).toBeGreaterThan(sessionSwitchStart);
    expect(source.slice(sessionSwitchStart, sessionSwitchEnd)).toContain(
      "shouldForwardDaemonThreadSwitch(event.reason)",
    );
  });

  test("reuses the recent background task cache", () => {
    expect(isCodexTaskCandidateCacheFresh({
      cachedAtMs: 8_000,
      nowMs: 10_000,
      maxAgeMs: 3_000,
    })).toBe(true);
    expect(isCodexTaskCandidateCacheFresh({
      cachedAtMs: 6_000,
      nowMs: 10_000,
      maxAgeMs: 3_000,
    })).toBe(false);
    expect(isCodexTaskCandidateCacheFresh({
      cachedAtMs: 0,
      nowMs: 10_000,
      maxAgeMs: 3_000,
    })).toBe(false);
  });

  test("creates ClawBot tasks without clearing other background task state", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const start = source.indexOf('      case "new_session":');
    const end = source.indexOf('      case "stop":', start);
    const block = source.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain("已新建");
    expect(block).toContain("直接发送消息即可开始");
    expect(block).toContain("command.input");
    expect(block).toContain("suppressCodexAcceptedNotice");
    expect(block).toContain("本次任务");
    expect(block).not.toContain("clearDeferredCodexInboundMessages");
    expect(block).not.toContain("activeTasks.clear");
  });

  test("keeps ClawBot task selection independent from desktop task switching", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const targetedStart = source.indexOf("  private async handleDaemonTaskTargetedMessage(");
    const targetedEnd = source.indexOf("\n  private async handleSystemCommand(", targetedStart);
    const resumeStart = source.indexOf('      case "resume": {');
    const resumeEnd = source.indexOf('      case "new_session":', resumeStart);
    const switchStart = source.indexOf('      case "thread_switched":');
    const switchEnd = source.indexOf('      case "task_complete":', switchStart);

    expect(targetedStart).toBeGreaterThan(-1);
    expect(targetedEnd).toBeGreaterThan(targetedStart);
    expect(resumeStart).toBeGreaterThan(-1);
    expect(resumeEnd).toBeGreaterThan(resumeStart);
    expect(switchStart).toBeGreaterThan(-1);
    expect(switchEnd).toBeGreaterThan(switchStart);

    expect(source.slice(targetedStart, targetedEnd)).not.toContain("slot.runtime.resumeSession(threadId)");
    expect(source.slice(resumeStart, resumeEnd)).toContain(
      'if (activeSlot.adapter !== "codex" && !command.sessionAlreadyRestored)',
    );
    expect(source.slice(resumeStart, resumeEnd)).toContain("activeSlot.runtime.resumeSession(candidate.sessionId)");
    expect(source.slice(resumeStart, resumeEnd)).toContain("persistCodexWechatThreadId");
    expect(source.slice(switchStart, switchEnd)).not.toContain("slot.wechatReplyThreadId = event.threadId");
  });

  test("shows the selected adapter task list after a successful switch", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const switchStart = source.indexOf("    const switchAdapter = parseDaemonSwitchCommand(message.text);");
    const switchEnd = source.indexOf("\n    if (message.text.trim().toLowerCase() === \"/daemon-stop\")", switchStart);
    const switchBlock = source.slice(switchStart, switchEnd);

    expect(switchStart).toBeGreaterThan(-1);
    expect(switchEnd).toBeGreaterThan(switchStart);
    expect(switchBlock).toContain("if (result.activated)");
    expect(switchBlock).toContain("await retrySwitchedAdapterTaskList(");
    expect(switchBlock).toContain("() => this.handleSystemCommand(message, switchedSlot, {");
    expect(switchBlock).toContain('type: "resume"');
  });

  test("retries exact global task restore while the companion is still starting", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const activationStart = source.indexOf("  private async activateExactGlobalTask(");
    const activationEnd = source.indexOf(
      "\n  private async handleGlobalTaskTargetedMessage(",
      activationStart,
    );
    const activationBlock = source.slice(activationStart, activationEnd);

    expect(activationStart).toBeGreaterThan(-1);
    expect(activationEnd).toBeGreaterThan(activationStart);
    expect(activationBlock).toContain("await retrySwitchedAdapterTaskList(");
    expect(activationBlock).toContain(
      "() => connected.runtime.resumeSession(sessionId)",
    );
    expect(activationBlock).toContain("global_task_resume_retry:");
    expect(activationBlock).toContain("initialSharedSessionId: candidate.sessionId");
  });

  test("routes global task commands and number-colon messages through adapter plus session identity", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const inboundStart = source.indexOf("  private async handleInboundMessage(");
    const inboundEnd = source.indexOf("\n  private async handleDaemonTaskTargetedMessage(", inboundStart);
    const inboundBlock = source.slice(inboundStart, inboundEnd);
    const systemStart = source.indexOf("  private async handleSystemCommand(");
    const systemEnd = source.indexOf('      case "help":', systemStart);
    const systemBlock = source.slice(systemStart, systemEnd);

    expect(inboundBlock.indexOf("resolveGlobalTaskTargetedMessage")).toBeLessThan(
      inboundBlock.indexOf("resolveDaemonTaskTargetedMessage"),
    );
    expect(inboundBlock).toContain('this.activeTaskListScope === "global"');
    expect(inboundBlock).toContain("resolveDaemonTaskListScope");
    expect(inboundBlock).toContain("{ ...command, taskListScope }");
    expect(systemBlock).toContain('command.taskListScope === "global"');
    expect(systemBlock).toContain("await this.handleGlobalTaskCommand(message, command)");
  });

  test("keeps adapter switches scoped to that adapter while mobile task board uses the global catalog", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const switchStart = source.indexOf("    const switchAdapter = parseDaemonSwitchCommand(message.text);");
    const switchEnd = source.indexOf('\n    if (message.text.trim().toLowerCase() === "/daemon-stop")', switchStart);
    const switchBlock = source.slice(switchStart, switchEnd);
    const boardStart = source.indexOf("  private async listMobileTaskBoard()");
    const boardEnd = source.indexOf("\n  private async recordRecentTaskCompletion(", boardStart);
    const boardBlock = source.slice(boardStart, boardEnd);

    expect(switchBlock).toContain('taskListScope: "adapter"');
    expect(boardBlock).toContain("await this.listGlobalTaskCandidates()");
    expect(boardBlock).toContain("DAEMON_ADAPTERS.map");
    expect(boardBlock).not.toContain("Array.from(this.slots.values())");
  });

  test("does not restrict stable number-colon routing to Codex", () => {
    const source = readRepoFile("src/daemon/werelay-daemon.ts");
    const routeStart = source.indexOf("    const targetedTaskMessage =");
    const routeEnd = source.indexOf("\n    const taskListScope = resolveDaemonTaskListScope", routeStart);
    const routeBlock = source.slice(routeStart, routeEnd);

    expect(routeStart).toBeGreaterThan(-1);
    expect(routeEnd).toBeGreaterThan(routeStart);
    expect(routeBlock).toContain("slot.runtime.sendInputToSession");
    expect(routeBlock).toContain("resolveDaemonTaskTargetedMessage");
    expect(routeBlock).toContain("handleDaemonTaskTargetedMessage");
    expect(routeBlock).not.toContain('slot.adapter === "codex"');
  });

  test("never hides WeChat messages in a Bridge-owned Codex queue", () => {
    expect(
      shouldQueueCodexDaemonInbound({
        adapter: "codex",
        status: "busy",
        currentThreadId: "thread_a",
        hasActiveTask: false,
      }),
    ).toBe(false);
    expect(
      shouldQueueCodexDaemonInbound({
        adapter: "codex",
        status: "idle",
        currentThreadId: "thread_a",
        hasActiveTask: true,
      }),
    ).toBe(false);
    expect(
      shouldQueueCodexDaemonInbound({
        adapter: "opencode",
        status: "busy",
        currentThreadId: "session_a",
        hasActiveTask: true,
      }),
    ).toBe(false);
  });

  test("parseDaemonSwitchCommand recognizes terminal switch commands", () => {
    expect(parseDaemonSwitchCommand("/codex")).toBe("codex");
    expect(parseDaemonSwitchCommand("/claude")).toBe("claude");
    expect(parseDaemonSwitchCommand("/tclaude")).toBe("tclaude");
    expect(parseDaemonSwitchCommand("/grok")).toBe("grok");
    expect(parseDaemonSwitchCommand("/codebuddy")).toBe("codebuddy");
    expect(parseDaemonSwitchCommand("/reasonix")).toBe("reasonix");
    expect(parseDaemonSwitchCommand("/reasonix code")).toBe("reasonix");
    expect(parseDaemonSwitchCommand("/deepseek")).toBe("deepseek");
    expect(parseDaemonSwitchCommand("/dsh")).toBe("deepseek");
    expect(parseDaemonSwitchCommand("/workbuddy")).toBe("workbuddy");
    expect(parseDaemonSwitchCommand("/opencode")).toBe("opencode");
    expect(parseDaemonSwitchCommand("/grok cli")).toBe("grok");
    expect(parseDaemonSwitchCommand("/claude code")).toBe("claude");
    expect(parseDaemonSwitchCommand("/workbuddy desktop")).toBe("workbuddy");
    expect(parseDaemonSwitchCommand("/status")).toBeNull();
  });

  test("parseDaemonCliArgs binds daemon to cwd and optional initial adapter", () => {
    const options = parseDaemonCliArgs([
      "--cwd",
      "./tmp/project",
      "--adapter",
      "claude",
      "--profile",
      "work",
      "--no-open",
    ]);

    expect(options).toEqual({
      cwd: path.resolve("./tmp/project"),
      initialAdapter: "claude",
      profile: "work",
      openVisible: false,
      restorePersistedAdapter: true,
      allowDesktopApplicationLaunch: false,
    });
  });

  test("idle startup keeps the relay online without restoring the last terminal", () => {
    const options = parseDaemonCliArgs([
      "--cwd",
      "./tmp/project",
      "--idle-start",
      "--no-open",
    ]);

    expect(options).toMatchObject({
      restorePersistedAdapter: false,
      openVisible: false,
      allowDesktopApplicationLaunch: false,
    });
    expect(resolveDaemonInitialAdapter(options, "codex")).toBeUndefined();
  });

  test("explicit adapter wins over idle startup and desktop launch needs explicit opt-in", () => {
    const options = parseDaemonCliArgs([
      "--idle-start",
      "--adapter",
      "deepseek",
      "--open-desktop-apps",
    ]);

    expect(resolveDaemonInitialAdapter(options, "codex")).toBe("deepseek");
    expect(options.allowDesktopApplicationLaunch).toBe(true);
  });

  test("daemon runtime disables desktop application launch unless explicitly allowed", () => {
    expect(buildDaemonRuntimeOptions({
      adapter: "codex",
      cwd: "/Users/test/project",
    }).allowDesktopApplicationLaunch).toBe(false);
    expect(buildDaemonRuntimeOptions({
      adapter: "codex",
      cwd: "/Users/test/project",
      allowDesktopApplicationLaunch: true,
    }).allowDesktopApplicationLaunch).toBe(true);
  });

  test("allows desktop application launch for an explicit web or ClawBot action", () => {
    expect(resolveDaemonDesktopApplicationLaunchPermission({
      automaticLaunchEnabled: false,
      userInitiated: false,
    })).toBe(false);
    expect(resolveDaemonDesktopApplicationLaunchPermission({
      automaticLaunchEnabled: false,
      userInitiated: true,
    })).toBe(true);
    expect(resolveDaemonDesktopApplicationLaunchPermission({
      automaticLaunchEnabled: true,
      userInitiated: false,
    })).toBe(true);
  });

  test("recreates a failed desktop-owner slot only for an explicit user launch", () => {
    expect(shouldRecreateDesktopOwnerSlotForUserLaunch({
      isDesktopOwner: true,
      userInitiated: true,
      status: "error",
    })).toBe(true);
    expect(shouldRecreateDesktopOwnerSlotForUserLaunch({
      isDesktopOwner: true,
      userInitiated: true,
      status: "stopped",
    })).toBe(true);
    expect(shouldRecreateDesktopOwnerSlotForUserLaunch({
      isDesktopOwner: true,
      userInitiated: false,
      status: "error",
    })).toBe(false);
    expect(shouldRecreateDesktopOwnerSlotForUserLaunch({
      isDesktopOwner: true,
      userInitiated: true,
      status: "idle",
    })).toBe(false);
    expect(shouldRecreateDesktopOwnerSlotForUserLaunch({
      isDesktopOwner: false,
      userInitiated: true,
      status: "error",
    })).toBe(false);
  });

  test("macOS visible clients launch through a Terminal command file instead of AppleScript", () => {
    const launcherFile = "/tmp/Desk Relay/launcher's tclaude.command";
    const cwd = "/tmp/Project's Workspace";
    const script = buildMacVisibleClientLaunchScript({
      launcherFile,
      cwd,
      execPath: "/opt/homebrew/bin/node",
      args: ["--no-warnings", "/tmp/local companion.js", "--adapter", "tclaude"],
    });

    expect(buildMacVisibleClientOpenArgs(launcherFile)).toEqual([
      "-g",
      "-a",
      "Terminal",
      launcherFile,
    ]);
    expect(script).toStartWith("#!/bin/zsh\n");
    expect(script).toContain(String.raw`/bin/rm -f -- '/tmp/Desk Relay/launcher'\''s tclaude.command'`);
    expect(script).toContain(String.raw`cd '/tmp/Project'\''s Workspace' || exit 1`);
    expect(script).toContain(
      "exec '/opt/homebrew/bin/node' '--no-warnings' '/tmp/local companion.js' '--adapter' 'tclaude'",
    );
    expect(script).not.toContain("tell application");
    expect(script).not.toContain("osascript");
  });

  test("buildVisibleClientLaunchArgs routes codex through the remote client", () => {
    const args = buildVisibleClientLaunchArgs({
      adapter: "codex",
      cwd: path.resolve("./tmp/project"),
      cliArgs: ["--yolo"],
    });

    expect(args.some((arg) => arg.endsWith("codex-remote-client.ts"))).toBe(true);
    expect(args).toContain("--cwd");
    expect(args).toContain(path.resolve("./tmp/project"));
    expect(args).toContain("--yolo");
    expect(args).not.toContain("--adapter");
  });

  test("buildVisibleClientLaunchArgs routes shared-owner agents through local companion", () => {
    for (const adapter of ["grok", "opencode"] as const) {
      const args = buildVisibleClientLaunchArgs({
        adapter,
        cwd: path.resolve("./tmp/project"),
      });

      expect(args.some((arg) => arg.endsWith("local-companion.ts"))).toBe(true);
      expect(args).toContain("--adapter");
      expect(args).toContain(adapter);
    }
  });

  test("buildVisibleClientLaunchArgs can request a fresh local companion session", () => {
    for (const adapter of ["claude", "opencode"] as const) {
      const args = buildVisibleClientLaunchArgs({
        adapter,
        cwd: path.resolve("./tmp/project"),
        sessionStartMode: "new",
      });

      expect(args).toContain("--session-start-mode");
      expect(args).toContain("new");
    }
  });

  test("defaultDaemonSessionStartMode restores desktop and harness owners and starts CLI owners fresh", () => {
    expect(defaultDaemonSessionStartMode("codex")).toBe("restore");
    expect(defaultDaemonSessionStartMode("workbuddy")).toBe("restore");
    expect(defaultDaemonSessionStartMode("deepseek")).toBe("restore");
    expect(defaultDaemonSessionStartMode("claude")).toBe("new");
    expect(defaultDaemonSessionStartMode("tclaude")).toBe("new");
    expect(defaultDaemonSessionStartMode("grok")).toBe("new");
    expect(defaultDaemonSessionStartMode("codebuddy")).toBe("new");
    expect(defaultDaemonSessionStartMode("opencode")).toBe("new");
  });

  test("resolveDaemonSessionStartMode avoids restoring stale OpenCode sessions", () => {
    expect(
      resolveDaemonSessionStartMode({
        adapter: "opencode",
        slotCreated: true,
        visibleConnected: false,
      }),
    ).toBe("new");

    expect(
      resolveDaemonSessionStartMode({
        adapter: "opencode",
        slotCreated: false,
        visibleConnected: false,
      }),
    ).toBe("new");

    expect(
      resolveDaemonSessionStartMode({
        adapter: "opencode",
        slotCreated: false,
        visibleConnected: false,
        sharedSessionId: "session_current",
      }),
    ).toBe("restore");

    expect(
      resolveDaemonSessionStartMode({
        adapter: "opencode",
        slotCreated: false,
        visibleConnected: true,
        sharedSessionId: "session_current",
      }),
    ).toBe("restore");

    expect(
      resolveDaemonSessionStartMode({
        adapter: "opencode",
        explicitSessionStartMode: "new",
        slotCreated: false,
        visibleConnected: true,
        sharedSessionId: "session_current",
      }),
    ).toBe("new");

    expect(
      resolveDaemonSessionStartMode({
        adapter: "opencode",
        explicitSessionStartMode: "new",
        slotCreated: false,
        visibleConnected: true,
        sharedSessionId: "session_current",
        reuseExistingVisible: true,
      }),
    ).toBe("restore");

    expect(
      resolveDaemonSessionStartMode({
        adapter: "codex",
        slotCreated: true,
        visibleConnected: false,
      }),
    ).toBe("restore");
  });

  test("buildWindowsVisibleClientLaunchCommand opens a titled console window", () => {
    const command = buildWindowsVisibleClientLaunchCommand({
      adapter: "claude",
      cwd: "D:\\work",
      args: ["C:\\Program Files\\bridge\\local-companion.js", "--cwd", "D:\\work"],
    });

    expect(command).toContain("start");
    expect(command).toContain('"werelay-claude"');
    expect(command).toContain('/D "D:\\work"');
    expect(command).toContain('"C:\\Program Files\\bridge\\local-companion.js"');
  });

  test("labels Codex background replies without repeating the terminal prefix", () => {
    expect(
      prefixDaemonTaskMessage(
        "codex",
        "第一个任务已完成",
        3,
        "0000000a-0000-7000-8000-00000000000a",
        "示例任务",
      ),
    ).toBe("[示例任务]\n第一个任务已完成");
    expect(
      prefixDaemonTaskMessage(
        "codex",
        "需要审批",
        undefined,
        "0000000a-0000-7000-8000-00000000000a",
        "示例任务",
      ),
    ).toBe("[示例任务]\n需要审批");
  });

  test("formatDaemonStatus keeps mobile output concise", () => {
    const output = formatDaemonStatus({
      cwd: "D:/work/project",
      activeAdapter: "codex",
      startedAt: "2026-05-22T00:00:00.000Z",
      slots: [
        {
          adapter: "codex",
          status: "idle",
          cwd: "D:/work/project",
          companionPid: 456,
          pendingApproval: false,
          pendingUserInput: false,
        },
        {
          adapter: "claude",
          status: "awaiting_approval",
          cwd: "D:/work/project",
          pendingApproval: true,
          pendingUserInput: false,
        },
      ],
    });

    expect(output).toBe(
      "当前：Codex\nCodex：空闲\nClaude Code：待审批\nTClaude：未启动\nGrok CLI：未启动\nCodeBuddy：未启动\nreasonix：未启动\nWorkBuddy：未启动\nDeepSeek Harness：未启动\nOpenCode：未启动",
    );
    expect(output).not.toMatch(/cwd|started_at|pid|D:\/work/);
  });

  test("formatDaemonSwitchResultDetail reports concise visible client outcomes", () => {
    expect(
      formatDaemonSwitchResultDetail({
        created: true,
        openedVisible: true,
        visibleConnected: true,
      }),
    ).toBe("已启动并连接桌面端。");

    expect(
      formatDaemonSwitchResultDetail({
        created: false,
        openedVisible: false,
        visibleConnected: true,
      }),
    ).toBe("已连接现有桌面端。");

    expect(
      formatDaemonSwitchResultDetail({
        created: true,
        openedVisible: true,
        visibleConnected: false,
        activated: false,
        previousActiveAdapter: "claude",
      }),
    ).toBe("桌面端尚未连接，仍使用 Claude Code。");
  });

  test("waitForVisibleClientConnection resolves when the visible companion appears", async () => {
    let now = 0;
    let checks = 0;

    const connected = await waitForVisibleClientConnection(
      {
        cwd: "D:\\work\\project",
        adapter: "opencode",
        timeoutMs: 1_000,
        pollMs: 250,
      },
      {
        isAlive: () => {
          checks += 1;
          return checks >= 3;
        },
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      },
    );

    expect(connected).toBe(true);
    expect(checks).toBe(3);
  });

  test("waitForVisibleClientConnection returns false on timeout", async () => {
    let now = 0;

    const connected = await waitForVisibleClientConnection(
      {
        cwd: "D:\\work\\project",
        adapter: "claude",
        timeoutMs: 500,
        pollMs: 250,
      },
      {
        isAlive: () => false,
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      },
    );

    expect(connected).toBe(false);
    expect(now).toBe(500);
  });

  test("retries switched adapter task lists while the companion is still starting", async () => {
    let now = 0;
    let attempts = 0;
    const delays: number[] = [];

    await retrySwitchedAdapterTaskList(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(
            "grok companion is connected but not ready yet. Wait for it to finish starting.",
          );
        }
      },
      {
        timeoutMs: 1_000,
        pollMs: 250,
        sleep: async (ms) => {
          delays.push(ms);
          now += ms;
        },
        now: () => now,
      },
    );

    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 250]);
    expect(now).toBe(500);
  });

  test("does not retry switched adapter task lists for non-transient errors", async () => {
    let attempts = 0;

    await expect(
      retrySwitchedAdapterTaskList(
        async () => {
          attempts += 1;
          throw new Error("unexpected decoder failure");
        },
        {
          timeoutMs: 1_000,
          pollMs: 250,
          sleep: async () => {
            throw new Error("must not sleep");
          },
          now: () => 0,
        },
      ),
    ).rejects.toThrow("unexpected decoder failure");
    expect(attempts).toBe(1);
  });

  test("stops retrying switched adapter task lists after the ready timeout", async () => {
    let now = 0;
    let attempts = 0;

    await expect(
      retrySwitchedAdapterTaskList(
        async () => {
          attempts += 1;
          throw new Error(
            "grok companion is connected but not ready yet. Wait for it to finish starting.",
          );
        },
        {
          timeoutMs: 500,
          pollMs: 250,
          sleep: async (ms) => {
            now += ms;
          },
          now: () => now,
        },
      ),
    ).rejects.toThrow("grok companion is connected but not ready yet");
    expect(attempts).toBe(3);
    expect(now).toBe(500);
  });

  test("reads switched adapter task lists immediately when the companion is ready", async () => {
    let attempts = 0;

    await retrySwitchedAdapterTaskList(
      async () => {
        attempts += 1;
      },
      {
        sleep: async () => {
          throw new Error("must not sleep");
        },
      },
    );

    expect(attempts).toBe(1);
  });

  test("cleanupDaemonBeforeStart returns none when no daemon endpoint exists", async () => {
    await expect(
      cleanupDaemonBeforeStart({
        readEndpoint: () => null,
        listDaemonProcesses: () => [],
      }),
    ).resolves.toEqual({ action: "none" });
  });

  test("cleanupDaemonBeforeStart stops same-cwd daemon peers when no endpoint exists", async () => {
    const killed: number[] = [];
    const alive = new Set([100, 101]);

    const result = await cleanupDaemonBeforeStart({
      cwd: "C:\\Users\\example",
      readEndpoint: () => null,
      listDaemonProcesses: (cwd) => {
        expect(cwd).toBe("C:\\Users\\example");
        return [
          {
            pid: 100,
            parentPid: 50,
            commandLine:
              '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\werelay\\bin\\werelay-daemon.mjs --cwd C:\\Users\\example',
          },
          {
            pid: 101,
            parentPid: 100,
            commandLine:
              '"C:\\Program Files\\nodejs\\node.exe" C:\\repo\\dist\\daemon\\werelay-daemon.js --cwd C:\\Users\\example',
          },
        ];
      },
      killProcess: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      isAlive: (pid) => alive.has(pid),
      sleep: async () => undefined,
      log: () => undefined,
      daemonLog: () => undefined,
      forceStopTimeoutMs: 1,
      pollMs: 1,
    });

    expect(result).toEqual({ action: "none" });
    expect(killed).toEqual([101]);
  });

  test("cleanupDaemonBeforeStart clears stale daemon endpoint and workspace endpoints", async () => {
    const endpoint = buildDaemonEndpoint();
    const cleared: string[] = [];

    const result = await cleanupDaemonBeforeStart({
      readEndpoint: () => endpoint,
      isAlive: () => false,
      clearEndpoint: (pid) => {
        cleared.push(`endpoint:${pid ?? 0}`);
      },
      clearWorkspaceEndpoints: (payload) => {
        cleared.push(`workspace:${payload.cwd}`);
      },
      listDaemonProcesses: () => [],
      log: () => undefined,
      daemonLog: () => undefined,
    });

    expect(result).toEqual({ action: "cleared_stale_endpoint", endpoint });
    expect(cleared).toEqual(["workspace:C:\\Users\\example", "endpoint:28600"]);
  });

  test("cleanupDaemonBeforeStart gracefully stops a live daemon before startup", async () => {
    const endpoint = buildDaemonEndpoint();
    let alive = true;
    const requests: DaemonRequest[] = [];
    const cleared: string[] = [];

    const result = await cleanupDaemonBeforeStart({
      readEndpoint: () => endpoint,
      isAlive: () => alive,
      sendRequest: async (_endpoint, request) => {
        requests.push(request);
        alive = false;
        return { ok: true };
      },
      clearEndpoint: (pid) => {
        cleared.push(`endpoint:${pid ?? 0}`);
      },
      clearWorkspaceEndpoints: (payload) => {
        cleared.push(`workspace:${payload.cwd}`);
      },
      listDaemonProcesses: () => [],
      sleep: async () => undefined,
      log: () => undefined,
      daemonLog: () => undefined,
    });

    expect(result).toEqual({ action: "stopped", endpoint, forced: false });
    expect(requests).toEqual([{ command: "shutdown" }]);
    expect(cleared).toEqual(["workspace:C:\\Users\\example", "endpoint:28600"]);
  });

  test("cleanupDaemonBeforeStart force-stops daemon endpoints that do not answer IPC", async () => {
    const endpoint = buildDaemonEndpoint();
    let alive = true;
    const killed: number[] = [];

    const result = await cleanupDaemonBeforeStart({
      readEndpoint: () => endpoint,
      isAlive: () => alive,
      sendRequest: async () => ({ ok: false, error: "Timed out waiting for daemon response." }),
      isDaemonProcess: () => true,
      killProcess: (pid) => {
        killed.push(pid);
        alive = false;
      },
      clearEndpoint: () => undefined,
      clearWorkspaceEndpoints: () => undefined,
      listDaemonProcesses: () => [],
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      log: () => undefined,
      daemonLog: () => undefined,
      stopTimeoutMs: 1,
      forceStopTimeoutMs: 1,
      pollMs: 1,
    });

    expect(result).toEqual({ action: "stopped", endpoint, forced: true });
    expect(killed).toEqual([28600]);
  });

  test("cleanupDaemonBeforeStart does not force-stop unverified reused pids", async () => {
    const endpoint = buildDaemonEndpoint();
    const killed: number[] = [];
    const cleared: string[] = [];

    const result = await cleanupDaemonBeforeStart({
      readEndpoint: () => endpoint,
      isAlive: () => true,
      sendRequest: async () => ({ ok: false, error: "Daemon endpoint is not reachable." }),
      isDaemonProcess: () => false,
      killProcess: (pid) => {
        killed.push(pid);
      },
      clearEndpoint: (pid) => {
        cleared.push(`endpoint:${pid ?? 0}`);
      },
      clearWorkspaceEndpoints: (payload) => {
        cleared.push(`workspace:${payload.cwd}`);
      },
      listDaemonProcesses: () => [],
      sleep: async () => undefined,
      log: () => undefined,
      daemonLog: () => undefined,
      stopTimeoutMs: 1,
      pollMs: 1,
    });

    expect(result).toEqual({ action: "cleared_stale_endpoint", endpoint });
    expect(killed).toEqual([]);
    expect(cleared).toEqual(["workspace:C:\\Users\\example", "endpoint:28600"]);
  });

  test("cleanupSingleBridgeBeforeDaemon returns none when no lock exists", async () => {
    await expect(
      cleanupSingleBridgeBeforeDaemon({
        readLock: () => null,
      }),
    ).resolves.toEqual({ action: "none" });
  });

  test("cleanupSingleBridgeBeforeDaemon clears stale locks and endpoints", async () => {
    const lock = buildBridgeLock();
    const cleared: string[] = [];

    const result = await cleanupSingleBridgeBeforeDaemon({
      readLock: () => lock,
      isAlive: () => false,
      clearEndpoint: (payload) => {
        cleared.push(`endpoint:${payload.adapter}:${payload.cwd}`);
      },
      clearLock: (payload) => {
        cleared.push(`lock:${payload.pid}`);
      },
      log: () => undefined,
      daemonLog: () => undefined,
    });

    expect(result).toEqual({ action: "cleared_stale_lock", lock });
    expect(cleared).toEqual([
      "endpoint:codex:C:\\Users\\example",
      "lock:28544",
    ]);
  });

  test("cleanupSingleBridgeBeforeDaemon stops a live single bridge before daemon startup", async () => {
    const lock = buildBridgeLock({ adapter: "opencode" });
    let alive = true;
    const signals: string[] = [];
    const cleared: string[] = [];

    const result = await cleanupSingleBridgeBeforeDaemon({
      readLock: () => lock,
      isAlive: () => alive,
      killProcess: (_pid, signal) => {
        signals.push(signal);
        alive = false;
      },
      clearEndpoint: (payload) => {
        cleared.push(`endpoint:${payload.adapter}`);
      },
      clearLock: (payload) => {
        cleared.push(`lock:${payload.pid}`);
      },
      sleep: async () => undefined,
      log: () => undefined,
      daemonLog: () => undefined,
    });

    expect(result).toEqual({ action: "stopped", lock, forced: false });
    expect(signals).toEqual(["SIGTERM"]);
    expect(cleared).toEqual(["endpoint:opencode", "lock:28544"]);
  });

  test("cleanupSingleBridgeBeforeDaemon force-stops bridges that ignore SIGTERM", async () => {
    const lock = buildBridgeLock();
    let alive = true;
    const signals: string[] = [];
    let pollCount = 0;

    const result = await cleanupSingleBridgeBeforeDaemon({
      readLock: () => lock,
      isAlive: () => {
        pollCount += 1;
        return alive;
      },
      killProcess: (_pid, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          alive = false;
        }
      },
      clearEndpoint: () => undefined,
      clearLock: () => undefined,
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      log: () => undefined,
      daemonLog: () => undefined,
      stopTimeoutMs: 1,
      forceStopTimeoutMs: 1,
      pollMs: 1,
    });

    expect(result).toEqual({ action: "stopped", lock, forced: true });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(pollCount).toBeGreaterThan(1);
  });

  test("package exposes the daemon binary and npm script", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const mainBinSource = readRepoFile("bin/werelay.mjs");
    const binSource = readRepoFile("bin/werelay-daemon.mjs");
    const reasonixBinSource = readRepoFile("bin/werelay-bridge-reasonix.mjs");

    expect(packageJson.bin?.werelay).toBe("bin/werelay.mjs");
    expect(mainBinSource).toContain('runJsEntry("dist/daemon/werelay-daemon.js")');
    expect(packageJson.bin?.["werelay-daemon"]).toBe("bin/werelay-daemon.mjs");
    expect(packageJson.scripts?.daemon).toContain("src/daemon/werelay-daemon.ts");
    expect(binSource).toContain('runJsEntry("dist/daemon/werelay-daemon.js")');
    expect(packageJson.bin?.["werelay-bridge-reasonix"]).toBe("bin/werelay-bridge-reasonix.mjs");
    expect(packageJson.scripts?.["bridge:reasonix"]).toContain("--adapter reasonix");
    expect(reasonixBinSource).toContain('["--adapter", "reasonix"]');
  });
});

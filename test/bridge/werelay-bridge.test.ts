import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  canDrainDeferredCodexInboundQueue,
  formatBridgeNoticeForWechat,
  formatCodexTaskAcceptedMessage,
  formatCodexTaskDuplicateMessage,
  formatCodexTaskQueuedMessage,
  formatDeferredCodexInboundQueueMessage,
  formatWechatContextTokenStaleLogEntry,
  formatUserFacingInboundError,
  formatWechatSendFailureLogEntry,
  isRetryableDeferredCodexDrainError,
  isRetryableWechatSendError,
  formatUserFacingBridgeFatalError,
  parseCliArgs,
  shouldDeferCodexInboundMessage,
  shouldForwardBridgeEventToWechat,
  shouldWatchParentProcess,
  startParentProcessWatcher,
} from "../../src/bridge/werelay-bridge.ts";
import { WechatApiResponseError } from "../../src/wechat/wechat-transport.ts";

describe("werelay-bridge cli helpers", () => {
  test("parseCliArgs keeps persistent lifecycle by default", () => {
    const options = parseCliArgs(["--adapter", "codex"]);

    expect(options.lifecycle).toBe("persistent");
    expect(options.sessionStartMode).toBe("restore");
  });

  test("parseCliArgs accepts --lifecycle companion_bound", () => {
    const options = parseCliArgs([
      "--adapter",
      "codex",
      "--lifecycle",
      "companion_bound",
    ]);

    expect(options.lifecycle).toBe("companion_bound");
  });

  test("parseCliArgs accepts internal new session startup mode", () => {
    const options = parseCliArgs([
      "--adapter",
      "claude",
      "--session-start-mode",
      "new",
    ]);

    expect(options.sessionStartMode).toBe("new");
  });

  test("shouldWatchParentProcess watches attached terminal bridges", () => {
    expect(
      shouldWatchParentProcess({
        startupParentPid: 123,
        attachedToTerminal: true,
        lifecycle: "persistent",
      }),
    ).toBe(true);
  });

  test("shouldWatchParentProcess watches detached companion-bound bridges", () => {
    expect(
      shouldWatchParentProcess({
        startupParentPid: 123,
        attachedToTerminal: false,
        lifecycle: "companion_bound",
      }),
    ).toBe(true);
  });

  test("shouldWatchParentProcess ignores detached persistent bridges", () => {
    expect(
      shouldWatchParentProcess({
        startupParentPid: 123,
        attachedToTerminal: false,
        lifecycle: "persistent",
      }),
    ).toBe(false);
  });

  test("parent watcher requests process shutdown when a companion-bound parent exits", async () => {
    let shutdownRequested = false;
    const messages: string[] = [];
    const timer = startParentProcessWatcher({
      startupParentPid: 123,
      attachedToTerminal: false,
      lifecycle: "companion_bound",
      pollMs: 1,
      isParentAlive: () => false,
      isShutdownRequested: () => shutdownRequested,
      requestShutdown: (message) => {
        shutdownRequested = true;
        messages.push(message);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    if (timer) {
      clearInterval(timer);
    }

    expect(messages).toEqual(["Parent process 123 exited. Stopping bridge."]);
  });

  test("formatUserFacingBridgeFatalError trims verbose app-server log details", () => {
    expect(
      formatUserFacingBridgeFatalError(
        "codex app-server websocket closed unexpectedly. Recent app-server log: codex app-server (WebSockets) listening on: ws://127.0.0.1:12345 readyz: http://127.0.0.1:12345/readyz",
      ),
    ).toBe("桥接错误：Codex 连接已断开，请稍后重试。");
  });

  test("formats worker exits as concise Chinese instructions", () => {
    expect(
      formatUserFacingBridgeFatalError(
        "tclaude worker exited unexpectedly with code 0.",
      ),
    ).toBe("TClaude 已关闭。\n发送“/tclaude”可重新打开。");
    expect(
      formatUserFacingBridgeFatalError(
        "tclaude worker exited unexpectedly with code 1.",
      ),
    ).toBe(
      "TClaude 运行异常结束（错误代码 1）。\n发送“/tclaude”可重新打开；如果再次出现，请在电脑端查看。",
    );
  });

  test("formatWechatSendFailureLogEntry includes the failed context and recipient", () => {
    expect(
      formatWechatSendFailureLogEntry({
        context: "thread_switched",
        recipientId: "owner@im.wechat",
        error: new Error("HTTP 503: upstream unavailable"),
      }),
    ).toBe(
      "wechat_send_failed: context=thread_switched recipient=owner@im.wechat error=Error: HTTP 503: upstream unavailable",
    );
  });

  test("formats stale WeChat context token failures separately", () => {
    expect(
      formatWechatContextTokenStaleLogEntry({
        context: "final_reply",
        recipientId: "owner@im.wechat",
        error: new WechatApiResponseError({
          endpoint: "sendmessage",
          ret: -2,
        }),
      }),
    ).toBe(
      "wechat_send_prepare_rejected: context=final_reply recipient=owner@im.wechat action=bounded_retry token_status=unproven error=WechatApiResponseError: sendmessage failed: ret=-2 errcode=undefined errmsg=",
    );
  });

  test("does not retry stale WeChat context token send failures", () => {
    expect(
      isRetryableWechatSendError(
        new WechatApiResponseError({
          endpoint: "sendmessage",
          ret: -2,
        }),
      ),
    ).toBe(false);

    expect(isRetryableWechatSendError(new Error("HTTP 503: upstream unavailable"))).toBe(true);
    expect(
      isRetryableWechatSendError(
        new WechatApiResponseError({
          endpoint: "sendmessage",
          ret: 1,
          errcode: 45009,
          errmsg: "rate limited",
        }),
      ),
    ).toBe(true);
  });

  test("formats opencode companion disconnects as a cleaner user-facing message", () => {
    expect(
      formatUserFacingInboundError({
        adapter: "opencode",
        cwd: "C:\\Users\\example",
        errorText:
          'opencode companion is not connected. Run "werelay-opencode" in a second terminal for this directory.',
        isUserFacingShellRejection: false,
      }),

    ).toBe("OpenCode 桌面端未连接，请在电脑上重新打开 OpenCode。");
  });

  test("keeps generic inbound bridge errors for other adapters", () => {
    expect(
      formatUserFacingInboundError({
        adapter: "codex",
        errorText: "codex app-server websocket closed unexpectedly.",
        isUserFacingShellRejection: false,
      }),
    ).toBe("桥接错误：Codex 连接已断开，请稍后重试。");
  });

  test("suppresses noisy OpenCode bridge events from WeChat replies", () => {
    expect(shouldForwardBridgeEventToWechat("opencode", "stdout")).toBe(false);
    expect(shouldForwardBridgeEventToWechat("opencode", "stderr")).toBe(false);
    expect(shouldForwardBridgeEventToWechat("opencode", "notice")).toBe(false);
    expect(
      shouldForwardBridgeEventToWechat("opencode", "notice", {
        text: "OpenCode is still working on:\nReview the bridge",
      }),
    ).toBe(false);
    expect(
      shouldForwardBridgeEventToWechat("opencode", "notice", {
        text: "OpenCode local draft:\nReview the bridge",
      }),
    ).toBe(true);
    expect(shouldForwardBridgeEventToWechat("opencode", "mirrored_user_input")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("opencode", "session_switched")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("opencode", "thread_switched")).toBe(false);
    expect(shouldForwardBridgeEventToWechat("opencode", "final_reply")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("opencode", "approval_required")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("opencode", "fatal_error")).toBe(true);
  });

  test("suppresses raw CLI output while preserving structured events", () => {
    expect(shouldForwardBridgeEventToWechat("codex", "stdout")).toBe(false);
    expect(shouldForwardBridgeEventToWechat("claude", "stderr")).toBe(false);
    expect(shouldForwardBridgeEventToWechat("claude", "notice")).toBe(true);
    expect(shouldForwardBridgeEventToWechat("shell", "stderr")).toBe(true);
    expect(
      shouldForwardBridgeEventToWechat("claude", "notice", {
        text: "Claude is still working on:\nReview the bridge",
      }),
    ).toBe(false);
  });

  test("compacts bridge notices before sending them to mobile WeChat", () => {
    expect(
      formatBridgeNoticeForWechat("OpenCode local draft:\nReview the bridge"),
    ).toBe("桌面端草稿：\nReview the bridge");
    expect(
      formatBridgeNoticeForWechat(
        'Conversation transcript "/Users/test/very-long-path.jsonl" no longer exists.',
      ),
    ).toBe("历史会话已失效，已新建会话。");
  });

  test("does not hide ordinary Codex input in a Bridge-owned queue", () => {
    expect(
      shouldDeferCodexInboundMessage({
        adapter: "codex",
        status: "busy",
        hasPendingConfirmation: false,
        hasSystemCommand: false,
      }),
    ).toBe(false);
  });

  test("does not defer Codex control commands", () => {
    expect(
      shouldDeferCodexInboundMessage({
        adapter: "codex",
        status: "busy",
        hasPendingConfirmation: false,
        hasSystemCommand: true,
      }),
    ).toBe(false);
  });

  test("does not defer non-Codex adapters", () => {
    expect(
      shouldDeferCodexInboundMessage({
        adapter: "opencode",
        status: "busy",
        hasPendingConfirmation: false,
        hasSystemCommand: false,
      }),
    ).toBe(false);
  });

  test("only drains the deferred Codex queue when the bridge is truly idle", () => {
    expect(
      canDrainDeferredCodexInboundQueue({
        adapter: "codex",
        deferredCount: 1,
        status: "idle",
        activeTurnId: undefined,
        hasPendingConfirmation: false,
        hasPendingUserInput: false,
        hasPendingApproval: false,
        hasActiveTask: false,
      }),
    ).toBe(true);

    expect(
      canDrainDeferredCodexInboundQueue({
        adapter: "codex",
        deferredCount: 1,
        status: "busy",
        activeTurnId: undefined,
        hasPendingConfirmation: false,
        hasPendingUserInput: false,
        hasPendingApproval: false,
        hasActiveTask: false,
      }),
    ).toBe(false);

    expect(
      canDrainDeferredCodexInboundQueue({
        adapter: "codex",
        deferredCount: 1,
        status: "idle",
        activeTurnId: "turn-123",
        hasPendingConfirmation: false,
        hasPendingUserInput: false,
        hasPendingApproval: false,
        hasActiveTask: false,
      }),
    ).toBe(false);

    expect(
      canDrainDeferredCodexInboundQueue({
        adapter: "codex",
        deferredCount: 1,
        status: "idle",
        activeTurnId: undefined,
        hasPendingConfirmation: false,
        hasPendingUserInput: false,
        hasPendingApproval: false,
        hasActiveTask: true,
      }),
    ).toBe(false);

    expect(
      canDrainDeferredCodexInboundQueue({
        adapter: "codex",
        deferredCount: 1,
        status: "awaiting_input",
        activeTurnId: undefined,
        hasPendingConfirmation: false,
        hasPendingUserInput: true,
        hasPendingApproval: false,
        hasActiveTask: false,
      }),
    ).toBe(false);
  });

  test("does not interrupt Codex before switching desktop tasks", () => {
    const source = [
      fs.readFileSync(path.resolve(process.cwd(), "src/bridge/werelay-bridge.ts"), "utf8"),
      fs.readFileSync(path.resolve(process.cwd(), "src/daemon/werelay-daemon.ts"), "utf8"),
    ].join("\n");

    expect(source).not.toContain("当前 Codex 任务仍在运行，正在停止并切换");
    expect(source).not.toContain("interruptCodexTaskBeforeSwitch");
  });

  test("keeps one immediate receipt without periodic Codex heartbeat promises", () => {
    expect(formatCodexTaskAcceptedMessage()).toBe(
      "已发送，Codex 正在处理。\n\n完成后会在微信通知你；任务较久时，可打开下方网页版查看实时进展。",
    );
  });

  test("formats duplicate Codex input receipts without starting another task", () => {
    expect(formatCodexTaskDuplicateMessage()).toBe(
      "与最近一条消息相同，未重复发送。",
    );
  });

  test("formats native Codex queue receipts for WeChat", () => {
    expect(formatCodexTaskQueuedMessage(2)).toBe(
      "已加入待发送（第 2 条）。\n可在网页版或 Codex 中引导、编辑或删除。",
    );
    expect(formatCodexTaskQueuedMessage()).toBe(
      "已加入待发送。\n可在网页版或 Codex 中引导、编辑或删除。",
    );
  });

  test("removes periodic Codex heartbeat code from bridge and daemon loops", () => {
    const source = [
      fs.readFileSync(path.resolve(process.cwd(), "src/bridge/werelay-bridge.ts"), "utf8"),
      fs.readFileSync(path.resolve(process.cwd(), "src/daemon/werelay-daemon.ts"), "utf8"),
    ].join("\n");

    expect(source).not.toContain("CODEX_PROGRESS_HEARTBEAT_INTERVAL_MS");
    expect(source).not.toContain("formatCodexTaskProgressMessage");
  });

  test("formats the deferred Codex queue confirmation for WeChat", () => {
    expect(formatDeferredCodexInboundQueueMessage(1)).toBe(
      "消息已排队；当前任务结束后自动发送。",
    );
    expect(formatDeferredCodexInboundQueueMessage(3)).toBe(
      "消息已排队，前面还有 2 条；当前任务结束后自动发送。",
    );
  });

  test("retries deferred Codex drain failures only for transient local-busy conditions", () => {
    expect(
      isRetryableDeferredCodexDrainError(
        "The local Codex panel is still working. Wait for the current reply or use /stop.",
      ),
    ).toBe(true);
    expect(
      isRetryableDeferredCodexDrainError(
        "Codex 有操作等待确认，请回复“同意”继续，或回复“拒绝”取消。",
      ),
    ).toBe(true);
    expect(
      isRetryableDeferredCodexDrainError("这个任务正在等待你的补充输入。"),
    ).toBe(true);
    expect(
      isRetryableDeferredCodexDrainError("Codex 桌面端连接已断开，正在重连。"),
    ).toBe(true);
    expect(
      isRetryableDeferredCodexDrainError("无法连接 Codex 桌面端。"),
    ).toBe(true);
    expect(isRetryableDeferredCodexDrainError("codex panel is not running.")).toBe(false);
  });
});

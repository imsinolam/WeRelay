import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import type {
  BridgeAdapterState,
  BridgeState,
} from "../../src/bridge/bridge-types.ts";
import {
  buildWechatAttachmentPromptPrefix,
  buildWechatInboundPrompt,
  buildOneTimeCode,
  containsWechatOutboundAttachmentPath,
  shouldInjectWechatAttachmentPrompt,
  detectCliApproval,
  formatApprovalMessage,
  formatFinalReplyMessage,
  formatMirroredUserInputMessage,
  formatPendingApprovalReminder,
  formatPendingUserInputReminder,
  formatCodexDesktopTaskLatestMessage,
  formatCodexDesktopTaskSelection,
  formatCodexWechatHelp,
  formatResumeSessionList,
  formatResumeSessionSearchResults,
  formatResumeThreadList,
  formatStatusReport,
  formatTaskInterruptedMessage,
  formatTaskFailedMessage,
  formatThreadSwitchMessage,
  formatUserInputRequestMessage,
  getInteractiveShellCommandRejectionMessage,
  isWechatOutboundAttachmentMutationTool,
  isWechatOutboundAttachmentWriteCommand,
  isHighRiskShellCommand,
  MESSAGE_START_GRACE_MS,
  OutputBatcher,
  parseCodexSessionAgentMessage,
  parseWechatFinalReply,
  parseSystemCommand,
  resolveResumeSessionCandidate,
  resolveCompactCodexTaskSearchTarget,
  searchResumeSessionCandidates,
  sanitizeWechatInboundPromptForDisplay,
  resolveBareCodexTaskSelection,
  parseWechatControlCommand,
  resolveCodexTaskListPageNavigation,
  shouldDropStartupBacklogMessage,
  shouldNotifyTaskInterrupted,
  splitWechatTextIntoChunks,
  WECHAT_TEXT_CHUNK_MAX_CHARS,
} from "../../src/bridge/bridge-utils.ts";

describe("splitWechatTextIntoChunks", () => {
  test("keeps short text as a single chunk", () => {
    expect(splitWechatTextIntoChunks("hello")).toEqual(["hello"]);
    expect(splitWechatTextIntoChunks("   ")).toEqual([]);
  });

  test("splits long text into bounded chunks preferring newline boundaries", () => {
    const paragraph = "段落内容".repeat(80); // 320 chars
    const text = Array.from({ length: 8 }, () => paragraph).join("\n");
    const chunks = splitWechatTextIntoChunks(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(WECHAT_TEXT_CHUNK_MAX_CHARS);
    }
    expect(chunks.join("\n")).toBe(text);
  });

  test("hard-splits text without newlines", () => {
    const text = "x".repeat(WECHAT_TEXT_CHUNK_MAX_CHARS * 2 + 100);
    const chunks = splitWechatTextIntoChunks(text);
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe(text);
  });
});

describe("parseSystemCommand", () => {
  test("parses supported control commands", () => {
    expect(parseSystemCommand("/status")).toEqual({ type: "status" });
    expect(parseSystemCommand("/full")).toEqual({
      type: "codex_reply_mode",
      mode: "full",
    });
    expect(parseSystemCommand("/全文")).toEqual({
      type: "codex_reply_mode",
      mode: "full",
    });
    expect(parseSystemCommand("/brief")).toEqual({
      type: "codex_reply_mode",
      mode: "preview",
    });
    expect(parseSystemCommand("/预览")).toEqual({
      type: "codex_reply_mode",
      mode: "preview",
    });
    expect(parseSystemCommand("/next")).toEqual({
      type: "resume_page",
      direction: "next",
    });
    expect(parseSystemCommand("/next 20")).toEqual({
      type: "resume_page",
      direction: "next",
      count: 20,
    });
    expect(parseSystemCommand("/next30")).toEqual({
      type: "resume_page",
      direction: "next",
      count: 30,
    });
    expect(parseSystemCommand("/prev")).toEqual({
      type: "resume_page",
      direction: "prev",
    });
    expect(parseSystemCommand("/resume")).toEqual({ type: "resume" });
    expect(parseSystemCommand("/resume 2")).toEqual({ type: "resume", target: "2" });
    expect(parseSystemCommand("/tasks")).toEqual({ type: "resume" });
    expect(parseSystemCommand("/tasks 2")).toEqual({ type: "resume", page: 2 });
    expect(parseSystemCommand("/task 3")).toEqual({ type: "resume", target: "3" });
    expect(parseSystemCommand("/t3")).toEqual({ type: "resume", target: "3" });
    expect(parseSystemCommand("/T12")).toEqual({ type: "resume", target: "12" });
    expect(parseSystemCommand("/threads")).toEqual({ type: "resume" });
    expect(parseSystemCommand("/threads 3")).toEqual({ type: "resume", page: 3 });
    expect(parseSystemCommand("/thread aaaaaaaa")).toEqual({
      type: "resume",
      target: "aaaaaaaa",
    });
    expect(parseSystemCommand("/new")).toEqual({ type: "new_session" });
    expect(parseSystemCommand("/new-session")).toEqual({ type: "new_session" });
    expect(parseSystemCommand("新建")).toEqual({ type: "new_session" });
    expect(parseSystemCommand("新建任务")).toEqual({ type: "new_session" });
    expect(parseSystemCommand("新建会话")).toEqual({ type: "new_session" });
    expect(parseSystemCommand("新建：修复登录问题")).toEqual({
      type: "new_session",
      input: "修复登录问题",
    });
    expect(parseSystemCommand("新建任务 :  修复登录问题")).toEqual({
      type: "new_session",
      input: "修复登录问题",
    });
    expect(parseSystemCommand("新建会话:修复登录问题")).toEqual({
      type: "new_session",
      input: "修复登录问题",
    });
    expect(parseSystemCommand("/new 修复登录问题")).toEqual({
      type: "new_session",
      input: "修复登录问题",
    });
    expect(parseSystemCommand("/reset")).toEqual({ type: "reset" });
    expect(parseSystemCommand("/stop")).toEqual({ type: "stop" });
    expect(parseSystemCommand("/confirm 123456")).toEqual({
      type: "confirm",
    });
    expect(parseSystemCommand("/deny")).toEqual({ type: "deny" });
  });

  test("returns null for unsupported input", () => {
    expect(parseSystemCommand("hello")).toBeNull();
    expect(parseSystemCommand("/unknown foo")).toBeNull();
    expect(parseSystemCommand("/t0")).toBeNull();
    expect(parseSystemCommand("/t3 extra")).toBeNull();
    expect(parseSystemCommand("/tasks 101")).toBeNull();
  });
});

describe("resolveBareCodexTaskSelection", () => {
  test("accepts only an exact positive integer immediately after a Codex task list", () => {
    const base = {
      adapter: "codex" as const,
      awaitingSelection: true,
      hasPendingConfirmation: false,
      hasPendingUserInput: false,
    };

    expect(resolveBareCodexTaskSelection({ ...base, text: "3" })).toBe("3");
    expect(resolveBareCodexTaskSelection({ ...base, text: " 16 " })).toBe("16");
    expect(resolveBareCodexTaskSelection({ ...base, text: "3a" })).toBeNull();
    expect(resolveBareCodexTaskSelection({ ...base, text: "/t3" })).toBeNull();
    expect(resolveBareCodexTaskSelection({ ...base, text: "0" })).toBeNull();
  });

  test("suspends bare task-list numbers while approval or input prompts are pending", () => {
    expect(
      resolveBareCodexTaskSelection({
        adapter: "codex",
        text: "3",
        awaitingSelection: false,
        hasPendingConfirmation: false,
        hasPendingUserInput: false,
      }),
    ).toBeNull();
    expect(
      resolveBareCodexTaskSelection({
        adapter: "codex",
        text: "2",
        awaitingSelection: true,
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
      }),
    ).toBeNull();
    expect(
      resolveBareCodexTaskSelection({
        adapter: "codex",
        text: "3",
        awaitingSelection: true,
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
      }),
    ).toBeNull();
    expect(
      resolveBareCodexTaskSelection({
        adapter: "codex",
        text: "3",
        awaitingSelection: true,
        hasPendingConfirmation: false,
        hasPendingUserInput: true,
      }),
    ).toBeNull();
  });
});

describe("parseWechatControlCommand", () => {
  test("passes native slash commands through to command-capable agents", () => {
    const options = {
      adapter: "claude" as const,
      hasPendingConfirmation: false,
      hasPendingUserInput: false,
    };

    expect(parseWechatControlCommand("/help", options)).toBeNull();
    expect(parseWechatControlCommand("/status", options)).toBeNull();
    expect(parseWechatControlCommand("/reset", options)).toBeNull();
    expect(parseWechatControlCommand("/model claude-sonnet-4-6", options)).toBeNull();

    expect(parseWechatControlCommand("/stop", options)).toEqual({ type: "stop" });
    expect(parseWechatControlCommand("/tasks", options)).toEqual({ type: "resume" });
    expect(parseWechatControlCommand("/confirm", options)).toEqual({ type: "confirm" });

    expect(parseWechatControlCommand("/help", {
      ...options,
      adapter: "codex",
    })).toEqual({ type: "help" });
  });

  test("adds Claude-only approval shortcuts while keeping slash commands intact", () => {
    expect(
      parseWechatControlCommand("confirm", {
        adapter: "claude",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
      }),
    ).toEqual({ type: "confirm" });
    expect(
      parseWechatControlCommand("yes", {
        adapter: "claude",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
      }),
    ).toEqual({ type: "confirm" });
    expect(
      parseWechatControlCommand("deny", {
        adapter: "claude",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
      }),
    ).toEqual({ type: "deny" });
    expect(
      parseWechatControlCommand("no", {
        adapter: "claude",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
      }),
    ).toEqual({ type: "deny" });
    expect(
      parseWechatControlCommand("/confirm", {
        adapter: "claude",
        hasPendingConfirmation: false,
        hasPendingUserInput: false,
      }),
    ).toEqual({ type: "confirm" });
    expect(
      parseWechatControlCommand("/confirm LEGACY", {
        adapter: "claude",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
      }),
    ).toEqual({ type: "confirm" });
  });

  test("supports concise Chinese commands for the Codex WeChat path", () => {
    const options = {
      adapter: "codex" as const,
      hasPendingConfirmation: false,
      hasPendingUserInput: false,
    };
    expect(parseWechatControlCommand("任务", options)).toEqual({ type: "resume" });
    expect(parseWechatControlCommand("任务列表", options)).toEqual({ type: "resume" });
    expect(parseWechatControlCommand("任务 2", options)).toEqual({
      type: "resume",
      target: "2",
    });
    expect(parseWechatControlCommand("任务：2", options)).toEqual({
      type: "resume",
      target: "2",
    });
    expect(parseWechatControlCommand("任务: 12", options)).toEqual({
      type: "resume",
      target: "12",
    });
    expect(parseWechatControlCommand("任务：震荡 止损", options)).toEqual({
      type: "resume",
      target: "震荡 止损",
    });
    expect(parseWechatControlCommand("任务 震荡 止损", options)).toEqual({
      type: "resume",
      target: "震荡 止损",
    });
    expect(parseWechatControlCommand("任务:design", options)).toEqual({
      type: "resume",
      target: "design",
    });
    expect(parseWechatControlCommand("任务： design", options)).toEqual({
      type: "resume",
      target: "design",
    });
    expect(parseWechatControlCommand("任务：", options)).toEqual({ type: "resume" });
    expect(parseWechatControlCommand("下一页", options)).toEqual({
      type: "resume_page",
      direction: "next",
    });
    expect(parseWechatControlCommand("下一页20", options)).toEqual({
      type: "resume_page",
      direction: "next",
      count: 20,
    });
    expect(parseWechatControlCommand("下一页 30", options)).toEqual({
      type: "resume_page",
      direction: "next",
      count: 30,
    });
    expect(parseWechatControlCommand("上一页", options)).toEqual({
      type: "resume_page",
      direction: "prev",
    });
    expect(parseWechatControlCommand("状态", options)).toEqual({ type: "status" });
    expect(parseWechatControlCommand("停止", options)).toEqual({ type: "stop" });
    expect(parseWechatControlCommand("全文", options)).toEqual({
      type: "codex_reply_mode",
      mode: "full",
    });
    expect(parseWechatControlCommand("预览", options)).toEqual({
      type: "codex_reply_mode",
      mode: "preview",
    });
    expect(parseWechatControlCommand("帮助", options)).toEqual({ type: "help" });
    expect(parseWechatControlCommand("任务做完后告诉我", options)).toBeNull();
    expect(parseWechatControlCommand("任务", { ...options, adapter: "claude" })).toEqual({
      type: "resume",
    });
    expect(parseWechatControlCommand("任务：hooks", {
      ...options,
      adapter: "claude",
    })).toEqual({ type: "resume", target: "hooks" });
  });

  test("formats a command-free Codex WeChat help card", () => {
    const output = formatCodexWechatHelp();
    expect(output).toContain("查看任务：发送“任务”");
    expect(output).toContain("进入任务：发送“任务：2”");
    expect(output).toContain("任务 canvas");
    expect(output).toContain("任务canvas");
    expect(output).toContain("任务：canvas");
    expect(output).toContain("新建任务：发送“新建：内容”");
    expect(output).toContain("继续对话：直接发送消息");
    expect(output).toContain("查看进度：发送“状态”");
    expect(output).toContain("下一页20");
    expect(output).not.toContain("/tasks");
    expect(output).not.toContain("/t3");
  });

  test("uses numeric approval shortcuts only while an approval is pending", () => {
    expect(
      parseWechatControlCommand("1", {
        adapter: "codex",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
      }),
    ).toEqual({ type: "confirm" });
    expect(
      parseWechatControlCommand("2", {
        adapter: "codex",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
      }),
    ).toEqual({ type: "deny" });
    expect(
      parseWechatControlCommand("3", {
        adapter: "codex",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
        canConfirmForSession: true,
      }),
    ).toEqual({ type: "confirm_session" });
    expect(
      parseWechatControlCommand("3", {
        adapter: "codex",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
        canConfirmForSession: false,
      }),
    ).toBeNull();

    expect(
      parseWechatControlCommand("3", {
        adapter: "claude",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
        canAutoApproveTask: true,
      }),
    ).toEqual({ type: "confirm_task" });
    expect(
      parseWechatControlCommand("4", {
        adapter: "codex",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
        canConfirmForSession: true,
        canAutoApproveTask: true,
      }),
    ).toEqual({ type: "confirm_task" });
    expect(
      parseWechatControlCommand("3", {
        adapter: "codex",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
        canConfirmForSession: true,
        canAutoApproveTask: true,
      }),
    ).toEqual({ type: "confirm_session" });

    for (const text of ["1", "2", "3", "4"]) {
      expect(
        parseWechatControlCommand(text, {
          adapter: "codex",
          hasPendingConfirmation: false,
          hasPendingUserInput: false,
          canConfirmForSession: true,
          canAutoApproveTask: true,
        }),
      ).toBeNull();
    }
  });

  test("does not reinterpret bare approval words without pending approvals", () => {
    expect(
      parseWechatControlCommand("yes", {
        adapter: "claude",
        hasPendingConfirmation: false,
        hasPendingUserInput: false,
      }),
    ).toBeNull();
    expect(
      parseWechatControlCommand("confirm", {
        adapter: "codex",
        hasPendingConfirmation: false,
        hasPendingUserInput: false,
      }),
    ).toBeNull();
  });

  test("bare approval words work for all adapters when pending", () => {
    expect(
      parseWechatControlCommand("confirm", {
        adapter: "codex",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
      }),
    ).toEqual({ type: "confirm" });
    expect(
      parseWechatControlCommand("yes", {
        adapter: "codex",
        hasPendingConfirmation: true,
        hasPendingUserInput: false,
      }),
    ).toEqual({ type: "confirm" });

    for (const text of ["同意", "允许", "确认", "可以", "继续"]) {
      expect(
        parseWechatControlCommand(text, {
          adapter: "codex",
          hasPendingConfirmation: true,
          hasPendingUserInput: false,
        }),
      ).toEqual({ type: "confirm" });
    }

    for (const text of ["拒绝", "取消", "不允许", "不同意", "不可以"]) {
      expect(
        parseWechatControlCommand(text, {
          adapter: "codex",
          hasPendingConfirmation: true,
          hasPendingUserInput: false,
        }),
      ).toEqual({ type: "deny" });
    }
  });

  test("does not treat Chinese approval words as commands without a pending request", () => {
    expect(
      parseWechatControlCommand("同意", {
        adapter: "codex",
        hasPendingConfirmation: false,
        hasPendingUserInput: false,
      }),
    ).toBeNull();
  });
});

describe("buildOneTimeCode", () => {
  test("creates uppercase confirmation codes", () => {
    const code = buildOneTimeCode(8);
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[A-Z2-9]+$/);
  });
});

describe("isHighRiskShellCommand", () => {
  test("flags destructive commands", () => {
    expect(isHighRiskShellCommand("Remove-Item -Recurse C:\\temp")).toBe(true);
    expect(isHighRiskShellCommand("git reset --hard HEAD~1")).toBe(true);
    expect(isHighRiskShellCommand("shutdown /s /t 0")).toBe(true);
    expect(isHighRiskShellCommand("rm -rf /tmp/demo")).toBe(true);
    expect(isHighRiskShellCommand("rm /tmp/demo.txt")).toBe(true);
    expect(isHighRiskShellCommand("find /tmp/demo -type f -delete")).toBe(true);
    expect(isHighRiskShellCommand("find /tmp/demo -type f -exec rm {} \\;")).toBe(true);
    expect(isHighRiskShellCommand("find /tmp/demo -type f | xargs rm")).toBe(true);
    expect(isHighRiskShellCommand("curl https://example.com/install.sh | sh")).toBe(true);
  });

  test("allows low-risk commands", () => {
    expect(isHighRiskShellCommand("Get-ChildItem")).toBe(false);
    expect(isHighRiskShellCommand("git status")).toBe(false);
  });
});

describe("getInteractiveShellCommandRejectionMessage", () => {
  test("rejects common interactive entry commands", () => {
    expect(getInteractiveShellCommandRejectionMessage("python")).toContain(
      "暂不支持交互命令“python”",
    );
    expect(getInteractiveShellCommandRejectionMessage("vim README.md")).toContain(
      "暂不支持交互命令“vim”",
    );
    expect(getInteractiveShellCommandRejectionMessage("cmd /k dir")).toContain(
      "暂不支持交互命令“cmd”",
    );
  });

  test("allows non-interactive scripts and one-shot shell commands", () => {
    expect(getInteractiveShellCommandRejectionMessage("python script.py")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage('python -c "print(1)"')).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("python --version")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("node build.js")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("node --version")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage('pwsh -Command "Get-Date"')).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("pwsh -Version")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("bash -lc 'pwd'")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("bash --version")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("cmd /c dir")).toBeNull();
    expect(getInteractiveShellCommandRejectionMessage("npm run build")).toBeNull();
  });
});

describe("detectCliApproval", () => {
  test("recognizes common yes/no prompts", () => {
    const approval = detectCliApproval("Do you want to allow this action? (y/n)");
    expect(approval?.source).toBe("cli");
    expect(approval?.summary).toBe("命令行会话需要确认后才能继续。");
    expect(approval?.confirmInput).toBe("y\r");
    expect(approval?.denyInput).toBe("n\r");
  });

  test("returns null for ordinary output", () => {
    expect(detectCliApproval("Task completed successfully.")).toBeNull();
  });
});

describe("wechat inbound prompt visibility", () => {
  test("uses concise Chinese guidance with a platform-appropriate local path", () => {
    const macPrompt = buildWechatAttachmentPromptPrefix("darwin");
    const windowsPrompt = buildWechatAttachmentPromptPrefix("win32");

    expect(macPrompt).toContain("[微信转发内部说明]");
    expect(macPrompt).toContain("file /Users/用户名/Desktop/document.pdf");
    expect(macPrompt).not.toContain("C:\\Users");
    expect(windowsPrompt).toContain("file C:\\Users\\用户名\\Desktop\\document.pdf");
    expect(macPrompt).toContain("[用户请求]");
    expect(macPrompt).not.toContain("Your final reply");
  });

  test("shows only the real request for both legacy and Chinese bridge prompts", () => {
    const legacyPrompt = [
      "[WeRelay WeChat note]",
      "English transport instructions.",
      "",
      "[User request]",
      "把桌面的文档发给我",
      "",
      "[WeChat inbound attachments — ACTION REQUIRED]",
      "kind=file path=/Users/test/Desktop/a.pdf",
    ].join("\n");
    const chinesePrompt = [
      "[微信转发内部说明]",
      "内部传输说明。",
      "",
      "[用户请求]",
      "把桌面的文档发给我",
      "",
      "[微信入站附件]",
      "类型=文件 路径=/Users/test/Desktop/a.pdf",
    ].join("\n");

    expect(sanitizeWechatInboundPromptForDisplay(legacyPrompt)).toBe("把桌面的文档发给我");
    expect(sanitizeWechatInboundPromptForDisplay(chinesePrompt)).toBe("把桌面的文档发给我");
  });
});

describe("wechat inbound prompt injection", () => {
  test("injects attachment guidance for explicit send-to-WeChat requests", () => {
    const prompt = buildWechatInboundPrompt("把桌面的pdf发给我，发送微信");

    expect(shouldInjectWechatAttachmentPrompt("把桌面的pdf发给我，发送微信")).toBe(true);
    expect(prompt).toContain("[微信转发内部说明]");
    expect(prompt).toContain("```wechat-attachments");
    expect(prompt).toContain("[用户请求]\n把桌面的pdf发给我，发送微信");
  });

  test("tells agents to reference source paths instead of staging outbound files", () => {
    const prompt = buildWechatInboundPrompt("Please send any document from Desktop to WeChat.");

    expect(prompt).toContain("直接引用原始本地绝对路径");
    expect(prompt).toContain("不要在 ~/.claude/channels/wechat");
    expect(prompt).toContain("~/.claude/channels/wechat");
    expect(prompt).toContain("~/.werelay");
    expect(prompt).toContain("outbound-attachments");
  });

  test("detects outbound attachment staging writes without blocking read-only commands", () => {
    expect(
      containsWechatOutboundAttachmentPath(
        "C:\\Users\\example\\.werelay\\outbound-attachments\\2026-05-23\\report.docx",
      ),
    ).toBe(true);
    expect(
      isWechatOutboundAttachmentWriteCommand(
        'Copy-Item "C:/Users/example/Desktop/report.docx" "C:/Users/example/.werelay/outbound-attachments/2026-05-23/report.docx"',
      ),
    ).toBe(true);
    expect(
      isWechatOutboundAttachmentWriteCommand(
        'ls "C:/Users/example/.werelay/outbound-attachments/2026-05-23"',
      ),
    ).toBe(false);
    expect(
      isWechatOutboundAttachmentMutationTool(
        "edit",
        "C:\\Users\\example\\.claude\\channels\\wechat\\outbound-attachments\\2026-05-23\\report.docx",
      ),
    ).toBe(true);
    expect(
      isWechatOutboundAttachmentMutationTool(
        "external_directory",
        "C:\\Users\\example\\.werelay\\outbound-attachments\\2026-05-23",
      ),
    ).toBe(true);
  });

  test("injects attachment guidance for short follow-up send commands", () => {
    expect(shouldInjectWechatAttachmentPrompt("发送微信")).toBe(true);
    expect(shouldInjectWechatAttachmentPrompt("发呀")).toBe(true);
    expect(buildWechatInboundPrompt("直接发给我")).toContain("```wechat-attachments");
  });

  test("injects attachment guidance for common Chinese send-file phrasing", () => {
    const requests = [
      "你随便给我发一个桌面上的PDF给我呗",
      "帮我把桌面的PDF发过来，我要毕业设计相关的",
      "给我发一个 C:\\Users\\example\\Desktop\\a.pdf",
    ];

    for (const request of requests) {
      expect(shouldInjectWechatAttachmentPrompt(request)).toBe(true);
      expect(buildWechatInboundPrompt(request)).toContain("```wechat-attachments");
    }
  });

  test("does not mistake discussion about ClawBot messages for a file-send request", () => {
    const complaint = "微信ClawBot 发过来的消息有这么大段英文是什么意思，必须吗，合理吗？我是 Mac，没有 C 盘。";

    expect(shouldInjectWechatAttachmentPrompt(complaint)).toBe(false);
    expect(buildWechatInboundPrompt(complaint)).toBe(complaint);
  });

  test("skips prompt injection for ordinary non-send requests and existing protocol blocks", () => {
    const ordinary = "帮我总结一下这份强化学习资料。";
    const nonSendWithChineseFa = "帮我发现这份桌面资料里的问题。";
    const explicitProtocol = [
      "直接发送。",
      "```wechat-attachments",
      "file C:\\Users\\example\\Desktop\\rl.pdf",
      "```",
    ].join("\n");

    expect(shouldInjectWechatAttachmentPrompt(ordinary)).toBe(false);
    expect(shouldInjectWechatAttachmentPrompt(nonSendWithChineseFa)).toBe(false);
    expect(buildWechatInboundPrompt(ordinary)).toBe(ordinary);
    expect(buildWechatInboundPrompt(explicitProtocol)).toBe(explicitProtocol);
  });

  test("adds saved inbound attachment paths to the prompt", () => {
    const prompt = buildWechatInboundPrompt("Please summarize this file.", [
      {
        kind: "file",
        path: "C:\\Users\\example\\.werelay\\inbound-attachments\\2026-05-22\\report.pdf",
        fileName: "report.pdf",
        sizeBytes: 1536,
      },
    ]);

    expect(prompt).toContain("Please summarize this file.");
    expect(prompt).toContain("[微信入站附件]");
    expect(prompt).toContain("kind=file name=report.pdf size=1.5 KB path=C:\\Users\\example");
  });

  test("creates a usable prompt for attachment-only messages", () => {
    const prompt = buildWechatInboundPrompt("", [
      {
        kind: "image",
        path: "C:\\Users\\example\\.werelay\\inbound-attachments\\2026-05-22\\photo.jpg",
        fileName: "photo.jpg",
      },
    ]);

    expect(prompt).toContain("收到微信附件。");
    expect(prompt).toContain("kind=image name=photo.jpg path=C:\\Users\\example");
  });
});

describe("parseCodexSessionAgentMessage", () => {
  test("extracts final-answer agent messages from the Codex session log", () => {
    expect(
      parseCodexSessionAgentMessage(
        JSON.stringify({
          timestamp: "2026-03-22T14:50:22.195Z",
          type: "event_msg",
          payload: {
            type: "agent_message",
            phase: "final_answer",
            message: "Hello from Codex.",
          },
        }),
      ),
    ).toEqual({
      timestamp: "2026-03-22T14:50:22.195Z",
      phase: "final_answer",
      message: "Hello from Codex.",
    });
  });

  test("ignores unrelated JSONL entries", () => {
    expect(
      parseCodexSessionAgentMessage(
        JSON.stringify({
          timestamp: "2026-03-22T14:50:22.195Z",
          type: "response_item",
          payload: { type: "message" },
        }),
      ),
    ).toBeNull();
  });
});

describe("WeChat attachment reply protocol", () => {
  test("extracts trailing attachment blocks with multiple local paths", () => {
    expect(
      parseWechatFinalReply(
        [
          "Finished.",
          "```wechat-attachments",
          "image C:\\Users\\example\\Desktop\\photo 1.jpg",
          "file C:\\Users\\example\\Desktop\\report final.pdf",
          "video C:\\Users\\example\\Desktop\\clip.mp4",
          "voice C:\\Users\\example\\Desktop\\audio.mp3",
          "```",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Finished.",
      attachments: [
        {
          kind: "image",
          path: "C:\\Users\\example\\Desktop\\photo 1.jpg",
        },
        {
          kind: "file",
          path: "C:\\Users\\example\\Desktop\\report final.pdf",
        },
        {
          kind: "video",
          path: "C:\\Users\\example\\Desktop\\clip.mp4",
        },
        {
          kind: "voice",
          path: "C:\\Users\\example\\Desktop\\audio.mp3",
        },
      ],
    });
  });

  test("rejects malformed attachment metadata and leaves the text unchanged", () => {
    expect(
      parseWechatFinalReply(
        [
          "Finished.",
          "```wechat-attachments",
          "image relative\\photo.jpg",
          "```",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: ["Finished.", "```wechat-attachments", "image relative\\photo.jpg", "```"].join(
        "\n",
      ),
      attachments: [],
    });
  });

  test("extracts local files from wrapped maas image URLs when no attachment block is present", () => {
    expect(
      parseWechatFinalReply(
        [
          "Main campus wallpaper:",
          "",
          "https://maas-log-prod.cn-wlcb.ufileos.com/anthropic/abc/C:\\Users\\example\\Desktop\\albums\\",
          "  campus\\main-building. png? UCloudPublicKey=TOKEN&Expires=1774447676&Signature=test",
          "",
          "Looks good.",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Main campus wallpaper:\n\nLooks good.",
      attachments: [
        {
          kind: "image",
          path: "C:\\Users\\example\\Desktop\\albums\\campus\\main-building.png",
        },
      ],
    });
  });

  test("extracts inline code paths and keeps the surrounding narration", () => {
    expect(
      parseWechatFinalReply(
        [
          "Saved the render to `C:\\Users\\example\\Desktop\\exports\\cover.png`.",
          "Please review it.",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Saved the render to .\nPlease review it.",
      attachments: [
        {
          kind: "image",
          path: "C:\\Users\\example\\Desktop\\exports\\cover.png",
        },
      ],
    });
  });

  test("keeps multi-dot document names intact when extracting inline attachments", () => {
    expect(
      parseWechatFinalReply(
        [
          "Artifacts:",
          "```text",
          "C:\\Users\\example\\Desktop\\exports\\analysis.final.pdf",
          "```",
          "Done.",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Artifacts:\n\nDone.",
      attachments: [
        {
          kind: "file",
          path: "C:\\Users\\example\\Desktop\\exports\\analysis.final.pdf",
        },
      ],
    });
  });

  test("extracts ordinary local text files from inline paths", () => {
    expect(
      parseWechatFinalReply(
        [
          "Saved note to `C:\\Users\\example\\Desktop\\exports\\summary.txt`.",
          "Review it.",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Saved note to .\nReview it.",
      attachments: [
        {
          kind: "file",
          path: "C:\\Users\\example\\Desktop\\exports\\summary.txt",
        },
      ],
    });
  });

  test("extracts standalone absolute paths from code fences", () => {
    expect(
      parseWechatFinalReply(
        [
          "Artifacts:",
          "```text",
          "C:\\Users\\example\\Desktop\\exports\\cover.png",
          "C:\\Users\\example\\Desktop\\exports\\report.pdf",
          "```",
          "Done.",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Artifacts:\n\nDone.",
      attachments: [
        {
          kind: "image",
          path: "C:\\Users\\example\\Desktop\\exports\\cover.png",
        },
        {
          kind: "file",
          path: "C:\\Users\\example\\Desktop\\exports\\report.pdf",
        },
      ],
    });
  });

  test("does not auto-attach source code paths from ordinary text", () => {
    expect(
      parseWechatFinalReply(
        [
          "Reference only:",
          "`C:\\Users\\example\\Desktop\\Github\\werelay-project\\src\\bridge\\bridge-adapters.test.ts`",
          "Do not upload this file.",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: [
        "Reference only:",
        "`C:\\Users\\example\\Desktop\\Github\\werelay-project\\src\\bridge\\bridge-adapters.test.ts`",
        "Do not upload this file.",
      ].join("\n"),
      attachments: [],
    });
  });

  test("extracts home-relative desktop paths from ordinary text", () => {
    expect(
      parseWechatFinalReply(
        [
          "Pick this one:",
          "Desktop/screenshots/air. png",
          "If you want another, ask again.",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Pick this one:\n\nIf you want another, ask again.",
      attachments: [
        {
          kind: "image",
          path: path.join(os.homedir(), "Desktop", "screenshots", "air.png"),
        },
      ],
    });
  });

  test("keeps explicit attachment blocks authoritative for arbitrary file types", () => {
    expect(
      parseWechatFinalReply(
        [
          "Ready.",
          "```wechat-attachments",
          "file C:\\Users\\example\\Desktop\\Github\\werelay-project\\src\\bridge\\bridge-adapters.test.ts",
          "```",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Ready.",
      attachments: [
        {
          kind: "file",
          path: "C:\\Users\\example\\Desktop\\Github\\werelay-project\\src\\bridge\\bridge-adapters.test.ts",
        },
      ],
    });
  });

  test("accepts home-relative desktop paths inside attachment blocks", () => {
    expect(
      parseWechatFinalReply(
        [
          "Ready.",
          "```wechat-attachments",
          "image Desktop/screenshots/air. png",
          "```",
        ].join("\n"),
      ),
    ).toEqual({
      visibleText: "Ready.",
      attachments: [
        {
          kind: "image",
          path: path.join(os.homedir(), "Desktop", "screenshots", "air.png"),
        },
      ],
    });
  });
});

describe("OutputBatcher", () => {
  test("flushes by size and keeps a recent summary", async () => {
    const flushed: string[] = [];
    const batcher = new OutputBatcher(
      async (text) => {
        flushed.push(text);
      },
      10_000,
      5,
    );

    batcher.push("hello world");
    await batcher.flushNow();

    expect(flushed.length).toBeGreaterThanOrEqual(2);
    expect(flushed.join("")).toContain("hello");
    expect(batcher.getRecentSummary()).toContain("hello");
  });
});

describe("startup backlog filtering", () => {
  test("drops messages older than bridge startup watermark", () => {
    const startedAt = Date.now();
    expect(
      shouldDropStartupBacklogMessage(
        startedAt - MESSAGE_START_GRACE_MS - 1,
        startedAt,
      ),
    ).toBe(true);
    expect(shouldDropStartupBacklogMessage(startedAt, startedAt)).toBe(false);
    // Missing or invalid timestamps must be treated as fresh, not dropped.
    expect(shouldDropStartupBacklogMessage(undefined, startedAt)).toBe(false);
    expect(shouldDropStartupBacklogMessage(0, startedAt)).toBe(false);
  });
});

describe("formatStatusReport", () => {
  test("keeps mobile status concise and hides internal diagnostics", () => {
    const bridgeState: BridgeState = {
      instanceId: "bridge-test",
      adapter: "codex",
      command: "codex",
      cwd: "C:\\repo",
      bridgeStartedAtMs: 1_700_000_000_000,
      authorizedUserId: "wx-owner",
      ignoredBacklogCount: 0,
      sharedSessionId: "thread_persisted",
      sharedThreadId: "thread_persisted",
      pendingConfirmation: null,
      lastActivityAt: "2026-03-23T12:00:00.000Z",
    };
    const adapterState: BridgeAdapterState = {
      kind: "codex",
      status: "busy",
      cwd: "C:\\repo",
      command: "codex",
      sharedSessionId: "thread_123",
      sharedThreadId: "thread_123",
      activeTurnId: "turn_456",
      activeTurnOrigin: "local",
    };

    expect(formatStatusReport(bridgeState, adapterState)).toBe(
      "状态：处理中\n来源：桌面端",
    );
    expect(formatStatusReport(bridgeState, adapterState)).not.toMatch(
      /thread_|turn_|instance_id|worker_pid|C:\\repo/,
    );
  });
});

describe("formatThreadSwitchMessage", () => {
  test("formats local thread-follow notices for mobile WeChat", () => {
    expect(
      formatThreadSwitchMessage({
        threadId: "thread_local_123456",
        source: "local",
        reason: "local_follow",
      }),
    ).toBe("已跟随桌面端切换任务。");
  });

  test("formats startup restore notices without internal ids", () => {
    expect(
      formatThreadSwitchMessage({
        threadId: "thread_restore_123456",
        source: "restore",
        reason: "startup_restore",
      }),
    ).toBe("已恢复上次任务。");
  });

  test("formats local session fallback notices", () => {
    expect(
      formatThreadSwitchMessage({
        threadId: "thread_fallback_123456",
        source: "local",
        reason: "local_session_fallback",
      }),
    ).toBe("已跟随桌面端切换任务。");
  });
});

describe("formatResumeThreadList", () => {
  test("renders a numbered list and marks the current thread", () => {
    const output = formatResumeThreadList(
      [
        {
          sessionId: "thread_1",
          threadId: "thread_1",
          title: "Fix the bridge resume flow",
          lastUpdatedAt: "2026-03-23T12:00:00.000Z",
        },
        {
          sessionId: "thread_2",
          threadId: "thread_2",
          title: "Review README updates",
          lastUpdatedAt: "2026-03-23T10:00:00.000Z",
        },
      ],
      "thread_1",
    );

    expect(output).toContain("1. Fix the bridge resume flow");
    expect(output).toContain("当前");
    expect(output).toContain("回复序号进入任务");
    expect(output).toContain("发送“任务”可重新选择");
    expect(output).toContain("发送“任务：关键词”搜索");
    expect(output).not.toContain("/t2");
    expect(output).not.toContain("03/23");
  });
});

describe("resolveResumeSessionCandidate", () => {
  const candidates = [
    {
      sessionId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa7",
      threadId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa7",
      title: "校验页面模板并列出修复建议",
      lastUpdatedAt: "2026-07-25T15:10:42.000Z",
      cwd: "/Users/example/Projects/design-system",
    },
    {
      sessionId: "cccccccc-cccc-7ccc-8ccc-ccccccccccc9",
      threadId: "cccccccc-cccc-7ccc-8ccc-ccccccccccc9",
      title: "检索亚太开发者活动",
      lastUpdatedAt: "2026-07-25T14:57:25.000Z",
      cwd: "/Users/example/Projects/notes",
    },
  ];

  test("resolves a one-based task number", () => {
    expect(resolveResumeSessionCandidate(candidates, "2")?.sessionId).toBe(
      "cccccccc-cccc-7ccc-8ccc-ccccccccccc9",
    );
  });

  test("resolves an unambiguous thread id prefix", () => {
    expect(resolveResumeSessionCandidate(candidates, "aaaaaaaa")?.title).toBe(
      "校验页面模板并列出修复建议",
    );
  });

  test("rejects out-of-range or unknown targets", () => {
    expect(resolveResumeSessionCandidate(candidates, "0")).toBeNull();
    expect(resolveResumeSessionCandidate(candidates, "3")).toBeNull();
    expect(resolveResumeSessionCandidate(candidates, "missing")).toBeNull();
  });
});

describe("formatResumeSessionList", () => {
  test("renders Claude sessions with session wording", () => {
    const output = formatResumeSessionList({
      adapter: "claude",
      candidates: [
        {
          sessionId: "session_1",
          title: "Continue the Claude bridge refactor",
          lastUpdatedAt: "2026-03-24T08:00:00.000Z",
        },
      ],
      currentSessionId: "session_1",
    });

    expect(output).toContain("最近任务");
    expect(output).not.toContain("session_1");
    expect(output).toContain("[当前]");
    expect(output).toContain("回复序号进入任务");
    expect(output).toContain("数字：内容");
    expect(output).toContain("6：继续处理");
    expect(output).not.toContain("/resume");
  });
});

describe("adapter-aware message formatting", () => {
  test("formats mirrored desktop input in concise Chinese", () => {
    expect(formatMirroredUserInputMessage("claude", "Review the hooks flow")).toBe(
      "桌面端输入：\nReview the hooks flow",
    );
  });

  test("removes Codex desktop metadata and aliases images", () => {
    const output = formatMirroredUserInputMessage("codex", [
      "# Files mentioned by the user:",
      "",
      "## codex-clipboard-a.png: /var/tmp/codex-clipboard-a.png",
      "## codex-clipboard-b.png: /var/tmp/codex-clipboard-b.png",
      "",
      "## My request for Codex:",
      "检查这两张图",
      '<image name=[Image #1] path="/var/tmp/codex-clipboard-a.png">',
      '<image name=[Image #2] path="/var/tmp/codex-clipboard-b.png">',
    ].join("\n"));

    expect(output).toBe("桌面端输入：\n图片：png1 png2\n检查这两张图");
    expect(output).not.toMatch(/Files mentioned|My request|codex-clipboard|\/var\/tmp|Image #/);
  });

  test("formats final reply and failure messages by adapter", () => {
    expect(formatFinalReplyMessage("codex", "Done")).toBe("Done");
    expect(formatFinalReplyMessage("claude", "Done")).toBe("Done");
    expect(formatTaskFailedMessage("claude", "Boom")).toBe("任务失败：Boom");
  });

  test("formats concise localized approval prompts without a required code", () => {
    const pending = {
      source: "cli" as const,
      summary: "Claude permission is required for Bash.",
      commandPreview: "Bash: npm test",
      toolName: "Bash",
      detailLabel: "command",
      detailPreview: "npm test",
      code: "ABC123",
      createdAt: "2026-03-24T09:00:00.000Z",
    };
    const claudeAdapterState: BridgeAdapterState = {
      kind: "claude",
      status: "awaiting_approval",
      cwd: "C:\\repo",
      command: "claude",
      pendingApproval: pending,
    };
    const codexAdapterState: BridgeAdapterState = {
      kind: "codex",
      status: "awaiting_approval",
      cwd: "C:\\repo",
      command: "codex",
      pendingApproval: pending,
    };

    expect(formatApprovalMessage(pending, claudeAdapterState)).toContain("需要确认");
    expect(formatApprovalMessage(pending, claudeAdapterState)).toContain("操作：npm test");
    expect(formatApprovalMessage(pending, claudeAdapterState)).not.toContain("code:");
    expect(formatApprovalMessage(pending, claudeAdapterState)).toContain("1 允许本次");
    expect(formatApprovalMessage(pending, claudeAdapterState)).toContain("2 拒绝");
    expect(formatApprovalMessage(pending, claudeAdapterState)).not.toContain(
      "3 本任务始终允许",
    );
    expect(
      formatApprovalMessage(pending, claudeAdapterState, {
        allowTaskAutoApprove: true,
      }),
    ).toContain("3 今日内本任务免审");
    expect(formatPendingApprovalReminder(pending, claudeAdapterState)).toContain("回复数字");

    const codexPending = { ...pending, allowForSession: true };
    expect(formatApprovalMessage(codexPending, codexAdapterState)).toContain(
      "3 本任务始终允许",
    );
    expect(
      formatApprovalMessage(codexPending, codexAdapterState, {
        allowTaskAutoApprove: true,
      }),
    ).toContain("4 今日内本任务免审");
    expect(
      formatPendingApprovalReminder(codexPending, codexAdapterState, {
        allowTaskAutoApprove: true,
      }),
    ).toContain("4 今日内本任务免审");
    expect(formatApprovalMessage(codexPending, codexAdapterState)).not.toMatch(
      /adapter:|summary:|target:/i,
    );
    expect(formatPendingApprovalReminder(codexPending, codexAdapterState)).toContain(
      "2 拒绝",
    );

    const longCodexPending = {
      ...codexPending,
      summary:
        "Codex needs approval before running a command: 需要发布新版并执行回归验证",
      commandPreview:
        '/bin/zsh -lc "ssh user@example.com /Users/test/project/scripts/deploy-production.sh"',
      detailPreview:
        '/bin/zsh -lc "ssh user@example.com /Users/test/project/scripts/deploy-production.sh"',
    };
    const longOutput = formatApprovalMessage(longCodexPending, codexAdapterState);
    expect(longOutput).toContain("需要发布新版并执行回归验证");
    expect(longOutput).not.toMatch(/Codex needs approval|\/Users\/test|deploy-production/);
  });

  test("notifies WeChat only when an active task is confirmed interrupted", () => {
    expect(shouldNotifyTaskInterrupted("interrupted", true)).toBe(true);
    expect(shouldNotifyTaskInterrupted("interrupted", false)).toBe(false);
    expect(shouldNotifyTaskInterrupted("completed", true)).toBe(false);
    expect(formatTaskInterruptedMessage("codex")).toBe("Codex 任务已中断。");
  });

  test("compacts English request-user-input metadata for mobile WeChat", () => {
    const pending = {
      summary: "Codex needs more information before the tool can continue.",
      questions: [
        {
          id: "format",
          header: "Format",
          question: "Which output format should I use?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "Markdown", description: "Return a Markdown report." },
            { label: "DOCX", description: "Create a Word document." },
          ],
        },
      ],
      createdAt: "2026-07-29T00:00:00.000Z",
    };
    const adapterState: BridgeAdapterState = {
      kind: "codex",
      status: "awaiting_input",
      cwd: "C:\\repo",
      command: "codex",
    };

    const output = formatUserInputRequestMessage(pending, adapterState);
    expect(output).toContain("需要补充信息");
    expect(output).toContain("请选择：Format");
    expect(output).toContain("1. Markdown");
    expect(output).toContain("回复 /answer 1");
    expect(output).not.toMatch(/adapter:|\[id:|options:|Return a Markdown|Create a Word/);
    expect(formatPendingUserInputReminder(pending)).toBe(
      "任务等待输入：Format\n请回复 /answer。",
    );
  });
});


describe("formatCodexDesktopTaskLatestMessage", () => {
  test("labels and preserves the latest assistant message for WeChat", () => {
    const output = formatCodexDesktopTaskLatestMessage({
      role: "assistant",
      text: "前序结论：继续修复切换流程。\n下一步运行完整测试。",
    });

    expect(output).toContain("最近一条消息（Codex）");
    expect(output).toContain("前序结论：继续修复切换流程。\n下一步运行完整测试。");
  });

  test("uses the selected terminal label for a non-Codex latest message", () => {
    const output = formatCodexDesktopTaskLatestMessage({
      role: "assistant",
      text: "已继续原会话。",
    }, "Claude");

    expect(output).toContain("最近一条消息（Claude）");
    expect(output).not.toContain("Codex");
  });

  test("labels a latest user message and bounds oversized content", () => {
    const output = formatCodexDesktopTaskLatestMessage({
      role: "user",
      text: "a".repeat(2_000),
    });

    expect(output).toContain("最近一条消息（你）");
    expect(output.length).toBeLessThanOrEqual(1_200);
    expect(output).toEndWith("…");
    expect(output).not.toContain("内容过长，已截断");
  });


  test("compacts image metadata in the latest user message", () => {
    const output = formatCodexDesktopTaskLatestMessage({
      role: "user",
      text: [
        "# Files mentioned by the user:",
        "## shot.png: /private/tmp/shot.png",
        "## My request for Codex:",
        "看看这个页面",
        '<image name=[Image #1] path="/private/tmp/shot.png">',
      ].join("\n"),
    });

    expect(output).toContain("图片：png1\n看看这个页面");
    expect(output).not.toMatch(/Files mentioned|shot\.png|private\/tmp|Image #/);
  });
});

describe("Codex task fuzzy selection", () => {
  const candidates = [
    {
      sessionId: "thread-1",
      threadId: "thread-1",
      title: "完善移动版任务栏",
      projectName: "design-system",
      lastUpdatedAt: "2026-08-02T13:00:00.000Z",
    },
    {
      sessionId: "thread-2",
      threadId: "thread-2",
      title: "优化震荡行情止损",
      projectName: "market-simulator",
      lastUpdatedAt: "2026-08-02T12:00:00.000Z",
    },
    {
      sessionId: "thread-3",
      threadId: "thread-3",
      title: "整理周末出行计划",
      projectName: "notes",
      lastUpdatedAt: "2026-08-02T11:30:00.000Z",
    },
    {
      sessionId: "thread-4",
      threadId: "thread-4",
      title: "定位开仓后价格转折记录逻辑",
      projectName: "market-simulator",
      lastUpdatedAt: "2026-08-02T11:00:00.000Z",
    },
  ];

  test("matches title subsequences and project names", () => {
    expect(searchResumeSessionCandidates(candidates, "震荡止损").map((match) => (
      match.candidate.sessionId
    ))).toEqual(["thread-2"]);
    expect(searchResumeSessionCandidates(candidates, "market simulator").map((match) => (
      match.candidate.sessionId
    ))).toEqual(["thread-2", "thread-4"]);
  });

  test("filters by a partial project name and directly resolves a unique task title", () => {
    const projectCandidates = [
      {
        sessionId: "canvas-1",
        title: "整理 Codex 周复盘",
        projectName: "design-system",
        lastUpdatedAt: "2026-08-04T00:00:00.000Z",
      },
      {
        sessionId: "canvas-2",
        title: "设计知识蒸馏",
        projectName: "design-system",
        lastUpdatedAt: "2026-08-04T00:00:00.000Z",
      },
      {
        sessionId: "trade-1",
        title: "定位开仓记录逻辑",
        projectName: "market-simulator",
        lastUpdatedAt: "2026-08-04T00:00:00.000Z",
      },
    ];

    expect(searchResumeSessionCandidates(projectCandidates, "design").map((match) => (
      match.candidate.sessionId
    )).sort()).toEqual(["canvas-1", "canvas-2"]);
    expect(resolveResumeSessionCandidate(projectCandidates, "知识蒸馏")?.sessionId).toBe(
      "canvas-2",
    );
    expect(resolveCompactCodexTaskSearchTarget("任务design", projectCandidates)).toBe(
      "design",
    );
    expect(resolveCompactCodexTaskSearchTarget("任务知识蒸馏", projectCandidates)).toBe(
      "知识蒸馏",
    );
    expect(resolveCompactCodexTaskSearchTarget("任务做完后告诉我", projectCandidates)).toBeNull();
  });

  test("jumps directly only when the fuzzy target is unambiguous", () => {
    expect(resolveResumeSessionCandidate(candidates, "震荡止损")?.sessionId).toBe("thread-2");
    expect(resolveResumeSessionCandidate(candidates, "market simulator")).toBeNull();
    expect(resolveResumeSessionCandidate(candidates, "完善移动版任务栏")?.sessionId).toBe("thread-1");
  });

  test("formats ambiguous matches with their global task numbers", () => {
    const matches = searchResumeSessionCandidates(candidates, "market simulator");
    const output = formatResumeSessionSearchResults({
      target: "market simulator",
      matches,
      currentSessionId: "thread-4",
    });

    expect(output).toContain("匹配任务：market simulator");
    expect(output).toContain("2. [market-simulator] 优化震荡行情止损");
    expect(output).toContain("4. [market-simulator] 定位开仓后价格转折记录逻辑");
    expect(output).toContain("当前");
    expect(output).toContain("回复序号或发送“任务2”进入");
  });
});

describe("formatCodexDesktopTaskSelection", () => {
  test("confirms the selected Codex desktop task", () => {
    const output = formatCodexDesktopTaskSelection({
      sessionId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa7",
      title: "校验页面模板并列出修复建议",
      lastUpdatedAt: "2026-07-25T15:10:42.000Z",
      cwd: "/Users/example/Projects/design-system",
    });

    expect(output).toContain("已进入任务。");
    expect(output).not.toContain("校验页面模板并列出修复建议");
    expect(output).not.toContain("项目：design-system");
    expect(output).not.toContain("aaaaaaaa");
    expect(output).toContain("接下来直接回复，会发送给当前任务");
    expect(output).toContain("任务4：继续处理");
    expect(output).toContain("发送“任务”可切换其他任务");
  });

  test("shows elapsed time for a running task", () => {
    const output = formatCodexDesktopTaskSelection(
      {
        sessionId: "thread_running",
        title: "运行中的任务",
        lastUpdatedAt: "2026-08-01T08:00:00.000Z",
        runtimeStatus: { type: "active", activeFlags: [] },
      },
      {
        turnId: "turn_running",
        status: "running",
        startedAtMs: 1_000,
        durationMs: 547_000,
      },
    );

    expect(output).toContain("状态：进行中，已运行9m 7s");
  });

  test("shows duration for a completed task", () => {
    const completedAtMs = new Date(2026, 7, 1, 16, 5).getTime();
    const output = formatCodexDesktopTaskSelection(
      {
        sessionId: "thread_done",
        title: "已完成任务",
        lastUpdatedAt: "2026-08-01T08:00:00.000Z",
        runtimeStatus: { type: "idle" },
      },
      {
        turnId: "turn_done",
        status: "completed",
        startedAtMs: 1_000,
        completedAtMs,
        durationMs: 1_055_660,
      },
    );

    expect(output).toContain("状态：08-01 16:05 已完成，用时17m 36s");
  });
});

describe("formatResumeSessionList for Codex desktop tasks", () => {
  test("shows desktop project names and /task selection instructions", () => {
    const output = formatResumeSessionList({
      adapter: "codex",
      candidates: [
        {
          sessionId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa7",
          threadId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa7",
          title: "校验页面模板并列出修复建议",
          lastUpdatedAt: "2026-07-25T15:10:42.000Z",
          cwd: "/Users/example/Projects/design-system",
          runtimeStatus: {
            type: "notLoaded",
          },
        },
        {
          sessionId: "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbb8",
          threadId: "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbb8",
          title: "运行完整测试",
          lastUpdatedAt: "2026-07-25T15:09:42.000Z",
          cwd: "/Users/example/Projects/design-system",
          runtimeStatus: {
            type: "active",
            activeFlags: [],
          },
        },
        {
          sessionId: "dddddddd-dddd-7ddd-8ddd-ddddddddddd5",
          threadId: "dddddddd-dddd-7ddd-8ddd-ddddddddddd5",
          title: "示例服务器部署",
          lastUpdatedAt: "2026-07-25T15:08:42.000Z",
          cwd: "/Users/example/Projects/Codex/2026-07-10/generated-task",
          runtimeStatus: {
            type: "notLoaded",
          },
        },
      ],
      currentSessionId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaa7",
      currentWorkerStatus: "awaiting_approval",
    });

    expect(output).toContain("最近任务\n1.");
    expect(output).not.toContain("────────");
    expect(output).toContain("[design-system]");
    expect(output).not.toContain("[generated-task]");
    expect(output).not.toContain("aaaaaaaa");
    expect(output).not.toContain("bbbbbbbb");
    expect(output).not.toContain("dddddddd");
    expect(output).not.toContain("07/25");
    expect(output).toContain("当前 · 待审批");
    expect(output).toContain("运行完整测试\u3000🟢");
    expect(output).not.toContain("运行完整测试\u3000运行中");
    expect(output).not.toContain("[进行中]");
    expect(output).toContain("回复序号进入任务");
    expect(output).toContain("发送“任务”可重新选择");
    expect(output).toContain("发送“新建：内容”创建任务并直接开始");
    expect(output).not.toContain("上一页");
    expect(output).toContain("不会中断后台运行");
    expect(output).toContain("序号在再次发送“任务”前保持不变");
  });

  test("shows global task numbers and next-page instructions", () => {
    const output = formatResumeSessionList({
      adapter: "codex",
      candidates: [
        {
          sessionId: "thread_16",
          threadId: "thread_16",
          title: "第十六个任务",
          lastUpdatedAt: "2026-07-25T15:10:42.000Z",
          runtimeStatus: {
            type: "active",
            activeFlags: [],
          },
        },
        {
          sessionId: "thread_17",
          threadId: "thread_17",
          title: "第十七个任务",
          lastUpdatedAt: "2026-07-25T15:09:42.000Z",
          runtimeStatus: {
            type: "notLoaded",
          },
        },
      ],
      page: 2,
      hasMore: true,
    });

    expect(output).toContain("11. 第十六个任务\u3000🟢");
    expect(output).not.toContain("11. 第十六个任务\u3000运行中");
    expect(output).toContain("12. 第十七个任务");
    expect(output).toContain("发送“下一页”查看更多");
    expect(output).toContain("发送“上一页”返回");
    expect(output).toContain("回复序号进入任务");
    expect(output).toContain("发送“任务”可重新选择");
    expect(output).toContain("发送“新建：内容”创建任务并直接开始");
  });

  test("supports a custom next-page size without skipping tasks", () => {
    const navigation = resolveCodexTaskListPageNavigation({
      direction: "next",
      current: { startIndex: 0, pageSize: 10 },
      history: [],
      requestedPageSize: 20,
    });
    expect(navigation).toEqual({
      current: { startIndex: 10, pageSize: 20 },
      history: [{ startIndex: 0, pageSize: 10 }],
    });

    const output = formatResumeSessionList({
      adapter: "codex",
      candidates: Array.from({ length: 20 }, (_, index) => ({
        sessionId: `thread_${index + 11}`,
        title: `任务 ${index + 11}`,
        lastUpdatedAt: "2026-08-04T00:00:00.000Z",
      })),
      startIndex: navigation.current.startIndex,
      hasPrevious: true,
      hasMore: true,
    });

    expect(output).toContain("11. 任务 11");
    expect(output).toContain("30. 任务 30");
    expect(output).toContain("下一页20");
  });

  test("returns to the exact previous range after a custom-sized page", () => {
    const previous = resolveCodexTaskListPageNavigation({
      direction: "prev",
      current: { startIndex: 10, pageSize: 20 },
      history: [{ startIndex: 0, pageSize: 10 }],
    });
    expect(previous).toEqual({
      current: { startIndex: 0, pageSize: 10 },
      history: [],
    });
  });

  test("explains how to return when a page has no tasks", () => {
    const output = formatResumeSessionList({
      adapter: "codex",
      candidates: [],
      page: 3,
    });

    expect(output).toBe("没有更多任务。\n发送“上一页”返回。");
  });
});

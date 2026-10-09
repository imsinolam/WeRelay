import { expect, test } from "bun:test";

import {
  isGeneratedTaskTitle,
  latestUserMessageText,
  titleFromLatestMessage,
} from "../../src/bridge/task-title-fallback.ts";

test("replaces only session-ID placeholder titles, not real names", () => {
  const id = "01a0d152-0000-0000-0000-000000000000";
  expect(isGeneratedTaskTitle("Pi 任务 01a0d152", id)).toBe(true);
  expect(isGeneratedTaskTitle("DeepSeek 任务 01a0d152", id)).toBe(true);
  expect(isGeneratedTaskTitle("Grok 会话 01a0d152", id)).toBe(true);
  expect(isGeneratedTaskTitle("01a0d152", id)).toBe(true);
  expect(isGeneratedTaskTitle("CodeBuddy 会话 session-42", "session-42-long")).toBe(true);
  expect(isGeneratedTaskTitle("Pi 任务 deadbeef", id)).toBe(false);
  expect(isGeneratedTaskTitle("Pi 任务 01a0d152 的说明", id)).toBe(false);
  expect(titleFromLatestMessage("正式命名", id, "新消息")).toBe("正式命名");
  expect(titleFromLatestMessage("Pi 任务 01a0d152", id, "   ")).toBe("Pi 任务 01a0d152");
});

test("uses at most 20 Unicode characters from a recent message", () => {
  const title = titleFromLatestMessage(
    "会话 01a0d152",
    "01a0d152-0000",
    "  第一行\n第二行：请帮忙检查新版任务列表和标题显示  ",
  );
  expect(title).toBe("第一行 第二行：请帮忙检查新版任务列表和");
  expect(Array.from(title)).toHaveLength(20);
});

test("unnamed tasks use the last user input, not a newer AI response or tool result", () => {
  expect(latestUserMessageText([
    { role: "user", text: "较早问题" },
    { role: "assistant", text: "回复一" },
    { role: "user", text: "最近的用户问题" },
    { role: "task", text: "工具进度" },
    { role: "assistant", text: "**最新的 AI 答案**" },
  ])).toBe("最近的用户问题");
  expect(latestUserMessageText([{ role: "assistant", text: "只有 AI 回复" }])).toBeUndefined();
});

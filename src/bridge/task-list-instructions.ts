/** Shared WeChat task-list footer; keep terminal and aggregate lists consistent. */
export function formatTaskListInstructions(): string {
  return [
    "[3] 进入任务 3",
    "[3：内容] 进入任务 3 并发消息",
    "",
    "[任务：关键词] 搜索任务",
    "[下一页] 再看 10 条，可带数量如[下一页20]",
    "",
    "任务序号在下次发送 [任务] 前保持不变。",
    "中英文冒号均可，指令间可加空格。",
  ].join("\n");
}

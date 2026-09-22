/** Shared WeChat task-list footer; keep terminal and aggregate lists consistent. */
export function formatTaskListInstructions(): string {
  return [
    "[3] 进入任务 3",
    "[3：内容] 给任务3发消息",
    "",
    "[任务：关键词] 搜索任务",
    "[下一页] 再看 10 条，可带数量如[下一页20]",
    "",
    "任务序号在下次发送 [任务] 前保持不变。",
    "中英文冒号均可，指令间可加空格。",
  ].join("\n");
}

/** Separate presentation guidance from a known task-list formatter result. */
export function splitTaskListMessages(text: string): string[] {
  const footer = formatTaskListInstructions();
  const suffix = "\n\n" + footer;
  if (text.endsWith(suffix)) {
    return [text.slice(0, -suffix.length), footer];
  }
  // Search results have shorter guidance and may include a remaining-count line.
  const searchSuffix = /\n(回复序号进入；补充关键词可缩小范围(?:\n还有 \d+ 条，请补充关键词缩小范围。)?)$/u.exec(text);
  if (searchSuffix) return [text.slice(0, searchSuffix.index), searchSuffix[1]!];
  return [text];
}

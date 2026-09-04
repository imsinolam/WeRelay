const TASK_LIST_DISPLAY_TITLE_MAX_CHARS = 72;

function neutralizeLinkToken(value: string): string {
  return value
    .replace(/:/g, "：")
    .replace(/\//g, "／")
    .replace(/\\/g, "＼")
    .replace(/\./g, "．")
    .replace(/@/g, "＠");
}

export function formatTaskListDisplayTitle(
  value: string,
  maxChars = TASK_LIST_DISPLAY_TITLE_MAX_CHARS,
): string {
  const normalized = String(value || "")
    .replace(/\[([^\]\n]+)\]\([^\n)]+\)/g, "$1")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"'，。；！？、]+/gi, neutralizeLinkToken)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, neutralizeLinkToken)
    .replace(
      /(?:\/(?:Users|home|tmp|var|private|Volumes)\/|[A-Z]:[\\/])[^\s<>"'，。；！？、]+/gi,
      neutralizeLinkToken,
    )
    .replace(/\b[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+\b/gu, neutralizeLinkToken)
    .replace(/\s+/g, " ")
    .trim();
  const safeLimit = Math.max(1, Math.floor(maxChars));
  const characters = Array.from(normalized || "未命名任务");
  if (characters.length <= safeLimit) return characters.join("");
  return `${characters.slice(0, Math.max(1, safeLimit - 1)).join("").trimEnd()}…`;
}

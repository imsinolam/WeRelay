/** Shared by browser reconciliation and the persistent outbox; no DOM or IO. */
export function normalizeMobileMessageText(value: string, withImages = false): string {
  let text = String(value || "").replace(/\r\n?/g, "\n");
  if (withImages) {
    text = text
      .replace(/<system-reminder>\s*<image_resize_notice>[\s\S]*?<\/image_resize_notice>\s*<\/system-reminder>/gi, "")
      .replace(/(^|\n)\s*图片：\s*png\d+(?:\s+png\d+)*\s*(?=\n|$)/gi, "$1")
      .replace(/<\/?image\b[^>]*>/gi, "")
      .replace(/^\s*\[image\]\s*$/gim, "")
      .replace(/^\s*\[local image:[^\]]+\]\s*$/gim, "");
  }
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

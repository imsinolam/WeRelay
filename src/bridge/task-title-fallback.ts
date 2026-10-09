import type { BridgeSessionMessage } from "./bridge-types.ts";

const GENERATED_TITLE_PREFIX =
  /^(?:(?:Pi(?: Agent)?|DeepSeek(?: Harness)?|DSH|Grok(?: CLI)?|CodeBuddy|reasonix|Claude(?: Code)?|TClaude|WorkBuddy|OpenCode|Codex)\s+)?(?:任务|会话)\s+/iu;

export function isGeneratedTaskTitle(title: string, sessionId: string): boolean {
  const normalized = title.trim().replace(GENERATED_TITLE_PREFIX, "");
  if (!/^[a-z0-9_-]{6,64}$/iu.test(normalized)) return false;
  return sessionId.toLowerCase().startsWith(normalized.toLowerCase());
}

export function titleFromLatestMessage(
  title: string,
  sessionId: string,
  latestMessageText: string | undefined,
): string {
  if (!isGeneratedTaskTitle(title, sessionId) || !latestMessageText) return title;
  const text = latestMessageText.replace(/\s+/gu, " ").trim();
  return text ? Array.from(text).slice(0, 20).join("") : title;
}

export function latestUserMessageText(messages: readonly BridgeSessionMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && message.text.trim()) {
      return message.text;
    }
  }
  return undefined;
}

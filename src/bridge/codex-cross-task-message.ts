import type { BridgeSessionMessage } from "./bridge-types.ts";
import { sanitizeCodexVisibleAssistantMessageForDisplay } from "./bridge-utils.ts";

/** Only desktop-delivered task messages are public conversation events, not arbitrary tool output. */
export function extractCodexCrossTaskMessage(
  payload: Record<string, unknown>,
  timestamp: unknown,
): BridgeSessionMessage | null {
  if (payload.type !== "function_call_output" || payload.name !== "send_message_to_thread" ||
      (payload.namespace !== "codex_app" && payload.namespace !== "mcp__codex_app") ||
      typeof payload.output !== "string") return null;
  const match = /^\s*<codex_delegation>\s*<source_thread_id>\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>\s*$/i.exec(payload.output);
  if (!match) return null;
  const text = sanitizeCodexVisibleAssistantMessageForDisplay(match[2] ?? "");
  if (!text) return null;
  const metadata = payload.internal_chat_message_metadata_passthrough;
  const turnId = metadata && typeof metadata === "object" && "turn_id" in metadata &&
      typeof metadata.turn_id === "string" ? metadata.turn_id.trim() : "";
  const createdAtMs = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  return {
    // A separate role prevents external task text from becoming a user-send
    // receipt, an optimistic turn boundary, or this agent's final answer.
    role: "task",
    text,
    sourceTask: { adapter: "codex", sessionId: match[1]!.toLowerCase() },
    ...(typeof payload.id === "string" && payload.id.trim() ? { id: payload.id.trim() } : {}),
    ...(turnId ? { turnId } : {}),
    ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
  };
}

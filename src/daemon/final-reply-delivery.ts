import { createHash } from "node:crypto";
import { forwardWechatFinalReply } from "../bridge/bridge-final-reply.ts";
import type { BridgeAdapterKind, BridgeMessageImage } from "../bridge/bridge-types.ts";
import type { CompletionAttachment } from "./codex-completion-delivery.ts";

// Materialize the existing formatter's output without touching the network.
// The daemon persists this payload before attempting any of its sends.
export async function prepareFinalReplyDelivery(params: {
  adapter: BridgeAdapterKind;
  threadId: string;
  turnId?: string;
  timestamp: string;
  rawText: string;
  images?: BridgeMessageImage[];
  prefix: (text: string) => string;
}) {
  const texts: string[] = [];
  const attachments: CompletionAttachment[] = [];
  await forwardWechatFinalReply({
    adapter: params.adapter,
    rawText: params.rawText,
    images: params.images,
    sender: {
      sendText: async (text) => { texts.push(params.prefix(text)); },
      sendImage: async (path) => { attachments.push({ kind: "image", path }); },
      sendFile: async (path) => { attachments.push({ kind: "file", path }); },
      sendVoice: async (path) => { attachments.push({ kind: "voice", path }); },
      sendVideo: async (path) => { attachments.push({ kind: "video", path }); },
    },
  });
  const identity = [params.adapter, params.threadId, params.turnId ?? [params.timestamp, params.rawText]];
  return {
    key: `final:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`,
    adapter: params.adapter,
    threadId: params.threadId,
    turnId: params.turnId,
    completedAt: params.timestamp,
    // Media-only replies still need a completion record in the text-first queue.
    texts: texts.length ? texts : [params.prefix("任务已完成。")],
    attachments,
  };
}

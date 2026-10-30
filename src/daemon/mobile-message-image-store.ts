import fs from "node:fs";
import path from "node:path";

import type {
  BridgeMessageImage,
  BridgeSessionMessage,
} from "../bridge/bridge-types.ts";
import { ensureWorkspaceChannelDir } from "../wechat/channel-config.ts";
import { writePrivateFileAtomic } from "../utils/private-files.ts";
import { normalizeMobileMessageText } from "./mobile-message-text.ts";

const MOBILE_MESSAGE_IMAGE_STORE_VERSION = 1;
const MOBILE_MESSAGE_IMAGE_STORE_LIMIT = 500;

type StoredMobileMessageImage = {
  path: string;
  alt?: string;
};

type StoredMobileMessageImages = {
  id: string;
  adapter: string;
  threadId: string;
  turnId?: string;
  text: string;
  images: StoredMobileMessageImage[];
  createdAtMs: number;
};

type MobileMessageImageStoreState = {
  version: 1;
  records: StoredMobileMessageImages[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMessageText(text: string): string {
  return normalizeMobileMessageText(text, true)
    .replace(/```wechat-attachments[ \t]*\n[\s\S]*?\n```/gi, "")
    .replace(/!\[[^\]]*\]\(\s*(?:<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g, "")
    .replace(/<image\b[^>]*>/gi, "")
    .replace(/\[local image:\s*[^\]]+\]/gi, "")
    .replace(/^\s*\[image\]\s*$/gim, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseState(value: unknown): MobileMessageImageStoreState {
  if (!isRecord(value) || value.version !== MOBILE_MESSAGE_IMAGE_STORE_VERSION) {
    return { version: MOBILE_MESSAGE_IMAGE_STORE_VERSION, records: [] };
  }
  const records: StoredMobileMessageImages[] = [];
  for (const item of Array.isArray(value.records) ? value.records : []) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.adapter !== "string" ||
      typeof item.threadId !== "string" ||
      typeof item.text !== "string" ||
      !Number.isFinite(item.createdAtMs) ||
      !Array.isArray(item.images)
    ) continue;
    const images = item.images.flatMap((image): StoredMobileMessageImage[] => {
      if (!isRecord(image) || typeof image.path !== "string" || !image.path.trim()) return [];
      return [{
        path: image.path,
        ...(typeof image.alt === "string" && image.alt.trim() ? { alt: image.alt } : {}),
      }];
    });
    if (images.length === 0) continue;
    records.push({
      id: item.id,
      adapter: item.adapter,
      threadId: item.threadId,
      ...(typeof item.turnId === "string" && item.turnId.trim()
        ? { turnId: item.turnId }
        : {}),
      text: item.text,
      images,
      createdAtMs: Number(item.createdAtMs),
    });
  }
  return {
    version: MOBILE_MESSAGE_IMAGE_STORE_VERSION,
    records: records.slice(-MOBILE_MESSAGE_IMAGE_STORE_LIMIT),
  };
}

function localImages(record: StoredMobileMessageImages): BridgeMessageImage[] {
  return record.images.flatMap((image): BridgeMessageImage[] => {
    try {
      const stat = fs.statSync(image.path);
      if (!stat.isFile() || stat.size <= 0) return [];
    } catch {
      return [];
    }
    return [{
      source: "local",
      path: image.path,
      ...(image.alt ? { alt: image.alt } : {}),
    }];
  });
}

export class MobileMessageImageStore {
  private readonly stateFile: string;

  constructor(
    cwdOrOptions: string | { stateFile: string },
    options: { stateFile?: string } = {},
  ) {
    this.stateFile = options.stateFile
      ? options.stateFile
      : typeof cwdOrOptions === "string"
        ? path.join(
            ensureWorkspaceChannelDir(cwdOrOptions).workspaceDir,
            "mobile-message-images.json",
          )
        : cwdOrOptions.stateFile;
  }

  remember(params: {
    adapter: string;
    threadId: string;
    turnId?: string;
    text: string;
    images: StoredMobileMessageImage[];
    createdAtMs?: number;
  }): void {
    const images = params.images.filter((image) => image.path.trim());
    if (images.length === 0) return;
    const state = this.read();
    const createdAtMs = params.createdAtMs ?? Date.now();
    const record: StoredMobileMessageImages = {
      id: `${createdAtMs}-${Math.random().toString(36).slice(2)}`,
      adapter: params.adapter,
      threadId: params.threadId,
      ...(params.turnId?.trim() ? { turnId: params.turnId.trim() } : {}),
      text: params.text,
      images,
      createdAtMs,
    };
    if (record.turnId) {
      const existingIndex = state.records.findIndex((candidate) =>
        candidate.adapter === record.adapter &&
        candidate.threadId === record.threadId &&
        candidate.turnId === record.turnId
      );
      if (existingIndex >= 0) state.records.splice(existingIndex, 1);
    }
    state.records.push(record);
    state.records = state.records.slice(-MOBILE_MESSAGE_IMAGE_STORE_LIMIT);
    this.write(state);
  }

  enrich(
    messages: BridgeSessionMessage[],
    options: { adapter: string; threadId: string; requireTurnMatch?: boolean },
  ): BridgeSessionMessage[] {
    const scoped = this.read().records.filter((record) =>
      record.adapter === options.adapter && record.threadId === options.threadId
    );
    if (scoped.length === 0) return messages;

    const used = new Set<number>();
    const enriched = messages.map((message) => ({ ...message }));
    for (let messageIndex = enriched.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = enriched[messageIndex]!;
      if (message.role !== "user") continue;
      const normalizedText = normalizeMessageText(message.text);
      let recordIndex = -1;
      if (message.turnId) {
        for (let index = scoped.length - 1; index >= 0; index -= 1) {
          if (!used.has(index) && scoped[index]?.turnId === message.turnId &&
              normalizeMessageText(scoped[index]!.text) === normalizedText) {
            recordIndex = index;
            break;
          }
        }
      }
      if (recordIndex < 0 && !options.requireTurnMatch) {
        for (let index = scoped.length - 1; index >= 0; index -= 1) {
          if (used.has(index)) continue;
          if (message.turnId && scoped[index]!.turnId && message.turnId !== scoped[index]!.turnId) continue;
          const candidateText = normalizeMessageText(scoped[index]!.text);
          if (
            normalizedText === candidateText ||
            (candidateText && normalizedText.endsWith(candidateText))
          ) {
            recordIndex = index;
            break;
          }
        }
      }
      if (recordIndex < 0) continue;
      const images = localImages(scoped[recordIndex]!);
      if (images.length === 0) continue;
      used.add(recordIndex);
      enriched[messageIndex] = { ...message, images };
    }
    return enriched;
  }

  private read(): MobileMessageImageStoreState {
    try {
      return parseState(JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as unknown);
    } catch {
      return { version: MOBILE_MESSAGE_IMAGE_STORE_VERSION, records: [] };
    }
  }

  private write(state: MobileMessageImageStoreState): void {
    writePrivateFileAtomic(this.stateFile, `${JSON.stringify(state)}\n`);
  }
}

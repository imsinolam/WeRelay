import net from "node:net";
import { randomUUID } from "node:crypto";
import type { PiOwnerAdvertisement } from "./pi-owner-discovery.ts";
import type { BridgeSessionComposerDraft } from "./bridge-types.ts";

/** Short-lived read against an existing owner; never selects/starts a session. */
export function readPiOwnerDraft(owner: PiOwnerAdvertisement): Promise<BridgeSessionComposerDraft> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = net.createConnection(owner.socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let resultDraft: BridgeSessionComposerDraft | undefined;
    const release = (draft: BridgeSessionComposerDraft) => {
      resultDraft = draft;
      socket.write(JSON.stringify({ type: "release", id: id + "-release", token: owner.token, sessionId: owner.sessionId }) + "\n");
    };
    const finish = (error?: Error, draft?: BridgeSessionComposerDraft) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(draft ?? { supported: false, draft: null });
    };
    const timer = setTimeout(() => finish(new Error("Pi 原窗口草稿暂时无法读取。")), 2_000);
    socket.once("error", () => finish(new Error("Pi 原窗口草稿连接不可用。")));
    socket.once("close", () => finish(new Error("Pi 原窗口草稿连接已关闭。")));
    socket.once("connect", () => socket.write(JSON.stringify({ type: "hello", token: owner.token }) + "\n"));
    socket.on("data", (data: string) => {
      buffer += data;
      if (buffer.length > 1024 * 1024) { finish(new Error("Pi 草稿超过安全读取上限，未截断导入。")); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const result = JSON.parse(line);
          if (result.token !== owner.token) { finish(new Error("Pi 草稿来源验证失败。")); return; }
          if (result.type === "ready") {
            if (result.sessionId !== owner.sessionId) { finish(new Error("Pi 原窗口任务已切换。")); return; }
            socket.write(JSON.stringify({ type: "composer_draft", id, token: owner.token, sessionId: owner.sessionId }) + "\n");
          } else if (result.type === "response" && result.id === id) {
            if (!result.ok) {
              if (/Unsupported Pi owner request/.test(String(result.error))) release({ supported: false, draft: null });
              else finish(new Error("Pi 原窗口暂未提供草稿。"));
            } else release(result.composerDraft ?? { supported: false, draft: null });
          } else if (result.type === "response" && result.id === id + "-release" && resultDraft) {
            finish(undefined, resultDraft);
            return;
          }
        } catch { finish(new Error("Pi 草稿格式暂不支持。")); return; }
      }
    });
  });
}

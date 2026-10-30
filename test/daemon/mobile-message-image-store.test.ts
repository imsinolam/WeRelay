import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MobileMessageImageStore } from "../../src/daemon/mobile-message-image-store.ts";

describe("MobileMessageImageStore", () => {
  test("persists web input images and restores them onto the matching user message", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-mobile-input-images-"));
    const stateFile = path.join(directory, "mobile-message-images.json");
    const imagePath = path.join(directory, "input.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const store = new MobileMessageImageStore("/tmp/project", { stateFile });
      store.remember({
        adapter: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "看看这张图",
        images: [{ path: imagePath, alt: "设计稿.png" }],
      });

      const restored = new MobileMessageImageStore("/tmp/project", { stateFile });
      if (process.platform !== "win32") {
        expect(fs.statSync(path.dirname(stateFile)).mode & 0o777).toBe(0o700);
        expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);
      }
      expect(restored.enrich([
        { role: "user", text: "看看这张图\n[image]", turnId: "turn-1" },
        { role: "assistant", text: "收到" },
      ], { adapter: "codex", threadId: "thread-1" })).toEqual([
        {
          role: "user",
          text: "看看这张图\n[image]",
          turnId: "turn-1",
          images: [{ source: "local", path: imagePath, alt: "设计稿.png" }],
        },
        { role: "assistant", text: "收到" },
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses the stored web originals instead of merging duplicate native input images", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-mobile-input-images-"));
    const stateFile = path.join(directory, "mobile-message-images.json");
    const originalPath = path.join(directory, "original.jpg");
    const nativePath = path.join(directory, "native-converted.jpg");
    fs.writeFileSync(originalPath, "original-image-bytes");
    fs.writeFileSync(nativePath, "converted-image-bytes");
    try {
      const store = new MobileMessageImageStore("/tmp/project", { stateFile });
      store.remember({
        adapter: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
        text: "这种连续审批应该怎么做",
        images: [{ path: originalPath, alt: "审批截图.jpg" }],
      });

      expect(store.enrich([{
        role: "user",
        text: "这种连续审批应该怎么做\n[image]",
        turnId: "turn-1",
        images: [{ source: "local", path: nativePath, alt: "输入图片 1" }],
      }], { adapter: "codex", threadId: "thread-1" })).toEqual([{
        role: "user",
        text: "这种连续审批应该怎么做\n[image]",
        turnId: "turn-1",
        images: [{ source: "local", path: originalPath, alt: "审批截图.jpg" }],
      }]);
      const wrapped = "图片：png1\n这种连续审批应该怎么做\n[image]\n</image>";
      expect(store.enrich([
        { role: "user", text: wrapped, turnId: "turn-1" },
        { role: "user", text: "这种连续审批应该怎么做", turnId: "different-turn" },
      ], { adapter: "codex", threadId: "thread-1" }).map(message => message.images)).toEqual([
        [{ source: "local", path: originalPath, alt: "审批截图.jpg" }], undefined,
      ]);
      expect(store.enrich([
        { role: "user", text: "另一个引导消息", turnId: "turn-1" },
        { role: "user", text: wrapped },
      ], { adapter: "codex", threadId: "thread-1", requireTurnMatch: true }).map(message => message.images)).toEqual([undefined, undefined]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("matches repeated image-only inputs from newest to oldest without crossing threads", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-mobile-input-images-"));
    const stateFile = path.join(directory, "mobile-message-images.json");
    const firstPath = path.join(directory, "first.jpg");
    const secondPath = path.join(directory, "second.jpg");
    fs.writeFileSync(firstPath, "first");
    fs.writeFileSync(secondPath, "second");
    try {
      const store = new MobileMessageImageStore("/tmp/project", { stateFile });
      store.remember({
        adapter: "grok",
        threadId: "thread-1",
        text: "",
        images: [{ path: firstPath, alt: "first.jpg" }],
        createdAtMs: 1,
      });
      store.remember({
        adapter: "grok",
        threadId: "thread-1",
        text: "",
        images: [{ path: secondPath, alt: "second.jpg" }],
        createdAtMs: 2,
      });

      expect(store.enrich([
        { role: "user", text: "[image]" },
        { role: "assistant", text: "一" },
        { role: "user", text: "[image]" },
      ], { adapter: "grok", threadId: "thread-1" }).map((message) => message.images)).toEqual([
        [{ source: "local", path: firstPath, alt: "first.jpg" }],
        undefined,
        [{ source: "local", path: secondPath, alt: "second.jpg" }],
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

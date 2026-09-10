import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import {
  CodexCompletionDeliveryQueue,
  type CodexCompletionDeliveryState,
} from "../../src/daemon/codex-completion-delivery.ts";

describe("mobile recovery with durable WeChat completion delivery", () => {
  test("survives text rejection and image rejection without repeating acknowledged pieces or changing task", async () => {
    let persisted: CodexCompletionDeliveryState = {pending: [], delivered: []};
    const now = Date.now();
    const makeQueue = () => new CodexCompletionDeliveryQueue({
      initial: persisted, now: () => now,
      persist: (value) => { persisted = structuredClone(value); },
    });
    const first = makeQueue();
    first.enqueue({key: "original:turn", threadId: "original", turnId: "turn", texts: ["结论", "任务链接"], images: ["/tmp/first.png", "/tmp/second.png"]});
    await expect(first.deliver("original:turn", async (_delivery, texts, checkpoint) => {
      expect(texts).toEqual(["结论", "任务链接"]);
      checkpoint();
      throw new Error("context rejected after first acknowledged text");
    })).rejects.toThrow("context rejected");
    expect(persisted.pending[0]?.nextTextIndex).toBe(1);
    expect(first.hasDelivered("original:turn")).toBe(false);

    const second = makeQueue();
    const imageAttempts: string[] = [];
    const partial = await second.deliver("original:turn", async (delivery, texts, checkpoint) => {
      expect(delivery.threadId).toBe("original");
      expect(delivery.turnId).toBe("turn");
      expect(texts).toEqual(["任务链接"]);
      checkpoint();
      return 1;
    }, async (delivery, image) => {
      expect(delivery.threadId).toBe("original");
      imageAttempts.push(image);
      if (image.endsWith("second.png")) throw new Error("image send rejected");
    });
    expect(partial.status).toBe("pending");
    expect(persisted.pending[0]).toMatchObject({nextTextIndex: 2, nextImageIndex: 1});
    expect(second.acknowledge(["original:turn"])).toEqual([]);
    expect(second.hasDelivered("original:turn")).toBe(false);

    const third = makeQueue();
    const done = await third.deliver("original:turn", async () => {
      throw new Error("acknowledged text must not repeat");
    }, async (delivery, image) => {
      expect(delivery.threadId).toBe("original");
      imageAttempts.push(image);
    });
    expect(done.status).toBe("delivered");
    expect(imageAttempts).toEqual(["/tmp/first.png", "/tmp/second.png", "/tmp/second.png"]);
    expect(persisted.pending).toEqual([]);
    expect(persisted.delivered).toHaveLength(1);
    const replay = await third.deliver("original:turn", async () => {
      throw new Error("completed turn must not replay");
    }, async () => { throw new Error("completed images must not replay"); });
    expect(replay.status).toBe("delivered");
  });

  test("Codex completion has exactly one image owner and no post-success attachment scan", () => {
    const source = fs.readFileSync(new URL("../../src/daemon/werelay-daemon.ts", import.meta.url), "utf8");
    const start = source.indexOf("  private async sendCodexTaskCompletionMessage(");
    const end = source.indexOf("  private async collectFinalReplyImages(", start);
    expect(start).toBeGreaterThan(0);
    const block = source.slice(start, end);
    expect(block.match(/collectAssistantMessageImages\(/g)).toHaveLength(1);
    expect(block).toContain("images: completionImages");
    expect(block.indexOf("images: completionImages")).toBeLessThan(block.indexOf("await this.deliverCodexCompletionNotification("));
    expect(block).not.toContain("forwardWechatFinalReply(");
    expect(block).not.toContain("sendWechatGeneratedImage(");
    expect(block).not.toContain("sendFile(");
    expect(block.indexOf('deliveryResult.status !== "delivered"')).toBeLessThan(block.indexOf("codex_completion_sent:"));
  });
});

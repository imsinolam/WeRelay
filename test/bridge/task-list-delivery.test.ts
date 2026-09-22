import { expect, test } from "bun:test";
import fs from "node:fs";
import { ContextSendGuard } from "../../src/wechat/context-send-guard.ts";
import { splitTaskListMessages, formatTaskListInstructions } from "../../src/bridge/task-list-instructions.ts";
import { sendWechatTextBatch } from "../../src/wechat/wechat-text-batch.ts";
import { splitWechatTextIntoChunks, formatResumeSessionList, formatResumeSessionSearchResults } from "../../src/bridge/bridge-utils.ts";
import { buildGlobalTaskSnapshot, formatGlobalTaskList, formatGlobalTaskSearchResults } from "../../src/daemon/global-task-index.ts";

const candidates = [
  { adapter: "deepseek" as const, sessionId: "same", title: "较新任务", lastUpdatedAt: "2026-09-14T12:14:09Z" },
  { adapter: "grok" as const, sessionId: "same", title: "旧任务", lastUpdatedAt: "2026-09-03T12:00:00Z" },
];
const snapshot = buildGlobalTaskSnapshot(candidates);

test("all and filtered pages send the instructions separately without changing identities or numbers", () => {
  for (const adapter of [undefined, "deepseek", "grok"] as const) {
    const text = formatGlobalTaskList({ snapshot, adapter, startIndex: 0, pageSize: 10 });
    const parts = splitTaskListMessages(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).not.toContain("[3] 进入任务");
    expect(parts[1]).toBe(formatTaskListInstructions());
    expect(parts.join("\n\n")).toBe(text);
    if (adapter === "grok") expect(parts[0]).toContain("2. ");
    if (!adapter) expect(parts[0]!.indexOf("较新任务")).toBeLessThan(parts[0]!.indexOf("旧任务"));
  }
  const nextPage = splitTaskListMessages(formatGlobalTaskList({ snapshot, startIndex: 1, pageSize: 1 }));
  expect(nextPage[0]).toContain("2. ");
  expect(nextPage[1]).toBe(formatTaskListInstructions());
});

test("legacy terminal pages split the footer, but empty/end pages do not send instructions", () => {
  for (const adapter of ["codex", "workbuddy", "deepseek", "grok"] as const) {
    const parts = splitTaskListMessages(formatResumeSessionList({ adapter, candidates, startIndex: 10 }));
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("11. ");
    expect(parts[1]).toBe(formatTaskListInstructions());
    for (const startIndex of [0, 10]) {
      const empty = formatResumeSessionList({ adapter, candidates: [], startIndex });
      expect(splitTaskListMessages(empty)).toEqual([empty]);
    }
  }
  const end = formatGlobalTaskList({ snapshot, startIndex: 99, pageSize: 10 });
  expect(splitTaskListMessages(end)).toEqual([end]);
});

test("search instructions also form a separate message, including remaining-count guidance", () => {
  const texts = [
    formatGlobalTaskSearchResults({ snapshot, matches: candidates, target: "任务" }),
    formatResumeSessionSearchResults({ target: "任务", matches: candidates.map((candidate, index) => ({ candidate, index, score: 1 })), limit: 1 }),
  ];
  for (const text of texts) {
    const parts = splitTaskListMessages(text);
    expect(parts).toHaveLength(2);
    expect(parts[0]).not.toContain("回复序号进入");
    expect(parts[1]).toStartWith("回复序号进入；补充关键词可缩小范围");
  }
});

test("only a formatter suffix is separated; title content and failed-search prefix are preserved", () => {
  const text = "没有找到任务\n\n1. 示例\n\n" + formatTaskListInstructions();
  expect(splitTaskListMessages(text)).toEqual(["没有找到任务\n\n1. 示例", formatTaskListInstructions()]);
  const body = "1. 标题提到了[3] 进入任务 3";
  expect(splitTaskListMessages(body)).toEqual([body]);
});

test("batch sends body before guidance and stops on zero/partial failure", async () => {
  for (const failAt of [0, 1, 2]) {
    const calls: string[] = [];
    const sent = await sendWechatTextBatch(["列表", "说明"], async (text) => {
      calls.push(text);
      await Promise.resolve();
      return calls.length - 1 !== failAt;
    });
    expect(sent).toBe(failAt);
    expect(calls).toEqual(failAt === 0 ? ["列表"] : ["列表", "说明"]);
  }
  const calls: string[] = [];
  await expect(sendWechatTextBatch(["列表", "说明"], async (text) => { calls.push(text); throw new Error("offline"); })).rejects.toThrow("offline");
  expect(calls).toEqual(["列表"]);
});

test("both runtime send paths queue task-list batches rather than sending combined text", () => {
  for (const file of ["src/daemon/werelay-daemon.ts", "src/bridge/werelay-bridge.ts"]) {
    const source = fs.readFileSync(file, "utf8");
    expect(source.includes("splitTaskListMessages(text)")).toBe(true);
    expect(source.includes("sendWechatTextBatch(")).toBe(true);
    expect(/(?:this\.)?queueWechatMessage\(\s*message.senderId,\s*format(?:GlobalTask|ResumeSession)List\(/.test(source)).toBe(false);
  }
});


test("long list chunks finish before the single guidance message; partial retry never replays the list", async () => {
  const body = Array.from({ length: 50 }, (_, i) => `${i + 1}. 示例任务${"正文".repeat(30)}`).join("\n");
  const parts = splitTaskListMessages(body + "\n\n" + formatTaskListInstructions())
    .flatMap((part) => splitWechatTextIntoChunks(part));
  expect(parts.length).toBeGreaterThan(2);
  expect(parts.every((part) => part.length <= 1200)).toBe(true);
  expect(parts.at(-1)).toBe(formatTaskListInstructions());
  let token = "old";
  const guard = new ContextSendGuard();
  const calls: string[] = [];
  const sendNow = async (part: string) => {
    await guard.send({
      recipient: "synthetic-recipient", requestKey: part,
      getToken: () => token, isExplicitRejection: (error) => error === denied,
      send: async (currentToken) => {
        calls.push(part);
        if (part === formatTaskListInstructions() && currentToken === "old") {
          token = "new";
          throw denied;
        }
      },
    });
    return true;
  };
  const denied = new Error("prepare failed");
  expect(await sendWechatTextBatch(parts, sendNow)).toBe(parts.length);
  expect(calls).toEqual([...parts, formatTaskListInstructions()]);
});

test("stale context before body stops the batch without sending a misleading footer", async () => {
  const calls: string[] = [];
  const guard = new ContextSendGuard();
  const denied = new Error("prepare failed");
  const sent = await sendWechatTextBatch(["列表", "说明"], async (part) => {
    try {
      await guard.send({ recipient: "synthetic", requestKey: part, getToken: () => "old",
        isExplicitRejection: (error) => error === denied,
        send: async () => { calls.push(part); throw denied; },
      });
      return true;
    } catch { return false; }
  });
  expect(sent).toBe(0);
  expect(calls).toEqual(["列表"]);
});

import { expect, test } from "bun:test";
import { WeRelayDaemon } from "../../src/daemon/werelay-daemon.ts";
import {
  buildGlobalTaskSnapshot,
  type GlobalTaskCandidate,
} from "../../src/daemon/global-task-index.ts";
import { formatTaskListInstructions } from "../../src/bridge/task-list-instructions.ts";
import { WeRelayRelayTaskLinkClient } from "../../src/relay/relay-task-links.ts";

function task(
  adapter: GlobalTaskCandidate["adapter"],
  sessionId: string,
  lastUpdatedAt: string,
  title = "示例任务",
): GlobalTaskCandidate {
  return { adapter, sessionId, title, lastUpdatedAt };
}

const tasks = [
  task("codex", "shared", "2026-10-28T03:00:00Z"),
  task("pi", "shared", "2026-10-28T02:00:00Z"),
  task("pi", "older-pi", "2026-10-28T01:00:00Z"),
];

const boardUrl = "https://relay.example/b";

function fixture(candidates = tasks, mobileEnabled = true) {
  candidates = candidates.map((candidate) => ({ ...candidate }));
  const sent: string[] = [];
  const links: string[] = [];
  const daemon = Object.assign(Object.create(WeRelayDaemon.prototype), {
    globalTaskListSnapshot: buildGlobalTaskSnapshot(candidates),
    globalTaskAdapterFilter: null,
    globalTaskListPosition: { startIndex: 0, pageSize: 15 },
    globalTaskListHistory: [],
    getActiveSlot: () => null,
    listWechatGlobalTaskCandidates: async () => candidates,
    activateExactGlobalTask: async () => { throw new Error("listing must not activate a task"); },
    codexMobileServer: mobileEnabled ? {
      buildBoardUrl() {
        links.push("board");
        return boardUrl;
      },
      buildTaskUrl() { throw new Error("task lists must not build a task-specific URL"); },
    } : undefined,
    queueWechatMessage: async (_sender: string, text: string) => { sent.push(text); return true; },
    queueWechatTextAction: async (operation: () => Promise<unknown>) => operation(),
    sendWechatMessageNow: async (_sender: string, text: string) => { sent.push(text); return true; },
    remindClawbotBacklogAfterTaskList: async () => {},
  });
  return { daemon, sent, links };
}

function expectListLink(sent: string[], url: string) {
  expect(sent).toHaveLength(2);
  expect(sent[0]).toEndWith(`\n\n${url}`);
  expect(sent[0]).not.toContain("```");
  expect(sent[1]).toBe(formatTaskListInstructions());
  expect(sent.join("\n").split(url)).toHaveLength(2);
  expect(sent[1]).not.toContain("https://");
}

test("the aggregate list ends with one board entry, not an individual task", async () => {
  const { daemon, sent, links } = fixture();
  await daemon.handleGlobalTaskCommand({ senderId: "u" }, { type: "resume", preserveTaskSnapshot: true });
  expectListLink(sent, boardUrl);
  expect(links).toEqual(["board"]);
});

test("filtered lists preserve global numbers and open the unfiltered board", async () => {
  const { daemon, sent, links } = fixture();
  await daemon.handleGlobalTaskCommand({ senderId: "u" }, {
    type: "resume", preserveTaskSnapshot: true,
  }, { adapterFilter: "pi" });
  expectListLink(sent, boardUrl);
  expect(sent[0]).toContain("2、[Pi]");
  expect(sent[0]).toContain("3、[Pi]");
  expect(links).toEqual(["board"]);
});

test("pagination uses the same board entry without selecting a task", async () => {
  const { daemon, sent, links } = fixture();
  await daemon.handleGlobalTaskCommand({ senderId: "u" }, {
    type: "resume", preserveTaskSnapshot: true,
    taskListPosition: { startIndex: 2, pageSize: 1 },
  });
  expectListLink(sent, boardUrl);
  expect(sent[0]).toContain("3、[Pi]");
  expect(links).toEqual(["board"]);
});

test("board entry does not depend on recency or stable-number ordering", async () => {
  const { daemon, sent } = fixture();
  // Stable numbering can keep an updated task below an older first entry.
  daemon.globalTaskListSnapshot.candidates[2].lastUpdatedAt = "2026-10-28T04:00:00Z";
  await daemon.handleGlobalTaskCommand({ senderId: "u" }, { type: "resume", preserveTaskSnapshot: true });
  expectListLink(sent, boardUrl);
  expect(sent[0]!.indexOf("1、[Codex]")).toBeLessThan(sent[0]!.indexOf("3、[Pi]"));
});

test("search results carry one link while their short instructions remain a separate message", async () => {
  const { daemon, sent, links } = fixture();
  await daemon.handleGlobalTaskCommand({ senderId: "u" }, { type: "resume", target: "示例" });
  expect(sent).toHaveLength(2);
  expect(sent[0]).toEndWith(`\n\n${boardUrl}`);
  expect(sent[1]).toBe("回复序号进入；补充关键词可缩小范围");
  expect(links).toEqual(["board"]);
});

test("empty, end-of-list and failed searches do not invent a task link", async () => {
  for (const mode of ["empty", "end", "miss"] as const) {
    const { daemon, sent, links } = fixture(mode === "empty" ? [] : tasks);
    await daemon.handleGlobalTaskCommand({ senderId: "u" }, {
      type: "resume", preserveTaskSnapshot: true,
      ...(mode === "end" ? { taskListPosition: { startIndex: 99, pageSize: 15 } } : {}),
      ...(mode === "miss" ? { target: "不存在的关键词" } : {}),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("https://");
    expect(links).toEqual([]);
  }
});

test("lists remain available when the mobile task web is disabled", async () => {
  const { daemon, sent, links } = fixture(tasks, false);
  await daemon.handleGlobalTaskCommand({ senderId: "u" }, { type: "resume", preserveTaskSnapshot: true });
  expect(sent).toHaveLength(2);
  expect(sent[0]).toContain("1、[Codex]");
  expect(sent[0]).not.toContain("https://");
  expect(sent[1]).toBe(formatTaskListInstructions());
  expect(links).toEqual([]);
});

test("long lists keep the link after all entries and before the standalone guide", async () => {
  const candidates = Array.from({ length: 40 }, (_, index) => task(
    "deepseek", `d${index}`, new Date(Date.parse("2026-10-28T03:00:00Z") - index * 1000).toISOString(),
    "示例任务".repeat(20),
  ));
  const { daemon, sent, links } = fixture(candidates);
  await daemon.handleGlobalTaskCommand({ senderId: "u" }, {
    type: "resume", preserveTaskSnapshot: true, pageSize: 40,
  });
  expect(sent.length).toBeGreaterThan(2);
  expect(sent.every((part) => part.length <= 1200)).toBe(true);
  expect(sent.at(-2)).toEndWith(`\n\n${boardUrl}`);
  expect(sent.at(-1)).toBe(formatTaskListInstructions());
  expect(sent.join("\n").split(boardUrl)).toHaveLength(2);
  expect(links).toEqual(["board"]);
});

test("board entry needs no task-link registration, even when registration is offline", async () => {
  const { daemon, sent } = fixture();
  let registrations = 0;
  const client = new WeRelayRelayTaskLinkClient({
    relayUrl: "https://relay.example", deviceId: "fixture-device", deviceToken: "fixture-secret",
    fetchImpl: async () => { registrations++; throw new Error("offline"); },
  });
  daemon.deskRelayRelayTaskLinks = client;
  try {
    await daemon.handleGlobalTaskCommand({ senderId: "u" }, { type: "resume", preserveTaskSnapshot: true }, {
      adapterFilter: "pi",
    });
    expect(registrations).toBe(0);
    expectListLink(sent, boardUrl);
    expect(sent[0]).not.toContain("/t/");
  } finally {
    await client.close();
  }
});

test("partial delivery of a linked list still stops the batch and never announces backlog", async () => {
  for (const failAt of [0, 1]) {
    const { daemon, sent } = fixture();
    let attempts = 0;
    let backlogReminders = 0;
    daemon.sendWechatMessageNow = async (_sender: string, text: string) => {
      if (attempts++ === failAt) return false;
      sent.push(text);
      return true;
    };
    daemon.remindClawbotBacklogAfterTaskList = async () => { backlogReminders++; };
    await daemon.handleGlobalTaskCommand({ senderId: "u" }, { type: "resume", preserveTaskSnapshot: true });
    expect(sent).toHaveLength(failAt);
    expect(attempts).toBe(failAt + 1);
    expect(backlogReminders).toBe(0);
    if (failAt === 1) expect(sent[0]).toEndWith(`\n\n${boardUrl}`);
  }
});

test("legacy terminal lists and search results use the same task-web entry without activating a task", async () => {
  for (const search of [false, true]) {
    const { daemon, sent, links } = fixture();
    const candidates = tasks.filter((candidate) => candidate.adapter === "pi");
    const slot = {
      adapter: "pi", taskListSnapshot: {
        candidates, numberByThreadId: new Map([["shared", 2], ["older-pi", 3]]),
      },
      runtime: { getState: () => ({ status: "idle" }) },
    };
    await daemon.handleSystemCommand({ senderId: "u" }, slot, {
      type: "resume", preserveTaskSnapshot: true, ...(search ? { target: "示例" } : {}),
    });
    expect(sent[0]).toEndWith(`\n\n${boardUrl}`);
    expect(sent).toHaveLength(2);
    expect(links).toEqual(["board"]);
  }
});

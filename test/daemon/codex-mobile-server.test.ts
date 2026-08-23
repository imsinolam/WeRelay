import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexMobileAuthStore } from "../../src/daemon/codex-mobile-auth.ts";
import {
  CODEX_MOBILE_CSS,
  CODEX_MOBILE_HTML,
  CODEX_MOBILE_JS,
} from "../../src/daemon/codex-mobile-web.ts";
import { DaemonWorkspaceStateStore } from "../../src/daemon/daemon-state.ts";
import {
  CODEX_MOBILE_ASSET_VERSION,
  createCodexMobileTranscriptRevision,
  decodeCodexMobileTaskShortCode,
  encodeCodexMobileTaskShortCode,
  MobileAdapterUnavailableError,
  paginateCodexMobileMessages,
  resolveCodexMobileListenHost,
  resolvePreferredLanAddress,
  startCodexMobileServer,
} from "../../src/daemon/codex-mobile-server.ts";

describe("mobile cache freshness", () => {
  test("builds a stable lightweight revision and changes it for visible updates", () => {
    const transcript = {
      threadId: "thread-1",
      messages: [
        { role: "user" as const, text: "请检查缓存" },
        { role: "assistant" as const, text: "正在检查", turnId: "turn-1" },
      ],
      progressItems: [
        {
          id: "progress-1",
          turnId: "turn-1",
          kind: "command" as const,
          status: "running" as const,
          text: "读取最新状态",
        },
      ],
      queuedMessages: [],
      runSummary: {
        turnId: "turn-1",
        status: "running" as const,
        startedAtMs: 1_786_796_400_000,
      },
      pendingApproval: null,
      approvalResults: [],
    };

    const revision = createCodexMobileTranscriptRevision(transcript);
    expect(revision).toHaveLength(16);
    expect(createCodexMobileTranscriptRevision(structuredClone(transcript))).toBe(revision);
    expect(createCodexMobileTranscriptRevision({
      ...transcript,
      runSummary: { ...transcript.runSummary, durationMs: 9_999 },
    })).toBe(revision);
    expect(createCodexMobileTranscriptRevision({
      ...transcript,
      messages: transcript.messages.concat({
        role: "assistant",
        text: "已完成同步",
        turnId: "turn-1",
      }),
    })).not.toBe(revision);
    expect(createCodexMobileTranscriptRevision({
      ...transcript,
      progressItems: transcript.progressItems.map((item) => ({
        ...item,
        status: "completed" as const,
      })),
    })).not.toBe(revision);
  });

  test("validates cached content with a tiny revision request before loading messages", () => {
    expect(CODEX_MOBILE_HTML).toContain('id="cache-sync-indicator"');
    expect(CODEX_MOBILE_CSS).toContain(".cache-sync-indicator");
    expect(CODEX_MOBILE_JS).toContain("async function refreshMessagesIfChanged");
    expect(CODEX_MOBILE_JS).toContain('"/sync-state?known="');
    expect(CODEX_MOBILE_JS).toContain('setCacheSyncState("checking")');
    expect(CODEX_MOBILE_JS).toContain('setCacheSyncState("updating")');
    expect(CODEX_MOBILE_JS).toContain('setCacheSyncState("current")');
    expect(CODEX_MOBILE_JS).toContain("if (!payload.changed)");
    expect(CODEX_MOBILE_JS).toContain("var refreshed = await loadMessages(forceBottom, false, false);");
    expect(CODEX_MOBILE_JS).toContain('if (!refreshed) setCacheSyncState("idle");');
    expect(CODEX_MOBILE_JS).toContain("var resumedCachedPreview = state.cachePreviewMode;");
    expect(CODEX_MOBILE_JS).toContain(
      "var shouldValidateCachedContent = Boolean(resumedCachedPreview || restoredCache);",
    );
  });

  test("returns unchanged from the lightweight endpoint when the cached revision matches", async () => {
    const authStore = createAuthStore("cache freshness password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    let answer = "缓存内容";
    const reads: Array<{ limit?: number; lightweight?: boolean }> = [];
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [],
      readMessages: async (threadId, options) => {
        reads.push({ limit: options?.limit, lightweight: options?.lightweight });
        return {
          threadId,
          messages: [{ role: "assistant", text: answer, turnId: "turn-1" }],
          queuedMessages: [],
          progressItems: [],
          runSummary: { turnId: "turn-1", status: "completed" },
        };
      },
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const headers = { cookie: sessionCookie };
      const fullResponse = await fetch(`${root}/api/tasks/thread-1/messages`, { headers });
      const full = await fullResponse.json() as { revision: string };
      const currentResponse = await fetch(
        `${root}/api/tasks/thread-1/sync-state?known=${full.revision}`,
        { headers },
      );
      expect(await currentResponse.json()).toEqual({
        threadId: "thread-1",
        revision: full.revision,
        changed: false,
      });
      expect(reads.at(-1)).toEqual({ limit: 1, lightweight: true });

      answer = "电脑端已有新内容";
      const changedResponse = await fetch(
        `${root}/api/tasks/thread-1/sync-state?known=${full.revision}`,
        { headers },
      );
      const changed = await changedResponse.json() as {
        revision: string;
        changed: boolean;
      };
      expect(changed.changed).toBe(true);
      expect(changed.revision).not.toBe(full.revision);
    } finally {
      await server.close();
    }
  });

  test("allows only device-authenticated read-only Relay prewarming", async () => {
    const authStore = createAuthStore("relay prewarm password");
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      relayPrewarmToken: "relay-prewarm-secret",
      authStore,
      listTasks: async () => [{
        threadId: "thread-1",
        title: "预热任务",
        status: "idle",
      }],
      readMessages: async (threadId) => ({
        threadId,
        messages: [{ role: "assistant", text: "预热详情" }],
        queuedMessages: [],
      }),
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const prewarmHeaders = {
        "x-werelay-relay": "1",
        "x-werelay-relay-prewarm": "relay-prewarm-secret",
      };
      expect((await fetch(`${root}/api/tasks`, { headers: prewarmHeaders })).status).toBe(200);
      expect((await fetch(`${root}/api/tasks/thread-1/messages`, {
        headers: prewarmHeaders,
      })).status).toBe(200);
      expect((await fetch(`${root}/api/tasks`, {
        headers: {
          ...prewarmHeaders,
          "x-werelay-relay-prewarm": "wrong-secret",
        },
      })).status).toBe(401);
      expect((await fetch(`${root}/api/tasks/thread-1/messages?before=older`, {
        headers: prewarmHeaders,
      })).status).toBe(401);
      expect((await fetch(`${root}/api/tasks/thread-1/messages?limit=41`, {
        headers: prewarmHeaders,
      })).status).toBe(401);
      expect((await fetch(`${root}/api/tasks/thread-1/messages`, {
        method: "POST",
        headers: { ...prewarmHeaders, "content-type": "application/json" },
        body: JSON.stringify({ text: "不能通过预热写入", images: [] }),
      })).status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("mobile task short links", () => {
  test("round-trips UUID and opaque session ids without cross-adapter collisions", () => {
    const uuid = "0000000a-0000-7000-8000-00000000000a";
    const codexCode = encodeCodexMobileTaskShortCode("codex", uuid);
    const workbuddyCode = encodeCodexMobileTaskShortCode("workbuddy", uuid);

    expect(codexCode.length).toBeLessThan(uuid.length);
    expect(workbuddyCode).not.toBe(codexCode);
    expect(decodeCodexMobileTaskShortCode(codexCode)).toEqual({
      adapter: "codex",
      threadId: uuid,
    });
    expect(decodeCodexMobileTaskShortCode(workbuddyCode)).toEqual({
      adapter: "workbuddy",
      threadId: uuid,
    });

    const opaqueCode = encodeCodexMobileTaskShortCode("custom-agent", "session/中文-42");
    expect(decodeCodexMobileTaskShortCode(opaqueCode)).toEqual({
      adapter: "custom-agent",
      threadId: "session/中文-42",
    });
    expect(decodeCodexMobileTaskShortCode("invalid")).toBeNull();
  });

  test("allows the public relay to replace reversible links with registered aliases", async () => {
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      publicBaseUrl: "https://werelay.example",
      accessToken: "access-token",
      authStore: {
        isConfigured: () => true,
      } as never,
      buildPublicTaskUrl: (threadId, adapter, searchParams) =>
        `https://werelay.example/Ab3dE7kPq2${searchParams.size > 0 ? `?${searchParams}` : ""}`,
      listTasks: async () => [],
      readMessages: async () => ({
        messages: [],
        hasMore: false,
        nextBefore: null,
        total: 0,
      }),
      sendMessage: async () => ({ accepted: true }),
    });
    try {
      expect(server.buildTaskUrl(
        "0000000a-0000-7000-8000-00000000000a",
        "workbuddy",
      )).toBe("https://werelay.example/Ab3dE7kPq2");
    } finally {
      await server.close();
    }
  });
});

describe("mobile message delivery stages", () => {
  test("acknowledges computer receipt before the Agent confirms the turn", async () => {
    const authStore = createAuthStore("delivery stages password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    let finishSend: ((value: { queued: false; turnId: string }) => void) | undefined;
    let failSend: ((error: Error) => void) | undefined;
    let sendCalls = 0;
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [],
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
      }),
      sendMessage: async () => {
        sendCalls += 1;
        return await new Promise((resolve, reject) => {
          finishSend = resolve;
          failSend = reject;
        });
      },
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const headers = {
        cookie: sessionCookie,
        "content-type": "application/json",
      };
      const response = await fetch(`${root}/api/tasks/thread-1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          clientId: "mobile-delivery-1",
          text: "继续处理",
          images: [],
        }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({
        ok: true,
        clientId: "mobile-delivery-1",
        status: "forwarding",
      });
      expect(sendCalls).toBe(1);

      const forwarding = await fetch(
        `${root}/api/tasks/thread-1/message-deliveries/mobile-delivery-1`,
        { headers: { cookie: sessionCookie } },
      );
      expect(await forwarding.json()).toEqual({
        clientId: "mobile-delivery-1",
        status: "forwarding",
      });

      finishSend?.({ queued: false, turnId: "turn-1" });
      await Bun.sleep(0);
      const delivered = await fetch(
        `${root}/api/tasks/thread-1/message-deliveries/mobile-delivery-1`,
        { headers: { cookie: sessionCookie } },
      );
      expect(await delivered.json()).toEqual({
        clientId: "mobile-delivery-1",
        status: "sent",
        queued: false,
        turnId: "turn-1",
      });

      const duplicatePost = await fetch(`${root}/api/tasks/thread-1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          clientId: "mobile-delivery-1",
          text: "继续处理",
          images: [],
        }),
      });
      expect(duplicatePost.status).toBe(202);
      expect(sendCalls).toBe(1);

      finishSend = undefined;
      const failedPost = await fetch(`${root}/api/tasks/thread-1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          clientId: "mobile-delivery-2",
          text: "检查失败状态",
          images: [],
        }),
      });
      expect(failedPost.status).toBe(202);
      expect(sendCalls).toBe(2);
      expect(failSend).toBeDefined();
      failSend?.(new Error("Codex 暂未确认收到这条消息。"));
      await Bun.sleep(0);
      const failedDelivery = await fetch(
        `${root}/api/tasks/thread-1/message-deliveries/mobile-delivery-2`,
        { headers: { cookie: sessionCookie } },
      );
      expect(await failedDelivery.json()).toEqual({
        clientId: "mobile-delivery-2",
        status: "failed",
        error: "Codex 暂未确认收到这条消息。",
      });
    } finally {
      await server.close();
    }
  });

  test("shows transport and Agent forwarding as separate mobile states", () => {
    const mobileWebSource = fs.readFileSync(
      path.join(process.cwd(), "src/daemon/codex-mobile-web.ts"),
      "utf8",
    );
    expect(mobileWebSource).toContain("正在尝试发送给电脑");
    expect(mobileWebSource).toContain("电脑正在组织发送给");
    expect(CODEX_MOBILE_JS).toContain("message-deliveries");
    expect(CODEX_MOBILE_JS).toContain("clientId: pending.clientId");
    expect(CODEX_MOBILE_JS).toContain("adapter: state.currentAdapter");
    expect(CODEX_MOBILE_JS).toContain("requestedAdapter");
    const submitStart = CODEX_MOBILE_JS.indexOf("  async function submitPendingMessage");
    const submitEnd = CODEX_MOBILE_JS.indexOf("\n  function beginOptimisticRunIfNeeded", submitStart);
    const submitBlock = CODEX_MOBILE_JS.slice(submitStart, submitEnd);
    const duplicateBranch = submitBlock.indexOf("if (result.duplicate)");
    const optimisticStart = submitBlock.indexOf("beginOptimisticRunIfNeeded(pending)");
    expect(duplicateBranch).toBeGreaterThan(0);
    expect(optimisticStart).toBeGreaterThan(duplicateBranch);
    const creationSubmitStart = CODEX_MOBILE_JS.indexOf(
      "  async function submitMessagesWaitingForTaskCreation",
    );
    const creationSubmitEnd = CODEX_MOBILE_JS.indexOf(
      "\n  async function createTask",
      creationSubmitStart,
    );
    expect(CODEX_MOBILE_JS.slice(creationSubmitStart, creationSubmitEnd))
      .not.toContain("beginOptimisticRunIfNeeded(pending)");
  });
});

describe("mobile document title", () => {
  test("tracks task selection, async task loading, rename, and stable fallback", () => {
    const state = {
      currentThreadId: "task-a",
      tasks: [] as Array<{ threadId: string; title: string }>,
    };
    const updateTitle = loadMobileDocumentTitleUpdater({ state, adapterName: "Codex" });

    expect(updateTitle()).toBe("WeRelay · Codex");
    state.tasks = [
      { threadId: "task-a", title: "任务 A" },
      { threadId: "task-b", title: "任务 B" },
    ];
    expect(updateTitle()).toBe("任务 A");

    state.currentThreadId = "task-b";
    expect(updateTitle()).toBe("任务 B");

    state.tasks[1]!.title = "任务 B（已重命名）";
    expect(updateTitle()).toBe("任务 B（已重命名）");

    state.currentThreadId = "";
    expect(updateTitle()).toBe("WeRelay · Codex");
  });
});

describe("mobile terminal switcher status", () => {
  test("hides normal lifecycle states and keeps only attention states", () => {
    const label = loadMobileAdapterStateLabel();

    expect(label("open")).toBe("");
    expect(label("idle")).toBe("");
    expect(label("stopped")).toBe("");
    expect(label("busy")).toBe("处理中");
    expect(label("awaiting_approval")).toBe("待审批");
    expect(label("awaiting_input")).toBe("待输入");
    expect(label("starting")).toBe("启动中");
    expect(label("error")).toBe("异常");
  });

  test("keeps both menu columns on one line in a wider mobile menu", () => {
    expect(CODEX_MOBILE_CSS).toContain("width: min(300px, calc(100vw - 24px))");
    expect(CODEX_MOBILE_CSS).toContain(".adapter-menu-item > span:first-child");
    expect(CODEX_MOBILE_CSS).toContain(".adapter-menu-state { flex: 0 0 auto; white-space: nowrap;");
    expect(CODEX_MOBILE_JS).toContain("status.hidden = !status.textContent;");
  });
});

describe("mobile boot connection states", () => {
  test("distinguishes Relay waiting, connected, and direct LAN startup", () => {
    const resolve = loadMobileBootConnectionStateResolver();

    expect(resolve({ ok: true, deviceOnline: false }, 2_000)).toEqual({
      mode: "relay",
      ready: false,
      label: "服务器已连接",
      detail: "正在等待你的电脑主动连接…",
    });
    expect(resolve({ ok: true, deviceOnline: true })).toEqual({
      mode: "relay",
      ready: true,
      label: "电脑已连接",
      detail: "正在读取任务和最近消息…",
    });
    expect(resolve({ ok: true })).toEqual({
      mode: "direct",
      ready: true,
      label: "已连接电脑",
      detail: "正在读取任务和最近消息…",
    });
  });

  test("adds elapsed-time guidance while the Relay waits for the computer", () => {
    const resolve = loadMobileBootConnectionStateResolver();

    expect(resolve({ ok: true, deviceOnline: false }, 12_000)).toEqual({
      mode: "relay",
      ready: false,
      label: "电脑尚未连接",
      detail: "已等待 12 秒，WeRelay 会自动重试。",
    });
    expect(resolve({ ok: true, deviceOnline: false }, 35_000)).toEqual({
      mode: "relay",
      ready: false,
      label: "电脑仍未连接",
      detail: "已等待 35 秒，请确认电脑已开机、联网且 WeRelay 正在运行。",
    });
  });

  test("restores trusted cache before waiting for the computer and authenticates in background", () => {
    expect(CODEX_MOBILE_HTML).toContain("正在检查电脑连接状态…");
    expect(CODEX_MOBILE_HTML).toContain('id="boot-detail"');
    expect(CODEX_MOBILE_HTML).toContain('class="boot-activity"');
    expect(CODEX_MOBILE_JS).toContain("async function waitForComputerConnection");
    expect(CODEX_MOBILE_JS).toContain('setCacheSyncState("waiting-computer")');
    expect(CODEX_MOBILE_JS).toContain('setCacheSyncState("server-retry")');
    expect(CODEX_MOBILE_JS).toContain("restoreTrustedPersistentMobileCachePreview");
    expect(CODEX_MOBILE_JS).toContain("void waitForComputerConnection();");
    expect(CODEX_MOBILE_JS).toContain("await initializeAuthentication();");
    expect(CODEX_MOBILE_JS).not.toContain("await waitForComputerConnection();");
  });
});

describe("mobile fetch resilience", () => {
  test("classifies browser transport failures without hiding HTTP errors", () => {
    const helpers = loadMobileFetchResilienceHelpers();

    expect(helpers.isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(helpers.isNetworkError(new TypeError("Load failed"))).toBe(true);
    expect(helpers.isNetworkError(new Error("NetworkError when attempting to fetch resource."))).toBe(true);
    expect(helpers.isNetworkError(Object.assign(new Error("电脑当前离线"), { status: 503 }))).toBe(false);
    expect(helpers.isNetworkError(new Error("业务失败"))).toBe(false);
  });

  test("retries one read-only request and translates the final network failure", () => {
    const helpers = loadMobileFetchResilienceHelpers();
    const failure = new TypeError("Failed to fetch");

    expect(helpers.shouldRetry(failure, "GET", 0)).toBe(true);
    expect(helpers.shouldRetry(failure, "GET", 1)).toBe(false);
    expect(helpers.shouldRetry(failure, "POST", 0)).toBe(false);

    const normalized = helpers.normalize(failure) as Error & { network?: boolean };
    expect(normalized.message).toBe("网络连接暂时中断，请稍后重试。");
    expect(normalized.network).toBe(true);
  });

  test("retries an idempotent GET once but never replays a POST", async () => {
    let getAttempts = 0;
    const fetchGet = loadMobileFetchJson(async () => {
      getAttempts += 1;
      if (getAttempts === 1) throw new TypeError("Failed to fetch");
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      };
    });
    await expect(fetchGet("/api/tasks")).resolves.toEqual({ ok: true });
    expect(getAttempts).toBe(2);

    let postAttempts = 0;
    const fetchPost = loadMobileFetchJson(async () => {
      postAttempts += 1;
      throw new TypeError("Failed to fetch");
    });
    await expect(fetchPost("/api/tasks/task/messages", { method: "POST" })).rejects.toMatchObject({
      message: "网络连接暂时中断，请稍后重试。",
      network: true,
    });
    expect(postAttempts).toBe(1);
  });

  test("keeps transient background refresh failures quiet and treats POST delivery as uncertain", () => {
    expect(CODEX_MOBILE_JS).toContain("if (error.network && !initial && state.tasks.length)");
    expect(CODEX_MOBILE_JS).toContain("if (!error.network) showToast");
    expect(CODEX_MOBILE_JS).toContain('var uncertain = Boolean(error && error.network) ||');
  });
});

describe("mobile optimistic progress isolation", () => {
  const oldProgress = [
    { id: "old-command", turnId: "turn-old" },
    { id: "old-tool", turnId: "turn-old" },
    { id: "old-plan", turnId: "turn-old" },
  ];

  test("clears completed progress immediately when a new direct turn starts", () => {
    const state = {
      progressItems: oldProgress.slice(),
      localRunSummary: null,
      optimisticProgressTurnId: null as string | null,
    };
    const start = loadMobileOptimisticRunStarter({ state, visibleSummary: null });
    const pending = { optimisticRun: false };

    start(pending);

    expect(pending.optimisticRun).toBe(true);
    expect(state.progressItems).toEqual([]);
    expect(state.optimisticProgressTurnId).toBe("");
  });

  test("does not clear the current real turn progress for a queued follow-up", () => {
    const state = {
      progressItems: oldProgress.slice(),
      localRunSummary: null,
      optimisticProgressTurnId: null as string | null,
    };
    const start = loadMobileOptimisticRunStarter({
      state,
      visibleSummary: { status: "running" },
    });
    const pending = { optimisticRun: false };

    start(pending);

    expect(pending.optimisticRun).toBe(false);
    expect(state.progressItems).toEqual(oldProgress);
    expect(state.optimisticProgressTurnId).toBeNull();
  });

  test("keeps old progress hidden until the new turn id and progress arrive", () => {
    const filter = loadMobileOptimisticProgressFilter();
    expect(filter(oldProgress, "")).toEqual([]);
    expect(filter(oldProgress, "")).toEqual([]);
    expect(filter([
      ...oldProgress,
      { id: "new-progress", turnId: "turn-new" },
    ], "turn-new")).toEqual([{ id: "new-progress", turnId: "turn-new" }]);
  });

  test("leaves progress unchanged when no optimistic direct turn is active", () => {
    const filter = loadMobileOptimisticProgressFilter();
    expect(filter(oldProgress, null)).toEqual(oldProgress);
  });
});

describe("paginateCodexMobileMessages", () => {
  test("returns the latest page first and walks backwards with an opaque boundary", () => {
    const messages = Array.from({ length: 95 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      text: `消息 ${index + 1}`,
    }));

    const latest = paginateCodexMobileMessages(messages, { limit: 40 });
    expect(latest.start).toBe(55);
    expect(latest.end).toBe(95);
    expect(latest.messages[0]?.text).toBe("消息 56");
    expect(latest.messages.at(-1)?.text).toBe("消息 95");
    expect(latest.hasMore).toBe(true);
    expect(latest.nextBefore).toBe(55);

    const older = paginateCodexMobileMessages(messages, {
      before: latest.nextBefore,
      limit: 40,
    });
    expect(older.start).toBe(15);
    expect(older.end).toBe(55);
    expect(older.messages[0]?.text).toBe("消息 16");
    expect(older.messages.at(-1)?.text).toBe("消息 55");
  });

  test("clamps invalid boundaries and page sizes", () => {
    const messages = [{ role: "user" as const, text: "唯一消息" }];
    expect(paginateCodexMobileMessages(messages, {
      before: Number.NaN,
      limit: 0,
    })).toMatchObject({
      start: 0,
      end: 1,
      total: 1,
      hasMore: false,
      nextBefore: null,
    });
  });
});

describe("mobile approval result helpers", () => {
  test("keeps approval decisions visible with action-specific labels", () => {
    const helpers = loadMobileApprovalResultHelpers();
    expect(helpers.title("confirm")).toBe("已允许本次操作");
    expect(helpers.title("confirm_session")).toBe("本任务后续同类操作已允许");
    expect(helpers.title("confirm_task")).toBe("已按本任务免审允许");
    expect(helpers.title("deny")).toBe("已拒绝此操作");
  });

  test("interleaves messages, progress, pending approvals, and approval results by occurrence time", () => {
    const helpers = loadMobileApprovalResultHelpers();
    const timeline = helpers.buildTimeline({
      messages: [
        { id: "commentary-1", turnId: "turn-1", createdAtMs: 10_000 },
        { id: "commentary-2", turnId: "turn-1", createdAtMs: 12_000 },
        { id: "final", turnId: "turn-1", createdAtMs: 15_000 },
      ],
      progressItems: [{ id: "command", turnId: "turn-1", createdAtMs: 10_500 }],
      approvalResults: [
        { id: "approval-2", turnId: "turn-1", resolvedAt: "1970-01-01T00:00:13.000Z" },
        { id: "approval-1", turnId: "turn-1", resolvedAt: "1970-01-01T00:00:11.000Z" },
      ],
      pendingApproval: { requestId: "pending", turnId: "turn-1", createdAtMs: 14_000 },
    });

    expect(timeline.map((item) =>
      item.message?.id ?? item.progressItem?.id ?? item.approvalResult?.id ?? item.pendingApproval?.requestId
    )).toEqual([
      "commentary-1",
      "command",
      "approval-1",
      "commentary-2",
      "approval-2",
      "pending",
      "final",
    ]);
  });

  test("places an approval between timestamped messages even when the earlier message lacks a turn id", () => {
    const helpers = loadMobileApprovalResultHelpers();
    const timeline = helpers.buildTimeline({
      messages: [
        { id: "user", role: "user", turnId: "turn-1", createdAtMs: 10_000 },
        { id: "commentary-without-turn", role: "assistant", createdAtMs: 12_000 },
        { id: "final", role: "assistant", turnId: "turn-1", createdAtMs: 15_000 },
      ],
      approvalResults: [{
        id: "approval",
        turnId: "turn-1",
        resolvedAt: "1970-01-01T00:00:13.000Z",
      }],
    });

    expect(timeline.map((item) => item.message?.id ?? item.approvalResult?.id)).toEqual([
      "user",
      "commentary-without-turn",
      "approval",
      "final",
    ]);
  });

  test("uses timestamps for approval placement when accelerated messages have no turn ids", () => {
    const helpers = loadMobileApprovalResultHelpers();
    const timeline = helpers.buildTimeline({
      messages: [
        { id: "message-1", role: "assistant", createdAtMs: 10_000 },
        { id: "message-2", role: "assistant", createdAtMs: 20_000 },
        { id: "message-3", role: "assistant", createdAtMs: 30_000 },
      ],
      approvalResults: [
        {
          id: "approval-before-page",
          turnId: "turn-before-page",
          requestedAt: "1970-01-01T00:00:05.000Z",
        },
        {
          id: "approval-after-2",
          turnId: "turn-from-native-history",
          requestedAt: "1970-01-01T00:00:25.000Z",
          resolvedAt: "1970-01-01T00:00:26.000Z",
        },
        {
          id: "approval-after-1",
          requestedAt: "1970-01-01T00:00:15.000Z",
          resolvedAt: "1970-01-01T00:00:16.000Z",
        },
      ],
    });

    expect(timeline.map((item) =>
      item.message?.id ?? item.approvalResult?.id
    )).toEqual([
      "message-1",
      "approval-after-1",
      "message-2",
      "approval-after-2",
      "message-3",
    ]);
  });

  test("hides approval results whose real turn has not been loaded yet", () => {
    const helpers = loadMobileApprovalResultHelpers();
    const latestPage = helpers.buildTimeline({
      messages: [
        { id: "latest-user", role: "user", turnId: "turn-latest", createdAtMs: 30_000 },
        { id: "latest-final", role: "assistant", turnId: "turn-latest", createdAtMs: 40_000 },
      ],
      approvalResults: [
        {
          id: "older-approval",
          turnId: "turn-older",
          requestedAt: "1970-01-01T00:00:20.000Z",
        },
        {
          id: "latest-approval",
          turnId: "turn-latest",
          requestedAt: "1970-01-01T00:00:35.000Z",
        },
      ],
    });

    expect(latestPage.map((item) =>
      item.message?.id ?? item.approvalResult?.id
    )).toEqual(["latest-user", "latest-approval", "latest-final"]);

    const withOlderHistory = helpers.buildTimeline({
      messages: [
        { id: "older-user", role: "user", turnId: "turn-older", createdAtMs: 10_000 },
        { id: "older-final", role: "assistant", turnId: "turn-older", createdAtMs: 25_000 },
        { id: "latest-user", role: "user", turnId: "turn-latest", createdAtMs: 30_000 },
        { id: "latest-final", role: "assistant", turnId: "turn-latest", createdAtMs: 40_000 },
      ],
      approvalResults: [
        {
          id: "older-approval",
          turnId: "turn-older",
          requestedAt: "1970-01-01T00:00:20.000Z",
        },
        {
          id: "latest-approval",
          turnId: "turn-latest",
          requestedAt: "1970-01-01T00:00:35.000Z",
        },
      ],
    });

    expect(withOlderHistory.map((item) =>
      item.message?.id ?? item.approvalResult?.id
    )).toEqual([
      "older-user",
      "older-approval",
      "older-final",
      "latest-user",
      "latest-approval",
      "latest-final",
    ]);
  });

  test("keeps equal-time items stable and scopes undated approval fallbacks to their turn", () => {
    const helpers = loadMobileApprovalResultHelpers();
    const timeline = helpers.buildTimeline({
      messages: [
        { id: "turn-1-message", turnId: "turn-1", createdAtMs: 10_000 },
        { id: "turn-2-message", turnId: "turn-2", createdAtMs: 10_000 },
      ],
      approvalResults: [
        { id: "same-time", turnId: "turn-1", resolvedAt: "1970-01-01T00:00:10.000Z" },
        { id: "legacy", turnId: "turn-1" },
      ],
    });

    expect(timeline.map((item) =>
      item.message?.id ?? item.approvalResult?.id
    )).toEqual([
      "turn-1-message",
      "same-time",
      "legacy",
      "turn-2-message",
    ]);
  });
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createAuthStore(password?: string): CodexMobileAuthStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mobile-server-"));
  tempDirs.push(dir);
  const store = new CodexMobileAuthStore({ stateFile: path.join(dir, "auth.json") });
  if (password) store.setPassword(password);
  return store;
}

function loadMobileFetchJson(
  fetchImpl: (...args: unknown[]) => Promise<unknown>,
): (path: string, options?: Record<string, unknown>) => Promise<unknown> {
  const start = CODEX_MOBILE_JS.indexOf("  function isMobileFetchNetworkError");
  const end = CODEX_MOBILE_JS.indexOf("\n  async function checkForAppUpdate", start);
  if (start < 0 || end < 0) throw new Error("Mobile fetchJson source not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function("fetch", "setTimeout", "document", `${source}
return fetchJson;`)(
    fetchImpl,
    (resolve: () => void) => resolve(),
    { hidden: false },
  ) as (path: string, options?: Record<string, unknown>) => Promise<unknown>;
}

function loadMobileFetchResilienceHelpers(): {
  isNetworkError: (error: unknown) => boolean;
  shouldRetry: (error: unknown, method: string, attempt: number) => boolean;
  normalize: (error: unknown) => Error & { network?: boolean };
} {
  const start = CODEX_MOBILE_JS.indexOf("  function isMobileFetchNetworkError");
  const end = CODEX_MOBILE_JS.indexOf("\n  async function waitForMobileFetchRetry", start);
  if (start < 0 || end < 0) throw new Error("Mobile fetch resilience helpers not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}
return {
  isNetworkError: isMobileFetchNetworkError,
  shouldRetry: shouldRetryMobileFetch,
  normalize: normalizeMobileFetchError
};`)() as ReturnType<typeof loadMobileFetchResilienceHelpers>;
}

function loadMobileMarkdownRenderer(): (markdown: string, foldPrefix?: string) => string {
  const start = CODEX_MOBILE_JS.indexOf("  function escapeHtml");
  const end = CODEX_MOBILE_JS.indexOf("\n  async function fetchJson", start);
  if (start < 0 || end < 0) throw new Error("Mobile markdown renderer not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn renderMarkdown;`)() as (markdown: string) => string;
}

function loadMobileDocumentTitleUpdater(params: {
  state: {
    currentThreadId: string;
    tasks: Array<{ threadId: string; title: string }>;
  };
  adapterName?: string;
}): () => string {
  const start = CODEX_MOBILE_JS.indexOf("  function updateDocumentTitle");
  const end = CODEX_MOBILE_JS.indexOf("\n  function isAdapterCapabilityError", start);
  if (start < 0 || end < 0) throw new Error("Mobile document-title updater not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  const document = { title: "" };
  const update = new Function("document", "currentTask", "currentAdapterName", `
${source}
return updateDocumentTitle;
`)(
    document,
    () => params.state.tasks.find((task) => task.threadId === params.state.currentThreadId) ?? null,
    () => params.adapterName ?? "Codex",
  ) as () => void;
  return () => {
    update();
    return document.title;
  };
}

function loadMobileAdapterStateLabel(): (status: string) => string {
  const start = CODEX_MOBILE_JS.indexOf("  function adapterStateLabel");
  const end = CODEX_MOBILE_JS.indexOf("\n  function renderAdapterMenu", start);
  if (start < 0 || end < 0) throw new Error("Mobile adapter-state label helper not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn adapterStateLabel;`)() as (status: string) => string;
}

function loadMobileBootConnectionStateResolver(): (
  health: { ok?: boolean; deviceOnline?: boolean } | null,
  waitedMs?: number,
) => { mode: "relay" | "direct"; ready: boolean; label: string; detail: string } {
  const start = CODEX_MOBILE_JS.indexOf("  function resolveBootConnectionState");
  const end = CODEX_MOBILE_JS.indexOf("\n  function bootReadyStatus", start);
  if (start < 0 || end < 0) throw new Error("Mobile boot connection resolver not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn resolveBootConnectionState;`)() as ReturnType<
    typeof loadMobileBootConnectionStateResolver
  >;
}

function loadMobileOptimisticRunStarter(params: {
  state: {
    progressItems: Array<{ id: string; turnId?: string }>;
    localRunSummary: unknown;
    optimisticProgressTurnId?: string | null;
  };
  visibleSummary: { status: string } | null;
}): (pending: { optimisticRun: boolean }) => void {
  const start = CODEX_MOBILE_JS.indexOf("  function beginOptimisticRunIfNeeded");
  const end = CODEX_MOBILE_JS.indexOf("\n  function retryPendingMessage", start);
  if (start < 0 || end < 0) throw new Error("Mobile optimistic-run starter not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function("state", "visibleSummary", `
function currentVisibleRunSummary() { return visibleSummary; }
${source}
return beginOptimisticRunIfNeeded;
`)(params.state, params.visibleSummary) as (pending: { optimisticRun: boolean }) => void;
}

function loadMobileOptimisticProgressFilter(): (
  progressItems: Array<{ id: string; turnId?: string }>,
  optimisticTurnId: string | null,
) => Array<{ id: string; turnId?: string }> {
  const start = CODEX_MOBILE_JS.indexOf("  function filterProgressItemsForOptimisticTurn");
  const end = CODEX_MOBILE_JS.indexOf("\n  function resolveVisibleRunSummary", start);
  if (start < 0 || end < 0) throw new Error("Mobile optimistic-progress filter not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn filterProgressItemsForOptimisticTurn;`)() as ReturnType<
    typeof loadMobileOptimisticProgressFilter
  >;
}

function loadMobileRunSummaryResolver(): (
  messages: Array<{ role: string; turnId?: string }>,
  task: { status: string; startedAtMs?: number } | null,
  summary: { turnId?: string; status: string; startedAtMs?: number; durationMs?: number } | null,
  nowMs: number,
) => { turnId?: string; status: string; startedAtMs?: number; durationMs?: number } | null {
  const start = CODEX_MOBILE_JS.indexOf("  function isTaskActivelyRunning");
  const end = CODEX_MOBILE_JS.indexOf("\n  function runDurationMs", start);
  if (start < 0 || end < 0) throw new Error("Mobile run summary resolver not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn resolveVisibleRunSummary;`)() as ReturnType<
    typeof loadMobileRunSummaryResolver
  >;
}

function loadMobileComposerActionPredicate(): (
  task: { status: string } | null,
  summary: { status: string } | null,
  hasContent: boolean,
) => boolean {
  const start = CODEX_MOBILE_JS.indexOf("  function isTaskActivelyRunning");
  const end = CODEX_MOBILE_JS.indexOf("\n  function runDurationMs", start);
  if (start < 0 || end < 0) throw new Error("Mobile composer action helper not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn shouldUseStopComposerAction;`)() as ReturnType<
    typeof loadMobileComposerActionPredicate
  >;
}

function loadMobileTaskSidebarHelpers(): {
  projectBatchSize: number;
  recentBatchSize: number;
  nextTaskVisibleLimit: (current: number, total: number, batchSize: number) => number;
  setProjectGroupCollapsed: (
    collapsedGroups: Record<string, boolean>,
    visibleLimits: Record<string, number>,
    groupKey: string,
    collapsed: boolean,
  ) => void;
  sortTasksByRecency: <T extends { lastUpdatedAt?: string }>(tasks: T[]) => T[];
  taskBoardLane: (task: { status?: string; completedAt?: string }) => string;
  isTaskBoardInProgress: (task: { status?: string }) => boolean;
  taskBoardMatchesQuery: (
    task: { title?: string; projectName?: string; adapterLabel?: string },
    query: string,
  ) => boolean;
  formatTaskBoardTime: (value: string, nowMs?: number) => string;
  shouldShowTaskAdapterLabels: (tasks: Array<{ adapter?: string }>) => boolean;
  projectTaskCreationSource: <T extends {
    threadId: string;
    canCreateInProject?: boolean;
  }>(tasks: T[], currentThreadId: string) => T | null;
} {
  const start = CODEX_MOBILE_JS.indexOf("  var PROJECT_TASK_BATCH_SIZE");
  const end = CODEX_MOBILE_JS.indexOf("\n  function readSetupToken", start);
  if (start < 0 || end < 0) throw new Error("Mobile task sidebar helpers not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}
return {
  projectBatchSize: PROJECT_TASK_BATCH_SIZE,
  recentBatchSize: RECENT_TASK_BATCH_SIZE,
  nextTaskVisibleLimit,
  setProjectGroupCollapsed,
  sortTasksByRecency,
  taskBoardLane,
  isTaskBoardInProgress,
  taskBoardMatchesQuery,
  formatTaskBoardTime,
  shouldShowTaskAdapterLabels,
  projectTaskCreationSource
};`)() as ReturnType<typeof loadMobileTaskSidebarHelpers>;
}

function loadMobileConversationCacheHelpers(): {
  conversationStateKey: (adapter: string, threadId: string) => string;
  setBoundedConversationValue: <T>(
    values: Record<string, T>,
    order: string[],
    key: string,
    value: T,
    limit: number,
  ) => string[];
  getBoundedConversationValue: <T>(
    values: Record<string, T>,
    order: string[],
    key: string,
  ) => T | null;
  deleteConversationValue: <T>(
    values: Record<string, T>,
    order: string[],
    key: string,
  ) => void;
  moveConversationValue: <T>(
    values: Record<string, T>,
    order: string[],
    fromKey: string,
    toKey: string,
    limit: number,
  ) => void;
  findReusableLocalTask: <T extends { localCreationState?: string }>(tasks: T[]) => T | null;
  mergeTasksWithLocalDrafts: <T extends { threadId: string }>(
    remoteTasks: T[],
    localTasks: T[],
  ) => T[];
} {
  const start = CODEX_MOBILE_JS.indexOf("  function conversationStateKey");
  const end = CODEX_MOBILE_JS.indexOf("\n  function readSetupToken", start);
  if (start < 0 || end < 0) throw new Error("Mobile conversation cache helpers not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}
return {
  conversationStateKey,
  setBoundedConversationValue,
  getBoundedConversationValue,
  deleteConversationValue,
  moveConversationValue,
  findReusableLocalTask,
  mergeTasksWithLocalDrafts
};`)() as ReturnType<typeof loadMobileConversationCacheHelpers>;
}

function loadMobileConversationSnapshotRuntime(params: {
  state: Record<string, any>;
  composerInput?: { value: string; placeholder?: string };
  messagesEl?: { scrollTop: number };
}): {
  restoreConversationSnapshot: (adapter: string, threadId: string) => boolean;
  setBoundedConversationValue: (
    values: Record<string, unknown>,
    order: string[],
    key: string,
    value: unknown,
    limit: number,
  ) => string[];
  conversationStateKey: (adapter: string, threadId: string) => string;
  renderEvents: string[];
} {
  const start = CODEX_MOBILE_JS.indexOf("  function conversationStateKey");
  const end = CODEX_MOBILE_JS.indexOf("\n  function readSetupToken", start);
  if (start < 0 || end < 0) throw new Error("Mobile conversation snapshot runtime not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  const renderEvents: string[] = [];
  const runtime = new Function(
    "state",
    "composerInput",
    "composerImageButton",
    "messagesEl",
    "renderPendingImages",
    "renderQueuedMessages",
    "resizeComposer",
    "renderMessages",
    "requestAnimationFrame",
    "scrollToLatest",
    "updateUserMessageNavigation",
    "isNearBottom",
    "MAX_COMPOSER_DRAFTS",
    "MAX_CONVERSATION_SNAPSHOTS",
    `${source}
return { restoreConversationSnapshot, setBoundedConversationValue, conversationStateKey };`,
  )(
    params.state,
    params.composerInput ?? { value: "", placeholder: "" },
    { disabled: false },
    params.messagesEl ?? { scrollTop: 0 },
    () => renderEvents.push("images"),
    () => renderEvents.push("queue"),
    () => renderEvents.push("composer"),
    () => renderEvents.push("messages"),
    (callback: () => void) => callback(),
    () => renderEvents.push("latest"),
    () => renderEvents.push("navigation"),
    () => true,
    40,
    12,
  ) as {
    restoreConversationSnapshot: (adapter: string, threadId: string) => boolean;
    setBoundedConversationValue: (
      values: Record<string, unknown>,
      order: string[],
      key: string,
      value: unknown,
      limit: number,
    ) => string[];
    conversationStateKey: (adapter: string, threadId: string) => string;
  };
  return { ...runtime, renderEvents };
}

function loadMobileTaskSelector(): <T extends { threadId: string }>(
  tasks: T[],
  selector: string,
) => T | null {
  const start = CODEX_MOBILE_JS.indexOf("  function resolveTaskSelector");
  const end = CODEX_MOBILE_JS.indexOf("\n  function readSetupToken", start);
  if (start < 0 || end < 0) throw new Error("Mobile task selector not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn resolveTaskSelector;`)() as ReturnType<
    typeof loadMobileTaskSelector
  >;
}

function loadMobileTaskBoardHref(currentHref: string): (
  task: { adapter: string; threadId: string },
) => string {
  const start = CODEX_MOBILE_JS.indexOf("  function taskBoardTaskHref");
  const end = CODEX_MOBILE_JS.indexOf("\n  function formatTaskBoardTime", start);
  if (start < 0 || end < 0) throw new Error("Mobile task-board href helper not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function("window", `${source}\nreturn taskBoardTaskHref;`)({
    location: { href: currentHref },
  }) as ReturnType<typeof loadMobileTaskBoardHref>;
}

function loadMobileMessagePageMerger(): (
  existing: Array<{ id?: string; role: string; text: string; turnId?: string; phase?: string }>,
  incoming: Array<{ id?: string; role: string; text: string; turnId?: string; phase?: string }>,
) => Array<{ id?: string; role: string; text: string; turnId?: string; phase?: string }> {
  const start = CODEX_MOBILE_JS.indexOf("  function messagePageKey");
  const end = CODEX_MOBILE_JS.indexOf("\n  function rebuildServerMessages", start);
  if (start < 0 || end < 0) throw new Error("Mobile message page merger not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn mergeMessagePages;`)() as ReturnType<
    typeof loadMobileMessagePageMerger
  >;
}

function loadMobilePendingMessageReconciler(): (
  pendingMessages: Array<{
    clientId: string;
    text: string;
    imageCount: number;
    status: string;
    turnId?: string;
    baselineUserCount: number;
    baselineUserKeys?: string[];
  }>,
  messages: Array<{
    id?: string;
    turnId?: string;
    role: string;
    text: string;
  }>,
) => Array<{ clientId: string }> {
  const start = CODEX_MOBILE_JS.indexOf("  function reconcilePendingMessages");
  const end = CODEX_MOBILE_JS.indexOf("\n  function runHeaderInsertIndex", start);
  if (start < 0 || end < 0) throw new Error("Mobile pending-message reconciler not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function("pendingMessages", "messages", `
var state = { pendingMessages: pendingMessages };
${source}
reconcilePendingMessages(messages);
return state.pendingMessages;
`) as ReturnType<typeof loadMobilePendingMessageReconciler>;
}

function loadMobileRunSummaryRenderKey(): (
  summary: {
    turnId?: string;
    status?: string;
    startedAtMs?: number;
    completedAtMs?: number;
    durationMs?: number;
    receivedAtMs?: number;
  } | null,
) => unknown {
  const start = CODEX_MOBILE_JS.indexOf("  function runSummaryRenderKey");
  const end = CODEX_MOBILE_JS.indexOf("\n  function renderMessages", start);
  if (start < 0 || end < 0) throw new Error("Mobile run-summary render key not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn runSummaryRenderKey;`)() as ReturnType<
    typeof loadMobileRunSummaryRenderKey
  >;
}

function loadMobileRunFailureText(): (summary: {
  status?: string;
  errorMessage?: string;
} | null) => string {
  const start = CODEX_MOBILE_JS.indexOf("  function runFailureText");
  const end = CODEX_MOBILE_JS.indexOf("\n  function renderRunFailure", start);
  if (start < 0 || end < 0) throw new Error("Mobile run-failure helper not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn runFailureText;`)() as ReturnType<
    typeof loadMobileRunFailureText
  >;
}

function loadMobileTaskApprovalStatusReconciler(): (
  task: Record<string, unknown>,
  pendingApproval: Record<string, unknown> | null,
  runSummary: { status?: string } | null,
) => Record<string, unknown> {
  const start = CODEX_MOBILE_JS.indexOf("  function reconcileTaskApprovalStatus");
  const end = CODEX_MOBILE_JS.indexOf("\n  function currentTask", start);
  if (start < 0 || end < 0) throw new Error("Mobile task approval reconciler not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn reconcileTaskApprovalStatus;`)() as ReturnType<
    typeof loadMobileTaskApprovalStatusReconciler
  >;
}

function loadMobileApprovalResultHelpers(): {
  title: (action: string) => string;
  buildTimeline: (params: {
    messages: Array<Record<string, unknown>>;
    approvalResults?: Array<Record<string, unknown>>;
    pendingApproval?: Record<string, unknown> | null;
    progressItems?: Array<Record<string, unknown>>;
  }) => Array<{
    kind: string;
    message?: Record<string, unknown>;
    approvalResult?: Record<string, unknown>;
    pendingApproval?: Record<string, unknown>;
    progressItem?: Record<string, unknown>;
  }>;
} {
  const start = CODEX_MOBILE_JS.indexOf("  function approvalResultTitle");
  const end = CODEX_MOBILE_JS.indexOf("\n  function renderApprovalResult", start);
  if (start < 0 || end < 0) throw new Error("Mobile approval-result helpers not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn { title: approvalResultTitle, buildTimeline: buildConversationTimeline };`)() as ReturnType<
    typeof loadMobileApprovalResultHelpers
  >;
}
function loadVisibleMessageModel(): (message: {
  role?: string;
  phase?: string;
  model?: string;
}) => string {
  const start = CODEX_MOBILE_JS.indexOf("  function visibleMessageModel");
  const end = CODEX_MOBILE_JS.indexOf("\n  function renderMessageRow", start);
  if (start < 0 || end < 0) throw new Error("Mobile message model helper not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn visibleMessageModel;`)() as ReturnType<
    typeof loadVisibleMessageModel
  >;
}

function loadMobileMessageNodeCache(): {
  messageNodeKey: (message: Record<string, unknown>, duplicateIndex: number) => string;
  getMessageNode: (
    message: Record<string, unknown>,
    index: number,
    nextMessage: Record<string, unknown> | undefined,
    nodeKey: string,
  ) => { renderCount: number; __deskRelayMessageRenderKey?: string };
} {
  const start = CODEX_MOBILE_JS.indexOf("  function messageNodeBaseKey");
  const end = CODEX_MOBILE_JS.indexOf("\n  function renderMessageRow", start);
  if (start < 0 || end < 0) throw new Error("Mobile message-node cache helpers not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  const state = { messageNodes: Object.create(null) };
  let renderCount = 0;
  const renderMessageRow = () => ({
    renderCount: ++renderCount,
  });
  return new Function("state", "currentAdapterName", "renderMessageRow", `
${source}
return { messageNodeKey, getMessageNode };
`)(state, () => "Codex", renderMessageRow) as ReturnType<
    typeof loadMobileMessageNodeCache
  >;
}

function loadMobileVisibleMessageText(): (message: {
  role?: string;
  text?: string;
}) => string {
  const start = CODEX_MOBILE_JS.indexOf("  function visibleMessageText");
  const end = CODEX_MOBILE_JS.indexOf("\n  function visibleMessageModel", start);
  if (start < 0 || end < 0) throw new Error("Mobile visible-message text helper not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn visibleMessageText;`)() as ReturnType<
    typeof loadMobileVisibleMessageText
  >;
}

function loadMobileProgressPartitioner(): (
  items: Array<{ id: string; kind: string; status: string; text: string }>,
) => {
  pinned: Array<{ id: string }>;
  hidden: Array<{ id: string }>;
  visible: Array<{ id: string }>;
} {
  const start = CODEX_MOBILE_JS.indexOf("  function partitionProgressItems");
  const end = CODEX_MOBILE_JS.indexOf("\n  function renderProgressList", start);
  if (start < 0 || end < 0) throw new Error("Mobile progress partitioner not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn partitionProgressItems;`)() as ReturnType<
    typeof loadMobileProgressPartitioner
  >;
}

function loadMobileSwitchProgressFormatter(): (startedAtMs: number, nowMs: number) => string {
  const start = CODEX_MOBILE_JS.indexOf("  function formatRunDuration");
  const end = CODEX_MOBILE_JS.indexOf("\n  function effectiveRunSummary", start);
  if (start < 0 || end < 0) throw new Error("Mobile switch-progress formatter not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn switchProgressLabel;`)() as ReturnType<
    typeof loadMobileSwitchProgressFormatter
  >;
}

function loadMobileQueuedMessageMerger(): (
  queuedMessages: Array<{ id: string; text: string; imageCount: number }>,
  pendingMessages: Array<{
    clientId: string;
    queuedMessageId?: string;
    text: string;
    imageCount: number;
    status: string;
    displayInTranscript: boolean;
    createdAtMs?: number;
  }>,
  transcriptMessages?: Array<{ role: string; text: string; turnId?: string }>,
  runSummary?: { status: string; turnId?: string } | null,
) => Array<{
  id: string;
  text: string;
  imageCount: number;
  createdAtMs?: number;
  optimistic?: boolean;
  status?: string;
}> {
  const start = CODEX_MOBILE_JS.indexOf("  function queuedMessageDisplayText");
  const end = CODEX_MOBILE_JS.indexOf("\n  async function steerQueuedMessage", start);
  if (start < 0 || end < 0) throw new Error("Mobile queued-message merger not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn mergeQueuedMessagesForDisplay;`)() as ReturnType<
    typeof loadMobileQueuedMessageMerger
  >;
}

function loadMobileUserMessageNavigator(): (
  offsets: number[],
  scrollTop: number,
  targetInset: number,
) => { previousIndex: number; nextIndex: number } {
  const start = CODEX_MOBILE_JS.indexOf("  function resolveUserMessageNavigation");
  const end = CODEX_MOBILE_JS.indexOf("\n  function updateUserMessageNavigation", start);
  if (start < 0 || end < 0) throw new Error("Mobile user-message navigator not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  return new Function(`${source}\nreturn resolveUserMessageNavigation;`)() as ReturnType<
    typeof loadMobileUserMessageNavigator
  >;
}

describe("Codex mobile conversation cache", () => {
  test("isolates snapshots by adapter and task id", () => {
    const { conversationStateKey } = loadMobileConversationCacheHelpers();

    expect(conversationStateKey("codex", "same-id")).toBe("codex\u0000same-id");
    expect(conversationStateKey("claude", "same-id")).not.toBe(
      conversationStateKey("codex", "same-id"),
    );
  });

  test("restores a recently used snapshot and evicts the least recently used one", () => {
    const helpers = loadMobileConversationCacheHelpers();
    const snapshots: Record<string, { messages: string[] }> = Object.create(null);
    const order: string[] = [];
    const a = helpers.conversationStateKey("codex", "a");
    const b = helpers.conversationStateKey("codex", "b");
    const c = helpers.conversationStateKey("codex", "c");

    helpers.setBoundedConversationValue(snapshots, order, a, { messages: ["A"] }, 2);
    helpers.setBoundedConversationValue(snapshots, order, b, { messages: ["B"] }, 2);
    expect(helpers.getBoundedConversationValue(snapshots, order, a)).toEqual({ messages: ["A"] });
    helpers.setBoundedConversationValue(snapshots, order, c, { messages: ["C"] }, 2);

    expect(snapshots[b]).toBeUndefined();
    expect(helpers.getBoundedConversationValue(snapshots, order, a)).toEqual({ messages: ["A"] });
    expect(helpers.getBoundedConversationValue(snapshots, order, c)).toEqual({ messages: ["C"] });
  });

  test("keeps independent drafts and clears only the submitted task", () => {
    const helpers = loadMobileConversationCacheHelpers();
    const drafts: Record<string, { text: string }> = Object.create(null);
    const order: string[] = [];
    const a = helpers.conversationStateKey("codex", "a");
    const b = helpers.conversationStateKey("codex", "b");

    helpers.setBoundedConversationValue(drafts, order, a, { text: "草稿 A" }, 20);
    helpers.setBoundedConversationValue(drafts, order, b, { text: "草稿 B" }, 20);
    helpers.deleteConversationValue(drafts, order, a);

    expect(helpers.getBoundedConversationValue(drafts, order, a)).toBeNull();
    expect(helpers.getBoundedConversationValue(drafts, order, b)).toEqual({ text: "草稿 B" });
  });

  test("moves an optimistic task draft to the real task id without losing content", () => {
    const helpers = loadMobileConversationCacheHelpers();
    const drafts: Record<string, { text: string }> = Object.create(null);
    const order: string[] = [];
    const temporary = helpers.conversationStateKey("grok", "local-new-1");
    const created = helpers.conversationStateKey("grok", "real-thread-1");

    helpers.setBoundedConversationValue(
      drafts,
      order,
      temporary,
      { text: "创建期间输入的内容" },
      40,
    );
    helpers.moveConversationValue(drafts, order, temporary, created, 40);

    expect(helpers.getBoundedConversationValue(drafts, order, temporary)).toBeNull();
    expect(helpers.getBoundedConversationValue(drafts, order, created)).toEqual({
      text: "创建期间输入的内容",
    });
  });

  test("keeps a created but unsent task as the reusable local draft", () => {
    const helpers = loadMobileConversationCacheHelpers();
    const remote = [{ threadId: "real-1", title: "服务端标题", status: "idle" }];
    const local = [{
      threadId: "real-1",
      title: "新 Codex 任务",
      status: "idle",
      localCreationState: "ready",
      localSourceThreadId: "",
    }];

    const merged = helpers.mergeTasksWithLocalDrafts(remote, local);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      threadId: "real-1",
      title: "服务端标题",
      localCreationState: "ready",
    });
    expect(helpers.findReusableLocalTask(merged)).toBe(merged[0]);
  });

  test("reuses the unfinished new task and only ends draft mode on first submit", () => {
    const start = CODEX_MOBILE_JS.indexOf("  async function createTask(");
    const end = CODEX_MOBILE_JS.indexOf("\n  async function selectTask(", start);
    const block = CODEX_MOBILE_JS.slice(start, end);

    expect(block).toContain("var reusableTask = currentLocalTaskDraft();");
    expect(block).toContain("await selectTask(reusableTask.threadId, true);");
    expect(block).toContain('localCreationState: "ready"');
    expect(CODEX_MOBILE_JS).toContain("localTaskDrafts: Object.create(null)");
    expect(CODEX_MOBILE_JS).toContain("rememberLocalTaskDraft(task);");
    expect(CODEX_MOBILE_JS).toContain("forgetLocalTaskDraft(state.currentAdapter, threadId);");
    expect(CODEX_MOBILE_JS).toContain(
      'if (task && task.localCreationState === "ready") finishLocalTaskDraft(task.threadId);',
    );
    expect(CODEX_MOBILE_JS).toContain(
      "if (!waiting.length) return;\n    finishLocalTaskDraft(threadId);",
    );
    expect(CODEX_MOBILE_JS).toContain(
      "var waitingForTaskCreation = taskNeedsCreation(task);",
    );
  });

  test("shows an optimistic task before waiting for desktop creation and preserves failed input", () => {
    const start = CODEX_MOBILE_JS.indexOf("  async function createTask(");
    const end = CODEX_MOBILE_JS.indexOf("\n  async function selectTask(", start);
    const block = CODEX_MOBILE_JS.slice(start, end);
    const insertIndex = block.indexOf("state.tasks.unshift(temporaryTask);");
    const selectIndex = block.indexOf("await selectTask(temporaryTask.threadId, true);");
    const requestIndex = block.indexOf("var payload = await api(createPath");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(insertIndex).toBeGreaterThan(-1);
    expect(selectIndex).toBeGreaterThan(insertIndex);
    expect(requestIndex).toBeGreaterThan(selectIndex);
    expect(block).toContain('temporaryTask.localCreationState = "failed";');
    expect(
      block.includes("创建失败，输入内容已保留") ||
        block.includes("\\u521B\\u5EFA\\u5931\\u8D25\\uFF0C\\u8F93\\u5165\\u5185\\u5BB9\\u5DF2\\u4FDD\\u7559"),
    ).toBe(true);
    expect(block).not.toContain('composerInput.value = "";');
    expect(CODEX_MOBILE_JS).toContain(
      "task && task.localCreationState === \"creating\"",
    );
    expect(CODEX_MOBILE_JS).toContain(
      "var localTasks = state.tasks.filter(isTemporaryTask);",
    );
  });

  test("restores cached messages and the task draft synchronously before live refresh", () => {
    const state: Record<string, any> = {
      currentThreadId: "task-a",
      conversationSnapshots: Object.create(null),
      conversationSnapshotOrder: [],
      composerDrafts: Object.create(null),
      composerDraftOrder: [],
      messageNodes: Object.create(null),
      pendingImages: [],
    };
    const composerInput = { value: "", placeholder: "" };
    const runtime = loadMobileConversationSnapshotRuntime({ state, composerInput });
    const key = runtime.conversationStateKey("codex", "task-a");
    runtime.setBoundedConversationValue(
      state.composerDrafts,
      state.composerDraftOrder,
      key,
      { text: "尚未发送的草稿" },
      40,
    );
    runtime.setBoundedConversationValue(
      state.conversationSnapshots,
      state.conversationSnapshotOrder,
      key,
      {
        serverMessages: [{ role: "assistant", text: "已缓存回复" }],
        historyMessages: [],
        latestMessages: [{ role: "assistant", text: "已缓存回复" }],
        oldestMessageCursor: null,
        hasOlderMessages: false,
        historySource: "native",
        historyCaughtUp: true,
        progressItems: [],
        optimisticProgressTurnId: null,
        pendingMessages: [],
        transcriptSignature: "cached",
        queueSignature: "",
        queuedMessages: [],
        editingQueuedMessageId: "",
        editingQueuedImageCount: 0,
        editingQueuedText: "",
        pendingImages: [{ fileName: "草稿图片.png", previewUrl: "data:image/png;base64,AA==" }],
        runSummary: null,
        localRunSummary: null,
        pendingApproval: null,
        approvalResults: [],
        stopRequestedThreadId: "",
        scrollTop: 18,
        nearBottom: false,
      },
      12,
    );

    expect(runtime.restoreConversationSnapshot("codex", "task-a")).toBe(true);
    expect(state.serverMessages).toEqual([{ role: "assistant", text: "已缓存回复" }]);
    expect(composerInput.value).toBe("尚未发送的草稿");
    expect(state.pendingImages).toEqual([
      { fileName: "草稿图片.png", previewUrl: "data:image/png;base64,AA==" },
    ]);
    expect(runtime.renderEvents).toContain("messages");
    expect(runtime.renderEvents.indexOf("messages")).toBeLessThan(
      runtime.renderEvents.indexOf("navigation"),
    );
  });
});

describe("Codex mobile persistent cache", () => {
  test("restores the cached task list and selected conversation before live refresh", () => {
    const storage = createMemoryStorage();
    const nowMs = 1_800_000_000_000;
    const state = createPersistentCacheTestState();
    const runtime = loadMobilePersistentCacheRuntime({ state, storage, nowMs });
    storage.setItem(runtime.storageKey, JSON.stringify({
      schemaVersion: runtime.schemaVersion,
      savedAtMs: nowMs - 2_000,
      currentAdapter: "codex",
      adapters: [
        { id: "codex", label: "Codex" },
        { id: "deepseek", label: "DeepSeek Harness" },
      ],
      taskSnapshots: {
        codex: {
          currentThreadId: "task-a",
          tasks: [
            { threadId: "task-a", title: "缓存任务 A", status: "idle" },
          ],
        },
      },
      taskSnapshotOrder: ["codex"],
      conversationSnapshots: {
        [runtime.conversationStateKey("codex", "task-a")]: {
          serverMessages: [{ role: "assistant", text: "缓存中的最近回复" }],
          historyMessages: [],
          latestMessages: [{ role: "assistant", text: "缓存中的最近回复" }],
          oldestMessageCursor: null,
          hasOlderMessages: false,
          historySource: "native",
          historyCaughtUp: true,
          progressItems: [],
          optimisticProgressTurnId: null,
          pendingMessages: [],
          transcriptSignature: "cached",
          queueSignature: "",
          queuedMessages: [],
          editingQueuedMessageId: "",
          editingQueuedImageCount: 0,
          editingQueuedText: "",
          pendingImages: [],
          runSummary: null,
          localRunSummary: null,
          pendingApproval: null,
          approvalResults: [],
          stopRequestedThreadId: "",
          scrollTop: 24,
          nearBottom: false,
        },
      },
      conversationSnapshotOrder: [runtime.conversationStateKey("codex", "task-a")],
      composerDrafts: {
        [runtime.conversationStateKey("codex", "task-a")]: { text: "跨刷新草稿" },
      },
      composerDraftOrder: [runtime.conversationStateKey("codex", "task-a")],
      taskBoard: {
        tasks: [{ adapter: "codex", threadId: "task-a", title: "缓存看板任务" }],
        recentCompleted: [{ adapter: "grok", threadId: "done-a", title: "缓存已完成任务" }],
        lastLoadedAtMs: nowMs - 2_000,
      },
    }));

    expect(runtime.restorePersistentMobileCache("codex", "task-a")).toBe(true);
    expect(state.tasks).toEqual([
      { threadId: "task-a", title: "缓存任务 A", status: "idle" },
    ]);
    expect(state.currentThreadId).toBe("task-a");
    expect(state.adapters).toEqual([
      { id: "codex", label: "Codex", status: "" },
      { id: "deepseek", label: "DeepSeek Harness", status: "" },
    ]);
    expect(state.serverMessages).toEqual([
      { role: "assistant", text: "缓存中的最近回复" },
    ]);
    expect(runtime.composerInput.value).toBe("跨刷新草稿");
    expect(state.boardTasks).toEqual([
      { adapter: "codex", threadId: "task-a", title: "缓存看板任务" },
    ]);
    expect(state.boardRecentCompleted).toEqual([
      { adapter: "grok", threadId: "done-a", title: "缓存已完成任务" },
    ]);
    expect(state.boardLastLoadedAtMs).toBe(nowMs - 2_000);
    expect(runtime.renderEvents).toContain("messages");
  });

  test("ignores expired or incompatible cache and removes it", () => {
    const nowMs = 1_800_000_000_000;
    const expiredStorage = createMemoryStorage();
    const expiredRuntime = loadMobilePersistentCacheRuntime({
      state: createPersistentCacheTestState(),
      storage: expiredStorage,
      nowMs,
    });
    expiredStorage.setItem(expiredRuntime.storageKey, JSON.stringify({
      schemaVersion: expiredRuntime.schemaVersion,
      savedAtMs: nowMs - expiredRuntime.ttlMs - 1,
    }));
    expect(expiredRuntime.restorePersistentMobileCache("codex", "task-a")).toBe(false);
    expect(expiredStorage.getItem(expiredRuntime.storageKey)).toBeNull();

    const incompatibleStorage = createMemoryStorage();
    const incompatibleRuntime = loadMobilePersistentCacheRuntime({
      state: createPersistentCacheTestState(),
      storage: incompatibleStorage,
      nowMs,
    });
    incompatibleStorage.setItem(incompatibleRuntime.storageKey, JSON.stringify({
      schemaVersion: incompatibleRuntime.schemaVersion + 1,
      savedAtMs: nowMs,
    }));
    expect(incompatibleRuntime.restorePersistentMobileCache("codex", "task-a")).toBe(false);
    expect(incompatibleStorage.getItem(incompatibleRuntime.storageKey)).toBeNull();
  });

  test("persists bounded display data without images, approvals, tokens, or other adapters leaking", () => {
    const storage = createMemoryStorage();
    const nowMs = 1_800_000_000_000;
    const state = createPersistentCacheTestState();
    state.authenticated = true;
    state.adapters = [
      { id: "codex", label: "Codex", status: "running", secret: "no-cache" },
      { id: "deepseek", label: "DeepSeek Harness", status: "idle" },
    ];
    state.currentAdapter = "codex";
    state.currentThreadId = "shared-id";
    state.tasks = [{
      threadId: "shared-id",
      title: "Codex 任务",
      status: "running",
      projectName: "WeRelay",
      projectPath: "/Users/example/project",
    }];
    state.serverMessages = Array.from({ length: 90 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      text: `消息 ${index}`,
    }));
    state.historyMessages = [];
    state.latestMessages = state.serverMessages.slice();
    state.pendingImages = [{ dataBase64: "SECRET_IMAGE", fileName: "secret.png" }];
    state.pendingApproval = { command: "cat /Users/example/secret" };
    state.approvalResults = [{ summary: "secret approval" }];
    state.queuedMessages = [{ text: "secret queued input" }];
    state.composerDrafts[runtimeKey("codex", "shared-id")] = { text: "保留草稿" };
    state.composerDraftOrder.push(runtimeKey("codex", "shared-id"));
    const runtime = loadMobilePersistentCacheRuntime({ state, storage, nowMs });

    expect(runtime.persistMobileCacheNow()).toBe(true);
    const raw = storage.getItem(runtime.storageKey) || "";
    const payload = JSON.parse(raw);
    const snapshot = payload.conversationSnapshots[runtime.conversationStateKey("codex", "shared-id")];
    expect(snapshot.serverMessages).toHaveLength(60);
    expect(snapshot.serverMessages[0].text).toBe("消息 30");
    expect(snapshot.pendingImages).toEqual([]);
    expect(snapshot.pendingApproval).toBeNull();
    expect(snapshot.approvalResults).toEqual([]);
    expect(snapshot.queuedMessages).toEqual([]);
    expect(payload.adapters).toEqual([
      { id: "codex", label: "Codex", status: "" },
      { id: "deepseek", label: "DeepSeek Harness", status: "" },
    ]);
    expect(raw).not.toContain("SECRET_IMAGE");
    expect(raw).not.toContain("secret approval");
    expect(raw).not.toContain("secret queued input");
    expect(raw).not.toContain("/Users/example/project");

    const otherState = createPersistentCacheTestState();
    const otherRuntime = loadMobilePersistentCacheRuntime({
      state: otherState,
      storage,
      nowMs,
    });
    expect(otherRuntime.restorePersistentMobileCache("grok", "shared-id")).toBe(false);
    expect(otherState.serverMessages).toEqual([]);
  });

  test("falls back silently when browser storage is unavailable and clears cache on logout", () => {
    const throwingStorage = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("quota"); },
      removeItem() { throw new Error("blocked"); },
    };
    const state = createPersistentCacheTestState();
    state.authenticated = true;
    const runtime = loadMobilePersistentCacheRuntime({
      state,
      storage: throwingStorage,
      nowMs: 1_800_000_000_000,
    });
    expect(runtime.restorePersistentMobileCache("codex", "task-a")).toBe(false);
    expect(runtime.persistMobileCacheNow()).toBe(false);
    expect(() => runtime.clearPersistentMobileCache()).not.toThrow();

    expect(CODEX_MOBILE_JS).toContain("clearPersistentMobileCache();");
  });

  test("shows authenticated cache first and refreshes adapters, tasks, and messages asynchronously", () => {
    const start = CODEX_MOBILE_JS.indexOf("  function startAuthenticatedApp");
    const end = CODEX_MOBILE_JS.indexOf("\n  function taskStatusLabel", start);
    const block = CODEX_MOBILE_JS.slice(start, end);
    const restoreIndex = block.indexOf("restorePersistentMobileCache(");
    const appVisibleIndex = block.indexOf("app.hidden = false;");
    const refreshIndex = block.indexOf("void refreshAuthenticatedApp(");

    expect(start).toBeGreaterThan(-1);
    expect(restoreIndex).toBeGreaterThan(-1);
    expect(appVisibleIndex).toBeGreaterThan(restoreIndex);
    expect(refreshIndex).toBeGreaterThan(appVisibleIndex);
    expect(block).toContain("async function refreshAuthenticatedApp");
    expect(block).toContain("await loadAdapters();");
    expect(block).toContain("await loadTasks(true);");
  });

  test("opens the cached task board immediately and refreshes it silently", () => {
    const loadStart = CODEX_MOBILE_JS.indexOf("  async function loadTaskBoard");
    const loadEnd = CODEX_MOBILE_JS.indexOf("\n  function setTaskBoardView", loadStart);
    const loadBlock = CODEX_MOBILE_JS.slice(loadStart, loadEnd);
    const openStart = CODEX_MOBILE_JS.indexOf("  function setTaskBoardOpen");
    const openEnd = CODEX_MOBILE_JS.indexOf("\n  function taskBoardSearch", openStart);
    const openBlock = CODEX_MOBILE_JS.slice(openStart, openEnd);

    expect(loadBlock).toContain("state.boardTasks.length");
    expect(loadBlock).toContain("if (error.network && hasCachedBoard) return;");
    expect(openBlock.indexOf("renderTaskBoard();")).toBeLessThan(
      openBlock.indexOf("void loadTaskBoard(false);")
    );
  });

  test("shows the target adapter cache before waiting for the desktop switch", () => {
    const start = CODEX_MOBILE_JS.indexOf("  async function switchAdapter");
    const end = CODEX_MOBILE_JS.indexOf("\n  function showAuthentication", start);
    const block = CODEX_MOBILE_JS.slice(start, end);
    const restoreIndex = block.indexOf('restoreCachedAdapterState(adapterId, "");');
    const requestIndex = block.indexOf('await api(\n        "/api/adapters/"');

    expect(restoreIndex).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(restoreIndex);
  });
});

describe("Codex mobile approval consistency", () => {
  test("keeps the sidebar, header, and approval card on one authoritative status", () => {
    const reconcile = loadMobileTaskApprovalStatusReconciler();
    const staleTask = { threadId: "thread-1", title: "任务", status: "approval" };

    expect(reconcile(staleTask, null, { status: "running" })).toEqual({
      ...staleTask,
      status: "running",
    });
    expect(reconcile(staleTask, null, { status: "completed" })).toEqual({
      ...staleTask,
      status: "idle",
    });
    expect(reconcile(
      { ...staleTask, status: "running" },
      { requestId: "approval-1" },
      { status: "running" },
    )).toEqual({
      ...staleTask,
      status: "approval",
    });
  });
});

describe("Codex mobile web rendering", () => {
  test("resolves full task ids and rejects ambiguous legacy prefixes", () => {
    const resolveTaskSelector = loadMobileTaskSelector();
    const tasks = [
      { threadId: "0000000a-aaaa", title: "任务 A" },
      { threadId: "0000000a-bbbb", title: "任务 B" },
      { threadId: "0000000c-cccc", title: "任务 C" },
    ];

    expect(resolveTaskSelector(tasks, "0000000a-bbbb")).toEqual(tasks[1]);
    expect(resolveTaskSelector(tasks, "0000000c")).toEqual(tasks[2]);
    expect(resolveTaskSelector(tasks, "0000000a")).toBeNull();
  });

  test("chooses the current project task for project-scoped creation", () => {
    const { projectTaskCreationSource } = loadMobileTaskSidebarHelpers();
    const tasks = [
      { threadId: "task-a", canCreateInProject: true },
      { threadId: "task-b", canCreateInProject: true },
    ];

    expect(projectTaskCreationSource(tasks, "task-b")).toEqual(tasks[1]);
    expect(projectTaskCreationSource(tasks, "missing")).toEqual(tasks[0]);
    expect(projectTaskCreationSource([
      { threadId: "unsupported", canCreateInProject: false },
    ], "unsupported")).toBeNull();
    expect(CODEX_MOBILE_CSS).toContain(".task-group-create");
    expect(CODEX_MOBILE_JS).toContain("task-group-create");
  });

  test("does not rebuild the transcript when only the running clock advances", () => {
    const runSummaryRenderKey = loadMobileRunSummaryRenderKey();
    const base = {
      turnId: "turn-running",
      status: "running",
      startedAtMs: 1_800_000_000_000,
    };

    expect(runSummaryRenderKey({
      ...base,
      durationMs: 3_000,
      receivedAtMs: 1_800_000_003_000,
    })).toEqual(runSummaryRenderKey({
      ...base,
      durationMs: 8_000,
      receivedAtMs: 1_800_000_008_000,
    }));
    expect(runSummaryRenderKey({ ...base, status: "completed" })).not.toEqual(
      runSummaryRenderKey(base),
    );
    expect(runSummaryRenderKey({ ...base, status: "failed", errorMessage: "账号不可用" }))
      .not.toEqual(runSummaryRenderKey({ ...base, status: "failed" }));
  });

  test("shows a failed run reason instead of an empty completed result", () => {
    const runFailureText = loadMobileRunFailureText();
    expect(runFailureText({
      status: "failed",
      errorMessage: "当前模型 gpt-5.4 暂时没有可用账号，未生成回复。",
    })).toBe("当前模型 gpt-5.4 暂时没有可用账号，未生成回复。");
    expect(runFailureText({ status: "failed" })).toBe(
      "任务执行失败，未生成 AI 回复。请重试。",
    );
    expect(runFailureText({ status: "completed", errorMessage: "不应显示" })).toBe("");
    expect(CODEX_MOBILE_CSS).toContain(".run-failure");
  });

  test("navigates between user messages and hides directions at either boundary", () => {
    const resolveUserMessageNavigation = loadMobileUserMessageNavigator();
    const offsets = [120, 520, 930];

    expect(resolveUserMessageNavigation(offsets, 0, 72)).toEqual({
      previousIndex: -1,
      nextIndex: 0,
    });
    expect(resolveUserMessageNavigation(offsets, 448, 72)).toEqual({
      previousIndex: 0,
      nextIndex: 2,
    });
    expect(resolveUserMessageNavigation(offsets, 858, 72)).toEqual({
      previousIndex: 1,
      nextIndex: -1,
    });
  });

  test("shows the real model only at the end of an assistant reply", () => {
    const visibleMessageModel = loadVisibleMessageModel();
    expect(visibleMessageModel({
      role: "assistant",
      phase: "final_answer",
      model: " gpt-5.6-sol ",
    })).toBe("gpt-5.6-sol");
    expect(visibleMessageModel({
      role: "assistant",
      phase: "commentary",
      model: "gpt-5.6-sol",
    })).toBe("");
    expect(visibleMessageModel({ role: "user", model: "gpt-5.6-sol" })).toBe("");
    expect(visibleMessageModel({ role: "assistant" })).toBe("");
  });

  test("hides screenshot transport labels while keeping the real user request", () => {
    const visibleMessageText = loadMobileVisibleMessageText();
    expect(visibleMessageText({
      role: "user",
      text: "图片：png1 png2\n请对比两个页面。\n[image]</image>",
    })).toBe("请对比两个页面。");
    expect(visibleMessageText({ role: "user", text: "图片：png1\n[image]" })).toBe("已发送图片");
    expect(visibleMessageText({ role: "assistant", text: "图片：png1 是正文" })).toBe("图片：png1 是正文");
  });

  test("folds long code or output blocks but keeps short snippets expanded", () => {
    const renderMarkdown = loadMobileMarkdownRenderer();
    const longBlock = renderMarkdown(`\`\`\`\n${Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join("\n")}\n\`\`\``, "message-42");
    const shortBlock = renderMarkdown("```\nline 1\nline 2\n```");

    expect(longBlock).toContain('<details class="message-code-fold" data-fold-key="message-42:1">');
    expect(longBlock).toContain('data-fold-key="message-42:1"');
    expect(longBlock).toContain("代码 / 输出 · 7 行");
    expect(shortBlock).not.toContain('class="message-code-fold"');
    expect(shortBlock).toContain("<pre><code>line 1\nline 2</code></pre>");
  });

  test("keeps the plan and latest progress visible while folding older completed activity", () => {
    const partitionProgressItems = loadMobileProgressPartitioner();
    const items = [
      { id: "plan", kind: "plan", status: "running", text: "第 3 / 5 步" },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `done-${index + 1}`,
        kind: "command",
        status: "completed",
        text: `已运行命令 ${index + 1}`,
      })),
      { id: "running", kind: "file", status: "running", text: "正在修改文件" },
    ];

    const result = partitionProgressItems(items);
    expect(result.pinned.map((item) => item.id)).toEqual(["plan"]);
    expect(result.hidden.map((item) => item.id)).toEqual(["done-1", "done-2", "done-3"]);
    expect(result.visible.map((item) => item.id)).toEqual([
      "done-4",
      "done-5",
      "done-6",
      "running",
    ]);
  });

  test("shows terminal-switch feedback immediately and keeps elapsed time visible", () => {
    const switchProgressLabel = loadMobileSwitchProgressFormatter();
    expect(switchProgressLabel(1_800_000_000_000, 1_800_000_002_000)).toBe("连接中 · 0m 2s");
    expect(switchProgressLabel(1_800_000_000_000, 1_800_000_015_000)).toBe("仍在连接 · 0m 15s");
  });

  test("shows a likely queued follow-up immediately and reconciles it by server id", () => {
    const mergeQueuedMessagesForDisplay = loadMobileQueuedMessageMerger();
    const pending = {
      clientId: "mobile-pending",
      text: "等待当前任务结束后发送",
      imageCount: 1,
      status: "sending",
      displayInTranscript: false,
      createdAtMs: 1_800_000_000_000,
    };

    expect(mergeQueuedMessagesForDisplay([], [pending])).toEqual([{
      id: "mobile-pending",
      text: "等待当前任务结束后发送",
      imageCount: 1,
      createdAtMs: 1_800_000_000_000,
      optimistic: true,
      status: "sending",
    }]);
    expect(mergeQueuedMessagesForDisplay(
      [{ id: "queued-real", text: pending.text, imageCount: 1 }],
      [{ ...pending, status: "queued", queuedMessageId: "queued-real" }],
    )).toEqual([{ id: "queued-real", text: pending.text, imageCount: 1 }]);
  });

  test("hides a confirmed queue card once the same input is the active transcript turn", () => {
    const mergeQueuedMessagesForDisplay = loadMobileQueuedMessageMerger();
    expect(mergeQueuedMessagesForDisplay(
      [{
        id: "queued-real",
        text: "只处理一次",
        imageCount: 0,
        createdAtMs: 9_000,
      }],
      [],
      [{ role: "user", text: "只处理一次", turnId: "turn-current" }],
      { status: "running", turnId: "turn-current", startedAtMs: 10_000 },
    )).toEqual([]);
    expect(mergeQueuedMessagesForDisplay(
      [{ id: "queued-real", text: "下一条再处理", imageCount: 0 }],
      [],
      [{ role: "user", text: "当前任务", turnId: "turn-current" }],
      { status: "running", turnId: "turn-current", startedAtMs: 10_000 },
    )).toHaveLength(1);
    expect(mergeQueuedMessagesForDisplay(
      [{
        id: "queued-intentional-repeat",
        text: "只处理一次",
        imageCount: 0,
        createdAtMs: 11_000,
      }],
      [],
      [{ role: "user", text: "只处理一次", turnId: "turn-current" }],
      { status: "running", turnId: "turn-current", startedAtMs: 10_000 },
    )).toHaveLength(1);
    expect(mergeQueuedMessagesForDisplay(
      [{
        id: "queued-consumed",
        text: "只处理一次",
        imageCount: 0,
        createdAtMs: 9_000,
      }, {
        id: "queued-repeat",
        text: "只处理一次",
        imageCount: 0,
        createdAtMs: 9_500,
      }],
      [],
      [{ role: "user", text: "只处理一次", turnId: "turn-current" }],
      { status: "running", turnId: "turn-current", startedAtMs: 10_000 },
    )).toEqual([{
      id: "queued-repeat",
      text: "只处理一次",
      imageCount: 0,
      createdAtMs: 9_500,
    }]);
  });

  test("does not show transcript or failed pending messages in the composer queue", () => {
    const mergeQueuedMessagesForDisplay = loadMobileQueuedMessageMerger();
    expect(mergeQueuedMessagesForDisplay([], [
      {
        clientId: "sent-directly",
        text: "直接发送",
        imageCount: 0,
        status: "sending",
        displayInTranscript: true,
      },
      {
        clientId: "failed",
        text: "发送失败",
        imageCount: 0,
        status: "failed",
        displayInTranscript: false,
      },
    ])).toEqual([]);
  });

  test("removes an optimistic message as soon as the real user message appears", () => {
    const reconcilePendingMessages = loadMobilePendingMessageReconciler();
    const pending = [{
      clientId: "mobile-new",
      text: "只发送一次",
      imageCount: 0,
      status: "sending",
      baselineUserCount: 20,
      baselineUserKeys: ["id:old-user"],
    }];

    expect(reconcilePendingMessages(pending, [
      { id: "new-user", role: "user", text: "只发送一次" },
    ])).toEqual([]);
  });

  test("shows a timed run header even when the runtime summary is temporarily missing", () => {
    const resolveVisibleRunSummary = loadMobileRunSummaryResolver();
    const nowMs = 1_800_000_100_000;
    const messages = [{ role: "assistant", turnId: "turn-latest" }];

    expect(resolveVisibleRunSummary(
      messages,
      { status: "running", startedAtMs: nowMs - 12_000 },
      null,
      nowMs,
    )).toMatchObject({
      turnId: "turn-latest",
      status: "running",
      startedAtMs: nowMs - 12_000,
      durationMs: 12_000,
    });
    expect(resolveVisibleRunSummary(
      messages,
      { status: "idle" },
      null,
      nowMs,
    )).toBeNull();
    expect(resolveVisibleRunSummary(
      [{ role: "user", turnId: "turn-new" }],
      { status: "idle" },
      {
        turnId: "turn-old",
        status: "completed",
        startedAtMs: nowMs - 20_000,
        durationMs: 15_000,
      },
      nowMs,
    )).toBeNull();
    expect(resolveVisibleRunSummary(
      messages,
      { status: "idle" },
      {
        turnId: "turn-new",
        status: "running",
        startedAtMs: nowMs - 2_000,
        durationMs: 2_000,
      },
      nowMs,
    )).toMatchObject({
      turnId: "turn-new",
      status: "running",
      durationMs: 2_000,
    });
  });

  test("uses the composer button for stop only while running with empty input", () => {
    const shouldUseStopComposerAction = loadMobileComposerActionPredicate();

    expect(shouldUseStopComposerAction(
      { status: "running" },
      { status: "running" },
      false,
    )).toBe(true);
    expect(shouldUseStopComposerAction(
      { status: "running" },
      { status: "running" },
      true,
    )).toBe(false);
    expect(shouldUseStopComposerAction(
      { status: "idle" },
      { status: "completed" },
      false,
    )).toBe(false);
  });

  test("keeps project expansion bounded and resets it after collapsing", () => {
    const helpers = loadMobileTaskSidebarHelpers();
    const collapsedGroups: Record<string, boolean> = {};
    const visibleLimits: Record<string, number> = { "project:alpha": 15 };

    expect(helpers.projectBatchSize).toBe(5);
    expect(helpers.recentBatchSize).toBe(20);
    expect(helpers.nextTaskVisibleLimit(5, 18, 5)).toBe(10);
    expect(helpers.nextTaskVisibleLimit(15, 18, 5)).toBe(18);

    helpers.setProjectGroupCollapsed(
      collapsedGroups,
      visibleLimits,
      "project:alpha",
      true,
    );
    expect(collapsedGroups["project:alpha"]).toBe(true);
    expect(visibleLimits["project:alpha"]).toBeUndefined();

    helpers.setProjectGroupCollapsed(
      collapsedGroups,
      visibleLimits,
      "project:alpha",
      false,
    );
    expect(collapsedGroups["project:alpha"]).toBeUndefined();
    expect(visibleLimits["project:alpha"]).toBe(5);
  });

  test("sorts the recent view by the newest task timestamp", () => {
    const { sortTasksByRecency } = loadMobileTaskSidebarHelpers();
    const tasks = [
      { threadId: "older", lastUpdatedAt: "2026-08-01T12:00:00.000Z" },
      { threadId: "newest", lastUpdatedAt: "2026-08-02T12:00:00.000Z" },
      { threadId: "middle", lastUpdatedAt: "2026-08-02T08:00:00.000Z" },
    ];

    expect(sortTasksByRecency(tasks).map((task) => task.threadId)).toEqual([
      "newest",
      "middle",
      "older",
    ]);
    expect(tasks.map((task) => task.threadId)).toEqual(["older", "newest", "middle"]);
  });

  test("classifies one unified task board without grouping by agent", () => {
    const {
      taskBoardLane,
      isTaskBoardInProgress,
      taskBoardMatchesQuery,
      formatTaskBoardTime,
    } = loadMobileTaskSidebarHelpers();

    expect(taskBoardLane({ status: "running", completedAt: "2026-08-07T01:00:00.000Z" }))
      .toBe("running");
    expect(taskBoardLane({ status: "approval" })).toBe("waiting");
    expect(taskBoardLane({ status: "input" })).toBe("waiting");
    expect(taskBoardLane({ status: "error" })).toBe("error");
    expect(taskBoardLane({ status: "idle", completedAt: "2026-08-07T01:00:00.000Z" }))
      .toBe("completed");
    expect(taskBoardLane({ status: "idle" })).toBe("queued");
    expect(isTaskBoardInProgress({ status: "running" })).toBe(true);
    expect(isTaskBoardInProgress({ status: "approval" })).toBe(true);
    expect(isTaskBoardInProgress({ status: "input" })).toBe(true);
    expect(isTaskBoardInProgress({ status: "idle" })).toBe(false);
    expect(isTaskBoardInProgress({ status: "error" })).toBe(false);
    expect(CODEX_MOBILE_JS).toContain(
      "var activeCount = state.boardTasks.filter(isTaskBoardInProgress).length;",
    );
    expect(taskBoardMatchesQuery({
      title: "统一任务看板",
      projectName: "WeRelay",
      adapterLabel: "Codex",
    }, "codex")).toBe(true);
    expect(formatTaskBoardTime(
      "2026-08-07T02:30:00.000Z",
      Date.parse("2026-08-07T03:00:00.000Z"),
    )).toBe("30 分钟前");
  });

  test("adapts mobile task terminal labels to the currently rendered page", () => {
    const { shouldShowTaskAdapterLabels } = loadMobileTaskSidebarHelpers();
    const pageOne = [{ adapter: "codex" }, { adapter: "codex" }];
    const pageTwo = [{ adapter: "codex" }, { adapter: "workbuddy" }];

    expect(shouldShowTaskAdapterLabels([])).toBe(false);
    expect(shouldShowTaskAdapterLabels([{ adapter: "codex" }])).toBe(false);
    expect(shouldShowTaskAdapterLabels(pageOne)).toBe(false);
    expect(shouldShowTaskAdapterLabels(pageTwo)).toBe(true);
    expect(CODEX_MOBILE_JS).toContain(
      "var showAdapterLabels = shouldShowTaskAdapterLabels(tasks);",
    );
    expect(CODEX_MOBILE_JS).toContain(
      "var showAdapterLabels = shouldShowTaskAdapterLabels(items);",
    );
  });

  test("uses a single-column touch layout for the task board on phones", () => {
    expect(CODEX_MOBILE_CSS).toContain(".task-board-columns { width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr);");
    expect(CODEX_MOBILE_CSS).toContain(".task-board-column.is-empty { display: none; }");
    expect(CODEX_MOBILE_CSS).toContain(".task-board-body { overflow-x: hidden;");
    expect(CODEX_MOBILE_CSS).not.toContain(".task-board-column { width: min(84vw, 320px);");
  });

  test("gives every task-board card a direct task link", () => {
    const href = loadMobileTaskBoardHref(
      "https://relay.example.com/?view=board&board=completed&appv=123",
    );

    expect(href({ adapter: "workbuddy", threadId: "task-123" })).toBe(
      "/?appv=123&adapter=workbuddy&task=task-123",
    );
    expect(CODEX_MOBILE_JS).toContain("card.href = taskBoardTaskHref(task);");
    expect(CODEX_MOBILE_JS).toContain("button.href = taskBoardTaskHref(item);");
  });

  test("preserves ordered-list numbers when bullet sections split the list", () => {
    const renderMarkdown = loadMobileMarkdownRenderer();
    const html = renderMarkdown([
      "1. 第一项",
      "",
      "- 第一项说明",
      "",
      "2. 第二项",
      "",
      "- 第二项说明",
      "",
      "3. 第三项",
    ].join("\n"));

    expect(html).toContain('<ol start="1"><li value="1">第一项</li></ol>');
    expect(html).toContain('<ol start="2"><li value="2">第二项</li></ol>');
    expect(html).toContain('<ol start="3"><li value="3">第三项</li></ol>');
  });

  test("replaces an accelerated history suffix with the native live tail without duplicates", () => {
    const mergeMessagePages = loadMobileMessagePageMerger();
    const merged = mergeMessagePages(
      [
        { role: "assistant", text: "更早的历史" },
        { role: "assistant", text: "已改好并部署" },
        { role: "user", text: '网页消息顺序不对\n<image path="local.png">' },
        { role: "assistant", text: "[tool_use]" },
        { role: "assistant", text: "正在排查" },
      ],
      [
        {
          id: "native-older",
          turnId: "turn-older",
          role: "user",
          text: "补充一条原生历史",
        },
        {
          id: "native-answer",
          turnId: "turn-previous",
          phase: "final_answer",
          role: "assistant",
          text: "已改好并部署",
        },
        {
          id: "native-user",
          turnId: "turn-current",
          role: "user",
          text: "网页消息顺序不对",
        },
        {
          id: "native-running",
          turnId: "turn-current",
          phase: "final_answer",
          role: "assistant",
          text: "正在排查",
        },
      ],
    );

    expect(merged).toEqual([
      { role: "assistant", text: "更早的历史" },
      {
        id: "native-older",
        turnId: "turn-older",
        role: "user",
        text: "补充一条原生历史",
      },
      {
        id: "native-answer",
        turnId: "turn-previous",
        phase: "final_answer",
        role: "assistant",
        text: "已改好并部署",
      },
      {
        id: "native-user",
        turnId: "turn-current",
        role: "user",
        text: "网页消息顺序不对",
      },
      {
        id: "native-running",
        turnId: "turn-current",
        phase: "final_answer",
        role: "assistant",
        text: "正在排查",
      },
    ]);
  });
});

describe("Codex mobile server", () => {
  test("serves one authenticated task board across adapters", async () => {
    const authStore = createAuthStore("a configured mobile password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTaskBoard: async () => ({
        tasks: [
          {
            adapter: "codex",
            adapterLabel: "Codex",
            threadId: "codex-running",
            title: "实现统一任务看板",
            status: "running",
            lastUpdatedAt: "2026-08-07T03:00:00.000Z",
          },
          {
            adapter: "grok",
            adapterLabel: "Grok",
            threadId: "grok-approval",
            title: "检查发布说明",
            status: "approval",
            lastUpdatedAt: "2026-08-07T02:00:00.000Z",
          },
        ],
        recentCompleted: [
          {
            adapter: "workbuddy",
            adapterLabel: "WorkBuddy",
            threadId: "workbuddy-complete",
            title: "修复桌面同步",
            completedAt: "2026-08-07T01:00:00.000Z",
          },
        ],
      }),
      listTasks: async () => [],
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
      }),
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const unauthorized = await fetch(
        `http://127.0.0.1:${server.port}/api/task-board`,
      );
      expect(unauthorized.status).toBe(401);

      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/task-board`,
        { headers: { cookie: sessionCookie } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        tasks: [
          {
            adapter: "codex",
            adapterLabel: "Codex",
            threadId: "codex-running",
            title: "实现统一任务看板",
            status: "running",
            lastUpdatedAt: "2026-08-07T03:00:00.000Z",
          },
          {
            adapter: "grok",
            adapterLabel: "Grok",
            threadId: "grok-approval",
            title: "检查发布说明",
            status: "approval",
            lastUpdatedAt: "2026-08-07T02:00:00.000Z",
          },
        ],
        recentCompleted: [
          {
            adapter: "workbuddy",
            adapterLabel: "WorkBuddy",
            threadId: "workbuddy-complete",
            title: "修复桌面同步",
            completedAt: "2026-08-07T01:00:00.000Z",
          },
        ],
      });
    } finally {
      await server.close();
    }
  });

  test("returns a clear recoverable error when the selected adapter is not connected", async () => {
    const authStore = createAuthStore("a configured mobile password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => {
        throw new MobileAdapterUnavailableError("TClaude 尚未连接。");
      },
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
      }),
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/tasks?adapter=tclaude`,
        { headers: { cookie: sessionCookie } },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "TClaude 尚未连接。" });
    } finally {
      await server.close();
    }
  });

  test("reads and switches the selected task model through the mobile API", async () => {
    const authStore = createAuthStore("a configured mobile password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const writes: Array<{ threadId: string; model: string; adapter?: string }> = [];
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [{
        threadId: "thread-model",
        title: "模型切换",
        status: "idle",
      }],
      readTaskModel: async (threadId, adapter) => ({
        currentModel: threadId === "thread-model" ? "gpt-5.6-sol" : undefined,
        options: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
        canChange: true,
        adapter,
      }),
      setTaskModel: async (threadId, model, adapter) => {
        writes.push({ threadId, model, adapter });
        return {
          currentModel: model,
          options: [{ id: model }],
          canChange: true,
        };
      },
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
      }),
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const readResponse = await fetch(
        `${root}/api/tasks/thread-model/model?adapter=codex`,
        { headers: { cookie: sessionCookie } },
      );
      expect(readResponse.status).toBe(200);
      expect(await readResponse.json()).toMatchObject({
        currentModel: "gpt-5.6-sol",
        canChange: true,
      });

      const writeResponse = await fetch(
        `${root}/api/tasks/thread-model/model?adapter=codex`,
        {
          method: "PUT",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "gpt-5.6-terra" }),
        },
      );
      expect(writeResponse.status).toBe(200);
      expect(await writeResponse.json()).toMatchObject({
        currentModel: "gpt-5.6-terra",
        canChange: true,
      });
      expect(writes).toEqual([{
        threadId: "thread-model",
        model: "gpt-5.6-terra",
        adapter: "codex",
      }]);
    } finally {
      await server.close();
    }
  });

  test("renames a real task through the mobile API", async () => {
    const authStore = createAuthStore("a configured mobile password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    let title = "原任务名";
    const renames: Array<{ threadId: string; title: string; adapter?: string }> = [];
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [{
        threadId: "thread-rename",
        title,
        status: "idle",
        canRename: true,
      }],
      renameTask: async (threadId, nextTitle, adapter) => {
        renames.push({ threadId, title: nextTitle, adapter });
        title = nextTitle;
      },
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
      }),
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/tasks/thread-rename?adapter=codex`,
        {
          method: "PATCH",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ title: "  新任务名  " }),
        },
      );
      expect(response.status).toBe(200);
      expect(renames).toEqual([{
        threadId: "thread-rename",
        title: "新任务名",
        adapter: "codex",
      }]);
      expect(await response.json()).toEqual({
        ok: true,
        threadId: "thread-rename",
        title: "新任务名",
      });
    } finally {
      await server.close();
    }
  });

  test("rejects invalid or unsupported mobile task renames", async () => {
    const authStore = createAuthStore("a configured mobile password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [{
        threadId: "thread-readonly",
        title: "只读任务",
        status: "idle",
        canRename: false,
      }],
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
      }),
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const empty = await fetch(`${root}/api/tasks/thread-readonly`, {
        method: "PATCH",
        headers: { cookie: sessionCookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "   " }),
      });
      expect(empty.status).toBe(400);
      expect(await empty.json()).toEqual({ error: "任务名不能为空。" });

      const unsupported = await fetch(`${root}/api/tasks/thread-readonly`, {
        method: "PATCH",
        headers: { cookie: sessionCookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "新名称" }),
      });
      expect(unsupported.status).toBe(409);
      expect(await unsupported.json()).toEqual({ error: "当前连接暂不支持重命名任务。" });
    } finally {
      await server.close();
    }
  });

  test("opens the LAN listener only when the password gate protects a public deployment", () => {
    expect(resolveCodexMobileListenHost({
      publicBaseUrl: "https://198.51.100.10/",
    })).toBe("127.0.0.1");
    expect(resolveCodexMobileListenHost({
      publicBaseUrl: "https://198.51.100.10/",
      authStore: createAuthStore("a configured mobile password"),
    })).toBe("0.0.0.0");
    expect(resolveCodexMobileListenHost({})).toBe("0.0.0.0");
    expect(resolveCodexMobileListenHost({
      host: "192.168.50.10",
      publicBaseUrl: "https://198.51.100.10/",
    })).toBe("192.168.50.10");
  });

  test("hands an authenticated public session to LAN once and preserves the selected task", async () => {
    const authStore = createAuthStore("a configured mobile password");
    const publicCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "192.168.50.10",
      publicBaseUrl: "https://198.51.100.10/",
      accessToken: "mobile-secret",
      authStore,
      resolveDesktopPublicAddress: async () => "203.0.113.10",
      listTasks: async () => [],
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
      }),
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const proxyHeaders = {
        cookie: publicCookie,
        "x-forwarded-proto": "https",
        "x-real-ip": "203.0.113.10",
      };
      const routeResponse = await fetch(`${root}/api/network-route`, {
        headers: proxyHeaders,
      });
      expect(routeResponse.status).toBe(200);
      expect(await routeResponse.json()).toEqual({
        mode: "public",
        publicUrl: "https://198.51.100.10",
        lanUrl: `http://192.168.50.10:${server.port}`,
        sameNetworkLikely: true,
      });

      const handoffResponse = await fetch(`${root}/api/network/lan-handoff`, {
        method: "POST",
        headers: {
          ...proxyHeaders,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          target: "/?adapter=codex&task=thread-1&appv=test&setup=must-not-survive",
        }),
      });
      expect(handoffResponse.status).toBe(200);
      const handoff = await handoffResponse.json() as { handoffUrl: string };
      const handoffUrl = new URL(handoff.handoffUrl);
      expect(handoffUrl.origin).toBe(`http://192.168.50.10:${server.port}`);
      expect(handoffUrl.pathname).toBe("/lan-entry");
      expect(handoffUrl.searchParams.get("handoff")).toBeTruthy();

      const rejectedPublicEntry = await fetch(
        `${root}${handoffUrl.pathname}${handoffUrl.search}`,
        {
          headers: {
            "x-forwarded-proto": "https",
            "x-real-ip": "203.0.113.10",
          },
          redirect: "manual",
        },
      );
      expect(rejectedPublicEntry.status).toBe(400);

      const lanEntry = await fetch(`${root}${handoffUrl.pathname}${handoffUrl.search}`, {
        redirect: "manual",
      });
      expect(lanEntry.status).toBe(302);
      expect(lanEntry.headers.get("location")).toBe(
        "/?adapter=codex&task=thread-1&appv=test",
      );
      expect(lanEntry.headers.get("set-cookie")).toContain("codex_mobile_session=");
      expect(lanEntry.headers.get("set-cookie")).not.toContain("; Secure");
      const lanCookie = lanEntry.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
      expect(lanCookie).toStartWith("codex_mobile_session=");

      const lanTasks = await fetch(`${root}/api/tasks`, {
        headers: { cookie: lanCookie },
      });
      expect(lanTasks.status).toBe(200);

      const rejectedOnPublic = await fetch(`${root}/api/tasks`, {
        headers: {
          cookie: lanCookie,
          "x-forwarded-proto": "https",
          "x-real-ip": "203.0.113.10",
        },
      });
      expect(rejectedOnPublic.status).toBe(401);

      const replay = await fetch(`${root}${handoffUrl.pathname}${handoffUrl.search}`, {
        redirect: "manual",
      });
      expect(replay.status).toBe(410);
    } finally {
      await server.close();
    }
  });

  test("does not offer automatic LAN switching when public source addresses differ", async () => {
    const authStore = createAuthStore("a configured mobile password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "192.168.50.10",
      publicBaseUrl: "https://198.51.100.10/",
      accessToken: "mobile-secret",
      authStore,
      resolveDesktopPublicAddress: async () => "203.0.113.10",
      listTasks: async () => [],
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
      }),
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${root}/api/network-route`, {
        headers: {
          cookie: sessionCookie,
          "x-forwarded-proto": "https",
          "x-real-ip": "198.51.100.22",
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        mode: "public",
        publicUrl: "https://198.51.100.10",
        lanUrl: `http://192.168.50.10:${server.port}`,
        sameNetworkLikely: false,
      });
    } finally {
      await server.close();
    }
  });

  test("prefers a private IPv4 address on a physical network interface", () => {
    expect(
      resolvePreferredLanAddress({
        utun0: [
          {
            address: "10.8.0.2",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: false,
            cidr: "10.8.0.2/24",
          },
        ],
        en0: [
          {
            address: "192.168.50.10",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:00:00:00:01",
            internal: false,
            cidr: "192.168.50.10/24",
          },
        ],
      }),
    ).toBe("192.168.50.10");
  });

  test("prefers a configured public URL when building task links", async () => {
    const authStore = createAuthStore();
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "192.168.50.10",
      publicBaseUrl: "http://198.51.100.10/",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [],
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
      }),
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const taskUrl = new URL(server.buildTaskUrl(
        "0000000a-0000-7000-8000-00000000000a",
        "codex",
      ));
      expect(taskUrl.origin).toBe("http://198.51.100.10");
      expect(taskUrl.pathname).toMatch(/^\/t\/[A-Za-z0-9_.~-]+$/);
      expect(taskUrl.searchParams.get("setup")).toBe("mobile-secret");

      const redirect = await fetch(
        `http://127.0.0.1:${server.port}${taskUrl.pathname}${taskUrl.search}`,
        { redirect: "manual" },
      );
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe(
        `/?task=0000000a-0000-7000-8000-00000000000a&adapter=codex&appv=${CODEX_MOBILE_ASSET_VERSION}&setup=mobile-secret`,
      );
    } finally {
      await server.close();
    }
  });

  test("passes opaque message cursors through to the transcript reader", async () => {
    const authStore = createAuthStore("a configured mobile password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const reads: Array<{ threadId: string; before?: string | null; limit?: number }> = [];
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [{
        threadId: "thread-page",
        title: "分页任务",
        status: "idle",
      }],
      readMessages: async (threadId, options) => {
        reads.push({ threadId, ...options });
        return {
          threadId,
          messages: [{ role: "user", text: "较早消息" }],
          messagePage: {
            hasMore: true,
            nextBefore: "byte:128",
          },
          queuedMessages: [],
        };
      },
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/tasks/thread-page/messages?limit=25&before=byte%3A256`,
        { headers: { cookie: sessionCookie } },
      );
      expect(response.status).toBe(200);
      expect(reads).toEqual([{
        threadId: "thread-page",
        before: "byte:256",
        limit: 25,
        lightweight: true,
      }]);
      expect(await response.json()).toMatchObject({
        messages: [{ role: "user", text: "较早消息" }],
        messagePage: {
          hasMore: true,
          nextBefore: "byte:128",
        },
      });
    } finally {
      await server.close();
    }
  });

  test("reads a directly addressed task without waiting for the task list", async () => {
    const authStore = createAuthStore("a configured mobile password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    let listCalls = 0;
    const reads: Array<{
      threadId: string;
      historyOnly?: boolean;
      limit?: number;
      lightweight?: boolean;
    }> = [];
    const sends: Array<{ threadId: string; text: string }> = [];
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => {
        listCalls += 1;
        await Bun.sleep(80);
        return [];
      },
      readMessages: async (threadId, options) => {
        reads.push({ threadId, ...options });
        return {
          threadId,
          messages: [{ role: "assistant", text: "历史正文" }],
          queuedMessages: [],
        };
      },
      sendMessage: async (threadId, input) => {
        sends.push({ threadId, text: input.text });
        return { queued: false, turnId: "new-turn" };
      },
    });

    try {
      const startedAt = performance.now();
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/tasks/direct-thread/messages?limit=40&history=1`,
        { headers: { cookie: sessionCookie } },
      );
      const elapsedMs = performance.now() - startedAt;
      expect(response.status).toBe(200);
      expect(listCalls).toBe(0);
      expect(elapsedMs).toBeLessThan(70);
      expect(reads).toEqual([{
        threadId: "direct-thread",
        historyOnly: true,
        limit: 40,
        lightweight: true,
      }]);
      expect(await response.json()).toMatchObject({
        task: null,
        threadId: "direct-thread",
        messages: [{ role: "assistant", text: "历史正文" }],
      });

      const sendResponse = await fetch(
        `http://127.0.0.1:${server.port}/api/tasks/direct-thread/messages`,
        {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "第一条消息" }),
        },
      );
      expect(sendResponse.status).toBe(202);
      expect(listCalls).toBe(0);
      expect(sends).toEqual([{
        threadId: "direct-thread",
        text: "第一条消息",
      }]);
      expect(await sendResponse.json()).toMatchObject({
        ok: true,
        queued: false,
        turnId: "new-turn",
      });
    } finally {
      await server.close();
    }
  });

  test("serves the responsive app and authenticated task APIs", async () => {
    const authStore = createAuthStore("a configured mobile password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const fullLongAssistantMessage = `完整回答开始\n\n${"这是网页必须保留的完整内容。".repeat(180)}\n\n完整回答结束`;
    const resolvedApprovals: Array<{ threadId: string; action: string }> = [];
    const sent: Array<{
      threadId: string;
      input: {
        text: string;
        images: Array<{ fileName: string; mimeType: string; data: Buffer }>;
      };
    }> = [];
    const stopped: string[] = [];
    const switchedAdapters: string[] = [];
    const queueActions: Array<{
      action: "update" | "delete" | "steer";
      threadId: string;
      messageId: string;
      text?: string;
    }> = [];
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "192.168.50.10",
      accessToken: "mobile-secret",
      authStore,
      listAdapters: async () => ({
        activeAdapter: "codex",
        adapters: [
          { id: "codex", label: "Codex", status: "running", active: true },
          { id: "workbuddy", label: "WorkBuddy", status: "idle", active: false },
        ],
      }),
      switchAdapter: async (adapter) => {
        switchedAdapters.push(adapter);
        return {
          activeAdapter: adapter,
          activated: true,
          detail: `已切换到 ${adapter}`,
        };
      },
      listTasks: async () => [
        {
          threadId: "0000000a-0000-7000-8000-00000000000a",
          title: "继续完善微信 Codex",
          projectName: "new-chat",
          lastUpdatedAt: "2026-08-02T16:00:00.000Z",
          status: "running",
          startedAtMs: 1_800_000_000_000,
          selected: true,
        },
      ],
      readMessages: async (threadId) => ({
        threadId,
        messages: [
          { role: "user", text: "做一个移动端页面" },
          { role: "assistant", text: "正在实现。", phase: "commentary" },
          {
            role: "assistant",
            text: fullLongAssistantMessage,
            phase: "final_answer",
            model: "gpt-5.6-sol",
          },
        ],
        queuedMessages: [
          {
            id: "queued-wechat",
            text: "修改任务列表说明",
            imageCount: 0,
            createdAtMs: 1_800_000_000_001,
          },
          {
            id: "queued-mobile",
            text: "收到请回复ok",
            imageCount: 1,
            createdAtMs: 1_800_000_000_002,
          },
        ],
        runSummary: {
          turnId: "turn-running",
          status: "running",
          startedAtMs: 1_780_000_000_000,
          durationMs: 73_000,
        },
        progressItems: [
          {
            id: "plan-running",
            turnId: "turn-running",
            kind: "plan",
            status: "running",
            text: "第 2 / 4 步 · 同步网页进展",
          },
          {
            id: "command-running",
            turnId: "turn-running",
            kind: "command",
            status: "completed",
            text: "已读取文件并运行命令",
          },
        ],
        pendingApproval: {
          summary: "Codex 请求运行命令。",
          commandPreview: "npm run quality",
          allowForSession: true,
          detailLabel: "运行命令",
          detailPreview: "npm run quality",
        },
        approvalResults: [
          {
            id: "approval-denied",
            action: "deny",
            turnId: "turn-previous",
            summary: "Codex 请求删除文件。",
            commandPreview: "rm obsolete.txt",
            resolvedAt: "2026-08-08T01:00:00.000Z",
          },
        ],
      }),
      sendMessage: async (threadId, input) => {
        if (input.text === "触发失败") {
          throw new Error("这个任务暂时不能发送消息。");
        }
        sent.push({ threadId, input });
        return { queued: false, turnId: "turn-new" };
      },
      resolveApproval: async (threadId, action) => {
        resolvedApprovals.push({ threadId, action });
        return {
          count: 1,
          result: {
            id: "approval-confirmed",
            action,
            turnId: "turn-running",
            summary: "Codex 请求运行命令。",
            commandPreview: "npm run quality",
            detailLabel: "运行命令",
            detailPreview: "npm run quality",
            resolvedAt: "2026-08-08T01:02:00.000Z",
          },
        };
      },
      updateQueuedMessage: async (threadId, messageId, text) => {
        queueActions.push({ action: "update", threadId, messageId, text });
        return true;
      },
      deleteQueuedMessage: async (threadId, messageId) => {
        queueActions.push({ action: "delete", threadId, messageId });
        return true;
      },
      steerQueuedMessage: async (threadId, messageId) => {
        queueActions.push({ action: "steer", threadId, messageId });
        return true;
      },
      stopTask: async (threadId) => {
        stopped.push(threadId);
        return true;
      },
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const htmlResponse = await fetch(`${root}/`);
      const html = await htmlResponse.text();
      expect(htmlResponse.status).toBe(200);
      expect(html).toContain('name="viewport"');
      expect(html).toContain('id="boot-status"');
      expect(html).toContain("<title>WeRelay</title>");
      const cssVersion = html.match(/href="\/app\.css\?appv=([a-f0-9]+)"/i)?.[1];
      const jsVersion = html.match(/src="\/app\.js\?appv=([a-f0-9]+)"/i)?.[1];
      expect(cssVersion).toBeTruthy();
      expect(jsVersion).toBe(cssVersion);
      const versionResponse = await fetch(`${root}/app-version`);
      expect(versionResponse.status).toBe(200);
      expect(await versionResponse.json()).toEqual({ version: cssVersion });
      expect(html).toContain("从手机继续任务");
      expect(html).toContain('id="boot-screen" aria-label="正在打开 WeRelay"');
      expect(html).not.toContain('class="brand-title"');
      expect(html).toContain('id="workspace-switcher"');
      expect(html).toContain('class="workspace-product">WeRelay</span>');
      expect(html).toContain('class="workspace-divider">·</span>');
      expect(html).toContain('id="adapter-menu"');
      expect(html).not.toContain('id="composer-status"');
      expect(html).toContain('id="composer-queue"');
      expect(html).toContain('id="auth-screen" aria-labelledby="auth-title" hidden');
      expect(html).toContain('id="auth-form"');
      expect(html).toContain('id="auth-security-warning"');
      expect(html).toContain('id="task-view-projects"');
      expect(html).toContain('id="task-view-recent"');
      expect(html).toContain("当前连接未启用 HTTPS");
      expect(html).not.toContain('class="product-connection"');
      expect(html).toContain('id="workspace-menu"');
      expect(html).not.toContain('id="product-menu-button"');
      expect(html).not.toContain('id="adapter-switcher"');
      expect(html).toContain('class="workspace-menu-divider"');
      expect(html).toContain('class="workspace-menu-item" href="/about"');
      expect(html).not.toContain('class="sidebar-foot"');
      expect(html).not.toContain('id="jump-latest"');
      expect(html).toContain('id="previous-user-message"');
      expect(html).toContain('id="next-user-message"');
      expect(html).toContain('id="task-context-menu"');
      expect(html).toContain('id="task-context-rename"');
      expect(html).toContain('id="task-context-copy-id"');
      expect(html).toContain('id="task-rename-overlay"');
      expect(html).toContain('id="task-rename-input"');
      expect(html).not.toContain('aria-label="添加文件等"');
      expect(html).toContain('aria-label="添加图片"');
      expect(html).toContain('<path d="M12 5v14M5 12h14"/>');
      expect(html).toContain('class="send-stop-icon"');
      expect(html).toContain('<rect x="5" y="5" width="14" height="14" rx="2.2"/>');
      expect(html).not.toContain('<rect x="3.5" y="5" width="17" height="14" rx="2.5"/>');
      expect(html).toContain('id="composer-image-input"');
      expect(html).toContain('id="composer-model-button"');
      expect(html).toContain('id="composer-model-menu"');
      const composerStart = html.indexOf('<div class="composer">');
      const composerEnd = html.indexOf("</div>\n      </form>", composerStart);
      const composerMediaIndex = html.indexOf('id="composer-media"');
      expect(composerStart).toBeGreaterThan(-1);
      expect(composerMediaIndex).toBeGreaterThan(composerStart);
      expect(composerMediaIndex).toBeLessThan(composerEnd);
      expect(html).not.toContain("Codex 也可能会犯错。请核查重要信息。");
      expect(html).not.toContain('class="brand-mark"');
      expect(html).not.toContain('class="empty-logo"');
      expect(html).toContain('id="task-board-open"');
      expect(html).toContain('id="task-board-view-completed"');
      expect(html).toContain('id="task-board-body"');
      const sidebarHeadStart = html.indexOf('<div class="sidebar-head">');
      const sidebarHeadEnd = html.indexOf("</div>\n      <nav class=\"sidebar-primary-nav\"", sidebarHeadStart);
      const workspaceSwitcherIndex = html.indexOf('id="workspace-switcher"');
      const topbarCopyStart = html.indexOf('<div class="topbar-copy">');
      const topbarCopyEnd = html.indexOf("</div>\n        <div class=\"topbar-actions\">", topbarCopyStart);
      expect(workspaceSwitcherIndex).toBeGreaterThan(sidebarHeadStart);
      expect(workspaceSwitcherIndex).toBeLessThan(sidebarHeadEnd);
      expect(html.slice(topbarCopyStart, topbarCopyEnd)).not.toContain('id="workspace-switcher"');

      const aboutResponse = await fetch(`${root}/about`);
      const aboutHtml = await aboutResponse.text();
      expect(aboutResponse.status).toBe(200);
      expect(aboutHtml).toContain("<title>项目说明 · WeRelay</title>");
      expect(aboutHtml).toContain("ONE REAL SESSION. EVERY SCREEN.");
      expect(aboutHtml).toContain("电脑端持有唯一真实任务");
      expect(aboutHtml).toContain('class="about-logo" href="/about">WeRelay</a>');
      expect(aboutHtml).toContain('class="about-open-app" href="/">打开任务</a>');

      const cssResponse = await fetch(`${root}/app.css`);
      const css = await cssResponse.text();
      expect(cssResponse.status).toBe(200);
      expect(css).toContain("--thread-max: 48rem;");
      expect(css).toContain("border-radius: 28px;");
      expect(css).toContain(".composer {\n  display: grid;");
      expect(css).toContain("grid-template-columns: 36px minmax(0, 1fr) 36px;");
      expect(css).toContain("align-items: flex-end;");
      expect(css).toContain("gap: 4px;");
      expect(css).toContain("min-height: 52px;");
      expect(css).toContain(".send-button { width: 36px; height: 36px;");
      expect(css).toContain(".send-button .send-stop-icon { width: 20px; height: 20px;");
      expect(css).not.toContain("grid-template-areas:");
      expect(css).toContain(".topbar { position: absolute; top: 0;");
      expect(css).toContain(".sidebar {\n  height: 100%;\n  min-height: 0;");
      expect(css).toContain("overflow: hidden;");
      expect(css).toContain(".task-list { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto;");
      expect(css).toContain(".task-view-switch {");
      expect(css).toContain(".task-board-columns {");
      expect(css).toContain(".task-board-completed {");
      expect(css).toContain(".task-group-title {");
      expect(css).toContain(".task-group { margin: 0; }");
      expect(css).toContain(".task-group:not(.is-recent) .task-group-items .task-item,");
      expect(css).toContain(".task-group:not(.is-recent) .task-group-more { padding-left: 28px; }");
      expect(css).toContain(".message-navigation {");
      expect(css).toContain("left: auto;");
      expect(css).toContain("right: max(24px, calc((100% - var(--thread-max)) / 2));");
      expect(css).toContain("top: 68px;");
      expect(css).toContain("opacity: .62;");
      expect(css).not.toContain("left: max(24px, calc((100% - var(--thread-max)) / 2));");
      expect(css).toContain(".task-group-more");
      expect(css).toContain(".task-context-menu {");
      expect(css).toContain(".task-rename-overlay {");
      expect(css).toContain("-webkit-touch-callout: none;");
      expect(css).toContain(".task-status-badge.approval { display: inline-flex; }");
      expect(css).toContain(".task-dot.running { visibility: visible; background: var(--green); animation: task-dot-breathe");
      expect(css).toContain("@keyframes task-dot-breathe");
      expect(css).toContain("@media (prefers-reduced-motion: reduce)");
      expect(css).toContain("padding: 38px 24px 112px;");
      expect(css).toContain("margin: 0 auto 20px;");
      expect(css).toContain("padding: 20px 24px max(12px, env(safe-area-inset-bottom));");
      expect(css).toContain(".about-hero h1 {");
      expect(css).toContain(".about-flow {");
      expect(css).toContain("border-radius: 6px;");
      expect(css).toContain("visibility: hidden;");
      expect(css).toContain("-webkit-tap-highlight-color: transparent;");
      expect(css).toContain("touch-action: manipulation;");
      expect(css).toContain(".message-content h1, .message-content h2, .message-content h3, .message-content h4, .message-content h5, .message-content h6");
      expect(css).toContain("font-size: inherit;");
      expect(css).toContain("font-weight: inherit;");
      expect(css).toContain(".message-row.assistant .message-card { width: 100%; color: var(--text); font-size: 15px; line-height: 1.62; }");
      expect(css).toContain(".message-row.assistant.continues { margin-bottom: 10px; }");
      expect(css).toContain(".message-row.assistant.commentary .message-card { padding-left: 0; border-left: 0; color: var(--text); }");
      expect(css).not.toContain(".message-row.assistant.commentary .message-card { padding-left: 0; border-left: 0; color: var(--text); font-size: inherit;");
      expect(css).toContain(".message-content strong { font-weight: 620; }");
      expect(css).not.toContain(".message-role {");
      expect(css).toContain(".message-content { -webkit-user-select: text;");
      expect(css).toContain(".message-model { margin-top: 10px;");
      expect(css).toContain(".app-shell:not(.sidebar-open) .sidebar");
      expect(css).toContain("pointer-events: none;");
      expect(css).toContain(".app-shell.sidebar-open .main-panel {");
      expect(css).toContain("-webkit-user-select: none;");
      expect(css).toContain("user-select: none;");
      expect(css).toContain("-webkit-touch-callout: none;");
      expect(css).toContain(".response-pending {");
      expect(css).toContain("@keyframes response-pending-dot");
      expect(css).toContain(".run-progress-item {");
      expect(css).toContain(".workspace-switch-progress");
      expect(css).toContain(".queued-followup-status");
      expect(css).toContain(".composer-queue { width: calc(100% - 40px); max-width: calc(var(--thread-max) - 40px); display: grid; gap: 0;");
      expect(css).toContain("overflow: hidden auto;");
      expect(css).toContain("border-radius: 16px; background: var(--page);");
      expect(css).toContain(".queued-followup { min-width: 0; background: var(--page); }");
      expect(css).toContain(".queued-followup + .queued-followup { border-top: 1px solid var(--border); }");
      expect(css).not.toContain(".queued-followup { border: 1px solid var(--border);");
      expect(css).toContain("@media (hover: none) and (pointer: coarse)");
      expect(css).toContain(".icon-button:active, .composer-image-button:active");

      const jsResponse = await fetch(`${root}/app.js`);
      const js = await jsResponse.text();
      expect(jsResponse.status).toBe(200);
      expect(js).toContain("scheduleLiveRefresh");
      expect(js).toContain('document.addEventListener("visibilitychange"');
      expect(js).toContain("renderQueuedMessages");
      expect(js).toContain("var continues = messageContinues(message, nextMessage);");
      expect(js).not.toContain('message.phase === "commentary" ? "工作过程" : ""');
      expect(js).toContain('group.key === "recent" ? " is-recent" : ""');
      expect(js).toContain("resolveUserMessageNavigation");
      expect(js).toContain("updateUserMessageNavigation");
      expect(js).toContain("navigateToUserMessage");
      expect(js).toContain('previousUserMessage.addEventListener("click"');
      expect(js).toContain('button.addEventListener("contextmenu"');
      expect(js).toContain('button.addEventListener("pointerdown"');
      expect(js).toContain('navigator.clipboard.writeText');
      expect(js).toContain('openTaskRenameDialog');
      expect(js).toContain('closeTaskContextMenu');
      expect(js).toContain('nextUserMessage.addEventListener("click"');
      expect(js).toContain("toggleWorkspaceMenu");
      expect(js).toContain("var task = currentTask();");
      expect(js).toContain("? task.title");
      expect(js).toContain(': "WeRelay \\u00B7 " + currentAdapterName();');
      expect(js).toContain('var requestedAdapter = pageUrl.searchParams.get("adapter") || "";');
      expect(js).toContain('requestedAdapter !== adapterPayload.activeAdapter');
      expect(js).toContain('if (!initial) canonicalUrl.searchParams.delete("task");');
      expect(js).toContain('if (requestedAdapter) state.currentAdapter = requestedAdapter;');
      expect(js).toContain(
        "state.loadingTasks = needsInitialTask && !restoredCache && !state.tasks.length;",
      );
      expect(js).toContain('<div class="loading-row">');
      expect(js).toContain("escapeHtml(currentAdapterName())");
      expect(js).toContain('updateDocumentTitle();\n  async function startMobileApplication()');
      expect(js).toContain('restoreTrustedPersistentMobileCachePreview');
      expect(js).toContain('void waitForComputerConnection();\n    await initializeAuthentication();');
      expect(js).toContain("mergeQueuedMessagesForDisplay");
      expect(js).toContain("switchingAdapterId");
      expect(js).toContain("switchProgressLabel");
      expect(js.match(/switchProgressLabel\(state\.switchStartedAtMs, Date\.now\(\)\)/g)).toHaveLength(1);
      expect(js).toContain("workspaceSwitchProgress.hidden = true;");
      expect(js).toContain("syncChildOrder(taskList, []);");
      expect(js).not.toContain('"正在连接 " + switchingAdapterName()');
      expect(js).not.toContain('showToast("正在连接 " + adapterName(adapterId) + "…")');
      expect(js).toContain('status.className = "queued-followup-status"');
      expect(js).toContain('if (!waitingForTaskCreation) {\n      submitPendingMessage(pending);');
      expect(js).toContain('pending.status = "creating_task";');
      expect(js).toContain("initializeAuthentication");
      expect(js).toContain("attemptLanAcceleration");
      expect(js).toContain("werelayLanRedirectAttemptedAt");
      expect(js).toContain("route.sameNetworkLikely");
      expect(js).toContain("bootStatus.textContent =");
      expect(js).toContain("window.location.assign(handoff.handoffUrl)");
      expect(js).toContain("updateAuthSecurityWarning");
      expect(js).toContain("pendingMessages");
      expect(js).toContain("messageRequestId");
      expect(js).toContain("taskRequestId");
      expect(js).toContain("conversationSnapshots");
      expect(js).toContain("composerDrafts");
      expect(js).toContain("saveCurrentConversationSnapshot");
      expect(js).toContain("restoreConversationSnapshot");
      expect(js).toContain("if (restored) {");
      expect(js).toContain("void loadMessages(false, false, false);");
      expect(js).toContain("requestedThreadId !== state.currentThreadId");
      expect(js).toContain("pending.threadId");
      expect(js).toContain("composerRevision");
      expect(js).toContain("composerInput.value = \"\";");
      expect(js).toContain("requestedComposerRevision !== state.composerRevision");
      expect(js).toContain("renderRunHeader");
      expect(js).toContain("runHeaderLabel");
      expect(js).toContain("renderApprovalCard");
      expect(js).toContain("renderProgressList");
      expect(js).toContain("visibleMessageModel(message)");
      expect(js).toContain('class="message-model"');
      expect(js).toContain("progressItems");
      expect(js).toContain("filterProgressItemsForCurrentTurn");
      expect(js).toContain("state.progressItems = filterProgressItemsForOptimisticTurn(");
      expect(js).toContain("filterProgressItemsForCurrentTurn(");
      expect(js).toContain("\\u7B49\\u5F85\\u786E\\u8BA4");
      expect(js).toContain("resolveVisibleRunSummary");
      expect(js).toContain("stopCurrentTask");
      expect(js).toContain("shouldUseStopComposerAction");
      expect(js).toContain('sendButton.classList.toggle("is-stop"');
      expect(js).toContain("pending.optimisticRun = true;");
      expect(js).not.toContain('class="run-stop-button"');
      expect(js).toContain("\\u5DF2\\u5B8C\\u6210");
      expect(js).toContain("if (!summary.completedAtMs || !summary.startedAtMs) return 0;");
      expect(js).toContain("updateRunSummary(payload.runSummary || null, payload.task || null);");
      expect(js).toContain('var LIVE_MESSAGE_PAGE_SIZE = 5;');
      expect(js).toContain('historyOnly ? "&history=1" : ""');
      expect(js).toContain('selectTask(requestedTask, false)');
      expect(js).toContain('state.nextTaskRefreshAtMs');
      expect(js).not.toContain('state.historySource === "openagentlog"');
      expect(js).toContain('forceFullPage ? MESSAGE_PAGE_SIZE : LIVE_MESSAGE_PAGE_SIZE');
      expect(js).toContain('void loadMessages(false, false, false);');
      expect(js).toContain('task.status === "running" || task.status === "approval" || task.status === "input"');
      expect(js).toContain("\\u6B63\\u5728\\u5904\\u7406");
      expect(js).not.toContain("codexMobileKey");
      expect(js).not.toContain("x-codex-mobile-key");
      expect(js).toContain("syncChildOrder");
      expect(js).toContain("taskGroupKey");
      expect(js).toContain("PROJECT_TASK_BATCH_SIZE = 5");
      expect(js).toContain("RECENT_TASK_BATCH_SIZE = 20");
      expect(js).toContain("setProjectGroupCollapsed");
      expect(js).toContain("sortTasksByRecency");
      expect(js).toContain("renderRecentTasks");
      expect(js).toContain('class="task-status-badge"');
      expect(js).toContain('task.status === "approval" ? "\\u5BA1\\u6279" : ""');
      expect(js).toContain("task-view-projects");
      expect(js).toContain("taskList.scrollTop = 0;");
      expect(js).toContain("MESSAGE_PAGE_SIZE = 40");
      expect(js).toContain("loadOlderMessages");
      expect(js).toContain('messagesEl.scrollTop < 120');
      expect(js).toContain('"/messages?limit=" + MESSAGE_PAGE_SIZE');
      expect(js).toContain('"&before=" + encodeURIComponent(before)');
      expect(js).toContain("state.historyRequestId += 1;");
      expect(js).toContain("state.historyMessages = [];");
      expect(js).toContain("mergeMessagePages");
      expect(js).toContain("state.oldestMessageCursor");
      expect(js).toContain('canonicalUrl.searchParams.set("task", chosen.threadId);');
      expect(js).not.toContain("connection-dot");
      expect(js).not.toContain("connection-label");
      expect(js).not.toContain("setConnection(");
      expect(js).not.toContain('taskList.innerHTML = ""');
      expect(js).toContain("addImageFiles");
      expect(js).toContain('composerInput.addEventListener("paste"');
      expect(js).not.toContain('composerTool.addEventListener("click"');
      expect(js).not.toContain("defaultComposerStatus");
      expect(js).not.toContain("已加入队列，前面还有");
      expect(js).toContain("steerQueuedMessage");
      expect(js).not.toContain("saveQueuedMessage");
      expect(js).toContain("beginQueuedMessageEdit");
      expect(js).toContain('replace(/\\s+/g, " ")');
      expect(js).toContain("message.id === state.editingQueuedMessageId");
      expect(js).toContain("submitQueuedMessageEdit");
      expect(js).toContain("loadAdapters");
      expect(js).toContain("loadCurrentTaskModel");
      expect(js).toContain("selectCurrentTaskModel");
      expect(js).toContain('adapterApiPath("/api/tasks/" + encodeURIComponent(state.currentThreadId) + "/model")');
      expect(js).toContain("loadTaskBoard");
      expect(js).toContain('api("/api/task-board")');
      expect(js).toContain("openTaskFromBoard");
      expect(js).toContain("switchAdapter");
      expect(js).toContain("deleteQueuedMessage");
      expect(js).not.toContain("state.queuedMessages.concat");
      expect(js).toContain("message.clientId !== pending.clientId");
      expect(js).toContain('pending.displayInTranscript = true;');
      const startAuthenticatedAppIndex = js.indexOf("function startAuthenticatedApp");
      const appVisibleIndex = js.indexOf("app.hidden = false;", startAuthenticatedAppIndex);
      expect(appVisibleIndex).toBeLessThan(
        js.indexOf("adapterPayload = await loadAdapters();", startAuthenticatedAppIndex),
      );
      expect(appVisibleIndex).toBeLessThan(js.indexOf("await loadTasks(true);", startAuthenticatedAppIndex));
      expect(js.indexOf("scheduleLiveRefresh(2200);", js.indexOf("function startAuthenticatedApp")))
        .toBeGreaterThan(js.indexOf("await loadTasks(true);"));
      expect(js).toContain("Math.max(96, composerHeight + 16)");
      expect(js).not.toContain("messageNavigation.style.bottom");
      expect(js).not.toContain('if (pending.status === "sending") return true;');
      expect(js).toContain("baselineUserKeys");
      expect(js).not.toContain('pending.status === "failed" || pending.status === "sending"');
      expect(js).toContain('pending.status = uncertain ? "unconfirmed" : "failed";');
      expect(js).toContain('var stillPending = state.pendingMessages.some');
      expect(js).toContain('message.status === "unconfirmed"');
      expect(js).toContain('if (result.duplicate)');
      expect(js).toContain("\\u4E0E\\u6700\\u8FD1\\u4E00\\u6761\\u6D88\\u606F\\u76F8\\u540C\\uFF0C\\u672A\\u91CD\\u590D\\u53D1\\u9001");
      expect(js).toContain("renderResponsePendingIndicator");
      expect(js).toContain("if (responsePending) nodes.push(responsePending)");
      expect(js).toContain("syncChildOrder(messagesEl, nodes)");
      expect(js).toContain("captureOpenFoldState");
      expect(js).toContain("restoreOpenFoldState");
      expect(js).toContain('messagesEl.dataset.threadId !== state.currentThreadId');
      expect(js).toContain("document.elementFromPoint(longPressStartX, longPressStartY)");
      expect(js).toContain("hasActiveTextSelection()");
      expect(js).toContain('app.classList.contains("sidebar-open")');
      expect(js).toContain('document.addEventListener("selectionchange"');
      expect(js).toContain('messagesEl.addEventListener("selectstart"');
      expect(js).toContain('messagesEl.addEventListener("contextmenu"');
      expect(js).toContain("isTaskContextMenuTriggerAllowed");
      expect(js).toContain("checkForAppUpdate");
      expect(js).toContain('window.addEventListener("pageshow"');
      expect(() => new Function(js)).not.toThrow();

      const taskUrl = new URL(server.buildTaskUrl(
        "0000000a-0000-7000-8000-00000000000a",
        "codex",
      ));
      expect(taskUrl.origin).toBe(`http://192.168.50.10:${server.port}`);
      expect(taskUrl.pathname).toMatch(/^\/t\/[A-Za-z0-9_.~-]+$/);
      expect(taskUrl.search).toBe("");
      const sameSessionOtherAdapter = new URL(server.buildTaskUrl(
        "0000000a-0000-7000-8000-00000000000a",
        "workbuddy",
      ));
      expect(sameSessionOtherAdapter.pathname).not.toBe(taskUrl.pathname);

      const shortRedirect = await fetch(`${root}${taskUrl.pathname}`, {
        redirect: "manual",
      });
      expect(shortRedirect.status).toBe(302);
      expect(shortRedirect.headers.get("location")).toBe(
        `/?task=0000000a-0000-7000-8000-00000000000a&adapter=codex&appv=${CODEX_MOBILE_ASSET_VERSION}`,
      );

      const unauthorized = await fetch(`${root}/api/tasks`);
      expect(unauthorized.status).toBe(401);

      const headers = { cookie: sessionCookie };
      const adaptersResponse = await fetch(`${root}/api/adapters`, { headers });
      expect(adaptersResponse.status).toBe(200);
      expect(await adaptersResponse.json()).toEqual({
        activeAdapter: "codex",
        adapters: [
          { id: "codex", label: "Codex", status: "running", active: true },
          { id: "workbuddy", label: "WorkBuddy", status: "idle", active: false },
        ],
      });
      const switchResponse = await fetch(`${root}/api/adapters/workbuddy/switch`, {
        method: "POST",
        headers,
      });
      expect(switchResponse.status).toBe(200);
      expect(await switchResponse.json()).toEqual({
        activeAdapter: "workbuddy",
        activated: true,
        detail: "已切换到 workbuddy",
      });
      expect(switchedAdapters).toEqual(["workbuddy"]);
      const tasksResponse = await fetch(`${root}/api/tasks`, { headers });
      const tasks = await tasksResponse.json() as {
        tasks: Array<{ threadId: string; status: string; lastUpdatedAt?: string }>;
      };
      expect(tasks.tasks[0]).toMatchObject({
        threadId: "0000000a-0000-7000-8000-00000000000a",
        status: "running",
        lastUpdatedAt: "2026-08-02T16:00:00.000Z",
      });

      const messagesResponse = await fetch(
        `${root}/api/tasks/0000000a/messages`,
        { headers },
      );
      const transcript = await messagesResponse.json() as {
        threadId: string;
        messages: Array<{ role: string; text: string }>;
        messagePage: {
          start: number;
          end: number;
          total: number;
          hasMore: boolean;
          nextBefore: number | null;
        };
        queuedMessages: Array<{
          id: string;
          text: string;
          imageCount: number;
          createdAtMs?: number;
        }>;
        runSummary: { turnId?: string; status: string; durationMs?: number } | null;
        progressItems: Array<{
          id: string;
          kind: string;
          status: string;
          text: string;
        }>;
        pendingApproval: {
          summary: string;
          commandPreview: string;
          allowForSession?: boolean;
        } | null;
        approvalResults: Array<{
          id: string;
          action: string;
          turnId?: string;
          summary: string;
          commandPreview: string;
          resolvedAt: string;
        }>;
      };
      expect(transcript.threadId).toBe(
        "0000000a-0000-7000-8000-00000000000a",
      );
      expect(transcript.messages).toHaveLength(3);
      expect(transcript.messages[2]?.text).toBe(fullLongAssistantMessage);
      expect(transcript.messages[2]?.text.endsWith("完整回答结束")).toBe(true);
      expect(transcript.messagePage).toEqual({
        start: 0,
        end: 3,
        total: 3,
        hasMore: false,
        nextBefore: null,
      });
      expect(transcript.queuedMessages).toEqual([
        {
          id: "queued-wechat",
          text: "修改任务列表说明",
          imageCount: 0,
          createdAtMs: 1_800_000_000_001,
        },
        {
          id: "queued-mobile",
          text: "收到请回复ok",
          imageCount: 1,
          createdAtMs: 1_800_000_000_002,
        },
      ]);
      expect(transcript.runSummary).toMatchObject({
        turnId: "turn-running",
        status: "running",
        durationMs: 73_000,
      });
      expect(transcript.progressItems).toEqual([
        {
          id: "plan-running",
          turnId: "turn-running",
          kind: "plan",
          status: "running",
          text: "第 2 / 4 步 · 同步网页进展",
        },
        {
          id: "command-running",
          turnId: "turn-running",
          kind: "command",
          status: "completed",
          text: "已读取文件并运行命令",
        },
      ]);
      expect(transcript.pendingApproval).toMatchObject({
        summary: "Codex 请求运行命令。",
        commandPreview: "npm run quality",
        allowForSession: true,
      });
      expect(transcript.approvalResults).toEqual([
        {
          id: "approval-denied",
          action: "deny",
          turnId: "turn-previous",
          summary: "Codex 请求删除文件。",
          commandPreview: "rm obsolete.txt",
          resolvedAt: "2026-08-08T01:00:00.000Z",
        },
      ]);

      const approvalResponse = await fetch(
        `${root}/api/tasks/0000000a/approval`,
        {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
          },
          body: JSON.stringify({ action: "confirm" }),
        },
      );
      expect(approvalResponse.status).toBe(200);
      expect(await approvalResponse.json()).toEqual({
        ok: true,
        count: 1,
        result: {
          id: "approval-confirmed",
          action: "confirm",
          turnId: "turn-running",
          summary: "Codex 请求运行命令。",
          commandPreview: "npm run quality",
          detailLabel: "运行命令",
          detailPreview: "npm run quality",
          resolvedAt: "2026-08-08T01:02:00.000Z",
        },
      });
      expect(resolvedApprovals).toEqual([
        {
          threadId: "0000000a-0000-7000-8000-00000000000a",
          action: "confirm",
        },
      ]);

      const queueUpdateResponse = await fetch(
        `${root}/api/tasks/0000000a/queue/queued-mobile`,
        {
          method: "PATCH",
          headers: {
            ...headers,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "修改后的待发送消息" }),
        },
      );
      expect(queueUpdateResponse.status).toBe(200);
      expect(await queueUpdateResponse.json()).toEqual({ ok: true });

      const queueSteerResponse = await fetch(
        `${root}/api/tasks/0000000a/queue/queued-mobile/steer`,
        { method: "POST", headers },
      );
      expect(queueSteerResponse.status).toBe(200);
      expect(await queueSteerResponse.json()).toEqual({ ok: true });

      const queueDeleteResponse = await fetch(
        `${root}/api/tasks/0000000a/queue/queued-wechat`,
        { method: "DELETE", headers },
      );
      expect(queueDeleteResponse.status).toBe(200);
      expect(await queueDeleteResponse.json()).toEqual({ ok: true });
      expect(queueActions).toEqual([
        {
          action: "update",
          threadId: "0000000a-0000-7000-8000-00000000000a",
          messageId: "queued-mobile",
          text: "修改后的待发送消息",
        },
        {
          action: "steer",
          threadId: "0000000a-0000-7000-8000-00000000000a",
          messageId: "queued-mobile",
        },
        {
          action: "delete",
          threadId: "0000000a-0000-7000-8000-00000000000a",
          messageId: "queued-wechat",
        },
      ]);

      const stopResponse = await fetch(
        `${root}/api/tasks/0000000a/stop`,
        { method: "POST", headers },
      );
      expect(stopResponse.status).toBe(200);
      expect(await stopResponse.json()).toEqual({ ok: true, interrupted: true });
      expect(stopped).toEqual(["0000000a-0000-7000-8000-00000000000a"]);

      const sendResponse = await fetch(
        `${root}/api/tasks/0000000a/messages`,
        {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "  继续处理这个任务\n保留缩进  " }),
        },
      );
      expect(sendResponse.status).toBe(202);
      expect(await sendResponse.json()).toEqual({
        ok: true,
        queued: false,
        turnId: "turn-new",
      });
      expect(sent).toEqual([
        {
          threadId: "0000000a-0000-7000-8000-00000000000a",
          input: {
            text: "  继续处理这个任务\n保留缩进  ",
            images: [],
          },
        },
      ]);

      const nativeCommandResponse = await fetch(
        `${root}/api/tasks/0000000a/messages`,
        {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "/model claude-sonnet-4-6" }),
        },
      );
      expect(nativeCommandResponse.status).toBe(202);
      expect(sent[1]).toEqual({
        threadId: "0000000a-0000-7000-8000-00000000000a",
        input: {
          text: "/model claude-sonnet-4-6",
          images: [],
        },
      });

      const imageResponse = await fetch(
        `${root}/api/tasks/0000000a/messages`,
        {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            text: "请分析图片",
            images: [
              {
                fileName: "clipboard.png",
                mimeType: "image/png",
                dataBase64:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl4wGAAAAAASUVORK5CYII=",
              },
            ],
          }),
        },
      );
      expect(imageResponse.status).toBe(202);
      expect(sent[2]).toMatchObject({
        threadId: "0000000a-0000-7000-8000-00000000000a",
        input: {
          text: "请分析图片",
          images: [
            { fileName: "clipboard.png", mimeType: "image/png" },
          ],
        },
      });
      expect(Buffer.isBuffer(sent[2]?.input.images[0]?.data)).toBe(true);

      const rejectedResponse = await fetch(
        `${root}/api/tasks/0000000a/messages`,
        {
          method: "POST",
          headers: {
            ...headers,
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "触发失败" }),
        },
      );
      expect(rejectedResponse.status).toBe(409);
      expect(await rejectedResponse.json()).toEqual({
        error: "这个任务暂时不能发送消息。",
      });
    } finally {
      await server.close();
    }
  });

  test("keeps a resolved approval visible after the transcript is refreshed", async () => {
    const authStore = createAuthStore("a configured mobile password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-approval-result-"));
    tempDirs.push(directory);
    const stateStore = new DaemonWorkspaceStateStore(directory, {
      stateFile: path.join(directory, "daemon-state.json"),
    });
    let pendingApproval: {
      summary: string;
      commandPreview: string;
      allowForSession: boolean;
      detailLabel: string;
      detailPreview: string;
    } | null = {
      summary: "Codex 请求运行命令。",
      commandPreview: "npm run quality",
      allowForSession: true,
      detailLabel: "运行命令",
      detailPreview: "npm run quality",
    };
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [{
        threadId: "approval-task",
        title: "审批结果验证",
        status: pendingApproval ? "approval" : "running",
        selected: true,
      }],
      readMessages: async (threadId) => ({
        threadId,
        messages: [
          { role: "user", text: "运行完整检查", turnId: "turn-approval" },
          { role: "assistant", text: "准备执行。", turnId: "turn-approval" },
        ],
        queuedMessages: [],
        pendingApproval,
        approvalResults: stateStore
          .getMobileApprovalResults("codex", threadId)
          .map(({ adapter: _adapter, threadId: _threadId, ...result }) => result),
      }),
      sendMessage: async () => ({ queued: false }),
      resolveApproval: async (threadId, action) => {
        if (!pendingApproval) {
          return { count: 0 };
        }
        const result = {
          id: "approval-persisted",
          action,
          turnId: "turn-approval",
          summary: pendingApproval.summary,
          commandPreview: pendingApproval.commandPreview,
          detailLabel: pendingApproval.detailLabel,
          detailPreview: pendingApproval.detailPreview,
          resolvedAt: "2026-08-08T02:00:00.000Z",
        };
        stateStore.recordMobileApprovalResult({
          ...result,
          adapter: "codex",
          threadId,
        });
        pendingApproval = null;
        return { count: 1, result };
      },
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const headers = { cookie: sessionCookie };
      const approvalResponse = await fetch(`${root}/api/tasks/approval-task/approval`, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "confirm_session" }),
      });
      expect(approvalResponse.status).toBe(200);

      const refreshedResponse = await fetch(
        `${root}/api/tasks/approval-task/messages`,
        { headers },
      );
      expect(refreshedResponse.status).toBe(200);
      expect(await refreshedResponse.json()).toMatchObject({
        pendingApproval: null,
        approvalResults: [{
          id: "approval-persisted",
          action: "confirm_session",
          turnId: "turn-approval",
          commandPreview: "npm run quality",
        }],
      });
    } finally {
      await server.close();
    }
  });
});

describe("Codex mobile task creation", () => {
  test("creates a task for the selected adapter", async () => {
    const authStore = createAuthStore("a configured mobile password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const createdRequests: Array<{
      adapter: string | undefined;
      sourceThreadId: string | undefined;
    }> = [];
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [],
      createTask: async (adapter, options) => {
        createdRequests.push({
          adapter,
          sourceThreadId: options?.sourceThreadId,
        });
        return {
          threadId: "new-tclaude-task",
          title: "新任务",
          projectName: "demo-workspace",
          status: "idle",
          selected: true,
        };
      },
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
      }),
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/tasks?adapter=tclaude&sourceTask=source-task`,
        {
          method: "POST",
          headers: { cookie: sessionCookie },
        },
      );
      expect(response.status).toBe(201);
      expect(createdRequests).toEqual([{
        adapter: "tclaude",
        sourceThreadId: "source-task",
      }]);
      expect(await response.json()).toEqual({
        task: {
          threadId: "new-tclaude-task",
          title: "新任务",
          projectName: "demo-workspace",
          status: "idle",
          selected: true,
        },
      });
    } finally {
      await server.close();
    }
  });
});

describe("Codex mobile generated image messages", () => {
  test("maps local assistant and user images to authenticated opaque URLs and serves the image", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-mobile-output-image-"));
    tempDirs.push(dir);
    const imagePath = path.join(dir, "generated.png");
    const imageBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl4wGAAAAAASUVORK5CYII=",
      "base64",
    );
    fs.writeFileSync(imagePath, imageBytes);
    const authStore = createAuthStore("a configured mobile password");
    const cookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const threadId = "generated-image-thread";
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [{ threadId, title: "生成图片", status: "idle" }],
      readMessages: async () => ({
        threadId,
        messages: [{
          role: "assistant",
          text: "图片已经生成。",
          images: [{ source: "local", path: imagePath, alt: "生成结果" }],
        }, {
          role: "user",
          text: "请查看输入图片。",
          images: [{ source: "local", path: imagePath, alt: "输入图片" }],
        }],
        queuedMessages: [],
      }),
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const messagesResponse = await fetch(
        `${root}/api/tasks/${encodeURIComponent(threadId)}/messages`,
        { headers: { cookie } },
      );
      expect(messagesResponse.status).toBe(200);
      const payload = await messagesResponse.json() as {
        messages: Array<{
          images?: Array<{ source: string; url: string; alt?: string; path?: string }>;
        }>;
      };
      const image = payload.messages[0]?.images?.[0];
      const inputImage = payload.messages[1]?.images?.[0];
      expect(image).toMatchObject({
        source: "remote",
        alt: "生成结果",
      });
      expect(image?.path).toBeUndefined();
      expect(image?.url).toMatch(
        /^\/api\/tasks\/generated-image-thread\/images\/[A-Za-z0-9_-]+$/,
      );
      expect(inputImage).toMatchObject({
        source: "remote",
        alt: "输入图片",
        url: image?.url,
      });

      const unauthorized = await fetch(`${root}${image?.url}`);
      expect(unauthorized.status).toBe(401);

      const imageResponse = await fetch(`${root}${image?.url}`, {
        headers: { cookie },
      });
      expect(imageResponse.status).toBe(200);
      expect(imageResponse.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await imageResponse.arrayBuffer())).toEqual(imageBytes);
    } finally {
      await server.close();
    }
  });

  test("renders assistant images as clickable previews instead of pending-only thumbnails", () => {
    expect(CODEX_MOBILE_JS).toContain("function renderMessageImages");
    expect(CODEX_MOBILE_JS).toContain('data-open-image="');
    expect(CODEX_MOBILE_JS).toContain("openImageViewer");
    expect(CODEX_MOBILE_JS).not.toContain(
      "var pendingImages = message.pending && Array.isArray(message.images)",
    );
    expect(CODEX_MOBILE_JS).toContain("if (state.loadingMessages) return null;");
  });

  test("reuses unchanged message rows when polling only changes progress or approval state", () => {
    const { messageNodeKey, getMessageNode } = loadMobileMessageNodeCache();
    const message = {
      id: "message-1",
      role: "user",
      text: "只发一张图",
      images: [{ url: "/api/tasks/task-1/images/image-1", alt: "截图.jpg" }],
    };
    const nodeKey = messageNodeKey(message, 0);
    const first = getMessageNode(message, 0, undefined, nodeKey);

    const unrelatedPollingState = {
      progressItems: [{ id: "progress-2", text: "继续分析" }],
      pendingApproval: { code: "4" },
    };
    expect(unrelatedPollingState.progressItems).toHaveLength(1);

    const second = getMessageNode({ ...message }, 0, undefined, nodeKey);
    expect(second).toBe(first);
    expect(second.renderCount).toBe(1);

    const changed = getMessageNode({ ...message, text: "图片说明已修改" }, 0, undefined, nodeKey);
    expect(changed).not.toBe(first);
    expect(changed.renderCount).toBe(2);
    expect(CODEX_MOBILE_JS).toContain("messageNodes: Object.create(null)");
    expect(CODEX_MOBILE_JS).toContain("syncChildOrder(messagesEl, nodes)");
  });

  test("opens selected input images in the same full-screen viewer", () => {
    expect(CODEX_MOBILE_JS).toContain('previewButton.className = "composer-media-preview"');
    expect(CODEX_MOBILE_JS).toContain("openImageViewer(image.previewUrl, image.fileName)");
    expect(CODEX_MOBILE_CSS).toContain(".composer-media-preview");
  });
});

describe("mobile settings API", () => {
  test("renders settings as a full right drawer with concise terminal and task tabs", () => {
    expect(CODEX_MOBILE_HTML).toContain('class="settings-drawer"');
    expect(CODEX_MOBILE_HTML).not.toContain('class="settings-dialog"');
    expect(CODEX_MOBILE_CSS).toContain("justify-content: flex-end");
    expect(CODEX_MOBILE_CSS).toContain("height: 100dvh");
    expect(CODEX_MOBILE_HTML).toContain('aria-selected="true">任务</button>');
    expect(CODEX_MOBILE_HTML).toContain('aria-selected="false">最近</button>');
    expect(CODEX_MOBILE_HTML).not.toContain('aria-selected="true">任务看板</button>');
    expect(CODEX_MOBILE_HTML).not.toContain('aria-selected="false">最近完成</button>');
    expect(CODEX_MOBILE_JS).not.toContain("adapter-menu-caps");
    expect(CODEX_MOBILE_CSS).not.toContain(".adapter-menu-caps");
    expect(CODEX_MOBILE_JS).not.toContain("桌面原生 owner");
    expect(CODEX_MOBILE_JS).not.toContain("可见 CLI owner");
  });

  test("serves provider capabilities, dependencies and approval rules", async () => {
    const authStore = createAuthStore("settings password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [],
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
        progressItems: [],
        runSummary: null,
      }),
      sendMessage: async () => ({ queued: false }),
      readSettings: async () => ({
        strictApproval: true,
        approvalRules: [
          { id: "strict-approval", label: "严格审批", description: "全部交给远程端。" },
          { id: "task-free-pass", label: "任务免审", description: "已开启免审的任务自动接受。" },
        ],
        providers: [
          {
            id: "deepseek",
            label: "DeepSeek Harness",
            transport: "harness_host",
            owner: "shared_service_owner",
            continuity: "same_owner",
            localVisibility: "live",
            capabilities: {
              sessions: true,
              messages: true,
              images: true,
              queue: true,
              approvals: true,
              stop: true,
              nativeCommands: true,
            },
            dependencies: [
              { kind: "command", name: "dsh", hint: "未找到 dsh 命令。" },
              { kind: "port", name: "3080", hint: "3080 端口无监听。" },
            ],
          },
        ],
      }),
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${root}/api/settings`, {
        headers: { cookie: sessionCookie },
      });
      expect(response.status).toBe(200);
      const payload = await response.json() as {
        strictApproval: boolean;
        approvalRules: Array<{ id: string }>;
        providers: Array<{ id: string; dependencies: Array<{ kind: string }> }>;
      };
      expect(payload.strictApproval).toBe(true);
      expect(payload.approvalRules.map((rule) => rule.id)).toEqual([
        "strict-approval",
        "task-free-pass",
      ]);
      expect(payload.providers[0].id).toBe("deepseek");
      expect(payload.providers[0].dependencies.map((dep) => dep.kind)).toEqual([
        "command",
        "port",
      ]);
    } finally {
      await server.close();
    }
  });

  test("returns 409 when the connection does not expose settings", async () => {
    const authStore = createAuthStore("settings password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [],
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
        progressItems: [],
        runSummary: null,
      }),
      sendMessage: async () => ({ queued: false }),
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${root}/api/settings`, {
        headers: { cookie: sessionCookie },
      });
      expect(response.status).toBe(409);
    } finally {
      await server.close();
    }
  });

  test("updates strict approval through POST /api/settings", async () => {
    const authStore = createAuthStore("settings password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    let strictApproval = false;
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [],
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
        progressItems: [],
        runSummary: null,
      }),
      sendMessage: async () => ({ queued: false }),
      readSettings: async () => ({
        strictApproval,
        approvalRules: [],
        providers: [],
      }),
      updateSettings: async (patch) => {
        if (typeof patch.strictApproval === "boolean") {
          strictApproval = patch.strictApproval;
        }
        return { strictApproval, approvalRules: [], providers: [] };
      },
    });

    try {
      const root = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${root}/api/settings`, {
        method: "POST",
        headers: {
          cookie: sessionCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ strictApproval: true }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json() as { strictApproval: boolean };
      expect(payload.strictApproval).toBe(true);

      // GET reflects the update.
      const getResponse = await fetch(`${root}/api/settings`, {
        headers: { cookie: sessionCookie },
      });
      const fresh = await getResponse.json() as { strictApproval: boolean };
      expect(fresh.strictApproval).toBe(true);
    } finally {
      await server.close();
    }
  });

  test("starts a predefined provider installation through the settings API", async () => {
    const authStore = createAuthStore("settings password");
    const sessionCookie = `codex_mobile_session=${authStore.createSessionToken()}`;
    const calls: Array<{ providerId: string; dependencyId: string }> = [];
    const server = await startCodexMobileServer({
      host: "127.0.0.1",
      port: 0,
      lanAddress: "127.0.0.1",
      accessToken: "mobile-secret",
      authStore,
      listTasks: async () => [],
      readMessages: async (threadId) => ({
        threadId,
        messages: [],
        queuedMessages: [],
        progressItems: [],
        runSummary: null,
      }),
      sendMessage: async () => ({ queued: false }),
      installProviderDependency: async (providerId, dependencyId) => {
        calls.push({ providerId, dependencyId });
        return {
          accepted: true,
          status: "installing",
          message: "OpenCode 正在安装，请稍候。",
        };
      },
    });

    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/settings/providers/opencode/install`,
        {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ dependencyId: "opencode-cli" }),
        },
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ status: "installing" });
      expect(calls).toEqual([{ providerId: "opencode", dependencyId: "opencode-cli" }]);
    } finally {
      await server.close();
    }
  });
});

type MemoryStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function createMemoryStorage(): MemoryStorage {
  const values = new Map<string, string>();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function runtimeKey(adapter: string, threadId: string): string {
  return `${adapter}\u0000${threadId}`;
}

function createPersistentCacheTestState(): Record<string, any> {
  return {
    authenticated: false,
    cachePreviewMode: false,
    persistentCacheAuthenticatedAtMs: 0,
    adapters: [],
    currentAdapter: "codex",
    currentThreadId: "",
    tasks: [],
    taskSnapshots: Object.create(null),
    taskSnapshotOrder: [],
    conversationSnapshots: Object.create(null),
    conversationSnapshotOrder: [],
    composerDrafts: Object.create(null),
    composerDraftOrder: [],
    persistentCacheRestored: false,
    persistentCacheWriteTimer: null,
    boardTasks: [],
    boardRecentCompleted: [],
    boardLastLoadedAtMs: 0,
    serverMessages: [],
    historyMessages: [],
    latestMessages: [],
    oldestMessageCursor: null,
    hasOlderMessages: false,
    historySource: "",
    historyCaughtUp: true,
    progressItems: [],
    optimisticProgressTurnId: null,
    pendingMessages: [],
    transcriptSignature: "",
    queueSignature: "",
    queuedMessages: [],
    editingQueuedMessageId: "",
    editingQueuedImageCount: 0,
    pendingImages: [],
    runSummary: null,
    localRunSummary: null,
    pendingApproval: null,
    approvalResults: [],
    stopRequestedThreadId: "",
    messageNodes: Object.create(null),
  };
}

function loadMobilePersistentCacheRuntime(params: {
  state: Record<string, any>;
  storage: MemoryStorage | {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
  };
  nowMs: number;
}): {
  storageKey: string;
  schemaVersion: number;
  ttlMs: number;
  composerInput: { value: string; placeholder: string };
  renderEvents: string[];
  conversationStateKey: (adapter: string, threadId: string) => string;
  restorePersistentMobileCache: (adapter: string, threadId: string) => boolean;
  persistMobileCacheNow: () => boolean;
  clearPersistentMobileCache: () => void;
} {
  const start = CODEX_MOBILE_JS.indexOf("  function conversationStateKey");
  const end = CODEX_MOBILE_JS.indexOf("\n  function readSetupToken", start);
  if (start < 0 || end < 0) throw new Error("Mobile persistent cache source not found");
  const source = CODEX_MOBILE_JS.slice(start, end);
  const composerInput = { value: "", placeholder: "" };
  const renderEvents: string[] = [];
  const runtime = new Function(
    "state",
    "localStorage",
    "Date",
    "composerInput",
    "composerImageButton",
    "messagesEl",
    "renderPendingImages",
    "renderQueuedMessages",
    "resizeComposer",
    "renderMessages",
    "renderTasks",
    "renderAdapterMenu",
    "updateHeader",
    "requestAnimationFrame",
    "scrollToLatest",
    "updateUserMessageNavigation",
    "isNearBottom",
    "setTimeout",
    "clearTimeout",
    "MAX_COMPOSER_DRAFTS",
    "MAX_CONVERSATION_SNAPSHOTS",
    `${source}
return {
  storageKey: PERSISTENT_MOBILE_CACHE_STORAGE_NAME,
  schemaVersion: PERSISTENT_MOBILE_CACHE_SCHEMA_VERSION,
  ttlMs: PERSISTENT_MOBILE_CACHE_TTL_MS,
  conversationStateKey,
  restorePersistentMobileCache,
  persistMobileCacheNow,
  clearPersistentMobileCache
};`,
  )(
    params.state,
    params.storage,
    { now: () => params.nowMs },
    composerInput,
    { disabled: false },
    { scrollTop: 0 },
    () => renderEvents.push("images"),
    () => renderEvents.push("queue"),
    () => renderEvents.push("composer"),
    () => renderEvents.push("messages"),
    () => renderEvents.push("tasks"),
    () => renderEvents.push("adapters"),
    () => renderEvents.push("header"),
    (callback: () => void) => callback(),
    () => renderEvents.push("latest"),
    () => renderEvents.push("navigation"),
    () => true,
    (callback: () => void) => {
      callback();
      return 1;
    },
    () => {},
    40,
    12,
  ) as {
    storageKey: string;
    schemaVersion: number;
    ttlMs: number;
    conversationStateKey: (adapter: string, threadId: string) => string;
    restorePersistentMobileCache: (adapter: string, threadId: string) => boolean;
    persistMobileCacheNow: () => boolean;
    clearPersistentMobileCache: () => void;
  };
  return { ...runtime, composerInput, renderEvents };
}

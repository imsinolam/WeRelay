import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { createBridgeAdapter } from "../../src/bridge/bridge-adapters.ts";
import {
  DeepSeekHarnessAdapter,
  DeepSeekHarnessHttpClient,
  discoverDeepSeekDesktopHarnessBaseUrl,
  mapDeepSeekHarnessHistoryEvents,
  normalizeDeepSeekHarnessBaseUrl,
  resolveDeepSeekHarnessBaseUrl,
  type DeepSeekHarnessClientLike,
  type DeepSeekHarnessEnvelope,
  type DeepSeekHarnessHistoryEntry,
  type DeepSeekHarnessModelSelection,
  type DeepSeekHarnessSessionSummary,
} from "../../src/bridge/bridge-adapters.deepseek.ts";
import type { BridgeEvent } from "../../src/bridge/bridge-types.ts";

class AsyncEnvelopeQueue implements AsyncIterable<DeepSeekHarnessEnvelope> {
  private readonly items: DeepSeekHarnessEnvelope[] = [];
  private readonly waiters: Array<(value: IteratorResult<DeepSeekHarnessEnvelope>) => void> = [];
  private closed = false;

  push(value: DeepSeekHarnessEnvelope): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.items.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<DeepSeekHarnessEnvelope> {
    return {
      next: async () => {
        const item = this.items.shift();
        if (item) return { value: item, done: false };
        if (this.closed) return { value: undefined, done: true };
        return await new Promise<IteratorResult<DeepSeekHarnessEnvelope>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

function session(overrides: Partial<DeepSeekHarnessSessionSummary> = {}): DeepSeekHarnessSessionSummary {
  return {
    sessionId: "session-1",
    updatedAt: Date.parse("2026-08-14T08:00:00.000Z"),
    running: false,
    blank: false,
    cwd: "/tmp/project",
    projections: {
      values: {
        title: "Harness 任务",
      },
    },
    ...overrides,
  };
}

function createFakeClient(queue: AsyncEnvelopeQueue) {
  const responses: unknown[] = [];
  const prompts: unknown[] = [];
  const createdCwds: string[] = [];
  const selections: Array<{ sessionId: string; selection: DeepSeekHarnessModelSelection }> = [];
  const sessions = [session()];
  const historyEntries: DeepSeekHarnessHistoryEntry[] = [];
  const modelState = {
    current: {
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
    },
    routable: true,
    groups: [{
      id: "deepseek-official",
      name: "DeepSeek",
      models: [
        { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
        {
          id: "deepseek-v4-flash-vision-exp",
          name: "DeepSeek-V4-Flash-Vision-Exp",
        },
      ],
    }],
    failures: [],
  };
  const client: DeepSeekHarnessClientLike = {
    async describeHost() {
      return {
        version: "0.0.1",
        cwd: "/tmp/project",
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        attachedSessions: 1,
        canOpenPath: true,
      };
    },
    async listSessions() {
      return sessions;
    },
    async createSession(cwd) {
      createdCwds.push(cwd);
      return { sessionId: "session-new" };
    },
    async renameSession() {},
    async readHistory() {
      return { events: [...historyEntries], hasMore: false };
    },
    async readModels() {
      return modelState;
    },
    async selectModel(sessionId, selection) {
      selections.push({ sessionId, selection });
      modelState.current = { ...selection };
      return { selected: selection };
    },
    async prompt(sessionId, content) {
      prompts.push({ sessionId, content });
      return { rpcId: "prompt-rpc-1", value: { accepted: true } };
    },
    async cancelSession() {
      return { accepted: true };
    },
    async respond(message) {
      responses.push(message);
      return { accepted: true };
    },
    openMux() {
      return queue;
    },
  };
  return {
    client,
    prompts,
    responses,
    createdCwds,
    selections,
    sessions,
    historyEntries,
    modelState,
  };
}

describe("DeepSeek Harness task permission scope", () => {
  test("reads the permissions projection and switches through the native command", async () => {
    const queue = new AsyncEnvelopeQueue();
    const fake = createFakeClient(queue);
    fake.client.readHistory = async () => ({
      events: [],
      hasMore: false,
      projections: {
        asOfSeq: 4,
        values: {
          permissions: {
            currentValue: "workspace-write",
            options: [
              {
                value: "workspace-write",
                name: "Workspace write",
                description: "Write inside the workspace.",
              },
              {
                value: "danger-full-access",
                name: "Full access",
                description: "Full file access without approvals.",
              },
            ],
          },
        },
      },
    });
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
      renderMode: "headless",
    }, {
      createClient: () => fake.client,
    }) as any;

    expect(await adapter.getSessionPermissionState("session-1")).toMatchObject({
      currentPermission: "workspace-write",
      canChange: true,
      options: [
        { id: "workspace-write" },
        { id: "danger-full-access", requiresConfirmation: true },
      ],
    });

    fake.sessions[0].running = true;
    expect(await adapter.getSessionPermissionState("session-1")).toMatchObject({
      currentPermission: "workspace-write",
      canChange: true,
    });
    fake.sessions[0].running = false;

    const next = await adapter.setSessionPermission(
      "session-1",
      "danger-full-access",
    );
    expect(fake.prompts.at(-1)).toEqual({
      sessionId: "session-1",
      content: [{ type: "text", text: "/permission danger-full-access" }],
    });
    expect(next.currentPermission).toBe("danger-full-access");
  });
});

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("DeepSeek Harness HTTP client", () => {
  test("honors a shorter timeout for read-only catalog probes", async () => {
    const client = new DeepSeekHarnessHttpClient(
      "http://127.0.0.1:3080",
      ((_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason ?? new Error("aborted"));
        }, { once: true });
      })) as typeof fetch,
      20,
    );
    const startedAt = Date.now();

    await expect(client.listSessions()).rejects.toBeDefined();

    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});

describe("DeepSeek Harness endpoint discovery", () => {
  test("prefers the live DSH Desktop Host over a separate dsh web Host", () => {
    expect(resolveDeepSeekHarnessBaseUrl(undefined, {
      platform: "darwin",
      readProcessList: () =>
        "92652 /Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop\n" +
        "92749 /Applications/DSH Desktop.app/Contents/Frameworks/DSH Desktop Helper.app/Contents/MacOS/DSH Desktop Helper",
      readListeners: (pid) => pid === 92652
        ? "p92652\nf39\nn127.0.0.1:58208\n"
        : "",
    })).toBe("http://127.0.0.1:58208");
  });

  test("keeps an explicit loopback Harness URL authoritative", () => {
    expect(resolveDeepSeekHarnessBaseUrl("http://127.0.0.1:3080", {
      platform: "darwin",
      readProcessList: () =>
        "92652 /Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop",
      readListeners: () => "n127.0.0.1:58208",
    })).toBe("http://127.0.0.1:3080");
  });

  test("falls back to dsh web when DSH Desktop is not installed", () => {
    // The 3080 default belongs to the `dsh web` CLI, so it only applies when
    // the Desktop app is absent from this machine.
    expect(resolveDeepSeekHarnessBaseUrl(undefined, {
      platform: "darwin",
      readProcessList: () => "57127 node /usr/local/bin/dsh web",
      readListeners: () => "",
      readPortListeners: () => "",
      appInstalled: () => false,
    })).toBe("http://127.0.0.1:3080");
  });
});

describe("DeepSeek Harness adapter", () => {
  test("uses the Harness WebSocket event stream instead of the HTTP endpoint", async () => {
    const originalWebSocket = globalThis.WebSocket;
    let openedUrl = "";
    class FakeWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeWebSocket.CONNECTING;

      constructor(url: string | URL) {
        super();
        openedUrl = String(url);
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.OPEN;
          this.dispatchEvent(new Event("open"));
          this.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify({
              type: "server-request",
              rpcId: "mux-frame-1",
              method: "session/subscribed",
              payload: {
                type: "session/subscribed",
                sessionId: "session-1",
                lastSeq: 9,
              },
            }),
          }));
        });
      }

      close(): void {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
    }
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
    const client = new DeepSeekHarnessHttpClient(
      "http://127.0.0.1:3080",
      (() => {
        throw new Error("openMux must not use HTTP fetch");
      }) as typeof fetch,
    );
    const controller = new AbortController();
    try {
      const iterator = client.openMux(controller.signal)[Symbol.asyncIterator]();
      expect(await iterator.next()).toEqual({
        done: false,
        value: {
          rpcId: "mux-frame-1",
          payload: {
            type: "session/subscribed",
            sessionId: "session-1",
            lastSeq: 9,
          },
        },
      });
      expect(openedUrl).toBe("ws://127.0.0.1:3080/api/events.mux");
      controller.abort();
      await iterator.return?.();
    } finally {
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: originalWebSocket,
      });
    }
  });

  test("is registered as a first-class WeRelay adapter", () => {
    const adapter = createBridgeAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    });
    expect(adapter).toBeInstanceOf(DeepSeekHarnessAdapter);
    expect(adapter.getState()).toMatchObject({
      kind: "deepseek",
      command: "dsh",
    });
  });

  test("accepts only loopback Harness endpoints", () => {
    expect(normalizeDeepSeekHarnessBaseUrl(undefined)).toBe("http://127.0.0.1:3080");
    expect(normalizeDeepSeekHarnessBaseUrl("http://localhost:3080/")).toBe("http://localhost:3080");
    expect(() => normalizeDeepSeekHarnessBaseUrl("https://example.com")).toThrow("loopback");
    expect(() => normalizeDeepSeekHarnessBaseUrl("http://user:pass@127.0.0.1:3080")).toThrow("credentials");
  });

  test("maps only real user text and visible assistant output", () => {
    const messages = mapDeepSeekHarnessHistoryEvents([
      {
        event: {
          type: "user/message",
          seq: 1,
          time: 100,
          data: {
            id: "user-real",
            role: "user",
            source: { kind: "user", rpcId: "prompt-1" },
            content: [{ type: "text", text: "真实问题" }],
          },
        },
      },
      {
        event: {
          type: "user/message",
          seq: 2,
          time: 101,
          data: {
            id: "user-injected",
            role: "user",
            source: { kind: "plugin", plugin: "system" },
            content: [{ type: "text", text: "内部上下文" }],
          },
        },
      },
      {
        event: {
          type: "assistant/message",
          seq: 3,
          time: 102,
          data: {
            turn: 7,
            step: 1,
            message: {
              id: "assistant-1",
              role: "assistant",
              source: {
                kind: "model",
                provider: "deepseek-official",
                model: "deepseek-v4-flash",
              },
              content: [
                { type: "reasoning", text: "内部思考不能泄露" },
                { type: "text", text: "可见答案" },
              ],
            },
          },
        },
      },
    ]);

    expect(messages).toEqual([
      {
        role: "user",
        text: "真实问题",
        id: "user-real",
        createdAtMs: 100,
      },
      {
        role: "assistant",
        text: "可见答案",
        id: "assistant-1",
        turnId: "7",
        phase: "final_answer",
        createdAtMs: 102,
        model: "deepseek-v4-flash",
      },
    ]);
  });

  test("recovers a protected DSH Desktop host only after an explicit switch", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client: workingClient } = createFakeClient(queue);
    const protectedClient: DeepSeekHarnessClientLike = {
      ...workingClient,
      async describeHost() {
        throw new Error("DeepSeek Harness host.describe transport failed: HTTP 403");
      },
    };
    let clientCount = 0;
    let recoveryCount = 0;
    let recoveredEndpointChecks = 0;
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
      allowDesktopApplicationLaunch: true,
    }, {
      createClient: () => clientCount++ === 0 ? protectedClient : workingClient,
      resolveBaseUrl: () => "http://127.0.0.1:43120",
      resolveRecoveredBaseUrl: () => recoveredEndpointChecks++ === 0
        ? null
        : "http://127.0.0.1:43120",
      recoverDesktopAccess: async () => {
        recoveryCount += 1;
        return true;
      },
      sleep: async () => undefined,
      now: (() => {
        let now = 0;
        return () => now += 100;
      })(),
    });

    await adapter.start();
    expect(recoveryCount).toBe(1);
    expect(clientCount).toBe(2);
    expect(recoveredEndpointChecks).toBe(2);
    expect(adapter.getState()).toMatchObject({
      status: "idle",
      sharedSessionId: "session-1",
    });
    await adapter.dispose();
  });

  test("does not restart DSH Desktop during background startup", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client } = createFakeClient(queue);
    const protectedClient: DeepSeekHarnessClientLike = {
      ...client,
      async describeHost() {
        throw new Error("DeepSeek Harness host.describe transport failed: HTTP 403");
      },
    };
    let recoveryCount = 0;
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
      allowDesktopApplicationLaunch: false,
    }, {
      createClient: () => protectedClient,
      resolveBaseUrl: () => "http://127.0.0.1:43120",
      recoverDesktopAccess: async () => {
        recoveryCount += 1;
        return true;
      },
    });

    await expect(adapter.start()).rejects.toThrow("HTTP 403");
    expect(recoveryCount).toBe(0);
    await adapter.dispose();
  });

  test("reports the original failure when the desktop recovery window expires without a listening host", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client } = createFakeClient(queue);
    const protectedClient: DeepSeekHarnessClientLike = {
      ...client,
      async describeHost() {
        throw new Error("DeepSeek Harness host.describe transport failed: HTTP 403");
      },
    };
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
      allowDesktopApplicationLaunch: true,
    }, {
      createClient: () => protectedClient,
      resolveBaseUrl: () => "http://127.0.0.1:43120",
      // The restarted Desktop never publishes a loopback port in this window.
      resolveRecoveredBaseUrl: () => null,
      recoverDesktopAccess: async () => true,
      sleep: async () => undefined,
      now: (() => {
        let now = 0;
        return () => now += 5_000;
      })(),
    });

    const failure = await adapter.start().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("undefined");
    expect((failure as Error).message).toContain("HTTP 403");
    await adapter.dispose();
  });

  test("uses the existing Harness owner and forwards a WeChat turn without reasoning", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, prompts } = createFakeClient(queue);
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));

    await adapter.start();
    await adapter.sendInput("继续处理");
    expect(prompts).toEqual([{
      sessionId: "session-1",
      content: [{ type: "text", text: "继续处理" }],
    }]);

    queue.push({
      rpcId: "turn-start",
      payload: {
        type: "session/event",
        sessionId: "session-1",
        event: { type: "turn/start", seq: 10, time: 200, data: { turn: 3 } },
      },
    });
    queue.push({
      rpcId: "user-message",
      payload: {
        type: "session/event",
        sessionId: "session-1",
        event: {
          type: "user/message",
          seq: 11,
          time: 201,
          data: {
            id: "user-1",
            role: "user",
            source: { kind: "user", rpcId: "prompt-rpc-1" },
            content: [{ type: "text", text: "继续处理" }],
          },
        },
      },
    });
    queue.push({
      rpcId: "assistant-message",
      payload: {
        type: "session/event",
        sessionId: "session-1",
        event: {
          type: "assistant/message",
          seq: 12,
          time: 202,
          data: {
            turn: 3,
            step: 1,
            message: {
              id: "assistant-1",
              role: "assistant",
              source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
              content: [
                { type: "reasoning", text: "秘密思考" },
                { type: "text", text: "已经完成" },
              ],
            },
          },
        },
      },
    });
    queue.push({
      rpcId: "turn-end",
      payload: {
        type: "session/event",
        sessionId: "session-1",
        event: {
          type: "turn/end",
          seq: 13,
          time: 203,
          data: { turn: 3, reason: { kind: "completed" } },
        },
      },
    });
    await nextTurn();

    expect(events).toContainEqual({
      type: "final_reply",
      text: "已经完成",
      timestamp: new Date(202).toISOString(),
      threadId: "session-1",
      turnId: "3",
      origin: "wechat",
    });
    expect(events.some((event) =>
      event.type === "final_reply" && event.text.includes("秘密思考")
    )).toBe(false);
    expect(adapter.getState()).toMatchObject({
      kind: "deepseek",
      status: "idle",
      sharedSessionId: "session-1",
    });
    await adapter.dispose();
  });

  test("lists every Harness provider group and switches duplicate model ids precisely", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, selections } = createFakeClient(queue);
    client.readModels = async () => ({
      current: {
        provider: "tencent-intranet",
        model: "shared-model",
      },
      routable: true,
      groups: [
        {
          id: "deepseek-official",
          name: "DeepSeek",
          models: [
            { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
            { id: "shared-model", name: "共享模型" },
          ],
        },
        {
          id: "tencent-intranet",
          name: "Tencent",
          models: [
            { id: "hunyuan-t1", name: "混元 T1" },
            { id: "shared-model", name: "共享模型" },
          ],
        },
        {
          id: "openrouter",
          name: "OpenRouter",
          models: [{
            id: "anthropic/claude-sonnet",
            name: "Claude Sonnet",
            description: "经 OpenRouter 路由",
          }],
        },
      ],
      failures: [],
    });
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });

    expect(await adapter.getSessionModelState("session-1")).toEqual({
      currentModel: "tencent-intranet::shared-model",
      options: [
        { id: "deepseek-official::deepseek-v4-flash", label: "DeepSeek V4 Flash", group: "DeepSeek" },
        { id: "deepseek-official::shared-model", label: "共享模型", group: "DeepSeek" },
        { id: "tencent-intranet::hunyuan-t1", label: "混元 T1", group: "Tencent" },
        { id: "tencent-intranet::shared-model", label: "共享模型", group: "Tencent" },
        {
          id: "openrouter::anthropic/claude-sonnet",
          label: "Claude Sonnet",
          group: "OpenRouter",
          description: "经 OpenRouter 路由",
        },
      ],
      canChange: true,
    });

    await adapter.setSessionModel("session-1", "deepseek-official::shared-model");
    expect(selections.at(-1)).toEqual({
      sessionId: "session-1",
      selection: { provider: "deepseek-official", model: "shared-model" },
    });
  });

  test("keeps legacy bare Harness model ids compatible and prefers the current provider", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, selections } = createFakeClient(queue);
    client.readModels = async () => ({
      current: { provider: "tencent-intranet", model: "shared-model" },
      routable: true,
      groups: [
        {
          id: "deepseek-official",
          name: "DeepSeek",
          models: [{ id: "shared-model", name: "共享模型" }],
        },
        {
          id: "tencent-intranet",
          name: "Tencent",
          models: [{ id: "shared-model", name: "共享模型" }],
        },
      ],
      failures: [],
    });
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });

    await adapter.setSessionModel("session-1", "shared-model");
    expect(selections.at(-1)).toEqual({
      sessionId: "session-1",
      selection: { provider: "tencent-intranet", model: "shared-model" },
    });
  });

  test("reads and switches the Harness reasoning effort without allowing xhigh", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, selections } = createFakeClient(queue);
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });

    expect(await adapter.getSessionModelState("session-1")).toMatchObject({
      currentModel: "deepseek-official::deepseek-v4-flash",
      currentReasoningEffort: "high",
      reasoningEffortOptions: [
        { id: "low", label: "低" },
        { id: "medium", label: "中" },
        { id: "high", label: "高" },
      ],
      canChangeReasoningEffort: true,
    });
    expect(await adapter.setSessionReasoningEffort("session-1", "low"))
      .toMatchObject({ canChangeReasoningEffort: true });
    expect(selections.at(-1)).toEqual({
      sessionId: "session-1",
      selection: {
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        reasoningEffort: "low",
      },
    });
    await expect(adapter.setSessionReasoningEffort("session-1", "xhigh"))
      .rejects.toThrow("当前不可用");
  });

  test("keeps the Harness session reasoning setting unset while switching models", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, selections } = createFakeClient(queue);
    client.readModels = async () => ({
      current: {
        provider: "deepseek-official",
        model: "deepseek-v4-flash-vision-exp",
      },
      routable: true,
      groups: [{
        id: "deepseek-official",
        name: "DeepSeek",
        models: [
          { id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" },
          { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek-V4-Flash-Vision-Exp" },
        ],
      }],
      failures: [],
    });
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });

    await adapter.setSessionModel(
      "session-1",
      "deepseek-official::deepseek-v4-flash",
    );
    expect(selections.at(-1)).toEqual({
      sessionId: "session-1",
      selection: {
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
      },
    });
  });

  test("uses the Harness cwd folder as the mobile project identity", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, sessions } = createFakeClient(queue);
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });

    const [candidate] = await adapter.listResumeSessions(10);
    expect(candidate).toMatchObject({
      title: "Harness 任务",
      cwd: "/tmp/project",
      projectId: "/tmp/project",
      projectName: "project",
    });

    sessions[0] = session({ cwd: "C:\\work\\wechat_canvas\\" });
    const [windowsCandidate] = await adapter.listResumeSessions(10);
    expect(windowsCandidate).toMatchObject({
      projectId: "C:\\work\\wechat_canvas",
      projectName: "wechat_canvas",
    });
  });

  test("creates a fresh V4 Flash high-reasoning session only when explicitly requested", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, createdCwds, selections } = createFakeClient(queue);
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/new-project",
      sessionStartMode: "new",
    }, { createClient: () => client });

    await adapter.start();
    expect(createdCwds).toEqual(["/tmp/new-project"]);
    expect(selections).toEqual([{
      sessionId: "session-new",
      selection: {
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        reasoningEffort: "high",
      },
    }]);
    expect(adapter.getState()).toMatchObject({
      sharedSessionId: "session-new",
      cwd: "/tmp/new-project",
      status: "idle",
    });
    await adapter.dispose();
  });

  test("refuses to replace a missing persisted Harness task with another session", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, createdCwds } = createFakeClient(queue);
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
      initialSharedSessionId: "missing-session",
      sessionStartMode: "restore",
    }, { createClient: () => client });

    await expect(adapter.start()).rejects.toThrow("避免会话分叉");
    expect(createdCwds).toEqual([]);
    expect(adapter.getState().status).toBe("error");
    await adapter.dispose();
  });

  test("keeps the selected Harness session cwd in adapter state", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, sessions } = createFakeClient(queue);
    sessions[0] = session({ cwd: "/tmp/harness-real-workspace" });
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/daemon-workspace",
    }, { createClient: () => client });

    await adapter.start();
    expect(adapter.getState().cwd).toBe("/tmp/harness-real-workspace");
    await adapter.dispose();
  });

  test("recovers a missed Harness completion from native history", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, historyEntries } = createFakeClient(queue);
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));
    await adapter.start();
    await adapter.sendInput("从历史恢复");

    historyEntries.push(
      {
        event: { type: "turn/start", seq: 20, time: 300, data: { turn: 4 } },
      },
      {
        event: {
          type: "user/message",
          seq: 21,
          time: 301,
          data: {
            source: { kind: "user", rpcId: "prompt-rpc-1" },
            content: [{ type: "text", text: "从历史恢复" }],
          },
        },
      },
      {
        event: {
          type: "assistant/message",
          seq: 22,
          time: 302,
          data: {
            turn: 4,
            message: {
              source: { kind: "model", model: "deepseek-v4-flash" },
              content: [
                { type: "reasoning", text: "不会外发" },
                { type: "text", text: "历史恢复成功" },
              ],
            },
          },
        },
      },
      {
        event: {
          type: "turn/end",
          seq: 23,
          time: 303,
          data: { turn: 4, reason: { kind: "completed" } },
        },
      },
    );
    queue.push({
      rpcId: "subscribed",
      payload: { type: "session/subscribed", sessionId: "session-1", lastSeq: 23 },
    });
    await nextTurn();
    await nextTurn();

    expect(events).toContainEqual({
      type: "final_reply",
      text: "历史恢复成功",
      timestamp: new Date(302).toISOString(),
      threadId: "session-1",
      turnId: "4",
      origin: "wechat",
    });
    expect(events.some((event) =>
      event.type === "final_reply" && event.text.includes("不会外发")
    )).toBe(false);
    await adapter.dispose();
  });

  test("encodes local images into the existing Harness session prompt", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-deepseek-image-"));
    const imagePath = path.join(directory, "sample.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const queue = new AsyncEnvelopeQueue();
      const { client, prompts } = createFakeClient(queue);
      const adapter = new DeepSeekHarnessAdapter({
        kind: "deepseek",
        command: "dsh",
        cwd: "/tmp/project",
      }, { createClient: () => client });
      await adapter.start();

      await adapter.sendInputItemsToSession("session-1", [
        { type: "text", text: "看图" },
        { type: "localImage", path: imagePath },
      ]);
      expect(prompts).toEqual([{
        sessionId: "session-1",
        content: [
          { type: "text", text: "看图" },
          {
            type: "image",
            mediaType: "image/png",
            data: "iVBORw==",
            name: "sample.png",
          },
        ],
      }]);
      await adapter.dispose();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("switches a blank WeRelay-created image task to the available vision model", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "werelay-deepseek-vision-"));
    const imagePath = path.join(directory, "sample.png");
    fs.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const queue = new AsyncEnvelopeQueue();
      const { client, prompts, selections, sessions } = createFakeClient(queue);
      sessions[0] = session({ blank: true });
      const adapter = new DeepSeekHarnessAdapter({
        kind: "deepseek",
        command: "dsh",
        cwd: "/tmp/project",
      }, { createClient: () => client });
      await adapter.start();

      await adapter.sendInputItemsToSession("session-1", [
        { type: "text", text: "看图" },
        { type: "localImage", path: imagePath },
      ]);

      expect(selections).toContainEqual({
        sessionId: "session-1",
        selection: {
          provider: "deepseek-official",
          model: "deepseek-v4-flash-vision-exp",
          reasoningEffort: "high",
        },
      });
      expect(prompts).toHaveLength(1);
      await adapter.dispose();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("surfaces the nested Harness model failure instead of a generic error", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, historyEntries } = createFakeClient(queue);
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));
    await adapter.start();
    await adapter.sendInputToSession("session-1", "继续任务");

    historyEntries.push(
      {
        event: { type: "turn/start", seq: 1, time: 100, data: { turn: 3 } },
      },
      {
        event: {
          type: "user/message",
          seq: 2,
          time: 101,
          data: {
            source: { kind: "user", rpcId: "prompt-rpc-1" },
            content: [{ type: "text", text: "继续任务" }],
          },
        },
      },
      {
        event: {
          type: "turn/end",
          seq: 3,
          time: 102,
          data: {
            turn: 3,
            reason: {
              kind: "error",
              error: {
                message: 'model "stealth/ox-alpha" returned a completed response with no content',
                code: "EMPTY_RESPONSE",
              },
            },
          },
        },
      },
    );
    queue.push({
      rpcId: "turn-end",
      payload: {
        type: "session/event",
        sessionId: "session-1",
        event: {
          type: "turn/end",
          seq: 3,
          time: 102,
          data: {
            turn: 3,
            reason: {
              kind: "error",
              error: {
                message: 'model "stealth/ox-alpha" returned a completed response with no content',
                code: "EMPTY_RESPONSE",
              },
            },
          },
        },
      },
    });
    await nextTurn();
    await nextTurn();
    await nextTurn();

    expect(events).toContainEqual({
      type: "task_failed",
      message: "OpenRouter 的 ox-alpha 模型返回了空响应，请切换到其他模型后重试。",
      timestamp: new Date(102).toISOString(),
      threadId: "session-1",
      turnId: "3",
      origin: "wechat",
    });
    await adapter.dispose();
  });

  test("includes the nested Harness error in the session run summary", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, historyEntries, sessions } = createFakeClient(queue);
    sessions[0] = session({ updatedAt: 200 });
    historyEntries.push(
      {
        event: { type: "turn/start", seq: 1, time: 100, data: { turn: 2 } },
      },
      {
        event: {
          type: "turn/end",
          seq: 2,
          time: 200,
          data: {
            turn: 2,
            reason: {
              kind: "error",
              error: {
                message: 'model "stealth/ox-alpha" returned a completed response with no content',
                code: "EMPTY_RESPONSE",
              },
            },
          },
        },
      },
    );
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });

    expect(await adapter.getSessionRunSummary("session-1")).toEqual({
      turnId: "2",
      status: "failed",
      startedAtMs: 100,
      completedAtMs: 200,
      durationMs: 100,
      errorMessage: "OpenRouter 的 ox-alpha 模型返回了空响应，请切换到其他模型后重试。",
    });
  });

  test("reports a cancelled Harness turn as interrupted when no turn-end was persisted", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, historyEntries, sessions } = createFakeClient(queue);
    sessions[0] = session({
      running: false,
      updatedAt: 500,
    });
    historyEntries.push(
      {
        event: {
          type: "turn/end",
          seq: 10,
          time: 200,
          data: { turn: 2, reason: { kind: "completed" } },
        },
      },
      {
        event: {
          type: "turn/start",
          seq: 11,
          time: 300,
          data: { turn: 3 },
        },
      },
    );
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });

    expect(await adapter.getSessionRunSummary("session-1")).toEqual({
      turnId: "3",
      status: "interrupted",
      startedAtMs: 300,
      completedAtMs: 500,
      durationMs: 200,
    });
  });

  test("answers Harness approvals through the original request rpcId", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, responses } = createFakeClient(queue);
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));
    await adapter.start();

    queue.push({
      rpcId: "approval-rpc-1",
      payload: {
        type: "approval/requested",
        sessionId: "session-1",
        approvalId: "approval-1",
        toolName: "bash",
        callId: "call-1",
        reason: "需要运行命令",
      },
    });
    await nextTurn();

    expect(events.some((event) => event.type === "approval_required" &&
      event.request.requestId === "approval-rpc-1" &&
      event.request.threadId === "session-1")).toBe(true);
    expect(await adapter.resolveApproval("confirm")).toBe(true);
    expect(responses).toEqual([{
      type: "client-response",
      rpcId: "approval-rpc-1",
      result: {
        ok: true,
        value: {
          sessionId: "session-1",
          approvalId: "approval-1",
          outcome: "allowed-once",
        },
      },
    }]);
    await adapter.dispose();
  });

  test("rejects Harness approvals and answers Harness questions with their original rpcIds", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, responses } = createFakeClient(queue);
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });
    await adapter.start();

    queue.push({
      rpcId: "approval-rpc-deny",
      payload: {
        type: "approval/requested",
        sessionId: "session-1",
        approvalId: "approval-deny",
        toolName: "bash",
      },
    });
    await nextTurn();
    expect(await adapter.resolveApproval("deny")).toBe(true);

    queue.push({
      rpcId: "question-rpc-1",
      payload: {
        type: "question/requested",
        sessionId: "session-1",
        questions: [{
          id: "choice",
          question: "选择方案",
          options: [{ label: "方案甲" }, { label: "方案乙" }],
        }],
      },
    });
    await nextTurn();
    expect(await adapter.submitUserInput({ choice: ["方案乙"] })).toBe(true);

    expect(responses).toEqual([
      {
        type: "client-response",
        rpcId: "approval-rpc-deny",
        result: {
          ok: true,
          value: {
            sessionId: "session-1",
            approvalId: "approval-deny",
            outcome: "rejected",
          },
        },
      },
      {
        type: "client-response",
        rpcId: "question-rpc-1",
        result: {
          ok: true,
          value: {
            sessionId: "session-1",
            answer: {
              answers: [{ id: "choice", selected: ["方案乙"] }],
            },
          },
        },
      },
    ]);
    await adapter.dispose();
  });

  test("sorts task activity before truncating and preserves the host running flag", async () => {
    const queue = new AsyncEnvelopeQueue();
    const {client} = createFakeClient(queue);
    client.listSessions = async () => [session({sessionId:"old", updatedAt:1000}), session({sessionId:"latest", updatedAt:9000, running:true})];
    const adapter = new DeepSeekHarnessAdapter({kind:"deepseek",command:"dsh",cwd:"/tmp/project"},{createClient:()=>client});
    expect((await adapter.listResumeSessions(1)).map((x) => [x.sessionId,x.runtimeStatus?.type])).toEqual([["latest","active"]]);
    await adapter.dispose();
  });

  test("background question preserves native custom-answer capability and responds to the exact rpc without a new prompt", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client, responses, prompts } = createFakeClient(queue);
    const adapter = new DeepSeekHarnessAdapter({ kind: "deepseek", command: "dsh", cwd: "/tmp/project" }, { createClient: () => client });
    await adapter.start();
    queue.push({ rpcId: "background-question", payload: { type: "question/requested", sessionId: "session-background", questions: [{
      id: "choice", question: "选一个方向", multiSelect: true, options: [{label: "甲"}, {label: "乙"}],
    }] } });
    await nextTurn();
    const pending = adapter.getPendingTaskUserInput("session-background");
    expect(pending?.questions[0]?.isOther).toBe(true);
    expect(pending?.questions[0]?.multiSelect).toBe(true);
    expect(adapter.getPendingTaskUserInput("session-other")).toBeNull();
    expect(adapter.getState().sharedSessionId).not.toBe("session-background");
    expect(await adapter.submitTaskUserInput("session-background", {choice: ["user_note: 请先解释方案"]})).toBe(true);
    expect(responses.at(-1)).toMatchObject({ rpcId: "background-question", result: {ok: true, value: {
      sessionId: "session-background", answer: {answers: [{id: "choice", selected: [], custom: "请先解释方案"}]},
    }} });
    expect(adapter.getPendingTaskUserInput("session-background")).toBeNull();
    expect(prompts).toHaveLength(0);

    await adapter.dispose();
  });

  test("keeps model switching available when the current provider is no longer routable", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client } = createFakeClient(queue);
    const originalReadModels = client.readModels;
    client.readModels = async () => ({
      current: { provider: "ox-alpha", model: "ox-alpha" },
      routable: false,
      groups: [{
        id: "deepseek-official",
        name: "DeepSeek",
        models: [{ id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" }],
      }],
      failures: [{
        id: "ox-alpha",
        name: "OX Alpha",
        message: "provider offline",
      }],
    });
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });

    const state = await adapter.getSessionModelState!("session-1");
    expect(state.currentModel).toBe("ox-alpha::ox-alpha");
    expect(state.canChange).toBe(true);
    expect(state.options).toEqual([{
      id: "deepseek-official::deepseek-v4-flash",
      label: "DeepSeek-V4-Flash",
      group: "DeepSeek",
    }]);
    expect(state.unavailableReason).toBeUndefined();
    client.readModels = originalReadModels;
  });
});

describe("DeepSeek Harness reconnect policy", () => {
  test("uses a bounded backoff after repeated failed event connections", () => {
    const source = fs
      .readFileSync(new URL("../../src/bridge/bridge-adapters.deepseek.ts", import.meta.url), "utf8")
      .replace(/\r\n/g, "\n");
    const loop = source.slice(source.indexOf("private async runMuxLoop"), source.indexOf("private handleMuxEnvelope"));
    expect(loop).toContain("consecutiveFailures");
    expect(loop).toContain("Math.min(\n        30_000");
    expect(loop).toContain("consecutiveFailures += 1");
    expect(loop).toContain("consecutiveFailures = 0");
    const sourceStart = source.indexOf("private scheduleMuxRecoveryNotice");
    const sourceEnd = source.indexOf("private handleMuxEnvelope", sourceStart);
    const noticeBlock = source.slice(sourceStart, sourceEnd);
    expect(noticeBlock).toContain("cancel the");
    expect(noticeBlock).toContain("muxOutageNoticeTimer = null");
  });
});

describe("DeepSeek Harness disconnect notice dedup", () => {
  test("sends one warning per outage episode and an info notice on recovery", { timeout: 20_000 }, async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client: baseClient } = createFakeClient(queue);
    let muxFailing = true;
    let failedAttempts = 0;
    const client: DeepSeekHarnessClientLike = {
      ...baseClient,
      openMux(): AsyncIterable<DeepSeekHarnessEnvelope> {
        if (!muxFailing) return queue;
        failedAttempts += 1;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<DeepSeekHarnessEnvelope>> {
                throw new Error("DeepSeek Harness WebSocket 连接失败。");
              },
            };
          },
        };
      },
    };
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });
    const events: BridgeEvent[] = [];
    adapter.setEventSink((event) => events.push(event));
    await adapter.start();

    const notices = () =>
      events.flatMap((event) => event.type === "notice" ? [event] : []);
    const disconnectNotices = () =>
      notices().filter((event) => event.text.includes("事件连接暂时中断"));

    async function waitFor(predicate: () => boolean): Promise<void> {
      const deadline = Date.now() + 20_000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("timed out waiting for mux loop state");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    try {
      await waitFor(() => disconnectNotices().length === 1);
      await waitFor(() => failedAttempts >= 2);
      expect(disconnectNotices()).toHaveLength(1);

      muxFailing = false;
      queue.push({
        rpcId: "mux-recovered",
        payload: { type: "session/subscribed", sessionId: "session-1", lastSeq: 1 },
      });
      await waitFor(() =>
        notices().some((event) =>
          event.level === "info" && event.text.includes("事件连接已恢复")
        )
      );
      expect(disconnectNotices()).toHaveLength(1);
    } finally {
      await adapter.dispose();
    }
  });
});

test("a failed subscribed-session history refresh does not become an unhandled daemon rejection", async () => {
  const queue = new AsyncEnvelopeQueue();
  const fake = createFakeClient(queue);
  const adapter = new DeepSeekHarnessAdapter({ kind: "deepseek", command: "dsh", cwd: "/tmp/project" }, { createClient: () => fake.client });
  const events: BridgeEvent[] = [];
  adapter.setEventSink(event => events.push(event));
  await adapter.start();
  fake.client.readHistory = async () => { throw new Error("readHistory timeout"); };
  try {
    queue.push({ rpcId: "refresh-failure", payload: { type: "session/subscribed", sessionId: "session-1", lastSeq: 1 } });
    await Bun.sleep(25);
    expect(events.some(event => event.type === "notice" && event.text.includes("历史同步暂时失败"))).toBe(true);
    expect(adapter.getState().status).not.toBe("error");
  } finally { await adapter.dispose(); }
});

test("a failed end-of-turn history refresh preserves the adapter without an unhandled rejection", async () => {
  const queue = new AsyncEnvelopeQueue();
  const fake = createFakeClient(queue);
  const adapter = new DeepSeekHarnessAdapter({ kind: "deepseek", command: "dsh", cwd: "/tmp/project" }, { createClient: () => fake.client });
  const events: BridgeEvent[] = [];
  adapter.setEventSink(event => events.push(event));
  await adapter.start();
  await adapter.sendInputToSession("session-1", "继续任务");
  fake.client.readHistory = async () => { throw new Error("readHistory timeout"); };
  try {
    queue.push({ rpcId: "turn-end-refresh-failure", payload: {
      type: "session/event", sessionId: "session-1",
      event: { type: "turn/end", seq: 3, time: 102, data: { turn: 1, reason: { kind: "completed" } } },
    } });
    const failedNotice = () => events.some(event => event.type === "notice" && event.text.includes("历史同步暂时失败"));
    const deadline = Date.now() + 500;
    while (!failedNotice() && Date.now() < deadline) await Bun.sleep(5);
    expect(failedNotice()).toBe(true);
    expect(adapter.getState().status).not.toBe("error");
  } finally { await adapter.dispose(); }
});

describe("DeepSeek Harness dual-dialect support", () => {
  /** A Typert host: serves slash endpoints, requires `args`, 404s legacy names. */
  function typertFetch(calls: Array<{ url: string; body: unknown }>): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/api/session.list")) {
        return new Response("not found", { status: 404 });
      }
      if (url.endsWith("/api/session/list")) {
        return new Response(JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId,
          result: {
            ok: true,
            value: {
              items: [{
                sessionId: "session-1",
                updatedAt: 1,
                running: false,
                blank: false,
                projections: { asOfSeq: 42 },
              }],
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  test("detects the Typert dialect and uses slash endpoints with args wrappers", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new DeepSeekHarnessHttpClient(
      "http://127.0.0.1:43120",
      typertFetch(calls),
      5_000,
      null,
    );

    const sessions = await client.listSessions();
    expect(sessions.map((session) => session.sessionId)).toEqual(["session-1"]);

    // The probe and the real call both target the Typert endpoint.
    const listCall = calls.at(-1)!;
    expect(listCall.url).toContain("/api/session/list");
    expect(listCall.body).toMatchObject({
      method: "session/list",
      payload: { args: { _request: {} } },
    });
  });

  test("wraps mutating Typert endpoints with a request field", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/api/session.list")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({
        type: "server-response",
        rpcId: body.rpcId,
        result: { ok: true, value: { accepted: true } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const client = new DeepSeekHarnessHttpClient("http://127.0.0.1:43120", fetchImpl, 5_000, null);
    await client.cancelSession("session-1");

    const cancelCall = calls.at(-1)!;
    expect(cancelCall.url).toContain("/api/session/cancel");
    expect(cancelCall.body).toMatchObject({
      payload: { args: { request: { sessionId: "session-1" } } },
    });
  });

  test("sends catalog endpoints with empty args because they declare no parameters", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/api/session.list")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({
        type: "server-response",
        rpcId: body.rpcId,
        result: {
          ok: true,
          value: { default: { provider: "deepseek-official", model: "deepseek-v4-flash" }, groups: [] },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const client = new DeepSeekHarnessHttpClient("http://127.0.0.1:43120", fetchImpl, 5_000, null);
    // The full model-state path also opens a native session snapshot; that
    // integration is covered by deepseek-harness-remote.test.ts's fake host.
    await client["callEndpoint"]("readModels", {});

    const catalogCall = calls.at(-1)!;
    expect(catalogCall.url).toContain("/api/session/modelCatalog");
    expect(catalogCall.body).toMatchObject({ payload: { args: {} } });
  });

  test("keeps the legacy dialect when the host does not serve slash endpoints", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/api/session/list")) return new Response("not found", { status: 404 });
      if (url.endsWith("/api/session.list")) {
        return new Response(JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId,
          result: { ok: true, value: { items: [] } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = new DeepSeekHarnessHttpClient("http://127.0.0.1:3080", fetchImpl, 5_000, null);
    expect(await client.listSessions()).toEqual([]);

    const legacyCall = calls.at(-1)!;
    expect(legacyCall.url).toContain("/api/session.list");
    // Legacy payloads stay unwrapped so 2.0.3 keeps working unchanged.
    expect(legacyCall.body).toMatchObject({ payload: {} });
  });

  test("attaches the browser-session cookie to every request when credentials exist", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.endsWith("/api/session.list")) return new Response("not found", { status: 404 });
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return new Response(JSON.stringify({
        type: "server-response",
        rpcId: body.rpcId,
        result: { ok: true, value: { items: [] } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const client = new DeepSeekHarnessHttpClient(
      "http://127.0.0.1:43120",
      fetchImpl,
      5_000,
      "dsh-auth-abc=signature",
    );
    await client.listSessions();

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.headers.cookie).toBe("dsh-auth-abc=signature");
    }
  });
});

describe("DeepSeek Desktop endpoint discovery", () => {
  const DESKTOP_MAIN = "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop";
  const DESKTOP_HELPER =
    "/Applications/DSH Desktop.app/Contents/Frameworks/DSH Desktop Helper.app/Contents/MacOS/DSH Desktop Helper --type=utility";

  test("finds the web port when the Helper child owns the listener", () => {
    // DSH Desktop 2.0.9 serves its loopback API from a Helper child process,
    // so the parent PID owns no TCP socket at all.
    const baseUrl = discoverDeepSeekDesktopHarnessBaseUrl({
      platform: "darwin",
      readProcessList: () => `  17916 ${DESKTOP_MAIN}\n  18738 ${DESKTOP_HELPER}\n`,
      readListeners: (pid) => pid === 17916
        ? ""
        : "p18738\nn127.0.0.1:60586\nn127.0.0.1:43120\nn127.0.0.1:59810\n",
      readPortListeners: () => "",
    });
    // The documented web port wins over the helper's other sockets.
    expect(baseUrl).toBe("http://127.0.0.1:43120");
  });

  test("still discovers a legacy Desktop that owns its own listener", () => {
    const baseUrl = discoverDeepSeekDesktopHarnessBaseUrl({
      platform: "darwin",
      readProcessList: () => `  4242 ${DESKTOP_MAIN}\n`,
      readListeners: () => "p4242\nn127.0.0.1:43120\n",
      readPortListeners: () => "",
    });
    expect(baseUrl).toBe("http://127.0.0.1:43120");
  });

  test("falls back to a loopback listener scan when PID lookup misses", () => {
    const baseUrl = discoverDeepSeekDesktopHarnessBaseUrl({
      platform: "darwin",
      readProcessList: () => `  4242 ${DESKTOP_MAIN}\n`,
      readListeners: () => "",
      readPortListeners: () =>
        "DSH\\x20De 18738 xiaolonglin 30u IPv4 0x1 0t0 TCP 127.0.0.1:43120 (LISTEN)\n",
    });
    expect(baseUrl).toBe("http://127.0.0.1:43120");
  });

  test("returns null when no Desktop process is running", () => {
    expect(discoverDeepSeekDesktopHarnessBaseUrl({
      platform: "darwin",
      readProcessList: () => "  1 /sbin/launchd\n",
      readListeners: () => "",
      readPortListeners: () => "",
    })).toBeNull();
  });
});

describe("DeepSeek Harness dialect self-healing", () => {
  test("does not cache an inconclusive probe as the legacy dialect", async () => {
    // First probe fails at the transport layer (Desktop restarting); the host
    // is a Typert host once it comes back.
    let probeAttempts = 0;
    let hostUp = false;
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push(url);
      if (url.endsWith("/api/session/list")) {
        probeAttempts += 1;
        if (!hostUp) throw new TypeError("fetch failed");
        return new Response(JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId,
          result: { ok: true, value: { items: [] } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = new DeepSeekHarnessHttpClient("http://127.0.0.1:43120", fetchImpl, 5_000, null);

    // Host down: the call fails, but the failure must not be remembered.
    await expect(client.listSessions()).rejects.toThrow();
    const probesWhileDown = probeAttempts;
    expect(probesWhileDown).toBeGreaterThan(0);

    // Host returns as a Typert host; the very next call must re-probe and work
    // instead of replaying a cached legacy verdict.
    hostUp = true;
    expect(await client.listSessions()).toEqual([]);
    expect(probeAttempts).toBeGreaterThan(probesWhileDown);
    expect(calls.at(-1)).toContain("/api/session/list");
  });

  test("recovers from a stale dialect by retrying the other dialect on 404", async () => {
    // Reproduces the production symptom: the client believes the host is
    // Typert, but the host answers the slash endpoint with 404 (it is really a
    // legacy host, or the Desktop changed under a live client). The call must
    // re-detect and retry the other dialect instead of failing until restart.
    const calls: Array<{ url: string; body: unknown }> = [];
    let slashIs404 = true;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, body });
      if (url.endsWith("/api/session/list")) {
        if (slashIs404) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId,
          result: { ok: true, value: { items: [] } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/api/session.list")) {
        // Legacy data disappears once the host flips to the Typert dialect.
        if (!slashIs404) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId,
          result: { ok: true, value: { items: [{ sessionId: "s1", updatedAt: 1, running: false, blank: false }] } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = new DeepSeekHarnessHttpClient("http://127.0.0.1:43120", fetchImpl, 5_000, null);
    // A 404 probe is a definitive "legacy" answer, so the first call succeeds
    // through the dotted endpoint.
    expect((await client.listSessions()).map((s) => s.sessionId)).toEqual(["s1"]);
    expect(calls.some((c) => c.url.endsWith("/api/session.list"))).toBe(true);

    // The host is upgraded to Typert underneath the live client. The cached
    // legacy verdict now 404s, which must trigger a re-probe and a successful
    // retry against the slash endpoint rather than failing until a restart.
    slashIs404 = false;
    calls.length = 0;
    expect(await client.listSessions()).toEqual([]);
    expect(calls.some((c) => c.url.endsWith("/api/session/list"))).toBe(true);
  });

  test("keeps a definitive legacy classification cached across calls", async () => {
    let probes = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.endsWith("/api/session/list")) {
        probes += 1;
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({
        type: "server-response",
        rpcId: body.rpcId,
        result: { ok: true, value: { items: [] } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const client = new DeepSeekHarnessHttpClient("http://127.0.0.1:3080", fetchImpl, 5_000, null);
    await client.listSessions();
    await client.listSessions();
    await client.listSessions();
    // A definitive answer is cached: only the first call probes.
    expect(probes).toBe(1);
  });
});

describe("DeepSeek Harness browser-session cookie refresh", () => {
  test("re-mints the cookie and retries once after a 401", async () => {
    // A Desktop restart invalidates the cached cookie. The client must not
    // stay broken until the whole daemon restarts.
    const seenCookies: string[] = [];
    let attempts = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seenCookies.push(headers.cookie ?? "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      // This host speaks the legacy dialect only; a 404 here makes the probe
      // classify it as legacy rather than Typert.
      if (url.endsWith("/api/session/list")) {
        return new Response("not found", { status: 404 });
      }
      if (url.endsWith("/api/session.list")) {
        attempts += 1;
        // The stale cookie is rejected until the client presents the new one.
        if (headers.cookie === "stale-cookie") {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId,
          result: { ok: true, value: { items: [{ sessionId: "s1", updatedAt: 1, running: false, blank: false }] } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = new DeepSeekHarnessHttpClient(
      "http://127.0.0.1:3080",
      fetchImpl,
      5_000,
      "stale-cookie",
      () => "fresh-cookie",
    );
    const sessions = await client.listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(["s1"]);
    // It tried with the stale cookie, then retried with a freshly minted one.
    expect(attempts).toBe(2);
    expect(seenCookies).toContain("stale-cookie");
    expect(seenCookies.some((c) => c && c !== "stale-cookie")).toBe(true);
  });

  test("does not retry forever when the credential store cannot supply a new cookie", async () => {
    let attempts = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.endsWith("/api/session/list")) {
        return new Response("not found", { status: 404 });
      }
      if (url.endsWith("/api/session.list")) {
        attempts += 1;
        return new Response("unauthorized", { status: 401 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const client = new DeepSeekHarnessHttpClient(
      "http://127.0.0.1:3080",
      fetchImpl,
      5_000,
      "stale-cookie",
      // The credential store cannot produce a different cookie.
      () => "stale-cookie",
    );
    await expect(client.listSessions()).rejects.toThrow("HTTP 401");
    // One original attempt plus at most one refresh retry.
    expect(attempts).toBeLessThanOrEqual(2);
  });
});

describe("DeepSeek Harness endpoint re-resolution", () => {
  test("re-resolves a dead default endpoint before connecting", async () => {
    // Reproduces the production failure: construction happens while DSH
    // Desktop is restarting, so discovery fails and the resolver falls back to
    // the documented default port. That port is not what the Desktop serves,
    // so start() must re-resolve instead of pinning the dead address.
    const queue = new AsyncEnvelopeQueue();
    const { client } = createFakeClient(queue);
    let resolutions = 0;
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
      sessionStartMode: "restore",
    }, {
      createClient: () => client,
      resolveBaseUrl: () => {
        resolutions += 1;
        // Construction sees the dead fallback; the next resolution finds the
        // port the Desktop actually serves.
        return resolutions === 1
          ? "http://127.0.0.1:3080"
          : "http://127.0.0.1:43120";
      },
      recoverDesktopAccess: async () => false,
    });

    expect(resolutions).toBe(1);
    await adapter.start();
    // start() must have re-resolved rather than reusing the dead endpoint.
    expect(resolutions).toBe(2);
    expect(adapter.getState().status).not.toBe("error");
    await adapter.dispose();
  });

  test("does not rebind the client when the endpoint is unchanged", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client } = createFakeClient(queue);
    let created = 0;
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
      sessionStartMode: "restore",
    }, {
      createClient: () => { created += 1; return client; },
      resolveBaseUrl: () => "http://127.0.0.1:43120",
      recoverDesktopAccess: async () => false,
    });
    await adapter.start();
    // Same endpoint: the original client stays bound, no needless rebind.
    expect(created).toBe(1);
    await adapter.dispose();
  });
});

describe("DeepSeek Harness transient failure handling", () => {
  test("retries a transient failure without restarting the Desktop", async () => {
    // A user-initiated switch allows desktop recovery, but a transient
    // transport failure must be retried in place: restarting the user's
    // Desktop turns a brief blip into a long outage.
    const queue = new AsyncEnvelopeQueue();
    const { client } = createFakeClient(queue);
    let attempts = 0;
    let recoveryCalls = 0;
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
      sessionStartMode: "restore",
      allowDesktopApplicationLaunch: true,
    }, {
      createClient: () => client,
      resolveBaseUrl: () => "http://127.0.0.1:43120",
      recoverDesktopAccess: async () => {
        recoveryCalls += 1;
        // The protected-host case does not apply to a transient failure.
        return false;
      },
      sleep: async () => undefined,
      now: (() => {
        let now = 0;
        return () => now += 3_000;
      })(),
    });
    // First connect fails transiently; later attempts succeed.
    const originalList = client.listSessions.bind(client);
    client.listSessions = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return await originalList();
    };

    await adapter.start();
    expect(attempts).toBeGreaterThan(1);
    // The Desktop was never asked to restart for a transient failure.
    expect(recoveryCalls).toBeLessThanOrEqual(1);
    expect(adapter.getState().status).not.toBe("error");
    await adapter.dispose();
  });

  test("does not treat transient transport errors as desktop-recoverable", async () => {
    const source = await Bun.file(
      new URL("../../src/bridge/deepseek-desktop-lifecycle.ts", import.meta.url),
    ).text();
    const start = source.indexOf("function isRecoverableDeepSeekDesktopError(");
    const end = source.indexOf("\n}", start);
    const block = source.slice(start, end);
    // Only the protected-host (403) case may trigger a Desktop restart.
    expect(block).toContain("403");
    expect(block).not.toContain("fetch failed");
    expect(block).not.toContain("ECONNREFUSED");
    expect(block).not.toContain("ETIMEDOUT");
    expect(block).not.toContain("timeout");
  });
});

describe("DeepSeek Harness dead-default endpoint avoidance", () => {
  test("re-discovers instead of binding the documented default port", async () => {
    // Production failure: the resolver reported the documented default port
    // because discovery was empty at that instant, so the client bound a port
    // the Desktop does not serve and failed with ECONNREFUSED forever.
    const queue = new AsyncEnvelopeQueue();
    const { client } = createFakeClient(queue);
    let discoveryCalls = 0;
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
      sessionStartMode: "restore",
    }, {
      createClient: () => client,
      // Always reports the dead default, exactly like the daemon did.
      resolveBaseUrl: () => "http://127.0.0.1:3080",
      // Discovery finds the port the Desktop actually serves.
      resolveRecoveredBaseUrl: () => {
        discoveryCalls += 1;
        return "http://127.0.0.1:43120";
      },
      recoverDesktopAccess: async () => false,
      sleep: async () => undefined,
    });

    await adapter.start();
    // The dead default was rejected in favour of a discovered endpoint.
    expect(discoveryCalls).toBeGreaterThan(0);
    expect(adapter.getState().status).not.toBe("error");
    await adapter.dispose();
  });

  test("keeps an explicitly configured endpoint without re-discovering", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client } = createFakeClient(queue);
    let discoveryCalls = 0;
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
      sessionStartMode: "restore",
    }, {
      createClient: () => client,
      // An operator-supplied endpoint must be honoured as-is.
      resolveBaseUrl: () => "http://127.0.0.1:59999",
      resolveRecoveredBaseUrl: () => {
        discoveryCalls += 1;
        return "http://127.0.0.1:43120";
      },
      recoverDesktopAccess: async () => false,
      sleep: async () => undefined,
    });

    await adapter.start();
    expect(discoveryCalls).toBe(0);
    await adapter.dispose();
  });
});

describe("DSH Desktop vs dsh web endpoint defaults", () => {
  test("prefers the Desktop port when the app is installed but not yet listening", () => {
    // DSH Desktop serves 43120; the documented 3080 default belongs to the
    // `dsh web` CLI. Binding 3080 for a Desktop user is always wrong.
    const resolved = resolveDeepSeekHarnessBaseUrl(undefined, {
      platform: "darwin",
      readProcessList: () => "",
      readListeners: () => "",
      readPortListeners: () => "",
      appInstalled: () => true,
    });
    expect(resolved).toBe("http://127.0.0.1:43120");
  });

  test("keeps the CLI default when no Desktop app is installed", () => {
    const resolved = resolveDeepSeekHarnessBaseUrl(undefined, {
      platform: "darwin",
      readProcessList: () => "",
      readListeners: () => "",
      readPortListeners: () => "",
      appInstalled: () => false,
    });
    expect(resolved).toBe("http://127.0.0.1:3080");
  });

  test("still prefers a discovered endpoint over any default", () => {
    const resolved = resolveDeepSeekHarnessBaseUrl(undefined, {
      platform: "darwin",
      readProcessList: () =>
        "  4242 /Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop\n",
      readListeners: () => "n127.0.0.1:43120\n",
      readPortListeners: () => "",
      appInstalled: () => true,
    });
    expect(resolved).toBe("http://127.0.0.1:43120");
  });

  test("never second-guesses an explicit endpoint", () => {
    const resolved = resolveDeepSeekHarnessBaseUrl("http://127.0.0.1:59999", {
      platform: "darwin",
      readProcessList: () => "",
      readListeners: () => "",
      readPortListeners: () => "",
      appInstalled: () => true,
    });
    expect(resolved).toBe("http://127.0.0.1:59999");
  });
});

describe("DeepSeek Harness model state without a current selection", () => {
  test("returns a catalog instead of throwing when the host omits current", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client } = createFakeClient(queue);
    // 某些会话（尚未选择模型、Host 刚重启）不会带回 current。
    client.readModels = async () => ({
      routable: true,
      groups: [{
        id: "deepseek-official",
        name: "DeepSeek",
        models: [{ id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" }],
      }],
      failures: [],
    } as never);
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });

    const state = await adapter.getSessionModelState("session-1");

    expect(state.currentModel).toBeUndefined();
    expect(state.canChange).toBe(true);
    expect(state.options).toEqual([{
      id: "deepseek-official::deepseek-v4-flash",
      label: "DeepSeek-V4-Flash",
      group: "DeepSeek",
    }]);
  });

  test("reports a clear error instead of crashing when switching effort without current", async () => {
    const queue = new AsyncEnvelopeQueue();
    const { client } = createFakeClient(queue);
    client.readModels = async () => ({
      routable: true,
      groups: [],
      failures: [],
    } as never);
    const adapter = new DeepSeekHarnessAdapter({
      kind: "deepseek",
      command: "dsh",
      cwd: "/tmp/project",
    }, { createClient: () => client });

    // 没有 current 时推理强度选项为空，先给出可读的“不可用”提示；
    // 关键是不再抛 TypeError（Cannot read properties of undefined）。
    await expect(adapter.setSessionReasoningEffort("session-1", "high"))
      .rejects.toThrow("这个推理强度当前不可用");
  });
});

test("DSH retry delay resets after a stable event stream instead of accumulating for the daemon lifetime", async () => {
  const queue = new AsyncEnvelopeQueue();
  const { client: base } = createFakeClient(queue);
  let attempts = 0;
  let stableEndedAt = 0;
  let retryAt = 0;
  const client: DeepSeekHarnessClientLike = {
    ...base,
    async *openMux() {
      attempts += 1;
      if (attempts < 3) throw new Error("temporary test outage");
      if (attempts === 3) {
        yield { rpcId: "ready", payload: { type: "stream/ready" } } as DeepSeekHarnessEnvelope;
        await new Promise(resolve => setTimeout(resolve, 5100));
        stableEndedAt = performance.now();
        throw new Error("new outage after stable connection");
      }
      retryAt = performance.now();
      yield* queue;
    },
  };
  const adapter = new DeepSeekHarnessAdapter({ kind: "deepseek", command: "dsh", cwd: "/tmp/project" }, {
    createClient: () => client,
  });
  try {
    await adapter.start();
    const deadline = performance.now() + 15000;
    while (!retryAt && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect(attempts).toBe(4);
    expect(retryAt - stableEndedAt).toBeGreaterThanOrEqual(900);
    expect(retryAt - stableEndedAt).toBeLessThan(2000);
  } finally {
    queue.close();
    await adapter.dispose();
  }
}, 18000);

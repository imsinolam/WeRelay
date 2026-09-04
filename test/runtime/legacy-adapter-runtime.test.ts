import { describe, expect, test } from "bun:test";

import type { BridgeAdapter } from "../../src/bridge/bridge-types.ts";
import { LegacyAdapterRuntime } from "../../src/runtime/legacy-adapter-runtime.ts";

function buildAdapter(overrides: Partial<BridgeAdapter> = {}): BridgeAdapter {
  return {
    setEventSink() {},
    async start() {},
    async sendInput() {},
    async listResumeSessions() { return []; },
    async resumeSession() {},
    async interrupt() { return false; },
    async reset() {},
    async resolveApproval() { return false; },
    async resolveAllApprovals() { return 0; },
    async submitUserInput() { return false; },
    async dispose() {},
    getState() {
      return {
        kind: "grok",
        command: "grok",
        status: "idle",
        startedAt: new Date(0).toISOString(),
      };
    },
    ...overrides,
  };
}

describe("LegacyAdapterRuntime optional capabilities", () => {
  test("preserves missing optional adapter methods", () => {
    const runtime = new LegacyAdapterRuntime(buildAdapter());

    expect(runtime.getSessionMessages).toBeUndefined();
    expect(runtime.getSessionMessageMedia).toBeUndefined();
    expect(runtime.sendInputToSession).toBeUndefined();
    expect(runtime.getQueuedTaskInputs).toBeUndefined();
    expect(runtime.createSessionInProject).toBeUndefined();
    expect(runtime.getSessionModelState).toBeUndefined();
    expect(runtime.setSessionModel).toBeUndefined();
    expect(runtime.setSessionReasoningEffort).toBeUndefined();
    expect(runtime.getSessionPermissionState).toBeUndefined();
    expect(runtime.setSessionPermission).toBeUndefined();
    expect(runtime.resolveApprovalRequest).toBeUndefined();
  });

  test("forwards optional session and queue methods to the wrapped adapter", async () => {
    const adapter = buildAdapter({
      async getSessionMessages(sessionId) {
        return [{ role: "assistant", text: `reply:${sessionId}` }];
      },
      async getSessionMessageMedia(sessionId, options, targetMessages) {
        expect(options).toEqual({ limit: 12, historyOnly: true });
        expect(targetMessages).toEqual([{ role: "user", text: "prompt" }]);
        return [{
          role: "assistant",
          text: `reply:${sessionId}`,
          images: [{ source: "local", path: "/tmp/generated.jpg" }],
        }];
      },
      async sendInputToSession(sessionId, text) {
        return { sessionId, turnId: text };
      },
      getQueuedTaskInputs(sessionId) {
        return [{ id: "queued-1", text: sessionId, imageCount: 0 }];
      },
      async getSessionModelState(sessionId) {
        expect(this).toBe(adapter);
        return {
          currentModel: sessionId === "session-1" ? "gpt-5.6-sol" : undefined,
          options: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
          canChange: true,
        };
      },
      async setSessionModel(sessionId, model) {
        expect(this).toBe(adapter);
        expect(sessionId).toBe("session-1");
        expect(model).toBe("gpt-5.6-terra");
        return {
          currentModel: model,
          options: [{ id: model }],
          canChange: true,
        };
      },
      async setSessionReasoningEffort(sessionId, reasoningEffort) {
        expect(this).toBe(adapter);
        expect(sessionId).toBe("session-1");
        expect(reasoningEffort).toBe("high");
        return {
          currentModel: "gpt-5.6-terra",
          currentReasoningEffort: reasoningEffort,
          reasoningEffortOptions: [{ id: reasoningEffort }],
          options: [{ id: "gpt-5.6-terra" }],
          canChange: true,
        };
      },
      async getSessionPermissionState(sessionId) {
        expect(this).toBe(adapter);
        expect(sessionId).toBe("session-1");
        return {
          currentPermission: "workspace-write",
          options: [{ id: "workspace-write" }, { id: "danger-full-access" }],
          canChange: true,
        };
      },
      async setSessionPermission(sessionId, permission) {
        expect(this).toBe(adapter);
        expect(sessionId).toBe("session-1");
        expect(permission).toBe("danger-full-access");
        return {
          currentPermission: permission,
          options: [{ id: permission }],
          canChange: true,
        };
      },
      async createSessionInProject(sourceSessionId) {
        expect(this).toBe(adapter);
        expect(this.getState().kind).toBe("grok");
        expect(sourceSessionId).toBe("source-session");
      },
      async resolveApprovalRequest(requestId, action) {
        expect(this).toBe(adapter);
        expect(requestId).toBe("approval-1");
        expect(action).toBe("deny");
        return true;
      },
    });
    const runtime = new LegacyAdapterRuntime(adapter);

    expect(await runtime.getSessionMessages?.("session-1")).toEqual([
      { role: "assistant", text: "reply:session-1" },
    ]);
    expect(await runtime.getSessionMessageMedia?.(
      "session-1",
      { limit: 12, historyOnly: true },
      [{ role: "user", text: "prompt" }],
    )).toEqual([{
      role: "assistant",
      text: "reply:session-1",
      images: [{ source: "local", path: "/tmp/generated.jpg" }],
    }]);
    expect(await runtime.sendInputToSession?.("session-1", "turn-1")).toEqual({
      sessionId: "session-1",
      turnId: "turn-1",
    });
    expect(runtime.getQueuedTaskInputs?.("session-1")).toEqual([
      { id: "queued-1", text: "session-1", imageCount: 0 },
    ]);
    expect(await runtime.getSessionModelState?.("session-1")).toEqual({
      currentModel: "gpt-5.6-sol",
      options: [{ id: "gpt-5.6-sol", label: "GPT-5.6 Sol" }],
      canChange: true,
    });
    expect(await runtime.setSessionModel?.("session-1", "gpt-5.6-terra")).toEqual({
      currentModel: "gpt-5.6-terra",
      options: [{ id: "gpt-5.6-terra" }],
      canChange: true,
    });
    expect(await runtime.setSessionReasoningEffort?.("session-1", "high")).toEqual({
      currentModel: "gpt-5.6-terra",
      currentReasoningEffort: "high",
      reasoningEffortOptions: [{ id: "high" }],
      options: [{ id: "gpt-5.6-terra" }],
      canChange: true,
    });
    expect(await runtime.getSessionPermissionState?.("session-1")).toMatchObject({
      currentPermission: "workspace-write",
    });
    expect(await runtime.setSessionPermission?.(
      "session-1",
      "danger-full-access",
    )).toMatchObject({
      currentPermission: "danger-full-access",
    });
    expect(runtime.createSessionInProject).toBeFunction();
    await runtime.createSessionInProject?.("source-session");
    await expect(runtime.resolveApprovalRequest?.("approval-1", "deny")).resolves.toBe(true);
  });
});

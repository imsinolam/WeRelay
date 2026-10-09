import { expect, test } from "bun:test";
import { WorkBuddyDesktopAdapter } from "../../src/bridge/bridge-adapters.workbuddy.ts";
import type { BridgeEvent } from "../../src/bridge/bridge-types.ts";

test("notification-only WorkBuddy observes and resolves approvals across sessions without load or launch", async () => {
  const calls: string[] = [];
  const events: BridgeEvent[] = [];
  let emit!: (channel: string, data: unknown) => void;
  const adapter = new WorkBuddyDesktopAdapter({ kind: "workbuddy", command: "workbuddy", cwd: "/repo",
    desktopNotificationsOnly: true, initialSharedSessionId: "selected" }, {
    createDesktopClient: (options) => {
      expect(options.allowDesktopApplicationLaunch).toBe(false);
      emit = options.onEvent;
      return { connect: async () => {}, close: async () => {}, invoke: async (channel) => {
        calls.push(channel); return channel === "session:list" ? [] : {};
      } };
    }, listSessions: async () => ["A", "B"].map((id) => ({ id, cwd: "/repo", status: "working", createdAt: 1, updatedAt: 2 })), readSession: async () => null,
    readMessages: async () => [], readRunSummary: async () => null,
    readLocalImage: async () => ({ data: "", mimeType: "image/png" }),
  });
  adapter.setEventSink((event) => events.push(event));
  await adapter.start();
  const request = (sessionId: string) => emit("session:event", { type: "permissionRequest", sessionId,
    requestId: "same-request", request: { toolCall: { toolCallId: "tool", title: "检查文件" },
      options: [{ optionId: "yes", kind: "allow_once" }] } });
  request("A"); request("B"); request("A");
  expect(events.filter((e) => e.type === "approval_required")).toHaveLength(2);
  expect(adapter.getState().sharedSessionId).toBeUndefined();
  expect(adapter.getPendingTaskApprovals("A")).toHaveLength(1);
  expect(adapter.getPendingTaskApprovals("B")).toHaveLength(1);
  expect(adapter.getState().status).toBe("idle");
  expect((await adapter.listResumeSessions()).map((row) => row.runtimeStatus?.activeFlags)).toEqual([["waitingOnApproval"], ["waitingOnApproval"]]);
  expect(await adapter.resolveTaskApprovals("A", "confirm")).toBe(1);
  expect(adapter.getPendingTaskApprovals("A")).toHaveLength(0);
  expect(adapter.getPendingTaskApprovals("B")).toHaveLength(1);
  emit("session:event", { type: "permissionResolved", sessionId: "B", requestId: "same-request" });
  expect(adapter.getPendingTaskApprovals("B")).toHaveLength(0);
  expect(calls).not.toContain("session:load");
  expect(calls).not.toContain("session:create");
  await adapter.dispose();
});

test("read-only snapshots recover missed approvals and resolved requests without replaying history", async () => {
  let view: unknown = { pendingPermissions: [{ requestId: "native", request: {
    toolCall: { toolCallId: "t", title: "检查" }, options: [{ optionId: "yes", kind: "allow_once" }],
  } }] };
  const events: BridgeEvent[] = [];
  const adapter = new WorkBuddyDesktopAdapter({ kind: "workbuddy", command: "workbuddy", cwd: "/repo", desktopNotificationsOnly: true }, {
    createDesktopClient: () => ({ connect: async () => {}, close: async () => {}, invoke: async (channel) => {
      if (channel === "session:list") return [{ sessionId: "native-session", status: "working" }];
      if (channel === "session:get") return view;
      throw new Error("mutating channel called");
    } }), listSessions: async () => [], readSession: async () => null, readMessages: async () => [],
    readRunSummary: async () => null, readLocalImage: async () => ({ data: "", mimeType: "image/png" }),
  });
  adapter.setEventSink((event) => events.push(event));
  await adapter.start();
  expect(adapter.getPendingTaskApprovals("native-session")).toHaveLength(1);
  await adapter.refreshDesktopApprovals();
  expect(events.filter((event) => event.type === "approval_required")).toHaveLength(1);
  view = { unsupportedSchema: true };
  await adapter.refreshDesktopApprovals();
  expect(adapter.getPendingTaskApprovals("native-session")).toHaveLength(1);
  view = { pendingPermissions: [] };
  await adapter.refreshDesktopApprovals();
  expect(adapter.getPendingTaskApprovals("native-session")).toHaveLength(0);
  await adapter.dispose();
});

// Integration regression: native-model metadata and global approvals share
// the same event listener, but must retain their different session scopes.
test("selected WorkBuddy model metadata does not hide other-session approvals", async () => {
  let emit!: (channel: string, data: unknown) => void;
  const adapter = new WorkBuddyDesktopAdapter({ kind: "workbuddy", command: "fixture", cwd: "/repo" }, {
    createDesktopClient: (options) => {
      emit = options.onEvent;
      return { connect: async () => {}, close: async () => {}, invoke: async () => ({}) };
    },
    listSessions: async () => [], readSession: async () => null, readMessages: async () => [],
    readRunSummary: async () => null, readLocalImage: async () => ({ data: "", mimeType: "image/png" }),
  });
  await adapter.start();
  (adapter as any).state.sharedSessionId = "selected";
  emit("session:event", { type: "permissionRequest", sessionId: "other", requestId: "foreign-approval",
    request: { toolCall: { toolCallId: "tool", title: "检查文件" }, options: [{ optionId: "yes", kind: "allow_once" }] } });
  expect(adapter.getState().sharedSessionId).toBe("selected");
  expect(adapter.getPendingTaskApprovals("other")).toHaveLength(1);
  expect(adapter.getPendingTaskApprovals("selected")).toHaveLength(0);
  await adapter.dispose();
});

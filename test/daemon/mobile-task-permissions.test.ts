import { expect, test } from "bun:test";
import type { BridgeSessionPermissionState } from "../../src/bridge/bridge-types.ts";
import { ensureMobileTaskWritablePermission, mobileTaskPermissionState, assertMobileTaskPermission } from "../../src/daemon/mobile-task-permissions.ts";

const readOnly = (): BridgeSessionPermissionState => ({ currentPermission: "read-only", canChange: true, options: [
  { id: "read-only", label: "只读" }, { id: "workspace-write", label: "项目内读写" },
  { id: "danger-full-access", label: "完全访问", requiresConfirmation: true },
] });

test("mobile options reject read-only without weakening full-access confirmation", () => {
  const source = readOnly();
  expect(mobileTaskPermissionState(source).options.map(option => option.id)).toEqual(["workspace-write", "danger-full-access"]);
  expect(source.options).toHaveLength(3);
  expect(mobileTaskPermissionState(source).options[1]?.requiresConfirmation).toBe(true);
  expect(() => assertMobileTaskPermission(" read-only ")).toThrow("项目内读写");
  expect(() => assertMobileTaskPermission("workspace-write")).not.toThrow();
});

test("migrates each requested task to project write, never full access", async () => {
  const calls: string[] = [];
  const runtime = {
    getSessionPermissionState: async () => readOnly(),
    setSessionPermission: async (thread: string, permission: string) => { calls.push(thread + ":" + permission); return { ...readOnly(), currentPermission: permission }; },
  };
  for (const thread of ["existing", "new-task"]) {
    expect((await ensureMobileTaskWritablePermission(runtime, thread)).currentPermission).toBe("workspace-write");
  }
  expect(calls).toEqual(["existing:workspace-write", "new-task:workspace-write"]);
});

test("does not overwrite an existing writable or custom permission", async () => {
  for (const currentPermission of ["workspace-write", "danger-full-access", "default", "custom"]) {
    let changed = false;
    const result = await ensureMobileTaskWritablePermission({
      getSessionPermissionState: async () => ({ ...readOnly(), currentPermission }),
      setSessionPermission: async () => { changed = true; return readOnly(); },
    }, "task");
    expect(result.currentPermission).toBe(currentPermission);
    expect(changed).toBe(false);
  }
});

test("fails closed for a protected read-only task or an unconfirmed change", async () => {
  for (const state of [{ ...readOnly(), canChange: false }, { ...readOnly(), options: [{ id: "danger-full-access", label: "完全访问" }] }]) {
    let changed = false;
    await expect(ensureMobileTaskWritablePermission({ getSessionPermissionState: async () => state,
      setSessionPermission: async () => { changed = true; return readOnly(); },
    }, "task")).rejects.toThrow("项目内读写");
    expect(changed).toBe(false);
  }
  await expect(ensureMobileTaskWritablePermission({ getSessionPermissionState: async () => readOnly(),
    setSessionPermission: async () => readOnly(),
  }, "task")).rejects.toThrow("未确认");
});

test("coalesces concurrent permission reads and sends for the same owner/task", async () => {
  let writes = 0;
  const runtime = { getSessionPermissionState: async () => readOnly(), setSessionPermission: async () => {
    writes++; return { ...readOnly(), currentPermission: "workspace-write" };
  } };
  await Promise.all([ensureMobileTaskWritablePermission(runtime, "task"), ensureMobileTaskWritablePermission(runtime, "task")]);
  expect(writes).toBe(1);
  await ensureMobileTaskWritablePermission(runtime, "another");
  expect(writes).toBe(2);
});

test("leaves adapters without permission controls unchanged", async () => {
  expect((await ensureMobileTaskWritablePermission({}, "task")).canChange).toBe(false);
});

test("failed permission migration is retriable and never cached as success", async () => {
  let attempt = 0;
  const runtime = { getSessionPermissionState: async () => readOnly(), setSessionPermission: async () => {
    if (++attempt === 1) throw new Error("暂时断开连接");
    return { ...readOnly(), currentPermission: "workspace-write" };
  } };
  await expect(ensureMobileTaskWritablePermission(runtime, "task")).rejects.toThrow("断开连接");
  expect((await ensureMobileTaskWritablePermission(runtime, "task")).currentPermission).toBe("workspace-write");
});

test("the actual mobile dispatch checks task permissions before submitting a new or existing message", async () => {
  const { WeRelayDaemon } = await import("../../src/daemon/werelay-daemon.ts");
  for (const protectedTask of [false, true]) {
    const calls: string[] = [];
    const runtime = {
      sendInputToSession: async () => {},
      getSessionPermissionState: async () => ({ ...readOnly(), canChange: !protectedTask }),
      setSessionPermission: async (_id: string, permission: string) => {
        calls.push(permission); return { ...readOnly(), currentPermission: permission };
      },
    };
    const receiver = {
      getMobileSlot: () => ({ adapter: "codex", runtime }),
      getSlotThreadId: () => "task",
      mobileCreatedTaskKeys: new Set(["codex\0task"]),
      dispatchMobileInput: async () => { calls.push("send"); return {}; },
    };
    const dispatch = (WeRelayDaemon.prototype as any).dispatchPersistedMobileMessage.call(receiver, {
      adapter: "codex", threadId: "task", text: "修改项目", images: [],
    });
    if (protectedTask) {
      await expect(dispatch).rejects.toThrow("项目内读写");
      expect(calls).toEqual([]);
    } else {
      await dispatch;
      expect(calls).toEqual(["workspace-write", "send"]);
    }
  }
});

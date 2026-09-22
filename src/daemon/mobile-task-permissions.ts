import type { BridgeAdapter, BridgeSessionPermissionState } from "../bridge/bridge-types.ts";

type PermissionRuntime = Pick<BridgeAdapter, "getSessionPermissionState" | "setSessionPermission">;
const pending = new WeakMap<PermissionRuntime, Map<string, Promise<BridgeSessionPermissionState>>>();

export function assertMobileTaskPermission(permission: string): void {
  if (permission.trim() === "read-only") {
    throw new Error("任务台不提供只读权限，请选择项目内读写。");
  }
}

export function mobileTaskPermissionState(state: BridgeSessionPermissionState): BridgeSessionPermissionState {
  const options = state.options.filter(option => option.id !== "read-only");
  return { ...state, options, canChange: state.canChange && options.length > 0 };
}

/** Scope the writable default to the requested task; never enable unrestricted access. */
export function ensureMobileTaskWritablePermission(
  runtime: PermissionRuntime,
  threadId: string,
): Promise<BridgeSessionPermissionState> {
  let tasks = pending.get(runtime);
  if (!tasks) {
    tasks = new Map();
    pending.set(runtime, tasks);
  }
  const existing = tasks.get(threadId);
  if (existing) return existing;
  const result = (async () => {
    if (!runtime.getSessionPermissionState) {
      return { options: [], canChange: false, unavailableReason: "当前终端未提供任务权限设置。" };
    }
    const state = await runtime.getSessionPermissionState(threadId);
    if (state.currentPermission !== "read-only") return mobileTaskPermissionState(state);
    const writable = state.options.find(option => option.id === "workspace-write");
    if (!state.canChange || !writable || writable.requiresConfirmation || !runtime.setSessionPermission) {
      throw new Error("当前任务受到只读限制，无法启用项目内读写。请在电脑端确认任务权限；消息会保留，不会改用完全访问。");
    }
    const updated = await runtime.setSessionPermission(threadId, "workspace-write");
    if (updated.currentPermission !== "workspace-write") {
      throw new Error("尚未确认任务已启用项目内读写，消息会保留，请稍后重试。");
    }
    return mobileTaskPermissionState(updated);
  })();
  const tracked = result.finally(() => tasks!.delete(threadId));
  tasks.set(threadId, tracked);
  return tracked;
}

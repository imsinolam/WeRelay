import type { BridgeAdapterState, PendingUserInputRequest, UserInputRequest } from "./bridge-types.ts";

/** Selected-session state cannot invalidate a question owned by a background task. */
export function reconcilePendingUserInputs(
  tracked: PendingUserInputRequest[],
  state: BridgeAdapterState,
  getPendingForTask?: (threadId: string) => UserInputRequest | null,
): PendingUserInputRequest[] {
  const selected = state.sharedSessionId ?? state.sharedThreadId;
  return tracked.filter((pending) => {
    if (getPendingForTask && pending.threadId) return Boolean(getPendingForTask(pending.threadId));
    if (pending.threadId && pending.threadId !== selected) return true;
    return Boolean(state.pendingUserInput);
  });
}

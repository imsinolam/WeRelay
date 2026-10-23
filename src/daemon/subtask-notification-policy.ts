import type { BridgeResumeSessionCandidate } from "../bridge/bridge-types.ts";
import { isInternalTask } from "../bridge/task-origin.ts";

/** Only completion pushes are muted; approvals retain their normal delivery rules. */
export function shouldPushTaskNotification(
  kind: "completion" | "approval",
  task?: Pick<BridgeResumeSessionCandidate, "parentThreadId" | "source"> | null,
): boolean {
  return kind === "approval" || !isInternalTask(task);
}

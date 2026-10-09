import { classifyMobileSendFailure, type MobileMessageOutbox, type MobileMessageOutboxEntry } from "./mobile-message-outbox.ts";
import type { BridgeSessionMessage } from "../bridge/bridge-types.ts";

export function shouldRetryMobileMessage(error: string, attempts: number, limit: number): boolean {
  const failure = classifyMobileSendFailure(error);
  return failure !== "permanent" && failure !== "unconfirmed" && attempts < limit;
}

// 覆盖桌面端 120 秒 hydration，并为回执同步留出余量；观察不消耗发送次数。
export const MOBILE_MESSAGE_RECEIPT_OBSERVATION_WINDOW_MS = 180_000;
export const MOBILE_MESSAGE_RECEIPT_OBSERVATION_INTERVAL_MS = 10_000;

export function isMobileMessageDeliveryUncertain(entry: MobileMessageOutboxEntry): boolean {
  return entry.deliveryUncertain === true || classifyMobileSendFailure(entry.lastError ?? "") === "unconfirmed";
}

export function mobileMessageReceiptObservationDeadlineMs(entry: MobileMessageOutboxEntry): number {
  // 旧持久化条目没有首次尝试时间时，使用其已有尝试时间，不因每次检查而延长。
  return (entry.firstAttemptAtMs ?? entry.lastAttemptAtMs ?? entry.createdAtMs) + MOBILE_MESSAGE_RECEIPT_OBSERVATION_WINDOW_MS;
}

/** An uncertain RPC response retries observation, never a possibly accepted turn. */
export async function prepareMobileMessageRetry(params: {
  outbox: MobileMessageOutbox;
  entry: MobileMessageOutboxEntry;
  readMessages: () => Promise<BridgeSessionMessage[]>;
  timeoutMs?: number;
}): Promise<"received" | "send" | "check"> {
  const {outbox, entry} = params;
  if (!entry.attempts && !entry.deliveryUncertain) return "send";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const messages = await Promise.race([
      Promise.resolve().then(params.readMessages),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("receipt check timed out")), params.timeoutMs ?? 2_000);
      }),
    ]);
    if (outbox.reconcileReceived(entry.adapter, entry.threadId, entry.clientId, messages)) return "received";
  } catch {
    // A missing page or a read timeout is not proof of rejection.
  } finally {
    if (timer) clearTimeout(timer);
  }
  return isMobileMessageDeliveryUncertain(entry) ? "check" : "send";
}

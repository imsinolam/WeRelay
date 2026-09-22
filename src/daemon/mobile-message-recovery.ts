import { classifyMobileSendFailure, type MobileMessageOutbox, type MobileMessageOutboxEntry } from "./mobile-message-outbox.ts";
import type { BridgeSessionMessage } from "../bridge/bridge-types.ts";

export function shouldRetryMobileMessage(error: string, attempts: number, limit: number): boolean {
  return classifyMobileSendFailure(error) !== "permanent" && attempts < limit;
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
  return entry.deliveryUncertain || classifyMobileSendFailure(entry.lastError ?? "") === "unconfirmed" ? "check" : "send";
}

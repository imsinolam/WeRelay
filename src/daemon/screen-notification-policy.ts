import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type ScreenLockState = "locked" | "unlocked" | "unknown";
export const UNLOCKED_NOTIFICATION_INTERVAL_MS = 10 * 60_000;
const execFileAsync = promisify(execFile);

export function parseMacScreenLockState(output: string): ScreenLockState {
  const values = [...output.matchAll(/"CGSSessionScreenIsLocked"\s*=\s*(Yes|No|true|false)/g)].map((match) => match[1]);
  // Ambiguous multi-user results must not suppress an approval.
  if (values.length !== 1) return "unknown";
  return values[0] === "Yes" || values[0] === "true" ? "locked" : "unlocked";
}

export async function readScreenLockState(): Promise<ScreenLockState> {
  if (process.platform !== "darwin") return "unknown";
  try {
    const { stdout } = await execFileAsync("/usr/sbin/ioreg", ["-l", "-n", "Root", "-d", "1"], {
      timeout: 1_500, maxBuffer: 1024 * 1024,
    });
    return parseMacScreenLockState(stdout);
  } catch { return "unknown"; }
}

/** Applies only to unsolicited task notifications, never inbound command replies. */
export class ScreenNotificationPolicy {
  private lastSentAtMs?: number;
  private readonly options: {
    read?: () => Promise<ScreenLockState>;
    now?: () => number;
    lastSentAtMs?: number;
    persist?: (atMs: number) => void;
  };
  constructor(options: ScreenNotificationPolicy["options"] = {}) {
    this.options = options;
    this.lastSentAtMs = options.lastSentAtMs;
  }

  async mode(): Promise<"immediate" | "digest" | "wait"> {
    const state = await (this.options.read ?? readScreenLockState)().catch(() => "unknown");
    if (state !== "unlocked") return "immediate";
    const now = this.options.now?.() ?? Date.now();
    return this.lastSentAtMs !== undefined && now - this.lastSentAtMs < UNLOCKED_NOTIFICATION_INTERVAL_MS
      ? "wait" : "digest";
  }

  sent(): void {
    this.lastSentAtMs = this.options.now?.() ?? Date.now();
    this.options.persist?.(this.lastSentAtMs);
  }
}

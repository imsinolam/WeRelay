import type { BridgeResumeSessionCandidate, BridgeSessionMessage, BridgeSessionRunSummary } from "../bridge/bridge-types.ts";
import { BoundedTtlSet } from "../utils/bounded-ttl-cache.ts";
import { CODEX_COMPLETION_DELIVERABLE_WINDOW_MS } from "./codex-completion-delivery.ts";
import { finalReplyDeliveryKey } from "./final-reply-delivery.ts";

export type DesktopCompletion = {
  adapter: "codex" | "workbuddy";
  candidate: BridgeResumeSessionCandidate;
  summary: BridgeSessionRunSummary;
  finalMessage: BridgeSessionMessage;
};

export class PassiveCompletionMonitor {
  private stopped = false;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly captured: BoundedTtlSet<string>;
  constructor(private readonly options: {
    now?: () => number;
    adapters?: DesktopCompletion["adapter"][];
    read: (adapter: DesktopCompletion["adapter"]) => Promise<DesktopCompletion[]>;
    capture: (item: DesktopCompletion, key: string) => Promise<void>;
    onError?: (adapter: DesktopCompletion["adapter"], error: unknown) => void;
    intervalMs?: number;
  }) {
    this.captured = new BoundedTtlSet<string>({
      maxSize: 512, ttlMs: CODEX_COMPLETION_DELIVERABLE_WINDOW_MS, now: options.now,
    });
  }

  start(): void {
    if (this.stopped || this.timer || this.running) return;
    void this.poll().finally(() => this.schedule());
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.start();
    }, this.options.intervalMs ?? 30_000);
    this.timer.unref?.();
  }

  async poll(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      await Promise.all((this.options.adapters ?? ["codex", "workbuddy"]).map(async (adapter) => {
        try {
          const completions = await this.options.read(adapter);
          for (const item of completions) {
            if (this.stopped) break;
            const { summary, finalMessage, candidate } = item;
            const now = this.options.now?.() ?? Date.now();
            if (item.adapter !== adapter || summary.status !== "completed" ||
                !Number.isFinite(summary.completedAtMs) || summary.completedAtMs! > now ||
                now - summary.completedAtMs! > CODEX_COMPLETION_DELIVERABLE_WINDOW_MS ||
                finalMessage.role !== "assistant" || finalMessage.phase !== "final_answer" ||
                !finalMessage.text.trim()) continue;
            if (adapter === "codex" && (!summary.turnId || finalMessage.turnId !== summary.turnId)) continue;
            if (adapter === "workbuddy" && !finalMessage.id) continue;
            const key = adapter === "codex" ? `${candidate.sessionId}:${summary.turnId}`
              : finalReplyDeliveryKey({ adapter, threadId: candidate.sessionId, messageId: finalMessage.id,
                timestamp: new Date(summary.completedAtMs!).toISOString(), rawText: finalMessage.text });
            if (this.captured.has(key)) continue;
            // Capture means persisted, not delivered. Existing delivery recovery
            // owns retries; failure to persist must be retried by the next scan.
            await this.options.capture(item, key);
            if (!this.stopped) this.captured.add(key);
          }
        } catch (error) { this.options.onError?.(adapter, error); }
      }));
    } finally { this.running = false; }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.captured.clear();
  }
}

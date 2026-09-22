/** Local execution delay, not proof of a network failure or system sleep. */
export class DaemonLivenessMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private previous = 0;
  private lastReported = -Infinity;
  private readonly now: () => number;

  constructor(private readonly report: (lagMs: number) => void, options: {
    now?: () => number;
  } = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  start(): void {
    if (this.timer) return;
    this.previous = this.now();
    this.timer = setInterval(() => this.sample(), 1000);
    this.timer.unref();
  }

  sample(): void {
    if (!this.timer) return;
    const now = this.now();
    const lag = Math.max(0, now - this.previous - 1000);
    this.previous = now;
    if (lag < 1000 || now - this.lastReported < 30_000) return;
    this.lastReported = now;
    try { this.report(Math.round(lag)); } catch { /* Diagnostics are best effort. */ }
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

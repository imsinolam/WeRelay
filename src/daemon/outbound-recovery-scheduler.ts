// Independent of inbound long polling. One recovery pass at a time, even when
// a fresh inbound context and a timer tick arrive together.
export class OutboundRecoveryScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private rerunRequested = false;
  private stopped = true;
  private closed = false;

  constructor(
    private readonly recover: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.closed = false;
    this.schedule();
  }

  trigger(options: { rerunIfRunning?: boolean } = {}): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) {
      // Only real inbound context refreshes need another pass. Ordinary capture
      // and policy callbacks can themselves run inside recovery: never loop on
      // those internal triggers.
      if (options.rerunIfRunning) this.rerunRequested = true;
      return this.running;
    }
    this.running = Promise.resolve().then(async () => {
      do {
        this.rerunRequested = false;
        if (this.closed) break;
        try { await this.recover(); } catch (error) { this.onError(error); }
      } while (!this.closed && this.rerunRequested);
    }).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  stop(): void {
    this.stopped = true;
    this.closed = true;
    this.rerunRequested = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.trigger().finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref();
  }
}

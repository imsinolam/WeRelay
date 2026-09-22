// Independent of inbound long polling. One recovery pass at a time, even when
// a fresh inbound context and a timer tick arrive together.
export class OutboundRecoveryScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
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

  trigger(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = Promise.resolve().then(() => this.closed ? undefined : this.recover()).catch(this.onError).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  stop(): void {
    this.stopped = true;
    this.closed = true;
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

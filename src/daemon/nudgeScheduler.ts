/** Keep delivery checks at the daemon's scan cadence and enforce both rate limits. */
export class NudgeScheduler {
  private readonly pending = new Set<string>();
  private readonly lastSent = new Map<string, number>();
  private readonly sentTimes: number[] = [];
  private running: Promise<void> | null = null;
  /** Counts delivery requests, so one made during a delivery outlives it. */
  private readonly requests = new Map<string, number>();

  constructor(private readonly options: {
    now(): number;
    intervalMs: number;
    perMinute: number;
    /** A delivered or obsolete batch is done; a busy batch remains pending. */
    deliver(id: string): Promise<'sent' | 'wait' | 'done'>;
  }) {}

  queue(id: string): void {
    this.pending.add(id);
    this.requests.set(id, (this.requests.get(id) ?? 0) + 1);
  }
  remove(id: string): void { this.pending.delete(id); this.lastSent.delete(id); this.requests.delete(id); }

  tick(): Promise<void> {
    if (this.running !== null) return this.running;
    const run = this.check();
    this.running = run;
    void run.then(() => { this.running = null; }, () => { this.running = null; });
    return run;
  }

  private async check(): Promise<void> {
    for (const id of this.pending) {
      const now = this.options.now();
      while (this.sentTimes.length > 0 && this.sentTimes[0]! <= now - 60_000) this.sentTimes.shift();
      if (now - (this.lastSent.get(id) ?? -Infinity) < this.options.intervalMs ||
        this.sentTimes.length >= this.options.perMinute) continue;
      const requested = this.requests.get(id) ?? 0;
      const result = await this.options.deliver(id);
      // A message that arrived during this delivery was not in its batch: keep the
      // session pending so that message gets its own check.
      if (result !== 'wait' && (this.requests.get(id) ?? 0) === requested) this.pending.delete(id);
      if (result === 'sent') {
        const sentAt = this.options.now();
        this.lastSent.set(id, sentAt);
        this.sentTimes.push(sentAt);
      }
    }
  }
}

/** Keep delivery checks at the daemon's scan cadence and enforce both rate limits. */
export class NudgeScheduler {
  private readonly pending = new Set<string>();
  private readonly lastSent = new Map<string, number>();
  private readonly sentTimes: number[] = [];
  private running: Promise<void> | null = null;

  constructor(private readonly options: {
    now(): number;
    intervalMs: number;
    perMinute: number;
    /** A delivered or obsolete batch is done; a busy batch remains pending. */
    deliver(id: string): Promise<'sent' | 'wait' | 'done'>;
  }) {}

  queue(id: string): void { this.pending.add(id); }
  remove(id: string): void { this.pending.delete(id); this.lastSent.delete(id); }

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
      const result = await this.options.deliver(id);
      if (result !== 'wait') this.pending.delete(id);
      if (result === 'sent') {
        const sentAt = this.options.now();
        this.lastSent.set(id, sentAt);
        this.sentTimes.push(sentAt);
      }
    }
  }
}

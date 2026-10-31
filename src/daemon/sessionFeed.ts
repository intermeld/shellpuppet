import { NULL_LOGGER } from '../core/types.js';
import type { Logger, SessionSummary } from '../core/types.js';

export type FeedSummary = SessionSummary & {
  waitingOnPrompt?: { question: string; options: string[]; waitingMs: number; alerted: boolean };
};

export type FeedFrame =
  | { type: 'hello'; version: string }
  | { type: 'snapshot'; at: string; sessions: FeedSummary[] }
  | { type: 'session-added'; at: string; session: FeedSummary }
  | { type: 'session-updated'; at: string; session: FeedSummary; changed: string[] }
  | { type: 'session-removed'; at: string; session: string };

const trackedFields = [
  'cols', 'rows', 'geometryHeld', 'ready', 'readyReason', 'watchers',
  'label', 'purpose', 'exited', 'exitCode', 'waitingOnPrompt',
] as const;

export function changedFields(before: FeedSummary, after: FeedSummary): string[] {
  return trackedFields.filter((field) => {
    if (field !== 'waitingOnPrompt') return before[field] !== after[field];
    const left = before.waitingOnPrompt;
    const right = after.waitingOnPrompt;
    if (left === undefined || right === undefined) return left !== right;
    return left.question !== right.question || left.alerted !== right.alerted ||
      left.options.length !== right.options.length ||
      left.options.some((option, index) => option !== right.options[index]);
  });
}

interface Subscriber {
  listener: (frame: FeedFrame) => void;
  initialising: boolean;
  queued: FeedFrame[];
}

export class SessionFeed {
  private readonly current = new Map<string, FeedSummary>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly pending: { frame: FeedFrame; recipients: Subscriber[] }[] = [];
  private dispatching = false;

  constructor(
    private readonly version: string,
    private readonly snapshot: () => FeedSummary[],
    private readonly logger: Logger = NULL_LOGGER,
  ) {
    for (const summary of snapshot()) this.current.set(summary.id, summary);
  }

  subscribe(listener: (frame: FeedFrame) => void): () => void {
    // Capture the list before registering. Events raised by a callback while
    // these two frames are delivered queue behind the captured snapshot.
    const sessions = this.snapshot();
    const subscriber: Subscriber = { listener, initialising: true, queued: [] };
    this.subscribers.add(subscriber);
    this.deliver(subscriber, { type: 'hello', version: this.version });
    this.deliver(subscriber, { type: 'snapshot', at: new Date().toISOString(), sessions });
    while (subscriber.queued.length > 0) this.deliver(subscriber, subscriber.queued.shift()!);
    subscriber.initialising = false;
    return () => { this.subscribers.delete(subscriber); };
  }

  add(summary: FeedSummary): void {
    if (this.current.has(summary.id)) return;
    this.current.set(summary.id, summary);
    this.emit({ type: 'session-added', at: new Date().toISOString(), session: summary });
  }

  update(summary: FeedSummary): void {
    const previous = this.current.get(summary.id);
    if (previous === undefined) return;
    const changed = changedFields(previous, summary);
    this.current.set(summary.id, summary);
    if (changed.length > 0) {
      this.emit({ type: 'session-updated', at: new Date().toISOString(), session: summary, changed });
    }
  }

  remove(id: string): void {
    if (!this.current.delete(id)) return;
    this.emit({ type: 'session-removed', at: new Date().toISOString(), session: id });
  }

  private emit(frame: FeedFrame): void {
    this.pending.push({ frame, recipients: [...this.subscribers] });
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift()!;
        for (const subscriber of next.recipients) {
          if (!this.subscribers.has(subscriber)) continue;
          if (subscriber.initialising) subscriber.queued.push(next.frame);
          else this.deliver(subscriber, next.frame);
        }
      }
    } finally {
      this.dispatching = false;
    }
  }

  private deliver(subscriber: Subscriber, frame: FeedFrame): void {
    try {
      subscriber.listener(frame);
    } catch {
      // A fixed message keeps screen text in a thrown error out of the log.
      this.logger.warn('session feed listener failed');
    }
  }
}

/**
 * The mailbox: messages between sessions, held by the daemon in memory
 * (design §2.5).
 *
 * The rules this module owns:
 * - A message is bound to the recipient INSTANCE that held the name when it
 *   was sent. If that participant ends before reading, the message becomes
 *   `not-delivered` and is never handed to a later holder of the same name.
 * - States: `waiting` -> `nudged` -> `read`, or `not-delivered`.
 * - One message holds at most 16 KiB of UTF-8 text. Each recipient holds at
 *   most 200 messages and 1 MiB of text; when a send would pass those, the
 *   oldest READ messages are dropped to make room, unread messages are never
 *   dropped, and a send that still does not fit is refused.
 * - Everything lives in memory: a daemon restart clears the mailbox.
 *
 * The message TEXT never leaves through events. The wiring forwards events to
 * the session feed and the dashboard; the text is read only through `inbox`,
 * `outbox` and `log`, which exist for the participants and the local owner.
 *
 * This module knows nothing about sessions or the daemon: it never imports
 * them. Everything it needs arrives as constructor dependencies, so the wiring
 * decides what "parent" means and whether messaging is switched on at all.
 *
 * Pure in-memory logic, no I/O, nothing written to stdout or stderr.
 */

import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A participant name: 1 to 40 letters, digits, dots, underscores or hyphens. */
export const NAME_PATTERN = /^[A-Za-z0-9._-]{1,40}$/;

/** The most text one message may hold, in UTF-8 bytes. */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** The most messages one recipient may hold. */
export const MAX_INBOX_MESSAGES = 200;
/** The most text one recipient may hold, in UTF-8 bytes. */
export const MAX_INBOX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------- types

export type ParticipantKind = 'session' | 'claim';

/** A participant as the mailbox hands it back: who it is, and the name it holds. */
export interface ParticipantRef {
  kind: ParticipantKind;
  id: string;
  name: string;
}

/** A daemon session joining the name registry. */
export interface SessionRegistration {
  kind: 'session';
  id: string;
  name: string;
}

export type MessageState = 'waiting' | 'nudged' | 'read' | 'not-delivered';

/** A message as a reader sees it: everything, text included. */
export interface MailboxEntry {
  id: string;
  from: ParticipantRef;
  to: { id: string; name: string };
  /** Epoch milliseconds, from the clock the mailbox was built with. */
  time: number;
  text: string;
  state: MessageState;
}

/** What `send` hands back: the id, the recipient instance and the state now. */
export interface SendResult {
  id: string;
  to: { id: string; name: string };
  state: MessageState;
}

/** The `message` event. The text is deliberately absent. */
export interface MailboxMessageEvent {
  id: string;
  from: ParticipantRef;
  to: { id: string; name: string };
  state: MessageState;
}

/** The `state` event: a message moved between states. */
export interface MailboxStateEvent {
  id: string;
  state: MessageState;
}

export type MailboxErrorCode =
  | 'invalid-name'
  | 'duplicate-name'
  | 'duplicate-id'
  | 'messaging-disabled'
  | 'unknown-sender'
  | 'unknown-name'
  | 'not-allowed'
  | 'empty-text'
  | 'text-too-large'
  | 'mailbox-full';

/** Every refusal the mailbox makes, with a code the wiring can map to a status. */
export class MailboxError extends Error {
  readonly code: MailboxErrorCode;

  constructor(code: MailboxErrorCode, message: string) {
    super(message);
    this.name = 'MailboxError';
    this.code = code;
  }
}

/** Who may message whom. Refuses everything when none is injected. */
export type MessagingPolicy = (from: ParticipantRef, to: ParticipantRef) => boolean;

export interface MailboxDeps {
  /** Whether the configuration switches messaging on. */
  enabled: boolean;
  policy?: MessagingPolicy;
  /** The clock behind message times. Defaults to the wall clock. */
  now?: () => number;
}

// ------------------------------------------------------------------ internals

interface ParticipantRecord {
  kind: ParticipantKind;
  id: string;
  name: string;
  /** Claims only: the secret handed out with the claim id. */
  secret?: string;
}

interface StoredMessage {
  id: string;
  /** Send order, monotonic for the life of the module. */
  seq: number;
  from: ParticipantRef;
  toId: string;
  toName: string;
  time: number;
  text: string;
  /** Cached UTF-8 length of the text, so the byte ceiling is cheap to check. */
  bytes: number;
  state: MessageState;
}

interface Waiter {
  readerId: string;
  from?: string;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
  settle: (message: StoredMessage | undefined) => void;
}

/** Constant-time comparison over sha256 digests, so length never leaks. */
function secretsEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

// ------------------------------------------------------------------- the mailbox

export class Mailbox extends EventEmitter {
  private readonly enabled: boolean;
  private readonly policy: MessagingPolicy;
  private readonly now: () => number;

  private readonly participants = new Map<string, ParticipantRecord>();
  private readonly byName = new Map<string, string>();
  private readonly messages: StoredMessage[] = [];
  private readonly waiters = new Set<Waiter>();
  private seq = 0;
  private claimSeq = 0;

  constructor(deps: MailboxDeps) {
    super();
    this.enabled = deps.enabled;
    // An absent policy refuses everything: the safe default.
    this.policy = deps.policy ?? (() => false);
    this.now = deps.now ?? Date.now;
  }

  override on(event: 'message', listener: (event: MailboxMessageEvent) => void): this;
  override on(event: 'state', listener: (event: MailboxStateEvent) => void): this;
  override on(event: string, listener: (...args: unknown[]) => void): this;
  override on(event: string, listener: (event: never) => void): this {
    return super.on(event, listener as unknown as (...args: unknown[]) => void);
  }

  // ------------------------------------------------------------ the name registry

  /**
   * Join the name registry under a name unique among live participants.
   * Frees nothing else: the id must be new.
   */
  register(session: SessionRegistration): void {
    if (typeof session.id !== 'string' || session.id === '') {
      throw new MailboxError('duplicate-id', 'A participant id must be a non-empty string.');
    }
    if (this.participants.has(session.id)) {
      throw new MailboxError('duplicate-id', `A participant with the id "${session.id}" is already live.`);
    }
    this.checkName(session.name);
    this.participants.set(session.id, { kind: 'session', id: session.id, name: session.name });
    this.byName.set(session.name, session.id);
  }

  private checkName(name: string): void {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      throw new MailboxError(
        'invalid-name',
        'A participant name is 1 to 40 characters of letters, digits, dots, underscores or hyphens.',
      );
    }
    if (this.byName.has(name)) {
      throw new MailboxError('duplicate-name', `The name "${name}" is already held by a live participant.`);
    }
  }

  /**
   * Hold a name from outside the daemon. The claim lasts until it is released
   * or the process ends, and is proved by the secret handed back here.
   */
  claim(name: string): { claimId: string; secret: string } {
    this.checkName(name);
    this.claimSeq += 1;
    const claimId = `c${String(this.claimSeq)}`;
    const secret = randomBytes(32).toString('base64url');
    this.participants.set(claimId, { kind: 'claim', id: claimId, name, secret });
    this.byName.set(name, claimId);
    return { claimId, secret };
  }

  /** Timing-safe claim verification. Unknown claims and wrong secrets are alike. */
  verifyClaim(claimId: string, secret: string): boolean {
    const record = this.participants.get(claimId);
    if (record === undefined || record.kind !== 'claim' || typeof secret !== 'string') return false;
    return secretsEqual(secret, record.secret ?? '');
  }

  /** End a claim. The name is freed and its unread messages are not delivered. */
  release(claimId: string): void {
    this.end(claimId);
  }

  /**
   * End a participant: the name is freed, unread messages to it become
   * `not-delivered`, and anyone waiting on its inbox is woken with nothing.
   */
  end(participantId: string): void {
    const record = this.participants.get(participantId);
    if (record === undefined) return;
    this.participants.delete(participantId);
    if (this.byName.get(record.name) === participantId) this.byName.delete(record.name);
    for (const message of this.messages) {
      if (message.toId === participantId && message.state !== 'read' && message.state !== 'not-delivered') {
        message.state = 'not-delivered';
        this.emit('state', { id: message.id, state: 'not-delivered' });
      }
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.readerId === participantId) waiter.settle(undefined);
    }
  }

  // ------------------------------------------------------------------ sending

  send(fromId: string, toName: string, text: string, now?: number): SendResult {
    const from = this.participants.get(fromId);
    if (from === undefined) {
      throw new MailboxError('unknown-sender', `No live participant has the id "${fromId}".`);
    }
    if (!this.enabled) {
      throw new MailboxError('messaging-disabled', 'Messaging is switched off in the daemon configuration.');
    }
    const toId = this.byName.get(toName);
    const to = toId === undefined ? undefined : this.participants.get(toId);
    if (to === undefined) {
      throw new MailboxError('unknown-name', `No live participant is named "${toName}".`);
    }
    if (!this.policy(from, to)) {
      throw new MailboxError(
        'not-allowed',
        `The messaging policy does not allow ${from.name} to send to ${to.name}.`,
      );
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw new MailboxError('empty-text', 'A message cannot be empty.');
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_MESSAGE_BYTES) {
      throw new MailboxError(
        'text-too-large',
        `A message is limited to ${String(MAX_MESSAGE_BYTES)} bytes of UTF-8 text; this one is ${String(bytes)}.`,
      );
    }

    // Make room, oldest READ message first. Unread messages are never dropped,
    // so a send that still does not fit is refused and drops nothing.
    const held = this.messages.filter(
      (message) => message.toId === to.id && message.state !== 'not-delivered',
    );
    const readHeld = held.filter((message) => message.state === 'read');
    let count = held.length + 1;
    let totalBytes = bytes;
    for (const message of held) totalBytes += message.bytes;
    const drops: StoredMessage[] = [];
    for (const message of readHeld) {
      if (count <= MAX_INBOX_MESSAGES && totalBytes <= MAX_INBOX_BYTES) break;
      drops.push(message);
      count -= 1;
      totalBytes -= message.bytes;
    }
    if (count > MAX_INBOX_MESSAGES || totalBytes > MAX_INBOX_BYTES) {
      throw new MailboxError(
        'mailbox-full',
        `The mailbox for ${to.name} is full (${String(MAX_INBOX_MESSAGES)} messages or ` +
          `${String(MAX_INBOX_BYTES)} bytes): unread messages are never dropped, so nothing can be ` +
          `added until some are read.`,
      );
    }
    if (drops.length > 0) {
      const dropped = new Set(drops);
      for (let index = this.messages.length - 1; index >= 0; index--) {
        const message = this.messages[index];
        if (message !== undefined && dropped.has(message)) this.messages.splice(index, 1);
      }
    }

    this.seq += 1;
    const message: StoredMessage = {
      id: `m${String(this.seq)}`,
      seq: this.seq,
      from: { kind: from.kind, id: from.id, name: from.name },
      toId: to.id,
      toName: to.name,
      time: now ?? this.now(),
      text,
      bytes,
      state: 'waiting',
    };
    this.messages.push(message);
    this.emit('message', {
      id: message.id,
      from: message.from,
      to: { id: to.id, name: to.name },
      state: 'waiting',
    });
    this.wake(message);
    return { id: message.id, to: { id: to.id, name: to.name }, state: 'waiting' };
  }

  /** Wake the first waiter this message satisfies. */
  private wake(message: StoredMessage): void {
    for (const waiter of this.waiters) {
      if (waiter.readerId !== message.toId) continue;
      if (waiter.from !== undefined && waiter.from !== message.from.id) continue;
      waiter.settle(message);
      return;
    }
  }

  /** Move messages from `waiting` to `nudged`. Other states are left alone. */
  markNudged(ids: readonly string[]): void {
    const wanted = new Set(ids);
    for (const message of this.messages) {
      if (wanted.has(message.id) && message.state === 'waiting') {
        message.state = 'nudged';
        this.emit('state', { id: message.id, state: 'nudged' });
      }
    }
  }

  // ------------------------------------------------------------------ reading

  private unreadFor(readerId: string, from?: string): StoredMessage[] {
    return this.messages.filter(
      (message) =>
        message.toId === readerId &&
        (message.state === 'waiting' || message.state === 'nudged') &&
        (from === undefined || message.from.id === from),
    );
  }

  private static entry(message: StoredMessage): MailboxEntry {
    return {
      id: message.id,
      from: message.from,
      to: { id: message.toId, name: message.toName },
      time: message.time,
      text: message.text,
      state: message.state,
    };
  }

  /**
   * The reader's unread messages, oldest first. `markRead` (the default)
   * marks the returned messages read; `limit` bounds how many are returned,
   * and marked.
   */
  inbox(readerId: string, opts: { markRead?: boolean; limit?: number } = {}): MailboxEntry[] {
    const { markRead = true, limit } = opts;
    const unread = this.unreadFor(readerId);
    const chosen = limit === undefined ? unread : unread.slice(0, Math.max(0, limit));
    if (markRead) {
      for (const message of chosen) {
        message.state = 'read';
        this.emit('state', { id: message.id, state: 'read' });
      }
    }
    return chosen.map((message) => Mailbox.entry(message));
  }

  /** The sender's messages, oldest first, with their states. */
  outbox(senderId: string): MailboxEntry[] {
    return this.messages
      .filter((message) => message.from.id === senderId)
      .map((message) => Mailbox.entry(message));
  }

  /**
   * Every message, oldest first, for the local owner's view. When
   * `participantId` is given, only that participant's messages, sent or
   * received. `limit` keeps the most recent messages, still oldest first.
   */
  log(opts: { participantId?: string; limit?: number } = {}): MailboxEntry[] {
    const { participantId, limit } = opts;
    const all = this.messages.filter(
      (message) =>
        participantId === undefined || message.from.id === participantId || message.toId === participantId,
    );
    const kept = limit === undefined ? all : all.slice(Math.max(0, all.length - Math.max(0, limit)));
    return kept.map((message) => Mailbox.entry(message));
  }

  // ------------------------------------------------------------------ waiting

  /**
   * Resolve with the next unread message for a reader, through events rather
   * than polling. Resolves at once when one is already waiting. Resolves with
   * `undefined` on timeout or when the reader ends; rejects with an
   * `AbortError` when the signal fires. `from` waits for one sender only.
   */
  async waitForMessage(
    readerId: string,
    opts: { from?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<MailboxEntry | undefined> {
    const { from, timeoutMs, signal } = opts;
    const waiting = this.unreadFor(readerId, from)[0];
    if (waiting !== undefined) return Mailbox.entry(waiting);
    if (signal?.aborted) {
      const error = new Error('The wait for a message was aborted.');
      error.name = 'AbortError';
      throw error;
    }
    return new Promise<MailboxEntry | undefined>((resolve, reject) => {
      let done = false;
      const waiter: Waiter = {
        readerId,
        from,
        settle: (message) => {
          if (done) return;
          done = true;
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
            waiter.signal.removeEventListener('abort', waiter.onAbort);
          }
          this.waiters.delete(waiter);
          resolve(message === undefined ? undefined : Mailbox.entry(message));
        },
      };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          waiter.settle(undefined);
        }, timeoutMs);
      }
      if (signal !== undefined) {
        const onAbort = (): void => {
          if (done) return;
          done = true;
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          signal.removeEventListener('abort', onAbort);
          this.waiters.delete(waiter);
          const error = new Error('The wait for a message was aborted.');
          error.name = 'AbortError';
          reject(error);
        };
        waiter.signal = signal;
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

// ----------------------------------------------------------------- the nudge line

/** What `buildNudge` needs from a message: its id and its sender. No text. */
export interface NudgeMessage {
  id: string;
  from: { id: string; name: string };
}

/** How many messages the nudge line lists before counting the rest. */
export const NUDGE_LIST_CAP = 3;

/**
 * The one line the daemon types to say that messages are waiting. The wording
 * is fixed, the line carries no message text, and a sender's name is shown
 * only when it is a plain name: anything else (spaces, line breaks, escape
 * codes, words that read as instructions) is replaced by the participant id,
 * so nothing a sender wrote reaches the user's turn through the nudge.
 */
export function buildNudge(messages: readonly NudgeMessage[]): string {
  if (messages.length === 0) return '';
  const shown = (value: string | undefined, fallback: string): string =>
    typeof value === 'string' && NAME_PATTERN.test(value) ? value : fallback;
  const pairs = messages.map((message) => {
    const id = shown(message?.id, '?');
    const name = shown(message?.from?.name, shown(message?.from?.id, 'unknown'));
    return `${id} from ${name}`;
  });
  const listed = pairs.slice(0, NUDGE_LIST_CAP);
  const more = pairs.length - listed.length;
  const tail = more > 0 ? `, and ${String(more)} more` : '';
  if (pairs.length === 1) {
    return (
      `[ShellPuppet] Message ${listed[0] ?? '?'} is waiting. ` +
      'Read it with the session_inbox tool, or run: shellpuppet inbox'
    );
  }
  return (
    `[ShellPuppet] ${String(pairs.length)} messages are waiting: ${listed.join(', ')}${tail}. ` +
    'Read them with the session_inbox tool, or run: shellpuppet inbox'
  );
}

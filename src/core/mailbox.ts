/**
 * The mailbox: messages between sessions, held by the daemon in memory
 * (design §2.5).
 *
 * The rules this module owns:
 * - A message is bound to the recipient INSTANCE that held the name when it
 *   was sent. If that participant ends before reading, the message becomes
 *   `not-delivered`. Explicit replacement of a live claim carries unread mail.
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

export function claimRecoveryCommand(name: string): string {
  return name.startsWith('-') ? `msg claim --replace --name=${name}` : `msg claim ${name} --replace`;
}

/** The most text one message may hold, in UTF-8 bytes. */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** The most messages one recipient may hold. */
export const MAX_INBOX_MESSAGES = 200;
/** The most text one recipient may hold, in UTF-8 bytes. */
export const MAX_INBOX_BYTES = 1024 * 1024;
/** The maximum retained history across the daemon. */
export const MAX_MAILBOX_MESSAGES = 2_000;
export const MAX_MAILBOX_BYTES = 8 * 1024 * 1024;
export const MAX_OUTBOX_TOMBSTONES = 200;
const CLAIM_ID_PATTERN = /^claim_[a-f0-9]{32}$/;
const DUMMY_CLAIM_DIGEST = '0'.repeat(64);

// ---------------------------------------------------------------------- types

export type ParticipantKind = 'session' | 'claim';

/** A participant as the mailbox hands it back: who it is, and the name it holds. */
export interface ParticipantRef {
  kind: ParticipantKind;
  id: string;
  name: string;
  role?: 'chair' | 'delegate';
}

/** A daemon session joining the name registry. */
export interface SessionRegistration {
  kind: 'session';
  id: string;
  name: string;
  role?: 'chair' | 'delegate';
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

  constructor(code: MailboxErrorCode, message: string, readonly hint?: string) {
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
  reservedNames?: ReadonlySet<string>;
  claimIdleMinutes?: number;
}

// ------------------------------------------------------------------ internals

export interface SavedClaim {
  id: string;
  name: string;
  digest: string;
  lastActivity: number;
}

interface ParticipantRecord {
  kind: ParticipantKind;
  id: string;
  name: string;
  role?: 'chair' | 'delegate';
  lastActivity?: number;
  generation: number;
  /** Claims only: the SHA-256 digest of the secret. */
  digest?: string;
}

interface StoredMessage {
  id: string;
  /** Send order, monotonic for the life of the module. */
  seq: number;
  from: ParticipantRef;
  fromGeneration: number;
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

function claimDigest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

// ------------------------------------------------------------------- the mailbox

export class Mailbox extends EventEmitter {
  private readonly enabled: boolean;
  private readonly policy: MessagingPolicy;
  private readonly now: () => number;
  private readonly reservedNames: ReadonlySet<string>;
  private readonly claimIdleMs: number;

  private readonly participants = new Map<string, ParticipantRecord>();
  private readonly byName = new Map<string, string>();
  private readonly messages: StoredMessage[] = [];
  private readonly waiters = new Set<Waiter>();
  private seq = 0;
  private generation = 0;

  constructor(deps: MailboxDeps) {
    super();
    this.enabled = deps.enabled;
    // An absent policy refuses everything: the safe default.
    this.policy = deps.policy ?? (() => false);
    this.now = deps.now ?? Date.now;
    this.reservedNames = deps.reservedNames ?? new Set();
    this.claimIdleMs = (deps.claimIdleMinutes ?? 30) * 60_000;
  }

  /** Keep recent tombstones per sender, then enforce the daemon-wide budget. */
  private trimHistory(): void {
    const tombstones = new Map<number, number>();
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index];
      if (message?.state !== 'not-delivered') continue;
      const count = (tombstones.get(message.fromGeneration) ?? 0) + 1;
      tombstones.set(message.fromGeneration, count);
      if (count > MAX_OUTBOX_TOMBSTONES) this.messages.splice(index, 1);
    }
    let bytes = this.messages.reduce((sum, message) => sum + message.bytes, 0);
    for (const state of ['not-delivered', 'read'] as const) {
      for (let index = 0; index < this.messages.length &&
        (this.messages.length > MAX_MAILBOX_MESSAGES || bytes > MAX_MAILBOX_BYTES);) {
        const message = this.messages[index];
        if (message?.state === state) {
          bytes -= message.bytes;
          this.messages.splice(index, 1);
        } else index++;
      }
    }
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
    if (CLAIM_ID_PATTERN.test(session.id) || this.participants.has(session.id)) {
      throw new MailboxError('duplicate-id', `A participant with the id "${session.id}" is already live.`);
    }
    this.checkName(session.name);
    if (this.reservedNames.has(session.name)) throw new MailboxError('invalid-name', `The name "${session.name}" is reserved for an outside claim.`);
    this.participants.set(session.id, { kind: 'session', id: session.id, name: session.name, role: session.role ?? 'delegate', generation: ++this.generation });
    this.byName.set(session.name, session.id);
  }

  nameTaken(name: string): boolean { return this.byName.has(name) || this.reservedNames.has(name); }

  sessionIdByName(name: string): string | undefined {
    const id = this.byName.get(name);
    return id !== undefined && this.participants.get(id)?.kind === 'session' ? id : undefined;
  }

  participant(id: string): ParticipantRef | undefined {
    const record = this.participants.get(id);
    return record === undefined ? undefined : { kind: record.kind, id: record.id, name: record.name, ...(record.role === 'chair' ? { role: record.role } : {}) };
  }

  rename(id: string, name: string): void {
    const record = this.participants.get(id);
    if (record?.kind !== 'session') throw new MailboxError('unknown-sender', 'The session has ended.');
    if (record.name === name) return;
    if (this.reservedNames.has(name)) throw new MailboxError('invalid-name', `The name "${name}" is reserved for an outside claim.`);
    this.checkName(name);
    this.byName.delete(record.name);
    record.name = name;
    this.byName.set(name, id);
  }

  expiredClaims(): string[] {
    const lapsed: string[] = [];
    for (const record of [...this.participants.values()]) {
      if (record.kind === 'claim' && ![...this.waiters].some((waiter) => waiter.readerId === record.id) && this.now() - (record.lastActivity ?? 0) >= this.claimIdleMs) {
        lapsed.push(record.id);
      }
    }
    return lapsed;
  }

  lapseClaims(): string[] {
    const lapsed = this.expiredClaims();
    for (const id of lapsed) this.end(id);
    return lapsed;
  }

  touchClaim(id: string): void {
    const record = this.participants.get(id);
    if (record?.kind === 'claim') record.lastActivity = this.now();
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

  private newClaimId(): string {
    return `claim_${randomBytes(16).toString('hex')}`;
  }

  /** Issue a proof, carrying unread mail only when replacing a live outside claim. */
  claim(name: string, options: {
    replace?: boolean;
    beforeCommit?: (next: SavedClaim, previousId?: string) => void;
  } = {}) {
    if (typeof name === 'string' && /^s[0-9]+$/.test(name)) {
      throw new MailboxError('invalid-name', 'Session id names are reserved for sessions.');
    }
    const previousId = this.byName.get(name);
    if (previousId === undefined) {
      this.checkName(name);
    } else {
      const previous = this.participants.get(previousId)!;
      if (previous.kind === 'session' || !options.replace) {
        const hint = previous.kind === 'session' ? 'That participant name is unavailable.' :
          `Recover it with ${claimRecoveryCommand(name)} or replace: true on session_claim.`;
        throw new MailboxError('duplicate-name', `The name "${name}" is already held by a live participant.`, hint);
      }
    }
    let claimId: string;
    do {
      claimId = this.newClaimId();
    } while (this.participants.has(claimId));
    const secret = randomBytes(32).toString('base64url');
    const next = { id: claimId, name, digest: claimDigest(secret), lastActivity: this.now() };
    // Finish required writes before retiring the old reader or changing delivery.
    options.beforeCommit?.(next, previousId);
    if (previousId !== undefined) {
      for (const message of this.unreadFor(previousId)) message.toId = claimId;
      this.end(previousId);
    }
    this.participants.set(claimId, { ...next, kind: 'claim', generation: ++this.generation });
    this.byName.set(name, claimId);
    return { claimId, secret, previousId };
  }

  savedClaims(granted: readonly string[]) {
    const waiting = new Set([...this.waiters].map(waiter => waiter.readerId));
    const now = this.now();
    return [...this.participants.values()]
      .filter(p => p.kind === 'claim' && granted.includes(p.name))
      .map(({ id, name, digest, lastActivity }) => ({ id, name, digest, lastActivity: waiting.has(id) ? now : lastActivity }));
  }

  restoreClaims(rows: unknown, granted: readonly string[]): number {
    if (!Array.isArray(rows)) return 0;
    let count = 0;
    for (const value of rows.slice(0, 64) as unknown[]) {
      if (typeof value !== 'object' || value === null) continue;
      const row = value as Record<string, unknown>;
      if (typeof row['name'] !== 'string' || !granted.includes(row['name']) || !NAME_PATTERN.test(row['name']) ||
        typeof row['id'] !== 'string' || !CLAIM_ID_PATTERN.test(row['id']) ||
        typeof row['digest'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['digest']) ||
        typeof row['lastActivity'] !== 'number' || !Number.isFinite(row['lastActivity']) || this.now() - row['lastActivity'] >= this.claimIdleMs ||
        this.participants.has(row['id']) || this.byName.has(row['name'])) continue;
      this.participants.set(row['id'], { kind: 'claim', id: row['id'], name: row['name'],
        digest: row['digest'], lastActivity: row['lastActivity'], generation: ++this.generation });
      this.byName.set(row['name'], row['id']);
      count++;
    }
    return count;
  }

  private compareSecrets(secret: string, digest: string): boolean {
    return timingSafeEqual(Buffer.from(claimDigest(secret)), Buffer.from(digest));
  }

  /** Marked requests can authenticate a proof without refreshing its idle deadline. */
  verifyClaim(claimId: string, secret: string, refresh = true): boolean {
    const record = this.participants.get(claimId);
    const matched = this.compareSecrets(typeof secret === 'string' ? secret : '', record?.digest ?? DUMMY_CLAIM_DIGEST);
    if (record?.kind === 'claim' && typeof secret === 'string' && matched) {
      if (refresh) record.lastActivity = this.now();
      return true;
    }
    return false;
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
    const changed: MailboxStateEvent[] = [];
    for (const message of this.messages) {
      if (message.toId === participantId && message.state !== 'read' && message.state !== 'not-delivered') {
        message.state = 'not-delivered';
        changed.push({ id: message.id, state: 'not-delivered' });
      }
    }
    for (let index = this.messages.length - 1; index >= 0; index--) {
      const message = this.messages[index];
      if (message?.toId === participantId && message.state === 'read') this.messages.splice(index, 1);
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.readerId === participantId) waiter.settle(undefined);
    }
    this.participants.delete(participantId);
    if (this.byName.get(record.name) === participantId) this.byName.delete(record.name);
    this.trimHistory();
    // One subscriber must not interrupt shutdown or prevent another from seeing it.
    for (const event of changed) {
      for (const listener of this.rawListeners('state')) {
        try { listener.call(this, event); } catch { /* Event subscribers are independent. */ }
      }
    }
  }

  // ------------------------------------------------------------------ sending

  send(fromId: string, toName: string, text: string, now?: number): SendResult {
    const from = this.participants.get(fromId);
    if (from === undefined) {
      throw new MailboxError('unknown-sender',
        typeof fromId === 'string' && NAME_PATTERN.test(fromId)
          ? `No live participant has the id "${fromId}".` : 'No live participant has that id.');
    }
    if (!this.enabled) {
      throw new MailboxError('messaging-disabled', 'Messaging is switched off in the daemon configuration.');
    }
    const toId = this.byName.get(toName);
    const to = toId === undefined ? undefined : this.participants.get(toId);
    if (to === undefined) {
      throw new MailboxError('unknown-name',
        typeof toName === 'string' && NAME_PATTERN.test(toName)
          ? `No live participant is named "${toName}".` : 'No live participant has that name.');
    }
    if (!this.policy(from, to)) {
      throw new MailboxError(
        'not-allowed',
        `Messages from ${from.name} to ${to.name} are not allowed by messaging.allow.`,
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
    // Plan global eviction before changing anything. A refused send drops nothing.
    const dropped = new Set(drops);
    let globalCount = this.messages.length - dropped.size + 1;
    let globalBytes = bytes + this.messages.reduce((sum, item) => sum + (dropped.has(item) ? 0 : item.bytes), 0);
    for (const state of ['not-delivered', 'read'] as const) {
      for (const item of this.messages) {
        if (globalCount <= MAX_MAILBOX_MESSAGES && globalBytes <= MAX_MAILBOX_BYTES) break;
        if (item.state !== state || dropped.has(item)) continue;
        drops.push(item);
        dropped.add(item);
        globalCount--;
        globalBytes -= item.bytes;
      }
    }
    if (globalCount > MAX_MAILBOX_MESSAGES || globalBytes > MAX_MAILBOX_BYTES) {
      throw new MailboxError('mailbox-full', 'The daemon mailbox is full of unread messages.');
    }
    if (drops.length > 0) {
      for (let index = this.messages.length - 1; index >= 0; index--) {
        const message = this.messages[index];
        if (message !== undefined && dropped.has(message)) this.messages.splice(index, 1);
      }
    }

    this.seq += 1;
    const message: StoredMessage = {
      id: `m${String(this.seq)}`,
      seq: this.seq,
      from: { kind: from.kind, id: from.id, name: from.name, ...(from.role === 'chair' ? { role: from.role } : {}) },
      fromGeneration: from.generation,
      toId: to.id,
      toName: to.name,
      time: now ?? this.now(),
      text,
      bytes,
      state: 'waiting',
    };
    this.messages.push(message);
    this.trimHistory();
    this.emit('message', {
      id: message.id,
      from: { ...message.from },
      to: { id: to.id, name: to.name },
      state: 'waiting',
    });
    this.wake(message);
    return { id: message.id, to: { id: to.id, name: to.name }, state: 'waiting' };
  }

  /** Wake every matching waiter; waiting does not mark the message read. */
  private wake(message: StoredMessage): void {
    for (const waiter of this.waiters) {
      if (waiter.readerId !== message.toId) continue;
      if (waiter.from !== undefined && waiter.from !== message.from.id) continue;
      waiter.settle(message);
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
      from: { ...message.from },
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

  /** The live sender's recent messages, oldest first, with their states. */
  outbox(senderId: string, opts: { limit?: number } = {}): MailboxEntry[] {
    const generation = this.participants.get(senderId)?.generation;
    if (generation === undefined) return [];
    const all = this.messages.filter((message) => message.from.id === senderId && message.fromGeneration === generation);
    const kept = opts.limit === undefined ? all : all.slice(Math.max(0, all.length - Math.max(0, opts.limit)));
    return kept.map((message) => Mailbox.entry(message));
  }

  /** Live names this participant may address under the configured policy. */
  directory(senderId: string): ParticipantRef[] {
    const sender = this.participants.get(senderId);
    if (sender === undefined || !this.enabled) return [];
    return [...this.participants.values()]
      .filter((recipient) => this.policy(sender, recipient))
      .map(({ kind, id, name, role }) => ({ kind, id, name, ...(role === 'chair' ? { role } : {}) }));
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
   * `AbortError` when the signal fires. `from` waits for one sender only,
   * named by participant id or by the name it holds now.
   */
  async waitForMessage(
    readerId: string,
    opts: { from?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<MailboxEntry | undefined> {
    const { timeoutMs, signal } = opts;
    const from = opts.from === undefined || this.participants.has(opts.from)
      ? opts.from
      : this.byName.get(opts.from) ?? opts.from;
    if (!this.participants.has(readerId)) return undefined;
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
          waiter.settle(this.unreadFor(readerId, from)[0]);
        }, timeoutMs);
        waiter.timer.unref();
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
 * codes) is replaced by the participant id. Plain names may contain words.
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
      'Read it with the session_inbox tool.'
    );
  }
  return (
    `[ShellPuppet] ${String(pairs.length)} messages are waiting: ${listed.join(', ')}${tail}. ` +
    'Read them with the session_inbox tool.'
  );
}

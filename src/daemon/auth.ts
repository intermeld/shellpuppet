/**
 * Token generation and verification (design §4.1).
 *
 * Three credentials, deliberately different in kind:
 *
 * - **Client token**: full API access; generated per daemon run, written to
 *   `daemon.json`, read by same-user clients. Rotates on restart. Travels in an
 *   `Authorization` header over HTTP, and on the query string for the two
 *   WebSocket routes, because a browser will not let a page set headers on an
 *   upgrade (design §4.1). It never appears in a URL a human is given.
 * - **Viewer grant**: the `vt` in a viewer URL. **One use, short life.** It
 *   is not a session credential and cannot open a stream; it can only be
 *   exchanged, once, for the credential below. A viewer URL inevitably lands
 *   in the driving agent's transcript, in logs and in whatever the human
 *   pasted it into, so the thing that lands there has to become worthless
 *   the moment it has done its job: spent by the first redemption, or expired
 *   unopened. Until then it is a live bearer capability.
 * - **Stream credential**: what a grant is exchanged for, delivered as an
 *   `HttpOnly` cookie scoped to that one session's path. The browser attaches
 *   it to the WebSocket upgrade on its own, so page scripts never hold it and
 *   cannot leak it. It lives as long as the session, because a viewer that
 *   reconnects after a dropped socket must not need a fresh URL.
 *
 * Read-only is a property of the grant, and so of the credential it
 * becomes: it is enforced by the daemon, not by the viewer page. The page's
 * own toggle stops that tab sending keystrokes and is a convenience; a
 * read-only credential means the daemon will not accept them.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type AuthResult =
  | { kind: 'client' }
  | { kind: 'viewer'; sessionId: string; readOnly: boolean }
  | null;

/**
 * How long an unredeemed viewer grant stays usable.
 *
 * The window we open ourselves redeems it in a second or two, so this bounds
 * only the case where nobody opened the link: a URL sitting in a transcript,
 * a chat message or a terminal scrollback. Five minutes is long enough to
 * paste a link to a second device by hand and short enough that yesterday's
 * transcript is inert. Expired is not a dead end: mint another.
 */
export const VIEWER_GRANT_TTL_MS = 5 * 60_000;

interface ViewerGrant {
  sessionId: string;
  readOnly: boolean;
  expiresAt: number;
}

interface StreamCredential {
  sessionId: string;
  readOnly: boolean;
  /**
   * The grant this was exchanged for, kept so the minter can take back what
   * it handed out. A grant is one-use, so this names exactly one credential,
   * and it is dead the moment the grant is redeemed: it opens nothing, and
   * keeping it costs nothing a reader of this store should worry about.
   */
  grant: string;
}

export interface RedeemedGrant {
  /** The value to put in the viewer's cookie. */
  streamToken: string;
  sessionId: string;
  readOnly: boolean;
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/** Constant-time comparison over sha256 digests, so length never leaks. */
function tokensEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

/**
 * Find a key by constant-time comparison rather than by lookup. A `Map.get`
 * would be faster and would compare the presented string against stored keys
 * in whatever way the engine sees fit; these are secrets, so every comparison
 * goes through `tokensEqual`.
 */
function findKey<T>(store: Map<string, T>, presented: string): string | null {
  for (const key of store.keys()) {
    if (tokensEqual(presented, key)) return key;
  }
  return null;
}

export class TokenStore {
  private readonly clientToken: string;
  private readonly grants = new Map<string, ViewerGrant>();
  private readonly streams = new Map<string, StreamCredential>();

  constructor(clientToken: string = generateToken()) {
    this.clientToken = clientToken;
  }

  get token(): string {
    return this.clientToken;
  }

  /**
   * Mint a one-use viewer grant for a session. `readOnly` rides with it, so a
   * watch-only link cannot be turned into a typing one by the page that holds
   * it.
   */
  mintViewerGrant(
    sessionId: string,
    options: { readOnly?: boolean; ttlMs?: number; now?: number } = {},
  ): string {
    const now = options.now ?? Date.now();
    this.pruneExpired(now);
    const token = generateToken();
    this.grants.set(token, {
      sessionId,
      readOnly: options.readOnly ?? false,
      expiresAt: now + (options.ttlMs ?? VIEWER_GRANT_TTL_MS),
    });
    return token;
  }

  /**
   * Exchange a grant for a stream credential, consuming the grant. Returns
   * null for an unknown, already-redeemed or expired grant. The three cases
   * are deliberately indistinguishable to the caller.
   */
  redeemViewerGrant(
    presented: string | undefined | null,
    now: number = Date.now(),
  ): RedeemedGrant | null {
    this.pruneExpired(now);
    if (presented === undefined || presented === null || presented === '') return null;
    const key = findKey(this.grants, presented);
    if (key === null) return null;
    const grant = this.grants.get(key);
    if (grant === undefined) return null;
    // One use: gone whether or not the caller does anything with it.
    this.grants.delete(key);
    if (grant.expiresAt <= now) return null;
    const streamToken = generateToken();
    this.streams.set(streamToken, {
      sessionId: grant.sessionId,
      readOnly: grant.readOnly,
      grant: key,
    });
    return { streamToken, sessionId: grant.sessionId, readOnly: grant.readOnly };
  }

  /** Verify a stream credential (the viewer's cookie). */
  verifyStreamToken(presented: string | undefined | null): AuthResult {
    if (presented === undefined || presented === null || presented === '') return null;
    const key = findKey(this.streams, presented);
    if (key === null) return null;
    const credential = this.streams.get(key);
    if (credential === undefined) return null;
    return {
      kind: 'viewer',
      sessionId: credential.sessionId,
      readOnly: credential.readOnly,
    };
  }

  /**
   * Take back a grant and whatever it became: the grant itself if nobody spent
   * it, and the stream credential it was exchanged for if somebody did.
   *
   * For a link minted on behalf of something with an end, which is the
   * screenshot's headless browser and not a human's window. Its credential
   * would otherwise live as long as the session, so a session photographed a
   * thousand times would hold a thousand of them, each able to open a socket.
   * A human's viewer is the opposite case and keeps its credential: a dropped
   * socket must reconnect without a fresh link.
   */
  revokeViewerGrant(grant: string): void {
    if (grant === '') return;
    const key = findKey(this.grants, grant);
    if (key !== null) this.grants.delete(key);
    for (const [token, credential] of this.streams) {
      if (tokensEqual(credential.grant, grant)) this.streams.delete(token);
    }
  }

  /** Drop every viewer grant and credential scoped to a session (on kill/exit cleanup). */
  revokeViewerTokens(sessionId: string): void {
    for (const [token, grant] of this.grants) {
      if (grant.sessionId === sessionId) this.grants.delete(token);
    }
    for (const [token, credential] of this.streams) {
      if (credential.sessionId === sessionId) this.streams.delete(token);
    }
  }

  /**
   * Verify a bearer token. Only the client token authenticates this way:
   * viewer credentials are cookie-borne and session-scoped, and are checked
   * with `verifyStreamToken`.
   */
  verify(presented: string | undefined | null): AuthResult {
    if (presented === undefined || presented === null || presented === '') return null;
    if (tokensEqual(presented, this.clientToken)) return { kind: 'client' };
    return null;
  }

  private pruneExpired(now: number): void {
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(token);
    }
  }
}

/** Extract a bearer token from an Authorization header value. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * The viewer's cookie name. One name, but each is written with the session's
 * own `Path`, so a browser watching several sessions keeps their credentials
 * apart and sends only the one whose path matches the socket being opened.
 */
export const VIEWER_COOKIE = 'sp_viewer';

/**
 * Every value carried under `name` in a Cookie header, in order, with its
 * percent-escapes decoded. More than one is possible: cookies ignore ports,
 * so anything served from 127.0.0.1 can set a same-named cookie beside the
 * daemon's own, and the caller tries each rather than trusting the first. A
 * value whose escapes do not decode is skipped rather than thrown on.
 */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (header === undefined) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== name) continue;
    try {
      values.push(decodeURIComponent(part.slice(at + 1).trim()));
    } catch {
      // Not a value this daemon ever set. Ignored, never fatal.
    }
  }
  return values;
}

/** The first value carried under `name`, or null. */
export function cookieValue(header: string | undefined, name: string): string | null {
  return cookieValues(header, name)[0] ?? null;
}

/**
 * The `Set-Cookie` value delivering a stream credential.
 *
 * `HttpOnly` keeps it out of reach of page scripts, `SameSite=Strict` stops
 * any other site's navigation carrying it and the per-session `Path` means a
 * credential for one session is never even sent on another's socket. No
 * `Max-Age`: it should die with the browsing session, not linger on disk.
 * No `Secure`, deliberately: the daemon is loopback-only http, and a
 * `Secure` cookie would simply never be stored.
 */
export function viewerCookie(sessionId: string, streamToken: string): string {
  return (
    `${VIEWER_COOKIE}=${encodeURIComponent(streamToken)}` +
    `; Path=/sessions/${encodeURIComponent(sessionId)}` +
    '; HttpOnly; SameSite=Strict'
  );
}

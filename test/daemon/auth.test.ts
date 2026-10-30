/**
 * Token store (design §4.1): the client token, one-use viewer grants and the
 * stream credentials they are exchanged for.
 */

import { describe, expect, it } from 'vitest';
import {
  TokenStore,
  VIEWER_COOKIE,
  VIEWER_GRANT_TTL_MS,
  bearerToken,
  cookieValue,
  cookieValues,
  generateToken,
  viewerCookie,
} from '../../src/daemon/auth.js';

describe('client token', () => {
  it('verifies its own token and nothing else', () => {
    const store = new TokenStore('client-secret');
    expect(store.verify('client-secret')).toEqual({ kind: 'client' });
    expect(store.verify('nearly-right')).toBeNull();
    expect(store.verify('')).toBeNull();
    expect(store.verify(undefined)).toBeNull();
    expect(store.verify(null)).toBeNull();
  });

  it('never accepts a viewer grant as a bearer token', () => {
    const store = new TokenStore('client-secret');
    const grant = store.mintViewerGrant('s1');
    // A grant is not a credential: it can only be exchanged, at one endpoint.
    expect(store.verify(grant)).toBeNull();
    expect(store.verifyStreamToken(grant)).toBeNull();
  });
});

describe('viewer grants', () => {
  it('exchanges once for a stream credential, then never again', () => {
    const store = new TokenStore();
    const grant = store.mintViewerGrant('s1');

    const redeemed = store.redeemViewerGrant(grant);
    expect(redeemed).not.toBeNull();
    expect(redeemed?.sessionId).toBe('s1');
    expect(redeemed?.readOnly).toBe(false);
    expect(redeemed?.streamToken).not.toBe(grant);

    // The whole point: a URL captured from a transcript is spent.
    expect(store.redeemViewerGrant(grant)).toBeNull();
  });

  it('expires unredeemed', () => {
    const store = new TokenStore();
    const start = 1_000_000;
    const grant = store.mintViewerGrant('s1', { now: start });

    expect(store.redeemViewerGrant(grant, start + VIEWER_GRANT_TTL_MS + 1)).toBeNull();
    // And is not resurrected by asking again inside the window.
    expect(store.redeemViewerGrant(grant, start + 1)).toBeNull();
  });

  it('honours a shorter life when asked', () => {
    const store = new TokenStore();
    const start = 1_000_000;
    const grant = store.mintViewerGrant('s1', { now: start, ttlMs: 1_000 });
    expect(store.redeemViewerGrant(grant, start + 999)).not.toBeNull();
  });

  it('is refused at the very millisecond it expires, and lives five minutes', () => {
    // The boundary: a grant redeemed AT its expiry is spent. And the life is
    // pinned as a number, because "five minutes" is what the docs promise,
    // not whatever the constant happens to say.
    const store = new TokenStore();
    const start = 1_000_000;
    const late = store.mintViewerGrant('s1', { now: start, ttlMs: 1_000 });
    expect(store.redeemViewerGrant(late, start + 1_000)).toBeNull();
    expect(VIEWER_GRANT_TTL_MS).toBe(5 * 60_000);
  });

  it('rejects an unknown grant', () => {
    const store = new TokenStore();
    store.mintViewerGrant('s1');
    expect(store.redeemViewerGrant(generateToken())).toBeNull();
    expect(store.redeemViewerGrant('')).toBeNull();
    expect(store.redeemViewerGrant(undefined)).toBeNull();
  });

  it('carries read-only through to the credential', () => {
    const store = new TokenStore();
    const grant = store.mintViewerGrant('s1', { readOnly: true });
    const redeemed = store.redeemViewerGrant(grant);
    expect(redeemed?.readOnly).toBe(true);
    // The page cannot widen what it was given.
    expect(store.verifyStreamToken(redeemed?.streamToken)).toEqual({
      kind: 'viewer',
      sessionId: 's1',
      readOnly: true,
    });
  });
});

describe('stream credentials', () => {
  it('identify their own session and survive repeated use', () => {
    const store = new TokenStore();
    const redeemed = store.redeemViewerGrant(store.mintViewerGrant('s7'));
    const token = redeemed?.streamToken;
    // Reconnects must not need a fresh link.
    expect(store.verifyStreamToken(token)).toEqual({
      kind: 'viewer',
      sessionId: 's7',
      readOnly: false,
    });
    expect(store.verifyStreamToken(token)).not.toBeNull();
    expect(store.verifyStreamToken(generateToken())).toBeNull();
  });

  it('die with the grant they came from, so a capture takes its credential with it', () => {
    // A screenshot mints a grant and the headless browser spends it; the
    // credential that comes back is revoked with the grant, so a session
    // photographed a thousand times does not hold a thousand live
    // credentials.
    const store = new TokenStore();
    const grant = store.mintViewerGrant('s1', { readOnly: true });
    const redeemed = store.redeemViewerGrant(grant);
    expect(store.verifyStreamToken(redeemed?.streamToken)).not.toBeNull();

    store.revokeViewerGrant(grant);

    expect(store.verifyStreamToken(redeemed?.streamToken)).toBeNull();
  });

  it('revoking a grant nobody spent leaves nothing to spend', () => {
    // The capture that failed before the page loaded: the grant is still out
    // there, in a URL the browser never opened, and it must not survive the
    // capture that minted it either.
    const store = new TokenStore();
    const grant = store.mintViewerGrant('s1');

    store.revokeViewerGrant(grant);

    expect(store.redeemViewerGrant(grant)).toBeNull();
  });

  it('revokes only what came from that grant, not the neighbours', () => {
    const store = new TokenStore();
    const doomed = store.mintViewerGrant('s1');
    const fromDoomed = store.redeemViewerGrant(doomed);
    // The same session's human viewer, and another session's altogether.
    const sameSession = store.redeemViewerGrant(store.mintViewerGrant('s1'));
    const otherSession = store.redeemViewerGrant(store.mintViewerGrant('s2'));
    const unspent = store.mintViewerGrant('s1');

    store.revokeViewerGrant(doomed);

    expect(store.verifyStreamToken(fromDoomed?.streamToken)).toBeNull();
    expect(store.verifyStreamToken(sameSession?.streamToken)).not.toBeNull();
    expect(store.verifyStreamToken(otherSession?.streamToken)).not.toBeNull();
    expect(store.redeemViewerGrant(unspent)).not.toBeNull();
  });

  it('are revoked with their session, grants included', () => {
    const store = new TokenStore();
    const live = store.redeemViewerGrant(store.mintViewerGrant('s1'));
    const unredeemed = store.mintViewerGrant('s1');
    const other = store.redeemViewerGrant(store.mintViewerGrant('s2'));

    store.revokeViewerTokens('s1');

    expect(store.verifyStreamToken(live?.streamToken)).toBeNull();
    expect(store.redeemViewerGrant(unredeemed)).toBeNull();
    // A neighbouring session is untouched.
    expect(store.verifyStreamToken(other?.streamToken)).not.toBeNull();
  });
});

describe('header helpers', () => {
  it('reads every cookie of the name, in order, and skips one that will not decode', () => {
    // Cookies ignore ports: anything on another loopback port can plant one
    // beside the daemon's own. A value whose escapes do not decode is skipped
    // rather than thrown on.
    expect(cookieValues('sp_viewer=first; a=1; sp_viewer=second', VIEWER_COOKIE)).toEqual([
      'first',
      'second',
    ]);
    expect(cookieValues('sp_viewer=%zz; sp_viewer=ok%20fine', VIEWER_COOKIE)).toEqual(['ok fine']);
    expect(cookieValues(undefined, VIEWER_COOKIE)).toEqual([]);
    expect(cookieValue('sp_viewer=%zz', VIEWER_COOKIE)).toBeNull();
  });

  it('reads a bearer token', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('bearer abc123')).toBe('abc123');
    expect(bearerToken('Basic abc123')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it('reads one cookie out of a header', () => {
    expect(cookieValue('a=1; sp_viewer=secret; b=2', VIEWER_COOKIE)).toBe('secret');
    expect(cookieValue('sp_viewer=secret', VIEWER_COOKIE)).toBe('secret');
    // A name that merely ends the same way is not a match.
    expect(cookieValue('other_sp_viewer=secret', VIEWER_COOKIE)).toBeNull();
    expect(cookieValue('a=1', VIEWER_COOKIE)).toBeNull();
    expect(cookieValue(undefined, VIEWER_COOKIE)).toBeNull();
  });

  it('scopes the cookie to one session and keeps it from scripts', () => {
    const cookie = viewerCookie('s3', 'tok');
    expect(cookie).toContain('sp_viewer=tok');
    expect(cookie).toContain('Path=/sessions/s3');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    // A cookie that outlived the browsing session would be a stored credential.
    expect(cookie).not.toContain('Max-Age');
  });
});

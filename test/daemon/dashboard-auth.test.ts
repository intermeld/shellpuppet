/**
 * Dashboard grant and the credential it becomes (design §4.1).
 *
 * One use, five minutes, not a session credential. Redeeming replaces whatever
 * credential was current and drops its proofs.
 */

import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_COOKIE,
  DASHBOARD_PROOF_LIMIT,
  DASHBOARD_UNUSED_PROOF_LIMIT,
  TokenStore,
  VIEWER_GRANT_TTL_MS,
  dashboardCookie,
  dashboardProofFromProtocol,
} from '../../src/daemon/auth.js';

describe('dashboard grant', () => {
  it('exchanges once for a cookie credential, then never again', () => {
    const store = new TokenStore();
    const grant = store.mintDashboardGrant();
    const redeemed = store.redeemDashboardGrant(grant);
    expect(redeemed).not.toBeNull();
    expect(redeemed?.token).not.toBe(grant);
    expect(store.verifyDashboardToken(redeemed?.token)).toBe(true);
    // A URL captured from a transcript is spent.
    expect(store.redeemDashboardGrant(grant)).toBeNull();
    expect(store.verifyDashboardToken(grant)).toBe(false);
  });

  it('expires unredeemed, and expiry spends it', () => {
    const store = new TokenStore();
    const start = 1_000_000;
    const grant = store.mintDashboardGrant({ now: start });
    expect(store.redeemDashboardGrant(grant, start + VIEWER_GRANT_TTL_MS)).toBeNull();
    // Not resurrected by asking again inside the window.
    expect(store.redeemDashboardGrant(grant, start + 1)).toBeNull();
  });

  it('lives five minutes unless a test asks for a shorter life', () => {
    const store = new TokenStore();
    const start = 1_000_000;
    const grant = store.mintDashboardGrant({ now: start, ttlMs: 1_000 });
    expect(store.redeemDashboardGrant(grant, start + 999)).not.toBeNull();
    expect(VIEWER_GRANT_TTL_MS).toBe(5 * 60_000);
  });

  it('revokes an unspent grant and the credential a spent grant became', () => {
    const store = new TokenStore();
    const unspent = store.mintDashboardGrant();
    store.revokeDashboardGrant(unspent);
    expect(store.redeemDashboardGrant(unspent)).toBeNull();

    const spent = store.mintDashboardGrant();
    const redeemed = store.redeemDashboardGrant(spent);
    const proof = store.issueDashboardProof();
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(store.retainDashboardProof(proof)).toBeDefined();
    const unused = store.issueDashboardProof();
    store.revokeDashboardGrant(spent);
    expect(store.verifyDashboardToken(redeemed?.token)).toBe(false);
    expect(store.acceptsDashboardProof(proof)).toBe(false);
    expect(store.acceptsDashboardProof(unused)).toBe(false);
  });

  it('a second redeem replaces the credential and drops its proofs', () => {
    const store = new TokenStore();
    const first = store.redeemDashboardGrant(store.mintDashboardGrant());
    const oldProof = store.issueDashboardProof();
    const second = store.redeemDashboardGrant(store.mintDashboardGrant());
    expect(store.verifyDashboardToken(first?.token)).toBe(false);
    expect(store.acceptsDashboardProof(oldProof)).toBe(false);
    expect(store.verifyDashboardToken(second?.token)).toBe(true);
    const fresh = store.issueDashboardProof();
    expect(store.acceptsDashboardProof(fresh)).toBe(true);
    expect(fresh).not.toBe(oldProof);
  });

  it('keeps the eight newest unused proofs and drops the oldest', () => {
    const store = new TokenStore();
    store.redeemDashboardGrant(store.mintDashboardGrant());
    const proofs: string[] = [];
    expect(DASHBOARD_UNUSED_PROOF_LIMIT).toBe(8);
    for (let i = 0; i < DASHBOARD_UNUSED_PROOF_LIMIT + 1; i += 1) {
      const proof = store.issueDashboardProof();
      expect(proof).toMatch(/^[0-9a-f]{64}$/);
      proofs.push(proof ?? '');
    }
    expect(new Set(proofs).size).toBe(proofs.length);
    expect(store.acceptsDashboardProof(proofs[0])).toBe(false);
    expect(store.acceptsDashboardProof(proofs[1])).toBe(true);
    expect(store.acceptsDashboardProof(proofs.at(-1))).toBe(true);
    // Equal-length and wrong: the compare hashes, it does not branch on length.
    const newest = proofs.at(-1)!;
    const flipped = newest.slice(0, 63) + (newest.endsWith('0') ? '1' : '0');
    expect(flipped).toHaveLength(64);
    expect(store.acceptsDashboardProof(flipped)).toBe(false);
    expect(store.acceptsDashboardProof('')).toBe(false);
    expect(store.acceptsDashboardProof(undefined)).toBe(false);
  });

  it('lets a document reconnect at capacity and issues a new proof once a slot is free', () => {
    const store = new TokenStore();
    store.redeemDashboardGrant(store.mintDashboardGrant());
    const documents = Array.from({ length: DASHBOARD_PROOF_LIMIT }, () => {
      const document = store.retainDashboardProof(store.issueDashboardProof());
      expect(document).toBeDefined();
      return document!;
    });
    const first = documents[0]!;
    expect(store.issueDashboardProof()).toBeNull();
    const secondSocket = store.retainDashboardProof(first.token)!;
    store.releaseDashboardProof(first);
    expect(store.issueDashboardProof()).toBeNull();
    expect(documents.every(doc => store.acceptsDashboardProof(doc.token))).toBe(true);
    store.releaseDashboardProof(secondSocket);
    expect(store.issueDashboardProof()).toMatch(/^[0-9a-f]{64}$/);
    expect(store.acceptsDashboardProof(first.token)).toBe(false);
    expect(store.acceptsDashboardProof(documents[1]!.token)).toBe(true);
  });

  it('issues no proof when there is no credential', () => {
    const store = new TokenStore();
    expect(store.issueDashboardProof()).toBeNull();
    expect(store.acceptsDashboardProof(store.mintDashboardGrant())).toBe(false);
  });
});

describe('dashboard cookie header', () => {
  it('is HttpOnly, SameSite=Strict, Path=/, with no Max-Age, Secure or Domain', () => {
    const header = dashboardCookie('abc');
    expect(header.startsWith(`${DASHBOARD_COOKIE}=abc`)).toBe(true);
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict');
    expect(header).not.toMatch(/Max-Age|Expires|Secure|Domain/i);
  });

  it('reads a proof only from the sp-csrf subprotocol', () => {
    const proof = 'ab'.repeat(32);
    expect(dashboardProofFromProtocol(`sp-csrf.${proof}`)).toBe(proof);
    expect(dashboardProofFromProtocol(`sp-csrf.${proof} `)).toBeNull();
    expect(dashboardProofFromProtocol(proof)).toBeNull();
    expect(dashboardProofFromProtocol('sp-csrf.not-hex')).toBeNull();
    expect(dashboardProofFromProtocol(`sp-csrf.${proof.slice(0, 63)}`)).toBeNull();
  });
});

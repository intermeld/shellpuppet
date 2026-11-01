/**
 * Dashboard grant and the credential it becomes (design §4.1).
 *
 * One use, five minutes, not a session credential. Redeeming replaces whatever
 * credential was current and drops its proofs. The ring keeps the eight
 * newest proofs for the credential that is current.
 */

import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_COOKIE,
  DASHBOARD_PROOF_RING,
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
    expect(DASHBOARD_PROOF_RING).toBe(8);
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
    store.revokeDashboardGrant(spent);
    expect(store.verifyDashboardToken(redeemed?.token)).toBe(false);
    expect(store.acceptsDashboardProof(proof)).toBe(false);
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

  it('keeps the eight newest proofs and drops the oldest', () => {
    const store = new TokenStore();
    store.redeemDashboardGrant(store.mintDashboardGrant());
    const proofs: string[] = [];
    for (let i = 0; i < DASHBOARD_PROOF_RING + 1; i += 1) {
      const proof = store.issueDashboardProof();
      expect(proof).toMatch(/^[0-9a-f]{64}$/);
      proofs.push(proof ?? '');
    }
    expect(new Set(proofs).size).toBe(proofs.length);
    expect(store.acceptsDashboardProof(proofs[0])).toBe(false);
    expect(store.acceptsDashboardProof(proofs[1])).toBe(true);
    expect(store.acceptsDashboardProof(proofs[DASHBOARD_PROOF_RING])).toBe(true);
    // Equal-length and wrong: the compare hashes, it does not branch on length.
    const wrong = `${proofs[DASHBOARD_PROOF_RING]?.slice(0, 63)}0`;
    const flipped = wrong.endsWith('0') && proofs[DASHBOARD_PROOF_RING]?.endsWith('0')
      ? `${wrong.slice(0, 63)}1`
      : wrong;
    expect(flipped).toHaveLength(64);
    expect(store.acceptsDashboardProof(flipped)).toBe(false);
    expect(store.acceptsDashboardProof('')).toBe(false);
    expect(store.acceptsDashboardProof(undefined)).toBe(false);
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

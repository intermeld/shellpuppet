/**
 * The DevTools client behind screenshots shares the capture's deadline with
 * every call it makes (design §5), so a browser that accepts the connection
 * and then never answers, as a wedged renderer does, fails the capture at the
 * deadline rather than holding the agent's tool call open.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import {
  DEFAULT_CAPTURE_TIMEOUT_MS,
  DevTools,
  MAX_CAPTURE_TIMEOUT_MS,
  MIN_CAPTURE_TIMEOUT_MS,
} from '../../src/daemon/screenshot.js';

/** A socket that takes every message and answers none of them. */
class MuteSocket {
  readonly sent: string[] = [];
  on(): void {
    // Never fires anything: no answers, no close.
  }
  send(data: string): void {
    this.sent.push(data);
  }
}

describe('the capture budget', () => {
  it('leaves room for a cold browser start, which can take over 20 s', () => {
    // A capture that WORKED took 20.8 s on a cold Windows CI runner.
    expect(DEFAULT_CAPTURE_TIMEOUT_MS).toBe(45_000);
    expect(DEFAULT_CAPTURE_TIMEOUT_MS).toBeGreaterThan(21_000);
    // And a caller may move it, within bounds that keep it a budget.
    expect(MIN_CAPTURE_TIMEOUT_MS).toBeLessThan(DEFAULT_CAPTURE_TIMEOUT_MS);
    expect(MAX_CAPTURE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_CAPTURE_TIMEOUT_MS);
  });
});

describe('DevTools client deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a call the browser never answers once the deadline passes', async () => {
    vi.useFakeTimers();
    const socket = new MuteSocket();
    const cdp = new DevTools(socket as unknown as WebSocket, Date.now() + 500);
    const outcome = cdp
      .send('Page.navigate', { url: 'about:blank' })
      .then(() => 'answered', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(600);
    expect(await outcome).toContain('did not answer Page.navigate');
    expect(socket.sent).toHaveLength(1);
  });
});

/**
 * A port probe that is neither accepted nor refused within its bound counts as
 * accepted: something is there, and taking a running daemon for gone is the
 * mistake to avoid (design §2.3). A loopback connect settles within
 * milliseconds, so the socket here is one that never settles.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { portAccepts } from '../../src/daemon/liveness.js';

vi.mock('node:net', () => ({
  connect: () => {
    const socket = Object.assign(new EventEmitter(), {
      setTimeout(ms: number, onTimeout: () => void) {
        setTimeout(onTimeout, ms);
        return socket;
      },
      destroy() {
        return socket;
      },
    });
    return socket;
  },
}));

describe('a port probe that never settles', () => {
  it('counts as accepted once its bound has passed', async () => {
    await expect(portAccepts(4_242, 20)).resolves.toBe(true);
  });
});

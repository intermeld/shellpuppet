/**
 * The DevTools client behind screenshots shares the capture's deadline with
 * every call it makes (design §5), so a browser that accepts the connection
 * and then never answers, as a wedged renderer does, fails the capture at the
 * deadline rather than holding the agent's tool call open.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import {
  DEFAULT_CAPTURE_TIMEOUT_MS,
  DevTools,
  capturePageTarget,
  MAX_CAPTURE_TIMEOUT_MS,
  MIN_CAPTURE_TIMEOUT_MS,
} from '../../src/daemon/screenshot.js';

describe('capture page selection', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('waits for the initial page before creating another target', async () => {
    vi.useFakeTimers();
    const send = vi.fn((method: string): Promise<unknown> => {
      if (method !== 'Target.getTargets') throw new Error(`Unexpected ${method}`);
      return Promise.resolve({ targetInfos: send.mock.calls.length === 1 ? [] :
        [{ targetId: 'initial', type: 'page', url: 'about:blank' }] });
    });
    const selected = capturePageTarget({ send } as unknown as Pick<DevTools, 'send'>, Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(50);
    expect(await selected).toBe('initial');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('falls back to creating a page when the initial page never registers', async () => {
    vi.useFakeTimers();
    const send = vi.fn((method: string): Promise<unknown> => Promise.resolve(method === 'Target.getTargets'
      ? { targetInfos: [] } : { targetId: 'fallback' }));
    const selected = capturePageTarget({ send } as unknown as Pick<DevTools, 'send'>, Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await selected).toBe('fallback');
    expect(send.mock.calls.at(-1)?.[0]).toBe('Target.createTarget');
    expect(send.mock.calls.length).toBeGreaterThan(2);
  });

  it.each([undefined, {}, { targetInfos: null }, { targetInfos: 'invalid' },
    { targetInfos: [null, { type: 'page', url: 'about:blank' }] }])(
    'falls back when target discovery returns %j', async reply => {
      vi.useFakeTimers();
      const send = vi.fn((method: string): Promise<unknown> => Promise.resolve(method === 'Target.getTargets'
        ? reply : { targetId: 'fallback' }));
      const selected = capturePageTarget({ send } as unknown as Pick<DevTools, 'send'>, Date.now() + 5_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await selected).toBe('fallback');
      expect(send.mock.calls.at(-1)?.[0]).toBe('Target.createTarget');
    },
  );
});

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

  it('identifies a refused screenshot separately from an expired capture deadline', async () => {
    vi.useFakeTimers();
    const socket = Object.assign(new EventEmitter(), { send: vi.fn() });
    const cdp = new DevTools(socket as unknown as WebSocket, Date.now() + 30_000);
    const result = cdp.send('Page.captureScreenshot', { format: 'png' })
      .catch((error: unknown) => error as Error);
    await vi.advanceTimersByTimeAsync(195);
    const refusal = { code: -32000, message: 'Unable to capture screenshot', data: 'test capture refusal' };
    socket.emit('message', JSON.stringify({ id: 1, error: refusal }));
    const error = await result as Error;
    expect(error.message).toContain('Page.captureScreenshot returned a DevTools error after 195 ms');
    expect(error.message).toContain('29805 ms remaining');
    expect(error.message).toContain(JSON.stringify(refusal));
    expect(error.cause).toEqual(refusal);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

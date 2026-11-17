import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

describe('dashboard message refresh', () => {
  it('coalesces a burst and spaces fetch starts by 250 ms', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const source = readFileSync(new URL('../../src/viewer/dashboard.js', import.meta.url), 'utf8');
    const start = source.indexOf('function scheduleMessageRefresh()');
    const end = source.indexOf('\n  function openMessages', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const refresh = runInNewContext(`let messageDirty = false;
      let messageTimer = null;
      let messageFetching = false;
      let lastMessageFetch = 0;
      let messageRetryDelay = 0;
      let fetches = 0;
      function loadMessages() { messageTimer = null; messageDirty = false; lastMessageFetch = Date.now(); fetches++; }
      ${source.slice(start, end)}
      ({ scheduleMessageRefresh, get fetches() { return fetches; } })`,
    { setTimeout, Date }) as { scheduleMessageRefresh: () => void; fetches: number };
    for (let index = 0; index < 12; index++) refresh.scheduleMessageRefresh();
    await vi.runAllTimersAsync();
    expect(refresh.fetches).toBe(1);
    for (let index = 0; index < 12; index++) refresh.scheduleMessageRefresh();
    await vi.advanceTimersByTimeAsync(249);
    expect(refresh.fetches).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh.fetches).toBe(2);
  });

  it('retries a failed refresh with no further event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const source = readFileSync(new URL('../../src/viewer/dashboard.js', import.meta.url), 'utf8');
    const start = source.indexOf('  async function loadMessages()');
    const end = source.indexOf('\n  function openMessages', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const outcomes = [false, true];
    const refresh = runInNewContext(`let messageDirty = false;
      let messageTimer = null;
      let messageFetching = false;
      let lastMessageFetch = 0;
      let messageRetryDelay = 0;
      let messagingEnabled = false;
      let unreadCounts = {};
      let messageEntries = [];
      let messageGroups = [];
      let calls = 0;
      let counts = null;
      const proof = 'p';
      const panes = new Map();
      const messagesView = { hidden: true };
      function updateMessageBadge() {}
      function renderMessages() {}
      function showError() {}
      async function fetch() {
        calls++;
        if (!outcomes.shift()) throw new Error('offline');
        return { ok: true, json: async () => ({ enabled: true, counts: { s2: 1 } }) };
      }
      ${source.slice(start, end)}
      ({ scheduleMessageRefresh, get calls() { return calls; }, get counts() { return unreadCounts; } })`,
    { setTimeout, Date, outcomes }) as { scheduleMessageRefresh: () => void; calls: number; counts: Record<string, number> };
    refresh.scheduleMessageRefresh();
    await vi.advanceTimersByTimeAsync(300);
    expect(refresh.calls).toBe(1);
    expect(refresh.counts).toEqual({});
    await vi.advanceTimersByTimeAsync(1_200);
    expect(refresh.calls).toBe(2);
    expect(refresh.counts).toEqual({ s2: 1 });
  });
});

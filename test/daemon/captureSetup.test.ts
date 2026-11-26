import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { captureViewer } from '../../src/daemon/screenshot.js';

const commands: string[] = [];

// Announce a private DevTools endpoint using the same file as Chromium.
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: (_command: string, args: string[]) => {
    const profile = args.find(arg => arg.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
    writeFileSync(join(profile, 'DevToolsActivePort'), '1\n/devtools/browser/test');
    const child = new EventEmitter();
    return Object.assign(child, { exitCode: null, kill: () => child.emit('exit') });
  },
}));

// Only the navigation and interaction consume time. The socket never opens
// a network connection, so their deadlines can be tested on one clock.
vi.mock('ws', () => ({ default: class extends EventEmitter {
  constructor() { super(); queueMicrotask(() => this.emit('open')); }
  close() { this.emit('close'); }
  send(data: string) {
    const { id, method, params } = JSON.parse(data) as {
      id: number; method: string; params: { expression?: string };
    };
    commands.push(method);
    const delay = method === 'Page.navigate' ? 86_000 : params.expression === 'interaction' ? 8_000 : 0;
    setTimeout(() => this.emit('message', JSON.stringify({ id, result: {
      targetInfos: [{ targetId: 'page', type: 'page', url: 'about:blank' }],
      targetId: 'page', sessionId: 'session', result: { value: true },
    } })), delay);
  }
} }));

beforeEach(() => { commands.length = 0; vi.useFakeTimers({ now: 0 }); });
afterEach(() => { vi.useRealTimers(); });

it.each([
  { setupTimeoutMs: 45_000, completes: false },
  { setupTimeoutMs: 90_000, completes: true },
  { setupTimeoutMs: undefined, completes: false },
])('attributes a slow navigation with setup budget $setupTimeoutMs', async ({ setupTimeoutMs, completes }) => {
  const interact = vi.fn((page: { evaluate: (expression: string) => Promise<unknown> }) => page.evaluate('interaction'));
  const outcome = captureViewer({ browser: 'test', viewerUrl: 'about:blank', width: 800, height: 600,
    drive: true, probeOnly: true, probe: 'ready', interact, setupTimeoutMs, timeoutMs: 90_000 })
    .then(result => result.probe, (error: unknown) => String(error));
  await vi.advanceTimersByTimeAsync(100_000);
  expect(commands.indexOf('Page.bringToFront')).toBeGreaterThan(commands.indexOf('Page.enable'));
  expect(commands.indexOf('Page.bringToFront')).toBeLessThan(commands.indexOf('Page.navigate'));
  if (completes) {
    expect(await outcome).toBe(true);
    expect(interact).toHaveBeenCalledTimes(1);
  } else if (setupTimeoutMs !== undefined) {
    expect(await outcome).toContain('capture stage=page setup');
    expect(interact).not.toHaveBeenCalled();
  } else {
    expect(await outcome).toContain('capture stage=interaction');
    expect(interact).toHaveBeenCalledTimes(1);
  }
});

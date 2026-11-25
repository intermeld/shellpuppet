import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { monitorCapture } from '../integration/captureMonitor.js';
import { captureViewer, checkCaptureTransport } from '../integration/browserCapture.js';
import { captureViewer as capture } from '../../src/daemon/screenshot.js';

vi.mock('../../src/daemon/screenshot.js', () => ({ captureViewer: vi.fn() }));

it('keeps capture timing and page counts without exposing exception text, URLs or nested causes', async () => {
  const secret = 'private-capture-marker';
  const page = { paneCount: 2, streamCount: 3, openPaneStreams: ['ws://localhost/stream?grant=' + secret],
    errors: [secret], step: secret, pageMs: 1200 };
  vi.mocked(capture).mockRejectedValueOnce(new Error(
    `ENOENT /home/${secret}; capture stage=readiness probe, elapsedMs=1201, remainingMs=0, ` +
    `timings={"browserReadyMs":150}; dashboard diagnostics: ${JSON.stringify(page)}`, { cause: new Error(secret) }));
  const error: unknown = await captureViewer({ browser: 'test', viewerUrl: 'about:blank', width: 10, height: 10 })
    .catch((failure: unknown) => failure);
  if (!(error instanceof Error)) throw new Error('Expected a capture failure.');
  expect(error.cause === undefined && !error.message.includes(secret)).toBe(true);
  expect(error.message).toContain('"browserReadyMs":150');
  expect(error.message).toContain('"paneCount":2');
  expect(error.message).toContain('"openPaneStreams":1');
});

it('distinguishes an unanswered page from an unanswered readiness poll on a responsive page', () => {
  const timeout = 'DevTools did not answer Runtime.evaluate in time.; capture stage=readiness probe';
  expect(() => checkCaptureTransport(timeout + '; dashboard diagnostics: {"paneCount":1}')).not.toThrow();
  expect(() => checkCaptureTransport(timeout + '; dashboard diagnostics: page did not answer')).toThrow('runner stalled');
});

it('samples only the new profile and keeps the last matching browser reply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'capture-monitor-'));
  const previous = 'shellpuppet-capture-AAAAAA';
  const current = 'shellpuppet-capture-BBBBBB';
  mkdirSync(join(root, previous));
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/browser/test' }))
    .mockRejectedValueOnce(new Error('closed'));
  vi.stubGlobal('fetch', fetch);
  const monitor = monitorCapture(root);
  try {
    mkdirSync(join(root, current));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(monitor.details().status).toBe('no port file');
    expect(fetch).not.toHaveBeenCalled();
    writeFileSync(join(root, current, 'DevToolsActivePort'), '1234\n/devtools/browser/test\n');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:1234/json/version', expect.anything());
    expect(monitor.details()).toMatchObject({ profilesBefore: 1, status: 'browser answered', lastReplyMs: 10_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(monitor.details()).toMatchObject({ status: 'probe failed', lastReplyMs: 10_000 });
  } finally {
    await monitor.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
});

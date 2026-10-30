/**
 * A daemon whose viewer opens in its own window begins detecting the browser
 * as it starts (design §5), while its first client is waiting for `/health`
 * to answer. chrome-launcher's lookup is synchronous, and on macOS it took
 * 5.7 s and 9.7 s on CI runners: run on the daemon's event loop, it kept the
 * daemon from answering long enough for the client to give up on it. Here a
 * chrome-launcher whose lookup holds its thread for three seconds stands in
 * for that, on any platform, and the daemon must answer throughout.
 */

import { describe, expect, it, vi } from 'vitest';
import { findBrowser, resetBrowserCache } from '../../src/daemon/viewerLauncher.js';
import { startTestDaemon } from './helpers.js';

const lookup = vi.hoisted(() => ({ calls: 0 }));

vi.mock('chrome-launcher', () => ({
  Launcher: {
    getInstallations: (): string[] => {
      lookup.calls += 1;
      // Holds the calling thread, as a synchronous shell-out does.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3_000);
      return [];
    },
  },
}));

describe('browser detection at daemon start', () => {
  it('leaves the daemon answering /health while it runs', async () => {
    resetBrowserCache();
    // The test and an in-process daemon share one event loop, so a gap
    // between two answers is time the daemon could not answer in. The gaps
    // are measured from before the start, so a hold anywhere shows.
    const answered = [Date.now()];
    const td = await startTestDaemon({ viewer: { launchMode: 'isolated-app' } });
    try {
      while (Date.now() - answered[0]! < 5_000) {
        const response = await fetch(`http://127.0.0.1:${String(td.port)}/health`, {
          signal: AbortSignal.timeout(10_000),
        });
        expect(response.ok).toBe(true);
        answered.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const gaps = answered.slice(1).map((at, i) => at - answered[i]!);
      expect(Math.max(...gaps)).toBeLessThan(1_000);
      // Detection finishes, and the daemon never ran the lookup itself.
      await findBrowser();
      expect(lookup.calls).toBe(0);
    } finally {
      await td.stop();
    }
  }, 30_000);
});

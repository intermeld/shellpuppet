import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_VIEWER_LAUNCH_MODE } from '../../src/daemon/config.js';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const running: TestDaemon[] = [];
afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
});

const startBody = {
  command: process.execPath,
  args: ['-e', 'setInterval(() => {}, 200)'],
  shell: false,
};

async function start(daemon: TestDaemon) {
  return api(daemon.port, daemon.token, '/sessions', { body: startBody });
}

describe('automatic dashboard launch', () => {
  it('opens one dashboard for consecutive and concurrent starts before its socket connects', async () => {
    const urls: string[] = [];
    const daemon = await startTestDaemon({
      viewer: { launchMode: DEFAULT_VIEWER_LAUNCH_MODE },
      launcher: (url) => {
        urls.push(url);
        return Promise.resolve({ launched: true, mode: 'isolated-app' as const });
      },
    });
    running.push(daemon);
    const first = await start(daemon);
    expect(first.status).toBe(200);
    expect(first.body['viewer']).toMatchObject({ opened: true, mode: 'dashboard' });
    expect(first.body['viewerUrl']).toBeUndefined();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/dashboard?dt=');
    const later = await Promise.all([start(daemon), start(daemon), start(daemon)]);
    expect(later.every((result) => result.status === 200)).toBe(true);
    expect(later.every((result) => result.body['viewerUrl'] === undefined)).toBe(true);
    expect(later.every((result) => (result.body['viewer'] as { mode: string }).mode === 'dashboard')).toBe(true);
    expect(urls).toHaveLength(1);
  });

  it('revokes a failed dashboard grant and hands over a viewer link without failing the start', async () => {
    const urls: string[] = [];
    const daemon = await startTestDaemon({
      viewer: { launchMode: 'dashboard' },
      launcher: (url) => {
        urls.push(url);
        return Promise.resolve({ launched: false, mode: 'no-window' as const, reason: 'missing browser' });
      },
    });
    running.push(daemon);
    const result = await start(daemon);
    expect(result.status).toBe(200);
    expect(result.body['viewer']).toMatchObject({ opened: false, mode: 'dashboard' });
    expect(String(result.body['viewerUrl'])).toContain('/view?s=');
    expect(urls[0]).toContain('/dashboard?dt=');
    const grantUrl = new URL(urls[0] ?? '');
    const page = await fetch(grantUrl, {
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' },
    });
    expect(page.headers.get('set-cookie')).toBeNull();
    expect(JSON.stringify(result.body)).not.toContain('dt=');
  });

  it('opens only one dashboard for starts racing while launch is pending', async () => {
    const urls: string[] = [];
    let finishLaunch: (() => void) | undefined;
    const launcherReady = new Promise<void>((resolve) => { finishLaunch = resolve; });
    const daemon = await startTestDaemon({
      viewer: { launchMode: 'dashboard' },
      launcher: async (url) => {
        urls.push(url);
        await launcherReady;
        return { launched: true, mode: 'isolated-app' as const };
      },
    });
    running.push(daemon);
    const starts = [start(daemon), start(daemon), start(daemon)];
    await new Promise((resolve) => setTimeout(resolve, 100));
    finishLaunch?.();
    const results = await Promise.all(starts);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect(results.filter((result) => (result.body['viewer'] as { opened: boolean }).opened)).toHaveLength(1);
    expect(urls).toHaveLength(1);
  });

  it('keeps isolated-app and no-window behaviour', async () => {
    const urls: string[] = [];
    const isolated = await startTestDaemon({
      viewer: { launchMode: 'isolated-app' },
      launcher: (url) => {
        urls.push(url);
        return Promise.resolve({ launched: true, mode: 'isolated-app' as const });
      },
    });
    running.push(isolated);
    const opened = await start(isolated);
    expect(opened.body['viewer']).toMatchObject({ opened: true, mode: 'isolated-app' });
    expect(urls[0]).toContain('/view?s=');
    const noWindow = await startTestDaemon({ viewer: { launchMode: 'no-window' } });
    running.push(noWindow);
    const quiet = await start(noWindow);
    expect(quiet.body['viewer']).toMatchObject({ opened: false, mode: 'no-window' });
    expect(String(quiet.body['viewerUrl'])).toContain('/view?s=');
  });
});

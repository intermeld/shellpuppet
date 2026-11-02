import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { TokenStore } from '../../src/daemon/auth.js';
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

function navigate(daemon: TestDaemon, requestPath: string): Promise<http.IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: daemon.port, path: requestPath,
      headers: {
        host: `127.0.0.1:${String(daemon.port)}`,
        'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none',
      },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.headers)); });
    req.on('error', reject);
    req.end();
  });
}

function connectDashboard(daemon: TestDaemon, url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const page = await navigate(daemon, new URL(url).pathname + new URL(url).search);
      const cookie = String(page['set-cookie']?.[0] ?? '').split(';')[0];
      const document = await new Promise<string>((resolvePage, rejectPage) => {
        const req = http.request({
          host: '127.0.0.1', port: daemon.port, path: '/dashboard',
          headers: { host: `127.0.0.1:${String(daemon.port)}`, cookie,
            'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' },
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolvePage(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', rejectPage);
        req.end();
      });
      const proof = /<meta name="sp-csrf" content="([^"]*)">/.exec(document)?.[1] ?? '';
      const ws = new WebSocket(`ws://127.0.0.1:${String(daemon.port)}/dashboard/events`, [`sp-csrf.${proof}`], {
        headers: { host: `127.0.0.1:${String(daemon.port)}`, origin: `http://127.0.0.1:${String(daemon.port)}`,
          cookie, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'websocket' },
      });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    })().catch(reject);
  });
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
    const page = await navigate(daemon, grantUrl.pathname + grantUrl.search);
    expect(page['set-cookie']).toBeUndefined();
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

  it('retries after 30 seconds without a dashboard connection', async () => {
    const clock = { now: 1_700_000_000_000 };
    const urls: string[] = [];
    const daemon = await startTestDaemon({
      viewer: { launchMode: 'dashboard' }, now: () => clock.now,
      launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app' as const }); },
    });
    running.push(daemon);
    expect((await start(daemon)).body['viewer']).toMatchObject({ opened: true, mode: 'dashboard' });
    clock.now += 29_999;
    expect((await start(daemon)).body['viewer']).toMatchObject({ opened: false, reason: 'a dashboard window is opening' });
    expect(urls).toHaveLength(1);
    clock.now += 1;
    expect((await start(daemon)).body['viewer']).toMatchObject({ opened: true, mode: 'dashboard' });
    expect(urls).toHaveLength(2);
  });

  it('opens another dashboard after the connected socket closes', async () => {
    const urls: string[] = [];
    const daemon = await startTestDaemon({
      viewer: { launchMode: 'dashboard' },
      launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app' as const }); },
    });
    running.push(daemon);
    await start(daemon);
    const ws = await connectDashboard(daemon, urls[0] ?? '');
    expect((await start(daemon)).body['viewer']).toMatchObject({ opened: false, reason: 'a dashboard is connected' });
    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await start(daemon)).body['viewer']).toMatchObject({ opened: true, mode: 'dashboard' });
    expect(urls).toHaveLength(2);
  });

  it('settles shutdown after a pending launch and opens no window afterwards', async () => {
    const urls: string[] = [];
    let finishLaunch: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { finishLaunch = resolve; });
    const daemon = await startTestDaemon({
      viewer: { launchMode: 'dashboard' },
      launcher: async (url) => { urls.push(url); await pending; return { launched: true, mode: 'isolated-app' as const }; },
    });
    running.push(daemon);
    const request = start(daemon).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(urls).toHaveLength(1);
    const stopped = daemon.daemon.stop();
    finishLaunch?.();
    await stopped;
    await request;
    expect(urls).toHaveLength(1);
    const grant = new URL(urls[0] ?? '').searchParams.get('dt');
    const tokens = (daemon.daemon as unknown as { tokens: TokenStore }).tokens;
    expect(tokens.redeemDashboardGrant(grant)).toBeNull();
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

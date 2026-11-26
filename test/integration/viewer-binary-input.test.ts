import * as fs from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { auditLogPath, createAuditor } from '../../src/daemon/audit.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { captureViewer } from './browserCapture.js';
import { captureDashboard } from './dashboardCapture.js';
import { api, connectWs, connectWsWithCookie, eventually, makeTempHome, redeemViewerUrl,
  startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let testDaemon: TestDaemon;
let launchedDashboard = '';
const browser = await findBrowser();

beforeAll(async () => {
  const home = makeTempHome('viewer-binary-input-');
  testDaemon = await startTestDaemon({ home, audit: createAuditor(home, { captureContent: true }),
    launcher: url => {
      launchedDashboard = url;
      return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' });
    } });
});

afterAll(async () => { await testDaemon.stop(); }, 90_000);

it('writes a binary mouse frame byte-exactly and audits only a whole report', async () => {
  const program = [
    'process.stdin.setRawMode?.(true); process.stdin.resume();',
    'let input = Buffer.alloc(0);',
    "process.stdin.on('data', bytes => { input = Buffer.concat([input, bytes]);",
    "process.stdout.write('BYTES:' + input.toString('hex') + '\\r\\n'); });",
    "process.stdout.write('READY\\r\\n');",
  ].join(' ');
  const started = await api(testDaemon.port, testDaemon.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', program], shell: false, openViewer: false,
    cols: 120, rows: 24, hold: true,
  } });
  expect(started.status).toBe(200);
  const id = String(started.body['id']);
  const writer = await connectWs(testDaemon.port, id, testDaemon.token);
  try {
    await writer.waitForData('READY');
    const minted = await api(testDaemon.port, testDaemon.token, `/sessions/${id}/viewer`, {
      body: { readOnly: true },
    });
    const watcher = await connectWsWithCookie(testDaemon.port, id,
      await redeemViewerUrl(String(minted.body['viewerUrl'])));
    try {
      await watcher.waitForControl(c => c['type'] === 'identity');
      watcher.ws.send(Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0x84, 0x25]));
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(writer.received()).not.toContain('BYTES:');

      writer.ws.send(Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0x84, 0x25]));
      await writer.waitForData('BYTES:');
      // ConPTY's input pipe is UTF-8, so Windows replaces the invalid 0x84
      // before the child sees it. On a Unix PTY the child sees the raw byte.
      const childBytes = process.platform === 'win32' ? '1b5b4d20efbfbd25' : '1b5b4d208425';
      expect(writer.received(), writer.received().slice(-300)).toContain(`BYTES:${childBytes}`);
      await eventually(() => {
        const entries = fs.readFileSync(auditLogPath(testDaemon.home), 'utf8')
          .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
        return entries.some(entry => entry['session'] === id && entry['action'] === 'report' &&
          (entry['meta'] as Record<string, unknown>)['kind'] === 'mouse');
      }, 5000, 50, 'the mouse report audit');
      const entries = fs.readFileSync(auditLogPath(testDaemon.home), 'utf8')
        .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
      const reports = entries.filter(entry => entry['session'] === id && entry['action'] === 'report' &&
        (entry['meta'] as Record<string, unknown>)['kind'] === 'mouse');
      expect(reports).toHaveLength(1);
      expect(reports[0]?.['meta']).toMatchObject({ kind: 'mouse', chars: 6,
        data: Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0x84, 0x25]).toString('latin1') });
      expect(writer.controls().filter(c => c['type'] === 'input-source' && c['source'] === 'human'))
        .toHaveLength(0);
      writer.ws.send(Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0x84]));
      await writer.waitForControl(c => c['type'] === 'input-source' && c['source'] === 'human');
      const afterNearMatch = fs.readFileSync(auditLogPath(testDaemon.home), 'utf8')
        .split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
      expect(afterNearMatch.filter(entry => entry['session'] === id && entry['action'] === 'report' &&
        (entry['meta'] as Record<string, unknown>)['kind'] === 'mouse')).toHaveLength(1);
      expect(afterNearMatch.some(entry => entry['session'] === id && entry['action'] === 'input' &&
        (entry['meta'] as Record<string, unknown>)['chars'] === 5)).toBe(true);
    } finally { watcher.close(); }
  } finally { writer.close(); }
}, 60_000);

it.skipIf(!browser)('delivers default mouse clicks above column 95 in viewer and dashboard', async () => {
  const program = [
    'process.stdin.setRawMode?.(true); process.stdin.resume();',
    'let pending = Buffer.alloc(0);',
    "process.stdin.on('data', chunk => { pending = Buffer.concat([pending, chunk]);",
    "process.stdout.write('BYTES:' + pending.toString('hex') + '\\r\\n'); });",
    "process.stdout.write('\\x1b[?1000hREADY\\r\\n');",
  ].join(' ');
  const started = await api(testDaemon.port, testDaemon.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', program], shell: false, openViewer: false,
    cols: 120, rows: 24, hold: true,
  } });
  expect(started.status).toBe(200);
  const id = String(started.body['id']);
  const observer = await connectWs(testDaemon.port, id, testDaemon.token);
  try {
    await observer.waitForData('READY');
    const click = async (viewerUrl: string, dashboard: boolean, occurrence: number): Promise<void> => {
      const options = { browser: browser!, viewerUrl, drive: true, probeOnly: true,
        width: 1500, height: 700, setupTimeoutMs: 60_000, timeoutMs: 60_000,
        beforeNavigateScript: `window.mouseFrames = [];
          const originalSend = WebSocket.prototype.send;
          WebSocket.prototype.send = function(data) {
            if (data instanceof Uint8Array) window.mouseFrames.push(Array.from(data));
            return originalSend.call(this, data);
          };
          let panes;
          Object.defineProperty(window, 'ShellPuppetPane', { get: () => panes, set: implementation => {
            panes = { ...implementation, create(config) {
              const pane = implementation.create(config);
              if (config.sessionId === ${JSON.stringify(id)}) window.mouseTerm = pane.getTerminal();
              return pane;
            } };
          } });`,
        probe: "window.mouseTerm && document.querySelector('.xterm-rows')?.textContent.includes('READY')",
        interact: async ({ evaluate, send }: { evaluate: (expression: string) => Promise<unknown>;
          send: (method: string, params?: Record<string, unknown>) => Promise<unknown> }) => {
          const grid = await evaluate(`(() => {
            const term = window.mouseTerm;
            const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
            return { left: r.left, top: r.top, width: r.width / term.cols, height: r.height / term.rows,
              cols: term.cols, mode: term.modes.mouseTrackingMode };
          })()`) as { left: number; top: number; width: number; height: number; cols: number; mode: string };
          expect(grid.cols).toBe(120);
          expect(grid.mode).not.toBe('none');
          const point = { x: grid.left + 99.2 * grid.width, y: grid.top + 4.5 * grid.height,
            button: 'left', clickCount: 1 };
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, buttons: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, buttons: 0 });
          const frames = await evaluate('window.mouseFrames') as number[][];
          expect(frames).toContainEqual([0x1b, 0x5b, 0x4d, 0x20, 0x84, 0x25]);
          const expected = process.platform === 'win32' ? '1b5b4d20efbfbd25' : '1b5b4d208425';
          await eventually(() => {
            const output = observer.received();
            const last = output.lastIndexOf('BYTES:');
            return last >= 0 && output.slice(last).split(expected).length - 1 >= occurrence;
          }, 10_000, 50, 'the default mouse press in the programme input');
          return true;
        },
      };
      if (dashboard) await captureDashboard(options);
      else await captureViewer(options);
    };

    const grant = await api(testDaemon.port, testDaemon.token, `/sessions/${id}/viewer`, { body: {} });
    await click(String(grant.body['viewerUrl']), false, 1);
    const opened = await api(testDaemon.port, testDaemon.token, '/dashboard/open', { method: 'POST', body: {} });
    expect(opened.status).toBe(200);
    expect(launchedDashboard).not.toBe('');
    await click(launchedDashboard, true, 2);
  } finally { observer.close(); }
}, 180_000);

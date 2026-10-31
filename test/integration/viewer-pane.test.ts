/** Two terminal clients keep their frames, badges and input in separate panes. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureViewer } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let td: TestDaemon;
let browser: string | null;

beforeAll(async () => {
  td = await startTestDaemon();
  browser = await findBrowser();
}, 60_000);

afterAll(async () => {
  await td.stop();
}, 60_000);

describe('shared pane client in a browser', () => {
  it('routes two sessions into two containers independently', async (context) => {
    if (browser === null) {
      context.skip();
      return;
    }
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);

    // The real page loads pane.js. Two additional panes use small socket
    // doubles, so the test can deliver separate session frames without a
    // dashboard credential or another page changing the viewer cookie.
    const capture = await captureViewer({
      browser,
      viewerUrl: String(started.body['viewerUrl']),
      width: 900,
      height: 600,
      timeoutMs: 90_000,
      probe: `(() => {
        // Wait for the real viewer to load pane.js and paint before the doubles
        // replace WebSocket, so the page's own stream is never one of them.
        if (!window.__paneProbe && (!window.ShellPuppetPane || window.__shellpuppetPainted !== true)) return null;
        if (!window.__paneProbe) {
          const NativeSocket = window.WebSocket;
          const sockets = [];
          class Socket {
            constructor(url) { this.url = url; this.readyState = 1; this.sent = []; sockets.push(this); }
            send(data) { this.sent.push(data); }
            close() { this.readyState = 3; if (this.onclose) this.onclose(); }
          }
          window.WebSocket = Socket;
          const make = (id) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'width:400px;height:250px;position:fixed;left:0;top:0;';
            const container = document.createElement('div');
            const purpose = document.createElement('span');
            const size = document.createElement('span');
            const readonly = document.createElement('button');
            wrap.append(container, purpose, size, readonly);
            document.body.append(wrap);
            const pane = window.ShellPuppetPane.create({
              container, sessionId: id, initialFontOverride: 13,
              elements: { identityPurpose: purpose, size, readonly },
            });
            const socket = sockets[sockets.length - 1];
            socket.onopen();
            socket.onmessage({ data: JSON.stringify({
              type: 'identity', session: id, purpose: id + ' purpose',
            }) });
            socket.onmessage({ data: JSON.stringify({
              type: 'geometry', cols: 80, rows: 24, control: 'held',
              max: { cols: 400, rows: 150 },
            }) });
            socket.onmessage({ data: new TextEncoder().encode(id + ' screen').buffer });
            return { pane, socket, purpose, size, wrap };
          };
          const first = make('first');
          const second = make('second');
          window.WebSocket = NativeSocket;
          first.pane.setReadOnly(true);
          first.pane.getTerminal().input('blocked', true);
          second.pane.getTerminal().input('second-key', true);
          window.__paneProbe = { first, second, NativeSocket };
        }
        const { first, second } = window.__paneProbe;
        const line = (pane) => pane.getTerminal().buffer.active.getLine(0)?.translateToString();
        if (!line(first.pane)?.includes('first screen') ||
            !line(second.pane)?.includes('second screen')) return null;
        const result = {
          firstUrl: first.socket.url, secondUrl: second.socket.url,
          firstPurpose: first.purpose.textContent, secondPurpose: second.purpose.textContent,
          firstLine: line(first.pane), secondLine: line(second.pane),
          firstSent: first.socket.sent, secondSent: second.socket.sent,
          firstReadOnly: first.pane.isReadOnly(), secondReadOnly: second.pane.isReadOnly(),
          firstSize: first.size.textContent, secondSize: second.size.textContent,
        };
        first.pane.destroy(); second.pane.destroy();
        first.wrap.remove(); second.wrap.remove();
        return JSON.stringify(result);
      })()`,
    });
    const result = JSON.parse(String(capture.probe)) as Record<string, unknown>;
    expect(result['firstUrl']).toContain('/sessions/first/stream');
    expect(result['secondUrl']).toContain('/sessions/second/stream');
    expect(result['firstPurpose']).toBe('first purpose');
    expect(result['secondPurpose']).toBe('second purpose');
    expect(result['firstLine']).toContain('first screen');
    expect(result['secondLine']).toContain('second screen');
    expect(result['firstSent']).toEqual([]);
    expect(result['secondSent']).toEqual(['second-key']);
    expect(result['firstReadOnly']).toBe(true);
    expect(result['secondReadOnly']).toBe(false);
    expect(result['firstSize']).toBe('80×24 (fixed)');
    expect(result['secondSize']).toBe('80×24 (fixed)');
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  }, 120_000);
});

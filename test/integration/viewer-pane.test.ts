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
  it('pastes Ctrl+V through xterm, blocks it in read-only mode, and copies selected text with Ctrl+C', async (context) => {
    if (browser === null || process.platform === 'darwin') { context.skip(); return; }
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const capture = await captureViewer({
      browser, viewerUrl: String(started.body['viewerUrl']), width: 900, height: 600, timeoutMs: 90_000,
      probe: `(() => {
        if (!window.__shellpuppetPainted || !window.ShellPuppetPane) return null;
        if (!window.__pasteProbe) {
          const NativeSocket = window.WebSocket;
          const sockets = [];
          class Socket {
            constructor() { this.readyState = 1; this.sent = []; sockets.push(this); }
            send(data) { this.sent.push(data); }
            close() { this.readyState = 3; }
          }
          window.WebSocket = Socket;
          const make = (name) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'width:400px;height:250px;position:fixed;left:0;top:0';
            const container = document.createElement('div');
            wrap.append(container); document.body.append(wrap);
            const pane = window.ShellPuppetPane.create({ container, sessionId: name });
            const socket = sockets.at(-1);
            socket.onopen();
            socket.onmessage({ data: JSON.stringify({ type: 'identity', session: name }) });
            socket.onmessage({ data: JSON.stringify({ type: 'geometry', cols: 80, rows: 24,
              control: 'held', max: { cols: 400, rows: 150 } }) });
            return { wrap, pane, socket, area: container.querySelector('textarea') };
          };
          const writable = make('paste-writable');
          const readonly = make('paste-readonly');
          window.WebSocket = NativeSocket;
          readonly.pane.setReadOnly(true);
          const state = window.__pasteProbe = { writable, readonly, ready: false };
          // Wait for xterm to process the program's bracketed-paste request.
          writable.socket.onmessage({ data: new TextEncoder().encode(String.fromCharCode(27) + '[?2004hcopy me').buffer });
          writable.pane.getTerminal().write('', () => { state.ready = true; });
          return null;
        }
        const { writable, readonly, ready } = window.__pasteProbe;
        if (!ready) return null;
        const press = (target, key, code, keyCode) => {
          const event = new KeyboardEvent('keydown', { key, code, ctrlKey: true,
            bubbles: true, cancelable: true });
          Object.defineProperty(event, 'keyCode', { get: () => keyCode });
          Object.defineProperty(event, 'which', { get: () => keyCode });
          target.dispatchEvent(event);
          return event.defaultPrevented;
        };
        const paste = (target, text) => {
          const data = new DataTransfer(); data.setData('text/plain', text);
          target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: data }));
        };
        const pastePrevented = press(writable.area, 'v', 'KeyV', 86);
        if (!pastePrevented) paste(writable.area, 'dictated text');
        const readonlyPrevented = press(readonly.area, 'v', 'KeyV', 86);
        if (!readonlyPrevented) paste(readonly.area, 'blocked text');
        const interruptPrevented = press(writable.area, 'c', 'KeyC', 67);
        const term = writable.pane.getTerminal();
        term.select(0, 0, 4);
        const copyPrevented = press(writable.area, 'c', 'KeyC', 67);
        const copied = new DataTransfer();
        if (!copyPrevented) writable.area.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData: copied }));
        const result = { pastePrevented, readonlyPrevented, interruptPrevented, copyPrevented,
          copied: copied.getData('text/plain'), writableSent: writable.socket.sent,
          readonlySent: readonly.socket.sent, hasSelection: term.hasSelection() };
        writable.pane.destroy(); readonly.pane.destroy(); writable.wrap.remove(); readonly.wrap.remove();
        return JSON.stringify(result);
      })()`,
    });
    const result = JSON.parse(String(capture.probe)) as {
      pastePrevented: boolean; readonlyPrevented: boolean; interruptPrevented: boolean;
      copyPrevented: boolean; copied: string; writableSent: string[]; readonlySent: string[];
      hasSelection: boolean;
    };
    expect(result.pastePrevented).toBe(false);
    expect(result.readonlyPrevented).toBe(false);
    expect(result.writableSent).toEqual(['\x1b[200~dictated text\x1b[201~', '\x03']);
    expect(result.readonlySent).toEqual([]);
    expect(result.interruptPrevented).toBe(true);
    expect(result.hasSelection).toBe(true);
    expect(result.copyPrevented).toBe(false);
    expect(result.copied).toBe('copy');
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  }, 120_000);

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

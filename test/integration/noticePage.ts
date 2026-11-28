import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { CaptureOptions } from '../../src/daemon/screenshot.js';
import type { FeedSummary } from '../../src/daemon/sessionFeed.js';
import { captureViewer } from './browserCapture.js';
import { api, eventually, startTestDaemon } from './helpers.js';

export type NoticePage = Parameters<NonNullable<CaptureOptions['interact']>>[0];
const fixture = fileURLToPath(new URL('../fixtures/notice-repaint-tui.mjs', import.meta.url));

// Observe the public stream and the real pane. Each socket still talks to the test daemon.
export const observeNotices = `(() => {
  localStorage.setItem('shellpuppet.dashboard', JSON.stringify({ autoFit: false, mode: 'grid' }));
  window.streams = new Map();
  window.terminals = new Map();
  window.paneClients = new Map();
  window.WebSocket = class extends WebSocket {
    constructor(...args) {
      super(...args);
      const id = new URL(this.url).pathname.match(/^\\/sessions\\/([^/]+)\\/stream$/)?.[1];
      if (!id) return;
      this.sent = [];
      streams.set(id, this);
      // Register after the pane installs onopen, before any replay frame can arrive.
      queueMicrotask(() => this.addEventListener('open', () => window.afterNoticeOpen?.(id, this), { once: true }));
      this.addEventListener('message', event => {
        if (typeof event.data === 'string') {
          const frame = JSON.parse(event.data);
          if (frame.type === 'prompt-stall') this.prompt = frame;
        }
      });
    }
    send(data) {
      this.sent?.push(data);
      return super.send(data);
    }
  };
  let implementation;
  Object.defineProperty(window, 'ShellPuppetPane', {
    get: () => implementation,
    set: value => { implementation = { ...value, create(config) {
      const pane = value.create(config);
      terminals.set(config.sessionId, pane.getTerminal());
      paneClients.set(config.sessionId, pane);
      return pane;
    } }; }
  });
  window.parts = (id) => {
    const root = document.querySelector('[data-session="' + id + '"]') || document;
    const button = root.querySelector('.prompt-toggle');
    const alert = document.getElementById(button.getAttribute('aria-controls'));
    const stack = root.querySelector('#notices, .pane-notices');
    return { root, button, alert, stack, term: terminals.get(id), socket: streams.get(id) };
  };
})()`;

export async function withNoticePage(browser: string, mode: string,
  interact: (page: NoticePage, ids: string[], input: (key: string) => Promise<void>, listSessions: () => Promise<FeedSummary[]>) => Promise<unknown>,
  { count = 1, rows = 24, before = '' } = {}) {
  let dashboardUrl: string | undefined;
  const td = await startTestDaemon({ promptScanIntervalMs: 100, promptStallMs: 300,
    launcher: url => {
      dashboardUrl = url;
      return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' });
    },
  });
  try {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const started = await api(td.port, td.token, '/sessions', { body: {
        command: process.execPath, args: [fixture, String(rows)], cols: 80, rows,
        shell: false, hold: true, openViewer: false,
      } });
      expect(started.status).toBe(200);
      ids.push(String(started.body['id']));
    }
    const id = ids[0]!;
    const listSessions = async () => {
      const { body } = await api(td.port, td.token, '/sessions');
      return body['sessions'] as FeedSummary[];
    };
    await eventually(async () => (await listSessions()).filter(session => session.waitingOnPrompt?.alerted).length === count,
      30_000, 100, 'all test prompts waiting before attachment');
    if (mode === 'dashboard') {
      expect((await api(td.port, td.token, '/dashboard/open', { body: {} })).status).toBe(200);
    } else {
      const minted = await api(td.port, td.token, `/sessions/${id}/viewer`, { body: {} });
      dashboardUrl = String(minted.body['viewerUrl']);
    }
    const input = async (key: string) => {
      expect((await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: key } })).status).toBe(200);
    };
    let interactionTimeout: string | undefined;
    const result = await captureViewer({ browser, viewerUrl: dashboardUrl!, width: 860, height: 650,
      drive: true, probeOnly: true, setupTimeoutMs: 90_000, timeoutMs: 90_000,
      beforeNavigateScript: observeNotices + ';' + before,
      probe: `${JSON.stringify(ids)}.every(id => terminals.has(id) && streams.get(id)?.prompt && !parts(id).button.hidden)`,
      failureFacts: () => ({ interactionTimeout }),
      interact: async page => {
        try { return await interact(page, ids, input, listSessions); }
        catch (error) {
          if (error instanceof Error && error.message.startsWith('Timed out waiting for ')) interactionTimeout = error.message;
          throw error;
        }
      },
    });
    return result.probe;
  } finally { await td.stop(); }
}

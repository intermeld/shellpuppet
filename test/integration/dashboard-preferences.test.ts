import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

const running: TestDaemon[] = [];
let browser: string | null = null;
const FIT_SETTLE_MS = 3000 + 250 + 100;

beforeAll(async () => { browser = await findBrowser(); }, 60_000);
afterEach(async () => { for (const daemon of running.splice(0)) await daemon.stop(); }, 120_000);

async function setup(fontSize?: number) {
  const urls: string[] = [];
  const daemon = await startTestDaemon({
    ...(fontSize === undefined ? {} : { dashboardFontSize: fontSize }),
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  running.push(daemon);
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const started = await api(daemon.port, daemon.token, '/sessions', {
      body: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
        openViewer: false, cols: 100, rows: 30 },
    });
    expect(started.status).toBe(200);
    ids.push(String(started.body['id']));
  }
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  return { daemon, ids, url: urls.at(-1) ?? '' };
}

const sentScript = `(() => {
  window.__resizes = [];
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    if (typeof data === 'string' && data.includes('"type":"resize"'))
      window.__resizes.push({ url: this.url, frame: JSON.parse(data) });
    return send.call(this, data);
  };
})()`;

async function page(url: string, script = sentScript) {
  if (!browser) throw new Error('No headless Chromium browser');
  return captureDashboard({ browser, viewerUrl: url, width: 1920, height: 1080, drive: true,
    beforeNavigateScript: script, timeoutMs: 120_000,
    probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
      document.querySelectorAll('.pane-size').length === 2 &&
      [...document.querySelectorAll('.pane-size')].every(x => x.textContent.includes('×')) ? true : null)()`,
    interact: async ({ evaluate }) => evaluate(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      return window.__dashboardTest();
    })()`),
  });
}

describe('dashboard preferences and errors', () => {
  it('restores Auto fit and text size after a page reload', async (context) => {
    if (!browser) { context.skip(); return; }
    const { url } = await setup(17);
    const shot = await captureDashboard({ browser, viewerUrl: url, width: 1920, height: 1080,
      drive: true, timeoutMs: 120_000,
      probe: `(() => {
        if (document.getElementById('connection')?.textContent !== 'Connected' ||
            document.querySelectorAll('.pane-term').length !== 2 ||
            [...document.querySelectorAll('.pane-term')].some(x => !x.dataset.fontSize)) return null;
        if (!localStorage.getItem('dashboard-preferences-reloaded')) {
          document.getElementById('auto-fit').click();
          document.getElementById('text-larger').click();
          localStorage.setItem('dashboard-preferences-reloaded', '1');
          location.reload();
          return null;
        }
        return { pressed: document.getElementById('auto-fit').getAttribute('aria-pressed'),
          remembered: JSON.parse(localStorage.getItem('shellpuppet.dashboard')).fontSize,
          panes: [...document.querySelectorAll('.pane-term')].map(term => {
            const tile = term.getBoundingClientRect();
            const screen = term.querySelector('.xterm-screen').getBoundingClientRect();
            return { font: Number(term.dataset.fontSize), fits: screen.width <= tile.width + 2 &&
              screen.height <= tile.height + 2 };
          }) };
      })()`,
    });
    const result = shot.probe as { pressed: string; remembered: number; panes: { font: number; fits: boolean }[] };
    expect(result.pressed).toBe('false');
    expect(result.remembered).toBe(18);
    expect(result.panes).toHaveLength(2);
    expect(result.panes.every(pane => pane.font >= 6 && pane.font <= 18 && pane.fits)).toBe(true);
  });

  it('auto fits layout changes once, honours the floor and a held grid, and off sends no resize', async (context) => {
    if (!browser) { context.skip(); return; }
    const { daemon, ids, url } = await setup();
    const held = await api(daemon.port, daemon.token, `/sessions/${ids[1]}/resize`,
      { body: { cols: 100, rows: 30, hold: true } });
    expect(held.status).toBe(200);
    const script = `${sentScript}; window.__dashboardTest = async () => {
      const waitFor = async (step, read, ready) => {
        let last;
        const started = Date.now();
        while (Date.now() - started < 5000) {
          last = read();
          if (ready(last)) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Timed out waiting for ' + step + '; last observed: ' + JSON.stringify(last));
      };
      const toggle = document.getElementById('auto-fit');
      const initial = toggle?.getAttribute('aria-pressed');
      window.__resizes.length = 0;
      document.getElementById('focus').click();
      await waitFor('the Focus pane take', () => ({
        active: document.getElementById('focus').classList.contains('active'),
        resizes: window.__resizes.slice(),
      }), state => state.active && state.resizes.some(frame => frame.url.includes(${JSON.stringify(ids[0])}) && frame.frame.take));
      await new Promise(resolve => setTimeout(resolve, ${FIT_SETTLE_MS}));
      const on = window.__resizes.slice();
      toggle.click();
      window.__resizes.length = 0;
      document.getElementById('grid').click();
      await waitFor('the settled Grid layout', () => ({
        active: document.getElementById('grid').classList.contains('active'),
        panes: [...document.querySelectorAll('.pane')].map(pane => pane.getBoundingClientRect().width),
      }), state => state.active && state.panes.length === 2 && state.panes.every(width => width > 0));
      await new Promise(resolve => setTimeout(resolve, ${FIT_SETTLE_MS}));
      const off = window.__resizes.slice();
      return { initial, on, off, saved: JSON.parse(localStorage.getItem('shellpuppet.dashboard')).autoFit };
    };`;
    const result = (await page(url, script)).probe as { initial: string; on: { url: string; frame: { cols: number; rows: number } }[]; off: unknown[]; saved: boolean };
    expect(result.initial).toBe('true');
    expect(result.on.filter(x => x.url.includes(ids[0]!))).toHaveLength(1);
    expect(result.on.filter(x => x.url.includes(ids[1]!))).toHaveLength(0);
    expect(result.on.every(x => x.frame.cols >= 80 && x.frame.rows >= 24)).toBe(true);
    expect(result.off).toEqual([]);
    expect(result.saved).toBe(false);
  });

  it('uses configured text size only without a saved size and applies one toolbar setting to every pane', async (context) => {
    if (!browser) { context.skip(); return; }
    const { url } = await setup(17);
    const script = `${sentScript}; window.__dashboardTest = async () => {
      const sizes = () => [...document.querySelectorAll('.pane-term')].map(x => x.dataset.fontSize);
      const waitForSizes = async (wanted) => {
        const started = Date.now();
        while (Date.now() - started < 5000) {
          const current = sizes();
          if (current.length === 2 && current.every(size => size === wanted)) return current;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw Error('font size ' + wanted + ' did not settle: ' + JSON.stringify(sizes()));
      };
      const configured = await waitForSizes('17');
      document.getElementById('text-larger').click();
      const changed = await waitForSizes('18');
      const started = Date.now();
      while (window.__resizes.length === 0 && Date.now() - started < 5000)
        await new Promise(resolve => setTimeout(resolve, 50));
      const saved = JSON.parse(localStorage.getItem('shellpuppet.dashboard')).fontSize;
      return { configured, changed, saved, resizes: window.__resizes.length };
    };`;
    const result = (await page(url, script)).probe as { configured: string[]; changed: string[]; saved: number; resizes: number };
    expect(result.configured).toEqual(['17', '17']);
    expect(result.changed).toEqual(['18', '18']);
    expect(result.saved).toBe(18);
    expect(result.resizes).toBeGreaterThan(0);
  });

  it('closes a shortcut error by button or Escape and clears it after a valid shortcut', async (context) => {
    if (!browser) { context.skip(); return; }
    const { url } = await setup();
    const script = `${sentScript}; window.__dashboardTest = async () => {
      const shortcut = document.getElementById('shortcut');
      const banner = document.getElementById('error');
      const press = (key, ctrlKey = false, shiftKey = false) => document.dispatchEvent(
        new KeyboardEvent('keydown', { key, ctrlKey, shiftKey, bubbles: true, cancelable: true }));
      shortcut.click(); press('x');
      const shown = !banner.hidden;
      banner.querySelector('button[aria-label="Close error"]').click();
      const byButton = banner.hidden;
      shortcut.click(); press('x'); press('Escape');
      const byEscape = banner.hidden;
      shortcut.click(); press('x'); shortcut.click(); press('Z', true, true);
      return { shown, byButton, byEscape, validCleared: banner.hidden };
    };`;
    expect((await page(url, script)).probe).toEqual({ shown: true, byButton: true, byEscape: true, validCleared: true });
  });

  it('closes a pane error, reopens it for a new error, and lets Escape close the top then focused banner', async (context) => {
    if (!browser) { context.skip(); return; }
    const { url } = await setup();
    const script = `${sentScript}; (() => {
      window.__paneSockets = [];
      const Native = window.WebSocket;
      window.WebSocket = new Proxy(Native, { construct(Target, args) {
        const socket = new Target(...args);
        window.__paneSockets.push({ socket, url: String(args[0]) });
        return socket;
      } });
    })(); window.__dashboardTest = async () => {
      const card = document.querySelector('.pane');
      card.focus();
      const banner = card.querySelector('.pane-banner');
      const socket = window.__paneSockets.find(x => x.url.includes('/stream'))?.socket;
      if (!socket) return { error: 'no pane socket' };
      for (let i = 0; i < 9; i++) socket.onclose();
      const close = banner.querySelector('button[aria-label="Close pane error"]');
      const shown = !banner.hidden;
      close?.focus();
      close?.click();
      const byButton = banner.hidden;
      // Focus leaves the hidden button for the pane, where a keyboard user can see it.
      const focusOnPane = document.activeElement === card;
      socket.onclose();
      const reopened = !banner.hidden;
      const shortcut = document.getElementById('shortcut');
      shortcut.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }));
      const top = document.getElementById('error');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const topClosedFirst = top.hidden && !banner.hidden;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return { shown, closeNamed: Boolean(close), byButton, focusOnPane, reopened, topClosedFirst, paneClosedByEscape: banner.hidden };
    };`;
    expect((await page(url, script)).probe).toEqual({ shown: true, closeNamed: true, byButton: true,
      focusOnPane: true, reopened: true, topClosedFirst: true, paneClosedByEscape: true });
  });
});

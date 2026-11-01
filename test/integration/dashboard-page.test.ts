/** Dashboard page behaviour in the same Chromium harness as the viewer. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { captureDashboard } from './dashboardCapture.js';
import { createAuditor } from '../../src/daemon/audit.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, eventually, makeTempHome, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let daemon: TestDaemon;
let browser: string | null;
const opened: string[] = [];
const ids: string[] = [];

const instrument = `(() => {
  window.__dashSockets = [];
  window.__dashResizes = [];
  const Native = window.WebSocket;
  window.WebSocket = new Proxy(Native, {
    construct(Target, args) {
      const socket = new Target(...args);
      const entry = { socket, url: String(args[0]), protocol: args[1], binaryFrames: [] };
      socket.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) entry.binaryFrames.push(new TextDecoder().decode(event.data));
      });
      window.__dashSockets.push(entry);
      return socket;
    }
  });
  const send = Native.prototype.send;
  Native.prototype.send = function(data) {
    if (typeof data === 'string' && data.includes('"type":"resize"'))
      window.__dashResizes.push(JSON.parse(data));
    return send.call(this, data);
  };
})()`;

async function startSession(label: string): Promise<string> {
  const program = label.includes('second')
    ? "process.stdout.write(Array.from({length:2200},(_,i)=>'line-'+i+'\\r\\n').join('')); setInterval(() => {}, 1000)"
    : 'setInterval(() => {}, 1000)';
  const response = await api(daemon.port, daemon.token, '/sessions', {
    body: { command: process.execPath, args: ['-e', program],
      shell: false, openViewer: false, label, cols: 100, rows: 30 },
  });
  expect(response.status).toBe(200);
  const id = String(response.body['id']);
  ids.push(id);
  return id;
}

async function dashboardUrl(): Promise<string> {
  expect((await fetch(`http://127.0.0.1:${String(daemon.port)}/viewer/dashboard.js`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  })).status).toBe(200);
  const before = opened.length;
  const response = await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} });
  expect(response.status).toBe(200);
  expect(opened.length).toBe(before + 1);
  return opened.at(-1)!;
}

beforeAll(async () => {
  browser = await findBrowser();
  const home = makeTempHome('dashboard-page-');
  daemon = await startTestDaemon({
    home, audit: createAuditor(home),
    exitedGraceMs: 120,
    idleCheckIntervalMs: 40,
    launcher: (url) => {
      opened.push(url);
      return Promise.resolve({ launched: true, mode: 'isolated-app' as const, browser: 'mock' });
    },
  });
}, 60_000);

afterAll(async () => { await daemon.stop(); }, 120_000);

describe('passive dashboard page', () => {
  it('uses a hint colour with at least 4.5 to 1 contrast', () => {
    const css = fs.readFileSync(path.join(repoRoot, 'src', 'viewer', 'dashboard.css'), 'utf8');
    const hint = /\.hint\s*\{[^}]*color:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
    const background = /header\s*\{[^}]*background:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
    expect(hint).toBe('#8b97a6');
    expect(background).toBe('#141922');
    const luminance = (hex: string): number => {
      const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
        .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    expect((luminance(hint!) + 0.05) / (luminance(background!) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  it('redeems a grant, shows two live sessions, adds a third and removes it when reaped', async (context) => {
    if (!browser) { context.skip(); return; }
    const first = await startSession('first');
    const second = await startSession('second');
    const url = await dashboardUrl();
    const capture = captureDashboard({ browser, viewerUrl: url, width: 1920, height: 1080,
      drive: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
      probe: `(() => {
        const seen = window.__dashboardDiagnostics.paneCounts;
        if (seen.join(',') !== '2,3,2') return null;
        return JSON.stringify({ seen, ids: [...document.querySelectorAll('.pane')].map(p => p.dataset.session),
          sockets: window.__dashSockets.map(s => ({ url: s.url, protocol: s.protocol })),
          labels: [...document.querySelectorAll('.pane-label')].map(e => e.textContent),
          resizes: window.__dashResizes });
      })()`,
    });
    await eventually(() => daemon.daemon.connectedSockets >= 3, 90_000);
    const third = await startSession('third');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await api(daemon.port, daemon.token, `/sessions/${third}`, { method: 'DELETE' });
    const result = JSON.parse(String((await capture).probe)) as {
      seen: number[]; ids: string[]; labels: string[];
      sockets: { url: string; protocol: string[] }[]; resizes: unknown[];
    };
    expect(result.seen).toEqual([2, 3, 2]);
    expect(result.ids).toEqual([first, second]);
    expect(result.labels).toEqual(['first', 'second']);
    expect(result.sockets.some((s) => s.url.endsWith('/dashboard/events') &&
      s.protocol?.[0]?.startsWith('sp-csrf.'))).toBe(true);
    expect(result.sockets.filter((s) => s.url.includes('/stream')).length).toBeGreaterThanOrEqual(3);
    expect(result.resizes).toEqual([]);
  }, 180_000);

  it('bounds arrangement when layout fires resize and scroll during visibility', async (context) => {
    if (!browser) { context.skip(); return; }
    const loopIds = ids.length < 2
      ? [await startSession('loop-first'), await startSession('loop-second')]
      : [];
    let third: string | null = null;
    try {
      const url = await dashboardUrl();
      const capture = captureDashboard({ browser, viewerUrl: url, width: 1920, height: 1080,
      drive: true, timeoutMs: 120_000,
      beforeNavigateScript: `(() => {
        window.__dashboardTrace = { arrangements: 0, visibility: 0, arrangeDepth: 0,
          visibilityDepth: 0, maxArrangeDepth: 0, maxVisibilityDepth: 0, events: 0 };
        const rect = Element.prototype.getBoundingClientRect;
        Element.prototype.getBoundingClientRect = function() {
          if (this.classList?.contains('pane') && window.__dashboardTrace.events < 12) {
            window.__dashboardTrace.events++;
            window.dispatchEvent(new Event('resize'));
            document.getElementById('strip')?.dispatchEvent(new Event('scroll'));
          }
          return rect.call(this);
        };
      })()`,
      probe: `(() => {
        const seen = window.__dashboardDiagnostics.paneCounts;
        if (seen.join(',') !== '2,3,2') return null;
        return JSON.stringify({ ...window.__dashboardTrace, seen });
      })()`,
      });
      await eventually(() => daemon.daemon.connectedSockets >= 3, 90_000);
      third = await startSession('loop-third');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await api(daemon.port, daemon.token, `/sessions/${third}`, { method: 'DELETE' });
      const shot = await capture;
      const trace = JSON.parse(String(shot.probe)) as { arrangements: number; visibility: number;
        maxArrangeDepth: number; maxVisibilityDepth: number; events: number; seen: number[] };
      expect(trace.seen).toEqual([2, 3, 2]);
      expect(trace.events).toBeGreaterThanOrEqual(1);
      expect(trace.maxArrangeDepth).toBe(1);
      expect(trace.maxVisibilityDepth).toBe(1);
      expect(trace.arrangements).toBeLessThanOrEqual(10);
      expect(trace.visibility).toBeLessThanOrEqual(10);
    } finally {
      const cleanupIds = [...loopIds, ...(third === null ? [] : [third])];
      for (const id of cleanupIds) {
        await api(daemon.port, daemon.token, `/sessions/${id}`, { method: 'DELETE' });
      }
      await eventually(async () => {
        const list = await api(daemon.port, daemon.token, '/sessions');
        return cleanupIds.every((id) => !((list.body['sessions'] as { id: string }[]) ?? []).some((item) => item.id === id));
      }, 10_000);
    }
  }, 180_000);

  it('keeps pane nodes and streams attached through a slow window resize', async (context) => {
    if (!browser) { context.skip(); return; }
    if (ids.length < 2) { await startSession('resize first'); await startSession('resize second'); }
    const url = await dashboardUrl();
    const shot = await captureDashboard({ browser, viewerUrl: url, width: 1920, height: 1080,
      drive: true, timeoutMs: 60_000, beforeNavigateScript: instrument,
      probe: `(() => {
        const state = (window.__slowResize ||= {});
        if (!state.observer) {
          const cards = [...document.querySelectorAll('#panes .pane')];
          if (cards.length < 2 || cards.some(card => !card.querySelector('.pane-size')?.textContent)) return null;
          state.cards = cards;
          state.root = document.getElementById('panes');
          state.streamsBefore = window.__dashSockets.length;
          state.removals = 0;
          state.step = 0;
          state.width = state.root.clientWidth;
          state.originalWidth = Object.getOwnPropertyDescriptor(state.root, 'clientWidth');
          state.observer = new MutationObserver(records => {
            for (const record of records) state.removals += [...record.removedNodes].filter(node => node.classList?.contains('pane')).length;
          });
          state.observer.observe(state.root, { childList: true, subtree: true });
          Object.defineProperty(state.root, 'clientWidth', { configurable: true, get: () => state.width });
        }
        if (state.step < 20) {
          state.width -= 5;
          state.step++;
          window.dispatchEvent(new Event('resize'));
          return null;
        }
        for (const record of state.observer.takeRecords()) {
          state.removals += [...record.removedNodes].filter(node => node.classList?.contains('pane')).length;
        }
        if (state.originalWidth) Object.defineProperty(state.root, 'clientWidth', state.originalWidth);
        else delete state.root.clientWidth;
        state.observer.disconnect();
        return JSON.stringify({ removals: state.removals, streamsBefore: state.streamsBefore,
          streamsAfter: window.__dashSockets.length, sameCards: state.cards.every(card => card.isConnected),
          resizeEvents: state.step });
      })()`,
    });
    const result = JSON.parse(String(shot.probe)) as { removals: number; streamsBefore: number;
      streamsAfter: number; sameCards: boolean; resizeEvents: number };
    expect(result.resizeEvents).toBe(20);
    expect(result.removals).toBe(0);
    expect(result.streamsAfter).toBe(result.streamsBefore);
    expect(result.sameCards).toBe(true);
  }, 90_000);

  it('lays out one to five panes at 1920 by 1080, keeps order, attention and geometry passive', async (context) => {
    if (!browser) { context.skip(); return; }
    const url = await dashboardUrl();
    const shot = await captureDashboard({ browser, viewerUrl: url, width: 1920, height: 1080,
      drive: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
      probe: `(() => {
        if (!window.__dashSockets) return null;
        const feed = window.__dashSockets.find(s => s.url.endsWith('/dashboard/events'))?.socket;
        if (!feed || document.getElementById('connection').textContent !== 'Connected') return null;
        const ids = ['one','two','three','four','five'];
        const summaries = ids.map(id => ({ id, label: id, purpose: '<b>purpose</b>', cols: 100, rows: 30 }));
        const layouts = [];
        for (let n = 1; n <= 5; n++) {
          feed.onmessage({ data: JSON.stringify({ type: 'snapshot', sessions: summaries.slice(0, n) }) });
          const cards = [...document.querySelectorAll('.pane')];
          layouts.push({ mode: document.getElementById('panes').dataset.layout,
            ids: cards.map(c => c.dataset.session),
            boxes: cards.map(c => { const b = c.getBoundingClientRect(); return [b.x,b.y,b.width,b.height]; }),
            below: cards.map(c => c.classList.contains('below-floor')) });
        }
        const before = [...document.querySelectorAll('.pane')].map(c => {
          const b = c.getBoundingClientRect(); return [b.x,b.y,b.width,b.height]; });
        feed.onmessage({ data: JSON.stringify({ type: 'session-updated',
          session: { ...summaries[1], waitingOnPrompt: { question: '<img src=x>', options: [], waitingMs: 20000, alerted: true } } }) });
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'A', ctrlKey: true, shiftKey: true, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
        const jumped = document.querySelector('.pane.selected')?.dataset.session;
        document.querySelector('[data-session="one"]').click();
        document.getElementById('attention-count').click();
        const pillSelected = document.querySelector('.pane.selected')?.dataset.session;
        const after = [...document.querySelectorAll('.pane')].map(c => {
          const b = c.getBoundingClientRect(); return [b.x,b.y,b.width,b.height]; });
        const title = document.title;
        const text = document.querySelector('[data-session="two"] .pane-purpose').textContent;
        const plantedMarkup = document.querySelector('[data-session="two"] b') !== null;
        document.getElementById('grid').click();
        const gridOrder = [...document.querySelectorAll('.pane')].map(c => c.dataset.session);
        document.querySelector('[data-session="two"] button[aria-label="Pin"]').click();
        const pinnedGrid = [...document.querySelectorAll('.pane')].map(c => c.dataset.session);
        document.getElementById('focus').click();
        const mainAfterPin = document.querySelector('#main-pane .pane')?.dataset.session;
        document.querySelector('[data-session="three"] button[aria-label="Pin"]').click();
        const mainAfterTwoPins = document.querySelector('#main-pane .pane')?.dataset.session;
        const stripBeforeReorder = [...document.querySelectorAll('#strip .pane')].map(c => c.dataset.session);
        document.querySelector('[data-session="four"] button[aria-label="Move left"]').click();
        const reordered = [...document.querySelectorAll('#strip .pane')].map(c => c.dataset.session);
        document.getElementById('shortcut').click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
        const oldKey = new KeyboardEvent('keydown', { key: 'A', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
        const newKey = new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(oldKey); document.dispatchEvent(newKey);
        const shortcut = document.getElementById('shortcut-help').textContent;
        const preference = JSON.parse(localStorage.getItem('shellpuppet.dashboard'));
        return JSON.stringify({ layouts, before, after, jumped, pillSelected, title, text,
          plantedMarkup, gridOrder, pinnedGrid, mainAfterPin, mainAfterTwoPins,
          stripBeforeReorder, reordered, shortcut, oldConsumed: oldKey.defaultPrevented,
          newConsumed: newKey.defaultPrevented, preference, resizes: window.__dashResizes });
      })()`,
    });
    const result = JSON.parse(String(shot.probe)) as {
      layouts: { mode: string; ids: string[]; boxes: number[][]; below: boolean[] }[];
      before: number[][]; after: number[][]; jumped: string; pillSelected: string;
      title: string; text: string; plantedMarkup: boolean; gridOrder: string[];
      pinnedGrid: string[]; mainAfterPin: string; mainAfterTwoPins: string;
      stripBeforeReorder: string[]; reordered: string[];
      shortcut: string; oldConsumed: boolean; newConsumed: boolean;
      preference: { mode: string; order: string[]; pins: string[]; prefix: string }; resizes: unknown[];
    };
    expect(result.layouts.map((layout) => layout.mode)).toEqual(['grid','grid','grid','grid','focus']);
    for (const layout of result.layouts.slice(0, 4)) expect(layout.ids).toEqual(['one','two','three','four','five'].slice(0, layout.ids.length));
    expect(result.layouts[4]!.boxes[1]![2]).toBeCloseTo(300, 0);
    expect(result.layouts[2]!.boxes).toEqual(result.layouts[3]!.boxes.slice(0, 3));
    for (const layout of result.layouts.slice(0, 4)) expect(layout.below).not.toContain(true);
    expect(result.before).toEqual(result.after);
    expect(result.jumped).toBe('two');
    expect(result.pillSelected).toBe('two');
    expect(result.title).toContain('1 waiting');
    expect(result.title).not.toContain('[ANSWER ME]');
    expect(result.text).toBe('<b>purpose</b>');
    expect(result.plantedMarkup).toBe(false);
    expect(result.gridOrder).toEqual(result.pinnedGrid);
    expect(result.mainAfterPin).toBe('two');
    expect(result.mainAfterTwoPins).toBe('two');
    expect(result.stripBeforeReorder).toEqual(['one', 'three', 'four', 'five']);
    expect(result.reordered).toEqual(['one', 'four', 'three', 'five']);
    expect(result.shortcut).toBe('Ctrl+Shift+Z');
    expect(result.oldConsumed).toBe(false);
    expect(result.newConsumed).toBe(true);
    expect(result.preference).toEqual({ mode: 'focus', order: ['one', 'two', 'four', 'three', 'five'], pins: ['two', 'three'], prefix: 'z' });
    expect(result.resizes).toEqual([]);
  }, 180_000);

  it('uses focus at 1280 by 720 and marks a forced small grid without resizing', async (context) => {
    if (!browser) { context.skip(); return; }
    const url = await dashboardUrl();
    const shot = await captureDashboard({ browser, viewerUrl: url, width: 1280, height: 720,
      drive: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
      probe: `(() => {
        const feed = window.__dashSockets?.find(s => s.url.endsWith('/dashboard/events'))?.socket;
        if (!feed || document.getElementById('connection').textContent !== 'Connected') return null;
        const sessions = ['one','two'].map(id => ({ id, label: id, cols: 100, rows: 30 }));
        feed.onmessage({ data: JSON.stringify({ type: 'snapshot', sessions }) });
        const auto = document.getElementById('panes').dataset.layout;
        document.getElementById('grid').click();
        const forced = document.getElementById('panes').dataset.layout;
        const below = [...document.querySelectorAll('.pane')].map(c => c.classList.contains('below-floor'));
        document.getElementById('auto').click();
        return JSON.stringify({ auto, forced, below, resizes: window.__dashResizes });
      })()`,
    });
    const result = JSON.parse(String(shot.probe)) as { auto: string; forced: string; below: boolean[]; resizes: unknown[] };
    expect(result.auto).toBe('focus');
    expect(result.forced).toBe('grid');
    expect(result.below).toEqual([true, true]);
    expect(result.resizes).toEqual([]);
  }, 180_000);

  it('takes the grid only for Fit, Enlarge and Restore, and disconnects covered and scrolled-off panes', async (context) => {
    if (!browser) { context.skip(); return; }
    if (ids.length < 2) { await startSession('geometry first'); await startSession('geometry second'); }
    const url = await dashboardUrl();
    const shot = await captureDashboard({ browser, viewerUrl: url, width: 1280, height: 720,
      drive: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
      probe: `(() => {
        const state = (window.__geometryProbe ||= { phase: 0, at: 0 });
        state.started ||= Date.now();
        if (Date.now() - state.started > 8000) return JSON.stringify({ ...state,
          cards: [...document.querySelectorAll('.pane')].map(c => ({ id: c.dataset.session, size: c.querySelector('.pane-size')?.textContent })),
          sockets: window.__dashSockets?.map(s => ({url:s.url, ready:s.socket.readyState})),
          frames: window.__dashResizes });
        const cards = [...document.querySelectorAll('.pane')];
        if (state.phase === 0 && (cards.length !== 2 ||
          !cards.every(c => c.querySelector('.pane-size').textContent.includes('100×30')))) return null;
        const first = document.querySelector('[data-session="' + state.firstId + '"]') || cards[0];
        const secondSockets = () => window.__dashSockets.filter(s => s.url.includes('/sessions/' + state.secondId + '/stream'));
        if (state.phase === 0) {
          state.firstId = cards[0].dataset.session;
          state.secondId = cards[1].dataset.session;
          state.original = secondSockets().length;
          first.querySelector('button[aria-label="Fit"]').click();
          state.phase = 1; state.at = Date.now(); return null;
        }
        if (state.phase === 1 && Date.now() - state.at > 350) {
          first.querySelector('button[aria-label="Enlarge"]').click();
          state.phase = 2; state.at = Date.now(); return null;
        }
        if (state.phase === 2 && Date.now() - state.at > 350) {
          state.coveredClosed = secondSockets()[0]?.socket.readyState === 3;
          first.querySelector('button[aria-label="Restore"]').click();
          state.phase = 3; state.at = Date.now(); return null;
        }
        if (state.phase === 3 && Date.now() - state.at > 500) {
          state.returned = secondSockets().length > state.original && secondSockets().at(-1)?.socket.readyState === 1;
          state.returnedSnapshotLines = secondSockets().at(-1)?.binaryFrames[0]?.match(/line-\\d+/g)?.length || 0;
          document.getElementById('focus').click();
          state.phase = 4; state.at = Date.now(); return null;
        }
        if (state.phase === 4 && Date.now() - state.at > 350) {
          const strip = document.getElementById('strip');
          strip.style.height = '80px'; strip.style.paddingTop = '180px';
          strip.dispatchEvent(new Event('scroll'));
          state.phase = 5; state.at = Date.now(); return null;
        }
        if (state.phase === 5 && Date.now() - state.at > 350) {
          state.scrolledClosed = secondSockets().at(-1)?.socket.readyState === 3;
          const strip = document.getElementById('strip');
          strip.scrollTop = 180; strip.dispatchEvent(new Event('scroll'));
          state.phase = 6; state.at = Date.now(); return null;
        }
        if (state.phase === 6 && Date.now() - state.at > 500) {
          state.scrolledReturned = secondSockets().at(-1)?.socket.readyState === 1;
          state.scrolledSnapshotLines = secondSockets().at(-1)?.binaryFrames[0]?.match(/line-\\d+/g)?.length || 0;
          state.socketCount = secondSockets().length;
          state.beforeFont = window.__dashResizes.length;
          for (let i = 0; i < 50; i++) first.querySelector('button[aria-label="Smaller text"]').click();
          state.smallFont = first.querySelector('.pane-term').dataset.fontSize;
          for (let i = 0; i < 50; i++) first.querySelector('button[aria-label="Larger text"]').click();
          state.largeFont = first.querySelector('.pane-term').dataset.fontSize;
          state.transform = getComputedStyle(first.querySelector('.xterm')).transform;
          state.afterFont = window.__dashResizes.length;
          return JSON.stringify({ ...state, frames: window.__dashResizes });
        }
        return null;
      })()`,
    });
    const result = JSON.parse(String(shot.probe)) as {
      frames: { type: string; take?: boolean; cols: number; rows: number }[];
      coveredClosed: boolean; returned: boolean; scrolledClosed: boolean; scrolledReturned: boolean;
      socketCount: number; beforeFont: number; afterFont: number;
      returnedSnapshotLines: number; scrolledSnapshotLines: number;
      smallFont: string; largeFont: string; transform: string;
    };
    expect(result.frames, JSON.stringify(result)).toHaveLength(4);
    expect(result.frames.every((f) => f.type === 'resize' && f.take === true)).toBe(true);
    expect(result.frames[2]).toMatchObject({ cols: result.frames[0]!.cols, rows: result.frames[0]!.rows });
    expect(result.coveredClosed).toBe(true);
    expect(result.returned).toBe(true);
    expect(result.scrolledClosed).toBe(true);
    expect(result.scrolledReturned).toBe(true);
    expect(result.socketCount).toBeGreaterThanOrEqual(3);
    expect(result.returnedSnapshotLines).toBeGreaterThan(1900);
    expect(result.returnedSnapshotLines).toBeLessThanOrEqual(2030);
    expect(result.scrolledSnapshotLines).toBeGreaterThan(1900);
    expect(result.scrolledSnapshotLines).toBeLessThanOrEqual(2030);
    expect(result.afterFont).toBe(result.beforeFont);
    expect(result.smallFont).toBe('6');
    expect(result.largeFont).toBe('40');
    expect(result.transform).toBe('none');
  }, 180_000);

  it('updates covered and scrolled panes immediately while assignment and visibility frames lag', async (context) => {
    if (!browser) { context.skip(); return; }
    if (ids.length < 2) { await startSession('geometry first'); await startSession('geometry second'); }
    const shot = await captureDashboard({ browser, viewerUrl: await dashboardUrl(), width: 1280, height: 720,
      drive: true, timeoutMs: 30_000, beforeNavigateScript: instrument,
      probe: `(() => {
        const state = (window.__restoreProbe ||= { phase: 0, started: Date.now() });
        if (Date.now() - state.started > 8000) return JSON.stringify({ timeout: true, ...state });
        const cards = [...document.querySelectorAll('#panes .pane')];
        const sockets = () => window.__dashSockets.filter(s => s.url.includes('/sessions/' + state.second + '/stream'));
        if (state.phase === 0) {
          if (cards.length !== 2 || !cards.every(c => c.querySelector('.pane-size')?.textContent)) return null;
          state.first = cards[0].dataset.session; state.second = cards[1].dataset.session;
          state.original = sockets().length;
          const assign = ShellPuppetDashboardLayout.assign;
          ShellPuppetDashboardLayout.assign = () => ({});
          setTimeout(() => { ShellPuppetDashboardLayout.assign = assign; }, 4000);
          const frame = window.requestAnimationFrame;
          window.requestAnimationFrame = (callback) => setTimeout(() => callback(performance.now()), 1500);
          setTimeout(() => { window.requestAnimationFrame = frame; }, 4000);
          cards[0].querySelector('button[aria-label="Enlarge"]').click();
          state.coveredClosed = sockets()[0]?.socket.readyState >= 2;
          state.phase = 1; return null;
        }
        if (state.phase === 1) {
          if (sockets()[0]?.socket.readyState !== 3) return null;
          state.phase = 2; return null;
        }
        if (state.phase === 2) {
          cards[0].querySelector('button[aria-label="Restore"]').click();
          state.phase = 3; state.at = Date.now(); return null;
        }
        if (state.phase === 3 && Date.now() - state.at > 500) {
          state.returned = sockets().length > state.original && sockets().at(-1)?.socket.readyState === 1;
          state.visible = document.querySelector('[data-session="' + state.second + '"]')?.isConnected === true;
          document.getElementById('focus').click();
          const strip = document.getElementById('strip');
          strip.style.height = '80px'; strip.style.paddingTop = '180px';
          strip.dispatchEvent(new Event('scroll'));
          state.scrolledClosed = sockets().at(-1)?.socket.readyState >= 2;
          strip.scrollTop = 180; strip.dispatchEvent(new Event('scroll'));
          state.phase = 4; state.at = Date.now(); return null;
        }
        if (state.phase === 4 && Date.now() - state.at > 500) return JSON.stringify({
          coveredClosed: state.coveredClosed, returned: state.returned, visible: state.visible,
          scrolledClosed: state.scrolledClosed,
          scrolledReturned: sockets().at(-1)?.socket.readyState === 1 });
        return null;
      })()`,
    });
    const result = JSON.parse(String(shot.probe)) as {
      coveredClosed: boolean; returned: boolean; visible: boolean;
      scrolledClosed: boolean; scrolledReturned: boolean;
    };
    expect(result.coveredClosed, JSON.stringify(result)).toBe(true);
    expect(result.visible, JSON.stringify(result)).toBe(true);
    expect(result.returned, JSON.stringify(result)).toBe(true);
    expect(result.scrolledClosed, JSON.stringify(result)).toBe(true);
    expect(result.scrolledReturned, JSON.stringify(result)).toBe(true);
  }, 60_000);
});

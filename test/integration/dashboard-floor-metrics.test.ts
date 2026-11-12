import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, connectWs, eventually, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let browser: string | null = null;
let daemon: TestDaemon | null = null;
beforeAll(async () => { browser = await findBrowser(); }, 60_000);
afterEach(async () => { await daemon?.stop(); daemon = null; vi.restoreAllMocks(); }, 120_000);

interface Box { left: number; right: number; top: number; bottom: number; width: number; height: number }
interface PaneView { id: string; grid: { cols: number; rows: number }; font: number; below: boolean; whole: boolean;
  screen: Box; wrap: Box; size: string }

async function setup() {
  const urls: string[] = [];
  daemon = await startTestDaemon({ idleCheckIntervalMs: 600_000,
    launcher: url => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
  });
  // Serve the fixture from the test daemon's own origin, retaining the page's CSP.
  const httpDaemon = daemon.daemon as unknown as {
    handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  };
  const handleRequest = httpDaemon.handleRequest.bind(httpDaemon);
  vi.spyOn(httpDaemon, 'handleRequest').mockImplementation((req, res) => {
    if (req.url !== '/test-font.ttf') return handleRequest(req, res);
    res.writeHead(200, { 'Content-Type': 'font/ttf', 'Cache-Control': 'no-store' });
    res.end(fontData);
    return Promise.resolve();
  });
  return async () => {
    expect((await api(daemon!.port, daemon!.token, '/dashboard/open', { body: {} })).status).toBe(200);
    return urls.at(-1)!;
  };
}

async function start(cols = 96, rows = 24, hold = false, words = false) {
  const script = (words ? "for(let i=0;i<500;i++)process.stdout.write('ROW'+String(i).padStart(3,'0')+':'+(' WORD'+String(i).padStart(3,'0')).repeat(26)+'\\r\\n');" : '') +
    'setInterval(() => {}, 1000)';
  const response = await api(daemon!.port, daemon!.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', script], shell: false, openViewer: false,
    cwd: process.cwd(), cols, rows, hold,
  } });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const id = String(response.body['id']);
  const manager = (daemon!.daemon as unknown as {
    manager: { get: (id: string) => import('../../src/core/session.js').Session };
  }).manager;
  const session = manager.get(id);
  const pty = (session as unknown as { pty: { resize: (cols: number, rows: number) => void } }).pty;
  return { id, session, resize: vi.spyOn(session, 'resize'), nativeResize: vi.spyOn(pty, 'resize') };
}

const instrument = `(() => {
  localStorage.setItem('shellpuppet.dashboard', JSON.stringify({ mode: 'grid' }));
  window.__clients = new Map(); window.__metrics = 0;
  let implementation;
  Object.defineProperty(window, 'ShellPuppetPane', { get: () => implementation, set: value => {
    implementation = { ...value, create(config) {
      const onMetricsChange = config.onMetricsChange;
      config.onMetricsChange = () => { window.__metrics++; onMetricsChange?.(); };
      const client = value.create(config); window.__clients.set(config.sessionId, client); return client;
    } };
  } });
  window.__pause = (ms = 1600) => new Promise(resolve => setTimeout(resolve, ms));
  // Only read committed geometry here: fitting queries would hide stale displays.
  window.__views = () => [...document.querySelectorAll('.pane')].filter(card =>
    card.querySelector('.xterm-screen')).map(card => {
    const client = __clients.get(card.dataset.session), term = client.getTerminal();
    const screen = card.querySelector('.xterm-screen').getBoundingClientRect();
    const wrap = card.querySelector('.pane-wrap').getBoundingClientRect();
    return { id: card.dataset.session, grid: { cols: term.cols, rows: term.rows },
      font: Number(card.querySelector('.pane-term').dataset.fontSize), below: card.classList.contains('below-floor'),
      whole: screen.left >= wrap.left && screen.top >= wrap.top && screen.right <= wrap.right && screen.bottom <= wrap.bottom,
      screen: screen.toJSON(), wrap: wrap.toJSON(), size: card.querySelector('.pane-size').textContent };
  });
  window.__frames = () => __dashboardDiagnostics.streams.flatMap(stream =>
    stream.resizes.map(frame => ({ url: stream.url, ...frame })));
  window.__reset = () => { for (const stream of __dashboardDiagnostics.streams) stream.resizes.length = 0; };
})()`;

it('selects the clicked word and places the context menu helper under a scaled right-click', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  await start();
  const held = await start(220, 115, true, true);
  await captureDashboard({ browser, viewerUrl: await open(), width: 1400, height: 900,
    drive: true, probeOnly: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
    probe: 'window.__clients?.size === 2', interact: async ({ evaluate, send }) => {
      await evaluate(`(async () => {
        await __pause(); document.querySelector('.pane').click(); document.getElementById('focus').click();
        await __pause(); window.__term = __clients.get('${held.id}').getTerminal();
        window.__card = document.querySelector('.pane[data-session="${held.id}"]');
        __term.options.rightClickSelectsWord = true; __term.scrollToTop(); await __pause(250);
        __card.addEventListener('contextmenu', event => {
          window.__contextEvent = event;
          window.__nativeOffsets = [Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'offsetX').get.call(event),
            Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'offsetY').get.call(event)];
        }, true);
        __card.addEventListener('contextmenu', event => {
          window.__sameEvent = event === __contextEvent && event.isTrusted && __card.contains(event.target);
          window.__offsets = [event.offsetX, event.offsetY];
        });
      })()`);
      held.resize.mockClear(); held.nativeResize.mockClear();
      const point = await evaluate(`(() => {
        const screen = __card.querySelector('.xterm-screen').getBoundingClientRect();
        return { x: Math.round(screen.left + 113.5 * screen.width / __term.cols),
          y: Math.round(screen.top + 39.5 * screen.height / __term.rows) };
      })()`) as { x: number; y: number };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'right', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'right', clickCount: 1 });
      const result = await evaluate(`({ selection: __term.getSelection(), row: __term.getSelectionPosition()?.start.y,
        helper: __card.querySelector('.xterm-helper-textarea').getBoundingClientRect().toJSON(),
        same: __sameEvent, offsets: __offsets, native: __nativeOffsets })`) as {
        selection: string; row: number; helper: Box; same: boolean; offsets: number[]; native: number[];
      };
      expect.soft(result.row).toBe(39);
      expect.soft(result.selection).toBe('WORD039');
      expect.soft(point.x >= result.helper.left && point.x <= result.helper.right &&
        point.y >= result.helper.top && point.y <= result.helper.bottom, JSON.stringify(result)).toBe(true);
      expect(result.same).toBe(true);
      expect(result.offsets).toEqual(result.native);
      expect(held.resize).not.toHaveBeenCalled();
      expect(held.nativeResize).not.toHaveBeenCalled();
    },
  });
}, 180_000);

it('automatically refits a held Focus strip through device scales 1, 1.5, 2 and 1', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  await start();
  const held = await start(220, 115, true);
  await captureDashboard({ browser, viewerUrl: await open(), width: 1400, height: 900,
    drive: true, probeOnly: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
    probe: 'window.__clients?.size === 2', interact: async ({ evaluate, send }) => {
      await evaluate(`(async () => {
        await __pause(); document.querySelector('.pane').click(); document.getElementById('focus').click();
        await __pause(); window.__term = __clients.get('${held.id}').getTerminal();
        window.__dprEvents = 0; __term._core._coreBrowserService.onDprChange(() => __dprEvents++);
      })()`);
      held.resize.mockClear(); held.nativeResize.mockClear();
      let previous = 1;
      for (const deviceScaleFactor of [1, 1.5, 2, 1]) {
        const events = await evaluate('__dprEvents') as number;
        await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor, mobile: false });
        // CDP does not always deliver resolution changes. Notify xterm's existing
        // media query, retaining all its native handlers and metric updates.
        await evaluate(`(() => {
          for (const client of __clients.values()) {
            const query = client.getTerminal()._core._coreBrowserService._screenDprMonitor._resolutionMediaMatchList;
            query.dispatchEvent(new MediaQueryListEvent('change', { matches: query.matches, media: query.media }));
          }
        })()`);
        await evaluate('__pause(700)');
        if (previous !== deviceScaleFactor) expect(await evaluate('__dprEvents')).toBeGreaterThan(events);
        const automatic = (await evaluate('__views()') as PaneView[]).find(pane => pane.id === held.id)!;
        // Assert the display before any relayout or fitting query. Derive the
        // fractional fit independently from the rendered one-pixel canvas.
        const expected = await evaluate(`(() => {
          const screen = __term.element.querySelector('.xterm-screen');
          const wrap = __term.element.closest('.pane-wrap'), style = getComputedStyle(wrap);
          return Math.min((wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / screen.offsetWidth,
            (wrap.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / screen.offsetHeight);
        })()`) as number;
        expect.soft(automatic.whole, JSON.stringify(automatic)).toBe(true);
        expect.soft(automatic.font).toBeCloseTo(expected, 10);
        expect(automatic.grid).toEqual({ cols: 220, rows: 115 });
        await evaluate(`__clients.get('${held.id}').relayout(false)`);
        await evaluate('__pause(150)');
        const refreshed = (await evaluate('__views()') as PaneView[]).find(pane => pane.id === held.id)!;
        expect.soft(automatic.font).toBe(refreshed.font);
        previous = deviceScaleFactor;
      }
      expect(held.resize).not.toHaveBeenCalled();
      expect(held.nativeResize).not.toHaveBeenCalled();
      const disposed = await evaluate(`(async () => {
        const emitter = __term._core._coreBrowserService._onDprChange;
        emitter.fire(devicePixelRatio);
        const before = __metrics;
        __clients.get('${held.id}').destroy();
        await __pause(100);
        return { before, after: __metrics };
      })()`) as { before: number; after: number };
      expect(disposed.after).toBe(disposed.before);
    },
  });
}, 180_000);

const fontInstrument = instrument.replace('const client = value.create(config);',
  "const client = value.create(config); client.getTerminal().options.fontFamily = 'FloorFont, monospace';");
const fontData = readFileSync(new URL('../fixtures/floor-metrics.ttf', import.meta.url));

async function loadFont(evaluate: (expression: string) => Promise<unknown>, family = 'FloorFont') {
  const loaded = await evaluate(`(async () => {
    let events = 0;
    const onLoad = () => events++;
    document.fonts.addEventListener('loadingdone', onLoad);
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = '13px ' + ${JSON.stringify(family)} + ', monospace';
    const beforeWidth = measure.measureText('W').width;
    const face = new FontFace(${JSON.stringify(family)}, 'url(/test-font.ttf)');
    document.fonts.add(face);
    let error;
    try {
      await document.fonts.load('13px ' + ${JSON.stringify(family)});
      await document.fonts.ready; await __pause();
    } catch (cause) { error = String(cause); }
    finally { document.fonts.removeEventListener('loadingdone', onLoad); }
    return { events, status: face.status, error, beforeWidth, afterWidth: measure.measureText('W').width,
      panes: __views(), frames: __frames() };
  })()`) as { events: number; status: string; error?: string; beforeWidth: number; afterWidth: number;
    panes: PaneView[]; frames: unknown[] };
  const details = JSON.stringify({ platform: process.platform, family, ...loaded });
  expect(loaded.status, details).toBe('loaded');
  expect(loaded.events, details).toBe(1);
  expect(loaded.afterWidth, details).toBeGreaterThan(loaded.beforeWidth);
  return loaded;
}

it('keeps a remembered text size as the ceiling for an owned grid with Auto fit off after metric changes', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const session = await start();
  const fixedInstrument = fontInstrument.replace("{ mode: 'grid' }", "{ mode: 'grid', fontSize: 13 }");
  await captureDashboard({ browser, viewerUrl: await open(), width: 1400, height: 900,
    drive: true, probeOnly: true, timeoutMs: 120_000, beforeNavigateScript: fixedInstrument,
    probe: 'window.__clients?.size === 1', interact: async ({ evaluate, send }) => {
      await evaluate('__pause()');
      await evaluate("document.getElementById('auto-fit').click()");
      const before = (await evaluate('__views()') as PaneView[])[0]!;
      expect(before.whole).toBe(true);
      expect(before.below).toBe(false);
      expect(before.font).toBe(13);
      expect(before.grid.cols).toBeGreaterThan(80);
      expect(before.grid.rows).toBeGreaterThan(24);
      expect(before.size).not.toMatch(/following|fixed/);
      session.resize.mockClear(); session.nativeResize.mockClear();
      await evaluate('__reset()');
      const checkRetained = async (stage: string, shrunk: boolean) => {
        const pane = (await evaluate('__views()') as PaneView[])[0]!;
        expect.soft(pane.whole, `${stage}: ${JSON.stringify(pane)}`).toBe(true);
        expect.soft(pane.below, stage).toBe(false);
        expect.soft(pane.grid, stage).toEqual(before.grid);
        expect.soft(pane.size, stage).not.toMatch(/following|fixed/);
        expect.soft(pane.font, stage).toBeGreaterThan(0);
        if (shrunk) expect.soft(pane.font, stage).toBeLessThan(13);
        else expect.soft(pane.font, stage).toBe(13);
        expect.soft(await evaluate("JSON.parse(localStorage.getItem('shellpuppet.dashboard')).fontSize"), stage).toBe(13);
        expect.soft(await evaluate("document.getElementById('auto-fit').getAttribute('aria-pressed')"), stage).toBe('false');
        expect.soft(await evaluate('__frames()'), stage).toHaveLength(0);
        expect.soft(session.resize, stage).not.toHaveBeenCalled();
        expect.soft(session.nativeResize, stage).not.toHaveBeenCalled();
        expect.soft({ cols: session.session.cols, rows: session.session.rows }, stage).toEqual(before.grid);
      };
      await loadFont(evaluate);
      await checkRetained('local font loaded', true);
      for (const deviceScaleFactor of [1.5, 2, 1]) {
        await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor, mobile: false });
        // Notify xterm's existing resolution query when CDP omits the event.
        await evaluate(`(() => {
          const query = __clients.values().next().value.getTerminal()._core._coreBrowserService._screenDprMonitor._resolutionMediaMatchList;
          query.dispatchEvent(new MediaQueryListEvent('change', { matches: query.matches, media: query.media }));
        })()`);
        await evaluate('__pause(700)');
        await checkRetained(`display scale ${deviceScaleFactor}`, true);
      }
      // Growing the available space restores the saved size without taking the grid.
      await send('Emulation.setDeviceMetricsOverride', { width: 2600, height: 1100, deviceScaleFactor: 1, mobile: false });
      await evaluate('__pause()');
      await checkRetained('space restored', false);
    },
  });
}, 180_000);

it('fits equal grids after a local font loads while respecting Auto fit, hidden, held and following panes', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const sessions = [await start(), await start()];
  // Separate documents load a real local font in each mode, without network fonts.
  for (const autoFit of [true, false]) {
    await captureDashboard({ browser, viewerUrl: await open(), width: 1800, height: 700,
      drive: true, probeOnly: true, timeoutMs: 120_000, beforeNavigateScript: fontInstrument,
      probe: 'window.__clients?.size === 2', interact: async ({ evaluate }) => {
        await evaluate('__pause()');
        if (!autoFit) await evaluate("document.getElementById('auto-fit').click()");
        const before = await evaluate('__views()') as PaneView[];
        expect(before.every(pane => !pane.below)).toBe(true);
        expect(before[0]!.grid).toEqual(before[1]!.grid);
        for (const session of sessions) { session.resize.mockClear(); session.nativeResize.mockClear(); }
        await evaluate('__reset()');
        const loaded = await loadFont(evaluate);
        let settled = { panes: loaded.panes, frames: loaded.frames };
        await eventually(async () => {
          settled = { panes: await evaluate('__views()') as PaneView[], frames: await evaluate('__frames()') as unknown[] };
          return settled.panes.length === 2 && settled.panes.every(pane => pane.below && pane.whole);
        }, 10_000, 100, 'font-loaded floor fit', () => ({ ...loaded, ...settled }));
        loaded.panes = settled.panes;
        loaded.frames = settled.frames;
        expect(loaded.panes.every(pane => pane.below && pane.whole), JSON.stringify(loaded)).toBe(true);
        expect.soft(loaded.panes.map(pane => pane.grid)).toEqual(autoFit ?
          [{ cols: 80, rows: 24 }, { cols: 80, rows: 24 }] : before.map(pane => pane.grid));
        expect(loaded.panes[0]!.font).toBe(loaded.panes[1]!.font);
        expect.soft(loaded.frames).toHaveLength(autoFit ? 2 : 0);
        for (const session of sessions) {
          expect.soft(session.resize).toHaveBeenCalledTimes(autoFit ? 1 : 0);
          expect.soft(session.nativeResize).toHaveBeenCalledTimes(autoFit ? 1 : 0);
          expect.soft({ cols: session.session.cols, rows: session.session.rows })
            .toEqual(autoFit ? { cols: 80, rows: 24 } : before[0]!.grid);
        }
        if (autoFit) {
          await evaluate("document.querySelector('button[aria-label=Fit]').click()");
          await evaluate('__pause()');
          const fitted = await evaluate('__views()') as PaneView[];
          expect(fitted.map(pane => pane.grid)).toEqual([{ cols: 80, rows: 24 }, { cols: 80, rows: 24 }]);
          expect.soft(fitted[0]!.font).toBe(fitted[1]!.font);
          expect.soft(fitted[0]!.font).toBe(loaded.panes[0]!.font);
          for (const session of sessions) expect.soft(session.nativeResize).toHaveBeenCalledTimes(1);
        }
      },
    });
  }
  // A held pane and an outside owner must stay protected on the same notification.
  const held = await start(220, 115, true);
  const external = await connectWs(daemon!.port, sessions[1]!.id, daemon!.token);
  try {
    external.ws.send(JSON.stringify({ type: 'resize', cols: 140, rows: 45 }));
    await vi.waitFor(() => expect(sessions[1]!.session.cols).toBe(140));
    await captureDashboard({ browser, viewerUrl: await open(), width: 1800, height: 700,
      drive: true, probeOnly: true, timeoutMs: 120_000, beforeNavigateScript: fontInstrument,
      probe: 'window.__clients?.size === 3', interact: async ({ evaluate }) => {
        await evaluate('__pause()');
        expect((await evaluate('__views()') as PaneView[]).find(pane => pane.id === sessions[1]!.id)!.size).toContain('following');
        for (const session of [...sessions, held]) { session.resize.mockClear(); session.nativeResize.mockClear(); }
        await evaluate('__reset()');
        await loadFont(evaluate);
        for (const session of [sessions[1]!, held]) {
          expect(session.resize).not.toHaveBeenCalled();
          expect(session.nativeResize).not.toHaveBeenCalled();
        }
        expect({ cols: held.session.cols, rows: held.session.rows }).toEqual({ cols: 220, rows: 115 });
        expect({ cols: sessions[1]!.session.cols, rows: sessions[1]!.session.rows }).toEqual({ cols: 140, rows: 45 });
        // Enlarge hides the other panes. Loading a second face must not take them.
        await evaluate(`document.querySelector('.pane[data-session="${held.id}"] button[aria-label=Enlarge]').click()`);
        await evaluate('__pause()');
        for (const session of [...sessions, held]) { session.resize.mockClear(); session.nativeResize.mockClear(); }
        await evaluate("for (const client of __clients.values()) client.getTerminal().options.fontFamily = 'HiddenFloorFont, monospace'");
        await loadFont(evaluate, 'HiddenFloorFont');
        for (const session of sessions) {
          expect(session.resize).not.toHaveBeenCalled();
          expect(session.nativeResize).not.toHaveBeenCalled();
        }
      },
    });
  } finally { external.ws.close(); }
}, 300_000);

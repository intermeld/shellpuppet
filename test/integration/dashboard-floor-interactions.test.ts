import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { captureViewer } from '../../src/daemon/screenshot.js';
import type { CaptureOptions } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, connectWs, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let browser: string | null = null;
let daemon: TestDaemon | null = null;
beforeAll(async () => { browser = await findBrowser(); }, 60_000);
afterEach(async () => { await daemon?.stop(); daemon = null; vi.restoreAllMocks(); }, 120_000);
type Page = Parameters<NonNullable<CaptureOptions['interact']>>[0];
type Box = { x: number; y: number; width: number; height: number; top: number; bottom: number; left: number; right: number };
interface View { screen: Box; wrap: Box; bar: Box; slider: Box; row: number; end: number; font: number }

async function setup() {
  const urls: string[] = [];
  daemon = await startTestDaemon({ idleCheckIntervalMs: 600_000,
    launcher: url => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
  });
  return async () => {
    expect((await api(daemon!.port, daemon!.token, '/dashboard/open', { body: {} })).status).toBe(200);
    return urls.at(-1)!;
  };
}

async function start(cols = 96, rows = 24, hold = false, history = false) {
  const script = (history ? "for(let i=0;i<500;i++)process.stdout.write('ROW'+String(i).padStart(3,'0')+':'+'x'.repeat(210)+'\\r\\n');" : '') +
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
  // Observe the actual PTY call as well as the session method and wire frames.
  const pty = (session as unknown as { pty: { resize: (cols: number, rows: number) => void } }).pty;
  const resizePty = pty.resize.bind(pty);
  return { id, resizePty, resize: vi.spyOn(session, 'resize'), nativeResize: vi.spyOn(pty, 'resize') };
}

const instrument = `(() => {
  localStorage.setItem('shellpuppet.dashboard', JSON.stringify({ mode: 'grid' }));
  window.__clients = new Map(); window.__fontChanges = 0;
  let implementation;
  Object.defineProperty(window, 'ShellPuppetPane', { get: () => implementation, set: value => {
    implementation = { ...value, create(config) {
      const client = value.create(config); window.__clients.set(config.sessionId, client);
      const options = client.getTerminal().options;
      const descriptor = Object.getOwnPropertyDescriptor(options, 'fontSize');
      Object.defineProperty(options, 'fontSize', { ...descriptor, set(value) {
        if (descriptor.get.call(this) !== value) window.__fontChanges++;
        descriptor.set.call(this, value);
      } });
      return client;
    } };
  } });
  window.__pause = (ms = 1600) => new Promise(resolve => setTimeout(resolve, ms));
  window.__frames = () => window.__dashboardDiagnostics.streams.flatMap(stream =>
    stream.resizes.map(frame => ({ url: stream.url, ...frame })));
  window.__reset = () => {
    window.__fontChanges = 0;
    for (const stream of window.__dashboardDiagnostics.streams) stream.resizes.length = 0;
  };
})()`;

async function scaledPage(interact: (page: Page) => Promise<void>) {
  const open = await setup();
  await start();
  const held = await start(220, 115, true, true);
  await captureDashboard({ browser: browser!, viewerUrl: await open(), width: 1400, height: 900,
    drive: true, probeOnly: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
    probe: 'window.__clients?.size === 2', interact: async page => {
      await page.evaluate(`(async () => {
        await __pause(); document.querySelector('.pane').click(); document.getElementById('focus').click();
        await __pause(); window.__held = __clients.get('${held.id}').getTerminal();
        window.__card = document.querySelector('.pane[data-session="${held.id}"]');
        window.__view = () => {
          const box = selector => __card.querySelector(selector).getBoundingClientRect().toJSON();
          return { screen: box('.xterm-screen'), wrap: box('.pane-wrap'), bar: box('.scrollbar.vertical'),
            slider: box('.scrollbar.vertical .slider'), row: __held.buffer.active.viewportY,
            end: __held.buffer.active.baseY, font: Number(__card.querySelector('.pane-term').dataset.fontSize) };
        };
      })()`);
      held.resize.mockClear(); held.nativeResize.mockClear();
      await interact(page);
      expect(held.resize).not.toHaveBeenCalled();
      expect(held.nativeResize).not.toHaveBeenCalled();
    },
  });
}

it('scrolls normal history inside a scaled pane and preserves its row through Enlarge and Restore', async context => {
  if (!browser) { context.skip(); return; }
  await scaledPage(async ({ evaluate, send }) => {
    for (const action of [null, 'Enlarge', 'Restore']) {
      if (action) await evaluate(`(async () => { __card.querySelector('button[aria-label="${action}"]').click(); await __pause(); })()`);
      const before = await evaluate('__view()') as View;
      expect(before.end).toBeGreaterThan(300);
      if (action !== 'Enlarge') expect(before.font).toBeLessThan(1);
      expect.soft(before.bar.top).toBeGreaterThanOrEqual(before.wrap.top);
      expect.soft(before.bar.bottom).toBeLessThanOrEqual(before.wrap.bottom);
      expect.soft(before.bar.right).toBeLessThanOrEqual(before.wrap.right);
      if (action) expect.soft(before.row).toBe(100);
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel',
        x: Math.round(before.screen.x + before.screen.width / 2), y: Math.round(before.screen.y + before.screen.height / 2),
        deltaX: 0, deltaY: -120 });
      await evaluate('__pause(300)');
      const after = await evaluate('__view()') as View;
      expect.soft(after.row).toBeLessThan(before.row);
      await evaluate('(async () => { __held.scrollToLine(100); await __pause(200); })()');
      expect.soft((await evaluate('__view()') as View).row).toBe(100);
    }
  });
}, 180_000);

it('drags a scaled scrollbar to both ends while retaining pointer capture and text selection', async context => {
  if (!browser) { context.skip(); return; }
  await scaledPage(async ({ evaluate, send }) => {
    // Isolate pointer scaling from viewport synchronisation, so either defect is caught independently.
    await evaluate(`(async () => { __held._core._viewport.queueSync(); await __pause(200);
      __held.scrollToTop(); await __pause(200);
      __card.addEventListener('pointerdown', event => window.__pointer = event.pointerId, true);
    })()`);
    for (const end of ['bottom', 'top']) {
      const before = await evaluate('__view()') as View;
      const x = before.slider.x + before.slider.width / 2;
      const y = before.slider.y + before.slider.height / 2;
      const targetY = end === 'bottom' ? before.bar.bottom - 1 : before.bar.top + 1;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await evaluate('__pause(150)');
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: targetY, button: 'left', buttons: 1 });
      expect(await evaluate(`__card.querySelector('.scrollbar.vertical .slider').hasPointerCapture(__pointer)`)).toBe(true);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: targetY, button: 'left', clickCount: 1 });
      await evaluate('__pause(250)');
      const after = await evaluate('__view()') as View;
      expect.soft(after.row).toBe(end === 'bottom' ? after.end : 0);
      expect(await evaluate(`__card.querySelector('.scrollbar.vertical .slider').hasPointerCapture(__pointer)`)).toBe(false);
    }
    const view = await evaluate('__view()') as View;
    const x = Math.round(view.screen.x + view.screen.width / 3), y = Math.round(view.screen.y + view.screen.height / 3);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 12, y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 12, y, button: 'left', clickCount: 1 });
    expect(await evaluate('__held.getSelection().length')).toBeGreaterThan(0);
  });
}, 180_000);

it('reuses font measurements and limits a blocked divider to its tracks without resizing any terminal', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const sessions: Awaited<ReturnType<typeof start>>[] = [];
  for (let i = 0; i < 13; i++) sessions.push(await start());
  await captureDashboard({ browser, viewerUrl: await open(), width: 1920, height: 1080, drive: true,
    probeOnly: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
    probe: 'window.__clients?.size === 13', interact: async ({ evaluate, send }) => {
      await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
      await evaluate('__pause(2300)');
      expect(await evaluate(`[...__clients.values()].map(client => client.getGrid())`))
        .toEqual(sessions.map(() => ({ cols: 80, rows: 24 })));
      await evaluate('__reset()');
      await send('Emulation.setDeviceMetricsOverride', { width: 1916, height: 1080, deviceScaleFactor: 1, mobile: false });
      await evaluate('__pause()');
      expect.soft(await evaluate('__fontChanges')).toBe(0);
      expect.soft(await evaluate('__frames()')).toEqual([]);
      for (const session of sessions) { session.resize.mockClear(); session.nativeResize.mockClear(); }
      const tracks = await evaluate(`(() => {
        __reset(); const divider = document.querySelector('.pane-divider[data-axis="column"]');
        divider.focus(); return JSON.parse(divider.dataset.panes).flat();
      })()`) as string[];
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
      await evaluate('__pause()');
      const frames = await evaluate('__frames()') as { url: string }[];
      expect.soft(frames.length).toBeLessThanOrEqual(tracks.length);
      expect.soft(frames.every(frame => tracks.some(id => frame.url.includes('/' + id + '/stream')))).toBe(true);
      for (const session of sessions) {
        expect.soft(session.resize).not.toHaveBeenCalled();
        expect.soft(session.nativeResize).not.toHaveBeenCalled();
      }
      // A cache hit must still be a fit for today's font settings and display.
      for (const deviceScaleFactor of [1, 1.5, 2]) {
        await send('Emulation.setDeviceMetricsOverride', { width: 1916, height: 1080, deviceScaleFactor, mobile: false });
        await evaluate('__pause()');
        const results = await evaluate(`(() => {
          const client = [...__clients.values()][0], term = client.getTerminal();
          const wrap = term.element.closest('.pane-wrap'), screen = term.element.querySelector('.xterm-screen');
          const results = [];
          for (const options of [{ fontFamily: 'monospace', letterSpacing: 1, lineHeight: 1.5 },
              { fontFamily: 'serif', letterSpacing: 0, lineHeight: 1 }]) {
            Object.assign(term.options, options);
            for (const startingFont of [1, 40]) {
              term.options.fontSize = startingFont;
              const actual = client.floorFontSize();
              let expected = 0;
              for (let font = 1; font <= 40; font++) {
                term.options.fontSize = font;
                if (screen.offsetWidth <= wrap.clientWidth - 12 && screen.offsetHeight <= wrap.clientHeight - 12) expected = font;
              }
              results.push({ actual, expected, startingFont, options });
            }
          }
          return results;
        })()`) as { actual: number; expected: number }[];
        for (const result of results) expect(result.actual, JSON.stringify(result)).toBe(result.expected);
      }
    },
  });
}, 240_000);

it('adopts a grid already owned elsewhere on the first dashboard connection', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const session = await start();
  const external = await connectWs(daemon!.port, session.id, daemon!.token);
  try {
    await external.waitForControl(frame => frame['control'] === 'yours');
    external.ws.send(JSON.stringify({ type: 'resize', cols: 140, rows: 45 }));
    await external.waitForControl(frame => frame['cols'] === 140 && frame['rows'] === 45);
    session.resize.mockClear(); session.nativeResize.mockClear();
    await captureDashboard({ browser, viewerUrl: await open(), width: 600, height: 400, drive: true,
      probeOnly: true, timeoutMs: 60_000, beforeNavigateScript: instrument,
      probe: 'window.__clients?.size === 1', interact: async ({ evaluate }) => {
        await evaluate('__pause()');
        expect.soft(await evaluate('[...__clients.values()][0].getGrid()')).toEqual({ cols: 140, rows: 45 });
        expect.soft(await evaluate('__frames()')).toEqual([]);
        external.close();
        await evaluate(`(async () => { window.dispatchEvent(new Event('resize')); await __pause(); })()`);
        expect.soft(session.resize).not.toHaveBeenCalled();
        expect.soft(session.nativeResize).not.toHaveBeenCalled();
        await evaluate(`(async () => { document.querySelector('button[aria-label="Fit"]').click(); await __pause(); })()`);
        expect(await evaluate('[...__clients.values()][0].getGrid()')).toEqual({ cols: 80, rows: 24 });
      },
    });
  } finally { external.close(); }
}, 120_000);

it.for([null, 'monospace'])('follows a viewer on its first takeover until Fit, Enlarge or a drag takes the pane back (%s)', { timeout: 240_000 }, async (fontFamily, context) => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const session = await start();
  const grant = await api(daemon!.port, daemon!.token, `/sessions/${session.id}/viewer`, { body: {} });
  expect(grant.status).toBe(200);
  const nativeCalls: { cols: number; rows: number; stack: string | undefined }[] = [];
  session.nativeResize.mockImplementation((cols, rows) => {
    nativeCalls.push({ cols, rows, stack: new Error('PTY resize').stack });
    return session.resizePty(cols, rows);
  });
  const viewerInstrument = (fontFamily === null ? instrument : instrument.replace(
    'const client = value.create(config);',
    `const client = value.create(config); client.getTerminal().options.fontFamily = ${JSON.stringify(fontFamily)};`)) + `;(() => {
    window.__viewerResizes = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      try {
        const frame = JSON.parse(data);
        if (frame.type === 'resize') {
          const term = [...__clients.values()][0].getTerminal();
          __viewerResizes.push({ ...frame, stack: new Error('viewer resize').stack,
            font: term.options.fontSize, grid: { cols: term.cols, rows: term.rows },
            dimensions: structuredClone(term._core._renderService.dimensions), dpr: devicePixelRatio });
        }
      } catch { /* Terminal input is not a control frame. */ }
      return send.call(this, data);
    };
  })()`;
  await captureDashboard({ browser, viewerUrl: await open(), width: 750, height: 650, drive: true,
    probeOnly: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
    probe: 'window.__clients?.size === 1', interact: async ({ evaluate }) => {
      await evaluate('__pause()');
      session.nativeResize.mockClear();
      await captureViewer({ browser: browser!, viewerUrl: String(grant.body['viewerUrl']), width: 900, height: 700,
        drive: true, probeOnly: true, timeoutMs: 90_000, beforeNavigateScript: viewerInstrument,
        probe: 'window.__clients?.size === 1', interact: async viewer => {
          await viewer.evaluate('__pause()');
          expect(session.nativeResize).not.toHaveBeenCalled();
          for (const [index, action] of ['Fit', 'Enlarge', 'drag'].entries()) {
            // A fractional cell can cross a column boundary when xterm rounds
            // the whole canvas. Exercise that boundary with the real font.
            const width = fontFamily === null ? 1000 + index * 100 : await viewer.evaluate(`(() => {
              const term = [...__clients.values()][0].getTerminal(), drawn = term.options.fontSize;
              term.options.fontSize = 13;
              const cell = term._core._renderService.dimensions.device.cell.width / devicePixelRatio;
              term.options.fontSize = drawn;
              for (let width = ${1000 + index * 100}; width < ${1600 + index * 100}; width++) {
                const available = width - 30; // Viewer padding and the xterm scrollbar.
                const first = Math.floor(available / (Math.round(cell * term.cols) / term.cols));
                const second = Math.floor(available / (Math.round(cell * first) / first));
                if (first !== second) return width;
              }
              return null;
            })()`);
            expect(width, 'a real fractional cell boundary').toBeTypeOf('number');
            session.resize.mockClear();
            session.nativeResize.mockClear();
            nativeCalls.length = 0;
            await viewer.evaluate('__viewerResizes.length = 0');
            await evaluate('__reset()');
            await viewer.send('Emulation.setDeviceMetricsOverride', {
              width, height: 760 + index * 50, deviceScaleFactor: 1, mobile: false,
            });
            await viewer.evaluate('__pause(2000)');
            const grid = await viewer.evaluate('[...__clients.values()][0].getGrid()') as { cols: number; rows: number };
            expect.soft(await evaluate('[...__clients.values()][0].getGrid()')).toEqual(grid);
            expect.soft(await evaluate('__frames()')).toEqual([]);
            const details = JSON.stringify({ platform: process.platform, action, fontFamily, nativeCalls: nativeCalls.slice(0, 12),
              viewer: await viewer.evaluate('__viewerResizes.slice(0, 12)') });
            expect.soft(session.resize, details).toHaveBeenCalledTimes(1);
            expect.soft(session.nativeResize, details).toHaveBeenCalledTimes(1);
            expect.soft(session.nativeResize.mock.calls[0], details).toEqual([grid.cols, grid.rows]);
            expect.soft(await viewer.evaluate('__viewerResizes.length'), details).toBe(1);
            // Changing the dashboard layout must not take a followed grid either.
            await evaluate(`(async () => { window.dispatchEvent(new Event('resize')); await __pause(); })()`);
            expect.soft(await evaluate('[...__clients.values()][0].getGrid()')).toEqual(grid);
            expect.soft(session.nativeResize, details).toHaveBeenCalledTimes(1);
            if (action === 'drag') await evaluate('[...__clients.values()][0].fitAfterDrag(true)');
            else await evaluate(`document.querySelector('button[aria-label="${action}"]').click()`);
            await evaluate('__pause()');
            expect.soft(await evaluate(`document.querySelector('.pane-size').textContent.includes('following')`)).toBe(false);
          }
        },
      });
    },
  });
});

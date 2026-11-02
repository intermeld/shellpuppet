import { afterEach, beforeAll, expect, it } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let browser: string | null = null;
let running: TestDaemon | null = null;
beforeAll(async () => { browser = await findBrowser(); }, 60_000);
afterEach(async () => { await running?.stop(); running = null; }, 120_000);

async function openDashboard(width: number, height: number, interact: Parameters<typeof captureDashboard>[0]['interact'], script = 'setInterval(() => {}, 1000)') {
  const urls: string[] = [];
  const daemon = running = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  const started = await api(daemon.port, daemon.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', script], shell: false,
    openViewer: false, cols: 100, rows: 30,
  } });
  expect(started.status).toBe(200);
  const id = String(started.body['id']);
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser: browser!, viewerUrl: urls.at(-1)!, width, height,
    drive: true, timeoutMs: 120_000,
    beforeNavigateScript: `(() => {
      window.__resizes = [];
      window.__inputs = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        if (typeof data === 'string' && data.includes('"type":"resize"')) window.__resizes.push(JSON.parse(data));
        else if (typeof data === 'string') window.__inputs.push(data);
        return send.call(this, data);
      };
    })()`,
    probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
      document.querySelector('.pane-size')?.textContent.includes('×') ? true : null)()`,
    interact,
  });
  return { id, daemon, result: shot.probe };
}

it('fills the tile at the 400 column cap with a fixed text choice', async (context) => {
  if (!browser) { context.skip(); return; }
  const { result } = await openDashboard(5000, 1000, async ({ evaluate }) => evaluate(`(async () => {
    document.getElementById('text-smaller').click();
    await new Promise(resolve => setTimeout(resolve, 850));
    const tile = document.querySelector('.pane-term').getBoundingClientRect();
    const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
    return { size: document.querySelector('.pane-size').textContent, font: Number(document.querySelector('.pane-term').dataset.fontSize),
      tileWidth: tile.width, screenWidth: screen.width, tileHeight: tile.height, screenHeight: screen.height,
      screenOffsetWidth: document.querySelector('.xterm-screen').offsetWidth,
      wrapWidth: document.querySelector('.pane-wrap').clientWidth };
  })()`));
  const measured = result as { size: string; font: number; tileWidth: number; screenWidth: number;
    tileHeight: number; screenHeight: number };
  expect(measured.size).toContain('400×');
  expect(measured.font, JSON.stringify(measured)).toBeGreaterThan(12);
  expect(measured.font).toBeLessThanOrEqual(40);
  expect(measured.screenWidth / measured.tileWidth).toBeGreaterThan(0.94);
  expect(measured.screenWidth).toBeLessThanOrEqual(measured.tileWidth + 2);
}, 150_000);

it('stops capped text at 40 px even when the tile could grow it further', async (context) => {
  if (!browser) { context.skip(); return; }
  const { result } = await openDashboard(5000, 1000, async ({ evaluate }) => evaluate(`(async () => {
    document.getElementById('text-smaller').click();
    await new Promise(resolve => setTimeout(resolve, 600));
    document.getElementById('auto-fit').click();
    document.getElementById('panes').style.flex = 'none';
    document.getElementById('panes').style.width = '25000px';
    document.getElementById('panes').style.height = '5000px';
    window.dispatchEvent(new Event('resize'));
    await new Promise(resolve => setTimeout(resolve, 1000));
    return { font: Number(document.querySelector('.pane-term').dataset.fontSize),
      size: document.querySelector('.pane-size').textContent,
      tileWidth: document.querySelector('.pane-term').getBoundingClientRect().width };
  })()`));
  const measured = result as { font: number; size: string; tileWidth: number };
  expect(measured.tileWidth).toBeGreaterThan(24_000);
  expect(measured.size).toContain('400×');
  expect(measured.font, JSON.stringify(measured)).toBe(40);
}, 150_000);

it('refits one outside resize, follows a second, shows held grids whole, and Fit restores text', async (context) => {
  if (!browser) { context.skip(); return; }
  let daemon: TestDaemon;
  let id: string;
  const { result } = await openDashboard(1400, 900, async ({ evaluate }) => {
    // The session id comes from the single visible card; this callback runs after the dashboard is ready.
    id = String(await evaluate(`document.querySelector('.pane').dataset.session`));
    daemon = running!;
    await evaluate(`(async () => { document.getElementById('text-smaller').click();
      await new Promise(resolve => setTimeout(resolve, 650)); window.__resizes.length = 0; })()`);
    expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
      { body: { cols: 194, rows: 100, hold: true } })).status).toBe(200);
    const heldFirst = await evaluate(`(async () => { await new Promise(resolve => setTimeout(resolve, 650));
      return { frames: window.__resizes.slice(), size: document.querySelector('.pane-size').textContent }; })()`);
    await evaluate(`window.__resizes.length = 0`);
    expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
      { body: { cols: 194, rows: 100 } })).status).toBe(200);
    const first = await evaluate(`(async () => { await new Promise(resolve => setTimeout(resolve, 700));
      return { frames: window.__resizes.slice(), size: document.querySelector('.pane-size').textContent }; })()`);
    await evaluate(`window.__resizes.length = 0`);
    expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
      { body: { cols: 210, rows: 110 } })).status).toBe(200);
    const second = await evaluate(`(async () => { await new Promise(resolve => setTimeout(resolve, 700));
      const tile = document.querySelector('.pane-term').getBoundingClientRect();
      const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
      return { frames: window.__resizes.slice(), size: document.querySelector('.pane-size').textContent,
        font: Number(document.querySelector('.pane-term').dataset.fontSize),
        contained: screen.width <= tile.width + 2 && screen.height <= tile.height + 2 }; })()`);
    await evaluate(`window.__resizes.length = 0`);
    expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
      { body: { cols: 220, rows: 115, hold: true } })).status).toBe(200);
    const held = await evaluate(`(async () => { await new Promise(resolve => setTimeout(resolve, 650));
      const tile = document.querySelector('.pane-term').getBoundingClientRect();
      const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
      const wrap = document.querySelector('.pane-wrap');
      return { frames: window.__resizes.slice(), size: document.querySelector('.pane-size').textContent,
        tile: [tile.width, tile.height], screen: [screen.width, screen.height],
        font: Number(document.querySelector('.pane-term').dataset.fontSize),
        scrolls: getComputedStyle(wrap).overflow === 'auto',
        contained: screen.width <= tile.width + 2 && screen.height <= tile.height + 2 }; })()`);
    const stripSession = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
      openViewer: false, cols: 220, rows: 115, hold: true,
    } });
    expect(stripSession.status).toBe(200);
    const narrowHeld = await evaluate(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 450));
      document.querySelector('.pane').click();
      document.getElementById('focus').click();
      await new Promise(resolve => setTimeout(resolve, 700));
      const card = document.querySelector('#strip .pane');
      if (!card) return { error: 'no strip pane', layout: document.getElementById('panes').className };
      if (!card.querySelector('.xterm-screen')) return { error: 'strip pane has no screen', layout: document.getElementById('panes').className };
      const tile = card.querySelector('.pane-term').getBoundingClientRect();
      const screenElement = card.querySelector('.xterm-screen');
      const screen = screenElement.getBoundingClientRect();
      const wrap = card.querySelector('.pane-wrap');
      const result = { tile: [tile.width, tile.height], screen: [screen.width, screen.height],
        font: Number(card.querySelector('.pane-term').dataset.fontSize),
        scrollWidth: wrap.scrollWidth, clientWidth: wrap.clientWidth,
        scrollHeight: wrap.scrollHeight, clientHeight: wrap.clientHeight,
        overflow: getComputedStyle(wrap).overflow,
        note: card.querySelector('.pane-overflow-note')?.textContent || '',
        noteWidth: card.querySelector('.pane-overflow-note')?.scrollWidth,
        noteClientWidth: card.querySelector('.pane-overflow-note')?.clientWidth,
        noteOverflow: getComputedStyle(card.querySelector('.pane-overflow-note')).textOverflow,
        stripWidth: card.getBoundingClientRect().width };
      wrap.scrollLeft = wrap.scrollWidth; wrap.scrollTop = wrap.scrollHeight;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const end = screenElement.getBoundingClientRect();
      const viewport = wrap.getBoundingClientRect();
      result.reachable = wrap.scrollLeft > 0 && wrap.scrollTop > 0 &&
        end.right <= viewport.right + 2 && end.bottom <= viewport.bottom + 2;
      return result;
    })()`);
    expect((await api(daemon.port, daemon.token, `/sessions/${id}/resize`,
      { body: { cols: 220, rows: 115 } })).status).toBe(200);
    const fit = await evaluate(`(async () => { document.querySelector('.pane button[aria-label="Fit"]').click();
      await new Promise(resolve => setTimeout(resolve, 500));
      return { font: Number(document.querySelector('.pane-term').dataset.fontSize),
        size: document.querySelector('.pane-size').textContent }; })()`);
    return { heldFirst, first, second, held, narrowHeld, fit };
  });
  const measured = result as { heldFirst: { frames: unknown[]; size: string }; first: { frames: unknown[]; size: string };
    second: { frames: unknown[]; size: string; font: number; contained: boolean };
    held: { frames: unknown[]; size: string; font: number; scrolls: boolean; contained: boolean };
    narrowHeld: { tile: number[]; screen: number[]; font: number; scrollWidth: number; clientWidth: number;
      scrollHeight: number; clientHeight: number; overflow: string; note: string; stripWidth: number;
      noteWidth: number; noteClientWidth: number; noteOverflow: string;
      reachable: boolean }; fit: { font: number; size: string } };
  expect(measured.heldFirst.frames).toHaveLength(0);
  expect(measured.heldFirst.size).toContain('fixed');
  expect(measured.first.frames).toHaveLength(1);
  expect(measured.first.size).not.toContain('194×100');
  expect(measured.second.frames).toHaveLength(0);
  expect(measured.second.size).toContain('following');
  expect(measured.second.contained).toBe(true);
  expect(measured.second.font).toBeLessThan(12);
  expect(measured.held.frames).toHaveLength(0);
  expect(measured.held.size).toContain('fixed');
  expect(measured.held.contained || (measured.held.font === 6 && measured.held.scrolls), JSON.stringify(measured)).toBe(true);
  expect(measured.narrowHeld.font, JSON.stringify(measured)).toBe(6);
  expect(measured.narrowHeld.stripWidth).toBeCloseTo(300, 0);
  expect(measured.narrowHeld.scrollWidth).toBeGreaterThan(measured.narrowHeld.clientWidth);
  expect(measured.narrowHeld.scrollHeight).toBeGreaterThan(measured.narrowHeld.clientHeight);
  expect(measured.narrowHeld.overflow).toBe('auto');
  expect(measured.narrowHeld.note).toContain('Shift+wheel');
  expect(measured.narrowHeld.noteWidth).toBeLessThanOrEqual(measured.narrowHeld.noteClientWidth);
  expect(measured.narrowHeld.noteOverflow).not.toBe('ellipsis');
  expect(measured.narrowHeld.reachable, JSON.stringify(measured)).toBe(true);
  expect(measured.fit.font).toBe(12);
}, 150_000);

it('keeps plain alternate-screen wheel input in the app and scrolls overflow with Shift or deltaX', async (context) => {
  if (!browser) { context.skip(); return; }
  const tui = `process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h'); setInterval(() => {}, 1000);`;
  const { result } = await openDashboard(1400, 900, async ({ evaluate, send }) => {
    const daemon = running!;
    const held = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', tui], shell: false,
      openViewer: false, cols: 220, rows: 115, hold: true,
    } });
    expect(held.status).toBe(200);
    const geometry = await evaluate(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      document.querySelector('.pane').click(); document.getElementById('focus').click();
      await new Promise(resolve => setTimeout(resolve, 700));
      const card = document.querySelector('#strip .pane');
      const wrap = card.querySelector('.pane-wrap');
      const rect = wrap.getBoundingClientRect();
      window.__inputs.length = 0;
      return { x: rect.left + 45, y: rect.top + 45,
        maxX: wrap.scrollWidth - wrap.clientWidth, maxY: wrap.scrollHeight - wrap.clientHeight };
    })()`) as { x: number; y: number; maxX: number; maxY: number };
    const wheel = async (deltaX: number, deltaY: number, modifiers = 0) => send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: geometry.x, y: geometry.y, deltaX, deltaY, modifiers,
    });
    await wheel(0, 100);
    const plain = await evaluate(`(async () => { await new Promise(resolve => setTimeout(resolve, 100));
      const wrap = document.querySelector('#strip .pane-wrap');
      return { x: wrap.scrollLeft, y: wrap.scrollTop, inputs: window.__inputs.slice() }; })()`);
    await wheel(0, 100, 8);
    const shifted = await evaluate(`(async () => { await new Promise(resolve => setTimeout(resolve, 100));
      const wrap = document.querySelector('#strip .pane-wrap');
      return { x: wrap.scrollLeft, y: wrap.scrollTop, inputs: window.__inputs.slice() }; })()`);
    await wheel(100, 0);
    const horizontal = await evaluate(`(async () => { await new Promise(resolve => setTimeout(resolve, 100));
      const wrap = document.querySelector('#strip .pane-wrap');
      return { x: wrap.scrollLeft, y: wrap.scrollTop, inputs: window.__inputs.slice() }; })()`);
    return { geometry, plain, shifted, horizontal };
  }, tui);
  const measured = result as { geometry: { maxX: number; maxY: number };
    plain: { x: number; y: number; inputs: string[] };
    shifted: { x: number; y: number; inputs: string[] };
    horizontal: { x: number; y: number; inputs: string[] } };
  expect(measured.geometry.maxX).toBeGreaterThan(0);
  expect(measured.geometry.maxY).toBeGreaterThan(0);
  expect(measured.plain.inputs.length).toBeGreaterThan(0);
  expect(measured.plain.y).toBe(0);
  expect(measured.shifted.y).toBeGreaterThan(0);
  expect(measured.shifted.inputs).toHaveLength(measured.plain.inputs.length);
  expect(measured.horizontal.x).toBeGreaterThan(0);
  expect(measured.horizontal.inputs).toHaveLength(measured.shifted.inputs.length);
}, 150_000);

it('keeps a scrolled view steady during click, text entry and cell selection', async (context) => {
  if (!browser) { context.skip(); return; }
  const screen = `process.stdin.setRawMode(true); process.stdout.write('\\x1b[?1049h'); for (let row = 0; row < 115; row++) process.stdout.write('ROW' + String(row).padStart(3, '0') + ':' + String(row % 10).repeat(210) + (row < 114 ? '\\r\\n' : '')); process.stdin.on('data', data => process.stdout.write('\\x1b[100;1HRECEIVED:' + data));`;
  const { result } = await openDashboard(1400, 900, async ({ evaluate, send }) => {
    const daemon = running!;
    const held = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', screen], shell: false,
      openViewer: false, cols: 220, rows: 115, hold: true,
    } });
    expect(held.status).toBe(200);
    const point = await evaluate(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      document.querySelector('.pane').click(); document.getElementById('focus').click();
      await new Promise(resolve => setTimeout(resolve, 700));
      const card = document.querySelector('#strip .pane');
      const wrap = card.querySelector('.pane-wrap');
      wrap.scrollLeft = 250; wrap.scrollTop = 250;
      await new Promise(resolve => requestAnimationFrame(resolve));
      const rect = wrap.getBoundingClientRect();
      const screenRect = card.querySelector('.xterm-screen').getBoundingClientRect();
      const x = rect.left + 75;
      const y = rect.top + Math.min(20, rect.height / 2);
      return { x, y, left: wrap.scrollLeft, top: wrap.scrollTop,
        target: document.elementFromPoint(x, y)?.className,
        screen: [screenRect.left, screenRect.top, screenRect.right, screenRect.bottom],
        wrap: [rect.left, rect.top, rect.right, rect.bottom] };
    })()`) as { x: number; y: number; left: number; top: number };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await send('Input.insertText', { text: 'Wispr probe' });
    const afterText = await evaluate(`(async () => { await new Promise(resolve => setTimeout(resolve, 700));
      const wrap = document.querySelector('#strip .pane-wrap');
      return { left: wrap.scrollLeft, top: wrap.scrollTop, received: document.querySelector('#strip .xterm-rows')?.textContent.includes('RECEIVED:Wispr probe'),
        active: [document.activeElement?.tagName, document.activeElement?.className], inputs: window.__inputs.slice(),
        rowText: document.querySelector('#strip .xterm-rows')?.textContent.slice(0, 80) }; })()`);
    const stream = await api(daemon.port, daemon.token, `/sessions/${String(held.body['id'])}/snapshot`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 35, y: point.y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 35, y: point.y, button: 'left', clickCount: 1 });
    const selected = await evaluate(`(() => {
      const wrap = document.querySelector('#strip .pane-wrap');
      let copied = '';
      document.addEventListener('copy', event => { copied = event.clipboardData?.getData('text/plain') || ''; }, { once: true });
      document.execCommand('copy');
      const row = [...document.querySelectorAll('#strip .xterm-rows > div')].find(line => {
        const box = line.getBoundingClientRect();
        return box.top <= ${point.y} && ${point.y} < box.bottom;
      });
      return { left: wrap.scrollLeft, top: wrap.scrollTop, selection: copied,
        underPointer: row?.textContent.match(/ROW\\d{3}:(\\d)/)?.[1],
        text: document.querySelector('#strip .xterm-rows')?.textContent.slice(0, 100) };
    })()`);
    return { point, afterText, selected, stream: { status: stream.status,
      received: JSON.stringify(stream.body).includes('RECEIVED:Wispr probe'),
      first: JSON.stringify(stream.body).slice(0, 200) } };
  }, screen);
  const measured = result as { point: { left: number; top: number };
    afterText: { left: number; top: number; received: boolean };
    selected: { left: number; top: number; selection: string; underPointer: string; text: string } };
  expect(measured.point.left).toBeGreaterThan(0);
  expect(measured.point.top).toBeGreaterThan(0);
  expect(measured.afterText.received, JSON.stringify(measured)).toBe(true);
  expect(measured.afterText.left).toBe(measured.point.left);
  expect(measured.afterText.top).toBe(measured.point.top);
  expect(measured.selected.left).toBe(measured.point.left);
  expect(measured.selected.top).toBe(measured.point.top);
  expect(measured.selected.selection.length).toBeGreaterThan(0);
  expect(measured.selected.selection).toMatch(new RegExp(`^${measured.selected.underPointer}+$`));
}, 150_000);

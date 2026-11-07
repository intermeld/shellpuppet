import { afterEach, beforeAll, expect, it } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, eventually, startTestDaemon } from './helpers.js';
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

it('shows the short coloured TUI text boundary inside the same grid and canvas as a full field', async (context) => {
  if (!browser) { context.skip(); return; }
  const urls: string[] = [];
  const daemon = running = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  const ids: string[] = [];
  for (const width of [129, 80]) {
    const script = `process.stdout.write('\\x1b[?1049h\\x1b[1;1H\\x1b[48;2;40;70;90m' +
      '${width === 129 ? 'F' : 'N'}'.repeat(${width - 1}) + '|\\x1b[0m'); setInterval(() => {}, 1000)`;
    const started = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', script], shell: false,
      openViewer: false, cols: 129, rows: 49, hold: true,
    } });
    expect(started.status).toBe(200);
    ids.push(String(started.body['id']));
  }
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
  const shot = await captureDashboard({ browser, viewerUrl: urls.at(-1)!, width: 1920, height: 1080,
    drive: true, timeoutMs: 120_000,
    probe: `(() => [...document.querySelectorAll('.pane-size')].length === 2 &&
      [...document.querySelectorAll('.pane-size')].every(node => node.textContent.includes('129×49')) ? true : null)()`,
    interact: async ({ evaluate }) => evaluate(`(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if ([...document.querySelectorAll('.pane')].length === 2 &&
            [...document.querySelectorAll('.pane')].every(card => card.querySelector('.xterm-rows > div')?.textContent.includes('|'))) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return [...document.querySelectorAll('.pane')].map(card => ({
        id: card.dataset.session,
        size: card.querySelector('.pane-size').textContent,
        font: card.querySelector('.pane-term').dataset.fontSize,
        canvas: card.querySelector('.xterm-screen').offsetWidth,
        first: card.querySelector('.xterm-rows > div').textContent,
      }));
    })()`),
  });
  const panes = shot.probe as { id: string; size: string; font: string; canvas: number; first: string }[];
  expect(panes.map((pane) => pane.id)).toEqual(ids);
  expect(panes[0]?.size).toBe(panes[1]?.size);
  expect(panes[0]?.font).toBe(panes[1]?.font);
  expect(panes[0]?.canvas).toBe(panes[1]?.canvas);
  const snapshots = await Promise.all(ids.map((id) => api(daemon.port, daemon.token, `/sessions/${id}/snapshot`)));
  expect(snapshots.map((snapshot) => snapshot.status)).toEqual([200, 200]);
  expect(String(snapshots[0]!.body['screen']).split('\n')[0]?.indexOf('|')).toBe(128);
  expect(String(snapshots[1]!.body['screen']).split('\n')[0]?.indexOf('|')).toBe(79);
  expect(panes[0]?.first.indexOf('|')).toBe(128);
  expect(panes[1]?.first.indexOf('|')).toBe(79);
}, 150_000);

it('repaints an idle full-screen program from the daemon after narrowing and widening', async (context) => {
  if (!browser) { context.skip(); return; }
  const script = `process.stdout.write('\\x1b[?1049h'); for (let row = 0; row < 25; row++)
    process.stdout.write('\\x1b[' + (row + 1) + ';1HROW' + String(row).padStart(2, '0') +
      ':' + String(row % 10).repeat(85)); setInterval(() => {}, 1000)`;
  const { result } = await openDashboard(1400, 900, async ({ evaluate }) => {
    const id = String(await evaluate(`document.querySelector('.pane').dataset.session`));
    await evaluate(`document.getElementById('auto-fit').click()`);
    await eventually(async () => {
      const snapshot = await api(running!.port, running!.token, `/sessions/${id}/snapshot`);
      return String(snapshot.body['screen']).includes('ROW00:') && String(snapshot.body['screen']).includes('ROW24:');
    });
    const before = await api(running!.port, running!.token, `/sessions/${id}/snapshot`);
    expect(before.status).toBe(200);
    expect((await api(running!.port, running!.token, `/sessions/${id}/resize`,
      { body: { cols: 80, rows: 24 } })).status).toBe(200);
    await eventually(async () => {
      const snapshot = await api(running!.port, running!.token, `/sessions/${id}/snapshot`);
      return snapshot.body['cols'] === 80 && snapshot.body['rows'] === 24 &&
        snapshot.body['screen'] !== before.body['screen'];
    });
    expect((await api(running!.port, running!.token, `/sessions/${id}/resize`,
      { body: { cols: 100, rows: 30 } })).status).toBe(200);
    await eventually(async () => {
      const snapshot = await api(running!.port, running!.token, `/sessions/${id}/snapshot`);
      return snapshot.body['cols'] === 100 && snapshot.body['rows'] === 30;
    });
    await evaluate(`(async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (document.querySelector('.pane-size')?.textContent.includes('100×30')) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    })()`);
    const after = await api(running!.port, running!.token, `/sessions/${id}/snapshot`);
    expect(after.status).toBe(200);
    const expectedRows = String(after.body['screen']).split('\n').map((row) => row.trimEnd());
    const pane = await evaluate(`(async () => {
      const expected = ${JSON.stringify(expectedRows)};
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = [...document.querySelectorAll('.xterm-rows > div')].map(row => row.textContent.trimEnd());
        if (rows.slice(0, expected.length).every((row, index) => row === expected[index]))
          return { size: document.querySelector('.pane-size').textContent, rows };
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { size: document.querySelector('.pane-size').textContent,
        rows: [...document.querySelectorAll('.xterm-rows > div')].map(row => row.textContent.trimEnd()) };
    })()`);
    return { before: String(before.body['screen']), after: String(after.body['screen']), pane };
  }, script);
  const measured = result as { before: string; after: string;
    pane: { size: string; rows: string[] } };
  expect(measured.pane.size).toContain('100×30');
  const daemonRows = measured.after.split('\n').map((row) => row.trimEnd());
  expect(measured.pane.rows.slice(0, daemonRows.length)).toEqual(daemonRows);
  expect(measured.pane.rows.slice(daemonRows.length).every((row) => row === '')).toBe(true);
  expect(measured.after).not.toBe(measured.before);
}, 150_000);

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

it('follows the first outside resize, shows held grids whole, and Fit restores text', async (context) => {
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
      const end = screenElement.getBoundingClientRect();
      const viewport = wrap.getBoundingClientRect();
      result.reachable = end.left >= viewport.left && end.top >= viewport.top &&
        end.right <= viewport.right && end.bottom <= viewport.bottom;
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
  expect(measured.first.frames).toHaveLength(0);
  expect(measured.first.size).toBe('194×100 (following)');
  expect(measured.second.frames).toHaveLength(0);
  expect(measured.second.size).toContain('following');
  expect(measured.second.contained).toBe(true);
  expect(measured.second.font).toBeLessThan(12);
  expect(measured.held.frames).toHaveLength(0);
  expect(measured.held.size).toContain('fixed');
  expect(measured.held.contained, JSON.stringify(measured)).toBe(true);
  expect(measured.narrowHeld.font, JSON.stringify(measured)).toBeLessThan(6);
  expect(measured.narrowHeld.stripWidth).toBeCloseTo(300, 0);
  expect(measured.narrowHeld.screen[0]).toBeLessThanOrEqual(measured.narrowHeld.tile[0]!);
  expect(measured.narrowHeld.screen[1]).toBeLessThanOrEqual(measured.narrowHeld.tile[1]!);
  expect(measured.narrowHeld.overflow).toBe('clip');
  expect(measured.narrowHeld.reachable, JSON.stringify(measured)).toBe(true);
  expect(measured.fit.font).toBe(12);
}, 150_000);

it('keeps alternate-screen wheel input in the app with the whole held grid visible', async (context) => {
  if (!browser) { context.skip(); return; }
  const tui = `setTimeout(() => process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006hREADY'), 4000); setInterval(() => {}, 1000);`;
  const { result } = await openDashboard(1400, 900, async ({ evaluate, send }) => {
    const daemon = running!;
    const held = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', tui], shell: false,
      openViewer: false, cols: 220, rows: 115, hold: true,
    } });
    expect(held.status).toBe(200);
    const geometry = await evaluate(`(async () => {
      document.querySelector('.pane').click(); document.getElementById('focus').click();
      let lastGeometry;
      for (let attempt = 0; attempt < 100; attempt++) {
        const card = document.querySelector('#strip .pane');
        const screen = card?.querySelector('.xterm-screen')?.getBoundingClientRect();
        const tile = card?.querySelector('.pane-term')?.getBoundingClientRect();
        lastGeometry = { whole: screen && tile && screen.width <= tile.width && screen.height <= tile.height };
        if (lastGeometry.whole) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!lastGeometry?.whole)
        throw new Error('Timed out waiting for the whole held grid; last observed: ' + JSON.stringify(lastGeometry));
      const card = document.querySelector('#strip .pane');
      const wrap = card.querySelector('.pane-wrap');
      const rect = card.querySelector('.xterm-screen').getBoundingClientRect();
      window.__inputs.length = 0;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
        maxX: wrap.scrollWidth - wrap.clientWidth, maxY: wrap.scrollHeight - wrap.clientHeight };
    })()`) as { x: number; y: number; maxX: number; maxY: number };
    let readyText: unknown;
    await eventually(async () => {
      readyText = await evaluate(`document.querySelector('#strip .xterm-rows')?.textContent`);
      return String(readyText).includes('READY');
    }, 10_000, 100, 'READY in the alternate screen', () => readyText);
    const wheel = async (deltaX: number, deltaY: number, modifiers = 0) => send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: geometry.x, y: geometry.y, deltaX, deltaY, modifiers,
    });
    await wheel(0, 100);
    let inputCount = 0;
    await eventually(async () => (inputCount = Number(await evaluate('window.__inputs.length'))) > 0,
      5_000, 100, 'plain wheel input', () => inputCount);
    const plain = await evaluate(`(() => {
      const wrap = document.querySelector('#strip .pane-wrap');
      return { x: wrap.scrollLeft, y: wrap.scrollTop, inputs: window.__inputs.slice() }; })()`);
    return { geometry, plain };
  }, tui);
  const measured = result as { geometry: { maxX: number; maxY: number };
    plain: { x: number; y: number; inputs: string[] } };
  expect(measured.plain.inputs.length).toBeGreaterThan(0);
  expect(measured.plain.y).toBe(0);
  expect(measured.plain.x).toBe(0);
}, 150_000);

it('keeps the whole held screen steady during click, text entry and cell selection', async (context) => {
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
      await new Promise(resolve => requestAnimationFrame(resolve));
      const rect = wrap.getBoundingClientRect();
      const screenRect = card.querySelector('.xterm-screen').getBoundingClientRect();
      // MouseEvent coordinates use whole CSS pixels. With rows below a
      // pixel, measure the row under the coordinate the browser will receive.
      const x = Math.round(screenRect.left + screenRect.width / 2);
      const y = Math.round(screenRect.top + screenRect.height * 30.5 / 115);
      return { x, y, dx: screenRect.width * 20 / 220, left: wrap.scrollLeft, top: wrap.scrollTop,
        target: document.elementFromPoint(x, y)?.className,
        screen: [screenRect.left, screenRect.top, screenRect.right, screenRect.bottom],
        wrap: [rect.left, rect.top, rect.right, rect.bottom] };
    })()`) as { x: number; y: number; dx: number; left: number; top: number };
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
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + point.dx, y: point.y, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + point.dx, y: point.y, button: 'left', clickCount: 1 });
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
  expect(measured.point.left).toBe(0);
  expect(measured.point.top).toBe(0);
  expect(measured.afterText.received, JSON.stringify(measured)).toBe(true);
  expect(measured.afterText.left).toBe(measured.point.left);
  expect(measured.afterText.top).toBe(measured.point.top);
  expect(measured.selected.left).toBe(measured.point.left);
  expect(measured.selected.top).toBe(measured.point.top);
  expect(measured.selected.selection.length).toBeGreaterThan(0);
  expect(measured.selected.selection).toMatch(new RegExp(`^${measured.selected.underPointer}+$`));
}, 150_000);

it('places IME composition at the cursor with a whole held grid and a scrolled strip', async (context) => {
  if (!browser) { context.skip(); return; }
  const { result } = await openDashboard(1400, 900, async ({ evaluate, send }) => {
    const held = await api(running!.port, running!.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', "process.stdout.write('\\x1b[?1049h\\x1b[30;80H'); process.stdin.setRawMode(true); process.stdin.resume()"],
      shell: false, openViewer: false, cols: 220, rows: 115, hold: true,
    } });
    expect(held.status).toBe(200);
    const point = await evaluate(`(async () => {
      await new Promise(resolve => setTimeout(resolve, 750));
      document.querySelector('.pane').click(); document.getElementById('focus').click();
      await new Promise(resolve => setTimeout(resolve, 700));
      const strip = document.getElementById('strip');
      strip.style.height = '100px'; strip.style.flex = 'none'; strip.scrollTop = 40;
      const wrap = strip.querySelector('.pane-wrap');
      await new Promise(resolve => requestAnimationFrame(resolve));
      const card = strip.querySelector('.pane');
      card.querySelector('.xterm-helper-textarea').focus();
      const screen = card.querySelector('.xterm-screen').getBoundingClientRect();
      const tile = card.querySelector('.pane-term').getBoundingClientRect();
      return { whole: screen.width <= tile.width && screen.height <= tile.height, left: wrap.scrollLeft,
        top: wrap.scrollTop, stripTop: strip.scrollTop };
    })()`) as { left: number; top: number; stripTop: number };
    await send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
    const composing = await evaluate(`(() => {
      const card = document.querySelector('#strip .pane');
      const wrap = card.querySelector('.pane-wrap');
      const textarea = card.querySelector('.xterm-helper-textarea');
      const style = getComputedStyle(textarea);
      return { left: wrap.scrollLeft, top: wrap.scrollTop,
        stripTop: document.getElementById('strip').scrollTop,
        inlineLeft: textarea.style.left, inlineTop: textarea.style.top,
        computedLeft: style.left, computedTop: style.top, position: style.position };
    })()`);
    await send('Input.insertText', { text: '日本' });
    const after = await evaluate(`(() => {
      const wrap = document.querySelector('#strip .pane-wrap');
      return { left: wrap.scrollLeft, top: wrap.scrollTop,
        stripTop: document.getElementById('strip').scrollTop };
    })()`);
    return { point, composing, after };
  });
  const measured = result as { point: { whole: boolean; left: number; top: number; stripTop: number };
    composing: { left: number; top: number; stripTop: number; inlineLeft: string; inlineTop: string;
      computedLeft: string; computedTop: string; position: string };
    after: { left: number; top: number; stripTop: number } };
  expect(measured.point.left).toBe(0);
  expect(measured.point.top).toBe(0);
  expect(measured.point.stripTop).toBeGreaterThan(0);
  expect(measured.point.whole).toBe(true);
  expect(measured.composing.inlineLeft).not.toBe('');
  expect(measured.composing.inlineTop).not.toBe('');
  expect(measured.composing.computedLeft, JSON.stringify(measured)).toBe(measured.composing.inlineLeft);
  expect(measured.composing.computedTop, JSON.stringify(measured)).toBe(measured.composing.inlineTop);
  expect(measured.composing.position).toBe('absolute');
  expect([measured.composing.left, measured.composing.top, measured.composing.stripTop]).toEqual(
    [measured.point.left, measured.point.top, measured.point.stripTop]);
  expect([measured.after.left, measured.after.top, measured.after.stripTop]).toEqual(
    [measured.point.left, measured.point.top, measured.point.stripTop]);
}, 150_000);

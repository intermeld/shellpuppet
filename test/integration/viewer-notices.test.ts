import { beforeAll, describe, expect, it } from 'vitest';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { eventually } from './helpers.js';
import { withNoticePage, type NoticePage } from './noticePage.js';

let browser: string | null;
beforeAll(async () => { browser = await findBrowser(); });

async function key(page: NoticePage, key: string, code: string, virtual: number, modifiers = 0) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtual, modifiers });
  }
}

async function holdMatchingReplay(page: NoticePage, sessionId: string) {
  const id = JSON.stringify(sessionId);
  await page.evaluate(`(() => {
    const original = streams.get(${id});
    window.afterNoticeOpen = (id, socket) => {
      if (id !== ${id}) return;
      const deliver = socket.onmessage;
      socket.onmessage = event => {
        const frame = typeof event.data === 'string' && JSON.parse(event.data);
        if (frame.type === 'prompt-stall' && frame.since === original.prompt.since) {
          window.releaseReplay = () => deliver.call(socket, event);
        } else deliver.call(socket, event);
      };
    };
    original.close();
  })()`);
  await eventually(async () => await page.evaluate(`typeof releaseReplay === 'function' && parts(${id}).button.hidden`) === true,
  15_000, 50, 'matching prompt held on the replacement socket');
}

describe.each(['viewer', 'dashboard'])('%s waiting notice', mode => {
  it('anchors both prompt positions and isolates mouse and keyboard disclosure from the terminal', async context => {
    if (!browser) { context.skip(); return; }
    const result = await withNoticePage(browser, mode, async (page, ids, input) => {
      const { evaluate, send } = page;
      await evaluate(`void Object.assign(window, parts(${JSON.stringify(ids[0])}))`);
      const state = () => evaluate(`(() => {
        const heading = button.getBoundingClientRect(), body = stack.getBoundingClientRect();
        const viewport = stack.parentElement.getBoundingClientRect(), screen = term.element.querySelector('.xterm-screen').getBoundingClientRect();
        return { expanded: button.getAttribute('aria-expanded'), hidden: alert.hidden,
          top: Math.abs(body.top - viewport.top) <= 1, clear: heading.bottom <= screen.top + 1,
          slim: heading.height > 0 && heading.height <= 22, focused: document.activeElement === button };
      })()`);
      const row = async (number: number) => eventually(async () =>
        await evaluate(`term.buffer.active.cursorY === ${String(number)} && term.buffer.active.getLine(0)?.translateToString().includes('Permission Required')`) === true,
      10_000, 30, 'upper prompt snapshot');
      await row(0);
      const upper = await state();
      const statusNode = await send('Runtime.evaluate', { expression: "alert.closest('[role=status]')" }) as {
        result: { objectId: string };
      };
      const { nodes } = await send('Accessibility.queryAXTree', { objectId: statusNode.result.objectId, role: 'StaticText' }) as {
        nodes: { ignored: boolean; name?: { value?: string } }[];
      };
      const spoken = nodes.filter(node => !node.ignored).map(node => node.name?.value);
      const announcement = await evaluate(`(() => {
        const regions = [...root.querySelectorAll('[role="status"], [role="alert"], [aria-live]')].filter(region =>
          !region.closest('[hidden], [aria-hidden="true"]') && region.getClientRects().length &&
          (region.textContent.includes(button.textContent) || region.textContent.includes(socket.prompt.question)));
        const status = regions[0];
        const observer = new MutationObserver(() => {});
        if (status) observer.observe(status, { childList: true, subtree: true, characterData: true });
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(socket.prompt) }));
        const repeatChanges = observer.takeRecords().length;
        observer.disconnect();
        return { count: regions.length, repeatChanges, polite: (status?.getAttribute('aria-live') ??
          (status?.getAttribute('role') === 'status' ? 'polite' : null)) === 'polite',
          complete: [button.textContent, socket.prompt.question, ...socket.prompt.options]
            .every(text => ${JSON.stringify(spoken)}.includes(text)) };
      })()`);
      await input('b');
      await eventually(async () => await evaluate("term.buffer.active.cursorY === 23 && term.buffer.active.getLine(23).translateToString().includes('Reject')") === true,
        10_000, 30, 'lower prompt repaint');
      const lower = await state();
      await evaluate('socket.sent.length = 0; window.gridBefore = [term.cols, term.rows, stack.parentElement.clientHeight].join()');
      const point = await evaluate('(() => { const r = button.getBoundingClientRect(); return { x: r.left + 12, y: r.top + r.height / 2 }; })()') as { x: number; y: number };
      const click = async () => {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
        }
      };
      await click();
      const folded = await state();
      await click();
      const mouseOpen = await state();
      await click();
      const otherExpanded = ids.length === 1 || await evaluate(`parts(${JSON.stringify(ids[1])}).button.getAttribute('aria-expanded') === 'true'`);
      await key(page, 'Tab', 'Tab', 9, 8);
      const leftButton = await evaluate('document.activeElement !== button');
      await key(page, 'Tab', 'Tab', 9);
      const returned = await evaluate('document.activeElement === button');
      await key(page, 'Enter', 'Enter', 13);
      const keyboardOpen = await state();
      await key(page, ' ', 'Space', 32);
      const keyboardClosed = await state();
      // Enter with a carriage return can also generate native button activation.
      // Holding it should produce just one click across keydown, repeat and keyup.
      await evaluate("window.enterClicks = 0; button.addEventListener('click', () => window.enterClicks++)");
      const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, text: '\r' });
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, text: '\r', autoRepeat: true });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
      const enterClicks = await evaluate('window.enterClicks');
      const heldEnterOpen = await state();
      await key(page, 'Enter', 'Enter', 13);
      const sameGrid = await evaluate('gridBefore === [term.cols, term.rows, stack.parentElement.clientHeight].join()');
      const sent = await evaluate("socket.sent.filter(data => typeof data !== 'string' || !data.startsWith('{') || JSON.parse(data).type !== 'layout')");
      await input('t');
      await row(0);
      const repainted = await state();
      const firstSince = await evaluate('socket.prompt.since');
      await input('c');
      await eventually(async () => await evaluate('button.hidden && alert.hidden') === true);
      await input('t');
      await eventually(async () => await evaluate('!button.hidden && !alert.hidden') === true);
      const identical = await evaluate(`socket.prompt.since > ${String(firstSince)} && button.getAttribute('aria-expanded') === 'true'`);
      await evaluate('button.click()');
      await input('n');
      await eventually(async () => await evaluate("!alert.hidden && alert.textContent.includes('Replace this file?')") === true);
      return { upper, lower, announcement, folded, mouseOpen, sameGrid, otherExpanded, leftButton, returned, keyboardOpen, keyboardClosed,
        enterClicks, heldEnterOpen, sent, repainted, identical, heading: await evaluate('button.textContent'), different: await state() };
    }, { count: mode === 'dashboard' ? 2 : 1 });
    const open = { expanded: 'true', hidden: false, top: true };
    const closed = { expanded: 'false', hidden: true, slim: true, clear: true };
    expect(result).toMatchObject({ upper: open, lower: open, mouseOpen: open, sameGrid: true, folded: { ...closed, focused: true }, otherExpanded: true,
      leftButton: true, returned: true, keyboardOpen: { ...open, focused: true }, keyboardClosed: { ...closed, focused: true },
      enterClicks: 1, heldEnterOpen: { ...open, focused: true }, sent: [], repainted: closed, identical: true, different: open });
    expect((result as { heading: string }).heading).toMatch(/^Waiting for you: \d+s unanswered$/);
    expect(result).toMatchObject({ announcement: { count: 1, polite: true, complete: true, repeatChanges: 0 } });
  }, 230_000);

  it('uses the pane height and scrolls a long list to its last option', async context => {
    if (!browser) { context.skip(); return; }
    const result = await withNoticePage(browser, mode, async ({ evaluate, send }, ids) => {
      await send('Emulation.setScrollbarsHidden', { hidden: false });
      await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 560, deviceScaleFactor: 1, mobile: false });
      await evaluate(`void Object.assign(window, parts(${JSON.stringify(ids[0])}))`);
      await evaluate(`window.showOptions = count => {
        const frame = { ...socket.prompt, options: Array.from({length:count}, (_,i) => 'Synthetic option ' + (i+1)) };
        socket.dispatchEvent(new MessageEvent('message', {data:JSON.stringify(frame)}));
      }`);
      const measure = () => evaluate(`(() => {
        const box = stack.getBoundingClientRect(), viewport = stack.parentElement.getBoundingClientRect();
        const last = alert.querySelector('li:last-child').getBoundingClientRect(), css = getComputedStyle(stack);
        return { beyondThird: box.height > viewport.height / 3, fits: stack.scrollHeight === stack.clientHeight,
          overflow: css.overflowY, gutter: stack.offsetWidth - stack.clientWidth - parseFloat(css.borderLeftWidth) - parseFloat(css.borderRightWidth),
          offset: stack.scrollTop, lastVisible: last.bottom <= box.bottom + 1 && last.top >= box.top,
          top: Math.abs(box.top - viewport.top) <= 1, heading: button.getBoundingClientRect().bottom <= box.top + 1 };
      })()`);
      // Find the first natural list taller than one third; keep the viewport fixed afterwards.
      await evaluate(`for (let count = 2; count <= 80; count++) {
        showOptions(count);
        if (stack.scrollHeight > stack.parentElement.clientHeight / 3 + 4) break;
      }`);
      await evaluate('stack.scrollTop = 99999');
      const fits = await measure();
      await send('Emulation.setTouchEmulationEnabled', { enabled: true });
      const hitNotice = () => evaluate(`(() => {
        const r = alert.querySelector('.question').getBoundingClientRect();
        return stack.contains(document.elementFromPoint(r.left + 4, r.top + 4));
      })()`);
      const passive = await hitNotice();
      await evaluate('showOptions(120)');
      const long = await measure();
      const point = await evaluate('(() => { const r = stack.getBoundingClientRect(); return { x: r.x + 25, y: r.y + 25 }; })()') as { x: number; y: number };
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 10000 });
      await eventually(async () => await evaluate('stack.scrollTop + stack.clientHeight >= stack.scrollHeight - 1') === true);
      const scrolled = await measure();

      await evaluate('stack.scrollTop = 0');
      const swipe = await evaluate(`(() => {
        const r = stack.getBoundingClientRect();
        return { x: r.left + r.width / 2, start: r.top + r.height * 0.85, distance: r.height * 0.7 };
      })()`) as { x: number; start: number; distance: number };
      for (let attempt = 0; attempt < 20; attempt++) {
        const touch = (fraction: number) => [{ x: swipe.x, y: swipe.start - swipe.distance * fraction }];
        await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touch(0) });
        for (const fraction of [0.25, 0.5, 0.75, 1]) {
          await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touch(fraction) });
        }
        await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        if (await evaluate('stack.scrollTop === 0 || stack.scrollTop + stack.clientHeight >= stack.scrollHeight - 1')) break;
      }
      return { fits, passive, long, scrolled, touched: await measure() };
    });
    expect(result).toMatchObject({ fits: { beyondThird: true, fits: true, gutter: 0, offset: 0, lastVisible: true, top: true },
      passive: false, long: { fits: false, overflow: 'auto', lastVisible: false, top: true },
      scrolled: { lastVisible: true, heading: true }, touched: { lastVisible: true, heading: true } });
  }, 230_000);

  it('keeps the same prompt folded and reachable by Tab after a held replay leaves focus on the body', async context => {
    if (!browser) { context.skip(); return; }
    const result = await withNoticePage(browser, mode, async (page, ids) => {
      const id = ids[0]!;
      await page.evaluate(`void Object.assign(window, parts(${JSON.stringify(id)}))`);
      const tabFromHeader = async () => {
        await page.evaluate("root.querySelector('#readonly, .pane-menu-button').focus()");
        await key(page, 'Tab', 'Tab', 9);
      };
      await tabFromHeader();
      await key(page, 'Enter', 'Enter', 13);
      const foldedAtDrop = await page.evaluate("document.activeElement === button && alert.hidden && button.getAttribute('aria-expanded') === 'false'");

      await holdMatchingReplay(page, id);
      const bodyWhileHeld = await page.evaluate('document.activeElement === document.body');
      await page.evaluate('releaseReplay()');
      const replay = await page.evaluate(`({ bodyFocused: document.activeElement === document.body,
        visible: !button.hidden, expanded: button.getAttribute('aria-expanded'), detailsHidden: alert.hidden })`);

      await tabFromHeader();
      return { foldedAtDrop, bodyWhileHeld, replay, tabReachedHeading: await page.evaluate('document.activeElement === button') };
    });
    expect(result).toEqual({ foldedAtDrop: true, bodyWhileHeld: true,
      replay: { bodyFocused: true, visible: true, expanded: 'false', detailsHidden: true }, tabReachedHeading: true });
  }, 230_000);
});

it('scrolls upper, lower and partly visible options with a desktop wheel in the scaled Focus strip', async context => {
  if (!browser) { context.skip(); return; }
  const result = await withNoticePage(browser, 'dashboard', async ({ evaluate, send }) => {
    await evaluate("document.getElementById('focus').click()");
    await send('Emulation.setDeviceMetricsOverride', { width: 860, height: 245, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.strip = document.getElementById('strip');
      void Object.assign(window, parts(strip.querySelector('.pane').dataset.session))`);
    await eventually(async () => await evaluate(`Number(term.element.parentElement.dataset.fontSize) < 1
      && !button.hidden && socket.readyState === WebSocket.OPEN`) === true, 12_000, 50, 'scaled strip pane');
    await evaluate(`const options = Array.from({ length: 14 }, (_, i) => 'Strip choice ' + (i + 1));
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ ...socket.prompt, options }) }))`);

    const wheelAt = async (across: number, down: number) => {
      const point = await evaluate(`(() => {
        stack.scrollTop = 0;
        socket.sent.length = 0;
        window.stripBeforeWheel = strip.scrollTop;
        window.wheel = null;
        window.addEventListener('wheel', event => { window.wheel = event; }, { capture: true, once: true });
        const box = stack.getBoundingClientRect(), clip = strip.getBoundingClientRect();
        const top = Math.max(alert.querySelector('.options').getBoundingClientRect().top, clip.top);
        const bottom = Math.min(box.bottom, clip.bottom);
        return { x: box.left + box.width * ${across}, y: top + (bottom - top) * ${down} };
      })()`) as { x: number; y: number };
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: 300 });
      await eventually(async () => await evaluate('!!wheel') === true);
      return evaluate(`({ overTerminal: root.querySelector('.pane-term').contains(wheel.target), consumed: wheel.defaultPrevented,
        reachedEnd: stack.scrollTop > 0 && stack.scrollTop + stack.clientHeight >= stack.scrollHeight - 1,
        stripStayed: strip.scrollTop === stripBeforeWheel,
        terminalInputs: socket.sent.filter(data => typeof data !== 'string' || !data.startsWith('{')).length })`);
    };

    const upper = await wheelAt(0.5, 0.1);
    const lower = await wheelAt(0.5, 0.9);
    // Leave only the bottom ten pixels visible, then wheel away from the centre of the terminal.
    await evaluate('strip.scrollTop += stack.getBoundingClientRect().bottom - strip.getBoundingClientRect().top - 10');
    const visible = await evaluate('stack.getBoundingClientRect().bottom - strip.getBoundingClientRect().top') as number;
    const slice = await wheelAt(0.85, 0.5);
    return { touchPoints: await evaluate('navigator.maxTouchPoints'), upper, lower, slice, visible };
  }, { count: 3, rows: 150 }) as { visible: number };
  expect(result.visible).toBeCloseTo(10, 0);
  const scrolled = { overTerminal: true, consumed: true, reachedEnd: true, stripStayed: true, terminalInputs: 0 };
  expect(result).toMatchObject({ touchPoints: 0, upper: scrolled, lower: scrolled, slice: scrolled });
}, 230_000);

it('keeps the notice and page in place when tabbing into an oversized terminal', async context => {
  if (!browser) { context.skip(); return; }
  const result = await withNoticePage(browser, 'viewer', async (page, ids, input) => {
    await page.evaluate(`void Object.assign(window, parts(${JSON.stringify(ids[0])}))`);
    await input('b');
    await eventually(async () => await page.evaluate("term.buffer.active.cursorY === 149 && term.buffer.active.getLine(149)?.translateToString().includes('Reject')") === true);
    await page.evaluate('button.focus()');
    const oversized = await page.evaluate("term.element.querySelector('.xterm-screen').getBoundingClientRect().height > document.getElementById('wrap').clientHeight");
    const position = () => page.evaluate(`[scrollX, scrollY, document.body.scrollTop, button.getBoundingClientRect().top,
      stack.getBoundingClientRect().top, stack.getBoundingClientRect().bottom]`);
    const before = await position();
    await key(page, 'Tab', 'Tab', 9);
    await eventually(async () => await page.evaluate('document.activeElement === term.textarea') === true);
    return { oversized, before, after: await position() };
  }, { rows: 150 }) as { oversized: boolean; before: number[]; after: number[] };
  expect(result.oversized).toBe(true);
  expect(result.after).toEqual(result.before);
}, 230_000);

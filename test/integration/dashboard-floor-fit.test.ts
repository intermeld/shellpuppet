import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, eventually, makeTempHome, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let browser: string | null = null;
let daemon: TestDaemon | null = null;
beforeAll(async () => { browser = await findBrowser(); }, 60_000);
afterEach(async () => { await daemon?.stop(); daemon = null; }, 120_000);

interface PaneMeasurement {
  id: string;
  size: string;
  font: number;
  below: boolean;
  width: number;
  height: number;
  screenWidth: number;
  screenHeight: number;
  floorMaximum: number;
  gridMaximum: number;
}

it('keeps a detailed pane header from reducing its Auto fit area', async (context) => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const label = 'A detailed session label '.repeat(8);
  const purpose = 'A longer purpose '.repeat(8) + ' · Started by a synthetic launcher with a long description';
  const response = await api(daemon!.port, daemon!.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
    openViewer: false, cwd: process.cwd(), cols: 96, rows: 24, label, purpose,
  } });
  expect(response.status).toBe(200);
  await startSession();
  const shot = await captureDashboard({ browser, viewerUrl: await open(), width: 1100, height: 700,
    drive: true, timeoutMs: 120_000,
    beforeNavigateScript: `${instrument}; localStorage.setItem('shellpuppet.dashboard', JSON.stringify({ mode: 'grid', fontSize: 10 }));`,
    probe: `window.__paneClients?.size === 2 ? true : null`,
    interact: async ({ evaluate }) => {
      await evaluate(`window.__settlePanes(2)`);
      return await evaluate(`(async () => {
        for (const card of document.querySelectorAll('.pane')) {
          card.style.width = '500px';
          card.style.height = '340px';
        }
        const cards = [...document.querySelectorAll('.pane')];
        for (const card of cards) window.__paneClients.get(card.dataset.session).relayout(false);
        document.getElementById('auto-fit').click();
        document.getElementById('auto-fit').click();
        await window.__settlePanes(2);
        const fitted = cards.map(card => ({
          id: card.dataset.session, headHeight: card.querySelector('.pane-head').getBoundingClientRect().height,
          termHeight: card.querySelector('.pane-term').getBoundingClientRect().height,
          size: card.querySelector('.pane-size').textContent, below: card.classList.contains('below-floor'),
          label: card.querySelector('.pane-label').textContent, purpose: card.querySelector('.pane-purpose').textContent
        }));
        for (const card of cards) {
          card.style.width = '300px';
          window.__paneClients.get(card.dataset.session).relayout(false);
        }
        document.getElementById('auto-fit').click();
        document.getElementById('auto-fit').click();
        await window.__settlePanes(2);
        const card = cards[0];
        const head = card.querySelector('.pane-head');
        const fit = card.querySelector('button[aria-label="Fit"]');
        const menuButton = card.querySelector('button[aria-label="Menu"]');
        const inside = button => button.getBoundingClientRect().right <= head.getBoundingClientRect().right;
        const narrow = {
          headHeight: head.getBoundingClientRect().height,
          labelWidth: card.querySelector('.pane-label').getBoundingClientRect().width,
          purposeWidth: card.querySelector('.pane-purpose').getBoundingClientRect().width,
          labelTitle: card.querySelector('.pane-label').title,
          purposeTitle: card.querySelector('.pane-purpose').title,
          fitVisible: getComputedStyle(fit).display !== 'none' && inside(fit),
          menuVisible: getComputedStyle(menuButton).display !== 'none' && inside(menuButton),
          collapsed: getComputedStyle(card.querySelector('.pane-head button[aria-label="Enlarge"]')).display === 'none'
        };
        menuButton.click();
        const menu = card.querySelector('.pane-menu');
        const pin = menu.querySelector('button[aria-label="Pin"]');
        const right = menu.querySelector('button[aria-label="Move right"]');
        const left = menu.querySelector('button[aria-label="Move left"]');
        const menuActionsVisible = [pin, right, left, menu.querySelector('button[aria-label="Enlarge"]')]
          .every(button => getComputedStyle(button).display !== 'none');
        pin.click();
        const pinned = menu.querySelector('button[aria-label="Unpin"]') !== null;
        right.click();
        const movedRight = [...document.querySelectorAll('#panes > .pane')].at(-1) === card;
        left.click();
        const movedLeft = [...document.querySelectorAll('#panes > .pane')][0] === card;
        menu.querySelector('button[aria-label="Enlarge"]').click();
        const enlarged = document.getElementById('panes').dataset.layout === 'enlarged';
        menu.querySelector('button[aria-label="Restore"]').click();
        const restored = document.getElementById('panes').dataset.layout === 'grid';
        return { fitted, narrow, menuActionsVisible, pinned, movedRight, movedLeft, enlarged, restored };
      })()`);
    },
  });
  const result = shot.probe as {
    fitted: { headHeight: number; termHeight: number; size: string; below: boolean; label: string; purpose: string }[];
    narrow: { headHeight: number; labelWidth: number; purposeWidth: number; labelTitle: string; purposeTitle: string;
      fitVisible: boolean; menuVisible: boolean; collapsed: boolean };
    menuActionsVisible: boolean; pinned: boolean; movedRight: boolean; movedLeft: boolean;
    enlarged: boolean; restored: boolean;
  };
  const panes = result.fitted;
  expect(panes[0]!.label).toBe(label);
  expect(panes[0]!.purpose).toBe(purpose);
  expect(panes[0]!.headHeight, JSON.stringify(panes)).toBe(panes[1]!.headHeight);
  expect(panes[0]!.termHeight, JSON.stringify(panes)).toBe(panes[1]!.termHeight);
  expect(panes[0]!.size, JSON.stringify(panes)).toBe(panes[1]!.size);
  expect(panes[0]!.below, JSON.stringify(panes)).toBe(panes[1]!.below);
  expect(result.narrow.headHeight).toBe(panes[0]!.headHeight);
  expect(result.narrow.labelWidth).toBeGreaterThan(0);
  expect(result.narrow.purposeWidth).toBeGreaterThan(0);
  expect(result.narrow.labelTitle).toBe(label);
  expect(result.narrow.purposeTitle).toBe(purpose);
  expect(result.narrow.fitVisible).toBe(true);
  expect(result.narrow.menuVisible).toBe(true);
  expect(result.narrow.collapsed).toBe(true);
  expect(result.menuActionsVisible).toBe(true);
  expect(result.pinned).toBe(true);
  expect(result.movedRight).toBe(true);
  expect(result.movedLeft).toBe(true);
  expect(result.enlarged).toBe(true);
  expect(result.restored).toBe(true);
}, 180_000);

it('keeps crowded narrow header statuses readable and the menu actionable', async (context) => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const id = await startSession();
  const messages = `(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (resource, options) => String(resource).startsWith('/dashboard/messages')
      ? Promise.resolve(new Response(JSON.stringify({ enabled: true,
          counts: { [${JSON.stringify(id)}]: 3 }, messages: [], groups: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } }))
      : nativeFetch(resource, options);
  })()`;
  const shot = await captureDashboard({ browser, viewerUrl: await open(), width: 900, height: 650,
    drive: true, timeoutMs: 120_000,
    beforeNavigateScript: `${instrument}; ${messages}; localStorage.setItem('shellpuppet.dashboard', JSON.stringify({ mode: 'grid', fontSize: 10 }));`,
    probe: `window.__paneClients?.size === 1 && document.querySelector('.pane-message-count')?.textContent === '3 messages' ? true : null`,
    interact: async ({ evaluate }) => evaluate(`(async () => {
      const id = ${JSON.stringify(id)};
      const card = document.querySelector('.pane[data-session="' + id + '"]');
      card.style.width = '300px'; card.style.height = '340px';
      const client = window.__paneClients.get(id);
      client.relayout(false);
      document.getElementById('auto-fit').click();
      document.getElementById('auto-fit').click();
      await window.__settlePanes(1);
      const sizeBefore = card.querySelector('.pane-size').textContent;
      document.getElementById('auto-fit').click();
      if (!client.takeGrid(90, 30)) throw Error('Could not change the grid');
      const started = performance.now();
      while (!card.querySelector('.pane-size').textContent.startsWith('90×30')) {
        if (performance.now() - started > 10000) throw Error('Grid size did not change');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await window.__settlePanes(1);
      const feed = window.__dashboardDiagnostics.streams.find(s => s.url.endsWith('/dashboard/events'))?.socket;
      feed.onmessage({ data: JSON.stringify({ type: 'session-updated', session: {
        id, label: 'Crowded status fixture', purpose: 'Synthetic purpose', role: 'chair',
        waitingOnPrompt: { question: 'Synthetic prompt', options: [], waitingMs: 30000, alerted: true }
      }, changed: ['role', 'waitingOnPrompt'] }) });
      const head = card.querySelector('.pane-head');
      const fields = Object.fromEntries(['role', 'badge', 'message-count', 'size', 'floor'].map(name => {
        const element = card.querySelector(name === 'badge' ? '.pane-head .badge' : '.pane-' + name);
        return [name, { text: element.textContent, title: element.title }];
      }));
      const fit = card.querySelector('button[aria-label="Fit"]');
      const menuButton = card.querySelector('button[aria-label="Menu"]');
      const within = button => button.getBoundingClientRect().right <= head.getBoundingClientRect().right;
      const narrow = { headHeight: head.getBoundingClientRect().height,
        below: card.classList.contains('below-floor'), fields,
        sizeBefore, menuStatus: card.querySelector('.pane-menu-status').textContent,
        menuTitle: menuButton.title, menuMarked: menuButton.classList.contains('has-status'),
        fitVisible: within(fit), menuVisible: within(menuButton) };
      menuButton.click();
      const menuMessage = card.querySelector('.pane-menu-message-count');
      narrow.menuMessage = { text: menuMessage.textContent, title: menuMessage.title,
        visible: getComputedStyle(menuMessage).display !== 'none' };
      menuMessage.click();
      narrow.messagesOpened = !document.getElementById('messages-view').hidden;
      return narrow;
    })()`),
  });
  const result = shot.probe as {
    headHeight: number; below: boolean; sizeBefore: string;
    fields: Record<string, { text: string; title: string }>;
    menuStatus: string; menuTitle: string; menuMarked: boolean; fitVisible: boolean; menuVisible: boolean;
    menuMessage: { text: string; title: string; visible: boolean }; messagesOpened: boolean;
  };
  expect(result.headHeight).toBe(38);
  expect(result.below).toBe(true);
  expect(result.sizeBefore).not.toBe(result.fields['size']!.text);
  expect(result.fields['role']).toEqual({ text: 'Chair', title: 'Chair' });
  expect(result.fields['badge']).toEqual({ text: '● Waiting', title: '● Waiting' });
  expect(result.fields['message-count']).toEqual({ text: '3 messages', title: '3 messages' });
  expect(result.fields['size']!.title).toBe(result.fields['size']!.text);
  expect(result.fields['floor']).toEqual({ text: 'Below 80×24 floor', title: 'Below 80×24 floor' });
  for (const field of Object.values(result.fields)) expect(result.menuStatus).toContain(field.text);
  expect(result.menuTitle).toContain('Waiting');
  expect(result.menuTitle).toContain('Below 80×24 floor');
  expect(result.menuMarked).toBe(true);
  expect(result.fitVisible).toBe(true);
  expect(result.menuVisible).toBe(true);
  expect(result.menuMessage).toEqual({ text: '3 messages', title: '3 messages', visible: true });
  expect(result.messagesOpened).toBe(true);
}, 180_000);

it('scrolls a short Focus menu to its Restart and Dismiss actions', async (context) => {
  if (!browser) { context.skip(); return; }
  const home = makeTempHome('dash-short-menu-');
  const release = join(home, 'finish-programme');
  const parsed = parseDaemonConfig({ launcher: { profiles: [{
    name: 'short-menu', role: 'chair', label: 'Crowded status fixture',
    purpose: 'A synthetic dashboard launch in the short Focus strip',
    command: process.execPath,
    args: ['-e', "const fs = require('node:fs'); setInterval(() => { if (fs.existsSync(process.argv[1])) process.exit(0); }, 25);", release],
    shell: false,
  }] } });
  expect(parsed.problems).toEqual([]);
  const urls: string[] = [];
  daemon = await startTestDaemon({ home, launchProfiles: parsed.config.launcher,
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  const primary = await startSession();
  expect((await api(daemon.port, daemon.token, '/dashboard/open', { body: {} })).status).toBe(200);
  const messages = `(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (resource, options) => String(resource).startsWith('/dashboard/messages')
      ? Promise.resolve(new Response(JSON.stringify({ enabled: true,
          counts: window.__crowdedId ? { [window.__crowdedId]: 3 } : {}, messages: [], groups: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } }))
      : nativeFetch(resource, options);
  })()`;
  let phase = 'opening the dashboard';
  let failureState: Record<string, unknown> = {};
  const shot = await captureDashboard({ browser, viewerUrl: urls.at(-1)!, width: 1200, height: 720,
    drive: true, timeoutMs: 120_000,
    failureFacts: () => ({ phase, ...failureState }),
    beforeNavigateScript: `${instrument}; ${messages}; localStorage.setItem('shellpuppet.dashboard', JSON.stringify({ mode: 'focus', autoFit: false }));`,
    probe: `window.__paneClients?.size === 1 && !document.getElementById('start')?.disabled ? true : null`,
    interact: async ({ evaluate, send }) => {
      phase = 'launching the short pane';
      await evaluate("document.getElementById('start').click()");
      let launched = '';
      phase = 'waiting for the launched session';
      await eventually(async () => {
        const result = await api(daemon!.port, daemon!.token, '/sessions');
        launched = ((result.body['sessions'] as { id: string }[]) ?? []).find(item => item.id !== primary)?.id ?? '';
        return launched !== '';
      }, 30_000, 100, 'the dashboard launch to create a session');
      failureState = { sessionLaunched: true };
      const cardSelector = `#strip .pane[data-session=${JSON.stringify(launched)}]`;
      phase = 'waiting for the Focus pane';
      await eventually(async () => await evaluate(`(() => {
        const card = document.querySelector(${JSON.stringify(cardSelector)});
        return document.getElementById('panes').dataset.layout === 'focus' &&
          !!card?.querySelector('.pane-size')?.textContent.includes('×');
      })()`) === true, 30_000, 100, 'the launched pane to enter the Focus strip');
      phase = 'showing the unread message count';
      await evaluate(`(() => {
        window.__crowdedId = ${JSON.stringify(launched)};
        document.getElementById('messages-toggle').click();
        document.getElementById('messages-toggle').click();
      })()`);
      await eventually(async () => await evaluate(`document.querySelector(${JSON.stringify(cardSelector)})
        ?.querySelector('.pane-message-count')?.textContent === '3 messages'`) === true,
      10_000, 100, 'the unread message count');
      phase = 'setting the following grid';
      expect((await api(daemon!.port, daemon!.token, `/sessions/${launched}/resize`,
        { body: { cols: 400, rows: 150 } })).status).toBe(200);
      await eventually(async () => await evaluate(`document.querySelector(${JSON.stringify(cardSelector)})
        ?.querySelector('.pane-size')?.textContent === '400×150 (following)'`) === true,
      10_000, 100, 'the following grid');
      phase = 'ending the programme';
      writeFileSync(release, '');
      await eventually(async () => (await api(daemon!.port, daemon!.token,
        `/sessions/${launched}/snapshot`)).body['exited'] === true, 15_000, 100, 'the programme to exit');
      phase = 'waiting for ended pane controls';
      await eventually(async () => await evaluate(`(() => {
        const card = document.querySelector(${JSON.stringify(cardSelector)});
        return card?.classList.contains('ended') && card?.classList.contains('below-floor') &&
          !card.querySelector('button[aria-label="Restart"]').hidden &&
          !card.querySelector('button[aria-label="Dismiss"]').hidden;
      })()`) === true, 10_000, 100, 'the ended pane controls');
      phase = 'opening and scrolling the menu';
      const before = await evaluate(`(() => {
        const card = document.querySelector(${JSON.stringify(cardSelector)});
        card.querySelector('button[aria-label="Menu"]').click();
        const menu = card.querySelector('.pane-menu');
        menu.scrollTop = menu.scrollHeight;
        const restart = card.querySelector('button[aria-label="Restart"]');
        const box = restart.getBoundingClientRect();
        const menuBox = menu.getBoundingClientRect();
        const cardBox = card.getBoundingClientRect();
        return { width: cardBox.width, height: cardBox.height,
          headHeight: card.querySelector('.pane-head').getBoundingClientRect().height,
          menuHeight: menuBox.height, menuBottom: menuBox.bottom, cardBottom: cardBox.bottom,
          terminalHeight: card.querySelector('.pane-term').getBoundingClientRect().height,
          scrollMax: menu.scrollHeight - menu.clientHeight, scrollTop: menu.scrollTop,
          status: card.querySelector('.pane-menu-status').textContent,
          restartVisible: box.top >= menuBox.top && box.bottom <= menuBox.bottom,
          point: { x: box.x + box.width / 2, y: box.y + box.height / 2 } };
      })()`) as { width: number; height: number; headHeight: number; menuHeight: number;
        menuBottom: number; cardBottom: number; terminalHeight: number; scrollMax: number;
        scrollTop: number; status: string; restartVisible: boolean; point: { x: number; y: number } };
      failureState = { menuScrollTop: before.scrollTop, menuScrollMax: before.scrollMax,
        menuBottom: before.menuBottom, cardBottom: before.cardBottom,
        restartVisible: before.restartVisible };
      expect(before.restartVisible, JSON.stringify(before)).toBe(true);
      phase = 'clicking Restart';
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...before.point, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...before.point, button: 'left', clickCount: 1 });
      let restarted = '';
      await eventually(async () => {
        const result = await api(daemon!.port, daemon!.token, '/sessions');
        restarted = ((result.body['sessions'] as { id: string }[]) ?? [])
          .find(item => item.id !== primary && item.id !== launched)?.id ?? '';
        return restarted !== '';
      }, 15_000, 100, 'Restart to launch another session');
      failureState = { ...failureState, restartSessionCreated: true };
      phase = 'waiting for the restarted pane to settle';
      await eventually(async () => await evaluate(`document.querySelector(
        ${JSON.stringify(`.pane[data-session=${JSON.stringify(restarted)}]`)})?.isConnected === true`) === true,
      15_000, 100, 'the restarted pane to appear in the dashboard');
      await evaluate('window.__settlePanes(3)');
      failureState = { ...failureState, restartedPaneSettled: true };
      phase = 'focusing Dismiss';
      const keyboard = await evaluate(`(async () => {
        const card = document.querySelector(${JSON.stringify(cardSelector)});
        const menu = card.querySelector('.pane-menu');
        const dismiss = card.querySelector('button[aria-label="Dismiss"]');
        window.__dismissEvents = { focus: 0, keydown: 0, keyup: 0, click: 0, key: '', code: '' };
        dismiss.addEventListener('focus', () => { window.__dismissEvents.focus++; });
        dismiss.addEventListener('keydown', event => {
          window.__dismissEvents.keydown++;
          window.__dismissEvents.key = event.key;
          window.__dismissEvents.code = event.code;
        });
        dismiss.addEventListener('keyup', () => { window.__dismissEvents.keyup++; });
        dismiss.addEventListener('click', () => { window.__dismissEvents.click++; });
        dismiss.focus();
        await new Promise(resolve => requestAnimationFrame(resolve));
        const box = dismiss.getBoundingClientRect();
        const viewport = menu.getBoundingClientRect();
        return { focused: document.activeElement === dismiss,
          visible: box.top >= viewport.top && box.bottom <= viewport.bottom,
          scrollTop: menu.scrollTop, scrollMax: menu.scrollHeight - menu.clientHeight,
          menuTop: viewport.top, menuBottom: viewport.bottom,
          dismissTop: box.top, dismissBottom: box.bottom,
          events: window.__dismissEvents };
      })()`) as { focused: boolean; visible: boolean; scrollTop: number; scrollMax: number;
        menuTop: number; menuBottom: number; dismissTop: number; dismissBottom: number;
        events: { focus: number; keydown: number; keyup: number; click: number; key: string; code: string } };
      failureState = { ...failureState, keyboard };
      expect(keyboard.focused && keyboard.visible, JSON.stringify(keyboard)).toBe(true);
      const dismissState = async () => await evaluate(`(() => {
        const card = document.querySelector(${JSON.stringify(cardSelector)});
        const menu = card?.querySelector('.pane-menu');
        const dismiss = card?.querySelector('button[aria-label="Dismiss"]');
        const menuBox = menu?.getBoundingClientRect();
        const box = dismiss?.getBoundingClientRect();
        return { cardPresent: !!card, focused: document.activeElement === dismiss,
          visibility: document.visibilityState, scrollTop: menu?.scrollTop ?? null,
          scrollMax: menu ? menu.scrollHeight - menu.clientHeight : null,
          menuTop: menuBox?.top ?? null, menuBottom: menuBox?.bottom ?? null,
          dismissTop: box?.top ?? null, dismissBottom: box?.bottom ?? null,
          events: window.__dismissEvents };
      })()`);
      phase = 'sending Space keydown to Dismiss';
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ',
        windowsVirtualKeyCode: 32 });
      failureState = { ...failureState, afterKeyDown: await dismissState() };
      phase = 'sending Space keyup to Dismiss';
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space',
        windowsVirtualKeyCode: 32 });
      const afterKeyUp = await dismissState() as { events: typeof keyboard.events };
      failureState = { ...failureState, afterKeyUp };
      phase = 'waiting for Dismiss to remove the pane';
      try {
        await eventually(async () => await evaluate(`!document.querySelector(${JSON.stringify(cardSelector)})`) === true,
          10_000, 100, 'Dismiss to remove the ended pane');
      } catch (error) {
        failureState = { ...failureState, afterWait: await dismissState().catch(() => ({ unavailable: true })) };
        throw error;
      }
      return { before, keyboard, dismissed: true, events: afterKeyUp.events };
    },
  });
  const result = shot.probe as { before: { width: number; height: number; headHeight: number;
    menuHeight: number; menuBottom: number; cardBottom: number; terminalHeight: number;
    scrollMax: number; scrollTop: number; status: string; restartVisible: boolean };
    keyboard: { focused: boolean; visible: boolean; scrollTop: number };
    events: { focus: number; keydown: number; keyup: number; click: number; key: string; code: string };
    dismissed: boolean };
  expect(result.before.width).toBe(300);
  expect(result.before.height).toBe(170);
  expect(result.before.headHeight).toBe(38);
  expect(result.before.menuBottom).toBeLessThanOrEqual(result.before.cardBottom);
  expect(result.before.terminalHeight).toBeGreaterThan(0);
  expect(result.before.scrollMax).toBeGreaterThan(0);
  expect(result.before.scrollTop).toBeGreaterThan(0);
  expect(result.before.restartVisible).toBe(true);
  for (const text of ['Chair', '3 messages', 'Ended', '400×150 (following)', 'Below 80×24 floor'])
    expect(result.before.status).toContain(text);
  expect(result.keyboard.focused).toBe(true);
  expect(result.keyboard.visible).toBe(true);
  expect(result.events.focus).toBeGreaterThan(0);
  expect(result.events.keydown).toBeGreaterThan(0);
  expect(result.events.keyup).toBeGreaterThan(0);
  expect(result.events.key).toBe(' ');
  expect(result.events.code).toBe('Space');
  expect(result.events.click).toBeGreaterThan(0);
  expect(result.dismissed).toBe(true);
}, 180_000);

async function startSession(cols = 96, rows = 24, hold = false) {
  const response = await api(daemon!.port, daemon!.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
    openViewer: false, cwd: process.cwd(), cols, rows, hold,
  } });
  expect(response.status).toBe(200);
  return String(response.body['id']);
}

async function setup() {
  const urls: string[] = [];
  daemon = await startTestDaemon({
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  return async () => {
    expect((await api(daemon!.port, daemon!.token, '/dashboard/open', { body: {} })).status).toBe(200);
    return urls.at(-1)!;
  };
}

// Expose the public pane client to measure real xterm cells independently of
// the fitting algorithm. The browser still receives real daemon geometry.
const instrument = `(() => {
  localStorage.setItem('shellpuppet.dashboard', JSON.stringify({ mode: 'grid' }));
  const clients = window.__paneClients = new Map();
  let implementation;
  Object.defineProperty(window, 'ShellPuppetPane', {
    get: () => implementation,
    set: value => { implementation = { ...value, create(config) {
      const client = value.create(config); clients.set(config.sessionId, client); return client;
    } }; }
  });
  window.__measurePanes = (maxima = false) => [...document.querySelectorAll('.pane')].filter(card =>
    card.querySelector('.xterm-screen')).map(card => {
    const client = clients.get(card.dataset.session);
    const term = client.getTerminal();
    const screen = card.querySelector('.xterm-screen');
    const wrap = card.querySelector('.pane-wrap');
    const style = getComputedStyle(wrap);
    const width = wrap.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = wrap.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const drawn = term.options.fontSize;
    let floorMaximum = 0, gridMaximum = 0;
    if (maxima) {
      for (let font = 1; font <= 40; font++) {
        term.options.fontSize = font;
        if (Math.ceil(screen.offsetWidth * 80 / term.cols) <= width &&
            Math.ceil(screen.offsetHeight * 24 / term.rows) <= height) floorMaximum = font;
        if (screen.offsetWidth <= width && screen.offsetHeight <= height) gridMaximum = font;
      }
      if (gridMaximum === 0) {
        term.options.fontSize = 1;
        gridMaximum = Math.min(width / screen.offsetWidth, height / screen.offsetHeight);
      }
      term.options.fontSize = drawn;
    }
    return { id: card.dataset.session, size: card.querySelector('.pane-size').textContent,
      font: Number(card.querySelector('.pane-term').dataset.fontSize), below: card.classList.contains('below-floor'),
      width, height, screenWidth: screen.getBoundingClientRect().width,
      screenHeight: screen.getBoundingClientRect().height, floorMaximum, gridMaximum };
  });
  window.__settlePanes = async count => {
    let last = '', since = performance.now();
    const started = performance.now();
    while (performance.now() - started < 15000) {
      const panes = window.__measurePanes();
      const current = JSON.stringify(panes);
      if (last !== current) { last = current; since = performance.now(); }
      if (panes.length === count && panes.every(pane => pane.size.includes('×')) &&
          performance.now() - since > 1300) return window.__measurePanes(true);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Panes did not settle: ' + last);
  };
})()`;

function expectWhole(panes: PaneMeasurement[]) {
  for (const pane of panes) {
    expect(pane.screenWidth, JSON.stringify(pane)).toBeLessThanOrEqual(pane.width);
    expect(pane.screenHeight, JSON.stringify(pane)).toBeLessThanOrEqual(pane.height);
  }
}

function expectSharedFloor(panes: PaneMeasurement[]) {
  expect(panes.length).toBeGreaterThan(1);
  expect(panes.every(pane => pane.below), JSON.stringify(panes)).toBe(true);
  expect(panes.map(pane => pane.size), JSON.stringify(panes)).toEqual(panes.map(() => '80×24'));
  const maximum = Math.min(...panes.map(pane => pane.floorMaximum));
  expect(panes.map(pane => pane.font), JSON.stringify(panes)).toEqual(panes.map(() => maximum));
  expectWhole(panes);
}

it('shares the largest floor text after growth, shrinkage, a late arrival and a track drag', async (context) => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const ids = [await startSession(), await startSession(), await startSession()];
  const shot = await captureDashboard({ browser, viewerUrl: await open(), width: 1600, height: 750,
    drive: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
    probe: `window.__paneClients?.size === 3 ? true : null`,
    interact: async ({ evaluate, send }) => {
      await evaluate(`window.__settlePanes(3)`);
      const histories = await evaluate(`(async () => {
        const cards = [...document.querySelectorAll('.pane')];
        for (const [index, dimensions] of [[320, 220], [1200, 700], [600, 260]].entries()) {
          cards[index].style.width = dimensions[0] + 'px'; cards[index].style.height = dimensions[1] + 'px';
          window.__paneClients.get(cards[index].dataset.session).relayout(false);
        }
        const before = window.__measurePanes();
        for (const card of cards) { card.style.width = '600px'; card.style.height = '300px'; }
        window.dispatchEvent(new Event('resize'));
        return before;
      })()`);
      const late = await startSession();
      ids.push(late);
      await evaluate(`window.__settlePanes(4)`);
      const equal = await evaluate(`(async () => {
        for (const card of document.querySelectorAll('.pane')) { card.style.width = '600px'; card.style.height = '300px'; }
        for (const client of window.__paneClients.values()) client.relayout(false);
        document.getElementById('text-auto').click();
        return window.__settlePanes(4);
      })()`) as PaneMeasurement[];
      // A wide window allows a real column divider to move while its short
      // tracks remain below the floor. The narrower track sets everyone's text.
      await evaluate(`(() => { for (const card of document.querySelectorAll('.pane')) {
        card.style.removeProperty('width'); card.style.removeProperty('height');
      } })()`);
      await evaluate(`(() => { for (let index = 0; index < 11; index++) document.getElementById('text-larger').click(); })()`);
      await send('Emulation.setDeviceMetricsOverride', { width: 2000, height: 1100, deviceScaleFactor: 1, mobile: false });
      await evaluate(`window.__settlePanes(4)`);
      const divider = await evaluate(`document.querySelector('.pane-divider[data-axis="column"]').getBoundingClientRect().toJSON()`) as { x: number; y: number; width: number; height: number };
      const x = divider.x + divider.width / 2, y = divider.y + divider.height / 4;
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 250, y, button: 'left', buttons: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 250, y, button: 'left', clickCount: 1 });
      const dragged = await evaluate(`window.__settlePanes(4)`) as PaneMeasurement[];
      await evaluate(`document.getElementById('text-auto').click()`);
      await send('Emulation.setDeviceMetricsOverride', { width: 2200, height: 1500, deviceScaleFactor: 1, mobile: false });
      const grown = await evaluate(`window.__settlePanes(4)`) as PaneMeasurement[];
      return { histories, equal, dragged, grown };
    },
  });
  const result = shot.probe as { histories: PaneMeasurement[]; equal: PaneMeasurement[]; dragged: PaneMeasurement[]; grown: PaneMeasurement[] };
  expect(result.histories[0]!.font).toBeLessThan(result.histories[1]!.font);
  expectSharedFloor(result.equal);
  expectSharedFloor(result.dragged);
  expect(new Set(result.dragged.map(pane => pane.width)).size).toBe(2);
  expect(result.grown.every(pane => !pane.below && pane.size !== '80×24' && pane.font >= 13), JSON.stringify(result)).toBe(true);
  expectWhole(result.grown);
  for (const id of ids) {
    const snapshot = await api(daemon!.port, daemon!.token, `/sessions/${id}/snapshot`);
    expect(snapshot.body['cols']).toBeGreaterThan(80);
    expect(snapshot.body['rows']).toBeGreaterThan(24);
  }
}, 180_000);

it('keeps Focus independent and preserves held and followed grids beside the shared floor', async (context) => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const main = await startSession();
  const free = await startSession();
  const held = await startSession(120, 40, true);
  const followed = await startSession();
  const shot = await captureDashboard({ browser, viewerUrl: await open(), width: 1700, height: 1000,
    drive: true, timeoutMs: 120_000, beforeNavigateScript: instrument,
    probe: `window.__paneClients?.size === 4 ? true : null`,
    interact: async ({ evaluate }) => {
      await evaluate(`window.__settlePanes(4)`);
      await evaluate(`(() => { document.querySelector('.pane[data-session="${main}"]').click(); document.getElementById('focus').click(); })()`);
      await evaluate(`window.__settlePanes(4)`);
      expect((await api(daemon!.port, daemon!.token, `/sessions/${followed}/resize`,
        { body: { cols: 140, rows: 45 } })).status).toBe(200);
      const before = await evaluate(`window.__settlePanes(4)`) as PaneMeasurement[];
      await evaluate(`document.querySelector('.pane[data-session="${followed}"] button[aria-label="Fit"]').click()`);
      const taken = await evaluate(`window.__settlePanes(4)`) as PaneMeasurement[];
      return { before, taken };
    },
  });
  const { before, taken } = shot.probe as { before: PaneMeasurement[]; taken: PaneMeasurement[] };
  const primary = before.find(pane => pane.id === main)!;
  const ordinary = before.find(pane => pane.id === free)!;
  const fixed = before.find(pane => pane.id === held)!;
  const following = before.find(pane => pane.id === followed)!;
  expect(ordinary.size).toBe('80×24');
  expect(primary.below).toBe(false);
  expect(primary.font).toBeGreaterThan(ordinary.font);
  expect(primary.size).not.toBe('80×24');
  expect(fixed.size).toBe('120×40 (fixed)');
  expect(following.size).toBe('140×45 (following)');
  const shared = Math.min(...before.filter(pane => pane.below).map(pane => pane.floorMaximum));
  expect(ordinary.font).toBe(shared);
  for (const pane of [fixed, following]) expect(pane.font, JSON.stringify(before)).toBe(Math.min(shared, pane.gridMaximum));
  expectWhole(before);
  const sharedAfter = Math.min(...taken.filter(pane => pane.below).map(pane => pane.floorMaximum));
  for (const pane of taken.filter(pane => pane.id === free || pane.id === followed)) {
    expect(pane.size).toBe('80×24');
    expect(pane.font).toBe(sharedAfter);
  }
  expectWhole(taken);
  const snapshot = await api(daemon!.port, daemon!.token, `/sessions/${held}/snapshot`);
  expect([snapshot.body['cols'], snapshot.body['rows']]).toEqual([120, 40]);
}, 180_000);

it('measures the floor at the remembered text choice and recovers after growing', async (context) => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  await startSession(); await startSession();
  const shot = await captureDashboard({ browser, viewerUrl: await open(), width: 1550, height: 650,
    drive: true, timeoutMs: 120_000,
    beforeNavigateScript: `${instrument}; localStorage.setItem('shellpuppet.dashboard', JSON.stringify({ mode: 'grid', fontSize: 24 }));`,
    probe: `window.__paneClients?.size === 2 ? true : null`,
    interact: async ({ evaluate, send }) => {
      const largeChoice = await evaluate(`window.__settlePanes(2)`) as PaneMeasurement[];
      await evaluate(`(() => { for (let index = 0; index < 16; index++) document.getElementById('text-smaller').click(); })()`);
      const smallChoice = await evaluate(`window.__settlePanes(2)`) as PaneMeasurement[];
      await evaluate(`(() => { for (let index = 0; index < 16; index++) document.getElementById('text-larger').click(); })()`);
      const restored = await evaluate(`window.__settlePanes(2)`) as PaneMeasurement[];
      await send('Emulation.setDeviceMetricsOverride', { width: 2800, height: 1100, deviceScaleFactor: 1, mobile: false });
      const grown = await evaluate(`window.__settlePanes(2)`) as PaneMeasurement[];
      await evaluate(`document.getElementById('auto-fit').click()`);
      await send('Emulation.setDeviceMetricsOverride', { width: 1550, height: 650, deviceScaleFactor: 1, mobile: false });
      await evaluate(`window.__settlePanes(2)`);
      await evaluate(`document.querySelector('.pane button[aria-label="Enlarge"]').click()`);
      await evaluate(`window.__settlePanes(1)`);
      await evaluate(`document.querySelector('.pane button[aria-label="Restore"]').click()`);
      const restoredPane = await evaluate(`window.__settlePanes(2)`) as PaneMeasurement[];
      return { largeChoice, smallChoice, restored, grown, restoredPane };
    },
  });
  const result = shot.probe as Record<'largeChoice' | 'smallChoice' | 'restored' | 'grown' | 'restoredPane', PaneMeasurement[]>;
  expectSharedFloor(result.largeChoice);
  expectSharedFloor(result.restored);
  expect(result.largeChoice.map(pane => pane.font)).toEqual(result.restored.map(pane => pane.font));
  expect(result.smallChoice.every(pane => !pane.below && pane.font === 8 && pane.size !== '80×24'), JSON.stringify(result)).toBe(true);
  expect(result.grown.every(pane => !pane.below && pane.font === 24 && pane.size !== '80×24'), JSON.stringify(result)).toBe(true);
  expectWhole(result.grown);
  expect(result.restoredPane[0]!.size).toBe('80×24');
  expectWhole(result.restoredPane);
}, 180_000);

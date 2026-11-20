/** Browser proof of the dashboard window protocol. */
import { beforeAll, expect, it } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, eventually, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let browser: string | null = null;
beforeAll(async () => { browser = await findBrowser(); }, 60_000);

type Page = { evaluate: (expression: string) => Promise<unknown>;
  send: (method: string, params?: Record<string, unknown>, browserWideOrSession?: boolean | string) => Promise<unknown> };
type Target = { targetId: string; url: string; type: string };
type Child = Page & { id: string };
type Primary = Parameters<NonNullable<Parameters<typeof captureDashboard>[0]['interact']>>[0];

async function until<T>(read: () => T | null | Promise<T | null>, limitMs = 30_000): Promise<T> {
  const deadline = Date.now() + limitMs;
  do {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error('Dashboard did not acknowledge the expected state.');
}

const ids = (evaluate: Page['evaluate']): Promise<unknown> =>
  evaluate(`[...document.querySelectorAll('#panes .pane')].map(p => p.dataset.session)`);

async function exercise(count: number, action: (primary: Primary, openChild: (useButton?: boolean) => Promise<Child>,
  start: () => Promise<string>, daemon: TestDaemon) => Promise<unknown>): Promise<unknown> {
  const urls: string[] = [];
  const profiles = parseDaemonConfig({ launcher: { profiles: [{ name: 'lead', command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'], shell: false }] } }).config.launcher;
  const daemon = await startTestDaemon({ launchProfiles: profiles,
    launcher: (url) => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app' as const, browser: 'mock' }); },
    idleCheckIntervalMs: 600_000 });
  const start = async (): Promise<string> => {
    const result = await api(daemon.port, daemon.token, '/sessions', { body: { command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], shell: false, openViewer: false } });
    expect(result.status).toBe(200);
    return String(result.body['id']);
  };
  try {
    for (let index = 0; index < count; index++) await start();
    expect((await api(daemon.port, daemon.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
    const result = await captureDashboard({ browser: browser!, viewerUrl: urls.at(-1)!, width: 1280, height: 720,
      drive: true, probeOnly: true, timeoutMs: 180_000,
      probe: `(() => document.getElementById('connection')?.textContent === 'Connected' &&
        document.querySelectorAll('#panes .pane').length === ${count})()`,
      interact: async (primary) => {
        await until(async () => await primary.evaluate(`document.getElementById('share-count')?.textContent?.includes('1 window')`) ? true : null);
        const targets = async (): Promise<Target[]> => ((await primary.send('Target.getTargets', {}, true)) as
          { targetInfos: Target[] }).targetInfos.filter((target) => target.type === 'page');
        const existing = new Set((await targets()).map((target) => target.targetId));
        const attach = async (target: Target, windowCount: number): Promise<Child> => {
          existing.add(target.targetId);
          const { sessionId } = await primary.send('Target.attachToTarget',
            { targetId: target.targetId, flatten: true }, true) as { sessionId: string };
          const evaluate = async (expression: string): Promise<unknown> => ((await primary.send('Runtime.evaluate',
            { expression, returnByValue: true, awaitPromise: true }, sessionId)) as { result: { value?: unknown } }).result.value;
          await until(async () => {
            try {
              return await evaluate(`document.getElementById('connection')?.textContent === 'Connected' &&
                document.getElementById('share-count')?.textContent?.includes('${windowCount} windows')`) ? true : null;
            } catch (error) {
              if (/Execution context was destroyed|Cannot find context|Inspected target navigated or closed/i.test(String(error))) return null;
              throw error;
            }
          });
          await until(async () => await primary.evaluate(`document.getElementById('share-count').textContent
            .includes('${windowCount} windows')`) ? true : null);
          return { id: target.targetId, evaluate, send: (method, params) => primary.send(method, params, sessionId) };
        };
        const openChild = async (useButton = false): Promise<Child> => {
          const current = String(await primary.evaluate(`document.getElementById('share-count').textContent`));
          const windowCount = Number(/(\d+) windows?/.exec(current)?.[1] ?? 1) + 1;
          if (!useButton) {
            const target = await primary.send('Target.createTarget', {
              url: `http://127.0.0.1:${String(daemon.port)}/dashboard#screen=test-${Date.now().toString(36)}`,
            }, true) as Target;
            return attach({ ...target, url: 'dashboard' }, windowCount);
          }
          expect(await primary.evaluate(`!!document.getElementById('new-window')`)).toBe(true);
          await primary.send('Runtime.evaluate', { expression: "document.getElementById('new-window').click()",
            userGesture: true, returnByValue: true });
          const target = await until(async () => (await targets()).find((entry) =>
            !existing.has(entry.targetId) && entry.url.includes('/dashboard#screen=')) ?? null);
          return attach(target, windowCount);
        };
        return action(primary, openChild, start, daemon);
      },
    });
    return result.probe;
  } finally { await daemon.stop(); }
}

it('opens a New window empty with the same controls', async (context) => {
  if (!browser) { context.skip(); return; }
  const result = await exercise(1, async (primary, openChild) => {
    const child = await openChild(true);
    return { primary: await ids(primary.evaluate), child: await ids(child.evaluate),
      controls: await child.evaluate(`['new-window','designated-window','launcher'].every(id => !!document.getElementById(id))`),
      screens: await child.evaluate(`document.querySelectorAll('#screens button').length`) };
  });
  expect(result).toMatchObject({ primary: [expect.any(String)], child: [], controls: true, screens: 0 });
}, 240_000);

it('designates one window and hands it to the survivor on close', async (context) => {
  if (!browser) { context.skip(); return; }
  const result = await exercise(0, async (primary, openChild, start) => {
    const child = await openChild();
    expect(await child.evaluate(`!!document.getElementById('designated-window')`)).toBe(true);
    await child.evaluate(`document.getElementById('designated-window').click()`);
    await until(async () => await child.evaluate(`document.getElementById('designated-window').getAttribute('aria-pressed') === 'true'`) ? true : null);
    await until(async () => await primary.evaluate(`document.getElementById('designated-window').getAttribute('aria-pressed') === 'false'`) ? true : null);
    const delegate = await start();
    await until(async () => (await ids(child.evaluate) as string[]).includes(delegate) ? true : null);
    await primary.send('Target.closeTarget', { targetId: child.id }, true);
    await until(async () => await primary.evaluate(`document.getElementById('designated-window').getAttribute('aria-pressed') === 'true'`) ? true : null);
    await until(async () => (await ids(primary.evaluate) as string[]).includes(delegate) ? true : null);
    return { primary: await ids(primary.evaluate), delegate };
  });
  const state = result as { primary: string[]; delegate: string };
  expect(state.primary).toEqual([state.delegate]);
}, 240_000);

it('places a profile launch in its own window regardless of designation', async (context) => {
  if (!browser) { context.skip(); return; }
  const result = await exercise(0, async (primary, openChild) => {
    const child = await openChild();
    await until(async () => await child.evaluate(`!document.getElementById('launcher').hidden &&
      document.getElementById('profile').value === 'lead' &&
      document.getElementById('start').disabled === false`) ? true : null);
    await child.evaluate(`document.getElementById('start').click()`);
    await until(async () => (await ids(child.evaluate) as string[])[0] ?? null, 30_000);
    return { primary: await ids(primary.evaluate), child: await ids(child.evaluate),
      primaryDesignated: await primary.evaluate(`document.getElementById('designated-window').getAttribute('aria-pressed')`) };
  });
  expect(result).toMatchObject({ primary: [], child: [expect.any(String)], primaryDesignated: 'true' });
}, 240_000);

async function dragPane(source: Primary, target: Page, id: string, selector: string, fraction = 0.5, moveAllowed = true) {
  await source.send('Page.bringToFront');
  await source.send('Input.setInterceptDrags', { enabled: true });
  const start = await source.evaluate(`(() => {
    const box = document.querySelector('.pane[data-session=${JSON.stringify(id)}] .pane-head').getBoundingClientRect();
    return { x: box.left + 3, y: box.top + 3 };
  })()`) as { x: number; y: number };
  let intercepted: { items: { mimeType: string; data: string }[]; dragOperationsMask: number } | undefined;
  const unsubscribe = source.onEvent('Input.dragIntercepted', params => {
    intercepted = params['data'] as typeof intercepted;
  });
  try {
    await source.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
    await source.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1 });
    await source.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + 24, y: start.y + 2, buttons: 1, button: 'left' });
    const data = await until(() => intercepted ?? null);
    expect(data.items.find(item => item.mimeType === 'application/x-shellpuppet-pane')?.data).toBeTruthy();
    expect(data.dragOperationsMask, 'operation authorised by the source').toBe(moveAllowed ? 16 : 1);
    await target.send('Page.bringToFront');
    const point = await target.evaluate(`(() => {
      delete window.__acceptedDrop;
      window.addEventListener('dragover', e => {
        window.__acceptedDrop = e.isTrusted && e.defaultPrevented && e.dataTransfer.dropEffect === 'move';
      }, { once: true });
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: box.left + box.width * ${fraction}, y: box.top + box.height * ${fraction} };
    })()`) as { x: number; y: number };
    for (const type of ['dragEnter', 'dragOver']) await target.send('Input.dispatchDragEvent', { type, ...point, data });
    expect(await target.evaluate('window.__acceptedDrop'), 'destination accepted a move').toBe(moveAllowed);
    await target.send('Input.dispatchDragEvent', { type: moveAllowed ? 'drop' : 'dragCancel', ...point, data });
  } finally {
    unsubscribe();
    await source.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...start, button: 'left', clickCount: 1 });
    await source.send('Input.setInterceptDrags', { enabled: false });
  }
}

it.for(['toolbar', 'before', 'after'])('drags the last pane from its title to %s', { timeout: 240_000 }, async (placement, context) => {
  if (!browser) { context.skip(); return; }
  await exercise(3, async (primary, openChild) => {
    const child = await openChild();
    const [a, b, c] = await ids(primary.evaluate) as [string, string, string];
    await sendMove(primary, a);
    await sendMove(primary, b);
    await until(async () => JSON.stringify(await ids(child.evaluate)) === JSON.stringify([a,b]) ? true : null);
    await until(async () => JSON.stringify(await ids(primary.evaluate)) === JSON.stringify([c]) ? true : null);
    const target = placement === 'toolbar' ? 'h1' : '.pane[data-session="' + a + '"]';
    await dragPane(primary, child, c, target, placement === 'before' ? 0.25 : 0.75);
    const expected = placement === 'toolbar' ? [a,b,c] : placement === 'before' ? [c,a,b] : [a,c,b];
    await until(async () => JSON.stringify(await ids(child.evaluate)) === JSON.stringify(expected) ? true : null);
    await until(async () => (await ids(primary.evaluate) as string[]).length === 0 ? true : null);
    expect(await primary.evaluate("!document.getElementById('start').disabled")).toBe(true);
    return true;
  });
});

it('refuses a native drag whose source allows only copy', async (context) => {
  if (!browser) { context.skip(); return; }
  await exercise(1, async (primary, openChild) => {
    const child = await openChild();
    const [id] = await ids(primary.evaluate) as [string];
    await primary.evaluate(`document.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'copy';
    }, {once: true})`);
    await dragPane(primary, child, id, 'h1', 0.5, false);
    expect(await ids(primary.evaluate)).toEqual([id]);
    expect(await ids(child.evaluate)).toEqual([]);
  });
}, 240_000);

const feedEntry = "window.__dashboardDiagnostics.streams.filter(s => s.url.endsWith('/dashboard/events')).at(-1)";
it('retains the last real focus of a survivor across its background reconnect', async (context) => {
  if (!browser) { context.skip(); return; }
  await exercise(0, async (primary, openChild, start, { daemon }) => {
    const b = await openChild();
    const c = await openChild();
    const registration = async (page: Page) => {
      const protocol = 'sp-csrf.' + String(await page.evaluate("document.querySelector('meta[name=sp-csrf]').content"));
      return () => daemon['dashboardWindows']().find(window => window.socket.protocol === protocol);
    };
    const aReg = await registration(primary), bReg = await registration(b), cReg = await registration(c);
    // Bring A forward first so all three focus changes below are real transitions.
    await primary.send('Page.bringToFront');
    for (const [page, current] of [[c, cReg], [b, bReg], [primary, aReg]] as const) {
      const before = current()!.focused;
      await page.send('Page.bringToFront');
      await eventually(() => (current()?.focused ?? 0) > before, 15_000, 50, 'daemon acknowledged real window focus');
    }
    const old = bReg()!;
    old.socket.close();
    await eventually(() => !!bReg() && bReg()!.socket !== old.socket);
    expect(await b.evaluate('document.hasFocus()')).toBe(false);
    const departing = aReg()!;
    departing.socket.close();
    await eventually(() => daemon['dashboardDesignated'] !== departing.pair && daemon['dashboardWindows']().length === 2);
    expect(daemon['dashboardDesignated'], 'survivor most recently focused before the reconnect').toBe(bReg()!.pair);
    const id = await start();
    await eventually(async () => (await ids(b.evaluate) as string[]).includes(id));
  });
}, 240_000);

async function sendMove(primary: Page, session: string) {
  await primary.evaluate(`(() => {
    const feed = ${feedEntry};
    const [source, target] = feed.windowState.windows;
    feed.socket.send(JSON.stringify({ type: 'window-move', session: ${JSON.stringify(session)}, source, target }));
  })()`);
}

it.for(['release first', 'recipient first'])('takes an equal-sized grid with %s', { timeout: 240_000 }, async (order, context) => {
  if (!browser) { context.skip(); return; }
  await exercise(1, async (primary, openChild, _start, { daemon }) => {
    const child = await openChild();
    const [id] = await ids(primary.evaluate) as [string];
    for (const page of [primary, child]) await page.send('Emulation.setDeviceMetricsOverride',
      { width: 600, height: 210, deviceScaleFactor: 1, mobile: false });
    const badge = "document.querySelector('.pane-size')?.textContent";
    await primary.evaluate(`document.querySelector('.pane button[aria-label="Fit"]').click()`);
    await eventually(async () => await primary.evaluate(badge) === '80×24', 15_000, 50, 'source controls the floor grid',
      () => primary.evaluate(badge));
    if (order === 'release first') {
      // Let the source process the move while the destination cannot handle its assignment yet.
      await child.send('Debugger.enable');
      await child.send('Debugger.pause');
      try {
        await sendMove(primary, id);
        await eventually(() => daemon['dashboardTransferable'].has(id));
      } finally { await child.send('Debugger.resume'); }
    } else {
      // Keep the genuine release and close queued until the recipient has seen the existing controller.
      await primary.evaluate(`(() => {
        const socket = window.__dashboardDiagnostics.streams.find(s => s.url.includes('/stream') && s.socket.readyState === 1).socket;
        const send = socket.send.bind(socket), close = socket.close.bind(socket);
        socket.send = data => {
          if (data === JSON.stringify({type:'release-grid'})) window.__releaseGrid = () => { send(data); close(); };
          else send(data);
        };
        socket.close = () => { if (!window.__releaseGrid) close(); };
      })()`);
      await sendMove(primary, id);
      await eventually(async () => await child.evaluate(badge) === '80×24 (following)');
      await primary.evaluate('window.__releaseGrid()');
    }
    const protocol = 'sp-csrf.' + String(await child.evaluate("document.querySelector('meta[name=sp-csrf]').content"));
    await eventually(() => daemon['geometryController'].get(id)?.protocol === protocol, 15_000, 50,
      'recipient acknowledged ownership at equal dimensions', () => child.evaluate(badge));
    await eventually(async () => await child.evaluate(badge) === '80×24');
  });
});

it('removes an enlarged pane from its source and scopes keyboard enlargement to the assignment', async (context) => {
  if (!browser) { context.skip(); return; }
  await exercise(2, async (primary, openChild) => {
    const child = await openChild();
    const [a, b] = await ids(primary.evaluate) as [string, string];
    await primary.evaluate(`document.querySelector('[data-session="${b}"] button[aria-label="Enlarge"]').click()`);
    await sendMove(primary, b);
    await until(async () => (await ids(child.evaluate) as string[]).includes(b) ? true : null);
    expect(await ids(primary.evaluate)).toEqual([a]);
    await child.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'A',ctrlKey:true,shiftKey:true,bubbles:true}));
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'m',bubbles:true}));`);
    expect(await ids(child.evaluate)).toEqual([b]);
    return true;
  });
}, 240_000);

it('clears local clients and designation before reconnecting the event feed', async (context) => {
  if (!browser) { context.skip(); return; }
  await exercise(1, async (primary, openChild) => {
    const child = await openChild();
    const [session] = await ids(primary.evaluate) as string[];
    const atClose = await primary.evaluate(`new Promise(resolve => {
      const socket = ${feedEntry}.socket;
      socket.addEventListener('close', () => resolve({
        cards: document.querySelectorAll('.pane').length,
        pressed: document.getElementById('designated-window').getAttribute('aria-pressed'),
        streams: window.__dashboardDiagnostics.streams.filter(s => s.url.includes('/stream') && s.socket.readyState === 1).length
      }), {once:true});
      socket.close();
    })`);
    expect(atClose).toEqual({ cards: 0, pressed: 'false', streams: 0 });
    await until(async () => (await ids(child.evaluate) as string[]).includes(session!) ? true : null);
    await until(async () => await primary.evaluate(`document.getElementById('share-count').textContent.includes('2 windows') &&
      !document.getElementById('designated-window').disabled`) ? true : null);
    expect(await ids(primary.evaluate)).toEqual([]);
    return true;
  });
}, 240_000);

it('moves left and right across a gap in the global catalogue', async (context) => {
  if (!browser) { context.skip(); return; }
  await exercise(3, async (primary, openChild) => {
    const child = await openChild();
    const [a, b, c] = await ids(primary.evaluate) as [string, string, string];
    await sendMove(primary, b);
    await until(async () => (await ids(child.evaluate) as string[]).includes(b) ? true : null);
    for (const [label, expected] of [['Move left', [c, a]], ['Move right', [a, c]]] as const) {
      await primary.evaluate(`document.querySelector('[data-session="${c}"] button[aria-label="${label}"]').click()`);
      await until(async () => JSON.stringify(await primary.evaluate(`${feedEntry}.windowState.assignments[${feedEntry}.windowState.designated]`))
        === JSON.stringify(expected) ? true : null);
      expect(await ids(primary.evaluate)).toEqual(expected);
    }
    return true;
  });
}, 240_000);

it('shows local attention and keeps the empty notice after closing Messages', async (context) => {
  if (!browser) { context.skip(); return; }
  await exercise(1, async (primary, openChild) => {
    const child = await openChild();
    const [id] = await ids(primary.evaluate) as string[];
    const readAttention = () => primary.evaluate(`(() => {
      ${feedEntry}.socket.onmessage({ data: JSON.stringify({type:'session-updated',
        session:{id:${JSON.stringify(id)},label:'Waiting elsewhere',waitingOnPrompt:{waitingMs:21000}}}) });
      return document.getElementById('attention-count').textContent;
    })()`);
    expect(await readAttention()).toBe('1 waiting');
    await child.evaluate(`document.getElementById('messages-toggle').click(); document.getElementById('messages-toggle').click()`);
    const empty = await child.evaluate("!document.getElementById('empty').hidden");
    await sendMove(primary, id!);
    await until(async () => (await ids(primary.evaluate) as string[]).length === 0 ? true : null);
    expect({ empty, attention: await readAttention() }).toEqual({ empty: true, attention: '' });
    return true;
  });
}, 240_000);

it('preserves both launcher records and offers Restart to the receiving window', async (context) => {
  if (!browser) { context.skip(); return; }
  await exercise(0, async (primary, openChild) => {
    const child = await openChild();
    const launch = async (page: Page) => {
      await until(async () => await page.evaluate("!document.getElementById('start').disabled") ? true : null);
      await page.evaluate("document.getElementById('start').click()");
      return until(async () => await page.evaluate("document.querySelector('.pane:has([data-action=restart]:not([hidden]))')?.dataset.session") as string ?? null);
    };
    const [a, b] = await Promise.all([launch(primary), launch(child)]);
    await sendMove(primary, a);
    await until(async () => (await ids(child.evaluate) as string[]).includes(a) ? true : null);
    const restartable = () => child.evaluate("[...document.querySelectorAll('.pane:has([data-action=restart]:not([hidden]))')].map(p=>p.dataset.session).sort()");
    expect(await restartable()).toEqual([a,b].sort());
    // When the other window closes, this surviving document receives every pane.
    await primary.send('Target.closeTarget', {targetId: child.id}, true);
    await until(async () => (await ids(primary.evaluate) as string[]).length === 2 ? true : null);
    const previous = Number(await primary.evaluate('performance.timeOrigin'));
    await primary.send('Page.reload');
    await until(async () => {
      try {
        return await primary.evaluate(`performance.timeOrigin !== ${previous} &&
          document.querySelectorAll('#panes .pane').length === 2`) ? true : null;
      } catch (error) {
        if (/Execution context was destroyed|Cannot find context/i.test(String(error))) return null;
        throw error;
      }
    });
    expect(await primary.evaluate("[...document.querySelectorAll('.pane:has([data-action=restart]:not([hidden]))')].map(p=>p.dataset.session).sort()"))
      .toEqual([a,b].sort());
    return true;
  });
}, 240_000);

it('pops out into an ordinary window and returns its pane on close', async (context) => {
  if (!browser) { context.skip(); return; }
  const result = await exercise(1, async (primary) => {
    const existing = new Set(((await primary.send('Target.getTargets', {}, true)) as { targetInfos: Target[] }).targetInfos.map(t => t.targetId));
    await primary.send('Runtime.evaluate', { expression: `document.querySelector('.pane [data-action="pop"]').click()`,
      userGesture: true, returnByValue: true });
    const target = await until(async () => ((await primary.send('Target.getTargets', {}, true)) as { targetInfos: Target[] })
      .targetInfos.find(t => !existing.has(t.targetId) && t.url.includes('/dashboard#screen=')) ?? null);
    const { sessionId } = await primary.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, true) as { sessionId: string };
    const child = async (expression: string): Promise<unknown> => ((await primary.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, sessionId)) as { result: { value?: unknown } }).result.value;
    const moved = await until(async () => (await child(`document.querySelector('#panes .pane')?.dataset.session`) as string | undefined) ?? null);
    await until(async () => (await ids(primary.evaluate) as string[]).length === 0 ? true : null);
    const controls = await child(`!!document.getElementById('new-window') && !!document.getElementById('launcher')`);
    await primary.send('Target.closeTarget', { targetId: target.targetId }, true);
    await until(async () => (await ids(primary.evaluate) as string[]).includes(moved) ? true : null);
    return { moved, controls, returned: await ids(primary.evaluate) };
  });
  const state = result as { moved: string; controls: boolean; returned: string[] };
  expect(state.moved).toMatch(/^s\d+$/);
  expect(state.controls).toBe(true);
  expect(state.returned).toEqual([state.moved]);
}, 240_000);

/** Browser proof of the dashboard window protocol. */
import { beforeAll, expect, it } from 'vitest';
import { captureDashboard } from './dashboardCapture.js';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, startTestDaemon } from './helpers.js';

let browser: string | null = null;
beforeAll(async () => { browser = await findBrowser(); }, 60_000);

type Page = { evaluate: (expression: string) => Promise<unknown>;
  send: (method: string, params?: Record<string, unknown>, browserWideOrSession?: boolean | string) => Promise<unknown> };
type Target = { targetId: string; url: string; type: string };
type Child = { id: string; evaluate: Page['evaluate'] };

async function until<T>(read: () => Promise<T | null>, limitMs = 30_000): Promise<T> {
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

async function exercise(count: number, action: (primary: Page, openChild: (useButton?: boolean) => Promise<Child>,
  start: () => Promise<string>) => Promise<unknown>): Promise<unknown> {
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
          return { id: target.targetId, evaluate };
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
        return action(primary, openChild, start);
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

it('drags the last pane into an empty window and inserts before a target pane', async (context) => {
  if (!browser) { context.skip(); return; }
  const result = await exercise(2, async (primary, openChild) => {
    const child = await openChild();
    const source = await ids(primary.evaluate) as string[];
    const drag = async (id: string, before?: string) => {
      const data = await primary.evaluate(`(() => { const transfer = new DataTransfer();
        document.querySelector('.pane[data-session=${JSON.stringify(id)}] .pane-head')
          .dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
        return transfer.getData('application/x-shellpuppet-pane'); })()`);
      await child.evaluate(`(() => { const transfer = new DataTransfer();
        transfer.setData('application/x-shellpuppet-pane', ${JSON.stringify(data)});
        const target = ${before ? `document.querySelector('.pane[data-session=${JSON.stringify(before)}]')` : `document.getElementById('panes')`};
        target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer })); })()`);
    };
    await drag(source[0]!);
    await until(async () => (await ids(child.evaluate) as string[]).includes(source[0]!) ? true : null);
    await drag(source[1]!, source[0]);
    await until(async () => JSON.stringify(await ids(child.evaluate)) === JSON.stringify([source[1], source[0]]) ? true : null);
    await until(async () => (await ids(primary.evaluate) as string[]).length === 0 ? true : null);
    await until(async () => await primary.evaluate(`document.getElementById('start').disabled === false`) ? true : null);
    return { source: await ids(primary.evaluate), target: await ids(child.evaluate), expected: [source[1], source[0]],
      sourceControls: await primary.evaluate(`!!document.getElementById('new-window') &&
        !document.getElementById('launcher').hidden && !document.getElementById('start').disabled`) };
  });
  expect(result).toMatchObject({ source: [], target: (result as { expected: string[] }).expected, sourceControls: true });
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

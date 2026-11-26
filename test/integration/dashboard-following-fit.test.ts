import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AGENT_MODULES } from '../../src/agents/index.js';
import { captureDashboard } from './dashboardCapture.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, connectWs, eventually, repoRoot, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let browser: string | null = null;
let daemon: TestDaemon | null = null;
beforeAll(async () => { browser = await findBrowser(); }, 60_000);
afterEach(async () => { await daemon?.stop(); daemon = null; }, 120_000);

async function setup() {
  const urls: string[] = [];
  daemon = await startTestDaemon({
    launcher: url => { urls.push(url); return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' }); },
    idleCheckIntervalMs: 600_000,
  });
  return async () => {
    expect((await api(daemon!.port, daemon!.token, '/dashboard/open', { body: {} })).status).toBe(200);
    return urls.at(-1)!;
  };
}

async function startSession(cols = 83, rows = 25, agent?: string) {
  const response = await api(daemon!.port, daemon!.token, '/sessions', { body: {
    command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false,
    openViewer: false, cwd: process.cwd(), cols, rows, agent,
  } });
  expect(response.status).toBe(200);
  return String(response.body['id']);
}

const gridMode = `localStorage.setItem('shellpuppet.dashboard', JSON.stringify({ mode: 'grid' }))`;
const stream = (id: string) => `window.__dashboardDiagnostics.streams.find(entry => entry.url.endsWith('/sessions/${id}/stream'))`;
const badge = (id: string) => `document.querySelector('.pane[data-session="${id}"] .pane-size')?.textContent`;

it('fits a CLI session after its live controller leaves', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const { port, token, home } = daemon!;
  const startCli = async (rows: number) => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      join(repoRoot, 'dist', 'cli', 'index.js'), 'start', '--json', '--no-viewer', '--no-shell',
      '--cols', '83', '--rows', String(rows), process.execPath, '-e', 'setInterval(() => {}, 1000)',
    ], { env: { ...process.env, SHELLPUPPET_HOME: home }, timeout: 60_000 });
    return (JSON.parse(stdout) as { id: string }).id;
  };
  const id = await startCli(25);
  const peer = await startCli(26);
  const driver = await connectWs(port, id, token);
  try {
    expect(await driver.waitForControl(frame => frame.type === 'geometry')).toMatchObject({
      cols: 83, rows: 25, control: 'yours',
    });
    await captureDashboard({ browser, viewerUrl: await open(), width: 2000, height: 900,
      drive: true, probeOnly: true, beforeNavigateScript: gridMode, timeoutMs: 60_000,
      probe: `!!${stream(id)} && !!${stream(peer)}`,
      interact: async ({ evaluate }) => {
        await eventually(async () => Number(String(await evaluate(badge(peer))).split('×')[0]) > 83);
        const peerSize = String(await evaluate(badge(peer)));
        expect(Number(peerSize.split('×')[0])).toBeGreaterThan(83);
        expect(await evaluate(badge(id))).toBe('83×25 (following)');
        expect(await evaluate(`${stream(id)}.resizes.length`)).toBe(0);
        driver.close();
        await eventually(async () => await evaluate(badge(id)) === peerSize);
        const takes = await evaluate(`${stream(id)}.resizes`) as { automatic: boolean; takeId: number }[];
        expect(takes).toHaveLength(1);
        expect(takes[0]).toMatchObject({ automatic: true, takeId: 1 });
        const [cols, rows] = peerSize.split('×').map(Number);
        expect((await api(port, token, `/sessions/${id}/snapshot`)).body).toMatchObject({ cols, rows });
      },
    });
  } finally { driver.close(); }
}, 120_000);

it('ends an unheld HTTP resize when a later live controller leaves', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const id = await startSession();
  const { port, token } = daemon!;
  const drivers: Awaited<ReturnType<typeof connectWs>>[] = [];
  try {
    await captureDashboard({ browser, viewerUrl: await open(), width: 1600, height: 1000,
      drive: true, probeOnly: true, beforeNavigateScript: gridMode, timeoutMs: 60_000,
      probe: `!!${stream(id)}`,
      interact: async ({ evaluate }) => {
        await eventually(async () => Number(String(await evaluate(badge(id))).split('×')[0]) > 83);
        expect((await api(port, token, `/sessions/${id}/resize`,
          { body: { cols: 108, rows: 36 } })).status).toBe(200);
        await eventually(async () => await evaluate(badge(id)) === '108×36 (following)');
        const before = Number(await evaluate(`${stream(id)}.resizes.length`));
        const driver = await connectWs(port, id, token);
        drivers.push(driver);
        expect(await driver.waitForControl(frame => frame.control === 'yours')).toMatchObject({ cols: 108, rows: 36 });
        expect(await evaluate(badge(id))).toBe('108×36 (following)');
        driver.close();
        await eventually(async () => Number(await evaluate(`${stream(id)}.resizes.length`)) === before + 1);
        const fit = await evaluate(`${stream(id)}.resizes.at(-1)`) as { cols: number; rows: number; automatic: boolean };
        expect(fit.automatic).toBe(true);
        await eventually(async () => await evaluate(badge(id)) === `${fit.cols}×${fit.rows}`);
        expect((await api(port, token, `/sessions/${id}/snapshot`)).body)
          .toMatchObject({ cols: fit.cols, rows: fit.rows });
      },
    });
  } finally { for (const driver of drivers) driver.close(); }
}, 120_000);

it('registers a reconnecting layout and retries one stale layout refusal', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const id = await startSession();
  const { port, token } = daemon!;
  const driver = await connectWs(port, id, token);
  const captureWire = `(() => {
    window.__fitWire = [];
    let connection = 0, injected = false;
    window.WebSocket = new Proxy(window.WebSocket, { construct(Target, args) {
      const socket = new Target(...args);
      if (new URL(args[0]).pathname !== '/sessions/${id}/stream') return socket;
      const index = ++connection, send = socket.send.bind(socket);
      socket.send = data => {
        if (typeof data !== 'string') return send(data);
        let frame;
        try { frame = JSON.parse(data); } catch { return send(data); }
        if (frame.type === 'layout' || (frame.type === 'resize' && frame.automatic)) {
          window.__fitWire.push({ index, at: performance.now(), ...frame });
        }
        if (index === 2 && frame.type === 'resize' && frame.automatic && !injected) {
          injected = true;
          return send(JSON.stringify({ ...frame, layoutId: frame.layoutId + 1000 }));
        }
        return send(data);
      };
      return socket;
    } });
  })()`;
  try {
    await driver.waitForControl(frame => frame.control === 'yours');
    await captureDashboard({ browser, viewerUrl: await open(), width: 1600, height: 1000,
      drive: true, probeOnly: true, beforeNavigateScript: `${gridMode};${captureWire}`, timeoutMs: 60_000,
      probe: `!!${stream(id)}`,
      interact: async ({ evaluate, send }) => {
        await eventually(async () => await evaluate(badge(id)) === '83×25 (following)');
        const firstLayout = `window.__fitWire.filter(frame => frame.index === 1 &&
          frame.type === 'layout' && frame.real === true).at(-1)?.layoutId`;
        await eventually(async () => Number(await evaluate(firstLayout)) > 0);
        const initialLayoutId = Number(await evaluate(firstLayout));
        await send('Emulation.setDeviceMetricsOverride',
          { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
        await eventually(async () => Number(await evaluate(firstLayout)) > initialLayoutId);
        expect(await evaluate(`${stream(id)}.resizes.length`)).toBe(0);
        await evaluate(`${stream(id)}.socket.close()`);
        driver.close();
        await eventually(async () => Number(await evaluate(`window.__dashboardDiagnostics.streams.filter(entry =>
          entry.url.endsWith('/sessions/${id}/stream')).length`)) === 2);
        await eventually(async () => Number(await evaluate(`window.__dashboardDiagnostics.streams.at(-1).geometry
          .filter(frame => frame.staleLayoutId === true).length`)) === 1);
        await eventually(async () => Number(await evaluate(`window.__dashboardDiagnostics.streams.at(-1).resizes.length`)) === 2);
        const wire = await evaluate('window.__fitWire.filter(frame => frame.index === 2)') as
          { type: string; layoutId: number; real?: boolean; takeId?: number }[];
        expect(wire.map(frame => frame.type)).toEqual(['layout', 'resize', 'layout', 'resize']);
        expect(wire[0]).toMatchObject({ real: false });
        expect(wire[2]).toMatchObject({ real: false });
        expect(wire[2]!.layoutId).toBeGreaterThan(wire[0]!.layoutId);
        expect(wire[3]!.takeId).toBeGreaterThan(wire[1]!.takeId!);
        const fit = await evaluate('window.__dashboardDiagnostics.streams.at(-1).resizes.at(-1)') as
          { cols: number; rows: number; takeId: number };
        await eventually(async () => await evaluate(badge(id)) === `${fit.cols}×${fit.rows}`);
        expect((await api(port, token, `/sessions/${id}/snapshot`)).body)
          .toMatchObject({ cols: fit.cols, rows: fit.rows });
      },
    });
  } finally { driver.close(); }
}, 120_000);

it('keeps an explicit resize made while disconnected until a real layout change', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const id = await startSession();
  const { port, token } = daemon!;
  const streams = `window.__dashboardDiagnostics.streams.filter(entry =>
    entry.url.endsWith('/sessions/${id}/stream'))`;
  await captureDashboard({ browser, viewerUrl: await open(), width: 1600, height: 1000,
    drive: true, probeOnly: true, beforeNavigateScript: gridMode, timeoutMs: 60_000,
    probe: `!!${stream(id)}`,
    interact: async ({ evaluate, send }) => {
      await eventually(async () => Number(String(await evaluate(badge(id))).split('×')[0]) > 83);
      await evaluate(`${stream(id)}.socket.close()`);
      await eventually(() => daemon!.daemon['sessionSockets'].get(id)?.size === 0);
      expect((await api(port, token, `/sessions/${id}/resize`,
        { body: { cols: 108, rows: 36 } })).status).toBe(200);
      await eventually(async () => Number(await evaluate(`${streams}.length`)) === 2);
      await eventually(async () => await evaluate(badge(id)) === '108×36 (following)');
      const second = `${streams}.at(-1)`;
      expect(await evaluate(`${second}.geometry[0]`)).toMatchObject({ cols: 108, rows: 36 });
      await evaluate('new Promise(resolve => setTimeout(resolve, 700))');
      expect(await evaluate(`${second}.resizes.length`)).toBe(0);
      expect((await api(port, token, `/sessions/${id}/snapshot`)).body)
        .toMatchObject({ cols: 108, rows: 36 });
      await send('Emulation.setDeviceMetricsOverride',
        { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
      await eventually(async () => Number(await evaluate(`${second}.resizes.length`)) === 1);
      const fit = await evaluate(`${second}.resizes[0]`) as { cols: number; rows: number; automatic: boolean };
      expect(fit.automatic).toBe(true);
      await eventually(async () => await evaluate(badge(id)) === `${fit.cols}×${fit.rows}`);
      expect((await api(port, token, `/sessions/${id}/snapshot`)).body)
        .toMatchObject({ cols: fit.cols, rows: fit.rows });
      expect((await api(port, token, `/sessions/${id}/resize`,
        { body: { cols: 110, rows: 37 } })).status).toBe(200);
      await eventually(async () => await evaluate(badge(id)) === '110×37 (following)');
      const socket = [...daemon!.daemon['sessionSockets'].get(id)!.keys()][0]!;
      const virtualId = daemon!.daemon['dashboardLayouts'].get(socket)!.id + 1000;
      await evaluate(`${second}.socket.send(JSON.stringify({ type: 'layout',
        layoutId: ${virtualId}, eligible: true, real: false }))`);
      await eventually(() => daemon!.daemon['dashboardLayouts'].get(socket)?.id === virtualId);
      const choice = Number(await evaluate(`${second}.geometry.at(-1).choiceRevision`));
      await evaluate(`${second}.socket.send(JSON.stringify({ type: 'resize',
        cols: 130, rows: 40, take: true, automatic: true, takeId: 999,
        choiceRevision: ${choice}, layoutId: ${virtualId} }))`);
      await eventually(async () => Number(await evaluate(`${second}.geometry.at(-1).refusedTakeId`)) === 999);
      expect((await api(port, token, `/sessions/${id}/snapshot`)).body)
        .toMatchObject({ cols: 110, rows: 37 });
    },
  });
}, 120_000);

it('cancels a queued release fit when the pane settles below the floor', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const agent = AGENT_MODULES.find(module => module.input?.resizeBehindSubmit)!.name;
  const id = await startSession(83, 25, agent);
  const { port, token } = daemon!;
  const session = daemon!.daemon['manager'].get(id)!;
  const driver = await connectWs(port, id, token);
  let release!: () => void;
  const submit = new Promise<void>(resolve => { release = resolve; });
  try {
    await driver.waitForControl(frame => frame.control === 'yours');
    await captureDashboard({ browser, viewerUrl: await open(), width: 1600, height: 1000,
      drive: true, probeOnly: true, beforeNavigateScript: gridMode, timeoutMs: 60_000,
      probe: `!!${stream(id)}`,
      interact: async ({ evaluate, send }) => {
        await eventually(async () => await evaluate(badge(id)) === '83×25 (following)');
        session['writeChain'] = submit;
        session['submissionsQueued']++;
        try {
          driver.close();
          await eventually(async () => Number(await evaluate(`${stream(id)}.resizes.length`)) === 1);
          const take = await evaluate(`${stream(id)}.resizes[0]`) as { takeId: number; automatic: boolean };
          expect(take).toMatchObject({ automatic: true, takeId: 1 });
          await send('Emulation.setDeviceMetricsOverride',
            { width: 410, height: 320, deviceScaleFactor: 1, mobile: false });
          await eventually(async () => await evaluate("document.querySelector('.pane').classList.contains('below-floor')") === true);
          await eventually(() => {
            const socket = [...daemon!.daemon['sessionSockets'].get(id)!.keys()][0]!;
            return daemon!.daemon['dashboardLayouts'].get(socket)?.eligible === false;
          });
        } finally {
          session['submissionsQueued']--;
          release();
          await session['writeChain'];
        }
        await eventually(async () => Number(await evaluate(`${stream(id)}.geometry.at(-1).refusedTakeId`)) === 1);
        expect(await evaluate(badge(id))).toBe('83×25 (following)');
        expect((await api(port, token, `/sessions/${id}/snapshot`)).body).toMatchObject({ cols: 83, rows: 25 });
      },
    });
  } finally { driver.close(); release(); }
}, 120_000);

it.for(['HTTP', 'MCP', 'CLI'] as const)(
  'keeps an unheld %s resize ahead of an earlier release fit', { timeout: 120_000 }, async (kind, context) => {
    if (!browser) { context.skip(); return; }
    const open = await setup();
    const id = await startSession();
    const { port, token, home } = daemon!;
    const driver = await connectWs(port, id, token);
    const delayTake = `(() => {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        if (typeof data === 'string' && data.includes('"type":"resize"') && data.includes('"take":true')) {
          window.__heldFit = data;
          window.__deliverFit = () => send.call(this, data);
          WebSocket.prototype.send = send;
          return;
        }
        return send.call(this, data);
      };
    })()`;
    try {
      await driver.waitForControl(frame => frame.control === 'yours');
      await captureDashboard({ browser, viewerUrl: await open(), width: 1600, height: 1000,
        drive: true, probeOnly: true, beforeNavigateScript: `${gridMode};${delayTake}`, timeoutMs: 60_000,
        probe: `!!${stream(id)}`,
        interact: async ({ evaluate, send }) => {
          await eventually(async () => await evaluate(badge(id)) === '83×25 (following)');
          driver.close();
          await eventually(async () => await evaluate('typeof window.__deliverFit') === 'function');
          if (kind === 'HTTP') {
            expect((await api(port, token, `/sessions/${id}/resize`,
              { body: { cols: 108, rows: 36 } })).status).toBe(200);
          } else if (kind === 'CLI') {
            await promisify(execFile)(process.execPath, [join(repoRoot, 'dist', 'cli', 'index.js'),
              'resize', id, '108', '36'], { env: { ...process.env, SHELLPUPPET_HOME: home }, timeout: 30_000 });
          } else {
            const client = new Client({ name: 'geometry-test', version: '1.0.0' });
            try {
              await client.connect(new StdioClientTransport({ command: process.execPath,
                args: [join(repoRoot, 'dist', 'mcp', 'index.js')],
                env: { ...process.env, SHELLPUPPET_HOME: home }, stderr: 'pipe' }));
              const result = await client.callTool({ name: 'terminal_resize',
                arguments: { session: id, cols: 108, rows: 36 } });
              expect(result.isError).not.toBe(true);
            } finally { await client.close(); }
          }
          await eventually(async () => await evaluate(badge(id)) === '108×36 (following)');
          await evaluate('window.__deliverFit()');
          await eventually(async () => Number(await evaluate(`${stream(id)}.geometry.at(-1).refusedTakeId`)) === 1);
          expect(await evaluate(badge(id))).toBe('108×36 (following)');
          expect((await api(port, token, `/sessions/${id}/snapshot`)).body).toMatchObject({ cols: 108, rows: 36 });
          await send('Emulation.setDeviceMetricsOverride',
            { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
          await eventually(async () => Number(String(await evaluate(badge(id))).split('×')[0]) > 108);
          const size = String(await evaluate(badge(id)));
          const [cols, rows] = size.split('×').map(Number);
          expect((await api(port, token, `/sessions/${id}/snapshot`)).body).toMatchObject({ cols, rows });
        },
      });
    } finally { driver.close(); }
  });

it('keeps a newer fit behind a delayed first acknowledgement', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const id = await startSession();
  const { port, token } = daemon!;
  const holdReply = `(() => {
    window.WebSocket = new Proxy(window.WebSocket, { construct(Target, args) {
      const socket = new Target(...args);
      if (new URL(args[0]).pathname !== '/sessions/${id}/stream') return socket;
      let held = false;
      const replies = [];
      socket.addEventListener('message', event => {
        if (held || typeof event.data !== 'string') return;
        const frame = JSON.parse(event.data);
        if (frame.control === 'yours') {
          held = true;
          event.stopImmediatePropagation();
          replies.push(event);
        }
      });
      window.__releaseFirst = () => socket.onmessage(replies.shift());
      return socket;
    } });
  })()`;
  await captureDashboard({ browser, viewerUrl: await open(), width: 1600, height: 1000,
    drive: true, probeOnly: true, beforeNavigateScript: `${gridMode};${holdReply}`, timeoutMs: 60_000,
    probe: `typeof window.__releaseFirst === 'function'`,
    interact: async ({ evaluate, send }) => {
      await eventually(async () => Number(await evaluate(`${stream(id)}.resizes.length`)) === 1);
      const first = await evaluate(`${stream(id)}.resizes[0]`) as { cols: number; rows: number; takeId: number; layoutId: number };
      await eventually(async () => (await api(port, token, `/sessions/${id}/snapshot`)).body['cols'] === first.cols);
      await send('Emulation.setDeviceMetricsOverride',
        { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
      await new Promise(resolve => setTimeout(resolve, 900));
      expect(await evaluate(`${stream(id)}.resizes.length`)).toBe(1);
      await evaluate('window.__releaseFirst()');
      await eventually(async () => Number(await evaluate(`${stream(id)}.resizes.length`)) === 2);
      const second = await evaluate(`${stream(id)}.resizes[1]`) as typeof first;
      expect(second.takeId).toBeGreaterThan(first.takeId);
      expect(second.cols).toBeLessThan(first.cols);
      expect(second.rows).toBeLessThan(first.rows);
      await eventually(async () => await evaluate(badge(id)) === `${second.cols}×${second.rows}`);
      expect((await api(port, token, `/sessions/${id}/snapshot`)).body)
        .toMatchObject({ cols: second.cols, rows: second.rows });
    },
  });
}, 120_000);

it('retries identical dimensions after one native automatic resize failure', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const id = await startSession();
  const { port, token } = daemon!;
  const session = daemon!.daemon['manager'].get(id)!;
  const resize = vi.spyOn(session['pty'], 'resize').mockImplementationOnce(() => { throw new Error('Resize failed'); });
  try {
    await captureDashboard({ browser, viewerUrl: await open(), width: 1600, height: 1000,
      drive: true, probeOnly: true, beforeNavigateScript: gridMode, timeoutMs: 60_000,
      probe: `!!${stream(id)}`,
      interact: async ({ evaluate }) => {
        await eventually(async () => Number(await evaluate(`${stream(id)}.geometry.at(-1).refusedTakeId`)) === 1);
        expect(await evaluate(badge(id))).toBe('83×25 (following)');
        expect((await api(port, token, `/sessions/${id}/snapshot`)).body).toMatchObject({ cols: 83, rows: 25 });
        const first = await evaluate(`${stream(id)}.resizes[0]`) as { cols: number; rows: number; takeId: number };
        expect(first.takeId).toBe(1);
        await evaluate("document.getElementById('auto-fit').click(); document.getElementById('auto-fit').click()");
        await eventually(async () => Number(await evaluate(`${stream(id)}.resizes.length`)) === 2);
        const second = await evaluate(`${stream(id)}.resizes[1]`) as typeof first;
        expect(second).toMatchObject({ cols: first.cols, rows: first.rows, takeId: 2 });
        await eventually(async () => await evaluate(badge(id)) === `${first.cols}×${first.rows}`);
        expect(resize.mock.calls).toEqual([[first.cols, first.rows], [first.cols, first.rows]]);
        expect((await api(port, token, `/sessions/${id}/snapshot`)).body)
          .toMatchObject({ cols: first.cols, rows: first.rows });
      },
    });
  } finally { resize.mockRestore(); }
}, 120_000);

it.for(['after', 'before'] as const)(
  'orders a layout %s an explicit resize with delayed geometry delivery',
  { timeout: 120_000 }, async (order, context) => {
    if (!browser) { context.skip(); return; }
    const open = await setup();
    const id = await startSession();
    const { port, token } = daemon!;
    await captureDashboard({ browser, viewerUrl: await open(), width: 1600, height: 1000,
      drive: true, probeOnly: true, beforeNavigateScript: gridMode, timeoutMs: 60_000,
      probe: `${stream(id)}?.geometry.at(-1)?.control === 'yours'`,
      interact: async ({ evaluate, send }) => {
        await eventually(async () => Number(String(await evaluate(badge(id))).split('×')[0]) > 83);
        await evaluate(`(() => {
          const socket = ${stream(id)}.socket;
          const receive = socket.onmessage, send = socket.send.bind(socket), messages = [];
          socket.onmessage = event => messages.push(event);
          window.__deliverGeometry = () => {
            socket.onmessage = receive;
            for (const event of messages) receive.call(socket, event);
          };
          socket.send = data => {
            if (typeof data !== 'string' || !data.includes('"type":"resize"') ||
                !data.includes('"take":true')) return send(data);
            window.__pendingFit = JSON.parse(data);
            window.__deliverFit = () => { socket.send = send; send(data); };
          };
        })()`);
        const resizeClient = async () => {
          const origin = performance.timeOrigin;
          const skew = vi.spyOn(performance, 'timeOrigin', 'get')
            .mockReturnValue(origin + (order === 'after' ? 60_000 : -60_000));
          try {
            expect((await api(port, token, `/sessions/${id}/resize`,
              { body: { cols: 108, rows: 36 } })).status).toBe(200);
          } finally { skew.mockRestore(); }
        };
        if (order === 'after') await resizeClient();
        await send('Emulation.setDeviceMetricsOverride',
          { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
        await eventually(async () => await evaluate('typeof window.__deliverFit') === 'function');
        const wanted = await evaluate('window.__pendingFit') as { cols: number; rows: number; takeId?: number };
        expect(wanted.takeId).toBeGreaterThan(0);
        if (order === 'before') await resizeClient();
        await evaluate('window.__deliverFit()');
        if (order === 'before') {
          await eventually(async () => Number(await evaluate(`${stream(id)}.geometry.at(-1).refusedTakeId`)) === wanted.takeId);
        } else {
          await eventually(async () => (await api(port, token, `/sessions/${id}/snapshot`)).body['cols'] === wanted.cols);
        }
        await evaluate('window.__deliverGeometry()');
        const expected = order === 'after' ? `${wanted.cols}×${wanted.rows}` : '108×36 (following)';
        await eventually(async () => await evaluate(badge(id)) === expected);
        expect((await api(port, token, `/sessions/${id}/snapshot`)).body).toMatchObject(order === 'after'
          ? { cols: wanted.cols, rows: wanted.rows } : { cols: 108, rows: 36 });
      },
    });
  });

it('preserves a live controller that arrives while a release fit waits', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const agent = AGENT_MODULES.find(module => module.input?.resizeBehindSubmit)!.name;
  const id = await startSession(83, 25, agent);
  const { port, token } = daemon!;
  const session = daemon!.daemon['manager'].get(id)!;
  const original = await connectWs(port, id, token);
  let release!: () => void;
  const submit = new Promise<void>(resolve => { release = resolve; });
  try {
    await original.waitForControl(frame => frame.control === 'yours');
    await captureDashboard({ browser, viewerUrl: await open(), width: 1600, height: 1000,
      drive: true, probeOnly: true, beforeNavigateScript: gridMode, timeoutMs: 60_000,
      probe: `!!${stream(id)}`,
      interact: async ({ evaluate }) => {
        await eventually(async () => await evaluate(badge(id)) === '83×25 (following)');
        session['writeChain'] = submit;
        session['submissionsQueued']++;
        let replacement: Awaited<ReturnType<typeof connectWs>> | undefined;
        try {
          original.close();
          await eventually(async () => Number(await evaluate(`${stream(id)}.resizes.length`)) === 1);
          replacement = await connectWs(port, id, token);
          await replacement.waitForControl(frame => frame.control === 'yours');
        } finally {
          session['submissionsQueued']--;
          release();
          await session['writeChain'];
        }
        try {
          await eventually(async () => Number(await evaluate(`${stream(id)}.geometry.at(-1).refusedTakeId`)) === 1);
          expect(await evaluate(badge(id))).toBe('83×25 (following)');
          expect((await api(port, token, `/sessions/${id}/snapshot`)).body).toMatchObject({ cols: 83, rows: 25 });
        } finally { replacement?.close(); }
      },
    });
  } finally { original.close(); release(); }
}, 120_000);

it('leaves an explicit grid in an unchanged pane after neighbour and catalogue events', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const first = await startSession();
  const second = await startSession();
  await startSession();
  const { port, token } = daemon!;
  const driver = await connectWs(port, second, token);
  try {
    await driver.waitForControl(frame => frame.control === 'yours');
    await captureDashboard({ browser, viewerUrl: await open(), width: 2000, height: 900,
      drive: true, probeOnly: true, beforeNavigateScript: gridMode, timeoutMs: 60_000,
      probe: `document.querySelectorAll('.pane').length === 3`,
      interact: async ({ evaluate }) => {
        await eventually(async () => Number(String(await evaluate(badge(first))).split('×')[0]) > 83);
        expect((await api(port, token, `/sessions/${first}/resize`,
          { body: { cols: 108, rows: 36 } })).status).toBe(200);
        await eventually(async () => await evaluate(badge(first)) === '108×36 (following)');
        const box = await evaluate(`document.querySelector('.pane[data-session="${first}"] .pane-wrap')
          .getBoundingClientRect().toJSON()`) as { width: number; height: number };
        const count = Number(await evaluate(`${stream(first)}.resizes.length`));
        driver.close();
        await eventually(async () => await evaluate(`${stream(second)}.geometry.some(frame => frame.owned === false)`) === true);
        const fourth = await startSession();
        await eventually(async () => await evaluate(`document.querySelectorAll('.pane').length`) === 4);
        await eventually(async () => Number(String(await evaluate(badge(fourth))).split('×')[0]) > 83);
        const afterBox = await evaluate(`document.querySelector('.pane[data-session="${first}"] .pane-wrap')
          .getBoundingClientRect().toJSON()`) as typeof box;
        expect(afterBox.width).toBe(box.width);
        expect(afterBox.height).toBe(box.height);
        expect(await evaluate(badge(first))).toBe('108×36 (following)');
        expect(Number(await evaluate(`${stream(first)}.resizes.length`))).toBe(count);
        expect((await api(port, token, `/sessions/${first}/snapshot`)).body).toMatchObject({ cols: 108, rows: 36 });
      },
    });
  } finally { driver.close(); }
}, 120_000);

it('answers a queued API resize only after applying it', async () => {
  await setup();
  const agent = AGENT_MODULES.find(module => module.input?.resizeBehindSubmit)!.name;
  const id = await startSession(83, 25, agent);
  const { port, token } = daemon!;
  const session = daemon!.daemon['manager'].get(id)!;
  let release!: () => void;
  const submit = new Promise<void>(resolve => { release = resolve; });
  session['writeChain'] = submit;
  session['submissionsQueued']++;
  let answered = false;
  const request = api(port, token, `/sessions/${id}/resize`, { body: { cols: 108, rows: 36 } })
    .then(response => { answered = true; return response; });
  try {
    await eventually(() => session['writeChain'] !== submit);
    expect(answered).toBe(false);
    expect((await api(port, token, `/sessions/${id}/snapshot`)).body).toMatchObject({ cols: 83, rows: 25 });
  } finally {
    session['submissionsQueued']--;
    release();
    await session['writeChain'];
  }
  expect((await request).status).toBe(200);
  expect((await api(port, token, `/sessions/${id}/snapshot`)).body).toMatchObject({ cols: 108, rows: 36 });
}, 60_000);

it('does not take a newly assigned pane from a later live controller', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const id = await startSession();
  const { port, token } = daemon!;
  const delayTake = `(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (typeof data === 'string' && data.includes('"type":"resize"') && data.includes('"take":true')) {
        window.__deliverFit = () => send.call(this, data);
        WebSocket.prototype.send = send;
        return;
      }
      return send.call(this, data);
    };
  })()`;
  await captureDashboard({ browser, viewerUrl: await open(), width: 1600, height: 1000,
    drive: true, probeOnly: true, beforeNavigateScript: `${gridMode};${delayTake}`, timeoutMs: 60_000,
    probe: `typeof window.__deliverFit === 'function'`,
    interact: async ({ evaluate }) => {
      const driver = await connectWs(port, id, token);
      try {
        await driver.waitForControl(frame => frame.control === 'yours');
        driver.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 30, take: true }));
        await driver.waitForControl(frame => frame.type === 'geometry' && frame.cols === 90 && frame.rows === 30);
        const before = Number(await evaluate(`${stream(id)}.geometry.length`));
        await evaluate('window.__deliverFit()');
        await eventually(async () => Number(await evaluate(`${stream(id)}.geometry.length`)) > before);
        expect(await evaluate(badge(id))).toBe('90×30 (following)');
        expect((await api(port, token, `/sessions/${id}/snapshot`)).body).toMatchObject({ cols: 90, rows: 30 });
        const takes = await evaluate(`${stream(id)}.resizes`) as { takeId?: number; automatic?: boolean }[];
        expect(takes).toHaveLength(1);
        expect(takes[0]).toMatchObject({ takeId: 1, automatic: true });
      } finally { driver.close(); }
    },
  });
}, 120_000);

it('waits below the floor after release and fits after that pane grows', async context => {
  if (!browser) { context.skip(); return; }
  const open = await setup();
  const id = await startSession();
  const { port, token } = daemon!;
  const driver = await connectWs(port, id, token);
  try {
    await driver.waitForControl(frame => frame.control === 'yours');
    await captureDashboard({ browser, viewerUrl: await open(), width: 410, height: 320,
      drive: true, probeOnly: true, beforeNavigateScript: gridMode, timeoutMs: 60_000,
      probe: `!!${stream(id)}`,
      interact: async ({ evaluate, send }) => {
        await eventually(async () => await evaluate(badge(id)) === '83×25 (following)');
        await eventually(async () => await evaluate("document.querySelector('.pane').classList.contains('below-floor')") === true);
        driver.close();
        await eventually(async () => await evaluate(`${stream(id)}.geometry.at(-1).owned`) === false);
        expect(await evaluate(`${stream(id)}.resizes.length`)).toBe(0);
        await send('Emulation.setDeviceMetricsOverride',
          { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
        await eventually(async () => Number(String(await evaluate(badge(id))).split('×')[0]) > 83);
        const size = String(await evaluate(badge(id)));
        const [cols, rows] = size.split('×').map(Number);
        const takes = await evaluate(`${stream(id)}.resizes`) as { automatic?: boolean; takeId?: number }[];
        const replies = await evaluate(`${stream(id)}.geometry`) as
          { acceptedTakeId?: number; refusedTakeId?: number }[];
        expect(takes.length).toBeGreaterThanOrEqual(1);
        expect(takes.length).toBeLessThanOrEqual(2);
        expect(takes.map(take => take.takeId)).toEqual(takes.map((_, index) => index + 1));
        expect(takes.every(take => take.automatic === true)).toBe(true);
        expect(replies.filter(reply => reply.acceptedTakeId !== undefined)
          .map(reply => reply.acceptedTakeId)).toEqual([takes.at(-1)!.takeId]);
        expect(replies.filter(reply => reply.refusedTakeId !== undefined)
          .map(reply => reply.refusedTakeId)).toEqual(takes.slice(0, -1).map(take => take.takeId));
        expect((await api(port, token, `/sessions/${id}/snapshot`)).body).toMatchObject({ cols, rows });
      },
    });
  } finally { driver.close(); }
}, 120_000);

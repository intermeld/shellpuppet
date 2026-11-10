import type { IPty } from 'node-pty';
import { expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import type { SessionDeps } from '../../src/core/session.js';
import { api, connectWs, startTestDaemon } from './helpers.js';

it('does not let a departed queued viewport strand the wider grid', async () => {
  const td = await startTestDaemon({ policy: { mode: 'allow-all' } });
  let output: (data: string) => void = () => {};
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'synthetic', handleFlowControl: false,
    onData: (fn: (data: string) => void) => { output = fn; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
    resize(cols: number, rows: number) { Object.assign(this, { cols, rows }); },
    write() {}, clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  let release: (() => void) | undefined;
  try {
    const manager = (td.daemon as unknown as { manager: SessionManager }).manager;
    const internal = manager as unknown as { sessionDeps: SessionDeps };
    internal.sessionDeps = { ...internal.sessionDeps, platform: 'linux', spawn: () => pty,
      pidWaitMs: 0, treeKiller: () => Promise.resolve(null) };
    const session = manager.create({ command: process.execPath, agent: 'muse', cols: 80, rows: 24 });
    output('ready');
    const driver = await connectWs(td.port, session.id, td.token);
    await driver.waitForControl(c => c['type'] === 'geometry' && c['control'] === 'yours');
    const departing = await connectWs(td.port, session.id, td.token, {}, { drive: false });
    await departing.waitForControl(c => c['type'] === 'geometry');
    const wider = api(td.port, td.token, `/sessions/${session.id}/snapshot?wider=140x40&widerTimeout=1000`);
    await driver.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 140 && c['temporary'] === true);
    const state = session as unknown as { writeChain: Promise<void>; submissionsQueued: number };
    state.writeChain = new Promise<void>(resolve => { release = resolve; });
    state.submissionsQueued = 1;
    const blocked = state.writeChain;
    departing.ws.send(JSON.stringify({ type: 'resize', cols: 150, rows: 45, take: true }));
    for (let i = 0; i < 100 && state.writeChain === blocked; i++) await new Promise(r => setTimeout(r, 10));
    expect(state.writeChain).not.toBe(blocked);
    departing.close();
    await new Promise<void>(resolve => departing.ws.once('close', () => resolve()));
    for (let i = 0; i < 100 && td.daemon.connectedSockets !== 1; i++) await new Promise(r => setTimeout(r, 10));
    expect(td.daemon.connectedSockets).toBe(1);
    release?.(); release = undefined;
    const result = await wider;
    const after = await api(td.port, td.token, `/sessions/${session.id}/snapshot`);
    const controller = (td.daemon as unknown as { geometryController: Map<string, { readyState: number }> }).geometryController.get(session.id);
    expect({ cols: after.body['cols'], rows: after.body['rows'], restored: result.body['restored'],
      controllerState: controller?.readyState, lastFrame: driver.controls().filter(c => c['type'] === 'geometry').at(-1) })
      .toMatchObject({ cols: 80, rows: 24, restored: true, controllerState: 1,
        lastFrame: { cols: 80, rows: 24, control: 'yours' } });
    expect((await driver.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 80 && c['temporary'] !== true))['control']).toBe('yours');
    driver.close();
  } finally {
    release?.();
    await td.stop();
  }
});

it.each(['before', 'after'] as const)('orders a live viewport take queued %s restore', async (order) => {
  const td = await startTestDaemon({ policy: { mode: 'allow-all' } });
  let output: (data: string) => void = () => {};
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'synthetic', handleFlowControl: false,
    onData: (fn: (data: string) => void) => { output = fn; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
    resize(cols: number, rows: number) { Object.assign(this, { cols, rows }); },
    write() {}, clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  let release: (() => void) | undefined;
  try {
    const manager = (td.daemon as unknown as { manager: SessionManager }).manager;
    const internal = manager as unknown as { sessionDeps: SessionDeps };
    internal.sessionDeps = { ...internal.sessionDeps, platform: 'linux', spawn: () => pty,
      pidWaitMs: 0, treeKiller: () => Promise.resolve(null) };
    const session = manager.create({ command: process.execPath, agent: 'muse', cols: 80, rows: 24 });
    output('ready');
    const driver = await connectWs(td.port, session.id, td.token);
    await driver.waitForControl(c => c['type'] === 'geometry' && c['control'] === 'yours');
    const taker = await connectWs(td.port, session.id, td.token, {}, { drive: false });
    await taker.waitForControl(c => c['type'] === 'geometry');
    const wider = api(td.port, td.token, `/sessions/${session.id}/snapshot?wider=140x40&widerTimeout=1000`);
    await driver.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 140 && c['temporary'] === true);
    const state = session as unknown as { writeChain: Promise<void>; submissionsQueued: number };
    state.writeChain = new Promise<void>(resolve => { release = resolve; });
    state.submissionsQueued = 1;
    const blocked = state.writeChain;
    if (order === 'after') {
      for (let i = 0; i < 150 && state.writeChain === blocked; i++) await new Promise(r => setTimeout(r, 10));
      expect(state.writeChain).not.toBe(blocked);
    }
    const prior = state.writeChain;
    taker.ws.send(JSON.stringify({ type: 'resize', cols: 150, rows: 45, take: true }));
    for (let i = 0; i < 100 && state.writeChain === prior; i++) await new Promise(r => setTimeout(r, 10));
    expect(state.writeChain).not.toBe(prior);
    if (order === 'before') {
      const takeChain = state.writeChain;
      for (let i = 0; i < 150 && state.writeChain === takeChain; i++) await new Promise(r => setTimeout(r, 10));
      expect(state.writeChain).not.toBe(takeChain);
    }
    release?.(); release = undefined;
    const result = await wider;
    const after = await api(td.port, td.token, `/sessions/${session.id}/snapshot`);
    expect(after.body).toMatchObject({ cols: 150, rows: 45 });
    expect(result.body).toMatchObject({ restored: order === 'after' });
    expect(driver.controls().filter(c => c['type'] === 'geometry').at(-1))
      .toMatchObject({ cols: 150, rows: 45, control: 'adopt' });
    taker.close(); driver.close();
  } finally {
    release?.();
    await td.stop();
  }
});

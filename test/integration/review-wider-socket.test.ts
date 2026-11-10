import type { IPty } from 'node-pty';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { SessionManager } from '../../src/core/manager.js';
import type { SessionDeps } from '../../src/core/session.js';
import { startTestDaemon, connectWs, api } from './helpers.js';
import type { TestDaemon } from './helpers.js';

function injectPty(td: TestDaemon, pty: IPty): SessionManager {
  const manager = (td.daemon as unknown as { manager: SessionManager }).manager;
  const internal = manager as unknown as { sessionDeps: SessionDeps };
  internal.sessionDeps = { ...internal.sessionDeps, platform: 'linux', spawn: () => pty,
    pidWaitMs: 0, treeKiller: () => Promise.resolve(null) };
  return manager;
}

it.each(['before', 'after'] as const)('serialises a deliberate resize queued %s the wider restore', async (order) => {
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
    const session = injectPty(td, pty).create({ command: process.execPath, agent: 'muse', cols: 80, rows: 24 });
    output('ready');
    const watcher = await connectWs(td.port, session.id, td.token);
    await watcher.waitForControl(c => c['type'] === 'geometry');
    const wider = api(td.port, td.token, `/sessions/${session.id}/snapshot?wider=140x40&widerTimeout=1000`);
    await watcher.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 140 && c['temporary'] === true);
    const state = session as unknown as { writeChain: Promise<void>; submissionsQueued: number };
    state.writeChain = new Promise<void>(resolve => { release = resolve; });
    state.submissionsQueued = 1;
    const blocked = state.writeChain;
    const deliberateResize = () => api(td.port, td.token, `/sessions/${session.id}/resize`, {
      method: 'POST', body: { cols: 150, rows: 45 },
    });
    let deliberate: ReturnType<typeof deliberateResize>;
    if (order === 'before') {
      deliberate = deliberateResize();
      for (let i = 0; i < 100 && state.writeChain === blocked; i++) await new Promise(r => setTimeout(r, 10));
      expect(state.writeChain).not.toBe(blocked);
      const apiChain = state.writeChain;
      for (let i = 0; i < 100 && state.writeChain === apiChain; i++) await new Promise(r => setTimeout(r, 10));
      expect(state.writeChain).not.toBe(apiChain);
    } else {
      for (let i = 0; i < 150 && state.writeChain === blocked; i++) await new Promise(r => setTimeout(r, 10));
      expect(state.writeChain).not.toBe(blocked);
      const restoreChain = state.writeChain;
      deliberate = deliberateResize();
      for (let i = 0; i < 100 && state.writeChain === restoreChain; i++) await new Promise(r => setTimeout(r, 10));
      expect(state.writeChain).not.toBe(restoreChain);
    }
    release?.(); release = undefined;
    expect((await deliberate).status).toBe(200);
    const result = await wider;
    const after = await api(td.port, td.token, `/sessions/${session.id}/snapshot`);
    expect(after.body).toMatchObject({ cols: 150, rows: 45 });
    expect(result.body).toMatchObject({ restored: order === 'after' });
    const frames = watcher.controls().filter(c => c['type'] === 'geometry');
    expect(frames.at(-1)).toMatchObject({ cols: 150, rows: 45 });
    expect(frames.at(-1)?.['temporary']).not.toBe(true);
    watcher.close();
  } finally {
    release?.();
    await td.stop();
  }
});

it('restores the original grid if its controlling socket closes during a wider read', async () => {
  const td = await startTestDaemon({ policy: { mode: 'allow-all' } });
  let output: (data: string) => void = () => {};
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'synthetic', handleFlowControl: false,
    onData: (fn: (data: string) => void) => { output = fn; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
    resize(cols: number, rows: number) { Object.assign(this, { cols, rows }); },
    write() {}, clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  try {
    const manager = injectPty(td, pty);
    const session = manager.create({ command: process.execPath, cols: 80, rows: 24 });
    output('ready');
    const watcher = await connectWs(td.port, session.id, td.token);
    expect((await watcher.waitForControl(c => c['type'] === 'geometry'))['control']).toBe('yours');
    const passive = await connectWs(td.port, session.id, td.token, {}, { drive: false });
    expect(await passive.waitForControl(c => c['type'] === 'geometry')).toMatchObject({ control: 'adopt', owned: true });
    const pending = api(td.port, td.token, `/sessions/${session.id}/snapshot?wider=140x40&widerTimeout=1000`);
    await watcher.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 140);
    await passive.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 140);
    watcher.close();
    const result = await pending;
    const normal = await passive.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 80 && c['temporary'] !== true && c['owned'] === false);
    expect(normal).toMatchObject({ rows: 24, control: 'adopt' });
    const after = await api(td.port, td.token, `/sessions/${session.id}/snapshot`);
    expect({ cols: after.body['cols'], rows: after.body['rows'], restored: result.body['restored'] })
      .toEqual({ cols: 80, rows: 24, restored: true });
    passive.close();
  } finally {
    await td.stop();
  }
});

it('returns the ended refusal without a restore frame when the program exits during the read', async () => {
  const td = await startTestDaemon({ policy: { mode: 'allow-all' } });
  let exit: (event: { exitCode: number }) => void = () => {};
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'synthetic', handleFlowControl: false,
    onData: () => ({ dispose() {} }),
    onExit: (fn: (event: { exitCode: number }) => void) => { exit = fn; return { dispose() {} }; },
    resize(cols: number, rows: number) { Object.assign(this, { cols, rows }); },
    write() {}, clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  try {
    const manager = injectPty(td, pty);
    const session = manager.create({ command: process.execPath, cols: 80, rows: 24 });
    const watcher = await connectWs(td.port, session.id, td.token);
    await watcher.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 80);
    const pending = api(td.port, td.token, `/sessions/${session.id}/snapshot?wider=140x40&widerTimeout=1000`);
    await watcher.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 140);
    exit({ exitCode: 0 });
    const result = await pending;
    expect(result.status).toBe(409);
    expect(result.body['error']).toMatch(/exited/i);
    expect(watcher.controls().filter(c => c['type'] === 'geometry').map(c => c['cols'])).toEqual([80, 140]);
    watcher.close();
  } finally {
    await td.stop();
  }
});

it('restores after an automatic viewer adoption during the read', async () => {
  const td = await startTestDaemon({ policy: { mode: 'allow-all' } });
  const pty = {
    pid: 0, cols: 80, rows: 24, process: 'synthetic', handleFlowControl: false,
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    resize(cols: number, rows: number) { Object.assign(this, { cols, rows }); },
    write() {}, clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  try {
    const session = injectPty(td, pty).create({ command: process.execPath, cols: 80, rows: 24 });
    const passive = await connectWs(td.port, session.id, td.token, {}, { drive: false });
    expect(await passive.waitForControl(c => c['type'] === 'geometry')).toMatchObject({ owned: false });
    const pending = api(td.port, td.token, `/sessions/${session.id}/snapshot?wider=140x40&widerTimeout=1000`);
    await passive.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 140 && c['temporary'] === true);
    const driver = await connectWs(td.port, session.id, td.token);
    expect(await driver.waitForControl(c => c['type'] === 'geometry')).toMatchObject({ cols: 140, control: 'yours' });
    const result = await pending;
    expect(result.body).toMatchObject({ restored: true });
    expect(await driver.waitForControl(c => c['type'] === 'geometry' && c['cols'] === 80 && c['temporary'] !== true))
      .toMatchObject({ rows: 24, control: 'yours', owned: true });
    driver.close();
    passive.close();
  } finally {
    await td.stop();
  }
});

it('keeps an established MiMo stall through a wider read', async () => {
  const td = await startTestDaemon({ policy: { mode: 'allow-all' } });
  let output: (data: string) => void = () => {};
  const pty = {
    pid: 0, cols: 120, rows: 30, process: 'synthetic', handleFlowControl: false,
    onData: (fn: (data: string) => void) => { output = fn; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
    resize(cols: number, rows: number) { Object.assign(this, { cols, rows }); },
    write() {}, clear() {}, kill() {}, pause() {}, resume() {},
  } satisfies IPty;
  try {
    const manager = injectPty(td, pty);
    const session = manager.create({ command: process.execPath, agent: 'mimo', cols: 120, rows: 30 });
    const transitions: unknown[] = [];
    session.onStall((state: unknown) => transitions.push(state));
    output(readFileSync(new URL('../fixtures/stalls/mimo-refusal.ansi', import.meta.url), 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 1500));
    const established = session.getStalled();
    expect(established).toBeDefined();
    expect(transitions).toEqual([established]);
    const result = await api(td.port, td.token, `/sessions/${session.id}/snapshot?wider=140x40&widerTimeout=500`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ cols: 140, rows: 40, restored: true });
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(session.getStalled()).toEqual(established);
    expect(transitions).toEqual([established]);
  } finally {
    await td.stop();
  }
});

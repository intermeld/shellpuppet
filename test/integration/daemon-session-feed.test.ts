/**
 * Dashboard session feed, exercised through an in-process daemon.
 *
 * The prompt scan is held off on the field daemon so a frame that arrives
 * with a resize, a viewer or an exit is the direct trigger and not the
 * scan's periodic summary. Prompt sightings, the stall and the clear run
 * on a second daemon whose scan is the real path for those fields.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeedFrame } from '../../src/daemon/sessionFeed.js';
import { api, connectWs, eventually, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let fields: TestDaemon;
let prompts: TestDaemon;

beforeAll(async () => {
  fields = await startTestDaemon({
    policy: { mode: 'allow-all' },
    // Far longer than this file, so the scan cannot publish a resize,
    // a watcher change, readiness or an exit that the direct trigger missed.
    promptScanIntervalMs: 600_000,
    promptStallMs: 600_000,
    idleCheckIntervalMs: 600_000,
    exitedGraceMs: 600_000,
  });
  prompts = await startTestDaemon({
    policy: { mode: 'allow-all' },
    promptScanIntervalMs: 70,
    promptStallMs: 2_500,
    idleCheckIntervalMs: 600_000,
    exitedGraceMs: 600_000,
  });
});

afterAll(async () => {
  await fields.stop();
  await prompts.stop();
}, 180_000);

function subscribe(daemon: TestDaemon, frames: FeedFrame[]): () => void {
  return daemon.daemon.subscribeDashboardFeed((frame) => frames.push(frame));
}

function forSession(frames: FeedFrame[], id: string): FeedFrame[] {
  return frames.filter((frame) =>
    (frame.type === 'session-removed' && frame.session === id) ||
    ((frame.type === 'session-added' || frame.type === 'session-updated') && frame.session.id === id),
  );
}

async function start(
  daemon: TestDaemon,
  script: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const result = await api(daemon.port, daemon.token, '/sessions', {
    body: {
      command: process.execPath,
      args: ['-e', script],
      shell: false,
      openViewer: false,
      ...extra,
    },
  });
  expect(result.status).toBe(200);
  return String(result.body['id']);
}

describe('dashboard feed fields, direct triggers', () => {
  const frames: FeedFrame[] = [];
  let unsubscribe = (): void => undefined;

  beforeAll(() => {
    unsubscribe = subscribe(fields, frames);
  });
  afterAll(() => unsubscribe());

  it('offers no feed route, and hello carries the same version as /health', async () => {
    expect(frames.slice(0, 2).map((frame) => frame.type)).toEqual(['hello', 'snapshot']);
    const hello = frames[0];
    expect(hello?.type).toBe('hello');
    const health = await api(fields.port, null, '/health');
    expect(health.status).toBe(200);
    if (hello?.type === 'hello') expect(hello.version).toBe(health.body['version']);
    const missing = await api(fields.port, fields.token, '/feed');
    expect(missing.status).toBe(404);
    const events = await api(fields.port, fields.token, '/events');
    expect(events.status).toBe(404);
  });

  it('gives two subscribers the same ordered deltas and stops after unsubscribe', async () => {
    const first: FeedFrame[] = [];
    const second: FeedFrame[] = [];
    const leaveFirst = subscribe(fields, first);
    const leaveSecond = subscribe(fields, second);
    const id = await start(fields, 'setInterval(() => {}, 200)', { label: 'shared-order' });
    const resized = await api(fields.port, fields.token, `/sessions/${id}/resize`, {
      body: { cols: 81, rows: 25 },
    });
    expect(resized.status).toBe(200);
    expect(forSession(first, id).map((frame) => frame.type)).toEqual([
      'session-added', 'session-updated',
    ]);
    expect(forSession(second, id)).toEqual(forSession(first, id));
    leaveSecond();
    const before = second.length;
    await api(fields.port, fields.token, `/sessions/${id}/resize`, {
      body: { cols: 82, rows: 25 },
    });
    expect(second).toHaveLength(before);
    expect(forSession(first, id).filter((frame) => frame.type === 'session-updated')).toHaveLength(2);
    leaveFirst();
  });

  it('publishes label, purpose, size and hold on add, then each later change from the HTTP resize path', async () => {
    const id = await start(fields, 'setInterval(() => {}, 200)', {
      label: 'geometry',
      purpose: 'observe the feed',
      cols: 70,
      rows: 18,
      hold: true,
    });
    const added = forSession(frames, id)[0];
    expect(added?.type).toBe('session-added');
    if (added?.type !== 'session-added') return;
    expect(added.session).toMatchObject({
      id,
      label: 'geometry',
      purpose: 'observe the feed',
      cols: 70,
      rows: 18,
      geometryHeld: true,
      ready: true,
      readyReason: 'not-tracked',
      watchers: 0,
      exited: false,
      exitCode: null,
    });
    expect(added.session.waitingOnPrompt).toBeUndefined();

    const held = await api(fields.port, fields.token, `/sessions/${id}/resize`, {
      body: { cols: 90, rows: 30, hold: true },
    });
    expect(held.status).toBe(200);
    const heldFrame = forSession(frames, id).at(-1);
    expect(heldFrame?.type).toBe('session-updated');
    if (heldFrame?.type === 'session-updated') {
      expect(heldFrame.changed).toEqual(['cols', 'rows']);
      expect(heldFrame.session).toMatchObject({ cols: 90, rows: 30, geometryHeld: true });
    }

    const released = await api(fields.port, fields.token, `/sessions/${id}/resize`, {
      body: { cols: 90, rows: 32 },
    });
    expect(released.status).toBe(200);
    const releasedFrame = forSession(frames, id).at(-1);
    expect(releasedFrame?.type).toBe('session-updated');
    if (releasedFrame?.type === 'session-updated') {
      expect(releasedFrame.changed).toEqual(['rows', 'geometryHeld']);
      expect(releasedFrame.session).toMatchObject({ cols: 90, rows: 32, geometryHeld: false });
    }

    const listed = await api(fields.port, fields.token, '/sessions');
    const late: FeedFrame[] = [];
    const lateUnsub = subscribe(fields, late);
    const snapshot = late[1];
    expect(snapshot?.type).toBe('snapshot');
    if (snapshot?.type === 'snapshot') {
      const fromFeed = snapshot.sessions.find((session) => session.id === id);
      const fromList = (listed.body['sessions'] as { id: string }[]).find((session) => session.id === id);
      expect(fromFeed).toEqual(fromList);
    }
    lateUnsub();
  });

  it('publishes watcher count as viewers connect and leave, and a viewer resize', async () => {
    const id = await start(fields, 'setInterval(() => {}, 200)', {
      label: 'watchers',
      purpose: 'count sockets',
    });
    const first = await connectWs(fields.port, id, fields.token);
    await eventually(() => forSession(frames, id).some((frame) =>
      frame.type === 'session-updated' && frame.changed.includes('watchers') && frame.session.watchers === 1,
    ), 5_000);
    first.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }));
    await eventually(() => forSession(frames, id).some((frame) =>
      frame.type === 'session-updated' &&
      frame.changed.includes('cols') && frame.changed.includes('rows') &&
      frame.session.cols === 100 && frame.session.rows === 40,
    ), 5_000);
    const second = await connectWs(fields.port, id, fields.token);
    await eventually(() => forSession(frames, id).some((frame) =>
      frame.type === 'session-updated' && frame.session.watchers === 2,
    ), 5_000);
    // Only frames after the close count: the connect above already published a count of one.
    const beforeClose = forSession(frames, id).length;
    first.close();
    await eventually(() => forSession(frames, id).slice(beforeClose).some((frame) =>
      frame.type === 'session-updated' && frame.changed.includes('watchers') && frame.session.watchers === 1,
    ), 5_000);
    second.close();
    await eventually(() => forSession(frames, id).some((frame) =>
      frame.type === 'session-updated' && frame.changed.includes('watchers') && frame.session.watchers === 0,
    ), 5_000);
  });

  it('publishes ready and readyReason when the readiness condition settles, and not otherwise', async () => {
    const pending = await start(fields, "console.log('READY'); setInterval(() => {}, 200)", {
      label: 'readiness',
      purpose: 'become ready',
      readyText: 'READY',
    });
    const added = forSession(frames, pending)[0];
    expect(added?.type).toBe('session-added');
    if (added?.type === 'session-added') {
      expect(added.session).toMatchObject({ ready: false, readyReason: 'pending' });
    }
    await eventually(() => forSession(frames, pending).some((frame) =>
      frame.type === 'session-updated' &&
      frame.changed.includes('ready') && frame.changed.includes('readyReason') &&
      frame.session.ready === true && frame.session.readyReason === 'condition-met',
    ), 5_000);
    const readyIndex = forSession(frames, pending).findIndex((frame) =>
      frame.type === 'session-updated' && frame.changed.includes('ready'));
    expect(readyIndex).toBeGreaterThan(0);

    const plain = await start(fields, 'setInterval(() => {}, 200)', { label: 'no-ready' });
    const plainAdded = forSession(frames, plain)[0];
    if (plainAdded?.type === 'session-added') {
      expect(plainAdded.session).toMatchObject({ ready: true, readyReason: 'not-tracked' });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(forSession(frames, plain).some((frame) =>
      frame.type === 'session-updated' &&
      (frame.changed.includes('ready') || frame.changed.includes('readyReason')),
    )).toBe(false);
  });

  it('publishes exited and exitCode together, after session-added, and removal only on kill', async () => {
    const id = await start(fields, 'setTimeout(() => process.exit(42), 200)', {
      label: 'exit-code',
      purpose: 'end on its own',
    });
    await eventually(() => forSession(frames, id).some((frame) =>
      frame.type === 'session-updated' &&
      frame.changed.includes('exited') && frame.changed.includes('exitCode') &&
      frame.session.exited === true && frame.session.exitCode === 42,
    ), 10_000);
    const exitIndex = forSession(frames, id).findIndex((frame) =>
      frame.type === 'session-updated' && frame.changed.includes('exited'));
    expect(forSession(frames, id)[0]?.type).toBe('session-added');
    expect(exitIndex).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(forSession(frames, id).some((frame) => frame.type === 'session-removed')).toBe(false);

    const killed = await api(fields.port, fields.token, `/sessions/${id}`, { method: 'DELETE' });
    expect(killed.status).toBe(200);
    await eventually(() => forSession(frames, id).some((frame) => frame.type === 'session-removed'), 10_000);
    const mine = forSession(frames, id);
    expect(mine.filter((frame) => frame.type === 'session-removed')).toHaveLength(1);
    expect(mine.at(-1)?.type).toBe('session-removed');
  });

  it('lets a listener subscribe during session-added and still see one later delta', async () => {
    const nested: FeedFrame[] = [];
    let nestedUnsubscribe: (() => void) | undefined;
    const outerUnsubscribe = fields.daemon.subscribeDashboardFeed((frame) => {
      if (
        frame.type === 'session-added' &&
        frame.session.label === 'nested-join' &&
        nestedUnsubscribe === undefined
      ) {
        nestedUnsubscribe = fields.daemon.subscribeDashboardFeed((inner) => nested.push(inner));
      }
    });
    const id = await start(fields, 'setInterval(() => {}, 200)', {
      label: 'nested-join',
      purpose: 'join from a listener',
    });
    expect(nested[0]?.type).toBe('hello');
    expect(nested[1]?.type).toBe('snapshot');
    const snapshot = nested[1];
    if (snapshot?.type === 'snapshot') {
      expect(snapshot.sessions.some((session) => session.id === id)).toBe(true);
    }
    expect(forSession(nested, id).some((frame) => frame.type === 'session-added')).toBe(false);

    const resized = await api(fields.port, fields.token, `/sessions/${id}/resize`, {
      body: { cols: 88, rows: 20 },
    });
    expect(resized.status).toBe(200);
    const updates = forSession(nested, id).filter((frame) =>
      frame.type === 'session-updated' && frame.changed.includes('cols'));
    expect(updates).toHaveLength(1);
    outerUnsubscribe();
    nestedUnsubscribe?.();
  });

  it('stops delivering to a listener that unsubscribes inside a callback', async () => {
    const id = await start(fields, 'setInterval(() => {}, 200)', { label: 'unsubscribe' });
    const seen: FeedFrame[] = [];
    let unsubscribe = (): void => undefined;
    unsubscribe = fields.daemon.subscribeDashboardFeed((frame) => {
      if (!forSession([frame], id).length) return;
      seen.push(frame);
      if (frame.type === 'session-updated' && frame.changed.includes('cols')) unsubscribe();
    });
    const first = await api(fields.port, fields.token, `/sessions/${id}/resize`, {
      body: { cols: 77, rows: 22 },
    });
    expect(first.status).toBe(200);
    const count = seen.length;
    expect(seen.some((frame) => frame.type === 'session-updated' && frame.changed.includes('cols'))).toBe(true);
    const second = await api(fields.port, fields.token, `/sessions/${id}/resize`, {
      body: { cols: 78, rows: 22 },
    });
    expect(second.status).toBe(200);
    expect(seen).toHaveLength(count);
  });

  it('keeps delivering to other listeners when one throws', async () => {
    const thrown = fields.daemon.subscribeDashboardFeed(() => {
      throw new Error('subscriber fault');
    });
    const id = await start(fields, 'setInterval(() => {}, 200)', { label: 'thrower' });
    expect(forSession(frames, id)[0]?.type).toBe('session-added');
    const resized = await api(fields.port, fields.token, `/sessions/${id}/resize`, {
      body: { cols: 66, rows: 17 },
    });
    expect(resized.status).toBe(200);
    expect(forSession(frames, id).some((frame) =>
      frame.type === 'session-updated' && frame.changed.includes('cols'))).toBe(true);
    thrown();
  });
});

describe('dashboard feed prompts and removal races', () => {
  it('clears prompt state after the program exits', async () => {
    const frames: FeedFrame[] = [];
    const unsubscribe = subscribe(prompts, frames);
    try {
      const id = await start(prompts, [
        "process.stdout.write('Allow this?\\n  1 (•) Allow once\\n  2 (○) No\\n');",
        'setTimeout(() => process.exit(0), 1800);',
      ].join(' '), { label: 'prompt-exit' });
      await eventually(() => forSession(frames, id).some((frame) =>
        frame.type === 'session-updated' && frame.changed.includes('waitingOnPrompt') &&
        frame.session.waitingOnPrompt !== undefined,
      ), 10_000);
      await eventually(() => forSession(frames, id).some((frame) =>
        frame.type === 'session-updated' && frame.changed.includes('exited') && frame.session.exited,
      ), 10_000);
      await eventually(() => forSession(frames, id).some((frame) =>
        frame.type === 'session-updated' && frame.changed.includes('waitingOnPrompt') &&
        frame.session.waitingOnPrompt === undefined,
      ), 10_000);
    } finally {
      unsubscribe();
    }
  });

  it('publishes exit before the natural reap and removes the id once', async () => {
    const daemon = await startTestDaemon({
      policy: { mode: 'allow-all' },
      idleCheckIntervalMs: 40,
      exitedGraceMs: 80,
      promptScanIntervalMs: 600_000,
    });
    const frames: FeedFrame[] = [];
    const unsubscribe = subscribe(daemon, frames);
    try {
      const id = await start(daemon, 'setTimeout(() => process.exit(7), 150)', { label: 'reap' });
      await eventually(() => forSession(frames, id).some((frame) =>
        frame.type === 'session-updated' && frame.changed.includes('exited') &&
        frame.changed.includes('exitCode') && frame.session.exitCode === 7,
      ), 10_000);
      await eventually(() => forSession(frames, id).some((frame) =>
        frame.type === 'session-removed',
      ), 10_000);
      const mine = forSession(frames, id);
      expect(mine[0]?.type).toBe('session-added');
      expect(mine.at(-1)?.type).toBe('session-removed');
      expect(mine.filter((frame) => frame.type === 'session-removed')).toHaveLength(1);
    } finally {
      unsubscribe();
      await daemon.stop();
    }
  });

  it('publishes the first sighting, an option move, the stall and the clear, as data', async () => {
    const frames: FeedFrame[] = [];
    const unsubscribe = subscribe(prompts, frames);
    const script = [
      'const paint = (n) => {',
      "process.stdout.write('\\u001b[2J\\u001b[H');",
      "process.stdout.write('Allow <img onerror=alert(1)> this?\\n');",
      "process.stdout.write('  1 ' + (n === 1 ? '(•)' : '(○)') + ' Allow once\\n');",
      "process.stdout.write('  2 ' + (n === 2 ? '(•)' : '(○)') + ' No\\n');",
      '};',
      'paint(1);',
      'setTimeout(() => paint(2), 800);',
      "setTimeout(() => { process.stdout.write('\\u001b[2J\\u001b[HGenerating... (esc to cancel)\\n'); }, 4500);",
      'setInterval(() => {}, 200);',
    ].join(' ');
    const id = await start(prompts, script, { label: 'prompt', purpose: 'ask' });
    await eventually(() => forSession(frames, id).some((frame) =>
      frame.type === 'session-updated' && frame.changed.includes('waitingOnPrompt') &&
      frame.session.waitingOnPrompt?.alerted === false &&
      frame.session.waitingOnPrompt.options.some((option) => option.includes('(•)') && option.startsWith('1')),
    ), 10_000);
    const mine = forSession(frames, id);
    expect(mine[0]?.type).toBe('session-added');
    const sighting = mine.find((frame) =>
      frame.type === 'session-updated' && frame.session.waitingOnPrompt !== undefined);
    if (sighting?.type === 'session-updated') {
      expect(sighting.session.waitingOnPrompt?.question).toBe('Allow <img onerror=alert(1)> this?');
    }

    const late: FeedFrame[] = [];
    const lateUnsubscribe = subscribe(prompts, late);
    const snapshot = late[1];
    expect(snapshot?.type).toBe('snapshot');
    if (snapshot?.type === 'snapshot') {
      const held = snapshot.sessions.find((session) => session.id === id)?.waitingOnPrompt;
      expect(held?.question).toBe('Allow <img onerror=alert(1)> this?');
      expect(typeof held?.question).toBe('string');
    }

    await eventually(() => forSession(frames, id).some((frame) =>
      frame.type === 'session-updated' &&
      frame.session.waitingOnPrompt?.options.some((option) => option.includes('(•)') && option.startsWith('2')),
    ), 10_000);
    await eventually(() => forSession(frames, id).some((frame) =>
      frame.type === 'session-updated' && frame.session.waitingOnPrompt?.alerted === true,
    ), 10_000);
    await eventually(() => forSession(frames, id).some((frame) =>
      frame.type === 'session-updated' && frame.changed.includes('waitingOnPrompt') &&
      frame.session.waitingOnPrompt === undefined,
    ), 10_000);

    const updates = forSession(frames, id).filter((frame) => frame.type === 'session-updated');
    const firstAt = updates.findIndex((frame) =>
      frame.session.waitingOnPrompt?.options.some((option) => option.startsWith('1') && option.includes('(•)')));
    const movedAt = updates.findIndex((frame) =>
      frame.session.waitingOnPrompt?.options.some((option) => option.startsWith('2') && option.includes('(•)')));
    const alertAt = updates.findIndex((frame) => frame.session.waitingOnPrompt?.alerted === true);
    const clearAt = updates.findIndex((frame) =>
      frame.changed.includes('waitingOnPrompt') && frame.session.waitingOnPrompt === undefined);
    expect(firstAt).toBeGreaterThanOrEqual(0);
    expect(movedAt).toBeGreaterThan(firstAt);
    expect(alertAt).toBeGreaterThan(movedAt);
    expect(clearAt).toBeGreaterThan(alertAt);
    lateUnsubscribe();
    unsubscribe();
  });

  it('emits one removal when a kill overlaps the program exit and the reap', async () => {
    const daemon = await startTestDaemon({
      policy: { mode: 'allow-all' },
      idleCheckIntervalMs: 40,
      exitedGraceMs: 80,
      promptScanIntervalMs: 600_000,
    });
    const frames: FeedFrame[] = [];
    const unsubscribe = subscribe(daemon, frames);
    try {
      const id = await start(daemon, 'setTimeout(() => process.exit(0), 150)', { label: 'race' });
      await new Promise((resolve) => setTimeout(resolve, 40));
      const killed = await api(daemon.port, daemon.token, `/sessions/${id}`, { method: 'DELETE' });
      expect(killed.status).toBe(200);
      await eventually(() => forSession(frames, id).some((frame) => frame.type === 'session-removed'), 20_000);
      // taskkill on this machine can take several seconds. Wait it out so a
      // second onRemoved from the overlapping reap or kill would have arrived.
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      const mine = forSession(frames, id);
      expect(mine[0]?.type).toBe('session-added');
      expect(mine.filter((frame) => frame.type === 'session-removed')).toHaveLength(1);
      expect(mine.at(-1)?.type).toBe('session-removed');
      const removedAt = mine.findIndex((frame) => frame.type === 'session-removed');
      expect(mine.slice(removedAt + 1)).toEqual([]);
    } finally {
      unsubscribe();
      await daemon.stop();
    }
  });

  it('emits one removal per session on daemon shutdown', async () => {
    const daemon = await startTestDaemon({
      policy: { mode: 'allow-all' },
      promptScanIntervalMs: 600_000,
      idleCheckIntervalMs: 600_000,
    });
    const frames: FeedFrame[] = [];
    const unsubscribe = subscribe(daemon, frames);
    try {
      const id = await start(daemon, 'setInterval(() => {}, 200)', { label: 'shutdown' });
      expect(forSession(frames, id)[0]?.type).toBe('session-added');
      await daemon.daemon.stop();
      const mine = forSession(frames, id);
      expect(mine.filter((frame) => frame.type === 'session-removed')).toHaveLength(1);
      expect(mine.at(-1)?.type).toBe('session-removed');
    } finally {
      unsubscribe();
      await daemon.stop();
    }
  });
});

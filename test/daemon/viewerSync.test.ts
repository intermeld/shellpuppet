/**
 * ViewerSync: the gate that keeps one viewer's byte stream in order across
 * snapshots (design §5). Pure logic: the socket and the snapshot are injected.
 */

import { describe, expect, it } from 'vitest';
import { ViewerSync } from '../../src/daemon/viewerSync.js';

interface Deferred {
  promise: Promise<string>;
  resolve: (state: string) => void;
  reject: (error: unknown) => void;
}

/** A snapshot whose completion the test controls. */
function deferred(): Deferred {
  let resolve: (state: string) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let settled promises run their continuations. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ViewerSync', () => {
  it('forwards live bytes straight through while no snapshot is pending', () => {
    const sent: string[] = [];
    const sync = new ViewerSync(
      (bytes) => sent.push(bytes),
      () => Promise.resolve('SNAP'),
    );
    sync.deliver('a');
    sync.deliver('b');
    expect(sent).toEqual(['a', 'b']);
  });

  it('holds bytes that arrive while a snapshot is pending and sends them after it', async () => {
    const sent: string[] = [];
    const snap = deferred();
    const sync = new ViewerSync(
      (bytes) => sent.push(bytes),
      () => snap.promise,
    );
    sync.deliver('before');
    sync.resync();
    sync.deliver('during-1');
    sync.deliver('during-2');
    // Nothing leaks past the gate while the snapshot is being taken.
    expect(sent).toEqual(['before']);

    snap.resolve('SNAP');
    await settle();
    expect(sent).toEqual(['before', 'SNAP', 'during-1', 'during-2']);

    sync.deliver('after');
    expect(sent.at(-1)).toBe('after');
  });

  it('overlapping requests send each snapshot once and no chunk twice or never', async () => {
    const sent: string[] = [];
    const snaps: Deferred[] = [];
    const sync = new ViewerSync(
      (bytes) => sent.push(bytes),
      () => {
        const snap = deferred();
        snaps.push(snap);
        return snap.promise;
      },
    );
    sync.resync(); // first request
    sync.deliver('x'); // after the first request, before the second: inside SNAP-2 only
    sync.resync(); // second request
    sync.deliver('y'); // after both

    snaps[0]?.resolve('SNAP-1');
    await settle();
    // x stays held: the pending second snapshot contains it.
    expect(sent).toEqual(['SNAP-1']);

    snaps[1]?.resolve('SNAP-2');
    await settle();
    // x is never sent on its own: it is inside SNAP-2; y follows it.
    expect(sent).toEqual(['SNAP-1', 'SNAP-2', 'y']);
  });

  it('a snapshot that fails covers nothing: chunks between two requests are released, not pruned', async () => {
    // Request 1, then chunk x, then request 2, then chunk y. Snapshot 1 goes
    // out without x or y; snapshot 2 fails. x is in no snapshot that went
    // out, so it must not be pruned on request 2's mark.
    const sent: string[] = [];
    const snapshots = [deferred(), deferred()];
    let requested = 0;
    const sync = new ViewerSync(
      (bytes) => sent.push(bytes),
      () => snapshots[requested++]?.promise ?? Promise.reject(new Error('no snapshot')),
    );
    sync.resync();
    sync.deliver('x');
    sync.resync();
    sync.deliver('y');
    snapshots[0]?.resolve('SNAP-1');
    await settle();
    snapshots[1]?.reject(new Error('renderer gone'));
    await settle();
    expect(sent).toEqual(['SNAP-1', 'x', 'y']);
  });

  it('a snapshot that fails still releases what was held', async () => {
    const sent: string[] = [];
    const snap = deferred();
    const sync = new ViewerSync(
      (bytes) => sent.push(bytes),
      () => snap.promise,
    );
    sync.resync();
    sync.deliver('held');
    snap.reject(new Error('renderer gone'));
    await settle();
    expect(sent).toEqual(['held']);
  });

  it('sends nothing after close, including a snapshot that resolves late', async () => {
    const sent: string[] = [];
    const snap = deferred();
    const sync = new ViewerSync(
      (bytes) => sent.push(bytes),
      () => snap.promise,
    );
    sync.resync();
    sync.deliver('held');
    sync.close();
    snap.resolve('SNAP');
    await settle();
    sync.deliver('late');
    expect(sent).toEqual([]);
  });
});

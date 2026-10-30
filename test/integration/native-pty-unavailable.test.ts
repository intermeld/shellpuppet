/**
 * How the daemon answers a start that node-pty cannot serve: the refusal is
 * the explanation from `nativePty.ts`, word for word, and the daemon keeps
 * answering. The loader and the macOS helper check are stand-ins here, so each
 * failure point is reached on every platform. `daemon-without-node-pty.test.ts`
 * runs the compiled daemon with node-pty really unloadable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const stand = vi.hoisted(() => ({ load: vi.fn(), helper: vi.fn() }));

vi.mock('../../src/core/nativePty.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/nativePty.js')>();
  return { ...actual, loadNodePty: stand.load, ensureSpawnHelperExecutable: stand.helper };
});

import { NativePtyUnavailableError, explainLoadFailure } from '../../src/core/nativePty.js';
import { api, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let td: TestDaemon;

beforeAll(async () => {
  td = await startTestDaemon({ policy: { mode: 'allow-all' } });
});
afterAll(async () => {
  await td.stop();
});
beforeEach(() => {
  stand.load.mockReset();
  stand.helper.mockReset();
});

/** A start as the tools send it: direct, through the shell or the default. */
const STARTS: [string, Record<string, unknown>][] = [
  ['direct', { shell: false }],
  ['through the shell', { shell: true }],
  ['with the default', {}],
];

function start(shape: Record<string, unknown>): ReturnType<typeof api> {
  return api(td.port, td.token, '/sessions', {
    body: { command: process.execPath, args: ['-e', ''], label: 'no-terminal', ...shape },
  });
}

async function expectStillAnswering(): Promise<void> {
  const listed = await api(td.port, td.token, '/sessions');
  expect(listed.status).toBe(200);
  expect(listed.body['sessions']).toEqual([]);
  expect((await api(td.port, null, '/health')).status).toBe(200);
}

describe('a start that node-pty cannot serve', () => {
  it('is refused with the explanation as written when node-pty will not load', async () => {
    const explanation = explainLoadFailure(
      new Error("Cannot find module 'node-pty'\nRequire stack:\n- /usr/lib/node_modules/shellpuppet/dist/core/nativePty.js"),
    );
    stand.load.mockImplementation(() => {
      throw new NativePtyUnavailableError(explanation);
    });

    const refused = await start({ shell: false });
    expect(refused.status).toBe(500);
    // The whole body: no prefix, no second line, nothing but what to do.
    expect(refused.body).toEqual({ error: explanation });
    await expectStillAnswering();
  });

  it.each(STARTS)('checks the macOS helper before anything is spawned (%s)', async (_name, shape) => {
    const spawn = vi.fn(() => {
      throw new Error('spawned before the helper was checked');
    });
    stand.load.mockReturnValue({ spawn });
    stand.helper.mockImplementation(() => {
      throw new NativePtyUnavailableError("node-pty's spawn-helper is not executable");
    });

    const refused = await start(shape);
    expect(refused.status).toBe(500);
    expect(refused.body).toEqual({ error: "node-pty's spawn-helper is not executable" });
    expect(spawn).not.toHaveBeenCalled();
    await expectStillAnswering();
  });

  it('explains a native module that fails to load as the terminal is built, as on Windows', async () => {
    // node-pty 1.1.0's own words when conpty.node will not load.
    const failure = new Error(
      "Failed to load native module: conpty.node, checked: build/Release, build/Debug, prebuilds/win32-x64: Error: Cannot find module '../build/Release/conpty.node'",
    );
    stand.load.mockReturnValue({
      spawn: vi.fn(() => {
        throw failure;
      }),
    });

    const refused = await start({ shell: false });
    expect(refused.status).toBe(500);
    expect(refused.body).toEqual({ error: explainLoadFailure(failure) });
    await expectStillAnswering();
  });
});

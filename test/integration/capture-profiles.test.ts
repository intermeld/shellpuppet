/**
 * The daemon keeps screenshot profiles in a folder of its own home and clears
 * that folder of leftovers as it starts (design §5): a capture whose profile
 * Windows would not let go of leaves it behind, and without the sweep such
 * folders would pile up for as long as the machine is used.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CaptureOptions } from '../../src/daemon/screenshot.js';
import { api, makeTempHome, startTestDaemon } from './helpers.js';

/**
 * Where the daemon keeps them, and an age well past the sweep's threshold of
 * ten minutes, spelled out here rather than imported: the folder is part of
 * the home's documented layout.
 */
const profilesIn = (home: string): string => path.join(home, 'capture-profiles');
const OLD_MS = 11 * 60_000;

function aged(dir: string, ageMs: number): string {
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), '{}');
  const then = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, then, then);
  return dir;
}

describe('capture profiles', () => {
  it('are swept from the home as the daemon starts, leaving anything else', async () => {
    const home = makeTempHome('shellpuppet-sweep-');
    const root = profilesIn(home);
    const leftover = aged(path.join(root, 'shellpuppet-capture-Lft0v1'), OLD_MS);
    const recent = aged(path.join(root, 'shellpuppet-capture-Rcnt01'), 0);
    const unrelated = aged(path.join(root, 'kept-by-someone'), OLD_MS);
    const td = await startTestDaemon({ home });
    try {
      await expect.poll(() => fs.existsSync(leftover), { timeout: 10_000 }).toBe(false);
      expect(fs.existsSync(recent)).toBe(true);
      expect(fs.existsSync(unrelated)).toBe(true);
    } finally {
      await td.stop();
    }
  });

  it("are made in the daemon's own folder for them", async () => {
    const seen: (string | undefined)[] = [];
    const td = await startTestDaemon({
      // Any existing file passes for a browser: the seam below is what runs.
      viewer: { browserPath: process.execPath },
      capture: (options: CaptureOptions) => {
        seen.push(options.profileRoot);
        return Promise.resolve({ png: Buffer.from('x'), width: 1, height: 1, rows: [] });
      },
    });
    try {
      const started = await api(td.port, td.token, '/sessions', {
        body: {
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 200)'],
          shell: false,
        },
      });
      const shot = await api(td.port, td.token, `/sessions/${String(started.body['id'])}/screenshot`, {
        body: { width: 400, height: 300 },
      });
      expect(shot.status).toBe(200);
      expect(seen).toEqual([profilesIn(td.home)]);
    } finally {
      await td.stop();
    }
  });
});

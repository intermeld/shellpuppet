/**
 * Every screenshot runs a headless browser in a profile folder of its own
 * (design §5), removed when the capture ends. On Windows a browser's last
 * processes can hold files in it for a while after the browser has exited,
 * longer under load, so removal can fail. These pin that such a folder is
 * tried again later, and that a sweep removes leftovers, never anything that
 * is not a capture profile, and never one a capture may still be using.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MAX_CAPTURE_TIMEOUT_MS,
  STALE_PROFILE_AGE_MS,
  captureProfileRoot,
  removeCaptureProfile,
  sweepCaptureProfiles,
} from '../../src/daemon/screenshot.js';
import type { Logger } from '../../src/core/types.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-profiles-'));
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => warnings.push(message),
    error: (message) => warnings.push(message),
  };
  return { logger, warnings };
}

/** A folder holding a file and a subfolder, as a browser profile does. */
function profileLike(dir: string, ageMs = 0): string {
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), '{}');
  if (ageMs > 0) {
    const then = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, then, then);
  }
  return dir;
}

describe('removeCaptureProfile', () => {
  it('tries a folder it could not remove again, until it goes', async () => {
    const dir = profileLike(path.join(tempDir, 'shellpuppet-capture-retry1'));
    const { logger, warnings } = recordingLogger();
    let calls = 0;
    const busyTwice = async (target: string): Promise<void> => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      await fs.promises.rm(target, { recursive: true, force: true });
    };
    const firstWorked = await removeCaptureProfile(dir, logger, [20, 20], busyTwice);
    expect(firstWorked).toBe(false);
    await expect.poll(() => fs.existsSync(dir), { timeout: 5_000 }).toBe(false);
    expect(calls).toBe(3);
    expect(warnings).toEqual([]);
  });

  it('leaves a folder that stays busy for the next sweep, and says so once', async () => {
    const dir = profileLike(path.join(tempDir, 'shellpuppet-capture-retry2'));
    const { logger, warnings } = recordingLogger();
    let calls = 0;
    const alwaysBusy = (): Promise<void> => {
      calls += 1;
      return Promise.reject(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }));
    };
    await removeCaptureProfile(dir, logger, [20, 20], alwaysBusy);
    await expect.poll(() => calls, { timeout: 5_000 }).toBe(3);
    await expect.poll(() => warnings.length, { timeout: 5_000 }).toBe(1);
    expect(warnings[0]).toContain('next daemon start');
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('sweepCaptureProfiles', () => {
  it('removes old capture profiles and nothing else', async () => {
    const root = captureProfileRoot(path.join(tempDir, 'home'));
    const old = STALE_PROFILE_AGE_MS + 60_000;
    const leftover = profileLike(path.join(root, 'shellpuppet-capture-a1B2c3'), old);
    const keep = {
      // A capture that may still be running.
      recent: profileLike(path.join(root, 'shellpuppet-capture-z9Y8x7')),
      // Not the name a capture gives its folder.
      longer: profileLike(path.join(root, 'shellpuppet-capture-a1B2c3d'), old),
      shorter: profileLike(path.join(root, 'shellpuppet-capture-a1B2c'), old),
      otherChars: profileLike(path.join(root, 'shellpuppet-capture-a1_2c3'), old),
      otherPrefix: profileLike(path.join(root, 'capture-a1B2c3'), old),
      unrelated: profileLike(path.join(root, 'notes'), old),
    };
    // A file with a capture's name is not a capture's folder.
    const file = path.join(root, 'shellpuppet-capture-f1l2e3');
    fs.writeFileSync(file, 'not a profile');
    const then = new Date(Date.now() - old);
    fs.utimesSync(file, then, then);

    const { logger, warnings } = recordingLogger();
    expect(await sweepCaptureProfiles(root, logger)).toBe(1);
    expect(fs.existsSync(leftover)).toBe(false);
    for (const [name, dir] of Object.entries(keep)) expect(fs.existsSync(dir), name).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('waits far longer than any capture can run before taking a folder for a leftover', () => {
    // The capture budget's ceiling, plus the wait for the browser to exit.
    expect(STALE_PROFILE_AGE_MS).toBeGreaterThan(MAX_CAPTURE_TIMEOUT_MS + 3_000);
    // capture-profiles.test.ts ages its leftover eleven minutes.
    expect(STALE_PROFILE_AGE_MS).toBeLessThan(11 * 60_000);
  });

  it('finds nothing to do where no capture has run', async () => {
    const { logger } = recordingLogger();
    expect(await sweepCaptureProfiles(path.join(tempDir, 'never-made'), logger)).toBe(0);
  });

  it('keeps the profiles inside the home they belong to', () => {
    const home = path.join(tempDir, 'some-home');
    expect(path.dirname(captureProfileRoot(home))).toBe(home);
  });
});

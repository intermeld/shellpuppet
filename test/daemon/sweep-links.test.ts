/**
 * The capture-profile sweep never deletes through a link. A junction
 * (Windows) or symbolic link (POSIX) named exactly as a capture names its
 * folder, pointing at an old folder of someone else's files, must leave
 * those files alone; so must a link inside a real leftover profile.
 * `fs.symlinkSync(..., 'junction')` makes a junction on Windows, which needs
 * no privilege, and a directory symlink elsewhere. Both links live in this
 * test's own temporary folder.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { STALE_PROFILE_AGE_MS, sweepCaptureProfiles } from '../../src/daemon/screenshot.js';
import { NULL_LOGGER } from '../../src/core/types.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-sweep-links-'));
const links: string[] = [];
afterAll(() => {
  // Links first, so nothing is followed on the way out.
  for (const link of links) {
    try {
      fs.unlinkSync(link);
    } catch {
      // Already gone.
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const old = new Date(Date.now() - STALE_PROFILE_AGE_MS - 60 * 60_000);

/** A folder of someone else's files, old enough to pass the age test. */
function precious(name: string): string {
  const dir = path.join(tempDir, name);
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(dir, 'sub', 'nested.txt'), 'nested');
  fs.utimesSync(dir, old, old);
  return dir;
}

function link(target: string, at: string): void {
  fs.symlinkSync(target, at, 'junction');
  links.push(at);
}

describe('sweepCaptureProfiles and links', () => {
  it('does not delete through a link named as a capture profile', async () => {
    const root = path.join(tempDir, 'home1', 'capture-profiles');
    fs.mkdirSync(root, { recursive: true });
    const target = precious('target-named-link');
    link(target, path.join(root, 'shellpuppet-capture-Lnk001'));
    await sweepCaptureProfiles(root, NULL_LOGGER);
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'sub', 'nested.txt'))).toBe(true);
  });

  it('removes an old profile holding a link, but not what the link points at', async () => {
    const root = path.join(tempDir, 'home2', 'capture-profiles');
    const profile = path.join(root, 'shellpuppet-capture-Hld001');
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
    const target = precious('target-inner-link');
    link(target, path.join(profile, 'Default', 'inner'));
    fs.utimesSync(profile, old, old);
    expect(await sweepCaptureProfiles(root, NULL_LOGGER)).toBe(1);
    expect(fs.existsSync(profile)).toBe(false);
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'sub', 'nested.txt'))).toBe(true);
  });
});

/**
 * An install that leaves node-pty unable to open a terminal says what to do,
 * and a macOS spawn-helper without its execute bit gets it back before the
 * first spawn. npm 12 blocks dependency install scripts, which is how both
 * happen. These drive `nativePty.ts` with stand-ins; CI's package check
 * installs under npm 12 for real.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REINSTALL,
  NativePtyUnavailableError,
  ensureSpawnHelperExecutable,
  explainLoadFailure,
  explainSpawnFailure,
  nodePtyLoader,
  realHelperFs,
} from '../../src/core/nativePty.js';
import type { HelperFs } from '../../src/core/nativePty.js';

/**
 * node-pty 1.1.0's own words when no native module loads (lib/utils.js), with
 * the require stack Node appends to it.
 */
const MISSING =
  "Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-x64: Error: Cannot find module '../build/Release/pty.node'\n" +
  'Require stack:\n' +
  '- /usr/lib/node_modules/shellpuppet/node_modules/node-pty/lib/utils.js\n' +
  '- /usr/lib/node_modules/shellpuppet/dist/core/nativePty.js';

/**
 * A module built for another Node.js, as node-pty's loader wraps Node's own
 * message: the reason is on the lines after the first.
 */
const WRONG_NODE =
  "Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-x64: Error: The module '/usr/lib/node_modules/shellpuppet/node_modules/node-pty/build/Release/pty.node'\n" +
  'was compiled against a different Node.js version using\n' +
  'NODE_MODULE_VERSION 127. This version of Node.js requires\n' +
  'NODE_MODULE_VERSION 137. Please try re-compiling or re-installing\n' +
  'the module (for instance, using `npm rebuild` or `npm install`).';

/** node-pty 1.1.0 on Windows, when the terminal is built without a conpty binary. */
const MISSING_ON_WINDOWS =
  "Failed to load native module: conpty.node, checked: build/Release, build/Debug, prebuilds/win32-x64: Error: Cannot find module './prebuilds/win32-x64//conpty.node'\n" +
  'Require stack:\n' +
  '- C:\\nm\\node-pty\\lib\\utils.js';

describe('loading node-pty', () => {
  it('names the install that fixes a missing native module', () => {
    const load = nodePtyLoader(() => {
      throw new Error(MISSING);
    });
    let caught: unknown;
    try {
      load();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NativePtyUnavailableError);
    const message = (caught as Error).message;
    expect(message).toContain(REINSTALL);
    expect(message).toContain('--allow-scripts=node-pty');
    expect(message).toContain('Python 3, make and a C++ compiler');
    // What node-pty said stays in the message, for whoever debugs it, but not
    // the require stack Node appends to it.
    expect(message).toContain('prebuilds/linux-x64');
    expect(message).not.toContain('Require stack');
    expect(message).not.toContain('\n');
  });

  it('says so when node-pty was built for another Node.js, from the lines after the first', () => {
    const message = explainLoadFailure(new Error(WRONG_NODE));
    expect(message).toMatch(/built for a different version of Node\.js/);
    expect(message).toContain(REINSTALL);
    expect(message).not.toContain('\n');
  });

  it('passes any other failure through, saying what it stops', () => {
    expect(explainLoadFailure(new Error('something else'))).toBe(
      'node-pty could not be loaded, so ShellPuppet cannot open a terminal: something else',
    );
  });

  it('loads once, and tries again after a failure', () => {
    let calls = 0;
    const standIn = { spawn: () => undefined } as unknown as typeof import('node-pty');
    const load = nodePtyLoader(() => {
      calls += 1;
      if (calls === 1) throw new Error(MISSING);
      return standIn;
    });
    expect(() => load()).toThrow(NativePtyUnavailableError);
    expect(load()).toBe(standIn);
    expect(load()).toBe(standIn);
    expect(calls).toBe(2);
  });
});

describe('a spawn that fails', () => {
  it('is explained when the native module would not load (Windows loads it as the terminal is built)', () => {
    const explained = explainSpawnFailure(new Error(MISSING_ON_WINDOWS));
    expect(explained).toBeInstanceOf(NativePtyUnavailableError);
    expect((explained as Error).message).toContain(REINSTALL);
    expect((explained as Error).message).not.toContain('Require stack');
  });

  it('is passed on unchanged for any other reason', () => {
    const other = new Error('Cannot create process, error code: 193');
    expect(explainSpawnFailure(other)).toBe(other);
  });
});

/**
 * A stand-in file system: which native modules load, which helpers are
 * executable and what was done. A helper absent from `helpers` is missing.
 */
function standInFs(
  modules: Record<string, boolean>,
  helpers: Record<string, 'executable' | 'plain'>,
  failChmod?: string,
): HelperFs & { done: string[] } {
  const done: string[] = [];
  return {
    done,
    loads: (file) => modules[file] === true,
    isExecutable: (file) => helpers[file] === 'executable',
    makeExecutable: (file) => {
      const code = !(file in helpers) ? 'ENOENT' : failChmod;
      if (code !== undefined) {
        const error = new Error(`${code}: chmod '${file}'`) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      }
      helpers[file] = 'executable';
      done.push(`chmod ${file}`);
    },
  };
}

describe("the macOS spawn-helper's execute bit", () => {
  const root = path.join('nm', 'node-pty');
  const prebuilds = path.join(root, 'prebuilds', 'darwin-arm64');
  const release = path.join(root, 'build', 'Release');

  it('is restored on the prebuilt helper node-pty will use', () => {
    const fsOps = standInFs(
      { [path.join(prebuilds, 'pty.node')]: true },
      { [path.join(prebuilds, 'spawn-helper')]: 'plain' },
    );
    ensureSpawnHelperExecutable(root, 'darwin', 'arm64', fsOps);
    expect(fsOps.done).toEqual([`chmod ${path.join(prebuilds, 'spawn-helper')}`]);
  });

  it('follows node-pty: a build of its own that loads comes before the prebuilds', () => {
    const fsOps = standInFs(
      { [path.join(release, 'pty.node')]: true, [path.join(prebuilds, 'pty.node')]: true },
      { [path.join(release, 'spawn-helper')]: 'plain', [path.join(prebuilds, 'spawn-helper')]: 'plain' },
    );
    ensureSpawnHelperExecutable(root, 'darwin', 'arm64', fsOps);
    expect(fsOps.done).toEqual([`chmod ${path.join(release, 'spawn-helper')}`]);
  });

  it('follows node-pty past a build of its own that does not load', () => {
    // A stale build/Release, say for another Node.js: node-pty moves on to the
    // prebuild, so the prebuild's helper is the one that must run.
    const fsOps = standInFs(
      { [path.join(release, 'pty.node')]: false, [path.join(prebuilds, 'pty.node')]: true },
      { [path.join(release, 'spawn-helper')]: 'executable', [path.join(prebuilds, 'spawn-helper')]: 'plain' },
    );
    ensureSpawnHelperExecutable(root, 'darwin', 'arm64', fsOps);
    expect(fsOps.done).toEqual([`chmod ${path.join(prebuilds, 'spawn-helper')}`]);
  });

  it("follows node-pty into a bundle's lib directory", () => {
    const bundled = path.join(root, 'lib', 'prebuilds', 'darwin-arm64');
    const fsOps = standInFs(
      { [path.join(bundled, 'pty.node')]: true },
      { [path.join(bundled, 'spawn-helper')]: 'plain' },
    );
    ensureSpawnHelperExecutable(root, 'darwin', 'arm64', fsOps);
    expect(fsOps.done).toEqual([`chmod ${path.join(bundled, 'spawn-helper')}`]);
  });

  it('leaves a helper that can already run alone', () => {
    const fsOps = standInFs(
      { [path.join(prebuilds, 'pty.node')]: true },
      { [path.join(prebuilds, 'spawn-helper')]: 'executable' },
    );
    ensureSpawnHelperExecutable(root, 'darwin', 'arm64', fsOps);
    expect(fsOps.done).toEqual([]);
  });

  it('does nothing anywhere but macOS', () => {
    const linux = path.join(root, 'prebuilds', 'linux-x64');
    const fsOps = standInFs(
      { [path.join(linux, 'pty.node')]: true },
      { [path.join(linux, 'spawn-helper')]: 'plain' },
    );
    ensureSpawnHelperExecutable(root, 'linux', 'x64', fsOps);
    ensureSpawnHelperExecutable(root, 'win32', 'x64', fsOps);
    expect(fsOps.done).toEqual([]);
  });

  it('says which chmod to run when it cannot change the file, quoted for a shell', () => {
    // A path a shell would otherwise expand: a variable, a command, a quote and spaces.
    const odd = path.join(`it's $HOME and \`id\``, 'node-pty');
    const oddPrebuilds = path.join(odd, 'prebuilds', 'darwin-arm64');
    const helper = path.join(oddPrebuilds, 'spawn-helper');
    const fsOps = standInFs({ [path.join(oddPrebuilds, 'pty.node')]: true }, { [helper]: 'plain' }, 'EPERM');
    let caught: unknown;
    try {
      ensureSpawnHelperExecutable(odd, 'darwin', 'arm64', fsOps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NativePtyUnavailableError);
    const message = (caught as Error).message;
    expect(message).toContain('EPERM');
    const quoted = `'${helper.replace(/'/g, `'\\''`)}'`;
    expect(message).toContain(`chmod +x -- ${quoted}`);
  });

  it('says to reinstall, not to chmod, when the helper is missing', () => {
    const fsOps = standInFs({ [path.join(prebuilds, 'pty.node')]: true }, {});
    let caught: unknown;
    try {
      ensureSpawnHelperExecutable(root, 'darwin', 'arm64', fsOps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NativePtyUnavailableError);
    const message = (caught as Error).message;
    expect(message).toContain('missing');
    expect(message).toContain(REINSTALL);
    expect(message).not.toContain('chmod');
  });

  // The real file operations, on a real file, with a stand-in for the load (a
  // real pty.node cannot be faked). POSIX only: Windows has no execute bit.
  it.skipIf(process.platform === 'win32')('restores the bit on a real file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-native-pty-'));
    try {
      const pre = path.join(dir, 'prebuilds', 'darwin-arm64');
      fs.mkdirSync(pre, { recursive: true });
      fs.writeFileSync(path.join(pre, 'spawn-helper'), '', { mode: 0o644 });
      const ops: HelperFs = { ...realHelperFs, loads: (file) => file === path.join(pre, 'pty.node') };
      ensureSpawnHelperExecutable(dir, 'darwin', 'arm64', ops);
      expect(fs.statSync(path.join(pre, 'spawn-helper')).mode & 0o111).toBe(0o111);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Loading node-pty, and the ways an npm install can leave it unable to open a
 * terminal.
 *
 * npm 12 runs a dependency's install scripts only when the person installing
 * allows them. node-pty has prebuilt binaries for Windows and macOS but not for
 * Linux, where its install script builds one; without that script there is no
 * native module to load. On macOS the prebuilt `spawn-helper` ships without its
 * execute bit (microsoft/node-pty#850). npm 12 would block an install script
 * that restored it, and every spawn would then fail with "posix_spawnp failed".
 *
 * So node-pty is loaded on the first start rather than when the daemon starts,
 * and the helper's execute bit is checked there. Either failure reaches the
 * person as a start that fails with what to do, instead of a daemon that dies
 * before it answers and a client that can only say it never became healthy.
 * On Windows node-pty loads its native module when a terminal is built, not
 * when it is imported, so a spawn's failure gets the same explanation.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

type NodePty = typeof import('node-pty');

const require = createRequire(import.meta.url);

/**
 * The install that builds node-pty under npm 12. Earlier npm runs the script
 * without the flag; npm 10 and early npm 11 releases ignore it as an unknown
 * option.
 */
export const REINSTALL = 'npm install -g --allow-scripts=node-pty shellpuppet';

/** node-pty cannot open a terminal on this install; the message says what to do. */
export class NativePtyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativePtyUnavailableError';
  }
}

/**
 * A loader that keeps node-pty once a load succeeds, and explains a failure. A
 * failed load is not remembered, so a start after a reinstall tries again.
 * `load` is a test seam.
 */
export function nodePtyLoader(load: () => NodePty = () => require('node-pty') as NodePty): () => NodePty {
  let loaded: NodePty | undefined;
  return () => {
    if (loaded === undefined) {
      try {
        loaded = load();
      } catch (error) {
        throw new NativePtyUnavailableError(explainLoadFailure(error));
      }
    }
    return loaded;
  };
}

/** The daemon's node-pty. */
export const loadNodePty = nodePtyLoader();

/**
 * What a node-pty load failure means for the person who hit it. node-pty's own
 * loader reports a missing module as "Failed to load native module: pty.node,
 * checked: …"; a module built for another Node.js names NODE_MODULE_VERSION,
 * on a later line of the message than the first.
 */
export function explainLoadFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Classified whole, shown by its first line: Node appends the whole require
  // stack to a missing module's message, which is noise to the person reading
  // it, but the reason a module would not load can sit on a later line.
  const detail = message.split('\n')[0] ?? '';
  if (/NODE_MODULE_VERSION|compiled against a different Node\.js version/.test(message)) {
    return (
      'node-pty was built for a different version of Node.js, so ShellPuppet cannot open a terminal. ' +
      `Reinstall ShellPuppet under this Node.js: ${REINSTALL}. (${detail})`
    );
  }
  // node-pty's loader keeps only its last error, so a module built for
  // another Node.js can look like a missing one here. Say both.
  if (/Failed to load native module|Cannot find module/.test(message)) {
    return (
      "node-pty's native module is missing, or was built for another version of Node.js, " +
      'so ShellPuppet cannot open a terminal. ' +
      "npm 12 runs a dependency's install script only when you allow it; reinstall with " +
      `${REINSTALL} (on Linux that builds node-pty, which needs Python 3, make and a C++ compiler). (${detail})`
    );
  }
  return `node-pty could not be loaded, so ShellPuppet cannot open a terminal: ${detail}`;
}

/**
 * A spawn's failure, explained when it is node-pty's native module that would
 * not load (on Windows that happens as a terminal is built). Anything else is
 * returned as it was, so other start failures keep their own handling.
 */
export function explainSpawnFailure(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to load native module/.test(message) ? new NativePtyUnavailableError(explainLoadFailure(error)) : error;
}

/** The file operations `ensureSpawnHelperExecutable` needs; a test seam. */
export interface HelperFs {
  /** Whether this native module loads, as node-pty's loader would find. */
  loads(file: string): boolean;
  isExecutable(file: string): boolean;
  makeExecutable(file: string): void;
}

/** The real file operations; exported so a test can pair them with a stand-in `loads`. */
export const realHelperFs: HelperFs = {
  loads: (file) => {
    try {
      require(file);
      return true;
    } catch {
      return false;
    }
  },
  isExecutable: (file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  makeExecutable: (file) => {
    fs.chmodSync(file, 0o755);
  },
};

/** A path as one POSIX shell word, safe to paste: single quotes, with any single quote escaped. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * On macOS, make sure node-pty's `spawn-helper` can run before a spawn needs
 * it. node-pty uses the helper beside the native module it loaded. Its loader
 * tries `build/Release`, `build/Debug` and then `prebuilds/<platform>-<arch>`,
 * each first beside its `lib` directory and then inside it, and moves on when
 * a module fails to load. This follows the same order and takes the first
 * module that loads. Anywhere but macOS it does nothing.
 */
export function ensureSpawnHelperExecutable(
  root: string = path.dirname(require.resolve('node-pty/package.json')),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  ops: HelperFs = realHelperFs,
): void {
  if (platform !== 'darwin') return;
  for (const dir of ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]) {
    for (const base of [root, path.join(root, 'lib')]) {
      const candidate = path.join(base, dir);
      if (!ops.loads(path.join(candidate, 'pty.node'))) continue;
      const helper = path.join(candidate, 'spawn-helper');
      if (ops.isExecutable(helper)) return;
      try {
        ops.makeExecutable(helper);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? String(error);
        if (code === 'ENOENT') {
          throw new NativePtyUnavailableError(
            `node-pty's spawn-helper is missing (${helper}), so ShellPuppet cannot open a terminal. ` +
              `Reinstall ShellPuppet: ${REINSTALL}.`,
          );
        }
        throw new NativePtyUnavailableError(
          `node-pty's spawn-helper is not executable and ShellPuppet could not make it so (${code}), ` +
            `so it cannot open a terminal. Run: chmod +x -- ${shellQuote(helper)} ` +
            '(with sudo if ShellPuppet was installed as root).',
        );
      }
      return;
    }
  }
}

/**
 * Package metadata at runtime. Works from `dist/daemon/` and from `src/daemon/`
 * under the test runner, because both sit two levels below the package root.
 */

import { createRequire } from 'node:module';

interface PackageJson {
  version: string;
}

let cached: string | null = null;

export function packageVersion(): string {
  if (cached === null) {
    const require = createRequire(import.meta.url);
    cached = (require('../../package.json') as PackageJson).version;
  }
  return cached;
}

/** The oldest Node major line supported: `engines` in package.json says the same. */
export const MIN_NODE_MAJOR = 22;

/** Enforce the Node floor with a clear error (design §9): no installer does it. */
export function assertNodeVersion(minMajor = MIN_NODE_MAJOR): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < minMajor) {
    throw new Error(
      `ShellPuppet requires Node ${String(minMajor)}+, but you are running ` +
        `${process.versions.node}. Upgrade Node and try again.`,
    );
  }
}

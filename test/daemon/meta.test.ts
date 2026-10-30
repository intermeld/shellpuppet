/**
 * The Node floor. npm only warns when `engines` is not met, so the startup
 * check is what refuses an unsupported Node, and the two must name the same
 * line.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { MIN_NODE_MAJOR, assertNodeVersion } from '../../src/daemon/meta.js';

interface PackageJson {
  engines: { node: string };
}

describe('the Node floor', () => {
  it('is the same in package.json engines and in the startup check', () => {
    const pkg = createRequire(import.meta.url)('../../package.json') as PackageJson;
    expect(pkg.engines.node).toBe(`>=${String(MIN_NODE_MAJOR)}`);
  });

  it('passes the running Node and refuses one below the floor, saying what to do', () => {
    expect(() => {
      assertNodeVersion();
    }).not.toThrow();
    const running = Number(process.versions.node.split('.')[0]);
    expect(() => {
      assertNodeVersion(running + 1);
    }).toThrow(/requires Node \d+\+, but you are running .*Upgrade Node/);
  });
});

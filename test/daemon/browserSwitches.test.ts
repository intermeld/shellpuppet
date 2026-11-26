/**
 * The browsers ShellPuppet starts, the viewer window and the screenshot
 * browser, are asked to make no background requests of their own (design §5,
 * and VISION's rule that nothing leaves the machine unless a human sends it or
 * switches it on). These pin that both launches pass the switches, by
 * recording what is spawned. Node stands in for the browser, so nothing opens.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NULL_LOGGER } from '../../src/core/types.js';

const spawned = vi.hoisted(() => [] as { command: string; args: readonly string[] }[]);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // Record the launch, then start a Node that exits at once in its place.
    spawn: (command: string, args: readonly string[], options: object) => {
      spawned.push({ command, args });
      return actual.spawn(process.execPath, ['-e', ''], options);
    },
  };
});

const { QUIET_BROWSER_SWITCHES, launchViewer } = await import(
  '../../src/daemon/viewerLauncher.js'
);
const { captureViewer } = await import('../../src/daemon/screenshot.js');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellpuppet-switches-'));
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
});
beforeEach(() => {
  spawned.splice(0);
});

/**
 * The switches, each from Chromium's own source: background networking,
 * component updates, built-in extensions' background pages, default apps,
 * Domain Reliability reports, sync, metrics reports, crash reports, the
 * variations seed, proxy detection, and the Optimization Guide's hints and
 * models and the network time queries as features.
 */
const EXPECTED = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-sync',
  '--metrics-recording-only',
  '--disable-breakpad',
  '--disable-variations-seed-fetch',
  '--no-proxy-server',
  '--disable-features=OptimizationHints,OptimizationTargetPrediction,NetworkTimeServiceQuerying',
];

/** Chromium keeps only the last `--disable-features`, so there must be one. */
function expectOneFeatureList(args: readonly string[] | undefined): void {
  const lists = (args ?? []).filter((arg) => arg.startsWith('--disable-features='));
  expect(lists).toHaveLength(1);
  const names = lists[0]!.slice('--disable-features='.length).split(',');
  expect(names).toEqual(['OptimizationHints', 'OptimizationTargetPrediction', 'NetworkTimeServiceQuerying']);
}

describe('the switches that keep a launched browser quiet', () => {
  it('are the documented set', () => {
    expect([...QUIET_BROWSER_SWITCHES]).toEqual(EXPECTED);
  });

  it('are passed to the viewer window', async () => {
    const result = await launchViewer(
      'http://127.0.0.1:1/view?s=s1&vt=0123abcd',
      tempDir,
      {
        launchMode: 'isolated-app',
        browserPath: process.execPath,
        profileDir: path.join(tempDir, 'viewer-profile'),
      },
      NULL_LOGGER,
    );
    expect(result.launched).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.command).toBe(process.execPath);
    for (const flag of EXPECTED) expect(spawned[0]?.args, flag).toContain(flag);
    expectOneFeatureList(spawned[0]?.args);
    // What the window is for is untouched.
    expect(spawned[0]?.args).toContain('--app=http://127.0.0.1:1/view?s=s1&vt=0123abcd');
  });

  it('are passed to the screenshot browser', async () => {
    // The stand-in exits at once, so the capture fails; the launch is what counts.
    await expect(
      captureViewer({
        browser: process.execPath,
        viewerUrl: 'http://127.0.0.1:1/view?s=s1&vt=0123abcd',
        width: 400,
        height: 300,
        timeoutMs: 5_000,
        profileRoot: path.join(tempDir, 'capture-profiles'),
      }),
    ).rejects.toThrow();
    expect(spawned).toHaveLength(1);
    for (const flag of EXPECTED) expect(spawned[0]?.args, flag).toContain(flag);
    expectOneFeatureList(spawned[0]?.args);
    expect(spawned[0]?.args).toContain('--headless=new');
    // The page is loaded through DevTools, after the switches.
    expect(spawned[0]?.args.at(-1)).toBe('about:blank');
  });
});

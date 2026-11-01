/**
 * Dashboard launch profiles (design §4.3, §5.1): the configuration is the
 * only source of starts, so an entry that cannot be read whole is left out
 * and named, and its siblings still load.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDaemonConfig } from '../../src/daemon/config.js';
import {
  compileProfilePolicy,
  copyDaemonEnv,
  expandProfileText,
  parseLauncher,
  resolveLaunchCommand,
} from '../../src/daemon/launchProfiles.js';
import { evaluateCommand } from '../../src/core/policy.js';

const KNOWN_AGENTS = new Set(['claude', 'codex']);

function parse(raw: unknown): ReturnType<typeof parseLauncher> {
  return parseLauncher(raw, KNOWN_AGENTS);
}

describe('launcher profiles load', () => {
  it('reads a full profile and applies the documented defaults', () => {
    const { launcher, problems } = parse({
      profiles: [
        {
          name: 'claude-work',
          command: 'claude',
          args: ['--model', 'sonnet'],
          shell: false,
          cwd: 'C:/work',
          agent: 'claude',
          envFromDaemon: ['ANTHROPIC_BASE_URL'],
          readyText: 'Welcome',
          label: 'Claude in {folder}',
          purpose: 'Supervise {name}',
          policy: { allow: ['^claude'], deny: ['--dangerously'] },
          open: 'focus',
        },
      ],
    });
    expect(problems).toEqual([]);
    expect(launcher.profiles).toHaveLength(1);
    expect(launcher.profiles[0]).toMatchObject({
      name: 'claude-work',
      command: 'claude',
      args: ['--model', 'sonnet'],
      shell: false,
      cwd: 'C:/work',
      askCwd: false,
      folders: [],
      agent: 'claude',
      envFromDaemon: ['ANTHROPIC_BASE_URL'],
      readyText: 'Welcome',
      label: 'Claude in {folder}',
      purpose: 'Supervise {name}',
      policy: { allow: ['^claude'], deny: ['--dangerously'] },
      open: 'focus',
    });
  });

  it('defaults open to grid, args to empty and envFromDaemon to empty', () => {
    const { launcher, problems } = parse({ profiles: [{ name: 'shell', command: 'cmd.exe' }] });
    expect(problems).toEqual([]);
    expect(launcher.profiles[0]).toMatchObject({
      args: [],
      envFromDaemon: [],
      folders: [],
      askCwd: false,
      open: 'grid',
    });
  });

  it('reads an ask profile with named folders', () => {
    const { launcher, problems } = parse({
      profiles: [
        {
          name: 'shell',
          command: 'cmd.exe',
          cwd: 'ask',
          folders: [
            { name: 'repo', path: 'C:/work/repo' },
            { name: 'docs', path: 'C:/work/docs' },
          ],
        },
      ],
    });
    expect(problems).toEqual([]);
    expect(launcher.profiles[0]?.askCwd).toBe(true);
    expect(launcher.profiles[0]?.cwd).toBeUndefined();
    expect(launcher.profiles[0]?.folders).toEqual([
      { name: 'repo', path: 'C:/work/repo' },
      { name: 'docs', path: 'C:/work/docs' },
    ]);
  });
});

describe('a bad profile is named and left out; its siblings load', () => {
  const cases: { title: string; entry: Record<string, unknown>; names: string[] }[] = [
    {
      title: 'an unknown key',
      entry: { name: 'bad', command: 'cmd.exe', surprise: true },
      names: ['bad', 'surprise'],
    },
    {
      title: 'a name that fails the pattern',
      entry: { name: 'Bad Name', command: 'cmd.exe' },
      names: ['Bad Name'],
    },
    {
      title: 'both readiness conditions',
      entry: { name: 'bad', command: 'cmd.exe', readyText: 'x', readyQuiet: 10 },
      names: ['bad', 'readyText', 'readyQuiet'],
    },
    {
      title: 'cwd ask without folders',
      entry: { name: 'bad', command: 'cmd.exe', cwd: 'ask' },
      names: ['bad', 'folders'],
    },
    {
      title: 'folders on a fixed directory',
      entry: { name: 'bad', command: 'cmd.exe', cwd: 'C:/work', folders: [] },
      names: ['bad', 'folders'],
    },
    {
      title: 'an unknown agent',
      entry: { name: 'bad', command: 'cmd.exe', agent: 'nobody' },
      names: ['bad', 'agent'],
    },
    {
      title: 'an invalid open value',
      entry: { name: 'bad', command: 'cmd.exe', open: 'popout' },
      names: ['bad', 'open'],
    },
    {
      title: 'a profile policy that tries to set mode',
      entry: { name: 'bad', command: 'cmd.exe', policy: { mode: 'allow-all' } },
      names: ['bad', 'mode'],
    },
  ];

  for (const entry of cases) {
    it(`leaves out ${entry.title} and keeps the valid sibling`, () => {
      const { launcher, problems } = parse({
        profiles: [entry.entry, { name: 'good', command: 'node', shell: false }],
      });
      expect(launcher.profiles.map((profile) => profile.name)).toEqual(['good']);
      const text = problems.join('\n');
      for (const name of entry.names) expect(text).toContain(name);
    });
  }

  it('says where envNames and passEnv actually live', () => {
    const { launcher, problems } = parse({
      profiles: [{ name: 'bad', command: 'cmd.exe', envNames: ['TOKEN'] }],
    });
    expect(launcher.profiles).toEqual([]);
    expect(problems[0]).toContain('envNames');
    expect(problems[0]).toContain('agents.passEnv');
  });

  it('leaves out a duplicate name and names both entries', () => {
    const { launcher, problems } = parse({
      profiles: [
        { name: 'shell', command: 'cmd.exe' },
        { name: 'shell', command: 'powershell.exe' },
      ],
    });
    expect(launcher.profiles).toHaveLength(1);
    expect(launcher.profiles[0]?.command).toBe('cmd.exe');
    expect(problems.join('\n')).toContain('already used');
  });

  it('drops an invalid envFromDaemon name but keeps the profile', () => {
    const { launcher, problems } = parse({
      profiles: [
        { name: 'shell', command: 'cmd.exe', envFromDaemon: ['GOOD', 'NOT A NAME', '__proto__'] },
      ],
    });
    expect(launcher.profiles).toHaveLength(1);
    expect(launcher.profiles[0]?.envFromDaemon).toEqual(['GOOD']);
    expect(problems.join('\n')).toContain('NOT A NAME');
  });

  it('a launcher section that is not an object has no profiles and does not touch policy', () => {
    const { config, problems } = parseDaemonConfig({ launcher: 'shell' });
    expect(config.launcher?.profiles).toEqual([]);
    expect(config.policy).toBeUndefined();
    expect(problems.join('\n')).toContain('launcher');
  });
});

describe('launcher is a known top-level key', () => {
  it('does not report launcher as an unknown key', () => {
    const { config, problems } = parseDaemonConfig({
      launcher: { profiles: [{ name: 'shell', command: 'cmd.exe' }] },
    });
    expect(problems).toEqual([]);
    expect(config.launcher?.profiles).toHaveLength(1);
  });

  it('a bad profile does not install a deny-all policy', () => {
    const { config, problems } = parseDaemonConfig({
      policy: { mode: 'allow-all' },
      launcher: { profiles: [{ name: 'bad', command: 'cmd.exe', surprise: true }] },
    });
    expect(config.policy).toEqual({ mode: 'allow-all' });
    expect(config.launcher?.profiles).toEqual([]);
    expect(problems.join('\n')).toContain('launcher.profiles[0] ("bad")');
  });
});

describe('profile policy', () => {
  it('a deny rule refuses a line the global mode allowed', () => {
    const policy = compileProfilePolicy({ deny: ['--dangerously'] });
    expect(evaluateCommand(policy, 'claude', ['--dangerously-skip-permissions']).allowed).toBe(false);
    expect(evaluateCommand(policy, 'claude', ['--model', 'sonnet']).allowed).toBe(true);
  });

  it('an allow list must also match', () => {
    const policy = compileProfilePolicy({ allow: ['^claude'] });
    expect(evaluateCommand(policy, 'claude').allowed).toBe(true);
    expect(evaluateCommand(policy, 'powershell').allowed).toBe(false);
  });
});

describe('the daemon environment copy', () => {
  it('copies only the named variables that are set', () => {
    const source = { WANTED: 'value', OTHER: 'no' } as NodeJS.ProcessEnv;
    expect(copyDaemonEnv(['WANTED', 'MISSING'], source)).toEqual({
      env: { WANTED: 'value' },
      copied: ['WANTED'],
    });
  });

  it('never copies a name reserved for a connected feature credential', () => {
    const source = { INTERMELD_TOKEN: 'secret', WANTED: 'value' } as NodeJS.ProcessEnv;
    const reserved = new Set(['INTERMELD_TOKEN']);
    expect(copyDaemonEnv(['INTERMELD_TOKEN', 'WANTED'], source, reserved)).toEqual({
      env: { WANTED: 'value' },
      copied: ['WANTED'],
    });
  });

  it('copies only own string properties, so inherited names are not variables', () => {
    // `constructor` and `toString` are functions on Object.prototype, not
    // variables, and a name on the source's prototype is not the daemon's.
    const source = Object.create({ INHERITED: 'inherited' }) as NodeJS.ProcessEnv;
    source['OWN'] = 'value';
    expect(copyDaemonEnv(['constructor', 'toString', 'INHERITED', 'OWN'], source)).toEqual({
      env: { OWN: 'value' },
      copied: ['OWN'],
    });
  });
});

describe('a launch command is resolved to the file that runs', () => {
  const dirs: string[] = [];
  // The function is told the platform, so these run with the host's path
  // rules and real paths: win32 on Windows, posix elsewhere.
  const host = process.platform === 'win32' ? 'win32' : 'linux';

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function makeProgram(dir: string, name: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
    return file;
  }

  it('finds a bare name on PATH, never in the working folder', () => {
    const bin = makeDir('launch-bin-');
    const work = makeDir('launch-work-');
    const real = makeProgram(bin, 'sptool');
    makeProgram(work, 'sptool'); // the decoy a shell searching the folder would run
    expect(resolveLaunchCommand('sptool', work, { PATH: bin }, host)).toEqual({ file: real });
  });

  it('takes a relative path with a separator from the folder', () => {
    const work = makeDir('launch-rel-');
    const sub = path.join(work, 'sub');
    fs.mkdirSync(sub);
    const real = makeProgram(sub, 'tool');
    expect(resolveLaunchCommand(path.join('sub', 'tool'), work, { PATH: '' }, host)).toEqual({ file: real });
  });

  it('resolves a quoted command without its quotes', () => {
    const work = makeDir('launch-quoted-');
    const real = makeProgram(work, 'tool');
    expect(resolveLaunchCommand(`"${real}"`, work, { PATH: '' }, host)).toEqual({ file: real });
  });

  it('refuses a bare name that is not on PATH, even when the folder has one', () => {
    const work = makeDir('launch-ghost-');
    const empty = makeDir('launch-empty-');
    makeProgram(work, 'ghost');
    const result = resolveLaunchCommand('ghost', work, { PATH: empty }, host);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('Command not found on PATH: ghost');
      expect(result.error).toContain('folder is not searched');
    }
  });

  it('refuses an absolute path that is not a file', () => {
    const work = makeDir('launch-missing-');
    const result = resolveLaunchCommand(path.join(work, 'missing'), work, {}, host);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('Not an executable file');
  });

  it('follows PATHEXT on Windows, so an npm .cmd shim still resolves', () => {
    if (process.platform !== 'win32') return;
    const bin = makeDir('launch-cmd-');
    const work = makeDir('launch-cmd-work-');
    fs.writeFileSync(path.join(bin, 'tool.cmd'), '@echo off\r\n');
    const expected = path.win32.resolve(path.win32.join(bin, 'tool.cmd'));
    const resolved = resolveLaunchCommand('tool', work, { PATH: bin, PATHEXT: '.CMD;.EXE' }, 'win32');
    // Windows names files without case, and the suffix comes from PATHEXT.
    expect('file' in resolved && resolved.file.toLowerCase()).toBe(expected.toLowerCase());
  });
});

describe('profile text placeholders', () => {
  it('fills {name} and {folder} at launch and leaves other braces alone', () => {
    expect(expandProfileText('{name} in {folder} {other}', 'shell', 'repo')).toBe(
      'shell in repo {other}',
    );
    expect(expandProfileText('{name} in {folder}', 'shell', undefined)).toBe('shell in ');
  });
});

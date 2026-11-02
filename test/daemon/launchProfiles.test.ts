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
  listRootFolders,
  resolveRootFolder,
  validRootFolderName,
  isRootFolderContained,
} from '../../src/daemon/launchProfiles.js';
import { evaluateCommand } from '../../src/core/policy.js';

const KNOWN_AGENTS = new Set(['claude', 'codex']);

function parse(raw: unknown): ReturnType<typeof parseLauncher> {
  return parseLauncher(raw, KNOWN_AGENTS);
}

describe('launcher profiles load', () => {
  it('accepts folder roots with cwd ask and named folders', () => {
    const { launcher, problems } = parse({ profiles: [{ name: 'shell', command: 'node', cwd: 'ask', folderRoots: ['C:/work'] }] });
    expect(problems).toEqual([]);
    expect(launcher.profiles[0]?.folderRoots).toEqual(['C:/work']);
  });
  it('allows an any-folder profile only with cwd ask', () => {
    const valid = parse({ profiles: [{ name: 'open', command: 'node', cwd: 'ask', folders: 'any' }] });
    expect(valid.problems).toEqual([]);
    expect(valid.launcher.profiles[0]?.anyFolder).toBe(true);
    const invalid = parse({ profiles: [{ name: 'fixed', command: 'node', cwd: 'C:/work', folders: 'any' }] });
    expect(invalid.launcher.profiles).toEqual([]);
  });
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

describe('folders offered under a root', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
  function root(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-root-')); dirs.push(dir); return dir; }

  it('lists one level, sorted, without hidden folders or files', async () => {
    const dir = root();
    for (const name of ['zeta', 'alpha', '.hidden']) fs.mkdirSync(path.join(dir, name));
    fs.mkdirSync(path.join(dir, 'alpha', 'nested'));
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    expect(await listRootFolders([dir])).toEqual([{ rootIndex: 0, name: 'alpha' }, { rootIndex: 0, name: 'zeta' }]);
  });

  it('omits dot names and named Windows system directories, including Unicode roots', async () => {
    const dir = path.join(root(), 'Répertoire');
    fs.mkdirSync(dir);
    for (const name of ['visible', '.hidden', '$RECYCLE.BIN', 'System Volume Information', '$WinREAgent', 'rEcOvErY', 'Config.Msi']) fs.mkdirSync(path.join(dir, name));
    expect(await listRootFolders([dir])).toEqual([{ rootIndex: 0, name: 'visible' }]);
  });

  it('keeps the event loop available while listing a 400-folder root', async () => {
    const dir = root();
    for (let index = 0; index < 400; index++) fs.mkdirSync(path.join(dir, `folder-${String(index).padStart(3, '0')}`));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 1);
    try {
      const listed = await Promise.all(Array.from({ length: 5 }, () => listRootFolders([dir])));
      expect(listed[0]).toHaveLength(400);
      expect(ticks).toBeGreaterThan(0);
    } finally { clearInterval(timer); }
  }, 30_000);

  it.each(['a/b', 'a\\b'])('rejects a separator as its own name guard: %s', (name) => {
    expect(validRootFolderName(name)).toBe(false);
  });
  it('rejects dot-dot as its own name guard', () => {
    expect(validRootFolderName('..')).toBe(false);
  });
  it.each(['CON', 'NUL.txt'])('rejects a device name as its own name guard: %s', (name) => {
    expect(validRootFolderName(name)).toBe(false);
  });
  it('rejects a resolved child outside its root even when it was initially offered', async () => {
    const dir = root();
    const outside = root();
    fs.mkdirSync(path.join(dir, 'pick'));
    expect(await listRootFolders([dir])).toContainEqual({ rootIndex: 0, name: 'pick' });
    fs.rmdirSync(path.join(dir, 'pick'));
    fs.symlinkSync(outside, path.join(dir, 'pick'), 'junction');
    expect(isRootFolderContained(fs.realpathSync(dir), fs.realpathSync(path.join(dir, 'pick')))).toBe(false);
  });
  it('requires a still-offered child even while its real directory exists', async () => {
    const dir = root();
    const child = path.join(dir, 'pick');
    fs.mkdirSync(child);
    expect(await listRootFolders([dir])).toContainEqual({ rootIndex: 0, name: 'pick' });
    fs.renameSync(child, path.join(dir, '.pick'));
    fs.symlinkSync(path.join(dir, '.pick'), child, 'junction');
    expect(fs.realpathSync(child)).toBeTruthy();
    expect(await resolveRootFolder([dir], 0, 'pick')).toEqual({ error: 'Folder is no longer offered by this root.' });
  });
  it.each([-1, 0.5, '0', 1])('rejects invalid root index %s', async (index) => {
    const dir = root();
    fs.mkdirSync(path.join(dir, 'pick'));
    expect(await resolveRootFolder([dir], index, 'pick')).toEqual({ error: 'Invalid root folder choice.' });
  });

  for (const name of ['a/b', 'a\\b', '..', 'C:/work', 'CON', 'NUL.txt']) {
    it(`refuses unsafe folder name ${name}`, async () => {
      expect('error' in await resolveRootFolder([root()], 0, name)).toBe(true);
    });
  }

  it('refuses a junction that leaves the root', async () => {
    const dir = root();
    const outside = root();
    fs.symlinkSync(outside, path.join(dir, 'escape'), 'junction');
    expect('error' in await resolveRootFolder([dir], 0, 'escape')).toBe(true);
  });

  it('refuses a folder deleted after it was offered', async () => {
    const dir = root();
    fs.mkdirSync(path.join(dir, 'gone'));
    expect(await listRootFolders([dir])).toContainEqual({ rootIndex: 0, name: 'gone' });
    fs.rmdirSync(path.join(dir, 'gone'));
    expect('error' in await resolveRootFolder([dir], 0, 'gone')).toBe(true);
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

  it('accepts all but rejects every other string for envFromDaemon', () => {
    const { launcher, problems } = parse({ profiles: [
      { name: 'whole', command: 'cmd.exe', envFromDaemon: 'all' },
      { name: 'wrong', command: 'cmd.exe', envFromDaemon: 'passthrough' },
    ] });
    expect(launcher.profiles).toHaveLength(1);
    expect(launcher.profiles.map((profile) => profile.name)).toEqual(['whole']);
    expect(launcher.profiles[0]?.envFromDaemon).toBe('all');
    expect(problems.join('\n')).toContain('envFromDaemon');
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
  it('excludes verified agent child markers that prefixes missed', () => {
    const names = [
      'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SSE_PORT',
      'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID',
      'CODEX_TOOL_CALL_ID', 'CODEX_VERSION', 'CODEX_PERMISSION_PROFILE',
      'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'GROK_AGENT',
      'OPENCODE_TERMINAL', 'OPENCODE', 'OPENCODE_PID',
    ];
    const source: NodeJS.ProcessEnv = { ORDINARY_NAME: 'made-up-ordinary' };
    for (const name of names) source[name] = `made-up-${name}`;
    expect(copyDaemonEnv('all', source)).toEqual({
      env: { ORDINARY_NAME: 'made-up-ordinary' },
      copied: ['ORDINARY_NAME'],
    });
  });
  it('passes documented user settings and unverified CLI prefixes', () => {
    const source = {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: 'made-up-output-limit',
      CLAUDE_CODE_USE_BEDROCK: 'made-up-provider-choice',
      CLAUDE_CODE_GIT_BASH_PATH: 'made-up-shell-path',
      QODER_SESSION_ID: 'made-up-qoder-choice',
      QODER_SESSION_NAME: 'made-up-qoder-name',
      ANTIGRAVITY_SESSION_ID: 'made-up-antigravity-setting',
      GOOSE_SESSION_ID: 'made-up-goose-setting',
      GEMINI_CLI_SESSION_ID: 'made-up-gemini-setting',
      OPENCODE_SESSION_ID: 'made-up-opencode-setting',
      OPENCODE_CLIENT: 'made-up-opencode-client',
      CODEX_SHELL: 'made-up-codex-setting',
    };
    expect(copyDaemonEnv('all', source)).toEqual({
      env: source,
      copied: Object.keys(source),
    });
  });
  it.runIf(process.platform === 'win32')('matches new exact markers without regard to case on Windows', () => {
    const source = {
      cOdEx_ToOl_CaLl_Id: 'made-up-codex',
      oPeNcOdE_tErMiNaL: 'made-up-opencode',
      gRoK_aGeNt: 'made-up-grok',
      cLaUdE_cOdE_mAx_OuTpUt_ToKeNs: 'made-up-setting',
      qOdEr_SeSsIoN_nAmE: 'made-up-session-name',
    };
    expect(copyDaemonEnv('all', source)).toEqual({
      env: {
        cLaUdE_cOdE_mAx_OuTpUt_ToKeNs: 'made-up-setting',
        qOdEr_SeSsIoN_nAmE: 'made-up-session-name',
      },
      copied: ['cLaUdE_cOdE_mAx_OuTpUt_ToKeNs', 'qOdEr_SeSsIoN_nAmE'],
    });
  });
  it.runIf(process.platform !== 'win32')('matches the markers exactly elsewhere', () => {
    const source = { codex_thread_id: 'made-up-lower-case', CODEX_THREAD_ID: 'made-up-marker' };
    expect(copyDaemonEnv('all', source)).toEqual({
      env: { codex_thread_id: 'made-up-lower-case' },
      copied: ['codex_thread_id'],
    });
  });
  it('copies all owned string values except reserved credentials and ShellPuppet session variables', () => {
    const source = Object.create({ INHERITED: 'inherited' }) as NodeJS.ProcessEnv;
    source['UNLISTED'] = 'made-up-value';
    source['FEATURE_CREDENTIAL'] = 'made-up-feature';
    source['SHELLPUPPET_HOME'] = 'made-up-home';
    source['SHELLPUPPET_TOKEN'] = 'made-up-token';
    source['NODE_OPTIONS'] = '--no-warnings';
    source['=C:'] = 'made-up-drive';
    source['ODD-NAME'] = 'made-up-malformed';
    const result = copyDaemonEnv('all', source, new Set(['FEATURE_CREDENTIAL']));
    expect(result.copied).toEqual(['UNLISTED', 'SHELLPUPPET_HOME']);
    expect(result.env['UNLISTED'] === 'made-up-value').toBe(true);
    expect(result.env['SHELLPUPPET_HOME'] === 'made-up-home').toBe(true);
  });
  it('keeps agent CLI session scaffolding out of an all profile', () => {
    const excluded = [
      'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID',
      'CODEX_THREAD_ID', 'GROK_SESSION_ID', 'OPENCODE_TERMINAL',
      'GEMINI_CLI', 'SHELLPUPPET_SESSION',
    ];
    const source: NodeJS.ProcessEnv = {
      SHELLPUPPET_HOME: 'made-up-home',
      ANTHROPIC_API_KEY: 'made-up-user-key',
      CLAUDE_CONFIG_DIR: 'made-up-config-dir',
      OPENAI_API_KEY: 'made-up-openai-key',
      ORDINARY_NAME: 'made-up-ordinary',
    };
    for (const name of excluded) source[name] = `made-up-${name}`;
    const result = copyDaemonEnv('all', source);
    expect(result.env).toEqual({
      SHELLPUPPET_HOME: 'made-up-home',
      ANTHROPIC_API_KEY: 'made-up-user-key',
      CLAUDE_CONFIG_DIR: 'made-up-config-dir',
      OPENAI_API_KEY: 'made-up-openai-key',
      ORDINARY_NAME: 'made-up-ordinary',
    });
    expect(result.copied).toEqual([
      'SHELLPUPPET_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR',
      'OPENAI_API_KEY', 'ORDINARY_NAME',
    ]);
    expect(copyDaemonEnv(['CLAUDE_CODE_SESSION_ID'], source)).toEqual({
      env: { CLAUDE_CODE_SESSION_ID: 'made-up-CLAUDE_CODE_SESSION_ID' },
      copied: ['CLAUDE_CODE_SESSION_ID'],
    });
  });
  it.runIf(process.platform === 'win32')('excludes agent CLI session names without regard to case on Windows', () => {
    const source = {
      cLaUdEcOdE: 'made-up-claude',
      cLaUdE_cOdE_sEsSiOn_Id: 'made-up-claude-session',
      cLaUdE_pId: 'made-up-claude-pid',
      cOdEx_ThReAd_Id: 'made-up-codex',
      gRoK_sEsSiOn_Id: 'made-up-grok',
      oPeNcOdE_tErMiNaL: 'made-up-opencode',
      gEmInI_cLi: 'made-up-gemini',
      sHeLlPuPpEt_SeSsIoN: 'made-up-shellpuppet',
      sHeLlPuPpEt_HoMe: 'made-up-home',
    };
    expect(copyDaemonEnv('all', source)).toEqual({
      env: { sHeLlPuPpEt_HoMe: 'made-up-home' },
      copied: ['sHeLlPuPpEt_HoMe'],
    });
  });
  it('leaves an owned __proto__ name out of an explicit copy', () => {
    const source = Object.create(null) as NodeJS.ProcessEnv;
    Object.defineProperty(source, '__proto__', { value: 'made-up-prototype', enumerable: true });
    const result = copyDaemonEnv(['__proto__', 'SAFE'], source);
    expect(result.copied.includes('__proto__')).toBe(false);
    expect(Object.hasOwn(result.env, '__proto__')).toBe(false);
  });
  it.runIf(process.platform === 'win32')('folds case when excluding reserved credential names', () => {
    const source = { fEaTuRe_CrEdEnTiAl: 'made-up-feature', SAFE: 'made-up-safe' };
    const result = copyDaemonEnv('all', source, new Set(['FEATURE_CREDENTIAL']));
    expect(result.copied.includes('fEaTuRe_CrEdEnTiAl')).toBe(false);
    expect(result.env['SAFE'] === 'made-up-safe').toBe(true);
  });
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

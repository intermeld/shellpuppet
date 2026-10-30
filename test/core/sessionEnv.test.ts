/**
 * A session's own variables (`SessionOptions.env`, design §4.6) go on top of
 * the environment `sessionEnv` gives it, and TERM is still the terminal's.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_ENV, buildSessionEnv, credentialShapedNames } from '../../src/core/session.js';

const SOURCE = { PATH: '/bin', HOME: '/home/x', INHERITED_KEY: 'from-daemon' };

describe('buildSessionEnv with variables of the session’s own', () => {
  it('adds them on top of a clean environment, which keeps everything else out', () => {
    const env = buildSessionEnv('clean', 'linux', SOURCE, { PASSED_KEY: 'v' });
    expect(env['PASSED_KEY']).toBe('v');
    expect(env['INHERITED_KEY']).toBeUndefined();
    expect(env['PATH']).toBe('/bin');
  });

  it('replaces an inherited variable of the same name', () => {
    const env = buildSessionEnv('passthrough', 'linux', SOURCE, { INHERITED_KEY: 'passed' });
    expect(env['INHERITED_KEY']).toBe('passed');
  });

  it('on Windows replaces it whatever its case, leaving one copy', () => {
    const env = buildSessionEnv('passthrough', 'win32', { Inherited_Key: 'old' }, { INHERITED_KEY: 'new' });
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'INHERITED_KEY')).toEqual(['INHERITED_KEY']);
    expect(env['INHERITED_KEY']).toBe('new');
  });

  it('elsewhere keeps names that differ in case apart, as the platform does', () => {
    const env = buildSessionEnv('passthrough', 'linux', { Inherited_Key: 'old' }, { INHERITED_KEY: 'new' });
    expect(env['Inherited_Key']).toBe('old');
    expect(env['INHERITED_KEY']).toBe('new');
  });

  it('cannot change TERM or COLORTERM, which belong to the terminal', () => {
    const env = buildSessionEnv('clean', 'linux', SOURCE, { TERM: 'dumb', COLORTERM: 'none' });
    expect(env['TERM']).toBe('xterm-256color');
    expect(env['COLORTERM']).toBe('truecolor');
  });

  it('on Windows cannot change them in another casing either, which Windows would read as the same name', () => {
    const env = buildSessionEnv('passthrough', 'win32', { Term: 'inherited' }, { colorterm: 'none', TeRm: 'dumb' });
    const named = (wanted: string): string[] =>
      Object.keys(env).filter((key) => key.toUpperCase() === wanted);
    expect(named('TERM')).toEqual(['TERM']);
    expect(named('COLORTERM')).toEqual(['COLORTERM']);
    expect(env['TERM']).toBe('xterm-256color');
    expect(env['COLORTERM']).toBe('truecolor');
  });
});

describe('the clean baseline (ADR-008)', () => {
  it('is the default', () => {
    expect(DEFAULT_SESSION_ENV).toBe('clean');
  });

  it('on Windows keeps the standard variables toolchains look for, and nothing else', () => {
    const source = {
      Path: 'C:/Windows',
      SystemRoot: 'C:/Windows',
      'ProgramFiles(x86)': 'C:/Program Files (x86)',
      CommonProgramFiles: 'C:/Program Files/Common Files',
      COMPUTERNAME: 'BOX',
      PSModulePath: 'C:/Modules',
      NoDefaultCurrentDirectoryInExePath: '1',
      PAYMENT_API_KEY: 'value-from-daemon',
    };
    const env = buildSessionEnv('clean', 'win32', source);
    expect(env['ProgramFiles(x86)']).toBe('C:/Program Files (x86)');
    expect(env['CommonProgramFiles']).toBe('C:/Program Files/Common Files');
    expect(env['COMPUTERNAME']).toBe('BOX');
    expect(env['PSModulePath']).toBe('C:/Modules');
    expect(env['NoDefaultCurrentDirectoryInExePath']).toBe('1');
    expect(env['Path']).toBe('C:/Windows');
    expect(env['PAYMENT_API_KEY']).toBeUndefined();
  });

  it('on POSIX keeps the login name and the locale, without which terminal programs lose UTF-8', () => {
    const source = { PATH: '/bin', LOGNAME: 'x', LC_ALL: 'C.UTF-8', LC_CTYPE: 'C.UTF-8', SSH_AUTH_SOCK: '/tmp/agent' };
    const env = buildSessionEnv('clean', 'linux', source);
    expect(env['LOGNAME']).toBe('x');
    expect(env['LC_ALL']).toBe('C.UTF-8');
    expect(env['LC_CTYPE']).toBe('C.UTF-8');
    // Opt-in through the list form, as configuration.md says.
    expect(env['SSH_AUTH_SOCK']).toBeUndefined();
    expect(buildSessionEnv(['SSH_AUTH_SOCK'], 'linux', source)['SSH_AUTH_SOCK']).toBe('/tmp/agent');
  });
});

describe('credentialShapedNames', () => {
  it('names variables that look like credentials, sorted, never their values', () => {
    const names = credentialShapedNames({
      PAYMENT_API_KEY: 'v1',
      GithubToken: 'v2',
      EXAMPLE_CLIENT_SECRET: 'v3',
      SSH_AUTH_SOCK: 'v4',
      VENDOR_APIKEY_REF: 'v5',
      DB_PASSWORD: 'v6',
      ImageLibraryLicenseKey: 'v7',
      PATH: '/bin',
      PWD: '/home/x',
      MAX_THINKING_TOKENS: '1000',
      GIT_AUTHOR_NAME: 'x',
      KEYBOARD_LAYOUT: 'uk',
      EMPTY_TOKEN: '',
    });
    expect(names).toEqual([
      'DB_PASSWORD',
      'EXAMPLE_CLIENT_SECRET',
      'GithubToken',
      'ImageLibraryLicenseKey',
      'PAYMENT_API_KEY',
      'SSH_AUTH_SOCK',
      'VENDOR_APIKEY_REF',
    ]);
  });

  it('splits after a digit and before the last capital of a run, and reads one-word names by their ending', () => {
    const shaped = (name: string): boolean => credentialShapedNames({ [name]: 'v' }).length === 1;
    for (const name of ['S3Key', 'Auth0Token', 'GHToken', 'NPMToken', 'APISecret', 'AWSKey', 'PGPass', 'GITHUBTOKEN', 'PGPASSWORD', 'CLIENTSECRET', 'ACCESSKEY']) {
      expect(shaped(name), name).toBe(true);
    }
    for (const name of ['DB_PASS', 'DB_PW', 'GPG_PASSPHRASE', 'API_KEYS', 'AWS_SECRETS', 'SLACK_WEBHOOK_URL', 'SENTRY_DSN', 'AZURE_SAS', 'JWT', 'HTTP_AUTHORIZATION', 'BEARER', 'DB_CREDS']) {
      expect(shaped(name), name).toBe(true);
    }
    for (const name of ['PSModulePath', 'MAX_TOKENS', 'HOTKEY', 'MONKEY_PATCH', 'BYPASS_CACHE', 'PASSTHROUGH', 'COMPASS_DIR', 'PATHEXT']) {
      expect(shaped(name), name).toBe(false);
    }
  });

  it('reads a name as long as a Windows environment block in linear time', () => {
    // A backtracking split took seconds on a run of capitals this long; the
    // lookahead takes well under a millisecond, so the bound is generous.
    const started = performance.now();
    expect(credentialShapedNames({ ['A'.repeat(32_000)]: 'v', ['Ab'.repeat(16_000)]: 'v' })).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

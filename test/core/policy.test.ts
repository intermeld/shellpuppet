import { describe, expect, it } from 'vitest';
import {
  checkSessionCapacity,
  commandLine,
  compilePolicy,
  evaluateCommand,
} from '../../src/core/policy.js';

// The design §4.3 example, in allowlist mode.
const designExample = {
  mode: 'allowlist' as const,
  allow: ['^qodercli', '^goose', '^gemini', '^grok'],
  deny: ['rm\\s+-rf\\s+/', 'format\\s', '^shutdown'],
  maxSessions: 10,
};

describe('commandLine', () => {
  it('joins command and args with single spaces', () => {
    expect(commandLine('goose', ['session', '--name', 'x'])).toBe('goose session --name x');
    expect(commandLine('goose')).toBe('goose');
  });
});

describe('evaluateCommand: allow-all', () => {
  it('allows everything, lists inert', () => {
    const policy = compilePolicy({ mode: 'allow-all', deny: ['.*'] });
    expect(evaluateCommand(policy, 'anything', ['at', 'all']).allowed).toBe(true);
  });

  it('is the default when no policy is configured', () => {
    const policy = compilePolicy(undefined);
    expect(policy.mode).toBe('allow-all');
    expect(evaluateCommand(policy, 'goose', ['session']).allowed).toBe(true);
  });
});

describe('evaluateCommand: allowlist', () => {
  const policy = compilePolicy(designExample);

  it('allows listed commands', () => {
    for (const command of ['qodercli', 'goose', 'gemini', 'grok']) {
      const decision = evaluateCommand(policy, command, ['session']);
      expect(decision.allowed, `${command} should be allowed`).toBe(true);
      expect(decision.rule).toBe(`^${command}`);
    }
  });

  it('refuses unlisted commands with a reason', () => {
    const decision = evaluateCommand(policy, 'powershell', []);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('not on the allowlist');
  });

  it('evaluates the pre-wrap command, never the shell wrapper (§4.3)', () => {
    // Callers pass the real command; the daemon applies `cmd.exe /c` AFTER the
    // policy decision. If a caller (or a future refactor) routed the wrapped
    // form through policy, the allowlist would see `cmd.exe` for everything
    // and be unsatisfiable. Pin both directions:
    expect(evaluateCommand(policy, 'goose', ['session']).allowed).toBe(true);
    expect(evaluateCommand(policy, 'cmd.exe', ['/c', 'goose session']).allowed).toBe(false);
  });

  it('honours deny rules even in allowlist mode: deny always wins', () => {
    const belt = compilePolicy({
      mode: 'allowlist',
      allow: ['^goose'],
      deny: ['--dangerous'],
    });
    expect(evaluateCommand(belt, 'goose', ['session']).allowed).toBe(true);
    const decision = evaluateCommand(belt, 'goose', ['session', '--dangerous']);
    expect(decision.allowed).toBe(false);
    expect(decision.rule).toBe('--dangerous');
  });

  it('matches case-insensitively: Windows commands are case-insensitive in reality', () => {
    expect(evaluateCommand(policy, 'Goose.exe', ['session']).allowed).toBe(true);
    expect(evaluateCommand(policy, 'QoderCLI', []).allowed).toBe(true);
  });
});

describe('evaluateCommand: denylist', () => {
  const policy = compilePolicy({ mode: 'denylist', deny: designExample.deny });

  it('refuses matching commands', () => {
    expect(evaluateCommand(policy, 'rm', ['-rf', '/']).allowed).toBe(false);
    expect(evaluateCommand(policy, 'shutdown', ['/s']).allowed).toBe(false);
    expect(evaluateCommand(policy, 'format', ['c:']).allowed).toBe(false);
  });

  it('allows everything else', () => {
    expect(evaluateCommand(policy, 'goose', ['session']).allowed).toBe(true);
    expect(evaluateCommand(policy, 'rm', ['-i', 'file.txt']).allowed).toBe(true);
  });

  it('matches deny patterns anywhere in the command line, not only the command word', () => {
    expect(evaluateCommand(policy, 'bash', ['-c', 'rm -rf /']).allowed).toBe(false);
  });
});

describe('evaluateCommand: malformed patterns fail closed', () => {
  it('refuses every command when an active policy has an invalid pattern', () => {
    const policy = compilePolicy({ mode: 'allowlist', allow: ['^goose', '(unclosed'] });
    expect(policy.invalidPatterns).toEqual(['(unclosed']);
    const decision = evaluateCommand(policy, 'goose', ['session']);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('(unclosed');
    expect(decision.reason).toContain('config.json');
  });

  it('fails closed for a broken deny pattern too: a deny that cannot be evaluated must not silently allow', () => {
    const policy = compilePolicy({ mode: 'denylist', deny: ['[bad'] });
    expect(evaluateCommand(policy, 'harmless', []).allowed).toBe(false);
  });

  it('does not penalise allow-all mode, where patterns are inert', () => {
    const policy = compilePolicy({ mode: 'allow-all', deny: ['[bad'] });
    expect(evaluateCommand(policy, 'anything', []).allowed).toBe(true);
  });
});

describe('evaluateCommand: configError outranks everything', () => {
  it('refuses every command with the stated reason, even in allow-all mode', () => {
    // A structurally invalid policy SECTION cannot even tell us the intended
    // mode, so, unlike invalid patterns, this must outrank the allow-all
    // early return. Set by the daemon's config validation, never by users.
    const policy = compilePolicy({
      mode: 'allow-all',
      configError: 'the policy section is invalid: allow must be an ARRAY.',
    });
    const decision = evaluateCommand(policy, 'goose', ['session']);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('allow must be an ARRAY');
    expect(decision.reason).toContain('config.json');
  });

  it('refuses in allowlist mode even when a rule would have matched', () => {
    const policy = compilePolicy({
      mode: 'allowlist',
      allow: ['^goose'],
      configError: 'the policy section is invalid: has an unknown key "denyy".',
    });
    expect(evaluateCommand(policy, 'goose', ['session']).allowed).toBe(false);
  });
});

describe('checkSessionCapacity', () => {
  it('allows below the cap, refuses at it', () => {
    const policy = compilePolicy({ mode: 'allow-all', maxSessions: 2 });
    expect(checkSessionCapacity(policy, 0).allowed).toBe(true);
    expect(checkSessionCapacity(policy, 1).allowed).toBe(true);
    const decision = checkSessionCapacity(policy, 2);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('2');
  });

  it('has no cap unless one is configured', () => {
    for (const policy of [compilePolicy(undefined), compilePolicy({ mode: 'allow-all' })]) {
      // The compiled value, not only sample counts: a default of any size fails here.
      expect(policy.maxSessions).toBeUndefined();
      expect(checkSessionCapacity(policy, 10).allowed).toBe(true);
      expect(checkSessionCapacity(policy, 1_000).allowed).toBe(true);
    }
  });
});

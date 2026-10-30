/**
 * Config shape validation. A value of the wrong shape must not reach
 * compilePolicy: `"allow": "^goose"`, a string where an array belongs, would
 * be read one character at a time as single-character regex rules. Shape
 * mistakes must fail CLOSED.
 */

import { describe, expect, it } from 'vitest';
import { isEnvNamesProblem, parseDaemonConfig } from '../../src/daemon/config.js';
import { compilePolicy, evaluateCommand } from '../../src/core/policy.js';

/** Compile the parsed policy and evaluate a command, as the daemon would. */
function decide(raw: unknown, command: string): { allowed: boolean; reason?: string } {
  const { config } = parseDaemonConfig(raw);
  return evaluateCommand(compilePolicy(config.policy), command);
}

describe('parseDaemonConfig: valid input', () => {
  it('no file (undefined) means pure defaults and no problems', () => {
    expect(parseDaemonConfig(undefined)).toEqual({ config: {}, problems: [] });
  });

  it('accepts valid values across the documented sections', () => {
    const { config, problems } = parseDaemonConfig({
      policy: {
        mode: 'allowlist',
        allow: ['^goose'],
        deny: ['rm\\s+-rf'],
        maxSessions: 5,
      },
      idleMinutes: 0.5,
      sessionEnv: ['MY_API_KEY'],
      audit: { captureContent: false },
      envNames: ['NPM_TOKEN'],
      mcp: { untrustedFraming: true },
    });
    expect(problems).toEqual([]);
    expect(config.policy).toEqual({
      mode: 'allowlist',
      allow: ['^goose'],
      deny: ['rm\\s+-rf'],
      maxSessions: 5,
    });
    expect(config.idleMinutes).toBe(0.5);
    expect(config.sessionEnv).toEqual(['MY_API_KEY']);
    expect(config.audit).toEqual({ captureContent: false });
    expect(config.envNames).toEqual(['NPM_TOKEN']);
  });

  it('a valid policy still evaluates normally after the round trip', () => {
    const raw = { policy: { mode: 'allowlist', allow: ['^goose'] } };
    expect(decide(raw, 'goose session').allowed).toBe(true);
    expect(decide(raw, 'powershell').allowed).toBe(false);
  });
});

describe('parseDaemonConfig: the policy section fails CLOSED', () => {
  it('a STRING allowlist refuses everything instead of matching per-character', () => {
    const raw = { policy: { mode: 'allowlist', allow: '^goose' } };
    const goose = decide(raw, 'goose session');
    expect(goose.allowed).toBe(false);
    expect(goose.reason).toContain('ARRAY');
    expect(decide(raw, 'grep secrets').allowed).toBe(false);
  });

  it('an unknown mode refuses everything and names the problem', () => {
    const result = decide({ policy: { mode: 'Allowlist' } }, 'goose');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('mode must be one of');
    expect(result.reason).toContain('config.json');
  });

  it('an unknown key inside policy refuses everything (a misspelt deny must not deny nothing)', () => {
    const result = decide(
      { policy: { mode: 'denylist', denyy: ['rm'] } },
      'rm -rf /',
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('denyy');
  });

  it('a malformed maxSessions refuses everything', () => {
    for (const bad of ['20', 0, -1, 2.5, Number.NaN]) {
      const result = decide({ policy: { mode: 'allow-all', maxSessions: bad } }, 'goose');
      expect(result.allowed, `maxSessions=${String(bad)}`).toBe(false);
    }
  });

  it('a policy section that is not an object refuses everything', () => {
    expect(decide({ policy: 'allowlist' }, 'goose').allowed).toBe(false);
  });

  it('deny-all outranks allow-all mode: a broken section must not be waved through', () => {
    // mode itself is fine here; the allow list is the broken part.
    const result = decide({ policy: { mode: 'allow-all', allow: 42 } }, 'goose');
    expect(result.allowed).toBe(false);
  });

  it('reports the problem for the daemon log as well as the refusal reason', () => {
    const { problems } = parseDaemonConfig({ policy: { mode: 'allowlist', allow: '^goose' } });
    expect(problems.some((p) => p.includes('refusing all commands'))).toBe(true);
  });
});

describe('parseDaemonConfig: other fields fail SAFE', () => {
  it('an invalid sessionEnv falls back to clean, never passthrough', () => {
    for (const bad of ['Clean', 'PASSTHROUGH', null, 1, ['MY_SETTING', 1], [['MY_SETTING']]]) {
      const { config, problems } = parseDaemonConfig({ sessionEnv: bad });
      expect(config.sessionEnv, `sessionEnv=${JSON.stringify(bad)}`).toBe('clean');
      expect(problems.some((p) => p.includes('sessionEnv'))).toBe(true);
    }
  });

  it('an invalid idleMinutes is dropped with a problem', () => {
    for (const bad of ['30', -1, 0, Number.NaN]) {
      const { config, problems } = parseDaemonConfig({ idleMinutes: bad });
      expect(config.idleMinutes, `idleMinutes=${String(bad)}`).toBeUndefined();
      expect(problems.length).toBeGreaterThan(0);
    }
  });

  it('a non-boolean captureContent stays OFF: anything unclear must not capture secrets', () => {
    const { config, problems } = parseDaemonConfig({ audit: { captureContent: 'true' } });
    expect(config.audit).toBeUndefined();
    expect(problems.some((p) => p.includes('captureContent'))).toBe(true);
  });

  it('unknown top-level keys are reported but do not invalidate the rest', () => {
    const { config, problems } = parseDaemonConfig({
      Policy: { mode: 'allowlist' }, // wrong case, a classic typo
      idleMinutes: 10,
    });
    expect(problems.some((p) => p.includes('"Policy"'))).toBe(true);
    expect(config.idleMinutes).toBe(10);
    // The typo means NO policy was configured. That is the documented
    // default, and the warning is how the user finds out.
    expect(config.policy).toBeUndefined();
  });

  it('a non-object root refuses everything and uses the clean env', () => {
    const { config, problems } = parseDaemonConfig(['not', 'a', 'config']);
    expect(config.sessionEnv).toBe('clean');
    expect(problems.length).toBeGreaterThan(0);
    const result = evaluateCommand(compilePolicy(config.policy), 'goose');
    expect(result.allowed).toBe(false);
  });
});

describe('viewer launch config', () => {
  it('accepts a valid viewer section', () => {
    const { config, problems } = parseDaemonConfig({
      viewer: { launchMode: 'isolated-app', browserPath: 'C:/browser.exe' },
    });
    expect(config.viewer?.launchMode).toBe('isolated-app');
    expect(config.viewer?.browserPath).toBe('C:/browser.exe');
    expect(problems).toEqual([]);
  });

  it('falls back to none, never to launching, on an invalid launchMode', () => {
    // Config the daemon cannot read must not cause it to start spawning
    // browser windows on someone's desktop. A viewer that did not open is
    // visibly wrong in a way the operator can act on; one that opened when it
    // should not have is not.
    const { config, problems } = parseDaemonConfig({ viewer: { launchMode: 'kiosk' } });
    expect(config.viewer?.launchMode).toBe('none');
    expect(problems.join(' ')).toMatch(/launchMode/);
  });

  it('falls back to none when viewer is not an object', () => {
    const { config, problems } = parseDaemonConfig({ viewer: 'isolated-app' });
    expect(config.viewer?.launchMode).toBe('none');
    expect(problems.join(' ')).toMatch(/viewer must be an object/);
  });

  it('reports an unknown viewer key without discarding the rest', () => {
    const { config, problems } = parseDaemonConfig({
      viewer: { launchMode: 'default-browser', lanchMode: 'oops' },
    });
    expect(config.viewer?.launchMode).toBe('default-browser');
    expect(problems.join(' ')).toMatch(/unknown key "lanchMode"/);
  });

  it('does not flag viewer as an unknown top-level key', () => {
    const { problems } = parseDaemonConfig({ viewer: { launchMode: 'none' } });
    expect(problems.join(' ')).not.toMatch(/unknown key "viewer"/);
  });
});

describe('extra dialog signatures', () => {
  const FINE = { name: 'Example CLI', title: 'wants to run', choices: 'Approve {2,}Deny' };

  it('keeps the entries that compile and reports the rest', () => {
    const { config, problems } = parseDaemonConfig({
      prompts: { dialogs: [FINE, { name: 'Broken', title: '(', choices: 'x' }] },
    });
    expect(config.dialogs).toEqual([FINE]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Broken');
    expect(problems.join(' ')).not.toMatch(/unknown key "prompts"/);
  });

  it('reports a prompts section of the wrong shape and uses the built-in dialogs only', () => {
    for (const prompts of [[FINE], { dialogs: FINE }, { dialogs: [FINE], extra: 1 }]) {
      const { config, problems } = parseDaemonConfig({ prompts });
      expect(config.dialogs).toBeUndefined();
      expect(problems.join(' ')).toMatch(/prompts must be an object/);
    }
  });
});

describe('extra agent signatures', () => {
  const FINE = { name: 'mycli', programs: ['mycli'], composer: { text: '^> ' }, answer: { start: { text: '^• ' } } };

  it('keeps the entries that compile and reports the rest', () => {
    const { config, problems } = parseDaemonConfig({
      agents: { signatures: [FINE, { name: 'broken', composer: { text: '(' }, answer: { start: { text: 'x' } } }] },
    });
    expect(config.agentSignatures).toEqual([FINE]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('broken');
    expect(problems.join(' ')).not.toMatch(/unknown key "agents"/);
  });

  it('reports an agents section of the wrong shape and uses the built-in signatures only', () => {
    for (const agents of [[FINE], 'mycli']) {
      const { config, problems } = parseDaemonConfig({ agents });
      expect(config.agentSignatures).toBeUndefined();
      expect(problems.join(' ')).toMatch(/agents must be an object/);
    }
    const notList = parseDaemonConfig({ agents: { signatures: FINE } });
    expect(notList.config.agentSignatures).toBeUndefined();
    expect(notList.problems.join(' ')).toMatch(/agents\.signatures must be an array/);
  });

  it('reports an unknown key in agents and keeps the signatures', () => {
    const { config, problems } = parseDaemonConfig({ agents: { signatures: [FINE], extra: 1 } });
    expect(config.agentSignatures).toEqual([FINE]);
    expect(problems.join(' ')).toMatch(/agents has an unknown key extra/);
  });
});

describe('the variables each agent receives', () => {
  const MINE = { name: 'mycli', programs: ['mycli'], composer: { text: '^> ' }, answer: { start: { text: '^• ' } } };

  it('reads a list per agent, for built-in agents and the config\'s own', () => {
    const { config, problems } = parseDaemonConfig({
      agents: { signatures: [MINE], passEnv: { qoder: ['QODER_TOKEN', 'ZHIPU_API_KEY'], mycli: ['MY_KEY'], codex: [] } },
    });
    expect(problems).toEqual([]);
    expect(config.agentPassEnv).toEqual({ qoder: ['QODER_TOKEN', 'ZHIPU_API_KEY'], mycli: ['MY_KEY'], codex: [] });
    expect(config.agentSignatures).toEqual([MINE]);
  });

  it('drops only the entry that is wrong, and keeps the signatures', () => {
    const { config, problems } = parseDaemonConfig({
      agents: {
        signatures: [MINE],
        passEnv: { qoder: ['GOOD', 'not a name', 7], nobody: ['X'], codex: 'CODEX_KEY', opencode: ['OC_KEY'] },
      },
    });
    expect(config.agentSignatures).toEqual([MINE]);
    expect(config.agentPassEnv).toEqual({ qoder: ['GOOD'], opencode: ['OC_KEY'] });
    const text = problems.join(' | ');
    expect(text).toContain('agents.passEnv.qoder: ignoring entries that are not variable names');
    expect(text).toContain('agents.passEnv names nobody, which has no agent signature');
    expect(text).toContain('agents.passEnv.codex must be a list of variable names');
  });

  it('reports a passEnv that is not an object, passes none, and keeps the signatures', () => {
    const { config, problems } = parseDaemonConfig({ agents: { signatures: [MINE], passEnv: ['QODER_TOKEN'] } });
    expect(config.agentPassEnv).toBeUndefined();
    expect(config.agentSignatures).toEqual([MINE]);
    expect(problems.join(' ')).toMatch(/agents\.passEnv must be an object/);
  });

  it('never takes a key named __proto__ for an agent', () => {
    const { config } = parseDaemonConfig(JSON.parse('{"agents":{"passEnv":{"__proto__":["X"],"qoder":["Q"]}}}'));
    expect(config.agentPassEnv).toEqual({ qoder: ['Q'] });
    expect(Object.getPrototypeOf(config.agentPassEnv)).toBe(Object.prototype);
  });
});

describe('the variables a caller may name at start (envNames)', () => {
  it('reads the names the human allows to be passed', () => {
    const { config, problems } = parseDaemonConfig({ envNames: ['OPENCODE_API_KEY', 'OTHER_KEY'] });
    expect(problems).toEqual([]);
    expect(config.envNames).toEqual(['OPENCODE_API_KEY', 'OTHER_KEY']);
  });

  it('drops entries that are not variable names, and says so', () => {
    const { config, problems } = parseDaemonConfig({ envNames: ['GOOD_KEY', 'BAD-KEY', 7, '', '__proto__'] });
    expect(config.envNames).toEqual(['GOOD_KEY']);
    expect(problems).toEqual(['envNames: ignoring entries that are not variable names']);
  });

  it('passes nothing when envNames is not a list, and says so', () => {
    const { config, problems } = parseDaemonConfig({ envNames: 'OPENCODE_API_KEY' });
    expect(config.envNames).toBeUndefined();
    expect(problems).toEqual(['envNames must be an array of variable names: passing none']);
  });

  it('reads no names from mcp.passEnv, and says in one line that the list is read from envNames', () => {
    const { config, problems } = parseDaemonConfig({ mcp: { untrustedFraming: true, passEnv: ['NPM_TOKEN'] } });
    expect(problems).toEqual([
      'mcp.passEnv is not read, so nothing passes from it: the variables a caller may name at start ' +
        'are read from envNames, at the top level of config.json',
    ]);
    expect(config.envNames).toBeUndefined();
  });

  it('passes only what envNames lists when mcp.passEnv is there too', () => {
    const { config, problems } = parseDaemonConfig({ envNames: ['A_KEY'], mcp: { passEnv: ['B_KEY'] } });
    expect(config.envNames).toEqual(['A_KEY']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^mcp\.passEnv is not read/);
    expect(isEnvNamesProblem(problems[0]!)).toBe(true);
  });
});

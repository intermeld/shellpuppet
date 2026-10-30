/**
 * Which configuration problems the clients report beside a refusal, and that
 * the two about config `envNames` say they mean the config key (the
 * `terminal_start` parameter shares the name). Parser checks; no daemon.
 */

import { describe, expect, it } from 'vitest';
import { isEnvNamesProblem, parseDaemonConfig } from '../../src/daemon/config.js';

describe('config envNames problems', () => {
  it('counts the not-a-list problem as an envNames problem', () => {
    const { problems } = parseDaemonConfig({ envNames: 'SP_TEST_A' });
    expect(problems).toHaveLength(1);
    expect(isEnvNamesProblem(problems[0]!)).toBe(true);
  });

  it('counts the bad-entries problem as an envNames problem', () => {
    const { problems } = parseDaemonConfig({ envNames: ['SP_TEST_A', 'BAD-NAME'] });
    expect(problems).toHaveLength(1);
    expect(isEnvNamesProblem(problems[0]!)).toBe(true);
  });

  it('does not count an agents problem or an unknown key as an envNames problem', () => {
    const { problems } = parseDaemonConfig({ agents: { passEnv: ['X'] }, envnames: ['X'] });
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) expect(isEnvNamesProblem(problem)).toBe(false);
  });
});

describe('config envNames: the old key and odd shapes', () => {
  it('reports mcp.passEnv even when it is null, and passes nothing from it', () => {
    const { config, problems } = parseDaemonConfig({ mcp: { passEnv: null } });
    expect(problems).toHaveLength(1);
    expect(isEnvNamesProblem(problems[0]!)).toBe(true);
    expect(config.envNames).toBeUndefined();
  });

  it('accepts an empty envNames with no problem', () => {
    const { config, problems } = parseDaemonConfig({ envNames: [] });
    expect(problems).toEqual([]);
    expect(config.envNames).toEqual([]);
  });

  it('passes nothing from the old key when envNames is empty', () => {
    const { config, problems } = parseDaemonConfig({ envNames: [], mcp: { passEnv: ['SP_TEST_A'] } });
    expect(config.envNames).toEqual([]);
    expect(problems).toHaveLength(1);
  });
});

describe('config envNames problems name the config key', () => {
  it('the not-a-list problem says it is about config.json', () => {
    const { problems } = parseDaemonConfig({ envNames: 'SP_TEST_A' });
    expect(problems[0]).toMatch(/config\.json/);
  });

  it('the bad-entries problem says it is about config.json', () => {
    const { problems } = parseDaemonConfig({ envNames: ['SP_TEST_A', 'BAD-NAME'] });
    expect(problems[0]).toMatch(/config\.json/);
  });

  it('a file that does not parse counts as an envNames problem', () => {
    expect(isEnvNamesProblem('config.json is not valid JSON (Unexpected token): refusing all commands')).toBe(true);
  });
});

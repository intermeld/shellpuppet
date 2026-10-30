/**
 * The shared resolver both clients pass variables by (design §4.6): an agent
 * session gets its agent's list and nothing else, any other session only the
 * names it asked for that the ad hoc list holds.
 */

import { describe, expect, it } from 'vitest';
import { planPassedEnv } from '../../src/mcp/config.js';

const environment = { A_KEY: 'a', B_KEY: 'b', ADHOC_KEY: 'h' };
const base = {
  agentLists: { qoder: ['A_KEY', 'UNSET_KEY'], codex: [] as string[] },
  adHoc: ['ADHOC_KEY', 'A_KEY'],
  environment,
  source: 'here',
};

describe('planPassedEnv', () => {
  it('gives an agent session its list, unasked, and reports a listed name not set', () => {
    const plan = planPassedEnv({ ...base, agent: 'qoder', requested: [] });
    expect(plan.env).toEqual({ A_KEY: 'a' });
    expect(plan.notes).toEqual(['Passed for qoder from here: A_KEY.', 'Listed for qoder but not set in here, so not passed: UNSET_KEY.']);
    expect(plan.refused).toEqual([]);
    expect(plan.refusedForAgent).toEqual([]);
  });

  it('gives an agent with no entry nothing, even names the ad hoc list holds', () => {
    const plan = planPassedEnv({ ...base, agent: 'grok', requested: [] });
    expect(plan.env).toEqual({});
    expect(plan.notes).toEqual([]);
  });

  it('refuses a name asked for beyond the agent\'s list, even one on the ad hoc list', () => {
    const plan = planPassedEnv({ ...base, agent: 'qoder', requested: ['ADHOC_KEY', 'A_KEY'] });
    expect(plan.refusedForAgent).toEqual(['ADHOC_KEY']);
  });

  it('gives a session that runs as no agent only the asked-for names on the ad hoc list', () => {
    const plan = planPassedEnv({ ...base, agent: null, requested: ['ADHOC_KEY'] });
    expect(plan.env).toEqual({ ADHOC_KEY: 'h' });
    expect(planPassedEnv({ ...base, agent: null, requested: [] }).env).toEqual({});
    expect(planPassedEnv({ ...base, agent: null, requested: ['B_KEY'] }).refused).toEqual(['B_KEY']);
  });

  it('takes no list from the object prototype for an agent named like one of its properties', () => {
    for (const agent of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      const plan = planPassedEnv({ ...base, agent, requested: [] });
      expect(plan.env, agent).toEqual({});
      expect(planPassedEnv({ ...base, agent, requested: ['A_KEY'] }).refusedForAgent, agent).toEqual(['A_KEY']);
    }
  });
});

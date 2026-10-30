/**
 * What daemon.log says when a signature runs past the regular-expression
 * time budget on a screen and is set aside for a minute. An entry from config
 * is a problem its author can fix; a built-in signature is not anybody's to
 * change, so its line is not a CONFIG PROBLEM and asks nothing of the reader.
 */

import { describe, expect, it } from 'vitest';
import { signatureOverBudgetLog } from '../../src/daemon/config.js';

describe('the log line for a signature that ran past its budget', () => {
  it('is a CONFIG PROBLEM that asks its author to simplify an entry from config', () => {
    expect(signatureOverBudgetLog('dialog', 'Example CLI', false)).toEqual({
      message: 'CONFIG PROBLEM',
      meta: {
        problem:
          'the "Example CLI" dialog signature ran past the regular-expression time budget on a screen ' +
          'and is set aside for a minute at a time; if it keeps happening, simplify its patterns',
      },
    });
    expect(signatureOverBudgetLog('agent', 'demo', false).meta).toEqual({
      problem:
        'the "demo" agent signature ran past the regular-expression time budget on a screen ' +
        'and is set aside for a minute at a time; if it keeps happening, simplify its patterns',
    });
  });

  it('for a built-in signature, of either kind, is no config problem and has nothing to change', () => {
    for (const kind of ['dialog', 'agent'] as const) {
      const line = signatureOverBudgetLog(kind, 'claude', true);
      expect(line.message).toBe('signature set aside');
      expect(line.meta).toEqual({
        signature: 'claude',
        note:
          `the built-in "claude" ${kind} signature ran past the regular-expression time budget on a ` +
          'screen, as a busy machine can make it do; it is tried again in a minute, and there is nothing to change',
      });
    }
  });
});

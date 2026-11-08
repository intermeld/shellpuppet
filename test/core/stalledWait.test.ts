import { expect, it } from 'vitest';
import { waitFor } from '../../src/core/waiter.js';
import type { WaitTarget } from '../../src/core/waiter.js';

it('keeps terminal text out of a stalled-only wait even when it times out', async () => {
  const target: WaitTarget = {
    getScreen: () => 'Transcript content is not stall metadata.',
    lastChangeAt: () => Date.now(), isExited: () => false, hasPainted: () => true,
    lastInput: () => null, observePrompt: () => undefined, isStalePrompt: () => false,
  };
  expect(await waitFor(target, { stalled: true }, { timeout: 0 }))
    .toMatchObject({ matched: false, reason: 'timeout', screen: '' });
});

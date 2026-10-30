import { describe, expect, it } from 'vitest';
import { NULL_LOGGER, howSessionEnded, listedState } from '../../src/core/types.js';

describe('NULL_LOGGER', () => {
  it('accepts every level and discards silently', () => {
    expect(NULL_LOGGER.debug('x')).toBeUndefined();
    expect(NULL_LOGGER.info('x', { meta: 1 })).toBeUndefined();
    expect(NULL_LOGGER.warn('x')).toBeUndefined();
    expect(NULL_LOGGER.error('x')).toBeUndefined();
  });
});

describe("how a session's end reads", () => {
  it('names an exit by its code, and an end with no code by its failed output', () => {
    expect(howSessionEnded(0)).toBe('code 0');
    expect(howSessionEnded(3)).toBe('code 3');
    expect(howSessionEnded(null)).toBe('its output failed');
  });

  it('lists a session as live, exited with its code, or ended because its output failed', () => {
    expect(listedState({ exited: false, exitCode: null })).toBe('live');
    expect(listedState({ exited: true, exitCode: 7 })).toBe('exited(7)');
    expect(listedState({ exited: true, exitCode: null })).toBe('ended(output failed)');
  });
});

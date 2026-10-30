import { describe, expect, it } from 'vitest';
import { NULL_LOGGER } from '../../src/core/types.js';

describe('NULL_LOGGER', () => {
  it('accepts every level and discards silently', () => {
    expect(NULL_LOGGER.debug('x')).toBeUndefined();
    expect(NULL_LOGGER.info('x', { meta: 1 })).toBeUndefined();
    expect(NULL_LOGGER.warn('x')).toBeUndefined();
    expect(NULL_LOGGER.error('x')).toBeUndefined();
  });
});

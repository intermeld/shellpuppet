import { describe, expect, it } from 'vitest';

async function parse(expression: string) {
  const { parseCron } = await import('../../src/core/cron.js');
  return parseCron(expression);
}

describe('UTC cron', () => {
  it.each([
    ['*/15 9-17/2 * * 1-5', '2026-11-20T17:45:19Z', '2026-11-23T09:00:00Z'],
    ['2,7-11/2 0 1 1,6 *', '2026-06-01T00:07:00Z', '2026-06-01T00:09:00Z'],
    ['0 0 29 2 *', '2096-02-29T00:00:00Z', '2104-02-29T00:00:00Z'],
    ['0 0 13 * 5', '2026-11-13T00:00:00Z', '2026-11-20T00:00:00Z'],
    ['0 0 13 * 5', '2026-12-12T00:00:00Z', '2026-12-13T00:00:00Z'],
    ['0 0 * * 7', '2026-11-21T23:59:59Z', '2026-11-22T00:00:00Z'],
  ])('finds the next minute for %s after %s', async (expression, after, next) => {
    const cron = (await parse(expression))!;
    expect(cron.next(new Date(after))?.toISOString()).toBe(new Date(next).toISOString());
    expect(cron.matches(new Date(next))).toBe(true);
  });

  it.each(['* * * *', '0 0 * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *',
    '* * * 13 *', '* * * * 8', '5-2 * * * *', '*/0 * * * *', '1,,2 * * * *',
    '1/2/3 * * * *', '* * * * fri', '0 0 ? * *', '@hourly', '1.5 * * * *'])(
    'rejects %s', async expression => expect(await parse(expression)).toBeNull());

  it('terminates for an impossible calendar date', async () => {
    expect((await parse('0 0 30 2 *'))!.next(new Date('2026-01-01T00:00:00Z'))).toBeNull();
  });
});

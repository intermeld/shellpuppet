import { describe, expect, it } from 'vitest';
import { decisionStall } from './decision-stall.js';

describe.each([
  ['native clear', 0, 1500],
  ['occupancy placement', 2517, 3000],
  ['leading notice', 1700, 2500],
  ['Auto fit take', 1000, 4000],
])('%s retry attribution', (_name, start, end) => {
  it('rejects a measured gap before or after the decision interval', () => {
    expect(decisionStall([{ from: start - 700, to: start - 100, gap: 600 }], 1, start, end)).toBeNull();
    expect(decisionStall([{ from: end + 100, to: end + 700, gap: 600 }], 1, start, end)).toBeNull();
  });

  it('fails inconclusive without two delivered frames or independent lag samples', () => {
    expect(decisionStall([], 0, start, end)).toBe('inconclusive');
  });

  it('attributes a measured overlapping gap', () => {
    const gap = { from: start - 100, to: start + 500, gap: 600 };
    expect(decisionStall([gap], 1, start, end)).toEqual(gap);
  });
});

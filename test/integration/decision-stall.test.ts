import { describe, expect, it } from 'vitest';
import { decisionStall, deliveredPairs } from './decision-stall.js';

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

describe('delivered frame pairs in a decision interval', () => {
  it('ignores a pair that starts before the interval', () => {
    // Arrival at 1,000 ms; the last frame before it at 400 ms; one frame after it at 1,001 ms.
    expect(deliveredPairs([400, 1001], 1000, 4000)).toBe(0);
    expect(decisionStall([{ from: 400, to: 1001, gap: 601 }], deliveredPairs([400, 1001], 1000, 4000), 1000, 4000))
      .toBe('inconclusive');
  });

  it('counts pairs whose frames both fall inside the interval', () => {
    expect(deliveredPairs([400, 1001, 1600, 2400, 4200], 1000, 4000)).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import { assessDeliveredCadence } from './noticeCadence.js';
import type { DeliveredCadence } from './noticeCadence.js';

describe('delivered rest frame', () => {
  it('rejects the missed first frame in the recorded 80x24 equal PTY leg', () => {
    // Extracted from a captured 80x24 equal PTY cadence.
    const cadence: DeliveredCadence = {
      end: 5938.1,
      legs: [{ row: 0, start: 4818.9, end: 5938.1, top: true, bottom: false }],
      samples: [
        { time: 5819.2, row: 0, side: 'top', leg: 0, deadline: false, covered: true },
        { time: 5822.1, row: 0, side: 'top', leg: 0, deadline: true, covered: true },
        { time: 5838.5, row: 0, side: 'bottom', leg: 0, deadline: false, covered: false, evaluation: true },
      ],
    };
    expect(assessDeliveredCadence(cadence).violations).toEqual([
      expect.objectContaining({ rule: 'rest clears on first completed frame at or after deadline' }),
    ]);
    cadence.samples[1] = { ...cadence.samples[1]!, side: 'bottom', covered: false };
    expect(assessDeliveredCadence(cadence).violations).toEqual([]);
  });

  it('keeps a complete in-band prefix as a possible deadline veto', () => {
    const rows: [number, number, number, boolean, boolean][] = [
      [22, 0, 500, false, true], [0, 500, 1000, true, false],
      [22, 1000, 1500, false, true], [8, 1500, 1700, false, false],
      [22, 1700, 2200, false, true], [8, 2200, 2300, false, false],
      [22, 2300, 2800, false, true],
    ];
    const cadence: DeliveredCadence = {
      end: 2800,
      legs: rows.map(([row, start, end, top, bottom]) => ({ row, start, end, top, bottom })),
      samples: [
        { time: 0, row: 22, side: 'bottom', leg: 0, deadline: false, covered: true },
        { time: 2600, row: 22, side: 'bottom', leg: 6, deadline: false,
          covered: true, evaluation: true },
      ],
    };
    const result = assessDeliveredCadence(cadence);
    expect(result.repaints[0]?.target).toBe('top');
    expect(result.violations).toEqual([]);
  });

  it('keeps an equal cycle across a long uncovered leg', () => {
    const rows: [number, number, number, boolean, boolean][] = [
      [0, 0, 900, true, false], [50, 900, 1800, false, false],
      [148, 1800, 2700, false, true], [0, 2700, 3600, true, false],
      [50, 3600, 5200, false, false], [148, 5200, 6100, false, true],
      [50, 6100, 7000, false, false], [148, 7000, 7950, false, true],
    ];
    const cadence: DeliveredCadence = {
      end: 7950,
      legs: rows.map(([row, start, end, top, bottom]) => ({ row, start, end, top, bottom })),
      samples: [
        { time: 0, row: 0, side: 'bottom', leg: 0, deadline: false, covered: false },
        { time: 7940, row: 148, side: 'bottom', leg: 7, deadline: false,
          covered: true, evaluation: true },
      ],
    };
    expect(assessDeliveredCadence(cadence).violations).toEqual([]);
  });
});

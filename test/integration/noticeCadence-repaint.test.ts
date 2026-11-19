import { describe, expect, it } from 'vitest';
import { assessDeliveredCadence, type DeliveredCadence } from './noticeCadence.js';

type Visit = [row: number, start: number];
type Observation = [time: number, side: 'top' | 'bottom'];

function assess(visits: Visit[], end: number, observations: Observation[]) {
  const legs = visits.map(([row, start], index) => ({
    row, start, end: visits[index + 1]?.[1] ?? end, top: row <= 2, bottom: row >= 22,
  }));
  const samples: DeliveredCadence['samples'] = observations.map(([time, side]) => {
    const leg = legs.findIndex(visit => visit.start <= time && time < visit.end);
    const visit = legs[leg]!;
    return { time, side, leg, row: visit.row, covered: visit[side], deadline: false, evaluation: true };
  });
  return assessDeliveredCadence({ legs, samples, end });
}

describe('clear-edge evidence after a rest', () => {
  // The recorded lower rectangle remains occupied across two short row visits.
  const lower: Visit[] = [[23, 11807.6], [22, 12862.7], [23, 13608.4]];

  it('starts fresh when the recorded long word leaves the lower rectangle', () => {
    const result = assess([...lower, [0, 14508.6], [1, 15410.1], [2, 16310.2]], 17211.2,
      [[14508.6, 'top'], [15407.7, 'top'], [15512.6, 'bottom']]);
    expect(result.violations).toEqual([]);
  });

  it('rejects a missed deadline after enough fresh repaint evidence', () => {
    const visits: Visit[] = [...lower, [0, 14508.6], [8, 15208.6], [0, 15308.6], [8, 16008.6],
      [0, 16108.6], [8, 16808.6], [0, 16908.6]];
    const result = assess(visits, 17608.6, [[14508.6, 'top'], [17007.6, 'top'], [17009.6, 'top']]);
    expect(result.violations).toEqual([
      { rule: 'first eligible clear-edge deadline', target: 'bottom', clearBy: 17008.6, first: 17009.6 },
    ]);
  });

  it('requires 1.2 seconds of fresh evidence for a repaint after the rest', () => {
    const visits: Visit[] = [...lower, [0, 14508.6], [8, 15208.6]];
    const at = (time: number) => assess(visits, 15808.6, [[14508.6, 'top'], [time, 'bottom']]).violations;
    expect(at(15707.6)).toEqual([expect.objectContaining({ rule: 'fresh startup evidence after a rectangle rest' })]);
    expect(at(15708.6)).toEqual([]);
  });

  it('ends a genuine rest on the first delivered move outside the rectangle', () => {
    const visits: Visit[] = [[0, 0], [8, 1300], [1, 1300.5], [8, 1900], [0, 2100]];
    const result = assess(visits, 2400, [[0, 'bottom']]);
    expect(result.rests).toMatchObject([{ edge: 'top', start: 0, end: 1300 }]);
    expect(result.repaints.at(-1)?.start).toBe(1300);
  });
});

describe('repaint spacing on uncovered rows', () => {
  // The recorded changing word held row 9 for 1112.5 ms. Its move to
  // the bottom at 14503 ms left the cursor clear on that neutral row.
  const visits: Visit[] = [[8, 13502.3], [9, 14384.5], [10, 15497], [11, 16381.3],
    [12, 17310.5], [0, 18234.5], [22, 18424.5]];
  const move: Observation[] = [[14384.5, 'top'], [14503, 'bottom']];

  it('allows the recorded repaint to keep its edge through the next clear-edge deadline', () => {
    expect(assess(visits, 19376.8, [...move, [19037.6, 'bottom']]).violations).toEqual([]);
  });

  it('rejects a second repaint during the ten seconds spent on the uncovered row', () => {
    expect(assess(visits, 19376.8, [...move, [19037.6, 'top']]).violations).toMatchObject([
      { rule: 'one repaint change per ten seconds', previous: { time: 14503 }, current: { time: 19037.6 } },
    ]);
  });
});

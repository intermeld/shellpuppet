/** Judge delivered visits and actual rectangles, including mixed runs. */
import * as fs from 'node:fs';
import * as path from 'node:path';
export const deliveredNoticeScript = fs.readFileSync(new URL('../fixtures/notice-delivered-browser.js', import.meta.url), 'utf8');
export interface DeliveredCadence {
  end: number; epoch?: number; cycleRows?: number[];
  legs: { row: number; start: number; end: number; top: boolean; bottom: boolean }[];
  samples: { time: number; row: number; side: string; leg: number; deadline: boolean; covered: boolean;
    evaluation?: boolean; frameTime?: number }[];
}
interface RepaintAssessment {
  start: number; end: number; top: number; bottom: number; target: string | null;
  firstCycle: number | null; clearBy: number; changes: number;
}
export function clearEdge(top: number, bottom: number, guard = 0): string | null {
  return top + guard <= bottom * 2 / 3 && bottom - top >= 20 ? 'top' :
    bottom + guard <= top * 2 / 3 && top - bottom >= 20 ? 'bottom' : null;
}
function guardedCycleEdge(weights: { top: number; bottom: number }, duration: number): string | null {
  const scale = Math.max(1, 1200 / Math.max(1, duration));
  return clearEdge(weights.top * scale, weights.bottom * scale, 5);
}
export function deliveredWeights(legs: DeliveredCadence['legs'], start: number, end: number) {
  let top = 0, bottom = 0;
  for (const leg of legs) {
    const duration = Math.max(0, Math.min(end, leg.end) - Math.max(start, leg.start));
    if (leg.top) top += duration;
    if (leg.bottom) bottom += duration;
  }
  return { top, bottom };
}
export function deliveredChanges(cadence: DeliveredCadence) {
  const changes: (DeliveredCadence['samples'][number] & { earliest: number })[] = [];
  let previous = cadence.samples[0];
  for (const sample of cadence.samples) {
    if (previous && sample.side !== previous.side) changes.push({ ...sample, earliest: previous.time });
    previous = sample;
  }
  return changes;
}

function cycleSummaries(legs: DeliveredCadence['legs'], restEnds: Set<number>) {
  type Summary = { end: number; duration: number; validFor: number; edge: string | null; rows: number[] };
  const renewals: Summary[] = [];
  let active: Summary | undefined;
  let anchorStart = -1;
  for (const [i, leg] of legs.entries()) {
    if (restEnds.has(leg.start)) { anchorStart = -1; active = undefined; }
    if (anchorStart < 0) {
      if (leg.top || leg.bottom) anchorStart = i;
      continue;
    }
    if (leg.row !== legs[anchorStart]!.row) continue;
    // A return can be internal to a longer word. Once two identical words
    // close, the latest occurrence supplies all the weights for its renewal.
    const half = (i - anchorStart) / 2;
    if (Number.isInteger(half) && legs.slice(anchorStart, anchorStart + half)
      .every((visit, j) => visit.row === legs[anchorStart + half + j]!.row)) anchorStart += half;
    const word = legs.slice(anchorStart, i);
    const start = word[0]!.start, end = leg.start, duration = end - start;
    const weights = deliveredWeights(word, start, end);
    if (weights.top <= 0 || weights.bottom <= 0) continue;
    const rows = word.map(visit => visit.row);
    const previousRows = active?.rows;
    const sameWord = rows.length === previousRows?.length && rows.every((row, j) => row === previousRows[j]);
    if (active && !sameWord && end - active.end < active.validFor && duration < active.duration) continue;
    const longest = Math.max(...word.map(visit => visit.end - visit.start));
    active = { end, rows, duration, validFor: Math.max(10000, duration + longest), edge: guardedCycleEdge(weights, duration) };
    renewals.push(active);
  }
  return renewals.reverse();
}

export function assessDeliveredCadence(cadence: DeliveredCadence) {
  const violations: unknown[] = [], rests: unknown[] = [], repaints: RepaintAssessment[] = [];
  const historyStart = cadence.legs[0]?.start ?? 0;
  const changes = deliveredChanges(cadence);
  const between = (start: number, end: number) => changes.filter(change => change.time >= start && change.time < end);
  const runs: { edge: string; start: number; end: number }[] = [];
  let currentRun: typeof runs[number] | undefined;
  for (const leg of cadence.legs) {
    const edge = leg.top ? 'top' : leg.bottom ? 'bottom' : null;
    if (!edge) {
      currentRun = undefined;
    } else if (currentRun?.edge === edge && Math.abs(currentRun.end - leg.start) < 1) {
      currentRun.end = leg.end;
    } else {
      currentRun = { edge, start: leg.start, end: leg.end };
      runs.push(currentRun);
    }
  }
  const rectangleRests = runs.filter(run => run.end - run.start >= 1000);
  const restEnds = new Set(rectangleRests.map(run => run.end));
  const summaries = cycleSummaries(cadence.legs, restEnds);
  const restChange = (change: typeof changes[number]) => rectangleRests.some(run =>
    change.time >= run.start && change.time < run.end && change.side !== run.edge);
  const evidenceStart = (time: number, start: number) => Math.max(start,
    ...rectangleRests.filter(run => run.end <= time).map(run => run.end));
  for (const run of rectangleRests) {
    const runChanges = between(run.start, run.end);
    if (runChanges.length > 1) violations.push({ rule: 'one change per rectangle rest', run, changes: runChanges });
    const frames = cadence.samples.filter(sample => sample.deadline &&
      (sample.frameTime ?? sample.time) >= run.start + 1000 && sample.time < run.end);
    const firstEligible = frames[0];
    // The rest must outlast that frame for its placement to be observable:
    // a rest that ends before the next delivered frame cannot show a clear.
    const outlasted = firstEligible !== undefined &&
      cadence.samples.some(sample => sample.time > firstEligible.time && sample.time < run.end);
    if (firstEligible?.covered && outlasted) violations.push({ rule: 'rest clears on first completed frame at or after deadline', run, frame: firstEligible });
    rests.push({ ...run, duration: run.end - run.start, changes: runChanges.length, deadline: frames[0]?.time });
  }
  const repaintChanges = changes.filter(change => {
    const leg = cadence.legs[change.leg];
    if (!leg || restChange(change)) return false;
    return (!leg.top && !leg.bottom) || leg.end - leg.start < 1000;
  });
  for (const change of repaintChanges) {
    const start = evidenceStart(change.time, historyStart);
    if (start > historyStart && change.time - start < 1200) {
      violations.push({ rule: 'fresh startup evidence after a rectangle rest', start, change });
    }
  }
  for (let i = 1; i < repaintChanges.length; i++) {
    const current = repaintChanges[i]!, previous = repaintChanges[i - 1]!;
    // Observation brackets bound actual changes, without a timing allowance.
    if (current.time - previous.earliest < 10000) violations.push({ rule: 'one repaint change per ten seconds', previous, current });
  }
  for (const change of changes) {
    const leg = cadence.legs[change.leg];
    if (change.covered || (leg && (change.side === 'top' ? leg.top : leg.bottom))) violations.push({ rule: 'no move lands on the cursor', change });
  }
  const inspectRepaint = (legs: DeliveredCadence['legs']) => {
    if (!legs.length) return;
    const start = legs[0]!.start, end = legs.at(-1)!.end;
    const returns: number[] = [];
    if (cadence.cycleRows?.length) {
      const word = cadence.cycleRows;
      let index = 0, candidate = 0;
      for (const leg of legs) {
        if (leg.row !== word[index]) index = 0;
        if (leg.row !== word[index]) continue;
        if (index === 0) candidate = leg.start;
        index++;
        if (index === word.length) { returns.push(candidate); index = 0; }
      }
      if (index > 0 && candidate > (returns.at(-1) ?? -Infinity)) returns.push(candidate);
    } else returns.push(...legs.filter(leg => leg.row === legs[0]!.row).map(leg => leg.start));
    const completeEnd = returns.length > 1 ? returns.at(-1)! : end;
    const weights = deliveredWeights(legs, returns.length > 1 ? returns[0]! : start, completeEnd);
    const target = clearEdge(weights.top, weights.bottom);
    const firstCycle = returns[1] === undefined ? null : returns[1] - start;
    const clearBy = start + (firstCycle !== null && firstCycle > 2500 ? firstCycle + 250 : 2500);
    for (const [i, cycleStart] of returns.entries()) {
      const cycleEnd = returns[i + 1] ?? end;
      const count = between(cycleStart, cycleEnd).filter(change => !restChange(change)).length;
      if (count > 1) violations.push({ rule: 'one change per delivered cycle', cycleStart, cycleEnd, changes: count });
    }
    const localChanges = between(start, end).filter(change => !restChange(change));
    for (const change of localChanges) {
      const times = [change.earliest, change.time, ...legs.flatMap(leg => [leg.start, leg.end])
        .filter(time => time >= change.earliest && time <= change.time)];
      if (!times.some(time => {
        const whole = deliveredWeights(cadence.legs,
          Math.max(evidenceStart(time, historyStart), time - 10000), time);
        return clearEdge(whole.top, whole.bottom) === change.side;
      })) violations.push({ rule: 'whole retained history must clearly favour a repaint change', change });
    }
    const firstChange = localChanges[0]?.time ?? Infinity;
    const prior = repaintChanges.filter(change => change.time < start).at(-1);
    const wrong = cadence.samples.find(sample => {
      if (!sample.evaluation || sample.time < clearBy || sample.time >= Math.min(end, firstChange)) return false;
      if (prior && sample.time - prior.time < 10000) return false;
      const leg = cadence.legs[sample.leg];
      const destination = sample.side === 'top' ? 'bottom' : 'top';
      if (!leg || (destination === 'top' ? leg.top : leg.bottom)) return false;
      const whole = deliveredWeights(cadence.legs,
        Math.max(evidenceStart(sample.time, historyStart), sample.time - 10000), sample.time);
      // Only evidence already delivered can require a move at this evaluation.
      if (clearEdge(whole.top, whole.bottom, 5) !== destination) return false;
      const active = summaries.find(summary => summary.end <= sample.time);
      return !active || active.end < evidenceStart(sample.time, historyStart) ||
        sample.time - active.end >= active.validFor || active.edge === destination;
    });
    if (wrong) violations.push({ rule: 'first eligible clear-edge deadline',
      target: wrong.side === 'top' ? 'bottom' : 'top', clearBy, first: wrong.time });
    repaints.push({ start, end, ...weights, target, firstCycle, clearBy, changes: localChanges.length });
  };
  let shortLegs: DeliveredCadence['legs'] = [];
  for (const leg of cadence.legs) {
    if (restEnds.has(leg.start)) {
      // A row change within the same rectangle does not end the rest.
      inspectRepaint(shortLegs);
      shortLegs = [];
    }
    const count = between(leg.start, leg.end).length;
    if (count > 1) violations.push({ rule: 'one change per delivered leg', start: leg.start, changes: count });
    const duration = leg.end - leg.start;
    if (duration < 1000) { shortLegs.push(leg); continue; }
    inspectRepaint(shortLegs); shortLegs = [];
    // A long row outside either rectangle has no notice to clear. Rectangle
    // stays, including stays across adjacent rows, are assessed above.
  }
  inspectRepaint(shortLegs);
  return { violations, rests, repaints, legs: cadence.legs, changes, repaintChanges };
}
export function recordDeliveredCadence(name: string, cadence: DeliveredCadence): void {
  const directory = process.env['NOTICE_EVIDENCE_DIR'];
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify({ cadence, assessment: assessDeliveredCadence(cadence) }));
}

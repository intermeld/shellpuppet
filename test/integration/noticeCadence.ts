/** Judge delivered visits and actual rectangles, including mixed runs. */
import * as fs from 'node:fs';
import * as path from 'node:path';
export const deliveredNoticeScript = fs.readFileSync(new URL('../fixtures/notice-delivered-browser.js', import.meta.url), 'utf8');
export interface DeliveredCadence {
  end: number; cycleRows?: number[];
  legs: { row: number; start: number; end: number; top: boolean; bottom: boolean }[];
  samples: { time: number; row: number; side: string; leg: number; deadline: boolean; covered: boolean; evaluation?: boolean }[];
}
interface RepaintAssessment {
  start: number; end: number; top: number; bottom: number; target: string | null;
  firstCycle: number | null; clearBy: number; changes: number;
}
export function clearEdge(top: number, bottom: number): string | null {
  return top <= bottom * 2 / 3 && bottom - top >= 20 ? 'top' :
    bottom <= top * 2 / 3 && top - bottom >= 20 ? 'bottom' : null;
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
export function assessDeliveredCadence(cadence: DeliveredCadence) {
  const violations: unknown[] = [], rests: unknown[] = [], repaints: RepaintAssessment[] = [];
  const historyStart = cadence.legs[0]?.start ?? 0;
  const retainedSummaries: { end: number; edge: string | null; validFor: number }[] = [];
  const changes = deliveredChanges(cadence);
  const between = (start: number, end: number) => changes.filter(change => change.time >= start && change.time < end);
  const runs: { edge: string; start: number; end: number }[] = [];
  for (const leg of cadence.legs) {
    const edge = leg.top ? 'top' : leg.bottom ? 'bottom' : null;
    if (!edge) continue;
    const previous = runs.at(-1);
    if (previous?.edge === edge && Math.abs(previous.end - leg.start) < 1) previous.end = leg.end;
    else runs.push({ edge, start: leg.start, end: leg.end });
  }
  const rectangleRests = runs.filter(run => run.end - run.start >= 1000);
  const restChange = (change: typeof changes[number]) => rectangleRests.some(run =>
    change.time >= run.start && change.time < run.end && change.side !== run.edge);
  const evidenceStart = (time: number, start: number) => Math.max(start,
    ...rectangleRests.filter(run => run.end <= time).map(run => run.end));
  for (const run of rectangleRests) {
    const runChanges = between(run.start, run.end);
    if (runChanges.length > 1) violations.push({ rule: 'one change per rectangle rest', run, changes: runChanges });
    const frames = cadence.samples.filter(sample => sample.deadline && sample.time >= run.start + 1000 && sample.time < run.end);
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
    return leg && leg.end - leg.start < 1000 && !restChange(change);
  });
  for (let i = 1; i < repaintChanges.length; i++) {
    const current = repaintChanges[i]!, previous = repaintChanges[i - 1]!;
    // Observation brackets bound actual changes, without a timing allowance.
    if (current.time - previous.earliest < 10000) violations.push({ rule: 'one repaint change per ten seconds', previous, current });
  }
  for (const change of changes) {
    const leg = cadence.legs[change.leg];
    if (leg && (change.side === 'top' ? leg.top : leg.bottom)) violations.push({ rule: 'no move lands on the cursor', change });
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
    // Any complete conflicting prefix can remain the retained summary. An
    // aggregate of later returns can look clear while that prefix still vetoes
    // a correction, so the deadline must account for each candidate.
    const summaries = returns.slice(1).flatMap(returnTime => {
      const first = returns[0]!;
      const covered = deliveredWeights(legs, first, returnTime);
      if (covered.top <= 0 || covered.bottom <= 0) return [];
      const longest = legs.reduce((length, leg) => leg.start >= first && leg.start < returnTime ?
        Math.max(length, Math.min(leg.end, returnTime) - leg.start) : length, 0);
      return [{ end: returnTime, edge: clearEdge(covered.top, covered.bottom),
        validFor: Math.max(10000, returnTime - first + longest) }];
    });
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
    if (target) {
      const firstChange = localChanges[0]?.time ?? Infinity;
      const prior = repaintChanges.filter(change => change.time < start).at(-1);
      const wrong = cadence.samples.find(sample => {
        if (sample.time < clearBy || sample.time >= Math.min(end, firstChange) || sample.side === target) return false;
        if (prior && sample.time - prior.time < 10000) return false;
        const leg = cadence.legs[sample.leg];
        if (!leg || (target === 'top' ? leg.top : leg.bottom)) return false;
        const whole = deliveredWeights(cadence.legs,
          Math.max(evidenceStart(sample.time, historyStart), sample.time - 10000), sample.time);
        const complete = returns.filter(time => time <= sample.time && time >= evidenceStart(sample.time, start));
        const cycleWeights = complete.length > 1 ? deliveredWeights(legs, complete[0]!, complete.at(-1)!) : null;
        const cycle = cycleWeights ? clearEdge(cycleWeights.top, cycleWeights.bottom) : undefined;
        const summaryVeto = [...retainedSummaries, ...summaries].some(summary => summary.end <= sample.time &&
          summary.end >= evidenceStart(sample.time, historyStart) &&
          sample.time - summary.end < summary.validFor && summary.edge !== target);
        return sample.evaluation && clearEdge(whole.top, whole.bottom) === target &&
          (cycle === undefined || cycle === target) && !summaryVeto;
      });
      if (wrong) violations.push({ rule: 'first eligible clear-edge deadline', target, clearBy, first: wrong.time });
    }
    repaints.push({ start, end, ...weights, target, firstCycle, clearBy, changes: localChanges.length });
    retainedSummaries.push(...summaries);
  };
  let shortLegs: DeliveredCadence['legs'] = [];
  for (const leg of cadence.legs) {
    const count = between(leg.start, leg.end).length;
    if (count > 1) violations.push({ rule: 'one change per delivered leg', start: leg.start, changes: count });
    const duration = leg.end - leg.start;
    if (duration < 1000) { shortLegs.push(leg); continue; }
    inspectRepaint(shortLegs); shortLegs = [];
    if (leg.top || leg.bottom) retainedSummaries.length = 0;
    // A long row outside either rectangle has no notice to clear. Rectangle
    // stays, including stays across adjacent rows, are assessed above.
  }
  inspectRepaint(shortLegs);
  return { violations, rests, repaints, legs: cadence.legs, changes };
}
export function recordDeliveredCadence(name: string, cadence: DeliveredCadence): void {
  const directory = process.env['NOTICE_EVIDENCE_DIR'];
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name + '.json'), JSON.stringify({ cadence, assessment: assessDeliveredCadence(cadence) }));
}

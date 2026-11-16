/** Attribute a failed timing decision only to a measured gap in its evidence window. */
export interface TimingGap { from: number; to: number; gap: number }

export function decisionStall(
  gaps: TimingGap[], measuredFrames: number, start: number, end: number,
): TimingGap | 'inconclusive' | null {
  if (measuredFrames < 1) return 'inconclusive';
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return gaps.find(gap => gap.gap >= 500 && gap.from < end && gap.to > start) ?? null;
}

/**
 * Frame pairs delivered entirely inside a decision interval. A pair whose earlier frame precedes the interval
 * measures time before the decision started, so it does not count towards the evidence of a stall.
 */
export function deliveredPairs(frames: readonly number[], start: number, end: number): number {
  const inside = frames.filter(time => time >= start && time <= end).length;
  return Math.max(0, inside - 1);
}

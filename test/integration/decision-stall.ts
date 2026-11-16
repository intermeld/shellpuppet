/** Attribute a failed timing decision only to a measured gap in its evidence window. */
export interface TimingGap { from: number; to: number; gap: number }

export function decisionStall(
  gaps: TimingGap[], measuredFrames: number, start: number, end: number,
): TimingGap | 'inconclusive' | null {
  if (measuredFrames < 1) return 'inconclusive';
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return gaps.find(gap => gap.gap >= 500 && gap.from < end && gap.to > start) ?? null;
}

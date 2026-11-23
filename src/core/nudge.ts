/**
 * Whether a session is quiet enough for one fixed nudge line.
 * The module's own reading, prompt detection and a stall the caller has
 * already settled each have to agree. This module types nothing.
 */
import type { AgentModule, NudgeView } from '../agents/types.js';
import { detectPrompt } from './promptDetector.js';
import type { StyledLine } from './renderer.js';
import type { StallState } from './types.js';

/** How long a ready screen must stay unchanged before it can be nudged. */
export const NUDGE_QUIET_MS = 1_500;

export type NudgeBlock = 'busy' | 'draft' | 'unknown' | 'prompt' | 'stalled' | 'quiet' | 'recent-input';

export type NudgeVerdict = { ready: true; queued?: true } | { ready: false; reason: NudgeBlock };

export interface NudgeObservation extends NudgeView {
  /** Terminal height. Clipped prompt detection needs it, so a verdict always has it. */
  viewportRows: number;
  /** A stall the session has already settled. Detection is not repeated here. */
  stall?: StallState;
  /** How long the screen has stayed unchanged, in milliseconds. */
  unchangedMs: number;
  /**
   * How long the composer and the rows under it have stayed unchanged. A running
   * turn repaints elsewhere, so a queued nudge waits on this, not the whole screen.
   */
  composerUnchangedMs?: number;
}

/**
 * One viewport for the prompt detector and the composer. Styled text wins
 * when it matches `rows`. A mismatch is refused.
 */
function viewport(observation: NudgeObservation): { rows: readonly string[]; styled?: readonly StyledLine[] } | null {
  const styled = observation.styled;
  if (styled === undefined || styled.length === 0) return { rows: observation.rows };
  if (styled.length !== observation.rows.length) return null;
  for (let i = 0; i < styled.length; i++) {
    if (styled[i]?.text !== observation.rows[i]) return null;
  }
  return { rows: styled.map((line) => line.text), styled };
}

/**
 * Ready only when the module can tell, no prompt is waiting, the session is
 * not stalled, the composer is idle and empty, and the screen has been quiet.
 * A module with no nudge judgement is unknown even if a prompt is showing.
 * The quiet period applies only once everything else says ready.
 */
export function nudgeVerdict(module: AgentModule | undefined, observation: NudgeObservation): NudgeVerdict {
  if (module?.nudge === undefined) return { ready: false, reason: 'unknown' };
  const screen = viewport(observation);
  if (screen === null) return { ready: false, reason: 'unknown' };
  const prompt = detectPrompt(screen.rows.join('\n'), module.name, observation.viewportRows, screen.styled);
  if (prompt !== null) return { ready: false, reason: 'prompt' };
  if (observation.stall !== undefined) return { ready: false, reason: 'stalled' };
  const reading = module.nudge.readiness({ rows: screen.rows, styled: screen.styled,
    cursor: observation.cursor, untrimmedRow: observation.untrimmedRow, viewportCols: observation.viewportCols,
    expectedDraft: observation.expectedDraft, recoveringDraft: observation.recoveringDraft,
    exactEmpty: observation.exactEmpty, afterSubmit: observation.afterSubmit,
    whenBusy: observation.whenBusy, queueDraft: observation.queueDraft });
  if (reading === 'queue') {
    if (observation.whenBusy === 'skip') return { ready: false, reason: 'busy' };
    if (observation.expectedDraft !== undefined) return { ready: false, reason: 'busy' };
    const quiet = observation.composerUnchangedMs;
    if (quiet === undefined || !Number.isFinite(quiet) || quiet < NUDGE_QUIET_MS) return { ready: false, reason: 'quiet' };
    return { ready: true, queued: true };
  }
  if (reading !== 'ready') return { ready: false, reason: reading };
  if (observation.expectedDraft !== undefined) return { ready: true };
  if (!Number.isFinite(observation.unchangedMs) || observation.unchangedMs < NUDGE_QUIET_MS) {
    return { ready: false, reason: 'quiet' };
  }
  return { ready: true };
}

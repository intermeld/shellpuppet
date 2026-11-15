/**
 * Whether a session is quiet enough for one fixed nudge line.
 * The module's own reading, prompt detection and a stall the caller has
 * already settled each have to agree. This module types nothing.
 */
import type { AgentModule } from '../agents/types.js';
import { detectPrompt } from './promptDetector.js';
import type { StyledLine } from './renderer.js';
import type { StallState } from './types.js';

/** How long a ready screen must stay unchanged before it can be nudged. */
export const NUDGE_QUIET_MS = 1_500;

export type NudgeBlock = 'busy' | 'draft' | 'unknown' | 'prompt' | 'stalled' | 'quiet';

export type NudgeVerdict = { ready: true } | { ready: false; reason: NudgeBlock };

export interface NudgeObservation {
  rows: readonly string[];
  styled?: readonly StyledLine[];
  /** Terminal height, when the caller knows it. Clipped panels need it. */
  viewportRows?: number;
  /** A stall the session has already settled. Detection is not repeated here. */
  stall?: StallState;
  /** How long the screen has stayed unchanged, in milliseconds. */
  unchangedMs: number;
}

/**
 * Ready only when the module can tell, no prompt is waiting, the session is
 * not stalled, the composer is idle and empty, and the screen has been quiet.
 * A module with no nudge judgement is unknown even if a prompt is showing.
 * The quiet period applies only once everything else says ready.
 */
export function nudgeVerdict(module: AgentModule | undefined, observation: NudgeObservation): NudgeVerdict {
  if (module?.nudge === undefined) return { ready: false, reason: 'unknown' };
  const screen = observation.rows.join('\n');
  const prompt = detectPrompt(screen, module.name, observation.viewportRows, observation.styled);
  if (prompt !== null) return { ready: false, reason: 'prompt' };
  if (observation.stall !== undefined) return { ready: false, reason: 'stalled' };
  const reading = module.nudge.readiness({ rows: observation.rows, styled: observation.styled });
  if (reading !== 'ready') return { ready: false, reason: reading };
  if (!Number.isFinite(observation.unchangedMs) || observation.unchangedMs < NUDGE_QUIET_MS) {
    return { ready: false, reason: 'quiet' };
  }
  return { ready: true };
}

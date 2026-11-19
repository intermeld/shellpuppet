import { submittingText } from '../input.js';

/** Muse needs a short pause after text before its submitting Enter. */
export const MUSE_SUBMIT_DELAY_MS = 400;

export function museSubmittingText(data: string): boolean {
  return submittingText(data);
}

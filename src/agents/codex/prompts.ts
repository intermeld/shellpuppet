import type { PromptShape } from '../types.js';

/**
 * `Press enter to continue` / `…to confirm or esc to cancel`: the footer
 * both Codex prompt classes draw, and a wait state in its own right on the
 * onboarding screens that have no option list at all. `Enter to confirm ·
 * Esc to cancel`, without "press", is Claude Code's.
 */
export const enterFooter: PromptShape = { kind: 'rows', footer: /(?:press\s+)?\benter to (confirm|continue|select)/i };

export const prompts: PromptShape[] = [enterFooter, {
  kind: 'rows',
  // The sign-in marker can sit against the digit without a space.
  numbered: /^\s*(?:│\s*)?›\s*(\d+)\.\s+\S/,
  marker: /›/,
}];

import type { PromptShape } from '../types.js';
import { pointerRows } from '../claude/prompts.js';
import { enterFooter } from '../codex/prompts.js';
import { radioRows } from '../grok/prompts.js';

export const prompts: PromptShape[] = [radioRows, pointerRows, enterFooter, {
  kind: 'rows',
  numbered: /^\s*(?:│\s*)?(?:>\s*)?(\d+)\.\s+\S/,
  marker: /^\s*(?:│\s*)?>\s*(?:\d+\.|[[(][a-z][\])])/i,
  busy: /(generating|thinking|running|working|waiting for response)(\.{3}|…)/i,
}];

import type { PromptShape } from '../types.js';

export const prompts: PromptShape[] = [{
  kind: 'rows', numbered: /^\s*(?:│\s*)?❯\s*(\d+)\.\s+\S/, marker: /❯/,
}];

import type { PromptShape } from '../types.js';
import { reading } from './reading.js';

export const prompts: PromptShape[] = [{
  kind: 'rows', numbered: /^\s*(?:│\s*)?❯\s*(\d+)\.\s+\S/, marker: /❯/,
  composer: new RegExp(reading.composer.text!),
}];

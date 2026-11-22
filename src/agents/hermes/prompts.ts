import type { DetectedPrompt } from '../../core/promptDetector.js';
import type { StyledLine } from '../../core/renderer.js';
import type { PromptShape } from '../types.js';

const consentFooter = '  Choice [default 2]:';

export function hasPromptFooter(rows: readonly string[]): boolean {
  return rows.at(-1)?.trimEnd() === consentFooter;
}

export function activePrompt(rows: readonly string[], styled?: readonly StyledLine[]): DetectedPrompt | null {
  if (!hasPromptFooter(rows) || !styled) return null;
  const end = rows.length - 1;
  const first = end - 6;
  if (rows[first] !== '  Help improve Hermes?' || rows[first + 1] !== '  Select by number, Enter to confirm.' ||
      rows[first + 2] !== '' || rows[first + 3] !== '  (○)  1. Share with Nous' ||
      rows[first + 4] !== '  (●)  2. No thanks' || rows[first + 5] !== '' ||
      styled[first]?.spans[0]?.fg !== 'p3' || !styled[end]?.spans[0]?.dim) return null;
  return { question: 'Help improve Hermes?', options: ['Share with Nous', 'No thanks'],
    selectedOption: 1, optionRows: [first + 3, first + 4], rows: [first, end],
    signature: rows.slice(first).join('\n'), basis: 'footer' };
}

export const prompts: PromptShape[] = [
  { kind: 'menu', order: 1, detect: (raw, _lines, _tail, _busy, _height, styled) => activePrompt(raw, styled) },
];

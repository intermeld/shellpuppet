import type { PromptShape } from '../types.js';
import { enterFooter } from '../codex/prompts.js';

/**
 * A pointer against plain text: `❯ npm`, `> minimal`. It is the
 * inquirer.js shape, and Claude Code's own folder-trust prompt. Captures
 * indent, pointer and text. `›` is deliberately absent: Codex draws it on
 * its composer line, and every `›` chooser seen so far numbers its rows.
 */
export const pointerRows: PromptShape = { kind: 'rows', pointer: /^(\s*)([❯>])\s+(\S.*)$/ };

export const prompts: PromptShape[] = [pointerRows, enterFooter, {
  kind: 'rows',
  numbered: /^\s*(?:│\s*)?❯\s*(\d+)\.\s+\S/,
  marker: /❯/,
  // Every spinner verb ends in an ellipsis; a completed turn does not.
  busy: /^\s*[·✢✳✶✻✽*] [^…]+…(?: \(.*\))?\s*$/i,
}];

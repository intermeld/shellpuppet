import type { DetectedPrompt } from '../../core/promptDetector.js';
import type { PromptLine as Line, PromptShape } from '../types.js';
import { normalise } from '../../core/promptText.js';

import type { StyledLine } from '../../core/renderer.js';

/** A plain Muse heading can precede the moment its keys become active. */
export const MUSE_MENU_SETTLE_MS = 1_500;

function museQuestion(text: string): boolean {
  return /^Would .+ like to run the following command\?$/.test(text) || text === 'Do you trust this workspace?';
}

/** Muse's approval and trust menus use ⟩ with numbered rows and no composer. */
export function musePrompt(raw: string[], tail: Line[]): DetectedPrompt | null {
  const selected = [...tail].reverse().find((line) => /^⟩ [1-3](?:\. | {2})/.test(line.text));
  if (selected === undefined) return null;
  const marker = /^⟩ ([1-3])(\. | {2})/.exec(selected.text);
  if (marker === null) return null;
  const selectedOption = Number(marker[1]) - 1;
  const approval = marker[2] === '. ';
  const first = selected.index - selectedOption;
  // Muse omits the workspace-wide choice for script blocks and some commands.
  // The second row identifies that form even when the heading stays plain.
  const twoOptionApproval = approval && /^(?:⟩ | {2})2\. Abort the entire command\s*\(esc\)/.test(raw[first + 1] ?? '');
  const count = approval && !twoOptionApproval ? 3 : 2;
  if (selectedOption >= count) return null;
  const options: string[] = [];
  const optionRows: number[] = [];
  for (let offset = 0; offset < count; offset++) {
    const row = first + offset;
    const text = (raw[row] ?? '').trimEnd();
    const prefix = `${offset === selectedOption ? '⟩ ' : '  '}${String(offset + 1)}${approval ? '. ' : '  '}`;
    if (!text.startsWith(prefix) || text.slice(prefix.length).trim() === '') return null;
    options.push(normalise(text.replace(/^⟩ /, '')));
    optionRows.push(row);
  }
  // Walk the visible menu itself: a long wrapped command can put the heading
  // beyond the tail and more than ten rows above the first choice. The first
  // transcript or composer boundary prevents borrowing an answered question.
  let question: Line | undefined;
  for (let index = first - 1; index >= 0 && first - index <= 60; index--) {
    const text = (raw[index] ?? '').trimEnd();
    if (museQuestion(text)) {
      question = { text, index };
      break;
    }
    if (/^\s*(?:[◆◇◈]|❯(?:\s|$)|[─━═]{2,})/u.test(text)) break;
  }
  if (question === undefined) return null;
  if (approval !== question.text.startsWith('Would ')) return null;
  // A quoted menu inside an answer has no new Muse input border before it.
  const before = raw.slice(0, question.index);
  let border = -1;
  for (let index = before.length - 1; index >= 0; index--) {
    if (/^\s*── .*Voice input/.test(before[index]!)) { border = index; break; }
  }
  if (before.slice(border + 1).some((line) => /^\s*◆/.test(line))) return null;
  const stage = approval ? raw.slice(question.index, first).find((line) => /^ {2}Stage \d+\/\d+$/.test(line.trimEnd())) : undefined;
  // Only this menu's hint and footer, blank rows and Muse's status footer
  // belong below its options. Other output means the menu is historical.
  if (raw.slice(optionRows[optionRows.length - 1]! + 1).some((line) => {
    const text = line.trimEnd();
    return text.trim() !== '' && !/^Change approval defaults in \/permissions$/.test(text) &&
      (approval || !/^Use Up\/Down or 1\/2, then Enter\. Esc quits\.$/.test(text)) &&
      !/^\s*[─━═]{2,}$/.test(text) &&
      !/^ {2}\S[^·]* · [^·]+ · [^·]+ · Launch overrides$/u.test(text);
  })) return null;
  return {
    question: question.text,
    options,
    selectedOption,
    optionRows,
    signature: [question.text, stage ?? '', ...options].join(' | '),
    rows: [question.index, optionRows[optionRows.length - 1]!],
    basis: 'marker',
  };
}

/** Tracks the visible menu block, independently of activity above it. */
export class MusePromptSettler {
  private menu: string | null = null;
  private since = 0;

  settle(prompt: DetectedPrompt | null, screen: string, now: number, styled?: readonly StyledLine[]): DetectedPrompt | null {
    if (prompt === null) {
      this.menu = null;
      return null;
    }
    if (!prompt.question.startsWith('Would ') || !prompt.signature.includes('Stage ') ||
      prompt.optionRows === undefined) {
      this.menu = null;
      return prompt;
    }
    const atRow = styled?.[prompt.rows[0]];
    const heading = atRow?.text === prompt.question ? atRow :
      [...(styled ?? [])].reverse().find((line) => line.text === prompt.question);
    const bold = heading !== undefined && heading.spans.some((span) =>
      span.bold && span.to - span.from >= prompt.question.length / 2);
    if (bold) {
      this.menu = null;
      return prompt;
    }
    // The heading to the last option row: a status footer below may tick.
    const block = screen.split('\n').slice(prompt.rows[0], prompt.rows[1] + 1).join('\n');
    if (block !== this.menu) {
      this.menu = block;
      this.since = now;
    }
    return now - this.since >= MUSE_MENU_SETTLE_MS ? prompt : null;
  }
}

export const prompts: PromptShape[] = [{ kind: 'rows', styledHeading: /^Would .+ like to run the following command\?$/ }, { kind: 'menu', order: 0, detect: (raw, _lines, tail) => musePrompt(raw, tail) }];

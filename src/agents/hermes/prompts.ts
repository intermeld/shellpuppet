import type { DetectedPrompt } from '../../core/promptDetector.js';
import type { StyledLine } from '../../core/renderer.js';
import type { PromptShape } from '../types.js';
import { colour, ink, paintedFooter } from './frame.js';

const consentFooter = '  Choice [default 2]:';
const permission = ['Allow once', 'Allow for this session', 'Add to permanent allowlist', 'Deny'];
const bronze = '#cd7f32';

export function hasPromptFooter(rows: readonly string[]): boolean {
  return rows.at(-1)?.trimEnd() === consentFooter || /^(?:⚠|\?) ❯$/u.test(rows.at(-3)?.trimEnd() ?? '');
}

export function incompleteMenu(rows: readonly string[]): boolean {
  if (hasPromptFooter(rows)) return true;
  const last = rows.at(-1)?.trimEnd() ?? '';
  if (!/^(?:╰─+╯|│.*│)$/u.test(last)) return false;
  return rows.slice(-12).some(row => /^╭─ Hermes Agent needs your input ─+╮\s*$/u.test(row) ||
    /^│ ⚠️ {2}Dangerous Command +│\s*$/u.test(row));
}

function consent(rows: string[], styled: readonly StyledLine[]): DetectedPrompt | null {
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

export function activePrompt(raw: readonly string[], styled?: readonly StyledLine[]): DetectedPrompt | null {
  if (!hasPromptFooter(raw) || !styled || raw.length !== styled.length) return null;
  const rows = raw.map(row => row.trimEnd());
  if (rows.at(-1) === consentFooter) return consent(rows, styled);
  const foot = rows.length - 1;
  const approval = rows[foot - 2] === '⚠ ❯';
  const hint = foot - 4;
  const bottom = hint - 2;
  const hintPattern = approval ? /^ {2}↑\/↓ to select, Enter to confirm {2}\(\d+s\)$/u :
    /^ {2}↑\/↓ to select, Enter to lock, Tab next question {2}\(\d+s\)$/u;
  // The row below the controls is a changing caption. A filtered reader
  // replaces that row while retaining the dialog and its input footer.
  if (!hintPattern.test(rows[hint] ?? '') || rows[hint - 1] !== '' || !/^╰─+╯$/u.test(rows[bottom] ?? '') ||
      !colour(styled[bottom]!, bronze) ||
      paintedFooter(styled[foot]!, styled[foot - 1]!) !== 'busy' ||
      !ink(styled[foot - 2]!, 0, 3, s => s.fg === '#b8860b' && s.italic)) return null;

  let top = bottom - 1;
  while (top >= 0 && /^│.*│$/u.test(rows[top]!)) {
    const row = styled[top]!;
    if (row.wrapped || row.spans[0]?.fg !== bronze || row.spans.at(-1)?.fg !== bronze) return null;
    top--;
  }
  const inner = (i: number) => rows[i]!.slice(1, -1).trim();
  let question: string;
  let optionStart: number;
  let optionEnd: number;
  if (approval) {
    if (top !== bottom - 11 || !/^╭─+╮$/u.test(rows[top] ?? '') || !colour(styled[top]!, bronze) ||
        inner(top + 1) !== '⚠️  Dangerous Command' || inner(top + 2) !== '' || inner(top + 4) !== '' ||
        inner(bottom - 2) !== '' || !inner(bottom - 1) || !inner(top + 3) ||
        !ink(styled[top + 3]!, 2, 3, s => s.italic && s.fg === '#b8860b')) return null;
    question = inner(top + 1) + '\n' + inner(top + 3);
    optionStart = top + 5;
    optionEnd = bottom - 3;
  } else {
    if (!/^╭─ Hermes Agent needs your input ─+╮$/u.test(rows[top] ?? '') ||
        inner(top + 1) !== '1 question' || !/^▸ \S/u.test(inner(top + 2))) return null;
    question = inner(top + 2).slice(2);
    optionStart = top + 3;
    optionEnd = bottom - 1;
  }

  const options: string[] = [];
  const optionRows: number[] = [];
  let selected: number | undefined;
  for (let i = optionStart; i <= optionEnd; i++) {
    const m = /^(❯ )?(\d+)\. (.+)$/u.exec(inner(i));
    if (!m || Number(m[2]) !== options.length + 1) return null;
    if (m[1]) {
      if (selected !== undefined || !ink(styled[i]!, rows[i]!.indexOf('❯'), rows[i]!.indexOf('❯') + 1,
        s => s.fg === '#ffd700' && s.bold)) return null;
      selected = options.length;
    }
    options.push(m[3]!);
    optionRows.push(i);
  }
  if (selected === undefined || (approval ? options.join('\n') !== permission.join('\n') :
    options.length < 2 || options.at(-1) !== 'Other (type your answer)')) return null;
  return { question, options, optionRows, selectedOption: selected, rows: [top, hint],
    signature: rows.slice(top, bottom + 1).join('\n'), basis: 'frame' };
}

export const prompts: PromptShape[] = [
  { kind: 'menu', order: 1, detect: (raw, _lines, _tail, _busy, _height, styled) => activePrompt(raw, styled) },
];

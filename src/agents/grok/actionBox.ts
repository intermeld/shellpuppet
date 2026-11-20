import type { StyledLine } from '../../core/renderer.js';

type Row = string | StyledLine;

function text(line: Row | undefined): string {
  return typeof line === 'string' ? line.trimEnd() : line?.text ?? '';
}

function inkAt(line: StyledLine, column: number) {
  return line.spans.find((span) => span.from <= column && column < span.to);
}

/** A physical bar can be repainted on a row xterm still marks as wrapped. */
function boxBody(line: Row | undefined): string | undefined {
  const value = text(line);
  if (!line || !/^ {2}│(?: {2}|$)/u.test(value)) return undefined;
  if (typeof line !== 'string') {
    const bar = inkAt(line, 2);
    if (bar?.fg !== '#c8c8c8' || bar.bg !== '#404040') return undefined;
  }
  return value.slice(5);
}

function isBoxAction(line: Row | undefined, footer: string): boolean {
  const body = boxBody(line);
  if (!line || !body || !/^[!-~] \S/u.test(body)) return false;
  // A text reader can corroborate the key and label against the live footer.
  if (typeof line === 'string') return footer.split('  │  ').includes(body.replace(' ', ':'));
  const key = inkAt(line, 5);
  const label = inkAt(line, 7);
  return key?.fg === '#c8c8c8' && key.bg === '#404040' &&
    label?.fg === '#6c6c6c' && label.bg === '#404040' && label.to === line.text.length;
}

const FOOTER = /^ {2}1\/([1-9]\d*):select\b/u;

export function hasActionBoxFooter(lines: readonly string[]): boolean {
  return FOOTER.test(lines.at(-1) ?? '');
}

/** Read the visible controls, or verify their ink when claiming rows for the filter. */
export function actionBox(lines: readonly Row[], styled?: readonly StyledLine[]) {
  let footerRow = lines.length - 1;
  while (footerRow >= 0 && text(lines[footerRow]).trim() === '') footerRow--;
  const footer = text(lines[footerRow]);
  const count = FOOTER.exec(footer);
  if (!count) return null;
  let row = footerRow - 1;
  const status = lines[row];
  if (typeof status === 'string') {
    if (/^ {2}[^\s│]/u.test(status)) row--;
  } else if (status) {
    const ink = inkAt(status, 2);
    if (ink?.fg === 'p6' && ink.bg === '#141414') row--;
  }
  if (boxBody(lines[row]) !== '') return null;
  const bottom = row; // Closing bar, immediately after the last radio.
  let selectedRow: number | undefined;
  for (row--; row >= 0; row--) {
    // The radio column stays aligned when a choice has no numeric shortcut.
    const radio = /^(?:[1-9]\d*| ) \(([○•●])\) \S/u.exec(boxBody(lines[row]) ?? '');
    if (!radio) break;
    if (radio[1] !== '○') {
      if (selectedRow !== undefined) return null;
      selectedRow = row;
    }
  }
  const firstOption = row + 1;
  const choices = bottom - firstOption;
  if (choices < 2 || choices !== Number(count[1]) || selectedRow === undefined) return null;

  while (boxBody(lines[row]) === '') row--;
  if (boxBody(lines[row]) === 'Auto-review blocked this action.  Ctrl+F to view explanation') row--;
  while (boxBody(lines[row]) === '') row--;
  if (!isBoxAction(lines[row], footer)) return null;
  while (isBoxAction(lines[row - 1], footer)) row--;

  // A physical wrap has box background right from column zero. A repainted
  // box row has its own margin and bar, even if xterm still calls it wrapped.
  const inkRow = (index: number): StyledLine | undefined => {
    const line = lines[index];
    if (typeof line !== 'string') return line;
    const ink = styled?.[index];
    return ink?.text === line.trimEnd() ? ink : undefined;
  };
  const rowStart = (end: number): number => {
    let start = end;
    while (start > 0) {
      const line = inkRow(start);
      if (!line?.wrapped || (line.text !== '' && line.spans.length === 0) ||
          line.spans.some(span => span.bg !== '#404040')) break;
      start--;
    }
    return start;
  };
  const actionRow = row;
  let start = rowStart(row - 1);
  while (/^[│:] /u.test(boxBody(lines[start]) ?? '')) {
    row = start;
    start = rowStart(row - 1);
  }
  if (row === actionRow || !boxBody(lines[row])?.startsWith('│ ')) return null;
  const body = boxBody(lines[start]);
  let question: string | undefined;
  if (body?.startsWith('> ')) {
    question = body.slice(2);
    for (let i = start + 1; i < row; i++) {
      if (inkRow(i - 1)?.wrapPadding) question += ' ';
      question += text(lines[i]);
    }
    row = start;
  }
  if (boxBody(lines[row - 1]) === '') row--;
  return { top: row, bottom, questionRow: question === undefined ? undefined : start, question, firstOption, selectedRow };
}

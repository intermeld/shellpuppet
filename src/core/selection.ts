/** Text-only annotation for a menu choice selected by cell styling. */
import { detectPrompt, MUSE_ACTIVE_HEADING_MARKER, SELECTED_OPTION_MARKER } from './promptDetector.js';
import type { DetectedPrompt } from './promptDetector.js';
import type { StyledLine } from './renderer.js';

interface Selection {
  option: number;
  row: number;
}

/** Carry Muse's heading style into the plain screen used by prompt detection. */
function museActiveHeading(lines: readonly StyledLine[]): number | null {
  for (let row = lines.length - 1; row >= 0; row--) {
    const line = lines[row]!;
    if (!/^Would .+ like to run the following command\?$/.test(line.text.trimEnd())) continue;
    if (!lines.slice(row + 1, row + 5).some((next) => /^ {2}Stage \d+\/\d+$/.test(next.text.trimEnd()))) continue;
    const ink = line.spans.find((span) => span.from <= 0 && span.to > 0);
    if (ink === undefined) continue;
    // During the stage repaint Muse leaves muted padding across the rest of
    // the heading row; the active captures have default padding there.
    const mutedPadding = line.trailingStyle?.fg !== null && line.trailingStyle?.fg !== undefined;
    if (ink.bold || !mutedPadding) return row;
  }
  return null;
}

function museMarkedLines(lines: readonly StyledLine[]): string[] {
  const output = lines.map((line) => line.text);
  const heading = museActiveHeading(lines);
  if (heading !== null) output[heading] = MUSE_ACTIVE_HEADING_MARKER + output[heading];
  return output;
}

/** A style must cover at least half the option's visible text, not just an icon. */
function highlighted(line: StyledLine): boolean {
  const visible = Array.from({ length: line.text.length }, (_, index) => index)
    .filter((index) => line.text.charAt(index).trim() !== '');
  if (visible.length === 0) return false;
  let covered = 0;
  for (const index of visible) {
    if (line.spans.some((span) => span.from <= index && index < span.to && (span.inverse || span.bg !== null))) covered++;
  }
  return covered * 2 >= visible.length;
}

function selectedOption(lines: readonly StyledLine[], detected?: DetectedPrompt | null): Selection | null {
  const prompt = detected === undefined ? detectPrompt(museMarkedLines(lines).join('\n')) : detected;
  if (prompt?.optionRows === undefined || prompt.optionRows.length < 2) return null;
  const selected = prompt.optionRows.flatMap((row, option) => {
    const line = lines[row];
    return line !== undefined && highlighted(line) ? [{ option, row }] : [];
  });
  // More than one highlighted row is a colour scheme, not a clear selection.
  return selected.length === 1 ? selected[0]! : null;
}

/** Preserve all original text unless one recognised menu row has unique emphasis. */
export function markSelectedOption(lines: readonly StyledLine[], prompt?: DetectedPrompt | null): string[] {
  const output = museMarkedLines(lines);
  const selected = selectedOption(lines, prompt);
  if (selected !== null) output[selected.row] = SELECTED_OPTION_MARKER + output[selected.row];
  return output;
}

/** Apply the same marker after reasoning rows have been removed or collapsed. */
export function markFilteredSelectedOption(filtered: readonly string[], source: readonly StyledLine[]): string[] {
  const output = [...filtered];
  const heading = museActiveHeading(source);
  if (heading !== null) {
    const row = output.lastIndexOf(source[heading]!.text);
    if (row >= 0) output[row] = MUSE_ACTIVE_HEADING_MARKER + output[row];
  }
  const selected = selectedOption(source);
  if (selected === null) return output;
  const prompt = detectPrompt(output.join('\n'));
  const row = prompt?.optionRows?.[selected.option];
  if (row !== undefined && output[row] === source[selected.row]?.text) {
    output[row] = SELECTED_OPTION_MARKER + output[row];
  }
  return output;
}

import type { AgentSignature } from '../core/reasoning.js';
import type { NudgeView } from './types.js';

/** The last bar foot and its aligned gutter in a single viewport. */
export function barFrame(view: NudgeView): { foot: number; gutter: string; end: number } | null {
  if (view.styled !== undefined && (view.styled.length !== view.rows.length ||
    view.styled.some((line, index) => line.text !== view.rows[index]))) return null;
  for (let i = view.rows.length - 1; i >= 0; i--) {
    const match = /^( *)╹▀{8,}/u.exec(view.rows[i]!);
    if (match !== null) return i < 4 ? null : { foot: i, gutter: match[1] + '┃', end: match[0].length };
  }
  return null;
}

export function barIsBusy(view: NudgeView, reading: AgentSignature): boolean {
  return (reading.busy ?? []).some(test => {
    if (test.text === undefined) return false;
    const marker = new RegExp(test.text, 'u');
    return view.rows.some(row => marker.test(row));
  });
}

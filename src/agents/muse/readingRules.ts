import type { ReadingRules } from '../types.js';

export const readingRules: ReadingRules = {
  busyWithoutComposer: true,
  pendingComposer: true,
  composer: (lines, i, signature, context) => {
    const candidate = lines[i]!;
    // A full-width rule above Muse's composer can leave its row marked as a
    // continuation. The voice bar still anchors that row as the composer.
    const wrappedMuseComposer = candidate.wrapped === true &&
      signature.composer.text?.test(candidate.text) === true &&
      lines.slice(Math.max(0, i - 2), i).some((line) => /^── Voice input \(Alt\+V to start\)/.test(line.text));
    if (!context.matches(candidate, signature.composer) && !wrappedMuseComposer) return false;
    let inComposerBody = true;
    const tailIsChrome = lines.slice(i + 1).every((line) => {
      if (line.text.trim() === '') return true;
      if (/^[─━]{10,}$/.test(line.text)) {
        inComposerBody = false;
        return true;
      }
      if (/· Launch overrides\s*$/.test(line.text)) return true;
      // Muse indents later rows of a typed composer. Their text keeps the
      // ordinary foreground, unlike the grey hint or status line.
      return inComposerBody && /^ {2}\S/.test(line.text) &&
        context.ink(line).every((style) => style.fg === '#ccd3db');
    });
    return tailIsChrome;
  },
  busy: (lines, turnStart, chrome, signature, context) => {
    let lastBusy = -1;
    for (let i = lines.length - 1; i >= turnStart; i--) {
      if (signature.busy.some((test) => context.matches(lines[i]!, test))) {
        lastBusy = i;
        break;
      }
    }
    // Muse can retain an activity row above a finished answer. Only a later
    // answer before the composer makes that row historical.
    let museAnswerAfterBusy = false;
    if (lastBusy >= 0) {
      const ranges = context.ranges(lines, signature, chrome);
      const inReasoning = (i: number): boolean => ranges.some(([from, to]) => i >= from && i < to);
      museAnswerAfterBusy = lines.slice(lastBusy + 1, chrome).some((line, offset) =>
        !inReasoning(lastBusy + 1 + offset) && context.matches(line, signature.answer.start));
    }
    return lastBusy >= 0 && !museAnswerAfterBusy;
  },
};

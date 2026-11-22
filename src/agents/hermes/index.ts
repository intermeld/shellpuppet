import { submittingText } from '../input.js';
import type { AgentModule } from '../types.js';
import { composer, readyScreen } from './frame.js';
import { composerBlock, readiness } from './nudge.js';
import { prompts } from './prompts.js';
import { answerFloor, hiddenRanges, reading } from './reading.js';

export const hermes: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts, requirePaintedMenu: true,
  readingRules: {
    composer: (lines, i, signature, context) => context.matches(lines[i]!, signature.composer) &&
      (!signature.builtIn || composer(lines)?.first === i),
    hiddenRanges, answerFloor,
    busyWithoutComposer: true,
    busy: (lines, start, _chrome, signature, context) => signature.builtIn ? !composer(lines)?.idle :
      lines.slice(start).some(line => signature.busy.some(test => context.matches(line, test))),
  },
  input: { submit: { key: '\r', delayMs: 150, matches: data => submittingText(data) || /^ +\r$/u.test(data) } },
  nudge: { readiness, composerBlock, queueKey: '\t' },
  readiness: { readyScreen },
};

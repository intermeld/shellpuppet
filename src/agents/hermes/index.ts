import { submittingText } from '../input.js';
import type { AgentModule } from '../types.js';
import { completed, composer, readyScreen } from './frame.js';
import { readiness } from './nudge.js';
import { prompts } from './prompts.js';
import { hiddenRanges, reading } from './reading.js';

export const hermes: AgentModule = {
  name: reading.name, programs: reading.programs, reading, prompts,
  readingRules: {
    composer: (lines, i, signature, context) => context.matches(lines[i]!, signature.composer) &&
      (!signature.builtIn || composer(lines)?.first === i),
    hiddenRanges,
    busy: (lines, start, chrome, signature, context) => signature.builtIn ? !completed(lines[chrome - 1]) :
      lines.slice(start).some(line => signature.busy.some(test => context.matches(line, test))),
  },
  input: { submit: { key: '\r', delayMs: 150, matches: submittingText } },
  nudge: { readiness },
  readiness: { readyScreen },
};

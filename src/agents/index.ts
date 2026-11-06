import type { AgentSignature } from '../core/reasoning.js';
import type { AgentModule, AgentSource, PromptShape } from './types.js';
import { claude } from './claude/index.js';
import { codex } from './codex/index.js';
import { agy } from './agy/index.js';
import { grok } from './grok/index.js';
import { opencode } from './opencode/index.js';
import { mimo } from './mimo/index.js';
import { qoder } from './qoder/index.js';
import { muse } from './muse/index.js';
import { generic } from './generic/index.js';

// Compatibility exports for callers of the former core entry points.
export { MusePromptSettler as MuseMenuSettler, MUSE_MENU_SETTLE_MS } from './muse/prompts.js';
export { MUSE_SUBMIT_DELAY_MS } from './muse/input.js';

export const AGENT_MODULES: readonly AgentModule[] = [claude, codex, agy, grok, opencode, mimo, qoder, muse, generic];
export const BUILT_IN_SIGNATURES: readonly AgentSignature[] = AGENT_MODULES.filter(module => module !== generic).map(module => module.reading);

export function moduleFor(name: string): AgentModule | undefined {
  return AGENT_MODULES.find(module => module.name === name);
}

/** A program's basename, independent of the host platform. */
export function programName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase();
}

/** Preserve the existing versioned-program match, including configured signatures. */
export function claimsProgram(signature: { programs: string[] }, program: string): boolean {
  return signature.programs.includes(program) || AGENT_MODULES.some(module =>
    module.programs.some(pattern => signature.programs.includes(pattern) && module.matchesProgram?.(pattern, program) === true));
}

/** Resolution uses the same ordered readings as the configuration overlay. */
export function resolveAgent(agent: string | undefined, command: string, readings: readonly { name: string; programs: string[] }[] = BUILT_IN_SIGNATURES): { agent: string; agentSource: AgentSource } {
  if (agent !== undefined) return { agent, agentSource: 'explicit' };
  const program = programName(command);
  const matched = readings.find(reading => claimsProgram(reading, program));
  return matched === undefined
    ? { agent: 'generic', agentSource: 'fallback' }
    : { agent: matched.name, agentSource: 'program' };
}

/** Every session runs every shape in the original detector order; callers may still pass their identity. */
export const promptShapesFor: (agent: string) => PromptShape[] = () =>
  [...new Set(AGENT_MODULES.flatMap(module => module.prompts))].sort((a, b) =>
    (a.kind === 'menu' ? a.order : 2) - (b.kind === 'menu' ? b.order : 2));

export const BUILT_IN_DIALOGS = [...new Set(AGENT_MODULES.flatMap(module =>
  module.prompts.flatMap(shape => shape.kind === 'dialog' ? [shape.signature] : [])))];

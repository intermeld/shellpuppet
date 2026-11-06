import type { AgentSignature, CompiledSignature } from '../core/reasoning.js';
import type { DialogSignature } from '../core/dialogs.js';
import type { DetectedPrompt } from '../core/promptDetector.js';
import type { CellStyle, StyledLine } from '../core/renderer.js';

export type ProgramMatch = string;
export type AgentSource = 'explicit' | 'program' | 'fallback';
export interface VerifyTiming { baseMs: number; perCharacterMs: number; maxMs: number }
/** Reserved for a later, explicitly configured safety adapter. */
export interface SafetyAdapter { readonly kind: string }

export interface PromptLine { text: string; index: number }
export interface PromptRows {
  kind: 'rows';
  styledHeading?: RegExp;
  numbered?: RegExp;
  pointer?: RegExp;
  footer?: RegExp;
  marker?: RegExp;
  busy?: RegExp;
  keyHint?: RegExp;
  questionPrefix?: RegExp;
  commandStart?: (raw: string[], firstOption: number) => number;
  clackMessage?: (raw: string[], index: number) => string[];
}
export type PromptShape =
  | { kind: 'dialog'; signature: DialogSignature }
  | { kind: 'menu'; order: number; detect: (raw: string[], lines: PromptLine[], tail: PromptLine[], busy: (text: string) => boolean) => DetectedPrompt | null }
  | PromptRows;

export interface PromptSettler {
  settle(prompt: DetectedPrompt | null, screen: string, now: number, styled?: readonly StyledLine[]): DetectedPrompt | null;
}
export interface ReadingContext {
  matches: (line: StyledLine, test: CompiledSignature['composer']) => boolean;
  ink: (line: StyledLine) => CellStyle[];
  ranges: (lines: readonly StyledLine[], signature: CompiledSignature, limit: number) => [number, number][];
}
export interface ReadingRules {
  composer?: (lines: readonly StyledLine[], index: number, signature: CompiledSignature, context: ReadingContext) => boolean;
  busyWithoutComposer?: boolean;
  busy?: (lines: readonly StyledLine[], turnStart: number, chrome: number, signature: CompiledSignature, context: ReadingContext) => boolean;
  pendingComposer?: boolean;
}

/** Internal harness data and the few detector walks not yet expressed as data. */
export interface AgentModule {
  name: string;
  programs: ProgramMatch[];
  reading: AgentSignature;
  prompts: PromptShape[];
  input?: {
    submit?: { key: string; delayMs?: number; matches?: (data: string) => boolean };
    resizeBehindSubmit?: boolean;
    verifyMs?: VerifyTiming;
  };
  readiness?: { readyText?: string[]; readyQuietMs?: number; settleMs?: number };
  env?: { sessionMarkers: string[] };
  safety?: SafetyAdapter;
  matchesProgram?: (pattern: ProgramMatch, program: string) => boolean;
  createPromptSettler?: () => PromptSettler;
  readingRules?: ReadingRules;
}

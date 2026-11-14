import type { AgentSignature, CompiledSignature, LineTest } from '../core/reasoning.js';
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
  /** A module's input row, which must not seed a pointer chooser. */
  composer?: RegExp;
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
  /** Crop only independently framed adjacent UI, before any reading walk. */
  contentRegion?: (lines: readonly StyledLine[]) => readonly StyledLine[];
  composer?: (lines: readonly StyledLine[], index: number, signature: CompiledSignature, context: ReadingContext) => boolean;
  busyWithoutComposer?: boolean;
  busy?: (lines: readonly StyledLine[], turnStart: number, chrome: number, signature: CompiledSignature, context: ReadingContext) => boolean;
  pendingComposer?: boolean;
  /** Live answer content, outside tools and quotations; missing turn context is inconclusive. */
  liveContent?: (lines: readonly StyledLine[], turnStart: number, candidate: number, context: ReadingContext) => boolean | 'inconclusive';
  /** Remove a side panel only when the surrounding frame establishes its columns. */
  inputRegion?: (lines: readonly StyledLine[], composer: number) => readonly StyledLine[];
}

/** An evidenced error at the end of an idle turn, never a phrase search. */
export interface StallSignature {
  reason: string;
  /** Fixed product wording. Never supplied by the terminal. */
  description: string;
  /** Complete visible marker row, excluding trailing space, before styled reads. */
  marker: { text: string | RegExp; fg: string[] };
  /** Controls on the completed footer only; group 1 retains its semantic prefix. */
  cosmetic?: RegExp;
  /** Framing shared with the module's answer reader, independent of body text. */
  contentRegion?: ReadingRules['contentRegion'];
  chrome: LineTest[];
  /** Columns whose ink establishes row ownership for cheap invalidation. */
  frameColumns: number[];
  before: LineTest;
  /** Some versions omit the neutral introduction above the coloured error. */
  beforeOptional?: boolean;
  rows: LineTest[];
  footer: LineTest;
  composer: LineTest;
  /** Mode row immediately before the closing edge, for partial redraw ownership. */
  composerStatus?: LineTest;
  /** Allowed non-blank rows of the idle composer, including placeholders. */
  idle: LineTest[];
  /** Positional rows immediately below the closing edge; later rows are output. */
  bottom: LineTest[];
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
  readiness?: {
    /** Alternative literal ready signals recorded in agent-profiles.md. */
    readyText?: string[];
    /** A composer whose position matters as well as its text. */
    readyScreen?: (screen: string) => boolean;
    readyQuietMs?: number;
    settleMs?: number;
  };
  env?: { sessionMarkers: string[] };
  safety?: SafetyAdapter;
  stalls?: StallSignature[];
  matchesProgram?: (pattern: ProgramMatch, program: string) => boolean;
  createPromptSettler?: () => PromptSettler;
  readingRules?: ReadingRules;
}

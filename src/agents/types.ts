import type { AgentSignature, CompiledSignature, LineTest } from '../core/reasoning.js';
import type { DialogSignature } from '../core/dialogs.js';
import type { DetectedPrompt } from '../core/promptDetector.js';
import type { CursorPosition } from '../core/types.js';
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
  | { kind: 'menu'; order: number; detect: (raw: string[], lines: PromptLine[], tail: PromptLine[], busy: (text: string) => boolean, viewportRows?: number, styled?: readonly StyledLine[]) => DetectedPrompt | null }
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
  /** Hidden row ranges for a reader that can positively identify only framed output. */
  hiddenRanges?: (lines: readonly StyledLine[], limit: number) => [number, number][];
  /** Earliest possible answer row for a completed turn with a distinct closing frame. */
  answerFloor?: (lines: readonly StyledLine[], limit: number) => number;
  /** Crop only independently framed adjacent UI, before any reading walk. */
  contentRegion?: (lines: readonly StyledLine[]) => readonly StyledLine[];
  /** Rows owned by a live frame, even if its controls were painted on physical wraps. */
  claimPromptRows?: (lines: readonly StyledLine[], prompt: DetectedPrompt | null) => readonly [number, number] | null;
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
  /** The general error message may occupy several red-gutter rows. */
  flexibleMessage?: boolean;
  /** A long error can leave only its coloured body visible above the footer. */
  clippedBody?: boolean;
  footer: LineTest;
  composer: LineTest;
  /** Mode row immediately before the closing edge, for partial redraw ownership. */
  composerStatus?: LineTest;
  /** Allowed non-blank rows of the idle composer, including placeholders. */
  idle: LineTest[];
  /** A styled suggestion with the shortcut's opening parenthesis at the inset right edge. */
  idleClipped?: { row: LineTest; rightInset: number };
  /** Positional rows immediately below the closing edge; later rows are output. */
  bottom: LineTest[];
  /** A live modal banner may interrupt a busy turn without an idle footer. */
  overlay?: { message: LineTest; background: string; centreOffset: number };
}

/**
 * What a module can tell about typing into the composer it already describes.
 * `queue` is a running turn whose composer is visible and empty, for a program
 * that takes a submitted line while it works (queued or handed to the turn).
 */
export type NudgeReadiness = 'ready' | 'busy' | 'queue' | 'draft' | 'unknown';

/**
 * One visible viewport. Plain rows are enough for a recorded transcript.
 * When styled rows are set, their text is that same viewport: the ink tells
 * the recorded placeholder from a draft. A difference is not judged.
 */
export interface NudgeView {
  /** Terminal width in cells, when known. */
  viewportCols?: number;
  /** Cursor and optional physical cells from the same viewport as the text. */
  cursor?: CursorPosition;
  untrimmedRow?: (y: number) => StyledLine | undefined;
  rows: readonly string[];
  styled?: readonly StyledLine[];
  /** Exact daemon line allowed in the composer during a delayed submission. */
  expectedDraft?: string;
  /** A scheduled write needs the reason a busy composer blocks this particular run. */
  whenBusy?: 'skip' | 'queue';
  /** Prove a draft for the distinct key that queues it during a running turn. */
  queueDraft?: boolean;
  /** Require a blank composer or the module's exact known placeholder. */
  exactEmpty?: boolean;
}

/** Internal harness data and the few detector walks not yet expressed as data. */
export interface AgentModule {
  name: string;
  programs: ProgramMatch[];
  reading: AgentSignature;
  prompts: PromptShape[];
  /** A recognisable but incomplete menu whose text could fool the shared row heuristics. */
  incompleteMenu?: (rows: readonly string[]) => boolean;
  input?: {
    submit?: {
      key: string;
      delayMs?: number;
      matches?: (data: string) => boolean;
      /** Minimum pause for a pasted line, scaled by its length where measured. */
      perCharacterMs?: number;
      /** Quiet time after the draft is visible, before Enter. */
      quietMs?: number;
      /** Time for the composer to settle after Enter. */
      settleMs?: number;
      /** Extra time after the minimum pause to wait for a painted, quiet draft. */
      maxWaitMs?: number;
      /** A composer replacement: group 1 is the placeholder; named group chars is its length, if shown. */
      pastePlaceholder?: RegExp;
      /** Input for which this module accepts a paste placeholder as proof. */
      pastePlaceholderBody?: RegExp;
    };
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
  /**
   * Whether this program's screen is idle with an empty composer.
   * Absent means the module cannot tell, and the session is never judged ready.
   */
  nudge?: {
    readiness(view: NudgeView): NudgeReadiness;
    queueKey?: string;
    /** The composer and footer text to compare across paints while a turn runs. */
    composerBlock?: (rows: readonly string[], cursor?: CursorPosition) => string;
    /** A separately framed idle pane whose neighbours can repaint without holding up input. */
    idlePane?: (view: NudgeView) => string | undefined;
  };
  /** Conversation id exported to a child tool by this agent, when available. */
  resumeIdMarkers?: readonly string[];
  env?: { sessionMarkers: string[] };
  safety?: SafetyAdapter;
  stalls?: StallSignature[];
  matchesProgram?: (pattern: ProgramMatch, program: string) => boolean;
  createPromptSettler?: () => PromptSettler;
  readingRules?: ReadingRules;
}

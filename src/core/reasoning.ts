/**
 * Reading an agent CLI's screen without its reasoning.
 *
 * Several agent CLIs draw the model's reasoning on screen as they work, and a
 * supervisor reading the screen with `terminal_snapshot` takes all of it into
 * its own context: text it did not need, and another model's reasoning it
 * has no business collecting. This module tells the parts of a screen apart:
 * the reasoning blocks, the answer that ends a turn, the composer and the
 * status lines under it. `terminal_snapshot` and `terminal_find` can then
 * leave the reasoning out (`hideReasoning`), and `terminal_result` returns
 * the answer alone.
 *
 * Each program is described as data, a signature, because each draws its
 * screen its own way. A signature says how to recognise a line by its text
 * and by how it is drawn (bold, dim, italic, colour): reasoning is usually
 * drawn dim or italic, an answer often starts with a bullet in the text
 * colour while tool calls get a grey or coloured one. Every built-in
 * signature is pinned by fixtures captured from the real program's screen
 * (`test/fixtures/reasoning/`), and config `agents.signatures` adds or
 * replaces one without a release.
 *
 * A question the program is waiting on is never hidden, whatever its
 * signature says: the rows the prompt detection (`promptDetector.ts`)
 * claims for a question on screen stay, so a permission box drawn in the
 * same style as the reasoning keeps every row of its own.
 *
 * Both readers fail closed. A session whose program has no signature is
 * refused rather than shown unfiltered, and `terminal_result` refuses when it
 * cannot find an answer it recognises, rather than returning something else.
 * What the filter cannot promise: a program that draws its reasoning in a
 * shape its signature does not describe, a new version that changes the
 * shape, or a screen that imitates one, defeats it. Screen content is
 * untrusted input either way (design §4.4).
 *
 * Signature patterns run under the regular-expression time budget
 * (`regexBudget.ts`), as patterns from config are text a person wrote.
 * The prompt detector times its dialog signatures the same way; its own
 * patterns are not timed.
 */

import { BUILT_IN_SIGNATURES, claimsProgram, moduleFor, programName, resolveAgent } from '../agents/index.js';
import type { AgentSource } from '../agents/types.js';
import { RegexBudgetError, SET_ASIDE_MS, withRegexBudget } from './regexBudget.js';
import { detectPrompt } from './promptDetector.js';
import type { DetectedPrompt } from './promptDetector.js';
import type { CellStyle, StyledLine } from './renderer.js';

/** Conditions on how characters are drawn. Colours as in `CellStyle`, or `default`. */
export interface StyleTest {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  /** Accepted foreground colours. */
  fg?: string[];
  /** Foreground colours that rule the line out. */
  notFg?: string[];
  /** Accepted background colours. */
  bg?: string[];
}

/** A test one line must pass. Every condition given must hold. */
export interface LineTest {
  /** A regular expression the line's text must match. */
  text?: string;
  /** How the first character that is not a space is drawn. */
  lead?: StyleTest;
  /** How every character after the first, other than spaces, is drawn. */
  body?: StyleTest;
  /**
   * How the first character after the lead and the space behind it is drawn:
   * a bold heading after a bullet marks a tool call where plain text marks a
   * message.
   */
  word?: StyleTest;
}

/** A block: its first line, and the lines that belong to it. */
export interface BlockTest {
  start: LineTest;
  /**
   * A line that continues the block. Without it, the block is its first line
   * alone. A blank line inside a block is kept when the line after it
   * continues the block too.
   */
  continues?: LineTest;
  /**
   * For an answer whose paragraphs all look alike, with no first line of its
   * own: the block also takes in the lines above that pass `start`, across
   * blank lines, as far as the first line that does not.
   */
  upward?: boolean;
}

/** One program's screen, as data. The shape of an `agents.signatures` entry. */
export interface AgentSignature {
  /** The agent's name, as `terminal_start`'s `agent` takes it. */
  name: string;
  /** Start commands that select it without an `agent`: `claude`, `codex`. */
  programs: string[];
  /** The program's version the fixtures were captured from, for the reader. */
  measured?: string;
  /** The composer's own line: the last line that passes is the composer. */
  composer: LineTest;
  /**
   * Lines the program draws between its transcript and the composer: borders,
   * a mode line, the line its spinner turns on. Walking up from the composer
   * over these and over blank lines finds where the transcript ends. A walk
   * that tests what it passes cannot swallow the answer, as a fixed count of
   * lines would when a mode line is not drawn.
   */
  chrome?: LineTest[];
  /** Lines that belong to the frame and carry nothing, dropped from status. */
  frame?: LineTest;
  /** A line present only while a turn is running: an answer is not final. */
  busy?: LineTest[];
  /** Where a turn begins: the person's prompt as the program echoes it. */
  turn?: LineTest;
  /** The program's reasoning blocks. */
  reasoning?: BlockTest[];
  /** The answer that ends a turn. */
  answer: BlockTest;
  /** Lines after the answer, above the composer, that go with it: a turn summary. */
  trailer?: LineTest;
  /**
   * The program always closes a finished turn with a trailer line, so a turn
   * without one has not finished (it was interrupted, or ended without an
   * answer): no result is given, rather than the last message before it.
   */
  requireTrailer?: boolean;
  /**
   * The composer holding text the person or an agent typed and has not sent
   * (as opposed to its placeholder): the latest turn is about to change, so no
   * result is given.
   */
  typed?: LineTest;
  /**
   * A regular expression for what the program draws on the same row as its
   * text but is not part of it, such as a right-aligned timestamp or a
   * sidebar: removed from the lines `terminal_result` returns.
   */
  tidy?: string;
}

export { BUILT_IN_SIGNATURES } from '../agents/index.js';

// ---------------------------------------------------------------- compiling

interface CompiledStyle {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  fg?: Set<string>;
  notFg?: Set<string>;
  bg?: Set<string>;
}

interface CompiledLine {
  text?: RegExp;
  word?: CompiledStyle;
  lead?: CompiledStyle;
  body?: CompiledStyle;
}

interface CompiledBlock {
  start: CompiledLine;
  continues?: CompiledLine;
  upward: boolean;
}

export interface CompiledSignature {
  name: string;
  programs: string[];
  measured?: string;
  source: string;
  composer: CompiledLine;
  chrome: CompiledLine[];
  frame?: CompiledLine;
  busy: CompiledLine[];
  turn?: CompiledLine;
  reasoning: CompiledBlock[];
  answer: CompiledBlock;
  trailer?: CompiledLine;
  requireTrailer: boolean;
  typed?: CompiledLine;
  tidy?: RegExp;
  /**
   * When a pattern last ran past its budget. The signature is set aside for
   * `SET_ASIDE_MS` after that, then tried again: a wall-clock budget can trip
   * once on a loaded machine without the signature being at fault.
   */
  overBudgetAt: number | null;
  /** Whether it is one of `BUILT_IN_SIGNATURES`, not an entry from config. */
  builtIn: boolean;
}

export { SET_ASIDE_MS };

/** Whether a signature is set aside for running past its time budget just now. */
export function setAside(signature: CompiledSignature, now = Date.now()): boolean {
  return signature.overBudgetAt !== null && now - signature.overBudgetAt < SET_ASIDE_MS;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A regular expression from a signature, or an error that says which one would not compile. */
function pattern(source: string, at: string): RegExp {
  try {
    return new RegExp(source, 'u');
  } catch (error) {
    throw new Error(`${at} does not compile (${error instanceof Error ? error.message : String(error)})`, {
      cause: error,
    });
  }
}

function compileStyle(value: unknown, at: string): CompiledStyle {
  if (!isRecord(value)) throw new Error(`${at} must be an object`);
  const style: CompiledStyle = {};
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (key === 'bold' || key === 'dim' || key === 'italic') {
      if (typeof v !== 'boolean') throw new Error(`${at}.${key} must be true or false`);
      style[key] = v;
    } else if (key === 'fg' || key === 'notFg' || key === 'bg') {
      if (!Array.isArray(v) || v.length === 0 || !v.every((c) => typeof c === 'string' && /^(default|p\d{1,3}|#[0-9a-f]{6})$/.test(c))) {
        throw new Error(`${at}.${key} must list colours as "default", "p<n>" or "#rrggbb"`);
      }
      style[key] = new Set(v as string[]);
    } else {
      throw new Error(`${at} has an unknown key ${key}`);
    }
  }
  return style;
}

function compileLine(value: unknown, at: string): CompiledLine {
  if (!isRecord(value)) throw new Error(`${at} must be an object`);
  const line: CompiledLine = {};
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (key === 'text') {
      if (typeof v !== 'string' || v === '') throw new Error(`${at}.text must be a non-empty regular expression`);
      line.text = pattern(v, `${at}.text`);
    } else if (key === 'lead' || key === 'body' || key === 'word') {
      line[key] = compileStyle(v, `${at}.${key}`);
    } else {
      throw new Error(`${at} has an unknown key ${key}`);
    }
  }
  if (line.text === undefined && line.lead === undefined && line.body === undefined && line.word === undefined) {
    throw new Error(`${at} needs text, lead, word or body`);
  }
  return line;
}

function compileBlock(value: unknown, at: string): CompiledBlock {
  if (!isRecord(value)) throw new Error(`${at} must be an object with start`);
  for (const key of Object.keys(value)) {
    if (key !== 'start' && key !== 'continues' && key !== 'upward') throw new Error(`${at} has an unknown key ${key}`);
  }
  const upward = value['upward'] ?? false;
  if (typeof upward !== 'boolean') throw new Error(`${at}.upward must be true or false`);
  return {
    start: compileLine(value['start'], `${at}.start`),
    ...(value['continues'] !== undefined ? { continues: compileLine(value['continues'], `${at}.continues`) } : {}),
    upward,
  };
}

const SIGNATURE_KEYS = new Set([
  'name', 'programs', 'measured', 'composer', 'chrome', 'frame', 'busy', 'turn', 'reasoning', 'answer', 'trailer',
  'requireTrailer', 'typed', 'tidy',
]);

/**
 * Compile signatures, setting aside any that cannot be used and saying why,
 * in words a person can act on.
 */
export function compileSignatures(list: readonly unknown[], where = 'agents.signatures'): {
  signatures: CompiledSignature[];
  problems: string[];
  usable: number[];
} {
  const signatures: CompiledSignature[] = [];
  const problems: string[] = [];
  const usable: number[] = [];
  list.forEach((entry, index) => {
    const at = `${where}[${String(index)}]`;
    try {
      if (!isRecord(entry)) throw new Error(`${at} must be an object`);
      const name = entry['name'];
      if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
        throw new Error(`${at}.name must be a short lower-case name such as "codex"`);
      }
      const named = `${at} (${name})`;
      for (const key of Object.keys(entry)) {
        if (!SIGNATURE_KEYS.has(key)) throw new Error(`${named} has an unknown key ${key}`);
      }
      const programs = entry['programs'] ?? [];
      if (!Array.isArray(programs) || !programs.every((p) => typeof p === 'string' && p !== '')) {
        throw new Error(`${named}.programs must be a list of command names`);
      }
      const composer = entry['composer'];
      const chrome = entry['chrome'] ?? [];
      const busy = entry['busy'] ?? [];
      const reasoning = entry['reasoning'] ?? [];
      if (!Array.isArray(chrome)) throw new Error(`${named}.chrome must be a list of line tests`);
      if (!Array.isArray(busy)) throw new Error(`${named}.busy must be a list of line tests`);
      if (!Array.isArray(reasoning)) throw new Error(`${named}.reasoning must be a list of blocks`);
      if (entry['answer'] === undefined) throw new Error(`${named} needs an answer block`);
      const measured = entry['measured'];
      const tidy = entry['tidy'];
      if (tidy !== undefined && (typeof tidy !== 'string' || tidy === '')) {
        throw new Error(`${named}.tidy must be a non-empty regular expression`);
      }
      const requireTrailer = entry['requireTrailer'] ?? false;
      if (typeof requireTrailer !== 'boolean') throw new Error(`${named}.requireTrailer must be true or false`);
      if (requireTrailer && entry['trailer'] === undefined) {
        throw new Error(`${named}.requireTrailer needs a trailer to require`);
      }
      signatures.push({
        name,
        programs: (programs as string[]).map((p) => p.toLowerCase()),
        ...(typeof measured === 'string' ? { measured } : {}),
        source: JSON.stringify(entry),
        composer: compileLine(composer, `${named}.composer`),
        chrome: chrome.map((c: unknown, i: number) => compileLine(c, `${named}.chrome[${String(i)}]`)),
        ...(entry['frame'] !== undefined ? { frame: compileLine(entry['frame'], `${named}.frame`) } : {}),
        busy: busy.map((b: unknown, i: number) => compileLine(b, `${named}.busy[${String(i)}]`)),
        ...(entry['turn'] !== undefined ? { turn: compileLine(entry['turn'], `${named}.turn`) } : {}),
        reasoning: reasoning.map((r: unknown, i: number) => compileBlock(r, `${named}.reasoning[${String(i)}]`)),
        answer: compileBlock(entry['answer'], `${named}.answer`),
        ...(entry['trailer'] !== undefined ? { trailer: compileLine(entry['trailer'], `${named}.trailer`) } : {}),
        requireTrailer,
        ...(entry['typed'] !== undefined ? { typed: compileLine(entry['typed'], `${named}.typed`) } : {}),
        ...(typeof tidy === 'string' ? { tidy: pattern(tidy, `${named}.tidy`) } : {}),
        overBudgetAt: null,
        builtIn: where === 'built-in',
      });
      usable.push(index);
    } catch (error) {
      problems.push(`${error instanceof Error ? error.message : String(error)}: ignored`);
    }
  });
  return { signatures, problems, usable };
}

let active: CompiledSignature[] = compileSignatures(BUILT_IN_SIGNATURES, 'built-in').signatures;
let reportOverBudget: (name: string, builtIn: boolean) => void = () => undefined;

/**
 * Use the built-in signatures plus `extra`, the entries from config; an entry
 * named like a built-in one replaces it. `onOverBudget` is told, with whether
 * the signature is built in, each time one runs past its budget (the daemon
 * logs it). Returns what was wrong with `extra`.
 */
export function useAgentSignatures(
  extra: readonly unknown[],
  onOverBudget: (name: string, builtIn: boolean) => void = () => undefined,
): string[] {
  const { signatures, problems } = compileSignatures(extra);
  const replaced = new Set(signatures.map((s) => s.name));
  active = [
    ...compileSignatures(BUILT_IN_SIGNATURES, 'built-in').signatures.filter((s) => !replaced.has(s.name)),
    ...signatures,
  ];
  reportOverBudget = onOverBudget;
  return problems;
}

/** Resolve identity once, independently of a reading pattern's temporary time budget. */
export function resolveSessionAgent(agent: string | undefined, command: string): ReturnType<typeof resolveAgent> {
  return resolveAgent(agent, command, active);
}

/** The names `terminal_start`'s `agent` accepts. */
export function agentNames(): string[] {
  return active.map((s) => s.name).sort();
}

export { programName } from '../agents/index.js';

/**
 * The agent a session runs as, by name: the one it was started as, or the one
 * whose programs include its start command. The signatures are compiled and
 * ordered exactly as `useAgentSignatures` orders the daemon's (the built-ins
 * a config entry does not replace, then the config's entries in order, first
 * match), so a client and the daemon name the same agent. Null when neither
 * names one. For a client, which has no signature registry of its own; the
 * daemon reads screens with `signatureFor`.
 */
export function agentNameFor(agent: string | undefined, command: string, extra: readonly unknown[] = []): string | null {
  if (agent !== undefined) return agent;
  const configured = compileSignatures(extra).signatures;
  const replaced = new Set(configured.map((signature) => signature.name));
  const ordered = [
    ...compileSignatures(BUILT_IN_SIGNATURES, 'built-in').signatures.filter((s) => !replaced.has(s.name)),
    ...configured,
  ];
  const program = programName(command);
  return ordered.find((signature) => claimsProgram(signature, program))?.name ?? null;
}

/**
 * The signature for a session: the agent it was started as, or the one whose
 * programs include its start command. Null when neither names one.
 */
export function signatureFor(agent: string | undefined, command = ''): CompiledSignature | null {
  if (agent !== undefined) return active.find((s) => s.name === agent && !setAside(s)) ?? null;
  const program = programName(command);
  return active.find((s) => !setAside(s) && claimsProgram(s, program)) ?? null;
}

/** A fallback identity must not select a configured reading named generic. */
export function signatureForSession(session: { agent: string; agentSource: AgentSource }): CompiledSignature | null {
  return session.agentSource === 'fallback' ? null : signatureFor(session.agent);
}

// ---------------------------------------------------------------- matching

/** A row that holds nothing but whitespace and box drawing: border, not text. */
const BORDER_ROW = /^[\s─-╿-]*$/u;

function styleFits(style: CellStyle, test: CompiledStyle): boolean {
  if (test.bold !== undefined && style.bold !== test.bold) return false;
  if (test.dim !== undefined && style.dim !== test.dim) return false;
  if (test.italic !== undefined && style.italic !== test.italic) return false;
  const fg = style.fg ?? 'default';
  if (test.fg !== undefined && !test.fg.has(fg)) return false;
  if (test.notFg !== undefined && test.notFg.has(fg)) return false;
  if (test.bg !== undefined && !test.bg.has(style.bg ?? 'default')) return false;
  return true;
}

/** The style of each character that is not a space, in order. */
function inkStyles(line: StyledLine): CellStyle[] {
  const out: CellStyle[] = [];
  for (const span of line.spans) {
    for (let i = span.from; i < span.to; i++) {
      if (!/\s/u.test(line.text[i] ?? ' ')) out.push(span);
    }
  }
  return out;
}

function lineFits(line: StyledLine, test: CompiledLine): boolean {
  // A continuation has no independent meaning, even when its text happens
  // to look like a turn, question, composer, answer or reasoning start.
  if (line.wrapped) return false;
  if (test.text !== undefined && !test.text.test(line.text)) return false;
  if (test.lead === undefined && test.body === undefined && test.word === undefined) return true;
  const ink = inkStyles(line);
  if (ink.length === 0) return false;
  if (test.lead !== undefined && !styleFits(ink[0]!, test.lead)) return false;
  if (test.word !== undefined && (ink.length < 2 || !styleFits(ink[1]!, test.word))) return false;
  if (test.body !== undefined) {
    const body = ink.slice(1);
    if (body.length === 0 || !body.every((style) => styleFits(style, test.body!))) return false;
  }
  return true;
}

/**
 * Whether a line holds nothing of the transcript: blank, or blank once the
 * signature's `tidy` has taken away what is drawn beside the text (a side
 * panel, a scrollbar).
 */
const blank = (line: StyledLine | undefined, tidy?: RegExp): boolean =>
  line === undefined || (tidy === undefined ? line.text : line.text.replace(tidy, '')).trim() === '';

/** The end (exclusive) of the block that starts at `at`, stopping at `limit`. */
function blockEnd(
  lines: readonly StyledLine[],
  at: number,
  block: CompiledBlock,
  limit: number,
  tidy?: RegExp,
  claimed?: ReadonlySet<number> | null,
): number {
  let end = at + 1;
  let i = at + 1;
  while (i < limit) {
    if (lines[i]!.wrapped) {
      i++;
      end = i;
      continue;
    }
    if (block.continues === undefined) break;
    // A line a question on screen claims for itself is never part of a
    // block: the block ends before it rather than running over it.
    if (claimed?.has(i)) break;
    const line = lines[i]!;
    if (!blank(line, tidy) && lineFits(line, block.continues)) {
      i++;
      end = i;
      continue;
    }
    if (blank(line, tidy)) {
      // A blank line stays inside the block only if the block carries on after it.
      let next = i;
      while (next < limit && blank(lines[next], tidy)) next++;
      if (next < limit && lineFits(lines[next]!, block.continues)) {
        i = next;
        continue;
      }
    }
    break;
  }
  return end;
}

/** Run `body` under the budget; a signature that overruns is set aside. */
function guarded<T>(signature: CompiledSignature, body: () => T): T | null {
  try {
    return withRegexBudget(signature.source.slice(0, 120), body);
  } catch (error) {
    if (!(error instanceof RegexBudgetError)) throw error;
    // Reported each time it trips: a person reading daemon.log sees whether
    // a signature keeps running long or tripped once under load.
    signature.overBudgetAt = Date.now();
    reportOverBudget(signature.name, signature.builtIn);
    return null;
  }
}

/** The index of the composer's line and the first line of chrome, or null. */
function composerAt(lines: readonly StyledLine[], signature: CompiledSignature): { line: number; chrome: number } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const candidate = lines[i]!;
    const composerRule = moduleFor(signature.name)?.readingRules?.composer;
    if (!(composerRule === undefined ? lineFits(candidate, signature.composer) :
      composerRule(lines, i, signature, readingContext))) continue;
    // Reasoning is never drawn below the composer. A line with reasoning under
    // it is the echo of the person's prompt, taken for the composer while a
    // dialog stands in its place: no composer is found, so the filter reads
    // the whole screen and a result is refused.
    for (let j = i + 1; j < lines.length; j++) {
      if (signature.reasoning.some((block) => lineFits(lines[j]!, block.start))) return null;
    }
    let top = i;
    while (top > 0) {
      const above = lines[top - 1]!;
      if (!blank(above, signature.tidy) && !signature.chrome.some((test) => lineFits(above, test))) break;
      top--;
    }
    return { line: i, chrome: top };
  }
  return null;
}

/**
 * Whether every row of `[first, last]` sits inside one reasoning block that
 * began above `first`. The block scan here ignores claims: this is what
 * decides whether a claim is made at all.
 */
function enclosedByReasoning(
  lines: readonly StyledLine[],
  signature: CompiledSignature,
  first: number,
  last: number,
): boolean {
  const composer = composerAt(lines, signature);
  const limit = composer?.line ?? lines.length;
  return reasoningRanges(lines, signature, limit).some(([from, to]) => from < first && last < to);
}

/**
 * The rows a question on screen claims for itself: the prompt detection's
 * own rows (`promptDetector.ts`), and the rows of nothing but border beside
 * them, which belong to the question's box. A filter that hides reasoning
 * must never hide a question, so a hidden block is cut at the first of
 * these rows and never starts on one. Null when no question is on screen,
 * so the block scan below runs as before.
 *
 * A detection whose only signal is a question with nothing below it is not
 * claimed when that whole span sits inside a reasoning block that began
 * above the question: a numbered list the reasoning drew, on a screen that
 * happens to end there, is not a question the program is waiting on. A line
 * that begins a reasoning block between the question and the last option
 * stays reasoning too.
 */
function claimedRows(
  lines: readonly StyledLine[],
  signature: CompiledSignature,
  prompt: DetectedPrompt | null,
): ReadonlySet<number> | null {
  if (prompt === null) return null;
  const [first, last] = prompt.rows;
  if (prompt.basis === 'question' && enclosedByReasoning(lines, signature, first, last)) return null;
  let top = first;
  while (top > 0 && BORDER_ROW.test(lines[top - 1]!.text)) top--;
  let bottom = last;
  while (bottom + 1 < lines.length && BORDER_ROW.test(lines[bottom + 1]!.text)) bottom++;
  const rows = new Set<number>();
  for (let i = top; i <= bottom; i++) {
    // A one-line reasoning summary drawn between the question and the last
    // option is still reasoning. A start that also continues (the bar a
    // command is written on) is the prompt's own text, and stays.
    const summary = signature.reasoning.some(
      (block) => block.continues === undefined && lineFits(lines[i]!, block.start),
    );
    if (i > first && i < last && summary) continue;
    rows.add(i);
  }
  // A question keeps its own wrapped continuation rows. A continuation
  // cannot be claimed independently of the physical row above it.
  for (let i = top; i <= bottom; i++) {
    if (!rows.has(i)) continue;
    for (let j = i + 1; j < lines.length && lines[j]!.wrapped; j++) rows.add(j);
  }
  return rows;
}

/** `[from, to)` ranges of reasoning above `limit`. */
function reasoningRanges(
  lines: readonly StyledLine[],
  signature: CompiledSignature,
  limit: number,
  claimed?: ReadonlySet<number> | null,
): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  // The parent may have left the retained scrollback. There is no safe way
  // to classify a leading continuation, so hide it for reasoning signatures.
  if (signature.reasoning.length > 0) {
    while (i < limit && lines[i]!.wrapped) i++;
    if (i > 0) ranges.push([0, i]);
  }
  while (i < limit) {
    if (claimed?.has(i)) {
      i++;
      continue;
    }
    const block = signature.reasoning.find((b) => lineFits(lines[i]!, b.start));
    if (block === undefined) {
      i++;
      continue;
    }
    const end = blockEnd(lines, i, block, limit, signature.tidy, claimed);
    ranges.push([i, end]);
    i = end;
  }
  return ranges;
}

/** What `hideReasoning` gives back: the lines kept, where each came from, and how much went. */
export interface FilteredLines {
  lines: string[];
  /** For each kept line, its index in the input; a marker line has its block's first index. */
  rows: number[];
  /** Which kept lines are markers standing in for a hidden block. */
  markers: boolean[];
  hiddenLines: number;
  hiddenBlocks: number;
}

/** The line that stands in for a hidden block. */
export function hiddenMarker(count: number): string {
  return `[reasoning hidden: ${String(count)} line${count === 1 ? '' : 's'}]`;
}

/**
 * The lines from `firstVisible` on, with every reasoning block above the
 * composer replaced by one marker line. The lines before `firstVisible` are
 * context only: a block whose first line is among them is still recognised
 * where it carries on into what is returned. `rows` count from
 * `firstVisible`. Null when the signature was set aside for running past its
 * time budget, which the caller must treat as "cannot filter".
 */
export function hideReasoning(
  lines: readonly StyledLine[],
  signature: CompiledSignature,
  firstVisible = 0,
): FilteredLines | null {
  // Outside the signature's budget, so the two never nest. A signature with
  // no reasoning rules can hide nothing, so the detector is not run. Dialog
  // signatures are the only patterns the detector times (`dialogs.ts`); its
  // own patterns are not.
  const detected =
    signature.reasoning.length === 0 ? null : detectPrompt(lines.map((line) => line.wrapped ? '' : line.text).join('\n'), signature.name);
  return guarded(signature, () => {
    const claimed = claimedRows(lines, signature, detected);
    // Everything above the composer's own line, the chrome over it included:
    // a spinner there can carry the model's words about what it is thinking.
    const composer = composerAt(lines, signature);
    const limit = composer?.line ?? lines.length;
    const ranges = reasoningRanges(lines, signature, limit, claimed);
    const out: FilteredLines = { lines: [], rows: [], markers: [], hiddenLines: 0, hiddenBlocks: 0 };
    const keep = (i: number): void => {
      out.lines.push(lines[i]!.text);
      out.rows.push(i - firstVisible);
      out.markers.push(false);
    };
    let next = firstVisible;
    for (const [from, to] of ranges) {
      if (to <= firstVisible) continue;
      const start = Math.max(from, firstVisible);
      for (let i = next; i < start; i++) keep(i);
      out.lines.push(hiddenMarker(to - start));
      out.rows.push(start - firstVisible);
      out.markers.push(true);
      out.hiddenLines += to - start;
      out.hiddenBlocks++;
      next = to;
    }
    for (let i = next; i < lines.length; i++) keep(i);
    return out;
  });
}

/** What the CLI and the MCP tool say when there is no result to give. */
export function resultRefusal(reason: string): string {
  switch (reason) {
    case 'busy':
      return 'No result yet: the agent is still working on its turn.';
    case 'no-answer':
      return "No result: nothing below the latest prompt reads as the agent's answer.";
    case 'no-composer':
      return (
        "No result: the agent's composer is not on screen (a dialog, another view, or a " +
        'program still starting), so its turn cannot be read.'
      );
    case 'over-budget':
      return 'No result: the signature ran past the regular-expression time budget and was set aside for a minute.';
    case 'unfinished':
      return (
        'No result: the latest turn has no closing line, so it has not finished (it was ' +
        'interrupted, or ended without an answer).'
      );
    case 'prompt-typed':
      return 'No result: the composer holds a prompt that has not been sent, so the latest turn is about to change.';
    default:
      return 'No result.';
  }
}

/** What `terminal_result` gives back. */
export type AgentResult =
  | {
      found: true;
      /** The answer that ends the latest turn, as drawn. */
      answer: string[];
      /** A turn summary drawn after the answer, when the program draws one. */
      trailer: string[];
      /** The status lines under the composer. */
      status: string[];
      /** The echo of the prompt the answer follows, so a caller can check it is the one it sent. */
      prompt: string | null;
    }
  | {
      found: false;
      reason: 'busy' | 'no-composer' | 'no-answer' | 'over-budget' | 'unfinished' | 'prompt-typed';
      /** The status lines under the composer, when there is one. */
      status: string[];
    };

/**
 * The answer that ends the latest turn. It has to start below the latest
 * prompt the person typed, sit above the composer, and lie outside every
 * reasoning block; nothing else is ever returned in its place.
 */
export function latestResult(lines: readonly StyledLine[], signature: CompiledSignature): AgentResult {
  const result = guarded<AgentResult>(signature, () => {
    const composer = composerAt(lines, signature);
    if (composer === null) {
      const busy = moduleFor(signature.name)?.readingRules?.busyWithoutComposer === true && lines.some((line) =>
        signature.busy.some((test) => lineFits(line, test)));
      return { found: false, reason: busy ? 'busy' : 'no-composer', status: [] };
    }
    const status = lines
      .slice(composer.line + 1)
      .filter((line) => !blank(line) && !(signature.frame !== undefined && lineFits(line, signature.frame)))
      .map((line) => line.text);
    let turnStart = 0;
    let prompt: string | null = null;
    if (signature.turn !== undefined) {
      for (let i = composer.chrome - 1; i >= 0; i--) {
        if (lineFits(lines[i]!, signature.turn)) {
          turnStart = i + 1;
          prompt = lines[i]!.text.replace(/\s+$/u, '');
          break;
        }
      }
    }
    // A spinner can be drawn in the latest turn or the chrome under it;
    // a stale copy in the scrollback above says nothing.
    const busyRule = moduleFor(signature.name)?.readingRules?.busy;
    const busy = busyRule === undefined
      ? signature.busy.some(test => lines.slice(turnStart).some(line => lineFits(line, test)))
      : busyRule(lines, turnStart, composer.chrome, signature, readingContext);
    if (busy) return { found: false, reason: 'busy', status };
    if (signature.typed !== undefined) {
      for (let i = composer.chrome; i <= composer.line; i++) {
        if (lineFits(lines[i]!, signature.typed)) return { found: false, reason: 'prompt-typed', status };
      }
    }
    const ranges = reasoningRanges(lines, signature, composer.chrome);
    const inReasoning = (i: number): boolean => ranges.some(([from, to]) => i >= from && i < to);
    let start = -1;
    for (let i = composer.chrome - 1; i >= turnStart; i--) {
      if (!inReasoning(i) && lineFits(lines[i]!, signature.answer.start)) {
        start = i;
        break;
      }
    }
    if (start === -1) return { found: false, reason: 'no-answer', status };
    let end = blockEnd(lines, start, signature.answer, composer.chrome, signature.tidy);
    if (signature.answer.upward) {
      for (;;) {
        let above = start - 1;
        while (above >= turnStart && blank(lines[above], signature.tidy)) above--;
        if (above < turnStart || inReasoning(above) || !lineFits(lines[above]!, signature.answer.start)) break;
        start = above;
      }
    }
    const firstReasoningAfter = ranges.find(([from]) => from > start);
    if (firstReasoningAfter !== undefined) end = Math.min(end, firstReasoningAfter[0]);
    const tidy = (text: string): string =>
      (signature.tidy === undefined ? text : text.replace(signature.tidy, '')).replace(/\s+$/u, '');
    const trailer: string[] = [];
    if (signature.trailer !== undefined) {
      for (let i = end; i < composer.chrome; i++) {
        if (lineFits(lines[i]!, signature.trailer)) trailer.push(tidy(lines[i]!.text));
      }
    }
    if (signature.requireTrailer && trailer.length === 0) return { found: false, reason: 'unfinished', status };
    return { found: true, answer: lines.slice(start, end).map((line) => tidy(line.text)), trailer, status, prompt };
  });
  return result ?? { found: false, reason: 'over-budget', status: [] };
}

const readingContext = { matches: lineFits, ink: inkStyles, ranges: reasoningRanges };

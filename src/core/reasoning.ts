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
 * Both readers fail closed. A session whose program has no signature is
 * refused rather than shown unfiltered, and `terminal_result` refuses when it
 * cannot find an answer it recognises, rather than returning something else.
 * What the filter cannot promise: a program that draws its reasoning in a
 * shape its signature does not describe, a new version that changes the
 * shape, or a screen that imitates one, defeats it. Screen content is
 * untrusted input either way (design §4.4).
 *
 * Every pattern runs under the regular-expression time budget
 * (`regexBudget.ts`), as patterns from config are text a person wrote.
 */

import { RegexBudgetError, SET_ASIDE_MS, withRegexBudget } from './regexBudget.js';
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

// ---------------------------------------------------------------- built in

const RULE = '^[─━]{10,}$';
const RULE_INDENTED = '^\\s*[─━]{10,}';

/**
 * Built-in signatures. Each comment names the screens its fixtures come from.
 */
export const BUILT_IN_SIGNATURES: readonly AgentSignature[] = [
  {
    // Claude Code 2.1.312, default view and the ctrl+o transcript: no
    // reasoning text is drawn in either, only a spinner line while the model
    // thinks ("✻ Pondering… (2s · thinking with xhigh effort)"). The answer
    // is a `●` in the text colour; tool calls get a grey or coloured `●`.
    name: 'claude',
    programs: ['claude'],
    measured: 'Claude Code 2.1.312',
    // The composer's prompt glyph is followed by a non-breaking space once
    // something is typed; the echo of a sent prompt by an ordinary one.
    composer: { text: '^❯( |\\xa0|$)' },
    typed: { text: '^❯[ \\xa0]\\S', word: { dim: false } },
    chrome: [{ text: RULE }, { text: '/effort\\s*$' }],
    frame: { text: RULE },
    busy: [{ text: '^[✻✽✶✢✳·*] \\S+…' }],
    turn: { text: '^❯ \\S' },
    answer: {
      start: { text: '^● ', lead: { fg: ['default', '#ffffff', '#000000'] } },
      continues: { text: '^ {2}' },
    },
    trailer: { text: '^✻ \\S' },
    requireTrailer: true,
  },
  {
    // Codex CLI 0.165.0 (GPT-6-Sol, high effort), default view. The answer is
    // a dim "•" with plain text after it; a tool group is a dim "•" with a
    // bold heading ("Explored"), a command a bold green "•" ("Ran"). While a
    // turn runs, "Working (Ns • esc to interrupt)" sits above the composer.
    name: 'codex',
    programs: ['codex'],
    measured: 'Codex CLI 0.165.0',
    composer: { text: '^› ' },
    // The placeholder ("Ask Codex to do anything") is dim; typed text is not.
    typed: { text: '^› \\S', word: { dim: false } },
    chrome: [{ text: 'esc to interrupt' }],
    busy: [{ text: 'esc to interrupt' }],
    turn: { text: '^› \\S' },
    answer: {
      start: { text: '^• ', lead: { dim: true }, word: { bold: false, italic: false } },
      continues: { text: '^ {2}(?!Worked for )[^\\s└]' },
    },
    trailer: { text: '^ {2}Worked for ' },
    requireTrailer: true,
  },
  {
    // Antigravity CLI 1.4.10 (Gemini 3.8 Flash, high effort). A summary of
    // the model's reasoning stays on screen as one line, "○ Thought for 4.2s
    // (Create the file, then…)"; while it works, the spinner's label is the
    // subject of what it is thinking about. "▸ Thought for 5s, 228 tokens"
    // carries no text. Tool calls are a green "●"; the answer is plain text
    // indented two spaces. While a turn runs, "esc to cancel" is under the
    // composer.
    name: 'agy',
    programs: ['agy', 'antigravity'],
    measured: 'Antigravity CLI 1.4.10',
    composer: { text: '^>' },
    chrome: [{ text: RULE_INDENTED }, { text: '^[⠀-⣿] {2}' }, { text: '^└ ' }],
    frame: { text: RULE_INDENTED },
    busy: [{ text: '^[⠀-⣿] {2}\\S' }, { text: '^esc to cancel' }],
    turn: { text: '^> \\S' },
    reasoning: [
      { start: { text: '^○ Thought for ' } },
      { start: { text: '^[⠀-⣿] {2}\\S' } },
    ],
    answer: {
      start: { text: '^ {2}\\S', lead: { fg: ['default', '#ffffff', '#000000', 'p7', 'p15'] } },
      continues: { text: '^ {2}\\S', lead: { fg: ['default', '#ffffff', '#000000', 'p7', 'p15'] } },
      upward: true,
    },
  },
  {
    // Grok Build 1.0.70 (grok-4.7, xhigh effort). While the model thinks, its
    // reasoning streams into a block behind a fading "│" bar, headed
    // "♦ Thinking…"; once it is done the block collapses to "♦ Thought for
    // Ns" with nothing under it. Messages and the answer are plain text
    // indented five spaces; tool work is a "♦" line ("♦ Edited primes.py, ran
    // 1 command"); "Worked for Ns" closes the turn. While a turn runs, a
    // spinner line ("| Thinking… 3.1s") sits above the composer's box.
    name: 'grok',
    programs: ['grok'],
    measured: 'Grok Build 1.0.70',
    composer: { text: '^ {2}│ >' },
    chrome: [{ text: '^ {2}╭' }, { text: '^ {3}[|/\\\\-] \\S' }, { text: '^ {3}\\S.*shift\\+tab', }],
    frame: { text: '^ {2}[╭╰]' },
    busy: [{ text: '^ {3}[|/\\\\-] .* \\d+(?:\\.\\d+)?s\\s*$' }, { text: '♦ Thinking…' }],
    turn: { text: '^ {5}> \\S' },
    reasoning: [
      {
        start: { text: '^ {2}│ {2}♦ Thinking' },
        continues: { text: '^ {2}│' },
      },
      // The spinner's label can be the model's own words about what it is
      // doing; it goes too, and the busy state still shows in the result.
      { start: { text: '^ {3}[|/\\\\-] \\S' } },
      // The bar on its own: the heading may have scrolled away.
      {
        start: { text: '^ {2}│ {2}\\S' },
        continues: { text: '^ {2}│' },
      },
    ],
    answer: {
      start: { text: '^ {5}(?!Worked for )[^\\s♦>]', lead: { fg: ['default', '#c8c8c8', '#ffffff', '#000000'] } },
      continues: { text: '^ {5}(?!Worked for )[^\\s♦>]', lead: { fg: ['default', '#c8c8c8', '#ffffff', '#000000'] } },
      upward: true,
    },
    trailer: { text: '^ {5}Worked for ' },
    requireTrailer: true,
    // A right-aligned time on each message row.
    tidy: ' {2,}\\d{1,2}:\\d{2}(?: ?[A-Za-z]{2})?\\s*$',
  },
  {
    // OpenCode 2.0.26 (GLM-5.3): no reasoning text is drawn. While the model
    // thinks it shows "⠇ Thinking"; afterwards a collapsed "+ Thought · Ns"
    // with nothing under it. The answer is plain paragraphs, in the same
    // colour and indent as any other text, closed by a footer naming the
    // agent, the model and the time ("Build · GLM-5.3 · 7.0s"). A sidebar
    // can share the rows on the right.
    name: 'opencode',
    programs: ['opencode'],
    measured: 'OpenCode 2.0.26',
    composer: { text: '^ {2}[┃╹]' },
    chrome: [{ text: '^ {2}┃' }, { text: '^\\s{60,}\\S' }],
    busy: [
      { text: '\\besc interrupt\\b' },
      { text: '^ {3,}[⠀-⣿] ' },
      { text: '^ {3,}\\+ Thought\\s*$' },
    ],
    turn: { text: '^ {2}┃ {2}\\S' },
    answer: {
      start: { text: '^ {5}[^\\s→+⠀-⣿]', lead: { fg: ['default', '#eeeeee', '#ffffff', '#000000'] } },
      continues: { text: '^ {5}[^\\s→+⠀-⣿]', lead: { fg: ['default', '#eeeeee', '#ffffff', '#000000'] } },
      upward: true,
    },
    trailer: { text: '^ {5}\\S+ · [^·]+ · \\d[\\d.]*m?s\\b' },
    requireTrailer: true,
    // The sidebar, on the same rows to the right.
    tidy: ' {20,}\\S.*$',
  },
  {
    // MiMoCode 0.1.16 (MiMo-V2.6-Pro), built from OpenCode: no reasoning text
    // is drawn. A collapsed "+ Thought: Ns" sits before each tool group and
    // before the answer; tool calls are boxes behind a bar drawn in the
    // background colour, the person's prompt and the composer behind one in
    // the agent's colour. The answer is plain paragraphs closed by "▣ Build ·
    // MiMo-V2.6-Pro · Ns", which carries no time while the turn runs. A side
    // panel on the right shares the rows (the session's title, context and
    // cost). The composer can hold a suggestion of its own after a turn.
    name: 'mimo',
    programs: ['mimo', 'mimocode', 'mimo-code'],
    measured: 'MiMoCode 0.1.16',
    composer: { text: '^ {2}[┃╹]' },
    chrome: [{ text: '^ {2}┃' }, { text: '^\\s{60,}\\S' }],
    busy: [
      { text: '\\besc (?:to )?interrupt\\b' },
      { text: '^ {5}▣ {2}\\S+ · [^·]+?\\s*(?:[⎘█].*)?$' },
      { text: '^ {3,}[⠀-⣿] ' },
    ],
    turn: { text: '^ {2}┃ {2}\\S', lead: { notFg: ['#0a0a0a'] } },
    answer: {
      start: { text: '^ {5}[^\\s→+⠀-⣿▣]' },
      continues: { text: '^ {5}[^\\s→+⠀-⣿▣]' },
      upward: true,
    },
    trailer: { text: '^ {5}▣ {2}\\S+ · [^·]+ · \\d' },
    requireTrailer: true,
    // The scrollbar, the side panel and the copy button, on the same rows.
    tidy: '\\s+[⎘█].*$',
  },
  {
    // Qoder CLI 1.1.80 (GLM-5.3), default thinking: a "Thinking" heading in
    // italics, then the reasoning behind a grey "│" bar in grey italics, as
    // the model works and after it has answered. Messages start with a "▪"
    // in the text colour, tool calls with a green one. While a turn runs, a
    // braille spinner line says "(esc to cancel, Ns)".
    name: 'qoder',
    programs: ['qodercli', 'qoder'],
    measured: 'Qoder CLI 1.1.80',
    composer: { text: '^ > ' },
    // The placeholder ("Type your message or @path/to/file") is grey; typed text is not.
    typed: { text: '^ > ', word: { notFg: ['#95958f'] } },
    chrome: [
      { text: RULE_INDENTED },
      { text: 'Shift\\+Tab' },
      { text: '\\? for shortcuts\\s*$' },
      { text: '\\(esc to cancel' },
    ],
    frame: { text: RULE_INDENTED },
    busy: [{ text: '\\(esc to cancel' }],
    turn: { text: '^ > \\S' },
    reasoning: [
      // The bar by its text alone: a code span or a table inside the
      // reasoning is drawn upright, and an upright line is still reasoning.
      {
        start: { text: '^ Thinking\\s*$', lead: { italic: true } },
        continues: { text: '^ │( |$)' },
      },
      // The same bar on its own: the heading may have scrolled away.
      {
        start: { text: '^ │ ' },
        continues: { text: '^ │( |$)' },
      },
    ],
    answer: {
      start: { text: '^ ▪ ', lead: { fg: ['default', '#eeeeeb', '#ffffff', '#000000'] } },
      continues: { text: '^ {3}[^\\s└│]' },
    },
  },
];

// ---------------------------------------------------------------- compiling

interface CompiledStyle {
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  fg?: Set<string>;
  notFg?: Set<string>;
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
    } else if (key === 'fg' || key === 'notFg') {
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
      });
      usable.push(index);
    } catch (error) {
      problems.push(`${error instanceof Error ? error.message : String(error)}: ignored`);
    }
  });
  return { signatures, problems, usable };
}

let active: CompiledSignature[] = compileSignatures(BUILT_IN_SIGNATURES, 'built-in').signatures;
let reportOverBudget: (name: string) => void = () => undefined;

/**
 * Use the built-in signatures plus `extra`, the entries from config; an entry
 * named like a built-in one replaces it. Returns what was wrong with `extra`.
 */
export function useAgentSignatures(
  extra: readonly unknown[],
  onOverBudget: (name: string) => void = () => undefined,
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

/** The names `terminal_start`'s `agent` accepts. */
export function agentNames(): string[] {
  return active.map((s) => s.name).sort();
}

/** A program's name from its start command: `C:\x\Claude.EXE` is `claude`. */
export function programName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/i, '').toLowerCase();
}

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
  return ordered.find((signature) => signature.programs.includes(program))?.name ?? null;
}

/**
 * The signature for a session: the agent it was started as, or the one whose
 * programs include its start command. Null when neither names one.
 */
export function signatureFor(agent: string | undefined, command: string): CompiledSignature | null {
  if (agent !== undefined) return active.find((s) => s.name === agent && !setAside(s)) ?? null;
  const program = programName(command);
  return active.find((s) => !setAside(s) && s.programs.includes(program)) ?? null;
}

// ---------------------------------------------------------------- matching

function styleFits(style: CellStyle, test: CompiledStyle): boolean {
  if (test.bold !== undefined && style.bold !== test.bold) return false;
  if (test.dim !== undefined && style.dim !== test.dim) return false;
  if (test.italic !== undefined && style.italic !== test.italic) return false;
  const fg = style.fg ?? 'default';
  if (test.fg !== undefined && !test.fg.has(fg)) return false;
  if (test.notFg !== undefined && test.notFg.has(fg)) return false;
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
): number {
  let end = at + 1;
  if (block.continues === undefined) return end;
  let i = at + 1;
  while (i < limit) {
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
    reportOverBudget(signature.name);
    return null;
  }
}

/** The index of the composer's line and the first line of chrome, or null. */
function composerAt(lines: readonly StyledLine[], signature: CompiledSignature): { line: number; chrome: number } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lineFits(lines[i]!, signature.composer)) continue;
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

/** `[from, to)` ranges of reasoning above `limit`. */
function reasoningRanges(lines: readonly StyledLine[], signature: CompiledSignature, limit: number): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < limit) {
    const block = signature.reasoning.find((b) => lineFits(lines[i]!, b.start));
    if (block === undefined) {
      i++;
      continue;
    }
    const end = blockEnd(lines, i, block, limit, signature.tidy);
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
  return guarded(signature, () => {
    // Everything above the composer's own line, the chrome over it included:
    // a spinner there can carry the model's words about what it is thinking.
    const composer = composerAt(lines, signature);
    const limit = composer?.line ?? lines.length;
    const ranges = reasoningRanges(lines, signature, limit);
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
    if (composer === null) return { found: false, reason: 'no-composer', status: [] };
    const status = lines
      .slice(composer.line + 1)
      .filter((line) => !blank(line) && !(signature.frame !== undefined && lineFits(line, signature.frame)))
      .map((line) => line.text);
    if (signature.typed !== undefined) {
      for (let i = composer.chrome; i <= composer.line; i++) {
        if (lineFits(lines[i]!, signature.typed)) return { found: false, reason: 'prompt-typed', status };
      }
    }
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
    // The latest turn and the chrome under it: a spinner can be drawn in
    // either, and a stale copy in the scrollback above says nothing.
    const current = lines.slice(turnStart);
    if (signature.busy.some((test) => current.some((line) => lineFits(line, test)))) {
      return { found: false, reason: 'busy', status };
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

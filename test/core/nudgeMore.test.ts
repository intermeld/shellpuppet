import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agy } from '../../src/agents/agy/index.js';
import { grok } from '../../src/agents/grok/index.js';
import { mimo } from '../../src/agents/mimo/index.js';
import { opencode } from '../../src/agents/opencode/index.js';
import type { AgentModule, NudgeView } from '../../src/agents/types.js';
import { NUDGE_QUIET_MS, nudgeVerdict } from '../../src/core/nudge.js';
import type { NudgeObservation } from '../../src/core/nudge.js';
import type { StyledLine } from '../../src/core/renderer.js';

const fixtures = path.join(__dirname, '..', 'fixtures', 'nudge');
const modules = { opencode, mimo, grok, agy };
const ink = { bold: false, dim: false, italic: false, inverse: false, fg: null, bg: null };

function load(name: string): NudgeObservation {
  const rows = fs.readFileSync(path.join(fixtures, `${name}.txt`), 'utf8').trimEnd().split(/\r?\n/u);
  const styled: StyledLine[] = rows.map((text) => ({ text, spans: text.length === 0 ? [] : [{ ...ink, from: 0, to: text.length }] }));
  const placeholder = name === 'opencode-empty' ? 'Ask anything… "What is the tech stack of this project?"'
    : name === 'mimo-empty' ? 'Type your message... (type / for commands)'
      : name === 'mimo-after-empty' ? 'now say hello  (Tab to accept)'
        : name === 'agy-empty' ? 'Auto mode: edits & safe commands auto-approved (shift+tab to cycle)' : '';
  if (placeholder !== '') {
    const capture = fs.readFileSync(path.join(fixtures, `${name}.ansi`), 'utf8');
    const colour = name === 'agy-empty' ? '\x1b[90m' : '\x1b[38;2;128;128;128m';
    if (!capture.includes(`${colour}${placeholder}`)) throw new Error(`Missing captured placeholder ink in ${name}`);
    const index = rows.findIndex((row) => row.includes(placeholder));
    if (index < 0) throw new Error(`Missing placeholder in ${name}`);
    const start = rows[index]!.indexOf(placeholder);
    styled[index] = { text: rows[index]!, spans: [
      { ...ink, from: 0, to: start },
      { ...ink, fg: name === 'agy-empty' ? 'p8' : '#808080', from: start, to: start + placeholder.length },
      { ...ink, from: start + placeholder.length, to: rows[index]!.length },
    ] };
  }
  const cursor = name === 'opencode-after-empty' ? { x: 5, y: rows.findIndex(row => row.startsWith('  ╹▀')) - 3 } : undefined;
  return { rows, styled, cursor, viewportRows: rows.length, unchangedMs: NUDGE_QUIET_MS };
}

function livePlaceholder(name: 'opencode-empty' | 'mimo-empty'): NudgeObservation {
  const welcome = load(name);
  const screen = load(`${name.split('-')[0]}-after-empty`);
  const placeholder = name === 'opencode-empty' ? 'Ask anything… "What is the tech stack of this project?"'
    : 'Type your message... (type / for commands)';
  const frame = lastIndexWhere(screen.rows, (row) => /^\s*╹▀{8,}/u.test(row));
  const source = welcome.styled!.find((line) => line.text.includes(placeholder));
  if (frame < 0 || source === undefined) throw new Error('Missing captured composer');
  const row = `  ┃  ${placeholder}`;
  const start = row.indexOf(placeholder);
  const rows = [...screen.rows];
  rows[frame - 3] = row;
  const styled = screen.styled!.map((line, index) => index === frame - 3
    ? { text: row, spans: [
      { ...ink, from: 0, to: start },
      { ...ink, fg: '#808080', from: start, to: row.length },
    ] }
    : line);
  return { ...screen, rows, styled };
}

function judgement(module: AgentModule, view: NudgeView): string {
  if (module.nudge === undefined) throw new Error(`Missing nudge judgement: ${module.name}`);
  return module.nudge.readiness(view);
}

function lastIndexWhere(rows: readonly string[], matches: (row: string) => boolean): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (matches(rows[i] ?? '')) return i;
  }
  return -1;
}

for (const [name, module] of Object.entries(modules)) {
  describe(`${name} nudge readiness`, () => {
    for (const [capture, expected] of [
      ['empty', name === 'mimo' ? 'unknown' : 'ready'],
      ['draft', name === 'mimo' ? 'unknown' : 'draft'],
      ['after-empty', 'ready'], ['after-draft', 'draft'],
    ] as const) {
      it(`${capture} is ${expected}`, () => {
        const screen = load(`${name}-${capture}`);
        expect(judgement(module, screen)).toBe(expected);
        expect(nudgeVerdict(module, screen)).toEqual(expected === 'ready' ? { ready: true } : { ready: false, reason: expected });
      });
    }

    it('is busy when its running marker appears above the composer', () => {
      const screen = load(`${name}-after-empty`);
      const marker = name === 'opencode' ? '   ⠇ Working          +' : name === 'mimo' ? '   esc interrupt'
        : name === 'grok' ? '   | Thinking… 3.1s' : 'esc to cancel';
      const rows = [...screen.rows];
      rows.splice(name === 'mimo' || name === 'opencode' ? 0 : Math.max(0, rows.length - 6), 0, marker);
      expect(judgement(module, { rows })).toBe('busy');
    });

    it('is unknown when the composer is missing', () => {
      expect(judgement(module, { rows: ['A finished turn with no visible input'] })).toBe('unknown');
    });

    it('is unknown when its frame is missing', () => {
      expect(judgement(module, { rows: ['>'] })).toBe('unknown');
      const screen = load(`${name}-after-empty`);
      const rows = [...screen.rows];
      const frame = name === 'grok' ? lastIndexWhere(rows, (row) => /^ {2}╭─/u.test(row))
        : name === 'agy' ? lastIndexWhere(rows, (row) => /^─{10,}/u.test(row)) - 2
          : lastIndexWhere(rows, (row) => /^\s*╹▀{8,}/u.test(row));
      if (frame < 0) throw new Error('Missing captured frame');
      rows.splice(frame, 1);
      expect(judgement(module, { rows })).toBe('unknown');
    });

    it('is unknown when plain and styled rows disagree', () => {
      const screen = load(`${name}-after-empty`);
      const rows = [...screen.rows];
      const index = name === 'grok' ? lastIndexWhere(rows, (row) => /^ {2}│ > /u.test(row))
        : name === 'agy' ? lastIndexWhere(rows, (row) => row === '>')
          : lastIndexWhere(rows, (row) => /^\s*┃ {2}Build · /u.test(row)) - 2;
      if (index < 0) throw new Error('Missing captured composer row');
      rows[index] = `${rows[index]}${name === 'opencode' || name === 'mimo' ? '  x' : 'x'}`;
      expect(judgement(module, { rows, styled: screen.styled })).toBe('unknown');
    });
  });
}

describe('placeholder ink', () => {
  for (const name of ['opencode-empty', 'mimo-empty', 'mimo-after-empty', 'agy-empty'] as const) {
    it(`${name} in ordinary ink is a draft`, () => {
      const screen = name === 'opencode-empty' || name === 'mimo-empty' ? livePlaceholder(name) : load(name);
      const styled = screen.styled!.map((line) => ({ ...line, spans: line.spans.map((span) => ({ ...span, fg: null })) }));
      expect(judgement(modules[name.split('-')[0] as keyof typeof modules], { rows: screen.rows, styled })).toBe('draft');
    });
  }
  it('requires the exact placeholder words', () => {
    const screen = livePlaceholder('mimo-empty');
    const rows = screen.rows.map((row) => row.replace('Type your message...', 'Type your massage...'));
    const styled = screen.styled!.map((line, index) => ({ ...line, text: rows[index]! }));
    expect(judgement(mimo, { rows, styled })).toBe('draft');
  });
});

describe('waiting choices', () => {
  it('blocks OpenCode and MiMo permission dialogs', () => {
    const rows = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'dialogs', 'opencode-permission-dialog.txt'), 'utf8').split(/\r?\n/u);
    for (const module of [opencode, mimo]) {
      expect(nudgeVerdict(module, { rows, viewportRows: rows.length, unchangedMs: NUDGE_QUIET_MS }))
        .toEqual({ ready: false, reason: 'prompt' });
    }
  });

  it('blocks a numbered menu in Grok and Antigravity', () => {
    const rows = ['Choose one:', '  ❯ 1. Allow once', '    2. Reject and type something'];
    for (const module of [grok, agy]) {
      expect(nudgeVerdict(module, { rows, viewportRows: rows.length, unchangedMs: NUDGE_QUIET_MS }))
        .toEqual({ ready: false, reason: 'prompt' });
    }
  });
});

describe('bar composer boundaries', () => {
  for (const name of ['opencode', 'mimo'] as const) {
    it(`${name} keeps a typed star in the input cells`, () => {
      const screen = load(`${name}-after-empty`);
      const rows = [...screen.rows];
      const frame = lastIndexWhere(rows, (row) => /^\s*╹▀{8,}/u.test(row));
      rows[frame - 3] = '  ┃     ✦draft';
      expect(judgement(modules[name], { rows })).toBe('draft');
    });
  }

  it('ignores decoration beyond the composer width in its own ink', () => {
    const screen = load('mimo-after-empty');
    const rows = [...screen.rows];
    const frame = lastIndexWhere(rows, (row) => /^\s*╹▀{8,}/u.test(row));
    const starAt = /^\s*╹▀{8,}/u.exec(rows[frame]!)![0].length;
    rows[frame - 3] = `${rows[frame - 3]}${' '.repeat(starAt - rows[frame - 3]!.length)}✧`;
    const styled = screen.styled!.map((line, index) => index === frame - 3
      ? { text: rows[index]!, spans: [...line.spans,
        { ...ink, from: line.text.length, to: starAt },
        { ...ink, fg: '#ccbd92', from: starAt, to: starAt + 1 }] }
      : line);
    expect(judgement(mimo, { rows, styled })).toBe('ready');
  });
});

describe('bar screen identity', () => {
  for (const capture of ['empty', 'draft', 'after-empty', 'after-draft'] as const) {
    it(`rejects the other bar screen on ${capture}`, () => {
      for (const [module, name] of [[mimo, 'opencode'], [opencode, 'mimo']] as const) {
        const screen = load(`${name}-${capture}`);
        expect(judgement(module, screen)).toBe('unknown');
      }
    });
  }

  it('requires its own footer even when the other screen has matching hints', () => {
    const screen = load('opencode-after-empty');
    const rows = [...screen.rows];
    const frame = lastIndexWhere(rows, (row) => /^\s*╹▀{8,}/u.test(row));
    rows[frame + 1] = '  tab switch mode';
    expect(judgement(mimo, { rows })).toBe('unknown');
  });

  it('requires the switch hint beside its own composer', () => {
    const screen = load('mimo-after-empty');
    const rows = [...screen.rows];
    const frame = lastIndexWhere(rows, (row) => /^\s*╹▀{8,}/u.test(row));
    rows[frame + 1] = '  no switch hint';
    expect(judgement(mimo, { rows })).toBe('unknown');
  });
});

describe('live composer position', () => {
  for (const [name, module] of Object.entries(modules)) {
    it(`${name} requires blank rows after the completed footer`, () => {
      const screen = load(`${name}-after-empty`);
      const later = [...screen.rows, 'Later transcript output', 'Another line'];
      const styled = [...screen.styled!, ...later.slice(screen.rows.length).map((text) => ({ text, spans: [] }))];
      expect(judgement(module, { rows: later, styled })).toBe('unknown');
      expect(nudgeVerdict(module, { rows: later, styled, viewportRows: later.length, unchangedMs: NUDGE_QUIET_MS }))
        .toEqual({ ready: false, reason: 'unknown' });
    });

    it(`${name} accepts blank rows after the completed footer`, () => {
      const screen = load(`${name}-after-empty`);
      const rows = [...screen.rows, '', '   '];
      const styled = [...screen.styled!, { text: '', spans: [] }, { text: '   ', spans: [] }];
      expect(judgement(module, { ...screen, rows, styled })).toBe('ready');
    });
  }

  it('requires both rows immediately below the boxed composer', () => {
    const screen = load('grok-after-empty');
    const rows = [...screen.rows];
    const box = lastIndexWhere(rows, (row) => /^ {2}╰─/u.test(row));
    rows.splice(box + 1, 2);
    expect(judgement(grok, { rows })).toBe('unknown');
  });

  it('requires the boxed composer status row', () => {
    const screen = load('grok-after-empty');
    const rows = [...screen.rows];
    const box = lastIndexWhere(rows, (row) => /^ {2}╰─/u.test(row));
    rows[box + 1] = '';
    expect(judgement(grok, { rows })).toBe('unknown');
  });

  it('requires the boxed composer key hints', () => {
    const screen = load('grok-after-empty');
    const rows = [...screen.rows];
    const box = lastIndexWhere(rows, (row) => /^ {2}╰─/u.test(row));
    rows[box + 2] = '';
    expect(judgement(grok, { rows })).toBe('unknown');
  });

  it('requires the bar composer footer', () => {
    for (const name of ['opencode', 'mimo'] as const) {
      const screen = load(`${name}-after-empty`);
      const rows = [...screen.rows];
      const frame = lastIndexWhere(rows, (row) => /^\s*╹▀{8,}/u.test(row));
      rows[frame + 1] = '';
      expect(judgement(modules[name], { rows })).toBe('unknown');
    }
  });

  it('requires the continued hint below the bar footer to be recognised', () => {
    const screen = load('mimo-after-empty');
    const rows = [...screen.rows];
    rows[rows.length - 1] = 'Another line';
    expect(judgement(mimo, { rows })).toBe('unknown');
  });

  const scrolled = () => {
    const screen = load('agy-after-empty');
    const rows = screen.rows.slice(0, 11);
    rows[8] = '>';
    rows[9] = screen.rows[14]!;
    return rows;
  };

  it('does not use a transcript block as the composer', () => {
    expect(judgement(agy, { rows: scrolled() })).toBe('unknown');
  });

  it('requires a visible footer after the last block', () => {
    expect(judgement(agy, { rows: scrolled().slice(0, 10) })).toBe('unknown');
  });

  it('requires only blank rows after the footer', () => {
    const screen = load('agy-after-empty');
    expect(judgement(agy, { rows: [...screen.rows, 'Another visible line'] })).toBe('unknown');
  });
});

describe('the line before Enter', () => {
  for (const [name, module] of Object.entries(modules)) {
    it(`${name} submits only when the composer holds exactly the nudge`, () => {
      const empty = load(`${name}-after-empty`);
      const draft = load(`${name}-after-draft`);
      expect(nudgeVerdict(module, { ...empty, unchangedMs: 0, expectedDraft: 'fixed nudge' }))
        .toEqual({ ready: false, reason: 'draft' });
      expect(nudgeVerdict(module, { ...draft, unchangedMs: 0, expectedDraft: 'other words' }))
        .toEqual({ ready: false, reason: 'draft' });
      expect(nudgeVerdict(module, { ...draft, unchangedMs: 0, expectedDraft: 'draft words not sent' }))
        .toEqual({ ready: true });
      if (module === grok || module === mimo) {
        const expectedDraft = 'draft words not sent';
        const y = draft.rows.findIndex(row => row.includes(expectedDraft));
        const x = draft.rows[y]!.indexOf(expectedDraft) + expectedDraft.length;
        const view = { ...draft, expectedDraft, recoveringDraft: true };
        expect(nudgeVerdict(module, { ...view, cursor: { x, y } }).ready).toBe(true);
        expect(nudgeVerdict(module, { ...view, cursor: { x: x + 1, y } }).ready).toBe(false);
      }
    });
  }
});

describe('Grok square composer', () => {
  it('accepts the empty after-turn composer with an unfilled one per cent status', () => {
    const screen = load('grok-square-after-empty');
    expect(judgement(grok, screen)).toBe('ready');
    expect(nudgeVerdict(grok, screen)).toEqual({ ready: true });
  });

  it('keeps typed words as a draft and accepts only the exact submitted line', () => {
    const screen = load('grok-square-after-draft');
    expect(judgement(grok, screen)).toBe('draft');
    expect(judgement(grok, { ...screen, expectedDraft: 'draft words not sent' })).toBe('ready');
    expect(judgement(grok, { ...screen, expectedDraft: 'other words' })).toBe('draft');
  });

  it('fails closed when the recorded draft has no proven status row', () => {
    expect(judgement(grok, load('grok-square-draft-timeout'))).toBe('unknown');
  });

  it('accepts the empty welcome composer only with its live footer', () => {
    const screen = load('grok-square-welcome');
    expect(judgement(grok, screen)).toBe('ready');
    expect(judgement(grok, { rows: screen.rows.slice(0, -1) })).toBe('unknown');
    expect(judgement(grok, { rows: [...screen.rows, 'Later output'] })).toBe('unknown');
    const draft = screen.rows.map((row) => row.replace('│ > ', '│ > typed '));
    expect(judgement(grok, { rows: draft })).toBe('draft');
  });

  it('requires matching frame corners and the after-turn footer', () => {
    const screen = load('grok-square-after-empty');
    const mixed = screen.rows.map((row) => row.replace(/^ {2}└─/u, '  ╰─'));
    expect(judgement(grok, { rows: mixed })).toBe('unknown');
    const noHints = screen.rows.map((row) => row.replace('Shift+Tab:mode', 'Other text'));
    expect(judgement(grok, { rows: noHints })).toBe('unknown');
  });
});

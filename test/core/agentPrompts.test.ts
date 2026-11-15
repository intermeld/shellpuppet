import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_MODULES } from '../../src/agents/index.js';
import { detectPrompt } from '../../src/core/promptDetector.js';
import { ScreenRenderer, type StyledLine, type StyleSpan } from '../../src/core/renderer.js';
import { useDialogSignatures } from '../../src/core/dialogs.js';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

afterEach(() => { useDialogSignatures([]); });

describe('prompt shapes by resolved agent', () => {
  it.each(['opencode', 'mimo'])('runs %s menus and the shared generic detector', (agent) => {
    expect(detectPrompt(fixture('dialogs/mimo-question-menu.txt'), agent)?.options).toContain('Type your own answer');
    expect(detectPrompt(fixture('dialogs/opencode-permission-dialog.txt'), agent)?.question).toContain('Permission required');
    expect(detectPrompt('Continue? (y/n)', agent)?.question).toBe('Continue? (y/n)');
    expect(detectPrompt('Press enter to continue', agent)?.basis).toBe('frame');
  });

  it.each([...AGENT_MODULES.map(module => module.name), 'custom'])('runs every module shape for %s', (agent) => {
    for (const name of ['dialogs/mimo-question-menu.txt', 'dialogs/opencode-permission-dialog.txt', 'muse-live-129-menu.txt']) {
      expect(detectPrompt(fixture(name), agent), name).toEqual(detectPrompt(fixture(name)));
      expect(detectPrompt(fixture(name), agent), name).not.toBeNull();
    }
  });

  it('keeps configured dialogs available alongside every module', () => {
    useDialogSignatures([{ name: 'custom', title: '^Custom permission', choices: '^Accept {2,}Reject' }]);
    for (const module of AGENT_MODULES) {
      expect(detectPrompt('Custom permission\nAccept  Reject', module.name)?.options).toEqual(['Accept', 'Reject']);
    }
  });
});

describe('clipped OpenCode question panels', () => {
  const clipped = fixture('dialogs/opencode-question-clipped.txt').trimEnd();
  const rows = clipped.split('\n');
  const question = 'Which release plan should the team use for the next iteration? Consider the schedule, available people and support work before making a choice. The options below describe three ways to organise the next set of tasks so the team can begin.';

  // Colours measured from the live ANSI capture and the OpenCode composer capture.
  function styledFrame(frame: string[], composer = false): StyledLine[] {
    const header = frame.findIndex(row => /^ *┃ {2}Questions\s*$/u.test(row));
    return frame.map((raw, index) => {
      const text = raw.trimEnd();
      const spans: StyleSpan[] = [];
      const add = (from: number, to: number, fg: string, bg: string) => {
        if (to > from) spans.push({ from, to, fg, bg, bold: false, dim: false, italic: false, inverse: false });
      };
      if (!/^ {2}┃/u.test(text)) return { text, spans };
      add(0, 2, '#ffffff', '#0a0a0a');
      if (composer || index < header - 1) {
        add(2, text.length, '#5c9cf5', '#0a0a0a');
      } else {
        add(2, Math.min(3, text.length), '#fab283', '#141414');
        const description = /^ {2}┃ {5}\S/u.test(text);
        const option = /^ {2}┃ {2}[1-4]\. /u.test(text);
        add(3, Math.min(description ? 8 : 5, text.length), '#fab283', '#141414');
        if (index === header || description) add(description ? 8 : 5, text.length, '#808080', '#141414');
        else if (option && !/^ {2}┃ {2}1\./u.test(text)) {
          add(5, Math.min(8, text.length), '#808080', '#141414');
          add(8, text.length, '#eeeeee', '#141414');
        } else add(5, text.length, option ? '#fab283' : '#eeeeee', '#141414');
      }
      return { text, spans };
    });
  }

  const detectStyled = (frame: string[], agent = 'opencode') =>
    detectPrompt(frame.join('\n'), agent, frame.length, styledFrame(frame));

  it.each(['opencode', 'mimo'])('keeps a live panel below ordinary transcript at 80x24 for %s', async (agent) => {
    const renderer = new ScreenRenderer({ cols: 80, rows: 24, agent });
    try {
      await renderer.write(fixture('dialogs/opencode-question-live-transcript.ansi'));
      const screen = renderer.snapshot();
      expect(screen.screen.split('\n')).toHaveLength(24);
      expect(screen.screen.split('\n')[0]).toMatch(/^ \? \S/u);
      const prompt = detectPrompt(screen.screen, agent, screen.rows, renderer.styledLines().lines);
      expect(prompt?.options).toHaveLength(3);
      expect(prompt?.optionRows).toEqual([12, 18, 21]);
      expect(prompt?.rows).toEqual([3, 23]);
      expect(prompt?.basis).toBe('frame');
      expect(prompt?.selectedOption).toBeUndefined();
      expect(renderer.styledLines().lines.map((line) => [line.wrapped ?? false, line.wrapPadding ?? 0])).toEqual([
        ...Array.from({ length: 18 }, () => [false, 0]),
        [false, 50], [true, 6], [true, 9], [true, 49], [true, 7], [true, 0],
      ]);
    } finally {
      await renderer.dispose();
    }
  });

  it.each(['  ┃  Earlier answer', '  ┃  Ready · model'])('detects a live panel below %s at 80x24 and 100x60', async (earlier) => {
    const source = new ScreenRenderer({ cols: 80, rows: 24, agent: 'opencode' });
    try {
      await source.write(fixture('dialogs/opencode-question-live-transcript.ansi'));
      const liveRows = source.snapshot().screen.split('\n');
      for (const [cols, height] of [[80, 24], [100, 60]] as const) {
        const renderer = new ScreenRenderer({ cols, rows: height, agent: 'opencode' });
        try {
          const panel = [...Array<string>(height - liveRows.length).fill(''), ...liveRows];
          panel[height - liveRows.length] = earlier;
          await renderer.write(panel.join('\r\n'));
          const screen = renderer.snapshot();
          expect(screen.screen.split('\n')).toHaveLength(height);
          for (const agent of ['opencode', 'mimo']) {
            const prompt = detectPrompt(screen.screen, agent, screen.rows, styledFrame(screen.screen.split('\n')));
            expect(prompt?.options).toHaveLength(3);
            expect(prompt?.optionRows).toEqual([height - 12, height - 6, height - 3]);
            expect(prompt?.rows).toEqual([height - 21, height - 1]);
            expect(prompt?.basis).toBe('frame');
          }
        } finally {
          await renderer.dispose();
        }
      }
    } finally {
      await source.dispose();
    }
  });

  it.each(['opencode', 'mimo'])('reports the visible choices at 80x24 for %s', (agent) => {
    expect(rows).toHaveLength(24);
    const prompt = detectStyled(rows, agent);
    expect(prompt?.question).toBe(question);
    expect(prompt?.options).toEqual(['Keep the current plan', 'Reorder the work', 'Split the work']);
    expect(prompt?.optionRows).toEqual([12, 18, 21]);
    expect(prompt?.rows).toEqual([3, 23]);
    expect(prompt?.basis).toBe('frame');
    expect(prompt?.selectedOption).toBeUndefined();
  });

  it('does not claim an unstyled panel through the renderer', async () => {
    const renderer = new ScreenRenderer({ cols: 80, rows: 24, agent: 'opencode' });
    try {
      await renderer.write(rows.join('\r\n'));
      const screen = renderer.snapshot();
      expect(detectPrompt(screen.screen, 'opencode', screen.rows, renderer.styledLines().lines)).toBeNull();
    } finally {
      await renderer.dispose();
    }
  });

  it('reports only fully visible labels when clipped within an option', () => {
    const screen = ['', '', ...rows.slice(0, 21), '  ┃  3. Split the wo'].join('\n');
    expect(screen.split('\n')).toHaveLength(24);
    const prompt = detectStyled(screen.split('\n'));
    expect(prompt?.options).toEqual(['Keep the current plan', 'Reorder the work', 'Split the wo']);
    expect(prompt?.rows[1]).toBe(23);
  });

  it('reports two choices when the viewport ends just after them', () => {
    const screen = [
      ...Array<string>(17).fill(''),
      '  ┃', '  ┃  Questions', '  ┃', '  ┃  Which plan should we use?', '  ┃',
      '  ┃  1. Keep the plan', '  ┃  2. Change the plan',
    ].join('\n');
    expect(screen.split('\n')).toHaveLength(24);
    expect(detectStyled(screen.split('\n'))?.options).toEqual(['Keep the plan', 'Change the plan']);
  });

  it.each([[80, 24], [100, 60]] as const)('accepts question content beginning with > at %ix%i', (cols, height) => {
    const frame = [...Array<string>(height - rows.length).fill(''), ...rows];
    frame[height - rows.length + 5] = '  ┃  > Which plan should we use?';
    const prompt = detectStyled(frame);
    expect(prompt?.question).toContain('> Which plan should we use?');
    expect(prompt?.options).toHaveLength(3);
    expect(frame.every(row => row.length <= cols)).toBe(true);
  });

  it('keeps a visible selected row but does not guess from a clipped description', () => {
    expect(detectPrompt(clipped.replace('  ┃  2. Reorder', '⟦SP:selected⟧   ┃  2. Reorder'), 'opencode', 24, styledFrame(rows))?.selectedOption).toBe(1);
    const descriptionMarked = detectPrompt(clipped.replace('  ┃     Confirm the groups', '⟦SP:selected⟧   ┃     Confirm the groups'), 'opencode', 24, styledFrame(rows));
    expect(descriptionMarked?.options).toHaveLength(3);
    expect(descriptionMarked?.selectedOption).toBeUndefined();
  });

  it('keeps a fitting 100x60 question menu detected', async () => {
    const fitting = [...rows, '  ┃  4. Type your own answer', '  ┃',
      '  ┃  ↑↓ select  enter submit  esc dismiss', '  ctrl+p commands'].join('\n');
    const renderer = new ScreenRenderer({ cols: 100, rows: 60, agent: 'opencode' });
    try {
      await renderer.write(fitting.replaceAll('\n', '\r\n'));
      const screen = renderer.snapshot();
      expect([screen.cols, screen.rows]).toEqual([100, 60]);
      expect(detectPrompt(screen.screen)?.options).toEqual([
        'Keep the current plan', 'Reorder the work', 'Split the work', 'Type your own answer',
      ]);
      expect(detectPrompt(screen.screen)?.basis).toBe('footer');
    } finally {
      await renderer.dispose();
    }
  });

  it('rejects headings and numbered lists in transcript, file output and a typed draft', () => {
    const list = 'Questions\n1. Keep the plan\n2. Change the plan';
    expect(detectPrompt(`Completed turn\n${list}\n  ╹▀▀▀▀▀▀▀▀`)).toBeNull();
    expect(detectPrompt(`$ cat plan.txt\n${list}`)).toBeNull();
    expect(detectPrompt(`  ┃  ${list.replaceAll('\n', '\n  ┃  ')}\n  ╹▀▀▀▀▀▀▀▀\n  ctrl+p commands`)).toBeNull();
  });

  it('rejects an answered panel and one above a later turn', () => {
    expect(detectPrompt(`${clipped}\n  ╹▀▀▀▀▀▀▀▀\n  ctrl+p commands`)).toBeNull();
    expect(detectPrompt(`${clipped}\n  ┃  Finished answering.\n  ┃  New turn output`)).toBeNull();
  });

  it('rejects panel-shaped text in a later transcript turn', () => {
    const transcript = [...rows];
    transcript[0] = '$ cat saved-output.txt';
    expect(detectPrompt(transcript.join('\n'), 'opencode', 24, styledFrame(transcript, true))).toBeNull();
  });

  it.each([
    '   esc interrupt',
    '     ▣  Building · model',
  ])('rejects active chrome above a clipped panel: %s', (chrome) => {
    const active = [...rows];
    active[0] = chrome;
    expect(detectStyled(active)).toBeNull();
    expect(detectStyled(active, 'mimo')).toBeNull();
  });

  it.each(['opencode', 'mimo'])('rejects one choice and a bare header for %s', (agent) => {
    const oneChoice = [
      ...Array<string>(18).fill(''), '  ┃', '  ┃  Questions', '  ┃',
      '  ┃  Which plan?', '  ┃', '  ┃  1. Keep the plan',
    ].join('\n');
    const bareHeader = [...Array<string>(23).fill(''), '  ┃  Questions'].join('\n');
    expect(detectPrompt(oneChoice, agent, 24)).toBeNull();
    expect(detectPrompt(bareHeader, agent, 24)).toBeNull();
  });

  it.each([80, 100])('requires the physical bottom row at %ix24 or taller', async (cols) => {
    const height = cols === 80 ? 24 : 60;
    const renderer = new ScreenRenderer({ cols, rows: height, agent: 'opencode' });
    try {
      await renderer.write(rows.slice(0, 19).join('\r\n'));
      const screen = renderer.snapshot();
      expect(screen.rows).toBe(height);
      expect(screen.screen.split('\n')).toHaveLength(19);
      expect(detectPrompt(screen.screen, 'opencode', screen.rows)).toBeNull();
      expect(screen.lines.some(line => line.includes('⟦SP:selected⟧'))).toBe(false);
    } finally {
      await renderer.dispose();
    }
  });

  it.each([24, 60])('rejects busy gutter content and a full-height draft at 80x%i', async (height) => {
    const busyRenderer = new ScreenRenderer({ cols: 80, rows: height, agent: 'mimo' });
    const draftRenderer = new ScreenRenderer({ cols: 80, rows: height, agent: 'opencode' });
    try {
      const panel = [...Array<string>(height - rows.length).fill(''), ...rows];
      panel[height - rows.length] = '   ⠇ Thinking';
      await busyRenderer.write(panel.join('\r\n'));
      const busyScreen = busyRenderer.snapshot();
      expect(detectPrompt(busyScreen.screen, 'mimo', busyScreen.rows)).toBeNull();

      const draft = [...Array<string>(height - rows.length).fill(''), ...rows];
      draft[height - rows.length] = '  ┃  Draft text';
      await draftRenderer.write(draft.join('\r\n'));
      const draftScreen = draftRenderer.snapshot();
      expect(detectPrompt(draftScreen.screen, 'opencode', draftScreen.rows,
        styledFrame(draftScreen.screen.split('\n'), true))).toBeNull();
    } finally {
      await busyRenderer.dispose();
      await draftRenderer.dispose();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { ScreenRenderer } from '../../src/core/renderer.js';
import { BUILT_IN_SIGNATURES, compileSignatures, hideReasoning, latestResult } from '../../src/core/reasoning.js';
import type { StyledLine } from '../../src/core/renderer.js';

const grok = compileSignatures(BUILT_IN_SIGNATURES, 'built-in').signatures.find((s) => s.name === 'grok')!;
const row = (text: string, wrapped = false, ink = '#929292'): StyledLine => ({
  text,
  wrapped,
  spans: text === '' ? [] : [{ from: 0, to: text.length, bold: false, dim: false, italic: false, inverse: false, fg: ink, bg: null }],
});
const question = (text: string, wrapped = false): StyledLine => row(text, wrapped, '#e1e1e1');
const option = (text: string, wrapped = false): StyledLine => row(text, wrapped, text.includes('(○)') ? '#c8c8c8' : '#e1e1e1');
const footer = (text: string, wrapped = false): StyledLine => row(text, wrapped, '#808080');
const mixedRow = (text: string, markerInk: string): StyledLine => {
  const line = row(text);
  line.spans = [
    { ...line.spans[0]!, to: 6, fg: markerInk },
    { ...line.spans[0]!, from: 6 },
  ];
  return line;
};
describe('Grok reasoning continuation', () => {
  for (const cols of [80, 129, 300, 398]) {
    it(`hides a lone box-inked question at ${cols} columns`, async () => {
      const renderer = new ScreenRenderer({ cols, rows: 49 });
      await renderer.write('  │  ♦ Thinking…\r\n\x1b[38;2;225;225;225m' +
        '  │  >  Allow orphan command?'.padEnd(cols, ' ') + '\x1b[0m\r\n  │ >');
      const lines = renderer.styledLines({ last: 2000 }).lines;
      expect(hideReasoning(lines, grok)!.lines.join('\n')).not.toContain('Allow orphan command?');
      await renderer.dispose();
    });

    it(`keeps a question after one box-inked option appears at ${cols} columns`, () => {
      const lines = [
        row('  │  ♦ Thinking…'),
        question('  │  >  Allow synthetic command?'.padEnd(cols, ' ')),
        option('  │  1 (○) Yes'),
        row('  │ >'),
      ];
      expect(hideReasoning(lines, grok)!.lines.join('\n')).toContain('Allow synthetic command?');
    });

    it(`keeps a question when marked command rows lead to an option at ${cols} columns`, () => {
      const lines = [
        row('  │  ♦ Thinking…'),
        question('  │  >  Allow synthetic command?'.padEnd(cols, ' ')),
        row('  │  │ echo synthetic'),
        row('  │  : continuation'),
        row('  │'),
        option('  │  1 (○) Yes'),
        row('  │ >'),
      ];
      expect(hideReasoning(lines, grok)!.lines.join('\n')).toContain('Allow synthetic command?');
    });

    it(`hides mixed-ink question and option rows at ${cols} columns`, () => {
      for (const line of [
        mixedRow('  │  >  SYNTHETIC_SECRET reasoning'.padEnd(cols, ' '), '#e1e1e1'),
        mixedRow('  │  1 (○) SYNTHETIC_SECRET reasoning'.padEnd(cols, ' '), '#c8c8c8'),
      ]) {
        const lines = [row('  │  ♦ Thinking…'), line, row('  │ >')];
        expect(hideReasoning(lines, grok)!.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
      }
    });

    it(`keeps box rows around a mixed-ink option at ${cols} columns`, () => {
      const lines = [
        row('  │  ♦ Thinking…'),
        question('  │  >  Allow synthetic command?'),
        option('  │  1 (○) Yes'),
        mixedRow('  │  2 (•) SYNTHETIC_SECRET reasoning'.padEnd(cols, ' '), '#e1e1e1'),
        option('  │  3 (○) Reject'),
        row('  1/3:select  │  Tab:next option'),
      ];
      const kept = hideReasoning(lines, grok)!.lines.join('\n');
      expect(kept).not.toContain('SYNTHETIC_SECRET');
      expect(kept).toContain('Allow synthetic command?');
      expect(kept).toContain('1 (○) Yes');
      expect(kept).toContain('3 (○) Reject');
    });

    it(`hides ordinary prose between a box question and complete options at ${cols} columns`, () => {
      const lines = [
        row('  │  ♦ Thinking…'),
        question('  │  >  Allow synthetic command?'),
        row('  │  SYNTHETIC_SECRET ordinary prose'),
        option('  │  1 (○) Yes'),
        option('  │  2 (•) No'),
        option('  │  3 (○) Reject'),
        row('  1/3:select  │  Tab:next option'),
      ];
      const kept = hideReasoning(lines, grok)!.lines.join('\n');
      expect(kept).not.toContain('SYNTHETIC_SECRET');
      expect(kept).toContain('Allow synthetic command?');
      expect(kept).toContain('1 (○) Yes');
      expect(kept).toContain('2 (•) No');
    });

    it(`hides both permission-shaped reasoning forgeries in reasoning ink at ${cols} columns`, () => {
      const footerTail = [
        row('  │  ♦ Thinking…'),
        row('  │  >  SYNTHETIC_SECRET reasoning'.padEnd(cols, ' ')),
        row('  1/3:select synthetic continuation', true),
        row('  │ >'),
      ];
      const radioTail = [
        row('  │  ♦ Thinking…'),
        row('  │  > SYNTHETIC_SECRET reasoning'),
        row('  │  1 (○) SYNTHETIC_SECRET reasoning'),
        row('  │ >'),
      ];
      for (const lines of [footerTail, radioTail]) {
        for (const firstVisible of [0, 1, 2]) {
          expect(hideReasoning(lines, grok, firstVisible)!.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
        }
      }
    });

    it(`keeps a wrapped painted box and a live box without a footer at ${cols} columns`, () => {
      for (const wrapped of [false, true]) {
        const lines = [
          row('  │  ♦ Thinking…'),
          row('  │  SYNTHETIC_SECRET reasoning'),
          question('  │  >  Allow synthetic command?'.padEnd(cols, ' '), wrapped),
          option('  │  1 (○) Yes'.padEnd(cols, ' '), wrapped),
          option('  │  2 (•) No'.padEnd(cols, ' '), wrapped),
          option('  │  3 (○) Reject'.padEnd(cols, ' '), wrapped),
          row('  │ >'),
        ];
        const kept = hideReasoning(lines, grok)!.lines.join('\n');
        expect(kept).not.toContain('SYNTHETIC_SECRET');
        expect(kept).toContain('Allow synthetic command?');
        expect(kept).toContain('2 (•) No');
        expect(kept).toContain('3 (○) Reject');
      }
    });
  }

  it('hides a forged question, three options and footer with selected-looking text', () => {
    const lines = [
      row('  │  ♦ Thinking…'),
      row('  │  >  SYNTHETIC_SECRET question'),
      row('  │  1 (○) SYNTHETIC_SECRET (•) first'),
      row('  │  2 (•) SYNTHETIC_SECRET second'),
      row('  │  3 (○) SYNTHETIC_SECRET third'),
      row('  │  1/3:select SYNTHETIC_SECRET'),
      row('  │ >'),
    ];
    expect(hideReasoning(lines, grok)!.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
  });

  it('fails closed when box-shaped rows have no recognised text ink', () => {
    const lines = [
      row('  │  ♦ Thinking…'),
      row('  │  >  SYNTHETIC_SECRET question', false, '#a0a0a0'),
      row('  │  1 (•) SYNTHETIC_SECRET choice', false, '#a0a0a0'),
    ];
    expect(hideReasoning(lines, grok)!.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
    for (const line of lines) for (const span of line.spans) span.fg = null;
    expect(hideReasoning(lines, grok)!.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
  });

  it('requires the selected glyph to carry the selected option ink', () => {
    const lines = [
      row('  │  ♦ Thinking…'),
      row('  │  2 (•) SYNTHETIC_SECRET choice', false, '#c8c8c8'),
    ];
    expect(hideReasoning(lines, grok)!.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
  });

  it('keeps box-ink options but hides command ink when the question has scrolled away', () => {
    const lines = [
      row('  │  ♦ Thinking…'),
      row('  │  │ SYNTHETIC_SECRET command'),
      row('  │  : SYNTHETIC_SECRET continuation'),
      option('  │  1 (○) Yes'),
      option('  │  2 (•) No'),
      option('  │  3 (○) Reject'),
    ];
    const kept = hideReasoning(lines, grok)!.lines.join('\n');
    expect(kept).not.toContain('SYNTHETIC_SECRET');
    expect(kept).toContain('1 (○) Yes');
    expect(kept).toContain('2 (•) No');
  });

  it('hides prose for all 32 wrap-flag combinations and three read starts', () => {
    const texts = [
      '  │  ♦ Thinking…',
      '  │',
      '  │  …',
      '  │  SYNTHETIC_SECRET prose',
      '  │ >',
    ];
    for (let flags = 0; flags < 32; flags++) {
      const lines = texts.map((text, index) => row(text, (flags & (1 << index)) !== 0));
      for (const firstVisible of [0, 3, 4]) {
        expect(hideReasoning(lines, grok, firstVisible)!.lines.join('\n'), `${flags}:${firstVisible}`)
          .not.toContain('SYNTHETIC_SECRET');
      }
    }
  });
  for (const cols of [80, 129, 300, 398]) {
    it(`hides a quoted full-width row before a wrapped footer-shaped tail at ${cols} columns`, async () => {
      const renderer = new ScreenRenderer({ cols, rows: 49 });
      await renderer.write([
        '  │  ♦ Thinking…',
        '  │  >  SYNTHETIC_SECRET reasoning'.padEnd(cols, ' ') + '  1/3:select synthetic continuation',
        '  │ >',
      ].join('\r\n'));
      const lines = renderer.styledLines({ last: 2000 }).lines;
      expect(lines.find((line) => line.text.includes('1/3:select'))?.wrapped).toBe(true);
      expect(hideReasoning(lines, grok)!.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
      await renderer.dispose();
    });

    it(`hides a quoted row followed by one unselected radio at ${cols} columns`, async () => {
      const renderer = new ScreenRenderer({ cols, rows: 49 });
      await renderer.write([
        '  │  ♦ Thinking…',
        '  │  > SYNTHETIC_SECRET reasoning',
        '  │  1 (○) SYNTHETIC_SECRET reasoning',
        '  │ >',
      ].join('\r\n'));
      const lines = renderer.styledLines({ last: 2000 }).lines;
      expect(hideReasoning(lines, grok)!.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
      await renderer.dispose();
    });
  }

  it('hides bar rows whose repaint marks each separate row as wrapped', () => {
    const lines = [
      row('     > synthetic input'),
      row('  │  ♦ Thinking…', true),
      row('  │', true),
      row('  │  …', true),
      row('  │  SYNTHETIC_SECRET ordinary prose 12345', true),
      row('  │  further synthetic prose'),
      row('  │ >', true),
    ];
    const filtered = hideReasoning(lines, grok)!;
    expect(filtered.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
    expect(filtered.lines).not.toContain('  │  …');
    expect(filtered.lines).not.toContain('  │');
  });

  for (const cols of [80, 129, 300, 398]) {
    for (const paint of ['wrapped', 'separate'] as const) {
      it(`hides painted bar rows at ${cols} columns when ${paint}`, async () => {
        const renderer = new ScreenRenderer({ cols, rows: 49 });
        const physical = [
          '     > synthetic input',
          '  │  ♦ Thinking…',
          '  │',
          '  │  …',
          '  │  SYNTHETIC_SECRET ordinary prose 12345',
          '  │  further synthetic prose',
          '  │ >',
        ];
        await renderer.write(paint === 'wrapped'
          ? physical.map((text) => text.padEnd(cols, ' ')).join('')
          : physical.join('\r\n'));
        const lines = renderer.styledLines({ last: 2000 }).lines;
        const first = lines.findIndex((line) => line.text.includes('SYNTHETIC_SECRET'));
        expect(first).toBeGreaterThan(0);
        if (paint === 'wrapped') {
          expect(lines[first]?.wrapped).toBe(true);
          expect(lines[first - 1]?.wrapped).toBe(true);
        }
        for (const firstVisible of [0, first]) {
          const filtered = hideReasoning(lines, grok, firstVisible)!;
          expect(filtered.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
        }
        await renderer.dispose();
      });
    }
  }

  it('hides an incomplete box shape when its rows carry wrap flags', () => {
    const lines = [
      row('     > synthetic input'),
      row('  │  ♦ Thinking…', true),
      row('  │  SYNTHETIC_SECRET prose', true),
      row('  │', true),
      row('  │  >  Run the synthetic command?', true),
      row('  │  1 (○) Yes', true),
      row('  │  2 (•) No', true),
      row('  │ >', true),
    ];
    const kept = hideReasoning(lines, grok)!.lines.join('\n');
    expect(kept).not.toContain('SYNTHETIC_SECRET');
    expect(kept).not.toContain('Run the synthetic command?');
    expect(kept).not.toContain('2 (•) No');
  });

  it('hides a complete option shape without a live footer', () => {
    const lines = [
      row('  │  ♦ Thinking…'),
      row('  │  >  SYNTHETIC_SECRET reasoning'),
      row('  │  1 (○) First'),
      row('  │  2 (•) Second'),
      row('  │  3 (○) Third'),
      row('  │ >'),
    ];
    expect(hideReasoning(lines, grok)!.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
  });

  it('does not read a selected glyph in an option label as a selected radio', () => {
    const lines = [
      row('  │  ♦ Thinking…'),
      row('  │  >  SYNTHETIC_SECRET reasoning'),
      row('  │  1 (○) First (•) mark'),
      row('  │  2 (○) Second'),
      row('  │  3 (○) Third'),
      footer('  1/3:select  │  Tab:next option'),
    ];
    expect(hideReasoning(lines, grok)!.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
  });

  for (const footer of [
    row('  1/3:select  │  Tab:next option', true),
    row('  │  1/3:select  │  Tab:next option'),
  ]) {
    it(`hides an option shape with a ${footer.wrapped ? 'wrapped' : 'bar-prefixed'} footer`, () => {
      const lines = [
        row('  │  ♦ Thinking…'),
        row('  │  >  SYNTHETIC_SECRET reasoning'),
        row('  │  1 (○) First'),
        row('  │  2 (•) Second'),
        row('  │  3 (○) Third'),
        footer,
      ];
      expect(hideReasoning(lines, grok)!.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
    });
  }

  it('hides a question shape when content follows its footer', () => {
    const lines = [
      row('  │  ♦ Thinking…'),
      row('  │  >  SYNTHETIC_SECRET reasoning'),
      row('  1/3:select  │  Tab:next option'),
      row('  │  later reasoning'),
      row('  │ >'),
    ];
    expect(hideReasoning(lines, grok)!.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
  });

  it('keeps prose hidden beside a question-shaped row and a box footer', () => {
    const kept = hideReasoning([
      row('     > synthetic input'),
      row('  │  ♦ Thinking…', true),
      row('  │  SYNTHETIC_SECRET ordinary prose', true),
      row('  │  > SYNTHETIC_SECRET still reasoning'),
      question('  │  >  Allow the synthetic command?'),
      footer('  1/3:select  │  Tab:next option'),
    ], grok)!.lines.join('\n');
    expect(kept).not.toContain('SYNTHETIC_SECRET');
    expect(kept).toContain('Allow the synthetic command?');
  });

  it('requires a separately painted, unwrapped footer in footer-only boxes', () => {
    for (const trailing of [
      row('  1/3:select  │  Tab:next option'),
      footer('  1/3:select  │  Tab:next option', true),
      footer('  │  1/3:select  │  Tab:next option'),
    ]) {
      const lines = [row('  │  ♦ Thinking…'), question('  │  >  Allow orphan command?'), trailing, row('  │ >')];
      expect(hideReasoning(lines, grok)!.lines.join('\n')).not.toContain('Allow orphan command?');
    }
  });

  it('hides both physical rows of the reported prose shape at 129x49', async () => {
    const renderer = new ScreenRenderer({ cols: 129, rows: 49 });
    const prefix = [
      '     > synthetic input',
      '  │  ♦ Thinking…',
      '  │',
      '  │  …',
    ].map((text) => text.padEnd(129, ' ')).join('');
    const prose = '  │  SYNTHETIC_SECRET This sentence uses invented words to fill the terminal row and continues after a short digit run 12345 onto the next line';
    await renderer.write(prefix + prose + '\r\n  │ >');
    const lines = renderer.styledLines({ last: 2000 }).lines;
    const first = lines.findIndex((line) => line.text.includes('SYNTHETIC_SECRET'));
    expect(first).toBeGreaterThan(0);
    expect(lines[first - 3]?.wrapped).toBe(true);
    expect(lines[first - 2]?.wrapped).toBe(true);
    expect(lines[first - 1]?.wrapped).toBe(true);
    expect(lines[first]?.wrapped).toBe(true);
    expect(lines[first + 1]?.wrapped).toBe(true);
    expect(lines[first]?.text).toMatch(/^ {2}│ {2}S/);
    for (const firstVisible of [0, first]) {
      const filtered = hideReasoning(lines, grok, firstVisible)!;
      expect(filtered.lines).not.toContain(lines[first]!.text);
      expect(filtered.lines).not.toContain(lines[first + 1]!.text);
      expect(filtered.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
    }
    await renderer.dispose();
  });

  it('hides a box-shaped prose row after an ellipsis', () => {
    const lines = [
      row('  │  ♦ Thinking…'),
      row('  │'),
      row('  │  …'),
      row('  │  > SYNTHETIC_SECRET prose'),
      row('  │ >'),
    ];
    const filtered = hideReasoning(lines, grok)!;
    expect(filtered.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
  });

  it('does not let a later permission box claim earlier prose', () => {
    const lines = [
      row('  │  ♦ Thinking…'),
      row('  │  > SYNTHETIC_SECRET prose'),
      row('  │'),
      question('  │  >  Run the synthetic command?'),
      option('  │  1 (○) Yes'),
      option('  │  2 (•) No'),
      option('  │  3 (○) Reject'),
      row('  1/3:select  │  Tab:next option'),
    ];
    const kept = hideReasoning(lines, grok)!.lines.join('\n');
    expect(kept).not.toContain('SYNTHETIC_SECRET');
    expect(kept).toContain('Run the synthetic command?');
    expect(kept).toContain('2 (•) No');
  });

  const shapes = [
    { name: 'full width', prose: (cols: number) => '  │  > SYNTHETIC_SECRET'.padEnd(cols - 1, 'x') },
    { name: 'soft wrap', prose: (cols: number) => '  │  > SYNTHETIC_SECRET'.padEnd(cols + 22, 'x') },
    { name: 'ordinary soft wrap', prose: (cols: number) =>
      '  │  SYNTHETIC_SECRET ordinary prose '.padEnd(cols - 12, 'x') + '12345 continuing' },
    { name: 'ellipsis alone', prose: () => '  │  … SYNTHETIC_SECRET' },
    { name: 'question prefix', prose: () => '  │  > SYNTHETIC_SECRET' },
    { name: 'colon prefix', prose: () => '  │  : SYNTHETIC_SECRET' },
    { name: 'command prefix', prose: () => '  │  │ SYNTHETIC_SECRET' },
    { name: 'radio prefix', prose: () => '  │  1 (○) SYNTHETIC_SECRET' },
  ];

  for (const [cols, height] of [[80, 24], [129, 49]]) {
    for (const shape of shapes) {
      it(`hides ${shape.name} at ${cols}x${height}, including a cropped read`, async () => {
        const renderer = new ScreenRenderer({ cols: cols!, rows: height! });
        await renderer.write([
          '     > synthetic input',
          '  │  ♦ Thinking…',
          '  │',
          '  │  …',
          shape.prose(cols!),
          '  │ >',
        ].join('\r\n'));
        const lines = renderer.styledLines({ last: 2000 }).lines;
        const prose = lines.findIndex((line) => line.text.includes('SYNTHETIC_SECRET'));
        expect(prose).toBeGreaterThanOrEqual(0);
        if (shape.name.includes('soft wrap')) expect(lines[prose + 1]?.wrapped).toBe(true);
        for (const firstVisible of [0, prose]) {
          const filtered = hideReasoning(lines, grok, firstVisible)!;
          expect(filtered.lines.join('\n')).not.toContain('SYNTHETIC_SECRET');
        }
        expect(JSON.stringify(latestResult(lines, grok))).not.toContain('SYNTHETIC_SECRET');
        await renderer.dispose();
      });
    }
  }
});

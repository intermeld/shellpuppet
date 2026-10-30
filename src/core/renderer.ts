/**
 * ANSI stream → plain-text screen grid, via a headless terminal emulator.
 *
 * Wraps `@xterm/headless` so the rest of the system never touches xterm APIs
 * directly. One renderer per session; the daemon feeds it every byte the PTY
 * emits and reads back clean text for snapshots, waits and finds.
 *
 * No I/O and no logging: pure transformation.
 */

// DO NOT "simplify" this to `import { Terminal } from '@xterm/headless'`.
// The package is a CJS bundle whose named exports Node's CJS-ESM lexer cannot
// detect: under raw Node ESM the named import is `undefined` at runtime, even
// though the typings say otherwise, and Vitest's transform pipeline hides the
// breakage in tests. Verified on Node 22.22.2. The default import is the
// module object.
import xterm from '@xterm/headless';
import type { Terminal as XtermTerminal } from '@xterm/headless';
// Same CJS-bundle caveat as `@xterm/headless` above: default import, then destructure.
import serializeAddon from '@xterm/addon-serialize';
import type { SerializeAddon as XtermSerializeAddon } from '@xterm/addon-serialize';
import { DEFAULT_COLS, DEFAULT_ROWS, DEFAULT_SCROLLBACK } from './types.js';
import type { CursorPosition } from './types.js';

const { Terminal } = xterm;
const { SerializeAddon } = serializeAddon;

export interface RendererOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
}

export interface SerializeOptions {
  /** Scrollback lines to carry, from the bottom; all of them when omitted. */
  scrollback?: number;
}

/**
 * How a run of characters is drawn. Colours are `null` for the terminal's
 * default, `p<n>` for palette entry n, or `#rrggbb` for a true colour.
 */
export interface CellStyle {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  inverse: boolean;
  fg: string | null;
  bg: string | null;
}

/** A run of `text.slice(from, to)` drawn in one style. */
export interface StyleSpan extends CellStyle {
  from: number;
  to: number;
}

/**
 * One line as text and the styles it was drawn in. `text` is the same string
 * a snapshot gives for that line; `spans` cover it from start to end.
 */
export interface StyledLine {
  text: string;
  spans: StyleSpan[];
}

/** The rendered viewport plus cursor state (screen-level, not session-level). */
export interface RenderedScreen {
  cols: number;
  rows: number;
  cursor: CursorPosition;
  /** Viewport lines, right-trimmed, with trailing blank lines removed. */
  lines: string[];
  /** `lines` joined with `\n`. */
  screen: string;
}

export class ScreenRenderer {
  private readonly term: XtermTerminal;
  private readonly serializer: XtermSerializeAddon;
  /** Chain of pending writes, so `flush()` can await parser completion. */
  private pending: Promise<void> = Promise.resolve();

  constructor(options: RendererOptions = {}) {
    this.term = new Terminal({
      cols: options.cols ?? DEFAULT_COLS,
      rows: options.rows ?? DEFAULT_ROWS,
      scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /**
   * Feed PTY output into the emulator. xterm parses asynchronously; the
   * returned promise resolves once this chunk has been applied. Streaming
   * callers may ignore it, but anything about to read the screen must `flush()`.
   */
  write(data: string): Promise<void> {
    const written = new Promise<void>((resolve) => {
      this.term.write(data, resolve);
    });
    this.pending = this.pending.then(() => written);
    return written;
  }

  /** Resolves once every write issued so far has been parsed. */
  flush(): Promise<void> {
    return this.pending;
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /**
   * The terminal as bytes that rebuild it in a fresh terminal of the same
   * size: buffer contents with their attributes, wrapped lines, the alternate
   * screen when active, the cursor position and the DEC modes. Resolves once
   * every byte queued BEFORE the call has been parsed, and includes nothing
   * queued after it: the write queue is FIFO and the marker takes its place in
   * it. Cursor visibility is not part of xterm's serialisation; Session adds
   * it from its own mode scan.
   */
  serialize(options: SerializeOptions = {}): Promise<string> {
    return new Promise((resolve) => {
      this.term.write('', () => {
        resolve(
          this.serializer.serialize(
            options.scrollback === undefined ? {} : { scrollback: options.scrollback },
          ),
        );
      });
    });
  }

  /** Render the visible viewport (the bottom page when scrolled fully down). */
  snapshot(): RenderedScreen {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i++) {
      const line = buffer.getLine(buffer.baseY + i);
      lines.push(line ? line.translateToString(true) : '');
    }
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
      lines.pop();
    }
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      lines,
      screen: lines.join('\n'),
    };
  }

  /**
   * The last `count` lines of everything written, scrollback included
   * (design §3: `terminal_snapshot`'s `lastLines`). Agent CLIs scroll long
   * output straight past the viewport; without this an agent hits a wall the
   * moment output exceeds one screen.
   *
   * Trailing blank lines (the unused bottom of the viewport) are dropped, then
   * the last `count` remaining lines are returned in order. Interior blank
   * lines are preserved.
   */
  lastLines(count: number): string[] {
    if (count <= 0) return [];
    const buffer = this.term.buffer.active;
    let end = buffer.length - 1;
    // Walk past the blank tail. Everything above it is content territory.
    while (end >= 0) {
      const line = buffer.getLine(end);
      if (line && line.translateToString(true).trim() !== '') break;
      end--;
    }
    const start = Math.max(0, end - count + 1);
    const lines: string[] = [];
    for (let i = start; i <= end; i++) {
      const line = buffer.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  /**
   * Lines with the styles they were drawn in, for the readers that tell
   * parts of an agent's screen apart by how they look as well as by what
   * they say (`reasoning.ts`). By default the viewport, with `above` lines of
   * scrollback over it as context; `firstVisible` is where the viewport
   * starts among them. With `last`, the last `last` lines of everything
   * written, scrollback included, as `lastLines` takes them. Text matches
   * `snapshot` and `lastLines` line for line.
   */
  styledLines(options: { above?: number; last?: number } = {}): { lines: StyledLine[]; firstVisible: number } {
    const buffer = this.term.buffer.active;
    let start: number;
    let end: number;
    let firstVisible = 0;
    if (options.last === undefined) {
      end = buffer.baseY + this.term.rows - 1;
      start = Math.max(0, buffer.baseY - Math.max(0, options.above ?? 0));
      firstVisible = buffer.baseY - start;
    } else {
      end = buffer.length - 1;
      while (end >= 0) {
        const line = buffer.getLine(end);
        if (line && line.translateToString(true).trim() !== '') break;
        end--;
      }
      start = Math.max(0, end - options.last + 1);
    }
    const lines: StyledLine[] = [];
    const cell = buffer.getNullCell();
    for (let y = start; y <= end; y++) {
      const line = buffer.getLine(y);
      if (!line) {
        lines.push({ text: '', spans: [] });
        continue;
      }
      let text = '';
      const spans: StyleSpan[] = [];
      for (let x = 0; x < line.length; x++) {
        line.getCell(x, cell);
        // The second half of a wide character holds nothing of its own.
        if (cell.getWidth() === 0) continue;
        const chars = cell.getChars() || ' ';
        const style = styleOf(cell);
        const last = spans[spans.length - 1];
        if (last !== undefined && sameStyle(last, style)) last.to += chars.length;
        else spans.push({ ...style, from: text.length, to: text.length + chars.length });
        text += chars;
      }
      // Right-trimmed, as snapshot text is, with the spans cut to match.
      const trimmed = text.replace(/\s+$/, '');
      const kept: StyleSpan[] = [];
      for (const span of spans) {
        if (span.from >= trimmed.length) break;
        kept.push({ ...span, to: Math.min(span.to, trimmed.length) });
      }
      lines.push({ text: trimmed, spans: kept });
    }
    if (options.last === undefined) {
      while (lines.length > firstVisible && lines[lines.length - 1]?.text.trim() === '') lines.pop();
    }
    return { lines, firstVisible };
  }

  dispose(): void {
    this.term.dispose();
  }
}

type BufferCell = ReturnType<XtermTerminal['buffer']['active']['getNullCell']>;

function colourOf(isDefault: boolean, isRgb: boolean, value: number): string | null {
  if (isDefault) return null;
  if (isRgb) return `#${value.toString(16).padStart(6, '0')}`;
  return `p${String(value)}`;
}

function styleOf(cell: BufferCell): CellStyle {
  return {
    bold: cell.isBold() !== 0,
    dim: cell.isDim() !== 0,
    italic: cell.isItalic() !== 0,
    inverse: cell.isInverse() !== 0,
    fg: colourOf(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor()),
    bg: colourOf(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor()),
  };
}

function sameStyle(a: CellStyle, b: CellStyle): boolean {
  return (
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.inverse === b.inverse &&
    a.fg === b.fg &&
    a.bg === b.bg
  );
}

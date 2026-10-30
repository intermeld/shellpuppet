// Test fixture: a TUI that paints its frame ONCE and then only touches part
// of the screen.
//
// Every agent CLI has this shape once its chrome is up: the header, borders
// and composer stay put while a status region churns. On Windows, ConPTY
// gives EVERY program this shape as far as the daemon can tell, because it
// forwards only the cells that changed. After enough churn the frame lies
// further back in the raw stream than any bounded replay reaches, so a viewer
// that rebuilt the screen from the tail of that stream would get churn and
// nothing else.
//
// Layout: row 1 header, row 2 status line, rows 3..rows-2 churn region,
// row rows-1 a static row, last row a footer in inverse video. The churn
// rewrites its whole region on every update with content that changes in
// every cell, PACED so that ConPTY cannot coalesce the updates into a
// handful of paints. When the updates are spent the status line says DONE
// and the program idles. Each chunk of input (one per keypress) advances a
// tick on the status line; a resize repaints the whole frame, as a real TUI
// does on SIGWINCH. It never exits on its own.
//
// Usage: node partial-repaint-tui.mjs [updates] [intervalMs]
const updates = Number(process.argv[2]) || 400;
const intervalMs = Number(process.argv[3]) || 5;

const out = process.stdout;
const ESC = '\x1b';
const at = (row, col) => `${ESC}[${String(row)};${String(col)}H`;

let cols = out.columns || 80;
let rows = out.rows || 24;
let n = 0;
let tick = 0;
let done = false;

function fit(text) {
  return text.padEnd(cols).slice(0, cols);
}

function statusText() {
  if (tick > 0) return `tick ${String(tick)}`;
  return done ? `DONE after ${String(n)} updates` : `update ${String(n)}`;
}

/** The frame chrome: everything the churn never touches. */
function frame() {
  let s = `${ESC}[?25l${ESC}[2J${ESC}[H`;
  s += at(1, 1) + fit('PARTIAL REPAINT TUI header');
  s += at(rows - 1, 1) + fit(`static row ${String(rows - 1)} ${'-'.repeat(cols)}`);
  s += at(rows, 1) + `${ESC}[7m` + fit(` footer ${String(cols)}x${String(rows)} `) + `${ESC}[0m`;
  return s;
}

const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** One churn update: every cell of rows 3..rows-2 changes. */
function region() {
  let s = '';
  for (let r = 3; r <= rows - 2; r++) {
    let text = '';
    for (let c = 0; c < cols; c++) text += alphabet[(n + r + c) % alphabet.length];
    s += at(r, 1) + text;
  }
  return s;
}

function paintAll() {
  out.write(frame() + at(2, 1) + fit(statusText()) + region());
}

paintAll();

function churn() {
  if (n >= updates) {
    done = true;
    out.write(at(2, 1) + fit(statusText()));
    return;
  }
  n++;
  out.write(region() + at(2, 1) + fit(statusText()));
  setTimeout(churn, intervalMs);
}
churn();

// Raw mode + resume: on Windows the resize event only reaches a program whose
// stdin is being read, because libuv learns of console size changes from the
// input queue.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', () => {
  tick++;
  out.write(at(2, 1) + fit(statusText()));
});

out.on('resize', () => {
  cols = out.columns || cols;
  rows = out.rows || rows;
  paintAll();
});

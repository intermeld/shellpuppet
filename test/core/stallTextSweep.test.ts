import { readFileSync } from 'node:fs';
import type { IPty } from 'node-pty';
import { describe, expect, it, vi } from 'vitest';
import { Session } from '../../src/core/session.js';
import { detectStall, signatureFor } from '../../src/core/reasoning.js';

const refusal = readFileSync(new URL('../fixtures/stalls/mimo-refusal.ansi', import.meta.url), 'utf8');
const userBar = '  \x1b[38;2;255;128;64m┃\x1b[38;2;238;238;238m  ';
const toolBar = '  \x1b[38;2;10;10;10m┃\x1b[0m  ';
// These are ordinary contents, never changes to the TUI's own framing or ink.
const phrases = [
  'Indented detail', '✗ Error', 'The request was rejected because it was considered high risk',
  "The response was withheld by the model provider's content safety filter.",
  '▣  Build · Example Model · 17m 17s', 'Build · Example Model', 'ctrl+p settings',
  'esc to interrupt', 'esc interrupt', '⠋ Thinking', '⎘ copy', '⎘ copied', '↻ /recover',
  'Review the sample. (Tab to accept)', '█', '│', '✗', '✓', '⏵',
  'Notes:', '> quoted text', '```text', '~~~text', '+ Thought: sample',
];

function frame(text: string, place: string) {
  if (place === 'prompt') return refusal.replace('Summarise the sample.', 'First paragraph.\r\n' + userBar + text);
  if (place === 'output') return refusal.replace('Reading the sample.', text);
  return refusal.replace('     Reading the sample.', toolBar + 'cat example.txt\r\n' + toolBar + text +
    '\r\n  \x1b[38;2;10;10;10m╹' + '▀'.repeat(25) + '\x1b[0m');
}

describe('user-controlled refusal text sweep', () => {
  for (const [cols, rows] of [[80, 24], [120, 30]] as const) {
    for (const place of ['prompt', 'output', 'tool']) {
      it(`${cols}x${rows} ${place}: indents, continuations, wide fills and reserved phrases`, async () => {
        let output: (data: string) => void = () => {};
        const pty = { pid: 0, cols, rows, process: 'synthetic', handleFlowControl: false,
          onData(fn: (data: string) => void) { output = fn; return { dispose() {} }; },
          onExit: () => ({ dispose() {} }), resize() {}, write() {}, clear() {}, kill() {}, pause() {}, resume() {},
        } satisfies IPty;
        const session = new Session('text-sweep', { command: process.execPath, agent: 'mimo', cols, rows }, {
          platform: 'linux', spawn: () => pty, pidWaitMs: 0,
        });
        // Advance only the observation clock. Terminal parsing and output callbacks
        // stay real; no sleep or load-dependent rediscovery interval is involved.
        const realNow = Date.now;
        let now = realNow();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const internal = session as unknown as { refreshStall(): void; clearStallTimer(): void };
        const draw = async (screen: string) => {
          output(screen);
          await vi.advanceTimersByTimeAsync(1);
          await session.viewportLines();
        };
        const failures: string[] = [];
        const check = (ok: boolean, label: string) => { if (!ok) failures.push(label); };
        try {
          for (const phrase of phrases) for (let indent = 0; indent <= 8; indent++) {
            for (const wide of [false, true]) {
              const text = ' '.repeat(indent) + (wide ? 'File content'.padEnd(cols - 8 - indent) : '') + phrase;
              const screen = frame(text, place);
              const label = `${place}/${indent}/${wide ? 'wide' : 'short'}/${phrase}`;
              await draw('\x1b[2J\x1b[H');
              internal.refreshStall(); now += 1000; internal.refreshStall();
              // Without the genuine error ink, quoting any of these contents
              // cannot discover a refusal, even alongside the remaining chrome.
              await draw(screen.replaceAll('\x1b[38;2;251;113;133m', '\x1b[0m'));
              internal.refreshStall(); now += 1100; internal.refreshStall();
              check(session.getStalled() === undefined, 'false discovery: ' + label);
              await draw(screen);
              internal.refreshStall(); now += 1100; internal.refreshStall();
              const before = session.getStalled();
              check(before !== undefined, 'missed discovery: ' + label);
              await draw(frame(text + ' changed', place));
              check(place === 'prompt' ? session.getStalled() === before : session.getStalled() === undefined,
                (place === 'prompt' ? 'false clear: ' : 'hidden end: ') + label);
              if (place === 'prompt') {
                internal.refreshStall(); now += 1100; internal.refreshStall();
                check(session.getStalled() === before, 'false reannouncement: ' + label);
                await draw(frame(text, place).replace('Reading the sample.', 'Changed real answer.'));
                check(session.getStalled() === undefined, 'hidden subsequent output: ' + label);
              }
              if (place !== 'prompt') {
                await draw(screen);
                internal.refreshStall(); now += 1100; internal.refreshStall();
                await draw(frame(' ' + text, place));
                check(session.getStalled() === undefined, 'hidden indentation change: ' + label);
              }
              // The complete detector is checked separately from the clock.
              const view = await session.styledScreen(128);
              check(detectStall(view.lines, signatureFor('mimo', 'mimo')!, false, view.firstVisible) !== null,
                'text veto: ' + label);
              internal.clearStallTimer();
            }
          }
          expect(failures, failures.slice(0, 30).join('\n')).toEqual([]);
        } finally { clock.mockRestore(); vi.useRealTimers(); await session.kill(); }
      }, 60_000);
    }
  }
});

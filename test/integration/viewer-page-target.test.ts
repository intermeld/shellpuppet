/**
 * The viewer page as a target (design §4.4, §5).
 *
 * Screen content is untrusted data, and the page that draws it is a browser
 * window belonging to the human supervising the session. This is runtime
 * evidence of what a hostile-but-benign program on screen can make that page
 * do: set the window title (OSC 0), ring the bell, plant a hyperlink (OSC 8)
 * and answer a terminal query (CPR, `ESC[6n`; on Windows ConPTY answers that
 * one itself), which is the page being made to write into the session by the
 * program it is showing. The daemon files what the page sends that way as a
 * report, not as a person typing.
 *
 * Deliberately not the injection-drill fixture, which is recorded data about
 * what a reading agent did. This is about the page.
 *
 * Skipped where no Chromium-family browser is installed.
 */

import * as fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLogPath, createAuditor } from '../../src/daemon/audit.js';
import { captureViewer } from '../../src/daemon/screenshot.js';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { api, makeTempHome, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';

let td: TestDaemon;
let browser: string | null = null;

beforeAll(async () => {
  const home = makeTempHome('shellpuppet-page-target-');
  td = await startTestDaemon({ home, audit: createAuditor(home) });
  browser = await findBrowser();
}, 60_000);

afterAll(async () => {
  await td.stop();
});

const HOSTILE_PROGRAM = [
  // Plant a link, and a bare URL as text. Screen content, so it survives in
  // the snapshot a later viewer is sent.
  "process.stdout.write('visit http://evil.example now \\x1b]8;;http://evil.example\\x07click\\x1b]8;;\\x07 ok\\r\\n');",
  'process.stdin.setRawMode?.(true);',
  'process.stdin.resume();',
  'let answered = false;',
  "process.stdin.on('data', (b) => {",
  '  if (answered) return;',
  '  answered = true;',
  "  process.stdout.write('REPLY[' + b.toString('utf8').replace(/\\x1b/g, 'ESC') + ']\\r\\n');",
  '});',
  // The three things that are not screen content: an attempt on the OS window
  // title (OSC 0), a bell and a question only a terminal can answer (CPR).
  // None of them is in a snapshot, so a viewer that connects after they were
  // written never sees them. Repeated until something answers, so what this
  // test asserts does not depend on winning a race with the page's socket:
  // otherwise, on a Linux runner, the picture can be taken before the reply
  // lands.
  'const hostile = () => {',
  "  process.stdout.write('\\x1b]0;PWNED-TITLE\\x07');",
  "  process.stdout.write('\\x07');",
  "  process.stdout.write('\\x1b[6n');",
  '};',
  'hostile();',
  'const again = setInterval(() => {',
  '  if (answered) { clearInterval(again); return; }',
  '  hostile();',
  '}, 500);',
].join('\n');

describe('the viewer page under a hostile program on screen', () => {
  it('cannot set the window title, plant a link or leave the page, but its terminal does answer queries', async (context) => {
    if (browser === null) {
      context.skip();
      return;
    }
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', HOSTILE_PROGRAM],
        shell: false,
        cols: 100,
        rows: 20,
        purpose: 'page-target probe',
      },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);

    const capture = await captureViewer({
      browser,
      viewerUrl: String(started.body['viewerUrl']),
      width: 900,
      height: 500,
      timeoutMs: 60_000,
      // The picture waits for the reply to be ON SCREEN. The round trip goes
      // page, daemon, PTY, program and back, which takes longer than the
      // first paint the capture would otherwise settle on.
      probe:
        '(() => {' +
        "const rows = Array.from(document.querySelectorAll('.xterm-rows > div'))" +
        ".map((row) => row.textContent || '').join(String.fromCharCode(10));" +
        "if (!rows.includes('REPLY[')) return null;" +
        'return JSON.stringify({' +
        'title: document.title,' +
        "anchors: document.querySelectorAll('a').length," +
        'path: location.pathname' +
        '});' +
        '})()',
    });
    const probe = JSON.parse(String(capture.probe)) as {
      title: string;
      anchors: number;
      path: string;
    };

    // The title is composed by the page from the daemon's identity frame; the
    // program's OSC 0 goes nowhere.
    expect(probe.title).toContain('ShellPuppet');
    expect(probe.title).not.toContain('PWNED');
    // No anchor was planted: terminal text is text, and the page has no link
    // handler. The URL the program printed is inert characters.
    expect(probe.anchors).toBe(0);
    expect(capture.rows.join('\n')).toContain('http://evil.example');
    // The page is still the viewer page.
    expect(probe.path).toBe('/view');

    // But a terminal query is answered: the CPR reply reached the PTY, and
    // the program read it back. That is inherent to terminal emulation. It is
    // the PAGE that answers, except on Windows, where ConPTY answers the
    // cursor query itself before it reaches the page.
    expect(capture.rows.join('\n')).toContain('REPLY[ESC[');
    // Nobody typed what the page's xterm.js sent, and the audit log does not
    // say anybody did: all of it is filed as a report, never as input
    // (docs/reference/security-model.md). On Windows that is the page's focus
    // report, since ConPTY switches focus reporting on as a session starts.
    const lines = fs
      .readFileSync(auditLogPath(td.home), 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map(
        (line) =>
          JSON.parse(line) as {
            action: string;
            session?: string;
            actor: string;
            meta?: Record<string, unknown>;
          },
      )
      .filter((line) => line.session === id);
    expect(lines.filter((line) => line.action === 'input')).toEqual([]);
    if (process.platform !== 'win32') {
      expect(
        lines.some(
          (line) =>
            line.action === 'report' &&
            line.actor === 'viewer' &&
            line.meta?.['kind'] === 'cursor-position',
        ),
      ).toBe(true);
    }
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  }, 120_000);
});

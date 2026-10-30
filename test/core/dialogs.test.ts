/**
 * Dialog signatures (`dialogs.ts`): permission dialogs a TUI draws with its
 * choices as one row of buttons. The OpenCode screens are captures from a live
 * session with private text replaced by neutral text of the same length, so
 * every column is where OpenCode drew it, sidebar included. The MiMo Code
 * screen is built from the dialog's recorded text, in the same frame: MiMo
 * Code is built from OpenCode and draws its dialog with the same left border.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { compileDialogs, dialogPrompt, useDialogSignatures } from '../../src/core/dialogs.js';
import { detectPrompt } from '../../src/core/promptDetector.js';
import { ScreenRenderer } from '../../src/core/renderer.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'dialogs');
const OPENCODE_DIALOG = fs.readFileSync(path.join(fixtures, 'opencode-permission-dialog.txt'), 'utf8');
const OPENCODE_ANSWERED = fs.readFileSync(path.join(fixtures, 'opencode-permission-answered.txt'), 'utf8');

/** MiMo Code's dialog: two choices under the same title. */
const MIMO_DIALOG = `
  Removing the generated output folder.

  ┃  △ Permission required
  ┃
  ┃  ✗ Confirm irreversible deletion
  ┃  $ rm -rf dist/
  ┃
  ┃   Allow once   Reject                                     ⇆ select  enter confirm
`;

const DRAWN_COMMAND = '$ rm -rf build/output/generated && npm run build -- --mode production';

/**
 * OpenCode's dialog as the program draws it: `command` wrapped at word
 * boundaries within `width` characters inside the dialog, and, when
 * `sidebar` is set, a sidebar on the same rows, starting at the same column
 * on every row, as OpenCode lays it out.
 */
function drawnDialog(width: number, sidebar: boolean, command = DRAWN_COMMAND): string {
  const side = ['Connect from 75+ providers', 'use other models', 'Claude, GPT, Gemini etc', '', 'Connect provider'];
  const rows = ['△ Permission required', ''];
  let row = '';
  for (const word of command.split(' ')) {
    if (row !== '' && `${row} ${word}`.length > width) {
      rows.push(row);
      row = word;
    } else row = row === '' ? word : `${row} ${word}`;
  }
  rows.push(row, '');
  const drawn = rows.map((text, index) => {
    const after = sidebar ? (side[index % side.length] ?? '') : '';
    return `  ┃  ${text.padEnd(width + 30)}${after}`.trimEnd();
  });
  drawn.push(`  ┃   Allow once   Always allow   Reject${sidebar ? '      ⇆ select  enter confirm' : ''}`);
  return `${drawn.join('\n')}\n`;
}

/** `text` with the last `from` in it replaced: the dialog's, not the transcript's above it. */
function replaceLast(text: string, from: string, to: string): string {
  const at = text.lastIndexOf(from);
  return `${text.slice(0, at)}${to}${text.slice(at + from.length)}`;
}

/** The request part of a dialog's signature, which may hold ` | ` itself. */
function requestOf(screen: string): string {
  const prompt = detectPrompt(screen)!;
  return prompt.signature.split(' | ').slice(2, -prompt.options.length).join(' | ');
}

/** The capture as the daemon's grid holds it at a given width, before the program redraws. */
async function atWidth(screen: string, cols: number): Promise<string> {
  const renderer = new ScreenRenderer({ cols, rows: 80, scrollback: 1000 });
  await renderer.write(screen.replace(/\r?\n/g, '\r\n'));
  await renderer.flush();
  return renderer.snapshot().screen;
}

afterEach(() => {
  useDialogSignatures([]);
});

describe('detectPrompt: OpenCode and MiMo Code dialogs', () => {
  it('reads OpenCode’s dialog, sidebar and all, as a prompt with three choices', () => {
    const prompt = detectPrompt(OPENCODE_DIALOG);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('Permission required');
    expect(prompt!.options).toEqual(['Allow once', 'Always allow', 'Reject']);
  });

  it('reads it at every width the grid may reflow it to before OpenCode redraws', async () => {
    for (const cols of [40, 60, 80, 100, 120, 160, 200]) {
      const prompt = detectPrompt(await atWidth(OPENCODE_DIALOG, cols));
      expect(prompt?.options, `at ${String(cols)} columns`).toEqual(['Allow once', 'Always allow', 'Reject']);
    }
  });

  it('tells apart requests that differ anywhere in the dialog, at every width the grid may hold it', async () => {
    const edits = [
      ['printf', 'prints'],
      ['exit line', 'quit line'],
      ['PIPESTATUS[0]', 'PIPESTATUS[9]'],
    ];
    for (const [from, to] of edits) {
      const other = replaceLast(OPENCODE_DIALOG, from!, to!);
      expect(requestOf(other), `${from!} / ${to!}`).not.toBe(requestOf(OPENCODE_DIALOG));
      for (const cols of [40, 52, 60, 78, 79, 80, 100, 120, 156, 157, 158, 160, 200]) {
        const [left, right] = [await atWidth(OPENCODE_DIALOG, cols), await atWidth(other, cols)];
        expect(requestOf(left), `${from!} / ${to!} at ${String(cols)} columns`).not.toBe(requestOf(right));
      }
    }
  });

  it('gives a request redrawn at another width the same signature when nothing is drawn beside it', async () => {
    const signatures = new Set<string>();
    for (const width of [24, 41, 60, 90]) {
      const drawn = drawnDialog(width, false);
      signatures.add(detectPrompt(drawn)!.signature);
      // And as the daemon's grid holds it, at a width that fits it.
      const fits = Math.max(...drawn.split('\n').map((line) => line.length)) + 2;
      signatures.add(detectPrompt(await atWidth(drawn, fits))!.signature);
    }
    expect(signatures.size).toBe(1);
    expect(requestOf(drawnDialog(24, false))).toBe(DRAWN_COMMAND);
  });

  it('keeps apart long requests with a run of spaces, under a title with a key hint, at every width', async () => {
    const message = (tail: string): string => `git commit -m "${'x'.repeat(70)}   ${tail}"`;
    const hinted = (command: string): string =>
      drawnDialog(200, false, command).replace('△ Permission required', '△ Permission required   ctrl+c cancel');
    const [alpha, beta] = [hinted(message('alpha-unique')), hinted(message('beta-unique'))];
    expect(requestOf(alpha)).not.toBe(requestOf(beta));
    for (const cols of [40, 46, 60, 80, 90, 100, 120, 200]) {
      expect(requestOf(await atWidth(alpha, cols)), `at ${String(cols)} columns`).not.toBe(
        requestOf(await atWidth(beta, cols)),
      );
    }
  });

  it('keeps apart requests that differ only in their spaces, with or without a sidebar', () => {
    for (const sidebar of [false, true]) {
      const pairs = [
        ['echo a b', 'echo ab'],
        ['git commit -m "a b"', 'git commit -m "ab"'],
        ['npm   run   build', 'npm   run   test'],
        ['git commit -m "hello   world"', 'git commit -m "hello   there"'],
        ['git commit -m "feature work   alpha-unique"', 'git commit -m "feature work   beta-unique"'],
      ];
      for (const [left, right] of pairs) {
        expect(requestOf(drawnDialog(60, sidebar, left)), `${left} / ${right}`).not.toBe(
          requestOf(drawnDialog(60, sidebar, right)),
        );
      }
    }
  });

  it('finds nothing once the dialog is answered', () => {
    expect(detectPrompt(OPENCODE_ANSWERED)).toBeNull();
  });

  it('reads MiMo Code’s dialog with its two choices', () => {
    const prompt = detectPrompt(MIMO_DIALOG);
    expect(prompt?.question).toBe('Permission required');
    expect(prompt?.options).toEqual(['Allow once', 'Reject']);
  });

  it('reads MiMo Code’s dialog with its three choices, the middle one named its own way', () => {
    const prompt = detectPrompt(MIMO_DIALOG.replace('Allow once   Reject', 'Allow once   Allow always   Reject'));
    expect(prompt?.options).toEqual(['Allow once', 'Allow always', 'Reject']);
  });

  it('tells two requests apart, and the same request redrawn keeps its signature', () => {
    const first = detectPrompt(MIMO_DIALOG)!;
    const redrawn = detectPrompt(MIMO_DIALOG.replace('⇆ select', '⇆ select '))!;
    const other = detectPrompt(MIMO_DIALOG.replace('rm -rf dist/', 'rm -rf out/ '))!;
    expect(redrawn.signature).toBe(first.signature);
    expect(other.signature).not.toBe(first.signature);
  });

  it('is not hidden by a copy of the title further down the screen', () => {
    expect(detectPrompt(`${OPENCODE_DIALOG}  ┃  △ Permission required\n`)?.options).toHaveLength(3);
  });

  it('is not hidden by a row of choices further down with no title in reach', () => {
    const stray = `${MIMO_DIALOG}${'\n'.repeat(45)}  ┃   Allow once   Reject\n`;
    expect(detectPrompt(stray)?.question).toBe('Permission required');
  });

  it('is still read with a copy of its choices a few lines further down, its own text kept', () => {
    const copied = `${drawnDialog(60, false)}\n\n  ┃   Allow once   Reject\n`;
    expect(detectPrompt(copied)?.question).toBe('Permission required');
    expect(requestOf(copied)).toContain(DRAWN_COMMAND);
  });

  it('keeps box drawing at the start of a request row that is not the dialog’s own border', async () => {
    const asking = (row: string): string =>
      requestOf(`  ┃  △ Permission required\n  ┃  ${row}\n  ┃   Allow once   Reject\n`);
    expect(asking('─secret-aaa')).not.toBe(asking('secret-aaa'));
    // A wrap that leaves a `─` at the start of a row, against the same screen with a space there.
    const wrapped = (joint: string): string =>
      `  ┃  △ Permission required\n  ┃  echo ab${'x'.repeat(28)}${joint}cd-unique\n  ┃   Allow once   Reject\n`;
    expect(requestOf(await atWidth(wrapped('─'), 40))).not.toBe(requestOf(await atWidth(wrapped(' '), 40)));
  });

  it('keeps a line of the request that matches the choices, so two requests stay apart', () => {
    const quoting = (target: string): string =>
      `  ┃  △ Permission required\n  ┃   Allow once   Reject ${target}\n  ┃  $ rm -rf ${target}\n` +
      '  ┃   Allow once   Always allow   Reject\n';
    expect(detectPrompt(quoting('/tmp/foo'))?.options).toEqual(['Allow once', 'Always allow', 'Reject']);
    expect(requestOf(quoting('/tmp/foo'))).not.toBe(requestOf(quoting('/tmp/bar')));
  });

  it('does not count rows of nothing but border among the lines under the choices', () => {
    const under = ['  ┃', '  ctrl+f fullscreen', '  ⇆ select  enter confirm', '  ┃', '  ~/projects/example', '  ┃', '  -app'];
    expect(detectPrompt(`${MIMO_DIALOG}${under.join('\n')}\n`)?.options).toEqual(['Allow once', 'Reject']);
  });
});

describe('detectPrompt: what only quotes a dialog', () => {
  it('does not read a diff, a file listing or a code comment that quotes it', () => {
    const diff = '+  ┃  △ Permission required\n+  ┃  $ rm -rf dist/\n+  ┃   Allow once   Always allow   Reject\n';
    const listing =
      'src/x.ts:7: * OpenCode draws `△ Permission required` with `Allow once   Always\n' +
      'src/x.ts:8:   ┃   Allow once   Always allow   Reject\n';
    const comment =
      ' * OpenCode draws `△ Permission required` with `Allow once   Always allow\n' +
      ' *   Allow once   Always allow   Reject`.\n';
    for (const screen of [diff, listing, comment]) expect(detectPrompt(screen)).toBeNull();
  });

  it('does not read a transcript that quotes it without the frame, or with an input box under it', () => {
    const unframed = '  The dialog said:\n  △ Permission required\n  $ rm -rf dist/\n  Allow once   Reject\n';
    const framedAbovePrompt = [
      '  ┃  △ Permission required',
      '  ┃  $ rm -rf dist/',
      '  ┃   Allow once   Reject',
      '',
      '  Here is what it asked.',
      '  ╭──────────────────────╮',
      '  │ >                    │',
      '  ╰──────────────────────╯',
      '  ? for shortcuts',
    ].join('\n');
    expect(detectPrompt(unframed)).toBeNull();
    expect(detectPrompt(framedAbovePrompt)).toBeNull();
  });

  it('does not read a title without its choices, or choices too far below it', () => {
    expect(detectPrompt('  ┃  △ Permission required\n  ┃  thinking about it\n')).toBeNull();
    const farApart = ['  ┃  △ Permission required', ...Array<string>(45).fill('  ┃  line'), '  ┃   Allow once   Reject'];
    expect(detectPrompt(farApart.join('\n'))).toBeNull();
  });

  it('does not read prose that names the buttons with single spaces', () => {
    expect(detectPrompt('  ┃  △ Permission required\n  ┃  Choose Allow once or Reject to continue.\n')).toBeNull();
  });
});

describe('dialog signatures from config', () => {
  const PLAIN_DIALOG = 'Tool wants to run a command\n\n  [ Approve ]   [ Deny ]\n';

  it('recognises a dialog added in config, on top of the built-in ones', () => {
    expect(detectPrompt(PLAIN_DIALOG)).toBeNull();
    const problems = useDialogSignatures([
      { name: 'Example CLI', title: 'wants to run a command', choices: '\\[ Approve \\] {2,}\\[ Deny \\]' },
    ]);
    expect(problems).toEqual([]);
    const prompt = detectPrompt(PLAIN_DIALOG);
    expect(prompt?.question).toBe('wants to run a command');
    expect(prompt?.options).toEqual(['[ Approve ]', '[ Deny ]']);
    expect(detectPrompt(OPENCODE_DIALOG)?.question).toBe('Permission required');
  });

  it('reads each row of the request from where its text starts, left of the title or not', () => {
    useDialogSignatures([{ name: 'Example CLI', title: 'wants to run a command', choices: '\\[ Approve \\]' }]);
    const asking = (request: string): string =>
      detectPrompt(`Tool wants to run a command\n  ${request}\n\n  [ Approve ]   [ Deny ]\n`)!.signature;
    expect(asking('x')).not.toBe(asking('y'));
    expect(asking('rm -rf x')).toContain('rm -rf x');
    // A title matched along its line, over request rows drawn with a border.
    expect(asking('┃  $ rm -rf /tmp/foo')).not.toBe(asking('┃  $ rm -rf /tmp/bar'));
  });

  it('counts only box drawing left of the choices as border, not words', () => {
    useDialogSignatures([{ name: 'Example CLI', title: '^Confirm$', choices: 'Go' }]);
    expect(detectPrompt('Confirm\nabcdefghij Go now\n')?.options).toEqual(['Go']);
    expect(detectPrompt('Confirm\nabcdefghij Go now\nace\nbad\ndig\njab\nfed\n')).toBeNull();
  });

  it('keeps apart config requests whose own lines match the choices', () => {
    useDialogSignatures([
      { name: 'Go CLI', title: '^Confirm$', choices: 'Go' },
      { name: 'Example CLI', title: 'wants to run a command', choices: '\\[ Approve \\] {2,}\\[ Deny \\]' },
    ]);
    const confirm = (target: string): string => requestOf(`Confirm\nPrepare the release\nShip via Go for ${target}\nGo\n`);
    expect(confirm('foo')).not.toBe(confirm('bar'));
    const approve = (target: string): string =>
      requestOf(`Tool wants to run a command\necho [ Approve ]   [ Deny ] then ${target}\n\n[ Approve ]   [ Deny ]\n`);
    expect(approve('foo')).not.toBe(approve('bar'));
  });

  it('reports, by position and name, each entry it cannot use, and keeps the rest', () => {
    const { dialogs, problems, usable } = compileDialogs([
      { name: 'Broken', title: '(unclosed', choices: 'x' },
      { name: 'No choices', title: 'x' },
      { name: 'Too far', title: 'x', choices: 'y', within: 500 },
      { name: 'Too low', title: 'x', choices: 'y', below: -1 },
      'not an object',
      { name: 'Fine', title: 'x', choices: 'y', below: 0 },
    ]);
    expect(dialogs.map((dialog) => dialog.name)).toEqual(['Fine']);
    expect(usable).toEqual([5]);
    expect(problems).toHaveLength(5);
    expect(problems[0]).toContain('prompts.dialogs[0] (Broken)');
  });

  it('sets aside a pattern that runs past its budget, says so once and keeps the others working', () => {
    const reported: string[] = [];
    useDialogSignatures(
      [
        { name: 'Runaway', title: 'x', choices: '^(a+)+$' },
        { name: 'Fine', title: 'wants to run a command', choices: '\\[ Approve \\]' },
      ],
      (name) => void reported.push(name),
    );
    const screen = `${PLAIN_DIALOG}${'a'.repeat(40)}!\n`;
    const startedAt = Date.now();
    expect(dialogPrompt(screen.split('\n'))?.question).toBe('wants to run a command');
    expect(dialogPrompt(screen.split('\n'))?.question).toBe('wants to run a command');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(reported).toEqual(['Runaway']);
  });
});

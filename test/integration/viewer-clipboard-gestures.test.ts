import { beforeAll, expect, it } from 'vitest';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { captureViewer } from './browserCapture.js';
import { api, eventually, startTestDaemon } from './helpers.js';

const browser = await findBrowser();
const browserTest = it.skipIf(!browser);
const repeat: Record<string, unknown> = {};
const pasteGrants: string[] = [];
let afterRelease: unknown;
let delivered: unknown;
const selection: Record<string, unknown> = {};
const namedKeys: Record<string, unknown> = {};
let middlePress: unknown;
let staleWallClock: unknown;
let iPadSelection: unknown;

// Collect the observations in one browser on one private daemon.
beforeAll(async () => {
  if (!browser) return;
  const daemon = await startTestDaemon();
  try {
    const session = await api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, shell: false, openViewer: false, hold: true,
      args: ['-e', "process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('gesture fixture ready')"],
    } });
    expect(session.status).toBe(200);
    const grant = await api(daemon.port, daemon.token, '/sessions/' + String(session.body['id']) + '/viewer', { body: {} });
    expect(grant.status).toBe(200);
    const viewerUrl = String(grant.body['viewerUrl']);
    await captureViewer({ browser, viewerUrl, drive: true, probeOnly: true, width: 900, height: 600,
      setupTimeoutMs: 60_000, timeoutMs: 90_000,
      beforeNavigateScript: `
        const platform = sessionStorage.getItem('fixturePlatform') || 'MacIntel';
        Object.defineProperties(navigator, { platform: { value: platform },
          userAgentData: { value: { platform: platform === 'iPad' ? 'iPad' : 'macOS' } } });
        let panes;
        Object.defineProperty(window, 'ShellPuppetPane', { get: () => panes, set: implementation => {
          panes = { ...implementation, create(config) {
            const pane = implementation.create(config);
            window.term = pane.getTerminal();
            return pane;
          } };
        } });`,
      probe: "window.term && document.querySelector('.xterm-rows')?.textContent.includes('gesture fixture ready')",
      interact: async ({ evaluate, send, onEvent }) => {
        await send('Browser.grantPermissions', { origin: new URL(viewerUrl).origin,
          permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }, true);
        await evaluate(`(() => {
          window.input = [];
          term.onData(data => input.push(data));
          window.writeBytes = text => new Promise(done => term.write(new TextEncoder().encode(text), done));
          window.resetFocus = () => { term.textarea.blur(); term.focus(); };
          window.pastes = [];
          term.element.addEventListener('paste', e => pastes.push(e.isTrusted), true);
          // Probe whether a gesture admits payload validation. This payload is
          // always invalid, so it cannot change the clipboard on either revision.
          const decode = window.atob.bind(window);
          let checked = false;
          window.atob = text => {
            if (text === '!!!!') checked = true;
            return decode(text);
          };
          window.gate = async () => {
            checked = false;
            await writeBytes('\\x1b]52;c;!!!!\\x07');
            return checked;
          };
          term.focus();
        })()`);
        const gate = () => evaluate('gate()');
        const key = (type: 'keyDown' | 'keyUp', key: string, code: string, modifiers = 0,
          extra: Record<string, unknown> = {}) => send('Input.dispatchKeyEvent', { type, key, code, modifiers, ...extra });
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
        await key('keyDown', 'x', 'KeyX', 0, { text: 'x' });
        expect(await gate()).toBe(true);
        await wait(1100);
        await key('keyDown', 'x', 'KeyX', 0, { text: 'x', autoRepeat: true });
        await wait(1100);
        repeat.extended = await gate();
        await evaluate('resetFocus()');
        await key('keyDown', 'x', 'KeyX', 0, { text: 'x', autoRepeat: true });
        repeat.opened = await gate();
        await key('keyUp', 'x', 'KeyX');
        repeat.input = await evaluate("input.filter(data => data === 'x')");

        // Suppress the browser's default paste while checking the keys
        // individually. A subsequent paste must revoke an existing gesture.
        await evaluate(`window.suppressDefault = e => e.preventDefault();
          window.addEventListener('keydown', suppressDefault, true)`);
        for (const [modifier, code, mask] of [['Control', 'ControlLeft', 2], ['Shift', 'ShiftLeft', 8],
          ['Meta', 'MetaLeft', 4], ['Alt', 'AltLeft', 1]] as const) {
          await evaluate('resetFocus()');
          await key('keyDown', modifier, code, mask);
          if (await gate()) pasteGrants.push(modifier);
          await key('keyUp', modifier, code);
        }
        for (const [name, code, mask] of [['v', 'KeyV', 2], ['Insert', 'Insert', 8],
          ['v', 'KeyV', 4], ['V', 'KeyV', 10]] as const) {
          await evaluate('resetFocus()');
          await key('keyDown', name, code, mask);
          if (await gate()) pasteGrants.push(`${code} modifiers ${mask}`);
          await key('keyUp', name, code);
        }
        for (const name of ['CapsLock', 'F1', 'Paste', 'MediaPlayPause']) {
          await evaluate('resetFocus()');
          await key('keyDown', name, name);
          namedKeys[name] = await gate();
          await key('keyUp', name, name);
        }
        await evaluate("window.removeEventListener('keydown', suppressDefault, true)");
        await evaluate("navigator.clipboard.writeText('fixture paste')");
        await key('keyDown', 'j', 'KeyJ', 0, { text: 'j' });
        await key('keyUp', 'j', 'KeyJ');
        expect(await gate()).toBe(true);
        // Keep this shortcut out of the pane but allow the browser's native
        // edit command, so only the subsequent paste can revoke the press.
        await evaluate("window.addEventListener('keydown', e => e.stopPropagation(), { capture: true, once: true })");
        const nativePaste = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86,
          modifiers: process.platform === 'darwin' ? 4 : 2 };
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...nativePaste, commands: ['Paste'] });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...nativePaste });
        await eventually(async () => await evaluate('pastes.at(-1)') === true, 3000, 20, 'trusted paste');
        expect(await evaluate('input.at(-1)')).toContain('fixture paste');
        if (await gate()) pasteGrants.push('after paste');

        const grid = await evaluate(`(() => {
          const r = term.element.querySelector('.xterm-screen').getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width / term.cols, height: r.height / term.rows };
        })()`) as { left: number; top: number; width: number; height: number };
        const mouse = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', col: number, row: number, modifiers = 0) =>
          send('Input.dispatchMouseEvent', { type, x: grid.left + (col + 0.2) * grid.width,
            y: grid.top + (row + 0.5) * grid.height, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
            modifiers, clickCount: 1 });
        await mouse('mousePressed', 1, 0);
        expect(await gate()).toBe(true);
        await wait(2100);
        expect(await gate()).toBe(false);
        await mouse('mouseReleased', 1, 0);
        afterRelease = await gate();
        await evaluate('resetFocus()');
        const middle = { x: grid.left + grid.width, y: grid.top + grid.height / 2, button: 'middle', clickCount: 1 };
        await send('Input.dispatchMouseEvent', { ...middle, type: 'mousePressed', buttons: 4 });
        middlePress = await gate();
        await send('Input.dispatchMouseEvent', { ...middle, type: 'mouseReleased', buttons: 0 });

        await key('keyDown', 'x', 'KeyX', 0, { text: 'x' });
        await key('keyUp', 'x', 'KeyX');
        expect(await gate()).toBe(true);
        staleWallClock = await evaluate(`(async () => {
          const now = Date.now;
          try { Date.now = () => now() + 60_000; return await gate(); }
          finally { Date.now = now; }
        })()`);

        // The public parser removes LF from the byte stream before validating
        // the remaining base64. Observe the delivered text and the local copy.
        await key('keyDown', 'j', 'KeyJ', 0, { text: 'j' });
        await key('keyUp', 'j', 'KeyJ');
        delivered = await evaluate(`(async () => {
          let payload, pending;
          const listener = term.parser.registerOscHandler(52, text => { payload = text; return false; });
          const clipboard = navigator.clipboard;
          const write = clipboard.writeText.bind(clipboard);
          clipboard.writeText = text => pending = write(text);
          try {
            await writeBytes('\\x1b]52;c;Y\\nQ==\\x07');
            await pending;
            return { payload, copied: await clipboard.readText() };
          } finally { delete clipboard.writeText; listener.dispose(); }
        })()`);

        await evaluate("writeBytes('\\x1b[2J\\x1b[H0123456789\\r\\nabcdefghij\\r\\nABCDEFGHIJ\\x1b[?1002h\\x1b[?1006h')");
        await evaluate('input.length = 0');
        await mouse('mousePressed', 1, 0, 1);
        await mouse('mouseReleased', 1, 0, 1);
        selection.optionClick = await evaluate('input.slice()');
        await evaluate('input.length = 0');
        await mouse('mousePressed', 1, 0, 1);
        await mouse('mouseMoved', 4, 2, 1);
        await mouse('mouseReleased', 4, 2, 1);
        selection.optionDrag = await evaluate('input.slice()');
        selection.trackedText = await evaluate('term.getSelection()');

        await key('keyDown', 'Shift', 'ShiftLeft', 8);
        await mouse('mousePressed', 1, 0, 8);
        await mouse('mouseMoved', 4, 0, 8);
        await key('keyUp', 'Shift', 'ShiftLeft');
        selection.afterShift = await evaluate('term.options.macOptionClickForcesSelection');
        await mouse('mouseReleased', 4, 0);
        selection.shiftText = await evaluate('term.getSelection()');
        selection.afterDrag = await evaluate('term.options.macOptionClickForcesSelection');

        await evaluate("writeBytes('\\x1b[?1002l\\x1b[?1006l')");
        await mouse('mousePressed', 1, 0, 1);
        await mouse('mouseMoved', 4, 2, 1);
        await mouse('mouseReleased', 4, 2, 1);
        selection.rectangle = await evaluate("term.getSelection().split(/\\r?\\n/)");

        // xterm reads navigator.platform at load time. Keep the browser and
        // session, and load the viewer again with the mobile iPad platform.
        await evaluate("sessionStorage.setItem('fixturePlatform', 'iPad')");
        let loaded = false;
        const unsubscribe = onEvent('Page.loadEventFired', () => { loaded = true; });
        try {
          await send('Page.reload');
          await eventually(() => loaded, 30_000, 50, 'iPad viewer to reload');
        } finally { unsubscribe(); }
        await eventually(async () => await evaluate(
          "navigator.platform === 'iPad' && document.querySelector('.xterm-rows')?.textContent.includes('gesture fixture ready')") === true);
        await evaluate(`new Promise(done => term.write('\\x1b[2J\\x1b[H0123456789\\r\\nabcdefghij\\r\\nABCDEFGHIJ\\x1b[?1002h', done))`);
        await mouse('mousePressed', 1, 0, 8);
        await mouse('mouseMoved', 4, 2, 8);
        await mouse('mouseReleased', 4, 2, 8);
        iPadSelection = await evaluate("term.getSelection().split(/\\r?\\n/)");
      },
    });
  } finally { await daemon.stop(); }
}, 180_000);

browserTest('repeated keys reach the terminal without opening or extending clipboard access', () => {
  expect(repeat).toEqual({ extended: false, opened: false, input: ['x', 'x', 'x'] });
});

browserTest('paste shortcuts and their modifiers grant nothing and a paste clears a pending press', () => {
  expect(pasteGrants).toEqual([]);
});

browserTest('releasing a held mouse button does not renew clipboard access', () => {
  expect(afterRelease).toBe(false);
});

browserTest('macOS Shift selects locally and Option retains the active terminal mode', () => {
  expect(selection).toEqual({
    optionClick: ['\x1b[<8;2;1M', '\x1b[<8;2;1m'],
    optionDrag: ['\x1b[<8;2;1M', '\x1b[<40;5;3M', '\x1b[<8;5;3m'],
    trackedText: '', afterShift: false, shiftText: '123', afterDrag: false, rectangle: ['123', 'bcd', 'BCD'],
  });
});

browserTest('validates the payload delivered by the OSC parser after it consumes a line feed', () => {
  expect(delivered).toEqual({ payload: 'c;YQ==', copied: 'a' });
});

browserTest('a middle-button press grants nothing before release', () => {
  expect(middlePress).toBe(false);
});

browserTest.each(['CapsLock', 'F1', 'Paste', 'MediaPlayPause'])('%s leaves the clipboard window closed', name => {
  expect(namedKeys[name]).toBe(false);
});

browserTest('a fresh event timestamp cannot outlast the wall-clock deadline', () => {
  expect(staleWallClock).toBe(false);
});

browserTest('iPad Shift-drag selects continuous text across rows while the program tracks the mouse', () => {
  expect(iPadSelection).toEqual(['123456789', 'abcdefghij', 'ABCD']);
});

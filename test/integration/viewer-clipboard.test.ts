import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { captureViewer } from './browserCapture.js';
import { api, eventually, startTestDaemon } from './helpers.js';

it('copies OSC 52 output only after interacting with the focused viewer or dashboard pane', async context => {
  const browser = await findBrowser();
  if (!browser) { context.skip(); return; }
  let dashboardUrl = '';
  const daemon = await startTestDaemon({ launcher: url => {
    dashboardUrl = url;
    return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' });
  } });
  try {
    const fixture = fileURLToPath(new URL('../fixtures/osc52.mjs', import.meta.url));
    const start = () => api(daemon.port, daemon.token, '/sessions', { body: {
      command: process.execPath, args: [fixture], shell: false, openViewer: false, hold: true,
    } });
    const started = await start();
    expect(started.status).toBe(200);
    const path = '/sessions/' + String(started.body['id']);
    const grant = await api(daemon.port, daemon.token, path + '/viewer', { body: { readOnly: true } });
    expect(grant.status).toBe(200);
    const viewerUrl = String(grant.body['viewerUrl']);
    await captureViewer({ browser, viewerUrl, drive: true, probeOnly: true, width: 900, height: 600,
      setupTimeoutMs: 60_000, timeoutMs: 90_000,
      // Exercise xterm's Option-based selection path on every host.
      beforeNavigateScript: `if (location.pathname === '/view') {
        Object.defineProperties(navigator, { platform: { value: 'MacIntel' },
          userAgentData: { value: { platform: 'macOS' } } });
      }`,
      probe: "document.querySelector('#readonly')?.disabled && document.querySelector('.xterm-rows')?.textContent.includes('fixture ready')",
      interact: async ({ evaluate, send }) => {
        await send('Browser.grantPermissions', { origin: new URL(viewerUrl).origin,
          permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }, true);
        expect(await evaluate(`(async () => {
          const clipboard = navigator.clipboard;
          await clipboard.writeText('previous contents');
          window.fixtureRead = clipboard.readText.bind(clipboard);
          window.fixtureReads = 0;
          for (const key of ['readText', 'read']) {
            clipboard[key] = () => { window.fixtureReads++; throw new Error('unexpected read'); };
          }
          window.fixtureSends = [];
          const send = WebSocket.prototype.send;
          WebSocket.prototype.send = function (data) { window.fixtureSends.push(data); return send.call(this, data); };
          document.querySelector('.xterm-helper-textarea').focus();
          return document.hasFocus();
        })()`)).toBe(true);
        const point = await evaluate(`(() => { const r = document.querySelector('.xterm-screen').getBoundingClientRect();
          return { x: r.left + 2, y: r.top + 5 }; })()`) as { x: number; y: number };
        const click = async () => {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
          }
        };
        let count = 0;
        const emit = async (command: string, rows = '#term .xterm-rows') => {
          const response = await api(daemon.port, daemon.token, path + '/input', { body: { data: command } });
          expect(response.status).toBe(200);
          const marker = 'parsed-' + String(++count);
          await eventually(async () => await evaluate(
            `document.querySelector('${rows}').textContent.includes('${marker}')`) === true, 10_000, 20, marker);
        };
        const read = () => evaluate('window.fixtureRead()');
        await emit('c');
        expect(await read()).toBe('previous contents');
        await click();
        await emit('a');
        await expect.poll(read).toBe('pane copy ✓');
        expect(await evaluate("document.querySelector('#copy-notice:not([hidden])')?.textContent")).toContain('Copied');
        await new Promise(resolve => setTimeout(resolve, 2100));
        await emit('c');
        expect(await read()).toBe('pane copy ✓');

        await click();
        await evaluate("document.querySelector('#zoom-in').focus()");
        await emit('c');
        expect(await read()).toBe('pane copy ✓');
        await evaluate("document.querySelector('.xterm-helper-textarea').focus()");
        for (const command of ['d', 'e', 'f', 'g']) {
          await click();
          await emit(command);
          expect(await read()).toBe('pane copy ✓');
        }
        expect(await evaluate('window.fixtureReads')).toBe(0);
        expect(await evaluate('window.fixtureSends')).toEqual([]);
        expect(await evaluate("document.querySelector('#banner').hidden")).toBe(true);

        // A keyboard gesture also authorises the empty target on a read-only link.
        await evaluate("navigator.clipboard.writeText('before key')");
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x', code: 'KeyX', text: 'x' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'x', code: 'KeyX' });
        await emit('b');
        await expect.poll(read).toBe('pane copy ✓');

        await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true, value: () => Promise.reject(new Error('permission denied')) })`);
        await click();
        await emit('a');
        expect(await evaluate("document.querySelector('#banner:not([hidden])')?.textContent")).toContain('Could not copy');
        await evaluate("document.querySelector('#banner').hidden = true");
        await click();
        await emit('a');
        expect(await evaluate("document.querySelector('#banner').hidden")).toBe(true);

        await api(daemon.port, daemon.token, path + '/input', { body: { data: 'h' } });
        await eventually(async () => await evaluate(
          "!!document.querySelector('.xterm.enable-mouse-events') && document.querySelector('.xterm-rows').textContent.includes('select this line')") === true);
        const drag = { ...point, button: 'left', modifiers: 8, clickCount: 1 };
        await send('Input.dispatchMouseEvent', { ...drag, type: 'mousePressed', buttons: 1 });
        await send('Input.dispatchMouseEvent', { ...drag, type: 'mouseMoved', x: point.x + 70, buttons: 1 });
        await send('Input.dispatchMouseEvent', { ...drag, type: 'mouseReleased', x: point.x + 70 });
        expect(await evaluate(`(() => {
          let selected = '';
          document.addEventListener('copy', e => { selected = e.clipboardData.getData('text/plain'); }, { once: true });
          document.execCommand('copy');
          return selected;
        })()`)).toMatch(/^select/);
        expect(await evaluate('window.fixtureSends')).toEqual([]);

        // Reuse this browser for a real dashboard. A key in the second pane
        // can trigger its own copy while output from the first stays local.
        const second = await start();
        expect(second.status).toBe(200);
        expect((await api(daemon.port, daemon.token, '/dashboard/open', { body: {} })).status).toBe(200);
        await send('Page.navigate', { url: dashboardUrl });
        const secondPane = `.pane[data-session="${String(second.body['id'])}"]`;
        const firstPane = `.pane[data-session="${String(started.body['id'])}"]`;
        await eventually(async () => await evaluate(
          `document.querySelector('${secondPane} .xterm-rows')?.textContent.includes('fixture ready') &&
           !!document.querySelector('${firstPane} .xterm-screen')`) === true);
        await evaluate(`document.querySelector('${secondPane} textarea').focus()`);
        await evaluate("navigator.clipboard.writeText('before dashboard key')");
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
        await expect.poll(() => evaluate('navigator.clipboard.readText()')).toBe('pane copy ✓');
        expect(await evaluate(`document.querySelector('${secondPane} [role=status]:not([hidden])')?.textContent`)).toContain('Copied');
        await emit('c', firstPane + ' .xterm-rows');
        expect(await evaluate('navigator.clipboard.readText()')).toBe('pane copy ✓');
      },
    });
  } finally {
    await daemon.stop();
  }
}, 180_000);

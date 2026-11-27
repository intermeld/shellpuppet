import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, it } from 'vitest';
import { findBrowser } from '../../src/daemon/viewerLauncher.js';
import { captureViewer } from './browserCapture.js';
import { captureDashboard } from './dashboardCapture.js';
import { api, connectWs, eventually, startTestDaemon } from './helpers.js';

const browser = await findBrowser();

it.skipIf(!browser)('delivers mouse movement in the session encoding on attach, reconnect and reset', async () => {
  let dashboardUrl = '';
  const td = await startTestDaemon({ launcher: url => {
    dashboardUrl = url;
    return Promise.resolve({ launched: true, mode: 'isolated-app', browser: 'mock' });
  } });
  try {
    const input = path.join(td.home, 'mouse-input');
    fs.writeFileSync(input, '');
    const program = [
      'process.stdin.setRawMode(true);',
      'process.stdin.on("data", bytes => {',
      'if (bytes.toString() === "r") process.stdout.write("REJOINED\\r\\n");',
      'else if (bytes.toString() === "d") process.stdout.write("\\x1b[?1006lDEFAULT\\r\\n");',
      'else require("node:fs").appendFileSync(process.argv[1], bytes); });',
      'process.stdout.write("\\x1b[?1003h\\x1b[?1006hREADY\\r\\n");',
    ].join(' ');
    const started = await api(td.port, td.token, '/sessions', { body: {
      command: process.execPath, args: ['-e', program, input], shell: false, openViewer: false,
      cols: 80, rows: 24, hold: true,
    } });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const observer = await connectWs(td.port, id, td.token, {}, { drive: false });
    try {
      await observer.waitForData('READY');
      const grant = async () => {
        const response = await api(td.port, td.token, `/sessions/${id}/viewer`, { body: {} });
        expect(response.status).toBe(200);
        return String(response.body['viewerUrl']);
      };
      const visible = (marker: string) =>
        `document.fonts.status === 'loaded' && document.querySelector('.xterm-rows')?.textContent.includes(${JSON.stringify(marker)})`;
      const move = async (viewerUrl: string, marker: string, col: number, reconnect = false) => {
        const capture = reconnect ? captureDashboard : captureViewer;
        await capture({ browser: browser!, viewerUrl, drive: true, probeOnly: true,
          width: 1280, height: 800, setupTimeoutMs: 60_000, timeoutMs: 60_000, probe: visible(marker),
          interact: async ({ evaluate, send }) => {
            if (reconnect) {
              // The new marker can only reach this pane in the reconnect snapshot.
              await evaluate(`new Promise(resolve => {
                const stream = window.__dashboardDiagnostics.streams.find(s => s.url.includes('/stream'));
                stream.socket.addEventListener('close', () => resolve(true), { once: true });
                stream.socket.close();
              })`);
              observer.ws.send('r');
              await observer.waitForData('REJOINED');
              await eventually(async () => await evaluate(visible('REJOINED')) === true);
            }
            // The held 80 x 24 grid puts this point in the centre of row 5.
            const point = await evaluate(`(() => {
              const r = document.querySelector('.xterm-screen').getBoundingClientRect();
              return { x: r.left + ${col - 0.5} * r.width / 80, y: r.top + 4.5 * r.height / 24 };
            })()`) as { x: number; y: number };
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
            return true;
          },
        });
        const sgr = `\x1b[<35;${col};5M`;
        const legacy = '\x1b[M' + String.fromCharCode(35 + 32, col + 32, 5 + 32);
        const received = () => fs.readFileSync(input, 'latin1');
        await eventually(() => received().includes(sgr) || received().includes(legacy),
          10_000, 50, 'mouse movement at the PTY', () => Buffer.from(received(), 'latin1').toString('hex'));
        return received().includes(sgr) ? sgr : legacy;
      };
      const attached = await move(await grant(), 'READY', 10);
      expect((await api(td.port, td.token, '/dashboard/open', { method: 'POST', body: {} })).status).toBe(200);
      const reconnected = await move(dashboardUrl, 'READY', 11, true);
      observer.ws.send('d');
      await observer.waitForData('DEFAULT');
      const reset = await move(await grant(), 'DEFAULT', 12);

      expect({ attached, reconnected, reset }).toEqual({
        attached: '\x1b[<35;10;5M', reconnected: '\x1b[<35;11;5M', reset: '\x1b[MC,%',
      });
    } finally { observer.close(); }
  } finally { await td.stop(); }
}, 240_000);

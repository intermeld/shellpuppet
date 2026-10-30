/**
 * The audit log never captures typed content by default (design §4.5), and
 * session environment hygiene actually filters what child processes see
 * (design §4.6).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAuditor, auditLogPath } from '../../src/daemon/audit.js';
import {
  api,
  connectWs,
  connectWsWithCookie,
  eventually,
  makeTempHome,
  redeemViewerUrl,
  repoRoot,
  startTestDaemon,
} from './helpers.js';
import type { TestDaemon, WsClient } from './helpers.js';
import { NULL_LOGGER } from '../../src/core/types.js';
import type { Logger } from '../../src/core/types.js';

const SECRET = 'hunter2-super-secret-passphrase';

interface AuditLine {
  time: string;
  actor: string;
  action: string;
  session?: string;
  meta?: Record<string, unknown>;
}

function readAudit(home: string): AuditLine[] {
  return fs
    .readFileSync(auditLogPath(home), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as AuditLine);
}

const daemons: TestDaemon[] = [];
async function auditedDaemon(captureContent: boolean): Promise<TestDaemon> {
  const home = makeTempHome('shellpuppet-audit-');
  const td = await startTestDaemon({
    home,
    audit: createAuditor(home, { captureContent }),
  });
  daemons.push(td);
  return td;
}

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.stop();
});

async function startSpin(
  td: TestDaemon,
  actor?: string,
): Promise<{ id: string; viewerUrl: string }> {
  const started = await api(td.port, td.token, '/sessions', {
    body: {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 200)'],
      shell: false,
    },
    ...(actor !== undefined ? { headers: { 'x-shellpuppet-actor': actor } } : {}),
  });
  expect(started.status).toBe(200);
  const body = started.body as { id: string; viewerUrl: string };
  return { id: String(body.id), viewerUrl: String(body.viewerUrl) };
}

describe('audit log (§4.5)', () => {
  it('NEVER records typed content by default: length only; commands are recorded', async () => {
    const td = await auditedDaemon(false);
    const { id } = await startSpin(td, 'cli');

    await api(td.port, td.token, `/sessions/${id}/input`, {
      body: { data: SECRET },
      headers: { 'x-shellpuppet-actor': 'cli' },
    });
    await api(td.port, td.token, `/sessions/${id}/key`, {
      body: { key: 'enter' },
      headers: { 'x-shellpuppet-actor': 'cli' },
    });
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });

    const raw = fs.readFileSync(auditLogPath(td.home), 'utf8');
    // The load-bearing assertion of the whole feature:
    expect(raw).not.toContain(SECRET);

    const lines = readAudit(td.home);
    const input = lines.find((l) => l.action === 'input');
    expect(input?.actor).toBe('cli');
    expect(input?.session).toBe(id);
    expect(input?.meta?.['chars']).toBe(SECRET.length);
    expect(input?.meta?.['data']).toBeUndefined();

    const start = lines.find((l) => l.action === 'start');
    expect(start?.meta?.['command']).toBe(process.execPath); // commands ARE audited
    expect(lines.find((l) => l.action === 'key')?.meta?.['key']).toBe('enter');
    expect(lines.some((l) => l.action === 'kill')).toBe(true);
  });

  it('captureContent: true records input verbatim (the documented secret-capturing opt-in)', async () => {
    const td = await auditedDaemon(true);
    const { id } = await startSpin(td);
    await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: SECRET } });

    const input = readAudit(td.home).find((l) => l.action === 'input');
    expect(input?.meta?.['data']).toBe(SECRET);
  });

  it("attributes a browser's keystrokes and connection to the viewer actor", async () => {
    const td = await auditedDaemon(false);
    const { id, viewerUrl } = await startSpin(td);
    const cookie = await redeemViewerUrl(viewerUrl);
    const ws = await connectWsWithCookie(td.port, id, cookie);
    ws.ws.send('typed-by-human');
    await eventually(() =>
      readAudit(td.home).some((l) => l.action === 'input' && l.actor === 'viewer'),
    );
    ws.close();
    await eventually(() => readAudit(td.home).some((l) => l.action === 'ws-close'));

    const lines = readAudit(td.home);
    expect(lines.some((l) => l.action === 'ws-connect' && l.actor === 'viewer')).toBe(true);
    const humanInput = lines.find((l) => l.action === 'input' && l.actor === 'viewer');
    expect(humanInput?.meta?.['chars']).toBe('typed-by-human'.length);
    expect(fs.readFileSync(auditLogPath(td.home), 'utf8')).not.toContain('typed-by-human');
  });

  it('attributes a client-token socket to the client actor, not the human', async () => {
    // An agent or a script driving a session over the WebSocket must not
    // appear in the log as the human watching it: the credential that opened
    // the socket travels into the attachment.
    const td = await auditedDaemon(false);
    const { id } = await startSpin(td);
    const ws = await connectWs(td.port, id, td.token);
    ws.ws.send('typed-by-a-token-holder');
    await eventually(() =>
      readAudit(td.home).some((l) => l.action === 'input' && l.actor === 'client'),
    );
    ws.close();
    await eventually(() => readAudit(td.home).some((l) => l.action === 'ws-close'));

    const lines = readAudit(td.home).filter((l) => l.session === id);
    expect(lines.some((l) => l.action === 'ws-connect' && l.actor === 'client')).toBe(true);
    expect(lines.some((l) => l.action === 'ws-close' && l.actor === 'client')).toBe(true);
    // And nothing about this socket was filed under the human.
    expect(lines.some((l) => l.actor === 'viewer')).toBe(false);
  });

  it('records a geometry change over HTTP with its actor, grid and hold', async () => {
    // `resize` is on the published list of audited actions; this pins the
    // line that writes it.
    const td = await auditedDaemon(false);
    const { id } = await startSpin(td, 'cli');
    const resized = await api(td.port, td.token, `/sessions/${id}/resize`, {
      body: { cols: 96, rows: 26, hold: true },
      headers: { 'x-shellpuppet-actor': 'cli' },
    });
    expect(resized.status).toBe(200);

    // And a refusal writes nothing: the grid did not move, so no line may
    // say it did.
    const refused = await api(td.port, td.token, `/sessions/${id}/resize`, {
      body: { cols: 1, rows: 26 },
      headers: { 'x-shellpuppet-actor': 'cli' },
    });
    expect(refused.status).toBe(400);

    const resizes = readAudit(td.home).filter((l) => l.action === 'resize' && l.session === id);
    expect(resizes).toHaveLength(1);
    expect(resizes[0]?.actor).toBe('cli');
    expect(resizes[0]?.meta?.['cols']).toBe(96);
    expect(resizes[0]?.meta?.['rows']).toBe(26);
    expect(resizes[0]?.meta?.['hold']).toBe(true);
  });

  it('records a geometry change a viewport made, and only when it took', async () => {
    // A viewport is the actor whose geometry changes a reader most wants to
    // see, so its resizes are logged too.
    const td = await auditedDaemon(false);
    const { id, viewerUrl } = await startSpin(td);
    const cookie = await redeemViewerUrl(viewerUrl);
    const ws = await connectWsWithCookie(td.port, id, cookie);
    await ws.waitForControl((c) => c['type'] === 'geometry');

    ws.ws.send(JSON.stringify({ type: 'resize', cols: 88, rows: 22 }));
    await eventually(() =>
      readAudit(td.home).some((l) => l.action === 'resize' && l.session === id),
    );
    // Asking again for the grid it already has changes nothing, so it adds
    // no line: control may change hands, the geometry does not.
    ws.ws.send(JSON.stringify({ type: 'resize', cols: 88, rows: 22 }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    ws.close();

    const resizes = readAudit(td.home).filter((l) => l.action === 'resize' && l.session === id);
    expect(resizes).toHaveLength(1);
    expect(resizes[0]?.actor).toBe('viewer');
    expect(resizes[0]?.meta?.['cols']).toBe(88);
    expect(resizes[0]?.meta?.['rows']).toBe(22);
    // A viewport never holds: holding is asked for explicitly, over the API.
    expect(resizes[0]?.meta?.['hold']).toBe(false);
  });

  it('defaults the actor to "client" and caps oversized actor names', async () => {
    // (Control characters cannot even be SENT via fetch/undici, which rejects
    // them client-side, so the daemon's control-strip is exercised only
    // by hand-rolled raw clients; here we cover the default and the length cap.)
    const td = await auditedDaemon(false);
    await startSpin(td); // no actor header
    const { id: id2 } = await startSpin(td, 'x'.repeat(200));

    const lines = readAudit(td.home);
    expect(lines.some((l) => l.action === 'start' && l.actor === 'client')).toBe(true);
    const capped = lines.find((l) => l.action === 'start' && l.session === id2);
    expect(capped?.actor).toBe('x'.repeat(64));
  });
});

describe("audit log: the viewer's terminal answering the program (§4.5, §5)", () => {
  const FOCUS_SINK = path.join(repoRoot, 'test', 'fixtures', 'focus-sink.mjs');
  // The daemon's part, forwarding the bytes, filing a report and announcing
  // nothing, is what these tests pin. The focus sink echoes what it reads, so
  // the program's side shows the bytes arrived.

  function humanNotices(client: WsClient): number {
    return client
      .controls()
      .filter((c) => c['type'] === 'input-source' && c['source'] === 'human').length;
  }

  it('forwards a focus report to the program, and files it as a report rather than as a person typing', async () => {
    const td = await auditedDaemon(false);
    const started = await api(td.port, td.token, '/sessions', {
      body: { command: process.execPath, args: [FOCUS_SINK], shell: false },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    const viewer = await connectWsWithCookie(
      td.port,
      id,
      await redeemViewerUrl(String(started.body['viewerUrl'])),
    );
    // A second viewer watching: its header is the one that would claim a
    // person typed.
    const minted = await api(td.port, td.token, `/sessions/${id}/viewer`, { body: {} });
    const watcher = await connectWsWithCookie(
      td.port,
      id,
      await redeemViewerUrl(String(minted.body['viewerUrl'])),
    );
    await watcher.waitForData('SINK READY');
    const sessionLines = (): AuditLine[] =>
      readAudit(td.home).filter((l) => l.session === id);

    // What xterm.js sends once the program has switched focus reporting on.
    viewer.ws.send('\x1b[I');
    // The program asked for it, so it still gets it.
    await watcher.waitForData('GOT[ESC[I]');
    // The daemon files the report as the message arrives.
    await eventually(() => sessionLines().some((l) => l.action === 'report'));
    // A barrier on the watcher's socket: the agent's own input, echoed back,
    // reaches the watcher after anything the daemon announced while filing
    // the report, which happened in the same step as the filing.
    const typed = await api(td.port, td.token, `/sessions/${id}/input`, { body: { data: 'z' } });
    expect(typed.status).toBe(200);
    await watcher.waitForData('GOT[z]');
    expect({
      reports: sessionLines()
        .filter((l) => l.action === 'report')
        .map((l) => ({ actor: l.actor, meta: l.meta })),
      inputs: sessionLines().filter((l) => l.action === 'input' && l.actor === 'viewer').length,
      humanNoticesToTheWatcher: humanNotices(watcher),
      humanNoticesToTheSender: humanNotices(viewer),
    }).toEqual({
      // Its kind and length, and no content by default.
      reports: [{ actor: 'viewer', meta: { kind: 'focus-in', chars: 3 } }],
      inputs: 0,
      humanNoticesToTheWatcher: 0,
      humanNoticesToTheSender: 0,
    });

    // A keystroke is still a person typing.
    viewer.ws.send('a');
    await watcher.waitForData('GOT[a]');
    await watcher.waitForControl((c) => c['type'] === 'input-source' && c['source'] === 'human');
    expect({
      inputs: sessionLines()
        .filter((l) => l.action === 'input' && l.actor === 'viewer')
        .map((l) => ({ actor: l.actor, meta: l.meta })),
      humanNoticesToTheWatcher: humanNotices(watcher),
    }).toEqual({
      inputs: [{ actor: 'viewer', meta: { chars: 1 } }],
      humanNoticesToTheWatcher: 1,
    });

    viewer.close();
    watcher.close();
  });

  it('records what a report said only under captureContent, as for input', async () => {
    const td = await auditedDaemon(true);
    const { id } = await startSpin(td);
    const ws = await connectWs(td.port, id, td.token);
    ws.ws.send('\x1b[O');
    await eventually(() =>
      readAudit(td.home).some((l) => l.action === 'report' && l.session === id),
    );
    const lines = readAudit(td.home).filter((l) => l.session === id);
    const report = lines.find((l) => l.action === 'report');
    expect(report?.actor).toBe('client');
    expect(report?.meta).toEqual({ kind: 'focus-out', chars: 3, data: '\x1b[O' });
    expect(lines.some((l) => l.action === 'input')).toBe(false);
    ws.close();
  });
});

describe('session environment hygiene (§4.6)', () => {
  process.env['SHELLPUPPET_CANARY'] = 'leak-me';
  process.env['SHELLPUPPET_CANARY_2'] = 'leak-me-too';
  afterAll(() => {
    delete process.env['SHELLPUPPET_CANARY'];
    delete process.env['SHELLPUPPET_CANARY_2'];
  });

  async function envReport(td: TestDaemon): Promise<string> {
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: [
          '-e',
          "console.log('REPORT canary=' + process.env.SHELLPUPPET_CANARY + ' canary2=' + process.env.SHELLPUPPET_CANARY_2 + ' path=' + (process.env.PATH ? 'yes' : 'no') + ' term=' + process.env.TERM)",
        ],
        shell: false,
      },
    });
    const id = String((started.body as { id: string }).id);
    const waited = await api(
      td.port,
      td.token,
      `/sessions/${id}/wait?text=REPORT&timeout=20000&debounce=300`,
    );
    return String(waited.body['screen']);
  }

  it('clean is the default: the daemon environment stays out of sessions (ADR-008)', async () => {
    const td = await startTestDaemon();
    daemons.push(td);
    const screen = await envReport(td);
    expect(screen).toContain('canary=undefined');
    expect(screen).toContain('canary2=undefined');
    expect(screen).toContain('path=yes');
    expect(screen).toContain('term=xterm-256color');
  });

  it('passthrough, chosen by name, hands the daemon environment to sessions', async () => {
    const td = await startTestDaemon({ sessionEnv: 'passthrough' });
    daemons.push(td);
    const screen = await envReport(td);
    expect(screen).toContain('canary=leak-me');
    expect(screen).toContain('term=xterm-256color');
  });

  describe('what passthrough exposes, by name only (ADR-008)', () => {
    // The test daemons run in this process, so this is their environment.
    beforeAll(() => {
      process.env['SHELLPUPPET_CANARY_TOKEN'] = 'token-value-9c1d';
    });
    afterAll(() => {
      delete process.env['SHELLPUPPET_CANARY_TOKEN'];
    });

    function capturingLogger(): { logger: Logger; warnings: { message: string; meta?: Record<string, unknown> }[] } {
      const warnings: { message: string; meta?: Record<string, unknown> }[] = [];
      return {
        warnings,
        logger: { ...NULL_LOGGER, warn: (message, meta) => warnings.push({ message, ...(meta !== undefined ? { meta } : {}) }) },
      };
    }

    it('is warned about once at start, naming the variable and never its value', async () => {
      const { logger, warnings } = capturingLogger();
      const td = await startTestDaemon({ sessionEnv: 'passthrough', logger });
      daemons.push(td);
      const passthrough = warnings.filter((w) => w.message.includes('passthrough'));
      expect(passthrough).toHaveLength(1);
      expect(passthrough[0]?.meta?.['names']).toContain('SHELLPUPPET_CANARY_TOKEN');
      expect(JSON.stringify(warnings)).not.toContain('token-value-9c1d');
    });

    it('is reported by GET /environment behind the token; clean and a list report nothing exposed', async () => {
      const leaky = await startTestDaemon({ sessionEnv: 'passthrough' });
      daemons.push(leaky);
      const report = await api(leaky.port, leaky.token, '/environment');
      expect(report.status).toBe(200);
      expect(report.body['mode']).toBe('passthrough');
      expect(report.body['exposed']).toContain('SHELLPUPPET_CANARY_TOKEN');
      expect(JSON.stringify(report.body)).not.toContain('token-value-9c1d');
      expect((await api(leaky.port, null, '/environment')).status).toBe(401);
      // Nor can a viewer link: viewers reach only their page and its socket.
      const started = await api(leaky.port, leaky.token, '/sessions', {
        body: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], shell: false },
      });
      const grant = new URL(String(started.body['viewerUrl'])).searchParams.get('vt');
      expect(grant).toBeTruthy();
      expect((await api(leaky.port, grant, '/environment')).status).toBe(401);

      const { logger, warnings } = capturingLogger();
      const clean = await startTestDaemon({ logger });
      daemons.push(clean);
      expect((await api(clean.port, clean.token, '/environment')).body).toEqual({ mode: 'clean', exposed: [] });
      expect(warnings.filter((w) => w.message.includes('passthrough'))).toHaveLength(0);

      // A name someone listed on purpose is theirs to pass, not an exposure.
      const listed = await startTestDaemon({ sessionEnv: ['SHELLPUPPET_CANARY_TOKEN'] });
      daemons.push(listed);
      expect((await api(listed.port, listed.token, '/environment')).body).toEqual({ mode: 'list', exposed: [] });
    });
  });

  it('clean strips non-essential variables but keeps the session functional', async () => {
    const td = await startTestDaemon({ sessionEnv: 'clean' });
    daemons.push(td);
    const screen = await envReport(td);
    expect(screen).toContain('canary=undefined');
    expect(screen).toContain('canary2=undefined');
    expect(screen).toContain('path=yes'); // PATH survives: sessions must work
    expect(screen).toContain('term=xterm-256color'); // always injected
  });

  it('an explicit allowlist adds named variables on top of the clean baseline', async () => {
    // The baseline matters: a bare list would strip SystemRoot, without which
    // node.exe aborts in CSPRNG init before it can print anything, so
    // allowlist = clean + named.
    const td = await startTestDaemon({ sessionEnv: ['SHELLPUPPET_CANARY'] });
    daemons.push(td);
    const screen = await envReport(td);
    expect(screen).toContain('canary=leak-me');
    expect(screen).toContain('canary2=undefined');
    expect(screen).toContain('path=yes');
  });

  it("a start's own variables go on top of the session environment, audited by name alone", async () => {
    // captureContent is on, the most a log ever records, and the value still
    // stays out: it was handed over, not typed.
    const home = makeTempHome('shellpuppet-passed-env-');
    const td = await startTestDaemon({
      home,
      sessionEnv: 'clean',
      audit: createAuditor(home, { captureContent: true }),
    });
    daemons.push(td);
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: [
          '-e',
          "console.log('REPORT passed=' + process.env.SHELLPUPPET_PASSED + ' canary=' + process.env.SHELLPUPPET_CANARY + ' term=' + process.env.TERM)",
        ],
        shell: false,
        env: { SHELLPUPPET_PASSED: 'passed-value-7f3e', TERM: 'dumb' },
      },
    });
    const id = String((started.body as { id: string }).id);
    const waited = await api(td.port, td.token, `/sessions/${id}/wait?text=REPORT&timeout=20000&debounce=300`);
    const screen = String(waited.body['screen']);
    expect(screen).toContain('passed=passed-value-7f3e');
    // Everything not passed is still filtered, and TERM is still injected.
    expect(screen).toContain('canary=undefined');
    expect(screen).toContain('term=xterm-256color');

    const start = readAudit(home).find((line) => line.action === 'start' && line.session === id);
    expect(start?.meta?.['envNames']).toEqual(['SHELLPUPPET_PASSED', 'TERM']);
    expect(fs.readFileSync(auditLogPath(home), 'utf8')).not.toContain('passed-value-7f3e');
  });
});

describe('audit log: viewer link and picture events', () => {
  it('records no grant-mint for a start whose window opened, since no link was handed over', async () => {
    // The window holds the start's one grant and nobody was given a link, so
    // the log shows the window's own `grant-redeem` when its page loads and
    // nothing before it. A mint recorded here would describe a link that
    // never existed.
    const home = makeTempHome('shellpuppet-audit-');
    const td = await startTestDaemon({
      home,
      audit: createAuditor(home, { captureContent: false }),
      launcher: () => Promise.resolve({ launched: true, mode: 'isolated-app' as const }),
    });
    daemons.push(td);
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
      },
    });
    expect(started.status).toBe(200);
    const id = String(started.body['id']);
    expect(started.body['viewerUrl']).toBeUndefined();
    const lines = readAudit(td.home);
    expect(lines.some((l) => l.action === 'start' && l.session === id)).toBe(true);
    expect(lines.filter((l) => l.action === 'grant-mint' && l.session === id)).toHaveLength(0);
  });

  it('records minting, redemption and photographing under their own names', async () => {
    const home = makeTempHome('shellpuppet-audit-viewer-');
    const td = await startTestDaemon({
      home,
      audit: createAuditor(home, { captureContent: false }),
      viewer: { browserPath: process.execPath },
      capture: () => Promise.resolve({ png: Buffer.from('x'), width: 1, height: 1, rows: [] }),
    });
    daemons.push(td);
    const { id } = await startSpin(td);

    // This daemon opens no window (no launch mode is set), so the link the
    // start hands back is the human's way in: a viewer link like any other,
    // audited like any other, under the actor that asked for the session.
    // Exactly one line.
    const atStart = readAudit(td.home).filter(
      (l) => l.action === 'grant-mint' && l.session === id,
    );
    expect(atStart).toHaveLength(1);
    expect(atStart[0]?.actor).toBe('client');
    expect(atStart[0]?.meta?.['readOnly']).toBe(false);

    const minted = await api(td.port, td.token, `/sessions/${id}/viewer`, {
      body: { readOnly: true },
    });
    const page = await fetch(String(minted.body['viewerUrl']));
    await page.text();
    await api(td.port, td.token, `/sessions/${id}/screenshot`, { body: {} });

    const lines = readAudit(td.home);
    // ...and one more once a link was asked for by hand.
    const mints = lines.filter((l) => l.action === 'grant-mint' && l.session === id);
    expect(mints).toHaveLength(2);
    const mint = mints[1];
    expect(mint?.session).toBe(id);
    expect(mint?.meta?.['readOnly']).toBe(true);
    const redeem = lines.find((l) => l.action === 'grant-redeem');
    expect(redeem?.actor).toBe('viewer');
    expect(redeem?.session).toBe(id);
    expect(redeem?.meta?.['readOnly']).toBe(true);
    expect(lines.some((l) => l.action === 'screenshot' && l.session === id)).toBe(true);
  });
});

/**
 * The daemon-wide event stream and prompt-stall alerting: a session
 * stuck on a permission prompt must announce itself on `/events` instead of
 * waiting for someone to snapshot it. Auth: client token only, because viewer
 * tokens are session-scoped and must not see other sessions' prompts.
 */

import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, eventually, redeemViewerUrl, startTestDaemon } from './helpers.js';
import type { TestDaemon } from './helpers.js';
import type { FeedFrame } from '../../src/daemon/sessionFeed.js';

let td: TestDaemon;

beforeAll(async () => {
  td = await startTestDaemon({
    policy: { mode: 'allow-all' },
    // Fast cadence so a stall alert lands within test patience.
    promptScanIntervalMs: 100,
    promptStallMs: 300,
  });
});
afterAll(async () => {
  await td.stop();
});

interface EventClient {
  events: Record<string, unknown>[];
  close: () => void;
}

function connectEvents(port: number, token: string): Promise<EventClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/events?token=${token}`);
    const events: Record<string, unknown>[] = [];
    ws.on('message', (data: Buffer | string) => {
      events.push(JSON.parse(String(data)) as Record<string, unknown>);
    });
    ws.on('open', () => {
      resolve({ events, close: () => ws.close() });
    });
    ws.on('error', reject);
  });
}

/** Upgrade status for the /events route (wsUpgradeStatus is session-scoped). */
function eventsUpgradeStatus(port: number, query: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/events${query}`);
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode ?? 0);
    });
    ws.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * A session that draws a Qoder-shaped permission prompt, holds it and then
 * (after `clearAfterMs`) draws a busy line below it: the prompt-clear path.
 */
async function startPromptingSession(clearAfterMs: number): Promise<string> {
  const script = [
    `console.log(' Permission Required');`,
    `console.log(' Allow this command to run?');`,
    `console.log('  \\u276F 1. Allow once');`,
    `console.log('    2. No');`,
    clearAfterMs > 0
      ? `setTimeout(() => { console.log(' Generating... (esc to cancel)'); }, ${String(clearAfterMs)});`
      : '',
    `setInterval(() => {}, 200);`,
  ].join(' ');
  const started = await api(td.port, td.token, '/sessions', {
    body: {
      command: process.execPath,
      args: ['-e', script],
      shell: false,
      label: 'prompting-fixture',
    },
  });
  expect(started.status).toBe(200);
  return (started.body as unknown as { id: string }).id;
}

describe('/events auth', () => {
  it('rejects a missing or wrong token, and a session-scoped viewer grant', async () => {
    expect(await eventsUpgradeStatus(td.port, '')).toBe(401);
    expect(await eventsUpgradeStatus(td.port, '?token=not-the-token')).toBe(401);

    // Mint a real viewer grant by starting a session and reading its URL.
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
        label: 'viewer-grant-donor',
      },
    });
    const viewerUrl = (started.body as unknown as { viewerUrl: string }).viewerUrl;
    const viewerToken = new URL(viewerUrl).searchParams.get('vt') ?? '';
    expect(viewerToken).not.toBe('');
    expect(await eventsUpgradeStatus(td.port, `?token=${viewerToken}`)).toBe(401);
  });

  it('greets a client-token subscriber with a hello frame', async () => {
    const client = await connectEvents(td.port, td.token);
    await eventually(() => client.events.some((e) => e.type === 'hello'));
    client.close();
  });
});

describe('prompt-stall alerting', () => {
  it('alerts once for a held prompt, then clears when the screen moves on', async () => {
    const client = await connectEvents(td.port, td.token);
    const id = await startPromptingSession(3_000);

    // The stall alert names the session and carries the prompt content.
    await eventually(
      () => client.events.some((e) => e.type === 'prompt-stall' && e.session === id),
      10_000,
    );
    const stall = client.events.find(
      (e) => e.type === 'prompt-stall' && e.session === id,
    )!;
    expect(String(stall.question)).toMatch(/allow this command/i);
    expect(stall.options).toEqual(['1. Allow once', '2. No']);
    expect(Number(stall.waitingMs)).toBeGreaterThanOrEqual(300);
    expect(stall.label).toBe('prompting-fixture');

    // The busy line below the options clears the prompt state.
    await eventually(
      () => client.events.some((e) => e.type === 'prompt-clear' && e.session === id),
      10_000,
    );

    // One alert per held prompt: the scanner must not re-alert every beat.
    const stalls = client.events.filter(
      (e) => e.type === 'prompt-stall' && e.session === id,
    );
    expect(stalls).toHaveLength(1);

    client.close();
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });

  it('keeps scanning later sessions when an earlier snapshot faults', async () => {
    const client = await connectEvents(td.port, td.token);

    // A session created FIRST (so the scanner visits it first) whose every
    // snapshot rejects, the shape of a mid-reap race or renderer fault.
    // Without the per-session guard, this would abort the whole tick and the
    // prompting session below could never alert.
    const faulty = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
        label: 'faulty-fixture',
      },
    });
    expect(faulty.status).toBe(200);
    const faultyId = (faulty.body as unknown as { id: string }).id;
    const manager = (
      td.daemon as unknown as {
        manager: { get(id: string): { snapshot(): Promise<unknown> } | undefined };
      }
    ).manager;
    const faultySession = manager.get(faultyId);
    expect(faultySession).toBeDefined();
    faultySession!.snapshot = () => Promise.reject(new Error('render fault (test)'));

    // Held prompt in a LATER session must still alert.
    const id = await startPromptingSession(0);
    await eventually(
      () => client.events.some((e) => e.type === 'prompt-stall' && e.session === id),
      10_000,
    );

    client.close();
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
    await api(td.port, td.token, `/sessions/${faultyId}`, { method: 'DELETE' });
    // Twice the project default: this test starts two real sessions and waits
    // for a scanner beat, and on a heavily loaded machine that can take longer
    // than 60 s.
  }, 120_000);

  it('never alerts for a prompt answered before the stall threshold', async () => {
    const client = await connectEvents(td.port, td.token);
    // Clears after 150 ms, under the 300 ms stall threshold.
    const id = await startPromptingSession(150);

    // Give the scanner ample beats to have alerted if it were going to.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(
      client.events.some((e) => e.type === 'prompt-stall' && e.session === id),
    ).toBe(false);

    client.close();
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });
});

/**
 * Delivering the alert to someone who can act on it. `daemon.log` and the
 * `/events` socket are not enough on their own: an agent reaches the daemon
 * through request-and-answer tool calls or one-shot CLI runs, so it cannot
 * hold that socket open. These pin the three paths that actually reach a
 * decision-maker.
 */
describe('prompt state reaches its consumers', () => {
  it('reports a styled selection separately from unchanged option labels on every prompt surface', async () => {
    const client = await connectEvents(td.port, td.token);
    const frames: FeedFrame[] = [];
    const unsubscribe = td.daemon.subscribeDashboardFeed((frame) => frames.push(frame));
    let id = '';
    try {
      const script = [
        "process.stdout.write('Choose a build?\\r\\n  1. Debug\\r\\n\\x1b[7m  2. Release\\x1b[0m\\r\\n');",
        'setInterval(() => {}, 200);',
      ].join(' ');
      const started = await api(td.port, td.token, '/sessions', {
        body: { command: process.execPath, args: ['-e', script], shell: false, label: 'styled-menu' },
      });
      expect(started.status).toBe(200);
      id = String(started.body['id']);

      await eventually(async () => {
        const listed = await api(td.port, td.token, '/sessions');
        const sessions = listed.body['sessions'] as { id: string; waitingOnPrompt?: { selectedOption?: number } }[];
        return sessions.find((session) => session.id === id)?.waitingOnPrompt?.selectedOption === 1;
      }, 10_000);
      const listed = await api(td.port, td.token, '/sessions');
      const sessions = listed.body['sessions'] as { id: string; waitingOnPrompt?: { options: string[]; selectedOption?: number } }[];
      expect(sessions.find((session) => session.id === id)?.waitingOnPrompt).toMatchObject({
        options: ['1. Debug', '2. Release'], selectedOption: 1,
      });
      const hidden = await api(td.port, td.token, '/sessions?hideReasoning=1');
      const hiddenSessions = hidden.body['sessions'] as { id: string; waitingOnPrompt?: Record<string, unknown> }[];
      expect(hiddenSessions.find((session) => session.id === id)?.waitingOnPrompt).not.toHaveProperty('selectedOption');

      const snapshot = await api(td.port, td.token, `/sessions/${id}/snapshot`);
      expect(String(snapshot.body['screen'])).toContain('⟦SP:selected⟧   2. Release');
      const waited = await api(td.port, td.token, `/sessions/${id}/wait?prompt=true&timeout=10000`);
      expect(waited.body['prompt']).toMatchObject({
        options: ['1. Debug', '2. Release'], selectedOption: 1,
      });
      expect(String(waited.body['screen'])).toContain('⟦SP:selected⟧   2. Release');

      await eventually(() => client.events.some((event) => event.type === 'prompt-stall' && event.session === id), 10_000);
      const stall = client.events.find((event) => event.type === 'prompt-stall' && event.session === id);
      expect(stall).toMatchObject({ options: ['1. Debug', '2. Release'], selectedOption: 1 });
      const feed = frames.find((frame) =>
        frame.type === 'session-updated' && frame.session.id === id &&
        frame.session.waitingOnPrompt?.selectedOption === 1);
      expect(feed?.type).toBe('session-updated');
      if (feed?.type === 'session-updated') {
        expect(feed.session.waitingOnPrompt?.options).toEqual(['1. Debug', '2. Release']);
      }
    } finally {
      unsubscribe();
      client.close();
      if (id !== '') await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
    }
  });

  it('flags the held prompt on the session list, with how long it has waited', async () => {
    const client = await connectEvents(td.port, td.token);
    const id = await startPromptingSession(0);
    await eventually(
      () => client.events.some((e) => e.type === 'prompt-stall' && e.session === id),
      10_000,
    );

    const listed = await api(td.port, td.token, '/sessions');
    const sessions = (listed.body as unknown as {
      sessions: {
        id: string;
        waitingOnPrompt?: {
          question: string;
          options: string[];
          waitingMs: number;
          alerted: boolean;
        };
      }[];
    }).sessions;
    const mine = sessions.find((s) => s.id === id);
    expect(mine?.waitingOnPrompt).toBeDefined();
    expect(String(mine!.waitingOnPrompt!.question)).toMatch(/allow this command/i);
    expect(mine!.waitingOnPrompt!.options).toEqual(['1. Allow once', '2. No']);
    expect(mine!.waitingOnPrompt!.waitingMs).toBeGreaterThanOrEqual(300);
    expect(mine!.waitingOnPrompt!.alerted).toBe(true);

    client.close();
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });

  it('replays the held prompt to a viewer that connects after the alert', async () => {
    // The person opening the viewer BECAUSE they were told a session is stuck
    // arrives after the single announcement, and is exactly the person the
    // badge is for. Without replay they see a normal-looking terminal.
    const client = await connectEvents(td.port, td.token);
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: [
          '-e',
          `console.log(' Permission Required'); console.log(' Allow this command to run?'); ` +
            `console.log('  \u276F 1. Allow once'); console.log('    2. No'); ` +
            `setInterval(() => {}, 200);`,
        ],
        shell: false,
        label: 'late-viewer-fixture',
      },
    });
    const { id, viewerUrl } = started.body as unknown as { id: string; viewerUrl: string };
    await eventually(
      () => client.events.some((e) => e.type === 'prompt-stall' && e.session === id),
      10_000,
    );

    const cookie = await redeemViewerUrl(viewerUrl);
    const frames: Record<string, unknown>[] = [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(td.port)}/sessions/${id}/stream`,
      { headers: { cookie } },
    );
    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) return;
      try {
        frames.push(JSON.parse(String(data)) as Record<string, unknown>);
      } catch {
        // Terminal bytes arriving as text, not a control frame.
      }
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    await eventually(() => frames.some((f) => f.type === 'prompt-stall'), 5_000);
    const replayed = frames.find((f) => f.type === 'prompt-stall')!;
    expect(String(replayed.question)).toMatch(/allow this command/i);

    ws.close();
    client.close();
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });

  it('wait prompt:true returns as soon as the delegate needs an answer', async () => {
    // The supervision wait: no polling, no guessing at sleeps.
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: [
          '-e',
          `setTimeout(() => { console.log(' Permission Required'); ` +
            `console.log(' Allow this command to run?'); ` +
            `console.log('  \u276F 1. Allow once'); console.log('    2. No'); }, 400); ` +
            `setInterval(() => {}, 200);`,
        ],
        shell: false,
        label: 'wait-prompt-fixture',
      },
    });
    const id = (started.body as unknown as { id: string }).id;

    const waited = await api(td.port, td.token, `/sessions/${id}/wait?prompt=true&timeout=10000`);
    expect(waited.status).toBe(200);
    const result = waited.body as unknown as {
      matched: boolean;
      reason: string;
      prompt?: { question: string; options: string[] };
    };
    expect(result.matched).toBe(true);
    expect(result.reason).toBe('prompt');
    expect(String(result.prompt?.question)).toMatch(/allow this command/i);
    expect(result.prompt?.options).toEqual(['1. Allow once', '2. No']);

    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });
});

/**
 * Session identity in the viewer: with several viewer windows open at once, a
 * window that does not say what it is for can only be identified by reading
 * its terminal and inferring.
 */
describe('viewer session identity', () => {
  it('sends purpose, starter and command to a connecting viewer', async () => {
    const started = await api(td.port, td.token, '/sessions', {
      headers: { 'x-shellpuppet-actor': 'mcp:claude-code' },
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
        label: 'grok-build',
        purpose: 'Check the release notes',
        // A caller must not be able to name its own starter: attribution the
        // caller controls is a suggestion, not a fact.
        startedBy: 'mcp:someone-else',
      },
    });
    expect(started.status).toBe(200);
    const { id, viewerUrl } = started.body as unknown as { id: string; viewerUrl: string };
    const cookie = await redeemViewerUrl(viewerUrl);

    const frames: Record<string, unknown>[] = [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(td.port)}/sessions/${id}/stream`,
      { headers: { cookie } },
    );
    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) return;
      try {
        frames.push(JSON.parse(String(data)) as Record<string, unknown>);
      } catch {
        // Terminal bytes as text, not a control frame.
      }
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Wait for BOTH frames before reading either. The daemon sends them back
    // to back, but the client can receive them in separate reads, and the
    // ordering check below compares two indexes that both have to exist.
    await eventually(
      () =>
        frames.some((f) => f.type === 'identity') && frames.some((f) => f.type === 'geometry'),
      5_000,
    );
    const identity = frames.find((f) => f.type === 'identity')!;
    expect(identity.session).toBe(id);
    expect(identity.label).toBe('grok-build');
    expect(identity.purpose).toBe('Check the release notes');
    expect(identity.startedBy).toBe('mcp:claude-code');
    expect(String(identity.command)).toContain('-e');

    // Identity must precede geometry: the window has to be identifiable from
    // its first paint, and geometry triggers the viewer's first real layout.
    const identityIndex = frames.findIndex((f) => f.type === 'identity');
    const geometryIndex = frames.findIndex((f) => f.type === 'geometry');
    expect(identityIndex).toBeLessThan(geometryIndex);

    ws.close();
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });

  it('reports purpose and starter on the session list', async () => {
    const started = await api(td.port, td.token, '/sessions', {
      headers: { 'x-shellpuppet-actor': 'cli' },
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
        purpose: 'Watch a long test run',
      },
    });
    const id = (started.body as unknown as { id: string }).id;
    const listed = await api(td.port, td.token, '/sessions');
    const mine = (listed.body as unknown as {
      sessions: { id: string; purpose: string; startedBy: string }[];
    }).sessions.find((s) => s.id === id);
    expect(mine?.purpose).toBe('Watch a long test run');
    expect(mine?.startedBy).toBe('cli');

    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });
});

describe('prompt-stall miss tolerance', () => {
  it('a single missed scan beat does not reset the stall clock', async () => {
    // Detection reads a snapshot rendered concurrently with PTY output, so a
    // beat can land mid-repaint and see a half-drawn screen. Clearing on the
    // first miss would let that transient restart the 20 s clock, and a prompt
    // whose redraw kept coinciding with scan beats could postpone its alert
    // indefinitely, silently failing the one case the alert exists for.
    const client = await connectEvents(td.port, td.token);
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 200)'],
        shell: false,
        label: 'flicker-fixture',
      },
    });
    const id = (started.body as unknown as { id: string }).id;

    const manager = (
      td.daemon as unknown as {
        manager: { get(id: string): { snapshot(): Promise<{ screen: string }> } | undefined };
      }
    ).manager;
    const session = manager.get(id)!;

    const PROMPT = [
      ' Permission Required',
      ' Allow this command to run?',
      '  ❯ 1. Allow once',
      '    2. No',
    ].join('\n');

    // Every third beat sees a blank screen: a transient that must be ridden
    // out, never believed. Clearing on the first miss would reset the clock
    // every third beat, and the alert would never arrive.
    let calls = 0;
    session.snapshot = () => {
      calls += 1;
      return Promise.resolve({ screen: calls % 3 === 0 ? '' : PROMPT });
    };

    await eventually(
      () => client.events.some((e) => e.type === 'prompt-stall' && e.session === id),
      10_000,
    );
    // …and the flicker must not have produced spurious clears in the meantime.
    expect(
      client.events.filter((e) => e.type === 'prompt-clear' && e.session === id),
    ).toHaveLength(0);

    client.close();
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });
});

/** The signal coming DOWN again, on both channels: viewers and `/events`. */
describe('prompt-clear reaches BOTH channels', () => {
  it('tells viewers the badge can come down when the prompt clears', async () => {
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: [
          '-e',
          `console.log(' Permission Required'); console.log(' Allow this command to run?'); ` +
            `console.log('  \u276F 1. Allow once'); console.log('    2. No'); ` +
            `setTimeout(() => { console.log(' Generating... (esc to cancel)'); }, 1200); ` +
            `setInterval(() => {}, 200);`,
        ],
        shell: false,
        label: 'badge-down-fixture',
      },
    });
    const { id, viewerUrl } = started.body as unknown as { id: string; viewerUrl: string };
    const cookie = await redeemViewerUrl(viewerUrl);

    const frames: Record<string, unknown>[] = [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(td.port)}/sessions/${id}/stream`,
      { headers: { cookie } },
    );
    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) return;
      try {
        frames.push(JSON.parse(String(data)) as Record<string, unknown>);
      } catch {
        // Terminal bytes as text.
      }
    });
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // Up…
    await eventually(() => frames.some((f) => f.type === 'prompt-stall'), 10_000);
    const stall = frames.find((f) => f.type === 'prompt-stall')!;
    // …carrying the options, not just the question: the badge lists the
    // choices.
    expect(stall.options).toEqual(['1. Allow once', '2. No']);

    // …and down again.
    await eventually(() => frames.some((f) => f.type === 'prompt-clear'), 10_000);

    ws.close();
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });

  it('emits prompt-clear on /events when one prompt REPLACES another', async () => {
    // The replace path retracts to /events as well as to viewers: a
    // subscriber that saw stall(Q1) then stall(Q2) with no clear between
    // could not tell them from two concurrent holds.
    const client = await connectEvents(td.port, td.token);
    const started = await api(td.port, td.token, '/sessions', {
      body: {
        command: process.execPath,
        args: [
          '-e',
          // First chooser, then a DIFFERENT one, with no busy line between
          // them, so the state changes by signature rather than clearing.
          `console.log(' Permission Required'); console.log(' Allow this command to run?'); ` +
            `console.log('  \u276F 1. Allow once'); console.log('    2. No'); ` +
            `setTimeout(() => { console.clear(); console.log(' Permission Required'); ` +
            `console.log(' Allow writing this file?'); ` +
            `console.log('  \u276F 1. Write it'); console.log('    2. Never'); }, 2500); ` +
            `setInterval(() => {}, 200);`,
        ],
        shell: false,
        label: 'replace-fixture',
      },
    });
    const id = (started.body as unknown as { id: string }).id;

    await eventually(
      () =>
        client.events.filter((e) => e.type === 'prompt-stall' && e.session === id).length >= 2,
      20_000,
    );
    const forSession = client.events.filter(
      (e) => e.session === id && (e.type === 'prompt-stall' || e.type === 'prompt-clear'),
    );
    const firstStall = forSession.findIndex((e) => e.type === 'prompt-stall');
    const secondStall = forSession.findIndex(
      (e, i) => i > firstStall && e.type === 'prompt-stall',
    );
    const clearBetween = forSession
      .slice(firstStall + 1, secondStall)
      .some((e) => e.type === 'prompt-clear');
    expect(clearBetween).toBe(true);

    client.close();
    await api(td.port, td.token, `/sessions/${id}`, { method: 'DELETE' });
  });
});

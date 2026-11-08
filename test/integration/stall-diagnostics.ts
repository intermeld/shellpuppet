import { createHash } from 'node:crypto';
import type { Session } from '../../src/core/session.js';
import type { ScreenRenderer } from '../../src/core/renderer.js';
import { signatureFor, validateStall } from '../../src/core/reasoning.js';

/** Test-only tracing: retain comparisons and lengths, never screen text. */
export function stallDiagnostics(session: Session) {
  const internal = session as unknown as { renderer: ScreenRenderer; refreshStall(): void };
  const signature = signatureFor('mimo', 'mimo')!;
  const start = performance.now();
  const time = () => ({ at: new Date().toISOString(), elapsedMs: performance.now() - start });
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const samples: unknown[] = [];
  const transitions: unknown[] = [];
  const resizes: unknown[] = [];
  let previous: { refusal: string; footer: string; userTurnTextLength: number | null; composer: string } | undefined;
  const sample = (source: string) => {
    const full = internal.renderer.styledLines({ above: 128 });
    const bounded = internal.renderer.styledLines({ above: 128, extendWrapped: false });
    const candidate = validateStall(full.lines, signature, false, full.firstVisible);
    const limited = validateStall(bounded.lines, signature, false, bounded.firstVisible);
    // Read these independently: a missing composer must not be reported as
    // a changed refusal/footer just because complete validation failed.
    const before = full.lines.findIndex(line => line.text.includes('The request was rejected'));
    const footer = full.lines.findIndex(line => line.text.includes('▣  Build'));
    const semantic = (text: string) => text.replace(/\s+(?:[⎘█].*|↻ \/recover.*)$/u, '').trim();
    const block = before < 0 || footer < before ? null : full.lines.slice(before, footer).map(line => semantic(line.text));
    const user = candidate === null || 'inconclusive' in candidate ? null :
      (JSON.parse(candidate.identity) as [string, string, string[]])[1].length;
    let edge = -1;
    for (let row = full.lines.length - 1; row >= 0; row--) {
      if (/^ {2}╹▀/u.test(full.lines[row]!.text)) { edge = row; break; }
    }
    const current = { refusal: hash(block), footer: hash(footer < 0 ? null : semantic(full.lines[footer]!.text)),
      userTurnTextLength: user, composer: hash(edge < 0 ? null : full.lines.slice(Math.max(0, edge - 3), edge + 2)) };
    samples.push({ ...time(), source, bounded: limited === null ? 'absent' : 'inconclusive' in limited ? 'inconclusive' : 'complete',
      refusalBlockChanged: previous !== undefined && previous.refusal !== current.refusal,
      footerChanged: previous !== undefined && previous.footer !== current.footer,
      userTurnTextLength: { before: previous?.userTurnTextLength ?? null, after: current.userTurnTextLength },
      composerChanged: previous !== undefined && previous.composer !== current.composer });
    previous = current;
  };
  const refresh = internal.refreshStall.bind(internal);
  internal.refreshStall = () => { sample('validation'); refresh(); };
  const offData = session.onData(() => { void session.viewportLines().then(() => sample('output')); });
  const offStall = session.onStall(state => transitions.push({ ...time(), state: state ?? null }));
  sample('start');
  return {
    resize(cols: number, rows: number, phase: string) { resizes.push({ ...time(), cols, rows, phase }); sample(`resize ${phase}`); },
    print() { console.error('Native stall lifecycle diagnostics (no screen text):', JSON.stringify({ samples, transitions, resizes })); },
    stop() { offData(); offStall(); internal.refreshStall = refresh; },
  };
}

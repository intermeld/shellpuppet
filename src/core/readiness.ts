import type { AgentModule } from '../agents/types.js';
import { DEFAULT_START_READY_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, WAIT_POLL_INTERVAL_MS } from './types.js';
import type { SessionOptions, StartReadyResult } from './types.js';
import type { WaitTarget } from './waiter.js';
import { WaitConditionError } from './waiter.js';

export type Readiness = NonNullable<AgentModule['readiness']>;

/** Module defaults are used only when a caller explicitly asks to wait. */
export function readinessFor(options: SessionOptions, module?: AgentModule): Readiness | undefined {
  if (options.readyTimeout !== undefined && (!Number.isFinite(options.readyTimeout) || options.readyTimeout < 0)) {
    throw new WaitConditionError('readyTimeout must be a non-negative number of milliseconds.');
  }
  const readiness = options.readyText !== undefined ? { readyText: [options.readyText] }
    : options.readyQuiet !== undefined ? { readyQuietMs: options.readyQuiet }
    : options.waitReady === true ? module?.readiness : undefined;
  if (options.waitReady === true && readiness === undefined) {
    throw new WaitConditionError('No ready signal is known for this program. Pass readyText or readyQuiet with waitReady.');
  }
  return readiness;
}

export function readinessMatches(readiness: Readiness, screen: string, target: Pick<WaitTarget, 'hasPainted' | 'lastChangeAt'>, now: number): boolean {
  if (readiness.readyText !== undefined) {
    return readiness.readyText.some(text => screen.toLowerCase().includes(text.toLowerCase()));
  }
  if (readiness.readyScreen !== undefined) return readiness.readyScreen(screen);
  return readiness.readyQuietMs !== undefined && target.hasPainted() && now - target.lastChangeAt() >= readiness.readyQuietMs;
}

/** Track for five minutes independently of the shorter start call. */
export function trackReadiness(target: WaitTarget, readiness: Readiness, checkPrompts: boolean, deadline = Date.now() + MAX_WAIT_TIMEOUT_MS): Promise<boolean> {
  let heldSince: number | undefined;
  return new Promise(resolve => {
    const tick = (): void => {
      const now = Date.now();
      if (target.isExited() || now >= deadline) { resolve(false); return; }
      const screen = target.getScreen();
      const blocked = checkPrompts && target.answerablePrompt?.(screen, now) != null;
      if (!blocked && readinessMatches(readiness, screen, target, now)) {
        heldSince ??= now;
        if (now - heldSince >= (readiness.settleMs ?? 0)) { resolve(true); return; }
      } else heldSince = undefined;
      setTimeout(tick, WAIT_POLL_INTERVAL_MS);
    };
    tick();
  });
}

/** A question or an exit takes precedence over a ready flag on the same screen. */
export function waitUntilReady(target: WaitTarget & { readonly ready: boolean; deferReadiness?(): void }, timeout = DEFAULT_START_READY_TIMEOUT_MS, signal?: AbortSignal): Promise<StartReadyResult> {
  const began = Date.now();
  const limit = Math.min(timeout, MAX_WAIT_TIMEOUT_MS);
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (reason: StartReadyResult['reason'], prompt?: StartReadyResult['prompt']): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ reason, waitedMs: Date.now() - began, ...(prompt === undefined ? {} : { prompt }) });
    };
    const abort = (): void => finish('aborted');
    const tick = (): void => {
      if (target.isExited()) { finish('exited'); return; }
      const prompt = target.answerablePrompt?.(target.getScreen());
      target.observePrompt(prompt?.signature ?? null);
      if (prompt != null) {
        target.deferReadiness?.();
        if (!target.isStalePrompt(prompt.signature)) {
          finish('prompt', { question: prompt.question, options: prompt.options, signature: prompt.signature,
            ...(prompt.selectedOption === undefined ? {} : { selectedOption: prompt.selectedOption }) });
          return;
        }
      }
      if (prompt == null && target.ready) { finish('condition-met'); return; }
      if (Date.now() - began >= limit) { finish('timeout'); return; }
      timer = setTimeout(tick, WAIT_POLL_INTERVAL_MS);
    };
    if (signal?.aborted === true) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    tick();
  });
}

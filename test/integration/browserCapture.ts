import { freemem } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { captureViewer as capture, type CaptureOptions } from '../../src/daemon/screenshot.js';
import { monitorCapture } from './captureMonitor.js';

function transportFailure(message: string): string | undefined {
  if (message.includes('browser did not expose DevTools')) return 'no DevTools endpoint';
  if (message.includes('DevTools did not accept the connection')) return 'DevTools handshake expired';
  if (message.includes('DevTools connection closed during')) return 'DevTools connection closed';
  if (message.includes('DevTools did not answer Runtime.evaluate in time')) {
    return message.includes('page did not answer') ? 'page evaluation unanswered' : undefined;
  }
  if (message.includes('DevTools did not answer Page.enable in time')) return 'Page.enable unanswered';
  if (/DevTools did not answer [\w.]+ in time/.test(message)) return 'DevTools command unanswered';
}

export function checkCaptureTransport(error: unknown): void {
  const reason = transportFailure(String(error));
  if (reason) throw new Error(`runner stalled: ${reason}`);
}

export type TestCaptureOptions = CaptureOptions & {
  /** Only counts, flags and known fixture values belong in a failure report. */
  failureFacts?: () => object;
};

// The capture API formats its timings beside arbitrary page text and exceptions.
// Copy only recognised state fields across the test failure boundary.
function captureFacts(message: string) {
  const marker = '; dashboard diagnostics: ';
  const offset = message.indexOf(marker);
  const header = offset >= 0 ? message.slice(0, offset) : message;
  const start = header.lastIndexOf('; capture stage=');
  const metadata = start >= 0 ? header.slice(start) : '';
  const stage = /capture stage=(browser start|DevTools connection|page setup|readiness probe|interaction|read viewport rows|Page\.captureScreenshot),/.exec(metadata)?.[1];
  const timings: Record<string, number | null> = {};
  for (const match of metadata.matchAll(/\b(elapsedMs|remainingMs|browserReadyMs|navigationMs|setupMs|readyMs|browserExitCode|devToolsState)"?[:=](\d+|null)\b/g)) {
    timings[match[1]!] = match[2] === 'null' ? null : Number(match[2]);
  }
  const browserSignal = /browserSignal=(null|SIGTERM|SIGKILL|SIGSEGV|SIGABRT|SIGINT|SIGILL|SIGBUS),/.exec(metadata)?.[1];
  const page: Record<string, unknown> = {};
  if (offset >= 0) {
    const reply = message.slice(offset + marker.length);
    page['answered'] = reply !== 'page did not answer';
    try {
      const data = JSON.parse(reply) as Record<string, unknown> | null;
      if (data && typeof data === 'object') {
        for (const key of ['loaded', 'paneCount', 'streamCount', 'arrangements', 'pendingFrames', 'longTasks', 'longestTaskMs',
          'scriptErrors', 'resourceErrors', 'unhandledRejections', 'pageMs', 'panes']) {
          if (typeof data[key] === 'boolean' || Number.isFinite(data[key])) page[key] = data[key];
        }
        if (Array.isArray(data['openPaneStreams'])) page['openPaneStreams'] = data['openPaneStreams'].length;
        for (const key of ['mode', 'visibility', 'documentVisibility', 'readyState', 'fonts', 'paneScript', 'terminalScript']) {
          const value = data[key];
          if (typeof value === 'string' && ['viewer', 'dashboard', 'visible', 'hidden', 'loading', 'loaded', 'interactive', 'complete', 'object', 'function',
            'undefined']
            .includes(value)) page[key] = value;
        }
      }
    } catch { /* A failed probe may have no structured reply. */ }
  }
  return { stage, ...timings, browserSignal, page };
}

/** Keep browser transport failures separate from assertions made by a responding page. */
export async function captureViewer({ failureFacts, ...options }: TestCaptureOptions): ReturnType<typeof capture> {
  const runnerTemp = process.env['RUNNER_TEMP'];
  const profileRoot = !options.profileRoot && runnerTemp && process.env['SP_CI_CAPTURE_PASS'] === 'isolated'
    ? join(runnerTemp, 'isolated-captures') : undefined;
  const monitor = profileRoot ? monitorCapture(profileRoot) : undefined;
  const lag = monitorEventLoopDelay({ resolution: 100 });
  const freeBeforeMiB = Math.round(freemem() / 2 ** 20);
  lag.enable();
  try {
    return await capture({ ...options, ...(profileRoot ? { profileRoot } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason = transportFailure(message);
    const details = { ...captureFacts(message), test: failureFacts?.(),
      freeBeforeMiB, freeAfterMiB: Math.round(freemem() / 2 ** 20), browser: monitor?.details(),
      maxWorkerDelayMs: lag.count ? Math.round(lag.max / 1e6) : null };
    // eslint-disable-next-line preserve-caught-error -- Vitest prints the cause, including private URLs and paths.
    throw new Error(`${reason ? 'runner stalled: ' + reason : 'Browser capture failed'}; ${JSON.stringify(details)}`);
  } finally {
    lag.disable();
    await monitor?.stop();
  }
}

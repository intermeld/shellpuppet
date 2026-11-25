import { freemem } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { captureViewer as capture, type CaptureOptions } from '../../src/daemon/screenshot.js';
import { monitorCapture } from './captureMonitor.js';

export function checkCaptureTransport(error: unknown): void {
  const message = String(error);
  // A CDP command timeout is distinct from a responsive page returning a
  // failed assertion or never displaying the required content.
  if (/browser did not expose DevTools|DevTools did not accept the connection|DevTools connection closed during|DevTools did not answer (?!Runtime.evaluate)[\w.]+ in time/.test(message) ||
      (message.includes('DevTools did not answer Runtime.evaluate in time') &&
        message.includes('page did not answer'))) {
    throw new Error(`runner stalled: ${message}`, { cause: error });
  }
}

/** Keep browser transport failures separate from assertions made by a responding page. */
export async function captureViewer(options: CaptureOptions): ReturnType<typeof capture> {
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
    const details = { freeBeforeMiB, freeAfterMiB: Math.round(freemem() / 2 ** 20), browser: monitor?.details(),
      maxWorkerDelayMs: lag.count ? Math.round(lag.max / 1e6) : null };
    const failure = new Error(`${String(error)}; capture worker: ${JSON.stringify(details)}`, { cause: error });
    checkCaptureTransport(failure);
    throw failure;
  } finally {
    lag.disable();
    await monitor?.stop();
  }
}

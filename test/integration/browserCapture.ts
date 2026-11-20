import { captureViewer as capture, type CaptureOptions } from '../../src/daemon/screenshot.js';

export function checkCaptureTransport(error: unknown): void {
  const message = String(error);
  // A CDP command timeout is distinct from a responsive page returning a
  // failed assertion or never displaying the required content.
  if (/browser did not expose DevTools|DevTools did not accept the connection|DevTools connection closed during|DevTools did not answer (?!Runtime.evaluate)[\w.]+ in time/.test(message) ||
      (message.includes('DevTools did not answer Runtime.evaluate in time') &&
        /capture stage=readiness probe|page did not answer/.test(message))) {
    throw new Error(`runner stalled: ${message}`, { cause: error });
  }
}

/** Keep browser transport failures separate from assertions made by a responding page. */
export async function captureViewer(options: CaptureOptions): ReturnType<typeof capture> {
  try {
    return await capture(options);
  } catch (error) {
    checkCaptureTransport(error);
    throw error;
  }
}

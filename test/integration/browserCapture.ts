import { captureViewer as capture, type CaptureOptions } from '../../src/daemon/screenshot.js';

/** Keep browser transport failures separate from assertions made by a responding page. */
export async function captureViewer(options: CaptureOptions): ReturnType<typeof capture> {
  try {
    return await capture(options);
  } catch (error) {
    const message = String(error);
    if (/browser did not expose DevTools|DevTools did not accept the connection|DevTools did not answer (?!Runtime.evaluate)|DevTools connection closed during/.test(message) ||
        message.includes('DevTools did not answer Runtime.evaluate') && message.includes('page did not answer')) {
      throw new Error(`runner stalled: ${message}`, { cause: error });
    }
    throw error;
  }
}

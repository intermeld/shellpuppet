/**
 * Stands in for chrome-launcher in browser-detection tests: a module that
 * exports `Launcher`, imported by the detection's child process. Its query
 * string says how the lookup behaves:
 *
 * - `?mode=slow&found=<path>`: holds its thread for two seconds, as a slow
 *   synchronous shell-out does, then reports `<path>`;
 * - `?mode=found&found=<path>`: reports `<path>` at once;
 * - `?mode=empty`: reports nothing;
 * - `?mode=throw`: throws, as chrome-launcher does on Linux with no Chrome;
 * - `?mode=hang`: holds its thread for a minute.
 */

const query = new URL(import.meta.url).searchParams;
const mode = query.get('mode') ?? 'empty';
const found = query.get('found') ?? '';

function hold(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const Launcher = {
  getInstallations() {
    if (mode === 'slow') {
      hold(2_000);
      return [found];
    }
    if (mode === 'found') return [found];
    if (mode === 'throw') throw new Error('no installation found');
    if (mode === 'hang') {
      hold(60_000);
      return [found];
    }
    return [];
  },
};

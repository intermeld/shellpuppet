import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { assessDeliveredCadence, deliveredNoticeScript, type DeliveredCadence } from './noticeCadence.js';

/** Run the delivered observer across a rendering update that starts at 982 ms
 * and crosses the rest deadline before the observer callback runs. */
function observeRest(clearOnTime: boolean): DeliveredCadence {
  const epoch = 500;
  let now = epoch;
  let render: (timestamp: number) => void;
  let completed: (() => void) | undefined;
  const style = { top: '0px' };
  const screen = { rect: { top: 0, height: 240 } };
  const notice = { style, get rect() {
    const top = style.top === 'auto' ? 220 : 0;
    return { top, height: 20, bottom: top + 20 };
  } };
  const term = { rows: 24, buffer: { active: { cursorY: 0 } },
    element: { querySelector: () => screen }, onCursorMove: () => ({ dispose() {} }) };
  const window = {} as { observeDeliveredNotice: (terminal: typeof term, notices: typeof notice) =>
    { stop(): DeliveredCadence } };
  runInNewContext(deliveredNoticeScript, {
    window, performance: { now: () => now }, HTMLElement: { prototype: {
      getBoundingClientRect(this: typeof screen) { return this.rect; },
    } },
    requestAnimationFrame(callback: typeof render) { render = callback; return 1; },
    setTimeout(callback: () => void) { completed = callback; },
    cancelAnimationFrame() {}, setInterval() {}, clearInterval() {},
  });
  const observer = window.observeDeliveredNotice(term, notice);
  function frame(opportunity: number, callbackTime: number) {
    now = epoch + callbackTime;
    render(epoch + opportunity);
    completed?.();
    completed = undefined;
  }
  frame(982, 1001);
  if (clearOnTime) style.top = 'auto';
  frame(1016, 1018);
  frame(1032, 1034);
  now = epoch + 1050;
  return observer.stop();
}

it('uses the shared rendering timestamp when a frame crosses the rest deadline', () => {
  const cadence = observeRest(true);
  expect(assessDeliveredCadence(cadence).violations).toEqual([]);
  expect(cadence.samples.filter(sample => sample.deadline)).toEqual([
    expect.objectContaining({ time: 1018, frameTime: 1016, covered: false }),
    expect.objectContaining({ time: 1034, frameTime: 1032, covered: false }),
  ]);
});

it('rejects a disabled rest move on the first eligible rendering opportunity', () => {
  expect(assessDeliveredCadence(observeRest(false)).violations).toMatchObject([
    { rule: 'rest clears on first completed frame at or after deadline',
      frame: { time: 1018, frameTime: 1016, covered: true } },
  ]);
});

it('checks the rendering timestamp when replaying a completed-frame observation', () => {
  const cadence = observeRest(true);
  const eligible = cadence.samples.findIndex(sample => sample.deadline);
  cadence.samples.splice(eligible, 0, { ...cadence.samples[eligible]!, time: 1001, frameTime: 982,
    side: 'top', covered: true });
  expect(assessDeliveredCadence(cadence).violations).toEqual([]);
});

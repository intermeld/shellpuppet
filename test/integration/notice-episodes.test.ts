import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, expect, it, vi } from 'vitest';
import { assessDeliveredCadence, type DeliveredCadence } from './noticeCadence.js';

interface Trace { word: string; run: string; end: number; visits: [number, number][] }
type Side = 'top' | 'bottom';
const traces = JSON.parse(readFileSync(new URL('../fixtures/notice-delivered-words.json', import.meta.url), 'utf8')) as Trace[];
const source = readFileSync(new URL('../../src/viewer/pane.js', import.meta.url), 'utf8');
const edge = (row: number) => row <= 2 ? 'top' : row >= 21 ? 'bottom' : null;
const wrapRect = { top: 0, bottom: 280, height: 280 };
const screenRect = { top: 12, bottom: 252, height: 240 };
const noticeHeight = 30;
interface Placement { at: number; row: number; top: number; bottom: number; side: Side }

function offset(value: string) {
  const pixels = /^(-?[\d.]+)px$/.exec(value);
  if (pixels) return Number(pixels[1]);
  const fromEnd = /^calc\(100% - ([\d.]+)px\)$/.exec(value);
  if (fromEnd) return wrapRect.height - Number(fromEnd[1]);
  throw new Error(`Unknown replay offset ${value}`);
}

function overlaps(box: Placement, row: number) {
  const cell = screenRect.height / 24;
  return box.top < screenRect.top + (row + 1) * cell && box.bottom > screenRect.top + row * cell;
}

function displayedAt(trace: Trace, placements: Placement[], at: number) {
  const box = placements.filter(placement => placement.at <= at).at(-1)!;
  const row = trace.visits.filter(([start]) => start <= at).at(-1)![1];
  return { ...box, at, row, covered: overlaps(box, row) };
}

// The shipped pane receives the recorded cursor events, its own timers and
// 16 ms frames on one clock. A tick is a tenth of a millisecond, the precision
// of the CI trace. Every style assignment records the decision at that instant.
function replay(trace: Trace, layoutTimes: number[] = [], initial = { row: 22, settledMs: 1200 }) {
  vi.useFakeTimers({ now: 0 });
  const origin = initial.settledMs * 10;
  const now = () => (Date.now() - origin) / 10;
  const advance = (at: number) => vi.advanceTimersByTime(origin + Math.round(at * 10) - Date.now());
  const cursor = { cursorY: initial.row };
  let move!: () => void, layout!: () => void;
  const evaluations: Placement[] = [];
  const style = { top: '', set bottom(value: string) {
    const top = this.top === 'auto' ? wrapRect.bottom - offset(value) - noticeHeight : wrapRect.top + offset(this.top);
    const bottom = top + noticeHeight;
    const side = Math.abs(top - screenRect.top) < Math.abs(bottom - screenRect.bottom) ? 'top' : 'bottom';
    evaluations.push({ at: now(), top, bottom, side, row: cursor.cursorY });
  } };
  const screen = Object.assign(new EventTarget(), { getBoundingClientRect: () => screenRect });
  const wrap = Object.assign(new EventTarget(), { getBoundingClientRect: () => wrapRect });
  const notices = { style, getBoundingClientRect: () => ({ height: noticeHeight }) };
  class Terminal {
    rows = 24;
    buffer = { active: cursor };
    element = { querySelector: (selector: string) => selector === '.xterm-screen' ? screen : null };
    _core = { _coreBrowserService: { onDprChange: () => ({ dispose() {} }) } };
    onCursorMove(callback: () => void) { move = callback; return { dispose() {} }; }
    open() {} onData() {} onBinary() {} attachCustomKeyEventHandler() {} dispose() {}
  }
  const window = {
    performance: { now },
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 160 - Date.now() % 160),
    cancelAnimationFrame: clearTimeout,
    ResizeObserver: class {
      constructor(callback: () => void) { layout = callback; }
      observe() {} disconnect() {}
    },
  };
  runInNewContext(source, { window, Terminal, document: new EventTarget(), navigator: { userAgent: '' },
    location: { host: 'localhost' }, WebSocket: class { close() {} },
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, Math.max(1, Math.ceil(ms * 10))),
    clearTimeout });
  const implementation = (window as typeof window & { ShellPuppetPane: { create(config: unknown): { destroy(): void } } }).ShellPuppetPane;
  const pane = implementation.create({ container: { parentElement: wrap }, sessionId: 'replay',
    elements: { promptAlert: { parentElement: notices } } });
  try {
    const events = [...trace.visits.map(([at, row]) => ({ at, deliver: () => { cursor.cursorY = row; move(); } })),
      ...layoutTimes.map(at => ({ at, deliver: layout }))].sort((a, b) => a.at - b.at);
    for (const event of events) { advance(event.at); event.deliver(); }
    advance(trace.end);
    return evaluations;
  } finally { pane.destroy(); }
}

afterEach(() => vi.useRealTimers());

it.each(traces)('clears every completed rectangle rest in $word from run $run', trace => {
  const decisions = replay(trace);
  const moves = decisions.filter((d, i) => i > 0 && d.top !== decisions[i - 1]!.top);
  for (const move of moves) expect(overlaps(move, move.row), JSON.stringify(move)).toBe(false);
  for (const [i, [start]] of trace.visits.entries()) {
    const end = trace.visits[i + 1]?.[0] ?? trace.end;
    expect(moves.filter(d => d.at >= start && d.at < end).length).toBeLessThanOrEqual(1);
  }
  const rests: Side[] = [];
  const restMoves = new Set<typeof moves[number]>();
  for (let i = 0; i < trace.visits.length;) {
    const [start, row] = trace.visits[i++]!;
    const side = edge(row);
    while (i < trace.visits.length && edge(trace.visits[i]![1]) === side) i++;
    const end = trace.visits[i]?.[0] ?? trace.end;
    if (!side || end - start < 1000) continue;
    const firstFrame = Math.ceil((start + 1000) / 16) * 16;
    expect(firstFrame).toBeLessThan(end);
    const changes = moves.filter(d => d.at >= start && d.at < end);
    for (const change of changes) restMoves.add(change);
    expect(changes.length).toBeLessThanOrEqual(1);
    const display = displayedAt(trace, decisions, firstFrame);
    expect(display.covered, JSON.stringify(display)).toBe(false);
    expect(display.side).toBe(side === 'top' ? 'bottom' : 'top');
    expect(changes.every(d => d.at <= firstFrame)).toBe(true);
    rests.push(side);
  }
  expect(rests).toEqual(trace.word === 'rlong' ? ['top', 'bottom', 'top', 'bottom', 'top', 'bottom', 'top']
    : trace.run === '44697690503' ? ['top', 'bottom', 'bottom', 'bottom'] : ['bottom', 'bottom', 'bottom']);
  // Account for every other move, including the incomplete final word.
  // A provisional move in a stay that became a rest refunds its repaint.
  const repaints = moves.filter(change => !restMoves.has(change));
  const expected = trace.word === 'rlong' ? [] : trace.run === '44697690503'
    ? ['bottom', 'bottom'] : ['bottom', 'bottom', 'bottom'];
  expect(repaints.map(change => change.side)).toEqual(expected);
  for (let i = 1; i < repaints.length; i++) {
    expect(repaints[i]!.at - repaints[i - 1]!.at).toBeGreaterThanOrEqual(10_000);
  }
});

it.each(traces.filter(trace => trace.word === 'rlong'))('checks each lower repaint entry from $run', trace => {
  const entries = trace.visits.filter(([, row], i) => row === 22 && trace.visits[i - 1]?.[1] === 15);
  expect(entries).toHaveLength(3);
  // Each lower entry follows several seconds of neutral rows. The upper
  // weight is zero. Here the 20 ms floor binds before the guarded ratio.
  const offsets = [19.9, 20.4, 24.9, 25];
  const times = entries.flatMap(([start]) => offsets.map(offset => Math.round((start + offset) * 10) / 10));
  const decisions = replay(trace, times);
  for (const [i, time] of times.entries()) {
    const display = displayedAt(trace, decisions, time);
    const shouldHold = i % offsets.length === 0;
    expect(display, String(time)).toMatchObject({ side: shouldHold ? 'bottom' : 'top', covered: shouldHold });
  }
});

it('keeps the delivery guard when the advantage crosses 20 to 25 ms', () => {
  // After the upper rest and a neutral interval, the upper weight is 30 ms.
  // At 50.4 ms of lower occupancy the absolute margin is met. At 52.5 ms
  // the guarded ratio also holds: 30 + 5 equals two thirds of 52.5.
  const trace: Trace = { word: 'ratio boundary', run: '', end: 2600,
    visits: [[0, 0], [1110, 8], [2500, 1], [2530, 22]] };
  const times = [2580.4, 2582.4, 2582.5, 2585];
  const decisions = replay(trace, times);
  expect(times.map(at => decisions.filter(d => d.at === at).at(-1)?.side))
    .toEqual(['bottom', 'bottom', 'top', 'top']);
});

it('requires a repaint once a repeated row word renews its first cycle', () => {
  const visits: Trace['visits'] = [[0, 0], [100, 22]];
  for (let at = 250; at < 2700; at += 600) visits.push([at, 0], [at + 100, 22]);
  const trace = { word: 'renewed', run: '', end: 2984, visits };
  const legs = visits.map(([start, row], i) => ({ start, row, end: visits[i + 1]?.[0] ?? trace.end,
    top: row === 0, bottom: row === 22 }));
  const decisions = replay(trace, [], { row: 8, settledMs: 0 });
  const samples = decisions.map(box => {
    const leg = legs.filter(visit => visit.start <= box.at).length - 1;
    return { time: box.at, leg, row: box.row, side: box.side, covered: overlaps(box, box.row), evaluation: true, deadline: false };
  });
  expect(assessDeliveredCadence({ end: trace.end, legs, samples }).violations).toEqual([]);
  const held = samples.map(sample => ({ ...sample, side: 'bottom', covered: legs[sample.leg]!.bottom }));
  expect(assessDeliveredCadence({ end: trace.end, legs, samples: held }).violations).toEqual([
    { rule: 'first eligible clear-edge deadline', target: 'top', clearBy: 2500, first: 2512 },
  ]);
});

it('judges the staged 80 by 150 evaluation on the guarded side of the ratio', () => {
  // The first evaluation of this CI pair was 4.93 ms beyond the raw ratio.
  const starts = [0.1, 430.4, 1109.6, 1761.8, 2415.6, 2719.1, 3374.6, 4037.2];
  const rows = [0, 50, 75, 148, 0, 50, 75, 148];
  const cadence: DeliveredCadence = { end: 4688.9, legs: starts.map((start, i) => ({
    row: rows[i]!, start, end: starts[i + 1] ?? 4688.9, top: rows[i] === 0, bottom: rows[i] === 148,
  })), samples: [{ time: 4491.5, row: 148, side: 'bottom', leg: 7, deadline: false, evaluation: true, covered: true }] };
  expect(assessDeliveredCadence(cadence).violations).toEqual([]);
  cadence.samples.push({ ...cadence.samples[0]!, time: 4508.5 });
  expect(assessDeliveredCadence(cadence).violations).toEqual([
    { rule: 'first eligible clear-edge deadline', target: 'top', clearBy: 2500.1, first: 4508.5 },
  ]);
});

it('separates a staged repaint from the required clear of a later upper rest', () => {
  const starts = [0.1, 116.2, 471.4, 827.5, 1336.4, 1446.5, 1800.1, 2167, 2673.1, 2780,
    3131.9, 3486.4, 3989.6, 4097.9, 4454, 4809.8, 5317.3];
  const rows = [0, 50, 75, 148];
  const end = 6499.4;
  const legs = starts.map((start, i) => ({ start, end: starts[i + 1] ?? end,
    row: rows[i % 4]!, top: i % 4 === 0, bottom: i % 4 === 3 }));
  const recorded: [number, number, Side][] = [[1018.4, 3, 'bottom'], [1020.9, 3, 'top'],
    [6318.5, 16, 'top'], [6318.6, 16, 'bottom'], [6322.9, 16, 'bottom'], [6327.7, 16, 'bottom']];
  const samples = recorded.map(([time, leg, side]) => ({ time, leg, side, row: legs[leg]!.row,
    covered: side === 'top' ? legs[leg]!.top : legs[leg]!.bottom,
    deadline: time === 6322.9, frameTime: time === 6322.9 ? 6322.1 : undefined }));
  const result = assessDeliveredCadence({ legs, samples, end });
  expect(result.violations).toEqual([]);
  expect(result.changes.map(change => change.side)).toEqual(['top', 'bottom']);
  expect(result.repaintChanges.map(change => change.side)).toEqual(['top']);
  expect(result.rests).toMatchObject([{ edge: 'top', start: 5317.3, changes: 1, deadline: 6322.9 }]);
  const missed = samples.map(sample => sample.leg === 16 ? { ...sample, side: 'top', covered: true } : sample);
  expect(assessDeliveredCadence({ legs, samples: missed, end }).violations).toMatchObject([
    { rule: 'rest clears on first completed frame at or after deadline', frame: { time: 6322.9 } },
  ]);
});

it('still requires an eligible repaint when individual short cycles have less than 20 ms advantage', () => {
  const legs = Array.from({ length: 130 }, (_, i) => {
    const start = i * 20;
    return [{ start, end: start + 16, row: 22, bottom: true, top: false },
      { start: start + 16, end: start + 20, row: 0, bottom: false, top: true }];
  }).flat();
  const result = assessDeliveredCadence({ end: 2600, legs, samples: [
    { time: 2528, row: 22, side: 'bottom', leg: 252, evaluation: true, deadline: false, covered: true },
  ] });
  expect(result.violations).toEqual([
    { rule: 'first eligible clear-edge deadline', target: 'top', clearBy: 2500, first: 2528 },
  ]);
});

it('keeps a staged deadline when a later upper visit erases the aggregate lead', () => {
  const starts = [0, 307.3, 970, 1634.9, 2296.3, 2603.2, 3267.2, 3927, 4589.4,
    5561.4, 6226.3, 6893.4, 7557, 7863.7, 8527.3, 9186.8, 9853.1];
  const rows = [0, 50, 75, 148];
  const legs = starts.map((start, i) => ({ start, end: starts[i + 1] ?? 10004.7,
    row: rows[i % 4]!, top: i % 4 === 0, bottom: i % 4 === 3 }));
  const recorded: [number, number, Side][] = [[2109.9, 3, 'bottom'], [2118.4, 3, 'top'],
    [4169, 7, 'top'], [4235.6, 7, 'top']];
  const samples = recorded.map(([time, leg, side]) => ({ time, leg, side, row: legs[leg]!.row,
    deadline: false, evaluation: true, covered: side === 'bottom' }));
  const result = assessDeliveredCadence({ legs, samples, end: 10004.7 });
  expect(result.repaints[0]?.target).toBeNull();
  expect(result.changes.map(change => change.side)).toEqual(['top']);
  expect(result.violations).toEqual([]);
  const held = samples.map(sample => ({ ...sample, side: 'bottom', covered: true }));
  expect(assessDeliveredCadence({ legs, samples: held, end: 10004.7 }).violations).toEqual([
    { rule: 'first eligible clear-edge deadline', target: 'top', clearBy: 2500, first: 4235.6 },
  ]);
});

it.each(traces.filter(trace => trace.word === 'rchange'))('checks the eligible repaint decisions of the changing word from $run', trace => {
  const decisions = replay(trace);
  const moves = decisions.filter((d, i) => i > 0 && d.side !== decisions[i - 1]!.side);
  // These are separate repaints onto the bottom edge. The intervening
  // lower rests clear to the top and leave the last repaint time intact.
  const startsWithRest = trace.visits[1]![0] >= 1000;
  const afterRest = trace.visits.filter(([, row], i) => row === 0 && trace.visits[i - 1]?.[1] === 23);
  expect(afterRest).toHaveLength(3);
  // Each delivered row requests a frame immediately and every 50 ms until
  // the next row. These opportunities exist even if the pane never writes.
  const frames = trace.visits.flatMap(([start], i) => {
    const end = trace.visits[i + 1]?.[0] ?? trace.end;
    const result: number[] = [];
    for (let request = start; request < end; request += 50) result.push((Math.floor(request / 16) + 1) * 16);
    return result;
  });
  let previous = startsWithRest ? -Infinity : moves.find(d => d.side === 'bottom')!.at;
  if (!startsWithRest) {
    // The second top visit is the first clear destination after startup.
    const returnAt = trace.visits[2]![0];
    expect(previous).toBeGreaterThanOrEqual(returnAt);
    expect(previous).toBeLessThanOrEqual(Math.ceil(returnAt / 16) * 16);
  }
  for (const [start] of afterRest) {
    const eligible = Math.max(start + 1200, previous + 10_000);
    const end = trace.visits.find(([at, row]) => at > start + 1200 && row === 22)?.[0] ?? trace.end;
    const changes = moves.filter(d => d.at >= start && d.at < end);
    if (eligible >= end) { expect(changes).toEqual([]); continue; }
    const first = frames.find(at => at >= eligible && at < end);
    expect(first, JSON.stringify({ eligible, end })).toBeDefined();
    const display = displayedAt(trace, decisions, first!);
    expect(display, JSON.stringify({ eligible, display })).toMatchObject({ side: 'bottom', covered: false });
    expect(decisions.filter(d => d.at >= first! && d.at < end).every(d => d.side === 'bottom')).toBe(true);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.at).toBeGreaterThanOrEqual(eligible);
    expect(changes[0]!.at).toBeLessThanOrEqual(first!);
    previous = changes[0]!.at;
  }
});

// Controlled xterm traffic, including split writes and long repaint pauses.
// Socket doubles let the same pane run in viewer and dashboard modes.
window.noticePause = ms => new Promise(resolve => setTimeout(resolve, ms));
window.noticeFrameTiming = onFrame => {
  const gaps = [];
  let previous = null, first = null, active = true;
  const started = performance.now();
  const tick = time => {
    first ??= time;
    if (previous !== null) gaps.push(time - previous);
    previous = time;
    onFrame?.(time, gaps.length);
    if (active) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => {
    active = false;
    const ordered = gaps.slice().sort((a, b) => a - b);
    return { frames: gaps.length, frameInterval: ordered[Math.floor(ordered.length / 2)] ?? null,
      maxFrameGap: ordered.at(-1) ?? null, frameSpan: previous === null ? 0 : previous - first,
      observedMs: performance.now() - started };
  };
};
window.makeNoticePane = (mode, rows) => {
  const NativeSocket = window.WebSocket;
  let socket;
  const FakeSocket = class {
    constructor() { this.readyState = 1; socket = this; }
    send() {}
    close() { this.readyState = 3; }
  };
  window.WebSocket = FakeSocket;
  const wrap = document.createElement('div');
  wrap.id = 'wrap';
  wrap.style.cssText = 'position:fixed;left:0;top:0;width:850px;height:700px;padding:6px;box-sizing:border-box';
  const container = document.createElement('div');
  container.id = 'term';
  container.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center';
  const notices = document.createElement('div');
  notices.id = 'notices'; notices.className = 'pane-notices';
  const alert = document.createElement('div');
  alert.id = 'prompt-alert'; alert.className = 'pane-prompt'; alert.hidden = true;
  notices.append(alert); wrap.append(container, notices); document.body.append(wrap);
  const pane = ShellPuppetPane.create({ container, sessionId: 'notice-test',
    dashboardProof: mode === 'dashboard' ? 'test-proof' : null, elements: { promptAlert: alert } });
  window.WebSocket = NativeSocket;
  const term = pane.getTerminal();
  const control = value => socket.onmessage({ data: JSON.stringify(value) });
  const binary = value => socket.onmessage({ data: new TextEncoder().encode(value).buffer });
  const geometry = count => control({ type: 'geometry', cols: 80, rows: count, control: 'held' });
  socket.onopen(); geometry(rows);
  // Drops the connection and lets the pane's own retry open a new one.
  const reconnect = async () => {
    const old = socket;
    window.WebSocket = FakeSocket;
    try {
      old.readyState = 3; old.onclose();
      const deadline = Date.now() + 5000;
      while (socket === old && Date.now() < deadline) await noticePause(50);
    } finally { window.WebSocket = NativeSocket; }
    if (socket === old) throw new Error('the pane did not reconnect');
    socket.onopen(); geometry(rows);
  };
  const move = row => new Promise(resolve => term.write('\x1b[' + (row + 1) + ';1H', resolve));
  const show = () => control({ type: 'prompt-stall', question: 'Allow this command to run?',
    waitingMs: 300, options: ['1. Allow once', '2. Reject'] });
  const side = () => notices.style.top === 'auto' ? 'bottom' : 'top';
  const screen = term.element.querySelector('.xterm-screen');
  const screenRect = screen.getBoundingClientRect.bind(screen);
  let rects = 0;
  for (const element of [screen, wrap, notices]) {
    const original = element.getBoundingClientRect.bind(element);
    element.getBoundingClientRect = () => { rects++; return original(); };
  }
  const noticeRect = HTMLElement.prototype.getBoundingClientRect.bind(notices);
  const measure = (row = term.buffer.active.cursorY) => {
    const grid = screenRect(), box = noticeRect(), cell = grid.height / term.rows;
    return { side: side(), row, rows: term.rows, height: box.height,
      overlap: !alert.hidden && box.top < grid.top + (row + 1) * cell - 0.01 &&
        box.bottom > grid.top + row * cell + 0.01 };
  };
  return { pane, term, notices, wrap, control, binary, geometry, reconnect, move, show, side, measure,
    rects: () => rects, destroy: () => { pane.destroy(); wrap.remove(); } };
};

window.noticeOccupancyCases = async (mode, kind) => {
  const results = [];
  if (kind === 'dominant') {
    for (const rows of [4, 5, 8, 12, 24, 49, 150]) for (const initial of [0, 1]) {
      const p = makeNoticePane(mode, rows);
      try {
        await p.move(1); await p.move(initial); await noticePause(1100); p.show();
        const before = p.measure();
        const stopFrames = noticeFrameTiming(), start = performance.now(), placements = new Set();
        let samples = 0, covered = 0, measuredAt = null;
        // Establish the old edge first. A clearly leading lower rest must
        // win whether the previous resting row is still visited or gone.
        // Equal replacements retain their edge in noticeCoveredTimeCases.
        // Cover and steadiness count after the documented startup deadline for
        // a repaint-driven change: a clearly leading edge within 2.5 s.
        while (performance.now() - start < 4000) {
          await p.move(rows - 1); await noticePause(100);
          if (performance.now() - start > 2517) {
            measuredAt ??= p.rects();
            placements.add(p.side()); samples++;
            if (p.measure(rows - 1).overlap) covered++;
          }
          await p.move(0); await noticePause(9);
        }
        // A newly shown alert or an explicit fit during a header visit must
        // use the recorded resting row, not that transient cursor position.
        p.show();
        const shown = p.measure(rows - 1);
        p.pane.relayout(false);
        const fitted = p.measure(rows - 1);
        p.geometry(rows + 1);
        const resized = p.measure(rows - 1);
        results.push({ rows, initial, before, samples, covered, ...stopFrames(), placements: [...placements],
          rects: p.rects() - measuredAt, shown, fitted, resized });
      } finally { p.destroy(); }
    }
  }
  if (kind === 'quiet') {
    for (const rows of [4, 5, 8, 12, 24, 49, 150, 500]) {
      const p = makeNoticePane(mode, rows);
      try {
        await p.move(1); await p.move(0); await noticePause(600); p.show();
        // Model a browser timer rounding down before the quiet deadline.
        // This must re-arm its check rather than leave a final move stranded.
        const nativeTimeout = window.setTimeout;
        let earlyQuiet = false;
        window.setTimeout = (cb, ms, ...args) => {
          if (!earlyQuiet && cb.name === 'settleNoticeCursor') {
            earlyQuiet = true;
            return nativeTimeout(cb, Math.max(0, ms - 30), ...args);
          }
          return nativeTimeout(cb, ms, ...args);
        };
        try { await p.move(Math.ceil(rows / 2)); await noticePause(1050); }
        finally { window.setTimeout = nativeTimeout; }
        const lower = p.measure();
        await p.move(rows - 1); await noticePause(1050);
        await p.move(Math.ceil(rows / 2) - 1); await noticePause(1050);
        const upper = p.measure();
        // Make the alert tall enough to cover every intersecting edge row.
        p.notices.firstChild.style.minHeight = '600px'; p.pane.relayout(false);
        await p.move(0); await noticePause(1050);
        await p.move(Math.floor(rows / 3)); await noticePause(1050);
        const edge = p.measure();
        p.pane.setFontOverride(8); const font = p.measure();
        p.pane.setDashboardFontLimit(7); const limit = p.measure();
        p.wrap.style.height = '100px'; p.wrap.style.width = '180px';
        p.pane.relayout(false); const scale = p.measure();
        results.push({ rows, lower, upper, edge, font, limit, scale, earlyQuiet });
      } finally { p.destroy(); }
    }
  }
  if (kind === 'alternation') {
    for (const rows of [4, 12, 24, 49, 150]) {
      for (const interval of [350, 400]) {
        const p = makeNoticePane(mode, rows);
        try {
          await p.move(rows - 1); await noticePause(650); p.show();
          const stopFrames = noticeFrameTiming();
          const before = p.side(), placements = new Set([before]), start = performance.now();
          let covered = 0, samples = 0;
          const watch = setInterval(() => {
            placements.add(p.side()); samples++;
            if (p.measure(rows - 1).overlap) covered++;
          }, 10);
          try {
            for (let i = 0; i < 5; i++) {
              await p.move(0); await noticePause(interval);
              await p.move(rows - 1); await noticePause(interval);
            }
          } finally { clearInterval(watch); }
          const stable = { rows, interval, before, covered, samples, ...stopFrames(),
            placements: [...placements], elapsed: performance.now() - start };
          await p.move(0); await noticePause(1050);
          results.push({ ...stable, final: p.measure() });
        } finally { p.destroy(); }
      }
    }
  }
  return results;
};

window.noticeDisposalCases = async mode => {
  const nativeFrame = requestAnimationFrame, nativeCancel = cancelAnimationFrame;
  const nativeTimer = setTimeout, nativeClear = clearTimeout;
  const NativeObserver = ResizeObserver;
  const frames = new Set(), timers = new Set();
  const observers = new Set();
  let callbacks = 0, holdFrame = false;
  window.requestAnimationFrame = cb => {
    const tracked = cb.name === 'sampleNoticeCursor';
    let id;
    id = nativeFrame(time => {
      if (tracked && holdFrame) return;
      frames.delete(id);
      if (tracked) callbacks++;
      cb(time);
    });
    if (tracked) frames.add(id);
    return id;
  };
  window.cancelAnimationFrame = id => { frames.delete(id); nativeCancel(id); };
  window.setTimeout = (cb, ms, ...args) => {
    const tracked = typeof cb === 'function' &&
      (cb.name === 'settleNoticeCursor' || cb.toString().includes('scheduleNoticeCursor()'));
    let id;
    id = nativeTimer(() => { timers.delete(id); if (tracked) callbacks++; cb(...args); }, ms);
    if (tracked) timers.add(id);
    return id;
  };
  window.clearTimeout = id => { timers.delete(id); nativeClear(id); };
  window.ResizeObserver = class {
    constructor(cb) { this.inner = new NativeObserver(entries => cb(entries)); }
    observe(element) {
      if (element.id === 'notices') observers.add(this);
      this.inner.observe(element);
    }
    unobserve(element) { this.inner.unobserve(element); }
    disconnect() { observers.delete(this); this.inner.disconnect(); }
  };
  const state = p => {
    const listeners = p.term._core._onCursorMove._listeners;
    return { frames: frames.size, timers: timers.size, observers: observers.size, callbacks,
      listeners: (Array.isArray(listeners) ? listeners : [listeners]).filter(Boolean)
        .filter(listener => listener.value.name === 'scheduleNoticeCursor').length };
  };
  const results = [];
  try {
    for (const rows of [4, 24, 150]) for (const end of ['destroy', 'exited', 'identity', 'input-refused']) {
      for (const pending of ['frame', 'timer']) {
        const p = makeNoticePane(mode, rows);
        try {
          await p.move(22); await noticePause(650); p.show();
          holdFrame = pending === 'frame';
          await p.move(0);
          if (pending === 'timer') await noticePause(80);
          const before = state(p);
          if (end === 'destroy') p.pane.destroy();
          else p.control(end === 'identity' ? { type: end, exited: true, exitCode: 0 } :
            { type: end, reason: 'exited', exitCode: 0 });
          const immediate = state(p);
          holdFrame = false;
          await noticePause(700);
          if (end !== 'destroy') { await p.move(22); await noticePause(700); }
          const after = state(p);
          p.pane.destroy();
          results.push({ rows, end, pending, before, immediate, after, repeated: state(p) });
        } finally { holdFrame = false; p.destroy(); }
      }
    }
  } finally {
    window.requestAnimationFrame = nativeFrame; window.cancelAnimationFrame = nativeCancel;
    window.setTimeout = nativeTimer; window.clearTimeout = nativeClear;
    window.ResizeObserver = NativeObserver;
  }
  return results;
};

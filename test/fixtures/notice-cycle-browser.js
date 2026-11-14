// Exercise late layout updates and returns within a larger repaint cycle.
window.noticeEqualLayoutCases = async (mode, kind) => {
  const results = [];
  for (const rows of [24, 150]) for (const initial of [0, rows - 1]) {
    const p = makeNoticePane(mode, rows);
    try {
      await p.move(1); await p.move(initial); await noticePause(1100); p.show();
      await noticePause(100);
      const before = p.side(), changes = [], layouts = [], visits = [];
      const start = performance.now();
      const subscription = p.term.onCursorMove(() => visits.push({ row: p.term.buffer.active.cursorY, at: performance.now() - start }));
      let last = before;
      const watch = setInterval(() => {
        if (last !== p.side()) { last = p.side(); changes.push({ side: last, at: performance.now() - start }); }
      }, 4);
      try {
        // Start with an actual row change after the preparation rest.
        const alternatingRows = initial === 0 ? [rows - 1, 0] : [0, rows - 1];
        for (let cycle = 0; cycle < 6; cycle++) for (const row of alternatingRows) {
          await p.move(row); await noticePause(385);
          if (kind === 'height') {
            p.control({ type: 'prompt-stall', waitingMs: 900,
              question: row === 0 ? 'Allow this command to run?' : 'Allow this command to run? '.repeat(35),
              options: row === 0 ? ['1. Allow once', '2. Reject'] :
                Array.from({ length: 18 }, (_, i) => String(i + 1) + '. A detailed option') });
          } else { p.show(); p.pane.relayout(false); }
          const screen = p.term.element.querySelector('.xterm-screen').getBoundingClientRect();
          const box = p.notices.getBoundingClientRect();
          layouts.push({ height: box.height,
            anchorError: Math.abs(p.side() === 'top' ? box.top - screen.top : box.bottom - screen.bottom),
            capError: Math.abs(parseFloat(p.notices.style.maxHeight) - screen.height / 3) });
          await noticePause(65);
        }
      } finally { clearInterval(watch); subscription.dispose(); }
      results.push({ rows, initial, before, changes, layouts, visits, elapsed: performance.now() - start });
    } finally { p.destroy(); }
  }
  return results;
};

window.noticeNestedReturnCases = async (mode, timing = [30, 290, 30, 300]) => {
  const results = [];
  for (const rows of [24, 150]) {
    const p = makeNoticePane(mode, rows);
    try {
      await p.move(rows - 2); await noticePause(650); p.show(); await noticePause(100);
      const start = performance.now(), changes = [], visits = [], stopFrames = noticeFrameTiming();
      const subscription = p.term.onCursorMove(() => visits.push({ row: p.term.buffer.active.cursorY, at: performance.now() - start }));
      let last = p.side(), samples = 0, covered = 0, restSamples = 0, coveredAtRest = 0;
      const watch = setInterval(() => {
        const elapsed = performance.now() - start;
        if (last !== p.side()) { last = p.side(); changes.push({ side: last, at: elapsed }); }
        if (elapsed > 1700) {
          const overlap = p.measure(rows - 2).overlap;
          samples++; if (overlap) covered++;
          if (p.term.buffer.active.cursorY === rows - 2) { restSamples++; if (overlap) coveredAtRest++; }
        }
      }, 4);
      try {
        while (performance.now() - start < 6500) {
          for (const [i, row] of [0, Math.floor(rows / 2), 0, rows - 2].entries()) {
            await p.move(row); await noticePause(timing[i]);
          }
        }
      } finally { clearInterval(watch); subscription.dispose(); }
      results.push({ rows, samples, covered, restSamples, coveredAtRest, changes, visits, ...stopFrames() });
    } finally { p.destroy(); }
  }
  return results;
};

window.noticeSnapshotCases = async mode => {
  const results = [];
  for (const rows of [24, 150]) for (const ended of [false, true]) {
    for (const order of ['before', 'after']) {
      const p = makeNoticePane(mode, rows);
      try {
        // Let initial layout complete before the queued snapshot and alert.
        await noticePause(100);
        if (ended) p.control({ type: 'identity', exited: true, exitCode: 0 });
        if (order === 'before') p.show();
        p.binary('\x1b[2J\x1b[1;1HStatus\x1b[' + (rows - 1) + ';1HPrompt');
        if (order === 'after') p.show();
        // The next write's callback runs immediately after snapshot parsing,
        // before a frame or the quiet timer could repair initial placement.
        const ready = await new Promise(resolve => p.term.write('', () => resolve(p.measure())));
        await noticePause(100);
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rects = p.rects();
        for (let chunk = 0; chunk < 8; chunk++) {
          p.binary('\x1b[1;1HStatus\x1b[' + (rows - 1) + ';1HPrompt');
          await noticePause(10);
        }
        const ordinaryReads = p.rects() - rects;
        const listeners = p.term._core._onCursorMove._listeners;
        const tracking = (Array.isArray(listeners) ? listeners : [listeners]).filter(Boolean)
          .filter(listener => listener.value.name === 'scheduleNoticeCursor').length;
        results.push({ rows, ended, order, ready, ordinaryReads, tracking });
      } finally { p.destroy(); }
    }
    const p = makeNoticePane(mode, rows);
    try {
      p.show();
      // Hold parsing completion across destroy, without disposing xterm yet.
      const write = p.term.write.bind(p.term), dispose = p.term.dispose.bind(p.term);
      let completed;
      p.term.write = (bytes, callback) => { completed = callback; write(bytes); };
      p.term.dispose = () => {};
      p.binary('\x1b[' + (rows - 1) + ';1HPrompt');
      p.pane.destroy();
      const before = p.notices.style.cssText, rects = p.rects();
      try {
        await new Promise(resolve => write('', resolve));
        completed?.();
        results.push({ rows, destroyed: true, unchanged: before === p.notices.style.cssText,
          reads: p.rects() - rects });
      } finally { dispose(); }
    } finally { p.destroy(); }
  }
  return results;
};

// Typing or a status field can keep moving horizontally on a settled row.
window.noticeHorizontalRestCases = async mode => {
  const results = [];
  for (const rows of [24, 150]) {
    const p = makeNoticePane(mode, rows);
    try {
      await p.move(1); await p.move(0); await noticePause(650); p.show(); await noticePause(100);
      const start = performance.now(), visits = [], rects = p.rects();
      let deadlineFrame = null, clearFrame = null, latestFrame = -1;
      const stopFrames = noticeFrameTiming((_time, index) => {
        if (visits.length && performance.now() - start - visits[0].at >= 1000) deadlineFrame ??= index;
        if (!p.measure(rows - 2).overlap) clearFrame ??= index;
        latestFrame = index;
      });
      const subscription = p.term.onCursorMove(() => visits.push({ row: p.term.buffer.active.cursorY, at: performance.now() - start }));
      let frame = 0, samples = 0, covered = 0, follow = null;
      try {
        while (performance.now() - start < 1800) {
          await new Promise(resolve => p.term.write('\x1b[' + (rows - 1) + ';' + (frame++ % 2 + 1) + 'H*', resolve));
          const overlap = p.measure(rows - 2).overlap;
          if (!overlap) follow ??= performance.now() - start;
          // Late samples count once the deadline frame has been delivered: the
          // rest must clear on that frame, and a sample taken before it is
          // painted would only measure the frame interval.
          if (deadlineFrame !== null && latestFrame > deadlineFrame) { samples++; if (overlap) covered++; }
          await noticePause(20);
        }
      } finally { subscription.dispose(); }
      results.push({ rows, samples, covered, follow, visits, rects: p.rects() - rects,
        deadlineFrame, clearFrame, ...stopFrames() });
    } finally { p.destroy(); }
  }
  return results;
};

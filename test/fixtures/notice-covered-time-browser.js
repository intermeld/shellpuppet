// Real xterm cursor events with the product styles, without PTY timer jitter.
window.noticeCoveredTimeCases = async (mode, kind) => {
  const results = [];
  for (const rows of [24, 150]) for (const initial of kind === 'equal' ? [1, rows - 2] : [0]) {
    const p = makeNoticePane(mode, rows);
    try {
      const waitFrames = async count => {
        for (let i = 0; i < count; i++) await new Promise(resolve => requestAnimationFrame(resolve));
      };
      await p.move(1); await p.move(initial);
      await noticePause(1100);
      const firstLowerMove = kind === 'plurality' ? p.move(rows - 2) : null;
      p.show(); const initialSide = p.side(); await noticePause(50);
      const expectedSide = kind === 'equal' ? p.side() : 'top';
      const restRows = kind === 'adjacent' ? [rows - 4, rows - 3, rows - 2] :
        kind === 'equal' && initial === 1 ? [0] : [rows - 2];
      const start = performance.now(), visits = [], placements = new Set();
      const subscription = p.term.onCursorMove(() => visits.push({ row: p.term.buffer.active.cursorY, at: performance.now() }));
      let samples = 0, covered = 0, follow = null, frame = 0, rects = null;
      let deadlineFrame = null, clearFrame = null;
      const stopFrames = noticeFrameTiming((_time, index) => {
        const now = performance.now() - start;
        const overlap = restRows.some(row => p.measure(row).overlap);
        if (now >= 2450) deadlineFrame ??= index;
        if (!overlap) { clearFrame ??= index; follow ??= now; }
        if (now > 1700) {
          rects ??= p.rects(); samples++;
          if (overlap) covered++;
          placements.add(p.side());
        }
      });
      let firstLowerLeg = null;
      try {
        if (kind === 'plurality') {
          await firstLowerMove;
          const lowerAt = performance.now();
          await waitFrames(4);
          await p.move(0);
          firstLowerLeg = performance.now() - lowerAt;
        }
        while (performance.now() - start < 4200) {
          if (kind === 'equal') {
            await p.move(0); await noticePause(30);
            placements.add(p.side());
            await p.move(rows - 2); await noticePause(30);
          } else if (kind === 'adjacent') {
            await p.move(0); await noticePause(12);
            for (const row of restRows) { await p.move(row); await noticePause(16); }
          } else {
            // The resting row's hold follows the delivered time of the rest of
            // the cycle, so it stays the plurality without becoming a single
            // majority at any frame rate.
            const cycleAt = performance.now();
            await p.move(0); await waitFrames(1);
            await p.move(Math.floor(rows / 2)); await waitFrames(1);
            await p.move(rows - 2);
            const restAt = performance.now();
            do { await waitFrames(1); } while (performance.now() - restAt < (restAt - cycleAt) * 0.6);
          }
          frame++;
        }
      } finally { subscription.dispose(); }
      const end = performance.now(), weights = {};
      for (let i = 0; i < visits.length; i++) {
        const visit = visits[i];
        const duration = Math.max(0, (visits[i + 1]?.at ?? end) - Math.max(start + 1700, visit.at));
        weights[visit.row] = (weights[visit.row] || 0) + duration;
      }
      results.push({ rows, kind, initial, initialSide, expectedSide, restRows, samples, covered, follow,
        deadlineFrame, clearFrame, weights, frame,
        firstLowerLeg,
        ...stopFrames(),
        placements: [...placements], rects: p.rects() - rects });
    } finally { p.destroy(); }
  }
  return results;
};

window.noticeMovingRestCases = async (mode, checkSustained = false,
  intervals = [500, 750, 1000, 1500, 2000]) => {
  const results = [];
  for (const rows of [24, 150]) for (const interval of intervals) {
    for (const excursion of [0, Math.floor(rows / 2)]) {
      const p = makeNoticePane(mode, rows);
      let observer;
      try {
        await p.move(1); await p.move(0); await noticePause(650); p.show();
        await noticePause(1100);
        observer = observeDeliveredNotice(p.term, p.notices, performance.now(), rows - 2);
        const legs = [], sustained = [];
        const follow = async (row, duration) => {
          const start = performance.now();
          let follow = null, samples = 0, covered = 0;
          while (performance.now() - start < duration) {
            await p.move(excursion); await noticePause(5);
            await p.move(row); await noticePause(23);
            const overlap = p.measure(row).overlap;
            if (!overlap) follow ??= performance.now() - start;
            if (performance.now() - start >= Math.min(duration - 70, checkSustained ? 1500 : 650)) {
              samples++; if (overlap) covered++;
            }
          }
          return { row, follow, samples, covered };
        };
        for (let leg = 0; leg < 4; leg++) {
          legs.push(await follow(leg % 2 ? 1 : rows - 2, interval));
        }
        // These phases still contain short excursions. Their observations
        // remain repaint evidence, even when the dominant row stays for a
        // long phase. Only the final uninterrupted row is a genuine rest.
        if (checkSustained) for (const row of [rows - 2, 1]) {
          sustained.push(await follow(row, 1700));
        }
        await p.move(rows - 2); await noticePause(1050);
        results.push({ rows, interval, excursion, legs, sustained, final: p.measure(), cadence: observer.stop() });
      } finally { observer?.stop(); p.destroy(); }
    }
  }
  return results;
};

window.noticeEndedLayoutCases = async mode => {
  const results = [];
  for (const rows of [24, 150]) for (const row of [0, rows - 2]) {
    for (const end of ['exited', 'identity', 'input-refused']) {
      const p = makeNoticePane(mode, rows);
      try {
        await p.move(1); await p.move(row); await noticePause(650); p.show();
        p.notices.firstChild.style.minHeight = '1000px'; p.pane.relayout(false);
        const steps = [];
        const measure = name => {
          const screen = p.term.element.querySelector('.xterm-screen').getBoundingClientRect();
          const box = p.notices.getBoundingClientRect();
          steps.push({ name, anchorError: Math.abs(p.side() === 'top' ? box.top - screen.top : box.bottom - screen.bottom),
            capError: Math.abs(parseFloat(p.notices.style.maxHeight) - screen.height / 3),
            heightError: Math.max(0, box.height - screen.height / 3) });
        };
        measure('before');
        p.control(end === 'identity' ? { type: end, exited: true, exitCode: 0 } :
          { type: end, reason: 'exited', exitCode: 0 });
        p.pane.setFontOverride(8); measure('font');
        p.wrap.style.height = '300px'; p.pane.relayout(false); measure('resize');
        p.pane.setDashboardFontLimit(7); measure('font limit');
        p.pane.relayout(true); measure('fit');
        p.show(); measure('alert');
        await noticePause(700); measure('settled');
        results.push({ rows, row, end, steps });
      } finally { p.destroy(); }
    }
  }
  return results;
};

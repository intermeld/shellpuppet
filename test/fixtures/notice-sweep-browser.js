// Requested durations drive writes; the independent observer judges delivery.
window.noticeSweepCases = async (mode, cases) => {
  const run = async spec => {
    const { rows, cycle, stages, ratio, inside } = spec;
    const p = makeNoticePane(mode, rows);
    let observer;
    try {
      const prompt = rows - 2;
      const middle = [Math.floor(rows / 3), Math.floor(rows / 2), Math.floor(rows * 2 / 3)];
      const insideRows = stages === 3 ? [rows - 3] : [2, rows - 3, middle[1]];
      const intermediate = (inside ? insideRows : middle).slice(0, stages - 2);
      const middleTime = stages === 2 ? 0 : cycle * 0.12 / (stages - 2);
      const coveredTime = cycle - middleTime * (stages - 2);
      const header = [0, coveredTime * ratio / (1 + ratio)];
      const lower = [prompt, coveredTime / (1 + ratio)];
      const panels = intermediate.map(row => [row, middleTime]);
      let legs = spec.directLegs ?? (spec.legs ? spec.legs.map(([row, ms]) =>
        [row === 'top' ? 0 : row === 'bottom' ? prompt : middle[row], ms]) :
        cycle === 3000 ? [lower, ...panels, header] : [header, ...panels, lower]);
      // Prepare on an uncovered row so a rectangle rest cannot continue
      // invisibly across the observer's start boundary.
      await p.move(spec.initial === 'top' ? Math.floor(rows * 2 / 3) : Math.floor(rows / 3));
      p.show(); await noticePause(1100);
      const epoch = performance.now();
      observer = observeDeliveredNotice(p.term, p.notices, epoch, legs[0][0]);
      const duration = spec.duration ?? Math.max(10000, cycle * 2 + 400);
      let deadline = epoch, tick = 0, continued = false;
      const initialSide = p.side();
      while (performance.now() - epoch < duration) {
        for (const [row, ms] of legs) {
          if (performance.now() - epoch >= duration) break;
          if (spec.delayLower && row === prompt) await noticePause(spec.delayLower);
          await p.move(row);
          deadline += ms;
          do {
            if (spec.spinner) await new Promise(resolve => p.term.write(
              '\x1b[' + (row + 1) + ';' + (2 + tick++ % 2) + 'H*', resolve));
            await noticePause(Math.max(1, Math.min(spec.spinner ? 50 : Infinity,
              deadline - performance.now(), epoch + duration - performance.now())));
          } while (performance.now() < Math.min(deadline, epoch + duration));
        }
        if (spec.continuation && !continued) {
          const changed = observer.peek().samples.find(sample => sample.side !== initialSide);
          const topAt = (changed?.time ?? 2500) + 10000 - 20;
          let remaining = topAt - (deadline - epoch), row = rows - 1;
          const next = [];
          while (remaining > 0) {
            const ms = Math.min(800, remaining);
            next.push([row, ms]); remaining -= ms; row = row === rows - 1 ? prompt : rows - 1;
          }
          next.push([0, spec.continuation === 'rest' ? 1200 : 900], [1, 900], [0, 900], [1, 900]);
          legs = next; continued = true;
        }
      }
      const cadence = observer.stop();
      if (!spec.continuation) cadence.cycleRows = legs.map(([row]) => row);
      return { ...spec, initialSide, cadence };
    } finally { observer?.stop(); p.destroy(); }
  };
  const results = [];
  for (let i = 0; i < cases.length; i += 4) results.push(...await Promise.all(cases.slice(i, i + 4).map(run)));
  return results;
};

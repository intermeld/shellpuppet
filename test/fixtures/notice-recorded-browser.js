window.replayRecordedNotice = async (mode, rows, recorded, repeats = 1) => {
  const p = makeNoticePane(mode, rows);
  let observer;
  try {
    await p.move(rows - 2); p.show(); await noticePause(1100);
    const epoch = performance.now();
    observer = observeDeliveredNotice(p.term, p.notices, epoch);
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const leg of recorded.legs) {
        const row = leg.row === 148 ? rows - 2 : leg.row === 75 ? Math.floor(rows / 2) : leg.row;
        await noticePause(Math.max(0, epoch + repeat * recorded.end + leg.start - performance.now()));
        await p.move(row);
      }
    }
    await noticePause(Math.max(0, epoch + repeats * recorded.end - performance.now()));
    return { mode, rows, repeats, cadence: observer.stop() };
  } finally { observer?.stop(); p.destroy(); }
};

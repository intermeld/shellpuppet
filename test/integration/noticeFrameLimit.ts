/** Slow delivered animation frames in headless Chromium for notice tests. */
export const noticeFrameLimitScript = `(() => {
  const busyMs = ${JSON.stringify(Number(process.env['NOTICE_FRAME_BUSY_MS'] ?? 0))};
  const intervalMs = ${JSON.stringify(Number(process.env['NOTICE_FRAME_INTERVAL_MS'] ?? 0))};
  if (intervalMs > 0) {
    const nativeFrame = requestAnimationFrame.bind(window);
    const callbacks = new Map();
    let nextId = 0, last = null;
    const deliver = time => {
      if (last === null || time - last >= intervalMs - 2) {
        last = time;
        const ready = [...callbacks.values()];
        callbacks.clear();
        for (const callback of ready) callback(time);
      }
      nativeFrame(deliver);
    };
    nativeFrame(deliver);
    window.requestAnimationFrame = callback => {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = id => { callbacks.delete(id); };
  }
  if (busyMs <= 0) return;
  requestAnimationFrame(function slowFrame() {
    const end = performance.now() + busyMs;
    while (performance.now() < end) { /* keep this frame busy */ }
    requestAnimationFrame(slowFrame);
  });
})()`;

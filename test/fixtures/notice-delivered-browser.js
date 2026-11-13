// Observe delivered cursor legs and placement without driving pane layout.
window.observeDeliveredNotice = (term, notices, startedAt = performance.now(), firstRow) => {
  let epoch = startedAt;
  const legs = [], samples = [];
  const rect = element => HTMLElement.prototype.getBoundingClientRect.call(element);
  const screen = rect(term.element.querySelector('.xterm-screen'));
  const cell = screen.height / term.rows, height = rect(notices).height;
  let frame, interval, stopped = false, deadlineFrames = 0, stayEdge = null, stayStart = 0;
  const addLeg = row => {
    const start = performance.now() - epoch;
    if (legs.length) legs.at(-1).end = start;
    const top = row * cell < height - 0.01;
    const bottom = (term.rows - row - 1) * cell < height - 0.01;
    const edge = top ? 'top' : bottom ? 'bottom' : null;
    if (edge !== stayEdge) { stayEdge = edge; stayStart = start; deadlineFrames = 0; }
    legs.push({ row, start, end: null, top, bottom });
  };
  const sample = (deadline = false, evaluation = false) => {
    if (!legs.length) return;
    const time = performance.now() - epoch, row = term.buffer.active.cursorY;
    const box = rect(notices);
    samples.push({ time, row, side: notices.style.top === 'auto' ? 'bottom' : 'top',
      leg: legs.length - 1, deadline, evaluation,
      covered: box.top < screen.top + (row + 1) * cell && box.bottom > screen.top + row * cell });
  };
  const quietFrame = () => {
    const leg = legs.at(-1);
    const due = stayEdge !== null && deadlineFrames < 2 && performance.now() - epoch - stayStart >= 1000;
    frame = requestAnimationFrame(quietFrame);
    if (due) {
      deadlineFrames++;
      // Sample after the completed frame, including placement callbacks in
      // its rAF batch. The assessor allows this frame and checks the next.
      setTimeout(() => { if (!stopped && legs.at(-1) === leg) sample(true); }, 0);
    }
  };
  const arm = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(quietFrame);
  };
  if (firstRow === undefined) {
    addLeg(term.buffer.active.cursorY);
    legs[0].start = 0;
    arm(); sample();
  }
  const subscription = term.onCursorMove(() => {
    const row = term.buffer.active.cursorY;
    if (!legs.length) {
      if (row !== firstRow) return;
      epoch = performance.now(); addLeg(row); arm(); sample(); return;
    }
    if (row === legs.at(-1).row) return;
    addLeg(row); arm(); sample();
  });
  interval = setInterval(sample, 4);
  // Observe every placement evaluation, including assignments of the same
  // value. MutationObserver alone omits those in Chromium.
  const style = notices.style;
  Object.defineProperty(style, 'bottom', { configurable: true,
    get() { return style.getPropertyValue('bottom'); },
    set(value) { style.setProperty('bottom', value); sample(false, true); } });
  return { peek() { return { legs, samples }; }, stop() {
    if (!stopped) {
      stopped = true;
      sample(); if (legs.length) legs.at(-1).end = performance.now() - epoch;
      clearInterval(interval); cancelAnimationFrame(frame); subscription.dispose(); delete style.bottom;
    }
    return { legs, samples, end: legs.at(-1)?.end ?? 0 };
  } };
};

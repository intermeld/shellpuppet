/** Assign ordered sessions to windows up to each window's readable grid capacity. */
(() => {
  'use strict';
  const readable = (width, height, count) => {
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    return width / columns >= MIN_PANE_WIDTH && height / rows >= MIN_PANE_HEIGHT;
  };
  const MIN_PANE_WIDTH = 652;
  const MIN_PANE_HEIGHT = 446;
  const MIN_STRIP_WIDTH = 300;
  const capacity = (width, height) => {
    let count = 0;
    while (count < 32 && readable(width, height, count + 1)) count += 1;
    return count;
  };
  const allocate = (total, capacities) => {
    const counts = capacities.map(() => 0);
    let next = 0;
    for (let index = 0; index < capacities.length; index++) {
      counts[index] = Math.min(capacities[index], total - next);
      next += counts[index];
    }
    const eligible = capacities.some((value) => value > 0)
      ? capacities.map((value, index) => value > 0 ? index : -1).filter((index) => index >= 0)
      : capacities.map((_, index) => index);
    while (next < total && eligible.length > 0) {
      let target = eligible[0];
      for (const index of eligible.slice(1)) {
        const left = counts[index] / Math.max(1, capacities[index]);
        const right = counts[target] / Math.max(1, capacities[target]);
        if (left < right) target = index;
      }
      counts[target]++;
      next++;
    }
    return counts;
  };
  const assign = (ids, windows) => {
    const result = {};
    if (windows.length === 0) return result;
    const counts = allocate(ids.length, windows.map((window) => capacity(window.width, window.height)));
    let next = 0;
    for (const [index, window] of windows.entries()) {
      result[window.id] = ids.slice(next, next + counts[index]);
      next += counts[index];
    }
    return result;
  };
  globalThis.ShellPuppetDashboardLayout = { assign, capacity, allocate,
    MIN_PANE_WIDTH, MIN_PANE_HEIGHT, MIN_STRIP_WIDTH };
})();

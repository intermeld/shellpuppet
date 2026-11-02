/** Assign ordered sessions to windows up to each window's readable grid capacity. */
(() => {
  'use strict';
  const readable = (width, height, count) => {
    const columns = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / columns);
    return width / columns >= 652 && height / rows >= 446;
  };
  const capacity = (width, height) => {
    let count = 0;
    while (count < 32 && readable(width, height, count + 1)) count += 1;
    return count;
  };
  const assign = (ids, windows) => {
    const result = {};
    if (windows.length === 0) return result;
    const capacities = windows.map((window) => capacity(window.width, window.height));
    const counts = capacities.map(() => 0);
    let next = 0;
    for (let index = 0; index < windows.length; index++) {
      counts[index] = Math.min(capacities[index], ids.length - next);
      next += counts[index];
    }
    while (next < ids.length) {
      let target = 0;
      for (let index = 1; index < windows.length; index++) {
        const left = counts[index] / Math.max(1, capacities[index]);
        const right = counts[target] / Math.max(1, capacities[target]);
        if (left < right) target = index;
      }
      counts[target]++;
      next++;
    }
    next = 0;
    for (const [index, window] of windows.entries()) {
      result[window.id] = ids.slice(next, next + counts[index]);
      next += counts[index];
    }
    return result;
  };
  globalThis.ShellPuppetDashboardLayout = { assign, capacity };
})();

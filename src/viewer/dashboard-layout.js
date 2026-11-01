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
    let next = 0;
    for (const [index, window] of windows.entries()) {
      const count = index === windows.length - 1 ? Math.max(0, ids.length - next) : capacity(window.width, window.height);
      result[window.id] = ids.slice(next, next + count);
      next += count;
    }
    return result;
  };
  globalThis.ShellPuppetDashboardLayout = { assign, capacity };
})();

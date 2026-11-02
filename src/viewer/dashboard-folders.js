/** Recent choices and ordering for the dashboard launcher. */
(() => {
  'use strict';
  function remember(recent, profile, choice) {
    const before = Array.isArray(recent[profile]) ? recent[profile] : [];
    return { ...recent, [profile]: [choice, ...before.filter((item) => item !== choice)].slice(0, 5) };
  }
  function order(offered, recent, profile) {
    const before = Array.isArray(recent[profile]) ? recent[profile] : [];
    const rank = new Map(before.map((value, index) => [value, index]));
    return [...offered].sort((a, b) => (rank.get(a.value) ?? 100) - (rank.get(b.value) ?? 100));
  }
  globalThis.ShellPuppetDashboardFolders = { remember, order };
})();

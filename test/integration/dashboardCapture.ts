/** Test-only diagnostics for a dashboard whose renderer stalls on CI. */
import { captureViewer } from '../../src/daemon/screenshot.js';
import type { CaptureOptions } from '../../src/daemon/screenshot.js';

export const dashboardDiagnosticsScript = `(() => {
  const state = window.__dashboardDiagnostics = {
    arrangements: 0, visibilityPasses: 0, pendingFrames: 0,
    pendingAnimationFrames: 0, arrangeTriggers: [], longTasks: 0, longestTaskMs: 0,
    streams: [], paneCounts: []
  };
  document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('panes');
    if (!root) return;
    const record = () => {
      const count = root.querySelectorAll('.pane').length;
      if (count > 0 && state.paneCounts.at(-1) !== count) state.paneCounts.push(count);
    };
    new MutationObserver(record).observe(root, { childList: true, subtree: true });
    record();
  });
  const nativeFrame = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const outstanding = new Set();
  window.requestAnimationFrame = (callback) => {
    let id;
    id = nativeFrame((time) => { outstanding.delete(id); state.pendingAnimationFrames = outstanding.size; callback(time); });
    outstanding.add(id);
    state.pendingAnimationFrames = outstanding.size;
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    outstanding.delete(id); state.pendingAnimationFrames = outstanding.size;
    return nativeCancel(id);
  };
  const NativeSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeSocket, {
    construct(Target, args) {
      const socket = new Target(...args);
      state.streams.push({ url: String(args[0]), socket });
      return socket;
    }
  });
  try {
    new PerformanceObserver((list) => {
      for (const task of list.getEntries()) {
        state.longTasks++;
        state.longestTaskMs = Math.max(state.longestTaskMs, Math.round(task.duration));
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* Browser without long-task entries. */ }
})()`;

export const dashboardTimeoutProbe = `(() => {
  const d = window.__dashboardDiagnostics;
  if (!d) return { loaded: false };
  const cards = [...document.querySelectorAll('#panes .pane')];
  return {
    arrangements: d.arrangements, visibilityPasses: d.visibilityPasses,
    pendingFrames: d.pendingFrames, pendingAnimationFrames: d.pendingAnimationFrames,
    paneCount: cards.length,
    paneCounts: d.paneCounts,
    visiblePanes: cards.filter(card => {
      const box = card.getBoundingClientRect();
      const parent = card.parentElement?.id === 'strip' ? card.parentElement : document.getElementById('panes');
      const viewport = parent?.getBoundingClientRect();
      return viewport && box.width > 0 && box.height > 0 &&
        box.bottom > viewport.top && box.top < viewport.bottom &&
        box.right > viewport.left && box.left < viewport.right;
    }).map(card => card.dataset.session),
    openStreams: d.streams.filter(entry => entry.socket.readyState === 1).map(entry => entry.url),
    openPaneStreams: d.streams.filter(entry => entry.socket.readyState === 1 && entry.url.includes('/stream'))
      .map(entry => entry.url),
    streamCount: d.streams.length, arrangeTriggers: d.arrangeTriggers,
    longTasks: d.longTasks, longestTaskMs: d.longestTaskMs,
    trace: window.__dashboardTrace || null,
    feedProbe: window.__feedProbe || null, loopProbe: window.__loopProbe || null
  };
})()`;

export function captureDashboard(options: CaptureOptions): ReturnType<typeof captureViewer> {
  const rate = Number(process.env['SP_DASHBOARD_CPU_RATE'] || '1');
  return captureViewer({
    ...options,
    beforeNavigateScript: `${dashboardDiagnosticsScript};\n${options.beforeNavigateScript || ''}`,
    timeoutProbe: dashboardTimeoutProbe,
    ...(rate > 1 ? { cpuThrottlingRate: rate } : {}),
  });
}

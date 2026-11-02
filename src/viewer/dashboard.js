/** The dashboard's feed, arrangement, launch controls and human controls. */
/* global ShellPuppetPane, ShellPuppetDashboardLayout, ShellPuppetDashboardFolders */
(() => {
  'use strict';

  const proof = document.querySelector('meta[name="sp-csrf"]')?.content || '';
  const root = document.getElementById('panes');
  const empty = document.getElementById('empty');
  const error = document.getElementById('error');
  const connection = document.getElementById('connection');
  const attentionCount = document.getElementById('attention-count');
  const shareCount = document.getElementById('share-count');
  const profileSelect = document.getElementById('profile');
  const folderField = document.getElementById('folder-field');
  const folderSelect = document.getElementById('folder');
  const folderFilter = document.getElementById('folder-filter');
  const recentFolders = document.getElementById('recent-folders');
  const boundedFolder = document.getElementById('bounded-folder');
  const anyFolder = document.getElementById('any-folder');
  const folderPath = document.getElementById('folder-path');
  const folderPathOptions = document.getElementById('folder-path-options');
  const browseFolder = document.getElementById('browse-folder');
  const launcher = document.getElementById('launcher');
  const watchOnly = document.getElementById('watch-only');
  const profileProblems = document.getElementById('profile-problems');
  const main = document.createElement('div');
  const strip = document.createElement('div');
  main.id = 'main-pane';
  strip.id = 'strip';
  const panes = new Map();
  const PREF = 'shellpuppet.dashboard';
  const LAUNCH_PREF = 'shellpuppet.dashboard.launches';
  const RECENT_PREF = 'shellpuppet.dashboard.recentFolders';
  const NAME = /^[a-z][a-z0-9-]{0,31}$/;
  let saved = {};
  try { saved = JSON.parse(window.localStorage.getItem(PREF) || '{}') || {}; } catch { /* Preferences are optional. */ }
  let order = Array.isArray(saved.order) ? saved.order.filter((id) => typeof id === 'string') : [];
  let pins = Array.isArray(saved.pins) ? saved.pins.filter((id) => typeof id === 'string') : [];
  let mode = ['auto', 'grid', 'focus'].includes(saved.mode) ? saved.mode : 'auto';
  let autoFit = saved.autoFit !== false;
  const configuredFont = Number(document.querySelector('meta[name="sp-dashboard-font-size"]')?.content);
  let fontSize = Number.isInteger(saved.fontSize) && saved.fontSize >= 8 && saved.fontSize <= 32
    ? saved.fontSize : saved.fontSize === null ? null
      : Number.isInteger(configuredFont) && configuredFont >= 8 && configuredFont <= 32 ? configuredFont : null;
  let autoFitTimer = null;
  const focusOpenFits = new Set();
  const incomingFits = new Set();
  let prefix = typeof saved.prefix === 'string' && /^[a-z]$/.test(saved.prefix) ? saved.prefix : 'a';
  let choosingPrefix = false;
  let selected = null;
  let focusId = null;
  let enlarged = null;
  let navigation = false;
  let feed = null;
  let retry = null;
  let profiles = [];
  /** Sessions this page started: profile name and, where used, folder name. */
  let launches = loadLaunches();
  let recent = {};
  try { recent = JSON.parse(window.localStorage.getItem(RECENT_PREF) || '{}') || {}; } catch { recent = {}; }
  /** Panes another window holds, hidden from this grid until that window closes. */
  const popped = new Set();
  /** This document is the pop-out window for one session, or null. */
  const popSelf = popTarget();
  const dismissed = new Set();
  const pendingOpen = new Map();
  const popWatches = new Map();
  const windowToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const openedAt = window.performance.timeOrigin + window.performance.now();
  const screenParams = new URLSearchParams(location.hash.slice(1));
  const windowId = screenParams.get('screen') || windowToken;
  const windowRank = screenParams.has('screen') ? Number(screenParams.get('rank')) || 1000 : 0;
  const screenKey = screenParams.get('key');
  let currentScreenKey = screenKey;
  const windows = new Map();
  const lastSeen = new Map();
  const childWatches = new Map();
  let rosterTimer = null;
  let windowLeft = false;
  let assigned = screenParams.has('screen') ? new Set() : null;
  let screens = [];
  let watchedScreens = null;
  let screenState = 'unavailable';
  let nextFallback = 0;
  let arranging = false;
  let syncingVisibility = false;
  let pendingArrange = false;
  let pendingVisibility = false;
  let followUpFrame = false;
  const diagnostics = window.__dashboardDiagnostics;
  function traceArrange(trigger) {
    if (!diagnostics) return;
    diagnostics.arrangeTriggers.push({ at: Math.round(window.performance.now()), trigger });
    if (diagnostics.arrangeTriggers.length > 20) diagnostics.arrangeTriggers.shift();
  }
  let lastLayout = null;
  let lastStructure = null;
  let lastVisibilityGeometry = null;
  if (popSelf === null) windows.set(windowId, { id: windowId, rank: windowRank, openedAt, key: screenKey,
    width: window.innerWidth - 12, height: window.innerHeight - 54 });
  let channel = null;
  try { channel = new BroadcastChannel('shellpuppet.dashboard'); } catch { /* This window still tracks a pop-out it opened. */ }

  function popTarget() {
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    const match = /^pop=(.+)$/.exec(hash);
    if (match === null) return null;
    try { return decodeURIComponent(match[1] ?? ''); } catch { return null; }
  }

  function loadLaunches() {
    let raw;
    try { raw = JSON.parse(window.localStorage.getItem(LAUNCH_PREF) || '{}') || {}; } catch { return {}; }
    if (typeof raw !== 'object' || raw === null) return {};
    const out = {};
    for (const [id, value] of Object.entries(raw)) {
      if (typeof value !== 'object' || value === null || typeof value.profile !== 'string' || !NAME.test(value.profile)) continue;
      const entry = { profile: value.profile };
      if (typeof value.folder === 'string' && value.folder.length > 0 && !/[\\/:]/.test(value.folder) && !Array.from(value.folder).some((char) => char.charCodeAt(0) < 32) && value.folder !== '..') entry.folder = value.folder;
      if (Number.isInteger(value.rootIndex) && value.rootIndex >= 0) entry.rootIndex = value.rootIndex;
      if (typeof value.folderPath === 'string' && value.folderPath !== '') entry.folderPath = value.folderPath;
      out[id] = entry;
    }
    return out;
  }

  const persist = () => {
    try { window.localStorage.setItem(PREF, JSON.stringify({ mode, order, pins, prefix, autoFit, fontSize })); } catch { /* Layout still works. */ }
  };
  const persistLaunches = () => {
    try { window.localStorage.setItem(LAUNCH_PREF, JSON.stringify(launches)); } catch { /* Restart still works in this document. */ }
  };
  const showPrefix = () => {
    document.getElementById('shortcut').textContent = `Shortcut: Ctrl+Shift+${prefix.toUpperCase()}`;
    document.getElementById('shortcut-help').textContent = `Ctrl+Shift+${prefix.toUpperCase()}`;
  };
  const sorted = () => order.map((id) => panes.get(id)).filter(Boolean);
  /** Panes this window holds after the roster's assignment. */
  const shown = () => sorted().filter((item) => {
    if (popSelf !== null) return item.id === popSelf;
    return !popped.has(item.id) && (orderedWindows().length === 1 || assigned?.has(item.id));
  });
  function renderShareCount() {
    if (popSelf !== null) { shareCount.hidden = true; return; }
    const total = sorted().filter((item) => !popped.has(item.id)).length;
    const here = shown().length;
    const count = orderedWindows().length;
    shareCount.textContent = `${here} of ${total} here, ${count} ${count === 1 ? 'window' : 'windows'}`;
  }
  const closeError = () => { error.hidden = true; document.getElementById('error-message').textContent = ''; };
  const showError = (message) => { document.getElementById('error-message').textContent = message; error.hidden = false; };
  function closeVisibleError() {
    if (!error.hidden) { closeError(); return true; }
    const focusedCard = document.activeElement?.closest('.pane');
    const focused = focusedCard ? panes.get(focusedCard.dataset.session) : null;
    const item = [focused, panes.get(selected), ...shown()].find((pane) => pane && visible(pane) && !pane.banner.hidden);
    if (!item) return false;
    item.banner.hidden = true;
    return true;
  }
  function renderPreferences() {
    document.getElementById('auto-fit').setAttribute('aria-pressed', String(autoFit));
    document.getElementById('auto-fit').classList.toggle('active', autoFit);
    document.getElementById('text-auto').textContent = fontSize === null ? 'Auto text' : `${fontSize} px`;
    document.getElementById('text-auto').classList.toggle('active', fontSize === null);
  }
  function scheduleAutoFit() {
    clearTimeout(autoFitTimer);
    if (!autoFit) { focusOpenFits.clear(); return; }
    autoFitTimer = setTimeout(() => {
      autoFitTimer = null;
      for (const item of shown()) {
        if (!visible(item)) continue;
        if (item.client?.autoFitGrid(80, 24, focusOpenFits.has(item.id) || incomingFits.has(item.id))) {
          focusOpenFits.delete(item.id);
          incomingFits.delete(item.id);
        }
      }
    }, 250);
  }
  function broadcastPreferences() {
    channel?.postMessage({ type: 'preferences', autoFit, fontSize, token: windowToken });
  }
  function setFontSize(value, broadcast = true) {
    fontSize = value;
    for (const item of panes.values()) item.client?.setFontOverride(value);
    renderPreferences(); persist(); scheduleAutoFit();
    if (broadcast) broadcastPreferences();
  }
  const makeButton = (label, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', (event) => { event.stopPropagation(); action(); });
    return button;
  };

  const screenIdentity = (screen) => [screen.availLeft, screen.availTop,
    screen.availWidth, screen.availHeight].join(',');
  const orderedWindows = () => [...windows.values()].filter((entry) => entry.ready !== false)
    .sort((a, b) => a.rank - b.rank || a.openedAt - b.openedAt || a.id.localeCompare(b.id));
  const ownWindow = () => ({ id: windowId, rank: windowRank, openedAt, key: currentScreenKey,
    width: Math.max(1, root.clientWidth - 12), height: Math.max(1, root.clientHeight - 12) });
  function advertise() {
    if (popSelf !== null || channel === null) return;
    windows.set(windowId, ownWindow());
    lastSeen.set(windowId, Date.now());
    channel.postMessage({ type: 'window-roster', window: ownWindow(), token: windowToken });
  }
  function applyAssignment(ids) {
    const next = new Set(ids);
    if (assigned !== null && next.size === assigned.size && [...next].every((id) => assigned.has(id))) return;
    const previous = assigned === null ? new Set() : assigned;
    assigned = next;
    for (const id of next) if (!previous.has(id)) incomingFits.add(id);
    for (const id of previous) if (!next.has(id)) incomingFits.delete(id);
    arrange('assignment');
  }
  function publishAssignment() {
    if (popSelf !== null) return;
    windows.set(windowId, ownWindow());
    const roster = orderedWindows();
    if (roster[0]?.id !== windowId) return;
    const ids = sorted().map((item) => item.id).filter((id) => !popped.has(id));
    if (roster.length === 1) { assigned = null; renderShareCount(); return; }
    if (channel === null) return;
    const byWindow = ShellPuppetDashboardLayout.assign(ids, roster);
    channel.postMessage({ type: 'window-assignment', owner: windowId, byWindow, token: windowToken });
    applyAssignment(byWindow[windowId] || []);
  }
  function removeWindow(id) {
    if (!windows.delete(id)) return;
    lastSeen.delete(id);
    const watch = childWatches.get(id);
    if (watch !== undefined) { clearInterval(watch); childWatches.delete(id); }
    renderScreens();
    arrange('window removed');
    renderShareCount();
  }
  function openDashboard(hash, name, features) {
    const child = window.open(`${location.origin}/dashboard${hash}`, name, features);
    if (child === null) showError('The browser blocked the window. Press the button again.');
    return child;
  }
  function openScreen(screen, screenRank) {
    const id = `${windowToken}-${++nextFallback}`;
    const key = screen === null ? null : screenIdentity(screen);
    const rank = screen === null ? Date.now() * 1000 + nextFallback % 1000 : screenRank;
    const hash = new URLSearchParams({ screen: id, rank: String(rank),
      ...(key === null ? {} : { key, left: String(screen.availLeft), top: String(screen.availTop),
        width: String(screen.availWidth), height: String(screen.availHeight) }) });
    const features = screen === null ? 'popup' :
      `popup,left=${screen.availLeft},top=${screen.availTop},width=${screen.availWidth},height=${screen.availHeight}`;
    const child = openDashboard(`#${hash}`, `shellpuppet-screen-${id}`, features);
    if (child === null) return;
    windows.set(id, { id, rank, openedAt: Date.now(), key, ready: false });
    lastSeen.set(id, Date.now());
    renderScreens();
    publishAssignment();
    childWatches.set(id, setInterval(() => { if (child.closed) removeWindow(id); }, 500));
  }
  function renderScreens() {
    const control = document.getElementById('screens');
    control.textContent = '';
    if (popSelf !== null) return;
    if (screenState === 'prompt') {
      control.append(makeButton('Allow screens', async () => {
        control.querySelector('button').disabled = true;
        try {
          const details = await window.getScreenDetails();
          screenState = 'granted';
          watchScreens(details);
        } catch { screenState = 'denied'; renderScreens(); }
      }));
    } else if (screenState === 'granted') {
      screens.forEach(({ screen, rank }) => {
        if ([...windows.values()].some((entry) => entry.key === screenIdentity(screen))) return;
        control.append(makeButton(`Open on screen ${rank}`, () => openScreen(screen, rank)));
      });
    } else control.append(makeButton('Open another window', () => openScreen(null, 0)));
  }
  function setScreens(details) {
    const current = details.currentScreen || details.screens.find((screen) => screen.isPrimary) || details.screens[0];
    currentScreenKey = current ? screenIdentity(current) : screenKey;
    screens = details.screens.map((screen, index) => ({ screen, rank: index + 1 }))
      .filter((entry) => screenIdentity(entry.screen) !== screenIdentity(current));
    advertise();
    renderScreens();
  }
  function refreshScreens() {
    if (watchedScreens !== null) setScreens(watchedScreens);
  }
  function watchScreens(details) {
    if (watchedScreens !== details) {
      watchedScreens?.removeEventListener?.('currentscreenchange', refreshScreens);
      watchedScreens?.removeEventListener?.('screenschange', refreshScreens);
      watchedScreens = details;
      details.addEventListener?.('currentscreenchange', refreshScreens);
      details.addEventListener?.('screenschange', refreshScreens);
    }
    setScreens(details);
  }
  async function discoverScreens() {
    if (popSelf !== null || !navigator.permissions?.query) {
      renderScreens(); return;
    }
    try {
      const permission = await navigator.permissions.query({ name: 'window-management' });
      if (!window.getScreenDetails) { renderScreens(); return; }
      screenState = permission.state;
      if (screenState === 'granted') watchScreens(await window.getScreenDetails());
      else renderScreens();
    } catch { screenState = 'unavailable'; renderScreens(); }
  }

  function rememberLaunch(id, profile, folder, rootIndex, chosenPath, recentPath) {
    if (typeof id !== 'string' || !NAME.test(profile)) return;
    const entry = { profile };
    if (typeof folder === 'string' && folder !== '') entry.folder = folder;
    if (Number.isInteger(rootIndex) && rootIndex >= 0) entry.rootIndex = rootIndex;
    if (typeof chosenPath === 'string' && chosenPath !== '') entry.folderPath = chosenPath;
    launches[id] = entry;
    persistLaunches();
    if (entry.folder || entry.folderPath) {
      const key = recentPath || entry.folderPath || (entry.rootIndex === undefined ? entry.folder : `root:${entry.rootIndex}:${entry.folder}`);
      recent = ShellPuppetDashboardFolders.remember(recent, profile, key);
      try { window.localStorage.setItem(RECENT_PREF, JSON.stringify(recent)); } catch { /* Recent folders remain available here. */ }
      renderFolders();
    }
  }

  function launchBody(entry) {
    if (!entry || typeof entry.profile !== 'string') return null;
    const body = { profile: entry.profile };
    if (typeof entry.folder === 'string' && entry.folder !== '') body.folder = entry.folder;
    if (Number.isInteger(entry.rootIndex) && entry.rootIndex >= 0) body.rootIndex = entry.rootIndex;
    if (typeof entry.folderPath === 'string' && entry.folderPath !== '') body.folderPath = entry.folderPath;
    return body;
  }

  function createCard(summary) {
    const card = document.createElement('section');
    card.className = 'pane';
    card.dataset.session = summary.id;
    card.tabIndex = 0;
    const head = document.createElement('div');
    head.className = 'pane-head';
    head.title = 'Double-click the title bar to Enlarge or Restore; outside the terminal, Escape closes an error first, then restores';
    const label = document.createElement('span');
    label.className = 'pane-label';
    const purpose = document.createElement('span');
    purpose.className = 'pane-purpose hint';
    const badge = document.createElement('span');
    badge.className = 'badge';
    const state = document.createElement('span');
    state.className = 'pane-state hint';
    const space = document.createElement('span');
    space.className = 'spacer';
    const size = document.createElement('span');
    size.className = 'pane-size';
    const overflowNote = document.createElement('div');
    overflowNote.className = 'pane-overflow-note';
    overflowNote.textContent = 'Shift+wheel or drag the scrollbars to see the rest. Enlarge or Fit to show it whole.';
    overflowNote.hidden = true;
    const item = { id: summary.id, summary, card, label, purpose, badge, state, size, overflowNote, client: null, previousGrid: null };
    item.fit = makeButton('Fit', () => { select(item.id); item.client?.fitGrid(); });
    item.enlarge = makeButton('Enlarge', () => {
      select(item.id);
      if (enlarged === item.id) {
        enlarged = null;
        arrange('restore');
        if (!autoFit && item.previousGrid) item.client?.takeGrid(item.previousGrid.cols, item.previousGrid.rows);
        item.previousGrid = null;
      } else {
        item.previousGrid = item.client?.getGrid() || null;
        enlarged = item.id;
        arrange('enlarge');
        if (!autoFit) window.requestAnimationFrame(() => item.client?.fitGrid());
      }
    });
    item.pin = makeButton('Pin', () => {
      pins = pins.includes(item.id) ? pins.filter((id) => id !== item.id) : [...pins, item.id];
      persist(); arrange('pin');
    });
    item.left = makeButton('Move left', () => move(item.id, -1));
    item.right = makeButton('Move right', () => move(item.id, 1));
    item.menuButton = makeButton('Menu', () => { item.menu.hidden = !item.menu.hidden; });
    const menu = document.createElement('div');
    menu.className = 'pane-menu';
    menu.hidden = true;
    item.kill = makeButton('Kill', () => { void killSession(item.id); });
    item.kill.dataset.action = 'kill';
    item.copy = makeButton('Copy session id', () => { void copySessionId(item.id); });
    item.copy.dataset.action = 'copy';
    item.pop = makeButton('Pop out', () => popOut(item.id));
    item.pop.dataset.action = 'pop';
    item.restart = makeButton('Restart', () => { void restartSession(item.id); });
    item.restart.dataset.action = 'restart';
    item.dismiss = makeButton('Dismiss', () => dismiss(item.id));
    item.dismiss.dataset.action = 'dismiss';
    menu.append(item.kill, item.copy, item.pop, item.restart, item.dismiss);
    item.menu = menu;
    head.append(label, purpose, badge, state, space, size, item.fit, item.enlarge,
      item.pin, item.left, item.right, item.menuButton);
    head.addEventListener('dblclick', (event) => {
      if (!event.target.closest('button')) item.enlarge.click();
    });
    const wrap = document.createElement('div');
    wrap.className = 'pane-wrap';
    const term = document.createElement('div');
    term.className = 'pane-term';
    const notices = document.createElement('div');
    notices.className = 'pane-notices';
    const banner = document.createElement('div');
    banner.className = 'pane-banner';
    banner.hidden = true;
    const bannerMessage = document.createElement('span');
    bannerMessage.className = 'pane-banner-message';
    banner.append(bannerMessage, makeButton('Close pane error', () => {
      const hadFocus = banner.contains(document.activeElement);
      banner.hidden = true;
      // A hidden button cannot hold visible focus: give it to the pane.
      if (hadFocus) card.focus();
    }));
    const prompt = document.createElement('div');
    prompt.className = 'pane-prompt';
    prompt.hidden = true;
    notices.append(banner, prompt);
    wrap.append(term, notices);
    card.append(head, menu, overflowNote, wrap);
    Object.assign(item, { term, banner, prompt });
    card.addEventListener('click', () => select(item.id, true));
    card.addEventListener('focus', () => select(item.id));
    updateCard(item);
    return item;
  }

  function updateCard(item) {
    const summary = item.summary;
    item.label.textContent = summary.label || summary.id;
    item.purpose.textContent = summary.purpose || '';
    item.badge.textContent = attention(item) ? '● Waiting' : '';
    item.card.classList.toggle('attention', attention(item));
    item.card.classList.toggle('selected', selected === item.id);
    item.card.classList.toggle('ended', summary.exited === true);
    item.state.textContent = summary.exited !== true ? ''
      : summary.exitCode === null || summary.exitCode === undefined
        ? 'Ended: its output failed'
        : `Ended (code ${String(summary.exitCode)})`;
    item.pin.textContent = pins.includes(item.id) ? 'Unpin' : 'Pin';
    item.enlarge.textContent = enlarged === item.id ? 'Restore' : 'Enlarge';
    item.pin.setAttribute('aria-label', item.pin.textContent);
    item.enlarge.setAttribute('aria-label', item.enlarge.textContent);
    item.restart.hidden = launchBody(launches[item.id]) === null;
    item.dismiss.hidden = summary.exited !== true;
    item.pop.hidden = popSelf === item.id;
    item.card.setAttribute('aria-label', `${item.label.textContent} ${item.purpose.textContent}`);
  }
  function attention(item) {
    const prompt = item.summary.waitingOnPrompt;
    return Boolean(prompt && prompt.waitingMs >= 20_000);
  }
  function updateAttention() {
    for (const item of panes.values()) updateCard(item);
    const count = sorted().filter(attention).length;
    attentionCount.textContent = count ? `${count} waiting` : '';
    const focus = panes.get(selected);
    document.title = `${count ? `${count} waiting · ` : ''}${focus?.label.textContent || 'Dashboard'} · ShellPuppet`;
  }
  function select(id, focusTerminal = false) {
    if (!panes.has(id)) return;
    selected = id;
    updateAttention();
    if (focusTerminal) panes.get(id).client?.getTerminal().focus();
  }
  function move(id, delta) {
    const index = order.indexOf(id);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    persist(); arrange('move');
  }
  function activate(item) {
    const width = item.term.clientWidth;
    const height = item.term.clientHeight;
    if (item.client) {
      if (item.clientWidth !== width || item.clientHeight !== height) {
        item.clientWidth = width;
        item.clientHeight = height;
        item.client.relayout(false);
      }
      return;
    }
    item.clientWidth = width;
    item.clientHeight = height;
    item.client = ShellPuppetPane.create({
      container: item.term, sessionId: item.id, dashboardProof: proof,
      initialFontOverride: fontSize,
      elements: { banner: item.banner, promptAlert: item.prompt, size: item.size, overflowNote: item.overflowNote },
      onAttentionChange: () => updateAttention(),
      onGeometryReady: () => scheduleAutoFit(),
      onOutsideGeometry: () => scheduleAutoFit(),
    });
  }
  function deactivate(item) {
    if (!item.client) return;
    const client = item.client;
    item.client = null;
    client.destroy();
    item.term.textContent = '';
  }
  function visible(item) {
    if (popSelf !== null) return item.id === popSelf && item.card.isConnected;
    if (popped.has(item.id)) return false;
    if (enlarged && item.id !== enlarged) return false;
    const box = item.card.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const container = item.card.parentElement === strip ? strip.getBoundingClientRect() : root.getBoundingClientRect();
    return box.bottom > container.top && box.top < container.bottom && box.right > container.left && box.left < container.right;
  }
  function queueFollowUp() {
    if (followUpFrame) return;
    followUpFrame = true;
    if (diagnostics) diagnostics.pendingFrames++;
    window.requestAnimationFrame(() => {
      followUpFrame = false;
      if (diagnostics) diagnostics.pendingFrames--;
      if (pendingArrange) {
        pendingArrange = false;
        arrange('follow-up');
      }
      if (pendingVisibility) {
        pendingVisibility = false;
        syncVisibility();
      }
    });
  }
  function syncVisibility() {
    if (syncingVisibility) {
      pendingVisibility = true;
      queueFollowUp();
      return;
    }
    const stripBox = strip.getBoundingClientRect();
    const geometry = JSON.stringify([lastLayout, strip.scrollTop, strip.clientWidth, strip.clientHeight,
      strip.scrollHeight, stripBox.top, stripBox.bottom]);
    if (geometry === lastVisibilityGeometry) return;
    syncingVisibility = true;
    if (diagnostics) diagnostics.visibilityPasses++;
    if (window.__dashboardTrace) {
      window.__dashboardTrace.visibility++;
      window.__dashboardTrace.visibilityDepth++;
      window.__dashboardTrace.maxVisibilityDepth = Math.max(window.__dashboardTrace.maxVisibilityDepth, window.__dashboardTrace.visibilityDepth);
    }
    try {
      for (const item of panes.values()) {
        if (visible(item)) activate(item);
        else deactivate(item);
      }
      lastVisibilityGeometry = geometry;
    } finally {
      syncingVisibility = false;
      if (window.__dashboardTrace) window.__dashboardTrace.visibilityDepth--;
    }
  }
  function arrange(trigger = 'unspecified') {
    traceArrange(trigger);
    if (arranging || syncingVisibility) {
      pendingArrange = true;
      queueFollowUp();
      return;
    }
    arranging = true;
    if (diagnostics) diagnostics.arrangements++;
    if (window.__dashboardTrace) {
      window.__dashboardTrace.arrangements++;
      window.__dashboardTrace.arrangeDepth++;
      window.__dashboardTrace.maxArrangeDepth = Math.max(window.__dashboardTrace.maxArrangeDepth, window.__dashboardTrace.arrangeDepth);
    }
    try {
      const items = shown();
      renderShareCount();
      const width = root.clientWidth - 12;
      const height = root.clientHeight - 12;
      const columns = Math.ceil(Math.sqrt(items.length));
      const rows = Math.ceil(items.length / Math.max(1, columns));
      const autoGrid = items.length <= 1 || (width / columns >= 652 && height / rows >= 446);
      const layout = popSelf !== null || enlarged ? 'enlarged' : mode === 'auto' ? (autoGrid ? 'grid' : 'focus') : mode;
      const primary = layout === 'focus' ? pins.find((id) => items.some((item) => item.id === id)) ||
        (mode === 'focus' && items.some((item) => item.id === focusId) ? focusId : items[0]?.id) : null;
      const layoutKey = JSON.stringify([items.map((item) => item.id), width, height, layout, mode,
        columns, rows, primary, enlarged, pins]);
      if (layoutKey !== lastLayout) {
        const structureKey = JSON.stringify([items.map((item) => item.id), layout, primary, enlarged]);
        empty.hidden = items.length > 0;
        root.className = layout === 'focus' && items.length === 1 ? 'focus focus-only' : layout;
        root.dataset.layout = layout;
        root.style.setProperty('--columns', String(Math.max(1, columns)));
        root.style.setProperty('--rows', String(Math.max(1, rows)));
        for (const name of ['auto', 'grid', 'focus']) document.getElementById(name).classList.toggle('active', mode === name);
        if (structureKey !== lastStructure) {
          root.textContent = '';
          if (layout === 'grid') {
            for (const item of items) root.append(item.card);
          } else if (layout === 'focus') {
            main.textContent = '';
            strip.textContent = '';
            for (const item of items) (item.id === primary ? main : strip).append(item.card);
            root.append(main, strip);
          } else {
            const item = panes.get(popSelf || enlarged);
            if (item) root.append(item.card);
          }
          lastStructure = structureKey;
        }
        for (const item of items) {
          const measuredWidth = layout === 'grid' ? width / columns
            : item.card.parentElement === strip ? 300
              : layout === 'focus' && items.length > 1 ? width - 300 : width;
          const measuredHeight = layout === 'grid' ? height / rows : item.card.parentElement === strip ? 170 : height;
          item.card.classList.toggle('below-floor', measuredWidth < 652 || measuredHeight < 446);
          updateCard(item);
        }
        lastLayout = layoutKey;
        syncVisibility();
        scheduleAutoFit();
      }
      publishAssignment();
    } finally {
      arranging = false;
      if (window.__dashboardTrace) window.__dashboardTrace.arrangeDepth--;
    }
  }

  function dropLaunch(id) {
    if (launches[id] === undefined) return;
    delete launches[id];
    persistLaunches();
  }

  function reconcile(sessions, full = false) {
    const incoming = new Map(sessions.filter((s) => s && typeof s.id === 'string').map((s) => [s.id, s]));
    // A snapshot is the whole list. An added or removed frame is not, so it
    // must not forget a dismissal or a launch for a session it did not mention.
    if (full) {
      for (const id of [...dismissed]) { if (!incoming.has(id)) dismissed.delete(id); }
      for (const id of [...popped]) { if (!incoming.has(id)) releasePop(id); }
      for (const id of Object.keys(launches)) { if (!incoming.has(id)) dropLaunch(id); }
    }
    for (const [id, item] of panes) {
      if (incoming.has(id) && !dismissed.has(id)) continue;
      deactivate(item); item.card.remove(); panes.delete(id);
    }
    order = order.filter((id) => incoming.has(id) && !dismissed.has(id));
    pins = pins.filter((id) => incoming.has(id) && !dismissed.has(id));
    for (const [id, summary] of incoming) {
      if (dismissed.has(id)) continue;
      if (!panes.has(id)) {
        panes.set(id, createCard(summary));
        // A session the saved order already names keeps that place.
        if (!order.includes(id)) order.push(id);
      } else panes.get(id).summary = summary;
    }
    if (!panes.has(selected)) selected = order.find((id) => panes.has(id)) || null;
    if (!panes.has(focusId)) focusId = null;
    if (!panes.has(enlarged)) enlarged = null;
    persist(); arrange('feed reconcile'); updateAttention();
    for (const id of [...pendingOpen.keys()]) enactOpen(id);
  }
  function receive(frame) {
    if (!frame || typeof frame.type !== 'string') return;
    if (frame.type === 'snapshot' && Array.isArray(frame.sessions)) reconcile(frame.sessions, true);
    else if (frame.type === 'session-added' && frame.session?.id) {
      if (!panes.has(frame.session.id) && !dismissed.has(frame.session.id)) {
        reconcile([...sorted().map((p) => p.summary), frame.session]);
      }
    } else if (frame.type === 'session-updated' && frame.session?.id) {
      const item = panes.get(frame.session.id);
      if (item) { item.summary = frame.session; updateAttention(); }
    } else if (frame.type === 'session-removed' && typeof frame.session === 'string') {
      dismissed.delete(frame.session);
      dropLaunch(frame.session);
      releasePop(frame.session);
      reconcile(sorted().filter((p) => p.id !== frame.session).map((p) => p.summary));
    }
  }
  function connect() {
    feed = new WebSocket(`ws://${location.host}/dashboard/events`, [`sp-csrf.${proof}`]);
    feed.onopen = () => { connection.textContent = 'Connected'; error.hidden = true; };
    feed.onmessage = (event) => {
      try { receive(JSON.parse(event.data)); } catch { showError('The session feed sent an unreadable update.'); }
    };
    feed.onclose = () => { connection.textContent = 'Reconnecting'; retry = setTimeout(connect, 2000); };
    feed.onerror = () => showError('Could not connect to the dashboard session feed.');
  }

  async function killSession(id) {
    let response;
    try {
      response = await fetch(`/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'x-shellpuppet-csrf': proof },
      });
    } catch {
      showError('The session could not be ended.');
      return;
    }
    if (response.ok) return;
    let message = 'The session could not be ended.';
    try {
      const payload = await response.json();
      if (typeof payload.error === 'string') message = payload.error;
    } catch { /* The status line is enough. */ }
    showError(message);
  }

  async function copySessionId(id) {
    // The id alone. No viewer grant, no request and no event.
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(id);
        return;
      }
    } catch { /* The selection copy below is the fallback. */ }
    const area = document.createElement('textarea');
    area.value = id;
    area.setAttribute('readonly', '');
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }

  function releasePop(id) {
    const watch = popWatches.get(id);
    if (watch !== undefined) { clearInterval(watch); popWatches.delete(id); }
    if (!popped.delete(id)) return;
    arrange('pop release');
  }

  function popOut(id) {
    if (popSelf === id || popped.has(id)) return;
    // One window, and never a second open in the same click. The URL carries
    // the session id only: no grant and no cookie value.
    const child = openDashboard(`#pop=${encodeURIComponent(id)}`, `shellpuppet-pop-${id}`,
      'popup,width=960,height=720');
    if (child === null) return;
    popped.add(id);
    arrange('pop out');
    const watch = setInterval(() => {
      if (!child.closed) return;
      releasePop(id);
    }, 500);
    popWatches.set(id, watch);
  }

  function fitWhenReady(id, left = 30) {
    const client = panes.get(id)?.client;
    if (client?.fitGrid(80, 24)) return;
    if (left <= 0) return;
    window.requestAnimationFrame(() => fitWhenReady(id, left - 1));
  }

  function enactOpen(id) {
    const open = pendingOpen.get(id);
    if (open === undefined) return;
    if (open === 'window') {
      pendingOpen.delete(id);
      popOut(id);
      return;
    }
    if (open === 'focus') {
      if (!panes.has(id)) return;
      pendingOpen.delete(id);
      mode = 'focus';
      focusId = id;
      selected = id;
      enlarged = null;
      persist();
      arrange('focus open');
      if (autoFit) { focusOpenFits.add(id); scheduleAutoFit(); }
      else fitWhenReady(id);
    }
  }

  function applyOpen(id, open) {
    if (open !== 'focus' && open !== 'window') return;
    pendingOpen.set(id, open);
    enactOpen(id);
  }

  async function postLaunch(body) {
    let response;
    try {
      response = await fetch('/dashboard/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shellpuppet-csrf': proof },
        body: JSON.stringify(body),
      });
    } catch {
      showError('The profile did not start.');
      return;
    }
    let payload;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) {
      showError(typeof payload.error === 'string' ? payload.error : 'The profile did not start.');
      return;
    }
    if (typeof payload.id !== 'string') return;
    const profile = profiles.find((item) => item?.name === body.profile);
    const root = profile?.anyFolder && body.rootIndex !== undefined
      ? profile.rootFolders?.find((item) => item.rootIndex === body.rootIndex && item.name === body.folder) : null;
    rememberLaunch(payload.id, body.profile, body.folder, body.rootIndex, body.folderPath, root?.path);
    const item = panes.get(payload.id);
    if (item) updateCard(item);
    applyOpen(payload.id, payload.open);
  }

  function selectedProfile() {
    return profiles.find((profile) => profile && profile.name === profileSelect.value) || null;
  }

  function renderFolders() {
    const profile = selectedProfile();
    const free = !!profile?.anyFolder;
    boundedFolder.hidden = free;
    anyFolder.hidden = !free;
    folderField.hidden = !(profile && profile.folderRequired);
    if (free) {
      const options = ShellPuppetDashboardFolders.anyOptions(recent, profile.name, profile.rootFolders);
      folderPathOptions.textContent = '';
      for (const value of options) {
        const option = document.createElement('option');
        option.value = value;
        folderPathOptions.append(option);
      }
      return;
    }
    const named = Array.isArray(profile?.folders) ? profile.folders : [];
    const rooted = Array.isArray(profile?.rootFolders) ? profile.rootFolders : [];
    const folders = [
      ...named.filter((folder) => folder && typeof folder.name === 'string').map((folder) => ({ name: folder.name, value: folder.name })),
      ...rooted.filter((folder) => folder && typeof folder.name === 'string' && Number.isInteger(folder.rootIndex)).map((folder) => ({ name: folder.name, value: `root:${folder.rootIndex}:${folder.name}`, rootIndex: folder.rootIndex })),
    ];
    const remembered = Array.isArray(recent[profile?.name]) ? recent[profile.name] : [];
    const ordered = ShellPuppetDashboardFolders.order(folders, recent, profile?.name);
    const query = folderFilter.value.trim().toLocaleLowerCase();
    const previous = folderSelect.value;
    folderSelect.textContent = '';
    recentFolders.textContent = '';
    folderField.hidden = !(profile && profile.folderRequired && folders.length > 0);
    for (const folder of ordered) {
      if (query && !folder.name.toLocaleLowerCase().includes(query)) continue;
      const option = document.createElement('option');
      option.value = folder.value;
      option.textContent = folder.rootIndex === undefined ? folder.name : `${folder.name} (root ${folder.rootIndex + 1})`;
      option.dataset.name = folder.name;
      if (folder.rootIndex !== undefined) option.dataset.rootIndex = String(folder.rootIndex);
      folderSelect.append(option);
    }
    if (Array.from(folderSelect.options).some((option) => option.value === previous)) folderSelect.value = previous;
    for (const folder of ordered.filter((choice) => remembered.includes(choice.value))) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = folder.rootIndex === undefined ? folder.name : `${folder.name} (root ${folder.rootIndex + 1})`;
      button.title = `Start in ${button.textContent}`;
      button.addEventListener('click', () => { folderFilter.value = ''; renderFolders(); folderSelect.value = folder.value; startSelected(); });
      recentFolders.append(button);
    }
  }

  function renderProfiles() {
    profileSelect.textContent = '';
    for (const profile of profiles) {
      if (!profile || typeof profile.name !== 'string') continue;
      const option = document.createElement('option');
      option.value = profile.name;
      option.textContent = typeof profile.label === 'string' && profile.label !== '' ? profile.label : profile.name;
      profileSelect.append(option);
    }
    const loaded = profileSelect.options.length > 0;
    launcher.hidden = !loaded;
    watchOnly.hidden = loaded;
    renderFolders();
  }

  async function loadProfiles() {
    let response;
    try {
      response = await fetch('/dashboard/profiles', { headers: { 'x-shellpuppet-csrf': proof } });
    } catch {
      showError('The profile list could not be loaded.');
      return;
    }
    if (!response.ok) {
      showError('The profile list could not be loaded.');
      return;
    }
    let body;
    try { body = await response.json(); } catch { body = {}; }
    profiles = Array.isArray(body.profiles) ? body.profiles : [];
    const problems = Array.isArray(body.problems) ? body.problems.filter((line) => typeof line === 'string') : [];
    profileProblems.textContent = problems.join(' ');
    profileProblems.hidden = problems.length === 0;
    renderProfiles();
  }

  function startSelected() {
    const profile = selectedProfile();
    if (profile === null) return;
    const body = { profile: profile.name };
    if (profile.folderRequired) {
      if (profile.anyFolder) {
        if (folderPath.value === '') { showError('Choose a folder.'); return; }
        const rootChoice = profile.rootFolders?.find((item) => item.path === folderPath.value);
        if (rootChoice) { body.folder = rootChoice.name; body.rootIndex = rootChoice.rootIndex; }
        else body.folderPath = folderPath.value;
        void postLaunch(body);
        return;
      }
      if (folderSelect.value === '') { showError('Choose a folder.'); return; }
      const option = folderSelect.selectedOptions[0];
      if (!option) { showError('Choose a folder.'); return; }
      body.folder = option.dataset.name;
      if (option.dataset.rootIndex !== undefined) body.rootIndex = Number(option.dataset.rootIndex);
    }
    void postLaunch(body);
  }

  async function browseForFolder() {
    const profile = selectedProfile();
    if (!profile?.anyFolder) return;
    browseFolder.disabled = true;
    try {
      const response = await fetch('/dashboard/folder-picker', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shellpuppet-csrf': proof },
        body: JSON.stringify({ profile: profile.name }),
      });
      if (response.status === 204) return;
      const payload = await response.json();
      if (!response.ok) { showError(payload.error || 'The folder picker failed.'); return; }
      if (typeof payload.path === 'string') folderPath.value = payload.path;
    } catch { showError('The folder picker failed.'); }
    finally { browseFolder.disabled = false; }
  }

  function restartSession(id) {
    const body = launchBody(launches[id]);
    if (body === null) return;
    void postLaunch(body);
  }

  function dismiss(id) {
    dismissed.add(id);
    dropLaunch(id);
    const item = panes.get(id);
    if (item) { deactivate(item); item.card.remove(); panes.delete(id); }
    order = order.filter((entry) => entry !== id);
    pins = pins.filter((entry) => entry !== id);
    if (selected === id) selected = order.find((entry) => panes.has(entry)) || null;
    if (focusId === id) focusId = null;
    if (enlarged === id) enlarged = null;
    releasePop(id);
    persist();
    arrange('dismiss');
    updateAttention();
  }

  function onWindowMessage(event) {
    const data = event.data;
    if (typeof data !== 'object' || data === null || data.token === windowToken) return;
    if (data.type === 'preferences' && typeof data.autoFit === 'boolean' &&
        (data.fontSize === null || (Number.isInteger(data.fontSize) && data.fontSize >= 8 && data.fontSize <= 32))) {
      autoFit = data.autoFit;
      setFontSize(data.fontSize, false);
      return;
    }
    if (data.type === 'window-roster' && popSelf === null && data.window &&
        typeof data.window.id === 'string' && Number.isFinite(data.window.rank) &&
        Number.isFinite(data.window.openedAt) &&
        Number.isFinite(data.window.width) && Number.isFinite(data.window.height)) {
      const fresh = !windows.has(data.window.id);
      const previous = windows.get(data.window.id);
      windows.set(data.window.id, data.window);
      lastSeen.set(data.window.id, Date.now());
      if (fresh) advertise();
      if (fresh || previous.key !== data.window.key) renderScreens();
      publishAssignment();
      renderShareCount();
      return;
    }
    if (data.type === 'window-leave' && typeof data.id === 'string') {
      removeWindow(data.id);
      return;
    }
    if (data.type === 'window-assignment' && popSelf === null && windows.size > 1 &&
        data.owner === orderedWindows()[0]?.id && Array.isArray(data.byWindow?.[windowId])) {
      applyAssignment(data.byWindow[windowId]);
      return;
    }
    if (typeof data.id !== 'string') return;
    if (data.type === 'pop-claim') {
      if (data.id === popSelf) return;
      popped.add(data.id);
      arrange('pop claim');
    } else if (data.type === 'pop-release') {
      if (data.id === popSelf) return;
      releasePop(data.id);
    }
  }

  for (const name of ['auto', 'grid', 'focus']) {
    document.getElementById(name).addEventListener('click', () => {
      if (name === 'focus') focusId = selected;
      mode = name; enlarged = null; persist(); arrange('mode');
      if (name === 'focus' && !autoFit) {
        const items = shown();
        const primary = pins.find((id) => items.some((item) => item.id === id)) || focusId;
        window.requestAnimationFrame(() => panes.get(primary)?.client?.fitGrid());
      }
    });
  }
  strip.addEventListener('scroll', syncVisibility);
  document.getElementById('auto-fit').addEventListener('click', () => {
    autoFit = !autoFit;
    renderPreferences(); persist(); scheduleAutoFit(); broadcastPreferences();
  });
  document.getElementById('text-smaller').addEventListener('click', () => setFontSize(Math.max(8, (fontSize ?? 13) - 1)));
  document.getElementById('text-auto').addEventListener('click', () => setFontSize(null));
  document.getElementById('text-larger').addEventListener('click', () => setFontSize(Math.min(32, (fontSize ?? 13) + 1)));
  document.getElementById('error-close').addEventListener('click', closeError);
  document.getElementById('shortcut').addEventListener('click', () => {
    choosingPrefix = true;
    document.getElementById('shortcut').textContent = 'Press Ctrl+Shift and a letter';
  });
  attentionCount.addEventListener('click', () => {
    const waiting = shown().find((item) => attention(item) && item.id !== selected) || shown().find(attention);
    if (waiting) select(waiting.id);
  });
  profileSelect.addEventListener('change', renderFolders);
  folderFilter.addEventListener('input', renderFolders);
  folderFilter.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); startSelected(); } });
  folderPath.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); startSelected(); } });
  browseFolder.addEventListener('click', () => { void browseForFolder(); });
  document.getElementById('start').addEventListener('click', startSelected);
  document.getElementById('fullscreen').addEventListener('click', () => {
    const next = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    void Promise.resolve(next).catch(() => showError('The browser did not make this window full screen.'));
  });
  if (channel !== null) channel.onmessage = onWindowMessage;
  window.addEventListener('resize', () => { advertise(); arrange('window resize'); });
  window.addEventListener('beforeunload', () => {
    leaveWindow();
    clearTimeout(retry);
    clearTimeout(autoFitTimer);
    feed?.close();
    for (const item of panes.values()) deactivate(item);
    for (const watch of popWatches.values()) clearInterval(watch);
    for (const watch of childWatches.values()) clearInterval(watch);
    clearInterval(rosterTimer);
  });
  window.addEventListener('pagehide', () => {
    leaveWindow();
    if (popSelf === null || channel === null) return;
    channel.postMessage({ type: 'pop-release', id: popSelf, token: windowToken });
  });
  function leaveWindow() {
    if (popSelf !== null || windowLeft) return;
    windowLeft = true;
    channel?.postMessage({ type: 'window-leave', id: windowId, token: windowToken });
  }
  document.addEventListener('keydown', (event) => {
    if (choosingPrefix) {
      event.preventDefault(); event.stopPropagation();
      choosingPrefix = false;
      if (event.ctrlKey && event.shiftKey && /^[a-z]$/i.test(event.key)) {
        prefix = event.key.toLowerCase();
        persist();
        closeError();
      } else if (event.key === 'Escape') {
        closeVisibleError();
      } else {
        showError('Choose Ctrl+Shift and a letter.');
      }
      showPrefix();
      return;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === prefix) {
      event.preventDefault(); event.stopPropagation(); navigation = true; return;
    }
    const terminalFocused = document.activeElement?.closest('.pane-term') !== null;
    if (event.key === 'Escape' && !terminalFocused && closeVisibleError()) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (event.key === 'Escape' && enlarged && (navigation || !terminalFocused)) {
      event.preventDefault(); event.stopPropagation(); navigation = false;
      panes.get(enlarged)?.enlarge.click();
      return;
    }
    // Terminal mode: the focused pane's terminal receives the key, including Ctrl+\.
    if (!navigation) return;
    // A Ctrl+Shift chord for another letter is not this prefix, so the page
    // leaves it. Every other key while navigation is active is consumed.
    if (event.ctrlKey && event.shiftKey && /^[a-z]$/i.test(event.key) && event.key.toLowerCase() !== prefix) return;
    event.preventDefault(); event.stopPropagation();
    const key = event.key.toLowerCase();
    const list = shown();
    const index = list.findIndex((p) => p.id === selected);
    if (key === 'enter' || key === 'escape') { navigation = false; if (key === 'enter') select(selected, true); }
    else if (list.length === 0) return;
    else if (key === 'arrowright' || key === 'arrowdown') select(list[(index + 1) % list.length]?.id);
    else if (key === 'arrowleft' || key === 'arrowup') select(list[(index - 1 + list.length) % list.length]?.id);
    else if (/^[1-9]$/.test(key)) select(list[Number(key) - 1]?.id);
    else if (key === 'j') select(list.find((p) => attention(p) && p.id !== selected)?.id || list.find(attention)?.id);
    else if (key === 'p') panes.get(selected)?.pin.click();
    else if (key === 'f') panes.get(selected)?.fit.click();
    else if (key === 'm') panes.get(selected)?.enlarge.click();
    else if (key === '?') document.getElementById('help').hidden = !document.getElementById('help').hidden;
  }, true);
  showPrefix();
  renderPreferences();
  if (popSelf === null) {
    advertise();
    rosterTimer = setInterval(() => {
      advertise();
      for (const [id, seen] of lastSeen) {
        if (id !== windowId && Date.now() - seen > 180_000) removeWindow(id);
      }
    }, 1000);
    renderScreens();
    void discoverScreens();
    renderShareCount();
  }
  if (popSelf !== null) {
    document.getElementById('fullscreen').hidden = false;
    if (channel !== null) channel.postMessage({ type: 'pop-claim', id: popSelf, token: windowToken });
  }
  if (proof) { void loadProfiles(); connect(); }
  else showError('The dashboard page has no access proof. Open it with shellpuppet dashboard.');
})();

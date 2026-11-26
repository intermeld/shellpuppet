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
  const messagesToggle = document.getElementById('messages-toggle');
  const messagesView = document.getElementById('messages-view');
  const messagesFilter = document.getElementById('messages-filter');
  const messagesList = document.getElementById('messages-list');
  const messagesDetail = document.getElementById('messages-detail');
  const messagesOff = document.getElementById('messages-off');
  const messagesEmpty = document.getElementById('messages-empty');
  const shareCount = document.getElementById('share-count');
  const profileSelect = document.getElementById('profile');
  const resumeField = document.getElementById('resume-field');
  const resumeId = document.getElementById('resume-id');
  const sessionName = document.getElementById('session-name');
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
  let messageEntries = [];
  let unreadCounts = {};
  let messageGroups = [];
  let messagingEnabled = false;
  let messageSelection = null;
  let messageFetching = false;
  let messageDirty = false;
  let messageTimer = null;
  let lastMessageFetch = 0;
  let messageRetryDelay = 0;
  let messageFilter = '';
  // eslint-disable-next-line no-control-regex
  const visibleMessageText = (value) => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

  function unreadCount(id) {
    return unreadCounts[id] ?? 0;
  }
  function renderMessages() {
    const participantLabel = (participant) => `${participant.name}${participant.kind === 'claim' || participant.id.startsWith('claim_') ? ' (outside claim)' : ''}`;
    const options = [{ value: '', label: 'All' }];
    const participants = new Map();
    for (const entry of messageEntries) {
      participants.set(entry.from.id, participantLabel(entry.from));
      participants.set(entry.to.id, participantLabel(entry.to));
    }
    for (const [id, name] of [...participants].sort((a, b) => a[1].localeCompare(b[1])))
      options.push({ value: `session:${id}`, label: `${name} (${id})` });
    for (const group of messageGroups) options.push({ value: `group:${group.group}`, label: `Group: ${group.group}` });
    // A badge can open the view before the history arrives; keep its filter
    // rather than dropping it because no row has named that session yet.
    if (messageFilter && !options.some((option) => option.value === messageFilter)) {
      const id = messageFilter.startsWith('session:') ? messageFilter.slice(8) : messageFilter;
      const pane = panes.get(id);
      options.push({ value: messageFilter, label: pane ? `${pane.label.textContent} (${id})` : id });
    }
    messagesFilter.replaceChildren();
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      messagesFilter.append(node);
    }
    messagesFilter.value = messageFilter;
    if (messagesFilter.value !== messageFilter) messageFilter = '';
    const filtered = messageEntries.filter((entry) => {
      if (!messageFilter) return true;
      if (messageFilter.startsWith('session:')) {
        const id = messageFilter.slice(8);
        return entry.from.id === id || entry.to.id === id;
      }
      const group = messageGroups.find((item) => item.group === messageFilter.slice(6));
      return group?.members.includes(entry.from.name) || group?.members.includes(entry.to.name) ||
        group?.roles?.includes(entry.from.role) || group?.roles?.includes(panes.get(entry.to.id)?.summary.role);
    }).sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
    messagesOff.hidden = messagingEnabled;
    messagesEmpty.hidden = !messagingEnabled || filtered.length > 0;
    document.getElementById('messages-content').hidden = !messagingEnabled || filtered.length === 0;
    const focusedId = document.activeElement?.dataset?.messageId;
    messagesList.replaceChildren();
    for (const entry of filtered) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'message-row';
      row.dataset.messageId = entry.id;
      row.setAttribute('aria-current', String(entry.id === messageSelection));
      row.textContent = `${participantLabel(entry.from)} → ${participantLabel(entry.to)} · ${new Date(entry.time).toLocaleString()} · ${entry.id} · ${entry.state}`;
      row.addEventListener('click', () => { messageSelection = entry.id; renderMessages(); });
      const listItem = document.createElement('li');
      listItem.append(row);
      messagesList.append(listItem);
    }
    const selectedEntry = filtered.find((entry) => entry.id === messageSelection);
    messagesDetail.textContent = selectedEntry
      ? visibleMessageText(selectedEntry.text ?? '') : 'Select a message to read it.';
    if (focusedId) messagesList.querySelectorAll('button').forEach((row) => {
      if (row.dataset.messageId === focusedId) row.focus();
    });
  }
  function updateMessageBadge(item) {
    const count = unreadCount(item.id);
    const text = count ? `${count} ${count === 1 ? 'message' : 'messages'}` : '';
    for (const button of [item.messageCount, item.menuMessageCount]) {
      button.hidden = count === 0;
      button.textContent = text;
      button.title = text;
      button.setAttribute('aria-label', `${count} unread messages for ${item.label.textContent}`);
    }
    updateMenuStatus(item);
  }
  function updateMenuStatus(item) {
    const floor = item.floor.hidden ? '' : item.floor.textContent;
    const full = [item.role.textContent, item.badge.textContent, item.messageCount.textContent,
      item.state.textContent, item.size.textContent, floor].filter(Boolean).join(' · ');
    item.menuStatus.textContent = full;
    item.menuStatus.title = full;
    item.menuStatus.hidden = !full;
    const urgent = [item.badge.textContent, floor].filter(Boolean).join(' · ');
    item.menuButton.classList.toggle('has-status', Boolean(urgent));
    item.menuButton.title = urgent || 'More pane controls';
    item.menuButton.setAttribute('aria-description', item.menuButton.title);
  }
  async function loadMessages() {
    messageTimer = null;
    if (messageFetching || !messageDirty) return;
    messageDirty = false;
    messageFetching = true;
    lastMessageFetch = Date.now();
    const full = !messagesView.hidden;
    try {
      const response = await fetch(`/dashboard/messages${full ? '' : '?summary=1'}`, {
        headers: { 'x-shellpuppet-csrf': proof },
      });
      if (!response.ok) throw new Error('The message history could not be read.');
      const result = await response.json();
      messagingEnabled = result.enabled === true;
      unreadCounts = result.counts;
      for (const item of panes.values()) updateMessageBadge(item);
      if (full && !messagesView.hidden) {
        messageEntries = result.messages;
        messageGroups = result.groups;
        renderMessages();
      }
      if (full !== !messagesView.hidden) messageDirty = true;
      messageRetryDelay = 0;
    } catch {
      showError('The message history could not be read.');
      // Keep the update pending: the socket may stay open with no further
      // event, so retry rather than leave the badge stale.
      messageDirty = true;
      messageRetryDelay = Math.min(messageRetryDelay * 2 || 1000, 30_000);
    }
    finally { messageFetching = false; if (messageDirty) scheduleMessageRefresh(); }
  }
  function scheduleMessageRefresh() {
    messageDirty = true;
    if (messageFetching || messageTimer !== null) return;
    messageTimer = setTimeout(() => { void loadMessages(); },
      Math.max(messageRetryDelay, 250 - (Date.now() - lastMessageFetch)));
  }
  function openMessages(filter = '') {
    messageFilter = filter;
    messagesView.hidden = false;
    root.hidden = true;
    empty.hidden = true;
    messagesToggle.setAttribute('aria-expanded', 'true');
    messagesToggle.classList.add('active');
    renderMessages();
    messagesFilter.focus();
    scheduleMessageRefresh();
  }
  function closeMessages() {
    messagesView.hidden = true;
    root.hidden = false;
    empty.hidden = shown().length > 0;
    messagesToggle.setAttribute('aria-expanded', 'false');
    messagesToggle.classList.remove('active');
    messagesToggle.focus();
    messageEntries = [];
    scheduleMessageRefresh();
  }
  const PREF = 'shellpuppet.dashboard';
  const TRACK_PREF = 'shellpuppet.dashboard.tracks';
  const LAUNCH_PREF = 'shellpuppet.dashboard.launches';
  const RECENT_PREF = 'shellpuppet.dashboard.recentFolders';
  const NAME = /^[a-z][a-z0-9-]{0,31}$/;
  const SESSION_NAME = /^[A-Za-z0-9._-]{1,40}$/;
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
  let fontFitFrame = null;
  let assignmentSettleUntil = 0;
  let assignmentSettleStartedAt = 0;
  if (!window.name) window.name = `shellpuppet-dashboard-${Date.now()}-${Math.random()}`;
  let tracks = { count: 0, focusStrip: null, columns: null, rows: null };
  try {
    const record = JSON.parse(window.sessionStorage.getItem(TRACK_PREF) || 'null');
    if (record?.owner === window.name && Number.isInteger(record.count)) tracks = record;
  } catch { /* Track sizes are optional. */ }
  let activeDivider = null;
  let endActiveDivider = null;
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
  const launches = loadLaunches();
  let recent = {};
  try { recent = JSON.parse(window.localStorage.getItem(RECENT_PREF) || '{}') || {}; } catch { recent = {}; }
  const dismissed = new Set();
  const pendingOpen = new Map();
  // The launch reply can follow both a move away and a move back on this feed.
  const movedSessions = new Set();
  const windowToken = `w-${[...window.crypto.getRandomValues(new Uint8Array(12))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  const newInstance = () => `i-${[...window.crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  let windowInstance = newInstance();
  let registered = false;
  let lastFocusedAt = document.hasFocus() ? window.performance.timeOrigin + window.performance.now() : 0;
  const screenParams = new URLSearchParams(location.hash.slice(1));
  const hashWindowId = screenParams.get('screen');
  const windowId = hashWindowId && /^[a-z0-9]+-[a-z0-9]+(?:-[1-9][0-9]*)?$/.test(hashWindowId) &&
    hashWindowId.length <= 100 ? hashWindowId : windowToken;
  const windowPair = (id, instance) => JSON.stringify([id, instance]);
  const ownPair = () => windowPair(windowId, windowInstance);
  let assigned = new Set();
  let receivedWindowState = false;
  let daemonWindows = [];
  const pendingWindowMoves = new Map();
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
  let lastArrangedWidth = null;
  let lastArrangedHeight = null;
  let lastStructure = null;
  let lastVisibilityGeometry = null;
  let channel = null;
  try { channel = new BroadcastChannel('shellpuppet.dashboard'); } catch { /* Preferences remain local to this window. */ }

  function storedLaunch(value) {
    if (typeof value !== 'object' || value === null || typeof value.profile !== 'string' || !NAME.test(value.profile)) return null;
    const entry = { profile: value.profile };
    if (typeof value.name === 'string' && SESSION_NAME.test(value.name)) entry.name = value.name;
    if (typeof value.folder === 'string' && value.folder.length > 0 && !/[\\/:]/.test(value.folder) && !Array.from(value.folder).some((char) => char.charCodeAt(0) < 32) && value.folder !== '..') entry.folder = value.folder;
    if (Number.isInteger(value.rootIndex) && value.rootIndex >= 0) entry.rootIndex = value.rootIndex;
    if (typeof value.folderPath === 'string' && value.folderPath !== '') entry.folderPath = value.folderPath;
    return entry;
  }

  function loadLaunches() {
    const out = {};
    // Existing profiles may still have the single catalogue written by older versions.
    try {
      const legacy = JSON.parse(window.localStorage.getItem(LAUNCH_PREF) || '{}');
      for (const [id, value] of Object.entries(legacy)) {
        const entry = storedLaunch(value);
        if (entry) out[id] = entry;
      }
    } catch { /* The legacy catalogue is optional. */ }
    try {
      for (const key of Object.keys(window.localStorage)) {
        if (!key.startsWith(LAUNCH_PREF + '.')) continue;
        const id = key.slice(LAUNCH_PREF.length + 1);
        const entry = readLaunch(key);
        if (entry) out[id] = entry;
        else delete out[id];
      }
    } catch { /* Storage is optional. */ }
    return out;
  }

  function readLaunch(key) {
    try { return storedLaunch(JSON.parse(window.localStorage.getItem(key))); }
    catch { return null; }
  }

  const persist = () => {
    try { window.localStorage.setItem(PREF, JSON.stringify({ mode, order, pins, prefix, autoFit, fontSize })); } catch { /* Layout still works. */ }
  };
  function saveTracks() {
    try { window.sessionStorage.setItem(TRACK_PREF, JSON.stringify({ ...tracks, owner: window.name })); }
    catch { /* The current document still keeps its sizes. */ }
  }
  function resetTracks() {
    endActiveDivider?.();
    tracks = { count: shown().length, focusStrip: null, columns: null, rows: null };
    try { window.sessionStorage.removeItem(TRACK_PREF); } catch { /* The current document still resets. */ }
    applyTracks();
  }
  function applyTracks() {
    root.style.removeProperty('--strip-width');
    root.style.removeProperty('--grid-columns');
    root.style.removeProperty('--grid-rows');
    if (Number.isFinite(tracks.focusStrip)) root.style.setProperty('--strip-width', `${tracks.focusStrip}px`);
    if (Array.isArray(tracks.columns)) root.style.setProperty('--grid-columns', tracks.columns.map((x) => `${x}fr`).join(' '));
    if (Array.isArray(tracks.rows)) root.style.setProperty('--grid-rows', tracks.rows.map((x) => `${x}fr`).join(' '));
  }
  function clampTracks(width, height, columns, rows) {
    const { MIN_PANE_WIDTH: minWidth, MIN_PANE_HEIGHT: minHeight, MIN_STRIP_WIDTH: minStrip } = ShellPuppetDashboardLayout;
    const focusSpace = width - 6;
    if (typeof tracks.focusStrip === 'number' && Number.isFinite(tracks.focusStrip)) {
      tracks.focusStrip = focusSpace >= minWidth + minStrip
        ? Math.max(minStrip, Math.min(focusSpace - minWidth, tracks.focusStrip)) : null;
    }
    for (const [name, count, space, minimum] of [
      ['columns', columns, width - 6 * (columns - 1), minWidth],
      ['rows', rows, height - 6 * (rows - 1), minHeight],
    ]) {
      const values = tracks[name];
      if (!Array.isArray(values)) continue;
      if (values.length !== count || values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0) ||
          space < count * minimum) { tracks[name] = null; continue; }
      let remaining = space;
      let weight = values.reduce((sum, value) => sum + value, 0);
      const sizes = Array(count).fill(0);
      const free = new Set(values.map((_, index) => index));
      while (free.size > 0) {
        const small = [...free].filter((index) => remaining * values[index] / weight < minimum);
        if (small.length === 0) {
          for (const index of free) sizes[index] = remaining * values[index] / weight;
          break;
        }
        for (const index of small) {
          sizes[index] = minimum;
          remaining -= minimum;
          weight -= values[index];
          free.delete(index);
        }
      }
      tracks[name] = sizes.map((size) => size / space);
    }
  }
  window.addEventListener('storage', (event) => {
    if (!event.key?.startsWith(LAUNCH_PREF + '.')) return;
    const id = event.key.slice(LAUNCH_PREF.length + 1);
    const entry = readLaunch(event.key);
    if (entry) launches[id] = entry;
    else delete launches[id];
    const item = panes.get(id);
    if (item) updateCard(item);
  });
  const showPrefix = () => {
    document.getElementById('shortcut').textContent = `Shortcut: Ctrl+Shift+${prefix.toUpperCase()}`;
    document.getElementById('shortcut-help').textContent = `Ctrl+Shift+${prefix.toUpperCase()}`;
  };
  const sorted = () => order.map((id) => panes.get(id)).filter(Boolean);
  /** Panes this window holds after the roster's assignment. */
  const shown = () => sorted().filter((item) => assigned.has(item.id));
  function renderShareCount() {
    const total = sorted().length;
    const here = shown().length;
    const count = daemonWindows.length;
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
    scheduleFontFit();
    clearTimeout(autoFitTimer);
    if (activeDivider) return;
    if (!autoFit) { focusOpenFits.clear(); return; }
    autoFitTimer = setTimeout(() => {
      autoFitTimer = null;
      if (window.performance.now() < assignmentSettleUntil) { scheduleAutoFit(); return; }
      assignmentSettleStartedAt = 0;
      assignmentSettleUntil = 0;
      for (const item of shown()) {
        if (!visible(item) || item.client?.isTemporaryGeometry()) continue;
        item.client?.autoFitGrid(80, 24, focusOpenFits.has(item.id) || incomingFits.has(item.id));
      }
    }, assignmentSettleUntil ? Math.max(0, assignmentSettleUntil - window.performance.now()) : 250);
  }
  function fitFonts() {
    const visiblePanes = shown().filter((item) => item.client && visible(item));
    const below = new Set();
    let shared = Infinity;
    for (const item of visiblePanes) {
      // Update the notice after measuring the terminal area.
      item.card.classList.remove('below-floor');
      item.floor.hidden = true;
      const isBelow = item.client.belowDashboardFloor();
      item.card.classList.toggle('below-floor', isBelow);
      item.floor.hidden = !isBelow;
      updateMenuStatus(item);
      if (isBelow) {
        below.add(item);
        const font = item.client.floorFontSize();
        if (font !== null) shared = Math.min(shared, font);
      }
    }
    for (const item of visiblePanes) {
      item.client.setDashboardFontLimit(below.has(item) && Number.isFinite(shared) ? shared : null);
    }
  }
  function scheduleFontFit() {
    if (fontFitFrame !== null) return;
    fontFitFrame = window.requestAnimationFrame(() => {
      fontFitFrame = null;
      fitFonts();
    });
  }
  function settleAssignmentFits() {
    // A feed change and its window assignment can arrive in separate tasks.
    // Wait for the last change before taking a pane's grid.
    const now = window.performance.now();
    const settleMs = daemonWindows.length > 1 ? 900 : 250;
    if (assignmentSettleStartedAt === 0) assignmentSettleStartedAt = now;
    // Leave one layout settling interval for measuring and sending the take.
    assignmentSettleUntil = Math.min(now + settleMs, assignmentSettleStartedAt + 3000 - 250);
    scheduleAutoFit();
  }
  function broadcastPreferences() {
    channel?.postMessage({ type: 'preferences', autoFit, fontSize, token: windowToken });
  }
  function setFontSize(value, broadcast = true) {
    assignmentSettleUntil = 0;
    assignmentSettleStartedAt = 0;
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

  function applyAssignment(ids, byWindow) {
    const next = new Set(ids);
    if (next.size === assigned.size && [...next].every((id) => assigned.has(id))) return;
    settleAssignmentFits();
    const previous = assigned;
    assigned = next;
    for (const id of next) if (!previous.has(id)) incomingFits.add(id);
    for (const id of previous) if (!next.has(id)) {
      incomingFits.delete(id);
      const item = panes.get(id);
      const successor = Object.entries(byWindow).some(([window, sessions]) =>
        window !== ownPair() && Array.isArray(sessions) && sessions.includes(id));
      if (item) deactivate(item, successor);
    }
    updateAttention();
  }
  function openDashboard(hash, name, features) {
    const child = window.open(`${location.origin}/dashboard${hash}`, name, features);
    if (child === null) showError('The browser blocked the window. Press the button again.');
    return child;
  }
  function openScreen() {
    const id = `${windowToken}-${++nextFallback}`;
    const hash = new URLSearchParams({ screen: id });
    const child = openDashboard(`#${hash}`, `shellpuppet-window-${id}`, 'popup');
    if (child === null) return null;
    return id;
  }

  function rememberLaunch(id, profile, name, folder, rootIndex, chosenPath, recentPath) {
    if (typeof id !== 'string' || !NAME.test(profile)) return;
    const entry = { profile };
    if (typeof name === 'string' && SESSION_NAME.test(name)) entry.name = name;
    if (typeof folder === 'string' && folder !== '') entry.folder = folder;
    if (Number.isInteger(rootIndex) && rootIndex >= 0) entry.rootIndex = rootIndex;
    if (typeof chosenPath === 'string' && chosenPath !== '') entry.folderPath = chosenPath;
    launches[id] = entry;
    try { window.localStorage.setItem(LAUNCH_PREF + '.' + id, JSON.stringify(entry)); } catch { /* Restart remains available here. */ }
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
    if (typeof entry.name === 'string' && SESSION_NAME.test(entry.name)) body.name = entry.name;
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
    const role = document.createElement('span');
    role.className = 'pane-role hint';
    const badge = document.createElement('span');
    badge.className = 'badge';
    const messageCount = makeButton('', () => openMessages(`session:${item.id}`));
    messageCount.className = 'pane-message-count';
    messageCount.hidden = true;
    messageCount.addEventListener('click', (event) => event.stopPropagation());
    const state = document.createElement('span');
    state.className = 'pane-state hint';
    const space = document.createElement('span');
    space.className = 'spacer';
    const size = document.createElement('span');
    size.className = 'pane-size';
    const floor = document.createElement('span');
    floor.className = 'pane-floor';
    floor.textContent = 'Below 80×24 floor';
    floor.title = floor.textContent;
    floor.hidden = true;
    const overflowNote = document.createElement('div');
    overflowNote.className = 'pane-overflow-note';
    overflowNote.textContent = 'Shift+wheel or drag the scrollbars to see the rest. Enlarge or Fit to show it whole.';
    overflowNote.hidden = true;
    const item = { id: summary.id, summary, card, label, purpose, role, badge, messageCount, state, size, floor, overflowNote, client: null, previousGrid: null };
    const renameForm = document.createElement('form');
    renameForm.className = 'pane-rename';
    renameForm.hidden = true;
    const renameInput = document.createElement('input');
    renameInput.type = 'text';
    renameInput.maxLength = 40;
    renameInput.setAttribute('aria-label', 'New session name');
    const renameSave = document.createElement('button');
    renameSave.type = 'submit';
    renameSave.textContent = 'Save';
    const renameCancel = makeButton('Cancel rename', () => { renameForm.hidden = true; });
    renameForm.append(renameInput, renameSave, renameCancel);
    renameForm.addEventListener('click', (event) => event.stopPropagation());
    renameForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const response = await fetch(`/dashboard/sessions/${encodeURIComponent(item.id)}/rename`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-shellpuppet-csrf': proof },
          body: JSON.stringify({ name: renameInput.value }),
        });
        const result = await response.json();
        if (!response.ok) { showError(result.error || 'The session could not be renamed.'); return; }
        renameForm.hidden = true;
      } catch { showError('The session could not be renamed.'); }
    });
    item.rename = makeButton('Rename', () => {
      renameInput.value = item.summary.name || item.summary.label || item.id;
      renameForm.hidden = false;
      renameInput.focus();
      renameInput.select();
    });
    item.fit = makeButton('Fit', () => { select(item.id); item.client?.fitGrid(); });
    item.enlarge = makeButton('Enlarge', () => {
      select(item.id);
      if (enlarged === item.id) {
        enlarged = null;
        arrange('restore');
        if (!autoFit && item.previousGrid) {
          if (item.client?.belowDashboardFloor()) item.client.fitGrid();
          else item.client?.takeGrid(item.previousGrid.cols, item.previousGrid.rows);
        }
        item.previousGrid = null;
        if (autoFit) window.requestAnimationFrame(() => item.client?.autoFitGrid(80, 24, true));
      } else {
        item.previousGrid = item.client?.getGrid() || null;
        enlarged = item.id;
        arrange('enlarge');
        if (autoFit) window.requestAnimationFrame(() => item.client?.autoFitGrid(80, 24, true));
        if (!autoFit) window.requestAnimationFrame(() => item.client?.fitGrid());
      }
    });
    item.pin = makeButton('Pin', () => {
      pins = pins.includes(item.id) ? pins.filter((id) => id !== item.id) : [...pins, item.id];
      persist(); arrange('pin');
    });
    item.left = makeButton('Move left', () => move(item.id, -1));
    item.right = makeButton('Move right', () => move(item.id, 1));
    for (const control of [item.enlarge, item.pin, item.left, item.right]) {
      control.classList.add('pane-optional-control');
    }
    item.menuButton = makeButton('Menu', () => { item.menu.hidden = !item.menu.hidden; });
    item.menuButton.classList.add('pane-menu-button');
    const menu = document.createElement('div');
    menu.className = 'pane-menu';
    menu.hidden = true;
    item.menuStatus = document.createElement('div');
    item.menuStatus.className = 'pane-menu-status';
    item.menuStatus.hidden = true;
    item.menuMessageCount = makeButton('', () => openMessages(`session:${item.id}`));
    item.menuMessageCount.className = 'pane-collapsed-control pane-menu-message-count';
    item.menuMessageCount.hidden = true;
    item.menuEnlarge = makeButton('Enlarge', () => item.enlarge.click());
    item.menuPin = makeButton('Pin', () => item.pin.click());
    item.menuLeft = makeButton('Move left', () => item.left.click());
    item.menuRight = makeButton('Move right', () => item.right.click());
    for (const control of [item.menuEnlarge, item.menuPin, item.menuLeft, item.menuRight]) {
      control.classList.add('pane-collapsed-control');
    }
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
    menu.append(item.menuStatus, item.menuMessageCount, item.menuEnlarge, item.menuPin, item.menuLeft, item.menuRight,
      item.rename, renameForm, item.kill, item.copy, item.pop, item.restart, item.dismiss);
    item.menu = menu;
    head.append(label, purpose, role, badge, messageCount, state, space, size, floor, item.fit, item.enlarge,
      item.pin, item.left, item.right, item.menuButton);
    head.addEventListener('dblclick', (event) => {
      if (!event.target.closest('button')) item.enlarge.click();
    });
    head.draggable = true;
    head.addEventListener('dragstart', (event) => {
      if (event.target.closest('button')) { event.preventDefault(); return; }
      event.dataTransfer.setData('application/x-shellpuppet-pane', JSON.stringify({ id: item.id, source: ownPair() }));
      event.dataTransfer.effectAllowed = 'move';
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
    const copyNotice = document.createElement('div');
    copyNotice.className = 'pane-copy-notice';
    copyNotice.setAttribute('role', 'status');
    copyNotice.hidden = true;
    copyNotice.textContent = 'Copied to clipboard.';
    notices.append(banner, copyNotice, prompt);
    wrap.append(term, notices);
    card.append(head, menu, overflowNote, wrap);
    Object.assign(item, { term, banner, copyNotice, prompt });
    card.addEventListener('click', () => select(item.id, true));
    card.addEventListener('focus', () => select(item.id));
    updateCard(item);
    return item;
  }

  function updateCard(item) {
    const summary = item.summary;
    item.label.textContent = summary.label || summary.id;
    item.label.title = item.label.textContent;
    item.purpose.textContent = [summary.purpose, summary.parent && summary.startedBy && `Started by ${summary.startedBy}`].filter(Boolean).join(' · ');
    item.purpose.title = item.purpose.textContent;
    // Mark chairs explicitly; the label and purpose identify other panes.
    item.role.textContent = summary.role === 'chair' ? 'Chair' : '';
    item.role.title = item.role.textContent;
    item.role.hidden = summary.role !== 'chair';
    item.card.dataset.role = summary.role === 'chair' ? 'chair' : 'delegate';
    item.badge.textContent = summary.stalled ? '● Stalled' : attention(item) ? '● Waiting' : '';
    item.badge.title = summary.stalled
      ? `${item.badge.textContent}: ${summary.stalled.reason} since ${summary.stalled.since}: ${summary.stalled.description}`
      : item.badge.textContent;
    item.card.classList.toggle('attention', attention(item));
    item.card.classList.toggle('selected', selected === item.id);
    item.card.classList.toggle('ended', summary.exited === true);
    item.state.textContent = summary.exited !== true ? ''
      : summary.exitCode === null || summary.exitCode === undefined
        ? 'Ended: its output failed'
        : `Ended (code ${String(summary.exitCode)})`;
    item.state.title = item.state.textContent;
    item.pin.textContent = pins.includes(item.id) ? 'Unpin' : 'Pin';
    item.enlarge.textContent = enlarged === item.id ? 'Restore' : 'Enlarge';
    item.menuPin.textContent = item.pin.textContent;
    item.menuEnlarge.textContent = item.enlarge.textContent;
    item.pin.setAttribute('aria-label', item.pin.textContent);
    item.enlarge.setAttribute('aria-label', item.enlarge.textContent);
    item.menuPin.setAttribute('aria-label', item.menuPin.textContent);
    item.menuEnlarge.setAttribute('aria-label', item.menuEnlarge.textContent);
    item.restart.hidden = launchBody(launches[item.id]) === null;
    item.dismiss.hidden = summary.exited !== true;
    item.card.setAttribute('aria-label', `${item.label.textContent} ${item.purpose.textContent}`);
    updateMessageBadge(item);
  }
  function attention(item) {
    const prompt = item.summary.waitingOnPrompt;
    return Boolean(item.summary.stalled || (prompt && prompt.waitingMs >= 20_000));
  }
  function reconcileSelection() {
    if (!assigned.has(selected) || !panes.has(selected)) selected = shown()[0]?.id ?? null;
    if (!assigned.has(focusId) || !panes.has(focusId)) focusId = null;
    if (!assigned.has(enlarged) || !panes.has(enlarged)) enlarged = null;
  }
  function updateAttention() {
    reconcileSelection();
    for (const item of panes.values()) updateCard(item);
    const local = shown();
    const count = local.filter(attention).length;
    const state = local.some(item => item.summary.stalled) ? 'need attention' : 'waiting';
    attentionCount.textContent = count ? `${count} ${state}` : '';
    const focus = panes.get(selected);
    document.title = `${count ? `${count} ${state} · ` : ''}${focus?.label.textContent || 'Dashboard'} · ShellPuppet`;
  }
  function select(id, focusTerminal = false) {
    if (!assigned.has(id) || !panes.has(id)) return;
    selected = id;
    updateAttention();
    if (focusTerminal) panes.get(id).client?.getTerminal().focus();
  }
  function move(id, delta) {
    const local = shown().map((item) => item.id);
    const index = local.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= local.length) return;
    const from = order.indexOf(id);
    const to = order.indexOf(local[target]);
    [order[from], order[to]] = [order[to], order[from]];
    persist(); arrange('move');
    const current = shown();
    const position = current.findIndex((item) => item.id === id);
    if (position >= 0 && feed?.readyState === WebSocket.OPEN) feed.send(JSON.stringify({
      type: 'window-move', session: id, source: ownPair(), target: ownPair(),
      before: current[position + 1]?.id,
    }));
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
      elements: { banner: item.banner, copyNotice: item.copyNotice, promptAlert: item.prompt,
        size: item.size, overflowNote: item.overflowNote },
      onAttentionChange: () => updateAttention(),
      onGeometryReady: () => scheduleAutoFit(),
      onGeometryChange: () => { updateMenuStatus(item); scheduleFontFit(); },
      onMetricsChange: () => scheduleAutoFit(),
      onOutsideGeometry: () => {
        focusOpenFits.delete(item.id);
        incomingFits.delete(item.id);
        scheduleFontFit();
      },
      onGridTaken: () => { focusOpenFits.delete(item.id); incomingFits.delete(item.id); },
    });
  }
  function deactivate(item, reassigned = false) {
    if (!item.client) return;
    const client = item.client;
    item.client = null;
    client.destroy(reassigned);
    item.term.textContent = '';
  }
  function visible(item) {
    if (!assigned.has(item.id)) return false;
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
      scheduleFontFit();
    } finally {
      syncingVisibility = false;
      if (window.__dashboardTrace) window.__dashboardTrace.visibilityDepth--;
    }
  }
  function trackSizes(axis) {
    if (axis === 'focus') return [main.getBoundingClientRect().width, strip.getBoundingClientRect().width];
    const items = shown();
    const columns = Math.ceil(Math.sqrt(items.length));
    const count = axis === 'column' ? columns : Math.ceil(items.length / columns);
    return Array.from({ length: count }, (_, index) => {
      const card = items[axis === 'column' ? index : index * columns]?.card;
      return card?.getBoundingClientRect()[axis === 'column' ? 'width' : 'height'] || 0;
    });
  }
  function setTrackSizes(axis, sizes) {
    if (axis === 'focus') tracks.focusStrip = sizes[1];
    else {
      const total = sizes.reduce((sum, size) => sum + size, 0);
      tracks[axis === 'column' ? 'columns' : 'rows'] = sizes.map((size) => size / total);
    }
    applyTracks();
    positionDividers();
  }
  function positionDividers() {
    const frame = root.getBoundingClientRect();
    const items = shown();
    const columns = Math.ceil(Math.sqrt(items.length));
    for (const divider of root.querySelectorAll('.pane-divider')) {
      const axis = divider.dataset.axis;
      const index = Number(divider.dataset.index);
      const target = axis === 'focus' ? main : items[axis === 'column' ? index : (index + 1) * columns - 1]?.card;
      if (!target) continue;
      const boundary = target.getBoundingClientRect()[axis === 'row' ? 'bottom' : 'right'];
      const sizes = trackSizes(axis);
      const minimum = axis === 'row' ? ShellPuppetDashboardLayout.MIN_PANE_HEIGHT : ShellPuppetDashboardLayout.MIN_PANE_WIDTH;
      const secondMinimum = axis === 'focus' ? ShellPuppetDashboardLayout.MIN_STRIP_WIDTH : minimum;
      const total = sizes[index] + sizes[index + 1];
      const movable = total >= minimum + secondMinimum;
      const value = Math.round(sizes[index]);
      divider.setAttribute('aria-valuenow', String(value));
      divider.setAttribute('aria-valuemin', String(movable ? minimum : value));
      divider.setAttribute('aria-valuemax', String(movable ? Math.round(total - secondMinimum) : value));
      divider.setAttribute('aria-valuetext', axis === 'focus' ? `Focus pane ${value} pixels wide` :
        `${axis === 'column' ? 'Column' : 'Row'} ${index + 1} ${value} pixels ${axis === 'column' ? 'wide' : 'high'}`);
      if (axis === 'row') {
        divider.style.left = '6px'; divider.style.right = '6px';
        divider.style.top = `${boundary - frame.top - 3}px`;
      } else {
        divider.style.top = '6px'; divider.style.bottom = '6px';
        divider.style.left = `${boundary - frame.left - 3}px`;
      }
    }
  }
  function paneSizes() {
    return new Map(shown().map((item) => [item.id, item.card.getBoundingClientRect()]));
  }
  function finishDivider(divider, before, resetDirection = false) {
    activeDivider = null;
    endActiveDivider = null;
    divider.classList.remove('dragging');
    saveTracks();
    positionDividers();
    lastVisibilityGeometry = null;
    syncVisibility();
    const affected = new Set(JSON.parse(divider.dataset.panes).flat());
    for (const item of shown()) {
      if (!resetDirection && !affected.has(item.id)) continue;
      const old = before.get(item.id);
      if (!old || !item.client || !visible(item)) continue;
      const now = item.card.getBoundingClientRect();
      if (autoFit && (item.client.belowDashboardFloor() ||
          now.width > old.width + 1 || now.height > old.height + 1)) item.client.fitAfterDrag(true);
    }
  }
  function beginDivider(divider, pointerId, start) {
    endActiveDivider?.();
    const axis = divider.dataset.axis;
    const index = Number(divider.dataset.index);
    const sizes = trackSizes(axis);
    const before = paneSizes();
    const minimum = axis === 'row' ? ShellPuppetDashboardLayout.MIN_PANE_HEIGHT : ShellPuppetDashboardLayout.MIN_PANE_WIDTH;
    const secondMinimum = axis === 'focus' ? ShellPuppetDashboardLayout.MIN_STRIP_WIDTH : minimum;
    clearTimeout(autoFitTimer);
    activeDivider = divider;
    divider.classList.add('dragging');
    const move = (coordinate) => {
      const total = sizes[index] + sizes[index + 1];
      if (total < minimum + secondMinimum) return;
      const first = Math.max(minimum, Math.min(total - secondMinimum, sizes[index] + coordinate - start));
      if (Math.abs(first - sizes[index]) < 0.5) return;
      const next = sizes.slice();
      next[index] = first; next[index + 1] = total - first;
      setTrackSizes(axis, next);
    };
    let ended = false;
    const release = () => {
      if (ended) return;
      ended = true;
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('pointerup', onEnd);
      divider.removeEventListener('pointercancel', onCancel);
      divider.removeEventListener('lostpointercapture', onLost);
      document.removeEventListener('pointermove', onDocumentMove, true);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onCancel);
      if (pointerId !== null && divider.hasPointerCapture(pointerId)) divider.releasePointerCapture(pointerId);
      finishDivider(divider, before);
    };
    const onDocumentMove = (event) => {
      if (event.pointerId === pointerId && !divider.hasPointerCapture(pointerId)) release();
    };
    const onMove = (event) => {
      if (event.pointerId !== pointerId) return;
      if (!divider.hasPointerCapture(pointerId)) { release(); return; }
      move(axis === 'row' ? event.clientY : event.clientX);
    };
    const onEnd = (event) => { if (event.pointerId === pointerId) { move(axis === 'row' ? event.clientY : event.clientX); release(); } };
    const onCancel = (event) => { if (event.pointerId === pointerId) release(); };
    const onLost = (event) => { if (event.pointerId === pointerId) release(); };
    endActiveDivider = release;
    if (pointerId !== null) {
      divider.setPointerCapture(pointerId);
      divider.addEventListener('pointermove', onMove);
      divider.addEventListener('pointerup', onEnd);
      divider.addEventListener('pointercancel', onCancel);
      divider.addEventListener('lostpointercapture', onLost);
      document.addEventListener('pointermove', onDocumentMove, true);
      document.addEventListener('pointerup', onEnd);
      document.addEventListener('pointercancel', onCancel);
    }
    return { move, release };
  }
  function addDivider(axis, index) {
    const divider = document.createElement('div');
    divider.className = 'pane-divider';
    divider.dataset.axis = axis;
    divider.dataset.index = String(index);
    divider.setAttribute('role', 'separator');
    divider.setAttribute('aria-orientation', axis === 'row' ? 'horizontal' : 'vertical');
    divider.setAttribute('aria-label', axis === 'focus' ? 'Resize focused pane and strip' :
      `Resize ${axis === 'column' ? 'columns' : 'rows'} ${index + 1} and ${index + 2}`);
    divider.tabIndex = 0;
    divider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      divider.focus();
      beginDivider(divider, event.pointerId, axis === 'row' ? event.clientY : event.clientX);
    });
    divider.addEventListener('keydown', (event) => {
      const steps = axis === 'row' ? { ArrowUp: -24, ArrowDown: 24 } : { ArrowLeft: -24, ArrowRight: 24 };
      if (event.key !== 'Home' && !Object.hasOwn(steps, event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Home') {
        endActiveDivider?.();
        const before = paneSizes();
        if (axis === 'focus') tracks.focusStrip = null;
        else tracks[axis === 'column' ? 'columns' : 'rows'] = null;
        applyTracks(); finishDivider(divider, before, true);
      } else {
        const coordinate = divider.getBoundingClientRect()[axis === 'row' ? 'y' : 'x'];
        const action = beginDivider(divider, null, coordinate);
        action.move(coordinate + steps[event.key] * (event.shiftKey ? 4 : 1));
        action.release();
      }
    });
    root.append(divider);
    return divider;
  }
  function renderDividers(layout, columns, rows, items, primary) {
    const wanted = new Map();
    const ids = items.map((item) => item.id);
    if (layout === 'focus' && ids.length > 1) {
      wanted.set('focus:0', JSON.stringify([[primary], ids.filter((id) => id !== primary)]));
    }
    if (layout === 'grid' && mode === 'grid' && ids.length > 1) {
      for (let index = 0; index < columns - 1; index++) {
        wanted.set(`column:${index}`, JSON.stringify([
          ids.filter((_, position) => position % columns === index),
          ids.filter((_, position) => position % columns === index + 1),
        ]));
      }
      for (let index = 0; index < rows - 1; index++) {
        wanted.set(`row:${index}`, JSON.stringify([
          ids.slice(index * columns, (index + 1) * columns),
          ids.slice((index + 1) * columns, (index + 2) * columns),
        ]));
      }
    }
    const existing = new Map([...root.querySelectorAll('.pane-divider')].map((divider) =>
      [`${divider.dataset.axis}:${divider.dataset.index}`, divider]));
    for (const [key, divider] of existing) {
      if (wanted.get(key) === divider.dataset.panes) continue;
      if (divider === activeDivider) endActiveDivider?.();
      divider.remove();
    }
    for (const [key, sides] of wanted) {
      if (existing.get(key)?.dataset.panes === sides) continue;
      const [axis, index] = key.split(':');
      addDivider(axis, Number(index)).dataset.panes = sides;
    }
    positionDividers();
  }
  function arrange(trigger = 'unspecified') {
    if (!receivedWindowState) return;
    reconcileSelection();
    if (trigger === 'enlarge' || trigger === 'restore' || trigger === 'window resize') {
      assignmentSettleUntil = 0;
      assignmentSettleStartedAt = 0;
    }
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
      if (tracks.count !== items.length) resetTracks();
      renderShareCount();
      const width = root.clientWidth - 12;
      const height = root.clientHeight - 12;
      lastArrangedWidth = width;
      lastArrangedHeight = height;
      const columns = Math.ceil(Math.sqrt(items.length));
      const rows = Math.ceil(items.length / Math.max(1, columns));
      if (items.length > 0) clampTracks(width, height, columns, rows);
      applyTracks();
      const autoGrid = items.length <= 1 || (width / columns >= 652 && height / rows >= 446);
      const layout = enlarged ? 'enlarged' : mode === 'auto' ? (autoGrid ? 'grid' : 'focus') : mode;
      const primary = layout === 'focus' ? pins.find((id) => items.some((item) => item.id === id)) ||
        (mode === 'focus' && items.some((item) => item.id === focusId) ? focusId : items[0]?.id) : null;
      const layoutKey = JSON.stringify([items.map((item) => item.id), width, height, layout, mode,
        columns, rows, primary, enlarged, pins]);
      if (layoutKey !== lastLayout) {
        const structureKey = JSON.stringify([items.map((item) => item.id), layout, primary, enlarged]);
        empty.hidden = !messagesView.hidden || items.length > 0;
        root.className = layout === 'focus' && items.length === 1 ? 'focus focus-only' : layout;
        root.dataset.layout = layout;
        root.style.setProperty('--columns', String(Math.max(1, columns)));
        root.style.setProperty('--rows', String(Math.max(1, rows)));
        for (const name of ['auto', 'grid', 'focus']) document.getElementById(name).classList.toggle('active', mode === name);
        if (structureKey !== lastStructure) {
          for (const child of [...root.children]) if (!child.classList.contains('pane-divider')) child.remove();
          if (layout === 'grid') {
            for (const item of items) root.append(item.card);
          } else if (layout === 'focus') {
            main.textContent = '';
            strip.textContent = '';
            for (const item of items) (item.id === primary ? main : strip).append(item.card);
            root.append(main, strip);
          } else {
            const item = items.find((pane) => pane.id === enlarged);
            if (item) root.append(item.card);
          }
          lastStructure = structureKey;
        }
        renderDividers(layout, columns, rows, items, primary);
        for (const item of items) {
          updateCard(item);
        }
        lastLayout = layoutKey;
        syncVisibility();
        scheduleAutoFit();
      }
    } finally {
      arranging = false;
      if (window.__dashboardTrace) window.__dashboardTrace.arrangeDepth--;
    }
  }

  function dropLaunch(id) {
    if (launches[id] === undefined) return;
    delete launches[id];
    try {
      const legacy = JSON.parse(window.localStorage.getItem(LAUNCH_PREF) || '{}');
      if (legacy?.[id]) window.localStorage.setItem(LAUNCH_PREF + '.' + id, 'null');
      else window.localStorage.removeItem(LAUNCH_PREF + '.' + id);
    } catch { /* Storage is optional. */ }
  }

  function reconcile(sessions, full = false) {
    const incoming = new Map(sessions.filter((s) => s && typeof s.id === 'string').map((s) => [s.id, s]));
    if ([...panes.keys()].some((id) => !incoming.has(id) || dismissed.has(id)) ||
        [...incoming.keys()].some((id) => !panes.has(id) && !dismissed.has(id))) {
      settleAssignmentFits();
    }
    // A snapshot is the whole list. An added or removed frame is not, so it
    // must not forget a dismissal or a launch for a session it did not mention.
    if (full) {
      for (const id of [...dismissed]) { if (!incoming.has(id)) dismissed.delete(id); }
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
    persist(); arrange('feed reconcile'); updateAttention();
    for (const id of [...pendingOpen.keys()]) enactOpen(id);
  }
  function receive(frame) {
    if (!frame || typeof frame.type !== 'string') return;
    if (frame.type === 'window-state' && Array.isArray(frame.windows) && frame.windows.includes(ownPair()) &&
        typeof frame.designated === 'string' && frame.assignments && typeof frame.assignments === 'object') {
      daemonWindows = frame.windows;
      const designated = frame.designated === ownPair();
      const toggle = document.getElementById('designated-window');
      toggle.setAttribute('aria-pressed', String(designated));
      toggle.classList.toggle('active', designated);
      toggle.disabled = false;
      document.getElementById('start').disabled = launcher.hidden;
      const ids = Array.isArray(frame.assignments[ownPair()]) ? frame.assignments[ownPair()] : [];
      receivedWindowState = true;
      if (typeof frame.move?.session === 'string') {
        const id = frame.move.session;
        movedSessions.add(id);
        pendingOpen.delete(id);
        focusOpenFits.delete(id);
        for (const [target, session] of pendingWindowMoves) {
          if (session === id) pendingWindowMoves.delete(target);
        }
      }
      if (frame.move?.target === ownPair() && typeof frame.move.session === 'string') {
        order = order.filter((id) => id !== frame.move.session);
        const before = typeof frame.move.before === 'string' ? order.indexOf(frame.move.before) : -1;
        order.splice(before < 0 ? order.length : before, 0, frame.move.session);
        persist();
      }
      applyAssignment(ids, frame.assignments);
      arrange('window state');
      for (const id of [...pendingOpen.keys()]) enactOpen(id);
      for (const [id, session] of pendingWindowMoves) {
        const target = frame.windows.find((pair) => {
          try { return JSON.parse(pair)[0] === id; } catch { return false; }
        });
        if (!target) continue;
        feed?.send(JSON.stringify({ type: 'window-move', session, source: ownPair(), target }));
        pendingWindowMoves.delete(id);
      }
      renderShareCount();
      return;
    }
    if (frame.type === 'message' || frame.type === 'message-state') {
      scheduleMessageRefresh();
      return;
    }
    if (frame.type === 'window-gone') return;
    if (frame.type === 'snapshot' && Array.isArray(frame.sessions)) reconcile(frame.sessions, true);
    else if (frame.type === 'session-added' && frame.session?.id) {
      if (!panes.has(frame.session.id) && !dismissed.has(frame.session.id)) {
        reconcile([...sorted().map((p) => p.summary), frame.session]);
      }
    } else if (frame.type === 'session-updated' && frame.session?.id) {
      const item = panes.get(frame.session.id);
      if (item) {
        item.summary = frame.session;
        updateAttention();
        if (!messagesView.hidden && (frame.changed?.includes('label') || frame.changed?.includes('name'))) renderMessages();
      }
    } else if (frame.type === 'session-removed' && typeof frame.session === 'string') {
      movedSessions.delete(frame.session);
      pendingOpen.delete(frame.session);
      dismissed.delete(frame.session);
      dropLaunch(frame.session);
      reconcile(sorted().filter((p) => p.id !== frame.session).map((p) => p.summary));
    }
  }
  function connect() {
    feed = new WebSocket(`ws://${location.host}/dashboard/events`, [`sp-csrf.${proof}`]);
    feed.onopen = () => {
      connection.textContent = 'Connected'; error.hidden = true;
      scheduleMessageRefresh();
      if (registered) {
        windowInstance = newInstance();
      }
      registered = true;
      feed.send(JSON.stringify({ type: 'window-register', id: windowId, instance: windowInstance,
        focusedAt: lastFocusedAt }));
    };
    feed.onmessage = (event) => {
      try { receive(JSON.parse(event.data)); } catch { showError('The session feed sent an unreadable update.'); }
    };
    feed.onclose = () => {
      connection.textContent = 'Reconnecting';
      receivedWindowState = false;
      daemonWindows = [];
      pendingWindowMoves.clear();
      pendingOpen.clear();
      movedSessions.clear();
      focusOpenFits.clear();
      endActiveDivider?.();
      applyAssignment([], {});
      root.replaceChildren();
      lastLayout = lastStructure = lastVisibilityGeometry = null;
      empty.hidden = !messagesView.hidden;
      shareCount.textContent = '';
      const toggle = document.getElementById('designated-window');
      toggle.classList.remove('active');
      toggle.setAttribute('aria-pressed', 'false');
      toggle.disabled = true;
      document.getElementById('start').disabled = true;
      retry = setTimeout(connect, 2000);
    };
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

  function popOut(id) {
    if (!assigned.has(id)) return;
    const newId = openScreen();
    if (newId !== null) pendingWindowMoves.set(newId, id);
  }

  function fitWhenReady(id, registration, left = 30) {
    if (registration !== ownPair() || !assigned.has(id) || movedSessions.has(id)) return;
    const client = panes.get(id)?.client;
    if (client?.fitGrid(80, 24)) return;
    if (left <= 0) return;
    window.requestAnimationFrame(() => fitWhenReady(id, registration, left - 1));
  }

  function enactOpen(id) {
    const open = pendingOpen.get(id);
    if (open === undefined) return;
    if (open === 'window') {
      if (!assigned.has(id)) return;
      pendingOpen.delete(id);
      popOut(id);
      return;
    }
    if (open === 'focus') {
      if (!assigned.has(id) || !panes.has(id)) return;
      pendingOpen.delete(id);
      mode = 'focus';
      focusId = id;
      selected = id;
      enlarged = null;
      persist();
      arrange('focus open');
      if (autoFit) { focusOpenFits.add(id); scheduleAutoFit(); }
      else fitWhenReady(id, ownPair());
    }
  }

  function applyOpen(id, open) {
    if (open !== 'focus' && open !== 'window') return;
    pendingOpen.set(id, open);
    enactOpen(id);
  }

  async function postLaunch(body) {
    const launchingWindow = ownPair();
    if (feed?.readyState !== WebSocket.OPEN || !daemonWindows.includes(launchingWindow)) {
      showError('The dashboard window is reconnecting. Try again when it is connected.');
      return;
    }
    let response;
    try {
      response = await fetch('/dashboard/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shellpuppet-csrf': proof },
        body: JSON.stringify({ ...body, window: launchingWindow }),
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
    rememberLaunch(payload.id, body.profile, body.name, body.folder, body.rootIndex, body.folderPath, root?.path);
    const item = panes.get(payload.id);
    if (item) updateCard(item);
    if (feed?.readyState === WebSocket.OPEN && ownPair() === launchingWindow && !movedSessions.has(payload.id)) {
      applyOpen(payload.id, payload.open);
    }
  }

  function selectedProfile() {
    return profiles.find((profile) => profile && profile.name === profileSelect.value) || null;
  }

  function renderFolders() {
    const profile = selectedProfile();
    resumeField.hidden = !profile?.canResume;
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
      option.textContent = ShellPuppetDashboardFolders.optionText(profile);
      profileSelect.append(option);
    }
    const loaded = profileSelect.options.length > 0;
    launcher.hidden = !loaded;
    document.getElementById('start').disabled = !loaded || !daemonWindows.includes(ownPair());
    watchOnly.hidden = loaded;
    renderFolders();
    sessionName.value = selectedProfile()?.name || '';
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
    if (sessionName.value !== profile.name) body.name = sessionName.value;
    if (profile.canResume && resumeId.value) body.resumeId = resumeId.value;
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
    if (focusId === id) focusId = null;
    if (enlarged === id) enlarged = null;
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
    }
  }

  for (const name of ['auto', 'grid', 'focus']) {
    document.getElementById(name).addEventListener('click', () => {
      assignmentSettleUntil = 0;
      assignmentSettleStartedAt = 0;
      if (name === 'focus') focusId = selected;
      if (name === 'auto' || name === 'grid') resetTracks();
      mode = name; enlarged = null; persist(); arrange('mode');
      if (name === 'focus' && autoFit) {
        const primary = pins.find((id) => shown().some((item) => item.id === id)) || focusId;
        if (panes.get(primary)?.client?.isTemporaryGeometry()) {
          window.requestAnimationFrame(() => panes.get(primary)?.client?.autoFitGrid(80, 24, true));
        }
      }
      if (name === 'focus' && !autoFit) {
        const items = shown();
        const primary = pins.find((id) => items.some((item) => item.id === id)) || focusId;
        window.requestAnimationFrame(() => panes.get(primary)?.client?.fitGrid());
      }
    });
  }
  strip.addEventListener('scroll', syncVisibility);
  function acceptsPaneMove(transfer) {
    return transfer?.types.includes('application/x-shellpuppet-pane') &&
      ['move', 'copyMove', 'linkMove', 'all', 'uninitialized'].includes(transfer.effectAllowed);
  }
  document.addEventListener('dragover', (event) => {
    if (!acceptsPaneMove(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  document.addEventListener('drop', (event) => {
    if (!acceptsPaneMove(event.dataTransfer)) return;
    event.preventDefault();
    let drag;
    try { drag = JSON.parse(event.dataTransfer.getData('application/x-shellpuppet-pane')); }
    catch { return; }
    if (typeof drag?.id !== 'string' || typeof drag?.source !== 'string') return;
    const pane = event.target.closest?.('.pane');
    let before = pane?.dataset.session;
    if (pane && before) {
      const box = pane.getBoundingClientRect();
      const after = root.dataset.layout === 'focus'
        ? event.clientY > box.top + box.height / 2
        : event.clientX > box.left + box.width / 2;
      if (after) before = shown()[shown().findIndex((item) => item.id === before) + 1]?.id;
    }
    if (feed?.readyState === WebSocket.OPEN) feed.send(JSON.stringify({
      type: 'window-move', session: drag.id, source: drag.source, target: ownPair(), before,
    }));
  });
  document.getElementById('auto-fit').addEventListener('click', () => {
    assignmentSettleUntil = 0;
    assignmentSettleStartedAt = 0;
    autoFit = !autoFit;
    renderPreferences(); persist(); scheduleAutoFit(); broadcastPreferences();
  });
  document.getElementById('designated-window').addEventListener('click', () => {
    if (feed?.readyState === WebSocket.OPEN) feed.send(JSON.stringify({ type: 'window-designate' }));
  });
  document.getElementById('new-window').addEventListener('click', () => { openScreen(); });
  window.addEventListener('focus', (event) => {
    if (!event.isTrusted) return;
    lastFocusedAt = window.performance.timeOrigin + event.timeStamp;
    if (feed?.readyState === WebSocket.OPEN) feed.send(JSON.stringify({ type: 'window-focus', focusedAt: lastFocusedAt }));
  });
  document.getElementById('text-smaller').addEventListener('click', () => setFontSize(Math.max(8, (fontSize ?? 13) - 1)));
  document.getElementById('text-auto').addEventListener('click', () => setFontSize(null));
  document.getElementById('text-larger').addEventListener('click', () => setFontSize(Math.min(32, (fontSize ?? 13) + 1)));
  document.getElementById('error-close').addEventListener('click', closeError);
  messagesToggle.addEventListener('click', () => {
    if (messagesView.hidden) openMessages(); else closeMessages();
  });
  messagesFilter.addEventListener('change', () => {
    messageFilter = messagesFilter.value;
    messageSelection = null;
    renderMessages();
  });
  document.getElementById('shortcut').addEventListener('click', () => {
    choosingPrefix = true;
    document.getElementById('shortcut').textContent = 'Press Ctrl+Shift and a letter';
  });
  attentionCount.addEventListener('click', () => {
    const waiting = shown().find((item) => attention(item) && item.id !== selected) || shown().find(attention);
    if (waiting) select(waiting.id);
  });
  profileSelect.addEventListener('change', () => { resumeId.value = ''; sessionName.value = selectedProfile()?.name || ''; renderFolders(); });
  folderFilter.addEventListener('input', renderFolders);
  folderFilter.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); startSelected(); } });
  folderPath.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); startSelected(); } });
  browseFolder.addEventListener('click', () => { void browseForFolder(); });
  document.getElementById('start').addEventListener('click', startSelected);
  if (channel !== null) channel.onmessage = onWindowMessage;
  window.addEventListener('resize', () => {
    if (root.clientWidth - 12 !== lastArrangedWidth || root.clientHeight - 12 !== lastArrangedHeight)
      arrange('window resize');
  });
  window.addEventListener('beforeunload', () => {
    endActiveDivider?.();
    clearTimeout(retry);
    clearTimeout(messageTimer);
    clearTimeout(autoFitTimer);
    window.cancelAnimationFrame(fontFitFrame);
    feed?.close();
    for (const item of panes.values()) deactivate(item);
  });
  window.addEventListener('pagehide', () => { endActiveDivider?.(); });
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
  renderShareCount();
  if (proof) { void loadProfiles(); connect(); }
  else showError('Start ShellPuppet from its shortcut or with shellpuppet desktop');
})();

/** The dashboard's feed, arrangement and deliberate geometry controls. */
/* global ShellPuppetPane */
(() => {
  'use strict';

  const proof = document.querySelector('meta[name="sp-csrf"]')?.content || '';
  const root = document.getElementById('panes');
  const empty = document.getElementById('empty');
  const error = document.getElementById('error');
  const connection = document.getElementById('connection');
  const attentionCount = document.getElementById('attention-count');
  const main = document.createElement('div');
  const strip = document.createElement('div');
  main.id = 'main-pane';
  strip.id = 'strip';
  const panes = new Map();
  const PREF = 'shellpuppet.dashboard';
  let saved = {};
  try { saved = JSON.parse(window.localStorage.getItem(PREF) || '{}') || {}; } catch { /* Preferences are optional. */ }
  let order = Array.isArray(saved.order) ? saved.order.filter((id) => typeof id === 'string') : [];
  let pins = Array.isArray(saved.pins) ? saved.pins.filter((id) => typeof id === 'string') : [];
  let mode = ['auto', 'grid', 'focus'].includes(saved.mode) ? saved.mode : 'auto';
  let prefix = typeof saved.prefix === 'string' && /^[a-z]$/.test(saved.prefix) ? saved.prefix : 'a';
  let choosingPrefix = false;
  let selected = null;
  let focusId = null;
  let enlarged = null;
  let navigation = false;
  let feed = null;
  let retry = null;
  let visibilityFrame = null;

  const persist = () => {
    try { window.localStorage.setItem(PREF, JSON.stringify({ mode, order, pins, prefix })); } catch { /* Layout still works. */ }
  };
  const showPrefix = () => {
    document.getElementById('shortcut').textContent = `Shortcut: Ctrl+Shift+${prefix.toUpperCase()}`;
    document.getElementById('shortcut-help').textContent = `Ctrl+Shift+${prefix.toUpperCase()}`;
  };
  const sorted = () => order.map((id) => panes.get(id)).filter(Boolean);
  const showError = (message) => { error.textContent = message; error.hidden = false; };
  const makeButton = (label, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', (event) => { event.stopPropagation(); action(); });
    return button;
  };

  function createCard(summary) {
    const card = document.createElement('section');
    card.className = 'pane';
    card.dataset.session = summary.id;
    card.tabIndex = 0;
    const head = document.createElement('div');
    head.className = 'pane-head';
    const label = document.createElement('span');
    label.className = 'pane-label';
    const purpose = document.createElement('span');
    purpose.className = 'pane-purpose hint';
    const badge = document.createElement('span');
    badge.className = 'badge';
    const space = document.createElement('span');
    space.className = 'spacer';
    const size = document.createElement('span');
    size.className = 'pane-size';
    const item = { id: summary.id, summary, card, label, purpose, badge, size, client: null, previousGrid: null };
    item.fit = makeButton('Fit', () => { select(item.id); item.client?.fitGrid(); });
    item.smaller = makeButton('Smaller text', () => item.client?.nudgeFont(-1));
    item.larger = makeButton('Larger text', () => item.client?.nudgeFont(1));
    item.autoText = makeButton('Auto text', () => item.client?.setFontOverride(null));
    item.enlarge = makeButton('Enlarge', () => {
      select(item.id);
      if (enlarged === item.id) {
        enlarged = null;
        arrange();
        if (item.previousGrid) item.client?.takeGrid(item.previousGrid.cols, item.previousGrid.rows);
        item.previousGrid = null;
      } else {
        item.previousGrid = item.client?.getGrid() || null;
        enlarged = item.id;
        arrange();
        window.requestAnimationFrame(() => item.client?.fitGrid());
      }
    });
    item.pin = makeButton('Pin', () => {
      pins = pins.includes(item.id) ? pins.filter((id) => id !== item.id) : [...pins, item.id];
      persist(); arrange();
    });
    item.left = makeButton('Move left', () => move(item.id, -1));
    item.right = makeButton('Move right', () => move(item.id, 1));
    head.append(label, purpose, badge, space, size, item.smaller, item.autoText, item.larger,
      item.fit, item.enlarge, item.pin, item.left, item.right);
    const wrap = document.createElement('div');
    wrap.className = 'pane-wrap';
    const term = document.createElement('div');
    term.className = 'pane-term';
    const notices = document.createElement('div');
    notices.className = 'pane-notices';
    const banner = document.createElement('div');
    banner.className = 'pane-banner';
    banner.hidden = true;
    const prompt = document.createElement('div');
    prompt.className = 'pane-prompt';
    prompt.hidden = true;
    notices.append(banner, prompt);
    wrap.append(term, notices);
    card.append(head, wrap);
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
    item.pin.textContent = pins.includes(item.id) ? 'Unpin' : 'Pin';
    item.enlarge.textContent = enlarged === item.id ? 'Restore' : 'Enlarge';
    item.pin.setAttribute('aria-label', item.pin.textContent);
    item.enlarge.setAttribute('aria-label', item.enlarge.textContent);
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
    persist(); arrange();
  }
  function activate(item) {
    if (item.client) { item.client.relayout(false); return; }
    item.client = ShellPuppetPane.create({
      container: item.term, sessionId: item.id, dashboardProof: proof,
      elements: { banner: item.banner, promptAlert: item.prompt, size: item.size },
      onAttentionChange: () => updateAttention(),
    });
  }
  function deactivate(item) {
    if (!item.client) return;
    item.client.destroy();
    item.client = null;
    item.term.textContent = '';
  }
  function visible(item) {
    if (enlarged && item.id !== enlarged) return false;
    const box = item.card.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const container = item.card.parentElement === strip ? strip.getBoundingClientRect() : root.getBoundingClientRect();
    return box.bottom > container.top && box.top < container.bottom && box.right > container.left && box.left < container.right;
  }
  function syncVisibility() {
    visibilityFrame = null;
    for (const item of panes.values()) {
      if (visible(item)) activate(item);
      else deactivate(item);
    }
  }
  function scheduleVisibility() {
    if (visibilityFrame !== null) window.cancelAnimationFrame(visibilityFrame);
    visibilityFrame = window.requestAnimationFrame(syncVisibility);
  }
  function arrange() {
    const items = sorted();
    empty.hidden = items.length > 0;
    root.textContent = '';
    root.className = '';
    const width = root.clientWidth - 12;
    const height = root.clientHeight - 12;
    const columns = Math.ceil(Math.sqrt(items.length));
    const rows = Math.ceil(items.length / Math.max(1, columns));
    const autoGrid = items.length <= 1 || (width / columns >= 652 && height / rows >= 446);
    const layout = enlarged ? 'enlarged' : mode === 'auto' ? (autoGrid ? 'grid' : 'focus') : mode;
    root.classList.add(layout);
    root.dataset.layout = layout;
    root.style.setProperty('--columns', String(Math.max(1, columns)));
    root.style.setProperty('--rows', String(Math.max(1, rows)));
    for (const name of ['auto', 'grid', 'focus']) document.getElementById(name).classList.toggle('active', mode === name);
    if (layout === 'grid') {
      for (const item of items) root.append(item.card);
    } else if (layout === 'focus') {
      main.textContent = '';
      strip.textContent = '';
      const primary = pins.find((id) => panes.has(id)) ||
        (mode === 'focus' && panes.has(focusId) ? focusId : items[0]?.id);
      for (const item of items) (item.id === primary ? main : strip).append(item.card);
      root.append(main, strip);
    } else {
      const item = panes.get(enlarged);
      if (item) root.append(item.card);
    }
    for (const item of items) {
      const measuredWidth = layout === 'grid' ? width / columns : item.card.parentElement === strip ? 300 : width - 300;
      const measuredHeight = layout === 'grid' ? height / rows : item.card.parentElement === strip ? 170 : height;
      item.card.classList.toggle('below-floor', measuredWidth < 652 || measuredHeight < 446);
      updateCard(item);
    }
    scheduleVisibility();
  }

  function reconcile(sessions) {
    const incoming = new Map(sessions.filter((s) => s && typeof s.id === 'string').map((s) => [s.id, s]));
    for (const [id, item] of panes) {
      if (incoming.has(id)) continue;
      deactivate(item); item.card.remove(); panes.delete(id);
    }
    order = order.filter((id) => incoming.has(id));
    pins = pins.filter((id) => incoming.has(id));
    for (const [id, summary] of incoming) {
      if (!panes.has(id)) { panes.set(id, createCard(summary)); order.push(id); }
      else panes.get(id).summary = summary;
    }
    if (!panes.has(selected)) selected = order[0] || null;
    if (!panes.has(focusId)) focusId = null;
    if (!panes.has(enlarged)) enlarged = null;
    persist(); arrange(); updateAttention();
  }
  function receive(frame) {
    if (!frame || typeof frame.type !== 'string') return;
    if (frame.type === 'snapshot' && Array.isArray(frame.sessions)) reconcile(frame.sessions);
    else if (frame.type === 'session-added' && frame.session?.id) {
      if (!panes.has(frame.session.id)) reconcile([...sorted().map((p) => p.summary), frame.session]);
    } else if (frame.type === 'session-updated' && frame.session?.id) {
      const item = panes.get(frame.session.id);
      if (item) { item.summary = frame.session; updateAttention(); }
    } else if (frame.type === 'session-removed' && typeof frame.session === 'string') {
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

  for (const name of ['auto', 'grid', 'focus']) {
    document.getElementById(name).addEventListener('click', () => {
      if (name === 'focus') focusId = selected;
      mode = name; enlarged = null; persist(); arrange();
      if (name === 'focus') {
        const primary = pins.find((id) => panes.has(id)) || focusId;
        window.requestAnimationFrame(() => panes.get(primary)?.client?.fitGrid());
      }
    });
  }
  strip.addEventListener('scroll', scheduleVisibility);
  document.getElementById('shortcut').addEventListener('click', () => {
    choosingPrefix = true;
    document.getElementById('shortcut').textContent = 'Press Ctrl+Shift and a letter';
  });
  attentionCount.addEventListener('click', () => {
    const waiting = sorted().find((item) => attention(item) && item.id !== selected) || sorted().find(attention);
    if (waiting) select(waiting.id);
  });
  window.addEventListener('resize', arrange);
  window.addEventListener('beforeunload', () => { clearTimeout(retry); feed?.close(); for (const item of panes.values()) deactivate(item); });
  document.addEventListener('keydown', (event) => {
    if (choosingPrefix) {
      event.preventDefault(); event.stopPropagation();
      choosingPrefix = false;
      if (event.ctrlKey && event.shiftKey && /^[a-z]$/i.test(event.key)) {
        prefix = event.key.toLowerCase();
        persist();
      } else if (event.key !== 'Escape') {
        showError('Choose Ctrl+Shift and a letter.');
      }
      showPrefix();
      return;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === prefix) {
      event.preventDefault(); event.stopPropagation(); navigation = true; return;
    }
    if (!navigation) return;
    const key = event.key.toLowerCase();
    const list = sorted();
    const index = list.findIndex((p) => p.id === selected);
    if (key === 'enter' || key === 'escape') { navigation = false; if (key === 'enter') select(selected, true); }
    else if (key === 'arrowright' || key === 'arrowdown') select(list[(index + 1) % list.length]?.id);
    else if (key === 'arrowleft' || key === 'arrowup') select(list[(index - 1 + list.length) % list.length]?.id);
    else if (/^[1-9]$/.test(key)) select(list[Number(key) - 1]?.id);
    else if (key === 'j') select(list.find((p) => attention(p) && p.id !== selected)?.id || list.find(attention)?.id);
    else if (key === 'p') panes.get(selected)?.pin.click();
    else if (key === 'f') panes.get(selected)?.fit.click();
    else if (key === 'm') panes.get(selected)?.enlarge.click();
    else if (key === '?') document.getElementById('help').hidden = !document.getElementById('help').hidden;
    else return;
    event.preventDefault(); event.stopPropagation();
  }, true);
  showPrefix();
  if (proof) connect(); else showError('The dashboard page has no access proof. Open it with shellpuppet dashboard.');
})();

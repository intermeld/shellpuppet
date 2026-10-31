/** The single-session viewer page: grant URL, page controls and layout. */

/* global ShellPuppetPane */

(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  // A session id in the path is accepted as well as the query form.
  const sessionId = params.get('s') || location.pathname.split('/')[2] || '';
  const captureMode = params.get('capture') === '1';
  const redactedCapture = captureMode && params.get('redact') === '1';
  if (captureMode) document.body.classList.add('capture');

  // The grant has already been redeemed for an HttpOnly cookie. Keep the
  // session id for reloads while removing the spent grant from the URL.
  history.replaceState(null, '', `/view?s=${encodeURIComponent(sessionId)}`);

  const banner = document.getElementById('banner');
  document.getElementById('session-label').textContent = sessionId;
  if (!sessionId) {
    banner.textContent = 'This viewer link is missing its session id. Ask the agent for a fresh viewer URL.';
    banner.hidden = false;
    return;
  }

  const MIN_FONT_PX = 6;
  const MAX_FONT_PX = 40;
  const FONT_PREF_KEY = 'shellpuppet.fontSize';
  const clampFont = (px) => Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, px));
  let fontOverride = null;
  try {
    const saved = window.localStorage.getItem(FONT_PREF_KEY);
    if (saved !== null && saved !== 'auto') {
      const parsed = Number.parseInt(saved, 10);
      if (Number.isFinite(parsed)) fontOverride = clampFont(parsed);
    }
  } catch {
    // A blocked preference store leaves the automatic font size in place.
  }

  const pane = ShellPuppetPane.create({
    container: document.getElementById('term'),
    sessionId,
    captureMode,
    redactedCapture,
    initialFontOverride: fontOverride,
    onTitleChange: (title) => { document.title = title; },
    onFontOverrideChange: (value) => {
      try {
        window.localStorage.setItem(FONT_PREF_KEY, value === null ? 'auto' : String(value));
      } catch {
        // The selected size still applies for this page.
      }
    },
    elements: {
      dot: document.getElementById('dot'),
      banner,
      size: document.getElementById('size'),
      inputSource: document.getElementById('input-source'),
      readonly: document.getElementById('readonly'),
      modeHint: document.getElementById('mode-hint'),
      zoomAuto: document.getElementById('zoom-auto'),
      identity: document.getElementById('identity'),
      identityPurpose: document.getElementById('identity-purpose'),
      identityMeta: document.getElementById('identity-meta'),
      sessionAgent: document.getElementById('session-agent'),
      promptAlert: document.getElementById('prompt-alert'),
    },
  });

  document.getElementById('readonly').addEventListener('click', () => {
    if (!pane.isReadOnlyEnforced()) pane.setReadOnly(!pane.isReadOnly());
  });
  document.getElementById('zoom-in').addEventListener('click', () => pane.nudgeFont(1));
  document.getElementById('zoom-out').addEventListener('click', () => pane.nudgeFont(-1));
  document.getElementById('zoom-auto').addEventListener('click', () => pane.setFontOverride(null));

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => pane.relayout(true), 120);
  });
})();

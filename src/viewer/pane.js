/**
 * ShellPuppet pane: the terminal client for one session in one container.
 *
 * It owns frame handling, typing (with term.onData registered once), sizing,
 * reconnect and badges for one session. The page provides the container and
 * badge elements, and wires up its controls.
 *
 * Wire protocol: BINARY WebSocket frames carry terminal bytes (snapshots, the
 * live stream and the exit notice); TEXT frames are JSON control messages:
 * `identity`, `geometry`, `input-source`, `input-refused`, `exited`,
 * `prompt-stall`, `prompt-clear`, `session-stalled` and `session-stall-clear`.
 * What this pane sends is text: a JSON
 * resize message, or bytes for the program, which are either keystrokes or
 * the terminal's own answers to the program's queries. The daemon tells those
 * two apart.
 *
 * Three rules shape the pane:
 * - `term.onData` is registered exactly ONCE, never inside the connect path.
 *   Registering per-connect would stack a listener per reconnect and send
 *   every keystroke N times.
 * - The pane measures what grid this window would like, and asks
 *   the daemon for it rather than assuming it (§5). The daemon decides who is
 *   driving the grid and answers with a geometry frame; only that frame
 *   resizes anything here.
 * - The pane never rebuilds terminal state itself. On connect and after every
 *   grid change the daemon sends a snapshot of its own renderer, a wipe followed
 *   by the bytes that rebuild the screen, so what this pane shows is what the
 *   daemon renders, which is what the agent reads. A tail of the raw stream
 *   replayed here would start mid-frame.
 */

/* global Terminal */

window.ShellPuppetPane = (() => {
  'use strict';

  const MIN_FONT_PX = 6;
  const MAX_FONT_PX = 40;
  const DEFAULT_FONT_PX = 13;
  const NOTICE_HISTORY_MS = 10000;
  const NOTICE_DECISION_MS = 1200;
  const NOTICE_COVER_MARGIN_MS = 20;
  const NOTICE_DELIVERY_GUARD_MS = 5;
  const NOTICE_QUIET_MS = 1000;
  const scaledEvents = new WeakSet();
  let scaledSelection = null;
  const cellMetrics = new Map();
  const fontListeners = new Set();
  let fontGeneration = 0;
  document.fonts?.addEventListener('loadingdone', () => {
    cellMetrics.clear();
    fontGeneration++;
    for (const refresh of fontListeners) refresh();
  });

  function remember(cache, key, value) {
    // Bound caches across font choices, window sizes and device scales.
    if (cache.size >= 256) cache.delete(cache.keys().next().value);
    cache.set(key, value);
    return value;
  }

  function clampFont(px) {
    return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, px));
  }

  /**
   * Create a pane for one session in one container.
   *
   * @param {Object} config
   * @param {HTMLElement} config.container - The element to host the terminal.
   * @param {string} config.sessionId - The session to connect to.
   * @param {boolean} [config.captureMode=false] - Headless screenshot mode.
   * @param {boolean} [config.redactedCapture=false] - Redact sensitive rows.
   * @param {Object} config.elements - References to badge elements.
   * @param {number|null} [config.initialFontOverride=null] - Initial font size.
   * @param {function} [config.onTitleChange] - Called when the window title should change.
   * @param {function} [config.onFontOverrideChange] - Called when the font override changes.
   * @param {function} [config.onGeometryReady] - Called after the first geometry frame.
   * @param {function} [config.onGeometryChange] - Called after each geometry frame.
   * @param {function} [config.onMetricsChange] - Called after font or device-scale metrics change.
   * @param {function} [config.onOutsideGeometry] - Called when another client changes an unheld grid.
   * @param {string} [config.dashboardProof] - Document proof for a dashboard stream.
   * @param {function} [config.onAttentionChange] - Reports prompt attention.
   * @returns {Object} A pane instance for the page to control.
   */
  function create(config) {
    const {
      container,
      sessionId,
      captureMode = false,
      redactedCapture = false,
      elements = {},
      initialFontOverride = null,
      onTitleChange = () => {},
      onFontOverrideChange = () => {},
      onGeometryReady = () => {},
      onGeometryChange = () => {},
      onMetricsChange = () => {},
      onOutsideGeometry = () => {},
      onGridTaken = () => {},
      dashboardProof = null,
      onAttentionChange = () => {},
    } = config;

    let fontOverride = initialFontOverride;
    let ws = null;
    let readOnly = false;
    let readOnlyEnforced = false;
    let retriesLeft = 8;
    let everConnected = false;
    let sessionEnded = false;
    let inputFailed = false;
    let promptWaiting = false;
    let providerStall = null;
    let gridCols = 0;
    let gridRows = 0;
    let gridMax = { cols: Infinity, rows: Infinity };
    let controlMode = 'adopt';
    let geometryDecided = false;
    let firstFrameSeen = false;
    let identityTitle = `${sessionId} · ShellPuppet`;
    let destroyed = false;
    let reconnectTimer = null;
    let pendingTakeGrid = false;
    let pendingTakeSize = null;
    let pendingTakeSocket = null;
    let followingExternal = false;
    let temporaryGeometry = false;
    let dashboardFontLimit = null;
    let fontScale = 1;
    const fittingFonts = new Map();
    let viewportSyncPending = false;

    const showBanner = (message) => {
      if (!elements.banner) return;
      const text = elements.banner.querySelector('.pane-banner-message') || elements.banner;
      text.textContent = message;
      elements.banner.hidden = false;
      positionNotices();
    };

    const refreshTitle = () => {
      const prefix = sessionEnded ? '[ENDED] ' : promptWaiting ? '[ANSWER ME] ' : providerStall ? '[STALLED] ' : '';
      onTitleChange(prefix + identityTitle);
    };
    refreshTitle();

    const showEnded = (exitCode) => {
      if (sessionEnded) return;
      sessionEnded = true;
      disposeNoticeTracking();
      if (elements.readonly) elements.readonly.disabled = true;
      const withCode = typeof exitCode === 'number';
      if (elements.readonly) {
        elements.readonly.title = withCode ? 'The program has exited' : 'The session has ended';
      }
      if (elements.modeHint) {
        elements.modeHint.textContent = withCode
          ? `the program has exited (code ${String(exitCode)}); this session no longer accepts input`
          : 'the session has ended: its output failed; it no longer accepts input';
      }
      refreshTitle();
    };

    const showInputFailed = () => {
      if (sessionEnded || inputFailed) return;
      inputFailed = true;
      if (elements.modeHint) {
        elements.modeHint.textContent = "this session's input has failed; kill it and start it again";
      }
    };

    const showIdentity = (identity) => {
      const purpose = identity.purpose || identity.label || sessionId;
      if (elements.identityPurpose) elements.identityPurpose.textContent = purpose;

      const meta = [identity.session, identity.command].filter(Boolean).join('  ·  ');
      if (elements.identityMeta) elements.identityMeta.textContent = meta;
      if (elements.identity) elements.identity.hidden = false;

      if (identity.startedBy && elements.sessionAgent) {
        elements.sessionAgent.textContent = `started by ${identity.startedBy}`;
      }

      if (identity.readOnly === true) {
        readOnlyEnforced = true;
        readOnly = true;
        showReadOnly();
      }

      if (identity.exited === true) showEnded(identity.exitCode);
      if (identity.inputFailed === true) showInputFailed();

      identityTitle = `${identity.session} ${purpose} · ShellPuppet`;
      refreshTitle();
    };

    const showPromptAlert = (question, waitingMs, options) => {
      const seconds = Math.round((waitingMs || 0) / 1000);
      if (!elements.promptAlert) return;
      elements.promptAlert.textContent = '';
      const heading = document.createElement('div');
      heading.textContent = `Waiting for you: ${String(seconds)}s unanswered`;
      const question_ = document.createElement('div');
      question_.className = 'question';
      question_.textContent = question || '(the session is holding a prompt)';
      elements.promptAlert.append(heading, question_);

      if (Array.isArray(options) && options.length > 0) {
        const list = document.createElement('ul');
        list.className = 'options';
        for (const option of options) {
          const item = document.createElement('li');
          item.textContent = option;
          list.append(item);
        }
        elements.promptAlert.append(list);
      }
      if (elements.promptAlert.hidden || noticeKind !== 'prompt') {
        noticeNewEpisode = noticeKind !== 'prompt' || noticeHiddenLong();
      }
      noticeKind = 'prompt';
      elements.promptAlert.hidden = false;
      positionNotices();
      promptWaiting = true;
      onAttentionChange(true);
      refreshTitle();
    };

    const clearPromptAlert = () => {
      promptWaiting = false;
      if (providerStall) { showStallAlert(providerStall); return; }
      if (!elements.promptAlert) return;
      if (!elements.promptAlert.hidden) noticeHiddenAt = window.performance.now();
      elements.promptAlert.hidden = true;
      elements.promptAlert.textContent = '';
      promptWaiting = false;
      onAttentionChange(false);
      refreshTitle();
    };

    const showStallAlert = (stalled) => {
      providerStall = stalled;
      if (!elements.promptAlert || promptWaiting) return;
      elements.promptAlert.textContent = `Stalled: ${stalled.reason} since ${stalled.since}. ${stalled.description}`;
      if (elements.promptAlert.hidden || noticeKind !== 'stall') {
        noticeNewEpisode = noticeKind !== 'stall' || noticeHiddenLong();
      }
      noticeKind = 'stall';
      elements.promptAlert.hidden = false;
      positionNotices();
      onAttentionChange(true);
      refreshTitle();
    };

    const clearStallAlert = () => {
      providerStall = null;
      if (!promptWaiting && elements.promptAlert) {
        if (!elements.promptAlert.hidden) noticeHiddenAt = window.performance.now();
        elements.promptAlert.hidden = true;
        elements.promptAlert.textContent = '';
      }
      onAttentionChange(promptWaiting);
      refreshTitle();
    };

    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontOverride ?? DEFAULT_FONT_PX,
      scrollback: 5000,
      allowProposedApi: true,
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
      theme: { background: '#0b0e14', foreground: '#c5cdd9', cursor: '#6cb6ff' },
    });
    term.open(container);
    let pendingWrites = 0;
    let terminalReleased = false;
    const releaseTerminal = () => {
      if (terminalReleased) return;
      terminalReleased = true;
      term.dispose();
    };
    // Closing a pane detaches it immediately. Its finite parser queue keeps
    // the terminal alive until the last callback, including geometry markers.
    const writeTerminal = (data, applied) => {
      if (destroyed) return;
      pendingWrites++;
      term.write(data, () => {
        pendingWrites--;
        if (!destroyed) applied?.();
        if (destroyed && pendingWrites === 0) window.queueMicrotask(releaseTerminal);
      });
    };
    const resizeTerminal = (cols, rows, force = false) => {
      if (destroyed) return;
      const apply = () => {
        if (force || term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      };
      if (pendingWrites === 0) apply();
      else writeTerminal('', apply);
    };
    let metricsFrame = null;
    const refreshFontMetrics = () => {
      if (destroyed || metricsFrame !== null) return;
      // Let xterm finish updating its renderer before measuring a new fit.
      metricsFrame = window.requestAnimationFrame(() => {
        metricsFrame = null;
        if (destroyed) return;
        term._core._charSizeService.measure();
        relayout(false);
        onMetricsChange();
      });
    };
    fontListeners.add(refreshFontMetrics);
    const resolutionListener = term._core._coreBrowserService.onDprChange(refreshFontMetrics);
    // xterm measures mouse positions in unscaled cells. Keep selection and
    // terminal mouse reports aligned when a tiny held screen needs scaling.
    const scaleMouseEvent = (event) => {
      if (fontScale === 1 || scaledEvents.has(event)) return;
      const inside = container.contains(event.target);
      if (event.type === 'mousedown' || event.type === 'pointerdown') scaledSelection = inside ? container : null;
      if (event.type === 'mousemove' && event.buttons === 0 && scaledSelection === container) scaledSelection = null;
      if (scaledSelection ? scaledSelection !== container : !inside) return;
      const screen = term.element?.querySelector('.xterm-screen');
      if (!screen) return;
      const rect = screen.getBoundingClientRect();
      const clientX = rect.left + (event.clientX - rect.left) / fontScale;
      const clientY = rect.top + (event.clientY - rect.top) / fontScale;
      // Keep the original event, target and pointer id so native capture works.
      // xterm's scrollbar uses page coordinates for its drag deltas. Native
      // offsetX/Y are already local to the transformed target; leave them alone.
      Object.defineProperties(event, {
        clientX: { value: clientX }, clientY: { value: clientY },
        pageX: { value: clientX + window.scrollX }, pageY: { value: clientY + window.scrollY },
        movementX: { value: event.movementX / fontScale }, movementY: { value: event.movementY / fontScale },
      });
      scaledEvents.add(event);
      if (['mouseup', 'pointerup', 'pointercancel'].includes(event.type)) scaledSelection = null;
    };
    const scaledMouseEvents = ['mousedown', 'mousemove', 'mouseup', 'wheel', 'contextmenu',
      'pointerdown', 'pointermove', 'pointerup', 'pointercancel'];
    for (const type of scaledMouseEvents) document.addEventListener(type, scaleMouseEvent, true);
    const outerScroll = container.parentElement;
    const helper = term.element?.querySelector('.xterm-helper-textarea');
    if (dashboardProof !== null && outerScroll && helper) {
      let view = { left: 0, top: 0 };
      let composing = false;
      const rememberView = () => {
        view = { left: outerScroll.scrollLeft, top: outerScroll.scrollTop };
      };
      const restoreView = () => {
        if (!outerScroll.classList.contains('grid-overflow')) return;
        outerScroll.scrollLeft = view.left;
        outerScroll.scrollTop = view.top;
      };
      const restoreAfterInput = () => {
        restoreView();
        window.requestAnimationFrame(restoreView);
      };
      const nativeFocus = helper.focus.bind(helper);
      helper.focus = (options) => {
        rememberView();
        nativeFocus({ ...options, preventScroll: true });
        restoreAfterInput();
      };
      outerScroll.addEventListener('pointerdown', rememberView, true);
      helper.addEventListener('focus', restoreAfterInput);
      helper.addEventListener('beforeinput', () => { if (!composing) rememberView(); });
      helper.addEventListener('input', restoreAfterInput);
      helper.addEventListener('compositionstart', () => { rememberView(); composing = true; restoreAfterInput(); });
      helper.addEventListener('compositionupdate', restoreAfterInput);
      helper.addEventListener('compositionend', () => { restoreAfterInput(); composing = false; });
    }
    const scrollOversizedPane = (event) => {
      if (!outerScroll?.classList.contains('grid-overflow') ||
          (!event.shiftKey && event.deltaX === 0)) return;
      event.preventDefault();
      event.stopPropagation();
      outerScroll.scrollLeft += event.deltaX;
      if (event.shiftKey) outerScroll.scrollTop += event.deltaY;
    };
    outerScroll?.addEventListener('wheel', scrollOversizedPane, { capture: true, passive: false });
    const platform = navigator.userAgentData?.platform || navigator.userAgent;
    const isMac = /Mac|iPhone|iPad/i.test(platform);
    // Let the browser deliver paste to xterm's textarea on Windows and Linux.
    term.attachCustomKeyEventHandler((event) => {
      if (destroyed) return false;
      if (isMac || event.type !== 'keydown' || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return true;
      if (event.key.toLowerCase() === 'v') return false;
      if (event.key.toLowerCase() === 'c' && term.hasSelection()) {
        event.preventDefault();
        if (typeof navigator.clipboard?.writeText !== 'function') {
          showBanner('Could not copy selected text to the clipboard.');
          return false;
        }
        const selection = term.getSelection();
        void navigator.clipboard.writeText(selection).then(() => {
          if (!destroyed && term.getSelection() === selection) term.clearSelection();
        }).catch(() => showBanner('Could not copy selected text to the clipboard.'));
        return false;
      }
      return true;
    });

    let noticeBottom = null;
    let noticeLastMove = null;
    let noticeLastRepaint = -Infinity;
    let noticeLegMoved = false;
    let noticeStayPreviousRepaint;
    let noticeStayEdge = null;
    let noticeStaySince = null;
    let noticeStayMoved = false;
    let noticeAnchor = null;
    let noticeCycle = null;
    let noticeCycleVisits = [];
    let noticeCycleMoves = 0;
    const noticeVisits = [];
    let noticeGeometry = null;
    let noticeSeen = false;
    let noticeNewEpisode = false;
    let noticeHiddenAt = null;
    // The kind of the last alert shown: a different kind is a new notice.
    let noticeKind = null;
    // An alert shown after the notice was hidden for the whole retained history
    // is a new notice: none of its cadence evidence remains. A shorter gap, such
    // as the daemon re-announcing a prompt whose choices a repaint changed,
    // keeps the cadence.
    const noticeHiddenLong = () => noticeHiddenAt === null ||
      window.performance.now() - noticeHiddenAt >= NOTICE_HISTORY_MS;
    let noticeFrame = null;
    let noticeTimer = null;
    let noticeEvidenceTimer = null;
    let noticeDisposed = false;

    function clearNoticeTimer() {
      clearTimeout(noticeTimer);
      noticeTimer = null;
      clearTimeout(noticeEvidenceTimer);
      noticeEvidenceTimer = null;
    }

    function trimNoticeVisits(now) {
      const cutoff = now - NOTICE_HISTORY_MS;
      while (noticeVisits.length > 1 && noticeVisits[1].since <= cutoff) noticeVisits.shift();
      if (noticeVisits.length && noticeVisits[0].since < cutoff) {
        noticeVisits[0].since = cutoff;
        noticeVisits[0].clipped = true;
      }
    }

    function noticeCoversRow(row, bottom) {
      if (!noticeGeometry) return false;
      const distance = bottom ? term.rows - row - 1 : row;
      return distance * noticeGeometry.cell < noticeGeometry.height - 0.01;
    }

    function noticeWeights(visits, now) {
      let top = 0, bottom = 0;
      for (let i = 0; i < visits.length; i++) {
        const visit = visits[i];
        const duration = Math.max(0, (visits[i + 1]?.since ?? now) - visit.since);
        if (noticeCoversRow(visit.row, false)) top += duration;
        if (noticeCoversRow(visit.row, true)) bottom += duration;
      }
      return { top, bottom };
    }

    function noticeClearEdge({ top, bottom }) {
      // Cursor events are observed after this pane's listener has run. Keep
      // a small clear lead beyond the ratio boundary for delivered evidence.
      if (top + NOTICE_DELIVERY_GUARD_MS <= bottom * 2 / 3 &&
          bottom - top >= NOTICE_COVER_MARGIN_MS) return false;
      if (bottom + NOTICE_DELIVERY_GUARD_MS <= top * 2 / 3 &&
          top - bottom >= NOTICE_COVER_MARGIN_MS) return true;
      return null;
    }

    function finishNoticeRest() {
      // A completed rectangle stay reclassifies an earlier move in any of
      // its rows. Rest follows do not spend the repaint budget.
      if (noticeStayPreviousRepaint !== undefined) {
        noticeLastRepaint = noticeStayPreviousRepaint;
        noticeStayPreviousRepaint = undefined;
      }
    }

    function rememberNoticeCycle(row, now) {
      if (row !== noticeAnchor || !noticeGeometry) return;
      // Keep the current anchor-return word outside the ten-second weight
      // window. A full delivered cycle can be longer than that window.
      let visits = noticeCycleVisits.map(visit => ({ ...visit }));
      if (!visits.length) return;
      const half = visits.length / 2;
      const repeated = Number.isInteger(half) && visits.slice(0, half).every((visit, i) =>
        visit.row === visits[i + half].row);
      if (repeated) visits = visits.slice(half);
      const duration = now - visits[0].since;
      const weights = noticeWeights(visits, now);
      let longestLeg = 0;
      for (let i = 0; i < visits.length; i++) {
        longestLeg = Math.max(longestLeg, (visits[i + 1]?.since ?? now) - visits[i].since);
      }
      noticeCycleMoves = 0;
      if (repeated) noticeCycleVisits = noticeCycleVisits.slice(half);
      if (weights.top <= 0 || weights.bottom <= 0) return;
      // A repeated row word renews its evidence even when delivery makes
      // this occurrence slightly shorter than the previous one.
      const sameWord = noticeCycle && visits.length === noticeCycle.visits.length &&
        visits.every((visit, i) => visit.row === noticeCycle.visits[i].row);
      if (!noticeCycle || sameWord || now - noticeCycle.end >= noticeCycle.validFor || duration >= noticeCycle.duration) {
        noticeCycle = { visits, end: now, duration,
          validFor: Math.max(NOTICE_HISTORY_MS, duration + longestLeg) };
      }
    }

    function placeNotices(now, immediate = false) {
      if (!noticeGeometry || noticeGeometry.height <= 0) return;
      const { notices, top, bottom } = noticeGeometry;
      const row = term.buffer.active.cursorY;
      noticeBottom ??= row < term.rows / 2;
      trimNoticeVisits(now);
      const quiet = noticeStayEdge !== null && now - noticeStaySince >= NOTICE_QUIET_MS;
      if (quiet) finishNoticeRest();
      if (!noticeLegMoved && (noticeStayEdge === null || !noticeStayMoved)) {
        let destination = noticeBottom;
        const initial = !noticeVisits.length || (immediate && noticeVisits.length === 1);
        if (initial || quiet) {
          if (noticeCoversRow(row, noticeBottom)) destination = !noticeBottom;
        } else if (now - noticeVisits[0].since >= NOTICE_DECISION_MS &&
            now - noticeLastRepaint >= NOTICE_HISTORY_MS && noticeCycleMoves === 0) {
          const whole = noticeClearEdge(noticeWeights(noticeVisits, now));
          // A short complete cycle represents a repeated cadence. Apply the
          // absolute margin over the decision horizon, so a 24/9 ms cycle
          // cannot veto a clear lead accumulated across many repetitions.
          const cycle = noticeCycle && now - noticeCycle.end < noticeCycle.validFor ? (() => {
            const weights = noticeWeights(noticeCycle.visits, noticeCycle.end);
            const scale = Math.max(1, NOTICE_DECISION_MS / Math.max(1, noticeCycle.duration));
            return noticeClearEdge({ top: weights.top * scale, bottom: weights.bottom * scale });
          })() : undefined;
          // Whole-history hysteresis and the absolute budget apply even at
          // startup. A retained cycle can veto a move, never authorise
          // one against the whole history.
          if (whole !== null && (cycle === undefined || cycle === whole)) {
            destination = whole;
          }
        }
        if (destination !== noticeBottom && !noticeCoversRow(row, destination)) {
          noticeBottom = destination;
          noticeLegMoved = true;
          if (noticeStayEdge !== null) noticeStayMoved = true;
          if (!initial && !quiet) {
            if (noticeStayEdge !== null && noticeStayPreviousRepaint === undefined) {
              noticeStayPreviousRepaint = noticeLastRepaint;
            }
            noticeLastRepaint = now;
            noticeCycleMoves++;
          }
        }
      }
      notices.style.top = noticeBottom ? 'auto' : `${String(top)}px`;
      notices.style.bottom = noticeBottom ? `${String(bottom)}px` : 'auto';
    }

    // Cursor events record occupancy without measuring the DOM. A frame
    // coalesces placement decisions and uses the last measured geometry.
    function sampleNoticeCursor() {
      noticeFrame = null;
      if (destroyed || sessionEnded) return;
      const now = window.performance.now();
      placeNotices(now);
      // Watch frames continuously near a rest deadline. The first completed
      // frame after it can then place the notice without a late timer hop.
      if (noticeStayEdge !== null && now - noticeStaySince >= NOTICE_QUIET_MS - 100 &&
          now - noticeStaySince < NOTICE_QUIET_MS) {
        noticeFrame = window.requestAnimationFrame(sampleNoticeCursor);
      }
    }

    function settleNoticeCursor() {
      noticeTimer = null;
      if (destroyed || sessionEnded) return;
      // Timer deadlines can round down relative to performance.now(). Do not
      // consume the only quiet check a fraction before its deadline.
      const remaining = NOTICE_QUIET_MS - (window.performance.now() - noticeStaySince);
      if (remaining > 100) {
        noticeTimer = setTimeout(settleNoticeCursor, remaining - 100);
        return;
      }
      if (noticeFrame === null) noticeFrame = window.requestAnimationFrame(sampleNoticeCursor);
      if (remaining > 0) {
        // The armed frame can start just before the deadline and finish just
        // after it. Check at the deadline too, before that frame is delivered.
        noticeTimer = setTimeout(settleNoticeCursor, remaining);
      } else {
        placeNotices(window.performance.now());
      }
    }

    function checkNoticeEvidence() {
      noticeEvidenceTimer = null;
      if (destroyed || sessionEnded || (noticeStayEdge !== null &&
          window.performance.now() - noticeStaySince >= NOTICE_QUIET_MS)) return;
      // An active leg accumulates covered time even without cursor events.
      // Bound decision latency without adding DOM measurements or a timer
      // that continues after rest, disposal or the session ending.
      if (noticeFrame === null) noticeFrame = window.requestAnimationFrame(sampleNoticeCursor);
      noticeEvidenceTimer = setTimeout(checkNoticeEvidence, 50);
    }

    function scheduleNoticeCursor() {
      if (destroyed || sessionEnded) return;
      const row = term.buffer.active.cursorY;
      // Horizontal typing and animation cannot distinguish a repaint from
      // rest. Only a new row starts another leg or restarts the quiet timer.
      const now = window.performance.now();
      if (noticeVisits[noticeVisits.length - 1]?.row === row) return;
      const edge = noticeCoversRow(row, false) ? 'top' : noticeCoversRow(row, true) ? 'bottom' : null;
      if (noticeStayEdge !== null && edge !== noticeStayEdge && now - noticeStaySince >= NOTICE_QUIET_MS) {
        // A genuine rest ends the preceding repaint. Its idle time must not
        // outweigh the evidence delivered by the next staged redraw.
        // Retain a zero-duration boundary so a later layout is not mistaken
        // for the first placement of a newly shown notice.
        noticeVisits.splice(0, noticeVisits.length - 1);
        if (noticeVisits.length) noticeVisits[0].since = now;
        finishNoticeRest();
        noticeCycle = null;
        noticeCycleVisits = [];
        noticeCycleMoves = 0;
        noticeAnchor = edge === null ? null : row;
      }
      if (edge !== noticeStayEdge) {
        noticeStayEdge = edge;
        noticeStaySince = edge === null ? null : now;
        noticeStayMoved = false;
        noticeStayPreviousRepaint = undefined;
      }
      trimNoticeVisits(now);
      // An uncovered preparation row can recur within a longer repaint.
      // Anchor a complete cycle at the first row inside either rectangle.
      if (noticeAnchor === null && edge !== null) {
        noticeAnchor = row;
        noticeCycleVisits = [];
        noticeCycleMoves = 0;
      }
      rememberNoticeCycle(row, now);
      noticeLegMoved = false;
      noticeVisits.push({ row, since: now });
      if (noticeAnchor !== null) noticeCycleVisits.push({ row, since: now });
      trimNoticeVisits(now);
      noticeLastMove = now;
      clearNoticeTimer();
      // The final move must win even when no more cursor events arrive.
      if (noticeStayEdge !== null) noticeTimer = setTimeout(settleNoticeCursor,
        Math.max(0, NOTICE_QUIET_MS - (now - noticeStaySince) - 100));
      noticeEvidenceTimer = setTimeout(checkNoticeEvidence, 50);
      if (noticeFrame === null) noticeFrame = window.requestAnimationFrame(sampleNoticeCursor);
    }

    function disposeNoticeTracking() {
      if (noticeDisposed) return;
      noticeDisposed = true;
      noticeCursorListener.dispose();
      noticeResizeObserver.disconnect();
      if (noticeFrame !== null) window.cancelAnimationFrame(noticeFrame);
      noticeFrame = null;
      clearNoticeTimer();
      noticeVisits.length = 0;
    }

    // Alerts and layout changes measure once and place from existing evidence.
    // A held grid can be centred, so anchor to its screen, not the outer box.
    function positionNotices(initialPlacement = false) {
      if (destroyed) return;
      const notices = elements.promptAlert?.parentElement || elements.banner?.parentElement;
      const wrap = container.parentElement;
      const screen = term.element?.querySelector('.xterm-screen');
      if (!notices || !wrap || !screen || term.rows < 1) return;
      const screenRect = screen.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      notices.style.maxHeight = `${String(screenRect.height / 3)}px`;
      const noticeHeight = notices.getBoundingClientRect().height;
      const firstVisibleNotice = (!noticeSeen || noticeNewEpisode) && noticeHeight > 0;
      if (noticeHeight > 0) { noticeSeen = true; noticeNewEpisode = false; }
      noticeGeometry = { notices, top: screenRect.top - wrapRect.top,
        bottom: wrapRect.bottom - screenRect.bottom, cell: screenRect.height / term.rows,
        height: noticeHeight };
      const now = window.performance.now();
      const row = term.buffer.active.cursorY;
      if (firstVisibleNotice && !sessionEnded) {
        // Cursor time before a notice exists cannot decide its repaint edge.
        noticeVisits.length = 0;
        noticeVisits.push({ row, since: now });
        noticeLastRepaint = -Infinity;
        noticeLegMoved = false;
        noticeStayPreviousRepaint = undefined;
        noticeStayEdge = null;
        noticeStaySince = null;
        noticeStayMoved = false;
        noticeAnchor = null;
        noticeCycle = null;
        noticeCycleVisits = [];
        noticeCycleMoves = 0;
      }
      const edge = noticeCoversRow(row, false) ? 'top' : noticeCoversRow(row, true) ? 'bottom' : null;
      if (edge !== noticeStayEdge) {
        noticeStayEdge = edge;
        noticeStaySince = edge === null ? null : now;
        noticeStayMoved = false;
        noticeStayPreviousRepaint = undefined;
        clearNoticeTimer();
        if (edge !== null && !noticeDisposed) noticeTimer = setTimeout(settleNoticeCursor, NOTICE_QUIET_MS - 100);
      }
      // A repeated prompt control or resize must use the existing cadence.
      // Only first visibility (including an alert after a hidden period longer
      // than the retained history) and a completed snapshot can place immediately.
      placeNotices(now, firstVisibleNotice || initialPlacement === true);
    }
    const noticeCursorListener = term.onCursorMove(scheduleNoticeCursor);
    // Content can change height without a cursor move (including font loads).
    const noticeResizeObserver = new window.ResizeObserver(positionNotices);
    const noticeContainer = elements.promptAlert?.parentElement || elements.banner?.parentElement;
    if (noticeContainer) noticeResizeObserver.observe(noticeContainer);
    positionNotices();

    if (redactedCapture) {
      window.__shellpuppetCoverRows = (hiddenRows) => {
        const rows = container.querySelectorAll('.xterm-rows > div');
        for (const index of hiddenRows) {
          const row = rows[index];
          if (!row) continue;
          const rect = row.getBoundingClientRect();
          row.style.filter = 'blur(20px)';
          const cover = document.createElement('div');
          cover.style.cssText =
            `position:fixed;left:0;top:${rect.top}px;width:100vw;height:${rect.height}px;` +
            'z-index:2147483647;pointer-events:none;background:rgba(20,20,20,.97);' +
            'backdrop-filter:blur(20px);color:#d0d0d0;font:11px sans-serif;';
          cover.textContent = hiddenRows.includes(index - 1) ? '' : 'reasoning hidden';
          document.body.append(cover);
        }
      };
    }

    term.onData((data) => {
      if (destroyed || sessionEnded || readOnly) return;
      if (ws && ws.readyState === 1) ws.send(data);
    });

    function showReadOnly() {
      if (!elements.readonly) return;
      elements.readonly.textContent = `read-only: ${readOnly ? 'on' : 'off'}`;
      elements.readonly.classList.toggle('active', readOnly);
      if (sessionEnded || inputFailed) return;
      if (readOnlyEnforced) {
        elements.readonly.disabled = true;
        elements.readonly.title = 'This viewer link grants watching only';
        if (elements.modeHint) {
          elements.modeHint.textContent = 'read-only link: the session will not accept your keystrokes';
        }
        return;
      }
      if (elements.modeHint) {
        elements.modeHint.textContent = readOnly
          ? 'read-only: your keystrokes stay local'
          : 'you and the agent share this session: type freely';
      }
    }

    function relayout(deliberate) {
      if (destroyed) return;
      if (!geometryDecided) return;
      if (dashboardProof !== null) {
        applyFontPreference(gridCols, gridRows);
        positionNotices();
        return;
      }
      if (controlMode === 'held' || captureMode || (controlMode === 'adopt' && !deliberate)) {
        applyFontPreference(gridCols, gridRows);
      } else {
        requestFit();
      }
      positionNotices();
    }

    function requestFit() {
      const font = drivingFontPx();
      if (term.options.fontSize !== font) {
        term.options.fontSize = font;
        resizeTerminal(term.cols, term.rows, true);
      }
      updateZoomButtons();
      const proposed = propose();
      if (proposed === null) return;
      const cols = Math.min(proposed.cols, gridMax.cols);
      const rows = Math.min(proposed.rows, gridMax.rows);
      if (cols === gridCols && rows === gridRows && controlMode !== 'adopt') return;
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    }

    function propose() {
      return proposeAtFont(term.options.fontSize);
    }

    function fixedFontPx() {
      return fontOverride === null ? DEFAULT_FONT_PX : fontOverride;
    }

    function proposeAtFont(font) {
      const style = window.getComputedStyle(container);
      const terminalStyle = window.getComputedStyle(term.element);
      const width = parseInt(style.width) - parseInt(terminalStyle.paddingLeft) - parseInt(terminalStyle.paddingRight) -
        (term.options.scrollback === 0 ? 0 : term.options.overviewRuler?.width || 14);
      const height = parseInt(style.height) - parseInt(terminalStyle.paddingTop) - parseInt(terminalStyle.paddingBottom);
      if (!(width > 0 && height > 0)) return null;
      // Use the unrounded cell in both clients. The DOM renderer rounds the
      // whole canvas, so its CSS cell width changes with the current grid and
      // can make a viewer request another resize on the geometry reply.
      const cell = renderedCell(font);
      if (!cell) return null;
      let cols = Math.floor(width / cell.width);
      let rows = Math.floor(height / cell.height);
      // Include every whole cell whose rounded canvas fits, as gridFitsAtFont
      // does, without depending on the current grid's rounded average cell.
      while (Math.round((cols + 1) * cell.width) <= width) cols++;
      while (Math.round((rows + 1) * cell.height) <= height) rows++;
      return { cols: Math.max(2, cols), rows: Math.max(1, rows) };
    }

    function proposeDashboardGrid() {
      let proposed = proposeAtFont(fixedFontPx());
      if (proposed === null) return null;
      if (proposed.cols > gridMax.cols || proposed.rows > gridMax.rows) {
        for (let font = fixedFontPx() + 1; font <= MAX_FONT_PX; font++) {
          const larger = proposeAtFont(font);
          if (larger === null ||
              (larger.cols < gridMax.cols && larger.rows < gridMax.rows)) break;
          proposed = larger;
        }
      }
      return proposed;
    }

    function drivingFontPx() {
      const fixed = fixedFontPx();
      const drawn = term.options.fontSize;
      let font = fixed;
      try {
        for (; font < MAX_FONT_PX; font++) {
          term.options.fontSize = font;
          const proposed = propose();
          if (proposed === null) break;
          if (proposed.cols <= gridMax.cols && proposed.rows <= gridMax.rows) break;
        }
      } finally {
        term.options.fontSize = drawn;
      }
      return font;
    }

    function availableSpace() {
      const wrap = container.parentElement;
      if (!wrap) return null;
      const styles = window.getComputedStyle(wrap);
      const width = wrap.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
      const height = wrap.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
      return width > 0 && height > 0 ? { width, height } : null;
    }

    function fontSettings() {
      const options = term.options;
      return JSON.stringify([fontGeneration, window.devicePixelRatio, options.fontFamily,
        options.fontWeight, options.fontWeightBold, options.letterSpacing, options.lineHeight]);
    }

    function renderedCell(font) {
      const key = `${fontSettings()}:${font}`;
      if (cellMetrics.has(key)) return cellMetrics.get(key);
      const drawn = term.options.fontSize;
      try {
        term.options.fontSize = font;
        // xterm's DOM renderer rounds the complete canvas to CSS pixels. Cache
        // the unrounded cell so a different grid cannot inherit that rounding.
        const cell = term._core._renderService.dimensions.device.cell;
        const dpr = window.devicePixelRatio;
        if (!(cell.width > 0 && cell.height > 0)) return null;
        return remember(cellMetrics, key, { width: cell.width / dpr, height: cell.height / dpr });
      } finally {
        term.options.fontSize = drawn;
      }
    }

    function gridFitsAtFont(cols, rows, font, space) {
      const cell = renderedCell(font);
      return cell !== null && Math.round(cell.width * cols) <= space.width &&
        Math.round(cell.height * rows) <= space.height;
    }

    function largestFittingFont(cols, rows, maximum = MAX_FONT_PX, minimum = MIN_FONT_PX) {
      const space = availableSpace();
      if (!space || cols <= 0 || rows <= 0) return null;
      const key = JSON.stringify([fontSettings(), space.width, space.height, cols, rows, maximum, minimum]);
      if (fittingFonts.has(key)) return fittingFonts.get(key);
      let low = minimum;
      let high = maximum;
      let best = 0;
      while (low <= high) {
        const font = Math.floor((low + high) / 2);
        if (gridFitsAtFont(cols, rows, font, space)) {
          best = font;
          low = font + 1;
        } else high = font - 1;
      }
      if (best === 0 && minimum === 1) {
        // Even one pixel per row can exceed a very small held pane.
        // Scale that minimum uniformly so its whole screen remains visible.
        const cell = renderedCell(1);
        if (cell) {
          best = Math.min(maximum, space.width / Math.round(cell.width * cols),
            space.height / Math.round(cell.height * rows));
        }
      }
      return remember(fittingFonts, key, best || minimum);
    }

    function belowDashboardFloor(cols = 80, rows = 24) {
      const space = availableSpace();
      if (!space) return false;
      return !gridFitsAtFont(cols, rows, fixedFontPx(), space);
    }

    function fitGridByFont(cols, rows, maximum = MAX_FONT_PX) {
      const font = largestFittingFont(cols, rows, maximum, dashboardProof === null ? MIN_FONT_PX : 1);
      if (font !== null) drawFont(font);
    }

    function drawFont(font) {
      term.options.fontSize = Math.max(1, font);
      fontScale = Math.min(1, font);
      if (fontScale === 1 && scaledSelection === container) scaledSelection = null;
      term.element.style.transform = fontScale < 1 ? `scale(${fontScale})` : '';
      container.dataset.fontSize = String(font);
      // Font measurement can leave xterm's history viewport at a candidate's
      // dimensions. Sync once after the final display size, then restore the
      // history row with the new cell height. Both callbacks run after render.
      if (!viewportSyncPending) {
        viewportSyncPending = true;
        term._core._viewport.queueSync();
        term._core._renderService.addRefreshCallback(() => {
          viewportSyncPending = false;
          // Terminal.scrollToLine is a no-op when the buffer is already on
          // this row, even if the viewport still has the old pixel offset.
          // Read the row now so output received before paint is kept too.
          if (!destroyed) term._core._viewport.scrollToLine(term.buffer.active.viewportY, true);
        });
      }
    }

    function updateOverflowState() {
      if (dashboardProof === null) return;
      const wrap = container.parentElement;
      const screen = term.element?.querySelector('.xterm-screen');
      if (!wrap || !screen) return;
      const styles = window.getComputedStyle(wrap);
      const availableWidth = wrap.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
      const availableHeight = wrap.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
      const overflowing = controlMode !== 'yours' && term.options.fontSize === MIN_FONT_PX &&
        (screen.offsetWidth > availableWidth + 1 || screen.offsetHeight > availableHeight + 1);
      wrap.classList.toggle('grid-overflow', overflowing);
      if (elements.overflowNote) elements.overflowNote.hidden = !overflowing;
    }

    function applyFontPreference(cols, rows) {
      if (dashboardProof !== null && dashboardFontLimit !== null) {
        const font = largestFittingFont(cols, rows, dashboardFontLimit, 1);
        if (font !== null) drawFont(font);
      } else if (fontOverride === null) {
        fitGridByFont(cols, rows);
      } else if (dashboardProof !== null) {
        const capped = cols >= gridMax.cols || rows >= gridMax.rows;
        // Retained owned grids must still fit when Auto fit is off. The saved
        // size is the ceiling unless an owned grid has reached its size cap.
        fitGridByFont(cols, rows, capped && controlMode === 'yours' ? MAX_FONT_PX : fontOverride);
      } else {
        drawFont(fontOverride);
      }
      updateZoomButtons();
      updateOverflowState();
    }

    function applyGeometry(cols, rows, max) {
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
      const resized = term.cols !== cols || term.rows !== rows;
      gridCols = cols;
      gridRows = rows;
      if (max && Number.isInteger(max.cols) && Number.isInteger(max.rows)) {
        gridMax = { cols: max.cols, rows: max.rows };
      }
      // Compare at the parser boundary: another geometry frame may be queued.
      resizeTerminal(cols, rows);
      if (resized) {
        // A resize during a header excursion must not discard the prompt's
        // occupancy. Clamp rows lost from a smaller grid; subsequent cursor
        // events and the quiet fallback account for the arriving snapshot.
        for (const visit of noticeVisits) visit.row = Math.min(visit.row, rows - 1);
      }
      if (controlMode === 'yours' && !captureMode && dashboardProof === null) {
        updateZoomButtons();
      } else {
        applyFontPreference(cols, rows);
      }
      if (elements.size) {
        elements.size.textContent =
          `${cols}×${rows}` +
          (controlMode === 'held' ? ' (fixed)' : controlMode === 'adopt' ? ' (following)' : '');
      }
      positionNotices();
      onGeometryChange();
    }

    function updateZoomButtons() {
      if (!elements.zoomAuto) return;
      elements.zoomAuto.classList.toggle('active', fontOverride === null);
      elements.zoomAuto.title = fontOverride === null
        ? 'Text size chosen automatically (click - or + to set it yourself)'
        : 'Choose the text size automatically again';
    }

    function setFontOverride(value) {
      if (destroyed) return;
      fontOverride = value;
      onFontOverrideChange(value);
      if (dashboardProof !== null) {
        applyFontPreference(gridCols, gridRows);
        positionNotices();
        return;
      }
      if (controlMode === 'held' || captureMode) {
        applyFontPreference(gridCols, gridRows);
        positionNotices();
        return;
      }
      requestFit();
      positionNotices();
    }

    function nudgeFont(delta) {
      const base = term.options.fontSize || DEFAULT_FONT_PX;
      setFontOverride(clampFont(base + delta));
    }

    function showInputSource(source) {
      if (!elements.inputSource) return;
      const who = source === 'human' ? 'human' : 'agent';
      const at = new Date().toLocaleTimeString();
      elements.inputSource.textContent = `last input: ${who} ${at}`;
      elements.inputSource.className = `hint ${who}`;
    }

    function connect() {
      if (destroyed) return;
      ws = new WebSocket(`ws://${location.host}/sessions/${encodeURIComponent(sessionId)}/stream`,
        dashboardProof === null ? undefined : [`sp-csrf.${dashboardProof}`]);
      const socket = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        if (destroyed) return;
        // A reconnect may have missed a clear. The daemon replays the current
        // prompt and stall with a fresh snapshot, so drop both and place what
        // it replays as a new notice from that snapshot.
        const reconnected = everConnected;
        if (reconnected) {
          promptWaiting = false;
          firstFrameSeen = false;
        }
        clearStallAlert();
        if (reconnected) noticeHiddenAt = null;
        everConnected = true;
        if (elements.dot) elements.dot.classList.remove('off');
        if (elements.banner) elements.banner.hidden = true;
        retriesLeft = 8;
        geometryDecided = false;
        if (pendingTakeSocket !== socket) {
          pendingTakeGrid = false;
          pendingTakeSize = null;
          pendingTakeSocket = null;
        }
      };

      ws.onmessage = (event) => {
        if (destroyed) return;
        if (event.data instanceof ArrayBuffer) {
          if (redactedCapture && window.__shellpuppetPainted === true) return;
          if (!firstFrameSeen) {
            firstFrameSeen = true;
            writeTerminal(new Uint8Array(event.data), () => {
              if (destroyed) return;
              // Snapshot parsing is asynchronous and may follow an ended
              // identity or an alert. Its intermediate rows are not repaint
              // history. Place once at its final cursor, even after tracking
              // has been disposed; ordinary stream chunks need no layout.
              noticeVisits.length = 0;
              noticeLegMoved = false;
              noticeStayPreviousRepaint = undefined;
              noticeLastRepaint = -Infinity;
              noticeCycle = null;
              noticeAnchor = null;
              noticeCycleVisits = [];
              noticeCycleMoves = 0;
              noticeStayEdge = null;
              noticeStaySince = null;
              noticeStayMoved = false;
              if (!noticeDisposed) {
                noticeLastMove = window.performance.now();
                noticeVisits.push({ row: term.buffer.active.cursorY, since: noticeLastMove });
              }
              positionNotices(true);
              if (!captureMode) return;
              window.requestAnimationFrame(() => {
                if (destroyed) return;
                window.requestAnimationFrame(() => {
                  if (destroyed) return;
                  window.__shellpuppetPainted = true;
                });
              });
            });
            return;
          }
          writeTerminal(new Uint8Array(event.data));
          return;
        }
        try {
          const control = JSON.parse(event.data);
          if (control && control.type === 'input-source') {
            showInputSource(control.source);
          } else if (control && control.type === 'geometry') {
            const firstGeometry = !geometryDecided;
            geometryDecided = true;
            controlMode = captureMode ? 'adopt' : control.control || 'adopt';
            temporaryGeometry = control.temporary === true;
            if (pendingTakeSocket !== null && pendingTakeSocket !== socket) {
              pendingTakeGrid = false;
              pendingTakeSize = null;
              pendingTakeSocket = null;
            }
            if (controlMode === 'held') {
              pendingTakeGrid = false;
              pendingTakeSize = null;
              pendingTakeSocket = null;
            }
            if (dashboardProof !== null && firstGeometry && controlMode === 'yours') {
              followingExternal = false;
              pendingTakeGrid = false;
              pendingTakeSize = null;
              pendingTakeSocket = null;
              onGridTaken();
            }
            if (dashboardProof !== null && (!firstGeometry || control.owned === true)) {
              if (controlMode === 'yours' && pendingTakeGrid) {
                followingExternal = false;
                pendingTakeGrid = false;
                pendingTakeSize = null;
                pendingTakeSocket = null;
                onGridTaken();
              } else if (controlMode === 'adopt' && !followingExternal &&
                  control.dashboardTransferable !== true) {
                pendingTakeGrid = false;
                pendingTakeSize = null;
                pendingTakeSocket = null;
                followingExternal = true;
                onOutsideGeometry();
              } else if (controlMode === 'adopt' && control.dashboardTransferable === true && followingExternal) {
                followingExternal = false;
                onGeometryReady();
              }
            }
            applyGeometry(control.cols, control.rows, control.max);
            if (firstGeometry) onGeometryReady();
            if (controlMode === 'yours' && !temporaryGeometry && !captureMode && dashboardProof === null) requestFit();
          } else if (control && control.type === 'identity') {
            showIdentity(control);
          } else if (control && control.type === 'exited') {
            pendingTakeGrid = false;
            pendingTakeSize = null;
            pendingTakeSocket = null;
            showEnded(control.exitCode);
          } else if (control && control.type === 'input-refused') {
            if (control.reason === 'exited') showEnded(control.exitCode);
            else if (control.reason === 'input-failed') showInputFailed();
          } else if (control && control.type === 'prompt-stall') {
            showPromptAlert(control.question, control.waitingMs, control.options);
          } else if (control && control.type === 'prompt-clear') {
            clearPromptAlert();
          } else if (control && control.type === 'session-stalled') {
            showStallAlert(control.stalled);
          } else if (control && control.type === 'session-stall-clear') {
            clearStallAlert();
          }
        } catch {
          // Unknown text frame: ignore rather than corrupt the terminal.
        }
      };

      ws.onclose = () => {
        if (pendingTakeSocket === socket) {
          pendingTakeGrid = false;
          pendingTakeSize = null;
          pendingTakeSocket = null;
        }
        if (destroyed) return;
        if (elements.dot) elements.dot.classList.add('off');
        if (retriesLeft-- > 0) {
          reconnectTimer = setTimeout(connect, 2000);
        } else {
          showBanner(
            everConnected
              ? 'Disconnected. The session has probably ended or this viewer link has been revoked. ' +
                  'Ask the agent for a fresh viewer URL if the session is still running.'
              : 'Could not connect. A viewer link works once, and only for a few minutes. ' +
                  'Ask the agent for a fresh viewer URL.',
          );
        }
      };
    }

    updateZoomButtons();
    showReadOnly();
    connect();

    return {
      destroy(reassigned = false) {
        if (destroyed) return;
        destroyed = true;
        fontListeners.delete(refreshFontMetrics);
        resolutionListener.dispose();
        if (metricsFrame !== null) window.cancelAnimationFrame(metricsFrame);
        disposeNoticeTracking();
        if (scaledSelection === container) scaledSelection = null;
        for (const type of scaledMouseEvents) document.removeEventListener(type, scaleMouseEvent, true);
        outerScroll?.removeEventListener('wheel', scrollOversizedPane, true);
        clearTimeout(reconnectTimer);
        if (ws) {
          if (reassigned && dashboardProof !== null && ws.readyState === 1)
            ws.send(JSON.stringify({ type: 'release-grid' }));
          ws.close();
        }
        if (redactedCapture) delete window.__shellpuppetCoverRows;
        if (pendingWrites === 0) releaseTerminal();
      },
      setFontOverride(value) {
        setFontOverride(value);
      },
      nudgeFont(delta) {
        if (destroyed) return;
        nudgeFont(delta);
      },
      getFontOverride() {
        return fontOverride;
      },
      relayout(deliberate) {
        relayout(deliberate);
      },
      setReadOnly(value) {
        if (readOnlyEnforced) return;
        readOnly = value;
        showReadOnly();
      },
      isReadOnly() {
        return readOnly;
      },
      isReadOnlyEnforced() {
        return readOnlyEnforced;
      },
      getTerminal() {
        return term;
      },
      getGrid() {
        return { cols: gridCols, rows: gridRows };
      },
      belowDashboardFloor() {
        if (destroyed) return false;
        return belowDashboardFloor();
      },
      floorFontSize() {
        if (destroyed) return null;
        return largestFittingFont(80, 24, MAX_FONT_PX, 1);
      },
      setDashboardFontLimit(font) {
        if (destroyed) return;
        dashboardFontLimit = font;
        if (geometryDecided) applyFontPreference(gridCols, gridRows);
        positionNotices();
      },
      autoFitGrid(floorCols = 80, floorRows = 24, force = false) {
        if (destroyed) return false;
        if (dashboardProof === null || controlMode === 'held' || (temporaryGeometry && !force) ||
            (followingExternal && !force) || !geometryDecided ||
            !ws || ws.readyState !== 1 || sessionEnded) return false;
        if (force) {
          followingExternal = false;
        }
        let proposed = proposeDashboardGrid();
        if (proposed === null) {
          if (container.clientWidth <= 0 || container.clientHeight <= 0) return false;
          proposed = { cols: floorCols, rows: floorRows };
        }
        const belowFloor = belowDashboardFloor(floorCols, floorRows);
        const cols = Math.min(gridMax.cols, belowFloor ? floorCols : Math.max(floorCols, proposed.cols));
        const rows = Math.min(gridMax.rows, belowFloor ? floorRows : Math.max(floorRows, proposed.rows));
        if (cols === gridCols && rows === gridRows && !force) return false;
        if (pendingTakeSocket === ws && pendingTakeSize?.cols === cols && pendingTakeSize?.rows === rows) return false;
        return this.takeGrid(cols, rows);
      },
      isTemporaryGeometry() { return temporaryGeometry; },
      takeGrid(cols, rows) {
        if (destroyed) return false;
        if (dashboardProof === null || !ws || ws.readyState !== 1 || !geometryDecided) return false;
        const wanted = { cols: Math.max(2, Math.min(400, cols)), rows: Math.max(2, Math.min(150, rows)) };
        pendingTakeGrid = true;
        pendingTakeSize = wanted;
        pendingTakeSocket = ws;
        ws.send(JSON.stringify({ type: 'resize', ...wanted, take: true }));
        return true;
      },
      fitGrid(floorCols = 80, floorRows = 24) {
        if (destroyed) return false;
        if (dashboardProof === null) return false;
        followingExternal = false;
        const proposed = proposeDashboardGrid();
        if (belowDashboardFloor(floorCols, floorRows)) return this.takeGrid(floorCols, floorRows);
        return proposed !== null && this.takeGrid(
          Math.max(floorCols, proposed.cols), Math.max(floorRows, proposed.rows));
      },
      fitAfterDrag(useAutoFit) {
        if (controlMode === 'held' || captureMode || !geometryDecided) return false;
        // A deliberate drag still takes its grid when the floor is unchanged.
        return useAutoFit ? this.autoFitGrid(80, 24, true) : this.fitGrid(80, 24);
      },
    };
  }

  return { create };
})();

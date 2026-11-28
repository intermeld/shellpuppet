/**
 * ShellPuppet pane: the terminal client for one session in one container.
 *
 * It owns frame handling, input (with term.onData and term.onBinary registered once), sizing,
 * reconnect and badges for one session. The page provides the container and
 * badge elements, and wires up its controls.
 *
 * Wire protocol: BINARY WebSocket frames carry terminal bytes (snapshots, the
 * live stream and the exit notice); TEXT frames are JSON control messages:
 * `identity`, `geometry`, `input-source`, `input-refused`, `exited`,
 * `prompt-stall`, `prompt-clear`, `session-stalled` and `session-stall-clear`.
 * This pane sends text frames for JSON controls and onData input, and binary
 * frames for onBinary input. The latter contains one byte per character.
 *
 * Three rules shape the pane:
 * - `term.onData` and `term.onBinary` are registered exactly ONCE, outside the connect path.
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
  const MAX_CLIPBOARD_BYTES = 1024 * 1024;
  const MAX_CLIPBOARD_DISPATCH_MS = 1000;
  const CLIPBOARD_GESTURE_MS = 2000;
  const CLIPBOARD_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown',
    'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
  // A printable base (including space or a supplementary character) can carry combining marks.
  const PRINTABLE_KEY = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]\p{M}*$/u;
  const recentClipboardAge = (age, limit = CLIPBOARD_GESTURE_MS) => age >= 0 && age <= limit;
  const scaledEvents = new WeakSet();
  const wheelViewportPositions = new WeakMap();
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

  function decodeClipboard(data) {
    const start = data.startsWith('c;') ? 2 : data.startsWith(';') ? 1 : 0;
    if (!start || data.length - start > 4 * Math.ceil(MAX_CLIPBOARD_BYTES / 3)) return null;
    const encoded = data.slice(start);
    if (encoded.length % 4 !== 0) return null;
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    if (encoded.length / 4 * 3 - padding > MAX_CLIPBOARD_BYTES) return null;
    try {
      const binary = window.atob(encoded);
      // atob also accepts whitespace and non-zero padding bits.
      if (window.btoa(binary) !== encoded) return null;
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new window.TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch { return null; }
  }

  /**
   * Create a pane for one session in one container.
   *
   * @param {Object} config
   * @param {HTMLElement} config.container - The element to host the terminal.
   * @param {string} config.sessionId - The session to connect to.
   * @param {boolean} [config.captureMode=false] - Headless screenshot mode.
   * @param {boolean} [config.passive=false] - Opt the stream out of taking an unowned grid on connect.
   * @param {boolean} [config.redactedCapture=false] - Redact sensitive rows.
   * @param {Object} config.elements - References to badge elements.
   * @param {number|null} [config.initialFontOverride=null] - Initial font size.
   * @param {function} [config.onTitleChange] - Called when the window title should change.
   * @param {function} [config.onFontOverrideChange] - Called when the font override changes.
   * @param {function} [config.onGeometryReady] - Called after the first geometry frame and after temporary geometry ends.
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
      passive = false,
      redactedCapture = false,
      elements = {},
      promptChoice = { since: null, collapsed: false },
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
    let lastPromptContent = null;
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
    let followedGrid = null;
    let choiceRevision = 0;
    let layoutId = 0;
    let realLayoutId = 0;
    let nextTakeId = 0;
    let pendingAuto = null;
    let dirtyAuto = false;
    let explicitHold = false;
    let explicitHoldControllerRevision = 0;
    let lastExplicitResizeRevision = 0;
    let clearedExplicitResizeRevision = 0;
    let pendingRealLayout = false;
    let autoFitRequested = false;
    let layoutEligible = false;
    let layoutRecoveryUsed = false;
    let transferOffered = false;
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
    };

    const refreshTitle = () => {
      const prefix = sessionEnded ? '[ENDED] ' : promptWaiting ? '[ANSWER ME] ' : providerStall ? '[STALLED] ' : '';
      onTitleChange(prefix + identityTitle);
    };
    refreshTitle();

    const showEnded = (exitCode) => {
      if (sessionEnded) return;
      sessionEnded = true;
      if (promptWaiting) clearPromptAlert();
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

    const renderDisclosure = () => {
      elements.promptToggle.setAttribute('aria-expanded', String(!promptChoice.collapsed));
      elements.promptToggle.title = promptChoice.collapsed ? 'Expand waiting notice' : 'Collapse waiting notice';
      elements.promptAlert.hidden = promptChoice.collapsed;
    };
    const togglePrompt = (event) => {
      event.stopPropagation();
      promptChoice.collapsed = !promptChoice.collapsed;
      renderDisclosure();
    };
    const onPromptKeyDown = (event) => {
      if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented) return;
      // A raw Enter can arrive without the keypress that generates a native click.
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) event.currentTarget.click();
    };
    elements.promptToggle?.addEventListener('click', togglePrompt);
    elements.promptToggle?.addEventListener('keydown', onPromptKeyDown);

    // Passive notice text lets terminal clicks through. Route the wheel to
    // the notice only over its visible, overflowing rectangle.
    const notices = elements.notices;
    const noticeViewport = notices?.parentElement;
    // A capped stack can keep the same size while its contents grow or shrink.
    // Observe both so only an overflowing touch surface captures a swipe.
    const noticeResize = notices && !captureMode && new window.ResizeObserver(() => {
      notices.classList.toggle('scrollable', notices.scrollHeight > notices.clientHeight);
    });
    if (noticeResize) {
      noticeResize.observe(notices);
      for (const child of notices.children) noticeResize.observe(child);
    }
    const scrollNotice = (event) => {
      if (event.ctrlKey || event.shiftKey || !event.deltaY || notices.scrollHeight <= notices.clientHeight) return;
      const box = notices.getBoundingClientRect();
      const { clientX, clientY } = wheelViewportPositions.get(event) ?? event;
      if (clientX < box.left || clientX >= box.right || clientY < box.top || clientY >= box.bottom) return;
      event.preventDefault();
      event.stopPropagation();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? notices.clientHeight : 1;
      notices.scrollTop += event.deltaY * unit;
    };
    noticeViewport?.addEventListener('wheel', scrollNotice, { capture: true, passive: false });

    const showPromptAlert = ({ question, waitingMs, options, since }) => {
      const seconds = Math.round((waitingMs || 0) / 1000);
      if (sessionEnded || !elements.promptAlert || !elements.promptToggle) return;
      const samePrompt = Number.isFinite(since) ? since === promptChoice.since : promptWaiting;
      // An identical stall frame need not change the live region or announce it again.
      const content = JSON.stringify([seconds, question, options]);
      if (promptWaiting && samePrompt && lastPromptContent === content) return;
      lastPromptContent = content;
      if (!samePrompt) {
        promptChoice.collapsed = false;
      }
      promptChoice.since = since ?? null;
      const heading = `Waiting for you: ${String(seconds)}s unanswered`;
      elements.promptToggle.textContent = heading;
      elements.promptToggle.hidden = false;
      const details = document.createDocumentFragment();
      const spokenHeading = document.createElement('span');
      spokenHeading.className = 'prompt-announcement-heading';
      spokenHeading.textContent = heading;
      const question_ = document.createElement('div');
      question_.className = 'question';
      question_.textContent = question || '(the session is holding a prompt)';
      details.append(spokenHeading, question_);

      if (Array.isArray(options) && options.length > 0) {
        const list = document.createElement('ul');
        list.className = 'options';
        for (const option of options) {
          const item = document.createElement('li');
          item.textContent = option;
          list.append(item);
        }
        details.append(list);
      }
      elements.promptAlert.replaceChildren(details);
      renderDisclosure();
      promptWaiting = true;
      onAttentionChange(true);
      refreshTitle();
    };

    const clearPromptAlert = () => {
      promptWaiting = false;
      lastPromptContent = null;
      promptChoice.since = null;
      promptChoice.collapsed = false;
      if (elements.promptToggle) elements.promptToggle.hidden = true;
      if (providerStall) { showStallAlert(providerStall); return; }
      if (!elements.promptAlert) return;
      elements.promptAlert.hidden = true;
      elements.promptAlert.textContent = '';
      onAttentionChange(false);
      refreshTitle();
    };

    const showStallAlert = (stalled) => {
      providerStall = stalled;
      if (!elements.promptAlert || promptWaiting) return;
      elements.promptAlert.textContent = `Stalled: ${stalled.reason} since ${stalled.since}. ${stalled.description}`;
      elements.promptAlert.hidden = false;
      onAttentionChange(true);
      refreshTitle();
    };

    const clearStallAlert = () => {
      providerStall = null;
      if (!promptWaiting && elements.promptAlert) {
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
      // The notice compares the wheel position with a viewport rectangle.
      if (event.type === 'wheel') wheelViewportPositions.set(event, { clientX: event.clientX, clientY: event.clientY });
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
    // Match the browser platform list in xterm's common/Platform.ts for selection.
    const macShiftSelection = ['Macintosh', 'MacIntel', 'MacPPC', 'Mac68K'].includes(navigator.platform);
    let lastGesture = null;
    let copyFailureShown = false;
    let copyNoticeTimer;
    const forgetGesture = () => { lastGesture = null; };
    const terminalFocused = () => document.hasFocus() && document.activeElement === term.textarea;
    const recordGesture = (event) => {
      if (!event.isTrusted || !terminalFocused()) return;
      if (event.type === 'keydown') {
        const key = event.key;
        const pasteShortcut = key === 'Paste' || event.code === 'Paste' ||
          ((event.ctrlKey || event.metaKey) && (key === 'v' || key === 'V' || event.code === 'KeyV')) ||
          (event.shiftKey && event.key === 'Insert');
        if (pasteShortcut) { forgetGesture(); return; }
        if (event.repeat !== false || typeof key !== 'string' || !(CLIPBOARD_KEYS.has(key) || PRINTABLE_KEY.test(key))) return;
      } else if (event.button !== 0) return;

      const age = window.performance.now() - event.timeStamp;
      const wallNow = Date.now();
      // Charge time already spent waiting for event dispatch to both clocks.
      lastGesture = Number.isFinite(event.timeStamp) && recentClipboardAge(age, MAX_CLIPBOARD_DISPATCH_MS) && Number.isFinite(wallNow)
        ? { eventTime: event.timeStamp, wallTime: wallNow - age } : null;
    };
    const hasRecentGesture = () => {
      if (!lastGesture) return false;
      if (recentClipboardAge(window.performance.now() - lastGesture.eventTime) &&
          recentClipboardAge(Date.now() - lastGesture.wallTime)) return true;
      forgetGesture();
      return false;
    };
    const canWriteClipboard = () => !destroyed && terminalFocused() && hasRecentGesture();
    const startShiftSelection = (event) => {
      if (!event.isTrusted || event.button !== 0 || !event.shiftKey || term.modes.mouseTrackingMode === 'none') return;
      // xterm chooses the drag mode on mousedown. Let its macOS handlers see
      // Option for this press, then restore the option after they have run.
      const previous = term.options.macOptionClickForcesSelection;
      const addOption = !event.altKey;
      if (addOption) Object.defineProperty(event, 'altKey', { value: true, configurable: true });
      term.options.macOptionClickForcesSelection = true;
      const restore = () => {
        clearTimeout(timer);
        term.element?.removeEventListener('mousedown', restore);
        if (addOption) delete event.altKey;
        if (!destroyed) term.options.macOptionClickForcesSelection = previous;
      };
      // A child can stop the event before it bubbles back to xterm's element.
      const timer = setTimeout(restore, 0);
      term.element.addEventListener('mousedown', restore);
    };
    const writeClipboard = async (text) => {
      if (!canWriteClipboard()) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        if (!destroyed && !copyFailureShown) {
          copyFailureShown = true;
          showBanner('Could not copy selected text to the clipboard.');
        }
        return;
      }
      if (destroyed || !elements.copyNotice) return;
      elements.copyNotice.hidden = false;
      clearTimeout(copyNoticeTimer);
      copyNoticeTimer = setTimeout(() => { elements.copyNotice.hidden = true; }, 1500);
    };
    // Use just one press event. A compatibility mousedown after a touch can
    // arrive on release, well after the original pointerdown.
    const gestureEvents = [window.PointerEvent ? 'pointerdown' : 'mousedown', 'keydown'];
    if (!captureMode && term.textarea) {
      for (const type of gestureEvents) term.element.addEventListener(type, recordGesture, true);
      term.element.addEventListener('paste', forgetGesture, true);
      if (macShiftSelection) term.element.addEventListener('mousedown', startShiftSelection, true);
      term.textarea.addEventListener('blur', forgetGesture);
      window.addEventListener('blur', forgetGesture);
      term.parser.registerOscHandler(52, data => {
        if (canWriteClipboard()) {
          const text = decodeClipboard(data);
          if (text !== null) void writeClipboard(text);
        }
        return true;
      });
    }
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
    term.onBinary((data) => {
      if (destroyed || sessionEnded || readOnly || !ws || ws.readyState !== 1) return;
      const bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i);
      ws.send(bytes);
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
      if (dashboardProof !== null || passive || readOnlyEnforced || controlMode === 'held' ||
          captureMode || (controlMode === 'adopt' && !deliberate)) {
        applyFontPreference(gridCols, gridRows);
      } else {
        requestFit();
      }
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
        // A fit can run after loadingdone but before the font refresh frame.
        // Setting the current size again does not make xterm measure it.
        if (font === drawn) term._core._charSizeService.measure();
        else term.options.fontSize = font;
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
      const minimum = dashboardProof !== null || passive || readOnlyEnforced ? 1 : MIN_FONT_PX;
      const font = largestFittingFont(cols, rows, maximum, minimum);
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
      } else if (passive || readOnlyEnforced) {
        fitGridByFont(cols, rows, fontOverride);
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
      gridCols = cols;
      gridRows = rows;
      if (max && Number.isInteger(max.cols) && Number.isInteger(max.rows)) {
        gridMax = { cols: max.cols, rows: max.rows };
      }
      // Compare at the parser boundary: another geometry frame may be queued.
      resizeTerminal(cols, rows);
      if (controlMode === 'yours' && !captureMode && dashboardProof === null) {
        updateZoomButtons();
      } else {
        applyFontPreference(cols, rows);
      }
      if (elements.size) {
        elements.size.textContent =
          `${cols}×${rows}` +
          (controlMode === 'held' ? ' (fixed)' : controlMode === 'adopt' ? ' (following)' : '');
        elements.size.title = elements.size.textContent;
      }
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
      relayout(true);
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

    function registerDashboardLayout(eligible, real) {
      if (dashboardProof === null || !ws || ws.readyState !== 1 || !geometryDecided) return false;
      autoFitRequested = eligible;
      layoutId++;
      if (real) {
        realLayoutId = layoutId;
        layoutRecoveryUsed = false;
        pendingRealLayout = false;
      }
      const allowed = eligible && (real || !explicitHold) &&
        !(followedGrid === 'unowned' && belowDashboardFloor());
      layoutEligible = allowed;
      dirtyAuto = allowed;
      if (real) {
        explicitHold = false;
        clearedExplicitResizeRevision = lastExplicitResizeRevision;
      }
      ws.send(JSON.stringify({ type: 'layout', layoutId, eligible: allowed, real }));
      return true;
    }

    function connect() {
      if (destroyed) return;
      ws = new WebSocket(`ws://${location.host}/sessions/${encodeURIComponent(sessionId)}/stream${passive ? '?drive=0' : ''}`,
        dashboardProof === null ? undefined : [`sp-csrf.${dashboardProof}`]);
      const socket = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        if (destroyed) return;
        // A reconnect may have missed a clear. Only the daemon's replay can
        // show the prompt again and identify it as the one the person folded.
        firstFrameSeen = false;
        promptWaiting = false;
        lastPromptContent = null;
        if (elements.promptToggle) elements.promptToggle.hidden = true;
        clearStallAlert();
        everConnected = true;
        if (elements.dot) elements.dot.classList.remove('off');
        if (elements.banner) elements.banner.hidden = true;
        retriesLeft = 8;
        geometryDecided = false;
        pendingAuto = null;
        dirtyAuto = false;
        layoutRecoveryUsed = false;
        if (pendingTakeSocket !== socket) {
          pendingTakeGrid = false;
          pendingTakeSocket = null;
        }
      };

      ws.onmessage = (event) => {
        if (destroyed) return;
        if (event.data instanceof ArrayBuffer) {
          if (redactedCapture && window.__shellpuppetPainted === true) return;
          if (captureMode && !firstFrameSeen) {
            firstFrameSeen = true;
            writeTerminal(new Uint8Array(event.data), () => {
              if (destroyed) return;
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
            if (typeof control.choiceRevision === 'number') {
              if (control.choiceRevision < choiceRevision) return;
              choiceRevision = control.choiceRevision;
            }
            controlMode = captureMode ? 'adopt' : control.control || 'adopt';
            const wasOffered = transferOffered;
            transferOffered = controlMode === 'adopt' && control.dashboardTransferable === true;
            const wasTemporary = temporaryGeometry;
            temporaryGeometry = control.temporary === true;
            if (pendingTakeSocket !== null && pendingTakeSocket !== socket) {
              pendingTakeGrid = false;
              pendingTakeSocket = null;
            }
            if (controlMode === 'held') {
              pendingTakeGrid = false;
              pendingTakeSocket = null;
            }
            const previouslyFollowed = followedGrid;
            if (dashboardProof !== null && firstGeometry && controlMode === 'adopt' &&
                control.owned !== true) followedGrid = null;
            if (dashboardProof !== null && firstGeometry && controlMode === 'yours') {
              followedGrid = null;
              pendingTakeGrid = false;
              pendingTakeSize = null;
              pendingTakeSocket = null;
              onGridTaken();
            }
            if (dashboardProof !== null && (!firstGeometry || control.owned === true)) {
              if (controlMode === 'yours' && pendingTakeGrid) {
                followedGrid = null;
                explicitHold = false;
                pendingTakeGrid = false;
                pendingTakeSize = null;
                pendingTakeSocket = null;
                onGridTaken();
              } else if (controlMode === 'adopt' && !transferOffered) {
                pendingTakeGrid = false;
                pendingTakeSize = null;
                pendingTakeSocket = null;
                followedGrid = control.owned ? 'owned' : 'unowned';
                if (previouslyFollowed !== followedGrid) onOutsideGeometry();
              } else if (transferOffered) {
                followedGrid = null;
              }
            }
            if (controlMode === 'yours') followedGrid = null;
            const controllerRevision = Number.isSafeInteger(control.controllerChoiceRevision)
              ? control.controllerChoiceRevision : 0;
            const explicitRevision = Number.isSafeInteger(control.explicitResizeRevision)
              ? control.explicitResizeRevision : 0;
            lastExplicitResizeRevision = Math.max(lastExplicitResizeRevision, explicitRevision);
            let holdCleared = false;
            if (control.clientResize) {
              explicitHold = realLayoutId <= (control.layoutFence ?? realLayoutId);
              if (explicitHold) {
                explicitHoldControllerRevision = controllerRevision;
                dirtyAuto = false;
              } else clearedExplicitResizeRevision = lastExplicitResizeRevision;
            } else if (explicitHold && controllerRevision > explicitHoldControllerRevision) {
              explicitHold = false;
              holdCleared = true;
            } else if (firstGeometry && explicitRevision > controllerRevision) {
              if (explicitRevision > clearedExplicitResizeRevision) {
                explicitHold = true;
                explicitHoldControllerRevision = controllerRevision;
                dirtyAuto = false;
              } else pendingRealLayout = true;
            }
            const resolvedAuto = pendingAuto &&
              (control.acceptedTakeId === pendingAuto.id || control.refusedTakeId === pendingAuto.id);
            const staleLayout = resolvedAuto && control.refusedTakeId === pendingAuto.id &&
              control.staleLayoutId === true && !layoutRecoveryUsed;
            if (resolvedAuto) pendingAuto = null;
            applyGeometry(control.cols, control.rows, control.max);
            if (holdCleared && autoFitRequested && !layoutEligible) {
              layoutRecoveryUsed = false;
              registerDashboardLayout(true, false);
            }
            const ownerLeft = previouslyFollowed === 'owned' && followedGrid === 'unowned' &&
              !control.clientResize;
            const choiceOwnerLeft = holdCleared && control.owned === false;
            let retryLayout = false;
            if (staleLayout && layoutEligible && !explicitHold && followedGrid !== 'owned' &&
                controlMode !== 'held' && !temporaryGeometry) {
              layoutRecoveryUsed = true;
              retryLayout = registerDashboardLayout(true, false);
            }
            if (firstGeometry || ownerLeft || choiceOwnerLeft || (transferOffered && !wasOffered) ||
                (wasTemporary && !temporaryGeometry) || (control.clientResize && dirtyAuto) ||
                (resolvedAuto && dirtyAuto) || retryLayout ||
                (controlMode === 'yours' && dirtyAuto && !pendingTakeGrid))
              onGeometryReady(firstGeometry ? 'connect' : ownerLeft || choiceOwnerLeft ? 'release' : 'ready');
            if (controlMode === 'yours' && !temporaryGeometry && !captureMode && dashboardProof === null) requestFit();
          } else if (control && control.type === 'identity') {
            showIdentity(control);
          } else if (control && control.type === 'exited') {
            pendingAuto = null;
            pendingTakeGrid = false;
            pendingTakeSize = null;
            pendingTakeSocket = null;
            showEnded(control.exitCode);
          } else if (control && control.type === 'input-refused') {
            if (control.reason === 'exited') showEnded(control.exitCode);
            else if (control.reason === 'input-failed') showInputFailed();
          } else if (control && control.type === 'prompt-stall') {
            showPromptAlert(control);
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
        pendingAuto = null;
        dirtyAuto = false;
        if (pendingTakeSocket === socket) {
          pendingTakeGrid = false;
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
        if (!captureMode && term.textarea) {
          for (const type of gestureEvents) term.element.removeEventListener(type, recordGesture, true);
          term.element.removeEventListener('paste', forgetGesture, true);
          if (macShiftSelection) term.element.removeEventListener('mousedown', startShiftSelection, true);
          term.textarea.removeEventListener('blur', forgetGesture);
          window.removeEventListener('blur', forgetGesture);
        }
        noticeViewport?.removeEventListener('wheel', scrollNotice, true);
        if (noticeResize) noticeResize.disconnect();
        elements.promptToggle?.removeEventListener('click', togglePrompt);
        elements.promptToggle?.removeEventListener('keydown', onPromptKeyDown);
        if (elements.promptToggle) elements.promptToggle.hidden = true;
        if (elements.promptAlert) elements.promptAlert.hidden = true;
        clearTimeout(copyNoticeTimer);
        if (elements.copyNotice) elements.copyNotice.hidden = true;
        fontListeners.delete(refreshFontMetrics);
        resolutionListener.dispose();
        if (metricsFrame !== null) window.cancelAnimationFrame(metricsFrame);
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
      },
      registerLayout(eligible, real = true) {
        if (real && (!ws || ws.readyState !== 1 || !geometryDecided)) pendingRealLayout = true;
        registerDashboardLayout(eligible, real || pendingRealLayout);
      },
      withdrawAutoFit() {
        if (dashboardProof === null || !ws || ws.readyState !== 1 || !geometryDecided) return;
        autoFitRequested = false;
        layoutId++;
        layoutEligible = false;
        dirtyAuto = false;
        ws.send(JSON.stringify({ type: 'layout', layoutId, eligible: false, real: false }));
      },
      resumeAutoFit() {
        if (dashboardProof === null || !ws || ws.readyState !== 1 || !geometryDecided) return;
        autoFitRequested = true;
        layoutId++;
        layoutEligible = !explicitHold && !(followedGrid === 'unowned' && belowDashboardFloor());
        dirtyAuto = layoutEligible;
        ws.send(JSON.stringify({ type: 'layout', layoutId, eligible: layoutEligible, real: false }));
      },
      autoFitGrid(floorCols = 80, floorRows = 24, force = false) {
        if (destroyed) return false;
        if (dashboardProof === null || controlMode === 'held' || (temporaryGeometry && !force) ||
            ((followedGrid === 'owned' || explicitHold) && !force) || !geometryDecided ||
            !ws || ws.readyState !== 1 || sessionEnded) return false;
        if (force) followedGrid = null;
        let proposed = proposeDashboardGrid();
        if (proposed === null) {
          if (container.clientWidth <= 0 || container.clientHeight <= 0) return false;
          proposed = { cols: floorCols, rows: floorRows };
        }
        const belowFloor = belowDashboardFloor(floorCols, floorRows);
        if (belowFloor && followedGrid === 'unowned' && !force) {
          this.withdrawAutoFit();
          return false;
        }
        const cols = Math.min(gridMax.cols, belowFloor ? floorCols : Math.max(floorCols, proposed.cols));
        const rows = Math.min(gridMax.rows, belowFloor ? floorRows : Math.max(floorRows, proposed.rows));
        if (force || transferOffered) return this.takeGrid(cols, rows, transferOffered);
        if (pendingTakeGrid && pendingTakeSocket === ws) {
          if (pendingTakeSize?.cols !== cols || pendingTakeSize?.rows !== rows) dirtyAuto = true;
          return false;
        }
        if (pendingAuto) {
          if (pendingAuto.cols !== cols || pendingAuto.rows !== rows || pendingAuto.layoutId !== layoutId)
            dirtyAuto = true;
          return false;
        }
        if (cols === gridCols && rows === gridRows && controlMode === 'yours') return false;
        const wanted = { cols, rows };
        const id = ++nextTakeId;
        pendingAuto = { id, socket: ws, layoutId, ...wanted };
        dirtyAuto = false;
        ws.send(JSON.stringify({ type: 'resize', ...wanted, take: true, automatic: true,
          takeId: id, choiceRevision, layoutId }));
        return true;
      },
      isTemporaryGeometry() { return temporaryGeometry; },
      hasTransferOffer() { return transferOffered; },
      takeGrid(cols, rows, acceptOffer = false) {
        if (destroyed) return false;
        if (dashboardProof === null || !ws || ws.readyState !== 1 || !geometryDecided) return false;
        const wanted = { cols: Math.max(2, Math.min(400, cols)), rows: Math.max(2, Math.min(150, rows)) };
        pendingTakeGrid = true;
        pendingTakeSize = wanted;
        pendingTakeSocket = ws;
        ws.send(JSON.stringify({ type: 'resize', ...wanted, take: true, ...(acceptOffer ? { acceptOffer } : {}) }));
        return true;
      },
      fitGrid(floorCols = 80, floorRows = 24) {
        if (destroyed) return false;
        if (dashboardProof === null) return false;
        followedGrid = null;
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

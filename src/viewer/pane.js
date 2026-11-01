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
 * `prompt-stall` and `prompt-clear`. What this pane sends is text: a JSON
 * resize message, or bytes for the program, which are either keystrokes or
 * the terminal's own answers to the program's queries. The daemon tells those
 * two apart.
 *
 * Three rules shape the pane:
 * - `term.onData` is registered exactly ONCE, never inside the connect path.
 *   Registering per-connect would stack a listener per reconnect and send
 *   every keystroke N times.
 * - The fit addon measures what grid this window would like, and the pane asks
 *   the daemon for it rather than assuming it (§5). The daemon decides who is
 *   driving the grid and answers with a geometry frame; only that frame
 *   resizes anything here.
 * - The pane never rebuilds terminal state itself. On connect and after every
 *   grid change the daemon sends a snapshot of its own renderer, a wipe followed
 *   by the bytes that rebuild the screen, so what this pane shows is what the
 *   daemon renders, which is what the agent reads. A tail of the raw stream
 *   replayed here would start mid-frame.
 */

/* global Terminal, FitAddon */

window.ShellPuppetPane = (() => {
  'use strict';

  const MIN_FONT_PX = 6;
  const MAX_FONT_PX = 40;
  const DEFAULT_FONT_PX = 13;

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
    let gridCols = 0;
    let gridRows = 0;
    let gridMax = { cols: Infinity, rows: Infinity };
    let controlMode = 'adopt';
    let geometryDecided = false;
    let firstFrameSeen = false;
    let identityTitle = `${sessionId} · ShellPuppet`;
    let destroyed = false;
    let reconnectTimer = null;

    const showBanner = (message) => {
      if (!elements.banner) return;
      elements.banner.textContent = message;
      elements.banner.hidden = false;
      positionNotices();
    };

    const refreshTitle = () => {
      const prefix = sessionEnded ? '[ENDED] ' : promptWaiting ? '[ANSWER ME] ' : '';
      onTitleChange(prefix + identityTitle);
    };
    refreshTitle();

    const showEnded = (exitCode) => {
      if (sessionEnded) return;
      sessionEnded = true;
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
      elements.promptAlert.hidden = false;
      positionNotices();
      promptWaiting = true;
      onAttentionChange(true);
      refreshTitle();
    };

    const clearPromptAlert = () => {
      if (!elements.promptAlert) return;
      elements.promptAlert.hidden = true;
      elements.promptAlert.textContent = '';
      promptWaiting = false;
      onAttentionChange(false);
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
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(container);
    const platform = navigator.userAgentData?.platform || navigator.userAgent;
    const isMac = /Mac|iPhone|iPad/i.test(platform);
    // Let the browser deliver paste to xterm's textarea on Windows and Linux.
    term.attachCustomKeyEventHandler((event) => {
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
          if (term.getSelection() === selection) term.clearSelection();
        }).catch(() => showBanner('Could not copy selected text to the clipboard.'));
        return false;
      }
      return true;
    });

    // The terminal can be centred within #wrap when its grid is held. Anchor
    // notices to the rendered screen, not to the outer fit box, and keep the
    // cursor's half free even as a TUI moves its cursor without a grid change.
    function positionNotices() {
      const notices = elements.promptAlert?.parentElement || elements.banner?.parentElement;
      const wrap = container.parentElement;
      const screen = term.element?.querySelector('.xterm-screen');
      if (!notices || !wrap || !screen || term.rows < 1) return;
      const screenRect = screen.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      notices.style.maxHeight = `${String(screenRect.height / 3)}px`;
      if (term.buffer.active.cursorY < term.rows / 2) {
        notices.style.top = 'auto';
        notices.style.bottom = `${String(wrapRect.bottom - screenRect.bottom)}px`;
      } else {
        notices.style.bottom = 'auto';
        notices.style.top = `${String(screenRect.top - wrapRect.top)}px`;
      }
    }
    term.onCursorMove(positionNotices);
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
        term.resize(term.cols, term.rows);
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
      let proposed;
      try {
        proposed = fit.proposeDimensions();
      } catch {
        return null;
      }
      if (!proposed || !proposed.cols || !proposed.rows) return null;
      return { cols: proposed.cols, rows: proposed.rows };
    }

    function fixedFontPx() {
      return fontOverride === null ? DEFAULT_FONT_PX : fontOverride;
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

    function fitGridByFont(cols, rows) {
      const wrap = container.parentElement;
      if (!wrap) return;

      const styles = window.getComputedStyle(wrap);
      const availableWidth = wrap.clientWidth
        - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
      const availableHeight = wrap.clientHeight
        - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
      if (availableWidth <= 0 || availableHeight <= 0) return;

      for (let pass = 0; pass < 4; pass++) {
        const screen = term.element && term.element.querySelector('.xterm-screen');
        if (!screen) return;
        const renderedWidth = screen.offsetWidth;
        const renderedHeight = screen.offsetHeight;
        if (renderedWidth <= 0 || renderedHeight <= 0) return;

        const scale = Math.min(
          availableWidth / renderedWidth,
          availableHeight / renderedHeight,
        );
        if (Math.abs(scale - 1) < 0.01) return;

        const current = term.options.fontSize || DEFAULT_FONT_PX;
        const next = clampFont(Math.floor(current * scale));
        if (next === current) return;

        term.options.fontSize = next;
        term.resize(cols, rows);
      }
    }

    function applyFontPreference(cols, rows) {
      if (fontOverride === null) {
        fitGridByFont(cols, rows);
      } else if (term.options.fontSize !== fontOverride) {
        term.options.fontSize = fontOverride;
        term.resize(cols, rows);
      }
      updateZoomButtons();
      container.dataset.fontSize = String(term.options.fontSize);
    }

    function applyGeometry(cols, rows, max) {
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
      gridCols = cols;
      gridRows = rows;
      if (max && Number.isInteger(max.cols) && Number.isInteger(max.rows)) {
        gridMax = { cols: max.cols, rows: max.rows };
      }
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      if (controlMode === 'yours' && !captureMode) {
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
    }

    function updateZoomButtons() {
      if (!elements.zoomAuto) return;
      elements.zoomAuto.classList.toggle('active', fontOverride === null);
      elements.zoomAuto.title = fontOverride === null
        ? 'Text size chosen automatically (click - or + to set it yourself)'
        : 'Choose the text size automatically again';
    }

    function setFontOverride(value) {
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
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        everConnected = true;
        if (elements.dot) elements.dot.classList.remove('off');
        if (elements.banner) elements.banner.hidden = true;
        retriesLeft = 8;
        geometryDecided = false;
      };

      ws.onmessage = (event) => {
        if (destroyed) return;
        if (event.data instanceof ArrayBuffer) {
          if (redactedCapture && window.__shellpuppetPainted === true) return;
          if (captureMode && !firstFrameSeen) {
            firstFrameSeen = true;
            term.write(new Uint8Array(event.data), () => {
              window.requestAnimationFrame(() => {
                window.requestAnimationFrame(() => {
                  window.__shellpuppetPainted = true;
                });
              });
            });
            return;
          }
          term.write(new Uint8Array(event.data));
          return;
        }
        try {
          const control = JSON.parse(event.data);
          if (control && control.type === 'input-source') {
            showInputSource(control.source);
          } else if (control && control.type === 'geometry') {
            geometryDecided = true;
            controlMode = captureMode ? 'adopt' : control.control || 'adopt';
            applyGeometry(control.cols, control.rows, control.max);
            if (controlMode === 'yours' && !captureMode && dashboardProof === null) requestFit();
          } else if (control && control.type === 'identity') {
            showIdentity(control);
          } else if (control && control.type === 'exited') {
            showEnded(control.exitCode);
          } else if (control && control.type === 'input-refused') {
            if (control.reason === 'exited') showEnded(control.exitCode);
            else if (control.reason === 'input-failed') showInputFailed();
          } else if (control && control.type === 'prompt-stall') {
            showPromptAlert(control.question, control.waitingMs, control.options);
          } else if (control && control.type === 'prompt-clear') {
            clearPromptAlert();
          }
        } catch {
          // Unknown text frame: ignore rather than corrupt the terminal.
        }
      };

      ws.onclose = () => {
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
      destroy() {
        destroyed = true;
        clearTimeout(reconnectTimer);
        if (ws) ws.close();
        if (redactedCapture) delete window.__shellpuppetCoverRows;
        term.dispose();
      },
      setFontOverride(value) {
        setFontOverride(value);
      },
      nudgeFont(delta) {
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
      takeGrid(cols, rows) {
        if (dashboardProof === null || !ws || ws.readyState !== 1 || !geometryDecided) return false;
        const wanted = { cols: Math.max(2, Math.min(400, cols)), rows: Math.max(2, Math.min(150, rows)) };
        ws.send(JSON.stringify({ type: 'resize', ...wanted, take: true }));
        return true;
      },
      fitGrid() {
        if (dashboardProof === null) return false;
        const proposed = propose();
        return proposed !== null && this.takeGrid(proposed.cols, proposed.rows);
      },
    };
  }

  return { create };
})();

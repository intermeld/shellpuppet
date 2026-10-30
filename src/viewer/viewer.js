/**
 * ShellPuppet viewer: the human's window into a shared session (design §5).
 *
 * One page, one session: the credential this page was given is scoped to
 * exactly this session (design §4.1), so there is no session picker by design.
 *
 * Wire protocol: BINARY WebSocket frames carry terminal bytes (snapshots, the
 * live stream and the exit notice); TEXT frames are JSON control messages:
 * `identity`, `geometry`, `input-source`, `input-refused`, `exited`,
 * `prompt-stall` and `prompt-clear`. What this page sends is text: a JSON
 * resize message, or bytes for the program, which are either keystrokes or
 * the terminal's own answers to the program's queries. The daemon tells those
 * two apart.
 *
 * Three rules shape the page:
 * - `term.onData` is registered exactly ONCE, never inside the connect path.
 *   Registering per-connect would stack a listener per reconnect and send
 *   every keystroke N times.
 * - The fit addon measures what grid this window would like, and the page asks
 *   the daemon for it rather than assuming it (§5). The daemon decides who is
 *   driving the grid and answers with a geometry frame; only that frame
 *   resizes anything here.
 * - The page never rebuilds terminal state itself. On connect and after every
 *   grid change the daemon sends a snapshot of its own renderer, a wipe followed
 *   by the bytes that rebuild the screen, so what this page shows is what the
 *   daemon renders, which is what the agent reads. A tail of the raw stream
 *   replayed here would start mid-frame.
 */

/* global Terminal, FitAddon */

(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  // The session travels in the QUERY so that every viewer window shares one
  // path: Chrome keys an --app window's AppUserModelID on host + path, and
  // Windows groups taskbar buttons by that id, so a per-session path would
  // give each window its own taskbar icon. A session id as the path's last
  // segment (`/view/<id>`) is read too.
  const sessionId = params.get('s') || location.pathname.split('/')[2] || '';

  // Capture mode (a headless screenshot, design §5): no chrome, the grid held
  // at the daemon's geometry, never a resize sent and a flag raised once the
  // first snapshot has been drawn, for the capturer to wait on. A screenshot
  // must not change what the program sees.
  const captureMode = params.get('capture') === '1';
  if (captureMode) document.body.classList.add('capture');
  let firstFrameSeen = false;

  // This page never holds a credential (design §4.1). The `vt` in the address
  // bar was a ONE-USE grant, and by the time this script runs the daemon has
  // already redeemed it for an HttpOnly cookie that scripts cannot read and
  // the browser attaches to the socket by itself. So there is nothing to keep
  // here: only the spent grant to wipe from the address bar, so it never
  // reaches history or a bookmark. The session id stays: without it a reload
  // has nothing to reconnect to.
  history.replaceState(null, '', `/view?s=${encodeURIComponent(sessionId)}`);

  const dot = document.getElementById('dot');
  const banner = document.getElementById('banner');
  const sizeLabel = document.getElementById('size');
  const sourceLabel = document.getElementById('input-source');
  const sessionLabel = document.getElementById('session-label');
  const readonlyButton = document.getElementById('readonly');
  const modeHint = document.getElementById('mode-hint');
  const zoomInButton = document.getElementById('zoom-in');
  const zoomOutButton = document.getElementById('zoom-out');
  const zoomAutoButton = document.getElementById('zoom-auto');

  const MIN_FONT_PX = 6;
  const MAX_FONT_PX = 40;
  const DEFAULT_FONT_PX = 13;
  const FONT_PREF_KEY = 'shellpuppet.fontSize';

  function clampFont(px) {
    return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, px));
  }

  // null = choose the text size automatically.
  // A number = the human picked a size, and it wins until they press "fit".
  // Persisted, because this viewer reconnects routinely and a preference that
  // evaporated on every reconnect would be worse than none.
  let fontOverride = null;
  try {
    const saved = window.localStorage.getItem(FONT_PREF_KEY);
    if (saved !== null && saved !== 'auto') {
      const parsed = Number.parseInt(saved, 10);
      if (Number.isFinite(parsed)) fontOverride = clampFont(parsed);
    }
  } catch {
    // Blocked storage (private browsing): a missing preference is not an error.
  }

  sessionLabel.textContent = sessionId;

  const showBanner = (message) => {
    banner.textContent = message;
    banner.hidden = false;
  };

  const promptAlert = document.getElementById('prompt-alert');
  const identityBar = document.getElementById('identity');
  const identityPurpose = document.getElementById('identity-purpose');
  const identityMeta = document.getElementById('identity-meta');
  const sessionAgent = document.getElementById('session-agent');

  // The document title doubles as the OS window title, the only thing a human
  // sees when this viewer is one of several windows behind others. It has to
  // carry both what the session IS and whether it wants something, so
  // alt-tabbing is a decision rather than a hunt. Composed from state, never
  // appended to, or repeated prompts would stack prefixes.
  let identityTitle = `${sessionId} · ShellPuppet`;
  let promptWaiting = false;
  /** The daemon says the program is gone: the page stops pretending otherwise. */
  let sessionEnded = false;
  const refreshTitle = () => {
    // Ended wins over waiting: a prompt on a dead session is the last frame
    // it drew, not a question anyone can answer.
    const prefix = sessionEnded ? '[ENDED] ' : promptWaiting ? '[ANSWER ME] ' : '';
    document.title = prefix + identityTitle;
  };
  refreshTitle();

  /**
   * A session stays reachable for fifteen minutes after its process exits.
   * Once the daemon says the program has gone, the page says so too, rather
   * than showing the last frame the program drew as a live terminal.
   */
  const showEnded = (exitCode) => {
    if (sessionEnded) return;
    sessionEnded = true;
    readonlyButton.disabled = true;
    // An end with no exit code is the session's, not the program's: the
    // terminal closed when its output failed, and the daemon then ended the
    // program.
    const withCode = typeof exitCode === 'number';
    readonlyButton.title = withCode ? 'The program has exited' : 'The session has ended';
    modeHint.textContent = withCode
      ? `the program has exited (code ${String(exitCode)}); this session no longer accepts input`
      : 'the session has ended: its output failed; it no longer accepts input';
    refreshTitle();
  };

  /** The daemon says the session's input has failed: nothing typed here reaches the program. */
  let inputFailed = false;
  const showInputFailed = () => {
    // "The program has exited" is the more useful of the two once it is true.
    if (sessionEnded || inputFailed) return;
    inputFailed = true;
    modeHint.textContent = "this session's input has failed; kill it and start it again";
  };

  const showIdentity = (identity) => {
    // Prefer the purpose: "fix the failing login test" tells you which window
    // you want; "claude" does not, when three of them are claude.
    const purpose = identity.purpose || identity.label || sessionId;
    identityPurpose.textContent = purpose;

    const meta = [identity.session, identity.command].filter(Boolean).join('  ·  ');
    identityMeta.textContent = meta;
    identityBar.hidden = false;

    if (identity.startedBy) {
      sessionAgent.textContent = `started by ${identity.startedBy}`;
    }

    if (identity.readOnly === true) {
      readOnlyEnforced = true;
      readOnly = true;
      showReadOnly();
    }

    // Said on every connect, so a page that joins during the grace after the
    // program exited knows straight away rather than on its first keystroke.
    if (identity.exited === true) showEnded(identity.exitCode);
    // Likewise a session whose input has failed.
    if (identity.inputFailed === true) showInputFailed();

    // Session id first: it is the short, unique, stable part, and window-title
    // text is truncated from the RIGHT in the Windows taskbar and alt-tab.
    identityTitle = `${identity.session} ${purpose} · ShellPuppet`;
    refreshTitle();
    relayout(false);
  };

  const showPromptAlert = (question, waitingMs, options) => {
    const seconds = Math.round((waitingMs || 0) / 1000);
    // textContent throughout: the question and options are TUI output, i.e.
    // untrusted, and innerHTML here would let a session paint markup into the
    // supervisor's own chrome.
    promptAlert.textContent = '';
    const heading = document.createElement('div');
    heading.textContent = `Waiting for you: ${String(seconds)}s unanswered`;
    const question_ = document.createElement('div');
    question_.className = 'question';
    question_.textContent = question || '(the session is holding a prompt)';
    promptAlert.append(heading, question_);

    // The choices, so the badge says what is being asked and not merely that
    // something is. Numbers come from the program's own rows. Never renumber
    // them, because the number shown is the key the human has to press.
    if (Array.isArray(options) && options.length > 0) {
      const list = document.createElement('ul');
      list.className = 'options';
      for (const option of options) {
        const item = document.createElement('li');
        item.textContent = option;
        list.append(item);
      }
      promptAlert.append(list);
    }
    promptAlert.hidden = false;
    promptWaiting = true;
    refreshTitle();
    relayout(false);
  };

  const clearPromptAlert = () => {
    promptAlert.hidden = true;
    promptAlert.textContent = '';
    promptWaiting = false;
    refreshTitle();
    relayout(false);
  };

  // Only the session id is required to get this far. Whether this page may
  // actually watch is settled by the cookie on the socket, not by anything
  // visible here, so a missing or spent grant surfaces as a failed connection
  // rather than as a check in this file (§4.1).
  if (!sessionId) {
    showBanner(
      'This viewer link is missing its session id. Ask the agent for a fresh viewer URL.',
    );
    return;
  }

  const term = new Terminal({
    cursorBlink: true,
    // Start at the human's saved size, not the default: the grid this page
    // asks for is measured at whatever size the text already is, so building
    // the terminal at the default would propose a grid for a size the human
    // did not choose and then re-propose once it was applied.
    fontSize: fontOverride ?? DEFAULT_FONT_PX,
    scrollback: 5000,
    allowProposedApi: true,
    fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    theme: { background: '#0b0e14', foreground: '#c5cdd9', cursor: '#6cb6ff' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('term'));

  let ws = null;
  let readOnly = false;
  /** Set by the daemon: this credential may watch but not type (§4.1). */
  let readOnlyEnforced = false;
  let retriesLeft = 8;
  /** Distinguishes "the session ended" from "this link was already spent". */
  let everConnected = false;

  // ------------------------------------------------------------------------
  // Repaints come from the daemon, never from this page. xterm reflows its
  // buffer IN PLACE when the grid changes, rewrapping old lines into positions
  // the program never drew and pushing rows off the top into the scrollback.
  // So after any grid change the daemon sends a snapshot of its own renderer
  // at the new size (a wipe through the write queue, then the rebuild), and on
  // connect the same. A tail of the raw stream replayed here would start
  // mid-frame, and a program that only repaints what changed never puts the
  // rest of its frame back.

  // Registered exactly once. See the header comment.
  term.onData((data) => {
    if (sessionEnded || readOnly) return;
    if (ws && ws.readyState === 1) ws.send(data);
  });

  function showReadOnly() {
    readonlyButton.textContent = `read-only: ${readOnly ? 'on' : 'off'}`;
    readonlyButton.classList.toggle('active', readOnly);
    // Both write the same line, and "the program has exited" or "the input
    // has failed" is the more useful of the two facts once it is true.
    if (sessionEnded || inputFailed) return;
    if (readOnlyEnforced) {
      readonlyButton.disabled = true;
      readonlyButton.title = 'This viewer link grants watching only';
      modeHint.textContent = 'read-only link: the session will not accept your keystrokes';
      return;
    }
    modeHint.textContent = readOnly
      ? 'read-only: your keystrokes stay local'
      : 'you and the agent share this session: type freely';
  }

  readonlyButton.addEventListener('click', () => {
    // A watch-only credential is not a toggle. The daemon drops input from one
    // regardless, so offering the switch would only promise something the
    // session will not honour.
    if (readOnlyEnforced) return;
    readOnly = !readOnly;
    showReadOnly();
  });

  // Who drives the grid lives on the DAEMON, not here: the daemon states it in
  // a `geometry` frame on every connect, so a second copy here could only drift
  // from the authority and would have to be kept in step for no benefit.

  /**
   * Re-lay-out the terminal for the space it currently has. Called on window
   * resize AND whenever a strip above the terminal appears or disappears. The
   * identity bar and the prompt badge both consume vertical space, and without
   * this the terminal keeps its old height and its top row is clipped behind
   * them.
   */
  function relayout(deliberate) {
    // Nothing is sized until the daemon has said what the geometry IS. The
    // identity frame arrives before the geometry frame and shows the identity
    // bar, which calls this; with the grid's owner still unknown, fitting to
    // the window then would resize a session that is not this page's to
    // resize.
    if (!geometryDecided) return;
    // Held means held: scale the text so the fixed grid fills what it can.
    // A strip appearing above the terminal is nobody's act, so an adopted
    // grid is refitted for the space left rather than reshaped. Otherwise a
    // window that changed shape is a deliberate act, and a deliberate act
    // takes the grid, which is the only way back for someone looking at a
    // grid somebody else chose.
    if (controlMode === 'held' || captureMode || (controlMode === 'adopt' && !deliberate)) {
      applyFontPreference(gridCols, gridRows);
    } else {
      requestFit();
    }
  }

  /**
   * Ask the daemon for the grid this window would like. Deliberately a
   * REQUEST: the grid is resized when the daemon's geometry frame comes back,
   * never here. Sizing locally first would have the page briefly render a
   * snapshot serialised at the old grid, and leave the two disagreeing
   * whenever the daemon declined.
   */
  function requestFit() {
    // Text size first, grid second: the proposal is measured at the size the
    // answer will be drawn at, so nothing has to be redrawn when it arrives.
    const font = drivingFontPx();
    if (term.options.fontSize !== font) {
      term.options.fontSize = font;
      term.resize(term.cols, term.rows);
    }
    updateZoomButtons();
    const proposed = propose();
    if (proposed === null) return;
    // Never ask for more than the daemon will give. Font sizes are whole
    // pixels, so the grid at the chosen size can still overshoot the bound by
    // a column or two, and asking for those would be answered with the grid
    // already held, which would ask again.
    const cols = Math.min(proposed.cols, gridMax.cols);
    const rows = Math.min(proposed.rows, gridMax.rows);
    // Already what we would ask for. Saying so again would have the daemon
    // answer with the same frame, which would ask again: a loop. Unless this
    // page is merely adopting the grid, when asking IS the point: a
    // deliberate act on a grid that happens to fit still takes it. The answer
    // comes back as `yours`, and the next look through here finds nothing to
    // ask.
    if (cols === gridCols && rows === gridRows && controlMode !== 'adopt') return;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  }

  /** The grid this window would hold at the text size currently drawn. */
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

  /**
   * The text size for a viewport that DRIVES the grid, which is the ordinary
   * case. A real terminal keeps its text one size and lets the window decide
   * how many rows and columns fit; scaling the text to the window would
   * change what fits, which would change the grid, which would change what
   * fits. The one exception is a window past the bound the daemon puts on a
   * grid (§5): it will never be given the grid its text size asks for, so
   * the text grows instead, until the most it can be given fills the window.
   */
  function drivingFontPx() {
    // The smallest size, from the human's chosen size upwards, at which the
    // grid this window holds fits within the bound. MEASURED at each size,
    // never estimated from another: cell sizes do not scale with the font
    // linearly, and an estimate that flipped between two sizes would have the
    // page proposing two grids in turn, for ever. Measuring depends only on
    // the window, the chosen size and the bound, so the same window always
    // gets the same answer.
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

  // The grid the daemon last reported, so a window resize or a font change can
  // re-apply it without waiting for another frame, and this page's standing
  // in it: 'yours' (this viewport drives it), 'adopt' (another does, or nobody
  // does yet) or 'held' (the session holds it and no viewport may change it).
  let gridCols = 0;
  let gridRows = 0;
  // The most the daemon will give a viewport (§5); every geometry frame
  // carries it. Until one has, nothing bounds a proposal.
  let gridMax = { cols: Infinity, rows: Infinity };
  let controlMode = 'adopt';
  // Set by the geometry frame on each connect; until then relayout() is a
  // no-op, so nothing this page does can resize the PTY before it knows
  // whether the size belongs to an agent.
  let geometryDecided = false;

  /**
   * Size a grid this page does not drive to fill the window by changing the
   * FONT, never the grid.
   *
   * A grid this viewport does not drive must stay the size it is, so the page
   * cannot fill the window by resizing the grid, and scales the text instead.
   * Left at its natural pixel size, a 120x34 terminal renders into roughly
   * 960x580 px, stranded in the corner of a large window. A window whose shape
   * differs from the grid's keeps bars on one axis, which is the faithful
   * answer: the alternative is stretching the characters out of shape.
   *
   * xterm's cell size scales with fontSize, so measuring the rendered screen
   * at a known size gives the ratio to the size that fits. One correction pass
   * is enough in practice; the loop guards against font metrics that do not
   * scale perfectly linearly.
   */
  function fitGridByFont(cols, rows) {
    const wrap = document.getElementById('wrap');
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
      // Within one per cent of a perfect fit is as good as it needs to be; stop
      // rather than oscillate on rounding.
      if (Math.abs(scale - 1) < 0.01) return;

      // Floor, deliberately: rounding up can overshoot the box and clip the last
      // column or row, which is worse than a little slack. The cost is that the
      // fit can stop up to one font-step short (13 x 1.05 floors back to 13 and
      // returns). That is accepted, because a font size is a coarse unit and
      // the alternative is a terminal whose edge is cut off.
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
  }

  function applyGeometry(cols, rows, max) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return;
    gridCols = cols;
    gridRows = rows;
    if (max && Number.isInteger(max.cols) && Number.isInteger(max.rows)) {
      gridMax = { cols: max.cols, rows: max.rows };
    }
    // Resize before the snapshot that follows this frame on the wire is
    // parsed: it was serialised at this grid.
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    if (controlMode === 'yours' && !captureMode) {
      // Drawn at the size the proposal was measured at (see requestFit), so
      // there is nothing to fit here; the frame that answers a proposal is
      // followed by another look at the window, in case it moved meanwhile.
      updateZoomButtons();
    } else {
      // A grid this page does not drive fills what it can by scaling the
      // text. Bars on one axis are the faithful answer to a window of a
      // different shape (§5).
      applyFontPreference(cols, rows);
    }
    sizeLabel.textContent =
      `${cols}×${rows}` +
      (controlMode === 'held' ? ' (fixed)' : controlMode === 'adopt' ? ' (following)' : '');
  }

  function updateZoomButtons() {
    zoomAutoButton.classList.toggle('active', fontOverride === null);
    zoomAutoButton.title = fontOverride === null
      ? 'Text size chosen automatically (click - or + to set it yourself)'
      : 'Choose the text size automatically again';
  }

  function setFontOverride(value) {
    fontOverride = value;
    try {
      window.localStorage.setItem(FONT_PREF_KEY, value === null ? 'auto' : String(value));
    } catch {
      // Preference simply will not persist; the session still works.
    }
    // A session that holds its grid cannot be given a different one, so the
    // text size is all this can change: the fixed grid is drawn larger or
    // smaller inside the window.
    if (controlMode === 'held' || captureMode) {
      applyFontPreference(gridCols, gridRows);
      return;
    }

    // Otherwise a human choosing a text size is asking what a real terminal
    // gives them: smaller text means MORE rows and columns, not the same grid
    // drawn small with space around it. Set the size, then ask for the grid
    // that now fits the window. That is a deliberate act, so it takes the
    // grid if this page was not already driving it.
    requestFit();
  }

  function nudgeFont(delta) {
    const base = term.options.fontSize || DEFAULT_FONT_PX;
    setFontOverride(clampFont(base + delta));
  }

  zoomInButton.addEventListener('click', () => nudgeFont(1));
  zoomOutButton.addEventListener('click', () => nudgeFont(-1));
  zoomAutoButton.addEventListener('click', () => setFontOverride(null));

  function showInputSource(source) {
    const who = source === 'human' ? 'human' : 'agent';
    const at = new Date().toLocaleTimeString();
    sourceLabel.textContent = `last input: ${who} ${at}`;
    sourceLabel.className = `hint ${who}`;
  }

  function connect() {
    // No credential in this URL: the cookie the daemon set when it redeemed
    // this page's grant is attached by the browser (§4.1).
    ws = new WebSocket(`ws://${location.host}/sessions/${sessionId}/stream`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      everConnected = true;
      dot.classList.remove('off');
      banner.hidden = true;
      retriesLeft = 8;
      // The daemon's snapshot begins with a wipe, so a RECONNECT does not
      // paint on top of what is already here.
      // Geometry is deliberately NOT decided here. The daemon sends a
      // `geometry` frame on every connect stating the PTY size and whether it
      // is held, and we act on that. Fitting here instead would resize the
      // PTY out from under a held scripted run in the window between opening
      // the socket and being told the hold exists, and so would any relayout
      // before that frame, which is what the flag is for (see relayout()).
      geometryDecided = false;
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        if (captureMode && !firstFrameSeen) {
          firstFrameSeen = true;
          // The first binary frame is the daemon's snapshot. Raise the flag
          // once it has been parsed AND drawn: a parse callback, then a frame
          // for the renderer to catch up.
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
          // A capture never drives the grid whatever it is told: resizing the
          // PTY under the program for the sake of a picture would change the
          // very thing being photographed.
          controlMode = captureMode ? 'adopt' : control.control || 'adopt';
          // Follow the daemon first: it is authoritative for what the program
          // draws, and a grid wider than the PTY leaves stale content beyond
          // the last column that nothing will ever overwrite.
          applyGeometry(control.cols, control.rows, control.max);
          // Driving, so fill the window. Merely adopting is passive: this page
          // shows what it was given until the human does something.
          if (controlMode === 'yours' && !captureMode) requestFit();
        } else if (control && control.type === 'identity') {
          showIdentity(control);
        } else if (control && control.type === 'exited') {
          // The program has gone; every watcher is told the moment it happens.
          showEnded(control.exitCode);
        } else if (control && control.type === 'input-refused') {
          // The daemon refusing a keystroke because the program has gone, for
          // a page that missed the frame above, or because the session's
          // input has failed.
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
      dot.classList.add('off');
      if (retriesLeft-- > 0) {
        setTimeout(connect, 2000);
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

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => relayout(true), 120);
  });

  updateZoomButtons();

  connect();
})();

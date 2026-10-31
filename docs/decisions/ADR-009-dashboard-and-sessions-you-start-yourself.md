# ADR-009: The dashboard and sessions you start yourself

**Status:** Accepted
**Date:** 2026-10-31
**Decided by:** Red Eagle Tech (product owner)

## Context

The single-session viewer lets a person watch and type into a terminal an
agent started. A person also needs one place to see every session, start a
session themselves, and spread sessions across screens. A dashboard that can
start and kill sessions needs wider authority than a viewer link, while the
client token must remain outside the browser.

## Decision

- **One dashboard, one daemon.** `shellpuppet dashboard` opens one document in
  ShellPuppet's isolated Chromium profile. Native xterm.js panes share the
  single-session viewer's terminal client. The daemon still owns every PTY;
  the dashboard adds no outbound connection. Each session appears in one
  window only, including when panes are assigned to other screens.
- **A browser credential for this dashboard.** This is not a user sign-in:
  there is no login, password or account. `shellpuppet dashboard` mints a
  one-use grant and opens the dashboard in its own browser profile; the page
  exchanges the grant for a cookie that works only for the dashboard on that
  machine; every request then carries the cookie and a proof that it came
  from the dashboard page. The grant and URL are not printed or returned to
  an agent. A failed isolated-window launch revokes the grant and fails the
  command, without opening the normal browser.
- **Limited browser authority.** The dashboard cookie may list and open all
  sessions, type, resize, kill, and start named launch profiles. It cannot
  start an arbitrary command, shut down the daemon, mint viewer links, take
  screenshots, read the environment report or hold a grid. Configuration
  supplies profiles; an empty launcher is the default. First-run guidance is
  worked example profiles in the documentation only. Nothing adds profiles
  to `config.json` or detects programs on `PATH`.
- **Prove dashboard requests.** The cookie is `HttpOnly`, `SameSite=Strict`
  and scoped to `/`. The daemon checks the allowed `Host`, Fetch Metadata and
  matching `Origin` where required. Each authenticated document load receives
  a fresh proof. Mutations put it in `X-ShellPuppet-CSRF`; browser WebSockets
  put it in their subprotocol. A missing `Origin` is allowed only on specified
  document navigations and same-origin reads. The client token's existing
  HTTP and WebSocket rules remain. The security model records the wider
  same-origin risk.
- **Profiles, policy and environment.** A launch names a configured profile
  and, when offered, one named folder. The page cannot supply a command,
  arguments, raw path or environment value. Global and profile policy check
  the real command before any Windows shell wrap. The launch route accepts
  at most eight starts per sixty seconds and at most thirty-two live sessions
  when `policy.maxSessions` is unset; a configured cap takes its place.
  Client-token starts keep their existing limit. Sessions start with the
  clean environment, plus variables explicitly named by that profile in
  `envFromDaemon`; values are never returned or logged.
  A connected feature's reserved credential stays out of sessions under
  ADR-007, including on this path.
- **Fill, then focus.** Auto arranges panes in an even grid while each can
  hold at least 80 by 24 cells, then uses a large pane and a strip. That
  floor is confirmed before release by reading and typing in the shipped
  agent CLIs at that size, and raised to the smallest size that proves
  readable if it fails. Grid and Focus are explicit modes. New sessions
  append; attention marks a pane without moving it. A configurable
  `Ctrl+Shift+A` prefix enters navigation and is consumed by the page.
  Pin and reorder are deliberate gestures. The dashboard remembers mode,
  order and pin in its isolated browser profile.
- **The terminal changes size only on a deliberate act.** A dashboard pane
  adopts the session grid without driving it when it connects. Layout and
  window changes scale the font rather than resize the PTY. Fit, Enlarge and
  Restore take geometry control and resize the real terminal; Restore sends
  the previous grid. Each pane has Enlarge and Restore. Focus gives one
  session most of the window. The browser's full-screen key can make the
  dashboard full screen. An enlarged or focused pane also resizes the real
  terminal to fit when the person takes control. The single-session viewer's
  geometry rule and read-only enforcement remain.
- **Windows and placement.** A pane's Pop out control opens that session in
  its own movable, full-screen-capable window. It leaves the grid and returns
  when that window closes. This uses the same multi-window support as panes
  assigned to other screens: one click opens at most one window, and an
  unavailable screen-placement API falls back to a window the person moves.
  A profile's `open` setting is `grid` by default, or `focus` or `window`.
  It can therefore open a supervising session focused or popped out while
  sessions it starts appear in the grid.
- **Handoff and attention.** An agent joins a person-started session through
  the existing list and session tools; Copy session id helps the handoff.
  Prompt attention uses a badge and title count, with no sound, operating
  system notification or automatic focus change. Kill is one menu action.
  Ended panes remain until dismissed or reaped on the existing grace period.

## Alternatives considered

- Giving the browser the client token would expose free-form start, shutdown
  and viewer-grant minting. Widening a viewer cookie would lose its
  per-session boundary.
- A free command field would permit arbitrary starts under the default
  allow-all policy. A named shell profile still grants shell access when a
  person explicitly configures it.
- Mirroring every session in every window wastes readable space. Assigning
  each session to one window lets each screen fill to its readable capacity.
- A separate port would not isolate cookies, which are not scoped to ports.
  A single multiplexed stream would also couple sessions' backpressure.

## Consequences

- The design specifies the dashboard routes, document proof, pane geometry,
  launch profiles, screen assignment and shared viewer client. The security
  model states its authority and residual risks.
- A dashboard cookie at `Path=/` is presented across this origin. Script
  running in any page the daemon serves could use it to act on every live
  session and start configured profiles. `HttpOnly` keeps the value out of
  script, but does not prevent script from making authenticated requests.
- Parent and child sessions are the next step, outside this build. Each
  daemon-started session will receive its own id as `SHELLPUPPET_SESSION`.
  A ShellPuppet MCP server or CLI inside it can record that id as the parent
  of sessions it starts. The dashboard can then group and tag children and
  jump to a parent's waiting children, whichever agent supervises, without
  changes to agent CLIs.

# CLI reference

`type <id> <text> --enter` writes a single line, waits for a readable composer
to show it or a recognised paste placeholder and for the screen to settle,
then checks again immediately before sending Enter separately on the same
input queue. Codex waits at least 3 ms per character, or 150 ms for short
lines, with up to five more seconds for paint and quiet. A placeholder must
be new since this write and match the body's character count. If the exact
draft is absent, a prompt has opened or other input has arrived, Enter is not
sent and the result reports `submitted: false`. A composer still showing the
exact draft after Enter gets one further Enter only if these checks still
hold. An empty composer confirms
submission only if the draft was seen first; a busy indicator or an echo in
the transcript also confirms it. Otherwise the result says submission was
not confirmed. If the draft remains after the retry, JSON reports
`submitted: false` and plain text mode exits with an error. The text is never
typed twice. `--verify` checks for visible text, which may have cleared after
submission.

## Scheduled prompts

`shellpuppet schedule list [--json]` shows each valid schedule's name, target
session, cron expression, busy policy, enabled flag, next UTC run and last
outcome. A paused schedule or an impossible calendar date has no next run.
The last outcome includes the time and any skip or abort reason. It starts
empty when the daemon starts or the entry changes. JSON returns a `schedules`
array with `nextRunUtc` and `lastOutcome` set to `null` where appropriate.
Edit the `schedules` section of `config.json` to change a schedule.

## Session messages

`shellpuppet msg send <to> <text|->` sends a message; `-` reads the text from
standard input. `shellpuppet msg inbox` reads and marks unread messages,
while `msg outbox`, `msg directory`, and `msg wait [--from <id|name>]
[--timeout <ms>]` inspect sent messages, permitted live names and the next
unread message. `--from` takes a participant id or the name it holds now;
a live id wins when a name equals one. `shellpuppet inbox` is an alias for
`msg inbox`.
`msg log [--participant <id>] [--limit <n>]` gives the caller's own retained
message history, including text; `--participant` accepts only the caller's id.
`msg send` returns `waiting` when queued; `msg outbox` shows each message's
latest state, including `not-delivered` when its recipient ended or its outside
claim lapsed. A live recipient refused by `messaging.allow` returns 403 with
both names; an absent name returns 404.
Control characters in printed message text appear as visible escapes. All
commands accept `--json`.

Inside a session, use the `SHELLPUPPET_CLI` path supplied in its environment.
The message nudge names the `session_inbox` MCP tool, not a command.
The daemon always supplies its absolute `SHELLPUPPET_HOME`, so the CLI reaches
the daemon that started the session. It overrides a copied or caller supplied
value, including with `envFromDaemon: "all"`. The CLI presents the session's
identity automatically. Outside a session, run `msg claim <name>`, then set
the printed `SHELLPUPPET_CLAIM=<id>:<secret>`
in that client's environment for later commands. `msg release` frees it.
The CLI refuses `msg claim` when its environment identifies a session, which
already messages under its own name. The daemon refuses claims presenting a
session identity, a valid claim or the inside-session mark, and says which of
them the request presented. The CLI and MCP server add the mark when
`SHELLPUPPET_SESSION`, `SHELLPUPPET_SESSION_TOKEN` or
`SHELLPUPPET_DAEMON_INSTANCE` is set, so a client that is not a session but
inherited one clears them; a client that already holds a claim releases it
first. A request can present both. A request presenting neither is
treated as outside. A local process with the daemon token can omit those
signals and already has access to every session. Messaging rules govern which
participants the daemon carries messages between, not that token's authority.
Claims lapse after the configured idle period unless their holder makes an
authenticated messaging call, including a pending wait.
Treat a claim as a local same-user credential and keep it out of logs.

The dashboard launcher has a Name box filled with the selected profile's
name. Rename in a live pane's menu changes its label and messaging address.
The dashboard checks its credential, document proof and same-origin request
for each rename. Neither the CLI nor MCP tools can rename a session.

`shellpuppet dashboard` opens the dashboard. In a dashboard with several
windows, **New sessions here** chooses which window receives `shellpuppet
start` and agent-started sessions. When that window closes, the most recently
focused survivor takes over, including focus reported after a reconnect.
A window's profile launcher starts in that window. Moving the pane overrides
the profile's requested layout. **New window** opens an empty window. Drag panes between
windows or use **Pop out** to open a window for one pane.

```text
shellpuppet start [options] <command> [args...]
  --wait-ready
  --ready-timeout <ms>
  --ready-text <text> | --ready-quiet <ms>
  --agent <name>
  --json
```

Options precede the command. Pass `--wait-ready` when starting an agent CLI
to delegate work to. It uses the resolved agent's recorded ready signals;
`--agent` identifies it through a wrapper. Your own `--ready-text` or
`--ready-quiet` overrides those signals. A shell or unknown program needs
one of these explicit conditions. Without `--wait-ready`, starts return
without waiting, including when an explicit condition is being tracked.
Module signals come from captured screens. Ready text is a sign that the
input box is drawn, not a measured guarantee that every start-up frame has
passed; verify that typed input lands.

`--ready-timeout` sets the readiness limit in milliseconds, default 30,000
and capped at 300,000. The default leaves room beyond measured 24 to
25-second starts. A longer explicit wait needs a longer budget in the caller
running the CLI, including process creation and viewer opening. For MCP,
the bundled client's default budget is 60 seconds. A client that gives up
may lose the answer; the session still exists and `terminal_list` (CLI
`shellpuppet list`) shows it. A shorter call limit does not stop readiness
tracking, which lasts up to five minutes from session creation. The timeout
message says whether tracking is still pending or has ended (`never-held`).

The output says `Started and ready`, names a question and its choices,
reports the program's exit, or says `Started, not ready yet` after a timeout.
Questions take precedence over readiness, including a signal seen earlier
while the viewer was opening. Readiness returns to pending and is tracked
until the original deadline, so it can hold after the question clears. A timeout
leaves the session running; inspect or wait on that session before typing.
An exit reports its code, or that its output failed. These are all successful
starts and exit 0. Invalid input, including an unknown ready signal without
an explicit condition, exits 2 and starts nothing. `--json` returns the
[HTTP response](mcp.md#http-representation), including `readyWait` when asked.

Dashboard launches and launch profiles do not accept readiness wait fields
and never wait. A person's session appears as soon as its program starts.
See the [agent recipes](agent-profiles.md#recipes) for answering first-use
questions and verifying typed prompts.

## Listing and supervising sessions

`shellpuppet snap <id> --wider 200x80` temporarily enlarges the terminal
for a screen read, then restores the previous grid and its controller.
It waits for 250 ms of quiet after the resize, capped at 1500 ms by
default. `--wider-timeout <ms>` sets the cap from 250 to 30000 ms.
Each requested side may grow the grid but cannot shrink it. The API
refuses held grids, overlapping wider reads and sizes outside 2 to 400
columns and 2 to 150 rows. `--last`, `--hide-reasoning` and `--json`
continue to work. JSON reports `cols`, `rows` and `restored`; plain output
warns on stderr when a later geometry act prevents restoration.


`shellpuppet list` shows `STALLED <reason> since <ISO time>: <description>`
where readiness normally appears when a supported error has left the session idle
or a connection banner remains visible. JSON lists include
`stalled: { reason, description, since }`.
The reasons are `provider-refused` ("The model provider refused the turn."),
`request-failed` ("The model request failed."), `output-limit` ("The model
reached its output length limit."), `error` ("The model reported an error.")
and `server-lost` ("The local agent server connection was lost."). MiMo error
blocks and the OpenCode connection banner, also used by MiMo Code, are supported.
`list --waiting` selects answerable permission prompts only. A settled
`server-lost` banner hides a prompt beneath it until the banner clears.

```text
shellpuppet wait <id> --stalled [--timeout <ms>]
shellpuppet wait <id> --prompt --stalled [--hide-reasoning]
shellpuppet wait --stalled [id ...] [--now] [--timeout <ms>]
shellpuppet wait --prompt --stalled [id ...] [--now] [--hide-reasoning]
```

With no ids, the multi-session form watches every live session. `--now`
polls once. A stall match reports `reason: "stalled"` and the stall metadata;
its screen is empty. A prompt match still reports `reason: "prompt"`.
A wait for stalled alone also leaves the screen empty on timeout or exit.
With `--stalled`, each compact session row names its matched condition too.
The top-level reason names the first condition represented, with prompts
first if both conditions are present in different sessions. For the same session,
`server-lost` takes precedence and a bare `--prompt` does not return the covered
prompt. Text, regex and quiet cannot be combined with
these supervision conditions. Exit code 3 means a wait did not match;
`--now` returns normally even when no session needs attention.

MiMo errors are recognised by their shape on screen, at and above the 80x24
floor. The block must finish the live turn with MiMo's error ink, outside recognised
tool panels, with a visible idle composer and only recognised bottom chrome
below it. The same error must persist for one second. Indented unsent input
does not qualify. A clipped turn can still qualify when the red error body fills
the available history above a completed recovery footer and idle composer. Copy and recovery
controls, sidebar changes, resize reflow and cursor-only writes preserve the
stall and its original time. Composer frames repainted to the new width and
accepted grey suggestions arriving or leaving also preserve it while the
canonical error identity is unchanged, with no clear or further announcement.
OpenCode and MiMo Code report `server-lost` when their centred connection banner
remains on screen for one second. Its visible position and styling distinguish it
from text in the transcript or composer. The busy indicator may remain frozen
beneath the banner. The notice clears when the banner disappears.
Presentation changes are validated on a coalesced timer. Changes confined to
user-turn text, including every indented continuation behind its gutter, never
end an established notice. Ordinary output keeps its marker characters and
indentation; busy hints and cosmetic controls count only in their framed UI regions.
Changes or loss of the refusal,
completed footer or valid composer must persist across two checks 250 ms apart.
An established notice has a one-second redraw allowance after a resize request
or reported resize. This covers its composer, footer, marker and framing together.
Output and duplicate same-size requests cannot renew it or its confirmation;
a later geometry change or changed PTY size report gets its own allowance.
A genuine screen end during the allowance clears within 1.25 seconds of the
latest resize or size report, subject to event-loop scheduling; real input and
exit still clear immediately. A restored identity keeps the original notice.
Partial grey suggestion paints also wait for validation of the complete idle composer.
If only the user-turn boundary is outside the viewport plus 128 preceding rows,
an established notice
keeps its identity and time while the available content, same refusal block,
footer and idle composer still qualify. An incomplete leading wrapped row has
unknown context; it cannot set tool-panel state. Every complete
available content row is still checked. Missing context cannot finish settling
a new notice. A confirmed changed refusal or invalid visible shape clears the notice.
Busy output, newer transcript output, non-empty real input or exit clears it.
A live prompt clears other stalls, while `server-lost` remains until its banner
disappears. Empty writes and terminal reports do not. Input
suppresses the unchanged refusal even if its controls change. A program that
paints the same shape is reported the same way, including forged MiMo bars,
headers, footers or `Build ·` status rows. The state is a notice and nothing
acts on it. ShellPuppet sends no nudge.
Stall metadata contains no terminal text, with or without `--hide-reasoning`.

## Launch a configured profile

`shellpuppet launch PROFILE [--name NAME] [--folder FOLDER] [--root-index N] [--folder-path PATH] [--resume-id ID] [--json]`
uses the current session identity or `SHELLPUPPET_CLAIM`. The owner grants the
name in `launcher.sessionLaunch`. Use the folder choice configured for the profile.
For example, `shellpuppet launch review --folder repo --resume-id abc-123`.

## Relaunch after a daemon restart

Run `shellpuppet daemon restart --force` to record live profile sessions and
end them before restarting. A stop with `--hold` also requests a record.
From a granted session, run `shellpuppet previous --json`. For each entry
you want to restore, supply its profile, name, saved folder choice and known
resume id to `shellpuppet launch`. For example:

```sh
shellpuppet launch review --name chair --folder repo --resume-id thread-42
```

Omit `--name` when the saved name is null. A restart that cannot save a record
continues and reports the affected file in `--json` warnings or on stderr.
On a fresh home or after an unverified restart, `previous` exits with an error.
An empty list means the daemon successfully recorded zero live profile sessions.
An entry with a null resume id can be started fresh. Resume requires the
current profile to declare a resume template. Changing the configured command
or named folder changes the next launch.

For a recognised Claude Code process, the saved id follows the conversation
selected with `/resume`. If the daemon cannot verify the live id, including
for a Node-hosted Claude, it uses the last valid id reported by the session,
then the id supplied at launch. See the [agent profile reference](agent-profiles.md).

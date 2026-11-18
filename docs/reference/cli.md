# CLI reference

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
Treat a claim as a local same-user credential and keep it out of logs.

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

# MCP reference

## Session messages

Messaging starts off. The `session_*` tools below are offered only by an MCP
server that started while `messaging.enabled` was `true` in `config.json`; with
messaging off, the server offers only the `terminal_*` tools. After switching
messaging on, restart the MCP client (for example, the agent CLI) to see them.
Once the daemon has `messaging.enabled: true` and an allow rule, a session may
use `session_send(to, text)` and read its own
`session_inbox(markRead?, limit?)` or `session_outbox(limit?)`.
`session_directory()` lists only live names that policy permits it to address.
`session_wait_message(from?, timeoutMs?)` waits for the next unread message
without marking it read. The timeout is capped at five minutes.
`from` is a participant id or the name that participant holds now.

An MCP server running outside a daemon session may call `session_claim(name)`
to hold a name, then use the same messaging tools. `session_release()` frees
the name. Its claim stays in that MCP server's memory for its lifetime.
Received messages in tool results name the sender; sent messages name the
caller. Their text is framed as untrusted data, never as a user's instruction
or approval. Control and invisible directional characters are shown as visible escapes.
On the client-token `/events` WebSocket, message and state notifications go only
to the sender or receiver when the upgrade proves a session identity or claim.
A non-browser client can send claim headers on the upgrade; browser WebSocket
APIs cannot, so a claim holder using that API receives no message notifications.
A client token alone also receives none.

Pass `waitReady: true` to `terminal_start` when starting an agent CLI to
delegate work to. Waiting is off by default. The daemon uses the resolved
agent module's recorded ready signals. An explicit `readyText` (a literal,
case-insensitive substring) or `readyQuiet` (milliseconds without output
after first paint) overrides them. As before, if both are supplied, text
takes precedence. `agent` names the agent when its command is a wrapper.
The module signals come from captured screens. Ready text is a sign that
the input box is drawn, not a measured guarantee that every start-up frame
has passed. Verify that typed input lands.

`readyTimeout` is the per-call readiness limit in milliseconds: 30,000 by
default, capped at 300,000. That allows room beyond the measured 24 to
25-second starts and leaves room within the bundled MCP client's 60-second
budget for discovery, process creation and viewer opening. A longer explicit
wait needs a longer client budget, including that overhead. A client that
gives up may cancel the call and lose the answer; the session still exists
and `terminal_list` shows it. Cancellation stops that call's polling without
stopping the session or its readiness tracking. See
[long waits](agent-profiles.md#long-waits-know-your-clients-own-timeout).
Neither field changes dashboard launches or launch profiles, which do not
accept them and always return without waiting for readiness.

| Outcome | Tool result |
|---|---|
| Ready condition held | `Started and ready`, with readiness condition met |
| Recognised trust question, sign-in, update notice or other question | Returns immediately, names the question and choices inside the untrusted-data frame; answer it before waiting again |
| Program exited | Reports the exit code, or that its output failed |
| Time limit reached | `Started, not ready yet`; the session remains running, and the text says whether readiness is still tracked or tracking has ended |
| No caller condition and no module signal | Refuses before starting, asking for `readyText` or `readyQuiet` |

Readiness is tracked for up to five minutes from session creation. A shorter
call timeout leaves `readyReason: pending`; it later becomes `condition-met`
or `never-held`. At the tracking deadline, a timeout can already return
`never-held`. A recognised question at start completion makes readiness
pending even if the ready text appeared earlier during viewer opening.
Guarded tracking continues until the original deadline so readiness can
hold after the question clears. Without `waitReady`, module
signals are not applied and existing `readyText`/`readyQuiet` tracking is
unchanged. `readyReason: not-tracked` is never evidence that typing is safe.

## HTTP representation

`terminal_snapshot` accepts `wider: { cols, rows }` and optional
`widerTimeout` in milliseconds. The HTTP spelling is
`GET /sessions/<id>/snapshot?wider=200x80&widerTimeout=1500`.
The requested sides may enlarge the current grid but never shrink it.
The daemon waits for 250 ms of quiet after the resize, with a 1500 ms
default cap that callers may lower to 250 ms or raise to 30000 ms. The
returned `cols` and `rows` are the grid read, and `restored` says whether
the original size was restored without overriding a later geometry act. A
person's later resize, takeover or hold wins and sets `restored: false`.
A departing controller leaves control unowned, or with a remembered dashboard
owner, while the original size is restored.
Held grids and concurrent wider reads are refused with HTTP 409; sizes
outside 2 to 400 columns and 2 to 150 rows are refused with HTTP 400.
`lastLines` and `hideReasoning` apply to the wider snapshot as usual.
`terminal_find` searches only the current viewport; read a wider snapshot
when the program has clipped a line before drawing it.


`POST /sessions` accepts the same `waitReady` and `readyTimeout` fields.
A successful start is HTTP 200 for all four outcomes, with its session id
and existing viewer fields. Only an opted-in response adds `exited`,
`exitCode` and `readyWait`:

```json
{
  "ready": false,
  "readyReason": "pending",
  "exited": false,
  "exitCode": null,
  "readyWait": { "reason": "timeout", "waitedMs": 30000 }
}
```

`readyWait.reason` is `condition-met`, `prompt`, `exited` or `timeout`.
`prompt` adds `readyWait.prompt` with `question`, `options`, `signature`
and, when detected, `selectedOption`. These strings are untrusted terminal
data. A disconnected caller cancels its wait (`aborted` internally) without
stopping the session or its readiness tracking. A missing signal or malformed
wait field is HTTP 400 and creates no session. A failed process start keeps
the existing failure response.

## Listing and waiting for stalled sessions

`terminal_list` includes a `STALLED` state with the reason code, fixed product
description and ISO since time. `waitingOnly: true` selects answerable permission
prompts only. A settled `server-lost` banner hides any prompt beneath it from
waiting lists until the banner clears. A stall does not change the session's
startup readiness fields.
MiMo reports `provider-refused` for a provider refusal, `request-failed` for a
failed model request, `output-limit` when the model reaches its output length
limit and `error` for other error blocks at the end of an idle turn. OpenCode
and MiMo Code report `server-lost` when the local server connection banner persists.

`terminal_wait` accepts `stalled: true`, alone or with `prompt: true`. A string
`session` watches one session; an array watches those sessions; omitting it
watches all live sessions. `now: true` polls the compact multi-session form.
Text, regex and quiet are separate conditions and cannot be combined with
prompt or stalled. A prompt-only wait does not return a prompt beneath a settled
`server-lost` banner. When both conditions are requested, `server-lost` wins
for that session.

HTTP `GET /sessions/<id>/wait?stalled=true` returns, on a match:

```json
{
  "matched": true,
  "reason": "stalled",
  "waitedMs": 1040,
  "screen": "",
  "stalled": {
    "reason": "provider-refused",
    "description": "The model provider refused the turn.",
    "since": "2026-11-07T12:00:00.000Z"
  }
}
```

The response also carries `id`, `exited` and `exitCode`. The MCP result says
which condition matched and gives only the fixed stall metadata for a stall.
A wait for stalled alone never returns terminal text, including on timeout.
`GET /sessions/wait?prompt=true&stalled=true` returns compact `sessions` rows
with `reason: "prompt"` or `reason: "stalled"`; stalled rows carry `id`,
`label` and `stalled`. The top-level reason is `prompt` when any prompt rows
are present, otherwise `stalled` when any stalled rows are present, otherwise
`timeout`. Ended sessions are omitted. `GET /sessions` includes the same
`stalled` metadata in full session summaries.

MiMo error blocks are supported at and above the 80x24 floor. They are recognised
by their shape on screen. The error must belong to the live
turn with MiMo's error ink outside recognised tool panels, with a completed
turn footer, a visible idle composer and only recognised bottom chrome below
it. Indented unsent input does not qualify. Detection needs a known turn
boundary within the bounded context to establish a new notice, except when a
marker has scrolled away and the red error body reaches the top of the available
history above a completed recovery footer and idle composer. OpenCode's
connection banner uses its centred overlay position and styling instead of an
idle footer. Its frozen busy row does not prevent detection, and the notice
clears when the banner disappears.
The same evidence must persist for one second. An idle MiMo error has no prompt
or busy indication. Copy and recovery controls, sidebar changes,
resize reflow and cursor-only writes preserve its identity and original time.
Composer frames repainted to the new width and accepted grey suggestions
arriving or leaving preserve the notice while the canonical error identity
is unchanged, with no clear or further announcement. Presentation changes are
validated on a coalesced timer. Changes confined to user-turn text, including
every indented continuation behind its gutter, never end an established notice.
Ordinary output keeps its marker characters and indentation; busy hints and
cosmetic controls count only in their framed UI regions.
Changes or loss of the refusal, completed footer or valid
composer must persist across two checks 250 ms apart. An established notice has
a one-second allowance after a resize request or reported resize, covering all
of its framing, footer and marker as well as the composer. Output and duplicate
same-size requests cannot renew it or its confirmation; a later geometry change
or changed PTY size report gets its own allowance. A genuine screen end
during it clears within 1.25 seconds of the latest resize or size report, subject
to event-loop scheduling; real input and exit still clear immediately. A restored
identity keeps the original notice. Partial grey suggestion paints also wait for validation
of the complete idle composer. If only the user-turn boundary is
outside the viewport plus 128 preceding rows, an established notice keeps its identity and
time while the available content, same refusal block, footer and idle composer
still qualify. An incomplete leading wrapped row has unknown context; it cannot
set tool-panel state. Every complete available content row
is still checked. Missing context cannot finish settling a new notice. A confirmed
changed refusal or invalid visible shape clears the notice.
Non-empty real input, newer transcript output, busy output or exit clears it.
A live prompt clears other stalls, while `server-lost` remains until the banner
disappears. Empty writes and
terminal reports do not. Real input suppresses the unchanged refusal across
control changes. A program that paints the same shape is reported the same
way, including forged MiMo bars, headers, footers or `Build ·` status rows.
The state is a notice and nothing acts on it. No automatic input is sent.

`/events` sends `session-stalled` with `session`, `at` and `stalled`, then
`session-stall-clear` with `session` and `at` when cleared. The daemon records
each transition in its audit log and warns once per stall. Viewer control
messages use the same types and metadata, and the dashboard feed tracks
`stalled`. None of this metadata contains screen text; `hideReasoning`
readers receive the same fixed description without a screen-content side
channel.

## Launch a configured profile

Call `terminal_start` with `{"profile":"review","name":"chair","resumeId":"abc-123"}`.
The daemon authenticates the current session or held outside claim. Supply
only `profile` and applicable `name`, `folder`, `rootIndex`, `folderPath` and
`resumeId`. A resume id requires a profile resume template. The HTTP
equivalent is `POST /launcher/launch` with the same JSON. Free-form starts
continue to take `command` and the existing arguments.

A granted caller can request `terminal_list({"previous":true})` or
`GET /launcher/previous` after a restart. The response has `version: 1`
and a `sessions` array. A verified snapshot includes the outgoing daemon's
`outgoingInstanceId`. An empty array means no profile session was saved.
An older snapshot or a missing snapshot from a requested restart produces
HTTP 409 and an MCP tool error.
Pass the saved `profile`, `name`, fields of `folderChoice` and a known
`resumeId` to `terminal_start`. Omit a null name or resume id. An empty folder choice uses the current
fixed directory. `folder` in the record is the resolved directory for
inspection. `endedAt` is the time the daemon took its shutdown snapshot.

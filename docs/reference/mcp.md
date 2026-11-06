# MCP start reference

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

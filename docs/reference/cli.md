# CLI start reference

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

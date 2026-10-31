# Agent CLI profiles

How the agent CLIs ShellPuppet is used with behave under it: how long each
takes to start, what to wait for before typing, what each asks on first use,
what each shows while it thinks, recipes and the manual smoke checklist.
Timings are machine- and network-dependent: treat them as floors for your
timeout budgets rather than guarantees.

## The one rule

**First paint is not readiness, and a blank screen is not failure.** Some CLIs
below emit *nothing* for tens of seconds while they boot, and any of them can
be slower on a loaded machine. The single biggest
source of false failures in these measurements was snapshotting too early and
concluding the app was broken. Wait on output-only text with a generous
timeout; when a screen stays blank past budget, check the process tree before
concluding anything.

## Measured profiles

Two different numbers matter, and conflating them is how you reach a wrong
conclusion. **First output** is when anything visible first appears.
**Ready** is when the program will accept a prompt, which can be much later
and sometimes behind a trust question or a self-restart.

Measured 2026-10-29 (Windows 11, Node 22.22.2) through ShellPuppet itself, on a
workstation with other work running. Each CLI was started from a fresh, empty
folder under the default clean session environment, with the variables listed
for it in `agents.passEnv`, and timed from asking for the session: two runs or
more each, shown as a range. In the table, ready is when the text in the
readiness table below appears; where a first-use question came first, its
time is given instead, and the CLI is ready once you answer it.

| CLI | First output | Ready, or first question | Notes |
|---|---|---|---|
| Claude Code 2.1.312 | **1.8 to 3.3 s** | ready at **2.1 to 2.8 s** | Loads the MCP servers configured for it as it starts. Its footer reads `? for shortcuts` in the default mode and names the mode otherwise. |
| Codex 0.165.0 | **0.5 to 0.6 s** | ready at **0.5 to 0.6 s** | The fastest to a usable composer. |
| Antigravity 1.4.10 | **1.4 s** | trust question at **1.4 to 3.6 s** | Asks for trust on first use in a folder. |
| Qoder CLI 1.1.81 | **22 to 23 s** | ready at **24 s** | Paints nothing for over 20 seconds while it loads the MCP servers configured for it, and input typed while it settles is **silently discarded**. In-TUI suggestion panels can steal focus after tasks; `escape` resets. |
| OpenCode 2.0.26 | **0.6 to 5.7 s** | ready at **7 to 12 s** | Showed an update notice beside its composer on both runs. |
| MiMo Code 0.1.16 | **6.2 to 6.4 s** | trust question at **6.2 to 6.4 s** | Asks for trust on first use in a folder. |
| Grok 1.0.70 | **1.2 to 1.3 s** | ready at **1.2 to 1.3 s** | Wait on its input box: the `Shift+Tab` hint under it is not always drawn, and runs that waited on the hint did not all see it. |
| Goose 1.41.0 | **0.4 s** | not reached | Stopped at a configuration error about its provider key and keyring on the measuring machine, where Goose is not set up. Run `goose configure` first; a key it reads from its environment has to be passed in (it has no agent signature yet, so through config `envNames` and `terminal_start`'s `envNames`). In July, configured, it painted nothing for about 29 s while starting its MCP extension fleet of 89 processes; budget 90 to 150 s cold. |

Gemini CLI is not installed on the measuring machine. In July, at
version 0.52, it printed an update banner at once, then auto-updated and
restarted itself mid-session, and then failed authentication on the test
account, as described below.

**Timings are not stable across machines or runs.** OpenCode's first output
ranged from under a second to nearly six between two runs here. Budget
generously: a wrongly low timeout is indistinguishable from a hard failure.

### Verified end-to-end through ShellPuppet (2026-07-31)

Each of the four CLIs measured then (Qoder, Grok, Gemini CLI and Goose) was
driven by ShellPuppet's own CLI through start, wait, snapshot, arrow keys,
verified typing and tree-kill:

- **Arrow-key navigation confirmed objectively**: in Qoder the
  `❯` marker moved 1 → 2 and back; in Gemini the `●` marker walked 1 → 2 → 3
  and back. Asserted by regex against the rendered screen.
- **`type --verify` succeeded on all four**, including into Qoder and Goose
  once their load windows had settled.
- **Tree-kill is decisive.** Goose's fleet was enumerated before killing:
  **90 processes alive before, 0 after.** Qoder, Gemini and Grok left no
  survivors either.
- `goose --version` through the daemon-side shell wrap printed `1.41.0` and
  exited 0, so the direct-ConPTY-spawn hang class is handled.

### End-to-end micro-task through the MCP tools (2026-07-31)

Checklist item 7, driven the way real use looks: **Claude Code → MCP `terminal_*`
tools → Qoder CLI**, with a human watching the browser viewer live.

Task: read a 12-line JSONL audit sample, write a dependency-free Node
summariser, run it, report the counts. Qoder (v1.1.10, GLM-5.2) completed it
in roughly two and a half minutes of wall clock, asking permission for the
file write and the `node` run; both were approved with `terminal_key enter`.
Its answer was verified independently against the fixture: 12 events, with
`cli: 4`, `mcp:claude: 5` and `viewer: 3`. So the run was *correct* rather than
merely plausible. The whole session appears in `audit.log` attributed to
`mcp:claude-code`.

Timings for this run: trust prompt at ~4 s, usable prompt **~26 s** after
trusting (23 MCP servers, 14 skills loaded), first agent output ~5 s after
submitting, task complete ~90 s later.

**`type --verify` reads typed text the way an input box wraps it.** A
234-character prompt wrapped across two rows in Qoder's input box, and the
40-character needle straddled the line break. OpenCode draws a border down
its input box and, on a wide screen, a side panel on the same rows; Grok draws
a border on both sides. A comparison that counted any of these would report
`false` for text that had landed perfectly, and an agent trusting that
`false` would retype and **duplicate its input**. OpenCode also draws a long
line only once it has worked through every keystroke: measured at about 7 ms a
character, so a 300-character prompt appears about 2.2 s after it is typed.
Verify allows longer the longer the text.

Two behaviours worth knowing, neither a fault:

- **Long prompts may still need `escape` before retrying.** Wrapping does not
  upset `--verify`, but genuine swallowed-input windows are real (see the
  Qoder row above).
- **A connected browser viewer writes into the PTY on its own.** xterm.js
  answers terminal capability queries (device attributes, cursor position)
  and reports focus to a program that asks for it, and those replies travel
  back through the viewer socket. The daemon passes them to the program and
  files them in `audit.log` as `viewer` `report` entries with their kind, not
  as `input`, so they leave the "last input" indicator alone. Expect a few at
  connect time, one set per connected viewer.

### Gemini CLI authentication is account-dependent

On the test account Gemini reached its auth screen and reported:

> *"This client is no longer supported for Gemini Code Assist for individuals.
> To continue using Gemini, please migrate to the Antigravity suite of
> products."*

This is a Google product change affecting that account, **not** a ShellPuppet
fault: the TUI renders and responds to keystrokes normally right up to that
screen. On such an account Gemini cannot complete the checklist until it is
migrated, or an API-key / Vertex AI path is configured.

## Readiness and idleness regexes (use these, do not invent them)

Driving an agent CLI needs two different signals, and neither is `quiet`:
an agent that is thinking still paints spinners and streaming output.

- **Readiness:** the input box exists and will accept a prompt.
- **Idleness:** the agent has stopped working and wants input again (or is
  blocked on a permission prompt you must answer).

Hand-rolling these per session is the most repetitive part of driving an
agent, and getting them wrong is how a prompt gets typed into a loading TUI
and silently discarded. Start from this table.

For an agent CLI with a signature, `terminal_result` says when a turn has
finished; the table is for knowing when to type, and what blocks it. The
daemon's prompt detection flags these questions in the viewer and through
`terminal_wait`'s `prompt`. Each one quoted was seen on the CLI's own screen,
and each is pinned by a test of the detection from a captured screen, except
Antigravity's: its permission questions are numbered choosers of the shape the
detection reads, with no captured screen in the tests yet. A question
described rather than quoted has not been captured.

| CLI | Ready (wait after start) | In a folder it does not trust yet | Blocked on permission |
|---|---|---|---|
| Claude Code | `? for shortcuts`, or `shift+tab` when a mode other than the default is on | `Is this a project you created or one you trust?` | not yet captured |
| Codex | `Ask Codex` | not seen | `Would you like to run the following command?` |
| Antigravity | `? for shortcuts` | a trust question | `Run this command?`, `Accept this file edit?`, `Allow creation of this file?` |
| Qoder CLI | `Type your message` | `Do you trust the files in this folder?` | `Allow this command to run?`, under `Permission Required` |
| OpenCode | `ctrl+p` | not seen | `△ Permission required` |
| MiMo Code | `ctrl+p` | `Is this a project you created or one you trust?` | `△ Permission required` |
| Grok | its input box, `│ >` | `Do you trust the contents of this directory?` | a chooser whose choices include `Yes, proceed` |
| Goose | `( O)>` | not seen | not yet captured |
| Gemini CLI | `Type your message` (July, 0.52) | a trust question (July) | not yet captured |

In the timing runs above, Antigravity and MiMo Code asked in a fresh folder
and Claude Code, Qoder and Grok did not, so a trust they hold for a parent
folder may carry over.

Antigravity's permission questions are numbered choosers, as are Codex's,
Qoder's and Grok's; OpenCode and MiMo Code draw a bordered dialog that the
daemon recognises by its title.

Two Qoder specifics worth knowing:

- Its **folder-trust prompt** (`Do you trust the files in this folder?`)
  appears on first use in a directory and blocks readiness. Wait on
  `trust the files|Type your message` so a session works either way.
- It shows a **task counter** while working (`Tasks 3/7 completed`). Waiting
  on `Tasks\s+7/7`, or on your own known total, is a reliable "finished"
  signal for a multi-step job, and far better than guessing a timeout.

**`ready: true` is not a readiness signal on its own.** When you pass no
`readyText`/`readyQuiet`, nothing is checked, and `terminal_start` says
so explicitly (`readyReason: not-tracked`). Only `condition-met` is
affirmative.

**`quiet` and `readyQuiet` need a first paint.** Silence from a program that
has not drawn anything yet is "still starting", not "quiet": the condition
holds only once something is on screen and output has then stopped for the
given time. A `quiet` wait on a CLI that is still loading keeps waiting, and
if it times out the result says the program has not painted anything yet.

## Long waits: know your client's own timeout

`terminal_wait` accepts up to 300,000 ms, and this page tells you to budget
generously. But **an MCP client may impose its own, shorter call timeout**
and background the call before ShellPuppet's timeout is reached. Observed
2026-08-01: a client that backgrounds tool calls at 120 s turned every
`timeout: 240000` wait into an asynchronous notification.

That is not a failure: the wait keeps running and its result arrives. If you
need the answer *inline*, though, keep waits under your client's limit and
poll, rather than asking for one long wait and being surprised.

## Reading a session without the agent's reasoning

`terminal_result` and `hideReasoning` read each CLI's screen by its signature
(`src/core/reasoning.ts`), measured on these versions at their default
settings:

If your model's safety checks flag reasoning read off another model's screen
(Claude models at present), pass `hideReasoning: true` on every reading call:
snapshot, wait, find, list and screenshot. Leave it off when the full screen
is needed. A filtered screenshot obscures hidden rows in the image and replaces
their returned text; a filtered list omits waiting prompt questions.

| CLI | Measured | Reasoning drawn on screen | What `hideReasoning` leaves out |
|---|---|---|---|
| Claude Code | 2.1.312 | None: a spinner while it thinks | Nothing |
| Codex | 0.165.0 | None; its commentary before tool calls is a message, kept | Nothing |
| Qoder | 1.1.80 | A Thinking block behind a `│` bar, in italics, kept after the answer | Every Thinking block |
| OpenCode | 2.0.26 | None: `Thinking` while it thinks, then a collapsed `+ Thought · Ns` | Nothing |
| MiMo Code | 0.1.16 | None: a collapsed `+ Thought: Ns` before each tool group and the answer | Nothing |
| Grok | 1.0.70 | A Thinking block behind a `│` bar while it thinks, collapsed to `♦ Thought for Ns` | The live block and the spinner's label |
| Antigravity | 1.4.10 | A one-line summary, `○ Thought for Ns (…)`, and the subject in the spinner | Both |

The signatures for the CLIs that draw no reasoning describe no reasoning block,
so for them `hideReasoning` hides nothing by construction: a version or a
setting that starts drawing reasoning would show it until its signature is
replaced. `terminal_result` also says which prompt its answer follows; check it
is the one you sent.

Start a session with the CLI's own command and nothing more is needed. When it
runs through a shell, a wrapper or a launcher script, name it:
`terminal_start` with `agent: "codex"`, or `shellpuppet start --agent codex
pwsh`. A newer version that draws its screen differently can need a
replacement signature (`configuration.md`).

## Recipes

Start sessions with a readiness condition and verify your typing:

```
shellpuppet start --label qoder qodercli          # then:
shellpuppet wait <id> --text "qoder" --timeout 60000 --debounce 2000
shellpuppet type <id> "your prompt" --verify      # retry after `key <id> escape` if not verified
```

- **Wait on text that only appears in output, or pass `matchAfterInput`.**
  Waiting for text you just typed matches the echo of your own input in
  0 ms. `--match-after-input true` (MCP: `matchAfterInput: true`) ignores
  matches at or before that echo, which is what you want whenever the
  pattern describes the output you asked for.
- **`--prompt` never hands back the prompt you just answered.** It counts as
  answered until the screen has been seen without it, so the natural loop
  (wait → answer → wait) gets the next question, not the last one on a
  screen the TUI had yet to repaint. If the wait times out saying the prompt
  has not changed since your input, the input probably did not land:
  snapshot, then retry the answer.
- **Goose:** `--timeout 150000` on the first wait; prefer `goose run -t "…"`
  for non-interactive work.
- **Qoder:** answer the folder-trust prompt on first use in a directory;
  `--verify` every prompt you type, and treat a failed verify as "press
  `escape`, wait, retry".
- **Expect the human's window to set the grid.** The viewport watching a
  session drives its size, so `cols`/`rows` at `start` say where to *begin*
  and a browser window of a different shape will reshape it (design §5). This
  is deliberate: the alternative would leave the human's viewer unable to fill
  its own window. Their header shows the grid, with `(following)` when another
  viewport is driving it and `(fixed)` when nothing may.

  **Ask for `hold` when a reflow would invalidate the run**: when you compare
  output against a known width, or lay out a fixed frame. `terminal_start`
  takes `hold: true`, `terminal_resize` takes it too and
  `shellpuppet start --hold` / `shellpuppet resize <id> 120 34 --hold` are the
  CLI forms. A held session refuses viewports outright; session state exposes
  it as `geometryHeld`. Without `hold`, a `terminal_resize` still sets the
  grid, and the human's next window move takes it back.

  A viewer sizes nothing until the daemon has told it the session's grid and
  who drives it (design §5). If a grid changes when you did not expect it to,
  check `terminal_list` for `watchers`.

## Manual smoke checklist (@manual, not runnable in CI)

These need real credentials and minutes of wall-clock; run them by hand per
release and record timings back into the table above. For each agent CLI you
drive:

1. `shellpuppet start --label <cli>-smoke <cli>`: note the time to first
   frame (`wait --regex "." --timeout 150000` and read `waitedMs`).
2. Snapshot after paint: the UI renders sanely (borders, colour, no garbling).
3. Send `key <id> down` / `up`: the selection marker moves.
4. Type a trivial prompt with `--verify`: the text lands (for Qoder, after the
   trust prompt and once the status bar settles).
5. Watch in the viewer window, or open a link from `viewer-url`: it mirrors
   live, typing from the browser reaches the session and the input-source
   indicator flips.
6. `kill <id>`, then confirm no `<cli>` processes survive
   (`Get-Process`/`ps`), including MCP-server children.
7. One end-to-end micro-task per release candidate.

Record: first-frame time, any new swallowed-input windows, any prompt changes
(trust dialogs, update banners) that recipes should mention.

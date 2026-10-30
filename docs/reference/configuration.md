# ShellPuppet configuration

All configuration lives in one optional file: `~/.shellpuppet/config.json`
(override the directory with the `SHELLPUPPET_HOME` environment variable).
No file means all defaults. The **daemon** reads it at startup, so run
`shellpuppet daemon restart` after editing. The MCP adapter reads its own
`mcp` section at launch.

Full example, everything optional:

```jsonc
{
  // Command policy (design §4.3), off by default.
  "policy": {
    "mode": "allow-all",              // "allow-all" | "allowlist" | "denylist"
    "allow": ["^qodercli", "^goose", "^gemini", "^grok"],
    "deny": ["rm\\s+-rf\\s+/", "format\\s", "^shutdown"],
    "maxSessions": 10                 // no cap unless set
  },

  // Minutes with no sessions, no viewers and no API calls before the daemon
  // exits (fractions allowed). It never exits while a session is running.
  "idleMinutes": 30,

  // Session environment hygiene (design §4.6, ADR-008):
  //   "clean" (default): a minimal functional set (PATH, HOME/USERPROFILE,
  //                  the platform's system scaffolding, the locale on POSIX)
  //                  and nothing else from the daemon's environment.
  //   [ "MY_SETTING" ]: the clean functional set PLUS exactly these
  //                  variables. (A bare list would strip system scaffolding
  //                  processes need to start at all; node.exe, for one,
  //                  aborts without SystemRoot on Windows.)
  //   "passthrough": sessions inherit the daemon's whole environment, which
  //                  is whatever the first client that auto-started it had,
  //                  API keys included. See security-model.md.
  // TERM and COLORTERM are always injected regardless.
  "sessionEnv": "clean",

  // Variables a caller may copy from its OWN environment into a session it
  // starts by naming them: terminal_start's envNames and shellpuppet start
  // --env-name, for a program that is not an agent CLI. Empty by default:
  // nothing is passed until you list it. See below.
  "envNames": [],

  // Audit log (design §4.5). captureContent also records the full
  // text of every keystroke: SECRET-CAPTURING, for debugging only.
  "audit": {
    "captureContent": false
  },

  // How the viewer window opens when a session starts.
  "viewer": {
    //   "isolated-app"    (default): a chromeless window in ShellPuppet's OWN
    //                     browser profile, so the viewer shares no cookie jar,
    //                     storage or history with your normal browsing, and
    //                     the viewer grant in the URL stays out of your normal
    //                     history. Needs a Chromium-family browser (Chrome,
    //                     Edge, Chromium, Brave, Vivaldi); Edge ships with
    //                     Windows. Falls back to the default browser if none
    //                     is found; it never fails a session start.
    //   "default-browser": hand the URL to your normal browser.
    //   "none":           open nothing. Use this on unattended or headless
    //                     machines, where a window nobody sees just piles up.
    //                     A session start then hands its caller a viewer link.
    "launchMode": "isolated-app",

    // Override detection with a specific binary. Named explicitly means named:
    // if this path does not exist, nothing is detected in its place.
    // "browserPath": "C:/Program Files/Microsoft/Edge/Application/msedge.exe",

    // Where the isolated profile lives. Defaults to <home>/viewer-profile.
    // Per-daemon, not per-session, so window position and your text-size
    // preference persist instead of starting cold every time.
    // "profileDir": "C:/Users/you/.shellpuppet/viewer-profile"
  },

  // Permission dialogs to recognise beyond the built-in ones, for a program
  // that draws its dialog inside its own screen. See below.
  "prompts": {
    "dialogs": [
      // { "name": "Example CLI", "title": "wants to run a command",
      //   "choices": "\\[ Approve \\] {2,}\\[ Deny \\]" }
    ]
  },

  // MCP adapter options.
  "mcp": {
    // Wrap screen content returned by tools in UNTRUSTED DATA delimiters.
    "untrustedFraming": true
  }
}
```

`config.json` is plain JSON: take the comments out before you save it.

## Reading an agent's screen without its reasoning

`terminal_snapshot`, `terminal_find` and `terminal_wait` with `hideReasoning`,
and `terminal_result`, read an agent CLI's screen by a **signature**: how that
program draws its reasoning, its answer, its busy line, its composer and the
chrome around it. Claude Code, Codex, Qoder, OpenCode, MiMo Code, Grok and
Antigravity are built in, each measured on the version `agent-profiles.md`
names. A
session uses the signature named by `terminal_start`'s `agent` (CLI
`--agent`), or else the one whose `programs` include its start command's
name; a session with neither is refused by these readers.

Add a program, or replace a built-in one after its screen changes, under
`agents.signatures`:

```jsonc
{
  "agents": {
    "signatures": [
      {
        "name": "mycli",                       // what terminal_start's agent takes
        "programs": ["mycli"],                 // start commands that select it
        "composer": { "text": "^> " },         // the last line that passes is the composer
        "chrome": [{ "text": "^─{10,}" }],     // lines between the transcript and the composer
        "busy": [{ "text": "esc to interrupt" }],
        "turn": { "text": "^> \\S" },          // the echo of the person's prompt
        "reasoning": [
          {
            "start": { "text": "^Thinking", "lead": { "italic": true } },
            "continues": { "text": "^  ", "body": { "italic": true } }
          }
        ],
        "answer": { "start": { "text": "^• ", "word": { "bold": false } }, "continues": { "text": "^  \\S" } },
        "trailer": { "text": "^Worked for " }
      }
    ]
  }
}
```

A line test takes `text`, a JavaScript regular expression matched against the
line; `lead`, how its first character that is not a space is drawn; `word`,
how the character after that is drawn; and `body`, how every character after
the first is drawn. A style test takes `bold`, `dim` and `italic` as true or
false, and `fg` or `notFg` as lists of colours: `"default"`, `"p<n>"` for
palette entry n, or `"#rrggbb"`. A block has a `start` line and the lines
that `continues` it; an answer whose paragraphs all look alike takes
`"upward": true`. `tidy` is a regular expression for decoration drawn on the
same rows as the text, such as a right-aligned time or a side panel: it is
removed from what `terminal_result` returns, and a row that holds nothing
else counts as blank. `typed` is a line test that, matched on the composer,
means a prompt is typed and not yet sent, so a result is refused rather than
the turn before it offered. `"requireTrailer": true` refuses a result until
the `trailer` line that closes a finished turn is drawn. An entry with a
mistake is reported in `daemon.log` as a `CONFIG PROBLEM` and left out; a
session that would have needed it is refused. An entry whose pattern runs
past the regular-expression time budget is reported in `daemon.log` and set
aside for a minute, and its sessions are refused meanwhile.

## Recognising a program's own permission dialog

ShellPuppet notices a session waiting on a permission prompt by the shapes
choosers are drawn in: numbered options, a pointer, letter keys, yes/no. Some
programs draw their dialog inside their own interface instead, with the
choices as a row of buttons. Those are recognised by a **signature**: a
pattern for the dialog's title, and one for its row of choices. Both are
JavaScript regular expressions, matched case-sensitively within a line of the
screen, so a sidebar drawn on the same rows does not get in the way. A live
dialog is drawn at the bottom of the screen, so the row of choices must have
at most `below` lines under it with anything but the dialog's border on them
(default 4, at most 20), and the title must sit at most `within` lines above
it (default 40, at most 100). What `choices` matches, less any border in
front of it, split at runs of two or more spaces, becomes the list of
options. The lines between the title and the choices tell one request from
the next, so that answering one does not mark the next as answered. All of
their text counts, anything drawn beside the dialog on those lines included,
so two different requests are never taken for one; a resize, or a change in
that text, makes the same dialog look new to the stall alert.

OpenCode's and MiMo Code's dialogs are built in. Add others under
`prompts.dialogs`, as in the example above. A recognised dialog is a prompt
like any other: `terminal_list` shows the session waiting, `terminal_wait`
with `prompt: true` returns it and the stall alert fires. An entry that does
not compile is reported in `daemon.log` as a `CONFIG PROBLEM` and left out;
the others, and the built-in ones, still work. A signature whose pattern
runs past the regular-expression time budget on a screen, built-in or from
config, is reported there too, each time, and set aside for a minute, then
tried again; meanwhile its dialog is not recognised. Write patterns
specific enough not to match ordinary output: anchor them to what the
program draws around its dialog, such as a border, as the built-in ones do,
so that a transcript, a diff or a file listing quoting the dialog's words is
not read as the dialog.

## What a session's environment holds

By default (`"sessionEnv": "clean"`) a session gets a minimal functional set
from the daemon's environment and nothing else: `PATH`, the home and temporary
folders, the platform's system variables (on Windows also the standard
`ProgramFiles`, `CommonProgramFiles`, computer, domain and `PSModulePath`
variables that toolchains look for) and, on POSIX, the login name and locale.

- **To add a setting a program needs**, list its name:
  `"sessionEnv": ["JAVA_HOME", "NODE_EXTRA_CA_CERTS"]` gives the clean set
  plus those two. Some names stay out of the clean set on purpose:
  `SSH_AUTH_SOCK` grants the use of your SSH keys, the proxy variables
  (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) can hold a password in the proxy
  URL and `NODE_EXTRA_CA_CERTS` changes which certificates Node trusts. Name
  them when a session needs them. Names match without regard to case, on
  every platform.
- **To hand over a key**, don't list it in `sessionEnv`, which would give it to
  every session: pass it to the session that needs it, as described below.
- **To hand every session the daemon's whole environment**, set
  `"sessionEnv": "passthrough"`. The daemon names the variables in it whose
  names look like credentials, once in `daemon.log` at start and in
  `shellpuppet daemon status`. It names them, never their values. The names
  are a guide, not a complete list: a variable such as `DATABASE_URL` can hold
  a password without saying so.

The daemon reads `sessionEnv` when it starts, so a change takes effect at the
next daemon start. `shellpuppet daemon status` shows the mode in use.

## The variables each agent's sessions receive

A session gets the environment `sessionEnv` gives it, and the daemon never
sees variables that exist only in the environment of the client starting a
session, such as a key a secrets manager put there for that one client. List,
per agent CLI, the variables its sessions take from the starting client's
environment:

```json
{
  "agents": {
    "passEnv": {
      "qoder": ["QODER_PERSONAL_ACCESS_TOKEN"],
      "opencode": ["OPENCODE_API_KEY"]
    }
  }
}
```

A session that runs as one of these agents, because `terminal_start`'s
`agent` or the CLI's `--agent` names it or because its command is that
program, receives the variables listed for it, copied from the environment of
the MCP server or the CLI that starts it, with nothing named at start. It
receives nothing else: a name asked for at start that is not on its agent's
list refuses the start. A listed name that is not set in the client's
environment is reported by name, and the session starts without it. An agent
with no entry receives nothing.

The MCP server and the CLI read the lists at every start, so a change applies
to the next session started, with no restart. A session already running keeps
the environment it started with: start it again to give it a variable added
since. Values are never shown in tool results, the
CLI's output, logs, the audit trail or the viewer; the audit trail records the
names, and the agent when the start named one. Naming an agent at start gives
the session that agent's list whatever it runs, so list a key only for agents
whose sessions may see it. A mistake in an entry, such as an agent with no
signature or a list that is not one, is reported in `daemon.log` as a
`CONFIG PROBLEM` and that entry is left out; the rest still applies.

## Passing a variable to a session that is not an agent

For a program that is not one of the agent CLIs, name the variable at start
instead:

1. List its name in `envNames`, at the top level of `config.json`, for
   example `"envNames": ["NPM_TOKEN"]`. The MCP server and the CLI read
   the list at every start, so a change needs no restart.
2. Name it when you start the session: `terminal_start`'s `envNames`, or
   `shellpuppet start --env-name NPM_TOKEN ...` (repeat the flag for
   more than one). The MCP server or the CLI copies the value from its own
   environment and the session gets it on top of whatever `sessionEnv` gives
   it.

This one list governs both routes: `terminal_start`'s `envNames` and the
CLI's `--env-name` can each ask only for names on it. The list is yours, not
the agent's: a name that is not on it refuses the start. A listed name that is
not set in the client's environment is reported by name, and the session
starts without it. Values are never shown in tool results, the CLI's output,
logs, the audit trail or the viewer; the audit trail records the names. An
entry that is not a variable name is left out, and a value that is not a list
passes nothing; either is reported in `daemon.log` as a `CONFIG PROBLEM`, by
the MCP server on stderr, and by the CLI on a start that names a variable.

## Policy notes

- Policy patterns are regular expressions matched **case-insensitively** against the
  space-joined command line as the caller passed it (`goose session`), never
  against the internal Windows shell wrapper.
- **Anchor your allow patterns.** Patterns match *anywhere* in the command
  line: an unanchored allow rule like `goose` also matches
  `powershell -c "anything… goose"`, which is almost never what you meant.
  Write `^goose` (as in the example above) so the rule pins the command word.
  Deny rules are the opposite: matching broadly is the safe direction.
- Deny rules are honoured in `allowlist` mode too; deny always wins.
- `maxSessions` caps how many sessions may be live at once, and a start
  beyond it is refused with the cap named in the error. There is no cap
  unless it is set. Set one if a runaway client could start sessions in a
  loop: every live session costs the daemon memory and runs processes of
  its own.
- A malformed pattern **fails closed**: every command is refused, with the
  broken pattern named in the error, until the config is fixed.
- A malformed policy **section** (wrong shapes, such as a string where an array
  belongs or an unknown or misspelt key) also fails closed the same way, and a
  `config.json` that cannot be parsed at all refuses every command and drops
  sessions to the `clean` environment until it is fixed. Problems are logged
  as `CONFIG PROBLEM` lines in `daemon.log` at startup.
- Policy governs commands only. `security-model.md` says why keystrokes are
  deliberately out of scope.

## Locations

| File | Purpose |
|---|---|
| `~/.shellpuppet/config.json` | This configuration |
| `~/.shellpuppet/daemon.json` | Daemon discovery record + client token (managed; do not edit) |
| `~/.shellpuppet/daemon.log` | Daemon log (JSONL) |
| `~/.shellpuppet/audit.log` | Action audit (JSONL, append-only) |

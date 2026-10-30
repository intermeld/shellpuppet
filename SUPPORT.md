# Getting help

This page tells you where things go.

| You want to… | Go to |
|---|---|
| Ask a question | [Q&A in Discussions](https://github.com/intermeld/shellpuppet/discussions/categories/q-a) |
| Float an idea, or tell us what you wish it did | [Ideas in Discussions](https://github.com/intermeld/shellpuppet/discussions/categories/ideas) |
| Show what you've built with it | [Show and tell in Discussions](https://github.com/intermeld/shellpuppet/discussions/categories/show-and-tell) |
| Report a bug | [Open a bug report](https://github.com/intermeld/shellpuppet/issues/new?template=bug_report.yml) |
| Request a specific feature | [Open a feature request](https://github.com/intermeld/shellpuppet/issues/new?template=feature_request.yml) |
| Report a security problem | **Not an issue.** See [SECURITY.md](SECURITY.md) |
| Ask about Intermeld, the commercial platform | hello@redeagle.tech |
| Ask about using the names or logos | [TRADEMARKS.md](TRADEMARKS.md) |

## What to include in a bug report

- ShellPuppet version or commit, Node.js version, operating system and
  version.
- Which part: daemon, CLI, MCP server or viewer, and which agent CLI you were
  driving, if any.
- What you did, what you expected, what happened instead. The relevant lines
  of `~/.shellpuppet/daemon.log` help enormously.
- Anything unusual about your configuration: command policy, `sessionEnv`,
  viewer launch mode.
- A pull request that fixes it. Not required, but it would make our day.

Please check the log for secrets before pasting it. Terminal output often
contains tokens and keys that programs echo, and an issue is public.

## Response expectations

Discussions are for questions, ideas and what people build; issues are for
bugs and specific feature requests. Feedback of every kind is read, and it
shapes the [roadmap](ROADMAP.md): an idea that turns into agreed work becomes
an issue and appears there.

A maintainer reads every issue and discussion. You'll usually hear back within
a few working days; if a week passes in silence, nudge the thread. Security
reports follow the timelines in SECURITY.md.

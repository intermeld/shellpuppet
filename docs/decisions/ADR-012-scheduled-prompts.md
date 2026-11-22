# ADR-012: Scheduled prompts for named sessions

**Status:** Accepted
**Date:** 2026-11-21

## Decision

An owner-written schedule in `config.json` switches on delivery of that
owner's text. Messaging can stay off. ADR-010 continues to govern peer
messages. A schedule follows a session name through relaunches and chooses
whether to skip a busy turn or queue the line where the agent supports it.
The daemon evaluates five-field cron in UTC, once per minute, and discards
missed runs.

## Reasons and alternatives

A session id ends with its process. A name lets the owner keep the same
regular check across restarts. A single configuration section can serve
future MCP and dashboard editors through the same validated read and
replace API. A separate database or operating-system job would duplicate
state and still need the daemon to inspect the live terminal.

## Consequences

Edits take effect while the daemon runs. The composer checks, input queue,
separate submit key and pending-body rules from ADR-010 protect a person's
draft and waiting questions. The CLI shows the next UTC run and last
outcome. Each run leaves an audit entry without the prompt text.

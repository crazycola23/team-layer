# Handoff

> The prose form, for reading. The machine form is `templates/handoff.json`
> published with `teamctl handoff publish`, and that is the one the recipient's
> `teamctl inbox` sees. Publish the JSON; write this only when a human needs the
> same content in a document. Both carry the same fields, so if they disagree the
> JSON is authoritative — it is the one whose input snapshot is checked for
> staleness before the recipient may acknowledge it.

- **Session:** `<session-id>`
- **Task:** `<task-id>`
- **From:** `<agent-id> / <role>`
- **To:** `<role or agent-id>`
- **Base revision:** `git:<sha>`
- **Candidate / decision revision:** `<git/spec revision>`

## Authoritative inputs

- `<contract/spec/input>@<revision>`

## What changed / was decided

- ...

## Evidence

- Commit(s): ...
- Validation: `<command>` → `<result>`
- Canonical IDs/revisions: ...

## Unresolved / blockers

- None / ...

## Recipient next action

- One precise action the recipient should perform next.

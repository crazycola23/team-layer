# Codex Adapter

## Preferred per-worktree binding

Use a worktree-local, untracked `AGENTS.override.md`.

The helper writes a tiny bootstrap such as:

```markdown
# Persistent Agent Identity (local)

You are `fullstack-01`, role `fullstack`.
Before substantive work or after context loss, read:
`/absolute/path/to/~/.agent-team/agents/fullstack-01/bootstrap.md`.
Durable project/task truth overrides conversation memory.
```

Codex aggregates `AGENTS.override.md` / `AGENTS.md` along the project hierarchy. Keeping the
local identity in the override file gives each worktree a different role while the tracked
`AGENTS.md` remains shared project guidance.

The helper adds `/AGENTS.override.md` to Git's local exclude.

## Context budget

Keep the override tiny. Codex project instructions have a bounded context budget; use them as
a map to role/protocol/task artifacts rather than a monolithic employee handbook.

## Do not

- duplicate the entire role manual into every worktree override;
- depend on model/provider-specific behavior for identity semantics;
- let project `AGENTS.md` claim one individual Agent identity for all worktrees.

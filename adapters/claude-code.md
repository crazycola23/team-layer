# Claude Code Adapter

## Preferred per-worktree binding

Use a worktree-local, untracked `CLAUDE.local.md` containing an import of the durable Agent
bootstrap:

```markdown
# Persistent Agent Team — local identity
@/absolute/path/to/~/.agent-team/agents/fullstack-01/bootstrap.md
```

Why this is the preferred binding:

- `CLAUDE.local.md` is local to the worktree and loads alongside shared `CLAUDE.md`;
- three Claude Code windows can therefore hold three different persistent identities;
- tracked project-wide `CLAUDE.md` remains team/project guidance, not individual identity;
- the bootstrap can import/read the current role/protocol without permanently inflating the
  project instructions.

External imports may require a one-time approval when first encountered from a project-level
memory file.

The helper CLI creates this adapter and adds `/CLAUDE.local.md` to Git's local exclude.

## Launch-time fallback

Claude Code also supports adding a file to the system prompt for a particular invocation:

```bash
claude --append-system-prompt-file /path/to/bootstrap.md
```

This is useful for a harness wrapper that already owns process launch. Prefer appending rather
than replacing the default system prompt unless the wrapper intentionally takes responsibility
for all default Claude Code tool/safety guidance.

## Do not

- write Product/Fullstack/Reviewer identity into tracked `CLAUDE.md`;
- copy the full team manual into `CLAUDE.local.md`;
- rely on conversation auto-memory as the source of role identity.

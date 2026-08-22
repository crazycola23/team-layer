# Persistent Agent Team

A harness-neutral Agent Skill for running three long-lived software-delivery roles:

- Product Architect
- Fullstack
- Reviewer

The design assumes Agents can run in separate windows/worktrees, sometimes independently and
sometimes as one team. Agent identity survives model/harness changes and context compaction.
Shared truth lives outside conversation memory.

## Architecture

```text
                  User
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
       Product   Fullstack   Reviewer
       Architect
          │         │         │
          └─────────┼─────────┘
                    │
             Team protocol
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
      spec-suite          durable state
   truth / unresolved     identity / handoff
   scope / merge gate
          └─────────┬─────────┘
                    ▼
                  Git/CI
```

## The important separation

```text
Identity = who the Agent is               (stable)
Role     = what the Agent owns             (stable-ish)
Harness  = where it currently runs         (replaceable)
Model    = which model powers it            (replaceable)
Task     = what it is doing now             (temporary)
Context  = volatile working memory          (disposable)
```

## Quick start

Create three worktrees as you normally would, then run one setup command in each.

### Product Architect on Claude Code

```bash
node scripts/teamctl.mjs setup \
  --agent-id product-01 \
  --role product-architect \
  --harness claude-code \
  --repo /path/to/product-worktree
```

### Fullstack on Codex

```bash
node scripts/teamctl.mjs setup \
  --agent-id fullstack-01 \
  --role fullstack \
  --harness codex \
  --repo /path/to/fullstack-worktree
```

### Reviewer on Gemini CLI

```bash
node scripts/teamctl.mjs setup \
  --agent-id reviewer-01 \
  --role reviewer \
  --harness gemini-cli \
  --repo /path/to/reviewer-worktree
```

`setup` is idempotent for the same Agent/role. It writes durable identity under
`~/.agent-team/agents/<agentId>/` (or `$AGENT_TEAM_HOME`) and a local, untracked binding in
the worktree.

Run:

```bash
node scripts/teamctl.mjs doctor --repo .
```

to verify the binding, identity, role version, and adapter.

## Adapter behavior

- **Claude Code:** creates a worktree-local `CLAUDE.local.md` importing the Agent bootstrap.
  This gives different worktrees different identities without touching tracked `CLAUDE.md`.
- **Codex:** creates worktree-local `AGENTS.override.md` with the minimal identity and a pointer
  to the full bootstrap.
- **Gemini CLI:** creates `AGENT.bootstrap.md` and an Agent-specific Gemini settings file plus
  launcher script so `GEMINI.md` remains available and the identity context is added locally.
- **Generic:** creates `AGENT.bootstrap.md`; configure the harness to inject/read it at startup.

Adapter files are added to Git's local exclude file rather than modifying the repository's
tracked `.gitignore`.

## What the helper does NOT do

It does not launch Agents, create cloud resources, decide model choice, rewrite shared
project instructions, implement a second merge gate, or grant capabilities. It exists to
make identity/bootstrap boring and repeatable.

## spec-suite

When the target project uses `spec-suite`, keep its current task/merge-gate semantics
canonical. This skill uses `subject`, `role`, `baseRevision`, `readSet`, and `writeSet`, and
adds a team-level semantic `inputs` list for contract digests where useful. The latter must
not be forced into spec-suite artifacts that do not support it.

## Validate this skill

```bash
npm test
npm run validate
```

The tests use temporary Git repositories and temporary Agent homes; they do not touch your
real `~/.agent-team` directory.

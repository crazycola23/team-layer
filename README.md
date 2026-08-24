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

## After a lost context

The ledger lives in the Git common directory, so all linked worktrees share one and it survives
anything that happens to a conversation. One command reads it and answers where an Agent is:

```bash
node scripts/teamctl.mjs reconcile
```

It takes no arguments — identity comes from the worktree binding, session and task from the ledger,
the candidate from `HEAD` — and answers with a status, the session and task, three-valued
freshness, and a single `nextAction` with the reason that chose it. It exits `0` whatever it finds,
so "you have a review to address" can never be mistaken for the tool having failed to look.

`node scripts/teamctl.mjs help` lists the rest: sessions and tasks, handoffs, review decisions,
the task's frozen validation plan, the spec-suite projection, and metrics counted from the sealed
event log. See [protocol/recovery.md](protocol/recovery.md).

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
project instructions, implement a second merge gate, or grant capabilities. It keeps durable
state and answers questions about it; every judgment call stays with the Agent or the user.

## spec-suite

When the target project uses `spec-suite`, keep its current task/merge-gate semantics
canonical. This skill uses `subject`, `role`, `baseRevision`, `readSet`, and `writeSet`, and
adds a team-level semantic `inputs` list for contract digests where useful. The latter must
not be forced into spec-suite artifacts that do not support it.

There is no capability handshake, so the projection detects what the installed version can carry
and reports a `compatibility.mode` of `full` or `degraded` alongside the fields it withheld and why.
`degraded` is today's expected answer: no installed spec-suite carries semantic `inputs`, so
staleness against a contract revision is enforced in this layer only. That is a named boundary with
a documented consequence, not a silent omission — see
[protocol/spec-suite.md](protocol/spec-suite.md).

The two gates compose rather than duplicate. `teamctl validate-candidate --phase
pre-merge|post-replay` answers the semantic half — is the task current, has it been validated
against this exact commit, did somebody with the authority approve it — and is meant to be called
*by* spec-suite's external validation hook. It never re-derives ancestry or write scope: it reads
`safeToMerge` out of spec-suite's own merge-gate result and refuses to guess when nobody supplied
one. `integrationReady` is the conjunction, and it is false unless both verdicts passed and both
are about the same commit, which is what stops a replay from pairing a pass about the old tree with
a pass about the new one.

## Validate this skill

```bash
npm test
npm run gen:check
npm run validate
```

`gen:check` fails if a generated schema is out of date with the source of truth it was derived
from. `validate` checks the things a passing test suite cannot: that generated schemas say what
they were generated from, that every task-packet field has been classified as projectable or not,
that every action `reconcile` can name is in its precedence list, and that no document tells an
Agent to run a command the CLI does not have.

The tests use temporary Git repositories and temporary Agent homes; they do not touch your
real `~/.agent-team` directory.

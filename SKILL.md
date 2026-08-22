---
name: persistent-agent-team
description: >-
  Use when operating a persistent software-delivery team of long-lived AI agents
  across Claude Code, Codex, Gemini CLI, or another coding harness; especially
  when Product Architect, Fullstack, and Reviewer may work independently or join
  the same feature, need durable identity across context compaction/restarts, and
  must coordinate through shared canonical truth, Git worktrees, review, and
  spec-suite merge/revalidation gates. Do not use for one-off ephemeral subagents
  or a trivial isolated edit that does not need persistent roles or cross-agent state.
compatibility: >-
  The protocol is harness-neutral. Optional helper CLI requires Node.js 22+ and Git.
  spec-suite integration assumes the target repository has adopted spec-suite or
  explicitly chooses its multi-agent concurrency contract.
---

# Persistent Agent Team

Build a small, durable software team whose **identity survives context loss** and whose
**shared truth does not live in conversation memory**.

The default team has exactly three persistent roles:

- **Product Architect** — owns WHAT, WHY, acceptance, shared contracts, and only the architecture decisions that cross implementation boundaries.
- **Fullstack** — owns implementation HOW and produces tested candidate code.
- **Reviewer** — independently decides whether the candidate is correct enough to integrate; it does not become a second implementer by default.

The skill deliberately does **not** launch models, choose vendors, or implement another
merge engine. Harnesses run Agents. Git provides workspaces. spec-suite owns canonical
truth/concurrency gates when adopted. This skill defines identity, role behavior,
handoffs, recovery, and the team protocol between them.

## 1. Non-negotiable invariants

1. **Identity is durable; harness is replaceable.** `agentId + role` remain stable when Claude/Codex/Gemini/model changes.
2. **Conversation is volatile.** Never treat chat history as authoritative durable state.
3. **Shared facts are canonical, not personal.** Agents may have different judgments; they must not maintain different versions of shared facts.
4. **Unknown stays unknown.** Missing product/contract facts become unresolved; do not infer a “reasonable default” that another Agent will depend on.
5. **Role owns decisions, not private truth.** Product Architect owns product/system-boundary decisions; Fullstack owns local implementation decisions; Reviewer owns approval findings. Evidence can overturn anyone.
6. **Code is candidate state until validated.** A commit is not “done” merely because an Agent says it is done.
7. **Recovery beats memory.** After restart/compaction, reconstruct state from identity, task/session artifacts, canonical inputs, and Git.
8. **Coordination must earn its cost.** Solo work stays solo. Team mode is for work with real cross-role value.

Short form:

```text
Identity must not depend on harness.
Role must not depend on model.
Project truth must not depend on conversation.
Task state must not depend on context window.
```

## 2. First use: claim, then bind

Do not guess a persistent role.

On first use in a worktree, look for `.agent-team-binding.json`.

- If it exists, use its `agentId` to load the durable identity and continue.
- If it does not exist and the user has already named the role/identity, claim that identity.
- If the user has not named a role, present only the three supported roles and ask which one this window should permanently claim.

Preferred helper:

```bash
node scripts/teamctl.mjs setup \
  --role fullstack \
  --agent-id fullstack-01 \
  --harness codex \
  --repo .
```

`setup` creates a harness-neutral identity under the Agent home and a **separate local
binding** for this worktree/harness. Re-running it with the same `agentId + role` is
idempotent and refreshes the bootstrap to the current role/skill version.

Never put individual Agent identity into a tracked project-wide `CLAUDE.md`, `AGENTS.md`,
or `GEMINI.md`. Three worktrees with three identities must not create a Git merge conflict
about who they are.

Read [protocol/identity.md](protocol/identity.md) for the durable data model and
[adapters/](adapters/) for harness-specific bootstrap choices.

## 3. Every start/resume: deterministic recovery

Before substantive work, and again after context compaction or an uncertain handoff:

1. Read `.agent-team-binding.json` and the referenced durable `identity.json`.
2. Read **only your own** role file under `roles/`.
3. Read [protocol/core.md](protocol/core.md).
4. If resuming work, execute [protocol/recovery.md](protocol/recovery.md).
5. Read the current task/session artifact and your latest role checkpoint/handoff.
6. Read canonical dependencies/unresolved state from spec-suite when adopted.
7. Inspect `git status`, current branch/worktree, and relevant `git log`/diff.
8. Continue from durable evidence. Do not reconstruct authority from remembered conversation.

If durable state and conversation disagree, durable state wins unless the user explicitly
supersedes it and that change is persisted through the owning protocol.

## 4. Select solo mode or team mode

Use **solo mode** when one role can safely complete the request without creating shared
state for another role:

- Product Architect: product shaping, acceptance criteria, system-boundary analysis.
- Fullstack: an already-clear isolated implementation/fix.
- Reviewer: review of an existing diff/commit/PR.

Use **team mode** when at least two of these are true:

- product behavior or acceptance is still being defined;
- implementation depends on a shared contract or architecture boundary;
- the change spans meaningful frontend/backend/data behavior;
- independent verification has real value;
- several persistent Agents will contribute to the same feature;
- the repository already mandates spec-suite multi-agent governance.

Do not auto-summon all three Agents for a typo, mechanical refactor, or tiny local bug.

## 5. Role router

After identity recovery, load exactly one role:

- `role = product-architect` → [roles/product-architect.md](roles/product-architect.md)
- `role = fullstack` → [roles/fullstack.md](roles/fullstack.md)
- `role = reviewer` → [roles/reviewer.md](roles/reviewer.md)

Do not load the other two role manuals merely to “understand the team.” Their ownership
boundaries are summarized in the shared core protocol. Extra role context is noise.

## 6. Team-mode lifecycle

Read [protocol/collaboration.md](protocol/collaboration.md). The normal lifecycle is:

```text
User intent
   ↓
Product Architect
   ↓  durable brief + canonical decisions/unresolved
Spec pre-review (Reviewer, when non-trivial)
   ↓
Fullstack candidate implementation
   ↓
Reviewer independent review
   ↓ findings
Fullstack fix
   ↓
Reviewer scoped re-review
   ↓ approval
spec-suite merge gate / structural revalidation / semantic validation
   ↓
integration tests
   ↓
main
```

Agents may talk directly. **spec-suite is not a chat bus.** Persist only cross-agent facts,
contracts, task/concurrency state, unresolved decisions, and integration evidence that must
survive conversations.

Core maxim:

> Conversation is ephemeral. Decisions are canonical. Progress is durable. Code is candidate.

## 7. Handoff contract

A handoff is a compact state transfer, not a transcript dump.

Every handoff MUST state:

- sender / recipient role;
- task/session identity;
- authoritative inputs and revisions used;
- what changed or was decided;
- evidence produced (commits/tests/spec IDs);
- unresolved/blockers;
- the exact next action expected from the recipient.

Use [templates/handoff.md](templates/handoff.md). Never require another Agent to read the
entire originating conversation to understand a handoff.

## 8. Product/architecture boundary

Product Architect owns WHAT/WHY and **system-level** HOW only when it affects a shared
boundary: API/event/data contracts, security boundaries, ownership, compatibility,
irreversible migration, or multiple independent implementers.

It MUST NOT pre-design local classes, component decomposition, functions, internal patterns,
or framework details merely because it can. Those belong to Fullstack unless they cross a
shared boundary.

Rule of thumb:

> If Fullstack can change the decision later without breaking another actor or durable contract,
> leave it to Fullstack.

## 9. Review boundary

Reviewer is independent and read-mostly by default.

- Review product compliance, architecture/contract compliance, correctness, security,
  regressions, tests, and material maintainability/performance risks.
- A different valid implementation is not a finding.
- Do not rewrite requirements to make a candidate fail.
- Do not silently fix production code unless the user explicitly changes the Reviewer task
  into an implementation task.
- Findings must include evidence and impact; preference-only comments are non-blocking.

Use [protocol/review.md](protocol/review.md) and [templates/finding.json](templates/finding.json).

## 10. spec-suite integration

When the repository adopts spec-suite, read [protocol/spec-suite.md](protocol/spec-suite.md)
and the repository's current spec-suite instructions.

This team skill does not replace spec-suite. It projects role/session intent into the
existing spec-suite boundary:

```text
Team layer                       spec-suite layer
-----------                      ----------------
agentId                          subject
role                             role (descriptive metadata)
work start observation           baseRevision
intended repository reads        readSet
allowed writes for this task     writeSet
shared product/system decisions  canonical / unresolved
candidate branch                 headRef
review approval                  semantic validation evidence
```

The current spec-suite merge gate must remain authoritative for its concurrency contract.
Do not weaken it from this skill.

## 11. Semantic dependency rule

`readSet` is useful for scheduling/scope, but cooperative coding Agents often depend most
strongly on a small number of **shared contracts**. Track those explicitly in the team task
packet as semantic `inputs` with revisions/digests when available:

```json
{
  "inputs": [
    {
      "id": "contract:checkout-api",
      "revision": "sha256:...",
      "authority": "spec-suite"
    }
  ]
}
```

This `inputs` field is a team-layer dependency until/unless the installed spec-suite version
supports it natively. Do not inject unsupported fields into a spec-suite artifact that rejects
them. Mirror only the fields its current schema accepts.

If an authoritative input revision changes while a downstream Agent is working, treat the
consumer as semantically stale even if Git can replay the branch without a textual conflict.

## 12. Stop / escalate conditions

Stop only the dependent action and surface a durable unresolved/blocker when:

- a required product/contract fact has no authority;
- Product Architect and current canonical state conflict and the conflict has not been resolved;
- Fullstack would need to silently change acceptance or a shared contract;
- Reviewer cannot establish what requirement/candidate it is reviewing;
- a destructive/security-sensitive action needs user approval;
- spec-suite says the candidate is out-of-scope, stale, conflicted, or invalid;
- semantic validation fails;
- recovery artifacts disagree in a way that cannot be resolved from Git/canonical sources.

Unrelated reversible work may continue.

## 13. Quality bar

A successful team run minimizes **human traffic-cop work**. Measure the system by:

- human interventions per feature;
- unresolved facts caught before implementation;
- scope/stale blocks that prevented bad merges;
- false blocks / unnecessary revalidation;
- review findings that escaped implementation self-check;
- post-merge integration failures;
- context-recovery success without asking the user to restate prior work.

If the protocol creates more ceremony without reducing intervention or escaped errors,
simplify it. Internal machinery is allowed to be sophisticated; the Agent-facing decision
surface should stay small.

# Collaboration Protocol

## Goal

Make three persistent Agents collaborate without turning the user into the coordinator and
without turning the protocol into paperwork for its own sake.

## Phase 0 — Form the team

A team run begins from a user command or harness action that clearly requests collaborative
execution.

Each participating worktree must have:

- a durable Agent identity;
- one worktree/branch per write-capable Agent;
- a task/session identifier;
- a known integration target/base.

Reviewer should be read-mostly; it may use its own worktree for stable inspection but does not
need to produce implementation commits.

## Phase 1 — Product definition

Product Architect produces a compact durable brief:

- goal/problem;
- scope/non-scope;
- acceptance criteria;
- shared contracts/system boundaries;
- unresolved blockers;
- semantic dependency revisions/digests where available.

For non-trivial work, Reviewer performs a spec pre-review. Product Architect resolves valid
ambiguities and persists the resulting decisions.

**Gate:** Fullstack should not begin a path that depends on an unresolved blocking decision.
Unrelated reversible discovery/scaffolding may proceed.

## Phase 2 — Implementation

Fullstack receives a task packet, not Product's full conversation.

The packet shape lives in [templates/task-packet.json](../templates/task-packet.json), validated
against [schemas/task-packet.schema.json](../schemas/task-packet.schema.json). Copy the template
and edit it; this document deliberately does not restate it.

That is not a stylistic preference. A second copy of the packet in prose is a copy that drifts:
this section carried `schemaVersion: 1` and no `validationPlan` for as long as the real packet had
been at 2, so an Agent following the documentation would have written a packet the ledger refuses.
Prose can explain a field; it cannot be the field's definition and stay true.

What the packet carries, and why each part is there:

| field | what it fixes |
| --- | --- |
| `taskId`, `sessionId`, `subject`, `role` | who is being asked, in which session, under which role contract |
| `baseRevision` | the tree the work starts from, so a candidate can be checked for descent from it |
| `readSet`, `writeSet` | what may be consulted and what may be touched — the scope spec-suite enforces |
| `inputs` | the semantic dependencies, each pinned to a revision, so "the contract moved" is detectable |
| `acceptance` | the standard the work is judged against, named rather than implied |
| `validationPlan` | the checks that must pass, and at which gate — [review.md](review.md) lists the reasons a gate can withhold a pass |

Everything above is frozen on issue: `teamctl task issue` seals it as `frozenDigest`, and the only
way to change any of it is `teamctl task reissue`, which mints a new generation and leaves every
handoff, review and validation result produced under the old one no longer applicable.

Fullstack implements, verifies, self-reviews, and commits candidate state.

## Phase 3 — Independent review

Reviewer receives:

- exact candidate revision/head;
- base revision;
- task/acceptance revision;
- canonical contract/input revisions;
- implementation verification evidence.

Reviewer writes one complete first-pass review with evidence-backed findings.

Approval is always bound to an exact candidate revision.

## Phase 4 — Fix/re-review

Fullstack fixes blocking/accepted findings and returns:

- finding IDs addressed;
- new candidate revision;
- regression verification.

Reviewer performs scoped re-review. Repeat only while new material evidence appears. Avoid
endless preference loops.

If Product behavior/contract must change during this loop, route back to Product Architect,
update canonical inputs, then mark affected implementation/review evidence stale.

## Phase 5 — Integration

When spec-suite is adopted:

1. run its current checker/generator/consumer verification as relevant;
2. run `merge-gate.mjs` using the accepted task concurrency contract;
3. if target advanced, follow spec-suite's current structural revalidation/orchestration path;
4. run a semantic validator that includes project integration checks/reviewer-approved revision as appropriate;
5. merge only an exact candidate that still has valid approval/evidence.

If candidate content/revision changes after Reviewer approval, approval is stale.

"Still has valid approval/evidence" is a question, not a recollection. Ask it about the tree in
front of you rather than about what you remember agreeing:

```bash
node scripts/teamctl.mjs validate state --session feature:coupon --task task:coupon-api --gate merge
node scripts/teamctl.mjs review state   --session feature:coupon --task task:coupon-api
node scripts/teamctl.mjs reconcile
```

The first two answer for one dimension each; `reconcile` combines them and only says `integrate`
when the task is complete, the approval still applies, and the gate is satisfied — and stops saying
it the moment a commit lands, without anyone having to remember to re-ask. A gate reading `unknown`
is not a pass: see [review.md](review.md) for the reasons it can give.

## Parallelism

Parallel work is encouraged only across stable boundaries.

Good:

```text
freeze checkout API contract
        ↓
frontend work  ||  backend work
        ↓
contract/integration validation
```

Bad:

```text
frontend guesses API
backend invents API independently
reviewer reconciles afterward
```

Use semantic input revisions so a contract change invalidates dependent work even when file
diffs are textually disjoint.

## Direct Agent messages

Direct messages should be short and action-oriented. Persist cross-agent results.

Examples:

```text
Fullstack → Product: contract change proposal + evidence
Product → Fullstack: canonical decision ID/revision
Fullstack → Reviewer: candidate + tests + known risks
Reviewer → Fullstack: finding IDs + evidence
```

Do not forward long chain-of-thought or entire transcripts between Agents.

## Human escalation

The user should see:

- genuine unresolved product choices requiring owner judgment;
- security/destructive approvals;
- persistent integration blockers;
- final concise outcome.

The user should not routinely relay messages or remind one Agent that another Agent finished.

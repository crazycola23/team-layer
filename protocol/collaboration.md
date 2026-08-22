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

Recommended team-layer task shape:

```json
{
  "schemaVersion": 1,
  "taskId": "task:coupon-fullstack",
  "sessionId": "feature:coupon",
  "subject": "agent:fullstack-01",
  "role": "fullstack",
  "baseRevision": "git:abc1234",
  "readSet": ["apps/**", "packages/contracts/**"],
  "writeSet": ["apps/web/**", "apps/api/**", "tests/**"],
  "inputs": [
    {
      "id": "contract:coupon-api",
      "revision": "sha256:...",
      "authority": "spec-suite"
    }
  ],
  "acceptance": ["AC-1", "AC-2", "AC-3"]
}
```

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

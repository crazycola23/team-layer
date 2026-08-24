# Three-Window Workflow Example

This is the recommended first deployment: one persistent worktree/window per role.

## 1. Create worktrees

```bash
git worktree add ../myapp-product -b agent/product
git worktree add ../myapp-fullstack -b agent/fullstack
git worktree add ../myapp-reviewer -b agent/reviewer
```

Reviewer may use a branch even if it normally stays read-only; the separate worktree gives it
a stable filesystem view and independent harness context.

## 2. Bind identities

Example mixed-vendor team:

```bash
# Product Architect → Claude Code
node /path/to/persistent-agent-team/scripts/teamctl.mjs setup \
  --agent-id product-01 --role product-architect --harness claude-code \
  --repo ../myapp-product

# Fullstack → Codex
node /path/to/persistent-agent-team/scripts/teamctl.mjs setup \
  --agent-id fullstack-01 --role fullstack --harness codex \
  --repo ../myapp-fullstack

# Reviewer → Gemini CLI
node /path/to/persistent-agent-team/scripts/teamctl.mjs setup \
  --agent-id reviewer-01 --role reviewer --harness gemini-cli \
  --repo ../myapp-reviewer
```

Run `doctor` in each worktree before the first real feature.

## 3. User command

The human can issue one conceptual command through whatever harness/orchestrator owns the
three windows:

```text
Team: implement coupon support for checkout.
```

The external harness is responsible for waking/routing the three existing Agents. This skill
does not require a specific launcher.

## 4. Product phase

Open the session in the Product window. The ledger lives in the Git common directory, so all three
worktrees see the same one:

```bash
node scripts/teamctl.mjs session start --session feature:coupon --target main
```

Product Architect creates/finalizes:

```yaml
goal: Apply one valid coupon to an order.
nonScope:
  - coupon stacking
acceptanceCriteria:
  - AC-1: valid coupon updates server-authoritative order total
  - AC-2: invalid coupon is rejected without changing total
  - AC-3: a second coupon application is rejected
contracts:
  - contract:checkout-coupon-api@sha256:abc...
unresolved: []
```

Cross-agent decisions are persisted through spec-suite when adopted.

Reviewer may pre-review the brief for contradictions/untestable criteria.

## 5. Fullstack phase

Product issues the task packet. It is a file, not a message, and the packet is frozen when issued —
which is what makes staleness detectable later:

```json
{
  "schemaVersion": 2,
  "taskId": "task:coupon-fullstack",
  "sessionId": "feature:coupon",
  "subject": "agent:fullstack-01",
  "role": "fullstack",
  "baseRevision": "git:abc1234",
  "readSet": ["apps/**", "packages/contracts/**"],
  "writeSet": ["apps/web/**", "apps/api/**", "tests/**"],
  "inputs": [
    {
      "id": "contract:checkout-coupon-api",
      "revision": "sha256:abc...",
      "authority": "product-architect"
    }
  ],
  "acceptance": ["AC-1 valid coupon updates the server-authoritative total"],
  "validationPlan": [
    { "checkId": "unit-tests", "kind": "command", "requiredAt": ["handoff", "merge"], "command": "npm test" },
    { "checkId": "peer-review", "kind": "review", "requiredAt": ["merge"], "role": "reviewer" }
  ]
}
```

```bash
# Product window
node scripts/teamctl.mjs task issue --packet packet.json

# Fullstack window — no arguments; it finds the task itself
node scripts/teamctl.mjs reconcile
node scripts/teamctl.mjs task set-status --session feature:coupon --task task:coupon-fullstack \
  --status in-progress
```

`validationPlan` is the point of the packet: the checks are named by whoever defined the work, so
"tested" stops being a claim the implementer makes about itself. Implement, commit, then run the
plan rather than reporting on it:

```bash
node scripts/teamctl.mjs validate run --session feature:coupon --task task:coupon-fullstack \
  --gate handoff
node scripts/teamctl.mjs handoff publish --handoff draft.json
node scripts/teamctl.mjs task set-status --session feature:coupon --task task:coupon-fullstack \
  --status completed
```

`validate run` refuses on a dirty worktree — evidence for a tree nobody else can check out is not
evidence. It records the candidate revision with each result, which is what lets the same evidence
be judged stale later.

## 6. Reviewer phase

The Reviewer window also starts with no arguments. A handoff is addressed to a *role*, so it is
found before this Agent holds any task of its own:

```bash
node scripts/teamctl.mjs reconcile          # → ack-handoff
node scripts/teamctl.mjs handoff show --session feature:coupon
node scripts/teamctl.mjs handoff ack --session feature:coupon --handoff <handoff-id>
```

Reviewer checks the candidate against acceptance/contracts and produces findings such as:

```json
{
  "findingId": "FIND-001",
  "severity": "major",
  "status": "open",
  "candidateRevision": "git:def4567",
  "requirement": "AC-3",
  "location": "apps/api/src/coupon.ts:88",
  "evidence": "No existing-coupon guard; repeated request applies discount twice",
  "impact": "Order total can be discounted beyond allowed product behavior",
  "requiredOutcome": "Reject coupon application when an order already has a coupon"
}
```

Fullstack fixes it. Reviewer performs scoped re-review and records the decision against the new
exact revision:

```bash
node scripts/teamctl.mjs review record --review decision.json
```

The decision cites the evidence ids the implementer produced, and binds to one candidate revision.
An approval that named no revision could not go stale, and going stale is the behaviour that
matters.

## 7. Integration

When spec-suite is adopted:

```text
candidate
  ↓
review approval for exact revision
  ↓
spec-suite merge gate
  ↓
structural revalidation if target advanced
  ↓
semantic validator / project integration tests
  ↓
main
```

Establish the first two steps by asking, not by remembering:

```bash
node scripts/teamctl.mjs validate run   --session feature:coupon --task task:coupon-fullstack --gate merge
node scripts/teamctl.mjs review state   --session feature:coupon --task task:coupon-fullstack
node scripts/teamctl.mjs reconcile      # → integrate, or the one thing still missing
node scripts/teamctl.mjs project-spec-task --session feature:coupon --task task:coupon-fullstack \
  --spec-suite ../spec-suite --output .spec-suite-task.json
```

One more commit after approval and `reconcile` stops saying `integrate` — `review state` reports
`applies: false` with the reason `candidate-moved`, and the merge gate reads `unknown` until the
plan is rerun. Nobody has to remember to re-ask.

If the contract digest changed during the feature, the Fullstack task is semantically stale
even if Git reports no textual conflict. `reconcile` answers `reissue-task` for that, never
`rebase-task`: replay cannot resolve a semantic change.

## 8. Context crash demonstration

If the Fullstack window loses context halfway through:

```bash
node scripts/teamctl.mjs reconcile
```

```json
{
  "status": "ready",
  "agent": "fullstack-01",
  "session": "feature:coupon",
  "task": "task:coupon-fullstack",
  "freshness": { "git": "fresh", "inputs": "unknown" },
  "nextAction": "run-validation",
  "reasons": ["handoff validation is unknown: 0 failed, 1 unestablished"],
  "detail": { "role": "fullstack", "taskStatus": "in-progress", "…": "…" }
}
```

Identity came from the local binding, session and task from the ledger, the candidate from `HEAD`.
Nothing in that answer came from the conversation that was lost, which is the whole claim:

```text
new context
  ↓
AGENTS.override.md (Codex local binding)
  ↓
identity: fullstack-01
  ↓
teamctl reconcile  →  session, task, freshness, one next action
  ↓
resume
```

The user should not need to retell the feature history.

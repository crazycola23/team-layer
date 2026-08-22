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

Fullstack receives a compact task packet:

```json
{
  "taskId": "task:coupon-fullstack",
  "subject": "agent:fullstack-01",
  "role": "fullstack",
  "baseRevision": "git:abc1234",
  "readSet": ["apps/**", "packages/contracts/**"],
  "writeSet": ["apps/web/**", "apps/api/**", "tests/**"],
  "inputs": [
    {
      "id": "contract:checkout-coupon-api",
      "revision": "sha256:abc...",
      "authority": "spec-suite"
    }
  ],
  "acceptance": ["AC-1", "AC-2", "AC-3"]
}
```

It implements, tests, self-reviews, commits, then hands the exact candidate revision to
Reviewer.

## 6. Reviewer phase

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

Fullstack fixes it. Reviewer performs scoped re-review and approves the new exact revision.

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

If the contract digest changed during the feature, the Fullstack task is semantically stale
even if Git reports no textual conflict.

## 8. Context crash demonstration

If the Fullstack window loses context halfway through:

```text
new context
  ↓
AGENTS.override.md (Codex local binding)
  ↓
bootstrap.md
  ↓
identity: fullstack-01
  ↓
role + recovery protocol
  ↓
current task / canonical inputs / git status + log
  ↓
resume
```

The user should not need to retell the feature history.

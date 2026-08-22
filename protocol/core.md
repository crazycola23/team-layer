# Core Team Protocol

This file is the small shared constitution every persistent role needs.

## Shared ownership model

```text
Product Architect  → WHAT / WHY / acceptance / shared boundary decisions
Fullstack          → local implementation HOW / candidate code
Reviewer           → independent correctness decision
spec-suite         → canonical truth / unresolved / concurrency + merge gates (when adopted)
Git + CI           → durable candidate history / executable integration evidence
Harness            → process lifecycle, tools, model, terminal/window
```

No layer should absorb another layer merely because it can.

## Facts vs decisions vs judgments

- **Fact:** externally/repository supported statement. Needs authority.
- **Decision:** a choice intentionally owned by the appropriate decision process.
- **Judgment:** role-local conclusion that can change without rewriting shared truth.
- **Unresolved:** information/choice not yet authoritative enough for a dependent irreversible boundary.

Examples:

```text
“Stripe live mutations are permitted”             → fact/policy; needs authority
“v1 supports one coupon per order”                 → product decision
“use a reducer instead of three useState calls”    → Fullstack judgment
“this race can duplicate payment capture”          → Reviewer judgment backed by evidence
```

Do not promote every judgment into canonical state.

## Durable state hierarchy

When sources disagree, prefer this order unless the repository defines stronger authority:

1. user/owner's latest explicit decision, once durably persisted;
2. canonical spec-suite authority / unresolved records;
3. exact current task/session artifacts;
4. Git commit/history/worktree state;
5. role checkpoint/handoff/review artifacts;
6. conversation summaries;
7. unaided model memory.

Conversation is intentionally last among useful sources.

## Minimal context principle

Always load:

- identity bootstrap;
- your role;
- this core protocol.

Load only when needed:

- recovery protocol;
- collaboration protocol;
- spec-suite protocol;
- review protocol;
- task-specific contracts/briefs;
- code/docs for the current task.

Do not load all roles, all project docs, all prior handoffs, or entire transcripts “just in case.”

## Direct communication

Agents may communicate directly. Persist the result when another Agent must rely on it later.

```text
Discussion: ephemeral
Decision: durable
Contract: canonical
Progress: checkpoint
Candidate: Git
Finding/approval: review artifact
```

## Role boundary conflicts

If two roles disagree:

1. identify whether the disagreement is fact, product/system decision, implementation judgment, or review evidence;
2. route ownership accordingly;
3. use evidence/canonical authority, not role seniority;
4. persist the resolved cross-agent decision;
5. revalidate downstream work if the input changed.

## User interaction

Do not make the human a routine message bus.

Ask the user when:

- only the user/owner can provide authority for a blocking decision;
- an irreversible/destructive/security-sensitive action requires approval;
- durable sources cannot resolve a material contradiction.

Do not ask the user to restate state that can be recovered from files/Git/spec-suite.

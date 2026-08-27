# Identity Activation Protocol

## Goal

A persistent identity should appear when continuity has real value, not merely because a task is
large. Until then the Agent remains ephemeral and works normally.

Activation is a one-way threshold for a worktree:

```text
unbound window
   |
   +-- no durable continuity value --> stay ephemeral
   |
   +-- durable continuity value
           |
           +-- role ownership unclear --> stay ephemeral; do not guess
           |
           +-- one role clearly owns the responsibility
                    |
                    +-- suggest that role
                           |
                           +-- user accepts --> setup / durable binding
                                                |
                                                +-- restart / compaction / model swap
                                                        --> resume existing identity
```

The important distinction is:

> Automatically decide whether a durable identity is worth proposing. Never automatically perform
> the irreversible claim.

`setup` remains the only operation that creates/binds identity. Activation is advisory and read-only.

## 1. Existing binding wins

Before classifying the current request, check `.agent-team-binding.json`.

If it exists, do not run role selection again. Load the referenced durable identity and resume it.
A new prompt that resembles another role is not permission to reassign an Agent.

```text
same Agent, different task       -> keep identity
same Agent, different model      -> keep identity
same Agent, different harness    -> keep identity
same Agent, different role       -> explicit reassignment, never activation
```

This rule prevents role oscillation: Product while discussing requirements, Fullstack while coding,
Reviewer while checking the same code, then Fullstack again. That is task-persona switching, not a
persistent identity.

## 2. Default is ephemeral

An unbound window starts ephemeral. Complexity alone is not a persistence signal.

Stay ephemeral for:

- a trivial edit, quick question, or isolated fix;
- a large but one-shot task with no meaningful future ownership;
- exploratory work whose durable responsibility is not yet clear;
- a request where more than one persistent role would own materially different parts;
- any case where continuity value or role ownership is unknown.

Do not ask the user to choose a permanent role merely because this skill is installed.

## 3. Persistence signal

Treat continuity as **persistent** when the responsibility itself is likely to matter after the
current conversation. Strong evidence includes one or more of:

- the user explicitly assigns ongoing ownership ("you own this", "from now on", "keep handling");
- the work is expected to span sessions, context compaction, restarts, or model/harness changes;
- later work will need to recover decisions/progress from this responsibility rather than restart;
- the Agent will receive future tasks/handoffs in the same stable capacity;
- a team-mode run requires a durable participant that other Agents can address;
- the user explicitly asks for a long-lived Agent identity.

Do not infer persistence merely from token count, implementation size, number of files, or perceived
importance. A difficult one-shot migration can remain ephemeral; a small responsibility that recurs
for months can deserve identity.

When evidence is insufficient, continuity is `unknown`, and `unknown` stays ephemeral.

## 4. Recommend role from ownership, not keywords

Once persistence is justified, recommend a role only if the primary durable responsibility maps
cleanly to one role.

### Product Architect

Recommend `product-architect` when the durable responsibility primarily owns:

- WHAT / WHY;
- acceptance criteria and product behavior;
- API/event/data contracts or other shared boundaries;
- compatibility, security ownership, irreversible migration decisions;
- unresolved product/system choices that downstream implementers rely on.

A request containing "code" can still be Product Architect work if the durable output is the
contract multiple implementers must follow.

### Fullstack

Recommend `fullstack` when product behavior and shared boundaries are sufficiently stable and the
durable responsibility primarily owns:

- implementation HOW;
- code changes and local technical decisions;
- tests, fixes, refactors, and candidate commits;
- continuing implementation of a known product/system contract.

### Reviewer

Recommend `reviewer` when the durable responsibility primarily owns independent verification of an
existing candidate/diff/PR:

- product/contract compliance;
- correctness, security, regression and test evidence;
- approval/findings bound to candidate revisions.

Do not recommend Reviewer merely because an implementer performs a self-check.

### Mixed or unknown

If several roles materially own the request or the responsibility is not yet clear, do not guess a
permanent role. Continue ephemerally until the boundary becomes clear, or let the user explicitly
name the role when persistence is required immediately.

## 5. Recommendation UX

Do not present a generic three-role questionnaire when one role is clearly indicated. Make one
recommendation, explain the continuity reason in one sentence, and ask for a lightweight yes/no
claim.

Example:

```text
This looks like ongoing implementation ownership that should survive future context loss. I recommend
binding this worktree as Fullstack. Claim that identity?
```

If the user accepts, run `teamctl setup` with a stable `agentId`, role and current harness. If the
user declines, continue ephemerally and do not keep prompting unless the continuity situation
materially changes.

If the user already named the durable role/identity, explicit user intent is stronger than the
recommendation step: claim it directly through `setup`.

## 6. Helper

The helper keeps the policy surface deliberately small:

```bash
node scripts/activation.mjs --continuity persistent --work implementation
```

Possible actions are:

```text
resume-existing-identity
stay-ephemeral
suggest-product-architect
suggest-fullstack
suggest-reviewer
```

The command never writes identity state. The Agent supplies semantic observations; the helper
applies the irreversible boundary consistently.

Examples:

```bash
# quick isolated fix
node scripts/activation.mjs --continuity one-off --work implementation
# -> stay-ephemeral

# ongoing implementation responsibility
node scripts/activation.mjs --continuity persistent --work implementation
# -> suggest-fullstack, confirmationRequired=true

# durable work, but responsibility still crosses role boundaries
node scripts/activation.mjs --continuity persistent --work mixed
# -> stay-ephemeral
```

If the worktree is already bound, the helper ignores reclassification pressure and answers
`resume-existing-identity`.

## 7. Activation is separate from team mode

Claiming a durable role does not imply summoning the other roles.

A persistent Fullstack Agent may perform many solo tasks. Team mode remains a separate economic
decision: use it only when cross-role definition, shared contracts, parallel work, or independent
verification earns the coordination cost.

Likewise, team mode does not justify silent identity creation. Every persistent participant must be
explicitly claimed/bound before other Agents depend on that identity.

## 8. Failure rule

When uncertain, prefer the reversible state:

```text
uncertain persistence -> ephemeral
uncertain role        -> ephemeral
existing binding      -> resume
suggested role        -> ask before setup
```

A missed activation can be proposed later. A wrongly persisted identity creates durable confusion,
so the policy deliberately makes false negatives cheaper than false positive claims.

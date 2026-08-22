# spec-suite Integration

This protocol assumes the repository currently uses `spec-suite`. Always read the installed
repository's own `SKILL.md`/schema/docs because this team skill must not freeze an old
spec-suite interface.

## Boundary

`persistent-agent-team` owns role identity, recovery, and role-to-role workflow.

`spec-suite` remains authoritative for:

- canonical vs unresolved truth;
- deterministic derived artifacts;
- its task/concurrency schema;
- merge-gate scope/history/ancestry checks;
- structural revalidation/orchestration semantics;
- control-plane authorization if the project explicitly enables it.

Do not duplicate those checks here.

## Current multi-agent mapping

The current spec-suite task contract supports the following multi-agent fields:

```text
baseRevision   immutable Agent-start observation (git:<hex>)
readSet        declared read intent globs
writeSet       non-empty allowed write globs
subject        optional Agent identity metadata
role           optional descriptive role metadata
```

`readSet` and `writeSet` are paired. Old tasks without the concurrency contract may remain
compatible elsewhere but must not be presented as merge-gate-safe.

## Team task → spec-suite projection

Team task packets may carry richer orchestration data. Project only supported fields into
spec-suite's current task artifact.

Example:

```text
Team packet                       spec-suite
-----------                       ----------
agentId: fullstack-01          →  subject: agent:fullstack-01
role: fullstack                →  role: fullstack
baseRevision                   →  baseRevision
readSet                        →  readSet
writeSet                       →  writeSet
inputs                         →  team layer only (until supported natively)
acceptance                     →  product/review layer
```

Do not assume spec-suite accepts unknown fields.

## Merge/revalidation expectations

Respect current spec-suite behavior:

- actual writes outside `writeSet` must fail;
- scope considers the submitted commit history, including temporary writes/deletes and rename sides;
- invalid ancestry must fail;
- target advancement invalidates the direct fast path;
- structurally disjoint stale work still requires the installed revalidation semantics;
- structural replay alone is not proof of semantic correctness;
- a semantic validator must explicitly pass to claim semantic validation.

## Reviewer as semantic evidence

Reviewer approval can contribute to semantic validation, but it must be bound to the exact
candidate tree/revision being integrated. If spec-suite rebases/replays the candidate, rerun
at least the checks necessary to prove that the approval still applies.

Recommended semantic validator composition:

```text
spec-suite check/generation (if canonical changed)
+ project typecheck/build/tests
+ task-specific integration tests
+ reviewer approval for exact candidate
```

Do not make Reviewer approval a magic bypass around executable tests.

## Contract digests / semantic inputs

For common frontend/backend parallel work, prefer explicit stable contract dependencies over
trying to observe every file the Agent read.

Team layer example:

```json
{
  "id": "contract:checkout-api",
  "revision": "sha256:abc...",
  "authority": "spec-suite"
}
```

If that revision changes, downstream tasks are semantically stale. If backend implementation
changes while the contract digest remains unchanged, frontend does not become stale solely
because backend code changed.

This is a team-layer rule until spec-suite itself defines an authoritative input dependency
schema.

## Control Plane

Do not automatically enable spec-suite's Lease/effect Control Plane simply because team mode
is active. Use it only when the project actually needs machine-enforced effect authorization.
Identity/role in this skill is descriptive team identity; it is not cryptographic capability.

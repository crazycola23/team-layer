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

## Capability detection and compatibility mode

There is no capability handshake to rely on: an installed spec-suite is a directory of scripts,
not a service that answers questions about itself. So the interface is *detected*, and the
detection is three-valued — `supported`, `unsupported`, `unknown` — because "we did not ask" and
"we asked and it said no" call for different behaviour, and collapsing them is how a layer starts
claiming knowledge it does not have.

Run it, and read the answer, with:

```bash
node scripts/teamctl.mjs project-spec-task \
  --session feature:coupon --task task:coupon-api \
  --spec-suite ../spec-suite --output .spec-suite-task.json
```

`capabilitySource` says how the answers were obtained, most authoritative first:

```text
declared     spec-suite has scripts/capabilities.mjs and it answered; versions are known
probed       no handshake, so support was inferred from the modules that are present
unavailable  the spec-suite root does not exist or was never named; everything is unknown
```

A handshake that exists but exits non-zero or emits non-JSON is treated as absent and probed
instead, with a note saying so — a broken handshake read as "no capabilities" would be the worst
of the three answers, because it looks like a finding.

`compatibility.mode` is the field to act on:

- **`full`** — every capability-governed field the packet carries was projected. spec-suite is
  enforcing what it enforces and this layer is enforcing the rest.
- **`degraded`** — something the far side might have carried stayed behind. `compatibility.warnings`
  says which field, which capability, and what the consequence is. This is a status rather than a
  log line so a caller may refuse to proceed on it.

Today's degraded case is the expected one. `semanticInputs` is a property of spec-suite's *task
contract*, and no installed version carries semantic `inputs`, so `inputs` is withheld and:

> **staleness against a contract revision is enforced only in the team layer.**

That is a real gap with a named boundary, not a bug. `teamctl reconcile` refuses to let an Agent
act on a task whose frozen input revisions no longer match what the canonical authority reports
(see [recovery.md](recovery.md)), so nothing is *implemented* against a stale contract. What is not
enforced is the merge gate refusing such a candidate, because that check lives in spec-suite and
this skill does not modify it. If a project needs the gate to enforce it too, that is a change to
spec-suite's task contract, and this layer will project `inputs` the moment detection reports
`semanticInputs` as supported — no change here is required.

There is a way to close the gap without waiting for that, and without either project learning the
other's domain model: spec-suite's external validation hook can call `teamctl validate-candidate`,
which refuses a candidate whose frozen inputs have moved for the same reason `reconcile` does. The
staleness rule still lives only here; what changes is that the merge gate can now *ask*. See
[the semantic half, as a command](#the-semantic-half-as-a-command).

`compatibility.fieldsDiscovered` is the other thing to read. When it is `false` the projectable
field list was assumed rather than read from spec-suite, which means a field spec-suite has since
added will silently not be projected. The assumed list is deliberately conservative for that
reason.

## Team task → spec-suite projection

Team task packets may carry richer orchestration data. Project only supported fields into
spec-suite's current task artifact.

Example:

```text
Team packet                       spec-suite
-----------                       ----------
taskId: task:coupon-api        →  taskId: task:coupon-api
agentId: fullstack-01          →  subject: agent:fullstack-01
role: fullstack                →  role: fullstack
baseRevision                   →  baseRevision
readSet                        →  readSet
writeSet                       →  writeSet
inputs                         →  team layer only (until supported natively)
acceptance                     →  product/review layer
schemaVersion                  →  spec-suite's own, declared not projected
```

Do not assume spec-suite accepts unknown fields.

### What the far side requires is not negotiable

The whitelist below is *discovered*, by asking spec-suite's own
`projectionConcurrencyFields` which keys it keeps. That answer is about scheduling, so it names the
five concurrency fields and nothing else — and for a while this layer read its silence about
`taskId` as "spec-suite does not want it" and filed the field as team-layer-owned.

The opposite was true. `evaluateMergeGate` refuses a task whose `taskId` is not a non-empty string
before it resolves a single commit, so the projection was producing an artifact the real gate could
not read, and no amount of probing would ever have found it. `CONTRACT_REQUIRED_FIELDS` therefore
travels unconditionally, outside the discovered whitelist, and no capability may gate it: a field
the far side *requires* is not a feature to negotiate — if it did not travel there would be nothing
to negotiate about, only a gate failing closed for the wrong reason.

`scripts/validate-skill.mjs` holds the corollary: a required field may not also appear in
`FIELD_CAPABILITY`, and must be required by the task packet schema itself, so the projection's
refusal to build an unreadable artifact can never be reached by a schema-valid packet.

**`schemaVersion` is the mirror image.** Both layers number their schemas and the numbers count
different things, so the packet's version must not cross — but an artifact without one is rejected
by `project-context.mjs`. So the artifact *declares* spec-suite's constant on spec-suite's
authority. The report keeps `projected` and `withheld` a partition of the *packet* and names the
declared key separately in `declared`, because a field cannot honestly be reported as both carried
and withheld, and today the two numbers are both `1` — so comparing values would agree while the
one fact worth stating is that they are not the same fact.

### Project by whitelist, because the far side does not complain

The reflex is to strip the fields known to be unsupported and pass the rest. That is one line
shorter and wrong in the only direction that cannot be caught: **spec-suite accepts unknown task
fields silently.** A blacklist is correct on the day it is written; every field this layer adds
afterwards ships by default into a validator that neither reads nor rejects it, and the first
symptom is a merge gate appearing to honour a constraint nobody enforced.

So the projection is a whitelist, and everything left out is reported in `withheld` with a reason:

```text
capability-unsupported  the far side cannot carry it; this layer still enforces it
capability-unknown      nobody could establish whether it can; treated as cannot
team-layer-owned        this layer owns the field; spec-suite is not missing it
not-projectable         not part of spec-suite's task contract
```

`team-layer-owned` is separated from the capability reasons on purpose. `acceptance` and
`validationPlan` are not things spec-suite lacks; they are things this layer owns. An Agent
reading a flat list of omissions cannot tell a gap from a boundary.

Only the projection is written to `--output`. The compatibility report stays in stdout, because a
spec-suite task file carrying this skill's diagnostics would be a file with two audiences and the
far side would swallow the extras without comment.

### Names that mean different things in the two layers

Two collisions are load-bearing. Both are the kind that survive review because each side reads
correctly on its own.

**`stale-base`.** In spec-suite this is a *structural* finding: the candidate's base is behind the
integration target, and replay may resolve it. In this layer, `freshness.git: 'stale'` is the same
observation, but the sibling finding `freshness.inputs: 'stale'` is *semantic* and replay cannot
resolve it at all — it needs the task restated. Never route one to the other's remedy. `teamctl
reconcile` keeps the two dimensions in separate fields for exactly this reason, and answers
`rebase-task` for the first and `reissue-task` for the second.

**`inputs`.** spec-suite configuration uses `inputs` for generator inputs — file paths feeding
deterministic derived artifacts. A team task packet uses `inputs` for semantic contract
dependencies with revisions. Same word, unrelated meanings, and the projection is where they would
meet. This is a second reason `inputs` is withheld rather than passed through under an assumption
that a same-named field means the same thing.

**No handshake exists to settle either.** When `capabilitySource` is `probed` or `unavailable`,
no capability versions are known and both layers' vocabularies are being matched up by this
skill's reading of them. Prefer the explicit boundary over the convenient inference.

## Testing across the boundary

Everything above is this skill's reading of spec-suite, and a reading can be wrong in a way no test
in this repository will notice: the fakes were built from the same reading as the code, so when the
belief is wrong the fake is wrong in the same direction and the suite stays green. `taskId` was
exactly that — withheld as team-layer-owned, with passing projection tests, and unreadable by the
real merge gate.

`tests/cross-repo.test.mjs` is the answer, and the rule for it is: at least one test in every
direction must run the other side's actual code. Projected task into spec-suite's real gate;
spec-suite's real verdict back into `structuralVerdict` and `validate-candidate`. A test that
writes a JSON shape by hand and proves this layer can read it proves nothing about the far side.

It needs a checkout, found in this order:

```bash
TEAM_LAYER_SPEC_SUITE_ROOT=/path/to/spec-suite npm test   # explicit wins, even if unusable
npm test                                                  # else ../spec-suite, ../spec-suite-work
```

Without one, those tests report `skipped` with the variable named — not a pass. The distinction is
the whole value of the file: node's runner counts a test that returns early as passing, so a
conditional test written the obvious way reports an unverified belief as verified on every machine
that lacks the far side, which is most of them.

**CI does not run them.** The workflow checks out this repository only, so a green tick means the
semantic half is sound, not that the composition is. Confirming the boundary is a local step, or a
step for whoever adds a second checkout to CI.

## Merge/revalidation expectations

Respect current spec-suite behavior:

- actual writes outside `writeSet` must fail;
- scope considers the submitted commit history, including temporary writes/deletes and rename sides;
- invalid ancestry must fail;
- target advancement invalidates the direct fast path;
- structurally disjoint stale work still requires the installed revalidation semantics;
- structural replay alone is not proof of semantic correctness;
- a semantic validator must explicitly pass to claim semantic validation.

### The semantic half, as a command

The last two items are `teamctl validate-candidate`, which is this layer's side of the external
validation hook. spec-suite runs its own structural gate and calls this for the question it cannot
answer:

```bash
teamctl validate-candidate --phase pre-merge   --candidate git:<sha> [--structural merge-gate.json]
teamctl validate-candidate --phase post-replay --candidate git:<sha> [--structural merge-gate.json]
```

`status` is this layer's verdict alone — `passed`, `failed`, or `unknown` — and it is the only
field the hook has to read; anything other than `passed` is a refusal. It is deliberately *not*
the composed answer: spec-suite is the caller, so requiring its verdict to compute this one would
mean neither side could answer first, and composing here would make this a second merge gate.

`integrationReady` is the composed answer, for whoever is holding both reports. It is a
conjunction: semantics passed, `--structural` supplied a merge-gate result whose `safeToMerge` is
true, and both verdicts are about the same commit. Nothing missing produces a yes — a structural
gate nobody consulted reads `not-consulted`, which is an `unknown`, not an absence.

The same-commit rule is what `--phase post-replay` exists for. Every review decision and every
piece of evidence in this layer is bound to a candidate revision, so a replay produces a commit
that none of them are about. Without the rule the sequence is: semantics pass at C1, the
structural gate asks for a replay, spec-suite replays onto C2, the gate passes C2 — two genuine
passing reports describing two different trees. `post-replay` therefore requires `--candidate`
(the replayed commit is spec-suite's, not this worktree's HEAD) and asks the `revalidation` *and*
`merge` gates, because a packet may declare no revalidation checks and a gate with nothing
required reads `passed`.

Exit status is 0 whether or not the candidate passes, for the same reason `validate state` is: a
non-zero exit for "the review has not happened yet" is indistinguishable from the validator having
failed to run, and a caller that cannot tell those apart fails open on the wrong one.

## Reviewer as semantic evidence

Reviewer approval can contribute to semantic validation, but it must be bound to the exact
candidate tree/revision being integrated. If spec-suite rebases/replays the candidate, rerun
at least the checks necessary to prove that the approval still applies.

Rerunning the executable checks is not enough on its own, and `validate-candidate --phase
post-replay` says so: after a replay the command checks can be re-run and pass against the new
commit, and the report will still refuse, with `review.applies` false. A human judgement about one
tree is not a judgement about another, and no amount of re-running a suite produces an approval.

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

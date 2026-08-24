# Review Protocol

## Independent review package

Reviewer should be able to begin from files/commits alone:

```yaml
taskId: "..."
candidateRevision: "git:..."
baseRevision: "git:..."
acceptanceRevision: "..."
canonicalInputs:
  - "contract:...@sha256:..."
verificationRun:
  - checkId: "unit-tests"
    status: "passed"
knownLimitations: []
```

`verificationRun` names checks rather than command lines because a check id is what evidence is
recorded under (`validate show`), and because the same id can be a program, a shell line or a
required review. What the reviewer needs is which declared check was answered and how it came out;
the words it ran are in the frozen packet, where nobody can restate them afterwards.

## First-pass review order

1. acceptance/product behavior;
2. contract/architecture/security boundaries;
3. changed-code correctness;
4. tests and false confidence;
5. regression/performance/maintainability risk proportional to the change;
6. scope/history sanity where relevant.

Prioritize load-bearing failures. Do not spend the majority of review tokens on formatting.

## Finding lifecycle

```text
open → fixed → verified → closed
              ↘ rejected-with-evidence
open → accepted-risk (only by appropriate owner/policy)
open → unresolved-product (route Product Architect)
```

Reviewer may not close a blocker merely because Fullstack says it is fixed; inspect evidence.

## Approval invalidation

Approval becomes stale when any is true:

- candidate revision changes;
- relevant acceptance/canonical contract revision changes;
- the task is reissued at all — a new `acceptance`, `writeSet`, `baseRevision` or `validationPlan`
  changes what "approved" was a judgement about, even when every input revision holds;
- integration replay/rebase changes candidate content;
- required validation later fails.

A pure Git metadata/branch-name change that does not alter the approved tree may be treated
according to project policy, but do not assume tree equivalence without checking it.

### Ask, do not remember

The list above is a rule that has to be applied at the moment of integration, which is exactly when
the Agent holding the approval in mind is least likely to re-derive it. So it is answerable:

```bash
node scripts/teamctl.mjs review state --session feature:coupon --task task:coupon-api
```

`status` is what the reviewer said. `applies` is whether it still says it about the tree in front of
you, and those are different questions:

```text
status: approved   applies: true    integrate
status: approved   applies: false   the approval was real and no longer applies; reasons say why
status: approved   applies: null    no candidate to compare against; nothing was established
```

`reasons` names the invalidating condition rather than leaving it to be guessed:

```text
no-review              nobody has reviewed this candidate
candidate-moved        the tree moved after the approval — the fourth and fifth bullets above
inputs-moved           a frozen input revision no longer matches canonical — the second bullet
task-reissued          the packet itself was restated — the third bullet
candidate-unknown      the candidate revision could not be read
task-binding-unknown   the decision predates this binding and cannot say which packet it judged
```

`inputs-moved` and `task-reissued` are separate because they are separate facts and either can
happen without the other. Changing an input revision necessarily reissues the packet that names it,
so that direction reports both; the reverse does not. Product can add an acceptance criterion,
narrow a `writeSet` or rewrite a `validationPlan` while every input revision stays exactly where it
was, and an approval that survived that would be an approval against a standard nobody set.

`applies: null` is not a lenient `true`. An unanswerable question is not an approval, and the
distinction is the whole reason the field is three-valued.

`teamctl reconcile` consumes the same answer, which is why it stops saying `integrate` the moment a
commit lands after approval — without the reviewer having to be asked again to notice.

### The same question about a validation gate

`validate state --gate merge` answers per check, and its `command` checks age for one more reason
than a review does — the check itself can be rewritten:

```text
no-evidence             the check has never been run
candidate-moved         the run was against a different tree
inputs-moved            a frozen input revision no longer matches canonical
task-reissued           the packet was restated after the run
check-changed           this checkId still exists and no longer runs the same thing
candidate-unknown       the candidate revision could not be read
task-binding-unknown    the evidence predates that binding
check-binding-unknown   the evidence predates that binding
errored                 the run could not tell us anything — a missing binary, a timeout, a signal
```

`check-changed` earns its own word rather than being folded into `task-reissued`, which already
detects the same edit. What it adds is the reason. A `unit-tests` check quietly changing from
`node --test tests/` to an integration suite is a different edit from an unrelated acceptance
tweak, and told only "the task was reissued" a reader looks at a green run under the same
`checkId`, concludes the rename was cosmetic, and reuses it. Naming the check as the thing that
moved removes that reading.

Any reason at all makes the check `unknown` rather than `failed`: a pass that no longer applies is
not a failure, and reporting it as one would push an Agent to "fix" work that was never broken. The
fix is to rerun, and rerunning restores the gate.

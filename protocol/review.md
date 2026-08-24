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
no-review          nobody has reviewed this candidate
candidate-moved    the tree moved after the approval — the third and fourth bullets above
inputs-moved       a frozen input revision no longer matches canonical — the second bullet
candidate-unknown  the candidate revision could not be read
```

`applies: null` is not a lenient `true`. An unanswerable question is not an approval, and the
distinction is the whole reason the field is three-valued.

`teamctl reconcile` consumes the same answer, which is why it stops saying `integrate` the moment a
commit lands after approval — without the reviewer having to be asked again to notice.

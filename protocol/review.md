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
  - command: "..."
    result: "passed"
knownLimitations: []
```

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

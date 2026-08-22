# Recovery Protocol

Run this protocol at session start, after compaction, after a crash/restart, or whenever your
memory of state is uncertain.

## Recovery sequence

1. **Identity**
   - read `.agent-team-binding.json`;
   - read referenced `identity.json`;
   - verify the role matches the role manual being used.
2. **Workspace**
   - `git rev-parse --show-toplevel`;
   - `git status --short --branch`;
   - identify current branch/worktree and whether it is clean.
3. **Task/session**
   - locate the active task/session from the repository/harness/session artifact;
   - read only the current task, not every historical task.
4. **Authority**
   - if spec-suite is adopted, read current canonical dependencies and unresolved blockers;
   - verify expected contract/input revisions.
5. **Candidate history**
   - read the relevant `git log` range and current diff;
   - verify commits mentioned by checkpoints/handoffs actually exist.
6. **Role checkpoint**
   - read your latest durable checkpoint/handoff/review artifact;
   - reconcile it against Git and canonical state.
7. **Resume**
   - continue from the first incomplete durable step;
   - do not redo completed work only because conversation memory was lost.

## Contradiction rules

- Checkpoint says commit exists, Git says it does not → Git wins; mark checkpoint stale.
- Conversation says contract v1, canonical says v2 → canonical wins; evaluate task staleness.
- Handoff says tests passed but no command/result/CI evidence exists → treat as unverified.
- Product brief and canonical contract disagree → stop dependent implementation/review and route to Product Architect/canonical owner.
- Agent identity and worktree binding disagree → stop; do not guess which identity should own the workspace.

## Recovery output

After recovery, keep the in-context summary tiny:

```yaml
agent: fullstack-01
role: fullstack
task: task:coupon
base: git:abc123
canonicalInputs:
  - contract:coupon-api@sha256:...
head: git:def456
state: working
next: "finish integration tests"
blockers: []
```

Persist new progress in a durable checkpoint when it materially advances. Do not continuously
rewrite state after every tool call.

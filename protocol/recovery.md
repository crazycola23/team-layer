# Recovery Protocol

Run this protocol at session start, after compaction, after a crash/restart, or whenever your
memory of state is uncertain.

## One command first

The seven steps below are the protocol. `teamctl reconcile` is the protocol executed for you, and
it is what to run before reading any of it:

```bash
node scripts/teamctl.mjs reconcile
```

It takes no arguments on purpose. An Agent that has lost its context cannot be asked which session
it was in, so every input is derived: identity from the worktree binding, session and task from the
ledger, the candidate from `HEAD`. It exits `0` whatever it finds — including `blocked` — because a
non-zero exit for "you have a review to address" is indistinguishable from the tool having failed
to look, and that is the one outcome that must not be confusable with a finding.

The answer is the recovery summary, and the top-level keys are all an Agent needs to read:

```json
{
  "status": "stale",
  "agent": "fullstack-01",
  "session": "feature:coupon",
  "task": "task:coupon-api",
  "freshness": { "git": "fresh", "inputs": "stale" },
  "nextAction": "reissue-task",
  "reasons": ["inputs are stale: the canonical authority has moved on from contract:coupon"]
}
```

`reasons[0]` is the one that chose `nextAction`, so a surprising answer can be argued with rather
than only obeyed. `detail` carries everything the decision rested on.

Read the rest of this file when the answer needs interpreting, when `reconcile` is unavailable, or
when a contradiction has to be resolved by hand.

### Freshness is three-valued

`git` and `inputs` each read `fresh`, `stale`, or `unknown`, and `unknown` is not a softer `fresh`.
Nothing in this layer knows where `contract:coupon` lives — only the canonical authority can say
what its current revision is — so unless somebody supplies that observation, freshness against it
was never established:

```bash
node scripts/teamctl.mjs reconcile --canonical-inputs canonical.json   # [{ "id": …, "revision": … }]
```

Without the flag, `inputs` reads `unknown` rather than being assumed unchanged. Treat `unknown` as
a question still open, not as an answer.

### How the session is found

With no `--session`, a session is reachable three ways, in descending order of how much it says
about what to do now:

1. **a task addressed to this agent** — the ordinary case for an implementer;
2. **mail addressed to it** — a handoff is addressed to a *role*, so it can point at work before
   this Agent holds any task; for a reviewer that is the whole job;
3. **a session it has acted in before** — found from the events it caused.

The third route exists because a reviewer that has acknowledged its handoff has neither a task nor
an inbox row, and without it the answer was `open-session`: an instruction to start a second
session for work already under way, in the layer whose promise is that you do not have to remember.
Terminal sessions are excluded — a completed or cancelled session will never hold a task again, so
naming one as the place to resume is advice that cannot come good.

`detail.unreadableSessions` names any session whose event log could not be read. An empty inbox
reported next to a session nobody could read would be "no mail that I could see" presented as "no
mail", which is the confident wrong answer the three-valued freshness exists to avoid.

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

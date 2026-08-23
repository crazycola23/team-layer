import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FRESHNESS, RECONCILE_STATUSES, NEXT_ACTIONS,
  gitFreshness, inputsFreshness, decide,
} from '../src/reconcile.mjs';
import { collectMetrics, METRIC_SOURCES, DERIVED_METRICS, UNAVAILABLE_METRICS } from '../src/metrics.mjs';

const BASE = 'git:' + 'a'.repeat(40);
const MOVED = 'b'.repeat(40);

function state(overrides = {}) {
  return {
    binding: { agentId: 'agent-one', role: 'fullstack' },
    session: { sessionId: 'sess-1', integrationTarget: 'main' },
    task: { frozen: { taskId: 'task-1', baseRevision: BASE }, state: { status: 'in-progress', generation: 1 } },
    freshness: { git: { state: 'fresh', detail: '' }, inputs: { state: 'fresh', detail: '' } },
    handoffs: [],
    review: { status: 'none', applies: false, reasons: [], unresolvedFindings: 0 },
    validation: { gate: 'handoff', status: 'passed', required: 1, passed: 1, failed: 0, unknown: 0 },
    ...overrides,
  };
}

test('the vocabularies are closed and free of duplicates', () => {
  for (const list of [FRESHNESS, RECONCILE_STATUSES, NEXT_ACTIONS]) {
    assert.equal(new Set(list).size, list.length);
  }
});

test('a base at the target commit is fresh, and one behind it is stale', () => {
  const fresh = gitFreshness({ baseRevision: BASE, target: 'main', targetCommit: 'a'.repeat(40), baseIsAncestor: true });
  assert.equal(fresh.state, 'fresh');

  const stale = gitFreshness({ baseRevision: BASE, target: 'main', targetCommit: MOVED, baseIsAncestor: true });
  assert.equal(stale.state, 'stale');
  assert.match(stale.detail, /main has moved to bbbbbbbbbbbb/);
});

/**
 * The plan's Scenario 4 is the *target* moving, not this worktree's HEAD.
 *
 * Worth its own test because the wrong comparison passes every happy-path test: an Agent that
 * has committed nothing yet has HEAD equal to the base, so a HEAD-based check reads fresh right
 * up until the Agent does some work — at which point it reports every working Agent as stale.
 * Naming the target explicitly here is what pins the intended comparison.
 */
test('freshness is measured against the integration target, so the base being an ancestor is still stale', () => {
  const result = gitFreshness({ baseRevision: BASE, target: 'main', targetCommit: MOVED, baseIsAncestor: true });
  assert.equal(result.state, 'stale');
  assert.doesNotMatch(result.detail, /diverged/, 'an ancestor base is a rebase, not a divergence');
});

test('a base outside the target history is stale in a way nobody should rebase unattended', () => {
  const result = gitFreshness({ baseRevision: BASE, target: 'main', targetCommit: MOVED, baseIsAncestor: false });
  assert.equal(result.state, 'stale');
  assert.match(result.detail, /histories diverged/);
});

/**
 * "I could not look" is not "it is fine", and the two failures reach here by different routes.
 *
 * A target branch this worktree does not have and a task frozen without a base are both cases
 * where nothing can be compared. Reporting `fresh` for either would be the freshness equivalent
 * of a capability that defaults to supported — and unlike a capability, this one is read by an
 * Agent deciding whether it may keep writing code.
 */
test('an unreadable target or a missing base reads unknown rather than fresh', () => {
  assert.equal(gitFreshness({ baseRevision: BASE, target: 'main', targetCommit: null }).state, 'unknown');
  assert.equal(gitFreshness({ baseRevision: null, target: 'main', targetCommit: MOVED }).state, 'unknown');
  assert.match(gitFreshness({ baseRevision: BASE, target: 'main', targetCommit: null }).detail, /never established/);
});

test('ancestry that could not be established is admitted in the detail', () => {
  const result = gitFreshness({ baseRevision: BASE, target: 'main', targetCommit: MOVED, baseIsAncestor: null });
  assert.equal(result.state, 'stale');
  assert.match(result.detail, /ancestry could not be established/);
});

test('a task with no declared inputs is fresh, and says it is vacuous', () => {
  const result = inputsFreshness({ inputs: [], observed: null });
  assert.equal(result.state, 'fresh');
  assert.match(result.detail, /declares no semantic inputs/);
});

/**
 * The default answer, and the one that documents the missing half of the protocol.
 *
 * With no observation supplied there is nothing to compare against, and this layer cannot go
 * and get one: the packet carries `{ id, revision }` while resolving a canonical revision needs
 * the *paths* only the authority knows. `unknown` is the honest report, and it must not quietly
 * become `fresh` the day somebody decides the field looks untidy.
 */
test('without an observation the inputs read unknown, not fresh', () => {
  const result = inputsFreshness({ inputs: [{ id: 'contract:checkout', revision: 'r1' }], observed: null });
  assert.equal(result.state, 'unknown');
  assert.deepEqual(result.unchecked, ['contract:checkout']);
  assert.match(result.detail, /cannot resolve one/);
});

test('an observation that agrees on every declared input is fresh', () => {
  const result = inputsFreshness({
    inputs: [{ id: 'contract:checkout', revision: 'r1' }, { id: 'contract:pricing', revision: 'r4' }],
    observed: [{ id: 'contract:checkout', revision: 'r1' }, { id: 'contract:pricing', revision: 'r4' }],
  });
  assert.equal(result.state, 'fresh');
  assert.deepEqual(result.unchecked, []);
});

test('a moved revision is stale and names what moved', () => {
  const result = inputsFreshness({
    inputs: [{ id: 'contract:checkout', revision: 'r1' }],
    observed: [{ id: 'contract:checkout', revision: 'r2' }],
  });
  assert.equal(result.state, 'stale');
  assert.deepEqual(result.stale, [{ id: 'contract:checkout', frozen: 'r1', current: 'r2' }]);
});

/**
 * The trap this module exists for: a partial observation must not read as agreement.
 *
 * An authority asked about one contract and silent about another has agreed about one contract.
 * Treating the silence as `fresh` is the failure that lets an Agent implement against a
 * superseded interface *believing it had checked* — worse than never checking, because the
 * report says it did.
 */
test('an observation silent about a declared input leaves it unchecked and the whole answer unknown', () => {
  const result = inputsFreshness({
    inputs: [{ id: 'contract:checkout', revision: 'r1' }, { id: 'contract:pricing', revision: 'r4' }],
    observed: [{ id: 'contract:checkout', revision: 'r1' }],
  });
  assert.equal(result.state, 'unknown');
  assert.deepEqual(result.unchecked, ['contract:pricing']);
  assert.match(result.detail, /silence is not agreement/);
});

/**
 * Staleness that is stale first and unknown second is stale.
 *
 * A stale input is actionable now; an unchecked one might be. Reporting `unknown` because one
 * input was unobserved would bury the one finding that is certain, so a known-stale input wins
 * and the unchecked ones ride along in the detail rather than changing the verdict.
 */
test('a stale input outranks an unchecked one in the same observation', () => {
  const result = inputsFreshness({
    inputs: [{ id: 'contract:checkout', revision: 'r1' }, { id: 'contract:pricing', revision: 'r4' }],
    observed: [{ id: 'contract:checkout', revision: 'r2' }],
  });
  assert.equal(result.state, 'stale');
  assert.deepEqual(result.unchecked, ['contract:pricing']);
});

/**
 * An input the task never declared cannot make the task stale.
 *
 * If it could, every task in the repository would go stale the moment any contract anywhere
 * moved — and a staleness signal that fires constantly is one people learn to click past,
 * which costs more than never having had it.
 */
test('a revision the task does not depend on is not staleness', () => {
  const result = inputsFreshness({
    inputs: [{ id: 'contract:checkout', revision: 'r1' }],
    observed: [{ id: 'contract:checkout', revision: 'r1' }, { id: 'contract:unrelated', revision: 'r9' }],
  });
  assert.equal(result.state, 'fresh');
});

test('an unbound worktree is told to bind before anything else', () => {
  const result = decide(state({ binding: null }));
  assert.equal(result.status, 'unbound');
  assert.equal(result.nextAction, 'bind-worktree');
});

test('a bound agent with no session opens one; with no task it waits', () => {
  assert.equal(decide(state({ session: null })).nextAction, 'open-session');
  assert.equal(decide(state({ task: null })).nextAction, 'await-task');
});

test('nothing in the way means carry on, and the reason says so', () => {
  const result = decide(state());
  assert.equal(result.status, 'ready');
  assert.equal(result.nextAction, 'continue-task');
  assert.match(result.reasons[0], /nothing is in the way/);
});

/**
 * Stale inputs outrank a stale base, and this ordering is a decision rather than an accident.
 *
 * Reissuing a task restates the whole frozen packet, base revision included. Sending an Agent
 * to rebase first would have it do work the reissue immediately discards — and worse, produce a
 * task based on a revision nobody asked for.
 */
test('stale inputs outrank a stale base', () => {
  const result = decide(state({
    freshness: {
      git: { state: 'stale', detail: 'main moved' },
      inputs: { state: 'stale', detail: 'checkout moved' },
    },
  }));
  assert.equal(result.status, 'stale');
  assert.equal(result.nextAction, 'reissue-task');
  assert.match(result.reasons[0], /inputs are stale/);
  assert.ok(result.reasons.some((r) => /base is stale/.test(r)), 'the losing finding is still reported');
});

/**
 * And both outrank an unacknowledged handoff, because the ledger refuses that ack anyway.
 *
 * A handoff carries the input snapshot it was published against; acking one whose task has
 * moved on is refused. Answering `ack-handoff` under stale inputs would send a recovering Agent
 * straight into a refusal it has no way to clear from there — the worst possible answer for the
 * one command whose job is to be right when the Agent has no context to fall back on.
 */
test('a stale base outranks an unacknowledged handoff', () => {
  const result = decide(state({
    freshness: { git: { state: 'stale', detail: 'main moved' }, inputs: { state: 'fresh', detail: '' } },
    handoffs: [{ handoffId: 'h-1' }],
  }));
  assert.equal(result.nextAction, 'rebase-task');
  assert.ok(result.reasons.some((r) => /unacknowledged handoff/.test(r)));
});

test('an unresolved review is blocked on somebody else and outranks this agent own work', () => {
  const result = decide(state({
    review: { status: 'blocked-unresolved', reviewId: 'rev-1', applies: true, reasons: [], unresolvedFindings: 2 },
  }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.nextAction, 'resolve-unresolved');
});

/**
 * A block written about code that has since moved is not a block.
 *
 * `applies: false` is the ledger saying the decision was made against a different candidate, and
 * the block is the outcome where honouring a superseded decision costs most: `resolve-unresolved`
 * sends the Agent to fetch an authority ruling on facts that may no longer be in the diff, and it
 * is `blocked`, so the Agent stops. The review has to be re-run against what exists now, which is
 * the same conclusion `a superseded review sends the completed work back for a fresh one` reaches
 * from the approval side.
 */
test('a superseded block is not a block, and unfinished work carries on', () => {
  const superseded = { status: 'blocked-unresolved', reviewId: 'rev-1', applies: false, reasons: ['candidate moved'], unresolvedFindings: 2 };
  const open = decide(state({ review: superseded }));
  assert.equal(open.status, 'ready', 'nothing this agent cannot clear is in the way');
  assert.equal(open.nextAction, 'continue-task');

  const done = decide(state({
    task: { frozen: { taskId: 'task-1', baseRevision: BASE }, state: { status: 'completed', generation: 1 } },
    review: superseded,
  }));
  assert.equal(done.nextAction, 'request-review', 'the way out of a superseded decision is a fresh one');
  assert.match(done.reasons[0], /candidate moved/);
});

/**
 * A review asking for changes is this Agent's work, so the status is `ready` and not `blocked`.
 *
 * `blocked` is reserved for what somebody else must clear. Reporting a changes-requested review
 * as blocked would have an Agent wait for a person who is, in fact, waiting for the Agent.
 */
test('changes requested is ready work, not a block', () => {
  const result = decide(state({
    review: { status: 'changes-requested', reviewId: 'rev-1', applies: true, reasons: [], unresolvedFindings: 3 },
  }));
  assert.equal(result.status, 'ready');
  assert.equal(result.nextAction, 'address-review');
});

test('a parked task is blocked and says which task', () => {
  const result = decide(state({
    task: { frozen: { taskId: 'task-1', baseRevision: BASE }, state: { status: 'blocked', generation: 1 } },
  }));
  assert.equal(result.status, 'blocked');
  assert.equal(result.nextAction, 'unblock-task');
  assert.match(result.reasons[0], /task-1/);
});

/**
 * A review that no longer applies is not an approval, and not a review either.
 *
 * `reviewStateFor` reports `applies: false` when the decision was made against a candidate that
 * has since moved. Honouring it would either integrate on a stale approval or address findings
 * that were written about different code; the answer is a fresh review, and the reason has to
 * carry the ledger's explanation so nobody re-requests a review they already have.
 */
test('a superseded review sends the completed work back for a fresh one', () => {
  const result = decide(state({
    task: { frozen: { taskId: 'task-1', baseRevision: BASE }, state: { status: 'completed', generation: 1 } },
    review: { status: 'approved', reviewId: 'rev-1', applies: false, reasons: ['candidate moved'], unresolvedFindings: 0 },
  }));
  assert.equal(result.nextAction, 'request-review');
  assert.match(result.reasons[0], /candidate moved/);
});

test('completed, approved and validated is the only road to integrate', () => {
  const approved = {
    task: { frozen: { taskId: 'task-1', baseRevision: BASE }, state: { status: 'completed', generation: 1 } },
    review: { status: 'approved', reviewId: 'rev-1', applies: true, reasons: [], unresolvedFindings: 0 },
  };
  assert.equal(decide(state(approved)).nextAction, 'integrate');

  // Validation that nobody could establish is not validation that passed.
  const unvalidated = decide(state({
    ...approved,
    validation: { gate: 'merge', status: 'unknown', required: 2, passed: 1, failed: 0, unknown: 1 },
  }));
  assert.equal(unvalidated.nextAction, 'run-validation');
  assert.match(unvalidated.reasons[0], /unestablished/);
});

/**
 * `reasons[0]` must explain `nextAction`, not merely be one of the things that were true.
 *
 * Findings are collected in whatever order the branches happen to run, then sorted once by
 * precedence — so the sort is what ties the chosen action to the reason printed first. Without
 * it, a recovering Agent reads an action and an unrelated justification and has no way to tell
 * that they do not go together.
 */
test('every reason is reported, ordered so the first one explains the chosen action', () => {
  const result = decide(state({
    freshness: {
      git: { state: 'stale', detail: 'main moved' },
      inputs: { state: 'stale', detail: 'checkout moved' },
    },
    task: { frozen: { taskId: 'task-1', baseRevision: BASE }, state: { status: 'blocked', generation: 1 } },
    handoffs: [{ handoffId: 'h-1' }, { handoffId: 'h-2' }],
    review: { status: 'changes-requested', reviewId: 'rev-1', applies: true, reasons: [], unresolvedFindings: 1 },
    validation: { gate: 'handoff', status: 'failed', required: 1, passed: 0, failed: 1, unknown: 0 },
  }));
  assert.equal(result.nextAction, 'reissue-task');
  assert.match(result.reasons[0], /inputs are stale/);
  assert.equal(result.reasons.length, 6, 'nothing that was true is dropped');
  assert.match(result.reasons[1], /base is stale/);
  assert.match(result.reasons.at(-1), /validation is failed/);
});

/**
 * Every status this module can report must be in the vocabulary the CLI prints.
 *
 * Exercised rather than asserted about the source, because the source-level check the installer
 * runs cannot see a status assembled from a variable — and a status outside the list is one an
 * Agent branching on the field has no case for.
 */
test('every answer uses the published vocabularies', () => {
  const cases = [
    state({ binding: null }), state({ session: null }), state({ task: null }), state(),
    state({ freshness: { git: { state: 'stale', detail: '' }, inputs: { state: 'fresh', detail: '' } } }),
    state({ review: { status: 'blocked-unresolved', reviewId: 'r', applies: true, reasons: [], unresolvedFindings: 1 } }),
    state({ review: { status: 'changes-requested', reviewId: 'r', applies: true, reasons: [], unresolvedFindings: 1 } }),
    state({ task: { frozen: { taskId: 't', baseRevision: BASE }, state: { status: 'completed', generation: 1 } } }),
  ];
  for (const input of cases) {
    const result = decide(input);
    assert.ok(RECONCILE_STATUSES.includes(result.status), `${result.status} is not a published status`);
    assert.ok(NEXT_ACTIONS.includes(result.nextAction), `${result.nextAction} is not a published action`);
    assert.ok(result.reasons.length >= 1 && result.reasons.every((r) => typeof r === 'string' && r !== ''),
      'every answer must say why');
  }
});

test('an unavailable metric is named with a reason and never also counted', () => {
  assert.ok(UNAVAILABLE_METRICS.length > 0, 'the gaps are the point of the list');
  for (const entry of UNAVAILABLE_METRICS) {
    assert.equal(entry.metric in METRIC_SOURCES, false);
    assert.equal(DERIVED_METRICS.includes(entry.metric), false);
    assert.ok(entry.reason.length > 40, `${entry.metric} must say whose fact it is`);
  }
});

/**
 * A session whose log cannot be read must not be able to make the totals look small.
 *
 * The alternative — summing the sessions that could be read — produces a number that is wrong
 * and shaped exactly like a right one. `null` propagating is the only report a reader will
 * question, and `unreadable` says which session to go and look at.
 */
test('metrics survive an unreadable session by naming it rather than skipping it silently', () => {
  const ledger = {
    listSessions: () => ['sess-good', 'sess-bad'],
    readSession: (id) => {
      if (id === 'sess-bad') { const e = new Error('log truncated'); e.code = 'LOG_TRUNCATED'; throw e; }
      return { sessionId: id, eventSeq: 2 };
    },
    readEvents: () => ([
      { kind: 'task-issued' },
      { kind: 'review-recorded', status: 'approved', findings: 3, unresolved: 1 },
    ]),
  };
  const result = collectMetrics(ledger);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.totals.tasksIssued, 1);
  assert.equal(result.totals.reviewFindings, 3);
  assert.equal(result.totals.reviewApprovals, 1);
  assert.deepEqual(result.unreadable.map((row) => row.sessionId), ['sess-bad']);
  assert.equal(result.unreadable[0].code, 'LOG_TRUNCATED');
});

/**
 * A log that predates the `findings` field cannot answer how many findings there were.
 *
 * Summing the events that do carry it would produce a total lower than the truth, presented as
 * the truth. Null propagates instead — the rule `inbox` already follows with `stale: null`.
 */
test('a review event without a findings count makes the count null rather than partial', () => {
  const ledger = {
    listSessions: () => ['sess-1'],
    readSession: () => ({ sessionId: 'sess-1', eventSeq: 2 }),
    readEvents: () => ([
      { kind: 'review-recorded', status: 'approved', findings: 4, unresolved: 0 },
      { kind: 'review-recorded', status: 'changes-requested', unresolved: 2 },
    ]),
  };
  const result = collectMetrics(ledger);
  assert.equal(result.totals.reviewFindings, null);
  assert.equal(result.totals.reviewRounds, 2, 'what the log does prove is still counted');
  assert.equal(result.totals.unresolvedFindings, 2);
});

/**
 * `unresolved` means two different things in the two events that carry it, so it is counted twice.
 *
 * A handoff's unresolved list is facts an Agent declined to guess past — §14's measurement. A
 * review's is findings the decision left open. One counter for both would move for two unrelated
 * reasons, and a metric whose movement cannot be attributed is one nobody can act on: exactly
 * the failure the two repositories' same-named `inputs` fields produce, reached from the other
 * direction.
 */
test('the handoff and review senses of unresolved are counted separately', () => {
  const ledger = {
    listSessions: () => ['sess-1'],
    readSession: () => ({ sessionId: 'sess-1', eventSeq: 3 }),
    readEvents: () => ([
      { kind: 'handoff-published', unresolved: 2 },
      { kind: 'handoff-published', unresolved: 1 },
      { kind: 'review-recorded', status: 'changes-requested', findings: 5, unresolved: 4 },
    ]),
  };
  const result = collectMetrics(ledger);
  assert.equal(result.totals.unresolvedRaised, 3, 'the facts nobody guessed past');
  assert.equal(result.totals.unresolvedFindings, 4, 'and the findings a review left open');
  assert.equal(result.totals.handoffs, 2);
});

/** And a handoff logged before the field existed nulls it, for the reason a review does. */
test('a handoff event without an unresolved count nulls the total rather than lowering it', () => {
  const ledger = {
    listSessions: () => ['sess-1'],
    readSession: () => ({ sessionId: 'sess-1', eventSeq: 2 }),
    readEvents: () => ([
      { kind: 'handoff-published', unresolved: 2 },
      { kind: 'handoff-published' },
    ]),
  };
  const result = collectMetrics(ledger);
  assert.equal(result.totals.unresolvedRaised, null);
  assert.equal(result.totals.handoffs, 2, 'the events themselves are still countable');
});

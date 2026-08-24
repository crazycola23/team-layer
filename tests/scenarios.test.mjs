/**
 * The plan's §17 scenarios, walked end to end through the CLI by three real agents.
 *
 * `tests/teamctl.test.mjs` proves each command in isolation: that `handoff publish` refuses a
 * draft claiming a role the agent does not hold, that `review state` follows the candidate. What
 * it cannot prove is that the commands *compose* — that the output of one is a usable input to
 * the next, and that an Agent following the answers gets somewhere. A layer whose promise is
 * "you do not have to remember" is only as good as the chain, and every link here was found by
 * walking it: the reviewer's `open-session` dead end (Scenario 6) was invisible to every unit
 * test and obvious the first time one agent acked a handoff and then asked what to do.
 *
 * So these tests assert the *seams*. Each step's arguments come from the previous step's JSON
 * wherever the product can supply them, because an argument a test hard-codes is one a real
 * Agent would have had to remember, and a chain that only works when you already know the
 * answers is not a recovery path.
 *
 * Three worktrees off one repository, three bound agents, one home, one ledger — which is what
 * makes the seams real: the reviewer genuinely cannot see the implementer's HEAD, the
 * implementer genuinely cannot record its own approval, and the integration target genuinely
 * moves under both of them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { bootstrapped, git, json, refusal, run, taskPacket, writeDraft, writePacket } from './helpers/cli.mjs';

/** Two canonical revisions of the same contract: what the task was frozen at, and where it moved. */
const A1 = `sha256:${'a1'.repeat(32)}`;
const A2 = `sha256:${'a2'.repeat(32)}`;

/**
 * A check that can actually run: Node, which is here by definition, rather than `npm test`.
 *
 * The fixture repository has no package.json, and a check that always errors would make every
 * gate in this file read `unknown` for the wrong reason — the interesting `unknown`s below are
 * the ones staleness produces, and they have to be distinguishable from a broken runner.
 */
const nodeArgv = (script) => [process.execPath, '-e', script];

/** The product architect, an implementer, and a reviewer, each in its own worktree. */
function team() {
  const product = bootstrapped({ agentId: 'product-01', role: 'product-architect' });
  // Read rather than assumed: `git init` names the first branch from the machine's config, so a
  // hard-coded `master` here would make every git-freshness assertion below depend on whose
  // laptop ran the suite.
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], product.repo);
  const join = (name, agentId, role, harness) => {
    const repo = path.join(product.dir, name);
    git(['worktree', 'add', repo, '-b', name], product.repo);
    const worktree = { dir: product.dir, repo, home: product.home };
    run(['setup', '--agent-id', agentId, '--role', role, '--harness', harness, '--repo', repo], worktree);
    return worktree;
  };
  return {
    branch,
    product,
    dev: join('wt-fullstack', 'fullstack-01', 'fullstack', 'claude-code'),
    reviewer: join('wt-reviewer', 'reviewer-01', 'reviewer', 'codex'),
  };
}

/** A commit in one worktree, as the revision the rest of the layer refers to it by. */
function commit(worktree, file, body, message) {
  fs.writeFileSync(path.join(worktree.repo, file), body);
  git(['add', file], worktree.repo);
  git(['commit', '-m', message], worktree.repo);
  return `git:${git(['rev-parse', 'HEAD'], worktree.repo)}`;
}

/** The packet the whole file works from: one command check at both gates, one review at merge. */
function couponPacket(t, overrides = {}) {
  return taskPacket({
    baseRevision: `git:${git(['rev-parse', t.branch], t.product.repo)}`,
    inputs: [{ id: 'contract:coupon', revision: A1, authority: 'product-architect' }],
    validationPlan: [
      {
        checkId: 'unit-tests',
        kind: 'command',
        requiredAt: ['handoff', 'merge'],
        argv: nodeArgv("console.log('coupon: 12 passing')"),
      },
      { checkId: 'peer-review', kind: 'review', requiredAt: ['merge'], role: 'reviewer' },
    ],
    ...overrides,
  });
}

/** What the canonical authority currently says, in the shape `--canonical-inputs` reads. */
function canonical(worktree, rows, name = 'canonical.json') {
  const file = path.join(worktree.repo, name);
  fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
  return name;
}

/** The session and task every scenario starts from: issued by product, addressed to the dev. */
function issued(t, overrides = {}) {
  run(['session', 'start', '--session', 'feature:coupon', '--target', t.branch], t.product);
  writePacket(t.product, couponPacket(t, overrides));
  return json(['task', 'issue', '--packet', 'packet.json'], t.product);
}

const SESSION = ['--session', 'feature:coupon'];
const TASK = [...SESSION, '--task', 'task:coupon-api'];

// ------------------------------------------------------------------ §17 Scenario 1

/**
 * The normal flow: definition to integration, with nothing relayed by a human.
 *
 * The criterion is not that the steps succeed — a script can make them succeed — but that each
 * Agent's *next* step was obtainable from the layer. So the dev never names its session or task
 * until it has been told them, the reviewer finds its work through an inbox it asks for by
 * running one argument-free command, and the answer that ends the chain is `integrate` rather
 * than a human deciding it is time.
 *
 * The one place the plan asked for vocabulary this layer does not have: after publishing a
 * handoff the dev is told `run-validation`, not "await review", because the merge gate is
 * genuinely not satisfied and the reviewer's check is one of the things missing. `validate run`
 * names it in `awaitingReview` — machine-readably, which is what "no human relay" needs — and
 * inventing an `await-review` next action would be a change to §12's vocabulary rather than to
 * this suite.
 */
test('scenario 1: a task is defined, implemented, reviewed and integrated without a human relay', () => {
  const t = team();
  const record = issued(t);
  assert.equal(record.state.status, 'issued');

  // The dev has just been started. It knows nothing; it asks.
  const start = json(['reconcile'], t.dev);
  assert.deepEqual([start.status, start.nextAction], ['ready', 'run-validation']);
  assert.deepEqual([start.session, start.task], ['feature:coupon', 'task:coupon-api']);
  assert.deepEqual(start.freshness, { git: 'fresh', inputs: 'unknown' },
    'nobody has said what the contract is at now, and reconcile does not guess it is unchanged');
  const [session, taskId] = [start.session, start.task];

  // Everything from here on is addressed with what reconcile just said, not with a literal.
  const mine = json(['task', 'show', '--session', session, '--task', taskId], t.dev);
  assert.deepEqual(mine.frozen.writeSet, ['src/coupon/**'], 'the packet says where it may write');
  run(['task', 'set-status', '--session', session, '--task', taskId, '--status', 'in-progress'], t.dev);

  const candidate = commit(t.dev, 'coupon.md', '# coupon\n\nDiscount applies once.\n', 'coupon: apply once');
  const ran = json(['validate', 'run', '--gate', 'handoff', '--session', session, '--task', taskId], t.dev);
  assert.deepEqual(ran.evidence.map((e) => [e.evidenceId, e.status]), [['evidence:unit-tests-1', 'passed']]);
  assert.equal(ran.candidateRevision, candidate, 'the evidence names the commit it is evidence about');
  assert.deepEqual(ran.awaitingReview, [], 'the handoff gate asks for no review');
  assert.equal(json(['validate', 'state', '--gate', 'handoff', '--session', session, '--task', taskId], t.dev).status,
    'passed');

  writeDraft(t.dev, {
    sessionId: session,
    taskId,
    to: { role: 'reviewer' },
    nextAction: 'review',
    summary: 'Discount is applied once, in the domain layer; the API only validates shape.',
    artifacts: [{ type: 'code', id: 'module:coupon', revision: candidate }],
    evidence: [{ kind: 'validation', detail: 'unit-tests', result: 'evidence:unit-tests-1 passed' }],
  });
  const published = json(['handoff', 'publish', '--handoff', 'draft.json'], t.dev);
  assert.equal(published.handoffId, 'handoff:fullstack-to-reviewer-1');
  run(['task', 'set-status', '--session', session, '--task', taskId, '--status', 'completed'], t.dev);

  // The reviewer, likewise cold. One command, no arguments, and it is holding no task of its own
  // — mail is the only thing that can point it at work, which is why `ack-handoff` has to be
  // reachable from a state where nothing is assigned.
  const cold = json(['reconcile'], t.reviewer);
  assert.deepEqual([cold.status, cold.nextAction, cold.session], ['ready', 'ack-handoff', 'feature:coupon']);
  assert.equal(cold.task, null, 'a reviewer holds no task; that is not the same as having nothing to do');
  assert.deepEqual(cold.detail.unackedHandoffs.map((row) => [row.handoffId, row.nextAction, row.stale]),
    [['handoff:fullstack-to-reviewer-1', 'review', false]]);

  const waiting = cold.detail.unackedHandoffs[0].handoffId;
  const letter = json(['handoff', 'show', '--session', cold.session, '--handoff', waiting], t.reviewer);
  assert.equal(letter.handoff.artifacts[0].revision, candidate,
    'the handoff carries the revision to review, so the reviewer never asks the dev what to look at');
  run(['handoff', 'ack', '--session', cold.session, '--handoff', waiting], t.reviewer);

  writeDraft(t.reviewer, {
    sessionId: cold.session,
    taskId: letter.handoff.taskId,
    status: 'approved',
    candidateRevision: letter.handoff.artifacts[0].revision,
    requirementsRevision: A1,
    summary: 'AC-1 holds; the discount is applied in the domain layer and the suite covers it.',
    validationEvidence: ['evidence:unit-tests-1'],
  }, 'review.json');
  const decision = json(['review', 'record', '--review', 'review.json'], t.reviewer);
  assert.deepEqual(decision.decision.reviewer, { subject: 'agent:reviewer-01', role: 'reviewer' });

  // Back to the dev, which does not have to be told the review happened.
  const merge = json(['validate', 'run', '--gate', 'merge', '--session', session, '--task', taskId], t.dev);
  assert.deepEqual(merge.evidence.map((e) => e.evidenceId), ['evidence:unit-tests-2']);
  assert.deepEqual(merge.awaitingReview, [{ checkId: 'peer-review', role: 'reviewer' }],
    'the gate names who owes the judgement rather than leaving a human to notice');
  const gate = json(['validate', 'state', '--gate', 'merge', '--session', session, '--task', taskId], t.dev);
  assert.deepEqual([gate.status, gate.required, gate.passed, gate.unknown], ['passed', 2, 2, 0]);

  const done = json(['reconcile'], t.dev);
  assert.deepEqual([done.status, done.nextAction], ['ready', 'integrate']);
  assert.match(done.reasons[0], /complete, approved, and validated/,
    'the reason names all three things that had to be true, so the Agent can see which one to re-check');

  // The ledger's own account of the flow, which is the artifact that makes the claim checkable:
  // every transfer of control above left an event, so nothing happened out of band.
  const kinds = json(['session', 'events', '--session', session], t.dev).map((event) => event.kind);
  assert.deepEqual(kinds, [
    'session-created', 'task-issued', 'task-status-changed', 'evidence-recorded',
    'handoff-published', 'task-status-changed', 'handoff-acked', 'review-recorded', 'evidence-recorded',
  ]);
  const actors = new Set(json(['session', 'events', '--session', session], t.dev).map((event) => event.actor));
  assert.deepEqual([...actors].sort(), ['agent:fullstack-01', 'agent:product-01', 'agent:reviewer-01']);
});

// ------------------------------------------------------------------ §17 Scenario 2

/**
 * The contract moves while the task is in flight.
 *
 * What must not happen is the quiet version: the task's inputs silently following the contract,
 * so an Agent finishes work against A2 while its packet, its evidence and its review all say A1.
 * The freeze is the point — a task is a statement about a specific version of the truth, and
 * the only way for it to describe a new one is to be restated under a new generation, which is
 * visible in the log.
 *
 * The merge gate's half of §17's scenario 2 — refusing to merge work whose semantic inputs are
 * behind — belongs to spec-suite, which this layer does not modify (plan Phase A, out of scope
 * by decision). What is enforceable here is that the team layer never lets an Agent *act* on a
 * stale task without being told, and never silently repoints the task at what it now says.
 */
test('scenario 2: a moved contract makes the task stale and is only adopted by restating it', () => {
  const t = team();
  issued(t);
  commit(t.dev, 'coupon.md', '# coupon\n', 'coupon: first cut');

  const moved = json(['reconcile', '--canonical-inputs', canonical(t.dev, [{ id: 'contract:coupon', revision: A2 }])],
    t.dev);
  assert.deepEqual([moved.status, moved.nextAction], ['stale', 'reissue-task']);
  assert.equal(moved.freshness.inputs, 'stale');
  assert.deepEqual(moved.detail.inputs.stale,
    [{ id: 'contract:coupon', frozen: A1, current: A2 }],
    'the report names the input, both revisions, and therefore what a restatement has to say');
  assert.match(moved.reasons[0], /contract:coupon/);

  // The task itself did not move. Nothing in the layer adopts a new revision on the strength of
  // having been shown one: the frozen half is what the evidence and the review are about.
  const frozen = json(['task', 'show', ...TASK], t.dev);
  assert.deepEqual([frozen.frozen.inputs[0].revision, frozen.state.generation], [A1, 1]);
  const digestBefore = frozen.inputSnapshotDigest;

  // The product architect restates it, which is the one operation that changes the answer.
  writePacket(t.product, couponPacket(t, {
    inputs: [{ id: 'contract:coupon', revision: A2, authority: 'product-architect' }],
  }), 'packet-2.json');
  const restated = json(['task', 'reissue', '--packet', 'packet-2.json',
    '--reason', 'contract:coupon moved to a2 while the task was in flight', '--expect-generation', '1'], t.product);
  assert.equal(restated.unchanged, false, 'a restatement that changed nothing must be distinguishable from this');
  assert.equal(restated.record.state.generation, 2);
  assert.notEqual(restated.record.inputSnapshotDigest, digestBefore);

  const after = json(['reconcile', '--canonical-inputs', canonical(t.dev, [{ id: 'contract:coupon', revision: A2 }])],
    t.dev);
  assert.equal(after.freshness.inputs, 'fresh');
  assert.deepEqual(after.detail.inputs.stale, []);
  assert.equal(after.detail.generation, 2);
  assert.notEqual(after.nextAction, 'reissue-task');
});

// ------------------------------------------------------------------ §17 Scenario 3

/**
 * The implementation changes and the contract does not — so nothing about the inputs is stale.
 *
 * This is the scenario that catches a freshness check written as "has anything moved". Work
 * moving is the normal case and must cost nothing: an Agent told to reissue its task every time
 * it commits learns to ignore the advice, which is how the whole mechanism stops being read.
 *
 * The target moving is a different fact with a different remedy, and the pair is asserted
 * together on purpose: one dimension reads stale, the other reads fresh, and the reasons must
 * not borrow each other's language.
 */
test('scenario 3: work moving under a task is not staleness; the target moving is', () => {
  const t = team();
  issued(t);
  const said = canonical(t.dev, [{ id: 'contract:coupon', revision: A1 }]);

  commit(t.dev, 'coupon.md', '# coupon\n\nfirst\n', 'coupon: first cut');
  commit(t.dev, 'coupon.md', '# coupon\n\nsecond\n', 'coupon: rework the rule');
  const busy = json(['reconcile', '--canonical-inputs', said], t.dev);
  assert.deepEqual(busy.freshness, { git: 'fresh', inputs: 'fresh' },
    'two commits later the task is still about what it was always about');
  assert.deepEqual(busy.detail.inputs.stale, []);

  // Now the integration target moves, which is the other dimension entirely.
  commit(t.product, 'CHANGELOG.md', '# changelog\n\n- pricing rounding\n', 'pricing: rounding fix');
  const behind = json(['reconcile', '--canonical-inputs', said], t.dev);
  assert.deepEqual(behind.freshness, { git: 'stale', inputs: 'fresh' });
  assert.equal(behind.nextAction, 'rebase-task');
  assert.deepEqual(behind.detail.inputs.stale, []);
  assert.equal(behind.detail.git.baseIsAncestor, true, 'behind, not diverged: this one a rebase can fix');
  assert.ok(behind.reasons.every((reason) => !/contract:coupon|input/.test(reason)),
    'no reason blames the inputs for the target having moved');
});

// ------------------------------------------------------------------ §17 Scenario 4

/**
 * The integration target advances after the gate has already passed.
 *
 * Two things have to hold, and they pull in opposite directions. A pass recorded against the old
 * candidate must not carry: the suite ran against something that is not what would be merged,
 * and reporting it as passed is the most convincing kind of false confidence, because the record
 * is real. But merging the target is also not enough to make the task current — the frozen base
 * revision is a claim about what this task is a statement against, and only a restatement can
 * change it. So the dev does the merge, reruns, passes, and is *still* told to rebase the task.
 *
 * Structural revalidation after a rebase — re-checking that the change still applies to the
 * moved tree — is spec-suite's merge gate, out of scope here (plan Phase A).
 */
test('scenario 4: a passing gate does not survive the target moving, and merging is not restating', () => {
  const t = team();
  issued(t);
  const said = canonical(t.dev, [{ id: 'contract:coupon', revision: A1 }]);
  commit(t.dev, 'coupon.md', '# coupon\n', 'coupon: implement');
  run(['validate', 'run', '--gate', 'handoff', ...TASK], t.dev);
  assert.equal(json(['validate', 'state', '--gate', 'handoff', ...TASK], t.dev).status, 'passed');

  commit(t.product, 'CHANGELOG.md', '# changelog\n', 'pricing: rounding fix');
  assert.equal(json(['reconcile', '--canonical-inputs', said], t.dev).nextAction, 'rebase-task');

  git(['merge', t.branch, '--no-edit'], t.dev.repo);
  const carried = json(['validate', 'state', '--gate', 'handoff', ...TASK], t.dev);
  assert.deepEqual([carried.status, carried.checks[0].reasons], ['unknown', ['candidate-moved']],
    'the old pass is about the old commit and says so, rather than covering the merge');
  assert.equal(carried.checks[0].evidenceId, 'evidence:unit-tests-1', 'the run is still on the record');

  run(['validate', 'run', '--gate', 'handoff', ...TASK], t.dev);
  assert.equal(json(['validate', 'state', '--gate', 'handoff', ...TASK], t.dev).status, 'passed');

  // Green again, and the task is still not current: the base revision is a frozen fact.
  const merged = json(['reconcile', '--canonical-inputs', said], t.dev);
  assert.deepEqual([merged.freshness.git, merged.nextAction], ['stale', 'rebase-task']);

  writePacket(t.product, couponPacket(t), 'packet-2.json');
  const restated = json(['task', 'reissue', '--packet', 'packet-2.json',
    '--reason', `rebased onto ${t.branch}`, '--expect-generation', '1'], t.product);
  assert.equal(restated.record.frozen.baseRevision, `git:${git(['rev-parse', t.branch], t.product.repo)}`);
  assert.equal(json(['reconcile', '--canonical-inputs', said], t.dev).freshness.git, 'fresh');
});

// ------------------------------------------------------------------ §17 Scenario 5

/**
 * An approval, and then the candidate changes.
 *
 * `tests/teamctl.test.mjs` proves `review state` notices at the level of the one command. What
 * is asserted here is the consequence an Agent actually meets: `reconcile`, which is the command
 * it consults instead of remembering, must stop saying `integrate`. An approval that keeps
 * applying across a commit is worse than no review at all, because the record looks exactly like
 * a real one — and the Agent that acts on it has been told the code was read by somebody who
 * never saw it.
 */
test('scenario 5: an approval stops applying when the candidate moves, and reconcile stops saying integrate', () => {
  const t = team();
  issued(t);
  const said = canonical(t.dev, [{ id: 'contract:coupon', revision: A1 }]);
  const approved = commit(t.dev, 'coupon.md', '# coupon\n', 'coupon: implement');
  run(['validate', 'run', '--gate', 'merge', ...TASK], t.dev);
  run(['task', 'set-status', ...TASK, '--status', 'in-progress'], t.dev);
  run(['task', 'set-status', ...TASK, '--status', 'completed'], t.dev);

  writeDraft(t.reviewer, {
    sessionId: 'feature:coupon',
    taskId: 'task:coupon-api',
    status: 'approved',
    candidateRevision: approved,
    requirementsRevision: A1,
    summary: 'AC-1 holds.',
  }, 'review.json');
  run(['review', 'record', '--review', 'review.json'], t.reviewer);

  const ready = json(['reconcile', '--canonical-inputs', said], t.dev);
  assert.deepEqual([ready.status, ready.nextAction], ['ready', 'integrate']);
  assert.deepEqual([ready.detail.review.applies, ready.detail.review.reasons], [true, []]);

  // One more commit — the ordinary thing to do after a review, and the thing that invalidates it.
  commit(t.dev, 'coupon.md', '# coupon\n\naddress the note\n', 'coupon: address review note');
  const moved = json(['reconcile', '--canonical-inputs', said], t.dev);
  assert.notEqual(moved.nextAction, 'integrate');
  assert.equal(moved.nextAction, 'run-validation');
  assert.deepEqual([moved.detail.review.applies, moved.detail.review.reasons], [false, ['candidate-moved']]);
  assert.equal(moved.detail.review.status, 'approved', 'the decision is still on the record; it just does not cover this');
  assert.equal(json(['validate', 'state', '--gate', 'merge', ...TASK], t.dev).status, 'unknown');
  assert.ok(moved.reasons.some((reason) => /candidate-moved/.test(reason)),
    'the reason says which staleness this is, because the remedies differ');
});

// ------------------------------------------------------------------ §17 Scenario 6

/**
 * Total context loss: the case the layer exists for.
 *
 * An Agent that has been compacted knows nothing — not its own id, not the session, not what it
 * was doing. Every command in this test therefore takes no arguments beyond the subcommand, and
 * the chain has to reconstruct identity, role, session, task, the input snapshot, the state of
 * the tree, the queue, and the next action. Anything that requires an argument the Agent would
 * have had to remember is not part of a recovery path.
 *
 * Two routes are covered because they are genuinely different. An implementer is found by its
 * task. A reviewer that has already acked its mail has neither a task nor an inbox row, and used
 * to be told `open-session` — advice to start a second session for work already under way, in
 * the layer whose whole promise is that it does not have to remember. It is found by the events
 * it caused, which is the only record of participation that exists.
 */
test('scenario 6: an agent with no context recovers identity, session, task and next action', () => {
  const t = team();
  const record = issued(t);
  run(['task', 'set-status', ...TASK, '--status', 'in-progress'], t.dev);
  commit(t.dev, 'coupon.md', '# coupon\n', 'coupon: implement');

  // Who am I, and what does this worktree have to do with anything?
  const who = json(['show'], t.dev);
  assert.deepEqual([who.identity.agentId, who.identity.role], ['fullstack-01', 'fullstack']);
  assert.equal(who.binding.harness, 'claude-code', 'and which harness it is being driven by, for the adapter');
  const seen = json(['status'], t.dev);
  assert.deepEqual(seen.sessions.map((s) => [s.sessionId, s.status]), [['feature:coupon', 'forming']]);
  assert.deepEqual(seen.sessions[0].tasks.map((task) => task.taskId), ['task:coupon-api']);

  // And what should I do now?
  const back = json(['reconcile'], t.dev);
  assert.deepEqual([back.session, back.task, back.detail.role], ['feature:coupon', 'task:coupon-api', 'fullstack']);
  assert.equal(back.detail.taskStatus, 'in-progress');
  assert.equal(back.detail.inputSnapshotDigest, record.inputSnapshotDigest,
    'the recovered snapshot is the one the task was issued with, not one recomputed from what is around now');
  assert.equal(back.detail.git.baseRevision, record.frozen.baseRevision);
  assert.equal(back.detail.candidateRevision, `git:${git(['rev-parse', 'HEAD'], t.dev.repo)}`);
  assert.equal(back.freshness.inputs, 'unknown', 'nobody was asked what the contract says, so it is not claimed fresh');
  assert.deepEqual(json(['inbox'], t.dev), [], 'nothing is waiting, said as an empty queue rather than an error');
  assert.equal(back.nextAction, 'run-validation');

  // A worktree nobody has bound recovers the one thing it can: that it is not anybody yet.
  const stranger = path.join(t.product.dir, 'wt-stranger');
  git(['worktree', 'add', stranger, '-b', 'stranger'], t.product.repo);
  const unbound = json(['reconcile'], { dir: t.product.dir, repo: stranger, home: t.product.home });
  assert.deepEqual([unbound.status, unbound.nextAction, unbound.agent], ['unbound', 'bind-worktree', null]);

  // The reviewer's route: acked mail, no task, and a session it must be able to name.
  writeDraft(t.dev, {
    sessionId: 'feature:coupon',
    taskId: 'task:coupon-api',
    to: { role: 'reviewer' },
    nextAction: 'review',
    summary: 'Ready for review.',
  });
  const published = json(['handoff', 'publish', '--handoff', 'draft.json'], t.dev);
  run(['handoff', 'ack', '--session', 'feature:coupon', '--handoff', published.handoffId], t.reviewer);

  const resumed = json(['reconcile'], t.reviewer);
  assert.deepEqual([resumed.session, resumed.task, resumed.nextAction], ['feature:coupon', null, 'await-task']);
  assert.deepEqual(resumed.detail.unackedHandoffs, [], 'the mail is answered; that is why this route is needed');
  assert.deepEqual(resumed.detail.unreadableSessions, []);
  const there = json(['session', 'show', '--session', resumed.session], t.reviewer);
  assert.equal(there.session.integrationTarget, t.branch, 'the recovered session says where the work is going');
});

// ------------------------------------------------------------------ §17 Scenario 7

/**
 * Two worktrees writing to one session.
 *
 * The ledger's own concurrency is proved with real processes in `tests/ledger.test.mjs`. What is
 * asserted here is the part an Agent has to act on: a losing write is refused with a code that
 * says it is worth retrying, at an exit code distinguishable from a refusal that is not — an
 * Agent that cannot tell `REVISION_CONFLICT` from `ILLEGAL_TRANSITION` either gives up on
 * recoverable work or retries a refusal forever.
 *
 * The loser's transition is deliberately legal from the status the winner moved the session to,
 * because illegality is checked first: with an illegal target this would pass while proving
 * nothing about the compare-and-set it claims to be about.
 */
test('scenario 7: a losing write to a shared session is refused as retryable, and the retry works', () => {
  const t = team();
  issued(t);
  const before = json(['session', 'show', ...SESSION], t.product);
  assert.deepEqual([before.session.status, before.session.revision], ['forming', 1],
    'issuing a task writes a task record and an event, not the session: they version separately');

  const won = json(['session', 'set-status', ...SESSION, '--status', 'product-definition',
    '--expect-revision', String(before.session.revision)], t.product);
  assert.deepEqual([won.status, won.revision], ['product-definition', before.session.revision + 1]);

  // The dev was holding the revision it read before the product architect wrote.
  const lost = refusal(['session', 'set-status', ...SESSION, '--status', 'ready-for-implementation',
    '--expect-revision', String(before.session.revision)], t.dev);
  assert.deepEqual(lost, { code: 'REVISION_CONFLICT', exit: 4 },
    'exit 4 is "refused, but reading again may fix it" — 3 would mean stop');

  const retried = json(['session', 'set-status', ...SESSION, '--status', 'ready-for-implementation',
    '--expect-revision', String(json(['session', 'show', ...SESSION], t.dev).session.revision)], t.dev);
  assert.equal(retried.status, 'ready-for-implementation');

  // Both writes are in the log, in order, attributed to whoever made them — and the loser left
  // nothing behind, which is what a refusal before the write buys.
  const changes = json(['session', 'events', '--session', 'feature:coupon', '--kind', 'session-status-changed'], t.dev);
  assert.deepEqual(changes.map((event) => [event.actor, event.to]),
    [['agent:product-01', 'product-definition'], ['agent:fullstack-01', 'ready-for-implementation']]);
});

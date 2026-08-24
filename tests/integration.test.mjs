/**
 * The two gates, and the four ways a merge can be wrong when only one of them was asked.
 *
 * Everything else in this suite proves one layer's rules. These tests prove the *composition* —
 * that a semantic pass and a structural pass are each necessary and neither is sufficient — and
 * they are the only tests here whose subject is a boundary rather than a behaviour. That makes
 * them easy to write badly: an assertion that `semanticPass && structuralPass` implies readiness
 * is a tautology if the test computes both halves itself. So every case below goes through
 * `teamctl validate-candidate`, and the structural half arrives the way it will in production —
 * as a file spec-suite's merge gate wrote, which this layer reads and does not second-guess.
 *
 * The fixture merge-gate result is the shape `scripts/control-plane-merge.mjs` publishes, kept to
 * the fields this layer actually reads plus enough context to be recognisable. It is deliberately
 * not imported from spec-suite: the point of the adapter is that this layer works against a
 * documented shape rather than against an installed copy, and a test that imported the real thing
 * would stop proving that and start requiring spec-suite to be present.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  INTEGRATION_PHASES, PHASE_GATES, SEMANTIC_ESTABLISHED_NEGATIVE, SEMANTIC_UNESTABLISHED,
  composeIntegration, semanticVerdict, structuralVerdict,
} from '../src/integration.mjs';
import { NEXT_ACTIONS } from '../src/reconcile.mjs';
import { git, json, run, writeDraft, writePacket } from './helpers/cli.mjs';
import { A1, SESSION, TASK, canonical, commit, couponPacket, issued, team } from './helpers/team.mjs';

/**
 * spec-suite's merge-gate verdict, as a file.
 *
 * `safeToMerge` is the one field this layer trusts; `status` travels along as a label so a reader
 * can see which structural finding it was. `headRevision` is what binds the two verdicts to the
 * same commit, and it is spec-suite's own field name rather than a translation of it.
 */
function structural(worktree, { status, safeToMerge, headRevision, requiresRevalidation = false }, name = 'merge-gate.json') {
  const body = {
    schemaVersion: 1,
    type: 'merge-gate-result',
    taskId: 'task:coupon-api',
    headRevision,
    checks: { requiresRebase: !safeToMerge, requiresRevalidation },
    status,
    safeToMerge,
  };
  fs.writeFileSync(path.join(worktree.repo, name), `${JSON.stringify(body, null, 2)}\n`);
  return name;
}

/** The dev's HEAD, in the form every revision in this layer is written in. */
const head = (worktree) => `git:${git(['rev-parse', 'HEAD'], worktree.repo)}`;

/**
 * A task carried all the way to semantically integrable: implemented, validated, approved.
 *
 * Written as a helper because three of the four cases below need it and only differ in what
 * happens next — and because a test that reaches this state by a shortcut would not be starting
 * from a state the product can actually reach.
 */
function approved(t) {
  issued(t);
  run(['task', 'set-status', ...TASK, '--status', 'in-progress'], t.dev);
  const candidate = commit(t.dev, 'coupon.md', '# coupon\n\nDiscount applies once.\n', 'coupon: apply once');
  run(['validate', 'run', '--gate', 'handoff', ...TASK], t.dev);
  writeDraft(t.dev, {
    sessionId: 'feature:coupon',
    taskId: 'task:coupon-api',
    to: { role: 'reviewer' },
    nextAction: 'review',
    summary: 'Discount is applied once, in the domain layer.',
    artifacts: [{ type: 'code', id: 'module:coupon', revision: candidate }],
    evidence: [{ kind: 'validation', detail: 'unit-tests', result: 'evidence:unit-tests-1 passed' }],
  });
  run(['handoff', 'publish', '--handoff', 'draft.json'], t.dev);
  run(['task', 'set-status', ...TASK, '--status', 'completed'], t.dev);
  run(['handoff', 'ack', ...SESSION, '--handoff', 'handoff:fullstack-to-reviewer-1'], t.reviewer);
  writeDraft(t.reviewer, {
    sessionId: 'feature:coupon',
    taskId: 'task:coupon-api',
    status: 'approved',
    candidateRevision: candidate,
    requirementsRevision: A1,
    summary: 'AC-1 holds.',
    validationEvidence: ['evidence:unit-tests-1'],
  }, 'review.json');
  run(['review', 'record', '--review', 'review.json'], t.reviewer);
  run(['validate', 'run', '--gate', 'merge', ...TASK], t.dev);
  return candidate;
}

// ------------------------------------------------------------------ the classification table

/**
 * Every reconcile answer is either a finding about the candidate or the absence of one.
 *
 * The unit-level companion to the installer check in `scripts/validate-skill.mjs`: that one
 * proves the two lists partition `NEXT_ACTIONS`, and this one proves the partition is used —
 * that an action on the negative list produces `failed` rather than the safe-looking `unknown`
 * a default would give it.
 */
test('an unrecognised next action would read unknown, so every action is classified', () => {
  const classified = [...SEMANTIC_ESTABLISHED_NEGATIVE, ...SEMANTIC_UNESTABLISHED];
  assert.deepEqual(
    NEXT_ACTIONS.filter((a) => a !== 'integrate' && !classified.includes(a)), [],
    'an unclassified action falls through to unknown, which reads as "nobody has established it yet" — '
    + 'so a new action meaning "the code is wrong" would send a reader looking for a check to run',
  );
  for (const action of SEMANTIC_ESTABLISHED_NEGATIVE) {
    const v = semanticVerdict({ phase: 'pre-merge', candidate: 'git:abc', decision: { nextAction: action } });
    assert.deepEqual([v.status, v.reasons], ['failed', [action]], `${action} is a verdict against the candidate`);
  }
  for (const action of SEMANTIC_UNESTABLISHED) {
    const v = semanticVerdict({ phase: 'pre-merge', candidate: 'git:abc', decision: { nextAction: action } });
    assert.equal(v.status, 'unknown', `${action} establishes nothing either way`);
  }
});

test('a gate that failed outranks the action that named it, so the report says which check', () => {
  const v = semanticVerdict({
    phase: 'pre-merge',
    candidate: 'git:abc',
    decision: { nextAction: 'run-validation' },
    validations: [{ gate: 'merge', status: 'failed', failed: 1, unknown: 0 }],
  });
  assert.deepEqual([v.status, v.reasons], ['failed', ['merge-validation-failed', 'run-validation']],
    'run-validation covers both a check that failed and one that has not run; only the gate knows which — '
    + 'and a report without the action would name the finding and not the remedy');
});

test('a candidate nobody named is unknown, not a finding about any tree', () => {
  const v = semanticVerdict({ phase: 'pre-merge', candidate: null, decision: { nextAction: 'integrate' } });
  assert.deepEqual([v.status, v.reasons], ['unknown', ['candidate-unknown']]);
});

test('a phase this layer does not know is a programming error, not a refusal', () => {
  assert.throws(() => semanticVerdict({ phase: 'post-merge', decision: { nextAction: 'integrate' } }), TypeError);
  assert.deepEqual(INTEGRATION_PHASES, ['pre-merge', 'post-replay']);
});

/**
 * Why `post-replay` asks the merge gate and not only the revalidation one.
 *
 * A gate with no checks declared reads `passed`, correctly — nothing was required of it. So a
 * phase that asked only `revalidation` would hand a clean verdict to a packet that never declared
 * a revalidation check, which is most of them. This is that verdict, constructed directly: it is
 * a `passed` about a replayed commit, on the strength of nothing having been asked. The merge gate
 * is in the phase's list so that everything which had to hold before the replay has to hold after
 * it, against the new commit.
 */
test('a phase asking one gate that declares nothing would pass a replayed commit on no evidence', () => {
  const emptyGateOnly = semanticVerdict({
    phase: 'post-replay',
    candidate: 'git:c2',
    decision: { nextAction: 'integrate' },
    validations: [{ gate: 'revalidation', status: 'passed', failed: 0, unknown: 0 }],
  });
  assert.equal(emptyGateOnly.status, 'passed',
    'nothing was required of the only gate asked, so the verdict is a pass about a tree nothing was run against');
  assert.deepEqual(PHASE_GATES['post-replay'], ['revalidation', 'merge'],
    'which is why the phase asks both, and why dropping either one is a hole rather than a tidy-up');
});

/**
 * A structural report is read for one boolean, and anything else is `unknown`.
 *
 * The temptation the last case resists: treating an unfamiliar report as a refusal would look
 * tidier and would be a finding about the candidate that nobody made.
 */
test('the structural half is read, never inferred', () => {
  const consulted = structuralVerdict({ status: 'ready', safeToMerge: true, headRevision: 'git:abc' });
  assert.deepEqual([consulted.status, consulted.source, consulted.candidate], ['passed', 'spec-suite', 'git:abc']);

  const refused = structuralVerdict({ status: 'out-of-scope', safeToMerge: false, headRevision: 'git:abc' });
  assert.deepEqual([refused.status, refused.reasons], ['failed', ['structural-out-of-scope']],
    'the label is prefixed because both layers say stale-base and mean different remedies');

  const absent = structuralVerdict(null);
  assert.deepEqual([absent.status, absent.source, absent.reasons],
    ['unknown', 'not-consulted', ['structural-gate-not-consulted']]);

  const strange = structuralVerdict({ status: 'ready', headRevision: 'git:abc' });
  assert.deepEqual([strange.status, strange.reasons], ['unknown', ['structural-verdict-unrecognized']],
    'a report without the field the verdict lives in has not said yes or no');
});

test('two passes about two different commits are not a pass', () => {
  const semantic = semanticVerdict({ phase: 'post-replay', candidate: 'git:c1', decision: { nextAction: 'integrate' } });
  const composed = composeIntegration({
    semantic,
    structural: structuralVerdict({ status: 'ready', safeToMerge: true, headRevision: 'git:c2' }),
  });
  assert.equal(composed.integrationReady, false);
  assert.equal(composed.sameCandidate, false);
  assert.ok(composed.reasons.includes('verdicts-disagree-on-candidate'),
    'both halves genuinely passed; they are about the tree before and after a replay');
});

// ------------------------------------------------------------------ acceptance: the four cases

/**
 * Semantics fail, structure passes: the merge is refused.
 *
 * The structural gate is answering honestly — the write set was respected, the target has not
 * moved, the history is submittable — and it has no way to know the approval it is about was
 * withdrawn. This is the case where a single-gate design merges unreviewed work.
 */
test('a semantic failure is not overridden by a clean structural verdict', () => {
  const t = team();
  const candidate = approved(t);
  const said = canonical(t.dev, [{ id: 'contract:coupon', revision: A1 }]);

  // The reviewer changes its mind. Nothing structural about the candidate changes at all.
  writeDraft(t.reviewer, {
    sessionId: 'feature:coupon',
    taskId: 'task:coupon-api',
    status: 'changes-requested',
    candidateRevision: candidate,
    requirementsRevision: A1,
    summary: 'The discount is applied in the API layer, not the domain layer.',
    findings: [{
      findingId: 'finding:layering-1', severity: 'major', status: 'open',
      summary: 'move the rule into the domain',
    }],
  }, 'review-2.json');
  run(['review', 'record', '--review', 'review-2.json'], t.reviewer);

  const gate = structural(t.dev, { status: 'ready', safeToMerge: true, headRevision: candidate });
  const v = json(['validate-candidate', '--phase', 'pre-merge', '--canonical-inputs', said, '--structural', gate], t.dev);

  assert.equal(v.status, 'failed', 'the hook reads this field and anything but passed is a refusal');
  assert.equal(v.semantic.nextAction, 'address-review');
  assert.equal(v.structural.status, 'passed', 'the structural gate is not wrong; it is answering another question');
  assert.equal(v.integrationReady, false);
  assert.deepEqual(v.reasons, ['semantic-failed', 'merge-validation-failed', 'address-review'],
    'which layer refused, which check found it, and what to do — a reader needs all three');
  assert.equal(v.sameCandidate, true, 'both halves are about the same commit, which is why only one of them refuses');
});

/**
 * Semantics pass, structure fails: the merge is refused.
 *
 * The mirror case, and the one this layer cannot detect on its own — the work is finished,
 * reviewed and green against this exact commit, and `teamctl reconcile` says `integrate`. What it
 * does not know is anything about write scope or ancestry, which is the whole reason it must not
 * be the last word.
 */
test('a semantic pass is not permission to merge when the structural gate refuses', () => {
  const t = team();
  const candidate = approved(t);
  const said = canonical(t.dev, [{ id: 'contract:coupon', revision: A1 }]);

  assert.equal(json(['reconcile', '--canonical-inputs', said], t.dev).nextAction, 'integrate',
    'this layer is satisfied, and on its own would be the last word');

  const gate = structural(t.dev, { status: 'out-of-scope', safeToMerge: false, headRevision: candidate });
  const v = json(['validate-candidate', '--phase', 'pre-merge', '--canonical-inputs', said, '--structural', gate], t.dev);

  assert.equal(v.status, 'passed', 'the semantic verdict is a pass and says so; it is just not the whole answer');
  assert.equal(v.integrationReady, false);
  assert.deepEqual(v.reasons, ['structural-out-of-scope'],
    'the only thing wrong is structural, and the reason says which layer found it');
  assert.equal(v.structural.source, 'spec-suite');
});

/**
 * A replay invalidates the semantic verdict, so the validator has to be asked again.
 *
 * This is the sentence in protocol/spec-suite.md — "structural replay alone is not proof of
 * semantic correctness" — turned into something that fails. Every review decision and every piece
 * of evidence in the ledger is bound to a commit; a replay produces a commit none of them are
 * bound to. The first call passed. The same call against the replayed commit must not.
 */
test('after a structural replay the semantic validator must be asked again, about the new commit', () => {
  const t = team();
  const candidate = approved(t);
  const said = canonical(t.dev, [{ id: 'contract:coupon', revision: A1 }]);

  const before = json(['validate-candidate', '--phase', 'pre-merge', '--canonical-inputs', said,
    '--structural', structural(t.dev, { status: 'ready', safeToMerge: true, headRevision: candidate })], t.dev);
  assert.deepEqual([before.status, before.integrationReady], ['passed', true]);

  // The target moves and spec-suite replays the candidate onto it. From this layer's side that is
  // simply a new commit that nothing on record is about.
  commit(t.product, 'CHANGELOG.md', '# changelog\n', 'pricing: rounding fix');
  git(['merge', t.branch, '--no-edit'], t.dev.repo);
  const replayed = head(t.dev);
  assert.notEqual(replayed, candidate);

  const gate = structural(t.dev, {
    status: 'ready', safeToMerge: true, headRevision: replayed, requiresRevalidation: true,
  });
  const after = json(['validate-candidate', '--phase', 'post-replay', '--candidate', replayed,
    '--canonical-inputs', said, '--structural', gate], t.dev);

  assert.notEqual(after.status, 'passed', 'the evidence and the approval are about the tree the replay replaced');
  assert.equal(after.integrationReady, false);
  assert.equal(after.structural.status, 'passed', 'spec-suite did its half correctly, twice');
  // Written as a literal rather than as PHASE_GATES['post-replay'] on purpose: comparing the
  // observed list against the constant that produced it asserts nothing, and would move with a
  // change that dropped `merge` from the phase. The companion unit test below says why `merge`
  // has to be in it.
  assert.deepEqual(after.semantic.gates.map((g) => g.gate), ['revalidation', 'merge'],
    'post-replay asks the merge gate too, because a packet may declare no revalidation checks '
    + 'and an empty gate reads passed');
  assert.ok(after.reasons.some((r) => r.startsWith('semantic-')), 'the refusal is this layer\'s, and is named as such');

  // And the way back is to re-run the checks against the new commit, not to re-read the old pass.
  run(['validate', 'run', '--gate', 'merge', '--session', 'feature:coupon', '--task', 'task:coupon-api'], t.dev);
  const rerun = json(['validate-candidate', '--phase', 'post-replay', '--candidate', replayed,
    '--canonical-inputs', said, '--structural', gate], t.dev);
  assert.equal(rerun.semantic.review.applies, false,
    'the command check now passes against the replayed commit; the human judgement does not follow it');
  assert.equal(rerun.integrationReady, false, 'and re-running a suite is not a way to obtain an approval');
});

/**
 * Both halves pass, about the same commit, and only then is the state reached.
 *
 * The positive case exists to prove the conjunction is reachable — a gate that can never open is
 * indistinguishable from one that is broken — and to pin down that a missing structural report
 * withholds it rather than defaulting to yes. `--structural` omitted is the accident this catches:
 * a caller that forgot the flag would otherwise be told the merge is ready on semantic grounds
 * alone, which is exactly the single-gate failure the other three tests describe.
 */
test('integration-ready needs both verdicts, about one commit, and withholds when one is missing', () => {
  const t = team();
  const candidate = approved(t);
  const said = canonical(t.dev, [{ id: 'contract:coupon', revision: A1 }]);

  const alone = json(['validate-candidate', '--phase', 'pre-merge', '--canonical-inputs', said], t.dev);
  assert.equal(alone.status, 'passed');
  assert.equal(alone.integrationReady, false, 'nobody asked the structural gate; absent is not passing');
  assert.deepEqual([alone.structural.source, alone.sameCandidate], ['not-consulted', null]);

  const both = json(['validate-candidate', '--phase', 'pre-merge', '--canonical-inputs', said,
    '--structural', structural(t.dev, { status: 'ready', safeToMerge: true, headRevision: candidate })], t.dev);
  assert.equal(both.integrationReady, true);
  assert.deepEqual(both.reasons, [], 'nothing is outstanding, and the report says so by having nothing to say');
  assert.deepEqual([both.status, both.structural.status, both.sameCandidate], ['passed', 'passed', true]);
  assert.equal(both.candidate, candidate);
  assert.equal(both.semantic.taskFrozenDigest, json(['task', 'show', ...TASK], t.dev).frozenDigest,
    'the report names the task world it is a verdict about, so a reissue can be seen to invalidate it');
});

// ------------------------------------------------------------------ the command's own contract

/**
 * A report this layer cannot read is not a pass, even when it is about the right commit.
 *
 * The version-skew case, and the one the same-commit rule cannot cover for: an installed
 * spec-suite whose merge gate publishes its verdict under a name this adapter does not know still
 * names `headRevision`, so `sameCandidate` is satisfied and the only thing standing between it and
 * a merge is that `integrationReady` requires the structural half to have actually *passed*.
 * `unknown` is a third value here too — the report is not a refusal either, and calling it one
 * would be a finding about the candidate that nobody made.
 */
test('a merge-gate report this layer cannot read withholds the merge, about the right commit or not', () => {
  const t = team();
  const candidate = approved(t);
  const said = canonical(t.dev, [{ id: 'contract:coupon', revision: A1 }]);

  fs.writeFileSync(path.join(t.dev.repo, 'skewed.json'), `${JSON.stringify({
    schemaVersion: 2,
    type: 'merge-gate-result',
    taskId: 'task:coupon-api',
    headRevision: candidate,
    // The verdict moved: a newer or older gate reports it somewhere this adapter does not look.
    outcome: 'ready',
  }, null, 2)}\n`);

  const v = json(['validate-candidate', '--phase', 'pre-merge', '--canonical-inputs', said,
    '--structural', 'skewed.json'], t.dev);

  assert.equal(v.status, 'passed', 'the semantic half is genuinely satisfied');
  assert.deepEqual([v.structural.status, v.structural.source], ['unknown', 'spec-suite'],
    'somebody was asked and the answer could not be read; that is not the same as nobody being asked');
  assert.equal(v.sameCandidate, true, 'the report is about the right commit, so the mismatch rule cannot help here');
  assert.equal(v.integrationReady, false, 'which leaves the conjunction requiring a pass it never received');
  assert.deepEqual(v.reasons, ['structural-verdict-unrecognized']);
});

test('post-replay refuses to guess the candidate, because HEAD is the tree the replay replaced', () => {
  const t = team();
  approved(t);
  const res = run(['validate-candidate', '--phase', 'post-replay'], t.dev, 1);
  assert.match(res.stderr, /--candidate is required for --phase post-replay/);
});

test('a phase the CLI does not know is a usage error, not an unknown verdict', () => {
  const t = team();
  approved(t);
  assert.match(run(['validate-candidate', '--phase', 'post-merge'], t.dev, 1).stderr, /--phase must be one of/);
});

test('a failing candidate is still exit 0, because "I could not ask" needs a different response', () => {
  const t = team();
  issued(t);
  // Nothing implemented, nothing reviewed: the most refused a candidate can be.
  const v = json(['validate-candidate', '--phase', 'pre-merge'], t.dev);
  assert.equal(v.integrationReady, false);
  assert.notEqual(v.status, 'passed');
  assert.equal(v.schemaVersion, 1);
});

test('the two commands answer from one observation, so they cannot disagree about the task', () => {
  const t = team();
  const candidate = approved(t);
  const said = canonical(t.dev, [{ id: 'contract:coupon', revision: A1 }]);
  const r = json(['reconcile', '--canonical-inputs', said], t.dev);
  const v = json(['validate-candidate', '--phase', 'pre-merge', '--canonical-inputs', said], t.dev);
  assert.deepEqual(
    [r.session, r.task, r.nextAction, r.detail.candidateRevision, r.detail.taskFrozenDigest],
    [v.session, v.task, v.semantic.nextAction, v.candidate, v.semantic.taskFrozenDigest],
  );
  assert.equal(candidate, v.candidate);
});

test('a reissued task makes the standing approval inapplicable, and the verdict follows', () => {
  const t = team();
  approved(t);
  const said = canonical(t.dev, [{ id: 'contract:coupon', revision: A1 }]);
  assert.equal(json(['validate-candidate', '--phase', 'pre-merge', '--canonical-inputs', said], t.dev).status, 'passed');

  writePacket(t.product, couponPacket(t, { acceptance: ['AC-1 discount applies at most once per order'] }), 'packet-2.json');
  run(['task', 'reissue', '--packet', 'packet-2.json', '--reason', 'AC-1 clarified', '--expect-generation', '1'], t.product);

  const after = json(['validate-candidate', '--phase', 'pre-merge', '--canonical-inputs', said], t.dev);
  assert.notEqual(after.status, 'passed', 'the approval was of a different statement of the task');
  assert.ok(after.semantic.review === null || after.semantic.review.applies === false);
});

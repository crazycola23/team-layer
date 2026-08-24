/**
 * The tests that run the other side's code.
 *
 * Everything else in this suite proves this layer is internally consistent. That is necessary and
 * it is not sufficient, because the two projects are only useful composed, and every fake far side
 * in this repository was built from the same beliefs as the code it tests. When a belief is wrong
 * the fake is wrong in the same direction and the suite stays green. `taskId` was exactly that: a
 * field the real merge gate refuses a task without, filed as team-layer-owned, with passing tests.
 *
 * So these run real spec-suite binaries against real Git repositories, in both directions —
 * projected task into spec-suite's gate, and spec-suite's verdict back into this layer's composer.
 * The capability tests come first because they are what the other direction rests on: a projection
 * decides what to carry from the far side's own answer about itself, so a handshake read from a hand-
 * written JSON shape would only prove this file can read this file.
 *
 * They skip, loudly, when no checkout is available; `scripts/validate-skill.mjs` refuses to let the
 * file or its tests disappear.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { bootstrapped, run, taskPacket, writePacket, ROOT } from './helpers/cli.mjs';
import { SPEC_SUITE_ENV, findSpecSuite, git, requireSpecSuite, specSuite } from './helpers/cross-repo.mjs';
import { SPEC_SUITE_CAPABILITIES, detectCapabilities } from '../src/spec-suite.mjs';
import { structuralVerdict } from '../src/integration.mjs';

/**
 * A repository with a base commit, a candidate commit inside the write set, and a projected task.
 *
 * The candidate is committed with an explicit pathspec: the fixture's worktree also holds the
 * packet and this Agent's own binding, and a `git add -A` would put them in the diff the gate is
 * about to check against the write set. The test would then fail for the test harness's writes,
 * which is the least informative way to go red.
 */
function projected(specSuiteRoot, { packet = {}, session = 'feature:coupon' } = {}) {
  const f = bootstrapped();
  const base = git(['rev-parse', 'HEAD'], f.repo);
  const env = { SPEC_SUITE_ROOT: specSuiteRoot };

  run(['session', 'start', '--session', session, '--target', 'main'], f);
  writePacket(f, taskPacket({ baseRevision: `git:${base}`, ...packet }));
  run(['task', 'issue', '--packet', 'packet.json'], f);

  fs.mkdirSync(path.join(f.repo, 'src', 'coupon'), { recursive: true });
  fs.writeFileSync(path.join(f.repo, 'src', 'coupon', 'rules.mjs'), 'export const CAP = 1;\n');
  git(['add', 'src/coupon/rules.mjs'], f.repo);
  git(['commit', '-m', 'candidate'], f.repo);
  const head = git(['rev-parse', 'HEAD'], f.repo);

  const report = JSON.parse(run(['project-spec-task', '--session', session,
    '--task', 'task:coupon-api', '--output', 'spec-task.json'], { ...f, env }).stdout);
  return { f, base, head, report, taskFile: 'spec-task.json' };
}

function gate(root, { f, base, head, taskFile }, overrides = {}) {
  const args = [
    '--repo-root', f.repo,
    '--task', overrides.task ?? taskFile,
    '--target-ref', overrides.targetRef ?? base,
    '--head-ref', overrides.headRef ?? head,
  ];
  if (overrides.output) args.push('--output', overrides.output);
  return specSuite(root, 'merge-gate.mjs', args);
}

/**
 * The handshake, read from the checkout that emits it.
 *
 * Every other capability test in this suite builds a fake `scripts/capabilities.mjs` and proves this
 * layer can read it, which proves the reader and nothing about the contract: a fake emits the shape
 * this layer expects by construction. The failure that costs something is a *name* drifting. If
 * spec-suite renamed `mergeGate`, this layer would find no feature by that name, report `unknown`,
 * withhold nothing it was carrying anyway, and go on returning `source: 'declared'` — a green suite,
 * a real handshake, and every answer in it useless. Nothing fails; the layer just stops knowing
 * things.
 *
 * So this reads spec-suite's own output and compares it entry for entry against what this layer made
 * of it.
 */
test('cross-repo: the real handshake is read, and both layers name the same capabilities', (t) => {
  const root = requireSpecSuite(t);
  if (!root) return;
  if (!fs.existsSync(path.join(root, 'scripts', 'capabilities.mjs'))) {
    t.skip('this spec-suite predates scripts/capabilities.mjs, so the declared path cannot be run');
    return;
  }

  const raw = specSuite(root, 'capabilities.mjs', ['--format', 'json']);
  assert.equal(raw.status, 0, `the real handshake failed closed: ${raw.stderr}`);
  assert.ok(raw.json, `the handshake emitted no JSON: ${raw.stdout}`);

  const detection = detectCapabilities({ root });
  assert.equal(detection.source, 'declared',
    `the handshake is present but was not used; notes: ${detection.notes.join('; ')}`);
  assert.equal(detection.protocolVersion, raw.json.protocolVersion);
  assert.ok(Number.isInteger(detection.protocolVersion) && detection.protocolVersion > 0,
    `protocolVersion must be a version, got ${detection.protocolVersion}`);

  // The name check, in the direction that goes quiet: every feature spec-suite declares must be one
  // this layer asks about. A name this layer does not know is dropped on the floor, and the only
  // trace is a note nobody has to read — so the note is asserted absent rather than logged.
  const unknownNames = Object.keys(raw.json.features)
    .filter((name) => !SPEC_SUITE_CAPABILITIES.includes(name));
  assert.deepEqual(unknownNames, [],
    'spec-suite declares capabilities this layer has no name for; add them to SPEC_SUITE_CAPABILITIES '
    + 'or they are silently discarded');
  assert.equal(detection.notes.some((note) => /does not know about/.test(note)), false,
    `detection reported unknown capability names: ${detection.notes.join('; ')}`);

  // And every declared feature arrived with its version intact. Reading the version wrong is worse
  // than not reading it: a caller pinning `mergeGate >= 2` would be pinning a number this layer
  // invented.
  for (const [name, version] of Object.entries(raw.json.features)) {
    const answer = detection.capabilities[name];
    assert.equal(answer.support, 'supported', `${name} is declared but read as ${answer.support}`);
    assert.equal(answer.version, version, `${name}: spec-suite says ${version}, this layer read ${answer.version}`);
  }

  // The composition this layer depends on, tied to the number that promises it. `structuralVerdict`
  // can only bind a verdict to a task because the gate refuses a task with no `taskId` — which is
  // half of what `mergeGate: 2` means. Pinning the floor here means a spec-suite that regressed to
  // version 1 would be a red test rather than a composer quietly comparing `undefined` to `undefined`.
  assert.ok(detection.capabilities.mergeGate.version >= 2,
    `this layer composes against mergeGate >= 2; the install declares ${detection.capabilities.mergeGate.version}`);
});

/**
 * What the real handshake stays silent about, and why silence must not read as support.
 *
 * Today spec-suite declares three features and deliberately omits `semanticInputs` and
 * `semanticValidator` — its own suite holds those omissions to the shapes that justify them. This is
 * the consuming half: an omission has to arrive here as `unknown`, never `supported`, or the
 * projection would hand `inputs` to a task contract that has no such field and the merge gate would
 * appear to be enforcing staleness that nothing enforces.
 *
 * It must not arrive as `unsupported` either, and that costs something worth naming. The probe used
 * to answer `unsupported` for `semanticInputs`, having watched the far side's projection drop the
 * field — a stronger finding than the handshake's silence. Installing the handshake therefore
 * *weakens* this one answer, and that is the correct trade: the probe's finding came from inferring
 * a property of the task contract from a scheduling helper, which is the exact move that produced
 * the `taskId` bug. Both answers withhold the field; only one of them claims to know why.
 */
test('cross-repo: a feature the real handshake omits reads as unknown, not supported', (t) => {
  const root = requireSpecSuite(t);
  if (!root) return;
  if (!fs.existsSync(path.join(root, 'scripts', 'capabilities.mjs'))) {
    t.skip('this spec-suite predates scripts/capabilities.mjs, so the declared path cannot be run');
    return;
  }

  const raw = specSuite(root, 'capabilities.mjs', ['--format', 'json']);
  const detection = detectCapabilities({ root });
  const omitted = SPEC_SUITE_CAPABILITIES
    .filter((name) => !Object.prototype.hasOwnProperty.call(raw.json.features, name));
  assert.ok(omitted.length > 0,
    'the install declares every capability this layer knows; this test can no longer distinguish '
    + 'silence from support and needs a new subject');

  for (const name of omitted) {
    assert.equal(detection.capabilities[name].support, 'unknown',
      `${name} is not declared, so it must be unknown, not ${detection.capabilities[name].support}`);
    assert.equal(detection.capabilities[name].version, null);
  }
});

/**
 * Detection reaching the artifact: the projection an Agent actually gets, against the real far side.
 *
 * The two tests above establish what the handshake says. This one establishes that saying it changes
 * what travels — the whole reason the handshake was worth building. A detection layer that reported
 * beautifully and projected identically either way would be decoration.
 */
test('cross-repo: a real declared handshake is what the projection report acts on', (t) => {
  const root = requireSpecSuite(t);
  if (!root) return;
  if (!fs.existsSync(path.join(root, 'scripts', 'capabilities.mjs'))) {
    t.skip('this spec-suite predates scripts/capabilities.mjs, so the declared path cannot be run');
    return;
  }
  const { report } = projected(root);

  assert.equal(report.compatibility.source, 'declared');
  assert.equal(report.compatibility.fieldsDiscovered, true,
    'the projectable field list must still be discovered from the far side, not assumed');
  assert.equal(report.compatibility.warnings.some((w) => /no capability handshake was available/.test(w)),
    false, 'a handshake answered; the report must not still be apologising for its absence');

  // `inputs` stays behind, and the report says which capability held it back. Degraded is the honest
  // status here: the field is enforced, but only in this layer, and a caller is entitled to refuse
  // to proceed on that rather than discover it in a log.
  assert.equal(report.compatibility.mode, 'degraded');
  const inputs = report.withheld.find((w) => w.field === 'inputs');
  assert.ok(inputs, `inputs must be reported as withheld: ${JSON.stringify(report.withheld)}`);
  assert.equal(inputs.reason, 'capability-unknown',
    'the handshake is silent about semanticInputs, so the reason is unknown rather than unsupported');
  assert.equal(inputs.capability, 'semanticInputs');
  assert.equal(report.projected.includes('inputs'), false,
    'a field withheld for a capability reason must not also be reported as carried');

  // And the fields the handshake's declared capabilities do license are all there, `taskId` included
  // — the one that travels whatever detection says.
  assert.deepEqual(report.projected,
    ['baseRevision', 'readSet', 'role', 'subject', 'taskId', 'writeSet']);
});

/**
 * The test P0-1 exists for: the artifact this layer writes is one the real gate can read.
 *
 * Not "does not crash" — the verdict has to be *about* the projected task. A gate that answered
 * `ready` while reporting someone else's taskId would satisfy an exit-code assertion and be
 * useless to the composer downstream, which decides whether to merge by comparing exactly these
 * fields.
 */
test('cross-repo: the real merge gate reads a projected task and rules on it', (t) => {
  const root = requireSpecSuite(t);
  if (!root) return;
  const fixture = projected(root);
  const result = gate(root, fixture);

  assert.notEqual(result.status, 1,
    `the real merge gate failed closed on a projected task: ${result.stderr}`);
  assert.ok(result.json, `the gate wrote no verdict: ${result.stdout}${result.stderr}`);
  assert.equal(result.json.type, 'merge-gate-result');

  // The verdict names the task this layer projected, not merely a task.
  assert.equal(result.json.taskId, 'task:coupon-api');
  assert.equal(result.json.subject, 'agent:fullstack-01');
  assert.equal(result.json.baseRevision, `git:${fixture.base}`);
  /**
   * Canonical `git:<sha>`, on both sides, which is what makes the composition a string comparison.
   *
   * `composeIntegration` decides `sameCandidate` by comparing this value to the candidate this layer
   * validated, and `teamctl` normalises its own to `git:<sha>` (scripts/teamctl.mjs:1062). Two
   * layers agreeing to spell a commit the same way is exactly the kind of fact that is true until
   * it isn't, and a drift here does not fail loudly: it makes every real pair of verdicts look like
   * verdicts about different candidates, which reads as caution rather than a break.
   */
  assert.equal(result.json.headRevision, `git:${fixture.head}`);
  assert.deepEqual(result.json.writeSet, ['src/coupon/**']);
  assert.deepEqual(result.json.changedFiles, ['src/coupon/rules.mjs']);

  // And the projection was clean enough to be mergeable, which is the only outcome that proves
  // every field arrived usable rather than merely present.
  assert.equal(result.json.status, 'ready');
  assert.equal(result.json.safeToMerge, true);
  assert.equal(result.status, 0);
});

/**
 * Why `taskId` travels: because the far side, not this layer, insists.
 *
 * The projection now carries it unconditionally, so nothing in this repository would notice
 * spec-suite dropping the requirement — or, worse, nothing would have noticed it never having had
 * one, which is what the old code assumed. This asserts the requirement is real by removing the
 * field from an otherwise valid artifact and watching the real gate refuse it. If spec-suite
 * genuinely stops requiring `taskId`, this goes red and `CONTRACT_REQUIRED_FIELDS` gets re-read
 * rather than quietly outliving its reason.
 */
test('cross-repo: the real merge gate is what makes taskId non-negotiable', (t) => {
  const root = requireSpecSuite(t);
  if (!root) return;
  const fixture = projected(root);

  const file = path.join(fixture.f.repo, 'spec-task.json');
  const { taskId, ...withoutTaskId } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(taskId, 'task:coupon-api', 'the projection must have carried it in the first place');
  fs.writeFileSync(path.join(fixture.f.repo, 'no-task-id.json'),
    `${JSON.stringify(withoutTaskId, null, 2)}\n`);

  const result = gate(root, fixture, { task: 'no-task-id.json' });
  assert.equal(result.status, 1, `expected a fail-closed refusal, got ${result.status}: ${result.stdout}`);
  assert.match(result.stderr, /taskId/,
    'spec-suite refused the task for some other reason; the fixture no longer isolates taskId');
});

/**
 * The other direction: spec-suite's verdict, read by this layer's composer.
 *
 * `structuralVerdict` is written against the merge-gate result shape, and until something runs the
 * real gate into it, "written against" means "written from a reading of it" — a field renamed on
 * the far side would leave every unit test green and turn every real verdict into `unknown`, which
 * fails closed and so looks like caution rather than a break.
 */
test('cross-repo: a real merge-gate verdict is legible to structuralVerdict', (t) => {
  const root = requireSpecSuite(t);
  if (!root) return;
  const fixture = projected(root);
  const result = gate(root, fixture);
  assert.ok(result.json, `the gate wrote no verdict: ${result.stderr}`);

  const verdict = structuralVerdict(result.json);
  assert.equal(verdict.status, 'passed',
    `a ready verdict must read as passed, got ${verdict.status}: ${verdict.reasons.join(', ')}`);
  assert.equal(verdict.source, 'spec-suite');
  assert.equal(verdict.candidate, `git:${fixture.head}`,
    'the composer must learn the candidate from the verdict, or it cannot check the two gates agree');
});

/**
 * Both gates, both real, composed by the command an Agent actually runs.
 *
 * The test above reads the verdict in-process, which proves the shape and not the wiring: the
 * candidate this layer validated is normalised in `teamctl`, and the one the gate reports comes off
 * a real commit, and nothing so far has made those two strings meet. Here they do — via the real
 * gate's `--output` file and the real CLI — so a drift in either spelling shows up as
 * `sameCandidate: false` in a test instead of as a silent refusal to integrate in production.
 *
 * The composed answer is still `integrationReady: false`, and that is the second half of the point.
 * A structurally perfect candidate with no review and no validation run must not be admitted; if
 * this ever flips to true, the two-gate rule has become a one-gate rule.
 */
test('cross-repo: the real structural verdict composes with this layer\'s semantic one', (t) => {
  const root = requireSpecSuite(t);
  if (!root) return;
  const fixture = projected(root);
  const written = gate(root, fixture, { output: 'gate-result.json' });
  assert.equal(written.status, 0, `expected a safe verdict: ${written.stderr}`);

  const out = JSON.parse(run(['validate-candidate', '--phase', 'pre-merge',
    '--session', 'feature:coupon', '--task', 'task:coupon-api',
    '--candidate', fixture.head, '--structural', path.join(fixture.f.repo, 'gate-result.json'),
  ], fixture.f).stdout);

  assert.equal(out.structural.status, 'passed', `reasons: ${out.structural.reasons.join(', ')}`);
  assert.equal(out.sameCandidate, true,
    `the two layers named different candidates: semantic ${out.candidate}, `
    + `structural ${out.structural.candidate}`);
  assert.equal(out.candidate, `git:${fixture.head}`);
  assert.equal(out.integrationReady, false,
    'a structural pass alone must not admit a candidate nobody validated or reviewed');
  /**
   * `unknown`, not `failed`, and the distinction is the whole fail-closed rule.
   *
   * Nothing has been validated or reviewed on this candidate, so this layer has no finding against
   * it — it has no finding at all. Both answers block the merge, so only an assertion can tell them
   * apart, and the day someone reads the composed result as `status !== 'failed'` the difference
   * becomes the difference between refusing and admitting.
   */
  assert.equal(out.semantic.status, 'unknown');
  assert.notEqual(out.semantic.status, 'passed');
});

/**
 * A real unsafe verdict must read as a real failure, not as an unrecognised one.
 *
 * `unknown` and `failed` both block a merge today, so a shape mismatch on the unsafe path is
 * invisible from the outcome. It stops being invisible the moment anything reports *why* a merge
 * was blocked, and a reason of "we could not read the verdict" when the truth is "the candidate
 * left its write set" sends the next reader to debug the wrong layer.
 */
test('cross-repo: a real out-of-scope verdict reads as failed, with the gate\'s own reason', (t) => {
  const root = requireSpecSuite(t);
  if (!root) return;
  const fixture = projected(root, { packet: { writeSet: ['src/pricing/**'] } });
  const result = gate(root, fixture);

  assert.equal(result.status, 2, `expected a valid-but-unsafe verdict: ${result.stderr}`);
  assert.equal(result.json.status, 'out-of-scope');
  const verdict = structuralVerdict(result.json);
  assert.equal(verdict.status, 'failed');
  assert.ok(verdict.reasons.some((reason) => /out-of-scope/.test(reason)),
    `the gate's own status must survive into the reasons, got: ${verdict.reasons.join(', ')}`);
});

/**
 * The machinery that decides whether the tests above ran — tested, because everything rests on it.
 *
 * These two need no checkout, which is the point: they are the only assertions here that cannot
 * themselves be skipped. `requireSpecSuite` returning a root it should have refused would make the
 * five tests above run spec-suite's binaries out of some other directory and fail confusingly; the
 * same function forgetting to `skip` would make them report a far side they never spoke to.
 *
 * team-layer's own root is the fixture, because it is guaranteed to exist and guaranteed not to be
 * a spec-suite. That also makes this the assertion that an exported variable beats the sibling
 * search: on a machine with a real sibling checkout, honouring the bad variable is the only way to
 * reach a skip, and quietly testing the neighbour instead would report success about the wrong
 * install.
 */
test('a root that is not a spec-suite is skipped, with the variable named', () => {
  const skips = [];
  const answer = requireSpecSuite({ skip: (reason) => skips.push(reason) }, { [SPEC_SUITE_ENV]: ROOT });
  assert.equal(answer, null, 'team-layer is not a spec-suite checkout and must not be offered as one');
  assert.equal(skips.length, 1, 'a missing far side must be recorded as skipped, never passed silently');
  assert.match(skips[0], new RegExp(SPEC_SUITE_ENV), 'the skip must say which variable to set');
});

test('findSpecSuite refuses a named root rather than falling back to a sibling', () => {
  const found = findSpecSuite({ [SPEC_SUITE_ENV]: ROOT });
  assert.equal(found.root, null);
  assert.match(found.reason, /merge-gate\.mjs/, 'the reason must name what was missing');
  // And a real checkout is reported with its source, so a reader can tell which one was tested.
  const real = findSpecSuite({});
  if (real.root) assert.ok(['sibling', SPEC_SUITE_ENV].includes(real.source));
});

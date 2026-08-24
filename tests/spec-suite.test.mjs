import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  SPEC_SUITE_CAPABILITIES, ASSUMED_PROJECTABLE_FIELDS, TEAM_LAYER_ONLY_FIELDS,
  detectCapabilities, probeCapabilities, projectSpecTask,
} from '../src/spec-suite.mjs';
import { requireSpecSuite } from './helpers/cross-repo.mjs';

/**
 * A stand-in spec-suite, because the interesting cases are ones no real install is in.
 *
 * The probe's contract with the far side is narrow and stated: a module that exports
 * `projectionConcurrencyFields(task)` returning the keys it keeps. Building installs that
 * honour that contract in different ways — keeping `inputs`, dropping it, throwing, missing
 * entirely — is the only way to test the branches that matter, since the real checkout can
 * only ever be in one of them. `spec-suite-real` below is what keeps this honest.
 */
function install({ keeps = ['baseRevision', 'readSet', 'writeSet', 'subject', 'role'],
  scripts = ['merge-gate.mjs', 'orchestrate.mjs'], concurrency = true, throws = false,
  capabilities = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-spec-suite-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of scripts) fs.writeFileSync(path.join(root, 'scripts', name), '// present\n');
  if (concurrency) {
    fs.writeFileSync(path.join(root, 'scripts', 'control-plane-concurrency.mjs'),
      throws
        ? 'export function projectionConcurrencyFields() { throw new Error("task.baseRevision is required"); }\n'
        : 'export function projectionConcurrencyFields(task) {\n'
          + `  const keeps = ${JSON.stringify(keeps)};\n`
          + '  const out = {};\n'
          + '  for (const k of keeps) out[k] = task[k];\n'
          + '  return out;\n}\n');
  }
  if (capabilities) {
    fs.writeFileSync(path.join(root, 'scripts', 'capabilities.mjs'), capabilities);
  }
  return root;
}

function packet(overrides = {}) {
  return {
    schemaVersion: 2,
    taskId: 'task:coupon',
    sessionId: 'session:autumn',
    subject: 'agent:fullstack-01',
    role: 'fullstack',
    baseRevision: `git:${'a'.repeat(40)}`,
    readSet: ['src/**'],
    writeSet: ['src/coupon.ts'],
    inputs: [{ id: 'contract:checkout', revision: `sha256:${'c'.repeat(64)}`, authority: 'spec-suite' }],
    acceptance: ['a coupon over the cap is refused'],
    validationPlan: [{ checkId: 'unit-tests', kind: 'command', requiredAt: ['merge'], argv: ['node', '--test', 'tests/'] }],
    ...overrides,
  };
}

const withheldFor = (result, field) => result.withheld.find((w) => w.field === field);

// ------------------------------------------------------------------ detection

/**
 * "I could not look" and "it is not there" are different answers.
 *
 * The failure this prevents is the tempting one: no spec-suite found, so report everything
 * unsupported, so the projection confidently withholds. That is a guess dressed as a fact,
 * and it reads identically to a real answer. `unavailable` plus five `unknown`s says what
 * actually happened.
 */
test('an install nobody can find yields unknown, not unsupported', () => {
  for (const [name, root] of [
    ['no root at all', undefined],
    ['an empty root', ''],
    ['a root that does not exist', path.join(os.tmpdir(), 'no-spec-suite-here-xyz')],
  ]) {
    const detection = detectCapabilities({ root });
    assert.equal(detection.source, 'unavailable', name);
    for (const capability of SPEC_SUITE_CAPABILITIES) {
      assert.equal(detection.capabilities[capability].support, 'unknown', `${name}: ${capability}`);
    }
    assert.equal(detection.projectableFields.discovered, false);
    assert.deepEqual(detection.projectableFields.fields, ASSUMED_PROJECTABLE_FIELDS);
    assert.ok(detection.notes.length >= 1, 'silence is not an answer');
  }
});

/**
 * The probe may only claim `supported` for what it ran.
 *
 * `mergeGate` sits in a file the probe can see and cannot exercise without a repository, a
 * candidate and a merge — so it reads `unknown` with the file named as evidence. Calling it
 * supported because the filename matches would be the docs-reading the handshake exists to
 * replace, one indirection down.
 */
test('a probe reports what it exercised, and admits the rest', () => {
  const detection = probeCapabilities(install());
  assert.equal(detection.source, 'probed');
  assert.equal(detection.capabilities.multiAgentConcurrency.support, 'supported');
  assert.match(detection.capabilities.multiAgentConcurrency.evidence, /projected a concurrency task/);
  for (const unexercised of ['mergeGate', 'structuralRevalidation', 'semanticValidator']) {
    assert.equal(detection.capabilities[unexercised].support, 'unknown', unexercised);
    assert.match(detection.capabilities[unexercised].evidence, /present, but a probe cannot exercise/);
  }
  // No handshake means no versions, and a version invented here would be worse than none.
  for (const capability of SPEC_SUITE_CAPABILITIES) {
    assert.equal(detection.capabilities[capability].version, null, capability);
  }
  assert.ok(detection.notes.some((n) => /probed, not declared/.test(n)));
});

test('a module that is absent is unsupported, which is a fact rather than a guess', () => {
  const detection = probeCapabilities(install({ scripts: [] }));
  assert.equal(detection.capabilities.mergeGate.support, 'unsupported');
  assert.match(detection.capabilities.mergeGate.evidence, /scripts\/merge-gate\.mjs does not exist/);
  assert.equal(detection.capabilities.structuralRevalidation.support, 'unsupported');
});

/**
 * Which absences are findings, and which are only blindness.
 *
 * For four of the five, the module *is* the mechanism, so its absence settles the question.
 * `semanticInputs` is a property of the task contract and the concurrency module is only the
 * instrument that reveals it — so losing the instrument leaves the question unanswered, not
 * answered no. The two read the same to a projection (both withhold) and differently to a
 * human: one says spec-suite will not carry your contract revisions, the other says nobody
 * checked, and only the second is fixed by pointing the probe somewhere real.
 */
test('a capability the instrument was needed for goes unknown when the instrument is gone', () => {
  const detection = probeCapabilities(install({ concurrency: false }));
  assert.equal(detection.capabilities.multiAgentConcurrency.support, 'unsupported',
    'the concurrency module is the concurrency capability');
  assert.equal(detection.capabilities.semanticInputs.support, 'unknown');
  assert.match(detection.capabilities.semanticInputs.evidence, /never established/);
});

/**
 * The one capability a probe can settle both ways, settled by experiment.
 *
 * This is the whole reason the probe exercises the far side instead of grepping it: the
 * far side accepts unknown fields silently, so `inputs` reaching a validator proves nothing
 * about whether anything keeps it. Which keys come back does.
 */
test('semantic inputs are supported or not according to what survives the far side', () => {
  const without = probeCapabilities(install());
  assert.equal(without.capabilities.semanticInputs.support, 'unsupported');
  assert.match(without.capabilities.semanticInputs.evidence, /drops inputs/);
  assert.equal(without.projectableFields.discovered, true);
  assert.equal(without.projectableFields.fields.includes('inputs'), false);

  const with_ = probeCapabilities(install({
    keeps: ['baseRevision', 'readSet', 'writeSet', 'subject', 'role', 'inputs'],
  }));
  assert.equal(with_.capabilities.semanticInputs.support, 'supported');
  assert.ok(with_.projectableFields.fields.includes('inputs'));
});

test('a far side that cannot be exercised falls back to an assumed list, and says so', () => {
  for (const [name, root] of [
    ['the module throws', install({ throws: true })],
    ['the module is missing', install({ concurrency: false })],
  ]) {
    const detection = probeCapabilities(root);
    assert.equal(detection.projectableFields.discovered, false, name);
    assert.deepEqual(detection.projectableFields.fields, ASSUMED_PROJECTABLE_FIELDS, name);
    assert.ok(detection.notes.some((n) => /assumed rather than discovered/.test(n)), name);
    // Nothing was demonstrated, so nothing may be claimed either way.
    assert.notEqual(detection.capabilities.semanticInputs.support, 'supported', name);
  }
});

/** The handshake, once spec-suite ships one (plan §8), supersedes every probe. */
test('a declared handshake is trusted whole, versions included', () => {
  const root = install({
    capabilities: 'process.stdout.write(JSON.stringify({ schemaVersion: 1, protocolVersion: 3,'
      + ' features: { multiAgentConcurrency: 1, semanticInputs: 1, mergeGate: 2,'
      + ' structuralRevalidation: 1, semanticValidator: 1, timeTravel: 9 } }));\n',
  });
  const detection = detectCapabilities({ root });
  assert.equal(detection.source, 'declared');
  assert.equal(detection.protocolVersion, 3);
  assert.deepEqual(detection.capabilities.mergeGate, {
    support: 'supported', version: 2, evidence: 'declared by scripts/capabilities.mjs',
  });
  // Declared support beats a probe's inability to exercise it: the far side is the authority
  // on itself, and the probe's `unknown` was only ever a statement about the probe.
  assert.equal(detection.capabilities.semanticValidator.support, 'supported');
  assert.ok(detection.notes.some((n) => /does not know about: timeTravel/.test(n)),
    'a capability this skill has never heard of is worth saying out loud, not silently ignoring');
});

test('a handshake that omits a capability leaves it unknown rather than unsupported', () => {
  const root = install({
    capabilities: 'process.stdout.write(JSON.stringify({ protocolVersion: 3, features: { mergeGate: 2 } }));\n',
  });
  const detection = detectCapabilities({ root });
  assert.equal(detection.capabilities.mergeGate.support, 'supported');
  // An older handshake has no way to say "definitely not", so absence cannot mean absence.
  assert.equal(detection.capabilities.semanticInputs.support, 'unknown');
  assert.match(detection.capabilities.semanticInputs.evidence, /does not mention it/);
});

/**
 * A broken handshake must not read as "no capabilities".
 *
 * Exit 1 from `capabilities.mjs` is the shape of a crash, and a caller that took it as an
 * answer would degrade everything to unsupported on the strength of a bug in one script.
 * Falling back to the probe recovers the facts that are still establishable.
 */
test('a handshake that is present and broken falls back to probing, loudly', () => {
  for (const [name, script, expected] of [
    ['it crashes', 'process.exit(1);\n', /did not answer \(exit 1\)/],
    ['it emits prose', 'process.stdout.write("all good!");\n', /did not emit JSON/],
  ]) {
    const detection = detectCapabilities({ root: install({ capabilities: script }) });
    assert.equal(detection.source, 'probed', name);
    assert.match(detection.notes[0], expected, name);
    // The probe still learned what it could.
    assert.equal(detection.capabilities.multiAgentConcurrency.support, 'supported', name);
  }
});

// ----------------------------------------------------------------- projection

test('only whitelisted fields travel, and everything else is accounted for', () => {
  const detection = probeCapabilities(install());
  const result = projectSpecTask(packet(), detection);
  assert.deepEqual(result.projected,
    ['baseRevision', 'readSet', 'role', 'subject', 'taskId', 'writeSet']);
  // The artifact is the projected fields plus what it declares on spec-suite's authority.
  assert.deepEqual(Object.keys(result.projection).sort(),
    [...result.projected, 'schemaVersion'].sort());
  assert.equal(result.projection.schemaVersion, 1);
  // Every packet field is either projected or explained. Nothing may simply vanish.
  const accounted = new Set([...result.projected, ...result.withheld.map((w) => w.field)]);
  assert.deepEqual([...accounted].sort(), Object.keys(packet()).sort());
  for (const field of TEAM_LAYER_ONLY_FIELDS) {
    assert.equal(withheldFor(result, field).reason, 'team-layer-owned', field);
  }
});

/**
 * The two `schemaVersion` fields are not the same field.
 *
 * They are the `stale-base` problem in miniature: one name, two meanings, on opposite sides of a
 * boundary. Projecting the packet's number verbatim would hand spec-suite a version of a schema
 * it has never seen and its document policy would reject anything but `1`; withholding it without
 * substituting would produce an artifact its projection path rejects for a missing field. So the
 * artifact declares spec-suite's constant and the report says the packet's stayed home — which
 * has to remain true when this layer's own packet version moves.
 */
test('the artifact declares spec-suite\'s schemaVersion, not this layer\'s', () => {
  const detection = probeCapabilities(install());
  const result = projectSpecTask(packet({ schemaVersion: 7 }), detection);
  assert.equal(result.projection.schemaVersion, 1);
  assert.equal(result.projected.includes('schemaVersion'), false);
  assert.match(withheldFor(result, 'schemaVersion').detail, /count different schemas/);
});

/**
 * The field spec-suite requires travels even when the discovery experiment never mentions it.
 *
 * This is the bug the list exists for. `projectionConcurrencyFields` answers a question about
 * scheduling keys, so it is silent about `taskId` — and reading that silence as a refusal
 * produced a task artifact `evaluateMergeGate` rejected before resolving a single commit, with a
 * message about a missing field rather than anything to do with the candidate. A capability the
 * far side does not have is a negotiation; a field it requires is not.
 */
test('a required field travels regardless of what the whitelist discovered', () => {
  const detection = probeCapabilities(install());
  // The narrowest whitelist there is: the far side kept nothing at all.
  detection.projectableFields = { fields: [], discovered: true };
  const result = projectSpecTask(packet(), detection);
  assert.equal(result.projection.taskId, packet().taskId);
  assert.deepEqual(result.projected, ['taskId']);
  assert.equal(withheldFor(result, 'baseRevision').reason, 'not-projectable');
});

test('a packet with no taskId cannot be projected at all', () => {
  const detection = probeCapabilities(install());
  const incomplete = packet();
  delete incomplete.taskId;
  assert.throws(() => projectSpecTask(incomplete, detection),
    { name: 'TypeError', message: /must carry taskId/ });
});

/**
 * The failure this prevents cannot be observed from the far side.
 *
 * spec-suite's task validator accepts fields it has never heard of without complaint. So a
 * projection built by copying the packet and deleting the known-unwanted keys would ship
 * every field this layer adds later straight into a validator that swallows it, and the
 * first symptom would be a gate silently reading nothing. A whitelist is the only version
 * of this that stays correct when the team packet grows.
 */
test('a field the team packet gains later is not injected into spec-suite', () => {
  const detection = probeCapabilities(install());
  const result = projectSpecTask(packet({ blastRadius: 'large', reviewer: 'agent:reviewer-01' }), detection);
  assert.equal('blastRadius' in result.projection, false);
  assert.equal('reviewer' in result.projection, false);
  assert.equal(withheldFor(result, 'blastRadius').reason, 'not-projectable');
  assert.match(withheldFor(result, 'blastRadius').detail, /does not carry blastRadius/);
});

/**
 * §17 Scenario 2's accepted cost, stated by the tool rather than remembered.
 *
 * With `semanticInputs` unsupported, contract staleness is enforced in the team layer and
 * nowhere else. An Agent who is not told that will believe the merge gate is watching the
 * contract revision its work depends on. `degraded` plus a warning naming the capability is
 * the difference between a documented compatibility mode and a silent one.
 */
test('a capability that cannot carry a field degrades the run and names why', () => {
  const detection = probeCapabilities(install());
  const result = projectSpecTask(packet(), detection);
  assert.equal(result.compatibility.mode, 'degraded');
  assert.deepEqual(withheldFor(result, 'inputs'), {
    field: 'inputs',
    reason: 'capability-unsupported',
    capability: 'semanticInputs',
    detail: 'the concurrency projection drops inputs, so semantic inputs stay in the team layer',
    authority: 'team-layer',
  });
  assert.ok(result.compatibility.warnings.some((w) => /only enforced here/.test(w)));

  // Unknown withholds too — the point of three values is that only demonstrated support
  // lets a field travel, so a field cannot ride out on an unestablished capability.
  const unknown = probeCapabilities(install({ concurrency: false }));
  const cautious = projectSpecTask(packet(), unknown);
  assert.equal(cautious.compatibility.mode, 'degraded');
  assert.equal(withheldFor(cautious, 'inputs').reason, 'capability-unknown');
  assert.equal('inputs' in cautious.projection, false);
});

/**
 * A key surviving the far side is not the same as the far side supporting the feature.
 *
 * Reachable, and the most tempting place to be lenient: spec-suite declares a handshake that
 * says nothing about `semanticInputs`, while its concurrency projection keeps `inputs` anyway.
 * The keys say yes, the handshake says nothing, and "the field is in the whitelist, ship it"
 * would let it travel. It must not. A projection helper that copies keys through proves the
 * field is *carried*, not that anything downstream reads it — which is the silent-acceptance
 * trap in a new costume. Only the far side's own claim settles a capability, and its silence
 * is not a claim.
 */
test('a field does not travel on a capability the handshake declined to claim', () => {
  const root = install({
    keeps: ['baseRevision', 'readSet', 'writeSet', 'subject', 'role', 'inputs'],
    capabilities: 'process.stdout.write(JSON.stringify({ protocolVersion: 3,'
      + ' features: { multiAgentConcurrency: 1, mergeGate: 2 } }));\n',
  });
  const detection = detectCapabilities({ root });
  assert.equal(detection.source, 'declared');
  assert.equal(detection.capabilities.semanticInputs.support, 'unknown');
  assert.ok(detection.projectableFields.fields.includes('inputs'),
    'the far side does keep the key: that is exactly what makes this the interesting case');

  const result = projectSpecTask(packet(), detection);
  assert.equal('inputs' in result.projection, false);
  assert.equal(withheldFor(result, 'inputs').reason, 'capability-unknown');
  assert.equal(result.compatibility.mode, 'degraded');
});

test('a far side that carries semantic inputs gets them, at full compatibility', () => {
  const detection = probeCapabilities(install({
    keeps: ['baseRevision', 'readSet', 'writeSet', 'subject', 'role', 'inputs'],
  }));
  const result = projectSpecTask(packet(), detection);
  assert.deepEqual(result.projection.inputs, packet().inputs);
  assert.equal(result.compatibility.mode, 'full');
  assert.equal(withheldFor(result, 'inputs'), undefined);
  assert.equal(result.compatibility.warnings.some((w) => /only enforced here/.test(w)), false);
});

test('an assumed field list is a warning, because a stale whitelist drops real fields', () => {
  const result = projectSpecTask(packet(), probeCapabilities(install({ concurrency: false })));
  assert.equal(result.compatibility.fieldsDiscovered, false);
  assert.ok(result.compatibility.warnings.some((w) => /assumed, not discovered/.test(w)));
});

/**
 * A deterministic id for the artifact (plan §9), over the projection alone.
 *
 * Not over the compatibility report: notes carry absolute paths and probe evidence, so a
 * digest covering them would change when the *reporting* changed and stop being usable for
 * "have I already handed this over".
 */
test('the same packet and capabilities yield the same projection digest', () => {
  const detection = probeCapabilities(install());
  const first = projectSpecTask(packet(), detection);
  assert.match(first.projectionDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(projectSpecTask(packet(), probeCapabilities(install())).projectionDigest,
    first.projectionDigest, 'a second, differently-located install must not change the artifact id');
  assert.notEqual(projectSpecTask(packet({ writeSet: ['src/other.ts'] }), detection).projectionDigest,
    first.projectionDigest);
  // Key order in the source packet is not substance.
  const reordered = Object.fromEntries(Object.entries(packet()).reverse());
  assert.equal(projectSpecTask(reordered, detection).projectionDigest, first.projectionDigest);
  // But which fields travelled is: the same packet projected under richer capabilities is a
  // different artifact, and giving both one id would make the degraded one look complete.
  const richer = probeCapabilities(install({
    keeps: ['baseRevision', 'readSet', 'writeSet', 'subject', 'role', 'inputs'],
  }));
  assert.notEqual(projectSpecTask(packet(), richer).projectionDigest, first.projectionDigest);
});

test('a packet that is not an object is a programming error, not a projection', () => {
  const detection = probeCapabilities(install());
  for (const bad of [null, undefined, 'task.json', ['task']]) {
    assert.throws(() => projectSpecTask(bad, detection), TypeError);
  }
});

/**
 * The synthetic installs above encode what this skill believes about spec-suite. Pointed at
 * a real checkout, this asserts the belief is still true — the probe reaching the wrong
 * conclusion about a real install is the only failure that matters, and no fake can catch it.
 *
 * The gate is `requireSpecSuite` rather than a bare `return`, which is what this test used to do:
 * node's runner counts a returning test as a pass, so on every machine without a checkout — which
 * is most of them — this reported the belief as verified without having looked.
 */
test('spec-suite-real: a real checkout answers the probe coherently', (t) => {
  const root = requireSpecSuite(t);
  if (!root) return;
  const detection = detectCapabilities({ root });
  assert.notEqual(detection.source, 'unavailable', `${root} does not look like a spec-suite checkout`);
  assert.equal(detection.projectableFields.discovered, true,
    'a real checkout must be exercisable; if this fails, the probe contract has drifted');
  for (const required of ['baseRevision', 'readSet', 'writeSet']) {
    assert.ok(detection.projectableFields.fields.includes(required),
      `a real concurrency contract must carry ${required}`);
  }
  const result = projectSpecTask(packet(), detection);
  assert.equal(result.projection.writeSet.length, 1);
  assert.equal('validationPlan' in result.projection, false, 'the team layer must not leak into spec-suite');
  /**
   * And the field a real gate requires is really in there.
   *
   * The probe cannot discover this one — it asks about scheduling — so against a real install this
   * is the assertion that the unconditional class is doing its job.
   */
  assert.equal(result.projection.taskId, packet().taskId);
  assert.equal(result.projection.schemaVersion, 1);
});

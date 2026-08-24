#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import {
  SPEC_SUITE_CAPABILITIES, CAPABILITY_SUPPORT, ASSUMED_PROJECTABLE_FIELDS, TEAM_LAYER_ONLY_FIELDS,
  FIELD_CAPABILITY, detectCapabilities, probeCapabilities,
} from '../src/spec-suite.mjs';
import { NEXT_ACTIONS, RECONCILE_STATUSES } from '../src/reconcile.mjs';
import { METRIC_SOURCES, DERIVED_METRICS, UNAVAILABLE_METRICS } from '../src/metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const ok = (condition, message) => { if (!condition) failures.push(message); };
const text = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const required = [
  'SKILL.md', 'README.md', 'VERSION',
  'roles/product-architect.md', 'roles/fullstack.md', 'roles/reviewer.md',
  'protocol/core.md', 'protocol/identity.md', 'protocol/recovery.md',
  'protocol/collaboration.md', 'protocol/review.md', 'protocol/spec-suite.md',
  'adapters/claude-code.md', 'adapters/codex.md', 'adapters/gemini-cli.md', 'adapters/generic.md',
  'schemas/identity.schema.json', 'schemas/task-packet.schema.json', 'schemas/finding.schema.json',
  'schemas/session.schema.json', 'schemas/task-record.schema.json', 'schemas/timestamp.schema.json',
  'schemas/id.schema.json', 'schemas/role.schema.json',
  'schemas/revision.schema.json', 'schemas/digest.schema.json', 'schemas/git-revision.schema.json',
  'schemas/session-status.schema.json', 'schemas/task-status.schema.json',
  'schemas/handoff.schema.json', 'schemas/handoff-action.schema.json',
  'schemas/review-decision.schema.json', 'schemas/review-status.schema.json',
  'schemas/finding-severity.schema.json', 'schemas/finding-status.schema.json',
  'schemas/validation-check.schema.json', 'schemas/validation-evidence.schema.json',
  'schemas/validation-kind.schema.json', 'schemas/validation-gate.schema.json',
  'schemas/evidence-status.schema.json',
  'templates/handoff.md', 'templates/handoff.json', 'templates/task-packet.json', 'templates/finding.json',
  'templates/review-decision.json',
  'scripts/teamctl.mjs', 'src/ledger.mjs', 'src/slug.mjs', 'src/digest.mjs', 'src/schema.mjs',
  'src/validation.mjs', 'src/spec-suite.mjs', 'src/reconcile.mjs', 'src/metrics.mjs'
];
for (const file of required) ok(fs.existsSync(path.join(ROOT, file)), `missing ${file}`);

/**
 * Generated schemas must say so, and hand-written ones must not restate them.
 *
 * The failure this prevents is drift, not absence: a hand-written schema that
 * inlines the id regex or the role list keeps validating happily while the
 * generator's copy moves on, and the two only disagree once some input is legal
 * to one and rejected by the other. Referencing is the only way to stay honest,
 * so an inlined copy is treated as a defect even when it is currently correct.
 */
const GENERATED = {
  'schemas/id.schema.json': 'src/slug.mjs ID_PATTERN',
  'schemas/role.schema.json': 'roles/registry.json',
  'schemas/revision.schema.json': 'src/digest.mjs REVISION_PATTERN',
  'schemas/digest.schema.json': 'src/digest.mjs DIGEST_PATTERN',
  'schemas/git-revision.schema.json': 'src/digest.mjs GIT_REVISION_PATTERN',
  'schemas/session-status.schema.json': 'src/ledger.mjs SESSION_STATUSES',
  'schemas/task-status.schema.json': 'src/ledger.mjs TASK_STATUSES',
  'schemas/handoff-action.schema.json': 'src/ledger.mjs HANDOFF_ACTIONS',
  'schemas/review-status.schema.json': 'src/ledger.mjs REVIEW_STATUSES',
  'schemas/finding-severity.schema.json': 'src/ledger.mjs FINDING_SEVERITIES',
  'schemas/finding-status.schema.json': 'src/ledger.mjs FINDING_STATUSES',
  'schemas/validation-kind.schema.json': 'src/validation.mjs VALIDATION_KINDS',
  'schemas/validation-gate.schema.json': 'src/validation.mjs VALIDATION_GATES',
  'schemas/evidence-status.schema.json': 'src/validation.mjs EVIDENCE_STATUSES',
};
for (const [file, source] of Object.entries(GENERATED)) {
  if (!fs.existsSync(path.join(ROOT, file))) continue;
  const marker = JSON.parse(text(file))['x-generated-from'];
  ok(typeof marker === 'string' && marker.startsWith(source),
    `${file} must carry x-generated-from starting with "${source}", got ${JSON.stringify(marker)}`);
}

const HAND_WRITTEN = ['schemas/identity.schema.json', 'schemas/task-packet.schema.json',
  'schemas/finding.schema.json', 'schemas/session.schema.json', 'schemas/task-record.schema.json',
  'schemas/handoff.schema.json', 'schemas/review-decision.schema.json',
  'schemas/validation-check.schema.json', 'schemas/validation-evidence.schema.json'];
for (const file of HAND_WRITTEN) {
  if (!fs.existsSync(path.join(ROOT, file))) continue;
  const body = text(file);
  ok(!body.includes('x-generated-from'), `${file} is hand-written but claims to be generated`);
  ok(!/\[a-z\]\[a-z0-9-\]\*:/.test(body), `${file} inlines the id pattern; $ref id.schema.json instead`);
  ok(!/"sha256:\?\|git:"|\bsha256\|git\b/.test(body), `${file} inlines the revision pattern; $ref revision.schema.json instead`);
  ok(!/"product-architect"/.test(body), `${file} inlines the role list; $ref role.schema.json instead`);
}

const skill = text('SKILL.md');
ok(/^name:\s*persistent-agent-team$/m.test(skill), 'SKILL.md name mismatch');
ok(/Identity must not depend on harness\./.test(skill), 'missing harness-neutral identity invariant');
ok(/Project truth must not depend on conversation\./.test(skill), 'missing volatile-context invariant');
ok(/Do not load the other two role manuals/.test(skill), 'missing minimal-role-context rule');
ok(/spec-suite merge gate/.test(skill), 'missing spec-suite integration gate');

for (const role of ['product-architect', 'fullstack', 'reviewer']) {
  const body = text(`roles/${role}.md`);
  ok(new RegExp(`^role:\\s*${role}$`, 'm').test(body), `${role} frontmatter role mismatch`);
  ok(/^version:\s*\d+\.\d+\.\d+$/m.test(body), `${role} missing semver version`);
  ok(body.length < 14000, `${role} role manual is too large (${body.length} chars)`);
}

const identitySchema = JSON.parse(text('schemas/identity.schema.json'));
const identityProps = Object.keys(identitySchema.properties || {});
for (const forbidden of ['harness', 'model', 'taskId', 'worktreeRoot', 'branch']) {
  ok(!identityProps.includes(forbidden), `identity schema must not contain ${forbidden}`);
}

const taskSchema = JSON.parse(text('schemas/task-packet.schema.json'));
for (const requiredField of ['baseRevision', 'readSet', 'writeSet', 'inputs', 'acceptance', 'validationPlan']) {
  ok(taskSchema.required.includes(requiredField), `task packet must require ${requiredField}`);
}
/**
 * v1's `validation: string[]` may not come back alongside the plan (plan §6).
 *
 * A list of command strings is a reminder, not a protocol: nothing can run it, no gate
 * can consult it, and staleness cannot be derived from it. Tolerating both would leave
 * two answers to "how is this shown to be done", and whichever one a reader believes,
 * half the toolchain is reading the other. The ledger refuses the field by name; this
 * keeps the schema from quietly re-opening the door.
 */
ok(!Object.keys(taskSchema.properties || {}).includes('validation'),
  'task packet must not declare `validation`: it was replaced by validationPlan in schemaVersion 2');
ok(taskSchema.properties.validationPlan?.items?.$ref === 'validation-check.schema.json',
  'validationPlan items must $ref validation-check.schema.json rather than inlining the check shape');

/**
 * The frozen/state split has to survive editing, because everything downstream
 * assumes it. `frozenDigest` is a function of the packet alone, so `generation`
 * and `status` must live outside `frozen` — put either one inside it and
 * restating a task with identical content would produce a different digest,
 * which destroys the only cheap way to tell a real change from a no-op.
 *
 * `frozen` is checked to be a bare `$ref` rather than merely lacking those
 * fields. An inline copy of the packet shape would satisfy any field-level
 * assertion on the day it was written and then drift, and the drift would show
 * up as a task that the ledger accepts but the record schema rejects.
 */
const recordSchema = JSON.parse(text('schemas/task-record.schema.json'));
for (const half of ['frozen', 'state']) {
  ok(recordSchema.required.includes(half), `task record must require ${half}`);
}
ok(recordSchema.properties.frozen?.$ref === 'task-packet.schema.json',
  'task record frozen half must be a bare $ref to task-packet.schema.json, not an inline copy');
ok(recordSchema.properties.frozenDigest?.$ref === 'digest.schema.json',
  'task record frozenDigest must $ref digest.schema.json');

// The frozen half is the packet, so this is where the mutable fields must be
// absent. `additionalProperties: false` is what makes the absence load-bearing:
// without it a caller could smuggle `generation` past the schema into the digest.
ok(taskSchema.additionalProperties === false, 'task packet must be closed (additionalProperties: false)');
const packetProps = Object.keys(taskSchema.properties || {});
ok(packetProps.length > 0, 'task packet declares no properties');
for (const mutable of ['generation', 'status', 'updatedAt', 'revision']) {
  ok(!packetProps.includes(mutable), `task packet is the frozen half and must not declare ${mutable}`);
}

const stateProps = Object.keys(recordSchema.properties.state?.properties || {});
ok(stateProps.includes('generation'), 'task record state half must carry generation');
ok(stateProps.includes('status'), 'task record state half must carry status');

/**
 * "A handoff is state transfer, not a transcript dump" (plan §4), made mechanical.
 *
 * Length caps are the whole enforcement. A prose field with no upper bound will
 * eventually receive a pasted conversation, and once it does the recipient is back
 * to reconstructing state by reading — which is the failure the artifact exists to
 * prevent. So an uncapped string in the statement half is treated as a defect even
 * though nothing is currently over-long.
 *
 * The digest split is checked for the same reason it is on task records: putting
 * `publishedAt` inside `handoff` would make every republication of identical state
 * produce a new digest, and detecting "you already told me this" is the only cheap
 * defence against a handoff loop.
 */
const handoffSchema = JSON.parse(text('schemas/handoff.schema.json'));
const statement = handoffSchema.properties.handoff;
ok(handoffSchema.additionalProperties === false, 'handoff record must be closed');
ok(statement?.additionalProperties === false, 'the handoff statement must be closed');
ok(handoffSchema.properties.handoffDigest?.$ref === 'digest.schema.json',
  'handoffDigest must $ref digest.schema.json');
for (const circumstance of ['handoffId', 'seq', 'publishedAt', 'publishedBy', 'handoffDigest']) {
  ok(!Object.keys(statement?.properties ?? {}).includes(circumstance),
    `${circumstance} is circumstance, not statement; it must sit outside the digested half`);
}
for (const field of ['taskId', 'inputSnapshotDigest', 'nextAction', 'summary', 'unresolved']) {
  ok(statement?.required?.includes(field), `a handoff must require ${field}`);
}
ok(statement.properties.nextAction?.$ref === 'handoff-action.schema.json',
  'nextAction must $ref the generated action enum rather than inlining one');
for (const [name, node] of [
  ['summary', statement.properties.summary],
  ['unresolved item', statement.properties.unresolved?.items],
  ['evidence detail', statement.properties.evidence?.items?.properties?.detail],
  ['evidence result', statement.properties.evidence?.items?.properties?.result],
]) {
  ok(typeof node?.maxLength === 'number', `handoff ${name} must be length-capped: state transfer, not transcript`);
}

JSON.parse(text('templates/handoff.json'));

/**
 * An approval binds three things, and all three have to be structurally required
 * (plan §5). The interesting assertion is the absence: nothing in this schema may
 * record whether a decision is still current.
 *
 * A `stale` field would be a fact with an expiry date. It is true when written and
 * silently wrong the moment the candidate moves, because the thing that moved is a
 * git commit and it has no way to reach back into a JSON file and correct it. Every
 * later reader then trusts a flag that says "fresh" about work nobody approved.
 * Applicability is therefore derived on read (`reviewStateFor`), and the way to keep
 * it derived is to leave nowhere to store it.
 *
 * The digest split is checked for the reason it is on handoffs, with one addition:
 * `seq` sits outside the statement, so recording the same judgement twice yields the
 * same digest and reads as a duplicate rather than as two independent approvals.
 */
const reviewSchema = JSON.parse(text('schemas/review-decision.schema.json'));
const decision = reviewSchema.properties.decision;
ok(reviewSchema.additionalProperties === false, 'review record must be closed');
ok(decision?.additionalProperties === false, 'the review decision must be closed');
ok(reviewSchema.properties.decisionDigest?.$ref === 'digest.schema.json',
  'decisionDigest must $ref digest.schema.json');
for (const circumstance of ['reviewId', 'seq', 'recordedAt', 'recordedBy', 'decisionDigest']) {
  ok(!Object.keys(decision?.properties ?? {}).includes(circumstance),
    `${circumstance} is circumstance, not judgement; it must sit outside the digested half`);
}
for (const field of ['taskId', 'reviewer', 'candidateRevision', 'inputSnapshotDigest', 'status',
  'findings', 'summary']) {
  ok(decision?.required?.includes(field), `a review decision must require ${field}`);
}
for (const derived of ['stale', 'applies', 'current', 'isCurrent']) {
  ok(!JSON.stringify(reviewSchema).includes(`"${derived}"`),
    `review decisions must not store ${derived}: applicability is derived on read, and a stored copy stops being true the moment the candidate moves`);
}
ok(decision.properties.status?.$ref === 'review-status.schema.json',
  'review status must $ref the generated enum rather than inlining one');
ok(decision.properties.findings?.items?.$ref === 'finding.schema.json',
  'review findings must $ref finding.schema.json');
/**
 * A citation the ledger cannot follow must not validate.
 *
 * `recordReview` resolves every entry against this session, this task and this same
 * candidate, and refuses a repeat. A schema that accepted any non-empty string would
 * declare `"ran the tests"` a legal citation, and the interchange contract would then
 * be looser than the thing enforcing it — so the shape is a defect at the point where
 * the wire format is agreed, not at the point where one implementation happens to be
 * strict.
 */
ok(decision.properties.validationEvidence?.items?.$ref === 'id.schema.json',
  'validationEvidence must $ref id.schema.json: the ledger resolves these, so prose must not validate');
ok(decision.properties.validationEvidence?.uniqueItems === true,
  'validationEvidence must be uniqueItems: one run cited twice would read as two');
// Any revision scheme, not git only: plan §13 wants to name the candidate by a
// digest of its work product so a rebase that changes no substance stops throwing
// the review away, and pinning git here would make that a schema version bump.
ok(decision.properties.candidateRevision?.$ref === 'revision.schema.json',
  'candidateRevision must $ref revision.schema.json so the naming scheme can change without a version bump');
ok(typeof decision.properties.summary?.maxLength === 'number',
  'review summary must be length-capped: a decision, not the deliberation');

/**
 * The finding vocabularies must be references, not copies.
 *
 * `recordReview` refuses to approve over an unresolved blocker by comparing against
 * FINDING_SEVERITIES/FINDING_STATUSES in src/ledger.mjs. If this schema kept its own
 * list, the day someone added a status to the schema alone would be the day findings
 * carrying it validated fine and then passed straight through every consistency
 * check, because the ledger would not recognise the value as outstanding.
 */
const findingSchema = JSON.parse(text('schemas/finding.schema.json'));
ok(findingSchema.properties.severity?.$ref === 'finding-severity.schema.json',
  'finding severity must $ref the generated enum, not inline one');
ok(findingSchema.properties.status?.$ref === 'finding-status.schema.json',
  'finding status must $ref the generated enum, not inline one');
ok(JSON.parse(text('schemas/finding-severity.schema.json')).enum.includes('blocker'),
  'finding severity lacks blocker');
ok(findingSchema.required.includes('evidence') && findingSchema.required.includes('impact'), 'finding must require evidence + impact');

JSON.parse(text('templates/task-packet.json'));
JSON.parse(text('templates/finding.json'));
JSON.parse(text('templates/review-decision.json'));

/**
 * Evidence is an observation, and the seal covers the whole record (plan §6).
 *
 * Deliberately the opposite split from a review's. A review digests only the judgement,
 * so recording the same judgement twice yields one digest and reads as a duplicate. An
 * observation made twice is ordinary — two runs of one suite are two facts — so there is
 * nothing to deduplicate, and the record is sealed entire instead. That matters because a
 * gate reads `status` directly: a field a gate trusts and the digest does not cover is a
 * pass anyone with write access can forge.
 *
 * `outputExcerpt` is capped for the reason handoff prose is: uncapped, it eventually
 * receives a 200k-line suite log, and a record a gate has to read stops being readable.
 */
const evidenceSchema = JSON.parse(text('schemas/validation-evidence.schema.json'));
ok(evidenceSchema.additionalProperties === false, 'evidence record must be closed');
ok(evidenceSchema.properties.recordDigest?.$ref === 'digest.schema.json',
  'recordDigest must $ref digest.schema.json');
for (const sealed of ['seq', 'evidenceId', 'recordedAt', 'recordedBy', 'status', 'candidateRevision']) {
  ok(evidenceSchema.required.includes(sealed),
    `an evidence record must require ${sealed}: the seal covers the whole record, so every part of it must be there`);
}
ok(evidenceSchema.properties.status?.$ref === 'evidence-status.schema.json',
  'evidence status must $ref the generated enum rather than inlining one');
ok(typeof evidenceSchema.properties.outputExcerpt?.maxLength === 'number',
  'outputExcerpt must be length-capped: evidence a gate reads, not a transcript');
for (const derived of ['stale', 'applies', 'current', 'gate']) {
  ok(!Object.keys(evidenceSchema.properties || {}).includes(derived),
    `evidence must not store ${derived}: a run answers a check, and which gates need that check is the plan's to say`);
}

/**
 * Two closed branches, because src/schema.mjs has no `if/then` and no `not`.
 *
 * "A command check may not name a reviewer" is expressed by there being no branch that
 * allows both — the closure is the enforcement. A single open object with every field
 * optional would validate a check the runner cannot run, inside a packet that is frozen
 * by the time anyone finds out.
 */
const checkSchema = JSON.parse(text('schemas/validation-check.schema.json'));
ok(Array.isArray(checkSchema.oneOf) && checkSchema.oneOf.length === 2,
  'a validation check must be a oneOf over its kinds, since the schema dialect has no if/then');
for (const branch of ['commandCheck', 'reviewCheck']) {
  const def = checkSchema.$defs?.[branch];
  ok(def?.additionalProperties === false, `${branch} must be closed, or the kinds stop being distinguishable`);
  ok(def?.properties?.kind?.const, `${branch} must pin its kind with const`);
}
ok(checkSchema.$defs?.reviewCheck?.properties?.role?.$ref === 'role.schema.json',
  'a review check must $ref role.schema.json rather than inlining the role list');
ok(checkSchema.$defs?.requiredAt?.items?.$ref === 'validation-gate.schema.json',
  'requiredAt items must $ref the generated gate enum rather than inlining one');
ok(checkSchema.$defs?.requiredAt?.minItems === 1,
  'a check must name at least one gate: one that gates nothing is a comment');

/**
 * The far-side contract, held to the two rules it exists to enforce.
 *
 * Both checks are here rather than only in tests/spec-suite.test.mjs because this script is
 * what an installer runs, and both failures are silent in the same direction: a capability
 * that reads `supported` without evidence, or a packet field nobody classified, produces a
 * spec-suite handoff that looks complete and is not.
 */
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-layer-validate-'));
try {
  /**
   * Nothing may be born supported.
   *
   * Pointed at a directory with no spec-suite in it, every answer must be `unsupported` (a
   * module is provably absent) or `unknown` (nothing could be established). A `supported`
   * here would mean some capability defaults to trusted, and since the far side accepts
   * unknown fields without complaint, the field it waves through would be dropped in silence.
   */
  for (const [name, answer] of Object.entries(probeCapabilities(emptyDir).capabilities)) {
    ok(answer.support !== 'supported', `${name} reads supported with no spec-suite present: `
      + 'a capability must be earned by exercising it');
    ok(CAPABILITY_SUPPORT.includes(answer.support), `${name} reports ${answer.support}, which is not one of the three`);
    ok(typeof answer.evidence === 'string' && answer.evidence !== '',
      `${name} must say what its answer rests on`);
  }
  // And an install nobody could look at reads unknown throughout — "I could not look" is not
  // "it is not there", and only one of the two is fixed by correcting a path.
  const blind = detectCapabilities({ root: path.join(emptyDir, 'nope') });
  ok(SPEC_SUITE_CAPABILITIES.every((name) => blind.capabilities[name].support === 'unknown'),
    'an unreachable spec-suite must read unknown, never unsupported');
} finally {
  fs.rmSync(emptyDir, { recursive: true, force: true });
}

/**
 * Every task-packet field is either projected, capability-governed, or this layer's own.
 *
 * The drift this catches is the next commit's, not this one's: a field added to the packet
 * schema and to none of the three lists would be withheld as `not-projectable` — a true
 * statement that nobody decided, and the wrong one for anything spec-suite ought to receive.
 * Failing here forces the choice to be made where it is visible.
 */
const packetFields = Object.keys(JSON.parse(text('schemas/task-packet.schema.json')).properties);
const classified = new Map();
for (const [list, fields] of [
  ['ASSUMED_PROJECTABLE_FIELDS', ASSUMED_PROJECTABLE_FIELDS],
  ['TEAM_LAYER_ONLY_FIELDS', TEAM_LAYER_ONLY_FIELDS],
  ['FIELD_CAPABILITY', Object.keys(FIELD_CAPABILITY)],
]) {
  for (const field of fields) {
    ok(packetFields.includes(field), `${list} names ${field}, which is not a task packet field`);
    ok(!classified.has(field), `${field} is in both ${classified.get(field)} and ${list}`);
    classified.set(field, list);
  }
}
for (const field of packetFields) {
  ok(classified.has(field), `task packet field ${field} is in none of ASSUMED_PROJECTABLE_FIELDS, `
    + 'TEAM_LAYER_ONLY_FIELDS or FIELD_CAPABILITY: decide whether it crosses to spec-suite');
}
for (const capability of Object.values(FIELD_CAPABILITY)) {
  ok(SPEC_SUITE_CAPABILITIES.includes(capability),
    `FIELD_CAPABILITY names ${capability}, which is not a capability this skill detects`);
}

/**
 * A withheld field must be documented as a boundary, not discovered as a silence.
 *
 * Withholding `inputs` moves an enforcement point: staleness against a contract revision stops
 * being checked at the merge gate and is only checked here. That is a defensible trade, and it is
 * only defensible while somebody can read it — an undocumented one is indistinguishable from
 * having forgotten the field, and the far side accepts unknown fields silently, so neither layer
 * would ever complain. So every capability-governed field and the capability that governs it must
 * be named in the protocol doc, along with the mode a caller is expected to branch on.
 */
const specDoc = text('protocol/spec-suite.md');
for (const [field, capability] of Object.entries(FIELD_CAPABILITY)) {
  ok(specDoc.includes(`\`${field}\``), `protocol/spec-suite.md never mentions ${field}, whose projection `
    + `depends on ${capability}: a field withheld without a written consequence reads as an omission`);
  ok(specDoc.includes(capability), `protocol/spec-suite.md never mentions the capability ${capability}, `
    + `so a reader cannot tell what withholding ${field} costs them`);
}
for (const mode of ['full', 'degraded']) {
  ok(specDoc.includes(`\`${mode}\``), `protocol/spec-suite.md must document compatibility.mode ${mode}: `
    + 'it is a status callers are told to refuse on, so it cannot be self-explanatory');
}
/**
 * The reason codes are derived from CAPABILITY_SUPPORT, so adding a support value adds a reason.
 * Deriving rather than listing is the point: a fourth value would otherwise ship a reason code
 * that appears in output and in no document.
 */
const withheldReasons = ['team-layer-owned', 'not-projectable',
  ...CAPABILITY_SUPPORT.filter((s) => s !== 'supported').map((s) => `capability-${s}`)];
for (const reason of withheldReasons) {
  ok(specDoc.includes(reason), `protocol/spec-suite.md does not document the withheld reason ${reason}`);
}

/**
 * Every action `reconcile` can name must be in the precedence list.
 *
 * This one is worth an installer-time check because of how the miss behaves: precedence is
 * `NEXT_ACTIONS.indexOf(action)`, and a typo returns -1, which sorts *first*. A misspelled
 * action would not be ignored — it would silently outrank every real finding and become the
 * answer a recovering Agent acts on. Reading the source for the literals is crude, but the
 * alternative is discovering it from a bug report about the one command that exists to be
 * trustworthy when nothing else is.
 *
 * The status in the same position is checked alongside it, which is why both helpers must take
 * their arguments in the same order — the scan cannot tell an action from a status otherwise,
 * and it was this check that caught them disagreeing.
 */
const reconcileSource = text('src/reconcile.mjs');
const declaredActions = new Set(NEXT_ACTIONS);
let namedPairs = 0;
for (const [, status, action] of reconcileSource.matchAll(/(?:finding|answer)\(\s*'([a-z-]+)',\s*'([a-z-]+)'/g)) {
  namedPairs += 1;
  ok(declaredActions.has(action), `reconcile names the action ${action}, which is not in NEXT_ACTIONS: `
    + 'an unlisted action sorts to -1 and would outrank every real finding');
  ok(RECONCILE_STATUSES.includes(status), `reconcile reports the status ${status}, which is not in RECONCILE_STATUSES`);
}
// Both helpers take (status, nextAction), which is what makes the pair above readable at all.
// If somebody swaps one of them back, every literal lands in the wrong vocabulary and the two
// assertions light up together — but only if the scan found the call sites in the first place.
ok(namedPairs >= NEXT_ACTIONS.length, `reconcile only names ${namedPairs} status/action pairs, `
  + `fewer than the ${NEXT_ACTIONS.length} actions it declares: either an action is unreachable or the scan missed a call site`);
ok(new Set(NEXT_ACTIONS).size === NEXT_ACTIONS.length, 'NEXT_ACTIONS has a duplicate, so its precedence is ambiguous');

/**
 * Every counted metric must be wired to an event kind something actually emits.
 *
 * A metric pointed at a kind no writer produces reports 0 forever, which is the exact failure
 * `src/metrics.mjs` refuses to commit for the metrics it cannot get — so it must not commit it
 * here by accident either. The kinds are read out of the ledger's own `#commit` calls, which
 * makes renaming an event kind without renaming its metric a failure at install time rather
 * than a dashboard that flatlines quietly.
 */
const emittedKinds = new Set([...text('src/ledger.mjs').matchAll(/kind:\s*'([a-z-]+)'/g)].map((m) => m[1]));
for (const [metric, kind] of Object.entries(METRIC_SOURCES)) {
  ok(emittedKinds.has(kind), `metric ${metric} counts the event kind ${kind}, which the ledger never emits: `
    + 'it would report 0 forever');
}
for (const entry of UNAVAILABLE_METRICS) {
  ok(!(entry.metric in METRIC_SOURCES) && !DERIVED_METRICS.includes(entry.metric),
    `${entry.metric} is listed as unavailable and also counted`);
  ok(typeof entry.reason === 'string' && entry.reason.length > 40,
    `${entry.metric} is listed as unavailable without saying why, which reads as an excuse rather than a work item`);
}
/**
 * A name in both lists would be one counter with two writers.
 *
 * `zeroed()` builds the counter set from both lists, so a collision produces a single key that
 * the occurrence loop and the payload sum both add to — a number that is the two metrics added
 * together, under one of their names. Cheap to check, and invisible in any output.
 */
for (const metric of DERIVED_METRICS) {
  ok(!(metric in METRIC_SOURCES),
    `${metric} is both counted by occurrence and summed from a payload, so its value would be neither`);
}
ok(new Set(DERIVED_METRICS).size === DERIVED_METRICS.length, 'DERIVED_METRICS names the same metric twice');

/**
 * A command a document tells an Agent to run must be a command that exists.
 *
 * This is the one class of doc drift with teeth. Every other stale sentence costs a reader a
 * moment; a renamed subcommand costs the Agent that followed [protocol/recovery.md](../protocol/recovery.md)
 * after losing its context a usage error, at the exact moment it has nothing else to fall back on
 * and no memory to correct the instruction with. The recovery path is the one that must not have a
 * typo in it.
 *
 * Both halves are checked against different sources on purpose: the first word against the
 * dispatcher, because that is what decides whether the process runs at all, and the pair against
 * `usage()`, because a real command with an invented subcommand fails the same way. Line-wrapped
 * mentions are not matched — this catches renames, not every possible prose form.
 */
const teamctlSource = text('scripts/teamctl.mjs');
const dispatched = new Set([...teamctlSource.matchAll(/command === '([a-z-]+)'/g)].map((m) => m[1]));
const usageText = teamctlSource.slice(teamctlSource.indexOf('function usage()'));
ok(dispatched.size > 10, `only ${dispatched.size} teamctl commands were found in the dispatcher, `
  + 'so the scan is broken and the checks below would pass by finding nothing');
const docs = ['SKILL.md', 'README.md', 'protocol/recovery.md', 'protocol/review.md',
  'protocol/spec-suite.md', 'protocol/collaboration.md', 'protocol/core.md', 'protocol/identity.md',
  'templates/handoff.md', 'examples/three-window-workflow.md',
  'adapters/claude-code.md', 'adapters/codex.md', 'adapters/gemini-cli.md', 'adapters/generic.md'];
for (const doc of docs) {
  if (!fs.existsSync(path.join(ROOT, doc))) continue;
  for (const [, command, sub] of text(doc).matchAll(/teamctl(?:\.mjs)? +([a-z][a-z-]*)(?: +([a-z][a-z-]*))?/g)) {
    ok(dispatched.has(command), `${doc} tells an Agent to run "teamctl ${command}", which the CLI does not dispatch`);
    if (sub) {
      ok(usageText.includes(`${command} ${sub}`),
        `${doc} names "teamctl ${command} ${sub}", which teamctl's own usage does not list`);
    }
  }
}

const reviewer = text('roles/reviewer.md');
ok(/not a second implementer/i.test(reviewer), 'reviewer must remain independent');
ok(/different valid implementation is not a bug/i.test(reviewer), 'reviewer must not block valid alternatives');

const product = text('roles/product-architect.md');
ok(/leave the choice to Fullstack/i.test(product), 'product-architect must preserve local implementation freedom');

if (failures.length) {
  console.error(`validation failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('persistent-agent-team skill validation: PASS');

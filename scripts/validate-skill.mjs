#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  'templates/handoff.md', 'templates/handoff.json', 'templates/task-packet.json', 'templates/finding.json',
  'templates/review-decision.json',
  'scripts/teamctl.mjs', 'src/ledger.mjs', 'src/slug.mjs', 'src/digest.mjs', 'src/schema.mjs'
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
};
for (const [file, source] of Object.entries(GENERATED)) {
  if (!fs.existsSync(path.join(ROOT, file))) continue;
  const marker = JSON.parse(text(file))['x-generated-from'];
  ok(typeof marker === 'string' && marker.startsWith(source),
    `${file} must carry x-generated-from starting with "${source}", got ${JSON.stringify(marker)}`);
}

const HAND_WRITTEN = ['schemas/identity.schema.json', 'schemas/task-packet.schema.json',
  'schemas/finding.schema.json', 'schemas/session.schema.json', 'schemas/task-record.schema.json',
  'schemas/handoff.schema.json', 'schemas/review-decision.schema.json'];
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
for (const requiredField of ['baseRevision', 'readSet', 'writeSet', 'inputs', 'acceptance']) {
  ok(taskSchema.required.includes(requiredField), `task packet must require ${requiredField}`);
}

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

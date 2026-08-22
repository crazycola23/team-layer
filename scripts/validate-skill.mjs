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
  'schemas/identity.schema.json', 'schemas/task-packet.schema.json', 'schemas/finding.schema.json', 'schemas/session.schema.json',
  'templates/handoff.md', 'templates/task-packet.json', 'templates/finding.json',
  'scripts/teamctl.mjs'
];
for (const file of required) ok(fs.existsSync(path.join(ROOT, file)), `missing ${file}`);

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

const findingSchema = JSON.parse(text('schemas/finding.schema.json'));
ok(findingSchema.properties.severity.enum.includes('blocker'), 'finding severity lacks blocker');
ok(findingSchema.required.includes('evidence') && findingSchema.required.includes('impact'), 'finding must require evidence + impact');

JSON.parse(text('templates/task-packet.json'));
JSON.parse(text('templates/finding.json'));

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

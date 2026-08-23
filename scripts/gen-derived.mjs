#!/usr/bin/env node
/**
 * Regenerate derived artifacts from their single sources.
 *
 * Derived files are checked in so consumers do not need a build step, and
 * `--check` proves the checked-in copy is current. Never hand-edit a file
 * carrying the `x-generated-from` marker.
 *
 *   node scripts/gen-derived.mjs           # write
 *   node scripts/gen-derived.mjs --check   # verify, exit 1 if stale
 */
import fs from 'node:fs';
import path from 'node:path';

import { inputSnapshotDigest, DigestError, REVISION_PATTERN, DIGEST_PATTERN, GIT_REVISION_PATTERN } from '../src/digest.mjs';
import { SESSION_STATUSES, TASK_STATUSES } from '../src/ledger.mjs';
import { ID_PATTERN, MAX_ID_LENGTH } from '../src/slug.mjs';
import { SKILL_ROOT, roleIds, registryDigest } from '../src/roles.mjs';

const check = process.argv.includes('--check');
const stale = [];

function emit(relative, value) {
  const file = path.join(SKILL_ROOT, relative);
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (existing === content) return;
  if (check) {
    stale.push(existing === null ? `${relative} is missing` : `${relative} is out of date`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  console.log(`wrote ${relative}`);
}

// ---------------------------------------------------------------- role schema
emit('schemas/role.schema.json', {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/crazycola23/team-layer/schemas/role.schema.json',
  title: 'Team role',
  description: 'Every role enum in this repository resolves here. Edit roles/registry.json instead.',
  'x-generated-from': `roles/registry.json@${registryDigest()}`,
  type: 'string',
  enum: roleIds(),
});

// -------------------------------------------------------------- revision schema
// Generated so a revision can never pass its schema and then fail closed inside
// `assertRevision`: both sides are the same pattern.
emit('schemas/revision.schema.json', {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/crazycola23/team-layer/schemas/revision.schema.json',
  title: 'Semantic input revision',
  description: 'An opaque scheme-prefixed revision token. The scheme names who can interpret the value; known schemes (sha256, git) additionally have their shape enforced.',
  'x-generated-from': 'src/digest.mjs REVISION_PATTERN',
  type: 'string',
  pattern: REVISION_PATTERN,
});

emit('schemas/digest.schema.json', {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/crazycola23/team-layer/schemas/digest.schema.json',
  title: 'Content digest',
  description: 'A sha256 content digest as produced by contentDigest/jsonDigest in src/digest.mjs.',
  'x-generated-from': 'src/digest.mjs DIGEST_PATTERN',
  type: 'string',
  pattern: DIGEST_PATTERN,
});

emit('schemas/git-revision.schema.json', {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/crazycola23/team-layer/schemas/git-revision.schema.json',
  title: 'Git revision',
  description: "A Git object name. Matches spec-suite's REVISION_RE so both layers agree on which strings name a commit.",
  'x-generated-from': 'src/digest.mjs GIT_REVISION_PATTERN',
  type: 'string',
  pattern: GIT_REVISION_PATTERN,
});

// -------------------------------------------------------------------- id schema
// Session and task ids are also directory names. `assertId` is what actually
// guards the filesystem, so the schema has to describe exactly the same set: an
// id that validated but failed `assertId` would be rejected only once something
// tried to open its ledger directory, and one that passed `assertId` but failed
// validation could not be written down at all.
emit('schemas/id.schema.json', {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/crazycola23/team-layer/schemas/id.schema.json',
  title: 'Ledger id',
  description: 'A session or task id: lowercase "scheme:name". `_` and `.` are excluded so the id maps injectively onto one path segment and cannot express traversal.',
  'x-generated-from': 'src/slug.mjs ID_PATTERN',
  type: 'string',
  maxLength: MAX_ID_LENGTH,
  pattern: ID_PATTERN,
});

// --------------------------------------------------------------- status schemas
// The transition tables in src/ledger.mjs are the authority: a status that is
// legal in a schema but unknown to the state machine would be accepted into an
// artifact and then rejected on the next transition.
emit('schemas/session-status.schema.json', {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/crazycola23/team-layer/schemas/session-status.schema.json',
  title: 'Session status',
  description: 'Plan §3.2. Legal transitions live in SESSION_TRANSITIONS in src/ledger.mjs.',
  'x-generated-from': 'src/ledger.mjs SESSION_STATUSES',
  type: 'string',
  enum: SESSION_STATUSES,
});

emit('schemas/task-status.schema.json', {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/crazycola23/team-layer/schemas/task-status.schema.json',
  title: 'Task status',
  description: 'The mutable half of a task. Frozen truth is restated, never reopened, so there is no "stale" status here: staleness is derived by comparing inputSnapshotDigest against current canonical revisions.',
  'x-generated-from': 'src/ledger.mjs TASK_STATUSES',
  type: 'string',
  enum: TASK_STATUSES,
});

// -------------------------------------------------- input snapshot test vectors
// These lock the `inputSnapshotDigest` algorithm. spec-suite implements the same
// digest on its side (plan §2); if it cannot reproduce every vector here byte
// for byte, the two layers disagree about which task is stale.
const VALID = [
  {
    name: 'empty input set',
    note: 'A task that genuinely depends on nothing still has a stable digest.',
    inputs: [],
  },
  {
    name: 'single input',
    inputs: [{ id: 'contract:coupon-api', revision: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' }],
  },
  {
    name: 'declaration order does not matter',
    note: 'Same digest as "declaration order does not matter (reversed)".',
    inputs: [
      { id: 'contract:coupon-api', revision: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' },
      { id: 'brief:coupon', revision: 'sha256:2222222222222222222222222222222222222222222222222222222222222222' },
    ],
  },
  {
    name: 'declaration order does not matter (reversed)',
    inputs: [
      { id: 'brief:coupon', revision: 'sha256:2222222222222222222222222222222222222222222222222222222222222222' },
      { id: 'contract:coupon-api', revision: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' },
    ],
  },
  {
    name: 'revision change moves the digest',
    note: 'Same ids as "single input" with one revision bumped.',
    inputs: [{ id: 'contract:coupon-api', revision: 'sha256:3333333333333333333333333333333333333333333333333333333333333333' }],
  },
  {
    name: 'authority is not hashed',
    note: 'Same digest as "single input": relabelling the source of a revision must not restate the task.',
    inputs: [{
      id: 'contract:coupon-api',
      revision: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      authority: 'spec-suite',
    }],
  },
  {
    name: 'punctuation sorts by code unit, not locale',
    note: 'Locale-aware collation often ignores "-"; sorting must use code-unit order so "a-b" precedes "ab".',
    inputs: [
      { id: 'ab', revision: 'git:abc1234' },
      { id: 'a-b', revision: 'git:abc1234' },
    ],
  },
  {
    name: 'non-ascii ids are not escaped before hashing',
    inputs: [{ id: 'contract:优惠券', revision: 'sha256:4444444444444444444444444444444444444444444444444444444444444444' }],
  },
  {
    name: 'mixed revision schemes',
    inputs: [
      { id: 'brief:coupon', revision: 'sha256:2222222222222222222222222222222222222222222222222222222222222222' },
      { id: 'baseline', revision: 'git:0f041fd' },
    ],
  },
];

const INVALID = [
  { name: 'duplicate id', inputs: [{ id: 'a', revision: 'git:abc1234' }, { id: 'a', revision: 'git:abc1234' }] },
  { name: 'malformed revision', inputs: [{ id: 'a', revision: 'not-a-revision' }] },
  { name: 'sha256 revision of the wrong length', inputs: [{ id: 'a', revision: 'sha256:abcd' }] },
  { name: 'missing revision', inputs: [{ id: 'a' }] },
  { name: 'empty id', inputs: [{ id: '', revision: 'git:abc1234' }] },
  { name: 'padded id', inputs: [{ id: ' a ', revision: 'git:abc1234' }] },
  { name: 'entry is not an object', inputs: ['contract:coupon-api'] },
  { name: 'input set is not an array', inputs: { id: 'a', revision: 'git:abc1234' } },
];

emit('fixtures/input-snapshot-vectors.json', {
  schemaVersion: 1,
  algorithm: 'sha256 over the compact canonical JSON of {"inputs":[{"id","revision"},...]} sorted by id',
  'x-generated-from': 'scripts/gen-derived.mjs',
  valid: VALID.map((vector) => ({ ...vector, digest: inputSnapshotDigest(vector.inputs) })),
  invalid: INVALID.map((vector) => {
    let code = null;
    try {
      inputSnapshotDigest(vector.inputs);
    } catch (error) {
      if (!(error instanceof DigestError)) throw error;
      code = error.code;
    }
    if (code === null) throw new Error(`invalid vector ${JSON.stringify(vector.name)} was accepted`);
    return { ...vector, code };
  }),
});

if (stale.length) {
  console.error('derived artifacts are stale:');
  for (const message of stale) console.error(`- ${message}`);
  console.error('run: node scripts/gen-derived.mjs');
  process.exit(1);
}
if (check) console.log('derived artifacts are current');

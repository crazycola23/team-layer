import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize, stableJson } from '../src/canonical-json.mjs';
import {
  assertDigestible,
  assertRevision,
  contentDigest,
  jsonDigest,
  normalizeInputs,
  inputSnapshotDigest,
  REVISION_PATTERN,
  DIGEST_PATTERN,
  GIT_REVISION_PATTERN,
  DigestError,
} from '../src/digest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VECTORS = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'input-snapshot-vectors.json'), 'utf8'));

function code(fn) {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof DigestError)) throw error;
    return error.code;
  }
  return null;
}

// ------------------------------------------------------------- canonical form
// These lock the properties spec-suite's implementation also has; if either repo
// drifts, inputSnapshotDigest stops agreeing across the two layers.

test('canonicalization sorts keys at every depth by code unit', () => {
  assert.equal(stableJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(stableJson({ ab: 1, 'a-b': 2 }), '{"a-b":2,"ab":1}');
});

test('canonicalization preserves array order', () => {
  assert.equal(stableJson([3, 1, 2]), '[3,1,2]');
});

test('digests use the compact form regardless of pretty printing', () => {
  const value = { b: 1, a: 2 };
  assert.equal(stableJson(value), '{"a":2,"b":1}');
  assert.equal(jsonDigest(value), contentDigest('{"a":2,"b":1}'));
});

test('non-ascii is not escaped before hashing', () => {
  assert.equal(stableJson({ id: '优惠券' }), '{"id":"优惠券"}');
});

test('canonicalize rejects values JSON cannot represent', () => {
  for (const value of [undefined, () => {}, Symbol('x'), 1n]) {
    assert.throws(() => canonicalize(value), /not JSON-serializable/);
  }
});

// ----------------------------------------------------------- fail-closed guard
// canonicalize() inherits two lossy behaviours from spec-suite. assertDigestible
// exists so we never hash a value those behaviours would silently collapse.

test('assertDigestible rejects what canonicalization would silently mangle', () => {
  assert.equal(stableJson({ n: NaN }), '{"n":null}', 'canonicalize itself still loses NaN');
  assert.equal(code(() => jsonDigest({ n: NaN })), 'NON_FINITE_NUMBER');
  assert.equal(code(() => jsonDigest({ n: Infinity })), 'NON_FINITE_NUMBER');
  assert.equal(code(() => jsonDigest({ at: new Date() })), 'NOT_PLAIN_OBJECT');
  assert.equal(code(() => jsonDigest({ set: new Set([1]) })), 'NOT_PLAIN_OBJECT');
  assert.equal(code(() => jsonDigest({ missing: undefined })), 'UNDEFINED_VALUE');
});

test('assertDigestible accepts ordinary JSON data unchanged', () => {
  const value = { a: [1, 'two', true, null, { b: -0.5 }] };
  assert.equal(assertDigestible(value), value);
});

// ---------------------------------------------------------------- revisions
test('assertRevision enforces shape per known scheme', () => {
  assert.equal(assertRevision(`sha256:${'a'.repeat(64)}`), `sha256:${'a'.repeat(64)}`);
  assert.equal(assertRevision('git:abc1234'), 'git:abc1234');
  assert.equal(assertRevision('contract:v1.2.3'), 'contract:v1.2.3', 'unknown schemes stay opaque');
  for (const bad of ['', 'sha256', 'sha256:', 'sha256:abcd', `sha256:${'A'.repeat(64)}`, 'git:xyz', ':abc', 'Git:abc1234', 'sha256 abc']) {
    assert.equal(code(() => assertRevision(bad)), 'MALFORMED_REVISION', `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

// ------------------------------------------------------------ input snapshots
test('inputSnapshotDigest reproduces every checked-in vector', () => {
  assert.ok(VECTORS.valid.length >= 9);
  for (const vector of VECTORS.valid) {
    assert.equal(inputSnapshotDigest(vector.inputs), vector.digest, vector.name);
  }
});

test('inputSnapshotDigest rejects every invalid vector with the recorded code', () => {
  assert.ok(VECTORS.invalid.length >= 8);
  for (const vector of VECTORS.invalid) {
    assert.equal(code(() => inputSnapshotDigest(vector.inputs)), vector.code, vector.name);
  }
});

test('digest is order-independent but revision-sensitive', () => {
  const a = { id: 'contract:x', revision: 'git:aaaaaaa' };
  const b = { id: 'brief:y', revision: 'git:bbbbbbb' };
  assert.equal(inputSnapshotDigest([a, b]), inputSnapshotDigest([b, a]));
  assert.notEqual(inputSnapshotDigest([a, b]), inputSnapshotDigest([{ ...a, revision: 'git:ccccccc' }, b]));
});

test('authority and unknown metadata never move the digest', () => {
  const bare = [{ id: 'contract:x', revision: 'git:aaaaaaa' }];
  const labelled = [{ id: 'contract:x', revision: 'git:aaaaaaa', authority: 'spec-suite', source: 'file' }];
  assert.equal(inputSnapshotDigest(labelled), inputSnapshotDigest(bare));
  assert.deepEqual(normalizeInputs(labelled), bare, 'normalization drops everything that is not hashed');
});

test('a duplicate id fails closed even when the revisions agree', () => {
  const same = { id: 'contract:x', revision: 'git:aaaaaaa' };
  assert.equal(code(() => inputSnapshotDigest([same, { ...same }])), 'DUPLICATE_INPUT');
});

test('an empty input set has a stable digest distinct from any populated set', () => {
  const empty = inputSnapshotDigest([]);
  assert.match(empty, /^sha256:[0-9a-f]{64}$/);
  assert.equal(empty, inputSnapshotDigest([]));
  assert.notEqual(empty, inputSnapshotDigest([{ id: 'a', revision: 'git:aaaaaaa' }]));
});

test('adding an input restates the task even when existing revisions are unchanged', () => {
  const one = [{ id: 'contract:x', revision: 'git:aaaaaaa' }];
  const two = [...one, { id: 'brief:y', revision: 'git:bbbbbbb' }];
  assert.notEqual(inputSnapshotDigest(one), inputSnapshotDigest(two));
});

// The generated schemas are the *only* thing standing between a malformed
// revision and a fail-closed error thrown much later, at digest time. If the
// pattern were even slightly wider than assertRevision, an artifact could pass
// validation and then blow up in a place that no longer knows which field was
// at fault.
test('the generated revision pattern accepts exactly what assertRevision accepts', () => {
  const cases = [
    'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    'git:abc1234',
    'git:ABCDEF0',
    'contract-rev:v1.2.3_final',
    'x:1',
    'sha256:abcd',
    'sha256:' + '0'.repeat(63),
    'sha256:' + '0'.repeat(65),
    'sha256:' + 'A'.repeat(64),
    'git:abc',
    'git:' + 'a'.repeat(65),
    'git:xyz1234',
    'Sha256:0',
    'no-scheme',
    ':leading',
    '1abc:x',
    'a:',
    'a b:c',
    'a:b c',
  ];
  const pattern = new RegExp(REVISION_PATTERN);
  for (const value of cases) {
    let accepted = true;
    try {
      assertRevision(value);
    } catch (error) {
      if (!(error instanceof DigestError)) throw error;
      accepted = false;
    }
    assert.equal(pattern.test(value), accepted, `${JSON.stringify(value)}: schema and assertRevision disagree`);
  }

  // Every checked-in schema that constrains a revision must use these patterns
  // rather than restating them.
  const schemaDir = path.join(ROOT, 'schemas');
  const expected = {
    'revision.schema.json': REVISION_PATTERN,
    'digest.schema.json': DIGEST_PATTERN,
    'git-revision.schema.json': GIT_REVISION_PATTERN,
  };
  for (const [name, want] of Object.entries(expected)) {
    const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, name), 'utf8'));
    assert.equal(schema.pattern, want, `${name} must be regenerated from src/digest.mjs`);
  }
  for (const name of fs.readdirSync(schemaDir)) {
    if (name in expected) continue;
    const body = fs.readFileSync(path.join(schemaDir, name), 'utf8');
    assert.ok(!/\[0-9a-fA-?F\]\{7,64\}/.test(body), `${name} restates a git revision pattern; $ref git-revision.schema.json`);
    assert.ok(!/\[0-9a-f\]\{64\}/.test(body), `${name} restates a sha256 pattern; $ref digest.schema.json`);
  }
});

test('every revision in a checked-in template survives assertRevision', () => {
  const dir = path.join(ROOT, 'templates');
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const body = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const walk = (value, at) => {
      if (Array.isArray(value)) return value.forEach((item, i) => walk(item, `${at}[${i}]`));
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && /Revision$|^revision$/.test(key)) {
          assert.doesNotThrow(() => assertRevision(child, `${name} ${at}.${key}`));
        }
        walk(child, `${at}.${key}`);
      }
    };
    walk(body, '$');
  }
});

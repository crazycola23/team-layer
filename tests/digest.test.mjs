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

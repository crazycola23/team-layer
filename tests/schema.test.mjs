import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSchema, validate, assertValid, SchemaError, ValidationError } from '../src/schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = path.join(ROOT, 'schemas');

function tempSchema(schema) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-layer-schema-'));
  const file = path.join(dir, 'test.schema.json');
  fs.writeFileSync(file, JSON.stringify(schema), 'utf8');
  return file;
}

// The point of this validator is that it refuses to under-validate. A keyword it
// does not implement must be an error in the schema, never a silently skipped
// constraint on the instance.
test('an unimplemented keyword is a schema error, not a silent no-op', () => {
  assert.throws(
    () => loadSchema(tempSchema({ type: 'string', format: 'date-time' })),
    (error) => error instanceof SchemaError && /unsupported keyword "format"/.test(error.message),
  );
});

test('unimplemented keywords are rejected at any depth', () => {
  for (const schema of [
    { type: 'object', properties: { a: { multipleOf: 2 } } },
    { type: 'array', items: { not: { type: 'string' } } },
    { $defs: { x: { if: true } }, $ref: '#/$defs/x' },
    { anyOf: [{ type: 'string' }, { patternProperties: {} }] },
  ]) {
    assert.throws(() => loadSchema(tempSchema(schema)), SchemaError);
  }
});

test('a malformed schema is rejected before any instance is validated', () => {
  for (const schema of [
    { type: 'strong' },
    { pattern: '([' },
    { required: 'name' },
    { enum: [] },
    { oneOf: [] },
  ]) {
    assert.throws(() => loadSchema(tempSchema(schema)), SchemaError);
  }
});

test('a $ref that cannot be resolved throws instead of matching everything', () => {
  for (const ref of ['#/definitions/x', '#/$defs/missing', '../outside.json', 'https://example.invalid/x.json']) {
    const loaded = loadSchema(tempSchema({ $defs: { real: { type: 'string' } }, $ref: ref }));
    assert.throws(() => validate(loaded, 'anything'), SchemaError, `expected ${ref} to fail`);
  }
});

test('type, enum, const, and bounds are enforced', () => {
  const loaded = loadSchema(tempSchema({
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'count'],
    properties: {
      kind: { enum: ['a', 'b'] },
      count: { type: 'integer', minimum: 1, maximum: 3 },
      version: { const: 1 },
      name: { type: 'string', minLength: 2, pattern: '^[a-z]+$' },
      tags: { type: 'array', uniqueItems: true, minItems: 1, items: { type: 'string' } },
    },
  }));

  assert.deepEqual(validate(loaded, { kind: 'a', count: 2 }), []);
  assert.deepEqual(validate(loaded, { kind: 'a', count: 2, tags: ['x'], name: 'ok', version: 1 }), []);

  const paths = (value) => validate(loaded, value).map((e) => e.path);
  assert.deepEqual(paths({ count: 2 }), ['$.kind']);
  assert.deepEqual(paths({ kind: 'c', count: 2 }), ['$.kind']);
  assert.deepEqual(paths({ kind: 'a', count: 1.5 }), ['$.count'], 'integer rejects a fractional number');
  assert.deepEqual(paths({ kind: 'a', count: 4 }), ['$.count']);
  assert.deepEqual(paths({ kind: 'a', count: 2, extra: true }), ['$.extra']);
  assert.deepEqual(paths({ kind: 'a', count: 2, name: 'A' }), ['$.name', '$.name']);
  assert.deepEqual(paths({ kind: 'a', count: 2, tags: [] }), ['$.tags']);
  assert.deepEqual(paths({ kind: 'a', count: 2, tags: ['x', 'x'] }), ['$.tags[1]']);
  assert.deepEqual(paths({ kind: 'a', count: 2, version: 2 }), ['$.version']);
});

test('oneOf requires exactly one branch and anyOf requires at least one', () => {
  const one = loadSchema(tempSchema({ oneOf: [{ type: 'string' }, { type: 'number' }] }));
  assert.deepEqual(validate(one, 'x'), []);
  assert.equal(validate(one, true).length, 1);

  const ambiguous = loadSchema(tempSchema({ oneOf: [{ type: 'string' }, { minLength: 1 }] }));
  assert.match(validate(ambiguous, 'x')[0].message, /matches 2 variants/);

  const any = loadSchema(tempSchema({ anyOf: [{ type: 'string' }, { minLength: 1 }] }));
  assert.deepEqual(validate(any, 'x'), []);
});

test('assertValid reports every error at once', () => {
  const loaded = loadSchema(tempSchema({ type: 'object', required: ['a', 'b', 'c'] }));
  assert.throws(
    () => assertValid(loaded, {}, 'thing'),
    (error) => error instanceof ValidationError && error.errors.length === 3 && /thing failed/.test(error.message),
  );
});

// ------------------------------------------------------- the repository's own schemas
test('every checked-in schema loads under the strict keyword allowlist', () => {
  const files = fs.readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 8, `expected several schemas, found ${files.length}`);
  for (const name of files) {
    assert.doesNotThrow(() => loadSchema(path.join(SCHEMA_DIR, name)), `${name} must load`);
  }
});

test('checked-in templates validate against their schemas', () => {
  const pairs = [
    ['templates/task-packet.json', 'schemas/task-packet.schema.json'],
    ['templates/finding.json', 'schemas/finding.schema.json'],
    // Not a review record — the template is the draft, and the record is what
    // `recordReview` returns. tests/ledger.test.mjs validates that half, and it has
    // to be that way round: only the ledger can fill in the fields the schema
    // requires, which is the point of them being required.
  ];
  for (const [instance, schema] of pairs) {
    const loaded = loadSchema(path.join(ROOT, schema));
    const value = JSON.parse(fs.readFileSync(path.join(ROOT, instance), 'utf8'));
    assert.deepEqual(validate(loaded, value), [], `${instance} must satisfy ${schema}`);
  }
});

test('the shared role enum resolves through $ref rather than being restated', () => {
  const identity = loadSchema(path.join(SCHEMA_DIR, 'identity.schema.json'));
  assert.equal(identity.schema.properties.role.$ref, 'role.schema.json');
  const base = {
    schemaVersion: 1,
    agentId: 'fullstack-01',
    role: 'fullstack',
    roleVersion: '1.0.0',
    skill: 'persistent-agent-team',
    skillVersion: '0.2.0',
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
  };
  assert.deepEqual(validate(identity, base), []);
  assert.equal(validate(identity, { ...base, role: 'architect' }).length, 1);
  assert.equal(validate(identity, { ...base, updatedAt: '2026-08-23T00:00:00+08:00' }).length, 1, 'local offsets are rejected');
  for (const forbidden of ['harness', 'model', 'taskId']) {
    assert.equal(validate(identity, { ...base, [forbidden]: 'x' }).length, 1, `identity must reject ${forbidden}`);
  }
});

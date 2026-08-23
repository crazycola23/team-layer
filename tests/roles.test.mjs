import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadRegistry, roleIds, isRole, roleFile, roleVersion, registryDigest, RoleError } from '../src/roles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the registry is the only place the role list is written down', () => {
  const ids = roleIds();
  assert.deepEqual(ids, ['fullstack', 'product-architect', 'reviewer']);

  const generated = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'role.schema.json'), 'utf8'));
  assert.deepEqual(generated.enum, ids, 'role.schema.json must be regenerated from the registry');
  assert.equal(generated['x-generated-from'], `roles/registry.json@${registryDigest()}`);

  // No other schema may restate the enum; they must $ref role.schema.json.
  const schemaDir = path.join(ROOT, 'schemas');
  for (const name of fs.readdirSync(schemaDir).filter((f) => f.endsWith('.json') && f !== 'role.schema.json')) {
    const body = fs.readFileSync(path.join(schemaDir, name), 'utf8');
    for (const id of ids) {
      assert.ok(!body.includes(`"${id}"`), `${name} restates role ${id}; use {"$ref": "role.schema.json"}`);
    }
  }

  // teamctl must not carry a second hardcoded list either.
  const cli = fs.readFileSync(path.join(ROOT, 'scripts', 'teamctl.mjs'), 'utf8');
  for (const id of ids) {
    assert.ok(!cli.includes(`'${id}'`), `teamctl.mjs hardcodes role ${id}; derive it from the registry`);
  }
});

test('every registered role has a manual with matching frontmatter', () => {
  for (const id of roleIds()) {
    const file = roleFile(id);
    assert.ok(fs.existsSync(file), `${file} must exist`);
    const body = fs.readFileSync(file, 'utf8');
    assert.match(body, new RegExp(`^role:\\s*${id}$`, 'm'), `${id} frontmatter must declare its own id`);
    assert.match(roleVersion(id), /^\d+\.\d+\.\d+$/);
  }
});

test('isRole and roleFile fail closed on an unknown role', () => {
  assert.equal(isRole('fullstack'), true);
  assert.equal(isRole('architect'), false);
  assert.equal(isRole(''), false);
  assert.throws(() => roleFile('architect'), (error) => error instanceof RoleError && error.code === 'UNKNOWN_ROLE');
});

test('a malformed registry is rejected rather than partially honoured', () => {
  const original = fs.readFileSync(path.join(ROOT, 'roles', 'registry.json'), 'utf8');
  const registryPath = path.join(ROOT, 'roles', 'registry.json');
  const cases = [
    [{ schemaVersion: 2, roles: [{ id: 'fullstack', file: 'roles/fullstack.md' }] }, 'REGISTRY_VERSION'],
    [{ schemaVersion: 1, roles: [] }, 'REGISTRY_EMPTY'],
    [{ schemaVersion: 1, roles: [{ id: 'Fullstack', file: 'roles/fullstack.md' }] }, 'REGISTRY_ENTRY'],
    [{ schemaVersion: 1, roles: [{ id: 'fullstack', file: '../etc/passwd' }] }, 'REGISTRY_ENTRY'],
    [{ schemaVersion: 1, roles: [{ id: 'fullstack', file: 'roles/fullstack.md', extra: 1 }] }, 'REGISTRY_ENTRY'],
    [{
      schemaVersion: 1,
      roles: [{ id: 'fullstack', file: 'roles/fullstack.md' }, { id: 'fullstack', file: 'roles/other.md' }],
    }, 'REGISTRY_DUPLICATE'],
  ];
  try {
    for (const [registry, expected] of cases) {
      fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
      let code = null;
      try {
        loadRegistry({ reload: true });
      } catch (error) {
        if (!(error instanceof RoleError)) throw error;
        code = error.code;
      }
      assert.equal(code, expected, `expected ${expected} for ${JSON.stringify(registry)}`);
    }
  } finally {
    // Restore by rewriting the original bytes. `git checkout --` would also
    // discard unrelated uncommitted work in this repository.
    fs.writeFileSync(registryPath, original, 'utf8');
    loadRegistry({ reload: true });
  }
  assert.deepEqual(roleIds(), ['fullstack', 'product-architect', 'reviewer']);
});

test('derived artifacts checked into the repository are current', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-derived.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
});

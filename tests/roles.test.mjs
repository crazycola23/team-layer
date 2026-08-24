import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  //
  // Asked structurally rather than by substring, because a substring search cannot
  // tell a restated value from a field name: review-decision.schema.json has a
  // property *named* `reviewer`, which is not a second copy of the vocabulary and
  // renaming it to satisfy a text search would make the schema worse. Walking for
  // `enum`/`const` asks the real question — is the role list written down twice —
  // and asks it at any depth, which the old check did not.
  const schemaDir = path.join(ROOT, 'schemas');
  const roleSet = new Set(ids);
  const restated = (node, where) => {
    if (Array.isArray(node)) return node.flatMap((item, i) => restated(item, `${where}[${i}]`));
    if (!node || typeof node !== 'object') return [];
    const hits = [];
    if (Array.isArray(node.enum) && node.enum.some((value) => roleSet.has(value))) hits.push(`${where}.enum`);
    if (roleSet.has(node.const)) hits.push(`${where}.const`);
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'enum' && key !== 'const') hits.push(...restated(value, `${where}.${key}`));
    }
    return hits;
  };
  for (const name of fs.readdirSync(schemaDir).filter((f) => f.endsWith('.json') && f !== 'role.schema.json')) {
    const hits = restated(JSON.parse(fs.readFileSync(path.join(schemaDir, name), 'utf8')), '$');
    assert.deepEqual(hits, [], `${name} restates the role list at ${hits.join(', ')}; use {"$ref": "role.schema.json"}`);
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

/**
 * The malformed registries go to a scratch file, not to `roles/registry.json`.
 *
 * Writing them to the real one used to make this test fail somewhere else: test files run in
 * parallel processes sharing a filesystem, so `tests/validation.test.mjs` would read whichever
 * broken registry happened to be on disk and report a duplicate role it had nothing to do with.
 * A suite that fails at random in an innocent file is one people learn to rerun instead of read.
 */
test('a malformed registry is rejected rather than partially honoured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-agent-team-registry-'));
  const registryPath = path.join(dir, 'registry.json');
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
  for (const [registry, expected] of cases) {
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    let code = null;
    try {
      loadRegistry({ registryPath });
    } catch (error) {
      if (!(error instanceof RoleError)) throw error;
      code = error.code;
    }
    assert.equal(code, expected, `expected ${expected} for ${JSON.stringify(registry)}`);
  }
  fs.rmSync(registryPath);
  assert.throws(() => loadRegistry({ registryPath }),
    (error) => error instanceof RoleError && error.code === 'REGISTRY_UNREADABLE');

  // The installed registry is still the answer everything else gets: an override that populated
  // the cache would leave every later caller in this process reading a file nobody installed.
  assert.deepEqual(roleIds(), ['fullstack', 'product-architect', 'reviewer']);
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A registry read through the override is not the one later callers get.
 *
 * The test above cannot establish this: every registry it loads throws, so the assignment that
 * fills the cache is never reached and the assertion that the installed roles survived passes
 * against a cache nothing wrote to. Only a *successful* override load can tell the two apart,
 * which is what this one does — and the distinction is the whole reason the parameter exists.
 * Caching an override would make one test's private registry the answer every later caller in the
 * process reads, so the contamination this was built to prevent would come back through the cache
 * instead of through the file.
 */
test('an override registry is read without becoming the cached answer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-agent-team-override-'));
  const registryPath = path.join(dir, 'registry.json');
  // Valid, and deliberately nothing like the installed one. `file` is never opened by the loader,
  // so a role manual that does not exist is enough to load and tells us which registry answered.
  fs.writeFileSync(registryPath,
    `${JSON.stringify({ schemaVersion: 1, roles: [{ id: 'inventor', file: 'roles/inventor.md' }] })}\n`, 'utf8');

  assert.deepEqual(loadRegistry({ registryPath }).ids, ['inventor'], 'the override was read, not ignored');
  assert.deepEqual(roleIds(), ['fullstack', 'product-architect', 'reviewer'],
    'the installed registry is still what the module answers with');
  assert.equal(isRole('inventor'), false, 'the override leaked into the cache');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('derived artifacts checked into the repository are current', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-derived.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
});

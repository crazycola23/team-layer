/**
 * The CLI fixtures, shared by every test that drives `teamctl` as a subprocess.
 *
 * They live here rather than in one test file because two of them need the same fixture and a
 * second copy would drift: the moment `bootstrapped()` means something slightly different in the
 * scenario suite than in the unit suite, the two files are testing two systems and only one of
 * them is the product. `tests/teamctl.test.mjs` proves the individual commands; the scenario
 * suite walks the plan's §17 flows end to end; both need a real git repository, a real durable
 * home, and a real subprocess, because that is what an Agent actually has.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI = path.join(ROOT, 'scripts', 'teamctl.mjs');

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistent-agent-team-'));
  const repo = path.join(dir, 'repo');
  const home = path.join(dir, 'agent-home');
  fs.mkdirSync(repo);
  git(['init'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git(['add', 'README.md'], repo);
  git(['commit', '-m', 'init'], repo);
  return { dir, repo, home };
}

/**
 * `env` overlays the inherited environment, and an empty string un-sets a variable.
 *
 * Needed because `SPEC_SUITE_ROOT` is a real variable an operator may have exported: a test
 * asserting what happens when nobody named a spec-suite would otherwise pass or fail
 * depending on the machine it ran on.
 */
export function run(args, { repo, home, env = {} }, expect = 0) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    env: { ...process.env, AGENT_TEAM_HOME: home, ...env },
    encoding: 'utf8',
  });
  assert.equal(res.status, expect, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  return res;
}

/** `run`, parsed: every command that succeeds prints one JSON object. */
export function json(args, f, expect = 0) {
  return JSON.parse(run(args, f, expect).stdout);
}

/** The refusal a command produced: `{code, exit}`, or null if it was allowed. */
export function refusal(args, f) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: f.repo, env: { ...process.env, AGENT_TEAM_HOME: f.home }, encoding: 'utf8',
  });
  if (res.status === 0) return null;
  assert.match(res.stderr, /"status": "refused"/, `expected a structured refusal, got: ${res.stderr}`);
  return { code: JSON.parse(res.stderr).code, exit: res.status };
}

export function bootstrapped({ agentId = 'fullstack-01', role = 'fullstack' } = {}) {
  const f = fixture();
  run(['setup', '--agent-id', agentId, '--role', role, '--harness', 'claude-code', '--repo', '.'], f);
  return f;
}

/** A task packet for `session`, valid unless deliberately broken by the caller. */
export function taskPacket(overrides = {}) {
  return {
    schemaVersion: 2,
    taskId: 'task:coupon-api',
    sessionId: 'feature:coupon',
    subject: 'agent:fullstack-01',
    role: 'fullstack',
    baseRevision: 'git:abc1234',
    readSet: ['src/**'],
    writeSet: ['src/coupon/**'],
    inputs: [{ id: 'contract:coupon', revision: `sha256:${'1'.repeat(64)}`, authority: 'product-architect' }],
    acceptance: ['AC-1 discount applies at most once'],
    validationPlan: [
      { checkId: 'unit-tests', kind: 'command', requiredAt: ['handoff', 'merge'], command: 'npm test' },
    ],
    ...overrides,
  };
}

export function writePacket(f, packet, name = 'packet.json') {
  const file = path.join(f.repo, name);
  fs.writeFileSync(file, `${JSON.stringify(packet, null, 2)}\n`);
  return file;
}

export function writeDraft(f, draft, name = 'draft.json') {
  const file = path.join(f.repo, name);
  fs.writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`);
  return file;
}

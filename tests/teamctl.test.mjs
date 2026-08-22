import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'teamctl.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
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

function run(args, { repo, home }, expect = 0) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    env: { ...process.env, AGENT_TEAM_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(res.status, expect, `stdout=${res.stdout}\nstderr=${res.stderr}`);
  return res;
}

test('Claude setup creates harness-neutral identity and local adapter idempotently', () => {
  const f = fixture();
  run(['setup', '--agent-id', 'product-01', '--role', 'product-architect', '--harness', 'claude-code', '--repo', '.'], f);

  const identityPath = path.join(f.home, 'agents', 'product-01', 'identity.json');
  const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  assert.equal(identity.agentId, 'product-01');
  assert.equal(identity.role, 'product-architect');
  assert.equal('harness' in identity, false);
  assert.equal('model' in identity, false);
  assert.equal('taskId' in identity, false);

  const adapter = path.join(f.repo, 'CLAUDE.local.md');
  assert.match(fs.readFileSync(adapter, 'utf8'), /product-01\/bootstrap\.md/);
  assert.equal(git(['status', '--porcelain'], f.repo), '');

  fs.appendFileSync(adapter, '\n# personal local note\n');
  run(['setup', '--agent-id', 'product-01', '--role', 'product-architect', '--harness', 'claude-code', '--repo', '.'], f);
  const after = fs.readFileSync(adapter, 'utf8');
  assert.match(after, /personal local note/);
  assert.equal((after.match(/persistent-agent-team:managed:start/g) || []).length, 1);
});

test('different worktrees can bind different persistent identities', () => {
  const f = fixture();
  const fullstackWt = path.join(f.dir, 'fullstack-wt');
  const reviewerWt = path.join(f.dir, 'reviewer-wt');
  git(['worktree', 'add', '-b', 'agent/fullstack', fullstackWt], f.repo);
  git(['worktree', 'add', '-b', 'agent/reviewer', reviewerWt], f.repo);

  run(['setup', '--agent-id', 'fullstack-01', '--role', 'fullstack', '--harness', 'codex', '--repo', fullstackWt], { repo: fullstackWt, home: f.home });
  run(['setup', '--agent-id', 'reviewer-01', '--role', 'reviewer', '--harness', 'codex', '--repo', reviewerWt], { repo: reviewerWt, home: f.home });

  const a = JSON.parse(fs.readFileSync(path.join(fullstackWt, '.agent-team-binding.json'), 'utf8'));
  const b = JSON.parse(fs.readFileSync(path.join(reviewerWt, '.agent-team-binding.json'), 'utf8'));
  assert.equal(a.agentId, 'fullstack-01');
  assert.equal(b.agentId, 'reviewer-01');
  assert.match(fs.readFileSync(path.join(fullstackWt, 'AGENTS.override.md'), 'utf8'), /fullstack-01/);
  assert.match(fs.readFileSync(path.join(reviewerWt, 'AGENTS.override.md'), 'utf8'), /reviewer-01/);
  assert.equal(git(['status', '--porcelain'], fullstackWt), '');
  assert.equal(git(['status', '--porcelain'], reviewerWt), '');
});

test('setup refuses silent role reassignment', () => {
  const f = fixture();
  run(['setup', '--agent-id', 'worker-01', '--role', 'fullstack', '--harness', 'generic', '--repo', '.'], f);
  const res = run(['setup', '--agent-id', 'worker-01', '--role', 'reviewer', '--harness', 'generic', '--repo', '.'], f, 1);
  assert.match(res.stderr, /role reassignment must be explicit/);
});

test('Gemini setup preserves project GEMINI.md and emits agent-specific launcher', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, 'GEMINI.md'), '# tracked project instructions\n');
  git(['add', 'GEMINI.md'], f.repo);
  git(['commit', '-m', 'add gemini project context'], f.repo);

  run(['setup', '--agent-id', 'reviewer-01', '--role', 'reviewer', '--harness', 'gemini-cli', '--repo', '.'], f);

  assert.equal(fs.readFileSync(path.join(f.repo, 'GEMINI.md'), 'utf8'), '# tracked project instructions\n');
  assert.ok(fs.existsSync(path.join(f.repo, 'AGENT.bootstrap.md')));
  const settings = JSON.parse(fs.readFileSync(path.join(f.home, 'agents', 'reviewer-01', 'gemini-settings.json'), 'utf8'));
  assert.deepEqual(settings.context.fileName, ['GEMINI.md', 'AGENT.bootstrap.md']);
  const launcher = path.join(f.home, 'agents', 'reviewer-01', 'launch-gemini.sh');
  assert.ok(fs.existsSync(launcher));
  assert.ok((fs.statSync(launcher).mode & 0o111) !== 0);
  assert.equal(git(['status', '--porcelain'], f.repo), '');
});

test('doctor reports a healthy configured worktree', () => {
  const f = fixture();
  run(['setup', '--agent-id', 'fullstack-01', '--role', 'fullstack', '--harness', 'codex', '--repo', '.'], f);
  const res = run(['doctor', '--repo', '.'], f);
  const output = JSON.parse(res.stdout);
  assert.equal(output.status, 'healthy');
  assert.ok(output.checks.every((x) => x.ok));
});

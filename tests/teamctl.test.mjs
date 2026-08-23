import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'teamctl.mjs');

/**
 * Windows has no POSIX permission bits, so an executable-bit assertion cannot
 * pass there. Skipping silently would mean the check has never actually run
 * anywhere, so CI sets TEAM_LAYER_REQUIRE_POSIX=1 to turn the missing
 * capability into a hard failure instead of a quiet pass.
 */
function hasCapability(t, name, available) {
  if (available) return true;
  if (process.env.TEAM_LAYER_REQUIRE_POSIX === '1') {
    assert.fail(`capability ${name} is unavailable, but TEAM_LAYER_REQUIRE_POSIX=1 requires it`);
  }
  t.diagnostic(`skipped assertion: ${name} unavailable on ${process.platform}`);
  return false;
}

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
  // The adapter embeds a native absolute path, so compare with separators normalized
  // rather than asserting POSIX slashes that Windows will never emit.
  assert.match(fs.readFileSync(adapter, 'utf8').replaceAll('\\', '/'), /product-01\/bootstrap\.md/);
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

test('Gemini setup preserves project GEMINI.md and emits agent-specific launcher', (t) => {
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
  if (hasCapability(t, 'posix-executable-bit', process.platform !== 'win32')) {
    assert.ok((fs.statSync(launcher).mode & 0o111) !== 0, 'launcher must be executable');
  }
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

// --------------------------------------------------------------------- ledger
// These drive the CLI rather than src/ledger.mjs directly. tests/ledger.test.mjs
// already covers the semantics; what is left to prove is the part only the CLI
// owns — that a refusal reaches a caller as a distinguishable exit code, that
// the actor recorded is the bound identity rather than whatever was typed, and
// that two worktrees really do land on one ledger.

/** A task packet for `session`, valid unless deliberately broken by the caller. */
function taskPacket(overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: 'task:coupon-api',
    sessionId: 'feature:coupon',
    subject: 'agent:fullstack-01',
    role: 'fullstack',
    baseRevision: 'git:abc1234',
    readSet: ['src/**'],
    writeSet: ['src/coupon/**'],
    inputs: [{ id: 'contract:coupon', revision: `sha256:${'1'.repeat(64)}`, authority: 'product-architect' }],
    acceptance: ['AC-1 discount applies at most once'],
    validation: ['npm test'],
    ...overrides,
  };
}

function writePacket(f, packet, name = 'packet.json') {
  const file = path.join(f.repo, name);
  fs.writeFileSync(file, `${JSON.stringify(packet, null, 2)}\n`);
  return file;
}

/** The refusal a command produced: `{code, exit}`, or null if it was allowed. */
function refusal(args, f) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: f.repo, env: { ...process.env, AGENT_TEAM_HOME: f.home }, encoding: 'utf8',
  });
  if (res.status === 0) return null;
  assert.match(res.stderr, /"status": "refused"/, `expected a structured refusal, got: ${res.stderr}`);
  return { code: JSON.parse(res.stderr).code, exit: res.status };
}

function bootstrapped({ agentId = 'fullstack-01', role = 'fullstack' } = {}) {
  const f = fixture();
  run(['setup', '--agent-id', agentId, '--role', role, '--harness', 'claude-code', '--repo', '.'], f);
  return f;
}

test('a session and task round-trip through the CLI', () => {
  const f = bootstrapped();
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main', '--provider', 'spec-suite'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const shown = JSON.parse(run(['session', 'show', '--session', 'feature:coupon'], f).stdout);
  assert.equal(shown.session.status, 'forming');
  assert.equal(shown.session.canonicalProvider, 'spec-suite');
  assert.deepEqual(shown.tasks.map((t) => t.taskId), ['task:coupon-api']);
  assert.equal(shown.tasks[0].generation, 1);
  // `events` comes from a read that asserts the log holds exactly eventSeq
  // entries, so a truncated log surfaces here rather than at some later write.
  assert.equal(shown.events, shown.session.eventSeq);
});

/**
 * The exit code is the whole interface for a wrapper script.
 *
 * A caller that cannot tell "someone else got there first" from "your packet is
 * wrong" has to guess, and the safe-looking guess — retry — turns a malformed
 * packet into an infinite loop. So retryable refusals get their own code.
 */
test('CLI refusals are distinguishable: 4 is worth retrying, 3 is not', () => {
  const f = bootstrapped();
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);

  assert.deepEqual(refusal(['session', 'set-status', '--session', 'feature:coupon',
    '--status', 'product-definition', '--expect-revision', '99'], f),
    { code: 'REVISION_CONFLICT', exit: 4 });

  for (const [args, expected] of [
    [['session', 'start', '--session', 'feature:coupon', '--target', 'main'], 'SESSION_EXISTS'],
    [['session', 'start', '--session', '../escape', '--target', 'main'], 'MALFORMED_ID'],
    [['session', 'show', '--session', 'feature:nope'], 'NOT_FOUND'],
    [['session', 'set-status', '--session', 'feature:coupon', '--status', 'completed'], 'ILLEGAL_TRANSITION'],
    [['session', 'set-status', '--session', 'feature:coupon', '--status', 'forming'], 'NO_OP_TRANSITION'],
    [['session', 'set-status', '--session', 'feature:coupon', '--status', 'banana'], 'UNKNOWN_STATUS'],
  ]) {
    assert.deepEqual(refusal(args, f), { code: expected, exit: 3 }, args.join(' '));
  }

  // A refused write must not have consumed a revision, or a caller that retries
  // correctly after a conflict would conflict again on a revision nothing used.
  assert.equal(JSON.parse(run(['session', 'show', '--session', 'feature:coupon'], f).stdout).session.revision, 1);
});

test('a malformed packet is refused as a mistake, not as something to retry', () => {
  const f = bootstrapped();
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket({ baseRevision: 'git:zzz' }), 'bad.json');
  assert.deepEqual(refusal(['task', 'issue', '--packet', 'bad.json'], f), { code: 'MALFORMED_REVISION', exit: 3 });
  assert.deepEqual(JSON.parse(run(['session', 'show', '--session', 'feature:coupon'], f).stdout).tasks, []);
});

/**
 * Plan §17 Scenario 2, from the operator's side.
 *
 * The flag matters more than it looks: a scheduled freshness check that reports
 * `unchanged` must be safe to run against a task an Agent is working on, and the
 * caller needs to be told which of the two happened without going and diffing
 * digests itself.
 */
test('restating a task tells the caller whether anything actually moved', () => {
  const f = bootstrapped();
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);
  run(['task', 'set-status', '--session', 'feature:coupon', '--task', 'task:coupon-api',
    '--status', 'in-progress'], f);

  const noop = JSON.parse(run(['task', 'reissue', '--packet', 'packet.json',
    '--reason', 'periodic freshness re-check'], f).stdout);
  assert.equal(noop.unchanged, true);
  assert.equal(noop.record.state.generation, 1, 'a no-op check invents no generation');
  assert.equal(noop.record.state.status, 'in-progress', 'a no-op check does not derail work in progress');

  writePacket(f, taskPacket({
    inputs: [{ id: 'contract:coupon', revision: `sha256:${'2'.repeat(64)}`, authority: 'product-architect' }],
  }), 'moved.json');
  const moved = JSON.parse(run(['task', 'reissue', '--packet', 'moved.json',
    '--reason', 'coupon contract v2: stacking rules changed'], f).stdout);
  assert.equal(moved.unchanged, false);
  assert.equal(moved.record.state.generation, 2);
  assert.equal(moved.record.state.status, 'issued', 'a real restatement returns the task to the Agent');
  assert.equal(moved.supersededDigest, noop.record.frozenDigest);

  // Both checks are in the log, including the one that changed nothing: "we
  // looked and it was still current" is evidence, and losing it means a later
  // reader cannot tell a stale task from an unexamined one.
  const events = JSON.parse(run(['session', 'events', '--session', 'feature:coupon',
    '--kind', 'task-reissued'], f).stdout);
  assert.deepEqual(events.map((e) => e.unchanged), [true, false]);

  assert.deepEqual(refusal(['task', 'reissue', '--packet', 'moved.json',
    '--reason', 'again', '--expect-generation', '1'], f), { code: 'REVISION_CONFLICT', exit: 4 });
});

/**
 * The reason the ledger lives in the Git common dir rather than the worktree.
 *
 * Three Agent windows on one machine are three linked worktrees, and the whole
 * design depends on them seeing one session without a server in between. Each
 * event must also carry the identity that caused it: an audit log whose actor is
 * whatever the caller passed on the command line is not evidence of anything.
 */
test('linked worktrees share one ledger and each event keeps its own actor', () => {
  const f = bootstrapped({ agentId: 'product-01', role: 'product-architect' });
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);

  const linked = path.join(f.dir, 'wt-fullstack');
  git(['worktree', 'add', linked, '-b', 'impl'], f.repo);
  const g = { dir: f.dir, repo: linked, home: f.home };
  run(['setup', '--agent-id', 'fullstack-01', '--role', 'fullstack', '--harness', 'codex', '--repo', '.'], g);

  assert.deepEqual(JSON.parse(run(['session', 'list'], g).stdout).map((s) => s.sessionId), ['feature:coupon'],
    'the linked worktree sees the session it did not create');
  writePacket(g, taskPacket(), 'packet.json');
  run(['task', 'issue', '--packet', 'packet.json'], g);

  const shown = JSON.parse(run(['session', 'show', '--session', 'feature:coupon'], f).stdout);
  assert.deepEqual(shown.tasks.map((t) => t.taskId), ['task:coupon-api'],
    'and the original worktree sees the task it did not issue');

  const events = JSON.parse(run(['session', 'events', '--session', 'feature:coupon'], f).stdout);
  assert.deepEqual(events.map((e) => [e.kind, e.actor]), [
    ['session-created', 'agent:product-01'],
    ['task-issued', 'agent:fullstack-01'],
  ]);

  // --actor is ignored while a binding exists, so the log cannot be attributed to
  // someone else by a caller who simply asserts a different name. The flag stays
  // for the case it is meant for — a one-off in a worktree with no binding yet.
  run(['task', 'set-status', '--session', 'feature:coupon', '--task', 'task:coupon-api',
    '--status', 'in-progress', '--actor', 'agent:somebody-else'], g);
  const after = JSON.parse(run(['session', 'events', '--session', 'feature:coupon',
    '--kind', 'task-status-changed'], f).stdout);
  assert.deepEqual(after.map((e) => e.actor), ['agent:fullstack-01']);
});

/**
 * `status` is the first command an Agent runs after losing its context, so it
 * takes no arguments: an Agent that has forgotten everything cannot be asked
 * which session it was working on. It answers from the binding in the worktree.
 */
test('status answers "where am I?" from the binding alone', () => {
  const f = bootstrapped();
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);
  writePacket(f, taskPacket({ taskId: 'task:someone-else', subject: 'agent:reviewer-01', role: 'reviewer' }), 'other.json');
  run(['task', 'issue', '--packet', 'other.json'], f);

  const out = JSON.parse(run(['status'], f).stdout);
  assert.equal(out.agent.agentId, 'fullstack-01');
  assert.deepEqual(out.sessions.map((s) => s.sessionId), ['feature:coupon']);
  // Only this Agent's own tasks: a recovering Agent that is handed the whole
  // session has to work out which rows are its own, and that is the one question
  // it is least able to answer.
  assert.deepEqual(out.sessions[0].tasks.map((t) => t.taskId), ['task:coupon-api']);
});

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

function writePacket(f, packet, name = 'packet.json') {
  const file = path.join(f.repo, name);
  fs.writeFileSync(file, `${JSON.stringify(packet, null, 2)}\n`);
  return file;
}

function writeDraft(f, draft, name = 'draft.json') {
  const file = path.join(f.repo, name);
  fs.writeFileSync(file, `${JSON.stringify(draft, null, 2)}\n`);
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
  // The role too, and it is read through the binding rather than out of it: the
  // binding file deliberately carries no role, so a `status` that read the file
  // directly would report `undefined` here and look merely incomplete instead of
  // wrong — which is how it went unnoticed until this line existed.
  assert.equal(out.agent.role, 'fullstack');
  assert.deepEqual(out.sessions.map((s) => s.sessionId), ['feature:coupon']);
  // Only this Agent's own tasks: a recovering Agent that is handed the whole
  // session has to work out which rows are its own, and that is the one question
  // it is least able to answer.
  assert.deepEqual(out.sessions[0].tasks.map((t) => t.taskId), ['task:coupon-api']);
});

/**
 * The §4 path end to end, across two worktrees: Fullstack publishes state, the
 * Reviewer's `inbox` shows it without being told which session to look in, and
 * acknowledging clears it.
 *
 * Two worktrees rather than one, because that is the situation the layer exists
 * for — the addressing has to work when the sender and recipient are separate
 * processes with separate bindings that only share the ledger.
 */
test('a handoff crosses worktrees and lands in the recipient inbox', () => {
  const f = bootstrapped({ agentId: 'fullstack-01', role: 'fullstack' });
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const linked = path.join(f.dir, 'wt-reviewer');
  git(['worktree', 'add', linked, '-b', 'review'], f.repo);
  const g = { dir: f.dir, repo: linked, home: f.home };
  run(['setup', '--agent-id', 'reviewer-01', '--role', 'reviewer', '--harness', 'codex', '--repo', '.'], g);

  writeDraft(f, {
    sessionId: 'feature:coupon',
    taskId: 'task:coupon-api',
    to: { role: 'reviewer' },
    nextAction: 'review',
    summary: 'Discount is applied once, in the domain layer; the API only validates shape.',
    artifacts: [{ type: 'code', id: 'module:coupon', revision: 'git:abc1234' }],
    evidence: [{ kind: 'validation', detail: 'npm test', result: '73 passing' }],
    unresolved: ['Expired coupon on a saved cart is still unspecified.'],
  });
  const published = JSON.parse(run(['handoff', 'publish', '--handoff', 'draft.json'], f).stdout);
  assert.equal(published.handoffId, 'handoff:fullstack-to-reviewer-1');
  // The role came from the binding, not the draft: a publisher that could assert
  // any role would make `to.role` addressing meaningless.
  assert.deepEqual(published.handoff.from, { subject: 'agent:fullstack-01', role: 'fullstack' });

  // And --role cannot override it while a binding exists, for the same reason
  // --actor cannot override the actor: a claimed capacity nobody granted would let
  // one agent publish work into another role's queue as if it held that role. The
  // flag stays for what it is meant for — a worktree with no binding yet.
  writeDraft(f, {
    sessionId: 'feature:coupon', taskId: 'task:coupon-api', to: { role: 'product-architect' },
    nextAction: 'clarify', summary: 'Published while claiming a role this agent does not hold.',
  }, 'draft-2.json');
  const claimed = JSON.parse(run(['handoff', 'publish', '--handoff', 'draft-2.json',
    '--role', 'product-architect'], f).stdout);
  assert.equal(claimed.handoff.from.role, 'fullstack');
  assert.equal(claimed.handoffId, 'handoff:fullstack-to-product-architect-2');

  // The reviewer asks what is waiting for it, naming neither session nor task —
  // this is the command an agent runs when it has just lost its context.
  const inbox = JSON.parse(run(['inbox'], g).stdout);
  assert.deepEqual(inbox.map((row) => [row.handoffId, row.nextAction, row.stale]),
    [['handoff:fullstack-to-reviewer-1', 'review', false]]);
  assert.equal(inbox[0].sessionId, 'feature:coupon');
  assert.equal(inbox[0].unresolved, 1);

  // `--role` cannot redirect a bound worktree's inbox either. Reading another role's
  // queue is the harmless half; the same precedence decides who may ack out of it,
  // and one expression serves both, so it is asserted where the flag is tempting.
  assert.deepEqual(JSON.parse(run(['inbox', '--role', 'reviewer'], f).stdout), [],
    'the fullstack worktree sees the fullstack queue, whatever --role claims');

  // Acked while claiming a role that is not the addressee: it succeeds, which is the
  // proof the binding won — had the flag won, the addressee check would have refused.
  run(['handoff', 'ack', '--session', 'feature:coupon', '--handoff', inbox[0].handoffId,
    '--role', 'product-architect'], g);
  assert.deepEqual(JSON.parse(run(['inbox'], g).stdout), [], 'an acked handoff leaves the queue');
  assert.deepEqual(JSON.parse(run(['inbox'], f).stdout), [],
    'and it was never in the sender’s queue to begin with');

  const events = JSON.parse(run(['session', 'events', '--session', 'feature:coupon'], f).stdout);
  assert.deepEqual(events.filter((e) => e.kind.startsWith('handoff-')).map((e) => [e.kind, e.actor]), [
    ['handoff-published', 'agent:fullstack-01'],
    ['handoff-published', 'agent:fullstack-01'],
    ['handoff-acked', 'agent:reviewer-01'],
  ]);
});

/**
 * Plan §2.3 `stale-input` at the CLI boundary.
 *
 * The exit code is the assertion that matters: 3 means "do not retry, the inputs
 * moved", and an agent that saw the retryable 4 would loop until it gave up
 * instead of asking for a fresh handoff.
 */
test('the CLI refuses to acknowledge a handoff whose inputs have moved, unretryably', () => {
  const f = bootstrapped({ agentId: 'fullstack-01', role: 'fullstack' });
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);
  writeDraft(f, {
    sessionId: 'feature:coupon', taskId: 'task:coupon-api', to: { role: 'reviewer' },
    nextAction: 'review', summary: 'Ready for review.',
  });
  run(['handoff', 'publish', '--handoff', 'draft.json'], f);

  // The refusal has to be reachable by the addressee, because the addressee is who
  // discovers it: acking is the last cheap moment before the work exists.
  const linked = path.join(f.dir, 'wt-reviewer');
  git(['worktree', 'add', linked, '-b', 'review'], f.repo);
  const g = { dir: f.dir, repo: linked, home: f.home };
  run(['setup', '--agent-id', 'reviewer-01', '--role', 'reviewer', '--harness', 'codex', '--repo', '.'], g);

  writePacket(f, taskPacket({
    inputs: [{ id: 'contract:coupon', revision: `sha256:${'9'.repeat(64)}`, authority: 'product-architect' }],
  }), 'packet-v2.json');
  run(['task', 'reissue', '--packet', 'packet-v2.json', '--reason', 'coupon contract v2'], f);

  assert.deepEqual(refusal(['handoff', 'ack', '--session', 'feature:coupon',
    '--handoff', 'handoff:fullstack-to-reviewer-1'], g), { code: 'HANDOFF_STALE', exit: 3 });

  // Still in the queue, and flagged: a refusal that also hid the work would trade a
  // stale ack for a lost one.
  assert.deepEqual(JSON.parse(run(['inbox'], g).stdout)
    .map((row) => [row.handoffId, row.stale]), [['handoff:fullstack-to-reviewer-1', true]]);

  // `handoff show` still works: the statement is readable, it is only acting on
  // it that is refused. A recipient that cannot read it cannot see what moved.
  const shown = JSON.parse(run(['handoff', 'show', '--session', 'feature:coupon',
    '--handoff', 'handoff:fullstack-to-reviewer-1'], g).stdout);
  assert.equal(shown.handoff.nextAction, 'review');
});

test('a handoff draft that misnames its content is refused, not published empty', () => {
  const f = bootstrapped({ agentId: 'fullstack-01', role: 'fullstack' });
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);
  const base = {
    sessionId: 'feature:coupon', taskId: 'task:coupon-api',
    to: { role: 'reviewer' }, nextAction: 'review', summary: 'Ready.',
  };

  writeDraft(f, { ...base, artifcts: [{ type: 'code', id: 'module:x', revision: 'git:abc1234' }] });
  assert.deepEqual(refusal(['handoff', 'publish', '--handoff', 'draft.json'], f),
    { code: 'MALFORMED_HANDOFF', exit: 3 });

  writeDraft(f, { ...base, nextAction: 'have-a-look' });
  assert.deepEqual(refusal(['handoff', 'publish', '--handoff', 'draft.json'], f),
    { code: 'UNKNOWN_ACTION', exit: 3 });

  writeDraft(f, { ...base, handoffId: 'handoff:mine-1' });
  assert.deepEqual(refusal(['handoff', 'publish', '--handoff', 'draft.json'], f),
    { code: 'MALFORMED_HANDOFF', exit: 3 });

  assert.deepEqual(JSON.parse(run(['handoff', 'show', '--session', 'feature:coupon'], f).stdout), [],
    'no refused draft was published');
});

/** The shipped template must be publishable as-is, or it is documentation of a wish. */
test('the shipped handoff template publishes with only its ids filled in', () => {
  const f = bootstrapped({ agentId: 'fullstack-01', role: 'fullstack' });
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'handoff.json'), 'utf8'));
  writeDraft(f, { ...template, sessionId: 'feature:coupon', taskId: 'task:coupon-api' });
  const published = JSON.parse(run(['handoff', 'publish', '--handoff', 'draft.json'], f).stdout);
  assert.equal(published.seq, 1);
  assert.ok(published.handoffDigest.startsWith('sha256:'));
});

// --------------------------------------------------------------------- reviews

/**
 * `review state` across two worktrees, which is where the answer has to be right:
 * the reviewer records the decision, and the *implementer* is who later asks whether
 * it still covers what they now have.
 *
 * The candidate defaulting to this worktree's HEAD is the part only the CLI owns.
 * Asking "is what I have now approved?" is the real question, and requiring the
 * caller to paste a revision invites pasting the one that was approved — which turns
 * a staleness check into a tautology.
 */
test('a review crosses worktrees and its applicability follows the candidate', () => {
  const f = bootstrapped({ agentId: 'fullstack-01', role: 'fullstack' });
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const linked = path.join(f.dir, 'wt-reviewer');
  git(['worktree', 'add', linked, '-b', 'review'], f.repo);
  const g = { dir: f.dir, repo: linked, home: f.home };
  run(['setup', '--agent-id', 'reviewer-01', '--role', 'reviewer', '--harness', 'codex', '--repo', linked], g);

  const head = `git:${git(['rev-parse', 'HEAD'], f.repo)}`;
  writeDraft(g, {
    sessionId: 'feature:coupon', taskId: 'task:coupon-api', status: 'approved',
    candidateRevision: head, requirementsRevision: `sha256:${'1'.repeat(64)}`,
    summary: 'AC-1 holds; the discount is applied in the domain layer.',
  }, 'review.json');
  const recorded = JSON.parse(run(['review', 'record', '--review', 'review.json'], g).stdout);
  assert.equal(recorded.reviewId, 'review:coupon-api-1');
  // The reviewer came from the binding, like a handoff's `from`: a decision whose
  // author is whatever was typed is one anyone can attribute to anyone.
  assert.deepEqual(recorded.decision.reviewer, { subject: 'agent:reviewer-01', role: 'reviewer' });

  // The implementer asks about its own HEAD without naming it, and both worktrees
  // are on the same commit, so the approval covers what it has.
  const fresh = JSON.parse(run(['review', 'state', '--session', 'feature:coupon',
    '--task', 'task:coupon-api'], f).stdout);
  assert.deepEqual([fresh.status, fresh.applies, fresh.reasons], ['approved', true, []]);
  assert.equal(fresh.current.candidateRevision, head, 'the answer says which candidate it is about');

  // Then it commits, and the same command — unchanged, still naming no revision —
  // reports that the approval no longer covers what it has (plan §17 Scenario 5).
  fs.writeFileSync(path.join(f.repo, 'coupon.md'), '# coupon\n');
  git(['add', 'coupon.md'], f.repo);
  git(['commit', '-m', 'coupon domain rule'], f.repo);
  const moved = JSON.parse(run(['review', 'state', '--session', 'feature:coupon',
    '--task', 'task:coupon-api'], f).stdout);
  assert.deepEqual([moved.applies, moved.reasons], [false, ['candidate-moved']]);
  assert.equal(moved.observed.candidateRevision, head);

  // An explicit --candidate still wins, so the approved revision can be named on
  // purpose: "what did it approve?" is a different question from "does it still
  // apply?", and both have to be askable.
  assert.equal(JSON.parse(run(['review', 'state', '--session', 'feature:coupon',
    '--task', 'task:coupon-api', '--candidate', head], f).stdout).applies, true);

  const listed = JSON.parse(run(['review', 'show', '--session', 'feature:coupon'], f).stdout);
  assert.deepEqual(listed.map((r) => r.reviewId), ['review:coupon-api-1']);
  assert.equal(JSON.parse(run(['review', 'show', '--session', 'feature:coupon',
    '--review', 'review:coupon-api-1'], f).stdout).decisionDigest, recorded.decisionDigest);

  const events = JSON.parse(run(['session', 'events', '--session', 'feature:coupon'], f).stdout);
  assert.deepEqual(events.filter((e) => e.kind === 'review-recorded')
    .map((e) => [e.actor, e.actorRole, e.status]), [['agent:reviewer-01', 'reviewer', 'approved']]);
});

/**
 * The refusals a reviewer will actually hit, as exit codes.
 *
 * All 3, none 4: none of these get better by being retried. A wrapper that read
 * `REVIEW_SELF` as retryable would sit in a loop while the one thing that would fix
 * it — a different agent — never happens.
 */
test('the CLI refuses reviews that would record a decision nobody could trust', () => {
  const f = bootstrapped({ agentId: 'fullstack-01', role: 'fullstack' });
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);
  const head = `git:${git(['rev-parse', 'HEAD'], f.repo)}`;
  const base = {
    sessionId: 'feature:coupon', taskId: 'task:coupon-api', status: 'approved',
    candidateRevision: head, requirementsRevision: `sha256:${'1'.repeat(64)}`,
    summary: 'AC-1 holds.',
  };

  // From the implementer's own worktree: it owns the task, so it cannot review it,
  // and the binding is what says so — there is no flag that talks it round.
  writeDraft(f, base, 'review.json');
  assert.deepEqual(refusal(['review', 'record', '--review', 'review.json'], f),
    { code: 'REVIEW_SELF', exit: 3 });
  assert.deepEqual(refusal(['review', 'record', '--review', 'review.json', '--role', 'reviewer'], f),
    { code: 'REVIEW_SELF', exit: 3 });

  const linked = path.join(f.dir, 'wt-reviewer');
  git(['worktree', 'add', linked, '-b', 'review'], f.repo);
  const g = { dir: f.dir, repo: linked, home: f.home };
  run(['setup', '--agent-id', 'reviewer-01', '--role', 'reviewer', '--harness', 'codex', '--repo', linked], g);

  for (const [name, over, expected] of [
    ['a requirement the task never declared', { requirementsRevision: `sha256:${'9'.repeat(64)}` },
      'REVIEW_REQUIREMENT_UNKNOWN'],
    ['an approval naming no requirement', { requirementsRevision: undefined }, 'MALFORMED_REVIEW'],
    ['an approval over an open blocker', {
      findings: [{
        schemaVersion: 1, findingId: 'FIND-001', severity: 'blocker', status: 'open',
        candidateRevision: head, requirement: 'AC-1', location: 'src/coupon.ts:1',
        evidence: 'Two coupons both apply.', impact: 'The total can go negative.',
        requiredOutcome: 'At most one applies.',
      }],
    }, 'REVIEW_INCONSISTENT'],
    ['a status the vocabulary does not have', { status: 'lgtm' }, 'UNKNOWN_REVIEW_STATUS'],
    ['a field the ledger owns', { reviewer: { subject: 'agent:elsewhere', role: 'reviewer' } },
      'MALFORMED_REVIEW'],
  ]) {
    writeDraft(g, { ...base, ...over }, 'review.json');
    assert.deepEqual(refusal(['review', 'record', '--review', 'review.json'], g),
      { code: expected, exit: 3 }, name);
  }

  // Nothing was recorded, so the next legitimate decision is still seq 1: a refusal
  // that consumed a sequence number would leave a gap the event log cannot explain.
  assert.deepEqual(JSON.parse(run(['review', 'show', '--session', 'feature:coupon'], g).stdout), []);
  writeDraft(g, base, 'review.json');
  assert.equal(JSON.parse(run(['review', 'record', '--review', 'review.json'], g).stdout).seq, 1);
});

/** The shipped template must record as-is, or it is documentation of a wish. */
test('the shipped review template records with only its ids filled in', () => {
  const f = bootstrapped({ agentId: 'fullstack-01', role: 'fullstack' });
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'task-packet.json'), 'utf8'));
  run(['session', 'start', '--session', shipped.sessionId, '--target', 'main'], f);
  writePacket(f, shipped);
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const linked = path.join(f.dir, 'wt-reviewer');
  git(['worktree', 'add', linked, '-b', 'review'], f.repo);
  const g = { dir: f.dir, repo: linked, home: f.home };
  run(['setup', '--agent-id', 'reviewer-01', '--role', 'reviewer', '--harness', 'codex', '--repo', linked], g);

  const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'review-decision.json'), 'utf8'));
  writeDraft(g, { ...template, sessionId: shipped.sessionId, taskId: shipped.taskId }, 'review.json');
  const recorded = JSON.parse(run(['review', 'record', '--review', 'review.json'], g).stdout);
  assert.equal(recorded.seq, 1);
  assert.ok(recorded.decisionDigest.startsWith('sha256:'));
  // The template carries an open `minor` and still approved: only a blocker refuses,
  // and the count is reported so the approval does not read as "nothing found".
  assert.equal(JSON.parse(run(['review', 'state', '--session', shipped.sessionId,
    '--task', shipped.taskId, '--candidate', template.candidateRevision], g).stdout).unresolvedFindings, 1);
});

/** A check the fixture can actually run, without a package.json or a network. */
function nodeCheck(script) {
  return `"${process.execPath}" -e "${script}"`;
}

function validationPacket(overrides = {}) {
  return taskPacket({
    validationPlan: [
      {
        checkId: 'unit-tests', kind: 'command', requiredAt: ['handoff', 'merge'],
        command: nodeCheck(`console.log('unit tests green')`),
      },
      {
        checkId: 'contract-tests', kind: 'command', requiredAt: ['merge'],
        command: nodeCheck(`console.error('AC-1 regressed'); process.exit(1)`),
      },
      { checkId: 'peer-review', kind: 'review', requiredAt: ['merge'], role: 'reviewer' },
    ],
    ...overrides,
  });
}

/**
 * The whole point of a validation plan, end to end (plan §6, §7).
 *
 * What this is really testing is that a gate's answer is derived from records and the
 * current candidate every single time, and so cannot be stale — only unknown. The
 * three-valued answer is the load-bearing part: after a commit the failing check stops
 * reading as failed, because nothing has been run against what the caller now has.
 */
test('validate run records evidence, and the gate answer follows the candidate', () => {
  const f = bootstrapped({ agentId: 'fullstack-01', role: 'fullstack' });
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, validationPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);
  const args = ['--session', 'feature:coupon', '--task', 'task:coupon-api'];

  // Before anything runs, the gate is unknown rather than failed: nobody has claimed
  // the suite is broken, only that nobody has looked.
  const cold = JSON.parse(run(['validate', 'state', ...args, '--gate', 'handoff'], f).stdout);
  assert.deepEqual([cold.status, cold.required, cold.unknown], ['unknown', 1, 1]);
  assert.deepEqual(cold.checks[0].reasons, ['no-evidence']);

  // The handoff gate asks for one check, so running the gate runs one check — the
  // merge-only contract suite is not the implementer's toll to pay here.
  const handoffRun = JSON.parse(run(['validate', 'run', ...args, '--gate', 'handoff'], f).stdout);
  assert.deepEqual([handoffRun.ran, handoffRun.awaitingReview], [1, []]);
  const first = handoffRun.evidence[0];
  assert.deepEqual([first.evidenceId, first.checkId, first.status, first.exitCode],
    ['evidence:unit-tests-1', 'unit-tests', 'passed', 0]);
  assert.match(first.outputExcerpt, /unit tests green/, 'the record keeps what it saw, not just a verdict');
  assert.ok(first.recordDigest.startsWith('sha256:'));
  assert.equal(JSON.parse(run(['validate', 'state', ...args, '--gate', 'handoff'], f).stdout).status, 'passed');

  // The same evidence counts toward merge — a check required at two gates is one check,
  // not two — but merge asks for more, and the rest is still unmeasured.
  const beforeMerge = JSON.parse(run(['validate', 'state', ...args, '--gate', 'merge'], f).stdout);
  assert.deepEqual([beforeMerge.status, beforeMerge.required, beforeMerge.passed, beforeMerge.unknown],
    ['unknown', 3, 1, 2]);

  const mergeRun = JSON.parse(run(['validate', 'run', ...args, '--gate', 'merge'], f).stdout);
  // The review check is reported, not run and not dropped: `validate run` covering a
  // gate it cannot finish would read as if it had.
  assert.deepEqual(mergeRun.awaitingReview, [{ checkId: 'peer-review', role: 'reviewer' }]);
  // Sequence numbers are per session, not per check, so two ids can never collide even
  // when the same check is rerun.
  assert.deepEqual(mergeRun.evidence.map((e) => [e.evidenceId, e.status]),
    [['evidence:unit-tests-2', 'passed'], ['evidence:contract-tests-3', 'failed']]);

  const failing = JSON.parse(run(['validate', 'state', ...args, '--gate', 'merge'], f).stdout);
  assert.deepEqual([failing.status, failing.failed], ['failed', 1]);

  assert.deepEqual(JSON.parse(run(['validate', 'show', '--session', 'feature:coupon'], f).stdout)
    .map((e) => e.evidenceId),
  ['evidence:unit-tests-1', 'evidence:unit-tests-2', 'evidence:contract-tests-3']);
  assert.equal(JSON.parse(run(['validate', 'show', '--session', 'feature:coupon',
    '--check', 'unit-tests'], f).stdout).length, 2);
  assert.equal(JSON.parse(run(['validate', 'show', '--session', 'feature:coupon',
    '--evidence', 'evidence:unit-tests-1'], f).stdout).recordDigest, first.recordDigest);

  // A reviewer approves the work and cites the run it read. The gate still refuses,
  // because a human approval does not overrule a failing check — and that is the
  // separation the two check kinds exist for.
  const linked = path.join(f.dir, 'wt-reviewer');
  git(['worktree', 'add', linked, '-b', 'review'], f.repo);
  const g = { dir: f.dir, repo: linked, home: f.home };
  run(['setup', '--agent-id', 'reviewer-01', '--role', 'reviewer', '--harness', 'codex', '--repo', linked], g);
  const head = `git:${git(['rev-parse', 'HEAD'], f.repo)}`;
  writeDraft(g, {
    sessionId: 'feature:coupon', taskId: 'task:coupon-api', status: 'approved',
    candidateRevision: head, requirementsRevision: `sha256:${'1'.repeat(64)}`,
    summary: 'AC-1 holds in the domain layer; the contract suite failure is pre-existing.',
    validationEvidence: ['evidence:unit-tests-2'],
  }, 'review.json');
  run(['review', 'record', '--review', 'review.json'], g);
  const approved = JSON.parse(run(['validate', 'state', ...args, '--gate', 'merge'], f).stdout);
  assert.deepEqual([approved.status, approved.passed, approved.failed], ['failed', 2, 1]);

  // Then the implementer commits. Every answer above described a candidate that no
  // longer exists, so the gate goes quiet rather than confident: the failure is not
  // reported as fixed, and the approval is not reported as still standing.
  fs.writeFileSync(path.join(f.repo, 'coupon.md'), '# coupon\n');
  git(['add', 'coupon.md'], f.repo);
  git(['commit', '-m', 'coupon domain rule'], f.repo);
  const moved = JSON.parse(run(['validate', 'state', ...args, '--gate', 'merge'], f).stdout);
  assert.deepEqual([moved.status, moved.unknown, moved.failed], ['unknown', 3, 0]);
  assert.deepEqual(moved.checks.map((c) => c.reasons),
    [['candidate-moved'], ['candidate-moved'], ['candidate-moved']]);

  const events = JSON.parse(run(['session', 'events', '--session', 'feature:coupon'], f).stdout);
  assert.deepEqual(events.filter((e) => e.kind === 'evidence-recorded')
    .map((e) => [e.checkId, e.status, e.actor]), [
    ['unit-tests', 'passed', 'agent:fullstack-01'],
    ['unit-tests', 'passed', 'agent:fullstack-01'],
    ['contract-tests', 'failed', 'agent:fullstack-01'],
  ]);
});

/**
 * The refusals that keep evidence and citations honest.
 *
 * All 3 rather than 4: none of them get better by being retried unchanged. The dirty
 * worktree is the interesting one — it is the only refusal in this CLI that is about
 * the working copy rather than the ledger, and it exists because evidence names the
 * commit it is evidence about.
 */
test('the CLI refuses evidence and citations that would misdescribe what ran', () => {
  const f = bootstrapped({ agentId: 'fullstack-01', role: 'fullstack' });
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, validationPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);
  const args = ['--session', 'feature:coupon', '--task', 'task:coupon-api'];

  // A modified tracked file means the suite ran against something no commit contains,
  // and there is no flag to record it anyway: a knowingly-wrong candidate is worse
  // than no record, because it is indistinguishable from a real one afterwards.
  fs.writeFileSync(path.join(f.repo, 'README.md'), '# fixture\nedited\n');
  const dirty = refusal(['validate', 'run', ...args, '--gate', 'handoff'], f);
  assert.deepEqual(dirty, { code: 'WORKTREE_DIRTY', exit: 3 });
  assert.deepEqual(JSON.parse(run(['validate', 'show', '--session', 'feature:coupon'], f).stdout), [],
    'a refused run records nothing, so the next real run is still seq 1');
  git(['commit', '-am', 'edit readme'], f.repo);
  assert.equal(JSON.parse(run(['validate', 'run', ...args, '--gate', 'handoff'], f).stdout).ran, 1);

  // An untracked scratch file is not a candidate change; packet.json itself is one, so
  // the run above already proves it, and this makes the intent explicit.
  fs.writeFileSync(path.join(f.repo, 'notes.txt'), 'scratch\n');
  assert.equal(JSON.parse(run(['validate', 'run', ...args, '--check', 'unit-tests'], f).stdout).ran, 1);

  assert.deepEqual(refusal(['validate', 'state', ...args, '--gate', 'ship-it'], f),
    { code: 'UNKNOWN_VALIDATION_GATE', exit: 3 });
  // A check the packet never declared is a typo in the invocation, not a refusal by the
  // ledger: nothing was asked of it, so it exits 1 and says what the packet does declare.
  const unknown = run(['validate', 'run', ...args, '--check', 'lint'], f, 1);
  assert.match(unknown.stderr, /declares no check "lint".*unit-tests, contract-tests, peer-review/s);
  // Evidence cannot answer a review check: that judgement lives in one place.
  assert.deepEqual(refusal(['validate', 'run', ...args, '--check', 'peer-review'], f), null,
    'selecting a review check runs nothing rather than refusing');

  const linked = path.join(f.dir, 'wt-reviewer');
  git(['worktree', 'add', linked, '-b', 'review'], f.repo);
  const g = { dir: f.dir, repo: linked, home: f.home };
  run(['setup', '--agent-id', 'reviewer-01', '--role', 'reviewer', '--harness', 'codex', '--repo', linked], g);
  const head = `git:${git(['rev-parse', 'HEAD'], f.repo)}`;
  const base = {
    sessionId: 'feature:coupon', taskId: 'task:coupon-api', status: 'approved',
    candidateRevision: head, requirementsRevision: `sha256:${'1'.repeat(64)}`,
    summary: 'AC-1 holds.',
  };
  for (const [name, cited, expected] of [
    ['a citation nobody can resolve', ['evidence:unit-tests-99'], 'REVIEW_EVIDENCE_UNKNOWN'],
    ['a citation that is not an id at all', ['npm test'], 'REVIEW_EVIDENCE_UNKNOWN'],
    ['the same run cited twice', ['evidence:unit-tests-1', 'evidence:unit-tests-1'], 'MALFORMED_REVIEW'],
  ]) {
    writeDraft(g, { ...base, validationEvidence: cited }, 'review.json');
    assert.deepEqual(refusal(['review', 'record', '--review', 'review.json'], g),
      { code: expected, exit: 3 }, name);
  }

  // The citation resolves, but it is about the commit before this one. Left standing it
  // would be the most convincing kind of false confidence: a real record, correctly
  // sealed, describing something else (plan §17 Scenario 5).
  fs.writeFileSync(path.join(f.repo, 'coupon.md'), '# coupon\n');
  git(['add', 'coupon.md'], f.repo);
  git(['commit', '-m', 'coupon domain rule'], f.repo);
  const moved = `git:${git(['rev-parse', 'HEAD'], f.repo)}`;
  writeDraft(g, { ...base, candidateRevision: moved, validationEvidence: ['evidence:unit-tests-1'] }, 'review.json');
  assert.deepEqual(refusal(['review', 'record', '--review', 'review.json'], g),
    { code: 'REVIEW_EVIDENCE_MISMATCH', exit: 3 });
});


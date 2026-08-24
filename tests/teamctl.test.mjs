import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  CLI, ROOT, bootstrapped, fixture, git, refusal, run, taskPacket, writeDraft, writePacket,
} from './helpers/cli.mjs';

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
// that two worktrees really do land on one ledger. The fixtures are in
// tests/helpers/cli.mjs, shared with the §17 scenario suite.

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

/**
 * A check the fixture can actually run, without a package.json or a network.
 *
 * argv rather than a line, which also retires the quoting this used to need: the script
 * is one word no matter what punctuation is in it.
 */
function nodeArgv(script) {
  return [process.execPath, '-e', script];
}

function validationPacket(overrides = {}) {
  return taskPacket({
    validationPlan: [
      {
        checkId: 'unit-tests', kind: 'command', requiredAt: ['handoff', 'merge'],
        argv: nodeArgv(`console.log('unit tests green')`),
      },
      {
        checkId: 'contract-tests', kind: 'command', requiredAt: ['merge'],
        argv: nodeArgv(`console.error('AC-1 regressed'); process.exit(1)`),
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
 * The `shell-command` kind, end to end, because a kind that only the schema believes in
 * is worse than one that does not exist.
 *
 * Two separate narrowings hide here and neither shows up in a plain `command` test: the
 * runner's selection filter and the ledger's evidence guard. Either one reverting to
 * `kind === 'command'` leaves a check that a packet may declare, that a gate then
 * requires, and that `validate run` reports as covered having run nothing — or refuses
 * to record after running. So the assertion is not "it ran" but "the gate it was
 * required at now reads passed".
 */
test('a shell-command check is run and recorded, not quietly skipped', () => {
  const f = bootstrapped({ agentId: 'fullstack-01', role: 'fullstack' });
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  // Two statements joined by `&&`: no argv can express this, which is the only reason
  // the kind exists. `node` twice rather than a launcher — npm is a batch file.
  const line = `"${process.execPath}" -e "console.log('first')" `
    + `&& "${process.execPath}" -e "console.log('second')"`;
  writePacket(f, validationPacket({
    validationPlan: [
      { checkId: 'contract-tests', kind: 'shell-command', requiredAt: ['merge'], command: line },
    ],
  }));
  run(['task', 'issue', '--packet', 'packet.json'], f);
  const args = ['--session', 'feature:coupon', '--task', 'task:coupon-api'];

  const ran = JSON.parse(run(['validate', 'run', ...args, '--gate', 'merge'], f).stdout);
  assert.deepEqual([ran.ran, ran.awaitingReview], [1, []], 'the check was selected, not filtered out');
  assert.deepEqual([ran.evidence[0].checkId, ran.evidence[0].status], ['contract-tests', 'passed']);
  // Both halves of the line ran, which is what proves a shell was actually involved
  // rather than the first word having been spawned with the rest as arguments.
  assert.match(ran.evidence[0].outputExcerpt, /first[\s\S]*second/);
  assert.equal(JSON.parse(run(['validate', 'state', ...args, '--gate', 'merge'], f).stdout).status, 'passed');
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

// --------------------------------------------------------------- spec-suite handoff
// tests/spec-suite.test.mjs owns detection and projection semantics. What is left to
// the CLI is the part only it decides: which spec-suite location it looked at, whether
// a wrong answer there is a health finding, and what lands in a file that spec-suite
// will read without complaining about anything it does not recognise.

/** A minimal install that answers the probe: the concurrency contract, and nothing else. */
function fakeSpecSuite(f, { name = 'spec-suite', keeps = ['baseRevision', 'readSet', 'writeSet', 'subject', 'role'] } = {}) {
  const root = path.join(f.dir, name);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'control-plane-concurrency.mjs'),
    'export function projectionConcurrencyFields(task) {\n'
    + `  const keeps = ${JSON.stringify(keeps)};\n`
    + '  const out = {};\n'
    + '  for (const k of keeps) out[k] = task[k];\n'
    + '  return out;\n}\n');
  return root;
}

const noSpecSuiteEnv = { SPEC_SUITE_ROOT: '' };

/**
 * A repository without spec-suite is not a sick repository.
 *
 * Most are not using it, and a doctor that reported unhealthy for the ordinary case would
 * teach its readers that exit 2 means nothing. The section still appears, because "there is
 * no spec-suite here" is the answer to the question that was asked.
 */
test('doctor reports an absent spec-suite without calling the worktree unhealthy', () => {
  const f = bootstrapped();
  const out = JSON.parse(run(['doctor', '--repo', '.', '--with-spec-suite'], { ...f, env: noSpecSuiteEnv }).stdout);
  assert.equal(out.status, 'healthy');
  assert.equal(out.specSuite.source, 'probed');
  assert.equal(out.specSuite.compatibilityMode, 'partial');
  assert.deepEqual(out.specSuite.unsupported.sort(),
    ['mergeGate', 'multiAgentConcurrency', 'semanticValidator', 'structuralRevalidation']);
  // Not `unsupported`: the module that would have answered it is the one that is missing.
  assert.deepEqual(out.specSuite.unknown, ['semanticInputs']);
  assert.equal(out.specSuite.projectableFields.discovered, false);
});

/**
 * Asserting a location is a claim, and a false claim is what doctor is for.
 *
 * The asymmetry with the test above is deliberate. Nobody said there was a spec-suite in
 * the default case; here somebody did, by typing a path — and a typo in that path would
 * otherwise produce a full run whose every capability read `unknown` for a reason that had
 * nothing to do with spec-suite.
 */
test('a spec-suite path that was asserted and is not there is a health finding', () => {
  const f = bootstrapped();
  const missing = path.join(f.dir, 'not-installed-here');
  for (const [name, args, env] of [
    ['named on the command line', ['--spec-suite', missing], noSpecSuiteEnv],
    ['named in the environment', [], { SPEC_SUITE_ROOT: missing }],
  ]) {
    const res = run(['doctor', '--repo', '.', '--with-spec-suite', ...args], { ...f, env }, 2);
    const out = JSON.parse(res.stdout);
    assert.equal(out.status, 'unhealthy', name);
    const finding = out.checks.find((c) => c.name === 'spec-suite-root');
    assert.equal(finding.ok, false, name);
    assert.match(finding.detail, /does not exist/, name);
    // And the capabilities read unknown rather than unsupported, because nothing was looked at.
    assert.equal(out.specSuite.source, 'unavailable', name);
    assert.equal(out.specSuite.unsupported.length, 0, name);
  }
});

test('doctor reports what a real install demonstrated, and stays healthy about the rest', () => {
  const f = bootstrapped();
  const root = fakeSpecSuite(f);
  const out = JSON.parse(run(['doctor', '--repo', '.', '--with-spec-suite', '--spec-suite', root],
    { ...f, env: noSpecSuiteEnv }).stdout);
  assert.equal(out.status, 'healthy');
  assert.equal(out.specSuite.capabilities.multiAgentConcurrency.support, 'supported');
  assert.equal(out.specSuite.capabilities.semanticInputs.support, 'unsupported');
  assert.equal(out.specSuite.projectableFields.discovered, true);
  // No handshake, so no versions — and doctor says so rather than leaving the reader to
  // notice five nulls.
  assert.equal(out.specSuite.protocolVersion, null);
  assert.ok(out.specSuite.notes.some((n) => /probed, not declared/.test(n)));
});

/**
 * The projection comes from the frozen packet, not from the file it was issued with.
 *
 * The plan sketches `project-spec-task --task task.json`, and a file is the wrong source:
 * it is editable, so the spec-suite task could describe work no team task authorised. This
 * proves the substitution — the packet on disk is rewritten between issue and projection,
 * and the projection ignores it.
 */
test('project-spec-task projects the frozen packet and reports what stayed behind', () => {
  const f = bootstrapped();
  const env = { SPEC_SUITE_ROOT: fakeSpecSuite(f) };
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);
  writePacket(f, taskPacket({ writeSet: ['src/**', '.github/**'] }));

  const out = JSON.parse(run(['project-spec-task', '--session', 'feature:coupon',
    '--task', 'task:coupon-api'], { ...f, env }).stdout);
  assert.deepEqual(out.projection.writeSet, ['src/coupon/**'], 'the edited file must not be the source');
  assert.deepEqual(out.projected,
    ['baseRevision', 'readSet', 'role', 'subject', 'taskId', 'writeSet']);
  assert.equal(out.generation, 1);
  assert.match(out.frozenDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(out.capabilitySource, 'probed');

  // §17 Scenario 2's accepted cost, said out loud at the moment it starts applying.
  assert.equal(out.compatibility.mode, 'degraded');
  const inputs = out.withheld.find((w) => w.field === 'inputs');
  assert.deepEqual([inputs.reason, inputs.capability], ['capability-unsupported', 'semanticInputs']);
  assert.equal(out.withheld.find((w) => w.field === 'validationPlan').reason, 'team-layer-owned');
});

/**
 * A file spec-suite reads must contain nothing spec-suite does not read.
 *
 * This is the one place the silent-acceptance hazard becomes a file on disk: were the
 * compatibility report written alongside the projection, spec-suite's validator would accept
 * it without a word and the extras would sit there looking authoritative forever.
 */
test('project-spec-task --output writes the projection alone', () => {
  const f = bootstrapped();
  const env = { SPEC_SUITE_ROOT: fakeSpecSuite(f) };
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const out = JSON.parse(run(['project-spec-task', '--session', 'feature:coupon',
    '--task', 'task:coupon-api', '--output', 'spec-task.json'], { ...f, env }).stdout);
  const written = JSON.parse(fs.readFileSync(path.join(f.repo, 'spec-task.json'), 'utf8'));
  assert.deepEqual(written, out.projection);
  /**
   * Spelled out as a literal, not as `out.projected`.
   *
   * The report and the file are written by the same code, so comparing them proves only that it
   * is self-consistent — a projection that dropped a field would drop it from both and the
   * assertion would follow it down. This list is what spec-suite's task contract actually reads,
   * and `schemaVersion` is on it because `project-context.mjs` demands it while the merge gate
   * never looks; the file has to satisfy both.
   */
  assert.deepEqual(Object.keys(written).sort(),
    ['baseRevision', 'readSet', 'role', 'schemaVersion', 'subject', 'taskId', 'writeSet']);
  assert.deepEqual(Object.keys(written).sort(), [...out.projected, 'schemaVersion'].sort());
  for (const teamOnly of ['sessionId', 'compatibility', 'withheld', 'inputs', 'validationPlan', 'frozenDigest']) {
    assert.equal(teamOnly in written, false, `${teamOnly} must not reach spec-suite`);
  }
  /**
   * `taskId` is the counter-example, so it is asserted rather than merely absent from the list above.
   *
   * It used to be on it. The merge gate refuses a task whose `taskId` is not a non-empty string, so
   * withholding it produced a file the real gate could not read at all — the hazard this test names
   * runs both ways, and a field spec-suite requires is not a leak.
   */
  assert.equal(written.taskId, 'task:coupon-api');
  assert.equal(out.output, path.join(f.repo, 'spec-task.json'));
});

/**
 * An install that carries semantic inputs gets them, and the same command stops warning.
 *
 * The compatibility mode has to be able to reach `full`, or it is decoration: a status that
 * is always `degraded` tells a reader nothing about their install.
 */
test('project-spec-task carries semantic inputs to a far side that keeps them', () => {
  const f = bootstrapped();
  const env = {
    SPEC_SUITE_ROOT: fakeSpecSuite(f, {
      name: 'spec-suite-next',
      keeps: ['baseRevision', 'readSet', 'writeSet', 'subject', 'role', 'inputs'],
    }),
  };
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const out = JSON.parse(run(['project-spec-task', '--session', 'feature:coupon',
    '--task', 'task:coupon-api'], { ...f, env }).stdout);
  assert.equal(out.compatibility.mode, 'full');
  assert.deepEqual(out.projection.inputs, taskPacket().inputs);
  assert.equal(out.withheld.some((w) => w.field === 'inputs'), false);
  assert.equal(out.compatibility.warnings.some((w) => /only enforced here/.test(w)), false);
});

/**
 * Plan §12, from the side that matters: an Agent that has just lost its context.
 *
 * The command has to answer from the repository rather than from anything it was told, so the
 * only input the test gives it is a worktree. A worktree with no binding cannot even say who is
 * asking, and answering anything else would be answering about the wrong Agent.
 */
test('reconcile on an unbound worktree says so instead of guessing whose it is', () => {
  const f = fixture();
  const out = JSON.parse(run(['reconcile'], f).stdout);
  assert.equal(out.status, 'unbound');
  assert.equal(out.nextAction, 'bind-worktree');
  assert.equal(out.agent, null);
});

test('reconcile with no session tells the agent to open one', () => {
  const f = bootstrapped();
  const out = JSON.parse(run(['reconcile'], f).stdout);
  assert.equal(out.status, 'idle');
  assert.equal(out.nextAction, 'open-session');
  assert.equal(out.agent, 'fullstack-01');
});

/**
 * The exit code is 0 whatever reconcile finds, including a block.
 *
 * A recovering Agent runs this before it can trust anything else it remembers. If "you have a
 * review to address" exited non-zero it would be indistinguishable from the tool having failed
 * to look — and of every outcome, that is the one that must never be confusable, because the
 * Agent's fallback when a command fails is exactly the remembered state this command exists to
 * replace.
 */
test('reconcile finds this agent task and answers at exit 0 whatever it finds', () => {
  const f = bootstrapped();
  const head = git(['rev-parse', 'HEAD'], f.repo);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], f.repo);
  run(['session', 'start', '--session', 'feature:coupon', '--target', branch], f);
  writePacket(f, taskPacket({ baseRevision: `git:${head}` }));
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const out = JSON.parse(run(['reconcile'], f).stdout);
  assert.equal(out.agent, 'fullstack-01');
  assert.equal(out.session, 'feature:coupon');
  assert.equal(out.task, 'task:coupon-api');
  assert.equal(out.freshness.git, 'fresh', 'the task is based on the target branch current commit');
  assert.equal(out.detail.role, 'fullstack');
  assert.equal(out.detail.taskStatus, 'issued');
  // The packet requires unit-tests at the handoff gate and nothing has been recorded, so the
  // gate is unestablished rather than passed — and unestablished is work, not a block.
  assert.equal(out.status, 'ready');
  assert.equal(out.nextAction, 'run-validation');
});

/**
 * A task addressed to somebody else is not this Agent's task.
 *
 * One session holds several Agents' tasks by design, so the filter on `frozen.subject` is the
 * only thing standing between a recovering Agent and somebody else's work — and it would be
 * handed over with the ledger's blessing, writeSet and all.
 *
 * The session is reached twice here by two different routes: `--session` names it, and blind,
 * `participation` finds it from this Agent's own events. What must not differ between the routes
 * is the task, and `await-task` is right either way — an Agent that issued work to somebody else
 * is waiting on it, not sitting in a repository with no session in it. Blind used to answer
 * `open-session`, which told it to start a second session for work it had just set up itself.
 */
test('reconcile ignores a task addressed to another agent', () => {
  const f = bootstrapped();
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket({ taskId: 'task:coupon-review', subject: 'agent:reviewer-01', role: 'reviewer' }));
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const named = JSON.parse(run(['reconcile', '--session', 'feature:coupon'], f).stdout);
  assert.equal(named.status, 'idle');
  assert.equal(named.nextAction, 'await-task');
  assert.equal(named.task, null, "the reviewer's task is not answered about");
  assert.match(named.reasons[0], /feature:coupon has no task addressed to this agent/);

  const blind = JSON.parse(run(['reconcile'], f).stdout);
  assert.deepEqual([blind.session, blind.task, blind.nextAction],
    ['feature:coupon', null, 'await-task'], 'the flag changes how the session is found, not the answer');
});

/**
 * Finishing one task does not make it the task, while another is still open.
 *
 * The completed task is the most recently touched, so recency alone would answer with it — and
 * `integrate the thing you finished` is a plausible-looking answer that abandons work in
 * progress. Terminal tasks rank last and are chosen only when nothing else is open, which is
 * also what makes them reachable at all: an Agent whose last act was completing a task still
 * needs to be told to get it reviewed.
 */
test('reconcile prefers the open task over the one just completed', () => {
  const f = bootstrapped();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], f.repo);
  run(['session', 'start', '--session', 'feature:coupon', '--target', branch], f);
  writePacket(f, taskPacket({ taskId: 'task:coupon-api' }));
  run(['task', 'issue', '--packet', 'packet.json'], f);
  writePacket(f, taskPacket({ taskId: 'task:coupon-ui' }), 'packet-2.json');
  run(['task', 'issue', '--packet', 'packet-2.json'], f);
  for (const status of ['in-progress', 'completed']) {
    run(['task', 'set-status', '--session', 'feature:coupon', '--task', 'task:coupon-api',
      '--status', status], f);
  }

  const out = JSON.parse(run(['reconcile'], f).stdout);
  assert.equal(out.task, 'task:coupon-ui', 'the finished task is the most recent, and still not the answer');
  assert.equal(out.detail.taskStatus, 'issued');
});

/**
 * The gate follows the task's status, because the caller cannot be asked which gate it is at.
 *
 * An Agent that has just lost its context is exactly the caller that cannot supply `--gate`, and
 * the two gates require different checks. Reporting the handoff gate for finished work would call
 * a task validated when the merge gate's checks had never run — `passed` on the strength of
 * having asked an easier question.
 */
test('reconcile reads completed work against the merge gate, not the handoff gate', () => {
  const f = bootstrapped();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], f.repo);
  run(['session', 'start', '--session', 'feature:coupon', '--target', branch], f);
  writePacket(f, taskPacket({
    validationPlan: [
      { checkId: 'unit-tests', kind: 'command', requiredAt: ['handoff'], argv: ['npm', 'test'] },
      { checkId: 'contract-tests', kind: 'command', requiredAt: ['merge'], argv: ['npm', 'run', 'contract'] },
    ],
  }));
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const open = JSON.parse(run(['reconcile'], f).stdout);
  assert.equal(open.detail.validation.gate, 'handoff');
  assert.equal(open.detail.validation.required, 1);

  for (const status of ['in-progress', 'completed']) {
    run(['task', 'set-status', '--session', 'feature:coupon', '--task', 'task:coupon-api',
      '--status', status], f);
  }
  const done = JSON.parse(run(['reconcile'], f).stdout);
  assert.equal(done.detail.validation.gate, 'merge', 'finished work faces the merge gate');
  assert.equal(done.detail.validation.required, 1);
  // Same command, different gate: `--gate` stays for what the mapping cannot know about, such as
  // revalidating at the handoff gate after a rebase.
  const forced = JSON.parse(run(['reconcile', '--gate', 'handoff'], f).stdout);
  assert.equal(forced.detail.validation.gate, 'handoff');
});

/**
 * A base commit this worktree does not have leaves ancestry unanswered, not answered "no".
 *
 * `merge-base --is-ancestor` says yes with exit 0 and no with exit 1, and anything above that is
 * git declining to answer — most often a commit that exists somewhere else. Both readings report
 * `stale`, so the difference lands entirely in the detail, and it is the difference between "the
 * target moved ahead, rebase" and "the histories diverged, do not rebase unattended". Telling an
 * Agent the histories diverged on the strength of an object it simply has not fetched is a
 * fabricated finding about somebody else's branch.
 */
test('reconcile admits when git could not establish ancestry', () => {
  const f = bootstrapped();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], f.repo);
  run(['session', 'start', '--session', 'feature:coupon', '--target', branch], f);
  writePacket(f, taskPacket({ baseRevision: `git:${'d'.repeat(40)}` }));
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const out = JSON.parse(run(['reconcile'], f).stdout);
  assert.equal(out.freshness.git, 'stale');
  assert.equal(out.detail.git.baseIsAncestor, null, 'git exited above 1: it did not say no');
  assert.match(out.detail.git.detail, /ancestry could not be established/);
  assert.doesNotMatch(out.detail.git.detail, /diverged/,
    'a divergence nobody established must not be reported as one');
});

/**
 * Reconcile refuses on a truncated log rather than deciding from what is left.
 *
 * The inbox tolerates an unreadable session because one corrupt session must not hide every other
 * session's mail, and `metrics` names it in `unreadable` for the same reason. Reconcile cannot:
 * this is the only session it is answering about, and "no unacknowledged handoffs" derived from a
 * log missing its tail is a confident wrong answer to the one question the command exists to
 * answer. Exit 3, so a wrapper can tell it from the exit 0 that carries a finding.
 */
test('reconcile refuses to answer from a log whose tail is missing', () => {
  const f = bootstrapped();
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const events = path.join(f.repo, '.git', 'team-layer', 'sessions', 'feature__coupon', 'events.jsonl');
  const lines = fs.readFileSync(events, 'utf8').split('\n').filter((line) => line !== '');
  assert.ok(lines.length > 1, 'the log needs a tail to lose');
  fs.writeFileSync(events, `${lines.slice(0, -1).join('\n')}\n`);

  assert.deepEqual(refusal(['reconcile'], f), { code: 'LEDGER_CORRUPT', exit: 3 });
});

/**
 * A session nobody could read is named, not quietly counted as no mail.
 *
 * The refusal above is only for the session being answered about. A corrupt session *elsewhere*
 * in the Agent home is tolerated, because refusing there would let one unreadable session take
 * recovery down for every agent — the tolerance `inbox` exists for. What that tolerance costs is
 * that "no unacknowledged handoffs" really means "none in the sessions I could read", and those
 * two are the same answer only when nothing was skipped. So the list has to be capable of being
 * non-empty: reporting it as always empty converts the tolerance back into the confident wrong
 * answer it was built to avoid, and every existing assertion on this field reads `[]` from a home
 * where `[]` is also the truth.
 */
test('reconcile names a session it could not read rather than counting it as no mail', () => {
  const f = bootstrapped();
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);
  // A second session, holding no task for this agent, so the answer still comes from the first.
  run(['session', 'start', '--session', 'feature:legacy', '--target', 'main'], f);

  const events = path.join(f.repo, '.git', 'team-layer', 'sessions', 'feature__legacy', 'events.jsonl');
  const kept = fs.readFileSync(events, 'utf8').split('\n').filter((line) => line !== '').slice(0, -1);
  fs.writeFileSync(events, kept.length ? `${kept.join('\n')}\n` : '');

  const out = JSON.parse(run(['reconcile'], f).stdout);
  assert.equal(out.session, 'feature:coupon', 'the readable session is still the one answered about');
  assert.deepEqual(out.detail.unreadableSessions,
    [{ sessionId: 'feature:legacy', code: 'LEDGER_CORRUPT' }]);
  assert.deepEqual(out.detail.unackedHandoffs, [],
    'an empty inbox next to a named unreadable session is honest; on its own it would not be');
});

/**
 * The default answer for inputs is `unknown`, and it is not a bug.
 *
 * This layer holds `{ id, revision }` and the canonical authority resolves revisions from
 * *paths*, so there is no way for reconcile to check freshness by itself while the revision
 * handshake is unbuilt. Reporting `fresh` would be inventing the check; reporting `unknown` and
 * naming the flag that supplies it is the honest version, and this test pins it so nobody
 * "tidies" the field to fresh later.
 */
test('reconcile reports inputs as unknown until somebody who can ask the authority answers', () => {
  const f = bootstrapped();
  const head = git(['rev-parse', 'HEAD'], f.repo);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], f.repo);
  run(['session', 'start', '--session', 'feature:coupon', '--target', branch], f);
  writePacket(f, taskPacket({ baseRevision: `git:${head}` }));
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const blind = JSON.parse(run(['reconcile'], f).stdout);
  assert.equal(blind.freshness.inputs, 'unknown');
  assert.deepEqual(blind.detail.inputs.unchecked, ['contract:coupon']);

  fs.writeFileSync(path.join(f.repo, 'canonical.json'),
    `${JSON.stringify([{ id: 'contract:coupon', revision: `sha256:${'1'.repeat(64)}` }])}\n`);
  const checked = JSON.parse(run(['reconcile', '--canonical-inputs', 'canonical.json'], f).stdout);
  assert.equal(checked.freshness.inputs, 'fresh');
  assert.deepEqual(checked.detail.inputs.unchecked, []);
});

/**
 * Plan §17 Scenario 2 as the recovering Agent sees it.
 *
 * The authority has moved on, so the answer is a reissue rather than a rebase: restating the
 * task restates the base too, and rebasing first would be work the reissue throws away. The
 * losing finding still appears in `reasons`, because a precedence nobody can inspect is
 * folklore.
 */
test('reconcile answers a moved canonical revision with reissue-task', () => {
  const f = bootstrapped();
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], f.repo);
  run(['session', 'start', '--session', 'feature:coupon', '--target', branch], f);
  writePacket(f, taskPacket({ baseRevision: 'git:abc1234' }));
  run(['task', 'issue', '--packet', 'packet.json'], f);

  fs.writeFileSync(path.join(f.repo, 'canonical.json'),
    `${JSON.stringify([{ id: 'contract:coupon', revision: `sha256:${'2'.repeat(64)}` }])}\n`);
  const out = JSON.parse(run(['reconcile', '--canonical-inputs', 'canonical.json'], f).stdout);
  assert.equal(out.status, 'stale');
  assert.equal(out.nextAction, 'reissue-task');
  assert.equal(out.freshness.inputs, 'stale');
  assert.match(out.reasons[0], /inputs are stale/);
  assert.deepEqual(out.detail.inputs.stale.map((s) => s.id), ['contract:coupon']);
});

/**
 * A target branch this worktree cannot resolve is `unknown`, never `fresh`.
 *
 * The plan's §17 Scenario 4 is a base that fell behind, and the check for it depends on being
 * able to read the target at all. A fetch that never happened, a branch that only exists on the
 * remote, a target named in a session and deleted since — all of them leave the question
 * unanswered, and an unanswered staleness question reported as fresh is how an Agent ends up
 * confidently building on a base nobody checked.
 */
test('reconcile reports unknown git freshness when the integration target cannot be resolved', () => {
  const f = bootstrapped();
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'no-such-branch'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const out = JSON.parse(run(['reconcile'], f).stdout);
  assert.equal(out.freshness.git, 'unknown');
  assert.equal(out.detail.git.targetCommit, null);
  assert.match(out.detail.git.detail, /never established/);
});

/**
 * A handoff waiting to be acknowledged is the answer, and it outranks ordinary work.
 *
 * Reviewer-to-Fullstack mail is how a task changes hands, so an Agent that resumes and starts
 * coding without reading it has resumed against a state somebody already superseded.
 */
test('reconcile surfaces an unacknowledged handoff addressed to this agent', () => {
  const f = bootstrapped({ agentId: 'fullstack-01', role: 'fullstack' });
  const head = git(['rev-parse', 'HEAD'], f.repo);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], f.repo);
  run(['session', 'start', '--session', 'feature:coupon', '--target', branch], f);
  writePacket(f, taskPacket({ baseRevision: `git:${head}` }));
  run(['task', 'issue', '--packet', 'packet.json'], f);

  const linked = path.join(f.dir, 'wt-reviewer');
  git(['worktree', 'add', linked, '-b', 'review'], f.repo);
  const g = { dir: f.dir, repo: linked, home: f.home };
  run(['setup', '--agent-id', 'reviewer-01', '--role', 'reviewer', '--harness', 'codex', '--repo', linked], g);
  writeDraft(g, {
    sessionId: 'feature:coupon',
    taskId: 'task:coupon-api',
    to: { role: 'fullstack' },
    nextAction: 'implement',
    summary: 'The contract is frozen; the stacking rules are yours to write.',
  });
  run(['handoff', 'publish', '--handoff', 'draft.json'], g);

  const out = JSON.parse(run(['reconcile'], f).stdout);
  // Ahead of `run-validation`, which is also true here: the gate is unestablished, but running
  // it against a state a handoff has already superseded is the wasted work this ordering avoids.
  assert.equal(out.nextAction, 'ack-handoff');
  assert.equal(out.detail.unackedHandoffs.length, 1);
  assert.equal(out.detail.unackedHandoffs[0].nextAction, 'implement');
  assert.deepEqual(out.detail.unackedHandoffs[0].from, { subject: 'agent:reviewer-01', role: 'reviewer' });
  assert.ok(out.reasons.some((r) => /validation is unknown/.test(r)),
    'the losing finding is still reported, so the precedence can be argued with');
});

/**
 * Waiting mail outranks a session this Agent merely worked in before.
 *
 * Both routes can name a session for an Agent holding no task, and they can name different ones:
 * a reviewer that acknowledged its last handoff has participation in the old session and nothing
 * waiting there, while the new letter is in a session it has never touched. Mail is the route that
 * names work somebody is waiting on; participation only names a place. Resolving to the old
 * session does not merely answer `await-task` instead of `ack-handoff` — it drops the letter
 * entirely, because the unacknowledged handoffs reported are the ones in the session that was
 * chosen. The Agent would be told to sit in the room it was last seen in while its next task sat
 * unread next door.
 *
 * The order is encoded twice on purpose — the guard that skips the participation lookup while mail
 * is waiting, and the order of the fallback chain — so this holds if either one is loosened.
 */
test('reconcile answers with waiting mail rather than the session it last acted in', () => {
  const f = bootstrapped({ agentId: 'fullstack-01', role: 'fullstack' });
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], f.repo);
  const linked = path.join(f.dir, 'wt-reviewer');
  git(['worktree', 'add', linked, '-b', 'review'], f.repo);
  const g = { dir: f.dir, repo: linked, home: f.home };
  run(['setup', '--agent-id', 'reviewer-01', '--role', 'reviewer', '--harness', 'codex', '--repo', linked], g);

  // The old session: reviewed, acknowledged, nothing waiting — participation and nothing else.
  run(['session', 'start', '--session', 'feature:coupon', '--target', branch], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);
  writeDraft(f, {
    sessionId: 'feature:coupon',
    taskId: 'task:coupon-api',
    to: { role: 'reviewer' },
    nextAction: 'review',
    summary: 'Coupon path is ready to look at.',
  });
  const first = JSON.parse(run(['handoff', 'publish', '--handoff', 'draft.json'], f).stdout);
  run(['handoff', 'ack', '--session', 'feature:coupon', '--handoff', first.handoffId], g);

  const only = JSON.parse(run(['reconcile'], g).stdout);
  assert.deepEqual([only.session, only.nextAction], ['feature:coupon', 'await-task'],
    'with nothing waiting, participation is the route that finds a session at all');

  // The new session, which this reviewer has never acted in.
  run(['session', 'start', '--session', 'feature:refund', '--target', branch], f);
  writePacket(f, taskPacket({ taskId: 'task:refund-api', sessionId: 'feature:refund' }), 'refund.json');
  run(['task', 'issue', '--packet', 'refund.json'], f);
  writeDraft(f, {
    sessionId: 'feature:refund',
    taskId: 'task:refund-api',
    to: { role: 'reviewer' },
    nextAction: 'review',
    summary: 'Refund path is ready to look at.',
  }, 'draft-2.json');
  const second = JSON.parse(run(['handoff', 'publish', '--handoff', 'draft-2.json'], f).stdout);

  const out2 = JSON.parse(run(['reconcile'], g).stdout);
  assert.deepEqual([out2.session, out2.nextAction], ['feature:refund', 'ack-handoff'],
    'the letter is in the newer session; the older one is only where this agent was last seen');
  assert.deepEqual(out2.detail.unackedHandoffs.map((row) => row.handoffId), [second.handoffId]);
});

/**
 * §14's counters, and the honest report of the ones nothing records.
 *
 * A dashboard whose `humanInterventions` reads 0 because nothing observes it is
 * indistinguishable from the outcome this whole plan aims at, so the gap is printed as a gap
 * with a reason. The counted half comes from the sealed event log rather than a directory scan,
 * because the log is the half whose completeness `session.eventSeq` can prove.
 */
test('metrics counts what the log proves and names what nothing records', () => {
  const f = bootstrapped();
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);
  run(['task', 'set-status', '--session', 'feature:coupon', '--task', 'task:coupon-api',
    '--status', 'in-progress'], f);

  const out = JSON.parse(run(['metrics'], f).stdout);
  assert.equal(out.totals.sessions, 1);
  assert.equal(out.totals.tasksIssued, 1);
  assert.equal(out.totals.taskStatusChanges, 1);
  assert.equal(out.totals.handoffs, 0);
  assert.deepEqual(out.unreadable, []);
  assert.equal(out.sessions[0].sessionId, 'feature:coupon');
  assert.ok(out.unavailable.some((u) => u.metric === 'humanInterventions'),
    'a metric nothing records is named rather than printed as zero');
  assert.ok(out.unavailable.every((u) => typeof u.reason === 'string' && u.reason.length > 40),
    'every gap says whose fact it is');
});

/**
 * `reviewFindings` exists because the round count alone would flatter a noisy review.
 *
 * A review that raised nine findings and one that raised none are both a single
 * `review-recorded` event, so counting rounds and calling it review load would report the two
 * as identical. The count comes off the event payload, which is why the event carries it.
 */
test('metrics counts review findings from the event payload, not just the rounds', () => {
  const f = bootstrapped({ agentId: 'reviewer-01', role: 'reviewer' });
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);
  const head = `git:${git(['rev-parse', 'HEAD'], f.repo)}`;
  const finding = (id, severity, evidence) => ({
    schemaVersion: 1, findingId: id, severity, status: 'open', candidateRevision: head,
    requirement: 'AC-1', location: 'src/coupon.ts:1', evidence,
    impact: 'The total a customer is charged is wrong.',
    requiredOutcome: 'At most one coupon applies, and the error path is covered.',
  });
  writeDraft(f, {
    sessionId: 'feature:coupon', taskId: 'task:coupon-api', status: 'changes-requested',
    candidateRevision: head, requirementsRevision: `sha256:${'1'.repeat(64)}`,
    findings: [
      finding('FIND-001', 'major', 'Stacking is applied twice: once in the API and once in the domain.'),
      finding('FIND-002', 'minor', 'No test covers the expired-coupon path.'),
    ],
    summary: 'Two findings, one round.',
  }, 'decision.json');
  run(['review', 'record', '--review', 'decision.json'], f);

  const out = JSON.parse(run(['metrics', '--session', 'feature:coupon'], f).stdout);
  assert.equal(out.totals.reviewRounds, 1);
  assert.equal(out.totals.reviewFindings, 2, 'one round, two findings — the round count alone would say one');
  assert.equal(out.totals.reviewApprovals, 0);
  assert.equal(out.totals.unresolvedFindings, 2, 'both findings are open, so both are unresolved');
  assert.equal(out.totals.unresolvedRaised, 0,
    'and no handoff raised a fact: the two senses of unresolved are counted apart');
});

/**
 * `unresolvedRaised` is §14's own metric, and the one whose absence would be least visible.
 *
 * A handoff that carried no unresolved list is exactly the handoff where an Agent may have
 * guessed instead of asking, so the count has to come off the event rather than from the number
 * of handoffs: one handoff raising two questions and one raising none are the same event count
 * and the opposite outcome. This is the counter the plan reads to decide whether the layer is
 * making Agents stop at the edge of what they know.
 */
test('metrics counts the facts a handoff declined to guess past', () => {
  const f = bootstrapped();
  run(['session', 'start', '--session', 'feature:coupon', '--target', 'main'], f);
  writePacket(f, taskPacket());
  run(['task', 'issue', '--packet', 'packet.json'], f);
  writeDraft(f, {
    sessionId: 'feature:coupon',
    taskId: 'task:coupon-api',
    to: { role: 'product-architect' },
    nextAction: 'clarify',
    summary: 'Two questions I am not going to answer by guessing.',
    unresolved: [
      'Whether an expired coupon on a saved cart is still honoured.',
      'Whether stacking is forbidden outright or merely capped.',
    ],
  });
  run(['handoff', 'publish', '--handoff', 'draft.json'], f);

  const out = JSON.parse(run(['metrics'], f).stdout);
  assert.equal(out.totals.handoffs, 1);
  assert.equal(out.totals.unresolvedRaised, 2,
    'two facts, one handoff — counting handoffs would report the same number for a handoff that asked nothing');
  assert.equal(out.totals.unresolvedFindings, 0, 'no review left a finding open: the two senses stay apart');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Ledger, LedgerError, SESSION_STATUSES, SESSION_TRANSITIONS, TASK_STATUSES, TASK_TRANSITIONS } from '../src/ledger.mjs';
import { slug, unslug, assertId, SlugError } from '../src/slug.mjs';
import { loadSchema, validate } from '../src/schema.mjs';
import { jsonDigest, DigestError } from '../src/digest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION_SCHEMA = loadSchema(path.join(ROOT, 'schemas', 'session.schema.json'));
const TASK_SCHEMA = loadSchema(path.join(ROOT, 'schemas', 'task-record.schema.json'));
const HANDOFF_SCHEMA = loadSchema(path.join(ROOT, 'schemas', 'handoff.schema.json'));
const REVIEW_SCHEMA = loadSchema(path.join(ROOT, 'schemas', 'review-decision.schema.json'));
const EVIDENCE_SCHEMA = loadSchema(path.join(ROOT, 'schemas', 'validation-evidence.schema.json'));

function tempCommonDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-layer-ledger-'));
}

function tempLedger(options = {}) {
  return new Ledger({ commonDir: tempCommonDir(), actor: 'test', ...options });
}

/**
 * The code of the refusal, or null if the call was allowed.
 *
 * All three error classes are in scope on purpose: the ledger delegates id and
 * revision checks, so a caller sees SlugError/DigestError codes through it and
 * a test that only understood LedgerError would rethrow a correct rejection.
 */
function code(fn) {
  try {
    fn();
  } catch (error) {
    const known = error instanceof LedgerError || error instanceof SlugError || error instanceof DigestError;
    if (!known) throw error;
    return error.code;
  }
  return null;
}

/** A pid that is provably gone: the process ran to completion before we asked. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  assert.ok(Number.isInteger(child.pid));
  return child.pid;
}

function packet(overrides = {}) {
  return {
    schemaVersion: 2,
    taskId: 'task:coupon',
    subject: 'agent:fullstack-01',
    role: 'fullstack',
    baseRevision: 'git:abc1234',
    readSet: ['src/**'],
    writeSet: ['src/**'],
    inputs: [{ id: 'contract:coupon', revision: `sha256:${'1'.repeat(64)}`, authority: 'product-architect' }],
    acceptance: ['AC-1'],
    validationPlan: [
      { checkId: 'unit-tests', kind: 'command', requiredAt: ['handoff', 'merge'], command: 'npm test' },
    ],
    ...overrides,
  };
}

function startedSession({ sessionId = 'feature:coupon', ...options } = {}) {
  const ledger = tempLedger(options);
  ledger.createSession({ sessionId, integrationTarget: 'main' });
  return { ledger, sessionId };
}

// ------------------------------------------------------------------------- slugs
// A session id is not a filename. `:` is illegal on Windows, so the mapping has
// to exist; it has to be injective or two sessions would share one ledger.
test('ids map to filesystem-safe segments injectively', () => {
  assert.equal(slug('feature:coupon'), 'feature__coupon');
  assert.equal(slug('coupon'), 'coupon');
  assert.equal(unslug(slug('feature:coupon')), 'feature:coupon');

  // `_` is not a legal id character, which is what makes `__` an unambiguous
  // stand-in for `:` rather than something an id could contain itself.
  assert.equal(code(() => assertId('feature__coupon')), 'MALFORMED_ID');
  assert.notEqual(slug('a:b-c'), slug('a-b:c'));
});

test('ids that could escape the ledger directory are rejected', () => {
  for (const bad of ['..', '../x', 'a/b', 'a\\b', 'feature:../x', '.', 'a.b', 'A', '', 'a:', ':a', 'a:b:c', 'x'.repeat(200)]) {
    assert.equal(code(() => assertId(bad)), 'MALFORMED_ID', `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

// ----------------------------------------------------------------------- session
test('a new session is forming, schema-valid, and recorded as one event', () => {
  const ledger = tempLedger();
  const session = ledger.createSession({ sessionId: 'feature:coupon', integrationTarget: 'main' });
  assert.equal(session.status, 'forming');
  assert.equal(session.revision, 1);
  assert.equal(session.eventSeq, 1);
  assert.deepEqual(validate(SESSION_SCHEMA, session), []);

  const events = ledger.readEvents('feature:coupon', { expectSeq: session.eventSeq });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'session-created');
  assert.equal(events[0].seq, 1);
  assert.deepEqual(ledger.listSessions(), ['feature:coupon']);
});

test('creating a session twice fails closed instead of adopting the existing one', () => {
  const { ledger } = startedSession();
  assert.equal(code(() => ledger.createSession({ sessionId: 'feature:coupon', integrationTarget: 'main' })), 'SESSION_EXISTS');
  // The original state survives the refused write.
  assert.equal(ledger.readSession('feature:coupon').revision, 1);
});

test('the session status machine is closed and every transition is checked', () => {
  // Every status is reachable from the table, and the table only names statuses
  // that exist. A typo in either list is otherwise invisible until runtime.
  assert.deepEqual(Object.keys(SESSION_TRANSITIONS).sort(), [...SESSION_STATUSES].sort());
  for (const [from, targets] of Object.entries(SESSION_TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(SESSION_STATUSES.includes(to), `${from} -> ${to} names an unknown status`);
    }
  }

  const { ledger, sessionId } = startedSession();
  assert.equal(code(() => ledger.setSessionStatus(sessionId, 'integration')), 'ILLEGAL_TRANSITION');
  assert.equal(code(() => ledger.setSessionStatus(sessionId, 'forming')), 'NO_OP_TRANSITION');
  assert.equal(code(() => ledger.setSessionStatus(sessionId, 'nonsense')), 'UNKNOWN_STATUS');
  // A refused transition must not have consumed a revision or an event.
  const untouched = ledger.readSession(sessionId);
  assert.equal(untouched.revision, 1);
  assert.equal(untouched.eventSeq, 1);

  const walk = ['product-definition', 'ready-for-implementation', 'implementation', 'review', 'integration', 'completed'];
  let revision = 1;
  for (const status of walk) {
    const next = ledger.setSessionStatus(sessionId, status);
    assert.equal(next.status, status);
    assert.equal(next.revision, ++revision);
  }
  assert.equal(code(() => ledger.setSessionStatus(sessionId, 'implementation')), 'ILLEGAL_TRANSITION', 'completed is terminal');
});

test('blocked resumes only into a working state', () => {
  const { ledger, sessionId } = startedSession();
  ledger.setSessionStatus(sessionId, 'product-definition');
  ledger.setSessionStatus(sessionId, 'blocked', { note: 'waiting on the coupon contract' });
  assert.equal(ledger.readSession(sessionId).notes, 'waiting on the coupon contract');
  assert.equal(code(() => ledger.setSessionStatus(sessionId, 'completed')), 'ILLEGAL_TRANSITION');
  assert.equal(code(() => ledger.setSessionStatus(sessionId, 'forming')), 'ILLEGAL_TRANSITION');
  assert.equal(ledger.setSessionStatus(sessionId, 'implementation').status, 'implementation');
});

test('a stale expectedRevision is refused rather than overwriting', () => {
  const { ledger, sessionId } = startedSession();
  const read = ledger.readSession(sessionId);
  ledger.setSessionStatus(sessionId, 'product-definition');

  // `read` is now out of date. A writer holding it must not win.
  const error = (() => {
    try {
      ledger.setSessionStatus(sessionId, 'blocked', { expectedRevision: read.revision });
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.equal(error.code, 'REVISION_CONFLICT');
  assert.deepEqual(error.details, { expected: 1, actual: 2 });
  assert.equal(ledger.readSession(sessionId).status, 'product-definition', 'the refused write changed nothing');

  // Re-reading and retrying is the documented recovery.
  assert.equal(ledger.setSessionStatus(sessionId, 'blocked', { expectedRevision: 2 }).status, 'blocked');
});

// -------------------------------------------------------------------------- tasks
test('an issued task is schema-valid and splits frozen truth from mutable state', () => {
  const { ledger, sessionId } = startedSession();
  const record = ledger.issueTask({ sessionId, packet: packet() });
  assert.deepEqual(validate(TASK_SCHEMA, record), []);
  assert.equal(record.state.status, 'issued');
  assert.equal(record.state.generation, 1);
  assert.equal(record.frozen.sessionId, sessionId);
  assert.equal(record.frozenDigest, jsonDigest(record.frozen));
  assert.deepEqual(ledger.listTasks(sessionId), ['task:coupon']);
});

test('the frozen digest depends only on content, not on when or how often it was issued', () => {
  const a = startedSession();
  const b = startedSession();
  const first = a.ledger.issueTask({ sessionId: a.sessionId, packet: packet() });
  const second = b.ledger.issueTask({ sessionId: b.sessionId, packet: packet() });
  assert.equal(first.frozenDigest, second.frozenDigest);
  assert.equal(first.inputSnapshotDigest, second.inputSnapshotDigest);
});

test('editing a frozen packet on disk is detected instead of obeyed', () => {
  const { ledger, sessionId } = startedSession();
  ledger.issueTask({ sessionId, packet: packet() });
  const file = ledger.taskFile(sessionId, 'task:coupon');

  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.frozen.acceptance = ['AC-1', 'AC-2-snuck-in'];
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');

  const error = (() => {
    try {
      ledger.readTask(sessionId, 'task:coupon');
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.equal(error.code, 'FROZEN_TAMPERED');
  assert.match(error.message, /Reissue the task/);
  // Every path that relies on frozen truth goes through readTask, so the
  // tampered packet cannot be laundered through a status change either.
  assert.equal(code(() => ledger.setTaskStatus(sessionId, 'task:coupon', 'in-progress')), 'FROZEN_TAMPERED');
});

test('the task status machine is closed and completed tasks are not reopened', () => {
  assert.deepEqual(Object.keys(TASK_TRANSITIONS).sort(), [...TASK_STATUSES].sort());
  const { ledger, sessionId } = startedSession();
  ledger.issueTask({ sessionId, packet: packet() });
  assert.equal(code(() => ledger.setTaskStatus(sessionId, 'task:coupon', 'completed')), 'ILLEGAL_TRANSITION');
  ledger.setTaskStatus(sessionId, 'task:coupon', 'in-progress');
  ledger.setTaskStatus(sessionId, 'task:coupon', 'blocked', { note: 'contract ambiguous' });
  assert.equal(ledger.readTask(sessionId, 'task:coupon').state.note, 'contract ambiguous');
  ledger.setTaskStatus(sessionId, 'task:coupon', 'in-progress');
  const done = ledger.setTaskStatus(sessionId, 'task:coupon', 'completed');
  assert.equal(done.state.status, 'completed');
  assert.equal(code(() => ledger.setTaskStatus(sessionId, 'task:coupon', 'in-progress')), 'ILLEGAL_TRANSITION');
});

test('issuing the same task twice is refused; restating it is explicit', () => {
  const { ledger, sessionId } = startedSession();
  ledger.issueTask({ sessionId, packet: packet() });
  assert.equal(code(() => ledger.issueTask({ sessionId, packet: packet() })), 'TASK_EXISTS');
  assert.equal(code(() => ledger.reissueTask({ sessionId, packet: packet(), reason: '' })), 'MALFORMED_TASK');
});

// Plan §17 Scenario 2: the product architect changes the contract mid-flight. The
// old frozen truth must be superseded, never patched, and the audit log has to
// keep enough to prove which snapshot the Agent had been working against.
test('restating a task supersedes the old snapshot rather than editing it', () => {
  const { ledger, sessionId } = startedSession();
  const first = ledger.issueTask({ sessionId, packet: packet() });
  ledger.setTaskStatus(sessionId, 'task:coupon', 'in-progress');

  const moved = packet({ inputs: [{ id: 'contract:coupon', revision: `sha256:${'2'.repeat(64)}`, authority: 'product-architect' }] });
  const second = ledger.reissueTask({ sessionId, packet: moved, reason: 'contract:coupon moved', expectedGeneration: 1 });

  assert.equal(second.state.generation, 2);
  assert.equal(second.state.status, 'issued', 'a restated task starts over');
  assert.notEqual(second.frozenDigest, first.frozenDigest);
  assert.notEqual(second.inputSnapshotDigest, first.inputSnapshotDigest);
  assert.deepEqual(validate(TASK_SCHEMA, second), []);

  const reissued = ledger.readEvents(sessionId).find((e) => e.kind === 'task-reissued');
  assert.equal(reissued.reason, 'contract:coupon moved');
  assert.equal(reissued.supersededDigest, first.frozenDigest);
  assert.equal(reissued.supersededInputSnapshotDigest, first.inputSnapshotDigest);
  assert.equal(reissued.unchanged, false);

  assert.equal(
    code(() => ledger.reissueTask({ sessionId, packet: moved, reason: 'again', expectedGeneration: 1 })),
    'REVISION_CONFLICT',
  );
});

// A freshness re-check runs on a schedule and must be safe to run on a task
// someone is actively working on. Asserting the *whole* record is unchanged, not
// just the digest, is what pins that down: a bumped generation would read
// downstream as "your task was restated", and a reset status would throw away
// the fact that an Agent is mid-flight — both invented by a check that found
// nothing had moved.
test('restating with identical content is recorded as unchanged, not as a new snapshot', () => {
  const { ledger, sessionId } = startedSession();
  const first = ledger.issueTask({ sessionId, packet: packet() });
  ledger.setTaskStatus(sessionId, 'task:coupon', 'in-progress');
  const working = ledger.readTask(sessionId, 'task:coupon');

  const again = ledger.reissueTask({ sessionId, packet: packet(), reason: 'periodic freshness re-check' });
  assert.equal(again.frozenDigest, first.frozenDigest, 'same agreed truth keeps the same digest');
  assert.equal(again.state.generation, 1, 'a no-op restatement does not invent a generation');
  assert.equal(again.state.status, 'in-progress', 'a no-op restatement does not derail work in progress');
  assert.deepEqual(ledger.readTask(sessionId, 'task:coupon'), working, 'the stored task was not touched at all');

  // The check itself is still auditable: it happened, at a time, for a reason.
  const event = ledger.readEvents(sessionId).find((e) => e.kind === 'task-reissued');
  assert.equal(event.unchanged, true);
  assert.equal(event.reason, 'periodic freshness re-check');
  assert.equal(event.generation, 1);

  // And the CAS still refers to the generation that is actually current, so a
  // scheduled re-check cannot invalidate a holder that has not been superseded.
  assert.equal(code(() => ledger.reissueTask({
    sessionId, packet: packet(), reason: 'again', expectedGeneration: 1,
  })), null);
});

test('a cancelled task cannot be revived by restating it', () => {
  const { ledger, sessionId } = startedSession();
  ledger.issueTask({ sessionId, packet: packet() });
  ledger.setTaskStatus(sessionId, 'task:coupon', 'cancelled');
  assert.equal(code(() => ledger.reissueTask({ sessionId, packet: packet(), reason: 'oops' })), 'ILLEGAL_TRANSITION');
});

test('a packet cannot smuggle in ledger-owned fields', () => {
  const { ledger, sessionId } = startedSession();
  assert.equal(code(() => ledger.issueTask({ sessionId, packet: packet({ generation: 7 }) })), 'MALFORMED_TASK');
  assert.equal(code(() => ledger.issueTask({ sessionId, packet: packet({ sessionId: 'feature:other' }) })), 'SESSION_MISMATCH');
  assert.equal(code(() => ledger.issueTask({ sessionId, packet: packet({ baseRevision: 'git:zzz' }) })), 'MALFORMED_REVISION');
  assert.equal(code(() => ledger.issueTask({ sessionId, packet: packet({ taskId: '../escape' }) })), 'MALFORMED_ID');
  assert.deepEqual(ledger.listTasks(sessionId), [], 'no half-written task survived a rejected issue');
});

// ------------------------------------------------------------------ audit log
test('the event log is authoritative and truncation is reported, not absorbed', () => {
  const { ledger, sessionId } = startedSession();
  ledger.issueTask({ sessionId, packet: packet() });
  ledger.setTaskStatus(sessionId, 'task:coupon', 'in-progress');
  const session = ledger.readSession(sessionId);
  const events = ledger.readEvents(sessionId, { expectSeq: session.eventSeq });
  assert.deepEqual(events.map((e) => e.kind), ['session-created', 'task-issued', 'task-status-changed']);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3], 'sequence numbers are gap-free');
  for (const event of events) assert.equal(event.actor, 'test');

  const file = ledger.eventsFile(sessionId);
  const text = fs.readFileSync(file, 'utf8');

  // A crash mid-append leaves a partial line. Parsing what survives and calling
  // it the history would silently under-count everything derived from the log.
  fs.writeFileSync(file, `${text}{"seq":4,"kind":"tor`, 'utf8');
  assert.equal(code(() => ledger.readEvents(sessionId)), 'LEDGER_CORRUPT');

  fs.writeFileSync(file, text.split('\n').slice(1).join('\n'), 'utf8');
  const error = (() => {
    try {
      ledger.readEvents(sessionId, { expectSeq: session.eventSeq });
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.equal(error.code, 'LEDGER_CORRUPT');
  assert.deepEqual(error.details, { found: 2, expected: 3 });
});

// ------------------------------------------------------------------------ locking
test('a lock left behind by a dead process on this host is reclaimed', () => {
  const { ledger, sessionId } = startedSession();
  const lockDir = path.join(ledger.sessionDir(sessionId), '.lock');
  fs.mkdirSync(lockDir);
  // Liveness is what decides, not age: this holder's timestamp is recent, and it
  // is still reclaimed because the process behind it is gone.
  fs.writeFileSync(
    path.join(lockDir, 'holder.json'),
    JSON.stringify({ pid: deadPid(), host: os.hostname(), actor: 'crashed-window', at: new Date().toISOString() }),
    'utf8',
  );
  assert.equal(ledger.setSessionStatus(sessionId, 'product-definition').status, 'product-definition');
});

test('a lock held by a live process fails closed with a machine-readable error', () => {
  const { ledger, sessionId } = startedSession({ lockTimeoutMs: 150 });
  const lockDir = path.join(ledger.sessionDir(sessionId), '.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, 'holder.json'),
    JSON.stringify({ pid: process.pid, host: os.hostname(), actor: 'other-window', at: new Date().toISOString() }),
    'utf8',
  );
  const error = (() => {
    try {
      ledger.setSessionStatus(sessionId, 'product-definition');
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.equal(error.code, 'LOCK_HELD');
  assert.match(error.message, /still running/);
  assert.equal(error.details.holder.actor, 'other-window');
  assert.equal(ledger.readSession(sessionId).status, 'forming', 'nothing was written while locked out');
});

test('a lock held by another host is never reclaimed on age alone', () => {
  const { ledger, sessionId } = startedSession({ lockTimeoutMs: 150 });
  const lockDir = path.join(ledger.sessionDir(sessionId), '.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(
    path.join(lockDir, 'holder.json'),
    // Long dead by wall clock, and its pid does not exist here either — but it
    // is not this machine's pid space, so liveness is unknowable.
    JSON.stringify({ pid: 4242, host: 'some-other-machine', actor: 'ci', at: '2020-01-01T00:00:00.000Z' }),
    'utf8',
  );
  const error = (() => {
    try {
      ledger.setSessionStatus(sessionId, 'product-definition');
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.equal(error.code, 'LOCK_HELD');
  assert.match(error.message, /Liveness cannot be checked/);
});

test('the lock is released even when the guarded work throws', () => {
  const { ledger, sessionId } = startedSession({ lockTimeoutMs: 150 });
  assert.throws(() => ledger.withLock(sessionId, () => {
    throw new Error('boom');
  }), /boom/);
  assert.ok(!fs.existsSync(path.join(ledger.sessionDir(sessionId), '.lock')));
  assert.equal(ledger.setSessionStatus(sessionId, 'product-definition').status, 'product-definition');
});

// Plan §17 Scenario 7: two worktrees updating one session at the same time. Real
// concurrency needs real processes — an in-process loop would prove nothing about
// a lock whose whole job is to coordinate across processes. The children wait on a
// start file so they are all inside the contended region together, rather than
// finishing one after another and never meeting.
test('concurrent writers from separate processes lose no update and corrupt nothing', async () => {
  const commonDir = tempCommonDir();
  const ledger = new Ledger({ commonDir, actor: 'test' });
  const sessionId = 'feature:coupon';
  ledger.createSession({ sessionId, integrationTarget: 'main' });

  const WRITERS = 4;
  const PER_WRITER = 5;
  const worker = path.join(ROOT, 'tests', 'helpers', 'concurrent-writer.mjs');
  const goFile = path.join(commonDir, 'go');

  const children = Array.from({ length: WRITERS }, (_, index) => {
    const child = spawn(
      process.execPath,
      [worker, commonDir, sessionId, String(index), String(PER_WRITER), goFile],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    return new Promise((resolve) => {
      child.on('close', (status) => resolve({ index, status, output }));
    });
  });

  fs.writeFileSync(goFile, 'go', 'utf8');
  const results = await Promise.all(children);
  for (const result of results) {
    assert.equal(result.status, 0, `writer ${result.index} failed:\n${result.output}`);
  }

  const session = ledger.readSession(sessionId);
  const events = ledger.readEvents(sessionId, { expectSeq: session.eventSeq });

  // Every write landed: no interleaving silently dropped one.
  const issued = events.filter((e) => e.kind === 'task-issued');
  assert.equal(issued.length, WRITERS * PER_WRITER, 'every issued task is in the log exactly once');
  assert.equal(ledger.listTasks(sessionId).length, WRITERS * PER_WRITER);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), 'sequence numbers are gap-free and unique');

  // And everything is still readable and internally consistent.
  assert.deepEqual(validate(SESSION_SCHEMA, session), []);
  for (const taskId of ledger.listTasks(sessionId)) {
    assert.deepEqual(validate(TASK_SCHEMA, ledger.readTask(sessionId, taskId)), [], taskId);
  }
  assert.ok(!fs.existsSync(path.join(ledger.sessionDir(sessionId), '.lock')), 'no writer leaked the lock');
  const leftovers = fs.readdirSync(path.join(ledger.sessionDir(sessionId), 'tasks')).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, [], 'no temp files were left behind');
});

// ---------------------------------------------------------------------- handoffs
// Plan §4. A handoff is state transfer, not a transcript dump: it names the input
// snapshot the work was done against, what now exists, and the one next action.
// The property that makes it worth having a schema for is the staleness check —
// a recipient must not be able to start work against inputs that already moved.

function draft(overrides = {}) {
  return {
    taskId: 'task:coupon',
    to: { role: 'reviewer' },
    nextAction: 'review',
    summary: 'Discount applies at most once, enforced in the domain layer.',
    ...overrides,
  };
}

/** A session with one issued task, ready to hand off. */
function taskedSession(options = {}) {
  const started = startedSession(options);
  started.ledger.issueTask({ sessionId: started.sessionId, packet: packet() });
  return started;
}

test('a published handoff is schema-valid and the ledger owns its identity', () => {
  const { ledger, sessionId } = taskedSession();
  const record = ledger.publishHandoff({ sessionId, draft: draft(), actorRole: 'fullstack' });

  assert.deepEqual(validate(HANDOFF_SCHEMA, record), []);
  assert.equal(record.handoffId, 'handoff:fullstack-to-reviewer-1');
  assert.equal(record.seq, 1);
  assert.deepEqual(record.handoff.from, { subject: 'test', role: 'fullstack' });

  // The snapshot is copied from the task, not accepted from the sender, so a
  // handoff cannot claim to have been produced against truth that never held.
  const task = ledger.readTask(sessionId, 'task:coupon');
  assert.equal(record.handoff.inputSnapshotDigest, task.inputSnapshotDigest);

  // Receipt is an event, so the statement stays immutable and keeps its digest.
  const event = ledger.readEvents(sessionId).find((e) => e.kind === 'handoff-published');
  assert.equal(event.handoffId, record.handoffId);
  assert.equal(event.at, record.publishedAt);
  assert.equal(event.duplicateOf, undefined);
});

/**
 * The digest has to identify the state, not the act of transferring it.
 *
 * Re-sending an unacknowledged handoff is how you nudge a recipient, and it is
 * legal — but it is not new information, and a recipient that cannot tell the
 * difference has to re-read the whole thing to find out nothing changed. That
 * only works while `handoffId` and `publishedAt` stay outside the digested half.
 */
test('re-sending the same state is recognised as a nudge, not as new state', () => {
  const { ledger, sessionId } = taskedSession();
  const first = ledger.publishHandoff({ sessionId, draft: draft(), actorRole: 'fullstack' });
  const again = ledger.publishHandoff({ sessionId, draft: draft(), actorRole: 'fullstack' });

  assert.equal(again.handoffDigest, first.handoffDigest, 'identical state hashes identically');
  assert.notEqual(again.handoffId, first.handoffId, 'but it is still a distinct act, separately addressable');
  const events = ledger.readEvents(sessionId).filter((e) => e.kind === 'handoff-published');
  assert.deepEqual(events.map((e) => e.duplicateOf ?? null), [null, first.handoffId]);

  const moved = ledger.publishHandoff({
    sessionId, actorRole: 'fullstack',
    draft: draft({ summary: 'Stacking with promo codes now rejects with 409.' }),
  });
  assert.notEqual(moved.handoffDigest, first.handoffDigest);
  assert.equal(ledger.readEvents(sessionId).at(-1).duplicateOf, undefined);
});

test('a draft cannot assign what the ledger owns, or misspell what it does own', () => {
  const { ledger, sessionId } = taskedSession();
  const publish = (overrides) => code(() => ledger.publishHandoff({
    sessionId, draft: draft(overrides), actorRole: 'fullstack',
  }));

  assert.equal(publish({ handoffId: 'handoff:mine-1' }), 'MALFORMED_HANDOFF');
  assert.equal(publish({ from: { subject: 'agent:someone-else', role: 'reviewer' } }), 'MALFORMED_HANDOFF');
  assert.equal(publish({ publishedBy: 'agent:someone-else' }), 'MALFORMED_HANDOFF');

  // A misspelled field is refused rather than ignored. Ignoring it would publish
  // a handoff asserting there are no artifacts, which is a claim nobody made.
  assert.equal(publish({ artifcts: [{ type: 'code', id: 'module:x', revision: 'git:abc1234' }] }),
    'MALFORMED_HANDOFF');

  assert.equal(publish({ nextAction: 'have-a-look' }), 'UNKNOWN_ACTION');
  assert.equal(publish({ to: { role: 'archmage' } }), 'UNKNOWN_ROLE');
  assert.equal(publish({ summary: '   ' }), 'MALFORMED_HANDOFF');
  assert.equal(code(() => ledger.publishHandoff({
    sessionId, draft: draft(), actorRole: 'archmage',
  })), 'UNKNOWN_ROLE');

  assert.deepEqual(ledger.listHandoffs(sessionId), [], 'no refused draft left a file behind');
});

/**
 * Plan §2.3 `stale-input`, enforced in the team layer.
 *
 * This is the scenario the whole artifact exists for: the sender hands off against
 * a snapshot, the contract then moves, and the recipient must not be allowed to
 * start work against superseded inputs. Acknowledging is exactly the moment before
 * that work begins, so it is the right place to fail — and it fails closed, with no
 * override, because an override here would become the default path.
 */
test('acknowledging a handoff whose inputs have moved is refused', () => {
  const { ledger, sessionId } = taskedSession();
  const handoff = ledger.publishHandoff({ sessionId, draft: draft(), actorRole: 'fullstack' });

  ledger.reissueTask({
    sessionId, reason: 'coupon contract v2: stacking rules changed',
    packet: packet({
      inputs: [{ id: 'contract:coupon', revision: `sha256:${'2'.repeat(64)}`, authority: 'product-architect' }],
    }),
  });

  assert.equal(code(() => ledger.ackHandoff({ sessionId, handoffId: handoff.handoffId, actorRole: 'reviewer' })), 'HANDOFF_STALE');
  // Refused, and nothing was recorded as received: a rejected ack that still
  // logged an acknowledgement would let the next reader conclude work had started.
  assert.equal(ledger.readEvents(sessionId).some((e) => e.kind === 'handoff-acked'), false);

  // The remedy is a fresh handoff against current truth, which is then ackable.
  const fresh = ledger.publishHandoff({ sessionId, draft: draft(), actorRole: 'fullstack' });
  const { acked } = ledger.ackHandoff({ sessionId, handoffId: fresh.handoffId, actorRole: 'reviewer' });
  assert.equal(acked.kind, 'handoff-acked');
  assert.equal(acked.generation, 2, 'the acknowledgement pins which generation was received');

  assert.equal(code(() => ledger.ackHandoff({ sessionId, handoffId: fresh.handoffId, actorRole: 'reviewer' })), 'HANDOFF_ACKED');
});

test('publishing against a snapshot the task has already moved past is refused', () => {
  const { ledger, sessionId } = taskedSession();
  const stale = ledger.readTask(sessionId, 'task:coupon').inputSnapshotDigest;
  ledger.reissueTask({
    sessionId, reason: 'contract moved while the work was in flight',
    packet: packet({
      inputs: [{ id: 'contract:coupon', revision: `sha256:${'3'.repeat(64)}`, authority: 'product-architect' }],
    }),
  });

  // A sender that declares what it worked against gets checked against reality,
  // rather than discovering the problem via the recipient halfway through.
  assert.equal(code(() => ledger.publishHandoff({
    sessionId, actorRole: 'fullstack', draft: draft({ inputSnapshotDigest: stale }),
  })), 'HANDOFF_STALE');
  assert.deepEqual(ledger.listHandoffs(sessionId), []);
});

test('editing a published handoff on disk is detected instead of obeyed', () => {
  const { ledger, sessionId } = taskedSession();
  const record = ledger.publishHandoff({ sessionId, draft: draft(), actorRole: 'fullstack' });
  const file = ledger.handoffFile(sessionId, record.handoffId);

  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.handoff.nextAction = 'integrate';
  fs.writeFileSync(file, JSON.stringify(tampered));

  assert.equal(code(() => ledger.readHandoff(sessionId, record.handoffId)), 'HANDOFF_TAMPERED');
  // And it cannot be laundered by acknowledging it, which is the read that matters.
  assert.equal(code(() => ledger.ackHandoff({ sessionId, handoffId: record.handoffId, actorRole: 'reviewer' })), 'HANDOFF_TAMPERED');
});

/**
 * `inbox` is what an Agent runs after losing its context, so it takes no session:
 * an Agent that has forgotten everything cannot be asked where it was working.
 *
 * The `stale` flag is the point. Without it the recipient learns the inputs moved
 * by having its acknowledgement refused, which is a worse place to find out — it
 * has already decided to start.
 */
test('inbox shows what is actionable, addressed by role and narrowed by subject', () => {
  const { ledger, sessionId } = taskedSession();
  ledger.publishHandoff({ sessionId, draft: draft(), actorRole: 'fullstack' });
  ledger.publishHandoff({ sessionId, actorRole: 'fullstack',
    draft: draft({ to: { role: 'product-architect' }, nextAction: 'clarify',
      summary: 'The contract does not say what an expired coupon on a saved cart should do.' }) });
  ledger.publishHandoff({ sessionId, actorRole: 'fullstack',
    draft: draft({ to: { role: 'reviewer', subject: 'agent:reviewer-07' }, summary: 'Only for reviewer-07.' }) });

  const anyReviewer = ledger.inbox({ role: 'reviewer', subject: 'agent:reviewer-01' });
  assert.deepEqual(anyReviewer.map((row) => row.handoffId), ['handoff:fullstack-to-reviewer-1'],
    'a role-only handoff reaches whoever holds the role; a narrowed one does not');
  assert.deepEqual(ledger.inbox({ role: 'reviewer', subject: 'agent:reviewer-07' }).map((r) => r.handoffId),
    ['handoff:fullstack-to-reviewer-1', 'handoff:fullstack-to-reviewer-3']);
  assert.deepEqual(ledger.inbox({ role: 'product-architect' }).map((r) => r.nextAction), ['clarify']);

  const row = anyReviewer[0];
  assert.equal(row.stale, false);
  assert.equal(row.taskStatus, 'issued');
  assert.equal(row.sessionId, sessionId);
  assert.equal(row.from.role, 'fullstack');

  // Acknowledging clears it from the queue: an inbox that still shows work you
  // took is one you stop reading.
  ledger.ackHandoff({ sessionId, handoffId: row.handoffId, actorRole: 'reviewer' });
  assert.deepEqual(ledger.inbox({ role: 'reviewer', subject: 'agent:reviewer-01' }), []);

  ledger.reissueTask({
    sessionId, reason: 'contract v2',
    packet: packet({
      inputs: [{ id: 'contract:coupon', revision: `sha256:${'4'.repeat(64)}`, authority: 'product-architect' }],
    }),
  });
  const stale = ledger.inbox({ role: 'reviewer', subject: 'agent:reviewer-07' });
  assert.deepEqual(stale.map((r) => r.stale), [true], 'the recipient learns before acking, not by being refused');
  assert.equal(stale[0].currentInputSnapshotDigest, ledger.readTask(sessionId, 'task:coupon').inputSnapshotDigest);
});

/**
 * One unreadable session must not hide every other session's queue, because this
 * is the recovery path: the Agent running `inbox` is the one least able to work
 * out why it got an empty list.
 */
test('inbox reports a corrupt session as a row rather than throwing the queue away', () => {
  const { ledger, sessionId } = taskedSession();
  ledger.publishHandoff({ sessionId, draft: draft(), actorRole: 'fullstack' });

  ledger.createSession({ sessionId: 'feature:broken', integrationTarget: 'main' });
  fs.writeFileSync(ledger.sessionFile('feature:broken'), '{ not json');

  const rows = ledger.inbox({ role: 'reviewer' });
  assert.deepEqual(rows.map((r) => r.unreadable ?? r.handoffId),
    ['LEDGER_CORRUPT', 'handoff:fullstack-to-reviewer-1']);
});

/**
 * "Where was I" has to stay answerable after the mail is gone.
 *
 * `inbox` empties on acknowledgement and a reviewer holds nothing else — it never owns a task —
 * so between acking a handoff and recording the decision no artifact ties it to the session it
 * is working in. The event log does, because every event names the actor that caused it, and
 * that is the difference between the recovery path saying "wait here" and saying "start a
 * second session for the work already under way".
 *
 * Terminal sessions are excluded, and asserted here rather than left to the caller: a completed
 * session will never hold a task again, so offering it as the place to wait is advice that
 * cannot come good.
 */
test('participation finds the sessions an agent acted in, newest first, minus the finished ones', () => {
  const ledger = tempLedger();
  const act = (sessionId, actor) => {
    ledger.createSession({ sessionId, integrationTarget: 'main', actor });
    return sessionId;
  };
  act('feature:one', 'agent:reviewer-01');
  act('feature:two', 'agent:fullstack-01');
  act('feature:three', 'agent:reviewer-01');

  // Ordering is by last activity, not by session name: `feature:two` is touched last and comes
  // first even though it sorts last, and the reviewer never touched it at all.
  ledger.setSessionStatus('feature:two', 'product-definition', { actor: 'agent:reviewer-01' });

  const seen = ledger.participation({ subject: 'agent:reviewer-01' });
  assert.deepEqual(seen.map((row) => row.sessionId), ['feature:two', 'feature:three', 'feature:one']);
  assert.deepEqual(seen[0], {
    sessionId: 'feature:two',
    sessionStatus: 'product-definition',
    lastAt: seen[0].lastAt,
    lastKind: 'session-status-changed',
    events: 1,
  }, 'the row says what the agent last did there, so a caller can tell resuming from starting');

  // An agent that has done nothing anywhere gets an empty list rather than somebody else's work.
  assert.deepEqual(ledger.participation({ subject: 'agent:nobody-01' }), []);
  assert.deepEqual(ledger.participation({ subject: 'agent:fullstack-01' }).map((r) => r.sessionId),
    ['feature:two']);

  // Cancelling drops it out, and the runner-up takes its place.
  ledger.setSessionStatus('feature:two', 'cancelled', { actor: 'agent:fullstack-01' });
  assert.deepEqual(ledger.participation({ subject: 'agent:reviewer-01' }).map((r) => r.sessionId),
    ['feature:three', 'feature:one']);

  // A session nobody can read is skipped, not thrown: this is the recovery path, and it is
  // `inbox` that reports the corruption as a row.
  fs.writeFileSync(ledger.sessionFile('feature:three'), '{ not json');
  assert.deepEqual(ledger.participation({ subject: 'agent:reviewer-01' }).map((r) => r.sessionId),
    ['feature:one']);

  assert.equal(code(() => ledger.participation({ subject: '' })), 'MALFORMED_ID');
});

/**
 * An ack is what empties a queue, so only the addressee may issue one.
 *
 * The damage from getting this wrong is not a misattributed event: the handoff
 * leaves the addressee's inbox, so the state transfer is dropped and the recipient
 * never learns there was anything waiting. That is precisely the failure the layer
 * exists to prevent, arrived at through its own bookkeeping.
 */
test('only the addressee can acknowledge, so nobody else can empty their queue', () => {
  const { ledger, sessionId } = taskedSession();
  const open = ledger.publishHandoff({ sessionId, draft: draft(), actorRole: 'fullstack' });
  const narrowed = ledger.publishHandoff({ sessionId, actorRole: 'fullstack',
    draft: draft({ to: { role: 'reviewer', subject: 'agent:reviewer-07' } }) });

  const ack = (handoffId, over = {}) => code(() => ledger.ackHandoff({ sessionId, handoffId, ...over }));
  assert.equal(ack(open.handoffId, { actorRole: 'product-architect' }), 'HANDOFF_NOT_ADDRESSEE');
  // Omitting the role does not skip the check; a safety property that switches
  // itself off when a caller forgets an argument is not one you can rely on.
  assert.equal(ack(open.handoffId), 'UNKNOWN_ROLE');
  assert.equal(ledger.readEvents(sessionId).some((e) => e.kind === 'handoff-acked'), false);

  // A handoff narrowed to one agent is not ackable by another holding the role.
  assert.equal(ack(narrowed.handoffId, { actorRole: 'reviewer' }), 'HANDOFF_NOT_ADDRESSEE');
  assert.equal(ack(narrowed.handoffId, { actorRole: 'reviewer', actor: 'agent:reviewer-07' }), null);

  // Role-only addressing reaches whoever holds the role, whatever their agent id.
  assert.equal(ack(open.handoffId, { actorRole: 'reviewer', actor: 'agent:reviewer-99' }), null);
  assert.deepEqual(ledger.readEvents(sessionId)
    .filter((e) => e.kind === 'handoff-acked').map((e) => [e.actor, e.actorRole]),
  [['agent:reviewer-07', 'reviewer'], ['agent:reviewer-99', 'reviewer']]);
});

// ----------------------------------------------------------------------- reviews

const REQUIREMENT = `sha256:${'1'.repeat(64)}`;

function decision(overrides = {}) {
  return {
    taskId: 'task:coupon',
    status: 'approved',
    candidateRevision: 'git:def5678',
    requirementsRevision: REQUIREMENT,
    summary: 'AC-1 holds: the discount is applied in the domain layer, so the import path shares the rule.',
    ...overrides,
  };
}

function finding(overrides = {}) {
  return {
    schemaVersion: 1,
    findingId: 'FIND-001',
    severity: 'blocker',
    status: 'open',
    candidateRevision: 'git:def5678',
    requirement: 'AC-1',
    location: 'src/coupon/apply.ts:12',
    evidence: 'Two coupons on one order both apply.',
    impact: 'The order total can go negative.',
    requiredOutcome: 'At most one coupon applies per order.',
    ...overrides,
  };
}

/** Record a decision as a reviewer who is not the task subject. */
function review(ledger, sessionId, draft, over = {}) {
  return ledger.recordReview({ sessionId, draft, actorRole: 'reviewer', ...over });
}

test('a recorded review is schema-valid and the ledger owns its identity', () => {
  const { ledger, sessionId } = taskedSession();
  const record = review(ledger, sessionId, decision());

  assert.deepEqual(validate(REVIEW_SCHEMA, record), []);
  // `review:<task-name>-<seq>`, not `review:coupon:3`: an id carries at most one
  // `:`, so the scheme has to be the only colon in it.
  assert.equal(record.reviewId, 'review:coupon-1');
  assert.equal(record.seq, 1);
  assert.deepEqual(record.decision.reviewer, { subject: 'test', role: 'reviewer' });

  // The snapshot is copied from the task, not accepted from the reviewer, so a
  // decision cannot claim to have been made against truth that never held.
  const task = ledger.readTask(sessionId, 'task:coupon');
  assert.equal(record.decision.inputSnapshotDigest, task.inputSnapshotDigest);

  const event = ledger.readEvents(sessionId).find((e) => e.kind === 'review-recorded');
  assert.equal(event.reviewId, record.reviewId);
  assert.equal(event.at, record.recordedAt);
  assert.equal(event.decisionDigest, record.decisionDigest);
  assert.deepEqual(ledger.listReviews(sessionId).map((r) => r.reviewId), [record.reviewId]);
});

/**
 * "Reviewer approval is semantic evidence, and does not bypass the CI/tests/spec-suite
 * gate" (plan §5, last line), made mechanical.
 *
 * This is an absence test, and absences are what rot: the natural next edit is to
 * have `recordReview` advance the task to `approved` for the caller's convenience,
 * and the day it does, the reviewer's opinion becomes sufficient on its own. The
 * merge gate still owes its structural checks, so nothing here may move on its say.
 */
test('recording a decision moves neither the task nor the session', () => {
  const { ledger, sessionId } = taskedSession();
  const before = { task: ledger.readTask(sessionId, 'task:coupon'), session: ledger.readSession(sessionId) };

  review(ledger, sessionId, decision());

  const task = ledger.readTask(sessionId, 'task:coupon');
  assert.equal(task.state.status, before.task.state.status);
  assert.equal(task.state.generation, before.task.state.generation);
  assert.equal(task.frozenDigest, before.task.frozenDigest);
  assert.equal(ledger.readSession(sessionId).status, before.session.status);

  // Only the record itself was added to the log: no status transition slipped in
  // alongside it under a different event kind.
  assert.deepEqual(ledger.readEvents(sessionId).slice(before.session.eventSeq).map((e) => e.kind),
    ['review-recorded']);
});

/**
 * An approval binds candidate, input snapshot and requirement revision (plan §5).
 *
 * The requirement half is the one worth enforcing rather than merely storing. An
 * approval anchored to a revision the task never depended on cannot go stale when
 * the real requirement moves — so accepting an unchecked string would give the
 * binding the appearance of being enforced, which is worse than not having the
 * field, because a later reader would trust it.
 */
test('an approval must name a requirement revision the task actually depends on', () => {
  const { ledger, sessionId } = taskedSession();
  const record = (over) => code(() => review(ledger, sessionId, decision(over)));

  assert.equal(record({ requirementsRevision: undefined }), 'MALFORMED_REVIEW');
  assert.equal(record({ requirementsRevision: `sha256:${'9'.repeat(64)}` }), 'REVIEW_REQUIREMENT_UNKNOWN');
  assert.equal(record({ requirementsRevision: 'not-a-revision' }), 'MALFORMED_REVISION');

  // A non-approval may omit it: asking for changes does not stop being the right
  // answer when the contract moves underneath it.
  assert.equal(record({
    status: 'changes-requested', requirementsRevision: undefined, findings: [finding()],
  }), null);
  assert.equal(record({}), null);
});

/**
 * A decision that contradicts its own findings is internally inconsistent frozen
 * truth: every later reader has to guess which half to believe.
 */
test('a decision may not contradict its own findings', () => {
  const { ledger, sessionId } = taskedSession();
  const record = (over) => code(() => review(ledger, sessionId, decision(over)));

  assert.equal(record({ findings: [finding()] }), 'REVIEW_INCONSISTENT');
  assert.equal(record({ status: 'changes-requested', findings: [] }), 'REVIEW_INCONSISTENT');
  assert.equal(record({ status: 'changes-requested', findings: [finding({ status: 'verified' })] }),
    'REVIEW_INCONSISTENT');
  assert.equal(record({ status: 'blocked-unresolved', findings: [finding()] }), 'REVIEW_INCONSISTENT');
  assert.equal(record({ status: 'blocked-unresolved', findings: [finding({ status: 'unresolved-product' })] }),
    null);

  // Only `blocker` blocks. Refusing on an unresolved `major` would not produce
  // better reviews; it would produce majors relabelled as minors, which destroys
  // the signal rather than the ambiguity.
  assert.equal(record({ findings: [finding({ severity: 'major' })] }), null);

  // `fixed` is the implementer's claim, so it is not outstanding: a reviewer looking
  // at a fixed finding either verifies it or does not, and both answers move it out
  // of the set. Counting it would block approvals that have done the work already.
  assert.equal(record({ findings: [finding({ status: 'fixed' })] }), null);
  assert.equal(record({ status: 'changes-requested', findings: [finding({ status: 'fixed' })] }),
    'REVIEW_INCONSISTENT');
});

/**
 * Nobody reviews their own work — checked on task ownership, not on role name.
 *
 * A check that read "only the `reviewer` role may approve" would be a second copy of
 * the role list to keep in step with the registry, and it would still permit the one
 * case that matters: an agent holding the reviewer role approving a task assigned to
 * itself. Ownership is the property that actually carries the independence.
 */
test('a task subject cannot review its own work, whatever role it claims', () => {
  const { ledger, sessionId } = taskedSession();
  assert.equal(code(() => review(ledger, sessionId, decision(), { actor: 'agent:fullstack-01' })),
    'REVIEW_SELF');
  assert.equal(code(() => review(ledger, sessionId, decision(),
    { actor: 'agent:fullstack-01', actorRole: 'reviewer' })), 'REVIEW_SELF');
  assert.equal(ledger.listReviews(sessionId).length, 0);
});

test('a review draft cannot assign what the ledger owns, or misspell what it does own', () => {
  const { ledger, sessionId } = taskedSession();
  const record = (over) => code(() => review(ledger, sessionId, decision(over)));

  for (const owned of ['reviewId', 'seq', 'reviewer', 'recordedAt', 'recordedBy', 'decisionDigest']) {
    assert.equal(record({ [owned]: 'anything' }), 'MALFORMED_REVIEW', `${owned} is the ledger's to assign`);
  }
  // A misspelled field is refused rather than ignored, because ignoring it records
  // a decision whose content is silently missing — and the digest would certify it.
  assert.equal(record({ finding: [finding()] }), 'MALFORMED_REVIEW');
  assert.equal(record({ summary: '   ' }), 'MALFORMED_REVIEW');
  assert.equal(record({ validationEvidence: ['evidence:unit-tests-1', ''] }), 'MALFORMED_REVIEW');
  assert.equal(record({ validationEvidence: ['evidence:a-1', 'evidence:a-1'] }), 'MALFORMED_REVIEW');
  // A citation nobody can follow is decoration. `npm test` was the v1 shape and is
  // not even id-shaped, so it must come back as unfollowable evidence rather than as
  // a lexical complaint about slugs — the reviewer needs to know what to record.
  assert.equal(record({ validationEvidence: ['npm test'] }), 'REVIEW_EVIDENCE_UNKNOWN');
  assert.equal(record({ validationEvidence: ['evidence:unit-tests-1'] }), 'REVIEW_EVIDENCE_UNKNOWN');
  assert.equal(record({ findings: [finding({ severity: 'critical' })] }), 'MALFORMED_REVIEW');
  assert.equal(record({ findings: [finding({ status: 'wontfix' })] }), 'MALFORMED_REVIEW');
  assert.equal(record({ status: 'lgtm' }), 'UNKNOWN_REVIEW_STATUS');
  assert.equal(code(() => review(ledger, sessionId, decision(), { actorRole: 'architect' })), 'UNKNOWN_ROLE');
  assert.equal(record({ sessionId: 'feature:other' }), 'SESSION_MISMATCH');
  assert.equal(record({ taskId: 'task:absent' }), 'NOT_FOUND');
  assert.equal(ledger.listReviews(sessionId).length, 0);
});

/**
 * The digest identifies the judgement, not the act of recording it.
 *
 * Two identical decisions must hash identically so that "you already approved this"
 * is detectable; that is why `seq`, `recordedAt` and the id that embeds `seq` sit
 * outside the digested half.
 */
test('identical judgements hash identically and remain separately addressable', () => {
  const { ledger, sessionId } = taskedSession();
  const first = review(ledger, sessionId, decision());
  const again = review(ledger, sessionId, decision());

  assert.equal(again.decisionDigest, first.decisionDigest);
  assert.notEqual(again.reviewId, first.reviewId);
  assert.deepEqual(ledger.listReviews(sessionId).map((r) => r.seq), [1, 2]);

  const moved = review(ledger, sessionId, decision({ candidateRevision: 'git:ba55e77' }));
  assert.notEqual(moved.decisionDigest, first.decisionDigest);
});

/**
 * An approval anyone can edit is an approval anyone can manufacture.
 *
 * Unlike a handoff, an approval is consulted by something downstream deciding
 * whether work may proceed, so it has to be tamper-evident on every read rather
 * than at some later audit — by then the merge has already happened.
 */
test('an edited decision is refused on read rather than silently believed', () => {
  const { ledger, sessionId } = taskedSession();
  const record = review(ledger, sessionId, decision({ status: 'changes-requested', findings: [finding()] }));
  const file = ledger.reviewFile(sessionId, record.reviewId);

  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.decision.status = 'approved';
  stored.decision.findings = [];
  fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);

  assert.equal(code(() => ledger.readReview(sessionId, record.reviewId)), 'REVIEW_TAMPERED');
  // And it does not become believable by being read through the listing instead.
  assert.equal(code(() => ledger.listReviews(sessionId)), 'REVIEW_TAMPERED');
  assert.equal(code(() => ledger.reviewStateFor(sessionId, 'task:coupon')), 'REVIEW_TAMPERED');
});

/**
 * Plan §17 Scenario 5: reviewer approved `git:AAA`, fullstack then created `git:BBB`,
 * so the old approval must be stale.
 *
 * It is derived on read, never stored. A `stale: false` written at approval time is
 * a fact with an expiry date — the commit that invalidates it has no way to reach
 * back into the JSON file — so the only honest place to compute it is here, where
 * both halves of the comparison are current.
 */
test('an approval stops applying when the candidate or the inputs move', () => {
  const { ledger, sessionId } = taskedSession();
  const state = (over) => ledger.reviewStateFor(sessionId, 'task:coupon', over);

  const none = state({ candidateRevision: 'git:aaaaaaa' });
  assert.deepEqual([none.status, none.applies, none.reasons, none.observed],
    ['none', false, ['no-review'], null]);

  review(ledger, sessionId, decision({ candidateRevision: 'git:aaaaaaa' }));
  const fresh = state({ candidateRevision: 'git:aaaaaaa' });
  assert.deepEqual([fresh.status, fresh.applies, fresh.reasons], ['approved', true, []]);
  assert.equal(fresh.reviewId, 'review:coupon-1');
  assert.equal(fresh.reviewCount, 1);

  const moved = state({ candidateRevision: 'git:bbbbbbb' });
  assert.deepEqual([moved.applies, moved.reasons], [false, ['candidate-moved']]);
  assert.equal(moved.observed.candidateRevision, 'git:aaaaaaa', 'it says which candidate was approved');
  assert.equal(moved.current.candidateRevision, 'git:bbbbbbb', 'and which one was asked about');

  // No candidate supplied is unknown, not approved: this layer does not run git, and
  // answering "yes" about a candidate nobody named is the failure mode to avoid.
  const unknown = state();
  assert.deepEqual([unknown.applies, unknown.reasons], [null, ['candidate-unknown']]);

  // Inputs moving is known regardless of which candidate is being asked about, so it
  // is false rather than null even with no candidate.
  ledger.reissueTask({
    sessionId, reason: 'coupon contract v2',
    packet: packet({ inputs: [{ id: 'contract:coupon', revision: `sha256:${'9'.repeat(64)}`, authority: 'product-architect' }] }),
  });
  assert.deepEqual(state().reasons, ['inputs-moved']);
  assert.equal(state().applies, false);
  assert.deepEqual(state({ candidateRevision: 'git:aaaaaaa' }).reasons, ['inputs-moved']);
  assert.deepEqual(state({ candidateRevision: 'git:bbbbbbb' }).reasons, ['inputs-moved', 'candidate-moved']);

  // The latest decision is the one that answers, and it can restore applicability.
  review(ledger, sessionId, decision({
    candidateRevision: 'git:bbbbbbb', requirementsRevision: `sha256:${'9'.repeat(64)}`,
  }));
  const again = state({ candidateRevision: 'git:bbbbbbb' });
  assert.deepEqual([again.applies, again.reasons, again.reviewCount], [true, [], 2]);
  assert.equal(again.observed.requirementsRevision, `sha256:${'9'.repeat(64)}`);
});

/**
 * The same staleness, refused at record time when the reviewer declares the snapshot.
 *
 * Declaring it is optional, because the ledger copies the current snapshot anyway.
 * What the declaration buys is the refusal: a reviewer who read the task, went away
 * to review, and came back after a reissue would otherwise have their judgement
 * silently relabelled as being about inputs they never saw.
 */
test('a review declaring a snapshot the task has moved past is refused', () => {
  const { ledger, sessionId } = taskedSession();
  const stale = ledger.readTask(sessionId, 'task:coupon').inputSnapshotDigest;
  assert.equal(code(() => review(ledger, sessionId, decision({ inputSnapshotDigest: stale }))), null);

  ledger.reissueTask({
    sessionId, reason: 'coupon contract v2',
    packet: packet({ inputs: [{ id: 'contract:coupon', revision: `sha256:${'9'.repeat(64)}`, authority: 'product-architect' }] }),
  });
  assert.equal(code(() => review(ledger, sessionId, decision({
    inputSnapshotDigest: stale, requirementsRevision: `sha256:${'9'.repeat(64)}`,
  }))), 'REVIEW_STALE');
  assert.equal(ledger.listReviews(sessionId).length, 1);
});

test('the shipped review template records against the shipped task packet', () => {
  const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'review-decision.json'), 'utf8'));
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'task-packet.json'), 'utf8'));
  const { ledger, sessionId } = startedSession({ sessionId: shipped.sessionId });
  ledger.issueTask({ sessionId, packet: shipped });

  // Only the ids are filled in. The requirement the template approves against is
  // one the shipped packet declares, so the two templates can be followed end to
  // end — a review template naming a revision no shipped task depends on would
  // teach the reader a shape that is refused the first time they try it.
  const record = review(ledger, sessionId, { ...template, sessionId, taskId: shipped.taskId });
  assert.deepEqual(validate(REVIEW_SCHEMA, record), []);
  assert.equal(record.decision.status, 'approved');
});

// -------------------------------------------------------------------- validation

/** A result in the shape `runCommandCheck` returns, without running anything. */
function result(overrides = {}) {
  return {
    status: 'passed',
    exitCode: 0,
    durationMs: 1234,
    resultDigest: `sha256:${'a'.repeat(64)}`,
    outputExcerpt: '42 tests, 0 failures\n',
    outputTruncated: false,
    ...overrides,
  };
}

function evidence(ledger, sessionId, over = {}) {
  return ledger.recordEvidence({
    sessionId,
    taskId: 'task:coupon',
    checkId: 'unit-tests',
    candidateRevision: 'git:def5678',
    result: result(),
    ...over,
  });
}

/** A plan with one check of each kind, so both gate paths are exercisable. */
function mixedPacket(overrides = {}) {
  return packet({
    validationPlan: [
      { checkId: 'unit-tests', kind: 'command', requiredAt: ['handoff', 'merge'], command: 'npm test' },
      { checkId: 'peer-review', kind: 'review', requiredAt: ['merge'], role: 'reviewer' },
    ],
    ...overrides,
  });
}

test('a recorded evidence record is schema-valid and the ledger owns its identity', () => {
  const { ledger, sessionId } = taskedSession();
  const record = evidence(ledger, sessionId);

  assert.deepEqual(validate(EVIDENCE_SCHEMA, record), []);
  assert.deepEqual([record.evidenceId, record.seq], ['evidence:unit-tests-1', 1]);
  assert.equal(record.recordedBy, 'test');
  // The snapshot is copied from the task, like a handoff's and a review's: evidence
  // that could name its own snapshot could claim to be about truth it never saw.
  assert.equal(record.inputSnapshotDigest, ledger.readTask(sessionId, 'task:coupon').inputSnapshotDigest);

  const event = ledger.readEvents(sessionId).find((e) => e.kind === 'evidence-recorded');
  assert.deepEqual([event.evidenceId, event.checkId, event.status], ['evidence:unit-tests-1', 'unit-tests', 'passed']);

  // Recording evidence is an input to a gate, not the gate: it moves nothing.
  assert.equal(ledger.readTask(sessionId, 'task:coupon').state.status, 'issued');
  assert.equal(ledger.readSession(sessionId).status, 'forming');
});

/**
 * The seal covers the whole record, `seq` and `recordedAt` included.
 *
 * Deliberately unlike a review, whose digest covers only the judgement so that the same
 * judgement hashes identically twice. Nothing here needs that: two runs of one suite are
 * two observations, and a gate *reads* `status`, so a flippable one is a forgeable pass.
 */
test('an edited evidence record is refused on read rather than silently believed', () => {
  const { ledger, sessionId } = taskedSession();
  const record = evidence(ledger, sessionId, { result: result({ status: 'failed', exitCode: 1 }) });
  const file = ledger.evidenceFile(sessionId, record.evidenceId);

  assert.equal(ledger.readEvidence(sessionId, record.evidenceId).status, 'failed');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...stored, status: 'passed' }));
  assert.equal(code(() => ledger.readEvidence(sessionId, record.evidenceId)), 'EVIDENCE_TAMPERED');

  // Not just the verdict: rewriting when it happened, to make an old run look current,
  // is the same attack with a different field.
  fs.writeFileSync(file, JSON.stringify({ ...stored, recordedAt: '2030-01-01T00:00:00.000Z' }));
  assert.equal(code(() => ledger.readEvidence(sessionId, record.evidenceId)), 'EVIDENCE_TAMPERED');
});

/**
 * A packet whose plan cannot be run is refused at freeze, before anything depends on it.
 *
 * The plan is inside the frozen half of the packet, so this is the only moment the
 * ledger can say no: afterwards the unrunnable check is part of an immutable record that
 * some gate is required to consult.
 */
test('a task whose validation plan could not be run is refused at issue', () => {
  const { ledger, sessionId } = startedSession();
  for (const [name, plan] of [
    ['no plan at all', undefined],
    ['an empty plan', []],
    ['a command check with nothing to run', [{ checkId: 'unit-tests', kind: 'command', requiredAt: ['merge'] }]],
    ['a gate nobody consults', [{ checkId: 'unit-tests', kind: 'command', requiredAt: ['vibe-check'], command: 'npm test' }]],
    ['a review check naming a role nobody has', [{ checkId: 'peer', kind: 'review', requiredAt: ['merge'], role: 'vibe-officer' }]],
  ]) {
    assert.equal(code(() => ledger.issueTask({ sessionId, packet: packet({ validationPlan: plan }) })),
      'MALFORMED_TASK', name);
  }

  // v1's `validation: string[]` is refused by name rather than tolerated alongside the
  // plan. Two answers to "how is this shown to be done" is worse than one wrong one:
  // whichever the reader believes, half the toolchain consults the other.
  const legacy = packet({ schemaVersion: 1, validation: ['npm test'] });
  delete legacy.validationPlan;
  const refused = () => ledger.issueTask({ sessionId, packet: legacy });
  assert.equal(code(refused), 'MALFORMED_TASK');
  assert.throws(refused, /validationPlan/, 'the refusal has to say what to write instead');
  assert.deepEqual(ledger.listTasks(sessionId), []);
});

test('evidence must answer a check the packet actually declares, of a kind it can answer', () => {
  const { ledger, sessionId } = startedSession();
  ledger.issueTask({ sessionId, packet: mixedPacket() });

  // A check nobody asked for reads in `listEvidence` exactly like a required one, and
  // no gate would ever notice the difference.
  assert.equal(code(() => evidence(ledger, sessionId, { checkId: 'lint' })), 'EVIDENCE_CHECK_UNKNOWN');
  // A human judgement recorded as machine output would put the same fact in two places,
  // and the two would disagree the first time one of them was rerun.
  assert.equal(code(() => evidence(ledger, sessionId, { checkId: 'peer-review' })), 'EVIDENCE_KIND_MISMATCH');

  for (const [name, bad, expected] of [
    ['no result', { result: undefined }, 'MALFORMED_EVIDENCE'],
    ['a verdict the vocabulary lacks', { result: result({ status: 'green' }) }, 'UNKNOWN_EVIDENCE_STATUS'],
    ['a conclusion with no output behind it', { result: result({ resultDigest: '' }) }, 'MALFORMED_EVIDENCE'],
    ['a negative duration', { result: result({ durationMs: -1 }) }, 'MALFORMED_EVIDENCE'],
    ['a non-integer exit code', { result: result({ exitCode: 'ok' }) }, 'MALFORMED_EVIDENCE'],
  ]) {
    assert.equal(code(() => evidence(ledger, sessionId, bad)), expected, name);
  }
  assert.deepEqual(ledger.listEvidence(sessionId), [], 'nothing refused was written');

  // A check that never exited has no exit code, and null is how it says so rather than
  // 0 — which would be indistinguishable from success.
  assert.equal(evidence(ledger, sessionId, {
    result: result({ status: 'errored', exitCode: null, note: 'the check did not finish within 250ms' }),
  }).exitCode, null);
});

/**
 * Staleness refused at record time, the same way a review's is (plan §17 Scenario 2).
 *
 * A long suite is exactly where this bites: the task is restated while it runs, and the
 * result that arrives afterwards describes inputs that are no longer the task's. Passing
 * the snapshot read before the run is what turns that into a refusal instead of a
 * credited pass.
 */
test('evidence run against inputs the task has moved past is refused', () => {
  const { ledger, sessionId } = taskedSession();
  const stale = ledger.readTask(sessionId, 'task:coupon').inputSnapshotDigest;
  assert.equal(code(() => evidence(ledger, sessionId, { inputSnapshotDigest: stale })), null);

  ledger.reissueTask({
    sessionId, reason: 'coupon contract v2',
    packet: packet({ inputs: [{ id: 'contract:coupon', revision: `sha256:${'9'.repeat(64)}`, authority: 'product-architect' }] }),
  });
  assert.equal(code(() => evidence(ledger, sessionId, { inputSnapshotDigest: stale })), 'EVIDENCE_STALE');
  assert.equal(ledger.listEvidence(sessionId).length, 1);

  // Declaring it stays optional, because the ledger copies the current snapshot anyway.
  // What the declaration buys is the refusal above.
  assert.equal(code(() => evidence(ledger, sessionId)), null);
});

test('evidence is listable by task and by check, in the order it was recorded', () => {
  const { ledger, sessionId } = startedSession();
  ledger.issueTask({ sessionId, packet: mixedPacket() });
  ledger.issueTask({ sessionId, packet: mixedPacket({ taskId: 'task:refund' }) });
  evidence(ledger, sessionId);
  evidence(ledger, sessionId, { result: result({ status: 'failed', exitCode: 1 }) });
  evidence(ledger, sessionId, { taskId: 'task:refund' });

  // The sequence is per session, so two checks can never produce one id — and the ids
  // stay sortable into the order the runs actually happened in.
  assert.deepEqual(ledger.listEvidence(sessionId).map((e) => e.evidenceId),
    ['evidence:unit-tests-1', 'evidence:unit-tests-2', 'evidence:unit-tests-3']);
  assert.deepEqual(ledger.listEvidence(sessionId, { taskId: 'task:refund' }).map((e) => e.seq), [3]);
  assert.deepEqual(ledger.listEvidence(sessionId, { checkId: 'lint' }), []);
  assert.equal(code(() => ledger.readEvidence(sessionId, 'evidence:unit-tests-9')), 'NOT_FOUND');
});

/**
 * A gate's answer is derived on every call, so it can never be stale — only unknown.
 *
 * Three-valued because two values force a lie. Evidence that describes a candidate the
 * work has moved past is not a failure (it sends the implementer to fix passing code)
 * and not a pass (it merges something nothing ran against).
 */
test('a gate is answered from the records and the candidate, and never stored', () => {
  const { ledger, sessionId } = startedSession();
  ledger.issueTask({ sessionId, packet: mixedPacket() });
  const at = (gate, over = {}) => ledger.validationStateFor(sessionId, 'task:coupon',
    { gate, candidateRevision: 'git:def5678', ...over });

  const cold = at('handoff');
  assert.deepEqual([cold.status, cold.required, cold.unknown], ['unknown', 1, 1]);
  assert.deepEqual(cold.checks[0].reasons, ['no-evidence']);

  evidence(ledger, sessionId);
  assert.equal(at('handoff').status, 'passed');
  // One check required at two gates is one check: the same record answers both.
  assert.deepEqual([at('merge').status, at('merge').passed, at('merge').unknown], ['unknown', 1, 1]);
  // A gate this task asks nothing of is passed, with the reason attached so a caller
  // printing it says "nothing is required here" rather than implying it verified something.
  assert.deepEqual([at('integration').status, at('integration').reasons], ['passed', ['no-checks-required']]);
  assert.equal(code(() => at('ship-it')), 'UNKNOWN_VALIDATION_GATE');

  // A newer run supersedes an older one for the same check, in both directions.
  evidence(ledger, sessionId, { result: result({ status: 'failed', exitCode: 1 }) });
  assert.deepEqual([at('handoff').status, at('handoff').checks[0].runs], ['failed', 2]);
  evidence(ledger, sessionId);
  assert.equal(at('handoff').status, 'passed');

  // Then the candidate moves. The pass does not survive it, and neither does the
  // failure: what is known is that nothing has been run against this.
  const moved = at('handoff', { candidateRevision: 'git:9999999' });
  assert.deepEqual([moved.status, moved.checks[0].reasons], ['unknown', ['candidate-moved']]);
  assert.equal(moved.checks[0].observed.candidateRevision, 'git:def5678',
    'the answer says which candidate it is about, so the caller can see the gap');
  // And asking without naming a candidate is answered as unknown rather than assumed.
  assert.deepEqual(at('handoff', { candidateRevision: null }).checks[0].reasons, ['candidate-unknown']);

  // An errored run is unknown, not failed: it says nothing about the candidate, so the
  // next action is to fix the runner rather than the code.
  evidence(ledger, sessionId, { result: result({ status: 'errored', exitCode: null, note: 'runner died' }) });
  const errored = at('handoff');
  assert.deepEqual([errored.status, errored.checks[0].reasons], ['unknown', ['errored']]);
});

test('a review check at a gate is answered by the review ledger, not by evidence', () => {
  const { ledger, sessionId } = startedSession();
  ledger.issueTask({ sessionId, packet: mixedPacket() });
  const merge = () => ledger.validationStateFor(sessionId, 'task:coupon',
    { gate: 'merge', candidateRevision: 'git:def5678' });
  evidence(ledger, sessionId);

  const before = merge().checks.find((c) => c.checkId === 'peer-review');
  assert.deepEqual([before.status, before.reasons], ['unknown', ['no-review']]);

  review(ledger, sessionId, decision());
  assert.deepEqual([merge().status, merge().passed], ['passed', 2]);

  // A changes-requested decision is a failure of the check, not an absence of one.
  review(ledger, sessionId, decision({
    status: 'changes-requested', requirementsRevision: undefined, findings: [finding()],
  }));
  assert.equal(merge().status, 'failed');

  // An approval from the wrong capacity does not satisfy a check that named a role.
  // Unknown rather than failed: somebody did approve this, and what is missing is the
  // required reviewer's answer rather than a verdict against the work.
  const { ledger: other, sessionId: otherSession } = startedSession();
  other.issueTask({ sessionId: otherSession, packet: mixedPacket() });
  review(other, otherSession, decision(), { actorRole: 'product-architect' });
  const wrongRole = other.validationStateFor(otherSession, 'task:coupon',
    { gate: 'merge', candidateRevision: 'git:def5678' }).checks.find((c) => c.checkId === 'peer-review');
  assert.deepEqual([wrongRole.status, wrongRole.reasons], ['unknown', ['role-mismatch']]);
});

/**
 * A failing check settles the gate even while other checks are unmeasured.
 *
 * The other order would be worse: reporting `unknown` because something else has not
 * run yet hides a definite failure behind a shrug, and the caller retries instead of
 * fixing it.
 */
test('a definite failure outranks an unmeasured check at the same gate', () => {
  const { ledger, sessionId } = startedSession();
  ledger.issueTask({ sessionId, packet: mixedPacket() });
  evidence(ledger, sessionId, { result: result({ status: 'failed', exitCode: 1 }) });
  const state = ledger.validationStateFor(sessionId, 'task:coupon',
    { gate: 'merge', candidateRevision: 'git:def5678' });
  assert.deepEqual([state.status, state.failed, state.unknown], ['failed', 1, 1]);
});

/**
 * A citation has to resolve, or an approval's evidence is decoration.
 *
 * The mismatch case is the one worth having: a real record, correctly sealed, about a
 * different candidate is the most convincing kind of false confidence there is.
 */
test('a review may only cite evidence from this task and this candidate', () => {
  const { ledger, sessionId } = startedSession();
  ledger.issueTask({ sessionId, packet: mixedPacket() });
  ledger.issueTask({ sessionId, packet: mixedPacket({ taskId: 'task:refund' }) });
  evidence(ledger, sessionId);
  evidence(ledger, sessionId, { taskId: 'task:refund' });

  assert.equal(code(() => review(ledger, sessionId,
    decision({ validationEvidence: ['evidence:unit-tests-1'] }))), null);
  for (const [name, cited, expected] of [
    ['a citation nobody can resolve', ['evidence:unit-tests-9'], 'REVIEW_EVIDENCE_UNKNOWN'],
    ['a citation that is not an id', ['npm test'], 'REVIEW_EVIDENCE_UNKNOWN'],
    ['evidence belonging to another task', ['evidence:unit-tests-2'], 'REVIEW_EVIDENCE_UNKNOWN'],
    ['the same run cited twice', ['evidence:unit-tests-1', 'evidence:unit-tests-1'], 'MALFORMED_REVIEW'],
    ['an empty citation', [''], 'MALFORMED_REVIEW'],
  ]) {
    assert.equal(code(() => review(ledger, sessionId, decision({ validationEvidence: cited }))), expected, name);
  }

  // Same task, same session, real record — about the commit before this one.
  assert.equal(code(() => review(ledger, sessionId, decision({
    candidateRevision: 'git:9999999', validationEvidence: ['evidence:unit-tests-1'],
  }))), 'REVIEW_EVIDENCE_MISMATCH');
});

test('the shipped task packet declares a plan both gates can be asked about', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'task-packet.json'), 'utf8'));
  const { ledger, sessionId } = startedSession({ sessionId: shipped.sessionId });
  ledger.issueTask({ sessionId, packet: shipped });
  for (const gate of ['handoff', 'merge']) {
    const state = ledger.validationStateFor(sessionId, shipped.taskId, { gate, candidateRevision: 'git:def5678' });
    assert.equal(state.status, 'unknown', `${gate} must be answerable and honest before anything runs`);
    assert.ok(state.required >= 1, `${gate} must actually ask for something`);
  }
});


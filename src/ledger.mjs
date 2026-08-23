/**
 * The session ledger: shared, repository-local collaboration state.
 *
 * Stored under `<git-common-dir>/team-layer/` because linked worktrees share
 * the Git common dir natively (plan §3). Three local Agent windows therefore
 * see one ledger with no Redis, no database and no message broker.
 *
 *   .git/team-layer/sessions/<session-slug>/
 *     session.json      mutable session state, CAS-guarded by `revision`
 *     tasks/<slug>.json frozen task truth + mutable task state
 *     events.jsonl      append-only audit log
 *     .lock/            mkdir-based mutual exclusion
 *
 * Three properties this module exists to guarantee, because losing any one of
 * them is a silent-corruption bug rather than a visible failure:
 *
 * 1. No lost update. Every mutation happens under a lock *and* carries a
 *    compare-and-swap on an integer revision, so a writer that somehow
 *    bypassed the lock still cannot overwrite a state it never read.
 * 2. No torn file. Documents are written to a temp file and renamed;
 *    events are appended one complete line at a time.
 * 3. No silently mutated frozen truth. A task's frozen packet is stored with
 *    its digest and re-verified on every read, so editing the file by hand is
 *    detected rather than obeyed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { jsonDigest, inputSnapshotDigest, assertRevision } from './digest.mjs';
import { isRole, roleIds } from './roles.mjs';
import { assertId, slug, unslug } from './slug.mjs';

export class LedgerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    if (details) this.details = details;
  }
}

// ---------------------------------------------------------------- state machines

/**
 * Session statuses and their legal transitions (plan §3.2).
 *
 * The set is closed on purpose: an unlisted status is a spelling mistake, and a
 * transition that is not written down here is refused rather than guessed at.
 */
export const SESSION_STATUSES = [
  'forming',
  'product-definition',
  'ready-for-implementation',
  'implementation',
  'review',
  'changes-requested',
  'integration',
  'blocked',
  'completed',
  'cancelled',
];

const RESUMABLE = ['product-definition', 'ready-for-implementation', 'implementation', 'review', 'changes-requested', 'integration'];

export const SESSION_TRANSITIONS = {
  forming: ['product-definition', 'blocked', 'cancelled'],
  'product-definition': ['ready-for-implementation', 'blocked', 'cancelled'],
  // Back to product-definition: the contract changed and has to be respecified.
  'ready-for-implementation': ['implementation', 'product-definition', 'blocked', 'cancelled'],
  implementation: ['review', 'product-definition', 'blocked', 'cancelled'],
  review: ['changes-requested', 'integration', 'blocked', 'cancelled'],
  'changes-requested': ['implementation', 'blocked', 'cancelled'],
  // Integration can fail and send work back rather than only forward.
  integration: ['completed', 'changes-requested', 'blocked', 'cancelled'],
  blocked: [...RESUMABLE, 'cancelled'],
  completed: [],
  cancelled: [],
};

export const TASK_STATUSES = ['issued', 'in-progress', 'blocked', 'completed', 'cancelled'];

/**
 * What a handoff asks its recipient to do. Single authority for
 * `schemas/handoff-action.schema.json`.
 *
 * An enum rather than a sentence because `teamctl inbox` is read by an Agent
 * that has just lost its context: `ACTION implement` is a decision it can act
 * on, whereas a paragraph describing what to do is something it has to
 * interpret, and interpreting is the step that goes wrong. It also makes the
 * queue countable, which is what the §12 metrics are derived from.
 */
export const HANDOFF_ACTIONS = ['implement', 'review', 'revise', 'clarify', 'validate', 'integrate'];

/**
 * Fields of a handoff the ledger assigns. A draft that sets one is refused
 * rather than overridden: a publisher that believes it chose the id would go
 * looking for a handoff nothing stored under that name.
 */
const HANDOFF_DERIVED = ['handoffId', 'seq', 'from', 'publishedAt', 'publishedBy', 'handoffDigest'];

/**
 * What a draft may set. Closed, matching the schema, because the failure mode of
 * an open draft is silent: `artifcts` would be ignored and the handoff would
 * publish claiming no artifacts exist, which is worse than a rejected draft.
 * `$comment` is allowed so a template can explain itself.
 */
const HANDOFF_DRAFT_FIELDS = new Set(['$comment', 'sessionId', 'taskId', 'to', 'nextAction',
  'summary', 'baseRevision', 'artifacts', 'evidence', 'unresolved', 'inputSnapshotDigest']);

/**
 * What a review can conclude (plan §5).
 *
 * Narrower than the finding statuses on purpose: a decision answers one question —
 * may this candidate proceed — and the three answers are yes, no-and-here-is-what-
 * to-fix, and no-for-a-reason-the-reviewer-cannot-fix. The last is a separate
 * status rather than a severity because it routes differently: `changes-requested`
 * goes back to the implementer, `blocked-unresolved` goes to whoever owns the
 * requirement, and collapsing them makes the implementer the one who has to work
 * out that the ball is not in their court.
 */
export const REVIEW_STATUSES = ['approved', 'changes-requested', 'blocked-unresolved'];

/**
 * Finding vocabulary, hoisted here from finding.schema.json so there is one
 * authority rather than two.
 *
 * `recordReview` checks a decision against its own findings — approving over an
 * open blocker is a self-contradiction — and a check that compared against a
 * privately retyped copy of these lists would start passing the day the schema
 * gained a status this file had never heard of.
 */
export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'note'];
export const FINDING_STATUSES = ['open', 'fixed', 'verified', 'closed',
  'rejected-with-evidence', 'accepted-risk', 'unresolved-product'];

/**
 * Finding statuses that mean the finding is still outstanding.
 *
 * `fixed` is not here: it is the implementer's claim, and a reviewer looking at a
 * fixed finding either verifies it or does not — both of which move it out of this
 * set — so counting it as outstanding would block approvals that have already done
 * the work of resolving it.
 */
const FINDING_UNRESOLVED = new Set(['open', 'unresolved-product']);

/** Fields of a decision the ledger assigns. Same contract as HANDOFF_DERIVED. */
const REVIEW_DERIVED = ['reviewId', 'seq', 'reviewer', 'recordedAt', 'recordedBy', 'decisionDigest'];

/** What a review draft may set. Closed for the same reason a handoff draft is. */
const REVIEW_DRAFT_FIELDS = new Set(['$comment', 'sessionId', 'taskId', 'candidateRevision',
  'inputSnapshotDigest', 'requirementsRevision', 'status', 'findings', 'validationEvidence', 'summary']);

export const TASK_TRANSITIONS = {
  issued: ['in-progress', 'blocked', 'cancelled'],
  'in-progress': ['completed', 'blocked', 'cancelled'],
  blocked: ['issued', 'in-progress', 'cancelled'],
  // A completed task is not frozen forever: its inputs can still go stale, in
  // which case it is restated (see `reissueTask`) rather than reopened.
  completed: ['cancelled'],
  cancelled: [],
};

function assertTransition(kind, from, to, table, id) {
  if (!table[to]) {
    throw new LedgerError('UNKNOWN_STATUS', `${kind} status ${JSON.stringify(to)} is not one of ${Object.keys(table).join(', ')}`);
  }
  if (from === to) {
    throw new LedgerError('NO_OP_TRANSITION', `${kind} ${id} is already ${from}`);
  }
  if (!table[from].includes(to)) {
    const legal = table[from].length ? table[from].join(', ') : '(terminal)';
    throw new LedgerError(
      'ILLEGAL_TRANSITION',
      `${kind} ${id} cannot go from ${from} to ${to}; legal next: ${legal}`,
      { from, to, legal: table[from] },
    );
  }
}

// ------------------------------------------------------------------- primitives

function nowIso() {
  return new Date().toISOString();
}

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new LedgerError('NOT_FOUND', `${what} does not exist: ${file}`);
    throw new LedgerError('UNREADABLE', `${what} could not be read: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new LedgerError('LEDGER_CORRUPT', `${what} is not valid JSON (${file}): ${error.message}`);
  }
}

/** Write via temp file + rename, so a reader never observes a half-written document. */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.trunc(performance.now() * 1000)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // The rename is the failure worth reporting; a leftover temp file is not.
    }
    throw error;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user. Still alive.
    return error.code === 'EPERM';
  }
}

// ------------------------------------------------------------------------ ledger

export function ledgerRoot(commonDir) {
  return path.join(commonDir, 'team-layer');
}

export class Ledger {
  /**
   * @param {object} options
   * @param {string} options.commonDir  `git rev-parse --git-common-dir`, absolute.
   * @param {string} [options.actor]    Default actor recorded on events.
   * @param {number} [options.lockTimeoutMs]
   */
  constructor({ commonDir, actor = 'unknown', lockTimeoutMs = 10_000 } = {}) {
    if (!commonDir) throw new LedgerError('NO_COMMON_DIR', 'commonDir is required');
    this.root = ledgerRoot(commonDir);
    this.actor = actor;
    this.lockTimeoutMs = lockTimeoutMs;
  }

  sessionDir(sessionId) {
    return path.join(this.root, 'sessions', slug(sessionId, 'sessionId'));
  }

  sessionFile(sessionId) {
    return path.join(this.sessionDir(sessionId), 'session.json');
  }

  taskFile(sessionId, taskId) {
    return path.join(this.sessionDir(sessionId), 'tasks', `${slug(taskId, 'taskId')}.json`);
  }

  eventsFile(sessionId) {
    return path.join(this.sessionDir(sessionId), 'events.jsonl');
  }

  listSessions() {
    const dir = path.join(this.root, 'sessions');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          return unslug(entry.name);
        } catch {
          return null;
        }
      })
      .filter((id) => id !== null)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // -------------------------------------------------------------------- locking

  /**
   * Hold the session lock for the duration of `fn`.
   *
   * `mkdir` is the primitive because it is atomic on every platform we support,
   * unlike "check then create". A stale lock is reclaimed only when it is
   * *provably* dead — same host, and the recorded pid is gone. Reclaiming on age
   * alone is the classic way to reintroduce the lost update this lock prevents,
   * so a lock held by another machine fails closed and says so instead.
   */
  withLock(sessionId, fn) {
    const dir = this.sessionDir(sessionId);
    const lockDir = path.join(dir, '.lock');
    const holderFile = path.join(lockDir, 'holder.json');
    const deadline = Date.now() + this.lockTimeoutMs;
    const holder = { pid: process.pid, host: os.hostname(), actor: this.actor, at: nowIso() };

    fs.mkdirSync(dir, { recursive: true });
    let acquired = false;
    let lastObserved = null;
    while (!acquired) {
      try {
        fs.mkdirSync(lockDir);
        acquired = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let existing = null;
        try {
          existing = JSON.parse(fs.readFileSync(holderFile, 'utf8'));
        } catch {
          // Either the holder file is not written yet (a race we simply wait
          // out) or it is unreadable. Neither proves the holder is dead.
        }
        lastObserved = existing ?? lastObserved;
        if (existing && existing.host === holder.host && Number.isInteger(existing.pid) && !processAlive(existing.pid)) {
          this.#forceReleaseLock(lockDir);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new LedgerError(
            'LOCK_HELD',
            `could not lock session ${sessionId} within ${this.lockTimeoutMs}ms; ` +
              (lastObserved
                ? `held by pid ${lastObserved.pid} on ${lastObserved.host} since ${lastObserved.at}. ` +
                  (lastObserved.host === holder.host
                    ? 'That process is still running.'
                    : 'Liveness cannot be checked from this host, so the lock is not reclaimed.')
                : `lock directory ${lockDir} exists with no readable holder.`),
            { lockDir, holder: lastObserved },
          );
        }
        this.#sleep(25);
      }
    }

    try {
      fs.writeFileSync(holderFile, `${JSON.stringify(holder)}\n`, 'utf8');
      return fn();
    } finally {
      this.#forceReleaseLock(lockDir);
    }
  }

  #forceReleaseLock(lockDir) {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }

  /** Block without spinning the CPU and without an async boundary in a locked region. */
  #sleep(ms) {
    const until = Date.now() + ms;
    // A short synchronous wait keeps the lock protocol usable from a plain CLI
    // command; Atomics.wait is the only way to sleep without going async.
    const buffer = new Int32Array(new SharedArrayBuffer(4));
    while (Date.now() < until) Atomics.wait(buffer, 0, 0, Math.max(1, until - Date.now()));
  }

  // --------------------------------------------------------------------- events

  #appendEvent(sessionId, event) {
    const line = `${JSON.stringify(event)}\n`;
    fs.appendFileSync(this.eventsFile(sessionId), line, 'utf8');
  }

  /**
   * Read the audit log.
   *
   * `session.eventSeq` is authoritative, so a file with fewer events than the
   * session claims is reported as truncated rather than quietly treated as the
   * whole history — a metrics count derived from a truncated log would be wrong
   * in a way nothing else would reveal.
   */
  readEvents(sessionId, { expectSeq = null } = {}) {
    const file = this.eventsFile(sessionId);
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    if (lines[lines.length - 1] !== '') {
      throw new LedgerError('LEDGER_CORRUPT', `${file} ends mid-line; the last event was not written completely`);
    }
    const events = lines.slice(0, -1).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new LedgerError('LEDGER_CORRUPT', `${file} line ${index + 1} is not valid JSON: ${error.message}`);
      }
    });
    if (expectSeq !== null && events.length !== expectSeq) {
      throw new LedgerError(
        'LEDGER_CORRUPT',
        `${file} holds ${events.length} events but session.json records ${expectSeq}`,
        { found: events.length, expected: expectSeq },
      );
    }
    return events;
  }

  // -------------------------------------------------------------------- session

  readSession(sessionId) {
    assertId(sessionId, 'sessionId');
    return readJson(this.sessionFile(sessionId), `session ${sessionId}`);
  }

  /**
   * Create a session. Fails closed if one already exists — resuming an existing
   * session is `readSession`, and silently adopting it here would discard state.
   */
  createSession({ sessionId, integrationTarget, canonicalProvider = null, notes = null, actor = this.actor }) {
    assertId(sessionId, 'sessionId');
    if (typeof integrationTarget !== 'string' || integrationTarget.trim() === '') {
      throw new LedgerError('MALFORMED_SESSION', 'integrationTarget is required and must be a non-empty string');
    }
    return this.withLock(sessionId, () => {
      const file = this.sessionFile(sessionId);
      if (fs.existsSync(file)) {
        throw new LedgerError('SESSION_EXISTS', `session ${sessionId} already exists at ${file}`);
      }
      const at = nowIso();
      const session = {
        schemaVersion: 1,
        sessionId,
        revision: 1,
        status: 'forming',
        integrationTarget,
        createdAt: at,
        updatedAt: at,
        eventSeq: 0,
        handoffSeq: 0,
        reviewSeq: 0,
        ...(canonicalProvider ? { canonicalProvider } : {}),
        ...(notes ? { notes } : {}),
      };
      fs.mkdirSync(path.join(this.sessionDir(sessionId), 'tasks'), { recursive: true });
      this.#commit(session, { kind: 'session-created', actor, status: 'forming', integrationTarget });
      return session;
    });
  }

  /** Append an event and persist the session in one step, keeping `eventSeq` gap-free. */
  #commit(session, event) {
    session.eventSeq += 1;
    session.updatedAt = event.at ?? nowIso();
    const record = { seq: session.eventSeq, at: session.updatedAt, ...event };
    // The session file goes first: if the process dies between the two writes,
    // `readEvents` reports a truncated log rather than an event nothing accounts
    // for. Both orders can tear; only this one tears detectably.
    writeJsonAtomic(this.sessionFile(session.sessionId), session);
    this.#appendEvent(session.sessionId, record);
    return record;
  }

  /**
   * Move a session to `status`.
   *
   * `expectedRevision` is the compare-and-swap: pass the revision you read and
   * the write is refused if anything changed underneath you.
   */
  setSessionStatus(sessionId, status, { actor = this.actor, expectedRevision = null, note = null } = {}) {
    assertId(sessionId, 'sessionId');
    return this.withLock(sessionId, () => {
      const session = this.readSession(sessionId);
      this.#assertRevision(session, expectedRevision, `session ${sessionId}`);
      assertTransition('session', session.status, status, SESSION_TRANSITIONS, sessionId);
      const from = session.status;
      session.status = status;
      session.revision += 1;
      if (note) session.notes = note;
      this.#commit(session, { kind: 'session-status-changed', actor, from, to: status, ...(note ? { note } : {}) });
      return session;
    });
  }

  #assertRevision(document, expected, what) {
    if (expected === null || expected === undefined) return;
    if (!Number.isInteger(expected)) {
      throw new LedgerError('MALFORMED_REVISION', `expectedRevision must be an integer, got ${JSON.stringify(expected)}`);
    }
    if (document.revision !== expected) {
      throw new LedgerError(
        'REVISION_CONFLICT',
        `${what} is at revision ${document.revision}, not ${expected}; re-read it and retry`,
        { expected, actual: document.revision },
      );
    }
  }

  // ----------------------------------------------------------------------- tasks

  listTasks(sessionId) {
    const dir = path.join(this.sessionDir(sessionId), 'tasks');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => unslug(name.slice(0, -'.json'.length)))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /**
   * Read a task, proving its frozen half has not been edited.
   *
   * This is the executable form of "frozen task truth must remain internally
   * consistent": the digest was computed when the task was issued, so a
   * hand-edited packet is detected instead of being handed to an Agent as if it
   * were what was agreed.
   */
  readTask(sessionId, taskId) {
    assertId(sessionId, 'sessionId');
    assertId(taskId, 'taskId');
    const file = this.taskFile(sessionId, taskId);
    const record = readJson(file, `task ${taskId}`);
    const actual = jsonDigest(record.frozen);
    if (actual !== record.frozenDigest) {
      throw new LedgerError(
        'FROZEN_TAMPERED',
        `task ${taskId} frozen packet does not match its recorded digest; ` +
          'it was edited outside the ledger. Reissue the task instead of trusting this file.',
        { file, recorded: record.frozenDigest, actual },
      );
    }
    return record;
  }

  /**
   * Freeze a task packet and issue it.
   *
   * The frozen half is purely content-addressed: `frozenDigest` is a function of
   * the packet and nothing else, so the same agreed truth always has the same
   * digest no matter how many times it was issued. The issuance counter lives in
   * the mutable half, where it belongs.
   */
  issueTask({ sessionId, packet, actor = this.actor, expectedRevision = null }) {
    assertId(sessionId, 'sessionId');
    const taskId = packet?.taskId;
    assertId(taskId, 'packet.taskId');
    if (packet.sessionId !== undefined && packet.sessionId !== sessionId) {
      throw new LedgerError('SESSION_MISMATCH', `packet.sessionId ${JSON.stringify(packet.sessionId)} is not ${sessionId}`);
    }
    return this.withLock(sessionId, () => {
      const session = this.readSession(sessionId);
      this.#assertRevision(session, expectedRevision, `session ${sessionId}`);
      const file = this.taskFile(sessionId, taskId);
      if (fs.existsSync(file)) {
        throw new LedgerError('TASK_EXISTS', `task ${taskId} already exists; use reissueTask to restate it`);
      }
      const record = this.#freeze({ packet, sessionId, generation: 1 });
      writeJsonAtomic(file, record);
      this.#commit(session, {
        kind: 'task-issued',
        actor,
        taskId,
        generation: 1,
        frozenDigest: record.frozenDigest,
        inputSnapshotDigest: record.inputSnapshotDigest,
      });
      return record;
    });
  }

  /**
   * Restate a task under a new generation.
   *
   * Used when a declared input moved (plan §2.3 `stale-input`): the old frozen
   * truth is *superseded*, not patched. The previous digest goes into the audit
   * log so it stays possible to prove which snapshot an Agent had been working
   * against.
   *
   * Restating with byte-identical content is legal and recorded as
   * `unchanged: true` — re-checking a task and finding nothing moved is a real
   * event, and it must not be dressed up as a new snapshot. Concretely, the task
   * is left exactly as it was: no new generation, no revision bump, no status
   * reset. All three would be false signals invented by a check that found
   * nothing. Bumping the generation tells every downstream staleness check the
   * task was restated; resetting the status discards the fact that an Agent is
   * mid-flight; bumping the revision breaks the CAS of everyone holding the old
   * one. A freshness re-check has to be safe to run on a schedule, and something
   * that silently derails work in progress is not.
   */
  reissueTask({ sessionId, packet, reason, actor = this.actor, expectedGeneration = null }) {
    assertId(sessionId, 'sessionId');
    const taskId = packet?.taskId;
    assertId(taskId, 'packet.taskId');
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new LedgerError('MALFORMED_TASK', 'reissueTask requires a reason');
    }
    return this.withLock(sessionId, () => {
      const session = this.readSession(sessionId);
      const previous = this.readTask(sessionId, taskId);
      if (expectedGeneration !== null && previous.state.generation !== expectedGeneration) {
        throw new LedgerError(
          'REVISION_CONFLICT',
          `task ${taskId} is at generation ${previous.state.generation}, not ${expectedGeneration}`,
          { expected: expectedGeneration, actual: previous.state.generation },
        );
      }
      if (previous.state.status === 'cancelled') {
        throw new LedgerError('ILLEGAL_TRANSITION', `task ${taskId} is cancelled and cannot be reissued`);
      }
      // Freeze against the *previous* generation first, purely to learn the
      // digest. Whether this is a real restatement is a property of the content,
      // so it has to be answered before deciding what to write.
      const candidate = this.#freeze({
        packet,
        sessionId,
        generation: previous.state.generation + 1,
        revision: previous.revision + 1,
      });
      const unchanged = candidate.frozenDigest === previous.frozenDigest;
      if (!unchanged) writeJsonAtomic(this.taskFile(sessionId, taskId), candidate);
      const record = unchanged ? previous : candidate;
      this.#commit(session, {
        kind: 'task-reissued',
        actor,
        taskId,
        reason,
        generation: record.state.generation,
        unchanged,
        supersededDigest: previous.frozenDigest,
        supersededInputSnapshotDigest: previous.inputSnapshotDigest,
        frozenDigest: record.frozenDigest,
        inputSnapshotDigest: record.inputSnapshotDigest,
      });
      return record;
    });
  }

  #freeze({ packet, sessionId, generation, revision = 1 }) {
    if (packet.generation !== undefined) {
      throw new LedgerError(
        'MALFORMED_TASK',
        'packet.generation is not part of the frozen packet; issuance is tracked in state.generation',
      );
    }
    if (packet.baseRevision !== undefined) assertRevision(packet.baseRevision, 'packet.baseRevision');
    const frozen = { ...packet, sessionId };
    const digest = inputSnapshotDigest(frozen.inputs ?? [], `task ${frozen.taskId} inputs`);
    const at = nowIso();
    return {
      schemaVersion: 1,
      revision,
      frozen,
      frozenDigest: jsonDigest(frozen),
      inputSnapshotDigest: digest,
      state: {
        status: 'issued',
        generation,
        issuedAt: at,
        updatedAt: at,
      },
    };
  }

  /** Move a task's mutable half. The frozen half is never touched here. */
  setTaskStatus(sessionId, taskId, status, { actor = this.actor, expectedRevision = null, note = null } = {}) {
    assertId(sessionId, 'sessionId');
    assertId(taskId, 'taskId');
    return this.withLock(sessionId, () => {
      const session = this.readSession(sessionId);
      const record = this.readTask(sessionId, taskId);
      this.#assertRevision(record, expectedRevision, `task ${taskId}`);
      assertTransition('task', record.state.status, status, TASK_TRANSITIONS, taskId);
      const from = record.state.status;
      record.state.status = status;
      record.state.updatedAt = nowIso();
      record.revision += 1;
      if (note) record.state.note = note;
      writeJsonAtomic(this.taskFile(sessionId, taskId), record);
      this.#commit(session, {
        kind: 'task-status-changed',
        actor,
        taskId,
        generation: record.state.generation,
        from,
        to: status,
        ...(note ? { note } : {}),
      });
      return record;
    });
  }

  // -------------------------------------------------------------------- handoffs

  handoffsDir(sessionId) {
    return path.join(this.sessionDir(sessionId), 'handoffs');
  }

  handoffFile(sessionId, handoffId) {
    return path.join(this.handoffsDir(sessionId), `${slug(handoffId, 'handoffId')}.json`);
  }

  /**
   * Every handoff in the session, oldest first.
   *
   * Returns whole records rather than ids the way `listTasks` does, because the
   * ordering lives inside the file: handoff ids end with the sequence number but
   * begin with role names, so the directory sorts alphabetically by sender and
   * not chronologically. Sorting correctly requires the read anyway.
   */
  listHandoffs(sessionId) {
    const dir = this.handoffsDir(sessionId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.readHandoff(sessionId, unslug(name.slice(0, -'.json'.length))))
      .sort((a, b) => a.seq - b.seq);
  }

  /** Read a handoff, proving the statement has not been edited since publication. */
  readHandoff(sessionId, handoffId) {
    assertId(sessionId, 'sessionId');
    assertId(handoffId, 'handoffId');
    const file = this.handoffFile(sessionId, handoffId);
    const record = readJson(file, `handoff ${handoffId}`);
    const actual = jsonDigest(record.handoff);
    if (actual !== record.handoffDigest) {
      throw new LedgerError(
        'HANDOFF_TAMPERED',
        `handoff ${handoffId} does not match its recorded digest; it was edited after publication. ` +
          'Publish a new handoff instead of trusting this file.',
        { file, recorded: record.handoffDigest, actual },
      );
    }
    return record;
  }

  /**
   * Publish a state transfer from `actorRole` to the role named in the draft.
   *
   * The caller supplies content; the ledger supplies identity. `handoffId`, `seq`,
   * `from`, `inputSnapshotDigest` and the timestamps are all derived, and a draft
   * that sets one of them is refused rather than silently overridden — a publisher
   * that believes it chose the id would go looking for a handoff that does not
   * exist under that name.
   *
   * `inputSnapshotDigest` is copied from the task rather than accepted from the
   * draft, so a handoff cannot claim to have been produced against a snapshot that
   * was never current. A draft may still *declare* one, and then it is checked:
   * declaring a snapshot the task has moved past means the sender did the work
   * against superseded truth, which is refused here rather than discovered by the
   * recipient halfway through acting on it.
   */
  publishHandoff({ sessionId, draft, actor = this.actor, actorRole }) {
    assertId(sessionId, 'sessionId');
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new LedgerError('MALFORMED_HANDOFF', 'a handoff draft must be an object');
    }
    for (const field of HANDOFF_DERIVED) {
      if (draft[field] !== undefined) {
        throw new LedgerError('MALFORMED_HANDOFF',
          `${field} is assigned by the ledger; remove it from the draft`);
      }
    }
    for (const field of Object.keys(draft)) {
      if (!HANDOFF_DRAFT_FIELDS.has(field)) {
        throw new LedgerError('MALFORMED_HANDOFF',
          `${field} is not a handoff field; a misspelled field would publish silently missing content`);
      }
    }
    const taskId = draft.taskId;
    assertId(taskId, 'draft.taskId');
    if (draft.sessionId !== undefined && draft.sessionId !== sessionId) {
      throw new LedgerError('SESSION_MISMATCH',
        `draft.sessionId ${JSON.stringify(draft.sessionId)} is not ${sessionId}`);
    }
    // Role errors are raised as LedgerError rather than passed through from the
    // role registry, because the CLI turns a ledger refusal into an exit code and
    // a second error type would fall through that to an unhandled crash.
    if (!isRole(actorRole)) {
      throw new LedgerError('UNKNOWN_ROLE',
        `the publishing role ${JSON.stringify(actorRole)} is not a known role; expected ${roleIds().join(', ')}`);
    }
    const toRole = draft.to?.role;
    if (!isRole(toRole)) {
      throw new LedgerError('UNKNOWN_ROLE',
        `to.role ${JSON.stringify(toRole)} is not a known role; expected ${roleIds().join(', ')}`);
    }
    if (draft.to.subject !== undefined) assertId(draft.to.subject, 'to.subject');
    // A distinct code from MALFORMED_HANDOFF, mirroring UNKNOWN_ROLE: "that word is
    // not an action" is a fixable typo, whereas a malformed draft is a shape error,
    // and a caller that has to grep the message to tell them apart will not.
    if (!HANDOFF_ACTIONS.includes(draft.nextAction)) {
      throw new LedgerError('UNKNOWN_ACTION',
        `nextAction must be one of ${HANDOFF_ACTIONS.join(', ')}, got ${JSON.stringify(draft.nextAction)}`);
    }
    if (typeof draft.summary !== 'string' || draft.summary.trim() === '') {
      throw new LedgerError('MALFORMED_HANDOFF', 'a handoff requires a non-empty summary');
    }
    if (draft.baseRevision !== undefined) assertRevision(draft.baseRevision, 'baseRevision');

    return this.withLock(sessionId, () => {
      const session = this.readSession(sessionId);
      const task = this.readTask(sessionId, taskId);
      if (task.state.status === 'cancelled') {
        throw new LedgerError('ILLEGAL_TRANSITION',
          `task ${taskId} is cancelled; there is no state left to hand off`);
      }
      const snapshot = task.inputSnapshotDigest;
      if (draft.inputSnapshotDigest !== undefined && draft.inputSnapshotDigest !== snapshot) {
        throw new LedgerError('HANDOFF_STALE',
          `the draft was produced against input snapshot ${draft.inputSnapshotDigest}, but task ${taskId} ` +
            `is now at ${snapshot}. Re-read the task and redo the work against current truth.`,
          { declared: draft.inputSnapshotDigest, current: snapshot, taskId });
      }
      const seq = session.handoffSeq + 1;
      const handoffId = `handoff:${actorRole}-to-${toRole}-${seq}`;
      const handoff = {
        sessionId,
        taskId,
        from: { subject: actor, role: actorRole },
        to: { role: toRole, ...(draft.to.subject ? { subject: draft.to.subject } : {}) },
        inputSnapshotDigest: snapshot,
        ...(draft.baseRevision ? { baseRevision: draft.baseRevision } : {}),
        artifacts: draft.artifacts ?? [],
        evidence: draft.evidence ?? [],
        unresolved: draft.unresolved ?? [],
        nextAction: draft.nextAction,
        summary: draft.summary,
      };
      const file = this.handoffFile(sessionId, handoffId);
      if (fs.existsSync(file)) {
        throw new LedgerError('HANDOFF_EXISTS',
          `handoff ${handoffId} already exists at ${file}; session.handoffSeq disagrees with the directory`);
      }
      const at = nowIso();
      const handoffDigest = jsonDigest(handoff);
      // Re-sending state that was already transferred is legal — it is how you
      // nudge a recipient who has not acknowledged — but it is not new
      // information, and the recipient deserves to be told which it is. The
      // statement is substance only, so an identical digest means identical
      // state; that is the whole reason handoffId and publishedAt sit outside it.
      const duplicateOf = this.listHandoffs(sessionId)
        .find((existing) => existing.handoffDigest === handoffDigest)?.handoffId ?? null;
      const record = {
        schemaVersion: 1,
        seq,
        handoffId,
        handoff,
        handoffDigest,
        publishedAt: at,
        publishedBy: actor,
      };
      fs.mkdirSync(this.handoffsDir(sessionId), { recursive: true });
      writeJsonAtomic(file, record);
      session.handoffSeq = seq;
      this.#commit(session, {
        kind: 'handoff-published',
        at,
        actor,
        handoffId,
        taskId,
        to: toRole,
        ...(draft.to.subject ? { toSubject: draft.to.subject } : {}),
        nextAction: handoff.nextAction,
        inputSnapshotDigest: snapshot,
        handoffDigest: record.handoffDigest,
        ...(duplicateOf ? { duplicateOf } : {}),
      });
      return record;
    });
  }

  /**
   * Acknowledge a handoff: the recipient has read it and is taking the action.
   *
   * Refused when the task has moved past the snapshot the handoff was published
   * against. This is the team-layer enforcement of plan §2.3 `stale-input`, and it
   * has to fail closed: the whole point of acknowledging is that the recipient is
   * about to start work, and the most expensive moment to discover the inputs
   * changed is after that work exists. There is deliberately no override — the
   * remedy is a fresh handoff against current truth, which is cheap, and an
   * escape hatch here would become the default path.
   *
   * The acknowledgement is an event and not a field, so the published statement
   * stays immutable and keeps its digest.
   *
   * Only the addressee may acknowledge. See below: an ack is what empties a queue,
   * so allowing anyone to issue one turns "the inbox is clear" into a claim nobody
   * checked.
   */
  ackHandoff({ sessionId, handoffId, actor = this.actor, actorRole }) {
    assertId(sessionId, 'sessionId');
    assertId(handoffId, 'handoffId');
    // Required, not defaulted to "unchecked". A caller that omitted the role would
    // silently lose the addressee check below, and a safety property that switches
    // itself off when a caller forgets an argument is not one you can rely on.
    if (!isRole(actorRole)) {
      throw new LedgerError('UNKNOWN_ROLE',
        `acknowledging requires the role doing it; ${JSON.stringify(actorRole)} is not one of ${roleIds().join(', ')}`);
    }
    return this.withLock(sessionId, () => {
      const session = this.readSession(sessionId);
      const record = this.readHandoff(sessionId, handoffId);
      const already = this.readEvents(sessionId)
        .find((event) => event.kind === 'handoff-acked' && event.handoffId === handoffId);
      if (already) {
        throw new LedgerError('HANDOFF_ACKED',
          `handoff ${handoffId} was already acknowledged by ${already.actor} at ${already.at}`,
          { actor: already.actor, at: already.at });
      }
      // Only the addressee may acknowledge, because acknowledging is what removes
      // the handoff from a queue. A non-addressee acking it does not merely record
      // the wrong name: it empties the recipient's inbox, so the state transfer is
      // silently dropped and the recipient never learns there was work waiting —
      // exactly the failure this layer exists to make impossible.
      const { to } = record.handoff;
      const addressed = to.subject ? to.subject === actor : to.role === actorRole;
      if (!addressed) {
        throw new LedgerError('HANDOFF_NOT_ADDRESSEE',
          `handoff ${handoffId} is addressed to ${to.subject ?? to.role}, not to ${actor} as ${actorRole}. ` +
            'Acknowledging it would clear it from the addressee\'s inbox without them ever seeing it.',
          { to, actor, actorRole });
      }
      const { taskId, inputSnapshotDigest: published } = record.handoff;
      const task = this.readTask(sessionId, taskId);
      if (task.inputSnapshotDigest !== published) {
        throw new LedgerError('HANDOFF_STALE',
          `handoff ${handoffId} was published against input snapshot ${published}, but task ${taskId} is ` +
            `now at ${task.inputSnapshotDigest}. Ask for a fresh handoff rather than starting work ` +
            'against superseded inputs.',
          { published, current: task.inputSnapshotDigest, taskId, generation: task.state.generation });
      }
      const acked = this.#commit(session, {
        kind: 'handoff-acked',
        actor,
        actorRole,
        handoffId,
        taskId,
        generation: task.state.generation,
        inputSnapshotDigest: published,
        nextAction: record.handoff.nextAction,
      });
      return { acked, handoff: record };
    });
  }

  /**
   * Actionable handoffs addressed to a recipient, across every session.
   *
   * Takes no session argument because this is what an Agent runs after losing its
   * context, and it cannot be asked which session it was in. Addressing follows
   * the artifact: a handoff narrowed to one subject reaches only that subject,
   * while a role-only handoff reaches whoever currently holds the role.
   *
   * Each row carries `stale`, so the recipient learns that the inputs moved
   * *before* acknowledging rather than by having the acknowledgement refused. A
   * session or task that cannot be read is reported as a row rather than thrown,
   * because this is the recovery path: one corrupt session must not be able to
   * hide every other session's queue.
   */
  inbox({ role = null, subject = null } = {}) {
    if (role === null && subject === null) {
      throw new LedgerError('MALFORMED_ID', 'inbox needs a role or a subject to address');
    }
    const rows = [];
    for (const sessionId of this.listSessions()) {
      let session;
      let events;
      let handoffs;
      try {
        session = this.readSession(sessionId);
        events = this.readEvents(sessionId, { expectSeq: session.eventSeq });
        handoffs = this.listHandoffs(sessionId);
      } catch (error) {
        rows.push({ sessionId, unreadable: error.code ?? 'UNREADABLE', message: error.message });
        continue;
      }
      const acked = new Set(events
        .filter((event) => event.kind === 'handoff-acked')
        .map((event) => event.handoffId));
      for (const record of handoffs) {
        const h = record.handoff;
        if (acked.has(record.handoffId)) continue;
        const mine = h.to.subject ? h.to.subject === subject : h.to.role === role;
        if (!mine) continue;
        const row = {
          sessionId,
          sessionStatus: session.status,
          handoffId: record.handoffId,
          seq: record.seq,
          from: h.from,
          taskId: h.taskId,
          nextAction: h.nextAction,
          summary: h.summary,
          inputSnapshotDigest: h.inputSnapshotDigest,
          unresolved: h.unresolved.length,
          publishedAt: record.publishedAt,
        };
        try {
          const task = this.readTask(sessionId, h.taskId);
          row.stale = task.inputSnapshotDigest !== h.inputSnapshotDigest;
          row.taskStatus = task.state.status;
          if (row.stale) row.currentInputSnapshotDigest = task.inputSnapshotDigest;
        } catch (error) {
          // Unknown beats false: reporting `stale: false` for a task that cannot
          // be read would be an assertion nothing checked.
          row.stale = null;
          row.taskUnreadable = error.code ?? 'UNREADABLE';
        }
        rows.push(row);
      }
    }
    return rows;
  }
  // --------------------------------------------------------------------- reviews

  reviewsDir(sessionId) {
    return path.join(this.sessionDir(sessionId), 'reviews');
  }

  reviewFile(sessionId, reviewId) {
    return path.join(this.reviewsDir(sessionId), `${slug(reviewId, 'reviewId')}.json`);
  }

  /** Every review decision in the session, oldest first. */
  listReviews(sessionId) {
    const dir = this.reviewsDir(sessionId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.readReview(sessionId, unslug(name.slice(0, -'.json'.length))))
      .sort((a, b) => a.seq - b.seq);
  }

  /**
   * Read a decision, proving it has not been edited since it was recorded.
   *
   * A review decision is an authorisation: something downstream asks it whether this
   * candidate may proceed. An approval that can be edited on disk is an approval
   * anyone can manufacture, so the digest is checked on every read rather than
   * offered as a separate `verify` command nobody would run.
   */
  readReview(sessionId, reviewId) {
    assertId(sessionId, 'sessionId');
    assertId(reviewId, 'reviewId');
    const file = this.reviewFile(sessionId, reviewId);
    const record = readJson(file, `review ${reviewId}`);
    const actual = jsonDigest(record.decision);
    if (actual !== record.decisionDigest) {
      throw new LedgerError(
        'REVIEW_TAMPERED',
        `review ${reviewId} does not match its recorded digest; it was edited after being recorded. ` +
          'Record a new decision instead of trusting this file.',
        { file, recorded: record.decisionDigest, actual },
      );
    }
    return record;
  }

  /**
   * Record a review decision against one candidate of one task (plan §5).
   *
   * An approval binds three things at once: the exact candidate reviewed, the exact
   * semantic input snapshot it was reviewed against, and the exact requirement
   * revision it was judged by. All three are load-bearing — an approval that named
   * only the candidate would survive the contract changing underneath it, which is
   * how work gets merged against requirements nobody approved it against.
   *
   * Nothing here moves the task or the session. An approval is semantic evidence,
   * not a gate pass: it says a human-equivalent judgement was made, and the merge
   * gate still owes its own structural checks (plan §5, last line). Recording a
   * decision that also advanced the task would make the reviewer's opinion
   * sufficient, which is exactly the bypass that sentence forbids.
   */
  recordReview({ sessionId, draft, actor = this.actor, actorRole }) {
    assertId(sessionId, 'sessionId');
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      throw new LedgerError('MALFORMED_REVIEW', 'a review draft must be an object');
    }
    for (const field of REVIEW_DERIVED) {
      if (draft[field] !== undefined) {
        throw new LedgerError('MALFORMED_REVIEW',
          `${field} is assigned by the ledger; remove it from the draft`);
      }
    }
    for (const field of Object.keys(draft)) {
      if (!REVIEW_DRAFT_FIELDS.has(field)) {
        throw new LedgerError('MALFORMED_REVIEW',
          `${field} is not a review field; a misspelled field would record a decision with silently missing content`);
      }
    }
    const taskId = draft.taskId;
    assertId(taskId, 'draft.taskId');
    if (draft.sessionId !== undefined && draft.sessionId !== sessionId) {
      throw new LedgerError('SESSION_MISMATCH',
        `draft.sessionId ${JSON.stringify(draft.sessionId)} is not ${sessionId}`);
    }
    if (!isRole(actorRole)) {
      throw new LedgerError('UNKNOWN_ROLE',
        `the reviewing role ${JSON.stringify(actorRole)} is not a known role; expected ${roleIds().join(', ')}`);
    }
    // A distinct code from MALFORMED_REVIEW for the same reason UNKNOWN_ACTION is
    // distinct: a misspelled status is a fixable typo, not a shape error.
    if (!REVIEW_STATUSES.includes(draft.status)) {
      throw new LedgerError('UNKNOWN_REVIEW_STATUS',
        `status must be one of ${REVIEW_STATUSES.join(', ')}, got ${JSON.stringify(draft.status)}`);
    }
    assertRevision(draft.candidateRevision, 'candidateRevision');
    if (draft.requirementsRevision !== undefined) {
      assertRevision(draft.requirementsRevision, 'requirementsRevision');
    }
    if (typeof draft.summary !== 'string' || draft.summary.trim() === '') {
      throw new LedgerError('MALFORMED_REVIEW', 'a review decision requires a non-empty summary');
    }
    const findings = draft.findings ?? [];
    if (!Array.isArray(findings)) {
      throw new LedgerError('MALFORMED_REVIEW', 'findings must be an array');
    }
    findings.forEach((finding, index) => {
      const at = `findings[${index}]`;
      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
        throw new LedgerError('MALFORMED_REVIEW', `${at} must be an object`);
      }
      // Only the two fields this method reasons about are checked here; the full
      // finding shape is finding.schema.json's business. Checking these two is not
      // optional though: the status/findings consistency rules below are what stop
      // an approval contradicting its own evidence, and a finding with a severity
      // this code does not recognise would slip through every one of them.
      if (!FINDING_SEVERITIES.includes(finding.severity)) {
        throw new LedgerError('MALFORMED_REVIEW',
          `${at}.severity must be one of ${FINDING_SEVERITIES.join(', ')}, got ${JSON.stringify(finding.severity)}`);
      }
      if (!FINDING_STATUSES.includes(finding.status)) {
        throw new LedgerError('MALFORMED_REVIEW',
          `${at}.status must be one of ${FINDING_STATUSES.join(', ')}, got ${JSON.stringify(finding.status)}`);
      }
    });
    const validationEvidence = draft.validationEvidence ?? [];
    if (!Array.isArray(validationEvidence)
      || validationEvidence.some((id) => typeof id !== 'string' || id.trim() === '')) {
      throw new LedgerError('MALFORMED_REVIEW', 'validationEvidence must be an array of non-empty ids');
    }

    const unresolved = findings.filter((f) => FINDING_UNRESOLVED.has(f.status));
    // A decision that contradicts its own findings is the review equivalent of a
    // task whose frozen half disagrees with its digest: internally inconsistent
    // frozen truth, which every later reader has to guess its way past.
    if (draft.status === 'approved') {
      const blocking = unresolved.filter((f) => f.severity === 'blocker');
      if (blocking.length) {
        throw new LedgerError('REVIEW_INCONSISTENT',
          `cannot approve with ${blocking.length} unresolved blocker finding(s): ` +
            `${blocking.map((f) => f.findingId ?? '(unnamed)').join(', ')}. ` +
            'Resolve them, downgrade them honestly, or request changes.',
          { findings: blocking.map((f) => f.findingId ?? null) });
      }
      // Only `blocker` blocks. An unresolved `major` is a judgement call, and
      // refusing the approval here would not produce better reviews — it would
      // produce majors relabelled as minors, which destroys the signal instead of
      // the ambiguity.
    } else if (draft.status === 'changes-requested' && unresolved.length === 0) {
      throw new LedgerError('REVIEW_INCONSISTENT',
        'changes-requested with no unresolved finding gives the implementer nothing to act on; ' +
          'record the findings, or use blocked-unresolved if the obstacle is not theirs to fix');
    } else if (draft.status === 'blocked-unresolved'
      && !findings.some((f) => f.status === 'unresolved-product')) {
      throw new LedgerError('REVIEW_INCONSISTENT',
        'blocked-unresolved means a requirement question is open, so at least one finding must be ' +
          'status unresolved-product naming it; otherwise nobody knows who is being asked what');
    }

    return this.withLock(sessionId, () => {
      const session = this.readSession(sessionId);
      const task = this.readTask(sessionId, taskId);
      // Reviewing one's own work is the failure this role split exists to prevent,
      // and it is checkable without naming a role: the registry is the authority for
      // which roles exist, so hardcoding "only `reviewer` may approve" here would be
      // a second list to keep in step. Who the task belongs to is the real property.
      if (task.frozen.subject === actor) {
        throw new LedgerError('REVIEW_SELF',
          `task ${taskId} is assigned to ${actor}, which cannot review its own work`,
          { taskId, subject: task.frozen.subject });
      }
      const snapshot = task.inputSnapshotDigest;
      if (draft.inputSnapshotDigest !== undefined && draft.inputSnapshotDigest !== snapshot) {
        throw new LedgerError('REVIEW_STALE',
          `the review was made against input snapshot ${draft.inputSnapshotDigest}, but task ${taskId} ` +
            `is now at ${snapshot}. Re-read the task and review the candidate against current truth.`,
          { declared: draft.inputSnapshotDigest, current: snapshot, taskId });
      }
      // An approval must name the requirement revision it judged against, and that
      // revision has to be one the task actually declares. Accepting an unchecked
      // string would give the binding the plan requires the *appearance* of being
      // enforced, which is worse than not having the field: a later reader would
      // trust it. Non-approvals may omit it — asking for changes does not stop
      // being the right answer when the contract moves.
      const declared = task.frozen.inputs ?? [];
      if (draft.status === 'approved') {
        if (draft.requirementsRevision === undefined) {
          throw new LedgerError('MALFORMED_REVIEW',
            'an approval must name the requirementsRevision it was judged against (plan §5); ' +
              `task ${taskId} declares ${declared.map((i) => `${i.id}@${i.revision}`).join(', ') || 'no inputs'}`);
        }
        if (!declared.some((input) => input.revision === draft.requirementsRevision)) {
          throw new LedgerError('REVIEW_REQUIREMENT_UNKNOWN',
            `requirementsRevision ${draft.requirementsRevision} is not among task ${taskId}'s declared inputs ` +
              `(${declared.map((i) => `${i.id}@${i.revision}`).join(', ') || 'none'}). An approval anchored to a ` +
              'revision the task never depended on cannot go stale when the real requirement moves.',
            { requirementsRevision: draft.requirementsRevision, taskId });
        }
      }

      const seq = (session.reviewSeq ?? 0) + 1;
      const reviewId = `review:${taskId.includes(':') ? taskId.slice(taskId.indexOf(':') + 1) : taskId}-${seq}`;
      const decision = {
        sessionId,
        taskId,
        reviewer: { subject: actor, role: actorRole },
        candidateRevision: draft.candidateRevision,
        inputSnapshotDigest: snapshot,
        ...(draft.requirementsRevision ? { requirementsRevision: draft.requirementsRevision } : {}),
        status: draft.status,
        findings,
        validationEvidence,
        summary: draft.summary,
      };
      const file = this.reviewFile(sessionId, reviewId);
      if (fs.existsSync(file)) {
        throw new LedgerError('REVIEW_EXISTS',
          `review ${reviewId} already exists at ${file}; session.reviewSeq disagrees with the directory`);
      }
      const at = nowIso();
      const record = {
        schemaVersion: 1,
        seq,
        reviewId,
        decision,
        decisionDigest: jsonDigest(decision),
        recordedAt: at,
        recordedBy: actor,
      };
      fs.mkdirSync(this.reviewsDir(sessionId), { recursive: true });
      writeJsonAtomic(file, record);
      session.reviewSeq = seq;
      this.#commit(session, {
        kind: 'review-recorded',
        at,
        actor,
        actorRole,
        reviewId,
        taskId,
        status: decision.status,
        candidateRevision: decision.candidateRevision,
        inputSnapshotDigest: snapshot,
        unresolved: unresolved.length,
        decisionDigest: record.decisionDigest,
      });
      return record;
    });
  }

  /**
   * The review state of one task: the latest decision, and whether it still applies.
   *
   * Applicability is derived here and never stored. A `stale` field written into the
   * decision would be a fact that stops being true the moment the candidate moves —
   * and the whole point of plan §17 Scenario 5 is that nobody goes back to update it.
   * Deriving it means the answer cannot be out of date, only unknown.
   *
   * `candidateRevision` is the caller's to supply: this layer does not run git and
   * cannot know what the candidate is now. Omitting it does not buy an optimistic
   * answer — it yields `applies: null`, the same "unknown beats false" the inbox
   * uses for a task it cannot read. Inputs having moved still returns false, because
   * that much is known regardless of which candidate is being asked about.
   */
  reviewStateFor(sessionId, taskId, { candidateRevision = null } = {}) {
    assertId(sessionId, 'sessionId');
    assertId(taskId, 'taskId');
    if (candidateRevision !== null) assertRevision(candidateRevision, 'candidateRevision');
    const task = this.readTask(sessionId, taskId);
    const decisions = this.listReviews(sessionId).filter((r) => r.decision.taskId === taskId);
    const current = { inputSnapshotDigest: task.inputSnapshotDigest, candidateRevision };
    const latest = decisions.at(-1);
    if (!latest) {
      return {
        sessionId, taskId, status: 'none', reviewId: null, reviewer: null, recordedAt: null,
        reviewCount: 0, unresolvedFindings: 0, applies: false, reasons: ['no-review'],
        observed: null, current,
      };
    }
    const d = latest.decision;
    const reasons = [];
    if (d.inputSnapshotDigest !== task.inputSnapshotDigest) reasons.push('inputs-moved');
    if (candidateRevision !== null && d.candidateRevision !== candidateRevision) reasons.push('candidate-moved');
    let applies;
    if (reasons.length) applies = false;
    else if (candidateRevision === null) { applies = null; reasons.push('candidate-unknown'); }
    else applies = true;
    return {
      sessionId,
      taskId,
      status: d.status,
      reviewId: latest.reviewId,
      reviewer: d.reviewer,
      recordedAt: latest.recordedAt,
      reviewCount: decisions.length,
      unresolvedFindings: d.findings.filter((f) => FINDING_UNRESOLVED.has(f.status)).length,
      applies,
      reasons,
      observed: {
        candidateRevision: d.candidateRevision,
        inputSnapshotDigest: d.inputSnapshotDigest,
        requirementsRevision: d.requirementsRevision ?? null,
      },
      current,
    };
  }
}


/**
 * Validation as protocol rather than habit (plan §6).
 *
 * A task packet used to carry `validation: string[]` — a list of commands nobody
 * ran, checked against nothing. This module is the other half of making that a
 * plan: the vocabulary a plan is written in, and the execution of one check.
 *
 * Two properties everything here exists to serve:
 *
 * 1. **The plan is frozen with the task.** It lives inside the digested half of
 *    the packet, so an Agent cannot add a check that passes, drop one that fails,
 *    or edit the command it is judged by. Changing the plan means restating the
 *    task under a new generation, which is visible. This is also why running a
 *    `command` check through the shell is safe to do at all: the string executed
 *    is the one the packet author wrote and froze, not one the subject supplied.
 *
 * 2. **A check that could not run is not a check that failed.** `errored` is a
 *    separate outcome from `failed` because they route differently: a failure is
 *    the implementer's to fix, and an error — a missing binary, a timeout — is
 *    nobody's evidence about the code. Collapsing them would let a broken runner
 *    read as a broken candidate, which sends the wrong Agent to look.
 *
 * The ledger owns identity and refusal codes; this module owns vocabulary and
 * execution, and returns plain data so that recording is somebody else's decision.
 */
import { spawnSync } from 'node:child_process';

import { contentDigest } from './digest.mjs';
import { isRole, roleIds } from './roles.mjs';

/**
 * What a check is.
 *
 * `review` is here rather than in a separate mechanism because plan §7 asks the
 * runner to "check reviewer decision applicability" as one step of a gate. A
 * human judgement and a test run are both semantic evidence about a candidate,
 * they go stale for the same reasons, and a gate has to weigh them together — so
 * they are the same kind of thing with different ways of being satisfied.
 */
export const VALIDATION_KINDS = ['command', 'review'];

/**
 * When a check is required.
 *
 * Gates, not a single "must pass" flag, because the same task wants different
 * evidence at different moments: a fast unit run before handing off, the full
 * typecheck before integration, an independent review before merge. Demanding all
 * of it at every step trains Agents to skip the step.
 *
 * `revalidation` is the one spec-suite drives (plan §7): after a structural replay
 * on a rebased worktree, the semantic checks are rerun against the new candidate.
 */
export const VALIDATION_GATES = ['handoff', 'revalidation', 'integration', 'merge'];

/** What running a check concluded. See the header for why `errored` is not `failed`. */
export const EVIDENCE_STATUSES = ['passed', 'failed', 'errored'];

/** How much captured output an evidence record carries; the digest covers all of it. */
export const MAX_EXCERPT = 2000;

/** A command check that has not finished by now is not going to tell us anything. */
export const DEFAULT_TIMEOUT_MS = 600_000;

const CHECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Everything wrong with a plan, as a list of sentences.
 *
 * Returns problems rather than throwing so the caller decides what a malformed
 * plan means to it, and reports all of them at once: a packet author fixing one
 * typo per round trip through a refusal is how a plan ends up with the checks
 * that were easy to write rather than the ones that were needed.
 */
export function planProblems(plan, label = 'validationPlan') {
  if (!Array.isArray(plan)) return [`${label} must be an array of checks`];
  if (plan.length === 0) {
    return [`${label} must declare at least one check; a task with nothing to verify has no way to be done`];
  }
  const problems = [];
  const seen = new Set();
  plan.forEach((check, index) => {
    const at = `${label}[${index}]`;
    if (check === null || typeof check !== 'object' || Array.isArray(check)) {
      problems.push(`${at} must be an object`);
      return;
    }
    if (typeof check.checkId !== 'string' || !CHECK_ID.test(check.checkId)) {
      problems.push(`${at}.checkId must be lowercase kebab-case, got ${JSON.stringify(check.checkId)}`);
    } else if (seen.has(check.checkId)) {
      // Ids name evidence. Two checks sharing one would make "unit-tests passed"
      // ambiguous about which unit tests, and the gate would accept either.
      problems.push(`${at}.checkId ${check.checkId} is declared twice; a check id names its evidence`);
    } else {
      seen.add(check.checkId);
    }
    if (!VALIDATION_KINDS.includes(check.kind)) {
      problems.push(`${at}.kind must be one of ${VALIDATION_KINDS.join(', ')}, got ${JSON.stringify(check.kind)}`);
    }
    if (!Array.isArray(check.requiredAt) || check.requiredAt.length === 0) {
      problems.push(`${at}.requiredAt must name at least one gate (${VALIDATION_GATES.join(', ')}); `
        + 'a check required nowhere is a note, not a check');
    } else {
      for (const gate of check.requiredAt) {
        if (!VALIDATION_GATES.includes(gate)) {
          problems.push(`${at}.requiredAt contains ${JSON.stringify(gate)}, which is not one of ${VALIDATION_GATES.join(', ')}`);
        }
      }
      if (new Set(check.requiredAt).size !== check.requiredAt.length) {
        problems.push(`${at}.requiredAt repeats a gate`);
      }
    }
    if (check.kind === 'command') {
      if (typeof check.command !== 'string' || check.command.trim() === '') {
        problems.push(`${at}.command must be a non-empty string for a command check`);
      }
      if (check.role !== undefined) problems.push(`${at}.role does not apply to a command check`);
      if (check.timeoutMs !== undefined
        && (!Number.isInteger(check.timeoutMs) || check.timeoutMs <= 0)) {
        problems.push(`${at}.timeoutMs must be a positive integer of milliseconds`);
      }
    } else if (check.kind === 'review') {
      // The role is checked against the registry rather than pinned to `reviewer`,
      // because which roles exist is the registry's to say and a second list here
      // would drift. What matters is that the packet names one that exists: a plan
      // requiring approval from a role nobody holds can never be satisfied, and it
      // would look like an unfinished review forever.
      if (!isRole(check.role)) {
        problems.push(`${at}.role must be one of ${roleIds().join(', ')} for a review check, got ${JSON.stringify(check.role)}`);
      }
      if (check.command !== undefined) problems.push(`${at}.command does not apply to a review check`);
      if (check.timeoutMs !== undefined) problems.push(`${at}.timeoutMs does not apply to a review check`);
    }
    for (const key of Object.keys(check)) {
      if (!['checkId', 'kind', 'requiredAt', 'command', 'role', 'timeoutMs', 'description'].includes(key)) {
        problems.push(`${at}.${key} is not part of a validation check`);
      }
    }
    if (check.description !== undefined
      && (typeof check.description !== 'string' || check.description.trim() === '')) {
      problems.push(`${at}.description must be a non-empty string when present`);
    }
  });
  return problems;
}

/** The checks a gate requires, in plan order. */
export function checksRequiredAt(plan, gate) {
  if (!VALIDATION_GATES.includes(gate)) {
    throw new RangeError(`unknown validation gate ${JSON.stringify(gate)}; expected one of ${VALIDATION_GATES.join(', ')}`);
  }
  return (Array.isArray(plan) ? plan : []).filter((check) => check?.requiredAt?.includes(gate));
}

/**
 * Run one `command` check and report what happened.
 *
 * The command goes through the shell, because "npm test -- coupon" is what a
 * packet author writes and splitting it here would be a second, worse shell. See
 * the header for why that is not the hole it looks like: the string is frozen
 * inside the task's digest.
 *
 * `resultDigest` covers the whole captured output, and the excerpt is its tail.
 * The tail rather than the head because a failing run puts the reason at the end,
 * and the head is setup noise. Note what the digest is *not*: two passing runs of
 * the same suite will not share one, because real test output carries timings and
 * counts. It exists so a recorded result cannot be quietly restated later, not so
 * that runs can be compared.
 */
/**
 * Which of the three statuses a finished (or unfinished) run earned.
 *
 * Separate from `runCommandCheck` so it can be tested without arranging for the OS to
 * cooperate: "killed from outside" is the branch that matters most and the one a test
 * cannot reliably provoke, because Windows has no signals to deliver. Left inline it
 * would be the one classification nothing checks, and the invariant it protects —
 * unknown beats false — is precisely the one that fails silently when it breaks.
 */
export function classifyRun(result, limit) {
  if (result.error) {
    return {
      status: 'errored',
      note: result.error.code === 'ETIMEDOUT'
        ? `the check did not finish within ${limit}ms`
        : `the check could not be started: ${result.error.message}`,
    };
  }
  if (result.signal) {
    // Killed from outside — OOM killer, CI cancelling the job, a human losing patience.
    // Nobody learned anything about the candidate, and calling that a failure would send
    // the implementer looking for a bug that is not there.
    return { status: 'errored', note: `the check was killed by ${result.signal}` };
  }
  return { status: result.status === 0 ? 'passed' : 'failed', note: null };
}

export function runCommandCheck(check, { cwd, env = process.env, timeoutMs } = {}) {
  const limit = timeoutMs ?? check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const result = spawnSync(check.command, {
    cwd,
    env,
    shell: true,
    encoding: 'utf8',
    timeout: limit,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const durationMs = Date.now() - started;
  const { status, note } = classifyRun(result, limit);
  return {
    status,
    exitCode: result.status ?? null,
    durationMs,
    resultDigest: contentDigest(Buffer.from(output, 'utf8')),
    outputExcerpt: output.length > MAX_EXCERPT ? output.slice(-MAX_EXCERPT) : output,
    outputTruncated: output.length > MAX_EXCERPT,
    ...(note ? { note } : {}),
  };
}

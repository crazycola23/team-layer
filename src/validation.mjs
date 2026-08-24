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
 *    task under a new generation, which is visible.
 *
 *    What freezing buys is integrity, not safety. It proves the command run is the
 *    one the author wrote; a frozen `rm -rf` is still `rm -rf`. So the default kind
 *    is structured `argv` executed with `shell: false` — no word splitting, no
 *    globbing, no `&&`, no `$(...)`, and no quoting rules for an author to get
 *    wrong. A plan that genuinely needs shell syntax asks for it by name as
 *    `kind: shell-command`, which is the whole point: the capability is legible in
 *    the frozen packet and in review instead of being granted to every check by
 *    default. The threat model stays cooperative-but-fallible — this is about not
 *    handing out a capability nothing asked for, not about sandboxing malice.
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
 * `command` and `shell-command` are two kinds rather than one kind with a flag so
 * that the difference is a word in the frozen packet. A reviewer scanning a plan
 * sees which checks were handed a shell; a boolean buried in a check body is a
 * field you have to remember to look at.
 *
 * `review` is here rather than in a separate mechanism because plan §7 asks the
 * runner to "check reviewer decision applicability" as one step of a gate. A
 * human judgement and a test run are both semantic evidence about a candidate,
 * they go stale for the same reasons, and a gate has to weigh them together — so
 * they are the same kind of thing with different ways of being satisfied.
 */
export const VALIDATION_KINDS = ['command', 'shell-command', 'review'];

/** The kinds satisfied by running something, and therefore by recorded evidence. */
export const RUNNABLE_KINDS = ['command', 'shell-command'];

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
    if (RUNNABLE_KINDS.includes(check.kind)) {
      if (check.kind === 'command') {
        if (!Array.isArray(check.argv) || check.argv.length === 0) {
          problems.push(`${at}.argv must be a non-empty array of words for a command check: ["npm", "test"], not "npm test"`);
        } else if (check.argv.some((word) => typeof word !== 'string' || word === '')) {
          problems.push(`${at}.argv must contain only non-empty strings`);
        }
        // Refused rather than honoured, because honouring it is the whole hole: a
        // packet that says `command` and means a shell line would get one silently.
        if (check.command !== undefined) {
          problems.push(`${at}.command does not apply to a command check; give argv instead, or declare `
            + 'kind "shell-command" if this check genuinely needs shell syntax');
        }
      } else {
        if (typeof check.command !== 'string' || check.command.trim() === '') {
          problems.push(`${at}.command must be a non-empty string for a shell-command check`);
        }
        if (check.argv !== undefined) {
          problems.push(`${at}.argv does not apply to a shell-command check; a shell line is one string`);
        }
      }
      if (check.role !== undefined) problems.push(`${at}.role does not apply to a ${check.kind} check`);
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
      if (check.argv !== undefined) problems.push(`${at}.argv does not apply to a review check`);
      if (check.timeoutMs !== undefined) problems.push(`${at}.timeoutMs does not apply to a review check`);
    }
    for (const key of Object.keys(check)) {
      if (!['checkId', 'kind', 'requiredAt', 'command', 'argv', 'role', 'timeoutMs', 'description'].includes(key)) {
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
 * Run one runnable check and report what happened.
 *
 * A `command` check is spawned as argv with `shell: false`; a `shell-command` check
 * is handed to the shell it asked for. See the header for why that is two kinds and
 * not a flag.
 *
 * `resultDigest` covers the whole captured output, and the excerpt is its tail.
 * The tail rather than the head because a failing run puts the reason at the end,
 * and the head is setup noise. Note what the digest is *not*: two passing runs of
 * the same suite will not share one, because real test output carries timings and
 * counts. It exists so a recorded result cannot be quietly restated later, not so
 * that runs can be compared.
 */
/**
 * A sentence naming the likely cause when a `command` check never started.
 *
 * Worth the special case because the two ways structured argv fails on a real
 * machine are both invisible in the bare errno. A whole command line left in
 * `argv[0]` fails as `ENOENT` on a binary named "npm test", and on Windows the
 * launchers people reach for first — npm, npx, yarn — are `.cmd` batch files that
 * Node will not spawn without a shell at all. Reported as "spawnSync npm ENOENT"
 * and nothing else, both read as "the runner is broken", and the author goes
 * looking in the wrong place.
 */
export function startupHint(check, code) {
  if (check?.kind !== 'command') return '';
  const argv0 = Array.isArray(check.argv) ? check.argv[0] : null;
  if (typeof argv0 !== 'string' || argv0 === '') return '';
  if (/\s/.test(argv0)) {
    return ` argv[0] is ${JSON.stringify(argv0)}, which is a whole command line: argv has to be split into words.`;
  }
  const batch = /\.(?:cmd|bat)$/i.test(argv0);
  if (code === 'EINVAL' && batch) {
    return ` ${argv0} is a batch file, which cannot be spawned without a shell. Name the executable it`
      + ' wraps, or declare this check as kind "shell-command".';
  }
  if (code === 'ENOENT' && process.platform === 'win32' && !batch) {
    return ` On Windows a launcher such as npm, npx or yarn is a .cmd batch file rather than an`
      + ' executable, and is not spawnable without a shell. Name the executable it wraps, or declare'
      + ' this check as kind "shell-command".';
  }
  return '';
}

/**
 * Which of the three statuses a finished (or unfinished) run earned.
 *
 * Separate from `runCommandCheck` so it can be tested without arranging for the OS to
 * cooperate: "killed from outside" is the branch that matters most and the one a test
 * cannot reliably provoke, because Windows has no signals to deliver. Left inline it
 * would be the one classification nothing checks, and the invariant it protects —
 * unknown beats false — is precisely the one that fails silently when it breaks.
 */
export function classifyRun(result, limit, check = null) {
  if (result.error) {
    return {
      status: 'errored',
      note: result.error.code === 'ETIMEDOUT'
        ? `the check did not finish within ${limit}ms`
        : `the check could not be started: ${result.error.message}.${startupHint(check, result.error.code)}`,
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
  if (!RUNNABLE_KINDS.includes(check?.kind)) {
    // A RangeError rather than an `errored` result: a review check reaching the runner
    // is a caller bug, and returning evidence for it would file that bug as a fact
    // about the candidate.
    throw new RangeError(`runCommandCheck cannot run a ${JSON.stringify(check?.kind ?? null)} check; `
      + `expected one of ${RUNNABLE_KINDS.join(', ')}`);
  }
  const limit = timeoutMs ?? check.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const options = { cwd, env, encoding: 'utf8', timeout: limit, maxBuffer: 32 * 1024 * 1024 };
  // Two calls rather than one with a computed `shell` flag, because `spawnSync(file,
  // args, opts)` and `spawnSync(line, opts)` are different signatures. Passing argv
  // *with* shell:true would concatenate the words back into a line without escaping
  // them — Node's own DEP0190 warning — which is precisely the capability this kind
  // exists to withhold.
  const result = check.kind === 'shell-command'
    ? spawnSync(check.command, { ...options, shell: true })
    : spawnSync(check.argv[0], check.argv.slice(1), { ...options, shell: false });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const durationMs = Date.now() - started;
  const { status, note } = classifyRun(result, limit, check);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VALIDATION_KINDS, VALIDATION_GATES, EVIDENCE_STATUSES, MAX_EXCERPT,
  planProblems, checksRequiredAt, runCommandCheck, classifyRun,
} from '../src/validation.mjs';
import { loadSchema, validate } from '../src/schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = path.join(ROOT, 'schemas');
const CHECK_SCHEMA = loadSchema(path.join(SCHEMA_DIR, 'validation-check.schema.json'));

function check(overrides = {}) {
  return { checkId: 'unit-tests', kind: 'command', requiredAt: ['merge'], command: 'npm test', ...overrides };
}

/** A node one-liner, so the tests do not depend on a shell builtin or a package.json. */
function nodeCheck(script, overrides = {}) {
  return check({ command: `"${process.execPath}" -e "${script}"`, ...overrides });
}

// -------------------------------------------------------------------------- plans

test('a usable plan is accepted and reported problem-free', () => {
  assert.deepEqual(planProblems([
    check(),
    check({ checkId: 'contract-tests', requiredAt: ['handoff', 'merge'], command: 'npm run contract', timeoutMs: 30_000 }),
    { checkId: 'peer-review', kind: 'review', requiredAt: ['merge'], role: 'reviewer', description: 'A second pair of eyes.' },
  ]), []);
});

/**
 * Every way a plan can be unusable, reported as sentences rather than thrown.
 *
 * All of them at once, because the packet author is fixing a file: a validator that
 * stops at the first problem turns one edit into five round trips. The ledger is what
 * turns this list into a refusal.
 */
test('a plan that could not be run is rejected with a reason per problem', () => {
  for (const [name, plan, expected] of [
    ['not a list at all', { checkId: 'unit-tests' }, /must be an array/],
    ['nothing to check', [], /at least one check/],
    ['a check that is not an object', [null], /must be an object/],
    ['a checkId that is not a slug', [check({ checkId: 'Unit Tests' })], /checkId/],
    ['two checks under one id', [check(), check({ command: 'npm run other' })], /declared twice/],
    ['a kind nothing can run', [check({ kind: 'vibes' })], /kind must be one of/],
    ['a gate that gates nothing', [check({ requiredAt: [] })], /at least one gate/],
    ['a gate nobody consults', [check({ requiredAt: ['vibe-check'] })], /not one of/],
    ['one gate named twice', [check({ requiredAt: ['merge', 'merge'] })], /repeats a gate/],
    ['a command check with no command', [check({ command: undefined })], /command/],
    ['a command check claiming a reviewer', [check({ role: 'reviewer' })], /role/],
    ['a timeout that cannot elapse', [check({ timeoutMs: 0 })], /timeoutMs/],
    ['a review check with no role', [{ checkId: 'peer', kind: 'review', requiredAt: ['merge'] }], /role/],
    ['a review check with a role nobody has', [{ checkId: 'peer', kind: 'review', requiredAt: ['merge'], role: 'vibe-officer' }], /role/],
    ['a review check carrying a command', [{ checkId: 'peer', kind: 'review', requiredAt: ['merge'], role: 'reviewer', command: 'npm test' }], /command/],
    ['a key the runner would ignore', [check({ retries: 3 })], /retries/],
    ['a description that says nothing', [check({ description: '   ' })], /description/],
  ]) {
    const problems = planProblems(plan);
    assert.ok(problems.length >= 1, `${name} must be rejected`);
    assert.ok(problems.some((p) => expected.test(p)),
      `${name}: expected a problem matching ${expected}, got ${JSON.stringify(problems)}`);
  }
});

test('a plan reports every problem it has, not the first one', () => {
  assert.equal(planProblems([check({ checkId: 'Bad Id', kind: 'vibes', requiredAt: [] })]).length, 3);
});

test('a gate selects the checks that named it, and an unknown gate is a programming error', () => {
  const plan = [
    check({ checkId: 'unit-tests', requiredAt: ['handoff', 'merge'] }),
    check({ checkId: 'contract-tests', requiredAt: ['merge'] }),
    { checkId: 'peer-review', kind: 'review', requiredAt: ['merge'], role: 'reviewer' },
  ];
  assert.deepEqual(checksRequiredAt(plan, 'handoff').map((c) => c.checkId), ['unit-tests']);
  assert.deepEqual(checksRequiredAt(plan, 'merge').map((c) => c.checkId),
    ['unit-tests', 'contract-tests', 'peer-review']);
  // A gate no check named is an empty selection, not an error: gates the task asks
  // nothing of are ordinary, and the caller reports "nothing required here".
  assert.deepEqual(checksRequiredAt(plan, 'integration'), []);
  // A gate that does not exist is different in kind — the caller misspelled a
  // constant, and returning [] would read as "this gate is satisfied".
  assert.throws(() => checksRequiredAt(plan, 'ship-it'), RangeError);
});

// -------------------------------------------------------------------------- runs

test('a passing check is recorded as passed, with what it printed', () => {
  const result = runCommandCheck(nodeCheck(`console.log('42 tests, 0 failures')`), { cwd: ROOT });
  assert.deepEqual([result.status, result.exitCode, result.outputTruncated], ['passed', 0, false]);
  assert.match(result.outputExcerpt, /42 tests, 0 failures/);
  assert.ok(result.resultDigest.startsWith('sha256:'));
  assert.ok(Number.isInteger(result.durationMs) && result.durationMs >= 0);
});

test('a failing check keeps its exit code and its stderr', () => {
  const result = runCommandCheck(
    nodeCheck(`console.error('AC-1 regressed'); process.exit(3)`), { cwd: ROOT });
  assert.deepEqual([result.status, result.exitCode], ['failed', 3]);
  // stdout and stderr are one stream on purpose: interleaved is how a human read it,
  // and the failure explanation is usually on the half a split would drop.
  assert.match(result.outputExcerpt, /AC-1 regressed/);
});

/**
 * `errored` is not `failed`, and the distinction is the point of having three statuses.
 *
 * A timeout says nothing about the candidate — the check never reached a verdict — so
 * routing it to the implementer as a failure sends them to fix passing code. It reads
 * as unknown at the gate instead, and the next action is to fix the runner.
 */
test('a check that never reached a verdict is errored, not failed', () => {
  const result = runCommandCheck(
    nodeCheck(`setTimeout(() => {}, 60000)`, { timeoutMs: 250 }), { cwd: ROOT });
  assert.equal(result.status, 'errored');
  assert.equal(result.exitCode, null, 'nothing exited, so there is no exit code to report');
  assert.match(result.note, /did not finish within 250ms/);
});

/**
 * The four verdicts, classified without asking the OS to cooperate.
 *
 * Being killed from outside is the branch worth pinning and the one a portable test
 * cannot provoke — Windows has no signal to deliver, so a spawned child cannot be made
 * to report one. Reached directly, it can still be held to "unknown beats false": an
 * OOM kill or a cancelled CI job says nothing about the candidate, and reporting it as
 * `failed` would send the implementer to fix code that was never judged.
 */
test('a run is classified by what happened to it, not by what it exited with', () => {
  assert.deepEqual(classifyRun({ status: 0 }, 1000), { status: 'passed', note: null });
  assert.deepEqual(classifyRun({ status: 1 }, 1000), { status: 'failed', note: null });

  const killed = classifyRun({ status: null, signal: 'SIGKILL' }, 1000);
  assert.equal(killed.status, 'errored', 'killed from outside is unknown, not a verdict');
  assert.match(killed.note, /killed by SIGKILL/);

  const timedOut = classifyRun({ error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) }, 250);
  assert.deepEqual([timedOut.status, timedOut.note], ['errored', 'the check did not finish within 250ms']);

  const unstartable = classifyRun({ error: new Error('spawn EACCES') }, 1000);
  assert.equal(unstartable.status, 'errored');
  assert.match(unstartable.note, /could not be started: spawn EACCES/);

  // A signal outranks a status, because a killed process may still report one.
  assert.equal(classifyRun({ status: 0, signal: 'SIGTERM' }, 1000).status, 'errored');
});

test('a command that does not exist is errored rather than silently green', () => {
  const result = runCommandCheck(check({ command: 'definitely-not-a-real-command-xyz' }), { cwd: ROOT });
  assert.notEqual(result.status, 'passed');
  assert.notEqual(result.exitCode, 0);
});

/**
 * Output is truncated from the front, because the end is where the answer is.
 *
 * A 200k-line suite log cannot live in a record that a gate reads, but the last
 * screenful is what a human would have looked at, so keeping the head and dropping the
 * tail would store the least useful part and label it evidence.
 */
test('a torrent of output is kept as its tail, digested in full, and flagged', () => {
  const result = runCommandCheck(
    nodeCheck(`for (let i = 0; i < 40000; i++) console.log('line ' + i); console.log('THE VERDICT')`),
    { cwd: ROOT });
  assert.equal(result.status, 'passed');
  assert.ok(result.outputTruncated, 'the caller must be told it is not reading everything');
  assert.ok(result.outputExcerpt.length <= MAX_EXCERPT);
  assert.match(result.outputExcerpt, /THE VERDICT/);
  assert.doesNotMatch(result.outputExcerpt, /line 0\b/);
});

test('the check runs where it is told to, so a monorepo can validate one package', () => {
  const result = runCommandCheck(nodeCheck(`process.stdout.write(process.cwd())`), { cwd: SCHEMA_DIR });
  assert.equal(fs.realpathSync(result.outputExcerpt), fs.realpathSync(SCHEMA_DIR));
});

// ---------------------------------------------------------- vocabulary and schemas

/**
 * The runner branches on `kind`; the schema decides which shapes are legal. If a kind
 * is added to one and not the other, the failure is silent in the worse direction: a
 * check validates into a frozen packet and then is required by nothing.
 */
test('every runnable kind has a schema branch, and every branch a runnable kind', () => {
  const branches = CHECK_SCHEMA.schema.oneOf.map((branch) => {
    const name = branch.$ref.replace('#/$defs/', '');
    return CHECK_SCHEMA.schema.$defs[name].properties.kind.const;
  });
  assert.deepEqual([...branches].sort(), [...VALIDATION_KINDS].sort());
});

test('the generated vocabularies are the ones the code actually uses', () => {
  for (const [file, values] of [
    ['validation-kind.schema.json', VALIDATION_KINDS],
    ['validation-gate.schema.json', VALIDATION_GATES],
    ['evidence-status.schema.json', EVIDENCE_STATUSES],
  ]) {
    const schema = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8'));
    assert.deepEqual(schema.enum, values, `${file} must restate no vocabulary of its own`);
    assert.match(schema['x-generated-from'], /^src\/validation\.mjs /,
      `${file} must say where it came from, or the next editor will edit it`);
  }
  // And the gate enum reaches the check schema through $ref rather than a second copy.
  assert.equal(CHECK_SCHEMA.schema.$defs.requiredAt.items.$ref, 'validation-gate.schema.json');
});

/**
 * The schema has to refuse the same shapes the runner cannot run.
 *
 * `oneOf` over two closed branches is doing the work that `if/then` or `not` would do
 * elsewhere: src/schema.mjs deliberately supports neither, so "a command check may not
 * carry a role" is expressed by there being no branch that allows both.
 */
test('the check schema accepts exactly the two shapes that can be honoured', () => {
  const good = [
    check(),
    check({ timeoutMs: 900_000, description: 'The suite, before this leaves my hands.' }),
    { checkId: 'peer-review', kind: 'review', requiredAt: ['handoff', 'merge'], role: 'reviewer' },
  ];
  for (const value of good) {
    assert.deepEqual(validate(CHECK_SCHEMA, value), [], `must accept ${JSON.stringify(value)}`);
  }
  const bad = [
    ['a command check naming a reviewer', check({ role: 'reviewer' })],
    ['a review check carrying a command', { checkId: 'peer', kind: 'review', requiredAt: ['merge'], role: 'reviewer', command: 'npm test' }],
    ['a review check with a timeout', { checkId: 'peer', kind: 'review', requiredAt: ['merge'], role: 'reviewer', timeoutMs: 1 }],
    ['no gates', check({ requiredAt: [] })],
    ['a duplicated gate', check({ requiredAt: ['merge', 'merge'] })],
    ['an unknown gate', check({ requiredAt: ['ship-it'] })],
    ['an unknown kind', check({ kind: 'vibes' })],
    ['a checkId with spaces', check({ checkId: 'unit tests' })],
    ['a stray key', check({ retries: 3 })],
    ['a command check with no command', check({ command: undefined })],
  ];
  for (const [name, value] of bad) {
    assert.ok(validate(CHECK_SCHEMA, value).length > 0, `must reject ${name}`);
  }
});

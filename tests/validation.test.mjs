import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VALIDATION_KINDS, RUNNABLE_KINDS, VALIDATION_GATES, EVIDENCE_STATUSES, MAX_EXCERPT,
  planProblems, checksRequiredAt, runCommandCheck, classifyRun, startupHint,
} from '../src/validation.mjs';
import { loadSchema, validate } from '../src/schema.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = path.join(ROOT, 'schemas');
const CHECK_SCHEMA = loadSchema(path.join(SCHEMA_DIR, 'validation-check.schema.json'));

function check(overrides = {}) {
  return {
    checkId: 'unit-tests', kind: 'command', requiredAt: ['merge'],
    argv: ['node', '--test', 'tests/'], ...overrides,
  };
}

/** The other runnable kind: one string, and a shell to interpret it. */
function shellCheck(overrides = {}) {
  return {
    checkId: 'unit-tests', kind: 'shell-command', requiredAt: ['merge'],
    command: 'npm test && npm run lint', ...overrides,
  };
}

/** A node one-liner, so the tests do not depend on a shell builtin or a package.json. */
function nodeCheck(script, overrides = {}) {
  return check({ argv: [process.execPath, '-e', script], ...overrides });
}

// -------------------------------------------------------------------------- plans

test('a usable plan is accepted and reported problem-free', () => {
  assert.deepEqual(planProblems([
    check(),
    check({ checkId: 'contract-tests', requiredAt: ['handoff', 'merge'], argv: ['npx', 'pact-verifier'], timeoutMs: 30_000 }),
    shellCheck({ checkId: 'coverage-gate' }),
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
    ['two checks under one id', [check(), check({ argv: ['npm', 'run', 'other'] })], /declared twice/],
    ['a kind nothing can run', [check({ kind: 'vibes' })], /kind must be one of/],
    ['a gate that gates nothing', [check({ requiredAt: [] })], /at least one gate/],
    ['a gate nobody consults', [check({ requiredAt: ['vibe-check'] })], /not one of/],
    ['one gate named twice', [check({ requiredAt: ['merge', 'merge'] })], /repeats a gate/],
    ['a command check with nothing to run', [check({ argv: undefined })], /argv/],
    ['a command check with an empty argv', [check({ argv: [] })], /argv/],
    ['a command check whose argv holds a non-string', [check({ argv: ['node', 3] })], /argv/],
    ['a command check whose argv holds an empty word', [check({ argv: ['node', ''] })], /argv/],
    // The one that motivated splitting the kinds: a plan that says `command` and means
    // a shell line must be told so, not handed a shell because the field it filled in
    // happened to be readable.
    ['a command check smuggling a shell line', [check({ command: 'npm test && rm -rf .' })], /shell-command/],
    ['a shell-command check with no line', [shellCheck({ command: undefined })], /command/],
    ['a shell-command check with an empty line', [shellCheck({ command: '   ' })], /command/],
    ['a shell-command check given argv', [shellCheck({ argv: ['npm', 'test'] })], /argv/],
    ['a command check claiming a reviewer', [check({ role: 'reviewer' })], /role/],
    ['a shell-command check claiming a reviewer', [shellCheck({ role: 'reviewer' })], /role/],
    ['a timeout that cannot elapse', [check({ timeoutMs: 0 })], /timeoutMs/],
    ['a review check with no role', [{ checkId: 'peer', kind: 'review', requiredAt: ['merge'] }], /role/],
    ['a review check with a role nobody has', [{ checkId: 'peer', kind: 'review', requiredAt: ['merge'], role: 'vibe-officer' }], /role/],
    ['a review check carrying a command', [{ checkId: 'peer', kind: 'review', requiredAt: ['merge'], role: 'reviewer', command: 'npm test' }], /command/],
    ['a review check carrying argv', [{ checkId: 'peer', kind: 'review', requiredAt: ['merge'], role: 'reviewer', argv: ['npm', 'test'] }], /argv/],
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
  const result = runCommandCheck(check({ argv: ['definitely-not-a-real-command-xyz'] }), { cwd: ROOT });
  assert.notEqual(result.status, 'passed');
  assert.notEqual(result.exitCode, 0);
});

/**
 * The point of the kind: an ordinary check gets no shell, and cannot be given one.
 *
 * Proved by handing it words only a shell would treat as syntax and looking at where
 * they ended up. `&&` and `$(...)` arrive at the program as arguments; `> out.txt`
 * arrives as an argument rather than creating a file. Asserting on the arguments alone
 * would be weaker — a shell that split them would still be caught, but a shell that
 * redirected would not, and redirection is the half that writes to the disk.
 *
 * Worth this much care because the failure mode is invisible in every passing test: a
 * validation plan is frozen, and a frozen `rm -rf` is still `rm -rf`. Freezing proves
 * who wrote the line, not that running it was a good idea.
 */
test('a command check is spawned without a shell, so shell syntax stays data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-layer-noshell-'));
  try {
    const words = ['a b', '&&', 'echo', 'pwned', '$(echo substituted)', '`echo backtick`', '>', 'out.txt', '|', 'tee'];
    const result = runCommandCheck(check({
      argv: [process.execPath, '-e', 'process.stdout.write(process.argv.slice(1).join("\\n"))', ...words],
    }), { cwd: dir });

    assert.equal(result.status, 'passed');
    assert.deepEqual(result.outputExcerpt.split('\n'), words,
      'every word must reach the program exactly as written, unsplit and unsubstituted');
    assert.deepEqual(fs.readdirSync(dir), [],
      'a redirection that reached a shell would have left a file behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * And the escape hatch works, or nobody would have a reason to ask for it by name.
 *
 * `>` is the discriminator rather than `&&`: it is redirection in every shell this can
 * run under, including cmd.exe, where `$(...)` means nothing.
 */
test('a shell-command check gets the shell it asked for', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-layer-shell-'));
  try {
    const result = runCommandCheck(
      shellCheck({ command: `"${process.execPath}" -e "console.log(6*7)" > out.txt` }), { cwd: dir });
    assert.equal(result.status, 'passed');
    assert.match(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'), /42/,
      'the redirection is the whole capability this kind exists to grant');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A review check reaching the runner throws instead of returning `errored`.
 *
 * Returning a result would file a caller bug as a fact about the candidate: `errored`
 * evidence is recordable, and a gate reading it would say "the reviewer's judgement
 * could not be obtained" about a check nobody tried to obtain.
 */
test('the runner refuses a kind it cannot run rather than reporting it as errored', () => {
  for (const kind of ['review', 'vibes', undefined]) {
    assert.throws(() => runCommandCheck({ checkId: 'peer', kind, requiredAt: ['merge'], role: 'reviewer' },
      { cwd: ROOT }), RangeError, `${kind} must be refused as a caller bug`);
  }
  assert.throws(() => runCommandCheck(null, { cwd: ROOT }), RangeError);
});

/**
 * The two ways structured argv fails on a real machine, named at the moment of failure.
 *
 * Both are invisible in the bare errno. A whole command line left in `argv[0]` fails as
 * `ENOENT` on a binary named "npm test", and on Windows every launcher people reach for
 * first — npm, npx, yarn — is a `.cmd` batch file that Node refuses to spawn without a
 * shell (`EINVAL`, since the batch-file mitigation in CVE-2024-27980). Reported as
 * "spawnSync npm ENOENT" alone, both read as "the runner is broken".
 */
test('a check that could not start says which mistake it looks like', () => {
  assert.match(startupHint(check({ argv: ['npm test'] }), 'ENOENT'), /whole command line/);
  assert.match(startupHint(check({ argv: ['npm.cmd', 'test'] }), 'EINVAL'), /batch file/);
  assert.match(startupHint(check({ argv: ['npm.cmd', 'test'] }), 'EINVAL'), /shell-command/);

  // Silent where it has nothing to add: a shell-command check has no argv to diagnose,
  // and a hint offered for every failure is a hint nobody reads.
  assert.equal(startupHint(shellCheck(), 'ENOENT'), '');
  assert.equal(startupHint(check({ argv: ['node'] }), 'EACCES'), '');
  assert.equal(startupHint(null, 'ENOENT'), '');

  // Reached through the classifier, because that is where a real run collects it.
  const missing = runCommandCheck(check({ argv: ['npm test'] }), { cwd: ROOT });
  assert.equal(missing.status, 'errored');
  assert.match(missing.note, /whole command line/);
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
test('every kind has a schema branch, and every branch a kind', () => {
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
 * `oneOf` over closed branches is doing the work that `if/then` or `not` would do
 * elsewhere: src/schema.mjs deliberately supports neither, so "a command check may not
 * carry a role" is expressed by there being no branch that allows both — and so is the
 * one that matters most here, "a command check may not carry a shell line".
 */
test('the check schema accepts exactly the shapes that can be honoured', () => {
  const good = [
    check(),
    check({ timeoutMs: 900_000, description: 'The suite, before this leaves my hands.' }),
    shellCheck(),
    shellCheck({ timeoutMs: 900_000, description: 'Two runs, one verdict.' }),
    { checkId: 'peer-review', kind: 'review', requiredAt: ['handoff', 'merge'], role: 'reviewer' },
  ];
  for (const value of good) {
    assert.deepEqual(validate(CHECK_SCHEMA, value), [], `must accept ${JSON.stringify(value)}`);
  }
  const bad = [
    ['a command check naming a reviewer', check({ role: 'reviewer' })],
    ['a command check carrying a shell line', check({ command: 'npm test' })],
    ['a command check with argv and a shell line', check({ command: 'npm test', argv: ['npm', 'test'] })],
    ['a shell-command check given argv', shellCheck({ argv: ['npm', 'test'] })],
    ['a shell-command check with no line', shellCheck({ command: undefined })],
    ['a review check carrying a command', { checkId: 'peer', kind: 'review', requiredAt: ['merge'], role: 'reviewer', command: 'npm test' }],
    ['a review check carrying argv', { checkId: 'peer', kind: 'review', requiredAt: ['merge'], role: 'reviewer', argv: ['npm', 'test'] }],
    ['a review check with a timeout', { checkId: 'peer', kind: 'review', requiredAt: ['merge'], role: 'reviewer', timeoutMs: 1 }],
    ['no gates', check({ requiredAt: [] })],
    ['a duplicated gate', check({ requiredAt: ['merge', 'merge'] })],
    ['an unknown gate', check({ requiredAt: ['ship-it'] })],
    ['an unknown kind', check({ kind: 'vibes' })],
    ['a checkId with spaces', check({ checkId: 'unit tests' })],
    ['a stray key', check({ retries: 3 })],
    ['a command check with nothing to run', check({ argv: undefined })],
    ['a command check with an empty argv', check({ argv: [] })],
    ['a command check whose argv holds an empty word', check({ argv: ['node', ''] })],
  ];
  for (const [name, value] of bad) {
    assert.ok(validate(CHECK_SCHEMA, value).length > 0, `must reject ${name}`);
  }
});

/**
 * The vocabulary and the runner have to agree on which kinds produce evidence.
 *
 * `RUNNABLE_KINDS` is what the ledger consults to decide whether a recorded run answers
 * a check. A kind that is runnable to the runner and not to the ledger would run fine
 * and then be refused on record, which reads as "your evidence is wrong" rather than
 * "these two lists disagree".
 */
test('every runnable kind is a kind, and the unrunnable one is not runnable', () => {
  for (const kind of RUNNABLE_KINDS) {
    assert.ok(VALIDATION_KINDS.includes(kind), `${kind} must be part of the vocabulary`);
    assert.deepEqual(planProblems([check({ kind, ...(kind === 'command' ? {} : { argv: undefined, command: 'npm test' }) })]), [],
      `${kind} must be plannable, or nothing can ever satisfy it`);
  }
  assert.ok(!RUNNABLE_KINDS.includes('review'),
    'a review is satisfied by a recorded judgement; running one is not a thing the runner can do');
});

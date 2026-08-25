/**
 * Locating a real spec-suite checkout, for the tests that must run the far side's own code.
 *
 * Every other test in this suite fakes spec-suite, and has to: a synthetic install is the only way
 * to ask what happens when the far side is old, or absent, or answers incoherently. But a fake
 * cannot fail in the one direction that matters. `projectSpecTask` used to withhold `taskId`, every
 * projection test passed, and the artifact was unreadable by the real merge gate — because the fake
 * was built from the same belief as the code, so the two agreed and both were wrong.
 *
 * So the cross-repo tests run the real binaries. That makes them conditional on a checkout being
 * present, which is a real cost: a conditional test that quietly passes when it did not run is
 * worse than no test. Hence `requireSpecSuite`, which records an explicit `skipped` with the
 * variable to set, and `scripts/validate-skill.mjs`, which fails if the cross-repo file or any of
 * its named tests goes missing — the two ways this coverage could evaporate without anyone seeing
 * a red line.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT } from './cli.mjs';

export const SPEC_SUITE_ENV = 'TEAM_LAYER_SPEC_SUITE_ROOT';

/**
 * The files that make a directory a spec-suite rather than a directory called spec-suite.
 *
 * Both are named because the sibling search below guesses, and a wrong guess is worse than no
 * guess: pointed at some unrelated checkout the tests would fail for reasons that have nothing to
 * do with this layer, and the failure would read like a contract break.
 */
const MARKERS = [
  path.join('scripts', 'merge-gate.mjs'),
  path.join('scripts', 'control-plane-concurrency.mjs'),
];

/** Sibling directories worth trying when nobody exported the variable. */
const SIBLINGS = ['spec-suite', 'spec-suite-work'];

function looksLikeSpecSuite(candidate) {
  return MARKERS.every((marker) => fs.existsSync(path.join(candidate, marker)));
}

/**
 * `{root}` when a checkout was found, `{reason}` when not — never a throw, never a silent null.
 *
 * The variable wins over the siblings even when it points at something unusable, because an
 * operator who exported it wants *that* checkout tested; falling back to a neighbouring directory
 * would test something else and report success.
 */
export function findSpecSuite(env = process.env) {
  const named = env[SPEC_SUITE_ENV];
  if (named) {
    const root = path.resolve(named);
    if (!looksLikeSpecSuite(root)) {
      return { root: null, reason: `${SPEC_SUITE_ENV}=${named} is not a spec-suite checkout: `
        + `expected ${MARKERS.join(' and ')}` };
    }
    return { root, source: SPEC_SUITE_ENV };
  }
  for (const sibling of SIBLINGS) {
    const root = path.resolve(ROOT, '..', sibling);
    if (looksLikeSpecSuite(root)) return { root, source: 'sibling' };
  }
  return { root: null, reason: `no spec-suite checkout found; set ${SPEC_SUITE_ENV} to one `
    + `(searched siblings: ${SIBLINGS.join(', ')})` };
}

/**
 * A checkout of the sibling's *committed* HEAD, made once per test process.
 *
 * The sibling is this layer's own probe fixture, not an operator's choice, and what it holds on
 * disk is whatever the last session over there was in the middle of. That is not the contract:
 * these tests assert what the far side has committed, and a half-finished session leaving
 * `capabilities.mjs` modified in its worktree once turned every handshake assertion red for a
 * reason no commit introduced — while the sibling's uncommitted work was exactly the thing
 * nobody had agreed to yet. Cloning gives the tests the committed state without touching the
 * sibling's working tree, so the WIP stays exactly as its author left it and the suite stays
 * green for reasons a commit can explain.
 *
 * The env-var path deliberately does no such thing: an operator who exported
 * `TEAM_LAYER_SPEC_SUITE_ROOT` asked for *that* directory, dirt and all.
 */
let committedSibling = null;
function committedCheckout(root) {
  if (committedSibling) return committedSibling;
  // A sibling without a `.git` is an unpacked export: it has no committed state to be faithful
  // to, so it is used as-is rather than refused.
  if (!fs.existsSync(path.join(root, '.git'))) return root;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-layer-spec-suite-'));
  execFileSync('git', ['clone', '--quiet', root, dir], { encoding: 'utf8' });
  committedSibling = dir;
  return committedSibling;
}

/** The root, or null after marking the test skipped with the reason. */
export function requireSpecSuite(t, env = process.env) {
  const found = findSpecSuite(env);
  if (!found.root) {
    t.skip(found.reason);
    return null;
  }
  return found.source === 'sibling' ? committedCheckout(found.root) : found.root;
}

/**
 * Run one of spec-suite's entry scripts and return `{status, stdout, stderr, json}`.
 *
 * `json` is null rather than a throw when stdout does not parse, because the interesting failures
 * here are the ones where the far side wrote a diagnostic instead of a verdict, and a parse error
 * thrown from the helper would hide the diagnostic the test needs to report.
 */
export function specSuite(root, script, args, { cwd = root } = {}) {
  const res = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { json = null; }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

/** `git`, in a repository the test just built. */
export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

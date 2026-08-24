/**
 * A whole team on one repository: what the flow-level suites need before they can assert anything.
 *
 * `tests/helpers/cli.mjs` builds one agent in one worktree, which is all a unit test needs. The
 * suites that walk a flow need three agents who genuinely cannot see each other's work — the
 * reviewer cannot read the implementer's HEAD, the implementer cannot record its own approval,
 * and the integration target moves under both of them. That setup is long enough that a second
 * copy would drift, and drift here is worse than usual: if `couponPacket` means something
 * slightly different in two files, the two suites are describing two products and the one that
 * disagrees with reality is whichever nobody is reading.
 */
import fs from 'node:fs';
import path from 'node:path';

import { bootstrapped, git, json, run, taskPacket, writePacket } from './cli.mjs';

/** Two canonical revisions of the same contract: what the task was frozen at, and where it moved. */
export const A1 = `sha256:${'a1'.repeat(32)}`;
export const A2 = `sha256:${'a2'.repeat(32)}`;

/**
 * A check that can actually run: Node, which is here by definition, rather than `npm test`.
 *
 * The fixture repository has no package.json, and a check that always errors would make every
 * gate read `unknown` for the wrong reason — the interesting `unknown`s are the ones staleness
 * produces, and they have to be distinguishable from a broken runner.
 */
export const nodeArgv = (script) => [process.execPath, '-e', script];

/** The product architect, an implementer, and a reviewer, each in its own worktree. */
export function team() {
  const product = bootstrapped({ agentId: 'product-01', role: 'product-architect' });
  // Read rather than assumed: `git init` names the first branch from the machine's config, so a
  // hard-coded `master` here would make every git-freshness assertion depend on whose laptop ran
  // the suite.
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], product.repo);
  const join = (name, agentId, role, harness) => {
    const repo = path.join(product.dir, name);
    git(['worktree', 'add', repo, '-b', name], product.repo);
    const worktree = { dir: product.dir, repo, home: product.home };
    run(['setup', '--agent-id', agentId, '--role', role, '--harness', harness, '--repo', repo], worktree);
    return worktree;
  };
  return {
    branch,
    product,
    dev: join('wt-fullstack', 'fullstack-01', 'fullstack', 'claude-code'),
    reviewer: join('wt-reviewer', 'reviewer-01', 'reviewer', 'codex'),
  };
}

/** A commit in one worktree, as the revision the rest of the layer refers to it by. */
export function commit(worktree, file, body, message) {
  fs.writeFileSync(path.join(worktree.repo, file), body);
  git(['add', file], worktree.repo);
  git(['commit', '-m', message], worktree.repo);
  return `git:${git(['rev-parse', 'HEAD'], worktree.repo)}`;
}

/** The packet these suites work from: one command check at both gates, one review at merge. */
export function couponPacket(t, overrides = {}) {
  return taskPacket({
    baseRevision: `git:${git(['rev-parse', t.branch], t.product.repo)}`,
    inputs: [{ id: 'contract:coupon', revision: A1, authority: 'product-architect' }],
    validationPlan: [
      {
        checkId: 'unit-tests',
        kind: 'command',
        requiredAt: ['handoff', 'merge'],
        argv: nodeArgv("console.log('coupon: 12 passing')"),
      },
      { checkId: 'peer-review', kind: 'review', requiredAt: ['merge'], role: 'reviewer' },
    ],
    ...overrides,
  });
}

/** What the canonical authority currently says, in the shape `--canonical-inputs` reads. */
export function canonical(worktree, rows, name = 'canonical.json') {
  const file = path.join(worktree.repo, name);
  fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
  return name;
}

/** The session and task every flow starts from: issued by product, addressed to the dev. */
export function issued(t, overrides = {}) {
  run(['session', 'start', '--session', 'feature:coupon', '--target', t.branch], t.product);
  writePacket(t.product, couponPacket(t, overrides));
  return json(['task', 'issue', '--packet', 'packet.json'], t.product);
}

export const SESSION = ['--session', 'feature:coupon'];
export const TASK = [...SESSION, '--task', 'task:coupon-api'];

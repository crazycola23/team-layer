/**
 * Where the two layers meet, and the reason neither one may answer alone.
 *
 * This layer decides whether a candidate is *semantically* sound: the task is current, the
 * checks it declared have run against this exact commit, and somebody with the authority to
 * approve it did. spec-suite decides whether the same candidate is *structurally* safe to
 * merge: ancestry, declared write scope, the submitted commit history, whether the target has
 * moved underneath it. Neither question implies the other, and neither project is in a position
 * to answer the other one — which is why the composition is written down here instead of being
 * left to whoever is holding both reports.
 *
 * Three rules, and every one of them exists because the tempting shortcut is wrong.
 *
 * 1. **A pass here is not permission to merge.** `teamctl reconcile` answers `integrate` on
 *    semantic grounds, and an Agent reading it has been told the work is finished, reviewed and
 *    tested — not that the merge is safe. `integrationReady` is the only field that means the
 *    latter, and it is false until a structural verdict has actually been supplied. Absent is
 *    not passing: `not-consulted` is reported as `unknown` and never widens into a yes.
 *
 * 2. **This layer never computes the structural answer.** `structuralVerdict` reads one
 *    boolean out of spec-suite's own merge-gate report and refuses to guess when it is not
 *    there. Re-deriving ancestry or scope here would be a second merge gate, and a second gate
 *    is worse than none: two implementations of one rule disagree eventually, and the one that
 *    is wrong is the one nobody is maintaining.
 *
 * 3. **Both verdicts must be about the same commit.** This is the rule with teeth, and the
 *    sequence it stops is not hypothetical. Semantics pass at C1; the structural gate says a
 *    replay is needed; spec-suite replays onto C2; the gate now says C2 is safe. Two passing
 *    reports, both genuine, describing two different trees — and composing them would integrate
 *    a commit nothing was ever validated against. It is the same rule the ledger applies to
 *    review decisions and evidence one level down (a judgement is valid only for the world it
 *    was made in), applied to the pair of verdicts rather than to one artifact.
 *
 * Nothing here is stored. Like `reviewStateFor` and `validationStateFor`, the answer is derived
 * per call, because a written-down verdict is a fact that stops being true the moment the
 * candidate moves and nobody goes back to amend it.
 */

/**
 * The two moments spec-suite can ask, named as spec-suite sees them.
 *
 * `pre-merge` is the ordinary question: may this candidate go in. `post-replay` is asked after
 * spec-suite has rewritten the candidate onto a moved target, and it is a different question
 * for a reason the far side cannot see — every piece of evidence this layer holds is bound to a
 * commit, so a replay invalidates all of it at once. Structural replay is not proof of semantic
 * correctness (protocol/spec-suite.md), and this is where that sentence stops being prose.
 */
export const INTEGRATION_PHASES = ['pre-merge', 'post-replay'];

/**
 * Which gates each phase asks about.
 *
 * `post-replay` asks about `merge` as well as `revalidation`, and that is the point rather than
 * belt-and-braces. A packet is free to declare no `revalidation` checks at all, and a gate with
 * nothing required reads `passed` — correctly, since nothing was asked for. Accepting that as
 * the answer after a replay would mean a rewritten tree could be merged on the strength of a
 * review of the tree it replaced. Asking the merge gate too means everything that had to hold
 * before the replay has to hold after it, against the new commit, or the answer is `unknown`.
 */
export const PHASE_GATES = { 'pre-merge': ['merge'], 'post-replay': ['revalidation', 'merge'] };

/** Three-valued, for the same reason validation is: see src/validation.mjs. */
export const INTEGRATION_STATUSES = ['passed', 'failed', 'unknown'];

/** How a structural verdict came to be known. `not-consulted` is a status, not an absence. */
export const STRUCTURAL_SOURCES = ['spec-suite', 'not-consulted'];

/**
 * Reconcile answers that are a verdict *against* the candidate.
 *
 * The split is between "we looked and it is wrong" and "nobody has established it yet", and it
 * matters because spec-suite treats anything other than a pass as a refusal either way — but a
 * human reading the report needs to know whether to fix the code or to run something. Every
 * member of `NEXT_ACTIONS` is in exactly one of these two lists, and `scripts/validate-skill.mjs`
 * proves it, so adding a next action forces this decision instead of defaulting to `unknown`.
 */
export const SEMANTIC_ESTABLISHED_NEGATIVE = [
  'reissue-task',
  'rebase-task',
  'resolve-unresolved',
  'unblock-task',
  'address-review',
];

/**
 * Reconcile answers that establish nothing either way.
 *
 * `run-validation` is here rather than above because it covers both a check that failed and a
 * check that has not run, and only the first is a finding about the candidate. The distinction
 * is taken from the gate's own three-valued status, not from the name of the action.
 */
export const SEMANTIC_UNESTABLISHED = [
  'bind-worktree',
  'open-session',
  'await-task',
  'ack-handoff',
  'run-validation',
  'request-review',
  'continue-task',
];

/**
 * The semantic half, in the shape spec-suite's external validation hook reads.
 *
 * Derived from `decide()` rather than recomputed, so this can never disagree with what
 * `teamctl reconcile` tells the Agent working on the task. Two answers to one question is how a
 * layer ends up with a second gate by accident: the classification below turns reconcile's
 * answer into a verdict, and adds no rule of its own.
 */
export function semanticVerdict({ phase, candidate = null, decision, validations = [] }) {
  if (!INTEGRATION_PHASES.includes(phase)) {
    throw new TypeError(`phase must be one of ${INTEGRATION_PHASES.join(', ')}, got ${JSON.stringify(phase)}`);
  }
  const gates = validations.map((v) => ({ gate: v.gate, status: v.status, failed: v.failed, unknown: v.unknown }));
  const reasons = [];
  let status;
  if (candidate === null) {
    // Every check in the ledger is bound to a commit, so with no commit named there is nothing
    // for the evidence to be about. Unknown rather than failed: this is the caller declining to
    // say which tree it means, not a finding about any tree.
    status = 'unknown';
    reasons.push('candidate-unknown');
  } else if (decision.nextAction === 'integrate' && gates.every((g) => g.status === 'passed')) {
    status = 'passed';
  } else if (gates.some((g) => g.status === 'failed')) {
    status = 'failed';
    for (const g of gates.filter((x) => x.status === 'failed')) reasons.push(`${g.gate}-validation-failed`);
    // The gate names the check that failed and the action names what to do about it, and a report
    // carrying only one of them leaves a reader either without the finding or without the remedy.
    // The finding comes first because it is the specific thing: `address-review` is what to do
    // about a great many different problems.
    reasons.push(decision.nextAction);
  } else if (SEMANTIC_ESTABLISHED_NEGATIVE.includes(decision.nextAction)) {
    status = 'failed';
    reasons.push(decision.nextAction);
  } else {
    status = 'unknown';
    reasons.push(decision.nextAction);
    for (const g of gates.filter((x) => x.status !== 'passed')) reasons.push(`${g.gate}-validation-${g.status}`);
  }
  return { status, phase, candidate, gates, reasons, nextAction: decision.nextAction };
}

/**
 * spec-suite's answer, read rather than reproduced.
 *
 * `safeToMerge` is the field spec-suite's merge gate publishes its verdict in, and it is the
 * only field trusted here — its `status` travels along as a label so a reader can see *which*
 * structural finding it was, prefixed `structural-` because the two layers share vocabulary
 * they do not share meanings for. spec-suite's `stale-base` is a structural finding a replay can
 * resolve; this layer's stale base needs the task restated. A reason string that did not say
 * which layer it came from is a reason string that gets routed to the wrong remedy.
 *
 * A report this function does not recognise is `unknown`, loudly. The alternative — treating an
 * unfamiliar shape as a refusal — would look like a finding about the candidate, and the
 * alternative to that is unthinkable.
 */
export function structuralVerdict(raw) {
  if (raw === null || raw === undefined) {
    return {
      status: 'unknown',
      source: 'not-consulted',
      candidate: null,
      reasons: ['structural-gate-not-consulted'],
      observed: null,
    };
  }
  const label = typeof raw.status === 'string' ? raw.status : null;
  const candidate = typeof raw.headRevision === 'string' ? raw.headRevision : null;
  const observed = { status: label, safeToMerge: raw.safeToMerge ?? null, headRevision: candidate };
  if (typeof raw.safeToMerge !== 'boolean') {
    return {
      status: 'unknown',
      source: 'spec-suite',
      candidate,
      reasons: ['structural-verdict-unrecognized'],
      observed,
    };
  }
  return {
    status: raw.safeToMerge ? 'passed' : 'failed',
    source: 'spec-suite',
    candidate,
    reasons: raw.safeToMerge ? [] : [`structural-${label ?? 'refused'}`],
    observed,
  };
}

/**
 * Both verdicts, and the one thing that may be concluded from having both.
 *
 * `integrationReady` is a conjunction and is written as one: there is no combination of a
 * missing verdict, an unknown, or a mismatch that produces a yes. The candidate comparison is
 * the third rule from the header — two passes about two different commits are not a pass.
 */
export function composeIntegration({ semantic, structural }) {
  const reasons = [];
  if (semantic.status !== 'passed') reasons.push(`semantic-${semantic.status}`, ...semantic.reasons);
  if (structural.status !== 'passed') reasons.push(...structural.reasons);
  // Only when both sides named a commit: a report that named none is already `unknown` above,
  // and inventing a mismatch on top of that would report two problems where there is one.
  const sameCandidate = semantic.candidate !== null && structural.candidate !== null
    ? semantic.candidate === structural.candidate
    : null;
  if (sameCandidate === false) {
    reasons.push('verdicts-disagree-on-candidate',
      `this layer validated ${semantic.candidate} and the structural gate examined ${structural.candidate}`);
  }
  const integrationReady = semantic.status === 'passed' && structural.status === 'passed'
    && sameCandidate === true;
  return {
    integrationReady,
    phase: semantic.phase,
    candidate: semantic.candidate,
    sameCandidate,
    reasons,
    semantic,
    structural,
  };
}

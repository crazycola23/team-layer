/**
 * "Where am I, and what do I do next?" — answered from the ledger rather than from memory.
 *
 * This is the command an Agent runs first after a context compaction (plan §12), which
 * dictates almost everything about its shape.
 *
 * **One next action, not a list.** An Agent that has just lost its context cannot weigh five
 * findings against each other; if it could, it would not need this command. So the answer is
 * a single `nextAction` chosen by a stated precedence — and every finding that lost is still
 * reported in `reasons`, because "why this and not that" has to be inspectable or the
 * precedence becomes folklore.
 *
 * **Freshness is three-valued**, for the reason capability support is: "the base moved" and
 * "nobody could establish whether the base moved" lead to different actions, and collapsing
 * them means a `fresh` that was never checked. The team layer cannot resolve a canonical
 * input revision by itself — the packet's inputs are ids and revisions, not paths, and only
 * the canonical authority knows what the current revision is — so `inputs` reads `unknown`
 * until somebody supplies that observation. That is the honest report while spec-suite has
 * no revision handshake (plan §2.3 is Phase A, undone here), and it is far better than the
 * `fresh` that would otherwise be inferred from having nothing to compare against.
 *
 * **Pure.** Every observation is passed in. Git and the canonical authority are the caller's
 * to consult, because a decision function that shells out is a decision function that cannot
 * be tested against the interesting cases — a diverged history, a target branch that does
 * not exist locally, an authority that answered about half the inputs.
 */

/** Three-valued, and `unknown` is a real answer rather than a missing one. */
export const FRESHNESS = ['fresh', 'stale', 'unknown'];

/**
 * How much is in the way, coarsely, for a caller that acts on the summary alone.
 *
 * `blocked` is reserved for what somebody else has to clear — an unresolved fact, a task
 * somebody parked. A review asking for changes is not blocked: that is this Agent's work.
 */
export const RECONCILE_STATUSES = ['unbound', 'idle', 'stale', 'blocked', 'ready'];

/**
 * The closed vocabulary of next actions, in precedence order.
 *
 * Closed, and ordered, because this is the field an Agent branches on. A free-text
 * instruction would be interpreted, and interpreting is the step that goes wrong; an
 * unordered set would let two findings produce two different answers on two runs.
 */
export const NEXT_ACTIONS = [
  'bind-worktree',
  'open-session',
  'await-task',
  'reissue-task',
  'rebase-task',
  'resolve-unresolved',
  'unblock-task',
  'ack-handoff',
  'address-review',
  'run-validation',
  'request-review',
  'integrate',
  'continue-task',
];

/**
 * Has the ground moved under the frozen base revision?
 *
 * The comparison is against the integration target's current commit, not against this
 * worktree's HEAD: the plan's Scenario 4 is the target branch moving ahead while the Agent
 * works, and the Agent's own commits are supposed to move HEAD. Comparing to HEAD would
 * report every Agent that had done any work at all as stale.
 *
 * `baseIsAncestor` is asked for separately and allowed to be null because the two shapes of
 * staleness are not equally bad: a target that moved ahead of the base is a rebase, while a
 * target whose history no longer contains the base is a divergence somebody has to look at.
 * Reporting both as "stale" and leaving the difference out of the detail would send an Agent
 * to rebase against a history that will not take it.
 */
export function gitFreshness({ baseRevision = null, target = null, targetCommit = null, baseIsAncestor = null } = {}) {
  if (typeof baseRevision !== 'string' || baseRevision === '') {
    return { state: 'unknown', detail: 'the task was frozen without a base revision, so nothing can be compared' };
  }
  if (typeof targetCommit !== 'string' || targetCommit === '') {
    return {
      state: 'unknown',
      detail: `the current commit of ${target ?? 'the integration target'} could not be read, `
        + 'so whether the base is behind it was never established',
    };
  }
  const base = baseRevision.replace(/^git:/, '');
  if (base === targetCommit) {
    return { state: 'fresh', detail: `the task is based on ${target ?? 'the integration target'}'s current commit` };
  }
  if (baseIsAncestor === false) {
    return {
      state: 'stale',
      detail: `${base.slice(0, 12)} is not in ${target ?? 'the integration target'}'s history: `
        + 'the histories diverged, so this is not a rebase somebody can do unattended',
    };
  }
  return {
    state: 'stale',
    detail: `${target ?? 'the integration target'} has moved to ${targetCommit.slice(0, 12)} since the task was frozen at ${base.slice(0, 12)}`
      + (baseIsAncestor === null ? ', and ancestry could not be established' : ''),
  };
}

/**
 * Are the frozen input revisions still what the canonical authority says?
 *
 * `observed` is what somebody who *can* ask the authority reports: `[{ id, revision }]`. The
 * three rules that matter are all about what silence means.
 *
 * An observation that does not mention a declared input leaves that input `unknown`, never
 * `fresh` — the authority not having been asked about `contract:checkout` is not the authority
 * agreeing about it, and this is precisely the case that would otherwise let an Agent work
 * against a superseded contract believing it had been checked.
 *
 * An observed input the task never declared is not staleness at all. A revision the task does
 * not depend on cannot go stale for it, and counting it would make every task in a repository
 * stale whenever any contract anywhere moved — which trains people to ignore the field.
 *
 * A task with no inputs is `fresh` vacuously, and the detail says so, because "nothing can go
 * stale" and "nothing was checked" are the two answers this whole module exists to separate.
 */
export function inputsFreshness({ inputs = null, observed = null } = {}) {
  const declared = Array.isArray(inputs) ? inputs : [];
  if (!declared.length) {
    return { state: 'fresh', detail: 'the task declares no semantic inputs, so none can go stale', stale: [], unchecked: [] };
  }
  if (!Array.isArray(observed)) {
    return {
      state: 'unknown',
      detail: 'no canonical revision observation was supplied, and this layer cannot resolve one: '
        + 'the task carries input ids and revisions, not the locations only the authority knows',
      stale: [],
      unchecked: declared.map((input) => input.id),
    };
  }
  const current = new Map(observed
    .filter((row) => row && typeof row.id === 'string')
    .map((row) => [row.id, row.revision]));
  const stale = [];
  const unchecked = [];
  for (const input of declared) {
    if (!current.has(input.id)) unchecked.push(input.id);
    else if (current.get(input.id) !== input.revision) {
      stale.push({ id: input.id, frozen: input.revision, current: current.get(input.id) });
    }
  }
  if (stale.length) {
    return {
      state: 'stale',
      detail: `the canonical authority has moved on from ${stale.map((s) => s.id).join(', ')}`,
      stale,
      unchecked,
    };
  }
  if (unchecked.length) {
    return {
      state: 'unknown',
      detail: `the observation says nothing about ${unchecked.join(', ')}, and silence is not agreement`,
      stale,
      unchecked,
    };
  }
  return { state: 'fresh', detail: 'every declared input is at the revision the task was frozen against', stale, unchecked };
}

/**
 * Pick the one thing to do, and say what else was true.
 *
 * The precedence is the design, so it is written here as a list rather than spread through
 * nested conditionals. Two orderings in it are decisions rather than taste:
 *
 * Stale inputs outrank a stale base, because reissuing the task restates the whole packet —
 * a new base revision included — so `rebase-task` first would be work thrown away by the
 * reissue that follows it.
 *
 * Both outrank an unacknowledged handoff, because acknowledging a handoff whose inputs have
 * moved is refused by the ledger anyway (a handoff carries the snapshot it was published
 * against). Sending an Agent to `ack-handoff` under stale inputs would be sending it into a
 * refusal it cannot fix from there.
 */
export function decide(state) {
  const { binding, session, task, freshness, handoffs = [], review = null, validation = null } = state;
  const findings = [];
  // Same argument order as `answer`, deliberately: these two are the only places an action and
  // a status are named together, and a module where one reads (status, action) and the other
  // reads (action, status) is a module where the two get swapped and every finding reports the
  // wrong half. The installer checks these literals against both vocabularies, which only works
  // if the position of each is fixed.
  const finding = (status, nextAction, reason) => findings.push({ nextAction, status, reason });

  if (!binding) {
    return answer('unbound', 'bind-worktree',
      ['this worktree has no agent binding, so it cannot say who is asking']);
  }
  if (!session) {
    return answer('idle', 'open-session',
      ['no session holds a task for this agent']);
  }
  if (!task) {
    return answer('idle', 'await-task',
      [`session ${session.sessionId} has no task addressed to this agent`]);
  }

  if (freshness.inputs.state === 'stale') finding('stale', 'reissue-task', `inputs are stale: ${freshness.inputs.detail}`);
  if (freshness.git.state === 'stale') finding('stale', 'rebase-task', `the base is stale: ${freshness.git.detail}`);
  if (review?.status === 'blocked-unresolved' && review.applies !== false) {
    finding('blocked', 'resolve-unresolved',
      `review ${review.reviewId} is blocked on unresolved facts, which need an authority this agent does not hold`);
  }
  if (task.state.status === 'blocked') finding('blocked', 'unblock-task', `task ${task.frozen.taskId} is parked as blocked`);
  if (handoffs.length) {
    finding('ready', 'ack-handoff',
      `${handoffs.length} unacknowledged handoff${handoffs.length === 1 ? '' : 's'} addressed to this agent`);
  }
  if (review?.status === 'changes-requested' && review.applies !== false) {
    finding('ready', 'address-review',
      `review ${review.reviewId} requested changes (${review.unresolvedFindings} finding(s) still open)`);
  }
  if (validation && validation.status !== 'passed') {
    finding('ready', 'run-validation',
      `${validation.gate} validation is ${validation.status}: ${validation.failed} failed, ${validation.unknown} unestablished`);
  }
  if (task.state.status === 'completed' && (!review || review.status === 'none' || review.applies === false)) {
    finding('ready', 'request-review',
      review && review.status !== 'none'
        ? `the work is complete and review ${review.reviewId} no longer applies (${review.reasons.join(', ')})`
        : 'the work is complete and no review has been recorded');
  }
  // `review.applies !== false` is redundant today and kept anyway: a superseded approval is
  // already caught by the `request-review` branch above, which fires on `applies === false` and
  // outranks `integrate`. So no test can distinguish this clause — dropping it changes nothing
  // observable, which is exactly what makes it the clause somebody deletes as dead weight. What
  // it guards against is a later edit narrowing that branch, after which its absence would
  // integrate work approved against code that has since moved. The precedence is pinned by
  // `a superseded review sends the completed work back for a fresh one`.
  if (task.state.status === 'completed' && review?.status === 'approved' && review.applies !== false
    && (!validation || validation.status === 'passed')) {
    finding('ready', 'integrate', 'the work is complete, approved, and validated at this gate');
  }

  if (!findings.length) {
    return answer('ready', 'continue-task', [`task ${task.frozen.taskId} is ${task.state.status} and nothing is in the way`]);
  }
  // Sorted by position in NEXT_ACTIONS, so adding an action means deciding where it ranks —
  // rather than discovering the rank later from whichever branch happened to run first. The
  // reasons are ordered the same way, which is what makes `reasons[0]` the explanation of
  // `nextAction` instead of merely one of the things that were true.
  findings.sort((a, b) => NEXT_ACTIONS.indexOf(a.nextAction) - NEXT_ACTIONS.indexOf(b.nextAction));
  return answer(findings[0].status, findings[0].nextAction, findings.map((f) => f.reason));
}

function answer(status, nextAction, reasons) {
  return { status, nextAction, reasons };
}

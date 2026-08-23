/**
 * The §14 counters, derived from the audit log — and an explicit list of the ones that cannot be.
 *
 * §14 ends with the only criterion that matters: has this reduced the user's traffic-cop work?
 * That makes a missing metric more dangerous here than in most places. `humanInterventions: 0`
 * is what a system that never records human intervention reports, and it is indistinguishable
 * from the outcome the whole plan is aiming at. So a counter nothing can establish is named in
 * `unavailable` with the reason, and no number is printed for it. A reader can argue with a
 * gap; nobody argues with a zero.
 *
 * Everything counted here comes from `events.jsonl` rather than from scanning the artifact
 * directories, because the log is the half whose completeness can be checked: `session.eventSeq`
 * says how many events there should be, so a truncated log is refused instead of silently
 * producing a smaller number. Counting handoff files in a directory would have no such check —
 * and a metric that is quietly low is worse than one that is absent, for the same reason a
 * zero is.
 */

/**
 * Counters derived from event kinds, with the meaning each one actually has.
 *
 * The names are §14's where a §14 metric is genuinely what is being counted, and deliberately
 * *not* §14's where the log can only support something narrower — `taskReissues` rather than
 * `staleInputEvents`, because a reissue is what the ledger records and a stale input is only
 * the most common reason for one. Borrowing the aspirational name for the available number is
 * how a dashboard ends up measuring something other than what its labels claim.
 */
export const METRIC_SOURCES = {
  sessions: 'session-created',
  sessionStatusChanges: 'session-status-changed',
  tasksIssued: 'task-issued',
  taskReissues: 'task-reissued',
  taskStatusChanges: 'task-status-changed',
  handoffs: 'handoff-published',
  handoffAcks: 'handoff-acked',
  reviewRounds: 'review-recorded',
  validationRuns: 'evidence-recorded',
};

/**
 * What §14 asks for that nothing in this layer records, and why.
 *
 * Each entry says whose fact it is, so the list reads as a work item rather than an excuse.
 * Two of them are spec-suite's to emit (the merge gate is not in this layer at all), and the
 * rest need an event that does not exist yet — which is a decision to make deliberately,
 * since every new event kind is a thing the audit log promises to keep forever.
 */
export const UNAVAILABLE_METRICS = [
  { metric: 'humanInterventions',
    reason: 'nothing records when a human had to step in; inferring it from silence would report the '
      + 'success this plan is trying to measure' },
  { metric: 'unresolvedCaughtBeforeImplementation',
    reason: 'handoffs and reviews carry unresolved counts, but not whether the fact was caught before '
      + 'implementation started: that needs the unresolved item timestamped against the task status' },
  { metric: 'contextRecoveries',
    reason: 'reconcile is a read command and does not write to the log; counting recoveries means '
      + 'deciding that asking "where am I" is itself an event worth keeping forever' },
  { metric: 'staleBaseEvents',
    reason: 'base staleness is derived on demand by comparing the frozen base against the integration '
      + 'target, and a derived answer leaves no trace to count' },
  { metric: 'mergeGateBlocks',
    reason: "spec-suite's, not this layer's: the merge gate runs there and this layer never observes a block" },
  { metric: 'falseBlocks',
    reason: 'a block being false is a human judgement about a block, and no artifact records that judgement' },
  { metric: 'postMergeFailures',
    reason: 'nothing in this layer observes what happens after a merge lands' },
];

/**
 * Count what the log proves, per session and in total.
 *
 * `reviewFindings`, `unresolvedRaised` and `unresolvedFindings` are summed from event payloads
 * rather than counted as occurrences, which is why they are here rather than in
 * `METRIC_SOURCES`: a review that raised nine findings and a review that raised none are one
 * `review-recorded` event each, and reporting only the round count would make the loudest review
 * look like the quietest.
 *
 * The two `unresolved` counters are kept apart on purpose, because the word means two different
 * things in the two events. A handoff's `unresolved` is a list of facts an Agent declined to
 * guess past — which is what §14 is measuring. A review's is the number of findings the decision
 * left open. Summing them would produce a figure that is neither, and whose movement nobody
 * could attribute; this is the same collision the protocol notes between the two repositories'
 * `inputs`, arriving from a different direction.
 *
 * `readEvents` is asked to check the sequence, so a session whose log has been truncated
 * refuses rather than contributing a smaller number. A session that cannot be read at all is
 * reported as a row in `unreadable` and does not stop the others: this is the same rule the
 * inbox follows, and for the same reason — one corrupt session must not be able to hide every
 * other session's numbers.
 */
export function collectMetrics(ledger, { sessionId = null } = {}) {
  const sessionIds = sessionId ? [sessionId] : ledger.listSessions();
  const sessions = [];
  const unreadable = [];
  const totals = zeroed();

  for (const id of sessionIds) {
    let events;
    try {
      const session = ledger.readSession(id);
      events = ledger.readEvents(id, { expectSeq: session.eventSeq });
    } catch (error) {
      unreadable.push({ sessionId: id, code: error.code ?? 'UNREADABLE', message: error.message });
      continue;
    }
    const counters = zeroed();
    for (const event of events) {
      for (const [metric, kind] of Object.entries(METRIC_SOURCES)) {
        if (event.kind === kind) counters[metric] += 1;
      }
      if (event.kind === 'review-recorded') {
        // A log written before `findings` was recorded cannot answer this, and a partial sum
        // would read as a total. Null propagates instead — the same rule `inbox` follows with
        // `stale: null`: unknown beats a number nothing checked. A footnote under a plausible
        // figure is not read; a null is.
        sum(counters, 'reviewFindings', event.findings);
        sum(counters, 'unresolvedFindings', event.unresolved);
      }
      // §14's own metric, and the one whose absence would be least visible: the handoffs that
      // carried no unresolved list at all are exactly the ones where an Agent may have guessed.
      if (event.kind === 'handoff-published') sum(counters, 'unresolvedRaised', event.unresolved);
      // A run that did not pass is the interesting half: revalidation succeeding is the
      // normal case and revalidation always succeeding is a sign the checks prove nothing.
      if (event.kind === 'evidence-recorded' && event.status === 'passed') counters.validationPasses += 1;
      if (event.kind === 'review-recorded' && event.status === 'approved') counters.reviewApprovals += 1;
    }
    for (const metric of Object.keys(totals)) {
      // One session that cannot answer makes the total unable to answer. Adding the sessions
      // that could would produce a number smaller than the truth and shaped exactly like it.
      if (counters[metric] === null || totals[metric] === null) totals[metric] = null;
      else totals[metric] += counters[metric];
    }
    sessions.push({ sessionId: id, events: events.length, counters });
  }

  return { totals, sessions, unreadable, unavailable: UNAVAILABLE_METRICS };
}

/** Derived metrics live beside the counted ones so a caller never has to guess which is which. */
export const DERIVED_METRICS = [
  'reviewFindings', 'unresolvedRaised', 'unresolvedFindings', 'validationPasses', 'reviewApprovals',
];

/**
 * Add a payload figure, or give up on the whole counter if the event cannot supply it.
 *
 * The give-up is the point. An event kind that gained a field later leaves older events without
 * it, and treating those as zero yields a sum that is too low while looking exactly like a sum
 * that is right — the one failure mode a metric must not have, because nobody audits a number
 * that looks plausible.
 */
function sum(counters, metric, value) {
  if (counters[metric] === null) return;
  if (typeof value === 'number') counters[metric] += value;
  else counters[metric] = null;
}

function zeroed() {
  return Object.fromEntries([...Object.keys(METRIC_SOURCES), ...DERIVED_METRICS].map((metric) => [metric, 0]));
}

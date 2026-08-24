/**
 * What the installed spec-suite can actually do, and what may therefore be handed to it.
 *
 * Two rules shape everything here.
 *
 * 1. **A capability is established by asking the far side or by exercising it, never by reading
 *    about it.** The plan (§8) is explicit that "I read the docs and it seems supported" is not an
 *    answer, and the reason is not pedantry: spec-suite's task validator *silently accepts unknown
 *    fields*. Hand it an `inputs` array it has never heard of and nothing complains — the gate
 *    passes, the field is dropped, and the projection looks like it worked. Prose cannot catch that.
 *
 *    `scripts/capabilities.mjs` is not prose. It refuses to emit a feature whose implementation it
 *    cannot find, and takes its whole response down rather than answer partially, so a declaration
 *    that arrives has been checked against the checkout that produced it. That is why `declared`
 *    outranks `probed` rather than merely being more convenient — and why the probe is now a
 *    fallback for installs predating the handshake rather than the primary path.
 *
 * 2. **Unknown is not unsupported, and neither is supported.** Three values, for the same
 *    reason validation has three: "the mechanism is provably absent" and "I could not
 *    establish it" lead to different actions. Absent evidence degrades to `unknown`, and
 *    `unknown` never satisfies a projection — a field travels only on demonstrated support.
 *
 *    This applies to the handshake's own answers. A feature it does not mention is `unknown`,
 *    because an older handshake has no way to say "definitely not"; a version that is not a
 *    positive integer is also `unknown`, because a malformed answer is not an answer. Neither
 *    becomes `unsupported` — that verdict belongs to the probe, which can see a module is absent.
 *
 * The honest consequence is that a probe reports less than a handshake would: no versions, and
 * `unknown` for everything that needs a repository and a candidate to demonstrate.
 * `compatibilityMode` is where that says so out loud rather than degrading quietly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { jsonDigest } from './digest.mjs';

/** The capabilities the plan's handshake names (§8). Absent from a response means unknown. */
export const SPEC_SUITE_CAPABILITIES = [
  'multiAgentConcurrency',
  'semanticInputs',
  'mergeGate',
  'structuralRevalidation',
  'semanticValidator',
];

/** Three-valued on purpose. See the header: unknown is not unsupported. */
export const CAPABILITY_SUPPORT = ['supported', 'unsupported', 'unknown'];

/** Where a capability answer came from, most authoritative first. */
export const CAPABILITY_SOURCES = ['declared', 'probed', 'unavailable'];

/**
 * The task fields spec-suite's concurrency contract is known to carry.
 *
 * A fallback, and marked `assumed` in the output whenever it is used, because a hardcoded
 * whitelist is exactly how a field starts being injected that the far side silently
 * swallows: the list is right on the day it is written and nobody notices when it stops
 * being. The probe discovers the real list from `projectionConcurrencyFields` when it can,
 * and this is only what to do when spec-suite is not reachable at all.
 */
export const ASSUMED_PROJECTABLE_FIELDS = ['baseRevision', 'readSet', 'writeSet', 'subject', 'role'];

/**
 * Fields spec-suite's task contract requires of every task, whatever the install can do.
 *
 * `taskId` is not a concurrency field, so the discovery experiment below — which asks
 * spec-suite's own `projectionConcurrencyFields` which keys it keeps — will never name it, and
 * this layer used to read that silence as "spec-suite does not want it" and file `taskId` as
 * team-layer-owned. It is the opposite: `evaluateMergeGate` refuses a task whose `taskId` is not
 * a non-empty string before it resolves a single commit. The projection was producing an
 * artifact the real gate could not read, and no amount of probing would have found it, because
 * the probe only ever asked which *scheduling* fields survive.
 *
 * So these travel unconditionally, outside the discovered whitelist, and no capability may gate
 * them. A field the far side *requires* is not a feature to negotiate — if it did not travel
 * there would be nothing to negotiate about, only a gate that fails closed for the wrong reason.
 */
export const CONTRACT_REQUIRED_FIELDS = ['taskId'];

/**
 * Team packet fields that are the team layer's own and are never projected.
 *
 * Not "unsupported" — `acceptance` and `validationPlan` are not things spec-suite is
 * missing, they are things this layer owns (plan §9: unsupported fields stay in the team
 * layer). Listing them explicitly is what makes `withheld` readable: an Agent seeing
 * `inputs` withheld for a capability reason and `acceptance` withheld for an ownership
 * reason should not have to work out which is which.
 *
 * `schemaVersion` is here for a subtler reason than ownership: both sides have a field of that
 * name and they count different things. Projecting this layer's packet version verbatim would
 * hand spec-suite a number about a schema it has never seen, and its own document policy
 * requires exactly `1`. So the packet's version stays behind and the artifact declares
 * spec-suite's, which is a translation rather than a projection — see `SPEC_TASK_SCHEMA_VERSION`.
 */
export const TEAM_LAYER_ONLY_FIELDS = ['schemaVersion', 'sessionId', 'acceptance', 'validationPlan'];

/**
 * The `schemaVersion` spec-suite's document policy requires of a task artifact.
 *
 * A constant of the far side's contract, not a mirror of ours. `assertSchemaVersion` demands
 * exactly `1` and `evaluateMergeGate` never looks — so emitting it costs nothing at the gate and
 * is what makes the same artifact readable by the projection and lease paths that do look.
 */
export const SPEC_TASK_SCHEMA_VERSION = 1;

/**
 * Which capability a projectable field depends on. Fields absent from this map need none.
 *
 * Exported so `scripts/validate-skill.mjs` can prove that this map, `CONTRACT_REQUIRED_FIELDS`,
 * `ASSUMED_PROJECTABLE_FIELDS` and `TEAM_LAYER_ONLY_FIELDS` between them account for every field
 * of a task packet. A field added to the packet and to none of the four would quietly file as
 * `not-projectable`, which is a decision nobody made appearing as a decision somebody made.
 */
export const FIELD_CAPABILITY = { inputs: 'semanticInputs' };

/**
 * The module that *is* each capability — the ones whose absence settles the question.
 *
 * `scripts/merge-gate.mjs` not existing means there is no merge gate to invoke; that is a
 * fact about spec-suite, and reporting it as `unknown` would be false modesty.
 */
const CAPABILITY_MODULES = {
  multiAgentConcurrency: 'scripts/control-plane-concurrency.mjs',
  mergeGate: 'scripts/merge-gate.mjs',
  structuralRevalidation: 'scripts/orchestrate.mjs',
  semanticValidator: 'scripts/orchestrate.mjs',
};

/**
 * Capabilities no file can settle, only an experiment.
 *
 * `semanticInputs` is a property of spec-suite's *task contract*, not of a module. The
 * concurrency module is merely the instrument that reveals it — so that file's absence says
 * the instrument is missing, not that the feature is, and reporting `unsupported` there
 * would be the probe mistaking its own blindness for a finding about the far side. A future
 * spec-suite could carry `inputs` through machinery this skill has never heard of; what it
 * could not do is carry them past a projection that drops them.
 */
const EXPERIMENT_ONLY_CAPABILITIES = ['semanticInputs'];

function answer(support, evidence, version = null) {
  return { support, version, evidence };
}

/**
 * A version, or nothing — and `0` is nothing.
 *
 * spec-suite's own suite refuses to emit a version that is not a positive integer, but that suite
 * guards *that* checkout. This function is what stands between this layer and a fork, an older
 * build, or a half-finished feature flag whose natural value is `0`. The hole it closes is narrow
 * and quiet: `typeof 0 === 'number'`, so a `0` used to read as `supported` while meaning the
 * opposite of support, and only a caller that *also* compared the version against a floor would
 * have escaped it — which is to say, a caller doing the check this function exists to make
 * unnecessary.
 *
 * A malformed version reads `unknown`, never `unsupported`: a handshake with a bug in one entry has
 * established nothing about that feature, and its other entries are still the best information
 * available. Quarantining the bad one and noting it beats discarding a real declaration over a
 * fault that is visible and reportable.
 */
function versionOrNull(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Ask spec-suite what it supports, if it is in a position to be asked.
 *
 * `scripts/capabilities.mjs --format json` is the real handshake and is preferred whenever it
 * answers, entry by entry: a well-formed version is taken at face value, a malformed one is
 * quarantined as `unknown`, and the rest of the response still counts. Its absence is not a problem
 * to route around silently: the return value says `probed`, and every caller has to decide what to
 * do with a `version: null`.
 */
export function detectCapabilities({ root, timeoutMs = 30_000 } = {}) {
  if (typeof root !== 'string' || root === '') {
    return unavailable('no spec-suite root was given, so nothing was asked');
  }
  if (!fs.existsSync(root)) {
    return unavailable(`${root} does not exist`);
  }
  const declared = readDeclaredCapabilities(root, timeoutMs);
  if (declared) return declared;
  return probeCapabilities(root);
}

function unavailable(reason) {
  return {
    source: 'unavailable',
    root: null,
    protocolVersion: null,
    capabilities: Object.fromEntries(SPEC_SUITE_CAPABILITIES.map((name) => [name, answer('unknown', reason)])),
    projectableFields: { fields: [...ASSUMED_PROJECTABLE_FIELDS], discovered: false },
    notes: [reason],
  };
}

function readDeclaredCapabilities(root, timeoutMs) {
  const script = path.join(root, 'scripts', 'capabilities.mjs');
  if (!fs.existsSync(script)) return null;
  const run = spawnSync(process.execPath, [script, '--format', 'json'],
    { cwd: root, encoding: 'utf8', timeout: timeoutMs });
  if (run.status !== 0 || typeof run.stdout !== 'string') {
    // A handshake that is present and broken is worse than one that is absent, because a
    // caller could read the exit code as "no capabilities". Say what happened and probe.
    const probed = probeCapabilities(root);
    probed.notes.unshift(`scripts/capabilities.mjs exists but did not answer (exit ${run.status}); probed instead`);
    return probed;
  }
  let response;
  try {
    response = JSON.parse(run.stdout);
  } catch (error) {
    const probed = probeCapabilities(root);
    probed.notes.unshift(`scripts/capabilities.mjs did not emit JSON (${error.message}); probed instead`);
    return probed;
  }
  const features = response.features ?? {};
  const notes = [];
  const capabilities = Object.fromEntries(SPEC_SUITE_CAPABILITIES.map((name) => {
    const declared = features[name];
    // A capability the handshake does not mention is unknown, not unsupported. The
    // handshake is allowed to grow, and an older one has no way to say "definitely not".
    if (declared === undefined) {
      return [name, answer('unknown', 'the capability response does not mention it')];
    }
    const version = versionOrNull(declared);
    if (version === null) {
      // Not silently dropped: a doctor report that showed `unknown` with no reason would look
      // like an old handshake, when what happened is that this one answered badly.
      notes.push(`spec-suite declared ${name} as ${JSON.stringify(declared)}, which is not a version; treated as unknown`);
      return [name, answer('unknown', `the capability response declares ${JSON.stringify(declared)}, which is not a version`)];
    }
    return [name, answer('supported', 'declared by scripts/capabilities.mjs', version)];
  }));
  const extra = Object.keys(features).filter((name) => !SPEC_SUITE_CAPABILITIES.includes(name));
  if (extra.length) notes.push(`spec-suite declares capabilities this skill does not know about: ${extra.join(', ')}`);
  const protocolVersion = versionOrNull(response.protocolVersion);
  if (protocolVersion === null && response.protocolVersion !== undefined) {
    notes.push(`spec-suite declared protocolVersion ${JSON.stringify(response.protocolVersion)}, which is not a version`);
  }
  return {
    source: 'declared',
    root,
    protocolVersion,
    capabilities,
    projectableFields: discoverProjectableFields(root, notes),
    notes,
  };
}

/**
 * What can be established about an install that cannot be asked.
 *
 * The rule the header states, applied: `supported` requires having run the thing.
 * `multiAgentConcurrency` and `semanticInputs` are both answered by one experiment — feed
 * spec-suite's own projection helper a task carrying every team field and see which keys
 * come back — so both get real answers. Everything else needs a repository, a candidate
 * and a merge to demonstrate, which a doctor command has no business arranging, so those
 * report `unknown` with the file that suggests they exist. That is deliberately weaker
 * than "the file is there, call it supported": a module can exist and not do what its name
 * says, and the whole point of the handshake is to stop inferring behaviour from names.
 */
export function probeCapabilities(root) {
  const notes = [];
  const capabilities = {};
  for (const name of SPEC_SUITE_CAPABILITIES) {
    if (EXPERIMENT_ONLY_CAPABILITIES.includes(name)) {
      // Placed here only to keep the declaration order readable in a doctor report; the
      // experiment below settles it either way, so this evidence is what stands when the
      // experiment could not be run at all.
      capabilities[name] = answer('unknown',
        `${CAPABILITY_MODULES.multiAgentConcurrency} could not be exercised, so whether the task contract carries inputs was never established`);
      continue;
    }
    const relative = CAPABILITY_MODULES[name];
    capabilities[name] = fs.existsSync(path.join(root, relative))
      ? answer('unknown', `${relative} is present, but a probe cannot exercise this capability`)
      : answer('unsupported', `${relative} does not exist`);
  }

  const fields = discoverProjectableFields(root, notes);
  if (fields.discovered) {
    capabilities.multiAgentConcurrency = answer('supported',
      `${CAPABILITY_MODULES.multiAgentConcurrency} projected a concurrency task: ${fields.fields.join(', ')}`);
    capabilities.semanticInputs = fields.fields.includes('inputs')
      ? answer('supported', 'the concurrency projection carries inputs')
      : answer('unsupported', 'the concurrency projection drops inputs, so semantic inputs stay in the team layer');
  }
  notes.push('capabilities were probed, not declared: install spec-suite\'s scripts/capabilities.mjs for versions');
  return { source: 'probed', root, protocolVersion: null, capabilities, projectableFields: fields, notes };
}

/**
 * Which task keys spec-suite actually keeps, discovered by handing it one that has everything.
 *
 * This is the experiment that makes the rest trustworthy. The far side accepts unknown
 * fields without complaint, so the only way to learn what it *keeps* is to give it a task
 * containing every field this layer has and compare. A grep for field names would pass on
 * a module that mentions `inputs` in a comment.
 */
function discoverProjectableFields(root, notes) {
  const relative = CAPABILITY_MODULES.multiAgentConcurrency;
  const module = path.join(root, relative);
  if (!fs.existsSync(module)) {
    notes.push(`${relative} is absent, so the projectable fields are assumed rather than discovered`);
    return { fields: [...ASSUMED_PROJECTABLE_FIELDS], discovered: false };
  }
  const probe = [
    'const m = await import(process.argv[1]);',
    'const task = JSON.parse(process.argv[2]);',
    'const projected = m.projectionConcurrencyFields(task);',
    'process.stdout.write(JSON.stringify(Object.keys(projected ?? {})));',
  ].join('');
  const specimen = {
    baseRevision: `git:${'a'.repeat(40)}`,
    readSet: ['src/**'],
    writeSet: ['src/one.ts'],
    subject: 'agent:probe-01',
    role: 'fullstack',
    inputs: [{ id: 'contract:probe', revision: `sha256:${'b'.repeat(64)}`, authority: 'spec-suite' }],
    acceptance: ['the probe learns something'],
  };
  const run = spawnSync(process.execPath,
    ['--input-type=module', '-e', probe, pathToFileURL(module).href, JSON.stringify(specimen)],
    { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (run.status !== 0) {
    notes.push(`${relative} could not be exercised (${(run.stderr || '').trim().split('\n').pop() || `exit ${run.status}`}), `
      + 'so the projectable fields are assumed rather than discovered');
    return { fields: [...ASSUMED_PROJECTABLE_FIELDS], discovered: false };
  }
  let keys;
  try {
    keys = JSON.parse(run.stdout);
  } catch {
    notes.push(`${relative} answered unreadably, so the projectable fields are assumed rather than discovered`);
    return { fields: [...ASSUMED_PROJECTABLE_FIELDS], discovered: false };
  }
  if (!Array.isArray(keys) || !keys.length) {
    notes.push(`${relative} kept no fields, so the projectable fields are assumed rather than discovered`);
    return { fields: [...ASSUMED_PROJECTABLE_FIELDS], discovered: false };
  }
  return { fields: keys.filter((key) => typeof key === 'string').sort(), discovered: true };
}

/**
 * Turn a frozen team packet into the spec-suite task artifact, and say what did not travel.
 *
 * Whitelist rather than blacklist, which is the whole design (plan §9: "不得注入未知字段").
 * The temptation is to copy the packet and delete what spec-suite does not want, because
 * that is one line shorter — and it is wrong in the direction that cannot be detected:
 * every field this layer adds later would ship by default into a validator that accepts it
 * silently, and the first symptom would be a merge gate that read a field nobody set.
 *
 * `withheld` is the other half. A projection that quietly dropped `inputs` would leave an
 * Agent believing the far side knows about the contract revision its work depends on. Each
 * entry says which field, why, and where the field is still authoritative — so
 * "semantic staleness is the team layer's job here" is a statement the tool makes, not a
 * paragraph somebody has to remember reading.
 */
export function projectSpecTask(packet, detection) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    throw new TypeError('a task packet must be an object');
  }
  const allowed = detection.projectableFields.fields;
  const projection = {};
  const withheld = [];

  /**
   * What the far side requires travels first, and is not filtered through the whitelist.
   *
   * The whitelist answers "which optional fields does this install carry"; a required field is
   * not in that conversation. Running the required fields through `allowed` is precisely the bug
   * this list exists to fix — the discovery experiment asks about concurrency keys, so it is
   * silent about `taskId`, and treating that silence as a refusal produced a task artifact the
   * merge gate rejected before it read anything else.
   *
   * A packet missing one of them cannot be projected into anything usable, so this throws rather
   * than emitting an artifact whose first symptom is a gate failing for a reason that has nothing
   * to do with the candidate.
   */
  for (const field of CONTRACT_REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(packet, field)) {
      throw new TypeError(`a task packet must carry ${field}: spec-suite's task contract requires it`);
    }
    projection[field] = packet[field];
  }
  projection.schemaVersion = SPEC_TASK_SCHEMA_VERSION;

  /**
   * A capability-governed field is attributed to its capability first, even when the
   * whitelist never mentioned it.
   *
   * The two axes coincide today — `semanticInputs` is discovered by asking whether the
   * projection keeps `inputs` — but filing it as merely "not in the whitelist" would report
   * the true fact and lose the actionable one. "spec-suite's task contract does not carry
   * inputs" reads like a schema note; "semanticInputs is unsupported, so staleness against
   * your contract revisions is enforced only here" is the thing an Agent has to act on, and
   * it is what makes the run `degraded` rather than `full`.
   */
  for (const [field, capability] of Object.entries(FIELD_CAPABILITY)) {
    if (!Object.prototype.hasOwnProperty.call(packet, field)) continue;
    const support = detection.capabilities[capability]?.support ?? 'unknown';
    if (support === 'supported' && allowed.includes(field)) continue;
    withheld.push({
      field,
      reason: support === 'supported' ? 'not-projectable' : `capability-${support}`,
      capability,
      detail: support === 'supported'
        ? `${capability} is supported but ${field} is not in spec-suite's task contract`
        : detection.capabilities[capability]?.evidence ?? 'no evidence',
      authority: 'team-layer',
    });
  }

  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(packet, field)) continue;
    if (withheld.some((w) => w.field === field)) continue;
    projection[field] = packet[field];
  }

  /**
   * Whether a packet field travelled is recorded as it travels, not inferred from the artifact.
   *
   * `schemaVersion` is why. The artifact has one and the packet's did not travel, so asking the
   * artifact would report the field as carried — and today the two numbers are both `1`, so even
   * comparing the values would agree. The one fact worth reporting is that they count different
   * schemas, and only the code that did the copying knows which of them is in there.
   */
  const carried = new Set([...CONTRACT_REQUIRED_FIELDS,
    ...allowed.filter((field) => Object.prototype.hasOwnProperty.call(projection, field))]);

  for (const field of Object.keys(packet)) {
    if (carried.has(field)) continue;
    if (withheld.some((w) => w.field === field)) continue;
    withheld.push(TEAM_LAYER_ONLY_FIELDS.includes(field)
      ? { field, reason: 'team-layer-owned', capability: null,
        detail: field === 'schemaVersion'
          ? `both layers have a schemaVersion and they count different schemas; the artifact declares spec-suite's ${SPEC_TASK_SCHEMA_VERSION}`
          : 'this layer owns the field; spec-suite is not missing it', authority: 'team-layer' }
      : { field, reason: 'not-projectable', capability: null,
        detail: `spec-suite's task contract does not carry ${field}`, authority: 'team-layer' });
  }

  const capabilityWithheld = withheld.filter((w) => w.reason.startsWith('capability-'));
  const assumed = !detection.projectableFields.discovered;
  return {
    projection,
    // A digest of the projection alone, so the same packet against the same capabilities
    // yields the same artifact id and a re-projection is recognisable as a no-op (plan §9).
    // Deliberately not over the compatibility report: notes mention paths and versions,
    // and a digest that moved when the *reporting* changed would be no use for comparison.
    projectionDigest: jsonDigest(projection),
    /**
     * The packet fields that travelled — not the artifact's keys.
     *
     * They differ by exactly one: the artifact declares spec-suite's `schemaVersion`, which is
     * not a projection of anything. Reporting it here would claim the packet's version crossed
     * over, and it is also in `withheld` saying it did not. One field cannot be both, so
     * `projected` and `withheld` stay a partition of the *packet*, and `declared` says what the
     * artifact adds on its own authority.
     */
    projected: [...carried].sort(),
    declared: { schemaVersion: SPEC_TASK_SCHEMA_VERSION },
    withheld: withheld.sort((a, b) => a.field.localeCompare(b.field)),
    compatibility: {
      // `degraded` is a status, not a warning buried in prose: something the far side could
      // have carried stayed behind, and a caller may reasonably refuse to proceed on it.
      mode: capabilityWithheld.length ? 'degraded' : 'full',
      source: detection.source,
      fieldsDiscovered: !assumed,
      warnings: [
        ...capabilityWithheld.map((w) =>
          `${w.field} was not projected because ${w.capability} is ${w.reason === 'capability-unsupported' ? 'unsupported' : 'unknown'}: `
          + `it stays in the team layer, so staleness against it is only enforced here`),
        ...(assumed
          ? ['the projectable field list was assumed, not discovered: a field spec-suite has since added will not be projected']
          : []),
        ...(detection.source !== 'declared'
          ? ['no capability handshake was available, so no capability versions are known']
          : []),
      ],
    },
  };
}

import crypto from 'node:crypto';

import { stableJson } from './canonical-json.mjs';

/**
 * Digest helpers.
 *
 * INTEROP CONTRACT: `jsonDigest` must agree byte-for-byte with spec-suite's
 * `jsonDigest` in `scripts/control-plane-common.mjs`:
 *   `sha256:` + sha256(stableJson(value)) as lowercase hex.
 */

export class DigestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DigestError';
    this.code = code;
  }
}

/**
 * Reject values that `canonicalize` would silently mangle.
 *
 * `canonicalize` inherits two lossy behaviours from spec-suite: non-finite
 * numbers become `null`, and non-plain objects are flattened by `Object.keys`.
 * Silently hashing either would mean two different inputs share a digest, so
 * anything we hash is screened first. This is deliberately stricter than
 * `canonicalize` — it never changes the digest of a legal value.
 */
export function assertDigestible(value, at = '$') {
  const type = typeof value;
  if (value === null || type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new DigestError('NON_FINITE_NUMBER', `${at} is ${String(value)}; digest input must be a finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDigestible(item, `${at}[${index}]`));
    return value;
  }
  if (type !== 'object') {
    throw new DigestError('NOT_JSON', `${at} is ${type}; digest input must be JSON data`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new DigestError(
      'NOT_PLAIN_OBJECT',
      `${at} is a ${value.constructor?.name ?? 'non-plain'} instance; canonicalization would flatten it to {}`,
    );
  }
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      throw new DigestError('UNDEFINED_VALUE', `${at}.${key} is undefined; omit the key instead`);
    }
    assertDigestible(value[key], `${at}.${key}`);
  }
  return value;
}

export function contentDigest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function jsonDigest(value) {
  assertDigestible(value);
  return contentDigest(stableJson(value));
}

const GENERIC_REVISION_SOURCE = '[a-z][a-z0-9-]*:[A-Za-z0-9._-]+';
const KNOWN_REVISION_SOURCES = {
  sha256: '[0-9a-f]{64}',
  git: '[0-9a-fA-F]{7,64}',
};

const REVISION = new RegExp(`^${GENERIC_REVISION_SOURCE}$`);
const KNOWN_REVISION_SHAPES = Object.fromEntries(
  Object.entries(KNOWN_REVISION_SOURCES).map(([scheme, source]) => [scheme, new RegExp(`^${source}$`)]),
);

/**
 * The single pattern that accepts exactly what `assertRevision` accepts.
 *
 * `schemas/revision.schema.json` is generated from this by
 * `scripts/gen-derived.mjs`, because a schema that accepts a token the code
 * then rejects is the same silent under-validation `src/schema.mjs` exists to
 * prevent: the artifact would pass its schema and fail closed later, at digest
 * time, far from the field that caused it.
 *
 * The negative lookahead is what makes it exact — without it a malformed
 * `sha256:` token would fall through to the permissive generic branch.
 */
export const REVISION_PATTERN = `^(?:${
  Object.entries(KNOWN_REVISION_SOURCES).map(([scheme, source]) => `${scheme}:${source}`).join('|')
}|(?!(?:${Object.keys(KNOWN_REVISION_SOURCES).join('|')}):)${GENERIC_REVISION_SOURCE})$`;

/** `sha256:<64 hex>` — the shape every digest in this repository takes. */
export const DIGEST_PATTERN = `^sha256:${KNOWN_REVISION_SOURCES.sha256}$`;

/**
 * `git:<7-64 hex>` — a Git object name.
 *
 * Deliberately identical to spec-suite's `REVISION_RE`, so the two layers agree
 * on which strings name a commit.
 */
export const GIT_REVISION_PATTERN = `^git:${KNOWN_REVISION_SOURCES.git}$`;

/** Validate a revision token: `<scheme>:<opaque>`, with extra rigor for known schemes. */
export function assertRevision(revision, label = 'revision') {
  if (typeof revision !== 'string' || !REVISION.test(revision)) {
    throw new DigestError(
      'MALFORMED_REVISION',
      `${label} must look like "<scheme>:<value>" (e.g. "sha256:<64 hex>"), got ${JSON.stringify(revision)}`,
    );
  }
  const separator = revision.indexOf(':');
  const scheme = revision.slice(0, separator);
  const body = revision.slice(separator + 1);
  const shape = KNOWN_REVISION_SHAPES[scheme];
  if (shape && !shape.test(body)) {
    throw new DigestError('MALFORMED_REVISION', `${label} is not a valid ${scheme} revision: ${JSON.stringify(revision)}`);
  }
  return revision;
}

/**
 * Normalize a semantic input set into the exact form that gets hashed.
 *
 * Contract (plan §2), locked by `fixtures/input-snapshot-vectors.json`:
 * - only `id` and `revision` are hashed; `authority` and any resolution
 *   metadata are deliberately excluded, so re-labelling where a revision came
 *   from does not move the digest;
 * - entries are sorted by `id` using code-unit order (never `localeCompare`,
 *   which is locale-dependent), so declaration order does not matter;
 * - a duplicate `id` is a malformed dependency set and fails closed, even when
 *   both entries agree on the revision.
 */
export function normalizeInputs(inputs, label = 'inputs') {
  if (!Array.isArray(inputs)) {
    throw new DigestError('MALFORMED_INPUTS', `${label} must be an array`);
  }
  const seen = new Map();
  const normalized = inputs.map((entry, index) => {
    const at = `${label}[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DigestError('MALFORMED_INPUTS', `${at} must be an object`);
    }
    const { id, revision } = entry;
    if (typeof id !== 'string' || id.trim() !== id || id === '') {
      throw new DigestError('MALFORMED_INPUTS', `${at}.id must be a non-empty string without surrounding whitespace`);
    }
    assertRevision(revision, `${at}.revision`);
    if (seen.has(id)) {
      throw new DigestError(
        'DUPLICATE_INPUT',
        `${label} declares ${JSON.stringify(id)} twice (indexes ${seen.get(id)} and ${index}); a semantic input must have exactly one revision`,
      );
    }
    seen.set(id, index);
    return { id, revision };
  });
  normalized.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return normalized;
}

/**
 * `inputSnapshotDigest` — the identity of a frozen semantic input set.
 *
 * An empty input set is legal and still produces a stable digest, so a task
 * that genuinely depends on nothing is distinguishable from a task whose
 * dependencies were never declared (that one has no digest at all).
 */
export function inputSnapshotDigest(inputs, label = 'inputs') {
  return jsonDigest({ inputs: normalizeInputs(inputs, label) });
}

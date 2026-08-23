// Canonical JSON serialization.
//
// INTEROP CONTRACT: this must stay byte-identical to spec-suite's
// `src/shared/canonical-json.mjs`. Both repos hash the output of `stableJson`
// to derive `inputSnapshotDigest`; if the two implementations disagree on a
// single byte, the same semantic input set produces two different digests and
// every cross-layer staleness check silently becomes wrong.
//
// Do not "improve" this file. Changes must be mirrored in spec-suite and are
// locked by `fixtures/input-snapshot-vectors.json`.
//
// Known non-guarantees (inherited deliberately, not bugs to fix here):
// - `NaN`/`Infinity` survive canonicalize() and become `null` in JSON.stringify.
// - `Date`/`Map`/`Set`/class instances are flattened by `Object.keys`
//   (`new Date()` canonicalizes to `{}`).
// Callers that hash untrusted values must reject those shapes themselves;
// see `assertDigestible` in `src/digest.mjs`.

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (!value || typeof value !== 'object') throw new Error(`value is not JSON-serializable: ${typeof value}`);
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

/** Serialize after canonicalizing. `space` defaults to 0 — digests use the compact form. */
export function stableJson(value, space = 0) {
  return JSON.stringify(canonicalize(value), null, space);
}

/**
 * Filesystem-safe names for scheme-prefixed ids.
 *
 * Session and task ids are written as `feature:coupon` / `task:coupon` — the
 * `<scheme>:<name>` convention the plan uses throughout. `:` is illegal in a
 * Windows filename, so an id can never be a path segment directly.
 *
 * The mapping is deliberately *not* a hash: a human debugging a ledger has to
 * be able to look at `.git/team-layer/sessions/feature__coupon/` and know which
 * session it is. It is also injective, which matters more than it looks — if
 * two distinct ids could collapse onto one directory, two sessions would share
 * a ledger and silently overwrite each other's state.
 *
 * Injectivity comes from restricting ids rather than from escaping: `_` is not
 * a legal id character, so `__` cannot appear in an id and can safely mean
 * "there was a `:` here".
 */

export class SlugError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SlugError';
    this.code = code;
  }
}

/** `<scheme>:<name>`, or a bare `<name>`. Lowercase, no `_`, no `.`, no `..`. */
export const ID_PATTERN = '^(?:[a-z][a-z0-9-]*:)?[a-z0-9][a-z0-9-]*$';
export const MAX_ID_LENGTH = 120;

const ID = new RegExp(ID_PATTERN);

/**
 * Validate an id used as a ledger key.
 *
 * Rejecting `.` outright is what makes path traversal structurally impossible
 * rather than filtered-for: there is no `..` to sneak through, in any encoding.
 */
export function assertId(id, label = 'id') {
  if (typeof id !== 'string') {
    throw new SlugError('MALFORMED_ID', `${label} must be a string, got ${typeof id}`);
  }
  if (id.length > MAX_ID_LENGTH) {
    throw new SlugError('MALFORMED_ID', `${label} must be at most ${MAX_ID_LENGTH} characters`);
  }
  if (!ID.test(id)) {
    throw new SlugError(
      'MALFORMED_ID',
      `${label} must look like "scheme:name" using lowercase letters, digits and hyphens, got ${JSON.stringify(id)}`,
    );
  }
  return id;
}

/** Map an id to one path segment. Injective: distinct ids give distinct slugs. */
export function slug(id, label = 'id') {
  assertId(id, label);
  return id.replace(':', '__');
}

/** Recover the id a slug came from. `unslug(slug(x)) === x` for every legal x. */
export function unslug(segment) {
  if (typeof segment !== 'string' || !/^[a-z0-9-]+(?:__[a-z0-9-]+)?$/.test(segment)) {
    throw new SlugError('MALFORMED_SLUG', `${JSON.stringify(segment)} is not a slug this layer produced`);
  }
  const id = segment.replace('__', ':');
  assertId(id, 'slug');
  return id;
}

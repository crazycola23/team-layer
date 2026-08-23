import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { contentDigest } from './digest.mjs';

/**
 * The role registry is the single authority for which roles exist (plan §11).
 *
 * Before this module, the role list was duplicated in four places: `teamctl`'s
 * `ROLES` set, `identity.schema.json`'s enum, `task-packet.schema.json`'s enum,
 * and the role manuals' own frontmatter. Splitting `fullstack` into
 * `frontend` + `backend` meant editing four lists and hoping none was missed.
 * Now `roles/registry.json` is edited and everything else is derived from it —
 * schema enums via `scripts/gen-derived.mjs`, the CLI and validator at runtime.
 */

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY_PATH = path.join(SKILL_ROOT, 'roles', 'registry.json');

export class RoleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RoleError';
    this.code = code;
  }
}

const ROLE_ID = /^[a-z][a-z0-9-]{1,39}$/;

let cached;

export function loadRegistry({ reload = false } = {}) {
  if (cached && !reload) return cached;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  } catch (error) {
    throw new RoleError('REGISTRY_UNREADABLE', `${REGISTRY_PATH} is missing or invalid JSON: ${error.message}`);
  }
  if (raw?.schemaVersion !== 1) {
    throw new RoleError('REGISTRY_VERSION', `role registry schemaVersion must be 1, got ${JSON.stringify(raw?.schemaVersion)}`);
  }
  if (!Array.isArray(raw.roles) || raw.roles.length === 0) {
    throw new RoleError('REGISTRY_EMPTY', 'role registry must declare a non-empty roles array');
  }

  const seen = new Set();
  const roles = raw.roles.map((entry, index) => {
    const at = `roles[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new RoleError('REGISTRY_ENTRY', `${at} must be an object`);
    }
    const extra = Object.keys(entry).filter((key) => key !== 'id' && key !== 'file');
    if (extra.length) {
      throw new RoleError('REGISTRY_ENTRY', `${at} has unknown keys: ${extra.join(', ')}`);
    }
    if (typeof entry.id !== 'string' || !ROLE_ID.test(entry.id)) {
      throw new RoleError('REGISTRY_ENTRY', `${at}.id must be 2-40 lowercase letters/digits/hyphens, got ${JSON.stringify(entry.id)}`);
    }
    if (seen.has(entry.id)) {
      throw new RoleError('REGISTRY_DUPLICATE', `role ${JSON.stringify(entry.id)} is declared twice`);
    }
    seen.add(entry.id);
    if (typeof entry.file !== 'string' || !entry.file.startsWith('roles/') || entry.file.includes('..')) {
      throw new RoleError('REGISTRY_ENTRY', `${at}.file must be a repo-relative path under roles/, got ${JSON.stringify(entry.file)}`);
    }
    return { id: entry.id, file: entry.file, path: path.join(SKILL_ROOT, entry.file) };
  });

  // Sorted for deterministic derived output; the file itself may list any order.
  const ids = roles.map((role) => role.id).sort();
  cached = { roles, ids, byId: new Map(roles.map((role) => [role.id, role])) };
  return cached;
}

export function roleIds() {
  return loadRegistry().ids;
}

export function isRole(role) {
  return loadRegistry().byId.has(role);
}

export function assertRole(role) {
  if (!isRole(role)) {
    throw new RoleError('UNKNOWN_ROLE', `unsupported role ${JSON.stringify(role)}; expected ${roleIds().join(', ')}`);
  }
  return role;
}

export function roleFile(role) {
  return loadRegistry().byId.get(assertRole(role)).path;
}

/** Read the `version:` frontmatter of a role manual. */
export function roleVersion(role) {
  const file = roleFile(role);
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^version:\s*([^\s]+)\s*$/m);
  if (!match) throw new RoleError('ROLE_VERSION_MISSING', `role ${role} has no version frontmatter in ${file}`);
  return match[1];
}

/**
 * Digest of the registry's semantic content.
 *
 * `gen-derived.mjs` stamps this into generated schemas so a stale generated
 * file is detectable instead of merely wrong.
 */
export function registryDigest() {
  return contentDigest(JSON.stringify({ roles: roleIds() }));
}

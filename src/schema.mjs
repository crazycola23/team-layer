import fs from 'node:fs';
import path from 'node:path';

/**
 * A very small JSON Schema subset validator.
 *
 * Both team-layer and spec-suite ship zero npm dependencies, so there is no Ajv
 * here. The risk with a hand-rolled validator is the opposite of the usual one:
 * not that it rejects valid data, but that it *accepts* invalid data because it
 * quietly ignored a keyword it does not implement. A schema author writes
 * `"format": "date-time"`, nothing enforces it, and the artifact is trusted
 * anyway.
 *
 * So this validator fails closed on the schema, not just on the instance: any
 * keyword outside `KEYWORDS` throws at load time. Adding a keyword to a schema
 * therefore forces you to implement it here. Unsupported constraints must be
 * expressed with `pattern` instead.
 *
 * `pattern` is an ECMAScript regex (not the JSON Schema dialect) and is NOT
 * implicitly anchored — write `^...$` yourself.
 */

const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples', 'default', 'x-generated-from']);
const KEYWORDS = new Set([
  ...ANNOTATIONS,
  '$ref', '$defs',
  'type', 'enum', 'const',
  'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum',
  'oneOf', 'anyOf',
]);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

export class SchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
    this.code = 'INVALID_SCHEMA';
  }
}

export class ValidationError extends Error {
  constructor(label, errors) {
    super(`${label} failed schema validation:\n${errors.map((e) => `- ${e.path}: ${e.message}`).join('\n')}`);
    this.name = 'ValidationError';
    this.code = 'SCHEMA_VALIDATION_FAILED';
    this.errors = errors;
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function assertSchemaShape(schema, at) {
  if (schema === true || schema === false) return;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new SchemaError(`${at} must be an object or boolean`);
  }
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) {
      throw new SchemaError(
        `${at} uses unsupported keyword ${JSON.stringify(key)}; ` +
        'implement it in src/schema.mjs or express the constraint with a supported keyword',
      );
    }
  }
  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const type of types) {
      if (!TYPES.has(type)) throw new SchemaError(`${at}.type has unknown type ${JSON.stringify(type)}`);
    }
  }
  if ('pattern' in schema) {
    try {
      new RegExp(schema.pattern);
    } catch (error) {
      throw new SchemaError(`${at}.pattern is not a valid regex: ${error.message}`);
    }
  }
  if ('required' in schema && !Array.isArray(schema.required)) {
    throw new SchemaError(`${at}.required must be an array`);
  }
  if ('enum' in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new SchemaError(`${at}.enum must be a non-empty array`);
  }
  for (const key of ['properties', '$defs']) {
    if (key in schema) {
      if (schema[key] === null || typeof schema[key] !== 'object' || Array.isArray(schema[key])) {
        throw new SchemaError(`${at}.${key} must be an object`);
      }
      for (const [name, sub] of Object.entries(schema[key])) assertSchemaShape(sub, `${at}.${key}.${name}`);
    }
  }
  for (const key of ['items', 'additionalProperties']) {
    if (key in schema && typeof schema[key] === 'object') assertSchemaShape(schema[key], `${at}.${key}`);
  }
  for (const key of ['oneOf', 'anyOf']) {
    if (key in schema) {
      if (!Array.isArray(schema[key]) || schema[key].length === 0) {
        throw new SchemaError(`${at}.${key} must be a non-empty array`);
      }
      schema[key].forEach((sub, index) => assertSchemaShape(sub, `${at}.${key}[${index}]`));
    }
  }
}

/**
 * Resolve `$ref`. Supported forms only:
 *   `#/$defs/<name>`            — within the same document
 *   `<file>.json`               — sibling file, whole document
 *   `<file>.json#/$defs/<name>` — sibling file, one definition
 * Anything else throws rather than resolving to `{}` (which would validate
 * everything).
 */
function resolveRef(ref, ctx) {
  const [target, pointer] = ref.split('#');
  let root = ctx.root;
  let dir = ctx.dir;
  if (target) {
    if (!target.endsWith('.json') || target.includes('..') || path.isAbsolute(target)) {
      throw new SchemaError(`$ref ${JSON.stringify(ref)} must be a sibling .json file or a local #/$defs/ pointer`);
    }
    const file = path.join(ctx.dir, target);
    if (!ctx.cache.has(file)) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        throw new SchemaError(`$ref ${JSON.stringify(ref)} could not be loaded: ${error.message}`);
      }
      assertSchemaShape(parsed, path.basename(file));
      ctx.cache.set(file, parsed);
    }
    root = ctx.cache.get(file);
    dir = path.dirname(file);
  }
  let schema = root;
  if (pointer) {
    if (!pointer.startsWith('/$defs/')) {
      throw new SchemaError(`$ref ${JSON.stringify(ref)} pointer must start with #/$defs/`);
    }
    const name = pointer.slice('/$defs/'.length);
    schema = root.$defs?.[name];
    if (!schema) throw new SchemaError(`$ref ${JSON.stringify(ref)} does not resolve to a definition`);
  }
  return { schema, ctx: { ...ctx, root, dir } };
}

function check(schema, value, at, ctx, errors) {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path: at, message: 'no value is allowed here' });
    return;
  }

  if ('$ref' in schema) {
    const resolved = resolveRef(schema.$ref, ctx);
    check(resolved.schema, value, at, resolved.ctx, errors);
    // Sibling keywords next to $ref are also applied (2019-09 semantics).
  }

  const actual = typeOf(value);
  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matched = types.some((type) => (type === 'integer'
      ? actual === 'number' && Number.isInteger(value)
      : type === actual));
    if (!matched) {
      errors.push({ path: at, message: `expected ${types.join(' or ')}, got ${actual}` });
      return; // Further keywords would produce noise about the wrong type.
    }
  }

  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push({ path: at, message: `must equal ${JSON.stringify(schema.const)}` });
  }
  if ('enum' in schema && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    errors.push({ path: at, message: `must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(', ')}` });
  }

  if (actual === 'string') {
    if ('minLength' in schema && value.length < schema.minLength) {
      errors.push({ path: at, message: `must be at least ${schema.minLength} characters` });
    }
    if ('maxLength' in schema && value.length > schema.maxLength) {
      errors.push({ path: at, message: `must be at most ${schema.maxLength} characters` });
    }
    if ('pattern' in schema && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path: at, message: `must match ${schema.pattern}` });
    }
  }

  if (actual === 'number') {
    if ('minimum' in schema && value < schema.minimum) {
      errors.push({ path: at, message: `must be >= ${schema.minimum}` });
    }
    if ('maximum' in schema && value > schema.maximum) {
      errors.push({ path: at, message: `must be <= ${schema.maximum}` });
    }
  }

  if (actual === 'array') {
    if ('minItems' in schema && value.length < schema.minItems) {
      errors.push({ path: at, message: `must have at least ${schema.minItems} items` });
    }
    if ('maxItems' in schema && value.length > schema.maxItems) {
      errors.push({ path: at, message: `must have at most ${schema.maxItems} items` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      value.forEach((item, index) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) errors.push({ path: `${at}[${index}]`, message: 'duplicates an earlier item' });
        seen.add(key);
      });
    }
    if ('items' in schema) {
      value.forEach((item, index) => check(schema.items, item, `${at}[${index}]`, ctx, errors));
    }
  }

  if (actual === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push({ path: `${at}.${key}`, message: 'is required' });
    }
    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) check(sub, value[key], `${at}.${key}`, ctx, errors);
    }
    if ('additionalProperties' in schema && schema.additionalProperties !== true) {
      for (const key of Object.keys(value)) {
        if (known.has(key)) continue;
        if (schema.additionalProperties === false) {
          errors.push({ path: `${at}.${key}`, message: 'is not an allowed property' });
        } else {
          check(schema.additionalProperties, value[key], `${at}.${key}`, ctx, errors);
        }
      }
    }
  }

  for (const key of ['oneOf', 'anyOf']) {
    if (!(key in schema)) continue;
    const branches = schema[key].map((sub) => {
      const branchErrors = [];
      check(sub, value, at, ctx, branchErrors);
      return branchErrors;
    });
    const passed = branches.filter((branchErrors) => branchErrors.length === 0).length;
    if (passed === 0) {
      const detail = branches
        .map((branchErrors, index) => `  [${index}] ${branchErrors.map((e) => `${e.path}: ${e.message}`).join('; ')}`)
        .join('\n');
      errors.push({ path: at, message: `does not match any allowed variant:\n${detail}` });
    } else if (key === 'oneOf' && passed > 1) {
      errors.push({ path: at, message: `matches ${passed} variants but must match exactly one` });
    }
  }
}

/** Load a schema file, verifying every keyword it uses is actually enforced. */
export function loadSchema(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new SchemaError(`${file} is missing or invalid JSON: ${error.message}`);
  }
  assertSchemaShape(parsed, path.basename(file));
  return { schema: parsed, dir: path.dirname(file), file };
}

/** @returns {{path: string, message: string}[]} empty when valid. */
export function validate(loaded, value, at = '$') {
  const errors = [];
  const ctx = { root: loaded.schema, dir: loaded.dir, cache: new Map() };
  check(loaded.schema, value, at, ctx, errors);
  return errors;
}

export function assertValid(loaded, value, label = path.basename(loaded.file ?? 'value')) {
  const errors = validate(loaded, value);
  if (errors.length) throw new ValidationError(label, errors);
  return value;
}

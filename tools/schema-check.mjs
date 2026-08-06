// A small JSON Schema checker, for the one job this repo has: proving that
// `schema/*.json` still describes `packs/*`.
//
// WHY NOT A REAL VALIDATOR. The design doc calls the schemas normative (§11) and
// the packLoader's header says packs "are already schema-validated offline" —
// and until this file existed, nothing in the repo read a schema at all. Both
// statements were aspirations. The cheapest way to make them true is the one
// that adds no dependency and no install step: the schemas here use a small,
// closed subset of the vocabulary, so the checker only has to cover that subset.
//
// Deliberately NOT a general implementation — it supports exactly the keywords
// `schema/manifest.schema.json`, `schema/deck.schema.json` and
// `schema/rules-test.schema.json` actually use, and it THROWS on a keyword it
// does not know rather than ignoring it. An unimplemented keyword that silently
// passes is worse than no validator: it is a gate that reports green on rules it
// never checked. If a schema grows a new keyword, this file must grow with it,
// and the throw is what makes that unmissable.
//
// Node-only (it is a tool, not engine code — §17.10 keeps src/ browser-clean).

const KNOWN = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description', 'default',
  'type', 'enum', 'const',
  'properties', 'required', 'additionalProperties', 'propertyNames', 'minProperties', 'maxProperties',
  'items', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum',
  'oneOf', 'anyOf', 'allOf', 'if', 'then', 'else',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value; // 'number' | 'string' | 'boolean' | 'object'
}

function typeMatches(value, want) {
  const actual = typeOf(value);
  if (want === 'number') return actual === 'number' || actual === 'integer';
  return actual === want;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => deepEqual(a[k], b[k]));
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`schema-check: only local $refs are supported, got "${ref}"`);
  let node = root;
  for (const seg of ref.slice(2).split('/')) {
    node = node?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (node === undefined) throw new Error(`schema-check: unresolvable $ref "${ref}"`);
  }
  return node;
}

/**
 * @returns string[] — one message per violation, empty when the instance validates.
 */
export function validate(instance, schema, { root = schema, path = '' } = {}) {
  const where = path || '(root)';
  if (schema === true) return [];
  if (schema === false) return [`${where}: nothing is allowed here`];

  for (const key of Object.keys(schema)) {
    if (!KNOWN.has(key)) {
      throw new Error(`schema-check: unsupported schema keyword "${key}" at ${where} — teach tools/schema-check.mjs about it`);
    }
  }

  if (schema.$ref) return validate(instance, resolveRef(schema.$ref, root), { root, path });

  const errors = [];

  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wanted.some((t) => typeMatches(instance, t))) {
      errors.push(`${where}: expected ${wanted.join(' or ')}, got ${typeOf(instance)}`);
      return errors; // every check below assumes the type held
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((v) => deepEqual(v, instance))) {
    errors.push(`${where}: ${JSON.stringify(instance)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.const !== undefined && !deepEqual(schema.const, instance)) {
    errors.push(`${where}: expected ${JSON.stringify(schema.const)}`);
  }

  const kind = typeOf(instance);

  if (kind === 'string') {
    if (schema.minLength !== undefined && instance.length < schema.minLength) {
      errors.push(`${where}: shorter than ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && instance.length > schema.maxLength) {
      errors.push(`${where}: longer than ${schema.maxLength} (${instance.length})`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(instance)) {
      errors.push(`${where}: ${JSON.stringify(instance)} does not match /${schema.pattern}/`);
    }
  }

  if (kind === 'number' || kind === 'integer') {
    if (schema.minimum !== undefined && instance < schema.minimum) errors.push(`${where}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && instance > schema.maximum) errors.push(`${where}: above maximum ${schema.maximum}`);
  }

  if (kind === 'array') {
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      errors.push(`${where}: needs at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && instance.length > schema.maxItems) {
      errors.push(`${where}: allows at most ${schema.maxItems} items`);
    }
    if (schema.items !== undefined) {
      instance.forEach((item, i) => errors.push(...validate(item, schema.items, { root, path: `${where}[${i}]` })));
    }
  }

  if (kind === 'object') {
    const keys = Object.keys(instance);
    for (const key of schema.required || []) {
      if (!Object.hasOwn(instance, key)) errors.push(`${where}: missing required property "${key}"`);
    }
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      errors.push(`${where}: needs at least ${schema.minProperties} propert${schema.minProperties === 1 ? 'y' : 'ies'}`);
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      errors.push(`${where}: allows at most ${schema.maxProperties} properties`);
    }
    for (const key of keys) {
      const child = `${where}.${key}`;
      if (schema.propertyNames !== undefined) {
        errors.push(...validate(key, schema.propertyNames, { root, path: `${where} key "${key}"` }));
      }
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        errors.push(...validate(instance[key], schema.properties[key], { root, path: child }));
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push(`${where}: unknown property "${key}"`);
      } else if (schema.additionalProperties !== undefined) {
        errors.push(...validate(instance[key], schema.additionalProperties, { root, path: child }));
      }
    }
  }

  if (schema.allOf) {
    for (const sub of schema.allOf) errors.push(...validate(instance, sub, { root, path }));
  }
  if (schema.anyOf && !schema.anyOf.some((sub) => validate(instance, sub, { root, path }).length === 0)) {
    errors.push(`${where}: matches none of the allowed shapes`);
  }
  if (schema.oneOf) {
    const matched = schema.oneOf.filter((sub) => validate(instance, sub, { root, path }).length === 0);
    if (matched.length !== 1) {
      errors.push(`${where}: matches ${matched.length} of the ${schema.oneOf.length} allowed shapes, expected exactly 1`);
    }
  }
  if (schema.if) {
    const taken = validate(instance, schema.if, { root, path }).length === 0 ? schema.then : schema.else;
    if (taken) errors.push(...validate(instance, taken, { root, path }));
  }

  return errors;
}

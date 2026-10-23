// Attribute keys per site category (config/attribute-schemas.json) and the JSON schema Claude's answer must follow.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SITE_CATEGORIES } from '../site/categories.js';

export type AttrSpec = {
  type: 'text' | 'enum' | 'number';
  /** enum: the allowed values (a shared list is resolved into this) */
  values?: string[];
  /** number: the fixed unit the value is in */
  unit?: string;
  min?: number;
  max?: number;
  /** the value is a list (every colour or size the group's variants come in) */
  multi?: boolean;
  meaning: string;
};

export type CategorySchema = Record<string, AttrSpec>;
export type AttributeSchemas = Record<string, CategorySchema>;

export const SCHEMA_FILE = path.resolve('config/attribute-schemas.json');

/** The entry of a category that lists its identity specs (src/site/identity.ts); never an attribute key. */
export const IDENTITY_KEY = 'identity';
/** The entry of a category that lists its canonical name fields (src/names/canonical.ts); never an attribute key. */
export const CANONICAL_KEY = 'canonical';

type RawSpec = Omit<AttrSpec, 'values'> & { values?: string[]; list?: string };
type RawFile = { lists?: Record<string, string[]>; shared?: Record<string, RawSpec>; categories?: Record<string, Record<string, RawSpec>> };

/**
 * Resolves shared lists and checks the file: every site category present, every spec complete. The shared attributes
 * (line, condition, audience, pack count, ...: the canonical name fields of every category) follow each category's
 * own keys, unless the category defines the key itself.
 */
export function parseAttributeSchemas(raw: unknown): AttributeSchemas {
  const file = raw as RawFile;
  const lists = file.lists ?? {};
  const out: AttributeSchemas = {};
  for (const { slug } of SITE_CATEGORIES) {
    const cat = file.categories?.[slug];
    if (!cat) throw new Error(`attribute schemas: no entry for category ${slug}`);
    const schema: CategorySchema = {};
    const shared = Object.entries(file.shared ?? {}).filter(([k]) => !Object.hasOwn(cat, k));
    for (const [key, spec] of [...Object.entries(cat), ...shared]) {
      // the key specs shown after a name (src/site/identity.ts) and the canonical name fields: not attributes
      if (key === IDENTITY_KEY || key === CANONICAL_KEY) continue;
      if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error(`attribute schemas: bad key ${slug}.${key}`);
      if (!spec.meaning) throw new Error(`attribute schemas: ${slug}.${key} has no meaning`);
      const resolved: AttrSpec = { type: spec.type, meaning: spec.meaning };
      if (spec.multi) resolved.multi = true;
      if (spec.type === 'enum') {
        const values = spec.list !== undefined ? lists[spec.list] : spec.values;
        if (!values || values.length === 0) throw new Error(`attribute schemas: ${slug}.${key} has no values`);
        resolved.values = values;
      } else if (spec.type === 'number') {
        if (!spec.unit || typeof spec.min !== 'number' || typeof spec.max !== 'number') {
          throw new Error(`attribute schemas: ${slug}.${key} needs unit, min and max`);
        }
        Object.assign(resolved, { unit: spec.unit, min: spec.min, max: spec.max });
      } else if (spec.type !== 'text') {
        throw new Error(`attribute schemas: ${slug}.${key} has unknown type ${String(spec.type)}`);
      }
      schema[key] = resolved;
    }
    out[slug] = schema;
  }
  return out;
}

export async function loadAttributeSchemas(file = SCHEMA_FILE): Promise<AttributeSchemas> {
  return parseAttributeSchemas(JSON.parse(await readFile(file, 'utf8')));
}

function valueSchema(spec: AttrSpec): object {
  if (spec.type === 'number') return { type: 'number' };
  if (spec.type === 'enum') return { type: 'string', enum: spec.values };
  return { type: 'string' };
}

/** JSON schema for one batch answer of a category: { items: [{ key, display_name, variant_label, canonical_name, attrs }] }. */
export function answerJsonSchema(schema: CategorySchema): object {
  const attrProps: Record<string, object> = {};
  for (const [key, spec] of Object.entries(schema)) {
    attrProps[key] = spec.multi ? { type: 'array', items: valueSchema(spec) } : valueSchema(spec);
  }
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            display_name: { type: 'string' },
            variant_label: { type: ['string', 'null'] },
            canonical_name: { type: ['string', 'null'] },
            attrs: { type: 'object', properties: attrProps, additionalProperties: false },
          },
          required: ['key', 'display_name', 'variant_label', 'canonical_name', 'attrs'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  };
}

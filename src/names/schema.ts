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

type RawSpec = Omit<AttrSpec, 'values'> & { values?: string[]; list?: string };
type RawFile = { lists?: Record<string, string[]>; categories?: Record<string, Record<string, RawSpec>> };

/** Resolves shared lists and checks the file: every site category present, every spec complete. */
export function parseAttributeSchemas(raw: unknown): AttributeSchemas {
  const file = raw as RawFile;
  const lists = file.lists ?? {};
  const out: AttributeSchemas = {};
  for (const { slug } of SITE_CATEGORIES) {
    const cat = file.categories?.[slug];
    if (!cat) throw new Error(`attribute schemas: no entry for category ${slug}`);
    const schema: CategorySchema = {};
    for (const [key, spec] of Object.entries(cat)) {
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

/** JSON schema for one batch answer of a category: { items: [{ key, display_name, variant_label, attrs }] }. */
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
            attrs: { type: 'object', properties: attrProps, additionalProperties: false },
          },
          required: ['key', 'display_name', 'variant_label', 'attrs'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  };
}

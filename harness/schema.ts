// JSON Schema validation for the files in schemas/.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { Problem } from './problems.ts';

export const ROOT = join(import.meta.dirname, '..');

export type SchemaName = 'assertions' | 'manifest' | 'deviations' | 'results';

// ajv-formats is CommonJS; its default export arrives wrapped under nodenext.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

let ajv: Ajv2020 | undefined;
const compiled = new Map<SchemaName, ValidateFunction>();

function instance(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
  addFormats(ajv);
  for (const name of ['deviations', 'assertions', 'manifest', 'results'] as const) {
    const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', `${name}.schema.json`), 'utf8'));
    ajv.addSchema(schema, `${name}.schema.json`);
  }
  return ajv;
}

function validator(name: SchemaName): ValidateFunction {
  let v = compiled.get(name);
  if (!v) {
    v = instance().getSchema(`${name}.schema.json`);
    if (!v) throw new Error(`schema ${name} not found`);
    compiled.set(name, v);
  }
  return v;
}

/** Validate `data` against a schema; returns one Problem per schema error. */
export function checkSchema(name: SchemaName, data: unknown, file: string): Problem[] {
  const v = validator(name);
  if (v(data)) return [];
  return (v.errors ?? []).map((e: ErrorObject) => ({
    file,
    where: e.instancePath || '/',
    message: `${e.message}${e.params && Object.keys(e.params).length ? ` ${JSON.stringify(e.params)}` : ''}`,
  }));
}

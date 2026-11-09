// A small checker for docs/journeys/manifest.schema.json (no schema library is a dependency of the e2e package). It understands exactly what that file uses:
// type, enum, pattern, minimum, required, additionalProperties, properties, items and a local $ref.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../manifest.ts';

type Schema = {
  type?: string;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, Schema>;
  items?: Schema;
  $ref?: string;
};

const root = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'journeys', 'manifest.schema.json'), 'utf8')) as Schema & { $defs: Record<string, Schema> };

function check(value: unknown, schema: Schema, at: string, out: string[]): void {
  if (schema.$ref) return check(value, root.$defs[schema.$ref.replace('#/$defs/', '')]!, at, out);
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if (schema.type === 'string' && typeof value !== 'string') out.push(`${at}: not a string`);
  if (schema.type === 'integer' && !Number.isInteger(value)) out.push(`${at}: not an integer`);
  if (schema.type === 'array' && !Array.isArray(value)) out.push(`${at}: not an array`);
  if (schema.type === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) out.push(`${at}: not an object`);
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: below ${schema.minimum}`);
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => check(v, schema.items!, `${at}[${i}]`, out));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) out.push(`${at}: missing ${key}`);
    if (schema.additionalProperties === false) for (const key of Object.keys(object)) if (!(key in (schema.properties ?? {}))) out.push(`${at}: unexpected ${key}`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in object) check(object[key], sub, `${at}.${key}`, out);
  }
}

/** What is wrong with a manifest file's content (an array of entries) against the schema; empty: it conforms. */
export function manifestSchemaProblems(manifest: unknown): string[] {
  const out: string[] = [];
  check(manifest, root, 'manifest', out);
  return out;
}

import type { GetOneOrCreateInput } from '@manythreads/sdk';
import type pg from 'pg';
import type { Tx } from './with-actor.ts';

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`Unsafe SQL identifier "${name}"`);
  return `"${name}"`;
}

function qualified(name: string): string {
  return name.split('.').map(ident).join('.');
}

let doSelectSupported: boolean | undefined;

/**
 * Probes once per process whether `ON CONFLICT ... DO SELECT` parses (Postgres 19+). Runs inside a savepoint on a
 * temp table, so it leaves nothing behind and does not abort the surrounding transaction.
 */
export async function supportsDoSelect(tx: Tx): Promise<boolean> {
  if (doSelectSupported !== undefined) return doSelectSupported;
  await tx.query('SAVEPOINT manythreads_probe_do_select');
  try {
    await tx.query('CREATE TEMP TABLE manythreads_probe_do_select (k text PRIMARY KEY) ON COMMIT DROP');
    await tx.query('INSERT INTO manythreads_probe_do_select (k) VALUES ($1)', ['a']);
    await tx.query('INSERT INTO manythreads_probe_do_select (k) VALUES ($1) ON CONFLICT (k) DO SELECT RETURNING k', ['a']);
    doSelectSupported = true;
  } catch {
    doSelectSupported = false;
  } finally {
    await tx.query('ROLLBACK TO SAVEPOINT manythreads_probe_do_select');
    await tx.query('RELEASE SAVEPOINT manythreads_probe_do_select');
  }
  return doSelectSupported;
}

/** Test hook: forget the probe result. */
export function resetDoSelectProbe(): void {
  doSelectSupported = undefined;
}

export type { GetOneOrCreateInput };

/**
 * The one get-or-create: inserts the row, or returns the existing one for the conflict target, in a single
 * statement. Uses `DO SELECT` (no write on a hit); on servers without it, falls back to
 * `DO UPDATE SET <key> = EXCLUDED.<key>` chosen once by probing.
 */
export async function getOneOrCreate<R extends pg.QueryResultRow = pg.QueryResultRow>(
  tx: Tx,
  input: GetOneOrCreateInput,
): Promise<R> {
  const columns = Object.keys(input.values);
  if (columns.length === 0) throw new Error('getOneOrCreate needs at least one value');
  const key = input.conflict[0];
  if (!key) throw new Error('getOneOrCreate needs a conflict target');
  for (const c of input.conflict) {
    if (!columns.includes(c)) throw new Error(`Conflict column "${c}" is missing from values`);
  }
  const target = `(${input.conflict.map(ident).join(', ')})${input.conflictWhere ? ` WHERE ${input.conflictWhere}` : ''}`;
  const action = (await supportsDoSelect(tx))
    ? 'DO SELECT'
    : `DO UPDATE SET ${ident(key)} = EXCLUDED.${ident(key)}`;
  const returning = input.returning ? input.returning.map(ident).join(', ') : '*';
  const sql =
    `INSERT INTO ${qualified(input.table)} (${columns.map(ident).join(', ')}) ` +
    `VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) ` +
    `ON CONFLICT ${target} ${action} RETURNING ${returning}`;
  const result = await tx.query<R>(sql, Object.values(input.values));
  const row = result.rows[0];
  if (!row) throw new Error(`getOneOrCreate on ${input.table} returned no row`);
  return row;
}

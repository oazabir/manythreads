import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** A directory of numbered `.sql` files. The namespace makes ids unique across kernel and plugins. */
export interface MigrationSource {
  namespace: string;
  dir: string;
}

export interface MigrateOptions {
  /** Connection string for manythreads_owner (the role that owns the tables). */
  connectionString: string;
  /** Kernel first, then plugin directories in load order. Defaults to the kernel directory. */
  sources?: readonly MigrationSource[];
  /**
   * Password for the `manythreads_app` role, set with ALTER ROLE after the files run (skipped if the role does not
   * exist). `null` leaves it alone. Defaults to MANYTHREADS_APP_PASSWORD, then the dev default 'manythreads_app'.
   */
  appPassword?: string | null;
  /** Same for `manythreads_system`; defaults to MANYTHREADS_SYSTEM_PASSWORD, then the dev default 'manythreads_system'. */
  systemPassword?: string | null;
}

export interface MigrationFile {
  /** `namespace/NNNN_name.sql` */
  id: string;
  namespace: string;
  filename: string;
  path: string;
  checksum: string;
  sql: string;
}

export const kernelMigrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));
export const kernelMigrationSource: MigrationSource = { namespace: 'kernel', dir: kernelMigrationsDir };

export const DEFAULT_APP_PASSWORD = 'manythreads_app';
export const DEFAULT_SYSTEM_PASSWORD = 'manythreads_system';

/** Arbitrary constant; one lock per database serialises concurrent server starts. */
const ADVISORY_LOCK_KEY = 7_450_001;

const FILE_RE = /^(\d{4,})_[a-z0-9][a-z0-9_]*\.sql$/;
const NAMESPACE_RE = /^[a-z][a-z0-9_-]*$/;

export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/** Reads, validates and orders every migration file. Throws on down files, bad names, duplicate numbers. */
export async function readMigrationFiles(sources: readonly MigrationSource[]): Promise<MigrationFile[]> {
  const out: MigrationFile[] = [];
  const namespaces = new Set<string>();
  for (const { namespace, dir } of sources) {
    if (!NAMESPACE_RE.test(namespace)) throw new Error(`Invalid migration namespace "${namespace}"`);
    if (namespaces.has(namespace)) throw new Error(`Duplicate migration namespace "${namespace}"`);
    namespaces.add(namespace);

    const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
    const numbers = new Map<string, string>();
    for (const filename of names) {
      const id = `${namespace}/${filename}`;
      if (/down/i.test(filename)) {
        throw new Error(`Migration ${id} looks like a down migration; migrations are forward-only`);
      }
      const match = FILE_RE.exec(filename);
      if (!match?.[1]) throw new Error(`Migration ${id} must be named NNNN_name.sql (lowercase)`);
      const number = String(Number(match[1]));
      const clash = numbers.get(number);
      if (clash) throw new Error(`Migrations ${namespace}/${clash} and ${id} share the number ${match[1]}`);
      numbers.set(number, filename);

      const path = join(dir, filename);
      const bytes = await readFile(path);
      out.push({ id, namespace, filename, path, checksum: sha256(bytes), sql: bytes.toString('utf8') });
    }
  }
  return out;
}

/**
 * Applies pending migration files, each in its own transaction, under a Postgres advisory lock.
 * Returns the number of files applied. Throws, naming the file, if an applied file has been edited.
 */
export async function runMigrations(options: MigrateOptions): Promise<number> {
  const sources = options.sources ?? [kernelMigrationSource];
  const files = await readMigrationFiles(sources);
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      await client.query('CREATE SCHEMA IF NOT EXISTS app');
      await client.query(`CREATE TABLE IF NOT EXISTS app.schema_migrations (
        id text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const applied = new Map<string, string>();
      const rows = await client.query<{ id: string; checksum: string }>(
        'SELECT id, checksum FROM app.schema_migrations',
      );
      for (const row of rows.rows) applied.set(row.id, row.checksum);

      // Verify every known applied file first, so an edit stops the start before anything new runs.
      for (const file of files) {
        const recorded = applied.get(file.id);
        if (recorded !== undefined && recorded !== file.checksum) {
          throw new Error(
            `Migration ${file.id} was edited after it was applied (checksum changed); add a new migration instead`,
          );
        }
      }

      let count = 0;
      for (const file of files) {
        if (applied.has(file.id)) continue;
        await client.query('BEGIN');
        try {
          await client.query(file.sql);
          await client.query('INSERT INTO app.schema_migrations (id, checksum) VALUES ($1, $2)', [
            file.id,
            file.checksum,
          ]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`Migration ${file.id} failed: ${reason}`, { cause: err });
        }
        count += 1;
      }

      const setPassword = async (role: string, password: string | null): Promise<void> => {
        if (password === null) return;
        const alter = await client.query<{ sql: string }>(
          `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS sql
           WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1)`,
          [role, password],
        );
        const sql = alter.rows[0]?.sql;
        if (!sql) return;
        // Roles are cluster-wide; concurrent migrators on other databases can race
        // on pg_authid ("tuple concurrently updated", XX000). Retry with jitter.
        for (let attempt = 1; ; attempt += 1) {
          try {
            await client.query(sql);
            return;
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code !== 'XX000' || attempt >= 8) throw err;
            await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 50));
          }
        }
      };
      await setPassword(
        'manythreads_app',
        options.appPassword === undefined
          ? (process.env['MANYTHREADS_APP_PASSWORD'] ?? DEFAULT_APP_PASSWORD)
          : options.appPassword,
      );
      await setPassword(
        'manythreads_system',
        options.systemPassword === undefined
          ? (process.env['MANYTHREADS_SYSTEM_PASSWORD'] ?? DEFAULT_SYSTEM_PASSWORD)
          : options.systemPassword,
      );
      return count;
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    await client.end();
  }
}

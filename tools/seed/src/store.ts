import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ownerSql, testAdminUrl } from '../../../packages/test-utils/src/index.ts';

/** Where the tars of the repository and file folders are kept (`MANYTHREADS_SNAPSHOT_DIR`, else `~/.cache/manythreads/snapshots`). Outside the working tree: nothing here is committed. */
export function snapshotDir(): string {
  const dir = process.env['MANYTHREADS_SNAPSHOT_DIR'] ?? join(homedir(), '.cache', 'manythreads', 'snapshots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `mt_snap_<name>_<hash>`: the Postgres template database a snapshot lives in (a hyphen is not allowed in the name). */
export function snapshotDatabaseName(name: string, hash: string): string {
  return `mt_snap_${name.replace(/[^a-z0-9]/g, '_')}_${hash}`;
}

export const SNAPSHOT_DB_PATTERN = /^mt_snap_[a-z0-9_]+_[0-9a-f]{10}$/;

export interface SnapshotFiles {
  repos: string;
  blobs: string;
}

export function snapshotFiles(databaseName: string): SnapshotFiles {
  const dir = snapshotDir();
  return { repos: join(dir, `${databaseName}.repos.tar`), blobs: join(dir, `${databaseName}.blobs.tar`) };
}

/** True when the template database and both tars exist. */
export async function snapshotExists(databaseName: string): Promise<boolean> {
  const files = snapshotFiles(databaseName);
  if (!existsSync(files.repos) || !existsSync(files.blobs)) return false;
  const rows = await ownerSql<{ n: string }>(testAdminUrl(), 'SELECT count(*)::text AS n FROM pg_database WHERE datname = $1', [databaseName]);
  return rows[0]?.n === '1';
}

export interface StoredSnapshot {
  database: string;
  name: string;
  hash: string;
  bytes: number;
}

/** Every snapshot database on the cluster (current or stale). */
export async function listSnapshots(): Promise<StoredSnapshot[]> {
  const rows = await ownerSql<{ datname: string; bytes: string }>(
    testAdminUrl(),
    `SELECT datname, pg_database_size(datname)::text AS bytes FROM pg_database WHERE datname LIKE 'mt\\_snap\\_%' ORDER BY datname`,
  );
  return rows.flatMap((r) => {
    const m = /^mt_snap_(.+)_([0-9a-f]{10})$/.exec(r.datname);
    return m ? [{ database: r.datname, name: m[1]!.replace(/_/g, '-'), hash: m[2]!, bytes: Number(r.bytes) }] : [];
  });
}

/** Drops snapshot databases and tars that are not for `keepHash` (a stale snapshot is never restored; this frees its space). Returns the dropped database names. */
export async function pruneSnapshots(keepHash: string): Promise<string[]> {
  const dropped: string[] = [];
  for (const s of await listSnapshots()) {
    if (s.hash === keepHash) continue;
    await dropSnapshot(s.database);
    dropped.push(s.database);
  }
  // tars of a database that is gone
  const live = new Set((await listSnapshots()).map((s) => s.database));
  for (const file of readdirSync(snapshotDir())) {
    const m = /^(mt_snap_.+_[0-9a-f]{10})\.(repos|blobs)\.tar$/.exec(file);
    if (m && !live.has(m[1]!)) rmSync(join(snapshotDir(), file), { force: true });
  }
  return dropped;
}

export async function dropSnapshot(databaseName: string): Promise<void> {
  if (!SNAPSHOT_DB_PATTERN.test(databaseName)) throw new Error(`Refusing to drop ${databaseName}`);
  // a template database cannot be dropped until it stops being one
  await ownerSql(testAdminUrl(), `ALTER DATABASE "${databaseName}" IS_TEMPLATE false`).catch(() => undefined);
  await ownerSql(testAdminUrl(), `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  const files = snapshotFiles(databaseName);
  rmSync(files.repos, { force: true });
  rmSync(files.blobs, { force: true });
}

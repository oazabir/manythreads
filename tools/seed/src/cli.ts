// `pnpm --filter @manythreads/tools-seed snapshot <command>`
//   build <day-1|week-2|all> [--force]   run the seeds once and save the result (about 1-3 minutes); a current snapshot is left as it is without --force
//   restore <day-1|week-2>               restore it into a scratch database, print the time, drop the scratch database (the timing check: 10 s at most)
//   list                                 the snapshots on this database server, current or stale
//   prune                                drop the stale ones (their migrations or seeds changed)
//   hash                                 the hash of the migrations and seed sources a snapshot is made from
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase, dropTestDatabase } from '../../../packages/test-utils/src/index.ts';
import { buildSnapshot } from './build.ts';
import { SNAPSHOT_LIST, SNAPSHOT_NAMES, isSnapshotName } from './definitions.ts';
import { computeSnapshotHash } from './hash.ts';
import { restoreSnapshot } from './restore.ts';
import { listSnapshots, pruneSnapshots, snapshotDatabaseName, snapshotDir } from './store.ts';

const [, , command, ...rest] = process.argv;
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));
const say = (line: string): void => void process.stdout.write(`${line}\n`);

function names(): readonly string[] {
  const wanted = args[0];
  if (wanted === 'all') return SNAPSHOT_NAMES;
  if (!wanted || !isSnapshotName(wanted)) throw new Error(`name a snapshot: ${SNAPSHOT_LIST} (or "all")`);
  return [wanted];
}

async function main(): Promise<void> {
  switch (command) {
    case 'build': {
      for (const name of names()) {
        const r = await buildSnapshot(name, { force: flags.has('--force'), log: say });
        say(r.built ? `built ${name} -> ${r.database} in ${Math.round(r.millis / 1000)} s` : `${name} is current (${r.database}); use --force to build again`);
      }
      return;
    }
    case 'restore': {
      for (const name of names()) {
        const db = await createTestDatabase();
        const dir = mkdtempSync(join(tmpdir(), 'manythreads-restore-'));
        try {
          const r = await restoreSnapshot({ name, database: db, repoDir: join(dir, 'repos'), storageDir: join(dir, 'blobs'), autoBuild: false });
          say(`restored ${name} in ${r.millis} ms${r.millis > 10_000 ? '  (OVER the 10 s target)' : ''}`);
          process.exitCode = r.millis > 10_000 ? 1 : 0;
        } finally {
          rmSync(dir, { recursive: true, force: true });
          await dropTestDatabase(db).catch(() => undefined);
        }
      }
      return;
    }
    case 'list': {
      const hash = computeSnapshotHash();
      say(`current hash ${hash}; tars in ${snapshotDir()}`);
      for (const s of await listSnapshots()) say(`${s.hash === hash ? 'current' : 'stale  '}  ${s.database}  ${(s.bytes / 1e6).toFixed(1)} MB`);
      for (const n of SNAPSHOT_NAMES) if (!(await listSnapshots()).some((s) => s.database === snapshotDatabaseName(n, hash))) say(`missing  ${n}`);
      return;
    }
    case 'prune': {
      const dropped = await pruneSnapshots(computeSnapshotHash());
      say(dropped.length ? `dropped ${dropped.join(', ')}` : 'nothing stale');
      return;
    }
    case 'hash':
      say(computeSnapshotHash());
      return;
    default:
      throw new Error('usage: snapshot build <name|all> [--force] | restore <name> | list | prune | hash');
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);

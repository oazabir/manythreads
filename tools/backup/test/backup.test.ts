import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The backup tooling, tested without a cluster or a database: backup.sh against a stand-in psql/pg_dump and real tar/sha256sum, restore.sh and
 * drill.sh against a stand-in kubectl that records every call, and the chart's rendering with `helm template` (skipped where helm is absent).
 */
const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = resolve(here, '..');
const chartDir = resolve(here, '../../../deploy/helm/manythreads');
const backupScript = join(chartDir, 'files/backup.sh');

const SET = '20261029T021700Z';
const SUM_DB = 'a'.repeat(64);
const SUM_BLOBS = 'b'.repeat(64);
const SUM_REPOS = 'c'.repeat(64);
const MANIFEST = [
  `set=${SET}`,
  'created_at=2026-10-29T02:17:03Z',
  'namespace=manythreads',
  'app_version=abc1234',
  'databases=manythreads',
  'db.manythreads.owner=manythreads_owner',
  'rows_database=manythreads',
  'rows.messages=7',
  'rows.teams=7',
  'roles=manythreads_app manythreads_owner manythreads_system',
  'blobs=included',
  'repos=included',
  `file.db-manythreads.dump.sha256=${SUM_DB}`,
  `file.db-manythreads.settings.sql.sha256=${SUM_DB}`,
  `file.blobs.tar.sha256=${SUM_BLOBS}`,
  `file.repos.tar.sha256=${SUM_REPOS}`,
  'file.blobs.tar.bytes=2048',
  'file.repos.tar.bytes=1024',
  'complete=yes',
  '',
].join('\n');

let root: string;
let fakeBin: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mt-backup-test-'));
  fakeBin = join(root, 'bin');
  mkdirSync(fakeBin);
  copyFileSync(join(here, 'fake-kubectl'), join(fakeBin, 'kubectl'));
  chmodSync(join(fakeBin, 'kubectl'), 0o755);
  for (const name of ['psql', 'pg_dump']) {
    symlinkSync(join(here, 'fake-pg'), join(fakeBin, name));
  }
  mkdirSync(join(root, 'fixtures'));
  writeFileSync(join(root, 'fixtures/manifest.txt'), MANIFEST);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(cmd: string, args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`, ...env },
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

describe('files/backup.sh', () => {
  function setup(name: string): { dir: string; env: Record<string, string>; log: string } {
    const dir = join(root, name);
    mkdirSync(join(dir, 'backups'), { recursive: true });
    mkdirSync(join(dir, 'blobs/ab'), { recursive: true });
    mkdirSync(join(dir, 'blobs/.tmp'), { recursive: true });
    mkdirSync(join(dir, 'repos/team1.git'), { recursive: true });
    writeFileSync(join(dir, 'blobs/ab/abcdef'), 'attachment bytes');
    writeFileSync(join(dir, 'blobs/.tmp/partial'), 'half written');
    writeFileSync(join(dir, 'repos/team1.git/HEAD'), 'ref: refs/heads/main\n');
    const log = join(dir, 'calls.log');
    writeFileSync(log, '');
    return {
      dir,
      log,
      env: {
        FAKE_LOG: log,
        BACKUP_DIR: join(dir, 'backups'),
        BACKUP_BLOBS_DIR: join(dir, 'blobs'),
        BACKUP_REPOS_DIR: join(dir, 'repos'),
        BACKUP_DATABASES: 'manythreads hindsight',
        BACKUP_MAIN_DB: 'manythreads',
        BACKUP_RETENTION: '2',
        BACKUP_APP_VERSION: 'abc1234',
        BACKUP_NAMESPACE: 'manythreads',
      },
    };
  }

  const sets = (dir: string): string[] => readdirSync(join(dir, 'backups')).filter((n) => /^\d{8}T\d{6}Z$/.test(n)).sort();

  it('writes a whole set: dumps, tars, checksums and a manifest with row counts from the dump snapshot', () => {
    const { dir, env, log } = setup('whole');
    const r = run('bash', [backupScript], env);
    expect(r.code, r.out).toBe(0);
    const [name] = sets(dir);
    expect(name).toBeDefined();
    const set = join(dir, 'backups', name ?? '');
    expect(readdirSync(set).sort()).toEqual(
      ['blobs.tar', 'db-hindsight.dump', 'db-hindsight.settings.sql', 'db-manythreads.dump', 'db-manythreads.settings.sql', 'manifest.txt', 'repos.tar', 'sha256sums.txt'].sort(),
    );
    const manifest = readFileSync(join(set, 'manifest.txt'), 'utf8');
    expect(manifest).toContain('complete=yes');
    expect(manifest).toContain('app_version=abc1234');
    expect(manifest).toContain('rows.messages=7');
    expect(manifest).toContain('db.manythreads.owner=manythreads_owner');
    expect(manifest).toContain('roles=manythreads_app manythreads_owner manythreads_system');
    expect(manifest).toMatch(/file\.blobs\.tar\.sha256=[0-9a-f]{64}/);
    expect(readFileSync(join(set, 'db-manythreads.settings.sql'), 'utf8')).toContain('SET search_path=app, public');
    // the main database was dumped inside the exported snapshot, the other one plainly
    const calls = readFileSync(log, 'utf8');
    expect(calls).toMatch(/pg_dump .*--snapshot=00000003-1 .*db-manythreads\.dump/);
    expect(calls).toMatch(/pg_dump (?!.*--snapshot).*db-hindsight\.dump/);
    // checksums verify, the attachment store's scratch directory is left out, and nothing half-written is left behind
    const check = spawnSync('sha256sum', ['-c', 'sha256sums.txt'], { cwd: set, encoding: 'utf8' });
    expect(check.status, check.stdout + check.stderr).toBe(0);
    const listing = spawnSync('tar', ['-tf', join(set, 'blobs.tar')], { encoding: 'utf8' }).stdout;
    expect(listing).toContain('./ab/abcdef');
    expect(listing).not.toContain('.tmp');
    expect(readdirSync(join(dir, 'backups')).filter((n) => n.startsWith('.incoming'))).toEqual([]);
  });

  it('keeps only the newest N sets', () => {
    const { dir, env } = setup('retention');
    for (let i = 0; i < 3; i++) {
      const r = run('bash', [backupScript], env);
      expect(r.code, r.out).toBe(0);
      if (i < 2) spawnSync('sleep', ['1.1']);
    }
    expect(sets(dir)).toHaveLength(2);
  });

  it('leaves no set behind when the dump fails, and never prunes an older set because of it', () => {
    const { dir, env } = setup('failing');
    expect(run('bash', [backupScript], env).code).toBe(0);
    const before = sets(dir);
    spawnSync('sleep', ['1.1']);
    const r = run('bash', [backupScript], { ...env, FAKE_PG_DUMP_FAIL: '1', BACKUP_RETENTION: '1' });
    expect(r.code).not.toBe(0);
    expect(sets(dir)).toEqual(before);
    expect(readdirSync(join(dir, 'backups')).filter((n) => n.startsWith('.incoming'))).toEqual([]);
  });

  it('refuses a bad retention and records a bucket store honestly', () => {
    const { dir, env } = setup('s3');
    expect(run('bash', [backupScript], { ...env, BACKUP_RETENTION: '0' }).code).not.toBe(0);
    const r = run('bash', [backupScript], { ...env, BACKUP_STORAGE_TYPE: 's3' });
    expect(r.code, r.out).toBe(0);
    const [name] = sets(dir);
    const set = join(dir, 'backups', name ?? '');
    expect(existsSync(join(set, 'blobs.tar'))).toBe(false);
    expect(readFileSync(join(set, 'manifest.txt'), 'utf8')).toContain('blobs=not-included (s3 store)');
  });
});

describe('restore.sh', () => {
  const restore = join(toolsDir, 'restore.sh');
  const env = (log: string, extra: Record<string, string> = {}): Record<string, string> => ({
    FAKE_LOG: log,
    FAKE_FIXTURES: join(root, 'fixtures'),
    FAKE_SET: SET,
    ...extra,
  });
  const newLog = (name: string): string => {
    const log = join(root, `${name}.log`);
    writeFileSync(log, '');
    return log;
  };

  it('refuses the live namespace and the source namespace without --force-live, before talking to the cluster', () => {
    const log = newLog('refuse');
    for (const ns of ['manythreads', 'elsewhere']) {
      const args = ['--set', 'latest', '--target-ns', ns, '--yes'];
      const extra = ns === 'elsewhere' ? ['--source-ns', 'elsewhere'] : [];
      const r = run('bash', [restore, ...args, ...extra], env(log));
      expect(r.code).not.toBe(0);
      expect(r.out).toContain('refusing to restore');
    }
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  it('requires --set and --target-ns', () => {
    const log = newLog('args');
    expect(run('bash', [restore, '--target-ns', 'x'], env(log)).out).toContain('--set is required');
    expect(run('bash', [restore, '--set', 'latest'], env(log)).out).toContain('--target-ns is required');
  });

  it('--check-only verifies the set and changes nothing', () => {
    const log = newLog('check');
    const r = run('bash', [restore, '--set', 'latest', '--target-ns', 'scratch', '--check-only'], env(log));
    expect(r.code, r.out).toBe(0);
    const calls = readFileSync(log, 'utf8');
    expect(calls).not.toMatch(/ scale | pg_restore |DROP DATABASE/);
  });

  it('stops the server, replaces database, blobs and repositories in order, then starts the server again', () => {
    const log = newLog('full');
    const r = run('bash', [restore, '--set', 'latest', '--target-ns', 'scratch', '--yes'], env(log));
    expect(r.code, r.out).toBe(0);
    const calls = readFileSync(log, 'utf8').split('\n');
    const at = (needle: RegExp): number => calls.findIndex((l) => needle.test(l));
    const down = at(/scale deployment manythreads-server --replicas=0/);
    const scratch = at(/CREATE DATABASE "manythreads_restoring" OWNER "manythreads_owner"/);
    const pgRestore = at(/pg_restore --exit-on-error --dbname=manythreads_restoring/);
    const drop = at(/DROP DATABASE IF EXISTS "manythreads" WITH \(FORCE\).*ALTER DATABASE "manythreads_restoring" RENAME TO "manythreads"/);
    const blobs = at(/tar --extract --no-same-owner --touch --file=\/work\/blobs\.tar/);
    const repos = at(/tar --extract --no-same-owner --touch --file=\/work\/repos\.tar/);
    const up = at(/scale deployment manythreads-server --replicas=1/);
    expect(down).toBeGreaterThan(-1);
    expect(scratch).toBeGreaterThan(down);
    // the current database is dropped only after the dump restored whole into the scratch one
    expect(pgRestore).toBeGreaterThan(scratch);
    expect(drop).toBeGreaterThan(pgRestore);
    expect(blobs).toBeGreaterThan(drop);
    expect(repos).toBeGreaterThan(blobs);
    expect(up).toBeGreaterThan(repos);
    expect(calls.some((l) => /CREATE ROLE "manythreads_app" LOGIN/.test(l))).toBe(true);
    expect(calls.some((l) => /delete pod manythreads-restore-helper/.test(l))).toBe(true);
  });

  it('keeps the current database when pg_restore fails, and leaves the server stopped', () => {
    const log = newLog('badrestore');
    const r = run('bash', [restore, '--set', 'latest', '--target-ns', 'scratch', '--yes'], env(log, { FAKE_PG_RESTORE_FAIL: '1' }));
    expect(r.code).not.toBe(0);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('CREATE DATABASE "manythreads_restoring"');
    expect(calls).not.toMatch(/DROP DATABASE IF EXISTS "manythreads" WITH|RENAME TO|--replicas=1/);
    expect(r.out).toContain('stays stopped');
  });

  it('touches nothing when the set fails its checksums', () => {
    const log = newLog('badsums');
    const r = run('bash', [restore, '--set', 'latest', '--target-ns', 'scratch', '--yes'], env(log, { FAKE_BAD_SUMS: '1' }));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('damaged');
    expect(readFileSync(log, 'utf8')).not.toMatch(/ scale |DROP DATABASE|pg_restore/);
  });

  it('leaves the server stopped when a file arrives damaged', () => {
    const log = newLog('badarrival');
    const r = run('bash', [restore, '--set', 'latest', '--target-ns', 'scratch', '--yes'], env(log, { FAKE_BAD_ARRIVAL: '1' }));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('arrived damaged');
    expect(r.out).toContain('stays stopped');
    expect(readFileSync(log, 'utf8')).not.toMatch(/--replicas=1/);
  });
});

describe('drill.sh', () => {
  const drill = join(toolsDir, 'drill.sh');
  const newLog = (name: string): string => {
    const log = join(root, `${name}.log`);
    writeFileSync(log, '');
    rmSync(`${log}.ns`, { force: true });
    return log;
  };
  const env = (log: string, extra: Record<string, string> = {}): Record<string, string> => ({
    FAKE_LOG: log,
    FAKE_FIXTURES: join(root, 'fixtures'),
    FAKE_SET: SET,
    ...extra,
  });

  it('prints PASS with RPO and RTO and removes only its own scratch namespace', () => {
    const log = newLog('drill-pass');
    const r = run('bash', [drill], env(log));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/PASS\s+\(\d+ checks\)/);
    expect(r.out).toMatch(/RPO\s+the newest set is \d+s old/);
    expect(r.out).toMatch(/RTO\s+\d+s/);
    const calls = readFileSync(log, 'utf8');
    const ns = readFileSync(`${log}.ns`, 'utf8').trim();
    expect(ns).toMatch(/^manythreads-drill-/);
    expect(calls).toContain(`delete namespace ${ns}`);
    expect(calls).not.toMatch(/delete namespace manythreads( |$)/m);
    expect(calls).toContain(`-n ${ns} exec drill-postgres`);
    // the live namespace is only ever read (backup volume) and never scaled
    expect(calls).not.toMatch(/-n manythreads (scale|apply|delete namespace)/);
  });

  it('creates the scratch Postgres pod with the shell variables left for the pod to expand', () => {
    const log = newLog('drill-yaml');
    const r = run('bash', [drill], env(log));
    expect(r.code, r.out).toBe(0);
    const applied = readFileSync(`${log}.applied`, 'utf8');
    // an unquoted heredoc would expand these on the operator's machine; they must reach the pod verbatim
    expect(applied).toContain('PATH=$(ls -d /usr/lib/postgresql/*/bin | tail -n 1):$PATH pg_isready');
    expect(applied).toContain('export PATH="$(ls -d /usr/lib/postgresql/*/bin | tail -n 1):$PATH"');
    expect(applied).toContain('printf \'%s\' "$PGPASSWORD" >/tmp/pw');
    // initdb needs a directory it owns: a sub-directory of the (root-owned) volume
    expect(applied).toContain('initdb -D /var/lib/pgdata/data ');
  });

  it('prints FAIL and exits non-zero when restored rows differ from the manifest', () => {
    const log = newLog('drill-fail');
    const r = run('bash', [drill], env(log, { FAKE_WRONG_ROWS: '1' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL');
    expect(r.out).toContain('restored 0, manifest says 7');
  });

  it('--keep leaves the scratch namespace in place', () => {
    const log = newLog('drill-keep');
    const r = run('bash', [drill, '--keep'], env(log));
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(log, 'utf8')).not.toContain('delete namespace');
  });
});

describe('pull.sh', () => {
  const pull = join(toolsDir, 'pull.sh');
  it('copies the newest set to a local directory after checking its checksums', () => {
    const log = join(root, 'pull.log');
    writeFileSync(log, '');
    const dest = join(root, 'offbox');
    const env = { FAKE_LOG: log, FAKE_FIXTURES: join(root, 'fixtures'), FAKE_SET: SET };
    const r = run('bash', [pull, '--dest', dest, '--with-secrets'], env);
    expect(r.code, r.out).toBe(0);
    expect(readdirSync(join(dest, SET)).sort()).toEqual(['db-manythreads.dump', 'manifest.txt', 'sha256sums.txt']);
    expect(existsSync(join(dest, 'secrets-manythreads.yaml'))).toBe(true);
    expect(run('bash', [pull, '--dest', dest], env).code).not.toBe(0); // never overwrites a copied set
  });
});

describe('the chart', () => {
  const haveHelm = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' }).status === 0;
  const render = (extra: string[]): { code: number; out: string } => {
    const r = spawnSync('helm', ['template', 't', chartDir, ...extra], { encoding: 'utf8' });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  };

  it.skipIf(!haveHelm)('renders nothing for backups by default', () => {
    const r = render([]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain('manythreads-backup');
  });

  it.skipIf(!haveHelm)('renders the volume, the script and a daily CronJob when enabled', () => {
    const r = render(['--set', 'backup.enabled=true', '--set', 'backup.retention=5', '--set', 'backup.schedule=30 1 * * *']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('name: manythreads-backups');
    expect(r.out).toContain('kind: CronJob');
    expect(r.out).toContain('schedule: "30 1 * * *"');
    expect(r.out).toContain('name: BACKUP_RETENTION, value: "5"');
    expect(r.out).toContain('claimName: manythreads-blobs, readOnly: true');
    expect(r.out).toContain('claimName: manythreads-repos, readOnly: true');
    expect(r.out).toContain('backup.sh: |');
    // the owner password comes from the Secret, never as text
    expect(r.out).toMatch(/name: PGPASSWORD\s+valueFrom: \{ secretKeyRef: \{ name: manythreads-db-owner/);
  });

  it.skipIf(!haveHelm)('skips the blob volume with the S3 store and rejects a bad retention', () => {
    const s3 = render(['--set', 'backup.enabled=true', '--set', 'server.storage.type=s3', '--set', 'server.storage.s3.bucket=b']);
    expect(s3.code, s3.out).toBe(0);
    expect(s3.out).not.toContain('claimName: manythreads-blobs, readOnly: true');
    expect(s3.out).toContain('BACKUP_STORAGE_TYPE');
    const bad = render(['--set', 'backup.enabled=true', '--set', 'backup.retention=0']);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('backup.retention');
  });

  it.skipIf(!haveHelm)('is on in the live values with the memory engine database', () => {
    const r = render(['-f', join(chartDir, 'values-live.yaml'), '--set', 'hermesPods.apiServer.cidr=10.0.2.15/32']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('name: BACKUP_DATABASES, value: "manythreads hindsight"');
  });
});

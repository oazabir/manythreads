// `pnpm seed [--demo] [--migrate] [--wait <seconds>]`: seeds the database named by the environment with the Kahf Software
// world (seedWorld in seed.ts). Idempotent. Same variables as the server (packages/server/src/main.ts):
//   DATABASE_URL (owner URL, default: the dev compose Postgres), MANYTHREADS_SYSTEM_DATABASE_URL, MANYTHREADS_SYSTEM_PASSWORD.
import { DEFAULT_SYSTEM_PASSWORD, DEV_OWNER_URL, createSystemPool, runMigrations, withSystem } from '@manythreads/kernel';
import { seedWorld } from './seed.ts';

const USAGE = `Usage: pnpm seed [options]

Seeds workspace "Kahf Software" (teams Engineering, Customer support, Marketing; seven personas) into the database named by
DATABASE_URL. Safe to run again: nothing is duplicated and existing passwords are kept.

  --demo           random persona passwords, stored only as hashes and printed nowhere (public deployments)
  --migrate        apply the kernel migrations first (a fresh dev database); the server does this itself at start
  --wait <secs>    wait up to this long for the server's migrations to finish (default 0: fail at once)
  -h, --help       this text
`;

function parseArgs(argv: string[]): { demo: boolean; migrate: boolean; wait: number } | null {
  let demo = false;
  let migrate = false;
  let wait = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--demo') demo = true;
    else if (a === '--migrate') migrate = true;
    else if (a === '--wait') wait = Number(argv[(i += 1)]);
    else if (a?.startsWith('--wait=')) wait = Number(a.slice(7));
    else if (a === '-h' || a === '--help') return null;
    else throw new Error(`unknown argument "${a}"\n\n${USAGE}`);
  }
  if (!Number.isFinite(wait) || wait < 0) throw new Error('--wait takes a number of seconds');
  return { demo, migrate, wait };
}

const env = process.env;
const ownerUrl = env['DATABASE_URL'] ?? env['MANYTHREADS_DATABASE_URL'] ?? DEV_OWNER_URL;

function systemUrl(): string {
  const explicit = env['MANYTHREADS_SYSTEM_DATABASE_URL'];
  if (explicit) return explicit;
  const u = new URL(ownerUrl);
  u.username = 'manythreads_system';
  u.password = env['MANYTHREADS_SYSTEM_PASSWORD'] ?? DEFAULT_SYSTEM_PASSWORD;
  return u.toString();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True when the identity and team tables exist (the kernel migrations the seed writes to). */
async function migrated(url: string): Promise<boolean> {
  const pool = createSystemPool(url, 1);
  try {
    return await withSystem(
      async (tx) => {
        const res = await tx.query<{ ok: boolean }>(
          `SELECT to_regclass('app.person_emails') IS NOT NULL AND to_regclass('app.password_credentials') IS NOT NULL
              AND to_regclass('app.team_members') IS NOT NULL AND to_regclass('app.role_members') IS NOT NULL AS ok`,
        );
        return res.rows[0]?.ok === true;
      },
      { pool },
    );
  } catch {
    return false; // the role or the schema is not there yet
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.log(USAGE);
  process.exit(0);
}

const url = systemUrl();
if (args.migrate) {
  const applied = await runMigrations({ connectionString: ownerUrl });
  console.log(`seed: kernel migrations applied (${applied} new)`);
}
const deadline = Date.now() + args.wait * 1000;
while (!(await migrated(url))) {
  if (Date.now() >= deadline) {
    console.error(
      `seed: the database at ${new URL(url).host} is not migrated (or the system role cannot connect). Start the server once, pass --migrate, or --wait <secs>.`,
    );
    process.exit(1);
  }
  await sleep(2000);
}

const result = await seedWorld({ systemUrl: url }, { demo: args.demo, log: (line) => console.log(`seed: ${line}`) });
// Nothing below prints a credential: in demo mode the passwords never leave seedWorld.
console.log(
  result.skipped
    ? 'seed: nothing to do'
    : `seed: done (${result.created ? 'new' : 'existing'} workspace, ${result.passwordMode} passwords)`,
);
process.exit(0);

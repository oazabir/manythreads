import { withSystem, type Tx } from '@manythreads/kernel';
import type pg from 'pg';
import { AdminError, setPassword } from './admin.ts';
import { Http, InitError, checkPasswordLength, generatePassword, initEnvFromEnv, signInOrBootstrap, waitReady } from './init.ts';

/**
 * The commands of the one-command install (docs/deploy/install.md), run by `install.sh` and `manythreads` inside the server pod:
 *
 *   admin first-admin --email <address> [--workspace <name>]   the workspace and its first administrator, with a made-up password the person must change
 *   admin password-status <email>                              whether that first password is still the one in use (never prints it)
 *   admin reset-password <email> --generate                    a new made-up password for a person, printed once, to be changed at the next sign-in
 *
 * The password is the only secret these print, once, on standard output as a `KEY=value` line the installer reads; nothing else secret is printed, and the
 * password is never in an event, an audit line or a log. A made-up password is marked "must change": the sign-in then asks for a new one before anything else.
 */

export const FIRST_ADMIN_USAGE = [
  'usage: admin first-admin --email <address> [--workspace <name>] [--name <name>]',
  '       admin password-status <email>',
  '       admin reset-password <email> --generate',
].join('\n');

export interface FirstAdminArgs {
  email: string;
  workspace: string;
  name: string;
}

export function parseFirstAdminArgs(rest: readonly string[]): FirstAdminArgs | string {
  let email = '';
  let workspace = 'My organization';
  let name = '';
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    const value = rest[i + 1];
    if (arg === '--email' && value !== undefined) email = value.trim().toLowerCase();
    else if (arg === '--workspace' && value !== undefined) workspace = value.trim();
    else if (arg === '--name' && value !== undefined) name = value.trim();
    else return `unknown option ${arg}`;
    i += 1;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'give the administrator\'s email with --email <address>';
  if (workspace === '') return 'the workspace name cannot be empty';
  return { email, workspace, name: name || email.split('@')[0] || 'Admin' };
}

export interface FirstAdminResult {
  status: 'created' | 'exists';
  email: string;
  /** Only when `status` is `created`. */
  password?: string;
}

/**
 * Makes the workspace and its owner through the same first-run route the browser page uses (so the same rules run), then marks the made-up password
 * "must change". A workspace that exists already is left alone: running the installer again never makes a second administrator.
 */
export async function firstAdmin(
  pool: pg.Pool,
  http: Http,
  args: FirstAdminArgs,
  options: { now?: () => Date; password?: string } = {},
): Promise<FirstAdminResult> {
  const have = await withSystem(async (tx: Tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.workspaces')).rows[0]?.n ?? 0, { pool });
  if (have > 0) return { status: 'exists', email: args.email };
  const password = options.password ?? generatePassword();
  checkPasswordLength(password);
  await signInOrBootstrap(pool, http, { email: args.email, name: args.name, workspace: args.workspace, password }, options.now ?? (() => new Date()));
  await withSystem(
    async (tx: Tx) => {
      const r = await tx.query(
        `UPDATE app.password_credentials SET must_change = true, updated_at = now()
          WHERE person_id IN (SELECT id FROM app.people WHERE lower(primary_email) = $1)`,
        [args.email],
      );
      if (r.rowCount !== 1) throw new InitError('The administrator was made but its password could not be marked "must change".');
    },
    { pool },
  );
  return { status: 'created', email: args.email, password };
}

export type PasswordState = 'pending' | 'changed' | 'none' | 'unknown';

/** `pending`: a made-up password is still the one in use (it has not been changed); `changed`: the person chose their own; `none`: no password; `unknown`: no such person. */
export async function passwordStatus(pool: pg.Pool, email: string): Promise<PasswordState> {
  return withSystem(
    async (tx: Tx) => {
      const r = await tx.query<{ must_change: boolean | null }>(
        `SELECT c.must_change FROM app.people p LEFT JOIN app.password_credentials c ON c.person_id = p.id WHERE lower(p.primary_email) = $1 ORDER BY p.created_at LIMIT 2`,
        [email.trim().toLowerCase()],
      );
      if (r.rows.length === 0) return 'unknown';
      const row = r.rows[0] as { must_change: boolean | null };
      if (row.must_change === null) return 'none';
      return row.must_change ? 'pending' : 'changed';
    },
    { pool },
  );
}

/** A new made-up password for the person, marked "must change"; every session of theirs is signed out. */
export async function resetPasswordGenerated(pool: pg.Pool, email: string, options: { now?: () => Date; env?: NodeJS.ProcessEnv } = {}): Promise<{ email: string; password: string }> {
  const password = generatePassword();
  const r = await setPassword(pool, { email, password }, { ...options, mustChange: true });
  return { email: r.email, password };
}

interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Runs one of the three commands; returns the exit code. */
export async function runFirstAdmin(command: string, rest: readonly string[], io: Io, makePool: () => pg.Pool): Promise<number> {
  const fail = (err: unknown): number => {
    if (err instanceof AdminError || err instanceof InitError) {
      io.err(err.message);
      return err.exitCode;
    }
    io.err(`admin failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  };
  if (command === 'first-admin') {
    const parsed = parseFirstAdminArgs(rest);
    if (typeof parsed === 'string') {
      io.err(`${parsed}\n${FIRST_ADMIN_USAGE}`);
      return 2;
    }
    const pool = makePool();
    try {
      const http = new Http(initEnvFromEnv(io.env).baseUrl);
      // The server may still be starting when the installer calls this; it answers /readyz once it has migrated.
      const have = await withSystem(async (tx: Tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.workspaces')).rows[0]?.n ?? 0, { pool }).catch(() => 0);
      if (have === 0) await waitReady(http, (line) => io.err(line));
      const r = await firstAdmin(pool, http, parsed, io.now ? { now: io.now } : {});
      io.out(`FIRST_ADMIN_STATUS=${r.status}`);
      io.out(`FIRST_ADMIN_EMAIL=${r.email}`);
      if (r.password) io.out(`FIRST_ADMIN_PASSWORD=${r.password}`);
      if (r.status === 'exists') io.err('A workspace exists already; nothing was made and no password was changed.');
      return 0;
    } catch (err) {
      return fail(err);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
  const email = rest[0];
  if (!email || email.startsWith('-')) {
    io.err(FIRST_ADMIN_USAGE);
    return 2;
  }
  const pool = makePool();
  try {
    if (command === 'password-status') {
      if (rest.length !== 1) {
        io.err(FIRST_ADMIN_USAGE);
        return 2;
      }
      io.out(`FIRST_PASSWORD=${await passwordStatus(pool, email)}`);
      return 0;
    }
    // reset-password
    if (rest.length !== 2 || rest[1] !== '--generate') {
      io.err(`${FIRST_ADMIN_USAGE}\n(reset-password only makes up a new password: pass --generate; to choose one, pipe it into set-password)`);
      return 2;
    }
    const r = await resetPasswordGenerated(pool, email, { ...(io.now ? { now: io.now } : {}), env: io.env });
    io.out(`NEW_PASSWORD_EMAIL=${r.email}`);
    io.out(`NEW_PASSWORD=${r.password}`);
    return 0;
  } catch (err) {
    return fail(err);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

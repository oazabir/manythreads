import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MIN_PASSWORD_LENGTH, createSystemPool, emit, enqueueKmsRewrap, hashPassword, withSystem, type Tx } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import type { PersonId, WorkspaceId } from '@manythreads/shared';
import type pg from 'pg';
import { databaseUrlsFromEnv } from '../db-env.ts';
import { createSessionService, sessionConfigFromEnv } from '../session/index.ts';

/**
 * Operator commands for a running deployment, run inside the server image (`kubectl exec`), never over HTTP:
 *
 *   pnpm --filter @manythreads/server admin set-password <email>      new password on stdin
 *   pnpm --filter @manythreads/server admin kms-rewrap                 queue the move of every secret to the current master key
 *
 * `set-password` reads the new password from standard input (never from the command line, so it is not in `ps`, shell
 * history or logs), refuses one shorter than the policy minimum, stores its argon2id hash, signs the person out
 * everywhere and records an `identity.password.admin_set` audit event. It connects as the kernel's system role
 * (`MANYTHREADS_SYSTEM_DATABASE_URL`, or derived from `DATABASE_URL` like the server does).
 *
 * `kms-rewrap` is the last step of a master-key rotation: set the new `MANYTHREADS_KMS_KEY`, keep the old one in
 * `MANYTHREADS_KMS_PREVIOUS_KEYS`, restart the server (its job worker runs the `kms.rewrap` queue), then run the command. It only
 * enqueues the job (one at a time: asking again while one waits or runs returns that job) and prints the job id; progress is the
 * job's state in `app.jobs`. Once it is `done`, drop the old key from the previous list.
 */

export class AdminError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export interface SetPasswordResult {
  personId: string;
  workspaceId: string;
  email: string;
  sessionsRevoked: number;
}

/** Hash `password`, store it for the active person with this primary email, sign them out and audit it. */
export async function setPassword(
  pool: pg.Pool,
  input: { email: string; password: string },
  options: { now?: () => Date; env?: NodeJS.ProcessEnv } = {},
): Promise<SetPasswordResult> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes('@')) throw new AdminError(`"${input.email.trim()}" is not an email address.`, 2);
  if ([...input.password].length < MIN_PASSWORD_LENGTH) {
    throw new AdminError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 2);
  }
  const now = options.now ?? (() => new Date());
  const sessions = createSessionService({ pool, config: sessionConfigFromEnv(options.env ?? process.env), now });
  const hash = await hashPassword(input.password);

  return withSystem(
    async (tx: Tx): Promise<SetPasswordResult> => {
      const found = await tx.query<{ id: string; workspace_id: string; primary_email: string; status: string }>(
        'SELECT id, workspace_id, primary_email, status FROM app.people WHERE lower(primary_email) = $1 ORDER BY created_at, id',
        [email],
      );
      if (found.rows.length === 0) throw new AdminError(`No person has the email ${email}.`);
      if (found.rows.length > 1) throw new AdminError(`More than one person has the email ${email}; refusing to guess.`);
      const person = found.rows[0] as { id: string; workspace_id: string; primary_email: string; status: string };
      if (person.status !== 'active') throw new AdminError(`${email} is ${person.status}, not active.`);

      await tx.query(
        `INSERT INTO app.password_credentials (person_id, hash, must_change, created_at, updated_at) VALUES ($1, $2, false, $3, $3)
         ON CONFLICT (person_id) DO UPDATE SET hash = EXCLUDED.hash, must_change = false, updated_at = EXCLUDED.updated_at`,
        [person.id, hash, now()],
      );
      // Every reset link of this person dies with the old password; so does every session.
      await tx.query(
        `UPDATE app.email_verifications SET used_at = $2 WHERE person_id = $1 AND purpose = 'reset_password' AND used_at IS NULL`,
        [person.id, now()],
      );
      const sessionsRevoked = await sessions.revokeAll(tx as unknown as PluginTx, { personId: person.id });
      await emit(tx, {
        type: 'identity.password.admin_set',
        schemaVersion: 1,
        workspaceId: person.workspace_id as WorkspaceId,
        personId: person.id as PersonId,
        sessionsRevoked,
      });
      return { personId: person.id, workspaceId: person.workspace_id, email: person.primary_email, sessionsRevoked };
    },
    { pool },
  );
}

/** Everything piped in, minus one trailing line break (`echo` and `printf '%s\n'` both add one). */
export async function readPassword(stdin: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

export interface AdminIo {
  stdin: AsyncIterable<Buffer | string> & { isTTY?: boolean };
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** Opens the pool the command uses (default: the system role from the environment). Closed by `runAdmin`. */
  pool?: () => pg.Pool;
  now?: () => Date;
}

const USAGE = [
  'usage: admin set-password <email>   (the new password is read from standard input)',
  '       admin kms-rewrap             (queue the move of every secret to the current master key)',
].join('\n');

export interface KmsRewrapResult {
  jobId: string;
  /** False when a re-wrap was already waiting or running and this call returned it. */
  queued: boolean;
}

/** Enqueue the `kms.rewrap` job (deduplicated while one is ready or running). */
export async function queueKmsRewrap(pool: pg.Pool): Promise<KmsRewrapResult> {
  return withSystem(
    async (tx: Tx) => {
      const before = await tx.query<{ id: string }>(`SELECT id FROM app.jobs WHERE queue = 'kms.rewrap' AND state IN ('ready', 'running') LIMIT 1`);
      const job = await enqueueKmsRewrap(tx);
      return { jobId: job.id, queued: before.rows[0]?.id !== job.id };
    },
    { pool },
  );
}

/** Runs one admin command; returns the process exit code. Never prints the password. */
export async function runAdmin(argv: readonly string[], io: AdminIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'kms-rewrap') {
    if (rest.length > 0) {
      io.err(USAGE);
      return 2;
    }
    const pool = (io.pool ?? (() => createSystemPool(databaseUrlsFromEnv(io.env).systemUrl, 2)))();
    try {
      const r = await queueKmsRewrap(pool);
      io.out(
        r.queued
          ? `Key re-wrap queued (job ${r.jobId}). A running server picks it up; when the job is done, drop the old key from MANYTHREADS_KMS_PREVIOUS_KEYS.`
          : `A key re-wrap is already waiting or running (job ${r.jobId}).`,
      );
      return 0;
    } catch (err) {
      io.err(`admin failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
  if (command !== 'set-password') {
    io.err(command ? `unknown command "${command}"\n${USAGE}` : USAGE);
    return 2;
  }
  const email = rest[0];
  if (rest.length !== 1 || !email) {
    io.err(USAGE);
    return 2;
  }
  if (io.stdin.isTTY) {
    io.err('Pipe the new password on standard input (it is never taken from the command line).');
    return 2;
  }
  const pool = (io.pool ?? (() => createSystemPool(databaseUrlsFromEnv(io.env).systemUrl, 2)))();
  try {
    const password = await readPassword(io.stdin);
    const r = await setPassword(pool, { email, password }, { ...(io.now ? { now: io.now } : {}), env: io.env });
    io.out(`Password set for ${r.email}; ${r.sessionsRevoked} active session${r.sessionsRevoked === 1 ? '' : 's'} signed out.`);
    return 0;
  } catch (err) {
    if (err instanceof AdminError) {
      io.err(err.message);
      return err.exitCode;
    }
    io.err(`admin failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  const code = await runAdmin(process.argv.slice(2), {
    stdin: process.stdin,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    env: process.env,
  });
  process.exit(code);
}

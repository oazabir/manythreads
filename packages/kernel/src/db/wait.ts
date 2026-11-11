import pg from 'pg';

/** How long a start waits for the database before it gives up (seconds). */
export const DEFAULT_DB_CONNECT_TIMEOUT_SECONDS = 120;

/** First pause between attempts; it doubles up to {@link MAX_BACKOFF_MS}. */
const FIRST_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

/** Network errors of a database that is not reachable YET (a restarting pod, a service whose DNS record is not there yet). */
const RETRYABLE_NET_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * Postgres codes of a server that is up but cannot take a session yet: 57P03 "the database system is starting up" (also during
 * recovery and when a standby is not ready), 57P01/57P02 (shutting down or restarting), 53300 (all connection slots taken, which
 * clears when the other clients go).
 */
const RETRYABLE_PG_CODES: ReadonlySet<string> = new Set(['57P03', '57P01', '57P02', '53300']);

/** What a failed connect looked like, in a few words and never with the connection string. */
function describeError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code !== '') return code;
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0]!.replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * Whether a failed first connection is worth another try. Refused connections, DNS that is not ready, a database that is starting
 * up (57P03) and a connection cut during start-up are; a wrong password (28P01), an unknown role or database and a malformed URL
 * are not (waiting would not fix them, and the operator should see the error at once).
 */
export function isRetryableConnectError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; errors?: unknown; message?: unknown };
  if (typeof e.code === 'string') {
    if (RETRYABLE_PG_CODES.has(e.code) || RETRYABLE_NET_CODES.has(e.code)) return true;
    return false; // any other coded error (28P01, 28000, 3D000, ERR_INVALID_URL, ...) is a fault of the configuration
  }
  // Node reports a dual-stack connect failure (localhost: ::1 and 127.0.0.1) as an AggregateError.
  if (Array.isArray(e.errors) && e.errors.length > 0) return e.errors.every(isRetryableConnectError);
  // pg raises these without a code when the socket closes or stalls while the session is being opened.
  const message = typeof e.message === 'string' ? e.message : '';
  return /Connection terminated|timeout expired|ended unexpectedly/i.test(message);
}

/**
 * `MANYTHREADS_DB_CONNECT_TIMEOUT_SECONDS`: the total time a start waits for the database (default 120). `0` means a single attempt.
 * A value that is not a non-negative number is ignored.
 */
export function dbConnectTimeoutSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['MANYTHREADS_DB_CONNECT_TIMEOUT_SECONDS'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_DB_CONNECT_TIMEOUT_SECONDS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DB_CONNECT_TIMEOUT_SECONDS;
}

export interface WaitForDatabaseOptions {
  /** The URL to try (the owner login: it is the one the migrations use). Never logged. */
  connectionString: string;
  /** Total wait; default from `MANYTHREADS_DB_CONNECT_TIMEOUT_SECONDS`, else 120. */
  timeoutSeconds?: number;
  /** One short line per failed attempt (default: stderr). */
  log?: (line: string) => void;
  /** Makes one attempt and rejects when the database refuses (default: open a session, `SELECT 1`, close it). Tests pass a fake. */
  attempt?: (connectionString: string) => Promise<void>;
  /** Pause (default: setTimeout). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock in ms (default: Date.now). */
  now?: () => number;
}

async function connectOnce(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
  client.on('error', () => undefined);
  await client.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** The host and port of a URL, for the error text (no user, no password, no query). */
function targetOf(connectionString: string): string {
  try {
    const u = new URL(connectionString);
    return `${u.hostname}${u.port === '' ? '' : `:${u.port}`}`;
  } catch {
    return 'the configured address';
  }
}

/**
 * Waits for the database to take a connection: retries a database that is not there yet with a pause that doubles (0.5 s, 1 s, 2 s ...
 * at most 10 s) until `timeoutSeconds` have passed, logging one short line per failed attempt. A refusal that waiting cannot fix
 * (wrong password, unknown database, bad URL) throws at once; so does the limit, with an error that says how long it waited.
 * On 2026-11-09 a deploy filled the disk, the kubelet evicted Postgres, and the new server died on its FIRST connection instead of
 * waiting the few minutes Postgres needed to come back.
 */
export async function waitForDatabase(options: WaitForDatabaseOptions): Promise<void> {
  const timeoutSeconds = options.timeoutSeconds ?? dbConnectTimeoutSeconds();
  const log = options.log ?? ((line: string) => void process.stderr.write(`${line}\n`));
  const attempt = options.attempt ?? connectOnce;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = started + timeoutSeconds * 1000;
  let backoff = FIRST_BACKOFF_MS;
  for (let n = 1; ; n += 1) {
    try {
      await attempt(options.connectionString);
      if (n > 1) log(`database is ready (attempt ${n}, after ${Math.round((now() - started) / 1000)} s)`);
      return;
    } catch (err) {
      if (!isRetryableConnectError(err)) throw err;
      const left = deadline - now();
      if (left <= 0) {
        throw new Error(
          `The database at ${targetOf(options.connectionString)} did not take a connection within ${timeoutSeconds} s ` +
            `(${n} attempt${n === 1 ? '' : 's'}, last error: ${describeError(err)}). Is Postgres running? ` +
            'MANYTHREADS_DB_CONNECT_TIMEOUT_SECONDS sets how long the start waits.',
          { cause: err },
        );
      }
      const pause = Math.min(backoff, MAX_BACKOFF_MS, left);
      log(`database not ready (attempt ${n}: ${describeError(err)}); retrying in ${(pause / 1000).toFixed(pause % 1000 === 0 ? 0 : 1)} s`);
      await sleep(pause);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}

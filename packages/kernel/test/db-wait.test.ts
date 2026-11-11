import { describe, expect, it } from 'vitest';
import { dbConnectTimeoutSeconds, isRetryableConnectError, waitForDatabase } from '../src/db/wait.ts';

const err = (code: string | undefined, message = 'boom'): Error => Object.assign(new Error(message), code === undefined ? {} : { code });

/** A clock the fake sleep advances, so a 120 s wait takes no real time. */
function fakeTime() {
  let t = 1_000_000;
  const pauses: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      pauses.push(ms);
      t += ms;
    },
    pauses,
  };
}

describe('isRetryableConnectError', () => {
  it('retries a refused connection, DNS not ready, startup (57P03) and a cut connection', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', '57P03', '57P01', '53300']) {
      expect(isRetryableConnectError(err(code)), code).toBe(true);
    }
    expect(isRetryableConnectError(err(undefined, 'Connection terminated unexpectedly'))).toBe(true);
    expect(isRetryableConnectError(err(undefined, 'timeout expired'))).toBe(true);
    // localhost on a dual-stack node: both addresses refused
    const both = Object.assign(new AggregateError([err('ECONNREFUSED'), err('ECONNREFUSED')]), {});
    expect(isRetryableConnectError(both)).toBe(true);
  });

  it('does not retry a wrong password, an unknown role or database, a bad URL or a plain bug', () => {
    for (const code of ['28P01', '28000', '3D000', 'ERR_INVALID_URL']) expect(isRetryableConnectError(err(code)), code).toBe(false);
    expect(isRetryableConnectError(err(undefined, 'something else'))).toBe(false);
    expect(isRetryableConnectError(new AggregateError([err('ECONNREFUSED'), err('28P01')]))).toBe(false);
    expect(isRetryableConnectError('nope')).toBe(false);
    expect(isRetryableConnectError(null)).toBe(false);
  });
});

describe('dbConnectTimeoutSeconds', () => {
  it('defaults to 120, reads the variable, ignores nonsense, allows 0', () => {
    expect(dbConnectTimeoutSeconds({})).toBe(120);
    expect(dbConnectTimeoutSeconds({ MANYTHREADS_DB_CONNECT_TIMEOUT_SECONDS: '30' })).toBe(30);
    expect(dbConnectTimeoutSeconds({ MANYTHREADS_DB_CONNECT_TIMEOUT_SECONDS: '0' })).toBe(0);
    expect(dbConnectTimeoutSeconds({ MANYTHREADS_DB_CONNECT_TIMEOUT_SECONDS: '' })).toBe(120);
    expect(dbConnectTimeoutSeconds({ MANYTHREADS_DB_CONNECT_TIMEOUT_SECONDS: 'abc' })).toBe(120);
    expect(dbConnectTimeoutSeconds({ MANYTHREADS_DB_CONNECT_TIMEOUT_SECONDS: '-5' })).toBe(120);
  });
});

describe('waitForDatabase', () => {
  const url = 'postgresql://manythreads_owner:s3cret-pw@db.example.internal:5432/manythreads';

  it('succeeds at once without logging when the first attempt works', async () => {
    const t = fakeTime();
    const lines: string[] = [];
    await waitForDatabase({ connectionString: url, timeoutSeconds: 120, attempt: async () => undefined, log: (l) => lines.push(l), ...t });
    expect(lines).toEqual([]);
    expect(t.pauses).toEqual([]);
  });

  it('fails N times, then connects: one short log line per failure, doubling pauses, capped at 10 s', async () => {
    const t = fakeTime();
    const lines: string[] = [];
    let calls = 0;
    await waitForDatabase({
      connectionString: url,
      timeoutSeconds: 120,
      attempt: async () => {
        calls += 1;
        if (calls <= 7) throw err(calls % 2 === 0 ? '57P03' : 'ECONNREFUSED', 'the database system is starting up');
      },
      log: (l) => lines.push(l),
      ...t,
    });
    expect(calls).toBe(8);
    expect(t.pauses).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000]);
    expect(lines).toHaveLength(8); // 7 failures + the "ready" line
    expect(lines[0]).toBe('database not ready (attempt 1: ECONNREFUSED); retrying in 0.5 s');
    expect(lines[1]).toContain('57P03');
    expect(lines[7]).toMatch(/^database is ready \(attempt 8/);
    for (const l of lines) {
      expect(l).not.toContain('s3cret-pw');
      expect(l).not.toContain('postgresql://');
      expect(l.length).toBeLessThan(120);
    }
  });

  it('gives up after the limit with a clear error that names the host, not the password', async () => {
    const t = fakeTime();
    const lines: string[] = [];
    let calls = 0;
    const run = waitForDatabase({
      connectionString: url,
      timeoutSeconds: 120,
      attempt: async () => {
        calls += 1;
        throw err('ECONNREFUSED');
      },
      log: (l) => lines.push(l),
      ...t,
    });
    await expect(run).rejects.toThrow(/db\.example\.internal:5432 did not take a connection within 120 s/);
    await run.catch((e: Error) => {
      expect(e.message).not.toContain('s3cret-pw');
      expect(e.message).toContain('MANYTHREADS_DB_CONNECT_TIMEOUT_SECONDS');
      expect((e.cause as { code: string }).code).toBe('ECONNREFUSED');
    });
    // the pauses add up to the limit and never past it
    expect(t.pauses.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120_000);
    expect(calls).toBeGreaterThan(10);
    expect(calls).toBeLessThan(25);
  });

  it('does not retry an authentication failure (28P01)', async () => {
    const t = fakeTime();
    let calls = 0;
    await expect(
      waitForDatabase({
        connectionString: url,
        timeoutSeconds: 120,
        attempt: async () => {
          calls += 1;
          throw err('28P01', 'password authentication failed for user "manythreads_owner"');
        },
        log: () => undefined,
        ...t,
      }),
    ).rejects.toThrow(/password authentication failed/);
    expect(calls).toBe(1);
    expect(t.pauses).toEqual([]);
  });

  it('does not retry a bad URL, and a zero timeout is one try', async () => {
    const t = fakeTime();
    let calls = 0;
    await expect(
      waitForDatabase({ connectionString: 'not a url', attempt: async () => { calls += 1; throw err('ERR_INVALID_URL'); }, log: () => undefined, ...t }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    calls = 0;
    await expect(
      waitForDatabase({ connectionString: url, timeoutSeconds: 0, attempt: async () => { calls += 1; throw err('ECONNREFUSED'); }, log: () => undefined, ...t }),
    ).rejects.toThrow(/within 0 s/);
    expect(calls).toBe(1);
  });

  it('really refuses fast on a closed port (no fake): the default attempt path ends in the clear error', async () => {
    const lines: string[] = [];
    await expect(
      waitForDatabase({ connectionString: 'postgresql://u:p@127.0.0.1:1/db', timeoutSeconds: 1, log: (l) => lines.push(l) }),
    ).rejects.toThrow(/did not take a connection within 1 s/);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.join('\n')).not.toContain('u:p');
  }, 20_000);
});

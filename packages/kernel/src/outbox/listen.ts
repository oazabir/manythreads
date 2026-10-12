import type pg from 'pg';

// Listening on a channel costs a pooled connection that is held (and then destroyed) for the listener's whole life. Every
// job worker, the outbox consumer and the realtime socket loop listen, so a server with N plugin queues would hold N+2
// connections out of its system pool just to be woken up — and once the listeners fill the pool, the next transaction the
// boot needs (a schedule write, a start-up task) waits forever for a connection that no one will ever release: the server
// hangs before it listens, with no error.
//
// The fix is sharing: one connection per (pool, channel) in this process, with every callback in a set. PostgreSQL sends
// the notification to the connection, not to the code, so one LISTEN serves all of them — the workers already filter by
// queue themselves (the payload is the queue name).

type Callback = (payload: string) => void;

interface SharedListener {
  callbacks: Set<Callback>;
  /** Resolves once the connection is LISTENing; rejects if it never could (then it is gone from the map). */
  ready: Promise<{ client: pg.PoolClient }>;
}

/** Keyed by pool first, so two test worlds (or a pool per replica) never share a listener they should not. */
const listeners = new WeakMap<pg.Pool, Map<string, SharedListener>>();

/**
 * Listen on `channel` for as long as the returned function has not been called. Calls for the same pool and channel share
 * one connection; the connection is destroyed when the last caller lets go (it still has LISTEN registered, so it is not
 * recycled into the pool). The release function is idempotent.
 */
export async function listen(
  pool: pg.Pool,
  channel: string,
  onNotify: Callback,
): Promise<() => Promise<void>> {
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error(`Unsafe channel "${channel}"`);
  let byChannel = listeners.get(pool);
  if (!byChannel) {
    byChannel = new Map();
    listeners.set(pool, byChannel);
  }
  let shared = byChannel.get(channel);
  if (!shared) {
    const callbacks = new Set<Callback>();
    const onMessage = (msg: pg.Notification): void => {
      if (msg.channel !== channel) return;
      for (const callback of callbacks) callback(msg.payload ?? '');
    };
    const ready = (async (): Promise<{ client: pg.PoolClient }> => {
      const client = await pool.connect();
      try {
        client.on('notification', onMessage);
        client.on('error', () => undefined);
        await client.query(`LISTEN ${channel}`);
        return { client };
      } catch (err) {
        client.off('notification', onMessage);
        client.release(true);
        throw err;
      }
    })();
    shared = { callbacks, ready };
    byChannel.set(channel, shared);
    // A failed connection must not poison the channel for the next caller.
    ready.catch(() => {
      if (byChannel.get(channel) === shared) byChannel.delete(channel);
    });
  }
  const entry = shared;
  entry.callbacks.add(onNotify);
  try {
    await entry.ready;
  } catch (err) {
    entry.callbacks.delete(onNotify);
    throw err;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    entry.callbacks.delete(onNotify);
    if (entry.callbacks.size > 0) return;
    // Stop new callers from joining a listener that is going away, then hand the connection back.
    if (byChannel.get(channel) === entry) byChannel.delete(channel);
    try {
      const { client } = await entry.ready;
      client.release(true);
    } catch {
      // Never connected; `ready` already released what it took.
    }
  };
}

export function sleepUnlessWoken(ms: number, signal: { wake: (() => void) | null }): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.wake = null;
      resolve();
    }
    signal.wake = done;
  });
}

/** Exponential backoff in ms: base * 2^(attempt-1), capped. */
export function backoffMs(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

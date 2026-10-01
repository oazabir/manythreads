import type pg from 'pg';

/** Dedicated connection running `LISTEN <channel>`; returns the function that stops it. */
export async function listen(
  pool: pg.Pool,
  channel: string,
  onNotify: (payload: string) => void,
): Promise<() => Promise<void>> {
  if (!/^[a-z_][a-z0-9_]*$/.test(channel)) throw new Error(`Unsafe channel "${channel}"`);
  const client = await pool.connect();
  const onMessage = (msg: pg.Notification): void => {
    if (msg.channel === channel) onNotify(msg.payload ?? '');
  };
  client.on('notification', onMessage);
  client.on('error', () => undefined);
  await client.query(`LISTEN ${channel}`);
  return async () => {
    client.off('notification', onMessage);
    // Destroy instead of recycling: the connection still has LISTEN registered.
    client.release(true);
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

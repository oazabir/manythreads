import type { PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { workspaceKey } from '../src/keys.ts';

// The workspace key is read inside the drain's own transaction and never kept past it: a key created by a drain that then rolled back must not
// outlive it in the process while the database (and every other replica) has none.

const WS = '00000000-0000-7000-8000-00000000a001';

/** A table of keys with a transaction on top: `commit` keeps what the transaction wrote, `rollback` drops it. */
function database() {
  const committed = new Map<string, Buffer>();
  const begin = (): { tx: PluginTx; commit(): void } => {
    const pending = new Map<string, Buffer>();
    const tx = {
      actor: { kind: 'system', id: 'x', workspaceId: WS },
      query: (text: string, values: readonly unknown[] = []) => {
        if (/^SELECT key/.test(text)) {
          const key = pending.get(values[0] as string) ?? committed.get(values[0] as string);
          return Promise.resolve({ rows: key ? [{ key }] : [] });
        }
        if (/^INSERT INTO app\.memory_workspace_keys/.test(text)) {
          if (!pending.has(values[0] as string) && !committed.has(values[0] as string)) pending.set(values[0] as string, values[1] as Buffer);
          return Promise.resolve({ rows: [] });
        }
        throw new Error(`unexpected query: ${text}`);
      },
    } as unknown as PluginTx;
    return { tx, commit: () => pending.forEach((v, k) => committed.set(k, v)) };
  };
  return { begin, committed };
}

describe('workspaceKey', () => {
  it('creates a 32-byte key once and returns the same one to the rest of the drain', async () => {
    const db = database();
    const t = db.begin();
    const cache = new Map<string, Buffer>();
    const a = await workspaceKey(t.tx, WS, cache);
    const b = await workspaceKey(t.tx, WS, cache);
    expect(a).toHaveLength(32);
    expect(b).toBe(a);
  });

  it('a key created in a transaction that rolls back is not remembered: the next drain creates its own', async () => {
    const db = database();
    const first = db.begin();
    const rolledBack = await workspaceKey(first.tx, WS); // never committed
    const second = db.begin();
    const next = await workspaceKey(second.tx, WS);
    expect(next.equals(rolledBack)).toBe(false); // not served from a process cache
    second.commit();
    const third = db.begin();
    expect((await workspaceKey(third.tx, WS)).equals(next)).toBe(true); // the committed one is the key from then on
    expect(db.committed.get(WS)?.equals(next)).toBe(true);
  });
});

import type { PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { ensureWorkspaceKey, readWorkspaceKey } from '../src/keys.ts';

// The workspace key is made by the handler that marks a source (committed with the work row) and only READ by the drain: a key created inside a
// drain whose transaction rolled back would leave documents named by a key no database has.

const WS = '00000000-0000-7000-8000-00000000a001';

/** A table of keys with a transaction on top: `commit` keeps what the transaction wrote, a transaction nobody commits writes nothing. */
function database() {
  const committed = new Map<string, Buffer>();
  const queries: string[] = [];
  const begin = (): { tx: PluginTx; commit(): void } => {
    const pending = new Map<string, Buffer>();
    const tx = {
      actor: { kind: 'system', id: 'x', workspaceId: WS },
      query: (text: string, values: readonly unknown[] = []) => {
        queries.push(text.slice(0, 20));
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
  return { begin, committed, queries };
}

describe('the workspace key', () => {
  it('is made by ensure, once (a second ensure changes nothing), and read back whole', async () => {
    const db = database();
    const t = db.begin();
    await ensureWorkspaceKey(t.tx, WS);
    const first = await readWorkspaceKey(t.tx, WS);
    await ensureWorkspaceKey(t.tx, WS);
    const second = await readWorkspaceKey(t.tx, WS);
    expect(first).toHaveLength(32);
    expect(second?.equals(first!)).toBe(true);
  });

  it('is never made by a read: a drain that finds none gets null and writes nothing', async () => {
    const db = database();
    const t = db.begin();
    expect(await readWorkspaceKey(t.tx, WS)).toBeNull();
    t.commit();
    expect(db.committed.size).toBe(0);
    expect(db.queries.every((q) => q.startsWith('SELECT key'))).toBe(true);
  });

  it('a key made in a transaction that rolls back is gone; the next one makes its own, and what committed stays the key', async () => {
    const db = database();
    const lost = db.begin();
    await ensureWorkspaceKey(lost.tx, WS); // never committed
    const next = db.begin();
    expect(await readWorkspaceKey(next.tx, WS)).toBeNull(); // nothing of it is remembered anywhere
    await ensureWorkspaceKey(next.tx, WS);
    next.commit();
    const kept = db.committed.get(WS)!;
    const later = db.begin();
    expect((await readWorkspaceKey(later.tx, WS))?.equals(kept)).toBe(true);
    await ensureWorkspaceKey(later.tx, WS);
    later.commit();
    expect(db.committed.get(WS)?.equals(kept)).toBe(true); // never replaced
  });

  it('is read once per drain: the cache of one drain answers its later rows', async () => {
    const db = database();
    const t = db.begin();
    await ensureWorkspaceKey(t.tx, WS);
    t.commit();
    const reader = db.begin();
    const cache = new Map<string, Buffer>();
    await readWorkspaceKey(reader.tx, WS, cache);
    const before = db.queries.length;
    await readWorkspaceKey(reader.tx, WS, cache);
    expect(db.queries.length).toBe(before);
  });
});

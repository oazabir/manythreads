import { randomBytes } from 'node:crypto';
import type { PluginTx } from '@manythreads/sdk';

// The per-workspace key of the feed's keyed digests (`memory_workspace_keys`, system only). Created on first use; a key never changes once it
// exists (a changed key would make every retained document look edited). Cached per process: the value is immutable.

const cache = new Map<string, Buffer>();

export async function workspaceKey(tx: PluginTx, workspaceId: string): Promise<Buffer> {
  const hit = cache.get(workspaceId);
  if (hit) return hit;
  const read = async (): Promise<Buffer | null> =>
    (await tx.query<{ key: Buffer }>('SELECT key FROM app.memory_workspace_keys WHERE workspace_id = $1::uuid', [workspaceId])).rows[0]?.key ?? null;
  let key = await read();
  if (key === null) {
    await tx.query(
      'INSERT INTO app.memory_workspace_keys (workspace_id, key) VALUES ($1::uuid, $2) ON CONFLICT (workspace_id) DO NOTHING',
      [workspaceId, randomBytes(32)],
    );
    key = await read();
  }
  if (key === null) throw new Error('the memory workspace key could not be created');
  cache.set(workspaceId, key);
  return key;
}

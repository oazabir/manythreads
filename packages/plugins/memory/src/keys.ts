import { randomBytes } from 'node:crypto';
import type { PluginTx } from '@manythreads/sdk';

// The per-workspace key of the feed's keyed digests (`memory_workspace_keys`, system only). A key never changes once it exists (a changed key
// would make every retained document look edited), and it must exist BEFORE anything is retained under it: a key created inside a drain whose
// transaction then rolled back would leave documents in the engine named by a key no database has.
//
// So the drain never creates one. The event handlers do (`ensureWorkspaceKey`, in the transaction that marks a source: the key commits together
// with the work row that will need it), and the drain only reads (`readWorkspaceKey`, one read per workspace per drain; never kept past it). A row
// whose key is missing is put off, not retained.

/** Makes the workspace's key if there is none (idempotent: a second call, or a racing one, changes nothing). */
export async function ensureWorkspaceKey(tx: PluginTx, workspaceId: string): Promise<void> {
  await tx.query(
    'INSERT INTO app.memory_workspace_keys (workspace_id, key) VALUES ($1::uuid, $2) ON CONFLICT (workspace_id) DO NOTHING',
    [workspaceId, randomBytes(32)],
  );
}

/** The workspace's key, or null when none was made. `cache` is the caller's, for the length of one drain. */
export async function readWorkspaceKey(tx: PluginTx, workspaceId: string, cache: Map<string, Buffer> = new Map()): Promise<Buffer | null> {
  const hit = cache.get(workspaceId);
  if (hit) return hit;
  const key = (await tx.query<{ key: Buffer }>('SELECT key FROM app.memory_workspace_keys WHERE workspace_id = $1::uuid', [workspaceId])).rows[0]?.key ?? null;
  if (key !== null) cache.set(workspaceId, key);
  return key;
}

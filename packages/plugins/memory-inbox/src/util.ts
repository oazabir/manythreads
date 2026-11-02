import { createHash } from 'node:crypto';
import type { BlobStorage, PluginContext, PluginTx } from '@manythreads/sdk';
import { WS_INBOX_ITEM_CHANGED, type InboxItemChangedPush, type InboxState } from '@manythreads/shared';
import type { ItemRow } from './rows.ts';

export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** The blob store, or an error a job can retry (the plugin that provides it may not have finished loading when the job was queued). */
export function storageOf(ctx: PluginContext): BlobStorage {
  const storage = ctx.providers.get<BlobStorage>('storage');
  if (!storage) throw new Error('The blob store is not available');
  return storage;
}

async function readAll(stream: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of stream) {
    total += part.length;
    if (total > maxBytes) return null;
    parts.push(part);
  }
  return Buffer.concat(parts);
}

/** The stored original, or null when it is gone or larger than `maxBytes`. */
export async function readBlob(storage: BlobStorage, blobKey: string, maxBytes: number): Promise<Uint8Array | null> {
  try {
    return await readAll(await storage.get(blobKey), maxBytes);
  } catch {
    return null;
  }
}

/** The workspace's model-guard preset, when the model gateway keeps one (`standard` otherwise). */
export async function egressPreset(tx: PluginTx, workspaceId: string): Promise<{ preset: string; allowlist: string[] }> {
  const present = (await tx.query<{ ok: boolean }>(`SELECT to_regclass('app.llm_settings') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  if (!present) return { preset: 'standard', allowlist: [] };
  const row = (await tx.query<{ preset: string; egress_allowlist: string[] }>('SELECT preset, egress_allowlist FROM app.llm_settings WHERE workspace_id = $1::uuid', [workspaceId])).rows[0];
  return { preset: row?.preset ?? 'standard', allowlist: row?.egress_allowlist ?? [] };
}

/** Runs `fn` so that a failure leaves the transaction usable: the repo write is the one step that may fail for reasons outside the database. */
export async function attempt<T>(tx: PluginTx, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  await tx.query('SAVEPOINT memory_inbox_attempt');
  try {
    const value = await fn();
    await tx.query('RELEASE SAVEPOINT memory_inbox_attempt');
    return { ok: true, value };
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT memory_inbox_attempt');
    await tx.query('RELEASE SAVEPOINT memory_inbox_attempt');
    return { ok: false, error };
  }
}

/** The HTTP-like status a repo write error carries, or null for an error that is not the writer's refusal (a lost connection, a bug). */
export function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

/** The dropper's open tabs read the item again (delivered when `tx` commits). The persistent notification table is channel-bound, so this is a live push only. */
export async function notifyDropper(ctx: PluginContext, tx: PluginTx, item: Pick<ItemRow, 'id' | 'team_id' | 'dropper_id'>, state: InboxState): Promise<void> {
  if (item.dropper_id === null) return;
  const person = (await tx.query<{ ref_id: string }>(`SELECT ref_id FROM app.actors WHERE id = $1 AND kind = 'person'`, [item.dropper_id])).rows[0];
  if (!person) return;
  const payload: InboxItemChangedPush = { teamId: item.team_id, itemId: item.id, state } as InboxItemChangedPush;
  await ctx.realtime.pushToPerson(tx, person.ref_id, WS_INBOX_ITEM_CHANGED, payload);
}

/** Locks one item row for the rest of the transaction; undefined when it is gone. */
export async function lockItem(tx: PluginTx, itemId: string): Promise<ItemRow | undefined> {
  return (await tx.query<ItemRow>('SELECT i.* FROM app.memory_inbox_items i WHERE i.id = $1 FOR UPDATE', [itemId])).rows[0];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** The payload of every pipeline job: checked, because it is whatever was enqueued. */
export function payloadOf(payload: Record<string, unknown>): { workspaceId: string; itemId: string } | null {
  return isUuid(payload['workspaceId']) && isUuid(payload['itemId']) ? { workspaceId: payload['workspaceId'], itemId: payload['itemId'] } : null;
}

import { forbidden, type BlobStorage, type PluginContext, type PluginTx, type TeamRow } from '@manythreads/sdk';
import { InboxItemResponse, type InboxKind, type InboxOrigin } from '@manythreads/shared';
import { ITEM_COLUMNS, toItem, type ItemRow } from './rows.ts';

// Step 1 of the pipeline, "receive" (SPEC §12.2): the item is recorded with its SHA-256 and its dropper; identical bytes already in the inbox make it a
// `duplicate` (the first item is named, nothing is read again); anything else is queued and the hold check is scheduled. Every door (a file, a note,
// a message, a bot) ends here, so they all get the same dedupe, the same event and the same first job.

export const HOLD_QUEUE = 'memory-inbox.hold';
export const EXTRACT_QUEUE = 'memory-inbox.extract';
export const DISTIL_QUEUE = 'memory-inbox.distil';
export const COMMIT_QUEUE = 'memory-inbox.commit';
export const SWEEP_QUEUE = 'memory-inbox.sweep';
export const KEEP_QUEUE = 'memory-inbox.keep';

/** States in which an earlier drop of the same bytes counts: it is still on its way, or it was filed. A discarded or failed one does not. */
const LIVE_STATES = ['queued', 'extracting', 'filing', 'filed', 'held', 'needs_review'];

export interface DropInput {
  team: TeamRow;
  origin: InboxOrigin;
  kind: InboxKind;
  name: string;
  size: number;
  sha256: string;
  blobKey: string;
  teamOnly: boolean;
  sourceChannelId?: string | null;
  sourceMessageId?: string | null;
}

export interface DropResult {
  item: ItemRow;
  duplicate: boolean;
  /** The blob key to delete because the bytes already exist under another item; null when the new blob is the item's original. */
  discardBlob: string | null;
}

/** May the caller drop into this team? A person with post rights; a guest and an outsider cannot. */
export async function requireDrop(tx: PluginTx, team: TeamRow): Promise<void> {
  const ok = (await tx.query<{ ok: boolean }>("SELECT app.can('team', $1, 'post') AS ok", [team.id])).rows[0]?.ok === true;
  if (!ok) throw forbidden('Only people on this team can drop things into its memory.');
}

/** The caller's display name, or null (a bot, or a person with no name on file). */
async function nameOfCaller(tx: PluginTx): Promise<string | null> {
  const row = (
    await tx.query<{ name: string | null }>(
      `SELECT p.display_name AS name FROM app.actors a JOIN app.people p ON a.kind = 'person' AND p.id = a.ref_id WHERE a.id = $1`,
      [tx.actor.id],
    )
  ).rows[0];
  return row?.name ?? null;
}

export async function recordDrop(ctx: PluginContext, tx: PluginTx, input: DropInput): Promise<DropResult> {
  const first = (
    await tx.query<{ id: string }>(
      `SELECT id FROM app.memory_inbox_items WHERE team_id = $1 AND sha256 = $2 AND state = ANY ($3::text[]) ORDER BY created_at, id LIMIT 1`,
      [input.team.id, input.sha256, LIVE_STATES],
    )
  ).rows[0];
  const name = (await nameOfCaller(tx))?.slice(0, 200) ?? null;
  const duplicate = first !== undefined;
  const inserted = (
    await tx.query<ItemRow>(
      `INSERT INTO app.memory_inbox_items AS i
         (workspace_id, team_id, origin, state, stage, kind, name, size, sha256, blob_key, dropper_id, dropper_name, team_only, reason, duplicate_of, source_channel_id, source_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING ${ITEM_COLUMNS}`,
      [
        input.team.workspace_id,
        input.team.id,
        input.origin,
        duplicate ? 'duplicate' : 'queued',
        duplicate ? 'done' : 'hold',
        input.kind,
        input.name,
        input.size,
        input.sha256,
        duplicate ? null : input.blobKey,
        tx.actor.id,
        name,
        input.teamOnly,
        duplicate ? 'The same file is already in this team’s inbox, so nothing was written again.' : null,
        first?.id ?? null,
        input.sourceChannelId ?? null,
        input.sourceMessageId ?? null,
      ],
    )
  ).rows[0] as ItemRow;
  const at = ctx.runtime.now().toISOString();
  await ctx.audit.emit(tx, {
    type: 'memory.item.dropped',
    workspaceId: input.team.workspace_id,
    teamId: input.team.id,
    itemId: inserted.id,
    origin: input.origin,
    kind: input.kind,
    size: input.size,
    teamOnly: input.teamOnly,
    duplicate,
    droppedBy: tx.actor.id,
    at,
  });
  if (!duplicate) {
    await ctx.jobs.enqueue(tx, HOLD_QUEUE, { workspaceId: input.team.workspace_id, itemId: inserted.id }, { dedupeKey: `hold:${inserted.id}` });
  }
  return { item: inserted, duplicate, discardBlob: duplicate ? input.blobKey : null };
}

/** What a door adds to the bytes it already stored: everything `recordDrop` needs except the team, the size, the hash and the blob. */
export type DropDetails = Omit<DropInput, 'team' | 'size' | 'sha256' | 'blobKey'>;

/** Records a drop whose bytes are already in the blob store; the blob goes again if the record cannot be made or the same bytes are already in the inbox. */
export async function recordStored(
  ctx: PluginContext,
  tx: PluginTx,
  team: TeamRow,
  storage: BlobStorage,
  blobKey: string,
  sha256: string,
  size: number,
  details: DropDetails,
): Promise<InboxItemResponse> {
  try {
    const done = await recordDrop(ctx, tx, { ...details, team, size, sha256, blobKey });
    if (done.discardBlob) await storage.delete(done.discardBlob).catch(() => false);
    return InboxItemResponse.parse({ item: toItem(done.item), duplicate: done.duplicate });
  } catch (err) {
    // The row never committed (the transaction rolls back): do not leave bytes nobody can reach.
    await storage.delete(blobKey).catch(() => false);
    throw err;
  }
}

/** Stores `bytes` (a note, a message, a bot's text) and records the drop. */
export async function dropBytes(ctx: PluginContext, tx: PluginTx, team: TeamRow, storage: BlobStorage, bytes: Uint8Array, details: DropDetails): Promise<InboxItemResponse> {
  const stored = await storage.put(
    (async function* () {
      yield bytes;
    })(),
    { maxBytes: bytes.length + 1 },
  );
  return recordStored(ctx, tx, team, storage, stored.blobKey, stored.sha256, stored.size, details);
}

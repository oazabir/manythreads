import { createHash } from 'node:crypto';
import { forbidden, type BlobStorage, type JobInfo, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  PersonalInboxItem,
  PersonalInboxItemResponse,
  conceptText,
  conceptTitle,
  validateOkfWrite,
  type InboxKind,
  type InboxOrigin,
  type InboxState,
} from '@manythreads/shared';
import { PLATFORM_PRODUCER, REFERENCE_TEXT_MAX } from './commit.ts';
import { slugOf } from './kinds.ts';
import { readItem } from './pipeline.ts';
import { inboxMaxBytes } from './upload.ts';
import { egressPreset, isUuid, readBlob, storageOf } from './util.ts';

// A person's own inbox (P20-04). The same idea as the team's — receive, check, read, file — on a shorter road, because nothing here belongs to a team: no team rules, no
// Archivist, no review by a lead. The owner is the only person who sees an item (an admin only during a live audited open of the space), and what is filed is a Reference in
// the owner's own Memory. Held items (private data in the text, a very large file, a bundle from elsewhere) wait for the owner to release or discard them.

export const PERSONAL_HOLD_QUEUE = 'memory-inbox.personal-hold';
export const PERSONAL_FILE_QUEUE = 'memory-inbox.personal-file';
export const PERSONAL_SWEEP_QUEUE = 'memory-inbox.personal-sweep';

/** States in which an earlier drop of the same bytes counts: it is still on its way, or it was filed. A discarded or failed one does not. */
const LIVE_STATES = ['queued', 'extracting', 'filing', 'filed', 'held'];
/** An item running for this long has lost its job (a crash, a restart): it goes back in the queue. */
export const PERSONAL_STUCK_MINUTES = 30;
export const PERSONAL_MAX_TRIES = 5;
const SWEEP_BATCH = 100;
const cut = (text: string, max = 400): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export interface PersonalRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  owner_person_id: string;
  origin: string;
  state: string;
  stage: string;
  kind: string;
  name: string;
  size: string | number;
  sha256: string;
  blob_key: string | null;
  dropper_id: string | null;
  dropper_name: string | null;
  reason: string | null;
  hold_reason: string | null;
  duplicate_of: string | null;
  source_channel_id: string | null;
  source_message_id: string | null;
  filed_paths: string[];
  attempts: number;
  failed_stage: string | null;
  released_at: Date | null;
  original_removed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  filed_at: Date | null;
}

export function toPersonalItem(r: PersonalRow): PersonalInboxItem {
  return PersonalInboxItem.parse({
    id: r.id,
    personId: r.owner_person_id,
    space: `person:${r.owner_person_id}`,
    origin: r.origin,
    state: r.state,
    kind: r.kind,
    name: r.name,
    size: Number(r.size),
    sha256: r.sha256,
    droppedBy: r.dropper_id,
    droppedByName: r.dropper_name,
    teamOnly: false,
    reason: r.reason,
    holdReason: r.hold_reason,
    duplicateOf: r.duplicate_of,
    parentId: null,
    sender: null,
    senderCheck: null,
    filedPaths: r.filed_paths,
    commitSha: null,
    originalKept: r.blob_key !== null,
    attempts: r.attempts,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    filedAt: r.filed_at ? r.filed_at.toISOString() : null,
  });
}

export interface Me {
  personId: string;
  workspaceId: string;
}

/** The signed-in person: a Personal inbox has one owner and no way to name another. A guest has none. */
export async function requireMe(tx: PluginTx): Promise<Me> {
  const row = (await tx.query<{ person_id: string | null; role: string | null }>('SELECT app.person_id() AS person_id, app.workspace_role() AS role')).rows[0];
  if (!row?.person_id) throw forbidden('Only a person has a Personal inbox.');
  if (row.role === 'guest') throw forbidden('A guest has no Personal space.');
  return { personId: row.person_id, workspaceId: tx.actor.workspaceId };
}

/** One event per move an item makes; it carries ids and sizes, never the name or the text. */
export async function changed(ctx: PluginContext, tx: PluginTx, row: PersonalRow, state: InboxState, duplicate = false): Promise<void> {
  await ctx.audit.emit(tx, {
    type: 'memory.personal_item.changed',
    workspaceId: row.workspace_id,
    personId: row.owner_person_id,
    itemId: row.id,
    state,
    origin: row.origin as InboxOrigin,
    kind: row.kind as InboxKind,
    size: Number(row.size),
    duplicate,
    at: ctx.runtime.now().toISOString(),
  });
}

// ---- receive --------------------------------------------------------------------------------------------------------------------------

export interface PersonalDropInput {
  origin: 'person' | 'message';
  kind: InboxKind;
  name: string;
  size: number;
  sha256: string;
  blobKey: string;
  sourceChannelId?: string | null;
  sourceMessageId?: string | null;
}

export async function recordPersonalDrop(ctx: PluginContext, tx: PluginTx, me: Me, input: PersonalDropInput): Promise<{ item: PersonalRow; duplicate: boolean; discardBlob: string | null }> {
  const first = (
    await tx.query<{ id: string }>(
      `SELECT id FROM app.memory_personal_inbox_items WHERE owner_person_id = $1::uuid AND sha256 = $2 AND state = ANY ($3::text[]) ORDER BY created_at, id LIMIT 1`,
      [me.personId, input.sha256, LIVE_STATES],
    )
  ).rows[0];
  const name = (await tx.query<{ name: string | null }>('SELECT display_name AS name FROM app.people WHERE id = $1::uuid', [me.personId])).rows[0]?.name ?? null;
  const duplicate = first !== undefined;
  const inserted = (
    await tx.query<PersonalRow>(
      `INSERT INTO app.memory_personal_inbox_items
         (workspace_id, owner_person_id, origin, state, stage, kind, name, size, sha256, blob_key, dropper_id, dropper_name, reason, duplicate_of, source_channel_id, source_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        me.workspaceId,
        me.personId,
        input.origin,
        duplicate ? 'duplicate' : 'queued',
        duplicate ? 'done' : 'hold',
        input.kind,
        input.name,
        input.size,
        input.sha256,
        duplicate ? null : input.blobKey,
        tx.actor.id,
        name?.slice(0, 200) ?? null,
        duplicate ? 'The same file is already in your inbox, so nothing was written again.' : null,
        first?.id ?? null,
        input.sourceChannelId ?? null,
        input.sourceMessageId ?? null,
      ],
    )
  ).rows[0] as PersonalRow;
  await changed(ctx, tx, inserted, duplicate ? 'duplicate' : 'queued', duplicate);
  if (!duplicate) await ctx.jobs.enqueue(tx, PERSONAL_HOLD_QUEUE, { workspaceId: me.workspaceId, itemId: inserted.id }, { dedupeKey: `phold:${inserted.id}` });
  return { item: inserted, duplicate, discardBlob: duplicate ? input.blobKey : null };
}

/** Records a drop whose bytes are already in the blob store; the blob goes again if the record cannot be made or the same bytes are already in the inbox. */
export async function recordPersonalStored(
  ctx: PluginContext,
  tx: PluginTx,
  me: Me,
  storage: BlobStorage,
  stored: { blobKey: string; sha256: string; size: number },
  details: Omit<PersonalDropInput, 'size' | 'sha256' | 'blobKey'>,
): Promise<PersonalInboxItemResponse> {
  try {
    const done = await recordPersonalDrop(ctx, tx, me, { ...details, size: stored.size, sha256: stored.sha256, blobKey: stored.blobKey });
    if (done.discardBlob) await storage.delete(done.discardBlob).catch(() => false);
    return PersonalInboxItemResponse.parse({ item: toPersonalItem(done.item), duplicate: done.duplicate });
  } catch (err) {
    // The row never committed (the transaction rolls back): do not leave bytes nobody can reach.
    await storage.delete(stored.blobKey).catch(() => false);
    throw err;
  }
}

/** Stores `bytes` (a note, a message) and records the drop. */
export async function dropPersonalBytes(
  ctx: PluginContext,
  tx: PluginTx,
  me: Me,
  storage: BlobStorage,
  bytes: Uint8Array,
  details: Omit<PersonalDropInput, 'size' | 'sha256' | 'blobKey'>,
): Promise<PersonalInboxItemResponse> {
  const stored = await storage.put(
    (async function* () {
      yield bytes;
    })(),
    { maxBytes: bytes.length + 1 },
  );
  return recordPersonalStored(ctx, tx, me, storage, stored, details);
}

// ---- moves ----------------------------------------------------------------------------------------------------------------------------

async function lockPersonal(tx: PluginTx, itemId: string): Promise<PersonalRow | undefined> {
  return (await tx.query<PersonalRow>('SELECT * FROM app.memory_personal_inbox_items WHERE id = $1 FOR UPDATE', [itemId])).rows[0];
}

export async function holdPersonal(ctx: PluginContext, tx: PluginTx, row: PersonalRow, reason: 'foreign_bundle' | 'dlp' | 'oversize', message: string): Promise<void> {
  await tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'held', hold_reason = $2, reason = $3 WHERE id = $1`, [row.id, reason, cut(message)]);
  await changed(ctx, tx, row, 'held');
}

export async function failPersonal(ctx: PluginContext, tx: PluginTx, row: PersonalRow, stage: 'extract' | 'commit', message: string): Promise<void> {
  await tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'failed', failed_stage = $2, reason = $3 WHERE id = $1`, [row.id, stage, cut(message)]);
  await changed(ctx, tx, row, 'failed');
}

// ---- hold check -----------------------------------------------------------------------------------------------------------------------

/** The hold rules of a Personal inbox as a pure function. `released` is the owner's own answer to an earlier hold: it ends the check. Nothing is held for "review": the owner is the reviewer. */
export function personalHoldVerdict(facts: { kind: string; size: number | string }, released: boolean, maxBytes: number = inboxMaxBytes()): { reason: 'foreign_bundle' | 'oversize'; message: string } | null {
  if (released) return null;
  if (facts.kind === 'bundle') return { reason: 'foreign_bundle', message: 'This looks like a memory bundle from somewhere else. Release it only if you trust where it came from.' };
  if (Number(facts.size) > maxBytes) {
    return { reason: 'oversize', message: `This is larger than the ${Math.max(1, Math.floor(maxBytes / 1024 / 1024))} MB allowed for one drop. Release it to let it in anyway.` };
  }
  return null;
}

export async function personalHoldStep(ctx: PluginContext, tx: PluginTx, itemId: string): Promise<void> {
  const row = await lockPersonal(tx, itemId);
  if (!row || row.state !== 'queued' || row.stage !== 'hold') return;
  const verdict = personalHoldVerdict(row, row.released_at !== null);
  if (verdict) {
    await holdPersonal(ctx, tx, row, verdict.reason, verdict.message);
    return;
  }
  await tx.query(`UPDATE app.memory_personal_inbox_items SET stage = 'extract' WHERE id = $1`, [row.id]);
  await ctx.jobs.enqueue(tx, PERSONAL_FILE_QUEUE, { workspaceId: row.workspace_id, itemId: row.id }, { dedupeKey: `pfile:${row.id}` });
}

// ---- read and file --------------------------------------------------------------------------------------------------------------------

const withoutLoneSurrogate = (text: string): string => (/[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text);

/** Where the Reference of an item lives in the owner's bundle: fixed from the item's id, so a second run writes the same file instead of a second one. */
export function personalReferencePath(row: Pick<PersonalRow, 'id' | 'name'>, title: string | null): string {
  return `memory/references/${slugOf(title ?? row.name)}-${row.id.replace(/-/g, '').slice(-8)}.md`;
}

/** The Reference concept of an item: the text (shortened if long) and where the original is, in the shape the team's inbox files too. */
export function personalReferenceConcept(row: Pick<PersonalRow, 'id' | 'name' | 'kind'>, extract: { text: string; title: string | null }, at: string): string {
  const title = (extract.title ?? row.name).slice(0, 500);
  const full = extract.text.length > REFERENCE_TEXT_MAX;
  const shown = full ? withoutLoneSurrogate(extract.text.slice(0, REFERENCE_TEXT_MAX)) : extract.text;
  const resource = `personal-inbox/${row.id}`;
  const frontmatter: Record<string, unknown> = {
    type: 'Reference',
    title,
    description: `The text of ${row.name}, dropped into your inbox.`.slice(0, 2000),
    tags: [row.kind],
    resource,
    sources: [{ resource, title: row.name.slice(0, 500) }],
    generated: { by: PLATFORM_PRODUCER, at },
    origin: 'drop',
  };
  const note = full ? `\n\n(Shortened: the first ${REFERENCE_TEXT_MAX.toLocaleString('en-US')} of ${extract.text.length.toLocaleString('en-US')} characters. The original has all of it.)` : '';
  return conceptText(frontmatter, `# ${title.replace(/\s+/g, ' ')}\n\nFiled from your inbox (\`${row.name}\`).\n\n## Text\n\n${shown}${note}\n`);
}

const blobShaOf = (text: string): string => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text, 'utf8').digest('hex');

/** Saves a Reference into the owner's bundle through the database door; answers the door's status. */
export async function putPersonalReference(tx: PluginTx, ownerPersonId: string, path: string, text: string, at: string, tag: string): Promise<'ok' | 'unchanged' | 'too_many_files' | 'too_large' | 'invalid' | 'forbidden'> {
  const verdict = validateOkfWrite(path, text);
  if (!verdict.ok) return 'invalid';
  const fm = verdict.frontmatter;
  const meta = {
    type: fm.type,
    title: conceptTitle(path, fm),
    description: fm.description ?? null,
    tags: fm.tags ?? [tag],
    status: fm.status ?? 'stable',
    stale_after: null,
    trust_tier: 'unverified',
    origin: fm.origin ?? 'drop',
    share_never: false,
    generated_at: at,
    blob_sha: blobShaOf(text),
    person_owned: false,
  };
  const row = (
    await tx.query<{ status: string }>('SELECT status FROM app.memory_personal_put($1::uuid, $2, $3, $4::jsonb, NULL, false)', [ownerPersonId, path, text, JSON.stringify(meta)])
  ).rows[0];
  const status = row?.status ?? 'forbidden';
  return status === 'ok' || status === 'unchanged' || status === 'too_many_files' || status === 'too_large' ? status : 'forbidden';
}

export async function personalFileStep(ctx: PluginContext, job: JobInfo, itemId: string): Promise<void> {
  // Take the item: it must be at the read step and waiting (or marked running by a job that crashed).
  const taken = await job.transaction(async (tx) => {
    const row = await lockPersonal(tx, itemId);
    if (!row || row.stage !== 'extract' || (row.state !== 'queued' && row.state !== 'extracting')) return null;
    return (
      await tx.query<PersonalRow>(
        `UPDATE app.memory_personal_inbox_items SET state = 'extracting', attempts = attempts + CASE WHEN state = 'queued' THEN 1 ELSE 0 END, reason = NULL WHERE id = $1 RETURNING *`,
        [itemId],
      )
    ).rows[0] as PersonalRow;
  });
  if (!taken) return;
  const read = await readItem(ctx, taken, job.log);
  await job.transaction(async (tx) => {
    const cur = await lockPersonal(tx, itemId);
    if (!cur || cur.stage !== 'extract' || cur.state !== 'extracting') return;
    if (!read.ok) {
      await failPersonal(ctx, tx, cur, 'extract', read.message);
      return;
    }
    // The text is about to be kept where a bot the owner allows can read it: the workspace's guards see it first, as they see any text going into memory. A finding
    // holds the item for the owner, who decides; once released it goes through as written (never past a preset that refuses).
    const released = cur.released_at !== null;
    const setup = await egressPreset(tx, cur.workspace_id);
    const decision = await ctx.hooks.runPreEgress(tx, {
      destination: 'memory_inbox',
      workspaceId: cur.workspace_id,
      text: read.text,
      preset: setup.preset,
      allowlist: setup.allowlist,
      mode: released ? 'approved' : 'hold',
      recorded: false,
    });
    let text = read.text;
    if (decision.hooks > 0) {
      if (decision.outcome === 'block') {
        await failPersonal(ctx, tx, cur, 'extract', decision.message ?? 'The workspace’s data rules do not let this text into memory.');
        return;
      }
      if (decision.outcome === 'require_approval') {
        await holdPersonal(ctx, tx, cur, 'dlp', 'Something in this looks like private data (a key, a card number or the like). Release it if you want it kept anyway.');
        return;
      }
      if (decision.outcome === 'redact') text = decision.text;
    }
    const at = ctx.runtime.now().toISOString();
    const path = personalReferencePath(cur, read.title);
    const status = await putPersonalReference(tx, cur.owner_person_id, path, personalReferenceConcept(cur, { text, title: read.title }, at), at, cur.kind);
    if (status === 'too_many_files') {
      await failPersonal(ctx, tx, cur, 'commit', 'Your Memory already holds the most files it can (2,000). Remove some and retry.');
      return;
    }
    if (status !== 'ok' && status !== 'unchanged') {
      await failPersonal(ctx, tx, cur, 'commit', 'Your Memory did not accept this. Retry tries again.');
      return;
    }
    await tx.query(
      `UPDATE app.memory_personal_inbox_items
          SET state = 'filed', stage = 'done', filed_paths = ARRAY[$2]::text[], filed_at = now(), failed_stage = NULL, reason = NULL
        WHERE id = $1`,
      [cur.id, path],
    );
    await changed(ctx, tx, cur, 'filed');
  });
}

// ---- sweep ----------------------------------------------------------------------------------------------------------------------------

/** One pass of the sweep; exported for the tests. Returns how many items it moved. */
export async function personalSweep(ctx: PluginContext, tx: PluginTx): Promise<number> {
  let moved = 0;
  const stuck = (
    await tx.query<PersonalRow>(
      `SELECT * FROM app.memory_personal_inbox_items WHERE state IN ('extracting', 'filing') AND updated_at < now() - make_interval(mins => $1) ORDER BY updated_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [PERSONAL_STUCK_MINUTES, SWEEP_BATCH],
    )
  ).rows;
  for (const row of stuck) {
    moved += 1;
    if (row.attempts >= PERSONAL_MAX_TRIES) await failPersonal(ctx, tx, row, 'extract', 'This took too many tries and was stopped. Retry puts it back in the queue.');
    else await tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'queued' WHERE id = $1`, [row.id]);
  }
  const due = (
    await tx.query<PersonalRow>(
      `SELECT * FROM app.memory_personal_inbox_items WHERE state = 'queued' AND stage IN ('hold', 'extract') AND updated_at < now() - interval '2 minutes' ORDER BY updated_at LIMIT $1`,
      [SWEEP_BATCH],
    )
  ).rows;
  for (const row of due) {
    moved += 1;
    const queue = row.stage === 'hold' ? PERSONAL_HOLD_QUEUE : PERSONAL_FILE_QUEUE;
    await ctx.jobs.enqueue(tx, queue, { workspaceId: row.workspace_id, itemId: row.id }, { dedupeKey: `${row.stage === 'hold' ? 'phold' : 'pfile'}:${row.id}` });
  }
  return moved;
}

/** The payload of a Personal job: checked, because it is whatever was enqueued. */
export function personalPayloadOf(payload: Record<string, unknown>): { workspaceId: string; itemId: string } | null {
  return isUuid(payload['workspaceId']) && isUuid(payload['itemId']) ? { workspaceId: payload['workspaceId'], itemId: payload['itemId'] } : null;
}

/** The stored original of an item the owner may still read, or null when it is gone or too large. */
export async function personalOriginal(ctx: PluginContext, row: Pick<PersonalRow, 'blob_key' | 'size'>, maxBytes: number): Promise<Uint8Array | null> {
  if (row.blob_key === null) return null;
  return readBlob(storageOf(ctx), row.blob_key, Math.min(Number(row.size) + 1, maxBytes));
}

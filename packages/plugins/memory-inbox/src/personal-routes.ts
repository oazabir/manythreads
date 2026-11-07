import {
  BlobTooLargeError,
  HttpError,
  conflict,
  invalid,
  json,
  notFound,
  requireTeam,
  route,
  type BlobStorage,
  type PluginContext,
  type PluginTx,
} from '@manythreads/sdk';
import {
  CreatePersonalInboxNoteRequest,
  GetPersonalInboxItemResponse,
  INBOX_NAME_MAX,
  ListPersonalInboxQuery,
  ListPersonalInboxResponse,
  PersonalInboxActionResponse,
  PersonalInboxItemParams,
  PersonalInboxItemResponse,
  SendPersonalInboxToTeamRequest,
  SendPersonalInboxToTeamResponse,
  UploadPersonalInboxQuery,
  createPersonalInboxNoteRoute,
  discardPersonalInboxRoute,
  getPersonalInboxItemRoute,
  listPersonalInboxRoute,
  releasePersonalInboxRoute,
  retryPersonalInboxRoute,
  sendPersonalInboxToTeamRoute,
  uploadPersonalInboxRoute,
  type InboxKind,
} from '@manythreads/shared';
import { kindOfName, linkOnly } from './kinds.ts';
import {
  PERSONAL_FILE_QUEUE,
  PERSONAL_HOLD_QUEUE,
  changed,
  dropPersonalBytes,
  personalOriginal,
  recordPersonalStored,
  requireMe,
  toPersonalItem,
  type PersonalRow,
} from './personal.ts';
import { dropBytes, requireDrop } from './receive.ts';
import { allowDrop, cleanName, inboxMaxBytes, takeUploadSlot, tapped, type ReadableLike } from './upload.ts';

// The routes of a person's own inbox (P20-04): `/api/me/inbox/*`. Everything acts as the signed-in person on their own items; there is no way to name another person (the owner
// is never a parameter), and the database enforces the same. docs/plugins/memory-inbox.md.

const tooLarge = (message: string): HttpError => new HttpError(413, 'validation_failed', message);
const MB = (bytes: number): number => Math.max(1, Math.floor(bytes / 1024 / 1024));

/** The first line of a note, without Markdown marks, as its name. */
const nameFromText = (text: string): string => {
  // eslint-disable-next-line no-control-regex
  const line = (text.split('\n').find((l) => l.trim().length > 0) ?? '').replace(/^[#>*\-\s]+/, '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return (line.length > 80 ? `${line.slice(0, 79)}…` : line) || 'Note';
};

async function requireItem(tx: PluginTx, personId: string, itemId: string, lock = false): Promise<PersonalRow> {
  const row = (await tx.query<PersonalRow>(`SELECT * FROM app.memory_personal_inbox_items WHERE id = $1 AND owner_person_id = $2::uuid${lock ? ' FOR UPDATE' : ''}`, [itemId, personId])).rows[0];
  if (!row) throw notFound('No such item in your inbox');
  return row;
}

export function registerPersonalInboxRoutes(ctx: PluginContext): void {
  const storageOf = (): BlobStorage => {
    const storage = ctx.providers.get<BlobStorage>('storage');
    if (!storage) throw new HttpError(503, 'internal', 'File storage is not available');
    return storage;
  };

  ctx.http.route({
    ...listPersonalInboxRoute,
    schema: { query: ListPersonalInboxQuery, response: ListPersonalInboxResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const query = ListPersonalInboxQuery.parse(req.query);
      const rows = await tx.query<PersonalRow>(
        `SELECT * FROM app.memory_personal_inbox_items
          WHERE owner_person_id = $1::uuid AND (($2::text IS NULL AND state <> 'discarded') OR state = $2::text)
          ORDER BY id DESC LIMIT $3`,
        [me.personId, query.state ?? null, query.limit],
      );
      return json({ items: rows.rows.map(toPersonalItem), maxBytes: inboxMaxBytes() });
    }),
  });

  ctx.http.route({
    ...getPersonalInboxItemRoute,
    schema: { response: GetPersonalInboxItemResponse },
    rateLimit: { limit: 240, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const { itemId } = PersonalInboxItemParams.parse(req.params);
      return json({ item: toPersonalItem(await requireItem(tx, me.personId, itemId)) });
    }),
  });

  // Door 1: a file. The body is the file itself, streamed to the blob store (never held in memory), under the rules MISTAKES.md teaches for an upload.
  ctx.http.route({
    ...uploadPersonalInboxRoute,
    rawBody: true,
    schema: { query: UploadPersonalInboxQuery, response: PersonalInboxItemResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const query = UploadPersonalInboxQuery.parse(req.query);
      const source = req.stream;
      if (!source) throw invalid('The body must be the file');
      const drain = (): void => void (source as ReadableLike).resume?.();
      const name = cleanName(req.headers['x-file-name']) ?? cleanName(query.name);
      if (!name) {
        drain();
        throw invalid('Say what the file is called (the name= part of the address).');
      }
      const kind = kindOfName(name);
      if (kind === 'unknown') {
        drain();
        throw new HttpError(415, 'validation_failed', 'That kind of file cannot be dropped. Markdown, text, CSV, PDF, Word, PowerPoint, Excel and email files can; pictures and recordings are kept but cannot be read yet.');
      }
      const limit = inboxMaxBytes();
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) {
        drain();
        throw tooLarge(`That file is larger than the ${MB(limit)} MB limit.`);
      }
      if (!allowDrop(tx.actor.id)) {
        drain();
        throw new HttpError(429, 'rate_limited', 'You are dropping things faster than the inbox allows. Wait a minute and try again.');
      }
      const storage = storageOf();
      const release = takeUploadSlot(tx.actor.id);
      if (!release) {
        drain();
        throw new HttpError(429, 'rate_limited', 'Too many uploads at once: wait for one to finish.');
      }
      const body = tapped(source);
      let stored;
      try {
        stored = await storage.put(body.stream, { maxBytes: limit });
      } catch (err) {
        body.drain();
        if (err instanceof BlobTooLargeError) throw tooLarge(`That file is larger than the ${MB(limit)} MB limit.`);
        throw invalid('The upload was interrupted.');
      } finally {
        release();
      }
      if (stored.size === 0) {
        await storage.delete(stored.blobKey).catch(() => false);
        throw invalid('That file is empty.');
      }
      const result = await recordPersonalStored(ctx, tx, me, storage, stored, { origin: 'person', kind, name });
      return json(result, result.duplicate ? 200 : 201);
    }),
  });

  // Door 2: a note. Pasted text, with an optional title; a text that is only a web address is filed as a link and the page is never fetched.
  ctx.http.route({
    ...createPersonalInboxNoteRoute,
    schema: { body: CreatePersonalInboxNoteRequest, response: PersonalInboxItemResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const note = CreatePersonalInboxNoteRequest.parse(req.body);
      if (!allowDrop(tx.actor.id)) throw new HttpError(429, 'rate_limited', 'You are dropping things faster than the inbox allows. Wait a minute and try again.');
      const url = linkOnly(note.text);
      const kind: InboxKind = url ? 'link' : 'markdown';
      const text = url ?? (note.title ? `# ${note.title}\n\n${note.text}\n` : `${note.text}\n`);
      const name = (note.title ?? (url ?? nameFromText(note.text))).slice(0, INBOX_NAME_MAX);
      const result = await dropPersonalBytes(ctx, tx, me, storageOf(), new TextEncoder().encode(text), { origin: 'person', kind, name });
      return json(result, result.duplicate ? 200 : 201);
    }),
  });

  // Release: the owner lets a held item in (it skips the hold check from then on).
  ctx.http.route({
    ...releasePersonalInboxRoute,
    schema: { response: PersonalInboxActionResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const { itemId } = PersonalInboxItemParams.parse(req.params);
      const row = await requireItem(tx, me.personId, itemId, true);
      if (row.state !== 'held') throw conflict('Only a held item can be released.');
      // A DLP hold is found while reading, so it goes back to the read; a size or bundle hold goes back to the start.
      const stage = row.hold_reason === 'dlp' ? 'extract' : 'hold';
      const updated = (
        await tx.query<PersonalRow>(`UPDATE app.memory_personal_inbox_items SET state = 'queued', stage = $2, reason = NULL, hold_reason = NULL, released_at = now() WHERE id = $1 RETURNING *`, [row.id, stage])
      ).rows[0] as PersonalRow;
      await changed(ctx, tx, updated, 'queued');
      await ctx.jobs.enqueue(tx, stage === 'hold' ? PERSONAL_HOLD_QUEUE : PERSONAL_FILE_QUEUE, { workspaceId: updated.workspace_id, itemId: updated.id }, { dedupeKey: `${stage === 'hold' ? 'phold' : 'pfile'}:${updated.id}` });
      return json({ item: toPersonalItem(updated) });
    }),
  });

  // Discard: the owner throws an item away. The original is deleted with it. What an item already filed stays in Memory (it is a file there, with its own history).
  ctx.http.route({
    ...discardPersonalInboxRoute,
    schema: { response: PersonalInboxActionResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const { itemId } = PersonalInboxItemParams.parse(req.params);
      const row = await requireItem(tx, me.personId, itemId, true);
      if (!['queued', 'held', 'failed'].includes(row.state)) {
        throw conflict(row.state === 'extracting' || row.state === 'filing' ? 'This item is being filed right now. Try again in a moment.' : 'This item cannot be discarded any more.');
      }
      const updated = (
        await tx.query<PersonalRow>(`UPDATE app.memory_personal_inbox_items SET state = 'discarded', blob_key = NULL, original_removed_at = now(), reason = NULL WHERE id = $1 RETURNING *`, [row.id])
      ).rows[0] as PersonalRow;
      await changed(ctx, tx, updated, 'discarded');
      if (row.blob_key) await storageOf().delete(row.blob_key).catch(() => false);
      return json({ item: toPersonalItem(updated) });
    }),
  });

  // Retry: a failed item starts again at the step that failed.
  ctx.http.route({
    ...retryPersonalInboxRoute,
    schema: { response: PersonalInboxActionResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const { itemId } = PersonalInboxItemParams.parse(req.params);
      const row = await requireItem(tx, me.personId, itemId, true);
      if (row.state !== 'failed') throw conflict('Only an item that failed can be tried again.');
      const updated = (
        await tx.query<PersonalRow>(`UPDATE app.memory_personal_inbox_items SET state = 'queued', stage = 'extract', reason = NULL, failed_stage = NULL, attempts = 0 WHERE id = $1 RETURNING *`, [row.id])
      ).rows[0] as PersonalRow;
      await changed(ctx, tx, updated, 'queued');
      await ctx.jobs.enqueue(tx, PERSONAL_FILE_QUEUE, { workspaceId: updated.workspace_id, itemId: updated.id }, { dedupeKey: `pfile:${updated.id}` });
      return json({ item: toPersonalItem(updated) });
    }),
  });

  // Send to team: the person's own action. A copy of the original is dropped into the team's inbox AS the person, so that team's rules apply (its holds, its size cap, its
  // review mode, its Archivist). The personal item stays where it is.
  ctx.http.route({
    ...sendPersonalInboxToTeamRoute,
    schema: { body: SendPersonalInboxToTeamRequest, response: SendPersonalInboxToTeamResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const me = await requireMe(tx);
      const { itemId } = PersonalInboxItemParams.parse(req.params);
      const body = SendPersonalInboxToTeamRequest.parse(req.body);
      const row = await requireItem(tx, me.personId, itemId);
      if (row.state === 'duplicate') throw conflict('This is a copy of an item already in your inbox. Send that one.');
      if (row.state === 'discarded') throw conflict('This item was discarded, so there is nothing to send.');
      if (row.state === 'held') throw conflict('This item is held. Release it first, or discard it.');
      if (row.blob_key === null) throw conflict('The original of this item is no longer kept, so it cannot be sent.');
      const team = await requireTeam(tx, body.teamSlug);
      if (team.archived_at) throw conflict('This team is archived, so nothing can be dropped into its memory.');
      await requireDrop(tx, team);
      const bytes = await personalOriginal(ctx, row, inboxMaxBytes());
      if (bytes === null) throw conflict('The original could not be read from storage.');
      if (!allowDrop(tx.actor.id)) throw new HttpError(429, 'rate_limited', 'You are dropping things faster than the inbox allows. Wait a minute and try again.');
      const result = await dropBytes(ctx, tx, team, storageOf(), bytes, {
        origin: row.origin === 'message' ? 'message' : 'person',
        kind: row.kind as InboxKind,
        name: row.name,
        teamOnly: body.teamOnly,
      });
      return json({ teamItemId: result.item.id, duplicate: result.duplicate });
    }),
  });
}

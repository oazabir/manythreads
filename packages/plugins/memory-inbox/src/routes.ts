import {
  BlobTooLargeError,
  HttpError,
  conflict,
  forbidden,
  invalid,
  json,
  notFound,
  requireManage,
  requireTeam,
  route,
  type BlobStorage,
  type PluginContext,
  type PluginTx,
  type TeamRow,
} from '@manythreads/sdk';
import {
  CreateInboxNoteRequest,
  GetInboxItemResponse,
  InboxItemActionResponse,
  InboxItemParams,
  InboxItemResponse,
  InboxTeamParams,
  ListInboxItemsQuery,
  ListInboxItemsResponse,
  INBOX_NAME_MAX,
  SendToMemoryParams,
  SendToMemoryRequest,
  UploadInboxItemQuery,
  createInboxNoteRoute,
  discardInboxItemRoute,
  getInboxItemRoute,
  listInboxItemsRoute,
  releaseInboxItemRoute,
  retryInboxItemRoute,
  sendToMemoryRoute,
  uploadInboxItemRoute,
  type InboxHoldReason,
  type InboxKind,
} from '@manythreads/shared';
import { loadInboxConfig } from './config.ts';
import { kindOfName, linkOnly } from './kinds.ts';
import { dropBytes, recordStored, requireDrop } from './receive.ts';
import { ITEM_COLUMNS, toItem, type ItemRow } from './rows.ts';
import { enqueueStep } from './states.ts';
import { allowDrop, cleanName, inboxMaxBytes, takeUploadSlot, tapped, type ReadableLike } from './upload.ts';

// The routes of a team's memory inbox (PLAN P8-15, P8-17). Anyone on the team with post rights drops (a file, a note, a message) and sees their own items and the
// team's; a lead or workspace admin also sees what is held, and releases, discards and retries. A guest drops nothing. docs/plugins/memory-inbox.md.

const tooLarge = (message: string): HttpError => new HttpError(413, 'validation_failed', message);
const MB = (bytes: number): number => Math.max(1, Math.floor(bytes / 1024 / 1024));

function requireWritable(team: TeamRow): void {
  if (team.archived_at) throw conflict('This team is archived, so nothing can be dropped into its memory.');
}

async function canManage(tx: PluginTx, team: TeamRow): Promise<boolean> {
  return (await tx.query<{ ok: boolean }>("SELECT app.can('team', $1, 'manage') AS ok", [team.id])).rows[0]?.ok === true;
}

async function requireItem(tx: PluginTx, team: TeamRow, itemId: string, lock = false): Promise<ItemRow> {
  const row = (await tx.query<ItemRow>(`SELECT ${ITEM_COLUMNS} FROM app.memory_inbox_items i WHERE i.id = $1 AND i.team_id = $2${lock ? ' FOR UPDATE' : ''}`, [itemId, team.id])).rows[0];
  if (!row) throw notFound('No such item in this team’s inbox');
  return row;
}

/** The first line of a note, without Markdown marks, as its name. */
const nameFromText = (text: string): string => {
  // eslint-disable-next-line no-control-regex
  const line = (text.split('\n').find((l) => l.trim().length > 0) ?? '').replace(/^[#>*\-\s]+/, '').replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  return (line.length > 80 ? `${line.slice(0, 79)}…` : line) || 'Note';
};

export function registerRoutes(ctx: PluginContext): void {
  const storageOf = (): BlobStorage => {
    const storage = ctx.providers.get<BlobStorage>('storage');
    if (!storage) throw new HttpError(503, 'internal', 'File storage is not available');
    return storage;
  };

  ctx.http.route({
    ...listInboxItemsRoute,
    schema: { query: ListInboxItemsQuery, response: ListInboxItemsResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug } = InboxTeamParams.parse(req.params);
      const query = ListInboxItemsQuery.parse(req.query);
      const team = await requireTeam(tx, slug);
      const rows = await tx.query<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM app.memory_inbox_items i
          WHERE i.team_id = $1 AND (($2::text IS NULL AND i.state <> 'discarded') OR i.state = $2::text)
          ORDER BY i.id DESC LIMIT $3`,
        [team.id, query.state ?? null, query.limit],
      );
      const config = await loadInboxConfig(ctx, tx, team.id);
      return json({ items: rows.rows.map(toItem), canManage: await canManage(tx, team), maxBytes: config.maxBytes });
    }),
  });

  ctx.http.route({
    ...getInboxItemRoute,
    schema: { response: GetInboxItemResponse },
    rateLimit: { limit: 240, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, itemId } = InboxItemParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      return json({ item: toItem(await requireItem(tx, team, itemId)), canManage: await canManage(tx, team) });
    }),
  });

  // Door 1: a file. The body is the file itself, streamed to the blob store (never held in memory), under the rules MISTAKES.md teaches for an upload.
  ctx.http.route({
    ...uploadInboxItemRoute,
    rawBody: true,
    schema: { query: UploadInboxItemQuery, response: InboxItemResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug } = InboxTeamParams.parse(req.params);
      const query = UploadInboxItemQuery.parse(req.query);
      const team = await requireTeam(tx, slug);
      requireWritable(team);
      await requireDrop(tx, team);
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
      const result = await recordStored(ctx, tx, team, storage, stored.blobKey, stored.sha256, stored.size, {
        origin: 'person',
        kind,
        name,
        teamOnly: query.teamOnly ?? false,
      });
      return json(result, result.duplicate ? 200 : 201);
    }),
  });

  // Door 2: New note. Pasted text, with an optional title; a text that is only a web address is filed as a link and the page is never fetched.
  ctx.http.route({
    ...createInboxNoteRoute,
    schema: { body: CreateInboxNoteRequest, response: InboxItemResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug } = InboxTeamParams.parse(req.params);
      const note = CreateInboxNoteRequest.parse(req.body);
      const team = await requireTeam(tx, slug);
      requireWritable(team);
      await requireDrop(tx, team);
      if (!allowDrop(tx.actor.id)) throw new HttpError(429, 'rate_limited', 'You are dropping things faster than the inbox allows. Wait a minute and try again.');
      const url = linkOnly(note.text);
      const kind: InboxKind = url ? 'link' : 'markdown';
      const text = url ?? (note.title ? `# ${note.title}\n\n${note.text}\n` : `${note.text}\n`);
      const name = (note.title ?? (url ?? nameFromText(note.text))).slice(0, INBOX_NAME_MAX);
      const result = await dropBytes(ctx, tx, team, storageOf(), new TextEncoder().encode(text), { origin: 'person', kind, name, teamOnly: note.teamOnly });
      return json(result, result.duplicate ? 200 : 201);
    }),
  });

  // Door 3: Send to memory, on a message of a team channel (or the thread it belongs to). The person is told, by the screen, that everyone in the team will
  // see it; a private channel needs their yes (`confirmPrivate`). A direct message or a bot conversation has no team, so it cannot be sent.
  ctx.http.route({
    ...sendToMemoryRoute,
    schema: { body: SendToMemoryRequest, response: InboxItemResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId, messageId } = SendToMemoryParams.parse(req.params);
      const options = SendToMemoryRequest.parse(req.body);
      const channel = (
        await tx.query<{ id: string; name: string; kind: string; private: boolean; team_id: string | null }>('SELECT c.id, c.name, c.kind, c.private, c.team_id FROM app.channels c WHERE c.id = $1', [channelId])
      ).rows[0];
      if (!channel) throw forbidden();
      if (channel.kind !== 'channel' || channel.team_id === null) throw conflict('Only a message in a team channel can be sent to a team’s memory. A direct message belongs to the people in it.');
      const teamRow = (await tx.query<TeamRow & { name: string }>('SELECT id, workspace_id, archived_at, name FROM app.teams WHERE id = $1', [channel.team_id])).rows[0];
      if (!teamRow) throw forbidden('You cannot see this team');
      requireWritable(teamRow);
      await requireDrop(tx, teamRow);
      if (channel.private && !options.confirmPrivate) {
        throw conflict(`This channel is private, but everyone in ${teamRow.name} will see what is sent to the team’s memory. Confirm to send it anyway.`);
      }
      const messages = (
        await tx.query<{ id: string; author_id: string; body: string; thread_root_id: string | null; deleted_at: Date | null; created_at: Date }>(
          `SELECT m.id, m.author_id, m.body, m.thread_root_id, m.deleted_at, m.created_at FROM app.messages m
            WHERE m.channel_id = $1 AND (m.id = $2 OR m.thread_root_id = $2) ORDER BY m.id LIMIT 201`,
          [channelId, options.thread ? await threadRootOf(tx, channelId, messageId) : messageId],
        )
      ).rows;
      const picked = options.thread ? messages : messages.filter((m) => m.id === messageId);
      const first = picked.find((m) => m.id === messageId) ?? (options.thread ? picked[0] : undefined);
      if (!first) throw notFound('No such message');
      if (!options.thread && first.deleted_at) throw conflict('That message was deleted');
      const live = picked.filter((m) => m.deleted_at === null);
      if (live.length === 0) throw conflict('That message was deleted');
      const names = new Map<string, string>();
      const authors = await tx.query<{ actor_id: string; display_name: string }>('SELECT actor_id, display_name FROM app.message_authors($1::uuid[])', [live.map((m) => m.id)]);
      for (const a of authors.rows) names.set(a.actor_id, a.display_name);
      const lines = live.slice(0, 200).map((m) => `**${names.get(m.author_id) ?? 'Someone'}**, ${m.created_at.toISOString().slice(0, 16).replace('T', ' ')} UTC:\n\n${m.body}`);
      const heading = options.thread ? `Thread in #${channel.name}` : `Message in #${channel.name}`;
      const more = live.length > 200 ? '\n\n(The thread is longer; the first 200 messages were sent.)' : '';
      const text = `# ${heading}\n\n${lines.join('\n\n---\n\n')}${more}\n`.slice(0, 200_000);
      const firstAuthor = names.get((live[0] ?? first).author_id);
      const name = `${heading}${firstAuthor ? ` from ${firstAuthor}` : ''}`.slice(0, INBOX_NAME_MAX);
      if (!allowDrop(tx.actor.id)) throw new HttpError(429, 'rate_limited', 'You are dropping things faster than the inbox allows. Wait a minute and try again.');
      const result = await dropBytes(ctx, tx, teamRow, storageOf(), new TextEncoder().encode(text), {
        origin: 'message',
        kind: 'markdown',
        name,
        teamOnly: options.teamOnly,
        sourceChannelId: channelId,
        sourceMessageId: messageId,
      });
      return json(result, result.duplicate ? 200 : 201);
    }),
  });

  // Release: a lead or admin lets a held item into the pipeline (it skips the hold check from then on), or files an item whose proposals could not be used
  // by writing only the platform's reference.
  ctx.http.route({
    ...releaseInboxItemRoute,
    schema: { response: InboxItemActionResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, itemId } = InboxItemParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      requireWritable(team);
      const row = await requireItem(tx, team, itemId, true);
      if (row.state !== 'held' && row.state !== 'needs_review') throw conflict('Only a held item, or one that needs review, can be released.');
      const stage = row.state === 'held' ? 'hold' : 'commit';
      const updated = (
        await tx.query<ItemRow>(
          `UPDATE app.memory_inbox_items i SET state = 'queued', stage = $2, reason = NULL, not_before = NULL, released_by = $3, released_at = now() WHERE i.id = $1 RETURNING ${ITEM_COLUMNS}`,
          [row.id, stage, tx.actor.id],
        )
      ).rows[0] as ItemRow;
      await ctx.audit.emit(tx, {
        type: 'memory.item.released',
        workspaceId: team.workspace_id,
        teamId: team.id,
        itemId: row.id,
        reason: (row.hold_reason as InboxHoldReason | null) ?? null,
        releasedBy: tx.actor.id,
        at: ctx.runtime.now().toISOString(),
      });
      await enqueueStep(ctx, tx, stage, updated);
      return json({ item: toItem(updated) });
    }),
  });

  // Discard: a lead or admin throws an item away. The original is deleted with it.
  ctx.http.route({
    ...discardInboxItemRoute,
    schema: { response: InboxItemActionResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, itemId } = InboxItemParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      const row = await requireItem(tx, team, itemId, true);
      if (!['queued', 'held', 'needs_review', 'failed'].includes(row.state)) {
        throw conflict(row.state === 'extracting' || row.state === 'filing' ? 'This item is being filed right now. Try again in a moment.' : 'This item cannot be discarded any more.');
      }
      const updated = (
        await tx.query<ItemRow>(
          `UPDATE app.memory_inbox_items i SET state = 'discarded', blob_key = NULL, original_removed_at = now(), reason = NULL, not_before = NULL WHERE i.id = $1 RETURNING ${ITEM_COLUMNS}`,
          [row.id],
        )
      ).rows[0] as ItemRow;
      await tx.query('DELETE FROM app.memory_inbox_extracts WHERE item_id = $1', [row.id]);
      await ctx.audit.emit(tx, {
        type: 'memory.item.discarded',
        workspaceId: team.workspace_id,
        teamId: team.id,
        itemId: row.id,
        reason: (row.hold_reason as InboxHoldReason | null) ?? null,
        discardedBy: tx.actor.id,
        at: ctx.runtime.now().toISOString(),
      });
      if (row.blob_key) await storageOf().delete(row.blob_key).catch(() => false);
      return json({ item: toItem(updated) });
    }),
  });

  // Retry: a failed item starts again at the step that failed.
  ctx.http.route({
    ...retryInboxItemRoute,
    schema: { response: InboxItemActionResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug, itemId } = InboxItemParams.parse(req.params);
      const team = await requireTeam(tx, slug);
      await requireManage(tx, team);
      requireWritable(team);
      const row = await requireItem(tx, team, itemId, true);
      if (row.state !== 'failed') throw conflict('Only an item that failed can be tried again.');
      const stage = row.failed_stage === 'extract' ? 'extract' : row.failed_stage === 'distil' ? 'distil' : 'commit';
      const updated = (
        await tx.query<ItemRow>(
          `UPDATE app.memory_inbox_items i SET state = 'queued', stage = $2, reason = NULL, not_before = NULL, failed_stage = NULL, attempts = 0 WHERE i.id = $1 RETURNING ${ITEM_COLUMNS}`,
          [row.id, stage],
        )
      ).rows[0] as ItemRow;
      await enqueueStep(ctx, tx, stage, updated);
      return json({ item: toItem(updated) });
    }),
  });
}

/** The root of the thread a message belongs to, or the message itself when it has no thread. */
async function threadRootOf(tx: PluginTx, channelId: string, messageId: string): Promise<string> {
  const row = (await tx.query<{ thread_root_id: string | null }>('SELECT thread_root_id FROM app.messages WHERE id = $1 AND channel_id = $2', [messageId, channelId])).rows[0];
  if (!row) throw notFound('No such message');
  return row.thread_root_id ?? messageId;
}

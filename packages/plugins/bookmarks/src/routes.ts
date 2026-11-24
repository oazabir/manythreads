import { HttpError, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  BookmarksChangedPush,
  ListSavedBookmarksQuery,
  ListSavedBookmarksResponse,
  RemoveSavedBookmarkResponse,
  SAVED_BOOKMARKS_FULL,
  SAVED_BOOKMARKS_MAX,
  SaveBookmarkRequest,
  SavedBookmark,
  SavedBookmarkKeysResponse,
  SavedBookmarkPathParams,
  WS_BOOKMARKS_CHANGED,
  bookmarkKey,
  listSavedBookmarksRoute,
  removeSavedBookmarkRoute,
  saveBookmarkRoute,
  savedBookmarkKeysRoute,
  type BookmarkTarget,
  type BookmarkTargetKind,
} from '@manythreads/shared';
import { conflict, forbidden, invalid, json, notFound, route } from './http.ts';
import { BOOKMARK_COLUMNS, BOOKMARK_FROM, targetOf, toSavedBookmark, type BookmarkRow } from './rows.ts';

/** The signed-in person (people.id); bookmarks belong to people, so a bot has none. */
async function callerPerson(tx: PluginTx): Promise<string> {
  const row = (await tx.query<{ id: string | null }>('SELECT app.person_id() AS id')).rows[0];
  if (!row?.id) throw new HttpError(403, 'forbidden', 'Bookmarks belong to people');
  return row.id;
}

/** The authors' names of the messages, for what the caller can read (the channels plugin's definer function `app.message_authors`). */
async function authorNames(tx: PluginTx, messageIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (messageIds.length === 0) return out;
  const res = await tx.query<{ actor_id: string; display_name: string }>('SELECT actor_id, display_name FROM app.message_authors($1::uuid[])', [messageIds.slice(0, 500)]);
  for (const r of res.rows) out.set(r.actor_id, r.display_name);
  return out;
}

/** Bookmarks as the caller sees them. What they point at is read through the caller's own policies, so what they cannot read comes back as `item: null`. */
async function loadBookmarks(tx: PluginTx, where: string, params: unknown[], limit: number): Promise<SavedBookmark[]> {
  params.push(limit);
  const res = await tx.query<BookmarkRow>(
    `SELECT ${BOOKMARK_COLUMNS} ${BOOKMARK_FROM} WHERE b.person_id = app.person_id() AND ${where} ORDER BY b.id DESC LIMIT $${String(params.length)}`,
    params,
  );
  const ids = res.rows.filter((r) => r.found && !r.deleted).map((r) => (r.kind === 'thread' ? r.thread_root_id : r.message_id)).filter((id): id is string => id !== null);
  const authors = await authorNames(tx, ids);
  return res.rows.map((r) => toSavedBookmark(r, authors));
}

/** The columns and value that find a target among the caller's bookmarks of its kind (the partial unique index of that kind). */
function matchOf(target: BookmarkTarget): { where: string; params: unknown[] } {
  switch (target.kind) {
    case 'thread':
      return { where: `b.kind = 'thread' AND b.thread_root_id = $1::uuid`, params: [target.rootMessageId] };
    case 'message':
      return { where: `b.kind = 'message' AND b.message_id = $1::uuid`, params: [target.messageId] };
    case 'file':
      return { where: `b.kind = 'file' AND b.file_id = $1::uuid`, params: [target.fileId] };
    case 'repo_file':
      return { where: `b.kind = 'repo_file' AND b.team_id = $1::uuid AND b.path = $2`, params: [target.teamId, target.path] };
  }
}

const TAB_KINDS: Record<'thread' | 'message' | 'file', BookmarkTargetKind[]> = { thread: ['thread'], message: ['message'], file: ['file', 'repo_file'] };

/** Tells the person's own open tabs that a bookmark came or went (delivered when `tx` commits, so never for a change that was rolled back). */
async function pushChanged(ctx: PluginContext, tx: PluginTx, personId: string, push: BookmarksChangedPush): Promise<void> {
  await ctx.realtime.pushToPerson(tx, personId, WS_BOOKMARKS_CHANGED, BookmarksChangedPush.parse(push));
}

/**
 * Bookmarks: the caller's own. Four routes; the row-level security of `bookmarks` makes "own" true even if a query forgot to say so. Every route is for
 * people only (a bot is refused) and has a rate limit.
 */
export function registerBookmarkRoutes(ctx: PluginContext): void {
  ctx.http.route({
    ...listSavedBookmarksRoute,
    readOnly: true,
    schema: { query: ListSavedBookmarksQuery, response: ListSavedBookmarksResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const q = ListSavedBookmarksQuery.parse(req.query);
      await callerPerson(tx);
      const kinds = q.kind ? TAB_KINDS[q.kind] : null;
      const items = await loadBookmarks(tx, '($1::text[] IS NULL OR b.kind = ANY ($1::text[])) AND ($2::uuid IS NULL OR b.id < $2::uuid)', [kinds, q.cursor ?? null], q.limit + 1);
      const more = items.length > q.limit;
      const page = more ? items.slice(0, q.limit) : items;
      const counts = (
        await tx.query<{ thread: number; message: number; file: number }>(
          `SELECT count(*) FILTER (WHERE kind = 'thread')::int AS thread, count(*) FILTER (WHERE kind = 'message')::int AS message,
                  count(*) FILTER (WHERE kind IN ('file', 'repo_file'))::int AS file
             FROM app.bookmarks WHERE person_id = app.person_id()`,
        )
      ).rows[0]!;
      return json(ListSavedBookmarksResponse.parse({ items: page, nextCursor: more ? (page[page.length - 1]?.id ?? null) : null, counts }));
    }),
  });

  ctx.http.route({
    ...savedBookmarkKeysRoute,
    readOnly: true,
    schema: { response: SavedBookmarkKeysResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (_req, tx) => {
      await callerPerson(tx);
      const res = await tx.query<Pick<BookmarkRow, 'id' | 'kind' | 'message_id' | 'thread_root_id' | 'file_id' | 'team_id' | 'path'>>(
        'SELECT b.id, b.kind, b.message_id, b.thread_root_id, b.file_id, b.team_id, b.path FROM app.bookmarks b WHERE b.person_id = app.person_id() ORDER BY b.id DESC LIMIT $1',
        [SAVED_BOOKMARKS_MAX],
      );
      const items = res.rows.map((r) => ({ id: r.id, kind: r.kind, key: bookmarkKey(targetOf(r)) }));
      return json(SavedBookmarkKeysResponse.parse({ total: items.length, items }));
    }),
  });

  ctx.http.route({
    ...saveBookmarkRoute,
    schema: { body: SaveBookmarkRequest, response: SavedBookmark },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { target } = SaveBookmarkRequest.parse(req.body ?? {});
      const person = await callerPerson(tx);
      if (target.kind === 'file' || target.kind === 'repo_file') throw invalid('Files cannot be bookmarked yet.');

      // The message must be one the caller can read (an unknown id and a private channel look the same), and must still be there.
      const messageId = target.kind === 'thread' ? target.rootMessageId : target.messageId;
      const msg = (
        await tx.query<{ channel_id: string; thread_root_id: string | null; deleted_at: Date | null; replies: number }>(
          `SELECT m.channel_id, m.thread_root_id, m.deleted_at, coalesce((SELECT t.reply_count FROM app.threads t WHERE t.root_message_id = m.id), 0)::int AS replies
             FROM app.messages m WHERE m.id = $1::uuid`,
          [messageId],
        )
      ).rows[0];
      if (!msg) throw forbidden('You cannot see this message');
      if (target.kind === 'thread' && msg.thread_root_id !== null) throw invalid('That message is a reply. Bookmark its thread or the message instead.');
      if (msg.deleted_at && !(target.kind === 'thread' && msg.replies > 0)) throw notFound('This message is no longer there');

      const match = matchOf(target);
      const existing = (await tx.query<{ id: string }>(`SELECT b.id FROM app.bookmarks b WHERE b.person_id = app.person_id() AND ${match.where}`, match.params)).rows[0];
      if (existing) return json((await loadBookmarks(tx, 'b.id = $1::uuid', [existing.id], 1))[0]!, 200);
      // read first, then insert: the cap trigger fires for every insert (MISTAKES P14-04), and a full list must not refuse one already there
      const total = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.bookmarks WHERE person_id = app.person_id()')).rows[0]!.n;
      if (total >= SAVED_BOOKMARKS_MAX) throw conflict(SAVED_BOOKMARKS_FULL);
      const inserted =
        target.kind === 'thread'
          ? await tx.query<{ id: string }>(
              `INSERT INTO app.bookmarks (workspace_id, person_id, kind, thread_root_id, channel_id) VALUES (app.workspace_id(), $1::uuid, 'thread', $2::uuid, $3::uuid)
               ON CONFLICT (person_id, thread_root_id) WHERE kind = 'thread' DO NOTHING RETURNING id`,
              [person, messageId, msg.channel_id],
            )
          : await tx.query<{ id: string }>(
              `INSERT INTO app.bookmarks (workspace_id, person_id, kind, message_id, thread_root_id, channel_id) VALUES (app.workspace_id(), $1::uuid, 'message', $2::uuid, $3::uuid, $4::uuid)
               ON CONFLICT (person_id, message_id) WHERE kind = 'message' DO NOTHING RETURNING id`,
              [person, messageId, msg.thread_root_id, msg.channel_id],
            );
      const id = inserted.rows[0]?.id;
      if (id) {
        await pushChanged(ctx, tx, person, { id, kind: target.kind, key: bookmarkKey(target), on: true } as BookmarksChangedPush);
        return json((await loadBookmarks(tx, 'b.id = $1::uuid', [id], 1))[0]!, 201);
      }
      // another request of the same person added it a moment ago: answer that one
      const raced = (await tx.query<{ id: string }>(`SELECT b.id FROM app.bookmarks b WHERE b.person_id = app.person_id() AND ${match.where}`, match.params)).rows[0];
      if (!raced) throw conflict('Another change was in progress. Try again.');
      return json((await loadBookmarks(tx, 'b.id = $1::uuid', [raced.id], 1))[0]!, 200);
    }),
  });

  ctx.http.route({
    ...removeSavedBookmarkRoute,
    schema: { response: RemoveSavedBookmarkResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { bookmarkId } = SavedBookmarkPathParams.parse(req.params);
      const person = await callerPerson(tx);
      const res = await tx.query<Pick<BookmarkRow, 'id' | 'kind' | 'message_id' | 'thread_root_id' | 'file_id' | 'team_id' | 'path'>>(
        'DELETE FROM app.bookmarks b WHERE b.id = $1::uuid AND b.person_id = app.person_id() RETURNING b.id, b.kind, b.message_id, b.thread_root_id, b.file_id, b.team_id, b.path',
        [bookmarkId],
      );
      const gone = res.rows[0];
      if (!gone) throw notFound('That bookmark is not in your list');
      await pushChanged(ctx, tx, person, { id: gone.id, kind: gone.kind, key: bookmarkKey(targetOf(gone)), on: false } as BookmarksChangedPush);
      return json(RemoveSavedBookmarkResponse.parse({ removed: true }));
    }),
  });
}

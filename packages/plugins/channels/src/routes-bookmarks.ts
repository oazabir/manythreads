import {
  AddBookmarkRequest,
  AddBookmarkResponse,
  BookmarkItemPathParams,
  BookmarkPathParams,
  ChannelBookmark,
  ListBookmarksResponse,
  MAX_CHANNEL_BOOKMARKS,
  RemoveBookmarkResponse,
  addBookmarkRoute,
  listBookmarksRoute,
  removeBookmarkRoute,
} from '@manythreads/shared';
import { conflict, invalid, json, route } from './http.ts';
import { requireChannel, requirePost, type Deps } from './service.ts';

type BookmarkRow = { id: string; channel_id: string; kind: string; title: string; target: string; created_at: Date };
const toBookmark = (r: BookmarkRow): ChannelBookmark =>
  ChannelBookmark.parse({ id: r.id, channelId: r.channel_id, kind: r.kind, title: r.title, target: r.target, createdAt: r.created_at.toISOString() });
const COLUMNS = 'id, channel_id, kind, title, target, created_at';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// a page lives under `pages/` in the team's repository: plain path characters, no `.` or `..` segment, Markdown
const PAGE_PATH = /^pages\/(?:[A-Za-z0-9][A-Za-z0-9 _()+,=@~-]*\/)*[A-Za-z0-9][A-Za-z0-9 _()+,=@~.-]*\.(?:md|markdown)$/;
const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A web address a bookmark may point at: http or https, with no user name or password in it. */
function webAddress(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('target: not a web address');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    throw invalid('target: use an http or https address without a user name or password');
  }
  return url;
}

/**
 * The bookmarks bar of a channel (PLAN P14-12): links, files and pages the channel keeps under its header. Everyone who can read the channel
 * sees the bar; everyone who can post adds and removes entries (the table's own policies say so too).
 */
export function registerBookmarkRoutes(deps: Deps): void {
  const { ctx } = deps;

  ctx.http.route({
    ...listBookmarksRoute,
    schema: { response: ListBookmarksResponse },
    handler: route(async (req, tx) => {
      const { channelId } = BookmarkPathParams.parse(req.params);
      await requireChannel(tx, channelId);
      const res = await tx.query<BookmarkRow>(`SELECT ${COLUMNS} FROM app.channel_bookmarks WHERE channel_id = $1 ORDER BY id`, [channelId]);
      return json(ListBookmarksResponse.parse({ items: res.rows.map(toBookmark) }));
    }),
  });

  ctx.http.route({
    ...addBookmarkRoute,
    schema: { body: AddBookmarkRequest, response: AddBookmarkResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = BookmarkPathParams.parse(req.params);
      const body = AddBookmarkRequest.parse(req.body);
      const channel = await requireChannel(tx, channelId);
      await requirePost(tx, channel);
      let target = body.target;
      let title = body.title;
      if (body.kind === 'link') {
        const url = webAddress(body.target);
        target = url.toString();
        title ??= clip(url.hostname);
      } else if (body.kind === 'file') {
        if (!UUID.test(body.target)) throw invalid('target: not a file id');
        const file = await tx
          .query<{ name: string }>('SELECT name FROM app.files WHERE id = $1 AND channel_id = $2', [body.target, channelId])
          .catch((err: unknown) => {
            if ((err as { code?: string }).code === '42P01') throw invalid('target: file storage is not enabled');
            throw err;
          });
        if (!file.rows[0]) throw invalid('target: no such file in this channel');
        target = body.target.toLowerCase();
        title ??= clip(file.rows[0].name);
      } else {
        if (!channel.team_id) throw invalid('kind: a page belongs to a team, so a direct message cannot bookmark one');
        if (!PAGE_PATH.test(body.target) || body.target.length > 512) throw invalid('target: a page is a Markdown file under pages/');
        title ??= clip(body.target.slice(body.target.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/, ''));
      }
      const res = await tx.query<BookmarkRow>(
        `INSERT INTO app.channel_bookmarks (workspace_id, channel_id, kind, title, target, created_by)
         VALUES (app.workspace_id(), $1, $2, $3, $4, app.actor()) RETURNING ${COLUMNS}`,
        [channelId, body.kind, title, target],
      );
      // the cap is checked after the insert, so two people adding at once cannot both slip under it (a refusal rolls this insert back)
      const n = (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.channel_bookmarks WHERE channel_id = $1', [channelId])).rows[0]?.n ?? 0;
      if (n > MAX_CHANNEL_BOOKMARKS) throw conflict(`A channel keeps at most ${MAX_CHANNEL_BOOKMARKS} bookmarks. Remove one first.`);
      return json(AddBookmarkResponse.parse(toBookmark(res.rows[0]!)), 201);
    }),
  });

  ctx.http.route({
    ...removeBookmarkRoute,
    schema: { response: RemoveBookmarkResponse },
    handler: route(async (req, tx) => {
      const { channelId, bookmarkId } = BookmarkItemPathParams.parse(req.params);
      const channel = await requireChannel(tx, channelId);
      await requirePost(tx, channel);
      const res = await tx.query('DELETE FROM app.channel_bookmarks WHERE id = $1 AND channel_id = $2 RETURNING id', [bookmarkId, channelId]);
      return json(RemoveBookmarkResponse.parse({ removed: res.rows.length > 0 }));
    }),
  });
}

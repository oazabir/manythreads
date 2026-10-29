import type { PluginTx } from '@manythreads/sdk';
import {
  parseSearchText,
  searchDayEnd,
  searchDayStart,
  type SearchFileHit,
  type SearchFilters,
  type SearchMessageHit,
  type SearchPageHit,
  type SearchQuery,
  type SearchResponse,
  type SearchThreadHit,
} from '@manythreads/shared';

// Search runs the SQL functions of migration 0001 as the caller: every row they return already passed the read policies of messages,
// threads and files (the hoisted channel set). This file only shapes rows and adds the channel each hit sits in; it never decides visibility.

type Channel = SearchMessageHit['channel'];

const iso = (d: Date): string => d.toISOString();

/** Collapses whitespace and drops NUL characters (a text value in the database cannot hold one: it would be a 500); the server validates length (2 to 200). Trigram operators take the text as is: no escaping is needed or wanted. */
export const normalizeQuery = (q: string): string => q.split('\u0000').join('').replace(/\s+/g, ' ').trim();

/** The channels of a set of hits, as the caller sees them (a channel they cannot read is not in the result, and neither are its hits). */
async function channelsOf(tx: PluginTx, ids: readonly (string | null)[]): Promise<Map<string, Channel>> {
  const wanted = [...new Set(ids.filter((x): x is string => x !== null))];
  const out = new Map<string, Channel>();
  if (wanted.length === 0) return out;
  const res = await tx.query<{ id: string; name: string; kind: Channel['kind']; team_id: string | null }>(
    'SELECT c.id, c.name, c.kind, c.team_id FROM app.channels c WHERE c.id = ANY ($1::uuid[])',
    [wanted],
  );
  for (const c of res.rows) out.set(c.id, { id: c.id, name: c.kind === 'channel' ? c.name : null, kind: c.kind, teamId: c.team_id } as Channel);
  return out;
}

/**
 * What a search narrows by, already turned into ids and instants (the box's words are read by `parseSearchText` and resolved by
 * `resolveFilters`). `null` means "not asked"; an empty array means "asked, and nothing matches" (the functions then return nothing).
 * A filter only narrows what the caller can already read; none of them reaches a row the read policies hide.
 */
export type SearchNarrow = {
  from?: string[] | null;
  in?: string[] | null;
  hasFile?: boolean;
  hasLink?: boolean;
  inThread?: boolean;
  before?: string | null;
  after?: string | null;
};

type MessageRow = { id: string; channel_id: string; author_id: string; thread_root_id: string | null; snippet: string; score: number; created_at: Date };
export async function searchMessages(tx: PluginTx, q: string, teamId: string | null, limit: number, n: SearchNarrow = {}): Promise<SearchMessageHit[]> {
  const res = await tx.query<MessageRow>('SELECT * FROM app.search_messages($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [
    q,
    teamId,
    limit,
    n.from ?? null,
    n.in ?? null,
    n.hasFile ?? false,
    n.hasLink ?? false,
    n.inThread ?? false,
    n.before ?? null,
    n.after ?? null,
  ]);
  const channels = await channelsOf(tx, res.rows.map((r) => r.channel_id));
  return res.rows.flatMap((r) => {
    const channel = channels.get(r.channel_id);
    return channel
      ? [{ id: r.id, channel, authorId: r.author_id, threadRootId: r.thread_root_id, snippet: r.snippet, score: r.score, createdAt: iso(r.created_at) } as SearchMessageHit]
      : [];
  });
}

type ThreadRow = { root_message_id: string; channel_id: string; title: string; reply_count: number; score: number; last_reply_at: Date };
export async function searchThreads(tx: PluginTx, q: string, teamId: string | null, limit: number, n: SearchNarrow = {}): Promise<SearchThreadHit[]> {
  const res = await tx.query<ThreadRow>('SELECT * FROM app.search_threads($1, $2, $3, $4, $5, $6, $7)', [q, teamId, limit, n.from ?? null, n.in ?? null, n.before ?? null, n.after ?? null]);
  const channels = await channelsOf(tx, res.rows.map((r) => r.channel_id));
  return res.rows.flatMap((r) => {
    const channel = channels.get(r.channel_id);
    return channel
      ? [{ rootMessageId: r.root_message_id, channel, title: r.title, replyCount: r.reply_count, score: r.score, lastReplyAt: iso(r.last_reply_at) } as SearchThreadHit]
      : [];
  });
}

type FileRow = { id: string; channel_id: string | null; folder_path: string; name: string; size: string; mime: string; score: number; created_at: Date };
export async function searchFiles(tx: PluginTx, q: string, teamId: string | null, limit: number, n: SearchNarrow = {}): Promise<SearchFileHit[]> {
  const res = await tx.query<FileRow>('SELECT * FROM app.search_files($1, $2, $3, $4, $5, $6, $7)', [q, teamId, limit, n.from ?? null, n.in ?? null, n.before ?? null, n.after ?? null]);
  const channels = await channelsOf(tx, res.rows.map((r) => r.channel_id));
  return res.rows.map(
    (r) =>
      ({
        id: r.id,
        channel: r.channel_id ? (channels.get(r.channel_id) ?? null) : null,
        folderPath: r.folder_path,
        name: r.name,
        size: Number(r.size),
        mime: r.mime,
        score: r.score,
        createdAt: iso(r.created_at),
      }) as SearchFileHit,
  );
}

type PageRow = { team_id: string; path: string; snippet: string; score: number; updated_at: Date };
export async function searchPages(tx: PluginTx, q: string, teamId: string | null, limit: number, n: SearchNarrow = {}): Promise<SearchPageHit[]> {
  const res = await tx.query<PageRow>('SELECT * FROM app.search_pages($1, $2, $3, $4, $5, $6)', [q, teamId, limit, n.from ?? null, n.before ?? null, n.after ?? null]);
  return res.rows.map(
    (r) =>
      ({
        teamId: r.team_id,
        path: r.path,
        name: r.path.slice(r.path.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/i, ''),
        snippet: r.snippet,
        score: r.score,
        updatedAt: iso(r.updated_at),
      }) as SearchPageHit,
  );
}

/**
 * Turns the names of `from:` and `in:` into ids, as the caller. People come from `app.search_resolve_people` (a guest resolves only
 * themself), channels from `app.channels` through its read policy, so a private channel the caller is not in is no more findable by name than
 * by text. `unmatched` lists what found nothing, written as typed (`from:zed`).
 */
export async function resolveFilters(tx: PluginTx, f: SearchFilters): Promise<{ narrow: SearchNarrow; unmatched: string[] }> {
  const narrow: SearchNarrow = {
    hasFile: f.has.includes('file'),
    hasLink: f.has.includes('link'),
    inThread: f.is.includes('thread'),
    before: f.before ? searchDayStart(f.before) : null,
    after: f.after ? searchDayEnd(f.after) : null,
  };
  const unmatched: string[] = [];
  if (f.from.length > 0) {
    const res = await tx.query<{ name_key: string; actor_id: string }>('SELECT name_key, actor_id FROM app.search_resolve_people($1::text[])', [f.from]);
    const found = new Set(res.rows.map((r) => r.name_key));
    for (const name of f.from) if (!found.has(name.toLowerCase().trim())) unmatched.push(`from:${name}`);
    narrow.from = [...new Set(res.rows.map((r) => r.actor_id))];
  }
  if (f.in.length > 0) {
    const keys = f.in.map((x) => x.toLowerCase());
    const res = await tx.query<{ id: string; key: string }>("SELECT c.id, lower(c.name) AS key FROM app.channels c WHERE c.kind = 'channel' AND lower(c.name) = ANY ($1::text[])", [keys]);
    const found = new Set(res.rows.map((r) => r.key));
    for (const name of f.in) if (!found.has(name.toLowerCase())) unmatched.push(`in:${name}`);
    narrow.in = [...new Set(res.rows.map((r) => r.id))];
  }
  return { narrow, unmatched };
}

/** Keeps `limit` rows and says whether there were more (the functions are asked for one extra). */
const cut = <T>(rows: T[], limit: number): { rows: T[]; more: boolean } => ({ rows: rows.slice(0, limit), more: rows.length > limit });

/**
 * The `GET /api/search` answer: each requested kind best first (word similarity, then newest; newest first when the box holds only
 * filter words), the others empty. A kind that a filter cannot apply to is left out: `has:link` and `is:thread` are about messages,
 * so files and pages are not listed (`is:thread` still lists threads); `has:file` is about messages and files; `in:` is about a
 * channel, which a page does not have. Every list is what the caller may read, and `more` only says that list went on past `limit`.
 */
export async function search(tx: PluginTx, query: SearchQuery): Promise<SearchResponse> {
  const filters = parseSearchText(normalizeQuery(query.q));
  const text = filters.text.length >= 2 ? filters.text : '';
  const teamId = query.teamId ?? null;
  const limit = query.limit;
  const wants = (kind: 'messages' | 'threads' | 'files' | 'pages'): boolean => query.scope === 'all' || query.scope === kind;
  const { narrow, unmatched } = await resolveFilters(tx, filters);
  const about = {
    threads: !filters.has.length,
    files: !filters.has.includes('link') && !filters.is.length,
    pages: !filters.has.length && !filters.is.length && !filters.in.length,
  };
  const none = { rows: [], more: false };
  const messages = wants('messages') ? cut(await searchMessages(tx, text, teamId, limit + 1, narrow), limit) : none;
  const threads = wants('threads') && about.threads ? cut(await searchThreads(tx, text, teamId, limit + 1, narrow), limit) : none;
  const files = wants('files') && about.files ? cut(await searchFiles(tx, text, teamId, limit + 1, narrow), limit) : none;
  const pages = wants('pages') && about.pages ? cut(await searchPages(tx, text, teamId, limit + 1, narrow), limit) : none;
  return {
    query: text,
    filters,
    unmatched,
    messages: messages.rows as SearchMessageHit[],
    threads: threads.rows as SearchThreadHit[],
    files: files.rows as SearchFileHit[],
    pages: pages.rows as SearchPageHit[],
    more: { messages: messages.more, threads: threads.more, files: files.more, pages: pages.more },
  };
}

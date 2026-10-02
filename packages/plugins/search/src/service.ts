import type { PluginTx } from '@manythreads/sdk';
import type { SearchFileHit, SearchMessageHit, SearchQuery, SearchResponse, SearchThreadHit } from '@manythreads/shared';

// Search runs the SQL functions of migration 0001 as the caller: every row they return already passed the read policies of messages,
// threads and files (the hoisted channel set). This file only shapes rows and adds the channel each hit sits in; it never decides visibility.

type Channel = SearchMessageHit['channel'];

const iso = (d: Date): string => d.toISOString();

/** Collapses whitespace; the server validates length (2 to 200). Trigram operators take the text as is: no escaping is needed or wanted. */
export const normalizeQuery = (q: string): string => q.replace(/\s+/g, ' ').trim();

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

type MessageRow = { id: string; channel_id: string; author_id: string; thread_root_id: string | null; snippet: string; score: number; created_at: Date };
export async function searchMessages(tx: PluginTx, q: string, teamId: string | null, limit: number): Promise<SearchMessageHit[]> {
  const res = await tx.query<MessageRow>('SELECT * FROM app.search_messages($1, $2, $3)', [q, teamId, limit]);
  const channels = await channelsOf(tx, res.rows.map((r) => r.channel_id));
  return res.rows.flatMap((r) => {
    const channel = channels.get(r.channel_id);
    return channel
      ? [{ id: r.id, channel, authorId: r.author_id, threadRootId: r.thread_root_id, snippet: r.snippet, score: r.score, createdAt: iso(r.created_at) } as SearchMessageHit]
      : [];
  });
}

type ThreadRow = { root_message_id: string; channel_id: string; title: string; reply_count: number; score: number; last_reply_at: Date };
export async function searchThreads(tx: PluginTx, q: string, teamId: string | null, limit: number): Promise<SearchThreadHit[]> {
  const res = await tx.query<ThreadRow>('SELECT * FROM app.search_threads($1, $2, $3)', [q, teamId, limit]);
  const channels = await channelsOf(tx, res.rows.map((r) => r.channel_id));
  return res.rows.flatMap((r) => {
    const channel = channels.get(r.channel_id);
    return channel
      ? [{ rootMessageId: r.root_message_id, channel, title: r.title, replyCount: r.reply_count, score: r.score, lastReplyAt: iso(r.last_reply_at) } as SearchThreadHit]
      : [];
  });
}

type FileRow = { id: string; channel_id: string | null; folder_path: string; name: string; size: string; mime: string; score: number; created_at: Date };
export async function searchFiles(tx: PluginTx, q: string, teamId: string | null, limit: number): Promise<SearchFileHit[]> {
  const res = await tx.query<FileRow>('SELECT * FROM app.search_files($1, $2, $3)', [q, teamId, limit]);
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

/** The `GET /api/search` answer: each requested kind best first (word similarity, then newest), the others empty. */
export async function search(tx: PluginTx, query: SearchQuery): Promise<SearchResponse> {
  const q = normalizeQuery(query.q);
  const teamId = query.teamId ?? null;
  const wants = (kind: 'messages' | 'threads' | 'files'): boolean => query.scope === 'all' || query.scope === kind;
  return {
    query: q,
    messages: wants('messages') ? await searchMessages(tx, q, teamId, query.limit) : [],
    threads: wants('threads') ? await searchThreads(tx, q, teamId, query.limit) : [],
    files: wants('files') ? await searchFiles(tx, q, teamId, query.limit) : [],
  };
}

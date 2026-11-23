import { forbidden, json, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { AnsweredBeforeParams, AnsweredBeforeQuery, AnsweredBeforeResponse, answeredBeforeRoute, type AnsweredBeforeItem } from '@manythreads/shared';
import { queryVector } from './capability.ts';
import { queryTerms, searchKnowledge } from './search.ts';

/*
 * Answered before (P18-09, P35-06). While someone writes a question in a help channel, the composer asks here: up to three earlier threads of the channel's
 * team that have replies and share enough of the question's words, and up to two knowledge passages of the team (hybrid when the workspace has an embedding
 * model). Everything is read as the asker, so a thread in a channel they cannot read and a base they cannot read are not here. Nothing is posted or kept:
 * the asker reads, and sends the question or not.
 */

const THREADS = 3;
const PASSAGES = 2;
/** How many of a team's most recent answered threads are compared with the question (a help channel's history, not the whole archive). */
const RECENT = 3000;

type ThreadRow = {
  root_message_id: string;
  channel_id: string;
  channel_name: string;
  title: string;
  root_text: string;
  answer: string | null;
  reply_count: number;
  last_reply_at: Date;
};

/** How many of the terms the text holds, as words or word starts (the same light stemming as `queryTerms`). */
export function termsHeld(text: string, terms: readonly string[]): number {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.filter((t) => words.some((w) => w.startsWith(t))).length;
}

/** Enough in common to be worth showing: at least two of the question's words, and at least two in five of them. */
export const closeEnough = (held: number, of: number): boolean => held >= Math.min(2, of) && held * 5 >= of * 2;

export async function pastThreads(tx: PluginTx, teamId: string, question: string, excludeRoot: string | null = null): Promise<AnsweredBeforeItem[]> {
  const terms = queryTerms(question);
  if (terms.length === 0) return [];
  const tsquery = terms.map((t) => `${t}:*`).join(' | ');
  const rows = (
    await tx.query<ThreadRow>(
      `WITH recent AS (
         SELECT t.root_message_id, t.channel_id, t.title, t.reply_count, t.last_reply_at
           FROM app.threads t JOIN app.channels c ON c.id = t.channel_id
          WHERE c.team_id = $1::uuid AND c.kind = 'channel' AND c.archived_at IS NULL AND t.reply_count > 0
          ORDER BY t.last_reply_at DESC LIMIT ${RECENT})
       SELECT r.root_message_id, r.channel_id, c.name AS channel_name, r.title, left(m.body_plain, 2000) AS root_text, r.reply_count, r.last_reply_at,
              (SELECT left(a.body_plain, 400) FROM app.messages a
                WHERE a.thread_root_id = r.root_message_id AND a.deleted_at IS NULL AND a.author_id <> m.author_id ORDER BY a.id LIMIT 1) AS answer
         FROM recent r JOIN app.messages m ON m.id = r.root_message_id JOIN app.channels c ON c.id = r.channel_id
        WHERE m.deleted_at IS NULL AND ($3::uuid IS NULL OR r.root_message_id <> $3::uuid)
          AND to_tsvector('simple', r.title || ' ' || m.body_plain) @@ to_tsquery('simple', $2)
        ORDER BY ts_rank(to_tsvector('simple', r.title || ' ' || m.body_plain), to_tsquery('simple', $2)) DESC, r.last_reply_at DESC
        LIMIT 20`,
      [teamId, tsquery, excludeRoot],
    )
  ).rows;
  return rows
    .map((r) => ({ r, held: termsHeld(`${r.title} ${r.root_text}`, terms) }))
    .filter((x) => closeEnough(x.held, terms.length))
    .sort((a, b) => b.held - a.held)
    .slice(0, THREADS)
    .map(({ r }) => ({
      kind: 'thread' as const,
      rootId: r.root_message_id,
      channelId: r.channel_id,
      channelName: r.channel_name,
      title: (r.title || r.root_text).slice(0, 200),
      answer: r.answer,
      replyCount: r.reply_count,
      lastReplyAt: r.last_reply_at.toISOString(),
    }));
}

export function registerAnsweredBefore(ctx: PluginContext): void {
  ctx.http.route({
    ...answeredBeforeRoute,
    schema: { response: AnsweredBeforeResponse },
    // the composer asks after a pause in typing; a person typing fast for a minute stays well under this
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = AnsweredBeforeParams.parse(req.params);
      const { q } = AnsweredBeforeQuery.parse(req.query);
      // read as the asker: a channel they cannot read is not found
      const channel = (await tx.query<{ team_id: string | null; kind: string; help: boolean }>('SELECT team_id, kind, help FROM app.channels WHERE id = $1::uuid', [channelId])).rows[0];
      if (!channel) throw forbidden('You cannot see this channel');
      if (!channel.help || channel.kind !== 'channel' || !channel.team_id) return json(AnsweredBeforeResponse.parse({ help: false, items: [] }));
      const threads = await pastThreads(tx, channel.team_id, q);
      const vector = await queryVector(ctx, tx, q);
      const hits = await searchKnowledge(tx, { teamIds: [channel.team_id], personId: null, baseSlugs: null, query: q, limit: PASSAGES }, vector);
      const passages: AnsweredBeforeItem[] = hits.slice(0, PASSAGES).map((h) => ({
        kind: 'knowledge',
        base: h.baseSlug,
        document: h.documentName,
        section: h.section,
        text: h.text.slice(0, 400),
        file: h.repoPath,
      }));
      return json(AnsweredBeforeResponse.parse({ help: true, items: [...threads, ...passages] }));
    }),
  });
}

import type { PluginContext, PluginTx, ResolvedEntity } from '@manythreads/sdk';

/** First line of a message as a link title: at most 80 characters of its plain text. */
const titleOf = (plain: string): string => {
  const t = plain.trim().split('\n', 1)[0]?.trim() ?? '';
  return t === '' ? 'Message' : t.length > 80 ? `${t.slice(0, 79)}…` : t;
};

const isUuid = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

type Located = {
  channel_name: string;
  channel_kind: string;
  team_slug: string | null;
};

/** Where a channel lives in the client (`/t/<team>/c/<name>`); null for a DM or a channel whose team the caller cannot read (a guest). */
const channelHref = (r: Located): string | null =>
  r.channel_kind === 'channel' && r.team_slug ? `/t/${r.team_slug}/c/${encodeURIComponent(r.channel_name)}` : null;

/**
 * What the kernel's cohesion services need from the plugin that owns messages: how to count unread (`channel`: top-level messages
 * newer than a position, not the caller's own; `thread`: its live replies), and how a message or a thread is summarised for a link.
 * Both run as the person asking, so row level security decides what exists for them.
 */
export function registerCohesion(ctx: PluginContext): void {
  const count = async (tx: PluginTx, sql: string, id: string, after: string): Promise<number> =>
    (await tx.query<{ n: number }>(sql, [id, after])).rows[0]?.n ?? 0;

  ctx.readState.registerCounter('channel', (tx, target, after) =>
    count(
      tx,
      `SELECT count(*)::int AS n FROM app.messages
        WHERE channel_id = $1 AND id > $2 AND thread_root_id IS NULL AND deleted_at IS NULL AND author_id <> app.actor()`,
      target.targetId,
      after,
    ),
  );
  ctx.readState.registerCounter('thread', (tx, target, after) =>
    count(
      tx,
      `SELECT count(*)::int AS n FROM app.messages
        WHERE thread_root_id = $1 AND id > $2 AND deleted_at IS NULL AND author_id <> app.actor()`,
      target.targetId,
      after,
    ),
  );

  const locate = `c.name AS channel_name, c.kind AS channel_kind, (SELECT t.slug FROM app.teams t WHERE t.id = c.team_id) AS team_slug`;

  ctx.links.registerResolver('message', async (tx, id): Promise<ResolvedEntity | null> => {
    if (!isUuid(id)) return null;
    const res = await tx.query<Located & { body_plain: string; deleted_at: Date | null; thread_root_id: string | null }>(
      `SELECT m.body_plain, m.deleted_at, m.thread_root_id, ${locate}
         FROM app.messages m JOIN app.channels c ON c.id = m.channel_id WHERE m.id = $1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) return null;
    const base = channelHref(r);
    return {
      title: r.deleted_at ? 'Deleted message' : titleOf(r.body_plain),
      subtitle: r.channel_kind === 'channel' ? `#${r.channel_name}` : 'Direct message',
      href: base ? `${base}?message=${id}` : null,
    };
  });

  ctx.links.registerResolver('thread', async (tx, id): Promise<ResolvedEntity | null> => {
    if (!isUuid(id)) return null;
    const res = await tx.query<Located & { title: string; reply_count: number }>(
      `SELECT t.title, t.reply_count, ${locate}
         FROM app.threads t JOIN app.channels c ON c.id = t.channel_id WHERE t.root_message_id = $1`,
      [id],
    );
    const r = res.rows[0];
    if (!r) return null;
    const base = channelHref(r);
    const replies = `${r.reply_count} ${r.reply_count === 1 ? 'reply' : 'replies'}`;
    return {
      title: titleOf(r.title),
      subtitle: `${r.channel_kind === 'channel' ? `#${r.channel_name}` : 'Direct message'} · ${replies}`,
      href: base ? `${base}?panel=thread:${id}` : null,
    };
  });
}

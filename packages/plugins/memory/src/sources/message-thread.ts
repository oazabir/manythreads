import type { PluginTx } from '@manythreads/sdk';
import { MAX_THREAD_REPLIES, isUuid, metadataOf, renderMessage, renderThread, tagOf } from '../render.ts';
import { authoredVerdict, channelPath, forget, iso, skip, teamVisible, type Provenance, type Resolution } from './common.ts';

// Message and thread --------------------------------------------------------------------------------------------------------

interface MessageRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  channel_id: string;
  author_id: string;
  body_plain: string;
  thread_root_id: string | null;
  created_at: Date;
  deleted_at: Date | null;
  channel_kind: string;
  channel_private: boolean;
  channel_team_id: string | null;
  channel_name: string;
  team_slug: string | null;
  author_kind: string;
  author_name: string | null;
  has_replies: boolean;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.workspace_id, m.channel_id, m.author_id, m.body_plain, m.thread_root_id, m.created_at, m.deleted_at,
         c.kind AS channel_kind, c.private AS channel_private, c.team_id AS channel_team_id, c.name AS channel_name, t.slug AS team_slug,
         a.kind AS author_kind,
         CASE a.kind
           WHEN 'person' THEN (SELECT p.display_name FROM app.people p WHERE p.id = a.ref_id)
           WHEN 'bot' THEN (SELECT coalesce(nullif(b.name, ''), b.slug) FROM app.bots b WHERE b.id = a.ref_id)
         END AS author_name,
         EXISTS (SELECT 1 FROM app.messages r WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL) AS has_replies
    FROM app.messages m
    JOIN app.channels c ON c.id = m.channel_id
    LEFT JOIN app.teams t ON t.id = c.team_id
    JOIN app.actors a ON a.id = m.author_id
   WHERE m.id = $1::uuid`;

export async function resolveMessage(tx: PluginTx, messageId: string): Promise<Resolution> {
  if (!isUuid(messageId)) return forget('gone');
  const m = (await tx.query<MessageRow>(MESSAGE_SELECT, [messageId])).rows[0];
  if (!m) return forget('gone');
  if (!teamVisible(m)) return forget('not_team_visible');
  if (m.deleted_at !== null || m.body_plain.trim() === '') return forget('deleted');
  // A reply is part of its thread's document; so is a root that has live replies (the thread document quotes it).
  if (m.thread_root_id !== null) return skip('reply');
  if (m.has_replies) return forget('in_thread');
  const at: Provenance = {
    teamId: m.channel_team_id as string,
    workspaceId: m.workspace_id,
    channelId: m.channel_id,
    runId: null,
    actorId: m.author_id,
    scopes: [],
    link: `${channelPath(m.team_slug ?? '', m.channel_name)}?message=${m.id}`,
  };
  if (m.author_kind === 'bot') {
    const v = await authoredVerdict(tx, m.author_id, m.created_at);
    if (v.run_open) return { action: 'defer', at, reason: 'run_open' };
    if (v.retain_refusal !== null) return { action: 'withhold', at, reason: `authoring run: ${v.retain_refusal}` };
  }
  const text = renderMessage({ channelName: m.channel_name, authorName: m.author_name ?? 'someone', at: iso(m.created_at), body: m.body_plain });
  return {
    action: 'retain',
    at,
    item: {
      ...text,
      timestamp: iso(m.created_at),
      tags: ['feed', 'kind:message', tagOf('channel', m.channel_name)],
      metadata: metadataOf({ feed_kind: 'message', feed_id: m.id, actor: m.author_id, actor_name: m.author_name, occurred_at: iso(m.created_at), link: at.link, channel: m.channel_name }),
    },
  };
}

interface ReplyRow extends Record<string, unknown> {
  id: string;
  author_id: string;
  body_plain: string;
  created_at: Date;
  author_kind: string;
  author_name: string | null;
  run_open: boolean | null;
  retain_refusal: string | null;
}

export async function resolveThread(tx: PluginTx, rootId: string): Promise<Resolution> {
  if (!isUuid(rootId)) return forget('gone');
  const root = (await tx.query<MessageRow>(MESSAGE_SELECT, [rootId])).rows[0];
  if (!root) return forget('gone');
  if (!teamVisible(root)) return forget('not_team_visible');
  if (root.deleted_at !== null || root.body_plain.trim() === '') return forget('deleted');
  if (root.thread_root_id !== null) return skip('reply');
  const replies = (
    await tx.query<ReplyRow>(
      `SELECT m.id, m.author_id, m.body_plain, m.created_at, a.kind AS author_kind,
              CASE a.kind
                WHEN 'person' THEN (SELECT p.display_name FROM app.people p WHERE p.id = a.ref_id)
                WHEN 'bot' THEN (SELECT coalesce(nullif(b.name, ''), b.slug) FROM app.bots b WHERE b.id = a.ref_id)
              END AS author_name,
              v.run_open, v.retain_refusal
         FROM app.messages m
         JOIN app.actors a ON a.id = m.author_id
         LEFT JOIN LATERAL app.memory_authored_verdict(a.id, m.created_at) v ON a.kind = 'bot'
        WHERE m.thread_root_id = $1::uuid AND m.deleted_at IS NULL AND m.body_plain <> ''
        ORDER BY m.id
        LIMIT $2`,
      [rootId, MAX_THREAD_REPLIES + 1],
    )
  ).rows;
  // No live reply: the root is a plain message again (its own document, which the same event marked).
  if (replies.length === 0) return forget('no_replies');

  const at: Provenance = {
    teamId: root.channel_team_id as string,
    workspaceId: root.workspace_id,
    channelId: root.channel_id,
    runId: null,
    actorId: root.author_id,
    scopes: [],
    link: `${channelPath(root.team_slug ?? '', root.channel_name)}?message=${root.id}`,
  };
  const rootVerdict = root.author_kind === 'bot' ? await authoredVerdict(tx, root.author_id, root.created_at) : null;
  if (rootVerdict?.run_open === true || replies.some((r) => r.run_open === true)) return { action: 'defer', at, reason: 'run_open' };

  const quoted: Array<{ authorName: string; at: string; body: string }> = [];
  const excluded: NonNullable<Provenance['excluded']> = [];
  let withheld: string | null = null;
  let rootQuoted = false;
  if (rootVerdict?.retain_refusal != null) {
    withheld = rootVerdict.retain_refusal;
    excluded.push({ messageId: root.id, actorId: root.author_id, reason: `authoring run: ${rootVerdict.retain_refusal}` });
  } else {
    quoted.push({ authorName: root.author_name ?? 'someone', at: iso(root.created_at), body: root.body_plain });
    rootQuoted = true;
  }
  for (const r of replies.slice(0, MAX_THREAD_REPLIES)) {
    // What a bot wrote in a run that read something narrower than the team is left out of the document, like the message itself.
    if (r.retain_refusal !== null) {
      withheld ??= r.retain_refusal;
      excluded.push({ messageId: r.id, actorId: r.author_id, reason: `authoring run: ${r.retain_refusal}` });
      continue;
    }
    quoted.push({ authorName: r.author_name ?? 'someone', at: iso(r.created_at), body: r.body_plain });
  }
  at.excluded = excluded;
  if (quoted.length === 0) return { action: 'withhold', at, reason: `authoring run: ${withheld ?? 'private_source'}` };

  // The title is the root's own first line, taken only from a root that is quoted: `app.threads.title` is a copy of the root's first characters
  // made when it was posted, so reading it would put a withheld root's words in the head of a document that does not quote it.
  const title = rootQuoted ? (root.body_plain.split('\n', 1)[0] ?? '').slice(0, 120) : '';
  const text = renderThread({
    channelName: root.channel_name,
    title,
    messages: quoted,
    moreReplies: Math.max(0, replies.length - MAX_THREAD_REPLIES),
  });
  const last = replies[Math.min(replies.length, MAX_THREAD_REPLIES) - 1] as ReplyRow;
  return {
    action: 'retain',
    at,
    item: {
      ...text,
      timestamp: iso(last.created_at),
      tags: ['feed', 'kind:thread', tagOf('channel', root.channel_name)],
      metadata: metadataOf({ feed_kind: 'thread', feed_id: root.id, actor: root.author_id, actor_name: root.author_name, occurred_at: iso(root.created_at), link: at.link, channel: root.channel_name }),
    },
  };
}

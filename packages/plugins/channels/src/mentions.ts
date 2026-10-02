import type { PluginTx } from '@manythreads/sdk';
import { handlePrefix, matchHandle, parseMarkup, type HandleSubject } from '@manythreads/shared';
import type { ChannelRow } from './rows.ts';
import type { Deps } from './service.ts';

// What a message body points at (P3-07): `@person` and `#channel` become `message_mentions` rows, `[[thread:...]]` and friends become
// entity links. The parser is the one the composer uses (shared `parseMarkup`): code spans, fences, URLs, emails and escaped marks
// are never mentions. Runs in the transaction of the post or the edit, so a rolled-back message leaves no mention, link or event.

/** At most this many distinct `@handles`, `#channels` and `[[entities]]` of one message are looked at (the rest are plain text). */
const MAX_REFS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Entity references that can be links today: they need a uuid. `[[page:path]]` and `[[task:id]]` follow when those ids are uuids. */
const LINKABLE = new Set(['thread', 'file', 'task']);

export interface MessageRefs {
  id: string;
  body: string;
  /** The author's actor id. */
  authorId: string;
  threadRootId: string | null;
}

type PersonRow = {
  person_id: string;
  actor_id: string;
  display_name: string;
  primary_email: string;
};

/**
 * `@handle` to the person it means, among the people who can read the channel and have signed in at least once (they have an actor):
 * `app.channel_mention_candidates` (a definer function, because a caller sees only their own actor row) narrows by name prefix and
 * `matchHandle` applies the rule. Ambiguous or unknown handles resolve to nobody: no row, no event. A guest resolves nobody.
 */
async function resolvePeople(
  tx: PluginTx,
  channelId: string,
  handles: readonly string[],
): Promise<Map<string, { personId: string; actorId: string }>> {
  const out = new Map<string, { personId: string; actorId: string }>();
  if (handles.length === 0) return out;
  const prefixes = [...new Set(handles.map(handlePrefix).filter((p) => p !== ''))].map((p) => `${p}%`);
  const res = await tx.query<PersonRow>('SELECT person_id, actor_id, display_name, primary_email FROM app.channel_mention_candidates($1, $2::text[])', [
    channelId,
    prefixes,
  ]);
  const subjects: Array<HandleSubject & { actorId: string }> = res.rows.map((r) => ({
    id: r.person_id,
    actorId: r.actor_id,
    displayName: r.display_name,
    email: r.primary_email,
  }));
  for (const handle of handles) {
    const id = matchHandle(handle, subjects);
    const hit = id === null ? undefined : subjects.find((s) => s.id === id);
    if (hit) out.set(handle, { personId: hit.id, actorId: hit.actorId });
  }
  return out;
}

/**
 * Brings the mentions and links of one message in line with its body: inserts what is new, removes what an edit dropped, announces
 * each newly mentioned person once (`channel.mention.created`) and links the message to the entities it names.
 */
export async function syncMessageRefs(
  { ctx }: Deps,
  tx: PluginTx,
  channel: ChannelRow,
  message: MessageRefs,
  mode: 'post' | 'edit',
): Promise<void> {
  const parsed = parseMarkup(message.body);
  const handles = [...new Set(parsed.mentions.map((m) => m.handle.toLowerCase()))].slice(0, MAX_REFS);
  const channelNames = [...new Set(parsed.channels.map((c) => c.name.toLowerCase()))].slice(0, MAX_REFS);
  const entities = [...new Map(parsed.entityRefs.filter((r) => LINKABLE.has(r.type) && UUID.test(r.id)).map((r) => [`${r.type}:${r.id}`, r])).values()].slice(0, MAX_REFS);

  // 1. Who and what is named.
  const people = await resolvePeople(tx, channel.id, handles);
  const named = new Map<string, { kind: 'person'; id: string; personId: string }>();
  for (const { personId, actorId } of people.values()) {
    if (actorId !== message.authorId) named.set(`person:${actorId}`, { kind: 'person', id: actorId, personId });
  }
  const mentioned: Array<{ kind: 'person' | 'channel'; id: string; personId: string | null }> = [...named.values()];
  if (channelNames.length > 0 && channel.team_id) {
    const found = await tx.query<{ id: string }>(
      `SELECT id FROM app.channels WHERE team_id = $1 AND kind = 'channel' AND name = ANY ($2::text[])`,
      [channel.team_id, channelNames],
    );
    for (const r of found.rows) mentioned.push({ kind: 'channel', id: r.id, personId: null });
  }

  // 2. Rows: insert the new, delete the dropped (an edit), announce each newly named person once.
  const existing =
    mode === 'edit'
      ? (await tx.query<{ mentioned_id: string; kind: string }>('SELECT mentioned_id, kind FROM app.message_mentions WHERE message_id = $1', [message.id])).rows
      : [];
  const had = new Set(existing.map((r) => `${r.kind}:${r.mentioned_id}`));
  const want = new Set(mentioned.map((m) => `${m.kind}:${m.id}`));
  const fresh = mentioned.filter((m) => !had.has(`${m.kind}:${m.id}`));
  const dropped = existing.filter((r) => !want.has(`${r.kind}:${r.mentioned_id}`));
  if (fresh.length > 0) {
    await tx.query(
      `INSERT INTO app.message_mentions (message_id, mentioned_id, kind, channel_id)
       SELECT $1::uuid, u.id, u.kind, $2::uuid FROM unnest($3::uuid[], $4::text[]) AS u(id, kind) ON CONFLICT DO NOTHING`,
      [message.id, channel.id, fresh.map((m) => m.id), fresh.map((m) => m.kind)],
    );
  }
  if (dropped.length > 0) {
    await tx.query(
      `DELETE FROM app.message_mentions WHERE message_id = $1
         AND (mentioned_id, kind) IN (SELECT * FROM unnest($2::uuid[], $3::text[]))`,
      [message.id, dropped.map((r) => r.mentioned_id), dropped.map((r) => r.kind)],
    );
  }
  for (const m of fresh) {
    if (m.kind !== 'person') continue;
    await ctx.audit.emit(tx, {
      type: 'channel.mention.created',
      channelId: channel.id,
      teamId: channel.team_id,
      messageId: message.id,
      threadRootId: message.threadRootId,
      authorId: message.authorId,
      kind: 'person',
      mentionedId: m.id,
      personId: m.personId,
    });
  }

  // 3. Links: only for a team channel the author belongs to (the link table is for team members), and only to entities the author can
  //    see (the type's resolver answers for the caller; none registered, or hidden, or missing: no link).
  const teamId = channel.team_id;
  const mayLink = teamId !== null && (entities.length > 0 || mode === 'edit') && (await isTeamMember(tx, teamId));
  if (!mayLink || teamId === null) return;
  const src = { type: 'message' as const, id: message.id };
  const wanted = new Set<string>();
  for (const e of entities) {
    const dst = { type: e.type as 'thread' | 'file' | 'task', id: e.id.toLowerCase() };
    if (!(await ctx.links.resolve(tx, dst))) continue;
    wanted.add(`${dst.type}:${dst.id}`);
    await ctx.links.create(tx, { teamId, src, dst, kind: 'mentions' });
  }
  if (mode === 'edit') {
    for (const link of await ctx.links.list(tx, src, 'out', { kind: 'mentions' })) {
      if (!wanted.has(`${link.dst.type}:${link.dst.id}`)) await ctx.links.remove(tx, { src, dst: link.dst, kind: 'mentions' });
    }
  }
}

async function isTeamMember(tx: PluginTx, teamId: string): Promise<boolean> {
  const res = await tx.query<{ ok: boolean | null }>('SELECT app.is_team_member($1) AS ok', [teamId]);
  return res.rows[0]?.ok === true;
}

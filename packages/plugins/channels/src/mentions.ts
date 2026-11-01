import type { PluginTx, RoleGroupProvider } from '@manythreads/sdk';
import { BROADCAST_MAX_REACH, broadcastWordsIn, handlePrefix, matchHandle, parseMarkup, type HandleSubject, type RoleGroup } from '@manythreads/shared';
import { broadcastAudience, reachOf, requireBroadcastConfirmed } from './broadcast.ts';
import { mentionBudget } from './mention-budget.ts';
import type { ChannelRow } from './rows.ts';
import type { Deps } from './service.ts';

// What a message body points at (P3-07): `@person` and `#channel` become `message_mentions` rows, `[[thread:...]]` and friends become
// entity links. The parser is the one the composer uses (shared `parseMarkup`): code spans, fences, URLs, emails and escaped marks
// are never mentions. Runs in the transaction of the post or the edit, so a rolled-back message leaves no mention, link or event.

/** At most this many distinct `@handles`, `#channels` and `[[entities]]` of one message are looked at (the rest are plain text). */
const MAX_REFS = 50;
/** At most this many people are notified by one role group in one message (the first by person id); the author is told when a group was cut. */
export const MAX_ROLE_REACH = BROADCAST_MAX_REACH;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Entity references that can be links today: they need a uuid. `[[page:path]]` and `[[task:id]]` follow when those ids are uuids. */
const LINKABLE = new Set(['thread', 'file', 'task']);

export interface MessageRefs {
  id: string;
  body: string;
  /** The author's actor id. */
  authorId: string;
  threadRootId: string | null;
  /** On an edit: the text before it, so a group named then is not announced to its members a second time (a member who joined since stays unannounced). */
  previousBody?: string;
  /** The writer confirmed that `@here` / `@channel` will notify a big room (P14-02); without it a message that adds either word to a room over the limit is refused. */
  confirmBroadcast?: boolean;
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
  /** Words a role group also has: they find a person by exact handle only, so a first name never takes a team's tag away. */
  exactOnly: ReadonlySet<string> = new Set(),
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
    const id = matchHandle(handle, subjects, { exactOnly: exactOnly.has(handle) });
    const hit = id === null ? undefined : subjects.find((s) => s.id === id);
    if (hit) out.set(handle, { personId: hit.id, actorId: hit.actorId });
  }
  return out;
}

/**
 * The role groups of the team that `handles` name (`'all'`: every group, for the picker) and that a mention may use: not closed by a person, a bot or a
 * reserved word (the teams plugin marks those not mentionable, see `roleGroups` in `@manythreads/shared`) and held by at least one person. Only a channel of a
 * team has groups; a caller who cannot read the team gets none. The provider skips the roster when the team has no role tag or every handle is a bot's.
 */
export async function listMentionableGroups({ ctx }: Deps, tx: PluginTx, channel: ChannelRow, handles: readonly string[] | 'all'): Promise<RoleGroup[]> {
  if (handles !== 'all' && handles.length === 0) return [];
  if (channel.team_id === null) return [];
  const provider = ctx.providers.get<RoleGroupProvider>('role.groups');
  if (!provider) return [];
  const listed = await provider.list(tx, channel.team_id, handles === 'all' ? {} : { handles });
  return listed.filter((g) => g.mentionable && (handles === 'all' || handles.includes(g.handle)) && g.personIds.length > 0);
}

/** One group with the people it reaches in this conversation: holders who can read the channel (`app.channel_role_audience`), every one of them. */
export interface ReachedGroup {
  group: RoleGroup;
  people: Array<{ personId: string; actorId: string }>;
}

/** Narrows each group to the holders who can read `channel`. A group nobody there holds is dropped; a guest or a caller outside the channel reaches nobody. */
export async function narrowToReaders(tx: PluginTx, channel: ChannelRow, groups: readonly RoleGroup[]): Promise<ReachedGroup[]> {
  if (groups.length === 0) return [];
  const wanted = [...new Set(groups.flatMap((g) => g.personIds))].sort();
  const rows = await tx.query<{ person_id: string; actor_id: string }>('SELECT person_id, actor_id FROM app.channel_role_audience($1, $2::uuid[])', [channel.id, wanted]);
  const actorOf = new Map(rows.rows.map((r) => [r.person_id, r.actor_id]));
  return groups
    .map((group) => ({
      group,
      people: group.personIds.flatMap((personId) => {
        const actorId = actorOf.get(personId);
        return actorId === undefined ? [] : [{ personId, actorId }];
      }),
    }))
    .filter((g) => g.people.length > 0);
}

/** `listMentionableGroups` then `narrowToReaders`: the picker's list, with the full count of each group (never capped). */
export async function resolveRoleGroups(deps: Deps, tx: PluginTx, channel: ChannelRow, handles: readonly string[] | 'all'): Promise<ReachedGroup[]> {
  return narrowToReaders(tx, channel, await listMentionableGroups(deps, tx, channel, handles));
}

/** A group whose mention reached fewer people than hold it, because one message notifies at most `MAX_ROLE_REACH` people per group. */
export interface GroupNotice {
  handle: string;
  reached: number;
  notified: number;
}

/** `@here` and `@channel` are never a person's or a group's handle: they are the two whole-room words (see `broadcastWordsIn`, and the reserved words in role-handles.ts). */
const isRoomWord = (handle: string): boolean => handle === 'here' || handle === 'channel';
const handlesOf = (body: string): string[] =>
  [...new Set(parseMarkup(body).mentions.map((m) => m.handle.toLowerCase()))].filter((h) => !isRoomWord(h)).slice(0, MAX_REFS);

/**
 * Brings the mentions and links of one message in line with its body: inserts what is new, removes what an edit dropped, announces
 * each newly mentioned person once (`channel.mention.created`) and links the message to the entities it names.
 *
 * Role groups: a handle that is not a person may be a group of the team. A first name never beats a tag (only an exact person handle does), so the groups
 * are looked up first and a word that has one is resolved to people by exact handle only. A group is notified only when it is new in the text (a post, or
 * an edit that adds it): the rows and events go to its holders who can read the channel, at most `MAX_ROLE_REACH` per group, and the author's group budget
 * is charged first (`mention-budget.ts`; over it the post is refused with a 429 and nothing is written). `@channel` and `@here` (P14-02) work like a group of
 * their own (everybody who can read the channel, or those of them online), are told once when new in the text, count against the same budget and the same
 * per-message cut, and in a room of more than 20 other readers need `confirmBroadcast`, else the message is refused with 409 and nothing is written. An edit keeps the rows it has; it adds rows only
 * for what it newly names and removes only the rows of people it stopped naming (a direct `@person`, or a group whose handle was deleted); someone who left the
 * tag since stays recorded while the handle stays in the text. Returns the groups that were cut short.
 */
export async function syncMessageRefs(
  deps: Deps,
  tx: PluginTx,
  channel: ChannelRow,
  message: MessageRefs,
  mode: 'post' | 'edit',
): Promise<GroupNotice[]> {
  const { ctx } = deps;
  const parsed = parseMarkup(message.body);
  const handles = handlesOf(message.body);
  const channelNames = [...new Set(parsed.channels.map((c) => c.name.toLowerCase()))].slice(0, MAX_REFS);
  const entities = [...new Map(parsed.entityRefs.filter((r) => LINKABLE.has(r.type) && UUID.test(r.id)).map((r) => [`${r.type}:${r.id}`, r])).values()].slice(0, MAX_REFS);
  const earlierHandles = mode === 'edit' && message.previousBody !== undefined ? handlesOf(message.previousBody) : [];
  const earlier = new Set(earlierHandles);
  const allHandles = [...new Set([...handles, ...earlierHandles])];

  // 1. Who and what is named. The groups first (their words are matched to people by exact handle only), then the people, then each group's readers.
  const groups = await listMentionableGroups(deps, tx, channel, allHandles);
  const people = await resolvePeople(tx, channel.id, allHandles, new Set(groups.map((g) => g.handle)));
  const reachedAll = await narrowToReaders(tx, channel, groups.filter((g) => !people.has(g.handle)));
  const notAuthor = <T extends { actorId: string }>(list: T[]): T[] => list.filter((p) => p.actorId !== message.authorId);

  const direct = new Map<string, { personId: string; actorId: string }>();
  for (const h of handles) {
    const hit = people.get(h);
    if (hit && hit.actorId !== message.authorId) direct.set(hit.actorId, hit);
  }
  // `@channel` and `@here`: who they tell now, and which of the words this text adds or drops compared with the one before it
  const wordsNow = broadcastWordsIn(message.body);
  const wordsBefore = mode === 'edit' && message.previousBody !== undefined ? broadcastWordsIn(message.previousBody) : [];
  const wordsAdded = wordsNow.filter((w) => !wordsBefore.includes(w));
  const wordsDropped = wordsBefore.filter((w) => !wordsNow.includes(w));
  const room = wordsNow.length + wordsBefore.length > 0 ? await broadcastAudience(tx, channel.id, message.authorId) : { channel: [], here: [] };
  const roomAdded = reachOf(room, wordsAdded);
  requireBroadcastConfirmed(wordsAdded, roomAdded.length, message.confirmBroadcast === true);
  const current = reachedAll.filter((g) => handles.includes(g.group.handle));
  const added = current.filter((g) => !earlier.has(g.group.handle));
  const notices: GroupNotice[] = [];
  const named = new Map<string, { personId: string; actorId: string }>(direct);
  let reachedByGroups = 0;
  for (const g of added) {
    const everyone = notAuthor(g.people).sort((a, b) => (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0));
    const notified = everyone.slice(0, MAX_ROLE_REACH);
    if (notified.length < everyone.length) notices.push({ handle: g.group.handle, reached: everyone.length, notified: notified.length });
    reachedByGroups += notified.length;
    for (const p of notified) named.set(p.actorId, p);
  }
  // the room words are one more group: told once, the first `MAX_ROLE_REACH` by person id, and the author is told when it was cut
  const roomNotified = roomAdded.slice(0, MAX_ROLE_REACH);
  if (roomNotified.length < roomAdded.length) notices.push({ handle: wordsAdded.includes('channel') ? 'channel' : 'here', reached: roomAdded.length, notified: roomNotified.length });
  for (const p of roomNotified) named.set(p.actorId, p);
  reachedByGroups += roomNotified.length;
  // The budget is charged before anything is written. It counts per acting actor, so a webhook (a system-kind actor of its own) has a budget of its own too.
  const groupsCharged = added.length + (roomNotified.length > 0 ? 1 : 0);
  if (groupsCharged > 0 && reachedByGroups > 0) mentionBudget.take(`${tx.actor.id}:${channel.team_id}`, groupsCharged, reachedByGroups);

  const mentioned: Array<{ kind: 'person' | 'channel'; id: string; personId: string | null }> = [...named.values()].map((p) => ({ kind: 'person' as const, id: p.actorId, personId: p.personId }));
  const wantPeople = new Set([...direct.keys(), ...current.flatMap((g) => notAuthor(g.people).map((p) => p.actorId)), ...reachOf(room, wordsNow).map((p) => p.actorId)]);
  if (channelNames.length > 0 && channel.team_id) {
    const found = await tx.query<{ id: string }>(
      `SELECT id FROM app.channels WHERE team_id = $1 AND kind = 'channel' AND name = ANY ($2::text[])`,
      [channel.team_id, channelNames],
    );
    for (const r of found.rows) mentioned.push({ kind: 'channel', id: r.id, personId: null });
  }

  // 2. Rows: insert the new, delete what an edit stopped naming, announce each newly named person once.
  const existing =
    mode === 'edit'
      ? (await tx.query<{ mentioned_id: string; kind: string }>('SELECT mentioned_id, kind FROM app.message_mentions WHERE message_id = $1', [message.id])).rows
      : [];
  const had = new Set(existing.map((r) => `${r.kind}:${r.mentioned_id}`));
  const want = new Set(mentioned.map((m) => `${m.kind}:${m.id}`));
  const fresh = mentioned.filter((m) => !had.has(`${m.kind}:${m.id}`));
  // People who were named by the earlier text and are named by no one now: a direct `@person` that was deleted, or the members of a group whose handle was.
  const namedBefore = new Set<string>();
  for (const h of earlierHandles) {
    const hit = people.get(h);
    if (hit) namedBefore.add(hit.actorId);
  }
  for (const g of reachedAll) if (earlier.has(g.group.handle) && !handles.includes(g.group.handle)) for (const p of g.people) namedBefore.add(p.actorId);
  for (const p of reachOf(room, wordsDropped)) namedBefore.add(p.actorId);
  const dropped = existing.filter((r) => (r.kind === 'channel' ? !want.has(`channel:${r.mentioned_id}`) : namedBefore.has(r.mentioned_id) && !wantPeople.has(r.mentioned_id)));
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
  // One multi-row write for all the events, so a mention of a big group is a few statements, not one round trip per person.
  const events = fresh
    .filter((m) => m.kind === 'person')
    .map((m) => ({
      type: 'channel.mention.created',
      channelId: channel.id,
      teamId: channel.team_id,
      messageId: message.id,
      threadRootId: message.threadRootId,
      authorId: message.authorId,
      kind: 'person',
      mentionedId: m.id,
      personId: m.personId,
    }));
  await ctx.audit.emitMany(tx, events);

  // 3. Links: only for a team channel the author belongs to (the link table is for team members), and only to entities the author can
  //    see (the type's resolver answers for the caller; none registered, or hidden, or missing: no link).
  const teamId = channel.team_id;
  const mayLink = teamId !== null && (entities.length > 0 || mode === 'edit') && (await isTeamMember(tx, teamId));
  if (!mayLink || teamId === null) return notices;
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
  return notices;
}

async function isTeamMember(tx: PluginTx, teamId: string): Promise<boolean> {
  const res = await tx.query<{ ok: boolean | null }>('SELECT app.is_team_member($1) AS ok', [teamId]);
  return res.rows[0]?.ok === true;
}

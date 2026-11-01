import { HttpError, type PluginTx } from '@manythreads/sdk';
import {
  BROADCAST_CONFIRM_ABOVE,
  BroadcastReach,
  BroadcastReachPathParams,
  PRESENCE_TTL_SECONDS,
  broadcastReachRoute,
  broadcastSentence,
  broadcastWordsIn,
  type BroadcastWord,
} from '@manythreads/shared';
import { json, route } from './http.ts';
import { requireChannel, type Deps } from './service.ts';

// `@channel` and `@here` (PLAN P14-02; docs/plugins/channels.md). `@channel` tells everybody who can read the channel, `@here` those of them who are online.
// Both are real mentions (a row and a `channel.mention.created` event per person, like any `@person`), limited the way a role group is limited: the writer's
// group budget is charged and one message tells at most `MAX_ROLE_REACH` people. A room with more than `BROADCAST_CONFIRM_ABOVE` other readers makes the
// writer confirm first. A guest's words, and a bot's or a webhook's, are plain text: nobody is told.

export interface Reached {
  personId: string;
  actorId: string;
}

export interface BroadcastAudience {
  /** Everybody who can read the channel and is active, but the writer. */
  channel: Reached[];
  /** Those of them with a heartbeat in the last `PRESENCE_TTL_SECONDS`. */
  here: Reached[];
}

const bySortedPerson = (a: Reached, b: Reached): number => (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0);

/**
 * Who `@channel` and `@here` would tell in this channel, for the caller. Empty for a caller who is not a signed-in non-guest person: the audience function
 * answers only to a reader of the channel who is not a guest (`channel_role_audience`, the same door the role groups use).
 */
export async function broadcastAudience(tx: PluginTx, channelId: string, selfActorId: string): Promise<BroadcastAudience> {
  const readers = await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1)', [channelId]);
  const ids = readers.rows.map((r) => r.person_id);
  if (ids.length === 0) return { channel: [], here: [] };
  const known = await tx.query<{ person_id: string; actor_id: string }>('SELECT person_id, actor_id FROM app.channel_role_audience($1, $2::uuid[])', [channelId, ids]);
  const channel = known.rows.filter((r) => r.actor_id !== selfActorId).map((r) => ({ personId: r.person_id, actorId: r.actor_id })).sort(bySortedPerson);
  if (channel.length === 0) return { channel, here: [] };
  const online = await tx.query<{ person_id: string }>(
    `SELECT person_id FROM app.presence WHERE person_id = ANY ($1::uuid[]) AND seen_at > now() - make_interval(secs => $2)`,
    [channel.map((r) => r.personId), PRESENCE_TTL_SECONDS],
  );
  const onlineIds = new Set(online.rows.map((r) => r.person_id));
  return { channel, here: channel.filter((r) => onlineIds.has(r.personId)) };
}

/** The people the given words would tell: `@channel` takes everybody, `@here` only those online (a message that has both tells the larger set). */
export function reachOf(audience: BroadcastAudience, words: readonly BroadcastWord[]): Reached[] {
  if (words.includes('channel')) return audience.channel;
  if (words.includes('here')) return audience.here;
  return [];
}

/** 409 `broadcast_needs_confirmation` with a plain sentence, when the words would tell more than the limit and the writer did not confirm. The request is rolled back with everything it wrote, so nothing stays. */
export function requireBroadcastConfirmed(words: readonly BroadcastWord[], reach: number, confirmed: boolean): void {
  if (words.length === 0 || confirmed || reach <= BROADCAST_CONFIRM_ABOVE) return;
  throw new HttpError(409, 'broadcast_needs_confirmation', `${broadcastSentence(words, reach)} Confirm to send it.`);
}

/**
 * For a message that is posted later (scheduled): the same agreement a typed message needs, asked now because nobody can be asked when the job posts it.
 * Throws the same 409 when the text names `@channel` / `@here` for a big room without `confirmed`. Answers what to keep on the row: true only when the text
 * names a word and the writer agreed.
 */
export async function requireScheduledBroadcast(tx: PluginTx, channelId: string, text: string, confirmed: boolean): Promise<boolean> {
  const words = broadcastWordsIn(text);
  if (words.length === 0) return false;
  const audience = await broadcastAudience(tx, channelId, tx.actor.id);
  requireBroadcastConfirmed(words, reachOf(audience, words).length, confirmed);
  return confirmed;
}

/** How many people each word would tell here: what the composer asks before it shows the confirmation. */
export function registerBroadcastRoutes(deps: Deps): void {
  const { ctx } = deps;
  ctx.http.route({
    ...broadcastReachRoute,
    schema: { response: BroadcastReach },
    rateLimit: { limit: 120, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = BroadcastReachPathParams.parse(req.params);
      await requireChannel(tx, channelId);
      const audience = await broadcastAudience(tx, channelId, tx.actor.id);
      return json(BroadcastReach.parse({ channel: audience.channel.length, here: audience.here.length, confirmAbove: BROADCAST_CONFIRM_ABOVE }));
    }),
  });
}

import { HttpError, conflict, forbidden, json, notFound, route, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  CALL_OPTIONS_PEOPLE_MAX,
  CallStartOptionsQuery,
  CallStartOptionsResponse,
  InviteToMeetingRequest,
  InviteToMeetingResponse,
  MeetingPathParams,
  MeetingsInviteSentEvent,
  StartMeetingPathParams,
  callStartOptionsRoute,
  inviteToMeetingRoute,
} from '@manythreads/shared';
import { announceRoom } from './live.ts';
import { currentMedia, NOT_SET_UP } from './media.ts';
import { eligibleBots, notetakerPlaceAvailability, toBot } from './notetaker.ts';
import { callerPerson, defaultTitle, type Caller } from './routes.ts';
import { loadMeeting, type MeetingRow } from './rows.ts';

// Invitations to a call and the start dialog's options (P15-25, P15-27; docs/plugins/meetings.md "Starting a call and inviting people"). An invitation says who is told
// (the notifications plugin makes an inbox item and a push from `meetings.invite.sent`); it never decides who may join, which stays "whoever can read the channel".
// Who may be asked is decided by the database (`app.meetings_invite`): only readers of the channel, the whole list or nothing. A call in a direct message invites nobody:
// everyone in the conversation is rung when it starts.

interface ChannelFacts extends Record<string, unknown> {
  kind: string;
  name: string;
  team_id: string | null;
  archived: boolean;
}

/** The channel as the caller reads it; undefined when they cannot read it. */
export async function channelFacts(tx: PluginTx, channelId: string): Promise<ChannelFacts | undefined> {
  return (await tx.query<ChannelFacts>('SELECT kind, name, team_id, archived_at IS NOT NULL AS archived FROM app.channels WHERE id = $1::uuid', [channelId])).rows[0];
}

/**
 * Asks `personIds` to the live call `m` as the caller and says so (`meetings.invite.sent`, `first` when the call is just opening). The database refuses the whole list when
 * one person cannot read the channel (403 with that reason) and leaves out the caller and the people asked before. Returns the people newly asked.
 */
export async function inviteToCall(ctx: PluginContext, tx: PluginTx, m: MeetingRow, caller: Caller, personIds: readonly string[], first: boolean): Promise<string[]> {
  if (personIds.length === 0) return [];
  let added: string[];
  try {
    added = (await tx.query<{ ids: string[] }>('SELECT app.meetings_invite($1::uuid, $2::uuid[]) AS ids', [m.id, [...personIds]])).rows[0]?.ids ?? [];
  } catch (err) {
    // the function's refusals become fixed sentences: the database's own words never reach the person
    const { code, message } = err as { code?: unknown; message?: unknown };
    if (code === '42501') throw forbidden('You cannot invite these people to this call.');
    if (code === '23514') throw conflict(INVITE_REFUSALS.find(([known]) => typeof message === 'string' && message.startsWith(known))?.[1] ?? 'These people cannot be invited to this call now.');
    throw err;
  }
  if (added.length === 0) return [];
  await ctx.audit.emit(
    tx,
    MeetingsInviteSentEvent.parse({
      type: 'meetings.invite.sent',
      schemaVersion: 1,
      workspaceId: m.workspace_id,
      teamId: m.team_id,
      channelId: m.channel_id,
      meetingId: m.id,
      invitedBy: caller.actorId,
      personIds: added,
      first,
      at: ctx.runtime.now().toISOString(),
    }),
  );
  return added;
}

/**
 * Whether the start dialog offers "Let people outside the workspace join with a link" (P17-04), and why not: the database asks the same questions when the link is
 * made (`app.meetings_make_guest_link`), so this only words them for the dialog.
 */
export function guestLinkOffer(o: { directMessage: boolean; role: string | null; switchOn: boolean; mediaReason: string | null }): { available: boolean; reason: string | null } {
  if (o.directMessage) return { available: false, reason: 'A call in a direct message cannot have guest links.' };
  if (o.role === null || o.role === 'guest') return { available: false, reason: 'Workspace guests cannot make guest links.' };
  if (!o.switchOn) return { available: false, reason: 'Guest links are switched off for this workspace. A workspace admin can allow them.' };
  if (o.mediaReason !== null) return { available: false, reason: o.mediaReason };
  return { available: true, reason: null };
}

/** The checks of `app.meetings_invite` that can pass or be fixed, and the sentence each answers with (matched on the start of the database's message, never forwarded). */
const INVITE_REFUSALS: readonly (readonly [string, string])[] = [
  ['This call has ended', 'This call has ended.'],
  ['At most 100 people', 'At most 100 people can be invited at once.'],
  ['A call without a channel', 'A call without a channel has nobody to invite.'],
  ['A call in a direct message', 'Everyone in this conversation was rung when the call started.'],
];

export function registerInviteRoutes(ctx: PluginContext): void {
  // ---- what the start dialog offers ---------------------------------------------------------------------------------------------
  ctx.http.route({
    ...callStartOptionsRoute,
    schema: { query: CallStartOptionsQuery, response: CallStartOptionsResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    // not read-only on purpose: the note-taker check reads the team's TEAM.md, which may make the team's repository on first use (MISTAKES P15-05)
    handler: route(async (req, tx) => {
      const { channelId } = StartMeetingPathParams.parse(req.params);
      const { q } = CallStartOptionsQuery.parse(req.query ?? {});
      const caller = await callerPerson(tx);
      const now = ctx.runtime.now();
      const channel = await channelFacts(tx, channelId);
      const directMessage = channel?.kind === 'dm';
      const can = (
        await tx.query<{ post: boolean | null; role: string | null; guests_on: boolean }>(
          `SELECT app.lookup_channel_can($1::uuid, 'post') AS post, app.workspace_role() AS role,
                  coalesce((SELECT s.guest_links_allowed FROM app.meeting_settings s WHERE s.workspace_id = app.workspace_id()), true) AS guests_on`,
          [channelId],
        )
      ).rows[0];
      const base = {
        directMessage,
        defaultTitle: defaultTitle(now, channel ?? null),
        guestLinks: guestLinkOffer({ directMessage, role: can?.role ?? null, switchOn: can?.guests_on !== false, mediaReason: null }),
      };
      if (!channel || can?.post !== true) {
        const reason = !channel
          ? 'You cannot start a call in this channel'
          : channel.archived
            ? 'This channel is archived, so no call can start in it'
            : can?.role === 'guest'
              ? 'Guests cannot start a call here'
              : 'You cannot start a call in this channel';
        return json(CallStartOptionsResponse.parse({ ...base, canStart: false, reason, live: null, people: [], peopleTotal: 0, notetaker: { bots: [], defaultBotId: null, available: false, reason: null } }));
      }
      const media = currentMedia(ctx);
      const status = media?.status();
      const mediaReason = !media ? NOT_SET_UP : status?.configured ? null : (status?.reason ?? NOT_SET_UP);

      const live = (await tx.query<{ id: string; title: string }>("SELECT id, title FROM app.meetings WHERE channel_id = $1::uuid AND state = 'live'", [channelId])).rows[0];
      // The readers of the channel, by the name the caller may read (`people` shows a guest only themself, so a guest is offered nobody else). The caller comes first and is
      // always there; `q` keeps the people whose name has a word starting with it, or whose handle (the e-mail address) starts with it. At most 200 are sent.
      const prefix = q ? `${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const people = (
        await tx.query<{ person_id: string; display_name: string; you: boolean; total: number }>(
          `WITH r AS (
             SELECT p.id AS person_id, coalesce(nullif(btrim(p.display_name), ''), 'Someone') AS display_name, p.id = app.person_id() AS you
               FROM app.channel_audience($1::uuid) au JOIN app.people p ON p.id = au.person_id
              WHERE p.id = app.person_id() OR $2::text IS NULL
                 OR lower(p.display_name) LIKE $2 ESCAPE '\\' OR lower(p.display_name) LIKE '% ' || $2 ESCAPE '\\' OR lower(p.primary_email) LIKE $2 ESCAPE '\\')
           SELECT r.*, (count(*) OVER ())::int AS total FROM r ORDER BY r.you DESC, lower(r.display_name), r.person_id LIMIT $3`,
          [channelId, prefix, CALL_OPTIONS_PEOPLE_MAX],
        )
      ).rows;
      let peopleTotal = people[0]?.total ?? 0;
      if (!people.some((p) => p.you)) {
        people.unshift({ person_id: caller.personId, display_name: 'You', you: true, total: peopleTotal + 1 });
        if (people.length > CALL_OPTIONS_PEOPLE_MAX) people.pop();
        peopleTotal += 1;
      }

      const bots = await eligibleBots(tx, channel.team_id);
      const place = await notetakerPlaceAvailability(ctx, tx, channel.team_id);
      const notetaker =
        bots.length === 0
          ? { bots: [], defaultBotId: null, available: false, reason: 'No note-taker bot is set up here. A workspace admin can add one.' }
          : { bots: bots.map(toBot), defaultBotId: bots[0]!.id, available: place.canAdd, reason: place.canAdd ? null : place.reason };
      return json(
        CallStartOptionsResponse.parse({
          ...base,
          guestLinks: guestLinkOffer({ directMessage, role: can?.role ?? null, switchOn: can?.guests_on !== false, mediaReason }),
          canStart: mediaReason === null,
          reason: mediaReason,
          live: live ? { meetingId: live.id, title: live.title } : null,
          people: people.map((p) => ({ personId: p.person_id, displayName: p.display_name, you: p.you })),
          peopleTotal,
          notetaker,
        }),
      );
    }),
  });

  // ---- invite more --------------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...inviteToMeetingRoute,
    schema: { body: InviteToMeetingRequest, response: InviteToMeetingResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const { personIds } = InviteToMeetingRequest.parse(req.body);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That call is not available');
      if (m.state !== 'live') throw conflict('This call has ended');
      if (!m.channel_id) throw conflict('A call without a channel has nobody to invite');
      const channel = await channelFacts(tx, m.channel_id);
      if (channel?.kind === 'dm') throw new HttpError(409, 'conflict', 'Everyone in this conversation was rung when the call started');
      const invited = await inviteToCall(ctx, tx, m, caller, personIds, false);
      if (invited.length > 0) await announceRoom(ctx, tx, m);
      return json(InviteToMeetingResponse.parse({ invited }));
    }),
  });
}

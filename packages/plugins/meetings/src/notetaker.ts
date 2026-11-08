import {
  HttpError,
  forbidden,
  json,
  notFound,
  route,
  type LlmTranscriber,
  type MessageProvider,
  type PluginContext,
  type PluginTx,
  type RepoProvider,
} from '@manythreads/sdk';
import {
  ListMeetingNotetakersResponse,
  MeetingNotetaker,
  MeetingNotetakerBot,
  MeetingPathParams,
  MeetingsConsentChangedEvent,
  MeetingsNotetakerAddedEvent,
  MeetingsNotetakerRemovedEvent,
  RemoveMeetingNotetakerResponse,
  SetMeetingNotetakerRequest,
  SetMeetingNotetakerResponse,
  TeamMeetingsBundleConfig,
  listMeetingNotetakersRoute,
  removeMeetingNotetakerRoute,
  setMeetingNotetakerRoute,
} from '@manythreads/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { loadMeetingsSettings, transcribeLimits } from './config.ts';
import { stripHostileText } from './limits.ts';
import { LISTENER_START_QUEUE, isListening, maxRooms } from './listener.ts';
import { announceRoom } from './live.ts';
import { NOT_SET_UP, currentMedia } from './media.ts';
import { loadMeeting, type MeetingRow } from './rows.ts';

// Work package S4 (P15-18): adding and removing a room's note-taker (PLAN decisions C13, C16, C17).
//
// A note-taker is a bot of the room's team (or a workspace-wide bot) whose BOT.md lists the trigger `meeting`. Anyone in the room may add one; the organizer, the person who
// added it or a lead of the team removes it (the SQL function `app.meetings_set_notetaker` decides who). Adding it moves the room's transcription to the server and asks
// everybody again (also in that function). The listener itself, which joins the room and hears the people who said yes, is `listener.ts`; this file starts it with a job,
// so it begins only after the change is committed.
//
// What is checked here and not in the database: the media server can host a listener, the workspace and the team allow note-takers, transcription is not switched off, a
// speech model is set up on the server, and this server process has room for one more (`MANYTHREADS_NOTETAKER_MAX_ROOMS`). Everything is checked before anything is written.

export const ANNOUNCE_QUEUE = 'meetings.notetaker.announce';

const AnnouncePayload = z.object({
  meetingId: z.uuid(),
  workspaceId: z.uuid(),
  actorId: z.uuid(),
  botId: z.uuid(),
  what: z.enum(['added', 'removed']),
});

interface Caller {
  actorId: string;
  personId: string;
}

async function callerPerson(tx: PluginTx): Promise<Caller> {
  const row = (await tx.query<{ person: string | null; actor: string | null }>('SELECT app.person_id() AS person, app.actor() AS actor')).rows[0];
  if (!row?.person || !row.actor) throw forbidden('Voice rooms are for people');
  return { actorId: row.actor, personId: row.person };
}

// ---- what TEAM.md says -------------------------------------------------------------------------------------------------------------------

const frontmatterOf = (text: string): string | null => {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? (m[1] as string) : null;
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether the team's `TEAM.md` allows a note-taker (`meetings.noteTaker`, default on). A key that is left out means on; a `noteTaker` that is there but not `on` or `off`
 * (a typo) reads as off, so a team that meant to keep note-takers out never gets one by accident. The other keys under `meetings` are not this function's business.
 */
export function readTeamNotetakerAllowed(teamMd: string | null): boolean {
  if (teamMd === null) return true;
  const block = frontmatterOf(teamMd);
  if (block === null) return true;
  let doc: unknown;
  try {
    doc = parseYaml(block, { maxAliasCount: 20 });
  } catch {
    return false;
  }
  if (doc === null || doc === undefined) return true;
  if (!isRecord(doc)) return false;
  const meetings = doc['meetings'];
  if (meetings === undefined || meetings === null) return true;
  if (!isRecord(meetings)) return false;
  if (meetings['noteTaker'] === undefined) return true;
  const parsed = TeamMeetingsBundleConfig.shape.noteTaker.safeParse(meetings['noteTaker']);
  return parsed.success && parsed.data === 'on';
}

async function loadTeamNotetakerAllowed(ctx: PluginContext, tx: PluginTx, teamId: string): Promise<boolean> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return true;
  try {
    const blob = await repo.blob(tx, teamId, 'TEAM.md', 'main', 256 * 1024);
    return readTeamNotetakerAllowed(new TextDecoder().decode(blob.content));
  } catch (err) {
    return (err as { status?: unknown }).status === 404;
  }
}

// ---- who may be added ---------------------------------------------------------------------------------------------------------------------

interface BotRow extends Record<string, unknown> {
  id: string;
  slug: string;
  name: string;
  role: string;
  avatar: string | null;
}

const toBot = (r: BotRow): MeetingNotetakerBot => MeetingNotetakerBot.parse({ botId: r.id, slug: r.slug, name: r.name, role: r.role, avatar: r.avatar });

/** The active bots the caller can see whose BOT.md lists the trigger `meeting`, of the room's team or workspace-wide (the same rule the SQL function applies, plus the trigger). */
async function eligibleBots(tx: PluginTx, m: MeetingRow): Promise<BotRow[]> {
  return (
    await tx.query<BotRow>(
      `SELECT b.id, b.slug, b.name, b.role, b.avatar FROM app.bots b
        WHERE b.status = 'active' AND b.triggers @> '[{"type": "meeting"}]'::jsonb
          AND (b.visibility = 'workspace' OR ($1::uuid IS NOT NULL AND b.team_id = $1::uuid))
        ORDER BY b.name, b.id LIMIT 50`,
      [m.team_id],
    )
  ).rows;
}

interface Availability {
  canAdd: boolean;
  reason: string | null;
  /** The status a refused add answers with: 403 for a switch somebody turned off, 409 for a state that may pass. */
  status: 403 | 409;
}

const open = (): Availability => ({ canAdd: true, reason: null, status: 409 });
const shut = (reason: string, status: 403 | 409 = 409): Availability => ({ canAdd: false, reason, status });

/** How many rooms with a note-taker this server holds besides `exceptMeetingId` (the database's view: the rooms live now with a note-taker set). */
async function otherNotetakerRooms(ctx: PluginContext, exceptMeetingId: string): Promise<number> {
  return ctx.db.system(
    async (tx) =>
      (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.meetings WHERE state = 'live' AND notetaker_bot_id IS NOT NULL AND id <> $1::uuid", [exceptMeetingId])).rows[0]?.n ?? 0,
  );
}

/** Whether a note-taker may be added to this room right now, and if not, why, in plain words. */
export async function notetakerAvailability(ctx: PluginContext, tx: PluginTx, m: MeetingRow, callerActorId: string): Promise<Availability> {
  const media = currentMedia(ctx);
  if (!media) return shut(NOT_SET_UP);
  const status = media.status();
  if (!status.configured) return shut(status.reason ?? NOT_SET_UP);
  if (typeof media.listen !== 'function') return shut('This media server cannot host a note-taker.');
  if (m.state !== 'live') return shut('This voice room has ended.');
  const here = await tx.query('SELECT 1 FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid AND left_at IS NULL', [m.id, callerActorId]);
  if (here.rows.length === 0) return shut('Join the voice room to add a note-taker.', 403);
  if (m.notetaker_bot_id) return shut('This room already has a note-taker.');
  const settings = await loadMeetingsSettings(tx);
  if (!settings.notetakerAllowed) return shut('Note-takers are switched off for this workspace. A workspace admin can allow them.', 403);
  if (m.team_id !== null && !(await loadTeamNotetakerAllowed(ctx, tx, m.team_id))) {
    return shut('Note-takers are switched off for this team. A team lead can allow them in the team’s TEAM.md.', 403);
  }
  // transcription switched off (by the workspace or the team) means nothing is written down, by a person's device or by a bot
  const limits = await transcribeLimits(ctx, tx, m.team_id);
  if (limits.allowed.length === 0) return shut(limits.reason ?? 'Transcription is not allowed here.', 403);
  const transcriber = ctx.providers.get<LlmTranscriber>('llm');
  if (!transcriber || typeof transcriber.transcribe !== 'function') return shut('Transcription on the server is not set up. Ask a workspace admin to connect a speech model.');
  if ((await otherNotetakerRooms(ctx, m.id)) >= maxRooms()) return shut('The note-taker is busy, try again in a minute.');
  return open();
}

async function currentNotetaker(ctx: PluginContext, tx: PluginTx, m: MeetingRow): Promise<MeetingNotetaker | null> {
  if (!m.notetaker_bot_id) return null;
  const bot = (await tx.query<BotRow>('SELECT b.id, b.slug, b.name, b.role, b.avatar FROM app.bots b WHERE b.id = $1::uuid', [m.notetaker_bot_id])).rows[0];
  if (!bot) return null;
  return MeetingNotetaker.parse({ bot: toBot(bot), listening: isListening(ctx, m.id) });
}

// ---- the words in the call thread -------------------------------------------------------------------------------------------------------

/** A name as it goes into a message: controls and bidirectional characters out, markdown signs escaped, and short. */
function plain(name: string): string {
  return stripHostileText(name).replace(/[\\`*_[\]<>~|#]/g, (c) => `\\${c}`).slice(0, 100) || 'Someone';
}

async function emitConsentReset(ctx: PluginContext, tx: PluginTx, m: MeetingRow, actorId: string): Promise<void> {
  await ctx.audit.emit(
    tx,
    MeetingsConsentChangedEvent.parse({
      type: 'meetings.consent.changed',
      schemaVersion: 1,
      workspaceId: m.workspace_id,
      teamId: m.team_id,
      channelId: m.channel_id,
      meetingId: m.id,
      actorId,
      subject: 'room_transcription',
      value: 'yes',
      at: ctx.runtime.now().toISOString(),
    }),
  );
}

export function registerNotetaker(ctx: PluginContext): void {
  // ---- who can be added, and what is there now ----------------------------------------------------------------------------------
  ctx.http.route({
    ...listMeetingNotetakersRoute,
    schema: { response: ListMeetingNotetakersResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    // not read-only on purpose: reading the team's TEAM.md may make the team's repository on first use, which writes
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      const bots = await eligibleBots(tx, m);
      const current = await currentNotetaker(ctx, tx, m);
      const available = await notetakerAvailability(ctx, tx, m, caller.actorId);
      return json(ListMeetingNotetakersResponse.parse({ bots: bots.map(toBot), current, canAdd: available.canAdd, reason: available.reason }));
    }),
  });

  // ---- add ----------------------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...setMeetingNotetakerRoute,
    schema: { body: SetMeetingNotetakerRequest, response: SetMeetingNotetakerResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const { botId } = SetMeetingNotetakerRequest.parse(req.body);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      // the same bot again changes nothing (in a room that is still going)
      if (m.notetaker_bot_id === botId && m.state === 'live') {
        const same = await currentNotetaker(ctx, tx, m);
        if (same) return json(SetMeetingNotetakerResponse.parse({ notetaker: same }));
      }
      const available = await notetakerAvailability(ctx, tx, m, caller.actorId);
      if (!available.canAdd) throw new HttpError(available.status, available.status === 403 ? 'forbidden' : 'conflict', available.reason ?? 'A note-taker cannot be added now.');
      const bot = (await eligibleBots(tx, m)).find((b) => b.id === botId);
      if (!bot) throw new HttpError(409, 'conflict', 'This bot cannot be the note-taker of this room.');

      const changed = (await tx.query<{ changed: boolean }>('SELECT app.meetings_set_notetaker($1::uuid, $2::uuid) AS changed', [m.id, bot.id])).rows[0]?.changed === true;
      const after = (await loadMeeting(tx, m.id)) ?? m;
      if (changed) {
        await ctx.audit.emit(
          tx,
          MeetingsNotetakerAddedEvent.parse({
            type: 'meetings.notetaker.added',
            schemaVersion: 1,
            workspaceId: m.workspace_id,
            teamId: m.team_id,
            channelId: m.channel_id,
            meetingId: m.id,
            botId: bot.id,
            addedBy: caller.actorId,
            at: ctx.runtime.now().toISOString(),
          }),
        );
        // everybody was asked again by the SQL function: say so as turning transcription on does
        await emitConsentReset(ctx, tx, after, caller.actorId);
        await announceRoom(ctx, tx, after);
        await ctx.jobs.enqueue(tx, ANNOUNCE_QUEUE, { meetingId: m.id, workspaceId: m.workspace_id, actorId: caller.actorId, botId: bot.id, what: 'added' }, { dedupeKey: `announce:added:${m.id}:${bot.id}` });
        await ctx.jobs.enqueue(tx, LISTENER_START_QUEUE, { meetingId: m.id, workspaceId: m.workspace_id }, { dedupeKey: `listener:${m.id}` });
      }
      return json(SetMeetingNotetakerResponse.parse({ notetaker: { bot: toBot(bot), listening: isListening(ctx, m.id) } }));
    }),
  });

  // ---- remove -------------------------------------------------------------------------------------------------------------------
  ctx.http.route({
    ...removeMeetingNotetakerRoute,
    schema: { response: RemoveMeetingNotetakerResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      const botId = m.notetaker_bot_id;
      if (!botId) return json(RemoveMeetingNotetakerResponse.parse({ removed: false }));
      // the SQL function says who may: the organizer, the starter, the person who added it, a lead of the team or an admin
      const removed = (await tx.query<{ changed: boolean }>('SELECT app.meetings_set_notetaker($1::uuid, NULL) AS changed', [m.id])).rows[0]?.changed === true;
      if (removed) {
        await ctx.audit.emit(
          tx,
          MeetingsNotetakerRemovedEvent.parse({
            type: 'meetings.notetaker.removed',
            schemaVersion: 1,
            workspaceId: m.workspace_id,
            teamId: m.team_id,
            channelId: m.channel_id,
            meetingId: m.id,
            botId,
            removedBy: caller.actorId,
            at: ctx.runtime.now().toISOString(),
          }),
        );
        await announceRoom(ctx, tx, { id: m.id, channel_id: m.channel_id, state: m.state });
        await ctx.jobs.enqueue(tx, ANNOUNCE_QUEUE, { meetingId: m.id, workspaceId: m.workspace_id, actorId: caller.actorId, botId, what: 'removed' }, { dedupeKey: `announce:removed:${m.id}:${botId}` });
        // the listener notices within two seconds that the note-taker is gone, hears what is left, writes the last of the transcript and leaves
      }
      return json(RemoveMeetingNotetakerResponse.parse({ removed }));
    }),
  });

  // ---- the line in the call thread ------------------------------------------------------------------------------------------------
  // A job and not the route, so a message that cannot be posted (the person may not post there) never undoes the change. It is written as the person who acted.
  ctx.jobs.register(
    ANNOUNCE_QUEUE,
    async (payload, _tx, job) => {
      const p = AnnouncePayload.parse(payload);
      const messages = ctx.providers.get<MessageProvider>('messages');
      if (!messages) return;
      const facts = await job.transaction(async (tx) => {
        const room = (
          await tx.query<{ channel_id: string | null; thread_root_id: string | null; organizer_id: string }>('SELECT channel_id, thread_root_id, organizer_id FROM app.meetings WHERE id = $1::uuid', [p.meetingId])
        ).rows[0];
        if (!room?.channel_id || !room.thread_root_id) return null;
        const names = await tx.query<{ actor_id: string; display_name: string }>(
          'SELECT actor_id, display_name FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = ANY ($2::uuid[])',
          [p.meetingId, [p.actorId, room.organizer_id]],
        );
        const bot = (await tx.query<{ name: string }>('SELECT name FROM app.bots WHERE id = $1::uuid', [p.botId])).rows[0];
        const nameOf = (id: string): string => names.rows.find((n) => n.actor_id === id)?.display_name ?? 'Someone';
        return { channelId: room.channel_id, threadRootId: room.thread_root_id, who: nameOf(p.actorId), organizer: nameOf(room.organizer_id), bot: bot?.name ?? 'The note-taker' };
      });
      if (!facts) return;
      const body =
        p.what === 'added'
          ? `${plain(facts.who)} added ${plain(facts.bot)}. It listens on the server and writes notes for ${plain(facts.organizer)}. Everyone is asked again whether it may transcribe their voice.`
          : `${plain(facts.who)} removed ${plain(facts.bot)}.`;
      try {
        await ctx.db.as({ actorId: p.actorId, kind: 'person', workspaceId: p.workspaceId, personId: null, sessionId: null }, async (tx) => {
          await messages.post(tx, { channelId: facts.channelId, body, threadRootId: facts.threadRootId, skipRefs: true });
        });
      } catch {
        job.log.warn('meetings: the note-taker notice could not be posted in the call thread');
      }
    },
    { maxAttempts: 1 },
  );
}

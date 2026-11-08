import { forbidden, type MeetingRunsProvider, type MessageProvider, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { MEETING_CHANGED_PUSH, MeetingChangedPush } from '@manythreads/shared';
import { loadMeeting, type MeetingRow } from './rows.ts';

// Work package S5 (P15-21 to P15-23): who may open a meeting's notes, and the small things the notes, share and save routes have in common.
//
// A note-taker meeting's files live in the organizer's Personal space, which only the organizer reads. Everyone else reads through these routes, which decide on every request
// (`app.meetings_can_read_notes`: the organizer; a person the notes were shared with who is still in the place the call happened; a reader of a channel it was shared with;
// the readers of the place once the organizer saved the notes to the team) and then read the rows as the system. A person who may not read gets 404: "no such meeting".

export async function callerPerson(tx: PluginTx): Promise<{ actorId: string; personId: string }> {
  const row = (await tx.query<{ person: string | null; actor: string | null }>('SELECT app.person_id() AS person, app.actor() AS actor')).rows[0];
  if (!row?.person || !row.actor) throw forbidden('Voice rooms are for people');
  return { actorId: row.actor, personId: row.person };
}

/** The meeting as the caller may see it, whatever way in: the room itself (the caller's own row-level security), else a share. Null when neither lets them in. */
export interface NotesAccess {
  meeting: MeetingRow;
  /** True when `app.meetings_can_read_notes` said yes; false for a reader who may see the room but whose notes are not there yet (nothing is shown but the status). */
  canRead: boolean;
}

/**
 * The caller's way in to a meeting's notes. `canRead` follows the database function; a reader of the room who is not allowed to read the notes yet is let in only to see
 * that there are none (a room with no note-taker and no notes row), so a live or just-ended room can show "notes are being written" without showing anything else.
 */
export async function notesAccess(ctx: PluginContext, tx: PluginTx, meetingId: string, options: { roomOnly?: boolean } = {}): Promise<NotesAccess | null> {
  const can = (await tx.query<{ ok: boolean | null }>('SELECT app.meetings_can_read_notes($1::uuid) AS ok', [meetingId])).rows[0]?.ok === true;
  if (can) {
    const meeting = await ctx.db.system((sys) => loadMeeting(sys, meetingId), { workspaceId: tx.actor.workspaceId });
    return meeting ? { meeting, canRead: true } : null;
  }
  const seen = await loadMeeting(tx, meetingId);
  // `roomOnly`: the page about the meeting itself (who was there, how long) is for everyone who can see the room; only the notes are kept back
  if (!seen) return null;
  if (options.roomOnly === true) return { meeting: seen, canRead: false };
  if (seen.notetaker_bot_id !== null) return null;
  const row = await ctx.db.system(async (sys) => (await sys.query('SELECT 1 FROM app.meeting_notes WHERE meeting_id = $1::uuid', [meetingId])).rows.length > 0, { workspaceId: tx.actor.workspaceId });
  return row ? null : { meeting: seen, canRead: false };
}

/** The people ids behind some actor ids (bots and removed people are left out). */
export async function personIdsOf(tx: PluginTx, actorIds: readonly string[]): Promise<string[]> {
  if (actorIds.length === 0) return [];
  const res = await tx.query<{ person_id: string }>(
    `SELECT a.ref_id::text AS person_id FROM app.actors a WHERE a.kind = 'person' AND a.id = ANY ($1::uuid[])`,
    [actorIds],
  );
  return res.rows.map((r) => r.person_id);
}

/**
 * "Ask again": one small push (ids only) to the people whose view of the meeting changed. The push is delivered when the transaction commits, so a rolled-back change is never
 * announced.
 */
export async function announceMeeting(ctx: PluginContext, tx: PluginTx, m: Pick<MeetingRow, 'id' | 'channel_id' | 'state'>, personIds: readonly string[]): Promise<void> {
  const people = [...new Set(personIds)];
  if (people.length === 0) return;
  await ctx.realtime.pushToPeople(tx, people, MEETING_CHANGED_PUSH, MeetingChangedPush.parse({ meetingId: m.id, channelId: m.channel_id, state: m.state }));
}

/**
 * One message written by a bot, in a transaction of its own. A bot posts where it may post (a bot conversation, a channel of its team); where it may not, or when messages are
 * not available, this answers null and the caller goes on without the message: a line that cannot be posted must never undo the work it reports.
 */
export async function postAsBot(
  ctx: PluginContext,
  input: {
    workspaceId: string;
    botActorId: string;
    channelId: string;
    threadRootId?: string | null;
    body: string;
    meta?: { meetingNotes?: { meetingId: string } };
    /** Set when the channel is a person's conversation with this bot: a bot reads and posts there only inside a run opened for that channel. */
    conversationOf?: { botId: string; teamId: string };
  },
): Promise<{ id: string } | null> {
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages) return null;
  const message = {
    channelId: input.channelId,
    body: input.body.slice(0, 3900),
    threadRootId: input.threadRootId ?? null,
    skipRefs: true,
    ...(input.meta === undefined ? {} : { meta: input.meta }),
  };
  try {
    if (input.conversationOf === undefined) {
      const posted = await ctx.db.as({ actorId: input.botActorId, kind: 'bot', workspaceId: input.workspaceId, personId: null, sessionId: null }, (tx) => messages.post(tx, message));
      return { id: posted.id };
    }
    // the run is the bot's authority in its conversation, and opening one is the runtime's door: the runtime posts the message
    const runtime = ctx.providers.get<MeetingRunsProvider>('meeting.runs');
    if (runtime?.say === undefined) return null;
    return await runtime.say({
      workspaceId: input.workspaceId,
      botId: input.conversationOf.botId,
      teamId: input.conversationOf.teamId,
      channelId: input.channelId,
      body: input.body,
      ...(input.meta === undefined ? {} : { meta: input.meta }),
    });
  } catch {
    return null;
  }
}

/** The bot's actor id (the author of what it posts), or null when it has none. */
export async function botActorOf(tx: PluginTx, botId: string): Promise<string | null> {
  return (await tx.query<{ id: string }>(`SELECT id::text AS id FROM app.actors WHERE kind = 'bot' AND ref_id = $1::uuid`, [botId])).rows[0]?.id ?? null;
}

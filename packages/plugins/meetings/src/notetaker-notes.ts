import type { JobInfo, MeetingRunsProvider, MessageProvider, PersonalFilesProvider, PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { MeetingsMeetingEndedEvent, MeetingsNotesWrittenEvent, MeetingsTranscriptWrittenEvent, type MeetingTranscriptLine } from '@manythreads/shared';
import { z } from 'zod';
import { stripHostileText } from './limits.ts';
import { loadTranscript } from './memory.ts';
import { NOTES_MAX_ROUNDS, NOTES_RETRY_SECONDS, actionOwnerIds, buildNoteItems, ownerDirectory, renderNotesMarkdown, transcriptForModel, type OwnerDirectory } from './notes.ts';
import { announceMeeting, personIdsOf, postAsBot } from './notes-access.ts';
import { loadMeeting, type MeetingRow } from './rows.ts';

// Work package S5 (P15-21, decision C13): the notes of a room that had a note-taker.
//
// The note-taker's transcript is in the organizer's Personal space (listener.ts), and so are its notes: when the room has ended and the transcript is complete, the note-taker's
// own run reads it and answers the notes as JSON; the platform checks every item and writes `notes.md` beside the transcript (the model never writes a file). Then:
//   * the organizer gets a message from the note-taker in their conversation with it, carrying `meta.meetingNotes` (the page draws the Share and Save-to-team buttons from it);
//   * the call's thread says "Notes are with <organizer>" (the notes are the organizer's to share, so the thread carries no summary);
//   * a failure is written down and the same message says the transcript is there.
//
// The `meetings.notes` job of notes.ts does the same for a room without a note-taker, for the team's Scribe, into the team's files. This one leaves `meeting_notes.location`
// alone: a note-taker that was removed before the room ended already made the row, and its location stays `personal`.

export const NOTETAKER_NOTES_QUEUE = 'meetings.notetaker.notes';

const Payload = z.object({ meetingId: z.uuid(), workspaceId: z.uuid(), round: z.number().int().min(0).max(NOTES_MAX_ROUNDS).default(0) });

const oneLine = (text: string, max: number): string => stripHostileText(text).slice(0, max);
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1);
const errText = (err: unknown): string => (err instanceof Error ? err.message.slice(0, 200) : 'unknown');

interface BotRow {
  id: string;
  name: string;
  team_id: string | null;
  actor_id: string | null;
  [key: string]: unknown;
}

interface Facts {
  meeting: MeetingRow;
  bot: BotRow;
  transcriptPath: string;
  organizerPersonId: string | null;
  organizerName: string;
  lines: MeetingTranscriptLine[];
  directory: OwnerDirectory;
}

/** The bot that sat in the room: the one still set, else the last one the events say was added (it was taken out before the room ended). */
async function botOf(tx: PluginTx, m: MeetingRow): Promise<BotRow | null> {
  let botId = m.notetaker_bot_id;
  if (botId === null) {
    botId =
      (
        await tx.query<{ bot_id: string }>(
          `SELECT payload->>'botId' AS bot_id FROM app.events WHERE type IN ('meetings.notetaker.added', 'meetings.notetaker.removed') AND payload->>'meetingId' = $1 ORDER BY id DESC LIMIT 1`,
          [m.id],
        )
      ).rows[0]?.bot_id ?? null;
  }
  if (botId === null) return null;
  return (
    (
      await tx.query<BotRow>(
        `SELECT b.id::text AS id, b.name, b.team_id::text AS team_id, (SELECT a.id::text FROM app.actors a WHERE a.kind = 'bot' AND a.ref_id = b.id) AS actor_id
           FROM app.bots b WHERE b.id = $1::uuid`,
        [botId],
      )
    ).rows[0] ?? null
  );
}

async function readFacts(tx: PluginTx, meetingId: string): Promise<Facts | 'skip'> {
  const m = await loadMeeting(tx, meetingId);
  if (!m || m.state !== 'ended') return 'skip';
  const note = (await tx.query<{ status: string; location: string; transcript_path: string | null }>('SELECT status, location, transcript_path FROM app.meeting_notes WHERE meeting_id = $1::uuid', [m.id])).rows[0];
  if (!note || note.location !== 'personal' || note.status === 'written' || note.transcript_path === null) return 'skip';
  // the transcript is complete only when the listener has said so (it says so once, after its last write)
  const complete = await tx.query("SELECT 1 FROM app.events WHERE type = 'meetings.transcript.written' AND payload->>'meetingId' = $1 LIMIT 1", [m.id]);
  if (complete.rows.length === 0) return 'skip';
  const bot = await botOf(tx, m);
  if (!bot) return 'skip';
  const { lines, people } = await loadTranscript(tx, m.id);
  const teamId = m.team_id ?? bot.team_id;
  const members =
    teamId === null
      ? []
      : (
          await tx.query<{ actor_id: string; display_name: string }>(
            `SELECT tm.actor_id, p.display_name FROM app.team_members tm
               JOIN app.actors a ON a.id = tm.actor_id AND a.kind = 'person' JOIN app.people p ON p.id = a.ref_id
              WHERE tm.team_id = $1::uuid`,
            [teamId],
          )
        ).rows.map((r) => ({ actorId: r.actor_id, displayName: r.display_name }));
  const organizer = (
    await tx.query<{ person_id: string; display_name: string }>(
      `SELECT p.id::text AS person_id, p.display_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id WHERE a.id = $1::uuid AND a.kind = 'person'`,
      [m.organizer_id],
    )
  ).rows[0];
  return {
    meeting: m,
    bot,
    transcriptPath: note.transcript_path,
    organizerPersonId: organizer?.person_id ?? null,
    organizerName: organizer?.display_name.replace(/[<>]/g, '').slice(0, 100) ?? 'the organizer',
    lines,
    directory: ownerDirectory(members, people),
  };
}

// ---- telling the organizer -----------------------------------------------------------------------------------------------------------------------------------------

/** The organizer's conversation with the bot, made on first use; null when they have none (a person off the bot's team cannot open one). */
async function conversationWith(ctx: PluginContext, facts: Facts): Promise<string | null> {
  const m = facts.meeting;
  if (facts.organizerPersonId === null) return null;
  return ctx.db
    .as({ actorId: m.organizer_id, kind: 'person', workspaceId: m.workspace_id, personId: facts.organizerPersonId, sessionId: null }, async (tx) => {
      const opened = (await tx.query<{ channel_id: string; created: boolean }>('SELECT channel_id, created FROM app.conversations_open($1::uuid)', [facts.bot.id])).rows[0];
      if (!opened) return null;
      if (opened.created) await ctx.audit.emit(tx, { type: 'channel.channel.created', channelId: opened.channel_id, teamId: null, name: '', kind: 'bot_conversation', private: true });
      return opened.channel_id;
    })
    .catch(() => null);
}

/**
 * The message to the organizer from the note-taker, and (when the notes were written) the line in the call's thread. Neither can fail the job: the notes are already saved.
 */
async function tell(ctx: PluginContext, job: JobInfo, facts: Facts, outcome: { kind: 'written' } | { kind: 'failed'; why: string }): Promise<void> {
  const m = facts.meeting;
  const title = oneLine(m.title, 120);
  const botActor = facts.bot.actor_id;
  if (botActor === null) return;
  const dm = await conversationWith(ctx, facts);
  const body =
    outcome.kind === 'written'
      ? `The notes of **${title.replace(/[*_`<>[\]]/g, '')}** are ready, in your Personal files next to the transcript. Only you can read them. You can share them with people or save them to the team.`
      : `The notes of **${title.replace(/[*_`<>[\]]/g, '')}** could not be written. ${outcome.why} The transcript is saved at \`${facts.transcriptPath}\` in your Personal files; you can open it from the meeting.`;
  if (dm !== null) {
    const posted = await postAsBot(ctx, { workspaceId: m.workspace_id, botActorId: botActor, channelId: dm, body, meta: { meetingNotes: { meetingId: m.id } }, ...(facts.bot.team_id === null ? {} : { conversationOf: { botId: facts.bot.id, teamId: facts.bot.team_id } }) });
    if (posted === null) job.log.warn(`meetings: the message about the notes of ${m.id} could not be posted`);
  } else {
    job.log.warn(`meetings: the organizer of ${m.id} has no conversation with the note-taker to tell`);
  }
  if (outcome.kind !== 'written' || m.channel_id === null) return;
  const line = `Notes are with ${facts.organizerName}.`;
  const viaBot = await postAsBot(ctx, { workspaceId: m.workspace_id, botActorId: botActor, channelId: m.channel_id, threadRootId: m.thread_root_id, body: line });
  if (viaBot !== null) return;
  // the bot may not post in a private channel it is not in: the organizer's own message says the same
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages || facts.organizerPersonId === null) return;
  await ctx
    .db.as({ actorId: m.organizer_id, kind: 'person', workspaceId: m.workspace_id, personId: facts.organizerPersonId, sessionId: null }, (tx) =>
      messages.post(tx, { channelId: m.channel_id!, body: line, threadRootId: m.thread_root_id, skipRefs: true }),
    )
    .catch((err: unknown) => job.log.warn(`meetings: the thread line for ${m.id} could not be posted: ${errText(err)}`));
}

/** Writes down that the notes could not be written, then tells the organizer. Never throws. */
async function recordFailure(ctx: PluginContext, job: JobInfo, facts: Facts, why: string): Promise<void> {
  await job
    .transaction(async (tx) => {
      await tx.query(`UPDATE app.meeting_notes SET status = 'failed', failure = $2, updated_at = now() WHERE meeting_id = $1::uuid AND status <> 'written'`, [facts.meeting.id, why.slice(0, 500)]);
      await announceMeeting(ctx, tx, facts.meeting, await personIdsOf(tx, [facts.meeting.organizer_id]));
    })
    .catch((err: unknown) => job.log.warn(`meetings: the failure of the notes of ${facts.meeting.id} could not be recorded: ${errText(err)}`));
  await tell(ctx, job, facts, { kind: 'failed', why }).catch(() => undefined);
}

// ---- the job ----------------------------------------------------------------------------------------------------------------------------------------------------------

/** The job's body, exported for the tests. Returns what happened: `written`, `failed`, `retry` (the budget said later) or `skipped` (nothing to do now). */
export async function writeNotetakerNotes(
  ctx: PluginContext,
  tx: PluginTx,
  job: JobInfo,
  payload: { meetingId: string; workspaceId: string; round: number },
): Promise<'written' | 'failed' | 'retry' | 'skipped'> {
  const facts = await job.transaction((inner) => readFacts(inner, payload.meetingId));
  if (facts === 'skip') return 'skipped';
  const m = facts.meeting;
  if (!facts.lines.some((l) => l.transcribed)) return 'skipped'; // nobody's words were kept: nothing to write notes from

  const runs = ctx.providers.get<MeetingRunsProvider>('meeting.runs');
  if (!runs) {
    await recordFailure(ctx, job, facts, 'Writing notes is not switched on in this workspace.');
    return 'failed';
  }
  if (facts.bot.team_id === null) {
    await recordFailure(ctx, job, facts, 'The note-taker belongs to no team, so it cannot write notes.');
    return 'failed';
  }
  const files = ctx.providers.get<PersonalFilesProvider>('personal.files');
  if (!files || facts.organizerPersonId === null) {
    await recordFailure(ctx, job, facts, 'The notes could not be saved to your Personal files.');
    return 'failed';
  }

  let result;
  try {
    result = await runs.notes(tx, {
      workspaceId: m.workspace_id,
      teamId: facts.bot.team_id,
      botId: facts.bot.id,
      meetingId: m.id,
      transcriptMd: transcriptForModel(m, facts.lines),
      transaction: job.transaction,
    });
  } catch (err) {
    job.log.warn(`meetings: the note-taker's run for ${m.id} threw: ${errText(err)}`);
    result = { outcome: 'failed' as const, message: 'The note-taker stopped before it finished.' };
  }
  if (result.outcome === 'budget') {
    if (payload.round >= NOTES_MAX_ROUNDS) {
      await recordFailure(ctx, job, facts, 'The note-taker\'s budget stayed used up.');
      return 'failed';
    }
    const runAt = new Date(ctx.runtime.now().getTime() + NOTES_RETRY_SECONDS * 1000);
    await job.transaction((inner) =>
      ctx.jobs.enqueue(inner, NOTETAKER_NOTES_QUEUE, { meetingId: m.id, workspaceId: m.workspace_id, round: payload.round + 1 }, { runAt, dedupeKey: `ntnotes:${m.id}:r${payload.round + 1}` }),
    );
    return 'retry';
  }
  if (result.outcome === 'failed') {
    await recordFailure(ctx, job, facts, result.message.slice(0, 300));
    return 'failed';
  }

  const items = buildNoteItems(result.draft, facts.lines, facts.directory);
  const summary = oneLine(result.draft.summary, 4000);
  const markdown = renderNotesMarkdown({ title: m.title, startedAt: m.started_at, meetingId: m.id, summary, items });
  const owners = actionOwnerIds(items);
  const notesPath = `${dirOf(facts.transcriptPath)}notes.md`;
  try {
    await job.transaction(async (inner) => {
      const written = await files.write(inner, facts.organizerPersonId!, notesPath, markdown, { mode: 'replace', ...(facts.bot.actor_id ? { authorActorId: facts.bot.actor_id } : {}) });
      await inner.query(
        `UPDATE app.meeting_notes SET status = 'written', failure = NULL, notes_path = $2, notes_md = $3, summary = $4, items = $5::jsonb,
                file_ids = CASE WHEN $6::uuid = ANY (file_ids) THEN file_ids ELSE array_append(file_ids, $6::uuid) END, updated_at = now()
          WHERE meeting_id = $1::uuid`,
        [m.id, notesPath, markdown, summary, JSON.stringify(items), written.file.fileId],
      );
      await ctx.audit.emit(
        inner,
        MeetingsNotesWrittenEvent.parse({
          type: 'meetings.notes.written',
          schemaVersion: 1,
          workspaceId: m.workspace_id,
          teamId: m.team_id,
          channelId: m.channel_id,
          meetingId: m.id,
          writtenBy: facts.bot.actor_id ?? m.organizer_id,
          path: notesPath,
          store: 'organizer_files',
          actionOwnerIds: owners,
          at: ctx.runtime.now().toISOString(),
        }),
      );
      await announceMeeting(ctx, inner, m, await personIdsOf(inner, [m.organizer_id]));
    });
  } catch (err) {
    job.log.warn(`meetings: the notes of ${m.id} could not be saved: ${errText(err)}`);
    await recordFailure(ctx, job, facts, 'The notes were written but could not be saved.');
    return 'failed';
  }
  await tell(ctx, job, facts, { kind: 'written' }).catch((err: unknown) => job.log.warn(`meetings: the organizer of ${m.id} could not be told: ${errText(err)}`));
  return 'written';
}

export function registerNotetakerNotes(ctx: PluginContext): void {
  ctx.jobs.register(
    NOTETAKER_NOTES_QUEUE,
    async (raw, tx, job) => {
      await writeNotetakerNotes(ctx, tx, job, Payload.parse(raw));
    },
    { detached: true, serialKey: 'meetingId', maxAttempts: 3, concurrency: 2 },
  );

  // The listener says the transcript is complete (once, after its last write), and the room says it ended. Whichever comes second finds both true and writes the notes; the job
  // checks, so asking twice (or too early) does nothing. A note-taker that was removed while the room was still going says it first.
  ctx.events.subscribe('meetings.transcript.written', async (raw: PluginEvent, tx) => {
    const event = MeetingsTranscriptWrittenEvent.parse(raw);
    if (event.store !== 'organizer_files') return;
    await ctx.jobs.enqueue(tx, NOTETAKER_NOTES_QUEUE, { meetingId: event.meetingId, workspaceId: event.workspaceId, round: 0 }, { dedupeKey: `ntnotes:${event.meetingId}:written` });
  });
  ctx.events.subscribe('meetings.meeting.ended', async (raw: PluginEvent, tx) => {
    const event = MeetingsMeetingEndedEvent.parse(raw);
    // only a room that has a Personal transcript row can have these notes; one query to find out, nothing queued for the rest
    const has = await tx.query("SELECT 1 FROM app.meeting_notes WHERE meeting_id = $1::uuid AND location = 'personal'", [event.meetingId]);
    if (has.rows.length === 0) return;
    await ctx.jobs.enqueue(tx, NOTETAKER_NOTES_QUEUE, { meetingId: event.meetingId, workspaceId: event.workspaceId, round: 0 }, { dedupeKey: `ntnotes:${event.meetingId}:ended` });
  });
}

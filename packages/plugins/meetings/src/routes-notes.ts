import { conflict, forbidden, invalid, json, notFound, route, type PersonalFilesProvider, type PluginContext, type PluginTx, type RepoProvider } from '@manythreads/sdk';
import {
  GetMeetingByPathQuery,
  GetMeetingByPathResponse,
  GetMeetingNotesResponse,
  GetMeetingOverviewResponse,
  MEETING_TRANSCRIPT_MAX_BYTES,
  MeetingNotes,
  MeetingNotetakerBot,
  MeetingOverview,
  MeetingPathParams,
  MeetingsNotesSavedEvent,
  PutMeetingNotesRequest,
  PutMeetingNotesResponse,
  REPO_MAX_FILE_BYTES,
  SaveMeetingToTeamRequest,
  SaveMeetingToTeamResponse,
  getMeetingByPathRoute,
  getMeetingNotesRoute,
  getMeetingOverviewRoute,
  meetingRepoDir,
  putMeetingNotesRoute,
  saveMeetingToTeamRoute,
  type MeetingNoteItem,
} from '@manythreads/shared';
import { fileMeetingIntoMemory, loadTranscript } from './memory.ts';
import { putNotesFile } from './notes.ts';
import { announceMeeting, callerPerson, notesAccess, personIdsOf, type NotesAccess } from './notes-access.ts';
import { toMeeting, type MeetingRow } from './rows.ts';
import { registerNotetakerNotes } from './notetaker-notes.ts';
import { renderTranscriptMarkdown, slugOf } from './writer.ts';

// Work package S5 (P15-20, P15-22, P15-23): reading and editing a meeting's notes, the meeting view's summary, the lookup from a file to its meeting, and "Save to team".
//
//  * Who reads: see notes-access.ts. A note-taker meeting's notes and transcript are in the organizer's Personal space; a person the organizer shared them with, or the readers of
//    the place after "Save to team", read them here, from the rows, after the database function has said yes.
//  * "Save to team" (C19) copies both files to the team's meeting folder (`meetings/yyyy/mm/dd-hhmm-slug/`), the organizer is the author of the commit, once per meeting, and then
//    (the box is ticked unless the organizer unticks it) drops the notes into the team's memory inbox. The Personal copy stays where it is; the meeting's `location` stays `personal`.

interface NoteRow {
  location: 'repo' | 'channel_files' | 'personal';
  transcript_path: string | null;
  notes_path: string | null;
  summary: string;
  notes_md: string;
  items: MeetingNoteItem[];
  status: 'pending' | 'written' | 'failed';
  failure: string | null;
  memory_item_id: string | null;
  saved_at: Date | null;
  saved_by: string | null;
  saved_path: string | null;
  updated_at: Date;
  [key: string]: unknown;
}

const NOTE_SQL = `SELECT location, transcript_path, notes_path, summary, notes_md, items, status, failure, memory_item_id::text AS memory_item_id, saved_at, saved_by::text AS saved_by,
                         saved_path, updated_at
                    FROM app.meeting_notes WHERE meeting_id = $1::uuid`;

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/') + 1);

/** Where a meeting's files would be written, for a room that has no notes row yet. */
async function expectedLocation(sys: PluginTx, m: MeetingRow): Promise<NoteRow['location']> {
  if (m.notetaker_bot_id !== null) return 'personal';
  const c = m.channel_id === null ? undefined : (await sys.query<{ kind: string; private: boolean }>('SELECT kind, private FROM app.channels WHERE id = $1::uuid', [m.channel_id])).rows[0];
  return c && c.kind === 'channel' && !c.private && m.team_id !== null ? 'repo' : 'channel_files';
}

/** The paths a reader is told: the organizer's own Personal paths are the organizer's alone; a reader of a saved meeting gets the team copy's paths. */
function pathsFor(n: NoteRow | undefined, isOrganizer: boolean): { transcriptPath: string | null; notesPath: string | null } {
  if (!n) return { transcriptPath: null, notesPath: null };
  if (n.location === 'personal' && !isOrganizer) {
    return n.saved_path ? { transcriptPath: `${dirOf(n.saved_path)}transcript.md`, notesPath: n.saved_path } : { transcriptPath: null, notesPath: null };
  }
  return { transcriptPath: n.transcript_path, notesPath: n.notes_path };
}

const wasInCall = async (sys: PluginTx, meetingId: string, actorId: string): Promise<boolean> =>
  (await sys.query('SELECT 1 FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = $2::uuid', [meetingId, actorId])).rows.length > 0;

/** The notes as this caller gets them. `sys` reads the rows; `tx` is the caller's own transaction, for the questions only their rights answer. */
async function buildNotes(tx: PluginTx, sys: PluginTx, access: NotesAccess): Promise<MeetingNotes> {
  const m = access.meeting;
  const who = tx.actor.id;
  const isOrganizer = m.organizer_id === who;
  const n = access.canRead ? (await sys.query<NoteRow>(NOTE_SQL, [m.id])).rows[0] : undefined;
  const location = n?.location ?? (await expectedLocation(sys, m));
  const ended = m.state === 'ended';
  const written = n?.status === 'written';
  const settled = written || n?.status === 'failed';
  const participant = access.canRead ? await wasInCall(sys, m.id, who) : false;
  const paths = pathsFor(n, isOrganizer);

  let canSendToMemory = false;
  if (written && ended && m.team_id !== null && location !== 'personal' && n?.memory_item_id == null && participant) {
    canSendToMemory = (await tx.query<{ ok: boolean | null }>("SELECT app.can('team', $1, 'post') AS ok", [m.team_id])).rows[0]?.ok === true;
  }
  return MeetingNotes.parse({
    meetingId: m.id,
    status: n?.status ?? 'pending',
    location,
    summary: n?.summary ?? '',
    items: n?.items ?? [],
    notesMd: n?.notes_md ?? '',
    transcriptPath: paths.transcriptPath,
    notesPath: paths.notesPath,
    failure: n?.failure ?? null,
    memoryItemId: n?.memory_item_id ?? null,
    savedPath: n?.saved_path ?? null,
    savedAt: n?.saved_at ? n.saved_at.toISOString() : null,
    savedBy: n?.saved_by ?? null,
    updatedAt: (n?.updated_at ?? m.ended_at ?? m.started_at).toISOString(),
    canEdit: ended && settled && (isOrganizer || (location !== 'personal' && participant)),
    canShare: isOrganizer && ended && location === 'personal',
    canSaveToTeam: isOrganizer && ended && location === 'personal' && written && n?.saved_at == null,
    canSendToMemory,
  });
}

const sys = <T>(ctx: PluginContext, tx: PluginTx, fn: (inner: PluginTx) => Promise<T>): Promise<T> => ctx.db.system(fn, { workspaceId: tx.actor.workspaceId });

// ---- the summary at the top of the meeting page ----------------------------------------------------------------------------------------------------------

async function buildOverview(tx: PluginTx, inner: PluginTx, access: NotesAccess): Promise<MeetingOverview> {
  const m = access.meeting;
  const who = tx.actor.id;
  const isOrganizer = m.organizer_id === who;
  const n = access.canRead ? (await inner.query<NoteRow>(NOTE_SQL, [m.id])).rows[0] : undefined;
  const team = m.team_id === null ? undefined : (await inner.query<{ slug: string }>('SELECT slug FROM app.teams WHERE id = $1::uuid', [m.team_id])).rows[0];
  const channel = m.channel_id === null ? undefined : (await inner.query<{ name: string; kind: string }>('SELECT name, kind FROM app.channels WHERE id = $1::uuid', [m.channel_id])).rows[0];
  const organizer = (
    await inner.query<{ display_name: string }>(`SELECT p.display_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id WHERE a.id = $1::uuid AND a.kind = 'person'`, [m.organizer_id])
  ).rows[0];
  const people = (
    await inner.query<{ actor_id: string; display_name: string; consent_transcribe: string }>(
      'SELECT actor_id, display_name, consent_transcribe FROM app.meeting_participants WHERE meeting_id = $1::uuid ORDER BY joined_at, actor_id',
      [m.id],
    )
  ).rows;
  const audio = (await inner.query('SELECT 1 FROM app.meeting_recordings WHERE meeting_id = $1::uuid AND file_id IS NOT NULL LIMIT 1', [m.id])).rows.length > 0;
  const bot = m.notetaker_bot_id === null ? undefined : (await inner.query<{ id: string; slug: string; name: string; role: string; avatar: string | null }>('SELECT id, slug, name, role, avatar FROM app.bots WHERE id = $1::uuid', [m.notetaker_bot_id])).rows[0];
  const items = access.canRead ? (n?.items ?? []) : [];
  const paths = pathsFor(n, isOrganizer);
  return MeetingOverview.parse({
    meeting: toMeeting(m),
    teamSlug: team?.slug ?? null,
    channelName: channel?.kind === 'channel' ? channel.name : null,
    durationSeconds: m.ended_at ? Math.max(0, Math.round((m.ended_at.getTime() - m.started_at.getTime()) / 1000)) : null,
    organizerName: organizer?.display_name ?? 'Someone',
    people: people.map((p) => ({ actorId: p.actor_id, displayName: p.display_name, transcribed: p.consent_transcribe === 'yes' })),
    location: n?.location ?? null,
    transcriptPath: paths.transcriptPath,
    notesPath: paths.notesPath,
    notesStatus: n?.status ?? null,
    thread: m.channel_id !== null && m.thread_root_id !== null ? { channelId: m.channel_id, rootId: m.thread_root_id } : null,
    hasAudio: access.canRead && audio,
    notetaker: bot ? MeetingNotetakerBot.parse({ botId: bot.id, slug: bot.slug, name: bot.name, role: bot.role, avatar: bot.avatar }) : null,
    decisionCount: items.filter((i) => i.kind === 'decision').length,
    actionItemCount: items.filter((i) => i.kind === 'action').length,
    you: { isOrganizer, canManage: isOrganizer, canReadNotes: access.canRead },
  });
}

// ---- a Files path or a repo path to its meeting -----------------------------------------------------------------------------------------------------------

/** The folder part of a path: the first `parts` pieces, and the rest (a file inside it) dropped. Null when the path is not that deep or climbs out of its place. */
function folderOf(path: string, parts: number): string | null {
  const pieces = path.split('/').filter((p) => p !== '');
  if (pieces.length < parts || pieces.some((p) => p === '.' || p === '..')) return null;
  return `${pieces.slice(0, parts).join('/')}/`;
}

/**
 * Which meeting a path belongs to, for the Files screen's "Open the meeting". The shapes are the three places a meeting's files live: the team repo (`meetings/yyyy/mm/folder`),
 * a channel's Files folder (`channels/<name>/meetings/folder`, `dms/<id>/meetings/folder`) and the organizer's Personal space (`Meetings/folder`), each as the folder or a file
 * inside it. The team's slug says which team's space the first two are in; a Personal path has none. Null when no meeting has its files there.
 */
export async function meetingAtPath(tx: PluginTx, inner: PluginTx, query: GetMeetingByPathQuery): Promise<string | null> {
  const first = query.path.split('/').filter((p) => p !== '')[0];
  if (first === undefined) return null;
  if (first === 'Meetings') {
    const folder = folderOf(query.path, 2);
    if (folder === null) return null;
    const row = (
      await inner.query<{ meeting_id: string }>(`SELECT meeting_id::text FROM app.meeting_notes WHERE organizer_id = $1::uuid AND location = 'personal' AND starts_with(coalesce(transcript_path, ''), $2) LIMIT 1`, [tx.actor.id, folder])
    ).rows[0];
    return row?.meeting_id ?? null;
  }
  if (query.team === undefined) return null;
  const team = (await inner.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1 AND workspace_id = $2::uuid', [query.team, tx.actor.workspaceId])).rows[0];
  if (!team) return null;
  const folder = first === 'meetings' ? folderOf(query.path, 4) : first === 'channels' || first === 'dms' ? folderOf(query.path, 4) : null;
  if (folder === null) return null;
  if (first === 'channels' && folder.split('/')[2] !== 'meetings') return null;
  if (first === 'dms' && folder.split('/')[2] !== 'meetings') return null;
  const row = (
    await inner.query<{ meeting_id: string }>(
      `SELECT meeting_id::text FROM app.meeting_notes
        WHERE team_id = $1::uuid AND (starts_with(coalesce(transcript_path, ''), $2) OR starts_with(coalesce(saved_path, ''), $2))
        ORDER BY created_at LIMIT 1`,
      [team.id, folder],
    )
  ).rows[0];
  return row?.meeting_id ?? null;
}

// ---- writing the notes file again --------------------------------------------------------------------------------------------------------------------------

/** Puts the edited text where the meeting's notes file is. Returns the path and, for Files, the file's id. */
async function writeNotesFile(ctx: PluginContext, inner: PluginTx, m: MeetingRow, n: NoteRow, markdown: string, editor: { actorId: string; name: string }): Promise<{ path: string; fileId: string | null }> {
  if (n.transcript_path === null) throw conflict('There are no files for this meeting yet.');
  if (n.location === 'personal') {
    const files = ctx.providers.get<PersonalFilesProvider>('personal.files');
    if (!files) throw conflict('Personal files are not available.');
    const person = (await inner.query<{ ref_id: string }>(`SELECT ref_id::text FROM app.actors WHERE id = $1::uuid AND kind = 'person'`, [m.organizer_id])).rows[0];
    if (!person) throw conflict('The person who started the call is no longer here.');
    const path = n.notes_path ?? `${dirOf(n.transcript_path)}notes.md`;
    const written = await files.write(inner, person.ref_id, path, markdown, { mode: 'replace', authorActorId: editor.actorId });
    return { path, fileId: written.file.fileId };
  }
  if (n.location === 'repo') {
    const repo = ctx.providers.get<RepoProvider>('repo');
    if (!repo || m.team_id === null) throw conflict('The team’s files are not available.');
    const path = n.notes_path ?? `${dirOf(n.transcript_path)}notes.md`;
    await repo.write(inner, m.team_id, { id: inner.actor.id, kind: 'system' }, [{ path, op: 'put', content: markdown }], `Meeting notes edited: ${m.title.slice(0, 120)}`, [{ actorId: editor.actorId, name: editor.name }]);
    return { path, fileId: null };
  }
  return putNotesFile(ctx, inner, m, 'channel_files', n.transcript_path, markdown);
}

const displayNameOf = async (inner: PluginTx, actorId: string): Promise<string> =>
  (await inner.query<{ display_name: string }>(`SELECT p.display_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id WHERE a.id = $1::uuid AND a.kind = 'person'`, [actorId])).rows[0]?.display_name.replace(/[<>]/g, '').slice(0, 100) || 'Someone';

/** The first of `base`, `base-2`, ... that no other meeting's files already use in this team's repo. */
async function freeRepoDir(inner: PluginTx, m: MeetingRow, teamId: string): Promise<string> {
  const base = meetingRepoDir(m.started_at, slugOf(m.title));
  for (let n = 1; n <= 50; n += 1) {
    const dir = n === 1 ? base : `${base}-${n}`;
    const taken = await inner.query(
      `SELECT 1 FROM app.meeting_notes
        WHERE meeting_id <> $1::uuid AND team_id = $2::uuid AND (transcript_path = $3 OR saved_path = $4) LIMIT 1`,
      [m.id, teamId, `${dir}/transcript.md`, `${dir}/notes.md`],
    );
    if (taken.rows.length === 0) return dir;
  }
  return `${base}-${m.id.slice(0, 8)}`;
}

export function registerNotesRoutes(ctx: PluginContext): void {
  // the note-taker's own end-of-room job lives with the notes (notetaker-notes.ts)
  registerNotetakerNotes(ctx);

  ctx.http.route({
    ...getMeetingOverviewRoute,
    schema: { response: GetMeetingOverviewResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      await callerPerson(tx);
      const access = await notesAccess(ctx, tx, meetingId, { roomOnly: true });
      if (!access) throw notFound('That meeting is not available');
      return json(GetMeetingOverviewResponse.parse(await sys(ctx, tx, (inner) => buildOverview(tx, inner, access))));
    }),
  });

  ctx.http.route({
    ...getMeetingByPathRoute,
    schema: { query: GetMeetingByPathQuery, response: GetMeetingByPathResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const query = GetMeetingByPathQuery.parse(req.query);
      await callerPerson(tx);
      const found = await sys(ctx, tx, (inner) => meetingAtPath(tx, inner, query));
      // a path that is not a meeting's, and a meeting the caller may not read, answer the same
      if (found === null) throw notFound('No meeting has its files there');
      const can = (await tx.query<{ ok: boolean | null }>('SELECT app.meetings_can_read_notes($1::uuid) AS ok', [found])).rows[0]?.ok === true;
      if (!can) throw notFound('No meeting has its files there');
      return json(GetMeetingByPathResponse.parse({ meetingId: found }));
    }),
  });

  ctx.http.route({
    ...getMeetingNotesRoute,
    schema: { response: GetMeetingNotesResponse },
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      await callerPerson(tx);
      const access = await notesAccess(ctx, tx, meetingId);
      if (!access) throw notFound('That meeting is not available');
      return json(GetMeetingNotesResponse.parse(await sys(ctx, tx, (inner) => buildNotes(tx, inner, access))));
    }),
  });

  ctx.http.route({
    ...putMeetingNotesRoute,
    schema: { body: PutMeetingNotesRequest, response: PutMeetingNotesResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const body = PutMeetingNotesRequest.parse(req.body);
      const who = await callerPerson(tx);
      const access = await notesAccess(ctx, tx, meetingId);
      if (!access) throw notFound('That meeting is not available');
      const before = await sys(ctx, tx, (inner) => buildNotes(tx, inner, access));
      if (!before.canEdit) {
        if (before.status === 'pending' || !access.canRead) throw conflict('The notes are not written yet.');
        throw forbidden('You cannot edit these notes.');
      }
      const markdown = body.notesMd.replaceAll(String.fromCharCode(0), '');
      if (markdown.trim() === '') throw invalid('The notes cannot be empty.');
      const m = access.meeting;
      const base = body.baseUpdatedAt;
      const edited = await sys(ctx, tx, async (inner) => {
        const n = (await inner.query<NoteRow>(`${NOTE_SQL} FOR UPDATE`, [m.id])).rows[0];
        if (!n) throw conflict('The notes are not written yet.');
        if (base !== undefined && n.updated_at.getTime() !== new Date(base).getTime()) {
          throw conflict('Someone changed the notes since you opened them. Reload to see their version.');
        }
        const editor = { actorId: who.actorId, name: await displayNameOf(inner, who.actorId) };
        const written = await writeNotesFile(ctx, inner, m, n, markdown, editor);
        await inner.query(
          `UPDATE app.meeting_notes SET status = 'written', failure = NULL, notes_path = $2, notes_md = $3,
                  file_ids = CASE WHEN $4::uuid IS NULL OR $4::uuid = ANY (file_ids) THEN file_ids ELSE array_append(file_ids, $4::uuid) END, updated_at = now()
            WHERE meeting_id = $1::uuid`,
          [m.id, written.path, markdown, written.fileId],
        );
        // the team's copy, once there is one, follows the edit (the Personal copy was the first to change)
        if (n.saved_path !== null && m.team_id !== null) {
          const repo = ctx.providers.get<RepoProvider>('repo');
          if (repo) await repo.write(inner, m.team_id, { id: inner.actor.id, kind: 'system' }, [{ path: n.saved_path, op: 'put', content: markdown }], `Meeting notes edited: ${m.title.slice(0, 120)}`, [{ actorId: editor.actorId, name: editor.name }]);
        }
        await announceMeeting(ctx, inner, m, await personIdsOf(inner, [m.organizer_id, who.actorId]));
        return buildNotes(tx, inner, access);
      });
      return json(PutMeetingNotesResponse.parse(edited));
    }),
  });

  ctx.http.route({
    ...saveMeetingToTeamRoute,
    schema: { body: SaveMeetingToTeamRequest, response: SaveMeetingToTeamResponse },
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const body = SaveMeetingToTeamRequest.parse(req.body);
      const who = await callerPerson(tx);
      const access = await notesAccess(ctx, tx, meetingId);
      if (!access || !access.canRead) throw notFound('That meeting is not available');
      const m = access.meeting;
      if (m.organizer_id !== who.actorId) throw forbidden('Only the person who started the call saves its notes to the team.');
      if (m.state !== 'ended') throw conflict('The call is still going. Save its notes once it has ended.');

      // the team: the call's own, or (a direct-message call has none) the one the organizer chose, and the organizer must be able to put things there
      const team = (
        await tx.query<{ id: string; slug: string; archived_at: Date | null; ok: boolean | null }>(
          body.teamSlug !== undefined
            ? `SELECT t.id::text AS id, t.slug, t.archived_at, app.can('team', t.id, 'post') AS ok FROM app.teams t WHERE t.slug = $1`
            : `SELECT t.id::text AS id, t.slug, t.archived_at, app.can('team', t.id, 'post') AS ok FROM app.teams t WHERE t.id = $1::uuid`,
          [body.teamSlug ?? m.team_id],
        )
      ).rows[0];
      if (!team) {
        if (body.teamSlug === undefined && m.team_id === null) throw invalid('Choose the team to save the notes to.');
        throw notFound('That team is not available');
      }
      if (m.team_id !== null && team.id !== m.team_id) throw conflict('The notes of a team’s call are saved to that team.');
      if (team.ok !== true) throw forbidden('Only people on this team can save notes to it.');
      if (team.archived_at !== null) throw conflict('This team is archived.');
      const repo = ctx.providers.get<RepoProvider>('repo');
      if (!repo) throw conflict('The team’s files are not available.');

      const done = await sys(ctx, tx, async (inner) => {
        const n = (await inner.query<NoteRow>(`${NOTE_SQL} FOR UPDATE`, [m.id])).rows[0];
        if (!n || n.location !== 'personal') throw conflict('Only a call with a note-taker is saved this way; the files of this call are already where the team can read them.');
        if (n.saved_at !== null) throw conflict('These notes were already saved to the team.');
        if (n.status !== 'written') throw conflict('The notes are not written yet, so there is nothing to save.');

        const { lines, people } = await loadTranscript(inner, m.id);
        const channel = m.channel_id === null ? undefined : (await inner.query<{ name: string; kind: string }>('SELECT name, kind FROM app.channels WHERE id = $1::uuid', [m.channel_id])).rows[0];
        const rendered = renderTranscriptMarkdown(
          {
            title: m.title,
            startedAt: m.started_at,
            endedAt: m.ended_at ?? m.started_at,
            channelLabel: channel ? (channel.kind === 'channel' ? `#${channel.name}` : 'direct message') : '',
            participants: people.map((p) => p.displayName),
            language: null,
            source: 'server',
          },
          lines,
          Math.min(MEETING_TRANSCRIPT_MAX_BYTES, REPO_MAX_FILE_BYTES - 4096),
        );
        const dir = await freeRepoDir(inner, m, team.id);
        const transcriptPath = `${dir}/transcript.md`;
        const notesPath = `${dir}/notes.md`;
        const organizerName = await displayNameOf(inner, who.actorId);
        await repo.write(
          inner,
          team.id,
          { id: inner.actor.id, kind: 'system' },
          [
            { path: transcriptPath, op: 'put', content: rendered.markdown },
            { path: notesPath, op: 'put', content: n.notes_md },
          ],
          `Meeting notes saved to the team: ${m.title.replace(/[\r\n]+/g, ' ').slice(0, 120)}`,
          [{ actorId: who.actorId, name: organizerName }],
        );
        await inner.query('UPDATE app.meeting_notes SET saved_at = now(), saved_by = $2::uuid, saved_path = $3, updated_at = now() WHERE meeting_id = $1::uuid', [m.id, who.actorId, notesPath]);

        let memoryItemId: string | null = null;
        if (body.addToMemory) {
          // a failure to file must not undo the save: the person can still press "Send to memory" on the team copy
          try {
            await inner.query('SAVEPOINT meeting_save_memory');
            const filed = await fileMeetingIntoMemory(ctx, inner, m.id, { automatic: false, sentBy: who.actorId, teamCopy: { teamId: team.id, transcriptPath, notesPath } });
            memoryItemId = filed?.itemId ?? null;
            await inner.query('RELEASE SAVEPOINT meeting_save_memory');
          } catch {
            await inner.query('ROLLBACK TO SAVEPOINT meeting_save_memory').catch(() => undefined);
          }
        }
        await ctx.audit.emit(
          inner,
          MeetingsNotesSavedEvent.parse({
            type: 'meetings.notes.saved',
            schemaVersion: 1,
            workspaceId: m.workspace_id,
            teamId: team.id,
            channelId: m.channel_id,
            meetingId: m.id,
            savedBy: who.actorId,
            path: notesPath,
            toMemory: memoryItemId !== null,
            at: ctx.runtime.now().toISOString(),
          }),
        );
        // everyone who may now read the notes (the place the call was held in) looks again
        const audience = m.channel_id === null ? [] : (await inner.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [m.channel_id])).rows.map((r) => r.person_id);
        await announceMeeting(ctx, inner, m, [...audience, who.personId]);
        return { notes: await buildNotes(tx, inner, access), path: notesPath, memoryItemId };
      });
      return json(SaveMeetingToTeamResponse.parse(done));
    }),
  });
}

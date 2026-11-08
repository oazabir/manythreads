import type { LlmTranscriber, MediaListenChunk, MediaListener, PersonalFilesProvider, PluginContext, PluginLogger, PluginTx } from '@manythreads/sdk';
import { MEETING_NOTETAKER_MAX_ROOMS_DEFAULT, MeetingsNotetakerRemovedEvent, MeetingsTranscriptWrittenEvent } from '@manythreads/shared';
import { z } from 'zod';
import { stripHostileText } from './limits.ts';
import { requireMedia } from './media.ts';
import { takeSegments } from './segments.ts';
import { clock, slugOf } from './writer.ts';

// Work package S4 (P15-18, P15-19, P15-20; PLAN decisions C13, C14, C17): the note-taker's listener in the room.
//
// What it does, start to end:
//  * `startListener` joins the room through `MediaProvider.listen` (the provider mints the hidden, subscribe-only token itself; nothing here and nothing in a bot's run can
//    ask for one that publishes) with the people who are present and said yes to "Transcribe my voice".
//  * Every two seconds `reconcile` compares that list with the database and tells the listener when it changed: a consent given or withdrawn, a person who joined, left or was
//    kicked. A person who is not on the list loses their track at once, so a withdrawn yes or a kick reaches the listener well inside five seconds. (A timer and not an event
//    subscription: those changes are written by other modules and arrive here only as rows.)
//  * Each chunk of speech (cut at pauses by the listener, `audio/vad.ts`) is checked once more against the database, sent to the `transcribe` door of the `llm` provider, and
//    stored as a `server` line of the speaker by `takeSegments` (the same rules as every other line: words only for a yes, repeats dropped, a caption pushed).
//  * Every thirty seconds the new lines are appended to the transcript in the organizer's Personal space (`personal.files`, written by the system with the bot as author).
//  * When the room ends or the note-taker is removed it hears what is left, writes the last of the transcript, says `meetings.transcript.written` and leaves.
//
// Rooms are kept in this server process; at most `MANYTHREADS_NOTETAKER_MAX_ROOMS` (10). A cron job starts a listener for a room that has a note-taker and none here (after a
// restart or a lost connection). One server process is assumed: with two, both would join, and the repeat check in `takeSegments` would drop the second copy of a line.

export const LISTENER_START_QUEUE = 'meetings.listener.start';
export const LISTENER_SWEEP_QUEUE = 'meetings.listener.sweep';

const StartPayload = z.object({ meetingId: z.uuid(), workspaceId: z.uuid() });

const RECONCILE_MS = 2_000;
const PERSONAL_FLUSH_MS = 30_000;
/** How long a stopping room waits for the chunks it already holds to be transcribed. */
const DRAIN_MS = 90_000;
/** Audio waiting for the transcriber beyond this is dropped, oldest first (the memory a room may hold; about three minutes of speech). */
const QUEUE_MAX_BYTES = 32 * 1024 * 1024;
/** Audio waiting longer than this makes the captions say "catching up". */
const CATCHING_UP_MS = 60_000;
/** The file in the Personal space holds at most this much text; the platform's limit is 200 000 bytes. */
const PERSONAL_SAFE_BYTES = 190_000;
const INT_MAX = 2_147_483_647;

/** Rooms one server process listens to at once. */
export function maxRooms(): number {
  const raw = Number.parseInt(process.env['MANYTHREADS_NOTETAKER_MAX_ROOMS'] ?? '', 10);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 100) : MEETING_NOTETAKER_MAX_ROOMS_DEFAULT;
}

// Test hook, on globalThis because the server loads this file by its own path and a test may import it by another (two module instances). Honoured only outside production.
//   transcriber  stands in for the `llm` provider's door;  reconcileMs / flushMs  make the two timers short.
const HOOK = Symbol.for('manythreads.meetings.listener.hook');
interface ListenerHook {
  transcriber?: LlmTranscriber;
  reconcileMs?: number;
  flushMs?: number;
}
function hook(): ListenerHook {
  if (process.env['NODE_ENV'] === 'production') return {};
  return (globalThis as unknown as Record<symbol, ListenerHook | undefined>)[HOOK] ?? {};
}

interface TranscriptLine {
  startMs: number;
  speaker: string;
  text: string;
}

interface Queued {
  chunk: MediaListenChunk;
  bytes: number;
}

interface Room {
  id: string;
  workspaceId: string;
  teamId: string | null;
  channelLabel: string;
  botId: string;
  botActorId: string | null;
  botName: string;
  organizerActorId: string;
  organizerPersonId: string | null;
  title: string;
  startedAt: Date;
  log: PluginLogger;
  listener: MediaListener | null;
  /** The people the listener was last told to hear. */
  identities: string[];
  /** True once `stopRoom` began: no new work is started, the held chunks are finished. */
  stopping: boolean;
  stopped: Promise<void> | null;
  queue: Queued[];
  queuedMs: number;
  queuedBytes: number;
  working: boolean;
  waiters: Array<() => void>;
  lines: TranscriptLine[];
  path: string | null;
  full: boolean;
  chain: Promise<void>;
  reconcileTimer: ReturnType<typeof setInterval> | null;
  flushTimer: ReturnType<typeof setInterval> | null;
  reconciling: boolean;
  lastProblemAt: number;
}

interface State {
  rooms: Map<string, Room>;
  starting: Set<string>;
}
const states = new WeakMap<PluginContext, State>();
function stateOf(ctx: PluginContext): State {
  let s = states.get(ctx);
  if (!s) {
    s = { rooms: new Map(), starting: new Set() };
    states.set(ctx, s);
  }
  return s;
}

/** True while this server process has a working listener in the room. */
export function isListening(ctx: PluginContext, meetingId: string): boolean {
  const room = stateOf(ctx).rooms.get(meetingId);
  return room !== undefined && room.listener !== null && !room.stopping;
}

// ---- what the database says about the room ------------------------------------------------------------------------------------------

interface FactsRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string | null;
  title: string;
  state: 'live' | 'ended';
  started_at: Date;
  organizer_id: string;
  notetaker_bot_id: string | null;
  bot_name: string | null;
  bot_actor_id: string | null;
  organizer_person_id: string | null;
  channel_kind: string | null;
  channel_name: string | null;
  yes: string[];
  path: string | null;
}

async function loadFacts(tx: PluginTx, meetingId: string): Promise<FactsRow | undefined> {
  return (
    await tx.query<FactsRow>(
      `SELECT m.id, m.workspace_id, m.team_id, m.title, m.state, m.started_at, m.organizer_id, m.notetaker_bot_id,
              b.name AS bot_name,
              (SELECT a.id FROM app.actors a WHERE a.kind = 'bot' AND a.ref_id = m.notetaker_bot_id AND a.workspace_id = m.workspace_id) AS bot_actor_id,
              (SELECT p.person_id FROM app.meeting_participants p WHERE p.meeting_id = m.id AND p.actor_id = m.organizer_id) AS organizer_person_id,
              c.kind AS channel_kind, c.name AS channel_name,
              coalesce((SELECT array_agg(p.actor_id::text ORDER BY p.actor_id) FROM app.meeting_participants p
                         WHERE p.meeting_id = m.id AND p.left_at IS NULL AND p.consent_transcribe = 'yes'), '{}'::text[]) AS yes,
              (SELECT n.transcript_path FROM app.meeting_notes n WHERE n.meeting_id = m.id AND n.location = 'personal') AS path
         FROM app.meetings m
         LEFT JOIN app.bots b ON b.id = m.notetaker_bot_id
         LEFT JOIN app.channels c ON c.id = m.channel_id
        WHERE m.id = $1::uuid`,
      [meetingId],
    )
  ).rows[0];
}

// ---- starting -----------------------------------------------------------------------------------------------------------------------

/**
 * Joins the room of `meetingId` as its note-taker's listener. Does nothing when this process already has it, or when the room is not live or has no note-taker. Throws when the
 * server is full, the media server is not set up or the join fails (the job retries, then the cron job tries again every minute).
 */
export async function startListener(ctx: PluginContext, meetingId: string, workspaceId: string, log: PluginLogger): Promise<'started' | 'already' | 'gone'> {
  const st = stateOf(ctx);
  if (st.rooms.has(meetingId) || st.starting.has(meetingId)) return 'already';
  if (st.rooms.size + st.starting.size >= maxRooms()) throw new Error('The note-taker is busy.');
  st.starting.add(meetingId);
  try {
    const facts = await ctx.db.system((tx) => loadFacts(tx, meetingId), { workspaceId });
    if (!facts || facts.state !== 'live' || !facts.notetaker_bot_id) return 'gone';
    const media = requireMedia(ctx);
    if (typeof media.listen !== 'function') throw new Error('This media server cannot host a note-taker.');
    const room: Room = {
      id: facts.id,
      workspaceId: facts.workspace_id,
      teamId: facts.team_id,
      channelLabel: facts.channel_kind === 'channel' && facts.channel_name ? `#${facts.channel_name}` : 'direct message',
      botId: facts.notetaker_bot_id,
      botActorId: facts.bot_actor_id,
      botName: facts.bot_name ?? 'Note-taker',
      organizerActorId: facts.organizer_id,
      organizerPersonId: facts.organizer_person_id,
      title: facts.title,
      startedAt: facts.started_at,
      log,
      listener: null,
      identities: [...facts.yes],
      stopping: false,
      stopped: null,
      queue: [],
      queuedMs: 0,
      queuedBytes: 0,
      working: false,
      waiters: [],
      lines: [],
      path: facts.path,
      full: false,
      chain: Promise.resolve(),
      reconcileTimer: null,
      flushTimer: null,
      reconciling: false,
      lastProblemAt: 0,
    };
    // Not an actor id: the media server's notices about an unknown UUID make the plugin drop that "person" from the room (webhook.ts).
    room.listener = await media.listen(meetingId, {
      identities: room.identities,
      listener: { identity: `notetaker:${meetingId}`, displayName: room.botName },
      onChunk: (chunk) => enqueue(ctx, room, chunk),
      onClosed: (reason) => void closedByProvider(ctx, room, reason),
    });
    st.rooms.set(meetingId, room);
    const timing = hook();
    room.reconcileTimer = setInterval(() => void reconcile(ctx, room), timing.reconcileMs ?? RECONCILE_MS);
    room.reconcileTimer.unref?.();
    room.flushTimer = setInterval(() => void flushPersonal(ctx, room, false), timing.flushMs ?? PERSONAL_FLUSH_MS);
    room.flushTimer.unref?.();
    log.info('meetings: the note-taker joined a voice room');
    return 'started';
  } finally {
    st.starting.delete(meetingId);
  }
}

// ---- keeping the list of people to hear current ---------------------------------------------------------------------------------------

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

async function reconcile(ctx: PluginContext, room: Room): Promise<void> {
  if (room.stopping || room.reconciling || !room.listener) return;
  room.reconciling = true;
  try {
    const facts = await ctx.db.system((tx) => loadFacts(tx, room.id), { workspaceId: room.workspaceId });
    if (room.stopping) return;
    if (!facts || facts.state !== 'live') {
      void stopRoom(ctx, room, 'ended');
      return;
    }
    if (facts.notetaker_bot_id !== room.botId) {
      void stopRoom(ctx, room, 'removed');
      return;
    }
    const want = [...facts.yes].sort();
    if (!sameList(want, room.identities)) {
      room.identities = want;
      room.listener.setIdentities(want);
    }
  } catch {
    // the next tick tries again; a listener that cannot reach the database keeps hearing the people it had
  } finally {
    room.reconciling = false;
  }
}

// ---- chunks: check, transcribe, store -----------------------------------------------------------------------------------------------------

function enqueue(ctx: PluginContext, room: Room, chunk: MediaListenChunk): void {
  // only a person the listener was told to hear (a chunk of anyone else is dropped unheard, though the listener should never send one)
  if (!room.identities.includes(chunk.identity)) return;
  room.queue.push({ chunk, bytes: chunk.wav.byteLength });
  room.queuedMs += chunk.durationMs;
  room.queuedBytes += chunk.wav.byteLength;
  while (room.queuedBytes > QUEUE_MAX_BYTES && room.queue.length > 1) {
    const dropped = room.queue.shift()!;
    room.queuedMs -= dropped.chunk.durationMs;
    room.queuedBytes -= dropped.bytes;
    room.log.warn('meetings: the note-taker is far behind; the oldest stretch of speech was dropped');
  }
  if (!room.working) void pump(ctx, room);
}

async function pump(ctx: PluginContext, room: Room): Promise<void> {
  room.working = true;
  try {
    for (let item = room.queue.shift(); item; item = room.queue.shift()) {
      const behindMs = room.queuedMs + item.chunk.backlogMs;
      room.queuedMs -= item.chunk.durationMs;
      room.queuedBytes -= item.bytes;
      try {
        await handleChunk(ctx, room, item.chunk, behindMs > CATCHING_UP_MS);
      } catch {
        room.log.warn('meetings: a stretch of speech could not be written down');
      }
    }
  } finally {
    room.working = false;
    const waiting = room.waiters.splice(0);
    for (const w of waiting) w();
  }
}

interface Speaker {
  name: string;
  ok: boolean;
}

/**
 * Whether a person's words may be written down now: they said yes, and they are in the room, or left it after the stretch began (their last sentence arrives just after they
 * go) without having been kicked. Somebody removed from the channel has no more lines.
 */
async function speakerOf(tx: PluginTx, room: Room, chunk: MediaListenChunk): Promise<Speaker> {
  const row = (
    await tx.query<{ display_name: string; consent_transcribe: string; left_at: Date | null; kicked: boolean }>(
      `SELECT p.display_name, p.consent_transcribe, p.left_at,
              (p.left_at IS NOT NULL AND EXISTS (SELECT 1 FROM app.events e WHERE e.type = 'meetings.participant.left'
                  AND e.payload->>'meetingId' = $1 AND e.payload->>'actorId' = $2 AND e.payload->>'how' = 'kicked')) AS kicked
         FROM app.meeting_participants p WHERE p.meeting_id = $1::uuid AND p.actor_id = $2::uuid`,
      [room.id, chunk.identity],
    )
  ).rows[0];
  if (!row) return { name: '', ok: false };
  const present = row.left_at === null || (!row.kicked && row.left_at.getTime() >= chunk.startedAt.getTime() - 1000);
  return { name: row.display_name, ok: row.consent_transcribe === 'yes' && present };
}

function transcriberOf(ctx: PluginContext): LlmTranscriber | undefined {
  const t = hook().transcriber ?? ctx.providers.get<LlmTranscriber>('llm');
  return t && typeof t.transcribe === 'function' ? t : undefined;
}

async function handleChunk(ctx: PluginContext, room: Room, chunk: MediaListenChunk, catchingUp: boolean): Promise<void> {
  const before = await ctx.db.system((tx) => speakerOf(tx, room, chunk), { workspaceId: room.workspaceId });
  if (!before.ok) return; // nobody who has not said yes is ever sent anywhere
  const transcriber = transcriberOf(ctx);
  if (!transcriber) return;
  const heard = await ctx.db.system(
    (tx) => transcriber.transcribe(tx, { workspaceId: room.workspaceId, teamId: room.teamId, meetingId: room.id, actorId: chunk.identity, wav: chunk.wav, durationMs: chunk.durationMs }),
    { workspaceId: room.workspaceId },
  );
  if (heard.outcome !== 'text') {
    const now = Date.now();
    if (now - room.lastProblemAt > 60_000) {
      room.lastProblemAt = now;
      room.log.warn(`meetings: the note-taker could not transcribe a stretch of speech (${heard.outcome})`);
    }
    return;
  }
  const text = stripHostileText(heard.text).slice(0, 4000);
  if (text === '') return;
  const startMs = Math.min(INT_MAX - 60_000, Math.max(0, chunk.startedAt.getTime() - room.startedAt.getTime()));
  const endMs = startMs + Math.max(0, Math.round(chunk.durationMs));
  await ctx.db.system(
    async (tx) => {
      // the answer may have changed while the model worked: a no, or a kick, ends it here
      const after = await speakerOf(tx, room, chunk);
      if (!after.ok) return;
      const done = await takeSegments(
        ctx,
        tx,
        { id: room.id, workspaceId: room.workspaceId },
        { actorId: chunk.identity, displayName: after.name, consent: 'yes' },
        [{ clientSegId: `srv:${startMs}`, startMs, endMs, text, final: true, lang: heard.lang }],
        'server',
        { catchingUp },
      );
      if (done.stored > 0) room.lines.push({ startMs, speaker: after.name, text });
    },
    { workspaceId: room.workspaceId },
  );
}

/** Resolves when the room has no chunk waiting and none in work, or after `ms`. */
function idle(room: Room, ms: number): Promise<void> {
  if (!room.working && room.queue.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    room.waiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---- the transcript in the organizer's Personal space ---------------------------------------------------------------------------------------

/** Characters that mean something in markdown, escaped so what somebody said cannot become a heading, a link, a tag or a table. */
function escapeMarkdown(text: string): string {
  let out = text.startsWith('#') ? '\\#' : '';
  for (const ch of out === '' ? text : text.slice(1)) out += '\\`*_[]<>~|'.includes(ch) ? `\\${ch}` : ch;
  return out;
}

const lineOf = (l: TranscriptLine): string => `[${clock(l.startMs)}] **${escapeMarkdown(l.speaker)}:** ${escapeMarkdown(l.text)}\n`;

function headerOf(room: Room): string {
  const q = (s: string): string => JSON.stringify(s);
  return [
    '---',
    'type: "Meeting Transcript"',
    `title: ${q(room.title)}`,
    `date: ${q(room.startedAt.toISOString().slice(0, 10))}`,
    `start: ${q(room.startedAt.toISOString())}`,
    `channel: ${q(room.channelLabel)}`,
    'source: server',
    `note_taker: ${q(room.botName)}`,
    '---',
    '',
    `# ${escapeMarkdown(room.title)}`,
    '',
    '',
  ].join('\n');
}

/** `Meetings/2026-11-08-1402-sprint-review`, with `-2`, `-3` when the organizer already has a meeting in that folder. */
async function chooseFolder(tx: PluginTx, room: Room): Promise<string> {
  const d = room.startedAt;
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const base = `Meetings/${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}-${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}-${slugOf(room.title)}`;
  for (let n = 1; n <= 50; n += 1) {
    const folder = n === 1 ? base : `${base}-${n}`;
    const taken = await tx.query('SELECT 1 FROM app.meeting_notes WHERE organizer_id = $1::uuid AND transcript_path = $2 AND meeting_id <> $3::uuid LIMIT 1', [
      room.organizerActorId,
      `${folder}/transcript.md`,
      room.id,
    ]);
    if (taken.rows.length === 0) return folder;
  }
  return `${base}-${room.id.slice(0, 8)}`;
}

const statusOf = (err: unknown): number | undefined => (err as { status?: unknown } | null)?.status as number | undefined;

/** Appends the lines waiting to the file (one write at a time per room). `final`: the room is done, nothing may stay behind. */
function flushPersonal(ctx: PluginContext, room: Room, final: boolean): Promise<void> {
  room.chain = room.chain.then(() => writePersonal(ctx, room, final)).catch(() => undefined);
  return room.chain;
}

async function writePersonal(ctx: PluginContext, room: Room, final: boolean): Promise<void> {
  const lines = room.lines.splice(0);
  if (lines.length === 0) return;
  const files = ctx.providers.get<PersonalFilesProvider>('personal.files');
  if (!files || !room.organizerPersonId || !room.botActorId) {
    // the lines are in the room's transcript anyway; there is nowhere else to put them
    if (final) room.log.warn('meetings: the note-taker transcript could not be written to the organizer’s Personal space');
    return;
  }
  const personId = room.organizerPersonId;
  const botActorId = room.botActorId;
  try {
    await ctx.db.system(
      async (tx) => {
        let isNew = false;
        if (room.path === null) {
          room.path = `${await chooseFolder(tx, room)}/transcript.md`;
          isNew = true;
        }
        let text = lines.map(lineOf).join('');
        if (isNew) text = headerOf(room) + text;
        const written = await files.write(tx, personId, room.path, text, { mode: 'append', authorActorId: botActorId });
        if (written.file.text.length > PERSONAL_SAFE_BYTES) room.full = true;
        await tx.query(
          `INSERT INTO app.meeting_notes (meeting_id, location, transcript_path, file_ids)
           VALUES ($1::uuid, 'personal', $2, ARRAY[$3::uuid])
           ON CONFLICT (meeting_id) DO UPDATE SET transcript_path = EXCLUDED.transcript_path, updated_at = now()
             WHERE app.meeting_notes.location = 'personal'`,
          [room.id, room.path, written.file.fileId],
        );
      },
      { workspaceId: room.workspaceId },
    );
  } catch (err) {
    if (statusOf(err) === 413) {
      // the file is as big as a Personal file can be: the rest stays in the room's transcript
      if (!room.full) room.log.warn('meetings: the note-taker transcript is as long as a file in the Personal space can be');
      room.full = true;
    } else {
      // try again at the next flush; a room that is closing gives up
      if (!final) room.lines.unshift(...lines.slice(-500));
      else room.log.warn('meetings: the note-taker transcript could not be written to the organizer’s Personal space');
    }
  }
}

/** The transcript is complete: tell the rest of the system once. */
async function announceWritten(ctx: PluginContext, room: Room): Promise<void> {
  const path = room.path;
  if (path === null) return;
  await ctx.db.system(
    async (tx) => {
      const already = await tx.query("SELECT 1 FROM app.events WHERE type = 'meetings.transcript.written' AND payload->>'meetingId' = $1 LIMIT 1", [room.id]);
      if (already.rows.length > 0) return;
      const count = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.meeting_segments WHERE meeting_id = $1::uuid AND final AND text <> ''", [room.id])).rows[0]?.n ?? 0;
      const m = (await tx.query<{ channel_id: string | null }>('SELECT channel_id FROM app.meetings WHERE id = $1::uuid', [room.id])).rows[0];
      await ctx.audit.emit(
        tx,
        MeetingsTranscriptWrittenEvent.parse({
          type: 'meetings.transcript.written',
          schemaVersion: 1,
          workspaceId: room.workspaceId,
          teamId: room.teamId,
          channelId: m?.channel_id ?? null,
          meetingId: room.id,
          path,
          store: 'organizer_files',
          lineCount: count,
          at: ctx.runtime.now().toISOString(),
        }),
      );
    },
    { workspaceId: room.workspaceId },
  );
}

// ---- leaving -----------------------------------------------------------------------------------------------------------------------

type Why = 'ended' | 'removed' | 'lost';

/**
 * Leaves the room: hears what is left, transcribes the chunks it holds, writes the last of the transcript and (unless the connection was only lost, in which case the cron job
 * joins again) says the transcript is written. Safe to call twice.
 */
function stopRoom(ctx: PluginContext, room: Room, why: Why): Promise<void> {
  if (room.stopped) return room.stopped;
  room.stopping = true;
  if (room.reconcileTimer) clearInterval(room.reconcileTimer);
  if (room.flushTimer) clearInterval(room.flushTimer);
  room.stopped = (async () => {
    try {
      const listener = room.listener;
      room.listener = null;
      // the speech still open is delivered as the listener leaves, and lands in the queue below
      if (listener) await listener.close().catch(() => undefined);
      await idle(room, DRAIN_MS);
      await flushPersonal(ctx, room, why !== 'lost');
      if (why !== 'lost') {
        await announceWritten(ctx, room);
        if (why === 'ended') {
          await ctx.db.system(
            async (tx) => {
              const m = (await tx.query<{ channel_id: string | null }>('SELECT channel_id FROM app.meetings WHERE id = $1::uuid', [room.id])).rows[0];
              await ctx.audit.emit(
                tx,
                MeetingsNotetakerRemovedEvent.parse({
                  type: 'meetings.notetaker.removed',
                  schemaVersion: 1,
                  workspaceId: room.workspaceId,
                  teamId: room.teamId,
                  channelId: m?.channel_id ?? null,
                  meetingId: room.id,
                  botId: room.botId,
                  removedBy: null,
                  at: ctx.runtime.now().toISOString(),
                }),
              );
            },
            { workspaceId: room.workspaceId },
          );
        }
      }
      room.log.info('meetings: the note-taker left a voice room');
    } catch {
      room.log.warn('meetings: the note-taker could not finish leaving a voice room');
    } finally {
      const st = stateOf(ctx);
      if (st.rooms.get(room.id) === room) st.rooms.delete(room.id);
    }
  })();
  return room.stopped;
}

/** The media side ended on its own: the room was closed, or the connection was lost. */
async function closedByProvider(ctx: PluginContext, room: Room, reason: 'closed' | 'room_ended' | 'error'): Promise<void> {
  if (room.stopping) return;
  room.listener = null;
  if (reason === 'closed') {
    await stopRoom(ctx, room, 'lost');
    return;
  }
  let ended = false;
  // The media server says "room ended" while the request that ends the meeting may not have committed yet: look again for a few seconds before calling it a lost connection.
  const looks = reason === 'room_ended' ? 6 : 1;
  for (let look = 0; look < looks && !ended; look += 1) {
    if (look > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      const facts = await ctx.db.system((tx) => loadFacts(tx, room.id), { workspaceId: room.workspaceId });
      ended = !facts || facts.state !== 'live';
    } catch {
      // unknown: treat it as lost, the cron job decides
    }
  }
  await stopRoom(ctx, room, ended ? 'ended' : 'lost');
}

// ---- the jobs -------------------------------------------------------------------------------------------------------------------------

export function registerListener(ctx: PluginContext): void {
  // Right after a note-taker was added (and again, with backoff, if the media server was slow): not inside a transaction, joining a room takes seconds.
  ctx.jobs.register(
    LISTENER_START_QUEUE,
    async (payload, _tx, job) => {
      const p = StartPayload.parse(payload);
      await startListener(ctx, p.meetingId, p.workspaceId, job.log);
    },
    { detached: true, serialKey: 'meetingId', maxAttempts: 4 },
  );

  // Every minute: a room with a note-taker and no listener here (this process restarted, or the connection was lost) gets one. A room that ended is left alone.
  ctx.jobs.register(
    LISTENER_SWEEP_QUEUE,
    async (_payload, _tx, job) => {
      const rooms = await job.transaction(
        async (tx) =>
          (
            await tx.query<{ id: string; workspace_id: string }>(
              `SELECT id, workspace_id FROM app.meetings WHERE state = 'live' AND notetaker_bot_id IS NOT NULL
                  AND started_at > now() - make_interval(secs => $1::int) ORDER BY started_at LIMIT 100`,
              [24 * 3600],
            )
          ).rows,
      );
      const st = stateOf(ctx);
      for (const r of rooms) {
        if (st.rooms.has(r.id) || st.starting.has(r.id)) continue;
        if (st.rooms.size + st.starting.size >= maxRooms()) break;
        try {
          await startListener(ctx, r.id, r.workspace_id, job.log);
        } catch {
          job.log.warn('meetings: the note-taker could not join a voice room; trying again in a minute');
        }
      }
    },
    { cron: '* * * * *', detached: true, maxAttempts: 1 },
  );
}

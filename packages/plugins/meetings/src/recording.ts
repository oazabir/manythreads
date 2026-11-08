import { createReadStream, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HttpError,
  forbidden,
  json,
  notFound,
  readWavInfo,
  route,
  type BlobStorage,
  type MediaListenChunk,
  type MediaListener,
  type MessageProvider,
  type PluginContext,
  type PluginLogger,
  type PluginTx,
  type RepoProvider,
} from '@manythreads/sdk';
import {
  MEETING_KEEP_AUDIO_DAYS_DEFAULT,
  MeetingPathParams,
  MeetingRecordConsentRequest,
  MeetingRecordConsentResponse,
  MeetingRecordingState,
  MeetingsConsentChangedEvent,
  MeetingsRecordingStartedEvent,
  MeetingsRecordingStoppedEvent,
  SetMeetingRecordingRequest,
  SetMeetingRecordingResponse,
  TeamMeetingsBundleConfig,
  getMeetingRecordingRoute,
  meetingFolderName,
  meetingRecordConsentRoute,
  setMeetingRecordingRoute,
  type MeetingRecordingStopReason,
} from '@manythreads/shared';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { loadMeetingsSettings } from './config.ts';
import { announceRoom } from './live.ts';
import { currentMedia, requireMedia } from './media.ts';
import { loadMeeting, type MeetingRow } from './rows.ts';

// Work package S6 (P15-15, decision C11): recording a room's audio. Off until a workspace admin switches `recording_cap` on; then anyone present may turn it on for the room,
// and every person present answers "Record my voice" for themself. The rules, which every line below serves:
//   * Audio is written for a person only while EVERYONE present has said yes. The moment someone present has not (they joined, or answered no) nothing is written for anybody, and
//     the files so far are closed (`joined_without_yes`, `consent_withdrawn`) with a line in the call's thread. When all say yes again, new files begin.
//   * One 16 kHz mono WAV per consenting person per stretch. A person who leaves ends their file (`left`); the room ending or recording turned off ends all of them.
//   * The platform stores the file (the system role), in the channel's Files storage under `meetings/<folder>/audio/`, never in git. The person whose voice it is is the uploader,
//     so the Files rules (read by whoever reads the channel, delete by the uploader or a lead) apply as to any file of that channel.
//   * A yes counts only if it was given after the person last joined: a yes left over from an earlier stretch of recording does not follow a person who left and came back.
//   * Kept for `TEAM.md` `meetings.keepAudioDays` days (30 by default); the retention plugin deletes them (`delete_after`, retention 0002).
//
// How the audio arrives: the recorder is its own listen-only participant (`recorder:<room>`, hidden, never publishes), like the note-taker's listener but separate from it. The
// provider cuts each person's speech at pauses (`audio/vad.ts`); the spool lays those pieces on the room's clock and fills the pauses with silence, so a file is as long as the
// person's stay and a place in it is a place in the meeting. Samples go to a temporary file as they come (a long meeting is not held in memory) and the finished file is
// put into Files storage when the stretch ends.
//
// One server process is assumed (as for the note-taker). A restart loses the stretch in progress: its row is closed as `failed` and a minute later a new one begins.

export const RECORDER_START_QUEUE = 'meetings.recorder.start';
export const RECORDER_SWEEP_QUEUE = 'meetings.recorder.sweep';

const StartPayload = z.object({ meetingId: z.uuid(), workspaceId: z.uuid() });

const RECONCILE_MS = 2_000;
/** A chunk is accepted only if the gate was checked this recently. */
const GATE_FRESH_MS = 500;
/** One person's file stops growing after this much audio (3 hours: about 345 MB). */
export const RECORDING_MAX_MS = 3 * 3_600_000;
const BYTES_PER_MS = 32; // 16 kHz, 16-bit, mono
const MAX_BYTES = RECORDING_MAX_MS * BYTES_PER_MS;
const STALE_TMP_MS = 24 * 3_600_000;

export const recordingMaxRooms = (): number => {
  const raw = Number.parseInt(process.env['MANYTHREADS_RECORDING_MAX_ROOMS'] ?? '', 10);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 100) : 10;
};

// Test hook (outside production only), on globalThis because the server loads this file by its own path and a test may import it by another.
const HOOK = Symbol.for('manythreads.meetings.recording.hook');
interface RecordingHook {
  reconcileMs?: number;
}
const hook = (): RecordingHook => (process.env['NODE_ENV'] === 'production' ? {} : ((globalThis as unknown as Record<symbol, RecordingHook | undefined>)[HOOK] ?? {}));

// ---- the spool: one person's audio on the room's clock -------------------------------------------------------------------------------------------------------

/** A canonical 44-byte WAV header for `dataBytes` of 16 kHz mono 16-bit PCM. */
export function wavHeader(dataBytes: number): Uint8Array {
  const out = new Uint8Array(44);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) out[at + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16_000, true);
  v.setUint32(28, 32_000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, dataBytes, true);
  return out;
}

const SILENCE_BLOCK = new Uint8Array(64 * 1024);

/**
 * The samples of one person's recording so far, in a temporary file. `startedAtMs` is the instant the file begins (the clock of `addChunk`'s `atMs`). A piece that starts later than
 * the end of the file is preceded by silence; a piece that overlaps what is already there is appended (time never goes back).
 */
export class PcmSpool {
  private bytes = 0;
  private full = false;
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly handle: fs.FileHandle,
    readonly startedAtMs: number,
    private readonly maxBytes: number,
  ) {}

  static async open(path: string, startedAtMs: number, maxBytes = MAX_BYTES): Promise<PcmSpool> {
    await fs.mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    const handle = await fs.open(path, 'w', 0o600);
    return new PcmSpool(path, handle, startedAtMs, maxBytes);
  }

  get dataBytes(): number {
    return this.bytes;
  }
  get durationMs(): number {
    return Math.round(this.bytes / BYTES_PER_MS);
  }
  /** True once the file reached its limit and stopped growing. */
  get atLimit(): boolean {
    return this.full;
  }

  private async zeros(count: number): Promise<void> {
    let left = Math.min(count, this.maxBytes - this.bytes);
    left -= left % 2;
    while (left > 0) {
      const n = Math.min(left, SILENCE_BLOCK.length);
      await this.handle.write(SILENCE_BLOCK, 0, n);
      this.bytes += n;
      left -= n;
    }
  }

  /** Adds one chunk (a 16 kHz mono 16-bit WAV that began at `atMs`). Returns false when the bytes are not that format. */
  async addChunk(wav: Uint8Array, atMs: number): Promise<boolean> {
    if (this.closed) return false;
    const info = readWavInfo(wav);
    if (!info.ok) return false;
    const pcm = wav.subarray(info.dataOffset, info.dataOffset + info.dataBytes - (info.dataBytes % 2));
    if (pcm.length === 0) return true;
    const at = Math.max(0, Math.round((atMs - this.startedAtMs) * BYTES_PER_MS));
    const target = at - (at % 2);
    if (target > this.bytes) await this.zeros(target - this.bytes);
    const room = this.maxBytes - this.bytes;
    if (pcm.length > room) this.full = true;
    const take = Math.min(pcm.length, room - (room % 2));
    if (take > 0) {
      await this.handle.write(pcm, 0, take);
      this.bytes += take;
    }
    return true;
  }

  /** Pads with silence to `stopAtMs` and closes the file. */
  async finish(stopAtMs: number): Promise<void> {
    if (this.closed) return;
    const target = Math.round(Math.max(0, stopAtMs - this.startedAtMs) * BYTES_PER_MS);
    if (target > this.bytes) await this.zeros(target - (target % 2) - this.bytes);
    this.closed = true;
    await this.handle.close();
  }

  /** The finished WAV: its header, then the samples from the temporary file. */
  async *stream(): AsyncGenerator<Uint8Array> {
    yield wavHeader(this.bytes);
    if (this.bytes === 0) return;
    for await (const piece of createReadStream(this.path, { start: 0, end: this.bytes - 1 })) yield piece as Uint8Array;
  }

  async discard(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.handle.close().catch(() => undefined);
    }
    await fs.rm(this.path, { force: true }).catch(() => undefined);
  }
}

function tmpRoot(): string {
  return process.env['MANYTHREADS_RECORDING_TMP']?.trim() || join(tmpdir(), 'manythreads-recording');
}

/** Removes spool files a crashed process left behind (older than a day). Best effort. */
async function clearStaleSpools(): Promise<void> {
  try {
    const root = tmpRoot();
    for (const name of await fs.readdir(root)) {
      const path = join(root, name);
      const stat = await fs.stat(path).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > STALE_TMP_MS) await fs.rm(path, { force: true });
    }
  } catch {
    // no folder, nothing to clear
  }
}

// ---- what is written where ------------------------------------------------------------------------------------------------------------------------------------

/** A file-name-safe word for a person's name (letters and digits, lowercase, hyphens), never empty. */
export function audioSlug(name: string): string {
  let out = '';
  let hyphen = false;
  for (const ch of name.normalize('NFKD').toLowerCase()) {
    if (ch >= '\u0300' && ch <= '\u036f') continue; // an accent belongs to its letter
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      if (hyphen && out !== '') out += '-';
      hyphen = false;
      out += ch;
    } else hyphen = true;
  }
  const cut = out.slice(0, 40).replace(/-+$/, '');
  return cut === '' ? 'voice' : cut;
}

/** The folder of a meeting's audio in Files storage: `channels/<name>/meetings/<dd>-<hhmm>-<title>/audio/` (`dms/<id>/...` for a direct message). */
export function audioFolder(channel: { id: string; name: string; kind: string }, startedAt: Date, title: string): string {
  const base = channel.kind === 'channel' ? `channels/${channel.name}/` : `dms/${channel.id}/`;
  return `${base}meetings/${meetingFolderName(startedAt, audioSlug(title))}/audio/`;
}

/** How many days audio is kept, from a team's `TEAM.md`. No file, no key or a value that cannot be read: the default. Never throws. */
export function readTeamKeepAudioDays(teamMd: string | null): number {
  if (teamMd === null) return MEETING_KEEP_AUDIO_DAYS_DEFAULT;
  const block = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(teamMd)?.[1];
  if (block === undefined) return MEETING_KEEP_AUDIO_DAYS_DEFAULT;
  try {
    const doc: unknown = parseYaml(block, { maxAliasCount: 20 });
    const meetings = typeof doc === 'object' && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>)['meetings'] : undefined;
    if (typeof meetings !== 'object' || meetings === null || Array.isArray(meetings)) return MEETING_KEEP_AUDIO_DAYS_DEFAULT;
    const parsed = TeamMeetingsBundleConfig.shape.keepAudioDays.safeParse((meetings as Record<string, unknown>)['keepAudioDays']);
    return parsed.success ? parsed.data : MEETING_KEEP_AUDIO_DAYS_DEFAULT;
  } catch {
    return MEETING_KEEP_AUDIO_DAYS_DEFAULT;
  }
}

async function loadKeepAudioDays(ctx: PluginContext, tx: PluginTx, teamId: string | null): Promise<number> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo || teamId === null) return MEETING_KEEP_AUDIO_DAYS_DEFAULT;
  try {
    const blob = await repo.blob(tx, teamId, 'TEAM.md', 'main', 256 * 1024);
    return readTeamKeepAudioDays(new TextDecoder().decode(blob.content));
  } catch {
    return MEETING_KEEP_AUDIO_DAYS_DEFAULT;
  }
}

/** Whether retention's column `delete_after` exists (retention 0002 adds it); the recorder works without it and retention then falls back to the default. */
const keepColumn = new WeakMap<PluginContext, Promise<boolean>>();
function hasKeepColumn(ctx: PluginContext): Promise<boolean> {
  let known = keepColumn.get(ctx);
  if (!known) {
    known = ctx.db
      .system(async (tx) => (await tx.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'meeting_recordings' AND column_name = 'delete_after'")).rows.length > 0)
      .catch(() => false);
    keepColumn.set(ctx, known);
  }
  return known;
}

// ---- who is in the room, and who has said yes ----------------------------------------------------------------------------------------------------------

export interface PresentPerson {
  actorId: string;
  name: string;
  /** The stored answer. */
  stored: 'yes' | 'no' | 'unasked';
  /** True only for a yes given after the person last joined (see the header). */
  yes: boolean;
}

/** The people in the room now, with their answers to "Record my voice". Read as whoever holds `tx` (the system role in the recorder). */
export async function loadPresent(tx: PluginTx, meetingId: string): Promise<PresentPerson[]> {
  const res = await tx.query<{ actor_id: string; display_name: string; consent_record: 'yes' | 'no' | 'unasked'; yes: boolean }>(
    `SELECT p.actor_id::text AS actor_id, p.display_name, p.consent_record,
            (p.consent_record = 'yes' AND EXISTS (
               SELECT 1 FROM app.events e
                WHERE e.workspace_id = p.workspace_id AND e.type = 'meetings.consent.changed'
                  AND e.payload->>'meetingId' = p.meeting_id::text AND e.payload->>'actorId' = p.actor_id::text
                  AND e.payload->>'subject' = 'record' AND e.payload->>'value' = 'yes' AND e.occurred_at >= p.joined_at)) AS yes
       FROM app.meeting_participants p
      WHERE p.meeting_id = $1::uuid AND p.left_at IS NULL
      ORDER BY p.joined_at, p.actor_id`,
    [meetingId],
  );
  return res.rows.map((r) => ({ actorId: r.actor_id, name: r.display_name, stored: r.consent_record, yes: r.yes }));
}

/**
 * Whose audio may be written now: everybody present when everybody present has said yes (and someone is present), nobody otherwise. This is the rule; the recorder and the
 * state the routes show both come from it.
 */
export function recordableNow(recordingOn: boolean, present: readonly PresentPerson[]): string[] {
  if (!recordingOn || present.length === 0 || !present.every((p) => p.yes)) return [];
  return present.map((p) => p.actorId);
}

/** Why a file that was being written stops, given who is present now. */
export function stopReasonFor(actorId: string, present: readonly PresentPerson[]): MeetingRecordingStopReason {
  const me = present.find((p) => p.actorId === actorId);
  if (!me) return 'left';
  if (!me.yes) return 'consent_withdrawn';
  return 'joined_without_yes';
}

// ---- the recorder in a room ----------------------------------------------------------------------------------------------------------------------------

interface Session {
  actorId: string;
  name: string;
  rowId: string;
  startedAt: Date;
  spool: PcmSpool;
  /** Writes to the spool one after the other. */
  chain: Promise<void>;
  warned: boolean;
}

interface Room {
  id: string;
  workspaceId: string;
  teamId: string | null;
  channelId: string;
  log: PluginLogger;
  listener: MediaListener | null;
  identities: string[];
  sessions: Map<string, Session>;
  stopping: boolean;
  stopped: Promise<void> | null;
  timer: ReturnType<typeof setInterval> | null;
  reconciling: Promise<void> | null;
  gateAt: number;
  work: Promise<void>;
  seq: number;
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

/** True while this server process holds a recorder for the room. */
export function isRecording(ctx: PluginContext, meetingId: string): boolean {
  const room = stateOf(ctx).rooms.get(meetingId);
  return room !== undefined && room.listener !== null && !room.stopping;
}

/** The ids of the people whose audio this process is writing right now (for a test and for the state the routes show). */
export function recordingNow(ctx: PluginContext, meetingId: string): string[] {
  return [...(stateOf(ctx).rooms.get(meetingId)?.sessions.keys() ?? [])];
}

interface RoomFacts {
  id: string;
  workspace_id: string;
  team_id: string | null;
  channel_id: string | null;
  title: string;
  state: 'live' | 'ended';
  started_at: Date;
  organizer_id: string;
  recording: boolean;
  recording_by: string | null;
  thread_root_id: string | null;
  channel_kind: string | null;
  channel_name: string | null;
}

async function loadFacts(tx: PluginTx, meetingId: string): Promise<RoomFacts | undefined> {
  return (
    await tx.query<RoomFacts & Record<string, unknown>>(
      `SELECT m.id, m.workspace_id, m.team_id, m.channel_id, m.title, m.state, m.started_at, m.organizer_id, m.recording, m.recording_by, m.thread_root_id,
              c.kind AS channel_kind, c.name AS channel_name
         FROM app.meetings m LEFT JOIN app.channels c ON c.id = m.channel_id WHERE m.id = $1::uuid`,
      [meetingId],
    )
  ).rows[0];
}

/** Joins the room as the recorder. Does nothing when this process already has it, or when the room is not live or not recording. */
export async function startRecorder(ctx: PluginContext, meetingId: string, workspaceId: string, log: PluginLogger): Promise<'started' | 'already' | 'gone'> {
  const st = stateOf(ctx);
  if (st.rooms.has(meetingId) || st.starting.has(meetingId)) return 'already';
  if (st.rooms.size + st.starting.size >= recordingMaxRooms()) throw new Error('The recorder is busy.');
  st.starting.add(meetingId);
  try {
    const facts = await ctx.db.system((tx) => loadFacts(tx, meetingId), { workspaceId });
    if (!facts || facts.state !== 'live' || !facts.recording || !facts.channel_id) return 'gone';
    const media = requireMedia(ctx);
    if (typeof media.listen !== 'function') throw new Error('This media server cannot record.');
    // Whatever a process before this one left open will never be finished: close those rows (their files are gone with the temporary folder).
    await ctx.db.system(
      (tx) => tx.query("UPDATE app.meeting_recordings SET stopped_at = now(), stop_reason = 'failed' WHERE meeting_id = $1::uuid AND stopped_at IS NULL", [meetingId]),
      { workspaceId },
    );
    const room: Room = {
      id: facts.id,
      workspaceId: facts.workspace_id,
      teamId: facts.team_id,
      channelId: facts.channel_id,
      log,
      listener: null,
      identities: [],
      sessions: new Map(),
      stopping: false,
      stopped: null,
      timer: null,
      reconciling: null,
      gateAt: 0,
      work: Promise.resolve(),
      seq: 0,
    };
    // Not an actor id: the media server's notices about an unknown UUID make the plugin drop that "person" from the room (webhook.ts).
    room.listener = await media.listen(meetingId, {
      identities: [],
      listener: { identity: `recorder:${meetingId}`, displayName: 'Recorder' },
      onChunk: (chunk) => accept(ctx, room, chunk),
      onClosed: (reason) => void closedByProvider(ctx, room, reason),
    });
    st.rooms.set(meetingId, room);
    room.timer = setInterval(() => void reconcile(ctx, room), hook().reconcileMs ?? RECONCILE_MS);
    room.timer.unref?.();
    void reconcile(ctx, room);
    log.info('meetings: the recorder joined a voice room');
    return 'started';
  } finally {
    st.starting.delete(meetingId);
  }
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Looks at the database and brings the recorder in line with it. One at a time; callers that arrive meanwhile wait for the same pass. */
function reconcile(ctx: PluginContext, room: Room): Promise<void> {
  if (room.reconciling) return room.reconciling;
  const pass = (async () => {
    try {
      await reconcileOnce(ctx, room);
    } catch {
      // the next tick tries again; a recorder that cannot reach the database keeps the files it has and writes nothing new for a person it cannot confirm
      room.identities = [];
      room.listener?.setIdentities([]);
    } finally {
      room.reconciling = null;
    }
  })();
  room.reconciling = pass;
  return pass;
}

async function reconcileOnce(ctx: PluginContext, room: Room): Promise<void> {
  if (room.stopping) return;
  const view = await ctx.db.system(
    async (tx) => {
      const facts = await loadFacts(tx, room.id);
      if (!facts || facts.state !== 'live' || !facts.recording) return { facts, present: [] as PresentPerson[] };
      const present = await loadPresent(tx, room.id);
      // a yes that was given before the person last joined is not an answer to this stretch: ask again
      const stale = present.filter((p) => p.stored === 'yes' && !p.yes).map((p) => p.actorId);
      if (stale.length > 0) {
        await tx.query("UPDATE app.meeting_participants SET consent_record = 'unasked' WHERE meeting_id = $1::uuid AND actor_id = ANY($2::uuid[]) AND consent_record = 'yes'", [room.id, stale]);
      }
      return { facts, present };
    },
    { workspaceId: room.workspaceId },
  );
  if (room.stopping) return;
  const { facts, present } = view;
  if (!facts || facts.state !== 'live') {
    void stopRoom(ctx, room, 'ended');
    return;
  }
  if (!facts.recording) {
    void stopRoom(ctx, room, 'turned_off');
    return;
  }
  const want = recordableNow(true, present);
  room.gateAt = Date.now();
  // Order matters. Tracks are dropped before files are closed, and added only after the file they go to exists: nobody not on the list is ever heard, and nobody on it is
  // heard before there is somewhere to put it.
  const keep = want.filter((id) => room.sessions.has(id)).sort();
  setIdentities(room, keep);
  const leaving = [...room.sessions.keys()].filter((id) => !want.includes(id));
  if (leaving.length > 0) {
    const reasons = new Map(leaving.map((id) => [id, stopReasonFor(id, present)] as const));
    await finishSessions(ctx, room, reasons, facts);
  }
  const joining = want.filter((id) => !room.sessions.has(id));
  if (joining.length > 0 && !room.stopping) await beginSessions(ctx, room, facts, present.filter((p) => joining.includes(p.actorId)));
  setIdentities(room, want.filter((id) => room.sessions.has(id)).sort());
}

function setIdentities(room: Room, ids: string[]): void {
  if (sameList(ids, room.identities)) return;
  room.identities = ids;
  room.listener?.setIdentities(ids);
}

// ---- sessions: one person's file ---------------------------------------------------------------------------------------------------------------------

async function beginSessions(ctx: PluginContext, room: Room, facts: RoomFacts, people: readonly PresentPerson[]): Promise<void> {
  const startedAt = new Date();
  const begun: Session[] = [];
  for (const p of people) {
    room.seq += 1;
    const spool = await PcmSpool.open(join(tmpRoot(), `${room.id}-${p.actorId}-${room.seq}.pcm`), startedAt.getTime());
    const rowId = await ctx.db.system(
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.meeting_recordings (meeting_id, workspace_id, actor_id, started_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz) RETURNING id`,
            [room.id, room.workspaceId, p.actorId, startedAt.toISOString()],
          )
        ).rows[0]!.id,
      { workspaceId: room.workspaceId },
    ).catch(async (err) => {
      await spool.discard();
      throw err;
    });
    const session: Session = { actorId: p.actorId, name: p.name, rowId, startedAt, spool, chain: Promise.resolve(), warned: false };
    room.sessions.set(p.actorId, session);
    begun.push(session);
  }
  if (begun.length === 0) return;
  await ctx.db.system(
    (tx) =>
      ctx.audit.emit(
        tx,
        MeetingsRecordingStartedEvent.parse({
          type: 'meetings.recording.started',
          schemaVersion: 1,
          workspaceId: room.workspaceId,
          teamId: room.teamId,
          channelId: room.channelId,
          meetingId: room.id,
          startedBy: facts.recording_by ?? facts.organizer_id,
          people: begun.length,
          at: ctx.runtime.now().toISOString(),
        }),
      ),
    { workspaceId: room.workspaceId },
  ).catch(() => undefined);
}

/**
 * Closes the listed people's files, one after the other: pads to now, puts the file into Files storage, records it. Says once per reason that recording stopped, and, when the
 * reason is that somebody in the room has not agreed, writes a line in the call's thread.
 */
async function finishSessions(ctx: PluginContext, room: Room, reasons: ReadonlyMap<string, MeetingRecordingStopReason>, facts: RoomFacts | undefined): Promise<void> {
  const finished: Array<{ session: Session; reason: MeetingRecordingStopReason }> = [];
  for (const [actorId, reason] of reasons) {
    const session = room.sessions.get(actorId);
    if (!session) continue;
    room.sessions.delete(actorId);
    finished.push({ session, reason: await storeSession(ctx, room, session, reason, facts) });
  }
  if (finished.length === 0) return;
  const distinct = [...new Set(finished.map((f) => f.reason))];
  await ctx.db
    .system(
      async (tx) => {
        for (const reason of distinct) {
          await ctx.audit.emit(
            tx,
            MeetingsRecordingStoppedEvent.parse({
              type: 'meetings.recording.stopped',
              schemaVersion: 1,
              workspaceId: room.workspaceId,
              teamId: room.teamId,
              channelId: room.channelId,
              meetingId: room.id,
              reason,
              stoppedBy: null,
              at: ctx.runtime.now().toISOString(),
            }),
          );
        }
      },
      { workspaceId: room.workspaceId },
    )
    .catch(() => undefined);
  if (distinct.includes('joined_without_yes') || distinct.includes('consent_withdrawn')) await postThreadLine(ctx, room, facts, 'Recording stopped: someone in this room has not agreed to be recorded. It starts again when everyone has.');
}

/** Closes one file. Returns the reason that ended up on the row (`failed` when the file could not be kept). */
async function storeSession(ctx: PluginContext, room: Room, session: Session, reason: MeetingRecordingStopReason, facts: RoomFacts | undefined): Promise<MeetingRecordingStopReason> {
  await session.chain.catch(() => undefined);
  const stoppedAt = new Date();
  try {
    await session.spool.finish(stoppedAt.getTime());
    const storage = ctx.providers.get<BlobStorage>('storage');
    if (!storage) throw new Error('File storage is not available');
    const size = 44 + session.spool.dataBytes;
    const blob = await storage.put(session.spool.stream(), { maxBytes: size + 4096 });
    const keepDays = await ctx.db.system((tx) => loadKeepAudioDays(ctx, tx, room.teamId), { workspaceId: room.workspaceId });
    const withKeep = await hasKeepColumn(ctx);
    await ctx.db.system(
      async (tx) => {
        const f = facts ?? (await loadFacts(tx, room.id));
        const channel = { id: room.channelId, name: f?.channel_name ?? 'channel', kind: f?.channel_kind ?? 'channel' };
        const folder = audioFolder(channel, f?.started_at ?? session.startedAt, f?.title ?? 'meeting');
        const slug = audioSlug(session.name);
        let fileId = '';
        for (let n = 1; n <= 50 && fileId === ''; n += 1) {
          const name = n === 1 ? `${slug}.wav` : `${slug}-${n}.wav`;
          const taken = await tx.query('SELECT 1 FROM app.files WHERE channel_id = $1::uuid AND folder_path = $2 AND name = $3', [room.channelId, folder, name]);
          if (taken.rows.length > 0) continue;
          fileId = (
            await tx.query<{ id: string }>(
              `INSERT INTO app.files (workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
               VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'audio/wav', $7, $8::uuid) RETURNING id`,
              [room.workspaceId, room.channelId, folder, name, blob.blobKey, blob.size, blob.sha256, session.actorId],
            )
          ).rows[0]!.id;
        }
        if (fileId === '') throw new Error('no free file name');
        await tx.query(
          `UPDATE app.meeting_recordings SET file_id = $2::uuid, stopped_at = $3::timestamptz, stop_reason = $4${withKeep ? ', delete_after = $5::timestamptz' : ''} WHERE id = $1::uuid`,
          withKeep
            ? [session.rowId, fileId, stoppedAt.toISOString(), reason, new Date(stoppedAt.getTime() + keepDays * 86_400_000).toISOString()]
            : [session.rowId, fileId, stoppedAt.toISOString(), reason],
        );
      },
      { workspaceId: room.workspaceId },
    );
    return reason;
  } catch {
    room.log.warn('meetings: a recording could not be kept');
    await ctx.db
      .system((tx) => tx.query("UPDATE app.meeting_recordings SET stopped_at = $2::timestamptz, stop_reason = 'failed' WHERE id = $1::uuid AND stopped_at IS NULL", [session.rowId, stoppedAt.toISOString()]), {
        workspaceId: room.workspaceId,
      })
      .catch(() => undefined);
    return 'failed';
  } finally {
    await session.spool.discard();
  }
}

/** A line in the call's thread, written as the person who turned recording on (else the organizer), so it reads like the other lines of the call. Best effort. */
async function postThreadLine(ctx: PluginContext, room: Room, facts: RoomFacts | undefined, text: string): Promise<void> {
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages) return;
  try {
    const f = facts ?? (await ctx.db.system((tx) => loadFacts(tx, room.id), { workspaceId: room.workspaceId }));
    if (!f || !f.thread_root_id) return;
    const author = f.recording_by ?? f.organizer_id;
    await ctx.db.as({ actorId: author, kind: 'person', workspaceId: room.workspaceId, personId: null, sessionId: null }, async (tx) => {
      await messages.post(tx, { channelId: room.channelId, body: text, threadRootId: f.thread_root_id, skipRefs: true });
    });
  } catch {
    room.log.warn('meetings: the recording notice could not be posted in the call thread');
  }
}

// ---- audio in --------------------------------------------------------------------------------------------------------------------------------------------------

function accept(ctx: PluginContext, room: Room, chunk: MediaListenChunk): void {
  // only a person the recorder was told to hear (a chunk of anyone else is dropped unheard, though the provider should never send one)
  if (!room.identities.includes(chunk.identity)) return;
  room.work = room.work.then(() => write(ctx, room, chunk)).catch(() => undefined);
}

async function write(ctx: PluginContext, room: Room, chunk: MediaListenChunk): Promise<void> {
  // the gate is looked at again if it has not been just now: a no, or someone who joined, stops the audio before it is written
  if (Date.now() - room.gateAt > GATE_FRESH_MS) await reconcile(ctx, room);
  const session = room.sessions.get(chunk.identity);
  if (!session || !room.identities.includes(chunk.identity)) return;
  session.chain = session.chain.then(async () => {
    const ok = await session.spool.addChunk(chunk.wav, chunk.startedAt.getTime());
    if (!ok && !session.warned) {
      session.warned = true;
      room.log.warn('meetings: the recorder was given audio in a format it does not keep');
    }
    if (session.spool.atLimit && !session.warned) {
      session.warned = true;
      room.log.warn('meetings: a recording reached its length limit and stopped growing');
    }
  });
  await session.chain.catch(() => undefined);
}

// ---- leaving -----------------------------------------------------------------------------------------------------------------------------------------------

/** Stops the recorder: hears what is left, closes every file with `reason`, leaves the room. Safe to call twice. */
function stopRoom(ctx: PluginContext, room: Room, reason: MeetingRecordingStopReason): Promise<void> {
  if (room.stopped) return room.stopped;
  room.stopping = true;
  if (room.timer) clearInterval(room.timer);
  room.stopped = (async () => {
    try {
      const listener = room.listener;
      room.listener = null;
      // the speech still open is delivered as the listener leaves, to the people it was listening to; it is written below, before the files are closed
      if (listener) await listener.close().catch(() => undefined);
      room.identities = [];
      await room.work.catch(() => undefined);
      await finishSessions(ctx, room, new Map([...room.sessions.keys()].map((id) => [id, reason] as const)), undefined);
      room.log.info('meetings: the recorder left a voice room');
    } catch {
      room.log.warn('meetings: the recorder could not finish leaving a voice room');
    } finally {
      const st = stateOf(ctx);
      if (st.rooms.get(room.id) === room) st.rooms.delete(room.id);
    }
  })();
  return room.stopped;
}

/** The media side ended on its own: the room was closed, or the connection was lost. The files so far are kept. */
async function closedByProvider(ctx: PluginContext, room: Room, why: 'closed' | 'room_ended' | 'error'): Promise<void> {
  if (room.stopped) return;
  room.listener = null;
  if (why === 'closed') {
    await stopRoom(ctx, room, 'turned_off');
    return;
  }
  let ended = why === 'room_ended';
  if (!ended) {
    try {
      const facts = await ctx.db.system((tx) => loadFacts(tx, room.id), { workspaceId: room.workspaceId });
      ended = !facts || facts.state !== 'live';
    } catch {
      // unknown: treat as lost
    }
  }
  await stopRoom(ctx, room, ended ? 'ended' : 'failed');
}

// ---- the state routes show ---------------------------------------------------------------------------------------------------------------------------

async function whyNot(ctx: PluginContext, tx: PluginTx, m: MeetingRow): Promise<string | null> {
  const settings = await loadMeetingsSettings(tx);
  if (settings.recordingCap !== 'on') return 'Recording is switched off for this workspace. A workspace admin can turn it on.';
  const media = currentMedia(ctx);
  if (!media || !media.status().configured) return 'Voice rooms are not set up on this server. Ask a workspace admin to connect a media server.';
  if (typeof media.listen !== 'function') return 'This media server cannot record a room.';
  if (!ctx.providers.get<BlobStorage>('storage')) return 'File storage is not available, so a recording could not be kept.';
  if (!m.channel_id) return 'This room has no channel to keep a recording in.';
  return null;
}

/** The room's recording as the caller sees it. */
export async function recordingState(ctx: PluginContext, tx: PluginTx, m: MeetingRow): Promise<MeetingRecordingState> {
  const settings = await loadMeetingsSettings(tx);
  const present = m.state === 'live' ? await loadPresent(tx, m.id) : [];
  const mine = (await tx.query<{ consent_record: 'yes' | 'no' | 'unasked' }>('SELECT consent_record FROM app.meeting_participants WHERE meeting_id = $1::uuid AND actor_id = app.actor()', [m.id])).rows[0];
  const mineNow = present.find((p) => p.actorId === tx.actor.id);
  const yourConsent = mineNow ? (mineNow.yes ? 'yes' : mineNow.stored === 'no' ? 'no' : 'unasked') : mine?.consent_record === 'no' ? 'no' : 'unasked';
  const files = await tx.query<{ id: string; meeting_id: string; actor_id: string; file_id: string | null; started_at: Date; stopped_at: Date | null; stop_reason: MeetingRecordingStopReason | null }>(
    'SELECT id, meeting_id, actor_id, file_id, started_at, stopped_at, stop_reason FROM app.meeting_recordings WHERE meeting_id = $1::uuid ORDER BY started_at, id',
    [m.id],
  );
  return MeetingRecordingState.parse({
    cap: settings.recordingCap,
    on: m.recording,
    recording: m.state === 'live' && recordableNow(m.recording, present).length > 0,
    yourConsent,
    reason: await whyNot(ctx, tx, m),
    files: files.rows.map((r) => ({
      id: r.id,
      meetingId: r.meeting_id,
      actorId: r.actor_id,
      fileId: r.file_id,
      startedAt: r.started_at.toISOString(),
      stoppedAt: r.stopped_at ? r.stopped_at.toISOString() : null,
      stopReason: r.stop_reason,
    })),
  });
}

async function callerPerson(tx: PluginTx): Promise<{ actorId: string; personId: string }> {
  const row = (await tx.query<{ person: string | null; actor: string | null }>('SELECT app.person_id() AS person, app.actor() AS actor')).rows[0];
  if (!row?.person || !row.actor) throw forbidden('Voice rooms are for people');
  return { actorId: row.actor, personId: row.person };
}

async function emitRoomChange(ctx: PluginContext, tx: PluginTx, m: MeetingRow, actorId: string, subject: 'record' | 'room_recording', value: 'yes' | 'no'): Promise<void> {
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
      subject,
      value,
      at: ctx.runtime.now().toISOString(),
    }),
  );
}

export function registerRecording(ctx: PluginContext): void {
  void clearStaleSpools();

  ctx.http.route({
    ...getMeetingRecordingRoute,
    schema: { response: MeetingRecordingState },
    rateLimit: { limit: 120, windowMs: 60_000 },
    readOnly: true,
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      return json(await recordingState(ctx, tx, m));
    }),
  });

  ctx.http.route({
    ...setMeetingRecordingRoute,
    schema: { body: SetMeetingRecordingRequest, response: SetMeetingRecordingResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const { on } = SetMeetingRecordingRequest.parse(req.body);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      if (on) {
        // the caps live outside the room's row (the workspace switch, the media server, storage): checked first, so a room that cannot record never changes
        const reason = await whyNot(ctx, tx, m);
        if (reason !== null) {
          if (reason.startsWith('Recording is switched off')) throw forbidden(reason);
          throw new HttpError(409, 'conflict', reason);
        }
      }
      const changed = (await tx.query<{ changed: boolean }>('SELECT app.meetings_set_recording($1::uuid, $2) AS changed', [m.id, on])).rows[0]?.changed === true;
      const after = (await loadMeeting(tx, m.id)) ?? m;
      if (changed) {
        await emitRoomChange(ctx, tx, after, caller.actorId, 'room_recording', on ? 'yes' : 'no');
        await announceRoom(ctx, tx, after);
        // joining the room takes seconds and must not hold this transaction; the recorder follows the room's own flag from then on
        if (on) await ctx.jobs.enqueue(tx, RECORDER_START_QUEUE, { meetingId: m.id, workspaceId: m.workspace_id }, { dedupeKey: `recorder:${m.id}` });
      }
      return json(await recordingState(ctx, tx, after));
    }),
  });

  ctx.http.route({
    ...meetingRecordConsentRoute,
    schema: { body: MeetingRecordConsentRequest, response: MeetingRecordConsentResponse },
    rateLimit: { limit: 60, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { meetingId } = MeetingPathParams.parse(req.params);
      const body = MeetingRecordConsentRequest.parse(req.body);
      const caller = await callerPerson(tx);
      const m = await loadMeeting(tx, meetingId);
      if (!m) throw notFound('That voice room is not available');
      if (m.state !== 'live') throw new HttpError(409, 'conflict', 'This voice room has ended');
      if (!m.recording) throw new HttpError(409, 'conflict', 'Recording is not turned on in this voice room');
      // only the caller's own row (row-level security says so as well), and only while they are in the room
      const updated = await tx.query(
        'UPDATE app.meeting_participants SET consent_record = $3 WHERE meeting_id = $1::uuid AND actor_id = $2::uuid AND left_at IS NULL RETURNING 1',
        [m.id, caller.actorId, body.record],
      );
      if (updated.rows.length === 0) throw forbidden('Join the voice room first');
      await emitRoomChange(ctx, tx, m, caller.actorId, 'record', body.record);
      await announceRoom(ctx, tx, m);
      return json(await recordingState(ctx, tx, m));
    }),
  });

  // Right after recording was turned on (and again, with backoff, if the media server was slow): not inside a transaction, joining a room takes seconds.
  ctx.jobs.register(
    RECORDER_START_QUEUE,
    async (payload, _tx, job) => {
      const p = StartPayload.parse(payload);
      await startRecorder(ctx, p.meetingId, p.workspaceId, job.log);
    },
    { detached: true, serialKey: 'meetingId', maxAttempts: 4 },
  );

  // Every minute: a room that is recording and has no recorder here (this process restarted, or the connection was lost) gets one; rows a dead process left open are closed.
  ctx.jobs.register(
    RECORDER_SWEEP_QUEUE,
    async (_payload, _unused, job) => {
      const rooms = await job.transaction(async (tx) => {
        await tx.query(
          `UPDATE app.meeting_recordings r SET stopped_at = now(), stop_reason = 'failed'
            WHERE r.stopped_at IS NULL AND EXISTS (SELECT 1 FROM app.meetings m WHERE m.id = r.meeting_id AND m.state = 'ended')`,
        );
        return (
          await tx.query<{ id: string; workspace_id: string }>(
            `SELECT id, workspace_id FROM app.meetings WHERE state = 'live' AND recording AND started_at > now() - make_interval(secs => $1::int) ORDER BY started_at LIMIT 100`,
            [24 * 3600],
          )
        ).rows;
      });
      const st = stateOf(ctx);
      for (const r of rooms) {
        if (st.rooms.has(r.id) || st.starting.has(r.id)) continue;
        if (st.rooms.size + st.starting.size >= recordingMaxRooms()) break;
        try {
          await startRecorder(ctx, r.id, r.workspace_id, job.log);
        } catch {
          job.log.warn('meetings: the recorder could not join a voice room; trying again in a minute');
        }
      }
    },
    { cron: '* * * * *', detached: true, maxAttempts: 1 },
  );
}

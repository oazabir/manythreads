import type { ListMeetingNotetakersResponse, Meeting, MeetingJoin, MeetingParticipant, MeetingRecordingState, MeetingSummary, MeetingTranscriptLine, MeetingTranscriptionState } from '@manythreads/shared';
import { ApiError } from '../src/api/client';
import type { CallApi } from '../src/meetings/api';
import type { CallDeps, RoomApi } from '../src/meetings/controller';
import { createFakeAdapter, type FakeAdapter } from '../src/meetings/fakeAdapter';
import { DEFAULT_PREFS } from '../src/meetings/prefs';
import type { Sound, Sounds } from '../src/meetings/sounds';

/** Shared fixtures for the voice-room tests: ids, rooms and people as the server sends them, a stand-in server, a clock and timers a test steps by hand. */

export const id = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const ME = id(1);
export const NADIA = id(2);
export const RAFI = id(3);
export const CHANNEL = id(100);
export const MEETING = id(200);
export const THREAD = id(300);
export const NOW = Date.parse('2026-11-03T10:00:00.000Z');

export const meeting = (over: Partial<Meeting> = {}): Meeting =>
  ({
    id: MEETING,
    workspaceId: id(9),
    teamId: id(8),
    channelId: CHANNEL,
    title: 'Voice room · 10:00',
    state: 'live',
    startedBy: ME,
    organizerId: ME,
    notetakerBotId: null,
    startedAt: '2026-11-03T10:00:00.000Z',
    endedAt: null,
    endReason: null,
    transcription: 'off',
    recording: false,
    transcriptPath: null,
    transcriptFileId: null,
    threadRootId: THREAD,
    ...over,
  }) as Meeting;

export const person = (actor: string, name: string, over: Partial<MeetingParticipant> = {}): MeetingParticipant =>
  ({
    meetingId: MEETING,
    actorId: actor,
    personId: id(1000 + Number(actor.slice(-3))),
    displayName: name,
    joinedAt: '2026-11-03T10:00:00.000Z',
    leftAt: null,
    consentTranscribe: 'unasked',
    consentRecord: 'unasked',
    ...over,
  }) as MeetingParticipant;

export const summary = (people: MeetingParticipant[], over: Partial<Meeting> = {}): MeetingSummary => ({ meeting: meeting(over), present: people });

export const join = (over: Partial<MeetingJoin> = {}): MeetingJoin =>
  ({ provider: 'fake', url: 'wss://media.example', token: 'tok-1', identity: ME, roomName: MEETING, expiresAt: new Date(NOW + 600_000).toISOString(), ...over }) as MeetingJoin;

export const transcription = (over: Partial<MeetingTranscriptionState> = {}): MeetingTranscriptionState =>
  ({ meetingId: MEETING, mode: 'off', turnedOnBy: null, allowed: ['on_device'], reason: null, ...over }) as MeetingTranscriptionState;

export const apiError = (status: number, message: string, code: ApiError['code'] = 'conflict'): ApiError => new ApiError({ code, status, message });

/** A stand-in server. `people` is what GET /meetings/:id answers; every call is recorded in `calls`. */
export type FakeServer = CallApi & {
  calls: string[];
  people: MeetingParticipant[];
  room: Meeting;
  transcriptionState: MeetingTranscriptionState;
  /** Make the next call named `name` reject with `error` (once). */
  failOnce(name: keyof CallApi, error: unknown): void;
  /** Make every call named `name` reject with `error` until cleared. */
  failAlways(name: keyof CallApi, error: unknown | null): void;
};

export function fakeServer(over: { people?: MeetingParticipant[]; room?: Partial<Meeting>; joinOver?: Partial<MeetingJoin> } = {}): FakeServer {
  const once = new Map<string, unknown>();
  const always = new Map<string, unknown>();
  const srv: FakeServer = {
    calls: [],
    people: over.people ?? [person(ME, 'Omar')],
    room: meeting(over.room),
    transcriptionState: transcription(),
    failOnce(name: keyof CallApi, error: unknown) {
      once.set(name, error);
    },
    failAlways(name: keyof CallApi, error: unknown | null) {
      if (error === null) always.delete(name);
      else always.set(name, error);
    },
  } as unknown as FakeServer;
  const run = async <T>(name: keyof CallApi, text: string, produce: () => T): Promise<T> => {
    srv.calls.push(text);
    if (once.has(name)) {
      const e = once.get(name);
      once.delete(name);
      throw e;
    }
    if (always.has(name)) throw always.get(name);
    return produce();
  };
  srv.start = (channelId) => run('start', `start ${channelId}`, () => ({ meeting: srv.room, created: true, join: join(over.joinOver) }));
  srv.join = (meetingId) => run('join', `join ${meetingId}`, () => ({ meeting: srv.room, join: join(over.joinOver) }));
  srv.renew = (meetingId) => run('renew', `renew ${meetingId}`, () => ({ join: join({ token: `tok-${srv.calls.length}`, ...over.joinOver }) }));
  srv.leave = (meetingId) => run('leave', `leave ${meetingId}`, () => ({ meeting: srv.room }));
  srv.end = (meetingId) => run('end', `end ${meetingId}`, () => ({ meeting: { ...srv.room, state: 'ended' as const } }));
  srv.get = (meetingId) => run('get', `get ${meetingId}`, () => ({ meeting: srv.room, present: srv.people }));
  srv.heartbeat = (meetingId, speaking) => run('heartbeat', `heartbeat ${meetingId} ${speaking}`, () => ({ ok: true as const, serverNow: new Date().toISOString() }));
  srv.transcription = (meetingId) => run('transcription', `transcription ${meetingId}`, () => srv.transcriptionState);
  srv.setTranscription = (meetingId, mode) =>
    run('setTranscription', `setTranscription ${mode}`, () => {
      srv.room = { ...srv.room, transcription: mode };
      srv.transcriptionState = transcription({ mode, turnedOnBy: mode === 'off' ? null : { actorId: ME as never, displayName: 'Omar' } });
      if (mode !== 'off') srv.people = srv.people.map((p) => ({ ...p, consentTranscribe: 'unasked' as const }));
      return srv.transcriptionState;
    });
  srv.consent = (meetingId, answer) =>
    run('consent', `consent ${answer}`, () => {
      srv.people = srv.people.map((p) => (p.actorId === ME ? { ...p, consentTranscribe: answer } : p));
      return { participant: srv.people.find((p) => p.actorId === ME)! };
    });
  return srv;
}

export const BOT = id(500);
export const notetakerBot = (over: Partial<ListMeetingNotetakersResponse['bots'][number]> = {}) =>
  ({ botId: BOT, slug: 'note-taker', name: 'Note-taker', role: 'Writes the notes', avatar: null, ...over }) as ListMeetingNotetakersResponse['bots'][number];

/** A stand-in for the note-taker, recording and transcript calls. Its state is plain fields a test changes; calls are recorded in the server's list. */
export type FakeRoom = RoomApi & {
  notetakerState: ListMeetingNotetakersResponse;
  recordingState: MeetingRecordingState;
  lines: MeetingTranscriptLine[];
  /** Make every call of this name reject with `error` until cleared (null). */
  failAlways(name: keyof RoomApi, error: unknown | null): void;
};

export function fakeRoom(srv: FakeServer): FakeRoom {
  const always = new Map<string, unknown>();
  const room = {
    notetakerState: { bots: [notetakerBot()], current: null, canAdd: true, reason: null },
    recordingState: { cap: 'on', on: false, recording: false, yourConsent: 'unasked', reason: null, files: [] },
    lines: [],
    failAlways(name: keyof RoomApi, error: unknown | null) {
      if (error === null) always.delete(name);
      else always.set(name, error);
    },
  } as unknown as FakeRoom;
  const run = async <T>(name: keyof RoomApi, text: string, produce: () => T): Promise<T> => {
    srv.calls.push(text);
    if (always.has(name)) throw always.get(name);
    return produce();
  };
  room.notetakers = (meetingId) => run('notetakers', `notetakers ${meetingId}`, () => room.notetakerState);
  room.addNotetaker = (meetingId, botId) =>
    run('addNotetaker', `addNotetaker ${botId}`, () => {
      const bot = room.notetakerState.bots.find((b) => b.botId === botId) ?? notetakerBot();
      room.notetakerState = { ...room.notetakerState, current: { bot, listening: true } };
      srv.room = { ...srv.room, transcription: 'server', notetakerBotId: botId as never };
      srv.transcriptionState = transcription({ mode: 'server', allowed: ['on_device', 'server'], turnedOnBy: { actorId: ME as never, displayName: 'Omar' } });
      srv.people = srv.people.map((p) => ({ ...p, consentTranscribe: 'unasked' as const }));
      return { notetaker: room.notetakerState.current! };
    });
  room.removeNotetaker = (meetingId) =>
    run('removeNotetaker', `removeNotetaker ${meetingId}`, () => {
      room.notetakerState = { ...room.notetakerState, current: null };
      return { removed: true };
    });
  room.recording = (meetingId) => run('recording', `recording ${meetingId}`, () => room.recordingState);
  room.setRecording = (meetingId, on) =>
    run('setRecording', `setRecording ${on}`, () => {
      room.recordingState = { ...room.recordingState, on, recording: false, yourConsent: on ? room.recordingState.yourConsent : 'unasked' };
      return room.recordingState;
    });
  room.recordConsent = (meetingId, answer) =>
    run('recordConsent', `recordConsent ${answer}`, () => {
      srv.people = srv.people.map((p) => (p.actorId === ME ? { ...p, consentRecord: answer } : p));
      const everyone = srv.people.every((p) => p.consentRecord === 'yes');
      room.recordingState = { ...room.recordingState, yourConsent: answer, recording: room.recordingState.on && everyone };
      return room.recordingState;
    });
  room.transcript = (meetingId) => run('transcript', `transcript ${meetingId}`, () => ({ lines: room.lines }));
  room.correct = (meetingId, segId, text) =>
    run('correct', `correct ${segId}`, () => {
      const old = room.lines.find((l) => l.segmentId === segId);
      if (!old) throw apiError(404, 'Not found', 'not_found');
      const line = { ...old, text };
      room.lines = room.lines.map((l) => (l.segmentId === segId ? line : l));
      return { line };
    });
  return room;
}

/** Timers a test steps by hand: `advance(ms)` runs what is due, in order. */
export class FakeClock {
  now = NOW;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void; every: number | null }>();
  setTimeout = (fn: () => void, ms: number): unknown => this.add(fn, ms, null);
  setInterval = (fn: () => void, ms: number): unknown => this.add(fn, ms, ms);
  clearTimeout = (h: unknown): void => void this.timers.delete(h as number);
  clearInterval = (h: unknown): void => void this.timers.delete(h as number);
  private add(fn: () => void, ms: number, every: number | null): number {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn, every });
    return id;
  }
  get pending(): number {
    return this.timers.size;
  }
  /** Moves time forward, running timers as they fall due. Lets promises settle between timers. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [tid, t] = next;
      this.now = Math.max(this.now, t.at);
      if (t.every === null) this.timers.delete(tid);
      else t.at += t.every;
      t.fn();
      await settle();
    }
    this.now = end;
    await settle();
  }
}

/** Lets pending promises run. */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
};

export type Heard = { played: Sound[]; ringing: boolean };
export function fakeSounds(): Sounds & Heard {
  const heard: Sounds & Heard = {
    played: [],
    ringing: false,
    play: (k) => void heard.played.push(k),
    startRing: () => {
      heard.ringing = true;
    },
    stopRing: () => {
      heard.ringing = false;
    },
  };
  return heard;
}

export type Rig = { deps: CallDeps; server: FakeServer; room: FakeRoom; clock: FakeClock; sounds: Sounds & Heard; adapters: FakeAdapter[]; stored: Map<string, string> };

/** Everything a call needs, with a stand-in server, a hand-stepped clock and fake media. */
export function rig(over: Parameters<typeof fakeServer>[0] = {}, prefs = DEFAULT_PREFS): Rig {
  const server = fakeServer(over);
  const clock = new FakeClock();
  const sounds = fakeSounds();
  const adapters: FakeAdapter[] = [];
  const stored = new Map<string, string>();
  const room = fakeRoom(server);
  const deps: CallDeps = {
    api: server,
    room,
    loadAdapter: async () => {
      const a = createFakeAdapter();
      adapters.push(a);
      return a;
    },
    sounds,
    storage: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v) },
    prefs,
    loadEngine: async () => null,
    now: () => clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  };
  return { deps, server, room, clock, sounds, adapters, stored };
}

import type { ListMeetingNotetakersResponse, Meeting, MeetingConsent, MeetingJoin, MeetingParticipant, MeetingRecordingState, MeetingTranscriptLine, MeetingTranscriptionState, MeetingCaption, StartMeetingRequest, StartMeetingResponse } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { canOfferServer, enginePlan, planConsent, micMayOpen, writtenOnServer, type ConsentPlan, type EnginePlan, type EngineUi } from './consent';
import type { CallApi, addNotetaker, answerRecordConsent, correctSegment, fetchNotetakers, fetchRecording, fetchTranscript, removeNotetaker, setRecording } from './api';
import type { StreamStatus, TranscribeEngine } from './engine';
import { AUDIO_DEFAULTS, type AdapterEvents, type AdapterLoader, type Connection, type DeviceLists, type MediaAdapter, type VideoTile } from './media';
import { suggestAudioOnly, type ConnectionQuality } from './layout';
import {
  HEARTBEAT_EVERY_MS,
  LIVE_POLL_MS,
  REJOIN_ATTEMPTS,
  changeFailure,
  isNotConfigured,
  mergeCaptions,
  planRecordConsent,
  presenceChange,
  rejoinDelay,
  renewDelay,
  startFailure,
  type CaptionLine,
  type RecordConsentPlan,
} from './model';
import type { CallPrefs, KeyValue, StageLayout } from './prefs';
import { savePrefs } from './prefs';
import type { Sounds } from './sounds';

/*
 * The call (PLAN P15-04, P15-05): one room at a time per tab. This class is the whole story of being in a voice room: starting or joining it, connecting to the media
 * server, the heartbeat and the token renewal, mute / deafen / push-to-talk, the devices, getting back after a network drop, the consent answer that must come before
 * the microphone opens, the live captions, the note-taker, recording, and leaving. It knows nothing of React or of the media library: the server and the media layer are handed in, so a test drives every path.
 */

export type Phase =
  | 'idle'
  | 'starting'
  | 'connecting'
  | 'connected'
  /** The network dropped; the library or this class is getting back in. */
  | 'reconnecting'
  /** Gave up getting back in; the person can press Rejoin. */
  | 'lost'
  /** The server has no media server: said in plain words, nothing was started. */
  | 'not-set-up'
  | 'failed';

export type CallState = {
  phase: Phase;
  meeting: Meeting | null;
  /** The channel the person asked about while there is no meeting yet (starting, not set up, failed). */
  channelId: string | null;
  present: readonly MeetingParticipant[];
  myActorId: string | null;
  muted: boolean;
  deafened: boolean;
  /** Push-to-talk is on: the microphone is open only while the key or button is held. */
  pushToTalk: boolean;
  talking: boolean;
  /** Why the microphone is closed beyond "muted": the consent answer is still to come. */
  waitingForConsent: boolean;
  speaking: ReadonlySet<string>;
  devices: DeviceLists | null;
  prefs: CallPrefs;
  transcription: MeetingTranscriptionState | null;
  consent: ConsentPlan;
  chatUnread: number;
  chatOpen: boolean;
  /** The last captions that came in over the socket (newest last); the strip shows the latest two that have not faded. */
  captions: readonly CaptionLine[];
  /** What this person's own transcription engine is doing (P15-06): off, getting ready, listening, too slow for this device, or failed. */
  engine: EngineUi;
  /** The note-taker bots that may be added and the one that is in the room; null when the server has no note-taker. */
  notetakers: ListMeetingNotetakersResponse | null;
  /** Recording: the workspace switch, whether it is on, and this person's answer; null when the server has no recording. */
  recording: MeetingRecordingState | null;
  recordConsent: RecordConsentPlan;
  /** The stored lines of the transcript so far, for the captions history (a person corrects their own line there). */
  history: { status: 'idle' | 'loading' | 'ok' | 'failed'; lines: readonly MeetingTranscriptLine[] };
  /** A plain sentence to show above the controls (reconnecting, microphone blocked, you were removed). Null when there is nothing to say. */
  notice: string | null;
  /** The server's or the library's plain words for why the last start or join failed. */
  error: string | null;
  /** The cameras and shared screens in the room (P35-08), this person's own included. */
  videos: readonly VideoTile[];
  /** Audio only (P17-01): other people's video is not received and this person's camera is off, for a weak connection. Lasts for this call. */
  audioOnly: boolean;
  /** The connection is weak: the bar offers "Audio only" (a suggestion; nothing is switched by itself). */
  audioOnlySuggested: boolean;
};

/** Whether this person's camera or screen is on, and who else is sharing a screen (one sharer at a time). */
export const videoState = (videos: readonly VideoTile[]) => ({
  cameraOn: videos.some((v) => v.local && v.source === 'camera'),
  screenOn: videos.some((v) => v.local && v.source === 'screen'),
  otherSharer: videos.find((v) => !v.local && v.source === 'screen')?.actorId ?? null,
});

/** The calls for the note-taker, recording and the transcript history (Bundle C), kept apart from `CallApi` so that file stays as it was. */
export type RoomApi = {
  notetakers: typeof fetchNotetakers;
  addNotetaker: typeof addNotetaker;
  removeNotetaker: typeof removeNotetaker;
  recording: typeof fetchRecording;
  setRecording: typeof setRecording;
  recordConsent: typeof answerRecordConsent;
  transcript: typeof fetchTranscript;
  correct: typeof correctSegment;
};

export type CallDeps = {
  api: CallApi;
  room: RoomApi;
  loadAdapter: AdapterLoader;
  sounds: Sounds;
  storage: KeyValue | null;
  prefs: CallPrefs;
  loadEngine: (mode?: 'on_device' | 'server') => Promise<TranscribeEngine | null>;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
};

/** Things only the screen can do. */
export type CallHooks = {
  /** Open the call's chat thread in the right panel (when a person joins, and when they press Chat). `automatic` is the opening on joining, not the person's own press. */
  openChat(threadRootId: string, channelId: string | null, opts?: { automatic?: boolean }): void;
};

const IDLE = (prefs: CallPrefs): CallState => ({
  phase: 'idle',
  meeting: null,
  channelId: null,
  present: [],
  myActorId: null,
  muted: false,
  deafened: false,
  pushToTalk: prefs.pushToTalk,
  talking: false,
  waitingForConsent: false,
  speaking: new Set(),
  devices: null,
  prefs,
  transcription: null,
  consent: { kind: 'none' },
  captions: [],
  engine: { kind: 'off' },
  notetakers: null,
  recording: null,
  recordConsent: 'none',
  history: { status: 'idle', lines: [] },
  chatUnread: 0,
  chatOpen: false,
  notice: null,
  error: null,
  videos: [],
  audioOnly: false,
  audioOnlySuggested: false,
});

const GONE_STATUSES = new Set([403, 404]);

/** A start the dialog asked for that cannot begin now (another call is connecting, or the person is already in this one): its message is for the person. */
export class CallBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallBusyError';
  }
}

export class CallController {
  private state: CallState;
  private readonly listeners = new Set<() => void>();
  private hooks: CallHooks = { openChat: () => undefined };
  private adapter: MediaAdapter | null = null;
  /** Turn the camera on once connected: the person started this video call from the dialog. */
  private cameraOnJoin = false;
  private engine: TranscribeEngine | null = null;
  private engineMode: EnginePlan = 'none';
  private engineChain: Promise<void> = Promise.resolve();
  private join: MeetingJoin | null = null;
  private heartbeat: unknown = null;
  private renew: unknown = null;
  private poll: unknown = null;
  private rejoinTimer: unknown = null;
  private micOpen = false;
  private micChain: Promise<void> = Promise.resolve();
  private leaving = false;
  private wasMutedBeforeDeafen = false;
  private generation = 0;
  private lastPresent: string[] | null = null;
  private refreshing: Promise<void> | null = null;
  /** A refresh was asked for while one was running: the running one may have read the room before the change that asked, so it runs once more. */
  private refreshAgain = false;
  private sentConsent = false;
  /** Counts the person's consent answers (once as one leaves, once as the server's reply comes back): a room read that spans one may not have seen it. */
  private answerEpoch = 0;
  /** This person's connection as the media library last judged it, and whether they said "Not now" to audio only in this call (P17-01). */
  private quality: ConnectionQuality = 'unknown';
  private audioOnlyDismissed = false;

  constructor(private readonly deps: CallDeps) {
    this.state = IDLE(deps.prefs);
  }

  // ---- reading --------------------------------------------------------------------------------------------------------------------------------
  getState = (): CallState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  setHooks(hooks: CallHooks): void {
    this.hooks = hooks;
  }
  /** Who the person is in rooms (their actor id); needed to tell "me" in the roster. Set once the session is known. */
  setSelf(actorId: string | null): void {
    if (this.state.myActorId === actorId) return;
    this.set({ myActorId: actorId });
  }
  /** The start dialog has asked the server and is waiting: no other start or join begins meanwhile. */
  private dialogStarting = false;

  get active(): boolean {
    const p = this.state.phase;
    return p === 'connecting' || p === 'connected' || p === 'reconnecting' || p === 'lost' || p === 'starting';
  }
  /** The room the person is in (or getting into), by id. */
  get meetingId(): string | null {
    return this.state.meeting?.id ?? null;
  }

  private set(patch: Partial<CallState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }

  // ---- starting and joining ---------------------------------------------------------------------------------------------------------------------
  /** "Start voice room" / "Call": opens the channel's room or joins the one that is live. */
  async start(channelId: string): Promise<void> {
    if (this.dialogStarting || this.state.phase === 'starting' || this.state.phase === 'connecting') return;
    if (this.state.meeting && this.state.meeting.channelId === channelId && this.active) return;
    await this.teardownForNewRoom();
    const gen = ++this.generation;
    this.set({ ...IDLE(this.state.prefs), myActorId: this.state.myActorId, phase: 'starting', channelId });
    try {
      const res = await this.deps.api.start(channelId);
      if (gen !== this.generation) return;
      await this.enter(res.meeting, res.join, gen);
    } catch (e) {
      if (gen !== this.generation) return;
      this.failStart(e, channelId);
    }
  }

  /**
   * The start dialog's Start call (P15-25): like `start`, with the dialog's body (title, invitees, note-taker). The call the person is in now is kept until the
   * server has answered: a refused start leaves them where they were, and the refusal is thrown back to the dialog, which shows it and stays open. Only after a
   * successful answer is the old call left and the new one entered (the call bar takes over while the media connects). While another start or join is under way,
   * or when the person is already in this channel's call, it throws a `CallBusyError` with words the dialog shows.
   */
  /** A meeting the server has just opened with its call (P36-03): leave the call the person was in and enter this one, the camera on for a video meeting. */
  async enterOpened(res: StartMeetingResponse): Promise<void> {
    if (this.dialogStarting || this.state.phase === 'starting' || this.state.phase === 'connecting') throw new CallBusyError('A call is still connecting. Wait for it, then try again.');
    await this.teardownForNewRoom();
    this.cameraOnJoin = res.meeting.kind === 'video';
    const gen = ++this.generation;
    this.set({ ...IDLE(this.state.prefs), myActorId: this.state.myActorId, phase: 'starting', channelId: res.meeting.channelId });
    void this.enter(res.meeting, res.join, gen).catch(() => undefined);
  }

  async startFromDialog(channelId: string, body: StartMeetingRequest): Promise<StartMeetingResponse> {
    if (this.dialogStarting || this.state.phase === 'starting' || this.state.phase === 'connecting') throw new CallBusyError('A call is still connecting. Wait for it, then try again.');
    if (this.state.meeting && this.state.meeting.channelId === channelId && this.active) throw new CallBusyError('You are already in the call here.');
    this.dialogStarting = true;
    let res: StartMeetingResponse;
    try {
      res = await this.deps.api.start(channelId, body);
    } finally {
      this.dialogStarting = false;
    }
    // no other start or join could begin while the server was answering (`dialogStarting`): only now is the call the person was in left
    await this.teardownForNewRoom();
    // the person who starts a video call is in it with their camera on; whoever joins it later turns theirs on when they want (P36-02)
    this.cameraOnJoin = res.created && res.meeting.kind === 'video';
    const gen = ++this.generation;
    this.set({ ...IDLE(this.state.prefs), myActorId: this.state.myActorId, phase: 'starting', channelId });
    void this.enter(res.meeting, res.join, gen).catch(() => undefined);
    return res;
  }

  /** Joins a room that is already live (a badge in the sidebar, an incoming call). */
  async joinRoom(meetingId: string, channelId: string | null = null): Promise<void> {
    if (this.state.meeting?.id === meetingId && this.active) return;
    if (this.dialogStarting || this.state.phase === 'starting' || this.state.phase === 'connecting') return;
    await this.teardownForNewRoom();
    const gen = ++this.generation;
    this.set({ ...IDLE(this.state.prefs), myActorId: this.state.myActorId, phase: 'starting', channelId });
    try {
      const res = await this.deps.api.join(meetingId);
      if (gen !== this.generation) return;
      await this.enter(res.meeting, res.join, gen);
    } catch (e) {
      if (gen !== this.generation) return;
      this.failStart(e, channelId);
    }
  }

  /** After "lost": come back into the same room. */
  async rejoin(): Promise<void> {
    const m = this.state.meeting;
    if (!m) return;
    this.clearRejoin();
    this.set({ phase: 'reconnecting', notice: 'Reconnecting…', error: null });
    await this.reconnect(this.generation, 0);
  }

  private failStart(e: unknown, channelId: string | null): void {
    if (isNotConfigured(e)) {
      this.set({ phase: 'not-set-up', channelId, error: e instanceof Error ? e.message : null, notice: null });
      return;
    }
    this.set({ phase: 'failed', channelId, error: startFailure(e), notice: null });
  }

  private async teardownForNewRoom(): Promise<void> {
    if (this.state.meeting && (this.active || this.state.phase === 'lost')) await this.leave();
    else this.set(IDLE(this.state.prefs));
  }

  private async enter(meeting: Meeting, join: MeetingJoin, gen: number): Promise<void> {
    this.leaving = false;
    this.quality = 'unknown';
    this.audioOnlyDismissed = false;
    this.join = join;
    this.sentConsent = false;
    this.lastPresent = null;
    this.set({ meeting, channelId: meeting.channelId, myActorId: join.identity, phase: 'connecting', error: null, notice: null });
    let adapter: MediaAdapter;
    try {
      adapter = await this.deps.loadAdapter(join.provider);
      if (gen !== this.generation) return;
      await adapter.connect(join, { ...AUDIO_DEFAULTS, inputId: this.state.prefs.inputId, outputId: this.state.prefs.outputId }, this.eventsFor(gen), { receiveVideo: !this.state.audioOnly });
    } catch (e) {
      if (gen !== this.generation) return;
      // we told the server we joined; take that back so the room does not count a person who never got in
      void this.deps.api.leave(meeting.id).catch(() => undefined);
      this.join = null;
      this.set({ phase: 'failed', error: e instanceof Error && e.message !== '' ? `Could not connect to the voice server. ${e.message}` : 'Could not connect to the voice server.', notice: null });
      return;
    }
    if (gen !== this.generation) {
      void adapter.disconnect();
      return;
    }
    this.adapter = adapter;
    adapter.setDeafened(this.state.deafened);
    this.set({ phase: 'connected' });
    this.deps.sounds.play('join');
    this.startTimers(gen);
    if (meeting.threadRootId) this.hooks.openChat(meeting.threadRootId, meeting.channelId, { automatic: true });
    await this.refresh();
    if (gen !== this.generation) return;
    await this.applyConsentAndMic();
    void this.refreshDevices();
    if (this.cameraOnJoin && gen === this.generation) {
      this.cameraOnJoin = false;
      await this.toggleCamera();
    }
  }

  private eventsFor(gen: number): AdapterEvents {
    return {
      connection: (c: Connection) => {
        if (gen !== this.generation || this.leaving) return;
        if (c === 'reconnecting') this.set({ phase: 'reconnecting', notice: 'Reconnecting…' });
        else if (c === 'connected') {
          if (this.state.phase === 'reconnecting') {
            this.set({ phase: 'connected', notice: null });
            void this.refresh();
          }
        } else if (c === 'disconnected') {
          // the library gave up: renew the token and connect again ourselves
          this.set({ phase: 'reconnecting', notice: 'Reconnecting…' });
          void this.reconnect(gen, 0);
        }
      },
      speakers: (ids) => {
        if (gen !== this.generation) return;
        this.set({ speaking: new Set(ids) });
      },
      devices: () => void this.refreshDevices(),
      videos: (tiles) => {
        if (gen !== this.generation) return;
        this.set({ videos: tiles });
        this.judgeAudioOnly();
      },
      quality: (q) => {
        if (gen !== this.generation) return;
        this.quality = q;
        this.judgeAudioOnly();
      },
      micFailed: () => {
        if (gen !== this.generation) return;
        this.micOpen = false;
        this.set({ muted: true, notice: 'Your microphone is blocked. Allow it in your browser’s address bar, then press the microphone button.' });
      },
    };
  }

  // ---- timers: heartbeat, token, the room's roster ------------------------------------------------------------------------------------------------
  private startTimers(gen: number): void {
    this.stopTimers();
    this.heartbeat = this.deps.setInterval(() => void this.beat(gen), HEARTBEAT_EVERY_MS);
    this.poll = this.deps.setInterval(() => void this.refresh(), LIVE_POLL_MS);
    this.scheduleRenew(gen);
  }
  private stopTimers(): void {
    for (const h of [this.heartbeat, this.poll]) if (h !== null) this.deps.clearInterval(h);
    if (this.renew !== null) this.deps.clearTimeout(this.renew);
    this.heartbeat = this.poll = this.renew = null;
  }

  private scheduleRenew(gen: number): void {
    if (this.renew !== null) this.deps.clearTimeout(this.renew);
    if (!this.join) return;
    this.renew = this.deps.setTimeout(() => void this.renewToken(gen), renewDelay(this.join.expiresAt, this.deps.now()));
  }

  private async renewToken(gen: number): Promise<void> {
    const m = this.state.meeting;
    if (!m || gen !== this.generation || this.leaving) return;
    try {
      const res = await this.deps.api.renew(m.id);
      if (gen !== this.generation) return;
      this.join = res.join;
      this.scheduleRenew(gen);
    } catch (e) {
      if (gen !== this.generation) return;
      if (isApiError(e) && (GONE_STATUSES.has(e.status) || e.status === 409)) this.gone('You are no longer in this voice room.');
      else this.renew = this.deps.setTimeout(() => void this.renewToken(gen), 10_000);
    }
  }

  private async beat(gen: number): Promise<void> {
    const m = this.state.meeting;
    if (!m || gen !== this.generation || this.leaving || this.state.phase === 'lost') return;
    const speaking = this.state.myActorId !== null && this.state.speaking.has(this.state.myActorId);
    try {
      await this.deps.api.heartbeat(m.id, speaking);
    } catch (e) {
      if (gen !== this.generation) return;
      if (isApiError(e) && (GONE_STATUSES.has(e.status) || e.status === 409)) this.gone('You are no longer in this voice room.');
    }
  }

  /** The server says the person is not in the room (or it ended): leave on this side too, and say why. */
  private gone(notice: string): void {
    void this.teardown(notice);
  }

  /** Asks the server for the people in the room and the transcription now. */
  async refresh(): Promise<void> {
    const m = this.state.meeting;
    if (!m) return;
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    const gen = this.generation;
    const run = async (): Promise<void> => {
      try {
        const epoch = this.answerEpoch;
        const [sum, tr, nts, rec] = await Promise.all([
          this.deps.api.get(m.id),
          this.deps.api.transcription(m.id).catch(() => null),
          // a server without a note-taker or recording answers 404 or 501: those parts of the bar simply do not show
          this.deps.room.notetakers(m.id).catch(() => null),
          this.deps.room.recording(m.id).catch(() => null),
        ]);
        if (gen !== this.generation) return;
        if (epoch !== this.answerEpoch) {
          // the person answered while this was being read: it may show the old answer (and ask the question again). Read once more instead of using it.
          this.refreshAgain = true;
          return;
        }
        if (sum.meeting.state === 'ended') {
          this.gone('The voice room has ended.');
          return;
        }
        const ids = sum.present.map((p) => p.actorId);
        if (this.lastPresent) {
          const ch = presenceChange(this.lastPresent, ids, this.state.myActorId);
          if (ch.joined.length > 0) this.deps.sounds.play('join');
          else if (ch.left.length > 0) this.deps.sounds.play('leave');
        }
        this.lastPresent = ids;
        const mine = sum.present.find((p) => p.actorId === this.state.myActorId)?.consentTranscribe ?? 'unasked';
        this.set({
          meeting: sum.meeting,
          present: sum.present,
          transcription: tr ?? this.state.transcription,
          consent: planConsent(tr ?? this.state.transcription, mine, this.state.prefs.transcribeDefault, writtenOnServer(tr ?? this.state.transcription, (nts ?? this.state.notetakers)?.current != null)),
          notetakers: nts ?? this.state.notetakers,
          recording: rec ?? this.state.recording,
          recordConsent: planRecordConsent(rec ?? this.state.recording),
        });
        if (this.state.phase === 'connected') await this.applyConsentAndMic();
      } catch (e) {
        if (gen !== this.generation) return;
        if (isApiError(e) && GONE_STATUSES.has(e.status)) this.gone('You are no longer in this voice room.');
      }
    };
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        await run();
      } while (this.refreshAgain && gen === this.generation);
    })().finally(() => {
      this.refreshing = null;
      this.refreshAgain = false;
    });
    return this.refreshing;
  }

  /** A push said this room changed. */
  noteChanged(meetingId: string): void {
    if (this.state.meeting?.id === meetingId) void this.refresh();
  }

  // ---- getting back after a drop ---------------------------------------------------------------------------------------------------------------------------
  private clearRejoin(): void {
    if (this.rejoinTimer !== null) this.deps.clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
  }

  private async reconnect(gen: number, attempt: number): Promise<void> {
    if (gen !== this.generation || this.leaving) return;
    const m = this.state.meeting;
    if (!m) return;
    if (attempt >= REJOIN_ATTEMPTS) {
      this.micOpen = false;
      // out of the room, nobody is listening to this person: their own microphone and transcription stop too (Rejoin starts them again)
      this.stopEngine();
      this.set({ phase: 'lost', engine: { kind: 'off' }, notice: 'Lost the connection to the voice room.' });
      return;
    }
    this.clearRejoin();
    await new Promise<void>((resolve) => {
      this.rejoinTimer = this.deps.setTimeout(resolve, attempt === 0 ? 0 : rejoinDelay(attempt - 1));
    });
    if (gen !== this.generation || this.leaving) return;
    try {
      const res = await this.deps.api.renew(m.id);
      if (gen !== this.generation) return;
      this.join = res.join;
      const old = this.adapter;
      this.adapter = null;
      this.micOpen = false;
      // a camera and a shared screen do not come back by themselves after a new connection: the person turns them on again
      this.set({ videos: [] });
      // the new connection is judged afresh
      this.quality = 'unknown';
      if (this.state.audioOnlySuggested) this.set({ audioOnlySuggested: false });
      await old?.disconnect().catch(() => undefined);
      const adapter = await this.deps.loadAdapter(res.join.provider);
      await adapter.connect(res.join, { ...AUDIO_DEFAULTS, inputId: this.state.prefs.inputId, outputId: this.state.prefs.outputId }, this.eventsFor(gen), { receiveVideo: !this.state.audioOnly });
      if (gen !== this.generation) {
        void adapter.disconnect();
        return;
      }
      this.adapter = adapter;
      adapter.setDeafened(this.state.deafened);
      this.set({ phase: 'connected', notice: null });
      this.scheduleRenew(gen);
      await this.refresh();
      await this.applyConsentAndMic();
    } catch (e) {
      if (gen !== this.generation) return;
      if (isApiError(e) && (GONE_STATUSES.has(e.status) || e.status === 409)) {
        this.gone('You are no longer in this voice room.');
        return;
      }
      await this.reconnect(gen, attempt + 1);
    }
  }

  // ---- the microphone ----------------------------------------------------------------------------------------------------------------------------------
  /** Should the microphone be open right now? */
  private wantMic(): boolean {
    const s = this.state;
    if (s.phase !== 'connected') return false;
    if (s.muted || s.deafened) return false;
    if (!micMayOpen(s.consent)) return false;
    if (s.pushToTalk && !s.talking) return false;
    return true;
  }

  private syncMic(): Promise<void> {
    this.micChain = this.micChain.then(async () => {
      const want = this.wantMic();
      const adapter = this.adapter;
      if (!adapter || want === this.micOpen) return;
      try {
        await adapter.setMic(want);
        this.micOpen = want;
      } catch {
        // the adapter has already told us through `micFailed`
        this.micOpen = false;
      }
    });
    return this.micChain.then(() => this.engine?.setMuted?.(!this.wantMic()));
  }

  /** Decides whether the person must answer the consent question first, sends their saved default, and then opens the microphone. */
  private async applyConsentAndMic(): Promise<void> {
    const gen = this.generation;
    const plan = this.state.consent;
    this.set({ waitingForConsent: plan.kind === 'ask' });
    if (plan.kind === 'apply' && !this.sentConsent) {
      this.sentConsent = true;
      try {
        await this.answerConsent(plan.answer, { remember: false });
      } catch {
        this.sentConsent = false;
      }
      if (gen !== this.generation) return;
    }
    await this.syncMic();
    await this.syncEngine();
  }

  /** Starts, switches or stops this person's own transcription engine so that it matches the room: on, said yes, and no note-taker listening on the server instead. */
  private syncEngine(): Promise<void> {
    this.engineChain = this.engineChain.then(() => this.runEngineSync()).catch(() => undefined);
    return this.engineChain;
  }

  private wantedEngine(): EnginePlan {
    const s = this.state;
    if (s.phase !== 'connected') return 'none';
    const mine = s.present.find((p) => p.actorId === s.myActorId)?.consentTranscribe;
    return enginePlan(s.transcription, mine, s.notetakers?.current != null);
  }

  private engineUi(status: StreamStatus): EngineUi {
    switch (status.kind) {
      case 'listening':
        return { kind: 'listening' };
      case 'loading':
        return { kind: 'loading', fraction: status.fraction };
      case 'too_slow':
        return { kind: 'too_slow', message: status.message };
      case 'failed':
        return { kind: 'failed', message: status.message };
      default:
        return { kind: 'off' };
    }
  }

  /** `discard`: the person took their yes back, so anything heard but not yet sent is thrown away instead of sent. */
  private stopEngine(discard = false): void {
    this.engine?.stop(discard ? { discard: true } : undefined);
    this.engine = null;
    this.engineMode = 'none';
  }

  private async runEngineSync(): Promise<void> {
    const gen = this.generation;
    const want = this.wantedEngine();
    if (want === this.engineMode) return;
    if (this.engine) {
      const s = this.state;
      // the engine stops because the answer is no, or asked for again: what it heard but did not send yet is not sent
      this.stopEngine(s.present.find((p) => p.actorId === s.myActorId)?.consentTranscribe !== 'yes');
      this.set({ engine: { kind: 'off' } });
    }
    if (want === 'none') return;
    const engine = await this.deps.loadEngine(want);
    // the room moved on while the engine was loading: this one is not wanted any more
    if (gen !== this.generation || this.wantedEngine() !== want) {
      engine?.stop();
      return;
    }
    if (!engine) {
      this.set({ engine: { kind: 'failed', message: 'This browser cannot write down speech. Ask for server transcription, or join without it.' } });
      return;
    }
    this.engine = engine;
    this.engineMode = want;
    this.set({ engine: { kind: 'loading', fraction: 0 } });
    const m = this.state.meeting;
    if (!m) return;
    try {
      engine.start({
        meetingId: m.id,
        startedAt: m.startedAt,
        inputId: this.state.prefs.inputId,
        onStatus: (status) => {
          if (gen === this.generation && this.engine === engine) this.set({ engine: this.engineUi(status) });
        },
      });
      engine.setMuted?.(!this.wantMic());
    } catch {
      this.set({ engine: { kind: 'failed', message: 'Could not start transcription. Try again.' } });
    }
  }

  /** This device is too slow: move the room to server transcription (everybody is asked again, since their speech then goes to the server). */
  async switchToServer(): Promise<void> {
    const m = this.state.meeting;
    if (!m || !canOfferServer(this.state.transcription)) return;
    this.sentConsent = false;
    try {
      await this.deps.api.setTranscription(m.id, 'off');
      const next = await this.deps.api.setTranscription(m.id, 'server');
      this.set({ transcription: next, notice: null });
    } catch (e) {
      this.set({ notice: changeFailure(e, 'switch transcription to the server') });
    }
    await this.refresh();
  }

  /** "Join without it": the person says no to being transcribed, which stops their engine and shows them as "spoke (not transcribed)". */
  async joinWithoutTranscription(): Promise<void> {
    try {
      await this.answerConsent('no', { remember: false });
    } catch {
      this.set({ notice: 'Could not save your answer. Try again.' });
    }
  }

  // ---- camera and screen (P35-08) -------------------------------------------------------------------------------------------------------------------
  async toggleCamera(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter || this.state.phase !== 'connected') return;
    const { cameraOn } = videoState(this.state.videos);
    if (!cameraOn && this.state.audioOnly) {
      this.set({ notice: 'Audio only is on. Turn it off to use your camera.' });
      return;
    }
    try {
      await adapter.setCamera(!cameraOn);
    } catch {
      this.set({ notice: 'Your camera could not be opened: allow it in your browser’s address bar, or close the app that is using it.' });
    }
  }

  /** Shares a screen, or stops sharing. Only one person shares at a time: while someone else does, the page says who instead. */
  async toggleScreen(): Promise<void> {
    const adapter = this.adapter;
    if (!adapter || this.state.phase !== 'connected') return;
    const { screenOn, otherSharer } = videoState(this.state.videos);
    if (!screenOn && otherSharer) {
      const name = this.state.present.find((p) => p.actorId === otherSharer)?.displayName ?? 'Someone';
      this.set({ notice: `${name} is sharing their screen. Ask them to stop first: one screen is shared at a time.` });
      return;
    }
    try {
      await adapter.setScreen(!screenOn);
    } catch (e) {
      // the person closed the browser's picker: nothing to say
      if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return;
      this.set({ notice: 'Your screen could not be shared. Try again, or pick a single window or tab.' });
    }
  }

  // ---- audio only (P17-01) -------------------------------------------------------------------------------------------------------------------------
  /** Audio only on: other people's video stops coming in and this person's camera goes off. Off: their video comes in again (the camera stays off until turned on). */
  async setAudioOnly(on: boolean): Promise<void> {
    if (this.state.audioOnly === on) return;
    // turning it off again is an answer too: the suggestion is not offered again in this call
    if (!on) this.audioOnlyDismissed = true;
    this.set({ audioOnly: on, audioOnlySuggested: false, notice: !on && this.state.notice?.startsWith('Audio only is on') ? null : this.state.notice });
    const adapter = this.adapter;
    if (!adapter) return;
    adapter.setReceiveVideo(!on);
    if (on && videoState(this.state.videos).cameraOn) await adapter.setCamera(false).catch(() => undefined);
  }

  /** "Not now" on the suggestion: it is not offered again in this call. */
  dismissAudioOnly(): void {
    this.audioOnlyDismissed = true;
    if (this.state.audioOnlySuggested) this.set({ audioOnlySuggested: false });
  }

  private judgeAudioOnly(): void {
    const next = suggestAudioOnly({ quality: this.quality, audioOnly: this.state.audioOnly, dismissed: this.audioOnlyDismissed, videoCount: this.state.videos.length });
    if (next !== this.state.audioOnlySuggested) this.set({ audioOnlySuggested: next });
  }

  /** Draws a camera or a screen in a `<video>`; the returned function takes it off. Nothing happens outside a room. */
  attachVideo(key: string, el: HTMLVideoElement): () => void {
    return this.adapter?.attachVideo(key, el) ?? (() => undefined);
  }

  toggleMute(): void {
    if (this.state.phase !== 'connected' && this.state.phase !== 'reconnecting') return;
    if (this.state.deafened) {
      // unmuting while deafened also hears again
      this.setDeafened(false);
      return;
    }
    const muted = !this.state.muted;
    this.set({ muted, notice: muted ? this.state.notice : this.state.notice?.startsWith('Your microphone is blocked') ? null : this.state.notice });
    this.deps.sounds.play(muted ? 'mute' : 'unmute');
    void this.syncMic();
  }

  setDeafened(on: boolean): void {
    if (this.state.deafened === on) return;
    if (on) {
      this.wasMutedBeforeDeafen = this.state.muted;
      this.set({ deafened: true, muted: true });
    } else {
      this.set({ deafened: false, muted: this.wasMutedBeforeDeafen });
    }
    this.adapter?.setDeafened(on);
    void this.syncMic();
  }
  toggleDeafen(): void {
    this.setDeafened(!this.state.deafened);
  }

  setPushToTalk(on: boolean): void {
    const prefs = { ...this.state.prefs, pushToTalk: on };
    savePrefs(this.deps.storage, prefs);
    this.set({ pushToTalk: on, talking: false, prefs });
    void this.syncMic();
  }
  /** The push-to-talk key or button went down (true) or up (false). */
  talk(down: boolean): void {
    if (!this.state.pushToTalk || this.state.talking === down) return;
    this.set({ talking: down });
    void this.syncMic();
  }

  async pickInput(id: string): Promise<void> {
    const prefs = { ...this.state.prefs, inputId: id };
    savePrefs(this.deps.storage, prefs);
    this.set({ prefs });
    try {
      await this.adapter?.useInput(id);
    } catch {
      this.set({ notice: 'Could not switch to that microphone.' });
    }
    await this.refreshDevices();
  }
  async pickOutput(id: string): Promise<void> {
    const prefs = { ...this.state.prefs, outputId: id };
    savePrefs(this.deps.storage, prefs);
    this.set({ prefs });
    try {
      await this.adapter?.useOutput(id);
    } catch {
      this.set({ notice: 'Could not switch to that speaker.' });
    }
    await this.refreshDevices();
  }
  async refreshDevices(): Promise<void> {
    const a = this.adapter;
    if (!a) return;
    try {
      this.set({ devices: await a.devices() });
    } catch {
      /* the list stays as it was */
    }
  }

  /** Says a plain sentence above the controls (why a button does nothing). */
  notify(text: string): void {
    this.set({ notice: text });
  }

  setCaptions(on: boolean): void {
    const prefs = { ...this.state.prefs, captions: on };
    savePrefs(this.deps.storage, prefs);
    this.set({ prefs });
  }
  setSounds(on: boolean): void {
    const prefs = { ...this.state.prefs, sounds: on };
    savePrefs(this.deps.storage, prefs);
    this.set({ prefs });
  }
  /** The video layout (P17-01), kept with the other call choices. */
  setLayout(layout: StageLayout): void {
    const prefs = { ...this.state.prefs, layout };
    savePrefs(this.deps.storage, prefs);
    this.set({ prefs });
  }
  /** Picture-in-picture when the tab is left (P17-01). */
  setPip(on: boolean): void {
    const prefs = { ...this.state.prefs, pip: on };
    savePrefs(this.deps.storage, prefs);
    this.set({ prefs });
  }

  // ---- consent and transcription ----------------------------------------------------------------------------------------------------------------
  /** The person's answer to "Transcribe my voice". `remember` keeps it as their personal default (they can change it in the call bar). */
  async answerConsent(answer: 'yes' | 'no', opts: { remember: boolean }): Promise<void> {
    const m = this.state.meeting;
    if (!m) return;
    if (opts.remember) this.saveDefault(answer);
    // a no takes effect on this device first: nothing more is heard or sent while the answer travels to the server (if it fails, the next refresh starts the engine again)
    if (answer === 'no' && this.engine) {
      this.stopEngine(true);
      this.set({ engine: { kind: 'off' } });
    }
    this.answerEpoch += 1;
    const res = await this.deps.api.consent(m.id, answer);
    this.answerEpoch += 1;
    const present = this.state.present.map((p) => (p.actorId === res.participant.actorId ? res.participant : p));
    const consent = planConsent(this.state.transcription, res.participant.consentTranscribe as MeetingConsent, this.state.prefs.transcribeDefault, writtenOnServer(this.state.transcription, this.state.notetakers?.current != null));
    this.set({ present, consent, waitingForConsent: consent.kind === 'ask' });
    await this.syncMic();
    await this.syncEngine();
  }

  /** The saved personal default: `ask` clears it. */
  saveDefault(value: 'ask' | 'yes' | 'no'): void {
    const prefs = { ...this.state.prefs, transcribeDefault: value };
    savePrefs(this.deps.storage, prefs);
    this.set({ prefs });
  }

  async turnTranscription(mode: 'on_device' | 'server' | 'off'): Promise<void> {
    const m = this.state.meeting;
    if (!m) return;
    this.sentConsent = false;
    try {
      const next = await this.deps.api.setTranscription(m.id, mode);
      this.set({ transcription: next, notice: null });
    } catch (e) {
      this.set({ notice: isApiError(e) ? e.message : 'Could not change transcription. Try again.' });
      return;
    }
    await this.refresh();
  }

  // ---- captions and the transcript so far ------------------------------------------------------------------------------------------------------
  /** Captions came in over the socket for this room. */
  noteCaptions(meetingId: string, captions: readonly MeetingCaption[]): void {
    if (this.state.meeting?.id !== meetingId || !this.active) return;
    const next = mergeCaptions(this.state.captions, captions, this.deps.now());
    if (next.length === 0 && this.state.captions.length === 0) return;
    this.set({ captions: next });
  }

  /** Reads the lines stored so far (the captions history). */
  async loadHistory(): Promise<void> {
    const m = this.state.meeting;
    if (!m) return;
    const gen = this.generation;
    this.set({ history: { status: 'loading', lines: this.state.history.lines } });
    try {
      const res = await this.deps.room.transcript(m.id);
      if (gen !== this.generation) return;
      this.set({ history: { status: 'ok', lines: res.lines } });
    } catch {
      if (gen !== this.generation) return;
      this.set({ history: { status: 'failed', lines: this.state.history.lines } });
    }
  }

  /** The speaker corrects their own line (for 24 hours). Throws the server's refusal so the line's editor can say why. */
  async correctLine(segmentId: string, text: string): Promise<void> {
    const m = this.state.meeting;
    if (!m) return;
    const res = await this.deps.room.correct(m.id, segmentId, text);
    this.set({ history: { ...this.state.history, lines: this.state.history.lines.map((l) => (l.segmentId === segmentId ? res.line : l)) } });
  }

  // ---- the note-taker (P15-18) -------------------------------------------------------------------------------------------------------------------
  /** Anyone in the room may add a note-taker; everybody is asked again, and transcription moves to the server. */
  async addNotetaker(botId: string): Promise<void> {
    const m = this.state.meeting;
    if (!m) return;
    try {
      await this.deps.room.addNotetaker(m.id, botId);
    } catch (e) {
      this.set({ notice: changeFailure(e, 'add the note-taker') });
      return;
    }
    this.set({ notice: null });
    this.sentConsent = false;
    await this.refresh();
  }

  /** The organizer or a lead takes the note-taker out. */
  async removeNotetaker(): Promise<void> {
    const m = this.state.meeting;
    if (!m) return;
    try {
      await this.deps.room.removeNotetaker(m.id);
    } catch (e) {
      this.set({ notice: isApiError(e) && e.status === 403 ? 'Only the person who started the call or a team lead can take the note-taker out.' : changeFailure(e, 'take the note-taker out') });
      return;
    }
    this.set({ notice: null });
    await this.refresh();
  }

  // ---- recording (P15-15) --------------------------------------------------------------------------------------------------------------------------
  async setRecording(on: boolean): Promise<void> {
    const m = this.state.meeting;
    if (!m) return;
    try {
      const rec = await this.deps.room.setRecording(m.id, on);
      this.set({ recording: rec, recordConsent: planRecordConsent(rec), notice: null });
    } catch (e) {
      this.set({ notice: changeFailure(e, on ? 'turn recording on' : 'turn recording off') });
    }
  }

  /** The person's own answer to "Record my voice". No also stops their file at once. */
  async answerRecordConsent(answer: 'yes' | 'no'): Promise<void> {
    const m = this.state.meeting;
    if (!m) return;
    const rec = await this.deps.room.recordConsent(m.id, answer);
    this.set({ recording: rec, recordConsent: planRecordConsent(rec) });
    void this.refresh();
  }

  // ---- chat ---------------------------------------------------------------------------------------------------------------------------------------
  /** A message was posted in the call's thread by someone else. */
  noteChatMessage(): void {
    if (!this.state.chatOpen) this.set({ chatUnread: this.state.chatUnread + 1 });
  }
  setChatOpen(open: boolean): void {
    if (this.state.chatOpen === open && (!open || this.state.chatUnread === 0)) return;
    this.set({ chatOpen: open, chatUnread: open ? 0 : this.state.chatUnread });
  }
  openChat(): void {
    const m = this.state.meeting;
    if (m?.threadRootId) this.hooks.openChat(m.threadRootId, m.channelId);
  }

  // ---- leaving ---------------------------------------------------------------------------------------------------------------------------------------
  /** "Leave": goes out of the room (it stays open for the others). */
  async leave(): Promise<void> {
    const m = this.state.meeting;
    await this.teardown(null);
    if (m) await this.deps.api.leave(m.id).catch(() => undefined);
  }

  /** Closes the room for everyone (the starter, a lead or an admin). */
  async endForAll(): Promise<void> {
    const m = this.state.meeting;
    if (!m) return;
    try {
      await this.deps.api.end(m.id);
    } catch (e) {
      this.set({ notice: isApiError(e) && e.status === 403 ? 'Only the person who started the room, a team lead or an admin can end it for everyone.' : 'Could not end the voice room. Try again.' });
      return;
    }
    await this.teardown('The voice room has ended.');
  }

  /** Dismisses the "not set up" / "failed" / "lost" card. */
  dismiss(): void {
    if (this.state.phase === 'lost') {
      void this.leave();
      return;
    }
    if (this.state.phase === 'not-set-up' || this.state.phase === 'failed' || this.state.phase === 'idle') this.set(IDLE(this.state.prefs));
    else this.set({ notice: null });
  }

  private async teardown(notice: string | null): Promise<void> {
    this.leaving = true;
    this.generation++;
    this.stopTimers();
    this.clearRejoin();
    this.stopEngine();
    const adapter = this.adapter;
    this.adapter = null;
    this.micOpen = false;
    this.join = null;
    this.lastPresent = null;
    const was = this.state.meeting !== null;
    this.set({ ...IDLE(this.state.prefs), myActorId: this.state.myActorId, notice });
    if (was) this.deps.sounds.play('leave');
    await adapter?.disconnect().catch(() => undefined);
    this.leaving = false;
  }
}

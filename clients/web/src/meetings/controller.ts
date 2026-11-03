import type { Meeting, MeetingConsent, MeetingJoin, MeetingParticipant, MeetingTranscriptionState } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { planConsent, micMayOpen, type ConsentPlan } from './consent';
import type { CallApi } from './api';
import type { TranscribeEngine } from './engine';
import { AUDIO_DEFAULTS, type AdapterEvents, type AdapterLoader, type Connection, type DeviceLists, type MediaAdapter } from './media';
import { HEARTBEAT_EVERY_MS, LIVE_POLL_MS, REJOIN_ATTEMPTS, isNotConfigured, presenceChange, rejoinDelay, renewDelay, startFailure } from './model';
import type { CallPrefs, KeyValue } from './prefs';
import { savePrefs } from './prefs';
import type { Sounds } from './sounds';

/*
 * The call (PLAN P15-04, P15-05): one room at a time per tab. This class is the whole story of being in a voice room: starting or joining it, connecting to the media
 * server, the heartbeat and the token renewal, mute / deafen / push-to-talk, the devices, getting back after a network drop, the consent answer that must come before
 * the microphone opens, and leaving. It knows nothing of React or of the media library: the server and the media layer are handed in, so a test drives every path.
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
  /** A plain sentence to show above the controls (reconnecting, microphone blocked, you were removed). Null when there is nothing to say. */
  notice: string | null;
  /** The server's or the library's plain words for why the last start or join failed. */
  error: string | null;
};

export type CallDeps = {
  api: CallApi;
  loadAdapter: AdapterLoader;
  sounds: Sounds;
  storage: KeyValue | null;
  prefs: CallPrefs;
  loadEngine: () => Promise<TranscribeEngine | null>;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
};

/** Things only the screen can do. */
export type CallHooks = {
  /** Open the call's chat thread in the right panel (when a person joins, and when they press Chat). */
  openChat(threadRootId: string, channelId: string | null): void;
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
  chatUnread: 0,
  chatOpen: false,
  notice: null,
  error: null,
});

const GONE_STATUSES = new Set([403, 404]);

export class CallController {
  private state: CallState;
  private readonly listeners = new Set<() => void>();
  private hooks: CallHooks = { openChat: () => undefined };
  private adapter: MediaAdapter | null = null;
  private engine: TranscribeEngine | null = null;
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
  private sentConsent = false;

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
    if (this.state.phase === 'starting' || this.state.phase === 'connecting') return;
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

  /** Joins a room that is already live (a badge in the sidebar, an incoming call). */
  async joinRoom(meetingId: string, channelId: string | null = null): Promise<void> {
    if (this.state.meeting?.id === meetingId && this.active) return;
    if (this.state.phase === 'starting' || this.state.phase === 'connecting') return;
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
    this.join = join;
    this.sentConsent = false;
    this.lastPresent = null;
    this.set({ meeting, channelId: meeting.channelId, myActorId: join.identity, phase: 'connecting', error: null, notice: null });
    let adapter: MediaAdapter;
    try {
      adapter = await this.deps.loadAdapter(join.provider);
      if (gen !== this.generation) return;
      await adapter.connect(join, { ...AUDIO_DEFAULTS, inputId: this.state.prefs.inputId, outputId: this.state.prefs.outputId }, this.eventsFor(gen));
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
    if (meeting.threadRootId) this.hooks.openChat(meeting.threadRootId, meeting.channelId);
    await this.refresh();
    if (gen !== this.generation) return;
    await this.applyConsentAndMic();
    void this.refreshDevices();
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
    if (this.refreshing) return this.refreshing;
    const gen = this.generation;
    const run = async (): Promise<void> => {
      try {
        const [sum, tr] = await Promise.all([this.deps.api.get(m.id), this.deps.api.transcription(m.id).catch(() => null)]);
        if (gen !== this.generation) return;
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
          consent: planConsent(tr ?? this.state.transcription, mine, this.state.prefs.transcribeDefault),
        });
        if (this.state.phase === 'connected') await this.applyConsentAndMic();
      } catch (e) {
        if (gen !== this.generation) return;
        if (isApiError(e) && GONE_STATUSES.has(e.status)) this.gone('You are no longer in this voice room.');
      }
    };
    this.refreshing = run().finally(() => {
      this.refreshing = null;
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
      this.set({ phase: 'lost', notice: 'Lost the connection to the voice room.' });
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
      await old?.disconnect().catch(() => undefined);
      const adapter = await this.deps.loadAdapter(res.join.provider);
      await adapter.connect(res.join, { ...AUDIO_DEFAULTS, inputId: this.state.prefs.inputId, outputId: this.state.prefs.outputId }, this.eventsFor(gen));
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
    return this.micChain;
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

  private async syncEngine(): Promise<void> {
    const s = this.state;
    const mine = s.present.find((p) => p.actorId === s.myActorId)?.consentTranscribe;
    const should = s.phase === 'connected' && s.transcription?.mode === 'on_device' && mine === 'yes';
    if (should && !this.engine) {
      this.engine = await this.deps.loadEngine();
      this.engine?.start();
    } else if (!should && this.engine) {
      this.engine.stop();
      this.engine = null;
    }
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

  // ---- consent and transcription ----------------------------------------------------------------------------------------------------------------
  /** The person's answer to "Transcribe my voice". `remember` keeps it as their personal default (they can change it in the call bar). */
  async answerConsent(answer: 'yes' | 'no', opts: { remember: boolean }): Promise<void> {
    const m = this.state.meeting;
    if (!m) return;
    if (opts.remember) this.saveDefault(answer);
    const res = await this.deps.api.consent(m.id, answer);
    const present = this.state.present.map((p) => (p.actorId === res.participant.actorId ? res.participant : p));
    const consent = planConsent(this.state.transcription, res.participant.consentTranscribe as MeetingConsent, this.state.prefs.transcribeDefault);
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
    this.engine?.stop();
    this.engine = null;
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

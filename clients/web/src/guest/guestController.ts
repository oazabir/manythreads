import {
  GUEST_POLL_IN_CALL_MS,
  GUEST_POLL_WAITING_MS,
  GUEST_WAIT_SECONDS,
  MEETING_GUEST_NAME_MAX,
  type GuestLinkPeekResponse,
  type GuestRoomPerson,
  type GuestSessionResponse,
  type GuestSessionState,
  type MeetingConsent,
  type MeetingTranscription,
  type PostMeetingSegmentsRequest,
} from '@manythreads/shared';
import { isApiError } from '../api/client';
import type { EngineUi } from '../meetings/consent';
import type { MeetingClock, StreamStatus, TranscribeEngine } from '../meetings/engine';
import { AUDIO_DEFAULTS, type AdapterLoader, type MediaAdapter, type VideoTile } from '../meetings/media';
import type { GuestApi } from './api';

/*
 * The guest page's controller (P17-04): someone outside the workspace opened a guest link. It knows nothing of sessions, channels or the member's call store
 * (`meetings/controller.ts`, `meetings/store.ts`); it talks to the guest routes and to the same media adapter the members use.
 *
 *   open the link -> the call's title and the workspace's name -> a name, a device check, Ask to join -> waiting (the page asks every 2 s)
 *     -> let in: the call opens (asked every 10 s, which is also its sign of life; a new token every 8 minutes; a lost media connection is joined again,
 *        with a growing pause, while the server still says the guest is let in)
 *     -> "The host did not let you in." / "The call has ended." / after 10 minutes "Nobody answered. Try again."
 *   in the call: "You were removed from the call." ends it (the credential is dead).
 *
 * Transcription (step 2): while the call is transcribed, the guest is asked "Transcribe my voice?" (the members' prompt, P15-05). Only a yes starts the on-device
 * engine, whose lines go to the guest's own route; a no stops it first and throws away what it heard but had not sent. The guest's words never go to the server as
 * sound. A guest who does not answer is never written down; their microphone stays as they set it.
 */

export type GuestPhase =
  | { kind: 'loading' }
  /** The link is unknown, expired, turned off or used up (one answer for all), or the page's credential is gone. */
  | { kind: 'gone' }
  | { kind: 'open'; peek: GuestLinkPeekResponse }
  | { kind: 'waiting'; title: string }
  | { kind: 'joining'; title: string }
  | { kind: 'in-call'; title: string }
  | { kind: 'denied' | 'ended' | 'removed' | 'nobody' | 'left'; title: string }
  | { kind: 'failed'; message: string };

export type GuestState = {
  phase: GuestPhase;
  /** What the guest typed; checked before the knock. */
  name: string;
  /** A plain sentence beside the form or the bar; null when there is nothing to say. */
  error: string | null;
  busy: boolean;
  micOn: boolean;
  cameraOn: boolean;
  /** The microphone chosen in the device check (null: the browser's default). */
  inputId: string | null;
  videos: readonly VideoTile[];
  speaking: ReadonlySet<string>;
  /** The names in the call (the people and the other guests), for the tiles. */
  people: readonly GuestRoomPerson[];
  /** True while the media connection is trying to get back. */
  reconnecting: boolean;
  /** The call's transcription as the server last said it, who turned it on, and the guest's own answer. */
  transcription: MeetingTranscription;
  turnedOnBy: string | null;
  consent: MeetingConsent;
  /** True while the guest's answer is on its way. */
  answering: boolean;
  /** What the guest's own transcription engine is doing. */
  engine: EngineUi;
};

export type GuestTimers = {
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
};

export type GuestDeps = GuestTimers & {
  api: GuestApi;
  loadAdapter: AdapterLoader;
  /** Takes the secret out of the address bar once the knock is in (`/join/g/`). */
  forgetAddress: () => void;
  /** The on-device engine and the call clock its lines are timed by; without it the page never transcribes (a yes is still sent). */
  engine?: GuestEngineDeps;
};

export type GuestEngineDeps = {
  /** An engine whose lines go through `post`; null when this browser cannot write down speech. */
  load: (post: (body: PostMeetingSegmentsRequest) => Promise<unknown>) => TranscribeEngine | null;
  /** A clock of the call (milliseconds since it started, on the server's clock). */
  clock: (startedAt: string) => MeetingClock;
};

export const RENEW_MS = 8 * 60_000;
/** The pauses between tries to get back into the call after the media connection was lost: 1, 2, 4, 8, 16 s, then every 30 s. */
export const REJOIN_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/** The words of each ending, as the page shows them. */
export const GUEST_WORDS = {
  gone: 'This guest link has expired or was turned off',
  goneHelp: 'Ask the person who sent it for a new link.',
  waiting: 'Waiting for the host to let you in…',
  denied: 'The host did not let you in.',
  ended: 'The call has ended.',
  removed: 'You were removed from the call.',
  nobody: 'Nobody answered. Try again.',
  left: 'You left the call.',
  transcribed: 'This call is being transcribed for the team. In the call you choose whether your own voice is written down; it is not unless you say yes.',
  notetaker: 'A note-taker is listening to this call for the team. It never writes down a guest’s voice.',
  /** In the call, while it is transcribed, before the guest answers. */
  promptTitle: 'Transcribe my voice?',
  promptBody: (by: string | null): string =>
    `${by ?? 'Someone'} turned on transcription for this call. If you say yes, your own device writes down what you say and your sound stays on it; the words are shown to the team as yours, marked as a guest. If you say no, or do not answer, your voice is not written down; the transcript only shows that you spoke, and when.`,
  yes: 'Yes, transcribe my voice',
  no: 'No, do not transcribe me',
  noEngine: 'This browser cannot write down speech, so your voice is not transcribed.',
} as const;

/** The name as it will be sent, or the reason it cannot be. */
export function checkName(name: string): { ok: true; name: string } | { ok: false; message: string } {
  const t = name.trim();
  if (t === '') return { ok: false, message: 'Write your name' };
  if ([...t].length > MEETING_GUEST_NAME_MAX) return { ok: false, message: `A name can have at most ${MEETING_GUEST_NAME_MAX} characters` };
  return { ok: true, name: t };
}

/** The page's ending for a state the server says, or null while the guest is still waiting or in. */
export function endingOf(state: GuestSessionState): 'denied' | 'ended' | 'removed' | 'nobody' | 'left' | null {
  switch (state) {
    case 'denied':
      return 'denied';
    case 'removed':
      return 'removed';
    case 'ended':
      return 'ended';
    case 'expired':
      return 'nobody';
    case 'left':
      return 'left';
    default:
      return null;
  }
}

const initial: GuestState = {
  phase: { kind: 'loading' },
  name: '',
  error: null,
  busy: false,
  micOn: true,
  cameraOn: false,
  inputId: null,
  videos: [],
  speaking: new Set(),
  people: [],
  reconnecting: false,
  transcription: 'off',
  turnedOnBy: null,
  consent: 'unasked',
  answering: false,
  engine: { kind: 'off' },
};

/** The status of the guest's engine as the page shows it. */
export function engineUiOf(s: StreamStatus): EngineUi {
  switch (s.kind) {
    case 'listening':
      return { kind: 'listening' };
    case 'loading':
      return { kind: 'loading', fraction: s.fraction };
    case 'too_slow':
      return { kind: 'too_slow', message: s.message };
    case 'failed':
      return { kind: 'failed', message: s.message };
    default:
      return { kind: 'off' };
  }
}

/** Whether to ask "Transcribe my voice?" now: in the call, while it is transcribed, before the guest answered. */
export const mustAsk = (s: Pick<GuestState, 'phase' | 'transcription' | 'consent'>): boolean => s.phase.kind === 'in-call' && s.transcription !== 'off' && s.consent === 'unasked';

export class GuestController {
  private state: GuestState = initial;
  private readonly listeners = new Set<() => void>();
  private token: string | null = null;
  private knockedAt = 0;
  private poll: unknown = null;
  private renew: unknown = null;
  private retry: unknown = null;
  private attempts = 0;
  private adapter: MediaAdapter | null = null;
  private title = '';
  /** Bumped on every ending, so an answer that arrives after it changes nothing. */
  private generation = 0;
  private engine: TranscribeEngine | null = null;
  /** This browser has no engine: asked once, not again. */
  private noEngine = false;
  private clock: MeetingClock | null = null;
  private clockStart: string | null = null;

  constructor(private readonly deps: GuestDeps) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = (): GuestState => this.state;

  private set(next: Partial<GuestState>): void {
    this.state = { ...this.state, ...next };
    for (const l of [...this.listeners]) l();
  }

  // ---- before the knock ------------------------------------------------------------------------------------------------------------------------------
  /** The page opened: with the link's secret, show the call; without it (the address was already cleaned), carry on with the cookie the knock left. */
  async open(token: string | null): Promise<void> {
    this.token = token;
    if (token === null) {
      await this.check();
      return;
    }
    try {
      const peek = await this.deps.api.peek(token);
      this.title = peek.title;
      this.set({ phase: { kind: 'open', peek } });
    } catch (e) {
      this.set({ phase: isApiError(e) && (e.status === 404 || e.status === 400) ? { kind: 'gone' } : { kind: 'failed', message: failure(e) } });
    }
  }

  setName(name: string): void {
    this.set({ name, error: null });
  }
  setMicOn(on: boolean): void {
    this.set({ micOn: on });
    this.engine?.setMuted?.(!on);
    if (this.adapter) void this.adapter.setMic(on).catch(() => this.set({ micOn: false, error: 'Your microphone could not be opened.' }));
  }
  setCameraOn(on: boolean): void {
    this.set({ cameraOn: on });
    if (this.adapter) void this.adapter.setCamera(on).catch(() => this.set({ cameraOn: false, error: 'Your camera could not be opened.' }));
  }
  setInput(id: string | null): void {
    this.set({ inputId: id });
    if (this.adapter && id) void this.adapter.useInput(id).catch(() => undefined);
  }

  /** Ask to join: the name is checked here and again on the server. */
  async knock(): Promise<void> {
    const phase = this.state.phase;
    if (phase.kind !== 'open' || this.token === null || this.state.busy) return;
    const checked = checkName(this.state.name);
    if (!checked.ok) {
      this.set({ error: checked.message });
      return;
    }
    this.set({ busy: true, error: null });
    try {
      const res = await this.deps.api.knock(this.token, checked.name);
      this.title = res.title;
      this.knockedAt = this.deps.now();
      // the address carries the link's secret: it leaves the address bar (and the history) as soon as it has been used
      this.deps.forgetAddress();
      this.set({ busy: false, phase: { kind: 'waiting', title: res.title } });
      this.startPolling(GUEST_POLL_WAITING_MS);
    } catch (e) {
      if (isApiError(e) && e.status === 404) this.set({ busy: false, phase: { kind: 'gone' } });
      else this.set({ busy: false, error: failure(e) });
    }
  }

  /** Cancel while waiting, or Leave in the call. */
  async leave(): Promise<void> {
    const gen = ++this.generation;
    this.stopTimers();
    await this.disconnect();
    try {
      await this.deps.api.leave();
    } catch {
      /* the server lets a silent guest go by itself */
    }
    if (gen === this.generation) this.set({ phase: { kind: 'left', title: this.title } });
  }

  /** After "Nobody answered": back to the form, if the page still has the link. */
  tryAgain(): void {
    if (this.token === null) {
      this.set({ phase: { kind: 'gone' } });
      return;
    }
    void this.open(this.token);
  }

  // ---- waiting and in the call ------------------------------------------------------------------------------------------------------------------------
  private startPolling(ms: number): void {
    if (this.poll !== null) this.deps.clearInterval(this.poll);
    this.poll = this.deps.setInterval(() => void this.check(), ms);
  }

  private stopTimers(): void {
    for (const h of [this.poll, this.renew]) if (h !== null) this.deps.clearInterval(h);
    if (this.retry !== null) this.deps.clearTimeout(this.retry);
    this.poll = this.renew = this.retry = null;
  }

  /**
   * The tab was shown again: a browser slows the timers of a hidden tab, so the page says at once that it is still there (and looks where it stands), in the
   * waiting room and in the call.
   */
  async shown(): Promise<void> {
    const k = this.state.phase.kind;
    if (k !== 'waiting' && k !== 'in-call' && k !== 'joining') return;
    await this.deps.api.heartbeat().catch(() => undefined);
    await this.check();
  }

  /** Asks the server where the guest stands and follows it. */
  async check(): Promise<void> {
    const gen = this.generation;
    let s;
    const sentAt = this.deps.now();
    try {
      s = await this.deps.api.session();
    } catch (e) {
      if (gen !== this.generation) return;
      if (isApiError(e) && e.status === 401) await this.end('gone');
      // offline for a moment: the next look tries again
      return;
    }
    if (gen !== this.generation) return;
    this.followTranscription(s, sentAt, this.deps.now());
    this.title = s.title;
    const ending = endingOf(s.state);
    if (ending) {
      await this.end(ending);
      return;
    }
    if (s.state === 'waiting') {
      if (this.state.phase.kind !== 'waiting') {
        this.knockedAt = this.knockedAt || this.deps.now();
        this.set({ phase: { kind: 'waiting', title: s.title } });
        this.startPolling(GUEST_POLL_WAITING_MS);
      } else if (this.deps.now() - this.knockedAt >= GUEST_WAIT_SECONDS * 1000) {
        await this.end('nobody');
      }
      return;
    }
    // admitted
    this.set({ people: s.people });
    if (this.state.phase.kind === 'in-call' && this.adapter === null && this.retry === null) this.lost();
    else if (this.state.phase.kind !== 'in-call' && this.state.phase.kind !== 'joining') await this.join();
    else this.syncEngine();
  }

  // ---- transcription (step 2) ------------------------------------------------------------------------------------------------------------------------
  /** Takes the call's transcription, the guest's answer and the call clock from the server's answer. */
  private followTranscription(s: GuestSessionResponse, sentAt: number, receivedAt: number): void {
    if (s.state !== 'admitted') return;
    if (s.startedAt && this.deps.engine) {
      if (this.clock === null || this.clockStart !== s.startedAt) {
        this.clock = this.deps.engine.clock(s.startedAt);
        this.clockStart = s.startedAt;
      }
      if (s.serverNow) this.clock.observe(s.serverNow, sentAt, receivedAt);
    }
    // an answer on its way wins over a look that started before it
    this.set({ transcription: s.transcription, turnedOnBy: s.turnedOnBy, ...(this.state.answering ? {} : { consent: s.consent }) });
  }

  /** "Transcribe my voice?": yes starts the guest's own engine, no stops it first and throws away what it heard but had not sent. */
  async answer(transcribe: 'yes' | 'no'): Promise<void> {
    if (this.state.phase.kind !== 'in-call' || this.state.answering) return;
    const gen = this.generation;
    if (transcribe === 'no') this.stopEngine(true);
    this.set({ answering: true, error: null });
    try {
      const res = await this.deps.api.consent(transcribe);
      if (gen !== this.generation) return;
      this.set({ answering: false, consent: res.consent });
    } catch (e) {
      if (gen !== this.generation) return;
      this.set({ answering: false, error: isApiError(e) && e.status === 409 && e.message ? e.message : 'Could not save your answer. Try again.' });
    }
    this.syncEngine();
  }

  /** Starts or stops the guest's engine so it matches the call: in it, transcribed, and a yes. */
  private syncEngine(): void {
    const s = this.state;
    const want = s.phase.kind === 'in-call' && s.transcription !== 'off' && s.consent === 'yes' && !s.answering;
    if (!want) {
      if (this.engine) this.stopEngine(s.consent !== 'yes');
      return;
    }
    if (this.engine || this.noEngine || !this.deps.engine || !this.clock) return;
    const engine = this.deps.engine.load((body) => this.deps.api.segments(body));
    if (!engine) {
      this.noEngine = true;
      this.set({ engine: { kind: 'failed', message: GUEST_WORDS.noEngine } });
      return;
    }
    this.engine = engine;
    this.set({ engine: { kind: 'loading', fraction: 0 } });
    const gen = this.generation;
    engine.start({
      // the guest's engine never asks the members' room routes: its clock is given and its lines go to the guest's route
      meetingId: 'guest',
      clock: this.clock,
      inputId: s.inputId,
      onStatus: (status) => {
        if (gen === this.generation && this.engine === engine) this.set({ engine: engineUiOf(status) });
      },
    });
    engine.setMuted?.(!s.micOn);
  }

  /** `discard`: the guest said no (or the call stopped being transcribed for them), so what was heard but not sent is thrown away. */
  private stopEngine(discard: boolean): void {
    const e = this.engine;
    this.engine = null;
    if (e) e.stop(discard ? { discard: true } : undefined);
    if (this.state.engine.kind !== 'off' && !(this.noEngine && this.state.engine.kind === 'failed')) this.set({ engine: { kind: 'off' } });
  }

  private async join(again = false): Promise<void> {
    const gen = this.generation;
    // a rejoin keeps the call on screen with "Reconnecting…"
    if (!again) this.set({ phase: { kind: 'joining', title: this.title }, error: null });
    if (this.poll !== null) this.deps.clearInterval(this.poll);
    this.poll = null;
    try {
      const res = await this.deps.api.token();
      if (gen !== this.generation) return;
      const adapter = await this.deps.loadAdapter(res.join.provider);
      this.adapter = adapter;
      await adapter.connect(res.join, { ...AUDIO_DEFAULTS, inputId: this.state.inputId }, {
        connection: (state) => {
          if (state === 'reconnecting') this.set({ reconnecting: true });
          else if (state === 'connected') this.set({ reconnecting: false });
          // dropped by the server (taken out, the call ended) or the connection gave up: the server says which, and a guest still let in joins again
          else if (gen === this.generation) this.lost();
        },
        speakers: (ids) => this.set({ speaking: new Set(ids) }),
        devices: () => undefined,
        micFailed: () => this.set({ micOn: false, error: 'Your microphone could not be opened.' }),
        videos: (tiles) => this.set({ videos: tiles }),
        quality: () => undefined,
      });
      if (gen !== this.generation) {
        await adapter.disconnect();
        return;
      }
      this.attempts = 0;
      this.set({ phase: { kind: 'in-call', title: this.title }, people: res.people, reconnecting: false });
      if (this.state.micOn) await adapter.setMic(true).catch(() => this.set({ micOn: false, error: 'Your microphone could not be opened.' }));
      if (this.state.cameraOn) await adapter.setCamera(true).catch(() => this.set({ cameraOn: false, error: 'Your camera could not be opened.' }));
      // the poll is also the sign of life the server's sweep looks for: no separate heartbeat while the tab is shown
      this.startPolling(GUEST_POLL_IN_CALL_MS);
      // a token lasts ten minutes: a fresh one is asked for before it runs out (a reconnect needs one), and the answer says the guest is still let in
      this.renew = this.deps.setInterval(() => void this.deps.api.token().then((r) => this.set({ people: r.people })).catch(() => void this.check()), RENEW_MS);
      this.syncEngine();
    } catch (e) {
      if (gen !== this.generation) return;
      await this.disconnect();
      if (isApiError(e) && (e.status === 403 || e.status === 409 || e.status === 401)) {
        await this.check();
        return;
      }
      // a rejoin that failed (offline, the media server busy) tries again after a pause; a first join that failed says so
      if (this.state.reconnecting) this.scheduleRejoin();
      else this.set({ phase: { kind: 'failed', message: failure(e) } });
    }
  }

  /** The media connection was lost while in the call: "Reconnecting…", and a new token and a new connection after a pause, while the server says the guest is let in. */
  private lost(): void {
    if (this.state.phase.kind !== 'in-call' && this.state.phase.kind !== 'joining') return;
    const a = this.adapter;
    this.adapter = null;
    if (a) void a.disconnect().catch(() => undefined);
    // the engine stops with the call and starts again once it is back
    this.stopEngine(false);
    this.set({ reconnecting: true, videos: [], speaking: new Set() });
    this.scheduleRejoin();
  }

  private scheduleRejoin(): void {
    if (this.retry !== null) return;
    const delay = REJOIN_DELAYS_MS[Math.min(this.attempts, REJOIN_DELAYS_MS.length - 1)]!;
    this.attempts += 1;
    const gen = this.generation;
    this.retry = this.deps.setTimeout(() => {
      this.retry = null;
      if (gen !== this.generation) return;
      void this.rejoin(gen);
    }, delay);
  }

  private async rejoin(gen: number): Promise<void> {
    let s;
    try {
      s = await this.deps.api.session();
    } catch (e) {
      if (gen !== this.generation) return;
      if (isApiError(e) && e.status === 401) await this.end('gone');
      else this.scheduleRejoin();
      return;
    }
    if (gen !== this.generation) return;
    const ending = endingOf(s.state);
    if (ending) {
      await this.end(ending);
      return;
    }
    if (s.state !== 'admitted') {
      this.scheduleRejoin();
      return;
    }
    if (this.poll !== null) this.deps.clearInterval(this.poll);
    if (this.renew !== null) this.deps.clearInterval(this.renew);
    this.poll = this.renew = null;
    await this.join(true);
  }

  private async end(kind: 'gone' | 'denied' | 'ended' | 'removed' | 'nobody' | 'left'): Promise<void> {
    ++this.generation;
    this.stopTimers();
    await this.disconnect();
    this.set({ phase: kind === 'gone' ? { kind: 'gone' } : { kind, title: this.title }, videos: [], speaking: new Set(), reconnecting: false });
  }

  /** Every ending goes through here: the engine (sending what it heard), the media connection and the microphone are let go. */
  private async disconnect(): Promise<void> {
    this.stopEngine(false);
    const a = this.adapter;
    this.adapter = null;
    if (a) await a.disconnect().catch(() => undefined);
  }

  /** The page went away. */
  dispose(): void {
    ++this.generation;
    this.stopTimers();
    void this.disconnect();
  }

  // ---- for the stage --------------------------------------------------------------------------------------------------------------------------------
  attachVideo(key: string, el: HTMLVideoElement): () => void {
    return this.adapter?.attachVideo(key, el) ?? (() => undefined);
  }
  /** The guest page keeps the layout it has; the stage's layout buttons do nothing here. */
  setLayout(): void {
    /* nothing kept for a guest */
  }
}

/** A failed call in plain words. */
function failure(e: unknown): string {
  if (isApiError(e)) {
    if (e.code === 'network') return 'Could not reach the server. Check your connection and try again.';
    if (e.status === 429) return e.message || 'Too many tries in a short time. Try again in a minute.';
    if (e.status >= 400 && e.status < 500 && e.message) return e.message;
  }
  return 'Something went wrong. Try again.';
}

import { GUEST_POLL_IN_CALL_MS, GUEST_POLL_WAITING_MS, GUEST_WAIT_SECONDS, MEETING_GUEST_NAME_MAX, type GuestLinkPeekResponse, type GuestRoomPerson, type GuestSessionState } from '@manythreads/shared';
import { isApiError } from '../api/client';
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
  transcribed: 'This call is being transcribed for the team. Your own voice is not written down.',
  notetaker: 'A note-taker is listening to this call for the team. Your own voice is not written down.',
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
};

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
    try {
      s = await this.deps.api.session();
    } catch (e) {
      if (gen !== this.generation) return;
      if (isApiError(e) && e.status === 401) await this.end('gone');
      // offline for a moment: the next look tries again
      return;
    }
    if (gen !== this.generation) return;
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

  private async disconnect(): Promise<void> {
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

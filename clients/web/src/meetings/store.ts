import { useSyncExternalStore } from 'react';
import {
  MEETING_ASK_PUSH,
  MEETING_CATCHUP_PUSH,
  MEETING_CAPTION_PUSH,
  MEETING_CHANGED_PUSH,
  MEETING_LOBBY_PUSH,
  MEETING_RINGING_PUSH,
  MEETING_SHARE_ANSWERED_PUSH,
  MEETING_SHARE_ASKED_PUSH,
  MeetingCaptionPush,
  MeetingChangedPush,
  MeetingRingingPush,
  MeetingShareAnsweredPush,
  MeetingShareAskedPush,
  SCHEDULED_MEETING_CHANGED_PUSH,
  ScheduledMeetingChangedPush,
  dndState,
  type MeetingSummary,
} from '@manythreads/shared';
import { channelStore } from '../channels/store';
import { presenceStore } from '../presence/store';
import type { Push, RealtimeClient } from '../realtime/socket';
import { addNotetaker, answerRecordConsent, answerShareRequest, askToShare, correctSegment, fetchLiveMeetings, fetchNotetakers, fetchRecording, fetchTranscript, realCallApi, removeNotetaker, setRecording } from './api';
import { CallController, type CallState, type RoomApi } from './controller';
import { loadEngine } from './engine';
import { loadAdapter } from './media';
import { LIVE_POLL_MS, activeRings, liveByChannel, type Ring } from './model';
import { roomOfMessage } from './roomCard';
import { callCards } from './callCards';
import { lobbyStore } from './guestLinks';
import { assistantStore } from './assistant';
import { browserStorage, loadPrefs } from './prefs';
import { browserAudioContext, createSounds, type Sounds } from './sounds';

/*
 * What the page knows about voice rooms, beside the one call it may be in: the live rooms the person can see (the sidebar badge, "join" on a channel), and the
 * calls ringing for them. Pushes tell it something changed; it asks again, and also every half minute, so a lost push heals.
 */

export type LiveSnapshot = {
  status: 'loading' | 'ok' | 'absent';
  rooms: readonly MeetingSummary[];
  byChannel: ReadonlyMap<string, MeetingSummary>;
  rings: readonly Ring[];
};

export type LiveDeps = {
  fetchLive: () => Promise<{ meetings: MeetingSummary[] }>;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  /** Tell the room page that a room changed / a message came into its chat. */
  onRoomChanged: (meetingId: string) => void;
  /** The room (id and chat thread) the person is in, for the chat's unread count; null when in none. */
  currentRoom: () => { meetingId: string; threadRootId: string | null } | null;
  onChatMessage: () => void;
  /** Live captions for a room came in; the call keeps them if it is the room the person is in. */
  onCaptions: (meetingId: string, captions: MeetingCaptionPush['captions']) => void;
  /** Someone asked this person for a turn to share their screen, or the person they asked answered (P17-02); the call keeps it if it is the room they are in. */
  onShareRequest?: (push: { kind: 'asked'; push: MeetingShareAskedPush } | { kind: 'answered'; push: MeetingShareAnsweredPush }) => void;
  selfActor: () => string | null;
  sounds: Pick<Sounds, 'startRing' | 'stopRing'>;
  /** A system notice for a ring when the tab is hidden. */
  notify: (title: string, tag: string) => void;
  hidden: () => boolean;
  /** Someone knocked on, or was answered at, the waiting room of a call (P17-04): the lobby asks again if it is the call the person is in. */
  onLobby?: (push: Push) => void;
  /** The answer to this person's question in a call, or their Catch me up summary (P17-06): the assistant panel takes it. */
  onAssistant?: (push: Push) => void;
  /** The socket came back after a gap: what else the page keeps about calls asks again (the call cards, P15-26). */
  onReconnected?: () => void;
  /**
   * The person's own Do not disturb is on (P15-27): a call still shows its ring card, but makes no sound and no system notice. Read when a ring comes in, when
   * the person's presence changes (`quietChanged`: turning it on silences a ring, turning it off lets the sound start) and at each look at the rings (the live
   * list's half-minute check, a ring's end). A quiet period that starts or ends by the clock alone is noticed at the next of those, within half a minute.
   */
  quiet?: () => boolean;
};

const EMPTY: LiveSnapshot = { status: 'loading', rooms: [], byChannel: new Map(), rings: [] };

export class LiveRoomsStore {
  private snap: LiveSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private detach: Array<() => void> = [];
  private poll: unknown = null;
  private expiry: unknown = null;
  private running: Promise<void> | null = null;
  private again = false;
  private rings: Ring[] = [];
  private readonly addedAt = new Map<string, number>();
  /** Calls the person has answered or turned down: they stop ringing. */
  private readonly skip = new Set<string>();
  private ringing = false;
  private readonly scheduledListeners = new Set<(p: ScheduledMeetingChangedPush) => void>();

  constructor(private readonly deps: LiveDeps) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = (): LiveSnapshot => this.snap;

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  private publish(partial: Partial<LiveSnapshot>): void {
    this.snap = { ...this.snap, ...partial };
    this.emit();
  }

  /** Listens to the tab's socket and starts the half-minute check. */
  attach(client: RealtimeClient): void {
    this.detach.forEach((d) => d());
    this.detach = [
      client.onPush((p) => this.handlePush(p)),
      client.onReconnected(() => {
        void this.refresh();
        this.deps.onReconnected?.();
      }),
    ];
  }

  start(): void {
    if (this.poll !== null) return;
    void this.refresh();
    this.poll = this.deps.setInterval(() => void this.refresh(), LIVE_POLL_MS);
  }

  stop(): void {
    this.detach.forEach((d) => d());
    this.detach = [];
    if (this.poll !== null) this.deps.clearInterval(this.poll);
    this.poll = null;
    if (this.expiry !== null) this.deps.clearTimeout(this.expiry);
    this.expiry = null;
    this.deps.sounds.stopRing();
    this.ringing = false;
  }

  /** Asks the server for the live rooms. A call while one ask is out waits for one more ask that starts after it, so the answer is never older than the call (P33-03: End room waits for it). */
  async refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.refreshLoop();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  private async refreshLoop(): Promise<void> {
    do {
      this.again = false;
      await this.refreshOnce();
    } while (this.again);
  }

  private async refreshOnce(): Promise<void> {
    const startedAt = this.deps.now();
    try {
      const res = await this.deps.fetchLive();
      this.publish({ status: 'ok', rooms: res.meetings, byChannel: liveByChannel(res.meetings) });
      // a ring for a room that is no longer live stops (a ring that arrived while we were asking is kept: the answer may predate it)
      const liveIds = new Set<string>(res.meetings.map((r) => r.meeting.id));
      this.rings = this.rings.filter((r) => liveIds.has(r.meetingId) || (this.addedAt.get(r.meetingId) ?? 0) >= startedAt);
      this.syncRings();
    } catch {
      // no meetings plugin (404), a server without the route, or offline: no badges, never an error on screen
      this.publish({ status: this.snap.status === 'ok' ? 'ok' : 'absent' });
    }
  }

  /** A planned room was made, changed, cancelled or opened (P16-05): the channel header's chip asks again. Returns the way to stop listening. */
  onScheduledChanged = (listener: (p: ScheduledMeetingChangedPush) => void): (() => void) => {
    this.scheduledListeners.add(listener);
    return () => this.scheduledListeners.delete(listener);
  };

  handlePush(push: Push): void {
    if (push.type === SCHEDULED_MEETING_CHANGED_PUSH) {
      const p = ScheduledMeetingChangedPush.safeParse(push.payload);
      if (!p.success) return;
      // a plan that became a room: the live badge and the Join button learn of it at once
      if (p.data.change === 'started') void this.refresh();
      for (const l of [...this.scheduledListeners]) l(p.data);
      return;
    }
    if (push.type === MEETING_CHANGED_PUSH) {
      const p = MeetingChangedPush.safeParse(push.payload);
      if (!p.success) return;
      void this.refresh();
      this.deps.onRoomChanged(p.data.meetingId);
      return;
    }
    if (push.type === MEETING_CAPTION_PUSH) {
      const p = MeetingCaptionPush.safeParse(push.payload);
      if (p.success) this.deps.onCaptions(p.data.meetingId, p.data.captions);
      return;
    }
    if (push.type === MEETING_SHARE_ASKED_PUSH) {
      const p = MeetingShareAskedPush.safeParse(push.payload);
      if (p.success) this.deps.onShareRequest?.({ kind: 'asked', push: p.data });
      return;
    }
    if (push.type === MEETING_SHARE_ANSWERED_PUSH) {
      const p = MeetingShareAnsweredPush.safeParse(push.payload);
      if (p.success) this.deps.onShareRequest?.({ kind: 'answered', push: p.data });
      return;
    }
    if (push.type === MEETING_LOBBY_PUSH) {
      this.deps.onLobby?.(push);
      return;
    }
    if (push.type === MEETING_ASK_PUSH || push.type === MEETING_CATCHUP_PUSH) {
      this.deps.onAssistant?.(push);
      return;
    }
    if (push.type === MEETING_RINGING_PUSH) {
      const p = MeetingRingingPush.safeParse(push.payload);
      if (p.success) this.addRing(p.data);
      return;
    }
    if (push.type === 'message.posted') {
      const room = this.deps.currentRoom();
      const payload = push.payload as { threadRootId?: unknown; message?: { authorId?: unknown } };
      if (room?.threadRootId && payload.threadRootId === room.threadRootId && payload.message?.authorId !== this.deps.selfActor()) this.deps.onChatMessage();
    }
  }

  // ---- ringing -------------------------------------------------------------------------------------------------------------------------------------
  addRing(p: MeetingRingingPush): void {
    if (this.skip.has(p.meetingId) || this.rings.some((r) => r.meetingId === p.meetingId)) return;
    const ring: Ring = { meetingId: p.meetingId, channelId: p.channelId, callerActorId: p.callerActorId, callerName: p.callerName, until: this.deps.now() + p.ringSeconds * 1000 };
    this.rings = [...this.rings, ring];
    this.addedAt.set(p.meetingId, this.deps.now());
    if (this.deps.hidden() && !this.quiet()) this.deps.notify(`${p.callerName} is calling you`, p.meetingId);
    this.syncRings();
    void this.refresh();
  }

  /** The person answered or turned the call down: it stops ringing here. */
  stopRinging(meetingId: string): void {
    this.skip.add(meetingId);
    this.syncRings();
  }

  private quiet(): boolean {
    try {
      return this.deps.quiet?.() ?? false;
    } catch {
      return false;
    }
  }

  /** The person's Do not disturb may have changed: a ring going now is silenced or sounded to match. */
  quietChanged(): void {
    if (this.activeRings().length > 0 || this.ringing) this.syncRings();
  }

  /** Rings still going at this moment. */
  activeRings(): Ring[] {
    return activeRings(this.rings, this.deps.now(), this.skip);
  }

  private syncRings(): void {
    const now = this.deps.now();
    this.rings = this.rings.filter((r) => r.until > now);
    const active = this.activeRings();
    if (this.expiry !== null) this.deps.clearTimeout(this.expiry);
    this.expiry = null;
    const next = active.reduce<number | null>((m, r) => (m === null || r.until < m ? r.until : m), null);
    if (next !== null) this.expiry = this.deps.setTimeout(() => this.syncRings(), Math.max(50, next - now));
    const quiet = active.length > 0 && this.quiet();
    if (active.length > 0 && !quiet && !this.ringing) {
      this.ringing = true;
      this.deps.sounds.startRing();
    } else if ((active.length === 0 || quiet) && this.ringing) {
      this.ringing = false;
      this.deps.sounds.stopRing();
    }
    this.publish({ rings: active });
  }
}

// ---- the page's one instance of each ------------------------------------------------------------------------------------------------------------
let controller: CallController | null = null;
let sounds: Sounds | null = null;
let live: LiveRoomsStore | null = null;

export function pageSounds(): Sounds {
  sounds ??= createSounds({ context: browserAudioContext, enabled: () => callController().getState().prefs.sounds });
  return sounds;
}

export const realRoomApi: RoomApi = {
  notetakers: fetchNotetakers,
  addNotetaker,
  removeNotetaker,
  recording: fetchRecording,
  setRecording,
  recordConsent: answerRecordConsent,
  transcript: fetchTranscript,
  correct: correctSegment,
  askToShare,
  answerShare: answerShareRequest,
};

export function callController(): CallController {
  controller ??= new CallController({
    api: realCallApi,
    room: realRoomApi,
    loadAdapter,
    sounds: pageSounds(),
    storage: browserStorage(),
    prefs: loadPrefs(browserStorage()),
    loadEngine,
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as number),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => globalThis.clearInterval(h as number),
  });
  return controller;
}

export function liveRooms(): LiveRoomsStore {
  live ??= new LiveRoomsStore({
    fetchLive: fetchLiveMeetings,
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as number),
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: (h) => globalThis.clearInterval(h as number),
    onRoomChanged: (id) => {
      callController().noteChanged(id);
      // the call card of this call, if the page drew it, asks again for this one call
      callCards().changed(id);
    },
    currentRoom: () => {
      const m = callController().getState().meeting;
      return m ? { meetingId: m.id, threadRootId: m.threadRootId } : null;
    },
    onChatMessage: () => callController().noteChatMessage(),
    onCaptions: (meetingId, captions) => callController().noteCaptions(meetingId, captions),
    onShareRequest: (p) => (p.kind === 'asked' ? callController().noteShareAsked(p.push) : callController().noteShareAnswered(p.push)),
    selfActor: () => channelStore.selfActor,
    sounds: pageSounds(),
    notify: (title, tag) => {
      try {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { tag, body: 'Open manythreads to answer.' });
      } catch {
        /* a notification is a courtesy */
      }
    },
    hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    onReconnected: () => callCards().refreshAll(),
    onLobby: (push) => {
      const l = lobbyStore();
      l.knock = () => pageSounds().play('knock');
      l.handlePush(push);
    },
    onAssistant: (push) => assistantStore().handlePush(push),
    quiet: () => {
      const me = presenceStore.snapshot().me;
      return me !== null && dndState(me.dnd, me.timeZone ?? null, new Date(), false).active;
    },
  });
  // a card drawn as live whose call left the live list is asked again (a lost push heals with the list's half-minute check)
  const rooms = live;
  // turning Do not disturb on or off while a call rings silences or sounds it at once
  presenceStore.subscribe(() => rooms.quietChanged());
  let seen: LiveSnapshot['rooms'] | null = null;
  rooms.subscribe(() => {
    const snap = rooms.snapshot();
    if (snap.status !== 'ok' || snap.rooms === seen) return;
    seen = snap.rooms;
    callCards().liveListChanged(new Set(snap.rooms.map((r) => r.meeting.id)));
  });
  return live;
}

// ---- hooks -----------------------------------------------------------------------------------------------------------------------------------------
export function useCall(): CallState {
  const c = callController();
  return useSyncExternalStore(c.subscribe, c.getState, c.getState);
}

export function useLive(): LiveSnapshot {
  const l = liveRooms();
  return useSyncExternalStore(l.subscribe, l.snapshot, l.snapshot);
}

/** The live room in this channel, if any. */
export function useLiveRoom(channelId: string): MeetingSummary | undefined {
  return useLive().byChannel.get(channelId);
}

/** The live room that this message started (the card under "Started a voice room"); undefined for any other message and after the room ends. */
export function useRoomOfMessage(messageId: string): MeetingSummary | undefined {
  const l = liveRooms();
  const read = (): MeetingSummary | undefined => roomOfMessage(l.snapshot().rooms, messageId);
  return useSyncExternalStore(l.subscribe, read, read);
}

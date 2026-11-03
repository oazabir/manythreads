import { useSyncExternalStore } from 'react';
import { MEETING_CHANGED_PUSH, MEETING_RINGING_PUSH, MeetingChangedPush, MeetingRingingPush, type MeetingSummary } from '@manythreads/shared';
import { channelStore } from '../channels/store';
import type { Push, RealtimeClient } from '../realtime/socket';
import { fetchLiveMeetings, realCallApi } from './api';
import { CallController, type CallState } from './controller';
import { loadEngine } from './engine';
import { loadAdapter } from './media';
import { LIVE_POLL_MS, activeRings, liveByChannel, type Ring } from './model';
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
  selfActor: () => string | null;
  sounds: Pick<Sounds, 'startRing' | 'stopRing'>;
  /** A system notice for a ring when the tab is hidden. */
  notify: (title: string, tag: string) => void;
  hidden: () => boolean;
};

const EMPTY: LiveSnapshot = { status: 'loading', rooms: [], byChannel: new Map(), rings: [] };

export class LiveRoomsStore {
  private snap: LiveSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private detach: Array<() => void> = [];
  private poll: unknown = null;
  private expiry: unknown = null;
  private inflight = false;
  private again = false;
  private rings: Ring[] = [];
  private readonly addedAt = new Map<string, number>();
  /** Calls the person has answered or turned down: they stop ringing. */
  private readonly skip = new Set<string>();
  private ringing = false;

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
    this.detach = [client.onPush((p) => this.handlePush(p)), client.onReconnected(() => void this.refresh())];
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

  async refresh(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return;
    }
    this.inflight = true;
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
    } finally {
      this.inflight = false;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    }
  }

  handlePush(push: Push): void {
    if (push.type === MEETING_CHANGED_PUSH) {
      const p = MeetingChangedPush.safeParse(push.payload);
      if (!p.success) return;
      void this.refresh();
      this.deps.onRoomChanged(p.data.meetingId);
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
    if (this.deps.hidden()) this.deps.notify(`${p.callerName} is calling you`, p.meetingId);
    this.syncRings();
    void this.refresh();
  }

  /** The person answered or turned the call down: it stops ringing here. */
  stopRinging(meetingId: string): void {
    this.skip.add(meetingId);
    this.syncRings();
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
    if (active.length > 0 && !this.ringing) {
      this.ringing = true;
      this.deps.sounds.startRing();
    } else if (active.length === 0 && this.ringing) {
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

export function callController(): CallController {
  controller ??= new CallController({
    api: realCallApi,
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
    onRoomChanged: (id) => callController().noteChanged(id),
    currentRoom: () => {
      const m = callController().getState().meeting;
      return m ? { meetingId: m.id, threadRootId: m.threadRootId } : null;
    },
    onChatMessage: () => callController().noteChatMessage(),
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

import { useEffect, useSyncExternalStore } from 'react';
import { MEETING_LOBBY_PUSH, MeetingLobbyPush, type LobbyGuest } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { copyText } from '../channels/messageActions';
import { decideGuest, fetchLobby, makeGuestLink } from './api';

/*
 * Guest links and the waiting room on a member's page (P17-04, docs/plans/guest-links.md).
 *
 * The server keeps only a hash of a link, so it cannot show one again: each member gets a link of their own. The page keeps the address it was given for a call in
 * `sessionStorage` (this tab only, gone when the tab closes), so "Copy guest link" copies the same link every time in this tab, and asks for a new one after that.
 *
 * The waiting room: a knock pushes `meeting.lobby` to the people in the call; the page asks who is waiting and the call bar shows "Ana is waiting · Let in · Deny"
 * (with a soft knock sound), or "3 waiting" opening the list. Whoever answers first wins; a late answer is told "Someone already answered".
 */

const KEY = (meetingId: string): string => `manythreads_guest_link:${meetingId}`;

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
function tabStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The link this tab was given for the call, while it has not expired. */
export function keptGuestLink(meetingId: string, now: number = Date.now(), storage: Storage | null = tabStorage()): string | null {
  try {
    const raw = storage?.getItem(KEY(meetingId));
    if (!raw) return null;
    const v = JSON.parse(raw) as { url?: unknown; expiresAt?: unknown };
    if (typeof v.url !== 'string' || typeof v.expiresAt !== 'string' || Date.parse(v.expiresAt) <= now) return null;
    return v.url;
  } catch {
    return null;
  }
}

export function keepGuestLink(meetingId: string, link: { url: string; expiresAt: string }, storage: Storage | null = tabStorage()): void {
  try {
    storage?.setItem(KEY(meetingId), JSON.stringify({ url: link.url, expiresAt: link.expiresAt }));
  } catch {
    /* a full or blocked storage: the next copy asks for a new link */
  }
}

export function forgetGuestLink(meetingId: string, storage: Storage | null = tabStorage()): void {
  try {
    storage?.removeItem(KEY(meetingId));
  } catch {
    /* nothing kept */
  }
}

/** What a press on "Copy guest link" says. */
export type CopyOutcome = { ok: true; text: string } | { ok: false; text: string };

/** Copies this person's guest link for the call (the kept one, or a new one), and says what happened in plain words. */
export async function copyGuestLink(meetingId: string, deps: { make: typeof makeGuestLink; copy: (text: string) => Promise<boolean> } = { make: makeGuestLink, copy: copyText }): Promise<CopyOutcome> {
  let url = keptGuestLink(meetingId);
  if (url === null) {
    try {
      const made = await deps.make(meetingId);
      keepGuestLink(meetingId, made);
      url = made.url;
    } catch (e) {
      return { ok: false, text: isApiError(e) && e.status !== 0 && e.code !== 'network' ? e.message : 'Could not make a guest link. Try again.' };
    }
  }
  return (await deps.copy(url)) ? { ok: true, text: 'Guest link copied' } : { ok: false, text: `Copy this guest link: ${url}` };
}

// ---- the waiting room -------------------------------------------------------------------------------------------------------------------------------

export type LobbySnapshot = { meetingId: string | null; waiting: readonly LobbyGuest[]; error: string | null };

export class LobbyStore {
  private snap: LobbySnapshot = { meetingId: null, waiting: [], error: null };
  private readonly listeners = new Set<() => void>();
  private asking = 0;
  /** Played when somebody new knocks (the page's soft knock sound). */
  knock: () => void = () => undefined;

  constructor(private readonly deps: { fetch: typeof fetchLobby; decide: typeof decideGuest }) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = (): LobbySnapshot => this.snap;

  private publish(next: Partial<LobbySnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of [...this.listeners]) l();
  }

  /** The call this page is in now (null when in none): the list is of that call only. */
  follow(meetingId: string | null): void {
    if (meetingId === this.snap.meetingId) return;
    this.publish({ meetingId, waiting: [], error: null });
    if (meetingId) void this.refresh();
  }

  /** A push said someone knocked or was answered. */
  handlePush(push: { type: string; payload: unknown }): void {
    if (push.type !== MEETING_LOBBY_PUSH) return;
    const p = MeetingLobbyPush.safeParse(push.payload);
    if (p.success && p.data.meetingId === this.snap.meetingId) void this.refresh(true);
  }

  async refresh(fromPush = false): Promise<void> {
    const id = this.snap.meetingId;
    if (!id) return;
    const ask = ++this.asking;
    try {
      const res = await this.deps.fetch(id);
      if (ask !== this.asking || id !== this.snap.meetingId) return;
      const before = new Set(this.snap.waiting.map((w) => w.id));
      if (fromPush && res.waiting.some((w) => !before.has(w.id))) this.knock();
      // a fresh look: what went wrong with an earlier answer is no longer news
      this.publish({ waiting: res.waiting, error: null });
    } catch {
      // not in the call (any more), or offline: nobody shown; the next push or look heals it
      if (ask === this.asking) this.publish({ waiting: [], error: null });
    }
  }

  /** Takes a guest who was let in out of the call (their tile goes with the next look at the room). */
  async remove(guestId: string): Promise<void> {
    const id = this.snap.meetingId;
    if (!id) return;
    this.publish({ error: null });
    try {
      await this.deps.decide(id, guestId, 'remove');
    } catch (e) {
      this.publish({ error: isApiError(e) && e.status === 409 ? e.message : 'That did not work. Try again.' });
    }
  }

  async answer(guestId: string, decision: 'admit' | 'deny'): Promise<void> {
    const id = this.snap.meetingId;
    if (!id) return;
    this.publish({ error: null, waiting: this.snap.waiting.filter((w) => w.id !== guestId) });
    try {
      await this.deps.decide(id, guestId, decision);
    } catch (e) {
      this.publish({ error: isApiError(e) && e.status === 409 ? e.message : 'That did not work. Try again.' });
    }
    await this.refresh();
  }
}

let lobby: LobbyStore | null = null;
export function lobbyStore(): LobbyStore {
  lobby ??= new LobbyStore({ fetch: fetchLobby, decide: decideGuest });
  return lobby;
}

/** The waiting room of the call the page is in; the list is asked again every 10 seconds as well, so a lost push heals. */
export function useLobby(meetingId: string | null): LobbySnapshot {
  const l = lobbyStore();
  useEffect(() => {
    l.follow(meetingId);
    if (!meetingId) return;
    const t = setInterval(() => void l.refresh(), 10_000);
    return () => clearInterval(t);
  }, [l, meetingId]);
  return useSyncExternalStore(l.subscribe, l.snapshot, l.snapshot);
}

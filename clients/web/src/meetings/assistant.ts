import { useEffect, useSyncExternalStore } from 'react';
import {
  MEETING_ASK_PUSH,
  MEETING_CATCHUP_PUSH,
  MEETING_CATCH_UP_OFFER_MINUTES,
  MeetingAskPush,
  MeetingCatchUpPush,
  type MeetingAnswerer,
  type MeetingAssistantStatus,
} from '@manythreads/shared';
import { isApiError } from '../api/client';
import { askAssistant, fetchAssistantStatus, requestCatchUp } from './api';

/*
 * The meeting assistant on a person's page (P17-06, docs/plans/meeting-assistant.md): the Ask panel's questions and Catch me up.
 *
 * Both answer 202 at once; what was asked for comes later as a push to this person's own tabs (`meeting.ask`, `meeting.catchup`). A push can come before the answer to
 * the POST (MISTAKES P32-05), so one that names an id this page has not heard of yet is kept for a minute and used when the POST answers. A question with no push for
 * three minutes says so instead of waiting forever (its answer is still in the thread when it came).
 */

export type AskItem = {
  /** The page's own key; the server's id once the POST answered. */
  key: string;
  askId: string | null;
  question: string;
  state: 'asking' | 'answered' | 'failed';
  answererName: string;
  text: string;
};

export type CatchUpState =
  | { kind: 'idle' }
  | { kind: 'writing'; requestId: string | null; minutesBefore: number }
  | { kind: 'ready' | 'empty' | 'failed'; minutesBefore: number; text: string };

export type AssistantSnapshot = {
  meetingId: string | null;
  status: MeetingAssistantStatus | null;
  /** The panel is open (it stays open across re-renders of the call bar). */
  open: boolean;
  asks: readonly AskItem[];
  catchUp: CatchUpState;
  /** A refusal of the last Ask or Catch me up press, in plain words. */
  error: string | null;
};

/** How long a question waits for its push before the panel stops waiting. */
export const ASK_WAIT_MS = 3 * 60_000;
/** How long a summary waits for its push. */
export const CATCH_UP_WAIT_MS = 2 * 60_000;
/** At most this many questions are listed (newest first). */
const ASKS_KEPT = 20;
/** A push for an id not known yet is kept this long, for the POST that has not answered yet. */
const EARLY_MS = 60_000;

const EMPTY: AssistantSnapshot = { meetingId: null, status: null, open: false, asks: [], catchUp: { kind: 'idle' }, error: null };

type Deps = {
  status: typeof fetchAssistantStatus;
  ask: typeof askAssistant;
  catchUp: typeof requestCatchUp;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
};

const refusal = (e: unknown, fallback: string): string => (isApiError(e) && e.status !== 0 && e.code !== 'network' && e.message ? e.message : fallback);

/** "Catch me up · 12 minutes so far" (the minutes of the call before the person joined), or the plain label for someone who was there from the start. */
export function catchUpLabel(minutesBefore: number): string {
  if (minutesBefore <= 0) return 'Catch me up';
  return `Catch me up · ${minutesBefore} ${minutesBefore === 1 ? 'minute' : 'minutes'} so far`;
}

/** True when the call bar should offer Catch me up on its own: the person came late enough, may use it, and has not asked yet. */
export function offerCatchUp(snap: Pick<AssistantSnapshot, 'status' | 'catchUp'>): boolean {
  const c = snap.status?.catchUp;
  return c !== undefined && c.available && c.minutesBefore >= MEETING_CATCH_UP_OFFER_MINUTES && snap.catchUp.kind === 'idle';
}

/** The panel's heading: whom the question goes to. */
export function askHeading(answerer: MeetingAnswerer | null | undefined): string {
  return answerer ? `Ask ${answerer.name}` : 'Ask';
}

export class AssistantStore {
  private snap: AssistantSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private readonly early = new Map<string, { at: number; push: { type: string; payload: unknown } }>();
  private seq = 0;
  private looking = 0;

  constructor(private readonly deps: Deps) {}

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = (): AssistantSnapshot => this.snap;

  private publish(next: Partial<AssistantSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of [...this.listeners]) l();
  }

  /** The call this page is in (null when none): everything shown belongs to that call only, and starts empty for another. */
  follow(meetingId: string | null): void {
    if (meetingId === this.snap.meetingId) return;
    this.early.clear();
    this.publish({ ...EMPTY, meetingId });
    if (meetingId) void this.refresh();
  }

  setOpen(open: boolean): void {
    if (open === this.snap.open) return;
    this.publish({ open, error: null });
    if (open) void this.refresh();
  }

  /** Asks the server what may be offered now (a note-taker came or went, the person's answer to transcription changed). */
  async refresh(): Promise<void> {
    const id = this.snap.meetingId;
    if (!id) return;
    const look = ++this.looking;
    try {
      const status = await this.deps.status(id);
      if (look === this.looking && id === this.snap.meetingId) this.publish({ status });
    } catch {
      // not in the call any more, or offline: the next look heals it
    }
  }

  async ask(question: string): Promise<boolean> {
    const id = this.snap.meetingId;
    const q = question.trim();
    if (!id || q === '') return false;
    const key = `local-${++this.seq}`;
    const answererName = this.snap.status?.ask.answerer?.name ?? 'The assistant';
    const item: AskItem = { key, askId: null, question: q, state: 'asking', answererName, text: '' };
    this.publish({ error: null, asks: [item, ...this.snap.asks].slice(0, ASKS_KEPT) });
    try {
      const res = await this.deps.ask(id, q);
      if (id !== this.snap.meetingId) return false;
      // the same question may already be listed from its own `asking` push (another tab's list, or a push that won the race): one line per question
      if (this.snap.asks.some((a) => a.askId === res.askId && a.key !== key)) this.publish({ asks: this.snap.asks.filter((a) => a.key !== key) });
      else this.patch(key, { askId: res.askId, answererName: res.answerer.name });
      const early = this.early.get(res.askId);
      if (early) {
        this.early.delete(res.askId);
        this.handlePush(early.push);
      }
      // pushes kept while this question was on its way that were not its own: questions asked elsewhere, listed now
      if (!this.snap.asks.some((a) => a.askId === null)) {
        for (const [id, kept] of [...this.early]) {
          if (kept.push.type !== MEETING_ASK_PUSH) continue;
          this.early.delete(id);
          this.handlePush(kept.push);
        }
      }
      this.waitFor(res.askId);
      return true;
    } catch (e) {
      if (id !== this.snap.meetingId) return false;
      this.publish({ asks: this.snap.asks.filter((a) => a.key !== key), error: refusal(e, 'Your question could not be sent. Try again.') });
      return false;
    }
  }

  async catchUp(): Promise<void> {
    const id = this.snap.meetingId;
    if (!id || this.snap.catchUp.kind === 'writing') return;
    const minutes = this.snap.status?.catchUp.minutesBefore ?? 0;
    this.publish({ error: null, catchUp: { kind: 'writing', requestId: null, minutesBefore: minutes } });
    try {
      const res = await this.deps.catchUp(id);
      if (id !== this.snap.meetingId) return;
      const current: CatchUpState = this.snap.catchUp as CatchUpState; // read again after the wait (TypeScript keeps the narrowing from before it)
      if (current.kind !== 'writing') return;
      this.publish({ catchUp: { kind: 'writing', requestId: res.requestId, minutesBefore: res.minutesBefore } });
      const early = this.early.get(res.requestId);
      if (early) {
        this.early.delete(res.requestId);
        this.handlePush(early.push);
      }
      this.deps.setTimeout(() => {
        const c = this.snap.catchUp;
        if (c.kind === 'writing' && c.requestId === res.requestId) this.publish({ catchUp: { kind: 'failed', minutesBefore: c.minutesBefore, text: 'The summary did not come. Try again.' } });
      }, CATCH_UP_WAIT_MS);
    } catch (e) {
      if (id !== this.snap.meetingId) return;
      this.publish({ catchUp: { kind: 'idle' }, error: refusal(e, 'Could not ask for a summary. Try again.') });
    }
  }

  /** Starts Catch me up again after a summary was shown (Close, then ask again later). */
  dismissCatchUp(): void {
    if (this.snap.catchUp.kind !== 'writing') this.publish({ catchUp: { kind: 'idle' } });
  }

  /** After `ASK_WAIT_MS` with no answer, a question says so instead of waiting forever. */
  private waitFor(askId: string): void {
    this.deps.setTimeout(() => {
      const now = this.snap.asks.find((a) => a.askId === askId);
      if (now?.state === 'asking') this.patch(now.key, { state: 'failed', text: 'No answer came. Look in the call’s thread, or ask again.' });
    }, ASK_WAIT_MS);
  }

  handlePush(push: { type: string; payload: unknown }): void {
    if (push.type === MEETING_ASK_PUSH) {
      const p = MeetingAskPush.safeParse(push.payload);
      if (!p.success || p.data.meetingId !== this.snap.meetingId) return;
      const item = this.snap.asks.find((a) => a.askId === p.data.askId);
      if (!item) {
        // this page is still sending a question: the push may be its own, so it waits for the POST's answer
        if (this.snap.asks.some((a) => a.askId === null)) return this.keepEarly(p.data.askId, push);
        // a question asked from another tab (or any other way): listed here as well, waiting or answered
        const added: AskItem = {
          key: `push-${p.data.askId}`,
          askId: p.data.askId,
          question: p.data.question || 'Your question',
          state: p.data.state,
          answererName: p.data.answererName,
          text: p.data.text,
        };
        this.publish({ asks: [added, ...this.snap.asks].slice(0, ASKS_KEPT) });
        if (p.data.state === 'asking') this.waitFor(p.data.askId);
        return;
      }
      // `asking` only says what the list already shows; an answer replaces "looking" or a give-up note; a later failure never replaces an answer
      if (p.data.state === 'asking' || item.state === 'answered') return;
      this.patch(item.key, { state: p.data.state, text: p.data.text, answererName: p.data.answererName });
      return;
    }
    if (push.type === MEETING_CATCHUP_PUSH) {
      const p = MeetingCatchUpPush.safeParse(push.payload);
      if (!p.success || p.data.meetingId !== this.snap.meetingId) return;
      const c = this.snap.catchUp;
      if (c.kind !== 'writing') return;
      if (c.requestId !== p.data.requestId) return c.requestId === null ? this.keepEarly(p.data.requestId, push) : undefined;
      this.publish({ catchUp: { kind: p.data.state, minutesBefore: p.data.minutesBefore, text: p.data.text } });
    }
  }

  private keepEarly(id: string, push: { type: string; payload: unknown }): void {
    const now = this.deps.now();
    for (const [k, v] of this.early) if (now - v.at > EARLY_MS) this.early.delete(k);
    if (this.early.size < 50) this.early.set(id, { at: now, push });
  }

  private patch(key: string, next: Partial<AskItem>): void {
    this.publish({ asks: this.snap.asks.map((a) => (a.key === key ? { ...a, ...next } : a)) });
  }
}

let store: AssistantStore | null = null;
export function assistantStore(): AssistantStore {
  store ??= new AssistantStore({
    status: fetchAssistantStatus,
    ask: askAssistant,
    catchUp: requestCatchUp,
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  });
  return store;
}

/**
 * The assistant of the call the page is in. `revision` is anything that changes what may be offered (a note-taker came, the person's answer to transcription changed):
 * a change asks the server again.
 */
export function useAssistant(meetingId: string | null, revision: string): AssistantSnapshot {
  const s = assistantStore();
  useEffect(() => {
    s.follow(meetingId);
  }, [s, meetingId]);
  useEffect(() => {
    if (meetingId) void s.refresh();
  }, [s, meetingId, revision]);
  return useSyncExternalStore(s.subscribe, s.snapshot, s.snapshot);
}

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ScheduledChangedPush, WS_SCHEDULED_CHANGED, type ScheduledMessage } from '@manythreads/shared';
import { cancelScheduled, editScheduled, fetchAllScheduled, fetchScheduled, scheduleMessage } from '../api/endpoints';
import { isApiError } from '../api/client';
import { onPersonChange } from '../app/caches';
import { isMockMode } from '../api/setup';
import { realtimeClient } from '../realtime';

/*
 * The client's copy of the person's own scheduled messages, one list per channel (PLAN P14-05, docs/plugins/channels.md). The channel strip, the
 * thread's strip and the composer's "Send later" read the same copy, so a message scheduled from one shows in the others at once. The server is the
 * truth: every write answers with the message as the server holds it, a `scheduled.changed` push (another tab, or the job that sends them) reads
 * the channel's list again, and so does a reconnect. A server without the feature answers 404 on the first fetch; the channel then shows nothing.
 */

export type ScheduledSnapshot = { status: 'loading' | 'ok' | 'off'; items: readonly ScheduledMessage[] };

const LOADING: ScheduledSnapshot = { status: 'loading', items: [] };

/** The key of the list of every scheduled message the person has, in any channel (the "Not sent" list); the other keys are channel ids. */
export const ALL_SCHEDULED = '*';

const bySendAt = (a: ScheduledMessage, b: ScheduledMessage): number => a.sendAt.localeCompare(b.sendAt) || a.id.localeCompare(b.id);

export class ScheduledStore {
  private readonly entries = new Map<string, ScheduledSnapshot>();
  private readonly listeners = new Set<() => void>();
  private readonly inflight = new Map<string, Promise<void>>();
  /** Lists asked to be read again while a read was already out: read once more when it ends, so the answer is never older than the push. */
  private readonly dirty = new Set<string>();
  private wired = false;
  /** Called with the push's channel and change when the job or another tab changed the list (the screen words a notice from it). */
  private readonly changeHooks = new Set<(channelId: string, change: ScheduledChangedPush['change']) => void>();

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  get = (channelId: string): ScheduledSnapshot => this.entries.get(channelId) ?? LOADING;
  private set(channelId: string, next: ScheduledSnapshot): void {
    this.entries.set(channelId, next);
    for (const l of [...this.listeners]) l();
  }

  onChange(cb: (channelId: string, change: ScheduledChangedPush['change']) => void): () => void {
    this.changeHooks.add(cb);
    return () => this.changeHooks.delete(cb);
  }

  reset(): void {
    this.entries.clear();
    this.inflight.clear();
    this.dirty.clear();
    for (const l of [...this.listeners]) l();
  }

  /** Listens to the tab's socket once, the first time a list is asked for: a push or a reconnect reads the lists in use again. */
  private wire(): void {
    if (this.wired || isMockMode()) return;
    this.wired = true;
    const rt = realtimeClient();
    rt.onPush((push) => {
      if (push.type !== WS_SCHEDULED_CHANGED) return;
      const p = ScheduledChangedPush.safeParse(push.payload);
      if (!p.success) return;
      void this.load(p.data.channelId, true);
      if (this.entries.has(ALL_SCHEDULED)) void this.load(ALL_SCHEDULED, true);
      for (const h of [...this.changeHooks]) h(p.data.channelId, p.data.change);
    });
    rt.onReconnected(() => {
      for (const id of [...this.entries.keys()]) void this.load(id, true);
    });
  }

  /**
   * Loads a list once (and again with `force`); concurrent calls share one request. A forced load that finds a request already out marks the list
   * dirty and reads it again when that request ends, so a push that arrives mid-flight is never lost.
   */
  load(key: string, force = false): Promise<void> {
    this.wire();
    const have = this.entries.get(key);
    if (have && have.status !== 'loading' && !force) return Promise.resolve();
    const running = this.inflight.get(key);
    if (running) {
      if (force) this.dirty.add(key);
      return running;
    }
    const read = key === ALL_SCHEDULED ? fetchAllScheduled() : fetchScheduled(key);
    const run = read.then(
      (res) => this.set(key, { status: 'ok', items: [...res.items].sort(bySendAt) }),
      (e: unknown) => {
        // no feature on this server, or a channel the person cannot see: show nothing (a failed refresh keeps what was shown)
        if (isApiError(e) && (e.status === 404 || e.status === 403)) this.set(key, { status: 'off', items: [] });
        else if (!have) this.set(key, { status: 'ok', items: [] });
      },
    );
    const tracked = run.then(async () => {
      this.inflight.delete(key);
      if (this.dirty.delete(key)) await this.load(key, true);
    });
    this.inflight.set(key, tracked);
    return tracked;
  }

  private put(item: ScheduledMessage): void {
    for (const key of [item.channelId, ALL_SCHEDULED]) {
      // the list of every channel is kept only if it was asked for
      if (key === ALL_SCHEDULED && !this.entries.has(key)) continue;
      const have = this.get(key);
      this.set(key, { status: 'ok', items: [...have.items.filter((i) => i.id !== item.id), item].sort(bySendAt) });
    }
  }

  /** Schedules a message; resolves to it. Rejects with the server's sentence in `message` when refused. */
  async schedule(channelId: string, body: string, sendAt: Date, threadRootId: string | null, confirmBroadcast = false): Promise<ScheduledMessage> {
    const item = await scheduleMessage(channelId, {
      body,
      sendAt: sendAt.toISOString(),
      ...(threadRootId ? { threadRootId } : {}),
      // the writer agreed that @channel / @here will notify a big room; the job posts the message later with that agreement
      ...(confirmBroadcast ? { confirmBroadcast: true } : {}),
    } as Parameters<typeof scheduleMessage>[1]);
    this.put(item);
    return item;
  }

  async edit(item: ScheduledMessage, change: { body?: string; sendAt?: Date; confirmBroadcast?: boolean }): Promise<ScheduledMessage> {
    const next = await editScheduled(item.channelId, item.id, {
      ...(change.body !== undefined ? { body: change.body } : {}),
      ...(change.sendAt ? { sendAt: change.sendAt.toISOString() } : {}),
      ...(change.confirmBroadcast ? { confirmBroadcast: true } : {}),
    });
    this.put(next);
    return next;
  }

  async cancel(item: ScheduledMessage): Promise<void> {
    await cancelScheduled(item.channelId, item.id);
    for (const key of [item.channelId, ALL_SCHEDULED]) {
      if (key === ALL_SCHEDULED && !this.entries.has(key)) continue;
      this.set(key, { status: 'ok', items: this.get(key).items.filter((i) => i.id !== item.id) });
    }
  }
}

export const scheduledStore = new ScheduledStore();
onPersonChange(() => scheduledStore.reset());

/** The caller's scheduled and refused messages in a channel (threads included), or in every channel with `ALL_SCHEDULED`; loads them when first asked. */
export function useScheduled(channelId: string): ScheduledSnapshot {
  const snap = useSyncExternalStore(scheduledStore.subscribe, () => scheduledStore.get(channelId));
  useEffect(() => {
    void scheduledStore.load(channelId);
  }, [channelId]);
  return snap;
}

/** True when the server refused a schedule or an edit only because `@channel` / `@here` would notify a big room and the writer must agree. */
export const needsBroadcastAgreement = (e: unknown): boolean => isApiError(e) && e.code === 'broadcast_needs_confirmation';

/**
 * For the edit dialogs of the scheduled lists: an edit that names `@channel` / `@here` for a big room is refused until the writer agrees, and submitting the
 * same text again is the agreement (the sentence says so). A different text starts over. The thrown message is what the dialog shows.
 */
export function useAgreedEdit(): (item: ScheduledMessage, change: { body?: string; sendAt?: Date }, submitLabel: string) => Promise<void> {
  const asked = useRef<string | null>(null);
  return async (item, change, submitLabel) => {
    const text = change.body ?? item.body;
    try {
      await scheduledStore.edit(item, { ...change, ...(asked.current === text ? { confirmBroadcast: true } : {}) });
      asked.current = null;
    } catch (e) {
      if (needsBroadcastAgreement(e) && isApiError(e)) {
        asked.current = text;
        throw new Error(`${e.message.replace(/\s*Confirm to send it\.$/, '')} Press “${submitLabel}” again to agree.`);
      }
      asked.current = null;
      throw new Error(scheduledErrorText(e));
    }
  };
}

/** A sentence for a refused or failed write: the server's own words when it gave one. */
export function scheduledErrorText(e: unknown): string {
  if (isApiError(e) && e.status < 500 && e.message) return e.message.replace(/^sendAt: /, '').replace(/^body: /, '');
  return 'Could not save that. Try again.';
}

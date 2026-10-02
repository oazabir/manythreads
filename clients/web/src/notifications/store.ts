import {
  DEFAULT_NOTIFICATION_PREFS,
  NotificationCreatedPush,
  NotificationReadPush,
  type MarkNotificationsReadRequest,
  type Notification as InboxItem,
  type NotificationPrefs,
} from '@manythreads/shared';
import { isApiError } from '../api/client';
import {
  fetchNotificationPrefs,
  fetchNotificationSummary,
  fetchNotifications,
  markNotificationsRead,
  saveNotificationPrefs,
} from '../api/endpoints';
import { onPersonChange } from '../app/caches';
import type { Push, RealtimeClient } from '../realtime/socket';

/*
 * The bell's data (PLAN P3-16, docs/plugins/notifications.md): the unread count from `GET /api/notifications/summary` kept live by
 * `notification.created` / `notification.read`, the list the popover shows, and the person's settings. The summary route belongs to the
 * notifications plugin, so the bell feature-detects it: a server without it answers 404 and the bell stays out of the header.
 * A push is a hint, `GET /summary` the authoritative count (a reconnect refetches it).
 */

export type NotificationsSnapshot = {
  /** The server has the notifications plugin (known after the first summary answer). */
  supported: boolean;
  unread: number;
  items: readonly InboxItem[];
  /** `idle` until the popover is first opened. */
  itemsStatus: 'idle' | 'loading' | 'ok' | 'error';
  prefs: NotificationPrefs | null;
};

const INITIAL: NotificationsSnapshot = { supported: false, unread: 0, items: [], itemsStatus: 'idle', prefs: null };
const PAGE = 30;

/** What the browser says about operating-system alerts (`unsupported` when there is no Notification API, e.g. an old WebView). */
export type BrowserAlerts = 'unsupported' | 'default' | 'granted' | 'denied';
export function browserAlerts(): BrowserAlerts {
  try {
    if (typeof Notification === 'undefined') return 'unsupported';
    const p = Notification.permission;
    return p === 'granted' || p === 'denied' ? p : 'default';
  } catch {
    return 'unsupported';
  }
}

/** The line a notification makes in the popover and in an operating-system alert. */
export function notificationTitle(n: Pick<InboxItem, 'kind' | 'actorName' | 'channelName'>): string {
  const where = n.channelName ? ` in #${n.channelName.replace(/^#/, '')}` : '';
  if (n.kind === 'mention') return `${n.actorName} mentioned you${where}`;
  if (n.kind === 'reply') return `${n.actorName} replied in a thread${where}`;
  return `${n.actorName} sent you a message`;
}

export class NotificationStore {
  private snap: NotificationsSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private detach: Array<() => void> = [];
  private absent = false;
  /** Ids already counted, also while the list was never opened: a reply that became a mention is the same row, not a new one. */
  private readonly counted = new Set<string>();
  private settle: ReturnType<typeof setTimeout> | null = null;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = (): NotificationsSnapshot => this.snap;
  private set(next: Partial<NotificationsSnapshot>): void {
    this.snap = { ...this.snap, ...next };
    for (const l of [...this.listeners]) l();
  }

  reset(): void {
    this.absent = false;
    this.counted.clear();
    this.snap = INITIAL;
    for (const l of [...this.listeners]) l();
  }

  attach(client: RealtimeClient): void {
    this.detach.forEach((d) => d());
    this.detach = [
      client.onPush((p) => this.handlePush(p)),
      client.onReconnected(() => {
        void this.refreshSummary();
        if (this.snap.itemsStatus === 'ok') void this.loadItems();
      }),
    ];
  }

  handlePush(push: Push): void {
    if (push.type === 'notification.created') {
      const p = NotificationCreatedPush.safeParse(push.payload);
      if (!p.success) return;
      const { notification, browser } = p.data;
      const known = this.counted.has(notification.id) || this.snap.items.some((n) => n.id === notification.id);
      this.counted.add(notification.id);
      if (this.counted.size > 1_000) this.counted.delete(this.counted.values().next().value as string);
      // upsert by id: a reply or dm that became a mention replaces its row; only a new id raises the badge
      const items = known ? this.snap.items.map((n) => (n.id === notification.id ? notification : n)) : [notification, ...this.snap.items];
      this.set({
        supported: true,
        items: this.snap.itemsStatus === 'ok' || known ? items : this.snap.items,
        unread: known || notification.readAt !== null ? this.snap.unread : this.snap.unread + 1,
      });
      if (!known && browser) raiseAlert(notification);
      // the push is a hint, the summary the count: settle any drift a moment later
      if (this.settle) clearTimeout(this.settle);
      this.settle = setTimeout(() => void this.refreshSummary(), 1_500);
    } else if (push.type === 'notification.read') {
      const p = NotificationReadPush.safeParse(push.payload);
      if (!p.success) return;
      const at = new Date().toISOString();
      const ids = new Set<string>(p.data.ids);
      this.set({
        unread: p.data.unreadCount,
        items: this.snap.items.map((n) => (n.readAt === null && (p.data.all || ids.has(n.id)) ? { ...n, readAt: at } : n)),
      });
    }
  }

  async refreshSummary(): Promise<void> {
    if (this.absent) return;
    try {
      const s = await fetchNotificationSummary();
      this.set({ supported: true, unread: s.unreadCount });
    } catch (e) {
      if (isApiError(e) && (e.status === 404 || e.status === 403)) this.absent = true;
    }
  }

  async loadItems(): Promise<void> {
    if (this.snap.itemsStatus !== 'ok') this.set({ itemsStatus: 'loading' });
    try {
      const page = await fetchNotifications({ limit: PAGE });
      for (const n of page.items) this.counted.add(n.id);
      this.set({ items: page.items, itemsStatus: 'ok' });
    } catch {
      this.set({ itemsStatus: this.snap.items.length > 0 ? 'ok' : 'error' });
    }
  }

  /** Mark some (or, with no ids, all) read: the badge drops at once, the server's count settles it. */
  async markRead(ids?: readonly string[]): Promise<void> {
    const at = new Date().toISOString();
    const wanted = ids ? new Set(ids) : null;
    const fresh = this.snap.items.filter((n) => n.readAt === null && (wanted === null || wanted.has(n.id)));
    if (wanted !== null && fresh.length === 0) return;
    this.set({
      items: this.snap.items.map((n) => (n.readAt === null && (wanted === null || wanted.has(n.id)) ? { ...n, readAt: at } : n)),
      unread: wanted === null ? 0 : Math.max(0, this.snap.unread - fresh.length),
    });
    try {
      const res = await markNotificationsRead(wanted === null ? { all: true } : { ids: [...wanted] as Extract<MarkNotificationsReadRequest, { ids: unknown }>['ids'] });
      this.set({ unread: res.unreadCount });
    } catch {
      void this.refreshSummary();
    }
  }

  async loadPrefs(): Promise<void> {
    if (this.snap.prefs) return;
    try {
      this.set({ prefs: await fetchNotificationPrefs() });
    } catch {
      /* the popover then does not offer the alerts row */
    }
  }

  /** Turn operating-system alerts on or off for every kind (the popover's "Allow browser alerts?"). */
  async setBrowserAlerts(on: boolean): Promise<void> {
    const cur = this.snap.prefs ?? DEFAULT_NOTIFICATION_PREFS;
    const next: NotificationPrefs = {
      mention: { ...cur.mention, browser: on },
      reply: { ...cur.reply, browser: on },
      dm: { ...cur.dm, browser: on },
      mutedChannels: cur.mutedChannels,
    };
    this.set({ prefs: next });
    try {
      this.set({ prefs: await saveNotificationPrefs(next) });
    } catch {
      this.set({ prefs: cur });
      throw new Error('Could not save the setting');
    }
  }
}

/** The operating-system alert for a live notification, only when the person allowed them and is looking elsewhere. */
function raiseAlert(n: InboxItem): void {
  try {
    if (browserAlerts() !== 'granted') return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    new Notification(notificationTitle(n), { body: n.preview, tag: n.id });
  } catch {
    /* some WebViews have the constructor but refuse it: the in-app badge still shows */
  }
}

export const notificationStore = new NotificationStore();
onPersonChange(() => notificationStore.reset());

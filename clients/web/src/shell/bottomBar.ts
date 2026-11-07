import type { GetNotificationLevelsResponse } from '@manythreads/shared';
import { unreadLook } from './unreadLook';

/** The five entries of the phone's bottom bar, in order (P21-23). */
export type BarEntry = 'home' | 'messages' | 'activity' | 'search' | 'you';

/** Where the bar's links go: Home is the unread-threads inbox, Messages and Activity are the two phone pages. */
export const barPath = (slug: string, entry: 'home' | 'messages' | 'activity'): string => `/t/${slug}/${entry === 'home' ? 'threads' : entry === 'messages' ? 'dms' : 'activity'}`;

/** Which linked entry the page belongs to: a conversation under Messages, `/` and Threads under Home; any other page lights none. */
export function activeEntry(pathname: string, slug: string): 'home' | 'messages' | 'activity' | null {
  if (pathname === '/') return 'home';
  const base = `/t/${slug}/`;
  if (!pathname.startsWith(base)) return null;
  const section = pathname.slice(base.length).split('/')[0];
  if (section === 'threads') return 'home';
  if (section === 'dms' || section === 'dm') return 'messages';
  if (section === 'activity') return 'activity';
  return null;
}

const NO_TEXT_INPUT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image', 'hidden']);

/** Whether a focused element takes typed text, so the on-screen keyboard is (about to be) up and the bar steps aside. */
export function takesText(el: Element | null): boolean {
  if (!el) return false;
  const box = el as Partial<HTMLInputElement> & { isContentEditable?: boolean };
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return !box.readOnly && !box.disabled;
  if (tag === 'INPUT') return !NO_TEXT_INPUT.has((box.type ?? 'text').toLowerCase()) && !box.readOnly && !box.disabled;
  return box.isContentEditable === true;
}

/** Unread messages across the person's direct messages, quiet (notification level "nothing") conversations left out. */
export function dmUnreadTotal(
  items: ReadonlyArray<{ channel: { id: string }; unreadCount: number }>,
  unread: Readonly<Record<string, number>>,
  levels: GetNotificationLevelsResponse | null,
): number {
  let total = 0;
  for (const d of items) {
    const n = unread[d.channel.id] ?? d.unreadCount;
    if (n > 0 && unreadLook(n, levels, d.channel.id, 'dm').badge !== 'quiet') total += n;
  }
  return total;
}

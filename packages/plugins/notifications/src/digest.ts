import type { DigestMailGroup } from '@manythreads/sdk';
import { DIGEST_EXCERPT_MAX, DIGEST_MAX_ITEMS } from '@manythreads/shared';

// What goes into one email digest (PLAN P14-09): which unread items, in what order, grouped how, and in what words. Pure functions, so the rules can be
// tested without a database or a mail server. The job that finds the people and sends the mail is in digest-job.ts.

/** One unread notification, as the digest needs it. */
export interface DigestItem {
  notificationId: string;
  kind: 'mention' | 'reply' | 'dm';
  actorName: string;
  /** The notification's stored one-line preview (plain text). */
  preview: string;
  channelId: string;
  channelKind: string;
  channelName: string;
  messageId: string;
  threadRootId: string | null;
  createdAt: Date;
}

// Control characters, the marks that reorder text and zero-width characters are dropped: an excerpt is one plain printable line.
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** One line of at most `max` characters (code points) of text somebody wrote. Linear in the length of the input, which is cut first. */
export function oneLine(text: string, max: number): string {
  const line = text.slice(0, max * 8).replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim();
  const chars = [...line];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : chars.join('');
}

/** The excerpt of a message in the mail: at most 140 characters, one line, no control characters. The mail template escapes it again for HTML. */
export const excerptOf = (preview: string): string => oneLine(preview, DIGEST_EXCERPT_MAX) || 'New message';

const KIND_RANK: Record<DigestItem['kind'], number> = { mention: 0, dm: 1, reply: 2 };

/** The place an item is shown under: `#name` for a channel, otherwise "Direct message". */
export const placeOf = (item: Pick<DigestItem, 'channelKind' | 'channelName'>): string =>
  item.channelKind === 'channel' && item.channelName !== '' ? `#${oneLine(item.channelName.replace(/^#/, ''), 60)}` : 'Direct message';

export interface DigestPlan {
  /** What the mail lists, grouped by place; groups ordered by their newest item, items oldest first inside a group. */
  groups: Array<{ channelId: string; title: string; items: DigestItem[] }>;
  /** Unread items the person has in all (what the mail's subject counts). */
  total: number;
  /** How many items the mail lists. */
  shown: number;
  /** Items left out of the list ("and N more"). */
  more: number;
}

/**
 * Chooses at most `max` items: mentions first, then direct messages, then thread replies, the newest first within each kind. The chosen items are then
 * grouped by channel or conversation, so a person reads each place once.
 */
export function planDigest(items: readonly DigestItem[], max: number = DIGEST_MAX_ITEMS): DigestPlan {
  const ranked = [...items].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.createdAt.getTime() - a.createdAt.getTime());
  const chosen = ranked.slice(0, Math.max(0, max));
  const byPlace = new Map<string, DigestItem[]>();
  for (const item of chosen) byPlace.set(item.channelId, [...(byPlace.get(item.channelId) ?? []), item]);
  const newest = (list: readonly DigestItem[]): number => Math.max(...list.map((i) => i.createdAt.getTime()));
  const groups = [...byPlace.entries()]
    .map(([channelId, list]) => ({ channelId, title: placeOf(list[0]!), items: [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) }))
    .sort((a, b) => newest(b.items) - newest(a.items));
  return { groups, total: items.length, shown: chosen.length, more: items.length - chosen.length };
}

/** The link that opens a message on this site (ids only, the same `/open` page a browser push uses). */
export function messageLink(publicUrl: string, item: Pick<DigestItem, 'channelId' | 'messageId' | 'threadRootId'>): string {
  const params = new URLSearchParams({ channel: item.channelId, message: item.messageId });
  if (item.threadRootId) params.set('root', item.threadRootId);
  return `${publicUrl}/open?${params.toString()}`;
}

/** The groups of a plan as the mail template takes them. */
export function mailGroups(plan: DigestPlan, publicUrl: string): DigestMailGroup[] {
  return plan.groups.map((g) => ({
    title: g.title,
    items: g.items.map((i) => ({ sender: oneLine(i.actorName, 60) || 'Someone', excerpt: excerptOf(i.preview), url: messageLink(publicUrl, i) })),
  }));
}

/** The Account page section for notifications; joined with # where used, because the lint rule against raw hex colours reads "#acc" as one. */
export const ACCOUNT_ANCHOR = 'acc-notifications';

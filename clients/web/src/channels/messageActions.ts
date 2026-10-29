import type { DirectMessageSummary, NavChannelGroup } from '@manythreads/shared';
import { clock, dayLabel } from './format';

/*
 * The small, pure parts of the message actions (PLAN P14-12): the link a message is shared by, the time shown for an earlier version, and the
 * list of places a message can be forwarded to. The components that use them are `MessageRow` and `ForwardDialog`.
 */

/** What a link to one message names: the channel, the message, and for a reply the first message of its thread. */
export type MessageRef = { channelId: string; messageId: string; threadRootId: string | null };

/**
 * The address of a message, relative to the site: `/open?channel=<id>&message=<id>[&root=<id>]`. It carries only ids, so it leaks nothing
 * to someone who gets it by accident; opening it asks the server whether the person may read the message (see `OpenRoute`).
 */
export function messageLinkPath(ref: MessageRef): string {
  const params = new URLSearchParams({ channel: ref.channelId, message: ref.messageId });
  if (ref.threadRootId) params.set('root', ref.threadRootId);
  return `/open?${params.toString()}`;
}

/** The same address with the site in front, as it is copied. */
export const messageLinkUrl = (origin: string, ref: MessageRef): string => `${origin.replace(/\/+$/, '')}${messageLinkPath(ref)}`;

/** Copies text to the clipboard; false when the browser refuses (the caller then says so). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** When an earlier version was written: "Today 14:05", "Yesterday 09:30", "Monday 7 September 16:12". */
export const versionTime = (iso: string, now: Date = new Date()): string => `${dayLabel(iso, now)} ${clock(iso)}`;

/** A place a message can be forwarded to. */
export type ForwardTarget = { id: string; label: string; hint: string; kind: 'channel' | 'dm'; isPrivate: boolean };

/** The channels of each team's directory, in the order the sidebar shows them, with the team's name as the hint. */
export function channelTargets(directories: readonly { teamName: string; groups: readonly NavChannelGroup[] }[]): ForwardTarget[] {
  return directories.flatMap((d) =>
    d.groups.flatMap((g) =>
      g.channels.map((c): ForwardTarget => ({ id: c.id, label: `#${c.name.replace(/^#/, '')}`, hint: d.teamName, kind: 'channel', isPrivate: c.isPrivate })),
    ),
  );
}

/** The name of a conversation: the other people, or "Just you" for a conversation with oneself. */
export function dmLabel(dm: DirectMessageSummary, selfPersonId: string | null): string {
  const others = dm.participants.filter((p) => p.personId !== selfPersonId).map((p) => p.displayName);
  return others.length > 0 ? others.join(', ') : 'Just you';
}

export const dmTargets = (dms: readonly DirectMessageSummary[], selfPersonId: string | null): ForwardTarget[] =>
  dms.map((dm): ForwardTarget => ({ id: dm.channel.id, label: dmLabel(dm, selfPersonId), hint: 'Direct message', kind: 'dm', isPrivate: true }));

/** The targets whose name or hint contains what was typed (case does not matter); everything for an empty filter. */
export function filterTargets(targets: readonly ForwardTarget[], query: string): ForwardTarget[] {
  const q = query.trim().toLowerCase().replace(/^#/, '');
  if (q === '') return [...targets];
  return targets.filter((t) => t.label.toLowerCase().replace(/^#/, '').includes(q) || t.hint.toLowerCase().includes(q));
}

/** The newest message of the reader's own that the Up arrow in an empty composer may open for editing: not deleted, not a bot's Answer. */
export function lastEditableOwn(
  items: readonly { id: string; authorId: string; deletedAt: string | null; meta: { answer?: unknown } }[],
  selfActor: string | null,
): string | null {
  if (selfActor === null) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i];
    if (m && m.authorId === selfActor && m.deletedAt === null && m.meta.answer === undefined) return m.id;
  }
  return null;
}

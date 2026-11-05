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

/**
 * What a click inside a message row must leave alone (P21-26): controls, links, the toolbar and its menus, the editor, a poll, an Answer, a
 * picture, a mention chip, a channel reference, the author's name. Clicking anywhere else on a row that has a thread opens the thread.
 */
export const NO_THREAD_CLICK = [
  'a,button,textarea,.acts,.dlg-scrim,.vpop,.pcard-avatar',
  'input,select,label,summary,details,img,video,audio,iframe,[role=button],[role=menu],[contenteditable]',
  '.m,.chref,.show-more,.edit-box,.poll,.att,.atts,.who b,.an,.sf-message,.lp-card,.fwd,.msg-imgs,.edited-wrap',
].join(',');

/** A click on a message row opens its thread only for a plain single click on the row's own text, space and picture-free parts. */
export function rowClickOpensThread(a: {
  target: { closest: (selector: string) => unknown };
  /** The text the reader has selected inside this row ('' for none). */
  selectionText: string;
  /** `MouseEvent.detail`: 1 for a single click, 2 and up for the double and triple click that select words. */
  detail: number;
  mods: { ctrl: boolean; meta: boolean; shift: boolean; alt: boolean };
  editing: boolean;
  inThread: boolean;
  replyCount: number;
  hasOpen: boolean;
}): boolean {
  if (a.inThread || a.replyCount <= 0 || !a.hasOpen || a.editing || a.detail !== 1) return false;
  if (a.mods.ctrl || a.mods.meta || a.mods.shift || a.mods.alt) return false;
  if (a.selectionText !== '') return false;
  return a.target.closest(NO_THREAD_CLICK) === null;
}

/** The messages whose long text the reader opened with "Show more" in this tab: they stay open when the row is drawn again after scrolling away. */
const expandedRows = new Set<string>();
export const isExpanded = (messageId: string): boolean => expandedRows.has(messageId);
export function rememberExpanded(messageId: string): void {
  expandedRows.add(messageId);
}

/**
 * The sentence a reaction pill shows on hover: "Nadia, Omar and 3 others reacted with 👍". `names` are the people the reader can name (the
 * reader themselves reads "You"); `total` is the whole count, so people the reader cannot name are counted as others. Without any name the
 * sentence is only a count ("3 people reacted with 👍").
 */
export function reactorsText(names: readonly string[], total: number, emoji: string): string {
  const shown = names.slice(0, 3);
  const rest = Math.max(0, total - shown.length);
  if (shown.length === 0) return `${total} ${total === 1 ? 'person' : 'people'} reacted with ${emoji}`;
  const head = rest > 0 ? `${shown.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}` : shown.length === 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] ?? ''}`;
  return `${head} reacted with ${emoji}`;
}

/** What a key press on a focused message row does (P21-02); null for any other key. Modifiers other than Ctrl/Cmd+Shift+C are not ours. */
export function rowShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; isComposing: boolean }): 'edit' | 'reply' | 'copy-link' | null {
  if (e.isComposing || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (k === 'c' && e.shiftKey && (e.ctrlKey || e.metaKey) && !(e.ctrlKey && e.metaKey)) return 'copy-link';
  if (e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (k === 'e') return 'edit';
  if (k === 'r') return 'reply';
  return null;
}

/**
 * Whether Esc marks the open conversation read (P21-05): only when no menu, popover or dialog is open, no side panel is open, the reader is
 * not typing, and focus is on the page or in the message list. `openCount` counts the open menus, popovers and dialogs.
 */
export function escMarksRead(a: { openCount: number; focusInList: boolean; typing: boolean; panelOpen: boolean }): boolean {
  return a.openCount === 0 && a.focusInList && !a.typing && !a.panelOpen;
}

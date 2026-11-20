import type { ChannelMessage } from '@manythreads/shared';
import type { MessageChange } from './store';

/*
 * The rules of the pinned list (P31-07), kept apart from React so a test can run them, and the panel's type, which the channel details menu needs without
 * loading the panel.
 */

/** The type of the panel entry (`pins:<channelId>`); it is registered in `kernel/panel/builtins.tsx`. */
export const PINS_PANEL = 'pins';

/** How much of a pinned message the list shows: the start of its plain text, on one or two lines. */
export const PIN_EXCERPT_CHARS = 280;

/** The start of the message's plain text for the list, cut at a word near the limit. */
export function pinExcerpt(m: Pick<ChannelMessage, 'body' | 'bodyPlain'>): string {
  const text = (m.bodyPlain || m.body).replace(/\s+/g, ' ').trim();
  if (text.length <= PIN_EXCERPT_CHARS) return text;
  const cut = text.slice(0, PIN_EXCERPT_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > PIN_EXCERPT_CHARS - 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The pinned list of `channelId` reads again: a message of it was deleted (its pin went without a pin push) or edited (the text shown changed). A new message changes nothing. */
export function pinsListChanged(c: MessageChange, channelId: string): boolean {
  if (c.type === 'deleted') return c.channelId === channelId;
  return c.type === 'edited' && c.message.channelId === channelId;
}

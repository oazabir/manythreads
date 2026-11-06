import type { GetNotificationLevelsResponse } from '@manythreads/shared';
import { levelOf } from '../notifications/settingsModel';

/*
 * How a sidebar row shows unread messages. The count always comes from the read state. How loudly it shows follows the person's notification
 * level for that conversation: a conversation set to "nothing" keeps its count (grey, no bold label), because it must not call for attention.
 */

export type UnreadLook = { bold: boolean; badge: 'unread' | 'quiet' | 'mention' | null; muted?: boolean };

export function unreadLook(count: number, levels: GetNotificationLevelsResponse | null, channelId: string, channelKind: 'channel' | 'dm', mentioned = false): UnreadLook {
  const quiet = levelOf(levels, channelId, channelKind).effective === 'nothing';
  if (count <= 0) return quiet ? { bold: false, badge: null, muted: true } : { bold: false, badge: null };
  if (quiet) return { bold: false, badge: 'quiet', muted: true };
  // a direct message is always addressed to you: red. A channel is red only when somebody mentioned you in it (`mentioned`), else blue.
  return { bold: true, badge: channelKind === 'dm' || mentioned ? 'mention' : 'unread' };
}

/** The count a badge shows: large numbers stay short. */
export const badgeText = (n: number): string => (n > 99 ? '99+' : String(n));

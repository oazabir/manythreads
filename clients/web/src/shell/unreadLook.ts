import type { GetNotificationLevelsResponse } from '@manythreads/shared';
import { levelOf } from '../notifications/settingsModel';

/*
 * How a sidebar row shows unread messages. The count always comes from the read state. How loudly it shows follows the person's notification
 * level for that conversation: a conversation set to "nothing" keeps its count (grey, no bold label), because it must not call for attention.
 */

export type UnreadLook = { bold: boolean; badge: 'unread' | 'quiet' | null };

export function unreadLook(count: number, levels: GetNotificationLevelsResponse | null, channelId: string, channelKind: 'channel' | 'dm'): UnreadLook {
  if (count <= 0) return { bold: false, badge: null };
  const quiet = levelOf(levels, channelId, channelKind).effective === 'nothing';
  return quiet ? { bold: false, badge: 'quiet' } : { bold: true, badge: 'unread' };
}

/** The count a badge shows: large numbers stay short. */
export const badgeText = (n: number): string => (n > 99 ? '99+' : String(n));

import { useEffect, useRef } from 'react';
import { InboxItemChangedPush, WS_INBOX_ITEM_CHANGED } from '@manythreads/shared';
import { isMockMode } from '../../api/setup';
import { realtimeClient } from '../../realtime';

/** What a live push says about an item: which team, which item, and where it is now. Anything else (or a push of another kind) is left out. */
export function parseInboxPush(push: { type: string; payload: Record<string, unknown> }): InboxItemChangedPush | null {
  if (push.type !== WS_INBOX_ITEM_CHANGED) return null;
  const parsed = InboxItemChangedPush.safeParse(push.payload);
  return parsed.success ? parsed.data : null;
}

/**
 * Calls `onChange` whenever the server says one of the person's own drops moved (queued, held, filed, failed). The server tells only the person who dropped
 * it, so a team-mate's drop shows up on the next look at the list. Mock mode has no socket.
 */
export function useInboxPush(onChange: (change: InboxItemChangedPush) => void): void {
  const handler = useRef(onChange);
  useEffect(() => {
    handler.current = onChange;
  });
  useEffect(() => {
    if (isMockMode()) return;
    return realtimeClient().onPush((push) => {
      const change = parseInboxPush(push);
      if (change) handler.current(change);
    });
  }, []);
}

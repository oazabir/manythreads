import { useEffect, useRef, useState } from 'react';
import { CardActivityChangedPush, cardActivityChangedPushType, type CardActivityResponse } from '@manythreads/shared';
import { isMockMode } from '../../api/setup';
import { realtimeClient } from '../../realtime';
import { fetchCardActivity } from './api';

/*
 * Which bots are working on which cards (PLAN P6-13). The server's list is the truth; a push of `tasks.activity.changed` is only a hint to
 * read it again. It is read when the board opens (so a refresh is never stale), on the hint (after a short wait, so a burst of runs is one read),
 * after the socket reconnects, and when the tab comes back to the front.
 */

export type CardBot = { actorId: string; phase: 'running' | 'queued' };

const DEBOUNCE_MS = 400;

/** The list as a map from card id to its bots. */
export const botsByCard = (res: CardActivityResponse): Map<string, CardBot[]> => new Map(res.items.map((i) => [i.taskId as string, i.bots.map((b) => ({ actorId: b.actorId as string, phase: b.phase }))]));

export function useCardActivity(slug: string, teamId: string): Map<string, CardBot[]> {
  const [bots, setBots] = useState<Map<string, CardBot[]>>(() => new Map());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (isMockMode()) return () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (): void => {
      fetchCardActivity(slug)
        .then((res) => {
          if (alive.current) setBots(botsByCard(res));
        })
        .catch(() => undefined);
    };
    const soon = (): void => {
      clearTimeout(timer);
      timer = setTimeout(read, DEBOUNCE_MS);
    };
    const visible = (): void => {
      if (document.visibilityState === 'visible') soon();
    };
    read();
    const rt = realtimeClient();
    const offPush = rt.onPush((push) => {
      if (push.type !== cardActivityChangedPushType) return;
      const parsed = CardActivityChangedPush.safeParse(push.payload);
      if (!parsed.success || parsed.data.teamId === teamId) soon();
    });
    const offReconnect = rt.onReconnected(soon);
    document.addEventListener('visibilitychange', visible);
    return () => {
      alive.current = false;
      clearTimeout(timer);
      offPush();
      offReconnect();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [slug, teamId]);
  return bots;
}

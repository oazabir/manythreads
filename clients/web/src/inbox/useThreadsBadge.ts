import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { WS_RUN_ENDED, WS_RUN_STARTED } from '@manythreads/shared';
import { isMockMode } from '../api/setup';
import { useUnread } from '../channels/hooks';
import { realtimeClient } from '../realtime';
import { fetchThreadMentions, fetchThreadsRunning } from './api';

/** What the sidebar's Threads entry adds to the unread count it always had: the threads that wait on the person by a mention, and the threads where a run is going. */
export interface ThreadsBadge {
  mentions: number;
  running: number;
}
const NONE: ThreadsBadge = { mentions: 0, running: 0 };

/** A burst of reasons to read again makes one read, this long after the first. */
const SETTLE_MS = 500;

/**
 * The two extra counts of the Threads entry (P29-19). No new polling: they are read once, and again when something the page already hears says they may have changed: the unread summary moved (a message
 * arrived), a run began or ended, the socket came back, the person moved to another page (an answer they wrote clears a mention), or the tab became visible. A server without the plugin answers an error
 * and that count simply stays at nothing. Approvals are not counted here: they have their own entry.
 */
export function useThreadsBadge(slug: string | null): ThreadsBadge {
  const [state, setState] = useState<{ slug: string | null; badge: ThreadsBadge }>({ slug: null, badge: NONE });
  const { threadsUnread } = useUnread();
  const path = useLocation().pathname;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useRef<() => void>(() => undefined);

  useEffect(() => {
    load.current = () => {
      if (!slug || isMockMode()) return;
      void Promise.all([
        fetchThreadMentions(slug).then((r) => r.mentions, () => null),
        fetchThreadsRunning(slug).then((r) => r.threads, () => null),
      ]).then(([mentions, running]) =>
        setState((s) => {
          const was = s.slug === slug ? s.badge : NONE;
          const next = { mentions: mentions ?? was.mentions, running: running ?? was.running };
          return s.slug === slug && was.mentions === next.mentions && was.running === next.running ? s : { slug, badge: next };
        }),
      );
    };
  }, [slug]);

  const soon = useRef(() => {
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      load.current();
    }, SETTLE_MS);
  });

  // the first read, and a new team
  useEffect(() => {
    load.current();
  }, [slug]);
  // the unread summary moved, or the person went to another page
  useEffect(() => {
    soon.current();
  }, [threadsUnread, path]);
  useEffect(() => {
    if (!slug || isMockMode()) return;
    const rt = realtimeClient();
    const trigger = soon.current;
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') trigger();
    };
    document.addEventListener('visibilitychange', onVisible);
    const off = [
      rt.onPush((p) => {
        if (p.type === WS_RUN_STARTED || p.type === WS_RUN_ENDED) trigger();
      }),
      rt.onReconnected(trigger),
    ];
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      off.forEach((o) => o());
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [slug]);

  return state.slug === slug ? state.badge : NONE;
}

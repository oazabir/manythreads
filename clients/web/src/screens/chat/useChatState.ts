import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatThreadState } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { fetchChatState } from './api';

const RETRY_MS = 700;
const RETRIES = 6;

/**
 * One conversation's state (which answers it has, the thumbs the person gave, the model, the run that is answering). The server's index of a conversation
 * trails a new message by a moment, so a 404 for a conversation that was just started is asked again a few times.
 */
export function useChatState(team: string, bot: string, root: string | null): { state: ChatThreadState | null; reload: () => void; patch: (fn: (s: ChatThreadState) => ChatThreadState) => void } {
  const [state, setState] = useState<ChatThreadState | null>(null);
  const [tick, setTick] = useState(0);
  const forRoot = useRef<string | null>(null);
  useEffect(() => {
    if (forRoot.current !== root) {
      forRoot.current = root;
      setState(null);
    }
    if (root === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number): void => {
      fetchChatState({ team, bot, root }).then(
        (s) => live && setState(s),
        (err: unknown) => {
          if (live && isApiError(err) && err.status === 404 && n < RETRIES) timer = setTimeout(() => attempt(n + 1), RETRY_MS);
        },
      );
    };
    attempt(0);
    // a new answer is recorded by the index a moment after it is posted: read once more
    const later = setTimeout(() => attempt(RETRIES), 1_200);
    return () => {
      live = false;
      clearTimeout(timer);
      clearTimeout(later);
    };
  }, [team, bot, root, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const patch = useCallback((fn: (s: ChatThreadState) => ChatThreadState) => setState((s) => (s ? fn(s) : s)), []);
  return { state, reload, patch };
}

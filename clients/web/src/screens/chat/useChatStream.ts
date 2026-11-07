import { useEffect, useReducer, useRef } from 'react';
import { isMockMode } from '../../api/setup';
import { realtimeClient } from '../../realtime';
import { applyFrame, frameOf, NO_PREVIEW, type Frame, type Preview } from './model';

/**
 * The live preview of the answer being written in one conversation (PLAN P20-16): the server pushes `run.delta`, `run.looking` and `run.ended` to the
 * person who asked. The preview is dropped when the conversation changes. The final answer is the message the run posts; this is only what shows
 * until it arrives. Mock mode has no socket.
 */
export function useChatStream(thread: string | null): { preview: Preview; reset: () => void } {
  type Action = Frame | { type: 'reset' };
  const [preview, dispatch] = useReducer(
    (state: Preview, action: Action & { thread: string | null }): Preview => {
      if (action.type === 'reset' || action.thread === null) return NO_PREVIEW;
      return applyFrame(state, action, action.thread);
    },
    NO_PREVIEW,
  );
  const current = useRef(thread);
  useEffect(() => {
    current.current = thread;
    dispatch({ type: 'reset', thread });
  }, [thread]);
  useEffect(() => {
    if (isMockMode() || thread === null) return;
    return realtimeClient().onPush((push) => {
      const frame = frameOf(push);
      if (frame) dispatch({ ...frame, thread });
    });
  }, [thread]);
  return { preview, reset: () => dispatch({ type: 'reset', thread: current.current }) };
}

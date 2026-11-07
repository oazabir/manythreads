import { useEffect, useReducer, useRef } from 'react';
import { isMockMode } from '../../api/setup';
import { realtimeClient } from '../../realtime';
import { applyFrame, frameOf, holdEarly, NO_PREVIEW, takeEarly, type Frame, type Preview } from './model';

/**
 * The live preview of the answer being written in one conversation (PLAN P20-16): the server pushes `run.delta`, `run.looking` and `run.ended` to the
 * person who asked. The preview is dropped when the conversation changes. The final answer is the message the run posts; this is only what shows
 * until it arrives. A new chat has no thread until its first message is answered by the server: frames that come meanwhile are kept and replayed for the
 * thread that opens. Mock mode has no socket.
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
  const early = useRef<Frame[]>([]);
  useEffect(() => {
    current.current = thread;
    dispatch({ type: 'reset', thread });
    if (thread === null) return;
    const mine = takeEarly(early.current, thread);
    early.current = [];
    for (const frame of mine) dispatch({ ...frame, thread });
  }, [thread]);
  // one subscription for the life of the screen: the thread it serves is read when a frame arrives
  useEffect(() => {
    if (isMockMode()) return;
    return realtimeClient().onPush((push) => {
      const frame = frameOf(push);
      if (!frame) return;
      const open = current.current;
      if (open === null) early.current = holdEarly(early.current, frame);
      else dispatch({ ...frame, thread: open });
    });
  }, []);
  return { preview, reset: () => dispatch({ type: 'reset', thread: current.current }) };
}

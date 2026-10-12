import { useEffect, useRef } from 'react';
import { ApprovalChangedPush, approvalChangedPushType } from '@manythreads/shared';
import { isMockMode } from '../../api/setup';
import { realtimeClient } from '../../realtime';

/*
 * "Something about the approvals changed": a push from the server (an approval was raised or settled in a team the person is on) or a decision
 * made in this tab. It is a hint to refetch, never data — the list and the count are what the server says when asked.
 */

const local = new Set<(teamId: string | null) => void>();

/** This tab decided something: the count in the sidebar and any open card refetch, without waiting for the push to come back. */
export function announceApprovalsChanged(): void {
  for (const l of [...local]) l(null);
}

/** Calls `onChange` when approvals changed (the team's id when the server said which, else null) and after the socket reconnects. */
export function useApprovalsChanged(onChange: (teamId: string | null) => void): void {
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    const fire = (teamId: string | null): void => latest.current(teamId);
    local.add(fire);
    const offs: Array<() => void> = [() => local.delete(fire)];
    if (!isMockMode()) {
      const rt = realtimeClient();
      offs.push(
        rt.onPush((push) => {
          if (push.type !== approvalChangedPushType) return;
          const parsed = ApprovalChangedPush.safeParse(push.payload);
          fire(parsed.success ? parsed.data.teamId : null);
        }),
        rt.onReconnected(() => fire(null)),
      );
    }
    return () => offs.forEach((off) => off());
  }, []);
}

/**
 * An approved call is re-run a moment later, in a job: while any card on screen says it is still `queued`, ask again every couple of
 * seconds. The push usually gets there first; this is what keeps the card honest when it does not (a socket that is down, a slow job).
 */
export function usePollWhileQueued(queued: boolean, reload: () => void): void {
  useEffect(() => {
    if (!queued) return;
    const timer = setInterval(reload, 2_000);
    return () => clearInterval(timer);
  }, [queued, reload]);
}

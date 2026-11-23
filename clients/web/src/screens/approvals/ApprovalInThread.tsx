import { useEffect, useRef, useState } from 'react';
import type { Approval } from '@manythreads/shared';
import { ThreadBody } from '../../channels/ThreadPanel';
import { ApprovalCard } from './ApprovalCard';

/*
 * An approval read in the inbox, in its context (owner 2026-11-23: "the right side view only shows the approval message; it should show the thread where
 * the approval is waiting, and highlight the approval"). The thread the approval was raised in is drawn as the Threads view draws one, and the approval
 * inside it (the question strip above the composer, a run card's question, or the card under the replies once settled: each carries `data-approval`) is
 * scrolled into view and highlighted. When the thread does not draw it within a few seconds (a strip that hides an answered card, a thread still loading),
 * the card itself is shown above the thread, so the request and its buttons are never lost.
 */

const FIND_MS = 4000;
const STEP_MS = 150;

export function ApprovalInThread({ approval, slug, onDecided }: { approval: Approval; slug: string; onDecided: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [found, setFound] = useState<'looking' | 'found' | 'missing'>('looking');

  useEffect(() => {
    setFound('looking');
    let marked: HTMLElement | null = null;
    const started = Date.now();
    const look = (): boolean => {
      const el = box.current?.querySelector<HTMLElement>(`.apr-in-thread-body [data-approval="${CSS.escape(approval.id)}"]`) ?? null;
      if (!el) return false;
      marked = el;
      el.dataset['highlight'] = 'true';
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setFound('found');
      return true;
    };
    const timer = setInterval(() => {
      if (look()) clearInterval(timer);
      else if (Date.now() - started > FIND_MS) {
        clearInterval(timer);
        setFound('missing');
      }
    }, STEP_MS);
    return () => {
      clearInterval(timer);
      if (marked) delete marked.dataset['highlight'];
    };
  }, [approval.id, approval.status]);

  return (
    <div className="apr-in-thread" ref={box} data-testid="approval-thread" data-approval-shown={found}>
      {found === 'missing' ? (
        <div className="apr-in-thread-card">
          <ApprovalCard key={`${approval.id}:${approval.status}:${approval.outcome}`} approval={approval} slug={slug} onDecided={onDecided} />
        </div>
      ) : null}
      <div className="apr-in-thread-body">
        <ThreadBody key={approval.threadRootId ?? ''} rootId={approval.threadRootId ?? ''} variant="main" channelId={approval.channelId} />
      </div>
    </div>
  );
}

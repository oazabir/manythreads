import { useEffect } from 'react';
import { useBlocker } from 'react-router';
import { Dialog } from '../../components/Dialog';

/**
 * Leaving the bot page with unsaved changes (P21-17). A move to another page asks "Leave without saving?" (react-router's blocker, so the
 * Back button is covered as well); closing or reloading the tab gets the browser's own prompt. Moving between the page's own groups
 * (`?tab=`) keeps the same path and is never stopped.
 */
export function LeaveGuard({ dirty }: { dirty: boolean }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = ''; // older browsers only show their prompt when this is set
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty]);

  // a save finished while the question was open: nothing is left to lose
  useEffect(() => {
    if (blocker.state === 'blocked' && !dirty) blocker.proceed();
  }, [blocker, dirty]);

  if (blocker.state !== 'blocked' || !dirty) return null;
  return (
    <Dialog
      title="Leave without saving?"
      testId="leave-dialog"
      onClose={() => blocker.reset()}
      footer={
        <>
          <button type="button" className="btn" data-testid="leave-stay" onClick={() => blocker.reset()}>Keep editing</button>
          <button type="button" className="btn primary" data-testid="leave-confirm" onClick={() => blocker.proceed()}>Leave without saving</button>
        </>
      }
    >
      <p>Your changes to this bot have not been saved. If you leave now they are lost.</p>
    </Dialog>
  );
}

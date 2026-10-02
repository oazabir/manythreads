import { useState } from 'react';
import { isApiError } from '../api/client';
import { fetchChannel, fetchThreadInbox, joinChannel } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { useSession } from '../app/session';
import { useChannelFeed } from '../shell/channelFeed';
import { CloseIcon } from '../shell/icons';

/*
 * The first-day checklist of the Threads home for members (PLAN P3-14): join #general, follow a thread, ask Brain. Dismissing it is
 * remembered per person in this browser (localStorage, which may be blocked: the card then simply comes back next visit).
 * The Brain step is inert until Brain exists.
 */
const KEY = (personId: string): string => `manythreads.welcome.dismissed.${personId}`;

function wasDismissed(personId: string): boolean {
  try {
    return window.localStorage.getItem(KEY(personId)) === '1';
  } catch {
    return false;
  }
}

function Step({ done, label, children }: { done: boolean; label: string; children?: React.ReactNode }) {
  return (
    <li className={`wc-step ${done ? 'done' : ''}`} data-testid="welcome-step" data-done={done}>
      <span className="wc-box" aria-hidden="true">{done ? '✓' : ''}</span>
      <span className="wc-label">{label}</span>
      <span className="wc-aside">{children}</span>
    </li>
  );
}

export function WelcomeCard({ slug }: { slug: string }) {
  const session = useSession();
  const personId = session.person.id;
  const [dismissed, setDismissed] = useState(() => wasDismissed(personId));
  const feed = useChannelFeed(dismissed ? null : slug);
  const general = feed.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === 'general');
  const member = useQuery(`welcome-member:${general?.id ?? ''}`, async () => (general ? (await fetchChannel(general.id)).isMember : null));
  const followed = useQuery(`welcome-followed:${slug}`, async () => {
    try {
      return (await fetchThreadInbox(slug, 'followed')).items.length > 0;
    } catch (e) {
      if (isApiError(e) && e.status === 404) return null;
      throw e;
    }
  });
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (dismissed || session.role === 'guest') return null;

  const dismiss = (): void => {
    setDismissed(true);
    try {
      window.localStorage.setItem(KEY(personId), '1');
    } catch {
      /* blocked storage: the card is gone for this page only */
    }
  };
  const join = async (): Promise<void> => {
    if (!general || joining) return;
    setJoining(true);
    setError(null);
    try {
      await joinChannel(general.id);
      setJoined(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not join the channel.');
    } finally {
      setJoining(false);
    }
  };
  const first = session.person.name.trim().split(/\s+/)[0] ?? session.person.name;
  const joinDone = joined || (member.status === 'ok' && member.data === true);
  return (
    <section className="welcome" aria-label="Welcome" data-testid="welcome-card">
      <header className="wc-head">
        <h2 className="wc-title">{`Welcome, ${first}`}</h2>
        <button type="button" className="icon-btn" aria-label="Dismiss welcome" onClick={dismiss}><CloseIcon /></button>
      </header>
      <ul className="wc-steps">
        <Step done={joinDone} label="Join #general">
          {!joinDone && general ? <button type="button" className="btn s" disabled={joining} onClick={() => void join()}>Join</button> : null}
        </Step>
        <Step done={followed.status === 'ok' && followed.data === true} label="Follow a thread">
          {followed.status === 'ok' && followed.data === true ? null : <span className="wc-hint">Open a thread and turn on Follow</span>}
        </Step>
        <li className="wc-step inert" data-testid="welcome-step" data-done="false" aria-disabled="true">
          <span className="wc-box" aria-hidden="true" />
          <span className="wc-label">Ask Brain</span>
          <span className="wc-aside"><span className="wc-hint">Available soon</span></span>
        </li>
      </ul>
      {error ? <p className="wc-error" role="alert">{error}</p> : null}
    </section>
  );
}

import { useState } from 'react';
import { Link } from 'react-router';
import { dismissOnboarding } from '../api/endpoints';
import { isApiError } from '../api/client';
import { isAdmin, useSession } from '../app/session';
import { announceOnboardingChange, useOnboarding } from '../screens/onboarding/useOnboarding';

/*
 * The setup checklist in the sidebar (PLAN P10-01): for workspace admins only, from the first sign-in until they put it away, and it can be put away
 * only after the first goal went to Brain (the server refuses before that, and this card offers the button only when every required step is done).
 * The count and the next step are derived from real facts (screens/onboarding/steps.ts), the same as the wizard's. For everyone else, and once it
 * is put away, this renders nothing and reads nothing beyond the checklist's own state.
 */

export function SetupCard() {
  const session = useSession();
  return isAdmin(session) ? <Card /> : null;
}

function Card() {
  const view = useOnboarding('card');
  const [error, setError] = useState<string | null>(null);
  if (view.status !== 'ok' || view.summary.dismissed) return null;
  const { summary } = view;
  const pct = Math.round((summary.handled / summary.total) * 100);
  return (
    <aside className="region ob-card" data-landmark="setup-checklist" data-finished={summary.finished ? 'true' : 'false'} aria-label="Setup checklist">
      <div className="ob-card-title">
        <span>{summary.finished ? 'Setup is done' : 'Finish setting up'}</span>
        <span className="cnt" data-testid="setup-card-count">{summary.handled} of {summary.total}</span>
      </div>
      <div className="ob-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
      {summary.finished ? (
        <>
          <p>Your first question went to Brain. Put this away when you are ready.</p>
          {summary.firstTeam ? <Link to={`/t/${summary.firstTeam.slug}/files`}>Drop a document in {summary.firstTeam.name}'s files</Link> : null}
          <button
            type="button"
            className="btn"
            onClick={() => {
              setError(null);
              dismissOnboarding().then(announceOnboardingChange, (e: unknown) => setError(isApiError(e) ? e.message : 'Could not put it away.'));
            }}
          >
            Put it away
          </button>
          {error ? <p role="alert">{error}</p> : null}
        </>
      ) : (
        <p>
          Next: <Link to="/onboarding">{summary.next ? `${summary.next.title}` : 'Setup'}</Link>
        </p>
      )}
    </aside>
  );
}

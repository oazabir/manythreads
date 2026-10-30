import { isApiError } from '../../api/client';
import { fetchDlpPolicy, fetchTeamEgress } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { ForbiddenBody } from '../../components/states';
import { DlpSection } from './DlpSection';
import { EgressSection } from './EgressSection';

/**
 * Settings, Data protection. What happens to text that is about to leave the workspace when it holds a secret or personal data, and which hosts each
 * team's bots may reach. Only workspace owners and admins can open it. Nothing here shows text that was matched: the page deals in the kinds of
 * thing found, counts and names.
 */
export function Guardrails() {
  const policy = useQuery('guardrails-dlp', fetchDlpPolicy);
  const egress = useQuery('guardrails-egress', fetchTeamEgress);

  const forbidden = (policy.status === 'error' && isApiError(policy.error) && policy.error.status === 403) || (egress.status === 'error' && isApiError(egress.error) && egress.error.status === 403);
  if (forbidden) {
    return (
      <div className="gr-page" data-landmark="guardrails">
        <div className="inline-state"><ForbiddenBody /></div>
      </div>
    );
  }

  return (
    <div className="gr-page" data-landmark="guardrails">
      <h1 className="pane-title" data-landmark="title">Data protection</h1>
      <p className="lede" data-landmark="lede">
        Choose what happens when a bot is about to send out a password, a key or personal data, and which web hosts each team&rsquo;s bots may reach.
        It applies to what bots write through their tools and to what they read back. The Audit page records each time it acts, naming the kind of thing found and never the text itself.
      </p>
      {policy.status === 'loading' ? <p className="loading" aria-busy="true">Loading…</p> : null}
      {policy.status === 'error' ? (
        <div className="inline-state">
          <p>The data-loss settings could not be loaded.</p>
          <button type="button" className="btn" onClick={policy.reload}>Try again</button>
        </div>
      ) : null}
      {policy.status === 'ok' ? <DlpSection policy={policy.data} reload={policy.reload} /> : null}
      {egress.status === 'loading' ? <p className="loading" aria-busy="true">Loading…</p> : null}
      {egress.status === 'error' ? (
        <div className="inline-state">
          <p>The team host lists could not be loaded.</p>
          <button type="button" className="btn" onClick={egress.reload}>Try again</button>
        </div>
      ) : null}
      {egress.status === 'ok' ? <EgressSection data={egress.data} reload={egress.reload} /> : null}
    </div>
  );
}

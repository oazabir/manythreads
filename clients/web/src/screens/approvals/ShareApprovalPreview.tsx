import { MEMORY_SHARE_ACCEPT_TOOL, type Approval } from '@manythreads/shared';
import { acceptView, digestView } from './shareApproval';

/**
 * What an approver reads before deciding a memory-sharing request: for a request to receive another team's share, who it is from and what it picks; for a digest,
 * where it goes, how much it holds, what it leaves out and why, and what changed since last time. Titles and reasons only: the text of a concept is never in it.
 */
export function ShareApprovalPreview({ approval }: { approval: Pick<Approval, 'tool' | 'argsPreview'> }) {
  if (approval.tool === MEMORY_SHARE_ACCEPT_TOOL) {
    const view = acceptView(approval.argsPreview);
    return (
      <div className="apr-share" data-testid="share-accept-preview">
        <dl className="apr-preview">
          {view.rows.map((r) => (
            <div key={r.label} className="apr-kv">
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
        <p className="apr-share-note">{view.note}</p>
      </div>
    );
  }
  const view = digestView(approval.argsPreview);
  return (
    <div className="apr-share" data-testid="share-digest-preview">
      <dl className="apr-preview">
        <div className="apr-kv">
          <dt>Goes to</dt>
          <dd data-testid="share-digest-to">{view.to.length > 0 ? view.to.map((t) => `${t.team}${t.link && t.link !== 'accepted' ? ` (${t.link})` : ''}`).join(', ') : 'No team'}</dd>
        </div>
        {view.mode ? (
          <div className="apr-kv">
            <dt>It holds</dt>
            <dd>{view.mode}{view.period ? ` · ${view.period}` : ''}</dd>
          </div>
        ) : null}
        <div className="apr-kv">
          <dt>How much</dt>
          <dd data-testid="share-digest-counts"><strong>{view.headline}</strong><br />{view.counts}</dd>
        </div>
        <div className="apr-kv">
          <dt>Since last time</dt>
          <dd data-testid="share-digest-diff">{view.diff}</dd>
        </div>
      </dl>
      {view.included.length > 0 ? (
        <details className="apr-share-more">
          <summary data-testid="share-digest-included-toggle">What goes ({String(view.included.length)} listed)</summary>
          <ul className="apr-share-list" data-testid="share-digest-included">
            {view.included.map((t, i) => <li key={`${t}-${String(i)}`}>{t}</li>)}
          </ul>
        </details>
      ) : null}
      {view.leftOut.length > 0 ? (
        <details className="apr-share-more">
          <summary data-testid="share-digest-left-out-toggle">What is left out and why</summary>
          <ul className="apr-share-list" data-testid="share-digest-left-out">
            {view.leftOut.map((g) => (
              <li key={g.words}>
                {String(g.titles.length)} {g.titles.length === 1 ? 'concept' : 'concepts'}: {g.words}
                <ul>{g.titles.slice(0, 8).map((t, i) => <li key={`${t}-${String(i)}`}>{t}</li>)}</ul>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {view.more ? <p className="apr-share-note">{view.more}.</p> : null}
    </div>
  );
}

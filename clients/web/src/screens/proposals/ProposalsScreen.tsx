import type { Proposal, ProposalDetail } from '@manythreads/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '../../app/useQuery';
import { QueryView, EmptyState } from '../../components/states';
import { Alert, Time } from '../../components/ui';
import { useHeaderTopic } from '../../shell/topic';
import { approveProposal, fetchProposal, fetchProposals, rejectProposal, withdrawProposal } from './api';
import { opWords, ProposalChecks, ProposalDiff, StatusPill } from './parts';
import { placeOf, useProposalPerms } from './store';

/*
 * Proposals (PLAN P7-01): every change to bots/, TEAM.md, skills/ and routines/ waits here until a team lead or workspace admin applies it. The list
 * shows what waits first, then what was decided; a proposal shows the lines that change, the checks that ran (a BOT.md that does not load says why in
 * the loader's own words), and the buttons that person may use. Everyone in the team can read them; what each person may do is decided by the server.
 */

const FILTERS = [
  { id: 'open', label: 'Waiting' },
  { id: 'all', label: 'All' },
] as const;

function Row({ p, slug }: { p: Proposal; slug: string }) {
  return (
    <Link className="pp-row" to={`/t/${slug}/proposals/${p.id}`} data-testid="proposal-row" data-status={p.status}>
      <span className="pp-row-main">
        <span className="pp-row-title">{p.title}</span>
        <span className="pp-row-meta">
          <span className="mono">{p.path}</span> · {opWords(p)} · {p.authorName} · <Time iso={p.createdAt} />
        </span>
      </span>
      <span className="pp-row-side">
        <span className="pp-delta"><span className="add">+{p.added}</span> <span className="del">−{p.removed}</span></span>
        <StatusPill status={p.status} />
      </span>
    </Link>
  );
}

export function ProposalsList() {
  const { slug } = useProposalPerms();
  useHeaderTopic('Proposals');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('open');
  const q = useQuery(`proposals:${slug}`, () => fetchProposals(slug));
  return (
    <div className="pp-screen" data-testid="proposals-list">
      <div className="pp-head">
        <div>
          <h2 className="pp-title">Proposals</h2>
          <p className="pp-sub">
            A change to <span className="mono">bots/</span>, <span className="mono">TEAM.md</span>, <span className="mono">skills/</span> or <span className="mono">routines/</span> is
            proposed first. A team lead or workspace admin looks at the lines that change and applies them.
          </p>
        </div>
        <Link className="btn s" to={`/t/${slug}/bots`}>Bots</Link>
      </div>
      <QueryView q={q}>
        {({ proposals, openCount }) => {
          const shown = filter === 'open' ? proposals.filter((p) => p.status === 'open') : proposals;
          return (
            <>
              <div className="seg" role="group" aria-label="Show">
                {FILTERS.map((f) => (
                  <button key={f.id} type="button" className={filter === f.id ? 'on' : ''} aria-pressed={filter === f.id} data-testid={`proposals-filter-${f.id}`} onClick={() => setFilter(f.id)}>
                    {f.label}{f.id === 'open' ? ` (${openCount})` : ''}
                  </button>
                ))}
              </div>
              {shown.length === 0 ? (
                <EmptyState title={filter === 'open' ? 'Nothing is waiting' : 'No proposals yet'}>
                  <p>Open a file in <Link to={`/t/${slug}/files?path=skills`}>Files</Link> or a bot on its page and choose “Propose a change”.</p>
                </EmptyState>
              ) : (
                <div className="pp-list" role="list">
                  {shown.map((p) => <div role="listitem" key={p.id}><Row p={p} slug={slug} /></div>)}
                </div>
              )}
            </>
          );
        }}
      </QueryView>
    </div>
  );
}

function Decision({ d, slug, onChanged }: { d: ProposalDetail; slug: string; onChanged: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (name: 'apply' | 'reject' | 'withdraw', work: () => Promise<unknown>): Promise<void> => {
    setBusy(name);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'That did not work. Try again.');
    } finally {
      setBusy(null);
    }
  };
  const id = d.proposal.id;
  const failed = d.proposal.checks.some((c) => !c.ok);
  return (
    <div className="pp-decide" data-testid="proposal-decide">
      {d.proposal.status === 'open' && (d.canApply || d.canReject) ? (
        <label className="dlg-label pp-field">
          A note (optional)
          <input className="dlg-input" value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} data-testid="proposal-note" />
        </label>
      ) : null}
      {d.proposal.status === 'open' && !d.canApply && !d.stale && d.cannotApplyReason ? <p className="pp-why" data-testid="proposal-cannot-apply">{d.cannotApplyReason}</p> : null}
      {d.stale && d.staleReason ? <p className="pp-why bad" role="alert" data-testid="proposal-stale">{d.staleReason}</p> : null}
      {failed && d.proposal.status === 'open' ? <p className="pp-why bad" role="alert" data-testid="proposal-check-failed">This cannot be applied until the failed check passes. Make a new proposal with the fix.</p> : null}
      <div className="pp-actions">
        {d.canApply ? (
          <button type="button" className="btn primary" data-testid="proposal-apply" disabled={busy !== null || d.stale || failed} onClick={() => void run('apply', () => approveProposal(slug, id, note))}>
            {busy === 'apply' ? 'Applying…' : 'Apply'}
          </button>
        ) : null}
        {d.canReject ? (
          <button type="button" className="btn" data-testid="proposal-reject" disabled={busy !== null} onClick={() => void run('reject', () => rejectProposal(slug, id, note))}>Decline</button>
        ) : null}
        {d.canWithdraw ? (
          <button type="button" className="btn" data-testid="proposal-withdraw" disabled={busy !== null} onClick={() => void run('withdraw', () => withdrawProposal(slug, id))}>Withdraw</button>
        ) : null}
      </div>
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

export function ProposalPage() {
  const { slug } = useProposalPerms();
  const { proposalId = '' } = useParams();
  useHeaderTopic('Proposals');
  const q = useQuery(`proposal:${slug}:${proposalId}`, () => fetchProposal(slug, proposalId));
  return (
    <div className="pp-screen" data-testid="proposal-page">
      <p className="pp-back"><Link to={`/t/${slug}/proposals`}>← All proposals</Link></p>
      <QueryView q={q}>
        {({ proposal: d }) => {
          const p = d.proposal;
          return (
            <>
              <div className="pp-head">
                <div>
                  <h2 className="pp-title" data-testid="proposal-title">{p.title}</h2>
                  <p className="pp-sub">
                    {opWords(p)} <span className="mono">{p.path}</span> ({placeOf(p.path).toLowerCase()}) · proposed by {p.authorName}{p.authorKind === 'bot' ? ' (a bot)' : ''} · <Time iso={p.createdAt} />
                  </p>
                </div>
                <StatusPill status={p.status} />
              </div>
              {p.note ? <p className="pp-note" data-testid="proposal-note-text">{p.note}</p> : null}
              <ProposalChecks checks={p.checks} />
              <h3 className="pp-h">What would change <span className="pp-delta"><span className="add">+{p.added}</span> <span className="del">−{p.removed}</span></span></h3>
              <ProposalDiff diff={p.diff} />
              {p.status === 'applied' ? (
                <p className="pp-outcome" data-testid="proposal-outcome">
                  Applied by {p.decidedByName ?? 'a team lead'}{p.selfApplied ? ' (proposed and applied in one step)' : ''}. It is saved in the team repo as commit <span className="mono">{p.appliedCommitSha?.slice(0, 7)}</span>.
                </p>
              ) : null}
              {p.status === 'rejected' || p.status === 'withdrawn' ? (
                <p className="pp-outcome" data-testid="proposal-outcome">
                  {p.status === 'rejected' ? 'Declined' : 'Withdrawn'} by {p.decidedByName ?? 'someone'}.{p.decisionNote ? ` “${p.decisionNote}”` : ''} Nothing was changed.
                </p>
              ) : null}
              <Decision d={d} slug={slug} onChanged={q.reload} />
            </>
          );
        }}
      </QueryView>
    </div>
  );
}

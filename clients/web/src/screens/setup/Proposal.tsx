import type { ProposalDetail, SetupSession } from '@manythreads/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '../../app/useQuery';
import { QueryView } from '../../components/states';
import { Alert } from '../../components/ui';
import { fetchBot } from '../bots/api';
import { approveProposal, fetchProposal, rejectProposal } from '../proposals/api';
import { ProposalChecks, ProposalDiff, StatusPill } from '../proposals/parts';
import { placeOf } from '../proposals/store';
import { approvalOrder, botSlugOf } from './model';

/*
 * The last step of "Add a bot" (mockup section `setup`, step 3): what the helper proposes, as the diff a person reads, what the bot will not be able to do, and the buttons.
 * The helper filed ordinary proposals (P7-01); this screen only gathers them. Approving applies them (the platform creates the bot from the file and applies what it asks for);
 * who may approve is the server's answer for each proposal, not something this screen decides.
 */

type Row = { ref: SetupSession['proposals'][number]; detail: ProposalDetail };

export function ProposalStep({ slug, session, onDone }: { slug: string; session: SetupSession; onDone: () => void }) {
  const refs = approvalOrder(session.proposals);
  const q = useQuery(`setup-proposals:${session.id}`, async (): Promise<Row[]> => {
    const details = await Promise.all(refs.map((r) => fetchProposal(slug, r.proposalId)));
    return refs.map((ref, i) => ({ ref, detail: (details[i] as { proposal: ProposalDetail }).proposal }));
  });
  return (
    <QueryView q={q}>
      {(rows) => <Loaded slug={slug} session={session} rows={rows} reload={() => { q.reload(); onDone(); }} />}
    </QueryView>
  );
}

/** Tries to read the new bot until it is on the roster: applying the file is instant, the platform reads the bot's file a moment later. Gives up after about a minute. */
function useBotThere(slug: string, botSlug: string | null, wanted: boolean): 'checking' | 'there' | 'late' {
  const [state, setState] = useState<'checking' | 'there' | 'late'>('checking');
  useEffect(() => {
    if (!wanted || botSlug === null) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async (attempt: number): Promise<void> => {
      try {
        await fetchBot(slug, botSlug);
        if (live) setState('there');
        return;
      } catch {
        // not there yet
      }
      if (!live) return;
      if (attempt >= 40) setState('late');
      else timer = setTimeout(() => void look(attempt + 1), 1500);
    };
    void look(0);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [slug, botSlug, wanted]);
  return state;
}

function Loaded({ slug, session, rows, reload }: { slug: string; session: SetupSession; rows: Row[]; reload: () => void }) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bot = rows.find((r) => r.ref.role === 'bot');
  const open = rows.filter((r) => r.detail.proposal.status === 'open');
  const applied = rows.every((r) => r.detail.proposal.status === 'applied');
  const declined = rows.some((r) => r.detail.proposal.status === 'rejected' || r.detail.proposal.status === 'withdrawn');
  const canApprove = open.length > 0 && open.every((r) => r.detail.canApply && !r.detail.stale && r.detail.proposal.checks.every((c) => c.ok));
  const canReject = open.length > 0 && open.every((r) => r.detail.canReject);
  const blockedWhy = open.map((r) => r.detail.staleReason ?? r.detail.cannotApplyReason).find((t) => t);
  const slugOfBot = botSlugOf(session.proposals);
  const botThere = useBotThere(slug, slugOfBot, applied);
  // the heading is where keyboard focus lands when the proposal appears and again when it is approved or turned down
  useEffect(() => {
    document.getElementById('su-prop-h')?.focus();
  }, [applied, declined]);

  const run = async (name: 'approve' | 'reject', one: (id: string) => Promise<unknown>): Promise<void> => {
    setBusy(name);
    setError(null);
    try {
      // one after the other, in order: the bot last, so a failure on the way leaves the bot not created
      for (const r of open) await one(r.ref.proposalId);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'That did not work. Try again.');
    } finally {
      setBusy(null);
      reload();
    }
  };

  return (
    <div className="su-stack" data-testid="setup-proposal">
      <section className="su-card" aria-labelledby="su-prop-h">
        <h3 className="su-h" id="su-prop-h" tabIndex={-1}>
          {applied ? 'The bot is created' : declined ? 'Not approved' : 'Here is what I propose'} <span className="su-count">{session.name ?? bot?.detail.proposal.title ?? ''}</span>
        </h3>
        {session.message ? <p className="su-summary" data-testid="setup-summary">{session.message}</p> : null}
        {!applied && !declined ? <p className="su-hint">Nothing is applied until a person approves. {open.length > 1 ? `${open.length} changes are waiting.` : ''}</p> : null}
        {rows.map((r) => (
          <div key={r.ref.proposalId} className="su-file" data-testid="setup-file" data-role={r.ref.role}>
            <div className="su-file-head">
              <b>{r.ref.role === 'bot' ? 'The bot (draft of its description file)' : r.ref.role === 'skill' ? 'A new skill (saved instructions)' : 'A change to the team file (TEAM.md)'}</b>
              <span className="mono su-path">{r.ref.path}</span>
              <span className="su-file-tag">{placeOf(r.ref.path)}</span>
              <StatusPill status={r.detail.proposal.status} />
            </div>
            <ProposalChecks checks={r.detail.proposal.checks} />
            <ProposalDiff diff={r.detail.proposal.diff} />
          </div>
        ))}
      </section>

      <section className="su-card su-limits" aria-labelledby="su-lim-h" data-testid="setup-limits">
        <h3 className="su-h" id="su-lim-h">What it won&apos;t be able to do</h3>
        {session.limits.length === 0 ? (
          <p className="su-hint">Nothing you asked for was left out.</p>
        ) : (
          <ul className="su-list">
            {session.limits.map((l) => <li key={l}>{l}</li>)}
          </ul>
        )}
      </section>

      {error ? <Alert>{error}</Alert> : null}
      {applied ? (
        <div className="su-actions" data-testid="setup-created">
          {slugOfBot && botThere === 'there' ? <Link className="btn primary" to={`/t/${slug}/bots/${slugOfBot}`} data-testid="setup-open-bot">Open the bot</Link> : null}
          {botThere === 'checking' ? <p className="su-working" role="status" data-testid="setup-adding"><span className="su-spin" aria-hidden="true" />The bot is being added to the team…</p> : null}
          {botThere === 'late' ? <p className="su-hint" role="status" data-testid="setup-late">The bot is taking longer than usual to appear. Check the list of bots in a moment.</p> : null}
          <Link className="btn" to={`/t/${slug}/bots`}>Back to bots</Link>
        </div>
      ) : declined ? (
        <div className="su-actions">
          <Link className="btn" to={`/t/${slug}/bots`}>Back to bots</Link>
        </div>
      ) : (
        <div className="su-actions" data-testid="setup-decide">
          {canApprove ? (
            <button type="button" className="btn primary" disabled={busy !== null} data-testid="setup-approve" onClick={() => void run('approve', (id) => approveProposal(slug, id))}>
              {busy === 'approve' ? 'Creating…' : 'Approve — create bot'}
            </button>
          ) : null}
          {bot ? <Link className="btn" to={`/t/${slug}/proposals/${bot.ref.proposalId}`} data-testid="setup-edit">Review in Proposals</Link> : null}
          {canReject ? (
            <button type="button" className="btn" disabled={busy !== null} data-testid="setup-reject" onClick={() => void run('reject', (id) => rejectProposal(slug, id))}>
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </button>
          ) : null}
          {!canApprove && open.length > 0 ? (
            <p className="su-why" data-testid="setup-cannot-approve">{blockedWhy ?? 'A team lead or a workspace admin approves this. It is waiting for them in Proposals.'}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

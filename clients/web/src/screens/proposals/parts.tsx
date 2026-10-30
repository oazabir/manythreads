import { parseUnifiedDiff, type Proposal } from '@manythreads/shared';
import { useMemo } from 'react';
import { STATUS_LABEL } from './store';

/** The lines a proposal changes, drawn the way the Files history draws a commit (the `.diff` styles of the Files screen). */
export function ProposalDiff({ diff }: { diff: string }) {
  const hunks = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (hunks.length === 0) return <p className="vw-note">No lines change.</p>;
  return (
    <div className="diff pp-diff" data-testid="proposal-diff" role="group" aria-label="What would change">
      {hunks.map((h, i) => (
        <div key={i} className="hunk">
          <span className="hh">{h.header}</span>
          {h.lines.map((l, j) => (
            <span key={j} className={l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : 'ctx'} data-line={l.type}>
              {l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}
              {l.text}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** What was checked before anyone is asked to apply it. A failed check is shown with the loader's own words and stops the apply. */
export function ProposalChecks({ checks }: { checks: Proposal['checks'] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="pp-checks" data-testid="proposal-checks" aria-label="Checks">
      {checks.map((c) => (
        <li key={c.name} className={c.ok ? 'ok' : 'bad'} data-ok={c.ok}>
          <span className="pp-check-mark" aria-hidden="true">{c.ok ? '✓' : '!'}</span>
          <span>
            <b>{c.name}</b>
            {c.ok ? <span className="pp-check-msg"> passed</span> : null}
            {c.message ? <span className="pp-check-msg">{c.ok ? ` — ${c.message}` : `: ${c.message}`}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function StatusPill({ status }: { status: Proposal['status'] }) {
  return <span className={`pp-pill ${status}`} data-testid="proposal-status" data-status={status}>{STATUS_LABEL[status]}</span>;
}

export const opWords = (p: Pick<Proposal, 'op' | 'baseBlobSha'>): string => (p.op === 'delete' ? 'Remove' : p.baseBlobSha === null ? 'Add' : 'Change');

import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import type { ShareRun, ShareView } from '@manythreads/shared';
import { useQuery } from '../../app/useQuery';
import { Time } from '../../components/ui';
import { fetchShareRun, previewShare, runShare } from './shareApi';
import {
  acceptedLine,
  approvalWords,
  destinationSentence,
  invalidSentence,
  leftOutGroups,
  leftOutLine,
  linkLook,
  modeWords,
  previewDiffLine,
  previewHeadline,
  runHasReason,
  runLook,
  runNow,
  scheduleWords,
} from './shareWords';
import { message } from './inboxWords';

type Props = {
  slug: string;
  share: ShareView;
  canManage: boolean;
  sharingOn: boolean;
  /** After Run now: the list is read again (the digest moves on its own). */
  onChanged: (said: string) => void;
};

/**
 * One outgoing share: what it sends and to whom, how often, who approves, each destination's answer, the last digest, and (for a lead or admin) the live count of
 * what it would send now and Run now. The count comes from the memory index alone: nothing is built when it is read.
 */
export function ShareCard({ slug, share, canManage, sharingOn, onChanged }: Props) {
  const headId = useId();
  const active = share.status === 'active';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useQuery(`share-preview:${slug}:${share.slug}:${share.updatedAt}:${share.lastRun?.id ?? 'none'}`, () => (active && canManage ? previewShare(slug, share.slug) : Promise.resolve(null)));
  const lastState = share.lastRun?.state;
  const explain = share.lastRun && canManage && runHasReason(share.lastRun.state) ? share.lastRun : null;
  const [run, setRun] = useState<ShareRun | null>(null);
  const lastId = explain?.id;
  useEffect(() => {
    if (!lastId) {
      setRun(null);
      return;
    }
    let live = true;
    fetchShareRun(slug, share.slug, lastId).then(
      (r) => live && setRun(r.run),
      () => live && setRun(null),
    );
    return () => {
      live = false;
    };
  }, [slug, share.slug, lastId]);

  const can = runNow(share, sharingOn, canManage);
  const press = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await runShare(slug, share.slug);
      onChanged(`A digest of “${share.name}” is being built.`);
    } catch (e) {
      setError(message(e, 'The digest could not be started. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="ms-card" data-testid="share" data-share={share.slug} data-status={share.status} aria-labelledby={headId}>
      <div className="ms-card-main">
        <div className="ms-card-title">
          <strong id={headId} className="ms-name" data-testid="share-name">{share.name}</strong>
          {share.status === 'invalid' ? <span className="mi-state bad" data-testid="share-invalid"><span aria-hidden="true">!</span> File not valid</span> : null}
          <span className="mi-chip" data-testid="share-mode">{modeWords(share.mode)}</span>
        </div>
        {share.status === 'invalid' ? <p className="mi-sentence" data-testid="share-invalid-reason">{invalidSentence(share)}</p> : null}

        <dl className="ms-facts">
          <div>
            <dt>How often</dt>
            <dd data-testid="share-schedule">
              {scheduleWords(share.cron)}
              {share.cron && share.nextRunAt ? <> · next <Time iso={share.nextRunAt} /></> : null}
            </dd>
          </div>
          <div>
            <dt>Who approves</dt>
            <dd data-testid="share-approval">{approvalWords(share)}</dd>
          </div>
          <div>
            <dt>Last digest</dt>
            <dd data-testid="share-last">
              {share.lastRun ? (
                <>
                  <span className={`mi-state ${runLook(share.lastRun.state).tone}`} data-testid="share-last-state" data-state={share.lastRun.state}>
                    <span aria-hidden="true">{runLook(share.lastRun.state).glyph}</span> {runLook(share.lastRun.state).label}
                  </span>{' '}
                  <Time iso={share.lastRun.at} />
                </>
              ) : (
                <span className="faint">No digest has been made yet</span>
              )}
              {run?.reason ? <span className="ms-reason" data-testid="share-last-reason">{run.reason}</span> : null}
              {lastState === 'awaiting_approval' ? (
                <span className="ms-reason">
                  It waits in <Link to={`/t/${encodeURIComponent(slug)}/approvals`} data-testid="share-open-approvals">Approvals</Link> for a lead.
                </span>
              ) : null}
            </dd>
          </div>
        </dl>

        <div className="ms-dests" role="group" aria-label={`Teams that get ${share.name}`}>
          <span className="ms-dests-head" data-testid="share-accepted-line">{acceptedLine(share.destinations)}</span>
          <ul className="ms-dest-list">
            {share.destinations.map((d) => {
              const look = linkLook(d.link);
              return (
                <li key={d.teamId} className="ms-dest" data-testid="share-destination" data-team={d.slug} data-link={d.link}>
                  <strong>{d.name || d.slug}</strong>
                  <span className={`mi-state ${look.tone}`} data-testid="share-destination-state">
                    <span aria-hidden="true">{look.glyph}</span> {look.label}
                  </span>
                  <span className="ms-dest-note">{destinationSentence(d)}</span>
                </li>
              );
            })}
          </ul>
        </div>

        {active && canManage ? (
          <div className="ms-preview" data-testid="share-preview" aria-live="polite">
            {preview.status === 'loading' ? <p className="faint">Counting what it would send…</p> : null}
            {preview.status === 'error' ? <p className="mi-error" role="alert" data-testid="share-preview-error">The count could not be made: {preview.error.message}</p> : null}
            {preview.status === 'ok' && preview.data ? (
              <>
                <p className="ms-headline" data-testid="share-preview-headline">{previewHeadline(preview.data.preview)}</p>
                <p className="ms-diff" data-testid="share-preview-diff">Next digest: {previewDiffLine(preview.data.preview)}</p>
                {preview.data.preview.excluded.length > 0 ? (
                  <details className="ms-more">
                    <summary data-testid="share-left-out-toggle">Why {String(preview.data.preview.counts.leftOut)} {preview.data.preview.counts.leftOut === 1 ? 'is' : 'are'} left out</summary>
                    <ul className="ms-left" data-testid="share-left-out">
                      {leftOutGroups(preview.data.preview.excluded).map((g) => (
                        <li key={g.reason}>
                          <span>{leftOutLine(g)}</span>
                          <ul className="ms-paths">
                            {g.items.slice(0, 8).map((e) => (
                              <li key={e.path} className="mono">{e.title || e.path}</li>
                            ))}
                            {g.items.length > 8 ? <li className="faint">and {String(g.items.length - 8)} more</li> : null}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {error ? <p className="mi-error" role="alert" data-testid="share-error">{error}</p> : null}
      </div>

      {canManage ? (
        <div className="ms-actions">
          <button
            type="button"
            className="btn s primary"
            disabled={busy || !can.ok}
            aria-describedby={can.reason ? `${headId}-why` : undefined}
            onClick={() => void press()}
            aria-label={`Run ${share.name} now`}
            data-testid="share-run"
          >
            {busy ? 'Starting…' : 'Run now'}
          </button>
          {can.reason ? <span id={`${headId}-why`} className="ms-why" data-testid="share-run-why">{can.reason}</span> : null}
        </div>
      ) : null}
    </li>
  );
}

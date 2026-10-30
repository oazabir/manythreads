import { useEffect, useState } from 'react';
import type { EvalRun } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { Time } from '../../components/ui';
import { fetchEvals, startEvals } from './api';
import { NotSet } from './parts';

/*
 * What the Evals tab shows of a bot's runs (PLAN P7-08): the newest verdict in one line ("Eval 17 of 20 passed · minimum 0.90 · view failures"), the
 * cases that failed with the reason for each, and — for a team lead or workspace admin — the buttons that start a run. A run is a job on the server;
 * while one is open the panel asks again every two seconds. Cases the free mode cannot judge are said to be "not checked", never counted as passed.
 */

const POLL_MS = 2000;

const WHY: Record<EvalRun['trigger'], string> = {
  on_demand: 'started by hand',
  on_commit: 'after a change to BOT.md or its scenarios',
  nightly: 'the nightly check',
};

const minimumOf = (n: number): string => n.toFixed(2);

function Summary({ run, onView, viewing }: { run: EvalRun; onView: () => void; viewing: boolean }) {
  if (run.status === 'running') return <div className="b-ev-line" data-testid="eval-summary">Running the scenarios now…</div>;
  if (run.status === 'failed') {
    return (
      <div className="b-ev-line bad" data-testid="eval-summary">
        <strong>The evals could not run.</strong> {run.error}
      </div>
    );
  }
  const below = run.ok === false;
  const unchecked = run.total - run.judged;
  const failed = run.results.filter((r) => r.judged && !r.passed).length;
  // a case that passed on the assertions the free check can judge, while others of its assertions were not checked: said, never counted as fully passed
  const partly = run.results.filter((r) => r.judged && r.passed && r.skipped.length > 0).length;
  return (
    <div className={`b-ev-line${below ? ' bad' : ''}`} data-testid="eval-summary">
      <span className="b-ev-score" data-testid="eval-score">
        Eval {run.passed} of {run.judged} passed
      </span>
      {' · '}
      <span>minimum {minimumOf(run.minScore)}</span>
      {unchecked > 0 ? <span>{` · ${unchecked} not checked`}</span> : null}
      {partly > 0 ? <span data-testid="eval-partly">{` · ${partly} only partly checked`}</span> : null}
      {run.ok === null ? <span>{' · nothing could be checked without the model'}</span> : null}
      {failed > 0 || unchecked > 0 || partly > 0 ? (
        <>
          {' · '}
          <button type="button" className="b-ev-link" aria-expanded={viewing} onClick={onView} data-testid="eval-view-failures">
            {viewing ? 'hide failures' : 'view failures'}
          </button>
        </>
      ) : null}
      {below ? (
        <div className="b-ev-flag" role="alert" data-testid="eval-flag">
          Below the minimum score. Do not rely on this definition until the failing cases are fixed.
        </div>
      ) : null}
    </div>
  );
}

function Cases({ run }: { run: EvalRun }) {
  const failed = run.results.filter((r) => r.judged && !r.passed);
  const unchecked = run.results.filter((r) => !r.judged);
  const partly = run.results.filter((r) => r.judged && r.passed && r.skipped.length > 0);
  return (
    <div className="b-ev-cases" data-testid="eval-cases">
      {failed.map((r) => (
        <div className="b-ev-case" key={r.caseId} data-testid="eval-case">
          <div className="b-ev-case-id">{r.caseId}</div>
          <ul className="b-ev-reasons">
            {r.reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
          {r.answerExcerpt ? <div className="d b-ev-excerpt">It answered: {r.answerExcerpt}</div> : null}
        </div>
      ))}
      {unchecked.length > 0 ? (
        <div className="d" data-testid="eval-unchecked">
          Not checked ({unchecked.length}): {unchecked.map((r) => r.caseId).join(', ')}. The free check only judges the calls a case requires; run the evals with the model to judge the words.
        </div>
      ) : null}
      {partly.length > 0 ? (
        <div className="d" data-testid="eval-partly-cases">
          Only partly checked ({partly.length}): {partly.map((r) => `${r.caseId} (${r.skipped.join(', ')} not checked)`).join('; ')}. These passed on the calls they require; their words need the model.
        </div>
      ) : null}
    </div>
  );
}

export function EvalRunPanel({ slug, botSlug }: { slug: string; botSlug: string }) {
  const q = useQuery(`evals:${slug}:${botSlug}`, () => fetchEvals(slug, botSlug));
  const [viewing, setViewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const data = q.status === 'ok' ? q.data : null;
  const open = data?.recent.some((r) => r.status === 'running') ?? false;
  const reload = q.reload;
  useEffect(() => {
    if (!open) return undefined;
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [open, reload]);

  const start = async (mode: 'static' | 'model'): Promise<void> => {
    setStarting(true);
    setProblem(null);
    try {
      await startEvals(slug, botSlug, mode);
      reload();
    } catch (e) {
      setProblem(isApiError(e) ? e.message : 'The run could not be started. Try again.');
    } finally {
      setStarting(false);
    }
  };

  if (q.status === 'loading') return <NotSet>Loading the last run…</NotSet>;
  if (q.status === 'error') return <NotSet>The evals could not be loaded: {q.error.message}</NotSet>;
  const { latest, recent, canRun } = q.data;
  // the newest run decides what the line says; a run in progress shows over the last verdict
  const shown = recent[0]?.status === 'running' ? recent[0] : latest;

  return (
    <div className="b-ev" data-testid="eval-panel">
      {shown ? (
        <>
          <Summary run={shown} viewing={viewing} onView={() => setViewing((v) => !v)} />
          <div className="d">
            {shown.set !== '-' ? <>Set <code>{shown.set}</code> · </> : null}{WHY[shown.trigger]} · {shown.mode === 'model' ? 'with the model' : 'free check'}
            {shown.commitSha ? <> · commit <code>{shown.commitSha.slice(0, 7)}</code></> : null}
            {shown.finishedAt ? <> · <Time iso={shown.finishedAt} /></> : null}
          </div>
          {viewing && shown.status === 'finished' ? <Cases run={shown} /> : null}
        </>
      ) : (
        <NotSet>No run yet. {canRun ? 'Run the evals to see how this definition scores.' : 'A team lead or admin can run the evals.'}</NotSet>
      )}
      {recent.length > 1 ? (
        <details className="b-ev-history">
          <summary>Earlier runs ({recent.length})</summary>
          {recent.map((r) => (
            <div className="b-ev-hist" key={r.id}>
              <span className={`b-ev-dot${r.status === 'failed' || r.ok === false ? ' bad' : r.status === 'running' ? ' off' : ''}`} aria-hidden="true" />
              <span>
                {r.status === 'running' ? 'running' : r.status === 'failed' ? 'could not run' : `${r.passed} of ${r.judged}${r.ok === false ? ' (below the minimum)' : ''}`}
                {' · '}
                {WHY[r.trigger]}
                {' · '}
                <Time iso={r.startedAt} />
              </span>
            </div>
          ))}
        </details>
      ) : null}
      {canRun ? (
        <div className="b-ev-actions">
          <button type="button" className="btn s" disabled={starting || open} onClick={() => void start('static')} data-testid="eval-run">
            Run evals
          </button>
          <button type="button" className="btn s" disabled={starting || open} onClick={() => void start('model')} data-testid="eval-run-model" title="Asks the model, so it costs tokens">
            Run with the model
          </button>
        </div>
      ) : null}
      {problem ? (
        <div className="b-ev-line bad" role="alert">
          {problem}
        </div>
      ) : null}
    </div>
  );
}

import { useQuery } from '../../../app/useQuery';
import { QueryView } from '../../../components/states';
import { Time } from '../../../components/ui';
import { fetchRoutineRuns } from './routinesApi';
import { runStatusLabel, sourcesUsedSentence } from './routinesWords';

/** The last runs of one routine: when, how it ended, which kinds of thing it read (a count per kind, never their text) and the file it wrote. */
export function RoutineRuns({ routineId }: { routineId: string }) {
  const q = useQuery(`routine-runs-${routineId}`, () => fetchRoutineRuns(routineId));
  return (
    <div className="rt-runs" data-testid="routine-runs">
      <QueryView q={q}>
        {({ items }) =>
          items.length === 0 ? (
            <p className="rt-runs-none" data-testid="routine-runs-none">It has not run yet. Use Run now to try it.</p>
          ) : (
            <ul className="rt-run-list">
              {items.map((run) => (
                <li key={run.id} className="rt-run" data-testid="routine-run" data-status={run.status}>
                  <div className="rt-run-head">
                    <span className={`chip ${run.status === 'done' ? 'ok' : run.status === 'failed' ? 'alert' : ''}`} data-testid="routine-run-status">{runStatusLabel(run.status)}</span>
                    <Time iso={run.startedAt} />
                  </div>
                  <p className="rt-run-line" data-testid="routine-run-sources">{sourcesUsedSentence(run)}</p>
                  {run.reason ? <p className="rt-run-line" data-testid="routine-run-reason">{run.reason}</p> : null}
                  {run.outputPath ? <p className="rt-run-line">Wrote <span className="mono">{run.outputPath}</span></p> : null}
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
      <button type="button" className="btn s quiet" onClick={q.reload} data-testid="routine-runs-refresh">Refresh</button>
    </div>
  );
}

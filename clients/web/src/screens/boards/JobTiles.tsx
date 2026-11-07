import { JobHeartbeatIcon, JobRoutineIcon, JobTaskIcon } from './icons';
import { JOB_TILES, SCHEDULED_JOB_KIND_LABEL, type JobTile } from './scheduled-job';

/*
 * The empty Jobs page (PLAN P21-15): the three kinds of job as tiles, each with a picture, what it does, an example in one sentence and a
 * Create button that opens the usual form already filled with that example. Someone who may not create a job (a member proposes it in Files)
 * sees the tiles as a guide with no button.
 */

const ICONS = { heartbeat: JobHeartbeatIcon, routine: JobRoutineIcon, task: JobTaskIcon } as const;

export function JobTiles({ canManage, onCreate }: { canManage: boolean; onCreate: (tile: JobTile) => void }) {
  return (
    <div className="bd-start" data-testid="scheduled-jobs-empty">
      <h2 className="bd-start-title">No jobs yet</h2>
      <p className="bd-start-body">A job is something a bot does on a timer. Three kinds, with an example of each.</p>
      <div className="bd-tiles" data-landmark="job-kinds">
        {JOB_TILES.map((tile) => {
          const Icon = ICONS[tile.kind];
          const label = SCHEDULED_JOB_KIND_LABEL[tile.kind];
          return (
            <section key={tile.kind} className="bd-tile" data-testid="job-tile" data-kind={tile.kind} aria-label={label}>
              <span className="bd-tile-pic"><Icon /></span>
              <h3 className="bd-tile-title">{label}</h3>
              <p className="bd-tile-line">{tile.line}</p>
              <p className="bd-tile-example">&ldquo;{tile.example}&rdquo;</p>
              {canManage ? (
                <button type="button" className="btn primary bd-tile-act" aria-label={`Create a ${label.toLowerCase()}`} onClick={() => onCreate(tile)} data-testid="job-tile-create">
                  Create
                </button>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

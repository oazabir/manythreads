import { useState } from 'react';
import type { ScheduledJob, ScheduledJobEffort, ScheduledJobKind } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { Alert, Time } from '../../components/ui';
import { refusalText } from './board';
import { useTeamPeople } from './people';
import { SCHEDULED_JOB_KIND_BLURB, SCHEDULED_JOB_KIND_LABEL, RUN_STATUS_LABEL, cronNote, emptyScheduledJob, scheduledJobRequest, type ScheduledJobDraft } from './scheduled-job';
import { createScheduledJob, fetchScheduledJobRuns, fetchScheduledJobs, runScheduledJob, updateScheduledJob } from './api';

/*
 * Jobs (SPEC §6.5, PLAN P6-08): what the team has on a timer, with its own sidebar entry. A heartbeat is a scheduled prompt, a
 * routine is a contract under `routines/` with a page it writes, a task opens a card. Each row shows the schedule and the next run the
 * server computed, its ledger, and "Run now", which takes the exact path a tick takes — a contract that would fail at 09:00 fails here
 * too. A lead (or a workspace admin) creates and enables one; a member proposes it (a proposal a lead applies, P7-01), which is what the copy says.
 */

const KINDS: readonly ScheduledJobKind[] = ['heartbeat', 'routine', 'task'];
const EFFORTS: readonly ScheduledJobEffort[] = ['low', 'medium', 'high'];

export function ScheduledJobsView({ slug, canManage }: { slug: string; canManage: boolean }) {
  const people = useTeamPeople(slug);
  const listQ = useQuery(`scheduled-jobs:${slug}`, () => fetchScheduledJobs(slug));
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduledJobDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const scheduledJobs = listQ.status === 'ok' ? listQ.data.items : [];
  const current = scheduledJobs.find((r) => r.id === selected) ?? null;
  const runsQ = useQuery(`scheduled-job-runs:${slug}:${selected ?? 'none'}:${revision}`, () => (selected ? fetchScheduledJobRuns(slug, selected) : Promise.resolve({ items: [] })));
  const botName = (id: string): string => people.bots.find((b) => b.id === id)?.name ?? 'a bot that is no longer loaded';

  const reload = (): void => {
    listQ.reload();
    setRevision((r) => r + 1);
  };

  const toggle = async (scheduledJob: ScheduledJob): Promise<void> => {
    setBusy(scheduledJob.id);
    setProblem(null);
    try {
      await updateScheduledJob(slug, scheduledJob.id, { enabled: !scheduledJob.enabled });
      reload();
    } catch (err) {
      setProblem(refusalText(err));
    } finally {
      setBusy(null);
    }
  };

  const run = async (scheduledJob: ScheduledJob): Promise<void> => {
    setBusy(scheduledJob.id);
    setProblem(null);
    setNotice(null);
    try {
      const res = await runScheduledJob(slug, scheduledJob.id);
      setNotice(`“${scheduledJob.name}” started: ${RUN_STATUS_LABEL[res.run.status] ?? res.run.status}.`);
      setRevision((r) => r + 1);
      window.setTimeout(() => setRevision((r) => r + 1), 1500);
    } catch (err) {
      setProblem(refusalText(err));
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    const built = scheduledJobRequest(draft);
    if (!built.ok) {
      setProblem(built.message);
      return;
    }
    setProblem(null);
    try {
      const res = await createScheduledJob(slug, built.body);
      setDraft(null);
      setSelected(res.scheduledJob.id);
      setNotice(`“${res.scheduledJob.name}” saved; the scheduler runs it at the next time it matches.`);
      reload();
    } catch (err) {
      setProblem(refusalText(err));
    }
  };

  if (listQ.status === 'loading') return <p className="loading" aria-busy="true">Loading…</p>;
  if (listQ.status === 'error') {
    return (
      <div>
        <Alert>{isApiError(listQ.error) && listQ.error.status === 404 ? 'The jobs plugin is not loaded on this server.' : listQ.error.message}</Alert>
        <button type="button" className="btn" onClick={listQ.reload}>Try again</button>
      </div>
    );
  }

  return (
    <div className="bd-scheduled-jobs" data-testid="scheduled-jobs">
      <div className="bd-toolbar">
        <p className="bd-hint">
          Jobs run as a bot on a schedule. {canManage ? 'As a lead you can add one here.' : 'A lead saves a new one; a member proposes it in Files, and a lead applies it.'}
        </p>
        {canManage ? (
          <div className="bd-toolbar-act">
            <button type="button" className="btn s" onClick={() => { setDraft(emptyScheduledJob(people.bots[0]?.slug ?? '')); setProblem(null); }} data-testid="new-scheduled-job">
              New job
            </button>
          </div>
        ) : null}
      </div>

      {problem ? <Alert>{problem}</Alert> : null}
      {notice ? <p className="bd-filed" role="status" data-testid="scheduled-job-notice">{notice}</p> : null}

      {draft ? (
        <div className="bd-new-scheduled-job" data-testid="new-scheduled-job-form">
          <div className="bd-row2">
            <label className="bd-field">
              <span>Name</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Weekly numbers" data-testid="scheduled-job-name" />
            </label>
            <label className="bd-field">
              <span>Bot</span>
              <select value={draft.botSlug} onChange={(e) => setDraft({ ...draft, botSlug: e.target.value })} data-testid="scheduled-job-bot">
                {people.bots.length === 0 ? <option value="">No bots loaded</option> : null}
                {people.bots.map((b) => (
                  <option key={b.slug} value={b.slug}>{b.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="bd-row2">
            <label className="bd-field">
              <span>Kind</span>
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ScheduledJobKind })} data-testid="scheduled-job-kind">
                {KINDS.map((k) => (
                  <option key={k} value={k}>{SCHEDULED_JOB_KIND_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <label className="bd-field">
              <span>Schedule (UTC)</span>
              <input value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value })} placeholder="0 9 * * mon-fri" className="mono" data-testid="scheduled-job-schedule" />
            </label>
          </div>
          <p className="bd-hint" data-testid="scheduled-job-cron-note">{SCHEDULED_JOB_KIND_BLURB[draft.kind]} {cronNote(draft.schedule, new Date())}</p>
          {draft.kind === 'routine' ? (
            <div className="bd-row2">
              <label className="bd-field">
                <span>Job file</span>
                <input value={draft.contractPath} onChange={(e) => setDraft({ ...draft, contractPath: e.target.value })} placeholder="routines/weekly.yaml" className="mono" data-testid="scheduled-job-contract" />
              </label>
              <label className="bd-field">
                <span>Output page</span>
                <input value={draft.outputPath} onChange={(e) => setDraft({ ...draft, outputPath: e.target.value })} placeholder="pages/reports/weekly.md" className="mono" data-testid="scheduled-job-output" />
              </label>
            </div>
          ) : null}
          <div className="bd-row2">
            <label className="bd-field">
              <span>Model alias (optional)</span>
              <input value={draft.modelAlias} onChange={(e) => setDraft({ ...draft, modelAlias: e.target.value })} placeholder="the bot's own" data-testid="scheduled-job-model" />
            </label>
            <label className="bd-field">
              <span>Effort (optional)</span>
              <select value={draft.effort} onChange={(e) => setDraft({ ...draft, effort: e.target.value as ScheduledJobDraft['effort'] })} data-testid="scheduled-job-effort">
                <option value="">the runtime's default</option>
                {EFFORTS.map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="bd-check">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} data-testid="scheduled-job-enabled" />
            <span>Enabled</span>
          </label>
          <div className="bd-toolbar-act">
            <button type="button" className="btn s" onClick={() => setDraft(null)}>Cancel</button>
            <button type="button" className="btn primary" disabled={draft.name.trim() === '' || draft.botSlug === ''} onClick={() => void save()} data-testid="save-scheduled-job">
              Save job
            </button>
          </div>
        </div>
      ) : null}

      {scheduledJobs.length === 0 ? (
        <div className="bd-empty" data-testid="scheduled-jobs-empty">
          <p className="bd-empty-title">No jobs yet</p>
          <p className="bd-empty-body">A heartbeat nudges a bot on a schedule; a routine runs a contract and writes a page; a task opens a card. None is running right now.</p>
        </div>
      ) : (
        <div className="bd-scheduled-job-list" data-landmark="scheduled-jobs">
          {scheduledJobs.map((r) => (
            <div key={r.id} className={`bd-scheduled-job ${selected === r.id ? 'on' : ''}`} data-testid="scheduled-job-row" data-scheduled-job={r.id} data-enabled={r.enabled}>
              <button type="button" className="bd-scheduled-job-main" onClick={() => setSelected(r.id === selected ? null : r.id)} data-testid="scheduled-job-open">
                <span className="bd-scheduled-job-name">{r.name}</span>
                <span className={`bd-kind ${r.kind}`}>{SCHEDULED_JOB_KIND_LABEL[r.kind]}</span>
                <span className="bd-muted">{botName(r.botId)}</span>
                <span className="mono bd-scheduled-job-schedule">{r.schedule}</span>
                <span className="bd-muted" data-vt-mask>
                  {r.enabled ? (r.nextRunAt ? <>next <Time iso={r.nextRunAt} /></> : 'enabled') : 'paused'}
                </span>
              </button>
              <div className="bd-scheduled-job-act">
                {canManage ? (
                  <button type="button" className="btn s" disabled={busy !== null} onClick={() => void toggle(r)} data-testid="scheduled-job-toggle">
                    {r.enabled ? 'Pause' : 'Enable'}
                  </button>
                ) : null}
                {canManage ? (
                  <button type="button" className="btn s" disabled={busy !== null} onClick={() => void run(r)} data-testid="scheduled-job-run">
                    Run now
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {current ? (
        <div className="bd-runs" data-testid="scheduled-job-runs" data-scheduled-job={current.id}>
          <h3>Runs of “{current.name}”</h3>
          <dl className="bd-facts">
            <dt>Contract</dt>
            <dd className="mono">{current.contractPath ?? '— (not a routine)'}</dd>
            <dt>Output</dt>
            <dd className="mono">{current.outputPath ?? '—'}</dd>
            <dt>Model</dt>
            <dd>{current.modelAlias ?? 'the bot’s own alias'}</dd>
            <dt>Effort</dt>
            <dd>{current.effort ?? 'the runtime’s default'}</dd>
          </dl>
          {runsQ.status === 'loading' ? (
            <p className="loading" aria-busy="true">Loading…</p>
          ) : runsQ.status === 'error' ? (
            <p className="bd-muted">The ledger could not be loaded.</p>
          ) : runsQ.data.items.length === 0 ? (
            <p className="bd-muted">It has not run yet.</p>
          ) : (
            <ol className="bd-run-list">
              {runsQ.data.items.map((run) => (
                <li key={run.id} data-status={run.status}>
                  <span className={`bd-run-status ${run.status}`}>{RUN_STATUS_LABEL[run.status] ?? run.status}</span>
                  <span className="bd-run-when"><Time iso={run.startedAt} /></span>
                  {run.outputPath ? <span className="mono">{run.outputPath}</span> : null}
                  {run.taskId ? <span className="bd-muted">opened a card</span> : null}
                  {run.reason ? <span className="bd-muted">{run.reason}</span> : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </div>
  );
}

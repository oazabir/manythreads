import { useState } from 'react';
import type { Rhythm, RhythmEffort, RhythmKind } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { Alert, Time } from '../../components/ui';
import { refusalText } from './board';
import { useTeamPeople } from './people';
import { RHYTHM_KIND_BLURB, RHYTHM_KIND_LABEL, RUN_STATUS_LABEL, cronNote, emptyRhythm, rhythmRequest, type RhythmDraft } from './rhythm';
import { createRhythm, fetchRhythmRuns, fetchRhythms, runRhythm, updateRhythm } from './api';

/*
 * Rhythms (SPEC §6.5, PLAN P6-08): what the team has on a timer, with its own sidebar entry. A heartbeat is a scheduled prompt, a
 * routine is a contract under `routines/` with a page it writes, a task opens a card. Each row shows the schedule and the next run the
 * server computed, its ledger, and "Run now", which takes the exact path a tick takes — a contract that would fail at 09:00 fails here
 * too. A lead (or a workspace admin) creates and enables one; a member proposes it (a proposal a lead applies, P7-01), which is what the copy says.
 */

const KINDS: readonly RhythmKind[] = ['heartbeat', 'routine', 'task'];
const EFFORTS: readonly RhythmEffort[] = ['low', 'medium', 'high'];

export function RhythmsView({ slug, canManage }: { slug: string; canManage: boolean }) {
  const people = useTeamPeople(slug);
  const listQ = useQuery(`rhythms:${slug}`, () => fetchRhythms(slug));
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<RhythmDraft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  const rhythms = listQ.status === 'ok' ? listQ.data.items : [];
  const current = rhythms.find((r) => r.id === selected) ?? null;
  const runsQ = useQuery(`rhythm-runs:${slug}:${selected ?? 'none'}:${revision}`, () => (selected ? fetchRhythmRuns(slug, selected) : Promise.resolve({ items: [] })));
  const botName = (id: string): string => people.bots.find((b) => b.id === id)?.name ?? 'a bot that is no longer loaded';

  const reload = (): void => {
    listQ.reload();
    setRevision((r) => r + 1);
  };

  const toggle = async (rhythm: Rhythm): Promise<void> => {
    setBusy(rhythm.id);
    setProblem(null);
    try {
      await updateRhythm(slug, rhythm.id, { enabled: !rhythm.enabled });
      reload();
    } catch (err) {
      setProblem(refusalText(err));
    } finally {
      setBusy(null);
    }
  };

  const run = async (rhythm: Rhythm): Promise<void> => {
    setBusy(rhythm.id);
    setProblem(null);
    setNotice(null);
    try {
      const res = await runRhythm(slug, rhythm.id);
      setNotice(`“${rhythm.name}” started: ${RUN_STATUS_LABEL[res.run.status] ?? res.run.status}.`);
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
    const built = rhythmRequest(draft);
    if (!built.ok) {
      setProblem(built.message);
      return;
    }
    setProblem(null);
    try {
      const res = await createRhythm(slug, built.body);
      setDraft(null);
      setSelected(res.rhythm.id);
      setNotice(`“${res.rhythm.name}” saved; the scheduler runs it at the next time it matches.`);
      reload();
    } catch (err) {
      setProblem(refusalText(err));
    }
  };

  if (listQ.status === 'loading') return <p className="loading" aria-busy="true">Loading…</p>;
  if (listQ.status === 'error') {
    return (
      <div>
        <Alert>{isApiError(listQ.error) && listQ.error.status === 404 ? 'The rhythms plugin is not loaded on this server.' : listQ.error.message}</Alert>
        <button type="button" className="btn" onClick={listQ.reload}>Try again</button>
      </div>
    );
  }

  return (
    <div className="bd-rhythms" data-testid="rhythms">
      <div className="bd-toolbar">
        <p className="bd-hint">
          Rhythms run as a bot on a schedule. {canManage ? 'As a lead you can add one here.' : 'A lead saves a new one; a member proposes it in Files, under routines/, and a lead applies it.'}
        </p>
        {canManage ? (
          <div className="bd-toolbar-act">
            <button type="button" className="btn s" onClick={() => { setDraft(emptyRhythm(people.bots[0]?.slug ?? '')); setProblem(null); }} data-testid="new-rhythm">
              New rhythm
            </button>
          </div>
        ) : null}
      </div>

      {problem ? <Alert>{problem}</Alert> : null}
      {notice ? <p className="bd-filed" role="status" data-testid="rhythm-notice">{notice}</p> : null}

      {draft ? (
        <div className="bd-new-rhythm" data-testid="new-rhythm-form">
          <div className="bd-row2">
            <label className="bd-field">
              <span>Name</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Weekly numbers" data-testid="rhythm-name" />
            </label>
            <label className="bd-field">
              <span>Bot</span>
              <select value={draft.botSlug} onChange={(e) => setDraft({ ...draft, botSlug: e.target.value })} data-testid="rhythm-bot">
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
              <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as RhythmKind })} data-testid="rhythm-kind">
                {KINDS.map((k) => (
                  <option key={k} value={k}>{RHYTHM_KIND_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <label className="bd-field">
              <span>Schedule (UTC)</span>
              <input value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value })} placeholder="0 9 * * mon-fri" className="mono" data-testid="rhythm-schedule" />
            </label>
          </div>
          <p className="bd-hint" data-testid="rhythm-cron-note">{RHYTHM_KIND_BLURB[draft.kind]} {cronNote(draft.schedule, new Date())}</p>
          {draft.kind === 'routine' ? (
            <div className="bd-row2">
              <label className="bd-field">
                <span>Contract (`routines/…`)</span>
                <input value={draft.contractPath} onChange={(e) => setDraft({ ...draft, contractPath: e.target.value })} placeholder="routines/weekly.yaml" className="mono" data-testid="rhythm-contract" />
              </label>
              <label className="bd-field">
                <span>Output page (`pages/…`)</span>
                <input value={draft.outputPath} onChange={(e) => setDraft({ ...draft, outputPath: e.target.value })} placeholder="pages/reports/weekly.md" className="mono" data-testid="rhythm-output" />
              </label>
            </div>
          ) : null}
          <div className="bd-row2">
            <label className="bd-field">
              <span>Model alias (optional)</span>
              <input value={draft.modelAlias} onChange={(e) => setDraft({ ...draft, modelAlias: e.target.value })} placeholder="the bot's own" data-testid="rhythm-model" />
            </label>
            <label className="bd-field">
              <span>Effort (optional)</span>
              <select value={draft.effort} onChange={(e) => setDraft({ ...draft, effort: e.target.value as RhythmDraft['effort'] })} data-testid="rhythm-effort">
                <option value="">the runtime's default</option>
                {EFFORTS.map((x) => (
                  <option key={x} value={x}>{x}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="bd-check">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} data-testid="rhythm-enabled" />
            <span>Enabled</span>
          </label>
          <div className="bd-toolbar-act">
            <button type="button" className="btn s" onClick={() => setDraft(null)}>Cancel</button>
            <button type="button" className="btn primary" disabled={draft.name.trim() === '' || draft.botSlug === ''} onClick={() => void save()} data-testid="save-rhythm">
              Save rhythm
            </button>
          </div>
        </div>
      ) : null}

      {rhythms.length === 0 ? (
        <div className="bd-empty" data-testid="rhythms-empty">
          <p className="bd-empty-title">No rhythms yet</p>
          <p className="bd-empty-body">A heartbeat nudges a bot on a schedule; a routine runs a contract and writes a page; a task opens a card. None is running right now.</p>
        </div>
      ) : (
        <div className="bd-rhythm-list" data-landmark="rhythms">
          {rhythms.map((r) => (
            <div key={r.id} className={`bd-rhythm ${selected === r.id ? 'on' : ''}`} data-testid="rhythm-row" data-rhythm={r.id} data-enabled={r.enabled}>
              <button type="button" className="bd-rhythm-main" onClick={() => setSelected(r.id === selected ? null : r.id)} data-testid="rhythm-open">
                <span className="bd-rhythm-name">{r.name}</span>
                <span className={`bd-kind ${r.kind}`}>{RHYTHM_KIND_LABEL[r.kind]}</span>
                <span className="bd-muted">{botName(r.botId)}</span>
                <span className="mono bd-rhythm-schedule">{r.schedule}</span>
                <span className="bd-muted" data-vt-mask>
                  {r.enabled ? (r.nextRunAt ? <>next <Time iso={r.nextRunAt} /></> : 'enabled') : 'paused'}
                </span>
              </button>
              <div className="bd-rhythm-act">
                {canManage ? (
                  <button type="button" className="btn s" disabled={busy !== null} onClick={() => void toggle(r)} data-testid="rhythm-toggle">
                    {r.enabled ? 'Pause' : 'Enable'}
                  </button>
                ) : null}
                {canManage ? (
                  <button type="button" className="btn s" disabled={busy !== null} onClick={() => void run(r)} data-testid="rhythm-run">
                    Run now
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {current ? (
        <div className="bd-runs" data-testid="rhythm-runs" data-rhythm={current.id}>
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

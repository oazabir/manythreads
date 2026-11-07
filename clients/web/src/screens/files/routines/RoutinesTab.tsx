import { useState } from 'react';
import { Link } from 'react-router';
import { PERSONAL_ROUTINE_RECIPES, type ListPersonalRoutinesResponse, type PersonalRoutine, type RoutineQuietHours } from '@manythreads/shared';
import { PageHeader } from '../../../components/PageHeader';
import { proIcon } from '../../../components/proicon';
import { ForbiddenBody, QueryView } from '../../../components/states';
import { Time } from '../../../components/ui';
import { useSession } from '../../../app/session';
import { useQuery } from '../../../app/useQuery';
import { message } from '../../memory/inboxWords';
import { AddIcon, AlarmClockIcon, DeleteIcon, PlayIcon, TaskListIcon } from '@proicons/react';
import { NewRoutineDialog } from './NewRoutineDialog';
import { RoutineRuns } from './RoutineRuns';
import { deleteRoutine, fetchRoutines, runRoutineNow, saveRoutineSettings, updateRoutine } from './routinesApi';
import {
  allowancePercent,
  allowanceSentence,
  canRunNow,
  countSentence,
  limitsSentence,
  localTimeZone,
  outputModeLabel,
  quietHoursProblem,
  quietHoursSentence,
  routineLook,
  sourcesSentence,
  stopSentence,
  timeZoneProblem,
  turnOnLabel,
  lastRunSentence,
} from './routinesWords';

const PlusIcon = proIcon(AddIcon);
const ClockIcon = proIcon(AlarmClockIcon);
const RunIcon = proIcon(PlayIcon);
const TrashIcon = proIcon(DeleteIcon);
const ListIcon = proIcon(TaskListIcon);

/**
 * Account → Routines (PLAN P20-10, P20-11, P20-14): the routines a person has set up for themselves. A routine is a bot that runs on a schedule with the person asking,
 * in the person's own conversation, and writes into the person's own files. It is made from a sentence, shown as a plan first, and never switched on without a yes.
 * The page also holds the person's time zone, quiet hours and what they have spent of their monthly allowance.
 */
export function RoutinesTab() {
  // This page sits in the settings frame, outside the app shell: the role comes from the session. A guest has no Personal space and so no routines.
  const guest = useSession().role === 'guest';
  if (guest) return <div className="inline-state"><ForbiddenBody /></div>;
  return <RoutinesBody />;
}

function RoutinesBody() {
  const q = useQuery('my-routines', fetchRoutines);
  const [dialog, setDialog] = useState<{ startWith: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const zoneNow = localTimeZone();
  const zoneOf = (data: ListPersonalRoutinesResponse | undefined): string => data?.settings.timeZone ?? zoneNow;
  const loaded = q.status === 'ok' ? q.data : undefined;

  return (
    <>
      <PageHeader
        title="Your routines"
        description="A routine is a bot that does something for you on a schedule and puts the answer in your own files. It reads only what you could read yourself."
        actions={
          <button type="button" className="btn primary" onClick={() => setDialog({ startWith: null })} disabled={loaded !== undefined && loaded.limits.used >= loaded.limits.maxRoutines} data-testid="routine-new">
            <PlusIcon /> New routine
          </button>
        }
      />
      {notice ? <p className="rt-notice" role="status" data-testid="routine-notice">{notice}</p> : null}
      <QueryView q={q}>
        {(data) => (
          <>
            <section className="block" aria-labelledby="rt-list" data-testid="routines">
              <h2 className="bh" id="rt-list">Routines</h2>
              {data.items.length === 0 ? (
                <div className="block-body">
                  <p className="d" data-testid="routines-none">You have no routines yet. Start from a ready one below, or write what you want in a sentence.</p>
                </div>
              ) : (
                <ul className="rt-list">
                  {data.items.map((r) => (
                    <RoutineRow key={r.id} routine={r} onChanged={q.reload} onNotice={setNotice} />
                  ))}
                </ul>
              )}
            </section>

            <section className="block" aria-labelledby="rt-shelf" data-testid="routine-shelf">
              <h2 className="bh" id="rt-shelf">Ready routines</h2>
              <ul className="rt-shelf">
                {PERSONAL_ROUTINE_RECIPES.map((r) => (
                  <li key={r.id} className="rt-card" data-testid="routine-recipe" data-recipe={r.id}>
                    <div className="rt-card-main">
                      <div className="rt-card-name">{r.name}</div>
                      <p className="rt-card-why">{r.summary}</p>
                    </div>
                    <button type="button" className="btn s" onClick={() => setDialog({ startWith: r.id })} disabled={data.limits.used >= data.limits.maxRoutines} aria-label={`Set up ${r.name}`} data-testid="routine-recipe-use">Set up</button>
                  </li>
                ))}
              </ul>
              <p className="rt-more"><ListIcon /> Your action items have their own page. <Link to="/account/action-items" data-testid="routine-to-action-items">Open action items</Link></p>
            </section>

            <SettingsBlock data={data} onSaved={q.reload} />
          </>
        )}
      </QueryView>
      {dialog ? (
        <NewRoutineDialog
          timeZone={zoneOf(loaded)}
          startWith={dialog.startWith}
          onClose={() => setDialog(null)}
          onCreated={(r) => {
            setDialog(null);
            setNotice(`“${r.name}” is on. ${r.scheduleWords}.`);
            q.reload();
          }}
        />
      ) : null}
    </>
  );
}

function RoutineRow({ routine: r, onChanged, onNotice }: { routine: PersonalRoutine; onChanged: () => void; onNotice: (s: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const look = routineLook(r);
  const stopped = stopSentence(r);

  const act = async (work: () => Promise<unknown>, fallback: string, after?: () => void): Promise<void> => {
    setBusy(true);
    setError(null);
    onNotice(null);
    try {
      await work();
      after?.();
      onChanged();
    } catch (e) {
      setError(message(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const setOn = (enabled: boolean): Promise<void> => act(() => updateRoutine(r.id, { enabled }), 'That could not be changed. The routine is as it was.');

  return (
    <li className="rt-row" data-testid="routine" data-routine={r.slug} data-enabled={r.enabled} data-stopped={r.stoppedReason ?? ''}>
      <div className="rt-main">
        <div className="rt-title">
          <span className="rt-name" data-testid="routine-name-text">{r.name}</span>
          <span className={`chip ${look.tone === 'ok' ? 'ok' : look.tone === 'warn' ? 'warn' : ''}`} data-testid="routine-state">{look.label}</span>
        </div>
        <p className="rt-line" data-testid="routine-schedule"><ClockIcon /> {r.scheduleWords} <span className="rt-faint">({r.timeZone})</span>{r.botName ? <> · run by {r.botName}</> : null}</p>
        <p className="rt-line">{sourcesSentence(r.sources)}</p>
        <p className="rt-line">{outputModeLabel(r.outputMode)}: <span className="mono">{r.outputPath}</span></p>
        <p className="rt-line" data-testid="routine-last">{lastRunSentence(r.lastRun)}{r.lastRun ? <> <Time iso={r.lastRun.startedAt} /></> : null}{r.enabled && r.nextRunAt ? <> Next run <Time iso={r.nextRunAt} />.</> : null}</p>
        {stopped ? <p className="rt-stop" role="status" data-testid="routine-stop-reason">{stopped}</p> : null}
        {error ? <p className="rt-error" role="alert" data-testid="routine-error">{error}</p> : null}
        {showRuns ? <RoutineRuns routineId={r.id} /> : null}
      </div>
      <div className="rt-actions">
        {r.stoppedReason || !r.enabled ? (
          <button type="button" className="btn s primary" disabled={busy} onClick={() => void setOn(true)} aria-label={`${turnOnLabel(r)}: ${r.name}`} data-testid="routine-turn-on">{turnOnLabel(r)}</button>
        ) : (
          <button type="button" className="btn s" disabled={busy} onClick={() => void setOn(false)} aria-label={`Pause ${r.name}`} data-testid="routine-pause">Pause</button>
        )}
        <button type="button" className="btn s" disabled={busy || !canRunNow(r)} onClick={() => void act(() => runRoutineNow(r.id), 'It could not start.', () => { setShowRuns(true); onNotice(`“${r.name}” was asked to run. Its answer lands in ${r.outputPath}.`); })} aria-label={`Run ${r.name} now`} data-testid="routine-run-now"><RunIcon /> Run now</button>
        <button type="button" className="btn s quiet" aria-expanded={showRuns} onClick={() => setShowRuns((v) => !v)} data-testid="routine-toggle-runs">{showRuns ? 'Hide runs' : 'Runs'}</button>
        {confirmDelete ? (
          <span className="rt-confirm" role="group" aria-label={`Delete ${r.name}`}>
            <span className="rt-confirm-q">Delete it? Its files stay.</span>
            <button type="button" className="btn s danger" disabled={busy} onClick={() => void act(() => deleteRoutine(r.id), 'It could not be deleted.')} data-testid="routine-delete-yes">Delete</button>
            <button type="button" className="btn s" onClick={() => setConfirmDelete(false)} data-testid="routine-delete-no">Keep</button>
          </span>
        ) : (
          <button type="button" className="btn s quiet" disabled={busy} onClick={() => setConfirmDelete(true)} aria-label={`Delete ${r.name}`} data-testid="routine-delete"><TrashIcon /></button>
        )}
      </div>
    </li>
  );
}

/** Time zone, quiet hours, and what a person is held to: the count, the monthly allowance and the per-run limits. */
function SettingsBlock({ data, onSaved }: { data: ListPersonalRoutinesResponse; onSaved: () => void }) {
  const { settings, limits } = data;
  const [zone, setZone] = useState(settings.timeZone ?? localTimeZone());
  const [quiet, setQuiet] = useState(settings.quietHours !== null);
  const [from, setFrom] = useState(settings.quietHours?.from ?? '22:00');
  const [to, setTo] = useState(settings.quietHours?.to ?? '07:00');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = timeZoneProblem(zone) ?? (quiet ? quietHoursProblem(from, to) : null);
  const quietHours: RoutineQuietHours | null = quiet ? { from, to } : null;

  const save = async (): Promise<void> => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await saveRoutineSettings({ timeZone: zone.trim(), quietHours });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(message(e, 'That could not be saved. Your settings are as they were.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="block" aria-labelledby="rt-settings" data-testid="routine-settings">
      <h2 className="bh" id="rt-settings">Time and limits</h2>
      <form className="block-body rt-settings" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="dlg-label" htmlFor="rts-zone">Your time zone</label>
        <input id="rts-zone" className="dlg-input" value={zone} maxLength={64} onChange={(e) => { setZone(e.target.value); setSaved(false); }} autoComplete="off" spellCheck={false} data-testid="routine-settings-zone" />
        <label className="rt-check">
          <input type="checkbox" checked={quiet} onChange={(e) => { setQuiet(e.target.checked); setSaved(false); }} data-testid="routine-quiet-on" />
          <span>Quiet hours</span>
        </label>
        {quiet ? (
          <div className="rt-quiet">
            <label className="dlg-label" htmlFor="rts-from">From</label>
            <input id="rts-from" className="dlg-input" type="time" value={from} onChange={(e) => { setFrom(e.target.value); setSaved(false); }} data-testid="routine-quiet-from" />
            <label className="dlg-label" htmlFor="rts-to">Until</label>
            <input id="rts-to" className="dlg-input" type="time" value={to} onChange={(e) => { setTo(e.target.value); setSaved(false); }} data-testid="routine-quiet-to" />
          </div>
        ) : null}
        <p className="dlg-hint" data-testid="routine-quiet-sentence">{quietHoursSentence(quietHours)}</p>
        {problem ? <p className="dlg-error" role="alert">{problem}</p> : null}
        {error ? <p className="dlg-error" role="alert" data-testid="routine-settings-error">{error}</p> : null}
        <div className="rt-save">
          <button type="submit" className="btn primary" disabled={busy || problem !== null} data-testid="routine-settings-save">{busy ? 'Saving…' : 'Save'}</button>
          {saved ? <span className="rt-saved" role="status" data-testid="routine-settings-saved">Saved.</span> : null}
        </div>

        <h3 className="rt-sub">What you have used</h3>
        <p className="rt-line" data-testid="routine-count">{countSentence(limits)}</p>
        <progress className="rt-meter" max={100} value={allowancePercent(limits)} aria-label="Spending allowance used this month" data-testid="routine-allowance-bar" />
        <p className="rt-line" data-testid="routine-allowance">{allowanceSentence(limits)}</p>
        <p className="dlg-hint" data-testid="routine-limits">{limitsSentence(limits)}</p>
      </form>
    </section>
  );
}

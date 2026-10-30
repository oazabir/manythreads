import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { MyPresence } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { toLocalInput } from '../later/times';
import { MoonIcon } from '../shell/icons';
import { CLEAR_CHOICES, STATUS_PRESETS, WEEK_ORDER, dayName } from './format';
import { useNow } from './hooks';
import {
  DEFAULT_HOURS,
  HELD_NOTE,
  HOLD_REQUEST,
  PAUSE_PRESETS,
  QUICK_EMOJI,
  RESUME_REQUEST,
  defaultRows,
  clearsText,
  customPause,
  deviceTimeZone,
  fitsRows,
  hoursDraftOf,
  pauseEnd,
  pauseRequest,
  profileRequest,
  rowsOf,
  runsOvernight,
  sameHours,
  sameRows,
  scheduleRequest,
  statusDraftOf,
  statusRequest,
  timeZoneChoices,
  untilText,
  zoneClock,
  type DayRow,
  type DndBanner,
  type HoursDraft,
  type PausePreset,
  type StatusDraft,
} from './settingsModel';
import { presenceStore } from './store';

/*
 * The parts of the status and Do not disturb screen (PLAN P14-01). The Account page lays them out as one section; the account menu opens the status
 * and the pause parts in a dialog. Each part saves on its own through the presence store and says in words what went wrong.
 */

/** A sentence for a failed save: the server's own words for a refusal, a plain one otherwise. */
export function saveErrorText(e: unknown): string {
  if (isApiError(e) && e.status === 429) return 'Too many changes in a short time. Wait a moment and try again.';
  if (isApiError(e) && e.message && e.status !== 0 && e.status < 500) return e.message;
  return 'Could not save that. Check your connection and try again.';
}

/** One save at a time: `busy` and `error` for a part, and a guard that makes a second press during the first do nothing. */
export function useSaver(): { busy: boolean; error: string | null; run: (fn: () => Promise<unknown>, after?: () => void) => Promise<void>; fail: (text: string | null) => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const going = useRef(false);
  const run = async (fn: () => Promise<unknown>, after?: () => void): Promise<void> => {
    if (going.current) return;
    going.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      after?.();
    } catch (e) {
      setError(saveErrorText(e));
    } finally {
      going.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run, fail: setError };
}

/** Ends a pause or a hand-set Do not disturb. */
export const resumeNow = (): Promise<MyPresence> => presenceStore.saveDnd(RESUME_REQUEST);

// ---- the paused state -------------------------------------------------------------------------------------------------------------

/** "Paused until 14:30 · Resume now", with what happens to messages meanwhile. Quiet hours offer the way to change the schedule instead of a resume. */
export function PausedNote({ banner, onResume, busy, error, children }: { banner: DndBanner; onResume?: () => void; busy?: boolean; error?: string | null; children?: ReactNode }) {
  return (
    <div className="pr-paused" data-testid="paused-note" data-reason={banner.reason}>
      <div className="pr-paused-row">
        <span className="pr-paused-ic" aria-hidden="true"><MoonIcon /></span>
        <span className="pr-paused-text" data-vt-mask>{banner.text}</span>
        {banner.canResume && onResume ? (
          <button type="button" className="btn s" data-testid="resume-now" disabled={busy} onClick={onResume}>Resume now</button>
        ) : null}
        {children}
      </div>
      <p className="pr-help">{HELD_NOTE}</p>
      {error ? <p className="pr-error" role="alert">{error}</p> : null}
    </div>
  );
}

// ---- pause notifications ---------------------------------------------------------------------------------------------------------

/** The ways to pause: ready-made lengths, until the person ends it, or until a time of their own. `onDone` runs after a pause is saved. */
export function PauseControls({ banner, onDone, autoFocus }: { banner: DndBanner | null; onDone?: () => void; autoFocus?: boolean }) {
  const id = useId();
  const now = useNow(30_000);
  const save = useSaver();
  const [custom, setCustom] = useState(() => toLocalInput(new Date(Date.now() + 2 * 3_600_000)));
  const pick = (preset: PausePreset): void => void save.run(() => presenceStore.saveDnd(pauseRequest(preset, new Date())), onDone);
  const submitCustom = (e: FormEvent): void => {
    e.preventDefault();
    const built = customPause(custom, new Date());
    if (!built.ok) return save.fail(built.problem);
    void save.run(() => presenceStore.saveDnd(built.request), onDone);
  };
  return (
    <div className="pr-group" data-testid="pause-controls">
      {banner ? <PausedNote banner={banner} onResume={() => void save.run(resumeNow, onDone)} busy={save.busy} /> : null}
      <p className="pr-help">{banner ? 'Change how long:' : 'Stop notifications for a while. Direct messages, mentions and reminders wait too.'}</p>
      <div className="pr-choices" role="group" aria-label="Pause notifications for">
        {PAUSE_PRESETS.map((p, i) => (
          <button key={p.id} type="button" className="pr-choice" data-testid={`pause-${p.id}`} data-autofocus={autoFocus && i === 0 ? true : undefined} disabled={save.busy} onClick={() => pick(p.id)}>
            <span>{p.label}</span>
            <small data-vt-mask>until {untilText(pauseEnd(p.id, now).toISOString(), now)}</small>
          </button>
        ))}
        <button type="button" className="pr-choice" data-testid="pause-hold" disabled={save.busy} onClick={() => void save.run(() => presenceStore.saveDnd(HOLD_REQUEST), onDone)}>
          <span>Until I turn it off</span>
          <small>Stays on until you resume</small>
        </button>
      </div>
      <form className="pr-custom" onSubmit={submitCustom} noValidate>
        <label className="pr-label" htmlFor={`${id}-until`}>Or pause until (your time zone)</label>
        <div className="pr-inline">
          <input
            id={`${id}-until`}
            className="pr-input"
            type="datetime-local"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              save.fail(null);
            }}
            data-testid="pause-custom-time"
          />
          <button type="submit" className="btn" disabled={save.busy} data-testid="pause-custom-save">Pause until then</button>
        </div>
      </form>
      {save.error ? <p className="pr-error" role="alert" data-testid="pause-error">{save.error}</p> : null}
    </div>
  );
}

// ---- custom status ---------------------------------------------------------------------------------------------------------------

/** The status editor: emoji, words, when to clear, and a few ready-made statuses. `onDone` runs after a save or a clear. */
export function StatusEditor({ me, onDone, autoFocus }: { me: MyPresence; onDone?: () => void; autoFocus?: boolean }) {
  const id = useId();
  const now = useNow(30_000);
  const save = useSaver();
  const current = me.status;
  const [draft, setDraft] = useState<StatusDraft>(() => statusDraftOf(current));
  const set = (patch: Partial<StatusDraft>): void => {
    setDraft((d) => ({ ...d, ...patch }));
    save.fail(null);
  };
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const built = statusRequest(draft, current, new Date());
    if (!built.ok) return save.fail(built.problem);
    void save.run(() => presenceStore.saveProfile(built.body), onDone);
  };
  const clear = (): void => void save.run(() => presenceStore.saveProfile({ status: null }), () => {
    setDraft(statusDraftOf(null));
    onDone?.();
  });
  const when = clearsText(current, now);
  return (
    <form className="pr-group" onSubmit={submit} noValidate data-testid="status-editor">
      {current ? (
        <p className="pr-now" data-testid="status-now">
          <span aria-hidden="true">{current.emoji}</span> {current.text}
          {when ? <small data-vt-mask> · {when}</small> : null}
        </p>
      ) : null}
      <div className="pr-inline pr-status-row">
        <div className="pr-field pr-emoji-field">
          <label className="pr-label" htmlFor={`${id}-emoji`}>Emoji</label>
          <input id={`${id}-emoji`} className="pr-input" value={draft.emoji} maxLength={16} autoComplete="off" onChange={(e) => set({ emoji: e.target.value })} data-testid="status-emoji" data-autofocus={autoFocus || undefined} />
        </div>
        <div className="pr-field pr-grow">
          <label className="pr-label" htmlFor={`${id}-text`}>What are you up to?</label>
          <input id={`${id}-text`} className="pr-input" value={draft.text} maxLength={100} autoComplete="off" placeholder="In a meeting" onChange={(e) => set({ text: e.target.value })} data-testid="status-text" />
        </div>
      </div>
      <div className="pr-quick" role="group" aria-label="Quick emoji">
        {QUICK_EMOJI.map((e) => (
          <button key={e} type="button" className="pr-quick-btn" aria-label={`Use ${e}`} onClick={() => set({ emoji: e })}>
            <span aria-hidden="true">{e}</span>
          </button>
        ))}
      </div>
      <div className="pr-presets" role="group" aria-label="Ready-made statuses">
        {STATUS_PRESETS.map((p) => (
          <button key={p.text} type="button" className="chip pr-preset" onClick={() => set({ emoji: p.emoji, text: p.text, clear: p.clear })}>
            <span aria-hidden="true">{p.emoji}</span> {p.text}
          </button>
        ))}
      </div>
      <div className="pr-field">
        <label className="pr-label" htmlFor={`${id}-clear`}>Clear after</label>
        <select id={`${id}-clear`} className="pr-input" value={draft.clear} onChange={(e) => set({ clear: e.target.value as StatusDraft['clear'] })} data-testid="status-clear">
          {current?.clearsAt ? <option value="keep">Keep the current time{when ? ` (${when.charAt(0).toLowerCase()}${when.slice(1)})` : ''}</option> : null}
          {CLEAR_CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>
      {save.error ? <p className="pr-error" role="alert" data-testid="status-error">{save.error}</p> : null}
      <div className="pr-actions">
        <button type="submit" className="btn primary" disabled={save.busy} data-testid="status-save">Save status</button>
        {current ? <button type="button" className="btn" disabled={save.busy} onClick={clear} data-testid="status-clear-now">Clear status</button> : null}
      </div>
    </form>
  );
}

// ---- weekly schedule -------------------------------------------------------------------------------------------------------------

/** Quiet hours on a weekly schedule: per weekday on or off with a from and a to time, read in the person's time zone. */
export function ScheduleEditor({ me }: { me: MyPresence }) {
  const id = useId();
  const save = useSaver();
  const saved = me.dnd.schedule;
  const savedRows = rowsOf(saved);
  const [enabled, setEnabled] = useState(saved.enabled);
  const [rows, setRows] = useState<DayRow[]>(savedRows);
  const [note, setNote] = useState<string | null>(null);
  const zone = me.timeZone ?? deviceTimeZone();
  const dirty = enabled !== saved.enabled || !sameRows(rows, savedRows);
  const change = (fn: () => void): void => {
    fn();
    setNote(null);
    save.fail(null);
  };
  const turn = (on: boolean): void =>
    change(() => {
      setEnabled(on);
      if (on && !rows.some((r) => r.on)) setRows(defaultRows());
    });
  const edit = (day: number, patch: Partial<DayRow>): void => change(() => setRows((rs) => rs.map((r) => (r.day === day ? { ...r, ...patch } : r))));
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const built = scheduleRequest(enabled, rows);
    if (!built.ok) return save.fail(built.problem);
    if (zone === null) return save.fail('Choose your time zone below before you use a schedule.');
    void save.run(
      async () => {
        // The server reads a schedule in the saved zone (UTC when none is saved): save this device's zone first so the hours mean what the screen says.
        if (me.timeZone === null) await presenceStore.saveProfile({ timeZone: zone });
        await presenceStore.saveDnd(built.request);
      },
      () => setNote(enabled ? 'Schedule saved.' : 'Schedule saved and switched off.'),
    );
  };
  return (
    <form className="pr-group" onSubmit={submit} noValidate data-testid="schedule-editor">
      <div className="pr-switch-row">
        <div>
          <div id={`${id}-sw`}>Quiet hours on a weekly schedule</div>
          <p className="pr-help">Notifications wait during these hours and arrive together when they end. Times are read in <b data-testid="schedule-zone">{zone ?? 'UTC'}</b>{me.timeZone === null && zone ? ' (this device’s zone; saved with the schedule)' : ''}.</p>
        </div>
        <button type="button" role="switch" aria-checked={enabled} aria-labelledby={`${id}-sw`} className={`tog ${enabled ? 'on' : ''}`} onClick={() => turn(!enabled)} data-testid="schedule-switch" />
      </div>
      {!fitsRows(saved) ? <p className="pr-help" data-testid="schedule-lossy">This schedule has more than one period on a day. Saving here keeps the first period of each day.</p> : null}
      <ul className="pr-days" aria-label="Quiet hours per weekday">
        {rows.map((r) => (
          <li key={r.day} className="pr-day" data-day={r.day} data-on={r.on}>
            <label className="pr-day-name">
              <input type="checkbox" checked={r.on} disabled={!enabled} onChange={(e) => edit(r.day, { on: e.target.checked })} data-testid={`day-${r.day}-on`} />
              <span>{dayName(r.day)}<span className="sr-only"> quiet hours</span></span>
            </label>
            <label className="pr-time">
              <span className="pr-time-l">From<span className="sr-only"> on {dayName(r.day)}</span></span>
              <input className="pr-input" type="time" value={r.start} disabled={!enabled || !r.on} onChange={(e) => edit(r.day, { start: e.target.value })} data-testid={`day-${r.day}-start`} />
            </label>
            <label className="pr-time">
              <span className="pr-time-l">To<span className="sr-only"> on {dayName(r.day)}</span></span>
              <input className="pr-input" type="time" value={r.end} disabled={!enabled || !r.on} onChange={(e) => edit(r.day, { end: e.target.value })} data-testid={`day-${r.day}-end`} />
            </label>
            <span className="pr-day-hint">{r.on && runsOvernight(r) ? 'to the next morning' : ''}</span>
          </li>
        ))}
      </ul>
      {save.error ? <p className="pr-error" role="alert" data-testid="schedule-error">{save.error}</p> : null}
      {note ? <p className="pr-ok" role="status" data-testid="schedule-note">{note}</p> : null}
      <div className="pr-actions">
        <button type="submit" className="btn primary" disabled={save.busy || !dirty} data-testid="schedule-save">Save schedule</button>
        {dirty ? (
          <button type="button" className="btn quiet" disabled={save.busy} onClick={() => change(() => { setEnabled(saved.enabled); setRows(savedRows); })}>Undo changes</button>
        ) : null}
      </div>
    </form>
  );
}

// ---- time zone and working hours -------------------------------------------------------------------------------------------------

/** The person's time zone (with their local time) and working hours. */
export function HoursEditor({ me }: { me: MyPresence }) {
  const id = useId();
  const now = useNow(30_000);
  const save = useSaver();
  const device = deviceTimeZone();
  const [zone, setZone] = useState<string>(me.timeZone ?? device ?? 'UTC');
  const savedHours = hoursDraftOf(me.workingHours);
  const [hours, setHours] = useState<HoursDraft>(savedHours);
  const [note, setNote] = useState<string | null>(null);
  const dirty = zone !== (me.timeZone ?? '') || !sameHours(hours, savedHours);
  const change = (fn: () => void): void => {
    fn();
    setNote(null);
    save.fail(null);
  };
  const toggleDay = (day: number, on: boolean): void =>
    change(() => setHours((h) => ({ ...h, days: on ? [...new Set([...h.days, day])] : h.days.filter((d) => d !== day) })));
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const built = profileRequest(zone, hours);
    if (!built.ok) return save.fail(built.problem);
    void save.run(() => presenceStore.saveProfile(built.body), () => setNote('Saved.'));
  };
  const choices = timeZoneChoices(me.timeZone, device);
  return (
    <form className="pr-group" onSubmit={submit} noValidate data-testid="hours-editor">
      <div className="pr-field">
        <label className="pr-label" htmlFor={`${id}-zone`}>Time zone</label>
        <select id={`${id}-zone`} className="pr-input" value={zone} onChange={(e) => change(() => setZone(e.target.value))} data-testid="zone-select">
          {choices.map((z) => <option key={z} value={z}>{z.replaceAll('_', ' ')}</option>)}
        </select>
        <p className="pr-help" data-vt-mask>It is {zoneClock(zone, now)} there now. {me.timeZone === null ? 'No zone is saved yet: a weekly schedule reads UTC until you save one.' : ''}</p>
      </div>
      <div className="pr-switch-row">
        <div>
          <div id={`${id}-hrs`}>Working hours</div>
          <p className="pr-help">Shown on your profile card with your local time, so people know when to expect an answer.</p>
        </div>
        <button type="button" role="switch" aria-checked={hours.on} aria-labelledby={`${id}-hrs`} className={`tog ${hours.on ? 'on' : ''}`} onClick={() => change(() => setHours((h) => ({ ...h, on: !h.on, days: h.days.length ? h.days : [...DEFAULT_HOURS.days] })))} data-testid="hours-switch" />
      </div>
      {hours.on ? (
        <>
          <fieldset className="pr-fieldset">
            <legend className="pr-label">Working days</legend>
            <div className="pr-daychips">
              {WEEK_ORDER.map((d) => (
                <label key={d} className={`pr-daychip ${hours.days.includes(d) ? 'on' : ''}`}>
                  <input type="checkbox" checked={hours.days.includes(d)} onChange={(e) => toggleDay(d, e.target.checked)} data-testid={`hours-day-${d}`} />
                  <span>{dayName(d)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="pr-inline">
            <div className="pr-field">
              <label className="pr-label" htmlFor={`${id}-from`}>From</label>
              <input id={`${id}-from`} className="pr-input" type="time" value={hours.start} onChange={(e) => change(() => setHours((h) => ({ ...h, start: e.target.value })))} data-testid="hours-start" />
            </div>
            <div className="pr-field">
              <label className="pr-label" htmlFor={`${id}-to`}>To</label>
              <input id={`${id}-to`} className="pr-input" type="time" value={hours.end} onChange={(e) => change(() => setHours((h) => ({ ...h, end: e.target.value })))} data-testid="hours-end" />
            </div>
          </div>
        </>
      ) : null}
      {save.error ? <p className="pr-error" role="alert" data-testid="hours-error">{save.error}</p> : null}
      {note ? <p className="pr-ok" role="status" data-testid="hours-note">{note}</p> : null}
      <div className="pr-actions">
        <button type="submit" className="btn primary" disabled={save.busy || !dirty} data-testid="hours-save">Save time zone and hours</button>
      </div>
    </form>
  );
}

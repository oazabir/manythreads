import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { cronRunsBetween, type Appointment, type AppointmentAgendaResponse } from '@manythreads/shared';
import { fetchScheduledJobs } from '../boards/api';
import { useQuery } from '../../app/useQuery';
import { Dialog } from '../../components/Dialog';
import { PageHeader } from '../../components/PageHeader';
import { cancelAppointment, fetchAppointment, fetchAppointmentAgenda, fetchAppointments, joinAppointment, stopMeetingSeries } from '../../meetings/api';
import { Markdown } from '../../channels/MessageMarkdown';
import { callController } from '../../meetings/store';
import { useShell } from '../../shell/context';
import { SeriesIcon } from '../../shell/icons';
import { meetingPath } from '../../shell/messageLink';
import { useNarrow } from '../../shell/useNarrow';
import { LivePageEditor } from '../../viewers/markdown/LivePageEditor';
import { useNewRequest } from '../../shell/useNewRequest';
import { AppointmentForm } from './AppointmentForm';
import { agendaDay, repeatLabel } from './series';
import { addDays, joinable, onDay, placeInDay, sameDay, step, timeRange, viewDays, viewLabel, type CalendarView } from './calendar';

/*
 * Schedule (P36-05, docs/plans/team-schedule.md): the appointments of every team the person is on, and those they are invited to from other teams, on one
 * calendar: Day, Week and Month, today marked and a line at the current time; each team in its own colour with a chip to show or hide it. Opening one shows
 * who is invited and Join (from ten minutes before until it ends); its maker, a lead of its team or an admin can change or cancel it. On a phone the week is a
 * list of days.
 * A meeting of a series (P17-05) says how it repeats and opens its agenda page, edited live by the team; whoever may change the series can stop it. The people
 * invited from other teams read the agenda (step 2). `?appointment=<id>` (a reminder) opens that meeting's panel.
 */

const HOUR_PX = 48;
const PALETTE = 9;

const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
};

export function ScheduleScreen() {
  const { teams, team } = useShell();
  const narrow = useNarrow();
  const navigate = useNavigate();
  const [view, setView] = useState<CalendarView>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<Appointment | null>(null);
  const [form, setForm] = useState<{ appointment?: Appointment; start?: Date } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [agenda, setAgenda] = useState<{ path: string; teamSlug: string; title: string } | null>(null);
  const [stopAsk, setStopAsk] = useState(false);
  // the agenda as text, for a person invited from another team (they cannot open the team's files)
  const [reading, setReading] = useState<{ title: string; page: AppointmentAgendaResponse | null; error: string | null } | null>(null);
  const [params, setParams] = useSearchParams();
  // "Schedule a meeting" in the sidebar's New menu (`?new=appointment`): the New appointment form opens, with the cursor in its first box
  const asked = useNewRequest(['appointment'] as const);
  const askedDone = asked.done;
  const askedAppointment = asked.kind === 'appointment';
  useEffect(() => {
    if (!askedAppointment) return;
    setForm({});
    askedDone();
  }, [askedAppointment, askedDone]);
  const now = useNow();
  const shownView: CalendarView = narrow && view === 'week' ? 'day' : view;
  const days = useMemo(() => viewDays(shownView, anchor), [shownView, anchor]);
  const from = days[0]!.toISOString();
  const to = addDays(days[days.length - 1]!, 1).toISOString();
  const q = useQuery(`appointments:${from}:${to}`, () => fetchAppointments(from, to));
  const colourOf = useMemo(() => {
    const order = new Map(teams.map((t, i) => [t.id as string, i % PALETTE]));
    return (teamId: string): number => (order.get(teamId) ?? (PALETTE - 1)) + 1;
  }, [teams]);
  const all = q.status === 'ok' ? q.data.appointments : [];
  // the teams' routines beside the appointments (P36-04): each enabled one's runs in the window, from its schedule; one that runs more than twice a day
  // (a heartbeat) would bury the calendar and is left out
  const [routinesOn, setRoutinesOn] = useState(true);
  const slugs = teams.map((t) => t.slug).join(',');
  const jobsQ = useQuery(`schedule-routines:${slugs}`, async () => {
    const lists = await Promise.all(teams.map(async (t) => ({ team: t, items: (await fetchScheduledJobs(t.slug).catch(() => ({ items: [] }))).items })));
    return lists;
  });
  const routines = useMemo(() => {
    if (jobsQ.status !== 'ok') return [];
    const out: Array<{ key: string; teamId: string; teamSlug: string; name: string; at: Date }> = [];
    const windowDays = Math.max(1, (Date.parse(to) - Date.parse(from)) / 86_400_000);
    for (const { team: t, items: jobs } of jobsQ.data) {
      for (const j of jobs) {
        if (!j.enabled) continue;
        const runs = cronRunsBetween(j.schedule, new Date(from), new Date(to), 200);
        if (runs.length / windowDays > 2) continue;
        for (const at of runs) out.push({ key: `${j.id}:${at.toISOString()}`, teamId: t.id, teamSlug: t.slug, name: j.name, at });
      }
    }
    return out;
  }, [jobsQ, from, to]);
  const shownRoutines = routinesOn ? routines.filter((r) => !hidden.has(r.teamId)) : [];
  const routineBlock = (r: (typeof routines)[number], style?: React.CSSProperties) => (
    <button key={r.key} type="button" className={`sc-routine c${colourOf(r.teamId)}`} style={style} onClick={() => void navigate(`/t/${encodeURIComponent(r.teamSlug)}/jobs`)} title={`Routine: ${r.name} · ${r.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`} data-testid="schedule-routine">
      ⟳ {r.name}
    </button>
  );
  const items = all.filter((a) => !hidden.has(a.team.id));
  const grid = useRef<HTMLDivElement>(null);

  // a reminder opens one meeting: its panel, on its day
  const linked = params.get('appointment');
  useEffect(() => {
    if (!linked) return;
    // the link is taken off the address at once (a reload does not open it again), so the answer is not tied to this effect's life
    fetchAppointment(linked).then(
      (r) => {
        setAnchor(new Date(r.appointment.startsAt));
        setOpen(r.appointment);
      },
      // a meeting since made again or no longer shared: the calendar alone
      () => undefined,
    );
    setParams((p) => { const n = new URLSearchParams(p); n.delete('appointment'); return n; }, { replace: true });
  }, [linked, setParams]);

  const readAgenda = (a: Appointment): void => {
    setReading({ title: a.title, page: null, error: null });
    setOpen(null);
    fetchAppointmentAgenda(a.id).then(
      (page) => setReading({ title: a.title, page, error: null }),
      (e: unknown) => setReading({ title: a.title, page: null, error: e instanceof Error && e.message ? e.message : 'The agenda could not be loaded. Try again.' }),
    );
  };

  // the day starts in view at 08:00
  useEffect(() => {
    if (grid.current && shownView !== 'month') grid.current.scrollTop = HOUR_PX * 8 - 8;
  }, [shownView]);

  const join = async (a: Appointment): Promise<void> => {
    setProblem(null);
    try {
      const res = await joinAppointment(a.id);
      setOpen(null);
      void navigate(meetingPath(team?.slug ?? a.team.slug, res.channelId));
      await callController().enterOpened(res);
    } catch (e) {
      setProblem(e instanceof Error && e.message ? e.message : 'The meeting could not be joined. Try again.');
    }
  };
  const cancel = async (a: Appointment): Promise<void> => {
    setProblem(null);
    try {
      await cancelAppointment(a.id);
      setOpen(null);
      q.reload();
    } catch (e) {
      setProblem(e instanceof Error && e.message ? e.message : 'It could not be cancelled. Try again.');
    }
  };

  const stop = async (a: Appointment): Promise<void> => {
    if (!a.series) return;
    setProblem(null);
    try {
      await stopMeetingSeries(a.series.id);
      setStopAsk(false);
      setOpen(null);
      q.reload();
    } catch (e) {
      setProblem(e instanceof Error && e.message ? e.message : 'The series could not be stopped. Try again.');
    }
  };
  const closePanel = (): void => {
    setOpen(null);
    setStopAsk(false);
    setProblem(null);
  };

  const block = (a: Appointment, style?: React.CSSProperties, compact = false) => (
    <button
      key={a.id}
      type="button"
      className={`sc-appt c${colourOf(a.team.id)} ${a.status === 'cancelled' ? 'cancelled' : ''} ${a.liveMeetingId ? 'live' : ''}`}
      style={style}
      onClick={() => setOpen(a)}
      data-testid="schedule-appointment"
      data-id={a.id}
      title={`${a.title} · ${timeRange(a.startsAt, a.endsAt)} · ${a.team.name}`}
    >
      <span className="sc-appt-title">{a.series ? <span className="sc-series-mark" aria-label="Repeats" data-testid="schedule-series-mark"><SeriesIcon /></span> : null}{a.kind === 'video' ? '▶ ' : ''}{a.title}</span>
      <span className="sc-appt-time">{compact ? timeRange(a.startsAt, a.endsAt).split(' – ')[0] : timeRange(a.startsAt, a.endsAt)}</span>
    </button>
  );

  return (
    <div className="sc-screen" data-testid="schedule">
      <PageHeader
        title="Schedule"
        description={viewLabel(shownView, anchor)}
        actions={
          <div className="sc-actions">
            <div className="sc-nav">
              <button type="button" className="btn s" onClick={() => setAnchor((d) => step(shownView, d, -1))} aria-label="Earlier" data-testid="schedule-prev">‹</button>
              <button type="button" className="btn s" onClick={() => setAnchor(new Date())} data-testid="schedule-today">Today</button>
              <button type="button" className="btn s" onClick={() => setAnchor((d) => step(shownView, d, 1))} aria-label="Later" data-testid="schedule-next">›</button>
            </div>
            <div className="tabs2" role="tablist" aria-label="View">
              {(['day', 'week', 'month'] as const).map((v) => (
                <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)} data-testid={`schedule-view-${v}`}>
                  {v === 'day' ? 'Day' : v === 'week' ? 'Week' : 'Month'}
                </button>
              ))}
            </div>
            <button type="button" className="btn primary s" onClick={() => setForm({})} data-testid="schedule-new">New appointment</button>
          </div>
        }
      />
      <div className="sc-teams" role="group" aria-label="Teams">
        {teams.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`sc-chip c${colourOf(t.id)} ${hidden.has(t.id) ? 'off' : ''}`}
            aria-pressed={!hidden.has(t.id)}
            onClick={() => setHidden((h) => { const n = new Set(h); if (!n.delete(t.id)) n.add(t.id); return n; })}
            data-testid="schedule-team"
          >
            <span className="sc-dot" aria-hidden="true" /> {t.name}
          </button>
        ))}
        {routines.length > 0 ? (
          <button type="button" className={`sc-chip ${routinesOn ? '' : 'off'}`} aria-pressed={routinesOn} onClick={() => setRoutinesOn((v) => !v)} data-testid="schedule-routines">
            ⟳ Routines
          </button>
        ) : null}
        {q.status === 'error' ? <span className="dlg-error" role="alert">The schedule could not be loaded.</span> : null}
      </div>

      {shownView === 'month' ? (
        <div className="sc-month" data-testid="schedule-month">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="sc-mhead">{d}</div>)}
          {days.map((d) => {
            const these = onDay(items, d);
            return (
              <div key={d.toISOString()} className={`sc-mday ${d.getMonth() !== anchor.getMonth() ? 'other' : ''} ${sameDay(d, new Date(now)) ? 'today' : ''}`} onDoubleClick={() => setForm({ start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10) })}>
                <button type="button" className="sc-mnum" onClick={() => { setAnchor(d); setView('day'); }}>{d.getDate()}</button>
                {these.slice(0, 3).map((a) => block(a, undefined, true))}
                {shownRoutines.filter((r) => sameDay(r.at, d)).slice(0, 2).map((r) => routineBlock(r))}
                {these.length > 3 ? <button type="button" className="sc-more" onClick={() => { setAnchor(d); setView('day'); }}>+{these.length - 3} more</button> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="sc-week" style={{ '--sc-days': days.length } as React.CSSProperties}>
          <div className="sc-heads">
            <span className="sc-gutter" />
            {days.map((d) => (
              <div key={d.toISOString()} className={`sc-head ${sameDay(d, new Date(now)) ? 'today' : ''}`}>
                <span className="sc-wd">{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                <span className="sc-dn">{d.getDate()}</span>
              </div>
            ))}
          </div>
          <div className="sc-grid" ref={grid}>
            <div className="sc-hours" style={{ height: HOUR_PX * 24 }}>
              {Array.from({ length: 24 }, (_, h) => <span key={h} style={{ top: h * HOUR_PX }}>{h === 0 ? '' : `${String(h).padStart(2, '0')}:00`}</span>)}
            </div>
            {days.map((d) => (
              <div
                key={d.toISOString()}
                className={`sc-col ${sameDay(d, new Date(now)) ? 'today' : ''}`}
                style={{ height: HOUR_PX * 24 }}
                onDoubleClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  const minutes = Math.floor(((e.clientY - r.top) / HOUR_PX) * 2) * 30;
                  setForm({ start: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutes) });
                }}
                data-testid="schedule-day"
              >
                {shownRoutines
                  .filter((r) => sameDay(r.at, d))
                  .map((r) => routineBlock(r, { top: `${((r.at.getTime() - d.getTime()) / 86_400_000) * 100}%` }))}
                {placeInDay(items, d).map((p) =>
                  block(p.item, { top: `${p.top * 100}%`, height: `${p.height * 100}%`, left: `${(p.lane / p.lanes) * 100}%`, width: `calc(${100 / p.lanes}% - 4px)` }),
                )}
                {sameDay(d, new Date(now)) ? <span className="sc-now" style={{ top: `${((now - d.getTime()) / 86_400_000) * 100}%` }} aria-hidden="true" /> : null}
              </div>
            ))}
          </div>
        </div>
      )}
      {q.status === 'ok' && items.length === 0 ? <p className="sc-empty">Nothing on the schedule here. Double-click a time or press New appointment.</p> : null}

      {open ? (
        <Dialog
          title={open.title}
          onClose={closePanel}
          testId="appointment-panel"
          footer={
            stopAsk && open.series ? (
              <>
                <button type="button" className="btn" onClick={() => setStopAsk(false)}>Keep it</button>
                <button type="button" className="btn danger" onClick={() => void stop(open)} data-testid="series-stop-yes">Stop the series</button>
              </>
            ) : (
            <>
              {open.series && open.series.status === 'active' && open.canEdit ? (
                <button type="button" className="btn" onClick={() => setStopAsk(true)} data-testid="series-stop">Stop the series</button>
              ) : null}
              {open.canEdit && open.status === 'scheduled' ? (
                <>
                  <button type="button" className="btn danger" onClick={() => void cancel(open)} data-testid="appointment-cancel">Cancel it</button>
                  <button type="button" className="btn" onClick={() => { setForm({ appointment: open }); setOpen(null); }} data-testid="appointment-edit">Edit</button>
                </>
              ) : null}
              <button type="button" className="btn primary" disabled={!joinable(open, now)} title={joinable(open, now) ? 'Join the call' : 'Join opens ten minutes before'} onClick={() => void join(open)} data-testid="appointment-join">
                {open.liveMeetingId ? 'Join the call' : 'Join'}
              </button>
            </>
            )
          }
        >
          <dl className="sc-facts">
            <dt>When</dt>
            <dd>{new Date(open.startsAt).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · {timeRange(open.startsAt, open.endsAt)}</dd>
            <dt>Team</dt>
            <dd><span className={`sc-dot c${colourOf(open.team.id)}`} aria-hidden="true" /> {open.team.name}</dd>
            <dt>Call</dt>
            <dd>{open.kind === 'video' ? 'Video' : 'Audio'}{open.liveMeetingId ? ' · live now' : ''}{open.status === 'cancelled' ? ' · cancelled' : ''}</dd>
            {open.agenda ? (
              <>
                <dt>Agenda</dt>
                <dd>{open.agenda}</dd>
              </>
            ) : null}
            {open.series ? (
              <>
                <dt>Repeats</dt>
                <dd data-testid="appointment-repeats">{repeatLabel(open.series)}</dd>
                <dt>Agenda page</dt>
                <dd data-testid="appointment-agenda-page">
                  {open.agendaPath ? (
                    <button
                      type="button"
                      className="btn s"
                      onClick={() => {
                        setAgenda({ path: open.agendaPath!, teamSlug: open.team.slug, title: open.title });
                        setOpen(null);
                      }}
                      data-testid="appointment-agenda-open"
                    >
                      Open the agenda
                    </button>
                  ) : open.hasAgenda ? (
                    <button type="button" className="btn s" onClick={() => readAgenda(open)} data-testid="appointment-agenda-read">
                      Read the agenda
                    </button>
                  ) : open.status === 'cancelled' ? (
                    'This meeting is cancelled.'
                  ) : (
                    'The agenda opens after the meeting before it.'
                  )}
                </dd>
              </>
            ) : null}
            <dt>People</dt>
            <dd data-testid="appointment-people">{[open.createdBy?.name, ...open.invited.map((p) => p.name)].filter(Boolean).join(', ')}</dd>
          </dl>
          {stopAsk && open.series ? (
            <p className="sc-note" role="alert" data-testid="series-stop-ask">
              Stop {open.series.title}? The meetings still to come are cancelled. Agendas already written stay.
            </p>
          ) : null}
          {problem ? <p className="dlg-error" role="alert">{problem}</p> : null}
        </Dialog>
      ) : null}
      {agenda ? (
        <Dialog title={`${agenda.title} · ${agendaDay(agenda.path) ?? 'Agenda'}`} onClose={() => setAgenda(null)} testId="agenda-dialog" wide sheet={narrow}>
          <div className="sc-agenda">
            <LivePageEditor path={agenda.path} teamSlug={agenda.teamSlug} onExit={() => setAgenda(null)} />
          </div>
        </Dialog>
      ) : null}
      {reading ? (
        <Dialog title={`${reading.title} · ${reading.page ? (agendaDay(reading.page.path) ?? 'Agenda') : 'Agenda'}`} onClose={() => setReading(null)} testId="agenda-read-dialog" wide sheet={narrow}>
          {reading.error ? (
            <p className="dlg-error" role="alert">{reading.error}</p>
          ) : reading.page ? (
            <div className="sc-agenda-read">
              <p className="sc-note">Kept in the files of the team whose meeting this is. Its people edit it; you can read it.</p>
              <Markdown source={reading.page.markdown} />
              {reading.page.truncated ? <p className="sc-note">The page is longer; the rest is not shown here.</p> : null}
            </div>
          ) : (
            <p className="sc-note" role="status">Loading the agenda…</p>
          )}
        </Dialog>
      ) : null}
      {form ? (
        <AppointmentForm
          {...(form.appointment ? { appointment: form.appointment } : {})}
          {...(form.start ? { start: form.start } : {})}
          onClose={() => setForm(null)}
          onSaved={(a) => {
            setForm(null);
            setAnchor(new Date(a.startsAt));
            q.reload();
          }}
        />
      ) : null}
    </div>
  );
}

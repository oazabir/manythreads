import { useEffect, useState } from 'react';
import { APPOINTMENT_AGENDA_MAX, APPOINTMENT_TITLE_MAX, type Appointment, type MeetingPerson } from '@manythreads/shared';
import { Dialog } from '../../components/Dialog';
import { createAppointment, fetchMeetingPeople, updateAppointment } from '../../meetings/api';
import { useShell } from '../../shell/context';

/*
 * New appointment and Edit (P36-06): the team whose schedule it goes on (one of the person's teams; fixed once made), a title, the day and the time, audio or
 * video, an agenda line, and the people to invite from any team (searched by name). Saving tells the people newly invited.
 */

const pad = (n: number): string => String(n).padStart(2, '0');
const dateInput = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeInput = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const toIso = (date: string, time: string): string => new Date(`${date}T${time}`).toISOString();

/** The next half hour from now, for a new appointment. */
const nextSlot = (): Date => {
  const d = new Date();
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
};

export function AppointmentForm({ appointment, start, onClose, onSaved }: { appointment?: Appointment; start?: Date; onClose: () => void; onSaved: (a: Appointment) => void }) {
  const { teams, team } = useShell();
  const editing = appointment !== undefined;
  const s = appointment ? new Date(appointment.startsAt) : (start ?? nextSlot());
  const e = appointment ? new Date(appointment.endsAt) : new Date(s.getTime() + 30 * 60_000);
  const [teamSlug, setTeamSlug] = useState(appointment?.team.slug ?? team?.slug ?? teams[0]?.slug ?? '');
  const [title, setTitle] = useState(appointment?.title ?? '');
  const [day, setDay] = useState(dateInput(s));
  const [from, setFrom] = useState(timeInput(s));
  const [to, setTo] = useState(timeInput(e));
  const [kind, setKind] = useState<'audio' | 'video'>(appointment?.kind ?? 'video');
  const [agenda, setAgenda] = useState(appointment?.agenda ?? '');
  const [picked, setPicked] = useState<Map<string, string>>(new Map((appointment?.invited ?? []).map((p) => [p.personId as string, p.name])));
  const [find, setFind] = useState('');
  const [found, setFound] = useState<MeetingPerson[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      fetchMeetingPeople(find.trim()).then(
        (r) => live && setFound(r.people),
        () => live && setFound([]),
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [find]);

  const toggle = (id: string, name: string): void =>
    setPicked((m) => {
      const next = new Map(m);
      if (!next.delete(id)) next.set(id, name);
      return next;
    });

  const save = async (): Promise<void> => {
    if (title.trim() === '') return setError('Give it a title.');
    // an end earlier than the start is taken as the next day (a meeting across midnight)
    const startsAt = toIso(day, from);
    let endsAt = toIso(day, to);
    if (Date.parse(endsAt) <= Date.parse(startsAt)) endsAt = new Date(Date.parse(endsAt) + 86_400_000).toISOString();
    setBusy(true);
    setError(null);
    try {
      const body = { title: title.trim(), startsAt, endsAt, kind, agenda, inviteeIds: [...picked.keys()] as never };
      const res = editing ? await updateAppointment(appointment.id, body) : await createAppointment(teamSlug, body);
      onSaved(res.appointment);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'It could not be saved. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const people = [...new Map([...[...picked].map(([personId, name]) => [personId, { personId, name }] as const), ...found.map((p) => [p.personId as string, { personId: p.personId as string, name: p.name }] as const)]).values()];

  return (
    <Dialog
      title={editing ? 'Edit appointment' : 'New appointment'}
      onClose={onClose}
      testId="appointment-form"
      wide
      startAtTop
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()} data-testid="appointment-save">{busy ? 'Saving…' : editing ? 'Save' : 'Create'}</button>
        </>
      }
    >
      <div className="dlg-form sc-form">
        <label className="dlg-label" htmlFor="ap-title">Title</label>
        <input id="ap-title" className="dlg-input" value={title} maxLength={APPOINTMENT_TITLE_MAX} onChange={(ev) => setTitle(ev.target.value)} placeholder="Design review" data-autofocus data-testid="appointment-title" />
        <label className="dlg-label" htmlFor="ap-team">On the schedule of</label>
        <select id="ap-team" className="dlg-input" value={teamSlug} disabled={editing} onChange={(ev) => setTeamSlug(ev.target.value)} data-testid="appointment-team">
          {editing && appointment && !teams.some((t) => t.slug === appointment.team.slug) ? <option value={appointment.team.slug}>{appointment.team.name}</option> : null}
          {teams.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}
        </select>
        <div className="sc-when">
          <span className="sc-field">
            <label className="dlg-label" htmlFor="ap-day">Day</label>
            <input id="ap-day" type="date" className="dlg-input" value={day} onChange={(ev) => setDay(ev.target.value)} data-testid="appointment-day" />
          </span>
          <span className="sc-field">
            <label className="dlg-label" htmlFor="ap-from">From</label>
            <input id="ap-from" type="time" className="dlg-input" value={from} onChange={(ev) => setFrom(ev.target.value)} data-testid="appointment-from" />
          </span>
          <span className="sc-field">
            <label className="dlg-label" htmlFor="ap-to">To</label>
            <input id="ap-to" type="time" className="dlg-input" value={to} onChange={(ev) => setTo(ev.target.value)} data-testid="appointment-to" />
          </span>
        </div>
        <span className="dlg-label">Call</span>
        <div className="sc-kind" role="radiogroup" aria-label="Call">
          <label className={`sc-pill ${kind === 'video' ? 'on' : ''}`}><input type="radio" name="ap-kind" checked={kind === 'video'} onChange={() => setKind('video')} data-testid="appointment-video" /> Video</label>
          <label className={`sc-pill ${kind === 'audio' ? 'on' : ''}`}><input type="radio" name="ap-kind" checked={kind === 'audio'} onChange={() => setKind('audio')} data-testid="appointment-audio" /> Audio</label>
        </div>
        <label className="dlg-label" htmlFor="ap-agenda">Agenda</label>
        <textarea id="ap-agenda" className="dlg-input" rows={2} maxLength={APPOINTMENT_AGENDA_MAX} value={agenda} onChange={(ev) => setAgenda(ev.target.value)} placeholder="What it is for" data-testid="appointment-agenda" />
        <label className="dlg-label" htmlFor="ap-find">Invite people from any team{picked.size > 0 ? ` · ${picked.size} invited` : ''}</label>
        <input id="ap-find" type="search" className="dlg-input" value={find} onChange={(ev) => setFind(ev.target.value)} placeholder="Search by name" data-testid="appointment-find" />
        <ul className="nm-people" aria-label="People">
          {people.map((p) => (
            <li key={p.personId}>
              <label className="su-check">
                <input type="checkbox" checked={picked.has(p.personId)} onChange={() => toggle(p.personId, p.name)} data-testid="appointment-person" data-person={p.personId} /> {p.name}
              </label>
            </li>
          ))}
        </ul>
        {error ? <p className="dlg-error" role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}

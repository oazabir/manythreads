import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { ScheduledMeeting } from '@manythreads/shared';
import { SCHEDULED_AGENDA_MAX, SCHEDULED_ATTENDEES_MAX, SCHEDULED_TITLE_MAX } from '@manythreads/shared';
import { fetchChannelMembers } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { useSession } from '../../app/session';
import { Dialog } from '../../components/Dialog';
import { fetchMyCalendars } from '../../screens/connections/api';
import { actionFailure } from '../../screens/meetings/words';
import { createScheduledMeeting } from '../api';
import { LENGTHS, buildCreateRequest, dateInput, parseAddresses, proposedStart, timeInput } from './model';

const SERVICE_NAME = { google: 'Google Calendar', microsoft: 'Outlook' } as const;

/**
 * Plan a voice room ahead (PLAN Bundle D, P16-05, decision D4): a title, a day and time in the browser's own zone, a length, the people to invite (members of the channel, and
 * outside addresses that are used for the invitation and then forgotten), an agenda, and which of the person's calendars carries the event. The event is made at the organizer's
 * own calendar with the join link in it. Without a connected calendar the dialog says so and points to Settings, Connections.
 */
export function ScheduleRoomDialog({ channelId, channelLabel, onClose, onCreated }: { channelId: string; channelLabel?: string; onClose: () => void; onCreated: (plan: ScheduledMeeting) => void }) {
  const session = useSession();
  const members = useQuery(`channel-members:${channelId}`, () => fetchChannelMembers(channelId));
  const calendars = useQuery('my-calendars', fetchMyCalendars);
  const start = useMemo(() => proposedStart(new Date()), []);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(dateInput(start));
  const [time, setTime] = useState(timeInput(start));
  const [length, setLength] = useState<number>(30);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [find, setFind] = useState('');
  const [outside, setOutside] = useState('');
  const [agenda, setAgenda] = useState('');
  const [calendarKey, setCalendarKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choices = calendars.status === 'ok' ? calendars.data.calendars : [];
  const chosen = choices.find((c) => `${c.provider}|${c.calendarId}` === calendarKey) ?? choices.find((c) => c.primary) ?? choices[0] ?? null;
  const others = members.status === 'ok' ? members.data.members.filter((m) => m.personId !== session.person.id) : [];
  const shown = others.filter((m) => m.displayName.toLowerCase().includes(find.trim().toLowerCase()));
  const outsideCount = parseAddresses(outside).valid.length;
  const invited = picked.length + outsideCount;

  const toggle = (id: string): void => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const save = async (): Promise<void> => {
    const built = buildCreateRequest({ title, date, time, lengthMinutes: length, attendeePersonIds: picked, outsideText: outside, agenda, calendar: chosen ? { provider: chosen.provider, calendarId: chosen.calendarId } : null }, new Date());
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await createScheduledMeeting(channelId, built.body);
      onCreated(res.scheduledMeeting);
    } catch (e) {
      setError(actionFailure(e, 'The meeting could not be planned. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const noCalendar = calendars.status === 'ok' && choices.length === 0;
  const needsAccess = calendars.status === 'ok' ? calendars.data.needsCalendarAccess : [];

  return (
    <Dialog
      title="Schedule a room"
      onClose={onClose}
      testId="schedule-dialog"
      wide
      startAtTop
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || calendars.status !== 'ok' || noCalendar} onClick={() => void save()} data-testid="schedule-save">{busy ? 'Scheduling…' : 'Schedule'}</button>
        </>
      }
    >
      <p className="dlg-text">
        Plan a voice room{channelLabel ? <> in <b>{channelLabel}</b></> : null}. An event with the join link is added to your own calendar, and the people you invite get it too.
      </p>

      {noCalendar ? (
        <div className="sch-connect" data-testid="schedule-connect">
          <p className="dlg-text">
            {needsAccess.length > 0
              ? `Your ${needsAccess.map((p) => SERVICE_NAME[p]).join(' and ')} connection does not include the calendar yet. Add it, then come back.`
              : 'Connect your Google or Microsoft calendar to schedule a room.'}
          </p>
          <Link className="btn" to="/settings/connections" onClick={onClose} data-testid="schedule-connect-link">Open Settings, Connections</Link>
        </div>
      ) : null}
      {calendars.status === 'error' ? <p className="dlg-error" role="alert">Your calendars could not be loaded. Close this and try again.</p> : null}

      <div className="dlg-form sch-form">
        <label className="dlg-label" htmlFor="sch-title">Title</label>
        <input id="sch-title" className="dlg-input" value={title} maxLength={SCHEDULED_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder="Design review" data-autofocus data-testid="schedule-title" />

        <div className="sch-row">
          <div className="sch-field">
            <label className="dlg-label" htmlFor="sch-date">Day</label>
            <input id="sch-date" type="date" className="dlg-input" value={date} min={dateInput(new Date())} onChange={(e) => setDate(e.target.value)} data-testid="schedule-date" />
          </div>
          <div className="sch-field">
            <label className="dlg-label" htmlFor="sch-time">Starts</label>
            <input id="sch-time" type="time" className="dlg-input" value={time} onChange={(e) => setTime(e.target.value)} data-testid="schedule-time" />
          </div>
          <div className="sch-field">
            <label className="dlg-label" htmlFor="sch-length">Length</label>
            <select id="sch-length" className="dlg-input" value={length} onChange={(e) => setLength(Number(e.target.value))} data-testid="schedule-length">
              {LENGTHS.map((l) => (<option key={l} value={l}>{l} minutes</option>))}
            </select>
          </div>
        </div>
        <p className="dlg-hint">Times are in your own time zone.</p>

        {choices.length > 1 ? (
          <>
            <label className="dlg-label" htmlFor="sch-calendar">Calendar</label>
            <select id="sch-calendar" className="dlg-input" value={chosen ? `${chosen.provider}|${chosen.calendarId}` : ''} onChange={(e) => setCalendarKey(e.target.value)} data-testid="schedule-calendar">
              {choices.map((c) => (<option key={`${c.provider}|${c.calendarId}`} value={`${c.provider}|${c.calendarId}`}>{c.name} ({SERVICE_NAME[c.provider]})</option>))}
            </select>
          </>
        ) : chosen ? (
          <p className="dlg-hint" data-testid="schedule-calendar-one">Goes in your {chosen.name} calendar ({SERVICE_NAME[chosen.provider]}).</p>
        ) : null}

        <span className="dlg-label" id="sch-people-label">People in this channel</span>
        {members.status === 'error' ? <p className="dlg-hint">The members could not be loaded.</p> : null}
        {others.length > 6 ? <input className="dlg-input" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a person" aria-label="Find a person" data-testid="schedule-find" /> : null}
        <ul className="sch-people" aria-labelledby="sch-people-label" data-testid="schedule-people">
          {shown.map((m) => (
            <li key={m.personId}>
              <label className="sch-person">
                <input type="checkbox" checked={picked.includes(m.personId)} onChange={() => toggle(m.personId)} />
                <span>{m.displayName}</span>
              </label>
            </li>
          ))}
          {members.status === 'ok' && shown.length === 0 ? <li className="dlg-hint">{others.length === 0 ? 'Nobody else is in this channel yet.' : 'Nobody matches.'}</li> : null}
        </ul>

        <label className="dlg-label" htmlFor="sch-outside">People outside the workspace (email addresses)</label>
        <textarea id="sch-outside" className="dlg-input sch-outside" rows={2} value={outside} onChange={(e) => setOutside(e.target.value)} placeholder="name@example.com, other@example.com" data-testid="schedule-outside" />
        <p className="dlg-hint" data-testid="schedule-invited">
          {invited === 0 ? 'Nobody invited yet.' : `${invited} of ${SCHEDULED_ATTENDEES_MAX} invited.`} Outside addresses are used for the invitation and are not kept; only their number is.
        </p>

        <label className="dlg-label" htmlFor="sch-agenda">Agenda (optional)</label>
        <textarea id="sch-agenda" className="dlg-input sch-agenda" rows={4} value={agenda} maxLength={SCHEDULED_AGENDA_MAX} onChange={(e) => setAgenda(e.target.value)} data-testid="schedule-agenda" />

        {error ? <p className="dlg-error" role="alert" data-testid="schedule-error">{error}</p> : null}
      </div>
    </Dialog>
  );
}

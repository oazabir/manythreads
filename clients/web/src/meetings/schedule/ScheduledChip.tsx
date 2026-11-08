import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { channelStore } from '../../channels/store';
import { isMockMode } from '../../api/setup';
import { useQuery } from '../../app/useQuery';
import { ScheduleCalendarIcon } from '../../shell/icons';
import { useDismiss } from '../../shell/useDismiss';
import { actionFailure } from '../../screens/meetings/words';
import { cancelScheduledMeeting, fetchScheduledMeetings } from '../api';
import { liveRooms } from '../store';
import { ScheduleRoomDialog } from './ScheduleRoomDialog';
import { chipText, invitedWords, whenWords } from './model';

/**
 * The channel header's planned-room tools (PLAN Bundle D, P16-05, decision D10): the "Schedule a room" button, and, when a room is live or due within 12 hours, a chip with
 * its title and time ("Design review, today 15:00"). The chip opens a small card: when, who organizes, how many are invited, Join, and for the organizer Cancel (which also
 * cancels the event at their calendar). The chip asks the server again when a `scheduled_meeting.changed` push names this channel, so a plan made by someone else shows up at once.
 */
export function ScheduledChip({ channelId, channelLabel }: { channelId: string; channelLabel?: string }) {
  const navigate = useNavigate();
  const upcoming = useQuery(`scheduled-upcoming:${channelId}`, () => fetchScheduledMeetings(channelId, { upcoming: '1', limit: 1 }));
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);

  const reloadRef = useRef(upcoming.reload);
  useEffect(() => {
    reloadRef.current = upcoming.reload;
  });
  // a push for this channel, and a minute's tick so "in 5 minutes" and a plan whose time has gone stay right
  useEffect(() => {
    if (isMockMode()) return;
    const off = liveRooms().onScheduledChanged((p) => {
      if (p.channelId === channelId) reloadRef.current();
    });
    const tick = setInterval(() => setNow(new Date()), 60_000);
    return () => {
      off();
      clearInterval(tick);
    };
  }, [channelId]);

  if (isMockMode()) return null;
  const plan = upcoming.status === 'ok' ? (upcoming.data.scheduledMeetings[0] ?? null) : null;
  const mine = plan !== null && plan.organizerId === channelStore.selfActor;

  const cancel = async (): Promise<void> => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      await cancelScheduledMeeting(plan.id);
      setOpen(false);
      upcoming.reload();
    } catch (e) {
      setError(actionFailure(e, 'The meeting could not be cancelled. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {plan ? (
        <div className="sch-chip-wrap" ref={box}>
          <button type="button" className={`sch-chip${plan.status === 'started' ? ' live' : ''}`} aria-haspopup="dialog" aria-expanded={open} data-testid="scheduled-chip" onClick={() => setOpen((o) => !o)}>
            <ScheduleCalendarIcon />
            <span className="sch-chip-text">{chipText(plan, now)}</span>
          </button>
          {open ? (
            <div className="sch-pop" role="dialog" aria-label={`${plan.title}, planned room`} data-testid="scheduled-pop">
              <p className="sch-pop-title">{plan.title}</p>
              <p className="sch-pop-line">{plan.status === 'started' ? 'The room is open now.' : `Starts ${whenWords(plan.startsAt, now)}`}</p>
              <p className="sch-pop-line">{plan.organizerName ? `Organized by ${plan.organizerName}` : 'Organized by a former member'}</p>
              <p className="sch-pop-line" data-testid="scheduled-invited">{invitedWords(plan)}</p>
              {error ? <p className="dlg-error" role="alert">{error}</p> : null}
              <div className="sch-pop-actions">
                <button type="button" className="btn primary s" data-testid="scheduled-join" onClick={() => void navigate(plan.joinPath)}>{plan.status === 'started' ? 'Join' : 'Start now'}</button>
                {mine && plan.status === 'scheduled' ? <button type="button" className="btn s" disabled={busy} data-testid="scheduled-cancel" onClick={() => void cancel()}>{busy ? 'Cancelling…' : 'Cancel meeting'}</button> : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <button type="button" className="btn sch-add" data-testid="schedule-open" title="Plan a voice room for later" aria-label="Schedule a room" onClick={() => setDialog(true)}>
        <ScheduleCalendarIcon />
        <span className="sch-add-label">Schedule a room</span>
      </button>
      {dialog ? (
        <ScheduleRoomDialog
          channelId={channelId}
          {...(channelLabel ? { channelLabel } : {})}
          onClose={() => setDialog(false)}
          onCreated={() => {
            setDialog(false);
            upcoming.reload();
          }}
        />
      ) : null}
    </>
  );
}

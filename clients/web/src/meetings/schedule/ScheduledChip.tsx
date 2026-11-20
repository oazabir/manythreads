import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { channelStore } from '../../channels/store';
import { isMockMode } from '../../api/setup';
import { useQuery } from '../../app/useQuery';
import { useHeaderItem } from '../../shell/headerMenu';
import { ScheduleCalendarIcon } from '../../shell/icons';
import { useDismiss } from '../../shell/useDismiss';
import { actionFailure } from '../../screens/meetings/words';
import { cancelScheduledMeeting, fetchScheduledMeetings } from '../api';
import { liveRooms } from '../store';
import { onScheduledChangedHere } from './changed';
import { chipPlan, chipText, invitedWords, whenWords } from './model';

/**
 * The channel header's planned-room chip (PLAN Bundle D, P16-05, decision D10): when a room is due within 12 hours, a chip with
 * its title and time ("Design review, today 15:00"). The chip opens a small card: when, who organizes, how many are invited, Join, and for the organizer Cancel (which also
 * cancels the event at their calendar). The chip asks the server again when a `scheduled_meeting.changed` push names this channel, so a plan made by someone else shows up at once.
 * Once the room has started the chip goes: the card under the room's start message has Join (P33-03). The Schedule a room button is `ScheduleButton`.
 */
export function ScheduledChip({ channelId }: { channelId: string }) {
  const navigate = useNavigate();
  const upcoming = useQuery(`scheduled-upcoming:${channelId}`, () => fetchScheduledMeetings(channelId, { upcoming: '1', limit: 10 }));
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
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
    // a room planned in this tab (the Schedule a room button) shows at once
    const here = onScheduledChangedHere(channelId, () => reloadRef.current());
    return () => {
      off();
      here();
      clearInterval(tick);
    };
  }, [channelId]);

  // a room that has started is the card's business (Join under its start message), not the chip's
  // (the first plan may be one that has started: the chip shows the next one that has not)
  const plan = !isMockMode() && upcoming.status === 'ok' ? chipPlan(upcoming.data.scheduledMeetings) : null;
  // on a phone the chip is not in the header: the details menu names the plan, and its item opens the same card under the header (P34-05). The card takes the
  // keyboard, and once it closes the keyboard goes back to where it was (the channel's name), since the chip itself is hidden again
  useHeaderItem(channelId, plan ? { key: 'planned', label: `Planned: ${chipText(plan, now)}`, testId: 'details-planned', popup: true } : null, () => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  });
  useEffect(() => {
    if (open) {
      if (returnTo.current) box.current?.querySelector<HTMLElement>('.sch-pop button')?.focus();
      return;
    }
    const back = returnTo.current;
    returnTo.current = null;
    if (back?.isConnected && (document.activeElement === document.body || document.activeElement === null)) back.focus();
  }, [open]);

  if (isMockMode()) return null;
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
        <div className="sch-chip-wrap chv-tool chv-chip" ref={box}>
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
    </>
  );
}

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { GetScheduledMeetingResponse } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { useQuery } from '../../app/useQuery';
import { PageHeader } from '../../components/PageHeader';
import { fetchScheduledMeeting, joinScheduledMeeting } from '../../meetings/api';
import { invitedWords, whenWords } from '../../meetings/schedule/model';
import { callController } from '../../meetings/store';
import { useShell } from '../../shell/context';
import { GUEST_SLUG } from '../../shell/messageLink';
import { channelPath } from '../../shell/nav';
import { actionFailure } from './words';

/** The sentence for a link that leads nowhere the person may go (decision D10). Never the title or the agenda: the gate only says what the plan is, not what it is about. */
export function gateSentence(gate: GetScheduledMeetingResponse['gate']): string | null {
  if (gate.status === 'cancelled') return 'This meeting was cancelled.';
  if (!gate.readable) {
    const where = gate.channelName ? `#${gate.channelName.replace(/^#/, '')}` : 'this channel';
    return `You are not in ${where}. Ask ${gate.organizerName ?? 'the organizer'} to add you.`;
  }
  return null;
}

/**
 * The page a planned room's link opens, `/join/:scheduledId` (PLAN Bundle D, P16-05, decision D10). A person who can read the channel sees the plan and presses Start (or Join when the
 * room is already open): the server opens the room of the plan or joins the live one, and the person is in the call in the channel. Anyone else gets one plain sentence.
 */
export function JoinScheduled() {
  const { scheduledId = '' } = useParams();
  const navigate = useNavigate();
  const { teams } = useShell();
  const found = useQuery(`scheduled:${scheduledId}`, () => fetchScheduledMeeting(scheduledId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (found.status === 'loading') return <div className="view-empty" role="status" aria-busy="true" />;
  if (found.status === 'error') {
    const gone = isApiError(found.error) && (found.error.status === 404 || found.error.status === 403);
    return (
      <div className="view-empty sch-join-note" role="alert" data-testid="join-scheduled-missing">
        <p className="view-empty-title">{gone ? 'This meeting link does not lead anywhere.' : 'The meeting could not be loaded.'}</p>
        <p className="view-empty-body">{gone ? 'It may be wrong, or the meeting may have been removed.' : 'Check your connection and open the link again.'}</p>
      </div>
    );
  }

  const { gate, scheduledMeeting: plan } = found.data;
  const sentence = gateSentence(gate);
  if (sentence !== null || plan === null) {
    return (
      <div className="view-empty sch-join-note" role="status" data-testid="join-scheduled-gate">
        <p className="view-empty-title">{sentence ?? 'This meeting is not available.'}</p>
      </div>
    );
  }

  const live = plan.status === 'started';
  const go = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await joinScheduledMeeting(plan.id);
      // the room exists now; the call controller joins it the way a badge in the sidebar does, and the call bar stays with the person wherever they go
      void callController().joinRoom(res.meeting.id, plan.channelId);
      const slug = teams.find((t) => t.id === plan.teamId)?.slug ?? GUEST_SLUG;
      void navigate(gate.channelName ? channelPath(slug, gate.channelName) : '/');
    } catch (e) {
      setError(actionFailure(e, 'The room could not be opened. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sch-join" data-testid="join-scheduled" data-scheduled-id={plan.id}>
      <PageHeader title={plan.title} description={gate.channelName ? `#${gate.channelName.replace(/^#/, '')}` : undefined} />
      <p className="sch-join-line" data-testid="join-scheduled-when">{live ? 'The room is open now.' : `Starts ${whenWords(plan.startsAt, new Date())}`}</p>
      <p className="sch-join-line">{plan.organizerName ? `Organized by ${plan.organizerName}` : 'Organized by a former member'} · {invitedWords(plan)}</p>
      {plan.agendaMd ? <pre className="sch-join-agenda" data-testid="join-scheduled-agenda">{plan.agendaMd}</pre> : null}
      {error ? <p className="dlg-error" role="alert" data-testid="join-scheduled-error">{error}</p> : null}
      <button type="button" className="btn primary" disabled={busy} onClick={() => void go()} data-testid="join-scheduled-go">{busy ? 'Opening…' : live ? 'Join the room' : 'Start the room'}</button>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useSession } from '../../app/session';
import { joinAppointment } from '../../meetings/api';
import { callController } from '../../meetings/store';
import { useShell } from '../../shell/context';
import { ScheduleNavIcon } from '../../shell/icons';
import { meetingPath } from '../../shell/messageLink';
import { DigestCard, DigestRowView, RowList } from './DigestCard';
import { upNext, type UpNextRow } from './summaries';
import type { SummariesData } from './useSummaries';

/**
 * "Up next" (P37-06): the calls going now and the meetings of the next seven days, soonest first. A meeting offers Join from ten minutes before it starts (the same rule as
 * the Schedule); a call that is already going offers Join at once. A row opens the meeting on the Schedule.
 */
export function UpNextCard({ slug, now, data }: { slug: string; now: Date; data: SummariesData }) {
  const session = useSession();
  const { team, teams } = useShell();
  const navigate = useNavigate();
  const q = data.appointments;
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const model = useMemo(
    () =>
      q.status === 'ok'
        ? upNext({
            slug,
            now,
            appointments: q.data.appointments,
            rooms: data.live.status === 'ok' ? data.live.rooms : [],
            selfPersonId: session.person.id,
            manyTeams: teams.length > 1,
            teamId: team?.id ?? null,
            roomPath: data.keepGoing.roomPath,
          })
        : null,
    [q, slug, now, data.live.status, data.live.rooms, session.person.id, teams.length, team?.id, data.keepGoing.roomPath],
  );

  const join = async (row: UpNextRow): Promise<void> => {
    setProblem(null);
    setBusy(row.key);
    try {
      if (row.room) {
        await callController().joinRoom(row.room.meetingId, row.room.channelId);
      } else if (row.appointmentId) {
        const res = await joinAppointment(row.appointmentId);
        void navigate(meetingPath(team?.slug ?? slug, res.channelId));
        await callController().enterOpened(res);
      }
    } catch (e) {
      setProblem(e instanceof Error && e.message ? e.message : 'The meeting could not be joined. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <DigestCard
      id="next"
      title="Up next"
      count={model?.total ?? null}
      note={model && model.total > 0 ? 'Calls going now and meetings this week' : ''}
      state={q.status === 'loading' ? 'loading' : q.status === 'error' ? 'error' : 'ready'}
      onRetry={q.reload}
      empty={{ icon: ScheduleNavIcon, title: 'No meetings coming up', body: 'Meetings you are invited to in the next week show up here, with a Join button when it is time.' }}
      more={model?.more ?? 0}
      seeAll={[{ label: 'Open schedule', to: `/t/${encodeURIComponent(slug)}/schedule` }]}
      problem={problem ? { text: problem } : null}
    >
      {model && model.shown.length > 0 ? (
        <RowList label="Up next">
          {model.shown.map((r) => (
            <DigestRowView
              key={r.key}
              row={r}
              action={
                r.joinable ? (
                  <button type="button" className="btn s primary sm-join" disabled={busy !== null} onClick={() => void join(r)} data-testid="summaries-join" aria-label={`Join ${r.title}`}>
                    {busy === r.key ? 'Joining…' : 'Join'}
                  </button>
                ) : null
              }
            />
          ))}
        </RowList>
      ) : null}
    </DigestCard>
  );
}

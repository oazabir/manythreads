import { useEffect, useMemo, useState } from 'react';
import { useSession } from '../../app/session';
import { PageHeader } from '../../components/PageHeader';
import { ForbiddenBody } from '../../components/states';
import { useShell } from '../../shell/context';
import { RegenerateIcon } from '../../shell/icons';
import { ActivityCard } from './ActivityCard';
import { AttentionCard } from './AttentionCard';
import { KeepGoingCard } from './KeepGoingCard';
import { UpNextCard } from './UpNextCard';
import { WaitingCard } from './WaitingCard';
import { attention, dateLine, dayGreeting, leadLine, meetingsLeftToday, waitingRoots } from './summaries';
import { useSummaries } from './useSummaries';
import { todayIso } from '../files/actionItems/actionItemsWords';

/*
 * Summaries (P37-06, docs/plans/summaries.md): the person's daily digest. A greeting and one sentence of what stands out, then cards: what needs them today, the threads
 * waiting on their reply, what is new, the meetings and calls coming up, and quick ways back into the places they are in the middle of. A single column on a phone, two
 * columns on a wide screen. It only reads what Action items, Approvals, Threads, the bell, the Schedule and the sidebar already read; each card reads its own source.
 */

/** The clock, moved on every half minute, so "Live now" and "In 25 min" stay right while the page is open. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

export function SummariesScreen() {
  const { guest } = useShell();
  if (guest) return <div className="inline-state"><ForbiddenBody /></div>;
  return <SummariesBody />;
}

function SummariesBody() {
  const { team } = useShell();
  const session = useSession();
  const slug = team?.slug ?? '';
  const now = useNow();
  const data = useSummaries(slug, now);
  const [spinning, setSpinning] = useState(false);

  const refresh = (): void => {
    setSpinning(true);
    data.reloadAll();
    window.setTimeout(() => setSpinning(false), 700);
  };

  // the one sentence under the greeting: what is known so far, counted the way each card counts
  const lead = useMemo(() => {
    const ai = data.actionItems;
    const ap = data.approvals;
    const th = data.threads;
    const ap2 = data.appointments;
    const bell = data.notifications;
    const attentionKnown = ai.status === 'ok' && ap.status === 'ok' && bell.status === 'ok';
    const total = attentionKnown
      ? attention({
          slug,
          now,
          today: todayIso(now),
          actionItems: ai.data.items,
          approvals: ap.data.items,
          meetingNotes: bell.items.filter((n) => n.kind === 'meeting_actions' && n.readAt === null),
        }).rows.total
      : null;
    return leadLine({
      attention: total,
      waiting: th.status === 'ok' ? [...waitingRoots(th.data.items)].length : null,
      meetings: ap2.status === 'ok' ? meetingsLeftToday(ap2.data.appointments, now) : null,
    });
  }, [data.actionItems, data.approvals, data.threads, data.appointments, data.notifications, slug, now]);

  const firstName = session.person.name.trim().split(/\s+/)[0] ?? '';
  return (
    <div className="sm-screen" data-testid="summaries">
      <PageHeader
        title="Summaries"
        description={dateLine(now)}
        actions={
          <button type="button" className="btn s" onClick={refresh} data-testid="summaries-refresh" aria-label="Refresh the summaries">
            <span className={`sm-refresh-icon ${spinning ? 'spin' : ''}`}><RegenerateIcon /></span> Refresh
          </button>
        }
      />
      <div className="sm-body">
        <div className="sm-hello" data-testid="summaries-hello">
          <p className="sm-greeting" data-vt-mask>{firstName ? `${dayGreeting(now)}, ${firstName}` : dayGreeting(now)}</p>
          {lead ? <p className="sm-lead" data-testid="summaries-lead">{lead}</p> : null}
        </div>
        <div className="sm-grid">
          <AttentionCard slug={slug} now={now} data={data} />
          <WaitingCard slug={slug} now={now} data={data} />
          <ActivityCard slug={slug} now={now} data={data} />
          <UpNextCard slug={slug} now={now} data={data} />
          <KeepGoingCard slug={slug} now={now} data={data} />
        </div>
      </div>
    </div>
  );
}

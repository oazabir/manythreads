import { useState } from 'react';
import { Link, useParams } from 'react-router';
import type { MeetingSpace } from '@manythreads/shared';
import { fetchChannel } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { ago } from '../../channels/format';
import { EmptyState } from '../../components/EmptyState';
import { PageHeader } from '../../components/PageHeader';
import { SkeletonRows } from '../../components/Skeleton';
import { PaneResizer } from '../../kernel/panes/PaneResizer';
import { PANES } from '../../kernel/panes/paneWidth';
import { LiveBadge } from '../../meetings/LiveBadge';
import { NewMeetingDialog } from '../../meetings/NewMeetingDialog';
import { useMeetingSpaces } from '../../meetings/spaces';
import { useShell } from '../../shell/context';
import { AddIcon, BackIcon, MeetingsNavIcon } from '../../shell/icons';
import { meetingsPath, meetingPath } from '../../shell/messageLink';
import { useNarrow } from '../../shell/useNarrow';
import { ChannelBody, NoChannelAccess } from '../ChannelView';

/** "1 person", "3 people": who is in the space. */
export const peopleLine = (n: number): string => (n === 1 ? '1 person' : `${String(n)} people`);

/** The spaces newest first, as the Threads inbox lists its threads. */
export const newestFirst = (spaces: readonly MeetingSpace[]): MeetingSpace[] => [...spaces].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** One meeting space as a conversation of its own: a team-less chat of the people invited, drawn with the meeting's title (P36-03). */
export function MeetingSpaceThread({ id, slug }: { id: string; slug: string }) {
  const info = useQuery(`channel:${id}`, () => fetchChannel(id));
  if (info.status === 'loading') return <div className="view-empty" aria-busy="true" />;
  if (info.status === 'error' || info.data.channel.kind !== 'meeting') return <NoChannelAccess />;
  return <ChannelBody key={id} channelId={id} name="" teamSlug={slug} dm={{ label: info.data.channel.purpose || 'Meeting', personId: undefined }} />;
}

/**
 * Meetings (P37-04, owner 2026-11-25): one entry in the sidebar that opens this page, laid out like the Threads inbox. On the left the meeting spaces the person is
 * in, newest first, each with its live dot and the people in it, and "New meeting" at the top; on the right the chat of the selected one, as it was drawn when each
 * space had its own sidebar row. `/t/<team>/meetings` is the list, `/t/<team>/meetings/space/<channel>` the list with that space open. On a phone the list is the
 * page and a space opens on the whole screen with a way back.
 */
export function MeetingsInbox() {
  const { id = null } = useParams();
  const { team, teamSlug } = useShell();
  const slug = team?.slug ?? teamSlug ?? '';
  const narrow = useNarrow();
  const spaces = useMeetingSpaces();
  const [dialog, setDialog] = useState(false);
  const rows = spaces.status === 'ok' ? newestFirst(spaces.data.spaces) : [];
  const showList = !narrow || id === null;
  const showMain = !narrow || id !== null;
  return (
    <div className="threads-home">
      {/* with nothing open the page's title is "Meetings"; with a space open the chat draws its own title and tools in the header */}
      {id === null ? <PageHeader compact title="Meetings" /> : null}
      <div className={`inbox ${narrow ? 'narrow' : ''}`} data-testid="meetings-inbox">
        {showList ? (
          <div className="inl" data-landmark="meeting-list">
            {narrow ? null : <PaneResizer spec={PANES.list} edge="end" />}
            <header className="inh">
              {narrow || id === null ? null : <h2 className="inh-title">Meetings</h2>}
              <button type="button" className="btn s primary mi-new" aria-haspopup="dialog" onClick={() => setDialog(true)} data-testid="new-meeting">
                <AddIcon size={14} />
                <span>New meeting</span>
              </button>
            </header>
            {spaces.status === 'loading' ? (
              <SkeletonRows rows={4} label="Loading meetings" />
            ) : spaces.status === 'error' ? (
              <div className="inl-empty" role="alert">
                <p className="view-empty-title">Could not load meetings.</p>
                <button type="button" className="btn s" onClick={spaces.reload}>Try again</button>
              </div>
            ) : rows.length === 0 ? (
              <div className="inl-empty">
                <EmptyState icon={MeetingsNavIcon} testId="meetings-empty" title="No meetings yet">
                  <p>A meeting is a private chat with a call in it, for the people you invite from any team.</p>
                  <p>Press New meeting to start one.</p>
                </EmptyState>
              </div>
            ) : (
              <ul className="inlist mi-list" aria-label="Meetings">
                {rows.map((s) => {
                  const on = s.channelId === id;
                  return (
                    <li key={s.channelId} data-testid="meeting-space-row">
                      <Link to={meetingPath(slug, s.channelId)} className={`trow ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined}>
                        <span className="trow-main">
                          <span className="ttl">{s.title}</span>
                          <span className="last">{peopleLine(s.memberCount)}</span>
                        </span>
                        <span className="meta">
                          <span title={`Started ${new Date(s.createdAt).toLocaleString()}`}>{ago(s.createdAt)}</span>
                          <LiveBadge channelId={s.channelId} />
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
        {showMain ? (
          <div className="inr" data-landmark="meeting-view">
            {narrow ? (
              <Link className="btn s back-to-list" to={meetingsPath(slug)} data-testid="meetings-back">
                <BackIcon />
                <span>Meetings</span>
              </Link>
            ) : null}
            {id ? (
              <MeetingSpaceThread key={id} id={id} slug={slug} />
            ) : (
              <div className="inr-empty" data-testid="meetings-pick">
                <p className="view-empty-title">Pick a meeting</p>
                <p className="view-empty-body">Its chat, notes and call show here.</p>
              </div>
            )}
          </div>
        ) : null}
      </div>
      {/* the dialog opens the new space itself when it starts one */}
      {dialog ? <NewMeetingDialog onClose={() => setDialog(false)} /> : null}
    </div>
  );
}

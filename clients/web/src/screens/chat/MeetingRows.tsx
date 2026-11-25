import { useState } from 'react';
import { Link } from 'react-router';
import type { MeetingSpace } from '@manythreads/shared';
import { fetchChannel } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { ago } from '../../channels/format';
import { LiveBadge } from '../../meetings/LiveBadge';
import { NewMeetingDialog } from '../../meetings/NewMeetingDialog';
import { useMeetingSpaces } from '../../meetings/spaces';
import { AddIcon } from '../../shell/icons';
import { meetingPath } from '../../shell/messageLink';
import { ChannelBody, NoChannelAccess } from '../ChannelView';

/** "1 person", "3 people": who is in the space. */
export const peopleLine = (n: number): string => (n === 1 ? '1 person' : `${String(n)} people`);

/** The spaces newest first, as the Threads inbox lists its threads. */
export const newestFirst = (spaces: readonly MeetingSpace[]): MeetingSpace[] => [...spaces].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** The spaces whose title has the typed words in it (the Chat search box filters the meetings too); no words keep them all. */
export const matching = (spaces: readonly MeetingSpace[], query: string): MeetingSpace[] => {
  const q = query.trim().toLowerCase();
  return q === '' ? [...spaces] : spaces.filter((s) => s.title.toLowerCase().includes(q));
};

/** One meeting space as a conversation of its own: a team-less chat of the people invited, drawn with the meeting's title (P36-03). */
export function MeetingSpaceThread({ id, slug }: { id: string; slug: string }) {
  const info = useQuery(`channel:${id}`, () => fetchChannel(id));
  if (info.status === 'loading') return <div className="view-empty" aria-busy="true" />;
  if (info.status === 'error' || info.data.channel.kind !== 'meeting') return <NoChannelAccess />;
  return <ChannelBody key={id} channelId={id} name="" teamSlug={slug} dm={{ label: info.data.channel.purpose || 'Meeting', personId: undefined }} />;
}

/**
 * The meeting chats under the person's chats with bots, in the Chat page's list (P37-07, owner 2026-11-25): a quiet "Meetings" heading with a small New meeting
 * button, then one row per meeting space, newest first, each with its title, the people in it, its age and the live dot while a call is going. A row opens the
 * meeting chat in the pane beside the list (`/t/<team>/chat?meeting=<channel>`). The Chat search box filters these rows by title too.
 */
export function MeetingRows({ slug, selected, query, onOpen }: { slug: string; selected: string | null; query: string; onOpen?: () => void }) {
  const spaces = useMeetingSpaces();
  const [dialog, setDialog] = useState(false);
  const all = spaces.status === 'ok' ? newestFirst(spaces.data.spaces) : [];
  const rows = matching(all, query);
  const searching = query.trim() !== '';
  return (
    <section className="ch-group ch-meet" aria-label="Meetings" data-testid="chat-meetings">
      <div className="ch-meet-head">
        <h3 className="ch-group-title">Meetings</h3>
        <button type="button" className="btn s ch-meet-new" aria-haspopup="dialog" onClick={() => setDialog(true)} data-testid="new-meeting">
          <AddIcon size={12} />
          <span>New meeting</span>
        </button>
      </div>
      {spaces.status === 'error' ? (
        <div className="ch-note" role="alert">
          <p>Could not load meetings.</p>
          <button type="button" className="btn s" onClick={spaces.reload}>Try again</button>
        </div>
      ) : spaces.status === 'ok' && rows.length === 0 ? (
        <p className="ch-meet-none" data-testid="meetings-empty">{searching && all.length > 0 ? 'No meeting matches that.' : 'No meetings yet. A meeting is a private chat with a call in it.'}</p>
      ) : (
        <ul className="ch-rows" aria-label="Meetings">
          {rows.map((s) => {
            const on = s.channelId === selected;
            return (
              <li key={s.channelId} className={`ch-meet-row ${on ? 'on' : ''}`} data-testid="meeting-space-row">
                <Link to={meetingPath(slug, s.channelId)} className="ch-meet-main" aria-current={on ? 'page' : undefined} {...(onOpen ? { onClick: onOpen } : {})}>
                  <span className="ch-meet-text">
                    <span className="ch-row-title" title={s.title}>{s.title}</span>
                    <span className="ch-row-meta">{peopleLine(s.memberCount)}</span>
                  </span>
                  <span className="ch-meet-side">
                    <span className="ch-row-meta" title={`Started ${new Date(s.createdAt).toLocaleString()}`}>{ago(s.createdAt)}</span>
                    <LiveBadge channelId={s.channelId} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {/* the dialog opens the new space itself when it starts one */}
      {dialog ? <NewMeetingDialog onClose={() => setDialog(false)} /> : null}
    </section>
  );
}

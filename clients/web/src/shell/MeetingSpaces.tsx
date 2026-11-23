import { useState } from 'react';
import { NavLink } from 'react-router';
import { useSession } from '../app/session';
import { LiveBadge } from '../meetings/LiveBadge';
import { NewMeetingDialog } from '../meetings/NewMeetingDialog';
import { useMeetingSpaces } from '../meetings/spaces';
import { FoldButton } from './FoldButton';
import { AddIcon } from './icons';
import { meetingPath } from './messageLink';
import { useFold } from './sectionFold';

/** The sidebar's Meetings group (P36-03): the meeting spaces the person is in, newest first, each with its live dot; "New meeting" opens one with people from any team. */
export function MeetingSpaces({ slug }: { slug: string }) {
  const session = useSession();
  const spaces = useMeetingSpaces();
  const [folded, toggleFolded] = useFold(session.person.id, slug, 'meetings');
  const [dialog, setDialog] = useState(false);
  const rows = spaces.status === 'ok' ? spaces.data.spaces.slice(0, 8) : [];
  return (
    <>
      <div className="sec-row">
        <FoldButton folded={folded} label="Meetings" onToggle={toggleFolded} />
        <div className="sec"><span>Meetings</span></div>
      </div>
      {!folded
        ? rows.map((s) => (
            <div className="sb-row" key={s.channelId} data-testid="meeting-space-row">
              <NavLink to={meetingPath(slug, s.channelId)} className={({ isActive }) => `it ${isActive ? 'on' : ''}`}>
                <span className="h" aria-hidden="true">◷</span>
                <span className="it-label">{s.title}</span>
                <LiveBadge channelId={s.channelId} />
              </NavLink>
            </div>
          ))
        : null}
      <div className="dm-new">
        <button type="button" className="it dm-new-btn" aria-haspopup="dialog" onClick={() => setDialog(true)} data-testid="new-meeting">
          <span className="h" aria-hidden="true"><AddIcon size={14} /></span>
          <span className="it-label">New meeting</span>
        </button>
      </div>
      {dialog ? <NewMeetingDialog onClose={() => setDialog(false)} /> : null}
    </>
  );
}

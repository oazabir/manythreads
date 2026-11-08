import { useNavigate } from 'react-router';
import { fetchMeetingByPath } from '../../meetings/api';
import { useQuery } from '../../app/useQuery';
import { meetingFolderPath } from './words';

/**
 * The Files hook (PLAN P15-20): in a meeting's folder, or on one of its files, "Open the meeting" goes to the meeting page. The server says which meeting the path belongs to
 * (`GET /api/meetings/by-path`); a path it does not know draws nothing, so a folder that only looks like a meeting's never shows a button that goes nowhere.
 */
export function OpenMeeting({ path, personal, teamSlug }: { path: string; personal: boolean; teamSlug?: string | undefined }) {
  const asked = meetingFolderPath(path, personal);
  if (asked === null) return null;
  // a new path starts a new lookup: the query keeps its last answer while a new key loads, so the button is rebuilt rather than reused
  return <OpenMeetingButton key={`${personal ? '~me' : (teamSlug ?? '')}:${asked}`} path={asked} personal={personal} teamSlug={teamSlug} />;
}

function OpenMeetingButton({ path, personal, teamSlug }: { path: string; personal: boolean; teamSlug: string | undefined }) {
  const navigate = useNavigate();
  const found = useQuery(`meeting-by-path:${personal ? '~me' : (teamSlug ?? '')}:${path}`, () => fetchMeetingByPath({ path, ...(!personal && teamSlug ? { team: teamSlug } : {}) }));
  if (found.status !== 'ok') return null;
  return (
    <button type="button" className="btn s mv-open" data-testid="open-meeting" onClick={() => void navigate(`/meetings/${encodeURIComponent(found.data.meetingId)}`)}>
      Open the meeting
    </button>
  );
}

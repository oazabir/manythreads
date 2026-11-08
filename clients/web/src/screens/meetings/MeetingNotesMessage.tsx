import { useState } from 'react';
import { Link } from 'react-router';
import type { MeetingOverview } from '@manythreads/shared';
import { Markdown } from '../../channels/MessageMarkdown';
import { useQuery } from '../../app/useQuery';
import { fetchMeetingNotes, fetchMeetingOverview } from '../../meetings/api';
import { SaveToTeamDialog } from './SaveToTeamDialog';
import { ShareDialog } from './ShareDialog';

/**
 * The card the note-taker leaves in the organizer's direct message when a meeting is over (`meta.meetingNotes`, PLAN P15-23): its words, then Open the notes, Share and Save to
 * team meeting notes. Share and Save show only when the server says this person may (the notes' `can…` flags); each loads the meeting's header when it is pressed.
 */
export function MeetingNotesMessage({ meetingId, body, teamSlug }: { meetingId: string; body: string; teamSlug: string | null }) {
  const notes = useQuery(`meeting-card-notes:${meetingId}`, () => fetchMeetingNotes(meetingId));
  const [dialog, setDialog] = useState<'share' | 'save' | null>(null);
  const overview = useQuery(`meeting-card-overview:${dialog === null ? 'none' : meetingId}`, () => (dialog === null ? Promise.resolve(null) : fetchMeetingOverview(meetingId)));
  const may = notes.status === 'ok' ? notes.data : null;
  const loaded: MeetingOverview | null = dialog !== null && overview.status === 'ok' ? overview.data : null;
  return (
    <div className="mv-msg-card" data-testid="meeting-notes-card" data-meeting-id={meetingId}>
      <div className="txt"><Markdown source={body} teamSlug={teamSlug} /></div>
      <div className="mv-actions">
        <Link className="btn s primary" to={`/meetings/${encodeURIComponent(meetingId)}`} data-testid="meeting-card-open">Open the notes</Link>
        {may?.canShare ? <button type="button" className="btn s" onClick={() => setDialog('share')} data-testid="meeting-card-share">Share</button> : null}
        {may?.canSaveToTeam && !may.savedPath ? <button type="button" className="btn s" onClick={() => setDialog('save')} data-testid="meeting-card-save">Save to team meeting notes</button> : null}
        {dialog !== null && overview.status === 'error' ? <span className="mv-bad" role="alert">This meeting could not be opened. Try again.</span> : null}
      </div>
      {loaded && dialog === 'share' ? <ShareDialog overview={loaded} onClose={() => setDialog(null)} /> : null}
      {loaded && dialog === 'save' ? <SaveToTeamDialog overview={loaded} onClose={() => setDialog(null)} onSaved={() => notes.reload()} /> : null}
    </div>
  );
}

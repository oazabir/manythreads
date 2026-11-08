import { useState } from 'react';
import type { MeetingOverview, SaveMeetingToTeamResponse } from '@manythreads/shared';
import { useSession } from '../../app/session';
import { Dialog } from '../../components/Dialog';
import { saveMeetingToTeam } from '../../meetings/api';
import { MEMORY_WARNING, SAVED_ALREADY, SAVE_EXPLAINED, actionFailure, isConflict } from './words';

/**
 * Save to team meeting notes (PLAN P15-23): the organizer of a note-taker meeting copies the notes and the transcript to the team's meeting notes, once. "Add to team memory"
 * is ticked, with the warning beside it, and can be unticked.
 */
export function SaveToTeamDialog({ overview, onClose, onSaved }: { overview: MeetingOverview; onClose: () => void; onSaved: (done: SaveMeetingToTeamResponse) => void }) {
  const session = useSession();
  const fixed = overview.teamSlug;
  const teams = session.teams;
  const [slug, setSlug] = useState(fixed ?? (teams.length === 1 ? (teams[0]?.slug ?? '') : ''));
  const [memory, setMemory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<SaveMeetingToTeamResponse | null>(null);
  const teamName = fixed ? (teams.find((t) => t.slug === fixed)?.name ?? fixed) : null;

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await saveMeetingToTeam(overview.meeting.id, { addToMemory: memory, ...(slug ? { teamSlug: slug } : {}) });
      setDone(res);
      onSaved(res);
    } catch (e) {
      setError(isConflict(e) ? SAVED_ALREADY : actionFailure(e, 'The notes could not be saved to the team. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Dialog title="Saved to the team" onClose={onClose} testId="save-team-dialog" footer={<button type="button" className="btn primary" onClick={onClose} data-autofocus>Done</button>}>
        <p className="dlg-text" data-testid="save-team-done">
          The notes and the transcript are now in the team’s meeting notes{done.memoryItemId ? ', and they were added to the team’s memory' : ''}.
        </p>
        <p className="dlg-hint">Saved at <code>{done.path}</code></p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Save to team meeting notes"
      onClose={onClose}
      testId="save-team-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || slug === ''} onClick={() => void save()} data-testid="save-team-go">{busy ? 'Saving…' : 'Save to team'}</button>
        </>
      }
    >
      <p className="dlg-text">{SAVE_EXPLAINED}</p>
      <div className="dlg-form">
        {teamName ? (
          <p className="dlg-text" data-testid="save-team-name">Team: <b>{teamName}</b></p>
        ) : (
          <>
            <label className="dlg-label" htmlFor="mv-save-team">Team</label>
            <select id="mv-save-team" className="dlg-input" value={slug} onChange={(e) => setSlug(e.target.value)} data-testid="save-team-pick">
              <option value="">Choose a team</option>
              {teams.map((t) => (<option key={t.slug} value={t.slug}>{t.name}</option>))}
            </select>
          </>
        )}
        <label className="mv-check">
          <input type="checkbox" checked={memory} onChange={(e) => setMemory(e.target.checked)} data-testid="save-team-memory" />
          <span>
            <b>Add to team memory</b>
            <span className="mv-check-help">{MEMORY_WARNING}</span>
          </span>
        </label>
        {error ? <p className="dlg-error" role="alert" data-testid="save-team-error">{error}</p> : null}
      </div>
    </Dialog>
  );
}

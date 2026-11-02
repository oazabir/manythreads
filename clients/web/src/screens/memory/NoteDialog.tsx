import { useState } from 'react';
import { INBOX_NAME_MAX, INBOX_NOTE_MAX_CHARS, type InboxItem } from '@manythreads/shared';
import { Dialog } from '../../components/Dialog';
import { createInboxNote } from './inboxApi';
import { message } from './inboxWords';

/**
 * New note: pasted text with an optional title, dropped into the team's inbox. A text that is only a web address is filed as a link; the page it points at is
 * never fetched. Everyone on the team sees what is filed, unless "Team only" keeps it out of what is shared with other teams.
 */
export function NoteDialog({ slug, teamOnlyDefault, onClose, onDone }: { slug: string; teamOnlyDefault: boolean; onClose: () => void; onDone: (item: InboxItem, duplicate: boolean) => void }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [teamOnly, setTeamOnly] = useState(teamOnlyDefault);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = text.trim() === '';

  const submit = async (): Promise<void> => {
    if (empty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const t = title.trim();
      const answer = await createInboxNote(slug, { ...(t ? { title: t } : {}), text, teamOnly });
      onDone(answer.item, answer.duplicate);
      onClose();
    } catch (e) {
      setBusy(false);
      setError(message(e, 'The note could not be added. Try again.'));
    }
  };

  return (
    <Dialog
      title="New note"
      onClose={onClose}
      testId="inbox-note-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={empty || busy} onClick={() => void submit()} data-testid="inbox-note-submit">{busy ? 'Adding…' : 'Add to inbox'}</button>
        </>
      }
    >
      <p className="mi-help">Paste or write anything the team should remember. The team’s inbox reads it and files what is worth keeping as memory that everyone on the team can see.</p>
      <label className="mi-label" htmlFor="mi-note-title">Title (optional)</label>
      <input id="mi-note-title" className="mi-input" type="text" maxLength={INBOX_NAME_MAX} value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
      <label className="mi-label" htmlFor="mi-note-text">Note</label>
      <textarea id="mi-note-text" className="mi-input mi-text" rows={8} maxLength={INBOX_NOTE_MAX_CHARS} value={text} onChange={(e) => setText(e.target.value)} data-testid="inbox-note-text" />
      <label className="check mi-check">
        <input type="checkbox" checked={teamOnly} onChange={(e) => setTeamOnly(e.target.checked)} data-testid="inbox-note-team-only" />
        <span>Team only: keep this out of what is shared with other teams</span>
      </label>
      {error ? <p className="mi-error" role="alert" data-testid="inbox-note-error">{error}</p> : null}
    </Dialog>
  );
}

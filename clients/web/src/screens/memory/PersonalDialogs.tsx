import { useState } from 'react';
import { Link } from 'react-router';
import { INBOX_NAME_MAX, INBOX_NOTE_MAX_CHARS, type PersonalInboxItem, type TeamSummary } from '@manythreads/shared';
import { Dialog } from '../../components/Dialog';
import { message } from './inboxWords';
import { createPersonalNote, sendPersonalItemToTeam } from './personalApi';
import { teamChoiceLabel } from './personalWords';

/**
 * New note for your own inbox: pasted text with an optional title. It is read and filed as a reference in your own memory. A text that is only a web address is
 * kept as a link and the page is never fetched. Nobody else is shown it.
 */
export function PersonalNoteDialog({ onClose, onDone }: { onClose: () => void; onDone: (item: PersonalInboxItem, duplicate: boolean) => void }) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = text.trim() === '';

  const submit = async (): Promise<void> => {
    if (empty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const t = title.trim();
      const answer = await createPersonalNote({ ...(t ? { title: t } : {}), text });
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
      testId="personal-note-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={empty || busy} onClick={() => void submit()} data-testid="personal-note-submit">{busy ? 'Adding…' : 'Add to my inbox'}</button>
        </>
      }
    >
      <p className="mi-help">Paste or write anything you want to remember. It is read and filed in your own memory, and only you can see it.</p>
      <label className="mi-label" htmlFor="pi-note-title">Title (optional)</label>
      <input id="pi-note-title" className="mi-input" type="text" maxLength={INBOX_NAME_MAX} value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
      <label className="mi-label" htmlFor="pi-note-text">Note</label>
      <textarea id="pi-note-text" className="mi-input mi-text" rows={8} maxLength={INBOX_NOTE_MAX_CHARS} value={text} onChange={(e) => setText(e.target.value)} data-testid="personal-note-text" />
      {error ? <p className="mi-error" role="alert" data-testid="personal-note-error">{error}</p> : null}
    </Dialog>
  );
}

/**
 * Send to team: a copy of the original is dropped into the team's inbox as you. From then on that team's rules apply (its holds, its size limit, whether a lead
 * checks it first), and what is filed is memory everyone on the team can see. Your own copy stays where it is.
 */
export function SendToTeamDialog({ item, teams, onClose, onDone }: { item: PersonalInboxItem; teams: readonly TeamSummary[]; onClose: () => void; onDone: (said: string) => void }) {
  const [slug, setSlug] = useState(teams[0]?.slug ?? '');
  const [teamOnly, setTeamOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const team = teams.find((t) => t.slug === slug) ?? null;

  const send = async (): Promise<void> => {
    if (!team || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await sendPersonalItemToTeam(item.id, { teamSlug: team.slug, teamOnly });
      onDone(answer.duplicate ? `${item.name} is already in ${team.name}’s memory inbox.` : `${item.name} was copied to ${team.name}’s memory inbox.`);
      onClose();
    } catch (e) {
      setBusy(false);
      setError(message(e, 'It could not be sent to the team. Try again.'));
    }
  };

  return (
    <Dialog
      title="Send to team"
      onClose={onClose}
      testId="personal-send-team-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!team || busy} onClick={() => void send()} data-testid="personal-send-team-submit">{busy ? 'Sending…' : 'Send a copy'}</button>
        </>
      }
    >
      {teams.length === 0 ? (
        <p className="mi-help" data-testid="personal-send-team-none">You are not in a team yet, so there is nowhere to send it.</p>
      ) : (
        <>
          <p className="mi-help" data-testid="personal-send-team-help">
            A copy of “{item.name}” goes to the team’s memory inbox, as you. It is read and filed there, and everyone in that team will be able to see what is filed. The team’s own rules apply, and your copy stays in your inbox.
          </p>
          <label className="mi-label" htmlFor="pi-send-team">Team</label>
          <select id="pi-send-team" className="mi-input" value={slug} onChange={(e) => setSlug(e.target.value)} data-testid="personal-send-team-select">
            {teams.map((t) => (
              <option key={t.slug} value={t.slug}>{teamChoiceLabel(t)}</option>
            ))}
          </select>
          <label className="check mi-check">
            <input type="checkbox" checked={teamOnly} onChange={(e) => setTeamOnly(e.target.checked)} data-testid="personal-send-team-only" />
            <span>Team only: keep this out of what is shared with other teams</span>
          </label>
          {team ? (
            <p className="mi-help">
              <Link to={`/t/${encodeURIComponent(team.slug)}/memory?tab=inbox`} onClick={onClose}>Open {team.name}’s memory inbox</Link> to see the rules it follows.
            </p>
          ) : null}
        </>
      )}
      {error ? <p className="mi-error" role="alert" data-testid="personal-send-team-error">{error}</p> : null}
    </Dialog>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { MeetingPerson } from '@manythreads/shared';
import { Dialog } from '../components/Dialog';
import { useShell } from '../shell/context';
import { meetingPath } from '../shell/messageLink';
import { fetchMeetingPeople, openMeetingSpace } from './api';
import { notifyMeetingSpacesChanged } from './spaces';
import { callController } from './store';

/*
 * New meeting (P36-03): a meeting that needs no channel. Pick the team it is for, a title, audio or video, and the people to invite from any team; Start opens its
 * own private space (its card, chat, notes and transcript) and starts the call there, and the invited are told as for any call.
 */
export function NewMeetingDialog({ onClose }: { onClose: () => void }) {
  const { teams, team } = useShell();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [teamSlug, setTeamSlug] = useState(team?.slug ?? teams[0]?.slug ?? '');
  const [kind, setKind] = useState<'audio' | 'video'>('audio');
  const [find, setFind] = useState('');
  const [found, setFound] = useState<MeetingPerson[]>([]);
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      fetchMeetingPeople(find.trim()).then(
        (r) => live && setFound(r.people),
        () => live && setFound([]),
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [find]);
  const toggle = (p: MeetingPerson): void =>
    setPicked((m) => {
      const next = new Map(m);
      if (!next.delete(p.personId)) next.set(p.personId, p.name);
      return next;
    });
  const start = async (): Promise<void> => {
    if (title.trim() === '') return setError('Give the meeting a title.');
    if (!teamSlug) return setError('Pick the team the meeting is for.');
    setBusy(true);
    setError(null);
    try {
      const res = await openMeetingSpace({ title: title.trim(), teamSlug, kind, inviteeIds: [...picked.keys()] as never });
      notifyMeetingSpacesChanged();
      onClose();
      void navigate(meetingPath(teamSlug, res.channelId));
      await callController().enterOpened(res);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'The meeting could not start. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="New meeting"
      onClose={onClose}
      testId="new-meeting-dialog"
      wide
      startAtTop
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void start()} data-testid="new-meeting-start">{busy ? 'Starting…' : 'Start meeting'}</button>
        </>
      }
    >
      <p className="dlg-text">A meeting of its own, with people from any team. It gets its own private conversation for the call card, the chat and the notes.</p>
      <div className="dlg-form">
        <label className="dlg-label" htmlFor="nm-title">Title</label>
        <input id="nm-title" className="dlg-input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Escalation review" data-autofocus data-testid="new-meeting-title" />
        <label className="dlg-label" htmlFor="nm-team">For the team</label>
        <select id="nm-team" className="dlg-input" value={teamSlug} onChange={(e) => setTeamSlug(e.target.value)} data-testid="new-meeting-team">
          {teams.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}
        </select>
        <span className="dlg-label">Call</span>
        <div className="su-days" role="radiogroup" aria-label="Call">
          <label className="su-check"><input type="radio" name="nm-kind" checked={kind === 'audio'} onChange={() => setKind('audio')} data-testid="new-meeting-audio" /> Audio</label>
          <label className="su-check"><input type="radio" name="nm-kind" checked={kind === 'video'} onChange={() => setKind('video')} data-testid="new-meeting-video" /> Video</label>
        </div>
        <label className="dlg-label" htmlFor="nm-find">Invite people from any team{picked.size > 0 ? ` (${picked.size} picked)` : ''}</label>
        <input id="nm-find" className="dlg-input" type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Search by name" data-testid="new-meeting-find" />
        <ul className="nm-people" aria-label="People">
          {[...new Map([...[...picked].map(([personId, name]) => [personId, { personId, name }] as const), ...found.map((p) => [p.personId, p] as const)]).values()].map((p) => (
            <li key={p.personId}>
              <label className="su-check">
                <input type="checkbox" checked={picked.has(p.personId)} onChange={() => toggle(p as MeetingPerson)} data-testid="new-meeting-person" data-person={p.personId} /> {p.name}
              </label>
            </li>
          ))}
        </ul>
        {error ? <p className="dlg-error" role="alert">{error}</p> : null}
      </div>
    </Dialog>
  );
}

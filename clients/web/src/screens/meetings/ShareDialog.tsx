import { useState } from 'react';
import type { ChannelId, CreateMeetingShareRequest, MeetingOverview, MeetingShare, PersonId } from '@manythreads/shared';
import { fetchNavChannels, fetchRoster } from '../../api/endpoints';
import { useSession } from '../../app/session';
import { useQuery } from '../../app/useQuery';
import { usePeople } from '../../channels/hooks';
import { Dialog } from '../../components/Dialog';
import { fetchMeetingShares, shareMeeting, unshareMeeting } from '../../meetings/api';
import { SHARE_EXPLAINED, actionFailure, channelChoices, granteeWords, liveShares, personChoices } from './words';

type Who = 'person' | 'channel';

/**
 * Share (PLAN P15-22): the organizer gives a person, or everyone who can read a channel, access to the notes and the transcript, and takes it back. The server checks who may
 * read on every read, so the list here is only what was given.
 */
export function ShareDialog({ overview, onClose, onChanged }: { overview: MeetingOverview; onClose: () => void; onChanged?: () => void }) {
  const meetingId = overview.meeting.id;
  const slug = overview.teamSlug;
  const self = useSession().person.id;
  const shell = usePeople();
  const shares = useQuery(`meeting-shares:${meetingId}`, () => fetchMeetingShares(meetingId));
  // a team meeting offers the team's people and channels; a direct-message call offers the people who were in it
  const roster = useQuery(`meeting-share-roster:${slug ?? ''}`, () => (slug ? fetchRoster(slug).then((r) => r.members) : Promise.resolve(null)));
  const channels = useQuery(`meeting-share-channels:${slug ?? ''}`, () => (slug ? fetchNavChannels(slug).then((d) => d.groups.flatMap((g) => g.channels)) : Promise.resolve([])));

  const [who, setWho] = useState<Who>('person');
  const [personId, setPersonId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<MeetingShare[]>([]);
  const [taken, setTaken] = useState<string[]>([]);

  const current: MeetingShare[] = shares.status === 'ok' ? [...shares.data.shares, ...added].filter((s) => !taken.includes(s.id)) : added;
  const active = liveShares(current);

  const people = roster.status === 'ok' && roster.data
    ? roster.data.map((m) => ({ personId: m.personId, name: m.displayName }))
    : overview.people.flatMap((p) => {
        const known = shell.byActor(p.actorId);
        return known ? [{ personId: known.personId, name: known.name }] : [];
      });
  const personOptions = personChoices(people, current, self);
  const channelOptions = channelChoices(channels.status === 'ok' ? channels.data : [], current);
  const canChannel = slug !== null;

  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const body: CreateMeetingShareRequest = who === 'person' ? { kind: 'person', personId: personId as PersonId } : { kind: 'channel', channelId: channelId as ChannelId };
      const res = await shareMeeting(meetingId, body);
      setAdded((a) => [...a, res.share]);
      setPersonId('');
      setChannelId('');
      onChanged?.();
    } catch (e) {
      setError(actionFailure(e, 'That could not be shared. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const stop = async (share: MeetingShare): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await unshareMeeting(meetingId, share.id);
      setTaken((t) => [...t, share.id]);
      onChanged?.();
    } catch (e) {
      setError(actionFailure(e, 'That could not be taken back. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const ready = who === 'person' ? personId !== '' : channelId !== '';
  return (
    <Dialog title="Share these notes" onClose={onClose} testId="share-dialog" footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
      <p className="dlg-text">{SHARE_EXPLAINED}</p>
      <div className="mv-share-list" data-testid="share-list">
        <h3 className="mv-sub">Shared with</h3>
        {shares.status === 'loading' ? <p className="dlg-hint" role="status" aria-busy="true">Loading who this is shared with…</p> : null}
        {shares.status === 'error' ? <p className="dlg-error" role="alert">{actionFailure(shares.error, 'Could not load who this is shared with.')}</p> : null}
        {shares.status === 'ok' && active.length === 0 ? <p className="dlg-hint" data-testid="share-none">Not shared with anyone yet.</p> : null}
        {active.length > 0 ? (
          <ul className="mv-shares">
            {active.map((s) => (
              <li key={s.id} className="mv-share" data-testid="share-row">
                <span className="mv-share-name">{granteeWords(s.grantee)}</span>
                <span className="mv-share-kind">{s.grantee.kind === 'person' ? 'Person' : 'Channel'}</span>
                <button type="button" className="btn s" disabled={busy} onClick={() => void stop(s)} data-testid="share-stop">Stop sharing</button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <form
        className="dlg-form mv-share-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) void add();
        }}
      >
        <h3 className="mv-sub">Share with</h3>
        <div className="mv-seg" role="radiogroup" aria-label="Share with a person or a channel">
          <button type="button" role="radio" aria-checked={who === 'person'} className={`mv-seg-btn ${who === 'person' ? 'on' : ''}`} onClick={() => setWho('person')}>A person</button>
          {canChannel ? <button type="button" role="radio" aria-checked={who === 'channel'} className={`mv-seg-btn ${who === 'channel' ? 'on' : ''}`} onClick={() => setWho('channel')}>A channel</button> : null}
        </div>
        {who === 'person' ? (
          <>
            <label className="dlg-label" htmlFor="mv-share-person">Person</label>
            <select id="mv-share-person" className="dlg-input" value={personId} onChange={(e) => setPersonId(e.target.value)} data-testid="share-person">
              <option value="">Choose a person</option>
              {personOptions.map((p) => (<option key={p.personId} value={p.personId}>{p.name}</option>))}
            </select>
            {personOptions.length === 0 ? <p className="dlg-hint">There is nobody else to share with here.</p> : null}
          </>
        ) : (
          <>
            <label className="dlg-label" htmlFor="mv-share-channel">Channel</label>
            <select id="mv-share-channel" className="dlg-input" value={channelId} onChange={(e) => setChannelId(e.target.value)} data-testid="share-channel">
              <option value="">Choose a channel</option>
              {channelOptions.map((c) => (<option key={c.id} value={c.id}>{`# ${c.name}`}</option>))}
            </select>
            <p className="dlg-hint">Everyone who can read the channel can read these notes.</p>
          </>
        )}
        {error ? <p className="dlg-error" role="alert" data-testid="share-error">{error}</p> : null}
        <div className="mv-share-go">
          <button type="submit" className="btn primary" disabled={!ready || busy} data-testid="share-add">{busy ? 'Sharing…' : 'Share'}</button>
        </div>
      </form>
    </Dialog>
  );
}

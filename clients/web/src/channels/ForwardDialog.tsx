import { useMemo, useState } from 'react';
import type { ChannelMessage } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { fetchDms, fetchNavChannels, forwardMessage } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { Dialog } from '../components/Dialog';
import { useShell } from '../shell/context';
import { GUEST_SLUG } from '../shell/messageLink';
import { channelTargets, dmTargets, filterTargets, type ForwardTarget } from './messageActions';

/**
 * Forward one message into another channel or direct message (PLAN P14-12). The new message is the person's own: their name, their note.
 * It points at the original and does not copy it, so people in the target who cannot read the original see only that a message was
 * forwarded. The list holds the places the person can see; the server checks again that they may post there.
 */
export function ForwardDialog({ message, selfPersonId, onClose, onDone }: { message: ChannelMessage; selfPersonId: string | null; onClose: () => void; onDone: (label: string) => void }) {
  const { teams, guest } = useShell();
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<ForwardTarget | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slugs = guest ? [GUEST_SLUG] : teams.map((t) => t.slug);
  const places = useQuery<ForwardTarget[]>(`forward-targets:${slugs.join(',')}`, async () => {
    const [dirs, dms] = await Promise.all([
      Promise.all(slugs.map(async (slug) => ({ teamName: teams.find((t) => t.slug === slug)?.name ?? 'Channels', groups: (await fetchNavChannels(slug).catch(() => ({ groups: [] }))).groups }))),
      fetchDms().then((r) => r.items).catch(() => []),
    ]);
    return [...channelTargets(dirs), ...dmTargets(dms, selfPersonId)];
  });
  const shown = useMemo(() => (places.status === 'ok' ? filterTargets(places.data, filter) : []), [places, filter]);

  const send = async (): Promise<void> => {
    if (!picked || busy) return;
    setBusy(true);
    setError(null);
    try {
      await forwardMessage(message.channelId, message.id, picked.id, note);
      onDone(picked.label);
      onClose();
    } catch (e) {
      setBusy(false);
      setError(isApiError(e) && e.status === 403 ? 'You cannot post there.' : e instanceof Error && e.message ? e.message : 'Could not forward the message. Try again.');
    }
  };

  return (
    <Dialog
      title="Forward message"
      onClose={onClose}
      testId="forward-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!picked || busy} onClick={() => void send()} data-testid="forward-send">{busy ? 'Forwarding…' : 'Forward'}</button>
        </>
      }
    >
      <p className="fwd-help">
        The forwarded message is posted as you. People who can read the original see who wrote it and an excerpt; everyone else sees only that a message was forwarded.
      </p>
      <label className="fwd-label" htmlFor="fwd-filter">Forward to</label>
      <input id="fwd-filter" className="fwd-filter" type="search" placeholder="Find a channel or a person" value={filter} onChange={(e) => setFilter(e.target.value)} autoComplete="off" />
      <ul className="fwd-places" aria-label="Where to forward">
        {places.status === 'loading' ? <li className="fwd-none">Loading…</li> : null}
        {places.status === 'error' ? <li className="fwd-none" role="alert">Could not load your channels.</li> : null}
        {places.status === 'ok' && shown.length === 0 ? <li className="fwd-none">Nothing matches.</li> : null}
        {shown.map((t) => (
          <li key={t.id}>
            <button type="button" className={`fwd-place ${picked?.id === t.id ? 'on' : ''}`} aria-pressed={picked?.id === t.id} onClick={() => setPicked(t)} data-testid="forward-place">
              <span>{t.label}</span>
              <small>{t.isPrivate && t.kind === 'channel' ? `${t.hint} · private` : t.hint}</small>
            </button>
          </li>
        ))}
      </ul>
      <label className="fwd-label" htmlFor="fwd-note">Add a note (optional)</label>
      <textarea id="fwd-note" className="fwd-note" rows={3} maxLength={4_000} value={note} onChange={(e) => setNote(e.target.value)} />
      {error ? <p className="fwd-error" role="alert">{error}</p> : null}
    </Dialog>
  );
}

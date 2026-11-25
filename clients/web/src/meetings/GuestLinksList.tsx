import { useEffect, useState } from 'react';
import type { GuestLinkRow } from '@manythreads/shared';
import { isApiError } from '../api/client';
import { listGuestLinks, revokeGuestLink } from './api';

/*
 * "Guest links (n)" on the call card (P17-04 step 2), for the starter, a lead or an admin: the links of the call that still work, who made each one, how many of its
 * knocks are used and until when it works, with Turn off for each. The address itself is never shown again (the server keeps only its hash). Guests already in
 * the call stay when their link is turned off.
 */

/** One link as a line: "Made by Omar at 14:02 · 2 of 50 used · works until 02:02". */
export function guestLinkLine(l: Pick<GuestLinkRow, 'createdByName' | 'createdAt' | 'expiresAt' | 'uses' | 'maxUses'>, timeOf: (iso: string) => string = shortTime): string {
  return `Made by ${l.createdByName} at ${timeOf(l.createdAt)} · ${l.uses} of ${l.maxUses} used · works until ${timeOf(l.expiresAt)}`;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// read when called, so a test that mocks the api module without these names still draws the card
const REAL = { list: (meetingId: string) => listGuestLinks(meetingId), revoke: (meetingId: string, linkId: string) => revokeGuestLink(meetingId, linkId) };

type Load = { status: 'loading' } | { status: 'ok'; links: readonly GuestLinkRow[] } | { status: 'failed'; message: string };

export function GuestLinksList({ meetingId, onChanged, deps = REAL }: { meetingId: string; onChanged: () => void; deps?: { list: (meetingId: string) => ReturnType<typeof listGuestLinks>; revoke: (meetingId: string, linkId: string) => ReturnType<typeof revokeGuestLink> } }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    deps
      .list(meetingId)
      .then((r) => live && setLoad({ status: 'ok', links: r.links }))
      .catch((e: unknown) => live && setLoad({ status: 'failed', message: isApiError(e) && e.status !== 0 && e.message ? e.message : 'Could not load the guest links. Try again.' }));
    return () => {
      live = false;
    };
  }, [meetingId, deps]);

  const turnOff = async (linkId: string): Promise<void> => {
    setBusy(linkId);
    setProblem(null);
    try {
      await deps.revoke(meetingId, linkId);
      setLoad((l) => (l.status === 'ok' ? { status: 'ok', links: l.links.filter((x) => x.id !== linkId) } : l));
      onChanged();
    } catch (e) {
      setProblem(isApiError(e) && e.status !== 0 && e.message ? e.message : 'Could not turn that link off. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="room-card-links" role="group" aria-label="Guest links" data-testid="room-card-links">
      {load.status === 'loading' ? <p className="room-card-links-note" role="status">Loading the guest links…</p> : null}
      {load.status === 'failed' ? <p className="room-card-links-note" role="alert">{load.message}</p> : null}
      {load.status === 'ok' && load.links.length === 0 ? <p className="room-card-links-note" data-testid="room-card-links-empty">No guest link of this call works now.</p> : null}
      {load.status === 'ok' && load.links.length > 0 ? (
        <ul className="room-card-links-list">
          {load.links.map((l) => (
            <li key={l.id} className="room-card-link" data-testid="room-card-link" data-link-id={l.id}>
              <span className="room-card-link-text">{guestLinkLine(l)}</span>
              <button type="button" className="btn s" disabled={busy !== null} onClick={() => void turnOff(l.id)} data-testid="room-card-link-off" aria-label={`Turn off the link made by ${l.createdByName}`}>
                {busy === l.id ? 'Turning off…' : 'Turn off'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {problem ? <p className="dlg-error" role="alert">{problem}</p> : null}
    </div>
  );
}

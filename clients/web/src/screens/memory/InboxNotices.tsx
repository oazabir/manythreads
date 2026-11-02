import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { InboxState } from '@manythreads/shared';
import { useShell } from '../../shell/context';
import { fetchInboxItem } from './inboxApi';
import { useInboxPush } from './inboxLive';
import { conceptLink, filedConcepts, inboxLink, noticeCopy } from './inboxWords';

type Notice = { id: string; slug: string; text: string; tone: 'ok' | 'warn'; firstConcept: string | null };

/** The states worth telling a person about; a drop that is only waiting or being read is not. */
const TELL: ReadonlySet<InboxState> = new Set<InboxState>(['filed', 'held', 'needs_review', 'failed']);
const SHOWN_FOR_MS = 12_000;

/**
 * "Filed 3 concepts from Design review notes": a short line, anywhere in the app, when one of the person's own drops is filed, held or could not be filed.
 * The server sends the push to the person who dropped the item only, with no words in it; the words are made here from the item.
 */
export function InboxNotices() {
  const { teams } = useShell();
  const [notices, setNotices] = useState<Notice[]>([]);
  const timers = useRef(new Map<string, number>());
  const teamsRef = useRef(teams);
  useEffect(() => {
    teamsRef.current = teams;
  });
  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const t of live.values()) window.clearTimeout(t);
    };
  }, []);

  const dismiss = useCallback((id: string): void => {
    setNotices((n) => n.filter((x) => x.id !== id));
    const t = timers.current.get(id);
    if (t !== undefined) window.clearTimeout(t);
    timers.current.delete(id);
  }, []);

  useInboxPush(
    useCallback(
      (change) => {
        if (!TELL.has(change.state)) return;
        const team = teamsRef.current.find((t) => t.id === change.teamId);
        if (!team) return;
        fetchInboxItem(team.slug, change.itemId).then(
          ({ item }) => {
            const text = noticeCopy(item);
            if (!text) return;
            const notice: Notice = { id: item.id, slug: team.slug, text, tone: item.state === 'filed' ? 'ok' : 'warn', firstConcept: filedConcepts(item)[0] ?? null };
            setNotices((n) => [...n.filter((x) => x.id !== item.id), notice]);
            const old = timers.current.get(item.id);
            if (old !== undefined) window.clearTimeout(old);
            timers.current.set(item.id, window.setTimeout(() => dismiss(item.id), SHOWN_FOR_MS));
          },
          () => undefined,
        );
      },
      [dismiss],
    ),
  );

  if (notices.length === 0) return null;
  return (
    <div className="mi-notices" role="status" aria-live="polite" data-testid="inbox-notices">
      {notices.map((n) => (
        <div key={n.id} className={`mi-notice ${n.tone}`} data-testid="inbox-notice">
          <span className="mi-notice-text">{n.text}</span>
          <Link to={n.firstConcept ? conceptLink(n.slug, n.firstConcept) : inboxLink(n.slug)} onClick={() => dismiss(n.id)}>{n.firstConcept ? 'Open it' : 'Open the inbox'}</Link>
          <button type="button" className="btn s" onClick={() => dismiss(n.id)} aria-label="Dismiss">Dismiss</button>
        </div>
      ))}
    </div>
  );
}

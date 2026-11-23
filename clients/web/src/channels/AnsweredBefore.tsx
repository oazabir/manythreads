import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { AnsweredBeforeItem } from '@manythreads/shared';
import { fetchAnsweredBefore } from '../api/endpoints';
import { CloseIcon } from '../shell/icons';
import { messageLinkPath } from './messageActions';

/*
 * Answered before (P18-09): in a help channel, while a question is being written, earlier answers are shown above the box — a thread of the team that was
 * answered, with the first answer, and a knowledge passage. It asks after a pause in typing, only for a question of a few words, and posts nothing: the
 * writer reads and sends their question or not. Closing it hides it until the box is empty again.
 */

const PAUSE_MS = 700;
/** A question worth looking up: four words or more, not a slash command. */
export const worthAsking = (text: string): boolean => {
  const t = text.trim();
  return t.length >= 12 && !t.startsWith('/') && t.split(/\s+/).length >= 4;
};

export function AnsweredBefore({ channelId, teamSlug, text }: { channelId: string; teamSlug: string; text: string }) {
  const [items, setItems] = useState<AnsweredBeforeItem[]>([]);
  const [closed, setClosed] = useState(false);
  const asked = useRef('');
  const q = text.trim();
  useEffect(() => {
    if (q === '') setClosed(false);
    if (!worthAsking(q)) {
      setItems([]);
      asked.current = '';
      return;
    }
    if (closed || q === asked.current) return;
    let live = true;
    const t = window.setTimeout(() => {
      asked.current = q;
      fetchAnsweredBefore(channelId, q.slice(0, 500)).then(
        (r) => {
          if (live) setItems(r.help ? r.items : []);
        },
        () => {
          if (live) setItems([]);
        },
      );
    }, PAUSE_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [channelId, q, closed]);
  if (closed || items.length === 0) return null;
  return (
    <section className="ab" aria-label="Answered before" data-testid="answered-before">
      <header className="ab-head">
        <span className="ab-title">Answered before</span>
        <span className="ab-sub">Check these before you ask. Nothing is posted.</span>
        <button type="button" className="icon-btn ab-close" aria-label="Hide earlier answers" data-testid="answered-before-close" onClick={() => setClosed(true)}>
          <CloseIcon />
        </button>
      </header>
      <ul className="ab-list">
        {items.map((it) =>
          it.kind === 'thread' ? (
            <li key={`t:${it.rootId}`} className="ab-item" data-testid="answered-before-thread">
              <Link to={messageLinkPath({ channelId: it.channelId, messageId: it.rootId, threadRootId: it.rootId })} className="ab-link">
                {it.title}
              </Link>
              <span className="ab-meta">
                #{it.channelName} · {it.replyCount} {it.replyCount === 1 ? 'reply' : 'replies'}
              </span>
              {it.answer ? <p className="ab-snip">{it.answer}</p> : null}
            </li>
          ) : (
            <li key={`k:${it.base}:${it.document}:${it.section ?? ''}`} className="ab-item" data-testid="answered-before-knowledge">
              {it.file ? (
                <Link to={`/t/${encodeURIComponent(teamSlug)}/files?open=${encodeURIComponent(it.file)}`} className="ab-link">
                  {it.document}
                </Link>
              ) : (
                <span className="ab-link">{it.document}</span>
              )}
              <span className="ab-meta">
                Knowledge · {it.base}
                {it.section ? ` · ${it.section}` : ''}
              </span>
              <p className="ab-snip">{it.text}</p>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

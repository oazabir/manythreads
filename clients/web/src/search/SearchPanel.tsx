import { useMemo } from 'react';
import type { SearchFileHit, SearchMessageHit, SearchThreadHit } from '@manythreads/shared';
import { fileContentUrl, searchEverything } from '../api/endpoints';
import { useQuery } from '../app/useQuery';
import { ago, fileKind, fileSize } from '../channels/format';
import { usePeople } from '../channels/hooks';
import type { PanelEntry } from '../kernel/panel';
import { useShell } from '../shell/context';
import { useOpenMessage, type MessageTarget } from '../shell/messageLink';
import { Highlight } from './Highlight';
import { parseSearchEntry, searchEntry } from './searchEntry';

type HitChannel = SearchMessageHit['channel'];
const where = (c: HitChannel | null): string => (c === null ? 'File' : c.kind === 'channel' ? `#${(c.name ?? '').replace(/^#/, '')}` : c.kind === 'dm' ? 'Direct message' : 'Bot conversation');

/** Search results (PLAN P3-16 wireframe): Messages, Threads, Files with counts; a click lands on the message, the thread or the file. */
export function SearchPanel({ entry }: { entry: PanelEntry }) {
  const { q, channelId } = parseSearchEntry(entry.id);
  const { team, guest } = useShell();
  const people = usePeople();
  const open = useOpenMessage();
  // The sidebar box searches the team it names; a conversation's own box searches everything and keeps that conversation's hits.
  const teamId = !guest && !channelId ? team?.id : undefined;
  const short = q.trim().length < 2;
  const res = useQuery(`search:${entry.id}:${teamId ?? ''}`, () => (short ? Promise.resolve(null) : searchEverything(q, { ...(teamId ? { teamId } : {}), limit: channelId ? 50 : 20 })));
  const here = useMemo(() => [searchEntry(q, channelId)], [q, channelId]);

  const data = useMemo(() => {
    if (res.status !== 'ok' || res.data === null) return null;
    const keep = <T extends { channel: HitChannel | null }>(hits: T[]): T[] => (channelId ? hits.filter((h) => h.channel?.id === channelId) : hits);
    return { messages: keep(res.data.messages), threads: keep(res.data.threads), files: keep(res.data.files) };
  }, [res, channelId]);

  const target = (c: HitChannel, messageId: string, threadRootId: string | null): MessageTarget => ({
    channelId: c.id,
    channelKind: c.kind,
    channelName: c.name,
    teamId: c.teamId,
    messageId,
    threadRootId,
  });

  const body = (): React.ReactNode => {
    if (short) return <p className="search-note">Type at least two characters to search.</p>;
    if (res.status === 'loading') return <p className="loading" aria-busy="true">Searching…</p>;
    if (res.status === 'error' || data === null) {
      return (
        <div role="alert">
          <p className="panel-empty-title">Search is not available right now.</p>
          <button type="button" className="btn s" onClick={res.reload}>Try again</button>
        </div>
      );
    }
    const total = data.messages.length + data.threads.length + data.files.length;
    if (total === 0) return <p className="search-empty" data-testid="search-empty">No results in what you can see.</p>;
    return (
      <>
        <section className="sr-group" aria-label="Messages" data-testid="search-messages">
          <h3>{`Messages (${data.messages.length})`}</h3>
          <ul>
            {data.messages.map((h) => (
              <li key={h.id}>
                <button type="button" className="hit" data-testid="search-hit" onClick={() => void open(target(h.channel, h.id, h.threadRootId), here)}>
                  <span className="hit-where">
                    <span className="hit-ch">{where(h.channel)}</span>
                    <span>{people.byActor(h.authorId)?.name ?? ''}</span>
                    <span data-vt-mask>{ago(h.createdAt)}</span>
                  </span>
                  <span className="hit-snip"><Highlight text={h.snippet} query={q} /></span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="sr-group" aria-label="Threads" data-testid="search-threads">
          <h3>{`Threads (${data.threads.length})`}</h3>
          <ul>
            {data.threads.map((h: SearchThreadHit) => (
              <li key={h.rootMessageId}>
                <button type="button" className="hit" data-testid="search-hit" onClick={() => void open(target(h.channel, h.rootMessageId, h.rootMessageId), here)}>
                  <span className="hit-where">
                    <span className="hit-ch">{where(h.channel)}</span>
                    <span>{h.replyCount === 1 ? '1 reply' : `${h.replyCount} replies`}</span>
                    <span data-vt-mask>{ago(h.lastReplyAt)}</span>
                  </span>
                  <span className="hit-snip"><Highlight text={h.title} query={q} /></span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="sr-group" aria-label="Files" data-testid="search-files">
          <h3>{`Files (${data.files.length})`}</h3>
          <ul>
            {data.files.map((h: SearchFileHit) => {
              const kind = fileKind(h.name, h.mime);
              return (
                <li key={h.id}>
                  <a className="hit hit-file" data-testid="search-hit" href={fileContentUrl(h.id)} download={h.name}>
                    <span className={`ic ${kind.tone}`}>{kind.label}</span>
                    <span className="hit-text">
                      <span className="hit-snip"><Highlight text={h.name} query={q} /></span>
                      <span className="hit-where">
                        <span className="hit-ch">{where(h.channel)}</span>
                        <span>{fileSize(h.size)}</span>
                      </span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      </>
    );
  };

  return (
    <div className="search-panel" data-testid="search-results" data-query={q}>
      <p className="search-q">
        <b>{q}</b>
        {channelId ? <span className="search-scope"> in this conversation</span> : null}
      </p>
      {body()}
    </div>
  );
}

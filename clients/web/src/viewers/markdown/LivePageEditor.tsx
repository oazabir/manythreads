import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../../app/session';
import { LiveDocument, liveUrl, lineColumn, type LivePeer, type LiveStatus } from './live';

/**
 * Live editing of a page (PLAN P6-09, plate "Durable pages"): the markdown source in a monospace editor, everyone's cursor in their own colour, and
 * the session's commit shown when the server writes it. There is no Save button on purpose — the server commits when the last person leaves or
 * after a minute of quiet, and every editor is a co-author. Exiting hands the committed source back to the viewer (which re-renders it) so the
 * screen does not need a reload.
 */
export function LivePageEditor({ path, teamSlug, onExit }: { path: string; teamSlug: string; onExit: (text: string) => void }) {
  const session = useSession();
  const [live, setLive] = useState<LiveDocument | null>(null);
  const [text, setText] = useState('');
  const [peers, setPeers] = useState<LivePeer[]>([]);
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [saved, setSaved] = useState<{ sha: string; editors: number } | null>(null);
  const [scroll, setScroll] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const opened = new LiveDocument({
      actorId: session.person.id,
      name: session.person.name,
      url: liveUrl(window.location, teamSlug, path),
      onStatus: setStatus,
      onCommit: (notice) => setSaved(notice),
    });
    const refresh = (): void => {
      setText(opened.text.toString());
      setPeers(opened.peers());
    };
    const awareness = (): void => setPeers(opened.peers());
    opened.doc.on('update', refresh);
    opened.awareness.on('update', awareness);
    opened.connect();
    setLive(opened);
    refresh();
    return () => {
      opened.doc.off('update', refresh);
      opened.awareness.off('update', awareness);
      opened.close();
      setLive(null);
    };
  }, [path, teamSlug, session.person.id, session.person.name]);

  const edit = useCallback(
    (next: string) => {
      setText(next);
      live?.edit(next);
    },
    [live],
  );

  const reportCursor = useCallback(() => {
    const el = area.current;
    if (el) live?.setCursor(el.selectionStart, el.selectionEnd);
  }, [live]);

  const carets = useMemo(() => peers.filter((peer): peer is LivePeer & { cursor: { anchor: number; head: number } } => peer.cursor !== null), [peers]);

  return (
    <div className="live" data-testid="live-page">
      <div className="live-bar">
        <span className={`live-dot ${status}`} aria-hidden="true" />
        <span className="live-state" role="status" data-testid="live-status">
          {status === 'offline' ? 'Offline — changes stay here until the connection is back' : status === 'connecting' ? 'Connecting…' : 'Live'}
        </span>
        <span className="live-hint">Saved when everyone leaves or after a minute of quiet. Every editor is a co-author.</span>
        {peers.length > 0 ? (
          <span className="live-people" data-testid="live-people" aria-label={`${peers.length} other editor${peers.length === 1 ? '' : 's'}`}>
            {peers.map((peer) => (
              <span key={peer.actorId} className="live-person" title={`${peer.name} is editing`}>
                <span className="live-avatar" style={{ background: peer.color }} aria-hidden="true">
                  {peer.name.slice(0, 1).toUpperCase()}
                </span>
                {peer.name}
              </span>
            ))}
          </span>
        ) : null}
        <button type="button" className="btn sm" data-testid="leave-live" onClick={() => onExit(text)}>
          Done
        </button>
      </div>
      {saved ? (
        <p className="live-saved" role="status" data-testid="live-saved">
          Saved to history · commit {saved.sha.slice(0, 7)} · {saved.editors} editor{saved.editors === 1 ? '' : 's'}
        </p>
      ) : null}
      {status === 'offline' && text === '' ? <p className="vw-error" role="alert">The page could not be opened for live editing.</p> : null}
      <div className="live-editor">
        <textarea
          ref={area}
          className="live-area mono"
          aria-label="Page source, edited live"
          spellCheck={false}
          value={text}
          onChange={(event) => {
            edit(event.target.value);
            reportCursor();
          }}
          onSelect={reportCursor}
          onKeyUp={reportCursor}
          onClick={reportCursor}
          onScroll={(event) => setScroll(event.currentTarget.scrollTop)}
        />
        <div className="live-caret-layer" aria-hidden="true" style={{ transform: `translateY(-${scroll}px)` }}>
          {carets.map((peer) => {
            const at = lineColumn(text, peer.cursor.anchor);
            return (
              <span
                key={peer.actorId}
                className="live-caret"
                data-testid="live-caret"
                style={{ top: `calc(${at.line} * 1.55em + 0.8em)`, left: `calc(${at.column} * 0.62em + 0.8em)`, borderColor: peer.color }}
              >
                <span className="live-caret-name" style={{ background: peer.color }}>
                  {peer.name}
                </span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

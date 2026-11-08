import { useEffect, useState } from 'react';
import type { MeetingTranscriptLine } from '@manythreads/shared';
import { canOfferServer, engineLine } from './consent';
import type { CallState } from './controller';
import { CAPTION_SHOW, captionHeading, captionsEmptyText, correctionFailure, msClock, visibleCaptions } from './model';
import { callController } from './store';

/*
 * Captions over the call bar (PLAN P15-08): the last two lines people said (or the note-taker answered), with who said them. They fade a few seconds after the last
 * change. "History" opens the lines stored so far, and a person corrects their own lines there for 24 hours. The engine notice (getting the speech model ready, this
 * device is too slow) is a separate card, because it matters even when the captions are off.
 */

/** How long the history waits after the last final caption before it reads the stored lines again. */
const HISTORY_REFRESH_MS = 1500;

function Line({ line, me }: { line: MeetingTranscriptLine; me: string | null }) {
  const c = callController();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(line.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const who = line.speakerId === me ? 'You' : line.speakerName;
  const save = async (): Promise<void> => {
    const next = text.trim();
    if (next === '' || !line.segmentId) return;
    if (next === line.text) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await c.correctLine(line.segmentId, next);
      setEditing(false);
    } catch (e) {
      setError(correctionFailure(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="cap-hist-line" data-testid="caption-history-line" data-transcribed={line.transcribed || undefined}>
      <span className="cap-time" data-vt-mask>{msClock(line.startMs)}</span>
      <b className="cap-who">{who}</b>
      {!line.transcribed ? (
        <span className="cap-skipped">spoke (not transcribed)</span>
      ) : editing ? (
        <form
          className="cap-edit"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <textarea
            className="cap-edit-text"
            aria-label="Correct what you said"
            value={text}
            maxLength={4000}
            rows={2}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditing(false);
                setText(line.text);
              }
            }}
            data-testid="caption-edit-text"
          />
          {error ? <span className="cap-edit-error" role="alert">{error}</span> : null}
          <span className="cap-edit-actions">
            <button type="submit" className="btn primary s" disabled={busy || text.trim() === ''} data-testid="caption-edit-save">Save</button>
            <button type="button" className="btn s" disabled={busy} onClick={() => { setEditing(false); setText(line.text); setError(null); }}>Cancel</button>
          </span>
        </form>
      ) : (
        <>
          <span className="cap-text">{line.text}</span>
          {line.editable && line.segmentId ? (
            <button type="button" className="cap-edit-btn" onClick={() => { setText(line.text); setEditing(true); }} data-testid="caption-edit">Edit</button>
          ) : null}
        </>
      )}
    </li>
  );
}

function History({ call }: { call: CallState }) {
  const c = callController();
  const last = [...call.captions].reverse().find((l) => l.final);
  const lastKey = last?.key ?? null;
  useEffect(() => {
    void c.loadHistory();
  }, [c]);
  // a new final caption: read the stored lines again shortly after (not once per line)
  useEffect(() => {
    if (lastKey === null) return;
    const h = window.setTimeout(() => void c.loadHistory(), HISTORY_REFRESH_MS);
    return () => window.clearTimeout(h);
  }, [c, lastKey]);
  const lines = call.history.lines.slice(-100);
  return (
    <div className="cap-history" data-testid="caption-history" role="region" aria-label="Lines said so far">
      {call.history.status === 'failed' ? <p className="call-hint" role="status">Could not read the lines so far. They will show when the connection is back.</p> : null}
      {lines.length === 0 ? (
        <p className="call-hint">{call.history.status === 'loading' ? 'Reading the lines so far…' : 'Nothing has been written down yet.'}</p>
      ) : (
        <ul className="cap-hist-list">
          {lines.map((l, i) => <Line key={l.segmentId ?? `${l.speakerId}-${l.startMs}-${i}`} line={l} me={call.myActorId} />)}
        </ul>
      )}
      <p className="call-hint">You can correct your own lines for 24 hours.</p>
    </div>
  );
}

/** The captions strip with its history. */
export function Captions({ call, now }: { call: CallState; now: number }) {
  const [history, setHistory] = useState(false);
  const tr = call.transcription;
  const on = !!tr && tr.mode !== 'off';
  const hasNotetaker = call.notetakers?.current != null;
  // with captions off, only the note-taker's answers show: somebody asked for them
  const source = call.prefs.captions ? call.captions : call.captions.filter((l) => l.kind === 'answer');
  const lines = visibleCaptions(source, now, CAPTION_SHOW);
  return (
    <div className="call-captions-wrap" data-testid="call-captions-strip" aria-live="polite">
      <div className="call-captions">
        {lines.length === 0 ? (
          <p className="cap-empty">{captionsEmptyText(on, hasNotetaker)}</p>
        ) : (
          lines.map((l) => (
            <p key={l.key} className="cap-line" data-final={l.final} data-kind={l.kind} data-testid="caption-line">
              <b className="cap-who">{captionHeading(l, call.myActorId)}</b>
              <span className="cap-text">{l.text}</span>
              {l.catchingUp ? <span className="cap-late" data-testid="caption-catching-up">catching up</span> : null}
            </p>
          ))
        )}
        {call.prefs.captions && on ? (
          <button type="button" className="cap-history-btn" aria-expanded={history} onClick={() => setHistory((h) => !h)} data-testid="caption-history-btn">
            {history ? 'Hide lines so far' : 'Lines so far'}
          </button>
        ) : null}
      </div>
      {history && call.prefs.captions && on ? <History call={call} /> : null}
    </div>
  );
}

/** What this person's own engine is doing, when it needs saying: getting ready, too slow for this device, or failed. Null when there is nothing to say. */
export function EngineNotice({ call }: { call: CallState }) {
  const c = callController();
  const [confirm, setConfirm] = useState(false);
  const line = engineLine(call.engine);
  if (!line) return null;
  const stuck = call.engine.kind === 'too_slow' || call.engine.kind === 'failed';
  const server = stuck && canOfferServer(call.transcription);
  return (
    <div className={`call-engine ${stuck ? 'stuck' : ''}`} role="status" data-testid="call-engine" data-kind={call.engine.kind}>
      <span className="call-engine-text">{line}</span>
      {stuck ? (
        confirm ? (
          <>
            <span className="call-engine-text">This changes transcription for everyone in the call: speech is sent to this server, and everyone is asked again.</span>
            <span className="call-engine-actions">
              <button type="button" className="btn primary s" onClick={() => { setConfirm(false); void c.switchToServer(); }} data-testid="engine-server-confirm">Switch to the server</button>
              <button type="button" className="btn s" onClick={() => setConfirm(false)}>Cancel</button>
            </span>
          </>
        ) : (
          <span className="call-engine-actions">
            {server ? <button type="button" className="btn s" onClick={() => setConfirm(true)} data-testid="engine-use-server">Use server transcription</button> : null}
            <button type="button" className="btn s" onClick={() => void c.joinWithoutTranscription()} data-testid="engine-without">Join without transcription</button>
          </span>
        )
      ) : null}
    </div>
  );
}

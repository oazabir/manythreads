import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FIRST_USE_NOTE, NOTHING_HEARD, TranscriptRun, WRITING_TEXT, fetchClipBlob, progressLine, showsFirstUseNote } from './transcribe';

/**
 * "Add a transcript" on a voice message of one's own that went out without words (P14-17): this device writes the clip out, with the same progress
 * lines as the preview, and hands the words to the row's edit box, where they are read, changed and saved like any edit.
 */
export function WritingOut({ fileId, onText, onClose }: { fileId: string; onText: (text: string) => void; onClose: () => void }) {
  const [run] = useState(() => new TranscriptRun(() => fetchClipBlob(fileId)));
  const s = useSyncExternalStore(run.subscribe, run.getState);

  useEffect(() => {
    run.start();
    return () => run.cancel();
  }, [run]);

  // the row hands new functions on every draw; the words are handed over once
  const handlers = useRef({ onText, onClose });
  handlers.current = { onText, onClose };
  const text = s.phase === 'ready' ? s.text : null;
  useEffect(() => {
    if (text === null || text === '') return;
    handlers.current.onText(text);
    handlers.current.onClose();
  }, [text]);

  const failed = s.phase === 'none' ? s.notice : text === '' ? NOTHING_HEARD : null;
  return (
    <div className="vr-adding" data-testid="voice-adding">
      <span className="sr-only" role="status" aria-live="polite">{s.phase === 'working' ? WRITING_TEXT : ''}</span>
      {s.phase === 'working' ? (
        <>
          <p className="vr-note" aria-hidden="true" data-testid="voice-adding-progress">{progressLine(s.stage, s.fraction)}</p>
          {showsFirstUseNote(s) ? <p className="vr-note">{FIRST_USE_NOTE}</p> : null}
        </>
      ) : null}
      {failed ? <p className="vr-note bad" role="alert" data-testid="voice-adding-failed">{failed}</p> : null}
      <button type="button" className="btn s" onClick={onClose}>{failed ? 'Dismiss' : 'Cancel'}</button>
    </div>
  );
}

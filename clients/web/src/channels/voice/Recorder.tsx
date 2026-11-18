import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import { CloseIcon, MicIcon, PauseIcon, SendIcon, TrashIcon } from '../../shell/icons';
import { TAIL_BARS, type RecordedClip } from './capture';
import { LIMIT_NOTE, formatClock } from './clock';
import { liveBars } from './liveWave';
import { useMeter, type Recorder as RecorderState } from './useRecorder';

/**
 * The voice message recorder in the composer (P14-17, reshaped in P32-05): the mic button (hold to record, or tap to start), and, while recording, one rounded
 * bar that takes the place of the text row: a trash button, a red dot and the time, a live waveform, a pause / resume button and a round green send button.
 * Send hands the clip over to be uploaded and posted at once; there is no preview and the device writes no words (the server does, decision D13).
 */

/** A hold shorter than this is a tap: the recording goes on until Send or Delete. */
export const HOLD_MS = 450;
/** Sliding the pointer further left than this while held cancels the recording. */
export const CANCEL_DRAG_PX = 80;
/** Bars of the waveform when it does not scroll (reduced motion). */
const STILL_BARS = 48;

type RecorderProps = {
  rec: RecorderState;
  /** The mic button is offered only while the text box is empty. */
  showMic: boolean;
  /** The recording ended with Send (or the release of a hold): upload it and post it. */
  onSendClip: (clip: RecordedClip) => void;
  /** Put the cursor back in the text box (after Send or Delete). */
  returnFocus: () => void;
};

const reducedMotion = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function subscribeMotion(cb: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const q = window.matchMedia('(prefers-reduced-motion: reduce)');
  q.addEventListener?.('change', cb);
  return () => q.removeEventListener?.('change', cb);
}

export function Recorder({ rec, showMic, onSendClip, returnFocus }: RecorderProps) {
  const phase = rec.state.phase;
  const [holding, setHolding] = useState(false);
  const [willCancel, setWillCancel] = useState(false);
  const willCancelRef = useRef(false);
  const press = useRef<{ x: number; at: number } | null>(null);
  const setCancelling = (v: boolean): void => {
    willCancelRef.current = v;
    setWillCancel(v);
  };

  const { cancel } = rec; // stable, unlike `rec` itself
  // Esc deletes the recording and puts the cursor back in the text box. Captured first so it does not also close a panel behind.
  useEffect(() => {
    if (phase !== 'recording') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // Esc inside another dialog, menu or list (opened while the recording waits) belongs to that one: a recording is not thrown away by it
      if (e.target instanceof Element && e.target.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],[role="listbox"],[role="combobox"]')) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
      setHolding(false);
      setCancelling(false);
      returnFocus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase, cancel, returnFocus]);

  /** Ends the recording and sends it (Send, or the release of a hold). */
  const sendNow = (): void => {
    void rec.take().then((clip) => {
      if (clip) {
        onSendClip(clip);
        returnFocus();
      }
    });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer that is already gone */
    }
    if (phase === 'recording' || phase === 'asking') return;
    press.current = { x: e.clientX, at: performance.now() };
    setHolding(true);
    setCancelling(false);
    rec.start();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const p = press.current;
    if (!p) return;
    const left = e.clientX - p.x < -CANCEL_DRAG_PX;
    if (left !== willCancelRef.current) setCancelling(left);
  };
  const onPointerUp = (): void => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    setHolding(false);
    if (willCancelRef.current) {
      setCancelling(false);
      rec.cancel();
      return;
    }
    if (performance.now() - p.at < HOLD_MS) return; // a tap: the recording goes on until Send or Delete
    if (phase === 'asking') rec.releaseWhileAsking();
    else sendNow();
  };
  const onPointerCancel = (): void => {
    const p = press.current;
    press.current = null;
    setHolding(false);
    setCancelling(false);
    if (p) rec.cancel();
  };
  // Space or Enter on the focused button (a click with no pointer, `detail` 0) starts a recording; a pointer press is handled above.
  const onClick = (e: { detail: number }): void => {
    if (e.detail !== 0) return;
    if (phase === 'idle' || phase === 'error') rec.start();
  };

  const recording = phase === 'recording';
  // the button stays mounted for a whole press (an unmounted element drops the pointer capture and the release never arrives); a recording that is
  // not being held has its own controls, so the button is then hidden
  const micShown = showMic || recording || phase === 'asking';
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="voice-live">
        {rec.announcement}
      </span>
      {recording ? <RecordingBar rec={rec} holding={holding} willCancel={willCancel} onSend={sendNow} onDelete={() => { rec.cancel(); returnFocus(); }} /> : null}
      {micShown ? (
        <button
          type="button"
          className={`icon-btn vr-mic ${recording || phase === 'asking' ? 'on' : ''}`}
          aria-label="Record a voice message"
          aria-pressed={recording}
          title="Hold to record, or tap to start"
          data-testid="voice-mic"
          hidden={recording && !holding}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onContextMenu={(e) => e.preventDefault()}
          onClick={onClick}
        >
          <MicIcon />
        </button>
      ) : null}
    </>
  );
}

/** The sentence for a failed microphone or a clip that was too short, above the box. */
export function RecorderNotice({ rec }: { rec: RecorderState }) {
  if (rec.state.phase !== 'error') return null;
  return (
    <p className="cnotice bad vr-notice" role="alert" data-testid="voice-error">
      <span>{rec.state.message}</span>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => rec.discard()}><CloseIcon /></button>
    </p>
  );
}

/** The live waveform: the newest readings, scrolling left (or, under reduced motion, filling fixed places). */
export function LiveWave({ rec }: { rec: RecorderState }) {
  const m = useMeter(rec.meter);
  const still = useSyncExternalStore(subscribeMotion, reducedMotion, () => false);
  const bars = liveBars(m.tail, m.total, still ? STILL_BARS : TAIL_BARS, !still);
  return (
    <span className={`vr-live ${still ? 'still' : ''}`} aria-hidden="true" data-testid="voice-wave">
      {bars.map((h, i) => (
        <span key={i} className="vr-lb" style={{ height: `${Math.round(h * 100)}%` }} />
      ))}
    </span>
  );
}

function RecordingBar({ rec, holding, willCancel, onSend, onDelete }: { rec: RecorderState; holding: boolean; willCancel: boolean; onSend: () => void; onDelete: () => void }) {
  const { elapsedMs } = useMeter(rec.meter);
  const s = rec.state.phase === 'recording' ? rec.state : null;
  const paused = s?.paused ?? false;
  const limited = s?.limited ?? false;
  const lost = s?.lost ?? false;
  const pauseButton = useRef<HTMLButtonElement>(null);
  // when the bar's own controls appear (a tap, or the key that started it) the keyboard lands on Pause: harmless to press by mistake
  const fresh = useRef(true);
  useEffect(() => {
    if (!holding && fresh.current) {
      fresh.current = false;
      pauseButton.current?.focus();
    }
  }, [holding]);
  const hint = willCancel ? 'Release to cancel' : 'Slide left to cancel';
  return (
    <div className={`vr-bar ${paused ? 'paused' : ''} ${willCancel ? 'cancelling' : ''} ${holding ? 'holding' : ''}`} role="group" aria-label="Recording a voice message" aria-describedby="vr-about" data-testid="voice-recording" data-state={paused ? 'paused' : 'recording'}>
      <span id="vr-about" className="sr-only">Your voice message is sent as soon as you press Send. This server may write a transcript of its first 20 seconds.</span>
      {holding ? null : (
        <button type="button" className="icon-btn vr-trash" aria-label="Delete recording" title="Delete recording (Esc)" onClick={onDelete} data-testid="voice-delete">
          <TrashIcon />
        </button>
      )}
      <span className="vr-dot" aria-hidden="true" />
      <span className="vr-time" aria-hidden="true" data-testid="voice-timer">{formatClock(elapsedMs)}</span>
      <LiveWave rec={rec} />
      {holding ? (
        <span className="vr-hint" data-testid="voice-hint">{hint}</span>
      ) : (
        <>
          {lost ? null : (
            <button
              ref={pauseButton}
              type="button"
              className="vr-round vr-pause"
              aria-label={paused ? 'Resume recording' : 'Pause recording'}
              title={paused ? 'Resume recording' : 'Pause recording'}
              disabled={limited}
              onClick={() => (paused ? rec.resume() : rec.pause())}
              data-testid="voice-pause"
            >
              {paused ? <MicIcon /> : <PauseIcon />}
            </button>
          )}
          <button type="button" className="vr-round vr-send" aria-label="Send voice message" title="Send voice message" onClick={onSend} data-testid="voice-send">
            <SendIcon />
          </button>
        </>
      )}
      {limited ? <span className="vr-limit" role="note" data-testid="voice-limit">{LIMIT_NOTE}</span> : null}
    </div>
  );
}

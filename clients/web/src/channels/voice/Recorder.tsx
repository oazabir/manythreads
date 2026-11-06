import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { FileSummary, VoiceMeta } from '@manythreads/shared';
import { isApiError } from '../../api/client';
import { uploadChannelFile } from '../../api/endpoints';
import { CloseIcon, MicIcon, PauseIcon, PlayIcon, StopIcon, TrashIcon } from '../../shell/icons';
import type { RecordedClip } from './capture';
import { LIMIT_NOTE, clockOfMax, formatClock } from './clock';
import { buildVoiceSend } from './send';
import { clipFileName } from './support';
import { useMeter, type Recorder as RecorderState } from './useRecorder';

/**
 * The voice message recorder in the composer (P14-17): the mic button (hold to record, or tap to start and tap to stop), the recording bar
 * (timer, level meter, how to cancel) and the preview (play it, Discard, Send). The words of the message (the transcript) come later
 * (F9-7); this sends the clip with the stand-in line, see `send.ts`.
 */

/** A hold shorter than this is a tap: the recording goes on until the next tap. */
export const HOLD_MS = 450;
/** Sliding the pointer further left than this while held cancels the recording. */
export const CANCEL_DRAG_PX = 80;

type SendOptions = { attachments: FileSummary[]; voice: VoiceMeta };

type RecorderProps = {
  rec: RecorderState;
  channelId: string;
  /** The mic button is offered only while the text box is empty. */
  showMic: boolean;
  onSend: (body: string, options: SendOptions) => void;
  /** Put the cursor back in the text box (after Send or Discard). */
  returnFocus: () => void;
};

export function Recorder({ rec, channelId, showMic, onSend, returnFocus }: RecorderProps) {
  const phase = rec.state.phase;
  const [holding, setHolding] = useState(false);
  const [willCancel, setWillCancel] = useState(false);
  const willCancelRef = useRef(false);
  const press = useRef<{ x: number; at: number; wasRecording: boolean } | null>(null);
  const setCancelling = (v: boolean): void => {
    willCancelRef.current = v;
    setWillCancel(v);
  };

  const { cancel, discard } = rec; // stable, unlike `rec` itself
  // Esc throws the recording away (or the clip in the preview). Captured first so it does not also close a panel behind.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'preview') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (phase === 'recording') {
        cancel();
        setHolding(false);
        setCancelling(false);
      } else {
        discard('Voice message discarded');
        returnFocus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase, cancel, discard, returnFocus]);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* a pointer that is already gone */
    }
    press.current = { x: e.clientX, at: performance.now(), wasRecording: phase === 'recording' };
    if (phase === 'recording' || phase === 'asking') return;
    setHolding(true);
    setCancelling(false);
    rec.start();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const p = press.current;
    if (!p || p.wasRecording) return;
    const left = e.clientX - p.x < -CANCEL_DRAG_PX;
    if (left !== willCancelRef.current) setCancelling(left);
  };
  const onPointerUp = (): void => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    setHolding(false);
    if (p.wasRecording) {
      rec.stop(); // a tap while recording stops it
      return;
    }
    if (willCancelRef.current) {
      setCancelling(false);
      rec.cancel();
      return;
    }
    if (performance.now() - p.at < HOLD_MS) return; // a tap: the recording goes on until the next tap
    if (phase === 'asking') rec.releaseWhileAsking();
    else rec.stop();
  };
  const onPointerCancel = (): void => {
    const p = press.current;
    press.current = null;
    setHolding(false);
    setCancelling(false);
    if (p && !p.wasRecording) rec.cancel();
  };
  // Space or Enter on the focused button (a click with no pointer, `detail` 0) toggles; a pointer press is handled above.
  const onClick = (e: { detail: number }): void => {
    if (e.detail !== 0) return;
    if (phase === 'recording') rec.stop();
    else if (phase === 'idle' || phase === 'error') rec.start();
  };

  const recording = phase === 'recording';
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="voice-live">
        {rec.announcement}
      </span>
      {recording ? <RecordingBar rec={rec} holding={holding} willCancel={willCancel} /> : null}
      {rec.state.phase === 'preview' ? (
        <Preview clip={rec.state.clip} channelId={channelId} onSend={onSend} onDiscard={() => { rec.discard('Voice message discarded'); returnFocus(); }} onSent={() => { rec.discard('Voice message sent'); returnFocus(); }} />
      ) : null}
      {showMic && phase !== 'preview' ? (
        <button
          type="button"
          className={`icon-btn vr-mic ${recording || phase === 'asking' ? 'on' : ''}`}
          aria-label="Record a voice message"
          aria-pressed={recording}
          title="Hold to record, or tap to start and stop"
          data-testid="voice-mic"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onContextMenu={(e) => e.preventDefault()}
          onClick={onClick}
        >
          {recording ? <StopIcon filled /> : <MicIcon />}
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

function RecordingBar({ rec, holding, willCancel }: { rec: RecorderState; holding: boolean; willCancel: boolean }) {
  const { elapsedMs, level } = useMeter(rec.meter);
  return (
    <div className={`vr-bar ${willCancel ? 'cancelling' : ''}`} data-testid="voice-recording">
      <span className="vr-dot" aria-hidden="true" />
      <span className="vr-word">{willCancel ? 'Release to cancel' : holding ? 'Recording · slide left to cancel' : 'Recording'}</span>
      <span className="vr-time" aria-hidden="true" data-testid="voice-timer">{clockOfMax(elapsedMs)}</span>
      <span className="vr-meter" aria-hidden="true"><span className="vr-fill" style={{ transform: `scaleX(${Math.max(0.04, level).toFixed(2)})` }} /></span>
      {holding ? null : <button type="button" className="btn s vr-cancel" onClick={() => rec.cancel()}>Cancel</button>}
    </div>
  );
}

function Preview({ clip, channelId, onSend, onDiscard, onSent }: { clip: RecordedClip; channelId: string; onSend: RecorderProps['onSend']; onDiscard: () => void; onSent: () => void }) {
  const audio = useRef<HTMLAudioElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    playButton.current?.focus();
    return () => abort.current?.abort();
  }, []);

  const toggle = (): void => {
    const a = audio.current;
    if (!a) return;
    if (playing) a.pause();
    else void a.play().catch(() => setPlaying(false));
  };

  const send = async (): Promise<void> => {
    if (busy) return;
    audio.current?.pause();
    setBusy(true);
    setError(null);
    setProgress(0);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const file = new File([clip.blob], clipFileName(clip.mime), { type: clip.mime });
      const meta = await uploadChannelFile(channelId, file, setProgress, ctl.signal);
      if (ctl.signal.aborted) return;
      const built = buildVoiceSend({ fileId: meta.id, durationMs: clip.durationMs, peaks: clip.peaks });
      onSend(built.body, { attachments: [{ id: meta.id, name: meta.name, size: meta.size, mime: meta.mime }], voice: built.voice });
      onSent();
    } catch (e) {
      if (ctl.signal.aborted) return;
      setError(isApiError(e) && e.status === 413 ? 'This recording is too large to send.' : "The voice message was not sent. Check the connection and try again.");
      setBusy(false);
    }
  };

  const total = clip.durationMs;
  const played = total > 0 ? Math.min(1, positionMs / total) : 0;
  return (
    <div className="vr-preview" role="group" aria-label="Voice message ready to send" data-testid="voice-preview">
      <audio
        ref={audio}
        src={clip.url}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setPositionMs(0); }}
        onTimeUpdate={(e) => setPositionMs(e.currentTarget.currentTime * 1000)}
      />
      <button ref={playButton} type="button" className="icon-btn vr-play" aria-label={playing ? 'Pause your recording' : 'Play your recording'} onClick={toggle} data-testid="voice-play">
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <span className="vr-wave" aria-hidden="true">
        {(clip.peaks.length > 0 ? clip.peaks : [8]).map((p, i, all) => (
          <span key={i} className={`vr-b ${i / all.length < played ? 'played' : ''}`} style={{ height: `${Math.max(12, Math.round((p / 255) * 100))}%` }} />
        ))}
      </span>
      <span className="vr-time" data-testid="voice-length">{`${formatClock(positionMs)} / ${formatClock(total)}`}</span>
      {clip.limited ? <p className="vr-note">{LIMIT_NOTE}</p> : null}
      {busy ? <p className="vr-note" role="status">{`Sending… ${Math.round(progress * 100)}%`}</p> : null}
      {error ? <p className="vr-note bad" role="alert" data-testid="voice-send-error">{error}</p> : null}
      {/* F9-7: the transcript (written on this device, editable) goes here, above the buttons */}
      <span className="vr-actions">
        <button type="button" className="btn s" onClick={onDiscard} data-testid="voice-discard"><TrashIcon /><span>Discard</span></button>
        <button type="button" className="btn primary s" onClick={() => void send()} disabled={busy} data-testid="voice-send">Send</button>
      </span>
    </div>
  );
}

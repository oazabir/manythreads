import { useMemo, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { PauseIcon, PlayIcon, SoundwaveIcon } from '@proicons/react';
import type { VoiceMeta } from '@manythreads/shared';
import { proIcon } from '../../components/proicon';
import { isApiError } from '../../api/client';
import { channelStore } from '../store';
import { BAR_COUNT, barHeights, formatClock, playedBars, positionAt, rangeLabel, seekForKey, speedAria, speedLabel, transcriptNote, transcriptShows, valueText } from './playerFormat';
import { isPlayed, markPlayed, subscribePlayed } from './played';
import { usePlayback } from './usePlayback';

/*
 * The voice message a row draws (P14-17, flattened in P32-10): no card. One compact row (play and pause, a waveform with a dot at the play position that
 * is also the seek bar, the length, a small dot that is filled until this reader has played the message, and a speed button as plain text), and under it
 * the transcript the server writes as the message's ordinary text with one small muted caption after it (decision D13).
 * Everything works from the keyboard (Space or Enter plays, the arrows move by five seconds, Home and End jump) and nothing needs a hover.
 * The clip is fetched on the first press, not when the row is drawn. See `usePlayback.ts` for how it plays.
 */

const Play = proIcon(PlayIcon, 18);
const Pause = proIcon(PauseIcon, 18);
const Wave = proIcon(SoundwaveIcon, 14);

/** In a search result: the words and length of a voice message that has no transcript. */
export function VoiceHitLabel({ length }: { length: string }) {
  return (
    <span className="vp-hit" data-testid="voice-hit">
      <Wave />
      <span>{`Voice message · ${length}`}</span>
    </span>
  );
}

export function VoicePlayer({ voice, who, messageId }: { voice: VoiceMeta; who?: string; messageId?: string }) {
  const p = usePlayback(voice.fileId, voice.durationMs);
  const heights = useMemo(() => barHeights(voice.peaks, BAR_COUNT), [voice.peaks]);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const played = playedBars(p.positionMs, voice.durationMs);
  const name = who ? `Voice message from ${who}` : 'Voice message';
  const fraction = voice.durationMs > 0 ? Math.min(1, Math.max(0, p.positionMs / voice.durationMs)) : 0;
  // the dot after the length is filled until this reader plays the message
  const heard = useSyncExternalStore(subscribePlayed, () => (messageId ? isPlayed(messageId) : false), () => false);
  useEffect(() => {
    if (p.playing && messageId) markPlayed(messageId);
  }, [p.playing, messageId]);

  const seekFromPointer = (e: PointerEvent<HTMLDivElement>): void => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    p.seek(positionAt((e.clientX - box.left) / box.width, voice.durationMs));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      p.toggle();
      return;
    }
    const at = seekForKey(e.key, p.positionMs, voice.durationMs);
    if (at === null) return;
    e.preventDefault();
    e.stopPropagation();
    p.seek(at);
  };
  const started = p.playing || p.positionMs > 0;

  return (
    <div className="vp" role="group" aria-label={`${name}, ${formatClock(voice.durationMs)}`} data-testid="voice-player" data-state={p.playing ? 'playing' : p.status}>
      <button
        type="button"
        className="vp-play"
        aria-label={p.playing ? 'Pause voice message' : 'Play voice message'}
        aria-busy={p.status === 'loading'}
        onClick={p.toggle}
        data-testid="voice-play"
      >
        {p.playing ? <Pause /> : <Play />}
      </button>
      <div
        ref={track}
        className="vp-wave"
        role="slider"
        tabIndex={0}
        aria-label="Position in the voice message"
        aria-valuemin={0}
        aria-valuemax={Math.round(voice.durationMs / 1000)}
        aria-valuenow={Math.round(p.positionMs / 1000)}
        aria-valuetext={valueText(p.positionMs, voice.durationMs)}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          seekFromPointer(e);
        }}
        onPointerMove={(e) => dragging.current && seekFromPointer(e)}
        onPointerUp={() => void (dragging.current = false)}
        onPointerCancel={() => void (dragging.current = false)}
        data-testid="voice-seek"
      >
        {heights.map((h, i) => (
          <span key={i} className={`vp-bar ${i < played ? 'on' : ''}`} style={{ height: `${Math.round(h * 100)}%` }} />
        ))}
        <span className="vp-dot" aria-hidden="true" style={{ left: `${(fraction * 100).toFixed(2)}%` }} data-testid="voice-dot" />
      </div>
      <span className="vp-time" aria-hidden="true" data-testid="voice-time">
        {formatClock(started ? p.positionMs : voice.durationMs)}
      </span>
      {/* a small dot after the length: filled until this reader has played the message, an empty ring after */}
      <span className={`vp-heard ${heard ? 'heard' : ''}`} role="img" aria-label={heard ? 'played' : 'not played yet'} data-testid="voice-badge" />
      <button type="button" className="vp-speed" aria-label={speedAria(p.speed)} onClick={p.cycleSpeed} data-testid="voice-speed">
        {speedLabel(p.speed)}
      </button>
      {p.status === 'error' ? (
        <p className="vp-error" role="alert">
          This voice message could not be played. Press play to try again.
        </p>
      ) : null}
    </div>
  );
}

/** The state of the server's transcript under the player, as the reader sees it. */
export function VoiceTranscript({ voice, body, own, channelId, rootId, messageId }: { voice: VoiceMeta; body: ReactNode; own: boolean; channelId: string; rootId: string | null; messageId: string }) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // an answer to "Try again" turns the state to `pending` and back: the error of the last ask goes with it
  useEffect(() => {
    if (voice.transcript !== 'failed') setError(null);
  }, [voice.transcript]);
  // after "Try again" the button is gone; the keyboard goes to the words that say the transcript is being written
  const waiting = useRef<HTMLParagraphElement>(null);
  const wantFocus = useRef(false);
  useEffect(() => {
    if (voice.transcript === 'pending' && wantFocus.current) {
      wantFocus.current = false;
      waiting.current?.focus();
    }
  }, [voice.transcript]);
  const tryAgain = async (): Promise<void> => {
    if (asking) return;
    setAsking(true);
    setError(null);
    wantFocus.current = true;
    try {
      await channelStore.retryTranscript(channelId, rootId, messageId);
    } catch (e) {
      wantFocus.current = false;
      setError(isApiError(e) && e.message ? e.message : 'Could not ask again. Try again in a moment.');
    } finally {
      setAsking(false);
    }
  };

  switch (voice.transcript) {
    case 'pending':
      return (
        <div className="vt" data-testid="voice-transcript" data-state="pending">
          <p ref={waiting} tabIndex={-1} className="vt-line vt-wait" {...(own ? { role: 'status', 'aria-live': 'polite' as const } : {})} data-testid="voice-writing">
            <span className="vt-spin" aria-hidden="true" />
            <span>Writing the transcript…</span>
          </p>
        </div>
      );
    case 'server':
    case 'edited': {
      const shows = transcriptShows(voice);
      const first = voice.transcript === 'server' && shows.longer;
      return (
        <div className="vt" data-testid="voice-transcript" data-state={voice.transcript}>
          <div className="vt-body">{body}</div>
          {/* the one small caption after the words: what they are, and (a long clip) how much of the clip they cover */}
          <p className="vt-cap" data-testid="voice-transcript-heading" title={`Transcript · ${rangeLabel(voice)}`}>
            {voice.transcript === 'edited' ? 'Transcript (edited)' : 'Transcript'}
            {first ? <span data-testid="voice-first-seconds">{` of the first ${shows.seconds} seconds`}</span> : null}
          </p>
        </div>
      );
    }
    case 'failed':
      return (
        <div className="vt" data-testid="voice-transcript" data-state="failed">
          <p className="vt-line">
            <span data-testid="voice-no-transcript">No transcript.</span>
            {voice.transcriptNote ? <>{' '}<span data-testid="voice-fail-note">{voice.transcriptNote}</span></> : null}
            {own && voice.transcriptRetry === true ? (
              <>
                {' '}
                <button type="button" className="link-btn vt-retry" disabled={asking} onClick={() => void tryAgain()} data-testid="voice-try-again">Try again</button>
              </>
            ) : null}
          </p>
          {error ? <p className="vt-line bad" role="alert" data-testid="voice-retry-error">{error}</p> : null}
        </div>
      );
    case 'none':
      return (
        <div className="vt" data-testid="voice-transcript" data-state="none">
          <p className="vt-line" data-testid="voice-no-transcript">No transcript</p>
        </div>
      );
    default:
      // `device`: written on the sender's device (old messages)
      return (
        <div className="vt" data-testid="voice-transcript" data-state="device">
          <div className="vt-body">{body}</div>
          <VoiceTranscriptNote voice={voice} />
        </div>
      );
  }
}

/** The quiet line under a transcript that says where the words came from (written on the sender's device, an old message). */
export function VoiceTranscriptNote({ voice }: { voice: VoiceMeta }) {
  const note = transcriptNote(voice);
  return note ? (
    <p className="vt-cap" data-testid="voice-note">
      {note}
    </p>
  ) : null;
}

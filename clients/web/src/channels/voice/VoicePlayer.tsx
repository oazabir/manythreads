import { useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { PauseIcon, PlayIcon, SoundwaveIcon } from '@proicons/react';
import type { VoiceMeta } from '@manythreads/shared';
import { proIcon } from '../../components/proicon';
import { BAR_COUNT, barHeights, formatClock, playedBars, positionAt, seekForKey, speedAria, speedLabel, transcriptNote, valueText } from './playerFormat';
import { usePlayback } from './usePlayback';

/*
 * The player a voice message draws in its row (P14-17): play and pause, a waveform that is also the seek bar, the time, and a speed button.
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

export function VoicePlayer({ voice, who }: { voice: VoiceMeta; who?: string }) {
  const p = usePlayback(voice.fileId, voice.durationMs);
  const heights = useMemo(() => barHeights(voice.peaks, BAR_COUNT), [voice.peaks]);
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const played = playedBars(p.positionMs, voice.durationMs);
  const name = who ? `Voice message from ${who}` : 'Voice message';

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
      </div>
      <span className="vp-time" aria-hidden="true" data-testid="voice-time">
        {p.status === 'loading' ? 'Loading…' : `${formatClock(p.positionMs)} / ${formatClock(voice.durationMs)}`}
      </span>
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

/** What stands under the player: the transcript is the message's own text, so only the two quiet lines are drawn here. */
export function VoiceNoTranscript() {
  return (
    <p className="vp-none" data-testid="voice-no-transcript">
      No transcript
    </p>
  );
}

/** The quiet line under a transcript that says where the words came from (written on the sender's device, or corrected by hand). */
export function VoiceTranscriptNote({ voice }: { voice: VoiceMeta }) {
  const note = transcriptNote(voice);
  return note ? (
    <p className="vp-note" data-testid="voice-note">
      {note}
    </p>
  ) : null;
}

import { CancelIcon, PauseIcon, PlayIcon } from '@proicons/react';
import { proIcon } from '../../components/proicon';
import { formatClock } from './playerFormat';
import { dismissAutoplay, useAutoplayCurrent } from './autoplay';
import { usePlayback } from './usePlayback';

/*
 * The small player in the top right corner while an incoming voice message plays by itself (owner 2026-11-23): who is speaking, the time, Pause and Play
 * with one press, how many more are waiting, and a close button that lets the clip end and plays nothing more. It is drawn once, by the shell, and only
 * while an autoplayed message is playing or paused.
 */

const Play = proIcon(PlayIcon, 16);
const Pause = proIcon(PauseIcon, 16);
const Close = proIcon(CancelIcon, 14);

export function AutoplayMini() {
  const clip = useAutoplayCurrent();
  if (!clip) return null;
  return <Mini key={clip.messageId} clip={clip} />;
}

function Mini({ clip }: { clip: NonNullable<ReturnType<typeof useAutoplayCurrent>> }) {
  const p = usePlayback(clip.fileId, clip.durationMs);
  return (
    <div className="vpm" role="region" aria-label="Voice message playing" data-testid="voice-autoplay-mini" data-state={p.playing ? 'playing' : 'paused'}>
      <button type="button" className="vpm-play" onClick={p.toggle} aria-label={p.playing ? `Pause the voice message from ${clip.who}` : `Play the voice message from ${clip.who}`} data-testid="voice-autoplay-toggle">
        {p.playing ? <Pause /> : <Play />}
      </button>
      <span className="vpm-text">
        <span className="vpm-who">{clip.who}</span>
        <span className="vpm-time" aria-hidden="true">
          {formatClock(p.positionMs)} / {formatClock(clip.durationMs)}
          {clip.waiting > 0 ? ` · ${clip.waiting} more` : ''}
        </span>
      </span>
      <button type="button" className="vpm-close" onClick={dismissAutoplay} aria-label="Close the player; nothing more plays" data-testid="voice-autoplay-close">
        <Close />
      </button>
    </div>
  );
}

import { useMemo } from 'react';
import { PlayIcon } from '@proicons/react';
import { proIcon } from '../../components/proicon';
import { BAR_COUNT, barHeights, formatClock } from './playerFormat';

const Play = proIcon(PlayIcon, 18);

/**
 * A voice message that is still on this device (P32-05): the row drawn while the clip uploads and the message posts, and after a failed upload. It is the
 * finished message's own row (P32-10): the waveform and the length, but nothing plays yet and the words are not there. "Sending…" or the failed line is
 * drawn by the row around it.
 */
export function PendingVoice({ durationMs, peaks }: { durationMs: number; peaks: readonly number[] }) {
  const heights = useMemo(() => barHeights(peaks, BAR_COUNT), [peaks]);
  return (
    <div className="vm" data-testid="voice-pending">
      <div className="vp vp-idle" role="group" aria-label={`Voice message, ${formatClock(durationMs)}`}>
        <span className="vp-play" aria-hidden="true"><Play /></span>
        <div className="vp-wave" aria-hidden="true">
          {heights.map((h, i) => (
            <span key={i} className="vp-bar" style={{ height: `${Math.round(h * 100)}%` }} />
          ))}
        </div>
        <span className="vp-time" data-testid="voice-pending-length">{formatClock(durationMs)}</span>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { MeetingParticipant } from '@manythreads/shared';
import { callController } from './store';
import type { CallState } from './controller';
import type { VideoTile } from './media';
import { MaximizeIcon, MinimizeIcon } from './icons';

/*
 * The call's stage (P35-08): the shared screen large, the cameras as small tiles beside it, above the call bar. It shows only while somebody has a camera
 * or a screen on. "Full size" fills the window (for a demo or pairing on code); Esc or the same button brings it back. Hiding it keeps the call as it is.
 */

const nameOf = (present: readonly MeetingParticipant[], tile: VideoTile): string =>
  tile.local ? 'You' : (present.find((p) => p.actorId === tile.actorId)?.displayName ?? 'Someone');

function Tile({ tile, label, big }: { tile: VideoTile; label: string; big: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return callController().attachVideo(tile.key, el);
  }, [tile.key]);
  return (
    <figure className={`stage-tile ${big ? 'big' : ''} ${tile.source}`} data-testid="stage-tile" data-source={tile.source} data-local={tile.local || undefined}>
      {/* a person's own camera is shown mirrored, as a mirror would; a screen never is. Their own sound is never played back to them. */}
      <video ref={ref} autoPlay playsInline muted className={tile.local && tile.source === 'camera' ? 'mirror' : undefined} />
      <figcaption>{tile.source === 'screen' ? `${label} ${label === 'You' ? 'are' : 'is'} sharing` : label}</figcaption>
    </figure>
  );
}

export function CallStage({ call }: { call: CallState }) {
  const [full, setFull] = useState(false);
  const [hidden, setHidden] = useState(false);
  const videos = call.videos;
  const screen = videos.find((v) => v.source === 'screen') ?? null;
  const cameras = videos.filter((v) => v.source === 'camera');
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);
  // a new screen shows the stage again, even if it was hidden for the cameras
  useEffect(() => {
    if (screen) setHidden(false);
  }, [screen?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (videos.length === 0) return null;
  if (hidden) {
    return (
      <button type="button" className="btn s stage-show" onClick={() => setHidden(false)} data-testid="stage-show">
        Show video ({videos.length})
      </button>
    );
  }
  return (
    <section className={`call-stage ${full ? 'full' : ''} ${screen ? 'has-screen' : ''}`} aria-label="Video" data-testid="call-stage">
      <header className="stage-bar">
        <span className="stage-title">{screen ? `${nameOf(call.present, screen)} ${screen.local ? 'are' : 'is'} sharing a screen` : 'Cameras'}</span>
        <button type="button" className="icon-btn" aria-label={full ? 'Back to the small stage' : 'Full size'} title={full ? 'Back (Esc)' : 'Full size'} onClick={() => setFull((f) => !f)} data-testid="stage-full">
          {full ? <MinimizeIcon /> : <MaximizeIcon />}
        </button>
        <button type="button" className="btn s" onClick={() => { setFull(false); setHidden(true); }} data-testid="stage-hide">
          Hide
        </button>
      </header>
      <div className="stage-body">
        {screen ? <Tile tile={screen} label={nameOf(call.present, screen)} big /> : null}
        {cameras.length > 0 ? (
          <div className={`stage-cams ${screen ? 'side' : 'grid'}`}>
            {cameras.map((t) => (
              <Tile key={t.key} tile={t} label={nameOf(call.present, t)} big={false} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

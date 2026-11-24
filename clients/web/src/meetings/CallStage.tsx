import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { MeetingParticipant } from '@manythreads/shared';
import { useNarrow } from '../shell/useNarrow';
import { callController } from './store';
import type { CallState } from './controller';
import type { VideoTile } from './media';
import type { StageLayout } from './prefs';
import { NO_SPEECH, arrangeStage, focusTile, gridColumns, layoutFor, pipDecision, stickySlots, trackSpeech, type SpeechTrack } from './layout';
import { GridIcon, MaximizeIcon, MinimizeIcon, PinIcon, PinOffIcon, PipIcon, SpeakerIcon } from './icons';

/*
 * The call's stage (P35-08, P17-01), above the call bar while somebody has a camera or a screen on. Two layouts the person picks, kept with the call prefs:
 * Grid, equal tiles; Speaker, one large tile (the pinned one, a shared screen, or whoever speaks) and a strip of the others. Both are one list of tiles that CSS
 * places, so a tile keeps its video when the layout or the large tile changes. At most 16 video tiles, in sticky places (layout.ts), the rest one "+N" tile.
 * A tile can be pinned. When the tab is left, another person's video (the large one when it is theirs) goes into the browser's picture-in-picture window, if
 * the browser can and the person has not turned it off, and comes back when the tab does. "Full size" fills the window (Esc or the same button brings it back);
 * hiding it keeps the call as it is.
 */

/** Whether this browser can put a video into a floating window. Never throws. */
export function pipSupported(): boolean {
  try {
    return typeof document !== 'undefined' && document.pictureInPictureEnabled === true && typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function';
  } catch {
    return false;
  }
}

const exitPip = (): void => {
  try {
    if (typeof document !== 'undefined' && document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
  } catch {
    /* nothing to leave */
  }
};

const nameOf = (present: readonly MeetingParticipant[], tile: VideoTile): string =>
  tile.local ? 'You' : (present.find((p) => p.actorId === tile.actorId)?.displayName ?? 'Someone');

type TileProps = {
  tile: VideoTile;
  label: string;
  big: boolean;
  speaking: boolean;
  pinned: boolean;
  onPin: () => void;
  onVideo: (key: string, el: HTMLVideoElement | null) => void;
};

function Tile({ tile, label, big, speaking, pinned, onPin, onVideo }: TileProps) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    onVideo(tile.key, el);
    const off = callController().attachVideo(tile.key, el);
    return () => {
      onVideo(tile.key, null);
      off();
    };
  }, [tile.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const caption = tile.source === 'screen' ? `${label} ${label === 'You' ? 'are' : 'is'} sharing` : label;
  const pinLabel = pinned ? `Unpin ${caption}` : `Pin ${caption}`;
  return (
    <figure
      className={`stage-tile ${big ? 'big' : ''} ${tile.source} ${speaking ? 'speaking' : ''} ${pinned ? 'pinned' : ''}`}
      data-testid="stage-tile"
      data-source={tile.source}
      data-local={tile.local || undefined}
      data-key={tile.key}
      data-big={big || undefined}
      data-pinned={pinned || undefined}
    >
      {/* a person's own camera is shown mirrored, as a mirror would; a screen never is. Their own sound is never played back to them. */}
      <video ref={ref} autoPlay playsInline muted className={tile.local && tile.source === 'camera' ? 'mirror' : undefined} />
      <figcaption>{caption}</figcaption>
      <button type="button" className="stage-pin" aria-pressed={pinned} aria-label={pinLabel} title={pinned ? 'Unpin' : 'Pin: keep this one large'} onClick={onPin} data-testid="stage-pin">
        {pinned ? <PinOffIcon /> : <PinIcon />}
      </button>
    </figure>
  );
}

function Overflow({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <figure className="stage-tile stage-more" data-testid="stage-overflow" title={names.join(', ')}>
      <span className="stage-more-n" aria-hidden="true">+{names.length}</span>
      <figcaption className="sr-only">{`${names.length} more with video: ${names.join(', ')}`}</figcaption>
    </figure>
  );
}

export function CallStage({ call }: { call: CallState }) {
  const narrow = useNarrow();
  const prefs = call.prefs;
  const layout = layoutFor(prefs, narrow);
  const [full, setFull] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);
  // a look again after a wait: a person who is not drawn has been speaking for 3 s by then
  const [, setTick] = useState(0);
  const videos = call.videos;
  const screen = videos.find((v) => v.source === 'screen') ?? null;

  // the other person heard last, with a camera on: the large tile stays with them when the room goes quiet
  useEffect(() => {
    const who = videos.find((v) => v.source === 'camera' && !v.local && call.speaking.has(v.actorId));
    if (who && who.actorId !== lastSpeaker) setLastSpeaker(who.actorId);
  }, [call.speaking, videos, lastSpeaker]);
  // a pinned tile that went away (the camera was turned off) is no pin
  useEffect(() => {
    if (pinned !== null && !videos.some((v) => v.key === pinned)) setPinned(null);
  }, [videos, pinned]);
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

  // ---- which tiles are drawn: sticky places (layout.ts) ----
  const speech = useRef<{ track: SpeechTrack; seen: ReadonlySet<string> | null }>({ track: NO_SPEECH, seen: null });
  const slots = useRef<string[]>([]);
  const now = Date.now();
  if (speech.current.seen !== call.speaking) speech.current = { track: trackSpeech(speech.current.track, call.speaking, now), seen: call.speaking };
  const livePin = pinned !== null && videos.some((v) => v.key === pinned) ? pinned : null;
  const focus = focusTile(videos, call.speaking, livePin, lastSpeaker);
  const sticky = stickySlots({
    videos,
    previous: slots.current,
    required: [livePin, focus?.key].filter((k): k is string => typeof k === 'string'),
    speaking: call.speaking,
    speech: speech.current.track,
    now,
  });
  slots.current = sticky.slots;
  const recheck = sticky.recheckInMs;
  useEffect(() => {
    if (recheck === null) return;
    const h = window.setTimeout(() => setTick((t) => t + 1), recheck + 50);
    return () => window.clearTimeout(h);
  }, [recheck, call.speaking]);
  const arranged = arrangeStage({ layout, videos, speaking: call.speaking, pinned: livePin, lastSpeaker, slots: sticky.slots });

  // ---- picture-in-picture when the tab is left ----
  const els = useRef(new Map<string, HTMLVideoElement>());
  const pipActive = useRef(false);
  const latest = useRef({ focus: arranged.focus, tiles: arranged.tiles, enabled: prefs.pip, shown: !hidden });
  latest.current = { focus: arranged.focus, tiles: arranged.tiles, enabled: prefs.pip, shown: !hidden };
  const enterPip = (key: string): void => {
    const el = els.current.get(key);
    if (!el) return;
    try {
      void el.requestPictureInPicture().then(
        () => {
          pipActive.current = true;
          el.addEventListener('leavepictureinpicture', () => { pipActive.current = false; }, { once: true });
        },
        () => undefined, // the browser may want a press on the page first: then there is simply no window
      );
    } catch {
      /* not offered by this browser */
    }
  };
  const pipNow = (hiddenTab: boolean) => {
    const { focus: f, tiles, enabled, shown } = latest.current;
    return pipDecision({ hidden: hiddenTab, supported: pipSupported() && shown, enabled, active: pipActive.current, focus: f, videos: tiles });
  };
  useEffect(() => {
    const decide = (): void => {
      const action = pipNow(document.visibilityState === 'hidden');
      if (action.kind === 'enter') enterPip(action.key);
      else if (action.kind === 'exit') {
        pipActive.current = false;
        exitPip();
      }
    };
    document.addEventListener('visibilitychange', decide);
    // browsers that open the floating window by themselves for a call (Chrome) ask the page through the media session
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    try {
      session?.setActionHandler('enterpictureinpicture' as MediaSessionAction, () => {
        const action = pipNow(true);
        if (action.kind === 'enter') enterPip(action.key);
      });
    } catch {
      /* this browser does not know the action */
    }
    return () => {
      document.removeEventListener('visibilitychange', decide);
      try {
        session?.setActionHandler('enterpictureinpicture' as MediaSessionAction, null);
      } catch {
        /* as above */
      }
      if (pipActive.current) {
        pipActive.current = false;
        exitPip();
      }
    };
  }, []);

  if (videos.length === 0) return null;
  if (hidden) {
    return (
      <button type="button" className="btn s stage-show" onClick={() => setHidden(false)} data-testid="stage-show">
        Show video ({videos.length})
      </button>
    );
  }
  const onVideo = (key: string, el: HTMLVideoElement | null): void => {
    if (el) els.current.set(key, el);
    else els.current.delete(key);
  };
  const overflowNames = arranged.overflow.map((t) => nameOf(call.present, t));
  const pick = (l: StageLayout): void => callController().setLayout(l);
  const manualPip = pipNow(true);
  const strip = arranged.tiles.length - (arranged.main ? 1 : 0) + (overflowNames.length > 0 ? 1 : 0);
  const cols = gridColumns(arranged.tiles.length + (overflowNames.length > 0 ? 1 : 0), narrow);
  const vars = { '--stage-cols': cols, '--stage-strip': Math.max(1, strip) } as CSSProperties;

  return (
    <section className={`call-stage ${full ? 'full' : ''} ${screen ? 'has-screen' : ''}`} aria-label="Video" data-testid="call-stage" data-layout={layout}>
      <header className="stage-bar">
        <span className="stage-title">{screen ? `${nameOf(call.present, screen)} ${screen.local ? 'are' : 'is'} sharing a screen` : 'Cameras'}</span>
        <div className="stage-layouts" role="group" aria-label="Layout">
          <button type="button" className="icon-btn" aria-pressed={layout === 'grid'} aria-label="Grid: everyone the same size" title="Grid" onClick={() => pick('grid')} data-testid="stage-layout-grid">
            <GridIcon />
          </button>
          <button type="button" className="icon-btn" aria-pressed={layout === 'speaker'} aria-label="Speaker: one person large" title="Speaker" onClick={() => pick('speaker')} data-testid="stage-layout-speaker">
            <SpeakerIcon />
          </button>
        </div>
        {manualPip.kind === 'enter' ? (
          <button type="button" className="icon-btn" aria-label="Picture in picture: a small window that stays on top" title="Picture in picture" onClick={() => enterPip(manualPip.key)} data-testid="stage-pip">
            <PipIcon />
          </button>
        ) : null}
        <button type="button" className="icon-btn" aria-label={full ? 'Back to the small stage' : 'Full size'} title={full ? 'Back (Esc)' : 'Full size'} onClick={() => setFull((f) => !f)} data-testid="stage-full">
          {full ? <MinimizeIcon /> : <MaximizeIcon />}
        </button>
        <button type="button" className="btn s" onClick={() => { setFull(false); setHidden(true); }} data-testid="stage-hide">
          Hide
        </button>
      </header>
      <div className="stage-body">
        {/* one list in both layouts, so a tile keeps its <video> (and a floating window) when the layout or the large tile changes; CSS places the large one */}
        <div className={`stage-tiles ${layout} ${cols >= 2 ? 'wide' : ''} ${strip === 0 ? 'solo' : ''}`} style={vars} data-testid="stage-tiles">
          {arranged.tiles.map((t) => (
            <Tile
              key={t.key}
              tile={t}
              label={nameOf(call.present, t)}
              big={t === arranged.main}
              speaking={t.source === 'camera' && call.speaking.has(t.actorId)}
              pinned={pinned === t.key}
              onPin={() => setPinned((p) => (p === t.key ? null : t.key))}
              onVideo={onVideo}
            />
          ))}
          <Overflow names={overflowNames} />
        </div>
      </div>
    </section>
  );
}

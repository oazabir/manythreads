import { useRef, useState } from 'react';
import { useDismiss } from '../../shell/useDismiss';
import { CameraIcon, ScreenIcon } from '../../meetings/icons';
import { CaptureStudio, type CaptureKind } from './CaptureStudio';

/*
 * The capture button beside the paperclip (owner, 2026-11-23): Screenshot or Screen recording. Either asks the browser for a screen, a window or a tab (its
 * own picker), then opens the studio to keep a region, take or record, check and attach. The sharing ends when the studio closes.
 */

export const captureSupported = (): boolean => typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

export function CaptureButton({ onAttach, hidden = false }: { onAttach: (file: File) => void; hidden?: boolean }) {
  const [menu, setMenu] = useState(false);
  const [studio, setStudio] = useState<{ kind: CaptureKind; stream: MediaStream } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(menu, () => setMenu(false), box);

  const choose = async (kind: CaptureKind): Promise<void> => {
    setMenu(false);
    setProblem(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        // a recording keeps the shared tab's sound when the browser offers it; a screenshot never needs sound
        audio: kind === 'video',
        // the picker offers screens, windows and tabs, this one included
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
      } as DisplayMediaStreamOptions);
      setStudio({ kind, stream });
    } catch (e) {
      // the person closed the picker: nothing to say
      if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return;
      setProblem('The screen could not be shared. Allow screen sharing for this site, then try again.');
    }
  };
  const close = (): void => {
    studio?.stream.getTracks().forEach((t) => t.stop());
    setStudio(null);
  };

  if (!captureSupported()) return null;
  return (
    <div className="cap-wrap" ref={box} hidden={hidden}>
      <button
        type="button"
        className="icon-btn cap-btn-open"
        aria-label="Screenshot or screen recording"
        title="Screenshot or screen recording"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu((m) => !m)}
        data-testid="capture-open"
      >
        <CameraIcon />
      </button>
      {menu ? (
        <div className="cap-menu" role="menu" aria-label="Capture" data-testid="capture-menu">
          <button type="button" role="menuitem" className="cap-choice" onClick={() => void choose('image')} data-testid="capture-image">
            <span className="cap-choice-ic" aria-hidden="true"><ScreenIcon /></span>
            <span className="cap-choice-text">
              <b>Screenshot</b>
              <span>A picture of a screen, a window or a tab, or a part of it</span>
            </span>
          </button>
          <button type="button" role="menuitem" className="cap-choice" onClick={() => void choose('video')} data-testid="capture-video">
            <span className="cap-choice-ic rec" aria-hidden="true"><CameraIcon /></span>
            <span className="cap-choice-text">
              <b>Screen recording</b>
              <span>A video of up to 3 minutes, with the tab's sound</span>
            </span>
          </button>
        </div>
      ) : null}
      {problem ? <p className="cap-note" role="alert">{problem}</p> : null}
      {studio ? (
        <CaptureStudio
          kind={studio.kind}
          stream={studio.stream}
          onAttach={(file) => onAttach(file)}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

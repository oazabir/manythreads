import { useState, type ReactNode } from 'react';
import { CloseIcon } from '../../shell/icons';
import { CaptureStudio, type CaptureKind } from './CaptureStudio';

/*
 * Screenshot or Screen recording (owner, 2026-11-23). Either asks the browser for a screen, a window or a tab (its own picker), then opens the studio to keep
 * a region, take or record, check and attach. The sharing ends when the studio closes.
 */

export const captureSupported = (): boolean => typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

/**
 * Screenshot and screen recording for the composer (owner, 2026-11-23); since P36-09 they are two items of the Attach menu instead of a camera button with
 * its own menu. `start` must be called from the press itself (the browser asks for the screen only in answer to one); `view` is the studio and the note
 * when the screen could not be shared, drawn by the composer.
 */
export function useCapture(onAttach: (file: File) => void): { start: (kind: CaptureKind) => void; view: ReactNode } {
  const [studio, setStudio] = useState<{ kind: CaptureKind; stream: MediaStream } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const start = (kind: CaptureKind): void => {
    setProblem(null);
    if (!captureSupported()) return;
    navigator.mediaDevices
      .getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        // a recording keeps the shared tab's sound when the browser offers it; a screenshot never needs sound
        audio: kind === 'video',
        // the picker offers screens, windows and tabs, this one included
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
      } as DisplayMediaStreamOptions)
      .then(
        (stream) => setStudio({ kind, stream }),
        (e: unknown) => {
          // the person closed the picker: nothing to say
          if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return;
          setProblem('The screen could not be shared. Allow screen sharing for this site, then try again.');
        },
      );
  };
  const close = (): void => {
    studio?.stream.getTracks().forEach((t) => t.stop());
    setStudio(null);
  };

  const view = (
    <>
      {/* a plain note: it stays until it is closed or the next try, and it does not take Esc from the box or a panel behind it */}
      {problem ? (
        <p className="cap-note" role="alert" data-testid="capture-problem">
          <span>{problem}</span>
          <button type="button" className="icon-btn cap-note-close" aria-label="Close this note" onClick={() => setProblem(null)} data-testid="capture-problem-close"><CloseIcon /></button>
        </p>
      ) : null}
      {studio ? <CaptureStudio kind={studio.kind} stream={studio.stream} onAttach={(file) => onAttach(file)} onClose={close} /> : null}
    </>
  );
  return { start, view };
}

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Capture, type CaptureDeps, type CaptureState, type LevelReader, type Meter, type MeterSnapshot, type RecorderLike, type StreamLike } from './capture';
import { levelOf } from './peaks';
import { pickMimeType } from './support';

/**
 * The recorder as a hook (P14-17): wraps `Capture` with the real browser (getUserMedia, MediaRecorder, an AnalyserNode for the level).
 * The composer reads `state` (it changes a few times per recording); the timer and the level meter read `useMeter`, so the composer is
 * not drawn twelve times a second.
 */

type AudioCtxCtor = new () => AudioContext;

function makeLevelReader(stream: StreamLike): LevelReader | null {
  try {
    const w = globalThis as unknown as { AudioContext?: AudioCtxCtor; webkitAudioContext?: AudioCtxCtor };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    const ctx = new Ctor();
    const source = ctx.createMediaStreamSource(stream as unknown as MediaStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    // Safari starts a context made after an `await` suspended; without this the meter and the waveform stay flat
    void ctx.resume?.().catch(() => undefined);
    const data = new Uint8Array(analyser.fftSize);
    return {
      read() {
        analyser.getByteTimeDomainData(data);
        return levelOf(data);
      },
      close() {
        source.disconnect();
        void ctx.close().catch(() => undefined);
      },
    };
  } catch {
    return null; // no meter is not a reason to refuse the recording
  }
}

export const browserDeps: CaptureDeps = {
  openMic: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }) as unknown as Promise<StreamLike>,
  makeRecorder: (stream, mimeType) => new MediaRecorder(stream as unknown as MediaStream, mimeType ? { mimeType } : undefined) as unknown as RecorderLike,
  makeLevelReader,
  pickMime: () => pickMimeType(typeof MediaRecorder === 'undefined' ? undefined : (t) => MediaRecorder.isTypeSupported(t)),
  now: () => performance.now(),
  every: (fn, ms) => {
    const id = window.setInterval(fn, ms);
    return () => window.clearInterval(id);
  },
  makeUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
};

export type Recorder = {
  state: CaptureState;
  /** The polite live-region text: "Recording", "Recording stopped, 0:42. 42 seconds." */
  announcement: string;
  meter: Meter;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  releaseWhileAsking: () => void;
  discard: (announce?: string) => void;
  reset: () => void;
};

export function useRecorder(deps: CaptureDeps = browserDeps): Recorder {
  const ref = useRef<Capture | null>(null);
  if (ref.current === null) ref.current = new Capture(deps);
  const cap = ref.current;
  // the capture is replaced, not mutated: the snapshot is the state object itself, which changes on every transition
  const state = useSyncExternalStore(cap.subscribe, () => cap.state);
  const announcement = useSyncExternalStore(cap.subscribe, () => cap.announcement);
  useEffect(() => () => cap.dispose(), [cap]);
  const actions = useMemo(
    () => ({
      meter: cap.meter,
      start: () => void cap.start(),
      stop: () => cap.stop(),
      cancel: () => cap.cancel(),
      releaseWhileAsking: () => cap.releaseWhileAsking(),
      discard: (announce?: string) => cap.discard(announce),
      reset: () => cap.reset(),
    }),
    [cap],
  );
  return { state, announcement, ...actions };
}

/** The timer and level for the panel: re-reads about twelve times a second while recording. */
export function useMeter(meter: Meter): MeterSnapshot {
  return useSyncExternalStore(meter.subscribe, meter.get);
}

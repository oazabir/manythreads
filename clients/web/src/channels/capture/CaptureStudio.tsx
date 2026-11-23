import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { captureName, compressRecording, compressScreenshot } from './compress';

/*
 * The capture studio (owner, 2026-11-23): what the person chose to share (a screen, a window or a tab, from the browser's own picker) shown live; they drag
 * to keep only a region of it (or keep the whole picture), then take the screenshot or record. A screenshot is checked before it is attached; a recording
 * has a timer, stops at three minutes or when the sharing stops, and is played back before it is attached. Before the upload the picture is made smaller
 * (browser-image-compression) and the recording transcoded (ffmpeg.wasm), with a progress bar; the file then joins the message box's attachments.
 */

export type CaptureKind = 'image' | 'video';
type Rect = { x: number; y: number; w: number; h: number };
type Phase = 'select' | 'recording' | 'review' | 'optimizing';

const MAX_SECONDS = 180;
const FPS = 30;
/** A region smaller than this (in the source's pixels) is a click, not a region: the whole picture is kept. */
const MIN_SIDE = 24;

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const sizeText = (bytes: number): string => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** A frame clock that keeps ticking when this tab is in the background (a timer here would slow to once a second while another tab is recorded). */
function frameClock(onTick: () => void): () => void {
  const src = `let t=setInterval(()=>postMessage(0),${Math.round(1000 / FPS)});onmessage=()=>clearInterval(t);`;
  const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  try {
    const worker = new Worker(url);
    worker.onmessage = onTick;
    return () => {
      worker.postMessage('stop');
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    URL.revokeObjectURL(url);
    const t = window.setInterval(onTick, 1000 / FPS);
    return () => window.clearInterval(t);
  }
}

const recorderType = (): string => ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) ?? 'video/webm';

export function CaptureStudio({ kind, stream, onAttach, onClose }: { kind: CaptureKind; stream: MediaStream; onAttach: (file: File) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('select');
  const [ready, setReady] = useState(false);
  // the region in the source's own pixels; null is the whole picture
  const [region, setRegion] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const [clip, setClip] = useState<{ blob: Blob; url: string; seconds: number } | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [progress, setProgress] = useState<{ fraction: number; stage: 'loading' | 'encoding' | 'image' } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const stopRecording = useRef<(() => void) | null>(null);
  const hasAudio = stream.getAudioTracks().length > 0;

  // the live picture
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.srcObject = stream;
    void v.play().catch(() => undefined);
    const onMeta = (): void => setReady(true);
    v.addEventListener('loadedmetadata', onMeta);
    return () => v.removeEventListener('loadedmetadata', onMeta);
  }, [stream]);

  // the person stopped sharing from the browser's own bar: a recording ends, anything else closes
  useEffect(() => {
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const onEnded = (): void => {
      if (stopRecording.current) stopRecording.current();
      else if (!shot && !clip) onClose();
    };
    track.addEventListener('ended', onEnded);
    return () => track.removeEventListener('ended', onEnded);
  }, [stream, shot, clip, onClose]);

  // Esc leaves (a recording is stopped first, and kept for review)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (stopRecording.current) stopRecording.current();
      else if (phase !== 'optimizing') onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase, onClose]);

  useEffect(
    () => () => {
      if (shot) URL.revokeObjectURL(shot.url);
      if (clip) URL.revokeObjectURL(clip.url);
    },
    [shot, clip],
  );

  /** Where the picture is drawn inside the stage (object-fit: contain), to map the pointer to the source's pixels. */
  const frame = useCallback((): { left: number; top: number; scale: number } | null => {
    const v = video.current;
    const box = stage.current?.getBoundingClientRect();
    if (!v || !box || !v.videoWidth) return null;
    const scale = Math.min(box.width / v.videoWidth, box.height / v.videoHeight);
    return { left: box.left + (box.width - v.videoWidth * scale) / 2, top: box.top + (box.height - v.videoHeight * scale) / 2, scale };
  }, []);
  const toSource = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const f = frame();
    const v = video.current;
    if (!f || !v) return null;
    return { x: Math.max(0, Math.min(v.videoWidth, (e.clientX - f.left) / f.scale)), y: Math.max(0, Math.min(v.videoHeight, (e.clientY - f.top) / f.scale)) };
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (phase !== 'select') return;
    const p = toSource(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(p);
    setRegion({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drag) return;
    const p = toSource(e);
    if (!p) return;
    setRegion({ x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) });
  };
  const onUp = (): void => {
    setDrag(null);
    setRegion((r) => (r && (r.w < MIN_SIDE || r.h < MIN_SIDE) ? null : r));
  };

  /** The part of the source kept: the region, or all of it. */
  const crop = (): Rect => {
    const v = video.current!;
    return region ? { x: Math.round(region.x), y: Math.round(region.y), w: Math.round(region.w) & ~1, h: Math.round(region.h) & ~1 } : { x: 0, y: 0, w: v.videoWidth, h: v.videoHeight };
  };

  const takeScreenshot = (): void => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = crop();
    const canvas = document.createElement('canvas');
    canvas.width = c.w;
    canvas.height = c.h;
    canvas.getContext('2d')!.drawImage(v, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
    canvas.toBlob((blob) => {
      if (!blob) return setProblem('The screenshot could not be taken. Try again.');
      setShot({ blob, url: URL.createObjectURL(blob) });
      setPhase('review');
    }, 'image/png');
  };

  const startRecording = (): void => {
    const v = video.current;
    if (!v || !v.videoWidth || typeof MediaRecorder === 'undefined') return setProblem('This browser cannot record the screen.');
    const c = crop();
    const whole = region === null;
    let source: MediaStream;
    let stopFrames: (() => void) | null = null;
    if (whole) {
      source = stream;
    } else {
      // only the region: each frame is drawn into a canvas of its size, and the canvas is what is recorded (with the shared tab's sound, if any)
      const canvas = document.createElement('canvas');
      canvas.width = c.w;
      canvas.height = c.h;
      const g = canvas.getContext('2d')!;
      const draw = (): void => g.drawImage(v, c.x, c.y, c.w, c.h, 0, 0, c.w, c.h);
      draw();
      stopFrames = frameClock(draw);
      source = new MediaStream([...canvas.captureStream(FPS).getVideoTracks(), ...stream.getAudioTracks()]);
    }
    const chunks: Blob[] = [];
    const type = recorderType();
    const rec = new MediaRecorder(source, { mimeType: type, videoBitsPerSecond: 5_000_000 });
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const started = performance.now();
    const tick = window.setInterval(() => {
      const s = (performance.now() - started) / 1000;
      setSeconds(s);
      if (s >= MAX_SECONDS) stopRecording.current?.();
    }, 250);
    rec.onstop = () => {
      window.clearInterval(tick);
      stopFrames?.();
      stopRecording.current = null;
      const blob = new Blob(chunks, { type: 'video/webm' });
      const secs = (performance.now() - started) / 1000;
      if (blob.size === 0) {
        setPhase('select');
        setProblem('Nothing was recorded. Try again.');
        return;
      }
      setClip({ blob, url: URL.createObjectURL(blob), seconds: secs });
      setPhase('review');
    };
    stopRecording.current = () => {
      if (rec.state !== 'inactive') rec.stop();
    };
    setSeconds(0);
    setProblem(null);
    rec.start(1000);
    setPhase('recording');
  };

  const again = (): void => {
    if (shot) URL.revokeObjectURL(shot.url);
    if (clip) URL.revokeObjectURL(clip.url);
    setShot(null);
    setClip(null);
    setProblem(null);
    setPhase('select');
  };

  const attach = async (): Promise<void> => {
    setPhase('optimizing');
    try {
      if (shot) {
        setProgress({ fraction: 0.5, stage: 'image' });
        onAttach(await compressScreenshot(shot.blob, captureName('Screenshot')));
      } else if (clip) {
        setProgress({ fraction: 0, stage: 'loading' });
        onAttach(await compressRecording(clip.blob, captureName('Screen recording'), (fraction, stage) => setProgress({ fraction, stage }), hasAudio));
      }
      onClose();
    } catch {
      setPhase('review');
      setProblem('It could not be made ready to send. Try again.');
    }
  };

  const f = phase === 'select' || phase === 'recording' ? frame() : null;
  const shownRegion = region && f ? { left: f.left + region.x * f.scale, top: f.top + region.y * f.scale, width: region.w * f.scale, height: region.h * f.scale } : null;
  const stageBox = stage.current?.getBoundingClientRect();
  const title = kind === 'image' ? 'Screenshot' : 'Screen recording';
  const hint =
    phase === 'select'
      ? region
        ? `${Math.round(region.w)} × ${Math.round(region.h)} selected · drag again to change it`
        : 'Drag over the picture to keep only part of it, or keep the whole picture'
      : phase === 'recording'
        ? `Recording${region ? ' the selected area' : ''}${hasAudio ? ' with its sound' : ''} · Esc or Stop to finish`
        : phase === 'review'
          ? shot
            ? `Check the screenshot · ${sizeText(shot.blob.size)} before it is made smaller`
            : `Check the recording · ${clip ? clock(clip.seconds) : ''} · ${clip ? sizeText(clip.blob.size) : ''} before it is made smaller`
          : progress?.stage === 'loading'
            ? 'Getting the video encoder ready (the first time takes a moment)'
            : progress?.stage === 'image'
              ? 'Making the picture smaller'
              : `Making the video smaller · ${Math.round((progress?.fraction ?? 0) * 100)}%`;

  return createPortal(
    <div className="cap" role="dialog" aria-modal="true" aria-label={title} data-testid="capture-studio" data-phase={phase}>
      <header className="cap-bar">
        <span className={`cap-dot ${phase === 'recording' ? 'live' : ''}`} aria-hidden="true" />
        <h2 className="cap-title">{title}</h2>
        <span className="cap-hint" role="status">{hint}</span>
        {phase !== 'optimizing' ? (
          <button type="button" className="cap-x" aria-label="Close" onClick={() => (stopRecording.current ? stopRecording.current() : onClose())} data-testid="capture-close">
            ✕
          </button>
        ) : null}
      </header>
      <div
        ref={stage}
        className={`cap-stage ${phase === 'select' ? 'selecting' : ''}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        data-testid="capture-stage"
      >
        <video ref={video} className="cap-live" muted playsInline hidden={phase === 'review' || phase === 'optimizing'} />
        {phase === 'review' && shot ? <img className="cap-result" src={shot.url} alt="The screenshot" data-testid="capture-shot" /> : null}
        {(phase === 'review' || phase === 'optimizing') && clip ? <video className="cap-result" src={clip.url} controls playsInline data-testid="capture-clip" /> : null}
        {phase === 'optimizing' && shot ? <img className="cap-result dim" src={shot.url} alt="" /> : null}
        {shownRegion && stageBox ? (
          <div
            className={`cap-region ${phase === 'recording' ? 'live' : ''}`}
            style={{ left: shownRegion.left - stageBox.left, top: shownRegion.top - stageBox.top, width: shownRegion.width, height: shownRegion.height }}
            aria-hidden="true"
          />
        ) : null}
        {!ready && phase === 'select' ? <p className="cap-wait">Waiting for the picture…</p> : null}
      </div>
      <footer className="cap-foot">
        {problem ? <p className="cap-problem" role="alert">{problem}</p> : null}
        {phase === 'select' ? (
          <>
            {region ? <button type="button" className="cap-btn ghost" onClick={() => setRegion(null)} data-testid="capture-whole">Whole picture</button> : null}
            <button type="button" className="cap-btn ghost" onClick={onClose}>Cancel</button>
            {kind === 'image' ? (
              <button type="button" className="cap-btn primary" disabled={!ready} onClick={takeScreenshot} data-testid="capture-take">Take screenshot</button>
            ) : (
              <button type="button" className="cap-btn rec" disabled={!ready} onClick={startRecording} data-testid="capture-record"><span className="cap-recdot" aria-hidden="true" /> Start recording</button>
            )}
          </>
        ) : null}
        {phase === 'recording' ? (
          <>
            <span className="cap-timer" data-testid="capture-timer">{clock(seconds)} <span className="cap-of">/ {clock(MAX_SECONDS)}</span></span>
            <span className="cap-meter" aria-hidden="true"><span style={{ width: `${Math.min(100, (seconds / MAX_SECONDS) * 100)}%` }} /></span>
            <button type="button" className="cap-btn rec" onClick={() => stopRecording.current?.()} data-testid="capture-stop"><span className="cap-stopsq" aria-hidden="true" /> Stop</button>
          </>
        ) : null}
        {phase === 'review' ? (
          <>
            <button type="button" className="cap-btn ghost" onClick={again} data-testid="capture-again">{shot ? 'Retake' : 'Record again'}</button>
            <button type="button" className="cap-btn primary" onClick={() => void attach()} data-testid="capture-attach">Attach to message</button>
          </>
        ) : null}
        {phase === 'optimizing' ? (
          <span className="cap-progress" role="progressbar" aria-label="Making it ready to send" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress?.fraction ?? 0) * 100)} data-testid="capture-progress">
            <span className={progress?.stage === 'loading' ? 'indeterminate' : ''} style={progress?.stage === 'loading' ? undefined : { width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }} />
          </span>
        ) : null}
      </footer>
    </div>,
    document.body,
  );
}

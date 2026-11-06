import { VOICE_MAX_MS } from '@manythreads/shared';
import { VOICE_MIN_MS, formatClock, reachedLimit, warningAt } from './clock';
import { reducePeaks } from './peaks';
import { ALLOWED_TEXT, LOST_TEXT, TOO_SHORT_TEXT, clipMime, micErrorText } from './support';

/**
 * The recording itself (P14-17), with no React and with every browser object handed in, so the rules (permission, too short, the five minute
 * limit, cancel, a lost microphone) are tested with stand-ins. `useRecorder` is the thin hook around it.
 */

export interface TrackLike {
  stop(): void;
  onended: (() => void) | null;
}
export interface StreamLike {
  getTracks(): TrackLike[];
}
export interface RecorderLike {
  state: string;
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(timesliceMs?: number): void;
  stop(): void;
}
/** Reads the level of the microphone (0 to 1); `close` lets go of the audio graph. */
export interface LevelReader {
  read(): number;
  close(): void;
}

export type CaptureDeps = {
  openMic(): Promise<StreamLike>;
  makeRecorder(stream: StreamLike, mimeType: string | undefined): RecorderLike;
  makeLevelReader(stream: StreamLike): LevelReader | null;
  pickMime(): string | undefined;
  now(): number;
  /** Calls `fn` every `ms` until the returned function is called. */
  every(fn: () => void, ms: number): () => void;
  makeUrl(blob: Blob): string;
  revokeUrl(url: string): void;
};

export type RecordedClip = { blob: Blob; url: string; mime: string; durationMs: number; peaks: number[]; /** The recording ran into the five minute limit and stopped by itself. */ limited: boolean };

export type CaptureState =
  | { phase: 'idle' }
  /** Waiting for the person to answer the browser's microphone question. */
  | { phase: 'asking' }
  | { phase: 'recording' }
  | { phase: 'preview'; clip: RecordedClip }
  | { phase: 'error'; message: string };

export type MeterSnapshot = { elapsedMs: number; level: number };

/** A value that changes about twelve times a second while recording: only the timer and the level meter listen, not the composer. */
export function createMeter() {
  let snap: MeterSnapshot = { elapsedMs: 0, level: 0 };
  const subs = new Set<() => void>();
  return {
    get: (): MeterSnapshot => snap,
    set(next: MeterSnapshot): void {
      snap = next;
      subs.forEach((f) => f());
    },
    subscribe(fn: () => void): () => void {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}
export type Meter = ReturnType<typeof createMeter>;

export const TICK_MS = 80;
const TIMESLICE_MS = 250;

export class Capture {
  state: CaptureState = { phase: 'idle' };
  /** What a screen reader hears (a polite live region): short sentences at the start, the stop and the limit, never every second. */
  announcement = '';
  readonly meter: Meter = createMeter();

  private listeners = new Set<() => void>();
  private session = 0;
  private stream: StreamLike | null = null;
  private recorder: RecorderLike | null = null;
  private levels: LevelReader | null = null;
  private stopTicks: (() => void) | null = null;
  private chunks: Blob[] = [];
  private readings: number[] = [];
  private startedAt = 0;
  private endedAt = 0;
  private outcome: 'keep' | 'cancel' | 'limit' | 'lost' = 'keep';
  private warned = 0;

  constructor(private readonly deps: CaptureDeps) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private set(state: CaptureState, announcement?: string): void {
    this.state = state;
    if (announcement !== undefined) this.announcement = announcement;
    this.listeners.forEach((f) => f());
  }

  /** Asks for the microphone and starts. Does nothing while a recording is under way or a clip waits in the preview. */
  async start(): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'error') return;
    const mine = ++this.session;
    this.set({ phase: 'asking' });
    let stream: StreamLike;
    try {
      stream = await this.deps.openMic();
    } catch (err) {
      if (mine === this.session) this.set({ phase: 'error', message: micErrorText(err) }, '');
      return;
    }
    if (mine !== this.session) {
      // let go before the answer came (released too early, Esc, or the composer closed): the microphone is not kept
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    try {
      this.begin(stream);
    } catch (err) {
      // `begin` may have got as far as the level reader or the recorder: let go of all of it, not only the tracks
      this.stopTicks?.();
      this.stopTicks = null;
      this.release();
      stream.getTracks().forEach((t) => t.stop());
      this.set({ phase: 'error', message: micErrorText(err) }, '');
    }
  }

  private begin(stream: StreamLike): void {
    const recorder = this.deps.makeRecorder(stream, this.deps.pickMime());
    this.stream = stream;
    this.recorder = recorder;
    this.chunks = [];
    this.readings = [];
    this.warned = 0;
    this.outcome = 'keep';
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    recorder.onstop = () => this.finish();
    recorder.onerror = () => {
      this.outcome = 'lost';
      this.halt();
    };
    for (const t of stream.getTracks()) {
      t.onended = () => {
        if (this.state.phase === 'recording') {
          this.outcome = 'lost';
          this.halt();
        }
      };
    }
    this.levels = this.deps.makeLevelReader(stream);
    this.startedAt = this.deps.now();
    this.meter.set({ elapsedMs: 0, level: 0 });
    recorder.start(TIMESLICE_MS);
    this.stopTicks = this.deps.every(() => this.tick(), TICK_MS);
    this.set({ phase: 'recording' }, 'Recording');
  }

  private tick(): void {
    if (this.state.phase !== 'recording') return;
    const elapsedMs = Math.min(VOICE_MAX_MS, this.deps.now() - this.startedAt);
    const level = this.levels?.read() ?? 0;
    this.readings.push(level);
    this.meter.set({ elapsedMs, level });
    const warn = warningAt(elapsedMs, this.warned);
    if (warn) {
      this.warned = warn.said;
      this.announcement = warn.text;
      this.listeners.forEach((f) => f());
    }
    if (reachedLimit(elapsedMs)) {
      this.outcome = 'limit';
      this.halt();
    }
  }

  /** Ends the recording: keeps it for the preview. */
  stop(): void {
    if (this.state.phase !== 'recording') return;
    this.outcome = 'keep';
    this.halt();
  }

  /** Throws the recording away (slide away, Esc, Cancel). Nothing is kept and nothing is uploaded. */
  cancel(): void {
    if (this.state.phase === 'asking') {
      this.session++; // the answer, when it comes, is ignored and the microphone released
      this.set({ phase: 'idle' }, '');
      return;
    }
    if (this.state.phase !== 'recording') return;
    this.outcome = 'cancel';
    this.halt();
  }

  /** The press ended before the browser's question was answered, and it was a hold, not a tap: say the microphone is ready, record nothing. */
  releaseWhileAsking(): void {
    if (this.state.phase !== 'asking') return;
    this.session++;
    this.set({ phase: 'error', message: ALLOWED_TEXT }, '');
  }

  private halt(): void {
    this.endedAt = this.deps.now();
    this.stopTicks?.();
    this.stopTicks = null;
    const r = this.recorder;
    if (r && r.state !== 'inactive') r.stop();
    else this.finish();
  }

  private release(): void {
    this.levels?.close();
    this.levels = null;
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.stream = null;
    this.recorder = null;
  }

  private finish(): void {
    if (this.state.phase !== 'recording') return;
    const mime = clipMime(this.recorder?.mimeType || this.deps.pickMime() || 'audio/webm');
    const chunks = this.chunks;
    const outcome = this.outcome;
    const durationMs = Math.min(VOICE_MAX_MS, Math.max(0, this.endedAt - this.startedAt));
    const peaks = reducePeaks(this.readings);
    this.release();
    this.chunks = [];
    this.readings = [];
    this.meter.set({ elapsedMs: 0, level: 0 });
    if (outcome === 'cancel') {
      this.set({ phase: 'idle' }, 'Recording cancelled');
      return;
    }
    const blob = new Blob(chunks, { type: mime });
    if (outcome === 'lost' && (durationMs < VOICE_MIN_MS || blob.size === 0)) {
      this.set({ phase: 'error', message: LOST_TEXT }, '');
      return;
    }
    if (durationMs < VOICE_MIN_MS || blob.size === 0) {
      this.set({ phase: 'error', message: TOO_SHORT_TEXT }, '');
      return;
    }
    const clip: RecordedClip = { blob, url: this.deps.makeUrl(blob), mime, durationMs, peaks, limited: outcome === 'limit' };
    const said = outcome === 'limit' ? `Recording stopped at the limit, ${formatClock(durationMs)}` : `Recording stopped, ${formatClock(durationMs)}`;
    this.set({ phase: 'preview', clip }, said);
  }

  /** Drops the clip waiting in the preview (Discard, or after it was sent). */
  discard(announce = ''): void {
    if (this.state.phase === 'preview') this.deps.revokeUrl(this.state.clip.url);
    if (this.state.phase === 'preview' || this.state.phase === 'error') this.set({ phase: 'idle' }, announce);
  }

  /** The conversation changed under the recorder (another channel opened): whatever is under way or waiting is dropped, silently. */
  reset(): void {
    if (this.state.phase === 'asking') this.session++;
    if (this.state.phase === 'recording') {
      this.outcome = 'cancel';
      this.halt();
      return;
    }
    if (this.state.phase !== 'idle') {
      if (this.state.phase === 'preview') this.deps.revokeUrl(this.state.clip.url);
      this.set({ phase: 'idle' }, '');
    }
  }

  /** The composer went away: let go of everything, silently. */
  dispose(): void {
    this.session++;
    this.stopTicks?.();
    this.stopTicks = null;
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    }
    this.release();
    if (this.state.phase === 'preview') this.deps.revokeUrl(this.state.clip.url);
    this.state = { phase: 'idle' };
  }
}

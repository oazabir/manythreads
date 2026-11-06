import { fileContentUrl } from '../../api/endpoints';
import { installWhisperWorker } from '../../speech/client';
import { getSpeechEngine, SpeechError, TOO_WEAK_REASON, type SpeechEngine, type SpeechProgress, type Transcript } from '../../speech';

/**
 * Writing out a voice message on this device (P14-17): one run per clip, the sentences the person reads while it works, and what happens when it
 * cannot be done. The engine itself is `speech/`; this file is the part that knows what a voice message needs from it.
 *
 * A run never throws. It ends in one of two states: `ready` (words found, maybe none) or `none` (this device cannot, with the reason in plain words),
 * and then the message goes out without a transcript.
 */

export const WRITING_TEXT = 'Writing it out on this device…';
export const MODEL_TEXT = 'Getting the speech model ready…';
export const FIRST_USE_NOTE = 'The first voice message downloads a speech model (about 40 MB). It is kept for next time.';
export const CHECK_NOTE = 'Check the words before you send. Only the text and the clip leave your device.';
export const NOTHING_HEARD = 'No words were found in this recording. You can type them, or send the clip without a transcript.';
export const WEAK_TAIL = ' It will be sent without a transcript; you can add one later from another device.';
export const FAILED_TAIL = ' It will be sent without a transcript; you can add one later from the message menu.';

export type TranscriptState =
  | { phase: 'working'; stage: SpeechProgress['stage']; fraction: number }
  | { phase: 'ready'; text: string; language: string | null }
  | { phase: 'none'; notice: string };

export const WORKING_START: TranscriptState = { phase: 'working', stage: 'listening', fraction: 0 };

/** "Getting the speech model ready… 34%" / "Writing it out on this device… 60%"; no percentage until there is one. */
export function progressLine(stage: SpeechProgress['stage'], fraction: number): string {
  const base = stage === 'model' ? MODEL_TEXT : WRITING_TEXT;
  const pct = Math.round(Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0)) * 100);
  return pct > 0 && pct < 100 ? `${base} ${pct}%` : base;
}

/** The one-time download note is shown only while the model is being fetched. */
export const showsFirstUseNote = (s: TranscriptState): boolean => s.phase === 'working' && s.stage === 'model';

/** The sentence for a device or run that cannot write the words out, with what happens next. */
export function fallbackNotice(error: unknown, engine: SpeechEngine | null): string {
  const reason = error instanceof SpeechError ? error.message : 'Writing it out did not work.';
  const noEngine = engine === null || engine.kind === 'none' || reason === TOO_WEAK_REASON;
  return `${reason}${noEngine ? WEAK_TAIL : FAILED_TAIL}`;
}

/** What `Send` posts for the state of the preview: the device's words, the words as corrected, or nothing. */
export function transcriptToSend(state: TranscriptState, text: string): { text: string; language: string | null; edited: boolean } | null {
  if (state.phase !== 'ready') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return { text: trimmed, language: state.language, edited: trimmed !== state.text.trim() };
}

/** The engine for voice messages: the worker is plugged in on first use, then the device check runs once. */
export function voiceEngine(): Promise<SpeechEngine> {
  installWhisperWorker();
  return getSpeechEngine();
}

export class TranscriptRun {
  private current: TranscriptState = WORKING_START;
  private readonly listeners = new Set<() => void>();
  private ctl: AbortController | null = null;
  private finished: Promise<Transcript | null> = Promise.resolve(null);
  private running = false;

  constructor(
    private readonly audio: Blob | (() => Promise<Blob>),
    private readonly getEngine: () => Promise<SpeechEngine> = voiceEngine,
  ) {}

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  readonly getState = (): TranscriptState => this.current;

  /** Settles with the transcript, or null when there is none to give (a device that cannot, an error, a cancel). Never rejects. */
  get done(): Promise<Transcript | null> {
    return this.finished;
  }

  /** Begins writing out; calling it again while it runs does nothing. After `cancel` it starts over. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const ctl = new AbortController();
    this.ctl = ctl;
    this.set(WORKING_START);
    this.finished = this.work(ctl);
  }

  /** Stops the work now (the worker is stopped and the model's memory freed). */
  cancel(): void {
    this.ctl?.abort();
    this.ctl = null;
    this.running = false;
  }

  private set(next: TranscriptState): void {
    this.current = next;
    for (const l of [...this.listeners]) l();
  }

  private async work(ctl: AbortController): Promise<Transcript | null> {
    let engine: SpeechEngine | null = null;
    try {
      engine = await this.getEngine();
      if (ctl.signal.aborted) return null;
      if (engine.kind === 'none') {
        this.set({ phase: 'none', notice: fallbackNotice(new SpeechError('unavailable', engine.reason ?? TOO_WEAK_REASON), engine) });
        return null;
      }
      const blob = typeof this.audio === 'function' ? await this.audio() : this.audio;
      if (ctl.signal.aborted) return null;
      const t = await engine.transcribe(blob, {
        signal: ctl.signal,
        onProgress: (p) => {
          if (!ctl.signal.aborted) this.set({ phase: 'working', stage: p.stage, fraction: p.fraction });
        },
      });
      if (ctl.signal.aborted) return null;
      this.set({ phase: 'ready', text: t.text.trim(), language: t.language });
      return t;
    } catch (e) {
      if (ctl.signal.aborted || (e instanceof SpeechError && e.code === 'aborted')) return null;
      this.set({ phase: 'none', notice: fallbackNotice(e, engine) });
      return null;
    } finally {
      if (this.ctl === ctl) this.running = false;
    }
  }
}

/** The bytes of a clip already on the server (the author's own, fetched with the sign-in cookie), for "Add a transcript". */
export async function fetchClipBlob(fileId: string): Promise<Blob> {
  const res = await fetch(fileContentUrl(fileId), { credentials: 'include' });
  if (!res.ok) throw new SpeechError('decode', "The recording could not be fetched. Try again in a moment.");
  return res.blob();
}

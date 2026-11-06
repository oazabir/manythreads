/*
 * The words the page and the speech worker say to each other (PLAN P14-16), the places the model files live, and the one piece of arithmetic the
 * progress line needs. Nothing here touches the model library, a worker or the DOM, so it is plain to test.
 */
import lock from '../../models.lock.json';
import type { SpeechProgress, Transcript, WhisperModelName } from './types';

/** The worker is stopped this long after its last job, so the model's memory goes back to the device. */
export const WORKER_IDLE_MS = 60_000;

export type SpeechDevice = 'webgpu' | 'wasm';
/** `auto` picks the graphics card when the browser has one and the processor otherwise. */
export type DevicePreference = 'auto' | SpeechDevice;

/**
 * Page to worker. There is no "cancel" message: the worker computes in long stretches without listening, so a cancelled job ends by the page
 * stopping the worker (the model is read again from the service worker's cache next time, a second or two).
 */
export type ClientMessage = { type: 'transcribe'; id: number; model: WhisperModelName; samples: Float32Array; language?: string; device: DevicePreference };

/** How long each step took, for the bench page and the spike record. All in milliseconds. */
export interface SpeechStats {
  model: WhisperModelName;
  device: SpeechDevice;
  /** Opening the model files and getting the session ready (0 when the worker already had it). */
  loadMs: number;
  /** Finding where the speech is. 0 when no speech finder ran. */
  vadMs: number;
  /** Working out the language. 0 when it was given. */
  languageMs: number;
  /** Turning the speech windows into words. */
  decodeMs: number;
  audioMs: number;
  speechMs: number;
  windows: number;
}

/** Worker to page. */
export type WorkerMessage =
  | { type: 'progress'; id: number; stage: SpeechProgress['stage']; fraction: number }
  | { type: 'result'; id: number; transcript: Transcript; stats: SpeechStats }
  | { type: 'error'; id: number; code: 'failed'; during: 'model' | 'work'; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function isClientMessage(v: unknown): v is ClientMessage {
  if (!isObject(v) || typeof v['id'] !== 'number') return false;
  return (
    v['type'] === 'transcribe' &&
    (v['model'] === 'tiny' || v['model'] === 'base') &&
    v['samples'] instanceof Float32Array &&
    (v['device'] === 'auto' || v['device'] === 'wasm' || v['device'] === 'webgpu') &&
    (v['language'] === undefined || typeof v['language'] === 'string')
  );
}

export function isWorkerMessage(v: unknown): v is WorkerMessage {
  if (!isObject(v) || typeof v['id'] !== 'number') return false;
  if (v['type'] === 'progress') return (v['stage'] === 'model' || v['stage'] === 'listening') && typeof v['fraction'] === 'number';
  if (v['type'] === 'result') return isObject(v['transcript']) && isObject(v['stats']);
  return v['type'] === 'error' && v['code'] === 'failed' && (v['during'] === 'model' || v['during'] === 'work') && typeof v['message'] === 'string';
}

// ---- where the files are ------------------------------------------------------------------------------------------------------------------

interface LockFile {
  path: string;
  bytes: number;
}
interface LockSource {
  name: string;
  revision: string;
  files: LockFile[];
}
const sources = (lock as { sources: LockSource[] }).sources;

function source(name: string): LockSource {
  const s = sources.find((x) => x.name === name);
  if (!s) throw new Error(`models.lock.json has no source "${name}"`);
  return s;
}

/** The model's folder under `/models/`, without the prefix: `whisper-tiny/<commit>`. Transformers.js joins it to `env.localModelPath`. */
export const whisperModelId = (model: WhisperModelName): string => `whisper-${model}/${source(`whisper-${model}`).revision}`;
export const vadModelId = (): string => `silero-vad/${source('silero-vad').revision}`;

export const MODELS_PATH = '/models/';

/**
 * Where the ONNX Runtime files are served (same pinned revision the model library depends on). Pass the site's origin to get whole addresses:
 * the runtime loads its script with import(), and the dev server rewrites an import of a bare path (adds `?import`, which a plain file refuses).
 */
export function ortPaths(origin = ''): { mjs: string; wasm: string } {
  const base = `${origin}${MODELS_PATH}ort/${source('ort').revision}/`;
  return { mjs: `${base}ort-wasm-simd-threaded.jsep.mjs`, wasm: `${base}ort-wasm-simd-threaded.jsep.wasm` };
}

/** The sizes of the files a model needs, by path, for the progress line. */
export function modelFileSizes(id: string): Map<string, number> {
  const name = id.split('/')[0] ?? '';
  return new Map(source(name).files.map((f) => [f.path, f.bytes]));
}

// ---- the progress line --------------------------------------------------------------------------------------------------------------------

/** What the model library reports about a file it is getting. */
export interface FileEvent {
  status: string;
  file?: string;
  loaded?: number;
  total?: number;
}

/**
 * Adds up the per-file download events into one fraction for the whole model. The expected total comes from the lock file (every file's size),
 * so the line does not jump when the library learns of the next file. Never reaches 1 until `finish()`.
 */
export class ModelProgress {
  private readonly sizes: Map<string, number>;
  private readonly loaded = new Map<string, number>();
  private readonly expected: number;

  constructor(modelId: string) {
    this.sizes = modelFileSizes(modelId);
    let sum = 0;
    for (const n of this.sizes.values()) sum += n;
    this.expected = sum;
  }

  /** The fraction (0 to 0.99) after this event, or null when the event changes nothing. */
  update(e: FileEvent): number | null {
    if (!e.file) return null;
    const size = this.sizes.get(e.file) ?? e.total ?? 0;
    if (e.status === 'progress' && typeof e.loaded === 'number') this.loaded.set(e.file, Math.min(e.loaded, size || e.loaded));
    else if (e.status === 'done') this.loaded.set(e.file, size);
    else return null;
    return this.fraction();
  }

  fraction(): number {
    if (this.expected === 0) return 0;
    let sum = 0;
    for (const n of this.loaded.values()) sum += n;
    return Math.min(0.99, sum / this.expected);
  }
}

/** "Getting the speech model… 40%" for the screen. */
export function progressText(p: SpeechProgress): string {
  const pct = `${Math.round(Math.max(0, Math.min(1, p.fraction)) * 100)}%`;
  return p.stage === 'model' ? `Getting the speech model… ${pct}` : `Writing it out… ${pct}`;
}

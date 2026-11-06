/*
 * The page's side of the speech worker (PLAN P14-16): starts the worker when the first clip needs it, sends the samples, passes the progress on,
 * stops the worker when the person cancels and after a minute of quiet, and plugs into the engine (`installWhisperWorker`).
 * The worker itself (the model, the speech finder) is in worker.ts; the Worker is made by a function handed in, so a test can use a stand-in.
 */
import { WORKER_IDLE_MS, isWorkerMessage, type DevicePreference, type SpeechStats, type ClientMessage } from './protocol';
import { registerWhisperBackend } from './engine';
import { SpeechError, type PcmAudio, type TranscribeOptions, type Transcript, type WhisperBackend, type WhisperModelName } from './types';

/** The few parts of a Worker the client uses. */
export interface WorkerLike {
  postMessage(message: ClientMessage, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface WorkerBackendOptions {
  spawn: () => WorkerLike;
  idleMs?: number;
  device?: DevicePreference;
  /** Runs once, the first time a worker is made (the service worker that caches the model files is registered here). */
  onFirstUse?: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface WhisperWorkerBackend extends WhisperBackend {
  /** Stops the worker now and frees the model. */
  dispose(): void;
  /** How long each step took in the last finished job. */
  lastStats(): SpeechStats | null;
  /** True while a worker exists. */
  running(): boolean;
}

interface Job {
  id: number;
  options: TranscribeOptions;
  resolve(t: Transcript): void;
  reject(e: unknown): void;
}

export const MODEL_FAILED = "Couldn't get the speech model. Check your connection and try again.";
export const WRITE_FAILED = "Couldn't write this one out.";

export function createWorkerBackend(opts: WorkerBackendOptions): WhisperWorkerBackend {
  const idleMs = opts.idleMs ?? WORKER_IDLE_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let worker: WorkerLike | null = null;
  let idleTimer: unknown = null;
  let first = true;
  let nextId = 1;
  let stats: SpeechStats | null = null;
  const jobs = new Map<number, Job>();
  // The worker runs one job at a time; jobs wait here for their turn.
  let tail: Promise<unknown> = Promise.resolve();

  const stopIdleTimer = (): void => {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
  };

  const stopWorker = (): void => {
    stopIdleTimer();
    const w = worker;
    worker = null;
    if (w) {
      w.onmessage = null;
      w.onerror = null;
      w.terminate();
    }
  };

  const failAll = (error: SpeechError): void => {
    const pending = [...jobs.values()];
    jobs.clear();
    for (const j of pending) j.reject(error);
  };

  const startIdleTimer = (): void => {
    stopIdleTimer();
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (jobs.size === 0) stopWorker();
    }, idleMs);
  };

  const onMessage = (data: unknown): void => {
    if (!isWorkerMessage(data)) return;
    const job = jobs.get(data.id);
    if (!job) return;
    if (data.type === 'progress') {
      job.options.onProgress?.({ stage: data.stage, fraction: Math.max(0, Math.min(1, data.fraction)) });
      return;
    }
    jobs.delete(data.id);
    if (data.type === 'result') {
      stats = data.stats;
      job.resolve(data.transcript);
    } else {
      // for whoever looks in the browser's console; the person sees the plain sentence below
      console.warn(`[speech] the worker failed while ${data.during === 'model' ? 'getting the model' : 'working'}: ${data.message}`);
      job.reject(new SpeechError('unavailable', data.during === 'model' ? MODEL_FAILED : WRITE_FAILED));
    }
    if (jobs.size === 0) startIdleTimer();
  };

  const ensureWorker = (): WorkerLike => {
    if (worker) return worker;
    if (first) {
      first = false;
      try {
        opts.onFirstUse?.();
      } catch {
        // the model cache is a convenience, never a reason to fail
      }
    }
    const w = opts.spawn();
    w.onmessage = (e) => onMessage(e.data);
    w.onerror = () => {
      // the worker died (out of memory, a script that would not load): everything waiting on it is told, and the next job starts a fresh one
      if (worker === w) stopWorker();
      failAll(new SpeechError('unavailable', WRITE_FAILED));
    };
    worker = w;
    return w;
  };

  const runJob = (model: WhisperModelName, audio: PcmAudio, options: TranscribeOptions): Promise<Transcript> => {
    const aborted = (): SpeechError => new SpeechError('aborted', 'Writing it out was cancelled.');
    if (options.signal?.aborted) return Promise.reject(aborted());
    const id = nextId++;
    return new Promise<Transcript>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        // stopping the worker is the only way to interrupt a long stretch of computing; the model is read again from the cache next time
        jobs.delete(id);
        stopWorker();
        job.reject(aborted());
      };
      const finish =
        <T>(fn: (v: T) => void) =>
        (v: T): void => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener('abort', onAbort);
          fn(v);
        };
      const job: Job = { id, options, resolve: finish(resolve), reject: finish(reject) };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      stopIdleTimer();
      const w = ensureWorker();
      jobs.set(id, job);
      // the worker gets its own copy, handed over without copying again; the caller's samples stay usable
      const samples = audio.samples.slice();
      w.postMessage({ type: 'transcribe', id, model, samples, ...(options.language ? { language: options.language } : {}), device: opts.device ?? 'auto' }, [samples.buffer]);
    });
  };

  return {
    transcribe(model, audio, options) {
      const result = tail.then(() => runJob(model, audio, options));
      tail = result.catch(() => undefined);
      return result;
    },
    dispose() {
      stopWorker();
      failAll(new SpeechError('aborted', 'Writing it out was cancelled.'));
    },
    lastStats: () => stats,
    running: () => worker !== null,
  };
}

// ---- the model cache and the real worker --------------------------------------------------------------------------------------------------

let cacheRegistered = false;

/**
 * Registers `/sw.js`, whose fetch handler keeps the model files (cache-first, by pinned address). Called when the speech engine is first used for a real
 * download, never at page load, and never fatal: without a service worker the files simply come from the browser's own HTTP cache (they are `immutable`).
 */
export function registerModelCache(nav: { serviceWorker?: { register(url: string, o?: { scope?: string }): Promise<unknown> } } | undefined = typeof navigator === 'undefined' ? undefined : navigator): void {
  if (cacheRegistered || !nav?.serviceWorker) return;
  cacheRegistered = true;
  try {
    void nav.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  } catch {
    // not allowed here (a private window, an insecure page): carry on without
  }
}

let installed: WhisperWorkerBackend | null = null;

/** The backend the app uses: a real module worker, started on first use. Installing twice does nothing. */
export function installWhisperWorker(): WhisperWorkerBackend {
  if (installed) return installed;
  const backend = createWorkerBackend({
    spawn: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike,
    onFirstUse: () => registerModelCache(),
  });
  installed = backend;
  registerWhisperBackend(backend);
  return backend;
}

/** The backend installed by `installWhisperWorker`, for the bench page's timings. */
export const installedWhisperWorker = (): WhisperWorkerBackend | null => installed;

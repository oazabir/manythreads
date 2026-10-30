import { Worker } from 'node:worker_threads';
import { ExtractError, type ExtractKind, type ExtractResult } from './core.ts';

// The extractor as the rest of the plugin uses it (PLAN P8-32): `extractText(bytes, kind) -> { text, metadata }`, bounded in size and in time, and off
// the request path: every file is read in its own worker thread, so a hostile file (a PDF that loops, a huge CSV) can cost its own thread and nothing
// else. The host stops the thread when the time is up, and a memory limit on the thread ends it if it grows too large. At most `MAX_PARALLEL` run at once.

export { ExtractError } from './core.ts';
export type { ExtractKind, ExtractMetadata, ExtractResult, ExtractSection } from './core.ts';

const intEnv = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isSafeInteger(v) && v > 0 ? v : fallback;
};
/** Largest file read, in bytes. */
export const maxExtractBytes = (): number => intEnv('MANYTHREADS_KNOWLEDGE_MAX_BYTES', 10 * 1024 * 1024);
/** How long one file may take before its thread is stopped. */
export const extractTimeoutMs = (): number => intEnv('MANYTHREADS_KNOWLEDGE_EXTRACT_MS', 20_000);
/** How much the whole process may grow (resident memory) while one file is read, in bytes. A thread's own heap limit does not cover the buffers a PDF's compressed streams unpack into. */
export const extractMemoryGrowthBytes = (): number => intEnv('MANYTHREADS_KNOWLEDGE_EXTRACT_MB', 500) * 1024 * 1024;
const MEMORY_CHECK_MS = 40;
const MAX_PARALLEL = 2;
export const MAX_TEXT_CHARS = 900_000;

let running = 0;
const waiting: Array<() => void> = [];
async function turn(): Promise<() => void> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  else running += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  };
}

const WORKER_URL = new URL('./worker.ts', import.meta.url);

export interface ExtractOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** How far the process's resident memory may grow while this file is read (defaults to `extractMemoryGrowthBytes()`). */
  maxGrowthBytes?: number;
  /** Test hook: a different worker file (one that never answers, to prove the time limit). */
  workerUrl?: URL;
}

/** Reads `bytes` as `kind`. Rejects with an `ExtractError` whose message is a plain reason: too large, took too long, not readable, no text. */
export async function extractText(bytes: Uint8Array, kind: ExtractKind, options: ExtractOptions = {}): Promise<ExtractResult> {
  const maxBytes = options.maxBytes ?? maxExtractBytes();
  if (bytes.length > maxBytes) throw new ExtractError(`This file is larger than the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`);
  const timeoutMs = options.timeoutMs ?? extractTimeoutMs();
  const maxGrowth = options.maxGrowthBytes ?? extractMemoryGrowthBytes();
  const release = await turn();
  try {
    return await new Promise<ExtractResult>((resolve, reject) => {
      const copy = new Uint8Array(bytes);
      const worker = new Worker(options.workerUrl ?? WORKER_URL, {
        workerData: { bytes: copy, kind, maxChars: MAX_TEXT_CHARS },
        transferList: [copy.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
        stdout: true,
        stderr: true,
      });
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(watch);
        void worker.terminate();
        fn();
      };
      const timer = setTimeout(() => settle(() => reject(new ExtractError('Reading this file took too long, so it was stopped.'))), timeoutMs);
      // A hostile PDF can unpack a few megabytes of compressed stream into gigabytes of buffers, which count against the process and not against the
      // thread's heap limit: watch the process and stop the thread before the server is the one that runs out.
      const baseline = process.memoryUsage.rss();
      const watch = setInterval(() => {
        if (process.memoryUsage.rss() - baseline > maxGrowth) settle(() => reject(new ExtractError('This file needs too much memory to read, so it was stopped.')));
      }, MEMORY_CHECK_MS);
      worker.once('message', (m: { ok: boolean; result?: ExtractResult; reason?: string }) =>
        settle(() => (m.ok && m.result ? resolve(m.result) : reject(new ExtractError(m.reason ?? 'This file could not be read.')))),
      );
      worker.once('error', (err: Error & { code?: string }) =>
        settle(() =>
          reject(
            new ExtractError(
              err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'This file needs too much memory to read, so it was stopped.' : 'This file could not be read.',
            ),
          ),
        ),
      );
      worker.once('exit', () => settle(() => reject(new ExtractError('This file could not be read.'))));
    });
  } finally {
    release();
  }
}

// The worker thread an extraction runs in (index.ts starts one per file and stops it after a time limit). It takes the file, runs the pure extractor
// and posts back text or a plain reason, nothing else. Written with erasable TypeScript only (it is loaded by Node itself, not bundled).
import { parentPort, workerData } from 'node:worker_threads';
import { DEFAULT_LIMITS, extract, ExtractError } from './core.ts';

interface Job {
  bytes: Uint8Array;
  kind: 'markdown' | 'text' | 'csv' | 'pdf';
  maxChars: number;
}

const job = workerData as Job;
extract(job.bytes, job.kind, { ...DEFAULT_LIMITS, maxChars: job.maxChars })
  .then((result) => parentPort?.postMessage({ ok: true, result }))
  .catch((err: unknown) => parentPort?.postMessage({ ok: false, reason: err instanceof ExtractError ? err.message : 'This file could not be read.' }));
